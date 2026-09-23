//! Where a downloaded pack lives.
//!
//! ```text
//! <data root>/
//!   voices/
//!     packs/      the files a reader downloaded, one directory per pack
//!     staging/    partial downloads, promoted only after verification
//! ```
//!
//! `staging/` is a SIBLING of `packs/`, not a subdirectory of it, and that is
//! what makes "a stopped download leaves no half-installed pack" true by
//! construction rather than by a cleanup pass: bytes land in staging, the digest
//! is checked there, and only a verified file is renamed across. The rename is
//! the atomic primitive the whole design leans on, and `rename(2)` across
//! filesystems is a copy — which would put the window back — so the two
//! directories stay under one root.
//!
//! The root is asked of `paper-data-root` rather than recomputed, for the reason
//! that crate's header gives: a debug build may be pointed at
//! `PAPER_TEST_DATA_DIR`, and two answers to "where is the data root" is one
//! answer too many.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// The subdirectory this crate owns under the data root.
pub const VOICES_DIR: &str = "voices";

/// The directories, RESOLVED — not created. [`Layout::ensure`] is the half that
/// touches the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// `<data root>/voices`
    pub base: PathBuf,
    /// The packs a reader has downloaded.
    pub packs_dir: PathBuf,
    /// Partial downloads, promoted only after verification.
    pub staging_dir: PathBuf,
}

impl Layout {
    /// The layout under `root`, pure — no directory is created.
    #[must_use]
    pub fn under(root: &Path) -> Self {
        let base = root.join(VOICES_DIR);
        Self {
            packs_dir: base.join("packs"),
            staging_dir: base.join("staging"),
            base,
        }
    }

    /// Create every directory. Idempotent.
    ///
    /// # Errors
    /// Returns the underlying I/O failure.
    pub fn ensure(&self) -> Result<()> {
        std::fs::create_dir_all(&self.base)?;
        std::fs::create_dir_all(&self.packs_dir)?;
        std::fs::create_dir_all(&self.staging_dir)?;
        Ok(())
    }

    /// Where a pack's file lives once it has been verified.
    ///
    /// # Errors
    /// [`Error::BadPath`] if the id or the relative path is not one Paper may
    /// write. The manifest is Paper's own file and is validated on load — but it
    /// is still checked here, because a check that lives only at the boundary is
    /// a check the next caller can walk around.
    pub fn pack_path(&self, id: &str, relative: &str) -> Result<PathBuf> {
        Ok(self
            .packs_dir
            .join(safe_component(id)?)
            .join(safe_relative(relative)?))
    }

    /// Where a pack's bytes land while they are still arriving.
    ///
    /// NESTED under the pack's id rather than joined into one name: `("a-b",
    /// "c")` and `("a", "b-c")` flattened to the same `a-b-c`, so two packs'
    /// downloads could resume onto each other's partial bytes.
    ///
    /// # Errors
    /// As [`Layout::pack_path`].
    pub fn staging_path(&self, id: &str, relative: &str) -> Result<PathBuf> {
        Ok(self
            .staging_dir
            .join(safe_component(id)?)
            .join(safe_relative(relative)?))
    }

    /// Everything of one pack, for removing it.
    ///
    /// # Errors
    /// [`Error::BadPath`] if the id is not a name Paper may write.
    pub fn pack_dir(&self, id: &str) -> Result<PathBuf> {
        Ok(self.packs_dir.join(safe_component(id)?))
    }

    /// The staging directory of one pack, for removing what a stopped download
    /// left behind.
    ///
    /// # Errors
    /// [`Error::BadPath`] if the id is not a name Paper may write.
    pub fn staging_dir_for(&self, id: &str) -> Result<PathBuf> {
        Ok(self.staging_dir.join(safe_component(id)?))
    }
}

/// A single path component from a closed alphabet: `[A-Za-z0-9._-]`, non-empty,
/// bounded, and never `.` or `..`. A name, not a path, so there is nothing to
/// traverse with.
///
/// # Errors
/// [`Error::BadPath`] naming the component.
pub fn safe_component(name: &str) -> Result<&str> {
    let ok = !name.is_empty()
        && name.len() <= 120
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if ok {
        Ok(name)
    } else {
        Err(Error::BadPath(name.to_owned()))
    }
}

/// A relative path of safe components — a pack keeps its own shape
/// (`voices/af_heart.bin`, `speech_tokenizer/model.safetensors`), so this is
/// several components rather than one, each held to the same alphabet.
///
/// # Errors
/// [`Error::BadPath`] naming the whole path, since that is what the manifest
/// declared and what a reader would have to find.
pub fn safe_relative(relative: &str) -> Result<PathBuf> {
    if relative.is_empty() || relative.len() > 240 {
        return Err(Error::BadPath(relative.to_owned()));
    }
    let mut out = PathBuf::new();
    for part in relative.split('/') {
        safe_component(part).map_err(|_| Error::BadPath(relative.to_owned()))?;
        out.push(part);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_packs_live_under_the_voices_directory() {
        let layout = Layout::under(Path::new("/data/Paper"));
        assert_eq!(layout.base, PathBuf::from("/data/Paper/voices"));
        assert_eq!(layout.packs_dir, PathBuf::from("/data/Paper/voices/packs"));
    }

    #[test]
    fn staging_is_outside_the_pack_directory() {
        let layout = Layout::under(Path::new("/data/Paper"));
        assert!(
            !layout.staging_dir.starts_with(&layout.packs_dir),
            "a half-written file under packs/ would be a half-installed pack"
        );
    }

    #[test]
    fn ensure_creates_every_directory_and_is_idempotent() {
        let tmp = tempdir();
        let layout = Layout::under(&tmp);
        layout.ensure().expect("first");
        layout.ensure().expect("again");
        assert!(layout.base.is_dir() && layout.packs_dir.is_dir() && layout.staging_dir.is_dir());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_pack_id_cannot_traverse() {
        let layout = Layout::under(Path::new("/data/Paper"));
        for bad in ["..", ".", "", "a/b", "../../etc/passwd", "a\\b", "a b"] {
            assert!(
                layout.pack_path(bad, "model.onnx").is_err(),
                "{bad:?} should be refused"
            );
        }
        assert!(layout.pack_path("english-kokoro", "model.onnx").is_ok());
    }

    #[test]
    fn a_nested_file_is_allowed_and_a_traversing_one_is_not() {
        let layout = Layout::under(Path::new("/data/Paper"));
        assert_eq!(
            layout
                .pack_path("english-kokoro", "voices/af_heart.bin")
                .expect("nested"),
            PathBuf::from("/data/Paper/voices/packs/english-kokoro/voices/af_heart.bin")
        );
        for bad in ["../x", "a//b", "voices/../../x", "/etc/passwd", "a\\b", ""] {
            assert!(
                layout.pack_path("english-kokoro", bad).is_err(),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn a_refused_path_names_what_was_asked_for() {
        let layout = Layout::under(Path::new("/data/Paper"));
        let err = layout
            .pack_path("english-kokoro", "voices/../../x")
            .expect_err("refused");
        assert!(
            matches!(&err, Error::BadPath(p) if p == "voices/../../x"),
            "the whole path is what a reader would have to find, not one component: {err}"
        );
    }

    /// A scratch directory of this test's own; `std::env::temp_dir` plus the
    /// process id and a counter, so two tests never share one.
    fn tempdir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "paper-voices-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }
}
