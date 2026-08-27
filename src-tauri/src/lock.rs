//! The data-root lock, held by the app for the life of the process.
//!
//! One library, one writer. `paper` — the command line — takes an advisory
//! lock beside the library before it writes (`src/hosts/node/lock.ts`), and
//! its own header says what it could not fix: THE APP DID NOT TAKE IT. A
//! webview's filesystem is the Tauri fs plugin, which has no exclusive
//! create, so the CLI's "is the app running" question was answered by a
//! `pgrep` for the bundle's executable path — blind to `pnpm app`, the only
//! way this project is run, and `unknown` off macOS, where every CLI write
//! was therefore refused. Two Paper processes over one directory were not
//! excluded at all: no single-instance plugin, and the write queue's lanes
//! are per process, so a trash sweep in one could race a restore in the
//! other. All three are the same missing lock.
//!
//! SAME FILE, SAME RECORD, SAME PROTOCOL as the CLI's, deliberately — one
//! lock, not two that agree until somebody edits one. The record is the JSON
//! `lock.ts` reads (`pid`, `host`, `at`, `command`, `token`), so `paper book
//! add` beside a running app is refused by name: "pid N holds paper.cli.lock
//! (Paper, since …)". The stale-claim dance is the CLI's too, and its
//! comments are the reasoning; they are not repeated here.
//!
//! PUBLISHED BY `link`, NOT BY WRITE-AFTER-CREATE. The CLI opens with `wx`
//! and then writes the record, and a kill between the two leaves a lock file
//! nobody can read — which every later writer treats as held by somebody
//! unnameable, forever. The record is written whole to a private temp name
//! and `hard_link`ed into place: atomic, exclusive on POSIX and NTFS, and the
//! lock file never exists without a readable owner.
//!
//! WINDOWS IS FAIL-CLOSED ON A CRASH. Liveness is `kill(pid, 0)`, which is
//! Unix; without it a lock left by a crashed app is treated as held, and the
//! refusal names the file to delete. A wrong "stale" is two writers; a wrong
//! "held" is a file to remove. The single-instance plugin (WI-20.32) is what
//! makes the second-launch case moot there.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// The CLI's name for it — `LOCK_FILE` in `lock.ts`. One lock.
pub const LOCK_FILE: &str = "paper.cli.lock";

/// Who holds it, as the file records. The CLI's `LockOwner`, field for field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    pub pid: u32,
    pub host: String,
    /// Epoch milliseconds.
    pub at: u64,
    /// What to say holds it — the CLI records its argv; the app records itself.
    pub command: String,
    /// Per acquisition; the only thing `release` compares on.
    pub token: String,
}

/// Why the lock could not be taken.
#[derive(Debug)]
pub enum Refused {
    /// Somebody live holds it, and this is who.
    Held(Owner),
    /// A lock file that will not parse. Fail closed: reclaiming a file we
    /// cannot understand is how one confused writer becomes two.
    Unreadable(PathBuf),
    Io(io::Error),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Held(o) => write!(
                f,
                "pid {} on {} holds the library ({}, since {})",
                o.pid, o.host, o.command, o.at
            ),
            Refused::Unreadable(p) => write!(f, "{} exists and cannot be read", p.display()),
            Refused::Io(e) => write!(f, "{e}"),
        }
    }
}

/// What the reader is shown when the app cannot open its library: a title
/// and a body. Pure, so the words are tested; the dialog is one call.
pub fn refusal_text(refused: &Refused, root: &Path) -> (String, String) {
    let file = root.join(LOCK_FILE);
    match refused {
        Refused::Held(o) => (
            "Paper is already open".to_string(),
            format!(
                "Another process holds this library: {} (pid {}, on {}).\n\nClose it first, then open Paper again.",
                o.command, o.pid, o.host
            ),
        ),
        Refused::Unreadable(_) => (
            "Paper could not open its library".to_string(),
            format!(
                "The lock file could not be read, so it is being treated as held.\n\nIf no other Paper or `paper` is running, delete it and open Paper again:\n{}",
                file.display()
            ),
        ),
        Refused::Io(e) => (
            "Paper could not open its library".to_string(),
            format!("The lock beside the library could not be taken: {e}\n\n{}", file.display()),
        ),
    }
}

impl From<io::Error> for Refused {
    fn from(e: io::Error) -> Self {
        Refused::Io(e)
    }
}

/// The lock, for as long as this value lives. `release` is explicit rather
/// than a `Drop`, because the process ends through `app.exit` after the
/// shutdown handshake and the file must go THEN — not whenever the last
/// reference happens to fall.
#[derive(Debug)]
pub struct DataLock {
    path: PathBuf,
    owner: Owner,
}

impl DataLock {
    pub fn owner(&self) -> &Owner {
        &self.owner
    }

    /// Remove the file — only while it is still OURS. A lock reclaimed as
    /// stale by somebody else belongs to them now.
    pub fn release(&self) {
        if let Some(held) = read_owner(&self.path) {
            if !held.token.is_empty() && held.token == self.owner.token {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

/// Take the lock on `dir`, or say who has it.
///
/// `alive` answers whether a pid on THIS host still runs; injected so a test
/// can hand in a pid it is sure of. The default asks the kernel.
pub fn acquire(dir: &Path, command: &str) -> Result<DataLock, Refused> {
    acquire_with(dir, command, alive)
}

pub fn acquire_with(
    dir: &Path,
    command: &str,
    alive: fn(u32) -> bool,
) -> Result<DataLock, Refused> {
    let path = dir.join(LOCK_FILE);
    let mine = Owner {
        pid: std::process::id(),
        host: hostname(),
        at: now_ms(),
        command: command.to_string(),
        token: fresh_token(),
    };
    // Bounded: every branch below either returns or makes progress on the
    // file, and a loser of the rename race retries once more. A dozen is far
    // past any real contention and turns a bug into an error, not a hang.
    for _ in 0..12 {
        match publish(&path, &mine) {
            Ok(()) => return Ok(DataLock { path, owner: mine }),
            Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e.into()),
            Err(_) => {}
        }
        let Some(held) = read_owner(&path) else {
            return Err(Refused::Unreadable(path));
        };
        if !(held.host == mine.host && !alive(held.pid)) {
            return Err(Refused::Held(held));
        }
        // Stale, and provably ours to clear. CLAIMED BY RENAME, as the CLI
        // does, so two reclaimers cannot both unlink; then read back, so a
        // live lock moved in the gap between two renames is put straight
        // back with `link` — never `rename`, which would replace a third
        // process's lock created meanwhile.
        let aside = dir.join(format!("{LOCK_FILE}.stale-{}", mine.token));
        if fs::rename(&path, &aside).is_err() {
            continue;
        }
        match read_owner(&aside) {
            Some(moved) if moved.token == held.token && moved.pid == held.pid => {
                let _ = fs::remove_file(&aside);
            }
            _ => {
                if fs::hard_link(&aside, &path).is_ok() {
                    let _ = fs::remove_file(&aside);
                }
                // Otherwise somebody holds the name now; the evidence stays
                // under its `.stale-<token>` name and the loop retries.
            }
        }
    }
    Err(Refused::Io(io::Error::other(
        "could not settle the library lock after twelve attempts",
    )))
}

/// Write the record whole under a private name, then `link` it into place.
/// `AlreadyExists` means somebody holds the name; anything else is an I/O
/// failure. The temp name is removed either way.
fn publish(path: &Path, owner: &Owner) -> io::Result<()> {
    let tmp = path.with_file_name(format!(".{LOCK_FILE}.{}", owner.token));
    let bytes = serde_json::to_vec(owner).map_err(io::Error::other)?;
    fs::write(&tmp, bytes)?;
    let linked = fs::hard_link(&tmp, path);
    let _ = fs::remove_file(&tmp);
    linked
}

/// The record, or None for a file that is absent OR will not parse — the
/// caller tells the two apart with `exists`, and treats the second as held.
pub fn read_owner(path: &Path) -> Option<Owner> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Owner>(&text).ok()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Unique per acquisition within this process, and across processes by the
/// pid: the point is that two locks taken by one process never carry the same
/// token, which pid + time alone could not promise.
fn fresh_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, n)
}

/// The same string Node's `os.hostname()` returns, so a record the CLI wrote
/// and one the app wrote compare equal on `host`.
#[cfg(unix)]
fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: `buf` is a valid, writable buffer of the length passed, and
    // `gethostname` writes at most that many bytes.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(not(unix))]
fn hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// Does `pid` still run? Signal 0 tests for existence without delivering
/// anything; EPERM means it exists and is somebody else's — alive, and not
/// ours to reclaim. Only ESRCH is "no such process".
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: `kill` with signal 0 delivers nothing; it only checks.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// No liveness check without `kill`: a lock that exists is held. Fail closed
/// — see the module note.
#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("paper-lock-{name}-{}", fresh_token()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn live(_: u32) -> bool {
        true
    }
    fn dead(_: u32) -> bool {
        false
    }

    #[test]
    fn the_record_is_the_one_the_cli_reads() {
        let dir = scratch("shape");
        let lock = acquire(&dir, "Paper").unwrap();
        let text = fs::read_to_string(dir.join(LOCK_FILE)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        for key in ["pid", "host", "at", "command", "token"] {
            assert!(json.get(key).is_some(), "record lacks {key}");
        }
        assert_eq!(json["pid"], std::process::id());
        assert_eq!(json["command"], "Paper");
        assert_eq!(json["token"], lock.owner().token);
        // Published whole: the file never exists without a readable owner.
        assert!(read_owner(&dir.join(LOCK_FILE)).is_some());
        lock.release();
        assert!(!dir.join(LOCK_FILE).exists());
    }

    #[test]
    fn a_second_holder_is_refused_by_name_while_the_first_lives() {
        let dir = scratch("twice");
        let first = acquire_with(&dir, "Paper", live).unwrap();
        match acquire_with(&dir, "paper book add", live) {
            Err(Refused::Held(owner)) => {
                assert_eq!(owner.pid, std::process::id());
                assert_eq!(owner.command, "Paper");
            }
            other => panic!("expected Held, got {other:?}"),
        }
        first.release();
        // And free once it lets go.
        assert!(acquire_with(&dir, "paper book add", live).is_ok());
    }

    #[test]
    fn a_stale_lock_on_this_host_is_reclaimed_and_a_live_one_is_not() {
        let dir = scratch("stale");
        let stale = Owner {
            pid: 4_000_000,
            host: hostname(),
            at: 1,
            command: "a crashed paper".into(),
            token: "old".into(),
        };
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&stale).unwrap()).unwrap();
        // Judged live: refused, whatever the pid.
        assert!(matches!(
            acquire_with(&dir, "Paper", live),
            Err(Refused::Held(_))
        ));
        // Judged dead: reclaimed, and the new record is ours.
        let lock = acquire_with(&dir, "Paper", dead).unwrap();
        assert_eq!(
            read_owner(&dir.join(LOCK_FILE)).unwrap().token,
            lock.owner().token
        );
        assert!(!dir
            .join(format!("{LOCK_FILE}.stale-{}", lock.owner().token))
            .exists());
    }

    #[test]
    fn a_lock_from_another_host_is_never_reclaimed() {
        let dir = scratch("elsewhere");
        let theirs = Owner {
            pid: 1,
            host: "some-other-machine.local".into(),
            at: 1,
            command: "paper".into(),
            token: "t".into(),
        };
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&theirs).unwrap()).unwrap();
        assert!(matches!(
            acquire_with(&dir, "Paper", dead),
            Err(Refused::Held(_))
        ));
    }

    #[test]
    fn an_unreadable_lock_is_held_by_somebody_unnameable() {
        let dir = scratch("junk");
        fs::write(dir.join(LOCK_FILE), b"{").unwrap();
        assert!(matches!(
            acquire_with(&dir, "Paper", dead),
            Err(Refused::Unreadable(_))
        ));
    }

    #[test]
    fn release_leaves_a_lock_that_is_no_longer_ours() {
        let dir = scratch("release");
        let mine = acquire_with(&dir, "Paper", live).unwrap();
        let theirs = Owner {
            token: "not-mine".into(),
            ..mine.owner().clone()
        };
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&theirs).unwrap()).unwrap();
        mine.release();
        assert!(
            dir.join(LOCK_FILE).exists(),
            "released somebody else's lock"
        );
    }

    #[test]
    fn the_refusal_names_the_holder_or_the_file() {
        let root = Path::new("/tmp/paper");
        let held = Refused::Held(Owner {
            pid: 42,
            host: "mac.local".into(),
            at: 1,
            command: "paper book add".into(),
            token: "t".into(),
        });
        let (title, body) = refusal_text(&held, root);
        assert_eq!(title, "Paper is already open");
        assert!(
            body.contains("paper book add") && body.contains("pid 42"),
            "{body}"
        );
        let (_, body) = refusal_text(&Refused::Unreadable(root.join(LOCK_FILE)), root);
        assert!(body.contains("/tmp/paper/paper.cli.lock"), "{body}");
    }

    #[cfg(unix)]
    #[test]
    fn liveness_asks_the_kernel() {
        assert!(alive(std::process::id()));
        let mut child = Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!alive(pid), "a reaped child is not alive");
    }
}
