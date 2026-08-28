//! What this plugin will carry from the webview, per field.
//!
//! # Why there are bounds at all
//!
//! Every command here takes `String`s from a webview that renders untrusted
//! book HTML — which is the reason the command surface is closed in the first
//! place. A closed surface bounds WHICH verbs can be reached; it says nothing
//! about how much can be pushed through one. A caller could hand `question` a
//! gigabyte and spend the reader's memory, their machine, and — on a
//! subscription route — their money, without naming anything it was not
//! allowed to name.
//!
//! `MAX_ANSWER_TOKENS` does not help: it bounds what the model may write back,
//! after the prompt has been allocated, serialised and sent.
//!
//! # Why these numbers
//!
//! Each is far above what Paper itself sends and far below what hurts, and
//! that gap is the point — a bound tight enough to argue about would be a
//! bound that breaks a legitimate reader.
//!
//! - The companion numbers at most `MAX_CONTEXT_CHARS` (8 000) of passages
//!   into a question, plus a chapter title and the reader's sentence. 64 KiB
//!   is eight times that.
//! - The system prompt is a fixed six lines Paper writes; 8 KiB is generous
//!   for a string no caller has a reason to grow.
//! - An agent turn carries the same passages plus the rules, so it takes the
//!   same 64 KiB as a question.
//! - Speech is one line read aloud. 4 KiB is a paragraph.
//! - A request id is minted by Paper as `<kind>-<n>`. 64 bytes is room for a
//!   UUID and then some.
//! - The accumulated answer is bounded because the daemon is a separate
//!   process: a wedged or hostile one streaming without end would otherwise
//!   grow a `String` until the app died. 1 MiB is far past any answer a
//!   reading companion produces.

use crate::error::{Error, Result};

pub const MAX_QUESTION: usize = 64 * 1024;
pub const MAX_SYSTEM: usize = 8 * 1024;
pub const MAX_AGENT_PROMPT: usize = 64 * 1024;
pub const MAX_SPEECH_TEXT: usize = 4 * 1024;
pub const MAX_REQUEST_ID: usize = 64;
pub const MAX_ANSWER_BYTES: usize = 1024 * 1024;
/// A manifest id is a short slug; anything past this is not a model name,
/// it is an allocation. Applied wherever a caller-minted model string
/// arrives, BEFORE it is copied into ids, errors or lock keys.
///
/// ⚠️ **THREE FIELDS OF THIS KIND WERE MISSED THE FIRST TIME**, all found by a
/// later reading rather than by anything failing: `inference_remove_model`'s
/// `model`, which goes into a lock key and a `RequestBusy` error before the
/// manifest lookup can refuse it; `inference_speak`'s `voice`, which goes into
/// the JSON body sent to the daemon; and `route`, which
/// `parse_agent_route` copies into `ModelUnknown` and back across IPC.
/// Bounding the commands that FELT like the model commands is not a bound —
/// every field that carries a caller-minted daemon id names one, and they all
/// share this number because they are the same kind of value: `af_sky`,
/// `agent:codex`, a slug something downstream has to recognise.
pub const MAX_MODEL_ID: usize = 256;
/// A cloud endpoint id, and the ONE number for it.
///
/// [`crate::endpoints::valid_id`] is the real grammar — `[a-z0-9-]` — and
/// reads its length from here so there is no second number to drift. This is
/// applied at the command boundary as well, because the id is the keychain
/// account name and the `LEMONADE_<ID>_API_KEY` stem, and because the store
/// refuses an invalid one by COPYING it into an error that crosses IPC:
/// unbounded, that is a megabyte of caller's choosing echoed back.
/// `inference_remove_endpoint` did not reach the grammar check at all — its
/// store path never called it — so the bound here is the only thing that
/// stood between a webview and an unbounded keychain account name.
pub const MAX_ENDPOINT_ID: usize = 40;
/// A reader-entered display name for a cloud endpoint row.
pub const MAX_ENDPOINT_LABEL: usize = 256;
/// A cloud endpoint's base URL, and — like [`MAX_ENDPOINT_ID`] — the one
/// number for it: [`crate::endpoints::valid_base_url`] reads its length from
/// here. Bounded at the command boundary too, because that validator refuses
/// by formatting the URL into a `ManifestMalformed` that crosses IPC.
pub const MAX_ENDPOINT_URL: usize = 400;
/// A pasted API credential. Generous — some providers issue long tokens —
/// but bounded before it reaches the blocking keychain write.
pub const MAX_ENDPOINT_KEY: usize = 8 * 1024;
/// The longest utterance the daemon may hand back.
///
/// ⚠️ **THE SPEECH BODY WAS UNBOUNDED**, and it was hidden by a timeout rather
/// than by a bound: the daemon client carried a ten-second TOTAL deadline, so
/// nothing could arrive for very long. Splitting the streaming client off
/// removed that deadline for the right reason — an answer legitimately takes
/// longer than ten seconds — and took the accidental cap with it. Found by
/// audit. `generate::stream` had a real bound all along
/// (`MAX_ANSWER_BYTES`); `speech::collect` read `response.bytes()` whole.
///
/// 32 MiB against a real utterance: `MAX_SPEECH_TEXT` is 4 KiB, roughly four
/// minutes of speech, and Kokoro's 24 kHz 16-bit mono is about 48 KB/s — call
/// it 11 MB. Far above anything legitimate, far below what hurts.
pub const MAX_SPEECH_BYTES: usize = 32 * 1024 * 1024;

/// Refuse `value` if it is over `limit`, naming the field.
///
/// BYTES, NOT CHARACTERS. What is being bounded is what gets allocated,
/// serialised and sent, and a `char` count under-reports every non-ASCII
/// book by up to four times.
pub fn within(field: &'static str, value: &str, limit: usize) -> Result<()> {
    if value.len() > limit {
        return Err(Error::FieldTooLarge { field, limit });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_field_at_the_limit_is_accepted_and_one_past_it_is_not() {
        assert!(within("question", &"x".repeat(MAX_QUESTION), MAX_QUESTION).is_ok());
        let over = within("question", &"x".repeat(MAX_QUESTION + 1), MAX_QUESTION);
        assert_eq!(over.unwrap_err().kind(), "fieldTooLarge");
    }

    /// The message names the field, because a command with five string
    /// parameters refusing "a field" tells nobody which one.
    #[test]
    fn the_refusal_names_the_field() {
        let refused = within("speech text", &"x".repeat(10), 1).unwrap_err();
        assert!(refused.to_string().contains("speech text"), "{refused}");
    }

    /// BYTES, NOT CHARACTERS. A `char` count would let a book of CJK or emoji
    /// through at up to four times the bound this is here to enforce.
    #[test]
    fn the_bound_is_in_bytes() {
        let four_byte = "🙂".repeat(3); // 12 bytes, 3 chars
        assert_eq!(four_byte.chars().count(), 3);
        assert!(within("question", &four_byte, 12).is_ok());
        assert!(within("question", &four_byte, 11).is_err());
    }
    /// EVERY STRING PARAMETER OF EVERY COMMAND IS BOUNDED — per FIELD, and
    /// over commands this test discovers rather than a list somebody keeps.
    ///
    /// ⚠️ **BOTH OF THOSE ARE CORRECTIONS.** What stood here asserted that
    /// each of six NAMED commands mentioned `limits::within` somewhere in its
    /// body, and it passed throughout: `inference_speak` bounded three of its
    /// four strings and left `voice` open, `inference_remove_model` was not on
    /// the list at all, and neither was any endpoint command — so the id that
    /// becomes a keychain account name, and the URL, went unbounded past a
    /// green test whose name claims otherwise. A test that asks "does this
    /// function mention the guard" answers a question nobody had.
    ///
    /// So: find every `#[tauri::command]`, read its signature, and require a
    /// `limits::within` call naming each `String` and `Option<String>` it
    /// takes. No list to fall behind, and no field that hides behind a
    /// bounded sibling.
    #[test]
    fn every_string_parameter_of_every_command_is_bounded() {
        let source = include_str!("commands.rs");
        let mut checked = 0;
        for (at, _) in source.match_indices("#[tauri::command]") {
            let rest = &source[at..];
            let signature_start = at + rest.find('(').expect("a command has a parameter list");
            /* Every command returns `Result<…>`, so this is the end of the
             * parameter list and the start of the body. A parameter TYPE
             * cannot contain it. */
            let body_start = at + rest.find(") -> Result").expect("a command returns Result");
            let name = rest[..rest.find('(').unwrap()]
                .rsplit("fn ")
                .next()
                .expect("a command is a fn")
                .split('<')
                .next()
                .expect("a name before any generics")
                .trim()
                .to_owned();
            let signature = &source[signature_start + 1..body_start];
            let body_end = source[body_start..]
                .find("\n}\n")
                .map(|end| body_start + end)
                .unwrap_or(source.len());
            let body = &source[body_start..body_end];

            for parameter in signature.split(',') {
                let Some((field, kind)) = parameter.split_once(':') else {
                    // The tail of a multi-part generic — `State<'_,
                    // InferenceState>` splits across the comma.
                    continue;
                };
                let (field, kind) = (field.trim(), kind.trim());
                if kind != "String" && kind != "Option<String>" {
                    continue;
                }
                checked += 1;
                assert!(
                    bounds(body, field),
                    "{name} takes {field}: {kind} from the webview and no \
                     limits::within call in its body names it"
                );
            }
        }
        /* A parser that matched nothing would pass every assertion above
         * without running one — the failure mode this file's own header
         * warns about in another form. */
        assert!(
            checked > 10,
            "only {checked} string parameters were found; the parse is wrong, not the code"
        );
    }

    /// Whether some `limits::within(…)` call in `body` bounds `field`.
    ///
    /// The call is `within("<name>", <value>, <limit>)` and this reads the
    /// VALUE, never the display name: the names are prose, and "endpoint id"
    /// contains the word `id`, so a looser match would let the bound on one
    /// parameter vouch for another.
    fn bounds(body: &str, field: &str) -> bool {
        const CALL: &str = "limits::within(";
        body.match_indices(CALL).any(|(start, _)| {
            let open = start + CALL.len();
            let end = body[open..]
                .find(')')
                .map(|end| open + end)
                .unwrap_or(body.len());
            body[open..end]
                .split(',')
                .nth(1)
                .is_some_and(|value| value.trim().trim_start_matches('&') == field)
        })
    }

    /// The parser above is the kind that finds nothing and looks clean, so it
    /// is pointed at a KNOWN POSITIVE and a known negative here.
    #[test]
    fn the_parameter_check_can_actually_fail() {
        let body = r#"
            limits::within("request id", &request_id, limits::MAX_REQUEST_ID)?;
            limits::within("voice", voice, limits::MAX_MODEL_ID)?;
        "#;
        assert!(bounds(body, "request_id"));
        assert!(bounds(body, "voice"));
        // Not a prefix match, and not "some bound exists nearby".
        assert!(!bounds(body, "id"));
        assert!(!bounds(body, "model"));
    }
}
