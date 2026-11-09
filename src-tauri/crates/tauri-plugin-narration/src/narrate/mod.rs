//! Joining a book's rendered chapters into one `.m4b`.
//!
//! ⚠️ **THIS MODULE NO LONGER RENDERS ANYTHING, AND ITS HEADER DESCRIBED A
//! RENDERER UNTIL PHASE 30.** `narrate_render` and `narrate_voices` went
//! through `AVSpeechSynthesizer.writeUtterance:…`, which reached voices the
//! WebView cannot see — and the 2026-09-22 measurement settled that none of
//! them are reachable by a caller Apple did not sign either. Every voice it
//! could actually use was below the floor the reading refuses, so the export
//! could not produce a file anybody would want, and the whole of it was
//! deleted (owner's decision, 2026-09-23).
//!
//! **Chapters are rendered by `tauri-plugin-voices` now** — Kokoro or Qwen,
//! on weights the reader downloaded — and arrive here as the WAV shape
//! `wav::read` accepts. What is left is the part that was always portable and
//! always worth keeping: the join, `afconvert`, and the container.
//!
//! ## What survives, and why each piece is the way it is
//!
//! ⚠️ **`afconvert`'s OWN WAV PUTS `FLLR` WHERE `data` BELONGS** — a size field
//! of 4 044 with 278 398 bytes of audio after it. A tolerant reader would hand
//! the encoder 4 044 bytes of padding and call it a chapter: a book of silence
//! with no error anywhere. `wav::read` therefore accepts **only** the one shape
//! the engines write and refuses everything else by name.
//!
//! ⚠️ **`chapter_starts` ACCUMULATES IN FRAMES AND CONVERTS ONCE.** Summing
//! rounded milliseconds drifts: forty chapters each rounded down can put the
//! last mark most of a second early.
//!
//! ⚠️ **AND THE CONTAINER IS WRITTEN BY HAND, IN PURE RUST** — see `m4b`. Two
//! readers must agree about it, and ffmpeg and AVFoundation disagreed on three
//! separate defects; a green ffprobe means nothing on its own.
//!
//! ⚠️ **MOVED FROM THE APP CRATE INTO `tauri-plugin-narration`, 2026-11-09.**
//! The command that drives this is the plugin's `narrate_package` now, and it
//! takes a token for the destination and a run id for the scratch — never a
//! path from the window. See `crate::commands`.

use serde::Serialize;

/// The container — pure Rust, no framework, tested everywhere. See the module.
///
/// UNGATED since the move into this plugin: it is a public module of a library
/// crate, so nothing in it is `dead_code` on a platform that never calls it.
pub mod m4b;

/// The WAV between the engine and the encoder, both directions. See the module.
pub mod wav;

/// The join, the encoder and the container, in order. Only the call to
/// `afconvert` is Apple's.
pub mod apple;

/// Whether this platform can package a book at all: the encoder is macOS's own
/// `afconvert`, and an exporter that silently produced a chapterless file would
/// be worse than one that stops.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

/// The refusal everywhere else.
pub const UNSUPPORTED: &str = "Paper can only package an audiobook on macOS";

/// Run blocking work off both the main thread and the async runtime's own
/// threads.
///
/// `spawn_blocking` rather than simply awaiting in place: a package blocks for
/// as long as the encoder takes, and an `async` body that blocks holds a
/// runtime worker for the duration.
pub async fn offload<T, F>(what: &str, work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(outcome) => outcome,
        /* A panic in the worker, which would otherwise surface as a silent hang.
         * NAMED BY OPERATION, so a failed package is not reported as something
         * else. */
        Err(error) => Err(format!("the {what} did not finish: {error}")),
    }
}

/// What packaging produced, as the window is told it.
///
/// ⚠️ **THE NAME, NOT THE PATH.** The window never held the destination's path
/// — it holds a token — so the answer does not hand it one either. A name is
/// all a notice needs.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Packaged {
    pub name: String,
    pub duration_ms: u64,
    pub chapters: usize,
}

/// Where each chapter begins once its audio is laid end to end.
///
/// PURE, so the arithmetic that decides where a chapter mark lands has a test
/// that needs no audio at all. The running total is in FRAMES and converted once,
/// because summing rounded milliseconds drifts: forty chapters rounded down
/// individually can put the last mark most of a second early.
pub fn chapter_starts(parts: &[wav::Facts]) -> Result<Vec<u64>, String> {
    let mut starts = Vec::with_capacity(parts.len());
    let mut frames = 0u64;
    let rate = match parts.first() {
        Some(first) => first.sample_rate,
        None => return Ok(starts),
    };
    /* A ZERO RATE IS AN ERROR, NOT A PANIC. `wav::read` refuses one today, so
     * this is unreachable through the only caller — but `Facts` has public
     * fields and this function returns `Result`, so the one outcome it must not
     * have is a division by zero in a release build. */
    if rate == 0 {
        return Err("the first chapter reports a sample rate of zero".to_owned());
    }
    for (index, part) in parts.iter().enumerate() {
        /* ⚠️ **ONE RATE FOR THE WHOLE BOOK.** Chapters are rendered separately, so
         * two could in principle come back at different rates — and a single
         * concatenated stream has one. Refused rather than resampled: resampling
         * is a decision about sound, and this module decides about time. */
        if part.sample_rate != rate {
            return Err(format!(
                "chapter {} was rendered at {}Hz and the first at {rate}Hz, which cannot be one \
                 file",
                index + 1,
                part.sample_rate
            ));
        }
        starts.push(frames * 1000 / u64::from(rate));
        frames += part.frames;
    }
    Ok(starts)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ **THE TRAP THIS MODULE EXISTS TO NOT SHIP.** Measured 2026-09-20: a
    /// 154-second render of twelve repeated sentences gave 11 offset drops —
    /// `byteSampleOffset` restarts at every internal segment. Read as absolute,
    /// every word after the first segment lands in the first twelve seconds.
    /// ⚠️ **THE DOC CLAIMED THIS TEST EXISTED AND IT DID NOT.** `chapter_starts`
    /// says "PURE, so the arithmetic that decides where a chapter mark lands has
    /// a test that needs no audio at all" — a guarantee written down and never
    /// written. The audit found it.
    #[test]
    fn chapter_starts_accumulate_in_frames() {
        let at = |frames| wav::Facts {
            sample_rate: 22_050,
            frames,
        };
        /* One second, then half a second, then the rest. */
        let starts = chapter_starts(&[at(22_050), at(11_025), at(22_050)]).expect("starts");
        assert_eq!(starts, vec![0, 1000, 1500]);
    }

    #[test]
    fn chapter_starts_do_not_drift_over_many_chapters() {
        /* THE REASON THE RUNNING TOTAL IS IN FRAMES. 1000 frames at 22 050Hz is
         * 45.35ms; rounded down to 45 and summed, forty of them lose 14ms. */
        let at = |frames| wav::Facts {
            sample_rate: 22_050,
            frames,
        };
        let parts: Vec<_> = std::iter::repeat_n(at(1000), 40).collect();
        let starts = chapter_starts(&parts).expect("starts");
        assert_eq!(starts[39], 39 * 1000 * 1000 / 22_050);
        assert_ne!(starts[39], 39 * (1000 * 1000 / 22_050));
    }

    #[test]
    fn chapter_starts_refuse_a_mixed_rate_book() {
        let starts = chapter_starts(&[
            wav::Facts {
                sample_rate: 22_050,
                frames: 100,
            },
            wav::Facts {
                sample_rate: 44_100,
                frames: 100,
            },
        ]);
        assert!(starts.expect_err("refuses").contains("cannot be one file"));
    }

    #[test]
    fn chapter_starts_refuse_a_zero_rate_rather_than_dividing_by_it() {
        let starts = chapter_starts(&[wav::Facts {
            sample_rate: 0,
            frames: 100,
        }]);
        assert!(starts.expect_err("refuses").contains("sample rate of zero"));
    }

    #[test]
    fn chapter_starts_of_nothing_is_nothing() {
        assert_eq!(chapter_starts(&[]).expect("empty"), Vec::<u64>::new());
    }
}
