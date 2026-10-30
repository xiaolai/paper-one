//! The extracted section text, retained beside the postings.
//!
//! # Why this exists at all
//!
//! Because **changing the analysis must not mean reopening 1 959 EPUBs.**
//! Postings are derived; the text is not. With the text here, a tokenizer change
//! costs a rebuild that reads only this directory — [`crate::store::Store::rebuild`]
//! is that, and its test asserts no book was asked for.
//!
//! # One file per book, and the format
//!
//! JSONL. The first line is a HEADER naming the book and the version; every line
//! after it is one section. A book is written whole, to a temporary name, and
//! renamed over the old one — so a crash leaves either the previous generation
//! or the new one, never half of either.
//!
//! ⚠️ **THE HEADER CARRIES THE BOOK ID, AND THAT IS NOT DECORATION.** The
//! filename is a slug plus a 64-bit digest of the id, so two ids could in
//! principle land on one name. Reading the id back turns that from a silent
//! merge into a detected mismatch.
//!
//! ⚠️ **A FILE THAT IS PRESENT AND WILL NOT READ IS NOT AN EMPTY BOOK.** It is
//! [`Error::Damaged`], and the caller re-extracts rather than indexing nothing
//! and reporting success. This repository has fixed the opposite reading in
//! eighteen stores; the rule is the same here.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// What version of this file format is on disk.
///
/// Bumped when the SHAPE changes. It is not the analysis version — that is
/// [`crate::tokenize::ANALYSIS`], and the two move for different reasons: a
/// format change costs a re-extraction, an analysis change costs a rebuild.
pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Header {
    format: u32,
    book: String,
    /// What these bytes were extracted from — see [`crate::state`].
    generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Line {
    /// The spine index. `i` rather than `index` because this file is written
    /// once per book and read on every rebuild; the short name is the format.
    i: u32,
    t: String,
}

/// One book's text, as it is held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookText {
    pub book_id: String,
    pub generation: String,
    pub sections: Vec<crate::index::Section>,
}

impl BookText {
    /// Every character of it — what the size report counts.
    #[must_use]
    pub fn chars(&self) -> u64 {
        self.sections
            .iter()
            .map(|one| one.text.chars().count() as u64)
            .sum()
    }
}

/// Write one book's text, atomically.
///
/// # Errors
/// The underlying I/O failure.
pub fn write(path: &Path, book: &BookText) -> Result<()> {
    let mut out = String::new();
    out.push_str(
        &serde_json::to_string(&Header {
            format: FORMAT,
            book: book.book_id.clone(),
            generation: book.generation.clone(),
        })
        .map_err(|cause| Error::Io(cause.to_string()))?,
    );
    out.push('\n');
    for section in &book.sections {
        out.push_str(
            &serde_json::to_string(&Line {
                i: section.index,
                t: section.text.clone(),
            })
            .map_err(|cause| Error::Io(cause.to_string()))?,
        );
        out.push('\n');
    }
    write_atomically(path, out.as_bytes())
}

/// Write `bytes` to `path` so that a crash leaves the old file or the new one.
///
/// ⚠️ **THE TEMPORARY IS A SIBLING, NOT A FILE IN `/tmp`.** `rename(2)` across
/// filesystems is a copy, which puts the window this exists to close straight
/// back. The voices plugin's `staging/` beside `packs/` is the same decision for
/// the same reason.
///
/// # Errors
/// The underlying I/O failure.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::BadPath(path.display().to_string()))?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".writing");
    let temporary = std::path::PathBuf::from(temporary);
    /* REMOVED FIRST, THEN CREATED ANEW. `write` follows a symbolic link, so a
     * link left at the temporary name would send this file wherever it points —
     * the finding the mutation gate records for every file it generates. */
    let _ = std::fs::remove_file(&temporary);
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Read one book's text back.
///
/// `Ok(None)` when there is no such file — nothing was ever indexed for this
/// book, which is a state and not a failure.
///
/// # Errors
/// [`Error::Damaged`] when the file is THERE and will not read: unparseable,
/// the wrong format, or naming a different book. Each of those is damage, and
/// the caller re-extracts; none of them is "this book has no text".
pub fn read(path: &Path, book_id: &str) -> Result<Option<BookText>> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(cause) => return Err(cause.into()),
    };
    let damaged = |why: &str| Error::Damaged(path.display().to_string(), why.to_owned());
    let mut lines = raw.lines();
    let Some(first) = lines.next() else {
        /* AN EMPTY FILE IS DAMAGE, NOT AN EMPTY BOOK. `write` always emits a
         * header, so zero bytes means a truncated write — exactly the case the
         * atomic rename exists to prevent, arriving from something else. */
        return Err(damaged("it has no header line"));
    };
    let header: Header = serde_json::from_str(first)
        .map_err(|cause| damaged(&format!("its header will not parse: {cause}")))?;
    if header.format != FORMAT {
        return Err(damaged(&format!(
            "it is format {} and this build reads {FORMAT}",
            header.format
        )));
    }
    if header.book != book_id {
        /* THE DIGEST COLLISION, DETECTED. See the module header: two ids can in
         * principle produce one filename, and merging them silently would put
         * one book's passages under another's name. */
        return Err(damaged(&format!(
            "it holds {} and was asked for {book_id}",
            header.book
        )));
    }
    let mut sections = Vec::new();
    for (at, line) in lines.enumerate() {
        if line.is_empty() {
            continue;
        }
        let parsed: Line = serde_json::from_str(line)
            .map_err(|cause| damaged(&format!("line {} will not parse: {cause}", at + 2)))?;
        sections.push(crate::index::Section {
            index: parsed.i,
            text: parsed.t,
        });
    }
    Ok(Some(BookText {
        book_id: header.book,
        generation: header.generation,
        sections,
    }))
}

/// Forget one book's text. Absent is success — this is how a removal ends.
///
/// # Errors
/// The underlying I/O failure, for anything but a missing file.
pub fn remove(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(cause) => Err(cause.into()),
    }
}

/// Every book file under `dir`, as paths.
///
/// # Errors
/// The underlying I/O failure.
pub fn files_in(dir: &Path) -> Result<Vec<std::path::PathBuf>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(cause) => return Err(cause.into()),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
    /* SORTED, so a rebuild is deterministic and its log reads the same twice. */
    out.sort();
    Ok(out)
}

/// Read a file whose book id is not known in advance — the rebuild's path.
///
/// # Errors
/// [`Error::Damaged`] on the same terms as [`read`], minus the identity check,
/// which has nothing to compare against here.
pub fn read_any(path: &Path) -> Result<Option<BookText>> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(cause) => return Err(cause.into()),
    };
    let damaged = |why: &str| Error::Damaged(path.display().to_string(), why.to_owned());
    let first = raw
        .lines()
        .next()
        .ok_or_else(|| damaged("it has no header line"))?;
    let header: Header = serde_json::from_str(first)
        .map_err(|cause| damaged(&format!("its header will not parse: {cause}")))?;
    read(path, &header.book)
}

#[cfg(test)]
mod tests;
