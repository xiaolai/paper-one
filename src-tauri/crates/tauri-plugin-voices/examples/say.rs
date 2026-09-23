//! Speak a file with an installed pack, and write a WAV beside its timings.
//!
//! The way to hear what the engine does without the app:
//!
//! ```sh
//! cargo run -p tauri-plugin-voices --example say -- \
//!     /path/to/english-kokoro af_heart passage.txt out.wav
//! ```
//!
//! It prints the render's speed and every word's place, which is what a claim
//! about following along on the page has to be checked against.

use std::io::Write;
use std::time::Instant;

use tauri_plugin_voices::english::FrontEnd;
use tauri_plugin_voices::kokoro::Kokoro;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (pack, voice, input, output) = match (args.next(), args.next(), args.next(), args.next()) {
        (Some(p), Some(v), Some(i), Some(o)) => (p, v, i, o),
        _ => {
            eprintln!("usage: say <pack dir> <voice> <text file> <out.wav>");
            std::process::exit(2);
        }
    };
    let pack = std::path::PathBuf::from(pack);
    let text = std::fs::read_to_string(&input)?;

    let front = FrontEnd::load(&pack.join("lexicon"))?;
    let prepared = front.phonemise(text.trim());
    if !prepared.unknown.is_empty() {
        eprintln!("words with no pronunciation: {}", prepared.unknown.join(", "));
    }

    let threads: usize = std::env::var("PAPER_VOICES_THREADS")
        .ok()
        .and_then(|t| t.parse().ok())
        .unwrap_or(8);
    let mut kokoro = Kokoro::load(&pack, threads)?;
    let started = Instant::now();
    let rendered = kokoro.render(&prepared, &voice, 1.0)?;
    let elapsed = started.elapsed().as_secs_f64();
    let seconds = f64::from(rendered.duration_ms()) / 1000.0;
    println!(
        "{seconds:.3} s of audio in {elapsed:.3} s (RTF {:.3}), {} words, {threads} threads",
        elapsed / seconds,
        rendered.words.len()
    );

    // 16-bit mono, the shape the audiobook packer already accepts.
    let mut wav = std::io::BufWriter::new(std::fs::File::create(&output)?);
    let data = rendered.samples.len() * 2;
    wav.write_all(b"RIFF")?;
    wav.write_all(&u32::try_from(36 + data)?.to_le_bytes())?;
    wav.write_all(b"WAVEfmt ")?;
    wav.write_all(&16u32.to_le_bytes())?;
    wav.write_all(&1u16.to_le_bytes())?;
    wav.write_all(&1u16.to_le_bytes())?;
    wav.write_all(&rendered.sample_rate.to_le_bytes())?;
    wav.write_all(&(rendered.sample_rate * 2).to_le_bytes())?;
    wav.write_all(&2u16.to_le_bytes())?;
    wav.write_all(&16u16.to_le_bytes())?;
    wav.write_all(b"data")?;
    wav.write_all(&u32::try_from(data)?.to_le_bytes())?;
    for sample in &rendered.samples {
        wav.write_all(&sample.to_le_bytes())?;
    }
    wav.flush()?;

    // The timings index the source in UTF-16, which is what a web front end
    // counts in, so the word is read back the same way rather than by bytes.
    let utf16: Vec<u16> = text.encode_utf16().collect();
    let timings: Vec<serde_json::Value> = rendered
        .words
        .iter()
        .map(|w| {
            let word = String::from_utf16_lossy(&utf16[w.source_start..w.source_start + w.source_len]);
            serde_json::json!({"word": word, "startMs": w.start_ms, "endMs": w.end_ms})
        })
        .collect();
    std::fs::write(
        format!("{output}.words.json"),
        serde_json::to_vec_pretty(&timings)?,
    )?;
    println!("wrote {output} and its word timings");
    Ok(())
}
