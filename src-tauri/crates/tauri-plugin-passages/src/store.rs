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
    /// Committed-but-uncheckpointed books, with the warning each carries.
    ///
    /// ⚠️ **THE WARNING TRAVELS WITH THE CHECKPOINT BECAUSE IT HAS TO LAND IN
    /// THE SAME WRITE.** See [`Store::put`].
    pending: Vec<(String, Indexed, Option<Note>)>,
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
        /* ⚠️ **AND SO IS A REBUILD THAT WAS NEVER SEEN TO FINISH.** The
         * analysis test above catches an interrupted rebuild that was CAUSED by
         * an analysis change, because the old analysis is still on disk — it
         * says nothing about the same-analysis rebuild a reader asks for, where
         * the postings have been cleared and the checkpoint still describes
         * them. See [`State::rebuilding`]. */
        if store.state.analysis != tokenize::ANALYSIS || store.state.rebuilding {
            store.rebuild()?;
        } else {
            store.reconcile()?;
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
    /// A book's sections, and — in the same operation — whether its coverage is
    /// PARTIAL.
    ///
    /// ⚠️ **`partial` IS AN ARGUMENT RATHER THAN A SECOND CALL, AND THAT IS THE
    /// WHOLE OF WHY IT IS HERE.** It was `note_partial`, called by the front end
    /// immediately after this — and a `put` that fills the batch COMMITS and
    /// writes the checkpoint before returning, so a crash in the gap between the
    /// two calls left the book checkpointed as complete with nothing recording
    /// the chapters that would not read. `current()` then answers true at that
    /// generation for ever: the gap is permanent, silent, and looks exactly like
    /// a book with no matches there. One-in-`BATCH` books were exposed, and the
    /// front end could not close it from its side at any cost. Found by an
    /// independent audit.
    ///
    /// Carried alongside the checkpoint in `pending`, the two land in the single
    /// `state::write` [`Store::flush`] performs, so there is no gap to crash in.
    pub fn put(
        &mut self,
        book_id: &str,
        generation: &str,
        sections: Vec<Section>,
        at: u64,
        partial: Option<&str>,
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
            partial.map(|why| Note {
                why: why.to_owned(),
                at,
                generation: generation.to_owned(),
            }),
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
    pub fn note(&mut self, book_id: &str, generation: &str, why: &str, at: u64) -> Result<()> {
        self.flush()?;
        /* ⚠️ **THE OLD POSTINGS AND TEXT GO, AND LEAVING THEM MEANT THE PANEL
         * AND THE SEARCH DISAGREED.** A book whose REPLACEMENT bytes cannot be
         * read was noted while the previous generation went on answering
         * queries — so Settings said *"could not be read"* and search returned
         * its old contents, and a rebuild could clear the warning by re-indexing
         * that stale text. Found by an independent audit. */
        self.postings.forget(book_id)?;
        self.postings.commit()?;
        text::remove(&self.layout.text_path(book_id)?)?;
        self.state.noted(
            book_id,
            Note {
                why: why.to_owned(),
                at,
                /* WHAT IT FAILED AT, so freshness can leave it alone until the
                 * bytes change — see `Note::generation`. */
                generation: generation.to_owned(),
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
    /// Every book this store holds ANYTHING about — indexed or noted.
    ///
    /// ⚠️ **THE REMOVAL DIFF ASKED FOR `books` ALONE, SO A NOTED BOOK COULD
    /// NEVER BE FORGOTTEN.** A book that yields no text and is then trashed kept
    /// its warning in Settings for ever: it was never in the list the sweep
    /// compares against the shelf, so it never entered the set to drop. Found by
    /// an independent audit.
    #[must_use]
    pub fn known(&self) -> Vec<String> {
        let mut out: Vec<String> = self.state.books.keys().cloned().collect();
        for id in self.state.notes.keys() {
            if !self.state.books.contains_key(id) {
                out.push(id.clone());
            }
        }
        out.sort();
        out
    }

    pub fn retry_unreadable(&mut self) -> Result<usize> {
        let cleared = self.state.notes.len();
        if cleared == 0 {
            return Ok(0);
        }
        /* ⚠️ **THE CHECKPOINT GOES TOO, OR THE BUTTON ONLY DELETES THE
         * WARNING.** A PARTLY readable book keeps its `books` entry — that is
         * what makes its good chapters searchable — so clearing the note alone
         * left it `current` at that generation and freshness never offered it to
         * another sweep. The warning vanished and the coverage stayed exactly as
         * incomplete. Found by the verification pass of an independent audit,
         * which is the one that catches a fix that half-lands.
         *
         * The POSTINGS are untouched: `put` replaces a book's sections when the
         * re-extraction lands, so search keeps answering from what is there
         * until there is something better. Only the claim of freshness goes. */
        /* ⚠️ **AND THE NOTE IS REPLACED, NOT DROPPED, OR THE BOOK IS ORPHANED.**
         * Clearing both the checkpoint and the note takes the book out of
         * `known()` — so if it is removed or evicted before the re-extraction
         * lands, the removal diff never sees it and its postings answer for ever.
         * An empty-generation marker keeps it visible to the diff while matching
         * no generation, which is exactly "try this again". Found by the second
         * audit round, looking at what the first round's fixes introduced. */
        let retrying: Vec<String> = self.state.notes.keys().cloned().collect();
        for book_id in &retrying {
            self.state.books.remove(book_id);
        }
        self.state.notes.clear();
        for book_id in retrying {
            self.state.notes.insert(
                book_id,
                Note {
                    why: "waiting to be read again".to_owned(),
                    at: 0,
                    generation: String::new(),
                },
            );
        }
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
        for (book_id, one, partial) in std::mem::take(&mut self.pending) {
            self.state.indexed(&book_id, one);
            /* AFTER `indexed`, WHICH CLEARS ANY NOTE — and inserted directly
             * rather than through `noted`, which would remove the checkpoint
             * just written. The book IS indexed; what this records is that it
             * is indexed in PART, so the coverage stays and the gap is named
             * beside it. */
            if let Some(note) = partial {
                self.state.notes.insert(book_id, note);
            }
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
        self.pending.retain(|(id, _, _)| id != book_id);
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
        /* ⚠️ **THE MARKER GOES DOWN BEFORE THE CLEAR, AND THAT ORDER IS THE
         * WHOLE OF IT.** `clear()` commits, so from the next line the postings
         * are gone while `state.json` still names every book as searchable.
         * Marking first makes an interruption anywhere after this point a state
         * the next `open` recognises and repairs; marking afterwards would leave
         * the same hole one line further down. It stays set on `self.state` for
         * the whole walk, so an intermediate write carries it too, and an error
         * return leaves a store whose every later write still asks for the
         * repair. Found by an independent audit. */
        self.state.rebuilding = true;
        state::write(&self.layout.state_path, &self.state)?;
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
            /* CLEARED ONLY HERE, on the value that is about to become the
             * checkpoint — so the marker is lifted by the same write that makes
             * the new postings' description durable, and by nothing else. */
            rebuilding: false,
        };
        /* ⚠️ **WHICH BOOK A DAMAGED FILE BELONGS TO IS ANSWERED BY THE NAMING
         * FUNCTION, NEVER BY READING THE NAME BACK.** `file_stem` folds every
         * non-alphanumeric character to `_`, so `book:a` is stored as
         * `book_a-<digest>` and a recovered "id" of `book_a` names a book that
         * does not exist — while the real `book:a` keeps whatever note it
         * already had, generation and all, so `current()` answered true and
         * freshness skipped it for ever. A book with no postings, never
         * re-extracted, indistinguishable from a book with no matches. Found by
         * an independent audit.
         *
         * The fold is many-to-one, so it cannot be inverted; it CAN be applied
         * forwards to every id this store knows, which is exact. Built once
         * rather than per damaged file. */
        let mut belongs: HashMap<std::path::PathBuf, String> = HashMap::new();
        for book_id in self.state.books.keys().chain(self.state.notes.keys()) {
            if let Ok(path) = self.layout.text_path(book_id) {
                belongs.insert(path, book_id.clone());
            }
        }
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
                    match belongs.get(&path) {
                        Some(book_id) => rebuilt.noted(
                            book_id,
                            Note {
                                why: format!("its saved text could not be read: {cause}"),
                                at: 0,
                                /* EMPTY, so this never pins a generation: a
                                 * rebuild reads `text/` and has no idea what
                                 * bytes produced it. An empty generation
                                 * matches nothing, so the book is re-extracted
                                 * rather than left alone on the strength of a
                                 * guess — and `noted` drops the book from
                                 * `books` too, so nothing claims it is
                                 * searchable. */
                                generation: String::new(),
                            },
                        ),
                        /* ⚠️ **A FILE NO KNOWN ID PRODUCES IS LOGGED AND LEFT,
                         * NEVER NOTED UNDER A GUESS.** It is text written for a
                         * book whose checkpoint never landed, so nothing claims
                         * it is current and the ordinary backfill will
                         * re-extract that book under its real id. A note under
                         * an invented id would put a book the reader does not
                         * have in the panel's list of books that could not be
                         * read, and would be the one thing able to collide with
                         * a real id. */
                        None => log::warn!(
                            "passages: {} will not read and belongs to no known book: {cause}",
                            path.display()
                        ),
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
        /* ⚠️ **A PARTIAL WARNING SURVIVES A REBUILD, BECAUSE A REBUILD CANNOT
         * REPAIR WHAT IT WARNS ABOUT.** `rebuilt.indexed()` clears a book's note
         * as it checkpoints it — right for a book that has just been extracted
         * afresh, wrong here: the retained text holds only the chapters that
         * read, so rebuilding reproduces exactly the same gap while removing the
         * sentence that named it and the control that retries it. Re-applied for
         * the books whose generation still matches. Found by the second audit
         * round. */
        for (book_id, note) in &self.state.notes {
            let still = rebuilt
                .books
                .get(book_id)
                .is_some_and(|one| one.generation == note.generation);
            if still && !rebuilt.notes.contains_key(book_id) {
                rebuilt.notes.insert(book_id.clone(), note.clone());
            }
        }
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
    pub fn search(&mut self, clauses: &[Clause], limits: Limits) -> Result<Vec<Hit>> {
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
        /* Collected rather than written inside the loop: the state write is one
         * file, and a query that met three damaged books should cost one write
         * rather than three. */
        let mut damaged: Vec<(String, String)> = Vec::new();
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
            /* ⚠️ **A BOOK WHOSE TEXT WILL NOT READ IS RECORDED HERE, AND THIS
             * SAID THE DAMAGE WAS "already in `state.json`" WHEN NOTHING HAD
             * PUT IT THERE.** A read failure at SEARCH time was turned into
             * `None` and skipped — so the book silently stopped answering
             * queries while `passages_status` went on counting it as covered,
             * and freshness, seeing a current generation, never re-extracted it.
             * Three ways to be wrong about one book, and no way for a reader to
             * find out. Found by an independent audit.
             *
             * The query still answers: one damaged book must not make the
             * library unsearchable. What changes is that the damage is now a
             * fact somebody can read. */
            let text = match text::read(&path, &book_id) {
                Ok(Some(text)) => text,
                /* ⚠️ **ABSENT IS DAMAGE HERE, AND ONLY HERE.** Everywhere else a
                 * missing text file means a book that was never indexed — but
                 * the POSTINGS just named this one, so its text must exist and
                 * does not. Skipped silently it kept its checkpoint, showed no
                 * warning, and every later sweep passed it over. The damage
                 * handling covered an unreadable file and missed an absent one.
                 * Found by the second audit round. */
                Ok(None) => {
                    damaged.push((book_id.clone(), "the file is not there".to_owned()));
                    continue;
                }
                Err(cause) => {
                    damaged.push((book_id.clone(), cause.to_string()));
                    continue;
                }
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
        if !damaged.is_empty() {
            /* ⚠️ **THE PENDING ENTRY GOES TOO, OR THE NEXT FLUSH UNDOES THIS.**
             * A book can have a replacement in `pending` when a search meets its
             * damaged text; removing the checkpoint and writing the note is
             * pointless if `flush` then calls `indexed()` for that same book and
             * clears the warning. Found by the second audit round. */
            self.pending
                .retain(|(id, _, _)| !damaged.iter().any(|(damaged_id, _)| damaged_id == id));
            /* NOTED WITH AN EMPTY GENERATION, so the next sweep re-extracts it
             * rather than leaving it alone: what failed is the SAVED TEXT, and
             * nothing is known about whether the book's own bytes would read.
             * `noted` takes the checkpoint away, which is what makes it
             * pending. */
            for (book_id, why) in damaged {
                self.state.noted(
                    &book_id,
                    Note {
                        why: format!("its saved text could not be read: {why}"),
                        at: 0,
                        generation: String::new(),
                    },
                );
            }
            /* ⚠️ **A FAILED WRITE MUST NOT THROW AWAY THE HITS THE READER
             * ASKED FOR.** Propagating it turned one damaged book on a full disk
             * into the failure of the whole query, healthy results included —
             * which is a search that stops working because of bookkeeping. The
             * state stays dirty in memory and the next write takes it; what the
             * caller gets is what it asked for. Found by the second audit round. */
            if let Err(cause) = state::write(&self.layout.state_path, &self.state) {
                log::warn!("passages: the damage record could not be saved: {cause}");
            }
        }
        Ok(out)
    }

    /// Make the checkpoint agree with the postings that are actually there.
    ///
    /// ⚠️ **`books_in_index` WAS WRITTEN FOR THIS AND HAD NO PRODUCTION CALLER,
    /// WHICH IS THIS REPOSITORY'S OWN WORST SHAPE.** `paper/share-notes/1`
    /// answered a protocol nothing asked, `measuredIn` dropped a list only its
    /// stubs ever read; a capability with no caller is a capability nobody has
    /// seen work. Found by an independent audit.
    ///
    /// A checkpoint that outlives its postings is silent in the worst way:
    /// `current()` answers true, freshness never offers the book again, and the
    /// book simply has no matches for ever. [`State::rebuilding`] closes the way
    /// this crate can cause it; what is left is damage from outside — a segment
    /// file lost to a failed disk, a restore that brought back half of
    /// `passages/`, anything that is not us.
    ///
    /// ⚠️ **THE CHEAP QUESTION FIRST, AND THAT IS WHAT MAKES IT AFFORDABLE AT
    /// ALL.** The per-book count walks the document store — about 78 000
    /// documents on this shelf — and doing that at every launch to find nothing
    /// would be a cost every reader pays for a case almost none of them meet.
    /// `num_docs()` against the sum the checkpoint claims is O(1) and answers
    /// the same question for every state except one where two errors cancel
    /// exactly: a book losing N sections while another gains N. `replace`
    /// writes exactly the sections it is handed and the checkpoint records
    /// exactly that number, so there is no ordinary road to that coincidence,
    /// and the honest reading is that this is a very good check rather than a
    /// proof.
    ///
    /// ⚠️ **AND THE CHEAP CHECK CAN DISAGREE WITHOUT ANYTHING BEING WRONG.**
    /// A crash between a book's commit and its checkpoint — the case the module
    /// header calls self-healing — leaves postings no checkpoint names, so
    /// `claimed` is SHORT of what the index holds and the per-book walk runs
    /// once, finds every checkpointed book intact, and repairs nothing. That is
    /// the correct outcome at the cost of one walk on one launch, and it is
    /// written down rather than optimised away: telling that state from real
    /// damage needs exactly the walk it would be skipping.
    fn reconcile(&mut self) -> Result<()> {
        let claimed: u64 = self
            .state
            .books
            .values()
            .map(|one| u64::from(one.sections))
            .sum();
        if claimed == self.postings.sections() {
            return Ok(());
        }
        let held = index::books_in(&self.postings)?;
        let lost: Vec<String> = self
            .state
            .books
            .iter()
            .filter(|(book_id, one)| held.get(*book_id).copied().unwrap_or(0) != one.sections)
            .map(|(book_id, _)| book_id.clone())
            .collect();
        if lost.is_empty() {
            return Ok(());
        }
        log::warn!(
            "passages: {} book(s) are checkpointed with postings that are not there; they will be indexed again",
            lost.len()
        );
        for book_id in &lost {
            /* ⚠️ **`forget`, NOT A `books.remove`.** Dropping the checkpoint
             * alone leaves any note against the book standing — and `current()`
             * accepts a note whose generation matches, so a book with a PARTIAL
             * warning would go on being skipped with no postings at all. The
             * same trap the damaged-text path had. */
            self.state.forget(book_id);
        }
        state::write(&self.layout.state_path, &self.state)
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

#[cfg(test)]
mod tests;
