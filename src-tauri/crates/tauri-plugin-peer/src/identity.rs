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

/// Which endpoint's key a path is for.
///
/// ⚠️ **A CLOSED SET, BECAUSE THE VALUE IS JOINED ONTO A DIRECTORY.** This was a
/// `&str` guarded by `debug_assert!`, which is absent from release builds — so
/// the check that stopped a caller naming `../../something` existed only where
/// nobody runs. Two variants, two filenames, and no way to express a third
/// without editing this enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointKey {
    /// The circle endpoint: identity-addressed, mutual consent.
    ///
    /// ⚠️ **"NEVER ANNOUNCED TO ANYONE WHO HAS NOT BEEN INTRODUCED" WAS
    /// WRITTEN HERE AND IS FALSE.** This endpoint IS advertised over mDNS on
    /// the local network — `endpoint.rs` records the decision (WI-25.8) and why
    /// it cannot be otherwise: mDNS discovery is symmetric, so a Paper that
    /// advertises nothing resolves nothing, and the LAN path goes with it. What
    /// is actually true is narrower and still worth having: this key never
    /// enters a public CONTENT index, and a stranger who fetched a book cannot
    /// try circle protocols against the key that served it. Found by audit.
    Circle,
    /// The share endpoint: content-addressed, anybody who holds a hash.
    Share,
}

impl EndpointKey {
    fn file_name(self) -> &'static str {
        match self {
            EndpointKey::Circle => CIRCLE_KEY_FILE,
            EndpointKey::Share => SHARE_KEY_FILE,
        }
    }
}

pub const CIRCLE_KEY_FILE: &str = "identity.key";

/// The SHARE endpoint's key — WI-25.1.
///
/// ⚠️ **A SECOND KEYPAIR IS THE WHOLE POINT, NOT AN IMPLEMENTATION DETAIL.**
/// The share endpoint is content-addressed and announced; the circle endpoint
/// is identity-addressed and private. One key for both would put the circle's
/// identity into a public content index, and would let a stranger who fetched
/// a book attempt circle protocols against the key that served it.
///
/// It gets this module's whole discipline — private temp sibling, hard-linked
/// into place, 0600, `peer/` excluded from backup — because a share key that
/// changes identity under a restart is a provider every stored address hint
/// points at and nobody can reach.
///
/// ⚠️ **AND WHAT THE SPLIT DOES NOT BUY IS ANONYMITY.** Both endpoints resolve
/// to the same addresses, so IP-level correlation of "same machine" stays
/// trivial. Said here because a reader of this constant is exactly the person
/// about to assume otherwise.
pub const SHARE_KEY_FILE: &str = "share.key";

/// The marker Time Machine reads: the on-disk form of Foundation's
/// `NSURLIsExcludedFromBackupKey` (`CSBackupSetItemExcluded` without
/// `excludeByPath`) — an extended attribute on the item itself, so it
/// travels with the directory and needs no admin-owned preference file.
/// `tmutil isexcluded` reports it.
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_XATTR: &str = "com.apple.metadata:com_apple_backup_excludeItem";
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_VALUE: &[u8] = b"com.apple.backupd";

/// `<root>/peer/<file>`, for one of the two key files named above.
///
/// ⚠️ **THE NAME IS A TYPE, AND IT USED TO BE A `&str` WITH A DEBUG
/// ASSERTION.** It is joined straight onto `peer/`, so a caller-supplied name
/// is a path traversal wearing a key's clothes — and `debug_assert!` compiles
/// to nothing in the build readers actually run. The two names this module owns
/// are the only two values [`EndpointKey`] has, so a third means adding a
/// variant here rather than passing a string from somewhere else.
pub fn key_path_named(root: &Path, file: EndpointKey) -> PathBuf {
    let file = file.file_name();
    root.join(PEER_DIR).join(file)
}

/// Load the circle endpoint's key, or generate and persist one if there is none.
pub fn load_or_create(root: &Path) -> Result<SecretKey> {
    load_or_create_named(root, EndpointKey::Circle)
}

/// Load one endpoint's key, or generate and persist one if there is none.
///
/// ⚠️ **THE DISCIPLINE IS THE FUNCTION, WHICH IS WHY THE SHARE KEY GOES THROUGH
/// IT RATHER THAN BESIDE IT.** Everything below — the backup exclusion set on
/// every load, the non-clobbering install, the refusal to overwrite a
/// wrong-length file, mode 0600 — was learned once and is worth exactly nothing
/// to a second key file that reimplements two thirds of it.
pub fn load_or_create_named(root: &Path, file: EndpointKey) -> Result<SecretKey> {
    let path = key_path_named(root, file);
    /* The exclusion goes on FIRST, before any key exists to back up: a
     * freshly written key that predates the marker is one Time Machine pass
     * away from being cloned, and a CORRUPT key used to return early past
     * the marker entirely. On every load, not only at creation — every
     * install that exists today wrote `peer/` before this marker did, and
     * loading is what reaches them. */
    let dir = root.join(PEER_DIR);
    let fresh = !dir.exists();
    std::fs::create_dir_all(&dir)?;
    /* ⚠️ **THE NEW DIRECTORY'S OWN ENTRY IS PERSISTED, NOT ONLY WHAT GOES IN
     * IT.** `install_new` fsyncs `peer/` so the key's name survives a crash —
     * but on a FRESH install `peer/` is itself a new entry in `root`, and
     * nothing synced that. A power cut could therefore lose the directory and
     * every key inside it while each individual write reported success. Only on
     * creation: syncing the library root on every load would be a fsync per
     * launch for a directory that has not changed. */
    if fresh {
        crate::keyfile::sync_dir(root)?;
    }
    exclude_from_backup(&dir);
    let key = match std::fs::metadata(&path) {
        Ok(meta) => crate::keyfile::load(&path, meta.len())?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let fresh = SecretKey::generate();
            match write_new(&path, &fresh)? {
                Installed::Ours => fresh,
                /* SOMEBODY ELSE'S KEY IS THE IDENTITY NOW. The generated one
                 * is discarded unused: this device has exactly one endpoint
                 * id, and a caller that went on using the key it made would
                 * be a second peer wearing the same install — the file says
                 * who this machine is, not whoever wrote last. */
                Installed::Theirs => crate::keyfile::load(&path, std::fs::metadata(&path)?.len())?,
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

/// The one thing this device's endpoint key may be asked to sign.
///
/// ⚠️ **A COMMAND THAT SIGNS ARBITRARY BYTES WITH THE ENDPOINT KEY IS A SIGNING
/// ORACLE, AND THIS ONE IS REACHABLE FROM THE RENDERER.** The same key
/// authenticates the QUIC connection, so bytes signed for one purpose and
/// presented as another is the classic cross-protocol substitution — the exact
/// attack `signedBytes` prefixes its domain to prevent. Confining the command
/// to this prefix is that defence made structural rather than conventional.
///
/// `page` and nothing else: a delegation and a roster are signed by the PERSON
/// root, in `person.rs`, on a key the renderer can never reach. If a second
/// device-signed kind is ever wanted, widening this is the deliberate act that
/// grants it.
const PAGE_DOMAIN: &str = "paper.circle.";

/// Whether `message` is a page's signed bytes and not something else.
///
/// `paper.circle.<version>.page\n…` — see `signedBytes` in `page.ts`, which is
/// the ONE place these bytes are built. The version is not pinned here: a v2
/// page is still a page, and a Rust constant that had to move in lockstep with
/// a TypeScript one is a second list of the kind `commands.rs` opens by warning
/// about.
fn is_page_bytes(message: &str) -> bool {
    let Some(rest) = message.strip_prefix(PAGE_DOMAIN) else {
        return false;
    };
    let Some((version, tail)) = rest.split_once('.') else {
        return false;
    };
    !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()) && tail.starts_with("page\n")
}

/// Sign a page with this device's endpoint key.
///
/// ⚠️ **THE DEVICE SIGNS PAGES; THE PERSON SIGNS DELEGATIONS.** A page is
/// authorised by the delegation it carries, which is why it may be signed by a
/// key that lives on disk rather than in the keychain — and why losing a device
/// costs a revocation rather than the identity.
pub fn sign_page(root: &Path, message: &str) -> Result<String> {
    if !is_page_bytes(message) {
        return Err(Error::Identity(
            "this device signs pages and nothing else".into(),
        ));
    }
    let key = load_or_create(root)?;
    Ok(crate::keyfile::hex(
        &key.sign(message.as_bytes()).to_bytes(),
    ))
}

/// Which key ended up at the path — see [`write_new`].
///
/// One definition, in `keyfile.rs`: this module and `share/voice.rs` both
/// install keys, and two enums saying the same thing is how the two installers
/// drifted apart in the first place.
use crate::keyfile::Installed;

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
/* ⚠️ **THE INSTALLER LIVES IN `keyfile.rs` NOW.** `share/voice.rs` had grown a
 * near-copy of this function that was missing the directory sync below — the
 * drift this module's own header warns about, arriving exactly as predicted.
 * One writer, both callers. What stays here is what an ENDPOINT key means:
 * the backup exclusion, and the rule that a loser takes the winner's identity. */
fn write_new(path: &Path, key: &SecretKey) -> Result<Installed> {
    crate::keyfile::install_new(path, key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    #[test]
    fn a_fresh_root_gets_a_key_and_the_file() {
        let dir = ScratchDir::new("identity-fresh");
        let key = load_or_create(dir.path()).unwrap();
        let path = key_path_named(dir.path(), EndpointKey::Circle);
        assert!(path.is_file());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 32);
        assert_eq!(std::fs::read(&path).unwrap(), key.to_bytes());
        /* ⚠️ **THIS CHECKED A NAME NOTHING WRITES ANY MORE.** The temp file
        was `identity.key.tmp` once; it carries a pid and a sequence now
        (`keyfile::install_new`), so asserting the old spelling was asserting
        that a file nobody creates does not exist — a test that passes however
        much key material is left behind. Enumerate instead: what matters is
        that NO temp survives, whatever it is called. */
        let leftovers: Vec<String> = std::fs::read_dir(path.parent().expect("a key has a parent"))
            .expect("the peer directory")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "key material was left behind in temp files: {leftovers:?}"
        );
    }

    /// THE LOSER OF A RACE TAKES THE WINNER'S KEY. Installing by `hard_link`
    /// means a second writer that reaches `write_new` with a key already
    /// published cannot overwrite it — which is what `rename` did, changing
    /// the endpoint id under a peer that had already loaded and used it.
    #[test]
    fn a_key_that_appeared_first_is_taken_rather_than_overwritten() {
        let dir = ScratchDir::new("identity-race");
        let path = key_path_named(dir.path(), EndpointKey::Circle);
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
        let path = key_path_named(dir.path(), EndpointKey::Circle);
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
        let mode = std::fs::metadata(key_path_named(dir.path(), EndpointKey::Circle))
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
        let path = key_path_named(dir.path(), EndpointKey::Circle);
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
        let path = key_path_named(dir.path(), EndpointKey::Circle);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, key.to_bytes()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let loaded = load_or_create(dir.path()).unwrap();
        assert_eq!(loaded.public(), key.public());
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn the_device_signs_pages_and_nothing_else() {
        /* ⚠️ **A COMMAND THAT SIGNS ARBITRARY BYTES WITH THE ENDPOINT KEY IS A
        SIGNING ORACLE, AND IT IS REACHABLE FROM THE RENDERER.** The same key
        authenticates every QUIC connection this device makes, so bytes signed
        for one purpose and presented as another is cross-protocol
        substitution — the attack `signedBytes` prefixes a domain to prevent.
        Confining it here makes that defence structural. */
        let dir = ScratchDir::new("sign-page");
        assert!(sign_page(dir.path(), "paper.circle.1.page\n{}").is_ok());

        for refused in [
            /* Another kind under the same domain — a delegation or a roster is
            the PERSON's to sign, on a key the renderer cannot reach. */
            "paper.circle.1.roster\n{}",
            "paper.circle.1.delegation\n{}",
            "paper.circle.1.revocation\n{}",
            "paper.circle.1.succession\n{}",
            /* Another protocol entirely. */
            "one.paper.reader/pair/1",
            "paper/circle/roster/1\n{}",
            /* The prefix without the structure. */
            "",
            "paper.circle.",
            "paper.circle.page\n{}",
            "paper.circle..page\n{}",
            "paper.circle.1.page",
            "paper.circle.x.page\n{}",
            /* And the prefix buried rather than leading, which a `contains`
            would have accepted. */
            "x paper.circle.1.page\n{}",
        ] {
            assert!(
                sign_page(dir.path(), refused).is_err(),
                "signed something that is not a page: {refused:?}"
            );
        }
    }

    #[test]
    fn a_page_signature_verifies_under_this_devices_endpoint_id() {
        /* The signature is worth nothing unless the key a peer already knows —
        the endpoint id it dialled — is the key that verifies it. */
        let dir = ScratchDir::new("sign-verify");
        let message = "paper.circle.1.page\n{\"v\":1}";
        let sig = sign_page(dir.path(), message).unwrap();
        let key = load_or_create(dir.path()).unwrap();

        assert_eq!(sig.len(), 128, "64 bytes as hex");
        assert!(key
            .public()
            .verify(message.as_bytes(), &parse_sig(&sig))
            .is_ok());
        /* And not over anything else. */
        assert!(key
            .public()
            .verify(b"paper.circle.1.page\n{}", &parse_sig(&sig))
            .is_err());
    }

    #[test]
    fn signing_twice_gives_the_same_bytes_because_ed25519_is_deterministic() {
        /* The property the cross-language golden vector in `person.rs` rests
        on. A signature with randomness in it could not be pinned at all. */
        let dir = ScratchDir::new("sign-twice");
        let message = "paper.circle.1.page\n{}";
        assert_eq!(
            sign_page(dir.path(), message).unwrap(),
            sign_page(dir.path(), message).unwrap()
        );
    }

    #[test]
    fn hex_is_lower_case_and_zero_padded() {
        /* ⚠️ **A DROPPED LEADING ZERO SHORTENS THE STRING AND MOVES EVERY BYTE
        AFTER IT.** The signature then verifies nowhere, and the symptom is
        "some pages fail" — the ones whose signature happens to contain a byte
        below 0x10, which is most of them, sometimes. */
        assert_eq!(crate::keyfile::hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
        assert_eq!(crate::keyfile::hex(&[]), "");
    }

    fn parse_sig(hex: &str) -> iroh::Signature {
        let mut bytes = [0u8; 64];
        for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
            bytes[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
        }
        iroh::Signature::from_bytes(&bytes)
    }
}
