//! Where Paper's data lives, and the guard that keeps the plugin's file
//! commands inside it.
//!
//! The root is `app_data_dir()` — `$APPDATA`, the same root the fs plugin's
//! ACL scope is written against — except in debug builds, where
//! `PAPER_TEST_DATA_DIR` overrides it. That override is what lets two
//! instances of the app run side by side against two disjoint stores (the
//! two-instance sync harness) and lets a test point the app at a scratch
//! directory. It is compiled out of release builds: `cfg!(debug_assertions)`,
//! not a runtime check, so a release binary never consults the environment.
//!
//! The TypeScript side asks for the root through `paper_data_root` rather
//! than computing `appDataDir()` itself, so both halves agree by construction.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{Error, Result};

/// The debug-only override. Absolute; created if missing.
pub const TEST_DATA_DIR_ENV: &str = "PAPER_TEST_DATA_DIR";

/// The storage root for this process. Exists on return.
pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    resolve(debug_override(), || {
        app.path().app_data_dir().map_err(Error::from)
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
fn resolve(
    override_: Option<OsString>,
    default: impl FnOnce() -> Result<PathBuf>,
) -> Result<PathBuf> {
    let root = match override_ {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(Error::DataRootNotAbsolute(path));
            }
            path
        }
        None => default()?,
    };
    std::fs::create_dir_all(&root)?;
    Ok(root)
}

/// Refuse anything that is not lexically inside `root`.
///
/// Three checks, in this order, each with its own error kind so the caller
/// learns which rule it broke:
///
/// 1. absolute — a relative path would be resolved against whatever the
///    process's working directory happens to be;
/// 2. no `..` — `<root>/../elsewhere` starts with `root` as a string and as
///    components, and still leaves it;
/// 3. component-wise prefix — `starts_with` on `Path`, not on `str`, so
///    `/root2/x` does not pass for `/root`.
///
/// This is the lexical guard only. [`checked_target`] adds the symlink check,
/// which needs the filesystem.
pub fn guard_inside_root(root: &Path, path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::PathNotAbsolute(path.to_path_buf()));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::PathNotNormalized(path.to_path_buf()));
    }
    if !path.starts_with(root) {
        return Err(Error::PathOutsideDataRoot {
            path: path.to_path_buf(),
            root: root.to_path_buf(),
        });
    }
    Ok(())
}

/// The full guard: lexical, then with symlinks resolved. Returns the
/// canonical path to operate on, so a symlink planted inside the root that
/// points outside it cannot get a file outside the root touched.
///
/// Both sides are canonicalized, because the root itself may sit behind a
/// symlink (`/tmp` is `/private/tmp` on macOS) and the caller's path will
/// have been built from the uncanonicalized root `paper_data_root` returned.
pub fn checked_target(root: &Path, path: &Path) -> Result<PathBuf> {
    guard_inside_root(root, path)?;
    let canonical_root = root.canonicalize()?;
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&canonical_root) {
        return Err(Error::PathOutsideDataRoot {
            path: path.to_path_buf(),
            root: root.to_path_buf(),
        });
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\paper\data")
        } else {
            PathBuf::from("/paper/data")
        }
    }

    fn kind(result: Result<()>) -> &'static str {
        match result {
            Ok(()) => "ok",
            Err(err) => err.kind(),
        }
    }

    #[test]
    fn accepts_a_path_inside_the_root() {
        let inside = root().join("books").join("a").join("marks.json");
        assert_eq!(kind(guard_inside_root(&root(), &inside)), "ok");
    }

    #[test]
    fn accepts_the_root_itself() {
        // fsync of the root directory persists a rename inside it.
        assert_eq!(kind(guard_inside_root(&root(), &root())), "ok");
    }

    #[test]
    fn rejects_a_relative_path() {
        let relative = Path::new("books").join("a");
        assert_eq!(
            kind(guard_inside_root(&root(), &relative)),
            "pathNotAbsolute"
        );
    }

    #[test]
    fn rejects_dot_dot_even_when_the_prefix_matches() {
        let sneaky = root().join("..").join("elsewhere");
        assert_eq!(
            kind(guard_inside_root(&root(), &sneaky)),
            "pathNotNormalized"
        );
    }

    #[test]
    fn rejects_a_path_outside_the_root() {
        let outside = if cfg!(windows) {
            PathBuf::from(r"C:\other\file")
        } else {
            PathBuf::from("/other/file")
        };
        assert_eq!(
            kind(guard_inside_root(&root(), &outside)),
            "pathOutsideDataRoot"
        );
    }

    #[test]
    fn rejects_a_sibling_whose_name_extends_the_root() {
        // `/paper/data2/x` starts with `/paper/data` as a string. It must not
        // pass as a path.
        let mut sibling = root().into_os_string();
        sibling.push("2");
        let sibling = PathBuf::from(sibling).join("x");
        assert_eq!(
            kind(guard_inside_root(&root(), &sibling)),
            "pathOutsideDataRoot"
        );
    }

    #[test]
    fn override_must_be_absolute() {
        let err = resolve(Some(OsString::from("relative/dir")), || {
            unreachable!("default must not be consulted when the override is set")
        })
        .unwrap_err();
        assert_eq!(err.kind(), "dataRootNotAbsolute");
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

    #[cfg(unix)]
    #[test]
    fn checked_target_refuses_a_symlink_that_leaves_the_root() {
        let dir = scratch_dir("symlink");
        let root = dir.join("root");
        let outside = dir.join("outside.txt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, b"x").unwrap();
        let link = root.join("escape.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let err = checked_target(&root, &link).unwrap_err();
        assert_eq!(err.kind(), "pathOutsideDataRoot");

        let real = root.join("real.txt");
        std::fs::write(&real, b"y").unwrap();
        let canonical = checked_target(&root, &real).unwrap();
        assert!(canonical.ends_with("real.txt"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn checked_target_reports_a_missing_file_as_io() {
        let dir = scratch_dir("missing");
        std::fs::create_dir_all(&dir).unwrap();
        let err = checked_target(&dir, &dir.join("nope.txt")).unwrap_err();
        assert_eq!(err.kind(), "io");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A fresh directory under the OS temp dir, unique per test and process,
    /// so parallel tests never share one.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tauri-plugin-peer-{label}-{}-{}",
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
