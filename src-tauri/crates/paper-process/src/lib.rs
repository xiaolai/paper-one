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
/// cannot say.
pub fn booted_at_ms() -> Option<u64> {
    platform::booted_at_ms()
}

/// This process's own start, for writing into a record.
pub fn own_started_at_ms() -> Option<u64> {
    started_at_ms(std::process::id())
}

/// Now, as the same epoch milliseconds the answers above use.
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
        // A test binary is seconds old, not days: the unit is milliseconds.
        assert!(
            now - started < 10 * 60 * 1_000,
            "start reads {started} against now {now}"
        );
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn a_reaped_child_has_no_start_time() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert_eq!(started_at_ms(pid), None, "a pid that is gone has no start");
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn a_live_child_started_no_earlier_than_its_parent() {
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let mine = own_started_at_ms().unwrap();
        let theirs = started_at_ms(child.id()).expect("a live child has a start");
        assert!(theirs >= mine, "child {theirs} before parent {mine}");
        let _ = child.kill();
        let _ = child.wait();
    }
}
