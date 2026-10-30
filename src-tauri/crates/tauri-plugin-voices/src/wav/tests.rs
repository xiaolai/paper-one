//! The header's own bytes. That the PACKER accepts them is asserted in the app
//! crate, which is the only place both halves exist.

use super::{bytes, check_size, header, max_frames, HEADER_BYTES};

#[test]
fn the_header_is_canonical_riff_in_order() {
    let head = header(10, 24_000);
    assert_eq!(&head[0..4], b"RIFF");
    assert_eq!(&head[8..12], b"WAVE");
    assert_eq!(&head[12..16], b"fmt ");
    assert_eq!(&head[36..40], b"data");
    assert_eq!(head.len(), HEADER_BYTES);
}

#[test]
fn it_declares_mono_sixteen_bit_pcm_and_nothing_else() {
    // The packer's reader refuses every other shape by name, deliberately: a
    // tolerant one handed `afconvert`'s own WAV reads its padding chunk as the
    // audio and writes a book of silence.
    let head = header(10, 24_000);
    assert_eq!(u16::from_le_bytes([head[20], head[21]]), 1, "PCM");
    assert_eq!(u16::from_le_bytes([head[22], head[23]]), 1, "mono");
    assert_eq!(u16::from_le_bytes([head[34], head[35]]), 16, "16-bit");
}

#[test]
fn the_sizes_agree_with_each_other_and_with_the_samples() {
    let head = header(100, 24_000);
    let data = u32::from_le_bytes([head[40], head[41], head[42], head[43]]);
    let riff = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
    assert_eq!(data, 200, "two bytes to the frame");
    assert_eq!(riff, 236, "everything after the first eight bytes");
}

#[test]
fn the_byte_rate_and_block_align_follow_the_sample_rate() {
    let head = header(1, 48_000);
    assert_eq!(
        u32::from_le_bytes([head[24], head[25], head[26], head[27]]),
        48_000
    );
    assert_eq!(
        u32::from_le_bytes([head[28], head[29], head[30], head[31]]),
        96_000
    );
    assert_eq!(u16::from_le_bytes([head[32], head[33]]), 2);
}

#[test]
fn a_book_too_long_for_the_container_is_refused_by_name() {
    // ⚠️ About 24.9 hours at 24 kHz. The failure this prevents is a header
    // whose size field has wrapped: every reader then believes a length the
    // file does not have, and the book plays as a fraction of itself.
    check_size(max_frames()).expect("exactly the most it can hold");
    let err = check_size(max_frames() + 1).expect_err("one frame past it");
    assert!(
        err.contains("24.9 hours"),
        "the refusal says how long that is: {err}"
    );
    assert!(
        err.contains("container"),
        "and what a longer book needs: {err}"
    );
}

#[test]
fn the_file_is_the_header_and_then_the_samples() {
    let file = bytes(&[0, 1, -1], 24_000).expect("written");
    assert_eq!(file.len(), HEADER_BYTES + 6);
    assert_eq!(&file[HEADER_BYTES..], &[0, 0, 1, 0, 255, 255]);
}

#[test]
fn a_file_of_no_samples_is_still_a_valid_wav() {
    // The engines refuse an empty render, so this is the shape of that
    // refusal's absence rather than something a reader can reach — but a
    // header that is wrong for zero is wrong for the first chapter too.
    let file = bytes(&[], 24_000).expect("written");
    assert_eq!(file.len(), HEADER_BYTES);
    assert_eq!(
        u32::from_le_bytes([file[40], file[41], file[42], file[43]]),
        0
    );
}
