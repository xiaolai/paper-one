//! Turning English text into the sounds Kokoro speaks — without espeak-ng.
//!
//! Six stages, in the order the coverage was measured over 5 M words of the
//! owner's own library:
//!
//! | stage | what it answers |
//! |---|---|
//! | the normaliser here | numbers (3.3 % of tokens), abbreviations, symbols, web addresses |
//! | [`lexicon`], misaki gold and silver | 90 % of tokens outright |
//! | [`endings`] | another 3.5 %: plurals, past tenses, participles |
//! | [`lexicon`], CMUdict through [`arpabet`] | another 1.5 %, mostly names |
//! | spelling an acronym out | 0.2 % |
//! | a G2P model | the last ~1 %, two thirds of it rare names — **not yet wired** |
//!
//! # Every word keeps its place in the text
//!
//! The reason this is one pipeline rather than a function that returns a string:
//! the reader's follow-along needs to know which word is being spoken, and
//! Kokoro answers with a duration per PHONEME. So each spoken word records where
//! its phonemes start and how long they are, beside where the word sits in the
//! original text — in UTF-16 offsets, because that is what a JavaScript string
//! index is and the highlight is drawn from JavaScript.
//!
//! # What it does when it does not know
//!
//! It says so. An unknown word is collected in [`Phonemised::unknown`] and
//! contributes no phonemes, so a caller can decide — the G2P model, spelling it,
//! or leaving it out. What it must never do is emit a symbol Kokoro cannot say:
//! v1.1 met one, **skipped it silently**, and *workers* lost its middle four to
//! seven times a passage.

pub mod arpabet;
pub mod endings;
pub mod lexicon;
pub mod numbers;

use lexicon::Lexicon;

/// Which side a mark leans on. A comma belongs to the word before it; an
/// opening bracket to the word after; a dash to both, because `dog—the` is one
/// run of sound and `dog — the` is two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leans {
    Left,
    Right,
    Both,
}

/// Punctuation Kokoro has a token for, what Paper writes it as, and which way it
/// leans.
const PUNCTUATION: &[(char, char, Leans)] = &[
    (',', ',', Leans::Left),
    ('.', '.', Leans::Left),
    ('!', '!', Leans::Left),
    ('?', '?', Leans::Left),
    (';', ';', Leans::Left),
    (':', ':', Leans::Left),
    ('—', '—', Leans::Both),
    ('–', '—', Leans::Both),
    ('…', '…', Leans::Left),
    ('“', '"', Leans::Right),
    ('”', '"', Leans::Left),
    ('(', '(', Leans::Right),
    (')', ')', Leans::Left),
];

/// Words a reader says rather than spells. Small and defensible: each one is
/// unambiguous in a book, which is why `No.` (number or no) and `St.` after a
/// name (street) are not here.
const ABBREVIATIONS: &[(&str, &str)] = &[
    ("mr", "mister"),
    ("mrs", "missus"),
    ("ms", "miz"),
    ("dr", "doctor"),
    ("prof", "professor"),
    ("st", "saint"),
    ("vs", "versus"),
    ("etc", "et cetera"),
    ("e.g", "for example"),
    ("i.e", "that is"),
    ("pp", "pages"),
    ("vol", "volume"),
    ("ed", "editor"),
    ("cf", "compare"),
    ("approx", "approximately"),
];

/// Symbols a reader says, including the Greek letters a technical book uses.
const SYMBOLS: &[(char, &str)] = &[
    ('%', "percent"),
    ('&', "and"),
    ('+', "plus"),
    ('=', "equals"),
    ('@', "at"),
    ('°', "degrees"),
    ('§', "section"),
    ('©', "copyright"),
    ('α', "alpha"),
    ('β', "beta"),
    ('γ', "gamma"),
    ('δ', "delta"),
    ('Δ', "delta"),
    ('π', "pi"),
    ('σ', "sigma"),
    ('Σ', "sigma"),
    ('μ', "mu"),
    ('λ', "lambda"),
    ('θ', "theta"),
    ('φ', "phi"),
    ('ϕ', "phi"),
    ('Ω', "omega"),
    ('ω', "omega"),
];

/// Currencies, and what one of them is called.
const CURRENCIES: &[(char, &str, &str)] = &[
    ('$', "dollar", "dollars"),
    ('£', "pound", "pounds"),
    ('€', "euro", "euros"),
];

/// A word to say, and where it came from in the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spoken {
    /// The word as it will be looked up — already normalised.
    pub say: String,
    /// Where it sits in the original text, in UTF-16 code units.
    pub source_start: usize,
    pub source_len: usize,
}

/// One word, placed both in the text and in the phoneme string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpokenWord {
    pub source_start: usize,
    pub source_len: usize,
    /// Offset into [`Phonemised::phonemes`], in characters — which is also the
    /// model's token index, since Kokoro tokenises one id per character.
    pub phoneme_start: usize,
    pub phoneme_len: usize,
}

/// What the front end makes of a sentence.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Phonemised {
    /// What the model is given.
    pub phonemes: String,
    /// Each word, in the order spoken.
    pub words: Vec<SpokenWord>,
    /// Words nothing could say. They contribute no sound — see the header.
    pub unknown: Vec<String>,
}

/// The English front end: a lexicon, the rules, and the text handling around
/// them.
#[derive(Debug)]
pub struct FrontEnd {
    lexicon: Lexicon,
}

impl FrontEnd {
    #[must_use]
    pub fn new(lexicon: Lexicon) -> Self {
        Self { lexicon }
    }

    /// Read a pack's lexicon directory.
    ///
    /// # Errors
    /// The I/O failure, or a lexicon file that is not the shape expected.
    pub fn load(lexicon_dir: &std::path::Path) -> std::io::Result<Self> {
        Ok(Self::new(Lexicon::load(lexicon_dir)?))
    }

    /// The sounds for one piece of text, with every word placed.
    #[must_use]
    pub fn phonemise(&self, text: &str) -> Phonemised {
        let mut out = Phonemised::default();
        // Whether the next thing written should be preceded by a space. A mark
        // that leans right — an opening quote, a bracket — takes the space
        // before itself instead, so `the "dog"` is not `the " dog "`.
        let mut space_before_next = false;
        for piece in normalise(text) {
            match piece {
                Piece::Punctuation(mark, leans) => {
                    if matches!(leans, Leans::Right) && !out.phonemes.is_empty() {
                        out.phonemes.push(' ');
                    }
                    out.phonemes.push(mark);
                    space_before_next = matches!(leans, Leans::Left);
                }
                Piece::Word(spoken) => {
                    self.push_word(&spoken, space_before_next, &mut out);
                    space_before_next = true;
                }
            }
        }
        out.phonemes = out.phonemes.trim().to_owned();
        out
    }

    fn push_word(&self, spoken: &Spoken, space_before: bool, out: &mut Phonemised) {
        let Some(phonemes) = self.say(&spoken.say) else {
            out.unknown.push(spoken.say.clone());
            return;
        };
        if space_before && !out.phonemes.is_empty() && !out.phonemes.ends_with(' ') {
            out.phonemes.push(' ');
        }
        let start = out.phonemes.chars().count();
        out.phonemes.push_str(&phonemes);
        out.words.push(SpokenWord {
            source_start: spoken.source_start,
            source_len: spoken.source_len,
            phoneme_start: start,
            phoneme_len: phonemes.chars().count(),
        });
    }

    /// The sounds for one word: the lexicon, then the ending rules, then
    /// spelling it out if it reads as an acronym.
    #[must_use]
    pub fn say(&self, word: &str) -> Option<String> {
        if let Some(found) = self.lexicon.get(word) {
            return Some(found.phonemes);
        }
        for candidate in endings::candidates(word) {
            if let Some(found) = self.lexicon.get(&candidate.stem) {
                if let Some(built) = candidate.ending.apply(&found.phonemes) {
                    return Some(built);
                }
            }
        }
        self.spelled(word)
    }

    /// An acronym, letter by letter: `OKR` is *oh kay arr*. Only for short
    /// all-capital words — a lowercase unknown is a word, not an initialism, and
    /// spelling it would be worse than saying nothing.
    fn spelled(&self, word: &str) -> Option<String> {
        let letters: Vec<char> = word.chars().filter(|c| c.is_alphabetic()).collect();
        if letters.is_empty() || letters.len() > 5 || !word.chars().all(|c| !c.is_lowercase()) {
            return None;
        }
        let mut out = String::new();
        for letter in letters {
            let name = self.lexicon.get(&letter.to_lowercase().to_string())?;
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&name.phonemes);
        }
        Some(out)
    }
}

/// A normalised piece of text.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Piece {
    Word(Spoken),
    Punctuation(char, Leans),
}

/// Split text into the words a voice says, expanding what is not a word:
/// numbers, symbols, abbreviations, and web addresses (which are dropped).
fn normalise(text: &str) -> Vec<Piece> {
    let chars: Vec<char> = text.chars().collect();
    // UTF-16 offset of each character, so every piece can be placed in the
    // original string the way JavaScript indexes it.
    let mut utf16_at = Vec::with_capacity(chars.len() + 1);
    let mut utf16 = 0usize;
    for c in &chars {
        utf16_at.push(utf16);
        utf16 += c.len_utf16();
    }
    utf16_at.push(utf16);

    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '"' {
            // A straight quote is whichever it is by where it stands: after a
            // space or at the start it opens, otherwise it closes.
            let opens = i == 0 || chars[i - 1].is_whitespace();
            out.push(Piece::Punctuation(
                '"',
                if opens { Leans::Right } else { Leans::Left },
            ));
            i += 1;
            continue;
        }
        if let Some((_, mark, leans)) = PUNCTUATION.iter().find(|(from, _, _)| *from == c) {
            out.push(Piece::Punctuation(*mark, *leans));
            i += 1;
            continue;
        }
        if let Some((_, name)) = SYMBOLS.iter().find(|(from, _)| *from == c) {
            push_words(&mut out, name, utf16_at[i], 1);
            i += 1;
            continue;
        }
        // A web address is dropped whole: it is 0.05 % of a book's tokens and
        // reading one aloud is worse than passing over it.
        if let Some(end) = web_address_at(&chars, i) {
            i = end;
            continue;
        }
        if c.is_ascii_digit() || (CURRENCIES.iter().any(|(sym, _, _)| *sym == c)) {
            if let Some((words, end)) = number_at(&chars, i) {
                push_words(&mut out, &words, utf16_at[i], utf16_at[end] - utf16_at[i]);
                i = end;
                continue;
            }
        }
        if c.is_alphabetic() {
            let start = i;
            while i < chars.len()
                && (chars[i].is_alphanumeric() || chars[i] == '\'' || chars[i] == '’')
            {
                i += 1;
            }
            let raw: String = chars[start..i].iter().collect::<String>().replace('’', "'");
            // `Mr.` and `vol.` keep their full stop in the table, so the stop is
            // consumed here rather than read as the end of a sentence.
            let abbreviated = chars.get(i) == Some(&'.')
                && ABBREVIATIONS
                    .iter()
                    .any(|(from, _)| from.eq_ignore_ascii_case(&raw));
            let end = if abbreviated { i + 1 } else { i };
            if abbreviated {
                i += 1;
            }
            let expanded = ABBREVIATIONS
                .iter()
                .find(|(from, _)| from.eq_ignore_ascii_case(&raw))
                .map_or(raw.clone(), |(_, to)| (*to).to_owned());
            push_words(
                &mut out,
                &expanded,
                utf16_at[start],
                utf16_at[end] - utf16_at[start],
            );
            continue;
        }
        // Anything else — a stray glyph — is passed over rather than guessed at.
        i += 1;
    }
    out
}

/// Add one or more words, all pointing at the same place in the text.
fn push_words(out: &mut Vec<Piece>, words: &str, source_start: usize, source_len: usize) {
    for word in words.split_whitespace() {
        out.push(Piece::Word(Spoken {
            say: word.to_owned(),
            source_start,
            source_len,
        }));
    }
}

/// A number starting at `at`, in words, and where it ends.
fn number_at(chars: &[char], at: usize) -> Option<(String, usize)> {
    let mut i = at;
    let currency = CURRENCIES.iter().find(|(sym, _, _)| *sym == chars[i]);
    if currency.is_some() {
        i += 1;
    }
    let digits_start = i;
    while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == ',') {
        i += 1;
    }
    let whole: String = chars[digits_start..i]
        .iter()
        .filter(|c| c.is_ascii_digit())
        .collect();
    if whole.is_empty() {
        return None;
    }
    let value: u64 = whole.parse().ok()?;

    // A decimal point, if digits follow it.
    let mut fraction = String::new();
    if chars.get(i) == Some(&'.') && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
        let start = i + 1;
        i = start;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        fraction = chars[start..i].iter().collect();
    }

    // `1980s`, `21st`, `2nd`.
    let suffix: String = chars[i..]
        .iter()
        .take(2)
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_lowercase();
    let is_ordinal = ["st", "nd", "rd", "th"].contains(&suffix.as_str());
    let is_decade = suffix == "s" || (suffix.starts_with('s') && suffix.len() == 1);

    let words = if let Some((_, one, many)) = currency {
        let unit = if value == 1 && fraction.is_empty() {
            one
        } else {
            many
        };
        if fraction.is_empty() {
            format!("{} {unit}", numbers::cardinal(value))
        } else {
            format!(
                "{} {unit} {}",
                numbers::cardinal(value),
                numbers::decimal(0, &fraction).replace("zero point ", "")
            )
        }
    } else if !fraction.is_empty() {
        numbers::decimal(value, &fraction)
    } else if is_ordinal {
        i += suffix.len();
        numbers::ordinal(value)
    } else if is_decade && (1100..=2999).contains(&value) && value.is_multiple_of(10) {
        i += 1;
        numbers::decade(value)
    } else if (1100..=2999).contains(&value) && whole.len() == 4 {
        numbers::year(value)
    } else {
        numbers::cardinal(value)
    };
    Some((words, i))
}

/// A web address starting at `at`, and where it ends.
fn web_address_at(chars: &[char], at: usize) -> Option<usize> {
    let rest: String = chars[at..].iter().take(8).collect();
    let lower = rest.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www."))
    {
        return None;
    }
    let mut i = at;
    while i < chars.len() && !chars[i].is_whitespace() {
        i += 1;
    }
    Some(i)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
#[path = "corpus.rs"]
mod corpus;
