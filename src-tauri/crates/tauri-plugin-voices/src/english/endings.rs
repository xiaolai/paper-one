//! Plurals, past tenses and participles, built from the stem.
//!
//! The lexicons hold base forms: `student` is there and `students` is not, and
//! measured over 5 M words of real books these three endings are **3.5 % of
//! every token** — the difference between a lexicon that answers 90 % and one
//! that answers 94 %. sherpa-onnx sent all of them to espeak-ng.
//!
//! The rules are misaki's own (`misaki/en.py`, Apache-2.0), ported symbol for
//! symbol, because they are phonology rather than string surgery: the plural of
//! a word ending in an unvoiced sound is /s/ and of a voiced one is /z/, and a
//! reader hears the difference immediately.

/// Vowels and flaps a `t` may lenite after, in American English — misaki's
/// `US_TAUS`.
const US_TAUS: &str = "AIOWYiuæɑəɛɪɹʊʌ";

/// The ending `-s`, on a stem already in phonemes.
///
/// `pets` is /s/, `dogs` is /z/, `buses` is /ᵻz/ — one rule, three answers,
/// decided by the stem's last sound.
#[must_use]
pub fn plural(stem: &str) -> Option<String> {
    let last = stem.chars().last()?;
    Some(match last {
        'p' | 't' | 'k' | 'f' | 'θ' => format!("{stem}s"),
        's' | 'z' | 'ʃ' | 'ʒ' | 'ʧ' | 'ʤ' => format!("{stem}ᵻz"),
        _ => format!("{stem}z"),
    })
}

/// The ending `-ed`.
///
/// `walked` is /t/, `filled` is /d/, `wanted` is /ᵻd/ — and in American English
/// a `t` between vowels becomes a flap, which is why `waited` is `ɾᵻd`.
#[must_use]
pub fn past(stem: &str) -> Option<String> {
    let last = stem.chars().last()?;
    Some(match last {
        'p' | 'k' | 'f' | 'θ' | 'ʃ' | 's' | 'ʧ' => format!("{stem}t"),
        'd' => format!("{stem}ᵻd"),
        't' => {
            let before = stem.chars().rev().nth(1);
            match before {
                Some(before) if US_TAUS.contains(before) => {
                    let mut out: String = stem.chars().collect();
                    out.pop();
                    format!("{out}ɾᵻd")
                }
                _ => format!("{stem}ᵻd"),
            }
        }
        _ => format!("{stem}d"),
    })
}

/// The ending `-ing`, with the same American flap: `waiting` is `ɾɪŋ`.
#[must_use]
pub fn progressive(stem: &str) -> Option<String> {
    let last = stem.chars().last()?;
    if last == 't' {
        if let Some(before) = stem.chars().rev().nth(1) {
            if US_TAUS.contains(before) {
                let mut out: String = stem.chars().collect();
                out.pop();
                return Some(format!("{out}ɾɪŋ"));
            }
        }
    }
    Some(format!("{stem}ɪŋ"))
}

/// The stems a written word could be built from, in the order misaki tries
/// them. The caller asks the lexicon about each and takes the first it knows.
///
/// Returning candidates rather than looking them up keeps this module pure: the
/// rules are phonology and spelling, and the lexicon is somebody else's.
#[must_use]
pub fn candidates(word: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    let lower = word.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let len = chars.len();
    let take = |n: usize| -> String { chars[..n].iter().collect() };

    if len >= 3 && lower.ends_with('s') {
        if !lower.ends_with("ss") {
            out.push(Candidate { stem: take(len - 1), ending: Ending::Plural });
        }
        if lower.ends_with("'s") || (len > 4 && lower.ends_with("es") && !lower.ends_with("ies")) {
            out.push(Candidate { stem: take(len - 2), ending: Ending::Plural });
        }
        if len > 4 && lower.ends_with("ies") {
            out.push(Candidate { stem: format!("{}y", take(len - 3)), ending: Ending::Plural });
        }
    }
    if len >= 4 && lower.ends_with('d') {
        if !lower.ends_with("dd") {
            out.push(Candidate { stem: take(len - 1), ending: Ending::Past });
        }
        if len > 4 && lower.ends_with("ed") && !lower.ends_with("eed") {
            out.push(Candidate { stem: take(len - 2), ending: Ending::Past });
        }
        if len > 4 && lower.ends_with("ied") {
            out.push(Candidate { stem: format!("{}y", take(len - 3)), ending: Ending::Past });
        }
    }
    if len >= 5 && lower.ends_with("ing") {
        if len > 5 {
            out.push(Candidate { stem: take(len - 3), ending: Ending::Progressive });
        }
        out.push(Candidate { stem: format!("{}e", take(len - 3)), ending: Ending::Progressive });
        // `running` from `run`: a doubled consonant before the ending.
        if len > 5 && doubled_before_ing(&chars) {
            out.push(Candidate { stem: take(len - 4), ending: Ending::Progressive });
        }
    }
    out
}

/// `stopped`, `running`, `kicking` — the consonant doubling English spells an
/// ending with. misaki matches `([bcdgklmnprstvxz])\1ing$|cking$`.
fn doubled_before_ing(chars: &[char]) -> bool {
    let len = chars.len();
    if len < 6 {
        return false;
    }
    let (a, b) = (chars[len - 5], chars[len - 4]);
    (a == b && "bcdgklmnprstvxz".contains(a)) || (a == 'c' && b == 'k')
}

/// A stem to ask the lexicon about, and what to build if it answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub stem: String,
    pub ending: Ending,
}

/// Which rule to apply to a stem's phonemes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    Plural,
    Past,
    Progressive,
}

impl Ending {
    /// Build the whole word's phonemes from the stem's.
    #[must_use]
    pub fn apply(self, stem: &str) -> Option<String> {
        match self {
            Self::Plural => plural(stem),
            Self::Past => past(stem),
            Self::Progressive => progressive(stem),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plural_is_voiced_by_the_sound_before_it() {
        assert_eq!(plural("pˈɛt").as_deref(), Some("pˈɛts"), "unvoiced takes /s/");
        assert_eq!(plural("dˈɔɡ").as_deref(), Some("dˈɔɡz"), "voiced takes /z/");
        assert_eq!(plural("bˈʌs").as_deref(), Some("bˈʌsᵻz"), "a sibilant takes a vowel first");
        assert_eq!(plural("ʧˈɜɹʧ").as_deref(), Some("ʧˈɜɹʧᵻz"));
        assert_eq!(plural(""), None);
    }

    #[test]
    fn the_past_is_voiced_by_the_sound_before_it_too() {
        assert_eq!(past("wˈɔk").as_deref(), Some("wˈɔkt"), "unvoiced takes /t/");
        assert_eq!(past("fˈɪl").as_deref(), Some("fˈɪld"), "voiced takes /d/");
        assert_eq!(past("nˈid").as_deref(), Some("nˈidᵻd"), "after /d/ a vowel is needed");
    }

    #[test]
    fn an_american_t_between_vowels_becomes_a_flap() {
        // wait -> waited: the /t/ lenites rather than doubling the vowel.
        assert_eq!(past("wˈAt").as_deref(), Some("wˈAɾᵻd"));
        assert_eq!(progressive("wˈAt").as_deref(), Some("wˈAɾɪŋ"));
        // But not after a consonant: `lifted` keeps its /t/.
        assert_eq!(past("lˈɪft").as_deref(), Some("lˈɪftᵻd"));
        assert_eq!(progressive("lˈɪft").as_deref(), Some("lˈɪftɪŋ"));
    }

    #[test]
    fn a_written_word_offers_the_stems_it_could_be_built_from() {
        let stems = |w: &str| -> Vec<String> { candidates(w).into_iter().map(|c| c.stem).collect() };
        assert!(stems("students").contains(&"student".to_owned()));
        assert!(stems("policies").contains(&"policy".to_owned()));
        assert!(stems("boxes").contains(&"box".to_owned()));
        assert!(stems("originated").contains(&"originate".to_owned()));
        assert!(stems("making").contains(&"make".to_owned()));
        assert!(stems("running").contains(&"run".to_owned()));
        assert!(stems("kicking").contains(&"kick".to_owned()));
        assert!(stems("grove's").contains(&"grove".to_owned()));
    }

    #[test]
    fn a_word_that_only_looks_like_an_ending_offers_no_stem_that_strips_it() {
        // `ss` is not a plural, `eed` is not a past tense, and a short word has
        // no room for either.
        assert!(!candidates("class").iter().any(|c| c.stem == "clas"));
        assert!(!candidates("agreed").iter().any(|c| c.stem == "agre"));
        assert!(candidates("is").is_empty());
        assert!(candidates("sing").is_empty(), "too short to be an -ing form");
    }

    #[test]
    fn every_symbol_these_rules_add_is_one_kokoro_knows() {
        let vocab: std::collections::HashSet<char> =
            "AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔ".chars().collect();
        let built = [
            plural("pˈɛt"), plural("dˈɔɡ"), plural("bˈʌs"),
            past("wˈɔk"), past("fˈɪl"), past("nˈid"), past("wˈAt"),
            progressive("wˈAt"), progressive("lˈɪft"),
        ];
        for word in built.into_iter().flatten() {
            for c in word.chars() {
                assert!(vocab.contains(&c), "{word} contains {c}, which Kokoro cannot say");
            }
        }
    }
}
