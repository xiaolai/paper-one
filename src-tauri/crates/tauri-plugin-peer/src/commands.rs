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
use crate::circle::{self, KnownPerson};
use crate::data_root::data_root;
use crate::error::{Error, Result};
use crate::pairing::{self, PairKind, PairOffer, PairStart};
use crate::peers::PeerRecord;
use crate::person::{self, Custody, OsKeychain, PersonId};
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
///
/// `kind` is what the pairing is FOR (WI-22.B3): `device` for your own second
/// device, `circle` for another person. Absent means `device`, which is every
/// caller that existed before the circle — so a webview built against the old
/// signature keeps pairing devices and nothing else.
#[tauri::command]
pub async fn peer_pair_begin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    name: Option<String>,
    kind: Option<PairKind>,
) -> Result<PairOffer> {
    let node = state.node(&app).await?;
    pairing::begin(&node, name, kind.unwrap_or_default())
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

// ── the person identity (WI-22.B1) ────────────────────────────────────────
//
// ⚠️ **EVERY ONE OF THESE IS `async` AND DOES ITS WORK IN `spawn_blocking`,
// AND THE FIRST DRAFT WAS SYNCHRONOUS.** Tauri runs a synchronous command ON
// THE MAIN THREAD. The keychain is a blocking call that can sit for as long as
// it likes — it may consult a daemon, and on macOS it may put a permission
// prompt in front of the reader — so a sync command wedged the main thread and
// every IPC message queued behind it FOR EVER.
//
// MEASURED IN THE RUNNING APP, not reasoned about: the panel rendered
// correctly, "Start a circle" was pressed, and from that moment every
// `invoke` timed out while `webview_execute_js` still answered instantly —
// which is exactly the signature of a live webview thread and a blocked main
// thread. From the outside it looks like a button that does nothing.
//
// The filesystem commands go the same way for the same reason: a read of a
// file on a slow or network-backed volume is not different in kind from a
// keychain call, and having two rules here is how the next one gets it wrong.

/// Run blocking work off the main thread.
///
/// `spawn_blocking` rather than a plain `async` body: making a command `async`
/// moves it to the async runtime, and then a blocking call inside it stalls a
/// runtime worker instead of the main thread — better, and still wrong. The
/// work is genuinely blocking, so it belongs on a thread meant for that.
async fn off_thread<T, F>(work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| Error::Identity(format!("that task could not run: {e}")))?
}
//
// The DEVICE key is `identity.rs` and never leaves the plugin. What is here is
// the PERSON root: the thing that says several devices are one reader.
//
// ⚠️ **`person_phrase` HANDS A SECRET TO THE WEBVIEW, AND THAT IS THE DESIGN
// RATHER THAN AN OVERSIGHT.** `identity.md` §"Skip is the DEFAULT" requires the
// twelve words be re-showable from Settings for as long as a working device
// holds them, and a phrase nothing can display is a backup nobody has. The
// exposure is bounded on purpose: it is the ONLY command that returns the
// secret, it is never returned by `person_status` (which every surface polls),
// and `person_ensure` deliberately does not return it either — so the words
// cross that boundary when a reader asked to see them and at no other time.

/// What `person_status` returns — the standing custody state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonStatus {
    /// `None` for a reader who has never shared. Not a warning.
    pub person_id: Option<String>,
    #[serde(flatten)]
    pub custody: Custody,
}

/// The person identity as it stands, minting nothing.
///
/// ⚠️ **READ-ONLY, AND A STATUS CALL MUST STAY THAT WAY.** Every surface polls
/// this; if it minted, opening Settings would give a reader who never shares a
/// person identity, and the laziness the whole custody design rests on would be
/// gone without anybody removing it.
#[tauri::command]
pub async fn peer_person_status<R: Runtime>(
    app: AppHandle<R>,
    devices: usize,
    circle: usize,
) -> Result<PersonStatus> {
    let root = data_root(&app)?;
    off_thread(move || {
        let keychain = OsKeychain;
        Ok(PersonStatus {
            /* `_at`, not the bare root read: a demoted device still BELONGS to
            a person and the panel has to say whose it is. Reporting `None`
            is what offered "Start a circle" to a device already in one. */
            person_id: person::person_id_at(&keychain, &root)?.map(|id| id.to_string()),
            custody: person::custody(&keychain, &root, devices, circle)?,
        })
    })
    .await
}

/// Make a person identity if there is not one, and answer which it is.
///
/// Called at the first moment one is actually needed — the first circle
/// pairing, or the second device. Returns the id and NOT the phrase: showing
/// the words is [`peer_person_phrase`]'s job, and a reader asked for it.
#[tauri::command]
pub async fn peer_person_ensure<R: Runtime>(app: AppHandle<R>) -> Result<String> {
    let root = data_root(&app)?;
    off_thread(move || {
        let (id, _phrase) = person::ensure(&OsKeychain, &root)?;
        Ok(id.to_string())
    })
    .await
}

/// The twelve words, for the one surface that shows them.
///
/// `None` when this device does not hold the root — a leaf, or a reader with no
/// identity. That is a state to describe, not an error: a leaf has nothing to
/// show and saying so is the honest answer.
#[tauri::command]
pub async fn peer_person_phrase<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>> {
    let _ = data_root(&app)?;
    off_thread(move || Ok(person::root(&OsKeychain)?.map(|phrase| phrase.words()))).await
}

/// Take a person identity back from twelve words.
#[tauri::command]
pub async fn peer_person_restore<R: Runtime>(app: AppHandle<R>, words: String) -> Result<String> {
    let root = data_root(&app)?;
    off_thread(move || Ok(person::restore(&OsKeychain, &root, &words)?.to_string())).await
}

/// Drop the root this device holds, making it a leaf.
#[tauri::command]
pub async fn peer_person_forget<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    let root = data_root(&app)?;
    off_thread(move || person::forget(&OsKeychain, &root)).await
}

/// Sign a delegation for another device — home only.
#[tauri::command]
pub async fn peer_person_delegate<R: Runtime>(
    app: AppHandle<R>,
    device: String,
    not_before: i64,
    not_after: i64,
    roster: u64,
) -> Result<person::SignedDelegation> {
    let root = data_root(&app)?;
    off_thread(move || {
        let keychain = OsKeychain;
        let person_id: PersonId = person::person_id(&keychain)?
            .ok_or_else(|| Error::Identity("this device has no person identity".into()))?;
        person::sign_delegation(
            &keychain,
            &root,
            person::Delegation {
                person: person_id,
                device,
                not_before,
                not_after,
                roster,
            },
        )
    })
    .await
}

// ── the circle roster (WI-22.B3) ──────────────────────────────────────────

/// The people this reader has paired with.
#[tauri::command]
pub async fn peer_circle_people<R: Runtime>(app: AppHandle<R>) -> Result<Vec<KnownPerson>> {
    let root = data_root(&app)?;
    off_thread(move || circle::known_people(&root)).await
}

/// What this device needs to put on a page — WI-22.C1.
///
/// ⚠️ **THE DELEGATION AND THE ROSTER LIVE IN RUST AND A PAGE IS BUILT IN
/// TYPESCRIPT**, so one of them has to cross. This is that crossing, and it
/// carries only what a page carries: device ids, a window, a signature. No
/// address hints and no join times — `identity.md` is explicit that a roster
/// on a page is device ids ONLY, because hints are how a reader's machines are
/// located and a page goes to everybody.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePublisher {
    pub person: String,
    pub device: String,
    /// The delegation, as its own object. The TypeScript side canonicalises it
    /// before signing anything over it — `delegationBytes` covers the FIELDS in
    /// a fixed order, never this JSON, so re-spelling it changes nothing.
    pub delegation: person::SignedDelegation,
    /// Device ids the roster vouches for.
    pub roster: Vec<String>,
    /// How many revocations this device knows of — the page's `revocations`.
    pub revocations: usize,
}

/// This device's publishing identity, or `None` when it has none.
///
/// `None` for a reader who has never shared, which is the ordinary state and
/// not a failure. Renews the delegation if it is due, because a publisher whose
/// credentials expired is one whose pages every friend silently refuses.
#[tauri::command]
pub async fn peer_circle_mine<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
) -> Result<Option<PagePublisher>> {
    let node = state.node(&app).await?;
    let root = data_root(&app)?;
    let device = node.id().to_string();
    off_thread(move || {
        let keychain = OsKeychain;
        /* A device with no identity has nothing to publish with. That is a
        reader who has never shared, not a broken install. */
        if person::person_id_at(&keychain, &root)?.is_none() {
            return Ok(None);
        }
        let mine = circle::mine_for(&keychain, &root, &device, circle::now_ms())?;
        Ok(Some(PagePublisher {
            person: mine.delegation.delegation.person.to_string(),
            device,
            roster: mine.roster.roster.devices.clone(),
            revocations: mine.roster.roster.revocations.len(),
            delegation: mine.delegation,
        }))
    })
    .await
}

/// The device ids this device's LAST ACCEPTED roster vouches for — read from
/// the file, minting and renewing nothing. `None` for a device that has never
/// published.
///
/// ⚠️ **READ-ONLY, FOR `peer_person_status`'S REASON.** The Circle panel counts
/// the roster on every refresh to decide whether to show the custody marker,
/// and it read the count out of `peer_circle_mine` — which renews a delegation
/// that is due and REFUSES a leaf whose delegation has run out. Refreshing a
/// panel then either wrote credentials or replaced the panel with an error, for
/// a number that was on disk the whole time.
#[tauri::command]
pub async fn peer_circle_roster<R: Runtime>(app: AppHandle<R>) -> Result<Option<Vec<String>>> {
    let root = data_root(&app)?;
    off_thread(move || Ok(circle::read_mine(&root)?.map(|mine| mine.roster.roster.devices))).await
}

/// Sign a page with this device's endpoint key.
///
/// ⚠️ **THE ONLY THING THIS KEY MAY BE ASKED TO SIGN, AND THE CONFINEMENT IS
/// IN `identity::sign_page`, NOT HERE.** The same key authenticates every QUIC
/// connection this device makes; a command that signed arbitrary bytes with it
/// would let a caller mint something a peer reads as a different protocol
/// entirely. A delegation and a roster are signed by the PERSON root, on a key
/// the renderer can never reach.
///
/// The bytes are built by `signedBytes` in `page.ts` — ONE canonicaliser, in
/// TypeScript. Rust does not build them and deliberately does not know how:
/// `wire.md` names two canonicalisers disagreeing as a signature that verifies
/// on one machine and fails on another, and looks like corruption.
#[tauri::command]
pub async fn peer_page_sign<R: Runtime>(app: AppHandle<R>, message: String) -> Result<String> {
    let root = data_root(&app)?;
    off_thread(move || crate::identity::sign_page(&root, &message)).await
}

/// Introduce this device to another, over the circle door.
///
/// ⚠️ **NOTHING IN THE APP COULD SEND A HELLO.** `circle::admit` was written,
/// tested and served; `circle::serve` answered; and no command anywhere could
/// produce the value it admits. The protocol had one side.
///
/// Returns whether the far side admitted this device. `false` is an ANSWER, not
/// a failure — that person does not know this reader yet — so it is reported as
/// a value and not an error. Which check refused is deliberately not available:
/// see `circle::Ack`.
///
/// `addrs` are hints. Absent, the ones on file for that device are used; a
/// device with neither is a dial that can only work through discovery.
#[tauri::command]
pub async fn peer_circle_introduce<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    device: String,
    addrs: Option<Vec<String>>,
) -> Result<bool> {
    let node = state.node(&app).await?;
    let id = crate::node::parse_peer_id(&device)?;
    let hints = match addrs {
        Some(hints) => hints,
        /* The peer store is the only place addresses are kept. A device this
        reader has never met has none, which is the ordinary case for the
        door being dialled at all — hence the explicit argument. */
        None => node
            .peers()
            .get(&device)
            .map(|record| record.last_addrs.clone())
            .unwrap_or_default(),
    };
    circle::introduce(&node, crate::session::endpoint_addr(id, &hints)).await
}

/// Revoke one of this person's own devices — a laptop lost, a phone sold.
///
/// ⚠️ **NOTHING COULD PUT A DEVICE INTO A REVOCATION LIST.** The list was
/// carried, signed, verified, bound to its issuer and acted on by receivers,
/// and there was no way to add to it. See `circle::revoke_device`.
///
/// Three things happen and all three are needed: the roster stops vouching for
/// it, the revocation is stated so peers holding an OLDER roster stop too, and
/// the device loses its trust HERE — a revocation that leaves the device still
/// paired with the machine that revoked it is a notice, not a revocation.
///
/// Friends are told on the keeper's next round, which is poked immediately
/// rather than waited for: see `keeper::ROUND_EVERY`.
#[tauri::command]
pub async fn peer_circle_revoke<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    device: String,
) -> Result<()> {
    let node = state.node(&app).await?;
    let root = data_root(&app)?;
    {
        let keychain = OsKeychain;
        let device = device.clone();
        let root = root.clone();
        off_thread(move || {
            circle::revoke_device(&keychain, &root, &device, circle::now_ms()).map(|_| ())
        })
        .await?;
    }
    /* Locally too. `PeerUnknown` is the ordinary case — a device of this
    person's that this machine never paired with directly. */
    match node.forget_peer(&device) {
        Ok(()) | Err(Error::PeerUnknown(_)) => {}
        Err(err) => return Err(err),
    }
    node.keeper_wake.notify_waiters();
    Ok(())
}

/// Rename somebody already in the circle.
///
/// ⚠️ **RENAME ONLY — IT USED TO CREATE, AND THAT WALKED AROUND THE WHOLE SAS
/// EXCHANGE.** A person id is a public key; `circle::admit` admits anybody this
/// file names, so a command that appended an arbitrary id let a caller install
/// a stranger's key and then accept correctly-signed hellos from them as a
/// known person. Every other part of this design insists a person crosses only
/// where two humans compared six digits — `PairHello.person` says so in as many
/// words — and this one line made that a convention rather than a rule.
///
/// An unknown person is an ERROR rather than a silent insert: a surface that
/// asked to rename somebody who is not there has a bug, and swallowing it is
/// how the create path grew back.
///
/// ⚠️ **`display_name` IS NOT A KEY AND CANNOT BECOME ONE.** It is what the
/// reader calls them, theirs to change, and nothing downstream may match on it.
/// Two friends sharing a name is a feature — people share names — and a surface
/// that deduplicated on it would merge two circles into one.
#[tauri::command]
pub async fn peer_circle_remember<R: Runtime>(
    app: AppHandle<R>,
    person: String,
    display_name: String,
) -> Result<()> {
    let root = data_root(&app)?;
    off_thread(move || {
        let mut people = circle::known_people(&root)?;
        let known = people
            .iter_mut()
            .find(|k| k.person == person)
            .ok_or_else(|| {
                Error::Identity(
                    "that person is not in this circle — people are added by pairing".into(),
                )
            })?;
        known.display_name = display_name;
        circle::set_known_people(&root, &people)
    })
    .await
}

/// Drop somebody from the circle.
///
/// ⚠️ **THIS REMOVES THE ADMISSION, NOT THE HISTORY.** Passages they already
/// sent are on this disk and stay there until a purge asks for them by name —
/// `relationships.md`'s `retain` decides which, and it is a separate act with
/// its own confirmation. Conflating the two would make "I do not want to see
/// this person's new marks" silently delete a year of their old ones.
#[tauri::command]
pub async fn peer_circle_forget<R: Runtime>(app: AppHandle<R>, person: String) -> Result<()> {
    let root = data_root(&app)?;
    off_thread(move || {
        let people: Vec<KnownPerson> = circle::known_people(&root)?
            .into_iter()
            .filter(|k| k.person != person)
            .collect();
        circle::set_known_people(&root, &people)
    })
    .await
}
