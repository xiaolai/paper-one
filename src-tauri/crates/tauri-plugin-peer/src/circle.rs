//! Reader-to-reader admission: the second ALPN — WI-22.B3.
//!
//! ## Why there is a second ALPN at all
//!
//! `session.rs` refuses an unknown endpoint before reading a byte, which is
//! right for the transport it guards and is exactly the problem for a NEW
//! device: a leaf cannot present the delegation that authorises it, because it
//! is hung up on first. `identity.md` §"The introduction path" answers that
//! with a second ALPN rather than a hole in the first:
//!
//! > On it, an unknown endpoint may send **exactly one frame** and receive one
//! > answer.
//!
//! The ordinary ALPN keeps its flat refusal. Nothing about `session.rs`'s
//! guarantee is weakened — a stranger still cannot open a session — and the
//! only thing this door does is decide whether an endpoint should be added to
//! the allow-list, after which the dial is retried and proceeds unchanged.
//!
//! ## Bounded before it is parsed
//!
//! ⚠️ **ONE FRAME, SIZE-CAPPED, ONE ANSWER, THEN CLOSED.** `importLimits.ts`'s
//! rule applied to a socket a stranger can open: the cap is checked against the
//! declared length before a byte of body is read, so a hostile peer cannot make
//! this side allocate by claiming a large frame. 64 KiB rather than
//! `frame::MAX_FRAME`'s 4 MiB — a hello is a delegation, a roster and a
//! signature, and a megabyte of it is not a big roster, it is an attack.
//!
//! ## What the decision is NOT allowed to be
//!
//! ⚠️ **[`admit`] IS PURE, AND THAT IS THE TESTABLE PART.** Every reason to
//! refuse is a value it returns, not an early `return` buried in an async
//! transport function. The whole reason WI-22.B3's falsifier could not be run
//! before is that admission did not exist as anything a test could call.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use iroh::endpoint::{Connection, VarInt};
use tokio::time::timeout;

use crate::error::{Error, Result};
use crate::identity::PEER_DIR;
use crate::person::{self, SignedDelegation};

/// The introduction door. Distinct from `PEER_ALPN`, deliberately.
pub const CIRCLE_HELLO_ALPN: &[u8] = b"paper/circle-hello/1";

/// The most a hello may be, checked before the body is read.
pub const MAX_HELLO: u32 = 64 * 1024;

/// The most introductions one node serves at once.
///
/// ⚠️ **THIS IS THE ONLY DOOR AN UNKNOWN ENDPOINT MAY SAY ANYTHING ON**, and it
/// was the only one with no bound on how many may say it. Every other limit
/// here is per-connection — a timeout, a frame cap — and none of them stops a
/// peer opening ten thousand connections instead of one big frame. Each costs
/// a file read and TWO ed25519 verifications before anything can refuse it, so
/// the work is amplified on the defender's side, which is the shape that
/// matters.
///
/// Eight rather than sixteen: a hello is a handshake a human is waiting on, not
/// a transfer. If eight are genuinely in flight, a ninth caller retrying in a
/// second is a better outcome than a queue.
pub const MAX_HELLOS: usize = 8;

/// ±5 minutes on `not_before`.
///
/// ⚠️ **AND NONE ON `not_after`** — see [`live`]. `identity.md` §"Time
/// semantics" is explicit that the asymmetry is the point: a tolerance on
/// expiry is an extension granted to exactly the device you are trying to stop.
pub const SKEW_MS: i64 = 5 * 60 * 1000;

/// A hello is a delegation, a roster and a signature. A megabyte of it is not
/// a big roster; it is an attack.
///
/// A compile-time assertion rather than a test: this is a relationship between
/// two constants, so a build that violates it should not exist rather than
/// produce a red test.
const _: () = assert!(MAX_HELLO < crate::frame::MAX_FRAME);

/// Where the people this reader has paired with are recorded.
const PEOPLE_FILE: &str = "circle-people.json";

/// A roster version — `identity.md` §"Versions are `(epoch, hlc)`".
///
/// ⚠️ **NOT A COUNTER.** Two devices both incrementing a counter produce two
/// version 4s that are different rosters, and nothing can say which is later.
/// The epoch moves on a deliberate act (a succession); the HLC orders everything
/// inside one epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Version {
    pub epoch: u64,
    /// Hybrid logical clock, integer ms.
    pub hlc: i64,
}

impl Version {
    /// Whether `self` is at least as new as `other`.
    ///
    /// ⚠️ **A TRUE TIE REFUSES RATHER THAN PICKING.** Equal epoch and equal HLC
    /// from two different rosters means two devices minted concurrently and
    /// neither is authoritative; letting either win installs a roster the reader
    /// never authorised. The caller is told, and asks.
    pub fn at_least(self, other: Self) -> bool {
        (self.epoch, self.hlc) >= (other.epoch, other.hlc)
    }
}

/// A person this reader has paired with, and the roster they last presented.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownPerson {
    /// The person id — which IS their root public key.
    pub person: String,
    /// What the reader calls them. Display only; never a key.
    pub display_name: String,
    pub roster: Version,
    /// A fingerprint of the roster's DEVICE SET at `roster`.
    ///
    /// ⚠️ **WITHOUT THIS, `RosterTie` CANNOT EXIST.** A tie is two rosters at
    /// the same `(epoch, hlc)` over DIFFERENT devices — which is what two
    /// devices minting concurrently produce — and telling that apart from the
    /// roster already held requires remembering something about the contents.
    /// The first version of the tie check compared the version against itself
    /// and was therefore unreachable; storing the fingerprint is what makes the
    /// question askable at all.
    ///
    /// Empty for a person met but not yet heard from, which no offered roster
    /// can equal — the first hello is where their roster comes from.
    #[serde(default)]
    pub roster_hash: String,
    /// Device ids this person has revoked, at or below `roster`.
    #[serde(default)]
    pub revoked: Vec<String>,
    /// The devices this person's last accepted roster vouched for.
    ///
    /// ⚠️ **WITHOUT THIS, A REVOCATION CANNOT BE BOUND TO WHO ISSUED IT.** A
    /// hello carries the sender's revocation list, and acting on that list
    /// unchecked lets any person in the circle name ANY device id and have it
    /// evicted — including this reader's own laptop, and including devices
    /// belonging to somebody else entirely. A revocation is a statement about
    /// your own devices; the only way to enforce that is to remember which
    /// devices were ever yours.
    ///
    /// Empty for a person met but not yet heard from, so a first hello revokes
    /// nothing — which is right: nothing has been trusted on their word yet.
    #[serde(default)]
    pub devices: Vec<String>,
}

/// A roster's device set, order-independent.
///
/// Sorted before hashing: two peers listing the same devices in a different
/// order hold the SAME roster, and a fingerprint that said otherwise would
/// report a tie every time the ordering moved.
pub fn roster_hash(devices: &[String]) -> String {
    let mut sorted: Vec<&str> = devices.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.dedup();
    blake3::hash(sorted.join("\n").as_bytes())
        .to_hex()
        .to_string()
}

/// The domain a roster's signature is taken under — see `sign_as_person`.
const ROSTER_DOMAIN: &str = "paper/circle/roster/1";

/// The roster a hello carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Roster {
    pub version: Version,
    /// Device ids this person vouches for.
    pub devices: Vec<String>,
    /// Device ids this person has withdrawn, at or below `version`.
    ///
    /// ⚠️ **INSIDE THE SIGNED OBJECT, WITH THE DEVICE LIST.** Carried beside it
    /// they would be two statements a peer could mix: a current roster with an
    /// older revocation list, or none at all. Revocation only means anything if
    /// it cannot be dropped in transit.
    #[serde(default)]
    pub revocations: Vec<String>,
}

impl Roster {
    /// The exact bytes a signature covers.
    ///
    /// ⚠️ **FIELD ORDER FIXED HERE, AND BOTH LISTS SORTED.** A signature over a
    /// serialiser's output is a signature over that crate's field ordering this
    /// release; sorting means two peers holding the same roster in a different
    /// order produce the same bytes, which is what stops a re-ordering reading
    /// as a different roster.
    pub fn signed_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(self.version.epoch.to_string().as_bytes());
        out.push(b'\n');
        out.extend_from_slice(self.version.hlc.to_string().as_bytes());
        out.push(b'\n');
        for list in [&self.devices, &self.revocations] {
            let mut sorted: Vec<&str> = list.iter().map(String::as_str).collect();
            sorted.sort_unstable();
            sorted.dedup();
            out.extend_from_slice(sorted.join(",").as_bytes());
            out.push(b'\n');
        }
        out
    }
}

/// A roster and the root signature over it.
///
/// ⚠️ **THE ROSTER WAS NOT SIGNED AT ALL, AND ONLY THE DELEGATION WAS.** Any
/// device holding one valid delegation could therefore present
/// `Version { epoch: u64::MAX, hlc: i64::MAX }` with a device list of its
/// choosing: the receiver stored it, and every genuine later roster from that
/// person then read as STALE and was refused for ever. One compromised leaf
/// could lock its owner out of their own circle, permanently, with a number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedRoster {
    #[serde(flatten)]
    pub roster: Roster,
    /// Hex, 64 bytes.
    pub sig: String,
}

/// Sign this person's roster.
pub fn sign_roster(
    keychain: &dyn person::Keychain,
    root_dir: &Path,
    roster: Roster,
) -> Result<SignedRoster> {
    let sig = person::sign_as_person(keychain, root_dir, ROSTER_DOMAIN, &roster.signed_bytes())?;
    Ok(SignedRoster { roster, sig })
}

/// Whether `person` really signed this roster.
pub fn verify_roster(person: &str, signed: &SignedRoster) -> Result<()> {
    person::verify_as_person(
        person,
        ROSTER_DOMAIN,
        &signed.roster.signed_bytes(),
        &signed.sig,
    )
}

/// The one frame a stranger may send.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// The delegation that says this endpoint speaks for that person.
    pub delegation: SignedDelegation,
    /// The roster, ROOT-SIGNED — see `SignedRoster`.
    pub roster: SignedRoster,
}

/// Why a hello was refused, as a value rather than a log line.
///
/// ⚠️ **ONE VARIANT PER REASON, AND THEY ARE NOT COLLAPSED TO A BOOL.** A
/// refusal a reader can act on ("I have not met this person") and one they
/// cannot ("that signature is wrong") are different events, and the surface
/// that shows them needs to tell them apart. They are NOT sent to the peer —
/// see [`Ack`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    /// Not somebody this reader has paired with. The ordinary refusal.
    Stranger,
    /// The delegation was not signed by the person it names.
    BadSignature,
    /// The delegation is for a different endpoint than the one that dialled.
    WrongDevice,
    /// Outside `not_before`/`not_after` — see [`live`].
    NotLive,
    /// This device has been revoked by its own person.
    Revoked,
    /// The roster offered is older than the one held.
    RosterStale,
    /// Same epoch, same HLC, different roster — see [`Version::at_least`].
    RosterTie,
}

/// What admission decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Add this endpoint to the allow-list; the dial will be retried.
    Admit {
        person: String,
        device: String,
        /// The roster to store, when it is newer than the one held.
        roster: Option<Version>,
    },
    Refuse(Refusal),
}

/// What the peer is told.
///
/// ⚠️ **A BARE YES OR NO, CARRYING NO REASON.** The reasons above distinguish
/// "I have never met you" from "your signature is wrong", and telling a stranger
/// which is an oracle: it lets an unknown endpoint probe whether a given person
/// is in this reader's circle, one dial at a time. The reader sees the reason;
/// the peer sees whether the door opened.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub admitted: bool,
}

/// Whether a delegation is live at `now`.
///
/// ⚠️ **±5 MIN ON `not_before`, NONE ON `not_after`.** The asymmetry is a
/// security parameter and not an oversight: tolerance at the start absorbs two
/// machines disagreeing about the clock, and tolerance at the end hands a
/// revoked device five more minutes of speech.
pub fn live(delegation: &person::Delegation, now: i64) -> bool {
    /* `saturating_sub`, because `not_before` is a number off the wire: at
    `i64::MIN` the subtraction panics in a checked build and wraps to a huge
    POSITIVE value in a release one — which reads as "not yet valid" for a
    delegation that should simply be refused. */
    now >= delegation.not_before.saturating_sub(SKEW_MS) && now < delegation.not_after
}

/// The whole admission decision, as a function.
///
/// ⚠️ **THE ORDER OF THE CHECKS IS NOT AN ACCIDENT.** The stranger test comes
/// first because it is the only one that does not need the signature verified,
/// and running signature verification for every endpoint that dials is
/// unbounded work a stranger can ask for. Everything after it is cheap, and the
/// expensive check happens once we already know we care about the answer.
pub fn admit(known: &[KnownPerson], hello: &Hello, endpoint: &str, now: i64) -> Decision {
    let claimed = hello.delegation.delegation.person.as_str();

    let Some(person) = known.iter().find(|k| k.person == claimed) else {
        return Decision::Refuse(Refusal::Stranger);
    };

    /* The delegation must name the endpoint that actually dialled. Without
    this, any admitted person's valid delegation — which is public, it rides
    on every page — would let ANY endpoint in by replaying it. */
    if hello.delegation.delegation.device != endpoint {
        return Decision::Refuse(Refusal::WrongDevice);
    }

    if person::verify_delegation(&hello.delegation).is_err() {
        return Decision::Refuse(Refusal::BadSignature);
    }

    /* ⚠️ **THE ROSTER CARRIES ITS OWN SIGNATURE, AND NOTHING CHECKED ONE.**
     * Verifying the delegation established who is speaking; it said nothing
     * about the roster travelling beside it, which the receiver then STORED. A
     * device with one valid delegation could present any version it liked and
     * freeze out every genuine later roster from its own person. */
    if verify_roster(claimed, &hello.roster).is_err() {
        return Decision::Refuse(Refusal::BadSignature);
    }

    if !live(&hello.delegation.delegation, now) {
        return Decision::Refuse(Refusal::NotLive);
    }

    /* Revocation is checked against BOTH what we already hold and what this
    hello presents. A device revoked in the incoming roster is refused even
    though we are hearing about the revocation in the same breath — a peer
    honest enough to send its own revocation list is still not allowed to
    speak past it. */
    if person.revoked.iter().any(|d| d == endpoint)
        || hello
            .roster
            .roster
            .revocations
            .iter()
            .any(|d| d == endpoint)
    {
        return Decision::Refuse(Refusal::Revoked);
    }

    /* The roster must vouch for this device. A delegation alone is not enough:
    revocation works by the roster moving on, and a device holding an old
    delegation would otherwise outlive its removal. */
    if !hello.roster.roster.devices.iter().any(|d| d == endpoint) {
        return Decision::Refuse(Refusal::Revoked);
    }

    let offered = hello.roster.roster.version;
    /* ⚠️ **THE TIE TEST WAS UNREACHABLE.** It asked the same question as the
     * equality above it, so `Refusal::RosterTie` could never be returned: an
     * equal `(epoch, hlc)` was admitted before anything compared the rosters
     * themselves. Two devices minting concurrently produce exactly that — the
     * same version over DIFFERENT device sets — and the second one silently
     * won by being treated as the roster already held.
     *
     * The comparison is now the CONTENTS at an equal version, which is the
     * question that was meant all along. A roster the reader never authorised
     * is refused and the caller asks. */
    if offered == person.roster {
        /* The CONTENTS decide, because the version cannot: an equal version
        over a different device set is a roster the reader never authorised,
        and admitting it lets whichever peer arrives second silently win. An
        empty fingerprint is a person met and not yet heard from, whose first
        roster is simply learned. */
        let fingerprint = roster_hash(&hello.roster.roster.devices);
        if person.roster_hash == fingerprint {
            /* Byte for byte what is already held — nothing to write. */
            return Decision::Admit {
                person: person.person.clone(),
                device: endpoint.to_string(),
                roster: None,
            };
        }
        return if person.roster_hash.is_empty() {
            /* Met, and heard from for the first time: the fingerprint is
            learned rather than compared. */
            Decision::Admit {
                person: person.person.clone(),
                device: endpoint.to_string(),
                roster: Some(offered),
            }
        } else {
            Decision::Refuse(Refusal::RosterTie)
        };
    }
    if !offered.at_least(person.roster) {
        return Decision::Refuse(Refusal::RosterStale);
    }
    Decision::Admit {
        person: person.person.clone(),
        device: endpoint.to_string(),
        roster: Some(offered),
    }
}

/// Where the known-people file lives.
pub fn people_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(PEOPLE_FILE)
}

/// The people this reader has paired with.
///
/// ⚠️ **A MALFORMED FILE THROWS RATHER THAN READING AS EMPTY**, the rule
/// `peers.rs` already states for its own store: an empty list here is "this
/// reader knows nobody", and a bad parse silently meaning that would refuse
/// every friend the reader has and look like a quiet afternoon.
pub fn known_people(root: &Path) -> Result<Vec<KnownPerson>> {
    let path = people_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| Error::Identity(format!("{} does not parse: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(Error::Identity(format!(
            "could not read {}: {e}",
            path.display()
        ))),
    }
}

/// Replace the known-people file.
pub fn set_known_people(root: &Path, people: &[KnownPerson]) -> Result<()> {
    let text = serde_json::to_string_pretty(people)
        .map_err(|e| Error::Identity(format!("could not write the circle: {e}")))?;
    /* ⚠️ **ATOMIC, BECAUSE `known_people` THROWS ON A MALFORMED FILE.** A plain
     * `fs::write` truncates and then writes; a process that dies in that gap
     * leaves a file that parses as nothing, and the documented behaviour of the
     * reader is to refuse rather than read it as "this reader knows nobody". So
     * a torn write does not quietly empty the circle — it makes every circle
     * surface fail until somebody finds and deletes the file. */
    crate::store::write_atomic(&people_path(root), text.as_bytes())
}

/* ------------------------------------------------ this device's own side */

/// Where the roster this person publishes, and this device's delegation, live.
const MINE_FILE: &str = "circle-mine.json";

/// How long a minted delegation runs. The ceiling `sign_delegation` enforces.
///
/// The same ninety days `src/kernel/core/circle/identity.ts` names as
/// `DELEGATION_MS`; expiry is the real revocation, and the two sides of the
/// app have to agree about how long it takes.
pub const DELEGATION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// Renew two thirds of the way through, not at the end.
///
/// ⚠️ **A DELEGATION THAT RENEWS AT EXPIRY HAS ALREADY EXPIRED FOR ANYBODY
/// WHOSE CLOCK RUNS FAST**, and there is no tolerance on `not_after` —
/// deliberately, see [`SKEW_MS`]. The third that is left is the margin for a
/// laptop that was shut for a fortnight. `RENEW_AT` in `identity.ts` is the
/// same fraction, written the same way round.
const RENEW_NUM: i64 = 2;
const RENEW_DEN: i64 = 3;

/// This device's own side of the circle.
///
/// ⚠️ **NOTHING COULD BUILD A HELLO, BECAUSE NOTHING STORED THIS.** `admit` was
/// written, tested and served, and the crate had no way to produce the value it
/// admits: the roster this person publishes existed only inside test helpers.
/// A door with no key on this side of it.
///
/// Both fields are SIGNED artefacts. A leaf holds them and cannot make them; a
/// home device mints them from the root on demand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mine {
    pub roster: SignedRoster,
    pub delegation: SignedDelegation,
}

/// Where [`Mine`] is kept.
pub fn mine_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(MINE_FILE)
}

/// What this device publishes, if it has ever published anything.
///
/// A malformed file throws, for the reason `known_people` does: reading it as
/// "nothing published" would silently mint a NEW roster at a fresh version and
/// hand every peer a roster older than the one they already hold.
pub fn read_mine(root: &Path) -> Result<Option<Mine>> {
    let path = mine_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| Error::Identity(format!("{} does not parse: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::Identity(format!(
            "could not read {}: {e}",
            path.display()
        ))),
    }
}

/// Replace what this device publishes.
pub fn write_mine(root: &Path, mine: &Mine) -> Result<()> {
    let text = serde_json::to_string_pretty(mine)
        .map_err(|e| Error::Identity(format!("could not write the roster: {e}")))?;
    crate::store::write_atomic(&mine_path(root), text.as_bytes())
}

/// Whether a delegation is far enough through its life to renew.
///
/// Saturating, because this reads a value from disk: a delegation whose window
/// arithmetic overflows is not a reason to panic in a scheduler.
pub fn should_renew(delegation: &person::Delegation, now: i64) -> bool {
    let life = delegation.not_after.saturating_sub(delegation.not_before);
    life > 0 && now.saturating_sub(delegation.not_before) >= life / RENEW_DEN * RENEW_NUM
}

/// The next HLC for a roster, given the one it replaces.
///
/// ⚠️ **`max(now, previous + 1)`, NOT `now`.** A clock that steps backwards —
/// an NTP correction, a laptop restored from a snapshot — would otherwise mint
/// a roster that every peer refuses as `RosterStale`, and the device would be
/// locked out of its own circle until wall time caught up. The HLC is a logical
/// clock that happens to be seeded from the wall.
fn next_hlc(previous: Option<i64>, now: i64) -> i64 {
    match previous {
        Some(was) => now.max(was.saturating_add(1)),
        None => now,
    }
}

/// Mint a fresh roster and delegation for this device, from the root.
///
/// Home devices only — a leaf cannot sign, which is the point of demoting it,
/// and `sign_delegation` refuses on the role before this ever reaches a key.
fn mint_mine(
    keychain: &dyn person::Keychain,
    root_dir: &Path,
    device: &str,
    now: i64,
) -> Result<Mine> {
    let person_id = person::person_id(keychain)?
        .ok_or_else(|| Error::Identity("this device has no person identity".into()))?;
    let held = read_mine(root_dir)?;

    /* The device set carries forward. A mint that started from `[this device]`
    would drop every other device of this person on a renewal — which is a
    silent revocation of the reader's own phone. */
    let mut devices: Vec<String> = held
        .as_ref()
        .map(|m| m.roster.roster.devices.clone())
        .unwrap_or_default();
    if !devices.iter().any(|d| d == device) {
        devices.push(device.to_string());
    }
    let revocations = held
        .as_ref()
        .map(|m| m.roster.roster.revocations.clone())
        .unwrap_or_default();
    let previous = held.as_ref().map(|m| m.roster.roster.version);

    let roster = Roster {
        version: Version {
            /* The epoch moves on a SUCCESSION, not on a renewal — see
            `Version`. Renewing a delegation every sixty days is not a new
            generation of the identity. */
            epoch: previous.map_or(0, |v| v.epoch),
            hlc: next_hlc(previous.map(|v| v.hlc), now),
        },
        devices,
        revocations,
    };
    let delegation = person::sign_delegation(
        keychain,
        root_dir,
        person::Delegation {
            person: person_id,
            device: device.to_string(),
            /* Backdated by the skew allowance so a peer whose clock is a
            little behind does not refuse it as `NotLive` for five
            minutes after it is minted. */
            not_before: now - SKEW_MS,
            not_after: now - SKEW_MS + DELEGATION_MS,
            roster: roster.version.epoch,
        },
    )?;
    let mine = Mine {
        roster: sign_roster(keychain, root_dir, roster)?,
        delegation,
    };
    write_mine(root_dir, &mine)?;
    Ok(mine)
}

/// What this device should present right now, minting or renewing if it can.
///
/// ⚠️ **A LEAF PRESENTS WHAT IT WAS GIVEN AND DOES NOT MINT.** It has no root,
/// so it cannot; what it needs when its delegation runs out is a fresh one from
/// home, and saying so is more use than a signature nobody will accept.
pub fn mine_for(
    keychain: &dyn person::Keychain,
    root_dir: &Path,
    device: &str,
    now: i64,
) -> Result<Mine> {
    let held = read_mine(root_dir)?;
    if let Some(mine) = &held {
        let d = &mine.delegation.delegation;
        let usable = d.device == device
            && now < d.not_after
            && !should_renew(d, now)
            && mine.roster.roster.devices.iter().any(|x| x == device);
        if usable {
            return Ok(mine.clone());
        }
    }
    if person::person_id(keychain)?.is_none() {
        let held = held.ok_or_else(|| {
            Error::Identity("this device has nothing to introduce itself with".into())
        })?;
        return Err(Error::Identity(format!(
            "this device's delegation ran out on {} and only a home device can renew it",
            held.delegation.delegation.not_after
        )));
    }
    mint_mine(keychain, root_dir, device, now)
}

/// Revoke one of this person's own devices.
///
/// ⚠️ **THE ACT THE WHOLE REVOCATION MACHINERY EXISTS FOR, AND IT HAD NO WAY
/// TO HAPPEN.** `Roster::revocations` was carried, signed, verified, bound to
/// its issuer and acted on by the receiver — and nothing anywhere could put a
/// device into that list. A reader whose laptop was stolen had a design
/// document.
///
/// The device is removed from the roster AND named in the revocations, because
/// the two answer different questions: `admit` refuses a device the roster does
/// not vouch for, and refuses one the revocation list names. Removal alone
/// would let a peer holding an older roster keep admitting it — the older
/// roster still vouches — so the explicit statement is what travels.
///
/// Home devices only. A leaf cannot sign, so it cannot say this.
pub fn revoke_device(
    keychain: &dyn person::Keychain,
    root_dir: &Path,
    device: &str,
    now: i64,
) -> Result<Mine> {
    let mine = read_mine(root_dir)?
        .ok_or_else(|| Error::Identity("this device has published no roster".into()))?;
    /* ⚠️ **NOT THE DEVICE DOING THE REVOKING.** It would sign a roster saying
     * it is not allowed to speak, and then be unable to sign the correction —
     * a one-way door into a circle nobody can repair. Giving up a device is
     * `person::forget`, which is a different act with a different warning. */
    if mine.delegation.delegation.device == device {
        return Err(Error::Identity(
            "a device cannot revoke itself — use 'forget the phrase' on the device you are giving up"
                .into(),
        ));
    }
    if mine.roster.roster.revocations.iter().any(|d| d == device) {
        /* Already said. Not an error: pressing it twice is a reader making
        sure, and the answer to that is the state they asked for. */
        return Ok(mine);
    }

    let mut roster = mine.roster.roster.clone();
    roster.devices.retain(|d| d != device);
    roster.revocations.push(device.to_string());
    /* ⚠️ **THE VERSION MUST MOVE, or every peer refuses the new roster as
     * `RosterStale` and the revocation is a local note.** The HLC and not the
     * epoch: a revocation is a change within this generation of the identity,
     * not a succession. */
    roster.version.hlc = next_hlc(Some(roster.version.hlc), now);

    let updated = Mine {
        roster: sign_roster(keychain, root_dir, roster)?,
        delegation: mine.delegation,
    };
    write_mine(root_dir, &updated)?;
    Ok(updated)
}

/// The hello this device sends.
pub fn hello_from(
    keychain: &dyn person::Keychain,
    root_dir: &Path,
    device: &str,
    now: i64,
) -> Result<Hello> {
    let mine = mine_for(keychain, root_dir, device, now)?;
    Ok(Hello {
        delegation: mine.delegation,
        roster: mine.roster,
    })
}

/// Introduce this device to `addr`, and report whether it was admitted.
///
/// ⚠️ **THE OTHER HALF OF `serve`, AND IT DID NOT EXIST.** The door answered
/// and nothing ever knocked: `admit` was tested as a pure function, `serve` by
/// two transport tests that hand-built a hello, and no code path in the running
/// app could produce one. A protocol with one side implemented is a design
/// document.
///
/// The verdict is a plain `bool` because [`Ack`] carries no reason — telling a
/// caller WHICH check failed is the oracle the whole refusal design avoids.
pub async fn introduce(
    node: &std::sync::Arc<crate::node::Node>,
    addr: iroh::EndpointAddr,
) -> Result<bool> {
    let root = node.root().to_path_buf();
    let device = node.id().to_string();
    let keychain = node.keychain();
    let hello = tokio::task::spawn_blocking(move || {
        /* ⚠️ **OFF THE RUNTIME THREAD.** Minting reads the OS keychain, which
         * blocks — on macOS behind a UI prompt that a human may take a minute
         * to answer. Doing it inline stalls every other connection this node
         * is serving. */
        hello_from(keychain.as_ref(), &root, &device, now_ms())
    })
    .await
    .map_err(|e| Error::Identity(format!("the introduction was dropped: {e}")))??;

    let conn = timeout(
        HELLO_TIMEOUT,
        node.endpoint().connect(addr, CIRCLE_HELLO_ALPN),
    )
    .await
    .map_err(|_| Error::Timeout("dialling the circle door"))?
    .map_err(|e| Error::Identity(format!("could not reach that device: {e}")))?;

    let spoke = say_hello(&conn, &hello).await;
    /* Closed either way, and with a reason: an introduction that is dropped
    rather than closed leaves the far side holding a connection until its
    own idle timeout. */
    conn.close(VarInt::from_u32(0), b"introduced");
    spoke
}

/// One hello out, one ack back, on a single stream.
async fn say_hello(conn: &Connection, hello: &Hello) -> Result<bool> {
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| Error::Identity(format!("could not open a stream: {e}")))?;
    crate::frame::write_json(&mut send, hello).await?;
    /* ⚠️ **`finish`, NOT `pairing::flush` — THE CALLER MUST NOT WAIT FOR
     * `stopped()` HERE.** `flush` is `finish` plus a bounded wait for the peer
     * to release the stream, which is right for `serve`: it closes the
     * connection immediately afterwards, and a close discards whatever the
     * peer has not acknowledged. This side does the opposite — it READS next,
     * and the ack it is about to read is itself the proof the hello landed.
     * Waiting for `stopped()` first makes the answer depend on the server
     * releasing the stream before sending it; against today's `serve`, which
     * closes right after answering, it happens to resolve, so nothing here
     * fails either way. That is exactly why this is written down rather than
     * left as a five-second timeout somebody meets later.
     *
     * `finish` alone still matters: it is what tells `serve` the hello is
     * complete rather than a peer that has more to say. */
    let _ = send.finish();

    let body = timeout(
        HELLO_TIMEOUT,
        crate::frame::read_capped(&mut recv, MAX_HELLO),
    )
    .await
    .map_err(|_| Error::Timeout("the circle ack"))??
    .ok_or_else(|| Error::FrameMalformed("the circle ack was empty".into()))?;
    let ack: Ack = serde_json::from_slice(&body)
        .map_err(|e| Error::FrameMalformed(format!("the circle ack does not parse: {e}")))?;
    Ok(ack.admitted)
}

/// Serve one introduction, then close.
///
/// ⚠️ **ONE FRAME IN, ONE ANSWER OUT, AND THE STREAM IS DONE.** A stranger can
/// open this door, so everything about it is bounded: a timeout on the accept,
/// a cap on the declared length checked BEFORE the body is read, one parse, one
/// decision, one write. There is no loop, so there is nothing to hold open.
///
/// ⚠️ **THE RESULT IS NEVER SENT AS A REASON.** See [`Ack`] — telling a
/// stranger which check failed lets them probe this reader's circle one dial at
/// a time.
pub(crate) async fn serve(node: std::sync::Arc<crate::node::Node>, conn: Connection) {
    /* ⚠️ **BOUNDED BEFORE ANYTHING IS READ.** See [`MAX_HELLOS`]. `try_acquire`
     * rather than `acquire`: waiting for a permit is a queue, and a queue on
     * the one door a stranger may knock on is the resource being exhausted
     * rather than protected.
     *
     * Over the cap the connection is CLOSED WITHOUT AN ACK, which is
     * deliberately distinguishable from a refusal. It has to be: a legitimate
     * peer that reads `admitted: false` has been told it is not in the circle
     * and should stop trying, whereas this one should come back in a second.
     * It leaks nothing the anti-oracle rule protects — that rule is about which
     * CHECK failed, and load is externally observable anyway. */
    let Ok(_permit) = node.hello_limit.clone().try_acquire_owned() else {
        conn.close(VarInt::from_u32(2), b"busy");
        return;
    };
    /* ⚠️ **ONE `accept_bi`, AND THE ANSWER GOES BACK ON THAT SAME STREAM.**
     * This accepted the hello on one stream and then waited for the peer to
     * open a SECOND one to receive the ack — which no client does. A caller
     * sending a hello and reading the reply on its own stream got EOF, and this
     * side waited for ever on an accept that had no timeout. The door was built
     * and had never answered anybody; nothing caught it because `admit` is
     * tested as a pure function and this half was exercised by nothing.
     *
     * The ack is written whatever happened, including on a parse error: a
     * stranger that gets silence learns the same thing as one that gets
     * `false`, and answering keeps the two indistinguishable from outside. */
    let admitted = match timeout(HELLO_TIMEOUT, conn.accept_bi()).await {
        Ok(Ok((mut send, mut recv))) => {
            let admitted = matches!(
                decide(&node, &conn, &mut recv).await,
                Ok(Decision::Admit { .. })
            );
            let _ = crate::frame::write_json(&mut send, &Ack { admitted }).await;
            /* ⚠️ **FLUSHED BEFORE THE CLOSE BELOW, AND IT WAS NOT.** `finish`
             * alone only says "no more bytes"; the `conn.close` that follows
             * discards whatever the peer has not acknowledged, so the ack was
             * written and thrown away and the caller saw a closed connection
             * where a verdict should have been. `pairing::flush` has carried
             * this exact note since the pairing ack met the same wall. */
            crate::pairing::flush(&mut send).await;
            admitted
        }
        /* No stream, or none within the deadline. There is nothing to answer
        on, so the close below is the whole reply. */
        _ => false,
    };
    conn.close(
        VarInt::from_u32(if admitted { 0 } else { 1 }),
        if admitted { b"admitted" } else { b"refused" },
    );
}

/// Read one hello and apply what it decides.
async fn decide(
    node: &std::sync::Arc<crate::node::Node>,
    conn: &Connection,
    recv: &mut iroh::endpoint::RecvStream,
) -> Result<Decision> {
    let endpoint = conn.remote_id().to_string();

    /* ⚠️ **BOUNDED BEFORE PARSED.** `read_capped` checks the declared length
    against `MAX_HELLO` before allocating, so a hostile peer claiming four
    megabytes costs nothing. */
    let body = timeout(HELLO_TIMEOUT, crate::frame::read_capped(recv, MAX_HELLO))
        .await
        .map_err(|_| Error::Timeout("circle hello body"))??
        .ok_or_else(|| Error::FrameMalformed("the circle hello was empty".into()))?;
    let hello: Hello = serde_json::from_slice(&body)
        .map_err(|e| Error::FrameMalformed(format!("the circle hello does not parse: {e}")))?;

    let root = node.root().to_path_buf();
    let known = known_people(&root)?;
    let decision = admit(&known, &hello, &endpoint, now_ms());

    if let Decision::Admit {
        ref person,
        ref device,
        roster,
    } = decision
    {
        /* ⚠️ **THROUGH `node.peers()`, AND IT WAS `PeerStore::load`.** That
         * loaded a SECOND copy from disk and mutated it; the running node
         * authorises sessions from its own in-memory store, so the retry this
         * door exists to enable was still refused until the app restarted —
         * which is the one thing the whole introduction path promises. */
        let name = known
            .iter()
            .find(|k| &k.person == person)
            .map_or_else(|| "A reader".to_string(), |k| k.display_name.clone());
        let now = now_ms().max(0) as u64;
        {
            let mut peers = node.peers();
            if peers.get(device).is_none() {
                peers.insert(crate::peers::PeerRecord {
                    id: device.clone(),
                    name,
                    platform: String::new(),
                    role: crate::role::Role::Shelf,
                    grants: Vec::new(),
                    paired_at: now,
                    last_seen_at: now,
                    last_addrs: Vec::new(),
                })?;
            }
        }
        if let Some(version) = roster {
            let mut people = known.clone();
            let mut evict: Vec<String> = Vec::new();
            if let Some(entry) = people.iter_mut().find(|k| &k.person == person) {
                entry.roster = version;
                entry.roster_hash = roster_hash(&hello.roster.roster.devices);
                /* ⚠️ **THE PREVIOUS DEVICE SET, READ BEFORE IT IS REPLACED.** A
                 * revocation is a statement about YOUR OWN devices, and the
                 * only thing that makes that enforceable is remembering which
                 * devices this person ever vouched for. Acting on the list
                 * unchecked would let anybody in the circle name any device id
                 * — this reader's own laptop included — and have it evicted. */
                let theirs = std::mem::take(&mut entry.devices);
                for revoked in &hello.roster.roster.revocations {
                    if !entry.revoked.contains(revoked) {
                        entry.revoked.push(revoked.clone());
                        if theirs.iter().any(|d| d == revoked) {
                            evict.push(revoked.clone());
                        }
                    }
                }
                entry.devices = hello.roster.roster.devices.clone();
            }
            set_known_people(&root, &people)?;
            /* ⚠️ **RECORDING A REVOCATION IS NOT ACTING ON ONE.** This appended
             * to `revoked` and stopped — so the revoked device kept its entry
             * in `peers.json` and any session it already held stayed open. It
             * was refused at the CIRCLE door and admitted at every other one,
             * which is the door it did not need. `forget_peer` removes the
             * trust and closes the live sessions in one step.
             *
             * After the write, deliberately: a revocation that is acted on and
             * then fails to persist comes back on the next launch. */
            for device in evict {
                /* Not this device. A person's own home revoking a leaf sends
                the list back to that leaf, and obeying it would have the
                device evict itself from its own peer store. */
                if device == node.id().to_string() {
                    continue;
                }
                match node.forget_peer(&device) {
                    Ok(()) => log::info!("circle: dropped a device {person} revoked"),
                    /* Not being trusted in the first place is the ordinary
                    case, not a failure. */
                    Err(Error::PeerUnknown(_)) => {}
                    Err(err) => log::warn!("circle: could not drop a revoked device: {err}"),
                }
            }
        }
    }

    Ok(decision)
}

/// Wall clock, integer milliseconds UTC — `identity.md` §"Time semantics".
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The whole exchange is one round trip; anything slower is not a reader.
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::person::{Delegation, PersonId};

    /* The identity `signed` last minted, so `hello_with` can sign a roster as
    the same person.

    ⚠️ **THIS WAS A `static Mutex`, AND IT WAS A RACE ACROSS TESTS.** Every
    test calls `signed` and then `hello_for`, and cargo runs them in
    PARALLEL: a second test minting between one test's two calls replaced
    the identity, so the roster was signed by a person the delegation does
    not name. Most tests survived that — they expect a refusal, and
    `BadSignature` is a refusal, so they passed for the wrong reason. It
    surfaced only on `a_roster_listed_in_another_order_verifies_the_same`,
    which compares two signatures and cannot be satisfied by an accident.

    A thread-local removes the class rather than the instance: cargo gives
    each test its own thread, so there is no sharing left to get wrong, and
    the lock goes with it. (A block comment, not doc comments: `thread_local!`
    is a macro and rustc refuses doc comments that document nothing.) */
    thread_local! {
        static MINTED: std::cell::RefCell<Option<(FakeKeychain, PathBuf)>> =
            const { std::cell::RefCell::new(None) };
    }

    /// A person and a delegation that really is signed by them.
    fn signed(device: &str, not_before: i64, not_after: i64, roster: u64) -> SignedDelegation {
        let keychain = FakeKeychain::default();
        // Counted, not clocked — see `testutil::scratch`.
        let dir = crate::testutil::scratch("circle");
        std::fs::create_dir_all(dir.join(PEER_DIR)).unwrap();
        let (person, _) = person::ensure(&keychain, &dir).unwrap();
        let delegation = person::sign_delegation(
            &keychain,
            &dir,
            Delegation {
                person,
                device: device.to_string(),
                not_before,
                not_after,
                roster,
            },
        )
        .unwrap();
        MINTED.with(|held| *held.borrow_mut() = Some((keychain, dir)));
        delegation
    }

    #[derive(Debug, Default)]
    struct FakeKeychain {
        entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
    }

    impl person::Keychain for FakeKeychain {
        fn read(&self, account: &str) -> Result<Option<String>> {
            Ok(self.entries.lock().unwrap().get(account).cloned())
        }
        fn write(&self, account: &str, secret: &str) -> Result<()> {
            self.entries
                .lock()
                .unwrap()
                .insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.entries.lock().unwrap().remove(account);
            Ok(())
        }
    }

    /* A real endpoint key is 64 lower-case hex — `sign_delegation` refuses
    anything else, because a delegation naming a device that cannot be an
    endpoint is signed, valid and meaningless. */
    const DEVICE: &str = "aa11bb22cc33dd44ee55ff6600778899aabbccddeeff00112233445566778899";
    const OTHER: &str = "bb22cc33dd44ee55ff6600778899aabbccddeeff001122334455667788990011";
    const NOW: i64 = 1_000_000;

    /// A hello whose roster really is signed by the delegation's person.
    ///
    /// ⚠️ The keychain and root dir have to be the SAME ones `signed` used, or
    /// the roster is signed by a different person and every test refuses. That
    /// is `signed` returning its own scratch dir's business, so both are made
    /// here and handed back together.
    fn hello_for(d: SignedDelegation, epoch: u64, hlc: i64, devices: &[&str]) -> Hello {
        hello_with(d, epoch, hlc, devices, &[])
    }

    fn hello_with(
        d: SignedDelegation,
        epoch: u64,
        hlc: i64,
        devices: &[&str],
        revocations: &[&str],
    ) -> Hello {
        let roster = Roster {
            version: Version { epoch, hlc },
            devices: devices.iter().map(|s| (*s).to_string()).collect(),
            revocations: revocations.iter().map(|s| (*s).to_string()).collect(),
        };
        let signed = MINTED.with(|held| {
            let held = held.borrow();
            let (keychain, dir) = held.as_ref().expect("signed() ran first");
            sign_roster(keychain, dir, roster).unwrap()
        });
        Hello {
            delegation: d,
            roster: signed,
        }
    }

    /// Somebody met but not yet heard from — no roster fingerprint.
    fn met(person: &PersonId, epoch: u64, hlc: i64) -> KnownPerson {
        KnownPerson {
            person: person.to_string(),
            display_name: "A friend".into(),
            roster: Version { epoch, hlc },
            roster_hash: String::new(),
            revoked: Vec::new(),
            devices: Vec::new(),
        }
    }

    /// Somebody whose roster is already held, fingerprint and all.
    fn heard(person: &PersonId, epoch: u64, hlc: i64, devices: &[&str]) -> KnownPerson {
        KnownPerson {
            roster_hash: roster_hash(&devices.iter().map(|d| (*d).to_string()).collect::<Vec<_>>()),
            ..met(person, epoch, hlc)
        }
    }

    #[test]
    fn a_stranger_is_refused_without_verifying_anything() {
        /* ⚠️ **THE SIGNATURE IS CORRUPTED ON PURPOSE.** With a valid one this
        test passed whether or not verification ran first, so it could not tell
        "refused cheaply" from "refused after doing the expensive work" — which
        is the whole claim its name makes. A stranger must cost nothing: running
        Ed25519 for every endpoint that dials is unbounded work anybody can ask
        for. Corrupted, a `Stranger` verdict proves the signature was never
        reached, because reaching it would return `BadSignature`. */
        let mut d = signed(DEVICE, 0, NOW * 2, 1);
        d.signature = "00".repeat(64);
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        assert_eq!(
            admit(&[], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::Stranger)
        );
    }

    #[test]
    fn a_person_already_met_is_admitted() {
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        assert!(matches!(
            admit(&[met(&person, 1, 1)], &hello, DEVICE, NOW),
            Decision::Admit { .. }
        ));
    }

    #[test]
    fn a_delegation_for_another_endpoint_cannot_be_replayed() {
        // ⚠️ A delegation is PUBLIC — it rides on every page. Without the
        // device check, any admitted person's valid delegation would let any
        // endpoint at all through this door by replaying it.
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 1, 1, &[DEVICE, OTHER]);
        assert_eq!(
            admit(&[met(&person, 1, 1)], &hello, OTHER, NOW),
            Decision::Refuse(Refusal::WrongDevice)
        );
    }

    #[test]
    fn a_forged_delegation_is_refused() {
        let mut d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        d.delegation.not_after = i64::MAX;
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        assert_eq!(
            admit(&[met(&person, 1, 1)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::BadSignature)
        );
    }

    #[test]
    fn a_roster_the_person_did_not_sign_is_refused() {
        /* ⚠️ **ONLY THE DELEGATION WAS SIGNED, AND THE ROSTER RODE BESIDE IT
        UNCHECKED — THEN GOT STORED.** Verifying the delegation established WHO
        is speaking and said nothing about the roster travelling with them. So a
        device holding one valid delegation could present `epoch: u64::MAX` with
        a device list of its choosing; the receiver kept it, and every genuine
        later roster from that person then read as stale and was refused for
        ever. One compromised leaf could lock its owner out of their own circle,
        permanently, with a number. */
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let mut hello = hello_for(d, 1, 1, &[DEVICE]);
        hello.roster.sig = "00".repeat(64);

        assert_eq!(
            admit(&[met(&person, 0, 0)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::BadSignature)
        );
    }

    #[test]
    fn a_roster_edited_after_signing_is_refused() {
        // The version is the field an attacker wants; it is inside the signature.
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let mut hello = hello_for(d, 1, 1, &[DEVICE]);
        hello.roster.roster.version = Version {
            epoch: u64::MAX,
            hlc: i64::MAX,
        };

        assert_eq!(
            admit(&[met(&person, 0, 0)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::BadSignature)
        );
    }

    #[test]
    fn a_revocation_cannot_be_dropped_in_transit() {
        /* ⚠️ Revocations are INSIDE the signed roster. Carried beside it they
        would be a separate statement a peer could simply omit — and a
        revocation that can be dropped on the way is not a revocation. */
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let mut hello = hello_with(d, 1, 1, &[DEVICE], &[DEVICE]);
        /* Strip the revocation, keeping the signature that covered it. */
        hello.roster.roster.revocations.clear();

        assert_eq!(
            admit(&[met(&person, 0, 0)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::BadSignature)
        );
    }

    #[test]
    fn a_roster_signed_by_somebody_else_is_refused() {
        // The signature is checked against the person the DELEGATION names.
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        /* A second identity signs an identical roster. */
        let stranger = signed(DEVICE, 0, NOW * 2, 1);
        let theirs = hello_for(stranger, 1, 1, &[DEVICE]);
        let mut forged = hello;
        forged.roster = theirs.roster;

        assert_eq!(
            admit(&[met(&person, 0, 0)], &forged, DEVICE, NOW),
            Decision::Refuse(Refusal::BadSignature)
        );
    }

    #[test]
    fn a_roster_listed_in_another_order_verifies_the_same() {
        /* Both lists are sorted before signing, so two peers holding one roster
        in different orders produce identical bytes — otherwise a re-ordering
        would read as a forgery. */
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let one = hello_with(d.clone(), 1, 1, &[DEVICE, OTHER], &[]);
        let other = hello_with(d, 1, 1, &[OTHER, DEVICE], &[]);
        assert_eq!(one.roster.sig, other.roster.sig);
    }

    #[test]
    fn an_expired_delegation_is_refused_with_no_revocation_list_at_all() {
        // WI-22.B2's guarantee: expiry is what survives a peer who never
        // connects again, so it must hold without anything having been pushed.
        let d = signed(DEVICE, 0, NOW - 1, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        assert_eq!(
            admit(&[met(&person, 1, 1)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::NotLive)
        );
    }

    #[test]
    fn there_is_no_grace_after_not_after() {
        // ⚠️ A tolerance here is an extension granted to exactly the device you
        // are trying to stop.
        let d = signed(DEVICE, 0, NOW, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        assert_eq!(
            admit(&[met(&person, 1, 1)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::NotLive)
        );
    }

    #[test]
    fn there_is_grace_before_not_before() {
        // Two machines disagreeing about the clock must not look like an attack.
        let d = signed(DEVICE, NOW + SKEW_MS - 1, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        assert!(matches!(
            admit(&[met(&person, 1, 1)], &hello, DEVICE, NOW),
            Decision::Admit { .. }
        ));
    }

    #[test]
    fn a_device_revoked_in_what_we_already_hold_is_refused() {
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let mut known = met(&person, 1, 1);
        known.revoked.push(DEVICE.into());
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        assert_eq!(
            admit(&[known], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::Revoked)
        );
    }

    #[test]
    fn a_device_revoked_in_the_hello_it_sent_itself_is_refused() {
        // A peer honest enough to send its own revocation list is still not
        // allowed to speak past it.
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_with(d, 1, 1, &[DEVICE], &[DEVICE]);
        assert_eq!(
            admit(&[met(&person, 1, 1)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::Revoked)
        );
    }

    #[test]
    fn a_delegation_the_roster_no_longer_vouches_for_is_refused() {
        // Revocation works by the roster moving on; a device holding an old
        // delegation would otherwise outlive its removal.
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 2, 2, &[OTHER]);
        assert_eq!(
            admit(&[met(&person, 1, 1)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::Revoked)
        );
    }

    #[test]
    fn an_older_roster_is_refused_rather_than_installed() {
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 1, 1, &[DEVICE]);
        assert_eq!(
            admit(&[met(&person, 2, 5)], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::RosterStale)
        );
    }

    #[test]
    fn a_newer_roster_is_carried_back_so_the_caller_can_store_it() {
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 2, 9, &[DEVICE]);
        match admit(&[met(&person, 1, 1)], &hello, DEVICE, NOW) {
            Decision::Admit { roster, .. } => {
                assert_eq!(roster, Some(Version { epoch: 2, hlc: 9 }))
            }
            other => panic!("expected admit, got {other:?}"),
        }
    }

    #[test]
    fn the_same_roster_is_admitted_and_stores_nothing() {
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 3, 3, &[DEVICE]);
        match admit(&[heard(&person, 3, 3, &[DEVICE])], &hello, DEVICE, NOW) {
            Decision::Admit { roster, .. } => assert_eq!(roster, None),
            other => panic!("expected admit, got {other:?}"),
        }
    }

    #[test]
    fn one_version_over_two_different_rosters_is_refused_rather_than_picked() {
        /* ⚠️ **THE TIE, AND IT USED TO BE UNREACHABLE.** The check asked the
        same question as the equality above it, so an equal `(epoch, hlc)` over
        a DIFFERENT device set — which is exactly what two devices minting
        concurrently produce — was admitted as though it were the roster already
        held, and whichever peer arrived second silently won. Telling the two
        apart needs the CONTENTS, which is why `roster_hash` is stored. */
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 4, 4, &[DEVICE, OTHER]);

        assert_eq!(
            admit(&[heard(&person, 4, 4, &[DEVICE])], &hello, DEVICE, NOW),
            Decision::Refuse(Refusal::RosterTie)
        );
    }

    #[test]
    fn the_first_roster_from_somebody_met_is_learned_rather_than_compared() {
        let d = signed(DEVICE, 0, NOW * 2, 1);
        let person = d.delegation.person.clone();
        let hello = hello_for(d, 4, 4, &[DEVICE]);

        match admit(&[met(&person, 4, 4)], &hello, DEVICE, NOW) {
            Decision::Admit { roster, .. } => {
                assert_eq!(roster, Some(Version { epoch: 4, hlc: 4 }))
            }
            other => panic!("expected admit, got {other:?}"),
        }
    }

    #[test]
    fn a_roster_listed_in_a_different_order_is_the_same_roster() {
        /* Order is not part of what a roster says; a fingerprint that thought
        it was would report a tie every time two peers sorted differently. */
        assert_eq!(
            roster_hash(&[DEVICE.to_string(), OTHER.to_string()]),
            roster_hash(&[OTHER.to_string(), DEVICE.to_string()])
        );
    }

    #[test]
    fn a_higher_epoch_beats_a_higher_hlc() {
        // The epoch moves on a deliberate act; an HLC that ran ahead inside the
        // old epoch must not outrank a succession.
        assert!(Version { epoch: 2, hlc: 0 }.at_least(Version { epoch: 1, hlc: 999 }));
        assert!(!Version { epoch: 1, hlc: 999 }.at_least(Version { epoch: 2, hlc: 0 }));
    }

    #[test]
    fn the_ack_carries_no_reason() {
        // ⚠️ Telling a stranger WHY is an oracle: it lets an unknown endpoint
        // probe whether a given person is in this reader's circle.
        let json = serde_json::to_string(&Ack { admitted: false }).unwrap();
        assert_eq!(json, r#"{"admitted":false}"#);
        for word in ["stranger", "signature", "revoked", "roster"] {
            assert!(!json.contains(word), "the ack leaked {word}");
        }
    }

    #[test]
    fn a_malformed_people_file_throws_rather_than_reading_as_nobody() {
        // Reading it as empty would refuse every friend the reader has and look
        // like a quiet afternoon.
        let dir = crate::testutil::scratch("people");
        std::fs::create_dir_all(dir.join(PEER_DIR)).unwrap();
        std::fs::write(people_path(&dir), "not json").unwrap();
        assert!(known_people(&dir).is_err());
    }

    #[test]
    fn an_absent_people_file_is_nobody_which_is_a_real_answer() {
        let dir = crate::testutil::scratch("nopeople");
        std::fs::create_dir_all(dir.join(PEER_DIR)).unwrap();
        let _ = std::fs::remove_file(people_path(&dir));
        assert_eq!(known_people(&dir).unwrap(), Vec::new());
    }

    #[test]
    fn people_round_trip() {
        let dir = crate::testutil::scratch("rtpeople");
        std::fs::create_dir_all(dir.join(PEER_DIR)).unwrap();
        let people = vec![KnownPerson {
            person: "ab".repeat(32),
            display_name: "Mo".into(),
            roster: Version { epoch: 1, hlc: 7 },
            roster_hash: roster_hash(&["dd".to_string()]),
            revoked: vec!["cc".into()],
            devices: vec!["dd".into()],
        }];
        set_known_people(&dir, &people).unwrap();
        assert_eq!(known_people(&dir).unwrap(), people);
    }

    /// Two real nodes, one real hello, over the real ALPN.
    ///
    /// ⚠️ **THIS FILE HAD NO TRANSPORT TEST AT ALL, AND THAT IS HOW THE DOOR
    /// SHIPPED UNABLE TO ANSWER.** `admit` is a pure function and was tested
    /// exhaustively; `serve` accepted the hello on one stream and then waited
    /// for the peer to open a SECOND one to receive the ack, which no client
    /// does. Every unit test passed. The one thing nothing asked was whether a
    /// caller who sends a hello ever hears back.
    mod own_side {
        use super::*;

        /// A home device: a root, a role that may mint, and a scratch root dir.
        fn home() -> (person::testkit::MemoryKeychain, PathBuf, String) {
            let dir = crate::testutil::scratch("mine");
            std::fs::create_dir_all(dir.join(PEER_DIR)).unwrap();
            let keychain = person::testkit::MemoryKeychain::for_root(&dir);
            person::ensure(&keychain, &dir).unwrap();
            (keychain, dir, "ab".repeat(32))
        }

        #[test]
        fn a_home_device_mints_a_roster_that_contains_itself() {
            /* ⚠️ **NOTHING COULD BUILD A HELLO AT ALL.** `admit` was written,
            tested and served, and the crate had no way to produce the value it
            admits — the roster existed only inside test helpers. A roster
            without this device in it is refused by every peer as
            `WrongDevice`, so "contains itself" is the whole point. */
            let (keychain, dir, device) = home();
            let mine = mine_for(&keychain, &dir, &device, NOW).unwrap();

            assert!(mine.roster.roster.devices.contains(&device));
            assert_eq!(mine.delegation.delegation.device, device);
            /* And it is signed by the person it names, not merely present. */
            let person = mine.delegation.delegation.person.to_string();
            verify_roster(&person, &mine.roster).expect("the roster verifies");
        }

        #[test]
        fn what_it_minted_is_what_a_peer_would_admit() {
            /* The two halves meet: `mine_for` builds it, `admit` accepts it.
            Neither test above this proves they agree about anything. */
            let (keychain, dir, device) = home();
            let hello = hello_from(&keychain, &dir, &device, NOW).unwrap();
            let person = hello.delegation.delegation.person.clone();

            assert!(matches!(
                admit(&[met(&person, 0, 0)], &hello, &device, NOW),
                Decision::Admit { .. }
            ));
        }

        #[test]
        fn asking_twice_does_not_mint_twice() {
            /* ⚠️ **A MINT PER CALL WOULD HAND EVERY PEER A NEW ROSTER VERSION**
            — and a peer holding version N refuses N-1 as `RosterStale`, so two
            devices introducing themselves in the wrong order would refuse each
            other for ever. Stability is not an optimisation here. */
            let (keychain, dir, device) = home();
            let first = mine_for(&keychain, &dir, &device, NOW).unwrap();
            let again = mine_for(&keychain, &dir, &device, NOW + 1_000).unwrap();
            assert_eq!(first, again);
        }

        #[test]
        fn it_renews_two_thirds_of_the_way_through_rather_than_at_expiry() {
            /* ⚠️ **THERE IS NO TOLERANCE ON `not_after`** — see `SKEW_MS`, and
            deliberately so. A delegation renewed at expiry has already expired
            for anybody whose clock runs fast. */
            let (keychain, dir, device) = home();
            let first = mine_for(&keychain, &dir, &device, NOW).unwrap();
            let d = &first.delegation.delegation;
            let life = d.not_after - d.not_before;

            let early = mine_for(&keychain, &dir, &device, d.not_before + life / 2).unwrap();
            assert_eq!(early, first, "half way through is not time to renew");

            let late = mine_for(&keychain, &dir, &device, d.not_before + life * 7 / 10).unwrap();
            assert_ne!(late, first, "two thirds through, it renews");
            assert!(late.delegation.delegation.not_after > d.not_after);
        }

        #[test]
        fn a_renewal_moves_the_hlc_forward_and_leaves_the_epoch_alone() {
            /* The epoch moves on a SUCCESSION. Renewing every sixty days is
            not a new generation of the identity, and a device that bumped
            the epoch on renewal would make every peer's stored roster
            stale on a schedule. */
            let (keychain, dir, device) = home();
            let first = mine_for(&keychain, &dir, &device, NOW).unwrap();
            let d = first.delegation.delegation.clone();
            let later = mine_for(
                &keychain,
                &dir,
                &device,
                d.not_before + (d.not_after - d.not_before) * 7 / 10,
            )
            .unwrap();

            assert_eq!(
                later.roster.roster.version.epoch,
                first.roster.roster.version.epoch
            );
            assert!(later.roster.roster.version.hlc > first.roster.roster.version.hlc);
        }

        #[test]
        fn a_clock_that_steps_backwards_does_not_mint_a_stale_roster() {
            /* ⚠️ **`max(now, previous + 1)`, NOT `now`.** An NTP correction or
            a laptop restored from a snapshot would otherwise produce a roster
            every peer refuses as `RosterStale`, locking the device out of its
            own circle until wall time caught up. */
            assert_eq!(next_hlc(None, 100), 100);
            assert_eq!(next_hlc(Some(50), 100), 100);
            assert_eq!(next_hlc(Some(500), 100), 501, "the clock went back");
            assert_eq!(next_hlc(Some(i64::MAX), 100), i64::MAX, "and does not wrap");
        }

        #[test]
        fn renewing_does_not_silently_revoke_the_readers_other_devices() {
            /* ⚠️ **A MINT THAT STARTED FROM `[this device]` IS A REVOCATION.**
            Every other device of this person drops off the roster, and the
            reader's own phone stops being admitted anywhere — on a timer,
            with nothing anywhere saying why. */
            let (keychain, dir, device) = home();
            let phone = "cd".repeat(32);
            let mut mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            mine.roster.roster.devices.push(phone.clone());
            mine.roster = sign_roster(&keychain, &dir, mine.roster.roster.clone()).unwrap();
            write_mine(&dir, &mine).unwrap();

            let d = mine.delegation.delegation.clone();
            let renewed = mine_for(
                &keychain,
                &dir,
                &device,
                d.not_before + (d.not_after - d.not_before) * 7 / 10,
            )
            .unwrap();

            assert!(
                renewed.roster.roster.devices.contains(&phone),
                "the phone survived"
            );
            assert!(renewed.roster.roster.devices.contains(&device));
        }

        #[test]
        fn a_revocation_survives_a_renewal() {
            // Same class as the device set: dropping it would un-revoke.
            let (keychain, dir, device) = home();
            let gone = "ef".repeat(32);
            let mut mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            mine.roster.roster.revocations.push(gone.clone());
            mine.roster = sign_roster(&keychain, &dir, mine.roster.roster.clone()).unwrap();
            write_mine(&dir, &mine).unwrap();

            let d = mine.delegation.delegation.clone();
            let renewed = mine_for(
                &keychain,
                &dir,
                &device,
                d.not_before + (d.not_after - d.not_before) * 7 / 10,
            )
            .unwrap();
            assert!(renewed.roster.roster.revocations.contains(&gone));
        }

        #[test]
        fn a_leaf_presents_what_it_was_given_and_says_so_when_it_runs_out() {
            /* A leaf cannot sign, which is the point of demoting it. What it
            needs when the delegation expires is a fresh one from home —
            and saying that is more use than a signature nobody accepts. */
            let (keychain, dir, device) = home();
            let mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            person::forget(&keychain, &dir).unwrap();

            // Still inside the window: it presents what it holds.
            assert_eq!(mine_for(&keychain, &dir, &device, NOW).unwrap(), mine);

            // Past it: a refusal that names the fix.
            let err = mine_for(
                &keychain,
                &dir,
                &device,
                mine.delegation.delegation.not_after + 1,
            )
            .unwrap_err();
            let said = format!("{err}");
            assert!(said.contains("home device"), "names the fix: {said}");
        }

        #[test]
        fn a_device_with_no_root_and_nothing_stored_says_that_rather_than_minting() {
            let dir = crate::testutil::scratch("mine-empty");
            std::fs::create_dir_all(dir.join(PEER_DIR)).unwrap();
            let keychain = person::testkit::MemoryKeychain::for_root(&dir);
            person::ensure(&keychain, &dir).unwrap();
            person::forget(&keychain, &dir).unwrap();

            let err = mine_for(&keychain, &dir, &"ab".repeat(32), NOW).unwrap_err();
            assert!(format!("{err}").contains("nothing to introduce"));
        }

        #[test]
        fn a_new_endpoint_key_gets_a_delegation_for_the_key_it_actually_has() {
            /* The identity key is rotated by `identity.rs` on a clobber; a
            delegation for the OLD device id is refused as `WrongDevice` by
            every peer, and looks like a network fault. */
            let (keychain, dir, device) = home();
            mine_for(&keychain, &dir, &device, NOW).unwrap();
            let rotated = "12".repeat(32);

            let mine = mine_for(&keychain, &dir, &rotated, NOW).unwrap();
            assert_eq!(mine.delegation.delegation.device, rotated);
            assert!(mine.roster.roster.devices.contains(&rotated));
            assert!(
                mine.roster.roster.devices.contains(&device),
                "the old key stays until revoked"
            );
        }

        #[test]
        fn a_malformed_file_throws_rather_than_minting_over_it() {
            /* Reading it as "nothing published" would mint a NEW roster at a
            fresh version and hand every peer a roster OLDER than the one
            they hold — which they then refuse for ever. */
            let (keychain, dir, device) = home();
            mine_for(&keychain, &dir, &device, NOW).unwrap();
            std::fs::write(mine_path(&dir), "not json").unwrap();

            assert!(read_mine(&dir).is_err());
            assert!(mine_for(&keychain, &dir, &device, NOW).is_err());
        }

        #[test]
        fn revoking_a_device_stops_the_roster_vouching_and_says_so() {
            /* ⚠️ **BOTH, NOT EITHER.** `admit` refuses a device the roster does
            not list, and refuses one the revocation list names. Removal alone
            leaves a peer holding an OLDER roster still vouching for it — that
            older roster is perfectly valid and still says the device is fine.
            The explicit statement is the part that travels. */
            let (keychain, dir, device) = home();
            let phone = "cd".repeat(32);
            let mut mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            mine.roster.roster.devices.push(phone.clone());
            mine.roster = sign_roster(&keychain, &dir, mine.roster.roster.clone()).unwrap();
            write_mine(&dir, &mine).unwrap();

            let after = revoke_device(&keychain, &dir, &phone, NOW + 10).unwrap();

            assert!(
                !after.roster.roster.devices.contains(&phone),
                "not vouched for"
            );
            assert!(
                after.roster.roster.revocations.contains(&phone),
                "and said so"
            );
            assert!(
                after.roster.roster.devices.contains(&device),
                "this one stays"
            );
            let person = after.delegation.delegation.person.to_string();
            verify_roster(&person, &after.roster).expect("re-signed, not merely edited");
        }

        #[test]
        fn a_revocation_moves_the_version_or_every_peer_refuses_it() {
            /* ⚠️ **A ROSTER AT THE SAME VERSION IS REFUSED AS `RosterStale` OR
            `RosterTie`**, so a revocation that did not move the clock would be
            a local note that no friend ever accepts — and the reader would be
            told their laptop was revoked while every peer went on admitting
            it. */
            let (keychain, dir, device) = home();
            let phone = "cd".repeat(32);
            let mut mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            mine.roster.roster.devices.push(phone.clone());
            mine.roster = sign_roster(&keychain, &dir, mine.roster.roster.clone()).unwrap();
            write_mine(&dir, &mine).unwrap();
            let before = mine.roster.roster.version;

            let after = revoke_device(&keychain, &dir, &phone, NOW + 10).unwrap();

            assert!(
                after.roster.roster.version.hlc > before.hlc,
                "the clock moved"
            );
            assert_eq!(
                after.roster.roster.version.epoch, before.epoch,
                "a revocation is not a succession"
            );
        }

        #[test]
        fn what_a_revocation_produces_is_refused_by_a_peer_that_holds_it() {
            /* The two halves meet. Without this the roster could be perfectly
            well-formed and still admit the device it just revoked. */
            let (keychain, dir, device) = home();
            let phone = "cd".repeat(32);
            let mut mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            mine.roster.roster.devices.push(phone.clone());
            mine.roster = sign_roster(&keychain, &dir, mine.roster.roster.clone()).unwrap();
            write_mine(&dir, &mine).unwrap();

            let after = revoke_device(&keychain, &dir, &phone, NOW + 10).unwrap();
            let person = after.delegation.delegation.person.clone();
            /* The revoked phone presents its own delegation and the new roster
            — the best it can do, since anything else fails a signature. */
            let hello = Hello {
                delegation: person::sign_delegation(
                    &keychain,
                    &dir,
                    person::Delegation {
                        person: person.clone(),
                        device: phone.clone(),
                        not_before: NOW - 1_000,
                        not_after: NOW + 1_000_000,
                        roster: 0,
                    },
                )
                .unwrap(),
                roster: after.roster,
            };

            assert_eq!(
                admit(&[met(&person, 0, 0)], &hello, &phone, NOW + 20),
                Decision::Refuse(Refusal::Revoked)
            );
        }

        #[test]
        fn a_device_cannot_revoke_itself() {
            /* ⚠️ **A ONE-WAY DOOR INTO A CIRCLE NOBODY CAN REPAIR.** It would
            sign a roster saying it is not allowed to speak, and then be unable
            to sign the correction. Giving up a device is `person::forget`. */
            let (keychain, dir, device) = home();
            mine_for(&keychain, &dir, &device, NOW).unwrap();

            let err = revoke_device(&keychain, &dir, &device, NOW + 10).unwrap_err();
            let said = format!("{err}");
            assert!(said.contains("cannot revoke itself"), "{said}");
            assert!(
                said.contains("forget the phrase"),
                "names the real act: {said}"
            );
            // And nothing was written: the roster still vouches for it.
            let held = read_mine(&dir).unwrap().unwrap();
            assert!(held.roster.roster.devices.contains(&device));
        }

        #[test]
        fn revoking_twice_is_the_state_the_reader_asked_for() {
            // Pressing it again is somebody making sure, not an error.
            let (keychain, dir, device) = home();
            let phone = "cd".repeat(32);
            let mut mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            mine.roster.roster.devices.push(phone.clone());
            mine.roster = sign_roster(&keychain, &dir, mine.roster.roster.clone()).unwrap();
            write_mine(&dir, &mine).unwrap();

            let once = revoke_device(&keychain, &dir, &phone, NOW + 10).unwrap();
            let twice = revoke_device(&keychain, &dir, &phone, NOW + 20).unwrap();
            assert_eq!(once, twice, "the second one did not move the roster on");
            assert_eq!(
                twice.roster.roster.revocations.len(),
                1,
                "and not listed twice"
            );
        }

        #[test]
        fn a_leaf_cannot_revoke_because_it_cannot_sign() {
            let (keychain, dir, device) = home();
            let phone = "cd".repeat(32);
            let mut mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            mine.roster.roster.devices.push(phone.clone());
            mine.roster = sign_roster(&keychain, &dir, mine.roster.roster.clone()).unwrap();
            write_mine(&dir, &mine).unwrap();
            person::forget(&keychain, &dir).unwrap();

            assert!(revoke_device(&keychain, &dir, &phone, NOW + 10).is_err());
        }

        #[test]
        fn a_revocation_survives_the_next_renewal() {
            /* The renewal path re-signs the roster from what is held; a mint
            that dropped the revocations would silently un-revoke a stolen
            laptop ninety days later. */
            let (keychain, dir, device) = home();
            let phone = "cd".repeat(32);
            let mut mine = mine_for(&keychain, &dir, &device, NOW).unwrap();
            mine.roster.roster.devices.push(phone.clone());
            mine.roster = sign_roster(&keychain, &dir, mine.roster.roster.clone()).unwrap();
            write_mine(&dir, &mine).unwrap();
            revoke_device(&keychain, &dir, &phone, NOW + 10).unwrap();

            let d = mine.delegation.delegation.clone();
            let renewed = mine_for(
                &keychain,
                &dir,
                &device,
                d.not_before + (d.not_after - d.not_before) * 7 / 10,
            )
            .unwrap();

            assert!(renewed.roster.roster.revocations.contains(&phone));
            assert!(!renewed.roster.roster.devices.contains(&phone));
        }

        #[test]
        fn should_renew_is_saturating_because_it_reads_from_disk() {
            let (keychain, dir, device) = home();
            /* A real one — `PersonId` cannot be constructed from outside
            `person.rs`, which is the point: it is a key, not a label. */
            let mut d = mine_for(&keychain, &dir, &device, NOW)
                .unwrap()
                .delegation
                .delegation;
            d.not_before = 0;
            d.not_after = 300;
            assert!(!should_renew(&d, 199));
            assert!(should_renew(&d, 200));
            // A window that is not one, and one that would overflow a subtraction.
            d.not_after = 0;
            assert!(!should_renew(&d, 100));
            d.not_before = i64::MAX;
            d.not_after = i64::MIN;
            assert!(!should_renew(&d, 0), "no panic on a nonsense window");
        }
    }

    mod over_the_wire {
        use super::*;
        use crate::node::testkit::TestNode;
        use crate::role::Role;

        /// Dial a node on the hello ALPN, send one frame, read the answer.
        async fn say_hello(from: &TestNode, to: &TestNode, hello: &Hello) -> Option<Ack> {
            /* Every step names its own failure: a helper that answers `None`
            for "could not dial", "no answer" and "unparseable answer" alike
            turns three different defects into one blank assertion. */
            /* ⚠️ **THE ADDRESSES HAVE TO COME WITH THE ID.** Test nodes run
            with the relay off and mDNS off — deliberately, so a suite never
            touches the network — so a bare `EndpointAddr::new(id)` has no
            path to dial and the connect simply never resolves. `begin`
            builds a pairing URI the same way, from `endpoint().addr()`. */
            let mut addr = iroh::EndpointAddr::new(to.node.id());
            for ip in to.node.endpoint().addr().ip_addrs().copied() {
                addr = addr.with_ip_addr(ip);
            }
            let conn = from
                .node
                .endpoint()
                .connect(addr, CIRCLE_HELLO_ALPN)
                .await
                .expect("dial the hello ALPN");
            let (mut send, mut recv) = conn.open_bi().await.expect("open a stream");
            crate::frame::write_json(&mut send, hello)
                .await
                .expect("write the hello");
            /* The answer comes back on THIS stream — the whole point. */
            let body = timeout(
                std::time::Duration::from_secs(10),
                crate::frame::read_capped(&mut recv, MAX_HELLO),
            )
            .await
            .expect("an answer within ten seconds")
            .expect("a readable answer")
            .expect("a non-empty answer");
            Some(serde_json::from_slice(&body).expect("an Ack"))
        }

        /// The address of a test node, ADDRESSES INCLUDED.
        fn addr_of(to: &TestNode) -> iroh::EndpointAddr {
            let mut addr = iroh::EndpointAddr::new(to.node.id());
            for ip in to.node.endpoint().addr().ip_addrs().copied() {
                addr = addr.with_ip_addr(ip);
            }
            addr
        }

        #[tokio::test]
        async fn introduce_carries_a_real_hello_to_a_real_door() {
            /* ⚠️ **NOTHING IN THE APP COULD SEND A HELLO.** `admit` was a
            tested pure function, `serve` was exercised by two tests that
            hand-built the value, and no code path anywhere produced one. A
            protocol with one side implemented is a design document. This is
            the first test in which both halves are the shipping code. */
            let alice = TestNode::start("intro-alice", Role::Shelf).await;
            let bob = TestNode::start("intro-bob", Role::Shelf).await;

            /* Bob mints his own identity, exactly as the app would. */
            let bob_person = {
                let keychain = bob.node.keychain();
                let root = bob.node.root().to_path_buf();
                person::ensure(keychain.as_ref(), &root).unwrap().0
            };
            /* Alice has met that person — through pairing, in the app. */
            set_known_people(alice.node.root(), &[met(&bob_person, 0, 0)]).unwrap();

            let admitted = introduce(&bob.node, addr_of(&alice)).await.unwrap();

            assert!(admitted, "the person alice has met was admitted");
            /* And the door did what admission promises: the ORDINARY ALPN can
            now be dialled, which is the whole point of the introduction. */
            assert!(alice.node.peers().get(&bob.node.id().to_string()).is_some());
            alice.close().await;
            bob.close().await;
        }

        #[tokio::test]
        async fn introduce_reports_a_refusal_rather_than_an_error() {
            /* A refusal is an ANSWER — the reader is told they are not known
            to that person yet. Surfacing it as a transport error would send
            them looking at their wifi. */
            let alice = TestNode::start("intro-alice3", Role::Shelf).await;
            let bob = TestNode::start("intro-bob3", Role::Shelf).await;
            {
                let keychain = bob.node.keychain();
                let root = bob.node.root().to_path_buf();
                person::ensure(keychain.as_ref(), &root).unwrap();
            }
            // Alice knows nobody.

            let admitted = introduce(&bob.node, addr_of(&alice)).await;

            assert_eq!(admitted.ok(), Some(false), "refused, not failed");
            alice.close().await;
            bob.close().await;
        }

        #[tokio::test]
        async fn what_introduce_publishes_is_what_alice_stores() {
            /* The roster crosses the wire and is KEPT — the version and the
            fingerprint both. Without that, the next hello cannot be ordered
            against this one and `RosterStale` can never fire. */
            let alice = TestNode::start("intro-alice4", Role::Shelf).await;
            let bob = TestNode::start("intro-bob4", Role::Shelf).await;
            let bob_person = {
                let keychain = bob.node.keychain();
                let root = bob.node.root().to_path_buf();
                person::ensure(keychain.as_ref(), &root).unwrap().0
            };
            set_known_people(alice.node.root(), &[met(&bob_person, 0, 0)]).unwrap();

            assert!(introduce(&bob.node, addr_of(&alice)).await.unwrap());

            let mine = read_mine(bob.node.root()).unwrap().expect("bob published");
            let stored = known_people(alice.node.root()).unwrap();
            let entry = stored
                .iter()
                .find(|k| k.person == bob_person.to_string())
                .expect("alice kept bob");
            assert_eq!(entry.roster, mine.roster.roster.version);
            assert_eq!(entry.roster_hash, roster_hash(&mine.roster.roster.devices));
            alice.close().await;
            bob.close().await;
        }

        /// A device id that is a REAL endpoint key.
        ///
        /// ⚠️ **`"ab".repeat(32)` IS 64 HEX CHARACTERS AND IS NOT A KEY.** It
        /// satisfies every length and alphabet check in this file, so it works
        /// everywhere the id is only compared — and `forget_peer` parses it,
        /// fails, and evicts nothing. The revocation test passed the wrong
        /// reason for the wrong result until it used a key that parses.
        fn some_device() -> String {
            iroh::SecretKey::generate().public().to_string()
        }

        /// Set up alice knowing bob's person, with `devices` as bob's roster.
        async fn alice_knows_bob(
            alice: &TestNode,
            bob: &TestNode,
            devices: &[String],
        ) -> person::PersonId {
            let keychain = bob.node.keychain();
            let root = bob.node.root().to_path_buf();
            let bob_person = person::ensure(keychain.as_ref(), &root).unwrap().0;
            let mut entry = met(&bob_person, 0, 0);
            entry.devices = devices.to_vec();
            set_known_people(alice.node.root(), &[entry]).unwrap();
            bob_person
        }

        #[tokio::test]
        async fn a_revocation_drops_the_device_trust_rather_than_only_being_noted() {
            /* ⚠️ **RECORDING A REVOCATION IS NOT ACTING ON ONE.** The learned
            revocation was appended to `KnownPerson::revoked` and nothing else
            happened: the revoked device kept its `peers.json` entry and any
            session it already held stayed open. It was refused at the CIRCLE
            door and admitted at every other one — the door it did not need. */
            let alice = TestNode::start("revoke-alice", Role::Shelf).await;
            let bob = TestNode::start("revoke-bob", Role::Shelf).await;
            let stolen = some_device();
            let bob_device = bob.node.id().to_string();
            let bob_person =
                alice_knows_bob(&alice, &bob, &[bob_device.clone(), stolen.clone()]).await;

            /* Alice trusts the device bob is about to revoke. */
            {
                let mut peers = alice.node.peers();
                peers
                    .insert(crate::peers::PeerRecord {
                        id: stolen.clone(),
                        name: "Bob's old phone".into(),
                        platform: String::new(),
                        role: crate::role::Role::Shelf,
                        grants: Vec::new(),
                        paired_at: 0,
                        last_seen_at: 0,
                        last_addrs: Vec::new(),
                    })
                    .unwrap();
            }

            /* Bob revokes it, and says so in the roster he introduces with. */
            {
                let keychain = bob.node.keychain();
                let root = bob.node.root().to_path_buf();
                let mut mine = mine_for(keychain.as_ref(), &root, &bob_device, now_ms()).unwrap();
                mine.roster.roster.revocations.push(stolen.clone());
                mine.roster =
                    sign_roster(keychain.as_ref(), &root, mine.roster.roster.clone()).unwrap();
                write_mine(&root, &mine).unwrap();
            }

            assert!(introduce(&bob.node, addr_of(&alice)).await.unwrap());

            assert!(
                alice.node.peers().get(&stolen).is_none(),
                "the revoked device lost its device trust, not merely its circle entry"
            );
            let stored = known_people(alice.node.root()).unwrap();
            let entry = stored
                .iter()
                .find(|k| k.person == bob_person.to_string())
                .unwrap();
            assert!(entry.revoked.contains(&stolen), "and it is remembered");
            alice.close().await;
            bob.close().await;
        }

        #[tokio::test]
        async fn nobody_can_revoke_a_device_that_was_never_theirs() {
            /* ⚠️ **THE HOLE THE FIX ABOVE WOULD OTHERWISE OPEN.** A hello
            carries the sender's revocation list. Obeying it unchecked turns
            every person in the circle into an eviction primitive: name any
            device id — this reader's own laptop, a device belonging to
            somebody else entirely — and it is dropped from `peers.json` and
            its sessions closed. A revocation is a statement about YOUR OWN
            devices, and `KnownPerson::devices` is what makes that checkable. */
            let alice = TestNode::start("revoke-alice2", Role::Shelf).await;
            let bob = TestNode::start("revoke-bob2", Role::Shelf).await;
            let bob_device = bob.node.id().to_string();
            /* Bob has only ever vouched for his own device. */
            alice_knows_bob(&alice, &bob, std::slice::from_ref(&bob_device)).await;

            let not_bobs = some_device();
            {
                let mut peers = alice.node.peers();
                peers
                    .insert(crate::peers::PeerRecord {
                        id: not_bobs.clone(),
                        name: "Somebody else entirely".into(),
                        platform: String::new(),
                        role: crate::role::Role::Shelf,
                        grants: Vec::new(),
                        paired_at: 0,
                        last_seen_at: 0,
                        last_addrs: Vec::new(),
                    })
                    .unwrap();
            }
            {
                let keychain = bob.node.keychain();
                let root = bob.node.root().to_path_buf();
                let mut mine = mine_for(keychain.as_ref(), &root, &bob_device, now_ms()).unwrap();
                mine.roster.roster.revocations.push(not_bobs.clone());
                mine.roster =
                    sign_roster(keychain.as_ref(), &root, mine.roster.roster.clone()).unwrap();
                write_mine(&root, &mine).unwrap();
            }

            assert!(introduce(&bob.node, addr_of(&alice)).await.unwrap());

            assert!(
                alice.node.peers().get(&not_bobs).is_some(),
                "bob evicted a device that was never his"
            );
            alice.close().await;
            bob.close().await;
        }

        #[tokio::test]
        async fn a_first_hello_revokes_nothing() {
            /* Somebody met but not yet heard from has vouched for no devices,
            so their first roster cannot evict anything. Right, and not an
            accident: nothing has been trusted on their word yet. */
            let alice = TestNode::start("revoke-alice3", Role::Shelf).await;
            let bob = TestNode::start("revoke-bob3", Role::Shelf).await;
            let bob_device = bob.node.id().to_string();
            alice_knows_bob(&alice, &bob, &[]).await;

            let other = some_device();
            {
                let mut peers = alice.node.peers();
                peers
                    .insert(crate::peers::PeerRecord {
                        id: other.clone(),
                        name: "Anybody".into(),
                        platform: String::new(),
                        role: crate::role::Role::Shelf,
                        grants: Vec::new(),
                        paired_at: 0,
                        last_seen_at: 0,
                        last_addrs: Vec::new(),
                    })
                    .unwrap();
            }
            {
                let keychain = bob.node.keychain();
                let root = bob.node.root().to_path_buf();
                let mut mine = mine_for(keychain.as_ref(), &root, &bob_device, now_ms()).unwrap();
                mine.roster.roster.revocations.push(other.clone());
                mine.roster =
                    sign_roster(keychain.as_ref(), &root, mine.roster.roster.clone()).unwrap();
                write_mine(&root, &mine).unwrap();
            }

            assert!(introduce(&bob.node, addr_of(&alice)).await.unwrap());
            assert!(alice.node.peers().get(&other).is_some());
            alice.close().await;
            bob.close().await;
        }

        #[tokio::test]
        async fn a_hello_records_whose_devices_those_are() {
            /* The state the two tests above rest on. Without it every
            revocation check silently passes over an empty set and the
            binding is unenforced while looking enforced. */
            let alice = TestNode::start("revoke-alice4", Role::Shelf).await;
            let bob = TestNode::start("revoke-bob4", Role::Shelf).await;
            let bob_device = bob.node.id().to_string();
            let bob_person = alice_knows_bob(&alice, &bob, &[]).await;

            assert!(introduce(&bob.node, addr_of(&alice)).await.unwrap());

            let stored = known_people(alice.node.root()).unwrap();
            let entry = stored
                .iter()
                .find(|k| k.person == bob_person.to_string())
                .unwrap();
            assert_eq!(entry.devices, vec![bob_device]);
            alice.close().await;
            bob.close().await;
        }

        #[tokio::test]
        async fn the_door_a_stranger_may_knock_on_is_bounded() {
            /* ⚠️ **THE ONE DOOR AN UNKNOWN ENDPOINT MAY SPEAK ON HAD NO BOUND
            ON HOW MANY MAY SPEAK.** Every other limit is per-connection — a
            timeout, a frame cap — and none of them stops a peer opening ten
            thousand connections instead of one big frame. Each costs a file
            read and two ed25519 verifications before anything can refuse it,
            so the work lands on the defender. */
            let alice = TestNode::start("busy-alice", Role::Shelf).await;
            let bob = TestNode::start("busy-bob", Role::Shelf).await;

            /* Hold every permit, as `MAX_HELLOS` concurrent hellos would. */
            let held = alice
                .node
                .hello_limit
                .clone()
                .acquire_many_owned(MAX_HELLOS as u32)
                .await
                .unwrap();

            {
                let keychain = bob.node.keychain();
                let root = bob.node.root().to_path_buf();
                person::ensure(keychain.as_ref(), &root).unwrap();
            }
            let refused = introduce(&bob.node, addr_of(&alice)).await;

            /* Closed without an ack, so the caller gets a transport error
            rather than "you are not in the circle". A peer told `false`
            stops trying; this one should come back in a second. */
            assert!(
                refused.is_err(),
                "a full door answered as though it had decided: {refused:?}"
            );

            /* And a permit returning lets the next caller straight in — the
            cap is a bound, not a latch. */
            drop(held);
            assert_eq!(
                introduce(&bob.node, addr_of(&alice)).await.ok(),
                Some(false),
                "answered once there was room"
            );
            alice.close().await;
            bob.close().await;
        }

        #[tokio::test]
        async fn serving_one_introduction_gives_the_permit_back() {
            /* ⚠️ **A PERMIT THAT LEAKS IS A DOOR THAT CLOSES FOR EVER**, and
            it closes slowly enough that nobody connects it to the eighth
            introduction. Held by an RAII guard rather than released by hand
            for exactly that reason — every early return in `serve` would
            otherwise need to remember. */
            let alice = TestNode::start("permit-alice", Role::Shelf).await;
            let bob = TestNode::start("permit-bob", Role::Shelf).await;
            {
                let keychain = bob.node.keychain();
                let root = bob.node.root().to_path_buf();
                person::ensure(keychain.as_ref(), &root).unwrap();
            }

            for _ in 0..MAX_HELLOS + 2 {
                // Refused every time — alice knows nobody — and that is a
                // completed introduction, which must return its permit.
                assert_eq!(
                    introduce(&bob.node, addr_of(&alice)).await.ok(),
                    Some(false)
                );
            }
            /* ⚠️ **A BOUNDED WAIT, NOT AN IMMEDIATE READ.** `introduce`
            returns the moment it has the ack; alice's own task is still
            running its close when it does, so reading the count right here
            legitimately saw 7 of 8. That is a race in the ASSERTION, not a
            leak — and the claim being made is a liveness one: the permits come
            back. A leak still fails this, it just takes five seconds. */
            let returned = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while alice.node.hello_limit.available_permits() < MAX_HELLOS {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await;
            assert!(
                returned.is_ok(),
                "permits were not returned: {} of {MAX_HELLOS}",
                alice.node.hello_limit.available_permits()
            );
            alice.close().await;
            bob.close().await;
        }

        #[tokio::test]
        async fn a_stranger_is_answered_rather_than_left_hanging() {
            /* A refusal the caller never receives is indistinguishable from a
            hung server, and it was the latter. */
            let alice = TestNode::start("hello-alice", Role::Shelf).await;
            let bob = TestNode::start("hello-bob", Role::Shelf).await;
            let d = signed(
                &bob.node.id().to_string(),
                now_ms() - 1_000,
                now_ms() + 60_000,
                1,
            );
            let hello = hello_for(d, 1, 1, &[&bob.node.id().to_string()]);

            let ack = say_hello(&bob, &alice, &hello).await;

            assert_eq!(ack.map(|a| a.admitted), Some(false));
            alice.close().await;
        }

        #[tokio::test]
        async fn somebody_already_met_is_admitted_and_can_then_be_dialled() {
            /* The door's whole promise: admit, then the ORDINARY ALPN answers.
            This failed twice over — the ack never arrived, and admission
            wrote a `PeerStore` loaded from disk rather than the running
            node's, so the retry was refused until a restart. */
            let alice = TestNode::start("hello-alice2", Role::Shelf).await;
            let bob = TestNode::start("hello-bob2", Role::Shelf).await;
            let bob_device = bob.node.id().to_string();
            let d = signed(&bob_device, now_ms() - 1_000, now_ms() + 60_000, 1);
            let person = d.delegation.person.clone();
            set_known_people(alice.node.root(), &[met(&person, 0, 0)]).unwrap();
            let hello = hello_for(d, 1, 1, &[&bob_device]);

            let ack = say_hello(&bob, &alice, &hello).await;

            assert_eq!(ack.map(|a| a.admitted), Some(true));
            /* In the RUNNING node, not merely on disk. */
            assert!(alice.node.peers().get(&bob_device).is_some());
            alice.close().await;
        }
    }
}
