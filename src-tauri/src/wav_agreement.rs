//! The voices plugin writes the WAV a chapter is rendered to, and the narration
//! plugin's packer reads it back. Neither crate depends on the other, so the
//! app — the only crate that links both — is where they are held to one shape.
//!
//! ⚠️ **THE ONLY PLACE BOTH HALVES EXIST.** Moved here from `narrate/wav.rs` when
//! that module left the app for `tauri-plugin-narration`, 2026-11-09.
//!
//! Two writers for one reader is exactly the shape this repository keeps having
//! to fix, so the agreement is ASSERTED rather than assumed: a file the voices
//! crate writes is read back by the reader the packer uses. If this ever fails,
//! the two have drifted and a chapter will be joined as silence or refused —
//! neither of which either plugin's own tests can see.

use tauri_plugin_narration::narrate::wav::{check_size, header, read};

#[test]
fn the_packer_reads_what_the_voices_crate_writes() {
    let samples: Vec<i16> = (0..2_400).map(|i| ((i % 400) as i16) * 40).collect();
    let file = tauri_plugin_voices::wav::bytes(&samples, 24_000).expect("written");
    let facts = read(&file).expect("the packer's own reader accepts it");
    assert_eq!(facts.sample_rate, 24_000);
    assert_eq!(facts.frames, 2_400, "every sample, and no padding chunk");
}

#[test]
fn the_two_headers_are_byte_for_byte_the_same() {
    // Stronger than "it parses": a difference anywhere in the 44 bytes is
    // a difference one of the two will eventually read differently.
    for (frames, rate) in [(0u64, 24_000u32), (1, 24_000), (2_400, 48_000)] {
        assert_eq!(
            header(frames, rate).as_slice(),
            tauri_plugin_voices::wav::header(frames, rate).as_slice(),
            "{frames} frames at {rate} Hz"
        );
    }
}

#[test]
fn they_refuse_the_same_length() {
    // The cap is about 24.9 hours at 24 kHz. One crate allowing a length
    // the other refuses is a chapter that writes and will not join.
    let most = tauri_plugin_voices::wav::max_frames();
    assert!(check_size(most).is_ok());
    assert!(tauri_plugin_voices::wav::check_size(most).is_ok());
    assert!(check_size(most + 1).is_err());
    assert!(tauri_plugin_voices::wav::check_size(most + 1).is_err());
}
