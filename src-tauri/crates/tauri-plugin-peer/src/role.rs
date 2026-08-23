//! Which side of a pairing this device is.
//!
//! The build target and the runtime role are separate types on purpose (plan
//! III.2.2). A mobile build is always a satchel. A desktop build is a shelf —
//! unless, in a debug build, `PAPER_ROLE=satchel` says otherwise, which is
//! how one Mac pairs to another as a satchel in the two-instance harness. The
//! decision is made here, in Rust, and the webview asks for it
//! (`peer_local_role`); it never decides on its own.
//!
//! # A DESKTOP CAN NOW BE ASKED
//!
//! A second Mac had no way to be a satchel outside a debug build, and nothing
//! refused the state that produced: two shelves, paired, mutual, and silent —
//! neither dials, because `sync/index.ts` binds the role once and a shelf
//! "answers satchels; it does not dial them". The only symptom was a book menu
//! with no Download in it.
//!
//! So the reader's answer is a third input, stored beside the peers it governs.
//! THE ORDER IS THE WHOLE CONTRACT and each step earns its place:
//!
//!   1. the build target — a phone cannot hold the library, and no stored
//!      answer, no environment variable and no future UI may talk it into
//!      trying. This wins outright, exactly as before.
//!   2. `PAPER_ROLE` — the two-instance harness, which must work on a machine
//!      whatever the reader stored on it, or a test run would depend on the
//!      operator's own settings.
//!   3. the stored answer — what the reader said when they set the device up.
//!   4. shelf — a desktop that has never been asked, which is every desktop
//!      that exists today. Nothing changes for them.
//!
//! WHEN IT IS READ, AND THEREFORE WHEN A CHANGE LANDS. `state.rs` reads this
//! once, when the node starts, and `sync` reads it once at its own start and
//! binds it. Writing the file does not move a running app, and pretending
//! otherwise would be worse than saying so: the UI tells the reader the change
//! applies next launch, and only offers it while the device is unpaired, when
//! there is nothing yet to reconcile.

use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::identity::PEER_DIR;

/// The debug-only override. `shelf` or `satchel`; anything else is an error,
/// not a silent default.
pub const ROLE_ENV: &str = "PAPER_ROLE";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The authoritative library — a desktop.
    Shelf,
    /// A thin reader paired to a shelf — a phone, or a desktop pretending.
    Satchel,
}

impl FromStr for Role {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim() {
            "shelf" => Ok(Role::Shelf),
            "satchel" => Ok(Role::Satchel),
            other => Err(Error::UnknownRole(other.to_string())),
        }
    }
}

/// The file the reader's answer lives in, beside the peers it governs.
///
/// Plain text — one word, `shelf` or `satchel`. Not JSON: it holds a single
/// enum whose parser already exists and already rejects everything else by
/// name, and a one-field object would invite a second field later, which is
/// how a role file becomes a settings file nobody meant to write.
pub fn role_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join("role")
}

/// The reader's stored answer, or `None` when they have never been asked.
///
/// UNREADABLE IS THE SAME AS UNANSWERED, deliberately. A missing file, a
/// truncated one, a word from a newer version — every one of them means "this
/// device has no answer I can use", and the resolve below then falls to the
/// default that has always applied. The alternative is refusing to start the
/// peer node over a corrupt one-word file, which trades a recoverable state
/// for an unrecoverable one.
pub fn stored_role(root: &Path) -> Option<Role> {
    std::fs::read_to_string(role_path(root)).ok()?.parse().ok()
}

/// Write the reader's answer durably.
///
/// Temp-then-rename like `peers.rs`, and for the same reason: a half-written
/// role read at the next launch is a device that silently changed sides.
pub fn set_stored_role(root: &Path, role: Role) -> Result<()> {
    let path = role_path(root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, role_word(role))?;
    if let Err(err) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.into());
    }
    if let Some(dir) = path.parent() {
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// The word `stored_role` parses back. Beside the parser on purpose.
const fn role_word(role: Role) -> &'static str {
    match role {
        Role::Shelf => "shelf",
        Role::Satchel => "satchel",
    }
}

/// This device's role, given where its data lives.
pub fn local_role(root: &Path) -> Result<Role> {
    resolve(build_target_role(), debug_override(), stored_role(root))
}

/// What the compile target fixes, if anything. `cfg(mobile)` is emitted by
/// the plugin's build script from the target OS.
const fn build_target_role() -> Option<Role> {
    if cfg!(mobile) {
        Some(Role::Satchel)
    } else {
        None
    }
}

#[cfg(debug_assertions)]
fn debug_override() -> Option<String> {
    std::env::var(ROLE_ENV).ok()
}

#[cfg(not(debug_assertions))]
fn debug_override() -> Option<String> {
    None
}

/// The pure half of [`local_role`], and the order is the contract — see the
/// module header. A fixed role wins outright: the override and the stored
/// answer exist to let a DESKTOP act as a satchel, never to make a phone a
/// shelf.
fn resolve(fixed: Option<Role>, override_: Option<String>, stored: Option<Role>) -> Result<Role> {
    if let Some(role) = fixed {
        return Ok(role);
    }
    if let Some(value) = override_ {
        return value.parse();
    }
    Ok(stored.unwrap_or(Role::Shelf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_two_roles() {
        assert_eq!("shelf".parse::<Role>().unwrap(), Role::Shelf);
        assert_eq!("satchel".parse::<Role>().unwrap(), Role::Satchel);
        assert_eq!(" satchel\n".parse::<Role>().unwrap(), Role::Satchel);
    }

    #[test]
    fn rejects_anything_else_by_name() {
        for bad in ["", "Shelf", "SATCHEL", "phone", "shelf satchel"] {
            let err = bad.parse::<Role>().unwrap_err();
            assert_eq!(err.kind(), "unknownRole", "{bad:?}");
            assert!(err.to_string().contains(&format!("{:?}", bad.trim())));
        }
    }

    #[test]
    fn desktop_is_a_shelf_without_an_override() {
        assert_eq!(resolve(None, None, None).unwrap(), Role::Shelf);
    }

    #[test]
    fn desktop_becomes_a_satchel_on_request() {
        assert_eq!(
            resolve(None, Some("satchel".into()), None).unwrap(),
            Role::Satchel
        );
        assert_eq!(
            resolve(None, Some("shelf".into()), None).unwrap(),
            Role::Shelf
        );
    }

    #[test]
    fn desktop_refuses_a_misspelt_override() {
        let err = resolve(None, Some("stachel".into()), None).unwrap_err();
        assert_eq!(err.kind(), "unknownRole");
    }

    #[test]
    fn a_stored_answer_makes_a_desktop_a_satchel() {
        assert_eq!(
            resolve(None, None, Some(Role::Satchel)).unwrap(),
            Role::Satchel
        );
    }

    #[test]
    fn a_desktop_that_was_never_asked_is_a_shelf_exactly_as_before() {
        // Every desktop that exists today. The feature is additive or it is a
        // migration, and it is not a migration.
        assert_eq!(resolve(None, None, None).unwrap(), Role::Shelf);
    }

    #[test]
    fn the_harness_override_beats_a_stored_answer() {
        // `second-instance.sh` runs `PAPER_ROLE=satchel`, and a test run must
        // not depend on what the operator once chose on that machine.
        assert_eq!(
            resolve(None, Some("shelf".into()), Some(Role::Satchel)).unwrap(),
            Role::Shelf
        );
    }

    #[test]
    fn a_phone_cannot_be_talked_into_holding_the_library() {
        // The one guarantee nothing above may weaken: not by the environment,
        // not by a stored answer, not by both at once.
        assert_eq!(
            resolve(Some(Role::Satchel), Some("shelf".into()), Some(Role::Shelf)).unwrap(),
            Role::Satchel
        );
    }

    #[test]
    fn a_stored_answer_survives_a_write_and_an_unreadable_one_does_not_throw() {
        let dir = std::env::temp_dir().join(format!("paper-role-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(stored_role(&dir), None, "never asked");

        set_stored_role(&dir, Role::Satchel).unwrap();
        assert_eq!(stored_role(&dir), Some(Role::Satchel));
        set_stored_role(&dir, Role::Shelf).unwrap();
        assert_eq!(stored_role(&dir), Some(Role::Shelf), "overwrites");

        // A word from a newer version reads as "no answer I can use", never as
        // a reason to refuse to start the node.
        std::fs::write(role_path(&dir), "hub").unwrap();
        assert_eq!(stored_role(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fixed_role_ignores_the_override() {
        assert_eq!(
            resolve(Some(Role::Satchel), Some("shelf".into()), None).unwrap(),
            Role::Satchel
        );
        assert_eq!(
            resolve(Some(Role::Satchel), Some("garbage".into()), None).unwrap(),
            Role::Satchel
        );
    }

    #[test]
    fn serializes_lowercase() {
        assert_eq!(serde_json::to_string(&Role::Shelf).unwrap(), "\"shelf\"");
        assert_eq!(
            serde_json::to_string(&Role::Satchel).unwrap(),
            "\"satchel\""
        );
    }
}
