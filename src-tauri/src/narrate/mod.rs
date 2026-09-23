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

use serde::Serialize;

/// The container — pure Rust, no framework, tested everywhere. See the module.
///
/// ⚠️ **GATED, BECAUSE `mod narrate` IS PRIVATE AND `pub` DOES NOT SAVE IT.**
/// Nothing outside the Apple backend and these modules' own tests calls any of
/// this, so on Linux and Windows every item below is unreachable from the
/// crate's public API — which is `dead_code`, which `cargo clippy --all-targets
/// -- -D warnings` turns into a failed build. The audit caught it; a Mac never
/// could.
#[cfg(any(target_os = "macos", test))]
pub mod m4b;

/// The WAV between the engine and the encoder, both directions. See the module.
#[cfg(any(target_os = "macos", test))]
pub mod wav;

/// The Objective-C half. Everything above and below it is portable and tested
/// on every platform; only this is Apple's.
#[cfg(target_os = "macos")]
mod apple;

/// Run blocking work off both the main thread and the async runtime's own
/// threads.
///
/// `spawn_blocking` rather than simply awaiting in place: these two commands
/// block for as long as a chapter takes, and an `async` body that blocks holds a
/// runtime worker for the duration. The main thread stays free either way, which
/// is the part that matters — it is the one delivering the speech engine's
/// callbacks.
#[cfg(target_os = "macos")]
async fn offload<T, F>(what: &str, work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(outcome) => outcome,
        /* A panic in the worker, which would otherwise surface as a silent hang.
         * NAMED BY OPERATION: this helper serves both commands, and a hardcoded
         * "the render did not finish" reported a failed PACKAGE as a failed
         * render — which sends whoever is diagnosing it to the wrong half. */
        Err(error) => Err(format!("the {what} did not finish: {error}")),
    }
}

/// One chapter of an export: a title, and the file a render left behind.
///
/// ⚠️ **macOS's OWN, BECAUSE ONLY macOS READS IT.** It is deserialised from the
/// command's payload and then read by `apple::package` alone, so on any other
/// platform its fields have no reader at all — and `-D warnings` makes that a
/// build error. The Linux leg caught it on the 0.4.1 release commit; a Mac
/// cannot, because there the reader is compiled in. An `allow(dead_code)` would
/// have said these fields are unused of the two fields that ARE the wire
/// contract, so the platform boundary is written as one instead.
#[cfg(target_os = "macos")]
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChapterAudio {
    pub title: String,
    /// A WAV that `narrate_render` wrote.
    pub path: String,
}

/// What packaging produced.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Packaged {
    pub path: String,
    pub duration_ms: u64,
    pub chapters: usize,
}

/// Where each chapter begins once its audio is laid end to end.
///
/// PURE, so the arithmetic that decides where a chapter mark lands has a test
/// that needs no audio at all. The running total is in FRAMES and converted once,
/// because summing rounded milliseconds drifts: forty chapters rounded down
/// individually can put the last mark most of a second early.
#[cfg(any(target_os = "macos", test))]
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

/// Turn a book's rendered chapters into one `.m4b`.
///
/// ⚠️ **REFUSED OFF macOS**, like `narrate_render`: the encoder is the system's
/// own `afconvert`, and an exporter that silently produced a chapterless file
/// would be worse than one that stops.
///
/// ⚠️ **`async`, AND THAT IS NOT A STYLE CHOICE** — see `narrate_render`. A
/// synchronous command runs on the main thread, and encoding a whole book there
/// would freeze the window for the length of the export.
/// ⚠️ **AND OFF macOS IT TAKES NOTHING.** It used to take the payload everywhere
/// and drop it with a `let _ = (…)`, which consumes the values and reads none of
/// their fields — see `ChapterAudio`. The command still EXISTS on every platform
/// and still refuses by name, which is what stops an exporter carrying on past a
/// platform that cannot do it: Tauri deserialises the arguments a command
/// declares and ignores the rest of the payload.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn narrate_package(
    chapters: Vec<ChapterAudio>,
    title: String,
    author: String,
    path: String,
) -> Result<Packaged, String> {
    offload("package", move || {
        apple::package(chapters, title, author, path)
    })
    .await
}

/// Refused, with nothing to take: see the macOS form above.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn narrate_package() -> Result<Packaged, String> {
    Err("Paper can only package an audiobook on macOS".to_owned())
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
