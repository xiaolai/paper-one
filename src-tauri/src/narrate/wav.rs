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
/// ⚠️ **IT SERVES THE TESTS ALONE NOW, AND IS GATED TO SAY SO.** The engine
/// that handed back float32 was `narrate_render` over AVSpeechSynthesizer,
/// deleted in phase 30; the downloadable engines answer 16-bit PCM already. It
/// is kept because the packager's own cases build synthetic audio with it, and
/// ungated it is `dead_code` in a release build — which `-D warnings` makes a
/// failed build, on Linux first.
///
/// A wrap-around would be an audible click in the middle of a word, where a
/// clamp is inaudible.
#[cfg(test)]
pub fn to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * f32::from(i16::MAX)) as i16
}

/// The largest frame count a classic WAV can describe.
///
/// ⚠️ **THE SIZE FIELDS ARE 32 BITS, AND A LONG AUDIOBOOK REACHES THEM.** At
/// 22 050 Hz mono 16-bit that is about 27 hours — not a hypothetical for a
/// joined book. Past it the header silently wraps and the encoder is handed a
/// file describing a fraction of itself.
pub const MAX_FRAMES: u64 = (MAX_DATA_BYTES / 2) as u64;

/// The most audio a classic WAV can describe, leaving room for the 36 bytes the
/// RIFF size counts on top of it — and rounded DOWN to a whole 16-bit frame.
///
/// ⚠️ **`u32::MAX - 36` IS ODD.** Clamping to it produced a data length that is
/// not a whole number of samples, which `read` then refuses as malformed — so the
/// belt against an unchecked length wrote a header no reader would accept. Found
/// in the third verification pass, after two rounds on this same arithmetic.
const MAX_DATA_BYTES: u32 = (u32::MAX - 36) & !1;

/// The highest sample rate whose byte rate still fits the header's 32-bit field.
const MAX_SAMPLE_RATE: u32 = u32::MAX / 2;

/// Refuse a length this format cannot state, by name.
pub fn check_size(frames: u64) -> Result<(), String> {
    if frames > MAX_FRAMES {
        return Err(format!(
            "this book is {frames} frames long and a WAV can describe {MAX_FRAMES}; it is too \
             long to join in one file"
        ));
    }
    Ok(())
}

/// A 44-byte canonical WAV header for mono 16-bit PCM.
///
/// Written with the sizes it will have, which is why finalising a render has to
/// seek back and rewrite it: the frame count is not known until the engine has
/// finished.
pub fn header(frames: u64, sample_rate: u32) -> [u8; HEADER_BYTES] {
    /* CLAMPED TO WHAT THE *WHOLE HEADER* CAN STATE, not to what the data field
     * can hold. The first version saturated `frames * 2` at `u32::MAX`, which
     * left `36 + data_bytes` to overflow one line down — so a length just past
     * the limit produced a RIFF size smaller than the file. `check_size` is the
     * refusal callers owe; this is the belt, and a belt that overflows is not
     * one. */
    let data_bytes = u32::try_from(frames.saturating_mul(2))
        .unwrap_or(MAX_DATA_BYTES)
        .min(MAX_DATA_BYTES);
    let mut h = [0u8; HEADER_BYTES];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
                                                    /* The byte rate is the rate times two, and a rate above half of `u32::MAX`
                                                     * cannot state it. Written as the clamped pair so the two fields agree with
                                                     * each other; `read` refuses such a rate outright. */
    let rate = sample_rate.min(MAX_SAMPLE_RATE);
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * 2).to_le_bytes()); // byte rate
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
    if sample_rate > MAX_SAMPLE_RATE {
        return Err(format!(
            "this WAV claims a sample rate of {sample_rate}Hz, whose byte rate the header cannot \
             state"
        ));
    }
    let declared = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]) as usize;
    let present = bytes.len() - HEADER_BYTES;
    /* ⚠️ **EQUALITY, NOT `<=`.** The check was one-sided: a header claiming MORE
     * than the file holds was refused, but one claiming LESS was accepted and
     * the extra audio silently dropped — which is exactly what a stale
     * zero-length placeholder header looks like, and it would have packaged a
     * chapter as silence. */
    if declared != present {
        return Err(format!(
            "this WAV says it holds {declared} bytes of audio and holds {present}, so the render \
             that wrote it did not finish"
        ));
    }
    /* An odd byte count cannot be whole 16-bit frames. Rounding it down loses a
     * sample and hides the fact that the file is malformed. */
    if !declared.is_multiple_of(2) {
        return Err(format!(
            "this WAV declares {declared} bytes of 16-bit audio, which is not a whole number of \
             samples"
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

#[cfg(all(test, feature = "desktop"))]
mod voices_agreement {
    //! ⚠️ **THE ONLY PLACE BOTH HALVES EXIST.**
    //!
    //! The audiobook export renders chapters through the voices plugin now,
    //! and that crate writes the WAV itself — it cannot call this module,
    //! because this one lives in the app and the plugin is underneath it. Two
    //! writers for one reader is exactly the shape this repository keeps
    //! having to fix, so the agreement is ASSERTED rather than assumed: a file
    //! that crate writes is read back here, by the reader the packer uses.
    //!
    //! If this ever fails, the two have drifted and a chapter will be joined
    //! as silence or refused — neither of which the plugin's own tests can
    //! see.

    use super::read;

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
                super::header(frames, rate).as_slice(),
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
        assert!(super::check_size(most).is_ok());
        assert!(tauri_plugin_voices::wav::check_size(most).is_ok());
        assert!(super::check_size(most + 1).is_err());
        assert!(tauri_plugin_voices::wav::check_size(most + 1).is_err());
    }
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

    /// ⚠️ **THE CHECK WAS ONE-SIDED AND THIS IS THE HALF IT MISSED.** A header
    /// claiming LESS than the file holds is what a stale zero-length placeholder
    /// looks like — a render that wrote its header, crashed, and left the audio
    /// unaccounted for. It was accepted, and the audio silently dropped.
    #[test]
    fn a_header_that_understates_the_audio_is_refused() {
        let mut stale = wav(1000, 22_050);
        stale[40..44].copy_from_slice(&0u32.to_le_bytes());
        let error = read(&stale).expect_err("refuses");
        assert!(error.contains("did not finish"), "{error}");
    }

    #[test]
    fn an_odd_byte_count_is_not_whole_samples() {
        let mut odd = wav(1000, 22_050);
        odd.push(0);
        odd[40..44].copy_from_slice(&2001u32.to_le_bytes());
        let error = read(&odd).expect_err("refuses");
        assert!(error.contains("whole number of samples"), "{error}");
    }

    /// ⚠️ **A WAV STATES ITS LENGTH IN 32 BITS**, so a joined audiobook past
    /// about 27 hours at 22 050Hz wraps the header and describes a fraction of
    /// itself. Refused by name before anything is written.
    #[test]
    fn a_book_too_long_for_the_format_is_refused() {
        assert!(check_size(MAX_FRAMES).is_ok());
        let error = check_size(MAX_FRAMES + 1).expect_err("refuses");
        assert!(error.contains("too long to join"), "{error}");
        /* 27 hours is the scale, so the limit must be near it rather than near
        an hour — a bound checked only against itself proves nothing. */
        let hours = MAX_FRAMES / 22_050 / 3600;
        assert!((26..=28).contains(&hours), "limit is {hours} hours");
    }

    /// ⚠️ **`header` HAD TO BE SOUND ON ITS OWN, AND THE FIRST FIX LEFT IT
    /// OVERFLOWING.** Saturating the data field still let `36 + data_bytes` wrap
    /// one line later, so a length past the limit produced a RIFF size SMALLER
    /// than the file it described. The audit caught it in verification.
    #[test]
    fn the_header_stays_coherent_at_and_past_the_limit() {
        for frames in [MAX_FRAMES, MAX_FRAMES + 1, u64::MAX] {
            let h = header(frames, 22_050);
            let data = u32::from_le_bytes(h[40..44].try_into().unwrap());
            let riff = u32::from_le_bytes(h[4..8].try_into().unwrap());
            assert_eq!(riff, 36 + data, "riff and data disagree at {frames} frames");
            assert!(data <= MAX_DATA_BYTES);
            /* WHOLE SAMPLES, which the clamp itself got wrong once: an odd
             * length is one `read` refuses, so the belt must not write one. */
            assert_eq!(data % 2, 0, "an odd data length at {frames} frames");
            /* AND THE RATE PAIR STAYS CONSISTENT at an unrepresentable rate. */
            let h = header(frames, u32::MAX);
            let rate = u32::from_le_bytes(h[24..28].try_into().unwrap());
            let byte_rate = u32::from_le_bytes(h[28..32].try_into().unwrap());
            assert_eq!(byte_rate, rate * 2, "rate and byte rate disagree");
        }
    }

    #[test]
    fn a_rate_whose_byte_rate_cannot_be_stated_is_refused() {
        let mut fast = wav(10, 22_050);
        fast[24..28].copy_from_slice(&(MAX_SAMPLE_RATE + 1).to_le_bytes());
        let error = read(&fast).expect_err("refuses");
        assert!(error.contains("byte rate"), "{error}");
    }

    #[test]
    fn a_render_that_produced_no_audio_reads_as_none() {
        /* A header with a zero length and no audio after it is CONSISTENT — it is
        what a render that wrote its header and produced nothing looks like.
        `read` accepts it and reports zero frames; refusing an empty chapter is
        `package`'s job, where the chapter's title can be named. */
        let empty = wav(0, 22_050);
        assert_eq!(
            read(&empty).expect("reads"),
            Facts {
                sample_rate: 22_050,
                frames: 0
            }
        );
        assert!(samples(&empty).expect("no samples").is_empty());
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
