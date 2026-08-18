//! Which side of a pairing this device is.
//!
//! The build target and the runtime role are separate types on purpose (plan
//! III.2.2). A mobile build is always a satchel. A desktop build is a shelf —
//! unless, in a debug build, `PAPER_ROLE=satchel` says otherwise, which is
//! how one Mac pairs to another as a satchel in the two-instance harness. The
//! decision is made here, in Rust, and the webview asks for it
//! (`peer_local_role`); it never decides on its own.

use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

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

/// This device's role.
pub fn local_role() -> Result<Role> {
    resolve(build_target_role(), debug_override())
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

/// The pure half of [`local_role`]. A fixed role wins outright — the override
/// exists to let a desktop act as a satchel, never to make a phone a shelf.
fn resolve(fixed: Option<Role>, override_: Option<String>) -> Result<Role> {
    if let Some(role) = fixed {
        return Ok(role);
    }
    match override_ {
        None => Ok(Role::Shelf),
        Some(value) => value.parse(),
    }
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
        assert_eq!(resolve(None, None).unwrap(), Role::Shelf);
    }

    #[test]
    fn desktop_becomes_a_satchel_on_request() {
        assert_eq!(
            resolve(None, Some("satchel".into())).unwrap(),
            Role::Satchel
        );
        assert_eq!(resolve(None, Some("shelf".into())).unwrap(), Role::Shelf);
    }

    #[test]
    fn desktop_refuses_a_misspelt_override() {
        let err = resolve(None, Some("stachel".into())).unwrap_err();
        assert_eq!(err.kind(), "unknownRole");
    }

    #[test]
    fn a_fixed_role_ignores_the_override() {
        assert_eq!(
            resolve(Some(Role::Satchel), Some("shelf".into())).unwrap(),
            Role::Satchel
        );
        assert_eq!(
            resolve(Some(Role::Satchel), Some("garbage".into())).unwrap(),
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
