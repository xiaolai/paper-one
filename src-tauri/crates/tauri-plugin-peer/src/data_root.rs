//! Where Paper's data lives, and the guard that keeps the plugin's file
//! commands inside it.
//!
//! THE ROOT ITSELF IS RESOLVED BY `paper-data-root` — one crate, shared by the
//! app (its library lock), this plugin and `tauri-plugin-inference`, so a test
//! that moves one moves all of them and no capability's removal takes the
//! rule with it. What the override does and does not move is in that crate's
//! header. This file keeps what is this plugin's: the guard.
//!
//! The sync capability asks for the root through `paper_data_root` rather than
//! computing `appDataDir()` itself, so ITS paths agree with this plugin's. The
//! kernel's do not yet — closing that is what would make the override honest.

use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Runtime};

use crate::error::{Error, Result};

/// The debug-only override. Absolute; created if missing. ONE copy, in
/// `paper-data-root`, which the app and every plugin share — see its header.
pub use paper_data_root::TEST_DATA_DIR_ENV;

/// The storage root for this process. Exists on return. Resolved by
/// `paper-data-root`; only the error is this plugin's.
pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    paper_data_root::data_root(app).map_err(Error::from)
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
    /* The ROOT is validated too: an empty or relative root has no components
     * to disagree with, so `starts_with` on it would admit every absolute
     * path — a guard that guards nothing looks exactly like one that works. */
    if !root.is_absolute() {
        return Err(Error::PathNotAbsolute(root.to_path_buf()));
    }
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

    /// The resolver moved to `paper-data-root`; the KINDS the wire sees are
    /// this plugin's, and the mapping is what keeps them where they were.
    #[test]
    fn the_shared_resolvers_failures_keep_this_plugins_kinds() {
        let relative =
            paper_data_root::resolve(Some(std::ffi::OsString::from("relative/dir")), || {
                unreachable!("the override wins")
            })
            .unwrap_err();
        assert_eq!(Error::from(relative).kind(), "dataRootNotAbsolute");
        assert_eq!(
            Error::from(paper_data_root::Error::Io(std::io::Error::other("x"))).kind(),
            "io"
        );
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
        /* A stale directory that CANNOT be removed must fail here, loudly —
         * a test running over leftover state fails somewhere downstream with
         * a message about the wrong thing. Absent is fine. */
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => panic!("could not clear stale scratch {}: {err}", dir.display()),
        }
        dir
    }
}
