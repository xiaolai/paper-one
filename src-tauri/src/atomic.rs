//! Durable writes for the kernel: one command that does the whole atomic
//! write, and one that syncs a file the kernel already wrote.
//!
//! THE VAULT'S WRITE PATH HAD NO FSYNC. `vaultFsTauri.ts` wrote a temp file
//! through the fs plugin and renamed it; the fs plugin's `write_file` returns
//! when the bytes are handed to the OS, not when they are on disk, and the
//! plugin has no fsync at all. A power loss after the rename could leave an
//! empty `book.json` — which `scanFolder` skips, so the book vanished from
//! the shelf. In the ext4 documentation's words, "broken applications".
//!
//! WHAT THE LITERATURE PRESCRIBES, and this does: write, fsync the file,
//! rename, fsync the directory (Pillai et al., OSDI 2014; SQLite; PostgreSQL's
//! `durable_rename`). The application libraries — `write-file-atomic`,
//! `renameio`, VS Code, Chromium's `ImportantFileWriter` — fsync the file and
//! skip the directory; the directory sync is here because it is the half that
//! makes the RENAME durable, and it is ignored where the filesystem refuses
//! it (`EINVAL`, `ENOTSUP`), as PostgreSQL and SQLite do.
//!
//! TWO LEVELS, because macOS's `fsync(2)` does not do what its name says: it
//! hands the data to the drive without waiting for the drive's own cache.
//! `Full` is `F_FULLFSYNC` — the one that survives a power cut, which SQLite
//! calls "profoundly slow" and is what `book.json`, `marks.json`, the index
//! and the sync journal get. `Barrier` is `F_BARRIERFSYNC`, Chromium's and
//! libuv's choice after experiment "showed no detectable sign of increased
//! corruption": ordered, not waited for — what the 2-second position tick
//! gets, since a position lost to a power cut is a page, not a book. Off
//! macOS both are `fsync`. Each falls back to `fsync` where the filesystem
//! refuses the fcntl.
//!
//! ONE APP-CRATE COMMAND, not a plugin's. The peer plugin used to carry an
//! `fs_fsync` for the sync journal, and the kernel reached it through the
//! capability's port — a kernel that calls a removable capability's command
//! by string is a kernel that stops flushing when the capability is removed.
//! `open_external` is the precedent for a bare app command: reachable the
//! moment it is registered, which is why it confines its own argument rather
//! than trusting the caller — see `confined`.
//!
//! THE ROOT IS THE FS PLUGIN'S `BaseDirectory.AppData`, deliberately — the
//! kernel reads every file it writes back through that plugin, so a write
//! that landed anywhere else would be a write the kernel could not read.
//! `paper_data_root` differs from it only under the debug override, which
//! moves the peer plugin's files and not the kernel's (the trap WI-8.6
//! recorded); the lock lives beside the former, and that discrepancy is
//! noted, not hidden.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

/// How hard to sync — see the module note.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Full,
    Barrier,
}

impl Level {
    /// The header spelling: what `vaultFsTauri.ts` sends.
    fn parse(text: &str) -> Option<Level> {
        match text {
            "full" => Some(Level::Full),
            "barrier" => Some(Level::Barrier),
            _ => None,
        }
    }
}

/// Where a temp file and its rename are synced; injected so a test can
/// record the sequence a real write performs without a real disk.
pub trait Syncer {
    fn sync_file(&self, file: &File, level: Level) -> io::Result<()>;
    fn sync_dir(&self, dir: &Path) -> io::Result<()>;
}

/// The operating system.
pub struct Os;

impl Syncer for Os {
    fn sync_file(&self, file: &File, level: Level) -> io::Result<()> {
        sync_file(file, level)
    }

    fn sync_dir(&self, dir: &Path) -> io::Result<()> {
        sync_dir(dir)
    }
}

/// The root the kernel's files live under. See the module note for why it
/// is the fs plugin's and not `paper_data_root`'s.
fn kernel_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))
}

/// A path the kernel gave us, confined to the root.
///
/// Relative, non-empty, and made of plain components only: no root, no
/// prefix, no `..`, no `.`. A webview command that wrote anywhere it was
/// told would be a hole in the app; this refuses before touching the disk.
pub fn confined(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Err("write_atomic: the path is empty".into());
    }
    let path = Path::new(relative);
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(format!(
                    "write_atomic: {relative} does not stay inside the data directory"
                ))
            }
        }
    }
    Ok(root.join(path))
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `target` so a crash cannot leave half of one, synced at
/// `level`. A temp in the same directory (a rename is atomic only within a
/// filesystem), `write_all`, sync, rename, then the parent directory synced
/// so the rename itself is on disk. The temp name is private to this write
/// — two processes over one library used to share `<name>.writing`, and the
/// loser's bytes were published under the winner's rename.
pub fn write_atomic_at(
    target: &Path,
    bytes: &[u8],
    level: Level,
    syncer: &dyn Syncer,
) -> io::Result<()> {
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            io::Error::other("a file at the filesystem root has no directory to sync")
        })?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::other("the target has no file name"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".{name}.{}.{}.writing",
        std::process::id(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        syncer.sync_file(&file, level)?;
        drop(file);
        fs::rename(&temp, target)?;
        syncer.sync_dir(parent)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Sync a file (or a directory) the kernel already wrote.
pub fn fsync_at(target: &Path, level: Level, syncer: &dyn Syncer) -> io::Result<()> {
    if target.is_dir() {
        return syncer.sync_dir(target);
    }
    let file = File::open(target)?;
    syncer.sync_file(&file, level)
}

#[cfg(target_os = "macos")]
fn sync_file(file: &File, level: Level) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    /// `<sys/fcntl.h>`: not bound by libc.
    const F_BARRIERFSYNC: libc::c_int = 85;
    let command = match level {
        Level::Full => libc::F_FULLFSYNC,
        Level::Barrier => F_BARRIERFSYNC,
    };
    // SAFETY: `fcntl` with a sync command takes no pointer argument and
    // only acts on the descriptor, which `file` keeps open.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), command) };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if refuses_the_fcntl(&err) {
        // A filesystem that does not know the fcntl — a network mount, FAT —
        // gets the ordinary fsync, which is what it can offer.
        // SAFETY: as above.
        let rc = unsafe { libc::fsync(file.as_raw_fd()) };
        return if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
    }
    Err(err)
}

#[cfg(not(target_os = "macos"))]
fn sync_file(file: &File, _level: Level) -> io::Result<()> {
    // `fsync(2)` on Linux waits for the drive; there is no cheaper level.
    // On Windows this is `FlushFileBuffers`.
    file.sync_all()
}

/// The parent's entry for the renamed file, on disk. Ignored where the
/// filesystem refuses (`EINVAL`, `ENOTSUP`) and on Windows, where a
/// directory cannot be opened as a file — the rename is what it is there.
fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let handle = File::open(dir)?;
        // SAFETY: a plain fsync on an open descriptor.
        let rc = unsafe { libc::fsync(handle.as_raw_fd()) };
        if rc == 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if refuses_the_fcntl(&err) {
            return Ok(());
        }
        Err(err)
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

#[cfg(unix)]
fn refuses_the_fcntl(err: &io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(libc::EINVAL) | Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)
    )
}

/// The path header, percent-decoded — `vaultFsTauri.ts` encodes it the way
/// the fs plugin's client does, because HTTP headers carry ASCII and a
/// book's folder may not be.
fn path_header(request: &tauri::ipc::Request<'_>) -> Result<String, String> {
    let raw = request
        .headers()
        .get("path")
        .ok_or_else(|| "write_atomic: missing the path header".to_string())?;
    percent_encoding::percent_decode(raw.as_bytes())
        .decode_utf8()
        .map(|p| p.into_owned())
        .map_err(|_| "write_atomic: the path is not valid UTF-8".to_string())
}

fn level_header(request: &tauri::ipc::Request<'_>) -> Result<Level, String> {
    let raw = request
        .headers()
        .get("level")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "write_atomic: missing the level header".to_string())?;
    Level::parse(raw).ok_or_else(|| format!("write_atomic: unknown sync level {raw:?}"))
}

/// The whole atomic write, as the module note describes. The bytes travel as
/// the request body, the way the fs plugin's `write_file` takes them — a
/// JSON array of numbers is four characters per byte, and an index is a
/// megabyte.
///
/// `async`, so the sync waits on the runtime and never on the main thread:
/// `F_FULLFSYNC` is the slow one by design.
#[tauri::command]
pub async fn write_atomic<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let path = path_header(&request)?;
    let level = level_header(&request)?;
    let target = confined(&kernel_root(&app)?, &path)?;
    let bytes: std::borrow::Cow<'_, [u8]> = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => std::borrow::Cow::Borrowed(data),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(data)) => std::borrow::Cow::Owned(
            data.iter()
                .filter_map(|v| v.as_u64().map(|v| v as u8))
                .collect(),
        ),
        _ => return Err("write_atomic: unexpected invoke body".into()),
    };
    write_atomic_at(&target, &bytes, level, &Os).map_err(|e| format!("write_atomic: {path}: {e}"))
}

/// Sync a file the kernel wrote through the fs plugin — the sync journal's
/// appends, which are not atomic writes and must not be.
#[tauri::command]
pub async fn fsync_in_data_dir<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    level: Level,
) -> Result<(), String> {
    let target = confined(&kernel_root(&app)?, &path)?;
    fsync_at(&target, level, &Os).map_err(|e| format!("fsync: {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::time::Instant;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "paper-atomic-{name}-{}-{}",
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Records what a real write would sync, and in which order.
    #[derive(Default)]
    struct Recording {
        log: RefCell<Vec<String>>,
    }

    impl Syncer for Recording {
        fn sync_file(&self, file: &File, level: Level) -> io::Result<()> {
            // The temp's name is what the descriptor was opened as; the
            // metadata is the only thing a `File` will tell us about it, so
            // the caller's temp is matched by size.
            let len = file.metadata()?.len();
            self.log.borrow_mut().push(format!("file:{len}:{level:?}"));
            Ok(())
        }
        fn sync_dir(&self, dir: &Path) -> io::Result<()> {
            self.log.borrow_mut().push(format!(
                "dir:{}",
                dir.file_name().unwrap().to_string_lossy()
            ));
            Ok(())
        }
    }

    #[test]
    fn a_write_syncs_the_temp_before_the_rename_and_the_directory_after() {
        let dir = scratch("order");
        let target = dir.join("books").join("b").join("book.json");
        let recording = Recording::default();
        write_atomic_at(
            &target,
            b"{\"position\":\"p2\"}",
            Level::Barrier,
            &recording,
        )
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"{\"position\":\"p2\"}");
        assert_eq!(
            *recording.log.borrow(),
            vec!["file:17:Barrier".to_string(), "dir:b".to_string()],
            "the file is synced before the rename publishes it, the directory after"
        );
        // No temp left beside it.
        let left: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".writing"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn a_write_replaces_whole_and_never_leaves_half() {
        let dir = scratch("replace");
        let target = dir.join("index.json");
        write_atomic_at(&target, b"first", Level::Full, &Os).unwrap();
        write_atomic_at(&target, b"second and longer", Level::Full, &Os).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second and longer");
    }

    #[test]
    fn a_write_that_fails_leaves_no_temp() {
        struct Refusing;
        impl Syncer for Refusing {
            fn sync_file(&self, _: &File, _: Level) -> io::Result<()> {
                Err(io::Error::other("disk full"))
            }
            fn sync_dir(&self, _: &Path) -> io::Result<()> {
                Ok(())
            }
        }
        let dir = scratch("fail");
        let target = dir.join("book.json");
        let err = write_atomic_at(&target, b"x", Level::Full, &Refusing).unwrap_err();
        assert_eq!(err.to_string(), "disk full");
        assert!(
            !target.exists(),
            "the target must not exist after a failed write"
        );
        let left: Vec<_> = fs::read_dir(&dir).unwrap().collect();
        assert!(left.is_empty(), "a failed write left {left:?}");
    }

    #[test]
    fn the_path_is_confined_to_the_root() {
        let root = Path::new("/data/paper");
        assert_eq!(
            confined(root, "books/b/book.json").unwrap(),
            root.join("books/b/book.json")
        );
        for bad in [
            "",
            "/etc/passwd",
            "../outside",
            "books/../../x",
            "./index.json",
        ] {
            assert!(confined(root, bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn both_levels_sync_a_real_file_here() {
        let dir = scratch("levels");
        for level in [Level::Full, Level::Barrier] {
            let target = dir.join(format!("{level:?}.json"));
            write_atomic_at(&target, b"{}", level, &Os).unwrap();
            fsync_at(&target, level, &Os).unwrap();
        }
        fsync_at(&dir, Level::Full, &Os).unwrap();
    }

    #[test]
    fn the_level_header_is_the_two_spellings_and_nothing_else() {
        assert_eq!(Level::parse("full"), Some(Level::Full));
        assert_eq!(Level::parse("barrier"), Some(Level::Barrier));
        assert_eq!(Level::parse("Full"), None);
        assert_eq!(Level::parse(""), None);
    }

    /// `F_FULLFSYNC` latency on this machine, for one `book.json`-sized write
    /// under `$HOME`'s volume (`/tmp` is a different volume with different
    /// numbers). By hand: `cargo test -p app -- --ignored fullfsync --nocapture`.
    /// The decision it informs: `Full` on anything written every two seconds.
    #[test]
    #[ignore]
    fn fullfsync_latency_on_this_machine() {
        let home = std::env::var_os("HOME").expect("HOME");
        let dir = PathBuf::from(home).join(".paper-atomic-latency");
        fs::create_dir_all(&dir).unwrap();
        let body = vec![b'x'; 4 * 1024];
        for level in [Level::Full, Level::Barrier] {
            let target = dir.join(format!("{level:?}.json"));
            let mut samples = Vec::new();
            for _ in 0..20 {
                let started = Instant::now();
                write_atomic_at(&target, &body, level, &Os).unwrap();
                samples.push(started.elapsed());
            }
            samples.sort();
            eprintln!(
                "{level:?}: median {:?}, max {:?} over {} writes of {} bytes",
                samples[samples.len() / 2],
                samples[samples.len() - 1],
                samples.len(),
                body.len()
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
