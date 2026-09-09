//! Turning a book's hash into the places a provider can be looked up —
//! WI-25.7 and WI-25.9.
//!
//! ## What the spike found, and it changed the design
//!
//! ⚠️ **ROUTE 2 AS PHASE 25 DESCRIBED IT DOES NOT EXIST.** The plan's second
//! route was *"Mainline DHT directly … look up hash → address, then dial the
//! share endpoint"*. Measured 2026-09-09 against the crates themselves:
//!
//! | Read | Says |
//! |---|---|
//! | `mainline-8.0.0/src/dht.rs:247` | `get_peers(Id) -> Vec<SocketAddrV4>` — addresses, nothing else |
//! | `iroh-1.0.3/src/endpoint.rs:1052,:1092` | `connect` and `connect_with_opts` both take an `EndpointAddr`, whose `id` is not optional |
//! | `iroh-mainline-content-discovery-0.6.0/src/client.rs:161–182` | n0's own DHT route resolves to **trackers**, then speaks a tracker protocol to learn providers — it never dials a provider found in the DHT |
//!
//! An iroh endpoint cannot be dialled from a socket address alone: QUIC pins
//! the remote's public key before the first packet. So a `get_peers` result is
//! not a provider, and the *hash → provider* step needs a value channel, not a
//! peer channel.
//!
//! ## What is used instead, and it is still route 2
//!
//! BEP 44 **mutable items**, under a keypair DERIVED FROM THE BOOK'S HASH.
//! `MutableItem::target_from_key` is `SHA1(public_key ‖ salt)`
//! (`mainline-8.0.0/src/common/mutable.rs:46`), so if the keypair itself comes
//! from the content hash then anyone holding the hash can compute the address
//! — which is exactly the property "content-addressed lookup" means and the
//! one `announce_peer` cannot supply.
//!
//! ⚠️ **THIS MAKES THE RECORD WORLD-WRITABLE BY ANYONE WHO KNOWS THE HASH, AND
//! THAT IS NOT A BUG TO BE FIXED LATER.** The signing key is derivable by
//! every reader who can compute the lookup, so the index is a **bulletin
//! board, not an authority**: a vandal who knows the hash can empty it, and a
//! liar can list endpoints that serve nothing. Neither is a security failure,
//! because nothing downstream trusts it — the bytes are verified against the
//! hash they were asked for (WI-25.3), and a provider that refuses is simply
//! a provider that refuses (WI-25.5). What it costs is availability, and the
//! `announce_peer` topic below is the independent second signal for that.
//!
//! ⚠️ **AND THE WHOLE MECHANISM IS PUBLIC BY CONSTRUCTION.** Announcing puts
//! *this machine's address, against this book's topic* into a global,
//! unauthenticated, permanently queryable index. That is what publishing IS,
//! and it is why nothing is announced for a book the reader has not turned on
//! (`SharePolicy`, default off) and why no DHT socket is opened at all while
//! nothing is offered.

use mainline::{Id, MutableItem};

use crate::error::{Error, Result};
use crate::share::policy::ShareService;
use crate::share::ContentHash;

/// The domain the index keypair is derived under, per service.
///
/// ⚠️ **DOMAIN-SEPARATED PER SERVICE, WHICH IS WI-25.9 MADE MECHANICAL.**
/// *"Who has these bytes"* and *"who has annotations for this hash"* must be
/// separately answerable, and a provider may answer the second while refusing
/// the first. Two derivation contexts means two DHT addresses, so answering one
/// does not put you in the other's index — the separation is arithmetic rather
/// than a filter somebody has to remember to apply.
fn index_context(service: ShareService) -> &'static str {
    match service {
        ShareService::Bytes => "paper.share.index.1 bytes",
        ShareService::Notes => "paper.share.index.1 notes",
    }
}

/// The domain the `announce_peer` info-hash is derived under.
///
/// A DIFFERENT context from the index above, so the address a provider
/// announces under and the slot the provider list lives in are two unrelated
/// points in the key space. One derivation for both would make a passive DHT
/// observer's job easier for no gain.
fn peers_context(service: ShareService) -> &'static str {
    match service {
        ShareService::Bytes => "paper.share.peers.1 bytes",
        ShareService::Notes => "paper.share.peers.1 notes",
    }
}

/// Where one book's providers are looked up, for one service.
#[derive(Debug, Clone)]
pub struct Topic {
    /// The ed25519 key the mutable item is signed under and addressed by.
    signer: mainline::SigningKey,
    /// `SHA1(public_key)` — the BEP 44 address.
    target: Id,
    /// The `announce_peer` info-hash — the liveness signal beside the index.
    info_hash: Id,
}

impl Topic {
    /// Derive both addresses for one book and one service.
    ///
    /// ⚠️ **BLAKE3's `derive_key`, NOT A HASH OF A CONCATENATION.** The context
    /// string is a domain separator the construction itself enforces; hashing
    /// `context ‖ hash` would let a context ending in a hex digit collide with
    /// a shorter context and a longer hash. The same reasoning `signedBytes`
    /// applies to the circle's signatures, one layer down.
    pub fn derive(hash: &ContentHash, service: ShareService) -> Self {
        let seed = blake3::derive_key(index_context(service), hash.bytes().as_slice());
        let signer = mainline::SigningKey::from_bytes(&seed);
        let target = MutableItem::target_from_key(&signer.verifying_key().to_bytes(), None);
        let peers = blake3::derive_key(peers_context(service), hash.bytes().as_slice());
        let mut twenty = [0u8; 20];
        twenty.copy_from_slice(&peers[..20]);
        Self {
            signer,
            target,
            info_hash: Id::from_bytes(twenty).expect("twenty bytes is an info-hash"),
        }
    }

    /// The BEP 44 address the provider list lives at.
    pub fn target(&self) -> Id {
        self.target
    }

    /// The `announce_peer` / `get_peers` info-hash.
    pub fn info_hash(&self) -> Id {
        self.info_hash
    }

    /// The key the provider list is signed with.
    ///
    /// ⚠️ **NOT A SECRET, AND NAMED SO IT CANNOT BE MISTAKEN FOR ONE.** It is
    /// derived from a value every participant holds. Signing with it proves
    /// only that the writer knew the book's hash, which is why the module
    /// header calls the record a bulletin board.
    pub fn public_signer(&self) -> &mainline::SigningKey {
        &self.signer
    }
}

/// A 64-hex BLAKE3 digest — the network name of a book (WI-25.2).
///
/// ⚠️ **A NEWTYPE BECAUSE EVERY CONSUMER BELOW TRUSTS IT.** It keys the
/// sharing policy, derives two DHT addresses and names a file; a `String` that
/// might be `"../.."` or `"ABCD…"` reaching any of those is a different bug in
/// each place. Parsed once, at the edge, and lower-case only — an upper-case
/// spelling is the same digest under a different key, which is how one book
/// ends up offered and refused at the same time.
impl ContentHash {
    pub fn parse(text: &str) -> Result<ContentHash> {
        if text.len() != 64
            || !text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::ShareRefused(format!(
                "a content hash is 64 lower-case hex digits, not {:?}",
                // Bounded, because this string arrives from the wire and from
                // a file: an error message is not a place to echo a megabyte.
                text.chars().take(80).collect::<String>()
            )));
        }
        Ok(ContentHash(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The 32 raw bytes.
    pub fn bytes(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, pair) in self.0.as_bytes().chunks_exact(2).enumerate() {
            out[i] = u8::from_str_radix(std::str::from_utf8(pair).expect("hex is ASCII"), 16)
                .expect("parse checked every digit");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(text: &str) -> ContentHash {
        ContentHash::parse(text).unwrap()
    }

    const A: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const B: &str = "ff00112233445566778899aabbccddeeff00112233445566778899aabbccddee";

    #[test]
    fn a_hash_is_sixty_four_lower_case_hex_and_nothing_else() {
        assert!(ContentHash::parse(A).is_ok());
        for refused in [
            "",
            "abc",
            &A[..63],
            &format!("{A}0"),
            &A.to_uppercase(),
            "../../etc/passwd",
            &"g".repeat(64),
            &"0".repeat(63).to_string(),
        ] {
            assert!(
                ContentHash::parse(refused).is_err(),
                "accepted {refused:?} as a content hash"
            );
        }
    }

    #[test]
    fn the_bytes_are_the_digits_in_order() {
        assert_eq!(hash(A).bytes()[..4], [0x00, 0x11, 0x22, 0x33]);
        assert_eq!(hash(A).bytes()[31], 0xff);
        /* ⚠️ **A DROPPED LEADING ZERO MOVES EVERY BYTE AFTER IT** — the trap
        `identity.rs`'s `hex` names from the other direction. A hash whose
        first byte is below 0x10 must still decode to 32 bytes. */
        let low = hash(&format!("0f{}", "00".repeat(31)));
        assert_eq!(low.bytes()[0], 0x0f);
        assert_eq!(low.bytes().len(), 32);
    }

    #[test]
    fn a_books_two_services_land_on_four_different_addresses() {
        /* ⚠️ **WI-25.9's REQUIREMENT, AS ARITHMETIC.** Answering "who has these
        bytes" must not put a provider into "who has annotations for this
        hash", and the only way to be sure of that is for the two questions to
        be asked at different addresses. */
        let bytes = Topic::derive(&hash(A), ShareService::Bytes);
        let notes = Topic::derive(&hash(A), ShareService::Notes);
        let seen = [
            bytes.target(),
            bytes.info_hash(),
            notes.target(),
            notes.info_hash(),
        ];
        for (i, one) in seen.iter().enumerate() {
            for other in &seen[i + 1..] {
                assert_ne!(one, other, "two of a book's four addresses are the same");
            }
        }
    }

    #[test]
    fn two_books_land_on_different_addresses() {
        let a = Topic::derive(&hash(A), ShareService::Bytes);
        let b = Topic::derive(&hash(B), ShareService::Bytes);
        assert_ne!(a.target(), b.target());
        assert_ne!(a.info_hash(), b.info_hash());
    }

    #[test]
    fn the_addresses_are_deterministic_so_two_readers_meet() {
        /* The whole mechanism rests on this: a publisher and a searcher who
        share only the hash must compute the same address, in this build and
        in the next one. */
        let first = Topic::derive(&hash(A), ShareService::Notes);
        let second = Topic::derive(&hash(A), ShareService::Notes);
        assert_eq!(first.target(), second.target());
        assert_eq!(first.info_hash(), second.info_hash());
        assert_eq!(
            first.public_signer().to_bytes(),
            second.public_signer().to_bytes()
        );
    }

    #[test]
    fn the_dht_address_is_not_the_content_hash_itself() {
        /* ⚠️ **THE OBVIOUS SPELLING WOULD PUT THE BOOK'S BLAKE3 STRAIGHT INTO
        THE GLOBAL DHT KEY SPACE**, where it collides with the info-hash space
        real torrents use and where it is a literal prefix of the book's
        identity. n0's own mapping does exactly that
        (`iroh-mainline-content-discovery-0.6.0/src/client.rs:80` — "copy the
        first 20 bytes"); this one derives instead, which costs nothing and
        keeps the two key spaces apart. */
        let topic = Topic::derive(&hash(A), ShareService::Bytes);
        assert_ne!(&topic.info_hash().as_bytes()[..], &hash(A).bytes()[..20]);
        assert_ne!(&topic.target().as_bytes()[..], &hash(A).bytes()[..20]);
    }
}
