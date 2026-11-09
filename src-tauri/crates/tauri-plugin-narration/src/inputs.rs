//! Where an export may read from and write to, resolved once, and checked again
//! at every use.
//!
//! ⚠️ **EVERY PATH THE WEBVIEW NAMES IS CHECKED AGAINST A ROOT THIS PLUGIN
//! RESOLVED ITSELF.** The window can write, remove, rename and make directories
//! anywhere under `$APPDATA` through the fs plugin, and it can call every command
//! here with any argument. What it cannot do is make a symlink — no granted
//! command creates one — so the checks below refuse a link wherever one could
//! carry a read or a write out of the app's own data. A swap that stays inside
//! `$APPDATA` is the recorded residual: scratch audio proves where it is, not
//! who wrote it.

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::limits::{Refused, MAX_INPUT_BYTES};

/// The scratch directory's name under the app's data root. The voices plugin
/// knows it too, because it writes a chapter there — see its
/// `voices_render_file`.
pub const SCRATCH_DIR: &str = "audiobook";

/// The app's data root and the scratch root under it, both canonical.
#[derive(Debug, Clone)]
pub struct Roots {
    data: PathBuf,
    scratch: PathBuf,
}

impl Roots {
    /// Resolve the roots, creating the scratch directory where it is missing.
    ///
    /// ⚠️ **A SCRATCH ROOT THAT IS A LINK IS REFUSED, NOT FOLLOWED.** Every run
    /// directory is made under it and every removal walks it; a link here would
    /// point all of that somewhere the reader never chose.
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|error| format!("cannot make the app's data directory: {error}"))?;
        let data = std::fs::canonicalize(data_dir)
            .map_err(|error| format!("cannot resolve the app's data directory: {error}"))?;
        let scratch = data.join(SCRATCH_DIR);
        match std::fs::symlink_metadata(&scratch) {
            Ok(meta) => real_directory(&scratch, &meta)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&scratch).map_err(|error| {
                    format!("cannot make the audiobook scratch directory: {error}")
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "cannot read the audiobook scratch directory: {error}"
                ))
            }
        }
        let resolved = std::fs::canonicalize(&scratch)
            .map_err(|error| format!("cannot resolve the audiobook scratch directory: {error}"))?;
        if resolved != scratch {
            return Err(format!(
                "the audiobook scratch directory resolves to {} and not to itself",
                resolved.display()
            ));
        }
        Ok(Self { data, scratch })
    }

    pub fn scratch(&self) -> &Path {
        &self.scratch
    }

    /// The voices plugin's clip store, checked now rather than at startup:
    /// the voices plugin creates it, and it may not exist yet.
    fn clips(&self) -> Result<PathBuf, String> {
        let audio = self.data.join("audio");
        let clips = audio.join("clips");
        for dir in [&audio, &clips] {
            let meta = std::fs::symlink_metadata(dir)
                .map_err(|error| format!("cannot read {}: {error}", dir.display()))?;
            real_directory(dir, &meta)?;
        }
        Ok(clips)
    }

    /// A clip the reader has already heard, as a path this plugin rebuilt from
    /// its own root and the clip's file name.
    ///
    /// ⚠️ **THE WEBVIEW'S PATH IS NEVER OPENED AS GIVEN.** It must be absolute,
    /// a `.wav`, and directly inside the clip store once its directory is
    /// resolved; what is returned is the store joined with the bare name, so a
    /// `..` or a link in the given path cannot reach the read.
    pub fn clip(&self, given: &str) -> Result<PathBuf, String> {
        let path = Path::new(given);
        if !path.is_absolute() {
            return Err(format!("{given} is not an absolute path"));
        }
        if path.components().any(|part| part == Component::ParentDir) {
            return Err(format!("{given} climbs out of its directory"));
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("wav") {
            return Err(format!("{given} is not a rendered clip"));
        }
        let name = path
            .file_name()
            .ok_or_else(|| format!("{given} names no file"))?;
        let clips = self.clips()?;
        let parent = path
            .parent()
            .ok_or_else(|| format!("{given} has no directory"))?;
        let resolved = std::fs::canonicalize(parent)
            .map_err(|error| format!("cannot resolve the directory of {given}: {error}"))?;
        if resolved != clips {
            return Err(format!("{given} is not in the voices plugin's clip store"));
        }
        Ok(clips.join(name))
    }
}

/// Refuse anything at `path` that is not a directory, a link to one included.
pub fn real_directory(path: &Path, meta: &std::fs::Metadata) -> Result<(), String> {
    if meta.file_type().is_symlink() {
        return Err(format!(
            "{} is a link, and Paper does not follow one here",
            path.display()
        ));
    }
    if !meta.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    Ok(())
}

/// Why a chapter could not be read.
#[derive(Debug, PartialEq, Eq)]
pub enum Unreadable {
    TooLarge(u64),
    Refused(String),
}

impl Unreadable {
    /// The sentence for chapter `chapter` (counted from one).
    pub fn for_chapter(self, chapter: usize) -> String {
        match self {
            Self::TooLarge(bytes) => Refused::InputTooLarge { chapter, bytes }.to_string(),
            Self::Refused(why) => format!("cannot read chapter {chapter}: {why}"),
        }
    }
}

/// Read a regular file ONCE, refusing a link and anything over `cap` bytes.
///
/// ⚠️ **THE FILE OPENED IS PROVEN TO BE THE FILE INSPECTED.** `std` has no
/// `O_NOFOLLOW` without a `libc` dependency, so the open is followed by a
/// comparison of the open descriptor's device and inode with the `lstat` taken
/// first: a link swapped in between the two is refused. And the bytes are read
/// exactly once — what is measured is what is joined, so a file changed between
/// a measuring read and a copying read cannot put different audio in the book
/// from the audio its chapter marks were placed by.
pub fn read_once(path: &Path, cap: u64) -> Result<Vec<u8>, Unreadable> {
    let seen =
        std::fs::symlink_metadata(path).map_err(|error| Unreadable::Refused(error.to_string()))?;
    if seen.file_type().is_symlink() {
        return Err(Unreadable::Refused(
            "it is a link, and Paper does not follow one here".to_owned(),
        ));
    }
    if !seen.is_file() {
        return Err(Unreadable::Refused("it is not a file".to_owned()));
    }
    if seen.len() > cap {
        return Err(Unreadable::TooLarge(seen.len()));
    }
    let file = File::open(path).map_err(|error| Unreadable::Refused(error.to_string()))?;
    let opened = file
        .metadata()
        .map_err(|error| Unreadable::Refused(error.to_string()))?;
    if !same_file(&seen, &opened) {
        return Err(Unreadable::Refused(
            "it changed while it was being opened".to_owned(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| Unreadable::Refused(error.to_string()))?;
    /* A file that grew after it was measured is held to the same cap. */
    if bytes.len() as u64 > cap {
        return Err(Unreadable::TooLarge(bytes.len() as u64));
    }
    Ok(bytes)
}

/// Read a chapter at the input cap.
pub fn read_chapter(path: &Path) -> Result<Vec<u8>, Unreadable> {
    read_once(path, MAX_INPUT_BYTES)
}

#[cfg(unix)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// Off unix there is no stable identity in `std`. Nothing reaches this: the
/// export is refused off macOS before a chapter is read.
#[cfg(not(unix))]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    a.is_file() && b.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let data = std::fs::canonicalize(dir.path())
            .expect("canon")
            .join("data");
        (dir, data)
    }

    #[test]
    fn opening_makes_the_scratch_root_and_answers_it_canonical() {
        let (_dir, data) = data();
        let roots = Roots::open(&data).expect("roots");
        assert_eq!(roots.scratch(), data.join(SCRATCH_DIR));
        assert!(roots.scratch().is_dir());
        /* AND A SECOND OPEN TAKES THE ONE ALREADY THERE. */
        Roots::open(&data).expect("reopens");
    }

    #[cfg(unix)]
    #[test]
    fn a_scratch_root_that_is_a_link_is_refused() {
        let (dir, data) = data();
        std::fs::create_dir_all(&data).expect("data");
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).expect("elsewhere");
        std::os::unix::fs::symlink(&elsewhere, data.join(SCRATCH_DIR)).expect("plant");
        let error = Roots::open(&data).expect_err("refuses");
        assert!(error.contains("is a link"), "{error}");
    }

    #[test]
    fn a_scratch_root_that_is_a_file_is_refused() {
        let (_dir, data) = data();
        std::fs::create_dir_all(&data).expect("data");
        std::fs::write(data.join(SCRATCH_DIR), b"").expect("plant");
        let error = Roots::open(&data).expect_err("refuses");
        assert!(error.contains("not a directory"), "{error}");
    }

    fn with_clips() -> (tempfile::TempDir, PathBuf, Roots) {
        let (dir, data) = data();
        std::fs::create_dir_all(data.join("audio/clips")).expect("clips");
        let roots = Roots::open(&data).expect("roots");
        (dir, data, roots)
    }

    #[test]
    fn a_clip_in_the_store_is_answered_from_the_store() {
        let (_dir, data, roots) = with_clips();
        let given = data.join("audio/clips/abc.wav");
        assert_eq!(
            roots.clip(given.to_str().expect("utf-8")).expect("clip"),
            given
        );
    }

    #[test]
    fn a_clip_outside_the_store_is_refused() {
        let (_dir, data, roots) = with_clips();
        for given in [
            data.join("audiobook/run-x/chapter-1.wav"),
            data.join("audio/abc.wav"),
            data.join("audio/clips/../abc.wav"),
            data.join("audio/clips/abc.m4b"),
            PathBuf::from("audio/clips/abc.wav"),
        ] {
            assert!(
                roots.clip(given.to_str().expect("utf-8")).is_err(),
                "{} was accepted",
                given.display()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_clip_store_reached_through_a_link_is_refused() {
        for linked in ["audio", "audio/clips"] {
            let (dir, data) = data();
            std::fs::create_dir_all(&data).expect("data");
            let roots = Roots::open(&data).expect("roots");
            let elsewhere = dir.path().join("elsewhere");
            std::fs::create_dir_all(elsewhere.join("clips")).expect("elsewhere");
            if linked == "audio" {
                std::os::unix::fs::symlink(&elsewhere, data.join("audio")).expect("plant");
            } else {
                std::fs::create_dir(data.join("audio")).expect("audio");
                std::os::unix::fs::symlink(elsewhere.join("clips"), data.join("audio/clips"))
                    .expect("plant");
            }
            let given = data.join("audio/clips/abc.wav");
            let error = roots
                .clip(given.to_str().expect("utf-8"))
                .expect_err("refuses");
            assert!(error.contains("is a link"), "{linked}: {error}");
        }
    }

    #[test]
    fn a_file_is_read_whole_up_to_its_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("a.wav");
        std::fs::write(&path, b"12345").expect("write");
        assert_eq!(read_once(&path, 5).expect("read"), b"12345");
        assert_eq!(read_once(&path, 4), Err(Unreadable::TooLarge(5)));
    }

    #[test]
    fn a_directory_is_not_read_as_a_chapter() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(matches!(
            read_once(dir.path(), 5),
            Err(Unreadable::Refused(why)) if why.contains("not a file")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_not_read_through() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real.wav");
        std::fs::write(&real, b"secret").expect("write");
        let link = dir.path().join("link.wav");
        std::os::unix::fs::symlink(&real, &link).expect("plant");
        assert!(matches!(
            read_once(&link, 100),
            Err(Unreadable::Refused(why)) if why.contains("link")
        ));
    }

    #[test]
    fn a_too_large_chapter_names_its_number_and_the_bound() {
        let said = Unreadable::TooLarge(9).for_chapter(3);
        assert!(said.contains("chapter 3"), "{said}");
        assert!(said.contains(&MAX_INPUT_BYTES.to_string()), "{said}");
    }
}
