//! What counts as a word, on both sides of the question.
//!
//! ⚠️ **ONE TOKENIZER, USED THREE TIMES.** The index is built with it, the query
//! is parsed with it, and [`crate::passage`] locates a hit inside a section with
//! it. Three consumers is exactly the number this repository has learnt to be
//! careful about — every duplicated rule in here has cost a phase — so the rule
//! is written once and the other two call it.
//!
//! # Why it is written rather than configured
//!
//! Tantivy's `SimpleTokenizer` splits on anything that is not alphanumeric. For
//! English that is right. For Chinese it is a disaster of a particular kind: a
//! whole run of Han characters is ONE token, so `春天柳树` is a single word that
//! matches only a query spelling it identically, and `柳树` — the phrase a
//! reader would actually type — matches nothing at all. **Unsearchable, with no
//! error anywhere**, which is this repository's most-repeated defect shape.
//!
//! # Bigrams, and why not a dictionary
//!
//! A CJK run is emitted as OVERLAPPING BIGRAMS: `春天柳树` becomes `春天`,
//! `天柳`, `柳树`. A query is tokenized the same way, so `柳树` is one term and
//! matches; `春天柳树` is three terms in a row and matches as a phrase. This is
//! what Lucene's `CJKBigramFilter` does and what Elasticsearch's `cjk` analyzer
//! is.
//!
//! The alternative the phase plan named was `lindera`, a dictionary segmenter.
//! It was not taken, and the reason is measured rather than aesthetic:
//!
//!  - **It ships no dictionary.** One has to be chosen, pinned and carried —
//!    tens of megabytes of third-party data in a binary whose whole voices story
//!    is *nothing ships in the bundle but code*.
//!  - **This shelf has no Chinese books.** 1 959 EPUBs, 1 872 `en`, 62 `en-US`,
//!    5 `en-GB`, one `es`, one `ar-SA`, 15 undeclared, and **zero `zh`**. A
//!    corpus that cannot tell a good segmenter from a useless one cannot justify
//!    choosing one, and the phase plan says so in as many words.
//!  - **Bigrams cannot be WRONG, only coarse.** A dictionary segmenter that
//!    mis-segments makes a passage unfindable; bigrams over-generate slightly
//!    and find everything. For *find this in my books*, recall is the property
//!    that matters.
//!
//! ⚠️ **AND THIS IS A DECISION A TOKENIZER CHANGE CAN REVISIT CHEAPLY**, which
//! is the whole reason `text/` is retained beside `index/`: swapping this
//! function costs a posting rebuild and reopens no book.
//!
//! # What it deliberately does NOT do
//!
//! **No stemming.** A stemmer is pinned to one language and this index is built
//! from whatever is on the shelf. It also changes what a query MEANS: a reader
//! typing `whale` being shown `whales` is right for a web search and wrong for
//! *find this in my books*, where the reader is looking for words they remember
//! reading.
//!
//! **No stop words.** `"the whale"` is the commonest phrase query in an English
//! library and dropping `the` makes it unanswerable.
//!
//! **Case IS folded**, and that is the one place this differs from
//! `reanchor.ts`'s canonical form, which deliberately keeps case because *"case
//! is meaningful in a quote"*. The two are answering different questions: the
//! resolver is checking that a quote is THE SAME TEXT, where `US` and `us` are
//! not; a search field is asking what a reader meant, where they are. The quote
//! this plugin hands back is a slice of the ORIGINAL canonical text — case and
//! all — so the resolver still gets what it needs.

/// The typography the canonical form folds, applied to a QUERY.
///
/// ⚠️ **THE INDEX HOLDS CANONICAL TEXT AND THE QUERY ARRIVED RAW, SO A READER
/// WHO PASTED THE BOOK'S OWN SPELLING FOUND NOTHING.** `reanchor.ts` folds
/// curly quotes to straight and drops soft hyphens before a word is ever
/// indexed — so `don't` with a curly apostrophe is indexed as `don't` with a
/// straight one, ONE token. Tokenizing the raw query splits the curly form into
/// `don` and `t`, two terms, neither of which the index has in that
/// arrangement. Copying a phrase out of the book and searching for it is the
/// most natural thing a reader does, and it silently failed. Found by an
/// independent audit.
///
/// ⚠️ **AND IT IS A SUBSET OF THE CANONICAL FOLD, NOT A COPY OF IT.** The full
/// walk is `indexText`'s and lives in TypeScript; what a QUERY needs is only the
/// character-level part — the quote and dash folds and the soft hyphen — because
/// whitespace and block edges are already separators to this tokenizer. Spelled
/// here rather than shared because the other half of that walk is a DOM walk,
/// and a Rust copy of it is the third implementation this phase exists to
/// refuse.
#[must_use]
pub fn fold_query(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            /* Dropped outright — a hyphenation point is a fact about a line
             * break, and `indexText` drops it before indexing. */
            '\u{00ad}' => None,
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' => Some('\''),
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' => Some('"'),
            '\u{2013}' | '\u{2012}' | '\u{2015}' => Some('\u{2014}'),
            _ => Some(c),
        })
        .collect()
}

/// A word, and where it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    /// The token's text, folded for matching.
    pub text: String,
    /// Where the token's SOURCE sits in the input, in bytes.
    pub start: usize,
    pub end: usize,
    /// Its position in the stream, counting from 0. Consecutive positions are
    /// what makes a phrase query mean "next to each other".
    pub position: usize,
}

/// Whether a character belongs to a script written without spaces between
/// words, so that a run of them has to be broken up by shape rather than by
/// separator.
///
/// The ranges are the ones Lucene's CJK analyzer covers, spelled out rather than
/// reached for through a Unicode-property crate: this is a closed list that has
/// not moved in twenty years, and a dependency for it would be a dependency in
/// the hot loop of every indexing pass.
#[must_use]
pub fn is_cjk(c: char) -> bool {
    matches!(u32::from(c),
        0x3040..=0x309F      // Hiragana
        | 0x30A0..=0x30FF    // Katakana
        | 0x3400..=0x4DBF    // CJK Extension A
        | 0x4E00..=0x9FFF    // CJK Unified Ideographs
        | 0xF900..=0xFAFF    // CJK Compatibility Ideographs
        | 0xAC00..=0xD7AF    // Hangul syllables
        | 0x1100..=0x11FF    // Hangul Jamo
        | 0x2_0000..=0x2_A6DF // CJK Extension B
    )
}

/// Whether a character may be part of a word in a spaced script.
///
/// `'` is included so `don't` is one word rather than two. A trailing one is
/// trimmed below, so `'tis` keeps its apostrophe and `readers'` does not grow a
/// dangling token.
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '\''
}

/// The longest a single token may be.
///
/// ⚠️ **A BOUND, BECAUSE THE INPUT IS A BOOK SOMEBODY ELSE MADE.** An EPUB can
/// carry a base64 data URI as text; unbounded, one such run becomes a single
/// term of several megabytes in the dictionary. Truncating rather than dropping
/// keeps the prefix findable.
const MAX_TOKEN: usize = 64;

/// Every token in `text`, in order.
///
/// ⚠️ **`start`/`end` ARE BYTES INTO `text`, AND NOTHING SHOWS THEM TO THE FRONT
/// END.** They exist so [`crate::passage`] can cut an exact quote out of the
/// same string; the conversion to the unit the interface counts in happens once,
/// at the wire, in `commands.rs`. Mixing the two units is the defect this
/// separation exists to prevent.
#[must_use]
pub fn tokenize(text: &str) -> Vec<Token> {
    let mut out: Vec<Token> = Vec::new();
    let mut position = 0usize;
    let bytes = text.as_bytes();
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if is_cjk(c) {
            /* THE WHOLE RUN AT ONCE. Walking it character by character and
             * peeking needs a flag to tell the LAST character of a long run from
             * a run of ONE — two cases that look identical from inside the loop
             * — and the first version of this carried exactly that flag and got
             * it wrong. Taking the run first makes the two cases a length.
             */
            let start = at;
            let mut end = at + c.len_utf8();
            let mut in_run = 1usize;
            while let Some(&(next_at, next)) = chars.peek() {
                if !is_cjk(next) {
                    break;
                }
                end = next_at + next.len_utf8();
                in_run += 1;
                chars.next();
            }
            if in_run == 1 {
                /* A RUN OF ONE HAS NO BIGRAM TO BE, so it is itself.
                 *
                 * ⚠️ **AND THE LAST CHARACTER OF A LONGER RUN IS NOT ALSO
                 * EMITTED ALONE.** It would make `树` findable at the end of
                 * `春天柳树` and nowhere in the middle of a run — a rule that
                 * holds in one position and not another, which is the shape this
                 * repository keeps paying for. What a lone character costs is
                 * named on the query side instead:
                 * [`crate::passage::parse_query`] refuses a one-character CJK
                 * term rather than answering it sporadically.
                 */
                out.push(Token {
                    text: text[start..end].to_lowercase(),
                    start,
                    end,
                    position,
                });
                position += 1;
                continue;
            }
            let run = &text[start..end];
            let mut walk = run.char_indices().peekable();
            while let Some((off, _)) = walk.next() {
                let Some(&(next_off, next_char)) = walk.peek() else {
                    break;
                };
                let from = start + off;
                let to = start + next_off + next_char.len_utf8();
                out.push(Token {
                    text: text[from..to].to_lowercase(),
                    start: from,
                    end: to,
                    position,
                });
                position += 1;
            }
            continue;
        }
        if !is_word(c) {
            continue;
        }
        /* A RUN OF WORD CHARACTERS, stopping at the first CJK one so a mixed
         * `Paper书` is two tokens rather than one unsearchable blob. */
        let mut end = at + c.len_utf8();
        while let Some(&(next_at, next)) = chars.peek() {
            if !is_word(next) || is_cjk(next) {
                break;
            }
            end = next_at + next.len_utf8();
            chars.next();
        }
        /* A LEADING OR TRAILING APOSTROPHE IS NOT PART OF THE WORD. `’` is
         * already folded to `'` by the canonical form this runs over, so one
         * rule covers both spellings. */
        let mut from = at;
        while from < end && bytes[from] == b'\'' {
            from += 1;
        }
        while end > from && bytes[end - 1] == b'\'' {
            end -= 1;
        }
        if from == end {
            continue;
        }
        let mut word = text[from..end].to_lowercase();
        if word.len() > MAX_TOKEN {
            /* On a CHARACTER boundary: slicing bytes would panic mid-codepoint,
             * and a book is not obliged to be ASCII. */
            let cut = word
                .char_indices()
                .take_while(|(i, c)| i + c.len_utf8() <= MAX_TOKEN)
                .last()
                .map_or(0, |(i, c)| i + c.len_utf8());
            word.truncate(cut);
            if word.is_empty() {
                continue;
            }
        }
        out.push(Token {
            text: word,
            start: from,
            end,
            position,
        });
        position += 1;
    }
    out
}

/// Just the token texts — what the query side needs.
#[must_use]
pub fn terms(text: &str) -> Vec<String> {
    tokenize(text).into_iter().map(|one| one.text).collect()
}

/// The name this analysis is registered under in the index.
///
/// ⚠️ **IT CARRIES A VERSION, AND THAT IS THE MIGRATION HANDLE.** An index built
/// with `paper/1` and searched with `paper/2` would answer nonsense quietly —
/// the terms simply would not line up. [`crate::state`] records which analysis
/// wrote the postings, and a mismatch triggers a rebuild FROM `text/` rather
/// than a re-extraction. Bump this whenever [`tokenize`] changes what it emits.
pub const ANALYSIS: &str = "paper/1";

#[cfg(test)]
mod tests;
