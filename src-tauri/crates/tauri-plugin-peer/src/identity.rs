//! The device's one keypair: `<root>/peer/identity.key`, 32 secret bytes,
//! generated on the first launch and loaded on every later one, so the
//! endpoint id a peer paired with is the endpoint id it finds next time.
//!
//! The file is written to a private temp sibling and LINKED into place, so
//! it is either absent (generate) or complete (load) — never a short file
//! that would brick every pairing on the next launch, and never one writer's
//! key published over another's. A file of the wrong length is reported, not
//! overwritten. Mode 0600 on Unix.
//!
//! The directory `peer/` is kept out of backups, because a backup that
//! carries the key restores as THIS peer: a Mac restored or migrated from
//! another one comes back with the same endpoint id, and every device that
//! paired with the original accepts both. On macOS the plugin marks the
//! directory itself, here, with the attribute Time Machine reads
//! ([`exclude_from_backup`]); the mobile shells do the same through their
//! own APIs (plan III.2.7). Two live copies of one key still cannot be told
//! apart by their id — that needs an instance identity outside `peer/`, which
//! is `handover.md`'s design, not this file's.

use std::path::{Path, PathBuf};

use iroh::SecretKey;

use crate::error::{Error, Result};

/// The subdirectory of the data root that holds device-private state.
pub const PEER_DIR: &str = "peer";
const KEY_FILE: &str = "identity.key";
const KEY_LEN: usize = 32;

/// The marker Time Machine reads: the on-disk form of Foundation's
/// `NSURLIsExcludedFromBackupKey` (`CSBackupSetItemExcluded` without
/// `excludeByPath`) — an extended attribute on the item itself, so it
/// travels with the directory and needs no admin-owned preference file.
/// `tmutil isexcluded` reports it.
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_XATTR: &str = "com.apple.metadata:com_apple_backup_excludeItem";
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_VALUE: &[u8] = b"com.apple.backupd";

/// `<root>/peer/identity.key`.
pub fn key_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(KEY_FILE)
}

/// Load the key, or generate and persist one if there is none.
pub fn load_or_create(root: &Path) -> Result<SecretKey> {
    let path = key_path(root);
    /* The exclusion goes on FIRST, before any key exists to back up: a
     * freshly written key that predates the marker is one Time Machine pass
     * away from being cloned, and a CORRUPT key used to return early past
     * the marker entirely. On every load, not only at creation — every
     * install that exists today wrote `peer/` before this marker did, and
     * loading is what reaches them. */
    let dir = root.join(PEER_DIR);
    std::fs::create_dir_all(&dir)?;
    exclude_from_backup(&dir);
    let key = match std::fs::metadata(&path) {
        Ok(meta) => load(&path, meta.len())?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let fresh = SecretKey::generate();
            match write_new(&path, &fresh)? {
                Installed::Ours => fresh,
                /* SOMEBODY ELSE'S KEY IS THE IDENTITY NOW. The generated one
                 * is discarded unused: this device has exactly one endpoint
                 * id, and a caller that went on using the key it made would
                 * be a second peer wearing the same install — the file says
                 * who this machine is, not whoever wrote last. */
                Installed::Theirs => load(&path, std::fs::metadata(&path)?.len())?,
            }
        }
        Err(err) => return Err(err.into()),
    };
    Ok(key)
}

/// Keep `peer/` out of Time Machine, so a restored or migrated Mac does not
/// come back as the peer it was copied from. Set on `peer/` and nothing
/// else — the library around it is exactly what a backup should carry.
///
/// Best effort, deliberately: a filesystem without extended attributes
/// refuses it, and a device that cannot mark its directory must still be
/// able to pair. The failure is logged, not raised.
#[cfg(target_os = "macos")]
fn exclude_from_backup(dir: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = CString::new(dir.as_os_str().as_bytes()) else {
        log::warn!(
            "peer: {} could not be excluded from backup: the path holds a NUL",
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
            "peer: {} could not be excluded from backup: {}",
            dir.display(),
            std::io::Error::last_os_error()
        );
    }
}

/// Nothing to mark: Linux and Windows have no per-item backup exclusion, and
/// the mobile shells own theirs (plan III.2.7).
#[cfg(not(target_os = "macos"))]
fn exclude_from_backup(_dir: &Path) {}

fn load(path: &Path, len: u64) -> Result<SecretKey> {
    if len != KEY_LEN as u64 {
        return Err(Error::IdentityCorrupt {
            path: path.to_path_buf(),
            len,
        });
    }
    let bytes = std::fs::read(path)?;
    let bytes: [u8; KEY_LEN] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| Error::IdentityCorrupt {
            path: path.to_path_buf(),
            len: bytes.len() as u64,
        })?;
    tighten_permissions(path)?;
    Ok(SecretKey::from_bytes(&bytes))
}

/// Which key ended up at the path — see [`write_new`].
enum Installed {
    /// The one this call generated.
    Ours,
    /// Another writer's, published while this one was writing.
    Theirs,
}

/// Write `key` to a private temp file and install it WITHOUT CLOBBERING.
///
/// ⚠️ **THE TEMP NAME WAS SHARED AND THE INSTALL OVERWROTE.** Every caller
/// used one `identity.key.tmp` and unconditionally unlinked it first, so two
/// of them interleaved could unlink each other's open file, publish bytes
/// under a name the other still held, and — because `rename` replaces on
/// Unix — overwrite an identity that was already loaded and in use. Two
/// processes, two keys, and the endpoint id every paired device knows
/// changing underneath them. So: a temp name private to this writer, and
/// `hard_link` to install, which is atomic and EXCLUSIVE on POSIX and NTFS
/// (the library lock publishes the same way, `src/lock.rs`). A loser
/// discovers it lost instead of overwriting a winner.
fn write_new(path: &Path, key: &SecretKey) -> Result<Installed> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let dir = path.parent().expect("key path has a parent");
    std::fs::create_dir_all(dir)?;
    /* PRIVATE TO THIS WRITER: pid and a sequence number. A relic left under
     * this name can only be a dead process's — a live one with this pid is
     * this process, and the sequence never repeats within it — so removing
     * it and retrying is safe, which was not true of the shared name. The
     * create is EXCLUSIVE either way: a truncating `create(true)` would
     * follow a stale symlink and would reuse a stale file's looser mode,
     * since `mode(0o600)` applies only to a file the open itself creates. */
    let tmp = path.with_extension(format!(
        "key.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> Result<()> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = match opts.open(&tmp) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                std::fs::remove_file(&tmp)?;
                opts.open(&tmp)?
            }
            Err(err) => return Err(err.into()),
        };
        use std::io::Write;
        file.write_all(&key.to_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(err) = written {
        /* The temp holds PRIVATE KEY MATERIAL; a failure must not leave it. */
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    let installed = std::fs::hard_link(&tmp, path);
    // The name is published (or somebody else's is); either way this
    // writer's temp — key material — goes.
    let _ = std::fs::remove_file(&tmp);
    match installed {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            return Ok(Installed::Theirs)
        }
        Err(err) => return Err(err.into()),
    }
    tighten_permissions(path)?;
    /* Persist the new directory entry. Best-effort ONLY where the platform
     * cannot do it — Windows cannot open a directory as a file — but a Unix
     * failure is LOGGED: the comment used to claim the link was persisted
     * while every failure vanished into an `if let`. */
    match std::fs::File::open(dir) {
        Ok(dir_file) => {
            if let Err(err) = dir_file.sync_all() {
                log::warn!("peer: could not persist the identity's directory entry: {err}");
            }
        }
        Err(err) => {
            #[cfg(unix)]
            log::warn!("peer: could not open {} to sync it: {err}", dir.display());
            #[cfg(not(unix))]
            let _ = err;
        }
    }
    Ok(Installed::Ours)
}

#[cfg(unix)]
fn tighten_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::metadata(path)?.permissions();
    if perms.mode() & 0o777 != 0o600 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn tighten_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    #[test]
    fn a_fresh_root_gets_a_key_and_the_file() {
        let dir = ScratchDir::new("identity-fresh");
        let key = load_or_create(dir.path()).unwrap();
        let path = key_path(dir.path());
        assert!(path.is_file());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 32);
        assert_eq!(std::fs::read(&path).unwrap(), key.to_bytes());
        assert!(
            !path.with_extension("key.tmp").exists(),
            "temp file cleaned up"
        );
    }

    /// THE LOSER OF A RACE TAKES THE WINNER'S KEY. Installing by `hard_link`
    /// means a second writer that reaches `write_new` with a key already
    /// published cannot overwrite it — which is what `rename` did, changing
    /// the endpoint id under a peer that had already loaded and used it.
    #[test]
    fn a_key_that_appeared_first_is_taken_rather_than_overwritten() {
        let dir = ScratchDir::new("identity-race");
        let path = key_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let winner = SecretKey::generate();
        std::fs::write(&path, winner.to_bytes()).unwrap();

        // The state a second writer is in: it saw no file a moment ago and
        // has generated a key of its own.
        let mine = SecretKey::generate();
        assert!(matches!(
            write_new(&path, &mine).unwrap(),
            Installed::Theirs
        ));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            winner.to_bytes(),
            "the published identity was replaced"
        );
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "the loser left its key material behind: {leftovers:?}"
        );
        // And the caller ends up on the key that IS published, so both
        // processes answer to one endpoint id.
        assert_eq!(
            load_or_create(dir.path()).unwrap().to_bytes(),
            winner.to_bytes()
        );
    }

    #[test]
    fn two_loads_give_the_same_id() {
        let dir = ScratchDir::new("identity-stable");
        let first = load_or_create(dir.path()).unwrap();
        let second = load_or_create(dir.path()).unwrap();
        assert_eq!(first.public(), second.public());
        assert_eq!(first.to_bytes(), second.to_bytes());
    }

    #[test]
    fn two_roots_get_different_ids() {
        let a = ScratchDir::new("identity-a");
        let b = ScratchDir::new("identity-b");
        assert_ne!(
            load_or_create(a.path()).unwrap().public(),
            load_or_create(b.path()).unwrap().public()
        );
    }

    #[test]
    fn a_wrong_length_file_is_a_typed_error_and_is_left_alone() {
        let dir = ScratchDir::new("identity-corrupt");
        let path = key_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"short").unwrap();
        let err = load_or_create(dir.path()).unwrap_err();
        assert_eq!(err.kind(), "identityCorrupt");
        assert!(err.to_string().contains("5 bytes"));
        assert_eq!(std::fs::read(&path).unwrap(), b"short", "not overwritten");
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScratchDir::new("identity-mode");
        load_or_create(dir.path()).unwrap();
        let mode = std::fs::metadata(key_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "mode was {mode:o}");
    }

    /// What Time Machine reads back: the exclusion xattr's value, or `None`
    /// when the attribute is absent. `getxattr`, the syscall the marker is
    /// stored through — not `tmutil`, whose answer for a path under `/tmp`
    /// would fold in the system-wide exclusions and prove nothing about ours.
    #[cfg(target_os = "macos")]
    fn backup_exclusion(dir: &Path) -> Option<Vec<u8>> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let path = CString::new(dir.as_os_str().as_bytes()).unwrap();
        let name = CString::new(BACKUP_EXCLUDE_XATTR).unwrap();
        let mut value = vec![0u8; 64];
        let len = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        if len < 0 {
            let err = std::io::Error::last_os_error();
            assert_eq!(err.raw_os_error(), Some(libc::ENOATTR), "{err}");
            return None;
        }
        value.truncate(len as usize);
        Some(value)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_fresh_peer_directory_is_excluded_from_backup() {
        let dir = ScratchDir::new("identity-backup");
        assert_eq!(
            backup_exclusion(dir.path()),
            None,
            "the root itself is not marked"
        );
        load_or_create(dir.path()).unwrap();
        let peer_dir = dir.path().join(PEER_DIR);
        assert_eq!(
            backup_exclusion(&peer_dir).as_deref(),
            Some(BACKUP_EXCLUDE_VALUE),
            "peer/ carries the marker NSURLIsExcludedFromBackupKey writes"
        );
        assert_eq!(
            backup_exclusion(dir.path()),
            None,
            "only peer/ is excluded, not the library around it"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_existing_peer_directory_gains_the_exclusion_on_load() {
        // Every install that exists today has a `peer/` written before this
        // marker was; loading, not only creating, is what reaches them.
        let dir = ScratchDir::new("identity-backup-existing");
        let key = SecretKey::generate();
        let path = key_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, key.to_bytes()).unwrap();
        let peer_dir = dir.path().join(PEER_DIR);
        assert_eq!(backup_exclusion(&peer_dir), None);
        let loaded = load_or_create(dir.path()).unwrap();
        assert_eq!(loaded.public(), key.public());
        assert_eq!(
            backup_exclusion(&peer_dir).as_deref(),
            Some(BACKUP_EXCLUDE_VALUE)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_loose_existing_key_is_tightened_on_load() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScratchDir::new("identity-loose");
        let key = SecretKey::generate();
        let path = key_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, key.to_bytes()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let loaded = load_or_create(dir.path()).unwrap();
        assert_eq!(loaded.public(), key.public());
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
