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

/// The `finish_reason` a model gives when it hit the token bound rather than
/// finishing what it had to say.
///
/// The OpenAI streaming vocabulary, which `lemond` speaks: `stop` is the model
/// deciding it is done, `length` is `max_tokens` cutting it off mid-thought.
pub const FINISH_LENGTH: &str = "length";

/// What one SSE line meant.
///
/// ⚠️ **A RECORD, AND IT USED TO BE AN ENUM WITH `finish_reason` THROWN AWAY.**
/// The parser read `finish_reason`, matched on it, and returned `Ignore` — so
/// the one fact that says whether an answer is COMPLETE was decoded off the
/// wire and dropped one match arm before anybody could use it. `inference_gloss`
/// then returned a definition cut off at `MAX_GLOSS_TOKENS` as though the model
/// had finished it, and `glossProvider` cached it and the strip drew it in
/// amber — which is the shape `stream`'s own byte bound refuses eight lines
/// below, in as many words.
///
/// An enum could not carry it, and that is why this is a record rather than a
/// fourth variant: a chunk may hold BOTH text and a finish reason, and every
/// one-of-N shape has to choose which half to lose. Nothing here chooses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Event {
    /// Text to append to the answer.
    pub delta: Option<String>,
    /// Why the model stopped, when this chunk said so — see [`FINISH_LENGTH`].
    pub finish: Option<String>,
    /// The `[DONE]` sentinel: the stream is over.
    pub done: bool,
}

impl Event {
    /// A line with nothing in it for us — a comment, a keep-alive, a chunk
    /// whose delta carried only a role. Skipped rather than treated as an
    /// error: SSE explicitly allows all three.
    fn ignored() -> Self {
        Self::default()
    }
}

/// Read one SSE line.
///
/// Pure, and separately tested, because this is where a streaming bug is
/// cheapest to catch and most expensive to find later.
pub fn parse_line(line: &str) -> Event {
    let line = line.trim_end_matches('\r');
    let Some(payload) = line.strip_prefix(DATA_PREFIX) else {
        // Blank lines separate events; `:` starts a comment. Neither is data.
        return Event::ignored();
    };
    let payload = payload.trim_start();
    if payload == DONE {
        return Event {
            done: true,
            ..Event::ignored()
        };
    }
    if payload.is_empty() {
        return Event::ignored();
    }
    let Ok(chunk) = serde_json::from_str::<Chunk>(payload) else {
        // A chunk this build cannot read is not a reason to fail an answer
        // the reader is watching arrive. Upstream adds fields; skipping one
        // unreadable line loses at most a token.
        return Event::ignored();
    };
    let Some(choice) = chunk.choices.first() else {
        return Event::ignored();
    };
    Event {
        // An empty string is not a delta: `""` and absent are the same fact,
        // and treating the first as text made a keep-alive chunk look like
        // content to everything downstream.
        delta: choice.delta.content.clone().filter(|text| !text.is_empty()),
        // Read whether or not this chunk also carried text. The daemon
        // observed sends the two separately and then `[DONE]`, but a server
        // that combines them is within the protocol and used to be the case
        // where the truncation went unnoticed.
        finish: choice.finish_reason.clone(),
        done: false,
    }
}

/// A whole answer, and whether the model finished saying it.
///
/// ⚠️ **`finish` IS THE HALF THAT USED TO BE DROPPED.** Returning a bare
/// `String` gave every caller an answer with no way to ask whether it was one:
/// a generation stopped at `max_tokens` and one the model chose to end are the
/// same value, and `inference_gloss` — which delivers its answer whole rather
/// than streaming it, so nobody watches it stop — presented the first as the
/// second. See [`Event`].
///
/// `None` means the stream ended without saying, which is not the same as
/// `stop`: a body that ends with no `[DONE]` and no finish chunk is a daemon
/// that went away mid-answer. Callers that care must not read absence as
/// success by default; `inference_gloss` refuses only `length`, because
/// everything received is still real text and discarding it would lose more
/// than it protects.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Answer {
    pub text: String,
    pub finish: Option<String>,
}

impl Answer {
    /// Whether the model was cut off by the token bound rather than finishing.
    pub fn truncated(&self) -> bool {
        self.finish.as_deref() == Some(FINISH_LENGTH)
    }
}

/// Stream an answer, handing each text delta to `on_delta`.
///
/// Returns the whole answer as well, because the gloss wants it as one
/// string (WI-15.13: a promise, not a generator — two sentences streamed into
/// a popover beside a word is jitter, not progress) and the thread wants the
/// deltas. One code path, two shapes, rather than two paths that can drift.
pub async fn stream(
    request: crate::daemon::ModelRequest,
    cancel: &Cancel,
    mut on_delta: impl FnMut(String),
) -> Result<Answer> {
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(Error::Cancelled),
        sent = request.into_builder().send() => sent.map_err(|e| unreachable(CHAT_ROUTE, e))?,
    };
    let status = response.status();
    if !status.is_success() {
        return Err(Error::RuntimeHttp {
            status: status.as_u16(),
            route: CHAT_ROUTE.to_owned(),
        });
    }

    let mut answer = Answer::default();
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
            let event = parse_line(&String::from_utf8_lossy(&line));
            /* THE REASON IS TAKEN BEFORE THE TEXT, and from every chunk that
             * carries one, because a chunk may hold both and because the last
             * one to say wins — a server that re-states it must not be able to
             * unsay it by sending a bare delta afterwards. */
            if event.finish.is_some() {
                answer.finish = event.finish;
            }
            if let Some(text) = event.delta {
                /* BOUNDED, because the writer is a separate process. The
                 * request asks for `MAX_ANSWER_TOKENS`, but nothing on
                 * this side enforces that a daemon honours it — a wedged
                 * or hostile one streaming without end would grow this
                 * `String` until the app died. Refused by name rather
                 * than truncated: half an answer presented as a whole one
                 * is the shape this crate refuses everywhere else. */
                if answer.text.len() + text.len() > crate::limits::MAX_ANSWER_BYTES {
                    return Err(Error::FieldTooLarge {
                        field: "the answer",
                        limit: crate::limits::MAX_ANSWER_BYTES,
                    });
                }
                answer.text.push_str(&text);
                on_delta(text);
            }
            if event.done {
                return Ok(answer);
            }
        }
    }
    /* THE LAST LINE, when the body ended without a trailing newline.
     *
     * A stream that ends `data: {...}` with no `\n` left that event in the
     * buffer and it was silently dropped — losing the final token of an answer
     * the reader watched arrive, or the `[DONE]` that says it finished. */
    if !buffer.is_empty() {
        let event = parse_line(&String::from_utf8_lossy(&buffer));
        if event.finish.is_some() {
            answer.finish = event.finish;
        }
        if let Some(text) = event.delta {
            answer.text.push_str(&text);
            on_delta(text);
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
        assert_eq!(parse_line(line).delta.as_deref(), Some("One"));
    }

    /// The leak this module exists to stop: a chunk's `model` is an absolute
    /// path, and only the text may cross.
    #[test]
    fn nothing_but_the_text_survives_the_parse() {
        let line = r#"data: {"choices":[{"index":0,"delta":{"content":" two"}}],"model":"/Users/someone/Paper/inference/models/qwen/x.gguf","id":"chatcmpl-secret","system_fingerprint":"b10375-ba360efe1"}"#;
        let text = parse_line(line).delta.expect("a delta");
        assert_eq!(text, " two");
        assert!(!text.contains("/Users/"), "no path may reach the webview");
        assert!(!text.contains("chatcmpl"), "no request id either");
    }

    /// The sentinel is not JSON. A parser that fed it to serde would end
    /// every successful answer with an error.
    #[test]
    fn the_done_sentinel_ends_the_stream_rather_than_failing_it() {
        for line in ["data: [DONE]", "data:[DONE]", "data: [DONE]\r"] {
            assert!(parse_line(line).done, "{line:?}");
        }
    }

    #[test]
    fn the_opening_role_chunk_carries_no_text() {
        // Observed: the first chunk has `"content":null` and a role.
        let line = r#"data: {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}]}"#;
        assert_eq!(parse_line(line), Event::default());
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
            assert_eq!(parse_line(line), Event::default(), "{line:?}");
        }
    }

    /// An unreadable chunk loses a token, not the answer.
    #[test]
    fn an_unparseable_chunk_is_skipped_rather_than_fatal() {
        assert_eq!(parse_line("data: {not json"), Event::default());
        assert_eq!(parse_line("data: []"), Event::default());
        assert_eq!(parse_line(r#"data: {"choices":[]}"#), Event::default());
    }

    /// ⚠️ **THE FACT THAT USED TO BE DROPPED.** This asserted `Event::Ignore`
    /// — the parser decoded `finish_reason` and threw it away — and that is
    /// what let a gloss cut off at `MAX_GLOSS_TOKENS` reach the reader in amber
    /// as a finished definition.
    #[test]
    fn a_finish_chunk_carries_its_reason_and_no_text() {
        let line = r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
        let event = parse_line(line);
        assert_eq!(event.delta, None);
        assert_eq!(event.finish.as_deref(), Some("stop"));
        assert!(!event.done);
    }

    /// The bound cutting the model off, which is the one an answer must not be
    /// presented as complete over.
    #[test]
    fn the_token_bound_is_reported_as_length() {
        let line = r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}"#;
        assert_eq!(parse_line(line).finish.as_deref(), Some(FINISH_LENGTH));
    }

    /// ⚠️ **A CHUNK MAY CARRY BOTH**, which is why `Event` is a record and not
    /// a fourth enum variant: every one-of-N shape has to choose which half to
    /// lose, and the half an enum would have lost here is the whole point.
    #[test]
    fn a_chunk_carrying_text_and_a_reason_loses_neither() {
        let line =
            r#"data: {"choices":[{"index":0,"delta":{"content":"cut"},"finish_reason":"length"}]}"#;
        let event = parse_line(line);
        assert_eq!(event.delta.as_deref(), Some("cut"));
        assert_eq!(event.finish.as_deref(), Some(FINISH_LENGTH));
    }

    /// A future upstream that adds fields must not break the parse.
    #[test]
    fn unknown_fields_are_tolerated() {
        let line = r#"data: {"choices":[{"index":0,"delta":{"content":"hi","reasoning":"x"}}],"upstream_added_this":{"a":1}}"#;
        assert_eq!(parse_line(line).delta.as_deref(), Some("hi"));
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
            parse_line(&String::from_utf8_lossy(raw_bytes))
                .delta
                .as_deref(),
            Some("海")
        );
        assert_eq!(parse_line(&naive).delta.as_deref(), Some("海"));
    }

    /// A stream whose last event has no trailing newline. The old loop only
    /// parsed up to a `\n`, so the final token — or the `[DONE]` that says the
    /// answer finished — was silently dropped.
    #[test]
    fn a_final_event_without_a_newline_is_still_read() {
        let line = r#"data: {"choices":[{"delta":{"content":"last"}}]}"#;
        assert_eq!(parse_line(line).delta.as_deref(), Some("last"));
        assert!(parse_line("data: [DONE]").done);
    }

    /// One SSE event, framed.
    ///
    /// A helper rather than one long literal, and the reason is a defect this
    /// file's tests hit on the way in: a continued string literal carries the
    /// source's own indentation into the bytes, and `data:` with leading
    /// whitespace is not a `data:` line to `parse_line` — nor a header to
    /// hyper, which refused the whole response as malformed.
    fn sse(payload: &str) -> String {
        format!("data: {payload}\n\n")
    }

    /// A one-shot HTTP server that answers with `body` and then closes.
    ///
    /// `std` on its own thread rather than `tokio::net`: the `net` feature is
    /// not in this crate's tokio list, and adding one to the SHIPPED dependency
    /// to carry a test is not a trade this crate makes anywhere else.
    ///
    /// GET rather than POST, so the whole request arrives in one read — an
    /// unread request body is what makes a close look like a reset. What is
    /// under test is how `stream` reads an ANSWER; `chat_request` has its own
    /// test for what it sends.
    fn serving(body: String) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        let address = listener.local_addr().expect("an address");
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("a connection");
            let mut scratch = [0_u8; 4096];
            let _ = socket.read(&mut scratch);
            let head =
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
            socket.write_all(head.as_bytes()).expect("a head");
            socket.write_all(body.as_bytes()).expect("a body");
        });
        format!("http://{address}/api/v1/chat/completions")
    }

    async fn answered(body: String) -> Answer {
        let registry = crate::requests::Registry::default();
        let guard = registry.begin("gloss").expect("a fresh request");
        /* `.no_proxy()`, as both real clients do and for their reason: a
        machine with `http_proxy` set routes even 127.0.0.1 through it. */
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("a client");
        let request = crate::daemon::ModelRequest::from_builder_for_test(client.get(serving(body)));
        stream(request, &guard.cancel(), |_| {})
            .await
            .expect("an answer")
    }

    /// ⚠️ **THE WHOLE POINT OF `Answer`.** The reason reaches the caller, so
    /// `inference_gloss` can refuse a definition the model was cut off in the
    /// middle of instead of returning it as a finished one.
    #[tokio::test]
    async fn a_stream_cut_off_at_the_token_bound_says_so() {
        let answer = answered(
            sse(r#"{"choices":[{"delta":{"content":"a meeting between"}}]}"#)
                + &sse(r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#)
                + &sse("[DONE]"),
        )
        .await;

        assert_eq!(answer.text, "a meeting between");
        assert!(answer.truncated());
    }

    /// The ordinary end, and the non-vacuity of the case above: a reader must
    /// not lose a finished gloss to a check that fires on every answer.
    #[tokio::test]
    async fn a_stream_the_model_finished_is_not_truncated() {
        let answer = answered(
            sse(r#"{"choices":[{"delta":{"content":"a meeting."}}]}"#)
                + &sse(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#)
                + &sse("[DONE]"),
        )
        .await;

        assert_eq!(answer.text, "a meeting.");
        assert_eq!(answer.finish.as_deref(), Some("stop"));
        assert!(!answer.truncated());
    }

    /// A body that ends without saying. NOT read as `stop`: a stream that stops
    /// mid-answer is a daemon that went away, and calling that "finished" is
    /// the same mistake one level down. Everything received is still returned —
    /// see `Answer` — and only `length` is refused.
    #[tokio::test]
    async fn a_stream_that_ends_without_saying_reports_no_reason() {
        let answer = answered(sse(r#"{"choices":[{"delta":{"content":"half"}}]}"#)).await;

        assert_eq!(answer.text, "half");
        assert_eq!(answer.finish, None);
        assert!(!answer.truncated());
    }

    /// A server that combines the last token with the reason, which is within
    /// the protocol and is the shape an enum-shaped `Event` would have lost
    /// half of. Both halves have to survive the LOOP, not only the parse.
    #[tokio::test]
    async fn a_final_chunk_carrying_both_keeps_both() {
        let answer = answered(
            sse(r#"{"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}"#)
                + &sse("[DONE]"),
        )
        .await;

        assert_eq!(answer.text, "cut");
        assert!(answer.truncated());
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
