//! An `.m4b` written by hand, from an AAC stream and a list of chapters.
//!
//! PURE RUST, NO FRAMEWORK, and that is the whole reason this file exists.
//! `AVAssetWriter` can author a chapter track, but only through
//! `CMSampleBuffer`s built from `CMBlockBuffer`s with a `CMFormatDescription` —
//! several hundred lines of unsafe FFI whose failures are discovered one compile
//! cycle at a time. Laying out the container here is more bytes and no risk:
//! every box is a function, every function has a test, and the whole thing runs
//! on a machine with no AVFoundation at all.
//!
//! The audio arrives already encoded — `afconvert -f adts` is the system's own
//! encoder and is on every Mac — so nothing here decides anything about sound.
//! What it decides is the container, which is where the traps are.
//!
//! ## Two traps, both measured, both of which produce a file that looks fine
//!
//! ⚠️ **A v0 `tkhd` IS 92 BYTES AND THE OBVIOUS ONE IS 88.** There is a 4-byte
//! reserved field between `track_ID` and `duration`. Leave it out and every
//! field after it shifts: **ffmpeg recovers and reads the file correctly, while
//! AVFoundation refuses the track and reports `tracks=0`, `duration=0`** — and
//! still reads the metadata, so the file opens, names itself, and plays nothing.
//! In VLC it is perfect; in Apple Books it is empty. Found by comparing box
//! SIZES against a file `afconvert` wrote, not by reading the spec again.
//!
//! ⚠️ **A QUICKTIME TEXT SAMPLE HAS NO ENCODING FIELD.** Plain UTF-8 is read as
//! a legacy single-byte encoding: `第三章` came back from AVFoundation as
//! `Á¨¨‰∏âÁ´†`. A byte-order mark and UTF-16 does not fix it either — that came
//! back as `˛ˇ C h a p t e r`. What works is UTF-8 followed by an `encd` atom
//! naming the encoding. ⚠️ **AND ffprobe READ ALL THREE SPELLINGS CORRECTLY**, so
//! a one-reader check would have passed every one of them. Both readers, every
//! time.
//!
//! ## What is deliberately simple
//!
//! ONE CHUNK PER TRACK, so `stco` is a single offset and the layout cannot get
//! out of step with itself. A file meant for progressive download over a network
//! would interleave; an audiobook is read off local disk.
//!
//! NO EDIT LIST. An AAC stream opens with roughly 2 112 samples of encoder
//! priming, which an `elst` would trim. Untrimmed it shifts everything by about
//! 48 ms — inaudible in speech, and constant, so chapter marks stay in step with
//! the words. Worth adding the day something needs sample-accurate alignment;
//! stated here so nobody has to rediscover why the file is a frame long.

use std::path::Path;

/// The sampling frequencies an ADTS header's 4-bit index can name.
const SAMPLE_RATES: [u32; 13] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/// Every AAC-LC frame carries exactly this many samples, which is what turns a
/// frame count into a duration without decoding anything.
const SAMPLES_PER_FRAME: u32 = 1024;

/// `kCFStringEncodingUTF8`, as an `encd` atom states it.
const ENCODING_UTF8: u32 = 0x0800_0100;

/// The track ids. The audio track's `tref/chap` names the text track by id, so
/// the two constants have to agree and are therefore written once.
const AUDIO_TRACK: u32 = 1;
const TEXT_TRACK: u32 = 2;

/// One chapter: where it starts, and what it is called.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chapter {
    pub title: String,
    pub start_ms: u64,
}

/// What the file says about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BookMeta {
    pub title: String,
    pub author: String,
}

/// An AAC stream, measured but not decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aac {
    /// Byte ranges of each frame's payload, with the ADTS header stripped —
    /// an MP4 sample is the payload alone.
    frames: Vec<(usize, usize)>,
    sample_rate: u32,
    channels: u8,
    /// `audioObjectType - 1`, as an ADTS header spells it.
    profile: u8,
    frequency_index: u8,
}

impl Aac {
    /* NO `frame_count` OR `sample_rate` ACCESSOR. Both existed for one commit and
     * nothing outside this module's own tests called either — which `dead_code`
     * reported and `clippy -D warnings` refused. The tests read the fields
     * directly, being in the same module, and a getter arrives when a caller
     * does. */

    /// Whole milliseconds of audio, from the frame count alone.
    pub fn duration_ms(&self) -> u64 {
        let samples = self.frames.len() as u64 * u64::from(SAMPLES_PER_FRAME);
        samples * 1000 / u64::from(self.sample_rate)
    }
}

/// Read an ADTS stream's frame boundaries and format.
///
/// ⚠️ **EVERY REFUSAL IS BY NAME.** A stream that is not ADTS, a reserved
/// frequency index and a frame claiming more bytes than exist all produce a
/// container that a player opens and cannot play — so none of them may be
/// skipped quietly. The alternative, resynchronising on the next syncword, would
/// silently drop audio from the middle of a chapter.
pub fn parse_aac(bytes: &[u8]) -> Result<Aac, String> {
    let mut frames = Vec::new();
    let mut at = 0usize;
    let mut format: Option<(u32, u8, u8, u8)> = None;

    while at + 7 <= bytes.len() {
        if bytes[at] != 0xff || (bytes[at + 1] & 0xf0) != 0xf0 {
            return Err(format!(
                "this is not an ADTS stream: no syncword at byte {at}"
            ));
        }
        /* A frame with a CRC carries two more header bytes, and the MP4 sample
         * is the payload after the whole header either way. */
        let header = if bytes[at + 1] & 0x01 == 1 { 7 } else { 9 };
        let profile = (bytes[at + 2] >> 6) & 0x03;
        let frequency_index = (bytes[at + 2] >> 2) & 0x0f;
        let channels = ((bytes[at + 2] & 0x01) << 2) | ((bytes[at + 3] >> 6) & 0x03);
        let sample_rate = *SAMPLE_RATES.get(frequency_index as usize).ok_or_else(|| {
            format!(
                "the stream names sampling frequency index {frequency_index}, which is reserved"
            )
        })?;

        let length = (((bytes[at + 3] as usize) & 0x03) << 11)
            | ((bytes[at + 4] as usize) << 3)
            | ((bytes[at + 5] as usize) >> 5);
        if length <= header || at + length > bytes.len() {
            return Err(format!(
                "the frame at byte {at} claims {length} bytes, which runs past the end of the stream"
            ));
        }

        /* THE FORMAT MUST NOT CHANGE MID-STREAM. One `stsd` entry describes every
         * sample, so a stream that switched rate or channel count would be
         * described by the first frame's format and decoded wrongly from the
         * switch onward — which sounds like a corrupted chapter. */
        match format {
            None => format = Some((sample_rate, channels, profile, frequency_index)),
            Some(first) if first != (sample_rate, channels, profile, frequency_index) => {
                return Err(format!(
                    "the stream changes format at byte {at}, which one sample description cannot \
                     describe"
                ));
            }
            Some(_) => {}
        }

        /* ⚠️ **A FRAME MAY CARRY UP TO FOUR RAW BLOCKS**, and every sample here
         * is counted as exactly 1024. `afconvert` emits one block a frame, so
         * this has never fired — but a stream that did would get a duration and
         * a sample table wrong by a factor of up to four, which is a book whose
         * chapter marks drift further apart the longer it plays. */
        let blocks = bytes[at + 6] & 0x03;
        if blocks != 0 {
            return Err(format!(
                "the frame at byte {at} carries {} raw blocks; Paper writes one sample per frame \
                 and cannot describe it",
                blocks + 1
            ));
        }

        frames.push((at + header, at + length));
        at += length;
    }

    if at != bytes.len() {
        return Err(format!(
            "the stream has {} trailing bytes that are not a frame",
            bytes.len() - at
        ));
    }
    let (sample_rate, channels, profile, frequency_index) =
        format.ok_or_else(|| "the stream holds no AAC frames at all".to_owned())?;
    /* ⚠️ **`channel_configuration` IS NOT ALWAYS A CHANNEL COUNT.** 0 means the
     * count lives in a program configuration element this does not parse, and 7
     * means eight channels rather than seven — so writing it straight into
     * `mp4a` would describe the wrong track. Speech is mono; anything else is
     * refused rather than guessed at. */
    if channels != 1 && channels != 2 {
        return Err(format!(
            "the stream declares channel configuration {channels}, and Paper writes mono or \
             stereo only"
        ));
    }
    /* A rate above 65 535 cannot be stated in `mp4a`'s 16.16 field, so the
     * track would contradict itself. The speech engine answers 22 050. */
    if sample_rate > u32::from(u16::MAX) {
        return Err(format!(
            "the stream is {sample_rate}Hz, which an MP4 sound sample description cannot state"
        ));
    }
    Ok(Aac {
        frames,
        sample_rate,
        channels,
        profile,
        frequency_index,
    })
}

// ---------------------------------------------------------------- box writing

fn be32(v: u32) -> [u8; 4] {
    v.to_be_bytes()
}

fn be16(v: u16) -> [u8; 2] {
    v.to_be_bytes()
}

/// A box: a 32-bit size including the header, a four-character type, a payload.
fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(&be32((body.len() + 8) as u32));
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

/// A full box — one with a version and 24 bits of flags before its payload.
fn fbx(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(body.len() + 4);
    b.push(version);
    b.extend_from_slice(&flags.to_be_bytes()[1..]);
    b.extend_from_slice(body);
    bx(kind, &b)
}

fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

/// A track header.
///
/// ⚠️ **92 BYTES, NOT 88** — see the module header. The reserved word after
/// `track_ID` is the one this file lost once, and the test below is there so it
/// cannot be lost again without something going red.
fn tkhd(id: u32, duration_ms: u64, enabled: bool) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&be32(0)); // creation time
    body.extend_from_slice(&be32(0)); // modification time
    body.extend_from_slice(&be32(id));
    body.extend_from_slice(&be32(0)); // reserved — THE ONE THAT MATTERS
    body.extend_from_slice(&be32(duration_ms as u32));
    body.extend_from_slice(&[0; 8]); // reserved
    body.extend_from_slice(&be16(0)); // layer
    body.extend_from_slice(&be16(0)); // alternate group
    body.extend_from_slice(&be16(0x0100)); // volume 1.0
    body.extend_from_slice(&be16(0)); // reserved
    body.extend_from_slice(&unity_matrix());
    body.extend_from_slice(&be32(0)); // width
    body.extend_from_slice(&be32(0)); // height
                                      /* Flag 1 is `enabled`, flag 2 is `in movie`. The chapter track is written
                                       * NOT enabled: a player reads it for titles rather than playing it, and an
                                       * enabled text track is offered to the reader as a subtitle stream. */
    fbx(
        b"tkhd",
        0,
        if enabled { 0x00_0003 } else { 0x00_0002 },
        &body,
    )
}

/// The 3×3 transform every track carries, as the identity.
fn unity_matrix() -> Vec<u8> {
    let mut out = Vec::with_capacity(36);
    for value in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        out.extend_from_slice(&be32(value));
    }
    out
}

fn mdhd(timescale: u32, duration: u64) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&be32(0));
    body.extend_from_slice(&be32(0));
    body.extend_from_slice(&be32(timescale));
    body.extend_from_slice(&be32(duration as u32));
    body.extend_from_slice(&be16(0x55c4)); // language: `und`
    body.extend_from_slice(&be16(0));
    fbx(b"mdhd", 0, 0, &body)
}

fn hdlr(kind: &[u8; 4], name: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0; 4]); // predefined
    body.extend_from_slice(kind);
    body.extend_from_slice(&[0; 12]); // reserved
    body.extend_from_slice(name.as_bytes());
    body.push(0);
    fbx(b"hdlr", 0, 0, &body)
}

/// Self-contained media: the data is in this file, so the reference is empty.
fn dinf() -> Vec<u8> {
    let url = fbx(b"url ", 0, 1, &[]);
    let dref = fbx(b"dref", 0, 0, &cat(&[be32(1).to_vec(), url]));
    bx(b"dinf", &dref)
}

/// The `esds` descriptor, carrying an AudioSpecificConfig for AAC-LC.
fn esds(aac: &Aac) -> Vec<u8> {
    /* AudioSpecificConfig, bit-packed: 5 bits object type, 4 bits frequency
     * index, 4 bits channel configuration, then three GA flags left at zero. */
    let object_type = aac.profile + 1;
    let config = [
        (object_type << 3) | (aac.frequency_index >> 1),
        ((aac.frequency_index & 0x01) << 7) | (aac.channels << 3),
    ];

    /* Short-form lengths throughout: every descriptor here is well under 128
     * bytes, which is what makes a one-byte length legal. */
    fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag, body.len() as u8];
        out.extend_from_slice(body);
        out
    }

    let mut decoder = vec![0x40 /* MPEG-4 audio */, 0x15 /* audio stream */];
    decoder.extend_from_slice(&[0, 0, 0]); // buffer size
    decoder.extend_from_slice(&be32(0)); // maximum bitrate
    decoder.extend_from_slice(&be32(0)); // average bitrate
    decoder.extend_from_slice(&descriptor(0x05, &config));

    let mut es = Vec::new();
    es.extend_from_slice(&be16(1)); // elementary stream id
    es.push(0); // flags
    es.extend_from_slice(&descriptor(0x04, &decoder));
    es.extend_from_slice(&descriptor(0x06, &[0x02])); // SL config: predefined

    fbx(b"esds", 0, 0, &descriptor(0x03, &es))
}

fn mp4a(aac: &Aac) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0; 6]); // reserved
    body.extend_from_slice(&be16(1)); // data reference index
    body.extend_from_slice(&[0; 8]); // version, revision, vendor
    body.extend_from_slice(&be16(u16::from(aac.channels)));
    body.extend_from_slice(&be16(16)); // bits per sample
    body.extend_from_slice(&be16(0)); // compression id
    body.extend_from_slice(&be16(0)); // packet size
                                      /* 16.16 FIXED POINT, so a rate above 65 535 cannot be stated here at all —
                                       * which is why `mdhd`'s timescale is the rate that actually decides
                                       * playback, and this field is the legacy echo of it. */
    body.extend_from_slice(&be16(aac.sample_rate as u16));
    body.extend_from_slice(&be16(0));
    body.extend_from_slice(&esds(aac));
    bx(b"mp4a", &body)
}

/// The QuickTime text sample description.
fn text_sample_entry() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0; 6]); // reserved
    body.extend_from_slice(&be16(1)); // data reference index
    body.extend_from_slice(&be32(0)); // display flags
    body.extend_from_slice(&be32(1)); // text justification
    body.extend_from_slice(&[0; 6]); // background colour
    body.extend_from_slice(&[0; 8]); // default text box
    body.extend_from_slice(&[0; 8]); // reserved
    body.extend_from_slice(&be16(0)); // font number
    body.extend_from_slice(&be16(0)); // font face
    body.push(0); // reserved (8-bit)
                  /* ⚠️ **16 BITS, AND THIS WAS ONE BYTE.** The entry came out a byte short, so
                   * the foreground colour and the font name after it sat at the wrong offsets.
                   * AVFoundation tolerated it and the chapters still read back — which is
                   * exactly why it survived: a malformed box that one reader forgives is a
                   * box the next reader rejects. */
    body.extend_from_slice(&be16(0)); // reserved (16-bit)
    body.extend_from_slice(&[0; 6]); // foreground colour
    body.push(0); // font name: none
    bx(b"text", &body)
}

/// A text track's media header — generic, where audio has `smhd`.
fn gmhd() -> Vec<u8> {
    let mut gmin_body = Vec::new();
    gmin_body.extend_from_slice(&be16(0x40)); // graphics mode: copy
    gmin_body.extend_from_slice(&[0; 6]); // operation colour
    gmin_body.extend_from_slice(&be16(0)); // balance
    gmin_body.extend_from_slice(&be16(0)); // reserved
    let gmin = fbx(b"gmin", 0, 0, &gmin_body);
    let text = bx(b"text", &unity_matrix());
    bx(b"gmhd", &cat(&[gmin, text]))
}

/// A sample table. `deltas` is `(count, duration)` runs, in the media's timescale.
fn stbl(entry: Vec<u8>, sizes: &[u32], deltas: &[(u32, u32)], chunk_offset: u32) -> Vec<u8> {
    let stsd = fbx(b"stsd", 0, 0, &cat(&[be32(1).to_vec(), entry]));

    let mut stts_body = be32(deltas.len() as u32).to_vec();
    for (count, delta) in deltas {
        stts_body.extend_from_slice(&be32(*count));
        stts_body.extend_from_slice(&be32(*delta));
    }
    let stts = fbx(b"stts", 0, 0, &stts_body);

    let mut stsc_body = be32(1).to_vec();
    stsc_body.extend_from_slice(&be32(1)); // first chunk
    stsc_body.extend_from_slice(&be32(sizes.len() as u32)); // samples in it
    stsc_body.extend_from_slice(&be32(1)); // sample description index
    let stsc = fbx(b"stsc", 0, 0, &stsc_body);

    /* A zero `sample_size` means "they vary, and here they all are". A single
     * fixed size would be wrong for AAC, whose frames differ. */
    let mut stsz_body = be32(0).to_vec();
    stsz_body.extend_from_slice(&be32(sizes.len() as u32));
    for size in sizes {
        stsz_body.extend_from_slice(&be32(*size));
    }
    let stsz = fbx(b"stsz", 0, 0, &stsz_body);

    let stco = fbx(
        b"stco",
        0,
        0,
        &cat(&[be32(1).to_vec(), be32(chunk_offset).to_vec()]),
    );

    bx(b"stbl", &cat(&[stsd, stts, stsc, stsz, stco]))
}

/// One chapter's sample: a byte count, the title as UTF-8, and an `encd` atom
/// saying so.
///
/// ⚠️ **THE `encd` IS NOT OPTIONAL** — see the module header for the two
/// spellings that came back as mojibake without it, and for why ffprobe cannot
/// be the judge of this.
pub fn text_sample(title: &str) -> Result<Vec<u8>, String> {
    let utf8 = title.as_bytes();
    /* ⚠️ **THE LENGTH IS 16 BITS AND THE TITLE COMES FROM THE BOOK.** A table of
     * contents entry longer than 65 535 bytes wrapped the count and left the
     * rest of the title to be read as extension atoms — a malformed file built
     * from a stranger's EPUB. Refused by name; nothing truncates a title
     * silently. */
    if utf8.len() > usize::from(u16::MAX) {
        return Err(format!(
            "a chapter title is {} bytes long and the format allows {}",
            utf8.len(),
            u16::MAX
        ));
    }
    let mut out = Vec::with_capacity(utf8.len() + 14);
    out.extend_from_slice(&be16(utf8.len() as u16));
    out.extend_from_slice(utf8);
    out.extend_from_slice(&bx(b"encd", &be32(ENCODING_UTF8)));
    Ok(out)
}

/// Each chapter's length in milliseconds: up to the next one, and the last up to
/// the end of the audio.
///
/// ⚠️ **NEVER ZERO.** A zero-length chapter sample is one players step straight
/// over, so two chapters given the same start would collapse into one — which
/// happens whenever a book's table of contents points twice into the same
/// section.
pub fn chapter_durations(chapters: &[Chapter], total_ms: u64) -> Vec<u32> {
    chapters
        .iter()
        .enumerate()
        .map(|(i, chapter)| {
            let end = chapters.get(i + 1).map_or(total_ms, |next| next.start_ms);
            end.saturating_sub(chapter.start_ms).max(1) as u32
        })
        .collect()
}

/// The whole file, as bytes.
///
/// `chapters` must be in order and start at or before the end of the audio;
/// both are checked, because a chapter past the end is a table of contents that
/// disagrees with the book and produces a file whose last chapter can never be
/// reached.
pub fn build(
    aac_bytes: &[u8],
    aac: &Aac,
    chapters: &[Chapter],
    meta: &BookMeta,
) -> Result<Vec<u8>, String> {
    if chapters.is_empty() {
        return Err("a book with no chapters has nothing to mark".to_owned());
    }
    let total_ms = aac.duration_ms();
    /* ⚠️ **THE TEXT TRACK IS A RUN OF SAMPLES FROM ZERO, SO THE STARTS MUST BE
     * TOO.** `stts` places the first sample at time zero and each one after it
     * end to end — there is no start field. A first chapter at 500ms was
     * therefore drawn at 0, and two chapters sharing a start became samples at
     * 0ms and 1ms rather than two marks at the same moment. Both were accepted
     * and silently mis-placed; both are refused now, and `chapter_starts`
     * produces exactly what this requires. */
    if chapters[0].start_ms != 0 {
        return Err(format!(
            "'{}' starts at {}ms and the first chapter has to start at the beginning of the audio",
            chapters[0].title, chapters[0].start_ms
        ));
    }
    for pair in chapters.windows(2) {
        if pair[1].start_ms <= pair[0].start_ms {
            return Err(format!(
                "the chapters are out of order: '{}' starts at {}ms and '{}' at {}ms, and each \
                 chapter has to begin after the one before it",
                pair[0].title, pair[0].start_ms, pair[1].title, pair[1].start_ms
            ));
        }
    }
    if let Some(last) = chapters.last() {
        /* ⚠️ **`>=`, AND IT WAS `>`.** A chapter starting exactly where the audio
         * ends was accepted, its duration then forced from zero to one
         * millisecond — so `stts` totalled a millisecond more than the track's
         * declared duration, and the mark itself could never be reached. Found in
         * verification, not by the first pass. */
        if last.start_ms >= total_ms {
            return Err(format!(
                "'{}' starts at {}ms and there are only {}ms of audio, so it could never be \
                 reached",
                last.title, last.start_ms, total_ms
            ));
        }
    }

    let audio_sizes: Vec<u32> = aac.frames.iter().map(|(s, e)| (e - s) as u32).collect();
    let audio_bytes: usize = audio_sizes.iter().map(|s| *s as usize).sum();
    let audio_duration = aac.frames.len() as u64 * u64::from(SAMPLES_PER_FRAME);
    let durations = chapter_durations(chapters, total_ms);
    let text_blobs: Vec<Vec<u8>> = chapters
        .iter()
        .map(|c| text_sample(&c.title))
        .collect::<Result<Vec<_>, _>>()?;
    let text_sizes: Vec<u32> = text_blobs.iter().map(|b| b.len() as u32).collect();

    let moov_with = |audio_offset: u32, text_offset: u32| -> Vec<u8> {
        let audio_trak = {
            let smhd = fbx(b"smhd", 0, 0, &cat(&[be16(0).to_vec(), be16(0).to_vec()]));
            let table = stbl(
                mp4a(aac),
                &audio_sizes,
                &[(aac.frames.len() as u32, SAMPLES_PER_FRAME)],
                audio_offset,
            );
            let mdia = bx(
                b"mdia",
                &cat(&[
                    mdhd(aac.sample_rate, audio_duration),
                    hdlr(b"soun", "Paper audio"),
                    bx(b"minf", &cat(&[smhd, dinf(), table])),
                ]),
            );
            /* ⚠️ **`tref/chap` IS WHAT MAKES THEM CHAPTERS.** Without it the text
             * track is merely a track containing text: every player reports no
             * chapters while the file is otherwise complete and plays fine. */
            let tref = bx(b"tref", &bx(b"chap", &be32(TEXT_TRACK)));
            bx(
                b"trak",
                &cat(&[tkhd(AUDIO_TRACK, total_ms, true), tref, mdia]),
            )
        };

        let text_trak = {
            let runs: Vec<(u32, u32)> = durations.iter().map(|d| (1u32, *d)).collect();
            let table = stbl(text_sample_entry(), &text_sizes, &runs, text_offset);
            let mdia = bx(
                b"mdia",
                &cat(&[
                    /* TIMESCALE 1000, so a chapter's start is the millisecond the
                     * caller gave and nothing is rounded into a different one. */
                    mdhd(1000, total_ms),
                    hdlr(b"text", "Paper chapters"),
                    bx(b"minf", &cat(&[gmhd(), dinf(), table])),
                ]),
            );
            bx(b"trak", &cat(&[tkhd(TEXT_TRACK, total_ms, false), mdia]))
        };

        let mut mvhd_body = Vec::new();
        mvhd_body.extend_from_slice(&be32(0));
        mvhd_body.extend_from_slice(&be32(0));
        mvhd_body.extend_from_slice(&be32(1000)); // timescale: milliseconds
        mvhd_body.extend_from_slice(&be32(total_ms as u32));
        mvhd_body.extend_from_slice(&be32(0x0001_0000)); // rate 1.0
        mvhd_body.extend_from_slice(&be16(0x0100)); // volume 1.0
        mvhd_body.extend_from_slice(&be16(0));
        mvhd_body.extend_from_slice(&[0; 8]); // reserved
        mvhd_body.extend_from_slice(&unity_matrix());
        mvhd_body.extend_from_slice(&[0; 24]); // predefined
        mvhd_body.extend_from_slice(&be32(TEXT_TRACK + 1)); // next free track id
        let mvhd = fbx(b"mvhd", 0, 0, &mvhd_body);

        let udta = {
            let item = |name: &[u8; 4], value: &str| {
                let mut data = be32(1).to_vec(); // well-known type: UTF-8
                data.extend_from_slice(&be32(0)); // locale
                data.extend_from_slice(value.as_bytes());
                bx(name, &bx(b"data", &data))
            };
            let ilst = bx(
                b"ilst",
                &cat(&[
                    item(b"\xa9nam", &meta.title),
                    item(b"\xa9ART", &meta.author),
                ]),
            );
            bx(
                b"udta",
                &fbx(b"meta", 0, 0, &cat(&[hdlr(b"mdir", ""), ilst])),
            )
        };

        bx(b"moov", &cat(&[mvhd, audio_trak, text_trak, udta]))
    };

    let ftyp = bx(
        b"ftyp",
        &cat(&[
            b"M4A ".to_vec(),
            be32(0).to_vec(),
            b"M4A ".to_vec(),
            b"M4B ".to_vec(),
            b"mp42".to_vec(),
            b"isom".to_vec(),
        ]),
    );

    /* TWO PASSES, because `stco` holds offsets into the finished file and those
     * depend on how long `moov` is. The SIZE of `moov` depends only on the
     * number of samples, so it is identical between the passes even though the
     * values are not — and that identity is ASSERTED rather than assumed,
     * because if it ever stopped holding, every offset would be wrong by a
     * constant and the file would play silence. */
    let measured = moov_with(0, 0);
    let data_start = ftyp.len() + measured.len() + 8;
    let moov = moov_with(data_start as u32, (data_start + audio_bytes) as u32);
    if moov.len() != measured.len() {
        return Err(
            "the header changed size between the measuring pass and the writing pass, so every \
             sample offset would be wrong"
                .to_owned(),
        );
    }

    let mut media = Vec::with_capacity(audio_bytes + text_sizes.iter().sum::<u32>() as usize);
    for (start, end) in &aac.frames {
        media.extend_from_slice(&aac_bytes[*start..*end]);
    }
    for blob in &text_blobs {
        media.extend_from_slice(blob);
    }

    Ok(cat(&[ftyp, moov, bx(b"mdat", &media)]))
}

/// Build the file and write it.
pub fn write(
    aac_bytes: &[u8],
    chapters: &[Chapter],
    meta: &BookMeta,
    out: &Path,
) -> Result<u64, String> {
    let aac = parse_aac(aac_bytes)?;
    /* THE DURATION, NOT THE BYTE COUNT. The byte count had no caller, and
     * `package` was parsing the same stream a second time to learn the
     * duration — while the value it actually returned to the app was the file
     * SIZE reported as milliseconds. The end-to-end test caught it: a 30 508
     * byte book reported as a 30 508 ms one. */
    let duration_ms = aac.duration_ms();
    let file = build(aac_bytes, &aac, chapters, meta)?;
    /* ⚠️ **WRITTEN BESIDE AND RENAMED, NEVER STRAIGHT ONTO `out`.** `fs::write`
     * truncates first, so an interrupted write — a full disk, a crash — left a
     * reader's existing audiobook destroyed or half replaced. A rename within one
     * directory is atomic: the destination is the old file or the whole new one.
     * `package` stages its own copy too; this is here so the guarantee belongs to
     * the writer rather than to whoever remembers to call it correctly. */
    let parent = out
        .parent()
        .ok_or_else(|| format!("{} has no directory to write into", out.display()))?;
    let scratch = parent.join(format!(
        ".paper-m4b-{}-{}.part",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let written = std::fs::write(&scratch, &file)
        .map_err(|error| format!("cannot write {}: {error}", scratch.display()))
        .and_then(|()| {
            std::fs::rename(&scratch, out)
                .map_err(|error| format!("cannot move the finished book into place: {error}"))
        });
    if written.is_err() {
        let _ = std::fs::remove_file(&scratch);
    }
    written?;
    Ok(duration_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A syntactically valid ADTS frame with `payload` bytes after the header.
    fn frame(payload: usize, frequency_index: u8, channels: u8) -> Vec<u8> {
        let length = payload + 7;
        let mut f = vec![
            0xff,
            0xf1, // MPEG-4, no CRC — so a 7-byte header
            (1 << 6) | (frequency_index << 2) | ((channels >> 2) & 0x01),
            ((channels & 0x03) << 6) | ((length >> 11) & 0x03) as u8,
            ((length >> 3) & 0xff) as u8,
            (((length & 0x07) << 5) | 0x1f) as u8,
            0xfc,
        ];
        f.extend(std::iter::repeat_n(0xaa, payload));
        f
    }

    fn stream(frames: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for _ in 0..frames {
            out.extend_from_slice(&frame(100, 7 /* 22050 */, 1));
        }
        out
    }

    #[test]
    fn it_reads_a_streams_frames_and_format() {
        let aac = parse_aac(&stream(3)).expect("parses");
        assert_eq!(aac.frames.len(), 3);
        assert_eq!(aac.sample_rate, 22_050);
        assert_eq!(aac.channels, 1);
        /* Three frames of 1024 samples at 22 050 Hz. */
        assert_eq!(aac.duration_ms(), 3 * 1024 * 1000 / 22_050);
    }

    #[test]
    fn the_sample_is_the_payload_without_the_adts_header() {
        let aac = parse_aac(&stream(2)).expect("parses");
        /* An MP4 sample is the raw block: 100 bytes, not 107. A container built
         * from whole ADTS frames decodes as noise. */
        for (start, end) in &aac.frames {
            assert_eq!(end - start, 100);
        }
    }

    #[test]
    fn it_refuses_what_is_not_adts_rather_than_hunting_for_a_syncword() {
        let error = parse_aac(b"ID3\x04and then some").expect_err("refuses");
        assert!(error.contains("not an ADTS stream"), "{error}");
    }

    #[test]
    fn it_refuses_an_empty_stream() {
        let error = parse_aac(&[]).expect_err("refuses");
        assert!(error.contains("no AAC frames"), "{error}");
    }

    #[test]
    fn it_refuses_a_reserved_sampling_frequency() {
        let error = parse_aac(&frame(10, 13, 1)).expect_err("refuses");
        assert!(error.contains("reserved"), "{error}");
    }

    #[test]
    fn it_refuses_a_frame_that_runs_past_the_end() {
        let mut truncated = frame(100, 7, 1);
        truncated.truncate(50);
        let error = parse_aac(&truncated).expect_err("refuses");
        assert!(error.contains("past the end"), "{error}");
    }

    #[test]
    fn it_refuses_a_stream_whose_format_changes() {
        /* One `stsd` entry describes every sample, so a switch would be decoded
         * with the first frame's format from that point on. */
        let mut mixed = frame(100, 7, 1);
        mixed.extend_from_slice(&frame(100, 4 /* 44100 */, 1));
        let error = parse_aac(&mixed).expect_err("refuses");
        assert!(error.contains("changes format"), "{error}");
    }

    /// ⚠️ **THE REGRESSION THIS FILE WAS BUILT AROUND.** 88 bytes reads
    /// correctly in ffmpeg and leaves Apple Books with an empty file.
    #[test]
    fn a_track_header_is_ninety_two_bytes() {
        assert_eq!(tkhd(1, 1000, true).len(), 92);
        assert_eq!(tkhd(2, 1000, false).len(), 92);
    }

    #[test]
    fn the_chapter_track_is_not_enabled_and_the_audio_track_is() {
        /* Byte 8 is the version, 9..12 the flags. Flag 1 is `enabled`. */
        let audio = tkhd(1, 1000, true);
        let text = tkhd(2, 1000, false);
        assert_eq!(audio[11] & 0x01, 1);
        assert_eq!(text[11] & 0x01, 0);
    }

    #[test]
    fn a_chapter_title_carries_its_encoding() {
        let sample = text_sample("第三章").expect("a short title is fine");
        let utf8 = "第三章".as_bytes();
        assert_eq!(&sample[0..2], &(utf8.len() as u16).to_be_bytes());
        assert_eq!(&sample[2..2 + utf8.len()], utf8);
        /* Without the `encd` the title comes back as mojibake from AVFoundation
         * and correctly from ffprobe — see the module header. */
        let tail = &sample[2 + utf8.len()..];
        assert_eq!(&tail[4..8], b"encd");
        assert_eq!(
            u32::from_be_bytes(tail[8..12].try_into().unwrap()),
            ENCODING_UTF8
        );
    }

    #[test]
    fn a_chapter_runs_to_the_next_one_and_the_last_to_the_end() {
        let chapters = vec![
            Chapter {
                title: "One".into(),
                start_ms: 0,
            },
            Chapter {
                title: "Two".into(),
                start_ms: 2500,
            },
            Chapter {
                title: "Three".into(),
                start_ms: 4800,
            },
        ];
        assert_eq!(chapter_durations(&chapters, 6362), vec![2500, 2300, 1562]);
    }

    #[test]
    fn two_chapters_at_one_moment_do_not_collapse() {
        /* A table of contents pointing twice into the same section. A zero-length
         * sample is one a player steps straight over. */
        let chapters = vec![
            Chapter {
                title: "One".into(),
                start_ms: 1000,
            },
            Chapter {
                title: "Also one".into(),
                start_ms: 1000,
            },
        ];
        assert_eq!(chapter_durations(&chapters, 5000), vec![1, 4000]);
    }

    #[test]
    fn the_two_passes_agree_on_the_header_size() {
        let bytes = stream(40);
        let aac = parse_aac(&bytes).unwrap();
        let chapters = vec![
            Chapter {
                title: "One".into(),
                start_ms: 0,
            },
            Chapter {
                title: "第三章".into(),
                start_ms: 500,
            },
        ];
        let file = build(&bytes, &aac, &chapters, &BookMeta::default()).expect("builds");
        /* `build` refuses when the passes disagree, so reaching here is the
         * assertion — but the offsets are checked for real as well. */
        assert_eq!(&file[4..8], b"ftyp");
        let moov_at = u32::from_be_bytes(file[0..4].try_into().unwrap()) as usize;
        assert_eq!(&file[moov_at + 4..moov_at + 8], b"moov");
        let moov_size = u32::from_be_bytes(file[moov_at..moov_at + 4].try_into().unwrap()) as usize;
        let mdat_at = moov_at + moov_size;
        assert_eq!(&file[mdat_at + 4..mdat_at + 8], b"mdat");
        /* Every byte is accounted for: the three top-level boxes and nothing
         * else. A stray byte at the end is how a truncated write reads. */
        let mdat_size = u32::from_be_bytes(file[mdat_at..mdat_at + 4].try_into().unwrap()) as usize;
        assert_eq!(mdat_at + mdat_size, file.len());
    }

    #[test]
    fn the_audio_offset_points_at_the_first_frame() {
        let bytes = stream(5);
        let aac = parse_aac(&bytes).unwrap();
        let chapters = vec![Chapter {
            title: "One".into(),
            start_ms: 0,
        }];
        let file = build(&bytes, &aac, &chapters, &BookMeta::default()).unwrap();
        /* Find `stco` in the audio track — the first one in the file — and follow
         * its single offset. It must land on the first frame's payload. */
        let stco = file.windows(4).position(|w| w == b"stco").expect("stco");
        let offset = u32::from_be_bytes(file[stco + 12..stco + 16].try_into().unwrap()) as usize;
        assert_eq!(&file[offset..offset + 4], &[0xaa, 0xaa, 0xaa, 0xaa]);
    }

    #[test]
    fn it_refuses_chapters_out_of_order() {
        let bytes = stream(5);
        let aac = parse_aac(&bytes).unwrap();
        let chapters = vec![
            /* Starting at zero, so this reaches the ORDER rule rather than the
            first-chapter rule that now guards the timeline ahead of it. */
            Chapter {
                title: "First".into(),
                start_ms: 0,
            },
            Chapter {
                title: "Later".into(),
                start_ms: 200,
            },
            Chapter {
                title: "Earlier".into(),
                start_ms: 100,
            },
        ];
        let error = build(&bytes, &aac, &chapters, &BookMeta::default()).expect_err("refuses");
        assert!(error.contains("out of order"), "{error}");
    }

    #[test]
    fn it_refuses_a_chapter_past_the_end_of_the_audio() {
        let bytes = stream(5);
        let aac = parse_aac(&bytes).unwrap();
        let chapters = vec![
            Chapter {
                title: "First".into(),
                start_ms: 0,
            },
            Chapter {
                title: "Nowhere".into(),
                start_ms: 60_000,
            },
        ];
        let error = build(&bytes, &aac, &chapters, &BookMeta::default()).expect_err("refuses");
        assert!(error.contains("could never be reached"), "{error}");
    }

    /// ⚠️ **EXACTLY AT THE END WAS ACCEPTED, AND THE CHECK WAS `>`.** The chapter's
    /// duration was then forced from zero to one millisecond, so `stts` totalled a
    /// millisecond more than the track's declared duration — and the mark could
    /// never be reached anyway. Found in verification.
    #[test]
    fn a_chapter_starting_exactly_where_the_audio_ends_is_refused() {
        let bytes = stream(40);
        let aac = parse_aac(&bytes).unwrap();
        let total = aac.duration_ms();
        let chapters = vec![
            Chapter {
                title: "First".into(),
                start_ms: 0,
            },
            Chapter {
                title: "At the very end".into(),
                start_ms: total,
            },
        ];
        let error = build(&bytes, &aac, &chapters, &BookMeta::default()).expect_err("refuses");
        assert!(error.contains("could never be reached"), "{error}");
    }

    #[test]
    fn every_chapter_duration_sums_to_the_declared_track_length() {
        /* The invariant the accepted-at-the-end case broke: `stts` must total
        exactly what `mdhd` declares, or a player's last chapter runs past the
        audio. */
        let chapters = vec![
            Chapter {
                title: "One".into(),
                start_ms: 0,
            },
            Chapter {
                title: "Two".into(),
                start_ms: 2500,
            },
            Chapter {
                title: "Three".into(),
                start_ms: 4800,
            },
        ];
        let total = 6362u64;
        let sum: u64 = chapter_durations(&chapters, total)
            .iter()
            .map(|d| u64::from(*d))
            .sum();
        assert_eq!(sum, total);
    }

    /// The end-to-end check, and the ONLY one that proves the container is valid.
    ///
    /// ⚠️ **NOTHING ABOVE PROVES A PLAYER CAN OPEN THIS FILE.** Every other case
    /// here asserts bytes, and the defect this module was built around — a
    /// `tkhd` four bytes short — passes a byte assertion while leaving Apple
    /// Books with an empty file. Only a real reader settles it.
    ///
    /// `#[ignore]`d because it shells out to `say` and `afconvert` and writes
    /// outside the repository. Run it, then read the result back with BOTH
    /// readers, which disagree in ways that matter:
    ///
    /// ```sh
    /// cargo test -p app --lib narrate::m4b::tests::a_real_book -- --ignored --nocapture
    /// ffprobe -v error -show_chapters /tmp/paper-m4b/book.m4b
    /// swift /tmp/ttsprobe/verify.swift /tmp/paper-m4b/book.m4b
    /// ```
    #[test]
    #[ignore = "writes outside the repository and needs macOS's say and afconvert"]
    fn a_real_book_that_a_player_can_open() {
        use std::process::Command;
        let dir = std::path::Path::new("/tmp/paper-m4b");
        std::fs::create_dir_all(dir).expect("scratch directory");
        let aiff = dir.join("spoken.aiff");
        let adts = dir.join("spoken.adts");
        let book = dir.join("book.m4b");

        let said = Command::new("say")
            .args(["-v", "Samantha", "-o"])
            .arg(&aiff)
            .arg("Chapter one. The measure of a plan. Chapter two. What it costs to revisit it. Chapter three. A book in two languages.")
            .status()
            .expect("run say");
        assert!(said.success(), "say failed");

        let converted = Command::new("afconvert")
            .args(["-f", "adts", "-d", "aac", "-b", "64000"])
            .arg(&aiff)
            .arg(&adts)
            .status()
            .expect("run afconvert");
        assert!(converted.success(), "afconvert failed");

        let bytes = std::fs::read(&adts).expect("read the encoded audio");
        let aac = parse_aac(&bytes).expect("the system's own encoder produces readable ADTS");
        let total = aac.duration_ms();
        assert!(
            total > 3000,
            "expected a few seconds of audio, got {total}ms"
        );

        let chapters = vec![
            Chapter {
                title: "Chapter One".into(),
                start_ms: 0,
            },
            Chapter {
                title: "Chapter Two".into(),
                start_ms: total / 3,
            },
            /* NON-LATIN ON PURPOSE: the encoding trap only shows up here. */
            Chapter {
                title: "第三章".into(),
                start_ms: total * 2 / 3,
            },
        ];
        let meta = BookMeta {
            title: "A Measured Book".into(),
            author: "Paper".into(),
        };
        let reported_ms = write(&bytes, &chapters, &meta, &book).expect("writes the book");

        assert!(book.is_file(), "no file at {}", book.display());
        /* ⚠️ **`write` REPORTS THE DURATION, AND THIS ASSERTED ON IT AS A BYTE
         * COUNT.** It read `size as usize > audio` and passed for as long as the
         * two happened to be the same kind of number — which is the defect that
         * shipped once already, as a 30 508 byte book reported as 30 508 ms. The
         * file's size comes from the filesystem now, and the duration is checked
         * as a duration. */
        let size = std::fs::metadata(&book).expect("stat the book").len() as usize;
        let audio: usize = aac.frames.iter().map(|(s, e)| e - s).sum();
        assert!(size > audio, "the file is smaller than its own audio");
        assert_eq!(
            reported_ms, total,
            "the reported duration is not the audio's"
        );
        println!(
            "wrote {} ({size} bytes, {total}ms, 3 chapters)",
            book.display()
        );
    }

    #[test]
    fn it_refuses_a_book_with_no_chapters() {
        let bytes = stream(5);
        let aac = parse_aac(&bytes).unwrap();
        let error = build(&bytes, &aac, &[], &BookMeta::default()).expect_err("refuses");
        assert!(error.contains("no chapters"), "{error}");
    }
}
