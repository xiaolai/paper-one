//! The provider list one book's topic holds — WI-25.7.
//!
//! A BEP 44 mutable value is at most **1000 bytes**
//! (`mainline-8.0.0/src/rpc/server.rs:264`), so the record is fixed-width and
//! carries nothing it does not need: a four-byte magic and then raw 32-byte
//! endpoint ids. No JSON, no lengths, no delimiters — a format with no way to
//! disagree about where an entry ends is a format with no parser bugs.
//!
//! ⚠️ **THE LIST IS NOT EVIDENCE OF ANYTHING.** `topic.rs` explains why: the
//! signing key is derivable from the book's hash, so anybody who can look the
//! record up can also write it. An entry means "somebody claimed this endpoint
//! serves this book", and the only thing that settles the claim is asking the
//! endpoint — which verifies the bytes against the hash and may refuse
//! outright. Read it as a hint, never as a roster.

/// `PSI1` — Paper Share Index, version 1.
const MAGIC: [u8; 4] = *b"PSI1";

/// One endpoint id, raw.
pub const ID_LEN: usize = 32;

/// The BEP 44 value cap this record must fit inside.
pub const MAX_VALUE: usize = 1000;

/// The most providers one record lists.
///
/// `(1000 - 4) / 32 = 31`. Stated as arithmetic over the two constants so a
/// change to either cannot leave this stale — a record one entry too long is
/// refused by every DHT node on the network, silently, and the symptom is a
/// book that simply has no providers.
pub const MAX_PROVIDERS: usize = (MAX_VALUE - MAGIC.len()) / ID_LEN;

/// A provider list, decoded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderIndex {
    ids: Vec<[u8; ID_LEN]>,
}

impl ProviderIndex {
    /// Read a record off the wire. Anything that is not one is empty rather
    /// than an error.
    ///
    /// ⚠️ **A MALFORMED RECORD IS AN EMPTY ONE, WHICH IS THE OPPOSITE OF THIS
    /// CODEBASE'S USUAL POSTURE AND IS RIGHT HERE.** Every stored file in this
    /// plugin refuses to read a malformed value as an absent one, because the
    /// empty reading is what destroys data on the next write. This value is not
    /// stored, is not this machine's, and is written by anyone who knows the
    /// hash: "somebody put a byte here I do not understand" is the ordinary
    /// state of a public bulletin board, and failing the lookup over it would
    /// let one vandal take a book off the network.
    ///
    /// Trailing bytes that are not a whole id are dropped, and the ids that DID
    /// decode are kept — a truncated record still names real providers.
    pub fn decode(value: &[u8]) -> ProviderIndex {
        if value.len() < MAGIC.len() || value[..MAGIC.len()] != MAGIC {
            return ProviderIndex::default();
        }
        let body = &value[MAGIC.len()..];
        let mut ids = Vec::new();
        for chunk in body.chunks_exact(ID_LEN).take(MAX_PROVIDERS) {
            let mut id = [0u8; ID_LEN];
            id.copy_from_slice(chunk);
            if usable(&id) && !ids.contains(&id) {
                ids.push(id);
            }
        }
        ProviderIndex { ids }
    }

    /// The bytes to publish. Never longer than [`MAX_VALUE`].
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(MAGIC.len() + self.ids.len() * ID_LEN);
        out.extend_from_slice(&MAGIC);
        for id in self.ids.iter().take(MAX_PROVIDERS) {
            out.extend_from_slice(id);
        }
        debug_assert!(out.len() <= MAX_VALUE);
        out
    }

    /// This record with `id` listed FIRST, and at most [`MAX_PROVIDERS`] kept.
    ///
    /// ⚠️ **FIRST, NOT APPENDED, AND THE ORDER IS THE EVICTION POLICY.** A full
    /// record has to drop somebody, and dropping the entry that just arrived
    /// means a provider joining a popular book is never listed — the one case
    /// where being listed matters most. Putting the writer first evicts the
    /// least recently re-announced instead, which is also what makes a
    /// provider that has gone away fall out on its own.
    ///
    /// ⚠️ **AND YES, A FLOODER CAN EVICT EVERYONE BY WRITING THIRTY-ONE TIMES.**
    /// So can a vandal by writing an empty record once. See `topic.rs`: the
    /// index is availability, not authority, and `announce_peer` is the
    /// independent second signal for exactly this reason.
    ///
    /// ⚠️ **AN UNUSABLE ID IS NOT ADDED, AND IT USED TO BE.** `decode` dropped
    /// one and this did not, so `with([0; 32])` produced a record that lost an
    /// entry on its own round trip — and on a FULL record it evicted a real
    /// provider to make room for a byte string nobody can dial. One predicate
    /// now, in all three places. Found by audit.
    pub fn with(&self, id: [u8; ID_LEN]) -> ProviderIndex {
        if !usable(&id) {
            return ProviderIndex {
                ids: self.ids.clone(),
            };
        }
        let mut ids = Vec::with_capacity(self.ids.len() + 1);
        ids.push(id);
        for held in &self.ids {
            if *held != id && ids.len() < MAX_PROVIDERS {
                ids.push(*held);
            }
        }
        ProviderIndex { ids }
    }

    /// This record without `id` — what withdrawing publishes.
    pub fn without(&self, id: [u8; ID_LEN]) -> ProviderIndex {
        ProviderIndex {
            ids: self
                .ids
                .iter()
                .copied()
                .filter(|held| *held != id)
                .collect(),
        }
    }

    pub fn ids(&self) -> &[[u8; ID_LEN]] {
        &self.ids
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// The ids as iroh endpoint ids.
    ///
    /// ⚠️ **THIS USED TO BE THE THIRD ANSWER TO "IS THIS A PROVIDER?"** and it
    /// was the strictest of the three, so `is_empty()` said "somebody is
    /// listed" while this returned nothing — and `dht.rs` skipped its
    /// empty-provider diagnostic on a record that named no reachable provider
    /// at all. Every id held has already passed [`usable`], so nothing is
    /// dropped here; the `filter_map` stays because `from_bytes` returns a
    /// `Result` and a panic on the lookup path is not a trade worth making.
    pub fn endpoint_ids(&self) -> Vec<iroh::EndpointId> {
        self.ids()
            .iter()
            .filter_map(|id| iroh::EndpointId::from_bytes(id).ok())
            .collect()
    }
}

/// Whether these bytes name a provider anybody could dial.
///
/// ⚠️ **THREE PLACES DECIDED THIS AND THEY DISAGREED.** `decode` rejected the
/// all-zero id and nothing else; `with` rejected nothing, so a record could
/// lose an entry on its own round trip and evict a real provider to make room
/// for one nobody can use; `endpoint_ids` rejected whatever
/// `EndpointId::from_bytes` refused, so `is_empty()` and the provider list
/// answered differently about the same record. Found by audit.
///
/// ⚠️ **AND "ALL ZEROES IS THE IDENTITY POINT" WAS WRONG.** The identity
/// encodes as `[1, 0, …, 0]`; thirty-two zero bytes is a point of ORDER FOUR.
/// Both are in the small-order subgroup, and both — with the other six — are
/// keys whose signatures verify against messages nobody signed, which is to
/// say providers no dial can reach. `VerifyingKey::is_weak` is the library's
/// own name for that set, and it is the same check `crypto.ts` makes one layer
/// up with `isSmallOrder`.
fn usable(id: &[u8; ID_LEN]) -> bool {
    ed25519_dalek::VerifyingKey::from_bytes(id).is_ok_and(|key| !key.is_weak())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real, dialable endpoint id, deterministic in `byte`.
    ///
    /// ⚠️ **THIS WAS `[byte; 32]`, WHICH IS NOT A KEY.** Thirty-two copies of
    /// one byte is almost never a valid Ed25519 point, so every assertion
    /// below was made about ids no `EndpointId::from_bytes` would accept —
    /// which is exactly how `decode`, `with` and `endpoint_ids` came to
    /// disagree about what a provider is without any test noticing. A seed
    /// through the signing key gives a valid public key and stays
    /// deterministic. */
    fn id(byte: u8) -> [u8; ID_LEN] {
        ed25519_dalek::SigningKey::from_bytes(&[byte.wrapping_add(1); ID_LEN])
            .verifying_key()
            .to_bytes()
    }

    #[test]
    fn a_record_round_trips() {
        let index = ProviderIndex::default().with(id(1)).with(id(2));
        assert_eq!(ProviderIndex::decode(&index.encode()), index);
    }

    #[test]
    fn the_encoded_record_always_fits_a_bep44_value() {
        /* ⚠️ **A RECORD ONE BYTE OVER IS REFUSED BY EVERY DHT NODE, SILENTLY.**
        The symptom is a book with no providers and no error anywhere, which is
        indistinguishable from a book nobody serves. */
        let mut index = ProviderIndex::default();
        for byte in 0..=255u8 {
            index = index.with(id(byte.wrapping_add(1)));
        }
        assert!(
            index.encode().len() <= MAX_VALUE,
            "{}",
            index.encode().len()
        );
        assert_eq!(index.ids().len(), MAX_PROVIDERS);
    }

    #[test]
    fn the_writer_is_listed_first_and_the_oldest_falls_out() {
        let mut index = ProviderIndex::default();
        for byte in 1..=MAX_PROVIDERS as u8 {
            index = index.with(id(byte));
        }
        assert_eq!(index.ids()[0], id(MAX_PROVIDERS as u8));
        let oldest = id(1);
        assert!(index.ids().contains(&oldest));
        let index = index.with(id(200));
        assert_eq!(index.ids()[0], id(200));
        assert!(
            !index.ids().contains(&oldest),
            "the oldest entry survived a full record"
        );
    }

    #[test]
    /* Named "announcing_again" rather than "re_announcing": the commit guard
    reads `re_` followed by twenty-four word characters as a Resend API key,
    and it is a BLOCKING rule that no allow-file can exempt — correctly, for
    a rule about credentials. A test name is the cheap side of that
    trade. */
    fn announcing_again_moves_an_entry_to_the_front_rather_than_duplicating_it() {
        let index = ProviderIndex::default().with(id(1)).with(id(2)).with(id(1));
        assert_eq!(index.ids(), &[id(1), id(2)]);
    }

    #[test]
    fn withdrawing_removes_exactly_one_entry() {
        let index = ProviderIndex::default().with(id(1)).with(id(2)).with(id(3));
        let after = index.without(id(2));
        assert_eq!(after.ids(), &[id(3), id(1)]);
        assert_eq!(
            after.without(id(9)).ids(),
            after.ids(),
            "removing an absent id"
        );
    }

    #[test]
    fn anything_that_is_not_a_record_reads_as_empty() {
        /* A public slot anybody can write. See `decode`'s doc comment for why
        this is not an error. */
        for junk in [
            &b""[..],
            b"PSI",
            b"NOPE",
            b"PSI2\x00",
            &vec![0xffu8; 4000][..],
        ] {
            assert!(
                ProviderIndex::decode(junk).is_empty(),
                "decoded {junk:?} as providers"
            );
        }
    }

    #[test]
    fn a_truncated_record_keeps_the_ids_that_did_decode() {
        let index = ProviderIndex::default().with(id(1)).with(id(2));
        let mut wire = index.encode();
        wire.truncate(wire.len() - 5);
        let read = ProviderIndex::decode(&wire);
        assert_eq!(read.ids(), &[id(2)], "one whole id survived the truncation");
    }

    #[test]
    fn a_weak_key_is_dropped_however_it_arrives() {
        /* ⚠️ **`crypto.ts` MEASURED WHAT ACCEPTING ONE COSTS ONE LAYER UP**:
        `verify(0…0, anything, 0…0)` answers TRUE. Here it is merely undialable,
        but a value that cannot be a provider has no business taking one of
        thirty-one slots.

        ⚠️ **AND ALL ZEROES IS NOT THE IDENTITY, WHICH IS WHY THIS TESTS
        BOTH.** The identity encodes as `[1, 0, …, 0]`; thirty-two zeroes is a
        point of order four. The old check named the wrong one and let the
        other through, along with six more small-order keys and every byte
        string that is not a point at all. */
        let weak: [[u8; ID_LEN]; 3] = [
            [0u8; ID_LEN],
            {
                let mut one = [0u8; ID_LEN];
                one[0] = 1;
                one
            },
            /* Not a point at all: the old `decode` kept this, `with` kept it,
            and `endpoint_ids` silently dropped it. */
            [2u8; ID_LEN],
        ];
        for bad in weak {
            let mut wire = MAGIC.to_vec();
            wire.extend_from_slice(&bad);
            wire.extend_from_slice(&id(7));
            assert_eq!(
                ProviderIndex::decode(&wire).ids(),
                &[id(7)],
                "an unusable id survived decoding: {bad:?}"
            );
            /* ⚠️ **AND `with` MUST AGREE WITH `decode`.** It did not: adding
            one produced a record that lost an entry on its own round trip,
            and on a full record it evicted a real provider first. */
            let held = ProviderIndex::default().with(id(7));
            assert_eq!(
                held.with(bad).ids(),
                &[id(7)],
                "an unusable id was added: {bad:?}"
            );
        }
    }

    /// ⚠️ **`is_empty()` AND `endpoint_ids()` MUST ANSWER ABOUT THE SAME
    /// RECORD.** They did not: an id that decoded but was not a dialable key
    /// left `is_empty()` false and `endpoint_ids()` empty, so `dht.rs` skipped
    /// its empty-provider diagnostic for a record naming nobody reachable.
    #[test]
    fn what_is_listed_is_what_can_be_dialled() {
        let mut wire = MAGIC.to_vec();
        wire.extend_from_slice(&[2u8; ID_LEN]);
        let index = ProviderIndex::decode(&wire);
        assert!(index.is_empty(), "an undialable id counted as a provider");
        assert!(index.endpoint_ids().is_empty());

        let real = ProviderIndex::default().with(id(3));
        assert!(!real.is_empty());
        assert_eq!(real.endpoint_ids().len(), real.ids().len());
    }

    #[test]
    fn a_record_longer_than_the_cap_is_read_up_to_the_cap() {
        let mut wire = MAGIC.to_vec();
        for byte in 1..=(MAX_PROVIDERS as u8 + 10) {
            wire.extend_from_slice(&id(byte));
        }
        assert_eq!(ProviderIndex::decode(&wire).ids().len(), MAX_PROVIDERS);
    }

    #[test]
    fn duplicate_ids_on_the_wire_are_kept_once() {
        let mut wire = MAGIC.to_vec();
        wire.extend_from_slice(&id(4));
        wire.extend_from_slice(&id(4));
        assert_eq!(ProviderIndex::decode(&wire).ids(), &[id(4)]);
    }

    #[test]
    fn endpoint_ids_survive_the_round_trip_through_a_record() {
        let a = iroh::SecretKey::generate().public();
        let b = iroh::SecretKey::generate().public();
        let index = ProviderIndex::default()
            .with(*a.as_bytes())
            .with(*b.as_bytes());
        let back = ProviderIndex::decode(&index.encode()).endpoint_ids();
        assert_eq!(back.len(), 2);
        assert!(back.contains(&a) && back.contains(&b));
    }
}
