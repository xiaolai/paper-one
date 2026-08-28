//! The daemon's lineage: the record of the group Paper started, and the
//! recovery of one it lost.
//!
//! `kill_on_drop` and the process-group kill in `daemon.rs` cover a Paper
//! that EXITS. They cover nothing when Paper is killed outright — SIGKILL,
//! a logout, a panic that never unwinds this far — and until WI-20.23 that
//! was the whole story on Unix: `llama-server` kept the port, the model's
//! several gigabytes and the GPU, with nothing left anywhere that knew its
//! pid. Windows never had the problem; the Job Object in `procgroup.rs`
//! dies with the handle and takes the tree with it.
//!
//! There is no parent-death signal on macOS (verified: no `prctl.h` in the
//! SDK), and the cooperative patterns — Chromium's IPC-disconnect exit, the
//! LSP `processId` watchdog — need a child that watches, which a third-party
//! `lemond` does not. So the answer is the one Ollama and psutil converge on:
//! write down what was started, and at the next launch decide whether what is
//! running under that number is still it.
//!
//! # Identity is pid PLUS start time
//!
//! A pid is reused; a pid and its start time together are not (psutil's
//! rule, and the check Ollama's own instance barrier makes with
//! `kern.proc.pid`). And a process GROUP id cannot be recycled while any
//! member lives — POSIX, and XNU's `kern_fork.c` — so the only hazard is a
//! wholly dead group whose number came back to a stranger. The record
//! therefore carries the leader's pid and start time and the executable that
//! was launched; a group is OURS when its live leader has that start time,
//! or, once the leader has gone, when a live member is running something from
//! the runtime tree the leader was launched from. A stranger who inherited
//! the number matches neither and is never signalled.
//!
//! No nonce. A per-launch token in the child's environment has no precedent
//! in any of the surveyed projects, cannot be read back on macOS without
//! `sysctl KERN_PROCARGS2` on every candidate, and adds nothing the identity
//! check does not already establish.
//!
//! # Three pieces, one file
//!
//! - [`GroupRecord`] — what is written at spawn, replaced atomically.
//! - [`Processes`] — the OS questions the decision needs, behind a trait so
//!   the two interleavings Codex named run against a fake rather than a live
//!   `sleep`.
//! - [`GroupHold`] — the `Drop` half: the group is killed and the record
//!   removed when the `Daemon` goes away by any route at all, including a
//!   panic unwinding through it.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Beside the layout's `base`, named for what it records.
pub const RECORD_FILE: &str = "daemon.json";

/// The gap between liveness polls while a signalled group winds down.
const POLL_EVERY: Duration = Duration::from_millis(100);

/// What was started. Written at spawn, read at the next launch.
///
/// Five keys, camelCase on disk, and every one is load-bearing: the group to
/// signal, the leader and its start time for identity while it lives, the
/// executable for identity once it has gone, and the port for the log line
/// that says which daemon was collected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRecord {
    pub pgid: u32,
    pub leader_pid: u32,
    /// Epoch MILLISECONDS on every platform — `paper_process::started_at_ms`
    /// is the one lookup, shared with the library lock, and both writers and
    /// both readers go through it. (An earlier design kept the platform's own
    /// unit; the shared crate ended that.) `0` when the lookup failed at
    /// spawn — unknown, which `is_ours` treats as "decide by the members",
    /// never as a time to equal. Only ever compared, never interpreted.
    pub leader_started_at: u64,
    pub exe: PathBuf,
    pub port: u16,
}

/// The two signals a recovery sends, in that order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Terminate,
    Kill,
}

/// The questions the identity check asks the OS.
pub trait Processes: Send + Sync {
    /// When `pid` started, in the kernel's own unit; `None` when there is no
    /// such live process.
    fn started_at(&self, pid: u32) -> Option<u64>;
    /// The executable `pid` is running, when the OS will say.
    fn exe_of(&self, pid: u32) -> Option<PathBuf>;
    /// The LIVE members of process group `pgid`.
    ///
    /// ⚠️ **`Ok(vec![])` IS "THE GROUP IS EMPTY" AND NOTHING ELSE.** This
    /// answered a bare `Vec`, so an enumeration that FAILED — `proc_listpids`
    /// refusing, `/proc` unreadable because the process is out of descriptors
    /// — was the same value as a group that had exited. Both answers feed
    /// [`is_ours`] and the wind-down loop, where "empty" means throw the
    /// record away and confirm the shutdown: one transient failure would
    /// have made a live orphan undiscoverable for ever, holding the GPU and
    /// the port with nothing left that knew its pid. That is the exact
    /// failure this module exists to prevent, reached through its own
    /// bookkeeping.
    fn members_of(&self, pgid: u32) -> io::Result<Vec<u32>>;
    /// Signal the whole group. A group that is already gone is success.
    fn signal_group(&self, pgid: u32, signal: Signal) -> io::Result<()>;
}

/// Where the record goes, under the plugin's base directory.
pub fn record_path(base: &Path) -> PathBuf {
    base.join(RECORD_FILE)
}

/// Write the record whole, under a private name, then rename it into place —
/// so a crash mid-write leaves either the old record or the new one, never
/// half of one that the next launch would read as "nothing to collect".
pub fn write_record(path: &Path, record: &GroupRecord) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// The record, or `None` when there is none. A record that will not parse is
/// an error, which [`recover`] treats as stale — there is nothing in it to
/// signal.
pub fn read_record(path: &Path) -> io::Result<Option<GroupRecord>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// Is the group the record names still the one Paper started?
///
/// While the leader lives, its start time decides — a reused pid has a
/// different one. Once the leader has gone, a member running something from
/// the runtime tree (`lemond` itself, or a backend beside it) is ours; a
/// wholly dead group whose number a stranger inherited has no such member.
///
/// `Err` is "the OS would not say", which is neither yes nor no: a caller
/// must keep the record and signal nothing — see [`Processes::members_of`].
pub fn is_ours(record: &GroupRecord, procs: &dyn Processes) -> io::Result<bool> {
    let members = procs.members_of(record.pgid)?;
    if members.is_empty() {
        return Ok(false);
    }
    if members.contains(&record.leader_pid) {
        /* The recorded time can be UNKNOWN — `started_at` can fail at spawn,
         * and the record carries 0 for it — and the LIVE lookup can fail when
         * the leader exits between the membership snapshot and this call.
         * Neither failure is evidence of a stranger: with a real recorded
         * time and a real live one, they decide; otherwise fall through to
         * the member rule below, which judges by what the group is RUNNING.
         * Without this, a spawn-time lookup hiccup made its own orphan
         * unrecoverable forever — the recovery rejected the honest record. */
        if record.leader_started_at != 0 {
            if let Some(live) = procs.started_at(record.leader_pid) {
                return Ok(live == record.leader_started_at);
            }
        }
    }
    let tree = record.exe.parent();
    Ok(members.iter().any(|&pid| {
        procs
            .exe_of(pid)
            .is_some_and(|exe| exe == record.exe || tree.is_some_and(|tree| exe.starts_with(tree)))
    }))
}

/// What a recovery found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovery {
    /// No record: nothing was left behind.
    Nothing,
    /// A record that named nothing of ours. Removed.
    Stale,
    /// Our group, still running. Signalled, and `forced` when it needed the
    /// second signal.
    Collected { pgid: u32, port: u16, forced: bool },
    /// The OS would not say what is in the group, so nothing was signalled
    /// and the record was KEPT — the next launch asks again. Neither
    /// "collected" nor "stale": claiming either would be a guess, and one of
    /// the guesses throws away the only key to a live daemon.
    Unknown { pgid: u32 },
}

/// Collect a daemon a previous Paper left running, if there is one.
///
/// Terminate first — the daemon unloads its models on the way out, and a
/// loaded model takes a moment to let go of — then, past `grace`, kill. The
/// record is removed whatever happened: it described a group that is now
/// either gone or a stranger's.
pub async fn recover(path: &Path, procs: &dyn Processes, grace: Duration) -> Recovery {
    let record = match read_record(path) {
        Ok(Some(record)) => record,
        Ok(None) => return Recovery::Nothing,
        Err(err) => {
            log::warn!(
                "inference: the daemon record at {} would not read ({err}); removing it",
                path.display()
            );
            let _ = std::fs::remove_file(path);
            return Recovery::Stale;
        }
    };
    let outcome = match is_ours(&record, procs) {
        /* The OS refusing to enumerate is not evidence of anything. Keep the
         * record, signal nothing, and say so: the alternative reads the
         * failure as "empty" and deletes the only key to a live group. */
        Err(err) => {
            log::warn!(
                "inference: could not tell whether runtime group {} is still ours ({err}); keeping its record for the next launch",
                record.pgid
            );
            return Recovery::Unknown { pgid: record.pgid };
        }
        Ok(false) => Recovery::Stale,
        Ok(true) => match wind_down(&record, procs, grace).await {
            WoundDown::Gone { forced } => Recovery::Collected {
                pgid: record.pgid,
                port: record.port,
                forced,
            },
            // The number moved on between the check and the kill; nothing of
            // ours is there, and the record describes nobody.
            WoundDown::NotOurs => Recovery::Stale,
            WoundDown::Left { forced } => {
                /* The record is the ONLY key to this group. A kill that did
                 * not take — an EPERM, a member wedged in the kernel — must
                 * not end with the key thrown away and the group immortal;
                 * the next launch tries again with the same record. */
                log::warn!(
                    "inference: the orphaned runtime group {} did not exit; keeping its record for the next launch",
                    record.pgid
                );
                return Recovery::Collected {
                    pgid: record.pgid,
                    port: record.port,
                    forced,
                };
            }
        },
    };
    if let Err(err) = std::fs::remove_file(path) {
        if err.kind() != io::ErrorKind::NotFound {
            // A record that would not go will be read again next launch —
            // said out loud, because acting twice on one record is exactly
            // what the pgid-reuse hazard needs.
            log::warn!(
                "inference: the daemon record at {} could not be removed: {err}",
                path.display()
            );
        }
    }
    outcome
}

/// What a wind-down did. `forced` is whether it took the second signal.
///
/// The distinction `recover` acts on is Gone versus everything else: only an
/// EMPTIED group frees the record. Reporting a collection that did not happen
/// was how a kill that failed threw away the only key to a live group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WoundDown {
    /// The group emptied.
    Gone { forced: bool },
    /// The record no longer names our group — nothing of ours was signalled.
    NotOurs,
    /// It would not go, or the OS stopped answering. The record stays.
    Left { forced: bool },
}

/// Ask the group to stop, wait, then insist.
async fn wind_down(record: &GroupRecord, procs: &dyn Processes, grace: Duration) -> WoundDown {
    if let Err(err) = procs.signal_group(record.pgid, Signal::Terminate) {
        log::warn!(
            "inference: could not terminate the orphaned runtime group {}: {err}",
            record.pgid
        );
    }
    let deadline = tokio::time::Instant::now() + grace;
    loop {
        match procs.members_of(record.pgid) {
            Ok(members) if members.is_empty() => return WoundDown::Gone { forced: false },
            Ok(_) => {}
            Err(err) => {
                log::warn!(
                    "inference: could not read the members of the orphaned runtime group {} ({err}); keeping its record",
                    record.pgid
                );
                return WoundDown::Left { forced: false };
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return force(record, procs).await;
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
}

/// The second signal, and the identity check that guards it.
async fn force(record: &GroupRecord, procs: &dyn Processes) -> WoundDown {
    /* THE IDENTITY IS CHECKED AGAIN, IMMEDIATELY BEFORE THE KILL. `recover`
     * checked it once, a whole grace period ago. A pgid cannot be recycled
     * while any member lives, so what this catches is the group emptying
     * inside one poll gap and its number coming back to a stranger before
     * the deadline — after which the SIGKILL below would land on somebody
     * else's process tree. Signalling a stranger is the one outcome this
     * module must never produce, so an identity that no longer holds ABORTS
     * rather than insisting, and an OS that will not answer keeps the record
     * instead of guessing. */
    match is_ours(record, procs) {
        Ok(true) => {}
        Ok(false) => return WoundDown::NotOurs,
        Err(err) => {
            log::warn!(
                "inference: could not confirm the orphaned runtime group {} before killing it ({err}); leaving it alone",
                record.pgid
            );
            return WoundDown::Left { forced: false };
        }
    }
    if let Err(err) = procs.signal_group(record.pgid, Signal::Kill) {
        log::warn!(
            "inference: could not kill the orphaned runtime group {}: {err}",
            record.pgid
        );
    }
    // SIGKILL is not synchronous: give the kernel a moment, then read the
    // group back rather than assuming.
    let confirm = tokio::time::Instant::now() + Duration::from_millis(250);
    loop {
        match procs.members_of(record.pgid) {
            Ok(members) if members.is_empty() => return WoundDown::Gone { forced: true },
            Ok(_) => {}
            Err(err) => {
                log::warn!(
                    "inference: could not read the members of runtime group {} after the kill ({err}); keeping its record",
                    record.pgid
                );
                return WoundDown::Left { forced: true };
            }
        }
        if tokio::time::Instant::now() >= confirm {
            return WoundDown::Left { forced: true };
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The `Drop` half: holds the group id and the record's path for exactly as
/// long as the `Daemon` holds the child, and takes both down when it goes.
///
/// `Daemon::stop` is the ORDERED teardown and runs first whenever it can.
/// This is what still runs when it cannot — a future cancelled mid-await, a
/// panic unwinding — and after `stop` it finds an empty group (ESRCH, which
/// `kill_now` ignores) and a record already gone.
pub struct GroupHold {
    group: Option<u32>,
    record: PathBuf,
}

impl GroupHold {
    pub fn new(group: Option<u32>, record: PathBuf) -> Self {
        GroupHold { group, record }
    }

    /// The group id captured at spawn — see `procgroup::group_of`.
    pub fn group(&self) -> Option<u32> {
        self.group
    }

    /* NO `record()` ACCESSOR. There was one, and `Daemon::stop` used it to
     * unlink the record itself — past the condition this type's `Drop`
     * applies, so a kill that failed still threw the key away. The path is
     * this type's business alone now, and the accessor is gone so it cannot
     * become somebody else's again. */
}

impl Drop for GroupHold {
    fn drop(&mut self) {
        /* The record goes ONLY when the kill was delivered (or the group was
         * already gone). A killpg that failed outright — however unlikely
         * from the parent — with the record then removed is a live group
         * with no key; kept, the next launch recovers it. */
        if crate::procgroup::kill_now(self.group) {
            let _ = std::fs::remove_file(&self.record);
        } else {
            log::warn!(
                "inference: the runtime group {:?} could not be signalled at drop; its record stays for the next launch",
                self.group
            );
        }
    }
}

/// The OS, asked directly.
pub struct OsProcesses;

#[cfg(target_os = "macos")]
impl Processes for OsProcesses {
    fn started_at(&self, pid: u32) -> Option<u64> {
        // ONE LOOKUP FOR THE WHOLE APP. The library lock asks the same
        // question of the same kernel (`src-tauri/src/lock.rs`), and the app
        // crate may not reach into this plugin for it — so the `proc_pidinfo`
        // call that was here lives in `paper-process`, in epoch milliseconds
        // on every platform, and both records compare against it.
        paper_process::started_at_ms(pid)
    }

    fn exe_of(&self, pid: u32) -> Option<PathBuf> {
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the buffer is as large as the call is told it is.
        let len = unsafe {
            libc::proc_pidpath(
                pid as libc::c_int,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
            )
        };
        if len <= 0 {
            return None;
        }
        buffer.truncate(len as usize);
        Some(PathBuf::from(String::from_utf8_lossy(&buffer).into_owned()))
    }

    fn members_of(&self, pgid: u32) -> io::Result<Vec<u32>> {
        /// `<libproc.h>`: `PROC_PGRP_ONLY`, which libc does not bind.
        const PROC_PGRP_ONLY: u32 = 2;
        // Sized first, then filled. The kernel answers the byte count it
        // NEEDS on a null buffer, and a group can grow between the two calls,
        // so the buffer gets headroom and the count that comes back is the
        // truth.
        // SAFETY: a null buffer with size 0 is the documented sizing call.
        let needed = unsafe { libc::proc_listpids(PROC_PGRP_ONLY, pgid, std::ptr::null_mut(), 0) };
        /* NEGATIVE IS A FAILURE, ZERO IS AN EMPTY GROUP. Both were `<= 0`
         * and answered the same empty list — see the trait's note. */
        if needed < 0 {
            return Err(io::Error::last_os_error());
        }
        if needed == 0 {
            return Ok(Vec::new());
        }
        let mut capacity = needed as usize / std::mem::size_of::<libc::pid_t>() + 16;
        loop {
            let mut pids = vec![0 as libc::pid_t; capacity];
            // SAFETY: the buffer's byte length is what the call is told.
            let bytes = unsafe {
                libc::proc_listpids(
                    PROC_PGRP_ONLY,
                    pgid,
                    pids.as_mut_ptr().cast(),
                    (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
                )
            };
            if bytes < 0 {
                return Err(io::Error::last_os_error());
            }
            if bytes == 0 {
                // The group emptied between the two calls.
                return Ok(Vec::new());
            }
            /* A buffer filled to its LAST slot may have been truncated — the
             * headroom above absorbs ordinary growth between the sizing call
             * and this one, but a fork storm can outrun any fixed allowance,
             * and a truncated list can hide exactly the member an identity
             * check needed. Full means retry bigger, not hope. */
            if bytes as usize == pids.len() * std::mem::size_of::<libc::pid_t>() {
                capacity *= 2;
                continue;
            }
            pids.truncate(bytes as usize / std::mem::size_of::<libc::pid_t>());
            return Ok(pids
                .into_iter()
                .filter(|&pid| pid > 0)
                .map(|pid| pid as u32)
                .collect());
        }
    }

    fn signal_group(&self, pgid: u32, signal: Signal) -> io::Result<()> {
        killpg(pgid, signal)
    }
}

#[cfg(target_os = "linux")]
impl Processes for OsProcesses {
    fn started_at(&self, pid: u32) -> Option<u64> {
        // `/proc/<pid>/stat` field 22 — psutil's `create_time` source, and
        // the one thing about a pid the kernel will not reuse — read by
        // `paper-process` for the same reason as on macOS: the library lock
        // asks it too, and the answer is in epoch milliseconds for both.
        paper_process::started_at_ms(pid)
    }

    fn exe_of(&self, pid: u32) -> Option<PathBuf> {
        let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
        // A binary replaced under a running process reads " (deleted)"; the
        // path before that is the one to compare.
        let text = exe.to_string_lossy();
        Some(PathBuf::from(
            text.strip_suffix(" (deleted)").unwrap_or(&text).to_owned(),
        ))
    }

    fn members_of(&self, pgid: u32) -> io::Result<Vec<u32>> {
        /* `/proc` UNREADABLE IS A FAILURE, not an empty group — see the
         * trait's note. It is reachable: a process out of file descriptors
         * gets `EMFILE` here, and reading that as "nothing is running" is
         * what deleted the record of a live daemon. A single ENTRY that
         * cannot be read is different and stays skipped: processes come and
         * go under `/proc` while it is being walked. */
        let entries = std::fs::read_dir("/proc")?;
        Ok(entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|&pid| {
                // Field 5 is the process group.
                stat_fields(pid)
                    .and_then(|fields| fields.get(2)?.parse::<u32>().ok())
                    .is_some_and(|group| group == pgid)
            })
            .collect())
    }

    fn signal_group(&self, pgid: u32, signal: Signal) -> io::Result<()> {
        killpg(pgid, signal)
    }
}

/// The fields of `/proc/<pid>/stat` AFTER the command name, which is the
/// only field that can hold spaces and parentheses — so the split starts at
/// the last `)`. Index 0 is field 3 (state).
#[cfg(target_os = "linux")]
fn stat_fields(pid: u32) -> Option<Vec<String>> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = stat.rfind(')')?;
    Some(
        stat[after + 1..]
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
    )
}

#[cfg(unix)]
fn killpg(pgid: u32, signal: Signal) -> io::Result<()> {
    let sig = match signal {
        Signal::Terminate => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: a plain syscall on two integers.
    let rc = unsafe { libc::killpg(pgid as libc::pid_t, sig) };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(err)
    }
}

#[cfg(windows)]
impl Processes for OsProcesses {
    // The Job Object is the mechanism on Windows: the tree dies with the
    // handle, and the kernel closes the handle when Paper is killed. There is
    // no orphan to find, so the OS answers "nobody", and a leftover record is
    // simply removed.
    fn started_at(&self, _pid: u32) -> Option<u64> {
        None
    }
    fn exe_of(&self, _pid: u32) -> Option<PathBuf> {
        None
    }
    fn members_of(&self, _pgid: u32) -> io::Result<Vec<u32>> {
        Ok(Vec::new())
    }
    fn signal_group(&self, _pgid: u32, _signal: Signal) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::sync::Mutex;

    struct Proc {
        pid: u32,
        pgid: u32,
        started_at: u64,
        exe: PathBuf,
        alive: bool,
    }

    /// A process table the test writes, and the signals it received.
    ///
    /// `Terminate` ends the group's members unless the fake was told the
    /// group ignores it — a backend that shrugs off SIGTERM is the case the
    /// second signal exists for.
    #[derive(Default)]
    pub struct FakeProcesses {
        procs: Mutex<Vec<Proc>>,
        signals: Mutex<Vec<(u32, Signal)>>,
        ignores_terminate: bool,
        /// The OS refusing to enumerate — `proc_listpids` failing, `/proc`
        /// unreadable. Distinct from an empty table, which is the whole
        /// point of `members_of` answering a `Result`.
        enumeration_fails: bool,
        /// The pgid changing hands after the first signal.
        stranger_after_terminate: bool,
    }

    impl FakeProcesses {
        pub fn with(self, pid: u32, pgid: u32, started_at: u64, exe: &str) -> Self {
            self.procs.lock().unwrap().push(Proc {
                pid,
                pgid,
                started_at,
                exe: PathBuf::from(exe),
                alive: true,
            });
            self
        }

        pub fn ignoring_terminate(mut self) -> Self {
            self.ignores_terminate = true;
            self
        }

        /// An OS that will not say what is in a group.
        pub fn refusing_to_enumerate(mut self) -> Self {
            self.enumeration_fails = true;
            self
        }

        /// The group's number changing hands DURING the grace period: after
        /// the terminate, everything in it is somebody else's process. The
        /// members stay, which is what a test needs — the identity is what
        /// moves, and the identity is what the second signal is guarded on.
        pub fn stranger_after_terminate(mut self) -> Self {
            self.stranger_after_terminate = true;
            self
        }

        pub fn alive(&self, pid: u32) -> bool {
            self.procs
                .lock()
                .unwrap()
                .iter()
                .any(|p| p.pid == pid && p.alive)
        }

        pub fn signals(&self) -> Vec<(u32, Signal)> {
            self.signals.lock().unwrap().clone()
        }
    }

    impl Processes for FakeProcesses {
        fn started_at(&self, pid: u32) -> Option<u64> {
            self.procs
                .lock()
                .unwrap()
                .iter()
                .find(|p| p.pid == pid && p.alive)
                .map(|p| p.started_at)
        }

        fn exe_of(&self, pid: u32) -> Option<PathBuf> {
            self.procs
                .lock()
                .unwrap()
                .iter()
                .find(|p| p.pid == pid && p.alive)
                .map(|p| p.exe.clone())
        }

        fn members_of(&self, pgid: u32) -> io::Result<Vec<u32>> {
            if self.enumeration_fails {
                return Err(io::Error::other("the process table would not be read"));
            }
            Ok(self
                .procs
                .lock()
                .unwrap()
                .iter()
                .filter(|p| p.pgid == pgid && p.alive)
                .map(|p| p.pid)
                .collect())
        }

        fn signal_group(&self, pgid: u32, signal: Signal) -> io::Result<()> {
            self.signals.lock().unwrap().push((pgid, signal));
            let ends = match signal {
                Signal::Terminate => !self.ignores_terminate,
                Signal::Kill => true,
            };
            if ends {
                for p in self.procs.lock().unwrap().iter_mut() {
                    if p.pgid == pgid {
                        p.alive = false;
                    }
                }
            }
            if signal == Signal::Terminate && self.stranger_after_terminate {
                for p in self.procs.lock().unwrap().iter_mut() {
                    if p.pgid == pgid {
                        p.started_at += 1;
                        p.exe = PathBuf::from("/usr/bin/other");
                    }
                }
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeProcesses;
    use super::*;
    use crate::testutil::ScratchDir;

    const RUNTIME: &str = "/Applications/Paper.app/Contents/Resources/runtime";

    fn record(pgid: u32) -> GroupRecord {
        GroupRecord {
            pgid,
            leader_pid: pgid,
            leader_started_at: 1_700_000_000_000_000,
            exe: PathBuf::from(format!("{RUNTIME}/lemond")),
            port: 13399,
        }
    }

    fn written(dir: &ScratchDir, record: &GroupRecord) -> PathBuf {
        let path = record_path(dir.path());
        write_record(&path, record).unwrap();
        path
    }

    /// The grandchild's pid, from the file its shell writes — BOUNDED. Two
    /// tests carried this loop with no deadline each; a shell that never
    /// wrote the file hung the suite with no diagnosis instead of failing it.
    #[cfg(unix)]
    async fn pid_from(pidfile: &Path) -> u32 {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = tokio::fs::read_to_string(pidfile).await {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the helper shell never wrote its pidfile at {}",
                pidfile.display()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The five keys, camelCase, and nothing left beside the file: a record
    /// half-written when Paper died would be read as "nothing to collect".
    #[test]
    fn the_record_is_written_whole_under_five_camel_case_keys() {
        let dir = ScratchDir::new("lineage");
        let path = written(&dir, &record(500));
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            ["exe", "leaderPid", "leaderStartedAt", "pgid", "port"]
        );
        assert_eq!(read_record(&path).unwrap(), Some(record(500)));
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the temporary name is gone once the rename lands"
        );
    }

    /// Codex's round-1 case. The leader started a backend, recorded it and
    /// exited; Paper was then killed. At the next launch the backend is a
    /// live member of a group whose leader is gone, running something from
    /// the runtime tree — ours — and the group is collected: `kill(pid, 0)`
    /// on the grandchild is ESRCH afterwards.
    #[tokio::test]
    async fn an_orphaned_backend_whose_leader_exited_is_collected_with_its_group() {
        let dir = ScratchDir::new("lineage");
        let path = written(&dir, &record(500));
        let procs = FakeProcesses::default().with(
            501,
            500,
            7,
            &format!("{RUNTIME}/backend/llamacpp/metal/llama-server"),
        );
        assert!(procs.alive(501));

        let outcome = recover(&path, &procs, Duration::from_millis(50)).await;

        assert_eq!(
            outcome,
            Recovery::Collected {
                pgid: 500,
                port: 13399,
                forced: false
            }
        );
        assert!(!procs.alive(501), "the grandchild survived the recovery");
        assert_eq!(procs.signals(), [(500, Signal::Terminate)]);
        assert!(!path.exists(), "a collected record is removed");
    }

    /// Codex's round-2 case. The record's group id — and its port — are now
    /// held by an unrelated process: a wholly dead group whose number came
    /// back. Nothing is signalled, and the stranger is still there afterwards.
    #[tokio::test]
    async fn a_stale_record_whose_group_and_port_a_stranger_now_holds_is_not_signalled() {
        let dir = ScratchDir::new("lineage");
        let path = written(&dir, &record(4242));
        let procs = FakeProcesses::default().with(4242, 4242, 9_999, "/usr/bin/other");

        let outcome = recover(&path, &procs, Duration::from_millis(50)).await;

        assert_eq!(outcome, Recovery::Stale);
        assert!(procs.signals().is_empty(), "a stranger was signalled");
        assert!(procs.alive(4242));
        assert!(!path.exists(), "a stale record is removed");
    }

    /// While the leader lives, its start time is the identity — a reused
    /// pid has a different one, whatever else is in the group.
    #[tokio::test]
    async fn a_live_leader_decides_by_its_start_time() {
        let ours = record(600);
        let dir = ScratchDir::new("lineage");

        let path = written(&dir, &ours);
        let same = FakeProcesses::default().with(
            600,
            600,
            ours.leader_started_at,
            &format!("{RUNTIME}/lemond"),
        );
        assert!(matches!(
            recover(&path, &same, Duration::from_millis(50)).await,
            Recovery::Collected { pgid: 600, .. }
        ));
        assert!(!same.alive(600));

        let path = written(&dir, &ours);
        let reused = FakeProcesses::default().with(
            600,
            600,
            ours.leader_started_at + 1,
            &format!("{RUNTIME}/lemond"),
        );
        assert_eq!(
            recover(&path, &reused, Duration::from_millis(50)).await,
            Recovery::Stale
        );
        assert!(reused.alive(600), "a reused pid was signalled");
    }

    /// A backend that ignores SIGTERM gets SIGKILL after the grace, and the
    /// recovery says it had to insist.
    #[tokio::test]
    async fn a_group_that_ignores_terminate_is_killed_after_the_grace() {
        let dir = ScratchDir::new("lineage");
        let path = written(&dir, &record(700));
        let procs = FakeProcesses::default()
            .with(
                701,
                700,
                7,
                &format!("{RUNTIME}/backend/llamacpp/cpu/llama-server"),
            )
            .ignoring_terminate();

        let outcome = recover(&path, &procs, Duration::from_millis(30)).await;

        assert_eq!(
            outcome,
            Recovery::Collected {
                pgid: 700,
                port: 13399,
                forced: true
            }
        );
        assert_eq!(
            procs.signals(),
            [(700, Signal::Terminate), (700, Signal::Kill)]
        );
        assert!(!procs.alive(701));
    }

    /// AN OS THAT WILL NOT ANSWER IS NOT AN EMPTY GROUP. `members_of` used to
    /// fold a failed enumeration into "nobody is there", which reads as a
    /// stale record — so one `EMFILE` at launch deleted the only key to a
    /// live daemon and left it holding the GPU for ever. Nothing is
    /// signalled, and the record is still there for the next launch.
    #[tokio::test]
    async fn an_enumeration_the_os_refuses_keeps_the_record_and_signals_nothing() {
        let dir = ScratchDir::new("lineage");
        let path = written(&dir, &record(900));
        let procs = FakeProcesses::default()
            .with(901, 900, 7, &format!("{RUNTIME}/lemond"))
            .refusing_to_enumerate();

        let outcome = recover(&path, &procs, Duration::from_millis(30)).await;

        assert_eq!(outcome, Recovery::Unknown { pgid: 900 });
        assert!(
            procs.signals().is_empty(),
            "a group nobody could see was signalled"
        );
        assert!(path.exists(), "the only key to the group was thrown away");
        assert!(procs.alive(901));
    }

    /// THE IDENTITY IS RE-CHECKED BEFORE THE SECOND SIGNAL. The first check
    /// is a whole grace period old by then, and a group that empties inside
    /// one poll gap can have its number back in use before the deadline —
    /// after which SIGKILL would land on a stranger's tree. The record is
    /// removed as what it now is: a description of nobody.
    #[tokio::test]
    async fn a_group_that_changed_hands_during_the_grace_is_never_killed() {
        let dir = ScratchDir::new("lineage");
        let path = written(&dir, &record(910));
        let procs = FakeProcesses::default()
            .with(
                910,
                910,
                record(910).leader_started_at,
                &format!("{RUNTIME}/lemond"),
            )
            .ignoring_terminate()
            .stranger_after_terminate();

        let outcome = recover(&path, &procs, Duration::from_millis(30)).await;

        assert_eq!(outcome, Recovery::Stale);
        assert_eq!(
            procs.signals(),
            [(910, Signal::Terminate)],
            "the kill went to a group that was no longer ours"
        );
        assert!(procs.alive(910), "the stranger was killed");
        assert!(!path.exists(), "a record that names nobody is removed");
    }

    #[tokio::test]
    async fn no_record_is_nothing_to_collect_and_a_broken_one_is_stale() {
        let dir = ScratchDir::new("lineage");
        let path = record_path(dir.path());
        let procs = FakeProcesses::default();
        assert_eq!(
            recover(&path, &procs, Duration::from_millis(10)).await,
            Recovery::Nothing
        );

        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(
            recover(&path, &procs, Duration::from_millis(10)).await,
            Recovery::Stale
        );
        assert!(!path.exists());
        assert!(procs.signals().is_empty());
    }

    /// The identity check is exact about "from the runtime tree": a sibling
    /// directory of the runtime is not it.
    #[test]
    fn a_member_outside_the_runtime_tree_is_not_ours() {
        let procs = FakeProcesses::default().with(
            801,
            800,
            7,
            "/Applications/Paper.app/Contents/Resources/other/llama-server",
        );
        assert!(!is_ours(&record(800), &procs).unwrap());
        let inside = FakeProcesses::default().with(
            801,
            800,
            7,
            &format!("{RUNTIME}/backend/llamacpp/metal/llama-server"),
        );
        assert!(is_ours(&record(800), &inside).unwrap());
    }

    /// The OS layer, asked about this very process: it exists, it started,
    /// it is running this test binary, and it is a member of its own group.
    #[cfg(unix)]
    #[test]
    fn the_os_answers_this_process_s_own_identity() {
        let me = std::process::id();
        let procs = OsProcesses;
        assert!(
            procs.started_at(me).is_some(),
            "no start time for ourselves"
        );
        let exe = procs.exe_of(me).expect("no executable for ourselves");
        assert_eq!(
            exe.file_name(),
            std::env::current_exe().unwrap().file_name(),
            "{}",
            exe.display()
        );
        // SAFETY: a plain syscall with no arguments.
        let group = unsafe { libc::getpgrp() } as u32;
        assert!(
            procs.members_of(group).unwrap().contains(&me),
            "not a member of our own group"
        );
        assert!(
            procs.started_at(u32::MAX - 1).is_none(),
            "a pid that does not exist has no start time"
        );
        /* A GROUP WITH NO MEMBERS IS `Ok(vec![])`, NOT AN ERROR — the whole
         * `Result` is worthless if the ordinary "it has exited" answer is
         * indistinguishable from the failure it was added to name. This is
         * the platform call being asked, not a fake. */
        assert_eq!(
            procs
                .members_of(u32::MAX - 1)
                .expect("an empty group is not a failure"),
            Vec::<u32>::new()
        );
    }

    /// The whole thing against a real group: a leader that starts `sleep`,
    /// records nothing itself and exits, leaving the grandchild in its group
    /// — the shape `lemond` spawning `llama-server` takes when Paper dies.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_real_orphan_is_collected_by_its_group() {
        let dir = ScratchDir::new("lineage");
        let pidfile = dir.path().join("grandchild.pid");
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(format!(
            "sleep 30 & echo $! > {}; exit 0",
            pidfile.display()
        ));
        crate::procgroup::configure(&mut cmd);
        let mut leader = cmd.spawn().expect("spawn");
        let pgid = leader.id().expect("pid before reap");
        let _ = leader.wait().await;
        let grandchild: u32 = pid_from(&pidfile).await;
        assert_eq!(
            unsafe { libc::kill(grandchild as libc::pid_t, 0) },
            0,
            "the grandchild should be running"
        );

        let sleep_exe = OsProcesses.exe_of(grandchild).expect("sleep's executable");
        let path = written(
            &dir,
            &GroupRecord {
                pgid,
                leader_pid: pgid,
                leader_started_at: 0,
                exe: sleep_exe.with_file_name("lemond"),
                port: 1,
            },
        );

        let outcome = recover(&path, &OsProcesses, Duration::from_secs(2)).await;

        assert!(
            matches!(outcome, Recovery::Collected { .. }),
            "the orphan was not recognised: {outcome:?}"
        );
        let mut gone = false;
        for _ in 0..100 {
            if unsafe { libc::kill(grandchild as libc::pid_t, 0) } != 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(gone, "the grandchild survived the recovery");
        assert!(!path.exists());
    }

    /// The `Drop` half, against a real group: letting the hold go kills the
    /// grandchild and removes the record, with nothing awaited.
    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_the_hold_takes_the_group_and_the_record_with_it() {
        let dir = ScratchDir::new("lineage");
        let pidfile = dir.path().join("grandchild.pid");
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", pidfile.display()));
        crate::procgroup::configure(&mut cmd);
        cmd.kill_on_drop(true);
        let leader = cmd.spawn().expect("spawn");
        let grandchild: u32 = pid_from(&pidfile).await;
        let path = written(&dir, &record(leader.id().unwrap()));
        let hold = GroupHold::new(crate::procgroup::group_of(&leader), path.clone());
        assert!(path.exists());

        drop(hold);

        let mut gone = false;
        for _ in 0..100 {
            if unsafe { libc::kill(grandchild as libc::pid_t, 0) } != 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(gone, "the grandchild survived the drop");
        assert!(!path.exists(), "the record survived the drop");
    }
}
