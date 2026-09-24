//! What the webview may ask of the passages plugin.
//!
//! ⚠️ **THE COMMAND INVENTORY IS IN THREE PLACES AND STAYS THERE**, exactly as
//! `tauri-plugin-peer`'s and `tauri-plugin-voices`' are, and for the same
//! reason: `tauri::generate_handler!` needs literal tokens at expansion time and
//! `build.rs` runs before the crate compiles, so neither list can be derived
//! from the other without a third artifact that would become a fourth place to
//! keep in step. [`tests::lists_agree`] is the mechanism instead.
//!
//! # The unit at the wire, decided once
//!
//! ⚠️ **OFFSETS CROSS AS UTF-16 CODE UNITS, NOT AS RUST BYTES** — the same
//! convention `tauri-plugin-voices`' `WordRow.start` already states: *"UTF-16
//! code units, which is what a web front end counts in"*. Everything inside this
//! crate counts bytes, because that is what slices a `&str`.
//!
//! The conversion is `Store::search`'s, not this file's, and that is deliberate:
//! it is the one place holding the string both units describe, and converting
//! anywhere else would mean walking the section a second time.
//! `tests::an_offset_is_what_the_front_end_counts` is the assertion, with emoji
//! and with CJK.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{Error, Result};
use crate::index::Section;
use crate::passage::parse_query;
use crate::store::{Limits, Store};

/// A section handed over for indexing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionIn {
    pub index: u32,
    pub text: String,
}

/// One passage, as the reader's side receives it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HitRow {
    pub book_id: String,
    pub section: u32,
    /// Where the quote starts in the section's canonical text, in UTF-16 code
    /// units — see the module header.
    pub offset: u32,
    /// The text itself, RAW. Never marked up: the front end takes this back to
    /// the book and looks for it character for character.
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    pub score: f32,
}

/// What `passages_status` answers.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusRow {
    /// How many books have postings.
    pub books: u32,
    /// How many sections, across all of them.
    pub sections: u64,
    /// Characters of canonical text held.
    pub chars: u64,
    /// Bytes of postings, and bytes of retained text.
    pub index_bytes: u64,
    pub text_bytes: u64,
    /// Which analysis built the postings.
    pub analysis: String,
    /// Books that could not be read, with the reason, worst news first.
    pub unreadable: Vec<UnreadableRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnreadableRow {
    pub book_id: String,
    pub why: String,
    pub at: u64,
}

/// What the plugin holds between calls.
#[derive(Default)]
pub struct PassagesState {
    /// `None` until `setup` has said where the data root is, and until the first
    /// call that needs it — opening a tantivy index costs a directory scan, and
    /// a reader who never searches should not pay for one at launch.
    store: Mutex<Option<Store>>,
    root: Mutex<Option<std::path::PathBuf>>,
}

impl std::fmt::Debug for PassagesState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PassagesState").finish_non_exhaustive()
    }
}

impl PassagesState {
    /// Say where the index lives. Called once, from the plugin's `setup`.
    ///
    /// ⚠️ **THE APP'S DATA ROOT, NOT A `passages/` UNDER IT.** `Layout::under`
    /// joins its own segment — the trap the voices plugin sprang, where every
    /// pack installed one directory deeper than the app looked and nothing
    /// failed because a doubled directory works perfectly.
    pub fn set_root(&self, root: std::path::PathBuf) {
        if let Ok(mut held) = self.root.lock() {
            *held = Some(root);
        }
    }

    /// Run `work` against the open store, opening it if this is the first call.
    ///
    /// # Errors
    /// [`Error::NoRoot`] before `setup`; whatever opening or `work` returns.
    fn with<T>(&self, work: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        let mut held = self
            .store
            .lock()
            .map_err(|_| Error::Index("the passage index is poisoned".to_owned()))?;
        if held.is_none() {
            let root = self
                .root
                .lock()
                .map_err(|_| Error::NoRoot)?
                .clone()
                .ok_or(Error::NoRoot)?;
            *held = Some(Store::open(&root)?);
        }
        let store = held.as_mut().ok_or(Error::NoRoot)?;
        work(store)
    }
}

/// How many sections a query may consider, and how much it may answer with.
///
/// Bounded here rather than taken from the caller alone: the caller is a webview
/// and a book is somebody else's file, so an unbounded query is a main thread
/// held for as long as the index is large.
const MAX_SECTIONS: usize = 400;
const MAX_TOTAL: usize = 200;
const MAX_PER_SECTION: usize = 5;

/// Index one book's sections, replacing whatever was there.
///
/// Answers `false` when the book was forgotten while it was being extracted —
/// see `store.rs`'s note about a removal losing a race.
#[tauri::command]
pub async fn passages_put<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
    book: String,
    generation: String,
    sections: Vec<SectionIn>,
    at: u64,
) -> Result<bool> {
    let sections = sections
        .into_iter()
        .map(|one| Section {
            index: one.index,
            text: one.text,
        })
        .collect();
    state.with(|store| store.put(&book, &generation, sections, at))
}

/// Record a book that yielded no text, with the reason a reader can read.
#[tauri::command]
pub async fn passages_note<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
    book: String,
    why: String,
    at: u64,
) -> Result<()> {
    state.with(|store| store.note(&book, &why, at))
}

/// Commit everything pending and write the checkpoint.
#[tauri::command]
pub async fn passages_flush<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
) -> Result<()> {
    state.with(Store::flush)
}

/// Take a book out of the index.
#[tauri::command]
pub async fn passages_forget<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
    book: String,
    at: u64,
) -> Result<()> {
    state.with(|store| store.forget(&book, at))
}

/// Move a book's index to a new id, keeping the work.
#[tauri::command]
pub async fn passages_rekey<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
    from: String,
    to: String,
) -> Result<bool> {
    state.with(|store| store.rekey(&from, &to))
}

/// Which of these books need indexing at these generations.
///
/// ⚠️ **ASKED IN ONE CALL RATHER THAN ONE PER BOOK.** A backfill over 1 959
/// books that asked per book would be 1 959 round trips through the IPC before
/// it read a single file.
#[tauri::command]
pub async fn passages_pending<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
    books: Vec<(String, String)>,
) -> Result<Vec<String>> {
    state.with(|store| {
        Ok(books
            .into_iter()
            .filter(|(id, generation)| !store.current(id, generation))
            .map(|(id, _)| id)
            .collect())
    })
}

/// Every book the index holds, by id.
///
/// ⚠️ **ITS OWN COMMAND RATHER THAN A FIELD ON `passages_status`.** The status
/// is what a Settings pane reads, and putting a 1 959-entry list in it would
/// send the whole shelf across the IPC every time a panel is drawn. This is the
/// removal diff's question and only the backfill asks it.
///
/// ⚠️ **AND THE STATE IS THE ANSWER, NOT THE POSTINGS.** They agree — the state
/// is written only after the commit that made a book searchable — and asking
/// the state costs a map walk where asking the postings costs a scan of every
/// stored document in every segment.
#[tauri::command]
pub async fn passages_indexed<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
) -> Result<Vec<String>> {
    state.with(|store| Ok(store.state().books.keys().cloned().collect()))
}

/// Build the postings again from the retained text.
#[tauri::command]
pub async fn passages_rebuild<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
) -> Result<()> {
    state.with(Store::rebuild)
}

/// Forget every note, so the next sweep tries those books again.
///
/// Answers how many were cleared, so the caller can say so rather than leaving
/// a button that reports nothing.
#[tauri::command]
pub async fn passages_retry<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
) -> Result<u32> {
    state.with(|store| Ok(u32::try_from(store.retry_unreadable()?).unwrap_or(u32::MAX)))
}

/// What is indexed, what it costs, and what could not be read.
#[tauri::command]
pub async fn passages_status<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
) -> Result<StatusRow> {
    state.with(|store| {
        let held = store.state();
        let (index_bytes, text_bytes) = store.bytes();
        let mut unreadable: Vec<UnreadableRow> = held
            .notes
            .iter()
            .map(|(book_id, note)| UnreadableRow {
                book_id: book_id.clone(),
                why: note.why.clone(),
                at: note.at,
            })
            .collect();
        /* NEWEST FIRST, so a reader looking at the list sees what just failed
         * rather than what failed a month ago. */
        unreadable.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.book_id.cmp(&b.book_id)));
        Ok(StatusRow {
            books: u32::try_from(held.books.len()).unwrap_or(u32::MAX),
            sections: store.sections(),
            chars: held.books.values().map(|one| one.chars).sum(),
            index_bytes,
            text_bytes,
            analysis: held.analysis.clone(),
            unreadable,
        })
    })
}

/// Answer a query with passages.
#[tauri::command]
pub async fn passages_search<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, PassagesState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<HitRow>> {
    let clauses = parse_query(&query)?;
    let total = limit
        .map_or(MAX_TOTAL, |n| (n as usize).min(MAX_TOTAL))
        .max(1);
    let limits = Limits {
        sections: MAX_SECTIONS,
        per_section: MAX_PER_SECTION,
        total,
    };
    let hits = state.with(|store| store.search(&clauses, limits))?;
    Ok(hits.into_iter().map(row_of).collect())
}

/// One hit, on the wire.
///
/// A rename and nothing else: the offset was converted in `Store::search`,
/// which is the only place that holds the string both units describe.
fn row_of(hit: crate::store::Hit) -> HitRow {
    HitRow {
        offset: hit.offset,
        book_id: hit.book_id,
        section: hit.section,
        quote: hit.quote,
        prefix: hit.prefix,
        suffix: hit.suffix,
        score: hit.score,
    }
}

#[cfg(test)]
mod tests;
