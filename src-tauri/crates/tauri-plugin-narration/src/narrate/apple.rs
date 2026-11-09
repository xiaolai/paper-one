//! The join, the encoder and the container, in the order a package runs them.
//!
//! Only `encode` is Apple's: it shells out to `/usr/bin/afconvert`, which is on
//! every Mac and nowhere else. Everything before and after it is portable, and
//! is tested on every platform.

use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;

use super::wav;
use super::{chapter_starts, m4b};
use crate::staged::Staged;

/// Only one package at a time.
///
/// ⚠️ **`Live`'s DOC CLAIMED A SECOND RENDER WAS "REFUSED BY NAME" AND NOTHING
/// REFUSED ANYTHING.** The audit found the guarantee in the prose and not in the
/// code, which is the worst place for one to live. A queue nobody asked for is a
/// queue that hides contention instead of reporting it.
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
                "Paper is already packaging a book; wait for it to finish before starting a {what}"
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

/// A packaged book, staged beside its destination and not yet moved onto it —
/// the move belongs to the destination's token. See `crate::destination`.
#[derive(Debug)]
pub struct Book {
    pub staged: Staged,
    pub duration_ms: u64,
    pub chapters: usize,
}

/// Lay every chapter's samples end to end in `out`, reading each chapter ONCE.
///
/// ⚠️ **WHAT IS MEASURED IS WHAT IS JOINED.** This used to read every chapter
/// twice — once to measure, once to copy — so a file changed between the two
/// reads put audio in the book that its chapter marks had not been placed by.
/// Now each chapter's bytes are read, measured, copied and dropped in one step,
/// and the header, which needs the total, is written last over a placeholder.
/// The peak stays one chapter, not one book: ten hours of 22.05 kHz mono is
/// about 1.6 GB, and holding all of it ended the app once.
pub fn join<W: Write + Seek>(
    titles: &[String],
    mut read: impl FnMut(usize) -> Result<Vec<u8>, String>,
    out: &mut W,
) -> Result<Vec<wav::Facts>, String> {
    let wrote = |error: std::io::Error| format!("cannot write the joined audio: {error}");
    let mut writer = BufWriter::new(out);
    writer.write_all(&[0u8; wav::HEADER_BYTES]).map_err(wrote)?;
    let mut facts = Vec::with_capacity(titles.len());
    let mut total = 0u64;
    for (index, title) in titles.iter().enumerate() {
        let bytes = read(index)?;
        let measured = wav::read(&bytes)
            .map_err(|error| format!("chapter {} ({title}): {error}", index + 1))?;
        if measured.frames == 0 {
            /* A silent chapter would share the previous chapter's start, and two
             * marks at one moment cannot both be reached. */
            return Err(format!(
                "chapter {} ({title}) has no audio, so it has no place in the book",
                index + 1
            ));
        }
        total += measured.frames;
        /* ⚠️ **A WAV STATES ITS LENGTH IN 32 BITS.** Past about 27 hours at
         * 22.05 kHz the header wraps and `afconvert` is handed a file that
         * describes a fraction of itself. Refused by name, and as soon as the
         * running total passes it rather than after reading the rest. */
        wav::check_size(total)?;
        writer.write_all(wav::samples(&bytes)?).map_err(wrote)?;
        facts.push(measured);
    }
    let rate = facts
        .first()
        .map(|first| first.sample_rate)
        .ok_or_else(|| "there are no chapters to package".to_owned())?;
    writer.flush().map_err(wrote)?;
    let out = writer
        .into_inner()
        .map_err(|error| format!("cannot write the joined audio: {}", error.error()))?;
    out.seek(SeekFrom::Start(0)).map_err(wrote)?;
    out.write_all(&wav::header(total, rate)).map_err(wrote)?;
    out.flush().map_err(wrote)?;
    Ok(facts)
}

/// Encode a joined WAV to ADTS AAC with the system's own encoder.
#[cfg(target_os = "macos")]
fn encode(joined: &Path, aac: &Path) -> Result<(), String> {
    let converted = std::process::Command::new("/usr/bin/afconvert")
        .args(["-f", "adts", "-d", "aac", "-b", "64000"])
        .arg(joined)
        .arg(aac)
        .output()
        .map_err(|error| format!("cannot run afconvert: {error}"))?;
    if !converted.status.success() {
        return Err(format!(
            "afconvert refused the audio: {}",
            String::from_utf8_lossy(&converted.stderr).trim()
        ));
    }
    Ok(())
}

/// Refused off macOS: there is no encoder to run. The command refuses before
/// reaching here; this is the floor beneath it.
#[cfg(not(target_os = "macos"))]
fn encode(_joined: &Path, _aac: &Path) -> Result<(), String> {
    Err(super::UNSUPPORTED.to_owned())
}

/// Join, encode and mux a book, leaving it staged beside `target`.
///
/// The join and the encoded audio are written into `scratch`, the export's own
/// directory under the app's data; only the finished book is written beside the
/// destination, because only a rename within one directory is atomic.
pub fn package(
    titles: &[String],
    read: impl FnMut(usize) -> Result<Vec<u8>, String>,
    meta: m4b::BookMeta,
    scratch: &Path,
    target: &Path,
) -> Result<Book, String> {
    if titles.is_empty() {
        return Err("there are no chapters to package".to_owned());
    }
    let _admission = Admission::take("package")?;
    let inside = scratch.join("book");

    let (staged_audio, mut joined) = Staged::beside(&inside, "join")?;
    let facts = join(titles, read, &mut joined)?;
    drop(joined);
    let starts = chapter_starts(&facts)?;

    let (staged_adts, _) = Staged::beside(&inside, "aac")?;
    encode(staged_audio.path(), staged_adts.path())?;
    drop(staged_audio);

    let encoded = std::fs::read(staged_adts.path())
        .map_err(|error| format!("cannot read the encoded audio: {error}"))?;
    drop(staged_adts);
    let marks: Vec<m4b::Chapter> = titles
        .iter()
        .zip(&starts)
        .map(|(title, start)| m4b::Chapter {
            title: title.clone(),
            start_ms: *start,
        })
        .collect();
    let aac = m4b::parse_aac(&encoded)?;
    let file = m4b::build(&encoded, &aac, &marks, &meta)?;
    drop(encoded);

    /* STAGED, so a failure here cannot destroy a book already at the
     * destination — and the duration comes from the parse the container was
     * built from rather than from a second one. */
    let (staged, mut book) = Staged::beside(target, "book")?;
    book.write_all(&file)
        .and_then(|()| book.sync_all())
        .map_err(|error| format!("cannot write the book: {error}"))?;
    Ok(Book {
        staged,
        duration_ms: aac.duration_ms(),
        chapters: marks.len(),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;

    /// A tone of `frames` frames at `rate`, as the engines write it.
    pub(crate) fn tone(frames: u64, rate: u32) -> Vec<u8> {
        let mut bytes = wav::header(frames, rate).to_vec();
        for frame in 0..frames {
            let phase = (frame as f32 / rate as f32) * 220.0 * std::f32::consts::TAU;
            bytes.extend_from_slice(&wav::to_i16(phase.sin() * 0.2).to_le_bytes());
        }
        bytes
    }

    fn titles(count: usize) -> Vec<String> {
        (1..=count).map(|n| format!("Chapter {n}")).collect()
    }

    #[test]
    fn the_join_is_one_wav_of_every_chapter_in_order() {
        let chapters = [tone(100, 22_050), tone(50, 22_050)];
        let mut out = Cursor::new(Vec::new());
        let facts = join(&titles(2), |i| Ok(chapters[i].clone()), &mut out).expect("join");
        assert_eq!(
            facts.iter().map(|f| f.frames).collect::<Vec<_>>(),
            [100, 50]
        );
        let joined = out.into_inner();
        let read = wav::read(&joined).expect("the join is a WAV this module reads");
        assert_eq!(read.frames, 150);
        assert_eq!(read.sample_rate, 22_050);
        let mut expected = wav::samples(&chapters[0]).expect("a").to_vec();
        expected.extend_from_slice(wav::samples(&chapters[1]).expect("b"));
        assert_eq!(wav::samples(&joined).expect("joined"), expected);
    }

    #[test]
    fn each_chapter_is_read_exactly_once_and_its_measure_is_its_audio() {
        /* A READER THAT ANSWERS DIFFERENTLY THE SECOND TIME, which is what a file
         * changed between a measuring read and a copying read looks like. The old
         * package read every chapter twice; if this one did, the second answer —
         * 900 frames — would be the audio, and the marks would be placed by 10. */
        let mut calls = vec![0usize; 2];
        let mut out = Cursor::new(Vec::new());
        let facts = join(
            &titles(2),
            |i| {
                calls[i] += 1;
                Ok(if calls[i] == 1 {
                    tone(10, 22_050)
                } else {
                    tone(900, 22_050)
                })
            },
            &mut out,
        )
        .expect("join");
        assert_eq!(calls, [1, 1]);
        assert_eq!(facts.iter().map(|f| f.frames).sum::<u64>(), 20);
        assert_eq!(wav::read(&out.into_inner()).expect("read").frames, 20);
    }

    #[test]
    fn a_silent_chapter_is_refused_by_number_and_title() {
        let mut out = Cursor::new(Vec::new());
        let error =
            join(&titles(2), |i| Ok(tone(10 * i as u64, 22_050)), &mut out).expect_err("refuses");
        assert!(
            error.contains("chapter 1 (Chapter 1) has no audio"),
            "{error}"
        );
    }

    #[test]
    fn a_chapter_that_is_not_a_wav_is_refused_by_number_and_title() {
        let mut out = Cursor::new(Vec::new());
        let error = join(&titles(1), |_| Ok(b"not audio".to_vec()), &mut out).expect_err("refuses");
        assert!(error.starts_with("chapter 1 (Chapter 1):"), "{error}");
    }

    #[test]
    fn a_read_that_fails_stops_the_join_with_its_own_sentence() {
        let mut out = Cursor::new(Vec::new());
        let error = join(
            &titles(3),
            |i| {
                if i == 1 {
                    Err("cannot read chapter 2: gone".to_owned())
                } else {
                    Ok(tone(10, 22_050))
                }
            },
            &mut out,
        )
        .expect_err("refuses");
        assert_eq!(error, "cannot read chapter 2: gone");
    }

    #[test]
    fn a_book_of_no_chapters_is_refused_before_anything_is_written() {
        let dir = tempfile::tempdir().expect("tempdir");
        let error = package(
            &[],
            |_| Ok(Vec::new()),
            m4b::BookMeta::default(),
            dir.path(),
            &dir.path().join("Book.m4b"),
        )
        .expect_err("refuses");
        assert!(error.contains("no chapters"), "{error}");
        assert_eq!(std::fs::read_dir(dir.path()).expect("list").count(), 0);
    }

    /// The whole packaging chain, on real encoded audio: three chapter WAVs in,
    /// one `.m4b` with three chapter marks out. The plugin's own path — token,
    /// run, clip store — is `commands::tests::a_real_m4b_through_the_plugin`.
    ///
    /// `#[ignore]`d: it shells out to `afconvert`.
    ///
    /// ```sh
    /// cargo test -p tauri-plugin-narration --lib narrate::apple -- --ignored --nocapture
    /// ```
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "needs macOS's afconvert"]
    fn a_packaged_book_carries_its_chapters() {
        let dir = tempfile::tempdir().expect("tempdir");
        let rate = 22_050u32;
        let chapters: Vec<Vec<u8>> = [2u64, 3, 1]
            .iter()
            .map(|seconds| tone(seconds * u64::from(rate), rate))
            .collect();
        let names: Vec<String> = ["Chapter One", "Chapter Two", "第三章"]
            .iter()
            .map(|t| (*t).to_owned())
            .collect();
        let out = dir.path().join("packaged.m4b");
        let book = package(
            &names,
            |i| Ok(chapters[i].clone()),
            m4b::BookMeta {
                title: "A Measured Book".to_owned(),
                author: "Paper".to_owned(),
            },
            dir.path(),
            &out,
        )
        .expect("packages");
        assert_eq!(book.chapters, 3);
        /* SIX SECONDS OF AUDIO, within the frame AAC rounds to. A total near one
         * chapter's length would be the concatenation silently dropping the rest. */
        assert!(
            (5_900..6_200).contains(&book.duration_ms),
            "expected about 6000ms, got {}",
            book.duration_ms
        );
        book.staged.commit(&out).expect("commit");
        assert!(out.is_file());
        /* THE SCRATCH FILES ARE GONE, and the prefix looked for is the one
         * `Staged` writes — asserted, so a rename cannot make this vacuous. */
        assert!(Staged::name("x", 0, 0).starts_with(".paper-"));
        let strays: Vec<String> = std::fs::read_dir(dir.path())
            .expect("list")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".paper-"))
            .collect();
        assert!(
            strays.is_empty(),
            "scratch files were left behind: {strays:?}"
        );
    }
}
