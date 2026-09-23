//! The engine: one sentence at a time, each one checked before it is kept.
//!
//! The model lives on the Swift side over MLX (see `swift/QwenKit`); everything
//! that decides anything lives here, so it can be read, changed and tested
//! without a 2.5 GB download and a Metal toolchain.
//!
//! # Why a sentence at a time
//!
//! Qwen3-TTS decides for itself when to stop, and measured in WI-30.0 it
//! sometimes does not: two spike renders ran 3.14× and 3.42× the length their
//! text deserved. Handing it a paragraph makes one runaway cost the paragraph;
//! handing it a sentence costs a sentence, and the reader can be told which.
//!
//! # What happens to a render that is not believable
//!
//! It is rendered again with another seed — the model is sampled, so the same
//! text usually comes back right — up to [`ATTEMPTS`] times, and then the
//! sentence is **refused by name**. A skipped sentence and a notice is a thing
//! a reader can understand. A minute of babble is not.

use std::path::Path;

use super::text::{self, Verdict, FRAMES_PER_SECOND};
use crate::{Error, Result};

/// How many renders one sentence may have before it is refused.
///
/// Three, not more: each costs the full wait, and a sentence that babbles three
/// times with three different seeds is not going to come right on the fourth.
pub const ATTEMPTS: u32 = 3;

/// What a sentence came out as.
#[derive(Debug, Clone, PartialEq)]
pub struct Spoken {
    /// The text this is, so a refusal and a highlight can both name it.
    pub text: String,
    /// 16-bit mono at [`Rendered::sample_rate`](crate::kokoro::Rendered).
    pub samples: Vec<i16>,
    /// How many attempts it took. More than one is worth knowing: it is the
    /// runaway guard working, and it is where the time went.
    pub attempts: u32,
}

/// A sentence that could not be rendered, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub text: String,
    pub why: String,
}

/// What a whole passage came out as: what was said, and what was not.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub spoken: Vec<Spoken>,
    pub skipped: Vec<Skipped>,
    pub sample_rate: u32,
}

/// What the Swift side answers with when it cannot answer with samples.
///
/// Kept in step with `Failure` in `swift/QwenKit/Sources/QwenKit/QwenKit.swift`
/// by name, and by `a_code_from_the_bridge_is_named_not_numbered` below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    NotLoaded,
    BadArgument,
    GenerationFailed,
    /// More audio than the cap allowed room for — the runaway arriving.
    Overflowed,
    NoAudio,
    /// Something this side does not know about, which is a version skew
    /// between the two files rather than a model problem.
    Unknown(i64),
}

impl Failure {
    /// Read the bridge's answer.
    #[must_use]
    pub fn of(code: i64) -> Self {
        match code {
            -1 => Self::NotLoaded,
            -2 => Self::BadArgument,
            -3 => Self::GenerationFailed,
            -4 => Self::Overflowed,
            -5 => Self::NoAudio,
            other => Self::Unknown(other),
        }
    }

    /// What to tell a reader who is waiting for this sentence.
    #[must_use]
    pub fn why(self) -> String {
        match self {
            Self::NotLoaded => "the voice was not loaded".to_owned(),
            Self::BadArgument => "the sentence could not be given to the voice".to_owned(),
            Self::GenerationFailed => "the voice could not say it".to_owned(),
            Self::Overflowed => "the voice ran on past what the sentence should take".to_owned(),
            Self::NoAudio => "the voice produced no sound".to_owned(),
            Self::Unknown(code) => {
                format!("the voice answered {code}, which this version does not know")
            }
        }
    }

    /// Whether another seed could plausibly help.
    ///
    /// A runaway is worth another draw, since the model is sampled. A model
    /// that is not loaded, or an argument it refused, will refuse identically
    /// however many times it is asked — retrying those is pure delay.
    #[must_use]
    pub fn worth_retrying(self) -> bool {
        matches!(
            self,
            Self::Overflowed | Self::GenerationFailed | Self::NoAudio
        )
    }
}

/// How many samples a cap's worth of frames can be, at a sample rate.
///
/// This is what makes the caller-owned buffer possible: the cap bounds the
/// audio, so its size is known before the model runs and nothing has to be
/// allocated on the Swift side and freed across the boundary.
#[must_use]
pub fn buffer_samples(frames: usize, sample_rate: u32) -> usize {
    // A frame is 1/12.5 of a second, and the rounding goes up so a render that
    // uses every frame it was allowed still fits.
    let seconds = frames as f64 / FRAMES_PER_SECOND;
    (seconds * f64::from(sample_rate)).ceil() as usize + sample_rate as usize
}

/// Turn the model's floats into the 16-bit samples the rest of Paper carries.
///
/// Clamped rather than wrapped: a sample just past 1.0 is a fraction of a
/// decibel of clipping, and the same value wrapped is a loud click.
#[must_use]
pub fn to_pcm16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|s| {
            let clamped = s.clamp(-1.0, 1.0);
            // 32767 rather than 32768, so +1.0 does not become -32768.
            (clamped * 32767.0).round() as i16
        })
        .collect()
}

/// The seed for one attempt at one sentence.
///
/// Derived rather than random so a render is reproducible: the same sentence in
/// the same book comes back the same way, and a reported runaway can be
/// reproduced by whoever is looking into it.
#[must_use]
pub fn seed_for(text: &str, attempt: u32) -> u64 {
    // FNV-1a over the text, then mixed with the attempt. Any stable hash does;
    // this one is four lines and has no dependency.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash ^= u64::from(attempt).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    // Zero is a legitimate seed, but a zero that arrives by accident looks like
    // an uninitialised one; move it off that value.
    if hash == 0 {
        1
    } else {
        hash
    }
}

/// What one attempt at a sentence answered.
#[derive(Debug, Clone, PartialEq)]
pub enum Attempt {
    /// Samples, and how long they are in seconds.
    Audio(Vec<f32>, f64),
    /// The bridge refused.
    Failed(Failure),
}

/// Render one sentence, judging each attempt and re-seeding while it is worth
/// it. `render` is the bridge call, kept as a parameter so every decision here
/// is testable with no model.
///
/// # Errors
/// Never returns an error: a sentence that cannot be said is [`Skipped`], since
/// one bad sentence must not end a chapter.
pub fn say<F>(
    sentence: &str,
    sample_rate: u32,
    mut render: F,
) -> std::result::Result<Spoken, Skipped>
where
    F: FnMut(u64, usize, usize) -> Attempt,
{
    let cap = text::frame_cap(sentence);
    let room = buffer_samples(cap, sample_rate);
    let mut last = String::new();
    for attempt in 0..ATTEMPTS {
        match render(seed_for(sentence, attempt), cap, room) {
            Attempt::Audio(samples, seconds) => {
                let left = ATTEMPTS - attempt - 1;
                match text::verdict(sentence, seconds, left) {
                    Verdict::Keep => {
                        return Ok(Spoken {
                            text: sentence.to_owned(),
                            samples: to_pcm16(&samples),
                            attempts: attempt + 1,
                        })
                    }
                    Verdict::Again => {
                        let (low, high) = text::band(sentence);
                        last = format!(
                            "it came out {seconds:.1} s long, where this sentence should take {low:.1} to {high:.1} s"
                        );
                    }
                    Verdict::Refuse => {
                        let (low, high) = text::band(sentence);
                        return Err(Skipped {
                            text: sentence.to_owned(),
                            why: format!(
                                "it came out {seconds:.1} s long after {ATTEMPTS} tries, where this sentence should take {low:.1} to {high:.1} s"
                            ),
                        });
                    }
                }
            }
            Attempt::Failed(failure) => {
                last = failure.why();
                if !failure.worth_retrying() {
                    return Err(Skipped {
                        text: sentence.to_owned(),
                        why: last,
                    });
                }
            }
        }
    }
    Err(Skipped {
        text: sentence.to_owned(),
        why: last,
    })
}

/// Read a whole passage, sentence by sentence.
///
/// A sentence that cannot be said is recorded and the rest are still read: a
/// reader who loses one sentence and is told so has a book; a reader whose
/// chapter stops at the first hard sentence does not.
pub fn read<F>(passage: &str, sample_rate: u32, mut render: F) -> Reading
where
    F: FnMut(&str, u64, usize, usize) -> Attempt,
{
    let mut reading = Reading {
        spoken: Vec::new(),
        skipped: Vec::new(),
        sample_rate,
    };
    for sentence in text::sentences(passage) {
        let trimmed = sentence.trim();
        if trimmed.is_empty() {
            continue;
        }
        match say(trimmed, sample_rate, |seed, cap, room| {
            render(trimmed, seed, cap, room)
        }) {
            Ok(spoken) => reading.spoken.push(spoken),
            Err(skipped) => reading.skipped.push(skipped),
        }
    }
    reading
}

/// Refuse a pack this machine has too little memory for.
///
/// # Errors
/// [`Error::Malformed`] naming both numbers, because "not enough memory" with
/// no figures is something a reader can do nothing with.
pub fn memory_allows(minimum_gb: u32, machine_gb: u32, pack: &str) -> Result<()> {
    if machine_gb < minimum_gb {
        return Err(Error::Malformed {
            route: pack.to_owned(),
            why: format!("it needs {minimum_gb} GB of memory and this Mac has {machine_gb} GB"),
        });
    }
    Ok(())
}

/// Where a loaded model is refused, because this build has no engine.
///
/// Two ways to get here, and the refusal is deliberate rather than a silent
/// absence in both: the build is not for macOS, or it is and the Swift half was
/// left out with `PAPER_VOICES_NO_SWIFT`. Either way a reader asking for this
/// voice is told the build has none, which is what stops it being read as "the
/// voice failed".
///
/// # Errors
/// Always, in a build without the bridge.
#[cfg(not(all(target_os = "macos", qwen_bridge)))]
pub fn load(_pack_dir: &Path) -> Result<u32> {
    Err(Error::Malformed {
        route: "qwen".to_owned(),
        why: "this build has no Chinese voice: it runs on macOS, with the Swift engine built in"
            .to_owned(),
    })
}

/// Load a pack, answering the model's sample rate.
///
/// # Errors
/// [`Error::Malformed`] naming the bridge's own refusal.
#[cfg(all(target_os = "macos", qwen_bridge))]
pub fn load(pack_dir: &Path) -> Result<u32> {
    let path = std::ffi::CString::new(pack_dir.as_os_str().as_encoded_bytes()).map_err(|_| {
        Error::Malformed {
            route: "qwen".to_owned(),
            why: "the pack's path cannot be given to the voice".to_owned(),
        }
    })?;
    // SAFETY: `path` outlives the call, and the bridge copies the string before
    // it returns. Its answer is a sample rate or a negative code.
    let answered = unsafe { bridge::paper_qwen_load(path.as_ptr()) };
    if answered <= 0 {
        return Err(Error::Malformed {
            route: format!("qwen:{}", pack_dir.display()),
            why: Failure::of(answered).why(),
        });
    }
    u32::try_from(answered).map_err(|_| Error::Malformed {
        route: "qwen".to_owned(),
        why: format!("the voice answered a sample rate of {answered}"),
    })
}

/// Let the model go, and its memory with it.
#[cfg(all(target_os = "macos", qwen_bridge))]
pub fn unload() {
    // SAFETY: takes nothing and answers nothing; safe to call when no model is
    // loaded, which is what makes an idle timer able to call it unconditionally.
    unsafe { bridge::paper_qwen_unload() }
}

/// Let the model go. Nothing is loaded without the bridge, so this does nothing.
#[cfg(not(all(target_os = "macos", qwen_bridge)))]
pub fn unload() {}

/// Render one sentence through the bridge.
///
/// The buffer is allocated here, from the cap the caller computed, so nothing
/// is allocated on the Swift side and no memory crosses the boundary in either
/// direction except as a copy.
///
/// Not itself decided anything: it turns the bridge's answer into an
/// [`Attempt`] and leaves every judgement to [`say`].
#[cfg(all(target_os = "macos", qwen_bridge))]
#[must_use]
pub fn through_bridge(
    sentence: &str,
    voice: &str,
    language: &str,
    sample_rate: u32,
    seed: u64,
    cap: usize,
    room: usize,
) -> Attempt {
    let (Ok(text), Ok(voice), Ok(language)) = (
        std::ffi::CString::new(sentence),
        std::ffi::CString::new(voice),
        std::ffi::CString::new(language),
    ) else {
        // An interior NUL cannot be given to C, and it can only have come from
        // text this side built wrongly.
        return Attempt::Failed(Failure::BadArgument);
    };
    let mut buffer = vec![0f32; room];
    let (Ok(max_frames), Ok(capacity)) = (i64::try_from(cap), i64::try_from(room)) else {
        return Attempt::Failed(Failure::BadArgument);
    };
    // SAFETY: the three strings outlive the call; `buffer` is `room` floats and
    // `capacity` says so, and the bridge writes no more than it is told.
    let answered = unsafe {
        bridge::paper_qwen_render(
            text.as_ptr(),
            voice.as_ptr(),
            language.as_ptr(),
            max_frames,
            seed,
            buffer.as_mut_ptr(),
            capacity,
        )
    };
    let Ok(written) = usize::try_from(answered) else {
        return Attempt::Failed(Failure::of(answered));
    };
    if written > room {
        // The bridge cannot write more than it was given, so this is a bridge
        // that disagrees with this file rather than a long sentence.
        return Attempt::Failed(Failure::Unknown(answered));
    }
    buffer.truncate(written);
    let seconds = written as f64 / f64::from(sample_rate);
    Attempt::Audio(buffer, seconds)
}

/// The calls `swift/QwenKit` exports.
#[cfg(all(target_os = "macos", qwen_bridge))]
mod bridge {
    use std::os::raw::c_char;

    extern "C" {
        pub fn paper_qwen_load(directory: *const c_char) -> i64;
        pub fn paper_qwen_render(
            text: *const c_char,
            voice: *const c_char,
            language: *const c_char,
            max_frames: i64,
            seed: u64,
            out: *mut f32,
            capacity: i64,
        ) -> i64;
        pub fn paper_qwen_unload();
    }
}

#[cfg(test)]
mod tests;
