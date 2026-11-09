//! Every bound the plugin places on what the webview may ask of it, each with
//! its own name.
//!
//! ⚠️ **THE CALLER IS NOT TRUSTED TO BE PAPER.** The threat model in
//! `dev-docs/decisions/2026-11-09-narration-boundary.md` is script running in
//! the main window: it can call every command this plugin grants, as often and
//! with whatever arguments it likes. A bound that only Paper's own front end
//! respects is not a bound, so each one is enforced here, at the command, and
//! refused by a variant a test can match rather than by a sentence a test would
//! have to parse.

use std::fmt;

/// The most chapters one book may have. The largest spine in the 1 959-book
/// library is a few hundred sections; this is several times that, and small
/// enough that a payload of empty chapters cannot make the join allocate
/// without limit.
pub const MAX_CHAPTERS: usize = 2_000;

/// The longest title, author or chapter title, in UTF-8 bytes. They are
/// written into the container as text samples and metadata, so an unbounded
/// one is an unbounded allocation in the muxer.
pub const MAX_TEXT_BYTES: usize = 1_024;

/// The largest single input WAV. A WAV states its length in 32 bits, so no
/// valid chapter is larger than 4 GiB; a quarter of that is about 6.7 hours of
/// 22.05 kHz mono, far beyond any one section, and it is what one read may
/// allocate.
pub const MAX_INPUT_BYTES: u64 = 1 << 30;

/// How many exports may hold a scratch directory at once.
pub const MAX_LIVE_RUNS: usize = 4;

/// How many picked destinations may be waiting for their package at once.
pub const MAX_LIVE_TOKENS: usize = 4;

/// What a bound refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    TooManyChapters(usize),
    TextTooLong { what: &'static str, bytes: usize },
    InputTooLarge { chapter: usize, bytes: u64 },
    TooManyRuns,
    TooManyTokens,
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyChapters(count) => write!(
                f,
                "this book has {count} chapters, and an audiobook may have at most {MAX_CHAPTERS}"
            ),
            Self::TextTooLong { what, bytes } => write!(
                f,
                "the {what} is {bytes} bytes long, and at most {MAX_TEXT_BYTES} are kept"
            ),
            Self::InputTooLarge { chapter, bytes } => write!(
                f,
                "chapter {chapter} is {bytes} bytes of audio, more than one chapter may be \
                 ({MAX_INPUT_BYTES} bytes)"
            ),
            Self::TooManyRuns => write!(
                f,
                "{MAX_LIVE_RUNS} exports are already running; wait for one to finish"
            ),
            Self::TooManyTokens => write!(
                f,
                "{MAX_LIVE_TOKENS} destinations are already waiting to be written; finish or \
                 cancel one first"
            ),
        }
    }
}

impl From<Refused> for String {
    fn from(refused: Refused) -> Self {
        refused.to_string()
    }
}

/// Refuse a text field longer than [`MAX_TEXT_BYTES`].
pub fn text(what: &'static str, value: &str) -> Result<(), Refused> {
    if value.len() > MAX_TEXT_BYTES {
        return Err(Refused::TextTooLong {
            what,
            bytes: value.len(),
        });
    }
    Ok(())
}

/// Refuse a book with more than [`MAX_CHAPTERS`] chapters.
pub fn chapters(count: usize) -> Result<(), Refused> {
    if count > MAX_CHAPTERS {
        return Err(Refused::TooManyChapters(count));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_at_the_bound_is_kept_and_one_byte_over_is_refused() {
        assert_eq!(text("title", &"a".repeat(MAX_TEXT_BYTES)), Ok(()));
        assert_eq!(
            text("title", &"a".repeat(MAX_TEXT_BYTES + 1)),
            Err(Refused::TextTooLong {
                what: "title",
                bytes: MAX_TEXT_BYTES + 1
            })
        );
    }

    #[test]
    fn the_text_bound_counts_bytes_not_characters() {
        /* Three bytes each: 342 of them is 1 026 bytes, though only 342 chars. */
        let cjk = "章".repeat(342);
        assert!(matches!(
            text("author", &cjk),
            Err(Refused::TextTooLong { what: "author", .. })
        ));
    }

    #[test]
    fn a_book_at_the_chapter_bound_is_kept_and_one_over_is_refused() {
        assert_eq!(chapters(MAX_CHAPTERS), Ok(()));
        assert_eq!(
            chapters(MAX_CHAPTERS + 1),
            Err(Refused::TooManyChapters(MAX_CHAPTERS + 1))
        );
    }

    #[test]
    fn every_refusal_says_its_own_bound() {
        for (refused, says) in [
            (Refused::TooManyChapters(3_000), "2000"),
            (
                Refused::TextTooLong {
                    what: "title",
                    bytes: 2_000,
                },
                "title",
            ),
            (
                Refused::InputTooLarge {
                    chapter: 7,
                    bytes: 5,
                },
                "chapter 7",
            ),
            (Refused::TooManyRuns, "exports are already running"),
            (Refused::TooManyTokens, "destinations are already waiting"),
        ] {
            let said = String::from(refused);
            assert!(said.contains(says), "{said}");
        }
    }
}
