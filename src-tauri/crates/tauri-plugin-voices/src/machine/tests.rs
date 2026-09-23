//! The pure halves: the unit the platform answers in, and the rounding.

use super::{gb_from_bytes, mem_total_bytes, memory_gb, UNKNOWN};

#[test]
fn whole_gibibytes_are_rounded_down() {
    // ⚠️ DOWN, because the floor is a minimum: a pack asking for 8 GB on a
    // machine with 7.9 must not be offered, and rounding up would offer it.
    assert_eq!(gb_from_bytes(8 * 1024 * 1024 * 1024), 8);
    assert_eq!(gb_from_bytes(8 * 1024 * 1024 * 1024 - 1), 7);
    assert_eq!(gb_from_bytes(0), 0);
}

#[test]
fn a_machine_too_large_for_the_count_is_read_as_unknown() {
    // Not a machine that exists; the saturation is what stops a wrap making a
    // huge machine look like a tiny one, which would refuse it every pack.
    assert_eq!(gb_from_bytes(u64::MAX), UNKNOWN);
}

#[test]
fn meminfo_is_read_in_the_unit_it_states() {
    // ⚠️ `MemTotal` is KIBIBYTES. Read as bytes, a 16 GB machine reports 16 MB
    // and is refused every pack — the defect this parse exists for.
    let text = "MemTotal:       16305236 kB\nMemFree:         1000 kB\n";
    assert_eq!(mem_total_bytes(text), Some(16_305_236 * 1024));
    assert_eq!(gb_from_bytes(mem_total_bytes(text).expect("read")), 15);
}

#[test]
fn a_meminfo_it_cannot_read_answers_nothing() {
    assert_eq!(mem_total_bytes(""), None);
    assert_eq!(mem_total_bytes("MemFree: 100 kB\n"), None);
    assert_eq!(mem_total_bytes("MemTotal:       lots kB\n"), None);
    // A unit this does not know is refused rather than assumed to be bytes.
    assert_eq!(mem_total_bytes("MemTotal:       16 MB\n"), None);
}

#[test]
fn this_machine_answers_something_usable() {
    /* The one case that crosses to the real platform. It asserts a BAND rather
     * than a value — any machine running these tests has at least 1 GB, and
     * `UNKNOWN` means the read failed, which on macOS and Linux is a finding. */
    let gb = memory_gb();
    if cfg!(any(target_os = "macos", target_os = "linux")) {
        assert!(gb >= 1, "this machine reports {gb} GB");
        assert!(
            gb < UNKNOWN,
            "the memory read failed and fell back to unknown"
        );
    } else {
        assert_eq!(gb, UNKNOWN);
    }
    // Read twice, same answer: it is memoised and must not drift.
    assert_eq!(memory_gb(), gb);
}
