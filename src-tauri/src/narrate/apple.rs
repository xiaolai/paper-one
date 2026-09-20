//! The Apple half of rendering — `AVSpeechSynthesizer`, its two callbacks, and
//! the one thread they will speak to.
//!
//! Split from `mod.rs` for the reason the module header gives: the arithmetic
//! that placed the markers is where the measured trap lives, and it is worth
//! testing on a machine that has no AVFoundation. What is here can only be
//! exercised by running it.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_avf_audio::{
    AVAudioBuffer, AVAudioPCMBuffer, AVSpeechSynthesisMarker, AVSpeechSynthesisVoice,
    AVSpeechSynthesizer, AVSpeechSynthesizerDelegate, AVSpeechUtterance,
};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString};
use tauri::{AppHandle, Runtime};

use super::wav;
use super::{
    chapter_starts, m4b, mark_name, quality_name, ChapterAudio, Marker, Packaged, Rendered,
    Timeline, VoiceInfo,
};

/// How long a render may go without a single callback before it is refused.
///
/// A WATCHDOG ON SILENCE, not a budget for the whole render — which cannot be
/// bounded, because it scales with the chapter. Any progress resets it, so a
/// long chapter never trips it and a wedged engine always does.
const STALL: Duration = Duration::from_secs(30);

/// Everything a render in flight is accumulating.
struct Progress {
    timeline: Timeline,
    markers: Vec<Marker>,
    writer: Option<BufWriter<File>>,
    /// Set by the delegate. The ONLY thing that means the render is complete.
    finished: bool,
    /// A write that failed, or a buffer that made no sense — reported rather
    /// than swallowed, because a short file is otherwise indistinguishable from
    /// a short chapter.
    failure: Option<String>,
    last_activity: Instant,
}

struct Shared {
    progress: Mutex<Progress>,
    woke: Condvar,
}

/// The Objective-C objects a render needs kept alive while it runs.
///
/// ⚠️ **WITHOUT THIS THE RENDER IS CANCELLED THE INSTANT IT STARTS.** The
/// closure posted to the main thread creates the synthesiser, the delegate and
/// the two blocks and then returns — dropping every one of them, which releases
/// the synthesiser mid-render. They have to outlive the closure.
///
/// ONE SLOT, because a render is sequential: the exporter does one chapter at a
/// time, and a second render while one is in flight is refused by name rather
/// than queued. The previous render's objects are dropped when the next one
/// starts, which happens ON THE MAIN THREAD — the only thread it is safe to
/// release them from.
struct Live {
    _synth: Retained<AVSpeechSynthesizer>,
    _delegate: Retained<Watcher>,
    _on_buffer: RcBlock<dyn Fn(NonNull<AVAudioBuffer>)>,
    _on_marker: RcBlock<dyn Fn(NonNull<NSArray<AVSpeechSynthesisMarker>>)>,
}

/* SAFETY: the value is only ever constructed, stored and dropped on the main
 * thread — `start_on_main` does all three — and the `Mutex` is what carries it
 * across the posting thread's boundary without being touched there. */
unsafe impl Send for Live {}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "PaperNarrateWatcher"]
    #[ivars = Arc<Shared>]
    struct Watcher;

    unsafe impl NSObjectProtocol for Watcher {}

    /// ⚠️ **THE DELEGATE IS THE ONLY HONEST END.** See the module header: an
    /// empty buffer arrives once per internal segment, so the first one is a
    /// twelfth of the way through a long chapter.
    unsafe impl AVSpeechSynthesizerDelegate for Watcher {
        #[unsafe(method(speechSynthesizer:didFinishSpeechUtterance:))]
        fn did_finish(&self, _synth: &AVSpeechSynthesizer, _utterance: &AVSpeechUtterance) {
            self.ivars().finish(None);
        }

        /* A cancel is an END, and a FAILURE. Nothing in this module cancels, so
         * reaching here means the engine gave up — and the file on disk is a
         * part of a chapter, which must never be handed back as a chapter. */
        #[unsafe(method(speechSynthesizer:didCancelSpeechUtterance:))]
        fn did_cancel(&self, _synth: &AVSpeechSynthesizer, _utterance: &AVSpeechUtterance) {
            self.ivars()
                .finish(Some("the speech engine cancelled the utterance".to_owned()));
        }
    }
);

impl Shared {
    fn finish(&self, failure: Option<String>) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.finished = true;
            progress.last_activity = Instant::now();
            if failure.is_some() && progress.failure.is_none() {
                progress.failure = failure;
            }
        }
        self.woke.notify_all();
    }
}

/// Every voice this machine can read with, including any the webview hides.
pub(super) fn voices() -> Vec<VoiceInfo> {
    let voices = unsafe { AVSpeechSynthesisVoice::speechVoices() };
    voices
        .iter()
        .map(|voice| VoiceInfo {
            identifier: unsafe { voice.identifier() }.to_string(),
            name: unsafe { voice.name() }.to_string(),
            language: unsafe { voice.language() }.to_string(),
            quality: quality_name(unsafe { voice.quality() }.0),
        })
        .collect()
}

/// Render `text` to a mono 16-bit WAV at `path`, and report where each word is.
///
/// BLOCKING, on a worker thread, which is where Tauri runs a non-async command:
/// the wait is here and the work is posted to the main thread, because the
/// callbacks arrive nowhere else (module header).
pub(super) fn render<R: Runtime>(
    app: &AppHandle<R>,
    text: String,
    voice: String,
    rate: f32,
    path: String,
) -> Result<Rendered, String> {
    if text.trim().is_empty() {
        return Err("nothing to read: the text is empty".to_owned());
    }
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| format!("{path} has no directory to write into"))?;
    if !parent.is_dir() {
        return Err(format!("{} is not a directory", parent.display()));
    }

    let file = File::create(&target).map_err(|error| format!("cannot write {path}: {error}"))?;
    let mut writer = BufWriter::new(file);
    /* A PLACEHOLDER HEADER, rewritten at the end: the frame count is not known
     * until the engine has finished, and a WAV states it twice up front. */
    writer
        .write_all(&wav::header(0, 22_050))
        .map_err(|error| format!("cannot write {path}: {error}"))?;

    let shared = Arc::new(Shared {
        progress: Mutex::new(Progress {
            timeline: Timeline::default(),
            markers: Vec::new(),
            writer: Some(writer),
            finished: false,
            failure: None,
            last_activity: Instant::now(),
        }),
        woke: Condvar::new(),
    });

    let started = start_on_main(app, shared.clone(), text, voice, rate);
    if let Err(error) = started {
        let _ = std::fs::remove_file(&target);
        return Err(error);
    }

    let outcome = wait_for(&shared);

    /* THE FILE GOES WITH ANY REFUSAL. A partial WAV left on disk is a chapter
     * that plays, ends early, and says nothing about it — the failure this
     * whole module is most at risk of shipping. */
    let finalized = match outcome {
        Err(error) => {
            let _ = std::fs::remove_file(&target);
            return Err(error);
        }
        Ok(()) => finalize(&shared, &target),
    };
    match finalized {
        Ok(rendered) => Ok(rendered),
        Err(error) => {
            let _ = std::fs::remove_file(&target);
            Err(error)
        }
    }
}

/// Wait until the delegate says the utterance finished, or nothing has happened
/// for `STALL`.
///
/// ⚠️ **A TIMEOUT IS A REFUSAL, NEVER A RESULT.** "The engine stopped talking to
/// us" and "the chapter ended" are the same silence, and only one of them is a
/// finished chapter. Reporting the shorter file as a success is how a book gets
/// exported with a paragraph in it.
fn wait_for(shared: &Arc<Shared>) -> Result<(), String> {
    let mut progress = shared
        .progress
        .lock()
        .map_err(|_| "the render's state was poisoned".to_owned())?;
    loop {
        if let Some(failure) = &progress.failure {
            return Err(failure.clone());
        }
        if progress.finished {
            return Ok(());
        }
        let quiet = progress.last_activity.elapsed();
        if quiet >= STALL {
            return Err(format!(
                "the speech engine went quiet for {}s without finishing the utterance, so what \
                 was written is part of a chapter and has been discarded",
                quiet.as_secs()
            ));
        }
        let (next, _) = shared
            .woke
            .wait_timeout(progress, STALL - quiet)
            .map_err(|_| "the render's state was poisoned".to_owned())?;
        progress = next;
    }
}

/// Close the file, patch the header, and answer what was produced.
fn finalize(shared: &Arc<Shared>, target: &Path) -> Result<Rendered, String> {
    let mut progress = shared
        .progress
        .lock()
        .map_err(|_| "the render's state was poisoned".to_owned())?;
    if let Some(failure) = progress.failure.clone() {
        return Err(failure);
    }
    let writer = progress
        .writer
        .take()
        .ok_or_else(|| "the render wrote nothing at all".to_owned())?;
    let mut file = writer
        .into_inner()
        .map_err(|error| format!("cannot flush the audio: {error}"))?;

    let frames = progress.timeline.frames;
    let sample_rate = progress.timeline.sample_rate;
    /* ⚠️ **AN EMPTY RENDER IS A FAILURE, NOT AN EMPTY CHAPTER.** The engine
     * reporting `didFinish` having produced no audio is the shape a wrong voice
     * identifier or an unspeakable text takes, and a zero-length WAV is a file
     * every player opens and nothing plays. */
    if frames == 0 || sample_rate <= 0.0 {
        return Err("the speech engine finished without producing any audio".to_owned());
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("cannot rewrite the audio header: {error}"))?;
    file.write_all(&wav::header(frames, sample_rate as u32))
        .map_err(|error| format!("cannot rewrite the audio header: {error}"))?;
    file.flush()
        .map_err(|error| format!("cannot flush the audio: {error}"))?;

    Ok(Rendered {
        path: target.to_string_lossy().into_owned(),
        sample_rate,
        frames,
        duration_ms: progress.timeline.duration_ms(),
        markers: std::mem::take(&mut progress.markers),
    })
}

/// Build the synthesiser and start the write — on the main thread, always.
fn start_on_main<R: Runtime>(
    app: &AppHandle<R>,
    shared: Arc<Shared>,
    text: String,
    voice: String,
    rate: f32,
) -> Result<(), String> {
    /* The identifier is resolved on the main thread too, so the refusal comes
     * back through the same channel every other failure does. */
    let (ready, answered) = std::sync::mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let outcome = (|| -> Result<(), String> {
            let ident = NSString::from_str(&voice);
            let found = unsafe { AVSpeechSynthesisVoice::voiceWithIdentifier(&ident) }
                .ok_or_else(|| format!("this machine has no voice called {voice}"))?;

            let utterance =
                unsafe { AVSpeechUtterance::speechUtteranceWithString(&NSString::from_str(&text)) };
            unsafe { utterance.setVoice(Some(&found)) };
            /* ⚠️ **A DIFFERENT SCALE FROM THE WEB'S.** `AVSpeechUtterance.rate`
             * runs 0…1 with the default near 0.5, where `SpeechSynthesisUtterance.rate`
             * is a multiplier with a default of 1. The caller speaks the web's
             * language, so a multiplier is converted here rather than each caller
             * being asked to know which engine it is talking to. Clamped to the
             * platform's own ends, which is what it does itself anyway — stated
             * so a stored preference from a wider build cannot throw. */
            if rate.is_finite() && rate > 0.0 {
                let default = unsafe { objc2_avf_audio::AVSpeechUtteranceDefaultSpeechRate };
                let min = unsafe { objc2_avf_audio::AVSpeechUtteranceMinimumSpeechRate };
                let max = unsafe { objc2_avf_audio::AVSpeechUtteranceMaximumSpeechRate };
                unsafe { utterance.setRate((default * rate).clamp(min, max)) };
            }

            let watcher: Retained<Watcher> = {
                let this = Watcher::alloc().set_ivars(shared.clone());
                unsafe { msg_send![super(this), init] }
            };
            let synth = unsafe { AVSpeechSynthesizer::new() };
            unsafe { synth.setDelegate(Some(ProtocolObject::from_ref(&*watcher))) };

            let on_buffer = {
                let shared = shared.clone();
                RcBlock::new(move |buf: NonNull<AVAudioBuffer>| {
                    take_buffer(&shared, buf);
                })
            };
            let on_marker = {
                let shared = shared.clone();
                RcBlock::new(move |list: NonNull<NSArray<AVSpeechSynthesisMarker>>| {
                    take_markers(&shared, list);
                })
            };

            unsafe {
                /* ⚠️ **`&*block`, NOT `&block`.** A reference to the `RcBlock`
                 * is a pointer to the smart pointer; the callee reads it as a
                 * block header and segfaults — measured, exit 139. */
                synth.writeUtterance_toBufferCallback_toMarkerCallback(
                    &utterance,
                    &*on_buffer as *const _ as *mut _,
                    &*on_marker as *const _ as *mut _,
                );
            }

            /* HELD PAST THE END OF THIS CLOSURE — see `Live`. Replacing the slot
             * drops the previous render's objects here, on the main thread. */
            if let Ok(mut live) = LIVE.lock() {
                *live = Some(Live {
                    _synth: synth,
                    _delegate: watcher,
                    _on_buffer: on_buffer,
                    _on_marker: on_marker,
                });
            }
            Ok(())
        })();
        /* A receiver that has gone means the caller stopped waiting; the render
         * will be dropped by the next one. */
        let _ = ready.send(outcome);
    })
    .map_err(|error| format!("cannot reach the main thread to start the render: {error}"))?;

    answered
        .recv_timeout(STALL)
        .map_err(|_| "the main thread did not start the render".to_owned())?
}

/// One buffer of samples, or the empty buffer that ends a segment.
fn take_buffer(shared: &Arc<Shared>, buf: NonNull<AVAudioBuffer>) {
    let Ok(mut progress) = shared.progress.lock() else {
        return;
    };
    progress.last_activity = Instant::now();

    /* SAFETY: `writeUtterance`'s buffer callback is documented to deliver
     * `AVAudioPCMBuffer`s, and the measured format confirms it (float32 mono).
     * A non-PCM buffer would have no `frameLength`, so the cast is checked by
     * asking the object rather than assumed — `downcast_ref` is the objc2 way
     * and is used here for exactly that reason. */
    let buffer = unsafe { buf.as_ref() };
    let Some(pcm) = buffer.downcast_ref::<AVAudioPCMBuffer>() else {
        if progress.failure.is_none() {
            progress.failure = Some(
                "the speech engine sent audio in a shape Paper cannot read; \
                                     what was written has been discarded"
                    .to_owned(),
            );
        }
        shared.woke.notify_all();
        return;
    };

    let frames = unsafe { pcm.frameLength() } as usize;
    if frames == 0 {
        progress.timeline.end_segment();
        return;
    }

    if progress.timeline.sample_rate <= 0.0 {
        let format = unsafe { pcm.format() };
        progress.timeline.sample_rate = unsafe { format.sampleRate() };
        /* READ FROM THE FORMAT, never assumed to be 4. A compact voice answers
         * float32 mono; a downloaded voice need not, and a hardcoded frame size
         * puts every word timing out by a constant factor. */
        let description = unsafe { format.streamDescription() };
        progress.timeline.bytes_per_frame = unsafe { description.as_ref().mBytesPerFrame } as usize;
    }

    let channels = unsafe { pcm.floatChannelData() };
    if channels.is_null() {
        if progress.failure.is_none() {
            progress.failure = Some(
                "the speech engine sent audio that is not 32-bit float, which Paper cannot \
                 convert; what was written has been discarded"
                    .to_owned(),
            );
        }
        shared.woke.notify_all();
        return;
    }
    /* SAFETY: `floatChannelData` is an array of per-channel pointers, each with
     * `frameLength` valid samples. Only the FIRST channel is read: the engine
     * answers mono (measured `channels=1`), and mixing an unexpected second
     * channel down would be inventing a stereo policy nothing asked for. */
    let samples = unsafe { std::slice::from_raw_parts((*channels).as_ptr(), frames) };

    let Some(writer) = progress.writer.as_mut() else {
        return;
    };
    let mut bytes = Vec::with_capacity(frames * 2);
    for sample in samples {
        bytes.extend_from_slice(&wav::to_i16(*sample).to_le_bytes());
    }
    if let Err(error) = writer.write_all(&bytes) {
        if progress.failure.is_none() {
            progress.failure = Some(format!("cannot write the audio: {error}"));
        }
        shared.woke.notify_all();
        return;
    }
    progress.timeline.push_frames(frames as u64);
}

/// A batch of markers, placed on the render's own timeline.
fn take_markers(shared: &Arc<Shared>, list: NonNull<NSArray<AVSpeechSynthesisMarker>>) {
    let Ok(mut progress) = shared.progress.lock() else {
        return;
    };
    progress.last_activity = Instant::now();
    /* SAFETY: the callback owns the array for the duration of the call. */
    let markers = unsafe { list.as_ref() };
    for marker in markers {
        let raw_kind = unsafe { marker.mark() }.0;
        let range = unsafe { marker.textRange() };
        /* `NSUInteger` IS `usize` on every target this builds for, so clippy
         * refuses the cast as redundant rather than defensive. */
        let offset = unsafe { marker.byteSampleOffset() };
        /* Dropped rather than placed at zero when no buffer has arrived yet —
         * see `Timeline::place`. A marker with no timeline is a word with no
         * time, and zero is a real time. */
        if let Some(at_ms) = progress.timeline.place(offset) {
            progress.markers.push(Marker {
                kind: mark_name(raw_kind),
                start: range.location,
                len: range.length,
                at_ms,
            });
        }
    }
}

/// Encode every chapter's audio into one AAC stream and mux it with its chapters.
///
/// `afconvert` IS THE ENCODER, and it is in `/usr/bin` on every Mac — so this
/// needs nothing bundled and no second opinion about AAC. The muxing is
/// `m4b`'s, which is pure Rust and knows nothing about this file.
pub(super) fn package(
    chapters: Vec<ChapterAudio>,
    title: String,
    author: String,
    path: String,
) -> Result<Packaged, String> {
    if chapters.is_empty() {
        return Err("there are no chapters to package".to_owned());
    }

    /* READ EVERY CHAPTER FIRST, before writing anything. A book that fails on
     * its last chapter should leave no half-written file behind, and finding out
     * early costs one pass over files already on disk. */
    let mut parts = Vec::with_capacity(chapters.len());
    for (index, chapter) in chapters.iter().enumerate() {
        let bytes = std::fs::read(&chapter.path)
            .map_err(|error| format!("cannot read chapter {}: {error}", index + 1))?;
        let facts = wav::read(&bytes)
            .map_err(|error| format!("chapter {} ({}): {error}", index + 1, chapter.title))?;
        parts.push((bytes, facts));
    }

    let facts: Vec<wav::Facts> = parts.iter().map(|(_, f)| *f).collect();
    let starts = chapter_starts(&facts)?;
    let rate = facts[0].sample_rate;
    let total_frames: u64 = facts.iter().map(|f| f.frames).sum();
    if total_frames == 0 {
        return Err("every chapter is empty, so there is no book to write".to_owned());
    }

    /* ONE WAV FOR THE WHOLE BOOK, beside the destination rather than in a shared
     * temporary directory: it is as large as the book, and a reader who chose
     * where the book goes has chosen somewhere with room for it. Removed
     * whatever happens next. */
    let target = std::path::PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| format!("{path} has no directory to write into"))?;
    let joined = parent.join(format!(".paper-audiobook-{}.wav", std::process::id()));
    let adts = joined.with_extension("adts");

    let outcome = (|| -> Result<Packaged, String> {
        let mut whole = Vec::with_capacity(wav::HEADER_BYTES + (total_frames * 2) as usize);
        whole.extend_from_slice(&wav::header(total_frames, rate));
        for (bytes, _) in &parts {
            whole.extend_from_slice(wav::samples(bytes)?);
        }
        std::fs::write(&joined, &whole)
            .map_err(|error| format!("cannot write the joined audio: {error}"))?;
        drop(whole);

        let converted = std::process::Command::new("/usr/bin/afconvert")
            .args(["-f", "adts", "-d", "aac", "-b", "64000"])
            .arg(&joined)
            .arg(&adts)
            .output()
            .map_err(|error| format!("cannot run afconvert: {error}"))?;
        if !converted.status.success() {
            return Err(format!(
                "afconvert refused the audio: {}",
                String::from_utf8_lossy(&converted.stderr).trim()
            ));
        }

        let encoded = std::fs::read(&adts)
            .map_err(|error| format!("cannot read the encoded audio: {error}"))?;
        let marks: Vec<m4b::Chapter> = chapters
            .iter()
            .zip(&starts)
            .map(|(chapter, start)| m4b::Chapter {
                title: chapter.title.clone(),
                start_ms: *start,
            })
            .collect();
        let meta = m4b::BookMeta { title, author };
        m4b::write(&encoded, &marks, &meta, &target)?;

        let parsed = m4b::parse_aac(&encoded)?;
        Ok(Packaged {
            path: path.clone(),
            duration_ms: parsed.duration_ms(),
            chapters: marks.len(),
        })
    })();

    /* THE SCRATCH FILES GO EITHER WAY. They are the size of the book. */
    let _ = std::fs::remove_file(&joined);
    let _ = std::fs::remove_file(&adts);
    if outcome.is_err() {
        let _ = std::fs::remove_file(&target);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole packaging chain, on real encoded audio: three chapter WAVs in,
    /// one `.m4b` with three chapter marks out.
    ///
    /// ⚠️ **THE CHAPTER AUDIO IS SYNTHESISED, NOT SPOKEN, AND DELIBERATELY SO.**
    /// `afconvert`'s own WAV output puts a `FLLR` chunk where `data` belongs, so
    /// a test that produced its inputs with `say | afconvert` would be refused by
    /// `wav::read` — correctly. What `narrate_render` writes is `wav::header`
    /// plus samples, which is what this builds.
    ///
    /// `#[ignore]`d: it shells out to `afconvert` and writes outside the
    /// repository. Run it, then read the result with BOTH readers, which
    /// disagree in ways that matter:
    ///
    /// ```sh
    /// cargo test -p app --lib narrate::apple::tests::a_packaged_book -- --ignored --nocapture
    /// ffprobe -v error -show_chapters /tmp/paper-m4b/packaged.m4b
    /// ```
    #[test]
    #[ignore = "writes outside the repository and needs macOS's afconvert"]
    fn a_packaged_book_carries_its_chapters() {
        let dir = std::path::Path::new("/tmp/paper-m4b");
        std::fs::create_dir_all(dir).expect("scratch directory");

        /* A quiet tone per chapter, at the rate the speech engine answers. The
         * packaging path cares that the audio is valid PCM of a known length, not
         * what it sounds like. */
        let rate = 22_050u32;
        let mut paths = Vec::new();
        for (index, seconds) in [2u64, 3, 1].iter().enumerate() {
            let frames = seconds * u64::from(rate);
            let mut bytes = wav::header(frames, rate).to_vec();
            for frame in 0..frames {
                let phase = (frame as f32 / rate as f32) * 220.0 * std::f32::consts::TAU;
                bytes.extend_from_slice(&wav::to_i16(phase.sin() * 0.2).to_le_bytes());
            }
            let path = dir.join(format!("chapter-{index}.wav"));
            std::fs::write(&path, &bytes).expect("write a chapter");
            paths.push(path);
        }

        let chapters: Vec<ChapterAudio> = paths
            .iter()
            .zip(["Chapter One", "Chapter Two", "第三章"])
            .map(|(path, title)| ChapterAudio {
                title: title.to_owned(),
                path: path.to_string_lossy().into_owned(),
            })
            .collect();

        let out = dir.join("packaged.m4b");
        let packaged = package(
            chapters,
            "A Measured Book".to_owned(),
            "Paper".to_owned(),
            out.to_string_lossy().into_owned(),
        )
        .expect("packages");

        assert_eq!(packaged.chapters, 3);
        /* SIX SECONDS OF AUDIO, within the frame AAC rounds to. A total that came
         * out near one chapter's length would be the concatenation silently
         * dropping the rest. */
        assert!(
            (5_900..6_200).contains(&packaged.duration_ms),
            "expected about 6000ms, got {}",
            packaged.duration_ms
        );
        assert!(out.is_file(), "no file at {}", out.display());

        /* THE SCRATCH FILES ARE GONE. They are the size of the book, and leaving
         * one behind beside the reader's audiobook is the failure nobody notices
         * until a disk is full. */
        for stray in std::fs::read_dir(dir).expect("list the directory") {
            let name = stray.expect("entry").file_name();
            let name = name.to_string_lossy();
            assert!(
                !name.starts_with(".paper-audiobook-"),
                "a scratch file was left behind: {name}"
            );
        }
        println!(
            "wrote {} ({}ms, 3 chapters)",
            out.display(),
            packaged.duration_ms
        );
    }
}
