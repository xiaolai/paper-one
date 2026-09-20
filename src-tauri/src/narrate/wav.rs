//! The WAV Paper writes between the speech engine and the encoder, both ways.
//!
//! It is a private format in practice — `narrate_render` writes these files and
//! `narrate_package` reads them back — which is exactly why the reader is
//! STRICT rather than general. A tolerant reader here would accept a file this
//! app did not write and quietly mis-describe it; refusing everything but the
//! one shape we emit means a surprise is a named error instead of a chapter of
//! noise.
//!
//! Mono 16-bit PCM throughout. The speech engine hands back float32 mono (see
//! `apple.rs`), and 16-bit is what the AAC encoder wants anyway.
//!
//! ⚠️ **AND THE STRICTNESS IS MEASURED, NOT A PREFERENCE.** `afconvert`'s own
//! WAV output carries a `FLLR` padding chunk exactly where this module writes
//! `data`, with 4 044 in its size field and 278 398 bytes of audio after it. A
//! reader that took the chunk at offset 36 on trust would have handed the
//! encoder 4 044 bytes of padding and called it a chapter — a book of silence,
//! written without an error anywhere. This one refuses the file by name
//! instead, which is why `narrate_package` reads only what `narrate_render`
//! wrote.

/// The canonical header this module writes, and the only one it will read.
pub const HEADER_BYTES: usize = 44;

/// A 16-bit sample from a float one, CLAMPED.
///
/// The engine hands back float32, and a float outside ±1 is not impossible — a
/// wrap-around would be an audible click in the middle of a word, where a clamp
/// is inaudible.
pub fn to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * f32::from(i16::MAX)) as i16
}

/// A 44-byte canonical WAV header for mono 16-bit PCM.
///
/// Written with the sizes it will have, which is why finalising a render has to
/// seek back and rewrite it: the frame count is not known until the engine has
/// finished.
pub fn header(frames: u64, sample_rate: u32) -> [u8; HEADER_BYTES] {
    let data_bytes = (frames * 2) as u32;
    let mut h = [0u8; HEADER_BYTES];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    h[32..34].copy_from_slice(&2u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits per sample
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

/// What a WAV this module wrote says about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    pub sample_rate: u32,
    pub frames: u64,
}

/* NO `duration_ms` HERE. It existed for one commit with no caller but a test —
 * `chapter_starts` works in FRAMES precisely so that forty chapters' rounding
 * cannot drift — and an accessor nothing reads is what `clippy -D warnings`
 * refuses. */

/// Read a header this module wrote, refusing anything else by name.
///
/// ⚠️ **THE DECLARED LENGTH IS CHECKED AGAINST THE BYTES THERE ARE.** A render
/// that was cut short — a full disk, a crash — leaves a header claiming a length
/// the file does not have. Trusting the header would hand the encoder a promise
/// of audio that is not there; the honest answer is the shorter of the two, and
/// a mismatch is worth saying out loud because it means a chapter is incomplete.
pub fn read(bytes: &[u8]) -> Result<Facts, String> {
    if bytes.len() < HEADER_BYTES {
        return Err(format!(
            "this is {} bytes long, which is not even a WAV header",
            bytes.len()
        ));
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("this is not a WAV file".to_owned());
    }
    if &bytes[12..16] != b"fmt " || &bytes[36..40] != b"data" {
        /* A general reader would walk the chunk list. This one does not, because
         * it reads only what `header` writes — and a file with chunks in another
         * order came from somewhere else, which is the thing worth reporting.
         * `afconvert` writes `FLLR` here; see the module header for what taking
         * that chunk's size on trust produces. */
        return Err(
            "this WAV is not in the shape Paper writes: fmt and data are not where they \
                    should be"
                .to_owned(),
        );
    }
    let format = u16::from_le_bytes([bytes[20], bytes[21]]);
    let channels = u16::from_le_bytes([bytes[22], bytes[23]]);
    let bits = u16::from_le_bytes([bytes[34], bytes[35]]);
    if format != 1 || channels != 1 || bits != 16 {
        return Err(format!(
            "Paper reads mono 16-bit PCM only, and this is format {format}, {channels} channel(s), \
             {bits}-bit"
        ));
    }
    let sample_rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
    if sample_rate == 0 {
        return Err("this WAV claims a sample rate of zero".to_owned());
    }
    let declared = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]) as usize;
    let present = bytes.len() - HEADER_BYTES;
    if declared > present {
        return Err(format!(
            "this WAV says it holds {declared} bytes of audio and holds {present}, so the render \
             that wrote it did not finish"
        ));
    }
    Ok(Facts {
        sample_rate,
        frames: (declared / 2) as u64,
    })
}

/// The audio bytes of a WAV this module wrote.
pub fn samples(bytes: &[u8]) -> Result<&[u8], String> {
    let facts = read(bytes)?;
    let end = HEADER_BYTES + (facts.frames * 2) as usize;
    Ok(&bytes[HEADER_BYTES..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(frames: u64, sample_rate: u32) -> Vec<u8> {
        let mut out = header(frames, sample_rate).to_vec();
        out.extend(std::iter::repeat_n(0x11, (frames * 2) as usize));
        out
    }

    #[test]
    fn the_header_states_the_sizes_twice_and_agrees_with_itself() {
        let h = header(22_050, 22_050);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(&h[8..12], b"WAVE");
        assert_eq!(&h[36..40], b"data");
        let data = u32::from_le_bytes(h[40..44].try_into().unwrap());
        let riff = u32::from_le_bytes(h[4..8].try_into().unwrap());
        assert_eq!(data, 22_050 * 2);
        assert_eq!(riff, 36 + data);
        assert_eq!(u16::from_le_bytes(h[22..24].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(h[34..36].try_into().unwrap()), 16);
        assert_eq!(
            u32::from_le_bytes(h[28..32].try_into().unwrap()),
            22_050 * 2
        );
    }

    #[test]
    fn what_it_writes_it_reads_back() {
        let facts = read(&wav(1000, 22_050)).expect("reads");
        assert_eq!(
            facts,
            Facts {
                sample_rate: 22_050,
                frames: 1000
            }
        );
        assert_eq!(samples(&wav(1000, 22_050)).unwrap().len(), 2000);
    }

    #[test]
    fn a_render_that_was_cut_short_is_a_named_failure() {
        /* The header promises more than the file holds — a full disk, a crash.
         * Believing it hands the encoder audio that is not there. */
        let mut short = wav(1000, 22_050);
        short.truncate(HEADER_BYTES + 500);
        let error = read(&short).expect_err("refuses");
        assert!(error.contains("did not finish"), "{error}");
    }

    #[test]
    fn it_refuses_a_file_that_is_not_a_wav() {
        assert!(read(b"not a wav at all, not even close ................").is_err());
        let error = read(&[0u8; 10]).expect_err("refuses");
        assert!(error.contains("not even a WAV header"), "{error}");
    }

    #[test]
    fn it_refuses_a_shape_it_did_not_write() {
        /* `FLLR` IS THE REAL CASE: it is what `afconvert` puts at offset 36, with
         * a size that describes the padding and not the audio. */
        let mut other = wav(10, 22_050);
        other[36..40].copy_from_slice(b"FLLR");
        let error = read(&other).expect_err("refuses");
        assert!(error.contains("not in the shape Paper writes"), "{error}");
    }

    #[test]
    fn it_refuses_stereo_and_anything_but_sixteen_bits() {
        let mut stereo = wav(10, 22_050);
        stereo[22..24].copy_from_slice(&2u16.to_le_bytes());
        assert!(read(&stereo).expect_err("refuses").contains("mono 16-bit"));

        let mut eight = wav(10, 22_050);
        eight[34..36].copy_from_slice(&8u16.to_le_bytes());
        assert!(read(&eight).expect_err("refuses").contains("mono 16-bit"));
    }

    #[test]
    fn it_refuses_a_sample_rate_of_zero_rather_than_dividing_by_it() {
        let zero = wav(10, 0);
        assert!(read(&zero)
            .expect_err("refuses")
            .contains("sample rate of zero"));
    }

    #[test]
    fn a_loud_sample_clamps_rather_than_wrapping() {
        assert_eq!(to_i16(0.0), 0);
        assert_eq!(to_i16(1.0), i16::MAX);
        assert_eq!(to_i16(-1.0), -i16::MAX);
        /* A wrap would put full-scale positive at full-scale NEGATIVE — an
         * audible click in the middle of a word. */
        assert_eq!(to_i16(2.5), i16::MAX);
        assert_eq!(to_i16(-2.5), -i16::MAX);
    }
}
