//! The guards, against the spike's own renders.
//!
//! The measured cases carry the real numbers from WI-30.0 rather than invented
//! ones, so a change to a constant fails against what the model actually did.

use super::{band, expected_seconds, frame_cap, sentences, verdict, Verdict, FRAMES_PER_SECOND};

/// The five passages the listening page used: (text length by script, the
/// seconds Qwen really took over every healthy render of it).
///
/// `en2` is absent because no Qwen render of it was made.
const MEASURED: &[(&str, usize, usize, f64, f64)] = &[
    // name, wide chars, narrow chars, fastest render, slowest healthy render
    ("en1", 0, 525, 39.4, 52.2),
    ("en3", 0, 302, 20.1, 24.7),
    ("zh1", 109, 0, 23.5, 30.3),
    ("zh2", 24, 27, 8.8, 12.2),
];

/// Text of the right shape, since the guards count characters and not words.
fn of(wide: usize, narrow: usize) -> String {
    "\u{4E2D}".repeat(wide) + &"a".repeat(narrow)
}

#[test]
fn every_healthy_render_the_spike_made_is_inside_the_band() {
    for (name, wide, narrow, fastest, slowest) in MEASURED {
        let text = of(*wide, *narrow);
        let (low, high) = band(&text);
        assert!(
            *fastest >= low && *slowest <= high,
            "{name}: real renders took {fastest}-{slowest} s, band is {low:.1}-{high:.1} s"
        );
        assert_eq!(verdict(&text, *fastest, 0), Verdict::Keep, "{name} fastest");
        assert_eq!(verdict(&text, *slowest, 0), Verdict::Keep, "{name} slowest");
    }
}

#[test]
fn both_recorded_runaways_are_caught() {
    // en3, 302 narrow characters: the Rust+Metal render ran 82.6 s and the
    // 8-bit one 75.8 s, where every healthy render of it took 20-25 s.
    let text = of(0, 302);
    for seconds in [82.6, 75.8] {
        assert_eq!(verdict(&text, seconds, 2), Verdict::Again, "{seconds} s should be re-rendered");
        assert_eq!(verdict(&text, seconds, 0), Verdict::Refuse, "{seconds} s with no attempts left");
    }
}

#[test]
fn the_widest_healthy_reading_and_the_closest_runaway_do_not_touch() {
    // The separation the band is drawn in: 1.63x measured healthy (the mixed
    // passage) against 3.14x measured babble. If a future constant closes that
    // gap, this fails rather than the app refusing good renders.
    let text = of(24, 27);
    let expected = expected_seconds(&text);
    let (_, high) = band(&text);
    assert!(high > expected * 1.63, "the mixed passage's real 1.63x must be kept");
    // The nearer runaway ran 75.8 s against 24.2 s expected, so 3.13 is its
    // ratio rounded DOWN — the conservative side, and far enough from 3.14 that
    // clippy stops reading the literal as an approximation of pi.
    let nearest_runaway = 3.13_f64;
    assert!(high < expected * nearest_runaway, "the nearest runaway must still be refused");
}

#[test]
fn a_render_that_stopped_early_is_not_kept() {
    // Truncation loses words silently, which is the failure the floor exists
    // for: half a sentence sounds like a sentence.
    let text = of(0, 302);
    assert_eq!(verdict(&text, 2.0, 1), Verdict::Again);
    assert_eq!(verdict(&text, 2.0, 0), Verdict::Refuse);
}

#[test]
fn a_render_at_half_its_length_is_refused() {
    // The measured case that moved the floor: a real sentence capped short came
    // back at 0.49x and was kept, because the floor was 0.4. It is cut off
    // mid-clause, and the reader is told nothing.
    let text = of(24, 27);
    let expected = expected_seconds(&text);
    assert_eq!(verdict(&text, expected * 0.49, 0), Verdict::Refuse);
    // And the slowest render ever measured here still passes, with margin.
    assert_eq!(verdict(&text, expected * 0.83, 0), Verdict::Keep);
}

#[test]
fn a_length_that_is_not_a_number_is_refused_rather_than_compared() {
    // Every comparison against NaN is false, so a bare `> high` test would call
    // it sound. The engine's C boundary can hand back a NaN.
    let text = of(0, 100);
    assert_eq!(verdict(&text, f64::NAN, 0), Verdict::Refuse);
    assert_eq!(verdict(&text, f64::INFINITY, 0), Verdict::Refuse);
    assert_eq!(verdict(&text, f64::NAN, 3), Verdict::Again);
}

#[test]
fn script_decides_the_rate_and_not_the_declared_language() {
    // The reason this is not one rate per language: the same count of
    // characters takes very different time in the two scripts, and a Chinese
    // book is full of Latin.
    let wide = expected_seconds(&of(100, 0));
    let narrow = expected_seconds(&of(0, 100));
    assert!(wide > narrow * 2.5, "{wide} s of Han against {narrow} s of Latin");
    // Mixed text is the sum of its parts, not either rate over the whole.
    let mixed = expected_seconds(&of(50, 50));
    assert!((mixed - (wide + narrow) / 2.0).abs() < 1e-9);
}

#[test]
fn whitespace_is_said_by_nobody() {
    assert!((expected_seconds("a b c") - expected_seconds("abc")).abs() < 1e-9);
    assert!((expected_seconds("  \n\t") - 0.0).abs() < 1e-9);
}

#[test]
fn the_cap_is_above_the_refusal_bound_rather_than_equal_to_it() {
    // A cap at the bound truncates a runaway to exactly the maximum allowed
    // length, which the duration check then reads as a long sentence. The
    // runaway has to be able to exceed the bound to be recognised.
    let text = of(0, 302);
    let (_, high) = band(&text);
    let cap_seconds = frame_cap(&text) as f64 / FRAMES_PER_SECOND;
    assert!(cap_seconds > high, "cap {cap_seconds:.1} s must exceed the bound {high:.1} s");
    assert_eq!(verdict(&text, high + 0.1, 0), Verdict::Refuse, "and the excess is refused");
}

#[test]
fn even_empty_text_gets_a_frame_to_say_nothing_in() {
    // A cap of zero would be handed to the model as no bound at all.
    assert!(frame_cap("") >= 1);
    assert!(frame_cap("   ") >= 1);
}

#[test]
fn a_short_sentence_is_allowed_its_lead_in_and_tail() {
    // Two characters is a fifth of a second of speech, and every render carries
    // silence at both ends. Without the overhead allowance this is refused for
    // being a second long.
    let (_, high) = band("\u{597D}\u{7684}");
    assert!(high > 1.5, "a two-character sentence may take {high:.2} s");
}

#[test]
fn a_paragraph_is_split_into_sentences_that_rejoin_exactly() {
    let text = "He left. She stayed! Did they? Yes\u{2026} Then night fell.";
    let pieces = sentences(text);
    assert_eq!(pieces.len(), 5, "{pieces:?}");
    assert_eq!(pieces.concat(), text, "nothing is lost or duplicated in splitting");
    assert!(pieces[0].ends_with('.'), "the mark stays with its sentence: {:?}", pieces[0]);
}

#[test]
fn chinese_marks_end_a_sentence_too() {
    let text = "\u{5929}\u{6C14}\u{5F88}\u{597D}\u{3002}\u{4F60}\u{5462}\u{FF1F}\u{597D}\u{FF01}";
    let pieces = sentences(text);
    assert_eq!(pieces.len(), 3, "{pieces:?}");
    assert_eq!(pieces.concat(), text);
}

#[test]
fn a_closing_quotation_belongs_to_the_sentence_it_ends() {
    let text = "\u{300C}\u{597D}\u{3002}\u{300D}\u{4ED6}\u{8BF4}\u{3002}";
    let pieces = sentences(text);
    assert_eq!(pieces.len(), 2, "{pieces:?}");
    assert!(pieces[0].ends_with('\u{300D}'), "the bracket closes the first: {:?}", pieces[0]);
    assert_eq!(pieces.concat(), text);
}

#[test]
fn a_run_of_marks_is_one_ending() {
    let text = "Really?! Yes\u{2026}\u{2026} Fine.";
    let pieces = sentences(text);
    assert_eq!(pieces.len(), 3, "{pieces:?}");
    assert_eq!(pieces.concat(), text);
}

#[test]
fn text_with_no_mark_at_all_is_still_one_piece() {
    assert_eq!(sentences("no mark here"), vec!["no mark here"]);
    assert!(sentences("").is_empty(), "and nothing is not a sentence");
    assert!(sentences("   \n  ").is_empty(), "nor is whitespace");
}

#[test]
fn every_sentence_gets_its_own_cap() {
    // The point of splitting: a runaway costs one sentence, not the paragraph.
    let text = "\u{5929}\u{6C14}\u{5F88}\u{597D}\u{3002}This is a much longer English sentence about it.";
    let pieces = sentences(text);
    assert_eq!(pieces.len(), 2);
    assert!(
        frame_cap(pieces[1]) > frame_cap(pieces[0]),
        "the longer piece gets the larger cap: {} vs {}",
        frame_cap(pieces[1]),
        frame_cap(pieces[0])
    );
    assert!(
        frame_cap(text) < frame_cap(pieces[0]) + frame_cap(pieces[1]),
        "and each is tighter than one cap over the whole"
    );
}
