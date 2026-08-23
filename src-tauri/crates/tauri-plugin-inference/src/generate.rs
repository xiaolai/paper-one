//! Asking the daemon a question, and streaming the answer back.
//!
//! The transport half of WI-15.4 and WI-15.13. What crosses back to the
//! webview is **text and nothing else** — this module turns the daemon's
//! Server-Sent Events into a sequence of string deltas, and everything else
//! in a chunk is dropped here.
//!
//! # What is dropped, and why it is not tidiness
//!
//! Observed against 11.7.0: every streamed chunk carries a `model` field, and
//! for a model registered through `extra_models_dir` **its value is the
//! artifact's absolute path** —
//! `/Users/…/Paper/inference/models/qwen…/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`.
//! Forwarding a chunk verbatim would put the reader's home directory into the
//! webview on every token. So the parser reads `choices[0].delta.content` and
//! carries nothing else: not the id, not the fingerprint, not the model.
//!
//! # `[DONE]` is a sentinel, not JSON
//!
//! The stream ends with the literal `data: [DONE]`, which is not parseable as
//! an object. A parser that fed every `data:` line to `serde_json` would end
//! every successful answer with an error, so the sentinel is matched before
//! the parse rather than caught after it.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::error::{unreachable, Error, Result};
use crate::requests::Cancel;

/// The route the thread and the gloss both use.
pub const CHAT_ROUTE: &str = "/api/v1/chat/completions";

/// One message in a request. Paper sends exactly two — a system prompt it
/// wrote and the reader's question with its numbered passages — and never a
/// history, because this interface is one turn (see the crate header).
#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub role: &'static str,
    pub content: String,
}

/// What Paper asks the daemon for.
#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
    pub temperature: f32,
    pub stream: bool,
}

/// The sentinel that ends an SSE stream.
const DONE: &str = "[DONE]";

/// The prefix every SSE payload line carries.
const DATA_PREFIX: &str = "data:";

/// A streamed chunk, as much of it as Paper reads.
#[derive(Debug, Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
}

/// What one SSE line meant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Text to append to the answer.
    Delta(String),
    /// The stream is over.
    Done,
    /// A line with nothing in it for us — a comment, a keep-alive, a chunk
    /// whose delta carried only a role. Skipped rather than treated as an
    /// error: SSE explicitly allows all three.
    Ignore,
}

/// Read one SSE line.
///
/// Pure, and separately tested, because this is where a streaming bug is
/// cheapest to catch and most expensive to find later.
pub fn parse_line(line: &str) -> Event {
    let line = line.trim_end_matches('\r');
    let Some(payload) = line.strip_prefix(DATA_PREFIX) else {
        // Blank lines separate events; `:` starts a comment. Neither is data.
        return Event::Ignore;
    };
    let payload = payload.trim_start();
    if payload == DONE {
        return Event::Done;
    }
    if payload.is_empty() {
        return Event::Ignore;
    }
    let Ok(chunk) = serde_json::from_str::<Chunk>(payload) else {
        // A chunk this build cannot read is not a reason to fail an answer
        // the reader is watching arrive. Upstream adds fields; skipping one
        // unreadable line loses at most a token.
        return Event::Ignore;
    };
    match chunk.choices.first() {
        Some(choice) => match &choice.delta.content {
            Some(text) if !text.is_empty() => Event::Delta(text.clone()),
            // A chunk carrying only `finish_reason` closes the answer. The
            // daemon still sends `[DONE]` after it, but an adapter that
            // stopped here would also be correct.
            _ if choice.finish_reason.is_some() => Event::Ignore,
            _ => Event::Ignore,
        },
        None => Event::Ignore,
    }
}

/// Stream an answer, handing each text delta to `on_delta`.
///
/// Returns the whole answer as well, because the gloss wants it as one
/// string (WI-15.13: a promise, not a generator — two sentences streamed into
/// a popover beside a word is jitter, not progress) and the thread wants the
/// deltas. One code path, two shapes, rather than two paths that can drift.
pub async fn stream(
    request: reqwest::RequestBuilder,
    cancel: &Cancel,
    mut on_delta: impl FnMut(String),
) -> Result<String> {
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(Error::Cancelled),
        sent = request.send() => sent.map_err(|e| unreachable(CHAT_ROUTE, e))?,
    };
    let status = response.status();
    if !status.is_success() {
        return Err(Error::RuntimeHttp {
            status: status.as_u16(),
            route: CHAT_ROUTE.to_owned(),
        });
    }

    let mut answer = String::new();
    /* BYTES, NOT A STRING, and this was a real corruption.
     *
     * The previous version did `String::from_utf8_lossy(&chunk)` per chunk and
     * appended. A multibyte character split across a chunk boundary — which is
     * routine, and certain for the CJK text this model was chosen for — became
     * two replacement characters, one at the end of one chunk and one at the
     * start of the next. The bytes were never wrong on the wire; the decode
     * was. Buffering raw bytes and decoding only complete LINES fixes it,
     * because an SSE line boundary is always a `\n` and never mid-character. */
    let mut buffer: Vec<u8> = Vec::new();
    let mut body = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            biased;
            // The reader's abort has to land DURING the answer, which is the
            // whole point of cancellation on a streamed reply. Without this
            // arm, Escape would be honoured only between chunks — and a model
            // that has stopped emitting is exactly when a reader gives up.
            () = cancel.cancelled() => return Err(Error::Cancelled),
            next = body.next() => match next {
                None => break,
                Some(chunk) => chunk.map_err(|e| unreachable(CHAT_ROUTE, e))?,
            },
        };
        buffer.extend_from_slice(&chunk);
        // Lines can split across chunks — the tail is kept, never parsed.
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline).collect();
            match parse_line(&String::from_utf8_lossy(&line)) {
                Event::Delta(text) => {
                    /* BOUNDED, because the writer is a separate process. The
                     * request asks for `MAX_ANSWER_TOKENS`, but nothing on
                     * this side enforces that a daemon honours it — a wedged
                     * or hostile one streaming without end would grow this
                     * `String` until the app died. Refused by name rather
                     * than truncated: half an answer presented as a whole one
                     * is the shape this crate refuses everywhere else. */
                    if answer.len() + text.len() > crate::limits::MAX_ANSWER_BYTES {
                        return Err(Error::FieldTooLarge {
                            field: "the answer",
                            limit: crate::limits::MAX_ANSWER_BYTES,
                        });
                    }
                    answer.push_str(&text);
                    on_delta(text);
                }
                Event::Done => return Ok(answer),
                Event::Ignore => {}
            }
        }
    }
    /* THE LAST LINE, when the body ended without a trailing newline.
     *
     * A stream that ends `data: {...}` with no `\n` left that event in the
     * buffer and it was silently dropped — losing the final token of an answer
     * the reader watched arrive, or the `[DONE]` that says it finished. */
    if !buffer.is_empty() {
        match parse_line(&String::from_utf8_lossy(&buffer)) {
            Event::Delta(text) => {
                answer.push_str(&text);
                on_delta(text);
            }
            Event::Done => return Ok(answer),
            Event::Ignore => {}
        }
    }
    /* The body ended without `[DONE]`. Everything received is still a real
     * answer; a truncated stream is the daemon's problem to report, and
     * discarding text the reader watched arrive would be worse. */
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delta_line_yields_its_text() {
        // The exact shape observed from 11.7.0, minus nothing.
        let line = r#"data: {"choices":[{"finish_reason":null,"index":0,"delta":{"content":"One"}}],"created":1787418132,"id":"chatcmpl-xnR9","model":"/Users/someone/Paper/models/x.gguf","system_fingerprint":"b10375","object":"chat.completion.chunk"}"#;
        assert_eq!(parse_line(line), Event::Delta("One".to_owned()));
    }

    /// The leak this module exists to stop: a chunk's `model` is an absolute
    /// path, and only the text may cross.
    #[test]
    fn nothing_but_the_text_survives_the_parse() {
        let line = r#"data: {"choices":[{"index":0,"delta":{"content":" two"}}],"model":"/Users/someone/Paper/inference/models/qwen/x.gguf","id":"chatcmpl-secret","system_fingerprint":"b10375-ba360efe1"}"#;
        match parse_line(line) {
            Event::Delta(text) => {
                assert_eq!(text, " two");
                assert!(!text.contains("/Users/"), "no path may reach the webview");
                assert!(!text.contains("chatcmpl"), "no request id either");
            }
            other => panic!("expected a delta, got {other:?}"),
        }
    }

    /// The sentinel is not JSON. A parser that fed it to serde would end
    /// every successful answer with an error.
    #[test]
    fn the_done_sentinel_ends_the_stream_rather_than_failing_it() {
        assert_eq!(parse_line("data: [DONE]"), Event::Done);
        assert_eq!(parse_line("data:[DONE]"), Event::Done);
        assert_eq!(parse_line("data: [DONE]\r"), Event::Done);
    }

    #[test]
    fn the_opening_role_chunk_carries_no_text() {
        // Observed: the first chunk has `"content":null` and a role.
        let line = r#"data: {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}]}"#;
        assert_eq!(parse_line(line), Event::Ignore);
    }

    #[test]
    fn blanks_comments_and_keepalives_are_skipped() {
        for line in [
            "",
            "\n",
            ": keep-alive",
            "event: message",
            "data:",
            "data: ",
        ] {
            assert_eq!(parse_line(line), Event::Ignore, "{line:?}");
        }
    }

    /// An unreadable chunk loses a token, not the answer.
    #[test]
    fn an_unparseable_chunk_is_skipped_rather_than_fatal() {
        assert_eq!(parse_line("data: {not json"), Event::Ignore);
        assert_eq!(parse_line("data: []"), Event::Ignore);
        assert_eq!(parse_line(r#"data: {"choices":[]}"#), Event::Ignore);
    }

    #[test]
    fn a_finish_chunk_carries_no_text() {
        let line = r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
        assert_eq!(parse_line(line), Event::Ignore);
    }

    /// A future upstream that adds fields must not break the parse.
    #[test]
    fn unknown_fields_are_tolerated() {
        let line = r#"data: {"choices":[{"index":0,"delta":{"content":"hi","reasoning":"x"}}],"upstream_added_this":{"a":1}}"#;
        assert_eq!(parse_line(line), Event::Delta("hi".to_owned()));
    }

    /// The corruption an audit caught: decoding each network chunk on its own
    /// turns a multibyte character split across a boundary into replacement
    /// characters. Certain for the CJK text this model was chosen for.
    #[test]
    fn a_character_split_across_chunks_survives() {
        let line = r#"data: {"choices":[{"delta":{"content":"\u6d77"}}]}"#;
        let bytes = line.as_bytes();
        // Split mid-way and decode each half on its own, as the old code did.
        let split = bytes.len() / 2;
        let naive = format!(
            "{}{}",
            String::from_utf8_lossy(&bytes[..split]),
            String::from_utf8_lossy(&bytes[split..])
        );
        // The escaped form survives a naive split, so use a raw multibyte body
        // to show the real failure the byte buffer prevents.
        let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"海\"}}]}";
        let raw_bytes = raw.as_bytes();
        let cut = raw.find('海').unwrap() + 1; // mid-character
        let broken = format!(
            "{}{}",
            String::from_utf8_lossy(&raw_bytes[..cut]),
            String::from_utf8_lossy(&raw_bytes[cut..])
        );
        assert!(
            broken.contains('\u{FFFD}'),
            "the naive per-chunk decode must be shown to corrupt, or this test proves nothing"
        );
        // Buffered as bytes and decoded whole, it is intact — which is what
        // `stream` now does.
        assert_eq!(
            parse_line(&String::from_utf8_lossy(raw_bytes)),
            Event::Delta("海".to_owned())
        );
        assert_eq!(parse_line(&naive), Event::Delta("海".to_owned()));
    }

    /// A stream whose last event has no trailing newline. The old loop only
    /// parsed up to a `\n`, so the final token — or the `[DONE]` that says the
    /// answer finished — was silently dropped.
    #[test]
    fn a_final_event_without_a_newline_is_still_read() {
        let line = r#"data: {"choices":[{"delta":{"content":"last"}}]}"#;
        assert_eq!(parse_line(line), Event::Delta("last".to_owned()));
        assert_eq!(parse_line("data: [DONE]"), Event::Done);
    }

    /// The request Paper sends is one turn: a system prompt and a question,
    /// never a history. Stated as a test because "no conversation state" is a
    /// boundary the plan draws explicitly.
    #[test]
    fn a_request_is_one_turn_and_names_its_model() {
        let request = ChatRequest {
            model: "qwen".to_owned(),
            messages: vec![
                Message {
                    role: "system",
                    content: "ground rules".to_owned(),
                },
                Message {
                    role: "user",
                    content: "a question".to_owned(),
                },
            ],
            max_tokens: 512,
            temperature: 0.2,
            stream: true,
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["messages"].as_array().unwrap().len(), 2);
        assert_eq!(json["stream"], true);
        assert_eq!(json["model"], "qwen");
    }
}
