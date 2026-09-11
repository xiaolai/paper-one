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
use crate::share::policy::{SharePolicy, ShareService};
use crate::share::ContentHash;
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
    /// How many inbound connections never reached a protocol module.
    ///
    /// ⚠️ **READABLE BECAUSE THE RECEIVING SIDE HAD NOTHING TO SAY.** When a
    /// pairing fails in the transport, the machine that was dialled is the
    /// one that knows — and until this existed it could not be asked: a far
    /// end that dropped the connection and one that was never dialled gave
    /// identical answers to every command, log and event. A non-zero count
    /// here is the difference between "nobody called" and "I hung up".
    pub dropped_inbound: u64,
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
        dropped_inbound: node.dropped_inbound(),
        role: node.role(),
        ready: node.is_ready(),
    })
}

/// This device's role, decided in Rust.
/// ⚠️ **ASYNC AND OFF-THREAD, BECAUSE IT TOUCHES THE DISK.** A synchronous
/// `#[tauri::command]` runs on the thread that dispatches commands, so a read
/// waiting on slow or unresponsive storage stops EVERY other command — the app
/// stops answering, and nothing in it names a file as the reason. The work here
/// is small and the failure it prevents is not.
#[tauri::command]
pub async fn peer_local_role<R: Runtime>(app: AppHandle<R>) -> Result<Role> {
    let root = data_root(&app)?;
    off_thread(move || local_role(&root)).await
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
/// Off the command thread for the reason `peer_local_role` records — and this
/// one WRITES and `sync_all`s, which is the slower half.
#[tauri::command]
pub async fn peer_set_local_role<R: Runtime>(app: AppHandle<R>, role: Role) -> Result<()> {
    let root = data_root(&app)?;
    off_thread(move || set_stored_role(&root, role)).await
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
    /// ⚠️ **EVERY PARSER HERE READS CODE WITH THE COMMENTS TAKEN OUT.** They
    /// did not, and the first documentation change that mentioned a marker
    /// broke the check: a doc comment on `init` naming the handler macro made
    /// `find` land in prose, and the brackets it then read were a parenthesis
    /// in an English sentence. A source scanner that cannot tell code from
    /// commentary makes harmless documentation a build failure — and, worse,
    /// could make a real omission pass by matching a mention of it. Found by
    /// audit, by walking into it.
    /// Source with every comment replaced by whitespace.
    ///
    /// ⚠️ **LINE COUNTS AND OFFSETS ARE PRESERVED**, so a failure still points
    /// somewhere real. Doc comments (`///`, `//!`) and block comments both go;
    /// string literals stay, because a command name inside one is a value this
    /// crate might genuinely be using. Nesting is handled: Rust's block
    /// comments nest, and treating them as flat would end the first one early
    /// and leak code back in.
    fn without_comments(source: &str) -> String {
        let bytes: Vec<char> = source.chars().collect();
        let mut out = String::with_capacity(source.len());
        let mut at = 0usize;
        let mut depth = 0usize;
        while at < bytes.len() {
            let two =
                |i: usize| -> Option<(char, char)> { Some((*bytes.get(i)?, *bytes.get(i + 1)?)) };
            if depth > 0 {
                match two(at) {
                    Some(('/', '*')) => {
                        depth += 1;
                        out.push_str("  ");
                        at += 2;
                        continue;
                    }
                    Some(('*', '/')) => {
                        depth -= 1;
                        out.push_str("  ");
                        at += 2;
                        continue;
                    }
                    _ => {}
                }
                out.push(if bytes[at] == '\n' { '\n' } else { ' ' });
                at += 1;
                continue;
            }
            match two(at) {
                Some(('/', '*')) => {
                    depth = 1;
                    out.push_str("  ");
                    at += 2;
                }
                Some(('/', '/')) => {
                    while at < bytes.len() && bytes[at] != '\n' {
                        out.push(' ');
                        at += 1;
                    }
                }
                _ => {
                    out.push(bytes[at]);
                    at += 1;
                }
            }
        }
        out
    }

    #[test]
    fn lists_agree() {
        let declared = quoted_after(&without_comments(&read("build.rs")), "const COMMANDS");

        let lib = without_comments(&read("src/lib.rs"));
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
        let source = without_comments(&read("src/commands.rs"));
        let mut implemented: BTreeSet<String> = BTreeSet::new();
        for marker in ["pub async fn ", "pub fn "] {
            for (at, m) in source.match_indices(marker) {
                let rest = &source[at + m.len()..];
                let end = rest.find(['<', '(']).unwrap_or(rest.len());
                let name = rest[..end].trim();
                /* Identifiers only: this test lives in the file it reads, so
                 * its own marker LITERALS match themselves — the quotes and
                 * braces around them are what this filter drops. Comments are
                 * already gone; string literals are not, which is what this
                 * still guards. */
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
pub(crate) async fn off_thread<T, F>(work: F) -> Result<T>
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
            crate::circle::now_ms(),
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
    person's that this machine never paired with directly.

    ⚠️ **THE KEEPER IS WOKEN WHETHER OR NOT THIS SUCCEEDS, AND IT USED TO BE
    SKIPPED.** The roster revocation above has already COMMITTED by this point;
    returning early past the wake left the round that acts on it waiting for its
    next scheduled pass — six hours — over a revocation the reader was told had
    happened. The local failure is still raised, so the caller learns cleanup is
    incomplete; what must not also be lost is the part that succeeded. */
    let forgotten = match node.forget_peer(&device) {
        Ok(()) | Err(Error::PeerUnknown(_)) => Ok(()),
        Err(err) => Err(err),
    };
    /* ⚠️ **`notify_one`, NOT `notify_waiters`.** `Notify::notify_waiters` wakes
     * only tasks ALREADY parked at `notified()`, and the keeper spends most of
     * its life inside a round rather than at that line — so a revocation made
     * while it was working was dropped, and the comment at `keeper.rs`'s select
     * (*"A revocation made HERE does not wait six hours to be told"*) was
     * false. `notify_one` stores a permit when nobody is waiting, so the next
     * `notified()` returns at once. `session.rs` already uses it, which is what
     * shows the difference was known and missed here. Found by audit. */
    node.keeper_wake.notify_one();
    forgotten
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
        /* One transaction: the read and the write are the same critical
         * section, so a rename cannot be built on a snapshot a revocation has
         * already moved past. See `circle::update_known_people`. */
        circle::update_known_people(&root, |people| {
            let known = people
                .iter_mut()
                .find(|k| k.person == person)
                .ok_or_else(|| {
                    Error::Identity(
                        "that person is not in this circle — people are added by pairing".into(),
                    )
                })?;
            known.display_name = display_name;
            Ok(())
        })
        .map(|_| ())
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
        circle::update_known_people(&root, |people| {
            people.retain(|k| k.person != person);
            Ok(())
        })
        .map(|_| ())
    })
    .await
}

// ── public sharing, phase 25 ──────────────────────────────────────────────
//
// ⚠️ **EVERY ONE OF THESE STARTS THE SHARE ENDPOINT, WHICH IS WHY THERE IS NO
// STATUS POLL AMONG THEM.** `PeerState::share_node` binds a second UDP port,
// loads a second key and opens a blob store on first use. A surface that
// polled a `share_status` on every render would start all of that for a reader
// who has never published anything — the exact cost the lazy start exists to
// avoid. What a surface may read cheaply is `peer_share_offered`, which reads
// the policy FILE and starts nothing.

/// What this machine offers publicly, read from disk without starting anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedBook {
    /// The book's `contentHash`.
    pub hash: String,
    /// Whether the bytes are offered.
    pub bytes: bool,
    /// Whether public annotations are offered. Independent of `bytes` — see
    /// `share::policy`.
    pub notes: bool,
    /// How many public annotations this machine holds for the book.
    ///
    /// ⚠️ **A COUNT THE READER CAN SEE BEFORE TURNING THE SWITCH OFF.**
    /// Withdrawing `notes` deletes them (`ShareNode::withdraw`), and a
    /// confirmation that cannot say how many is a confirmation nobody can
    /// give informed consent to.
    /// How many public annotations this device holds for the book.
    ///
    /// ⚠️ **`None` IS "COULD NOT BE COUNTED", NOT ZERO.** The surface uses this
    /// to tell a reader what stopping publication will DELETE, and an
    /// unreadable file used to report zero — telling them nothing would be lost
    /// over the one file we could not read. A book with no annotations is
    /// `Some(0)`; a file that would not read is absent.
    pub note_count: Option<u64>,
}

/// This device's SHARE endpoint id — where to ask it for a book's notes.
///
/// ⚠️ **THIS EXISTS BECAUSE THE LAYER HAD EXACTLY TWO STATES: ANNOUNCE TO THE
/// WHOLE INTERNET, OR FIND NOBODY.** `ShareNode::discovered` returns an empty
/// list the moment the DHT is off, and the DHT is the only thing that turns a
/// content hash into a provider — mDNS publishes an endpoint id and its
/// addresses and has no field that could carry a hash (`endpoint.rs`), and
/// share discovery is global by decision (WI-25.7). So two people on one LAN,
/// or two machines a reader owns, could not reach each other at all without
/// putting a book's hash and a home address into a permanent public index.
///
/// `peer_share_fetch_notes` has ALWAYS taken an explicit `providers` list. What
/// was missing was any way for a device to say where it can be asked. This is
/// that, and it is the whole of it: an id a reader can hand to somebody they
/// already trust, out of band, the way they would a phone number.
///
/// ⚠️ **READS THE KEY, NEVER THE NODE — `peer_share_offered`'s rule.** The id
/// is the public half of `peer/share.key`, so answering costs a file read and
/// binds no UDP port. Asking "where can I be reached" must not be the thing
/// that puts this machine on a network.
///
/// ⚠️ **AND IT DISCLOSES NOTHING THE LAN DOES NOT ALREADY SEE.** The same id is
/// mDNS-advertised to every machine on the network (WI-25.8). What it does not
/// carry, and must never be extended to carry, is which books this device
/// holds: the share protocol answers for an unoffered book exactly as it does
/// for one this machine has never held, so that a stranger cannot enumerate a
/// library by asking.
#[tauri::command]
pub async fn peer_share_id<R: Runtime>(app: AppHandle<R>) -> Result<String> {
    let root = data_root(&app)?;
    off_thread(move || {
        let secret =
            crate::identity::load_or_create_named(&root, crate::identity::EndpointKey::Share)?;
        Ok(secret.public().to_string())
    })
    .await
}

/// Everything this machine offers publicly.
///
/// ⚠️ **READS THE FILE, NEVER THE NODE.** A surface that has to start a UDP
/// endpoint to draw a list of switches is a surface that turns "look at my
/// settings" into "join a public network".
#[tauri::command]
pub async fn peer_share_offered<R: Runtime>(app: AppHandle<R>) -> Result<Vec<SharedBook>> {
    let root = data_root(&app)?;
    off_thread(move || {
        let policy = SharePolicy::load(&root)?;
        let mut rows: std::collections::BTreeMap<String, SharedBook> = Default::default();
        for service in ShareService::ALL {
            for hash in policy.offered(service) {
                /* ⚠️ **COUNTED ONCE PER BOOK, NOT ONCE PER SERVICE.** A book
                 * offering both bytes and notes had its whole annotation file
                 * read and counted twice, and the second result was thrown away
                 * because the map entry already existed. */
                let row = rows.entry(hash.to_string()).or_insert_with(|| SharedBook {
                    hash: hash.to_string(),
                    bytes: false,
                    notes: false,
                    /* ⚠️ **UNREADABLE IS NOT ZERO.** `unwrap_or(0)` turned a
                     * damaged or unreadable annotation file into "no
                     * annotations" — and this count is what the surface uses to
                     * tell the reader what stopping publication will DELETE.
                     * Saying nothing will be lost, over a file we could not
                     * read, is the one wrong answer. A missing file is
                     * genuinely zero and `count` already reports that; anything
                     * else is left absent so the surface can say it does not
                     * know. */
                    note_count: match crate::share::notes::count(&root, &hash) {
                        Ok(held) => Some(held),
                        Err(err) => {
                            log::warn!(
                                "peer: the public annotations for {hash} could not be counted: {err}"
                            );
                            None
                        }
                    },
                });
                match service {
                    ShareService::Bytes => row.bytes = true,
                    ShareService::Notes => row.notes = true,
                }
            }
        }
        Ok(rows.into_values().collect())
    })
    .await
}

/// Offer a book's BYTES to anyone who has its hash.
///
/// ⚠️ **THIS IS PUBLICATION AND IT CANNOT BE UNDONE.** The book is announced
/// into a global index, and anybody who reads that index has read it.
/// `peer_share_withdraw` stops this machine serving; it does not un-tell.
#[tauri::command]
pub async fn peer_share_offer_bytes<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    folder: String,
    name: String,
    hash: String,
) -> Result<()> {
    /* ⚠️ **PARSED BEFORE THE ENDPOINT STARTS, NOT AFTER.** `share_node` binds a
     * UDP port, loads a key and opens the blob store — `share/mod.rs`'s header
     * is explicit that none of that happens "until a reader turns a book on".
     * Validating afterwards meant a malformed hash from any caller did all of
     * it and then failed, so an invalid request had persistent and network side
     * effects. Cheapest refusal first, which is `checkPage`'s rule and the same
     * one `answer` follows two files over. */
    let hash = ContentHash::parse(&hash)?;
    let share = state.share_node(&app).await?;
    share.offer_bytes(&folder, &name, &hash).await
}

/// Offer public annotations for a book WITHOUT offering the book.
#[tauri::command]
pub async fn peer_share_offer_notes<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    hash: String,
) -> Result<()> {
    /* ⚠️ **PARSED BEFORE THE ENDPOINT STARTS, NOT AFTER.** `share_node` binds a
     * UDP port, loads a key and opens the blob store — `share/mod.rs`'s header
     * is explicit that none of that happens "until a reader turns a book on".
     * Validating afterwards meant a malformed hash from any caller did all of
     * it and then failed, so an invalid request had persistent and network side
     * effects. Cheapest refusal first, which is `checkPage`'s rule and the same
     * one `answer` follows two files over. */
    let hash = ContentHash::parse(&hash)?;
    let share = state.share_node(&app).await?;
    share.offer_notes(&hash).await
}

/// Stop offering one book over one service.
#[tauri::command]
pub async fn peer_share_withdraw<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    hash: String,
    service: ShareService,
) -> Result<()> {
    /* ⚠️ **PARSED BEFORE THE ENDPOINT STARTS, NOT AFTER.** `share_node` binds a
     * UDP port, loads a key and opens the blob store — `share/mod.rs`'s header
     * is explicit that none of that happens "until a reader turns a book on".
     * Validating afterwards meant a malformed hash from any caller did all of
     * it and then failed, so an invalid request had persistent and network side
     * effects. Cheapest refusal first, which is `checkPage`'s rule and the same
     * one `answer` follows two files over. */
    let hash = ContentHash::parse(&hash)?;
    let share = state.share_node(&app).await?;
    share.withdraw(&hash, service).await
}

/// Publish one public annotation record for a book.
///
/// ⚠️ **THE RECORD IS OPAQUE HERE.** Its envelope, its signature and its
/// ordering are phase 26's, in TypeScript; this plugin stores a line and
/// serves it, and refuses only what would break the file (a newline, an empty
/// or oversized record, a book already at its cap).
#[tauri::command]
pub async fn peer_share_publish_note<R: Runtime>(
    app: AppHandle<R>,
    hash: String,
    record: String,
) -> Result<u64> {
    let root = data_root(&app)?;
    off_thread(move || {
        let hash = ContentHash::parse(&hash)?;
        crate::share::notes::append(&root, &hash, record.as_bytes())
    })
    .await
}

/// Fetch a book by its hash and write it into the library.
///
/// ⚠️ **`folder` AND `name` ARE THE CALLER'S ANSWER TO "IS THIS THE BOOK I
/// ALREADY HAVE?"** `mayAdoptIdentity` in `publicShare.ts` decides that, and
/// the decision IS the folder: a fetched file whose digest disagrees with the
/// held book's goes into a folder of its own rather than over it. Passing the
/// held book's folder for bytes that are not the held book is the defect
/// WI-25.4 exists to prevent, and this command cannot detect it — it has no
/// library to consult.
///
/// `providers` may be empty, in which case discovery is asked.
#[tauri::command]
pub async fn peer_share_fetch<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    hash: String,
    folder: String,
    name: String,
    providers: Option<Vec<String>>,
) -> Result<u64> {
    /* ⚠️ **EVERY ARGUMENT IS VALIDATED BEFORE THE ENDPOINT STARTS.**
     * `share_node` binds a UDP port and opens the blob store, and `share/mod.rs`
     * says none of that happens until a reader turns a book on — so a malformed
     * hash, or a provider id that is not one, used to do all of it and then
     * fail. The providers are parsed here too, for the same reason: a caller's
     * typo should not be a network side effect. */
    let hash = ContentHash::parse(&hash)?;
    /* Bare ids, with no address hints: a provider named by a caller — a
     * friend's answer, a ticket — is resolved by iroh's own address lookup.
     * The DHT path inside `fetch_book` attaches the hints it announced, which
     * is where an address is worth having. */
    let mut ids = Vec::new();
    for one in providers.unwrap_or_default() {
        ids.push(iroh::EndpointAddr::from(crate::node::parse_peer_id(&one)?));
    }
    let share = state.share_node(&app).await?;
    share.fetch_book(&hash, &ids, &folder, &name).await
}

/// Ask a provider for a book's public annotations — phase 26's receiving half.
///
/// ⚠️ **THE RECORDS COME BACK UNVERIFIED, AND THAT IS DELIBERATE.** This
/// plugin does not know what a public envelope is. Every check that matters —
/// the signature, the expiry, the reader's block list, the storage caps — is
/// the kernel's `readPublicEnvelope`, and a second verifier here would be a
/// second thing to keep in step with the first. What this returns is bytes a
/// stranger sent, and the caller must treat them as such.
///
/// ⚠️ **AND THEY ARE STRINGS, SO A NON-UTF-8 RECORD IS REFUSED HERE.** A
/// public annotation is a JSON line by construction; anything else could not
/// have been signed by a Paper. Refusing at the boundary keeps the caller from
/// having to decide what a lossy decode means.
///
/// `since` and `generation` are the cursor the previous answer returned. Both
/// are needed: a count alone silently skips a whole history after the
/// publisher withdraws everything and starts again.
#[tauri::command]
pub async fn peer_share_fetch_notes<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    hash: String,
    providers: Option<Vec<String>>,
    since: Option<u64>,
    generation: Option<u64>,
) -> Result<FetchedNotes> {
    /* Every argument validated before `share_node` binds a port — the same
    ordering `peer_share_fetch` states at length. */
    let hash = ContentHash::parse(&hash)?;
    let mut ids = Vec::new();
    for one in providers.unwrap_or_default() {
        ids.push(iroh::EndpointAddr::from(crate::node::parse_peer_id(&one)?));
    }
    let share = state.share_node(&app).await?;
    let answer = share
        .fetch_notes(&hash, &ids, since.unwrap_or(0), generation)
        .await?;
    let mut records = Vec::with_capacity(answer.records.len());
    for one in answer.records {
        records.push(String::from_utf8(one).map_err(|_| {
            Error::ShareRefused("that provider sent something that is not text".into())
        })?);
    }
    Ok(FetchedNotes {
        records,
        next: answer.next,
        generation: answer.generation,
        more: answer.more,
    })
}

/// One round of asking, as the app sees it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedNotes {
    pub records: Vec<String>,
    pub next: u64,
    pub generation: u64,
    pub more: bool,
}

/// Who else claims to serve this book, over this service.
#[tauri::command]
pub async fn peer_share_resolve<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PeerState>,
    hash: String,
    service: ShareService,
) -> Result<Vec<String>> {
    /* ⚠️ **PARSED BEFORE THE ENDPOINT STARTS, NOT AFTER.** `share_node` binds a
     * UDP port, loads a key and opens the blob store — `share/mod.rs`'s header
     * is explicit that none of that happens "until a reader turns a book on".
     * Validating afterwards meant a malformed hash from any caller did all of
     * it and then failed, so an invalid request had persistent and network side
     * effects. Cheapest refusal first, which is `checkPage`'s rule and the same
     * one `answer` follows two files over. */
    let hash = ContentHash::parse(&hash)?;
    let share = state.share_node(&app).await?;
    let found = share.resolve(&hash, service).await?;
    Ok(found.providers.iter().map(|id| id.to_string()).collect())
}

// ── the voice, phase 26 ───────────────────────────────────────────────────
//
// ⚠️ **A SECOND SIGNING KEY, AND THE SECOND CONFINED SIGNING COMMAND.**
// `peer_page_sign` signs `paper.circle.<v>.page\n…` with the ENDPOINT key;
// `peer_voice_sign` signs `paper.public.<v>.envelope\n…` with the VOICE key.
// The two domains cannot overlap, so neither key can be made to sign the
// other's bytes — which is what stops a public annotation being replayed as a
// circle page and the reverse.
//
// None of these starts the share endpoint: a voice is a key and a counter on
// disk, and a reader who publishes an annotation locally has not yet joined
// anything.

/// This device's voice, its sequence, and the keys it still holds.
#[tauri::command]
pub async fn peer_voice_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<crate::share::voice::VoiceStatus> {
    let root = data_root(&app)?;
    off_thread(move || crate::share::voice::status(&root)).await
}

/// The next sequence to publish at.
///
/// ⚠️ **PERSISTED BEFORE IT IS ANSWERED.** A crash between the two costs a
/// skipped sequence, which nothing minds; the other order costs a REUSED one,
/// which the public fold treats as equivocation and drops — taking the voice's
/// own annotations with it.
#[tauri::command]
pub async fn peer_voice_next_seq<R: Runtime>(app: AppHandle<R>) -> Result<u64> {
    let root = data_root(&app)?;
    off_thread(move || crate::share::voice::next_seq(&root)).await
}

/// Sign a public envelope. `voice` names a retired key, or the current one.
#[tauri::command]
pub async fn peer_voice_sign<R: Runtime>(
    app: AppHandle<R>,
    message: String,
    voice: Option<String>,
) -> Result<String> {
    let root = data_root(&app)?;
    off_thread(move || crate::share::voice::sign(&root, &message, voice.as_deref())).await
}

/// Rotate the voice, keeping the old key until `until`.
///
/// ⚠️ **`until` IS WHEN THE OLD KEY MAY GO, AND THE CALLER OWES IT A REAL
/// NUMBER.** Everything the old voice published carries a signed expiry; the
/// retention has to outlast the latest of them, or a publication becomes
/// unwithdrawable while it is still valid.
#[tauri::command]
pub async fn peer_voice_rotate<R: Runtime>(
    app: AppHandle<R>,
    until: i64,
) -> Result<crate::share::voice::VoiceStatus> {
    let root = data_root(&app)?;
    off_thread(move || crate::share::voice::rotate(&root, until)).await
}

/// Forget retired keys whose retention has run out.
#[tauri::command]
pub async fn peer_voice_sweep<R: Runtime>(app: AppHandle<R>, now: i64) -> Result<usize> {
    let root = data_root(&app)?;
    off_thread(move || crate::share::voice::sweep(&root, now)).await
}
