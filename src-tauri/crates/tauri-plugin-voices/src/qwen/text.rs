//! What to ask the model for, and whether to believe what came back.
//!
//! Qwen3-TTS is autoregressive: it decides for itself when to stop. Measured in
//! WI-30.0, sometimes it does not — two of the spike's English renders ran
//! **3.14×** and **3.42×** the length their text deserved, which is a minute of
//! babble where a reader expected a sentence. Nothing in the model says this has
//! happened; the audio is the only evidence, and it arrives after the wait.
//!
//! So the engine renders **one sentence at a time** and asks two questions of
//! each: how long should this take, and does what came back resemble that. Both
//! are answered here, with no model loaded, because they are the part that has
//! to be right whether or not anything can be built today.
//!
//! # Where the numbers come from
//!
//! Every constant below is fitted to the spike's 29 real renders — five voices
//! and three model variants across five passages — rather than chosen. The
//! script matters more than the declared language, because a Chinese book
//! quotes English and writes dates in digits, and a "Chinese" rate applied to a
//! Latin clause predicts nearly three times the duration it takes:
//!
//! | script | measured rate | from |
//! |---|---|---|
//! | wide (Han, kana, full-width) | **4.5 characters a second** | 18 Chinese renders, 3.59–5.80 |
//! | everything else | **12.5 characters a second** | 9 healthy English renders, 10.07–15.04 |
//!
//! Against that prediction the healthy renders land at **0.83×–1.63×** and the
//! two runaways at **3.14×** and **3.42×**, which is the separation the band
//! below is drawn in. The widest healthy reading is the mixed Chinese-and-English
//! passage, and that is not noise: dates and numbers are read out in syllables
//! that the characters do not show.

/// Qwen's codec, in frames a second. The model emits codec frames, so this is
/// what a duration in seconds has to be turned into to bound generation.
pub const FRAMES_PER_SECOND: f64 = 12.5;

/// Characters a second for wide scripts — Han, kana, full-width punctuation.
const WIDE_PER_SECOND: f64 = 4.5;

/// Characters a second for everything else.
const NARROW_PER_SECOND: f64 = 12.5;

/// The share of the expected duration below which a render is too short to be
/// the sentence asked for. A render that stops early is truncation, and the
/// reader loses words without being told.
///
/// ⚠️ **THIS WAS 0.4 AND LET A HALF-LENGTH RENDER THROUGH.** Measured 2026-09-23
/// against the real model: a sentence capped short came back at **0.49×** — cut
/// off mid-clause — and was KEPT, because 0.49 clears 0.4. Half a sentence
/// sounds exactly like a sentence that ended, which is the whole reason a floor
/// exists. 0.6 refuses it, and the slowest healthy render ever measured here is
/// **0.83×**, so there is a fifth of the range in hand. The ceiling's overhead
/// allowance does not apply to the floor deliberately: fixed lead-in silence
/// makes a short render LONGER than its text predicts, never shorter, so it can
/// only push a render away from this bound.
const FLOOR: f64 = 0.6;

/// The share above which it is babble. 2.5 clears the widest healthy reading
/// measured (1.63×) and sits well under the closest runaway (3.14×).
const CEILING: f64 = 2.5;

/// Seconds allowed on top of the band, for the lead-in and tail every render
/// carries. Without it a three-character sentence is refused for being half a
/// second long, since the band alone is proportional and short text has none.
const OVERHEAD_S: f64 = 1.5;

/// How much further than the ceiling generation may run before it is cut off.
///
/// The cap is deliberately **not** the ceiling. Stopping exactly at the refusal
/// threshold produces a render of precisely the maximum length, which is
/// indistinguishable from a sentence that happens to be long — the truncation
/// hides the very fact the check exists to find. Past the cap the answer is
/// known to be wrong, and the check can say so with the evidence in hand.
const CAP_BEYOND_CEILING: f64 = 1.2;

/// How long this text should take to say, in seconds.
///
/// Counted by script rather than by declared language: a Chinese sentence that
/// quotes an English title is both, and one rate for the whole sentence is
/// wrong for whichever part it does not describe.
#[must_use]
pub fn expected_seconds(text: &str) -> f64 {
    let (mut wide, mut narrow) = (0.0, 0.0);
    for c in text.chars() {
        // Whitespace is said by nobody; counting it makes a spaced-out line
        // look slower than the same words closed up.
        if c.is_whitespace() {
            continue;
        }
        if is_wide(c) {
            wide += 1.0;
        } else {
            narrow += 1.0;
        }
    }
    wide / WIDE_PER_SECOND + narrow / NARROW_PER_SECOND
}

/// Whether a character belongs to a script written one syllable to the glyph.
///
/// The ranges are the CJK blocks a book actually contains — Han, the two kana,
/// Hangul, and the full-width forms — rather than a general East Asian width
/// lookup, which this crate would otherwise have to carry a table for.
fn is_wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x115F        // Hangul Jamo
        | 0x2E80..=0x303E      // CJK radicals, Kangxi, CJK punctuation
        | 0x3041..=0x33FF      // kana, Bopomofo, Hangul compatibility, CJK letters
        | 0x3400..=0x4DBF      // CJK extension A
        | 0x4E00..=0x9FFF      // CJK unified
        | 0xA000..=0xA4CF      // Yi
        | 0xAC00..=0xD7A3      // Hangul syllables
        | 0xF900..=0xFAFF      // CJK compatibility
        | 0xFE30..=0xFE4F      // CJK compatibility forms
        | 0xFF00..=0xFF60      // full-width forms
        | 0xFFE0..=0xFFE6
        | 0x20000..=0x3FFFD)   // CJK extensions B and beyond
}

/// The most codec frames this text may take before generation is cut off.
///
/// # Panics
/// Never: the value is clamped into `usize` before conversion.
#[must_use]
pub fn frame_cap(text: &str) -> usize {
    let seconds = (expected_seconds(text) * CEILING + OVERHEAD_S) * CAP_BEYOND_CEILING;
    // A sentence of nothing still gets enough frames to say nothing audibly,
    // so a cap of zero can never be handed to the model as "generate forever".
    let frames = (seconds * FRAMES_PER_SECOND).ceil().max(1.0);
    frames as usize
}

/// What to do with a render that has come back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The length is what the text deserves. Keep it.
    Keep,
    /// It is not, and there are attempts left: render it again with another
    /// seed. The model is sampled, so the same text can come back right.
    Again,
    /// It is not, and there are none left. Say which sentence, and skip it.
    Refuse,
}

/// The band a render's length must fall in, in seconds.
#[must_use]
pub fn band(text: &str) -> (f64, f64) {
    let expected = expected_seconds(text);
    (expected * FLOOR, expected * CEILING + OVERHEAD_S)
}

/// Judge a finished render by its length.
///
/// `attempts_left` is how many further renders are allowed after this one, so
/// zero means this was the last.
#[must_use]
pub fn verdict(text: &str, seconds: f64, attempts_left: u32) -> Verdict {
    let (low, high) = band(text);
    // A render that is not a number at all — a NaN length from a broken answer
    // — fails both comparisons, so it is stated rather than left to the
    // comparison's default.
    let sound = seconds.is_finite() && seconds >= low && seconds <= high;
    if sound {
        Verdict::Keep
    } else if attempts_left > 0 {
        Verdict::Again
    } else {
        Verdict::Refuse
    }
}

/// Split text into the pieces the model is asked for, one at a time.
///
/// A paragraph handed to an autoregressive model is a paragraph's worth of
/// chances to run away, and one runaway costs the whole paragraph. A sentence
/// costs a sentence, and the reader is told which one.
///
/// Splitting keeps the mark with the sentence it ends, so nothing is lost and
/// the pieces rejoin into the original text exactly.
#[must_use]
pub fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes_len = text.len();
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if !is_end_mark(c) {
            continue;
        }
        // Take every closing mark that belongs to this sentence: a full stop
        // inside a quotation ends the sentence outside it too, and a run of
        // marks (`?!`, `……`) is one ending rather than several.
        let mut end = i + c.len_utf8();
        while let Some(&(j, next)) = chars.peek() {
            if is_end_mark(next) || is_closer(next) {
                end = j + next.len_utf8();
                chars.next();
            } else {
                break;
            }
        }
        let piece = &text[start..end];
        if !piece.trim().is_empty() {
            out.push(piece);
        }
        start = end;
    }
    if start < bytes_len {
        let rest = &text[start..];
        if !rest.trim().is_empty() {
            out.push(rest);
        }
    }
    out
}

/// A mark that ends a sentence, in either script.
fn is_end_mark(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '\u{3002}' | '\u{FF01}' | '\u{FF1F}' | '\u{FF1B}' | ';' | '\u{2026}')
}

/// A mark that belongs to the sentence it follows rather than the next one.
fn is_closer(c: char) -> bool {
    matches!(
        c,
        '"' | '\'' | '\u{201D}' | '\u{2019}' | '\u{300D}' | '\u{300F}' | '\u{FF09}' | ')' | '\u{300B}'
    )
}

#[cfg(test)]
mod tests;
