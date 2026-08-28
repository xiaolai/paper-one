//! Process identity: when a pid started, and when this host booted.
//!
//! A pid on its own names a process only until the kernel hands the number
//! to the next one. Two things in Paper keep a pid in a file and later ask
//! whether it is still the process that wrote it — the library lock
//! (`src-tauri/src/lock.rs`, shared with the CLI's `lock.ts`) and the
//! inference daemon's lineage record (`tauri-plugin-inference/src/lineage.rs`)
//! — and a wrong "still alive" is two writers on one library, or a stranger's
//! process group signalled. psutil's rule is the one both follow: process
//! identity is `(pid, creation time)`, and a record that also carries the
//! boot time is stale the moment the machine has rebooted, whatever the pid
//! now names.
//!
//! ONE LOOKUP, HERE. The lineage record had the macOS `proc_pidinfo` call and
//! the Linux `/proc/<pid>/stat` read; the lock needed the same two, and the
//! app crate must not reach into a removable capability for a rule that is
//! not the capability's (`scripts/lib/removal.mjs` refuses that by name — it
//! is how `paper-data-root` came to exist). A plain crate, like that one.
//!
//! Every answer is EPOCH MILLISECONDS, on every platform, so a record written
//! by one process compares against a lookup made by another without a unit
//! conversion that one side could forget. Where the platform offers nothing
//! (Windows, today) the answer is `None`, and a caller must treat `None` as
//! "cannot refute", never as "different".

use std::time::{SystemTime, UNIX_EPOCH};

/// When `pid` started, as epoch milliseconds, or `None` when the platform
/// cannot say or the process is gone.
pub fn started_at_ms(pid: u32) -> Option<u64> {
    platform::started_at_ms(pid)
}

/// When this host booted, as epoch milliseconds, or `None` when the platform
/// Whether `pid` is a ZOMBIE — dead, and still holding its slot.
///
/// `None` where the state cannot be read at all, which is "cannot refute"
/// rather than "no": a caller must not turn an unreadable answer into a
/// reclaim.
///
/// ⚠️ **WHY A LOCK CARES.** `kill(pid, 0)` SUCCEEDS for a zombie, and an
/// unreaped process keeps its pid table entry, its `/proc/<pid>/stat` and its
/// ORIGINAL START TIME. So a zombie defeats both halves of an identity check
/// at once: it answers the liveness probe, and its start time still matches
/// the record exactly — which reads as "the same process is still running"
/// when the truth is "the same process, dead, unreaped".
///
/// Measured, not theorised: an app killed under a container PID 1 that never
/// calls `wait()` left its lock permanently held, and Paper would not open
/// again — no error, no paint, the process alive and waiting on a dialog
/// nobody could dismiss. `docker run` without `--init` is exactly that PID 1,
/// which makes CI the place this is met first. On an ordinary desktop systemd
/// reaps orphans and the pid genuinely goes, so this cannot be reproduced
/// there; the exposure is containers and any launcher that spawns Paper and
/// keeps running without reaping it.
///
/// It reads no more than `started_at_ms` already does — the same
/// `/proc/<pid>/stat` line, one field earlier; the same `proc_pidinfo` call,
/// one field over — which keeps the module's ONE LOOKUP rule.
pub fn is_zombie(pid: u32) -> Option<bool> {
    platform::is_zombie(pid)
}

/// cannot say.
pub fn booted_at_ms() -> Option<u64> {
    platform::booted_at_ms()
}

/// This process's own start, for writing into a record.
pub fn own_started_at_ms() -> Option<u64> {
    started_at_ms(std::process::id())
}

/// Now, as the same epoch milliseconds the answers above use.
///
/// A clock BEFORE the epoch answers `0` rather than an error, deliberately:
/// the callers are identity records and stamps, and on a machine whose clock
/// is that broken, `0` makes every "is this holder newer" comparison read
/// the record as ancient — the conservative direction (a lock is treated as
/// stale-able, never as freshly held). An error type here would ripple
/// through every record writer for a machine state nothing else survives.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
mod platform {
    pub fn started_at_ms(pid: u32) -> Option<u64> {
        // `proc_pidinfo(PROC_PIDTBSDINFO)` is what `ps` reads; its start
        // time is the same `p_starttime` that `sysctl kern.proc.pid` carries,
        // and it costs one call rather than a sized buffer dance. A pid that
        // is gone answers with a short write, which is the `None` below.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: `info` is a zeroed instance of the struct the flavor fills,
        // and its size is passed alongside; the return is checked below.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if written != size {
            return None;
        }
        Some(info.pbi_start_tvsec * 1_000 + info.pbi_start_tvusec / 1_000)
    }

    /// Where `p_stat` sits in the `kinfo_proc` that `sysctl` returns.
    ///
    /// `kinfo_proc` opens with `struct extern_proc kp_proc`, whose first four
    /// members on 64-bit macOS are a 16-byte union (`p_un`), two pointers
    /// (`p_vmspace`, `p_sigacts`) at 8 each, and `int p_flag` at 4 — so the
    /// `char p_stat` after them lands at 36. Named rather than inlined, and
    /// the test beside `is_zombie` checks it in BOTH directions: a real zombie
    /// must read `Z` and a real live process must not. An offset that happened
    /// to be wrong could still answer one of those correctly by accident; it
    /// cannot answer both.
    const P_STAT_OFFSET: usize = 36;

    /// `SZOMB`, through `sysctl` — no `proc_pidinfo` flavor will answer.
    ///
    /// ⚠️ **`PROC_PIDTBSDINFO` AND `PROC_PIDT_SHORTBSDINFO` BOTH SHORT-WRITE
    /// FOR A ZOMBIE**, measured, and the first is the flavor `started_at_ms`
    /// above uses. So on macOS a zombie reports `started_at_ms() == None`, and
    /// `lock.rs`'s `holds` then takes its `(None, Some(boot))` arm and calls
    /// the lock HELD until the machine next reboots.
    ///
    /// The same defect therefore reaches the two platforms by OPPOSITE routes:
    /// on Linux a zombie KEEPS its start time and passes the identity check;
    /// on macOS it LOSES it and passes the no-start-time fallback. Neither is
    /// visible to a liveness probe, which is why the exclusion belongs in
    /// `alive` rather than in either arm of that match.
    ///
    /// `sysctl(KERN_PROC_PID)` is what `ps` reads, and it does answer — `ps -o
    /// stat` prints `Z` for precisely this state. `libc` exposes the constants
    /// but not `kinfo_proc` on Apple, so the one byte is read by offset.
    pub fn is_zombie(pid: u32) -> Option<bool> {
        let mut mib = [
            libc::CTL_KERN,
            libc::KERN_PROC,
            libc::KERN_PROC_PID,
            pid as libc::c_int,
        ];
        /* Sized from the kernel rather than guessed: `kinfo_proc` is not in
        `libc` here, and a buffer smaller than the real struct makes
        `sysctl` answer ENOMEM. */
        let mut len: usize = 0;
        // SAFETY: a null buffer with a zero length asks `sysctl` for the size.
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                std::ptr::null_mut(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || len <= P_STAT_OFFSET {
            return None;
        }
        let mut buf = vec![0u8; len];
        // SAFETY: `buf` is `len` bytes and `len` carries that size in and the
        // written size out; both are checked before the byte is read.
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                buf.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        /* A LENGTH OF ZERO IS "NO SUCH PROCESS": `sysctl` returns 0 and writes
        nothing for a pid that is gone. `None` — cannot say — rather than
        "not a zombie", which a caller reads as alive. */
        if rc != 0 || len <= P_STAT_OFFSET {
            return None;
        }
        Some(u32::from(buf[P_STAT_OFFSET]) == libc::SZOMB)
    }

    pub fn booted_at_ms() -> Option<u64> {
        // `kern.boottime`, the timeval the kernel recorded at boot — the
        // same source `uptime` and `sysctl kern.boottime` print.
        let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
        let mut boot: libc::timeval = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::timeval>();
        // SAFETY: the mib names a value of exactly `timeval`'s size, and
        // `len` carries that size in and out.
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                (&mut boot as *mut libc::timeval).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || len != std::mem::size_of::<libc::timeval>() {
            return None;
        }
        Some(boot.tv_sec as u64 * 1_000 + boot.tv_usec as u64 / 1_000)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    /// `btime` from `/proc/stat`: the boot, in epoch seconds.
    fn boot_seconds() -> Option<u64> {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        stat.lines()
            .find_map(|line| line.strip_prefix("btime "))
            .and_then(|rest| rest.trim().parse().ok())
    }

    pub fn started_at_ms(pid: u32) -> Option<u64> {
        // `/proc/<pid>/stat` field 22, in clock ticks since boot — psutil's
        // `create_time` source. The command name (field 2) is the only field
        // that can hold spaces and parentheses, so the split starts after
        // the last `)`; index 19 of what follows is field 22.
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let after = stat.rfind(')')?;
        let ticks: u64 = stat[after + 1..].split_whitespace().nth(19)?.parse().ok()?;
        // SAFETY: `sysconf` reads a constant.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if hz <= 0 {
            return None;
        }
        Some(boot_seconds()? * 1_000 + ticks * 1_000 / hz as u64)
    }

    /// Field 3 of `/proc/<pid>/stat` — the state character, `Z` for a zombie.
    ///
    /// The same line `started_at_ms` reads, and the same `rfind(')')` trick
    /// for the same reason: field 2 is the command name and is the only field
    /// that may hold spaces and parentheses, so everything is counted from
    /// after the LAST `)`. State is the first field after it.
    pub fn is_zombie(pid: u32) -> Option<bool> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let after = stat.rfind(')')?;
        Some(stat[after + 1..].split_whitespace().next()? == "Z")
    }

    pub fn booted_at_ms() -> Option<u64> {
        boot_seconds().map(|s| s * 1_000)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    // No lookup: the answer is "cannot say", and a caller must not read
    // that as "different". The library lock fails closed on Windows for the
    // same reason (see `lock.rs`).
    pub fn started_at_ms(_pid: u32) -> Option<u64> {
        None
    }
    pub fn booted_at_ms() -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn this_process_started_after_the_boot_and_before_now() {
        let started = own_started_at_ms().expect("the OS knows when this process started");
        let booted = booted_at_ms().expect("the OS knows when it booted");
        let now = now_ms();
        assert!(
            booted < started,
            "boot {booted} must precede start {started}"
        );
        assert!(
            started <= now,
            "start {started} must not be in the future ({now})"
        );
        // The unit check: a start time in SECONDS or MICROSECONDS would land
        // outside [boot, now] by three orders of magnitude. Bounding against
        // the boot rather than a fixed "ten minutes" keeps the test honest
        // under a debugger, a suspended laptop, or a slow runner — the
        // process genuinely cannot have started before the machine did.
        assert!(
            (booted..=now).contains(&started),
            "start reads {started}, outside [boot {booted}, now {now}] — wrong unit?"
        );
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn a_reaped_child_has_no_start_time() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        /* A reused pid between the reap and this read would legitimately
         * answer with the REPLACEMENT's start — the flake window is one
         * statement wide and pid allocation on both platforms walks forward,
         * so it is accepted rather than engineered around. If this ever
         * fires, re-run before suspecting the code. */
        assert_eq!(started_at_ms(pid), None, "a pid that is gone has no start");
    }

    /// Kills its child even when an assertion panics — a `sleep 5` left
    /// running until its timer is a straggler every earlier failure leaked.
    struct Reaped(std::process::Child);
    impl Drop for Reaped {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn a_live_child_started_no_earlier_than_its_parent() {
        let child = Reaped(
            std::process::Command::new("sleep")
                .arg("5")
                .spawn()
                .unwrap(),
        );
        let mine = own_started_at_ms().unwrap();
        let theirs = started_at_ms(child.0.id()).expect("a live child has a start");
        assert!(theirs >= mine, "child {theirs} before parent {mine}");
    }
}
