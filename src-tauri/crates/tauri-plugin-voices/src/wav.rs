//! The one WAV shape the audiobook packer reads.
//!
//! ⚠️ **THIS IS A WRITER FOR SOMEBODY ELSE'S READER, AND THAT IS THE WHOLE
//! CONSTRAINT.** `src/narrate/wav.rs` in the app crate accepts **mono 16-bit
//! PCM and nothing else**, by a deliberate decision recorded there: a tolerant
//! reader handed `afconvert`'s own output would read an `FLLR` padding chunk as
//! the audio and produce a book of silence with no error anywhere. So the
//! packer refuses every shape but this one, and this writes exactly it.
//!
//! The agreement is not assumed — `narrate::wav::read` is run over a file this
//! writes, in the app crate's own tests, which is the only place both halves
//! exist.

/// Bytes before the samples: `RIFF`, `fmt ` and `data`, canonical and in order.
pub const HEADER_BYTES: usize = 44;

/// What a 32-bit size field can state, leaving room for the 36 bytes the RIFF
/// size counts on top of the audio — and rounded DOWN to a whole frame.
///
/// ⚠️ **THIS IS THE APP'S `narrate::wav::MAX_DATA_BYTES`, TO THE BYTE, AND THE
/// FIRST VERSION WAS NOT.** It read `u32::MAX - HEADER_BYTES`, which is both
/// the wrong allowance and ODD — and an odd data length is not a whole number
/// of 16-bit samples, which that reader refuses as malformed. So the belt
/// against an unchecked length would have written a header no reader accepts.
/// The app found that in its own third pass on this arithmetic; this crate
/// found it on the first run of the agreement test, which is what that test is
/// for.
///
/// At 24 kHz mono this is about **24.9 hours**. Past it the container has to
/// be CAF, because a WAV cannot say how long the file is.
const MAX_DATA_BYTES: u32 = (u32::MAX - 36) & !1;

/// How many frames a WAV may hold at all.
#[must_use]
pub fn max_frames() -> u64 {
    u64::from(MAX_DATA_BYTES) / 2
}

/// Refuse a length this container cannot state, by name.
///
/// # Errors
/// When the samples would overflow the header's 32-bit size fields.
pub fn check_size(frames: u64) -> Result<(), String> {
    if frames > max_frames() {
        return Err(format!(
            "this is {frames} frames, and a WAV header can state {} — about 24.9 hours at 24 kHz. \
             A book this long needs a container that can say how long it is",
            max_frames()
        ));
    }
    Ok(())
}

/// The 44-byte header for mono 16-bit PCM.
///
/// # Panics
/// Never: `check_size` is the caller's, and every field below is derived from
/// values that fit once it has passed.
#[must_use]
pub fn header(frames: u64, sample_rate: u32) -> [u8; HEADER_BYTES] {
    let data = (frames * 2) as u32;
    let mut out = [0u8; HEADER_BYTES];
    out[0..4].copy_from_slice(b"RIFF");
    out[4..8].copy_from_slice(&(36 + data).to_le_bytes());
    out[8..12].copy_from_slice(b"WAVE");
    out[12..16].copy_from_slice(b"fmt ");
    out[16..20].copy_from_slice(&16u32.to_le_bytes());
    // 1 is PCM; 1 channel; 16 bits. The packer's reader checks all three.
    out[20..22].copy_from_slice(&1u16.to_le_bytes());
    out[22..24].copy_from_slice(&1u16.to_le_bytes());
    out[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    out[28..32].copy_from_slice(&(sample_rate * 2).to_le_bytes());
    out[32..34].copy_from_slice(&2u16.to_le_bytes());
    out[34..36].copy_from_slice(&16u16.to_le_bytes());
    out[36..40].copy_from_slice(b"data");
    out[40..44].copy_from_slice(&data.to_le_bytes());
    out
}

/// The whole file: header then samples, little-endian.
///
/// # Errors
/// When the samples are too many for the container to state.
pub fn bytes(samples: &[i16], sample_rate: u32) -> Result<Vec<u8>, String> {
    check_size(samples.len() as u64)?;
    let mut out = Vec::with_capacity(HEADER_BYTES + samples.len() * 2);
    out.extend_from_slice(&header(samples.len() as u64, sample_rate));
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
