use super::*;

fn indexed(generation: &str) -> Indexed {
    Indexed {
        generation: generation.to_owned(),
        sections: 3,
        chars: 100,
        at: 1,
    }
}

#[test]
fn a_book_is_current_only_at_the_generation_it_was_indexed_from() {
    let mut state = State::default();
    state.indexed("book:a", indexed("hash1"));
    assert!(state.current("book:a", "hash1"));
    assert!(!state.current("book:a", "hash2"), "different bytes");
    assert!(!state.current("book:b", "hash1"), "never indexed");
}

#[test]
fn indexing_a_book_clears_the_note_against_it() {
    /* A book that failed once and succeeded later must stop being listed among
     * the books that could not be read. */
    let mut state = State::default();
    state.noted(
        "book:a",
        Note {
            why: "it would not parse".to_owned(),
            at: 1,
        },
    );
    state.indexed("book:a", indexed("hash1"));
    assert!(state.notes.is_empty());
    assert!(state.current("book:a", "hash1"));
}

#[test]
fn noting_a_book_clears_a_stale_index_entry() {
    let mut state = State::default();
    state.indexed("book:a", indexed("hash1"));
    state.noted(
        "book:a",
        Note {
            why: "the file went away".to_owned(),
            at: 2,
        },
    );
    assert!(!state.current("book:a", "hash1"));
    assert_eq!(state.notes.len(), 1);
}

#[test]
fn forgetting_takes_both_halves() {
    let mut state = State::default();
    state.indexed("book:a", indexed("hash1"));
    state.noted(
        "book:b",
        Note {
            why: "empty".to_owned(),
            at: 1,
        },
    );
    state.forget("book:a");
    state.forget("book:b");
    assert!(state.books.is_empty());
    assert!(state.notes.is_empty());
}

#[test]
fn a_rekey_keeps_the_work_rather_than_throwing_it_away() {
    let mut state = State::default();
    state.indexed("book:old", indexed("hash1"));
    state.rekey("book:old", "book:new");
    assert!(state.current("book:new", "hash1"));
    assert!(!state.current("book:old", "hash1"));
}

#[test]
fn a_rekey_carries_a_note_too() {
    let mut state = State::default();
    state.noted(
        "book:old",
        Note {
            why: "no text".to_owned(),
            at: 1,
        },
    );
    state.rekey("book:old", "book:new");
    assert!(state.notes.contains_key("book:new"));
    assert!(!state.notes.contains_key("book:old"));
}

#[test]
fn a_rekey_of_a_book_nobody_knows_changes_nothing() {
    let mut state = State::default();
    state.indexed("book:a", indexed("hash1"));
    state.rekey("book:missing", "book:new");
    assert_eq!(state.books.len(), 1);
    assert!(state.current("book:a", "hash1"));
}

#[test]
fn it_reads_back_as_it_was_written() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("state.json");
    let mut state = State::default();
    state.indexed("book:a", indexed("hash1"));
    state.noted(
        "book:b",
        Note {
            why: "it yielded no text at all".to_owned(),
            at: 7,
        },
    );
    write(&path, &state).expect("written");
    assert_eq!(read(&path).expect("read"), state);
}

#[test]
fn no_file_is_a_fresh_state_and_not_a_failure() {
    let dir = tempfile::tempdir().expect("scratch");
    let fresh = read(&dir.path().join("state.json")).expect("absent");
    assert_eq!(fresh, State::default());
    assert_eq!(fresh.analysis, crate::tokenize::ANALYSIS);
}

#[test]
fn a_state_file_that_is_there_and_will_not_read_is_damage() {
    /* ⚠️ **NOT `unwrap_or_default`.** Read as "nothing is indexed", a damaged
     * file sends a backfill over every book that was already done and then
     * writes that emptiness over the record of what really is there. */
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("state.json");
    std::fs::write(&path, "{ not json").expect("written");
    let refused = read(&path).expect_err("damaged");
    assert_eq!(refused.kind(), "damaged");
}

#[test]
fn a_state_file_from_another_format_is_refused_by_version() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("state.json");
    std::fs::write(
        &path,
        "{\"format\":99,\"analysis\":\"paper/1\",\"books\":{},\"notes\":{}}",
    )
    .expect("written");
    let refused = read(&path).expect_err("wrong format");
    assert_eq!(refused.kind(), "damaged");
}

#[test]
fn the_file_is_byte_stable_for_the_same_content() {
    /* A `BTreeMap` rather than a `HashMap`: an order that moves makes every
     * write a diff and every comparison in a test a sort. */
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("state.json");
    let mut state = State::default();
    for id in ["book:c", "book:a", "book:b"] {
        state.indexed(id, indexed("hash"));
    }
    write(&path, &state).expect("written");
    let once = std::fs::read(&path).expect("read");
    write(&path, &state).expect("written again");
    assert_eq!(once, std::fs::read(&path).expect("read"));
}
