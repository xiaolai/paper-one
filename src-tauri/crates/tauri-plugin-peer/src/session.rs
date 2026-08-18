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
/// Frames the inbox holds before the reader stops pulling from the wire.
/// QUIC flow control does the rest; nothing is dropped.
pub const INBOX_CAP: usize = 4096;

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
    fn register(&self, make: impl FnOnce(u64) -> Session) -> Arc<Session> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let session = Arc::new(make(id));
        self.inner
            .lock()
            .expect("sessions lock")
            .insert(id, session.clone());
        session
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

// ── a session ─────────────────────────────────────────────────────────────

pub struct Session {
    pub id: u64,
    pub peer_id: EndpointId,
    conn: Connection,
    send: tokio::sync::Mutex<SendStream>,
    inbox: Mutex<VecDeque<Bytes>>,
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
        let n = max.min(inbox.len());
        let out: Vec<Bytes> = inbox.drain(..n).collect();
        drop(inbox);
        if n > 0 {
            self.space.notify_one();
        }
        out
    }

    fn inbox_len(&self) -> usize {
        self.inbox.lock().expect("inbox lock").len()
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

fn endpoint_addr(id: EndpointId, hints: &[String]) -> EndpointAddr {
    let mut addr = EndpointAddr::new(id);
    for hint in hints {
        if let Ok(ip) = hint.parse() {
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
    let session = establish(node, conn, send, recv, id, role, true, hello).await;
    Ok(session.id)
}

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
) -> Arc<Session> {
    let session = node.sessions.register(|id| Session {
        id,
        peer_id: peer,
        conn,
        send: tokio::sync::Mutex::new(send),
        inbox: Mutex::new(VecDeque::new()),
        space: Notify::new(),
        close_reason: Mutex::new(None),
        finished: AtomicBool::new(false),
    });
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
    session
}

async fn reader_loop(node: Arc<Node>, session: Arc<Session>, mut recv: RecvStream) {
    loop {
        while session.inbox_len() >= INBOX_CAP {
            session.space.notified().await;
        }
        match read_frame(&mut recv).await {
            Ok(Some(frame)) => {
                let (count, was_empty) = {
                    let mut inbox = session.inbox.lock().expect("inbox lock");
                    let was_empty = inbox.is_empty();
                    inbox.push_back(frame);
                    (inbox.len(), was_empty)
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
            Err(Error::FrameTooLarge(_)) => {
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
        tokio::spawn(blobs::serve_stream(
            node.clone(),
            session.clone(),
            send,
            recv,
        ));
    }
    finish(&node, &session);
}

/// Unregister and announce, once.
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
        assert!(started.elapsed() < Duration::from_secs(2));
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
