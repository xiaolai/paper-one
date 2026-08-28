//! Where Paper's data lives — ONE resolution of the storage root.
//!
//! The root is `app_data_dir()` — `$APPDATA`, the same root the fs plugin's
//! ACL scope is written against — except in debug builds, where
//! `PAPER_TEST_DATA_DIR` overrides it, letting a test point a process at a
//! scratch directory. The override is compiled out of release builds —
//! `#[cfg(debug_assertions)]` on the function that reads it, so a release
//! binary contains no code that consults the environment at all.
//!
//! THIS USED TO BE TWO COPIES, then nearly three. `tauri-plugin-peer` had it,
//! `tauri-plugin-inference` had the same forty lines with a comment saying
//! the override was "shared with `tauri-plugin-peer` BY NAME" — a comment
//! standing in for a shared module — and the app crate, needing the root for
//! its library lock (`src/lock.rs`), was about to reach into the peer plugin
//! for it. That would have made the peer capability unremovable: `lib.rs`
//! referencing `tauri_plugin_peer` for something that is not the plugin, which
//! `scripts/lib/removal.mjs` refuses by name. A third copy in the app was the
//! other option, and the second instance of a thing is a class. So: one crate,
//! a plain library like `paper-webauth`, that everything writing under the
//! root depends on and no capability's removal takes with it.
//!
//! ⚠️ **THE OVERRIDE MOVES THE PLUGINS AND THE LOCK, AND IS NOT A
//! SECOND-INSTANCE SWITCH.** The kernel's own storage — `bookVault.ts`,
//! `appStorage.ts`, `bookFiles.ts` — passes `BaseDirectory.AppData`, so
//! `index.json`, every book folder, the flat store and `sync/journal.*` stay
//! in the real `$APPDATA` no matter what this variable says. Two app instances
//! started with two different values share one book vault while holding
//! separate identities. Measured 2026-08-20; the two-instance harness is two
//! machines (`scripts/second-instance.sh`, `dev-docs/sync.md`).

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// The debug-only override. Absolute; created if missing.
pub const TEST_DATA_DIR_ENV: &str = "PAPER_TEST_DATA_DIR";

/// Why the root could not be resolved. Each dependant maps these onto its
/// own error kinds — the plugins have a `kind()` per variant for the wire.
#[derive(Debug)]
pub enum Error {
    /// The override was set to a relative path.
    NotAbsolute(PathBuf),
    /// The directory could not be created.
    Io(io::Error),
    /// Tauri could not say where the app's data directory is.
    Tauri(tauri::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotAbsolute(p) => write!(
                f,
                "the data root must be an absolute path, got {}",
                p.display()
            ),
            Error::Io(e) => write!(f, "could not create the data root: {e}"),
            Error::Tauri(e) => write!(f, "could not resolve the app data directory: {e}"),
        }
    }
}

impl std::error::Error for Error {
    /// The chain survives the wrapper — diagnostics that stop at "could not
    /// create the data root" with the `io::Error` swallowed are half a story.
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::NotAbsolute(_) => None,
            Error::Io(e) => Some(e),
            Error::Tauri(e) => Some(e),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// The storage root for this process. Exists on return.
pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    resolve(debug_override(), || {
        app.path().app_data_dir().map_err(Error::Tauri)
    })
}

#[cfg(debug_assertions)]
fn debug_override() -> Option<OsString> {
    std::env::var_os(TEST_DATA_DIR_ENV)
}

#[cfg(not(debug_assertions))]
fn debug_override() -> Option<OsString> {
    None
}

/// The pure half of [`data_root`]: pick the override or the default, insist
/// on an absolute path, and make sure the directory exists.
pub fn resolve(
    override_: Option<OsString>,
    default: impl FnOnce() -> Result<PathBuf>,
) -> Result<PathBuf> {
    let root = match override_ {
        Some(value) => PathBuf::from(value),
        None => default()?,
    };
    /* BOTH branches: the documented invariant is about the root, not about
     * where it came from. A relative default would be created against the
     * process's working directory — a different library per launch dir. */
    if !root.is_absolute() {
        return Err(Error::NotAbsolute(root));
    }
    std::fs::create_dir_all(&root).map_err(Error::Io)?;
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_must_be_absolute() {
        let err = resolve(Some(OsString::from("relative/dir")), || {
            unreachable!("default must not be consulted when the override is set")
        })
        .unwrap_err();
        assert!(matches!(err, Error::NotAbsolute(_)), "{err}");
    }

    #[test]
    fn override_wins_and_is_created() {
        let dir = scratch_dir("override");
        let nested = dir.join("nested").join("root");
        let got = resolve(Some(nested.clone().into_os_string()), || {
            unreachable!("default must not be consulted when the override is set")
        })
        .unwrap();
        assert_eq!(got, nested);
        assert!(nested.is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn default_is_used_when_no_override() {
        let dir = scratch_dir("default");
        let got = resolve(None, || Ok(dir.clone())).unwrap();
        assert_eq!(got, dir);
        assert!(dir.is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A fresh directory under the OS temp dir, unique per test and process,
    /// so parallel tests never share one.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "paper-data-root-{label}-{}-{}",
            std::process::id(),
            std::thread::current()
                .name()
                .unwrap_or("t")
                .replace("::", "-")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }
}
