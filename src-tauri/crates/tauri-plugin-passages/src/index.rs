//! The postings: tantivy's schema, its writer, and what a query asks of it.
//!
//! # What is stored here and what is not
//!
//! `body` is INDEXED AND NOT STORED. The words are searchable and the text
//! itself lives once, in `text/` — which is the separation the whole design
//! leans on: the index is rebuildable from the text, so changing the analysis
//! costs a posting rebuild and reopens no book. It is also what keeps the index
//! small enough to answer the phase's *"under 15 % of the library's own bytes"*
//! bar, since storing the body would put a second copy of the whole library in
//! `index/`.
//!
//! # Positions are stored, deliberately, and they are not free
//!
//! `WithFreqsAndPositions` is what makes `"the whale"` mean the two words next
//! to each other. Without it a phrase query is silently an AND — the worst shape
//! available, since it answers plausibly and wrongly. The cost is the posting
//! list carrying a position per occurrence; it is measured rather than assumed,
//! and reported by `passages_status`.

use std::collections::HashMap;
use std::path::Path;

use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, PhraseQuery, Query, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, FAST, INDEXED, STORED,
    STRING,
};
use tantivy::tokenizer::{Token as TantivyToken, TokenStream, Tokenizer, TokenizerManager};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};

use crate::error::{Error, Result};
use crate::passage::Clause;
use crate::tokenize;

/// The name the analysis is registered under inside the index.
pub const TOKENIZER: &str = "paper";

/// How much heap the writer may use before it flushes a segment.
///
/// Tantivy's floor is 15 MB per thread. 64 MB is roughly six hundred sections,
/// which keeps a backfill of a large library from writing thousands of tiny
/// segments that then have to be merged.
const WRITER_HEAP: usize = 64 * 1024 * 1024;

/// [`tokenize`] wearing tantivy's trait.
///
/// ⚠️ **IT DELEGATES RATHER THAN REIMPLEMENTING.** The index side and the
/// passage side must agree about what a word is down to the last apostrophe; two
/// implementations of that is the shape this repository keeps paying for.
#[derive(Clone, Default)]
pub struct PaperTokenizer;

pub struct PaperTokenStream {
    tokens: Vec<TantivyToken>,
    at: usize,
    current: TantivyToken,
}

impl Tokenizer for PaperTokenizer {
    type TokenStream<'a> = PaperTokenStream;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        let tokens = tokenize::tokenize(text)
            .into_iter()
            .map(|one| TantivyToken {
                offset_from: one.start,
                offset_to: one.end,
                position: one.position,
                text: one.text,
                position_length: 1,
            })
            .collect();
        PaperTokenStream {
            tokens,
            at: 0,
            current: TantivyToken::default(),
        }
    }
}

impl TokenStream for PaperTokenStream {
    fn advance(&mut self) -> bool {
        match self.tokens.get(self.at) {
            Some(token) => {
                self.current = token.clone();
                self.at += 1;
                true
            }
            None => false,
        }
    }

    fn token(&self) -> &TantivyToken {
        &self.current
    }

    fn token_mut(&mut self) -> &mut TantivyToken {
        &mut self.current
    }
}

/// The fields, resolved once.
#[derive(Debug, Clone, Copy)]
pub struct Fields {
    pub book_id: Field,
    pub section: Field,
    pub body: Field,
}

/// The schema, and the fields by name.
#[must_use]
pub fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    /* `STRING`, not `TEXT`: a book id is one opaque token, never analysed.
     * Stored, because a hit has to name its book. */
    let book_id = builder.add_text_field("book_id", STRING | STORED);
    /* `INDEXED` as well as stored, so a rekey or a removal can address a
     * book's sections; `FAST` so the section number comes back without
     * fetching the document. */
    let section = builder.add_u64_field("section", INDEXED | STORED | FAST);
    let body = builder.add_text_field(
        "body",
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(TOKENIZER)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        ),
    );
    let schema = builder.build();
    (
        schema,
        Fields {
            book_id,
            section,
            body,
        },
    )
}

fn register(tokenizers: &TokenizerManager) {
    tokenizers.register(TOKENIZER, PaperTokenizer);
}

/// One section, as the index holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub index: u32,
    pub text: String,
}

/// A section that matched, and how well.
#[derive(Debug, Clone)]
pub struct Match {
    pub book_id: String,
    pub section: u32,
    pub score: f32,
}

/// The index, open.
pub struct Postings {
    /* The index itself is not held: `IndexReader` and `IndexWriter` each keep
     * their own handle on it, and a third field nothing read is a field a later
     * reader has to work out the purpose of. `dir` is kept because measuring
     * the postings means asking the filesystem, not the index. */
    dir: std::path::PathBuf,
    fields: Fields,
    reader: IndexReader,
    writer: IndexWriter,
}

impl Postings {
    /// Open the index at `dir`, creating it when there is none.
    ///
    /// # Errors
    /// [`Error::Index`] when the directory is there and will not open — which is
    /// DAMAGE and not emptiness, and the caller must be able to tell the two
    /// apart. See `store.rs`, which is where the recovery decision is made.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let (schema, fields) = schema();
        let directory = tantivy::directory::MmapDirectory::open(dir)
            .map_err(|cause| Error::Index(cause.to_string()))?;
        let index = Index::open_or_create(directory, schema)?;
        register(index.tokenizers());
        let reader = index
            .reader_builder()
            /* MANUAL, AND RELOADED EXPLICITLY AFTER EVERY COMMIT. The
             * alternative polls on a delay, which makes "is the book I just
             * indexed searchable yet?" a question with a timing-dependent
             * answer — untestable, and the kind of flake that gets a test
             * deleted rather than fixed. */
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        let writer = index.writer(WRITER_HEAP)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            fields,
            reader,
            writer,
        })
    }

    /// Replace everything the index holds for one book.
    ///
    /// ⚠️ **DELETE THEN INSERT, WHICH IS WHAT MAKES A REPLAY HARMLESS.** A
    /// checkpoint written after a commit means a crash re-indexes whatever the
    /// commit had not yet covered; without the delete, that replay would leave
    /// the same section in twice and a reader would be shown one passage as two.
    ///
    /// # Errors
    /// [`Error::Index`] from the writer.
    pub fn replace(&mut self, book_id: &str, sections: &[Section]) -> Result<()> {
        self.forget(book_id)?;
        for section in sections {
            self.writer.add_document(doc!(
                self.fields.book_id => book_id,
                self.fields.section => u64::from(section.index),
                self.fields.body => section.text.as_str(),
            ))?;
        }
        Ok(())
    }

    /// Drop every section of one book. Uncommitted until [`Self::commit`].
    ///
    /// # Errors
    /// [`Error::Index`] from the writer.
    pub fn forget(&mut self, book_id: &str) -> Result<()> {
        self.writer
            .delete_term(Term::from_field_text(self.fields.book_id, book_id));
        Ok(())
    }

    /// Make everything written so far durable and visible.
    ///
    /// ⚠️ **THE RELOAD IS PART OF THE COMMIT, not a separate courtesy.** A
    /// commit that persisted without reloading leaves a reader answering from
    /// the previous generation, so `passages_status` would report a book indexed
    /// while a search for it answered nothing — which reads as a broken index
    /// and is a stale reader.
    ///
    /// # Errors
    /// [`Error::Index`] when the commit or the reload fails.
    pub fn commit(&mut self) -> Result<()> {
        self.writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    /// Throw away everything and start again — the tokenizer migration's half
    /// that touches the postings. The text beside it is untouched.
    ///
    /// # Errors
    /// [`Error::Index`] from the writer.
    pub fn clear(&mut self) -> Result<()> {
        self.writer.delete_all_documents()?;
        self.commit()
    }

    /// How many sections the index currently answers for.
    #[must_use]
    pub fn sections(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    /// The bytes the index occupies on disk.
    ///
    /// ⚠️ **MEASURED FROM THE FILESYSTEM, NOT BY READING THE FILES.** The
    /// obvious spelling — ask the directory for each managed file and take the
    /// length of what comes back — loads every posting list into memory to
    /// measure it, which on a full library is a gigabyte of reading to answer a
    /// number shown in Settings.
    #[must_use]
    pub fn bytes(&self) -> u64 {
        bytes_under(&self.dir)
    }

    /// Which sections answer this query, best first.
    ///
    /// # Errors
    /// [`Error::Index`] when the search fails.
    pub fn search(&self, clauses: &[Clause], limit: usize) -> Result<Vec<Match>> {
        if clauses.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let searcher = self.reader.searcher();
        let query = self.query_of(clauses);
        /* `order_by_score`, because `TopDocs` is no longer a collector on its
         * own — it is the limit and the offset, and asking it to rank is a
         * separate call. `with_limit` also PANICS on zero, which is why the
         * guard above is a guard and not a courtesy. */
        let found = searcher.search(&query, &TopDocs::with_limit(limit).order_by_score())?;
        let mut out = Vec::with_capacity(found.len());
        for (score, address) in found {
            let stored: TantivyDocument = searcher.doc(address)?;
            let Some(book_id) = stored
                .get_first(self.fields.book_id)
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            let Some(section) = stored
                .get_first(self.fields.section)
                .and_then(|value| value.as_u64())
            else {
                continue;
            };
            out.push(Match {
                book_id: book_id.to_owned(),
                section: u32::try_from(section).unwrap_or(u32::MAX),
                score,
            });
        }
        Ok(out)
    }

    /// The clauses as one conjunctive query.
    ///
    /// ⚠️ **BUILT BY HAND RATHER THAN THROUGH `QueryParser`.** The parser has a
    /// syntax of its own — field prefixes, ranges, `+`/`-` — which this app has
    /// not designed and would be exposing to a reader's search box by accident;
    /// and it would be a SECOND place that decides whether a bare multi-word
    /// query is an AND. `parse_query` is the one place, and this consumes its
    /// answer.
    fn query_of(&self, clauses: &[Clause]) -> BooleanQuery {
        let parts: Vec<(Occur, Box<dyn Query>)> = clauses
            .iter()
            .map(|clause| {
                let query: Box<dyn Query> = match clause {
                    Clause::Term(word) => Box::new(TermQuery::new(
                        Term::from_field_text(self.fields.body, word),
                        IndexRecordOption::WithFreqs,
                    )),
                    Clause::Phrase(words) => Box::new(PhraseQuery::new(
                        words
                            .iter()
                            .map(|word| Term::from_field_text(self.fields.body, word))
                            .collect(),
                    )),
                };
                (Occur::Must, query)
            })
            .collect();
        BooleanQuery::new(parts)
    }
}

/// Every book the index currently holds a section of, with how many.
///
/// Used by the recovery path to tell "the index is empty" from "the index
/// disagrees with what `state.json` claims", which is the difference between
/// nothing to do and a rebuild.
///
/// # Errors
/// [`Error::Index`] when a segment will not read.
pub fn books_in(postings: &Postings) -> Result<HashMap<String, u32>> {
    let searcher = postings.reader.searcher();
    let mut out: HashMap<String, u32> = HashMap::new();
    for segment in searcher.segment_readers() {
        let store = segment.get_store_reader(1)?;
        /* ⚠️ **`None` COUNTED DELETED DOCUMENTS, AND `replace` DELETES BEFORE IT
         * INSERTS.** So every book that had been re-indexed since the last
         * segment merge was counted twice — which is exactly the population a
         * reconciliation is about, and it made the answer disagree with the
         * checkpoint for books that were perfectly well indexed. Found by an
         * independent audit. The alive bitset is the segment's own record of
         * which documents survive its deletes. */
        for doc in store.iter::<TantivyDocument>(segment.alive_bitset()) {
            let doc = doc?;
            if let Some(book_id) = doc
                .get_first(postings.fields.book_id)
                .and_then(|value| value.as_str())
            {
                *out.entry(book_id.to_owned()).or_insert(0) += 1;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;

/// Every byte under a directory, following no link.
///
/// `symlink_metadata`, so a link planted in the index directory is counted as
/// the link it is rather than followed out of the tree — the same posture the
/// mutation gate takes about every path it is handed.
#[must_use]
pub fn bytes_under(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(std::result::Result::ok)
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => bytes_under(&entry.path()),
            Ok(kind) if kind.is_file() => {
                std::fs::symlink_metadata(entry.path()).map_or(0, |meta| meta.len())
            }
            _ => 0,
        })
        .sum()
}
