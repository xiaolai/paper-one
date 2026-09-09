//! Announcing a book, and finding who has one — WI-25.7.
//!
//! ⚠️ **NOTHING HERE RUNS UNTIL A READER OFFERS SOMETHING.** Joining the
//! mainline DHT means opening a UDP socket to a global, unauthenticated,
//! permanently queryable index and bootstrapping against public routers. It is
//! the loudest thing this application does, and a reading app must not do it
//! because it was launched. The node is built lazily, on the first announce or
//! resolve, and `SharePolicy` — default off, per book, per service — is what
//! decides whether there is ever a first one.
//!
//! ⚠️ **AND ANNOUNCING IS PUBLICATION, WITH NO TAKE-BACK.** An announce puts
//! *this machine's address against this book's topic* somewhere anybody can
//! read and nobody can be asked to forget. [`Announcer::withdraw`] rewrites the
//! index record, which is the most that can be done: DHT nodes that already
//! answered a query have answered it, and `announce_peer` entries expire on
//! their own schedule rather than on ours.
//!
//! ## Why there is no tracker
//!
//! Phase 25 weighed a small tracker against the DHT and preferred the DHT
//! *"because a tracker you operate is the thing that gets taken away"*. That
//! reasoning survived the spike; what did not survive was the mechanism — see
//! `topic.rs`, which records the three source readings that killed
//! "look up hash → address, then dial".

use std::time::Duration;

use futures_lite::stream::StreamExt;
use mainline::{Dht, MutableItem};

use crate::error::{Error, Result};
use crate::share::index::ProviderIndex;
use crate::share::policy::ShareService;
use crate::share::topic::Topic;
use crate::share::ContentHash;

/// How long a lookup waits before answering with what it has.
///
/// ⚠️ **AN ANSWER OF "NOBODY" AND AN ANSWER OF "NOT YET" LOOK THE SAME**, so
/// the deadline is part of the contract rather than a timeout to tune later.
/// Ten seconds is far above a warm DHT's few hundred milliseconds and far
/// below a reader's patience for a search that is going to fail.
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);

/// How many times a conflicting index write is re-read and retried.
///
/// Small on purpose: the record holds thirty-one providers and a contended one
/// is a popular book, where being listed is worth less than not spending a
/// reader's evening on it. Failing after three tries is a book that is
/// findable through everybody else's entry.
const PUBLISH_TRIES: usize = 3;

/// What a lookup found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// Endpoints somebody claimed serve this. Never trusted — see `index.rs`.
    pub providers: Vec<iroh::EndpointId>,
    /// Socket addresses announced under the same topic, as an independent
    /// liveness signal.
    ///
    /// ⚠️ **THESE ARE NOT DIALLABLE ON THEIR OWN, AND THAT IS THE SPIKE'S
    /// CENTRAL FINDING.** iroh pins a remote's public key before the first
    /// packet (`iroh-1.0.3/src/endpoint.rs:1092`), so an address without an
    /// endpoint id is not a provider. They are carried because an address that
    /// matches a listed provider's is evidence the provider is up, and because
    /// an empty index beside a busy peer set says the record was vandalised
    /// rather than that the book is unserved.
    pub addresses: Vec<std::net::SocketAddrV4>,
}

/// The DHT, started lazily and shared.
#[derive(Debug, Clone)]
pub struct Announcer {
    dht: Dht,
}

impl Announcer {
    /// Join the DHT. ⚠️ **CALL THIS ONLY WHEN SOMETHING IS ACTUALLY OFFERED.**
    pub fn join() -> Result<Announcer> {
        let dht = Dht::builder()
            .build()
            .map_err(|err| Error::ShareRefused(format!("the DHT would not start: {err}")))?;
        Ok(Announcer { dht })
    }

    /// A node against a local testnet, for the tests below.
    #[cfg(test)]
    pub fn joining(bootstrap: &[String]) -> Result<Announcer> {
        let dht = Dht::builder()
            .bootstrap(bootstrap)
            .request_timeout(Duration::from_millis(500))
            .build()
            .map_err(|err| Error::ShareRefused(format!("the DHT would not start: {err}")))?;
        Ok(Announcer { dht })
    }

    /// Put this endpoint into one book's provider index, for one service.
    ///
    /// Read-modify-write: the record is a shared bulletin board, so an
    /// announce that replaced it would take every other provider off the book.
    pub async fn announce(
        &self,
        hash: &ContentHash,
        service: ShareService,
        me: iroh::EndpointId,
        share_port: u16,
    ) -> Result<()> {
        let topic = Topic::derive(hash, service);
        let (held, _) = self.read_index(&topic).await;
        let next = held.with(*me.as_bytes());
        /* Unchanged records are not republished. A DHT put is a burst of
         * traffic to a dozen strangers; doing it on a schedule when nothing
         * moved is how a reading app becomes a DHT crawler's favourite host. */
        if next == held {
            log::debug!(
                "peer: already listed as a provider for {} ({})",
                &hash.as_str()[..8],
                service.as_str()
            );
        } else {
            self.publish_index(&topic, |current| current.with(*me.as_bytes()))
                .await?;
        }
        /* The liveness half. Best effort and logged, never fatal: a machine
         * behind a NAT that refuses the announce is still listed in the index
         * and still reachable through iroh's own address lookup. */
        if let Err(err) = self
            .dht
            .clone()
            .as_async()
            .announce_peer(topic.info_hash(), Some(share_port))
            .await
        {
            log::info!(
                "peer: could not announce {} ({}) to the DHT peer set: {err}",
                &hash.as_str()[..8],
                service.as_str()
            );
        }
        Ok(())
    }

    /// Take this endpoint out of one book's provider index.
    ///
    /// ⚠️ **THIS IS NOT AN UNDO.** See the module header: the record can be
    /// rewritten, and everything already answered has been answered. A reader
    /// turning a book off is protected by `SharePolicy` refusing every
    /// request, not by this.
    pub async fn withdraw(
        &self,
        hash: &ContentHash,
        service: ShareService,
        me: iroh::EndpointId,
    ) -> Result<()> {
        let topic = Topic::derive(hash, service);
        let (held, _) = self.read_index(&topic).await;
        if held.without(*me.as_bytes()) == held {
            return Ok(());
        }
        self.publish_index(&topic, |current| current.without(*me.as_bytes()))
            .await
    }

    /// Read the record, apply `change`, and publish the successor — retrying
    /// when somebody else got there first.
    ///
    /// ⚠️ **A BARE READ-MODIFY-WRITE LOSES A PROVIDER.** Found by audit: two
    /// honest providers announcing at once read the same sequence and publish
    /// competing successors, and whichever lands second replaces the first —
    /// so a book gains a provider and loses one. `put_mutable`'s `cas` is the
    /// DHT's own conditional update; a refusal means the record moved, and the
    /// answer to that is to read it again rather than to overwrite it.
    ///
    /// ⚠️ **AND `seq + 1` OVERFLOWS.** A valid item at `i64::MAX` panicked in a
    /// checked build and wrapped to an invalid sequence in a release one. The
    /// sequence space is the network's, so exhausting it is a refusal rather
    /// than a wrap — nobody's record should ever be there, and one that is has
    /// been vandalised into a corner.
    async fn publish_index(
        &self,
        topic: &Topic,
        change: impl Fn(&ProviderIndex) -> ProviderIndex,
    ) -> Result<()> {
        for _ in 0..PUBLISH_TRIES {
            let (held, seq) = self.read_index(topic).await;
            let next = change(&held);
            if next == held {
                return Ok(());
            }
            let Some(bumped) = seq.checked_add(1) else {
                return Err(Error::ShareRefused(
                    "this book's provider index has no sequence numbers left".into(),
                ));
            };
            /* `cas` is `None` for a record that does not exist yet: there is
            nothing to compare against, and passing `0` would claim there
            was. */
            let cas = if seq == 0 { None } else { Some(seq) };
            let item =
                MutableItem::new(topic.public_signer().clone(), &next.encode(), bumped, None);
            match self.dht.clone().as_async().put_mutable(item, cas).await {
                Ok(_) => return Ok(()),
                Err(err) => {
                    log::debug!("peer: the provider index moved under us ({err}); reading it again")
                }
            }
        }
        Err(Error::ShareRefused(
            "this book's provider index is being written faster than it can be read".into(),
        ))
    }

    /// Who claims to serve this book, over this service.
    pub async fn resolve(&self, hash: &ContentHash, service: ShareService) -> Found {
        let topic = Topic::derive(hash, service);
        let (index, _) = self.read_index(&topic).await;
        let addresses = self.read_peers(&topic).await;
        /* ⚠️ **AN EMPTY INDEX BESIDE A BUSY PEER SET IS THE VANDALISM CASE**,
         * and it is the only signal there is for it: the record is writable by
         * anybody who knows the hash, so "no providers" and "somebody wiped
         * the providers" are otherwise the same answer. Logged rather than
         * returned, because nothing downstream can act on it — a searcher
         * still has to ask whoever it can find. */
        if index.is_empty() && !addresses.is_empty() {
            log::info!(
                "peer: {} providers are listed for {} ({}) at {} though {} address(es) announced under it",
                0,
                &hash.as_str()[..8],
                service.as_str(),
                topic.target(),
                addresses.len()
            );
        }
        Found {
            providers: index.endpoint_ids(),
            addresses,
        }
    }

    /// The current record and its sequence number, or an empty one at zero.
    async fn read_index(&self, topic: &Topic) -> (ProviderIndex, i64) {
        let key = topic.public_signer().verifying_key().to_bytes();
        let dht = self.dht.clone().as_async();
        let mut best: Option<MutableItem> = None;
        let mut stream = dht.get_mutable(&key, None, None);
        let deadline = tokio::time::sleep(LOOKUP_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                item = stream.next() => match item {
                    Some(item) => {
                        /* HIGHEST SEQUENCE WINS, and a tie is broken by the
                         * larger value — BEP 44's own rule, and the one
                         * `mainline` applies server-side. Taking the first
                         * answer instead would let the slowest, stalest node
                         * on the network decide what a book's providers are. */
                        let better = match &best {
                            None => true,
                            Some(held) => (item.seq(), item.value()) > (held.seq(), held.value()),
                        };
                        if better {
                            best = Some(item);
                        }
                    }
                    None => break,
                },
            }
        }
        match best {
            Some(item) => (ProviderIndex::decode(item.value()), item.seq()),
            None => (ProviderIndex::default(), 0),
        }
    }

    async fn read_peers(&self, topic: &Topic) -> Vec<std::net::SocketAddrV4> {
        let dht = self.dht.clone().as_async();
        let mut stream = dht.get_peers(topic.info_hash());
        let mut out: Vec<std::net::SocketAddrV4> = Vec::new();
        let deadline = tokio::time::sleep(LOOKUP_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                batch = stream.next() => match batch {
                    Some(addrs) => {
                        for addr in addrs {
                            /* Bounded: this list is a hint, and an unbounded
                             * one is an unbounded allocation a stranger
                             * chooses the size of. */
                            if out.len() >= 64 { break }
                            if !out.contains(&addr) { out.push(addr) }
                        }
                    }
                    None => break,
                },
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mainline::Testnet;

    fn hash(byte: u8) -> ContentHash {
        ContentHash::parse(&format!("{byte:02x}").repeat(32)).unwrap()
    }

    /// ⚠️ **A LOCAL TESTNET, NOT THE REAL DHT.** `mainline::Testnet` runs a
    /// handful of nodes on loopback, so these measure the mechanism rather
    /// than the internet: a test that announced to the global DHT would put
    /// the developer's address into a public index on every `cargo test`, and
    /// would fail on a machine with no network for reasons unrelated to the
    /// code.
    fn testnet() -> Testnet {
        Testnet::builder(6).build().expect("a local testnet")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_provider_announces_and_a_stranger_finds_it() {
        /* WI-25.7's acceptance, as far as one process can ask it: a publisher
        and a searcher who share only the book's hash — no provider id, no
        ticket — and the searcher comes back with the publisher's endpoint. */
        let net = testnet();
        let publisher = Announcer::joining(&net.bootstrap).unwrap();
        let searcher = Announcer::joining(&net.bootstrap).unwrap();
        let me = iroh::SecretKey::generate().public();

        publisher
            .announce(&hash(1), ShareService::Bytes, me, 47822)
            .await
            .unwrap();

        let found = searcher.resolve(&hash(1), ShareService::Bytes).await;
        assert_eq!(found.providers, vec![me]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn announcing_notes_does_not_make_the_book_downloadable() {
        /* ⚠️ **WI-25.9's ACCEPTANCE AT THE DISCOVERY LAYER.** A reader who
        publishes annotations must not thereby appear as a provider of the
        book's bytes. Two topics, so this is arithmetic rather than a filter. */
        let net = testnet();
        let publisher = Announcer::joining(&net.bootstrap).unwrap();
        let searcher = Announcer::joining(&net.bootstrap).unwrap();
        let me = iroh::SecretKey::generate().public();

        publisher
            .announce(&hash(2), ShareService::Notes, me, 47822)
            .await
            .unwrap();

        assert_eq!(
            searcher
                .resolve(&hash(2), ShareService::Notes)
                .await
                .providers,
            vec![me]
        );
        assert!(
            searcher
                .resolve(&hash(2), ShareService::Bytes)
                .await
                .providers
                .is_empty(),
            "publishing an annotation listed the machine as a source of the book"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_provider_joins_rather_than_replaces() {
        /* Read-modify-write. An announce that published its own record would
        take every other provider off the book, and the symptom would be a
        popular book with exactly one source. */
        let net = testnet();
        let first = Announcer::joining(&net.bootstrap).unwrap();
        let second = Announcer::joining(&net.bootstrap).unwrap();
        let a = iroh::SecretKey::generate().public();
        let b = iroh::SecretKey::generate().public();

        first
            .announce(&hash(3), ShareService::Bytes, a, 1)
            .await
            .unwrap();
        second
            .announce(&hash(3), ShareService::Bytes, b, 2)
            .await
            .unwrap();

        let found = first.resolve(&hash(3), ShareService::Bytes).await;
        assert!(found.providers.contains(&a), "{found:?}");
        assert!(found.providers.contains(&b), "{found:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn withdrawing_stops_this_endpoint_resolving_and_leaves_the_others() {
        let net = testnet();
        let node = Announcer::joining(&net.bootstrap).unwrap();
        let a = iroh::SecretKey::generate().public();
        let b = iroh::SecretKey::generate().public();
        node.announce(&hash(4), ShareService::Bytes, a, 1)
            .await
            .unwrap();
        node.announce(&hash(4), ShareService::Bytes, b, 1)
            .await
            .unwrap();

        node.withdraw(&hash(4), ShareService::Bytes, a)
            .await
            .unwrap();

        let found = node.resolve(&hash(4), ShareService::Bytes).await;
        assert!(!found.providers.contains(&a), "withdrawal did not take");
        assert!(
            found.providers.contains(&b),
            "withdrawal took somebody else off"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_book_nobody_announced_resolves_to_nobody() {
        /* And it must do so by ANSWERING, not by hanging — see
        `LOOKUP_TIMEOUT`. */
        let net = testnet();
        let searcher = Announcer::joining(&net.bootstrap).unwrap();
        let found = searcher.resolve(&hash(9), ShareService::Bytes).await;
        assert!(found.providers.is_empty());
    }
}
