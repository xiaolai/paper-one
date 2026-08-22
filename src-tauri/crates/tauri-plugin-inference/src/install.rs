//! Downloading a model, and the three states a reader sees while it happens.
//!
//! WI-15.2. Bytes land in `staging/`, are verified there, and only a verified
//! file is renamed into `models/`. That is what makes the acceptance —
//! *"killing the daemon mid-download leaves no partially active artifact"* —
//! true by construction rather than by a cleanup pass that has to run.
//!
//! # Progress is a count, not a bar
//!
//! F3: `CAPABILITY_UI` is fourteen frozen class names and none of them is a
//! bar or a spinner. Progress reports as `Downloading · 412 MB of 2.4 GB` in
//! the same right-hand `value` slot `StoragePane` already writes facts into.
//! So what this module emits is two numbers and nothing about how to draw
//! them.
//!
//! # Resume is safe here because verification is unconditional
//!
//! A 2.4 GB download that fails at 90% and starts over is a real reader
//! problem, so a partial file IS resumed with a `Range` request. That would
//! be dangerous in a design where the resumed bytes were trusted — a partial
//! from a different URL, a server that renumbered its ranges — but every
//! artifact is SHA-256'd before it is promoted, so wrong bytes cannot reach
//! an activation slot. They cost a re-download, which is exactly what
//! refusing to resume would have cost anyway.
//!
//! A server that ignores `Range` and answers `200` instead of `206` is
//! handled by truncating and starting again, rather than by appending a whole
//! file onto a partial one — which is the specific corruption an unchecked
//! resume produces.

use std::path::Path;

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::digest;
use crate::error::{unreachable, Error, Result};
use crate::manifest::{Artifact, ModelEntry};
use crate::paths::Layout;
use crate::requests::Cancel;

/// How often to report progress, in bytes received.
///
/// Every chunk would be thousands of IPC messages for one download; every
/// megabyte is a number that moves visibly without the channel becoming the
/// expensive part of the operation.
const PROGRESS_EVERY: u64 = 1_000_000;

/// What the reader is told while a model arrives.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Progress {
    /// Bytes so far, and the total the manifest declared. Both across ALL of
    /// the model's artifacts, so a two-file model reports one number pair
    /// rather than restarting at zero half way through.
    Downloading { received: u64, total: u64 },
    /// Hashing. Separate from `Downloading` because it is not instant on a
    /// 2.4 GB file and a count that stopped moving reads as a stall.
    Verifying,
    /// Done, and the artifacts are in their activation slots.
    Installed,
}

/// Download and verify every artifact of `model`, then activate it.
///
/// Nothing is promoted until every artifact has verified: a model whose
/// weights arrived and whose voice pack did not is not installed, and a
/// half-activated model would be offered as a route that fails when pressed.
pub async fn install(
    client: &reqwest::Client,
    layout: &Layout,
    model: &ModelEntry,
    cancel: &Cancel,
    mut report: impl FnMut(Progress),
) -> Result<()> {
    let total = model.total_bytes();
    let mut received_before = 0u64;

    // Staged first, ALL of them, then promoted. See the doc comment.
    let mut staged = Vec::new();
    for artifact in &model.artifacts {
        cancel.check()?;
        let path = layout.staging_path(&model.id, &artifact.file)?;
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
        if let Err(failure) = digest::verify(path, &model.expected(artifact)).await {
            /* ⚠️ THE STAGED FILE IS DELETED ON A FAILED VERIFY, and without
             * this the install was UNRECOVERABLE. `fetch` skips a staged file
             * that already has the declared size, so a file that is the right
             * length and the wrong bytes — a truncated-then-padded resume, a
             * captive portal's error page of exactly the right size, a
             * corrupted disk write — would be re-verified and re-rejected on
             * every retry, forever, with no way for the reader to clear it.
             * Found by audit. `digest::promote` already did this; this path
             * verifies directly and did not. */
            let _ = tokio::fs::remove_file(path).await;
            return Err(failure);
        }
    }

    /* Every artifact is good. Promote them — a rename each, which is the
     * cheapest and least interruptible thing left to do.
     *
     * ROLLED BACK AS A SET. A model is not half-installed: Kokoro is a graph
     * plus a voice pack, and leaving the new graph beside the old voices is a
     * pairing neither version was tested with. A rename that fails puts back
     * whatever each earlier rename displaced. */
    /* EVERY promoted target is recorded, not only the ones that displaced a
     * predecessor. The first version pushed to `promoted` only when there had
     * been a previous file — so on a later failure, a target this loop had
     * NEWLY created was left in place: a model half-installed, which for
     * Kokoro means a graph with no voices. Found by the third audit round.
     * `Option` distinguishes "put the old one back" from "take the new one
     * away". */
    let mut promoted: Vec<(std::path::PathBuf, Option<std::path::PathBuf>)> = Vec::new();
    for (artifact, path) in &staged {
        let target = layout.model_path(&model.id, &artifact.file)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        /* The displaced file is kept aside rather than overwritten, so a
         * later failure in this loop has something to put back. */
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
    /* Everything landed. The displaced copies are now genuinely previous. */
    for (_, previous) in &promoted {
        if let Some(previous) = previous {
            let _ = tokio::fs::remove_file(previous).await;
        }
    }
    report(Progress::Installed);
    Ok(())
}

/// Undo a partial promotion, newest first.
///
/// A target that displaced a predecessor gets the predecessor back; one this
/// run created is removed. Best-effort throughout — the error being reported
/// is the interesting one, and a rollback that cannot finish leaves a state no
/// worse than the failure it is undoing.
async fn rollback(promoted: &[(std::path::PathBuf, Option<std::path::PathBuf>)]) {
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
        // Already the right size: leave it for the digest check to judge —
        // which now DELETES it if the bytes are wrong, so this cannot become
        // a permanent skip. See `install`.
        Ok(meta) if meta.len() == artifact.bytes => return Ok(()),
        // Longer than declared — not a partial of this artifact at all.
        Ok(_) => {
            tokio::fs::remove_file(path).await?;
            0
        }
        /* ONLY `NotFound` MEANS "nothing staged". A permission error or an
         * I/O fault was being read as "start from zero", which then truncated
         * a file this process could not even stat. */
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
        Err(err) => return Err(Error::Io(err)),
    };

    let route = &artifact.source;
    let mut request = client.get(route);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let response = request.send().await.map_err(|e| unreachable(route, e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::RuntimeHttp {
            status: status.as_u16(),
            route: route.clone(),
        });
    }

    // A server that ignored the Range answers 200 with the WHOLE file.
    // Appending that onto a partial is the corruption an unchecked resume
    // produces, so the partial is dropped and this becomes a fresh download.
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
     * answers 206 from a different offset — a proxy, a mirror that renumbered
     * — would have had its bytes appended at the wrong place, producing a file
     * of exactly the right length and the wrong contents. The digest would
     * catch it, but only after a multi-gigabyte download; this catches it
     * before the first byte is written. */
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
            return Err(crate::error::malformed(
                route,
                format!("resumed at {have} but the server answered a different range"),
            ));
        }
    }

    let mut stream = response.bytes_stream();
    let mut since_report = 0u64;
    loop {
        // The reader's abort has to be honoured DURING the body, not only
        // between artifacts — a 2.4 GB download is minutes long.
        let chunk = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                // Flush what we have: the partial is a legitimate resume
                // point, and it is in `staging/` where nothing loads it.
                let _ = file.flush().await;
                return Err(Error::Cancelled);
            }
            next = stream.next() => match next {
                None => break,
                Some(chunk) => chunk.map_err(|e| unreachable(route, e))?,
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
    /* THE LENGTH IS CHECKED HERE, before the digest, so a truncated transfer
     * is named as one rather than surfacing as a mismatched hash — which reads
     * as "the file was tampered with" and sends whoever debugs it the wrong
     * way entirely. */
    if written != artifact.bytes {
        let _ = tokio::fs::remove_file(path).await;
        return Err(Error::SizeMismatch {
            id: artifact.file.clone(),
            expected: artifact.bytes,
            got: written,
        });
    }
    Ok(())
}

/// Whether every artifact of `model` is present at its declared size.
///
/// SIZE ONLY, deliberately: this runs whenever the settings pane is opened
/// and hashing 2.4 GB to draw a list would make opening a group cost
/// thirty seconds of disk. The digest is checked where it matters — at
/// activation, in [`install`] — and a file that is the right size but wrong
/// bytes fails at load with the daemon's own error rather than silently
/// answering.
pub async fn is_installed(layout: &Layout, model: &ModelEntry) -> bool {
    for artifact in &model.artifacts {
        let Ok(path) = layout.model_path(&model.id, &artifact.file) else {
            return false;
        };
        match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.len() == artifact.bytes => {}
            _ => return false,
        }
    }
    true
}

/// Remove a model's artifacts and its directory.
pub async fn remove(layout: &Layout, model: &ModelEntry) -> Result<()> {
    for artifact in &model.artifacts {
        let path = layout.model_path(&model.id, &artifact.file)?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            // Already gone is the outcome asked for.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(Error::Io(err)),
        }
    }
    let dir = layout
        .models_dir
        .join(crate::paths::safe_component(&model.id)?);
    // Best-effort: an empty directory left behind is untidy, not wrong.
    let _ = tokio::fs::remove_dir(&dir).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use crate::testutil::ScratchDir;

    fn layout(dir: &ScratchDir) -> Layout {
        let layout = Layout::under(dir.path());
        layout.ensure().unwrap();
        layout
    }

    fn model() -> ModelEntry {
        Manifest::shipped().unwrap().models[0].clone()
    }

    #[tokio::test]
    async fn a_model_with_nothing_on_disk_is_not_installed() {
        let dir = ScratchDir::new("install");
        assert!(!is_installed(&layout(&dir), &model()).await);
    }

    #[tokio::test]
    async fn a_model_is_installed_only_when_every_artifact_is_the_right_size() {
        let dir = ScratchDir::new("install");
        let layout = layout(&dir);
        let manifest = Manifest::shipped().unwrap();
        // Kokoro: two artifacts, so "one arrived" must not read as installed.
        let kokoro = manifest.model("kokoro-v1-onnx").unwrap();

        let first = layout
            .model_path(&kokoro.id, &kokoro.artifacts[0].file)
            .unwrap();
        tokio::fs::create_dir_all(first.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&first, vec![0u8; kokoro.artifacts[0].bytes as usize])
            .await
            .unwrap();
        assert!(
            !is_installed(&layout, kokoro).await,
            "a graph without its voices is not an installed model"
        );

        let second = layout
            .model_path(&kokoro.id, &kokoro.artifacts[1].file)
            .unwrap();
        tokio::fs::write(&second, vec![0u8; kokoro.artifacts[1].bytes as usize])
            .await
            .unwrap();
        assert!(is_installed(&layout, kokoro).await);
    }

    #[tokio::test]
    async fn a_wrong_sized_artifact_is_not_installed() {
        let dir = ScratchDir::new("install");
        let layout = layout(&dir);
        let model = model();
        let path = layout
            .model_path(&model.id, &model.artifacts[0].file)
            .unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, b"truncated").await.unwrap();
        assert!(!is_installed(&layout, &model).await);
    }

    #[tokio::test]
    async fn removing_takes_every_artifact_and_the_directory() {
        let dir = ScratchDir::new("install");
        let layout = layout(&dir);
        let manifest = Manifest::shipped().unwrap();
        let kokoro = manifest.model("kokoro-v1-onnx").unwrap();
        for artifact in &kokoro.artifacts {
            let path = layout.model_path(&kokoro.id, &artifact.file).unwrap();
            tokio::fs::create_dir_all(path.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(&path, b"x").await.unwrap();
        }
        remove(&layout, kokoro).await.unwrap();
        for artifact in &kokoro.artifacts {
            assert!(!layout
                .model_path(&kokoro.id, &artifact.file)
                .unwrap()
                .exists());
        }
        assert!(!layout.models_dir.join(&kokoro.id).exists());
    }

    /// A promotion that fails part-way must leave NOTHING new behind — the
    /// rollback's own defect was that it only put back displaced files and
    /// left newly created ones active, which for a two-artifact model is a
    /// graph with no voices.
    #[tokio::test]
    async fn a_partial_promotion_leaves_no_new_artifact_active() {
        let dir = ScratchDir::new("install");
        let layout = layout(&dir);
        let first = layout.models_dir.join("m").join("a.bin");
        let second = layout.models_dir.join("m").join("b.bin");
        tokio::fs::create_dir_all(first.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&first, b"new").await.unwrap();

        // `first` was created by this run (no predecessor); `second` never
        // landed. Rolling back must remove `first`.
        rollback(&[(first.clone(), None), (second.clone(), None)]).await;
        assert!(
            !first.exists(),
            "a newly created artifact must not survive a rollback"
        );
        assert!(!second.exists());
    }

    /// And a displaced predecessor comes back rather than being lost.
    #[tokio::test]
    async fn a_rollback_restores_what_it_displaced() {
        let dir = ScratchDir::new("install");
        let layout = layout(&dir);
        let target = layout.models_dir.join("m").join("a.bin");
        let previous = target.with_extension("previous");
        tokio::fs::create_dir_all(target.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&target, b"new").await.unwrap();
        tokio::fs::write(&previous, b"old").await.unwrap();

        rollback(&[(target.clone(), Some(previous))]).await;
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"old");
    }

    #[tokio::test]
    async fn removing_a_model_that_is_not_there_is_success() {
        let dir = ScratchDir::new("install");
        remove(&layout(&dir), &model()).await.unwrap();
    }

    /// The progress shape the settings row renders from — two numbers, and
    /// nothing about how to draw them (F3).
    #[test]
    fn progress_carries_a_count_and_no_presentation() {
        let json = serde_json::to_value(Progress::Downloading {
            received: 412_000_000,
            total: 2_497_281_120,
        })
        .unwrap();
        assert_eq!(json["kind"], "downloading");
        assert_eq!(json["received"], 412_000_000u64);
        assert_eq!(json["total"], 2_497_281_120u64);
        let rendered = json.to_string();
        for presentational in ["percent", "bar", "spinner", "ratio"] {
            assert!(
                !rendered.contains(presentational),
                "{presentational} is the UI's business"
            );
        }
    }

    #[test]
    fn the_three_progress_states_are_distinct() {
        let kinds: Vec<String> = [
            Progress::Downloading {
                received: 0,
                total: 1,
            },
            Progress::Verifying,
            Progress::Installed,
        ]
        .iter()
        .map(|p| {
            serde_json::to_value(p).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
        let unique: std::collections::BTreeSet<_> = kinds.iter().collect();
        assert_eq!(unique.len(), 3);
    }

    /// Cancelling before the first byte must not leave a file in the
    /// activation slot. Uses a cancelled token and no network at all.
    #[tokio::test]
    async fn a_cancel_before_the_first_artifact_activates_nothing() {
        let dir = ScratchDir::new("install");
        let layout = layout(&dir);
        let registry = crate::requests::Registry::default();
        let guard = registry.begin("r").unwrap();
        registry.cancel("r").unwrap();

        let client = reqwest::Client::new();
        let model = model();
        let err = install(&client, &layout, &model, &guard.cancel(), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "cancelled");
        assert!(!is_installed(&layout, &model).await);
        assert!(
            !layout
                .model_path(&model.id, &model.artifacts[0].file)
                .unwrap()
                .exists(),
            "nothing may reach the activation slot"
        );
    }
}
