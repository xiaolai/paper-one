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
//! which goes through [`place_new`] because it must NOT clobber a key already in
//! use. Here replacing is exactly the intent: this is the newest state, and the
//! writer holds whatever lock the caller holds. [`write_new_atomic`] is the one
//! exception, for a first answer that must not replace one already given.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

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

    let renamed = {
        let _held = places();
        std::fs::rename(&tmp, path)
    };
    if let Err(e) = renamed {
        /* ⚠️ **THE RELIC IS REMOVED ON EVERY FAILING PATH.** A staged file left
         * behind is invisible — nothing reads it — so it accumulates silently
         * and the only symptom is a data directory that grows. */
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::Identity(format!(
            "could not install {}: {e}",
            path.display()
        )));
    }

    /* The rename is durable only once the directory entry is.
     *
     * ⚠️ **A DIRECTORY THAT WILL NOT OPEN AND A SYNC THAT FAILS ARE DIFFERENT
     * FACTS, AND THIS SWALLOWED BOTH.** The accommodation is for platforms
     * where a directory is not openable as a file (Windows): there the atomic
     * rename has still happened, and failing the write over an operation the
     * platform does not offer would be worse. That says nothing about a sync
     * that was attempted and FAILED — a full disk, a failing device, a
     * read-only remount. Reporting success there tells the caller the write is
     * durable when it is not, and the callers that matter here go on to
     * destroy something on the strength of it (see `voice::rotate`).
     *
     * `AGENTS.md` records the same rule for `screen_lock_state`: distinguish
     * ABSENT from UNREADABLE, and refuse the second rather than assuming. */
    /* `if let`, not `match`: the `Err` arm is deliberately empty — a platform
     * that does not open directories has still done the atomic rename — and
     * clippy is right that a one-armed match says that less clearly. */
    if let Ok(handle) = std::fs::File::open(dir) {
        handle.sync_all().map_err(|e| {
            Error::Identity(format!(
                "could not persist the directory entry for {}: {e}",
                path.display()
            ))
        })?;
    }
    Ok(())
}

/// Write `bytes` to `path` only if nothing is there, so a first answer cannot
/// replace one that landed before it. True if this call installed them.
///
/// [`place_new`], as `keyfile::install_new` installs a key: a reader sees a
/// complete file or none, and a loser discovers it lost instead of overwriting
/// the winner.
pub fn write_new_atomic(path: &Path, bytes: &[u8]) -> Result<bool> {
    write_new_by(path, bytes, place_new)
}

/// [`write_new_atomic`], apart from how the name is taken.
fn write_new_by(
    path: &Path,
    bytes: &[u8],
    place: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<bool> {
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
    let installed = place(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    match installed {
        Ok(()) => {
            /* The same accommodation and the same refusal as `write_atomic`. */
            if let Ok(handle) = std::fs::File::open(dir) {
                handle.sync_all().map_err(|e| {
                    Error::Identity(format!(
                        "could not persist the directory entry for {}: {e}",
                        path.display()
                    ))
                })?;
            }
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(Error::Identity(format!(
            "could not install {}: {e}",
            path.display()
        ))),
    }
}

/// Give the finished file `tmp` the name `path` unless something already has it,
/// answering `AlreadyExists` if so. Whichever way it goes, the caller removes `tmp`,
/// and finding it gone is not a failure.
///
/// `hard_link`, which is atomic and EXCLUSIVE on POSIX and NTFS, even against
/// another process, and which stays loud on a volume that refuses it.
///
/// ⚠️ **NOT ON ANDROID, WHICH DENIES `link()` TO APPS.** Since Marshmallow its
/// SELinux policy answers EACCES, so a first launch could not install a key or
/// answer the switch. No exclusive rename is there to use without a raw syscall
/// that the platform's seccomp filter is not known to allow, and `create_new` on
/// the name itself shows a reader a part-written key. [`rename_new`] is complete
/// or absent as a rename always is, and exclusive within one process, which there
/// is all there is: the Android app declares no second process, and a phone has
/// no second copy of it running over this directory.
pub(crate) fn place_new(tmp: &Path, path: &Path) -> std::io::Result<()> {
    if cfg!(target_os = "android") {
        rename_new(tmp, path)
    } else {
        std::fs::hard_link(tmp, path)
    }
}

/// [`place_new`] where hard links are not to be had: look, then rename, with
/// nothing that names a file allowed between the two.
pub(crate) fn rename_new(tmp: &Path, path: &Path) -> std::io::Result<()> {
    rename_new_after_look(tmp, path, || {})
}

/// [`rename_new`], with a way for a test to stand in the window it closes.
fn rename_new_after_look(
    tmp: &Path,
    path: &Path,
    after_look: impl FnOnce(),
) -> std::io::Result<()> {
    let _held = places();
    /* `symlink_metadata`: a dangling link has the name, and `link()` would refuse it. */
    match std::fs::symlink_metadata(path) {
        Ok(_) => return Err(std::io::ErrorKind::AlreadyExists.into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    after_look();
    std::fs::rename(tmp, path)
}

/// Held by everything here that renames onto a name [`rename_new`] may be looking
/// at, or its look says nothing about the rename that follows.
///
/// ⚠️ **ONE RENAME OUTSIDE THIS IS SAFE FOR ANOTHER REASON.** `voice::rotate` renames
/// over `voice.key`, under the per-root lock every install of that name holds.
fn places() -> MutexGuard<'static, ()> {
    static PLACES: Mutex<()> = Mutex::new(());
    PLACES.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two ways of taking a name, and the contract the callers' match arms hold them to.
    const PLACERS: [(&str, fn(&Path, &Path) -> std::io::Result<()>); 2] = [
        ("a hard link", |tmp, path| std::fs::hard_link(tmp, path)),
        ("the look and rename", rename_new),
    ];

    fn temps_in(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn either_placer_installs_into_an_empty_place_and_replaces_nothing() {
        for (name, place) in PLACERS {
            let dir = crate::testutil::scratch("place-new");
            let path = dir.join("deep").join("thing");
            assert!(write_new_by(&path, b"first", place).unwrap(), "{name}");
            assert!(!write_new_by(&path, b"second", place).unwrap(), "{name}");
            assert_eq!(std::fs::read(&path).unwrap(), b"first", "{name}");
            assert_eq!(temps_in(path.parent().unwrap()), Vec::<String>::new(), "{name}");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&path).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "{name}");
            }
        }
    }

    #[test]
    fn either_placer_answers_already_exists_and_leaves_the_temp_to_its_caller() {
        for (name, place) in PLACERS {
            let dir = crate::testutil::scratch("place-taken");
            let (tmp, path) = (dir.join("staged"), dir.join("thing"));
            std::fs::write(&tmp, b"second").unwrap();
            std::fs::write(&path, b"first").unwrap();
            let kind = place(&tmp, &path).unwrap_err().kind();
            assert_eq!(kind, std::io::ErrorKind::AlreadyExists, "{name}");
            assert!(tmp.exists(), "{name}");
            assert_eq!(std::fs::read(&path).unwrap(), b"first", "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn either_placer_counts_a_dangling_link_as_the_name_being_taken() {
        for (name, place) in PLACERS {
            let dir = crate::testutil::scratch("place-dangling");
            let (tmp, path) = (dir.join("staged"), dir.join("thing"));
            std::fs::write(&tmp, b"second").unwrap();
            std::os::unix::fs::symlink(dir.join("nowhere"), &path).unwrap();
            let kind = place(&tmp, &path).unwrap_err().kind();
            assert_eq!(kind, std::io::ErrorKind::AlreadyExists, "{name}");
            assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink(), "{name}");
        }
    }

    /// Exactly one of many first writers wins, on any machine that can run threads.
    #[test]
    fn the_look_and_rename_lets_one_of_many_writers_win() {
        let dir = crate::testutil::scratch("place-many");
        let path = dir.join("thing");
        let winners: Vec<usize> = std::thread::scope(|scope| {
            let writers: Vec<_> = (0..16)
                .map(|n| {
                    let path = &path;
                    scope.spawn(move || {
                        write_new_by(path, n.to_string().as_bytes(), rename_new)
                            .unwrap()
                            .then_some(n)
                    })
                })
                .collect();
            writers.into_iter().filter_map(|w| w.join().unwrap()).collect()
        });
        assert_eq!(winners.len(), 1, "winners: {winners:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), winners[0].to_string());
        assert_eq!(temps_in(&dir), Vec::<String>::new());
    }

    /// Run `rival` on another thread in the window between the look and the rename,
    /// and give it long enough to land there if anything would let it. The wait only
    /// decides how surely a broken guard is caught: a working one is never failed by it.
    fn rename_with_a_rival_in_the_window<T: Send>(
        tmp: &Path,
        path: &Path,
        rival: impl FnOnce() -> T + Send,
    ) -> (std::io::Result<()>, T) {
        std::thread::scope(|scope| {
            let (landed, wait) = std::sync::mpsc::channel();
            let mut running = None;
            let placed = rename_new_after_look(tmp, path, || {
                running = Some(scope.spawn(move || {
                    let answer = rival();
                    let _ = landed.send(());
                    answer
                }));
                let _ = wait.recv_timeout(std::time::Duration::from_millis(300));
            });
            (placed, running.expect("the look found the place empty").join().unwrap())
        })
    }

    /// ⚠️ **THE READER'S OWN OFF LANDS LAST.** The first answer is an inference from
    /// what is on the disk; a choice that reached the disk while it was being
    /// installed has to survive it, which is what `p2p::decided` promises.
    #[test]
    fn a_replacing_write_cannot_land_between_the_look_and_the_rename() {
        let dir = crate::testutil::scratch("place-window");
        let (tmp, path) = (dir.join("staged"), dir.join("thing"));
        std::fs::write(&tmp, b"inferred").unwrap();
        let (placed, written) =
            rename_with_a_rival_in_the_window(&tmp, &path, || write_atomic(&path, b"chosen"));
        placed.unwrap();
        written.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"chosen");
    }

    #[test]
    fn another_first_write_cannot_land_between_the_look_and_the_rename() {
        let dir = crate::testutil::scratch("place-window-new");
        let (tmp, path) = (dir.join("staged"), dir.join("thing"));
        std::fs::write(&tmp, b"first").unwrap();
        let (placed, second) = rename_with_a_rival_in_the_window(&tmp, &path, || {
            write_new_by(&path, b"second", rename_new)
        });
        placed.unwrap();
        assert!(!second.unwrap(), "two writers were both told they won");
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
    }

    /// A look that cannot answer is not an empty place, so it is not a win or a loss.
    #[test]
    fn the_look_stays_loud_when_it_cannot_answer() {
        let dir = crate::testutil::scratch("place-loud");
        let tmp = dir.join("staged");
        std::fs::write(&tmp, b"x").unwrap();
        std::fs::write(dir.join("file"), b"").unwrap();
        let refused = rename_new(&tmp, &dir.join("file").join("thing")).unwrap_err();
        assert_ne!(refused.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(tmp.exists());
    }

    /// ⚠️ **A THIRD HARD LINK WOULD PASS EVERY TEST THAT RUNS HERE AND FAIL ON A PHONE.**
    /// So the crate says it has one. `lock.rs` is the app's and desktop only.
    #[test]
    fn nothing_else_in_this_crate_makes_a_hard_link() {
        fn sources(dir: &Path, found: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    sources(&path, found);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    found.push(path);
                }
            }
        }
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&src, &mut files);
        assert!(files.len() > 10, "found {} sources under {}", files.len(), src.display());
        let this = src.join("store.rs");
        let call = ["hard", "_link("].concat();
        let others: Vec<_> = files
            .iter()
            .filter(|f| **f != this && std::fs::read_to_string(f).unwrap().contains(&call))
            .collect();
        assert_eq!(others, Vec::<&PathBuf>::new());
    }

    #[test]
    fn a_reader_sees_the_old_contents_or_the_new_and_never_a_truncated_file() {
        let dir = crate::testutil::scratch("atomic");
        let path = dir.join("thing.json");
        write_atomic(&path, b"{\"a\":1}").unwrap();
        write_atomic(&path, b"{\"a\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
    }

    #[test]
    fn a_first_write_installs_into_an_empty_place_and_replaces_nothing() {
        let dir = crate::testutil::scratch("atomic-new");
        let path = dir.join("deep").join("thing");
        assert!(write_new_atomic(&path, b"first").unwrap());
        assert!(!write_new_atomic(&path, b"second").unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
        let left: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(left.is_empty(), "left behind: {left:?}");
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
