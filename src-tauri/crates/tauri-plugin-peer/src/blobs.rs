//! Blob streams: a book's bytes or cover, served and fetched over a fresh
//! bi-stream on an open `peer/1` session (plan III.2.1, III.2.5, III.2.6).
//!
//! The requester opens the stream and sends `{kind: "blob", folder, name,
//! offset}`. The server validates the target with `paths.rs`, refuses unless
//! the peer holds `blob:read` (the app decides who does; `blob:*` covers
//! it), answers `{ok, size, blake3}` — the BLAKE3 of the whole file — and
//! streams the bytes from `offset`. The requester appends to `<target>.part`,
//! resuming from that file's length; before promoting it re-hashes the whole
//! `.part` from disk (never the stream incrementally, so an out-of-band change
//! cannot slip through) and re-validates containment, then renames `.part`
//! into place. On a size, hash, or containment mismatch the `.part` is
//! deleted. One transfer per target at a time.
//!
//! Symmetric: a shelf serves its books to a satchel; a satchel serves a book
//! it imported to the shelf. Neither side writes anything but the blob.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::{RecvStream, SendStream};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::error::{Error, Result};
use crate::events::{PeerEvent, TransferProgress, TransferState};
use crate::frame::{read_json, write_json};
use crate::node::{parse_peer_id, Node};
use crate::paths::{Access, BlobTarget};
use crate::session::Session;

/// The grant a peer needs for the server to serve it anything.
pub const GRANT_READ: &str = "blob:read";
const CHUNK: usize = 64 * 1024;
const PROGRESS_EVERY: u64 = 1024 * 1024;
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// The most concurrent blob-serve tasks one node runs. A peer opens streams on
/// its session; without a cap it could spawn unbounded tasks and descriptors
/// (finding H2). Over the cap, an extra stream is dropped rather than served.
pub const MAX_BLOB_STREAMS: usize = 16;

/// The largest blob this node accepts, serving or fetching. A peer advertising
/// a multi-terabyte (or simply lying) size cannot make the fetcher fill its
/// disk: the size is refused before a byte is written (finding M6). A generous
/// ceiling for a single book or cover, not a per-library budget.
pub const MAX_BLOB_SIZE: u64 = 4 * 1024 * 1024 * 1024;

/// Open a file for reading without following a final-component symlink, so a
/// planted link cannot redirect the read out of the data root even if it is
/// swapped in after the [`BlobTarget`] check (finding H4). On Unix this is
/// `O_NOFOLLOW`; elsewhere a pre-open `symlink_metadata` check stands in.
async fn open_read_no_follow(path: &Path) -> Result<tokio::fs::File> {
    let mut opts = tokio::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    opts.custom_flags(libc::O_NOFOLLOW);
    #[cfg(not(unix))]
    refuse_symlink_open(path)?;
    Ok(opts.open(path).await?)
}

/// Open (creating if absent) a file for append without following a
/// final-component symlink — a fetch must not append peer bytes through a
/// planted link (finding H4).
async fn open_append_no_follow(path: &Path) -> Result<tokio::fs::File> {
    let mut opts = tokio::fs::OpenOptions::new();
    opts.append(true).create(true);
    #[cfg(unix)]
    opts.custom_flags(libc::O_NOFOLLOW);
    #[cfg(not(unix))]
    refuse_symlink_open(path)?;
    Ok(opts.open(path).await?)
}

/// The Windows/non-Unix stand-in for `O_NOFOLLOW`: refuse if the final
/// component is already a symlink (reparse points there need privilege, so the
/// residual check→open race is negligible).
#[cfg(not(unix))]
fn refuse_symlink_open(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(Error::BlobRefused("not-found".into())),
        _ => Ok(()),
    }
}

// ── registry ──────────────────────────────────────────────────────────────

/// Which targets have a transfer running, and the transfer id counter.
#[derive(Default)]
pub struct Transfers {
    active: Mutex<HashSet<PathBuf>>,
    next: AtomicU64,
}

impl Transfers {
    /// Reserve the target; `TransferBusy` if another transfer holds it.
    fn claim(&self, target: &Path) -> Result<u64> {
        let mut active = self.active.lock().expect("transfers lock");
        if !active.insert(target.to_path_buf()) {
            return Err(Error::TransferBusy(target.display().to_string()));
        }
        Ok(self.next.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn release(&self, target: &Path) {
        self.active.lock().expect("transfers lock").remove(target);
    }
}

/// A claimed target that RELEASES ITSELF: the release used to be a plain
/// statement after the transfer future, so aborting or panicking the task
/// skipped it and the target answered `TransferBusy` forever after. `Drop`
/// runs on completion, panic and abort alike.
struct TransferClaim {
    node: Arc<Node>,
    target: PathBuf,
}

impl Drop for TransferClaim {
    fn drop(&mut self) {
        self.node.transfers.release(&self.target);
    }
}

// ── wire ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct BlobRequest {
    kind: String,
    folder: String,
    name: String,
    offset: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct BlobHeader {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    /// Hex, of the whole file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blake3: Option<String>,
}

// ── hashing ───────────────────────────────────────────────────────────────

/// What `peer_hash_file` returns.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HashResult {
    pub blake3: String,
    pub size: u64,
}

/// BLAKE3 and size of `<root>/books/<folder>/<name>`.
pub async fn hash_file(root: &Path, folder: &str, name: &str) -> Result<HashResult> {
    let target = BlobTarget::resolve(root, folder, name, Access::Read)?;
    target.checked_read(root)?;
    hash_path(target.path()).await
}

async fn hash_path(path: &Path) -> Result<HashResult> {
    let mut file = open_read_no_follow(path).await?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; CHUNK];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok(HashResult {
        blake3: hasher.finalize().to_hex().to_string(),
        size,
    })
}

// ── serving ───────────────────────────────────────────────────────────────

/// One accepted bi-stream on a session: read the request, answer it.
pub(crate) async fn serve_stream(
    node: Arc<Node>,
    session: Arc<Session>,
    mut send: SendStream,
    mut recv: RecvStream,
) {
    let request: BlobRequest = match timeout(HEADER_TIMEOUT, read_json(&mut recv)).await {
        Ok(Ok(request)) => request,
        _ => return,
    };
    let mut header_sent = false;
    let outcome = serve_inner(&node, &session, &request, &mut send, &mut header_sent).await;
    if let Err(err) = outcome {
        if !header_sent {
            let _ = write_json(
                &mut send,
                &BlobHeader {
                    ok: false,
                    reason: Some(refusal_reason(&err)),
                    size: None,
                    blake3: None,
                },
            )
            .await;
        }
    }
    let _ = send.finish();
    let _ = timeout(FLUSH_TIMEOUT, send.stopped()).await;
}

fn refusal_reason(err: &Error) -> String {
    match err {
        Error::BlobRefused(reason) => reason.clone(),
        Error::InvalidFolder(_) => "invalid-folder".into(),
        Error::InvalidBlobName(_) | Error::ReadOnlyBlobName(_) => "invalid-name".into(),
        Error::FolderGone(_) | Error::PathOutsideDataRoot { .. } => "not-found".into(),
        Error::Io(io) if io.kind() == std::io::ErrorKind::NotFound => "not-found".into(),
        other => other.kind().into(),
    }
}

async fn serve_inner(
    node: &Node,
    session: &Session,
    request: &BlobRequest,
    send: &mut SendStream,
    header_sent: &mut bool,
) -> Result<()> {
    if request.kind != "blob" {
        return Err(Error::BlobRefused("unknown-kind".into()));
    }
    if !node.has_grant(&session.peer_id.to_string(), GRANT_READ) {
        return Err(Error::BlobRefused("ungranted".into()));
    }
    let target = BlobTarget::resolve(node.root(), &request.folder, &request.name, Access::Read)?;
    target.checked_read(node.root())?;
    /* The size gate runs on METADATA before any byte is hashed — hashing an
     * oversized file first meant gigabytes of I/O spent computing a digest
     * for a transfer about to be refused. The post-hash check stays, in case
     * the file grew mid-hash. */
    let early_size = tokio::fs::metadata(target.path()).await?.len();
    if early_size > MAX_BLOB_SIZE {
        return Err(Error::BlobTooLarge {
            size: early_size,
            max: MAX_BLOB_SIZE,
        });
    }
    let hash = hash_path(target.path()).await?;
    if hash.size > MAX_BLOB_SIZE {
        return Err(Error::BlobTooLarge {
            size: hash.size,
            max: MAX_BLOB_SIZE,
        });
    }
    if request.offset > hash.size {
        return Err(Error::BlobRefused("bad-offset".into()));
    }
    write_json(
        send,
        &BlobHeader {
            ok: true,
            reason: None,
            size: Some(hash.size),
            blake3: Some(hash.blake3),
        },
    )
    .await?;
    *header_sent = true;

    // A test seam for the fetch-side idle deadline (finding H2): pause after
    // the header so a fetcher with a short idle timeout stalls waiting for the
    // body, then times out.
    #[cfg(test)]
    {
        let gate = node.serve_body_gate.lock().expect("serve gate").take();
        if let Some(gate) = gate {
            let _ = gate.await;
        }
    }

    let idle = node.blob_idle_timeout();
    let mut file = open_read_no_follow(target.path()).await?;
    file.seek(std::io::SeekFrom::Start(request.offset)).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut sent = request.offset;
    while sent < hash.size {
        /* Read no further than the advertised body: a file grown or
         * replaced mid-serve must not push bytes past the size and hash
         * the header promised. */
        let want = CHUNK.min((hash.size - sent) as usize);
        let n = file.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        // Idle deadline on the write: a requester that stops reading stalls
        // this on flow control; drop it rather than hold the task forever.
        timeout(idle, send.write_all(&buf[..n]))
            .await
            .map_err(|_| Error::Timeout("blob body write"))??;
        sent += n as u64;
    }
    Ok(())
}

// ── fetching ──────────────────────────────────────────────────────────────

/// What `peer_blob_fetch` takes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub peer_id: String,
    pub folder: String,
    pub name: String,
    pub expected_size: u64,
    /// Hex.
    pub expected_hash: String,
}

/// Fault injection for the tests. Absent from the plugin proper.
#[cfg(test)]
#[derive(Default)]
pub struct FetchHooks {
    /// Flip one byte at this absolute offset as it comes off the wire.
    pub corrupt_at: Option<u64>,
    /// Stop reading once this many bytes are on disk, as a dropped
    /// connection would.
    pub abort_at: Option<u64>,
    /// Once this many bytes are on disk, wait for the signal before
    /// reading on.
    pub pause_at: Option<(u64, tokio::sync::oneshot::Receiver<()>)>,
}

#[cfg(not(test))]
#[derive(Default)]
pub struct FetchHooks {
    _private: (),
}

/// Start a fetch. Validates the target and the session synchronously and
/// returns the transfer id; the transfer runs in the returned task, which
/// emits `peer://transfer` as it goes and resolves to the outcome.
pub async fn fetch(
    node: &Arc<Node>,
    request: FetchRequest,
    hooks: FetchHooks,
) -> Result<(u64, JoinHandle<Result<()>>)> {
    let peer = parse_peer_id(&request.peer_id)?;
    let target = BlobTarget::resolve(node.root(), &request.folder, &request.name, Access::Write)?;
    if request.expected_size > MAX_BLOB_SIZE {
        return Err(Error::BlobTooLarge {
            size: request.expected_size,
            max: MAX_BLOB_SIZE,
        });
    }
    let expected =
        blake3::Hash::from_hex(&request.expected_hash).map_err(|_| Error::BlobMismatch {
            expected: request.expected_hash.clone(),
            got: "not a BLAKE3 hex digest".into(),
        })?;
    target.checked_part(node.root())?;
    let session = node
        .sessions
        .any_for_peer(peer)
        .ok_or_else(|| Error::NoSession(request.peer_id.clone()))?;
    let transfer_id = node.transfers.claim(target.path())?;

    let node = node.clone();
    let total = request.expected_size;
    /* Copied out before the task takes ownership of anything else: the folder
    is what lets the caller match this transfer to the book it asked for. */
    let folder = request.folder.clone();
    let claim = TransferClaim {
        node: node.clone(),
        target: target.path().to_path_buf(),
    };
    let task = tokio::spawn(async move {
        /* Bytes on disk so far, updated by every progress emission — so a
         * failure AFTER data arrived (a bad hash, a rename refused) reports
         * what actually landed instead of a flat zero. */
        let landed = Arc::new(AtomicU64::new(0));
        let result = run(
            &node,
            &session,
            &target,
            total,
            expected,
            transfer_id,
            &folder,
            hooks,
            &landed,
        )
        .await;
        let (state, received, error) = match &result {
            Ok(()) => (TransferState::Done, total, None),
            Err(Error::BlobInterrupted { received, .. }) => (
                TransferState::Failed,
                *received,
                Some("blobInterrupted".to_owned()),
            ),
            Err(err) => (
                TransferState::Failed,
                landed.load(Ordering::Relaxed),
                Some(err.kind().to_owned()),
            ),
        };
        node.emit(PeerEvent::Transfer(TransferProgress {
            transfer_id,
            folder: folder.clone(),
            received,
            total,
            state,
            error,
        }));
        /* Released only NOW — after the terminal event — so a second
         * transfer claiming this target cannot slip its first progress in
         * before this one's Done/Failed reaches the webview. */
        drop(claim);
        result
    });
    Ok((transfer_id, task))
}

#[allow(clippy::too_many_arguments)]
async fn run(
    node: &Node,
    session: &Session,
    target: &BlobTarget,
    expected_size: u64,
    expected: blake3::Hash,
    transfer_id: u64,
    folder: &str,
    hooks: FetchHooks,
    landed: &AtomicU64,
) -> Result<()> {
    /* The fault-injection hooks exist only under `cfg(test)`; production
     * consumes the empty struct here — explicitly, so no warning needs
     * suppressing — and the test build rebinds it mutable for `pause_at`. */
    #[cfg(not(test))]
    let FetchHooks { _private: () } = hooks;
    #[cfg(test)]
    let mut hooks = hooks;
    let part = target.part_path();
    let progress = |received: u64| {
        landed.store(received, Ordering::Relaxed);
        node.emit(PeerEvent::Transfer(TransferProgress {
            transfer_id,
            folder: folder.to_owned(),
            received,
            total: expected_size,
            state: TransferState::Running,
            error: None,
        }));
    };

    // Resume point: whatever `.part` already holds. Its bytes are not trusted
    // incrementally — the whole file is re-hashed from disk before promotion
    // (finding M7), so a prefix poisoned or grown out of band between writes
    // cannot be promoted as verified.
    let mut offset = match tokio::fs::metadata(&part).await {
        Ok(meta) => meta.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
        Err(err) => return Err(err.into()),
    };
    if offset > expected_size {
        tokio::fs::remove_file(&part).await?;
        offset = 0;
    }

    let (mut send, mut recv) = session.conn().open_bi().await?;
    write_json(
        &mut send,
        &BlobRequest {
            kind: "blob".into(),
            folder: target.folder().to_owned(),
            name: target.name().to_owned(),
            offset,
        },
    )
    .await?;
    let _ = send.finish();
    let header: BlobHeader = timeout(HEADER_TIMEOUT, read_json(&mut recv))
        .await
        .map_err(|_| Error::Timeout("blob header"))??;
    if !header.ok {
        return Err(Error::BlobRefused(
            header.reason.unwrap_or_else(|| "refused".into()),
        ));
    }
    let size = header.size.unwrap_or(0);
    if size > MAX_BLOB_SIZE {
        // A lying or oversized advertisement: refuse before writing a byte so
        // a peer cannot fill the disk (finding M6).
        let _ = tokio::fs::remove_file(&part).await;
        return Err(Error::BlobTooLarge {
            size,
            max: MAX_BLOB_SIZE,
        });
    }
    let hash = header.blake3.clone().unwrap_or_default();
    if size != expected_size || blake3::Hash::from_hex(&hash).ok().as_ref() != Some(&expected) {
        // The record that named this blob is stale, or the remote's file
        // changed under it. Whatever `.part` holds is for a different file.
        let _ = tokio::fs::remove_file(&part).await;
        return Err(Error::BlobMismatch {
            expected: format!("{expected_size} bytes, {}", expected.to_hex()),
            got: format!("{size} bytes, {hash}"),
        });
    }
    progress(offset);

    let idle = node.blob_idle_timeout();
    let mut file = open_append_no_follow(&part).await?;
    let mut received = offset;
    let mut since_event = 0u64;
    let mut buf = vec![0u8; CHUNK];
    while received < size {
        let want = CHUNK.min((size - received) as usize);
        // iroh's inherent `read`: `Ok(None)` is the end of the stream. An idle
        // deadline drops a server that stalls or trickles (finding H2); the
        // `.part` is kept for a resume.
        let Some(n) = timeout(idle, recv.read(&mut buf[..want]))
            .await
            .map_err(|_| Error::BlobInterrupted {
                received,
                total: size,
            })??
        else {
            break;
        };
        #[cfg(test)]
        if let Some(at) = hooks.corrupt_at {
            if at >= received && at < received + n as u64 {
                buf[(at - received) as usize] ^= 0x01;
            }
        }
        file.write_all(&buf[..n]).await?;
        received += n as u64;
        /* Every landed byte counts NOW; only the EVENT is throttled — the
         * terminal accounting reads this, and updating it per event let a
         * failure between intervals underreport by up to the interval. */
        landed.store(received, Ordering::Relaxed);
        since_event += n as u64;
        if since_event >= PROGRESS_EVERY {
            since_event = 0;
            progress(received);
        }
        #[cfg(test)]
        {
            if hooks.abort_at.is_some_and(|at| received >= at) {
                file.sync_all().await?;
                return Err(Error::BlobInterrupted {
                    received,
                    total: size,
                });
            }
            if let Some((at, _)) = hooks.pause_at.as_ref() {
                if received >= *at {
                    let (_, gate) = hooks.pause_at.take().expect("checked");
                    file.sync_all().await?;
                    let _ = gate.await;
                }
            }
        }
    }
    file.sync_all().await?;
    drop(file);
    if received < size {
        return Err(Error::BlobInterrupted {
            received,
            total: size,
        });
    }

    // Promotion is decided by the bytes actually on disk — re-hashed through a
    // no-follow handle — never the incremental stream hash (finding M7). A
    // `.part` poisoned or grown out of band between writes changes this digest
    // or length and is refused. A missing folder here reads as `FolderGone`,
    // the same answer the pre-rename check gives.
    let on_disk = match hash_path(&part).await {
        Ok(result) => result,
        Err(Error::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::FolderGone(target.folder().to_owned()));
        }
        Err(err) => return Err(err),
    };
    if on_disk.size != expected_size
        || blake3::Hash::from_hex(&on_disk.blake3).ok().as_ref() != Some(&expected)
    {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(Error::BlobHashMismatch);
    }

    // The folder may have been trashed — or swapped for an outside symlink —
    // while the bytes arrived. Re-validate containment and the final component
    // atomically right before the rename (finding H4): the rename must not
    // resurrect a trashed folder, promote through a planted symlink, or escape
    // the data root.
    if let Err(err) = target.checked_part(node.root()) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(err);
    }
    match tokio::fs::rename(&part, target.path()).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Error::FolderGone(target.folder().to_owned()));
        }
        Err(err) => return Err(err.into()),
    }
    if let Ok(dir) = std::fs::File::open(target.folder_dir()) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::testkit::TestNode;
    use crate::role::Role;
    use crate::session::connect;
    use serde_json::json;

    const MB: u64 = 1024 * 1024;

    /// A deterministic pseudo-random book of `size` bytes at
    /// `<root>/books/<folder>/content.epub`; returns its bytes and digest.
    fn write_book(root: &Path, folder: &str, size: usize, seed: u64) -> (Vec<u8>, String) {
        let mut state = seed | 1;
        let mut bytes = Vec::with_capacity(size);
        while bytes.len() < size {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            bytes.extend_from_slice(&state.to_le_bytes());
        }
        bytes.truncate(size);
        let dir = root.join("books").join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("content.epub"), &bytes).unwrap();
        let hash = blake3::hash(&bytes).to_hex().to_string();
        (bytes, hash)
    }

    struct Pair {
        shelf: TestNode,
        satchel: TestNode,
    }

    /// Shelf and satchel trusting each other with these grants for the
    /// satchel, a session open from the satchel.
    async fn linked(label: &str, satchel_grants: &[&str]) -> Pair {
        let mut shelf = TestNode::start(&format!("{label}-shelf"), Role::Shelf).await;
        let mut satchel = TestNode::start(&format!("{label}-satchel"), Role::Satchel).await;
        shelf.trust(&satchel, satchel_grants);
        satchel.trust(&shelf, &["sync:*", "blob:*"]);
        shelf.node.set_ready();
        satchel.node.set_ready();
        connect(&satchel.node, &shelf.id(), json!({}))
            .await
            .unwrap();
        let _ = shelf.next_event().await;
        let _ = satchel.next_event().await;
        Pair { shelf, satchel }
    }

    fn request(pair: &Pair, folder: &str, name: &str, size: u64, hash: &str) -> FetchRequest {
        FetchRequest {
            peer_id: pair.shelf.id(),
            folder: folder.into(),
            name: name.into(),
            expected_size: size,
            expected_hash: hash.into(),
        }
    }

    /// How long a test waits for a transfer before calling it hung.
    ///
    /// A LIVENESS BOUND, NOT A THROUGHPUT ASSERTION, and the distinction is the
    /// whole reason it has a name. Nothing in these tests claims that 20 MB
    /// moves in any particular time; what they assert is that the bytes arrive
    /// intact, that progress is reported, and that a failure fails cleanly. The
    /// timeout exists so a transfer that never completes fails the suite in
    /// bounded time instead of hanging it forever.
    ///
    /// It was 30 seconds, written out at nine call sites, and that is a number
    /// small enough to be a performance assertion by accident. The heaviest of
    /// these takes six to eleven seconds on an unloaded developer machine — a
    /// three-to-five-fold margin, which a contended CI runner eats without
    /// difficulty. Both 20 MB tests duly failed on a machine that was also
    /// building a second copy of the tree, and passed three times out of three
    /// once it was quiet.
    ///
    /// AND IT MUST EXCEED EVERY PRODUCTION TIMEOUT IT COULD RACE, which is the
    /// second reason and the one that would have bitten silently. `HEADER_TIMEOUT`
    /// is thirty seconds. A test bound of thirty seconds awaiting an operation
    /// that stalls on the header is two timers started together: which one wins
    /// decides whether the test reports the interruption it is looking for or a
    /// bare elapsed error, and nothing about the code decides it.
    const TRANSFER_LIVENESS: Duration = Duration::from_secs(120);

    async fn transfer_events(node: &mut TestNode) -> Vec<TransferProgress> {
        let mut out = Vec::new();
        while let Ok(Some(ev)) = timeout(Duration::from_millis(200), node.events.recv()).await {
            if let PeerEvent::Transfer(p) = ev {
                out.push(p);
            }
        }
        out
    }

    #[tokio::test]
    async fn twenty_megabytes_arrive_intact_with_progress() {
        let mut pair = linked("blob-20mb", &["blob:*"]).await;
        let (bytes, hash) = write_book(pair.shelf.dir.path(), "bk1", 20 * MB as usize, 42);
        std::fs::create_dir_all(pair.satchel.dir.path().join("books").join("bk1")).unwrap();
        assert_eq!(
            hash_file(pair.shelf.dir.path(), "bk1", "content.epub")
                .await
                .unwrap(),
            HashResult {
                blake3: hash.clone(),
                size: 20 * MB
            }
        );

        let (transfer_id, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 20 * MB, &hash),
            FetchHooks::default(),
        )
        .await
        .unwrap();
        timeout(TRANSFER_LIVENESS, task)
            .await
            .expect("20 MB arrived before the liveness bound")
            .unwrap()
            .unwrap();

        let target = pair
            .satchel
            .dir
            .path()
            .join("books")
            .join("bk1")
            .join("content.epub");
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert!(!target.with_extension("epub.part").exists());
        let events = transfer_events(&mut pair.satchel).await;
        assert!(events.iter().all(|e| e.transfer_id == transfer_id));
        /* EVERY event names the book, not just the terminal one. A progress
        report nobody can attribute to a book cannot be shown on the book,
        which is the only place a reader looks for it — so the running
        frames carry it too, and a surface that reads only the last event
        is not the one being enabled here. */
        assert!(
            events.iter().all(|e| e.folder == "bk1"),
            "every transfer event carries the blob folder: {:?}",
            events.iter().map(|e| e.folder.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(events.first().unwrap().received, 0);
        assert!(
            events
                .iter()
                .filter(|e| e.state == TransferState::Running)
                .count()
                >= 10,
            "{events:?}"
        );
        let last = events.last().unwrap();
        assert_eq!(last.state, TransferState::Done);
        assert_eq!(last.received, 20 * MB);
        assert_eq!(last.total, 20 * MB);
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn an_interrupted_transfer_resumes_from_the_part_file() {
        let mut pair = linked("blob-resume", &["blob:read"]).await;
        let (bytes, hash) = write_book(pair.shelf.dir.path(), "bk1", 20 * MB as usize, 7);
        std::fs::create_dir_all(pair.satchel.dir.path().join("books").join("bk1")).unwrap();
        let part = pair
            .satchel
            .dir
            .path()
            .join("books")
            .join("bk1")
            .join("content.epub.part");

        let (_, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 20 * MB, &hash),
            FetchHooks {
                abort_at: Some(5 * MB),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let err = timeout(TRANSFER_LIVENESS, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(err.kind(), "blobInterrupted");
        let kept = std::fs::metadata(&part).unwrap().len();
        assert!((5 * MB..20 * MB).contains(&kept), "{kept}");
        assert_eq!(&std::fs::read(&part).unwrap()[..], &bytes[..kept as usize]);
        let events = transfer_events(&mut pair.satchel).await;
        assert_eq!(events.last().unwrap().state, TransferState::Failed);
        assert_eq!(events.last().unwrap().received, kept);

        let (_, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 20 * MB, &hash),
            FetchHooks::default(),
        )
        .await
        .unwrap();
        timeout(TRANSFER_LIVENESS, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let events = transfer_events(&mut pair.satchel).await;
        assert_eq!(
            events.first().unwrap().received,
            kept,
            "resumed at the .part length"
        );
        assert_eq!(events.last().unwrap().state, TransferState::Done);
        let target = part.with_extension("");
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert!(!part.exists());
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn a_corrupted_byte_leaves_no_file_and_no_part() {
        let pair = linked("blob-corrupt", &["blob:*"]).await;
        let (_, hash) = write_book(pair.shelf.dir.path(), "bk1", 3 * MB as usize, 9);
        let folder = pair.satchel.dir.path().join("books").join("bk1");
        std::fs::create_dir_all(&folder).unwrap();
        let (_, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 3 * MB, &hash),
            FetchHooks {
                corrupt_at: Some(MB + 12_345),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let err = timeout(TRANSFER_LIVENESS, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(err.kind(), "blobHashMismatch");
        assert!(!folder.join("content.epub").exists());
        assert!(!folder.join("content.epub.part").exists());
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn a_folder_trashed_mid_transfer_fails_cleanly_and_is_not_resurrected() {
        let mut pair = linked("blob-trashed", &["blob:*"]).await;
        let (_, hash) = write_book(pair.shelf.dir.path(), "bk1", 4 * MB as usize, 11);
        let books = pair.satchel.dir.path().join("books");
        let folder = books.join("bk1");
        std::fs::create_dir_all(&folder).unwrap();
        let (gate_tx, gate_rx) = tokio::sync::oneshot::channel();
        let (_, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 4 * MB, &hash),
            FetchHooks {
                pause_at: Some((MB, gate_rx)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // Wait until the transfer is parked past the first megabyte.
        loop {
            if let PeerEvent::Transfer(p) = pair.satchel.next_event().await {
                if p.received >= MB {
                    break;
                }
            }
        }
        // Trash the folder the way the kernel does: a rename away.
        let trash = pair.satchel.dir.path().join("trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::rename(&folder, trash.join("bk1")).unwrap();
        gate_tx.send(()).unwrap();

        let err = timeout(TRANSFER_LIVENESS, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(err.kind(), "folderGone");
        assert!(!folder.exists(), "the rename must not recreate the folder");
        assert!(
            !trash.join("bk1").join("content.epub").exists(),
            "not promoted in the trash either"
        );
        let events = transfer_events(&mut pair.satchel).await;
        assert_eq!(events.last().unwrap().state, TransferState::Failed);
        assert_eq!(events.last().unwrap().error.as_deref(), Some("folderGone"));
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn an_ungranted_peer_is_refused_before_any_byte() {
        let pair = linked("blob-ungranted", &["sync:*"]).await;
        let (_, hash) = write_book(pair.shelf.dir.path(), "bk1", 1024, 1);
        let folder = pair.satchel.dir.path().join("books").join("bk1");
        std::fs::create_dir_all(&folder).unwrap();
        let (_, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 1024, &hash),
            FetchHooks::default(),
        )
        .await
        .unwrap();
        let err = timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(err.kind(), "blobRefused");
        assert!(err.to_string().contains("ungranted"), "{err}");
        assert!(!folder.join("content.epub.part").exists());
        assert!(!folder.join("content.epub").exists());

        // Granting `blob:*` mid-session is enough — the server reads the
        // live store.
        pair.shelf
            .node
            .set_grants(&pair.satchel.id(), vec!["blob:*".into()])
            .unwrap();
        let (_, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 1024, &hash),
            FetchHooks::default(),
        )
        .await
        .unwrap();
        timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(folder.join("content.epub").exists());
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn invalid_targets_are_refused_on_both_ends() {
        let pair = linked("blob-invalid", &["blob:*"]).await;
        let (_, hash) = write_book(pair.shelf.dir.path(), "bk1", 1024, 1);
        std::fs::create_dir_all(pair.satchel.dir.path().join("books").join("bk1")).unwrap();
        // The requester refuses locally, before any network.
        assert_eq!(
            fetch(
                &pair.satchel.node,
                request(&pair, "bk1", "content.exe", 1024, &hash),
                FetchHooks::default()
            )
            .await
            .unwrap_err()
            .kind(),
            "invalidBlobName"
        );
        assert_eq!(
            fetch(
                &pair.satchel.node,
                request(&pair, "../bk1", "content.epub", 1024, &hash),
                FetchHooks::default()
            )
            .await
            .unwrap_err()
            .kind(),
            "invalidFolder"
        );
        assert_eq!(
            fetch(
                &pair.satchel.node,
                request(&pair, "bk1", "cover.webp", 1024, &hash),
                FetchHooks::default()
            )
            .await
            .unwrap_err()
            .kind(),
            "readOnlyBlobName"
        );
        assert_eq!(
            fetch(
                &pair.satchel.node,
                request(&pair, "bk1", "content.epub", 1024, "nothex"),
                FetchHooks::default()
            )
            .await
            .unwrap_err()
            .kind(),
            "blobMismatch"
        );
        assert_eq!(
            fetch(
                &pair.satchel.node,
                request(&pair, "missing", "content.epub", 1024, &hash),
                FetchHooks::default()
            )
            .await
            .unwrap_err()
            .kind(),
            "folderGone",
            "the requester's own folder must exist"
        );

        // The server refuses a hand-rolled request too.
        let session = pair
            .satchel
            .node
            .sessions
            .any_for_peer(pair.shelf.node.id())
            .unwrap();
        for (folder, name, reason) in [
            ("bk1", "content.exe", "invalid-name"),
            ("../bk1", "content.epub", "invalid-folder"),
            ("nope", "content.epub", "not-found"),
            ("bk1", "cover.jpg", "not-found"),
        ] {
            let (mut send, mut recv) = session.conn().open_bi().await.unwrap();
            write_json(
                &mut send,
                &BlobRequest {
                    kind: "blob".into(),
                    folder: folder.into(),
                    name: name.into(),
                    offset: 0,
                },
            )
            .await
            .unwrap();
            let header: BlobHeader = read_json(&mut recv).await.unwrap();
            assert!(!header.ok, "{folder}/{name}");
            assert_eq!(header.reason.as_deref(), Some(reason), "{folder}/{name}");
        }
        // Offsets past the end are refused; the legacy webp cover is served.
        std::fs::write(
            pair.shelf
                .dir
                .path()
                .join("books")
                .join("bk1")
                .join("cover.webp"),
            b"webp",
        )
        .unwrap();
        for (name, offset, ok, reason) in [
            ("content.epub", 5000u64, false, Some("bad-offset")),
            ("cover.webp", 0, true, None),
        ] {
            let (mut send, mut recv) = session.conn().open_bi().await.unwrap();
            write_json(
                &mut send,
                &BlobRequest {
                    kind: "blob".into(),
                    folder: "bk1".into(),
                    name: name.into(),
                    offset,
                },
            )
            .await
            .unwrap();
            let header: BlobHeader = read_json(&mut recv).await.unwrap();
            assert_eq!(header.ok, ok, "{name}");
            assert_eq!(header.reason.as_deref(), reason, "{name}");
        }
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn one_transfer_per_target_and_no_session_is_typed() {
        let mut pair = linked("blob-busy", &["blob:*"]).await;
        let (_, hash) = write_book(pair.shelf.dir.path(), "bk1", 3 * MB as usize, 5);
        std::fs::create_dir_all(pair.satchel.dir.path().join("books").join("bk1")).unwrap();
        let (gate_tx, gate_rx) = tokio::sync::oneshot::channel();
        let (first_id, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 3 * MB, &hash),
            FetchHooks {
                pause_at: Some((MB, gate_rx)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        loop {
            if let PeerEvent::Transfer(p) = pair.satchel.next_event().await {
                if p.received >= MB {
                    break;
                }
            }
        }
        let err = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 3 * MB, &hash),
            FetchHooks::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "transferBusy");
        gate_tx.send(()).unwrap();
        timeout(TRANSFER_LIVENESS, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        // Released: a new fetch of the same target is allowed again.
        let (second_id, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 3 * MB, &hash),
            FetchHooks::default(),
        )
        .await
        .unwrap();
        assert!(second_id > first_id);
        timeout(TRANSFER_LIVENESS, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        // No session with the peer: typed, before anything.
        let lonely = TestNode::start("blob-lonely", Role::Satchel).await;
        lonely.trust(&pair.shelf, &[]);
        std::fs::create_dir_all(lonely.dir.path().join("books").join("bk1")).unwrap();
        assert_eq!(
            fetch(
                &lonely.node,
                request(&pair, "bk1", "content.epub", 3 * MB, &hash),
                FetchHooks::default()
            )
            .await
            .unwrap_err()
            .kind(),
            "noSession"
        );
        lonely.close().await;
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn a_blob_larger_than_the_maximum_is_refused_before_any_byte() {
        // Finding M6: a peer advertising a huge (or lying) size must be refused
        // before a byte is written, so it cannot fill the disk.
        let pair = linked("blob-toobig", &["blob:*"]).await;
        let folder = pair.satchel.dir.path().join("books").join("bk1");
        std::fs::create_dir_all(&folder).unwrap();
        let err = fetch(
            &pair.satchel.node,
            request(
                &pair,
                "bk1",
                "content.epub",
                MAX_BLOB_SIZE + 1,
                &"0".repeat(64),
            ),
            FetchHooks::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "blobTooLarge");
        assert!(!folder.join("content.epub.part").exists());
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn a_part_poisoned_between_writes_is_not_promoted() {
        // Finding M7: extra bytes appended to `.part` out of band change the
        // on-disk digest and length; promotion is from disk, so it is refused.
        let mut pair = linked("blob-poison", &["blob:*"]).await;
        let (_, hash) = write_book(pair.shelf.dir.path(), "bk1", 3 * MB as usize, 13);
        let folder = pair.satchel.dir.path().join("books").join("bk1");
        std::fs::create_dir_all(&folder).unwrap();
        let part = folder.join("content.epub.part");
        let (gate_tx, gate_rx) = tokio::sync::oneshot::channel();
        let (_, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 3 * MB, &hash),
            FetchHooks {
                pause_at: Some((MB, gate_rx)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        loop {
            if let PeerEvent::Transfer(p) = pair.satchel.next_event().await {
                if p.received >= MB {
                    break;
                }
            }
        }
        // Poison the `.part` while the transfer is parked: bytes it never sent.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&part)
                .unwrap();
            f.write_all(b"POISONED-EXTRA-BYTES").unwrap();
        }
        gate_tx.send(()).unwrap();
        let err = timeout(TRANSFER_LIVENESS, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(err.kind(), "blobHashMismatch");
        assert!(!folder.join("content.epub").exists());
        assert!(!part.exists(), "the poisoned part is removed");
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn a_stalled_server_trips_the_fetch_idle_deadline() {
        // Finding H2: a server that sends the header then stops must not hold
        // the transfer open forever — the idle deadline drops it.
        let pair = linked("blob-idle", &["blob:*"]).await;
        pair.satchel
            .node
            .set_blob_idle_timeout(Duration::from_millis(300));
        let (_, hash) = write_book(pair.shelf.dir.path(), "bk1", 2 * MB as usize, 21);
        std::fs::create_dir_all(pair.satchel.dir.path().join("books").join("bk1")).unwrap();
        // The shelf sends the header, then stalls before the body.
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *pair.shelf.node.serve_body_gate.lock().expect("serve gate") = Some(release_rx);
        let (_, task) = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", 2 * MB, &hash),
            FetchHooks::default(),
        )
        .await
        .unwrap();
        let err = timeout(Duration::from_secs(10), task)
            .await
            .expect("the idle deadline fires well within 10s")
            .unwrap()
            .unwrap_err();
        assert_eq!(err.kind(), "blobInterrupted");
        let _ = release_tx.send(()); // let the shelf task unwind
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlinked_part_is_refused_before_the_fetch() {
        // Finding H4: a `.part` planted as a symlink out of the root must be
        // refused, not appended through.
        let pair = linked("blob-partlink", &["blob:*"]).await;
        let (_, hash) = write_book(pair.shelf.dir.path(), "bk1", MB as usize, 4);
        let folder = pair.satchel.dir.path().join("books").join("bk1");
        std::fs::create_dir_all(&folder).unwrap();
        let victim = pair.satchel.dir.path().join("victim");
        std::fs::write(&victim, b"x").unwrap();
        std::os::unix::fs::symlink(&victim, folder.join("content.epub.part")).unwrap();
        let err = fetch(
            &pair.satchel.node,
            request(&pair, "bk1", "content.epub", MB, &hash),
            FetchHooks::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "pathOutsideDataRoot");
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"x",
            "the victim is untouched"
        );
        pair.shelf.close().await;
        pair.satchel.close().await;
    }

    #[tokio::test]
    async fn hash_file_validates_and_reports() {
        let dir = crate::testutil::ScratchDir::new("blob-hash");
        let (bytes, hash) = write_book(dir.path(), "bk1", 100_000, 3);
        let got = hash_file(dir.path(), "bk1", "content.epub").await.unwrap();
        assert_eq!(got.blake3, hash);
        assert_eq!(got.size, bytes.len() as u64);
        assert_eq!(
            hash_file(dir.path(), "bk1", "content.exe")
                .await
                .unwrap_err()
                .kind(),
            "invalidBlobName"
        );
        assert_eq!(
            hash_file(dir.path(), "nope", "content.epub")
                .await
                .unwrap_err()
                .kind(),
            "folderGone"
        );
        assert_eq!(
            hash_file(dir.path(), "bk1", "cover.jpg")
                .await
                .unwrap_err()
                .kind(),
            "io"
        );
    }
}
