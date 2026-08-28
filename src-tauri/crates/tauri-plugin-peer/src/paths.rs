//! Where a blob may be read from or written to: `<root>/books/<folder>/<name>`
//! and nowhere else.
//!
//! The plugin serves and fetches book bytes and covers on behalf of a peer.
//! Both halves of the target are validated against closed grammars before a
//! path is ever built — a folder is `^[A-Za-z0-9_]{1,80}$` (the kernel's
//! bookId alphabet) and a name is one of a fixed list — so escape by name is
//! impossible by construction, and [`BlobTarget::checked`] adds the symlink
//! check on top for the day something inside `books/` points elsewhere.
//!
//! `cover.webp` is the legacy cover name: served so an old shelf can still
//! hand its jackets over, never written, so nothing new is created under it.

use std::path::{Path, PathBuf};

use crate::data_root::checked_target;
use crate::error::{Error, Result};

/// The content extensions the kernel's `formats.ts` knows, plus `bin` for a
/// book whose format could not be sniffed.
pub const CONTENT_EXTENSIONS: &[&str] =
    &["epub", "pdf", "mobi", "azw3", "cbz", "fb2", "fbz", "bin"];

/// The subdirectory of the data root that holds one folder per book.
pub const BOOKS_DIR: &str = "books";

/// Read or write. `cover.webp` is refused for `Write`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// A validated blob target. Construct one through [`BlobTarget::resolve`];
/// the fields are read-only afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobTarget {
    folder: String,
    name: String,
    /// `<root>/books/<folder>` — the directory a transfer must find still
    /// there before promoting a `.part`.
    folder_dir: PathBuf,
    /// `<root>/books/<folder>/<name>`.
    path: PathBuf,
}

impl BlobTarget {
    /// Validate `folder` and `name` and build the target under `root`. Pure:
    /// touches no filesystem.
    pub fn resolve(root: &Path, folder: &str, name: &str, access: Access) -> Result<Self> {
        validate_folder(folder)?;
        validate_name(name, access)?;
        let folder_dir = root.join(BOOKS_DIR).join(folder);
        let path = folder_dir.join(name);
        Ok(Self {
            folder: folder.to_owned(),
            name: name.to_owned(),
            folder_dir,
            path,
        })
    }

    /// The target a `.part` belongs to — `content.epub.part` is
    /// `content.epub`'s — validated exactly as [`resolve`](Self::resolve)
    /// with [`Access::Write`] validates that name, because a `.part` is only
    /// ever something a fetch wrote.
    ///
    /// This is how the launch sweep addresses one. [`validate_name`] refuses
    /// `.part` as a NAME and goes on refusing it: no command can serve,
    /// fetch, hash or delete a `.part` by naming it. What this adds is
    /// narrower — the sibling of a name the plugin writes — so the sweep can
    /// collect what a fetch abandoned and nothing else: not `notes.txt.part`,
    /// not `cover.webp.part` (never written, so never ours), not a bare
    /// `.part`.
    pub fn of_part(root: &Path, folder: &str, part_name: &str) -> Result<Self> {
        let Some(name) = part_name
            .strip_suffix(".part")
            .filter(|name| !name.is_empty())
        else {
            return Err(Error::InvalidBlobName(part_name.to_owned()));
        };
        Self::resolve(root, folder, name, Access::Write)
    }

    pub fn folder(&self) -> &str {
        &self.folder
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn folder_dir(&self) -> &Path {
        &self.folder_dir
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The `.part` sibling a fetch writes into before the rename.
    pub fn part_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push(".part");
        PathBuf::from(name)
    }

    /// The symlink check: the folder directory, canonicalized, must still be
    /// under the canonicalized root. Requires the folder to exist — a target
    /// whose folder is missing is [`Error::FolderGone`], which is the answer
    /// both a serve (nothing to serve) and a fetch (nothing to write into)
    /// need.
    ///
    /// This covers the *folder*. The final component (the content file or its
    /// `.part`) is checked by [`checked_read`](Self::checked_read) and
    /// [`checked_part`](Self::checked_part), and the actual opens use
    /// `O_NOFOLLOW` so a symlink planted between check and open still fails.
    pub fn checked(&self, root: &Path) -> Result<()> {
        /* Fallible on purpose: `is_dir()` folded every metadata failure —
         * permission denied, I/O error — into "gone", and GONE has a benign
         * meaning here that a failing disk does not deserve. */
        match std::fs::metadata(&self.folder_dir) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(Error::FolderGone(self.folder.clone())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(Error::FolderGone(self.folder.clone()));
            }
            Err(err) => return Err(err.into()),
        }
        checked_target(root, &self.folder_dir).map(|_| ())
    }

    /// [`checked`](Self::checked), plus: the content file, if it exists, must
    /// be a real file and not a final-component symlink out of the folder.
    /// The serve side reads through this name.
    pub fn checked_read(&self, root: &Path) -> Result<()> {
        self.checked(root)?;
        refuse_symlink(&self.path, root)?;
        /* "A real file" means exactly that: a directory, FIFO, socket or
         * device under the content name would hang or garble the serve —
         * hashing a FIFO blocks forever — and the promise above said file.
         * Absent stays fine; absence has its own meaning to both callers. */
        match std::fs::symlink_metadata(&self.path) {
            Ok(meta) if meta.is_file() => Ok(()),
            Ok(_) => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{} is not a regular file", self.path.display()),
            )
            .into()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// [`checked`](Self::checked), plus: neither the `.part` a fetch appends
    /// into nor the content file the `.part` is renamed onto may be a
    /// final-component symlink. Re-run immediately before the rename to close
    /// the check→rename race.
    pub fn checked_part(&self, root: &Path) -> Result<()> {
        self.checked(root)?;
        refuse_symlink(&self.part_path(), root)?;
        refuse_symlink(&self.path, root)
    }
}

/// A final-component symlink is refused as outside the containment boundary. A
/// missing path (nothing planted) or a plain file passes. This is `lstat`
/// (`symlink_metadata`) so it inspects the link itself, never its target.
fn refuse_symlink(path: &Path, root: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(Error::PathOutsideDataRoot {
            path: path.to_path_buf(),
            root: root.to_path_buf(),
        }),
        Ok(_) => Ok(()),
        /* ONLY absence passes: a permission or I/O failure answered "safe"
         * would let a containment check fail open. */
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// `^[A-Za-z0-9_]{1,80}$`.
pub fn validate_folder(folder: &str) -> Result<()> {
    let ok = !folder.is_empty()
        && folder.len() <= 80
        && folder
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidFolder(folder.to_owned()))
    }
}

/// One of `content.<ext>` (ext in [`CONTENT_EXTENSIONS`]), `cover.jpg`, or —
/// for reads only — `cover.webp`.
pub fn validate_name(name: &str, access: Access) -> Result<()> {
    if name == "cover.jpg" {
        return Ok(());
    }
    if name == "cover.webp" {
        return match access {
            Access::Read => Ok(()),
            Access::Write => Err(Error::ReadOnlyBlobName(name.to_owned())),
        };
    }
    if let Some(ext) = name.strip_prefix("content.") {
        if CONTENT_EXTENSIONS.contains(&ext) {
            return Ok(());
        }
    }
    Err(Error::InvalidBlobName(name.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\paper\data")
        } else {
            PathBuf::from("/paper/data")
        }
    }

    fn kind(result: Result<BlobTarget>) -> &'static str {
        match result {
            Ok(_) => "ok",
            Err(err) => err.kind(),
        }
    }

    #[test]
    fn accepts_a_plain_folder_and_content_name() {
        let target = BlobTarget::resolve(&root(), "book_a", "content.epub", Access::Write).unwrap();
        assert_eq!(
            target.path(),
            root().join("books").join("book_a").join("content.epub")
        );
        assert_eq!(target.folder_dir(), root().join("books").join("book_a"));
        assert_eq!(
            target.part_path(),
            root()
                .join("books")
                .join("book_a")
                .join("content.epub.part")
        );
        assert_eq!(target.folder(), "book_a");
        assert_eq!(target.name(), "content.epub");
    }

    #[test]
    fn every_content_extension_is_accepted() {
        for ext in CONTENT_EXTENSIONS {
            let name = format!("content.{ext}");
            assert_eq!(
                kind(BlobTarget::resolve(&root(), "b", &name, Access::Write)),
                "ok",
                "{name}"
            );
        }
    }

    #[test]
    fn rejects_dot_dot_and_separators_in_the_folder() {
        for bad in [
            "..",
            "../x",
            "a/b",
            "a\\b",
            "book:a",
            "book a",
            "book.a",
            "",
            "book\u{2028}a",
            "book\u{ff0f}a",
            "book\0a",
            "café",
        ] {
            assert_eq!(
                kind(BlobTarget::resolve(
                    &root(),
                    bad,
                    "content.epub",
                    Access::Read
                )),
                "invalidFolder",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn folder_length_is_capped_at_80() {
        let ok = "a".repeat(80);
        let long = "a".repeat(81);
        assert_eq!(
            kind(BlobTarget::resolve(&root(), &ok, "cover.jpg", Access::Read)),
            "ok"
        );
        assert_eq!(
            kind(BlobTarget::resolve(
                &root(),
                &long,
                "cover.jpg",
                Access::Read
            )),
            "invalidFolder"
        );
    }

    #[test]
    fn rejects_names_outside_the_closed_set() {
        for bad in [
            "content.exe",
            "content",
            "content.",
            "content.epub.part",
            "book.json",
            "marks.json",
            "../content.epub",
            "content.EPUB",
            "cover.png",
            "content.epub\0",
            "",
        ] {
            assert_eq!(
                kind(BlobTarget::resolve(&root(), "b", bad, Access::Read)),
                "invalidBlobName",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn of_part_names_the_target_a_part_belongs_to() {
        // The launch sweep addresses a `.part` ONLY as the sibling of a target
        // the fetch path could have written: `content.epub.part` is
        // `content.epub`'s, and the target it builds is the one `resolve`
        // would build for that name.
        let target = BlobTarget::of_part(&root(), "book_a", "content.epub.part").unwrap();
        assert_eq!(
            target,
            BlobTarget::resolve(&root(), "book_a", "content.epub", Access::Write).unwrap()
        );
        assert_eq!(
            target.part_path(),
            root()
                .join("books")
                .join("book_a")
                .join("content.epub.part")
        );
        assert_eq!(
            BlobTarget::of_part(&root(), "b", "cover.jpg.part")
                .unwrap()
                .name(),
            "cover.jpg"
        );
    }

    #[test]
    fn of_part_refuses_everything_that_is_not_a_written_names_part() {
        // Not a `.part` at all, a `.part` of a name outside the closed set, a
        // `.part` of the read-only legacy cover (never written, so never ours
        // to collect), the bare suffix, and a folder outside the grammar —
        // each refused, so the sweep can only ever remove what a fetch left.
        for (folder, name, expected) in [
            ("b", "content.epub", "invalidBlobName"),
            ("b", "notes.txt.part", "invalidBlobName"),
            ("b", "book.json.part", "invalidBlobName"),
            ("b", "content.exe.part", "invalidBlobName"),
            ("b", "cover.webp.part", "readOnlyBlobName"),
            ("b", ".part", "invalidBlobName"),
            ("b", "content.epub.part.part", "invalidBlobName"),
            ("b", "", "invalidBlobName"),
            ("../b", "content.epub.part", "invalidFolder"),
        ] {
            assert_eq!(
                kind(BlobTarget::of_part(&root(), folder, name)),
                expected,
                "{folder:?}/{name:?}"
            );
        }
    }

    #[test]
    fn legacy_webp_cover_is_read_only() {
        assert_eq!(
            kind(BlobTarget::resolve(
                &root(),
                "b",
                "cover.webp",
                Access::Read
            )),
            "ok"
        );
        assert_eq!(
            kind(BlobTarget::resolve(
                &root(),
                "b",
                "cover.webp",
                Access::Write
            )),
            "readOnlyBlobName"
        );
        assert_eq!(
            kind(BlobTarget::resolve(
                &root(),
                "b",
                "cover.jpg",
                Access::Write
            )),
            "ok"
        );
    }

    #[test]
    fn checked_needs_the_folder_to_exist() {
        let dir = ScratchDir::new("paths-missing");
        let target = BlobTarget::resolve(dir.path(), "b", "content.epub", Access::Write).unwrap();
        assert_eq!(target.checked(dir.path()).unwrap_err().kind(), "folderGone");
        std::fs::create_dir_all(target.folder_dir()).unwrap();
        target.checked(dir.path()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn checked_refuses_a_folder_that_is_a_symlink_out_of_the_root() {
        let dir = ScratchDir::new("paths-symlink");
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(root.join("books")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("books").join("escape")).unwrap();
        let target = BlobTarget::resolve(&root, "escape", "content.epub", Access::Write).unwrap();
        assert_eq!(
            target.checked(&root).unwrap_err().kind(),
            "pathOutsideDataRoot"
        );
    }

    #[cfg(unix)]
    #[test]
    fn checked_read_refuses_a_final_component_symlink() {
        // The folder is real, but `content.epub` inside it is a symlink to a
        // file outside the root. `checked` (folder only) passes; the closed
        // name and folder grammar pass; only the final-component check catches
        // it.
        let dir = ScratchDir::new("paths-final-symlink");
        let root = dir.path().join("root");
        let folder = root.join("books").join("bk1");
        let secret = dir.path().join("outside.txt");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&secret, b"not yours").unwrap();
        std::os::unix::fs::symlink(&secret, folder.join("content.epub")).unwrap();
        let target = BlobTarget::resolve(&root, "bk1", "content.epub", Access::Read).unwrap();
        assert!(target.checked(&root).is_ok(), "folder alone is fine");
        assert_eq!(
            target.checked_read(&root).unwrap_err().kind(),
            "pathOutsideDataRoot"
        );
    }

    #[cfg(unix)]
    #[test]
    fn checked_part_refuses_a_symlinked_part_and_rename_target() {
        let dir = ScratchDir::new("paths-part-symlink");
        let root = dir.path().join("root");
        let folder = root.join("books").join("bk1");
        let secret = dir.path().join("outside.bin");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&secret, b"victim").unwrap();
        // `.part` is a symlink out of the root — a fetch would append peer
        // bytes through it.
        std::os::unix::fs::symlink(&secret, folder.join("content.epub.part")).unwrap();
        let target = BlobTarget::resolve(&root, "bk1", "content.epub", Access::Write).unwrap();
        assert_eq!(
            target.checked_part(&root).unwrap_err().kind(),
            "pathOutsideDataRoot"
        );
        // A real `.part` (a genuine resume) passes.
        std::fs::remove_file(folder.join("content.epub.part")).unwrap();
        std::fs::write(folder.join("content.epub.part"), b"partial").unwrap();
        assert!(target.checked_part(&root).is_ok());
        // The rename target being a symlink is refused too.
        std::os::unix::fs::symlink(&secret, folder.join("content.epub")).unwrap();
        assert_eq!(
            target.checked_part(&root).unwrap_err().kind(),
            "pathOutsideDataRoot"
        );
    }
}
