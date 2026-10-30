//! Where the index and the text beside it live.
//!
//! ```text
//! <data root>/
//!   passages/
//!     text/       one file per book — the canonical section text, retained
//!     index/      tantivy's postings, rebuildable from text/
//!     state.json  what is indexed, at what generation, and what would not read
//! ```
//!
//! ⚠️ **`Layout::under` TAKES THE APP'S DATA ROOT AND JOINS `passages` ITSELF.**
//! The voices plugin was handed a root that already ended in its own segment and
//! installed every pack one directory deeper than the app looked —
//! `…/voices/voices/packs`, which works perfectly and is merely wrong, so
//! nothing failed. Same shape, so the same warning where the next reader is.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// The subdirectory this crate owns under the data root.
pub const PASSAGES_DIR: &str = "passages";

/// The directories, RESOLVED — not created. [`Layout::ensure`] is the half that
/// touches the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// `<data root>/passages`
    pub base: PathBuf,
    /// The extracted section text, one file per book.
    pub text_dir: PathBuf,
    /// Tantivy's own directory.
    pub index_dir: PathBuf,
    /// What is indexed, and what would not read.
    pub state_path: PathBuf,
}

impl Layout {
    /// The layout under `root`, pure — no directory is created.
    #[must_use]
    pub fn under(root: &Path) -> Self {
        let base = root.join(PASSAGES_DIR);
        Self {
            text_dir: base.join("text"),
            index_dir: base.join("index"),
            state_path: base.join("state.json"),
            base,
        }
    }

    /// Create every directory. Idempotent.
    ///
    /// # Errors
    /// Returns the underlying I/O failure.
    pub fn ensure(&self) -> Result<()> {
        std::fs::create_dir_all(&self.base)?;
        std::fs::create_dir_all(&self.text_dir)?;
        std::fs::create_dir_all(&self.index_dir)?;
        /* ⚠️ **ON EVERY OPEN, NOT ONLY AT CREATION.** `identity.rs` learned
         * this for `peer/`: every install that exists today was made before
         * the marker did, and loading is what reaches them. Marking on
         * creation alone leaves every index built by an earlier build in the
         * backup for ever. */
        exclude_from_backup(&self.base);
        Ok(())
    }

    /// Where one book's retained text lives.
    ///
    /// # Errors
    /// [`Error::BadPath`] when the id is empty or longer than an id can be.
    pub fn text_path(&self, book_id: &str) -> Result<PathBuf> {
        Ok(self.text_dir.join(format!("{}.jsonl", file_stem(book_id)?)))
    }
}

/// The longest a book id may be here — `MAX_RECORD_FIELD` on the TypeScript
/// side, which is where ids are bounded for every other store.
const MAX_ID: usize = 500;

/// How much of the id survives into the filename, for a human reading the
/// directory. The digest is what makes the name unique.
const SLUG: usize = 32;

/// A filename for a book id: a readable slug, then a digest of the WHOLE id.
///
/// ⚠️ **THE ID ITSELF CANNOT BE THE FILENAME, AND THE REASON IS WINDOWS.** Real
/// ids in this app look like `book:9f3c…` — and `:` is not a character a
/// filename may contain there, so a path built from the id works on the two
/// platforms most of the development happens on and fails on the third, which
/// is the leg this repository keeps for exactly that.
///
/// ⚠️ **AND `safeId`'s FOLD IS NOT AVAILABLE HERE EITHER.** `bookFolder.ts`
/// replaces every character outside `[A-Za-z0-9]` with `_`, which is MANY-TO-ONE
/// — `book:a` and `book_a` are one folder — and the app tolerates that because
/// it owns both ends and `book.add` refuses a folder that is taken. This plugin
/// is handed ids across an IPC boundary and has no such guard, so a fold would
/// silently file two books as one. The digest covers the whole id, and the id is
/// written INSIDE the file as well, so a collision is DETECTED on read rather
/// than merged.
///
/// # Errors
/// [`Error::BadPath`] for an empty id or one past [`MAX_ID`].
pub fn file_stem(book_id: &str) -> Result<String> {
    if book_id.is_empty() || book_id.len() > MAX_ID {
        return Err(Error::BadPath(book_id.to_owned()));
    }
    /* ⚠️ **NO EMPTY-SLUG FALLBACK, BECAUSE THERE IS NO EMPTY SLUG.** An empty id
     * is refused above and every character maps to exactly one output
     * character, so a `if slug.is_empty()` branch here could never be taken —
     * an unkillable mutant and a promise about a state that does not exist.
     * `an_id_with_no_ascii_at_all_still_gets_a_name` is the case that shows
     * why: it comes back `______-…`, not empty. Found by an independent
     * audit. */
    let slug: String = book_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(SLUG)
        .collect();
    Ok(format!("{slug}-{:016x}", fnv1a64(book_id.as_bytes())))
}

/// FNV-1a, 64-bit.
///
/// ⚠️ **`DefaultHasher` WOULD NOT DO, AND THE REASON IS THAT THIS NAME IS ON
/// DISK.** `std`'s hasher is explicitly not guaranteed stable across releases,
/// so a Rust upgrade would rename every file in `text/` and orphan the lot —
/// silently, since a missing file reads as a book that was never indexed. FNV-1a
/// is ten lines and is the same function for ever.
#[must_use]
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The marker Time Machine reads: the on-disk form of Foundation's
/// `NSURLIsExcludedFromBackupKey` (`CSBackupSetItemExcluded` without
/// `excludeByPath`) — an extended attribute on the item itself, so it travels
/// with the directory and needs no admin-owned preference file. `tmutil
/// isexcluded` reports it.
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_XATTR: &str = "com.apple.metadata:com_apple_backup_excludeItem";
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_VALUE: &[u8] = b"com.apple.backupd";

/// Keep `passages/` out of Time Machine.
///
/// ⚠️ **NOT INHERITED FROM `peer/`, AND THE REASON IS DIFFERENT TOO.** That
/// exclusion is applied to THAT directory — an extended attribute does not
/// travel to a sibling — and it exists because a restored Mac must not come
/// back as the peer it was copied from, which is an identity problem. This one
/// is about SIZE AND DERIVATION: every byte under `passages/` is derived from
/// books the backup is already carrying, so backing it up stores the library
/// twice to preserve something a rebuild reproduces exactly.
///
/// Best effort, deliberately, exactly as `peer/`'s is: a filesystem without
/// extended attributes refuses it, and a device that cannot mark its directory
/// must still be able to search. The failure is logged, not raised.
#[cfg(target_os = "macos")]
fn exclude_from_backup(dir: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = CString::new(dir.as_os_str().as_bytes()) else {
        log::warn!(
            "passages: {} could not be excluded from backup: the path holds a NUL",
            dir.display()
        );
        return;
    };
    let name = CString::new(BACKUP_EXCLUDE_XATTR).expect("a literal without NUL");
    // SAFETY: two NUL-terminated strings that outlive the call, and a value
    // buffer whose length is passed beside its pointer; `setxattr` copies the
    // value and keeps no pointer to it.
    let rc = unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            BACKUP_EXCLUDE_VALUE.as_ptr().cast(),
            BACKUP_EXCLUDE_VALUE.len(),
            0,
            0,
        )
    };
    if rc != 0 {
        log::warn!(
            "passages: {} could not be excluded from backup: {}",
            dir.display(),
            std::io::Error::last_os_error()
        );
    }
}

/// Nothing to mark: Linux and Windows have no per-item backup exclusion.
#[cfg(not(target_os = "macos"))]
fn exclude_from_backup(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_joins_its_own_segment_once() {
        let layout = Layout::under(Path::new("/tmp/root"));
        assert_eq!(layout.base, Path::new("/tmp/root/passages"));
        assert_eq!(layout.text_dir, Path::new("/tmp/root/passages/text"));
        assert_eq!(layout.index_dir, Path::new("/tmp/root/passages/index"));
        assert_eq!(
            layout.state_path,
            Path::new("/tmp/root/passages/state.json")
        );
        // The trap the voices plugin sprang: a caller that passes a root which
        // already ends in the segment gets it twice, so the caller must not.
        let doubled = Layout::under(Path::new("/tmp/root/passages"));
        assert_eq!(doubled.base, Path::new("/tmp/root/passages/passages"));
    }

    #[test]
    fn a_filename_carries_no_character_windows_refuses() {
        let name = file_stem("book:9f3c/../d").expect("a legal id");
        assert!(
            !name.contains([':', '/', '\\', '*', '?', '"', '<', '>', '|']),
            "{name} still holds a character Windows refuses"
        );
        assert!(!name.contains(".."), "{name} still names a parent");
    }

    #[test]
    fn two_ids_one_fold_would_merge_get_two_files() {
        // `safeId` maps both of these to `book_a`. The digest does not.
        let a = file_stem("book:a").expect("a legal id");
        let b = file_stem("book_a").expect("a legal id");
        assert_ne!(a, b);
        assert!(a.starts_with("book_a-"), "the slug stays readable: {a}");
    }

    #[test]
    fn an_id_with_no_ascii_at_all_still_gets_a_name() {
        let name = file_stem("《春天》").expect("a legal id");
        assert!(
            name.starts_with("______-") || name.starts_with('_'),
            "{name}"
        );
        assert!(name.len() < 64, "{name} is short enough to be a filename");
    }

    #[test]
    fn an_empty_or_enormous_id_is_refused() {
        assert!(file_stem("").is_err());
        assert!(file_stem(&"x".repeat(MAX_ID + 1)).is_err());
        assert!(file_stem(&"x".repeat(MAX_ID)).is_ok());
    }

    #[test]
    fn the_digest_is_the_published_constant_and_not_the_platform_hasher() {
        // Pinned so a change to the function is a change to this line, and
        // therefore a decision about every file already on disk.
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    /// ⚠️ **THE GATE THE PHASE PLAN ASKS FOR, RUN RATHER THAN ASSUMED.** *"Backup
    /// exclusion is not inherited from `peer/`. That exclusion is applied to that
    /// directory."* This reads the marker back with the same tool `tmutil
    /// isexcluded` reads — the extended attribute itself — so a `setxattr` that
    /// silently did nothing fails here rather than shipping an index that is
    /// backed up for ever.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_index_is_kept_out_of_time_machine() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let scratch = tempfile::tempdir().expect("a scratch directory");
        let layout = Layout::under(scratch.path());
        layout.ensure().expect("created");

        let path = CString::new(layout.base.as_os_str().as_bytes()).expect("no NUL");
        let name = CString::new(BACKUP_EXCLUDE_XATTR).expect("a literal");
        let mut held = [0u8; 64];
        // SAFETY: two NUL-terminated strings that outlive the call, and a
        // buffer whose length is passed beside its pointer.
        let read = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                held.as_mut_ptr().cast(),
                held.len(),
                0,
                0,
            )
        };
        assert!(
            read > 0,
            "the backup-exclusion marker is not on {}: {}",
            layout.base.display(),
            std::io::Error::last_os_error()
        );
        assert_eq!(
            &held[..read as usize],
            BACKUP_EXCLUDE_VALUE,
            "the marker is there with the wrong value"
        );
    }

    #[test]
    fn a_text_path_is_one_file_per_book() {
        let layout = Layout::under(Path::new("/tmp/root"));
        let path = layout.text_path("book:a").expect("a legal id");
        assert_eq!(path.parent(), Some(Path::new("/tmp/root/passages/text")));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("jsonl"));
        assert!(layout.text_path("").is_err());
    }
}
