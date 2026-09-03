//! Publishing a file's complete new contents, or none of them.
//!
//! ⚠️ **THIS EXISTS BECAUSE THE THIRD PLAIN `fs::write` WAS ABOUT TO BE
//! WRITTEN.** `peers.rs` and `identity.rs` each grew their own temp-and-install
//! dance, each with a comment explaining what it cost to learn; the circle's
//! own files — the people list, the roster this device publishes — were still
//! going out through `std::fs::write`, which truncates first and then writes.
//! A process that dies in that gap leaves a file that parses as nothing, and
//! `known_people` is documented to THROW on a malformed file rather than read
//! it as "this reader knows nobody". So a torn write does not quietly empty the
//! circle; it makes every circle surface fail until somebody deletes the file.
//!
//! The install is `rename`, which replaces atomically — unlike `identity.rs`,
//! which uses `hard_link` because it must NOT clobber a key already in use.
//! Here replacing is exactly the intent: this is the newest state, and the
//! writer holds whatever lock the caller holds.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{Error, Result};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// The temp sibling this writer will use, private to it.
///
/// ⚠️ **A SHARED TEMP NAME IS A DEFECT, NOT A DETAIL.** `identity.rs` carries
/// the full account: two writers on one `foo.tmp` unlink each other's open
/// file and publish bytes under a name the other still holds. Pid plus a
/// never-repeating sequence means a relic under this name can only be a dead
/// process's.
fn temp_beside(path: &Path) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("store");
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Write the complete new contents to `tmp`, synced, not yet installed.
///
/// Separate from [`write_atomic`] so the relic-recovery path is reachable from
/// a test: `temp_beside` never hands out the same name twice, so a test that
/// occupies a name is occupying one the next writer will not pick, and the
/// recovery below would never run. It was written that way first — a test that
/// asserted a later write succeeded, which it would have with the recovery
/// deleted.
fn stage(tmp: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    /* `create_new`, not `create(true).truncate(true)`: a truncating open
    follows a stale symlink and reuses a stale file's looser mode, since
    `mode(0o600)` applies only to a file the open itself creates. */
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        /* 0600 — the same as `peers.json`. These files name the people a
        reader shares with, which is not other users' business. */
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = match opts.open(tmp) {
        Ok(file) => file,
        /* Only a dead process can own this name — see `temp_beside`. */
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::remove_file(tmp)?;
            opts.open(tmp)?
        }
        Err(e) => return Err(e),
    };
    use std::io::Write;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Write `bytes` to `path` so a reader sees either the old contents or the new.
///
/// The parent directory is created, the temp file is `fsync`ed before the
/// rename, and the DIRECTORY is `fsync`ed after it — without that last step a
/// crash can lose the rename itself and leave yesterday's file standing.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| Error::Identity(format!("{} has no parent", path.display())))?;
    std::fs::create_dir_all(dir)
        .map_err(|e| Error::Identity(format!("could not make {}: {e}", dir.display())))?;

    let tmp = temp_beside(path);
    if let Err(e) = stage(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::Identity(format!(
            "could not stage {}: {e}",
            path.display()
        )));
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        /* ⚠️ **THE RELIC IS REMOVED ON EVERY FAILING PATH.** A staged file left
         * behind is invisible — nothing reads it — so it accumulates silently
         * and the only symptom is a data directory that grows. */
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::Identity(format!(
            "could not install {}: {e}",
            path.display()
        )));
    }

    /* The rename is durable only once the directory entry is. Best effort:
    a filesystem that will not open a directory (Windows) has still done
    the atomic part, and failing the write over it would be worse. */
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reader_sees_the_old_contents_or_the_new_and_never_a_truncated_file() {
        let dir = crate::testutil::scratch("atomic");
        let path = dir.join("thing.json");
        write_atomic(&path, b"{\"a\":1}").unwrap();
        write_atomic(&path, b"{\"a\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
    }

    #[test]
    fn nothing_is_left_beside_the_file_when_it_succeeds() {
        /* ⚠️ **THE ASSERTION THAT STOPS A RELIC ACCUMULATING.** A staged file
        nobody reads is invisible; the only symptom is a data directory that
        grows for ever, which nobody notices and nobody attributes to this. */
        let dir = crate::testutil::scratch("atomic-clean");
        let path = dir.join("thing.json");
        for _ in 0..5 {
            write_atomic(&path, b"x").unwrap();
        }
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(left.is_empty(), "left behind: {left:?}");
    }

    #[test]
    fn it_makes_the_directory_rather_than_failing_on_a_first_write() {
        let dir = crate::testutil::scratch("atomic-mkdir");
        let path = dir.join("deep").join("er").join("thing.json");
        write_atomic(&path, b"x").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"x");
    }

    #[test]
    fn two_writers_do_not_share_a_temp_name() {
        /* The defect `identity.rs` records: one shared `foo.tmp`, and two
        writers unlink each other's open file. */
        let dir = crate::testutil::scratch("atomic-race");
        let path = dir.join("thing.json");
        let a = temp_beside(&path);
        let b = temp_beside(&path);
        assert_ne!(a, b);
        assert_eq!(a.parent(), Some(dir.as_path()), "staged beside the target");
    }

    #[test]
    fn a_dead_processs_relic_does_not_block_the_write_for_ever() {
        /* ⚠️ **THIS TEST WAS WRITTEN ONCE IN A FORM THAT COULD NOT FAIL.** It
        occupied a name from `temp_beside` and then called `write_atomic`,
        which — `temp_beside` never repeating — picked a DIFFERENT name; the
        relic was never in the way and the assertion passed with the recovery
        deleted. `stage` takes the path so the collision is real. */
        let dir = crate::testutil::scratch("atomic-relic");
        let tmp = dir.join("occupied.tmp");
        std::fs::write(&tmp, b"a dead process left this").unwrap();

        stage(&tmp, b"new").expect("recovers from a relic under its own name");
        assert_eq!(std::fs::read(&tmp).unwrap(), b"new");
    }

    #[test]
    fn staging_refuses_to_follow_a_symlink_out_of_the_directory() {
        /* `create_new` is what makes this true: a truncating open would write
        THROUGH the link, and the mode would come from the target. */
        #[cfg(unix)]
        {
            let dir = crate::testutil::scratch("atomic-symlink");
            let elsewhere = dir.join("elsewhere");
            std::fs::write(&elsewhere, b"not mine").unwrap();
            let tmp = dir.join("link.tmp");
            std::os::unix::fs::symlink(&elsewhere, &tmp).unwrap();

            /* The link is removed and replaced by a real file — the target is
            untouched, which is the property that matters. */
            stage(&tmp, b"new").unwrap();
            assert_eq!(std::fs::read(&elsewhere).unwrap(), b"not mine");
        }
    }
}
