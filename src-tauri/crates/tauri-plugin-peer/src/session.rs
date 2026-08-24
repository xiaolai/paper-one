//! Sessions over `one.paper.reader/peer/1` (plan III.2.2, III.2.6).
//!
//! A session is one QUIC connection to a paired peer. The acceptor checks
//! `conn.remote_id() ∈ peers` before reading a byte and closes with
//! `unknown-peer` otherwise; before the webview has called `peer_ready` it
//! closes with `not-ready` and the peer may retry. The dialer opens one
//! bi-stream — the control stream — and sends the plugin hello
//! `{kind: "hello", proto: 1, role, …}`; the acceptor checks that `role`
//! equals the persisted role for that peer, answers `{kind: "welcome",
//! role}`, and from then on every frame on the control stream is opaque to
//! the plugin: appended to the session's inbox, drained by the webview.
//! Every further bi-stream on the connection is a blob stream (`blobs.rs`).
//!
//! What the plugin never does here: interpret an envelope, check a service
//! grant (the webview asks `peer_has_grant` and refuses before dispatch),
//! or keep anything past the session's life.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use iroh::endpoint::{Connection, RecvStream, SendStream, VarInt};
use iroh::{EndpointAddr, EndpointId};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio::time::timeout;

use crate::blobs;
use crate::error::{Error, Result};
use crate::events::{PeerEvent, SessionClosed, SessionFrames, SessionOpen};
use crate::frame::{read_frame, read_json, write_frame, write_json};
use crate::node::{parse_peer_id, Node};
use crate::pairing::{closed_reason, remote_addrs};
use crate::role::Role;

pub const PEER_ALPN: &[u8] = b"one.paper.reader/peer/1";
const HELLO_TIMEOUT: Duration = Duration::from_secs(15);
const DIAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Frames the inbox holds before the reader stops pulling from the wire — a
/// secondary bound that keeps a flood of tiny (even empty) frames from growing
/// the queue without bound. The byte budget below is the real memory ceiling.
pub const INBOX_CAP: usize = 4096;
/// Bytes the inbox holds before the reader stops pulling from the wire. This,
/// not the frame count, is what bounds memory: at 4096 frames of up to 4 MiB
/// the old frame-only cap allowed ~16 GiB per session. The reader admits a
/// frame only while under this budget, so at most `INBOX_BYTE_CAP` plus one
/// in-flight [`MAX_FRAME`](crate::frame::MAX_FRAME) is ever buffered. QUIC flow
/// control backpressures the sender; nothing is dropped.
pub const INBOX_BYTE_CAP: usize = 8 * 1024 * 1024;

/// The most sessions this node keeps open at once, across all peers — a bound
/// on connections, tasks and file descriptors a flood of dials can spawn.
pub const MAX_SESSIONS: usize = 256;
/// The most sessions any one peer may hold. The app opens a single session per
/// peer; this leaves headroom for a reconnect overlapping a not-yet-reaped drop
/// while still refusing a peer that tries to spawn many.
pub const MAX_SESSIONS_PER_PEER: usize = 4;

/// Close codes. The reason string is what both sides act on; the code is
/// for wire-level bookkeeping.
const CODE_OK: u32 = 0;
const CODE_REFUSED: u32 = 1;
const CODE_PROTOCOL: u32 = 2;

// ── registry ──────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<u64, Arc<Session>>>,
    next: AtomicU64,
}

impl Sessions {
    /// Register under the SAME lock acquisition as the capacity check:
    /// `at_capacity` and a separate insert let two concurrent handshakes both
    /// pass the check and exceed the caps, so the check-and-insert is one
    /// critical section and the earlier `at_capacity` calls are cheap
    /// pre-refusals, not the gate. `Err` hands the constructed session back
    /// UNREGISTERED, for the caller to close.
    #[allow(clippy::result_large_err)]
    fn register_within_caps(
        &self,
        peer: EndpointId,
        make: impl FnOnce(u64) -> Session,
    ) -> std::result::Result<Arc<Session>, Arc<Session>> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let session = Arc::new(make(id));
        let mut inner = self.inner.lock().expect("sessions lock");
        if over_caps(&inner, peer) {
            return Err(session);
        }
        inner.insert(id, session.clone());
        Ok(session)
    }

    /// Whether admitting another session for `peer` would break the global or
    /// per-peer cap. Checked before the handshake completes so a flood of
    /// dials cannot spawn unbounded sessions.
    pub fn at_capacity(&self, peer: EndpointId) -> bool {
        let inner = self.inner.lock().expect("sessions lock");
        over_caps(&inner, peer)
    }

    pub fn get(&self, id: u64) -> Option<Arc<Session>> {
        self.inner.lock().expect("sessions lock").get(&id).cloned()
    }

    fn remove(&self, id: u64) -> Option<Arc<Session>> {
        self.inner.lock().expect("sessions lock").remove(&id)
    }

    pub fn for_peer(&self, peer: EndpointId) -> Vec<Arc<Session>> {
        self.inner
            .lock()
            .expect("sessions lock")
            .values()
            .filter(|s| s.peer_id == peer)
            .cloned()
            .collect()
    }

    pub fn all(&self) -> Vec<Arc<Session>> {
        self.inner
            .lock()
            .expect("sessions lock")
            .values()
            .cloned()
            .collect()
    }

    /// Any open session with the peer — for a blob fetch, which rides on
    /// an existing connection.
    pub fn any_for_peer(&self, peer: EndpointId) -> Option<Arc<Session>> {
        self.for_peer(peer).into_iter().next()
    }
}

/// The capacity predicate, under the caller's lock — ONE copy, shared by the
/// cheap pre-refusal and the atomic registration gate so the two cannot drift.
fn over_caps(inner: &HashMap<u64, Arc<Session>>, peer: EndpointId) -> bool {
    inner.len() >= MAX_SESSIONS
        || inner.values().filter(|s| s.peer_id == peer).count() >= MAX_SESSIONS_PER_PEER
}

// ── a session ─────────────────────────────────────────────────────────────

/// The session's inbox and its running byte total, under one lock so the two
/// never disagree.
#[derive(Default)]
struct Inbox {
    frames: VecDeque<Bytes>,
    bytes: usize,
}

pub struct Session {
    pub id: u64,
    pub peer_id: EndpointId,
    conn: Connection,
    send: tokio::sync::Mutex<SendStream>,
    inbox: Mutex<Inbox>,
    space: Notify,
    close_reason: Mutex<Option<String>>,
    finished: AtomicBool,
}

impl Session {
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Close from this side with a reason both ends will report.
    pub fn close_with(&self, reason: &str) {
        {
            let mut current = self.close_reason.lock().expect("close reason lock");
            if current.is_none() {
                *current = Some(reason.to_owned());
            }
        }
        let code = match reason {
            "closed" => CODE_OK,
            "frame-too-large" | "bad-hello" => CODE_PROTOCOL,
            _ => CODE_REFUSED,
        };
        self.conn.close(VarInt::from_u32(code), reason.as_bytes());
    }

    /// One frame to the peer.
    pub async fn send(&self, payload: &[u8]) -> Result<()> {
        let mut send = self.send.lock().await;
        write_frame(&mut *send, payload).await
    }

    /// Bytes to the peer with no framing — for tests that need to put a
    /// malformed frame on the wire.
    #[cfg(test)]
    pub(crate) async fn send_raw(&self, bytes: &[u8]) -> Result<()> {
        let mut send = self.send.lock().await;
        send.write_all(bytes).await?;
        Ok(())
    }

    /// Up to `max` frames from the inbox, oldest first. Never waits.
    pub fn drain(&self, max: usize) -> Vec<Bytes> {
        let mut inbox = self.inbox.lock().expect("inbox lock");
        let n = max.min(inbox.frames.len());
        let out: Vec<Bytes> = inbox.frames.drain(..n).collect();
        inbox.bytes -= out.iter().map(Bytes::len).sum::<usize>();
        drop(inbox);
        if n > 0 {
            self.space.notify_one();
        }
        out
    }

    fn inbox_len(&self) -> usize {
        self.inbox.lock().expect("inbox lock").frames.len()
    }

    /// Bytes currently buffered — the memory this session's inbox holds.
    fn inbox_bytes(&self) -> usize {
        self.inbox.lock().expect("inbox lock").bytes
    }
}

// ── the plugin hello ──────────────────────────────────────────────────────

/// The dialer's first frame: the app's object with `kind`, `proto` and
/// `role` set by the plugin. `role` is always this node's — the app cannot
/// claim another.
fn build_hello(role: Role, app: Value) -> Result<Value> {
    let mut object = match app {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        _ => return Err(Error::FrameMalformed("hello must be a JSON object".into())),
    };
    object.insert("kind".into(), json!("hello"));
    object.entry("proto").or_insert(json!(1));
    object.insert(
        "role".into(),
        serde_json::to_value(role).expect("role serializes"),
    );
    Ok(Value::Object(object))
}

fn role_of(frame: &Value, kind: &str) -> Result<Role> {
    if frame.get("kind").and_then(Value::as_str) != Some(kind) {
        return Err(Error::FrameMalformed(format!("expected a {kind} frame")));
    }
    let role = frame
        .get("role")
        .cloned()
        .ok_or_else(|| Error::FrameMalformed("hello without a role".into()))?;
    serde_json::from_value(role)
        .map_err(|_| Error::FrameMalformed("hello with an unknown role".into()))
}

fn welcome(role: Role) -> Value {
    json!({ "kind": "welcome", "role": role })
}

/// `198.18.0.0/15` — RFC 2544's benchmarking range, which never appears on a
/// real network and is what a TUN proxy hands back for its synthesised
/// "fake IP" DNS answers.
///
/// A peer that records one of these has recorded the proxy's placeholder, not
/// an endpoint: dialling it can only ever time out, and it does so ahead of
/// the addresses that might have worked, because hints are tried in the order
/// they are given. Observed in this app's own peer store, stored beside two
/// perfectly good LAN addresses.
///
/// Deliberately NOT filtered: `100.64.0.0/10`. It looks equally synthetic and
/// is not — a tailnet lives there, and dropping it would remove a route that
/// genuinely carries traffic on this fleet.
fn is_synthetic(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            (a == 198 && (b == 18 || b == 19)) || v4.is_unspecified() || v4.is_loopback()
        }
        std::net::IpAddr::V6(v6) => v6.is_unspecified() || v6.is_loopback(),
    }
}

fn endpoint_addr(id: EndpointId, hints: &[String]) -> EndpointAddr {
    let mut addr = EndpointAddr::new(id);
    for hint in hints {
        if let Ok(ip) = hint.parse::<std::net::SocketAddr>() {
            if is_synthetic(ip.ip()) {
                continue;
            }
            addr = addr.with_ip_addr(ip);
        } else if let Ok(relay) = hint.parse() {
            addr = addr.with_relay_url(relay);
        }
    }
    addr
}

// ── accept side ───────────────────────────────────────────────────────────

/// One incoming `peer/1` connection.
pub(crate) async fn serve(node: Arc<Node>, conn: Connection) {
    // The allow-list, before a byte is read.
    let remote = conn.remote_id();
    let record = node.peers().get(&remote.to_string()).cloned();
    let Some(record) = record else {
        conn.close(VarInt::from_u32(CODE_REFUSED), b"unknown-peer");
        return;
    };
    if !node.is_ready() {
        conn.close(VarInt::from_u32(CODE_REFUSED), b"not-ready");
        return;
    }
    let refuse = |reason: &str| conn.close(VarInt::from_u32(CODE_PROTOCOL), reason.as_bytes());

    let Ok(Ok((mut send, mut recv))) = timeout(HELLO_TIMEOUT, conn.accept_bi()).await else {
        refuse("bad-hello");
        return;
    };
    let Ok(Ok(hello)) = timeout(HELLO_TIMEOUT, read_json::<_, Value>(&mut recv)).await else {
        refuse("bad-hello");
        return;
    };
    let Ok(role) = role_of(&hello, "hello") else {
        refuse("bad-hello");
        return;
    };
    if role != record.role {
        conn.close(VarInt::from_u32(CODE_REFUSED), b"role-mismatch");
        return;
    }
    if write_json(&mut send, &welcome(node.role())).await.is_err() {
        refuse("bad-hello");
        return;
    }
    // A test seam for the forget-vs-admission window (finding H5): pause here,
    // after the hello and before registration, so a test can forget the peer
    // in exactly the window the finding describes.
    #[cfg(test)]
    node.admit_gate().await;
    if node.sessions.at_capacity(remote) {
        conn.close(VarInt::from_u32(CODE_REFUSED), b"too-many-sessions");
        return;
    }
    establish(&node, conn, send, recv, remote, role, false, hello).await;
}

// ── dial side ─────────────────────────────────────────────────────────────

/// Dial a paired peer with its stored address hints (plus whatever
/// discovery the endpoint has), send the hello, wait for the welcome.
pub async fn connect(node: &Arc<Node>, peer_id: &str, hello: Value) -> Result<u64> {
    let id = parse_peer_id(peer_id)?;
    let record = node
        .peers()
        .get(peer_id)
        .cloned()
        .ok_or_else(|| Error::PeerUnknown(peer_id.to_owned()))?;
    let hello = build_hello(node.role(), hello)?;
    let conn = timeout(
        DIAL_TIMEOUT,
        node.endpoint()
            .connect(endpoint_addr(id, &record.last_addrs), PEER_ALPN),
    )
    .await
    .map_err(|_| Error::Timeout("session dial"))??;

    let exchange = async {
        let (mut send, mut recv) = conn.open_bi().await?;
        write_json(&mut send, &hello).await?;
        let welcome: Value = read_json(&mut recv).await?;
        Ok::<_, Error>((send, recv, welcome))
    };
    let (send, recv, welcome) = match timeout(HELLO_TIMEOUT, exchange).await {
        Ok(Ok(parts)) => parts,
        Ok(Err(err)) => {
            return Err(closed_reason(&conn)
                .map(Error::SessionRefused)
                .unwrap_or(err))
        }
        Err(_) => {
            conn.close(VarInt::from_u32(CODE_PROTOCOL), b"bad-hello");
            return Err(closed_reason(&conn)
                .map(Error::SessionRefused)
                .unwrap_or(Error::Timeout("session hello")));
        }
    };
    let role = role_of(&welcome, "welcome")?;
    if role != record.role {
        conn.close(VarInt::from_u32(CODE_REFUSED), b"role-mismatch");
        return Err(Error::RoleMismatch {
            expected: record.role,
            got: role,
        });
    }
    if node.sessions.at_capacity(id) {
        conn.close(VarInt::from_u32(CODE_REFUSED), b"too-many-sessions");
        return Err(Error::TooManySessions);
    }
    let session = establish(node, conn, send, recv, id, role, true, hello)
        .await
        .ok_or_else(|| Error::SessionRefused("revoked".into()))?;
    Ok(session.id)
}

/// Register the session and start its loops, unless the peer was forgotten
/// during the hello window. `None` means the session was refused and its
/// connection closed; nothing was emitted.
#[allow(clippy::too_many_arguments)]
async fn establish(
    node: &Arc<Node>,
    conn: Connection,
    send: SendStream,
    recv: RecvStream,
    peer: EndpointId,
    role: Role,
    initiator: bool,
    hello: Value,
) -> Option<Arc<Session>> {
    let session = match node.sessions.register_within_caps(peer, |id| Session {
        id,
        peer_id: peer,
        conn,
        send: tokio::sync::Mutex::new(send),
        inbox: Mutex::new(Inbox::default()),
        space: Notify::new(),
        close_reason: Mutex::new(None),
        finished: AtomicBool::new(false),
    }) {
        Ok(session) => session,
        Err(refused) => {
            /* The atomic gate said no — a racing handshake took the last
             * slot after this one's early check passed. */
            refused.close_with("too-many-sessions");
            return None;
        }
    };
    // Finding H5 — the forget-vs-admission race. `forget_peer` removes the peer
    // from the store and *then* closes its live sessions. We registered above,
    // so any concurrent forget either sees this session (and closes it) or has
    // already removed the peer (and this re-check sees the gap): no interleaving
    // can leave a live session for a peer forgotten while its hello was in
    // flight. A stale record captured before the hello no longer decides
    // admission on its own.
    let still_trusted = node.peers().get(&peer.to_string()).map(|r| r.role) == Some(role);
    if !still_trusted {
        session.close_with("revoked");
        node.sessions.remove(session.id);
        return None;
    }
    let addrs = remote_addrs(node, peer).await;
    let _ = node.peers().touch_seen(&peer.to_string(), addrs);
    node.emit(PeerEvent::SessionOpen(SessionOpen {
        session_id: session.id,
        peer_id: peer.to_string(),
        role,
        initiator,
        hello,
    }));
    tokio::spawn(reader_loop(node.clone(), session.clone(), recv));
    tokio::spawn(blob_accept_loop(node.clone(), session.clone()));
    Some(session)
}

async fn reader_loop(node: Arc<Node>, session: Arc<Session>, mut recv: RecvStream) {
    loop {
        // Backpressure on *bytes* (the memory bound) and on frame count (a
        // flood of empty frames). While over budget the reader stops pulling,
        // and QUIC flow control stalls the sender; nothing is dropped. The
        // wait also watches the CONNECTION: a peer that fills the inbox and
        // closes would otherwise park this reader on a notification only a
        // webview drain sends — and a closed session is never drained — so
        // reader, connection and inbox bytes all leaked, repeatably.
        while session.inbox_len() >= INBOX_CAP || session.inbox_bytes() >= INBOX_BYTE_CAP {
            if session.finished.load(Ordering::SeqCst) || session.conn.close_reason().is_some() {
                finish(&node, &session);
                return;
            }
            tokio::select! {
                _ = session.space.notified() => {}
                _ = session.conn.closed() => {}
            }
        }
        match read_frame(&mut recv).await {
            Ok(Some(frame)) => {
                let (count, was_empty) = {
                    let mut inbox = session.inbox.lock().expect("inbox lock");
                    let was_empty = inbox.frames.is_empty();
                    inbox.bytes += frame.len();
                    inbox.frames.push_back(frame);
                    (inbox.frames.len(), was_empty)
                };
                // Edge-triggered: one event when the inbox goes from empty
                // to non-empty; the webview drains until `recv` is empty.
                if was_empty {
                    node.emit(PeerEvent::SessionFrames(SessionFrames {
                        session_id: session.id,
                        count,
                    }));
                }
            }
            Ok(None) => break,
            Err(Error::FrameTooLarge { .. }) => {
                session.close_with("frame-too-large");
                break;
            }
            Err(_) => break,
        }
    }
    finish(&node, &session);
}

async fn blob_accept_loop(node: Arc<Node>, session: Arc<Session>) {
    while let Ok((send, recv)) = session.conn.accept_bi().await {
        // Cap concurrent blob-serve tasks so a peer cannot open unbounded
        // streams and spawn unbounded tasks/descriptors. Over the cap, the
        // stream is dropped (reset) rather than served.
        let Ok(permit) = node.blob_serve_limit.clone().try_acquire_owned() else {
            drop((send, recv));
            continue;
        };
        let node = node.clone();
        let session = session.clone();
        tokio::spawn(async move {
            let _permit = permit;
            blobs::serve_stream(node, session, send, recv).await;
        });
    }
    finish(&node, &session);
}

/// Unregister, tear the connection down, and announce, once.
fn finish(node: &Node, session: &Session) {
    if session.finished.swap(true, Ordering::SeqCst) {
        return;
    }
    node.sessions.remove(session.id);
    let reason = session
        .close_reason
        .lock()
        .expect("close reason lock")
        .clone()
        .or_else(|| closed_reason(&session.conn))
        .unwrap_or_else(|| "lost".to_owned());
    // Close the QUIC connection so the *other* loop riding it — blob-accept
    // when the control stream ended, or the reader when blob-accept ended —
    // unblocks and exits too. No connection (and no blob task on it) outlives
    // its control stream. Idempotent: a prior `close_with` keeps its reason.
    session
        .conn
        .close(VarInt::from_u32(CODE_OK), reason.as_bytes());
    node.emit(PeerEvent::SessionClosed(SessionClosed {
        session_id: session.id,
        reason,
    }));
}

// ── node surface ──────────────────────────────────────────────────────────

impl Node {
    fn session(&self, id: u64) -> Result<Arc<Session>> {
        self.sessions.get(id).ok_or(Error::SessionUnknown(id))
    }

    pub async fn session_send(&self, id: u64, payload: &[u8]) -> Result<()> {
        self.session(id)?.send(payload).await
    }

    /// Up to `max` waiting frames; returns at once, possibly empty.
    pub fn session_recv(&self, id: u64, max: usize) -> Result<Vec<Bytes>> {
        Ok(self.session(id)?.drain(max))
    }

    pub fn session_close(&self, id: u64) -> Result<()> {
        self.session(id)?.close_with("closed");
        Ok(())
    }
}

#[cfg(test)]
mod tests {

    /// A proxy's synthesised address is not an endpoint, and dialling one can
    /// only time out — ahead of the addresses that would have worked, since
    /// hints are tried in order. Both of these were in this app's real peer
    /// store, recorded beside two good LAN addresses.
    #[test]
    fn synthetic_proxy_addresses_are_not_dialled() {
        use std::net::IpAddr;
        for fake in ["198.18.0.1", "198.19.255.255", "0.0.0.0", "127.0.0.1"] {
            assert!(
                is_synthetic(fake.parse::<IpAddr>().unwrap()),
                "{fake} should be refused as a dial hint"
            );
        }
        // A tailnet address looks equally synthetic to a reader and carries
        // real traffic; dropping it would remove a working route. `is_synthetic`
        // keys on 198.18/19, unspecified and loopback ONLY, so what matters here
        // is the range each address sits in, never its exact value.
        //
        // DOCUMENTATION RANGES AND THE BASE OF THE CGNAT BLOCK, on purpose. This
        // list held two addresses copied from a real peer store — one tailnet,
        // one routable and public — which is network topology, and this file is
        // public. RFC 5737 and 100.64.0.0/10 say the same thing about ranges
        // while naming nobody's machine.
        for real in ["192.168.1.16", "100.64.0.1", "10.0.0.4", "203.0.113.9"] {
            assert!(
                !is_synthetic(real.parse::<IpAddr>().unwrap()),
                "{real} is routable and must still be dialled"
            );
        }
    }

    #[test]
    fn a_hint_list_keeps_its_good_addresses_and_drops_the_fake_one() {
        let id = iroh::SecretKey::generate().public();
        let addr = endpoint_addr(
            id,
            &[
                "198.18.0.1:57886".to_string(),
                "192.168.1.8:47821".to_string(),
            ],
        );
        let kept: Vec<_> = addr.ip_addrs().collect();
        assert_eq!(
            kept.len(),
            1,
            "exactly the routable hint survives: {kept:?}"
        );
        assert_eq!(kept[0].to_string(), "192.168.1.8:47821");
    }
    use super::*;
    use crate::node::testkit::TestNode;
    use crate::role::Role;

    /// Two nodes that trust each other; the shelf is ready.
    async fn linked(label: &str) -> (TestNode, TestNode) {
        let shelf = TestNode::start(&format!("{label}-shelf"), Role::Shelf).await;
        let satchel = TestNode::start(&format!("{label}-satchel"), Role::Satchel).await;
        shelf.trust(&satchel, &["sync:*", "blob:*"]);
        satchel.trust(&shelf, &["sync:*", "blob:*"]);
        shelf.node.set_ready();
        satchel.node.set_ready();
        (shelf, satchel)
    }

    async fn open(shelf: &mut TestNode, satchel: &mut TestNode) -> (u64, u64) {
        let out = connect(
            &satchel.node,
            &shelf.id(),
            json!({ "proto": 1, "app": "test" }),
        )
        .await
        .unwrap();
        let PeerEvent::SessionOpen(opened) = shelf
            .next_event_where(|e| matches!(e, PeerEvent::SessionOpen(_)))
            .await
        else {
            unreachable!()
        };
        assert_eq!(opened.peer_id, satchel.id());
        assert_eq!(opened.role, Role::Satchel);
        assert!(!opened.initiator);
        assert_eq!(opened.hello["app"], "test");
        assert_eq!(opened.hello["kind"], "hello");
        assert_eq!(opened.hello["role"], "satchel");
        let PeerEvent::SessionOpen(ours) = satchel
            .next_event_where(|e| matches!(e, PeerEvent::SessionOpen(_)))
            .await
        else {
            unreachable!()
        };
        assert!(ours.initiator);
        assert_eq!(ours.role, Role::Shelf);
        (opened.session_id, out)
    }

    #[test]
    fn the_hello_is_stamped_by_the_plugin() {
        let hello = build_hello(
            Role::Satchel,
            json!({ "proto": 3, "role": "shelf", "x": 1 }),
        )
        .unwrap();
        assert_eq!(hello["kind"], "hello");
        assert_eq!(hello["proto"], 3, "the app's proto is kept");
        assert_eq!(hello["role"], "satchel", "the app cannot claim a role");
        assert_eq!(hello["x"], 1);
        assert_eq!(build_hello(Role::Shelf, Value::Null).unwrap()["proto"], 1);
        assert_eq!(
            build_hello(Role::Shelf, json!([1])).unwrap_err().kind(),
            "frameMalformed"
        );
        assert_eq!(role_of(&hello, "hello").unwrap(), Role::Satchel);
        assert_eq!(
            role_of(&hello, "welcome").unwrap_err().kind(),
            "frameMalformed"
        );
        assert_eq!(
            role_of(&json!({"kind":"hello","role":"phone"}), "hello")
                .unwrap_err()
                .kind(),
            "frameMalformed"
        );
    }

    #[test]
    fn address_hints_parse_ips_and_relays_and_skip_junk() {
        let id = iroh::SecretKey::from_bytes(&[3u8; 32]).public();
        let addr = endpoint_addr(
            id,
            &[
                "10.0.0.2:4433".into(),
                "https://relay.example/".into(),
                "garbage".into(),
            ],
        );
        assert_eq!(addr.ip_addrs().count(), 1);
        assert_eq!(addr.relay_urls().count(), 1);
    }

    #[tokio::test]
    async fn an_unknown_peer_is_refused_before_the_hello() {
        let mut shelf = TestNode::start("sess-unknown-shelf", Role::Shelf).await;
        let stranger = TestNode::start("sess-unknown-stranger", Role::Satchel).await;
        stranger.trust(&shelf, &[]);
        shelf.node.set_ready();
        let err = connect(&stranger.node, &shelf.id(), Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "sessionRefused", "{err}");
        assert!(err.to_string().contains("unknown-peer"));
        assert!(
            timeout(Duration::from_millis(300), shelf.events.recv())
                .await
                .is_err(),
            "no session event on the shelf"
        );
        assert!(shelf.node.sessions.all().is_empty());
        shelf.close().await;
        stranger.close().await;
    }

    #[tokio::test]
    async fn before_ready_sessions_are_refused_and_after_it_nothing_is_lost() {
        let (mut shelf, mut satchel) = linked("sess-ready").await;
        // Un-ready the shelf for the first attempt.
        let shelf_not_ready = TestNode::start("sess-ready-shelf2", Role::Shelf).await;
        shelf_not_ready.trust(&satchel, &["sync:*"]);
        satchel.trust(&shelf_not_ready, &["sync:*"]);
        let err = connect(&satchel.node, &shelf_not_ready.id(), Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "sessionRefused");
        assert!(err.to_string().contains("not-ready"), "{err}");

        // Ready: retry succeeds and 1000 frames arrive in order.
        shelf_not_ready.node.set_ready();
        let sid = connect(&satchel.node, &shelf_not_ready.id(), Value::Null)
            .await
            .unwrap();
        // The other, ready shelf too, so both directions are exercised.
        let (shelf_sid, satchel_sid) = open(&mut shelf, &mut satchel).await;
        for i in 0..1000u32 {
            satchel
                .node
                .session_send(satchel_sid, &i.to_be_bytes())
                .await
                .unwrap();
        }
        let mut got = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while got.len() < 1000 {
            let batch = shelf.node.session_recv(shelf_sid, 100).unwrap();
            if batch.is_empty() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "1000 frames within 5s"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
                continue;
            }
            assert!(batch.len() <= 100, "max is honoured");
            got.extend(batch);
        }
        assert_eq!(got.len(), 1000);
        for (i, frame) in got.iter().enumerate() {
            assert_eq!(u32::from_be_bytes(frame[..].try_into().unwrap()), i as u32);
        }
        assert!(shelf.node.session_recv(shelf_sid, 10).unwrap().is_empty());
        // At least one frames event fired, and it named the session.
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::SessionFrames(_)))
            .await;
        assert!(
            matches!(ev, PeerEvent::SessionFrames(f) if f.session_id == shelf_sid && f.count >= 1)
        );

        // And back the other way.
        shelf.node.session_send(shelf_sid, b"pong").await.unwrap();
        let mut back = Vec::new();
        for _ in 0..200 {
            back = satchel.node.session_recv(satchel_sid, 10).unwrap();
            if !back.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(back, vec![Bytes::from_static(b"pong")]);

        satchel.node.session_close(sid).unwrap();
        satchel.node.session_close(satchel_sid).unwrap();
        let ev = satchel
            .next_event_where(|e| matches!(e, PeerEvent::SessionClosed(_)))
            .await;
        assert!(matches!(ev, PeerEvent::SessionClosed(c) if c.reason == "closed"));
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::SessionClosed(_)))
            .await;
        assert!(
            matches!(ev, PeerEvent::SessionClosed(c) if c.reason == "closed" && c.session_id == shelf_sid)
        );
        assert_eq!(
            shelf.node.session_recv(shelf_sid, 1).unwrap_err().kind(),
            "sessionUnknown"
        );
        shelf.close().await;
        satchel.close().await;
        shelf_not_ready.close().await;
    }

    #[tokio::test]
    async fn an_oversized_frame_closes_the_session_at_once() {
        let (mut shelf, mut satchel) = linked("sess-oversized").await;
        let (shelf_sid, satchel_sid) = open(&mut shelf, &mut satchel).await;
        let session = satchel.node.sessions.get(satchel_sid).unwrap();
        // 4 GiB declared, nothing behind it. Were the shelf to allocate,
        // this would take seconds or fail; the close arrives within the
        // event timeout instead.
        session.send_raw(&u32::MAX.to_be_bytes()).await.unwrap();
        let started = std::time::Instant::now();
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::SessionClosed(_)))
            .await;
        assert!(
            matches!(ev, PeerEvent::SessionClosed(c) if c.reason == "frame-too-large" && c.session_id == shelf_sid)
        );
        /* PROMPTLY, and "promptly" means "not by the idle timeout".
         *
         * The property is that an oversized frame closes the session AT ONCE
         * rather than leaving it to expire — the idle timeout is sixty
         * seconds (`BLOB_IDLE_TIMEOUT_MS`), so anything an order of magnitude
         * below that proves the same thing. The bound was two seconds, which
         * also measured the scheduler: a full `cargo test --workspace` on a
         * loaded machine can lose that much to contention, and the failure
         * would be about the host rather than the close path. Ten still
         * separates the two behaviours by six times over. */
        assert!(started.elapsed() < Duration::from_secs(10));
        let ev = satchel
            .next_event_where(|e| matches!(e, PeerEvent::SessionClosed(_)))
            .await;
        assert!(matches!(ev, PeerEvent::SessionClosed(c) if c.reason == "frame-too-large"));
        assert!(shelf.node.sessions.all().is_empty());
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn a_role_mismatch_in_the_hello_is_refused() {
        let (mut shelf, satchel) = linked("sess-role").await;
        // The shelf believes the peer is a shelf; the satchel says satchel.
        let mut wrong = shelf.record_for(&satchel, &[]);
        wrong.role = Role::Shelf;
        shelf.node.peers().insert(wrong).unwrap();
        let err = connect(&satchel.node, &shelf.id(), Value::Null)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("role-mismatch"), "{err}");
        assert!(shelf.node.sessions.all().is_empty());
        // The dialer checks the welcome's role too.
        shelf.trust(&satchel, &[]);
        let mut wrong = satchel.record_for(&shelf, &[]);
        wrong.role = Role::Satchel;
        satchel.node.peers().insert(wrong).unwrap();
        let err = connect(&satchel.node, &shelf.id(), Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "roleMismatch");
        let _ = shelf.next_event().await; // the shelf's session-open
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::SessionClosed(_)))
            .await;
        assert!(matches!(ev, PeerEvent::SessionClosed(c) if c.reason == "role-mismatch"));
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn forgetting_a_peer_closes_its_session_as_revoked_on_both_ends() {
        let (mut shelf, mut satchel) = linked("sess-revoke").await;
        let (shelf_sid, satchel_sid) = open(&mut shelf, &mut satchel).await;
        shelf.node.forget_peer(&satchel.id()).unwrap();
        let ev = shelf
            .next_event_where(|e| matches!(e, PeerEvent::SessionClosed(_)))
            .await;
        assert!(
            matches!(ev, PeerEvent::SessionClosed(c) if c.reason == "revoked" && c.session_id == shelf_sid)
        );
        let ev = satchel
            .next_event_where(|e| matches!(e, PeerEvent::SessionClosed(_)))
            .await;
        assert!(
            matches!(ev, PeerEvent::SessionClosed(c) if c.reason == "revoked" && c.session_id == satchel_sid)
        );
        assert!(satchel.node.session_send(satchel_sid, b"x").await.is_err());
        // And a new session is refused as unknown.
        let err = connect(&satchel.node, &shelf.id(), Value::Null)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown-peer"), "{err}");
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn the_inbox_is_bounded_by_bytes_not_by_frame_count() {
        // Finding H1: the inbox must be bounded by bytes, not frames. A peer
        // flooding ~1 MiB frames without the reader draining must not buffer
        // beyond the byte budget (plus one in-flight frame) — the old 4096
        // frame-only cap allowed ~16 GiB.
        let (mut shelf, mut satchel) = linked("sess-inbox-bytes").await;
        let (shelf_sid, satchel_sid) = open(&mut shelf, &mut satchel).await;
        let shelf_session = shelf.node.sessions.get(shelf_sid).unwrap();

        const FRAME: usize = 1024 * 1024;
        const FRAMES: u32 = 24; // 24 MiB — three times the 8 MiB budget
        let payloads: Vec<Vec<u8>> = (0..FRAMES)
            .map(|i| {
                let mut v = vec![0u8; FRAME];
                v[..4].copy_from_slice(&i.to_be_bytes());
                v
            })
            .collect();
        let sender = {
            let satchel_node = satchel.node.clone();
            let payloads = payloads.clone();
            tokio::spawn(async move {
                for p in &payloads {
                    satchel_node.session_send(satchel_sid, p).await.unwrap();
                }
            })
        };

        // Let the reader fill to the budget and stall on backpressure.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let buffered = shelf_session.inbox_bytes();
        assert!(
            buffered <= INBOX_BYTE_CAP + crate::frame::MAX_FRAME as usize,
            "buffered {buffered} bytes is over the budget plus one frame"
        );
        assert!(
            buffered < (FRAMES as usize) * FRAME,
            "the reader admitted everything ({buffered}); the cap did nothing"
        );

        // Drain it all, in order — nothing was dropped.
        let mut got: Vec<Bytes> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while got.len() < FRAMES as usize {
            let batch = shelf.node.session_recv(shelf_sid, 8).unwrap();
            if batch.is_empty() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "all frames within 20s"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
                continue;
            }
            got.extend(batch);
        }
        sender.await.unwrap();
        for (i, frame) in got.iter().enumerate() {
            assert_eq!(frame.len(), FRAME);
            assert_eq!(u32::from_be_bytes(frame[..4].try_into().unwrap()), i as u32);
        }
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn a_peer_cannot_open_more_than_its_session_cap() {
        // Finding H2: a peer must not spawn unbounded sessions. After the
        // per-peer cap, a further dial is refused.
        let (shelf, satchel) = linked("sess-cap").await;
        for _ in 0..MAX_SESSIONS_PER_PEER {
            connect(&satchel.node, &shelf.id(), Value::Null)
                .await
                .unwrap();
        }
        assert_eq!(
            satchel.node.sessions.for_peer(shelf.node.id()).len(),
            MAX_SESSIONS_PER_PEER
        );
        let err = connect(&satchel.node, &shelf.id(), Value::Null)
            .await
            .unwrap_err();
        assert!(
            matches!(err.kind(), "tooManySessions" | "sessionRefused"),
            "{err}"
        );
        assert!(
            satchel.node.sessions.for_peer(shelf.node.id()).len() <= MAX_SESSIONS_PER_PEER,
            "the dialer never exceeds its cap"
        );
        // Drain the shelf's open events so the drop is quiet.
        while shelf.node.sessions.all().len() < MAX_SESSIONS_PER_PEER {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn forgetting_during_the_hello_window_leaves_no_live_session() {
        // Finding H5: forgetting a peer while its hello is in flight — before
        // any session is registered to close — must still leave no live
        // session. The re-check after registration is what closes the window.
        let (mut shelf, satchel) = linked("sess-admit-race").await;
        let (reached_tx, reached_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *shelf.node.admit_hook.lock().expect("admit hook") = Some(crate::node::AdmitGate {
            reached: reached_tx,
            release: release_rx,
        });

        let dial = {
            let satchel_node = satchel.node.clone();
            let shelf_id = shelf.id();
            tokio::spawn(async move { connect(&satchel_node, &shelf_id, Value::Null).await })
        };

        // The acceptor is paused right before registration: forget the peer in
        // exactly the window the finding describes, then release.
        reached_rx.await.unwrap();
        shelf.node.forget_peer(&satchel.id()).unwrap();
        release_tx.send(()).unwrap();

        let _ = dial.await.unwrap();
        assert!(
            shelf.node.sessions.for_peer(satchel.node.id()).is_empty(),
            "a forgotten peer keeps no live session on the shelf"
        );
        let opened = tokio::time::timeout(Duration::from_millis(400), async {
            loop {
                if let PeerEvent::SessionOpen(_) = shelf.next_event().await {
                    return;
                }
            }
        })
        .await;
        assert!(opened.is_err(), "the shelf never announces an open session");
        shelf.close().await;
        satchel.close().await;
    }

    #[tokio::test]
    async fn dialing_an_unknown_peer_fails_locally() {
        let satchel = TestNode::start("sess-dial-unknown", Role::Satchel).await;
        let id = iroh::SecretKey::generate().public().to_string();
        assert_eq!(
            connect(&satchel.node, &id, Value::Null)
                .await
                .unwrap_err()
                .kind(),
            "peerUnknown"
        );
        assert_eq!(
            connect(&satchel.node, "nope", Value::Null)
                .await
                .unwrap_err()
                .kind(),
            "invalidPeerId"
        );
        assert_eq!(
            satchel.node.session_send(9, b"x").await.unwrap_err().kind(),
            "sessionUnknown"
        );
        satchel.close().await;
    }
}
