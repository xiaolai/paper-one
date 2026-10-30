use super::*;
use crate::index::Section;

fn book(id: &str, generation: &str, sections: &[(u32, &str)]) -> BookText {
    BookText {
        book_id: id.to_owned(),
        generation: generation.to_owned(),
        sections: sections
            .iter()
            .map(|(index, text)| Section {
                index: *index,
                text: (*text).to_owned(),
            })
            .collect(),
    }
}

#[test]
fn a_book_reads_back_as_it_was_written() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    let written = book(
        "book:a",
        "gen1",
        &[(0, "Call me Ishmael."), (3, "春天柳树")],
    );
    write(&path, &written).expect("written");
    let read_back = read(&path, "book:a").expect("read").expect("present");
    assert_eq!(read_back, written);
}

#[test]
fn a_book_that_was_never_indexed_is_absent_rather_than_a_failure() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("nothing.jsonl");
    assert_eq!(read(&path, "book:a").expect("read"), None);
}

#[test]
fn a_file_that_is_there_and_will_not_read_is_damage_and_not_emptiness() {
    /* ⚠️ **THE RULE THIS REPOSITORY HAS FIXED IN EIGHTEEN STORES.** Answered as
     * "no sections", the next pass would index nothing, report success, and the
     * book would be permanently unsearchable with nothing saying so. */
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    std::fs::write(&path, "{ not json at all\n").expect("written");
    let refused = read(&path, "book:a").expect_err("damaged");
    assert_eq!(refused.kind(), "damaged");
}

#[test]
fn an_empty_file_is_damage_because_every_write_emits_a_header() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    std::fs::write(&path, "").expect("written");
    let refused = read(&path, "book:a").expect_err("damaged");
    assert_eq!(refused.kind(), "damaged");
    assert!(refused.to_string().contains("header"));
}

#[test]
fn a_file_holding_another_book_is_refused_rather_than_merged() {
    /* The digest collision, detected. Two ids CAN land on one filename; reading
     * the id back is what stops one book's passages being served under
     * another's name. */
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    write(&path, &book("book:a", "gen1", &[(0, "one")])).expect("written");
    let refused = read(&path, "book:b").expect_err("wrong book");
    assert_eq!(refused.kind(), "damaged");
    assert!(
        refused.to_string().contains("book:a"),
        "{refused} should name what it actually holds"
    );
}

#[test]
fn a_file_from_another_format_is_refused_by_version() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    std::fs::write(
        &path,
        "{\"format\":99,\"book\":\"book:a\",\"generation\":\"g\"}\n",
    )
    .expect("written");
    let refused = read(&path, "book:a").expect_err("wrong format");
    assert_eq!(refused.kind(), "damaged");
    assert!(refused.to_string().contains("99"));
}

#[test]
fn a_damaged_line_names_which_line() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    std::fs::write(
        &path,
        "{\"format\":1,\"book\":\"book:a\",\"generation\":\"g\"}\n{\"i\":0,\"t\":\"fine\"}\nrubbish\n",
    )
    .expect("written");
    let refused = read(&path, "book:a").expect_err("damaged");
    assert!(
        refused.to_string().contains("line 3"),
        "{refused} should say where"
    );
}

#[test]
fn a_write_replaces_the_previous_generation_whole() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    write(&path, &book("book:a", "gen1", &[(0, "one"), (1, "two")])).expect("written");
    write(&path, &book("book:a", "gen2", &[(0, "only")])).expect("rewritten");
    let read_back = read(&path, "book:a").expect("read").expect("present");
    assert_eq!(read_back.generation, "gen2");
    assert_eq!(read_back.sections.len(), 1, "no line of gen1 survives");
}

#[test]
fn a_write_leaves_no_temporary_behind() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    write(&path, &book("book:a", "gen1", &[(0, "one")])).expect("written");
    let left: Vec<_> = std::fs::read_dir(dir.path())
        .expect("listed")
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, ["a.jsonl"]);
}

#[test]
fn removing_a_book_that_is_not_there_is_success() {
    let dir = tempfile::tempdir().expect("scratch");
    remove(&dir.path().join("nothing.jsonl")).expect("absent is success");
}

#[test]
fn text_with_newlines_in_it_survives_the_line_format() {
    /* JSON escapes them, so a section whose canonical text somehow carries one
     * does not become two sections. */
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("a.jsonl");
    write(&path, &book("book:a", "g", &[(0, "one\ntwo\r\nthree")])).expect("written");
    let read_back = read(&path, "book:a").expect("read").expect("present");
    assert_eq!(read_back.sections.len(), 1);
    assert_eq!(read_back.sections[0].text, "one\ntwo\r\nthree");
}

#[test]
fn the_files_in_a_directory_come_back_sorted_and_only_the_ones_we_wrote() {
    let dir = tempfile::tempdir().expect("scratch");
    for name in ["b.jsonl", "a.jsonl", "notes.txt"] {
        std::fs::write(dir.path().join(name), "x").expect("written");
    }
    let found = files_in(dir.path()).expect("listed");
    let names: Vec<_> = found
        .iter()
        .map(|p| p.file_name().and_then(|n| n.to_str()).unwrap_or_default())
        .collect();
    assert_eq!(names, ["a.jsonl", "b.jsonl"]);
    // A directory that does not exist is no files, not a failure.
    assert!(files_in(&dir.path().join("gone"))
        .expect("absent")
        .is_empty());
}

#[test]
fn a_rebuild_can_read_a_file_without_being_told_whose_it_is() {
    let dir = tempfile::tempdir().expect("scratch");
    let path = dir.path().join("whatever.jsonl");
    write(&path, &book("book:a", "gen1", &[(0, "one")])).expect("written");
    let read_back = read_any(&path).expect("read").expect("present");
    assert_eq!(read_back.book_id, "book:a");
}

#[test]
fn the_character_count_is_characters_and_not_bytes() {
    let counted = book("book:a", "g", &[(0, "春天"), (1, "ab")]);
    assert_eq!(
        counted.chars(),
        4,
        "two Chinese characters are two, not six"
    );
}
