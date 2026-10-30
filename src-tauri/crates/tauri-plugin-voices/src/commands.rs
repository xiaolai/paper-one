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
use crate::clips::{self, Clip, Evicted, Key, Skip, Store, Word};
use crate::english::FrontEnd;
use crate::install::{install, installed, remove, Progress};
use crate::kokoro::Kokoro;
use crate::machine;
use crate::manifest::{self, Family, Manifest, Pack, Platform};
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

/// What an engine answered, before anything has decided where it goes.
///
/// ⚠️ **A VALUE RATHER THAN A `SpokenRow`, BECAUSE THERE ARE TWO DESTINATIONS
/// NOW.** `voices_render` widens the samples to bytes for the IPC and
/// `voices_clip_render` writes them to disk; building the byte array on the way
/// to the disk would double a 140 MB section for nothing. The engines answer in
/// samples, so this is the shape they already have.
pub struct Rendered {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub words: Vec<WordRow>,
    pub skipped: Vec<SkippedRow>,
}

impl Rendered {
    /// The IPC's shape: samples widened to little-endian bytes.
    #[must_use]
    pub fn row(self) -> SpokenRow {
        SpokenRow {
            pcm: pcm_bytes(&self.samples),
            sample_rate: self.sample_rate,
            words: self.words,
            skipped: self.skipped,
        }
    }
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
    /// The rendered reading, opened on the first call that needs it.
    ///
    /// ⚠️ **LAZY, BECAUSE OPENING IT RECONCILES THE WHOLE DIRECTORY.** A reader
    /// who never presses Listen should not pay for a `stat` of every clip at
    /// launch, and a reader who has never listened has no clips to reconcile.
    clips: Mutex<Option<Store>>,
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

impl VoicesState {
    /// The rendered-reading store, opened once.
    ///
    /// ⚠️ **THE APP'S DATA ROOT, NOT A `voices/` UNDER IT.** `clips::Layout`
    /// joins its own `audio` segment, exactly as `paths::Layout` joins `voices`
    /// — and this plugin has already shipped `voices/voices/packs` once by
    /// passing a root that already ended in the segment.
    fn with_clips<T>(
        &self,
        work: impl FnOnce(&mut Store) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut held = self
            .clips
            .lock()
            .map_err(|_| "the rendered reading is poisoned".to_owned())?;
        if held.is_none() {
            let root = self
                .root
                .lock()
                .map_err(|_| "the voices root is poisoned".to_owned())?
                .clone()
                .ok_or_else(|| "the voices root is not set".to_owned())?;
            *held = Some(Store::open(&root, clips::BUDGET_BYTES).map_err(|e| e.to_string())?);
        }
        let store = held
            .as_mut()
            .ok_or_else(|| "the rendered reading did not open".to_owned())?;
        work(store)
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
/// ⚠️ **THIS IS WHAT `manifest::offered` IS FOR, AND IT WENT UNCALLED.** The
/// filter — the right platform, and enough memory — was written in WI-30.1 with
/// a test of its own, and this walked `catalogue.packs` directly instead. So a
/// macOS-only pack was listed on Windows and Linux, and a 2.3 GB pack declaring
/// an 8 GB floor was offered to every machine whatever it had, which is the
/// thing the floor exists to prevent: 2.3 GB downloaded and then killed by the
/// system on the first sentence. Found by the 2026-09-23 audit, which reported
/// the TypeScript half (`withinMemory`) as dead code — the same rule, written
/// twice and applied nowhere.
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
    let offered = manifest::offered(&catalogue, Platform::current(), machine::memory_gb());
    let mut rows = Vec::with_capacity(offered.len());
    for pack in offered {
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
/// ⚠️ **NOT A COMMAND ANY MORE, AND THE REASON IS A MEASUREMENT.** `SpokenRow`
/// carries the samples as bytes across the IPC, and WI-34.0 measured a real
/// section at **139 924 800 bytes** — which is the same objection
/// `voices_render_file` was written for. The webview asks for a CLIP now
/// (`voices_clip_render`) and reads the file; this is the shared half both roads
/// go through, and `voices_render_file` is the other caller.
///
/// # Errors
/// When the pack is unknown or not installed, when the engine refuses, or when
/// nothing at all could be said — never a silent partial answer.
pub async fn voices_render(
    state: &State<'_, VoicesState>,
    pack: String,
    voice: String,
    text: String,
    rate: Option<f32>,
) -> Result<Rendered, String> {
    let catalogue = catalogue();
    let wanted = pack_of(&catalogue, &pack)?;
    let layout = state.layout()?;
    /* ⚠️ **AN I/O FAILURE HERE USED TO READ AS "NOT INSTALLED" — FOUND BY AN
     * INDEPENDENT AUDIT, 2026-09-30.** `.unwrap_or(false)` turned a permission
     * error or an unreadable directory into the one sentence a reader can do
     * nothing about: the pack IS installed, the row in Settings says so, and the
     * reading refuses it as absent. That is the absent-versus-unreadable rule this
     * repository has already had to fix in eighteen stores, in the one place where
     * it decides whether a book can be read aloud at all. */
    readable(installed(&layout, wanted), &pack)?;
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
) -> Result<Rendered, String> {
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

    Ok(Rendered {
        samples: rendered.samples,
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
) -> Result<Rendered, String> {
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
    Ok(Rendered {
        samples,
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
) -> Result<RenderedFile, String> {
    let rendered = voices_render(&state, pack, voice, text, rate).await?;
    let bytes = crate::wav::bytes(&rendered.samples, rendered.sample_rate)?;
    let target = PathBuf::from(&path);
    tokio::fs::write(&target, &bytes).await.map_err(|e| {
        /* A half-written chapter reads as a short one, and the packer would
         * join it without complaint. Removed rather than left. */
        let _ = std::fs::remove_file(&target);
        format!("{path} could not be written: {e}")
    })?;
    Ok(RenderedFile {
        sample_rate: rendered.sample_rate,
        skipped: rendered
            .skipped
            .into_iter()
            .map(|s| SkippedRow {
                text: s.text,
                why: s.why,
            })
            .collect(),
    })
}

/// What a chapter written to a file is reported as.
///
/// ⚠️ **THE SKIPS ARE HERE BECAUSE THIS COMMAND ANSWERED ONLY A SAMPLE RATE,
/// AND THE EXPORT WAS SILENTLY INCOMPLETE — FOUND BY AN INDEPENDENT AUDIT,
/// 2026-09-30.** The engine already refuses a passage it cannot pronounce and
/// names it; the reading shows that to the reader as it happens. The export's
/// own road threw it away between here and the webview, so a book missing a
/// sentence was reported as a finished one. A complete-looking file with less
/// than the whole book in it is the failure `narrate` calls the worst available.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedFile {
    pub sample_rate: u32,
    pub skipped: Vec<SkippedRow>,
}

/// What the webview is told about a rendered section.
///
/// ⚠️ **A PATH AND NOT THE SAMPLES.** WI-34.0 measured a real section at
/// 139 924 800 bytes of audio; the webview reads the file through the fs
/// plugin's `$APPDATA` scope, which is already granted, and gets raw bytes
/// rather than a JSON array of numbers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipRow {
    /// The clip's own name — what `voices_clip_read` takes.
    pub stem: String,
    /// Absolute, for the audiobook packer, which is Rust and takes real paths.
    pub path: String,
    pub bytes: u64,
    pub sample_rate: u32,
    pub duration_ms: u32,
    pub words: Vec<WordRow>,
    pub skipped: Vec<SkippedRow>,
    /// What had to be removed to stay inside the budget. Zero almost always,
    /// and the reader is told when it is not — see WI-34.1's *eviction shown*.
    pub evicted: EvictedRow,
}

/// How much of the budget is used, for the row in Settings.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub bytes: u64,
    pub budget: u64,
    pub clips: u32,
}

/// What an eviction took away.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictedRow {
    pub clips: u32,
    pub bytes: u64,
}

impl From<Evicted> for EvictedRow {
    fn from(gone: Evicted) -> Self {
        Self {
            clips: gone.clips,
            bytes: gone.bytes,
        }
    }
}

/// What the webview asks about, as one value.
///
/// ⚠️ **ONE ARGUMENT AND NOT SEVEN, AND CLIPPY IS RIGHT ABOUT WHY.** A
/// `#[tauri::command]` takes its arguments by name out of one JSON object, so a
/// seven-field key spelled flat is seven parameters whose ORDER a reader has to
/// keep in their head and whose meaning `(String, u32, String, String, …)` does
/// not carry. It is a value on the TypeScript side already — `ClipQuery` in
/// `wire.ts` — so it is a value here.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAsk {
    pub book: String,
    /// Which spine item, or absent where the reader's place cannot say — see
    /// [`crate::clips::Key::section`], which records what a sentinel cost.
    pub section: Option<u32>,
    pub pack: String,
    pub voice: String,
    /// The reader's chosen speed, or none for the pack's own.
    pub rate: Option<f32>,
    pub text_digest: String,
    pub spoken_digest: String,
}

/// The key a command was given, as the store spells it.
///
/// ⚠️ **THE RATE IS QUANTISED TO MILLI-UNITS HERE AND NOWHERE ELSE.** A float in
/// the key would give two spellings of one speed — `1.0` and `0.9999999` — and
/// therefore two clips for one reading, which nothing would notice.
///
/// ⚠️ **AND THE RATE IS THE ONE THE RENDER REALLY USED, WHICH IS NOT ALWAYS THE
/// ONE ASKED FOR — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `read_with_qwen`
/// takes no speed at all: the Chinese bridge has no parameter for one, so a
/// Chinese chapter is rendered at the model's own pace whatever the reader chose.
/// Keyed on the ASKED rate, the store filed that audio under `1500` — so the
/// identity claimed a speed the samples did not have, and a reader moving between
/// 1.0× and 1.5× got two clips of byte-identical audio while each one lied about
/// what it was.
///
/// `effective_rate` is the one place that knows, and it answers by FAMILY rather
/// than by pack id: a second Qwen pack would inherit the truth instead of needing
/// this table edited. Everything else about the reader's speed is unchanged — the
/// control still moves, and what it cannot do on a Chinese voice is a phase-30
/// gap in the bridge, recorded there rather than papered over here.
/// The key for a RENDER, whose spoken digest is computed from the text rather
/// than taken from the caller.
///
/// ⚠️ **THIS EXISTS SO THERE IS NO CHECK TO FORGET.** The first fix for the audit's
/// finding was a `describes(&text, &ask.spoken_digest)?` line above the render —
/// correct, and invisible to every test, because the command needs a Tauri `State`
/// and cannot be called from one. Removing that line broke nothing: *a guard whose
/// tests all stand in for the path it sits on is a guard nobody has seen work*.
///
/// So the render's key is DERIVED. The digest in it is the digest of this text by
/// construction, and the caller's claim is compared on the way past — which makes
/// filing text B's audio under text A's identity unreachable rather than guarded
/// against.
///
/// `voices_clip_find` cannot do this: it has no text, only a key. That is
/// harmless, and the asymmetry is the point — a wrong claim there produces a MISS,
/// where a wrong claim here would produce wrong audio under a right-looking name.
fn render_key_of(ask: &ClipAsk, family: Option<Family>, text: &str) -> Result<Key, String> {
    let spoken = clips::text_digest(text);
    describes(&spoken, &ask.spoken_digest)?;
    Ok(Key {
        spoken_digest: spoken,
        ..key_of(ask, family)
    })
}

fn key_of(ask: &ClipAsk, family: Option<Family>) -> Key {
    Key {
        book: ask.book.clone(),
        section: ask.section,
        pack: ask.pack.clone(),
        voice: ask.voice.clone(),
        rate_milli: rate_milli(effective_rate(ask.rate, family)),
        text_digest: ask.text_digest.clone(),
        spoken_digest: ask.spoken_digest.clone(),
    }
}

/// Whether a pack may be read from, given what the installation check answered.
///
/// ⚠️ **AN I/O FAILURE USED TO READ AS "NOT INSTALLED" — FOUND BY AN INDEPENDENT
/// AUDIT, 2026-09-30.** `.unwrap_or(false)` turned a permission error or an
/// unreadable directory into the one sentence a reader can do nothing about: the
/// pack IS installed, the row in Settings says so, and the reading refuses it as
/// absent. That is the absent-versus-unreadable rule this repository has had to fix
/// in eighteen stores, landing in the place where it decides whether a book can be
/// read aloud at all.
///
/// A function of its own for the reason `describes` was one: the command it guards
/// needs a Tauri `State` and cannot be reached from a test.
fn readable(checked: crate::error::Result<bool>, pack: &str) -> Result<(), String> {
    match checked {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("{pack} is not installed")),
        Err(why) => Err(format!(
            "{pack} could not be checked, so it is not being read from: {why}"
        )),
    }
}

/// Whether a key's spoken digest is the digest of the text beside it.
///
/// ⚠️ **TAKEN ON TRUST UNTIL AN INDEPENDENT AUDIT FOUND IT, 2026-09-30.** The
/// digest IS the store's identity, and `voices_clip_render` receives both it and
/// the text it claims to describe — so a caller whose two arguments disagreed put
/// text B's samples and timings under text A's identity, and a later lookup for A
/// answered B. The reader would hear the wrong words with nothing failing.
///
/// One hash of a string already in hand, which makes the identity DERIVED rather
/// than asserted. A function of its own so it can be measured: the command it
/// guards needs a Tauri `State` and cannot be called from a test.
fn describes(spoken: &str, claimed: &str) -> Result<(), String> {
    if spoken == claimed {
        return Ok(());
    }
    Err(format!(
        "the section's own digest is {spoken} and the key says {claimed} — the key does not describe this text"
    ))
}

/// Which engine a pack id names, or `None` for one this build does not know.
///
/// The catalogue is embedded in the binary, so this is a lookup and not I/O. The
/// two clip commands ask it because the KEY depends on the answer — see `key_of`.
fn family_of(pack: &str) -> Option<Family> {
    let catalogue = catalogue();
    pack_of(&catalogue, pack).ok().map(|one| one.family)
}

/// The speed the render will actually be done at.
///
/// `None` for the family means *the pack is not one this build knows*, where the
/// render is going to be refused anyway — so the asked rate is carried through
/// unchanged rather than normalised into a key nothing will use.
fn effective_rate(asked: Option<f32>, family: Option<Family>) -> Option<f32> {
    match family {
        /* The bridge takes no speed, so the render is the model's own pace. */
        Some(Family::Qwen) => None,
        Some(Family::Kokoro) | None => asked,
    }
}

/// A speed as thousandths, bounded to what an engine will take.
///
/// ⚠️ **A NON-FINITE OR ABSENT RATE IS 1.0**, which is the engine's own default
/// and the value `voices_render` already substitutes — so the key says what the
/// render did rather than what the caller typed.
fn rate_milli(rate: Option<f32>) -> u32 {
    let asked = rate.unwrap_or(1.0);
    if !asked.is_finite() || asked <= 0.0 {
        return 1000;
    }
    (asked * 1000.0).round().clamp(1.0, 10_000.0) as u32
}

fn row_of(clip: Clip, evicted: Evicted) -> ClipRow {
    ClipRow {
        stem: clip.stem,
        path: clip.path.to_string_lossy().into_owned(),
        bytes: clip.bytes,
        sample_rate: clip.sample_rate,
        duration_ms: clip.duration_ms,
        words: clip
            .words
            .iter()
            .map(|w| WordRow {
                start: w.start,
                length: w.length,
                start_ms: w.start_ms,
                end_ms: w.end_ms,
            })
            .collect(),
        skipped: clip
            .skipped
            .iter()
            .map(|s| SkippedRow {
                text: s.text.clone(),
                why: s.why.clone(),
            })
            .collect(),
        evicted: evicted.into(),
    }
}

/// The rendered reading for this section, if it is already on disk.
///
/// A miss is `None` and not an error: it is the ordinary answer the first time a
/// section is read aloud. Finding one counts as playing it, which is what
/// least-recently-played eviction sorts on.
///
/// # Errors
/// When the store cannot be opened, or the book id is not a name Paper may
/// write.
#[tauri::command]
pub async fn voices_clip_find(
    state: State<'_, VoicesState>,
    ask: ClipAsk,
) -> Result<Option<ClipRow>, String> {
    let key = key_of(&ask, family_of(&ask.pack));
    state.with_clips(|store| {
        let found = store.find(&key).map_err(|e| e.to_string())?;
        Ok(found.map(|clip| row_of(clip, Evicted::default())))
    })
}

/// Render a section and keep it.
///
/// ⚠️ **THIS IS THE ONE LONG CALL IN THE READING, AND IT IS MINUTES.** WI-34.0
/// measured 315 s for a 48-minute section on an idle M4 Max. It is on a blocking
/// thread for the reason `voices_render` is, and the reader is shown the wait
/// rather than a spinner that says "loading" — see WI-34.5.
///
/// ⚠️ **A STOP DOES NOT REACH THE ENGINE, AND THE STORE IS WHY THAT IS SAFE.**
/// `SpeechEnginePort.render` has no `AbortSignal` and the plugin has no token to
/// give it, so a render the reader stopped runs to completion — into `staging/`,
/// promoted, and checkpointed. Nothing plays it, and pressing Listen again finds
/// it instantly. The bar WI-34.1 states is *no part-written artifact and no
/// checkpoint*, and that is what the staging-then-rename-then-checkpoint order
/// gives whether or not a stop arrives.
///
/// # Errors
/// When the pack is unknown or not installed, when the engine refuses, when
/// nothing could be said, or when the artifact cannot be written.
#[tauri::command]
pub async fn voices_clip_render(
    state: State<'_, VoicesState>,
    ask: ClipAsk,
    text: String,
) -> Result<ClipRow, String> {
    /* ⚠️ **THE KEY'S SPOKEN DIGEST IS CHECKED AGAINST THE TEXT, AND WAS TAKEN ON
     * TRUST — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** It is the digest OF
     * THIS ARGUMENT, so the check costs one hash of a string already in hand, and
     * without it a caller could file text B's audio and timings under text A's
     * identity: a later `find` for A would answer B, and the reader would hear
     * the wrong words with nothing failing anywhere.
     *
     * The digest is the store's identity, so this is the one place it can be made
     * DERIVED rather than asserted. `text_digest` is pinned against the same
     * vectors the TypeScript half is, which is what makes it the same function. */
    let key = render_key_of(&ask, family_of(&ask.pack), &text)?;
    let rendered =
        voices_render(&state, ask.pack.clone(), ask.voice.clone(), text, ask.rate).await?;
    let words: Vec<Word> = rendered
        .words
        .iter()
        .map(|w| Word {
            start: w.start,
            length: w.length,
            start_ms: w.start_ms,
            end_ms: w.end_ms,
        })
        .collect();
    let skipped: Vec<Skip> = rendered
        .skipped
        .iter()
        .map(|s| Skip {
            text: s.text.clone(),
            why: s.why.clone(),
        })
        .collect();
    state.with_clips(|store| {
        let (clip, evicted) = store
            .put(
                &key,
                &rendered.samples,
                rendered.sample_rate,
                words.clone(),
                skipped.clone(),
            )
            .map_err(|e| e.to_string())?;
        Ok(row_of(clip, evicted))
    })
}

/// A clip's samples, as raw bytes.
///
/// ⚠️ **A COMMAND OF THIS PLUGIN'S RATHER THAN THE fs PLUGIN, AND THAT IS A
/// BOUNDARY DECISION.** `no-direct-fs-plugin-outside-storage` in
/// `.dependency-cruiser.cjs` says a capability writes through kernel primitives
/// and never through `@tauri-apps/plugin-fs`, and it is right: the fs scope
/// grants the whole of `$APPDATA`, where this grants **one clip the store
/// already knows about**. A stem the checkpoint does not hold is refused, so the
/// webview can only read audio it could have asked to be rendered.
///
/// ⚠️ **AND IT ANSWERS `tauri::ipc::Response`, NOT A `Vec<u8>`.** A `Vec<u8>`
/// is serialised as a JSON array of decimal numbers — WI-34.0 measured a real
/// section at 139 924 800 bytes, which is the whole reason the samples stopped
/// crossing as a value. A `Response` is transferred as bytes.
///
/// # Errors
/// When the store cannot be opened, when the stem is not a name Paper wrote, or
/// when the file will not read.
#[tauri::command]
pub async fn voices_clip_read(
    state: State<'_, VoicesState>,
    stem: String,
) -> Result<tauri::ipc::Response, String> {
    let path = state.with_clips(|store| {
        store
            .path_of(&stem)
            .ok_or_else(|| format!("there is no rendered reading called {stem}"))
    })?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("{} could not be read: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Hold a clip open while something reads it, or let it go.
///
/// ⚠️ **THE AUDIOBOOK EXPORT IS THE CALLER — FOUND BY AN INDEPENDENT AUDIT,
/// 2026-09-30.** WI-34.4 hands `narrate_package` the PATH of a clip the reading
/// made rather than rendering the chapter again, and the packer reads that file
/// for as long as the muxing takes. Without a hold, a concurrent reading's render
/// could evict it under the packer, and *Forget them* could delete it: the export
/// would fail by name, which is loud but did not have to happen.
///
/// ⚠️ **ONE COMMAND FOR BOTH DIRECTIONS**, because a lease that can be taken and
/// not given back is a leak with a second command's name on it. The caller passes
/// what it wants, and a release for something it never held is not an error — an
/// export has more than one road out.
///
/// # Errors
/// When the store cannot be opened.
#[tauri::command]
pub async fn voices_clip_hold(
    state: State<'_, VoicesState>,
    stems: Vec<String>,
    hold: bool,
) -> Result<u32, String> {
    state.with_clips(|store| {
        let mut answered = 0u32;
        for stem in &stems {
            let moved = if hold {
                store.hold(stem)
            } else {
                store.release(stem)
            };
            if moved {
                answered += 1;
            }
        }
        Ok(answered)
    })
}

/// How much disk the rendered reading holds, and how much it may.
///
/// # Errors
/// When the store cannot be opened.
#[tauri::command]
pub async fn voices_clip_usage(state: State<'_, VoicesState>) -> Result<UsageRow, String> {
    state.with_clips(|store| {
        Ok(UsageRow {
            bytes: store.bytes(),
            budget: store.budget(),
            clips: u32::try_from(store.clips()).unwrap_or(u32::MAX),
        })
    })
}

/// Forget the rendered reading — all of it, or one book's.
///
/// # Errors
/// When the store cannot be opened or the checkpoint cannot be written.
#[tauri::command]
pub async fn voices_clip_forget(
    state: State<'_, VoicesState>,
    book: Option<String>,
) -> Result<EvictedRow, String> {
    state.with_clips(|store| {
        let gone = store.forget(book.as_deref()).map_err(|e| e.to_string())?;
        Ok(gone.into())
    })
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
