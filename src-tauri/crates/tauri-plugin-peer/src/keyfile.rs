//! Putting a private key on disk, and taking it off again.
//!
//! ⚠️ **ONE COPY, BECAUSE THERE WERE TWO AND THEY HAD ALREADY DRIFTED.**
//! `identity.rs` and `share/voice.rs` each grew a non-clobbering installer, a
//! length-checked loader and a permission tightener — and `identity.rs`'s own
//! header says why that is worth nothing: the discipline *"was learned once and
//! is worth exactly nothing to a second key file that reimplements two thirds
//! of it"*. It reimplemented two thirds of it. Found by audit.
//!
//! What the copies disagreed about was not cosmetic. The voice installer never
//! synced the parent directory, so a rotation could report success over a
//! directory entry a power cut would lose — the file's bytes were durable and
//! the NAME that reaches them was not. One copy, and the fix lands in both.
//!
//! ⚠️ **WHAT IS NOT HERE: AUTHORISATION, BACKUP EXCLUSION, OR WHAT A KEY
//! MEANS.** `identity.rs` excludes `peer/` from Time Machine and decides that a
//! loser takes the winner's endpoint key; `voice.rs` decides what a retired
//! voice may still sign. Those are policy about a particular key and stay with
//! it. This module knows only how to write 32 bytes down safely.

use std::path::Path;

use iroh::SecretKey;

use crate::error::{Error, Result};

/// Lower-case hex, zero-padded.
///
/// ⚠️ **ONE COPY, AND THERE WERE THREE.** `identity.rs`, `share/voice.rs` and
/// `person.rs` each carried a byte-identical version, and `identity.rs`'s own
/// test records what a dropped leading zero costs: the string shortens, every
/// byte after it moves, the signature verifies nowhere, and the symptom is
/// "some pages fail" — the ones whose signature happens to contain a byte below
/// 0x10, which is most of them, sometimes. Three chances to get that wrong is
/// two too many.
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).expect("a nibble is a hex digit"));
        out.push(char::from_digit((byte & 0x0f) as u32, 16).expect("a nibble is a hex digit"));
    }
    out
}

/// A key file is 32 raw bytes and nothing else.
pub const KEY_LEN: usize = 32;

/// Whether this writer's key reached the name, or found one already there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Installed {
    /// This call published the key.
    Ours,
    /// Somebody else got there first; theirs stands and the caller re-reads.
    Theirs,
}

/// Read a key, refusing a file that is not one.
///
/// ⚠️ **THE LENGTH IS CHECKED BEFORE THE BYTES ARE TRUSTED**, and a wrong
/// length is [`Error::IdentityCorrupt`] rather than a truncated key: a file that
/// is not 32 bytes was not written by this code, and guessing at it would mint
/// an identity out of somebody's damaged disk.
pub fn load(path: &Path, len: u64) -> Result<SecretKey> {
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
    tighten(path)?;
    Ok(SecretKey::from_bytes(&bytes))
}

/// Write a key WITHOUT clobbering one already at that name.
///
/// ⚠️ **`hard_link`, NOT `rename`: EXCLUSIVE on POSIX and NTFS**, so a second
/// writer discovers it lost rather than replacing a key that is already loaded
/// and in use. `identity.rs` carries the incident that taught this.
///
/// ⚠️ **THE TEMP NAME IS PRIVATE TO THIS WRITER — PID AND A SEQUENCE.** A pid
/// alone collides within one process, and the `AlreadyExists` branch then
/// deletes another live writer's open file. A relic under this name can only be
/// a dead process's, which is what makes removing it safe.
///
/// ⚠️ **AND THE CREATE IS EXCLUSIVE EITHER WAY.** A truncating `create(true)`
/// would follow a stale symlink and reuse a stale file's looser mode, since
/// `mode(0o600)` applies only to a file the open itself creates.
pub fn install_new(path: &Path, key: &SecretKey) -> Result<Installed> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let dir = path.parent().expect("a key path has a parent");
    std::fs::create_dir_all(dir)?;
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
        /* The temp holds PRIVATE KEY MATERIAL; a failure must not leave it —
         * and a cleanup that itself fails is a private key on disk under a name
         * nothing will ever look at again, which is worth saying out loud even
         * though the original error is what the caller needs. */
        remove_secret(&tmp);
        return Err(err);
    }
    let installed = std::fs::hard_link(&tmp, path);
    /* The name is published (or somebody else's is); either way this writer's
     * temp — key material — goes. */
    remove_secret(&tmp);
    let outcome = match installed {
        Ok(()) => Installed::Ours,
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Installed::Theirs,
        Err(err) => return Err(err.into()),
    };
    tighten(path)?;
    sync_dir(dir)?;
    Ok(outcome)
}

/// Persist a directory entry, so the NAME survives a power cut and not only the
/// bytes it points at.
///
/// ⚠️ **THE VOICE INSTALLER DID NOT DO THIS AT ALL**, so a rotation could
/// report success over a link a crash would lose — the one outcome the
/// retain-before-replace ordering exists to prevent, reached by a different
/// route. Found by audit.
///
/// Best effort ONLY where the platform cannot do it: Windows cannot open a
/// directory as a file. A Unix failure is LOGGED rather than swallowed.
pub fn sync_dir(dir: &Path) -> Result<()> {
    match std::fs::File::open(dir) {
        /* ⚠️ **A SYNC THAT WAS ATTEMPTED AND FAILED IS AN ERROR, NOT A
         * WARNING.** This logged and returned success, so `install_new`
         * reported a durable key over a directory entry a power cut would lose
         * — the caller cannot act on a failure it is never told about, and
         * `voice::rotate` goes on to destroy the old key on the strength of
         * this answer. The `store.rs` writer already makes this distinction. */
        Ok(handle) => handle.sync_all().map_err(|err| {
            Error::Identity(format!(
                "could not persist the directory entry in {}: {err}",
                dir.display()
            ))
        }),
        /* The platform does not open directories (Windows). The rename or link
         * has still happened; there is no operation here to have failed. */
        Err(_) => Ok(()),
    }
}

/// Delete a file that holds key material, saying so if it will not go.
///
/// ⚠️ **`let _ =` LEFT PRIVATE KEYS ON DISK IN SILENCE.** A temp file this
/// writer made carries 32 secret bytes; a cleanup that fails leaves them under
/// a name nothing else will ever enumerate. The original error is still what
/// the caller sees — this is not a reason to fail an operation that otherwise
/// worked — but it stops being invisible.
fn remove_secret(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::warn!(
            "peer: key material was left at {} and could not be removed: {err}",
            path.display()
        ),
    }
}

/// 0600 on a key that is already there, on every load as well as at creation.
#[cfg(unix)]
pub fn tighten(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::metadata(path)?.permissions();
    if perms.mode() & 0o777 != 0o600 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn tighten(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ **A DROPPED LEADING ZERO SHORTENS THE STRING AND MOVES EVERY BYTE
    /// AFTER IT**, so the signature verifies nowhere and the symptom is "some
    /// pages fail". Moved here with the function it guards.
    #[test]
    fn hex_is_lower_case_and_zero_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
        assert_eq!(hex(&[]), "");
    }

    #[test]
    fn a_key_round_trips_through_the_file() {
        let dir = crate::testutil::scratch("keyfile-round-trip");
        let path = dir.join("some.key");
        let key = SecretKey::generate();
        assert_eq!(install_new(&path, &key).unwrap(), Installed::Ours);
        let back = load(&path, std::fs::metadata(&path).unwrap().len()).unwrap();
        assert_eq!(back.public(), key.public());
    }

    /// ⚠️ **THE LOSER TAKES THE WINNER'S KEY.** Installing by `hard_link` is
    /// what makes a name that is already published un-overwritable — `rename`
    /// would change the identity under a key already loaded and in use.
    #[test]
    fn a_key_already_at_the_name_is_taken_rather_than_overwritten() {
        let dir = crate::testutil::scratch("keyfile-loser");
        let path = dir.join("some.key");
        let first = SecretKey::generate();
        install_new(&path, &first).unwrap();
        let second = SecretKey::generate();
        assert_eq!(install_new(&path, &second).unwrap(), Installed::Theirs);
        let back = load(&path, std::fs::metadata(&path).unwrap().len()).unwrap();
        assert_eq!(
            back.public(),
            first.public(),
            "the second writer replaced a key that was already published"
        );
    }

    #[test]
    fn a_file_that_is_not_a_key_is_refused_rather_than_read() {
        let dir = crate::testutil::scratch("keyfile-corrupt");
        let path = dir.join("some.key");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, b"not thirty-two bytes").unwrap();
        let refused = load(&path, std::fs::metadata(&path).unwrap().len()).unwrap_err();
        assert_eq!(refused.kind(), "identityCorrupt");
    }

    #[cfg(unix)]
    #[test]
    fn an_installed_key_is_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::testutil::scratch("keyfile-mode");
        let path = dir.join("some.key");
        install_new(&path, &SecretKey::generate()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "a private key is readable by others");
    }
}
