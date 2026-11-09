//! What the webview may call.
//!
//! ⚠️ **EVERY PATH THE WEBVIEW NAMES IS REBUILT HERE, NEVER OPENED AS GIVEN.**
//! The threat model in `dev-docs/decisions/2026-11-09-narration-boundary.md` is
//! script in the main window, able to call every command granted to it with any
//! arguments it likes. So:
//!
//! - the destination is never a path the window sends. The window asks for the
//!   save dialog, and is handed a token for whatever the reader chose — see
//!   `crate::destination`;
//! - a chapter is either an index into a run directory this plugin made, or a
//!   clip whose path is rebuilt from the voices plugin's store and its bare name
//!   — see `crate::inputs::Roots::clip`;
//! - every count and length the window controls has a named bound — see
//!   `crate::limits`.
//!
//! The old app command `narrate_package` took a source and a destination path
//! from the window and trusted a comment to keep them honest. It is gone from
//! the app; this plugin's `narrate_package` keeps the name and none of the trust.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::destination::Destinations;
use crate::inputs::{read_chapter, Roots};
use crate::limits;
use crate::narrate::{apple, m4b, offload, Packaged, SUPPORTED, UNSUPPORTED};
use crate::scratch::{Begun, Runs};

/// Everything the commands share: the roots, the live runs and the picked
/// destinations.
#[derive(Debug)]
pub struct Ready {
    pub roots: Roots,
    pub runs: Runs,
    pub destinations: Destinations,
}

impl Ready {
    /// Resolve the roots under `data_dir` and start with nothing live.
    pub fn open(data_dir: &std::path::Path) -> Result<Self, String> {
        let roots = Roots::open(data_dir)?;
        let runs = Runs::new(roots.scratch().to_path_buf());
        Ok(Self {
            roots,
            runs,
            destinations: Destinations::default(),
        })
    }

    /// Package a book from a live run into a picked destination, synchronously.
    ///
    /// ⚠️ **EVERYTHING THE WINDOW SENT IS CHECKED BEFORE THE TOKEN IS CLAIMED.**
    /// A refused request leaves the token as it was, so the reader can still
    /// cancel it; once claimed, a failure — a panic included — abandons it, so a
    /// token is packaged at most once.
    pub fn package(&self, request: &Request) -> Result<Packaged, String> {
        if request.chapters.is_empty() {
            return Err("there are no chapters to package".to_owned());
        }
        limits::chapters(request.chapters.len())?;
        limits::text("title", &request.title)?;
        limits::text("author", &request.author)?;
        for chapter in &request.chapters {
            limits::text("chapter title", &chapter.title)?;
        }
        let dir = self.runs.dir(&request.run)?;
        let paths = request
            .chapters
            .iter()
            .map(|chapter| match &chapter.source {
                Source::Scratch { index } => Ok(Runs::chapter(&dir, *index)),
                Source::Clip { path } => self.roots.clip(path),
            })
            .collect::<Result<Vec<PathBuf>, String>>()?;
        let titles: Vec<String> = request
            .chapters
            .iter()
            .map(|chapter| chapter.title.clone())
            .collect();

        /* Last of the checks, so every refusal above is tested on every
         * platform; and before the claim, so an unsupported one spends nothing. */
        if !SUPPORTED {
            return Err(UNSUPPORTED.to_owned());
        }
        /* THE GATE BEFORE THE CLAIM, so an export refused as busy leaves its
         * token picked — see `apple::Admission`. */
        let admission = apple::Admission::take("package")?;
        let target = self.destinations.claim(&request.destination)?;
        let claimed = Claimed {
            destinations: &self.destinations,
            token: &request.destination,
            done: false,
        };
        let book = apple::package(
            &admission,
            &titles,
            |index| read_chapter(&paths[index]).map_err(|error| error.for_chapter(index + 1)),
            m4b::BookMeta {
                title: request.title.clone(),
                author: request.author.clone(),
            },
            &dir,
            &target,
        )?;
        let (duration_ms, chapters) = (book.duration_ms, book.chapters);
        /* `commit` settles the token whichever way it goes: Committed on
         * success, removed when it was released meanwhile. */
        let committed = self.destinations.commit(&request.destination, book.staged);
        claimed.settle();
        committed?;
        Ok(Packaged {
            name: Destinations::name_of(&target),
            duration_ms,
            chapters,
        })
    }
}

/// A claimed token that is abandoned unless it is settled — so a failure or a
/// panic between the claim and the commit cannot leave it claimable again, or
/// stuck as "being written" forever.
struct Claimed<'a> {
    destinations: &'a Destinations,
    token: &'a str,
    done: bool,
}

impl Claimed<'_> {
    fn settle(mut self) {
        self.done = true;
    }
}

impl Drop for Claimed<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.destinations.abandon(self.token);
        }
    }
}

/// What the app holds for the commands.
///
/// ⚠️ **OPENED BY THE FIRST COMMAND, NOT IN `setup`.** Opening makes and
/// resolves directories, and Rust setup runs before any webview exists, so
/// work there could not be stopped by anything the window decides —
/// `optionalFeatures.contract.test.ts` holds every crate to that. A failure to
/// open is kept, and is the answer to every command, rather than ending the
/// app: the reader can still read without exporting.
#[derive(Debug, Clone)]
pub struct NarrationState(Arc<Lazy>);

#[derive(Debug)]
struct Lazy {
    data_dir: PathBuf,
    ready: OnceLock<Result<Ready, String>>,
}

impl NarrationState {
    /// Remember the app's data root; nothing is opened until a command asks.
    pub fn new(data_dir: PathBuf) -> Self {
        Self(Arc::new(Lazy {
            data_dir,
            ready: OnceLock::new(),
        }))
    }

    fn ready(&self) -> Result<&Ready, String> {
        self.0
            .ready
            .get_or_init(|| {
                let ready = Ready::open(&self.0.data_dir);
                if let Err(error) = &ready {
                    log::error!("narration: cannot start: {error}");
                }
                ready
            })
            .as_ref()
            .map_err(Clone::clone)
    }
}

/// Where a chapter's audio is.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Source {
    /// Rendered for this export, into its run directory.
    Scratch { index: u32 },
    /// Already rendered when the reader listened, in the voices plugin's store.
    Clip { path: String },
}

/// One chapter of the book.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterIn {
    pub title: String,
    pub source: Source,
}

/// A package request, as the window sends it.
#[derive(Debug, Clone)]
pub struct Request {
    pub run: String,
    pub destination: String,
    pub chapters: Vec<ChapterIn>,
    pub title: String,
    pub author: String,
}

/// What a pick answers: the token, and the name the reader chose.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub token: String,
    pub name: String,
}

/// The longest suggested file name, in bytes — the most any common file system
/// keeps in one name.
const MAX_NAME_BYTES: usize = 255;

/// Refuse a suggested name that is not a bare file name.
pub fn suggested_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("the suggested file name is empty".to_owned());
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(format!(
            "the suggested file name is {} bytes long, and at most {MAX_NAME_BYTES} are kept",
            name.len()
        ));
    }
    if name.contains(['/', '\\', '\0']) {
        return Err("the suggested file name is not a bare name".to_owned());
    }
    Ok(())
}

/// Whether this platform can package a book.
#[tauri::command]
pub async fn narration_supported() -> Result<bool, String> {
    Ok(SUPPORTED)
}

/// Ask the reader where to save the audiobook. `None` when they cancel.
#[tauri::command]
pub async fn narration_pick<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NarrationState>,
    name: String,
) -> Result<Option<Picked>, String> {
    let ready = state.ready()?;
    suggested_name(&name)?;
    ready.destinations.room()?;
    /* ⚠️ **NEVER ON THE MAIN THREAD.** A blocking dialog waits for the event
     * loop the main thread runs, so blocking there would wait forever. */
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Export as audiobook")
            .set_file_name(name)
            .add_filter("Audiobook", &["m4b"])
            .blocking_save_file()
    })
    .await
    .map_err(|error| format!("the save dialog did not finish: {error}"))?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let target = chosen
        .into_path()
        .map_err(|error| format!("the chosen destination is not a file path: {error}"))?;
    if !target.is_absolute() {
        return Err("the chosen destination is not an absolute path".to_owned());
    }
    let name = Destinations::name_of(&target);
    let token = ready.destinations.insert(target)?;
    Ok(Some(Picked { token, name }))
}

/// Start an export: a fresh scratch directory for its chapters.
#[tauri::command]
pub async fn narration_begin(state: State<'_, NarrationState>) -> Result<Begun, String> {
    state.ready()?.runs.begin()
}

/// Remove one chapter's scratch audio.
#[tauri::command]
pub async fn narration_discard_chapter(
    state: State<'_, NarrationState>,
    run: String,
    index: u32,
) -> Result<(), String> {
    state.ready()?.runs.discard_chapter(&run, index)
}

/// Remove an export's scratch directory, and end the run.
#[tauri::command]
pub async fn narration_discard(
    state: State<'_, NarrationState>,
    run: String,
) -> Result<(), String> {
    state.ready()?.runs.discard(&run)
}

/// Join, encode and mux a run's chapters into the picked destination.
#[tauri::command]
pub async fn narrate_package(
    state: State<'_, NarrationState>,
    run: String,
    destination: String,
    chapters: Vec<ChapterIn>,
    title: String,
    author: String,
) -> Result<Packaged, String> {
    let shared = state.inner().clone();
    let request = Request {
        run,
        destination,
        chapters,
        title,
        author,
    };
    offload("package", move || shared.ready()?.package(&request)).await
}

/// Whether anything is at a picked destination now.
#[tauri::command]
pub async fn narration_exists(
    state: State<'_, NarrationState>,
    destination: String,
) -> Result<bool, String> {
    state.ready()?.destinations.exists(&destination)
}

/// Remove the book an export wrote — see `Destinations::discard_book`.
#[tauri::command]
pub async fn narration_discard_book(
    state: State<'_, NarrationState>,
    destination: String,
) -> Result<(), String> {
    state.ready()?.destinations.discard_book(&destination)
}

/// The window is done with a destination.
#[tauri::command]
pub async fn narration_release(
    state: State<'_, NarrationState>,
    destination: String,
) -> Result<(), String> {
    state.ready()?.destinations.release(&destination)
}

#[cfg(test)]
mod tests;
