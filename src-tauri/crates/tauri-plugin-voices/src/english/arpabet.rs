//! CMUdict speaks ARPAbet; Kokoro speaks misaki's alphabet. This is the table
//! between them, and it is a table rather than a guess: every ARPAbet symbol is
//! named here, so a symbol this does not know makes the whole word fall through
//! to the next source instead of being silently dropped.
//!
//! That last part is the v1.1 lesson in miniature. Kokoro v1.1 met a phoneme it
//! did not have and **skipped it**, four to seven times a passage, and the audio
//! sounded almost right — *workers* without its middle. A mapping that answers
//! partially is the same defect, so this one answers wholly or not at all.
//!
//! # Stress
//!
//! ARPAbet marks stress on the vowel (`AH0`, `AH1`, `AH2`); misaki writes it
//! before the syllable (`ˈ`, `ˌ`). Primary and secondary are kept, and `0` is
//! unstressed — which is why `AH0` is `ə` and `AH1` is `ʌ`, two different
//! sounds in CMUdict's own scheme.

/// The vowels, by stress: (unstressed, stressed).
const VOWELS: &[(&str, &str, &str)] = &[
    // symbol, unstressed reading, stressed reading
    ("AA", "ɑ", "ɑ"),
    ("AE", "æ", "æ"),
    ("AH", "ə", "ʌ"),
    ("AO", "ɔ", "ɔ"),
    ("AW", "W", "W"),
    ("AY", "I", "I"),
    ("EH", "ɛ", "ɛ"),
    ("ER", "əɹ", "ɜɹ"),
    ("EY", "A", "A"),
    ("IH", "ɪ", "ɪ"),
    ("IY", "i", "i"),
    ("OW", "O", "O"),
    ("OY", "Y", "Y"),
    ("UH", "ʊ", "ʊ"),
    ("UW", "u", "u"),
];

/// The consonants, which carry no stress.
const CONSONANTS: &[(&str, &str)] = &[
    ("B", "b"),
    ("CH", "ʧ"),
    ("D", "d"),
    ("DH", "ð"),
    ("F", "f"),
    ("G", "ɡ"),
    ("HH", "h"),
    ("JH", "ʤ"),
    ("K", "k"),
    ("L", "l"),
    ("M", "m"),
    ("N", "n"),
    ("NG", "ŋ"),
    ("P", "p"),
    ("R", "ɹ"),
    ("S", "s"),
    ("SH", "ʃ"),
    ("T", "t"),
    ("TH", "θ"),
    ("V", "v"),
    ("W", "w"),
    ("Y", "j"),
    ("Z", "z"),
    ("ZH", "ʒ"),
];

/// One ARPAbet word — `"AH0 B AW1 T"` — in Kokoro's alphabet, or `None` if any
/// symbol is unknown.
///
/// Whole or nothing: see the module header.
#[must_use]
pub fn to_kokoro(arpabet: &str) -> Option<String> {
    let mut out = String::new();
    for symbol in arpabet.split_whitespace() {
        let (base, stress) = split_stress(symbol);
        if let Some((_, unstressed, stressed)) = VOWELS.iter().find(|(s, _, _)| *s == base) {
            match stress {
                Some('1') => {
                    out.push('ˈ');
                    out.push_str(stressed);
                }
                Some('2') => {
                    out.push('ˌ');
                    out.push_str(stressed);
                }
                _ => out.push_str(unstressed),
            }
        } else if let Some((_, reading)) = CONSONANTS.iter().find(|(s, _)| *s == base) {
            out.push_str(reading);
        } else {
            return None;
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `AH0` into `("AH", Some('0'))`, `B` into `("B", None)`.
fn split_stress(symbol: &str) -> (&str, Option<char>) {
    match symbol.chars().last() {
        Some(last @ ('0' | '1' | '2')) => (&symbol[..symbol.len() - 1], Some(last)),
        _ => (symbol, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_maps_symbol_by_symbol() {
        // CMUdict: about  AH0 B AW1 T
        assert_eq!(to_kokoro("AH0 B AW1 T").as_deref(), Some("əbˈWt"));
        // paul  P AO1 L
        assert_eq!(to_kokoro("P AO1 L").as_deref(), Some("pˈɔl"));
        // harvard  HH AA1 R V ER0 D
        assert_eq!(to_kokoro("HH AA1 R V ER0 D").as_deref(), Some("hˈɑɹvəɹd"));
    }

    #[test]
    fn stress_is_carried_and_the_unstressed_vowel_is_a_different_sound() {
        assert_eq!(to_kokoro("AH1").as_deref(), Some("ˈʌ"));
        assert_eq!(to_kokoro("AH0").as_deref(), Some("ə"));
        assert_eq!(to_kokoro("AH2").as_deref(), Some("ˌʌ"));
    }

    #[test]
    fn an_unknown_symbol_drops_the_whole_word_rather_than_part_of_it() {
        assert_eq!(
            to_kokoro("P AO1 QQ"),
            None,
            "a word missing a sound is worse than no word"
        );
        assert_eq!(to_kokoro(""), None);
    }

    #[test]
    fn every_symbol_it_emits_is_one_kokoro_knows() {
        // The vocabulary Kokoro v1.0 ships, as measured from its tokenizer.
        let vocab: std::collections::HashSet<char> =
            "AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔ"
                .chars()
                .collect();
        for (symbol, unstressed, stressed) in VOWELS {
            for reading in [unstressed, stressed] {
                for c in reading.chars() {
                    assert!(
                        vocab.contains(&c),
                        "{symbol} emits {c}, which Kokoro cannot say"
                    );
                }
            }
        }
        for (symbol, reading) in CONSONANTS {
            for c in reading.chars() {
                assert!(
                    vocab.contains(&c),
                    "{symbol} emits {c}, which Kokoro cannot say"
                );
            }
        }
    }
}
