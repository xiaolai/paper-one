//! The device's one keypair: `<root>/peer/identity.key`, 32 secret bytes,
//! generated on the first launch and loaded on every later one, so the
//! endpoint id a peer paired with is the endpoint id it finds next time.
//!
//! The file is written to a temp sibling and renamed into place, so it is
//! either absent (generate) or complete (load) — never a short file that
//! would brick every pairing on the next launch. A file of the wrong length
//! is reported, not overwritten. Mode 0600 on Unix; the directory `peer/` is
//! what the mobile shells exclude from backups (plan III.2.7).

use std::path::{Path, PathBuf};

use iroh::SecretKey;

use crate::error::{Error, Result};

/// The subdirectory of the data root that holds device-private state.
pub const PEER_DIR: &str = "peer";
const KEY_FILE: &str = "identity.key";
const KEY_LEN: u64 = 32;

/// `<root>/peer/identity.key`.
pub fn key_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(KEY_FILE)
}

/// Load the key, or generate and persist one if there is none.
pub fn load_or_create(root: &Path) -> Result<SecretKey> {
    let path = key_path(root);
    match std::fs::metadata(&path) {
        Ok(meta) => load(&path, meta.len()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let key = SecretKey::generate();
            write_new(&path, &key)?;
            Ok(key)
        }
        Err(err) => Err(err.into()),
    }
}

fn load(path: &Path, len: u64) -> Result<SecretKey> {
    if len != KEY_LEN {
        return Err(Error::IdentityCorrupt {
            path: path.to_path_buf(),
            len,
        });
    }
    let bytes = std::fs::read(path)?;
    let bytes: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| Error::IdentityCorrupt {
            path: path.to_path_buf(),
            len: bytes.len() as u64,
        })?;
    tighten_permissions(path)?;
    Ok(SecretKey::from_bytes(&bytes))
}

fn write_new(path: &Path, key: &SecretKey) -> Result<()> {
    let dir = path.parent().expect("key path has a parent");
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("key.tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        use std::io::Write;
        file.write_all(&key.to_bytes())?;
        file.sync_all()?;
    }
    // A leftover from an earlier crash could have been created before the
    // mode was applied by a different process; the rename below replaces
    // it, and the permissions are re-asserted on the final path.
    std::fs::rename(&tmp, path)?;
    tighten_permissions(path)?;
    if let Ok(dir_file) = std::fs::File::open(dir) {
        // Persist the rename. Directory fsync is Unix-only in effect; on
        // Windows opening a directory as a file fails, hence the `if let`.
        let _ = dir_file.sync_all();
    }
    Ok(())
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
