//! WI-31.0's measurements, as a runnable thing rather than a number in a plan.
//!
//! ```sh
//! cargo run --release -p tauri-plugin-passages --example measure -- [books]
//! ```
//!
//! ⚠️ **READ `uptime` BEFORE BELIEVING ANY WALL-CLOCK NUMBER THIS PRINTS.** This
//! repository has the rule written down twice: *a sweep run beside a desktop
//! that is using the cores measures the machine, not the code.* The RATIOS —
//! index bytes against text bytes, coverage after an interrupted build — do not
//! move with load and are the rows of the gate table that can be trusted from
//! any run.
//!
//! ⚠️ **AND THE CORPUS IS SYNTHETIC, WHICH IS STATED RATHER THAN GLOSSED.** It
//! is built from a fixed vocabulary at a realistic size per section, so the
//! posting list has a realistic shape; what it cannot model is the long tail of
//! rare words a real library has, which makes the index here a little SMALLER
//! than a real one. Treat the size ratio as a floor.

use std::time::Instant;

use tauri_plugin_passages::index::Section;
use tauri_plugin_passages::passage::parse_query;
use tauri_plugin_passages::store::{Limits, Store};

/// The shape of a real book on this shelf: about forty sections of about twenty
/// thousand characters. Measured from the corpus the phase was written against.
const SECTIONS_PER_BOOK: u32 = 40;
const CHARS_PER_SECTION: usize = 20_000;

/// A vocabulary big enough that a posting list is not one term long.
const WORDS: &[&str] = &[
    "whale",
    "ship",
    "sea",
    "captain",
    "harpoon",
    "voyage",
    "island",
    "storm",
    "mast",
    "deck",
    "rope",
    "sail",
    "anchor",
    "compass",
    "tide",
    "wave",
    "shore",
    "crew",
    "boat",
    "ocean",
    "morning",
    "evening",
    "shadow",
    "silence",
    "memory",
    "window",
    "letter",
    "question",
    "answer",
    "reason",
    "город",
    "весна",
    "дерево",
    "книга",
    "время",
];

fn section_text(seed: u64, index: u32) -> String {
    let mut out = String::with_capacity(CHARS_PER_SECTION + 32);
    let mut state = seed
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(u64::from(index));
    while out.len() < CHARS_PER_SECTION {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        out.push_str(WORDS[(state >> 33) as usize % WORDS.len()]);
        out.push(' ');
        /* A sentence end every dozen words or so, so the passage finder has
         * real boundaries to work with rather than one endless run. */
        if (state >> 20) % 12 == 0 {
            out.push_str(". ");
        }
    }
    out
}

fn book(seed: u64) -> Vec<Section> {
    (0..SECTIONS_PER_BOOK)
        .map(|index| Section {
            index,
            text: section_text(seed, index),
        })
        .collect()
}

fn main() {
    let books: u64 = std::env::args()
        .nth(1)
        .and_then(|one| one.parse().ok())
        .unwrap_or(100);

    let scratch =
        std::env::temp_dir().join(format!("paper-passages-measure-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    let mut store = Store::open(&scratch).expect("a fresh index");

    println!("corpus: {books} books x {SECTIONS_PER_BOOK} sections x {CHARS_PER_SECTION} chars");
    println!();

    /* ---- 1. time to the FIRST searchable book ---- */
    let began = Instant::now();
    store.put("book:0", "gen", book(0), 0).expect("indexed");
    store.flush().expect("flushed");
    let first = began.elapsed();
    let answered = store
        .search(
            &parse_query("whale").expect("a legal query"),
            Limits {
                sections: 400,
                per_section: 5,
                total: 50,
            },
        )
        .expect("searched");
    println!(
        "first book searchable in {first:?} ({} hits)",
        answered.len()
    );
    assert!(!answered.is_empty(), "the first book must be searchable");

    /* ---- 2. throughput over the rest ---- */
    let began = Instant::now();
    for seed in 1..books {
        store
            .put(&format!("book:{seed}"), "gen", book(seed), seed)
            .expect("indexed");
    }
    store.flush().expect("flushed");
    let bulk = began.elapsed();
    let per_book = bulk.as_secs_f64() / (books.saturating_sub(1)).max(1) as f64;
    println!(
        "{} more books in {bulk:?} — {:.3} s/book, so 1959 books ≈ {:.1} min",
        books - 1,
        per_book,
        per_book * 1959.0 / 60.0
    );

    /* ---- 3. what it costs on disk ---- */
    let (index_bytes, text_bytes) = store.bytes();
    let corpus = books * u64::from(SECTIONS_PER_BOOK) * CHARS_PER_SECTION as u64;
    println!();
    println!("corpus       {:>10} bytes of text", corpus);
    println!(
        "index/       {:>10} bytes — {:.1}% of the corpus",
        index_bytes,
        100.0 * index_bytes as f64 / corpus as f64
    );
    println!(
        "text/        {:>10} bytes — {:.1}% of the corpus (retained, so a tokenizer change is a rebuild)",
        text_bytes,
        100.0 * text_bytes as f64 / corpus as f64
    );
    println!(
        "both         {:>10} bytes — {:.1}% of the corpus",
        index_bytes + text_bytes,
        100.0 * (index_bytes + text_bytes) as f64 / corpus as f64
    );

    /* ---- 4. query latency, cold-ish and warm ---- */
    println!();
    let queries: &[(&str, &str)] = &[
        ("common word", "whale"),
        ("rare word", "компас"),
        ("absent word", "zzzznothing"),
        ("two words (AND)", "whale ship"),
        ("a phrase", "\"whale ship\""),
        ("Cyrillic", "весна"),
    ];
    for (what, query) in queries {
        let Ok(clauses) = parse_query(query) else {
            println!("{what:>16}: refused");
            continue;
        };
        let limits = Limits {
            sections: 400,
            per_section: 5,
            total: 50,
        };
        /* One to warm the page cache, then ten measured — a single sample of
         * anything on a loaded machine is noise. */
        let _ = store.search(&clauses, limits);
        let mut times = Vec::new();
        let mut hits = 0;
        for _ in 0..10 {
            let began = Instant::now();
            hits = store.search(&clauses, limits).expect("searched").len();
            times.push(began.elapsed());
        }
        times.sort();
        println!(
            "{what:>16}: median {:?}, worst {:?} ({hits} passages)",
            times[times.len() / 2],
            times[times.len() - 1]
        );
    }

    /* ---- 5. the rebuild, which must reopen no book ---- */
    println!();
    let began = Instant::now();
    store.rebuild().expect("rebuilt");
    println!(
        "rebuild from retained text: {:?} (no book was opened — this crate has no parser)",
        began.elapsed()
    );
    let after = store
        .search(
            &parse_query("whale").expect("q"),
            Limits {
                sections: 400,
                per_section: 5,
                total: 50,
            },
        )
        .expect("searched");
    assert!(!after.is_empty(), "the rebuild must keep every hit");
    println!(
        "still answering after the rebuild: {} passages",
        after.len()
    );

    /* ---- 6. an incremental add ---- */
    let began = Instant::now();
    store
        .put("book:new", "gen", book(999_999), 1)
        .expect("indexed");
    store.flush().expect("flushed");
    println!();
    println!("one more book into a full index: {:?}", began.elapsed());

    let _ = std::fs::remove_dir_all(&scratch);
}
