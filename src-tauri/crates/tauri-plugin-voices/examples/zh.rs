//! Read a passage with an installed Qwen pack, one sentence at a time.
//!
//! ```sh
//! cargo run --release -p tauri-plugin-voices --example zh -- \
//!     /tmp/paper-voices-pack/chinese-qwen Vivian zh passage.txt out.wav
//! ```
//!
//! Every sentence goes through the guards: its own frame cap, its own duration
//! check, another seed if the model runs away, and a refusal by name after
//! three tries. What is refused is printed rather than quietly missing.

use std::io::Write;
use std::time::Instant;

use tauri_plugin_voices::qwen::engine::{self, Attempt};
use tauri_plugin_voices::qwen::text;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(pack), Some(voice), Some(language), Some(input), Some(output)) =
        (args.next(), args.next(), args.next(), args.next(), args.next())
    else {
        eprintln!("usage: zh <pack dir> <voice> <language> <text file> <out.wav>");
        std::process::exit(2);
    };
    let passage = std::fs::read_to_string(&input)?;
    let passage = passage.trim();

    let started = Instant::now();
    let sample_rate = engine::load(std::path::Path::new(&pack))?;
    println!("loaded in {:.1} s, {sample_rate} Hz", started.elapsed().as_secs_f64());

    let pieces = text::sentences(passage);
    println!("{} sentence(s), expecting {:.1} s of audio", pieces.len(), text::expected_seconds(passage));

    // A way to make the model overrun on purpose, so the refusal path can be
    // measured through the REAL bridge rather than only against a stub. It
    // lives here, in a harness, and not in the library: shrinking the cap is
    // not a thing the app may ever do.
    let scale: f64 = std::env::var("PAPER_VOICES_CAP_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);
    // Shrinking the BUFFER rather than the cap is what forces the overflow:
    // the model still generates a full sentence, and there is nowhere to put
    // it. Shrinking the cap forces the other direction — a render that stops
    // early — and both end at the same guard.
    let room_scale: f64 = std::env::var("PAPER_VOICES_ROOM_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);
    if (scale - 1.0).abs() > f64::EPSILON || (room_scale - 1.0).abs() > f64::EPSILON {
        println!("forcing a failure: cap x{scale}, buffer x{room_scale}");
    }

    let started = Instant::now();
    let reading = engine::read(passage, sample_rate, |sentence, seed, cap, room| {
        let at = Instant::now();
        let cap = ((cap as f64 * scale).ceil() as usize).max(1);
        let room = ((room as f64 * room_scale).ceil() as usize).max(1);
        let attempt = engine::through_bridge(sentence, &voice, &language, sample_rate, seed, cap, room);
        match &attempt {
            Attempt::Audio(_, seconds) => println!(
                "  {seconds:6.2} s of audio in {:5.1} s — {}",
                at.elapsed().as_secs_f64(),
                sentence.chars().take(24).collect::<String>()
            ),
            Attempt::Failed(failure) => println!("  refused: {}", failure.why()),
        }
        attempt
    });
    let elapsed = started.elapsed().as_secs_f64();

    let samples: Vec<i16> = reading.spoken.iter().flat_map(|s| s.samples.iter().copied()).collect();
    let seconds = samples.len() as f64 / f64::from(sample_rate);
    let retried: u32 = reading.spoken.iter().map(|s| s.attempts - 1).sum();
    println!(
        "{seconds:.2} s of audio in {elapsed:.1} s (RTF {:.3}), {} sentence(s) said, {} re-seeded, {} refused",
        elapsed / seconds.max(0.001),
        reading.spoken.len(),
        retried,
        reading.skipped.len()
    );
    for skipped in &reading.skipped {
        println!("  SKIPPED «{}» — {}", skipped.text.trim(), skipped.why);
    }
    if samples.is_empty() {
        engine::unload();
        return Err("nothing was said at all".into());
    }

    let mut wav = std::io::BufWriter::new(std::fs::File::create(&output)?);
    let data = samples.len() * 2;
    wav.write_all(b"RIFF")?;
    wav.write_all(&u32::try_from(36 + data)?.to_le_bytes())?;
    wav.write_all(b"WAVEfmt ")?;
    wav.write_all(&16u32.to_le_bytes())?;
    wav.write_all(&1u16.to_le_bytes())?;
    wav.write_all(&1u16.to_le_bytes())?;
    wav.write_all(&sample_rate.to_le_bytes())?;
    wav.write_all(&(sample_rate * 2).to_le_bytes())?;
    wav.write_all(&2u16.to_le_bytes())?;
    wav.write_all(&16u16.to_le_bytes())?;
    wav.write_all(b"data")?;
    wav.write_all(&u32::try_from(data)?.to_le_bytes())?;
    for sample in &samples {
        wav.write_all(&sample.to_le_bytes())?;
    }
    wav.flush()?;
    println!("wrote {output}");

    // The memory is the reader's: ask for it back, and say so, because an
    // engine that is merely idle looks to the machine exactly like one reading.
    // A pause either side of the unload, so a watcher sampling this process's
    // resident size can see what it gave back. Without it the process exits
    // within milliseconds and "the memory comes back" stays a claim.
    if let Some(seconds) = std::env::var("PAPER_VOICES_LINGER_S").ok().and_then(|s| s.parse().ok()) {
        println!("holding the model for {seconds} s");
        std::thread::sleep(std::time::Duration::from_secs_f64(seconds));
    }
    engine::unload();
    println!("unloaded");
    if let Some(seconds) = std::env::var("PAPER_VOICES_LINGER_S").ok().and_then(|s| s.parse().ok()) {
        std::thread::sleep(std::time::Duration::from_secs_f64(seconds));
    }
    Ok(())
}
