//! The one peer node this process runs: the endpoint keyed by the device
//! identity, the peer store, and the pairing / session / transfer state the
//! protocol modules hang off. Everything Tauri-facing is a thin command over
//! a method here, and everything here is testable with two nodes in one
//! process (`RelayMode::Disabled`, no discovery, scratch data roots).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use iroh::endpoint::{Connection, VarInt};
use iroh::{Endpoint, EndpointId, RelayMode};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use crate::blobs::{Transfers, MAX_BLOB_STREAMS};
use crate::circle::{self, CIRCLE_HELLO_ALPN};
use crate::endpoint::{self, Advertised, Discovery, EndpointConfig, APP_BIND_PORT};
use crate::error::{Error, Result};
use crate::events::{EventSink, PeerEvent};
use crate::identity;
use crate::pairing::{self, PairingState, PAIR_ALPN};
use crate::peers::{PeerRecord, PeerStore};
use crate::role::Role;
use crate::session::{self, Sessions, PEER_ALPN};

pub struct NodeConfig {
    pub root: PathBuf,
    pub role: Role,
    pub relay_mode: RelayMode,
    pub discovery: Discovery,
    /// The UDP port to bind, or `None` for an ephemeral one.
    ///
    /// `None` IS RIGHT FOR TESTS and wrong for the app: the suites here run
    /// two nodes in one process, and a fixed port would make the second one
    /// fail to bind — or, worse, quietly take the first one's traffic.
    pub bind_port: Option<u16>,
    pub sink: EventSink,
    /// How long the shelf waits for `peer_pair_confirm` after showing the
    /// SAS before it refuses on its own.
    pub confirm_timeout: Duration,
}

impl NodeConfig {
    /// The app's configuration: relays on, n0 DNS on, mDNS everywhere but
    /// iOS.
    pub fn for_app(root: PathBuf, role: Role, sink: EventSink) -> Self {
        Self {
            root,
            role,
            relay_mode: RelayMode::Default,
            discovery: Discovery {
                n0_dns: true,
                mdns: cfg!(not(target_os = "ios")),
            },
            bind_port: Some(APP_BIND_PORT),
            sink,
            confirm_timeout: pairing::CONFIRM_TIMEOUT,
        }
    }
}

/// The default idle deadline for a blob body: if no byte moves on the transfer
/// stream within this window the stalled peer is dropped (finding H2). Held as
/// milliseconds so a test can shorten it.
pub(crate) const BLOB_IDLE_TIMEOUT_MS: u64 = 60_000;

pub struct Node {
    root: PathBuf,
    role: Role,
    endpoint: Endpoint,
    peers: Mutex<PeerStore>,
    pub(crate) pairing: PairingState,
    /* `Arc`, so a pending-handshake permit can hold the registry it must
     * release into — see `session::Handshake`. Derefs transparently, so every
     * `node.sessions.x()` call site is unchanged. */
    pub(crate) sessions: Arc<Sessions>,
    pub(crate) transfers: Transfers,
    /// Caps concurrent blob-serve tasks so a peer cannot open unbounded streams.
    pub(crate) blob_serve_limit: Arc<Semaphore>,
    /// Caps concurrent introductions. See `circle::MAX_HELLOS`.
    ///
    /// ⚠️ **THIS SAID "the one door a STRANGER may knock on", AND THERE ARE
    /// TWO.** `dispatch` below also hands every inbound `PAIR_ALPN` connection
    /// to `pairing::serve`, which until now read its hello under the 4 MiB
    /// TRANSPORT cap — and this sentence, naming this semaphore as the guard for
    /// that whole class, is a plausible reason nobody looked. The pair door is
    /// bounded by `pairing::MAX_HELLO` instead of by a semaphore, and
    /// `pairing.rs` states why: its pre-claim work is a bounded parse and one
    /// constant-time compare, where a circle hello costs a file read and two
    /// ed25519 verifications, so only one of the two amplifies.
    pub(crate) hello_limit: Arc<Semaphore>,
    /// Idle deadline (ms) for a blob body transfer.
    blob_idle_timeout_ms: AtomicU64,
    /// Inbound connections that never reached a protocol module. Counted
    /// because the two ways one can be lost used to be bare `return`s: no
    /// event, no log, nothing to read afterwards. See `accept_loop`.
    dropped_inbound: AtomicU64,
    ready: AtomicBool,
    /// What this endpoint tells the LAN — WI-25.8. Held so the claim can be
    /// read back rather than believed; see `Advertised`.
    advertised: Advertised,
    sink: EventSink,
    pub(crate) confirm_timeout: Duration,
    accept_task: Mutex<Option<JoinHandle<()>>>,
    /// Renews this device's circle credentials and carries its roster around.
    /// See `keeper`.
    keeper_task: Mutex<Option<JoinHandle<()>>>,
    /// Poked when something happened that friends should hear about sooner
    /// than the next scheduled round — a revocation, above all.
    pub(crate) keeper_wake: Arc<tokio::sync::Notify>,
    /// Test seam for the forget-vs-admission window (finding H5): if set, the
    /// acceptor pauses right before registering a session.
    #[cfg(test)]
    pub(crate) admit_hook: Mutex<Option<AdmitGate>>,
    /// Test seam for the blob-body idle deadline (finding H2): if set, the
    /// server pauses after sending the header so a fetch can idle out.
    #[cfg(test)]
    pub(crate) serve_body_gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

/// A one-shot admission gate for the finding-H5 test: the acceptor signals
/// `reached` when it arrives at the pre-registration point, then waits on
/// `release` so the test can forget the peer inside that window.
#[cfg(test)]
pub(crate) struct AdmitGate {
    pub reached: tokio::sync::oneshot::Sender<()>,
    pub release: tokio::sync::oneshot::Receiver<()>,
}

impl std::fmt::Debug for Node {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Node")
            .field("id", &self.endpoint.id())
            .field("role", &self.role)
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl Node {
    /// Load (or create) the identity, load the peers, bind the endpoint on
    /// that identity with both ALPNs, and start accepting.
    pub async fn start(config: NodeConfig) -> Result<Arc<Node>> {
        let secret = identity::load_or_create(&config.root)?;
        let peers = PeerStore::load(&config.root)?;

        /* THREE DOORS, and each answers a different question. `PAIR_ALPN`
        meets a device for the first time; `PEER_ALPN` carries every session
        and refuses a stranger flatly; `CIRCLE_HELLO_ALPN` is the ONLY one an
        unknown endpoint may say anything on, and all it may say is one
        bounded frame.

        ⚠️ **AND NONE OF THEM IS A SHARE ALPN — WI-25.1.** The share endpoint
        answers `iroh_blobs::ALPN` and `NOTES_ALPN` and nothing here; this
        endpoint answers these three and nothing there. `dispatch` below
        refuses anything else outright, which is what makes "each refuses the
        other's protocols" a property of the code rather than of the fact that
        nobody has tried. */
        let endpoint::Bound {
            endpoint,
            advertised,
        } = endpoint::bind(EndpointConfig {
            secret,
            alpns: vec![
                PAIR_ALPN.to_vec(),
                PEER_ALPN.to_vec(),
                CIRCLE_HELLO_ALPN.to_vec(),
            ],
            bind_port: config.bind_port,
            relay_mode: config.relay_mode,
            discovery: config.discovery,
            label: "circle",
        })
        .await?;

        let node = Arc::new(Node {
            root: config.root,
            role: config.role,
            endpoint: endpoint.clone(),
            peers: Mutex::new(peers),
            pairing: PairingState::default(),
            sessions: Arc::new(Sessions::default()),
            transfers: Transfers::default(),
            blob_serve_limit: Arc::new(Semaphore::new(MAX_BLOB_STREAMS)),
            hello_limit: Arc::new(Semaphore::new(circle::MAX_HELLOS)),
            blob_idle_timeout_ms: AtomicU64::new(BLOB_IDLE_TIMEOUT_MS),
            dropped_inbound: AtomicU64::new(0),
            ready: AtomicBool::new(false),
            advertised,
            sink: config.sink,
            confirm_timeout: config.confirm_timeout,
            accept_task: Mutex::new(None),
            keeper_task: Mutex::new(None),
            keeper_wake: Arc::new(tokio::sync::Notify::new()),
            #[cfg(test)]
            admit_hook: Mutex::new(None),
            #[cfg(test)]
            serve_body_gate: Mutex::new(None),
        });
        let task = tokio::spawn(accept_loop(Arc::downgrade(&node), endpoint));
        *node.accept_task.lock().expect("accept task lock") = Some(task);
        /* ⚠️ **WEAK, SO THE KEEPER CANNOT KEEP THE NODE ALIVE.** It sleeps for
         * hours at a time; an `Arc` held across that sleep is an endpoint that
         * stays bound after the app closes, and a next launch that cannot take
         * the port. */
        let keeper = tokio::spawn(crate::keeper::keep(
            Arc::downgrade(&node),
            Arc::clone(&node.keeper_wake),
        ));
        *node.keeper_task.lock().expect("keeper task lock") = Some(keeper);
        Ok(node)
    }

    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// Record — loudly — an inbound connection that never reached a protocol
    /// module, and say at which stage it was lost.
    fn drop_inbound(&self, from: &str, stage: &str, err: &dyn std::fmt::Display) {
        self.dropped_inbound.fetch_add(1, Ordering::Relaxed);
        log::warn!("peer: dropped an inbound connection from {from} at {stage}: {err}");
    }

    /// How many inbound connections never reached a protocol module.
    pub(crate) fn dropped_inbound(&self) -> u64 {
        self.dropped_inbound.load(Ordering::Relaxed)
    }

    pub fn role(&self) -> Role {
        self.role
    }

    /// The keychain this node's person identity lives in.
    ///
    /// ⚠️ **A `cfg(test)` SEAM, like `admit_hook` above, and for a sharper
    /// reason.** `OsKeychain` is machine-wide: under `cargo test` two nodes
    /// with two data roots read back ONE entry, so a suite asserting that two
    /// peers are two different people cannot fail even when they are the same
    /// — and every run leaves a real credential in the developer's login
    /// keychain. The memory keychain is keyed by data root, which is what a
    /// Paper installation actually is.
    #[cfg(not(test))]
    pub(crate) fn keychain(&self) -> Box<dyn crate::person::Keychain> {
        Box::new(crate::person::OsKeychain)
    }

    #[cfg(test)]
    pub(crate) fn keychain(&self) -> Box<dyn crate::person::Keychain> {
        Box::new(crate::person::testkit::MemoryKeychain::for_root(&self.root))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// What this endpoint discloses on the LAN — WI-25.8.
    pub fn advertised(&self) -> &Advertised {
        &self.advertised
    }

    /// The idle deadline for a blob body transfer.
    pub(crate) fn blob_idle_timeout(&self) -> Duration {
        Duration::from_millis(self.blob_idle_timeout_ms.load(Ordering::Relaxed))
    }

    /// Shorten the blob-body idle deadline so a test does not wait a minute.
    #[cfg(test)]
    pub(crate) fn set_blob_idle_timeout(&self, timeout: Duration) {
        self.blob_idle_timeout_ms
            .store(timeout.as_millis() as u64, Ordering::Relaxed);
    }

    /// The finding-H5 admission gate: if a test armed it, signal that the
    /// acceptor reached the pre-registration point and wait for release.
    #[cfg(test)]
    pub(crate) async fn admit_gate(&self) {
        let gate = self.admit_hook.lock().expect("admit hook").take();
        if let Some(gate) = gate {
            let _ = gate.reached.send(());
            let _ = gate.release.await;
        }
    }

    pub(crate) fn emit(&self, event: PeerEvent) {
        (self.sink)(event);
    }

    /// The peer store, locked. Never hold across an `.await`.
    pub(crate) fn peers(&self) -> MutexGuard<'_, PeerStore> {
        self.peers.lock().expect("peer store lock")
    }

    pub fn list_peers(&self) -> Vec<PeerRecord> {
        self.peers().list()
    }

    pub fn has_grant(&self, peer_id: &str, grant: &str) -> bool {
        self.peers().has_grant(peer_id, grant)
    }

    pub fn set_grants(&self, peer_id: &str, grants: Vec<String>) -> Result<()> {
        parse_peer_id(peer_id)?;
        self.peers().set_grants(peer_id, grants)
    }

    /// Remove the peer and close every session it has, with reason
    /// `revoked` — on both ends.
    pub fn forget_peer(&self, peer_id: &str) -> Result<()> {
        let id = parse_peer_id(peer_id)?;
        self.peers().remove(peer_id)?;
        for session in self.sessions.for_peer(id) {
            session.close_with("revoked");
        }
        Ok(())
    }

    /// The webview is listening: from now on `peer/1` sessions are accepted.
    pub fn set_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// Stop accepting, close every session, close the endpoint.
    pub async fn close(&self) {
        if let Some(task) = self.accept_task.lock().expect("accept task lock").take() {
            task.abort();
        }
        /* ⚠️ **ABORTED WITH THE ACCEPTOR, NOT LEFT TO NOTICE.** The keeper
         * holds a WEAK reference, so it would eventually stop on its own —
         * but "eventually" is up to six hours, and a test that closes a node
         * and starts another would have the old one's round dialling out of a
         * suite that thought it had finished. */
        if let Some(task) = self.keeper_task.lock().expect("keeper task lock").take() {
            task.abort();
        }
        for session in self.sessions.all() {
            session.close_with("closed");
        }
        self.endpoint.close().await;
    }
}

/// Parse a peer id string, with the plugin's error rather than iroh's.
pub(crate) fn parse_peer_id(id: &str) -> Result<EndpointId> {
    id.parse::<EndpointId>()
        .map_err(|_| Error::InvalidPeerId(id.to_owned()))
}

async fn accept_loop(node: Weak<Node>, endpoint: Endpoint) {
    while let Some(incoming) = endpoint.accept().await {
        let Some(node) = node.upgrade() else { break };
        tokio::spawn(async move {
            let from = format!("{:?}", incoming.remote_addr());
            /* ⚠️ **BOTH ARMS WERE A BARE `return`, WHICH IS WHY A PAIRING THAT
            NEVER ARRIVED LOOKED EXACTLY LIKE ONE NEVER SENT.** A connection
            lost here reaches no protocol module, so nothing emits, nothing
            logs, and the far end has no record of any kind that it was
            dialled — the joiner sees only its own transport error.

            MEASURED 2026-09-08: a circle pairing between two Macs failed
            intermittently (2 of 12 dials), and on every failure the
            receiving machine's log, its diagnostics ring and its UI were
            all completely silent. Three evenings went to explanations that
            could not be checked because the one side that knew said
            nothing. The count is here so a silent drop is still countable
            when the log has rotated. */
            let accepting = match incoming.accept() {
                Ok(accepting) => accepting,
                Err(err) => return node.drop_inbound(&from, "accept", &err),
            };
            let conn = match accepting.await {
                Ok(conn) => conn,
                Err(err) => return node.drop_inbound(&from, "handshake", &err),
            };
            dispatch(node, conn).await;
        });
    }
    /* The endpoint has closed. Silent, this is indistinguishable from a node
    nobody ever dials — every inbound protocol simply stops working. */
    log::warn!("peer: the accept loop has stopped; this endpoint answers nothing from now on");
}

async fn dispatch(node: Arc<Node>, conn: Connection) {
    match conn.alpn() {
        alpn if alpn == PAIR_ALPN => pairing::serve(node, conn).await,
        alpn if alpn == PEER_ALPN => session::serve(node, conn).await,
        alpn if alpn == CIRCLE_HELLO_ALPN => circle::serve(node, conn).await,
        _ => conn.close(VarInt::from_u32(1), b"unknown-alpn"),
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    //! Two-node fixtures for the protocol tests: scratch roots, relays off,
    //! no discovery, events into a channel.

    use std::sync::Arc;
    use std::time::Duration;

    use iroh::{EndpointAddr, RelayMode};
    use tokio::sync::mpsc;

    use super::{Discovery, Node, NodeConfig};
    use crate::events::PeerEvent;
    use crate::peers::PeerRecord;
    use crate::role::Role;
    use crate::testutil::ScratchDir;

    pub struct TestNode {
        pub node: Arc<Node>,
        pub events: mpsc::UnboundedReceiver<PeerEvent>,
        pub dir: ScratchDir,
    }

    impl TestNode {
        pub async fn start(label: &str, role: Role) -> TestNode {
            Self::start_with(label, role, Duration::from_secs(120)).await
        }

        pub async fn start_with(label: &str, role: Role, confirm_timeout: Duration) -> TestNode {
            let dir = ScratchDir::new(label);
            let (tx, events) = mpsc::unbounded_channel();
            let sink: crate::events::EventSink = Arc::new(move |event| {
                let _ = tx.send(event);
            });
            let node = Node::start(NodeConfig {
                root: dir.path().to_path_buf(),
                role,
                relay_mode: RelayMode::Disabled,
                discovery: Discovery::NONE,
                bind_port: None,
                sink,
                confirm_timeout,
            })
            .await
            .expect("node starts");
            TestNode { node, events, dir }
        }

        pub fn addr(&self) -> EndpointAddr {
            self.node.endpoint().addr()
        }

        pub fn id(&self) -> String {
            self.node.id().to_string()
        }

        /// The address hints as `peers.json` stores them.
        pub fn addr_strings(&self) -> Vec<String> {
            self.addr().ip_addrs().map(|a| a.to_string()).collect()
        }

        /// A record for `other`, as if it had been paired, with these grants.
        pub fn record_for(&self, other: &TestNode, grants: &[&str]) -> PeerRecord {
            PeerRecord {
                id: other.id(),
                name: format!("test {}", other.node.role() as u8),
                platform: "test".into(),
                role: other.node.role(),
                grants: grants.iter().map(|g| g.to_string()).collect(),
                paired_at: 1,
                last_seen_at: 1,
                last_addrs: other.addr_strings(),
            }
        }

        /// Trust `other` directly, no pairing.
        pub fn trust(&self, other: &TestNode, grants: &[&str]) {
            self.node
                .peers()
                .insert(self.record_for(other, grants))
                .unwrap();
        }

        /// The next event. The deadline is a BACKSTOP against a hang, not an
        /// assertion of speed — the same reasoning `next_event_where` below
        /// already carries, and the same thirty seconds.
        ///
        /// It was two seconds, and it flaked exactly as its sibling had: a
        /// full `cargo test --workspace` puts every crate's tests on the same
        /// cores, and this machine reached a load average above forty during
        /// one. Two seconds then measures the scheduler rather than the peer
        /// node, and the failure it reports is about the host, not the code.
        ///
        /// Raised rather than removed, because the point of the bound is that
        /// a genuinely wedged node fails the run instead of hanging it. Thirty
        /// seconds is still far below any real hang and far above any real
        /// event, which is what a backstop should be.
        ///
        /// FIXED IN BOTH HELPERS AT ONCE. The sibling was raised on its own
        /// when its test flaked; leaving this one at two seconds meant the
        /// same defect waiting in the next test to use it, which is what
        /// happened.
        pub async fn next_event(&mut self) -> PeerEvent {
            tokio::time::timeout(Duration::from_secs(30), self.events.recv())
                .await
                .expect("an event within 30s")
                .expect("event channel open")
        }

        /// The next event of a kind, skipping others. The deadline is a
        /// BACKSTOP against a hang, not an assertion of speed: at two
        /// seconds the hundred-attempt pairing test flaked under a full
        /// `cargo test --workspace` run, where every crate's tests contend
        /// for the same cores.
        pub async fn next_event_where(&mut self, pred: impl Fn(&PeerEvent) -> bool) -> PeerEvent {
            tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    let event = self.events.recv().await.expect("event channel open");
                    if pred(&event) {
                        return event;
                    }
                }
            })
            .await
            .expect("a matching event within 30s")
        }

        pub async fn close(self) {
            self.node.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::TestNode;
    use super::*;
    use crate::events::null_sink;
    use crate::testutil::ScratchDir;

    #[tokio::test]
    async fn the_endpoint_id_is_the_persisted_identity_across_restarts() {
        let dir = ScratchDir::new("node-identity");
        let config = || NodeConfig {
            root: dir.path().to_path_buf(),
            role: Role::Shelf,
            relay_mode: RelayMode::Disabled,
            discovery: Discovery::NONE,
            bind_port: None,
            sink: null_sink(),
            confirm_timeout: Duration::from_secs(1),
        };
        let first = Node::start(config()).await.unwrap();
        let id = first.id();
        first.close().await;
        let second = Node::start(config()).await.unwrap();
        assert_eq!(second.id(), id);
        assert_eq!(
            second.id().to_string(),
            identity::load_or_create(dir.path())
                .unwrap()
                .public()
                .to_string()
        );
        second.close().await;
    }

    #[tokio::test]
    async fn peers_survive_a_restart_and_forget_removes() {
        let dir = ScratchDir::new("node-peers");
        let other = TestNode::start("node-peers-other", Role::Satchel).await;
        let config = || NodeConfig {
            root: dir.path().to_path_buf(),
            role: Role::Shelf,
            relay_mode: RelayMode::Disabled,
            discovery: Discovery::NONE,
            bind_port: None,
            sink: null_sink(),
            confirm_timeout: Duration::from_secs(1),
        };
        let node = Node::start(config()).await.unwrap();
        node.peers()
            .insert(PeerRecord {
                id: other.id(),
                name: "phone".into(),
                platform: "ios".into(),
                role: Role::Satchel,
                grants: vec!["sync:*".into()],
                paired_at: 1,
                last_seen_at: 1,
                last_addrs: vec![],
            })
            .unwrap();
        assert!(node.has_grant(&other.id(), "sync:pull"));
        node.set_grants(&other.id(), vec!["blob:*".into()]).unwrap();
        assert!(!node.has_grant(&other.id(), "sync:pull"));
        assert!(node.has_grant(&other.id(), "blob:read"));
        node.close().await;

        let again = Node::start(config()).await.unwrap();
        assert_eq!(again.list_peers().len(), 1);
        again.forget_peer(&other.id()).unwrap();
        assert!(again.list_peers().is_empty());
        assert_eq!(
            again.forget_peer(&other.id()).unwrap_err().kind(),
            "peerUnknown"
        );
        assert_eq!(
            again.forget_peer("not-an-id").unwrap_err().kind(),
            "invalidPeerId"
        );
        again.close().await;
        other.close().await;
    }
}
