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
pub const MAX_MODEL_ID: usize = 256;
/// A reader-entered display name for a cloud endpoint row.
pub const MAX_ENDPOINT_LABEL: usize = 256;
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
    /// EVERY COMMAND THAT TAKES A STRING BOUNDS IT. The list is here rather
    /// than in a comment because a command added later with an unbounded
    /// `String` is exactly the regression this file exists to prevent, and a
    /// prose reminder does not fail.
    #[test]
    fn every_string_taking_command_checks_a_limit() {
        let source = include_str!("commands.rs");
        for command in [
            "inference_generate",
            "inference_gloss",
            "inference_speak",
            "agent_ask",
            "inference_cancel",
            "inference_install_model",
        ] {
            let at = source
                .find(&format!("pub async fn {command}"))
                .unwrap_or_else(|| panic!("{command} is not in commands.rs under that name"));
            let body_end = source[at..]
                .find("\n}\n")
                .map(|end| at + end)
                .unwrap_or(source.len());
            assert!(
                source[at..body_end].contains("limits::within"),
                "{command} takes caller-controlled input and bounds none of it"
            );
        }
    }
}
