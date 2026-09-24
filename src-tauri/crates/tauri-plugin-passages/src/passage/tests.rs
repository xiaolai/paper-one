use super::*;

fn term(word: &str) -> Clause {
    Clause::Term(word.to_owned())
}

fn phrase(words: &[&str]) -> Clause {
    Clause::Phrase(words.iter().map(|w| (*w).to_owned()).collect())
}

fn quotes(text: &str, raw: &str) -> Vec<String> {
    let clauses = parse_query(raw).expect("a legal query");
    passages(text, &clauses, 8)
        .into_iter()
        .map(|one| text[one.start..one.end].to_owned())
        .collect()
}

#[test]
fn a_bare_multi_word_query_is_and_and_not_a_phrase() {
    assert_eq!(
        parse_query("whale ship").expect("a legal query"),
        vec![term("whale"), term("ship")]
    );
}

#[test]
fn quotation_marks_make_a_phrase() {
    assert_eq!(
        parse_query("\"the whale\"").expect("a legal query"),
        vec![phrase(&["the", "whale"])]
    );
}

#[test]
fn a_phrase_and_a_loose_term_can_be_asked_for_together() {
    assert_eq!(
        parse_query("\"the whale\" ship").expect("a legal query"),
        vec![phrase(&["the", "whale"]), term("ship")]
    );
}

#[test]
fn an_unbalanced_quotation_mark_is_refused_by_name() {
    let refused = parse_query("\"the whale").expect_err("unbalanced");
    assert_eq!(refused.kind(), "badQuery");
    assert!(
        refused.to_string().contains("closing"),
        "{refused} should say which half is missing"
    );
}

#[test]
fn a_query_with_no_word_in_it_is_refused_rather_than_answered_empty() {
    /* ⚠️ **"no matches" AND "there was nothing to look for" ARE DIFFERENT
     * ANSWERS.** Reported as the first, a reader retypes a query that can never
     * work. */
    let refused = parse_query("  ,.;  ").expect_err("no words");
    assert_eq!(refused.kind(), "badQuery");
}

#[test]
fn an_empty_phrase_is_ignored_rather_than_making_the_query_unanswerable() {
    assert_eq!(
        parse_query("whale \"\" ship").expect("a legal query"),
        vec![term("whale"), term("ship")]
    );
}

#[test]
fn a_single_word_in_quotes_is_a_term() {
    assert_eq!(
        parse_query("\"whale\"").expect("a legal query"),
        vec![term("whale")]
    );
}

#[test]
fn a_phrase_matches_only_where_the_words_are_adjacent_and_in_order() {
    let text = "The whale was large. The ship saw a whale and then a ship.";
    assert_eq!(quotes(text, "\"whale and\""), ["whale and"]);
    // Reversed, it is nowhere.
    assert!(quotes(text, "\"and whale\"").is_empty());
}

#[test]
fn an_and_query_reports_the_place_the_words_are_near_each_other() {
    let text = "A whale opened the chapter. Many pages later, a ship and a whale together.";
    let found = quotes(text, "whale ship");
    assert_eq!(found.len(), 1);
    assert!(
        found[0].contains("ship") && found[0].contains("whale"),
        "the window should hold both words: {found:?}"
    );
    assert!(
        found[0].len() < 40,
        "it should be the NEAR pair, not the whole chapter: {found:?}"
    );
}

#[test]
fn four_matches_in_a_chapter_are_four_passages() {
    let text = "whale one. whale two. whale three. whale four.";
    let found = quotes(text, "whale");
    assert_eq!(found.len(), 4);
    assert!(found.iter().all(|one| one == "whale"));
}

#[test]
fn a_limit_stops_the_list() {
    let text = "whale whale whale whale whale";
    let clauses = parse_query("whale").expect("a legal query");
    assert_eq!(passages(text, &clauses, 2).len(), 2);
    assert_eq!(passages(text, &clauses, 0).len(), 0);
}

#[test]
fn a_clause_that_is_nowhere_answers_no_passage_rather_than_a_wrong_one() {
    let text = "the whale was large";
    let clauses = parse_query("whale unicorn").expect("a legal query");
    assert!(passages(text, &clauses, 8).is_empty());
}

#[test]
fn a_window_wider_than_a_quote_may_be_is_anchored_on_its_rarest_clause() {
    /* ⚠️ **ANCHORING ON THE FIRST SPAN SHOWED THE READER NONE OF THEIR WORDS,
     * AND IT WAS THE FIRST RESULT IN THE LIBRARY.** Found by looking at the
     * running app on the real shelf (WI-31.8): `the whale` over a book's
     * printed CONTENTS page is an AND of a word occurring fifty times and one
     * occurring once, so the minimal window ran from a `the` near the top to
     * the single `whale` far below — and its first span was a `the`, giving the
     * snippet *"Contents Cover Title Page Copyright Prologue: The Flip…"*. A
     * true hit whose quote held not one word that was typed. */
    let filler = "the word ".repeat(200);
    let text = format!("the opening {filler} whale");
    let found = quotes(&text, "the whale");
    assert_eq!(
        found,
        ["whale"],
        "the rare word is the question; `the` narrows nothing"
    );
}

#[test]
fn a_wide_window_still_answers_when_every_clause_is_equally_rare() {
    /* With nothing to choose between, the first is as good as any — what must
     * not happen is a page-long quote or no hit at all. */
    let filler = "word ".repeat(200);
    let text = format!("whale {filler} ship");
    let found = quotes(&text, "whale ship");
    assert_eq!(found.len(), 1);
    assert!(
        found[0].len() < 20,
        "a page-long 'quote' is no anchor at all: {found:?}"
    );
}

#[test]
fn every_quote_is_a_real_substring_of_the_text() {
    /* ⚠️ **THE PROPERTY THE WHOLE MODULE EXISTS FOR.** A quote the resolver
     * cannot find is a hit that cannot be landed, which the phase plan calls
     * worse than no hit. */
    let text = "He met Mr. Smith at noon. 春天柳树很好看。The whale, again.";
    for query in ["whale", "\"mr smith\"", "柳树", "smith whale"] {
        for quote in quotes(text, query) {
            assert!(
                text.contains(&quote),
                "{quote:?} is not in the text it came from"
            );
        }
    }
}

#[test]
fn a_chinese_query_lands_on_the_characters_a_reader_typed() {
    let text = "从前有一棵柳树，春天柳树发芽了。";
    let found = quotes(text, "柳树");
    assert_eq!(found.len(), 2);
    assert!(found.iter().all(|one| one == "柳树"), "{found:?}");
}

#[test]
fn the_context_either_side_touches_the_quote_exactly() {
    let text = "one two three whale four five six";
    let clauses = parse_query("whale").expect("a legal query");
    let one = &passages(text, &clauses, 1)[0];
    let before = prefix_of(text, one.start);
    let after = suffix_of(text, one.end);
    assert_eq!(
        format!("{before}{}{after}", &text[one.start..one.end]),
        text,
        "prefix and suffix must abut the quote with nothing between"
    );
}

#[test]
fn the_context_is_bounded_and_stops_at_the_edges() {
    let long = "x".repeat(500);
    let text = format!("{long} whale {long}");
    let clauses = parse_query("whale").expect("a legal query");
    let one = &passages(&text, &clauses, 1)[0];
    assert_eq!(prefix_of(&text, one.start).chars().count(), CONTEXT_CHARS);
    assert_eq!(suffix_of(&text, one.end).chars().count(), CONTEXT_CHARS);
    // At the very edges there is simply less, rather than a panic.
    assert_eq!(prefix_of("whale", 0), "");
    assert_eq!(suffix_of("whale", 5), "");
}

#[test]
fn the_context_never_splits_a_character() {
    let text = format!("{}whale", "春".repeat(100));
    let clauses = parse_query("whale").expect("a legal query");
    let one = &passages(&text, &clauses, 1)[0];
    let before = prefix_of(&text, one.start);
    assert_eq!(before.chars().count(), CONTEXT_CHARS);
    assert!(before.chars().all(|c| c == '春'));
}

#[test]
fn overlapping_windows_collapse_into_one_passage() {
    /* Without the collapse, `a b` over `a b b b` emits a window per right-hand
     * span and describes one sentence four times. */
    let text = "alpha beta beta beta";
    let found = quotes(text, "alpha beta");
    assert_eq!(found, ["alpha beta"]);
}

#[test]
fn case_does_not_decide_whether_a_passage_is_found_but_the_quote_keeps_it() {
    let text = "The Whale is large.";
    let found = quotes(text, "whale");
    assert_eq!(found, ["Whale"], "the quote is the book's own spelling");
}

#[test]
fn a_lone_cjk_character_query_is_refused_by_name() {
    /* ⚠️ **THE OTHER HALF OF THE BIGRAM DECISION.** The index holds `树` only
     * where it stood alone, so answering this query would return the handful of
     * isolated occurrences and silently miss every one inside a word. */
    let refused = parse_query("树").expect_err("a lone character");
    assert_eq!(refused.kind(), "badQuery");
    assert!(
        refused.to_string().contains("two or more"),
        "{refused} should say what would work instead"
    );
    // And it is refused wherever it appears, not only alone.
    assert!(parse_query("whale 树").is_err());
}

#[test]
fn two_cjk_characters_are_a_question_the_index_can_answer() {
    assert!(parse_query("柳树").is_ok());
    // And a quoted run of two or more never produces a lone-character term.
    assert!(parse_query("\"春天柳树\"").is_ok());
}

#[test]
fn a_one_letter_latin_query_is_not_refused() {
    /* The refusal is about what the CJK bigrams cannot hold, not about short
     * queries: `a` is an ordinary term with an ordinary posting list. */
    assert!(parse_query("a").is_ok());
}

#[test]
fn the_book_s_own_spelling_finds_the_book() {
    /* ⚠️ **COPYING A PHRASE OUT OF THE BOOK AND SEARCHING FOR IT IS THE MOST
     * NATURAL THING A READER DOES, AND IT SILENTLY FAILED.** The index holds
     * canonical text — curly apostrophes straightened — so `don't` with a curly
     * one is ONE token there; tokenizing the raw query split it into `don` and
     * `t`. Found by an independent audit. */
    let canonical = "he said don't go";
    let curly = "don\u{2019}t";
    assert_eq!(
        quotes(canonical, curly),
        ["don't"],
        "the curly form must ask the same question as the straight one"
    );
    assert_eq!(quotes(canonical, "don't"), ["don't"]);
}

#[test]
fn a_curly_quotation_mark_opens_a_phrase() {
    /* The fold runs BEFORE the quotes are counted, so a reader pasting a
     * smart-quoted phrase gets a phrase rather than an unbalanced-quote
     * refusal. */
    let text = "the ship saw a whale. the whale was large.";
    let found = quotes(text, "\u{201c}the whale\u{201d}");
    assert_eq!(found, ["the whale"]);
}

#[test]
fn a_soft_hyphen_in_a_query_is_dropped_as_the_index_dropped_it() {
    let soft = format!(
        "hyphen{}ation",
        char::from_u32(0x00ad).expect("a soft hyphen")
    );
    assert_eq!(quotes("the hyphenation rule", &soft), ["hyphenation"]);
}

#[test]
fn a_dash_variant_asks_the_question_the_index_holds() {
    /* `indexText` folds en and horizontal bars to an em dash before indexing. */
    assert_eq!(
        parse_query("a \u{2013} b").expect("a legal query"),
        parse_query("a \u{2014} b").expect("a legal query")
    );
}

#[test]
fn a_window_ends_at_its_furthest_span_not_its_last_one() {
    /* ⚠️ **`all` IS SORTED BY START, SO THE SPAN THAT STARTS LAST NEED NOT END
     * LAST.** Over `alpha beta gamma`, the phrase starts FIRST and ends last —
     * and taking the last span's endpoint cut the quote at `alpha beta`, a
     * passage that does not contain the phrase it matched. Found by an
     * independent audit. */
    let found = quotes("alpha beta gamma", "\"alpha beta gamma\" beta");
    assert_eq!(found, ["alpha beta gamma"]);
}

#[test]
fn the_quote_bound_holds_on_the_fallback_too() {
    /* The anchor is a whole clause, so a long quoted phrase could walk round
     * `MAX_QUOTE_BYTES` entirely. */
    let long: Vec<String> = (0..200).map(|n| format!("word{n}")).collect();
    let phrase = long.join(" ");
    let text = format!("{phrase} and then much later the whale");
    let query = format!("\"{phrase}\" whale");
    for quote in quotes(&text, &query) {
        assert!(
            quote.len() <= MAX_QUOTE_BYTES,
            "a {}-byte quote is no anchor at all",
            quote.len()
        );
        assert!(text.contains(&quote), "and it is still real text");
    }
}

#[test]
fn a_bounded_fallback_never_splits_a_character() {
    let long = "春".repeat(400);
    let text = format!("{long} whale");
    let query = format!("\"{}\" whale", "春".repeat(400));
    for quote in quotes(&text, &query) {
        assert!(
            quote.chars().all(|c| c == '春' || c.is_ascii()),
            "valid UTF-8"
        );
        assert!(quote.len() <= MAX_QUOTE_BYTES);
    }
}
