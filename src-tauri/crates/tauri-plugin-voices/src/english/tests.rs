//! What the front end does with real sentences.

use std::collections::HashMap;

use super::lexicon::Lexicon;
use super::{normalise, FrontEnd, Piece};

/// A lexicon of exactly the words these tests use, so a rule is tested rather
/// than the 183 000 answers that would otherwise hide it.
fn front_end() -> FrontEnd {
    let gold: HashMap<String, String> = [
        ("the", "ði"),
        ("quick", "kwˈɪk"),
        ("dog", "dˈɔɡ"),
        ("student", "stˈudənt"),
        ("policy", "pˈɑlɪsi"),
        ("box", "bˈɑks"),
        ("originate", "ɔɹˈɪʤɪnˌAt"),
        ("make", "mˈAk"),
        ("run", "ɹˈʌn"),
        ("wait", "wˈAt"),
        ("percent", "pəɹsˈɛnt"),
        ("mister", "mˈɪstəɹ"),
        ("smith", "smˈɪθ"),
        ("nineteen", "nˈIntˈin"),
        ("eighty", "ˈAɾi"),
        ("eighties", "ˈAɾiz"),
        ("twenty", "twˈɛnti"),
        ("five", "fˈIv"),
        ("second", "sˈɛkənd"),
        ("one", "wˈʌn"),
        ("hundred", "hˈʌndɹɪd"),
        ("eight", "ˈAt"),
        ("book", "bˈʊk"),
        ("read", "ɹˈid"),
        ("o", "ˈO"),
        ("k", "kˈA"),
        ("r", "ˈɑɹ"),
    ]
    .into_iter()
    .map(|(w, p)| (w.to_owned(), p.to_owned()))
    .collect();
    FrontEnd::new(Lexicon::from_parts(gold, HashMap::new(), HashMap::new()))
}

fn said(text: &str) -> String {
    front_end().phonemise(text).phonemes
}

#[test]
fn a_plain_sentence_becomes_phonemes_with_its_punctuation() {
    let out = front_end().phonemise("The quick dog.");
    assert_eq!(out.phonemes, "ði kwˈɪk dˈɔɡ.");
    assert!(out.unknown.is_empty());
    assert_eq!(out.words.len(), 3);
}

#[test]
fn each_word_knows_where_it_sits_in_the_text_and_in_the_sounds() {
    let text = "The quick dog.";
    let out = front_end().phonemise(text);
    let first = &out.words[0];
    assert_eq!((first.source_start, first.source_len), (0, 3), "`The`");
    let first_sounds: String = out.phonemes.chars().take(first.phoneme_len).collect();
    assert_eq!(first_sounds, "ði");
    let third = &out.words[2];
    assert_eq!((third.source_start, third.source_len), (10, 3), "`dog`");
    let sounds: String = out.phonemes.chars().skip(third.phoneme_start).take(third.phoneme_len).collect();
    assert_eq!(sounds, "dˈɔɡ");
}

#[test]
fn source_offsets_are_utf16_because_the_highlight_is_drawn_from_javascript() {
    // An emoji is two UTF-16 code units and one Rust char: a highlight placed by
    // char index would sit one place to the left of every word after it.
    let text = "🙂 the dog";
    let out = front_end().phonemise(text);
    assert_eq!(out.words[0].source_start, 3, "`the` after a surrogate pair and a space");
    assert_eq!(text.encode_utf16().skip(3).take(3).collect::<Vec<_>>(), "the".encode_utf16().collect::<Vec<_>>());
}

#[test]
fn inflected_words_are_built_from_their_stems() {
    // None of these four is in the lexicon; all four of their stems are.
    assert_eq!(said("students"), "stˈudənts", "an unvoiced /t/ takes /s/, not /z/");
    assert_eq!(said("policies"), "pˈɑlɪsiz");
    assert_eq!(said("boxes"), "bˈɑksᵻz");
    assert_eq!(said("originated"), "ɔɹˈɪʤɪnˌAɾᵻd");
    assert_eq!(said("making"), "mˈAkɪŋ");
    assert_eq!(said("running"), "ɹˈʌnɪŋ");
}

#[test]
fn numbers_are_read_rather_than_spelled_out_letter_by_letter() {
    assert_eq!(said("128"), "wˈʌn hˈʌndɹɪd twˈɛnti ˈAt");
    assert_eq!(said("1980"), "nˈIntˈin ˈAɾi");
    assert_eq!(said("the 1980s"), "ði nˈIntˈin ˈAɾiz");
    assert_eq!(said("2nd"), "sˈɛkənd");
    assert_eq!(said("20%"), "twˈɛnti pəɹsˈɛnt");
}

#[test]
fn a_number_and_its_words_point_back_at_the_whole_number() {
    let out = front_end().phonemise("128 books");
    // Four words are spoken for `128`, and every one of them is that number.
    for word in out.words.iter().take(4) {
        assert_eq!((word.source_start, word.source_len), (0, 3));
    }
    assert_eq!(out.words[4].source_start, 4, "`books` starts after the space");
}

#[test]
fn an_abbreviation_is_said_as_the_word_it_stands_for() {
    let out = front_end().phonemise("Mr. Smith");
    assert_eq!(out.phonemes, "mˈɪstəɹ smˈɪθ");
    assert_eq!(out.words[0].source_len, 3, "`Mr.` including its full stop");
    assert!(
        !out.phonemes.contains('.'),
        "the stop belongs to the abbreviation, not to the end of a sentence"
    );
}

#[test]
fn an_acronym_is_spelled_and_an_unknown_word_is_not() {
    let out = front_end().phonemise("OKR");
    assert_eq!(out.phonemes, "ˈO kˈA ˈɑɹ");
    // A lower-case word nothing knows is left unsaid and reported, never spelled.
    let out = front_end().phonemise("bastiat");
    assert!(out.phonemes.is_empty());
    assert_eq!(out.unknown, vec!["bastiat".to_owned()]);
}

#[test]
fn a_web_address_is_passed_over() {
    let out = front_end().phonemise("the dog https://example.com/a/b the dog");
    assert_eq!(out.phonemes, "ði dˈɔɡ ði dˈɔɡ");
    assert!(out.unknown.is_empty(), "an address is skipped, not reported as a word");
}

#[test]
fn a_symbol_is_named() {
    let pieces = normalise("50% & π");
    let words: Vec<String> = pieces
        .iter()
        .filter_map(|p| match p {
            Piece::Word(w) => Some(w.say.clone()),
            Piece::Punctuation(..) => None,
        })
        .collect();
    assert_eq!(words, vec!["fifty", "percent", "and", "pi"]);
}

#[test]
fn what_it_cannot_say_it_reports_rather_than_guessing() {
    let out = front_end().phonemise("The Kahneman dog");
    assert_eq!(out.phonemes, "ði dˈɔɡ", "the sentence carries on");
    assert_eq!(out.unknown, vec!["Kahneman".to_owned()]);
    assert_eq!(out.words.len(), 2, "and the unknown word claims no sounds");
}

#[test]
fn every_symbol_it_emits_is_one_kokoro_can_say() {
    // misaki's American alphabet, which is what this front end may emit, plus
    // the punctuation Kokoro has tokens for.
    let vocab: std::collections::HashSet<char> =
        "AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔ,.!?;:—…\"() ".chars().collect();
    let out = front_end()
        .phonemise("The quick dog, 128 boxes; Mr. Smith read 1980s policies — 20% (OKR)…");
    assert!(!out.phonemes.is_empty());
    for c in out.phonemes.chars() {
        assert!(vocab.contains(&c), "{c:?} is not in Kokoro's vocabulary");
    }
}

#[test]
fn punctuation_is_kept_where_kokoro_knows_it_and_dropped_where_it_does_not() {
    assert_eq!(said("the dog, the dog."), "ði dˈɔɡ, ði dˈɔɡ.");
    assert_eq!(said("the “dog”"), "ði \"dˈɔɡ\"", "curly quotes become the straight ones");
    assert_eq!(said("the dog–the dog"), "ði dˈɔɡ—ði dˈɔɡ", "an en dash becomes the em dash");
    assert_eq!(said("the/dog"), "ði dˈɔɡ", "a slash has no sound and no token");
}
