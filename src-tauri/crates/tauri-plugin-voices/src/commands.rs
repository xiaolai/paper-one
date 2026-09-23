//! What the webview may ask of the voices plugin.
//!
//! ⚠️ **THE COMMAND INVENTORY IS IN THREE PLACES AND STAYS THERE**, exactly as
//! `tauri-plugin-peer`'s is and for the same reason: `tauri::generate_handler!`
//! needs literal tokens at expansion time and `build.rs` runs before the crate
//! compiles, so neither list can be derived from the other without a third
//! artifact that would become a fourth place to keep in step. [`lists_agree`]
//! is the mechanism instead — it fails the build when they disagree.
//!
//! # What a command here may and may not do
//!
//! Rendering holds a model and can take minutes, so every long call takes a
//! cancel token and answers to it. Nothing here writes outside the voices root,
//! and every path is built from a pack id the embedded manifest declares —
//! never from a string the webview chose.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::cancel::{Cancel, Stopper};
use crate::english::FrontEnd;
use crate::install::{install, installed, remove, Progress};
use crate::kokoro::Kokoro;
use crate::manifest::{self, Family, Manifest, Pack};
use crate::paths::Layout;
use crate::qwen;

/// What the webview is told about a pack.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRow {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub family: String,
    pub languages: Vec<String>,
    pub bytes: u64,
    pub minimum_memory_gb: u32,
    pub voices: Vec<VoiceRow>,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRow {
    pub id: String,
    pub name: String,
    pub language: String,
    pub note: String,
}

/// A word, and when it is spoken, in the shape the interface counts in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordRow {
    /// UTF-16 code units into the requested text, which is what a web front
    /// end counts in. The engines answer in the same unit for that reason.
    pub start: usize,
    pub length: usize,
    pub start_ms: u32,
    pub end_ms: u32,
}

/// A sentence that was not said, and why.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRow {
    pub text: String,
    pub why: String,
}

/// Audio and its timings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpokenRow {
    /// 16-bit mono PCM, little-endian. A byte array rather than samples,
    /// because that is what crosses the IPC boundary without being widened to
    /// a JSON number each.
    pub pcm: Vec<u8>,
    pub sample_rate: u32,
    pub words: Vec<WordRow>,
    pub skipped: Vec<SkippedRow>,
}

/// A model held between calls, with the pack it came from.
///
/// `Arc` so a render can be moved onto a blocking thread: a chapter takes
/// minutes, and a `#[tauri::command] async fn` that does that work inline holds
/// a runtime worker for the whole of it.
type Held<T> = Arc<Mutex<Option<(String, T)>>>;

/// What the plugin holds between calls.
#[derive(Debug, Default)]
pub struct VoicesState {
    /// Where packs are installed. Set at startup from the app's data root.
    root: Mutex<Option<PathBuf>>,
    /// The Kokoro model, once something has asked it to read.
    kokoro: Held<Kokoro>,
    /// Its front end, which reads 180 000 lexicon entries and is worth keeping.
    english: Held<FrontEnd>,
    /// Which pack the Qwen engine has loaded, and at what sample rate.
    qwen: Held<u32>,
    /// Stop tokens for downloads in flight, by pack id.
    fetching: Mutex<HashMap<String, Stopper>>,
}

impl VoicesState {
    /// Say where packs live. Called once, from the plugin's `setup`.
    pub fn set_root(&self, root: PathBuf) {
        if let Ok(mut held) = self.root.lock() {
            *held = Some(root);
        }
    }

    /// Where packs live, once the app has said.
    fn layout(&self) -> Result<Layout, String> {
        let root = self
            .root
            .lock()
            .map_err(|_| "the voices root is poisoned".to_owned())?;
        let root = root
            .as_ref()
            .ok_or_else(|| "the voices root is not set".to_owned())?;
        Ok(Layout::under(root))
    }
}

/// How many threads an engine may use.
///
/// Half the machine, at least one. A reader listening to a book is using the
/// rest of it, and an engine that takes every core makes the app it is reading
/// in stutter — which is the one thing a voice must never do.
fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1))
}

/// The embedded catalogue. Infallible: it is checked by this crate's own tests,
/// so a manifest that will not parse fails the build rather than a reader's
/// download.
fn catalogue() -> Manifest {
    manifest::embedded()
}

/// Find a pack by the id the webview gave, which is never trusted as a path.
fn pack_of<'a>(catalogue: &'a Manifest, id: &str) -> Result<&'a Pack, String> {
    catalogue
        .packs
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("there is no voice pack called {id}"))
}

/// Every pack this device could have, and whether it has it.
///
/// # Errors
/// When the embedded catalogue will not parse, which is a build defect rather
/// than anything a reader did.
#[tauri::command]
pub async fn voices_catalogue<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, VoicesState>,
) -> Result<Vec<PackRow>, String> {
    let catalogue = catalogue();
    let layout = state.layout()?;
    let mut rows = Vec::with_capacity(catalogue.packs.len());
    for pack in &catalogue.packs {
        rows.push(PackRow {
            id: pack.id.clone(),
            name: pack.name.clone(),
            summary: pack.summary.clone(),
            family: pack.family.as_str().to_owned(),
            languages: pack.languages.clone(),
            bytes: pack.artifacts.iter().map(|a| a.bytes).sum(),
            minimum_memory_gb: pack.minimum_memory_gb,
            voices: pack
                .voices
                .iter()
                .map(|v| VoiceRow {
                    id: v.id.clone(),
                    name: v.name.clone(),
                    language: v.language.clone(),
                    note: v.note.clone(),
                })
                .collect(),
            installed: installed(&layout, pack).unwrap_or(false),
        });
    }
    Ok(rows)
}

/// Fetch a pack, reporting progress as an event.
///
/// # Errors
/// When the pack is unknown, a byte fails its digest, or the reader stopped it.
#[tauri::command]
pub async fn voices_install<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VoicesState>,
    pack: String,
) -> Result<(), String> {
    use tauri::Emitter;

    let catalogue = catalogue();
    let wanted = pack_of(&catalogue, &pack)?;
    let layout = state.layout()?;
    let (cancel, stopper) = Cancel::new();
    {
        let mut fetching = state
            .fetching
            .lock()
            .map_err(|_| "the download list is poisoned".to_owned())?;
        if fetching.contains_key(&pack) {
            return Err(format!("{pack} is already downloading"));
        }
        fetching.insert(pack.clone(), stopper);
    }
    let client = reqwest::Client::new();
    let outcome = install(&client, &layout, wanted, &cancel, |progress| {
        let payload = match progress {
            Progress::Downloading { received, total } => {
                serde_json::json!({"pack": pack, "kind": "downloading", "received": received, "total": total})
            }
            Progress::Verifying => serde_json::json!({"pack": pack, "kind": "verifying"}),
            Progress::Installed => serde_json::json!({"pack": pack, "kind": "installed"}),
        };
        // A dropped progress event costs a stale number on screen and nothing
        // else, so it must not end the download.
        let _ = app.emit("voices://progress", payload);
    })
    .await;
    if let Ok(mut fetching) = state.fetching.lock() {
        fetching.remove(&pack);
    }
    outcome.map_err(|e| e.to_string())
}

/// Stop a download that is in flight, leaving nothing half-installed.
///
/// # Errors
/// Never fails for a pack that is not downloading: stopping something already
/// stopped is what a second press of the button is.
#[tauri::command]
pub async fn voices_stop(state: State<'_, VoicesState>, pack: String) -> Result<(), String> {
    let mut fetching = state
        .fetching
        .lock()
        .map_err(|_| "the download list is poisoned".to_owned())?;
    if let Some(stopper) = fetching.remove(&pack) {
        stopper.stop();
    }
    Ok(())
}

/// Remove an installed pack.
///
/// # Errors
/// When the pack is unknown or its files cannot be removed.
#[tauri::command]
pub async fn voices_remove(state: State<'_, VoicesState>, pack: String) -> Result<(), String> {
    let catalogue = catalogue();
    // Refuses an id the catalogue does not declare, BEFORE any path is built
    // from it: the id reaches the filesystem, and the only ids that may are
    // the ones the embedded manifest names.
    pack_of(&catalogue, &pack)?;
    let layout = state.layout()?;
    // A model still loaded from this pack would hold the files open and keep
    // reading from a pack the reader has removed.
    release_engines(&state, &pack)?;
    remove(&layout, &pack).await.map_err(|e| e.to_string())
}

/// Let go of anything loaded from a pack.
fn release_engines(state: &State<'_, VoicesState>, pack: &str) -> Result<(), String> {
    if let Ok(mut held) = state.kokoro.lock() {
        if held.as_ref().is_some_and(|(id, _)| id == pack) {
            *held = None;
        }
    }
    if let Ok(mut held) = state.english.lock() {
        if held.as_ref().is_some_and(|(id, _)| id == pack) {
            *held = None;
        }
    }
    if let Ok(mut held) = state.qwen.lock() {
        if held.as_ref().is_some_and(|(id, _)| id == pack) {
            qwen::engine::unload();
            *held = None;
        }
    }
    Ok(())
}

/// Let every model go, and its memory with it.
///
/// # Errors
/// When a lock is poisoned, which is a panic elsewhere rather than anything
/// this call did.
#[tauri::command]
pub async fn voices_release(state: State<'_, VoicesState>) -> Result<(), String> {
    *state
        .kokoro
        .lock()
        .map_err(|_| "the engine is poisoned".to_owned())? = None;
    *state
        .english
        .lock()
        .map_err(|_| "the engine is poisoned".to_owned())? = None;
    let mut qwen_held = state
        .qwen
        .lock()
        .map_err(|_| "the engine is poisoned".to_owned())?;
    if qwen_held.is_some() {
        qwen::engine::unload();
        *qwen_held = None;
    }
    Ok(())
}

/// Read some text aloud.
///
/// # Errors
/// When the pack is unknown or not installed, when the engine refuses, or when
/// nothing at all could be said — never a silent partial answer.
#[tauri::command]
pub async fn voices_render(
    state: State<'_, VoicesState>,
    pack: String,
    voice: String,
    text: String,
    rate: Option<f32>,
) -> Result<SpokenRow, String> {
    let catalogue = catalogue();
    let wanted = pack_of(&catalogue, &pack)?;
    let layout = state.layout()?;
    if !installed(&layout, wanted).unwrap_or(false) {
        return Err(format!("{pack} is not installed"));
    }
    let dir = layout.pack_dir(&pack).map_err(|e| e.to_string())?;
    let family = wanted.family;
    let kokoro = Arc::clone(&state.kokoro);
    let english = Arc::clone(&state.english);
    let qwen = Arc::clone(&state.qwen);
    /* A chapter is minutes of work. On the runtime it would hold a worker for
     * all of it; on a blocking thread it holds one of the pool's. */
    tauri::async_runtime::spawn_blocking(move || match family {
        Family::Kokoro => read_with_kokoro(&dir, &pack, &kokoro, &english, &voice, &text, rate),
        Family::Qwen => read_with_qwen(&dir, &pack, &qwen, &voice, &text),
    })
    .await
    .map_err(|e| format!("the voice stopped unexpectedly: {e}"))?
}

/// English, through Kokoro: the front end, then the model, with word timings.
fn read_with_kokoro(
    dir: &Path,
    pack: &str,
    held: &Held<Kokoro>,
    fronts: &Held<FrontEnd>,
    voice: &str,
    text: &str,
    rate: Option<f32>,
) -> Result<SpokenRow, String> {
    let mut fronts = fronts
        .lock()
        .map_err(|_| "the voice is poisoned".to_owned())?;
    if fronts.as_ref().is_none_or(|(id, _)| id != pack) {
        let front = FrontEnd::load(&dir.join("lexicon")).map_err(|e| e.to_string())?;
        *fronts = Some((pack.to_owned(), front));
    }
    let (_, front) = fronts
        .as_ref()
        .ok_or_else(|| "the voice did not load".to_owned())?;
    let prepared = front.phonemise(text);

    let mut held = held
        .lock()
        .map_err(|_| "the voice is poisoned".to_owned())?;
    if held.as_ref().is_none_or(|(id, _)| id != pack) {
        let engine = Kokoro::load(dir, threads()).map_err(|e| e.to_string())?;
        *held = Some((pack.to_owned(), engine));
    }
    let (_, engine) = held
        .as_mut()
        .ok_or_else(|| "the voice did not load".to_owned())?;
    let rendered = engine
        .render(&prepared, voice, rate.unwrap_or(1.0))
        .map_err(|e| e.to_string())?;

    Ok(SpokenRow {
        pcm: pcm_bytes(&rendered.samples),
        sample_rate: rendered.sample_rate,
        words: rendered
            .words
            .iter()
            .map(|w| WordRow {
                start: w.source_start,
                length: w.source_len,
                start_ms: w.start_ms,
                end_ms: w.end_ms,
            })
            .collect(),
        /* A word the front end cannot pronounce is REPORTED, never guessed at,
         * and it is the same kind of answer as a sentence the Qwen engine
         * refused: something the reader will not hear, named. */
        skipped: prepared
            .unknown
            .iter()
            .map(|word| SkippedRow {
                text: word.clone(),
                why: "there is no pronunciation for this word".to_owned(),
            })
            .collect(),
    })
}

/// Chinese, through Qwen: sentence at a time, each one checked.
fn read_with_qwen(
    dir: &Path,
    pack: &str,
    held: &Held<u32>,
    voice: &str,
    text: &str,
) -> Result<SpokenRow, String> {
    let mut held = held
        .lock()
        .map_err(|_| "the voice is poisoned".to_owned())?;
    if held.as_ref().is_none_or(|(id, _)| id != pack) {
        let rate = qwen::engine::load(dir).map_err(|e| e.to_string())?;
        *held = Some((pack.to_owned(), rate));
    }
    let (_, sample_rate) = *held
        .as_ref()
        .ok_or_else(|| "the voice did not load".to_owned())?;
    let reading = qwen::engine::read(text, sample_rate, |sentence, seed, cap, room| {
        qwen::engine::through_bridge(sentence, voice, "zh", sample_rate, seed, cap, room)
    });
    let samples: Vec<i16> = reading
        .spoken
        .iter()
        .flat_map(|s| s.samples.iter().copied())
        .collect();
    if samples.is_empty() {
        /* Every sentence refused is not a quiet answer: an empty file that
         * plays as silence is the failure worth naming. */
        let why = reading
            .skipped
            .first()
            .map_or_else(|| "nothing could be said".to_owned(), |s| s.why.clone());
        return Err(why);
    }
    Ok(SpokenRow {
        pcm: pcm_bytes(&samples),
        sample_rate,
        /* Qwen reports no word boundaries. EMPTY rather than invented: the
         * reading falls back to a sentence highlight, which is the honest unit
         * when the words are not known. */
        words: Vec::new(),
        skipped: reading
            .skipped
            .iter()
            .map(|s| SkippedRow {
                text: s.text.clone(),
                why: s.why.clone(),
            })
            .collect(),
    })
}

/// Speak a chapter into a WAV file, for the audiobook export.
///
/// ⚠️ **A FILE RATHER THAN BYTES, AND NOT FOR CONVENIENCE.** A ten-hour book
/// is gigabytes of PCM; handing a chapter across the IPC as a JSON array would
/// widen every sample to a decimal number and hold the whole of it in the
/// webview's heap. `narrate_render` already writes files for the same reason,
/// and `narrate_package` — the muxer, `afconvert`, the chapter track, both
/// readers' checks — reads them and is untouched by this.
///
/// # Errors
/// When the pack is unknown or not installed, when the engine refuses, when
/// the chapter is longer than a WAV header can state, or when the file cannot
/// be written. Never a partial file: a short WAV is indistinguishable from a
/// short chapter, so a failed write removes what it wrote.
#[tauri::command]
pub async fn voices_render_file(
    state: State<'_, VoicesState>,
    pack: String,
    voice: String,
    text: String,
    rate: Option<f32>,
    path: String,
) -> Result<u32, String> {
    let row = voices_render(state, pack, voice, text, rate).await?;
    let samples: Vec<i16> = row
        .pcm
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let bytes = crate::wav::bytes(&samples, row.sample_rate)?;
    let target = PathBuf::from(&path);
    tokio::fs::write(&target, &bytes).await.map_err(|e| {
        /* A half-written chapter reads as a short one, and the packer would
         * join it without complaint. Removed rather than left. */
        let _ = std::fs::remove_file(&target);
        format!("{path} could not be written: {e}")
    })?;
    Ok(row.sample_rate)
}

/// 16-bit samples as little-endian bytes, which is what crosses the IPC.
fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests;
