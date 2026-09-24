use super::*;
use crate::passage::parse_query;

fn section(index: u32, text: &str) -> Section {
    Section {
        index,
        text: text.to_owned(),
    }
}

fn opened() -> (tempfile::TempDir, Postings) {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let postings = Postings::open(dir.path()).expect("a fresh index");
    (dir, postings)
}

#[test]
fn a_book_is_searchable_once_it_is_committed() {
    let (_dir, mut postings) = opened();
    postings
        .replace(
            "book:a",
            &[
                section(0, "Call me Ishmael."),
                section(1, "The whale was large."),
            ],
        )
        .expect("indexed");
    postings.commit().expect("committed");
    let found = postings
        .search(&parse_query("whale").expect("a legal query"), 10)
        .expect("searched");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].book_id, "book:a");
    assert_eq!(found[0].section, 1);
}

#[test]
fn a_bare_multi_word_query_is_an_and() {
    let (_dir, mut postings) = opened();
    postings
        .replace(
            "book:a",
            &[section(0, "a whale"), section(1, "a whale and a ship")],
        )
        .expect("indexed");
    postings.commit().expect("committed");
    let found = postings
        .search(&parse_query("whale ship").expect("a legal query"), 10)
        .expect("searched");
    assert_eq!(found.len(), 1, "only the section holding both");
    assert_eq!(found[0].section, 1);
}

#[test]
fn a_phrase_is_not_the_same_question_as_an_and() {
    let (_dir, mut postings) = opened();
    postings
        .replace(
            "book:a",
            &[
                section(0, "the ship saw a whale"),
                section(1, "the whale was large"),
            ],
        )
        .expect("indexed");
    postings.commit().expect("committed");
    let and = postings
        .search(&parse_query("the whale").expect("q"), 10)
        .expect("searched");
    assert_eq!(and.len(), 2, "both sections hold both words");
    let phrase = postings
        .search(&parse_query("\"the whale\"").expect("q"), 10)
        .expect("searched");
    assert_eq!(phrase.len(), 1, "only one has them adjacent");
    assert_eq!(phrase[0].section, 1);
}

#[test]
fn a_replay_replaces_rather_than_duplicates() {
    let (_dir, mut postings) = opened();
    postings
        .replace("book:a", &[section(0, "the whale")])
        .expect("indexed");
    postings.commit().expect("committed");
    postings
        .replace("book:a", &[section(0, "the whale")])
        .expect("indexed again");
    postings.commit().expect("committed");
    assert_eq!(postings.sections(), 1, "one section, indexed twice");
}

#[test]
fn forgetting_a_book_takes_every_section_with_it() {
    let (_dir, mut postings) = opened();
    postings
        .replace(
            "book:a",
            &[section(0, "the whale"), section(1, "the whale")],
        )
        .expect("indexed");
    postings
        .replace("book:b", &[section(0, "the whale")])
        .expect("indexed");
    postings.commit().expect("committed");
    assert_eq!(postings.sections(), 3);
    postings.forget("book:a").expect("forgotten");
    postings.commit().expect("committed");
    assert_eq!(postings.sections(), 1);
    let found = postings
        .search(&parse_query("whale").expect("q"), 10)
        .expect("searched");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].book_id, "book:b");
}

#[test]
fn chinese_is_searchable_by_the_words_a_reader_types() {
    let (_dir, mut postings) = opened();
    postings
        .replace("book:zh", &[section(0, "从前有一棵柳树，春天柳树发芽了。")])
        .expect("indexed");
    postings.commit().expect("committed");
    let found = postings
        .search(&parse_query("柳树").expect("q"), 10)
        .expect("searched");
    assert_eq!(
        found.len(),
        1,
        "a two-character word must be findable inside a run"
    );
}

#[test]
fn an_uncommitted_write_is_not_visible_and_that_is_the_point() {
    let (_dir, mut postings) = opened();
    postings
        .replace("book:a", &[section(0, "the whale")])
        .expect("indexed");
    let found = postings
        .search(&parse_query("whale").expect("q"), 10)
        .expect("searched");
    assert!(
        found.is_empty(),
        "visibility is the commit's, so a crash before it loses nothing half-written"
    );
}

#[test]
fn a_reopened_index_still_answers() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    {
        let mut postings = Postings::open(dir.path()).expect("a fresh index");
        postings
            .replace("book:a", &[section(0, "the whale")])
            .expect("indexed");
        postings.commit().expect("committed");
    }
    let postings = Postings::open(dir.path()).expect("reopened");
    let found = postings
        .search(&parse_query("whale").expect("q"), 10)
        .expect("searched");
    assert_eq!(found.len(), 1);
}

#[test]
fn clearing_leaves_an_index_that_still_works() {
    let (_dir, mut postings) = opened();
    postings
        .replace("book:a", &[section(0, "the whale")])
        .expect("indexed");
    postings.commit().expect("committed");
    postings.clear().expect("cleared");
    assert_eq!(postings.sections(), 0);
    postings
        .replace("book:a", &[section(0, "the whale")])
        .expect("re-indexed");
    postings.commit().expect("committed");
    assert_eq!(postings.sections(), 1);
}

#[test]
fn what_the_index_holds_can_be_read_back_book_by_book() {
    let (_dir, mut postings) = opened();
    postings
        .replace("book:a", &[section(0, "one"), section(1, "two")])
        .expect("indexed");
    postings
        .replace("book:b", &[section(0, "three")])
        .expect("indexed");
    postings.commit().expect("committed");
    let held = books_in(&postings).expect("read back");
    assert_eq!(held.get("book:a").copied(), Some(2));
    assert_eq!(held.get("book:b").copied(), Some(1));
}
