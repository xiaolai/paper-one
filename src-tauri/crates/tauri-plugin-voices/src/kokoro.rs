//! Kokoro, through ONNX Runtime: phonemes in, audio and word timings out.
//!
//! `tract` — pure Rust, no native binary downloaded at build time — was tried
//! first and **cannot load this model at all**: it refuses the vocoder's STFT
//! node (`inputs[0].rank == 3 … Impossible to unify 2 with 3`). So `ort` it is,
//! and the ONNX Runtime binary its build script fetches is a supply-chain cost
//! the catalogue's pinning does not cover — see the plan's risk table.
//!
//! # Three things measured rather than assumed
//!
//! Each of these was found by running the real model (WI-30.0 A), and each has a
//! plausible wrong answer that produces audio a listener would accept while the
//! highlight drifts:
//!
//! - **`durations` is f32, one per token** — not the int64 the name suggests.
//! - **Each duration is rounded to whole frames BEFORE accumulating.** The float
//!   sum gives 80 264 samples for an 81 000-sample waveform; rounding each first
//!   gives exactly 81 000. Accumulate the floats and every word drifts late, by
//!   a third of a second over one sentence.
//! - **The style vector is chosen by the UNPADDED token count.** The voice file
//!   is 510 rows of 256 floats and the row is `ids.len() - 2`; the wrong row is
//!   still a voice, just not the one the reader chose.
//!
//! A frame is 600 samples at 24 kHz, and the rounded sum must equal the sample
//! count exactly. That equality is asserted on every render: it is the cheapest
//! possible proof that the timings and the audio are the same utterance.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use crate::english::Phonemised;
use crate::error::{Error, Result};

/// What Kokoro speaks at.
pub const SAMPLE_RATE: u32 = 24_000;
/// One duration frame, in samples — 40 frames a second.
const FRAME_SAMPLES: usize = 600;
/// The model's own limit on how many tokens it will take at once.
const MAX_TOKENS: usize = 510;
/// Each voice file is this many rows of 256 floats, indexed by token count.
const STYLE_ROWS: usize = 510;
const STYLE_WIDTH: usize = 256;

/// One word, and when it is spoken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordTiming {
    /// Where the word sits in the text handed in, in UTF-16 code units.
    pub source_start: usize,
    pub source_len: usize,
    /// When it is spoken, in milliseconds from the start of this render.
    pub start_ms: u32,
    pub end_ms: u32,
}

/// A finished render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// 16-bit mono, the shape `narrate/wav.rs` accepts.
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub words: Vec<WordTiming>,
}

impl Rendered {
    /// Gather a render, refusing one with no audio.
    ///
    /// A render that produced nothing is the failure worth naming: silence of
    /// the right length is indistinguishable from speech until somebody plays
    /// it, and a chapter of it reaches the reader as a finished file. So no
    /// `Rendered` exists without samples, rather than callers each remembering
    /// to look.
    ///
    /// # Errors
    /// [`Error::Malformed`] when there are no samples.
    fn gather(voice: &str, samples: Vec<i16>, words: Vec<WordTiming>) -> Result<Self> {
        if samples.is_empty() {
            return Err(Error::Malformed {
                route: format!("kokoro:{voice}"),
                why: "the model produced no audio".to_owned(),
            });
        }
        Ok(Self { samples, sample_rate: SAMPLE_RATE, words })
    }

    /// How long it is, in milliseconds.
    #[must_use]
    pub fn duration_ms(&self) -> u32 {
        u32::try_from(self.samples.len() * 1000 / self.sample_rate as usize).unwrap_or(u32::MAX)
    }
}

/// How many whole frames the durations account for, refusing audio they do not.
///
/// Rounding happens per token and before the sum, which is the WI-30.0
/// measurement: the float sum of one render's durations gave 80 264 samples for
/// an 81 000-sample waveform, and the rounded sum gave exactly 81 000. The
/// equality is what proves the timings describe this audio and not another
/// render's.
///
/// # Errors
/// [`Error::Malformed`] when the frames do not account for every sample.
fn accounted(voice: &str, durations: &[f32], samples: usize) -> Result<usize> {
    let frames: usize = durations.iter().map(|d| d.round().max(0.0) as usize).sum();
    if frames * FRAME_SAMPLES != samples {
        return Err(Error::Malformed {
            route: format!("kokoro:{voice}"),
            why: format!(
                "{frames} frames of durations account for {} samples, but the model answered {samples}",
                frames * FRAME_SAMPLES
            ),
        });
    }
    Ok(frames)
}

/// The model, loaded.
#[derive(Debug)]
pub struct Kokoro {
    session: Session,
    /// Phoneme to token id, from the pack's `tokenizer.json`.
    vocab: HashMap<char, i64>,
    voices_dir: PathBuf,
    /// Voice styles already read, since each is half a megabyte.
    styles: HashMap<String, Vec<f32>>,
}

impl Kokoro {
    /// Load the model and its vocabulary from an installed pack.
    ///
    /// # Errors
    /// [`Error::Io`] if a file is missing, [`Error::Malformed`] if the
    /// vocabulary or the model is not the shape this engine speaks.
    pub fn load(pack_dir: &Path, threads: usize) -> Result<Self> {
        let vocab = read_vocab(&pack_dir.join("tokenizer.json"))?;
        let model = pack_dir.join("model.onnx");
        let session = open(&model, threads).map_err(|e| Error::Malformed {
            route: model.display().to_string(),
            why: e.to_string(),
        })?;
        Ok(Self { session, vocab, voices_dir: pack_dir.join("voices"), styles: HashMap::new() })
    }

    /// Speak what the front end prepared.
    ///
    /// # Errors
    /// [`Error::Malformed`] if a phoneme is outside the model's vocabulary, if
    /// the model answers without audio, or if the durations do not account for
    /// the samples — see the header.
    pub fn render(&mut self, text: &Phonemised, voice: &str, speed: f32) -> Result<Rendered> {
        let phonemes: Vec<char> = text.phonemes.chars().collect();
        let mut samples: Vec<i16> = Vec::new();
        let mut words: Vec<WordTiming> = Vec::new();
        let mut frames_before = 0usize;

        for chunk in chunks(&phonemes, MAX_TOKENS) {
            let piece: String = phonemes[chunk.clone()].iter().collect();
            let (chunk_samples, durations) = self.run(&piece, voice, speed)?;
            let frames = accounted(voice, &durations, chunk_samples.len())?;
            words.extend(timings_for(text, &chunk, &durations, frames_before));
            frames_before += frames;
            samples.extend(chunk_samples);
        }

        Rendered::gather(voice, samples, words)
    }

    /// One pass of the model: token ids in, samples and per-token durations out.
    fn run(&mut self, phonemes: &str, voice: &str, speed: f32) -> Result<(Vec<i16>, Vec<f32>)> {
        let mut ids = Vec::with_capacity(phonemes.chars().count() + 2);
        ids.push(0i64);
        for c in phonemes.chars() {
            let id = self.vocab.get(&c).copied().ok_or_else(|| Error::Malformed {
                route: format!("kokoro:{voice}"),
                why: format!("{c:?} is not a sound this model can say"),
            })?;
            ids.push(id);
        }
        ids.push(0);
        let style = self.style(voice, ids.len() - 2)?;

        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, ids.len()], ids.clone())).map_err(|e| malformed(voice, &e))?,
                "style" => Tensor::from_array(([1usize, STYLE_WIDTH], style)).map_err(|e| malformed(voice, &e))?,
                "speed" => Tensor::from_array(([1usize], vec![speed])).map_err(|e| malformed(voice, &e))?,
            ])
            .map_err(|e| malformed(voice, &e))?;

        let (_, waveform) = outputs["waveform"]
            .try_extract_tensor::<f32>()
            .map_err(|e| malformed(voice, &e))?;
        let (_, durations) = outputs["durations"]
            .try_extract_tensor::<f32>()
            .map_err(|e| malformed(voice, &e))?;
        let samples = waveform
            .iter()
            .map(|s| (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
            .collect();
        Ok((samples, durations.to_vec()))
    }

    /// The style vector for a voice at this token count, read once per voice.
    fn style(&mut self, voice: &str, tokens: usize) -> Result<Vec<f32>> {
        if !self.styles.contains_key(voice) {
            let path = self.voices_dir.join(format!("{}.bin", crate::paths::safe_component(voice)?));
            let bytes = std::fs::read(&path)?;
            if bytes.len() != STYLE_ROWS * STYLE_WIDTH * 4 {
                return Err(Error::Malformed {
                    route: path.display().to_string(),
                    why: format!(
                        "a voice is {} rows of {STYLE_WIDTH} floats; this file holds {} bytes",
                        STYLE_ROWS,
                        bytes.len()
                    ),
                });
            }
            let floats = bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            self.styles.insert(voice.to_owned(), floats);
        }
        let floats = &self.styles[voice];
        // The UNPADDED count chooses the row — see the header.
        let row = tokens.min(STYLE_ROWS - 1);
        Ok(floats[row * STYLE_WIDTH..(row + 1) * STYLE_WIDTH].to_vec())
    }
}

/// Open the model. Its own error types do not chain, so the `?`s live here and
/// the caller says which file could not be opened.
fn open(model: &Path, threads: usize) -> std::result::Result<Session, Box<dyn std::error::Error>> {
    Ok(Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(threads.max(1))?
        .commit_from_file(model)?)
}

fn malformed(voice: &str, error: &impl std::fmt::Display) -> Error {
    Error::Malformed { route: format!("kokoro:{voice}"), why: error.to_string() }
}

/// Kokoro's phoneme vocabulary, from the pack's `tokenizer.json`.
fn read_vocab(path: &Path) -> Result<HashMap<char, i64>> {
    let text = std::fs::read_to_string(path)?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| Error::Malformed {
        route: path.display().to_string(),
        why: e.to_string(),
    })?;
    let map = json["model"]["vocab"].as_object().ok_or_else(|| Error::Malformed {
        route: path.display().to_string(),
        why: "no model.vocab in the tokenizer".to_owned(),
    })?;
    let mut vocab = HashMap::new();
    for (symbol, id) in map {
        let mut chars = symbol.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if let Some(id) = id.as_i64() {
                vocab.insert(c, id);
            }
        }
    }
    if vocab.is_empty() {
        return Err(Error::Malformed {
            route: path.display().to_string(),
            why: "the tokenizer holds no single-character symbols".to_owned(),
        });
    }
    Ok(vocab)
}

/// Split a phoneme string into pieces the model will take, preferring to break
/// where a reader would: a sentence, then a clause, and only then wherever it
/// must — because a break mid-word is audible and a break at a comma is not.
#[must_use]
pub fn chunks(phonemes: &[char], max: usize) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < phonemes.len() {
        let end = (start + max).min(phonemes.len());
        if end == phonemes.len() {
            out.push(start..end);
            break;
        }
        let window = &phonemes[start..end];
        let split = last_of(window, &['.', '!', '?', '…'])
            .or_else(|| last_of(window, &[',', ';', ':', '—']))
            .or_else(|| last_of(window, &[' ']))
            .map_or(end, |at| start + at + 1);
        out.push(start..split);
        start = split;
    }
    out
}

fn last_of(window: &[char], marks: &[char]) -> Option<usize> {
    window.iter().rposition(|c| marks.contains(c))
}

/// When each word of this chunk is spoken, from the durations the model gave.
fn timings_for(
    text: &Phonemised,
    chunk: &std::ops::Range<usize>,
    durations: &[f32],
    frames_before: usize,
) -> Vec<WordTiming> {
    // `durations` is one per token, and the tokens are `[pad, …phonemes…, pad]`,
    // so token `i + 1` belongs to phoneme `chunk.start + i`.
    let mut cumulative = Vec::with_capacity(durations.len() + 1);
    let mut frames = 0usize;
    cumulative.push(0usize);
    for d in durations {
        frames += d.round().max(0.0) as usize;
        cumulative.push(frames);
    }
    let at = |phoneme: usize| -> u32 {
        let token = phoneme - chunk.start + 1;
        let frames = frames_before + cumulative.get(token).copied().unwrap_or(frames);
        u32::try_from(frames * FRAME_SAMPLES * 1000 / SAMPLE_RATE as usize).unwrap_or(u32::MAX)
    };
    text.words
        .iter()
        .filter(|w| w.phoneme_start >= chunk.start && w.phoneme_start < chunk.end)
        .map(|w| WordTiming {
            source_start: w.source_start,
            source_len: w.source_len,
            start_ms: at(w.phoneme_start),
            end_ms: at((w.phoneme_start + w.phoneme_len).min(chunk.end)),
        })
        .collect()
}

#[cfg(test)]
#[path = "kokoro/tests.rs"]
mod tests;
