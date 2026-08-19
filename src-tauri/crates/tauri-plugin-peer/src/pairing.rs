//! Pairing over `one.paper.reader/pair/1` (plan III.2.2).
//!
//! The shelf shows a QR: `paper://pair?v=1&id=<endpoint id>&a=<direct
//! addrs>&r=<relay>&s=<128-bit secret>&x=<expiry>`. The satchel dials the id
//! with the hints and sends a hello whose MAC is keyed on the secret over
//! `shelfId ‖ satchelId` — where the satchel id the shelf uses is the one the
//! TLS handshake proved (`conn.remote_id()`), never a field. The shelf
//! verifies in constant time, consumes the pending secret in one atomic step
//! (a second connection with the same secret finds nothing), shows the
//! human a 6-digit SAS derived from `(secret, shelfId, satchelId)` — the
//! satchel computes and shows the same — and waits for `peer_pair_confirm`.
//! On accept both sides persist the peer with the grants their app chose, as a
//! two-sided commit: the shelf's ack carries a second MAC, the satchel persists
//! and returns a third (the commit), and only then does the shelf keep the
//! peer — a satchel that never commits leaves no one-way trust.
//!
//! What a wrong version looks like: the ALPN carries it, so `pair/0` never
//! completes a handshake, and a `v` other than `1` in the URI is refused
//! before a socket is touched.

use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use data_encoding::BASE32_NOPAD;
use iroh::endpoint::{Connection, SendStream, VarInt};
use iroh::{EndpointAddr, EndpointId, RelayUrl};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use url::Url;

use crate::error::{Error, Result};
use crate::events::{PairingPending, PairingResult, PeerEvent};
use crate::frame::{read_json, write_json};
use crate::node::Node;
use crate::peers::{now_ms, PeerRecord};
use crate::role::Role;

pub const PAIR_ALPN: &[u8] = b"one.paper.reader/pair/1";
pub const PAIR_VERSION: &str = "1";
/// How long a QR is good for.
pub const PAIR_TTL: Duration = Duration::from_secs(300);
/// How long the shelf waits for the human after showing the SAS.
pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
const HELLO_TIMEOUT: Duration = Duration::from_secs(15);
const DIAL_TIMEOUT: Duration = Duration::from_secs(30);
/// The satchel waits the shelf's confirm window plus this much for the ack.
const ACK_GRACE: Duration = Duration::from_secs(30);
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
/// After sending the ack the shelf waits this long for the satchel's commit —
/// the second half of the two-sided commit (finding M8). A silent satchel is
/// dropped and the shelf rolls back; a reset arrives sooner.
const COMMIT_TIMEOUT: Duration = Duration::from_secs(30);

pub type Secret = [u8; 16];

// ── state ─────────────────────────────────────────────────────────────────

/// The shelf's pairing state: at most one pending secret, at most one
/// satchel awaiting the human. One mutex, taken synchronously, never held
/// across an await — that is what makes the claim single-shot.
#[derive(Default)]
pub struct PairingState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    pending: Option<Pending>,
    confirm: Option<Confirm>,
}

struct Pending {
    secret: Secret,
    /// Monotonic deadline (finding L10): a wall-clock change cannot stretch or
    /// shrink the window. The wall-clock expiry is encoded in the QR separately,
    /// for display only.
    expires_at: Instant,
    /// The name this shelf gives itself in the ack.
    name: String,
}

/// The confirmation the human is about to answer, bound to the exact attempt
/// (finding M9): `peer_pair_confirm` must present the matching `attempt_id`, so
/// a stale confirm — or one meant for a different, pre-played attempt — cannot
/// confirm this one.
struct Confirm {
    attempt_id: String,
    sender: oneshot::Sender<Decision>,
}

struct Decision {
    accept: bool,
    grants: Vec<String>,
    reply: oneshot::Sender<Result<Option<PeerRecord>>>,
}

enum Claim {
    NoPending,
    Expired,
    BadMac,
    Claimed {
        secret: Secret,
        shelf_name: String,
        attempt_id: String,
        decision: oneshot::Receiver<Decision>,
    },
}

/// A fresh, unguessable id for one pairing attempt.
fn new_attempt_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

impl PairingState {
    fn replace(&self, pending: Pending) {
        let mut inner = self.inner.lock().expect("pairing lock");
        inner.pending = Some(pending);
        // A satchel still waiting on the old offer is refused when its
        // sender drops here.
        inner.confirm = None;
    }

    fn cancel(&self) {
        let mut inner = self.inner.lock().expect("pairing lock");
        inner.pending = None;
        inner.confirm = None;
    }

    /// Take the confirmation sender, but only if the caller named the current
    /// attempt. REQUIRED: an unbound confirmation approved whichever attempt
    /// happened to be pending — exactly the stale/pre-played approval the
    /// binding (M9) exists to refuse — so the compat path that allowed one is
    /// gone. A mismatch leaves the pending attempt in place: a stale confirm
    /// cannot consume the attempt that replaced the one it meant.
    fn take_confirm(&self, attempt_id: &str) -> Result<oneshot::Sender<Decision>> {
        let mut inner = self.inner.lock().expect("pairing lock");
        match inner.confirm.as_ref() {
            None => Err(Error::NoPendingPairing),
            Some(confirm) => {
                if confirm.attempt_id != attempt_id {
                    return Err(Error::NoPendingPairing);
                }
                Ok(inner.confirm.take().expect("checked present").sender)
            }
        }
    }

    /// The single-shot step. Verify under the lock; consume only on success,
    /// so a stranger's bad MAC does not burn a QR the real satchel is about
    /// to use, while two correct MACs can never both win.
    fn claim(&self, shelf: &EndpointId, satchel: &EndpointId, mac: &blake3::Hash) -> Claim {
        let mut inner = self.inner.lock().expect("pairing lock");
        let Some(pending) = inner.pending.as_ref() else {
            return Claim::NoPending;
        };
        if Instant::now() > pending.expires_at {
            inner.pending = None;
            return Claim::Expired;
        }
        // `blake3::Hash == blake3::Hash` is constant-time.
        if pair_mac(&pending.secret, shelf, satchel) != *mac {
            return Claim::BadMac;
        }
        let pending = inner.pending.take().expect("checked above");
        let attempt_id = new_attempt_id();
        let (tx, rx) = oneshot::channel();
        inner.confirm = Some(Confirm {
            attempt_id: attempt_id.clone(),
            sender: tx,
        });
        Claim::Claimed {
            secret: pending.secret,
            shelf_name: pending.name,
            attempt_id,
            decision: rx,
        }
    }
}

// ── crypto ────────────────────────────────────────────────────────────────

/// `keyed_hash(derive_key("paper pair v1", secret), shelfId ‖ satchelId)`.
pub(crate) fn pair_mac(secret: &Secret, shelf: &EndpointId, satchel: &EndpointId) -> blake3::Hash {
    let key = blake3::derive_key("paper pair v1", secret);
    let mut hasher = blake3::Hasher::new_keyed(&key);
    hasher.update(shelf.as_bytes());
    hasher.update(satchel.as_bytes());
    hasher.finalize()
}

/// `keyed_hash(derive_key("paper pair ack v1", secret), "ack" ‖ satchelId ‖ shelfId)`.
pub(crate) fn ack_mac(secret: &Secret, satchel: &EndpointId, shelf: &EndpointId) -> blake3::Hash {
    let key = blake3::derive_key("paper pair ack v1", secret);
    let mut hasher = blake3::Hasher::new_keyed(&key);
    hasher.update(b"ack");
    hasher.update(satchel.as_bytes());
    hasher.update(shelf.as_bytes());
    hasher.finalize()
}

/// `keyed_hash(derive_key("paper pair commit v1", secret), "commit" ‖ satchelId
/// ‖ shelfId)`. The satchel returns this once it has persisted the shelf, so
/// the shelf keeps the peer only after the satchel confirms its own trust —
/// the second side of the commit (finding M8). Authenticated, so it cannot be
/// forged by a relay or a stranger.
pub(crate) fn commit_mac(
    secret: &Secret,
    satchel: &EndpointId,
    shelf: &EndpointId,
) -> blake3::Hash {
    let key = blake3::derive_key("paper pair commit v1", secret);
    let mut hasher = blake3::Hasher::new_keyed(&key);
    hasher.update(b"commit");
    hasher.update(satchel.as_bytes());
    hasher.update(shelf.as_bytes());
    hasher.finalize()
}

/// Six decimal digits from `keyed_hash(derive_key("paper pair sas", secret),
/// shelfId ‖ satchelId)`: the first four bytes, big-endian, mod 1_000_000.
///
/// Six digits (~20 bits), not four (~13): this code is the human's last check
/// against a man-in-the-middle, and 1-in-a-million is the entropy a compared
/// pairing code is normally held to. Four bytes into the modulo keeps the bias
/// negligible.
pub(crate) fn sas(secret: &Secret, shelf: &EndpointId, satchel: &EndpointId) -> String {
    let key = blake3::derive_key("paper pair sas", secret);
    let mut hasher = blake3::Hasher::new_keyed(&key);
    hasher.update(shelf.as_bytes());
    hasher.update(satchel.as_bytes());
    let bytes = hasher.finalize();
    let b = bytes.as_bytes();
    let n = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000;
    format!("{n:06}")
}

fn parse_mac(hex: &str) -> Option<blake3::Hash> {
    blake3::Hash::from_hex(hex).ok()
}

// ── the URI ───────────────────────────────────────────────────────────────

/// What the QR carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairUri {
    pub id: EndpointId,
    pub addrs: Vec<SocketAddr>,
    pub relay: Option<RelayUrl>,
    pub secret: Secret,
    /// Unix seconds.
    pub expires_at: u64,
}

impl PairUri {
    pub fn to_uri(&self) -> String {
        let mut url = Url::parse("paper://pair").expect("static URL parses");
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("v", PAIR_VERSION);
            q.append_pair("id", &self.id.to_string());
            let addrs: Vec<String> = self.addrs.iter().map(|a| a.to_string()).collect();
            q.append_pair("a", &addrs.join(","));
            q.append_pair(
                "r",
                &self
                    .relay
                    .as_ref()
                    .map(|r| r.to_string())
                    .unwrap_or_default(),
            );
            q.append_pair("s", &BASE32_NOPAD.encode(&self.secret));
            q.append_pair("x", &self.expires_at.to_string());
        }
        url.to_string()
    }

    pub fn parse(text: &str) -> Result<Self> {
        let invalid = |what: &str| Error::PairUriInvalid(what.to_owned());
        let url = Url::parse(text.trim()).map_err(|e| invalid(&e.to_string()))?;
        if url.scheme() != "paper" || url.host_str() != Some("pair") {
            return Err(invalid("not a paper://pair URI"));
        }
        let mut v = None;
        let mut id = None;
        let mut a = None;
        let mut r = None;
        let mut s = None;
        let mut x = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "v" => v = Some(value.into_owned()),
                "id" => id = Some(value.into_owned()),
                "a" => a = Some(value.into_owned()),
                "r" => r = Some(value.into_owned()),
                "s" => s = Some(value.into_owned()),
                "x" => x = Some(value.into_owned()),
                _ => {}
            }
        }
        let v = v.ok_or_else(|| invalid("missing v"))?;
        if v != PAIR_VERSION {
            return Err(Error::UnsupportedPairVersion(v));
        }
        let id = id
            .ok_or_else(|| invalid("missing id"))?
            .parse::<EndpointId>()
            .map_err(|_| invalid("bad id"))?;
        let addrs = a
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<SocketAddr>().map_err(|_| invalid("bad address")))
            .collect::<Result<Vec<_>>>()?;
        let relay = match r.as_deref() {
            None | Some("") => None,
            Some(r) => Some(RelayUrl::from_str(r).map_err(|_| invalid("bad relay"))?),
        };
        let secret_bytes = BASE32_NOPAD
            .decode(s.ok_or_else(|| invalid("missing s"))?.as_bytes())
            .map_err(|_| invalid("bad secret"))?;
        let secret: Secret = secret_bytes
            .as_slice()
            .try_into()
            .map_err(|_| invalid("secret must be 16 bytes"))?;
        let expires_at = x
            .ok_or_else(|| invalid("missing x"))?
            .parse::<u64>()
            .map_err(|_| invalid("bad expiry"))?;
        Ok(PairUri {
            id,
            addrs,
            relay,
            secret,
            expires_at,
        })
    }

    fn endpoint_addr(&self) -> EndpointAddr {
        let mut addr = EndpointAddr::new(self.id);
        for a in &self.addrs {
            addr = addr.with_ip_addr(*a);
        }
        if let Some(relay) = &self.relay {
            addr = addr.with_relay_url(relay.clone());
        }
        addr
    }
}

fn render_qr(text: &str) -> Result<String> {
    let code = qrcode::QrCode::new(text.as_bytes())
        .map_err(|e| Error::PairUriInvalid(format!("QR: {e}")))?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .build())
}

// ── wire ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct PairHello {
    name: String,
    platform: String,
    role: Role,
    /// Hex.
    mac: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct PairAck {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<Role>,
    /// Hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mac_ack: Option<String>,
}

/// The satchel's commit: sent after it persists the shelf, so the shelf can
/// keep the peer only once both sides hold the trust (finding M8).
#[derive(Debug, Serialize, Deserialize)]
struct PairCommit {
    /// Hex of [`commit_mac`].
    mac_commit: String,
}

// ── results ───────────────────────────────────────────────────────────────

/// What `peer_pair_begin` returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairOffer {
    pub url: String,
    pub svg: String,
    /// Unix milliseconds.
    pub expires_at: u64,
}

/// What `peer_pair_from_uri` returns, immediately: the SAS to show while
/// the shelf's human decides.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStart {
    pub sas: String,
}

fn default_device_name() -> String {
    format!("Paper on {}", std::env::consts::OS)
}

// ── shelf side ────────────────────────────────────────────────────────────

/// Mint a secret, publish the offer. A second call replaces the first.
pub fn begin(node: &Node, name: Option<String>) -> Result<PairOffer> {
    if node.role() != Role::Shelf {
        return Err(Error::RoleMismatch {
            expected: Role::Shelf,
            got: node.role(),
        });
    }
    let secret: Secret = rand::random();
    // The wall-clock expiry is for the QR's display/encoding only; enforcement
    // is on a monotonic deadline (finding L10) so moving the clock cannot
    // stretch the window.
    let expires_secs = (SystemTime::now() + PAIR_TTL)
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let deadline = Instant::now() + PAIR_TTL;
    let addr = node.endpoint().addr();
    let uri = PairUri {
        id: node.id(),
        addrs: addr.ip_addrs().copied().collect(),
        relay: addr.relay_urls().next().cloned(),
        secret,
        expires_at: expires_secs,
    };
    let url = uri.to_uri();
    let svg = render_qr(&url)?;
    node.pairing.replace(Pending {
        secret,
        expires_at: deadline,
        name: name.unwrap_or_else(default_device_name),
    });
    Ok(PairOffer {
        url,
        svg,
        expires_at: expires_secs * 1000,
    })
}

/// Drop the offer and refuse any satchel waiting on it.
pub fn cancel(node: &Node) {
    node.pairing.cancel();
}

/// The human's answer, bound to the exact attempt (finding M9): `attempt_id`
/// MUST name the pending attempt, so a stale confirm or one meant for a
/// different (e.g. pre-played) attempt is refused. There is no unbound form —
/// the compat path that accepted one restored the exact hole the binding
/// closed.
///
/// Returns once both sides have committed the pairing (`Some(record)`), or once
/// the refusal has gone out (`None`).
pub async fn confirm(
    node: &Node,
    accept: bool,
    grants: Vec<String>,
    attempt_id: String,
) -> Result<Option<PeerRecord>> {
    let sender = node.pairing.take_confirm(&attempt_id)?;
    let (reply_tx, reply_rx) = oneshot::channel();
    sender
        .send(Decision {
            accept,
            grants,
            reply: reply_tx,
        })
        .map_err(|_| Error::NoPendingPairing)?;
    reply_rx
        .await
        .map_err(|_| Error::PairingRefused("aborted".into()))?
}

/// One incoming `pair/1` connection on the shelf.
pub(crate) async fn serve(node: Arc<Node>, conn: Connection) {
    let remote = conn.remote_id();
    let outcome = serve_inner(&node, &conn).await;
    match outcome {
        Ok(Some(record)) => {
            node.emit(PeerEvent::PairingResult(PairingResult {
                ok: true,
                id: record.id,
                name: Some(record.name),
                platform: Some(record.platform),
                role: Some(record.role),
                reason: None,
            }));
            conn.close(VarInt::from_u32(0), b"done");
        }
        Ok(None) => conn.close(VarInt::from_u32(0), b"refused"),
        Err(err) => {
            node.emit(PeerEvent::PairingResult(PairingResult {
                ok: false,
                id: remote.to_string(),
                name: None,
                platform: None,
                role: None,
                reason: Some(reason_of(&err)),
            }));
            conn.close(VarInt::from_u32(1), b"refused");
        }
    }
}

fn reason_of(err: &Error) -> String {
    match err {
        Error::PairingRefused(reason) => reason.clone(),
        other => other.kind().to_owned(),
    }
}

/// `Ok(Some)` paired, `Ok(None)` the human said no (nothing emitted beyond
/// the ack), `Err` refused for a stated reason.
async fn serve_inner(node: &Arc<Node>, conn: &Connection) -> Result<Option<PeerRecord>> {
    let remote = conn.remote_id();
    let (mut send, mut recv) = timeout(HELLO_TIMEOUT, conn.accept_bi())
        .await
        .map_err(|_| Error::Timeout("pair hello"))??;
    let hello: PairHello = timeout(HELLO_TIMEOUT, read_json(&mut recv))
        .await
        .map_err(|_| Error::Timeout("pair hello"))??;

    if hello.role != Role::Satchel {
        return refuse(&mut send, "role-mismatch").await;
    }
    let Some(mac) = parse_mac(&hello.mac) else {
        return refuse(&mut send, "bad-mac").await;
    };

    let (secret, shelf_name, attempt_id, decision) =
        match node.pairing.claim(&node.id(), &remote, &mac) {
            Claim::NoPending => return refuse(&mut send, "no-pending").await,
            Claim::Expired => return refuse(&mut send, "expired").await,
            Claim::BadMac => return refuse(&mut send, "bad-mac").await,
            Claim::Claimed {
                secret,
                shelf_name,
                attempt_id,
                decision,
            } => (secret, shelf_name, attempt_id, decision),
        };

    node.emit(PeerEvent::PairingPending(PairingPending {
        attempt_id,
        id: remote.to_string(),
        name: hello.name.clone(),
        platform: hello.platform.clone(),
        sas: sas(&secret, &node.id(), &remote),
    }));

    let decision = match timeout(node.confirm_timeout, decision).await {
        Ok(Ok(decision)) => decision,
        Ok(Err(_)) => return refuse(&mut send, "cancelled").await,
        Err(_) => return refuse(&mut send, "timeout").await,
    };

    if !decision.accept {
        let outcome: Result<Option<PeerRecord>> = refuse(&mut send, "refused").await;
        let _ = decision.reply.send(Ok(None));
        // The refusal was the human's decision, not a failure: report it
        // as `Ok(None)` so no `pairing-result` error is emitted for it.
        return match outcome {
            Err(Error::PairingRefused(_)) => Ok(None),
            other => other,
        };
    }

    let now = now_ms();
    let record = PeerRecord {
        id: remote.to_string(),
        name: hello.name,
        platform: hello.platform,
        role: Role::Satchel,
        grants: decision.grants,
        paired_at: now,
        last_seen_at: now,
        last_addrs: remote_addrs(node, remote).await,
    };
    // Persist-then-commit already makes this durable before the peer is live in
    // memory (finding H3); the guard is dropped before the awaits below.
    let persisted = node.peers().insert(record.clone());
    if let Err(err) = persisted {
        let _ = decision.reply.send(Err(err));
        return refuse(&mut send, "persist-failed").await;
    }

    // The two-sided commit (finding M8): the shelf has persisted, but keeps the
    // peer only once the satchel confirms it persisted too. A satchel that
    // resets after the human accepts — or fails its own persist — never sends a
    // valid commit, so the shelf rolls back and no one-way trust survives.
    let ack = PairAck {
        ok: true,
        reason: None,
        name: Some(shelf_name),
        platform: Some(std::env::consts::OS.to_owned()),
        role: Some(Role::Shelf),
        mac_ack: Some(ack_mac(&secret, &remote, &node.id()).to_hex().to_string()),
    };
    match await_commit(node, &mut send, &mut recv, &secret, &remote, &ack).await {
        Ok(()) => {
            let _ = decision.reply.send(Ok(Some(record.clone())));
            Ok(Some(record))
        }
        Err(err) => {
            let _ = node.peers().remove(&record.id);
            let _ = decision
                .reply
                .send(Err(Error::PairingRefused("commit-failed".into())));
            Err(err)
        }
    }
}

/// Send the ack, then wait for the satchel's authenticated commit. Any failure
/// — a reset, a silent satchel past the deadline, or a forged commit MAC — is
/// returned so the caller rolls the shelf's trust back.
async fn await_commit(
    node: &Node,
    send: &mut SendStream,
    recv: &mut iroh::endpoint::RecvStream,
    secret: &Secret,
    satchel: &EndpointId,
    ack: &PairAck,
) -> Result<()> {
    write_json(send, ack).await?;
    flush(send).await;
    let commit: PairCommit = match timeout(COMMIT_TIMEOUT, read_json(recv)).await {
        Ok(Ok(commit)) => commit,
        Ok(Err(_)) => return Err(Error::PairingRefused("commit-aborted".into())),
        Err(_) => return Err(Error::PairingRefused("commit-timeout".into())),
    };
    let expected = commit_mac(secret, satchel, &node.id());
    if parse_mac(&commit.mac_commit) != Some(expected) {
        return Err(Error::PairingRefused("bad-commit-mac".into()));
    }
    Ok(())
}

/// Send `PairAck { ok: false, reason }`, wait for it to be acknowledged, and
/// return the matching error.
async fn refuse<T>(send: &mut SendStream, reason: &str) -> Result<T> {
    let ack = PairAck {
        ok: false,
        reason: Some(reason.to_owned()),
        name: None,
        platform: None,
        role: None,
        mac_ack: None,
    };
    let _ = write_json(send, &ack).await;
    flush(send).await;
    Err(Error::PairingRefused(reason.to_owned()))
}

/// Finish the stream and wait (bounded) for the peer to acknowledge the
/// bytes, so a `conn.close()` right after does not discard them.
async fn flush(send: &mut SendStream) {
    let _ = send.finish();
    let _ = timeout(FLUSH_TIMEOUT, send.stopped()).await;
}

/// The remote's addresses as `peers.json` stores them.
pub(crate) async fn remote_addrs(node: &Node, remote: EndpointId) -> Vec<String> {
    match node.endpoint().remote_info(remote).await {
        Some(info) => info
            .into_addrs()
            .filter_map(|a| match a.into_addr() {
                iroh::TransportAddr::Ip(addr) => Some(addr.to_string()),
                iroh::TransportAddr::Relay(url) => Some(url.to_string()),
                _ => None,
            })
            .collect(),
        None => Vec::new(),
    }
}

// ── satchel side ──────────────────────────────────────────────────────────

/// Parse the URI, dial the shelf, send the hello. Returns the SAS to show
/// at once, and the task that completes when the shelf answers: on success
/// the shelf is persisted with `grants` and `Ok(record)`; either way a
/// `peer://pairing-result` is emitted.
pub async fn from_uri(
    node: &Arc<Node>,
    uri: &str,
    name: Option<String>,
    grants: Vec<String>,
) -> Result<(PairStart, JoinHandle<Result<PeerRecord>>)> {
    let uri = PairUri::parse(uri)?;
    if node.role() != Role::Satchel {
        return Err(Error::RoleMismatch {
            expected: Role::Satchel,
            got: node.role(),
        });
    }
    let shelf = uri.id;
    let conn = timeout(
        DIAL_TIMEOUT,
        node.endpoint().connect(uri.endpoint_addr(), PAIR_ALPN),
    )
    .await
    .map_err(|_| Error::Timeout("pair dial"))??;
    let (mut send, mut recv) = conn.open_bi().await?;
    let hello = PairHello {
        name: name.unwrap_or_else(default_device_name),
        platform: std::env::consts::OS.to_owned(),
        role: Role::Satchel,
        mac: pair_mac(&uri.secret, &shelf, &node.id())
            .to_hex()
            .to_string(),
    };
    write_json(&mut send, &hello).await?;
    // The send stream stays open: after the ack the satchel sends its commit on
    // it, the second half of the two-sided commit (finding M8).
    let sas = sas(&uri.secret, &shelf, &node.id());

    let node = node.clone();
    let secret = uri.secret;
    let task = tokio::spawn(async move {
        let result = finish(&node, &conn, &mut send, &mut recv, shelf, &secret, grants).await;
        node.emit(PeerEvent::PairingResult(match &result {
            Ok(record) => PairingResult {
                ok: true,
                id: record.id.clone(),
                name: Some(record.name.clone()),
                platform: Some(record.platform.clone()),
                role: Some(record.role),
                reason: None,
            },
            Err(err) => PairingResult {
                ok: false,
                id: shelf.to_string(),
                name: None,
                platform: None,
                role: None,
                reason: Some(reason_of(err)),
            },
        }));
        conn.close(VarInt::from_u32(0), b"done");
        result
    });
    Ok((PairStart { sas }, task))
}

#[allow(clippy::too_many_arguments)]
async fn finish(
    node: &Node,
    conn: &Connection,
    send: &mut SendStream,
    recv: &mut iroh::endpoint::RecvStream,
    shelf: EndpointId,
    secret: &Secret,
    grants: Vec<String>,
) -> Result<PeerRecord> {
    let ack: PairAck = match timeout(node.confirm_timeout + ACK_GRACE, read_json(recv)).await {
        Ok(Ok(ack)) => ack,
        Ok(Err(err)) => {
            return Err(closed_reason(conn)
                .map(Error::PairingRefused)
                .unwrap_or(err))
        }
        Err(_) => return Err(Error::Timeout("pair ack")),
    };
    if !ack.ok {
        return Err(Error::PairingRefused(
            ack.reason.unwrap_or_else(|| "refused".into()),
        ));
    }
    let expected = ack_mac(secret, &node.id(), &shelf);
    let got = ack.mac_ack.as_deref().and_then(parse_mac);
    if got.as_ref() != Some(&expected) {
        return Err(Error::PairingRefused("bad-ack-mac".into()));
    }
    let role = ack.role.unwrap_or(Role::Satchel);
    if role != Role::Shelf {
        return Err(Error::RoleMismatch {
            expected: Role::Shelf,
            got: role,
        });
    }
    let now = now_ms();
    let record = PeerRecord {
        id: shelf.to_string(),
        name: ack.name.unwrap_or_else(|| "shelf".into()),
        platform: ack.platform.unwrap_or_default(),
        role: Role::Shelf,
        grants,
        paired_at: now,
        last_seen_at: now,
        last_addrs: remote_addrs(node, shelf).await,
    };
    node.peers().insert(record.clone())?;
    // Confirm to the shelf that we persisted, so it keeps the peer (finding M8).
    // Best-effort: if this commit is lost the shelf rolls back to no trust —
    // leaving at worst a benign satchel-only record, never shelf-only trust.
    let commit = PairCommit {
        mac_commit: commit_mac(secret, &node.id(), &shelf).to_hex().to_string(),
    };
    let _ = write_json(send, &commit).await;
    flush(send).await;
    Ok(record)
}

/// If the connection is already closed by the remote with a reason string,
/// that string.
pub(crate) fn closed_reason(conn: &Connection) -> Option<String> {
    match conn.close_reason()? {
        iroh::endpoint::ConnectionError::ApplicationClosed(close) => {
            Some(String::from_utf8_lossy(&close.reason).into_owned())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::testkit::TestNode;
    use crate::role::Role;
    use iroh::endpoint::presets;
    use iroh::{Endpoint, RelayMode, SecretKey};

    fn secret() -> Secret {
        [7u8; 16]
    }

    fn ids() -> (EndpointId, EndpointId) {
        (
            SecretKey::from_bytes(&[1u8; 32]).public(),
            SecretKey::from_bytes(&[2u8; 32]).public(),
        )
    }

    #[test]
    fn mac_and_sas_depend_on_every_input_and_are_ordered() {
        let (shelf, satchel) = ids();
        let s = secret();
        let mac = pair_mac(&s, &shelf, &satchel);
        assert_ne!(mac, pair_mac(&s, &satchel, &shelf), "order matters");
        assert_ne!(mac, pair_mac(&[8u8; 16], &shelf, &satchel));
        assert_ne!(mac, ack_mac(&s, &satchel, &shelf), "different derivation");
        let code = sas(&s, &shelf, &satchel);
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(code, sas(&s, &shelf, &satchel));
        assert_ne!(code, sas(&[8u8; 16], &shelf, &satchel));
    }

    #[test]
    fn sas_is_zero_padded_first_four_bytes_mod_1_000_000() {
        let (shelf, satchel) = ids();
        let s = secret();
        let key = blake3::derive_key("paper pair sas", &s);
        let mut h = blake3::Hasher::new_keyed(&key);
        h.update(shelf.as_bytes());
        h.update(satchel.as_bytes());
        let b = h.finalize();
        let bytes = b.as_bytes();
        let n = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 1_000_000;
        assert_eq!(sas(&s, &shelf, &satchel), format!("{n:06}"));
    }

    #[test]
    fn uri_round_trips_and_refuses_other_versions() {
        let (shelf, _) = ids();
        let uri = PairUri {
            id: shelf,
            addrs: vec![
                "192.168.1.2:4433".parse().unwrap(),
                "[::1]:9".parse().unwrap(),
            ],
            relay: Some("https://relay.example/".parse().unwrap()),
            secret: secret(),
            expires_at: 1_700_000_000,
        };
        let text = uri.to_uri();
        assert!(text.starts_with("paper://pair?v=1&id="), "{text}");
        assert!(
            !text.contains("0707070707"),
            "the secret is base32, not hex"
        );
        assert_eq!(PairUri::parse(&text).unwrap(), uri);

        let no_relay = PairUri {
            relay: None,
            addrs: vec![],
            ..uri.clone()
        };
        assert_eq!(PairUri::parse(&no_relay.to_uri()).unwrap(), no_relay);

        let v2 = text.replacen("v=1", "v=2", 1);
        assert_eq!(
            PairUri::parse(&v2).unwrap_err().kind(),
            "unsupportedPairVersion"
        );
        for bad in [
            "https://pair?v=1",
            "paper://pair?v=1&id=zz&a=&r=&s=AAAAAAAAAAAAAAAAAAAAAAAAAA&x=1",
            "paper://pair?v=1",
            "not a uri",
        ] {
            assert_eq!(
                PairUri::parse(bad).unwrap_err().kind(),
                "pairUriInvalid",
                "{bad}"
            );
        }
        let short_secret = text.replace(&BASE32_NOPAD.encode(&secret()), "AAAA");
        assert_eq!(
            PairUri::parse(&short_secret).unwrap_err().kind(),
            "pairUriInvalid"
        );
    }

    #[test]
    fn qr_renders_the_uri_as_svg() {
        let svg = render_qr("paper://pair?v=1&id=abc").unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("</svg>"));
    }

    // ── two nodes ─────────────────────────────────────────────────────

    async fn pair(
        shelf: &mut TestNode,
        satchel: &mut TestNode,
        accept: bool,
    ) -> (
        Result<Option<PeerRecord>>,
        Result<PeerRecord>,
        String,
        String,
    ) {
        let offer = begin(&shelf.node, Some("Desk".into())).unwrap();
        let (start, task) = from_uri(
            &satchel.node,
            &offer.url,
            Some("Phone".into()),
            vec!["sync:*".into()],
        )
        .await
        .unwrap();
        let pending = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await;
        let PeerEvent::PairingPending(pending) = pending else {
            unreachable!()
        };
        assert_eq!(pending.id, satchel.id());
        assert_eq!(pending.name, "Phone");
        let confirmed = confirm(
            &shelf.node,
            accept,
            vec!["sync:*".into(), "blob:*".into()],
            pending.attempt_id.clone(),
        )
        .await;
        let satchel_result = task.await.unwrap();
        (confirmed, satchel_result, pending.sas, start.sas)
    }

    #[tokio::test]
    async fn happy_path_persists_both_sides_with_roles_and_grants() {
        let mut shelf = TestNode::start("pair-shelf", Role::Shelf).await;
        let mut satchel = TestNode::start("pair-satchel", Role::Satchel).await;
        let (confirmed, satchel_result, shelf_sas, satchel_sas) =
            pair(&mut shelf, &mut satchel, true).await;
        assert_eq!(shelf_sas, satchel_sas, "SAS equal on both screens");

        let record = confirmed.unwrap().expect("accepted");
        assert_eq!(record.id, satchel.id());
        assert_eq!(record.role, Role::Satchel);
        assert_eq!(record.grants, vec!["sync:*", "blob:*"]);
        assert_eq!(record.name, "Phone");
        let on_shelf = shelf.node.list_peers();
        assert_eq!(on_shelf, vec![record]);
        assert!(
            !on_shelf[0].last_addrs.is_empty(),
            "addresses learned from the dial"
        );

        let shelf_record = satchel_result.unwrap();
        assert_eq!(shelf_record.id, shelf.id());
        assert_eq!(shelf_record.role, Role::Shelf);
        assert_eq!(shelf_record.name, "Desk");
        assert_eq!(shelf_record.grants, vec!["sync:*"]);
        assert_eq!(satchel.node.list_peers(), vec![shelf_record]);

        // Both sides announced the result.
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingResult(_)))
            .await;
        assert!(matches!(ev, PeerEvent::PairingResult(r) if r.ok && r.id == satchel.id()));
        let ev = satchel
            .next_event_where(|e| matches!(e, PeerEvent::PairingResult(_)))
            .await;
        assert!(matches!(ev, PeerEvent::PairingResult(r) if r.ok && r.id == shelf.id()));

        // The secret is spent: the same URI again is refused.
        assert_eq!(
            confirm(&shelf.node, true, vec![], "no-such-attempt".into())
                .await
                .unwrap_err()
                .kind(),
            "noPendingPairing"
        );
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn the_human_refusing_persists_nothing() {
        let mut shelf = TestNode::start("pair-refuse-shelf", Role::Shelf).await;
        let mut satchel = TestNode::start("pair-refuse-satchel", Role::Satchel).await;
        let (confirmed, satchel_result, _, _) = pair(&mut shelf, &mut satchel, false).await;
        assert!(confirmed.unwrap().is_none());
        let err = satchel_result.unwrap_err();
        assert_eq!(err.kind(), "pairingRefused");
        assert!(err.to_string().contains("refused"));
        assert!(shelf.node.list_peers().is_empty());
        assert!(satchel.node.list_peers().is_empty());
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn a_wrong_secret_is_refused_and_the_offer_survives() {
        let mut shelf = TestNode::start("pair-wrong-shelf", Role::Shelf).await;
        let satchel = TestNode::start("pair-wrong-satchel", Role::Satchel).await;
        let offer = begin(&shelf.node, None).unwrap();
        let mut uri = PairUri::parse(&offer.url).unwrap();
        uri.secret[0] ^= 1;
        let (_, task) = from_uri(&satchel.node, &uri.to_uri(), None, vec![])
            .await
            .unwrap();
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.kind(), "pairingRefused");
        assert!(err.to_string().contains("bad-mac"), "{err}");
        assert!(shelf.node.list_peers().is_empty());
        assert!(satchel.node.list_peers().is_empty());
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingResult(_)))
            .await;
        assert!(
            matches!(ev, PeerEvent::PairingResult(r) if !r.ok && r.reason.as_deref() == Some("bad-mac"))
        );

        // The real satchel can still use the offer.
        let (_, task) = from_uri(&satchel.node, &offer.url, None, vec![])
            .await
            .unwrap();
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await;
        let PeerEvent::PairingPending(pending) = ev else {
            unreachable!()
        };
        confirm(&shelf.node, true, vec![], pending.attempt_id)
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(shelf.node.list_peers().len(), 1);
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn an_expired_offer_is_refused() {
        let mut shelf = TestNode::start("pair-expired-shelf", Role::Shelf).await;
        let satchel = TestNode::start("pair-expired-satchel", Role::Satchel).await;
        let offer = begin(&shelf.node, None).unwrap();
        // Age the pending secret in place, on the monotonic deadline (finding
        // L10) — the enforcement clock, not the wall clock.
        {
            let mut inner = shelf.node.pairing.inner.lock().unwrap();
            inner.pending.as_mut().unwrap().expires_at = Instant::now() - Duration::from_secs(1);
        }
        let (_, task) = from_uri(&satchel.node, &offer.url, None, vec![])
            .await
            .unwrap();
        let err = task.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("expired"), "{err}");
        assert!(shelf.node.list_peers().is_empty());
        // And it is gone: a retry sees no pending.
        let (_, task) = from_uri(&satchel.node, &offer.url, None, vec![])
            .await
            .unwrap();
        let err = task.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("no-pending"), "{err}");
        let _ = shelf.next_event().await;
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn a_second_use_of_a_spent_secret_is_refused() {
        let mut shelf = TestNode::start("pair-reuse-shelf", Role::Shelf).await;
        let mut satchel = TestNode::start("pair-reuse-satchel", Role::Satchel).await;
        let offer = begin(&shelf.node, None).unwrap();
        let (_, task) = from_uri(&satchel.node, &offer.url, None, vec![])
            .await
            .unwrap();
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await;
        let PeerEvent::PairingPending(pending) = ev else {
            unreachable!()
        };
        confirm(&shelf.node, true, vec![], pending.attempt_id)
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap().unwrap();

        let other = TestNode::start("pair-reuse-other", Role::Satchel).await;
        let (_, task) = from_uri(&other.node, &offer.url, None, vec![])
            .await
            .unwrap();
        let err = task.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("no-pending"), "{err}");
        assert_eq!(shelf.node.list_peers().len(), 1);
        assert_eq!(shelf.node.list_peers()[0].id, satchel.id());
        let _ = satchel.next_event().await;
        shelf.close().await;
        satchel.close().await;
        other.close().await;
    }

    #[tokio::test]
    async fn cancel_refuses_a_satchel_awaiting_the_human() {
        let mut shelf = TestNode::start("pair-cancel-shelf", Role::Shelf).await;
        let satchel = TestNode::start("pair-cancel-satchel", Role::Satchel).await;
        let offer = begin(&shelf.node, None).unwrap();
        let (_, task) = from_uri(&satchel.node, &offer.url, None, vec![])
            .await
            .unwrap();
        shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await;
        cancel(&shelf.node);
        let err = task.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("cancelled"), "{err}");
        assert_eq!(
            confirm(&shelf.node, true, vec![], "no-such-attempt".into())
                .await
                .unwrap_err()
                .kind(),
            "noPendingPairing"
        );
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn no_confirmation_in_time_refuses() {
        let mut shelf = TestNode::start_with(
            "pair-timeout-shelf",
            Role::Shelf,
            Duration::from_millis(300),
        )
        .await;
        let satchel = TestNode::start("pair-timeout-satchel", Role::Satchel).await;
        let offer = begin(&shelf.node, None).unwrap();
        let (_, task) = from_uri(&satchel.node, &offer.url, None, vec![])
            .await
            .unwrap();
        shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await;
        let err = timeout(Duration::from_secs(5), task)
            .await
            .expect("refused within 5s")
            .unwrap()
            .unwrap_err();
        assert!(err.to_string().contains("timeout"), "{err}");
        assert!(shelf.node.list_peers().is_empty());
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn a_shelf_dialing_as_a_satchel_is_refused_by_role() {
        let shelf = TestNode::start("pair-role-shelf", Role::Shelf).await;
        let other_shelf = TestNode::start("pair-role-other", Role::Shelf).await;
        let satchel = TestNode::start("pair-role-satchel", Role::Satchel).await;
        let offer = begin(&shelf.node, None).unwrap();
        // The dialing side refuses before touching the network.
        assert_eq!(
            from_uri(&other_shelf.node, &offer.url, None, vec![])
                .await
                .unwrap_err()
                .kind(),
            "roleMismatch"
        );
        // A satchel cannot mint an offer.
        assert_eq!(
            begin(&satchel.node, None).unwrap_err().kind(),
            "roleMismatch"
        );
        // And a hand-rolled hello claiming to be a shelf is refused on the wire.
        let raw = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .unwrap();
        let uri = PairUri::parse(&offer.url).unwrap();
        let conn = raw.connect(uri.endpoint_addr(), PAIR_ALPN).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        write_json(
            &mut send,
            &PairHello {
                name: "x".into(),
                platform: "test".into(),
                role: Role::Shelf,
                mac: pair_mac(&uri.secret, &shelf.node.id(), &raw.id())
                    .to_hex()
                    .to_string(),
            },
        )
        .await
        .unwrap();
        let ack: PairAck = read_json(&mut recv).await.unwrap();
        assert!(!ack.ok);
        assert_eq!(ack.reason.as_deref(), Some("role-mismatch"));
        assert!(shelf.node.list_peers().is_empty());
        raw.close().await;
        shelf.close().await;
        other_shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn the_shelf_uses_the_authenticated_id_not_a_claimed_one() {
        let mut shelf = TestNode::start("pair-claim-shelf", Role::Shelf).await;
        let offer = begin(&shelf.node, None).unwrap();
        let uri = PairUri::parse(&offer.url).unwrap();
        let raw = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .unwrap();
        let bogus = SecretKey::generate().public();

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct HelloWithClaim {
            name: String,
            platform: String,
            role: Role,
            mac: String,
            satchel_id: String,
        }

        // A MAC over the claimed id: refused, because the shelf MACs over
        // the id it authenticated.
        let conn = raw.connect(uri.endpoint_addr(), PAIR_ALPN).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        write_json(
            &mut send,
            &HelloWithClaim {
                name: "imp".into(),
                platform: "test".into(),
                role: Role::Satchel,
                mac: pair_mac(&uri.secret, &shelf.node.id(), &bogus)
                    .to_hex()
                    .to_string(),
                satchel_id: bogus.to_string(),
            },
        )
        .await
        .unwrap();
        let ack: PairAck = read_json(&mut recv).await.unwrap();
        assert!(!ack.ok);
        assert_eq!(ack.reason.as_deref(), Some("bad-mac"));

        // A MAC over the real id with a bogus claim alongside: the claim is
        // ignored and the persisted id is the authenticated one.
        let conn = raw.connect(uri.endpoint_addr(), PAIR_ALPN).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        write_json(
            &mut send,
            &HelloWithClaim {
                name: "imp".into(),
                platform: "test".into(),
                role: Role::Satchel,
                mac: pair_mac(&uri.secret, &shelf.node.id(), &raw.id())
                    .to_hex()
                    .to_string(),
                satchel_id: bogus.to_string(),
            },
        )
        .await
        .unwrap();
        let PeerEvent::PairingPending(pending) = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await
        else {
            unreachable!()
        };
        assert_eq!(pending.id, raw.id().to_string());
        assert_eq!(pending.sas, sas(&uri.secret, &shelf.node.id(), &raw.id()));
        // The raw satchel, concurrently: read the ack, check it, and return its
        // commit so the shelf keeps the peer (the two-sided commit, finding M8).
        let raw_id = raw.id();
        let shelf_id = shelf.node.id();
        let secret = uri.secret;
        let ack_task = tokio::spawn(async move {
            let ack: PairAck = read_json(&mut recv).await.unwrap();
            assert!(ack.ok);
            assert_eq!(
                ack.mac_ack.as_deref(),
                Some(ack_mac(&secret, &raw_id, &shelf_id).to_hex().as_str())
            );
            let commit = PairCommit {
                mac_commit: commit_mac(&secret, &raw_id, &shelf_id).to_hex().to_string(),
            };
            write_json(&mut send, &commit).await.unwrap();
            let _ = send.finish();
        });
        let record = confirm(&shelf.node, true, vec![], pending.attempt_id.clone())
            .await
            .unwrap()
            .unwrap();
        ack_task.await.unwrap();
        assert_eq!(record.id, raw.id().to_string());
        assert_ne!(record.id, bogus.to_string());
        raw.close().await;
        shelf.close().await;
    }

    /* Multi-thread ON PURPOSE: a hundred QUIC handshakes, ten endpoints and
     * the shelf's accept loop all cooperatively scheduled on the default
     * current-thread runtime starve each other whenever the sibling tests
     * saturate the machine — the product-side HELLO_TIMEOUT (15s) then
     * expires for every attempt, no claim happens, and the pending-event
     * wait dies. The property under test is the single-shot claim, not
     * single-thread scheduling. */
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_hundred_concurrent_attempts_with_one_secret_pair_exactly_once() {
        let mut shelf = TestNode::start("pair-race-shelf", Role::Shelf).await;
        let offer = begin(&shelf.node, None).unwrap();
        let uri = Arc::new(PairUri::parse(&offer.url).unwrap());
        let shelf_id = shelf.node.id();

        let mut raws = Vec::new();
        for _ in 0..10 {
            raws.push(
                Endpoint::builder(presets::Minimal)
                    .relay_mode(RelayMode::Disabled)
                    .bind()
                    .await
                    .unwrap(),
            );
        }
        let mut tasks = Vec::new();
        for i in 0..100 {
            let raw = raws[i % raws.len()].clone();
            let uri = uri.clone();
            tasks.push(tokio::spawn(async move {
                let conn = raw.connect(uri.endpoint_addr(), PAIR_ALPN).await.unwrap();
                let (mut send, mut recv) = conn.open_bi().await.unwrap();
                write_json(
                    &mut send,
                    &PairHello {
                        name: format!("racer {i}"),
                        platform: "test".into(),
                        role: Role::Satchel,
                        mac: pair_mac(&uri.secret, &shelf_id, &raw.id())
                            .to_hex()
                            .to_string(),
                    },
                )
                .await
                .unwrap();
                let ack: PairAck = read_json(&mut recv).await.unwrap();
                if ack.ok {
                    // The one winner completes the two-sided commit so the
                    // shelf keeps the peer (finding M8).
                    let commit = PairCommit {
                        mac_commit: commit_mac(&uri.secret, &raw.id(), &shelf_id)
                            .to_hex()
                            .to_string(),
                    };
                    let _ = write_json(&mut send, &commit).await;
                    // Wait for delivery before this task returns and drops the
                    // connection, or the commit could be lost.
                    flush(&mut send).await;
                }
                (raw.id().to_string(), ack)
            }));
        }
        // Exactly one reaches the human.
        let PeerEvent::PairingPending(pending) = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await
        else {
            unreachable!()
        };
        confirm(&shelf.node, true, vec![], pending.attempt_id.clone())
            .await
            .unwrap()
            .unwrap();

        let mut ok = 0;
        let mut refused = 0;
        for task in tasks {
            // 30s, not 10s: with 100 concurrent handshakes each now carrying the
            // two-sided commit round-trip (M8), a loaded machine can take longer
            // than 10s to drain them all. The assertion is the count, not the
            // speed, so the headroom costs nothing when the run is fast.
            let (id, ack) = timeout(Duration::from_secs(30), task)
                .await
                .unwrap()
                .unwrap();
            if ack.ok {
                ok += 1;
                assert_eq!(id, pending.id);
            } else {
                refused += 1;
                assert_eq!(ack.reason.as_deref(), Some("no-pending"), "{id}");
            }
        }
        assert_eq!(ok, 1);
        assert_eq!(refused, 99);
        assert_eq!(shelf.node.list_peers().len(), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), async {
                loop {
                    if let PeerEvent::PairingPending(_) = shelf.next_event().await {
                        return;
                    }
                }
            })
            .await
            .is_err(),
            "no second pairing-pending"
        );
        for raw in raws {
            raw.close().await;
        }
        shelf.close().await;
    }

    #[tokio::test]
    async fn an_older_alpn_version_never_completes_a_handshake() {
        let shelf = TestNode::start("pair-alpn-shelf", Role::Shelf).await;
        let raw = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .unwrap();
        let addr = shelf.addr();
        let result = timeout(
            Duration::from_secs(5),
            raw.connect(addr, b"one.paper.reader/pair/0"),
        )
        .await
        .expect("a decision within 5s");
        assert!(result.is_err(), "pair/0 must not connect");
        assert!(shelf.node.list_peers().is_empty());
        raw.close().await;
        shelf.close().await;
    }

    #[tokio::test]
    async fn a_satchel_that_vanishes_before_committing_leaves_no_shelf_trust() {
        // Finding M8: the shelf keeps the peer only once the satchel confirms
        // it persisted too. A satchel that reads the ack then drops without a
        // commit must leave the shelf with no one-way trust.
        let mut shelf = TestNode::start("pair-commit-shelf", Role::Shelf).await;
        let offer = begin(&shelf.node, None).unwrap();
        let uri = PairUri::parse(&offer.url).unwrap();
        let raw = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .unwrap();
        let conn = raw.connect(uri.endpoint_addr(), PAIR_ALPN).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        write_json(
            &mut send,
            &PairHello {
                name: "ghost".into(),
                platform: "test".into(),
                role: Role::Satchel,
                mac: pair_mac(&uri.secret, &shelf.node.id(), &raw.id())
                    .to_hex()
                    .to_string(),
            },
        )
        .await
        .unwrap();
        let PeerEvent::PairingPending(pending) = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await
        else {
            unreachable!()
        };

        // Read the ack, then vanish without ever sending the commit.
        let vanish = tokio::spawn(async move {
            let ack: PairAck = read_json(&mut recv).await.unwrap();
            assert!(ack.ok);
            conn.close(VarInt::from_u32(0), b"bye");
            raw
        });
        let confirmed = confirm(&shelf.node, true, vec!["sync:*".into()], pending.attempt_id).await;
        assert!(confirmed.is_err(), "the shelf reports the commit failed");
        let raw = vanish.await.unwrap();
        assert!(
            shelf.node.list_peers().is_empty(),
            "no one-way shelf trust survives a missing commit"
        );
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingResult(_)))
            .await;
        assert!(matches!(ev, PeerEvent::PairingResult(r) if !r.ok));
        raw.close().await;
        shelf.close().await;
    }

    #[tokio::test]
    async fn confirm_is_bound_to_the_attempt_id() {
        // Finding M9: a confirm carrying the wrong attempt id is refused and
        // does not consume the pending attempt; only the matching id confirms.
        let mut shelf = TestNode::start("pair-attempt-shelf", Role::Shelf).await;
        let mut satchel = TestNode::start("pair-attempt-satchel", Role::Satchel).await;
        let offer = begin(&shelf.node, None).unwrap();
        let (_, task) = from_uri(&satchel.node, &offer.url, None, vec![])
            .await
            .unwrap();
        let PeerEvent::PairingPending(pending) = shelf
            .next_event_where(|e| matches!(e, PeerEvent::PairingPending(_)))
            .await
        else {
            unreachable!()
        };

        // A confirm for a different attempt is refused and leaves the real
        // attempt intact (a stale or pre-played attempt cannot ride this one).
        assert_eq!(
            confirm(&shelf.node, true, vec![], "not-the-attempt".into())
                .await
                .unwrap_err()
                .kind(),
            "noPendingPairing"
        );
        // The matching id confirms it.
        confirm(&shelf.node, true, vec![], pending.attempt_id.clone())
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(shelf.node.list_peers().len(), 1);
        assert_eq!(shelf.node.list_peers()[0].id, satchel.id());
        let _ = satchel.next_event().await;
        shelf.close().await;
        satchel.close().await;
    }
}
