//! Install a voice pack from the embedded catalogue, into a directory.
//!
//! ```sh
//! cargo run -p tauri-plugin-voices --example get -- chinese-qwen /tmp/paper-voices
//! ```
//!
//! The same code path the app uses, so a pack fetched here is one the engines
//! can load: every byte is checked against the manifest's digest and promoted
//! by rename, and a stopped run leaves nothing half-installed.

use std::time::Instant;

use tauri_plugin_voices::cancel::Cancel;
use tauri_plugin_voices::install::{install, installed, Progress};
use tauri_plugin_voices::manifest;
use tauri_plugin_voices::paths::Layout;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(id), Some(root)) = (args.next(), args.next()) else {
        eprintln!("usage: get <pack id> <directory>");
        eprintln!(
            "packs: {}",
            manifest::embedded()
                .packs
                .iter()
                .map(|p| p.id.clone())
                .collect::<Vec<_>>()
                .join(", ")
        );
        std::process::exit(2);
    };

    let catalogue = manifest::embedded();
    let pack = catalogue
        .packs
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("no pack called {id}"))?;
    let layout = Layout::under(std::path::Path::new(&root));
    layout.ensure()?;

    let total: u64 = pack.artifacts.iter().map(|a| a.bytes).sum();
    println!(
        "{} — {} files, {:.1} MB",
        pack.name,
        pack.artifacts.len(),
        total as f64 / 1_048_576.0
    );
    if installed(&layout, pack)? {
        println!(
            "already installed at {}",
            layout.pack_dir(&pack.id)?.display()
        );
        return Ok(());
    }

    let started = Instant::now();
    let client = reqwest::Client::new();
    let (cancel, _stopper) = Cancel::new();
    let mut last = 0u64;
    install(&client, &layout, pack, &cancel, |progress| match progress {
        Progress::Downloading { received, total } => {
            // A line per 25 MB: enough to see it moving, few enough to read.
            if received - last > 26_214_400 {
                last = received;
                let share = if total > 0 {
                    received as f64 / total as f64 * 100.0
                } else {
                    0.0
                };
                println!(
                    "  {:.0} MB of {:.0} MB ({share:.0}%)",
                    received as f64 / 1_048_576.0,
                    total as f64 / 1_048_576.0
                );
            }
        }
        Progress::Verifying => println!("  checking every byte against the manifest"),
        Progress::Installed => println!("  installed"),
    })
    .await?;
    println!(
        "{} in {:.0} s at {}",
        pack.id,
        started.elapsed().as_secs_f64(),
        layout.pack_dir(&pack.id)?.display()
    );
    Ok(())
}
