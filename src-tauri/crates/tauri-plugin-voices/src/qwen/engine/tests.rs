//! Every decision the engine makes, with no model anywhere.
//!
//! The bridge is a closure in these, which is the whole reason it is one: the
//! runaway guard, the re-seeding and the refusal are the parts that have to be
//! right, and none of them should need a 2.5 GB download to exercise.

use std::cell::RefCell;

use super::{
    buffer_samples, memory_allows, read, say, seed_for, to_pcm16, Attempt, Failure, ATTEMPTS,
};
use crate::qwen::text;

const RATE: u32 = 24_000;

/// Audio of a given length, at the rate the tests use.
fn audio(seconds: f64) -> Attempt {
    let count = (seconds * f64::from(RATE)) as usize;
    Attempt::Audio(vec![0.1; count], seconds)
}

/// A sentence long enough to have a meaningful band.
const SENTENCE: &str = "This is an ordinary English sentence of about this length.";

#[test]
fn a_believable_render_is_kept_on_the_first_attempt() {
    let expected = text::expected_seconds(SENTENCE);
    let calls = RefCell::new(0);
    let spoken = say(SENTENCE, RATE, |_seed, _cap, _room| {
        *calls.borrow_mut() += 1;
        audio(expected)
    })
    .expect("kept");
    assert_eq!(spoken.attempts, 1);
    assert_eq!(*calls.borrow(), 1, "a good render is not rendered twice");
    assert_eq!(spoken.text, SENTENCE);
    assert!(!spoken.samples.is_empty());
}

#[test]
fn a_runaway_is_rendered_again_with_a_different_seed() {
    let expected = text::expected_seconds(SENTENCE);
    let seeds = RefCell::new(Vec::new());
    let spoken = say(SENTENCE, RATE, |seed, _cap, _room| {
        seeds.borrow_mut().push(seed);
        // Babble first, then a sound render.
        if seeds.borrow().len() == 1 {
            audio(expected * 3.4)
        } else {
            audio(expected)
        }
    })
    .expect("the second attempt is kept");
    assert_eq!(spoken.attempts, 2);
    let seeds = seeds.borrow();
    assert_ne!(seeds[0], seeds[1], "the retry is a different draw, not the same one again");
}

#[test]
fn a_sentence_that_babbles_every_time_is_refused_by_name() {
    let expected = text::expected_seconds(SENTENCE);
    let calls = RefCell::new(0);
    let skipped = say(SENTENCE, RATE, |_seed, _cap, _room| {
        *calls.borrow_mut() += 1;
        audio(expected * 3.4)
    })
    .expect_err("refused");
    assert_eq!(*calls.borrow(), ATTEMPTS, "it is tried every time it is allowed");
    assert_eq!(skipped.text, SENTENCE, "the refusal names the sentence");
    assert!(skipped.why.contains("should take"), "and what it should have taken: {}", skipped.why);
    assert!(skipped.why.contains('s'), "with the lengths in it: {}", skipped.why);
}

#[test]
fn the_recorded_runaway_is_what_this_is_measured_against() {
    // 302 narrow characters rendered as 82.6 s, from the spike. Text of the
    // same shape, so the guard meets the real proportions.
    let text: String = "a".repeat(302);
    let skipped = say(&text, RATE, |_seed, _cap, _room| audio(82.6)).expect_err("refused");
    assert!(skipped.why.contains("82.6"), "the refusal quotes what came back: {}", skipped.why);
}

#[test]
fn a_render_the_bridge_refused_for_a_reason_that_will_not_change_is_not_retried() {
    // A model that is not loaded answers identically however often it is asked,
    // so retrying is delay with no chance of an answer.
    let calls = RefCell::new(0);
    let skipped = say(SENTENCE, RATE, |_seed, _cap, _room| {
        *calls.borrow_mut() += 1;
        Attempt::Failed(Failure::NotLoaded)
    })
    .expect_err("refused");
    assert_eq!(*calls.borrow(), 1, "asked once, not three times");
    assert!(skipped.why.contains("not loaded"), "{}", skipped.why);
}

#[test]
fn an_overflow_is_retried_because_the_next_draw_may_be_shorter() {
    let expected = text::expected_seconds(SENTENCE);
    let calls = RefCell::new(0);
    let spoken = say(SENTENCE, RATE, |_seed, _cap, _room| {
        *calls.borrow_mut() += 1;
        if *calls.borrow() == 1 {
            Attempt::Failed(Failure::Overflowed)
        } else {
            audio(expected)
        }
    })
    .expect("the second attempt is kept");
    assert_eq!(spoken.attempts, 2);
}

#[test]
fn the_cap_and_the_room_handed_to_the_bridge_match_the_sentence() {
    let seen = RefCell::new((0usize, 0usize));
    let _ = say(SENTENCE, RATE, |_seed, cap, room| {
        *seen.borrow_mut() = (cap, room);
        audio(text::expected_seconds(SENTENCE))
    });
    let (cap, room) = *seen.borrow();
    assert_eq!(cap, text::frame_cap(SENTENCE));
    assert_eq!(room, buffer_samples(cap, RATE));
    assert!(room > cap * 1_000, "the room is samples, not frames: {room} for {cap} frames");
}

#[test]
fn one_hard_sentence_does_not_end_the_passage() {
    // The point of reading a sentence at a time: the reader loses a sentence
    // and is told which, rather than losing the rest of the chapter.
    let passage = "First one. Second one. Third one.";
    let reading = read(passage, RATE, |sentence, _seed, _cap, _room| {
        if sentence.contains("Second") {
            Attempt::Failed(Failure::GenerationFailed)
        } else {
            audio(text::expected_seconds(sentence))
        }
    });
    assert_eq!(reading.spoken.len(), 2, "the other two are still read");
    assert_eq!(reading.skipped.len(), 1);
    assert!(reading.skipped[0].text.contains("Second"), "and the reader is told which");
    assert_eq!(reading.sample_rate, RATE);
}

#[test]
fn a_passage_is_read_one_sentence_at_a_time_and_not_all_at_once() {
    let asked = RefCell::new(Vec::new());
    let passage = "\u{5929}\u{6C14}\u{5F88}\u{597D}\u{3002}\u{4F60}\u{5462}\u{FF1F}";
    let reading = read(passage, RATE, |sentence, _seed, _cap, _room| {
        asked.borrow_mut().push(sentence.to_owned());
        audio(text::expected_seconds(sentence))
    });
    assert_eq!(asked.borrow().len(), 2, "two sentences, two renders: {:?}", asked.borrow());
    assert_eq!(reading.spoken.len(), 2);
    assert!(reading.skipped.is_empty());
}

#[test]
fn nothing_at_all_is_read_as_nothing_rather_than_refused() {
    let reading = read("   \n  ", RATE, |_s, _seed, _cap, _room| panic!("nothing to render"));
    assert!(reading.spoken.is_empty());
    assert!(reading.skipped.is_empty());
}

#[test]
fn a_seed_is_the_same_every_time_for_the_same_sentence() {
    // Reproducibility is the point: a reported runaway can be rendered again by
    // whoever looks into it, and a book does not change between readings.
    assert_eq!(seed_for(SENTENCE, 0), seed_for(SENTENCE, 0));
    assert_ne!(seed_for(SENTENCE, 0), seed_for(SENTENCE, 1));
    assert_ne!(seed_for(SENTENCE, 0), seed_for("another sentence entirely.", 0));
    for attempt in 0..ATTEMPTS {
        assert_ne!(seed_for("", attempt), 0, "a seed is never the value that means uninitialised");
    }
}

#[test]
fn a_code_from_the_bridge_is_named_not_numbered() {
    // These five numbers are the Swift file's `Failure`. A skew between the two
    // must read as a version problem and not as a model that failed.
    assert_eq!(Failure::of(-1), Failure::NotLoaded);
    assert_eq!(Failure::of(-2), Failure::BadArgument);
    assert_eq!(Failure::of(-3), Failure::GenerationFailed);
    assert_eq!(Failure::of(-4), Failure::Overflowed);
    assert_eq!(Failure::of(-5), Failure::NoAudio);
    assert_eq!(Failure::of(-99), Failure::Unknown(-99));
    assert!(Failure::of(-99).why().contains("-99"), "an unknown code is quoted");
    assert!(Failure::of(-99).why().contains("version"), "and read as a skew");
    assert!(!Failure::Unknown(-99).worth_retrying(), "an unknown answer is not retried blindly");
}

#[test]
fn samples_past_full_scale_are_clamped_rather_than_wrapped() {
    // Wrapping turns a fraction of a decibel of clipping into a loud click.
    let pcm = to_pcm16(&[0.0, 1.0, -1.0, 2.0, -2.0, f32::INFINITY, f32::NEG_INFINITY]);
    assert_eq!(pcm, vec![0, 32767, -32767, 32767, -32767, 32767, -32767]);
}

#[test]
fn a_not_a_number_sample_does_not_become_a_loud_one() {
    let pcm = to_pcm16(&[f32::NAN]);
    assert_eq!(pcm.len(), 1);
    assert!(pcm[0].abs() < 1_000, "a NaN sample came out as {}", pcm[0]);
}

#[test]
fn the_buffer_has_room_for_every_frame_the_cap_allows() {
    for frames in [1, 13, 125, 1_200] {
        let room = buffer_samples(frames, RATE);
        let seconds = frames as f64 / text::FRAMES_PER_SECOND;
        assert!(
            room >= (seconds * f64::from(RATE)) as usize,
            "{frames} frames is {seconds} s, which needs more than {room} samples"
        );
    }
}

#[test]
fn a_mac_with_too_little_memory_is_told_both_numbers() {
    let err = memory_allows(8, 4, "chinese-qwen").expect_err("refused");
    let text = format!("{err}");
    assert!(text.contains('8') && text.contains('4'), "both numbers are named: {text}");
    assert!(text.contains("chinese-qwen"), "and the pack: {text}");
    memory_allows(8, 8, "chinese-qwen").expect("exactly enough is enough");
    memory_allows(8, 16, "chinese-qwen").expect("more than enough");
}

#[cfg(not(all(target_os = "macos", qwen_bridge)))]
#[test]
fn without_the_bridge_the_voice_refuses_by_name_rather_than_being_absent() {
    let err = super::load(std::path::Path::new("/anywhere")).expect_err("refused");
    let text = format!("{err}");
    assert!(text.contains("no Chinese voice"), "the refusal says the BUILD has none: {text}");
    assert!(text.contains("macOS"), "and what a build that has one needs: {text}");
    super::unload();
}

#[cfg(all(target_os = "macos", qwen_bridge))]
#[test]
fn the_bridge_is_linked_in_and_answers() {
    // This is the assertion, not a nicety. Every test above drives the engine
    // through a closure, so none of them needs the Swift half — and a test
    // binary that references no bridge symbol LINKS PERFECTLY WITHOUT IT.
    // Measured while building this: 32 green tests over an engine that was not
    // connected to anything. Calling across the boundary once is what makes a
    // missing `build.rs`, a failed Swift build or a renamed entry point fail
    // here rather than in the app.
    //
    // A directory with no `config.json` is refused by `TTS.loadModel`, so this
    // costs a failed lookup and loads no model.
    let err = super::load(std::path::Path::new("/nonexistent/paper-voices-pack"))
        .expect_err("a pack that is not there cannot load");
    let text = format!("{err}");
    assert!(text.contains("nonexistent"), "the refusal names the path: {text}");
}
