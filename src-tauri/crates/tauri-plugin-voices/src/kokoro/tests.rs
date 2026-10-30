//! The arithmetic that turns durations into a highlight, and the model itself.
//!
//! The pure parts are tested here with no model loaded; the model's own
//! behaviour is `#[ignore]`d and needs an installed pack:
//!
//! ```sh
//! PAPER_VOICES_PACK=/path/to/english-kokoro cargo test -p tauri-plugin-voices -- --ignored --nocapture
//! ```

use super::{
    accounted, chunks, timings_for, Kokoro, Rendered, WordTiming, FRAME_SAMPLES, SAMPLE_RATE,
};
use crate::english::{Phonemised, SpokenWord};

fn text_of(phonemes: &str, words: &[(usize, usize, usize, usize)]) -> Phonemised {
    Phonemised {
        phonemes: phonemes.to_owned(),
        words: words
            .iter()
            .map(
                |(source_start, source_len, phoneme_start, phoneme_len)| SpokenWord {
                    source_start: *source_start,
                    source_len: *source_len,
                    phoneme_start: *phoneme_start,
                    phoneme_len: *phoneme_len,
                },
            )
            .collect(),
        unknown: Vec::new(),
    }
}

#[test]
fn a_short_utterance_is_one_chunk() {
    let phonemes: Vec<char> = "ði kwˈɪk dˈɔɡ.".chars().collect();
    assert_eq!(chunks(&phonemes, 510), vec![0..phonemes.len()]);
}

#[test]
fn a_long_one_breaks_where_a_reader_would() {
    // Two sentences, split at a limit that falls inside the second.
    let text = "aaaa. bbbb, cccc dddd";
    let phonemes: Vec<char> = text.chars().collect();
    let pieces = chunks(&phonemes, 12);
    let rendered: Vec<String> = pieces
        .iter()
        .map(|r| phonemes[r.clone()].iter().collect())
        .collect();
    assert_eq!(
        rendered[0], "aaaa.",
        "the full stop is the best break available"
    );
    assert!(
        rendered[1].starts_with(' '),
        "the space begins the next piece, which costs one token"
    );
    assert!(rendered.len() >= 2);
    assert_eq!(
        rendered.concat(),
        text,
        "every phoneme is spoken exactly once"
    );
}

#[test]
fn it_falls_back_to_a_clause_then_a_space_then_wherever_it_must() {
    let clause: Vec<char> = "aaaaaa, bbbbbb".chars().collect();
    let pieces = chunks(&clause, 10);
    assert_eq!(pieces[0], 0..7, "at the comma, which the piece keeps");

    let spaced: Vec<char> = "aaaaaa bbbbbb".chars().collect();
    assert_eq!(chunks(&spaced, 10)[0], 0..7, "after the space");

    let unbroken: Vec<char> = "aaaaaaaaaaaaaaa".chars().collect();
    let pieces = chunks(&unbroken, 10);
    assert_eq!(
        pieces[0],
        0..10,
        "a word longer than the limit is cut at the limit"
    );
    assert_eq!(
        pieces.iter().map(|r| r.len()).sum::<usize>(),
        unbroken.len()
    );
}

#[test]
fn a_words_timing_comes_from_the_rounded_durations() {
    // Two words of two phonemes each: `ab cd`.
    let text = text_of("ab cd", &[(0, 2, 0, 2), (3, 2, 3, 2)]);
    // Tokens: pad a b ' ' c d pad. Two frames each, and the leading pad is four.
    let durations = vec![4.0, 2.0, 2.0, 1.0, 2.0, 2.0, 1.0];
    let timings = timings_for(&text, &(0..5), &durations, 0);
    let ms = |frames: usize| (frames * FRAME_SAMPLES * 1000 / SAMPLE_RATE as usize) as u32;
    assert_eq!(
        timings,
        vec![
            WordTiming {
                source_start: 0,
                source_len: 2,
                start_ms: ms(4),
                end_ms: ms(8)
            },
            WordTiming {
                source_start: 3,
                source_len: 2,
                start_ms: ms(9),
                end_ms: ms(13)
            },
        ]
    );
}

#[test]
fn rounding_happens_before_the_sum_and_not_after() {
    // The measured case: floats that sum to less than their rounded selves.
    let text = text_of("ab", &[(0, 2, 0, 2)]);
    let durations = vec![13.3, 1.64, 1.7, 1.0];
    let timings = timings_for(&text, &(0..2), &durations, 0);
    // Rounded: 13 before the word. Summing the floats first would give 13.3,
    // which floors to 13 here but drifts by a frame every few words.
    let ms = |frames: usize| (frames * FRAME_SAMPLES * 1000 / SAMPLE_RATE as usize) as u32;
    assert_eq!(timings[0].start_ms, ms(13));
    assert_eq!(
        timings[0].end_ms,
        ms(13 + 2 + 2),
        "1.64 and 1.7 round to 2 and 2, not to 3"
    );
}

#[test]
fn a_later_chunks_words_are_placed_after_the_earlier_ones() {
    let text = text_of("ab cd", &[(3, 2, 3, 2)]);
    let durations = vec![1.0, 2.0, 2.0, 1.0];
    let timings = timings_for(&text, &(3..5), &durations, 100);
    let ms = |frames: usize| (frames * FRAME_SAMPLES * 1000 / SAMPLE_RATE as usize) as u32;
    assert_eq!(
        timings[0].start_ms,
        ms(101),
        "the chunks before it take 100 frames"
    );
}

#[test]
fn a_word_in_another_chunk_is_not_timed_twice() {
    let text = text_of("ab cd", &[(0, 2, 0, 2), (3, 2, 3, 2)]);
    let first = timings_for(&text, &(0..3), &[1.0, 2.0, 2.0, 1.0], 0);
    let second = timings_for(&text, &(3..5), &[1.0, 2.0, 2.0, 1.0], 5);
    assert_eq!(first.len(), 1, "only the word that starts in this chunk");
    assert_eq!(second.len(), 1);
    assert_eq!(first[0].source_start, 0);
    assert_eq!(second[0].source_start, 3);
}

#[test]
fn a_render_with_no_audio_is_refused_rather_than_returned() {
    // The failure this catches is the one nobody hears until they play it: a
    // chapter of the right length holding nothing.
    let err = Rendered::gather("af_heart", Vec::new(), Vec::new()).expect_err("refused");
    let text = format!("{err}");
    assert!(
        text.contains("no audio"),
        "the refusal says what happened: {text}"
    );
    assert!(text.contains("af_heart"), "and which voice it was: {text}");
}

#[test]
fn audio_with_samples_is_gathered_at_the_models_own_rate() {
    let out = Rendered::gather("af_heart", vec![0, 1, -1], Vec::new()).expect("gathered");
    assert_eq!(out.sample_rate, SAMPLE_RATE);
    assert_eq!(out.samples.len(), 3);
}

#[test]
fn durations_that_do_not_account_for_the_samples_are_refused() {
    // 2 frames is 1 200 samples; the model claiming 1 800 is a mismatch.
    let err = accounted("af_heart", &[1.0, 1.0], 3 * FRAME_SAMPLES).expect_err("refused");
    let text = format!("{err}");
    assert!(
        text.contains("1200"),
        "the refusal shows what the durations account for: {text}"
    );
    assert!(text.contains("1800"), "and what the model answered: {text}");
}

#[test]
fn durations_are_rounded_per_token_before_they_are_summed() {
    // The measured trap: these floats sum to 2.9, which truncates to 2 frames
    // and floors to 2 — but each rounds to 1, so the audio is 3 frames long.
    let frames = accounted("af_heart", &[0.9, 1.4, 0.6], 3 * FRAME_SAMPLES).expect("accounted");
    assert_eq!(frames, 3);
    assert!(
        accounted("af_heart", &[0.9, 1.4, 0.6], 2 * FRAME_SAMPLES).is_err(),
        "summing the floats first would have accepted two frames"
    );
}

#[test]
fn a_negative_duration_counts_as_nothing_rather_than_wrapping() {
    // `as usize` on a negative float saturates to 0 in Rust, but the clamp says
    // so out loud: a duration predictor that answers below zero must not make
    // the frame count enormous.
    let frames = accounted("af_heart", &[-3.0, 2.0], 2 * FRAME_SAMPLES).expect("accounted");
    assert_eq!(frames, 2);
}

/// Where an installed pack is, if this machine has one.
fn pack_dir() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var("PAPER_VOICES_PACK").ok()?);
    dir.join("model.onnx").is_file().then_some(dir)
}

#[test]
#[ignore = "needs an installed pack; set PAPER_VOICES_PACK"]
fn the_model_speaks_and_its_durations_account_for_every_sample() {
    let Some(dir) = pack_dir() else {
        panic!(
            "set PAPER_VOICES_PACK to a directory holding model.onnx, tokenizer.json and voices/"
        );
    };
    let mut kokoro = Kokoro::load(&dir, 8).expect("the model loads");
    let front = crate::english::FrontEnd::load(&dir.join("lexicon")).expect("the lexicons load");
    let text = front.phonemise("The quick brown fox jumps over the lazy dog.");
    assert!(
        text.unknown.is_empty(),
        "this sentence is all in the lexicon"
    );

    let out = kokoro.render(&text, "af_heart", 1.0).expect("render");
    // `render` asserts the frame equality itself; this is the audible half.
    assert_eq!(out.sample_rate, SAMPLE_RATE);
    assert!(
        out.duration_ms() > 1_500,
        "a nine-word sentence is longer than this"
    );
    assert!(
        out.samples.iter().any(|s| s.abs() > 1_000),
        "silence with the right length is the failure this catches"
    );
    assert_eq!(out.words.len(), text.words.len(), "every word is placed");
    for pair in out.words.windows(2) {
        assert!(
            pair[0].start_ms <= pair[1].start_ms,
            "words are spoken in order"
        );
    }
    let last = out.words.last().expect("words");
    assert!(
        last.end_ms <= out.duration_ms() + 50,
        "the last word cannot end after the audio does"
    );
    println!(
        "{} ms of audio, {} words, first word at {} ms",
        out.duration_ms(),
        out.words.len(),
        out.words[0].start_ms
    );
}

#[test]
#[ignore = "needs an installed pack; set PAPER_VOICES_PACK"]
fn a_sound_the_model_cannot_say_is_refused_by_name() {
    let Some(dir) = pack_dir() else {
        panic!("set PAPER_VOICES_PACK")
    };
    let mut kokoro = Kokoro::load(&dir, 2).expect("the model loads");
    let text = Phonemised {
        // `ɚ` is in this model's vocabulary; `ʘ` is in nobody's.
        phonemes: "ðiʘ".to_owned(),
        words: vec![SpokenWord {
            source_start: 0,
            source_len: 3,
            phoneme_start: 0,
            phoneme_len: 3,
        }],
        unknown: Vec::new(),
    };
    let err = kokoro.render(&text, "af_heart", 1.0).expect_err("refused");
    assert!(
        format!("{err}").contains('ʘ'),
        "the refusal names the sound: {err}"
    );
}
