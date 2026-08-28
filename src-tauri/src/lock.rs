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
//! `lock.ts` reads (`pid`, `host`, `at`, `command`, `token`, and since
//! WI-20.34 `startedAt` and `bootedAt`), so `paper book add` beside a running
//! app is refused by name: "pid N holds paper.cli.lock (Paper, since …)". The
//! stale-claim dance is the CLI's too, and its comments are the reasoning;
//! they are not repeated here.
//!
//! PUBLISHED BY `link`, NOT BY WRITE-AFTER-CREATE. The CLI used to open with
//! `wx` and then write the record, and a kill between the two left a lock
//! file nobody could read — which every later writer treated as held by
//! somebody unnameable, forever. Both sides now write the record whole to a
//! private temp name and `hard_link` it into place: atomic, exclusive on
//! POSIX and NTFS, and the lock file never exists without a readable owner.
//! Which is also why an EMPTY lock file is reclaimable by construction: the
//! protocol cannot produce one, so it is the old protocol's crash window,
//! and refusing it would lock the library until a human deleted a file.
//!
//! A PID IS NOT AN IDENTITY. The kernel hands a dead process's number to
//! the next one, and a machine that rebooted since the record was written
//! has handed out every number again. So the record carries the holder's
//! start time and the host's boot time, and a holder is live only when the
//! pid runs AND the OS's answers can be reconciled with what the record says
//! (`paper-process` is the one lookup, shared with the daemon's lineage
//! record; `Liveness::holds` has the rule and why it is not a plain equality).
//! `None` from the OS cannot refute — the check falls back to the pid alone.
//!
//! WHAT THIS PROTOCOL DOES NOT CLOSE, since an audit finds it every round.
//! Two windows are left, and both are the same shape: a name is read and then
//! ACTED ON, and POSIX has no ownership-conditional unlink to make the pair
//! one step. `release` compares the token and then removes the pathname, so a
//! lock published in that gap would be removed by the previous owner; the
//! stale-claim dance moves a lock aside and links it back, so a third writer
//! taking the name in that gap leaves the displaced owner detached from the
//! canonical lock. NEITHER IS REACHABLE WITHOUT A WRONG "STALE" FIRST — a
//! live holder has to be judged dead before anybody reclaims underneath it —
//! which is why the identity rule above is where the work went. Closing them
//! properly means a different primitive (an `flock`/`fcntl` lease held open),
//! and the CLI half cannot take one: Node has no lock syscall without a
//! native module, and SAME FILE, SAME RECORD, SAME PROTOCOL is the property
//! that makes one lock rather than two.
//!
//! WINDOWS IS FAIL-CLOSED ON A CRASH. Liveness is `kill(pid, 0)`, which is
//! Unix; without it a lock left by a crashed app is treated as held, and the
//! refusal names the file to delete. A wrong "stale" is two writers; a wrong
//! "held" is a file to remove. The single-instance plugin (WI-20.32) is what
//! makes the second-launch case moot there.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The CLI's name for it — `LOCK_FILE` in `lock.ts`. One lock.
pub const LOCK_FILE: &str = "paper.cli.lock";

/// How far a recorded start or boot may sit from the OS's answer and still
/// be the same process. The CLI's record is `Date.now() − uptime`, rounded
/// through seconds; a reused pid is minutes or days away, not seconds.
const IDENTITY_TOLERANCE_MS: u64 = 5_000;

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
    /// When the holder's process started, epoch milliseconds. Absent in a
    /// record written before WI-20.34, or on a platform that cannot say.
    #[serde(default, rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// When the holder's host booted, epoch milliseconds. Same terms.
    #[serde(default, rename = "bootedAt", skip_serializing_if = "Option::is_none")]
    pub booted_at: Option<u64>,
}

/// How the OS is asked whether a recorded holder is still that process.
/// Injected whole so a test can hand in a pid it is sure of and a clock it
/// controls; `Liveness::os()` is what the app uses.
#[derive(Clone, Copy)]
pub struct Liveness {
    /// Does `pid` run at all? Signal 0 on Unix; always `true` elsewhere.
    pub alive: fn(u32) -> bool,
    /// When `pid` started, or `None` when the OS cannot say.
    pub started_at: fn(u32) -> Option<u64>,
    /// When this host booted, or `None` when the OS cannot say.
    pub booted_at: fn() -> Option<u64>,
}

impl Liveness {
    pub fn os() -> Self {
        Liveness {
            alive,
            started_at: paper_process::started_at_ms,
            booted_at: paper_process::booted_at_ms,
        }
    }

    /// Is the recorded holder still the process that wrote the record?
    ///
    /// Pid first; then the START TIME, which is the identity — psutil's rule
    /// and `paper-process`'s header both say so: a pid whose process started
    /// when the record says it did IS that process. The boot time is the
    /// fallback for a record or a platform that cannot answer for the pid.
    /// An absent answer on either side cannot refute and is not read as one.
    ///
    /// ⚠️ EVERY STAMP IN THE RECORD IS WALL CLOCK, AND THE CLOCK MOVES. The
    /// check used to refuse on either stamp disagreeing, which made an NTP
    /// correction of more than the tolerance — a laptop whose clock was
    /// wrong, a VM resumed — read a LIVE holder as stale. That is the
    /// direction the module note calls expensive: two writers over one
    /// library, where the other way round costs a file to delete. What
    /// moves under a correction is not the same on both platforms: macOS
    /// shifts `kern.boottime` and leaves each process's `p_starttime`
    /// alone, while Linux derives BOTH from `/proc/stat`'s `btime`, so they
    /// move together. Hence two ways for a record to still be the holder's —
    /// the start times agree (macOS), or both readings are off by the SAME
    /// amount, which is a clock that moved under a process that did not
    /// (Linux). A pid reused on the same boot moves the start and not the
    /// boot, so it fails both and is still reclaimed.
    ///
    /// ⚠️ THE CLI'S HALF OF THIS IS STILL THE OLD RULE. `lock.ts` refutes on
    /// either stamp, so a `paper` beside a clock correction can still call a
    /// running app stale; the rule belongs there too, in the same words.
    fn holds(&self, held: &Owner) -> bool {
        if !(self.alive)(held.pid) {
            return false;
        }
        let start = shift(held.started_at, (self.started_at)(held.pid));
        let boot = shift(held.booted_at, (self.booted_at)());
        match (start, boot) {
            // The identity, agreeing. Whatever the boot time says, the pid
            // is running the process that wrote the record.
            (Some(start), _) if start.unsigned_abs() <= IDENTITY_TOLERANCE_MS => true,
            // Both readings moved together: the clock, not the process.
            (Some(start), Some(boot)) => start.abs_diff(boot) <= IDENTITY_TOLERANCE_MS,
            // A start time that disagrees with nothing to explain it away.
            (Some(_), None) => false,
            // No start time to be had — the pre-WI-20.34 record, or Windows.
            (None, Some(boot)) => boot.unsigned_abs() <= IDENTITY_TOLERANCE_MS,
            (None, None) => true,
        }
    }
}

/// How far the OS's answer has moved from what the record holds, in
/// milliseconds, or `None` when either side has nothing to say. Signed: a
/// clock corrected backwards is as ordinary as one corrected forwards.
///
/// A stamp too large to be a millisecond epoch answers `None` — "cannot
/// refute", which keeps the lock held rather than reclaiming on arithmetic
/// nobody can trust.
fn shift(recorded: Option<u64>, now: Option<u64>) -> Option<i64> {
    let recorded = i64::try_from(recorded?).ok()?;
    let now = i64::try_from(now?).ok()?;
    Some(now.saturating_sub(recorded))
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
                /* Logged, not discarded: on a platform whose liveness check
                 * cannot reclaim a dead holder (Windows fails closed), a
                 * removal that silently failed leaves the library locked
                 * until a human deletes a file the log never named. */
                if let Err(cause) = fs::remove_file(&self.path) {
                    log::warn!(
                        "lock: could not remove {} on release: {cause}",
                        self.path.display()
                    );
                }
            }
        }
    }
}

/// Take the lock on `dir`, or say who has it.
pub fn acquire(dir: &Path, command: &str) -> Result<DataLock, Refused> {
    acquire_with(dir, command, &Liveness::os())
}

pub fn acquire_with(dir: &Path, command: &str, liveness: &Liveness) -> Result<DataLock, Refused> {
    let path = dir.join(LOCK_FILE);
    let mine = Owner {
        pid: std::process::id(),
        host: hostname(),
        at: paper_process::now_ms(),
        command: command.to_string(),
        token: fresh_token(),
        started_at: paper_process::own_started_at_ms(),
        booted_at: paper_process::booted_at_ms(),
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
        let held = match read_owner(&path) {
            Some(held) => held,
            None if is_empty(&path) => {
                // The old protocol's crash window: created with `wx`, killed
                // before the record was written. `link` cannot leave this
                // shape, so it is provably nobody's. Moved aside and read
                // back, like a stale record, so a lock that appeared under
                // the name between the two looks is put back.
                let aside = dir.join(format!("{LOCK_FILE}.stale-{}", mine.token));
                if fs::rename(&path, &aside).is_err() {
                    continue;
                }
                // Still empty: nobody's, gone. Not empty: a live lock landed
                // under the name in the gap — put it back by `link`, and the
                // aside goes only once the name is taken again.
                if is_empty(&aside) || fs::hard_link(&aside, &path).is_ok() {
                    let _ = fs::remove_file(&aside);
                }
                continue;
            }
            /* Absent is not unreadable: the holder can release between our
             * failed publish and this read, and refusing then would tell the
             * caller a lock nobody holds cannot be read. Gone is a retry. */
            None if !path.exists() => continue,
            None => return Err(Refused::Unreadable(path)),
        };
        if !(held.host == mine.host && !liveness.holds(&held)) {
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

/// A file that exists and holds nothing — see the module note.
fn is_empty(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.len() == 0).unwrap_or(false)
}

/// Unique per acquisition WITHIN THIS PROCESS — the sequence number is what
/// pid + time alone could not promise — and distinct across live processes on
/// one host by the pid. Not a global claim: the token is only ever compared
/// by its own writer (`release`) and used as a private temp-file suffix, and
/// both live on one host.
fn fresh_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
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

    /// A scratch directory that REMOVES ITSELF — tests used to leak one per
    /// run into the system temp directory, recovery artifacts and all.
    /// Derefs to `Path`, so call sites read as before.
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    impl std::ops::Deref for Scratch {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }
    impl AsRef<Path> for Scratch {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("paper-lock-{name}-{}", fresh_token()));
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    /// A pid that runs and an OS with no opinion on identity — the check
    /// the record had before WI-20.34.
    fn live() -> Liveness {
        Liveness {
            alive: |_| true,
            started_at: |_| None,
            booted_at: || None,
        }
    }
    fn dead() -> Liveness {
        Liveness {
            alive: |_| false,
            started_at: |_| None,
            booted_at: || None,
        }
    }

    fn record(pid: u32, host: &str, token: &str) -> Owner {
        Owner {
            pid,
            host: host.into(),
            at: 1,
            command: "a crashed paper".into(),
            token: token.into(),
            started_at: None,
            booted_at: None,
        }
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
        // The two identities, where the OS can say — and as the CLI spells
        // them, camel-cased, so its `readOwner` picks them up.
        if paper_process::own_started_at_ms().is_some() {
            assert!(json["startedAt"].is_u64(), "{text}");
            assert!(json["bootedAt"].is_u64(), "{text}");
        }
        // Published whole: the file never exists without a readable owner,
        // and the private temp name is gone.
        assert!(read_owner(&dir.join(LOCK_FILE)).is_some());
        assert!(!dir
            .join(format!(".{LOCK_FILE}.{}", lock.owner().token))
            .exists());
        lock.release();
        assert!(!dir.join(LOCK_FILE).exists());
    }

    /// The CLI's record from before WI-20.34 — five keys, no identity — still
    /// parses, and is judged on its pid alone.
    #[test]
    fn a_five_key_record_is_still_read() {
        let dir = scratch("five");
        fs::write(
            dir.join(LOCK_FILE),
            br#"{"pid":4000000,"host":"h","at":1,"command":"paper","token":"t"}"#,
        )
        .unwrap();
        let held = read_owner(&dir.join(LOCK_FILE)).unwrap();
        assert_eq!(held.pid, 4_000_000);
        assert_eq!(held.started_at, None);
        assert_eq!(held.booted_at, None);
    }

    #[test]
    fn a_second_holder_is_refused_by_name_while_the_first_lives() {
        let dir = scratch("twice");
        let first = acquire_with(&dir, "Paper", &live()).unwrap();
        match acquire_with(&dir, "paper book add", &live()) {
            Err(Refused::Held(owner)) => {
                assert_eq!(owner.pid, std::process::id());
                assert_eq!(owner.command, "Paper");
            }
            other => panic!("expected Held, got {other:?}"),
        }
        first.release();
        // And free once it lets go.
        assert!(acquire_with(&dir, "paper book add", &live()).is_ok());
    }

    #[test]
    fn a_stale_lock_on_this_host_is_reclaimed_and_a_live_one_is_not() {
        let dir = scratch("stale");
        let stale = record(4_000_000, &hostname(), "old");
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&stale).unwrap()).unwrap();
        // Judged live: refused, whatever the pid.
        assert!(matches!(
            acquire_with(&dir, "Paper", &live()),
            Err(Refused::Held(_))
        ));
        // Judged dead: reclaimed, and the new record is ours.
        let lock = acquire_with(&dir, "Paper", &dead()).unwrap();
        assert_eq!(
            read_owner(&dir.join(LOCK_FILE)).unwrap().token,
            lock.owner().token
        );
        assert!(!dir
            .join(format!("{LOCK_FILE}.stale-{}", lock.owner().token))
            .exists());
    }

    /// A pid that runs is not a holder when the record says it started at
    /// another time — the number was reused. And the same when the host has
    /// booted since. The OS having no answer refutes nothing.
    #[test]
    fn a_running_pid_with_another_start_or_boot_is_not_the_holder() {
        let dir = scratch("identity");
        let mut reused = record(std::process::id(), &hostname(), "old");
        reused.started_at = Some(1_000);
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&reused).unwrap()).unwrap();
        let knows: Liveness = Liveness {
            alive: |_| true,
            started_at: |_| Some(2_000_000_000_000),
            booted_at: || Some(1_900_000_000_000),
        };
        let lock = acquire_with(&dir, "Paper", &knows).expect("a reused pid is not a holder");
        lock.release();

        let mut rebooted = record(std::process::id(), &hostname(), "old");
        rebooted.booted_at = Some(1_000);
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&rebooted).unwrap()).unwrap();
        let lock =
            acquire_with(&dir, "Paper", &knows).expect("a record from an earlier boot is stale");
        lock.release();

        // Same identity, within the tolerance: held.
        let mut same = record(std::process::id(), &hostname(), "old");
        same.started_at = Some(2_000_000_000_000 + 1_500);
        same.booted_at = Some(1_900_000_000_000 - 1_500);
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&same).unwrap()).unwrap();
        assert!(matches!(
            acquire_with(&dir, "Paper", &knows),
            Err(Refused::Held(_))
        ));

        // An OS with no answer cannot refute a record that has one.
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&reused).unwrap()).unwrap();
        assert!(matches!(
            acquire_with(&dir, "Paper", &live()),
            Err(Refused::Held(_))
        ));
    }

    /// A CLOCK CORRECTION IS NOT A DEAD HOLDER — the case that made a live
    /// app's lock reclaimable and put two writers over one library. Both
    /// shapes a correction takes: macOS moves the boot time and leaves the
    /// process's start alone; Linux moves both together. And the pid that
    /// really was reused is still reclaimed across the same correction,
    /// because its start moved by a different amount than the boot did.
    #[test]
    fn a_clock_correction_does_not_make_a_live_holder_stale() {
        const START: u64 = 2_000_000_000_000;
        const BOOT: u64 = 1_900_000_000_000;
        const STEP: u64 = 3_600_000; // an hour, far past the tolerance
        let dir = scratch("clockstep");
        let mut mine = record(std::process::id(), &hostname(), "old");
        mine.started_at = Some(START);
        mine.booted_at = Some(BOOT);
        let write = |owner: &Owner| {
            fs::write(dir.join(LOCK_FILE), serde_json::to_vec(owner).unwrap()).unwrap()
        };

        // macOS: `p_starttime` is untouched by the step, `kern.boottime` is not.
        write(&mine);
        let mac: Liveness = Liveness {
            alive: |_| true,
            started_at: |_| Some(START),
            booted_at: || Some(BOOT + STEP),
        };
        assert!(
            matches!(acquire_with(&dir, "Paper", &mac), Err(Refused::Held(_))),
            "a holder whose start time still matches was reclaimed"
        );

        // Linux: both readings are derived from `btime`, so both move.
        write(&mine);
        let linux: Liveness = Liveness {
            alive: |_| true,
            started_at: |_| Some(START + STEP),
            booted_at: || Some(BOOT + STEP),
        };
        assert!(
            matches!(acquire_with(&dir, "Paper", &linux), Err(Refused::Held(_))),
            "two readings that moved together are a clock, not a new process"
        );

        // And the genuinely reused pid, across the same correction: its start
        // moved by a minute more than the boot did.
        write(&mine);
        let reused: Liveness = Liveness {
            alive: |_| true,
            started_at: |_| Some(START + STEP + 60_000),
            booted_at: || Some(BOOT + STEP),
        };
        acquire_with(&dir, "Paper", &reused)
            .expect("a pid reused since the record is still stale")
            .release();
    }

    /// Created with `wx` and killed before the record was written: the old
    /// protocol's shape, which `link` cannot produce. Reclaimed, not held
    /// forever by nobody.
    #[test]
    fn an_empty_lock_file_is_the_old_crash_window_and_is_reclaimed() {
        let dir = scratch("empty");
        fs::write(dir.join(LOCK_FILE), b"").unwrap();
        // A helper's temp name left behind blocks nobody either.
        fs::write(dir.join(format!(".{LOCK_FILE}.dangling")), b"{}").unwrap();
        let lock = acquire_with(&dir, "Paper", &live()).expect("an empty lock is nobody's");
        assert_eq!(
            read_owner(&dir.join(LOCK_FILE)).unwrap().token,
            lock.owner().token
        );
        lock.release();
    }

    #[test]
    fn a_lock_from_another_host_is_never_reclaimed() {
        let dir = scratch("elsewhere");
        let theirs = record(1, "some-other-machine.local", "t");
        fs::write(dir.join(LOCK_FILE), serde_json::to_vec(&theirs).unwrap()).unwrap();
        assert!(matches!(
            acquire_with(&dir, "Paper", &dead()),
            Err(Refused::Held(_))
        ));
    }

    #[test]
    fn an_unreadable_lock_is_held_by_somebody_unnameable() {
        let dir = scratch("junk");
        fs::write(dir.join(LOCK_FILE), b"{").unwrap();
        assert!(matches!(
            acquire_with(&dir, "Paper", &dead()),
            Err(Refused::Unreadable(_))
        ));
    }

    #[test]
    fn release_leaves_a_lock_that_is_no_longer_ours() {
        let dir = scratch("release");
        let mine = acquire_with(&dir, "Paper", &live()).unwrap();
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
        let mut who = record(42, "mac.local", "t");
        who.command = "paper book add".into();
        let held = Refused::Held(who);
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

    /// The real `Liveness::os()` agrees with this process about itself.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_os_liveness_recognises_this_process() {
        let dir = scratch("self");
        let mine = acquire(&dir, "Paper").unwrap();
        // A second take by the same process is refused: the record is live
        // by pid, by start and by boot.
        assert!(matches!(acquire(&dir, "Paper"), Err(Refused::Held(_))));
        mine.release();
    }
}
