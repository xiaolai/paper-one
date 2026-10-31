//! The reader's one switch over all peer-to-peer: Circle, Public and Sync.
//!
//! `dev-docs/decisions/2026-10-31-p2p-switch.md` is the decision. The file here
//! is the fact, because the share endpoint resumes from plugin setup, before
//! any webview exists to ask. [`crate::state::PeerState`] reads it at the only
//! two doors to an endpoint, so a surface that forgot the switch is refused
//! rather than connected.
//!
//! ⚠️ **ANYTHING BUT A CLEAR `on` IS OFF.** A switch the reader set to off must
//! not come back on because its file stopped parsing.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::identity::PEER_DIR;
use crate::peers::PeerStore;
use crate::person::{device_role_path, person_path};
use crate::share::policy::{SharePolicy, ShareService};
use crate::store::{write_atomic, write_new_atomic};

const SWITCH_FILE: &str = "p2p-switch";

fn switch_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(SWITCH_FILE)
}

/// Whether this device has already taken part in P2P. Reads files only: no
/// keychain prompt and no network.
fn in_use(root: &Path) -> Result<bool> {
    /* Not `load_or_refuse_all`: that reads a damaged file as "nothing offered",
     * and the answer given here is written down for good. */
    let offered = SharePolicy::load(root)?;
    Ok(!PeerStore::load(root)?.list().is_empty()
        || device_role_path(root).exists()
        || person_path(root).exists()
        || ShareService::ALL
            .iter()
            .any(|service| !offered.offered(*service).is_empty()))
}

/// Whether P2P is on, deciding and recording the answer on first asking.
///
/// ⚠️ **DECIDED ONCE AND WRITTEN DOWN.** Re-deriving it every launch would turn
/// the switch back on for a reader who turned it off while still paired.
///
/// ⚠️ **THE FIRST ANSWER NEVER REPLACES ANYTHING.** Plugin setup and the webview
/// both ask at launch. An asker that found no file and was then slow reading the
/// evidence used to write its inference over whatever had landed meanwhile,
/// which could be the reader's own off. It installs only into an empty place,
/// then answers from the file, so every asker agrees with whoever won.
pub fn is_on(root: &Path) -> Result<bool> {
    decided(root, in_use)
}

/// [`is_on`], apart from where the evidence comes from.
fn decided(root: &Path, evidence: impl FnOnce(&Path) -> Result<bool>) -> Result<bool> {
    let path = switch_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(says_on(&text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            write_new_atomic(&path, word(evidence(root)?))?;
            Ok(says_on(&std::fs::read_to_string(&path)?))
        }
        Err(err) => Err(err.into()),
    }
}

fn says_on(text: &str) -> bool {
    text.trim() == "on"
}

fn word(on: bool) -> &'static [u8] {
    if on {
        b"on"
    } else {
        b"off"
    }
}

/// Record the reader's choice. It is durable when this returns.
pub fn set(root: &Path, on: bool) -> Result<()> {
    let path = switch_path(root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_atomic(&path, word(on))
}

/// `Ok` when P2P is on; the refusal an endpoint start returns when it is not.
pub fn require_on(root: &Path) -> Result<()> {
    if is_on(root)? {
        Ok(())
    } else {
        Err(Error::P2pOff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peers::PeerRecord;
    use crate::role::Role;
    use crate::testutil::ScratchDir;

    fn write_peer_file(root: &Path, name: &str, bytes: &str) {
        let dir = root.join(PEER_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), bytes).unwrap();
    }

    #[test]
    fn a_fresh_install_starts_off_and_records_it() {
        let scratch = ScratchDir::new("p2p-fresh");
        assert!(!is_on(scratch.path()).unwrap());
        assert_eq!(
            std::fs::read_to_string(switch_path(scratch.path())).unwrap(),
            "off"
        );
    }

    #[test]
    fn an_install_with_a_circle_identity_starts_on() {
        let scratch = ScratchDir::new("p2p-person");
        write_peer_file(scratch.path(), "circle-person", "someone");
        assert!(is_on(scratch.path()).unwrap());
    }

    #[test]
    fn an_install_with_a_paired_device_starts_on() {
        let scratch = ScratchDir::new("p2p-paired");
        PeerStore::load(scratch.path())
            .unwrap()
            .insert(PeerRecord {
                id: "a".into(),
                name: "n".into(),
                platform: "macos".into(),
                role: Role::Shelf,
                grants: vec![],
                paired_at: 1,
                last_seen_at: 1,
                last_addrs: vec![],
            })
            .unwrap();
        assert!(is_on(scratch.path()).unwrap());
    }

    #[test]
    fn an_install_with_a_public_offer_starts_on() {
        let scratch = ScratchDir::new("p2p-offer");
        std::fs::create_dir_all(scratch.path().join(PEER_DIR)).unwrap();
        let hash = crate::share::ContentHash::parse(&"a".repeat(64)).unwrap();
        SharePolicy::load_or_refuse_all(scratch.path())
            .set(&hash, ShareService::Bytes, true)
            .unwrap();
        assert!(is_on(scratch.path()).unwrap());
    }

    /// A reader who turned it off while still paired stays off: the evidence
    /// that decided the first answer must not overrule their choice.
    #[test]
    fn the_readers_choice_outranks_the_evidence() {
        let scratch = ScratchDir::new("p2p-choice");
        write_peer_file(scratch.path(), "circle-person", "someone");
        set(scratch.path(), false).unwrap();
        assert!(!is_on(scratch.path()).unwrap());
        assert!(matches!(require_on(scratch.path()), Err(Error::P2pOff)));
        set(scratch.path(), true).unwrap();
        assert!(is_on(scratch.path()).unwrap());
        assert!(require_on(scratch.path()).is_ok());
    }

    /// The reader turned it off while a slow first asker was still reading the
    /// evidence. That asker's inference must not bring it back on next launch.
    #[test]
    fn a_choice_landing_during_the_first_answer_outranks_it() {
        let scratch = ScratchDir::new("p2p-late-off");
        let answer = decided(scratch.path(), |root| {
            set(root, false)?;
            Ok(true)
        })
        .unwrap();
        assert!(!answer);
        assert_eq!(
            std::fs::read_to_string(switch_path(scratch.path())).unwrap(),
            "off"
        );
    }

    #[test]
    fn an_on_landing_during_the_first_answer_outranks_it_too() {
        let scratch = ScratchDir::new("p2p-late-on");
        let answer = decided(scratch.path(), |root| {
            set(root, true)?;
            Ok(false)
        })
        .unwrap();
        assert!(answer);
        assert!(is_on(scratch.path()).unwrap());
    }

    /// Whichever first asker installs its answer, the other reports that answer
    /// rather than its own inference.
    #[test]
    fn the_loser_of_the_first_answer_reports_the_winner() {
        let scratch = ScratchDir::new("p2p-loser");
        let answer = decided(scratch.path(), |root| {
            assert!(decided(root, |_| Ok(true)).unwrap());
            Ok(false)
        })
        .unwrap();
        assert!(answer);
    }

    #[test]
    fn askers_at_once_agree_and_leave_one_clean_file() {
        let scratch = ScratchDir::new("p2p-racers");
        write_peer_file(scratch.path(), "circle-person", "someone");
        let root = scratch.path();
        let answers: Vec<bool> = std::thread::scope(|threads| {
            let askers: Vec<_> = (0..16)
                .map(|_| threads.spawn(|| is_on(root).unwrap()))
                .collect();
            askers.into_iter().map(|one| one.join().unwrap()).collect()
        });
        assert!(answers.into_iter().all(|on| on));
        let mut left: Vec<_> = std::fs::read_dir(root.join(PEER_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["circle-person", SWITCH_FILE]);
    }

    #[test]
    fn a_file_that_does_not_say_on_is_off() {
        let scratch = ScratchDir::new("p2p-junk");
        write_peer_file(scratch.path(), SWITCH_FILE, "garbage");
        assert!(!is_on(scratch.path()).unwrap());
    }

    /// Paired devices that cannot be read are not evidence of a fresh install,
    /// so nothing is written down and the refusal stays loud.
    #[test]
    fn unreadable_evidence_refuses_without_deciding() {
        let scratch = ScratchDir::new("p2p-corrupt");
        write_peer_file(scratch.path(), "peers.json", "not json");
        assert!(is_on(scratch.path()).is_err());
        assert!(!switch_path(scratch.path()).exists());
    }

    /// The offers are the only evidence a publishing reader may have, and the
    /// answer given here is permanent.
    #[test]
    fn a_damaged_offer_file_refuses_without_deciding() {
        let scratch = ScratchDir::new("p2p-corrupt-offers");
        let hash = crate::share::ContentHash::parse(&"a".repeat(64)).unwrap();
        std::fs::create_dir_all(scratch.path().join(PEER_DIR)).unwrap();
        SharePolicy::load_or_refuse_all(scratch.path())
            .set(&hash, ShareService::Bytes, true)
            .unwrap();
        std::fs::write(
            crate::share::policy::policy_path(scratch.path()),
            "not json",
        )
        .unwrap();
        assert!(is_on(scratch.path()).is_err());
        assert!(!switch_path(scratch.path()).exists());
    }
}
