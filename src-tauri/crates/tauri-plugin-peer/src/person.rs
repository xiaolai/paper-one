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
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
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

/// The largest integer JavaScript can hold exactly — `Number.MAX_SAFE_INTEGER`.
///
/// ⚠️ **THE WIRE IS A CONTRACT BETWEEN TWO LANGUAGES, AND ONLY ONE OF THEM WAS
/// ENFORCING THIS ONE.** `receive.ts`'s `isDelegation` ends
/// `['notBefore', 'notAfter', 'roster'].every((key) => Number.isSafeInteger(...))`,
/// so a delegation carrying a larger number is refused there — while Rust
/// signed it happily. The result is a delegation that is valid, correctly
/// signed, and unusable by every recipient: the same shape of defect as
/// `signature` vs `sig`, which cost this project every page it ever sent.
///
/// ⚠️ **AND THE GOLDEN VECTOR CANNOT SEE IT.** That test pins the signed BYTES
/// — one seed, one message, one signature — and says nothing about which VALUES
/// the two sides agree to accept. Bytes agreeing is not the same as rules
/// agreeing, and this is the second time that distinction has cost something.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// How far ahead of this device's clock a delegation may start.
///
/// The same five minutes `circle::SKEW_MS` allows a RECEIVER for two machines
/// disagreeing about the time. Named here rather than imported so the signer's
/// bound cannot drift from the receiver's silently.
const CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;

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
    /// ⚠️ **THE `allow` HERE SAID "consumed by WI-22.B2", AND WI-22.B2 SHIPPED
    /// WITHOUT CONSUMING IT.** `circle::revoke_device` exists and calls nothing
    /// of the sort, so the marker read as work in flight when it is not.
    ///
    /// It has no caller because it CANNOT have one where the revocation happens:
    /// a `Roster` carries device ids and no roles (`circle::Roster::devices` is
    /// `Vec<String>`), so `revoke_device` has no way to learn the role of the
    /// device it is asked to withdraw. What actually stops the case is
    /// structural and stronger — signing a roster needs the person root, which
    /// only a home device holds, and `revoke_device` refuses to revoke the
    /// device doing the revoking. So a home device can only be revoked by
    /// itself, and that is already refused by name.
    ///
    /// Kept, with its test, because it is where the RULE is written down: a
    /// surface that offers Revoke must not offer it for a home device, and the
    /// sentence above is what it should ask.
    #[allow(
        dead_code,
        reason = "states the rule; the case is refused structurally — see above"
    )]
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

/// The platforms this build has a real credential store for.
///
/// ⚠️ **KEYRING'S DEFAULT WHEN NOTHING IS CONFIGURED IS A MOCK, AND A MOCK
/// LOSES THE PERSON ROOT WITHOUT SAYING SO.** `Cargo.toml` enables
/// `apple-native`, `windows-native` and `sync-secret-service` — there is no
/// Android backend among them, and keyring 3 falls back to an in-memory store
/// that is scoped to the `Entry`. Every method below makes a FRESH entry, so a
/// write there reports success into a store that is dropped on the next line
/// and the following read finds nothing. The root that identifies the reader to
/// their circle would vanish between two calls, silently, for ever. Found by
/// audit.
///
/// ⚠️ **REFUSED RATHER THAN EMULATED.** A file beside the key is not an
/// answer: `tauri-plugin-inference` already wrote down that the only honest
/// durable store is the keychain, and `identity.rs` keeps `peer/` out of
/// backups precisely because a plaintext sibling is not one. Giving Android a
/// real backend is a change to what this app stores where, which is a decision
/// rather than a defect fix — and until it is made, saying so is better than a
/// store that forgets. Android composes `peer`, `sync` and `public`, none of
/// which needs this; the person commands are reachable and now answer honestly.
const HAS_CREDENTIAL_STORE: bool = cfg!(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
));

impl OsKeychain {
    fn entry(account: &str) -> Result<keyring::Entry> {
        if !HAS_CREDENTIAL_STORE {
            return Err(Error::Identity(
                "this platform has no credential store this build can use, so a person root \
                 cannot be kept here; nothing was stored"
                    .into(),
            ));
        }
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
        Self(crate::keyfile::hex(key.as_bytes()))
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
    ///
    /// ⚠️ **ON THE WIRE IT IS `sig`, AND IT WAS `signature` UNTIL 2026-09-07.**
    /// `wire.md` gives every signed object `sig` — the page's own shape is
    /// `{ person, work, …, delegation, sig }` — and this one struct spelled it
    /// out. The TypeScript verifier's parser is deliberately strict, six
    /// members and no unknown ones (`receive.ts`, `isDelegation`), so a
    /// delegation arriving as `signature` was not merely misread: it was
    /// refused before its signature was ever checked, as `may-not-speak`, and
    /// reported as `bad-delegation`.
    ///
    /// **EVERY page from a Rust-signing device was refused by EVERY TypeScript
    /// verifier.** Measured 2026-09-07 on two machines: a published passage,
    /// a full fetch round each way, `accepted: 0` and
    /// `refusedBecause: {"bad-delegation": 1}`.
    ///
    /// ⚠️ **AND THE GOLDEN VECTOR COULD NOT SEE IT.**
    /// `the_golden_vector_the_typescript_pins` exists for exactly this class
    /// and pins the SIGNED BYTES — one seed, one message, one signature, the
    /// same in both languages. It passes. The two languages agree perfectly
    /// about the bytes and disagreed about the name of the field carrying
    /// them, so the signature verified and was thrown away before verification.
    /// A vector over what is signed says nothing about the envelope that
    /// carries it; `a_delegation_is_wire_shaped` below is that missing half.
    ///
    /// `alias` keeps every `circle-mine.json` already on disk readable — the
    /// signature covers hand-ordered bytes and never the field names, which is
    /// what `the_signature_does_not_depend_on_what_serde_calls_the_fields`
    /// established and what makes this rename safe.
    #[serde(rename = "sig", alias = "signature")]
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
    now: i64,
) -> Result<SignedDelegation> {
    /* ⚠️ **THE SIGNER CHECKS THE WINDOW; IT DOES NOT ACCEPT ONE ON TRUST.**
     * Every field here arrives from a caller, and the delegate command is
     * reachable from the renderer — so a delegation with `not_after: i64::MAX`
     * was one call away, and expiry is the one guarantee that survives a peer
     * who never connects again. A signer that will sign anything is not a
     * signer, it is an oracle. */
    /* ⚠️ **EVERY NUMBER THE WIRE CARRIES, AGAINST THE RANGE THE OTHER SIDE
     * ACCEPTS.** `isDelegation` refuses anything outside JavaScript's exact
     * integer range, so signing one produces a delegation no recipient can
     * use — correctly signed and permanently refused, with nothing anywhere
     * naming the cause. Refused at the signer, where it is one line. */
    for (name, value) in [
        ("notBefore", delegation.not_before),
        ("notAfter", delegation.not_after),
        ("roster", delegation.roster as i64),
    ] {
        if !(0..=MAX_SAFE_INTEGER).contains(&value) {
            return Err(Error::Identity(format!(
                "a delegation's {name} must be between 0 and {MAX_SAFE_INTEGER} — the range the wire's other side can hold exactly"
            )));
        }
    }
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
    /* ⚠️ **THE BACKSTOP CAPPED THE WINDOW'S LENGTH AND NOT WHERE IT SITS.**
     * `peer_person_delegate` is reachable from the renderer and passed
     * `not_before` straight through, so a device could mint a 90-day window
     * starting a year out, and another starting the year after that — a
     * stockpile of delegations that stay valid long after this device should
     * have lost the authority to speak. A peer that misses the revocation
     * accepts every one of them. "90 days" then describes each window's
     * length and nothing about the horizon, which is not what a backstop is.
     *
     * The tolerance is `SKEW_MS`, the same five minutes `live()` already
     * allows for two machines disagreeing about the clock — deliberately no
     * more: it is what absorbs skew, not a window for issuing ahead. */
    if delegation.not_before > now.saturating_add(CLOCK_SKEW_MS) {
        return Err(Error::Identity(
            "a delegation may not start in the future — the expiry backstop bounds the window's length, and this bounds where it sits".into(),
        ));
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
    /* ⚠️ **THE ROLE AND THE ROOT ARE READ UNDER ONE LOCK, AND THEY WERE NOT.**
     * `forget` demotes the role and then deletes the root, in that order and
     * under `ROOT_LOCK`, because only that order fails recoverably. Read
     * without the lock, a signer could see `Home`, have `forget` run to
     * completion beside it, and then read the root — which is still there
     * until the keychain delete lands, and stays there for ever if that delete
     * FAILS, which is the case the ordering deliberately leaves possible. The
     * role gate is then decided on a role the device no longer has. Held
     * across both reads and the signature, so a demotion either happens wholly
     * before this delegation or wholly after it. */
    let _held = hold_root();
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
        signature: crate::keyfile::hex(&signature.to_bytes()),
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
    /* Under the lock, for `sign_delegation`'s reason: a role read before a
    demotion and a root read after it is a signature a leaf produced. */
    let _held = hold_root();
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
    Ok(crate::keyfile::hex(&signature.to_bytes()))
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
    /* ⚠️ **`verify_strict`, BECAUSE THE OTHER SIDE IS STRICT.** `verify` accepts
     * small-order and non-canonical public keys that `@noble/ed25519` refuses
     * — `crypto.ts`'s `unusable` exists to reject exactly those — so a proof
     * Rust called valid could be one TypeScript will not. The golden-vector
     * test already used `verify_strict`, which means production and test
     * disagreed about acceptance while agreeing about bytes. */
    key.verify_strict(
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
/// The RECEIVING half of WI-22.B1: a page arrives carrying its delegation, and
/// this is what checks it.
///
/// ⚠️ **THIS SAID "NOT CALLED YET" AND CARRIED AN `allow(dead_code)` FOR IT.**
/// `circle.rs`'s admission path calls it in production. A suppression that has
/// outlived its reason is worse than none: it tells the compiler to stop
/// reporting a fact, and it tells the next reader that a security check is
/// inert when it is load-bearing.
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
    /* `verify_strict` for `verify_as_person`'s reason — the two verifiers must
    not disagree with each other either. */
    key.verify_strict(
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

    /// ⚠️ **THE FEATURE LIST AND THIS CONSTANT MUST AGREE, AND NOTHING ELSE
    /// CHECKS THAT.** `Cargo.toml` enables `apple-native`, `windows-native` and
    /// `sync-secret-service`; if a backend is added or dropped there and this
    /// is not updated, the mismatch is silent in exactly the direction that
    /// hurts — a platform believed to have a store, writing into a mock that
    /// forgets the person root between two calls.
    #[test]
    fn this_platform_agrees_with_the_backends_the_manifest_enables() {
        /* ⚠️ **THE WORKSPACE MANIFEST, BECAUSE THE FEATURES MOVED THERE.**
        Two plugins were keeping one feature list in step by hand; it is
        declared once under `[workspace.dependencies]` now, and this crate's
        own line is `keyring = { workspace = true }` — which names no
        backend at all, so reading it here would have made this test agree
        with nothing. */
        let manifest = include_str!("../../../Cargo.toml");
        let keyring = manifest
            .split("keyring = {")
            .nth(1)
            .expect("the workspace still declares keyring");
        let block = &keyring[..keyring.find('}').expect("the keyring block is closed")];

        let expected = cfg!(target_os = "macos") && block.contains("apple-native")
            || cfg!(target_os = "ios") && block.contains("apple-native")
            || cfg!(target_os = "windows") && block.contains("windows-native")
            || cfg!(target_os = "linux") && block.contains("secret-service");
        assert_eq!(
            HAS_CREDENTIAL_STORE, expected,
            "the manifest's keyring backends and HAS_CREDENTIAL_STORE disagree about this platform"
        );
    }

    /// The other half, so the refusal cannot be satisfied by refusing
    /// everywhere: where a backend IS configured, an entry is obtainable.
    ///
    /// `cfg`-gated rather than asserted — `HAS_CREDENTIAL_STORE` is a `const`,
    /// so asserting it compiles to `assert!(true)` here and to a test that
    /// always fails on a platform without one. Clippy's constant-assertion lint
    /// is what pointed that out.
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "windows",
        target_os = "linux"
    ))]
    #[test]
    fn a_platform_with_a_store_can_open_an_entry() {
        assert!(OsKeychain::entry("paper-test-account").is_ok());
    }
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
    /// A fixed clock for the signer's "may not start in the future" bound.
    /// Every delegation fixture below begins at or before this.
    const NOW: i64 = 1_700_000_000_000;

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
                /* ⚠️ **INSIDE THE WIRE RANGE, ON PURPOSE.** This was `i64::MAX`,
                 * which the wire-range check now refuses FIRST — so the test
                 * would have gone on passing while no longer exercising the
                 * backstop it is named for. The largest value the other side
                 * can hold is still ~285 000 years, which is amply longer than
                 * ninety days. */
                not_after: MAX_SAFE_INTEGER,
                roster: 1,
            },
            NOW,
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
                NOW,
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
                NOW,
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
            NOW,
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
            NOW,
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
            NOW,
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
            NOW,
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
            NOW,
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

        assert_eq!(
            crate::keyfile::hex(key.verifying_key().as_bytes()),
            PUBLIC_KEY
        );
        assert_eq!(
            crate::keyfile::hex(&key.sign(MESSAGE.as_bytes()).to_bytes()),
            SIGNATURE
        );

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
        assert_eq!(
            wire_keys(&custody(&keychain, &dir, 1, 0).unwrap()),
            [
                "atRisk",
                "canShowPhrase",
                "circle",
                "devices",
                "hasIdentity",
                "role"
            ],
        );
    }

    /// The keys a value actually serialises to, sorted.
    ///
    /// ⚠️ **THE WHOLE SET, NEVER `json.contains(name)`.** A `contains` check can
    /// only find a name somebody already suspected, which makes it exactly as
    /// good as the audit that wrote it and no better. The defect below got past
    /// one. Reading the key set asks the question the other way round — what IS
    /// this, rather than does it have the bit I am thinking of — and that is the
    /// only form that can report a field nobody thought about.
    fn wire_keys<T: serde::Serialize>(value: &T) -> Vec<String> {
        let json = serde_json::to_value(value).expect("serialises");
        let mut keys: Vec<String> = json
            .as_object()
            .expect("an object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    /// A keychain that pauses in the middle of a read, so a second caller can
    /// be shown waiting outside the lock.
    #[derive(Debug)]
    struct PausingKeychain {
        inner: FakeKeychain,
        reading: std::sync::mpsc::SyncSender<()>,
        go: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    impl Keychain for PausingKeychain {
        fn read(&self, account: &str) -> Result<Option<String>> {
            if account == ROOT_ACCOUNT {
                self.reading.send(()).unwrap();
                if let Some(go) = self.go.lock().unwrap().take() {
                    go.recv().unwrap();
                }
            }
            self.inner.read(account)
        }
        fn write(&self, account: &str, secret: &str) -> Result<()> {
            self.inner.write(account, secret)
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.inner.delete(account)
        }
    }

    #[test]
    fn a_signature_in_flight_holds_off_a_forgetting() {
        /* ⚠️ **THE ROLE AND THE ROOT WERE READ WITHOUT THE LOCK.** `forget`
        demotes the role and THEN deletes the root — that order on purpose,
        because only it fails recoverably — and both signers read the role,
        then the root, holding nothing. So a signer could pass the role gate as
        `Home`, have a whole `forget` run beside it, and go on to read a root
        that is still there: until the delete lands, and for ever if the delete
        fails, which is the case the ordering deliberately leaves open. The
        signature is then one a leaf produced.

        No timing is asserted. The signer is paused INSIDE its root read; the
        forgetting is started and given time to finish; the assertion is that
        it has NOT, which cannot become true by waiting longer. */
        let dir = temp();
        let original = FakeKeychain::default();
        let (person, _) = ensure(&original, &dir).unwrap();
        /* The same secret, behind a keychain that pauses on the way to it. */
        let seeded = FakeKeychain::default();
        seeded
            .write(ROOT_ACCOUNT, &original.read(ROOT_ACCOUNT).unwrap().unwrap())
            .unwrap();
        let (reading, reached) = std::sync::mpsc::sync_channel(1);
        let (release, go) = std::sync::mpsc::sync_channel(1);
        let paused = std::sync::Arc::new(PausingKeychain {
            inner: seeded,
            reading,
            go: Mutex::new(Some(go)),
        });

        let signing = {
            let keychain = std::sync::Arc::clone(&paused);
            let dir = dir.clone();
            let person = person.clone();
            std::thread::spawn(move || {
                sign_delegation(
                    keychain.as_ref(),
                    &dir,
                    Delegation {
                        person,
                        device: "ab".repeat(32),
                        not_before: NOW,
                        not_after: NOW + 1000,
                        roster: 1,
                    },
                    NOW,
                )
            })
        };
        reached.recv().unwrap();

        let forgetting = {
            let dir = dir.clone();
            std::thread::spawn(move || forget(&FakeKeychain::default(), &dir))
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !forgetting.is_finished(),
            "the forgetting ran while a signature was in flight"
        );
        /* And the role it would have demoted is still the one the signer read. */
        assert_eq!(device_role(&dir).unwrap(), Some(DeviceRole::Home));

        release.send(()).unwrap();
        assert!(signing.join().unwrap().is_ok());
        forgetting.join().unwrap().unwrap();
        assert_eq!(device_role(&dir).unwrap(), Some(DeviceRole::Leaf));
    }

    #[test]
    fn a_delegation_may_not_be_stockpiled_into_the_future() {
        /* ⚠️ **THE BACKSTOP BOUNDED THE WINDOW'S LENGTH AND NOT ITS HORIZON.**
        `peer_person_delegate` is reachable from the renderer and passed
        `not_before` through untouched, so this device could mint a 90-day
        window starting a year out, then another the year after — a stockpile
        that stays valid long after it should have lost the authority to speak,
        and that any peer which misses the revocation will accept. "90 days"
        described each window and nothing about how far ahead they could sit.

        Five minutes of tolerance, which is `SKEW_MS` — what absorbs two
        machines disagreeing about the clock, and deliberately not a window for
        issuing ahead. */
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        let year = 365 * 24 * 60 * 60 * 1000;

        let ahead = sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person: person.clone(),
                device: "ab".repeat(32),
                not_before: NOW + year,
                not_after: NOW + year + 1000,
                roster: 1,
            },
            NOW,
        )
        .unwrap_err();
        assert!(
            format!("{ahead}").contains("may not start in the future"),
            "{ahead}"
        );

        /* And the skew itself is still allowed, or every device with a fast
        clock would be unable to mint at all. */
        assert!(sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person,
                device: "ab".repeat(32),
                not_before: NOW + 60_000,
                not_after: NOW + 120_000,
                roster: 1,
            },
            NOW,
        )
        .is_ok());
    }

    #[test]
    fn a_delegation_carries_no_number_the_other_side_cannot_hold() {
        /* ⚠️ **THE THIRD TIME THIS CLASS HAS COST SOMETHING, AND THE FIRST TIME
        IT IS ASSERTED.** `receive.ts`'s `isDelegation` ends with
        `Number.isSafeInteger` over `notBefore`, `notAfter` and `roster`. Rust
        signed larger values happily, so a delegation could be correctly signed
        and refused by every recipient — exactly what `signature` vs `sig` did,
        and exactly what the golden vector cannot see, because that pins the
        signed BYTES and not the rules for which VALUES are allowed.

        Bytes agreeing is not rules agreeing. */
        const UNSAFE: i64 = 9_007_199_254_740_992; // MAX_SAFE_INTEGER + 1
        let keychain = FakeKeychain::default();
        let dir = temp();
        let (person, _) = ensure(&keychain, &dir).unwrap();
        let good = Delegation {
            person: person.clone(),
            device: "ab".repeat(32),
            not_before: 1,
            not_after: 2,
            roster: 3,
        };
        assert!(sign_delegation(&keychain, &dir, good.clone(), NOW).is_ok());

        for bad in [
            Delegation {
                not_before: UNSAFE,
                not_after: UNSAFE + 1,
                ..good.clone()
            },
            Delegation {
                not_before: -1,
                ..good.clone()
            },
            Delegation {
                roster: u64::MAX,
                ..good.clone()
            },
        ] {
            let refused = sign_delegation(&keychain, &dir, bad, NOW).unwrap_err();
            assert!(
                format!("{refused}").contains("the range the wire's other side can hold exactly"),
                "expected the wire-range refusal, got: {refused}"
            );
        }
    }

    #[test]
    fn a_small_order_key_cannot_forge_a_person() {
        /* ⚠️ **PRODUCTION USED `verify` WHILE THE GOLDEN VECTOR USED
        `verify_strict`.** The test agreed with TypeScript and the shipping code
        did not: `verify` is COFACTORED and accepts small-order public keys,
        which `@noble/ed25519` refuses — `crypto.ts`'s `unusable` exists for
        exactly them. So a proof Rust called valid was one no recipient would
        accept.

        ⚠️ **AND THE FIRST VERSION OF THIS TEST ASSERTED NOTHING.** It used an
        arbitrary signature against the all-zero key, which fails under BOTH
        verifiers — so it passed with `verify` in place and would have shipped
        the change unguarded. Measured, then replaced.

        THIS vector separates them, and was found by trying rather than by
        reasoning: an order-8 public key, R the same point, S zero. The
        cofactored equation is satisfied by torsion alone.

            verify        -> true    (a forgery accepted)
            verify_strict -> false

        Anyone can construct it; there is no secret in it. That is the point. */
        const ORDER_8: &str = "0100000000000000000000000000000000000000000000000000000000000000";
        let forged = format!("{ORDER_8}{}", "00".repeat(32));
        let refused = verify_as_person(ORDER_8, "paper/circle/roster/1", b"anything", &forged);
        assert!(
            refused.is_err(),
            "a small-order key forged a person's signature — production is not using verify_strict"
        );
    }

    #[test]
    fn a_delegation_is_wire_shaped() {
        /* ⚠️ **A TEST STOOD HERE AND PASSED FOR AS LONG AS THE CIRCLE WAS
        BROKEN.** It was called `a_signed_delegation_serialises_in_camel_case_too`
        and it asserted `notBefore`, `notAfter`, and the absence of
        `not_before` — the three names the camelCase audit had just changed. It
        never asked what this object's keys ACTUALLY were. The signature field
        was `signature`; `receive.ts` demands `sig`; nothing in either language
        was looking at that name, so a delegation was refused before its
        signature was ever checked and every page from a Rust-signing device
        died at every TypeScript verifier. Measured on two machines 2026-09-07:
        `accepted: 0`, `refusedBecause: {"bad-delegation": 1}`.

        The camelCase audit is not what failed — `rename_all` cannot see a
        SYNONYM, because `signature` is not snake_case and never was. What
        failed is a check shaped so that only a suspected name could fail it.

        ⚠️ **THESE SIX NAMES ARE `receive.ts`'s `isDelegation`, AND ITS
        `MEMBERS = 6` IS THIS `len()`.** That parser refuses any object with a
        seventh member, so the two are one statement in two languages: adding a
        field here without adding it there does not degrade gracefully, it
        refuses every page silently. Change one, change the other. */
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
            NOW,
        )
        .unwrap();

        assert_eq!(
            wire_keys(&signed),
            ["device", "notAfter", "notBefore", "person", "roster", "sig"],
            "the six `isDelegation` admits, and nothing else",
        );
    }

    #[test]
    fn a_delegation_written_as_signature_is_still_readable() {
        /* Every `circle-mine.json` already on disk spells it `signature`, and
        the alias is what keeps those readable. Without it the rename is a
        silent identity loss on upgrade: the file parses as garbage, the device
        mints a new delegation, and the roster it was admitted under no longer
        matches. */
        let old = serde_json::json!({
            "person": "aa".repeat(32),
            "device": "bb".repeat(32),
            "notBefore": 1,
            "notAfter": 2,
            "roster": 3,
            "signature": "cc".repeat(64),
        });
        let read: SignedDelegation = serde_json::from_value(old).expect("the old spelling reads");
        assert_eq!(read.signature, "cc".repeat(64));
        // And it is re-emitted under the name the wire uses, not the one it arrived as.
        assert_eq!(
            wire_keys(&read),
            ["device", "notAfter", "notBefore", "person", "roster", "sig"],
        );
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
