//! The commands. Each is one line of policy on top of a module that does the
//! work, so the modules stay testable without a Tauri app.
//!
//! Adding a command means three edits: here, `COMMANDS` in `build.rs`, and
//! `permissions/default.toml`. Miss the second and the command is unreachable;
//! miss the third and it is refused by the ACL.
//!
//! Frames cross IPC as byte arrays (`Vec<u8>` ⇄ a JSON array of numbers).
//! Correct and simple; if the envelope traffic ever makes it the bottleneck,
//! `tauri::ipc::Response` carries raw bytes without changing the contract
//! below it.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::blobs::{self, FetchHooks, FetchRequest, HashResult};
use crate::data_root::{checked_target, data_root};
use crate::error::{Error, Result};
use crate::pairing::{self, PairOffer, PairStart};
use crate::peers::PeerRecord;
use crate::role::{local_role, Role};
use crate::session;
use crate::state::PeerState;

/// What `peer_status` returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This crate's version, so a mismatched TS/Rust pair is visible.
    pub plugin_version: &'static str,
    /// The endpoint's public key in iroh's canonical text form — stable
    /// across launches (`peer/identity.key`).
    pub endpoint_id: String,
    pub role: Role,
    /// Whether `peer_ready` has been called.
    pub ready: bool,
}

// ── status, role, root, fsync (WI-5.8) ────────────────────────────────────

/// The endpoint's identity and this device's role. Starts the node on the
/// first call.
#[tauri::command]
pub async fn peer_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
) -> Result<Status> {
    let node = state.node(&app).await?;
    Ok(Status {
        plugin_version: env!("CARGO_PKG_VERSION"),
        endpoint_id: node.id().to_string(),
        role: node.role(),
        ready: node.is_ready(),
    })
}

/// This device's role, decided in Rust.
#[tauri::command]
pub fn peer_local_role() -> Result<Role> {
    local_role()
}

/// The storage root, as a string the webview can join paths onto. Exists on
/// return.
#[tauri::command]
pub fn paper_data_root<R: Runtime>(app: AppHandle<R>) -> Result<String> {
    let root = data_root(&app)?;
    root.to_str()
        .map(str::to_owned)
        .ok_or(Error::PathNotUnicode(root))
}

/// Flush a file (or directory) inside the data root to stable storage.
///
/// The fs plugin's `writeTextFile` returns when the bytes are handed to the
/// OS, not when they are on disk; a rename is durable only once its parent
/// directory is synced. This is the missing half. Anything outside the data
/// root is refused with a typed error before the file is opened.
#[tauri::command]
pub async fn fs_fsync<R: Runtime>(app: AppHandle<R>, path: String) -> Result<()> {
    let root = data_root(&app)?;
    let target = checked_target(&root, &PathBuf::from(path))?;
    // Read-only open: fsync does not need a writable descriptor, and this way
    // a directory can be synced too (a write open of a directory fails).
    let file = tokio::fs::File::open(&target).await?;
    file.sync_all().await?;
    Ok(())
}

// ── peers and grants (WI-B.1) ─────────────────────────────────────────────

#[tauri::command]
pub async fn peer_list_peers<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
) -> Result<Vec<PeerRecord>> {
    Ok(state.node(&app).await?.list_peers())
}

/// Remove a peer; any session it has closes with reason `revoked`.
#[tauri::command]
pub async fn peer_forget_peer<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    id: String,
) -> Result<()> {
    state.node(&app).await?.forget_peer(&id)
}

#[tauri::command]
pub async fn peer_set_grants<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    id: String,
    grants: Vec<String>,
) -> Result<()> {
    state.node(&app).await?.set_grants(&id, grants)
}

/// Does the peer hold this grant (exact, or under a `<prefix>:*`)? The
/// envelope router asks before dispatching a service call.
#[tauri::command]
pub async fn peer_has_grant<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    id: String,
    grant: String,
) -> Result<bool> {
    Ok(state.node(&app).await?.has_grant(&id, &grant))
}

// ── pairing (WI-B.2) ──────────────────────────────────────────────────────

/// Shelf: mint a pairing offer — URL, QR as SVG, expiry. Replaces any
/// earlier offer. `name` is what the satchel will call this device.
#[tauri::command]
pub async fn peer_pair_begin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    name: Option<String>,
) -> Result<PairOffer> {
    let node = state.node(&app).await?;
    pairing::begin(&node, name)
}

/// Shelf: drop the offer; a satchel waiting on it is refused.
#[tauri::command]
pub async fn peer_pair_cancel<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
) -> Result<()> {
    let node = state.node(&app).await?;
    pairing::cancel(&node);
    Ok(())
}

/// Shelf: the human's answer to `peer://pairing-pending`. On accept the
/// satchel is persisted with `grants` (default none) and the record is
/// returned; on refuse, `null`.
#[tauri::command]
pub async fn peer_pair_confirm<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    accept: bool,
    grants: Option<Vec<String>>,
) -> Result<Option<PeerRecord>> {
    let node = state.node(&app).await?;
    pairing::confirm(&node, accept, grants.unwrap_or_default()).await
}

/// Satchel: dial the shelf in the URI. Returns the SAS to show at once; the
/// outcome arrives as `peer://pairing-result`. On success the shelf is
/// persisted with `grants` (default none). `name` is what the shelf will
/// call this device.
#[tauri::command]
pub async fn peer_pair_from_uri<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    uri: String,
    name: Option<String>,
    grants: Option<Vec<String>>,
) -> Result<PairStart> {
    let node = state.node(&app).await?;
    let (start, _task) = pairing::from_uri(&node, &uri, name, grants.unwrap_or_default()).await?;
    Ok(start)
}

// ── sessions (WI-B.3) ─────────────────────────────────────────────────────

/// The webview is listening: accept `peer/1` sessions from now on.
#[tauri::command]
pub async fn peer_ready<R: Runtime>(app: AppHandle<R>, state: State<'_, PeerState>) -> Result<()> {
    state.node(&app).await?.set_ready();
    Ok(())
}

/// Dial a paired peer; `hello` is the app's object for the plugin hello
/// (`kind` and `role` are set by the plugin). Returns the session id.
#[tauri::command]
pub async fn peer_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    peer_id: String,
    hello: Option<serde_json::Value>,
) -> Result<u64> {
    let node = state.node(&app).await?;
    session::connect(&node, &peer_id, hello.unwrap_or(serde_json::Value::Null)).await
}

#[tauri::command]
pub async fn peer_send<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    session_id: u64,
    bytes: Vec<u8>,
) -> Result<()> {
    state
        .node(&app)
        .await?
        .session_send(session_id, &bytes)
        .await
}

/// Up to `max` waiting frames (default 64); returns at once, possibly
/// empty. `peer://session-frames` says when to come back.
#[tauri::command]
pub async fn peer_session_recv<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    session_id: u64,
    max: Option<usize>,
) -> Result<Vec<Vec<u8>>> {
    let frames = state
        .node(&app)
        .await?
        .session_recv(session_id, max.unwrap_or(64))?;
    Ok(frames.into_iter().map(|b| b.to_vec()).collect())
}

#[tauri::command]
pub async fn peer_close<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    session_id: u64,
) -> Result<()> {
    state.node(&app).await?.session_close(session_id)
}

// ── blobs (WI-B.4) ────────────────────────────────────────────────────────

/// Fetch `<folder>/<name>` from a peer over an open session into this
/// device's data root. Returns the transfer id; progress and the outcome
/// arrive as `peer://transfer`.
#[tauri::command]
pub async fn peer_blob_fetch<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    request: FetchRequest,
) -> Result<u64> {
    let node = state.node(&app).await?;
    let (transfer_id, _task) = blobs::fetch(&node, request, FetchHooks::default()).await?;
    Ok(transfer_id)
}

/// BLAKE3 and size of a blob in this device's data root.
#[tauri::command]
pub async fn peer_hash_file<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    name: String,
) -> Result<HashResult> {
    let root = data_root(&app)?;
    blobs::hash_file(&root, &folder, &name).await
}
