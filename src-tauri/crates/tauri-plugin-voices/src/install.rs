//! Downloading a pack, and the three states a reader sees while it happens.
//!
//! Recovered from the deleted `tauri-plugin-inference`, whose comments record
//! what each rule cost to learn. Bytes land in `staging/`, are verified there,
//! and only a verified file is renamed into `packs/` — which is what makes *"a
//! stopped download leaves no half-installed pack"* true by construction rather
//! than by a cleanup pass that has to run.
//!
//! # Progress is a count, not a bar
//!
//! What this module emits is two numbers and nothing about how to draw them:
//! `Downloading · 412 MB of 2.3 GB` in the same slot the Settings section writes
//! its other facts into.
//!
//! # Resume is safe here because verification is unconditional
//!
//! A 2.5 GB download that fails at 90 % and starts over is a real reader
//! problem, so a partial file IS resumed with a `Range` request. That would be
//! dangerous in a design where the resumed bytes were trusted — a partial from a
//! different URL, a server that renumbered its ranges — but every artifact is
//! SHA-256'd before it is promoted, so wrong bytes cannot reach a pack. They
//! cost a re-download, which is exactly what refusing to resume would have cost.
//!
//! A server that ignores `Range` and answers `200` instead of `206` is handled
//! by truncating and starting again, rather than by appending a whole file onto
//! a partial one — which is the specific corruption an unchecked resume makes.

use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::cancel::Cancel;
use crate::digest::{self, Expected};
use crate::error::{Error, Result};
use crate::manifest::{Artifact, Pack};
use crate::paths::Layout;

/// How often to report progress, in bytes received.
///
/// Every chunk would be thousands of messages for one download; every megabyte
/// is a number that moves visibly without the channel becoming the expensive
/// part of the operation.
const PROGRESS_EVERY: u64 = 1_000_000;

/// What the reader is told while a pack arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Progress {
    /// Bytes so far, and the total the catalogue declared. Both across ALL of the
    /// pack's artifacts, so a twelve-file pack reports one number pair rather
    /// than restarting at zero eleven times.
    Downloading { received: u64, total: u64 },
    /// Hashing. Separate from `Downloading` because it is not instant on 2.5 GB
    /// and a count that stopped moving reads as a stall.
    Verifying,
    /// Done, and every file is where the engine will look for it.
    Installed,
}

/// Download and verify every artifact of `pack`, then put them all in place.
///
/// Nothing is promoted until every artifact has verified: a pack whose model
/// arrived and whose voices did not is not installed, and a half-installed pack
/// would be offered as a voice that fails when pressed.
///
/// # Errors
/// The first failure, named — see [`Error`]. [`Error::Cancelled`] if the reader
/// stopped it, which leaves the partial files in `staging/` where they are a
/// legitimate resume point and nothing loads them.
pub async fn install(
    client: &reqwest::Client,
    layout: &Layout,
    pack: &Pack,
    cancel: &Cancel,
    mut report: impl FnMut(Progress),
) -> Result<()> {
    layout.ensure()?;
    let total = pack.total_bytes();
    let mut received_before = 0u64;

    // Staged first, ALL of them, then promoted. See the doc comment.
    let mut staged = Vec::new();
    for artifact in &pack.artifacts {
        cancel.check()?;
        let path = layout.staging_path(&pack.id, &artifact.path)?;
        fetch(client, artifact, &path, cancel, |received| {
            report(Progress::Downloading {
                received: received_before + received,
                total,
            });
        })
        .await?;
        received_before += artifact.bytes;
        staged.push((artifact, path));
    }

    report(Progress::Verifying);
    for (artifact, path) in &staged {
        cancel.check()?;
        if let Err(failure) = digest::verify(path, &expected(artifact)).await {
            /* THE STAGED FILE IS DELETED ON A FAILED VERIFY, and without this
             * the install was UNRECOVERABLE: `fetch` skips a staged file that
             * already has the declared size, so a file of the right length and
             * the wrong bytes — a truncated-then-padded resume, a captive
             * portal's error page of exactly that size, a corrupted write —
             * would be re-verified and re-rejected on every retry, for ever,
             * with no way for the reader to clear it. */
            let _ = tokio::fs::remove_file(path).await;
            return Err(failure);
        }
    }

    /* Every artifact is good. Promote them — a rename each, which is the
     * cheapest and least interruptible thing left to do.
     *
     * ROLLED BACK AS A SET. A pack is not half-installed: a model and its
     * voices are one thing, and leaving a new model beside an old voice is a
     * pairing neither version was tested with.
     *
     * EVERY promoted target is recorded, not only the ones that displaced a
     * predecessor: otherwise a later failure leaves a target this loop had
     * NEWLY created in place. `Option` distinguishes "put the old one back"
     * from "take the new one away". */
    let mut promoted: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    for (artifact, path) in &staged {
        let target = layout.pack_path(&pack.id, &artifact.path)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // The displaced file is kept aside rather than overwritten, so a later
        // failure in this loop has something to put back.
        let displaced = target.with_extension("previous");
        let had_previous = tokio::fs::rename(&target, &displaced).await.is_ok();
        if let Err(failure) = tokio::fs::rename(path, &target).await {
            if had_previous {
                let _ = tokio::fs::rename(&displaced, &target).await;
            }
            rollback(&promoted).await;
            return Err(Error::Io(failure));
        }
        promoted.push((target, had_previous.then_some(displaced)));
    }
    // Nothing failed: the displaced copies are rubbish now.
    for (_, previous) in &promoted {
        if let Some(previous) = previous {
            let _ = tokio::fs::remove_file(previous).await;
        }
    }
    let _ = tokio::fs::remove_dir_all(layout.staging_dir_for(&pack.id)?).await;
    report(Progress::Installed);
    Ok(())
}

fn expected(artifact: &Artifact) -> Expected {
    Expected {
        path: artifact.path.clone(),
        bytes: artifact.bytes,
        sha256: artifact.sha256.clone(),
    }
}

/// Undo a partial promotion, newest first.
///
/// A target that displaced a predecessor gets the predecessor back; one this run
/// created is removed. Best-effort throughout — the error being reported is the
/// interesting one, and a rollback that cannot finish leaves a state no worse
/// than the failure it is undoing.
async fn rollback(promoted: &[(PathBuf, Option<PathBuf>)]) {
    for (target, previous) in promoted.iter().rev() {
        let _ = tokio::fs::remove_file(target).await;
        if let Some(previous) = previous {
            let _ = tokio::fs::rename(previous, target).await;
        }
    }
}

/// Fetch one artifact into `path`, resuming a partial if there is one.
async fn fetch(
    client: &reqwest::Client,
    artifact: &Artifact,
    path: &Path,
    cancel: &Cancel,
    mut report: impl FnMut(u64),
) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let have = match tokio::fs::metadata(path).await {
        Ok(meta) if meta.len() < artifact.bytes => meta.len(),
        // Already the right size: leave it for the digest check to judge — which
        // DELETES it if the bytes are wrong, so this cannot become a permanent
        // skip. See `install`.
        Ok(meta) if meta.len() == artifact.bytes => return Ok(()),
        // Longer than declared — not a partial of this artifact at all.
        Ok(_) => {
            tokio::fs::remove_file(path).await?;
            0
        }
        /* ONLY `NotFound` MEANS "nothing staged". A permission error or an I/O
         * fault read as "start from zero" truncates a file this process could
         * not even stat. */
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
        Err(err) => return Err(Error::Io(err)),
    };

    let route = artifact.url.clone();
    let mut request = client.get(&route);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let response = request.send().await.map_err(|e| Error::Unreachable {
        route: route.clone(),
        why: e.to_string(),
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::Http {
            status: status.as_u16(),
            route,
        });
    }

    // A server that ignored the Range answers 200 with the WHOLE file. Appending
    // that onto a partial is the corruption an unchecked resume produces, so the
    // partial is dropped and this becomes a fresh download.
    let resumed = have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut written = if resumed { have } else { 0 };

    let mut file = if resumed {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .await?
    } else {
        tokio::fs::File::create(path).await?
    };

    /* A 206 WITHOUT A MATCHING `Content-Range` IS NOT A RESUME. A server that
     * answers 206 from a different offset — a proxy, a mirror that renumbered —
     * would have its bytes appended at the wrong place, producing a file of
     * exactly the right length and the wrong contents. The digest would catch
     * it, but only after a multi-gigabyte download; this catches it before the
     * first byte is written. */
    if resumed {
        let honoured = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split_whitespace().nth(1))
            .and_then(|range| range.split('-').next())
            .and_then(|start| start.parse::<u64>().ok())
            .is_some_and(|start| start == have);
        if !honoured {
            return Err(Error::Malformed {
                route,
                why: format!("resumed at {have} but the server answered a different range"),
            });
        }
    }

    let mut stream = response.bytes_stream();
    let mut since_report = 0u64;
    loop {
        // The reader's stop has to be honoured DURING the body, not only between
        // artifacts — a 1.8 GB download is minutes long.
        let chunk = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                // Flush what we have: the partial is a legitimate resume point,
                // and it is in `staging/` where nothing loads it.
                let _ = file.flush().await;
                return Err(Error::Cancelled);
            }
            next = stream.next() => match next {
                None => break,
                Some(chunk) => chunk.map_err(|e| Error::Unreachable {
                    route: route.clone(),
                    why: e.to_string(),
                })?,
            },
        };
        file.write_all(&chunk).await?;
        written += chunk.len() as u64;
        since_report += chunk.len() as u64;
        if since_report >= PROGRESS_EVERY {
            since_report = 0;
            report(written);
        }
    }
    file.flush().await?;
    report(written);
    /* THE LENGTH IS CHECKED HERE, before the digest, so a truncated transfer is
     * named as one rather than surfacing as a mismatched hash — which reads as
     * "the file was tampered with" and sends whoever debugs it the wrong way. */
    if written != artifact.bytes {
        let _ = tokio::fs::remove_file(path).await;
        return Err(Error::SizeMismatch {
            path: artifact.path.clone(),
            expected: artifact.bytes,
            got: written,
        });
    }
    Ok(())
}

/// Whether every artifact of `pack` is present at its declared size.
///
/// SIZE ONLY, deliberately: this runs whenever the Settings section is drawn, and
/// hashing 2.5 GB to draw a list would make opening a pane cost a minute of disk.
/// The digest is what installs a pack; this is what reports one.
///
/// # Errors
/// [`Error::BadPath`] if the catalogue names a path Paper may not write.
pub fn installed(layout: &Layout, pack: &Pack) -> Result<bool> {
    for artifact in &pack.artifacts {
        let path = layout.pack_path(&pack.id, &artifact.path)?;
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() == artifact.bytes => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

/// Remove a pack, and whatever a stopped download left in staging.
///
/// # Errors
/// [`Error::BadPath`] for a bad id, or the I/O failure of the removal itself.
pub async fn remove(layout: &Layout, pack_id: &str) -> Result<()> {
    for dir in [layout.pack_dir(pack_id)?, layout.staging_dir_for(pack_id)?] {
        match tokio::fs::remove_dir_all(&dir).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(Error::Io(err)),
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "install/tests.rs"]
mod tests;
