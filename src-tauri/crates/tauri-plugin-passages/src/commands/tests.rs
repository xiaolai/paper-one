use super::*;
use crate::store::utf16_len;

/// Every `#[tauri::command]` in `commands.rs`, by the name it is declared with.
///
/// ⚠️ **A LINE THAT IS THE ATTRIBUTE, NOT A LINE THAT CONTAINS IT.** The voices
/// plugin's copy of this test found SEVEN commands where there were six,
/// because a doc comment a few lines up explained what a `#[tauri::command]
/// async fn` costs — and to a `split` that is an attribute. Same family as
/// `check-browser-safe` counting `@tauri-apps` inside doc comments, and as prose
/// beginning with the words of a `Stryker disable`.
fn declared(source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut lines = source.lines();
    while let Some(line) = lines.next() {
        if line.trim() != "#[tauri::command]" {
            continue;
        }
        for next in lines.by_ref() {
            let trimmed = next.trim_start();
            let Some(rest) = trimmed
                .strip_prefix("pub async fn ")
                .or_else(|| trimmed.strip_prefix("pub fn "))
            else {
                continue;
            };
            let end = rest
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(rest.len());
            out.push(rest[..end].to_owned());
            break;
        }
    }
    out
}

#[test]
fn lists_agree() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let plugin = std::fs::read_to_string(root.join("src/plugin.rs")).expect("plugin.rs");
    let build = std::fs::read_to_string(root.join("build.rs")).expect("build.rs");
    let permissions =
        std::fs::read_to_string(root.join("permissions/default.toml")).expect("default.toml");
    let source = std::fs::read_to_string(root.join("src/commands.rs")).expect("commands.rs");

    let names = declared(&source);
    assert!(
        !names.is_empty(),
        "no commands found — the parse is wrong, not the code"
    );
    assert!(
        names.iter().all(|name| name.starts_with("passages_")),
        "a name that is not a command slipped into the parse: {names:?}"
    );

    for name in &names {
        assert!(
            plugin.contains(&format!("commands::{name}")),
            "{name} is declared but not registered in plugin.rs"
        );
        assert!(
            build.contains(&format!("\"{name}\"")),
            "{name} is declared but not in build.rs's COMMANDS, so it has no permission pair"
        );
        let grant = format!("allow-{}", name.replace('_', "-"));
        assert!(
            permissions.contains(&grant),
            "{name} is declared but {grant} is not in permissions/default.toml, so it is refused"
        );
    }

    /* AND THE OTHER DIRECTION. A command removed from `commands.rs` but left in
     * the other three lists is a grant for something that does not exist —
     * harmless today and a name somebody re-adds a different meaning to. */
    for line in build.lines() {
        let Some(quoted) = line.trim().strip_prefix('"') else {
            continue;
        };
        let Some(name) = quoted.strip_suffix("\",") else {
            continue;
        };
        assert!(
            names.iter().any(|declared| declared == name),
            "{name} is in build.rs's COMMANDS and is not declared in commands.rs"
        );
    }
}

#[test]
fn the_parse_does_not_read_a_doc_comment_as_a_command() {
    /* The voices plugin's own trap, reproduced in memory so this parser is
     * KNOWN to survive it rather than assumed to. */
    let source = "\
/// What a `#[tauri::command]` async fn costs.
#[tauri::command]
pub async fn passages_real() {}
";
    assert_eq!(declared(source), ["passages_real"]);
}

#[test]
fn an_offset_is_what_the_front_end_counts() {
    /* ⚠️ **UTF-16 CODE UNITS, NOT BYTES AND NOT `char`s.** Three different
     * numbers for the same position, and picking the wrong one shifts every
     * quote in the book by however many astral characters preceded it. */
    let text = "😀 a whale";
    assert_eq!(text.len(), 12, "bytes");
    assert_eq!(text.chars().count(), 9, "Rust chars");
    assert_eq!(utf16_len(text), 10, "what JavaScript counts");

    // CJK is three bytes, one char, ONE UTF-16 unit — where they differ the
    // other way round from an emoji.
    let cjk = "春天 whale";
    assert_eq!(
        cjk.len(),
        12,
        "bytes — three each for the two Chinese characters"
    );
    assert_eq!(cjk.chars().count(), 8);
    assert_eq!(
        utf16_len(cjk),
        8,
        "a BMP character is ONE unit, unlike an emoji"
    );
}

#[test]
fn the_offset_on_the_wire_is_the_one_the_store_computed() {
    use crate::store::{Limits, Store};
    let dir = tempfile::tempdir().expect("scratch");
    let mut store = Store::open(dir.path()).expect("opened");
    let text = "😀 the whale";
    store
        .put(
            "book:a",
            "gen1",
            vec![crate::index::Section {
                index: 0,
                text: text.to_owned(),
            }],
            1,
        )
        .expect("indexed");
    store.flush().expect("flushed");
    let hits = store
        .search(
            &parse_query("whale").expect("q"),
            Limits {
                sections: 10,
                per_section: 2,
                total: 10,
            },
        )
        .expect("searched");
    let row = row_of(hits.into_iter().next().expect("a hit"));
    /* A JavaScript `"😀 the whale".indexOf("whale")` is 7: two units for the
     * emoji, a space, `the`, a space. */
    assert_eq!(row.offset, 7);
    assert_eq!(row.quote, "whale");
}

#[test]
fn a_status_row_lists_the_unreadable_books_newest_first() {
    use crate::store::Store;
    let dir = tempfile::tempdir().expect("scratch");
    let mut store = Store::open(dir.path()).expect("opened");
    store.note("book:old", "g", "no text", 1).expect("noted");
    store
        .note("book:new", "g", "would not parse", 9)
        .expect("noted");
    let held = store.state();
    let mut rows: Vec<UnreadableRow> = held
        .notes
        .iter()
        .map(|(book_id, note)| UnreadableRow {
            book_id: book_id.clone(),
            why: note.why.clone(),
            at: note.at,
        })
        .collect();
    rows.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.book_id.cmp(&b.book_id)));
    assert_eq!(rows[0].book_id, "book:new");
    assert_eq!(rows[1].book_id, "book:old");
}

#[test]
fn a_refusal_carries_a_kind_the_front_end_can_branch_on() {
    /* ⚠️ **A KIND, NOT A MESSAGE.** `peer/lib/port.ts` records what a plain
     * `Error` costs across this boundary: every failure that arrived as prose
     * came out `unknown`, and every sentence written for a named cause was
     * unreachable. */
    let refused = parse_query("\"unbalanced").expect_err("bad query");
    let json = serde_json::to_value(&refused).expect("serialised");
    assert_eq!(json["kind"], "badQuery");
    assert!(json["message"].as_str().is_some_and(|m| !m.is_empty()));
}

#[test]
fn every_error_kind_has_its_own_word() {
    /* No default arm and no shared spelling: a front end that branches on these
     * must be able to tell them apart. */
    let kinds = [
        Error::NoRoot.kind(),
        Error::BadPath("x".into()).kind(),
        Error::Index("x".into()).kind(),
        Error::BadQuery("x".into()).kind(),
        Error::Damaged("x".into(), "y".into()).kind(),
        Error::Io("x".into()).kind(),
    ];
    let unique: std::collections::BTreeSet<_> = kinds.iter().collect();
    assert_eq!(unique.len(), kinds.len(), "two variants share a word");
}

#[test]
fn a_limit_is_bounded_whatever_the_caller_asks_for() {
    /* The caller is a webview and the index is the whole library; an unbounded
     * query is a main thread held for as long as the shelf is large. */
    let asked = |limit: Option<u32>| {
        limit
            .map_or(MAX_TOTAL, |n| (n as usize).min(MAX_TOTAL))
            .max(1)
    };
    assert_eq!(asked(None), MAX_TOTAL);
    assert_eq!(asked(Some(10)), 10);
    assert_eq!(asked(Some(100_000)), MAX_TOTAL);
    assert_eq!(asked(Some(0)), 1, "zero would panic tantivy's TopDocs");
}
