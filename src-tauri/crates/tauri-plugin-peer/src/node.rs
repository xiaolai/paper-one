//! The one peer node this process runs: the endpoint keyed by the device
//! identity, the peer store, and the pairing / session / transfer state the
//! protocol modules hang off. Everything Tauri-facing is a thin command over
//! a method here, and everything here is testable with two nodes in one
//! process (`RelayMode::Disabled`, no discovery, scratch data roots).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use iroh::endpoint::{presets, Connection, VarInt};
use iroh::{Endpoint, EndpointId, RelayMode};
use tokio::task::JoinHandle;

use crate::blobs::Transfers;
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

pub struct NodeConfig {
    pub root: PathBuf,
    pub role: Role,
    pub relay_mode: RelayMode,
    pub discovery: Discovery,
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
            sink,
            confirm_timeout: pairing::CONFIRM_TIMEOUT,
        }
    }
}

pub struct Node {
    root: PathBuf,
    role: Role,
    endpoint: Endpoint,
    peers: Mutex<PeerStore>,
    pub(crate) pairing: PairingState,
    pub(crate) sessions: Sessions,
    pub(crate) transfers: Transfers,
    ready: AtomicBool,
    sink: EventSink,
    pub(crate) confirm_timeout: Duration,
    accept_task: Mutex<Option<JoinHandle<()>>>,
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

        let mut builder = if config.discovery.n0_dns {
            Endpoint::builder(presets::N0)
        } else {
            Endpoint::builder(presets::Minimal)
        };
        builder = builder
            .secret_key(secret)
            .alpns(vec![PAIR_ALPN.to_vec(), PEER_ALPN.to_vec()])
            .relay_mode(config.relay_mode);
        let endpoint = builder.bind().await?;
        if config.discovery.mdns {
            // Added after the bind, not through the builder, so a network
            // that refuses multicast (Android without a MulticastLock,
            // plan III.2.7) costs LAN discovery and nothing else — never
            // the endpoint.
            match iroh_mdns_address_lookup::MdnsAddressLookup::builder().build(endpoint.id()) {
                Ok(mdns) => {
                    if let Ok(services) = endpoint.address_lookup() {
                        services.add(mdns);
                    }
                }
                Err(err) => log::warn!("mDNS address lookup unavailable: {err}"),
            }
        }

        let node = Arc::new(Node {
            root: config.root,
            role: config.role,
            endpoint: endpoint.clone(),
            peers: Mutex::new(peers),
            pairing: PairingState::default(),
            sessions: Sessions::default(),
            transfers: Transfers::default(),
            ready: AtomicBool::new(false),
            sink: config.sink,
            confirm_timeout: config.confirm_timeout,
            accept_task: Mutex::new(None),
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

        /// The next event, within two seconds.
        pub async fn next_event(&mut self) -> PeerEvent {
            tokio::time::timeout(Duration::from_secs(2), self.events.recv())
                .await
                .expect("an event within 2s")
                .expect("event channel open")
        }

        /// The next event of a kind, skipping others, within two seconds.
        pub async fn next_event_where(&mut self, pred: impl Fn(&PeerEvent) -> bool) -> PeerEvent {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let event = self.events.recv().await.expect("event channel open");
                    if pred(&event) {
                        return event;
                    }
                }
            })
            .await
            .expect("a matching event within 2s")
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
