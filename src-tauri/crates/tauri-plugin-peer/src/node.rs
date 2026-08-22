//! The one peer node this process runs: the endpoint keyed by the device
//! identity, the peer store, and the pairing / session / transfer state the
//! protocol modules hang off. Everything Tauri-facing is a thin command over
//! a method here, and everything here is testable with two nodes in one
//! process (`RelayMode::Disabled`, no discovery, scratch data roots).

use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use iroh::endpoint::{presets, Connection, VarInt};
use iroh::{Endpoint, EndpointId, RelayMode};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use crate::blobs::{Transfers, MAX_BLOB_STREAMS};
use crate::error::{Error, Result};
use crate::events::{EventSink, PeerEvent};
use crate::identity;
use crate::pairing::{self, PairingState, PAIR_ALPN};
use crate::peers::{PeerRecord, PeerStore};
use crate::role::Role;
use crate::session::{self, Sessions, PEER_ALPN};

/// How the node finds peers beyond the address hints it already has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Discovery {
    /// n0's DNS address lookup (publish and resolve). The app default; off
    /// for "Local network only" and in tests.
    pub n0_dns: bool,
    /// LAN mDNS (`iroh-mdns-address-lookup`). Desktop, and best-effort on
    /// Android; not on iOS, where raw multicast needs an entitlement
    /// (plan III.2.7).
    pub mdns: bool,
}

impl Discovery {
    pub const NONE: Discovery = Discovery {
        n0_dns: false,
        mdns: false,
    };
}

/// THE UDP PORT THE APP'S ENDPOINT BINDS, and the reason it is fixed at all.
///
/// iroh binds an ephemeral port by default, so the port changes on every
/// launch. That is invisible while address discovery works — a peer re-learns
/// the address through mDNS or n0's DNS every time. It is fatal when discovery
/// does NOT work, because the only thing left is the address hints stored at
/// the last successful session, and those carry the OLD port.
///
/// Measured on two Macs behind a TUN proxy (2026-08-22): the satchel was bound
/// to 54370 while the shelf still had 56827 recorded for it, from two days
/// earlier. Every direct dial went to a dead port, hole punching could not run
/// because the proxy's varying egress makes the mapping look endpoint-
/// dependent to QUIC Address Discovery, and the two machines — on ONE LAN —
/// had not held a session for thirty-nine hours.
///
/// A fixed port makes a stored LAN address stay TRUE across restarts, which is
/// what lets two machines on the same network reach each other with no
/// discovery, no relay and no hole punching at all. It is also what most
/// peer-to-peer software on a desktop already does.
///
/// Not registered with IANA and not meant to be: high in the dynamic range,
/// clear of this repository's other pinned port (31415, the MCP bridge).
pub const APP_BIND_PORT: u16 = 47821;

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
const BLOB_IDLE_TIMEOUT_MS: u64 = 60_000;

pub struct Node {
    root: PathBuf,
    role: Role,
    endpoint: Endpoint,
    peers: Mutex<PeerStore>,
    pub(crate) pairing: PairingState,
    pub(crate) sessions: Sessions,
    pub(crate) transfers: Transfers,
    /// Caps concurrent blob-serve tasks so a peer cannot open unbounded streams.
    pub(crate) blob_serve_limit: Arc<Semaphore>,
    /// Idle deadline (ms) for a blob body transfer.
    blob_idle_timeout_ms: AtomicU64,
    ready: AtomicBool,
    sink: EventSink,
    pub(crate) confirm_timeout: Duration,
    accept_task: Mutex<Option<JoinHandle<()>>>,
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

        // Rebuilt rather than cloned because `bind()` consumes the builder, and
        // the fixed port needs a second attempt when it is already taken.
        // Captured by value so the closure stays `Fn` and can run twice; the
        // fallback below is the second call.
        let relay_mode = config.relay_mode.clone();
        let n0_dns = config.discovery.n0_dns;
        let build = |port: Option<u16>| {
            let mut builder = if n0_dns {
                Endpoint::builder(presets::N0)
            } else {
                Endpoint::builder(presets::Minimal)
            };
            builder = builder
                .secret_key(secret.clone())
                .alpns(vec![PAIR_ALPN.to_vec(), PEER_ALPN.to_vec()])
                .relay_mode(relay_mode.clone());
            match port {
                // v4 only: `bind_addr` replaces the unspecified bind for THAT
                // family, so v6 keeps its ephemeral one and a machine with no
                // IPv4 is not left without an endpoint.
                Some(port) => builder
                    .bind_addr(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))
                    // Unreachable for a literal `0.0.0.0:PORT`, and mapped
                    // rather than unwrapped anyway: a panic here would take
                    // the whole app down for a bind address it chose itself.
                    .map_err(|err| {
                        Error::Io(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            format!("peer: bad bind address: {err}"),
                        ))
                    }),
                None => Ok(builder),
            }
        };

        // FALLS BACK RATHER THAN FAILING. A fixed port is a large gain and a
        // small risk — a second Paper on this machine, or a socket the kernel
        // has not released — and an app with no peer transport at all is a
        // worse outcome than one whose stored addresses go stale again. The
        // warning is the signal; silence here would hide a permanently
        // undiscoverable node behind a working-looking app.
        let endpoint = match config.bind_port {
            Some(port) => match build(Some(port))?.bind().await {
                Ok(endpoint) => endpoint,
                Err(err) => {
                    log::warn!(
                        "peer: UDP port {port} unavailable ({err}); falling back to an ephemeral port, \
                         so a peer that cannot reach discovery will not find this node"
                    );
                    build(None)?.bind().await?
                }
            },
            None => build(None)?.bind().await?,
        };
        if config.discovery.mdns {
            // Added after the bind, not through the builder, so a network
            // that refuses multicast (Android without a MulticastLock,
            // plan III.2.7) costs LAN discovery and nothing else — never
            // the endpoint.
            match iroh_mdns_address_lookup::MdnsAddressLookup::builder().build(endpoint.id()) {
                Ok(mdns) => match endpoint.address_lookup() {
                    Ok(services) => {
                        services.add(mdns);
                        log::info!("peer: mDNS address lookup registered");
                    }
                    // NOT SWALLOWED. This arm used to be an `if let Ok(..)`
                    // with no else, so an endpoint that refused its address
                    // lookup lost LAN discovery in total silence — the app
                    // looked healthy, published nothing, and was findable
                    // only through a relay. A LAN with no iroh service on it
                    // is exactly what that looks like from outside.
                    Err(err) => {
                        log::warn!("peer: address lookup unavailable, no LAN discovery: {err}")
                    }
                },
                Err(err) => log::warn!("mDNS address lookup unavailable: {err}"),
            }
        }

        // WHAT THIS ENDPOINT BELIEVES ABOUT ITSELF, once discovery has had a
        // moment to run. The addresses here are what a pairing URL carries and
        // what mDNS publishes, so an empty list is the difference between a
        // peer that can be reached and one that cannot — and it is invisible
        // from every other signal the app produces.
        {
            let endpoint = endpoint.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let addr = endpoint.addr();
                let ips: Vec<String> = addr.ip_addrs().map(|a| a.to_string()).collect();
                let relays: Vec<String> = addr.relay_urls().map(|r| r.to_string()).collect();
                if ips.is_empty() {
                    log::warn!(
                        "peer: endpoint reports NO direct addresses; pairing URLs and mDNS will carry none (relays: {relays:?})"
                    );
                } else {
                    log::info!("peer: direct addresses {ips:?} relays {relays:?}");
                }
            });
        }

        let node = Arc::new(Node {
            root: config.root,
            role: config.role,
            endpoint: endpoint.clone(),
            peers: Mutex::new(peers),
            pairing: PairingState::default(),
            sessions: Sessions::default(),
            transfers: Transfers::default(),
            blob_serve_limit: Arc::new(Semaphore::new(MAX_BLOB_STREAMS)),
            blob_idle_timeout_ms: AtomicU64::new(BLOB_IDLE_TIMEOUT_MS),
            ready: AtomicBool::new(false),
            sink: config.sink,
            confirm_timeout: config.confirm_timeout,
            accept_task: Mutex::new(None),
            #[cfg(test)]
            admit_hook: Mutex::new(None),
            #[cfg(test)]
            serve_body_gate: Mutex::new(None),
        });
        let task = tokio::spawn(accept_loop(Arc::downgrade(&node), endpoint));
        *node.accept_task.lock().expect("accept task lock") = Some(task);
        Ok(node)
    }

    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
    }

    pub fn role(&self) -> Role {
        self.role
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
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
            let Ok(accepting) = incoming.accept() else {
                return;
            };
            let Ok(conn) = accepting.await else {
                return;
            };
            dispatch(node, conn).await;
        });
    }
}

async fn dispatch(node: Arc<Node>, conn: Connection) {
    match conn.alpn() {
        alpn if alpn == PAIR_ALPN => pairing::serve(node, conn).await,
        alpn if alpn == PEER_ALPN => session::serve(node, conn).await,
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
