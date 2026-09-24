use super::*;

fn words(text: &str) -> Vec<String> {
    terms(text)
}

#[test]
fn an_english_sentence_is_its_words_folded() {
    assert_eq!(
        words("The Whale, and Mr. Smith!"),
        ["the", "whale", "and", "mr", "smith"]
    );
}

#[test]
fn an_apostrophe_inside_a_word_keeps_it_one_word() {
    assert_eq!(words("don't"), ["don't"]);
    // And a possessive does not leave a dangling token.
    assert_eq!(words("readers' books"), ["readers", "books"]);
    assert_eq!(words("'tis"), ["tis"]);
    // A bare apostrophe is no word at all.
    assert_eq!(words("' '"), Vec::<String>::new());
}

#[test]
fn a_cjk_run_becomes_overlapping_bigrams() {
    assert_eq!(words("春天柳树"), ["春天", "天柳", "柳树"]);
}

#[test]
fn the_query_a_reader_would_type_is_a_term_the_index_holds() {
    /* THE WHOLE POINT OF THE BIGRAMS, in one assertion. Under tantivy's own
     * SimpleTokenizer the left side is ONE token `春天柳树`, the right side is
     * ONE token `柳树`, and they do not match — so the passage is unsearchable
     * with nothing reporting a failure. */
    let body = words("春天柳树");
    let query = words("柳树");
    assert_eq!(query.len(), 1);
    assert!(body.contains(&query[0]));
}

#[test]
fn a_run_of_one_character_is_emitted_as_itself() {
    assert_eq!(words("我 is me"), ["我", "is", "me"]);
}

#[test]
fn the_last_character_of_a_longer_run_is_not_emitted_again_alone() {
    /* ⚠️ **THE ASYMMETRY THIS RULE EXISTS TO REFUSE.** Emitting it would make
     * `都` findable at the end of `東京都` and nowhere in the middle of a run —
     * a rule that holds in one position and not another. `parse_query` names
     * the cost instead of the tokenizer hiding it. */
    assert_eq!(words("東京都"), ["東京", "京都"]);
}

#[test]
fn a_mixed_script_word_is_split_at_the_seam() {
    // Not one unsearchable blob: `Paper` stays a word and `书` stays a token.
    assert_eq!(words("Paper书"), ["paper", "书"]);
    assert_eq!(words("书Paper"), ["书", "paper"]);
}

#[test]
fn positions_are_consecutive_so_a_phrase_means_next_to_each_other() {
    let found = tokenize("the great whale");
    assert_eq!(
        found.iter().map(|t| t.position).collect::<Vec<_>>(),
        [0, 1, 2]
    );
    // Punctuation between words does NOT create a gap — it is not a word.
    let punctuated = tokenize("the, great — whale");
    assert_eq!(
        punctuated.iter().map(|t| t.position).collect::<Vec<_>>(),
        [0, 1, 2]
    );
}

#[test]
fn offsets_cut_the_original_text_exactly() {
    let text = "He met Mr. Smith at noon.";
    for token in tokenize(text) {
        assert_eq!(
            text[token.start..token.end].to_lowercase(),
            token.text,
            "the offsets do not cut out the token they describe"
        );
    }
}

#[test]
fn offsets_are_bytes_and_survive_astral_characters() {
    /* ⚠️ **THE UNIT HERE IS BYTES AND IT IS NOT THE WIRE'S UNIT.** An emoji is
     * four bytes, one Rust `char`, and TWO UTF-16 code units. This assertion
     * exists so that a change of unit here fails loudly rather than shifting
     * every quote by however many astral characters preceded it. */
    let text = "a 😀 whale";
    let found = tokenize(text);
    assert_eq!(found.len(), 2);
    assert_eq!(&text[found[1].start..found[1].end], "whale");
    assert_eq!(found[1].start, 1 + 1 + 4 + 1);
}

#[test]
fn an_enormous_run_is_truncated_rather_than_dropped() {
    let long = "x".repeat(MAX_TOKEN * 4);
    let found = tokenize(&long);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].text.len(), MAX_TOKEN);
    /* The SOURCE span still covers the whole run, so a quote cut from it is the
     * text that is really there. Only the term is short. */
    assert_eq!(found[0].end - found[0].start, long.len());
}

#[test]
fn truncation_never_splits_a_character() {
    // 40 three-byte characters = 120 bytes, so the cut lands mid-character
    // unless it is taken on a boundary.
    let long = "é".repeat(MAX_TOKEN);
    let found = tokenize(&long);
    assert_eq!(found.len(), 1);
    assert!(found[0].text.len() <= MAX_TOKEN);
    // It is still valid UTF-8 — `truncate` on a bad boundary would have panicked.
    assert!(found[0].text.chars().all(|c| c == 'é'));
}

#[test]
fn nothing_but_separators_is_no_token_at_all() {
    assert_eq!(words("   ,.;—  "), Vec::<String>::new());
    assert_eq!(words(""), Vec::<String>::new());
}

#[test]
fn the_analysis_name_is_versioned() {
    /* Pinned so that changing what `tokenize` emits without bumping this is a
     * failing test rather than an index that answers nonsense quietly. */
    assert_eq!(ANALYSIS, "paper/1");
}
