//! The three stores as one thing, with the ordering that survives a crash.
//!
//! # The order, and why it is this order
//!
//! For one book:
//!
//! 1. write `text/<book>.jsonl` — atomically, so the old generation or the new
//!    one is on disk and never half of either;
//! 2. `delete_term(book)` then insert its sections into the writer;
//! 3. when the batch is full, `commit()` — which is where durability and
//!    visibility both happen;
//! 4. **only then** write `state.json`.
//!
//! A crash between 3 and 4 re-indexes the books of that batch on the next
//! launch, and step 2's delete makes that a replacement rather than a
//! duplication. A crash anywhere before 3 loses the batch's postings and keeps
//! its text, which the next launch notices because `state.json` does not name
//! those books.
//!
//! ⚠️ **THE OPPOSITE ORDER LOSES A BOOK FOR EVER**, which is the whole reason
//! this is written down: checkpoint first, and a crash before the commit leaves
//! `state.json` claiming a book is searchable that the index has never heard of.
//! Nothing would ever look at it again.
//!
//! # A removal that loses a race
//!
//! ⚠️ **AN EXTRACTOR THAT READ A BOOK'S BYTES AND THEN LOST TO AN EVICTION MUST
//! NOT COMMIT ITS TEXT AFTERWARDS AND RESURRECT THE BOOK IN SEARCH.** A serial
//! index writer does not serialise VAULT changes: the front end can spend a
//! second extracting a book that is removed while it works. [`Store::put`]
//! therefore takes the moment the extraction BEGAN and refuses anything older
//! than the removal, telling the caller so rather than reporting success.
//!
//! ⚠️ **AND IT IS A MOMENT, NOT A SET — WHICH IS WHAT MAKES A RESTORE WORK.**
//! The first version of this kept a `BTreeSet` of forgotten ids for the life of
//! the process, so a book that was trashed and then RESTORED could never be
//! indexed again until the app was relaunched: every later extraction was
//! refused by an id that had been removed an hour earlier. `trash → restore` is
//! a transition WI-31.3 names, and the set got it silently wrong — the book
//! simply stayed unsearchable, which looks exactly like a book with no matches.
//! Recording WHEN tells the two apart: an extraction that began before the
//! removal is the race, and one that began after it is a restore.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use crate::error::Result;
use crate::index::{self, Postings, Section};
use crate::passage::Clause;
use crate::paths::Layout;
use crate::state::{self, Indexed, Note, State};
use crate::text::{self, BookText};
use crate::tokenize;

/// How many books are indexed between commits.
///
/// ⚠️ **A COMMIT IS NOT FREE AND ONE PER BOOK IS NOT AFFORDABLE.** Tantivy's
/// `commit()` persists and fsyncs; at 1 959 books that is 1 959 of them, which
/// the phase's *"under 60 min for full coverage"* bar does not have room for.
/// Batching trades a little re-work after a crash — at most this many books —
/// for an order of magnitude on the build. The re-work is bounded and idempotent;
/// the build time is not.
pub const BATCH: usize = 24;

/// A section that matched, with the passage inside it and its context.
#[derive(Debug, Clone)]
pub struct Hit {
    pub book_id: String,
    pub section: u32,
    /// Where the quote starts in the section's canonical text, in **UTF-16 code
    /// units** — the unit a JavaScript string is sliced by, and the unit
    /// `tauri-plugin-voices`' `WordRow.start` already uses for the same reason.
    ///
    /// ⚠️ **CONVERTED HERE, WHERE THE STRING IS, AND NOWHERE ELSE.** Everything
    /// inside this crate counts BYTES, because that is what slices a `&str`.
    /// The two differ for every astral character — `"😀"` is four bytes, one
    /// Rust `char` and two UTF-16 units — so a conversion done anywhere that
    /// does not hold the text would have to walk it again, and two walks of one
    /// string is two chances to disagree. `commands.rs` passes this through
    /// untouched.
    pub offset: u32,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    pub score: f32,
}

/// How many UTF-16 code units `text` is.
///
/// `encode_utf16().count()` allocates an iterator per call and is the obvious
/// spelling; summing `len_utf16` is the same answer without one, which matters
/// because this runs over a section prefix per hit.
#[must_use]
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// What a search is allowed to cost.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// How many sections to consider.
    pub sections: usize,
    /// How many passages to report from one section.
    pub per_section: usize,
    /// How many hits to report in total.
    pub total: usize,
}

/// Everything this plugin holds.
///
/// ⚠️ **`Debug` IS DERIVED BY HAND BELOW RATHER THAN ON THE STRUCT**, because
/// tantivy's writer and reader are not `Debug` — and a store that cannot be
/// printed cannot be `expect_err`'d, which makes every refusal in this file
/// untestable. The summary is what a diagnostics line would want anyway.
pub struct Store {
    layout: Layout,
    postings: Postings,
    state: State,
    /// Books indexed into the writer but not yet committed. Empty after every
    /// commit; the checkpoint is written from it.
    pending: Vec<(String, Indexed)>,
    /// When each book was forgotten, by the caller's clock — see the module
    /// header. Not persisted, deliberately: after a restart nothing is in
    /// flight, and a durable list of removed books would be a second record of
    /// what the shelf holds.
    forgotten: BTreeMap<String, u64>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("base", &self.layout.base)
            .field("books", &self.state.books.len())
            .field("notes", &self.state.notes.len())
            .field("pending", &self.pending.len())
            .finish()
    }
}

impl Store {
    /// Open everything under `root`, which is the APP's data root.
    ///
    /// # Errors
    /// [`Error::Damaged`] when `state.json` is there and will not read;
    /// [`Error::Index`] when the postings will not open.
    pub fn open(root: &Path) -> Result<Self> {
        let layout = Layout::under(root);
        layout.ensure()?;
        let postings = Postings::open(&layout.index_dir)?;
        let state = state::read(&layout.state_path)?;
        let mut store = Self {
            layout,
            postings,
            state,
            pending: Vec::new(),
            forgotten: BTreeMap::new(),
        };
        /* ⚠️ **AN ANALYSIS CHANGE IS A REBUILD, NOT A RE-EXTRACTION**, and this
         * is the moment that decision is taken. The text on disk is unaffected
         * by what a tokenizer does with it, so every EPUB stays shut. */
        if store.state.analysis != tokenize::ANALYSIS {
            store.rebuild()?;
        }
        Ok(store)
    }

    /// The layout, for the status report.
    #[must_use]
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// What is indexed right now.
    #[must_use]
    pub fn state(&self) -> &State {
        &self.state
    }

    /// When this book was last forgotten, by the caller's clock.
    #[must_use]
    pub fn forgotten_at(&self, book_id: &str) -> Option<u64> {
        self.forgotten.get(book_id).copied()
    }

    /// Whether this book's index is current for these bytes — what a backfill
    /// asks before it spends a second extracting one.
    #[must_use]
    pub fn current(&self, book_id: &str, generation: &str) -> bool {
        self.state.current(book_id, generation)
    }

    /// Index one book's sections, replacing whatever was there.
    ///
    /// ⚠️ **THE TEXT IS WRITTEN BEFORE THE POSTINGS**, so a crash between them
    /// leaves text that `state.json` does not vouch for — which the next launch
    /// re-indexes. The other order would leave postings with no text to rebuild
    /// them from.
    ///
    /// `at` is when the EXTRACTION BEGAN, not when it finished — see the
    /// module header, where that distinction is the whole of how a removal race
    /// is told from a restore.
    ///
    /// Answers `false` — rather than failing — when the book was forgotten
    /// while it was being extracted.
    ///
    /// # Errors
    /// [`Error::BadPath`] for an id that cannot be filed; [`Error::Index`] from
    /// the writer; the underlying I/O failure from the text write.
    pub fn put(
        &mut self,
        book_id: &str,
        generation: &str,
        sections: Vec<Section>,
        at: u64,
    ) -> Result<bool> {
        /* THE RACE, REFUSED — and ONLY the race. `at` is when the extraction
         * BEGAN, so an extraction older than the removal is one that read bytes
         * the shelf no longer has, and committing it would put a removed book
         * back into search where nothing would take it out again. An extraction
         * that began AFTER the removal is a restore, and must be allowed.
         *
         * A tie accepts. Two events in one millisecond is vanishingly unlikely,
         * and accepting is the self-healing direction: the next sweep's diff
         * takes out a book the shelf does not want, while refusing would leave a
         * restored book unsearchable with nothing saying why. */
        if self
            .forgotten
            .get(book_id)
            .is_some_and(|removed| at < *removed)
        {
            return Ok(false);
        }
        let path = self.layout.text_path(book_id)?;
        let book = BookText {
            book_id: book_id.to_owned(),
            generation: generation.to_owned(),
            sections,
        };
        text::write(&path, &book)?;
        self.postings.replace(book_id, &book.sections)?;
        self.pending.push((
            book_id.to_owned(),
            Indexed {
                generation: generation.to_owned(),
                sections: u32::try_from(book.sections.len()).unwrap_or(u32::MAX),
                chars: book.chars(),
                at,
            },
        ));
        if self.pending.len() >= BATCH {
            self.flush()?;
        }
        Ok(true)
    }

    /// Record a book that yielded nothing, so a search can say so.
    ///
    /// ⚠️ **RECORDED, NEVER SKIPPED.** A book silently absent from the index is
    /// indistinguishable from a book with no matches, and at 1 959 books that is
    /// the difference between a search that covers the shelf and one that omits
    /// a fifth of it without saying.
    ///
    /// # Errors
    /// The underlying I/O failure from the checkpoint write.
    pub fn note(&mut self, book_id: &str, why: &str, at: u64) -> Result<()> {
        self.flush()?;
        self.state.noted(
            book_id,
            Note {
                why: why.to_owned(),
                at,
            },
        );
        state::write(&self.layout.state_path, &self.state)
    }

    /// Forget every note, so the next sweep tries those books again.
    ///
    /// ⚠️ **THE REMEDY FOR A BOOK RECORDED UNREADABLE IN ERROR, AND WITHOUT IT
    /// THERE IS NONE.** A note is what stops a book that yields nothing being
    /// re-parsed on every sweep for ever — but the same record also catches a
    /// TRANSIENT failure, a disk that was momentarily busy, and nothing
    /// distinguishes the two from a thrown value. Recorded, that book is never
    /// looked at again until its bytes change, which for a book nobody is
    /// editing is never.
    ///
    /// `rebuild` deliberately KEEPS the notes — re-deriving postings says
    /// nothing about which books could not be EXTRACTED — so this is a separate
    /// act with a separate control, and the pane offers it beside the list of
    /// books it is about.
    ///
    /// # Errors
    /// The underlying I/O failure from the checkpoint write.
    pub fn retry_unreadable(&mut self) -> Result<usize> {
        let cleared = self.state.notes.len();
        if cleared == 0 {
            return Ok(0);
        }
        self.state.notes.clear();
        state::write(&self.layout.state_path, &self.state)?;
        Ok(cleared)
    }

    /// Commit whatever is pending and write the checkpoint.
    ///
    /// # Errors
    /// [`Error::Index`] from the commit, or the I/O failure from the write.
    pub fn flush(&mut self) -> Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        /* THE COMMIT FIRST. Everything below this line is bookkeeping about
         * work that has already happened; everything above it is work that has
         * not. A failure here leaves `state.json` naming none of it, which the
         * next launch reads as "re-index these" — the safe direction. */
        self.postings.commit()?;
        for (book_id, one) in std::mem::take(&mut self.pending) {
            self.state.indexed(&book_id, one);
        }
        state::write(&self.layout.state_path, &self.state)
    }

    /// Take a book out of the index and off the disk.
    ///
    /// # Errors
    /// [`Error::Index`] from the writer, or the I/O failure from the removal.
    pub fn forget(&mut self, book_id: &str, at: u64) -> Result<()> {
        /* WHEN, so an extraction already in flight cannot put it back and a
         * later one can — see the module header. */
        self.forgotten.insert(book_id.to_owned(), at);
        /* PENDING WORK FOR THIS BOOK IS DROPPED, not committed and then
         * deleted. Left in, it would be checkpointed as indexed by the flush
         * below and the state would claim a removed book is searchable. */
        self.pending.retain(|(id, _)| id != book_id);
        self.postings.forget(book_id)?;
        self.postings.commit()?;
        text::remove(&self.layout.text_path(book_id)?)?;
        self.state.forget(book_id);
        state::write(&self.layout.state_path, &self.state)
    }

    /// Move a book's index to a new id, keeping the work.
    ///
    /// # Errors
    /// [`Error::Damaged`] when the text is there and will not read;
    /// [`Error::Index`] from the writer; the underlying I/O failure.
    pub fn rekey(&mut self, from: &str, to: &str) -> Result<bool> {
        self.flush()?;
        let old = self.layout.text_path(from)?;
        let Some(held) = text::read(&old, from)? else {
            return Ok(false);
        };
        let moved = BookText {
            book_id: to.to_owned(),
            generation: held.generation,
            sections: held.sections,
        };
        text::write(&self.layout.text_path(to)?, &moved)?;
        text::remove(&old)?;
        /* THE POSTINGS ARE RE-WRITTEN, because the book id is a stored FIELD
         * and a field cannot be renamed in place. The TEXT is moved rather than
         * re-extracted, which is the part worth keeping: it is the same bytes
         * under a new name. */
        self.postings.forget(from)?;
        self.postings.replace(to, &moved.sections)?;
        self.postings.commit()?;
        /* THE NEW ID IS NOT A REMOVED BOOK. A rekey into an id that had been
         * forgotten earlier would otherwise be refused by that id's own
         * timestamp on the next extraction. */
        self.forgotten.remove(to);
        self.state.rekey(from, to);
        state::write(&self.layout.state_path, &self.state)?;
        Ok(true)
    }

    /// Throw the postings away and build them again FROM `text/`.
    ///
    /// ⚠️ **NO BOOK IS OPENED.** This is what retaining the text buys, and it is
    /// the migration path for every future change to [`tokenize`]. The test
    /// `a_rebuild_reads_no_book` is the assertion that it stays true.
    ///
    /// # Errors
    /// [`Error::Index`] from the writer, or the I/O failure from the reads. A
    /// single damaged book file is NOTED and the rebuild continues — one bad
    /// file must not cost a library.
    pub fn rebuild(&mut self) -> Result<()> {
        self.pending.clear();
        self.postings.clear()?;
        let mut rebuilt = State {
            format: state::FORMAT,
            analysis: tokenize::ANALYSIS.to_owned(),
            books: std::collections::BTreeMap::new(),
            /* THE NOTES SURVIVE A REBUILD. They are facts about books that could
             * not be EXTRACTED, and re-deriving the postings says nothing about
             * that — dropping them would quietly turn "these 40 books could not
             * be read" into "the shelf is fully covered". */
            notes: self.state.notes.clone(),
        };
        let mut since_commit = 0usize;
        for path in text::files_in(&self.layout.text_dir)? {
            let held = match text::read_any(&path) {
                Ok(Some(held)) => held,
                Ok(None) => continue,
                Err(cause) => {
                    /* ⚠️ **ONE DAMAGED FILE MUST NOT COST A LIBRARY**, and it
                     * must not be silent either. The book is noted, so the
                     * reader is told which books are missing and why, and the
                     * next backfill re-extracts it. */
                    if let Some(book_id) = book_id_of(&path) {
                        rebuilt.noted(
                            &book_id,
                            Note {
                                why: format!("its saved text could not be read: {cause}"),
                                at: 0,
                            },
                        );
                    }
                    continue;
                }
            };
            self.postings.replace(&held.book_id, &held.sections)?;
            rebuilt.indexed(
                &held.book_id,
                Indexed {
                    generation: held.generation.clone(),
                    sections: u32::try_from(held.sections.len()).unwrap_or(u32::MAX),
                    chars: held.chars(),
                    at: 0,
                },
            );
            since_commit += 1;
            if since_commit >= BATCH {
                self.postings.commit()?;
                since_commit = 0;
            }
        }
        self.postings.commit()?;
        self.state = rebuilt;
        state::write(&self.layout.state_path, &self.state)
    }

    /// Answer a query with passages.
    ///
    /// Hits are grouped by book, best book first, and the sections inside each
    /// keep the index's own order — see the note inside about why that grouping
    /// is a memory decision rather than a presentational one.
    ///
    /// # Errors
    /// [`Error::Index`] when the search fails. A book whose text will not read
    /// is SKIPPED with its sections unreported rather than failing the whole
    /// query — one damaged book must not make the library unsearchable — and the
    /// damage is already in `state.json` for the reader to be told about.
    pub fn search(&self, clauses: &[Clause], limits: Limits) -> Result<Vec<Hit>> {
        let matched = self.postings.search(clauses, limits.sections)?;

        /* ⚠️ **GROUPED BY BOOK BEFORE ANY TEXT IS READ, AND THAT IS ABOUT
         * MEMORY RATHER THAN TIDINESS.** `matched` is in score order across the
         * whole shelf, so two sections of one book commonly sit either side of a
         * section of another. Walking it directly and caching what has been read
         * — which is what this did — holds every matching book's full text for
         * the length of the query: at `MAX_SECTIONS` of 400 that is up to four
         * hundred books at roughly a megabyte each, several hundred megabytes,
         * for one keystroke in a search field.
         *
         * Grouping first means exactly ONE book's text is alive at a time. The
         * order survives: the group list is built in first-appearance order,
         * which is best-score order, and the sections inside a group keep their
         * relative order for the same reason. */
        let mut order: Vec<String> = Vec::new();
        let mut grouped: HashMap<String, Vec<crate::index::Match>> = HashMap::new();
        for one in matched {
            grouped
                .entry(one.book_id.clone())
                .or_insert_with(|| {
                    order.push(one.book_id.clone());
                    Vec::new()
                })
                .push(one);
        }

        let mut out: Vec<Hit> = Vec::new();
        for book_id in order {
            if out.len() >= limits.total {
                break;
            }
            /* ⚠️ **AN UNFILEABLE ID SKIPS THIS BOOK RATHER THAN FAILING THE
             * QUERY.** Every id in the index came through `put`, which validated
             * it with this same helper — so this cannot happen today, and if it
             * ever does, one unreadable name must not make the whole library
             * unsearchable. */
            let Ok(path) = self.layout.text_path(&book_id) else {
                continue;
            };
            /* A book whose text will not read is SKIPPED, and the damage is
             * already in `state.json` for the reader to be told about. */
            let Some(text) = text::read(&path, &book_id).unwrap_or(None) else {
                continue;
            };
            let Some(sections) = grouped.get(&book_id) else {
                continue;
            };
            for one in sections {
                if out.len() >= limits.total {
                    break;
                }
                let Some(section) = text.sections.iter().find(|s| s.index == one.section) else {
                    continue;
                };
                for found in crate::passage::passages(&section.text, clauses, limits.per_section) {
                    if out.len() >= limits.total {
                        break;
                    }
                    out.push(Hit {
                        book_id: book_id.clone(),
                        section: one.section,
                        offset: u32::try_from(utf16_len(&section.text[..found.start]))
                            .unwrap_or(u32::MAX),
                        quote: section.text[found.start..found.end].to_owned(),
                        prefix: crate::passage::prefix_of(&section.text, found.start).to_owned(),
                        suffix: crate::passage::suffix_of(&section.text, found.end).to_owned(),
                        score: one.score,
                    });
                }
            }
            /* `text` goes out of scope here — one book's worth, never more. */
        }
        Ok(out)
    }

    /// How many sections the index answers for.
    #[must_use]
    pub fn sections(&self) -> u64 {
        self.postings.sections()
    }

    /// Bytes on disk: the postings, and the text beside them.
    #[must_use]
    pub fn bytes(&self) -> (u64, u64) {
        (
            self.postings.bytes(),
            index::bytes_under(&self.layout.text_dir),
        )
    }

    /// Every book the postings really hold, for the recovery check.
    ///
    /// # Errors
    /// [`Error::Index`] when a segment will not read.
    pub fn books_in_index(&self) -> Result<HashMap<String, u32>> {
        index::books_in(&self.postings)
    }
}

/// Recover a book id from a text file whose header would not parse.
///
/// Best effort, and it says so: the id is inside the file, which is the thing
/// that will not read. The slug in the filename is what is left, and it is
/// enough to name the book in a note.
fn book_id_of(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(|stem| stem.rsplit_once('-'))
        .map(|(slug, _)| slug.to_owned())
}

#[cfg(test)]
mod tests;
