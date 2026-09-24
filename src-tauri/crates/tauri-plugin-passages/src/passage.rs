//! Where inside a section a hit actually is.
//!
//! Tantivy answers WHICH sections match and in what order. This answers WHERE,
//! and it is a separate job for a reason the phase plan states: *"one result for
//! a chapter containing four matches is a result a reader cannot use."*
//!
//! ⚠️ **AND THE ANSWER HAS TO BE A REAL SUBSTRING OF THE SECTION'S CANONICAL
//! TEXT**, because that is what makes a hit LANDABLE. The front end takes the
//! quote back to `section.createDocument()` and hands it to `reanchorIn`, which
//! searches the same canonical form for exactly that string. A snippet
//! assembled from highlighted fragments — tantivy's `SnippetGenerator` hands
//! back marked-up HTML — would be a string that occurs nowhere in the book, and
//! every landing would fail.
//!
//! ⚠️ **RAW AND HIGHLIGHTED ARE DIFFERENT VALUES.** Nothing here emits markup.
//! The pane draws the emphasis from `quote`, `prefix` and `suffix` as three
//! plain strings, so the string the resolver searches for can never carry a
//! `<b>`.

use crate::error::{Error, Result};
use crate::tokenize::{tokenize, Token};

/// One thing a query asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Clause {
    /// Terms that must appear next to each other, in order — a quoted phrase.
    Phrase(Vec<String>),
    /// One word, anywhere in the section.
    Term(String),
}

/// How much text either side of a hit travels with it.
///
/// ⚠️ **AT LEAST THE 32 `reanchor.ts` COMPARES, AND IN A UNIT THAT CANNOT BE
/// SHORT.** The resolver caps both sides at `CONTEXT = 32` characters and scores
/// `matched / wanted`, so supplying MORE is free and supplying fewer silently
/// lowers the evidence a landing has to work with. A Rust `char` is one or two
/// UTF-16 code units, so 48 of them is never fewer than 48 of the unit the front
/// end counts in. It is also about the right length for a snippet a person
/// reads, which is the other thing it is for.
pub const CONTEXT_CHARS: usize = 48;

/// The longest a quote may be.
///
/// A quote is an ANCHOR before it is a snippet: `reanchorIn` looks for it
/// character for character, so a long one is more likely to straddle something
/// two builds of a book disagree about.
pub const MAX_QUOTE_BYTES: usize = 320;

/// A passage inside one section: the quote and what sits either side of it.
///
/// Byte offsets into the section text. They become the unit the interface counts
/// in exactly once, at the wire — see `commands.rs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Passage {
    pub start: usize,
    pub end: usize,
}

/// What a reader typed, as clauses.
///
/// **A bare multi-word query is AND, not a phrase**; quotes make a phrase. Both
/// are pinned by cases here, and the CLI, the pane and the schema answer the
/// same way because they all come through this function.
///
/// # Errors
/// [`Error::BadQuery`] for an unbalanced quote, or for a query with no word in
/// it at all — which is a question nothing can answer and must not be reported
/// as "no matches".
pub fn parse_query(raw: &str) -> Result<Vec<Clause>> {
    /* ⚠️ **FOLDED FIRST, OR THE BOOK'S OWN SPELLING FINDS NOTHING.** The index
     * holds canonical text — curly quotes straightened, soft hyphens gone — and
     * a query that has not been through the same fold asks for characters the
     * index does not contain. See `tokenize::fold_query`. Done here rather than
     * per clause so the quotation marks that make a PHRASE are counted after
     * the fold, which is what makes a curly `"` open one. */
    let raw = &crate::tokenize::fold_query(raw);
    let quotes = raw.chars().filter(|c| *c == '"').count();
    if quotes % 2 != 0 {
        return Err(Error::BadQuery(
            "the query has an opening quotation mark with no closing one".to_owned(),
        ));
    }
    let mut clauses: Vec<Clause> = Vec::new();
    let mut inside = false;
    for part in raw.split('"') {
        if inside {
            let terms = crate::tokenize::terms(part);
            /* AN EMPTY PHRASE IS NOT A CLAUSE. `""` between two words is a
             * reader's typo, not a demand that nothing match. */
            match terms.len() {
                0 => {}
                1 => clauses.push(Clause::Term(terms.into_iter().next().unwrap_or_default())),
                _ => clauses.push(Clause::Phrase(terms)),
            }
        } else {
            for term in crate::tokenize::terms(part) {
                clauses.push(Clause::Term(term));
            }
        }
        inside = !inside;
    }
    if clauses.is_empty() {
        return Err(Error::BadQuery(
            "there is no word in that query to look for".to_owned(),
        ));
    }
    if let Some(lone) = lone_cjk_character(&clauses) {
        /* ⚠️ **REFUSED, BECAUSE THE INDEX CANNOT ANSWER IT AND ANSWERING
         * SPORADICALLY IS WORSE THAN SAYING SO.** `tokenize` emits overlapping
         * BIGRAMS for a run of Chinese, Japanese or Korean, so a single
         * character appears as a term only where it stood alone between two
         * separators. A query for one would therefore find the handful of
         * places it happened to be isolated and miss the thousands where it is
         * part of a word — a result that looks like an answer and is an
         * artefact of the tokenizer.
         *
         * This is the SILENT-FAILURE rule this repository states everywhere
         * else: an unreadable file is not an empty one, and a question the
         * index cannot answer is not a question with no answer. */
        return Err(Error::BadQuery(format!(
            "“{lone}” is a single character — searching needs two or more together"
        )));
    }
    Ok(clauses)
}

/// The first clause that is one CJK character and nothing else.
fn lone_cjk_character(clauses: &[Clause]) -> Option<&str> {
    clauses.iter().find_map(|clause| match clause {
        Clause::Term(word) => {
            let mut chars = word.chars();
            match (chars.next(), chars.next()) {
                (Some(one), None) if crate::tokenize::is_cjk(one) => Some(word.as_str()),
                _ => None,
            }
        }
        /* A PHRASE IS NOT AFFECTED. `"春天"` tokenizes to one bigram, which the
         * index holds; the refusal is about a term that came from a run of one,
         * and a quoted run of two or more never produces one. */
        Clause::Phrase(_) => None,
    })
}

/// Every span in `tokens` that satisfies one clause, as token-index ranges.
fn spans_of(tokens: &[Token], clause: &Clause) -> Vec<(usize, usize)> {
    match clause {
        Clause::Term(want) => tokens
            .iter()
            .enumerate()
            .filter(|(_, token)| &token.text == want)
            .map(|(at, _)| (at, at))
            .collect(),
        Clause::Phrase(want) => {
            if want.is_empty() || tokens.len() < want.len() {
                return Vec::new();
            }
            let mut out = Vec::new();
            for at in 0..=tokens.len() - want.len() {
                let run = &tokens[at..at + want.len()];
                /* POSITIONS MUST BE CONSECUTIVE, not merely the token order.
                 * They are the same thing today — nothing here inserts a
                 * position gap — and asking the positions is what keeps this
                 * correct if one is ever added. */
                let adjacent = run
                    .windows(2)
                    .all(|pair| pair[1].position == pair[0].position + 1);
                if adjacent
                    && run
                        .iter()
                        .zip(want)
                        .all(|(token, term)| &token.text == term)
                {
                    out.push((at, at + want.len() - 1));
                }
            }
            out
        }
    }
}

/// Where in this section the query is answered, best passages first.
///
/// A passage is a MINIMAL WINDOW containing at least one span of every clause —
/// which is what makes `whale ship` report the place the two words are near each
/// other rather than the start of the chapter.
///
/// ⚠️ **A WINDOW WIDER THAN A QUOTE MAY BE IS ANCHORED ON ITS RAREST CLAUSE,
/// NEVER DROPPED.** Two words three thousand characters apart are a true match
/// of the section and not a passage; refusing to report one would list the book
/// with nothing to click, and reporting the whole span would hand the resolver a
/// "quote" the length of a page. Which span to keep is not arbitrary — see the
/// note in the body, which records what anchoring on the FIRST one looked like
/// on the real library.
#[must_use]
pub fn passages(text: &str, clauses: &[Clause], limit: usize) -> Vec<Passage> {
    if clauses.is_empty() || limit == 0 {
        return Vec::new();
    }
    let tokens = tokenize(text);
    /* EVERY CLAUSE MUST BE SOMEWHERE, or this section answers nothing —
     * which can happen even though tantivy matched it, because the index is
     * per-section and a rebuild may be mid-flight. Answering an empty list is
     * the honest result; inventing a passage is not. */
    let mut all: Vec<(usize, usize, usize)> = Vec::new();
    /* HOW COMMON EACH CLAUSE IS IN THIS SECTION. The rarest is the one the
     * reader is really asking about — see the wide-window rule below. */
    let mut common: Vec<usize> = vec![0; clauses.len()];
    for (which, clause) in clauses.iter().enumerate() {
        let found = spans_of(&tokens, clause);
        if found.is_empty() {
            return Vec::new();
        }
        common[which] = found.len();
        for (from, to) in found {
            all.push((from, to, which));
        }
    }
    all.sort_unstable();

    /* THE SLIDING WINDOW: walk the spans in order, keeping a count per clause,
     * and shrink from the left whenever every clause is covered. Each minimal
     * covering window is one passage. */
    let mut counted = vec![0usize; clauses.len()];
    let mut covered = 0usize;
    let mut left = 0usize;
    let mut windows: Vec<(usize, usize)> = Vec::new();
    for right in 0..all.len() {
        let (_, _, which) = all[right];
        if counted[which] == 0 {
            covered += 1;
        }
        counted[which] += 1;
        while covered == clauses.len() {
            /* ⚠️ **THE FURTHEST ENDPOINT IN THE WINDOW, NOT THE LAST SPAN'S.**
             * `all` is sorted by START, so the span that starts last need not
             * end last: over `alpha beta gamma`, the query
             * `"alpha beta gamma" beta` has the phrase starting FIRST and
             * ending last, and taking `all[right].1` cut the quote at
             * `alpha beta` — a passage that does not contain the phrase it
             * matched. Found by an independent audit. */
            let end = all[left..=right]
                .iter()
                .map(|(_, to, _)| *to)
                .max()
                .unwrap_or(all[right].1);
            windows.push((all[left].0, end));
            let (_, _, leaving) = all[left];
            counted[leaving] -= 1;
            if counted[leaving] == 0 {
                covered -= 1;
            }
            left += 1;
        }
    }

    let mut spans: Vec<Passage> = windows
        .into_iter()
        .filter_map(|(from_token, to_token)| {
            let first = tokens.get(from_token)?;
            let last = tokens.get(to_token)?;
            let (start, end) = (first.start, last.end);
            if end - start <= MAX_QUOTE_BYTES {
                return Some(Passage { start, end });
            }
            /* ⚠️ **A WINDOW WIDER THAN A QUOTE MAY BE IS ANCHORED ON ITS
             * RAREST CLAUSE, AND ANCHORING ON THE FIRST ONE SHOWED THE READER
             * NONE OF THEIR WORDS.**
             *
             * Found by looking at the running app, on the real library
             * (WI-31.8). A query of `the whale` over a book's printed CONTENTS
             * page is an AND of a word that occurs fifty times and a word that
             * occurs once — so the minimal window runs from some `the` near the
             * top to the single `whale` far below, which is far too wide, and
             * anchoring on its first span produced the snippet *"Contents Cover
             * Title Page Copyright Prologue: The Flip…"*. It was a TRUE hit
             * with a quote containing not one word the reader had typed, and it
             * was the FIRST result in the library.
             *
             * The rarest clause is the one the query is really about: `the`
             * narrows nothing and `whale` is the whole question. Anchoring there
             * gives *"Chapter 12: The Whale"*, which is short, true, and
             * recognisably an answer.
             */
            let anchor = all[..]
                .iter()
                .filter(|(from, _, _)| *from >= from_token && *from <= to_token)
                .min_by_key(|(_, _, which)| common[*which])?;
            let token = tokens.get(anchor.0)?;
            let last_token = tokens.get(anchor.1)?;
            /* ⚠️ **THE BOUND APPLIES HERE TOO, AND THE FALLBACK WALKED ROUND
             * IT.** The anchor is a whole clause — a long quoted phrase, or a
             * token whose TERM was truncated while its source span kept the
             * original run — so returning it unbounded could hand the resolver
             * a quote of any length, which is the thing `MAX_QUOTE_BYTES`
             * exists to prevent. Cut on a character boundary, because a book is
             * not obliged to be ASCII. Found by an independent audit. */
            let (start, mut end) = (token.start, last_token.end);
            if end - start > MAX_QUOTE_BYTES {
                end = start;
                for (offset, ch) in text[start..].char_indices() {
                    if offset + ch.len_utf8() > MAX_QUOTE_BYTES {
                        break;
                    }
                    end = start + offset + ch.len_utf8();
                }
            }
            Some(Passage { start, end })
        })
        .collect();

    /* ⚠️ **TIGHTEST FIRST, AND THAT IS WHAT "BEST" MEANS HERE.** The sliding
     * walk emits every minimal covering window in POSITION order, and the first
     * one is commonly the widest: in *"a whale … many pages later … a ship and a
     * whale"* the first window spans the whole digression and the second is four
     * words. Taking them in position order hands the reader the digression and
     * then drops the good one as an overlap. Width is the evidence that two
     * words are being used together rather than both appearing somewhere in a
     * chapter. */
    spans.sort_by_key(|one| (one.end - one.start, one.start));

    let mut kept: Vec<Passage> = Vec::new();
    for span in spans {
        /* OVERLAPPING WINDOWS COLLAPSE. Consecutive minimal windows commonly
         * share most of their text — four results describing one sentence is
         * the failure this whole function exists to avoid, arriving from the
         * other direction. */
        if kept
            .iter()
            .any(|held| span.start < held.end && held.start < span.end)
        {
            continue;
        }
        kept.push(span);
        if kept.len() >= limit {
            break;
        }
    }
    /* Back into reading order for display: the ranking above decided WHICH
     * passages, and a reader scanning a chapter's hits wants them in the order
     * they occur. */
    kept.sort_by_key(|one| one.start);
    kept
}

/// `CONTEXT_CHARS` of text ending at `at`, and the byte it starts from.
#[must_use]
pub fn prefix_of(text: &str, at: usize) -> &str {
    let mut from = at;
    for _ in 0..CONTEXT_CHARS {
        match text[..from].chars().next_back() {
            Some(c) => from -= c.len_utf8(),
            None => break,
        }
    }
    &text[from..at]
}

/// `CONTEXT_CHARS` of text starting at `at`.
#[must_use]
pub fn suffix_of(text: &str, at: usize) -> &str {
    let mut to = at;
    for _ in 0..CONTEXT_CHARS {
        match text[to..].chars().next() {
            Some(c) => to += c.len_utf8(),
            None => break,
        }
    }
    &text[at..to]
}

#[cfg(test)]
mod tests;
