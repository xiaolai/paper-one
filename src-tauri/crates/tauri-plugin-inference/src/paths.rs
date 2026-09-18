//! Where the reader's models live, and where the runtime is.
//!
//! Three directories under the app data root, all owned by Paper:
//!
//! ```text
//! <data root>/
//!   inference/
//!     models/       the artifacts the reader downloaded
//!     staging/      partial downloads, promoted only after verification
//!     daemon.json   the running server's process-group record (lineage.rs)
//! ```
//!
//! ⚠️ **THERE WAS A FOURTH, `runtime/`, AND NOTHING WRITES IT NOW.** It was
//! `LEMONADE_CACHE_DIR` — lemond's scratch and the `config.json` Paper wrote
//! before every launch — and `llama-server`, launched on one verified file with
//! `--offline`, has no cache to keep. A machine that ran a lemond-era build
//! still has the directory; it is small, and nothing reads it.
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

/// The directories, RESOLVED — not created. `under` is pure; `ensure` creates
/// every one of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// `<data root>/inference`
    pub base: PathBuf,
    /// The reader's artifacts.
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
            models_dir: base.join("models"),
            staging_dir: base.join("staging"),
            base,
        }
    }

    /// Create every directory. Idempotent.
    pub fn ensure(&self) -> Result<()> {
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
    ///
    /// NESTED, not joined with a separator: `("a-b", "c")` and `("a", "b-c")`
    /// flattened to the same `a-b-c`, so two distinct models' downloads could
    /// overwrite or resume each other's partial bytes. Both halves are
    /// validated single components, so the nesting cannot traverse.
    pub fn staging_path(&self, id: &str, file: &str) -> Result<PathBuf> {
        Ok(self
            .staging_dir
            .join(safe_component(id)?)
            .join(safe_component(file)?))
    }

    /// The server's process-group record — `lineage.rs`. Under `base`, beside
    /// the models and nowhere Paper would clear to fix a bad state, because
    /// the record is what makes the next launch able to collect a server the
    /// last one left running.
    pub fn daemon_record(&self) -> PathBuf {
        crate::lineage::record_path(&self.base)
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

/// The runtime this build ships, as its MANIFEST — the file that names the
/// server and vouches for every byte beside it (`runtime.rs`).
///
/// RESOLVED FROM THE BUNDLE, NEVER FROM `PATH`. WI-15.10 states the rule for
/// the agent probes and it applies with more force here: a `PATH` lookup is
/// the reader's shell deciding which binary Paper supervises. If the manifest
/// is missing the answer is [`Error::RuntimeMissing`] — never a fallback to
/// whatever else answers to the name.
///
/// ⚠️ **THE MANIFEST, NOT AN EXECUTABLE, IS WHAT "PRESENT" MEANS NOW.** This
/// looked for `lemond[.exe]`; the program Paper launches is whatever the
/// manifest's `llamacpp.server` names, and nothing launches without the
/// manifest verifying first — so a tree with a server and no manifest is not a
/// runtime this build can use, and saying "present" of it would offer a local
/// model that fails at the question.
pub fn bundled_runtime<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let manifest = bundled_runtime_dir(app)?.join(crate::runtime::MANIFEST_FILE);
    /* `metadata`, not `is_file`: `is_file()` folds EVERY failure — a
     * permission refusal, an I/O error — into `false`, and the reader was
     * then told the runtime is not installed when the truth was that Paper
     * could not look. Only "not there" is `RuntimeMissing`. */
    match std::fs::metadata(&manifest) {
        Ok(meta) if meta.is_file() => Ok(manifest),
        Ok(_) => Err(Error::RuntimeMissing(manifest)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Err(Error::RuntimeMissing(manifest))
        }
        Err(err) => Err(Error::Io(err)),
    }
}

/// The staged runtime directory: the llama.cpp build under
/// `backend/llamacpp/<name>/`, and the manifest that vouches for all of it
/// (`runtime.rs`). `bundle.resources` in `tauri.conf.json` copies
/// `vendor/inference/current/` here as `runtime/`.
pub fn bundled_runtime_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app
        .path()
        .resource_dir()
        .map_err(Error::from)?
        .join("runtime"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_models_live_under_the_inference_directory() {
        let layout = Layout::under(Path::new("/data/Paper"));
        assert_eq!(layout.base, PathBuf::from("/data/Paper/inference"));
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
    fn ensure_creates_every_directory_and_is_idempotent() {
        let tmp = crate::testutil::ScratchDir::new("x");
        let layout = Layout::under(tmp.path());
        layout.ensure().unwrap();
        layout.ensure().unwrap();
        assert!(layout.base.is_dir());
        assert!(layout.models_dir.is_dir());
        assert!(layout.staging_dir.is_dir());
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
}
