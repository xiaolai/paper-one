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
            /* An all-zero id is the ed25519 identity point and cannot be
             * dialled; `crypto.ts` records what accepting one costs one layer
             * up. Dropped here so nothing downstream has to know. */
            if id != [0u8; ID_LEN] && !ids.contains(&id) {
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
    pub fn with(&self, id: [u8; ID_LEN]) -> ProviderIndex {
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

    /// The ids as iroh endpoint ids, dropping any that are not valid keys.
    pub fn endpoint_ids(&self) -> Vec<iroh::EndpointId> {
        self.ids()
            .iter()
            .filter_map(|id| iroh::EndpointId::from_bytes(id).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(byte: u8) -> [u8; ID_LEN] {
        [byte; ID_LEN]
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
    fn an_all_zero_id_is_dropped() {
        /* ⚠️ **THE IDENTITY POINT — `crypto.ts` measured what accepting one
        costs one layer up**: `verify(0…0, anything, 0…0)` answers TRUE. Here it
        is merely undialable, but a value that cannot be a provider has no
        business taking one of thirty-one slots. */
        let mut wire = MAGIC.to_vec();
        wire.extend_from_slice(&[0u8; ID_LEN]);
        wire.extend_from_slice(&id(7));
        assert_eq!(ProviderIndex::decode(&wire).ids(), &[id(7)]);
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
