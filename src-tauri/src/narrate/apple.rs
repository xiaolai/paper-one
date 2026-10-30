//! The Apple half of rendering — `AVSpeechSynthesizer`, its two callbacks, and
//! the one thread they will speak to.
//!
//! Split from `mod.rs` for the reason the module header gives: the arithmetic
//! that placed the markers is where the measured trap lives, and it is worth
//! testing on a machine that has no AVFoundation. What is here can only be
//! exercised by running it.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::wav;
use super::{chapter_starts, m4b, ChapterAudio, Packaged};

/// Only one narration at a time, across both commands.
///
/// ⚠️ **`Live`'s DOC CLAIMED A SECOND RENDER WAS "REFUSED BY NAME" AND NOTHING
/// REFUSED ANYTHING.** A second call replaced the slot, dropping the first
/// render's retained synthesiser mid-flight and leaving its caller to wait out
/// the stall watchdog. Two packages in one directory collided on scratch names
/// besides. The audit found the guarantee in the prose and not in the code,
/// which is the worst place for one to live.
///
/// ONE GATE FOR BOTH COMMANDS, not one per resource: the exporter is sequential
/// and a queue nobody asked for is a queue that hides this contention instead of
/// reporting it.
static BUSY: Mutex<bool> = Mutex::new(false);

/// Holds the gate for as long as it is alive, and releases it however the work
/// ends — including a panic, which is what makes this a guard and not a pair of
/// calls somebody has to remember to balance.
struct Admission;

impl Admission {
    fn take(what: &str) -> Result<Self, String> {
        let mut busy = BUSY
            .lock()
            .map_err(|_| "the narration gate was poisoned".to_owned())?;
        if *busy {
            return Err(format!(
                "Paper is already rendering; wait for it to finish before starting a {what}"
            ));
        }
        *busy = true;
        Ok(Self)
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        if let Ok(mut busy) = BUSY.lock() {
            *busy = false;
        }
    }
}

/// A file written beside its destination and moved into place only once whole.
///
/// ⚠️ **`File::create` ON THE DESTINATION TRUNCATES IT BEFORE ANY WORK HAPPENS.**
/// `render` did that before it had even resolved the voice, so a bad voice
/// identifier emptied whatever was at that path; `package` went further and
/// REMOVED the destination on any failure, including ones that happened before
/// it had written a byte. Either way a reader who exported over an existing
/// audiobook lost it to a failure that had nothing to do with the file.
///
/// `create_new` refuses to follow or overwrite anything already at the scratch
/// name, which also closes the predictable-path symlink the audit found: the
/// old name was the process id alone, so a second call collided and a planted
/// link was followed.
struct Staged {
    path: PathBuf,
    done: bool,
}

impl Staged {
    fn beside(target: &Path, what: &str) -> Result<(Self, File), String> {
        let parent = target
            .parent()
            .ok_or_else(|| format!("{} has no directory to write into", target.display()))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for attempt in 0..8u32 {
            let path = parent.join(format!(
                ".paper-{what}-{}-{stamp}-{attempt}.part",
                std::process::id()
            ));
            match File::options().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok((Self { path, done: false }, file)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("cannot write beside {}: {error}", target.display()))
                }
            }
        }
        Err(format!(
            "cannot find an unused scratch name beside {}",
            target.display()
        ))
    }

    /// Move the finished file onto the destination. A rename within one
    /// directory is atomic, so the destination is either the old file or the
    /// whole new one — never half of either.
    fn commit(mut self, target: &Path) -> Result<(), String> {
        std::fs::rename(&self.path, target)
            .map_err(|error| format!("cannot move the finished file into place: {error}"))?;
        self.done = true;
        Ok(())
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        /* ⚠️ **ONLY EVER THIS FILE.** The destination is never removed: it may
         * be a book the reader already had, and no failure here is a reason to
         * take it from them. */
        if self.done {
            return;
        }
        /* ⚠️ **A FAILED CLEANUP IS SAID OUT LOUD.** This was `let _ = remove_file`,
         * which is how a successful export leaves a scratch file the size of the
         * book behind and reports nothing — the failure nobody notices until a
         * disk is full. A drop cannot return an error, so it logs: the process
         * log is where this belongs, and the export's own result is not the place
         * to report a tidy-up that did not matter to it. */
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "narrate: could not remove the scratch file {}: {error}",
                    self.path.display()
                );
            }
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
    let _admission = Admission::take("package")?;

    let target = PathBuf::from(&path);

    /* ⚠️ **MEASURE EVERY CHAPTER FIRST, WITHOUT KEEPING ANY OF IT.** The first
     * version read all of them into memory and then built a second, whole-book
     * copy beside them: ten hours of 22.05 kHz mono is about 1.6 GB, so the peak
     * passed 3 GB before the encoder had started, and an ordinary export could
     * end the app. Each file is read, measured, and dropped here; the bytes are
     * streamed once, below. */
    let mut facts = Vec::with_capacity(chapters.len());
    for (index, chapter) in chapters.iter().enumerate() {
        let bytes = std::fs::read(&chapter.path)
            .map_err(|error| format!("cannot read chapter {}: {error}", index + 1))?;
        let measured = wav::read(&bytes)
            .map_err(|error| format!("chapter {} ({}): {error}", index + 1, chapter.title))?;
        if measured.frames == 0 {
            /* A silent chapter would share the previous chapter's start, and two
             * marks at one moment cannot both be reached. */
            return Err(format!(
                "chapter {} ({}) has no audio, so it has no place in the book",
                index + 1,
                chapter.title
            ));
        }
        facts.push(measured);
    }

    let starts = chapter_starts(&facts)?;
    let rate = facts[0].sample_rate;
    let total_frames: u64 = facts.iter().map(|f| f.frames).sum();
    /* ⚠️ **A WAV STATES ITS LENGTH IN 32 BITS.** Past about 27 hours at 22.05 kHz
     * the header wraps and `afconvert` is handed a file that describes a
     * fraction of itself. Refused by name rather than silently truncated. */
    wav::check_size(total_frames)?;

    let (staged_audio, joined_file) = Staged::beside(&target, "join")?;
    let mut joined = BufWriter::new(joined_file);
    joined
        .write_all(&wav::header(total_frames, rate))
        .map_err(|error| format!("cannot write the joined audio: {error}"))?;
    for (index, chapter) in chapters.iter().enumerate() {
        let bytes = std::fs::read(&chapter.path)
            .map_err(|error| format!("cannot read chapter {}: {error}", index + 1))?;
        joined
            .write_all(wav::samples(&bytes)?)
            .map_err(|error| format!("cannot write the joined audio: {error}"))?;
        /* Dropped before the next one is read, which is the whole point. */
        drop(bytes);
    }
    joined
        .flush()
        .map_err(|error| format!("cannot flush the joined audio: {error}"))?;
    drop(joined);

    let (staged_adts, _) = Staged::beside(&target, "aac")?;
    let converted = std::process::Command::new("/usr/bin/afconvert")
        .args(["-f", "adts", "-d", "aac", "-b", "64000"])
        .arg(&staged_audio.path)
        .arg(&staged_adts.path)
        .output()
        .map_err(|error| format!("cannot run afconvert: {error}"))?;
    if !converted.status.success() {
        return Err(format!(
            "afconvert refused the audio: {}",
            String::from_utf8_lossy(&converted.stderr).trim()
        ));
    }
    drop(staged_audio);

    let encoded = std::fs::read(&staged_adts.path)
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

    /* STAGED, so a failure here cannot destroy a book already at the
     * destination — and the duration comes back from the writer rather than
     * from a second parse of the same bytes. */
    let (staged_book, _) = Staged::beside(&target, "book")?;
    let duration_ms = m4b::write(&encoded, &marks, &meta, &staged_book.path)?;
    drop(encoded);
    drop(staged_adts);
    staged_book.commit(&target)?;

    Ok(Packaged {
        path,
        duration_ms,
        chapters: marks.len(),
    })
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
        /* ⚠️ **THIS ASSERTED ON A PREFIX THAT NO LONGER EXISTS, SO IT COULD NEVER
         * FAIL.** The scratch name was `.paper-audiobook-` when this was written;
         * `Staged` renamed them to `.paper-join-`, `.paper-aac-` and
         * `.paper-book-` and the assertion was left pointing at the old one — a
         * check given a correct subject and asked a question that cannot come
         * back wrong. Found by the third verification pass. It matches the one
         * thing every scratch name has in common now, and asserts that at least
         * one such name is REACHABLE so a future rename cannot make it vacuous
         * again. */
        let strays: Vec<String> = std::fs::read_dir(dir)
            .expect("list the directory")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with(".paper-"))
            .collect();
        assert!(
            strays.is_empty(),
            "scratch files were left behind: {strays:?}"
        );
        assert!(
            Staged::beside(&out, "probe")
                .map(|(staged, _)| staged
                    .path
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with(".paper-")))
                .ok()
                .flatten()
                .unwrap_or(false),
            "the scratch prefix this test looks for is not the one Staged writes"
        );
        println!(
            "wrote {} ({}ms, 3 chapters)",
            out.display(),
            packaged.duration_ms
        );
    }
}
