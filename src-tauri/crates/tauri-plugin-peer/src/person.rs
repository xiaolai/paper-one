//! The PERSON root key, its twelve words, and the delegations it signs — WI-22.B1.
//!
//! `identity.rs` holds the DEVICE key: an iroh `SecretKey` at
//! `peer/identity.key`, one per machine, which is what opens connections. This
//! module holds the other one — the root that says several devices are ONE
//! reader, and which signs rather than connects.
//!
//! ## The phrase IS the key
//!
//! ⚠️ **THE KEYCHAIN HOLDS THE PHRASE, NOT THE DERIVED KEY.** `identity.md`
//! §"The shape" asks for *"32 bytes of OS CSPRNG entropy, 128 bits carried in
//! the phrase, the root key derived from it — so the phrase IS the key and
//! there are not two things that can diverge."* Storing the derived key beside
//! the phrase would create exactly the second thing: two secrets, one of which
//! can be restored while the other is stale, and no way for a reader to find
//! out which they have. Deriving on every read costs one PBKDF2 and removes the
//! question.
//!
//! ## The keychain is a cache, and saying so is load-bearing
//!
//! ⚠️ **NOTHING SETS `kSecAttrSynchronizable`, so a keychain entry is
//! DEVICE-LOCAL** — it dies with the Mac it was minted on, and adding a
//! replacement device is the entire reason a root key exists.
//! `identity.md` §"The keychain cannot be the durable store" is blunt about
//! what follows: *"The keychain is a cache. It is never the backup, and any
//! copy that says otherwise is a lie the reader discovers at the worst possible
//! moment."* The twelve words are the only durable copy, which is why
//! [`custody`] reports "one device, no copy" as a STANDING state rather than a
//! moment something hoped to catch.
//!
//! ## Lazily, and quietly
//!
//! ⚠️ **NOTHING IS MINTED AT FIRST LAUNCH AND NOTHING IS SHOWN AT CREATION.**
//! A reader who never shares never needs a person identity, and *"a phrase
//! shown before there is any context is a phrase that gets clicked through."*
//! [`ensure`] is called at the first moment one is actually needed — the first
//! circle pairing, or the second device — and it returns without a dialog.
//! `identity.md` §"Skip is the DEFAULT" carries the escalation ladder, and the
//! rule under it: **ask louder; never block.** Forced confirmation does not
//! produce custody, it produces a photograph in the camera roll.
//!
//! ## Why this is not a wallet, and why that decides the design
//!
//! Total loss costs: existing devices keep working until their delegations
//! lapse, you cannot add or revoke a device, and you can mint a fresh person
//! identity and re-pair. That is *meet your reading friends again* — a QR and
//! six digits each. The custody design is proportionate to that or it does more
//! harm than the loss it guards against.

use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Mutex, MutexGuard};

use bip39::{Language, Mnemonic};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::identity::PEER_DIR;

/// The keychain service every Paper credential lives under.
const KEYCHAIN_SERVICE: &str = "one.paper.reader";

/// The account the person phrase is filed under.
const ROOT_ACCOUNT: &str = "circle-person-root";

/// Where the `home`/`leaf` answer is written.
///
/// ⚠️ **NOT `peer/role`, which is already taken** by `role.rs` for
/// `shelf`/`satchel` — a different question about the same machine (what it
/// does for the library, not what it may do for the person). One file
/// answering two questions is how a satchel demotes itself to a leaf.
const DEVICE_ROLE_FILE: &str = "circle-role";

/// Which person this device belongs to, when it no longer holds the root.
///
/// ⚠️ **A LEAF HAD NO WAY TO NAME ITS OWN PERSON.** `forget` deleted the phrase
/// and wrote the word `leaf`, and nothing else — so `person_id` answered `None`,
/// `custody` reported no identity at all, and the device could not build a
/// circle hello for the person it still belongs to. Worse, the next `ensure`
/// saw no root and minted an UNRELATED identity, silently promoting a demoted
/// leaf to the home of a person nobody knows.
///
/// A person id is a PUBLIC key, so this is a plain file beside the role rather
/// than a keychain entry. What a leaf loses is the ability to SIGN, which is
/// the whole point of demoting it; what it keeps is the ability to say who it
/// speaks for, which was never a secret.
const PERSON_FILE: &str = "circle-person";

/// Twelve words, which is 128 bits plus its checksum.
const PHRASE_WORDS: usize = 12;

/// The longest a delegation may run.
///
/// ⚠️ **EXPIRY IS THE REAL REVOCATION** — `identity.md` says so, and WI-22.B2's
/// whole guarantee is that it holds for a peer who never connects again. A
/// lifetime the CALLER chooses is not a backstop: the delegate command is
/// reachable from the renderer, so `not_after: i64::MAX` was one IPC call away
/// and would have produced a delegation nothing can ever stop.
const MAX_LIFETIME_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// A device id is an iroh endpoint key: 64 lower-case hex characters.
const DEVICE_ID_HEX: usize = 64;

/// The entropy behind twelve words.
const PHRASE_ENTROPY_BYTES: usize = 16;

/// What a device may do with the person identity — `identity.md` §"Device roles".
///
/// ⚠️ **THE ROLE IS A GATE INDEPENDENT OF WHETHER THE ROOT IS HELD.** A leaf
/// answers `false` to [`DeviceRole::may_mint`] whether or not it has a root in
/// hand, because a leaf holding a root is a COMPROMISED IDENTITY, not a device
/// that may administer. That distinction is WI-22.B1's whole falsifier: *"a
/// device that holds no root key can mint itself a fresh delegation"* has to be
/// impossible, and checking custody alone would make it merely unlikely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceRole {
    /// Holds the root. Mints and revokes. There is exactly one, and it is
    /// SUCCEEDED rather than revoked — see `identity.md` §"Succession".
    Home,
    /// Holds only its own delegation. Reads, writes, shares; administers nothing.
    Leaf,
}

impl DeviceRole {
    /// Whether this device may sign a delegation for another.
    pub const fn may_mint(self) -> bool {
        matches!(self, Self::Home)
    }

    /// Whether this device may be revoked.
    ///
    /// ⚠️ Not called yet — WI-22.B2's revocation path is what asks. Kept beside
    /// `may_mint` because the two are one rule about roles read from opposite
    /// ends, and splitting them across two commits is how they drift.
    ///
    /// ⚠️ **`home` REFUSES**, so *"revoke the device holding the root"* stops
    /// being a sentence any surface can write. Home is succeeded; revoking it
    /// would leave a person identity nothing can ever administer again.
    #[allow(dead_code, reason = "the revocation half — consumed by WI-22.B2")]
    pub const fn is_revocable(self) -> bool {
        matches!(self, Self::Leaf)
    }

    const fn word(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Leaf => "leaf",
        }
    }
}

impl fmt::Display for DeviceRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.word())
    }
}

impl FromStr for DeviceRole {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim() {
            "home" => Ok(Self::Home),
            "leaf" => Ok(Self::Leaf),
            other => Err(Error::Identity(format!(
                "unknown circle device role {other:?} — expected \"home\" or \"leaf\""
            ))),
        }
    }
}

/// A store for one secret, so the tests do not need a real keychain.
///
/// The same shape `tauri-plugin-inference`'s `EndpointStore` uses, and for the
/// same reason: `Ok(None)` is "no entry", which is a normal state, and `Err` is
/// the keychain refusing to answer, which is a different fact and is kept as one.
/// Collapsing the two would read a locked keychain as a reader who has no
/// identity, and then mint a second one over the top of the first.
pub trait Keychain: Send + Sync + fmt::Debug {
    fn read(&self, account: &str) -> Result<Option<String>>;
    fn write(&self, account: &str, secret: &str) -> Result<()>;
    /// Absent is success — deleting what is not there is the outcome asked for.
    fn delete(&self, account: &str) -> Result<()>;
}

/// The OS keychain under Paper's service name.
#[derive(Debug)]
pub struct OsKeychain;

impl OsKeychain {
    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|e| Error::Identity(format!("keychain unavailable: {e}")))
    }
}

impl Keychain for OsKeychain {
    fn read(&self, account: &str) -> Result<Option<String>> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Identity(format!("keychain read failed: {e}"))),
        }
    }

    fn write(&self, account: &str, secret: &str) -> Result<()> {
        Self::entry(account)?
            .set_password(secret)
            .map_err(|e| Error::Identity(format!("keychain write failed: {e}")))
    }

    fn delete(&self, account: &str) -> Result<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Identity(format!("keychain delete failed: {e}"))),
        }
    }
}

/// The twelve words.
///
/// ⚠️ **NO `Display`, NO `Debug` THAT PRINTS IT.** A phrase reaching a log line
/// or a panic message is the whole secret in a file somebody else can read;
/// `words()` is the one way out and it is spelled out at the call site.
#[derive(Clone)]
pub struct Phrase(Mnemonic);

impl Phrase {
    /// The words, space separated, for the one surface that shows them.
    pub fn words(&self) -> String {
        self.0.to_string()
    }

    /// Parse twelve words a reader typed back in.
    ///
    /// The BIP39 checksum is what catches a mistyped word, which is most of why
    /// the phrase carries one — a wrong word otherwise derives a different key
    /// in silence and the reader learns about it as "nobody can see my marks".
    pub fn parse(words: &str) -> Result<Self> {
        let normalised = words.split_whitespace().collect::<Vec<_>>().join(" ");
        let mnemonic = Mnemonic::parse_in(Language::English, &normalised)
            .map_err(|e| Error::Identity(format!("that is not a valid recovery phrase: {e}")))?;
        if mnemonic.word_count() != PHRASE_WORDS {
            return Err(Error::Identity(format!(
                "a recovery phrase is {PHRASE_WORDS} words; that one is {}",
                mnemonic.word_count()
            )));
        }
        Ok(Self(mnemonic))
    }

    /// The signing key this phrase derives.
    ///
    /// ⚠️ **THE FIRST 32 BYTES OF THE BIP39 SEED, AND THE CHOICE IS WRITTEN
    /// DOWN BECAUSE IT CANNOT BE CHANGED LATER.** `to_seed` is PBKDF2-HMAC-SHA512
    /// over the phrase, 2048 rounds, empty passphrase; Ed25519 wants 32 bytes of
    /// secret and the seed is 64. SLIP-0010 would be the ceremonious answer and
    /// buys nothing here: there is ONE key, no derivation tree, and no
    /// interoperability with a wallet that would expect a path. What matters is
    /// that this line never moves — a different derivation is a different person
    /// identity from the same words, which reads to the reader as their phrase
    /// having stopped working.
    fn signing_key(&self) -> SigningKey {
        let seed = self.0.to_seed("");
        let mut secret = [0u8; 32];
        secret.copy_from_slice(&seed[..32]);
        SigningKey::from_bytes(&secret)
    }
}

/// A person, named by the public half of their root key.
///
/// Hex rather than base32: this is compared and stored, never typed by a human
/// — the twelve words are the part people handle — and hex has no case question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonId(String);

impl PersonId {
    fn of(key: &VerifyingKey) -> Self {
        Self(hex(key.as_bytes()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PersonId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Where the device role is written.
pub fn device_role_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(DEVICE_ROLE_FILE)
}

/// This device's circle role, or `None` when it has never had one.
///
/// Absent is NOT `leaf`: a device that has never taken part in a circle has no
/// role at all, and defaulting it to leaf would make "have I set this up" and
/// "am I a leaf" the same answer.
pub fn device_role(root: &Path) -> Result<Option<DeviceRole>> {
    let path = device_role_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text.parse()?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::Identity(format!(
            "could not read {}: {e}",
            path.display()
        ))),
    }
}

/// Write this device's circle role.
pub fn set_device_role(root: &Path, role: DeviceRole) -> Result<()> {
    /* Same class as the person record beside it: `forget` writes this BEFORE
    destroying the only copy of the root, so a half-written role is a device
    that has lost its key and cannot say what it has become. */
    crate::store::write_atomic(&device_role_path(root), role.word().as_bytes())
}

/// Serialises every mutation of the root.
///
/// ⚠️ **`ensure` IS READ-THEN-WRITE, AND THE DOC SAID IT WAS IDEMPOTENT.** Two
/// callers — the panel's button and a circle pairing, which is exactly the pair
/// that races — could both read `None`, both mint, and both write; the last
/// write won and the first caller walked away holding a `PersonId` that is no
/// longer this device's. It may already have handed that id to a peer, which
/// then verifies nothing this device can sign.
///
/// A process-wide lock, not a keychain compare-and-set: `Keychain` has no CAS
/// and the OS keychain does not offer one. This closes the race inside one app,
/// which is the only place these paths run — two Paper processes on one data
/// root is already refused by the advisory lock the CLI takes.
static ROOT_LOCK: Mutex<()> = Mutex::new(());

fn hold_root() -> MutexGuard<'static, ()> {
    /* A poisoned lock means a previous holder panicked mid-mutation. The state
    on disk is whatever it is; refusing every future call would turn one
    panic into a permanently unusable identity, so the guard is taken and the
    read below re-establishes the truth. */
    ROOT_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// The person root, if this device holds one.
pub fn root(keychain: &dyn Keychain) -> Result<Option<Phrase>> {
    match keychain.read(ROOT_ACCOUNT)? {
        Some(words) => Ok(Some(Phrase::parse(&words)?)),
        None => Ok(None),
    }
}

/// Where a leaf records the person it belongs to.
pub fn person_path(root_dir: &Path) -> PathBuf {
    root_dir.join(PEER_DIR).join(PERSON_FILE)
}

/// The person recorded on disk, for a device that holds no root.
fn recorded_person(root_dir: &Path) -> Result<Option<PersonId>> {
    match std::fs::read_to_string(person_path(root_dir)) {
        Ok(text) => {
            let id = text.trim();
            if id.len() != 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(Error::Identity(
                    "the recorded person id is not a key".into(),
                ));
            }
            Ok(Some(PersonId(id.to_owned())))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::Identity(format!(
            "could not read the person id: {e}"
        ))),
    }
}

/// The person this device belongs to, if it has one.
///
/// The root when it holds one; otherwise what a demotion recorded. A leaf still
/// belongs to somebody — see `PERSON_FILE`.
pub fn person_id_at(keychain: &dyn Keychain, root_dir: &Path) -> Result<Option<PersonId>> {
    if let Some(phrase) = root(keychain)? {
        return Ok(Some(PersonId::of(&phrase.signing_key().verifying_key())));
    }
    recorded_person(root_dir)
}

/// The person this device's ROOT names, if it holds one.
pub fn person_id(keychain: &dyn Keychain) -> Result<Option<PersonId>> {
    Ok(root(keychain)?.map(|phrase| PersonId::of(&phrase.signing_key().verifying_key())))
}

/// Make a person identity if there is not one yet, and answer it either way.
///
/// ⚠️ **IDEMPOTENT, AND THAT IS THE SAFETY PROPERTY.** This is called from
/// every path that needs an identity — the first circle pairing, adding a
/// second device — and two of them racing must not mint two roots. A second
/// mint is not a recoverable mistake: it silently replaces the identity every
/// existing delegation was signed under, so every other device in the circle
/// goes quiet and the reader is told nothing.
///
/// Returns the phrase so a caller that has somewhere to show it can. Nothing is
/// shown at creation — see the module header — but the ladder in
/// `identity.md` §"Skip is the DEFAULT" needs the words in hand at the two
/// moments it names.
pub fn ensure(keychain: &dyn Keychain, root_dir: &Path) -> Result<(PersonId, Phrase)> {
    let _held = hold_root();
    /* ⚠️ **A LEAF MUST NOT MINT ITSELF A NEW PERSON.** It already belongs to
     * one; minting here would silently promote a demoted device to the home of
     * an identity nobody in the circle has ever heard of, and its owner would
     * see a working panel that no peer answers. What a leaf needs is a fresh
     * delegation from home, over the introduction ALPN — not a new person. */
    if root(keychain)?.is_none() {
        if let Some(theirs) = recorded_person(root_dir)? {
            return Err(Error::Identity(format!(
                "this device is a leaf of {theirs} — ask that person's home device for a delegation"
            )));
        }
    }
    if let Some(existing) = root(keychain)? {
        let id = PersonId::of(&existing.signing_key().verifying_key());
        /* The role can be missing from an identity that IS present — a restore
        writes the phrase before it knows which machine it landed on. */
        if device_role(root_dir)?.is_none() {
            set_device_role(root_dir, DeviceRole::Home)?;
        }
        return Ok((id, existing));
    }
    let phrase = mint()?;
    keychain.write(ROOT_ACCOUNT, &phrase.words())?;
    /* The device that mints IS home, by construction: it is the only one that
    has ever held the root. */
    set_device_role(root_dir, DeviceRole::Home)?;
    Ok((PersonId::of(&phrase.signing_key().verifying_key()), phrase))
}

/// Twelve fresh words.
///
/// `rand::random`, which is `ThreadRng` — ChaCha12 seeded from the operating
/// system and reseeded as it runs, i.e. a CSPRNG and not a convenience. The
/// same source `pairing.rs` draws its 128-bit pairing secret from, so there is
/// one answer in this crate to "where does a secret come from" rather than two.
/// (An earlier draft of this comment claimed `rand` was NOT good enough here
/// and reached for `OsRng` directly; that was wrong about the crate and the
/// code did not compile, which is how it got read twice.)
fn mint() -> Result<Phrase> {
    let entropy: [u8; PHRASE_ENTROPY_BYTES] = rand::random();
    let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
        .map_err(|e| Error::Identity(format!("could not make a recovery phrase: {e}")))?;
    Ok(Phrase(mnemonic))
}

/// Take a person identity back from twelve words.
///
/// ⚠️ **REFUSES TO OVERWRITE A DIFFERENT IDENTITY.** Restoring onto a device
/// that already holds a root is either a no-op (the same words) or the silent
/// destruction of the identity every one of this reader's other devices is
/// delegated under. The second must be a decision somebody makes on purpose,
/// through [`forget`], and not a side effect of typing the wrong phrase into
/// the wrong machine.
pub fn restore(keychain: &dyn Keychain, root_dir: &Path, words: &str) -> Result<PersonId> {
    let _held = hold_root();
    let phrase = Phrase::parse(words)?;
    let id = PersonId::of(&phrase.signing_key().verifying_key());
    if let Some(existing) = root(keychain)? {
        let held = PersonId::of(&existing.signing_key().verifying_key());
        if held != id {
            return Err(Error::Identity(
                "this device already holds a different person identity; forget it first".into(),
            ));
        }
        /* ⚠️ **THE ROLE IS REPAIRED ON THE WAY OUT, and this used to return
         * early.** The keychain is written before the role, so a failed role
         * write left the phrase stored and the device with no role at all —
         * and a retry with the SAME phrase took this branch and never fixed
         * it. Repeating the operation is how a reader recovers from a
         * half-finished one; it has to actually finish it. */
        if device_role(root_dir)? != Some(DeviceRole::Home) {
            set_device_role(root_dir, DeviceRole::Home)?;
        }
        return Ok(id);
    }
    keychain.write(ROOT_ACCOUNT, &phrase.words())?;
    set_device_role(root_dir, DeviceRole::Home)?;
    Ok(id)
}

/// Drop the root this device holds.
///
/// The keychain copy only — the phrase, if the reader wrote it down, still
/// works. That asymmetry is the point: this is how a device stops being home,
/// not how an identity is destroyed.
pub fn forget(keychain: &dyn Keychain, root_dir: &Path) -> Result<()> {
    let _held = hold_root();
    /* ⚠️ **THE PERSON IS RECORDED BEFORE THE ROOT GOES, or the device forgets
     * WHOSE leaf it is along with the ability to sign.** Written first for the
     * same reason the role is: of the two orders, only this one has a
     * recoverable failure. */
    if let Some(id) = person_id(keychain)? {
        crate::store::write_atomic(&person_path(root_dir), id.as_str().as_bytes())?;
    }
    /* ⚠️ **THE ROLE GOES FIRST, AND THE DELETE USED TO.** Both halves can fail
     * independently, and only one order has a recoverable failure: role-then-
     * delete leaves a device marked `leaf` that still holds a root, which
     * `sign_delegation` refuses on the role — safe, and repairable by calling
     * this again. The other order deletes the only copy and then fails to
     * record what the device has become, which nothing can repair. */
    set_device_role(root_dir, DeviceRole::Leaf)?;
    keychain.delete(ROOT_ACCOUNT)
}

/// What a delegation says: this person vouches for this device, for this long.
///
/// ⚠️ **`roster` IS INSIDE THE SIGNED OBJECT.** A delegation that did not carry
/// the roster version it was minted against would let a peer accept a device
/// admitted under a roster the reader has since replaced — the signature would
/// still check, because the thing that changed was not signed.
/// ⚠️ **`rename_all` FOR `Custody`'S REASON — this is the same trap, found by
/// looking for it rather than by being bitten twice.** `SignedDelegation`
/// flattens this, so `not_before`/`not_after` would have reached TypeScript in
/// snake_case exactly the way `has_identity` did. Nothing reads it yet, which
/// is precisely why it was worth changing now: there are no peers to break,
/// and the alternative is discovering it from a second dead-looking button.
///
/// The SIGNATURE is unaffected: `signed_bytes` writes the fields by hand, in a
/// fixed order, so what serde calls them was never part of what is signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub person: PersonId,
    /// The device's public key, hex — an iroh `NodeId`'s bytes.
    pub device: String,
    /// Integer milliseconds, UTC. `identity.md` §"Time semantics".
    pub not_before: i64,
    pub not_after: i64,
    /// Which roster epoch this was minted under.
    pub roster: u64,
}

impl Delegation {
    /// The exact bytes a signature covers.
    ///
    /// ⚠️ **DOMAIN SEPARATED, AND FIELD ORDER IS FIXED HERE RATHER THAN LEFT TO
    /// A SERIALISER.** A signature over `serde_json` output is a signature over
    /// whatever that crate's field ordering happens to be this release; two
    /// builds disagreeing about it is a delegation that verifies on one machine
    /// and not the other, with nothing to point at. The prefix keeps a
    /// delegation's bytes from ever being read as some other signed object's.
    pub fn signed_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"paper/circle/delegation/1\n");
        out.extend_from_slice(self.person.as_str().as_bytes());
        out.push(b'\n');
        out.extend_from_slice(self.device.as_bytes());
        out.push(b'\n');
        out.extend_from_slice(self.not_before.to_string().as_bytes());
        out.push(b'\n');
        out.extend_from_slice(self.not_after.to_string().as_bytes());
        out.push(b'\n');
        out.extend_from_slice(self.roster.to_string().as_bytes());
        out
    }
}

/// A delegation and the root signature over it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedDelegation {
    #[serde(flatten)]
    pub delegation: Delegation,
    /// Hex, 64 bytes.
    pub signature: String,
}

/// Sign a delegation with the root this device holds.
///
/// ⚠️ **THE ROLE IS CHECKED BEFORE THE KEY IS**, which is WI-22.B1's falsifier
/// as a line of code. A leaf that has somehow come to hold a root — restored
/// onto the wrong machine, or compromised — is refused on the ROLE, so *"a
/// device that holds no root key can mint itself a fresh delegation"* is not
/// merely unlikely but unreachable: there is no ordering of custody and role
/// that lets a leaf mint.
pub fn sign_delegation(
    keychain: &dyn Keychain,
    root_dir: &Path,
    delegation: Delegation,
) -> Result<SignedDelegation> {
    /* ⚠️ **THE SIGNER CHECKS THE WINDOW; IT DOES NOT ACCEPT ONE ON TRUST.**
     * Every field here arrives from a caller, and the delegate command is
     * reachable from the renderer — so a delegation with `not_after: i64::MAX`
     * was one call away, and expiry is the one guarantee that survives a peer
     * who never connects again. A signer that will sign anything is not a
     * signer, it is an oracle. */
    if delegation.not_after <= delegation.not_before {
        return Err(Error::Identity(
            "a delegation must end after it begins".into(),
        ));
    }
    let lifetime = delegation
        .not_after
        .checked_sub(delegation.not_before)
        .ok_or_else(|| Error::Identity("that delegation window is not a window".into()))?;
    if lifetime > MAX_LIFETIME_MS {
        return Err(Error::Identity(format!(
            "a delegation may not run longer than {} days",
            MAX_LIFETIME_MS / (24 * 60 * 60 * 1000)
        )));
    }
    /* The device is a key, not a label. An id that is not one produces a
    delegation nothing can ever match against a real endpoint — signed,
    valid, and meaningless. */
    if delegation.device.len() != DEVICE_ID_HEX
        || !delegation
            .device
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Identity(
            "that device id is not an endpoint key".into(),
        ));
    }
    let role = device_role(root_dir)?
        .ok_or_else(|| Error::Identity("this device has no circle role".into()))?;
    if !role.may_mint() {
        return Err(Error::Identity(format!(
            "a {role} device does not mint delegations"
        )));
    }
    let phrase = root(keychain)?
        .ok_or_else(|| Error::Identity("this device does not hold the person root".into()))?;
    let key = phrase.signing_key();
    if PersonId::of(&key.verifying_key()) != delegation.person {
        return Err(Error::Identity(
            "that delegation names a different person than this device's root".into(),
        ));
    }
    let signature: Signature = key.sign(&delegation.signed_bytes());
    Ok(SignedDelegation {
        delegation,
        signature: hex(&signature.to_bytes()),
    })
}

/// Sign arbitrary bytes with this device's root, under a domain.
///
/// ⚠️ **THE DOMAIN IS NOT DECORATION.** Two kinds of signed object under one
/// key must never be readable as each other: without a prefix, a delegation's
/// bytes and a roster's could in principle be arranged to collide, and a
/// signature over one would verify as the other. Every signed thing in this
/// crate goes through here, so there is one place the separation is decided
/// rather than one per caller.
///
/// The role gate is `sign_delegation`'s reason, and applies identically: a leaf
/// does not speak for the person, whatever it happens to hold.
pub fn sign_as_person(
    keychain: &dyn Keychain,
    root_dir: &Path,
    domain: &str,
    payload: &[u8],
) -> Result<String> {
    let role = device_role(root_dir)?
        .ok_or_else(|| Error::Identity("this device has no circle role".into()))?;
    if !role.may_mint() {
        return Err(Error::Identity(format!(
            "a {role} device does not sign for the person"
        )));
    }
    let phrase = root(keychain)?
        .ok_or_else(|| Error::Identity("this device does not hold the person root".into()))?;
    let signature: Signature = phrase.signing_key().sign(&domained(domain, payload));
    Ok(hex(&signature.to_bytes()))
}

/// Whether `person` really signed those bytes under that domain.
pub fn verify_as_person(person: &str, domain: &str, payload: &[u8], signature: &str) -> Result<()> {
    let key_bytes: [u8; 32] = unhex(person)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Error::Identity("that person id is not a key".into()))?;
    let key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|e| Error::Identity(format!("that person id is not a key: {e}")))?;
    let sig_bytes: [u8; 64] = unhex(signature)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Error::Identity("that signature is not 64 bytes of hex".into()))?;
    key.verify(
        &domained(domain, payload),
        &Signature::from_bytes(&sig_bytes),
    )
    .map_err(|_| Error::Identity("that was not signed by the person it names".into()))
}

/// `<domain>\n<payload>` — see [`sign_as_person`].
fn domained(domain: &str, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(domain.len() + payload.len() + 1);
    out.extend_from_slice(domain.as_bytes());
    out.push(b'\n');
    out.extend_from_slice(payload);
    out
}

/// Whether a signed delegation really was signed by the person it names.
///
/// ⚠️ **NOT CALLED YET, AND DELIBERATELY NOT DELETED.** This is the RECEIVING
/// half of WI-22.B1: a page arrives carrying its delegation, and checking it is
/// what `checkPage`'s `maySpeak` parameter exists to be given. It is built and
/// tested with the minting half because a signature format is one decision — a
/// verifier written later, against the bytes rather than against the writer, is
/// how the two come to disagree about field order and nobody finds out until a
/// second device joins.
#[allow(
    dead_code,
    reason = "the receiving half — consumed by WI-22.C1's page check"
)]
///
/// The person id IS the public key, so there is no key to look up and no
/// directory to be out of date — checking the signature and checking the
/// identity are one operation.
pub fn verify_delegation(signed: &SignedDelegation) -> Result<()> {
    let key_bytes = unhex(signed.delegation.person.as_str())
        .ok_or_else(|| Error::Identity("that person id is not a key".into()))?;
    let key_bytes: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| Error::Identity("that person id is the wrong length".into()))?;
    let key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|e| Error::Identity(format!("that person id is not a key: {e}")))?;
    let sig_bytes = unhex(&signed.signature)
        .ok_or_else(|| Error::Identity("that signature is not hex".into()))?;
    let sig_bytes: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| Error::Identity("that signature is the wrong length".into()))?;
    key.verify(
        &signed.delegation.signed_bytes(),
        &Signature::from_bytes(&sig_bytes),
    )
    .map_err(|_| Error::Identity("that delegation was not signed by the person it names".into()))
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    /* ⚠️ **BYTES, NOT STRING SLICES — `&text[i..i + 2]` PANICS ON NON-ASCII.**
     * `len()` is a BYTE count, so an even length says nothing about where the
     * character boundaries are: a four-byte signature like `"aéa"` passed the
     * length test and then split `é` down the middle, which is a panic in a
     * network handler reachable by anyone who can reach the hello door. It
     * should simply have been a `BadSignature`. */
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    bytes
        .chunks_exact(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

/// What the reader should be told about their custody, continuously.
///
/// ⚠️ **A STANDING STATE, NOT A MOMENT.** `identity.md` §"The window closes
/// silently": *"A reader can only be shown the phrase while a working device
/// still holds the key, and a laptop dies without warning. So 'one device, no
/// copy' is a state Paper surfaces continuously — not a moment it hopes to
/// catch. That single line is the difference between lazy custody and
/// negligence."*
/// ⚠️ **`rename_all` IS ON THIS STRUCT, NOT ONLY ON THE ONE THAT FLATTENS IT.**
/// `PersonStatus` carries `#[serde(flatten)] custody` and declares
/// `rename_all = "camelCase"` — and a flattened struct DOES NOT INHERIT it. So
/// the wire carried `personId` beside `has_identity`, `can_show_phrase` and
/// `at_risk`, the TypeScript read `status.hasIdentity` as `undefined`, and the
/// circle panel could never leave its empty state however many identities the
/// reader minted. The button worked perfectly and looked dead.
///
/// Nothing else could catch it: the panel's tests build their fixtures in
/// TypeScript, so they never cross serde at all. `serialises_in_camel_case`
/// below asserts the bytes, which is the only place the two languages actually
/// meet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Custody {
    /// Whether a person identity exists at all. False is the ordinary state for
    /// a reader who has never shared, and is not a warning.
    pub has_identity: bool,
    /// Whether THIS device can still show the phrase.
    pub can_show_phrase: bool,
    pub role: Option<DeviceRole>,
    /// How many devices the roster carries, this one included.
    pub devices: usize,
    /// How many people are in the circle — the ladder's third rung.
    pub circle: usize,
    /// Whether the reader is one dead laptop away from losing the identity.
    ///
    /// ⚠️ **COMPUTED HERE, NOT IN THE UI.** Every surface that shows the
    /// standing marker would otherwise re-derive the condition, and three
    /// copies of "is this reader at risk" is how one of them ends up saying
    /// no while the others say yes.
    pub at_risk: bool,
}

impl Custody {
    /// Whether the reader is one dead laptop away from losing the identity.
    ///
    /// The condition is deliberately narrow: an identity that exists, on a
    /// single device, whose phrase is still showable. Two devices is not this
    /// state, and neither is a reader with no identity at all — warning about
    /// either is how a standing marker becomes wallpaper.
    pub const fn at_risk(&self) -> bool {
        self.has_identity && self.devices <= 1 && self.can_show_phrase
    }
}

/// Read the custody state.
pub fn custody(
    keychain: &dyn Keychain,
    root_dir: &Path,
    devices: usize,
    circle: usize,
) -> Result<Custody> {
    let held = root(keychain)?;
    let state = Custody {
        /* A leaf HAS an identity — it simply cannot sign for it. Reporting no
        identity is what made the panel offer "Start a circle" to a device
        that already belonged to one. */
        has_identity: held.is_some() || recorded_person(root_dir)?.is_some(),
        can_show_phrase: held.is_some(),
        role: device_role(root_dir)?,
        devices,
        circle,
        at_risk: false,
    };
    Ok(Custody {
        at_risk: state.at_risk(),
        ..state
    })
}

/// An in-memory keychain, keyed by data root — TESTS ONLY.
///
/// ⚠️ **`cargo test` MUST NOT TOUCH THE DEVELOPER'S REAL KEYCHAIN, and it did.**
/// The circle-pairing test ran `person::ensure` against `OsKeychain` and left a
/// live `circle-person-root` entry in the login keychain of whoever ran the
/// suite. Worse, it made the test WRONG: the OS keychain is machine-wide, so
/// two `TestNode`s — two data roots, two notional people — read back the same
/// entry and the test asserting they are different people failed on a real
/// defect it could not otherwise have found.
///
/// Keyed by root because that is what a Paper installation is. Two roots are
/// two installations and therefore two people, which is exactly the property
/// the test needs and the production keychain cannot express.
#[cfg(test)]
pub(crate) mod testkit {
    use super::{Keychain, Result};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{LazyLock, Mutex};

    type Store = HashMap<PathBuf, HashMap<String, String>>;
    static MEMORY: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(HashMap::new()));

    #[derive(Debug)]
    pub(crate) struct MemoryKeychain {
        root: PathBuf,
    }

    impl MemoryKeychain {
        pub(crate) fn for_root(root: &Path) -> Self {
            Self {
                root: root.to_path_buf(),
            }
        }
    }

    impl Keychain for MemoryKeychain {
        fn read(&self, account: &str) -> Result<Option<String>> {
            Ok(MEMORY
                .lock()
                .unwrap()
                .get(&self.root)
                .and_then(|entries| entries.get(account).cloned()))
        }
        fn write(&self, account: &str, secret: &str) -> Result<()> {
            MEMORY
                .lock()
                .unwrap()
                .entry(self.root.clone())
                .or_default()
                .insert(account.to_owned(), secret.to_owned());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            if let Some(entries) = MEMORY.lock().unwrap().get_mut(&self.root) {
                entries.remove(account);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct FakeKeychain {
        entries: Mutex<HashMap<String, String>>,
        /// When set, every call fails — a locked keychain, which must not read
        /// as "this reader has no identity".
        refusing: bool,
    }

    impl Keychain for FakeKeychain {
        fn read(&self, account: &str) -> Result<Option<String>> {
            if self.refusing {
                return Err(Error::Identity("keychain refused".into()));
            }
            Ok(self.entries.lock().unwrap().get(account).cloned())
        }
        fn write(&self, account: &str, secret: &str) -> Result<()> {
            if self.refusing {
                return Err(Error::Identity("keychain refused".into()));
            }
            self.entries
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.entries.lock().unwrap().remove(account);
            Ok(())
        }
    }

    /// ⚠️ **THIS USED TO BE NAMED FROM `SystemTime::as_nanos()`, AND IT
    /// COLLIDED.** `cargo test` runs these in parallel threads; two drew the
    /// same number, shared one directory, and a `forget` in one test wrote the
    /// person record that an `ensure` in another then refused to mint over.
    /// It failed once and passed the next three runs — the exact shape of a
    /// defect that gets written off as flakiness. `scratch` counts instead.
    fn temp() -> PathBuf {
        let dir = crate::testutil::scratch("person");
        std::fs::create_dir_all(dir.join(PEER_DIR)).unwrap();
        dir
    }

    #[test]
    fn a_fresh_phrase_is_twelve_words() {
        let phrase = mint().unwrap();
        assert_eq!(phrase.words().split_whitespace().count(), PHRASE_WORDS);
    }

    #[test]
    fn the_phrase_is_the_key_so_the_same_words_are_the_same_person() {
        // The property the whole custody design rests on: there are not two
        // secrets that can diverge, so a restore reproduces the identity
        // exactly rather than something that merely resembles it.
        let phrase = mint().unwrap();
        let again = Phrase::parse(&phrase.words()).unwrap();
        assert_eq!(
            PersonId::of(&phrase.signing_key().verifying_key()),
            PersonId::of(&again.signing_key().verifying_key())
        );
    }

    #[test]
    fn two_phrases_are_two_people() {
        assert_ne!(
            PersonId::of(&mint().unwrap().signing_key().verifying_key()),
            PersonId::of(&mint().unwrap().signing_key().verifying_key())
        );
    }

    /// A phrase whose checksum is definitely wrong.
    ///
    /// ⚠️ **FIXED, BECAUSE THE RANDOM VERSION WAS ~1-IN-16 FLAKY.** A 12-word
    /// BIP39 phrase carries a FOUR-BIT checksum, so swapping one word in a
    /// random mnemonic leaves a valid phrase about one time in sixteen — a test
    /// that fails on a schedule nobody can reproduce.
    const BAD_CHECKSUM: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";

    #[test]
    fn a_mistyped_word_is_refused_rather_than_deriving_someone_else() {
        // The checksum is most of why the phrase carries one: a wrong word
        // otherwise derives a different key in silence, and the reader learns
        // about it as "nobody can see my marks".
        assert!(Phrase::parse(BAD_CHECKSUM).is_err());
        /* And the checksum is the thing being tested, not the word list: every
        word above is a real BIP39 word. */
        assert!(BAD_CHECKSUM.split_whitespace().all(|w| w == "abandon"));
    }

    #[test]
    fn extra_whitespace_is_not_a_different_phrase() {
        let phrase = mint().unwrap();
        let spaced = phrase.words().replace(' ', "   ");
        assert_eq!(Phrase::parse(&spaced).unwrap().words(), phrase.words());
    }

    #[test]
    fn nothing_is_minted_until_it_is_asked_for() {
        // Lazily, at the first moment an identity is actually needed. A reader
        // who never shares never gets one.
        let keychain = FakeKeychain::default();
        let dir = temp();
        assert!(person_id(&keychain).unwrap().is_none());
        assert!(device_role(&dir).unwrap().is_none());
    }

    #[test]
    fn ensure_is_idempotent_so_two_callers_cannot_mint_two_roots() {
        // A second mint silently replaces the identity every existing
        // delegation was signed under. Every other device goes quiet and the
        // reader is told nothing.
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (first, _) = ensure(&keychain, &dir).unwrap();
        let (second, _) = ensure(&keychain, &dir).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn two_threads_calling_ensure_at_once_still_get_one_identity() {
        /* ⚠️ **THE TEST ABOVE IS SEQUENTIAL AND PASSED WITH THE RACE PRESENT.**
        `ensure` reads, then mints, then writes; two callers — the panel's
        button and a circle pairing, which is exactly the pair that races —
        could both read `None` and both write, and the loser walked away with a
        `PersonId` this device can no longer sign for. It may already have
        handed that id to a peer.

        ⚠️ **THE WINDOW IS FORCED OPEN, NOT HOPED FOR.** A first draft released
        two threads from a barrier and asserted they agreed — and it passed with
        the lock REMOVED, because the window between read and write is a few
        microseconds and the schedule rarely lands inside it. A test for a race
        that depends on losing a coin toss is not a test. This keychain sleeps
        INSIDE the write, so without the lock the second thread is guaranteed to
        read `None` while the first is still writing; with the lock it simply
        waits its turn and reads what the first wrote.

        A barrier inside `read` would be the other way to force it, and would
        DEADLOCK against the fix — the first thread would hold the lock while
        waiting for a second thread the lock is keeping out. */
        use std::sync::{Arc, Mutex as StdMutex};
        use std::time::Duration;

        #[derive(Debug, Default)]
        struct SlowKeychain {
            entries: StdMutex<HashMap<String, String>>,
            writes: StdMutex<usize>,
        }
        impl Keychain for SlowKeychain {
            fn read(&self, account: &str) -> Result<Option<String>> {
                Ok(self.entries.lock().unwrap().get(account).cloned())
            }
            fn write(&self, account: &str, secret: &str) -> Result<()> {
                std::thread::sleep(Duration::from_millis(50));
                *self.writes.lock().unwrap() += 1;
                self.entries
                    .lock()
                    .unwrap()
                    .insert(account.to_string(), secret.to_string());
                Ok(())
            }
            fn delete(&self, account: &str) -> Result<()> {
                self.entries.lock().unwrap().remove(account);
                Ok(())
            }
        }

        let keychain: Arc<SlowKeychain> = Arc::new(SlowKeychain::default());
        let dir = Arc::new(temp());

        let hands: Vec<_> = (0..2)
            .map(|_| {
                let keychain = Arc::clone(&keychain);
                let dir = Arc::clone(&dir);
                std::thread::spawn(move || ensure(keychain.as_ref(), dir.as_ref()).unwrap().0)
            })
            .collect();
        let ids: Vec<PersonId> = hands.into_iter().map(|h| h.join().unwrap()).collect();

        assert_eq!(ids[0], ids[1], "two callers minted two identities");
        /* And what they were handed is what the device actually holds. */
        assert_eq!(
            person_id(keychain.as_ref()).unwrap().as_ref(),
            Some(&ids[0])
        );
        /* One mint, so nothing was written over. */
        assert_eq!(*keychain.writes.lock().unwrap(), 1);
    }

    #[test]
    fn a_delegation_may_not_outlive_the_expiry_backstop() {
        /* ⚠️ **EXPIRY IS THE REAL REVOCATION**, and the delegate command is
        reachable from the renderer — so `not_after: i64::MAX` was one IPC call
        away from a delegation nothing can ever stop. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        let err = sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person,
                device: "ab".repeat(32),
                not_before: 0,
                not_after: i64::MAX,
                roster: 1,
            },
        )
        .unwrap_err();
        assert!(format!("{err}").contains("longer than"), "{err}");
    }

    #[test]
    fn a_delegation_must_end_after_it_begins() {
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        for (before, after) in [(10_i64, 10_i64), (10, 5)] {
            let err = sign_delegation(
                &keychain,
                &dir,
                Delegation {
                    person: person.clone(),
                    device: "ab".repeat(32),
                    not_before: before,
                    not_after: after,
                    roster: 1,
                },
            )
            .unwrap_err();
            assert!(format!("{err}").contains("end after it begins"), "{err}");
        }
    }

    #[test]
    fn a_device_id_that_is_not_an_endpoint_key_is_refused() {
        /* A delegation naming something that cannot be an endpoint is signed,
        valid, and matches nothing for ever. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        for bad in ["aa", &"zz".repeat(32), &"AB".repeat(32)] {
            let err = sign_delegation(
                &keychain,
                &dir,
                Delegation {
                    person: person.clone(),
                    device: bad.to_string(),
                    not_before: 0,
                    not_after: 1_000,
                    roster: 1,
                },
            )
            .unwrap_err();
            assert!(format!("{err}").contains("endpoint key"), "{bad}: {err}");
        }
    }

    #[test]
    fn a_non_ascii_signature_is_refused_rather_than_panicking() {
        /* ⚠️ `&text[i..i + 2]` on a str slices BYTES: `"aéa"` is four bytes, so
        the length test passed and the slice split `é` down the middle. That is
        a panic in a network handler anyone who can reach the hello door can
        trigger, where the answer should simply be `BadSignature`. */
        assert_eq!(unhex("aéa"), None);
        assert_eq!(unhex("zz"), None);
        assert_eq!(unhex("ab"), Some(vec![0xab]));
    }

    #[test]
    fn forgetting_records_the_role_before_dropping_the_only_copy() {
        /* Both halves can fail independently, and only one order is
        recoverable: a device marked `leaf` that still holds a root is refused
        on the ROLE and repaired by calling this again. The other order destroys
        the key and then fails to record what the device has become. */
        #[derive(Debug, Default)]
        struct RefusingDelete {
            inner: FakeKeychain,
        }
        impl Keychain for RefusingDelete {
            fn read(&self, a: &str) -> Result<Option<String>> {
                self.inner.read(a)
            }
            fn write(&self, a: &str, s: &str) -> Result<()> {
                self.inner.write(a, s)
            }
            fn delete(&self, _a: &str) -> Result<()> {
                Err(Error::Identity("keychain refused".into()))
            }
        }
        let keychain = RefusingDelete::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();

        assert!(forget(&keychain, &dir).is_err());
        // The role was written first, so the device is already safe.
        assert_eq!(device_role(&dir).unwrap(), Some(DeviceRole::Leaf));
    }

    #[test]
    fn restoring_the_same_phrase_repairs_a_missing_role() {
        /* The keychain is written before the role, so a failed role write left
        the phrase stored and no role at all — and a retry with the SAME phrase
        returned early and never fixed it. Repeating an operation is how a
        reader recovers from a half-finished one. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (_, phrase) = ensure(&keychain, &dir).unwrap();
        std::fs::remove_file(device_role_path(&dir)).unwrap();

        restore(&keychain, &dir, &phrase.words()).unwrap();

        assert_eq!(device_role(&dir).unwrap(), Some(DeviceRole::Home));
    }

    #[test]
    fn the_device_that_mints_is_home() {
        let keychain = FakeKeychain::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();
        assert_eq!(device_role(&dir).unwrap(), Some(DeviceRole::Home));
    }

    #[test]
    fn a_locked_keychain_is_not_a_reader_without_an_identity() {
        // `Ok(None)` and `Err` are different facts. Collapsing them would mint
        // a second identity over the top of the first.
        let keychain = FakeKeychain {
            refusing: true,
            ..Default::default()
        };
        assert!(person_id(&keychain).is_err());
    }

    #[test]
    fn a_leaf_does_not_mint_even_holding_the_root() {
        // ⚠️ WI-22.B1's falsifier, as a test. The ROLE is a gate independent of
        // custody: a leaf holding a root is a compromised identity, not a
        // device that may administer.
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        set_device_role(&dir, DeviceRole::Leaf).unwrap();

        let err = sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person,
                device: "aa".repeat(32),
                not_before: 0,
                not_after: 1,
                roster: 1,
            },
        )
        .unwrap_err();
        assert!(format!("{err}").contains("does not mint"));
    }

    #[test]
    fn home_signs_a_delegation_that_verifies() {
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        let signed = sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person,
                device: "bb".repeat(32),
                not_before: 1_000,
                not_after: 2_000,
                roster: 3,
            },
        )
        .unwrap();
        verify_delegation(&signed).unwrap();
    }

    #[test]
    fn a_delegation_edited_after_signing_does_not_verify() {
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        let mut signed = sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person,
                device: "cc".repeat(32),
                not_before: 1_000,
                not_after: 2_000,
                roster: 3,
            },
        )
        .unwrap();
        // The field a compromised leaf would most like to move.
        signed.delegation.not_after = i64::MAX;
        assert!(verify_delegation(&signed).is_err());
    }

    #[test]
    fn the_roster_is_inside_the_signature() {
        // A delegation that did not carry the roster it was minted against
        // would let a peer accept a device admitted under a roster the reader
        // has since replaced — the signature still checks, because the thing
        // that changed was not signed.
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        let mut signed = sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person,
                device: "dd".repeat(32),
                not_before: 1_000,
                not_after: 2_000,
                roster: 3,
            },
        )
        .unwrap();
        signed.delegation.roster = 4;
        assert!(verify_delegation(&signed).is_err());
    }

    #[test]
    fn one_person_cannot_sign_for_another() {
        let keychain = FakeKeychain::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();
        let stranger = PersonId::of(&mint().unwrap().signing_key().verifying_key());
        let err = sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person: stranger,
                device: "ee".repeat(32),
                not_before: 0,
                not_after: 1,
                roster: 1,
            },
        )
        .unwrap_err();
        assert!(format!("{err}").contains("different person"));
    }

    #[test]
    fn home_cannot_be_revoked_and_a_leaf_can() {
        // Revoking home would leave an identity nothing can ever administer
        // again, so it is succeeded instead.
        assert!(!DeviceRole::Home.is_revocable());
        assert!(DeviceRole::Leaf.is_revocable());
    }

    #[test]
    fn restoring_the_same_phrase_is_not_a_change() {
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, phrase) = ensure(&keychain, &dir).unwrap();
        assert_eq!(restore(&keychain, &dir, &phrase.words()).unwrap(), person);
    }

    #[test]
    fn restoring_a_different_phrase_over_an_identity_is_refused() {
        // Otherwise typing the wrong phrase into the wrong machine silently
        // destroys the identity every other device is delegated under.
        let keychain = FakeKeychain::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();
        let other = mint().unwrap();
        let err = restore(&keychain, &dir, &other.words()).unwrap_err();
        assert!(format!("{err}").contains("already holds a different"));
    }

    #[test]
    fn forgetting_makes_this_device_a_leaf_and_keeps_the_phrase_working() {
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, phrase) = ensure(&keychain, &dir).unwrap();
        forget(&keychain, &dir).unwrap();

        assert!(person_id(&keychain).unwrap().is_none());
        assert_eq!(device_role(&dir).unwrap(), Some(DeviceRole::Leaf));
        // The written-down phrase still names the same person.
        let recovered = Phrase::parse(&phrase.words()).unwrap();
        assert_eq!(
            PersonId::of(&recovered.signing_key().verifying_key()),
            person
        );
    }

    #[test]
    fn a_leaf_can_still_name_the_person_it_belongs_to() {
        /* ⚠️ **`forget` USED TO DESTROY THE ABILITY TO SAY WHOSE LEAF THIS IS.**
        It deleted the phrase and wrote the word `leaf`, and nothing else. The
        device then had no root, so `person_id` answered `None`, `custody`
        reported no identity at all, and nothing on it could build a circle
        hello for the person it still belonged to. A person id is a PUBLIC key
        — what a leaf gives up is the ability to SIGN, which is the whole point
        of demoting it, not the ability to say who it speaks for. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _phrase) = ensure(&keychain, &dir).unwrap();
        forget(&keychain, &dir).unwrap();

        assert!(
            person_id(&keychain).unwrap().is_none(),
            "no root, as intended"
        );
        assert_eq!(person_id_at(&keychain, &dir).unwrap(), Some(person));
    }

    #[test]
    fn a_leaf_has_an_identity_it_simply_cannot_sign_for() {
        // What the panel reads. Reporting no identity offered a device already
        // in a circle the button that starts one.
        let keychain = FakeKeychain::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();
        forget(&keychain, &dir).unwrap();

        let state = custody(&keychain, &dir, 2, 1).unwrap();
        assert!(state.has_identity, "a leaf belongs to somebody");
        assert!(!state.can_show_phrase, "and cannot show the words");
        assert!(!state.at_risk, "two devices, and this one cannot show them");
    }

    #[test]
    fn a_leaf_refuses_to_mint_itself_a_second_person() {
        /* ⚠️ **`ensure` ON A LEAF WOULD HAVE MINTED AN UNRELATED IDENTITY** —
        silently promoting a demoted device to the home of a person nobody in
        the circle has ever heard of. Its owner would see a working panel that
        no peer answers, with nothing anywhere saying why. What a leaf needs is
        a fresh delegation from home, not a new person. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _phrase) = ensure(&keychain, &dir).unwrap();
        forget(&keychain, &dir).unwrap();

        /* `unwrap_err` would need `Phrase: Debug`, and it deliberately has
        none — the words must not be printable by accident. */
        let said = match ensure(&keychain, &dir) {
            Ok(_) => panic!("a leaf minted itself a person"),
            Err(err) => format!("{err}"),
        };
        assert!(said.contains("leaf of"), "says what this device is: {said}");
        assert!(said.contains("delegation"), "and what would fix it: {said}");
        // And it stayed a leaf of the SAME person rather than becoming a home.
        assert_eq!(person_id_at(&keychain, &dir).unwrap(), Some(person));
        assert!(person_id(&keychain).unwrap().is_none());
    }

    #[test]
    fn restoring_the_phrase_makes_the_device_a_home_again() {
        // The recorded person is not a lock: the words are still the authority.
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, phrase) = ensure(&keychain, &dir).unwrap();
        forget(&keychain, &dir).unwrap();

        restore(&keychain, &dir, &phrase.words()).unwrap();
        assert_eq!(person_id(&keychain).unwrap(), Some(person.clone()));
        assert_eq!(person_id_at(&keychain, &dir).unwrap(), Some(person));
        assert!(custody(&keychain, &dir, 1, 0).unwrap().can_show_phrase);
    }

    #[test]
    fn a_corrupt_person_record_is_refused_rather_than_read_as_a_person() {
        /* A truncated write, or a file somebody edited. Reading it as a key
        would have a device announce a person id that verifies nothing, and
        every peer would refuse it with `Stranger` — a failure that looks like
        a network problem. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();
        forget(&keychain, &dir).unwrap();
        std::fs::write(person_path(&dir), "not a key").unwrap();

        assert!(person_id_at(&keychain, &dir).is_err());
        assert!(custody(&keychain, &dir, 1, 0).is_err());
        // And it does not silently mint over the damage.
        assert!(
            ensure(&keychain, &dir).is_err(),
            "no minting over the damage"
        );
    }

    #[test]
    fn a_device_that_never_had_an_identity_still_mints_one() {
        // The refusal above is for a LEAF, not for a reader who has not shared.
        let keychain = FakeKeychain::default();
        let dir = temp();
        assert!(person_id_at(&keychain, &dir).unwrap().is_none());
        assert!(ensure(&keychain, &dir).is_ok());
    }

    #[test]
    fn the_golden_vector_the_typescript_pins() {
        /* ⚠️ **THE TWO LANGUAGES SIGN THE SAME BYTES OR THE CIRCLE DOES NOT
        WORK, AND NOTHING CHECKED IT.** Rust signs with `ed25519-dalek`;
        TypeScript verifies with `@noble/ed25519`. Each was tested against
        itself. `wire.md` names the failure this leaves open in as many words —
        *"two canonicalisers disagreeing about key order is a signature that
        verifies on one machine and fails on another, and the failure would
        look like corruption rather than like a bug."*

        Ed25519 is DETERMINISTIC: one seed and one message give one signature,
        byte for byte. So the three constants below are the same three in
        `crypto.test.ts`, and a divergence in either library fails on one side
        or the other rather than in a reader's book six months from now. */
        const SEED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const PUBLIC_KEY: &str = "207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6";
        const MESSAGE: &str = "paper.circle.1.page\n{\"v\":1}";
        const SIGNATURE: &str = concat!(
            "ad0030e977f97ebc1ce1a26cb7f82be5b6ce8825055c34b3205cd9836362482e",
            "32c1ac229f64eec6fdf18288908cf27913e4e0c847b70268b4b9e5f94dd2310c",
        );

        let seed: [u8; 32] = unhex(SEED).unwrap().try_into().unwrap();
        let key = SigningKey::from_bytes(&seed);

        assert_eq!(hex(key.verifying_key().as_bytes()), PUBLIC_KEY);
        assert_eq!(hex(&key.sign(MESSAGE.as_bytes()).to_bytes()), SIGNATURE);

        /* And it verifies the way `verify_as_person` would — the path the
        receiving side actually takes, not just the signing one. */
        let sig = Signature::from_slice(&unhex(SIGNATURE).unwrap()).unwrap();
        assert!(key
            .verifying_key()
            .verify_strict(MESSAGE.as_bytes(), &sig)
            .is_ok());
    }

    #[test]
    fn serialises_in_camel_case_because_the_typescript_reads_it() {
        /* ⚠️ **THE ONE PLACE THE TWO LANGUAGES MEET.** Every test above this
        builds Rust values and every test in `CirclePane.test.tsx` builds
        TypeScript ones; neither crosses serde, so a field-name mismatch was
        invisible to both. It cost a whole afternoon of "the button does
        nothing" when the button was working every time. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();
        let json = serde_json::to_string(&custody(&keychain, &dir, 1, 0).unwrap()).unwrap();

        for camel in ["hasIdentity", "canShowPhrase", "atRisk"] {
            assert!(json.contains(camel), "{json} is missing {camel}");
        }
        for snake in ["has_identity", "can_show_phrase", "at_risk"] {
            assert!(!json.contains(snake), "{json} still carries {snake}");
        }
    }

    #[test]
    fn a_signed_delegation_serialises_in_camel_case_too() {
        /* The same trap, in the other struct that flattens — found by auditing
        the whole surface rather than by being bitten a second time. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        let signed = sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person,
                device: "ab".repeat(32),
                not_before: 1,
                not_after: 2,
                roster: 3,
            },
        )
        .unwrap();
        let json = serde_json::to_string(&signed).unwrap();

        assert!(json.contains("notBefore"), "{json}");
        assert!(json.contains("notAfter"), "{json}");
        assert!(!json.contains("not_before"), "{json}");
    }

    #[test]
    fn the_signature_does_not_depend_on_what_serde_calls_the_fields() {
        /* `signed_bytes` writes them by hand in a fixed order, which is what
        makes the rename above safe to have made at all. */
        let one = Delegation {
            person: PersonId("aa".repeat(32)),
            device: "bb".repeat(32),
            not_before: 1,
            not_after: 2,
            roster: 3,
        };
        let bytes = String::from_utf8(one.signed_bytes()).unwrap();
        assert!(bytes.starts_with("paper/circle/delegation/1\n"));
        assert!(!bytes.contains("notBefore"));
        assert!(!bytes.contains("not_before"));
    }

    #[test]
    fn one_device_with_the_phrase_still_showable_is_the_state_worth_saying() {
        let keychain = FakeKeychain::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();
        assert!(custody(&keychain, &dir, 1, 0).unwrap().at_risk());
    }

    #[test]
    fn two_devices_is_not_that_state_and_neither_is_no_identity() {
        // A marker that fires for everyone is wallpaper.
        let keychain = FakeKeychain::default();
        let dir = temp();
        ensure(&keychain, &dir).unwrap();
        assert!(!custody(&keychain, &dir, 2, 5).unwrap().at_risk());

        let empty = FakeKeychain::default();
        let bare = temp();
        assert!(!custody(&empty, &bare, 0, 0).unwrap().at_risk());
    }

    #[test]
    fn the_circle_role_file_is_not_the_shelf_role_file() {
        // One file answering two questions is how a satchel demotes itself to
        // a leaf.
        let dir = temp();
        assert_ne!(device_role_path(&dir), crate::role::role_path(&dir));
    }

    #[test]
    fn an_unknown_role_word_is_refused_rather_than_guessed() {
        let dir = temp();
        std::fs::write(device_role_path(&dir), "administrator").unwrap();
        assert!(device_role(&dir).is_err());
    }
}
