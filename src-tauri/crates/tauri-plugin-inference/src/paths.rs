//! Where the runtime, its cache and the reader's models live.
//!
//! Four directories, all under the app data root, all owned by Paper:
//!
//! ```text
//! <data root>/
//!   inference/
//!     runtime/      LEMONADE_CACHE_DIR — the daemon's scratch and config.json
//!     models/       models_dir — the artifacts the reader downloaded
//!     staging/      partial downloads, promoted only after verification
//! ```
//!
//! **Models are NOT inside the cache**, and the split is not tidiness.
//! `runtime/` is scratch the daemon rewrites and Paper may delete to fix a
//! bad state; `models/` holds gigabytes the reader waited for and the
//! settings pane offers to `[Reveal]`. Putting the second inside the first
//! makes "clear the cache" and "throw away the download" the same gesture.
//!
//! `staging/` is what makes WI-15.2's acceptance — *"killing the daemon
//! mid-download leaves no partially active artifact"* — true by construction
//! rather than by a cleanup pass: bytes land there, the digest is checked
//! there, and only a verified file is renamed into `models/`. A crash leaves
//! rubbish in `staging/`, which is nobody's activation slot.
//!
//! The root is asked of the peer plugin's `data_root` equivalent rather than
//! recomputed, for the reason `sync/index.ts` gives at length: a debug build
//! may be pointed at `PAPER_TEST_DATA_DIR`, and two answers to "where is the
//! data root" is one answer too many.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{Error, Result};

/// The debug-only override — ONE copy, in `paper-data-root`, shared with the
/// app and `tauri-plugin-peer`, so a test that moves one root moves all of
/// them. It used to be a second copy here, "shared BY NAME".
pub use paper_data_root::TEST_DATA_DIR_ENV;

/// The subdirectory this plugin owns under the data root.
pub const INFERENCE_DIR: &str = "inference";

/// The four directories, resolved. Every one exists on return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// `<data root>/inference`
    pub base: PathBuf,
    /// `LEMONADE_CACHE_DIR` — scratch, deletable.
    pub cache_dir: PathBuf,
    /// `models_dir` — the reader's artifacts.
    pub models_dir: PathBuf,
    /// Partial downloads, promoted only after verification.
    pub staging_dir: PathBuf,
}

impl Layout {
    /// The layout under `root`, pure — no directory is created. [`ensure`]
    /// is the half that touches the filesystem.
    pub fn under(root: &Path) -> Layout {
        let base = root.join(INFERENCE_DIR);
        Layout {
            cache_dir: base.join("runtime"),
            models_dir: base.join("models"),
            staging_dir: base.join("staging"),
            base,
        }
    }

    /// Create every directory. Idempotent.
    pub fn ensure(&self) -> Result<()> {
        // NOT the cache dir: WI-15.0's first acceptance line is that the
        // daemon starts from a directory that did not exist, and creating it
        // here would make that test prove nothing. The daemon makes its own.
        std::fs::create_dir_all(&self.base)?;
        std::fs::create_dir_all(&self.models_dir)?;
        std::fs::create_dir_all(&self.staging_dir)?;
        Ok(())
    }

    /// Where a model's artifact lives once it has been verified.
    ///
    /// `id` is a manifest id, and the manifest is Paper's own file — but it
    /// is still checked here, because a manifest is a file on disk and a file
    /// on disk can be hand-edited into `../../..`.
    pub fn model_path(&self, id: &str, file: &str) -> Result<PathBuf> {
        Ok(self
            .models_dir
            .join(safe_component(id)?)
            .join(safe_component(file)?))
    }

    /// Where a model's bytes land while they are still arriving.
    pub fn staging_path(&self, id: &str, file: &str) -> Result<PathBuf> {
        let name = format!("{}-{}", safe_component(id)?, safe_component(file)?);
        Ok(self.staging_dir.join(name))
    }
}

/// A single path component from a closed alphabet.
///
/// `[A-Za-z0-9._-]`, non-empty, bounded, and never `.` or `..`. The same
/// shape and the same reasoning as the kernel's `BLOB_FOLDER`: a name, not a
/// path, so there is nothing to traverse with.
pub fn safe_component(name: &str) -> Result<&str> {
    let ok = !name.is_empty()
        && name.len() <= 120
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if ok {
        Ok(name)
    } else {
        Err(Error::ModelUnknown(name.to_owned()))
    }
}

/// The storage root for this process. Exists on return. Resolved by
/// `paper-data-root`; only the error is this plugin's.
pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    paper_data_root::data_root(app).map_err(Error::from)
}

/// The `lemond` Paper ships, beside the app's own executable.
///
/// RESOLVED FROM THE BUNDLE, NEVER FROM `PATH`. WI-15.10 states the rule for
/// the agent probes and it applies with more force here: a `PATH` lookup is
/// the reader's shell deciding which binary Paper supervises, and this one is
/// handed a bearer token and a control plane that installs backends. If the
/// bundled file is missing the answer is [`Error::RuntimeMissing`] — never a
/// fallback to whatever else answers to the name.
pub fn bundled_runtime<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(Error::from)?
        .join("runtime");
    let exe = dir.join(runtime_exe_name());
    if exe.is_file() {
        Ok(exe)
    } else {
        Err(Error::RuntimeMissing(exe))
    }
}

/// `lemond`, plus the extension Windows needs.
pub const fn runtime_exe_name() -> &'static str {
    if cfg!(windows) {
        "lemond.exe"
    } else {
        "lemond"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_are_not_inside_the_cache() {
        let layout = Layout::under(Path::new("/data/Paper"));
        assert!(
            !layout.models_dir.starts_with(&layout.cache_dir),
            "clearing the cache must not be the same gesture as throwing away a 2.4 GB download"
        );
        assert_eq!(
            layout.cache_dir,
            PathBuf::from("/data/Paper/inference/runtime")
        );
        assert_eq!(
            layout.models_dir,
            PathBuf::from("/data/Paper/inference/models")
        );
    }

    #[test]
    fn staging_is_outside_the_activation_slot() {
        let layout = Layout::under(Path::new("/data/Paper"));
        assert!(
            !layout.staging_dir.starts_with(&layout.models_dir),
            "a half-written file under models/ would be a partially active artifact"
        );
    }

    #[test]
    fn ensure_does_not_create_the_cache_dir() {
        let tmp = crate::testutil::ScratchDir::new("x");
        let layout = Layout::under(tmp.path());
        layout.ensure().unwrap();
        assert!(layout.models_dir.is_dir());
        assert!(layout.staging_dir.is_dir());
        assert!(
            !layout.cache_dir.exists(),
            "WI-15.0 acceptance: the daemon must start from a directory that did not exist"
        );
    }

    #[test]
    fn a_model_id_cannot_traverse() {
        let layout = Layout::under(Path::new("/data/Paper"));
        for bad in ["..", ".", "", "a/b", "../../etc/passwd", "a\\b", "a b"] {
            assert!(
                layout.model_path(bad, "model.gguf").is_err(),
                "{bad:?} should be refused"
            );
        }
        assert!(layout
            .model_path("qwen3-4b-instruct-q4", "model.gguf")
            .is_ok());
    }

    #[test]
    fn a_file_name_cannot_traverse_either() {
        let layout = Layout::under(Path::new("/data/Paper"));
        assert!(layout.model_path("qwen3", "../../../etc/passwd").is_err());
        assert!(layout.staging_path("qwen3", "..").is_err());
    }

    /// The resolver moved to `paper-data-root`; what is this plugin's is the
    /// KIND the wire sees, and that must not have moved with it.
    #[test]
    fn a_relative_root_is_refused_under_this_plugins_kind() {
        let err = Error::from(
            paper_data_root::resolve(Some(std::ffi::OsString::from("relative/path")), || {
                unreachable!("the override wins")
            })
            .unwrap_err(),
        );
        assert_eq!(err.kind(), "rootNotAbsolute");
    }

    #[test]
    fn the_runtime_name_carries_the_windows_extension() {
        let name = runtime_exe_name();
        if cfg!(windows) {
            assert_eq!(name, "lemond.exe");
        } else {
            assert_eq!(name, "lemond");
        }
    }
}
