//! The words Paper knows how to say, and the order it asks in.
//!
//! Three sources, all permissive, in the order measured on 60 books of the
//! owner's library (about 5 M words per sample):
//!
//! | asked | answers |
//! |---|---|
//! | misaki's gold and silver lexicons (Apache-2.0, 183 561 entries) | 90 % of tokens |
//! | + the ending rules in `endings.rs` | 94 % |
//! | + CMUdict (BSD-2, 135 166 entries), mapped from ARPAbet | 95.5 % |
//!
//! The rest is numbers (a normaliser's job), acronyms, and about 1 % that needs
//! a G2P model — two thirds of it rare names.
//!
//! # Case matters, and it is not a formality
//!
//! misaki's keys are case-sensitive: `Aaron` is in gold and `aaron` in silver,
//! and a word written in capitals may be an acronym rather than a shout. The
//! lookup therefore tries the word as written first and only then folded, which
//! is also what keeps `US` from being read as `us`.
//!
//! # One reading per word, and that is the named limit
//!
//! A gold entry may carry several readings keyed by part of speech — `read` the
//! present tense and `read` the past. Kokoro's own front end runs a tagger;
//! Paper does not, so `DEFAULT` is taken. A heteronym in the wrong tense is the
//! cost, and it is written down rather than hidden.

use std::collections::HashMap;

use crate::english::arpabet;

/// What a lookup found, and where it came from — so a caller can tell a word the
/// lexicon knew from one the rules built, which is what the coverage figures
/// above are counted from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub phonemes: String,
    pub source: Source,
}

/// Which source answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// misaki's gold lexicon — hand-checked.
    Gold,
    /// misaki's silver lexicon.
    Silver,
    /// CMUdict, mapped from ARPAbet to Kokoro's alphabet.
    Cmudict,
}

/// Every word Paper can say without a model.
#[derive(Debug, Default)]
pub struct Lexicon {
    gold: HashMap<String, String>,
    silver: HashMap<String, String>,
    cmudict: HashMap<String, String>,
}

impl Lexicon {
    /// An empty lexicon — every word is unknown. Useful to a test that wants to
    /// exercise one rule without the other 183 000 answers in the way.
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    /// Read misaki's two lexicons and CMUdict from a pack's `lexicon/` directory.
    ///
    /// # Errors
    /// The I/O failure, or a file that is not the shape this expects — never a
    /// silent empty lexicon, which would leave every word unsayable while
    /// looking like a working install.
    pub fn load(dir: &std::path::Path) -> std::io::Result<Self> {
        let gold = read_misaki(&dir.join("us_gold.json"))?;
        let silver = read_misaki(&dir.join("us_silver.json"))?;
        let cmudict = read_cmudict(&dir.join("cmudict.dict"))?;
        Ok(Self { gold, silver, cmudict })
    }

    /// Build one from parsed entries — what the tests use, and what a future
    /// caller with the files already in memory would.
    #[must_use]
    pub fn from_parts(
        gold: HashMap<String, String>,
        silver: HashMap<String, String>,
        cmudict: HashMap<String, String>,
    ) -> Self {
        Self { gold, silver, cmudict }
    }

    /// How many words each source knows, for the Settings section and for a test
    /// that wants to prove a pack's lexicon actually loaded.
    #[must_use]
    pub fn sizes(&self) -> (usize, usize, usize) {
        (self.gold.len(), self.silver.len(), self.cmudict.len())
    }

    /// The reading for `word`, as written first and then folded.
    #[must_use]
    pub fn get(&self, word: &str) -> Option<Found> {
        let lower = word.to_lowercase();
        for (map, source) in [
            (&self.gold, Source::Gold),
            (&self.silver, Source::Silver),
            (&self.cmudict, Source::Cmudict),
        ] {
            if let Some(phonemes) = map.get(word).or_else(|| map.get(&lower)) {
                return Some(Found { phonemes: phonemes.clone(), source });
            }
        }
        None
    }

    /// Whether a word can be said without a model — the question the ending
    /// rules ask of a candidate stem.
    #[must_use]
    pub fn knows(&self, word: &str) -> bool {
        self.get(word).is_some()
    }
}

/// misaki's JSON: a map of word to either a reading or a map of part-of-speech
/// to reading. `DEFAULT` is taken from the second — see the module header.
fn read_misaki(path: &std::path::Path) -> std::io::Result<HashMap<String, String>> {
    let text = std::fs::read_to_string(path)?;
    let raw: HashMap<String, serde_json::Value> = serde_json::from_str(&text)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(raw.into_iter().filter_map(|(word, value)| Some((word, reading_of(&value)?))).collect())
}

/// One reading out of a misaki entry.
fn reading_of(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(map) => map
            .get("DEFAULT")
            .and_then(serde_json::Value::as_str)
            .or_else(|| map.values().find_map(serde_json::Value::as_str))
            .map(std::borrow::ToOwned::to_owned),
        _ => None,
    }
}

/// CMUdict's format: `word  AH0 B AW1 T`, with `word(2)` for later variants,
/// and `#` starting a comment.
fn read_cmudict(path: &std::path::Path) -> std::io::Result<HashMap<String, String>> {
    let text = std::fs::read_to_string(path)?;
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.split(" #").next().unwrap_or(line).trim();
        let Some((word, arpa)) = line.split_once(' ') else { continue };
        // `word(2)` is another way to say the same word; the first wins, which
        // is CMUdict's own most common reading.
        let word = word.split('(').next().unwrap_or(word);
        if word.is_empty() || out.contains_key(word) {
            continue;
        }
        if let Some(phonemes) = arpabet::to_kokoro(arpa.trim()) {
            out.insert(word.to_owned(), phonemes);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lexicon() -> Lexicon {
        Lexicon::from_parts(
            HashMap::from([
                ("Aaron".to_owned(), "ˈɛɹən".to_owned()),
                ("the".to_owned(), "ði".to_owned()),
            ]),
            HashMap::from([("aaron".to_owned(), "ˈɛɹən".to_owned())]),
            HashMap::from([("paul".to_owned(), "pˈɔl".to_owned())]),
        )
    }

    #[test]
    fn a_word_is_looked_up_as_written_before_it_is_folded() {
        let lex = lexicon();
        assert_eq!(lex.get("Aaron").expect("gold").source, Source::Gold);
        assert_eq!(lex.get("the").expect("gold").phonemes, "ði");
        // Folded, `AARON` misses gold — whose key is `Aaron` — and is answered by
        // silver, which is exactly the order misaki intends.
        assert_eq!(lex.get("AARON").expect("folded").source, Source::Silver);
    }

    #[test]
    fn cmudict_answers_what_misaki_does_not() {
        let lex = lexicon();
        let found = lex.get("Paul").expect("cmudict, folded");
        assert_eq!(found.source, Source::Cmudict);
        assert_eq!(found.phonemes, "pˈɔl");
        assert!(lex.knows("paul") && !lex.knows("Bastiat"));
    }

    #[test]
    fn a_misaki_entry_keyed_by_part_of_speech_takes_its_default() {
        let value = serde_json::json!({"DEFAULT": "ɹˈid", "VBD": "ɹˈɛd"});
        assert_eq!(reading_of(&value).as_deref(), Some("ɹˈid"));
        // An entry with readings but no DEFAULT still answers rather than
        // dropping the word: any reading is closer than none.
        let value = serde_json::json!({"VBD": "ɹˈɛd"});
        assert_eq!(reading_of(&value).as_deref(), Some("ɹˈɛd"));
        assert_eq!(reading_of(&serde_json::json!(null)), None);
    }

    #[test]
    fn cmudict_lines_are_read_with_their_variants_and_comments() {
        let dir = std::env::temp_dir().join(format!("paper-lex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch");
        let file = dir.join("cmudict.dict");
        std::fs::write(
            &file,
            "about AH0 B AW1 T\nabout(2) AH0 B AW1\nread R IY1 D # comment\n\n",
        )
        .expect("write");
        let map = read_cmudict(&file).expect("read");
        assert_eq!(map.len(), 2, "a variant is not a second word");
        assert!(map.contains_key("about") && map.contains_key("read"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_lexicon_is_an_error_rather_than_an_empty_one() {
        let missing = std::path::Path::new("/nonexistent/lexicon");
        assert!(
            Lexicon::load(missing).is_err(),
            "an empty lexicon would leave every word unsayable while looking installed"
        );
    }
}
