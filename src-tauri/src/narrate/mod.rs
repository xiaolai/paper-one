//! Reading a book into a file, in the platform's own voice.
//!
//! Read aloud goes through `window.speechSynthesis`, which is the right engine
//! for reading and useless for EXPORTING: there is no audio-capture API in Web
//! Speech at all. So an audiobook cannot be built on what the reader hears, and
//! this is the other road to the same voices —
//! `AVSpeechSynthesizer.writeUtterance:toBufferCallback:toMarkerCallback:`,
//! which hands back PCM and word markers instead of playing.
//!
//! It also reaches voices the WEBVIEW CANNOT SEE. Measured on macOS 27 on
//! 2026-09-20: `AVSpeechSynthesisVoice.speechVoices()` answered 192 voices
//! where `speechSynthesis.getVoices()` in a `WKWebView` answered 73, and the
//! three Enhanced ones were in the first list and not the second. A reader who
//! downloads a Premium voice may therefore be able to EXPORT in it before they
//! can read in it, which is why `narrate_voices` exists beside the web list.
//!
//! ## Three things measured the hard way, each of which had a wrong obvious answer
//!
//! ⚠️ **AN EMPTY BUFFER IS NOT THE END.** Twelve empty buffers arrived mid-way
//! through a 154-second render of twelve repeated sentences — one per internal
//! segment. Treating the first as the end truncates the book to 8 % and reports
//! success, which is the worst failure available here: a complete-looking file
//! with a twelfth of the book in it. The end is the DELEGATE's
//! `didFinishSpeechUtterance` and nothing else.
//!
//! ⚠️ **`byteSampleOffset` RESTARTS AT EVERY SEGMENT.** The same render gave 11
//! offset drops for 12 segments — `1068760 -> 0`, each at exactly one sentence's
//! worth of characters. Read as absolute, every word after the first segment
//! lands in the first twelve seconds, and the sync file looks plausible while
//! being wrong for 92 % of the book. `Timeline` below is the arithmetic that
//! fixes it, and it is pure so the trap has a test.
//!
//! ⚠️ **NOTHING ARRIVES ON A WORKER THREAD.** Started from a spawned thread
//! pumping its own `NSRunLoop`, the same render delivered 0 buffers, 0 markers
//! and no completion in 25 seconds. The write must be STARTED on the main
//! thread, and the app's own run loop is what then delivers the callbacks — so
//! this never waits on the main thread, it only posts work to it and waits on a
//! worker.
//!
//! ## What it costs
//!
//! 154 s of audio in 8.2 s — about 19× real time for a compact voice, so a
//! ten-hour book is roughly half an hour. ⚠️ **THAT NUMBER IS A COMPACT VOICE'S
//! AND IS AN UPPER BOUND.** Enhanced and Premium voices are larger models and
//! none was installed on the machine where this was measured; re-measure before
//! promising anything about them.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

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

/// What a voice's identifier says about its quality — see `ui/reader/voiceChoice.ts`,
/// which reads the same fact out of `voiceURI` on the web side.
///
/// TAKEN FROM `AVSpeechSynthesisVoiceQuality` HERE, not parsed out of the
/// identifier: on this side the platform answers the question directly, and a
/// string match would be a second implementation of something already given.
#[cfg(any(target_os = "macos", test))]
fn quality_name(raw: isize) -> &'static str {
    match raw {
        3 => "premium",
        2 => "enhanced",
        _ => "default",
    }
}

/// A voice this machine can read with.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    /// `com.apple.voice.premium.en-US.Ava` — the same string `voiceURI` carries.
    pub identifier: String,
    pub name: String,
    /// BCP 47, as the platform spells it: `en-US`, `zh-CN`.
    pub language: String,
    pub quality: &'static str,
}

/// Which kind of thing a marker marks.
///
/// The raw values are `AVSpeechSynthesisMarkerMark`'s, whose order is declared
/// in the SDK header: phoneme, word, sentence, paragraph, bookmark.
#[cfg(any(target_os = "macos", test))]
fn mark_name(raw: isize) -> &'static str {
    match raw {
        0 => "phoneme",
        1 => "word",
        2 => "sentence",
        3 => "paragraph",
        4 => "bookmark",
        _ => "other",
    }
}

/// One marker, placed on the whole render's timeline.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub kind: &'static str,
    /// Where in the TEXT this marker is — UTF-16 code units, which is what
    /// `NSRange` counts and what a JavaScript string index is.
    pub start: usize,
    pub len: usize,
    /// Milliseconds from the start of the render.
    pub at_ms: u64,
}

/// What a finished render produced.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub path: String,
    pub sample_rate: f64,
    pub frames: u64,
    pub duration_ms: u64,
    pub markers: Vec<Marker>,
}

/// The segment arithmetic, kept pure so the measured trap has a test.
///
/// Feed it what the callbacks report, in the order they report it: samples
/// arrive, an empty buffer ends a segment, markers carry an offset that is
/// relative to the segment they are in. It answers absolute positions.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Default)]
struct Timeline {
    /// Frames emitted across every segment so far.
    frames: u64,
    /// Frames emitted before the CURRENT segment began.
    segment_base: u64,
    sample_rate: f64,
    bytes_per_frame: usize,
}

#[cfg(any(target_os = "macos", test))]
impl Timeline {
    fn push_frames(&mut self, n: u64) {
        self.frames += n;
    }

    /// An empty buffer: the segment ended, so the next marker's zero means here.
    fn end_segment(&mut self) {
        self.segment_base = self.frames;
    }

    /// Where a marker sits on the whole render's timeline, in milliseconds.
    ///
    /// `None` while the format is still unknown — no buffer has arrived, so
    /// there is no sample rate to divide by and no frame size to divide with. A
    /// marker before the first buffer would otherwise be placed at zero, which
    /// is a real time and a wrong one.
    fn place(&self, byte_offset: usize) -> Option<u64> {
        if self.sample_rate <= 0.0 || self.bytes_per_frame == 0 {
            return None;
        }
        let within = (byte_offset / self.bytes_per_frame) as u64;
        let frames = self.segment_base + within;
        Some(((frames as f64 / self.sample_rate) * 1000.0).round() as u64)
    }

    fn duration_ms(&self) -> u64 {
        if self.sample_rate <= 0.0 {
            return 0;
        }
        ((self.frames as f64 / self.sample_rate) * 1000.0).round() as u64
    }
}

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

/// Every voice this machine can read with, including any the webview hides.
///
/// EMPTY, NEVER AN ERROR, on a platform with no engine: an empty list is what
/// the caller already has to handle — `getVoices()` answers `[]` until the
/// engine has loaded — and inventing a refusal here would give the picker a
/// second failure shape to draw for the same situation.
#[tauri::command]
pub fn narrate_voices() -> Vec<VoiceInfo> {
    #[cfg(target_os = "macos")]
    {
        apple::voices()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// Render `text` to a mono 16-bit WAV at `path`, and report where each word is.
///
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

/// Render `text` to a mono 16-bit WAV at `path`, and report where each word is.
///
/// ⚠️ **REFUSED BY NAME OFF macOS, rather than silently writing nothing.** A
/// command that answered an empty `Rendered` would hand the exporter a chapter
/// of no audio and let it carry on to the next one; the whole export has to stop
/// at the first platform that cannot do it.
///
/// ⚠️ **`async`, AND A SYNCHRONOUS VERSION DEADLOCKED THE APP.** Tauri runs a
/// synchronous command ON THE MAIN THREAD. This one posts the write to the main
/// thread and then waits for the callbacks that only the main thread's run loop
/// delivers — so run there itself, it blocked the thread it was waiting for.
/// Measured in the running app: a zero-byte file, an idle process at 0.1 % CPU,
/// and a bridge call that never returned. `narrate_voices` is synchronous and
/// fine, because it asks the main thread for nothing.
#[tauri::command]
pub async fn narrate_render<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    voice: String,
    rate: f32,
    path: String,
) -> Result<Rendered, String> {
    #[cfg(target_os = "macos")]
    {
        offload("render", move || {
            apple::render(&app, text, voice, rate, path)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, text, voice, rate, path);
        Err("Paper can only render audio on macOS".to_owned())
    }
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

    #[test]
    fn a_marker_offset_is_relative_to_its_segment() {
        let mut timeline = Timeline {
            sample_rate: 22_050.0,
            bytes_per_frame: 4,
            ..Timeline::default()
        };
        // One second of audio, then a segment boundary.
        timeline.push_frames(22_050);
        timeline.end_segment();
        // A marker at the very start of the SECOND segment is at one second,
        // not at zero — which is what an absolute reading would answer.
        assert_eq!(timeline.place(0), Some(1000));
        // And half a second into it, at one and a half.
        assert_eq!(timeline.place(22_050 / 2 * 4), Some(1500));
    }

    #[test]
    fn without_a_segment_boundary_an_offset_is_absolute() {
        let mut timeline = Timeline {
            sample_rate: 22_050.0,
            bytes_per_frame: 4,
            ..Timeline::default()
        };
        timeline.push_frames(22_050);
        assert_eq!(timeline.place(0), Some(0));
    }

    #[test]
    fn a_marker_before_the_first_buffer_has_no_time_rather_than_zero() {
        let timeline = Timeline::default();
        assert_eq!(timeline.place(0), None);
        // A sample rate without a frame size is just as unusable.
        let half = Timeline {
            sample_rate: 22_050.0,
            ..Timeline::default()
        };
        assert_eq!(half.place(64), None);
    }

    #[test]
    fn the_frame_size_is_read_and_not_assumed() {
        /* The same byte offset means a different time at a different frame size,
         * which is why `bytes_per_frame` comes off the format. */
        let float32 = Timeline {
            sample_rate: 1000.0,
            bytes_per_frame: 4,
            ..Timeline::default()
        };
        let int16 = Timeline {
            sample_rate: 1000.0,
            bytes_per_frame: 2,
            ..Timeline::default()
        };
        assert_eq!(float32.place(4000), Some(1000));
        assert_eq!(int16.place(4000), Some(2000));
    }

    #[test]
    fn duration_comes_from_the_frames_actually_written() {
        let mut timeline = Timeline {
            sample_rate: 22_050.0,
            bytes_per_frame: 4,
            ..Timeline::default()
        };
        assert_eq!(timeline.duration_ms(), 0);
        timeline.push_frames(11_025);
        assert_eq!(timeline.duration_ms(), 500);
        timeline.end_segment();
        timeline.push_frames(11_025);
        /* ACROSS SEGMENTS: the boundary moves the base and must not reset the
         * total, which is the same confusion from the other side. */
        assert_eq!(timeline.duration_ms(), 1000);
    }

    #[test]
    fn quality_and_mark_names_cover_what_the_sdk_declares() {
        assert_eq!(quality_name(3), "premium");
        assert_eq!(quality_name(2), "enhanced");
        assert_eq!(quality_name(1), "default");
        /* A tier this build has never heard of reads as `default` rather than
         * panicking: the enum gains members between releases. */
        assert_eq!(quality_name(99), "default");

        assert_eq!(mark_name(1), "word");
        assert_eq!(mark_name(2), "sentence");
        assert_eq!(mark_name(3), "paragraph");
        assert_eq!(mark_name(99), "other");
    }
}
