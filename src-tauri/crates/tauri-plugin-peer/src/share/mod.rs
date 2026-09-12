//! The SHARE endpoint — content-addressed, announced, and nothing to do with
//! the circle. Phase 25.
//!
//! ```text
//!   share.key ──▶ :47822  content-addressed   iroh-blobs + paper/share-notes
//!   identity.key ▶ :47821 identity-addressed  pair + peer + circle-hello
//! ```
//!
//! ⚠️ **THE TWO ENDPOINTS SHARE A PROCESS AND NOTHING ELSE.** Two keys, two
//! ports, two ALPN sets, two limiters. What the split buys: the circle key
//! never enters a public content index, and a stranger who fetches a book
//! cannot attempt circle protocols against the key that served it.
//!
//! ⚠️ **WHAT IT DOES NOT BUY, STATED SO NOBODY RELIES ON IT: ANONYMITY.** Both
//! endpoints resolve to the same addresses, so IP-level correlation of "same
//! machine" is trivial, and both are advertised on the LAN today (WI-25.8,
//! `endpoint.rs`). The split is a protocol boundary, not a privacy one.
//!
//! ## Nothing here starts because the app started
//!
//! The endpoint binds with the node (it must, to have a stable identity), but
//! no book is in the store, no topic is announced and no DHT socket is opened
//! until a reader turns a book on. `SharePolicy` is default-off per book and
//! per service, and it is asked again on **every request** — not at the index,
//! and not when the connection opened.

#[cfg(test)]
mod acceptance;
pub mod bounds;
pub mod dht;
pub mod index;
pub mod notes;
pub mod policy;
pub mod topic;
pub mod voice;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode};
use iroh_blobs::provider::events::{
    AbortReason, ConnectMode, EventMask, EventSender, ObserveMode, ProviderMessage, RequestMode,
    ThrottleMode,
};
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::{BlobsProtocol, Hash};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::endpoint::{self, Advertised, Discovery, EndpointConfig, SHARE_BIND_PORT};
use crate::error::{Error, Result};
use crate::identity;
use crate::paths::{Access, BlobTarget};
use crate::share::bounds::{ShareBounds, ShareLimits};
use crate::share::dht::{Announcer, Found};
use crate::share::notes::NOTES_ALPN;
use crate::share::policy::{share_dir, SharePolicy, ShareService};

/// The tag under which an OFFERED book is pinned in the blob store.
///
/// ⚠️ **DETERMINISTIC, SO RE-OFFERING REPLACES RATHER THAN ACCUMULATES**, and
/// so `withdraw` has a name to delete. An automatically named tag was taken per
/// import, which meant one more permanent tag every time a reader turned a book
/// off and on again, and nothing that could ever remove them.
fn offer_tag(hash: &ContentHash) -> String {
    format!("paper:offer:{hash}")
}

/// A book's network name — BLAKE3 of the whole content file, 64 lower-case
/// hex digits. The parser and the rest of its contract are in [`topic`].
///
/// ⚠️ **NO NEW IDENTIFIER — WI-25.2.** This is `contentHash`, which
/// `bookFolder.ts` already computes in Rust, already backfills off the open
/// path, and whose docstring already states the conflict rule this phase
/// needs: *"two devices holding bytes for one `bookId` with two different
/// hashes is a conflict, never a merge"*. `contentId` is untouched and keeps
/// its sampling and its keying of marks, cards and positions.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ContentHash(String);

impl ContentHash {
    /// The name of a blob this build already holds as a typed hash.
    ///
    /// ⚠️ **INFALLIBLE, BECAUSE THE CONVERSION IS.** `iroh_blobs::Hash` is 32
    /// bytes and formats as 64 lower-case hex digits — exactly the shape
    /// [`ContentHash::parse`] accepts — so a caller that went through `parse`
    /// carried an error branch nothing could reach. Parsing belongs on the
    /// boundary where a STRANGER's string arrives, not between two of this
    /// crate's own types.
    pub fn from_blob(hash: &Hash) -> Self {
        ContentHash(hash.to_hex().to_string())
    }
}

impl std::fmt::Display for ContentHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// How the share endpoint is started.
pub struct ShareConfig {
    pub root: PathBuf,
    pub relay_mode: RelayMode,
    pub discovery: Discovery,
    /// `None` for an ephemeral port — right for tests, wrong for the app.
    pub bind_port: Option<u16>,
    pub limits: ShareLimits,
    /// Whether announcing and resolving may touch the global DHT.
    ///
    /// ⚠️ **OFF IN TESTS, AND THE REASON IS NOT TIDINESS.** A test that
    /// announced would put the developer's address into a public index on
    /// every `cargo test`, permanently, against a book they may not have.
    /// `dht.rs`'s own tests use `mainline::Testnet` on loopback instead.
    pub dht: bool,
}

/// The environment variable a harness sets to run without announcing.
///
/// ⚠️ **THIS EXISTS BECAUSE THE PUBLIC LAYER COULD NOT BE DRIVEN AT ALL.**
/// Every row of the ledger's public section was evidenced by tests in one
/// process, and the reason was not only an absent harness: `for_app` hardcoded
/// `dht: true`, so the first thing any end-to-end run would do is announce a
/// real machine against a real book into a global, permanently queryable
/// index. This repository forbids its own tests from touching the real DHT —
/// a whole section of `AGENTS.md` says so — and gave a harness no way to obey
/// the same rule. Added 2026-09-11, as the first work item of
/// `public-scenario.sh` rather than as a convenience.
#[cfg(any(debug_assertions, test))]
pub const NO_DHT_ENV: &str = "PAPER_TEST_NO_DHT";

/// Whether this process may announce, given the environment.
///
/// PURE AND TOTAL, so it can be measured without setting a process-wide
/// variable in a threaded test runner.
///
/// ⚠️ **ABSENT MEANS ON, WHICH IS THE SHIPPED BEHAVIOUR AND THE UNSAFE
/// DIRECTION FOR A HARNESS.** A misspelled variable therefore announces. That
/// is deliberate — the default must be what a reader gets — and it is exactly
/// why `ShareNode::start` LOGS the resolved state instead of trusting it:
/// `public-scenario.sh` refuses to press Offer until it has read `dht=off` out
/// of `Paper.log` on that machine. A flag nobody can read back is a flag that
/// is assumed, and the thing being assumed here cannot be undone.
#[cfg(any(debug_assertions, test))]
pub fn dht_wanted(asked_off: Option<&std::ffi::OsStr>) -> bool {
    asked_off.is_none()
}

#[cfg(debug_assertions)]
fn dht_for_app() -> bool {
    dht_wanted(std::env::var_os(NO_DHT_ENV).as_deref())
}

/// ⚠️ **COMPILED OUT OF RELEASE**, on `paper-data-root`'s precedent: a shipped
/// build must not be steerable by the environment it happens to start in.
#[cfg(not(debug_assertions))]
fn dht_for_app() -> bool {
    true
}

impl ShareConfig {
    pub fn for_app(root: PathBuf) -> Self {
        Self {
            root,
            relay_mode: RelayMode::Default,
            discovery: Discovery {
                n0_dns: true,
                mdns: cfg!(not(target_os = "ios")),
            },
            bind_port: Some(SHARE_BIND_PORT),
            limits: ShareLimits::default(),
            dht: dht_for_app(),
        }
    }
}

/// The share endpoint, its store, and what it will serve.
pub struct ShareNode {
    root: PathBuf,
    endpoint: Endpoint,
    advertised: Advertised,
    policy: Arc<SharePolicy>,
    bounds: ShareBounds,
    store: FsStore,
    router: Router,
    /// The DHT, joined lazily — see [`ShareConfig::dht`] and `dht.rs`.
    ///
    /// ⚠️ **ONLY SUCCESS IS CACHED, AND IT USED TO CACHE FAILURE TOO.** This
    /// was a `OnceCell<Option<Announcer>>` filled by `get_or_init`, so ONE
    /// failed `Announcer::join` — a laptop launched on no network, a UDP port
    /// momentarily taken — stored `None` for the life of the process. Every
    /// later publication, lookup and renewal then answered "public discovery is
    /// off on this device" against a machine whose network had been back for
    /// hours, with a single warning at launch as the only trace. Found by
    /// audit. A `Mutex` holding the joined handle retries instead; `Announcer`
    /// is `Clone` because mainline's `Dht` is a handle, so callers take a copy
    /// rather than borrowing across the guard.
    announcer: tokio::sync::Mutex<Option<Announcer>>,
    dht_enabled: bool,
    /// The loop that authorizes every blob request. Aborted on close.
    gate: std::sync::Mutex<Option<JoinHandle<()>>>,
    /// Re-announces what is still offered, so a listing does not age out.
    /// Aborted on close.
    renewal: std::sync::Mutex<Option<JoinHandle<()>>>,
    /// Which destinations have a fetch running — see [`ShareNode::fetch_book`].
    fetching: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
}

/// A claimed fetch destination that releases itself.
///
/// ⚠️ **`Drop`, NOT A STATEMENT AFTER THE AWAIT.** `blobs.rs` records why in as
/// many words: a release written as a plain line after the transfer future is
/// skipped by an abort or a panic, and the target then answers "busy" for the
/// rest of the process's life. Every early return in `fetch_book` is one of
/// those paths, and there are five.
struct Fetching<'a> {
    node: &'a ShareNode,
    target: PathBuf,
}

impl Drop for Fetching<'_> {
    fn drop(&mut self) {
        self.node
            .fetching
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .remove(&self.target);
    }
}

/// How often a still-offered book is announced again.
///
/// ⚠️ **PUBLICATION WAS ONE-SHOT AND NOTHING RENEWED IT.** Found by audit: a
/// DHT record ages out, `announce_peer` entries expire on the network's own
/// schedule, and a failed announce was logged and forgotten — so an enabled,
/// running provider could become undiscoverable indefinitely while every
/// surface said it was published. `announce` skips a record it is already in,
/// which made the gap invisible from this side too.
///
/// Six hours: far under any DHT's expiry and far over anything that makes this
/// machine a source of DHT traffic.
const RENEW_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// How long ONE provider has to deliver a book before the next is tried.
///
/// ⚠️ **A DEADLINE PER PROVIDER, NOT PER FETCH.** A provider that connects and
/// then stalls is indistinguishable from a slow one until the clock says so,
/// and without this it held every later candidate hostage. Ten minutes is far
/// past a large book on a poor connection and far under a reader's patience
/// for a download that is not moving.
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(10 * 60);

impl std::fmt::Debug for ShareNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShareNode")
            .field("id", &self.endpoint.id())
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl ShareNode {
    /// Bind the share endpoint, open the store, and start answering.
    pub async fn start(config: ShareConfig) -> Result<Arc<ShareNode>> {
        /* ⚠️ **SAID OUT LOUD, BECAUSE THE HARNESS ASSERTS ON IT.** An announce
         * cannot be undone, so "we meant to turn it off" is not a thing a run
         * may assume. `public-scenario.sh` greps this line and refuses to press
         * Offer without it. Logged before anything binds, so a run that dies
         * during startup still says which way it was going. */
        log::info!(
            "peer: share endpoint dht={}",
            if config.dht { "on" } else { "off" }
        );
        let secret = identity::load_or_create_named(&config.root, identity::EndpointKey::Share)?;
        let policy = Arc::new(SharePolicy::load_or_refuse_all(&config.root));
        let bounds = ShareBounds::new(config.limits);

        let blobs_dir = share_dir(&config.root).join("blobs");
        std::fs::create_dir_all(&blobs_dir)?;
        let store = FsStore::load(&blobs_dir).await.map_err(|err| {
            Error::ShareRefused(format!("the public blob store would not open: {err}"))
        })?;

        /* ⚠️ **`Intercept`, NOT `Notify` — WI-25.5.** `Notify` tells us a
         * request happened; `Intercept` decides whether it may. The difference
         * is the whole work item: a public content address is not
         * authorization, so the answer has to be able to be no, per request,
         * on a connection that was already open.
         *
         * `push` stays `Disabled`: nothing may write into this machine's
         * public store from the network. That is not a bound to be tuned; a
         * writable public store is a free file host wearing a reader's name. */
        let (events, messages) = EventSender::channel(
            32,
            EventMask {
                /* ⚠️ **`connected` AND `throttle` ARE NOT DEFAULTS AND LEAVING
                 * THEM AS DEFAULTS COSTS THE WHOLE OF WI-25.6.** `EventMask::
                 * DEFAULT` is `ConnectMode::None` and `ThrottleMode::None`, so
                 * the connection arm and the byte arm of `authorize` below are
                 * never reached at all — and a limiter nothing calls looks
                 * exactly like a limiter nothing has exceeded.
                 *
                 * MEASURED: with these two left at their defaults, a whole
                 * book was served and `bounds.charged_bytes()` was still zero.
                 * `a_fresh_key_buys_no_fresh_allowance` is the assertion that
                 * caught it and the one that keeps it caught. */
                connected: ConnectMode::Intercept,
                throttle: ThrottleMode::Intercept,
                get: RequestMode::Intercept,
                get_many: RequestMode::Intercept,
                push: RequestMode::Disabled,
                observe: ObserveMode::Intercept,
            },
        );
        let gate = tokio::spawn(authorize(Arc::clone(&policy), bounds.clone(), messages));

        let endpoint::Bound {
            endpoint,
            advertised,
        } = endpoint::bind(EndpointConfig {
            secret,
            /* TWO DOORS, and neither is the circle's. `iroh_blobs::ALPN`
            carries the bytes; `NOTES_ALPN` carries public annotations. A
            request arriving here for `PAIR_ALPN`, `PEER_ALPN` or
            `CIRCLE_HELLO_ALPN` is not routed — the router answers only what
            it was given, which is what makes "each endpoint refuses the
            other's protocols" structural. */
            alpns: vec![iroh_blobs::ALPN.to_vec(), NOTES_ALPN.to_vec()],
            bind_port: config.bind_port,
            relay_mode: config.relay_mode,
            discovery: config.discovery,
            label: "share",
        })
        .await?;

        let router = Router::builder(endpoint.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&store, Some(events)))
            .accept(
                NOTES_ALPN,
                NotesProtocol {
                    root: config.root.clone(),
                    policy: Arc::clone(&policy),
                    bounds: bounds.clone(),
                },
            )
            .spawn();

        let node = Arc::new(ShareNode {
            root: config.root,
            endpoint,
            advertised,
            policy,
            bounds,
            store,
            router,
            announcer: tokio::sync::Mutex::new(None),
            dht_enabled: config.dht,
            gate: std::sync::Mutex::new(Some(gate)),
            renewal: std::sync::Mutex::new(None),
            fetching: std::sync::Mutex::new(std::collections::HashSet::new()),
        });
        /* ⚠️ **WEAK, SO THE RENEWAL CANNOT KEEP THE ENDPOINT ALIVE.** It sleeps
         * for hours at a time; an `Arc` held across that sleep is a share
         * endpoint that stays bound after the app closes and a next launch
         * that cannot take 47822 — the trap `Node`'s keeper carries verbatim,
         * one port over. */
        let renewal = tokio::spawn(renew(Arc::downgrade(&node)));
        *node.renewal.lock().expect("renewal lock") = Some(renewal);
        Ok(node)
    }

    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    pub fn advertised(&self) -> &Advertised {
        &self.advertised
    }

    pub fn policy(&self) -> &SharePolicy {
        &self.policy
    }

    pub fn bounds(&self) -> &ShareBounds {
        &self.bounds
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Offer a book's BYTES: import the file, then turn the switch on.
    ///
    /// ⚠️ **THE FILE'S OWN DIGEST DECIDES ITS NAME — WI-25.2 AND WI-25.4.**
    /// The caller states a `contentHash`; iroh-blobs hashes the file and
    /// answers with what it actually is. A disagreement is a refusal, never a
    /// rename: offering bytes under a hash they do not have is how a reader
    /// who asked for one book gets another, and the whole verified-transfer
    /// story downstream rests on the name being true.
    pub async fn offer_bytes(&self, folder: &str, name: &str, claimed: &ContentHash) -> Result<()> {
        let target = BlobTarget::resolve(&self.root, folder, name, Access::Read)?;
        target.checked_read(&self.root)?;
        /* ⚠️ **A TEMPORARY TAG WHILE THE IMPORT IS UNPROVEN, AND IT USED TO BE
         * A PERMANENT ONE.** Awaiting the import took an automatically NAMED
         * tag, which persists — so every re-offer of a book left another one
         * behind, and an import whose hash disagreed with the record, or whose
         * policy write then failed, left a permanently tagged blob nothing
         * would ever collect. A temp tag is released when it drops, which is
         * exactly the lifetime an unvalidated import should have. */
        let temp = self
            .store
            .blobs()
            .add_path_with_opts(iroh_blobs::api::blobs::AddPathOptions {
                path: target.path().to_path_buf(),
                /* `TryReference`, so a library is not stored twice. The store
                 * documents that a referenced file must not change afterwards;
                 * a book's content file never does — `bookVault` writes it
                 * once and replaces the folder rather than the file. */
                mode: iroh_blobs::api::blobs::ImportMode::TryReference,
                format: iroh_blobs::BlobFormat::Raw,
            })
            .temp_tag()
            .await
            .map_err(|err| Error::ShareRefused(format!("the book would not import: {err}")))?;
        let imported = temp.hash();
        if imported.to_hex() != claimed.0 {
            /* The temp tag drops with this return, so the unproven import is
             * collectable rather than pinned under a name for ever. */
            return Err(Error::ShareRefused(format!(
                "these bytes hash to {} and the record says {claimed}",
                imported.to_hex()
            )));
        }
        /* ⚠️ **THE POLICY WRITE GOES OFF THE RUNTIME'S WORKERS.** It serialises,
         * writes and `sync_all`s, and these workers are shared with the
         * CIRCLE's sessions — the same reason `answer` moves its read. */
        let policy = Arc::clone(&self.policy);
        let hash = claimed.clone();
        crate::commands::off_thread(move || policy.set(&hash, ShareService::Bytes, true)).await?;
        /* ⚠️ **ONE DETERMINISTIC TAG PER OFFERED BOOK, TAKEN ONLY ONCE THE
         * OFFER IS REAL.** Named for the hash, so re-offering replaces its own
         * tag rather than adding another, and `withdraw` has a name to delete. */
        self.store
            .tags()
            .set(offer_tag(claimed), imported)
            .await
            .map_err(|err| {
                Error::ShareRefused(format!("the offer could not be recorded: {err}"))
            })?;
        drop(temp);
        self.announce(claimed, ShareService::Bytes).await;
        Ok(())
    }

    /// Offer a book's public ANNOTATIONS, without offering the book.
    ///
    /// ⚠️ **NO BYTES ARE IMPORTED HERE, AND THAT IS WI-25.9.** A reader may
    /// publish notes on a book they have no right to redistribute; that is the
    /// common case, not the exception.
    pub async fn offer_notes(&self, hash: &ContentHash) -> Result<()> {
        /* Off the runtime's workers — see `offer_bytes`. */
        let policy = Arc::clone(&self.policy);
        let named = hash.clone();
        crate::commands::off_thread(move || policy.set(&named, ShareService::Notes, true)).await?;
        self.announce(hash, ShareService::Notes).await;
        Ok(())
    }

    /// Stop offering one book over one service.
    ///
    /// ⚠️ **THE SWITCH GOES FIRST AND THE DHT SECOND.** The switch is what
    /// refuses the request already in flight; the DHT rewrite is a courtesy
    /// that may fail, may be slow, and cannot be undone for anyone who already
    /// read the record. Ordering them the other way would leave a window in
    /// which the reader had been told it was off and it was not.
    pub async fn withdraw(&self, hash: &ContentHash, service: ShareService) -> Result<()> {
        /* Off the runtime's workers for the reason `offer_bytes` records: this
         * serialises, writes and `sync_all`s on threads the circle shares. */
        let policy = Arc::clone(&self.policy);
        let named = hash.clone();
        crate::commands::off_thread(move || policy.set(&named, service, false)).await?;
        if service == ShareService::Notes {
            let root = self.root.clone();
            let named = hash.clone();
            crate::commands::off_thread(move || notes::forget(&root, &named)).await?;
        }
        if service == ShareService::Bytes {
            /* ⚠️ **THE PIN GOES WITH THE OFFER.** `offer_bytes` tags the blob so
             * it survives collection while it is offered; leaving that tag
             * behind means a withdrawn book stays pinned in the public store for
             * ever, which is the opposite of what the reader asked for. A tag
             * that is not there is the ordinary case — notes-only books never
             * had one — so absence is not a failure. */
            if let Err(err) = self.store.tags().delete(offer_tag(hash)).await {
                log::warn!("peer: the offer tag for {hash} could not be removed: {err}");
            }
        }
        if let Some(dht) = self.dht().await {
            if let Err(err) = dht.withdraw(hash, service, self.id()).await {
                log::info!(
                    "peer: could not withdraw {hash} ({}) from the index: {err}",
                    service.as_str()
                );
            }
        }
        Ok(())
    }

    /// Fetch a book by its hash and write it into the library.
    ///
    /// ⚠️ **THE DESTINATION IS THE CALLER'S DECISION AND IT IS NOT A DETAIL.**
    /// `mayAdoptIdentity` in `publicShare.ts` decides whether these bytes may
    /// become a book already held or must be a new one, and it decides that
    /// BEFORE this is called — because the answer is which folder to pass. A
    /// version of this that picked the folder itself would have to make that
    /// judgement with no library to consult, which is how a downloaded file
    /// takes an annotated book's anchors.
    ///
    /// ⚠️ **AND THE HASH IS CHECKED AGAIN AFTER THE EXPORT.** The transfer
    /// verifies per chunk against the hash it asked for, which says the
    /// providers were honest. It says nothing about the file that ended up on
    /// disk — an export can be interrupted, a disk can be full, and a `.part`
    /// left behind is exactly the state `blobs.rs`'s sweep exists for. Cheap,
    /// once, at the end.
    pub async fn fetch_book(
        &self,
        hash: &ContentHash,
        providers: &[EndpointAddr],
        folder: &str,
        name: &str,
    ) -> Result<u64> {
        let target = BlobTarget::resolve(&self.root, folder, name, Access::Write)?;

        /* ⚠️ **THE DESTINATION IS CLAIMED FOR THE WHOLE FETCH, AND IT USED TO
         * BE CLAIMED ONLY FOR THE EXPORT.** The claim lived in
         * `export_verified`, which runs at the END of both paths below — so
         * whether a second fetch into the same destination was refused
         * depended on whether it reached that window before the first left it.
         * The two paths make the window wildly uneven: a book already in the
         * store skips the transfer entirely and arrives almost at once, while
         * a transferring fetch takes as long as the network does.
         *
         * The result was a test that failed about one run in ten with two
         * successes over one destination — the exact outcome
         * `two_fetches_into_one_destination_do_not_share_a_staging_file` exists
         * to forbid. Measured 2026-09-11: 2 failures in 17 runs.
         *
         * Claimed here, mutual exclusion covers entry to completion, so the
         * second fetch is refused deterministically rather than according to
         * how fast the first one finished. `export_verified` no longer claims;
         * it is private and both of its call sites are below this line. */
        let staging = target.part_path();
        let claimed = {
            let mut running = self
                .fetching
                .lock()
                .unwrap_or_else(|held| held.into_inner());
            running.insert(staging.clone())
        };
        if !claimed {
            return Err(Error::ShareRefused(format!(
                "a fetch into {} is already running",
                staging.display()
            )));
        }
        let _claim = Fetching {
            node: self,
            target: staging,
        };

        let blob = iroh_blobs::Hash::from_bytes(hash.bytes());
        /* ⚠️ **A BOOK THIS DEVICE ALREADY HOLDS NEEDS NOBODY.** Every fetch used
         * to require a provider — discovery, then a connection — before asking
         * whether the bytes were already in the store, so a book fetched once
         * and being written out again was unobtainable offline, and a reader
         * whose export failed on a full disk could not retry without the
         * network. The store's own completeness is the cheapest possible answer
         * and it was the last one asked. Verified on the way out exactly as a
         * transferred book is: `export_verified` re-hashes what lands. */
        if self.store.blobs().has(blob).await.unwrap_or(false) {
            return self.export_verified(&target, blob, hash).await;
        }
        /* Named providers first, then whoever the index knows. A caller that
         * already holds a provider — a friend's answer, a ticket — should not
         * pay for a DHT round trip to be told the same thing.
         *
         * ⚠️ **AND DISCOVERY IS ASKED WHEN THEY ALL FAIL, WHICH IT WAS NOT.**
         * The comment promised "then whoever the index knows" while a non-empty
         * supplied list disabled discovery outright — so a stale ticket, or a
         * friend who has since gone offline, meant the book was unobtainable
         * even though the DHT knew somebody who had it. The fallback runs after
         * the supplied ones are exhausted, not instead of them. */
        let mut candidates: Vec<EndpointAddr> = providers.to_vec();
        let supplied = !candidates.is_empty();
        if candidates.is_empty() {
            candidates = self.discovered(hash).await;
        }
        if candidates.is_empty() {
            return Err(Error::ShareRefused(format!(
                "nobody could be found who serves {hash}"
            )));
        }
        let mut last: Option<String> = None;
        let mut landed = false;
        /* ⚠️ **THE SUPPLIED LIST IS TRIED FIRST AND DISCOVERY FOLLOWS IT.** A
         * non-empty list used to disable discovery outright, so a stale ticket
         * or a friend who had gone offline made the book unobtainable while the
         * index knew somebody who had it — and the comment above said the
         * opposite was happening. Discovery runs only if every supplied
         * provider failed, so the round trip is still not paid for by a caller
         * whose own provider works. */
        /* ⚠️ **CONSUMED FROM THE FRONT, AND `pop()` TOOK IT FROM THE BACK.**
         * A caller's provider list is ORDERED — `receiveNotes` puts a device
         * the reader was told about ahead of whatever the index advertised —
         * and `Vec::pop` reversed exactly that, so the named device was tried
         * LAST and an advertised stranger first. It went unnoticed because the
         * only run that exercised it had the DHT off, which makes the
         * advertised half empty and the two orders identical. Found by an
         * independent audit, 2026-09-11, in BOTH loops: one defect, two sites,
         * fixed together. */
        let mut queue: std::collections::VecDeque<EndpointAddr> = candidates.into_iter().collect();
        let mut asked_discovery = !supplied;
        while let Some(provider) = queue.pop_front() {
            let who = provider.id;
            /* ⚠️ **EVERY PROVIDER IS TRIED, AND A BAD ONE COSTS ONLY ITS OWN
             * ATTEMPT.** WI-25.3's acceptance: a provider serving one bad chunk
             * is rejected WITHOUT discarding the good ones. The store keeps
             * what verified, so the next provider resumes rather than
             * restarting — which is the whole reason the ranges are verified as
             * they land instead of at the end. */
            /* ⚠️ **EACH ATTEMPT IS BOUNDED, AND THEY WERE NOT.** Found by
             * audit: a provider that connected and then kept the transfer
             * stalled prevented every later candidate from being tried at all
             * — one unresponsive machine taking a book off the network for a
             * reader who had four other sources. The store keeps whatever
             * verified before the deadline, so a slow provider still
             * contributes and the next one resumes rather than restarting. */
            let attempt =
                timeout(PROVIDER_TIMEOUT, async {
                    /* Through the one door, so the DIAL is bounded separately
                    from the transfer. `PROVIDER_TIMEOUT` is ten minutes
                    because a book is large; thirty seconds of it is all a
                    machine gets to answer the phone. */
                    let conn = crate::endpoint::dial(
                        &self.endpoint,
                        provider,
                        iroh_blobs::ALPN,
                        crate::endpoint::DIAL_TIMEOUT,
                    )
                    .await
                    .ok_or_else(
                        || -> Box<dyn std::error::Error + Send + Sync> {
                            Box::new(Error::ShareRefused(
                                "that provider did not answer a dial in time".into(),
                            ))
                        },
                    )??;
                    self.store.remote().fetch(conn, blob).await.map_err(
                        |err| -> Box<dyn std::error::Error + Send + Sync> { Box::new(err) },
                    )?;
                    Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
                })
                .await;
            match attempt {
                Ok(Ok(())) => {
                    landed = true;
                    break;
                }
                Ok(Err(err)) => last = Some(format!("{who}: {err}")),
                Err(_) => last = Some(format!("{who}: it did not answer in time")),
            }
            /* Every supplied provider has now failed. Ask the index once. */
            if queue.is_empty() && !asked_discovery {
                asked_discovery = true;
                queue = self.discovered(hash).await.into_iter().collect();
            }
        }
        if !landed {
            return Err(Error::ShareRefused(format!(
                "no provider could serve {hash}{}",
                last.map(|why| format!(" ({why})")).unwrap_or_default()
            )));
        }
        std::fs::create_dir_all(target.folder_dir())?;
        /* ⚠️ **THE CONTAINMENT CHECK RUNS BEFORE ANY BYTE IS WRITTEN, AND IT
         * DID NOT.** `BlobTarget::resolve` is PURE — it validates the folder
         * and the name and touches no filesystem — so a book directory that
         * is a symlink pointed the export straight out of the library. Found
         * by audit. `checked_part` is the same check `blobs.rs` runs before
         * it promotes a `.part` — the containment, plus a refusal of anything
         * planted under either the staging name or the content name — and it
         * is run here for the same reason and against the same two paths. */
        self.export_verified(&target, blob, hash).await
    }

    /// Write a blob this device holds into a book's folder, verified.
    ///
    /// ⚠️ **ONE STAGED EXPORT, SHARED BY THE TRANSFERRED AND THE ALREADY-HELD
    /// PATH.** The cleanup used to be written out three times — after a failed
    /// export, a failed hash and a digest mismatch — and a fourth exit skipped
    /// it entirely. Three copies of "remove the staging file" is three chances
    /// to leave private bytes behind, and it is why the local shortcut above
    /// could not simply reuse this.
    async fn export_verified(
        &self,
        target: &BlobTarget,
        blob: iroh_blobs::Hash,
        hash: &ContentHash,
    ) -> Result<u64> {
        target.checked_part(&self.root)?;
        /* ⚠️ **TWO FETCHES INTO ONE DESTINATION SHARE A `.part` AND DESTROY
         * EACH OTHER.** `part_path` is derived from the folder and the content
         * name, so it is the SAME path for both — and this function removes it
         * before exporting, hashes it, then renames. Interleave two of those
         * and one deletes the other's export, or replaces the file between its
         * hash check and its rename, which is the one window the whole staging
         * dance exists to close. Found by audit.
         *
         * `blobs.rs` already solved this for the circle's downloads
         * (`Transfers::claim`); the share path simply did not use it.
         *
         * ⚠️ **AND IT IS THIS ENDPOINT'S REGISTRY, NOT THE MACHINE'S.** A
         * circle download and a public fetch into one book folder are still not
         * excluded from each other: the two nodes start independently and share
         * no state, so one registry means threading it through both, which is a
         * change to how the plugin is assembled rather than to this function.
         * `planShareImport` narrows the exposure — a fetch reaches an existing
         * folder only when the held record names that exact digest — but does
         * not remove it. */
        /* The destination is already claimed by `fetch_book`, which is this
        function's only caller and takes it before either path — see the
        note there for why it is not taken here. */
        let staging = target.part_path();
        /* ⚠️ **EXPORTED TO A STAGING SIBLING, THEN PROMOTED.** Writing
         * straight to `content.*` means an interrupted export — a full disk, a
         * cancelled fetch, a hash that then disagrees — leaves a truncated
         * file the library treats as a completed book. The `.part` name is the
         * one `blobs::sweep_abandoned_parts` already knows how to clean up at
         * launch, so an abandoned fetch does not accumulate either. */
        let _ = std::fs::remove_file(&staging);
        let exported = self
            .store
            .blobs()
            .export(blob, &staging)
            .await
            .map_err(|err| Error::ShareRefused(format!("the book would not be written: {err}")));
        if let Err(err) = exported {
            let _ = std::fs::remove_file(&staging);
            return Err(err);
        }
        let written = match crate::blobs::hash_path(&staging).await {
            Ok(written) => written,
            Err(err) => {
                let _ = std::fs::remove_file(&staging);
                return Err(err);
            }
        };
        if written.blake3 != hash.as_str() {
            /* The file on disk is not what was asked for. Removed rather than
             * left, and — because it is the staging name — whatever the book
             * folder held before is untouched. */
            let _ = std::fs::remove_file(&staging);
            return Err(Error::ShareRefused(format!(
                "the file written for {hash} hashes to {}",
                written.blake3
            )));
        }
        /* Re-checked immediately before the rename, which NARROWS the
         * check-to-rename window rather than closing it — `BlobTarget`'s own
         * comment says nothing path-based can close it. */
        target.checked_part(&self.root)?;
        std::fs::rename(&staging, target.path())?;
        Ok(written.size)
    }

    /// Providers the index knows for a book's bytes, with the addresses it
    /// announced attached as hints.
    ///
    /// ⚠️ **THE ANNOUNCED ADDRESSES ARE HINTS ON A KNOWN ID, WHICH IS THE ONLY
    /// THING THEY CAN HONESTLY BE.** `Found` says so: an address without an
    /// endpoint id is not a provider, because QUIC pins the remote's key before
    /// the first packet. Attached to an id from the index they are useful — a
    /// direct dial that needs no DNS and no relay — and attached to nothing they
    /// are a list nobody can use.
    ///
    /// Every candidate gets every hint. The addresses are not labelled with
    /// whose they are (`get_peers` returns a set), so a wrong hint costs one
    /// failed path and the right one is in there somewhere. iroh discards a
    /// hint that does not answer.
    ///
    /// Empty when discovery is off or finds nobody — the caller decides what
    /// that means, because it is a fallback on one path and the only source on
    /// the other.
    async fn discovered(&self, hash: &ContentHash) -> Vec<EndpointAddr> {
        let Some(dht) = self.dht().await else {
            return Vec::new();
        };
        let found = dht.resolve(hash, ShareService::Bytes).await;
        let hints: Vec<std::net::SocketAddr> = found
            .addresses
            .iter()
            .map(|a| std::net::SocketAddr::V4(*a))
            .collect();
        found
            .providers
            .into_iter()
            .map(|id| {
                hints
                    .iter()
                    .fold(EndpointAddr::new(id), |addr, hint| addr.with_ip_addr(*hint))
            })
            .collect()
    }

    /// Ask for a book's public annotations — the asking half of
    /// `paper/share-notes/1`.
    ///
    /// ⚠️ **THIS HALF DID NOT EXIST, AND WITHOUT IT PHASE 26 COULD PUBLISH AND
    /// NEVER RECEIVE.** `notes::serve` has answered since the phase landed and
    /// no device ever asked, so the store the reader's overlay reads had no
    /// production writer and an ordinary reader saw nobody else's annotations
    /// at all. Found by audit.
    ///
    /// ⚠️ **THE RECORDS ARE RETURNED UNPARSED, WHICH IS THE POINT.** This
    /// crate does not know what a public envelope is: the signature, the
    /// expiry, the block list and the storage bounds are all the kernel's, and
    /// a plugin that verified them would be a second verifier to keep in step
    /// with the first. What lands here is bytes a stranger sent.
    ///
    /// Providers are tried in order and discovery follows them, exactly as
    /// `fetch_book` does and for the same reason: a caller who holds a working
    /// provider should not pay for a round trip, and a stale one should not
    /// take the book off the network.
    pub async fn fetch_notes(
        &self,
        hash: &ContentHash,
        providers: &[EndpointAddr],
        since: u64,
        generation: Option<u64>,
    ) -> Result<notes::FetchedNotes> {
        let supplied = !providers.is_empty();
        let mut queue: std::collections::VecDeque<EndpointAddr> =
            providers.iter().cloned().collect();
        if queue.is_empty() {
            queue = self.discovered(hash).await.into_iter().collect();
        }
        if queue.is_empty() {
            return Err(Error::ShareRefused(format!(
                "nobody could be found who serves notes for {hash}"
            )));
        }
        /* ⚠️ **CONSUMED FROM THE FRONT, AND `pop()` TOOK IT FROM THE BACK.**
         * A caller's provider list is ORDERED — `receiveNotes` puts a device
         * the reader was told about ahead of whatever the index advertised —
         * and `Vec::pop` reversed exactly that, so the named device was tried
         * LAST and an advertised stranger first. It went unnoticed because the
         * only run that exercised it had the DHT off, which makes the
         * advertised half empty and the two orders identical. Found by an
         * independent audit, 2026-09-11, in BOTH loops: one defect, two sites,
         * fixed together. */
        let mut asked_discovery = !supplied;
        let mut last: Option<String> = None;
        while let Some(provider) = queue.pop_front() {
            let who = provider.id;
            match notes::ask_one(&self.endpoint, provider, hash, since, generation).await {
                Ok(answer) => return Ok(answer),
                Err(err) => last = Some(format!("{who}: {err}")),
            }
            if queue.is_empty() && !asked_discovery {
                asked_discovery = true;
                queue = self.discovered(hash).await.into_iter().collect();
            }
        }
        Err(Error::ShareRefused(format!(
            "no provider could serve notes for {hash}{}",
            last.map(|why| format!(" ({why})")).unwrap_or_default()
        )))
    }

    /// Who else claims to serve this, over this service.
    pub async fn resolve(&self, hash: &ContentHash, service: ShareService) -> Result<Found> {
        let Some(dht) = self.dht().await else {
            return Err(Error::ShareRefused(
                "public discovery is off on this device".into(),
            ));
        };
        Ok(dht.resolve(hash, service).await)
    }

    async fn announce(&self, hash: &ContentHash, service: ShareService) {
        let Some(dht) = self.dht().await else { return };
        /* ⚠️ **THE `announce_peer` HALF RUNS EVERY TIME, EVEN WHEN THE INDEX
         * IS UNCHANGED.** The index is a value and skipping an identical write
         * is right; the peer set is a LEASE and skipping it is how a listing
         * ages out under a provider that is still running. */
        let port = self
            .endpoint
            .bound_sockets()
            .first()
            .map_or(SHARE_BIND_PORT, |a| a.port());
        if let Err(err) = dht.announce(hash, service, self.id(), port).await {
            log::info!(
                "peer: could not announce {hash} ({}): {err}",
                service.as_str()
            );
        }
    }

    /// The DHT, joined on first use. `None` when discovery is off or the node
    /// would not start — neither is fatal to serving, only to being found.
    async fn dht(&self) -> Option<Announcer> {
        if !self.dht_enabled {
            return None;
        }
        let mut held = self.announcer.lock().await;
        if held.is_none() {
            match Announcer::join() {
                Ok(node) => *held = Some(node),
                Err(err) => {
                    /* Not cached: the next caller tries again. See the field. */
                    log::warn!("peer: public discovery is unavailable: {err}");
                    return None;
                }
            }
        }
        held.clone()
    }

    /// The blob store, for the tests that assert what is pinned in it.
    #[cfg(test)]
    pub fn store(&self) -> &FsStore {
        &self.store
    }

    /// Whether this node currently holds a DHT handle — for the lifecycle
    /// tests, which are the only thing that can see it.
    #[cfg(test)]
    pub async fn has_dht(&self) -> bool {
        self.announcer.lock().await.is_some()
    }

    /// Stop answering, close the endpoint and the store.
    pub async fn close(&self) {
        if let Some(gate) = self.gate.lock().expect("share gate lock").take() {
            gate.abort();
        }
        if let Some(renewal) = self.renewal.lock().expect("renewal lock").take() {
            renewal.abort();
        }
        /* ⚠️ **THE DHT GOES TOO, AND IT USED TO SURVIVE THE CLOSE.** The
         * announcer holds a `mainline::Dht`, which is a background thread and a
         * UDP socket; `close` took the gate and the renewal down and left that
         * running for as long as anything held the closed node. The node's own
         * `Drop` is not the answer either, because `Arc<ShareNode>` is handed
         * out — a test that closes and asserts, or a plugin teardown that
         * outlives one clone, kept a DHT participant alive on a machine that
         * had stopped sharing. Dropping the handle here is what actually ends
         * it, and a later `dht()` would rejoin rather than answer from a stale
         * one, which is now safe because only success is cached. */
        drop(self.announcer.lock().await.take());
        /* ⚠️ **EVERY STEP RUNS, AND EVERY FAILURE IS SAID.** `.ok()` discarded
         * both of these: a router that would not shut down and a store that
         * could not flush are exactly the states worth knowing about at close,
         * and they left no trace at all. Still best effort in the sense that
         * one failure does not skip the others — a half-closed node must not
         * become a node that never closes. */
        if let Err(err) = self.router.shutdown().await {
            log::warn!("peer: the share router did not shut down cleanly: {err}");
        }
        self.endpoint.close().await;
        if let Err(err) = self.store.shutdown().await {
            log::warn!("peer: the public blob store did not shut down cleanly: {err}");
        }
    }
}

/// Announce everything still offered, on a cadence, for as long as the node
/// lives.
///
/// ⚠️ **A NO-OP WHILE NOTHING IS OFFERED, WHICH IS MOST INSTALLATIONS.** It
/// reads the policy — a file — and goes back to sleep; the DHT is joined only
/// if there is something to announce, so a reader who never publishes never
/// opens a socket to it.
async fn renew(node: Weak<ShareNode>) {
    loop {
        /* ⚠️ **ANNOUNCE FIRST, THEN SLEEP — IT USED TO SLEEP FIRST.** The
         * endpoint resumes on launch for books offered in a previous session,
         * and those listings expired while the app was closed. Sleeping first
         * left every one of them undiscoverable for a whole renewal period
         * after the reader opened the app, and an app used in shorter sessions
         * than that period never announced them at ALL — the offer switch says
         * "offered", the pane says "offered", and nobody can find the book.
         * Found by audit. Announcing first is also idempotent: the index write
         * is skipped when unchanged and the peer lease is meant to be
         * re-taken. */
        if let Some(node) = node.upgrade() {
            for service in ShareService::ALL {
                for hash in node.policy.offered(service) {
                    /* ⚠️ **RE-READ PER BOOK, NOT FROM A SNAPSHOT.** `offered`
                     * answers from the policy file, and a withdrawal landing
                     * mid-pass would otherwise be overtaken by an announcement
                     * this loop had already decided to make — re-publishing a
                     * book the reader had just taken back. The check is cheap
                     * and it is the reader's "stop" that it protects. */
                    if !node.policy.allows(&hash, service) {
                        continue;
                    }
                    node.announce(&hash, service).await;
                }
            }
        } else {
            break;
        }
        tokio::time::sleep(RENEW_EVERY).await;
    }
}

/// Answer one request's authorization and, when it is allowed, hold its
/// transfer permit for exactly as long as the request lives.
///
/// ⚠️ **ONE COPY, BECAUSE THE PERMIT'S LIFETIME HAS BEEN WRONG TWICE.** `Get`
/// and `GetMany` had identical bodies for this, and the release point has
/// already been fixed twice in this file's history: once from "immediately",
/// which bounded nothing, and once from "when the connection closes", which
/// bounded far too much and let one polite client lock the machine out. A
/// lifetime rule written out twice is one that gets fixed once.
///
/// ⚠️ **A MACRO RATHER THAN A FUNCTION, AND NOT BY PREFERENCE.** The parameters
/// would have to name `irpc::channel::oneshot::Sender` and
/// `irpc::channel::mpsc::Receiver`, and this crate deliberately does not depend
/// on `irpc` — `Cargo.toml` drops iroh-blobs' `rpc` feature to keep that whole
/// tree out. A macro shares the body without naming the types; inference does
/// the rest.
///
/// The drain is what ties the permit to the request: `rx` is the request's own
/// update stream and it ends when the request does, completed or aborted, so
/// the permit can neither outlive it nor die before it.
macro_rules! admit {
    ($verdict:expr, $msg:expr) => {
        match $verdict {
            Ok(permit) => {
                $msg.tx.send(Ok(())).await.ok();
                let mut updates = $msg.rx;
                tokio::spawn(async move {
                    while let Ok(Some(_update)) = updates.recv().await {}
                    drop(permit);
                });
            }
            Err(why) => {
                $msg.tx.send(Err(why)).await.ok();
            }
        }
    };
}

/// The one place a stranger's blob request is allowed or refused — WI-25.5.
///
/// ⚠️ **EVERY ARM DEFAULTS TO NO.** A message kind this build does not
/// understand is refused rather than passed through, and an unparseable hash
/// is refused rather than looked up. The failure this shape prevents is the
/// one WI-25.5 names: a check that lives at the index rather than in the serve
/// path, so that a hash kept from last week still works.
async fn authorize(
    policy: Arc<SharePolicy>,
    bounds: ShareBounds,
    mut messages: tokio::sync::mpsc::Receiver<ProviderMessage>,
) {
    let decide = |hashes: Vec<Hash>| -> std::result::Result<(), AbortReason> {
        if hashes.is_empty() {
            return Err(AbortReason::Permission);
        }
        for hash in hashes {
            /* ⚠️ **THE PARSE CANNOT FAIL, AND PRETENDING IT CAN HID THAT.** A
             * typed 32-byte `Hash` formats as exactly 64 lower-case hex
             * characters, which is precisely what `ContentHash::parse` accepts —
             * so the refusal branch was unreachable and the round trip through a
             * `String` was an allocation and a validation per request to reach
             * it. `ContentHash::from_blob` is the infallible conversion, and a
             * dead arm that looks like a guard is worse than no arm: it reads as
             * though something is being checked. */
            let parsed = ContentHash::from_blob(&hash);
            if !policy.allows(&parsed, ShareService::Bytes) {
                return Err(AbortReason::Permission);
            }
        }
        /* The machine-wide allowance, asked here so a refusal costs one
         * message rather than a transfer task — `envelope.ts`'s posture:
         * refuse *"BEFORE a handler context is built"*. The bytes themselves
         * are charged as they move, in the throttle arm below. */
        if !bounds.has_allowance() {
            return Err(AbortReason::RateLimited);
        }
        Ok(())
    };
    /* ⚠️ **THE CONNECTION PERMIT IS HELD FOR THE CONNECTION'S LIFE, WHICH IS
     * THE ONLY WAY IT BOUNDS ANYTHING.** A version of this took a permit and
     * dropped it immediately, which answers "is a slot free right now" and
     * bounds nothing at all — sixty-four strangers arriving in one second all
     * see a free slot. `connection_closed` is notified unconditionally by
     * iroh-blobs, so the release point exists; this map is the thing that uses
     * it. Only this task touches the map, so a plain `HashMap` is enough. */
    let mut held: std::collections::HashMap<u64, tokio::sync::OwnedSemaphorePermit> =
        std::collections::HashMap::new();
    /* ⚠️ **AND A BLOB REQUEST TAKES A TRANSFER PERMIT, WHICH IT DID NOT.**
     * `ShareLimits::concurrent_transfers` applied only to the notes service:
     * iroh-blobs spawns a handler per accepted STREAM, and a connection may
     * carry many, so the connection cap did not enforce the advertised
     * transfer or memory bound at all. Found by audit.
     *
     * ⚠️ **AND IT IS RELEASED WHEN THE REQUEST ENDS, NOT WHEN THE CONNECTION
     * DOES.** It was the connection, on the reasoning that holding a permit
     * "slightly longer than the transfer" was the safe direction. It is not
     * slightly longer and it is not safe: QUIC connections are persistent and
     * carry many sequential requests, so nine requests down one connection
     * exhausted all eight permits and held them against every OTHER connection
     * until that reader hung up. One well-behaved client could lock the machine
     * out of serving anybody. Found by audit — and it is the same defect as the
     * one it replaced, which released the permit immediately and bounded
     * nothing: both got the RELEASE POINT wrong, in opposite directions.
     *
     * `msg.rx` is the request's own update stream and it ends when the request
     * does, completed or aborted. Moving the permit into a task that drains it
     * ties the permit's lifetime to the request's exactly, with no map to keep
     * and no release point to forget.
     *
     * ⚠️ **INLINED AT BOTH CALL SITES RATHER THAN A HELPER**, because naming
     * the receiver's type means naming `irpc`, which this crate deliberately
     * does not depend on — `Cargo.toml` drops iroh-blobs' `rpc` feature to keep
     * that whole tree out. Inference knows the type; we do not have to. */
    while let Some(message) = messages.recv().await {
        match message {
            ProviderMessage::GetRequestReceived(msg) => {
                /* ⚠️ **A `Get` MAY BE A COLLECTION REQUEST, AND CHECKING ONLY
                 * THE ROOT HASH LETS IT SERVE CHILDREN NOBODY AUTHORIZED.**
                 * `ChunkRangesSeq` addresses a hash SEQUENCE: a request whose
                 * ranges reach past index 0 asks iroh-blobs to read the root
                 * as a list of child hashes and serve those, and every one of
                 * them skips this decision. A book offered today could then
                 * name a book withdrawn last week — the store still has it —
                 * and the root itself is loaded whole into memory to be
                 * interpreted. Found by audit.
                 *
                 * ⚠️ **REFUSED RATHER THAN AUTHORIZED PER CHILD**, because a
                 * book is one raw blob and this endpoint has no use for a
                 * collection at all. Authorizing children would mean reading
                 * the root before deciding whether it may be read. */
                let verdict = if !msg.inner.request.ranges.is_blob() {
                    Err(AbortReason::Permission)
                } else {
                    decide(vec![msg.inner.request.hash])
                        .and_then(|()| bounds.take_transfer().map_err(|_| AbortReason::RateLimited))
                };
                admit!(verdict, msg);
            }
            ProviderMessage::GetManyRequestReceived(msg) => {
                let verdict = decide(msg.inner.request.hashes.clone())
                    .and_then(|()| bounds.take_transfer().map_err(|_| AbortReason::RateLimited));
                admit!(verdict, msg);
            }
            /* Connections are counted rather than judged: there is nobody to
             * judge. Identity is not part of this layer's model at all — a
             * stranger has no name here, which is why the bounds are
             * machine-wide (WI-25.6) rather than per peer. */
            ProviderMessage::ClientConnected(msg) => {
                let verdict = match bounds.take_connection() {
                    Ok(permit) => {
                        held.insert(msg.inner.connection_id, permit);
                        Ok(())
                    }
                    Err(_) => Err(AbortReason::RateLimited),
                };
                msg.tx.send(verdict).await.ok();
            }
            ProviderMessage::ConnectionClosed(msg) => {
                /* Only the CONNECTION permit is released here now. A transfer
                 * permit belongs to its request and is dropped by that
                 * request's own drain task — see the note above. */
                held.remove(&msg.inner.connection_id);
            }
            /* ⚠️ **THIS ARM IS WHERE BYTES ARE ACTUALLY SPENT, AND THE CHUNK IT
             * IS TOLD ABOUT HAS ALREADY GONE.** This said the charge happened
             * "as the chunk is about to move", and the dependency is explicit
             * that it does not: `WriterContext::notify_payload_write` adds the
             * length to `payload_bytes_written` and THEN emits `Throttle`, so
             * by the time this runs the bytes are on the wire. Measured by
             * reading iroh-blobs 0.103, found by audit.
             *
             * ⚠️ **SO THE BOUND IS BACKPRESSURE WITH ONE CHUNK OF OVERSHOOT,
             * AND THAT IS WHAT IT CAN BE.** There is no pre-send hook: the
             * per-request arms above are the only place that refuses before
             * anything moves, and they are per REQUEST. What this arm does is
             * make the NEXT chunk wait, and refuse the rest of a transfer whose
             * allowance is gone — so a stranger can overshoot the day's budget
             * by about sixteen kibibytes per in-flight request and no more. The
             * old claim was that nothing overshot at all; the number is small
             * and stating it is the difference between a bound and a hope.
             *
             * ⚠️ **AND IT IS SPAWNED, BECAUSE SLEEPING HERE WOULD SERIALISE
             * EVERY REQUEST BEHIND THE SLOWEST TRANSFER.** iroh-blobs awaits
             * this reply before sending the NEXT chunk, so a delay taken inside
             * the loop is a delay taken by every other connection's
             * authorization too — a disk-rate limiter that became a global
             * stall. The
             * counters are atomic and the semaphores are shared, so the
             * spawned task decides against the same state the loop would. */
            ProviderMessage::Throttle(msg) => {
                let bounds = bounds.clone();
                tokio::spawn(async move {
                    let size = msg.inner.size;
                    let verdict = match bounds.charge(size) {
                        Ok(()) => {
                            tokio::time::sleep(bounds.read_delay(size)).await;
                            Ok(())
                        }
                        Err(_) => Err(AbortReason::RateLimited),
                    };
                    msg.tx.send(verdict).await.ok();
                });
            }
            ProviderMessage::PushRequestReceived(msg) => {
                msg.tx.send(Err(AbortReason::Permission)).await.ok();
            }
            /* ⚠️ **REFUSED, AND IT IS NOT AN OVERSIGHT.** `observe` lets a
             * caller watch a blob's local bitfield change. On a private store
             * that is a progress bar; on a PUBLIC one it is a channel that
             * reports what this machine is downloading, to anybody who asks. */
            ProviderMessage::ObserveRequestReceived(msg) => {
                msg.tx.send(Err(AbortReason::Permission)).await.ok();
            }
            /* The notify-only kinds carry no decision to make. */
            ProviderMessage::ClientConnectedNotify(_)
            | ProviderMessage::GetRequestReceivedNotify(_)
            | ProviderMessage::GetManyRequestReceivedNotify(_)
            | ProviderMessage::PushRequestReceivedNotify(_)
            | ProviderMessage::ObserveRequestReceivedNotify(_) => {}
        }
    }
}

/// The annotation service, as the router accepts it.
#[derive(Debug, Clone)]
struct NotesProtocol {
    root: PathBuf,
    policy: Arc<SharePolicy>,
    bounds: ShareBounds,
}

impl ProtocolHandler for NotesProtocol {
    async fn accept(
        &self,
        conn: iroh::endpoint::Connection,
    ) -> std::result::Result<(), AcceptError> {
        notes::serve(
            self.root.clone(),
            Arc::clone(&self.policy),
            self.bounds.clone(),
            conn,
        )
        .await;
        Ok(())
    }
}

#[cfg(test)]
mod dht_switch {
    //! The harness's off switch, measured rather than assumed.
    //!
    //! ⚠️ **THE DECISION IS TESTED, NOT THE ENVIRONMENT.** `dht_wanted` takes
    //! the value instead of reading `std::env` so these cases cannot race a
    //! threaded runner — one test setting a process-wide variable while
    //! another reads it is a flake that appears under `--test-threads` and
    //! nowhere else. `paper-data-root` splits `resolve` from `data_root` for
    //! the same reason.

    use super::{dht_wanted, ShareConfig, NO_DHT_ENV};
    use std::ffi::OsStr;
    use std::path::PathBuf;

    #[test]
    fn absent_means_the_dht_is_on_because_that_is_what_a_reader_gets() {
        assert!(dht_wanted(None));
    }

    #[test]
    fn any_value_at_all_turns_it_off_including_an_empty_one() {
        /* `PAPER_TEST_NO_DHT=` is a variable that IS set, and a harness that
        exported it meant it. Requiring a particular word would make the
        empty spelling announce, which is the direction that cannot be
        undone. */
        assert!(!dht_wanted(Some(OsStr::new(""))));
        assert!(!dht_wanted(Some(OsStr::new("1"))));
        assert!(!dht_wanted(Some(OsStr::new("no"))));
    }

    #[test]
    fn the_variable_is_named_once() {
        /* The scenario script greps for this spelling. Two copies of a name
        drift; this asserts the one the code uses. */
        assert_eq!(NO_DHT_ENV, "PAPER_TEST_NO_DHT");
    }

    /// Puts `NO_DHT_ENV` back however the body leaves — including by panic.
    ///
    /// ⚠️ **THE FIRST VERSION RESTORED ON THE LAST LINE**, so a failing
    /// assertion left the variable removed for every test that ran afterwards
    /// in the same process — turning one red test into an unrelated cascade
    /// and hiding the real one. Found by an independent audit, 2026-09-11.
    struct EnvGuard(Option<std::ffi::OsString>);

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => unsafe { std::env::set_var(NO_DHT_ENV, value) },
                None => unsafe { std::env::remove_var(NO_DHT_ENV) },
            }
        }
    }

    #[test]
    fn a_debug_build_with_nothing_set_still_announces() {
        /* The whole default, end to end through `for_app` rather than through
        the helper — so a future edit that stops consulting `dht_for_app`
        fails here rather than silently shipping a non-announcing app. */
        let _restore = EnvGuard(std::env::var_os(NO_DHT_ENV));
        unsafe { std::env::remove_var(NO_DHT_ENV) };
        assert!(ShareConfig::for_app(PathBuf::from("/tmp/paper-dht-switch")).dht);
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    //! A share endpoint on a scratch root, relays off, no discovery, no DHT.

    use super::*;
    use crate::testutil::ScratchDir;

    pub struct TestShare {
        pub node: Arc<ShareNode>,
        pub dir: ScratchDir,
    }

    impl TestShare {
        pub async fn start(label: &str) -> TestShare {
            Self::start_with(label, ShareLimits::default()).await
        }

        pub async fn start_with(label: &str, limits: ShareLimits) -> TestShare {
            let dir = ScratchDir::new(label);
            let node = ShareNode::start(ShareConfig {
                root: dir.path().to_path_buf(),
                relay_mode: RelayMode::Disabled,
                discovery: Discovery::NONE,
                bind_port: None,
                limits,
                dht: false,
            })
            .await
            .expect("the share endpoint starts");
            TestShare { node, dir }
        }

        /// A book in this root's vault, and its true content hash.
        pub fn write_book(&self, folder: &str, name: &str, bytes: &[u8]) -> ContentHash {
            let dir = self.dir.path().join("books").join(folder);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(name), bytes).unwrap();
            ContentHash::parse(&blake3::hash(bytes).to_hex()).unwrap()
        }

        pub async fn close(self) {
            self.node.close().await;
        }
    }
}
