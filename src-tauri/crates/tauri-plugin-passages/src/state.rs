//! What is indexed, at what generation, and what could not be read.
//!
//! # The crash-consistency rule, in one sentence
//!
//! **A book enters this file only AFTER the commit that made it searchable.**
//!
//! The phase plan states both halves of what that buys: *"a checkpoint written
//! before the commit loses a book for ever; after it, a replay duplicates its
//! sections."* The first half is why the order is this way round. The second is
//! why [`crate::index::Postings::replace`] deletes before it inserts — a replay
//! of a book already present is a REPLACEMENT, so re-doing work is free and
//! doing it twice is impossible.
//!
//! # What a generation is
//!
//! A string the front end chooses, opaque here. It is the book's `contentHash`
//! when the shelf knows one, and the byte size otherwise. Whatever it is, the
//! rule is the same: **the same generation means the same bytes, so the index is
//! current; a different one means re-extract.** The plugin never computes it,
//! because the plugin never opens a book.
//!
//! # And what a note is
//!
//! ⚠️ **A BOOK THAT YIELDED NO TEXT IS RECORDED, NEVER SKIPPED.** Silently empty
//! is indistinguishable from "no matches", which is this repository's most
//! repeated defect shape — and at library scale it is the difference between a
//! search that covers the shelf and one that quietly omits a fifth of it.
//! `passages_status` reads these notes, and WI-31.7 shows them to the reader.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::text::write_atomically;

/// The shape version of `state.json`.
pub const FORMAT: u32 = 1;

/// One book that is indexed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Indexed {
    /// What these postings were built from — see the module header.
    pub generation: String,
    pub sections: u32,
    /// Characters of canonical text, for the size report.
    pub chars: u64,
    /// When it was committed, in epoch milliseconds, as the caller counts them.
    pub at: u64,
}

/// A book that could not be indexed, and why — in words a reader can read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub why: String,
    pub at: u64,
}

/// The whole file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub format: u32,
    /// Which analysis wrote the postings. A mismatch means REBUILD, not
    /// re-extract — see [`crate::store::Store::open`].
    pub analysis: String,
    /// `BTreeMap` so the file is byte-stable: a map whose order moves makes
    /// every write a diff and every comparison in a test a sort.
    pub books: BTreeMap<String, Indexed>,
    pub notes: BTreeMap<String, Note>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            format: FORMAT,
            analysis: crate::tokenize::ANALYSIS.to_owned(),
            books: BTreeMap::new(),
            notes: BTreeMap::new(),
        }
    }
}

impl State {
    /// Whether this book's index is current for these bytes.
    #[must_use]
    pub fn current(&self, book_id: &str, generation: &str) -> bool {
        self.books
            .get(book_id)
            .is_some_and(|one| one.generation == generation)
    }

    /// Record a book as indexed, clearing any note against it.
    ///
    /// ⚠️ **THE NOTE GOES WHEN THE BOOK ARRIVES.** A book that failed to extract
    /// once and succeeded later would otherwise be listed for ever among the
    /// books that could not be read — which is the same class of lie as an
    /// unreadable file reported as empty, pointing the other way.
    pub fn indexed(&mut self, book_id: &str, one: Indexed) {
        self.notes.remove(book_id);
        self.books.insert(book_id.to_owned(), one);
    }

    /// Record that a book could not be indexed. Clears any stale index entry
    /// for the same reason the line above clears a note.
    pub fn noted(&mut self, book_id: &str, note: Note) {
        self.books.remove(book_id);
        self.notes.insert(book_id.to_owned(), note);
    }

    /// Forget a book entirely — a removal, or an eviction of its bytes.
    pub fn forget(&mut self, book_id: &str) {
        self.books.remove(book_id);
        self.notes.remove(book_id);
    }

    /// Move everything known about one book to a new id — WI-31.3's rekey.
    ///
    /// ⚠️ **NOT A REMOVE PLUS AN ADD.** A rekey preserves the work: the text is
    /// the same bytes under a new name, so re-extracting would be an hour of a
    /// backfill spent for nothing. The postings are re-written because the book
    /// id is a stored FIELD, which is the one part that cannot simply be moved.
    pub fn rekey(&mut self, from: &str, to: &str) {
        if let Some(one) = self.books.remove(from) {
            self.books.insert(to.to_owned(), one);
        }
        if let Some(note) = self.notes.remove(from) {
            self.notes.insert(to.to_owned(), note);
        }
    }
}

/// Read the state, or a fresh one when there is none.
///
/// # Errors
/// [`Error::Damaged`] when the file is THERE and will not read. That is the
/// whole reason this is not `unwrap_or_default`: a state file that parses as
/// "nothing is indexed" sends a backfill over 1 959 books that were already
/// done, and — worse — the next write puts that emptiness on disk over the
/// record of what really is there.
pub fn read(path: &Path) -> Result<State> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(State::default()),
        Err(cause) => return Err(cause.into()),
    };
    let damaged = |why: String| Error::Damaged(path.display().to_string(), why);
    let state: State = serde_json::from_str(&raw)
        .map_err(|cause| damaged(format!("it will not parse: {cause}")))?;
    if state.format != FORMAT {
        return Err(damaged(format!(
            "it is format {} and this build reads {FORMAT}",
            state.format
        )));
    }
    Ok(state)
}

/// Write the state, atomically.
///
/// # Errors
/// The underlying I/O failure.
pub fn write(path: &Path, state: &State) -> Result<()> {
    let raw = serde_json::to_vec_pretty(state).map_err(|cause| Error::Io(cause.to_string()))?;
    write_atomically(path, &raw)
}

#[cfg(test)]
mod tests;
