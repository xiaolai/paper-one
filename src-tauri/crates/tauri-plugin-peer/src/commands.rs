//! The commands. Each is one line of policy on top of a module that does the
//! work, so the modules stay testable without a Tauri app.
//!
//! Adding a command means four edits: here, `generate_handler!` in `lib.rs`,
//! `COMMANDS` in `build.rs`, and `permissions/default.toml`. Miss the handler
//! or the build list and the command is unreachable; miss the ACL and it is
//! refused.
//!
//! Frames cross IPC as byte arrays (`Vec<u8>` ⇄ a JSON array of numbers).
//! Correct and simple; if the envelope traffic ever makes it the bottleneck,
//! `tauri::ipc::Response` carries raw bytes without changing the contract
//! below it.

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::blobs::{self, FetchHooks, FetchRequest, HashResult};
use crate::data_root::data_root;
use crate::error::{Error, Result};
use crate::pairing::{self, PairOffer, PairStart};
use crate::peers::PeerRecord;
use crate::role::{local_role, set_stored_role, Role};
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

// ── status, role, root (WI-5.8) ───────────────────────────────────────────
//
// `fs_fsync` LIVED HERE and moved to the app crate (`src-tauri/src/atomic.rs`,
// WI-20.35). The sync journal's durability barrier is the kernel's business,
// and a kernel that reached a removable capability's command for it by
// string stopped flushing the moment the capability was removed.

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
pub fn peer_local_role<R: Runtime>(app: AppHandle<R>) -> Result<Role> {
    local_role(&data_root(&app)?)
}

/// Record which side of a pairing this device is, for the next launch.
///
/// NOT A LIVE SWITCH, and the name does not pretend to be one. `state.rs`
/// reads the role when the node starts and `sync` binds it at its own start;
/// this writes the answer they will read next time. The pane offers it only
/// while the device is unpaired — where there is nothing yet to reconcile —
/// and says that a restart applies it.
///
/// A phone ignores this by construction: `local_role` lets the build target
/// win outright, so a stored `shelf` on a mobile build changes nothing.
#[tauri::command]
pub fn peer_set_local_role<R: Runtime>(app: AppHandle<R>, role: Role) -> Result<()> {
    set_stored_role(&data_root(&app)?, role)
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
/// returned; on refuse, `null`. `attemptId` is the id from the
/// `peer://pairing-pending` event, REQUIRED: it binds this answer to that
/// exact attempt, so a stale confirm — or one meant for a pre-played attempt
/// — is refused (finding M9). The optional form restored the unbound
/// behaviour the binding exists to close, and is gone.
#[tauri::command]
pub async fn peer_pair_confirm<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    accept: bool,
    grants: Option<Vec<String>>,
    attempt_id: String,
) -> Result<Option<PeerRecord>> {
    let node = state.node(&app).await?;
    pairing::confirm(&node, accept, grants.unwrap_or_default(), attempt_id).await
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    fn read(rel: &str) -> String {
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/").to_owned() + rel)
            .unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    /// Names between the quotes of a `= &["a", "b"]` list.
    ///
    /// The `=` is found FIRST and the `[` only after it — the webhost twin's
    /// comment records why, and this port re-earned the lesson on its first
    /// run: taking the first `[` past the marker reads `&[&str]`, the type
    /// annotation, and returns an empty set.
    fn quoted_after(source: &str, marker: &str) -> BTreeSet<String> {
        let start = source.find(marker).unwrap_or_else(|| panic!("{marker}?"));
        let equals = source[start..].find('=').expect("an assignment") + start;
        let open = source[equals..].find('[').expect("a list") + equals;
        let close = source[open..].find(']').expect("a closed list") + open;
        source[open..close]
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    /// The check this plugin never had, ported from
    /// `tauri-plugin-webhost::commands::tests::lists_agree` — whose own
    /// comment named this crate as the one without it. Four hand-kept lists
    /// that must agree: a command missing from `build.rs` is unreachable
    /// however correct the handler, one missing from `default.toml` is
    /// refused at the ACL, one missing from `generate_handler!` never
    /// registers — and all three fail at RUNTIME with an error that names
    /// permissions rather than the omission. `peer_set_local_role` already
    /// paid for this once: registered and hand-permissioned, absent from
    /// `COMMANDS`, green until the next clean regeneration.
    #[test]
    fn lists_agree() {
        let declared = quoted_after(&read("build.rs"), "const COMMANDS");

        let lib = read("src/lib.rs");
        let start = lib.find("generate_handler!").expect("a handler list");
        let open = lib[start..].find('[').expect("a list") + start;
        let close = lib[open..].find(']').expect("a closed list") + open;
        let registered: BTreeSet<String> = lib[open + 1..close]
            .split(',')
            .map(|entry| {
                entry
                    .trim()
                    .rsplit("::")
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_owned()
            })
            .filter(|entry| !entry.is_empty())
            .collect();

        let acl: BTreeSet<String> =
            quoted_after(&read("permissions/default.toml"), "permissions =")
                .into_iter()
                .filter_map(|grant| grant.strip_prefix("allow-").map(|n| n.replace('-', "_")))
                .collect();

        /* Every public fn in this file IS a command — `pub fn` and
         * `pub async fn` both; `paper_data_root` carries no `peer_` prefix,
         * so the collection is by visibility, not by name shape. */
        let source = read("src/commands.rs");
        let mut implemented: BTreeSet<String> = BTreeSet::new();
        for marker in ["pub async fn ", "pub fn "] {
            for (at, m) in source.match_indices(marker) {
                let rest = &source[at + m.len()..];
                let end = rest.find(['<', '(']).unwrap_or(rest.len());
                let name = rest[..end].trim();
                /* Identifiers only: this test lives in the file it reads, so
                 * its own marker LITERALS match themselves — the quotes and
                 * braces around them are what this filter drops. */
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    implemented.insert(name.to_owned());
                }
            }
        }

        assert!(
            !declared.is_empty(),
            "the COMMANDS parser found nothing, which would make this check pass on anything"
        );
        assert_eq!(declared, registered, "build.rs vs generate_handler!");
        assert_eq!(declared, acl, "build.rs vs permissions/default.toml");
        assert_eq!(
            declared, implemented,
            "build.rs vs the handlers in this file"
        );
    }
}
