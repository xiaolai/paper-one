use super::*;
use crate::passage::parse_query;

fn sections(texts: &[&str]) -> Vec<Section> {
    texts
        .iter()
        .enumerate()
        .map(|(index, text)| Section {
            index: u32::try_from(index).expect("small"),
            text: (*text).to_owned(),
        })
        .collect()
}

fn limits() -> Limits {
    Limits {
        sections: 50,
        per_section: 4,
        total: 50,
    }
}

fn opened() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().expect("scratch");
    let store = Store::open(dir.path()).expect("opened");
    (dir, store)
}

fn find(store: &mut Store, query: &str) -> Vec<Hit> {
    store
        .search(&parse_query(query).expect("a legal query"), limits())
        .expect("searched")
}

#[test]
fn a_book_is_searchable_once_it_is_flushed() {
    let (_dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["Call me Ishmael.", "The whale was large."]),
            1,
            None,
        )
        .expect("indexed");
    store.flush().expect("flushed");
    let found = find(&mut store, "whale");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].book_id, "book:a");
    assert_eq!(found[0].section, 1);
    assert_eq!(found[0].quote, "whale");
    assert_eq!(found[0].prefix, "The ");
    assert_eq!(found[0].suffix, " was large.");
}

#[test]
fn the_quote_and_its_context_abut_with_nothing_between() {
    /* ⚠️ **THE PROPERTY THE LANDING DEPENDS ON.** `reanchorIn` scores context
     * outward from the quote's own edges; a gap between them would score zero
     * against a build whose text agrees perfectly. */
    let (_dir, mut store) = opened();
    let text = "one two three whale four five six";
    store
        .put("book:a", "gen1", sections(&[text]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    let hit = &find(&mut store, "whale")[0];
    assert_eq!(format!("{}{}{}", hit.prefix, hit.quote, hit.suffix), text);
}

#[test]
fn a_checkpoint_is_written_only_after_the_commit() {
    /* The ordering the module header argues for, asserted from outside: before
     * the flush the state must name nothing, because a crash there has to
     * re-index rather than believe a book is searchable. */
    let (dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    let mid = state::read(&Layout::under(dir.path()).state_path).expect("read");
    assert!(
        mid.books.is_empty(),
        "state must not name a book the index has not committed"
    );
    store.flush().expect("flushed");
    let after = state::read(&Layout::under(dir.path()).state_path).expect("read");
    assert!(after.current("book:a", "gen1"));
}

#[test]
fn a_crash_before_the_commit_is_re_indexed_rather_than_lost() {
    let dir = tempfile::tempdir().expect("scratch");
    {
        let mut store = Store::open(dir.path()).expect("opened");
        store
            .put("book:a", "gen1", sections(&["the whale"]), 1, None)
            .expect("indexed");
        // No flush — this is the crash.
    }
    let store = Store::open(dir.path()).expect("reopened");
    assert!(
        !store.current("book:a", "gen1"),
        "the book is not claimed as done, so a backfill will do it again"
    );
}

#[test]
fn a_replay_of_a_committed_book_replaces_rather_than_duplicates() {
    let (_dir, mut store) = opened();
    for _ in 0..3 {
        store
            .put("book:a", "gen1", sections(&["the whale"]), 1, None)
            .expect("indexed");
        store.flush().expect("flushed");
    }
    assert_eq!(store.sections(), 1);
    assert_eq!(find(&mut store, "whale").len(), 1);
}

#[test]
fn freshness_is_the_generation_and_nothing_else() {
    let (_dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    assert!(store.current("book:a", "gen1"));
    assert!(!store.current("book:a", "gen2"), "different bytes");
    // A re-import with new bytes replaces the sections rather than adding to them.
    store
        .put("book:a", "gen2", sections(&["the ship"]), 2, None)
        .expect("indexed");
    store.flush().expect("flushed");
    assert_eq!(store.sections(), 1);
    assert!(find(&mut store, "whale").is_empty());
    assert_eq!(find(&mut store, "ship").len(), 1);
}

#[test]
fn a_removal_takes_the_book_out_of_search_and_off_the_disk() {
    let (dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    store.forget("book:a", 10).expect("forgotten");
    assert!(find(&mut store, "whale").is_empty());
    assert!(!store.current("book:a", "gen1"));
    let text = Layout::under(dir.path())
        .text_path("book:a")
        .expect("a legal id");
    assert!(!text.exists(), "the retained text goes with it");
}

#[test]
fn an_extraction_that_lost_to_a_removal_does_not_resurrect_the_book() {
    /* ⚠️ **THE RACE WI-31.3 NAMES.** A serial index writer does not serialise
     * vault changes: the front end can spend a second extracting a book that is
     * evicted while it works. Committing that text afterwards would put a
     * removed book back into search, where nothing would ever take it out. */
    let (_dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    store.forget("book:a", 10).expect("forgotten");
    /* `at: 2` is BEFORE the removal at 10 — an extraction that read bytes the
     * shelf no longer has. */
    let accepted = store
        .put("book:a", "gen1", sections(&["the whale"]), 2, None)
        .expect("asked");
    assert!(!accepted, "the late extraction is refused, and says so");
    assert!(find(&mut store, "whale").is_empty());
}

#[test]
fn a_book_that_is_trashed_and_restored_is_indexed_again() {
    /* ⚠️ **THE DEFECT A SET OF IDS HAD, AND IT WAS SILENT.** Remembering only
     * THAT a book was forgotten refuses every later extraction of it for the
     * life of the process — so a restored book stays unsearchable with nothing
     * saying why, which looks exactly like a book with no matches. `trash →
     * restore` is a transition WI-31.3 names. */
    let (_dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    store.forget("book:a", 10).expect("forgotten");
    assert!(find(&mut store, "whale").is_empty());

    /* The restore: a NEW extraction, begun after the removal. */
    let accepted = store
        .put("book:a", "gen1", sections(&["the whale"]), 20, None)
        .expect("asked");
    assert!(
        accepted,
        "an extraction begun AFTER the removal is a restore"
    );
    store.flush().expect("flushed");
    assert_eq!(find(&mut store, "whale").len(), 1);
    assert!(store.current("book:a", "gen1"));
}

#[test]
fn a_removal_and_a_restore_are_told_apart_by_when_the_extraction_began() {
    let (_dir, mut store) = opened();
    store.forget("book:a", 10).expect("forgotten");
    assert_eq!(store.forgotten_at("book:a"), Some(10));
    assert_eq!(store.forgotten_at("book:b"), None);
    /* Older than the removal: the race. */
    assert!(!store
        .put("book:a", "g", sections(&["x"]), 9, None)
        .expect("asked"));
    /* The same millisecond accepts — the self-healing direction, since the next
     * sweep's diff removes a book the shelf does not want, where refusing would
     * leave a restored one unsearchable. */
    assert!(store
        .put("book:a", "g", sections(&["x"]), 10, None)
        .expect("asked"));
}

#[test]
fn a_removal_drops_work_that_was_pending_for_that_book() {
    /* Left in the pending list, it would be checkpointed by the next flush and
     * the state would claim a removed book is searchable. */
    let (_dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store
        .put("book:b", "gen1", sections(&["the ship"]), 1, None)
        .expect("indexed");
    store.forget("book:a", 10).expect("forgotten");
    store.flush().expect("flushed");
    assert!(!store.current("book:a", "gen1"));
    assert!(store.current("book:b", "gen1"), "the other book survives");
}

#[test]
fn a_rekey_keeps_the_work_and_moves_the_hits() {
    let (_dir, mut store) = opened();
    store
        .put("book:old", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    assert!(store.rekey("book:old", "book:new").expect("rekeyed"));
    let found = find(&mut store, "whale");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].book_id, "book:new");
    assert!(store.current("book:new", "gen1"), "no re-extraction needed");
}

#[test]
fn a_rekey_of_a_book_with_no_text_says_so_rather_than_inventing_one() {
    let (_dir, mut store) = opened();
    assert!(!store.rekey("book:missing", "book:new").expect("asked"));
}

#[test]
fn a_book_that_yielded_nothing_is_recorded_rather_than_skipped() {
    /* ⚠️ **SILENTLY EMPTY IS INDISTINGUISHABLE FROM "no matches".** At 1 959
     * books that is the difference between a search that covers the shelf and
     * one that omits a fifth of it without saying. */
    let (_dir, mut store) = opened();
    store
        .note("book:a", "g", "it holds no text this build could read", 5)
        .expect("noted");
    let note = store.state().notes.get("book:a").expect("recorded");
    assert!(note.why.contains("no text"));
    assert_eq!(note.at, 5);
}

#[test]
fn a_note_survives_a_relaunch() {
    let dir = tempfile::tempdir().expect("scratch");
    {
        let mut store = Store::open(dir.path()).expect("opened");
        store.note("book:a", "g", "no text", 5).expect("noted");
    }
    let store = Store::open(dir.path()).expect("reopened");
    assert!(store.state().notes.contains_key("book:a"));
}

#[test]
fn a_checkpoint_whose_postings_are_gone_is_dropped_at_open() {
    /* ⚠️ **`books_in_index` WAS WRITTEN FOR THIS AND NOTHING CALLED IT.** A
     * checkpoint that outlives its postings is the quietest failure the index
     * has: `current()` answers true, freshness never offers the book again, and
     * the book has no matches for ever with nothing anywhere saying so. The
     * marker closes the way this crate can cause it; damage from outside — a
     * lost segment, a half-restored `passages/` — is what is left, and it had
     * no repair at all. Found by an independent audit. */
    let dir = tempfile::tempdir().expect("scratch");
    {
        let mut store = Store::open(dir.path()).expect("opened");
        store
            .put(
                "book:a",
                "gen1",
                sections(&["the whale", "the ship"]),
                1,
                None,
            )
            .expect("indexed");
        store
            .put("book:b", "gen2", sections(&["春天柳树"]), 1, None)
            .expect("indexed");
        store.flush().expect("flushed");
    }
    let layout = Layout::under(dir.path());
    /* The damage: one book's documents gone, the checkpoint untouched. */
    let mut postings = Postings::open(&layout.index_dir).expect("postings");
    postings.forget("book:a").expect("deleted");
    postings.commit().expect("committed");
    /* The index lock is the writer's, and `Store::open` takes one too. */
    drop(postings);
    assert!(
        crate::state::read(&layout.state_path)
            .expect("read")
            .books
            .contains_key("book:a"),
        "the checkpoint still claims it, which is the whole defect"
    );

    let mut store = Store::open(dir.path()).expect("reopened");
    assert!(
        !store.current("book:a", "gen1"),
        "the book with no postings is due for extraction again"
    );
    assert!(
        store.current("book:b", "gen2"),
        "and the book that is really there is left alone"
    );
    assert_eq!(find(&mut store, "柳树").len(), 1);
}

#[test]
fn a_partial_warning_cannot_keep_a_book_settled_once_its_postings_are_gone() {
    /* ⚠️ **`books.remove` WOULD NOT HAVE BEEN ENOUGH, AND IT LOOKS LIKE IT.**
     * `current()` has two doors: the checkpoint, and a note whose generation
     * matches. A book carrying a PARTIAL warning — indexed, with a named gap —
     * keeps the second one, so dropping only the checkpoint leaves it settled
     * with no postings at all. The same trap the damaged-text path had, one
     * function along. */
    let dir = tempfile::tempdir().expect("scratch");
    {
        let mut store = Store::open(dir.path()).expect("opened");
        store
            .put(
                "book:a",
                "gen1",
                sections(&["the whale"]),
                1,
                Some("1 chapter could not be read"),
            )
            .expect("indexed, in part");
        store.flush().expect("flushed");
    }
    let layout = Layout::under(dir.path());
    let mut postings = Postings::open(&layout.index_dir).expect("postings");
    postings.forget("book:a").expect("deleted");
    postings.commit().expect("committed");
    drop(postings);

    let store = Store::open(dir.path()).expect("reopened");
    assert!(!store.current("book:a", "gen1"));
    assert!(
        store.state().notes.is_empty(),
        "and the warning goes with the coverage it was about"
    );
}

#[test]
fn a_book_re_indexed_since_the_last_merge_is_counted_once() {
    /* ⚠️ **THE RECOVERY COUNT READ DELETED DOCUMENTS AS LIVE ONES.**
     * `store.iter(None)` walks every document a segment holds, deletes
     * included, and `replace` deletes before it inserts — so a book indexed
     * twice was counted twice until the segments merged. That is exactly the
     * population `reconcile` is about, and it would have declared a perfectly
     * well indexed book damaged. Found by an independent audit. */
    let dir = tempfile::tempdir().expect("scratch");
    let mut store = Store::open(dir.path()).expect("opened");
    store
        .put(
            "book:a",
            "gen1",
            sections(&["the whale", "the ship"]),
            1,
            None,
        )
        .expect("indexed");
    store.flush().expect("flushed");
    store
        .put(
            "book:a",
            "gen2",
            sections(&["the whale", "the ship"]),
            2,
            None,
        )
        .expect("indexed again");
    store.flush().expect("flushed");

    assert_eq!(
        store.books_in_index().expect("counted").get("book:a"),
        Some(&2),
        "two live sections, not four"
    );
    drop(store);
    let store = Store::open(dir.path()).expect("reopened");
    assert!(
        store.current("book:a", "gen2"),
        "so reopening leaves it alone rather than re-extracting it"
    );
}

#[test]
fn a_rebuild_that_was_never_seen_to_finish_is_finished_on_the_next_open() {
    /* ⚠️ **THE CHECKPOINT DESCRIBED POSTINGS THAT HAD BEEN DELETED, AND
     * NOTHING NOTICED.** `rebuild()` clears the index in one committed
     * operation and writes the replacement checkpoint at the end. A crash
     * between them — or a failure reading `text/` — leaves `state.json` naming
     * every book as current over an empty index: reopening rebuilt nothing,
     * because the analysis matched, and freshness then skipped every book
     * because the checkpoint said they were done. The shelf was silently
     * unsearchable until a tokenizer change or a reader pressed Rebuild. Found
     * by an independent audit.
     *
     * ⚠️ **AND THE ANALYSIS-CHANGE REBUILD WAS NEVER THE CASE AT RISK**, which
     * is why this is spelt out: there the old analysis is still on disk, so the
     * next open rebuilds on that alone. This drives the SAME-analysis rebuild,
     * the one the Settings panel asks for. */
    let dir = tempfile::tempdir().expect("scratch");
    {
        let mut store = Store::open(dir.path()).expect("opened");
        store
            .put(
                "book:a",
                "gen1",
                sections(&["the whale", "the ship"]),
                1,
                None,
            )
            .expect("indexed");
        store.flush().expect("flushed");
    }
    let layout = Layout::under(dir.path());

    /* Exactly the state an interruption leaves: the marker down, the postings
     * gone, the checkpoint still describing them, the analysis unchanged. */
    let mut interrupted = crate::state::read(&layout.state_path).expect("read");
    assert!(
        !interrupted.rebuilding,
        "a finished rebuild lifts the marker"
    );
    interrupted.rebuilding = true;
    crate::state::write(&layout.state_path, &interrupted).expect("written");
    Postings::open(&layout.index_dir)
        .expect("postings")
        .clear()
        .expect("cleared");

    let mut store = Store::open(dir.path()).expect("reopened");
    assert_eq!(find(&mut store, "whale").len(), 1, "rebuilt from the text");
    assert!(store.current("book:a", "gen1"));
    assert!(
        !crate::state::read(&layout.state_path)
            .expect("read")
            .rebuilding,
        "and the marker is lifted, so the next open does not rebuild again"
    );
}

#[test]
fn the_marker_is_down_while_a_rebuild_is_running_and_not_before() {
    /* The ordering the repair depends on, asserted rather than assumed: the
     * marker must reach DISK before `clear()` commits, or the hole simply moves
     * one line down. Observed through the text directory, which `rebuild` reads
     * after the clear — the only place a case can stand between the two. */
    let dir = tempfile::tempdir().expect("scratch");
    let mut store = Store::open(dir.path()).expect("opened");
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    let layout = Layout::under(dir.path());

    std::fs::remove_dir_all(&layout.text_dir).expect("taken away mid-rebuild");
    std::fs::write(&layout.text_dir, b"not a directory").expect("and made unopenable");
    store.rebuild().expect_err("cannot read the text directory");

    assert!(
        crate::state::read(&layout.state_path)
            .expect("read")
            .rebuilding,
        "a rebuild that failed leaves the marker for the next open"
    );
}

#[test]
fn a_rebuild_reads_no_book_and_keeps_every_hit() {
    /* ⚠️ **THE WHOLE ARGUMENT FOR RETAINING `text/`.** A tokenizer change costs
     * a posting rebuild and reopens no EPUB. Nothing here can open one — this
     * crate has no parser — so the assertion is that the postings come back
     * from the text alone. */
    let (dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["the whale", "the ship"]),
            1,
            None,
        )
        .expect("indexed");
    store
        .put("book:b", "gen2", sections(&["春天柳树"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");

    store.rebuild().expect("rebuilt");

    assert_eq!(find(&mut store, "whale").len(), 1);
    assert_eq!(find(&mut store, "柳树").len(), 1);
    assert!(store.current("book:a", "gen1"), "the generation survives");
    assert!(store.current("book:b", "gen2"));
    assert_eq!(store.sections(), 3);
    // And the text is still exactly where it was.
    let layout = Layout::under(dir.path());
    assert!(layout.text_path("book:a").expect("id").exists());
}

#[test]
fn an_analysis_change_rebuilds_at_open_without_re_extracting() {
    let dir = tempfile::tempdir().expect("scratch");
    {
        let mut store = Store::open(dir.path()).expect("opened");
        store
            .put("book:a", "gen1", sections(&["the whale"]), 1, None)
            .expect("indexed");
        store.flush().expect("flushed");
    }
    // Pretend the tokenizer changed under us.
    let layout = Layout::under(dir.path());
    let mut held = state::read(&layout.state_path).expect("read");
    held.analysis = "paper/0".to_owned();
    state::write(&layout.state_path, &held).expect("written");

    let mut store = Store::open(dir.path()).expect("reopened");
    assert_eq!(store.state().analysis, tokenize::ANALYSIS);
    assert_eq!(
        find(&mut store, "whale").len(),
        1,
        "the postings came back from the retained text"
    );
    assert!(store.current("book:a", "gen1"));
}

#[test]
fn a_rebuild_keeps_the_notes_it_had() {
    /* Re-deriving postings says nothing about which books could not be
     * EXTRACTED. Dropping the notes would quietly turn "these books could not be
     * read" into "the shelf is fully covered". */
    let (_dir, mut store) = opened();
    store.note("book:bad", "g", "no text", 5).expect("noted");
    store.rebuild().expect("rebuilt");
    assert!(store.state().notes.contains_key("book:bad"));
}

#[test]
fn one_damaged_text_file_costs_that_book_and_not_the_library() {
    let (dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store
        .put("book:b", "gen1", sections(&["the ship"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");

    let layout = Layout::under(dir.path());
    std::fs::write(layout.text_path("book:a").expect("id"), "{ rubbish").expect("damaged");

    store.rebuild().expect("rebuilt");
    assert_eq!(find(&mut store, "ship").len(), 1, "book:b still answers");
    assert!(find(&mut store, "whale").is_empty());
    /* ⚠️ **AGAINST THE BOOK'S REAL ID, WHICH IS THE WHOLE VALUE OF THE
     * RECORD.** This asserted only that SOME note existed, and the note was
     * filed under `book_a` — the filename slug, which is what `file_stem` makes
     * of `book:a` and is not an id any book has. So the panel named a book the
     * reader does not own, and `book:a` kept whatever note it already had,
     * generation included, which is what `current()` reads. Found by an
     * independent audit. */
    assert!(
        store.state().notes.contains_key("book:a"),
        "the damage is recorded against the book it happened to: {:?}",
        store.state().notes.keys().collect::<Vec<_>>()
    );
    assert!(
        !store.current("book:a", "gen1"),
        "and it is due for re-extraction rather than settled"
    );
}

#[test]
fn a_damaged_text_file_never_takes_a_surviving_note_for_permission() {
    /* ⚠️ **THE SILENT HALF, AND IT NEEDED A NOTE ALREADY ON THE BOOK TO SHOW
     * IT.** With a partial note standing from an earlier build, a rebuild that
     * could not read the book's text noted the SLUG, left the real note
     * untouched, and `current()` — which accepts a note whose generation
     * matches — answered true. The book had no postings, freshness skipped it
     * on every sweep, and nothing anywhere said so. */
    let (dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["the whale"]),
            1,
            Some("three chapters would not read"),
        )
        .expect("indexed, in part");
    store.flush().expect("flushed");
    assert!(store.current("book:a", "gen1"), "settled before the damage");

    let layout = Layout::under(dir.path());
    std::fs::write(layout.text_path("book:a").expect("id"), "{ rubbish").expect("damaged");
    store.rebuild().expect("rebuilt");

    assert!(
        !store.current("book:a", "gen1"),
        "a book whose text will not read is due for re-extraction"
    );
    assert!(
        store.state().notes.keys().all(|id| id == "book:a"),
        "and no invented id is in the list the reader is shown: {:?}",
        store.state().notes.keys().collect::<Vec<_>>()
    );
}

#[test]
fn a_text_file_belonging_to_no_known_book_is_left_alone_rather_than_invented_for() {
    /* Text written for a book whose checkpoint never landed. Nothing claims it
     * is current, so the backfill re-extracts that book under its real id — and
     * a note under a guessed one would put a book nobody owns in front of the
     * reader, as well as being the one thing able to collide with a real id. */
    let (dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");

    let layout = Layout::under(dir.path());
    let orphan = layout.text_path("book:never-checkpointed").expect("id");
    std::fs::write(&orphan, "{ rubbish").expect("damaged");

    store.rebuild().expect("rebuilt");
    assert_eq!(
        find(&mut store, "whale").len(),
        1,
        "the library is unharmed"
    );
    assert!(
        store.state().notes.is_empty(),
        "no note is invented: {:?}",
        store.state().notes.keys().collect::<Vec<_>>()
    );
    assert!(orphan.exists(), "and the bytes are left where they are");
}

#[test]
fn a_damaged_state_file_is_refused_at_open_rather_than_read_as_empty() {
    let dir = tempfile::tempdir().expect("scratch");
    {
        let mut store = Store::open(dir.path()).expect("opened");
        store
            .put("book:a", "gen1", sections(&["the whale"]), 1, None)
            .expect("indexed");
        store.flush().expect("flushed");
    }
    let layout = Layout::under(dir.path());
    std::fs::write(&layout.state_path, "{ not json").expect("damaged");
    let refused = Store::open(dir.path()).expect_err("damaged");
    assert_eq!(refused.kind(), "damaged");
}

#[test]
fn a_batch_commits_itself_without_being_asked() {
    let (dir, mut store) = opened();
    for n in 0..BATCH {
        store
            .put(
                &format!("book:{n}"),
                "gen1",
                sections(&["the whale"]),
                1,
                None,
            )
            .expect("indexed");
    }
    let checkpointed = state::read(&Layout::under(dir.path()).state_path).expect("read");
    assert_eq!(
        checkpointed.books.len(),
        BATCH,
        "a full batch flushes itself, so a long backfill is not one commit at the end"
    );
}

#[test]
fn four_matches_in_a_chapter_are_four_hits() {
    let (_dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["whale one. whale two. whale three. whale four."]),
            1,
            None,
        )
        .expect("indexed");
    store.flush().expect("flushed");
    assert_eq!(find(&mut store, "whale").len(), 4);
}

#[test]
fn a_total_limit_stops_the_list() {
    let (_dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["whale one. whale two. whale three. whale four."]),
            1,
            None,
        )
        .expect("indexed");
    store.flush().expect("flushed");
    let found = store
        .search(
            &parse_query("whale").expect("q"),
            Limits {
                sections: 50,
                per_section: 4,
                total: 2,
            },
        )
        .expect("searched");
    assert_eq!(found.len(), 2);
}

#[test]
fn the_size_report_counts_both_stores() {
    let (_dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    let (postings, text) = store.bytes();
    assert!(postings > 0, "the index is on disk");
    assert!(text > 0, "and so is the text it was built from");
}

#[test]
fn what_the_index_holds_can_be_compared_with_what_the_state_claims() {
    let (_dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["one", "two"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    let held = store.books_in_index().expect("read back");
    assert_eq!(held.get("book:a").copied(), Some(2));
    assert_eq!(
        store.state().books.get("book:a").map(|one| one.sections),
        Some(2),
        "the state and the postings agree about how many sections there are"
    );
}

#[test]
fn the_notes_can_be_cleared_so_a_transient_failure_is_not_permanent() {
    /* ⚠️ **WITHOUT THIS THERE IS NO REMEDY.** A note stops a book that yields
     * nothing being re-parsed on every sweep for ever — and it catches a
     * transient failure just as well, which nothing can tell apart from a
     * thrown value. Recorded, that book is never looked at again until its
     * bytes change, which for a book nobody is editing is never. */
    let (_dir, mut store) = opened();
    store
        .note("book:a", "g", "the disk was busy", 1)
        .expect("noted");
    store.note("book:b", "g", "no text", 1).expect("noted");
    assert_eq!(store.retry_unreadable().expect("cleared"), 2);
    /* ⚠️ **A MARKER IS LEFT, NOT AN EMPTY MAP — AND THE SECOND AUDIT ROUND IS
     * WHY.** Clearing both the checkpoint and the note takes a book out of
     * `known()`, so a book removed before its re-extraction lands would never
     * reach the removal diff and its postings would answer for ever. An
     * empty-generation marker keeps it visible while matching nothing. */
    assert_eq!(store.state().notes.len(), 2);
    assert!(store
        .state()
        .notes
        .values()
        .all(|n| n.generation.is_empty()));
    assert!(!store.current("book:a", "gen1"), "and it is pending again");
    assert_eq!(store.known().len(), 2, "still visible to the removal diff");
}

#[test]
fn clearing_the_notes_leaves_the_index_alone() {
    let (_dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    store.note("book:b", "g", "no text", 1).expect("noted");
    store.retry_unreadable().expect("cleared");
    assert_eq!(find(&mut store, "whale").len(), 1);
    assert!(store.current("book:a", "gen1"));
}

#[test]
fn hits_from_one_book_arrive_together_even_when_another_book_scores_between() {
    /* ⚠️ **THIS IS A MEMORY PROPERTY WEARING A PRESENTATIONAL ONE.** The
     * postings answer in score order across the whole shelf, so two sections of
     * one book commonly sit either side of a section of another. Reading text as
     * that order arrives holds every matching book's text at once — hundreds of
     * megabytes for one keystroke. Grouping first keeps exactly one book alive,
     * and this is the observable consequence. */
    let (_dir, mut store) = opened();
    /* `whale` twice in book:a and once in book:b, with the sections arranged so
     * a score-ordered walk would interleave them. */
    store
        .put(
            "book:a",
            "gen1",
            sections(&["the whale", "nothing here", "the whale again"]),
            1,
            None,
        )
        .expect("indexed");
    store
        .put("book:b", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");

    let found = find(&mut store, "whale");
    assert_eq!(found.len(), 3);
    let books: Vec<&str> = found.iter().map(|one| one.book_id.as_str()).collect();
    /* Whichever book ranks first, its hits are contiguous. */
    let contiguous =
        books == ["book:a", "book:a", "book:b"] || books == ["book:b", "book:a", "book:a"];
    assert!(contiguous, "hits were interleaved: {books:?}");
}

#[test]
fn a_book_whose_text_will_not_read_costs_that_book_and_not_the_query() {
    let (dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store
        .put("book:b", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");

    let layout = Layout::under(dir.path());
    std::fs::write(layout.text_path("book:a").expect("id"), "{ rubbish").expect("damaged");

    let found = find(&mut store, "whale");
    assert_eq!(found.len(), 1, "the other book still answers");
    assert_eq!(found[0].book_id, "book:b");
}

#[test]
fn a_damaged_book_met_during_a_search_is_recorded_rather_than_skipped() {
    /* ⚠️ **THREE WAYS TO BE WRONG ABOUT ONE BOOK, AND NO WAY TO FIND OUT.** A
     * text read that failed at SEARCH time was turned into `None` and skipped —
     * so the book silently stopped answering queries, `passages_status` went on
     * counting it as covered, and freshness, seeing a current generation, never
     * re-extracted it. The comment beside it claimed the damage was "already in
     * `state.json`", which nothing had put there. Found by an independent
     * audit, and only its VERIFICATION pass caught that the first fix was to
     * the comment rather than the code. */
    let (dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    assert!(store.current("book:a", "gen1"));

    std::fs::write(
        Layout::under(dir.path()).text_path("book:a").expect("id"),
        "{ rubbish",
    )
    .expect("damaged");

    let _ = find(&mut store, "whale");

    let note = store
        .state()
        .notes
        .get("book:a")
        .expect("the damage is recorded");
    assert!(
        note.why.contains("saved text could not be read"),
        "{}",
        note.why
    );
    assert!(
        !store.current("book:a", "gen1"),
        "and the next sweep will extract it again"
    );
}

#[test]
fn clearing_the_notes_makes_a_partly_indexed_book_pending_again() {
    /* ⚠️ **THE FIRST FIX HALF-LANDED, AND THE VERIFICATION PASS IS WHAT SAID
     * SO.** "Try these again" cleared the warning — but a PARTLY readable book
     * keeps its checkpoint, so it stayed `current` and freshness never offered
     * it to another sweep. The warning vanished and the coverage stayed exactly
     * as incomplete, which is worse than the warning it removed. */
    let (_dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["the whale"]),
            1,
            Some("1 chapter could not be read"),
        )
        .expect("indexed, in part");
    store.flush().expect("flushed");
    assert!(store.current("book:a", "gen1"), "indexed, and partly so");

    assert_eq!(store.retry_unreadable().expect("cleared"), 1);
    assert!(
        !store.current("book:a", "gen1"),
        "the next sweep must try the chapters that failed"
    );
    /* AND THE POSTINGS STAY, so search keeps answering from what is there until
     * there is something better. */
    assert_eq!(find(&mut store, "whale").len(), 1);
}

#[test]
fn a_noted_book_is_left_alone_until_its_bytes_change() {
    /* ⚠️ **THE NOTE STOPPED NOTHING, WHILE ITS OWN DOCSTRING SAID IT DID.**
     * Freshness asked `books` alone and a noted book is not in `books`, so every
     * unreadable book was re-parsed on every sweep — at twenty-odd picture books
     * that is a whole extraction pass per sweep, for ever, for nothing. Found by
     * an independent audit; the sweep reported `unreadable` each time and looked
     * like it was working. */
    let (_dir, mut store) = opened();
    store
        .note("book:a", "gen1", "it holds no text", 1)
        .expect("noted");
    assert!(store.current("book:a", "gen1"), "settled at these bytes");
    assert!(
        !store.current("book:a", "gen2"),
        "new bytes are worth a try"
    );
}

#[test]
fn a_note_from_before_the_generation_existed_costs_one_retry_rather_than_a_refusal() {
    let (_dir, mut store) = opened();
    store
        .note("book:a", "", "it holds no text", 1)
        .expect("noted");
    assert!(
        !store.current("book:a", "gen1"),
        "an empty generation matches nothing, so it is tried once and settles"
    );
}

#[test]
fn noting_a_replacement_that_will_not_read_takes_the_old_answers_with_it() {
    /* ⚠️ **THE PANEL AND THE SEARCH DISAGREED, AND THE CONVINCING ONE WAS
     * WRONG.** A book whose replacement bytes cannot be read was noted while
     * the PREVIOUS generation went on answering queries — so Settings said
     * "could not be read" and search returned its old contents. Found by an
     * independent audit. */
    let (dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    assert_eq!(find(&mut store, "whale").len(), 1);

    store
        .note("book:a", "gen2", "the replacement would not parse", 2)
        .expect("noted");
    assert!(
        find(&mut store, "whale").is_empty(),
        "the stale answers go too"
    );
    let text = Layout::under(dir.path())
        .text_path("book:a")
        .expect("a legal id");
    assert!(!text.exists(), "and so does the text a rebuild would read");
}

#[test]
fn a_partly_readable_book_keeps_the_chapters_that_read() {
    /* ⚠️ **`note` WOULD HAVE DELETED THIRTY-SEVEN GOOD CHAPTERS TO REPORT
     * THREE BAD ONES.** A book that is mostly readable is worth having; the gap
     * is a warning BESIDE real coverage, not a replacement for it. */
    let (_dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["the whale", "the ship"]),
            1,
            Some("1 chapter could not be read"),
        )
        .expect("indexed, in part");
    store.flush().expect("flushed");

    assert_eq!(find(&mut store, "whale").len(), 1, "still searchable");
    assert!(store.current("book:a", "gen1"), "still checkpointed");
    assert_eq!(
        store.state().notes.get("book:a").map(|n| n.why.as_str()),
        Some("1 chapter could not be read"),
        "and the gap is named"
    );
}

#[test]
fn a_noted_book_reaches_the_removal_diff() {
    /* ⚠️ **A BOOK THAT YIELDS NO TEXT AND IS THEN TRASHED KEPT ITS WARNING FOR
     * EVER**, because the inventory the sweep compares against the shelf was
     * `books` alone and a noted book is not in it. Found by an independent
     * audit. */
    let (_dir, mut store) = opened();
    store
        .put("book:a", "gen1", sections(&["the whale"]), 1, None)
        .expect("indexed");
    store.flush().expect("flushed");
    store.note("book:b", "gen1", "no text", 1).expect("noted");
    assert_eq!(
        store.known(),
        vec!["book:a".to_owned(), "book:b".to_owned()]
    );
}

#[test]
fn a_partial_book_reaches_disk_with_its_warning_in_the_same_write() {
    /* ⚠️ **THE CHECKPOINT AND THE WARNING USED TO BE TWO CALLS, AND A `put`
     * THAT FILLS THE BATCH WRITES THE CHECKPOINT BEFORE IT RETURNS.** So a
     * crash in the gap — one book in `BATCH` — left `state.json` saying the
     * book was indexed and nothing at all saying three of its chapters had not
     * been. `current()` answers true at that generation for ever, so the gap is
     * permanent, silent, and looks exactly like a book with no matches in those
     * chapters. The front end could not close it from its side: the write had
     * already happened by the time control came back. Found by an independent
     * audit.
     *
     * Driven through the BATCH boundary and read back FROM DISK, because the
     * in-memory state would agree either way — what is being asserted is that
     * one `state::write` carried both. */
    let dir = tempfile::tempdir().expect("scratch");
    let mut store = Store::open(dir.path()).expect("opened");
    for at in 0..BATCH {
        let id = format!("book:{at}");
        let partial = (at == 0).then_some("3 chapters could not be read");
        store
            .put(
                &id,
                "gen1",
                sections(&["the whale"]),
                u64::try_from(at).expect("small"),
                partial,
            )
            .expect("indexed");
    }

    let layout = Layout::under(dir.path());
    let written = crate::state::read(&layout.state_path).expect("the batch wrote it");
    assert!(
        written.books.contains_key("book:0"),
        "the batch committed and checkpointed without anyone calling flush"
    );
    assert_eq!(
        written.notes.get("book:0").map(|note| note.why.as_str()),
        Some("3 chapters could not be read"),
        "and the warning is in the SAME file, not waiting on a second call"
    );
    assert_eq!(written.notes.len(), 1, "and only the book that has a gap");
    assert_eq!(
        written.notes["book:0"].generation, "gen1",
        "pinned to the bytes it is about, so it is retried when they move"
    );
}

#[test]
fn a_whole_book_put_after_a_partial_one_clears_the_warning() {
    /* The other half of carrying the note through `pending`: `State::indexed`
     * clears a book's note as it checkpoints, and the partial note is inserted
     * AFTER that. A later whole extraction passes `None`, so nothing is
     * re-inserted and the book stops being listed as incomplete — which is the
     * same rule `indexed()` has always had, reached by a new road. */
    let (_dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["the whale"]),
            1,
            Some("1 chapter could not be read"),
        )
        .expect("indexed, in part");
    store.flush().expect("flushed");
    assert_eq!(store.state().notes.len(), 1);

    store
        .put(
            "book:a",
            "gen2",
            sections(&["the whale", "the ship"]),
            2,
            None,
        )
        .expect("indexed whole");
    store.flush().expect("flushed");
    assert!(
        store.state().notes.is_empty(),
        "the gap is closed and unsaid"
    );
    assert!(store.current("book:a", "gen2"));
}

#[test]
fn a_book_that_is_both_indexed_and_noted_is_listed_once() {
    let (_dir, mut store) = opened();
    store
        .put(
            "book:a",
            "gen1",
            sections(&["the whale"]),
            1,
            Some("1 chapter could not be read"),
        )
        .expect("indexed, in part");
    store.flush().expect("flushed");
    assert_eq!(store.known(), vec!["book:a".to_owned()]);
}
