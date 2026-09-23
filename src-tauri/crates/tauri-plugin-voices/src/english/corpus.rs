//! The two claims this front end makes, measured against real data.
//!
//! Both need the pack's own lexicons — 183 561 misaki entries and 135 166
//! CMUdict ones — which are downloaded rather than checked in, so both are
//! `#[ignore]`d and read their directory from `PAPER_VOICES_LEXICON`:
//!
//! ```sh
//! PAPER_VOICES_LEXICON=/path/to/lexicon cargo test -p tauri-plugin-voices -- --ignored --nocapture
//! ```
//!
//! A `#[ignore]` here is not a skipped check; it is a check whose input is a
//! 6 MB download. The claims they measure are in the plan's WI-30.3 and in
//! `lexicon.rs`'s header, and neither should be believed without running these.

use std::collections::BTreeMap;

use super::{endings, lexicon::Lexicon, FrontEnd};

/// Where the real lexicons are, if this machine has them.
fn lexicon_dir() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var("PAPER_VOICES_LEXICON").ok()?);
    dir.join("us_gold.json").is_file().then_some(dir)
}

/// The book this is measured on: the opening chapters of *Moby-Dick*, public
/// domain, checked in beside this crate. See `tests/fixtures/README.md`.
fn corpus() -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/moby-dick-opening.txt"),
    )
    .expect("the corpus fixture is checked in beside this crate")
}

#[test]
#[ignore = "needs the pack's lexicons; set PAPER_VOICES_LEXICON"]
fn a_real_book_is_more_than_ninety_nine_percent_sayable() {
    let Some(dir) = lexicon_dir() else {
        panic!("set PAPER_VOICES_LEXICON to a directory holding us_gold.json, us_silver.json and cmudict.dict");
    };
    let front = FrontEnd::load(&dir).expect("the lexicons load");
    let text = corpus();

    // Sentence by sentence, the way the reader will ask for it.
    let mut spoken = 0usize;
    let mut unknown: BTreeMap<String, usize> = BTreeMap::new();
    // Every symbol the front end may emit: misaki's American alphabet and the
    // punctuation Kokoro has tokens for. One outside it is the v1.1 defect —
    // a sound the model cannot say, dropped where nobody hears it go.
    let allowed: std::collections::HashSet<char> =
        "AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔ,.!?;:—…\"() ".chars().collect();
    for line in text.split('\n') {
        let out = front.phonemise(line);
        spoken += out.words.len();
        for c in out.phonemes.chars() {
            assert!(allowed.contains(&c), "{c:?} is outside Kokoro's alphabet, in: {line}");
        }
        for word in out.unknown {
            *unknown.entry(word).or_default() += 1;
        }
    }
    let missed: usize = unknown.values().sum();
    let total = spoken + missed;
    let share = 100.0 * spoken as f64 / total as f64;
    let mut worst: Vec<_> = unknown.iter().collect();
    worst.sort_by_key(|(_, count)| std::cmp::Reverse(**count));
    println!(
        "{spoken} of {total} words said without a model ({share:.2} %); {} distinct unknown words",
        unknown.len()
    );
    println!(
        "  most frequent unknown: {}",
        worst
            .iter()
            .take(20)
            .map(|(word, count)| format!("{word}×{count}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    assert!(
        share >= 99.0,
        "the plan's claim is 99 % of a book's words before the G2P model; this is {share:.2} %"
    );
}

/// The port is held to misaki's own three functions, character for character,
/// by a fixture generated from `misaki/en.py`. This one is NOT ignored: it needs
/// no download, and it is the check that says the rules are misaki's rather than
/// something that resembles them.
#[test]
fn the_ending_rules_are_misakis_own() {
    let text = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/misaki-endings-parity.json"),
    )
    .expect("the parity fixture is checked in beside this crate");
    let fixture: serde_json::Value = serde_json::from_str(&text).expect("parity json");
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() > 1_000, "a fixture this small would measure nothing");
    let mut checked = 0usize;
    for case in cases {
        let stem = case["stem"].as_str().expect("stem");
        for (ending, built) in [
            ("plural", endings::plural(stem)),
            ("past", endings::past(stem)),
            ("progressive", endings::progressive(stem)),
        ] {
            let expected = case[ending].as_str();
            assert_eq!(
                built.as_deref(),
                expected,
                "{ending} of {stem}: misaki says {expected:?}, this port says {built:?}"
            );
            checked += 1;
        }
    }
    println!("{checked} endings match misaki's own rules");
}

/// What the rules and misaki's DICTIONARY say about the same word, which is a
/// different question and has a different answer.
///
/// ⚠️ **THE PLAN ASKED FOR "held-out misaki gold entries come back identical",
/// AND THAT CANNOT BE MET BY ANYTHING — misaki does not meet it either.** Its
/// dictionary and its rules are two sources that disagree on about a fifth of
/// inflected words: `aggravating` is listed as `ˈæɡɹəvˌAtɪŋ` where its own flap
/// rule builds `ˈæɡɹəvˌAɾɪŋ`, `abandoned` is listed with a syllabic `ᵊ` where the
/// rule keeps the `ə`, and words like `acarid` and `alkyd` are not inflections at
/// all but end in the same letters. So this REPORTS the figure rather than
/// asserting a threshold nobody can hold, and the parity test above is what
/// pins the port.
#[test]
#[ignore = "needs the pack's lexicons; set PAPER_VOICES_LEXICON"]
fn how_often_the_rules_and_misakis_dictionary_agree() {
    let Some(dir) = lexicon_dir() else {
        panic!("set PAPER_VOICES_LEXICON to a directory holding us_gold.json, us_silver.json and cmudict.dict");
    };
    let full = Lexicon::load(&dir).expect("the lexicons load");
    let (gold, silver, cmu) = full.sizes();
    println!("gold {gold}, silver {silver}, cmudict {cmu}");

    let text = std::fs::read_to_string(dir.join("us_gold.json")).expect("gold");
    let raw: BTreeMap<String, serde_json::Value> = serde_json::from_str(&text).expect("gold json");
    let mut agreed = 0usize;
    let mut differed: Vec<(String, String, String)> = Vec::new();
    for (word, value) in &raw {
        let Some(expected) = value.as_str() else { continue };
        if &word.to_lowercase() != word {
            continue;
        }
        let Some(built) = endings::candidates(word).into_iter().find_map(|candidate| {
            (candidate.stem != *word)
                .then(|| full.get(&candidate.stem))
                .flatten()
                .and_then(|found| candidate.ending.apply(&found.phonemes))
        }) else {
            continue;
        };
        if built == expected {
            agreed += 1;
        } else {
            differed.push((word.clone(), expected.to_owned(), built));
        }
    }
    let total = agreed + differed.len();
    let share = 100.0 * agreed as f64 / total as f64;
    println!("the rules match misaki's dictionary on {agreed} of {total} inflected entries ({share:.1} %)");
    for (word, expected, built) in differed.iter().take(10) {
        println!("  {word}: dictionary {expected}, rules {built}");
    }
    assert!(total > 1_000, "too few comparable entries to say anything");
}
