//! How much memory this machine has, for the one question that needs it.
//!
//! ⚠️ **THE FLOOR WAS DECLARED, TESTED AND NEVER ASKED.** `manifest::offered`
//! has filtered on the platform and the memory floor since WI-30.1, with a test
//! of its own — and `voices_catalogue` iterated `manifest.packs` directly, so
//! nothing ever called it. A 2.3 GB pack that needs 8 GB was offered to every
//! machine, and a macOS-only pack was offered on Windows and Linux. Found by
//! the 2026-09-23 audit, which reported `withinMemory` on the TypeScript side
//! as dead code; it was the same rule, written twice and applied nowhere.
//!
//! **No new dependency for one number.** `sysinfo` would be the obvious crate
//! and it is a large one to take for a single `u64`, so each platform is asked
//! the way it answers: `sysctl` on macOS — already the precedent for
//! `afconvert` — and `/proc/meminfo` on Linux.

use std::sync::OnceLock;

/// Bytes in a gibibyte.
const GIB: u64 = 1024 * 1024 * 1024;

/// What a machine whose memory cannot be read is treated as having.
///
/// ⚠️ **EVERYTHING, DELIBERATELY.** The failure this avoids is the worse one:
/// a reader whose machine could run a pack being offered nothing at all, with
/// no explanation and no way to override it. An unreadable answer means the
/// check cannot be made, and a check that cannot be made must not refuse.
pub const UNKNOWN: u32 = u32::MAX;

/// This machine's memory in whole gibibytes, rounded DOWN.
///
/// Rounded down because the floor is a minimum: a pack asking for 8 GB on a
/// machine with 7.9 must not be offered, and rounding up would offer it.
///
/// Read once. The pane polls the catalogue every few seconds and this cannot
/// change while the app runs.
pub fn memory_gb() -> u32 {
    static READ: OnceLock<u32> = OnceLock::new();
    *READ.get_or_init(read_memory_gb)
}

/// Whole gibibytes, rounded down, saturating into a `u32`.
#[must_use]
pub fn gb_from_bytes(bytes: u64) -> u32 {
    u32::try_from(bytes / GIB).unwrap_or(UNKNOWN)
}

/// The `MemTotal` line of `/proc/meminfo`, in bytes.
///
/// It is stated in kibibytes — `MemTotal:       16305236 kB` — which is why
/// this is a parse rather than a read: taking the number as bytes would report
/// a 16 GB machine as having 16 MB and refuse it every pack.
#[must_use]
pub fn mem_total_bytes(meminfo: &str) -> Option<u64> {
    for line in meminfo.lines() {
        let Some(rest) = line.strip_prefix("MemTotal:") else {
            continue;
        };
        let mut parts = rest.split_whitespace();
        let value: u64 = parts.next()?.parse().ok()?;
        // The unit is always kB in practice; anything else is refused rather
        // than assumed, because assuming it is the defect above.
        return match parts.next() {
            Some("kB") | Some("KB") => value.checked_mul(1024),
            None => Some(value),
            Some(_) => None,
        };
    }
    None
}

#[cfg(target_os = "macos")]
fn read_memory_gb() -> u32 {
    let Ok(out) = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
    else {
        return UNKNOWN;
    };
    if !out.status.success() {
        return UNKNOWN;
    }
    match String::from_utf8_lossy(&out.stdout).trim().parse::<u64>() {
        Ok(bytes) if bytes > 0 => gb_from_bytes(bytes),
        _ => UNKNOWN,
    }
}

#[cfg(target_os = "linux")]
fn read_memory_gb() -> u32 {
    match std::fs::read_to_string("/proc/meminfo") {
        Ok(text) => mem_total_bytes(&text).map_or(UNKNOWN, gb_from_bytes),
        Err(_) => UNKNOWN,
    }
}

/// ⚠️ **WINDOWS HAS NO DEPENDENCY-FREE ANSWER**, so it is not asked. Every pack
/// declares `platforms: ["macos"]` today, so nothing is offered there at all
/// and this decides nothing; the day a pack is offered on Windows, this is the
/// line that has to grow a real reading rather than a silent allow.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_memory_gb() -> u32 {
    UNKNOWN
}

#[cfg(test)]
mod tests;
