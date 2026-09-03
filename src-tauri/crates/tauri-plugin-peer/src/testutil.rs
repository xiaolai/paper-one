//! Shared test scaffolding: scratch directories under the OS temp dir, one
//! per test, removed on drop. Nothing here is compiled into the plugin.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, empty directory that is removed when the guard drops.
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    pub fn new(label: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "tauri-plugin-peer-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

/// A fresh, uniquely named directory that the CALLER owns.
///
/// ⚠️ **THE NAME MUST NOT COME FROM A CLOCK.** Two modules named their scratch
/// directories `<pid>-<SystemTime as_nanos>` on the reasoning that nanoseconds
/// do not repeat. On macOS `SystemTime` has microsecond-ish resolution, and
/// `cargo test` runs the tests in PARALLEL THREADS — so two of them drew the
/// same number, shared one directory, and the `forget` in one wrote a file the
/// `ensure` in the other read as its own. It surfaced once and passed on the
/// next three runs, which is exactly the shape of a bug that gets diagnosed as
/// flakiness and left alone.
///
/// A process-wide counter cannot collide by construction. `scratch_is_unique`
/// below is what stops a clock coming back.
///
/// Unlike `ScratchDir` this returns a bare path with no drop guard — for tests
/// that pass the directory around and would otherwise need a binding kept
/// alive by hand. The temp directory is the OS's to reap.
pub fn scratch(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "tauri-plugin-peer-{label}-{}-{n}",
        std::process::id()
    ));
    /* The guarantee is a FRESH directory. A removal that half-failed and left
     * the directory standing would let `create_dir_all` succeed over an older
     * run's files, and a test would read state it never wrote. */
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => panic!("could not clear {}: {e}", dir.display()),
    }
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn scratch_is_unique_under_the_parallelism_cargo_actually_uses() {
        /* ⚠️ **THE ASSERTION THAT STOPS A CLOCK COMING BACK.** The defect this
        replaces was invisible: a colliding name produced a test that failed
        once and passed on retry, and every reading of that is "flaky". Threads
        rather than a loop, because a loop cannot reproduce it — the collision
        needs two callers inside one clock tick. */
        let paths: HashSet<PathBuf> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..16).map(|_| s.spawn(|| scratch("unique"))).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        assert_eq!(paths.len(), 16, "two callers were handed one directory");
        for p in &paths {
            assert!(p.is_dir(), "{} was not created", p.display());
            let _ = std::fs::remove_dir_all(p);
        }
    }

    #[test]
    fn scratch_does_not_hand_back_a_directory_with_yesterdays_files_in_it() {
        let first = scratch("reused");
        std::fs::write(first.join("stale"), "old").unwrap();
        /* Same label, same process: the counter moves, so this is a different
        directory — and even the same one would have been cleared. */
        let second = scratch("reused");
        assert_ne!(first, second);
        assert!(!second.join("stale").exists());
        let _ = std::fs::remove_dir_all(&first);
        let _ = std::fs::remove_dir_all(&second);
    }
}
