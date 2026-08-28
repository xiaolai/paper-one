//! The credential a browser holds after it types the right six digits, and the
//! revocation that takes it away (phase 18, WI-18.2 and WI-18.3; persisted in
//! phase 20, WI-20.29).
//!
//! ## Why admission is two-phase
//!
//! The obvious shape is one call: look the credential up, and if it is there,
//! register the connection. Between those two acts there is a window, and the
//! review found it (finding 7): validate, then a revocation lands, then the
//! connection registers — and the browser the human just revoked is holding an
//! authenticated channel while the UI says it is gone.
//!
//! So [`Sessions::validate`] answers a question and grants nothing. It returns
//! an [`Admission`], which is a *claim about a moment*. [`Sessions::admit`]
//! re-checks that moment against the present and only then registers. A
//! revocation in between makes the admission fail closed.
//!
//! **The load-bearing half is the liveness re-check**, not the generation
//! counter. Re-reading the credential's presence at admit time is what closes
//! the race; the generation is what makes a *whole-tailnet* revocation
//! (`revoke_all`) reach admissions that are already in flight, which a
//! per-credential check alone would miss.
//!
//! ## Why the credential is not compared in constant time
//!
//! Deliberate, and the opposite of the decision one module over. The 6-digit
//! code is ~20 bits and a timing oracle against it is worth having, so
//! `Code::matches` uses `subtle`. A credential is 256 bits from the CSPRNG:
//! an attacker who can time a hash-map probe to within a nanosecond still needs
//! 2²⁵⁶ probes, and the map lookup is what makes revocation O(1). Spending
//! constant-time comparison here would be ritual rather than defence.
//!
//! ## Why the set is on disk, and why it holds hashes
//!
//! ⚠️ **THIS WAS AN IN-MEMORY MAP, AND THE COOKIE PROMISED NINETY DAYS.** Every
//! restart of the shelf forgot every browser: the phone presented a credential
//! the cookie said was good for three months and was answered 401, and the
//! reader typed six digits again. Of nine self-hosted media and book servers
//! surveyed for the decision (D6 in the phase-20 plan), only one loses sessions
//! on restart, and it hides that behind a remember-me cookie with no server-side
//! list. The two that went through a recent security cycle — Immich,
//! Audiobookshelf — converged on the same shape: a hashed token in a table, a
//! device list, and a revoke-all. OWASP ASVS 5.0 §7.4.3 and §7.5.2 require
//! exactly that.
//!
//! The file holds `sha256(credential)`, never the credential. The map in memory
//! is keyed by the same hash, so the plaintext exists in exactly one place: the
//! browser's cookie. That is what makes the file safe to back up, and it costs
//! one hash per lookup — nothing, against a 256-bit random value with no
//! preimage to find.
//!
//! Time is WALL-CLOCK here (`SystemTime`), because a monotonic `Instant` cannot
//! be written to a file. The one consequence: a system clock set back extends a
//! credential by that much, and one set forward shortens it. Every server in
//! the survey lives with the same thing.
//!
//! ## What this module does NOT do
//!
//! It does not know what a cookie is. The `HttpOnly; Secure; SameSite=Strict`
//! attributes that keep a hostile EPUB from reading the credential
//! (`rendererIsolation.test.ts` — book JavaScript runs in the app's own origin)
//! are the server's business, in WI-18.4. This module only ever sees the
//! value.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::AttemptId;

/// How long a credential is good for, however active it is.
///
/// "Long-lived" in the plan means "the human does not retype six digits every
/// day", not "forever". An absolute ceiling means a browser forgotten on a
/// borrowed laptop stops working on its own. The cookie's `Max-Age` is this
/// same number, read from here.
pub const CREDENTIAL_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 90);

/// The longest device label the file will hold.
///
/// The label is derived from a `User-Agent` a browser chose, so it is input
/// from the network and is bounded here regardless of what the caller did.
pub const LABEL_MAX: usize = 80;

/// How far `last_seen` has to move before the file is rewritten for it.
///
/// A validation happens per handshake and per client boot, not per frame, so
/// the write would be cheap anyway; the granularity is here so that a browser
/// reconnecting in a tight loop cannot turn the session file into a hot
/// write path. "Last seen" to the minute is what the pane shows.
const LAST_SEEN_GRANULARITY: Duration = Duration::from_secs(60);

/// The on-disk format's version. Bumped when a row changes shape.
const FILE_VERSION: u32 = 1;

/// The opaque value a browser presents. 256 bits from the CSPRNG.
///
/// Deliberately not `Debug`: this is the one string in the system whose
/// appearance in a log is a compromise, and a derived `Debug` is how it would
/// get there. Deliberately not `Serialize` either, for the same reason one
/// layer down: the file holds [`CredentialHash`], and a type that cannot be
/// serialised cannot be written by accident.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Credential(String);

impl Credential {
    fn fresh() -> Self {
        /* Two draws rather than one: `u128` is the widest `rand::random` gives
         * directly, and 128 bits is not the number this wants to be. */
        Self(format!(
            "{:032x}{:032x}",
            rand::random::<u128>(),
            rand::random::<u128>()
        ))
    }

    /// Borrow the value to put it on the wire. The only way out, so every
    /// escape is visible at a call site.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Rebuild from a value a browser presented. Does not imply validity.
    pub fn from_presented(value: &str) -> Self {
        Self(value.to_owned())
    }

    /// What the set is keyed by, in memory and on disk.
    pub fn hash(&self) -> CredentialHash {
        CredentialHash(format!("{:x}", Sha256::digest(self.0.as_bytes())))
    }
}

/// `sha256(credential)`, hex. Safe to write down: a 256-bit random credential
/// has no preimage to find, so the hash names the browser without being able
/// to become it.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CredentialHash(String);

/// A live browser session.
///
/// DURABLE, unlike a socket id: it identifies the CREDENTIAL, so it survives a
/// browser closing its tab and reconnecting — and, since the set is on disk,
/// the shelf restarting. That is what makes it the right thing to show a reader
/// who is deciding what to revoke, and the right thing for the pipe to close
/// sockets by.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct SessionId(u64);

impl SessionId {
    /// The number, for a wire that has no newtypes.
    pub fn as_u64(self) -> u64 {
        self.0
    }

    /// Rebuild from a number a caller sent back. Does not imply it is live.
    pub fn from_u64(id: u64) -> Self {
        Self(id)
    }
}

/// The right to register a connection, valid only against the state that
/// produced it.
///
/// `#[must_use]`: an admission that is validated and never admitted is a
/// connection that authenticated and never registered, which is a leak of the
/// most confusing kind — the browser works and nothing can revoke it.
#[must_use = "an admission must be admitted or dropped, never assumed"]
pub struct Admission {
    hash: CredentialHash,
    generation: u64,
    /// When this credential stops being good, whatever is holding it.
    ///
    /// ⚠️ **EXPIRY WAS CHECKED AT THE HANDSHAKE AND NOWHERE ELSE**, and a
    /// WebSocket outlives the request that made it. A browser that connected
    /// on day 89 held an authenticated channel indefinitely: nothing re-read
    /// the issue time once the socket was open, so `CREDENTIAL_TTL` — the whole
    /// point of which is that a browser forgotten on a borrowed laptop stops
    /// working ON ITS OWN — bounded only the act of connecting.
    ///
    /// Carried out so the caller holding the socket can close it at the
    /// deadline. `Sessions` cannot: it does not know what a socket is, which
    /// is the same division `revoke` is documented under.
    expires_at: SystemTime,
}

impl Admission {
    /// When the credential behind this admission stops being good.
    pub fn expires_at(&self) -> SystemTime {
        self.expires_at
    }
}

/// Why an admission or a validation failed.
#[derive(Debug, PartialEq, Eq)]
pub enum Rejected {
    /// No such credential — never issued, or already revoked.
    Unknown,
    /// Issued, but past [`CREDENTIAL_TTL`].
    Expired,
    /// Valid when it was checked; revoked between then and now. The race
    /// finding 7 named.
    RevokedMeanwhile,
}

/// What the Browsers pane shows about one credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRecord {
    pub id: SessionId,
    /// The device, as described at pairing time — "Safari on iPhone".
    pub label: String,
    pub created: SystemTime,
    pub last_seen: SystemTime,
    pub expires_at: SystemTime,
}

/// A change that was APPLIED, and whether it reached the disk.
///
/// A revocation is applied in memory first, unconditionally: the browser is
/// cut off now whatever the disk does. `saved` says whether it will STAY cut
/// off across a restart. The two are separate answers and the caller has to
/// show both — a pane that said "failed" over a browser that had in fact just
/// been revoked would be lying in the safe direction, which is still lying.
#[must_use = "the change was applied; `saved` says whether it will survive a restart"]
pub struct Outcome<T> {
    pub applied: T,
    pub saved: io::Result<()>,
}

struct Session {
    id: SessionId,
    /// The attempt that earned this credential, while this process remembers
    /// it. `None` after a reload: attempts live in `DeviceAuth`, which is
    /// deliberately not persisted, so a credential read back from disk has no
    /// attempt to point at.
    attempt: Option<AttemptId>,
    label: String,
    created: SystemTime,
    last_seen: SystemTime,
    /// Absolute, and STORED rather than derived from `created` on every read,
    /// so a later change to `CREDENTIAL_TTL` does not silently lengthen or
    /// shorten what a browser was already issued.
    expires_at: SystemTime,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    generation: u64,
    live: HashMap<CredentialHash, Session>,
}

/// Every credential this shelf has issued and not revoked.
///
/// One mutex, taken synchronously, never held across an await — the same rule
/// [`crate::DeviceAuth`] follows and for the same reason. The file, when there
/// is one, is written under the same lock, so two mutations cannot interleave
/// their writes; two PROCESSES are excluded by the data-root lock the app
/// takes at launch.
#[derive(Default)]
pub struct Sessions {
    inner: Mutex<Inner>,
    /// Where the set lives between runs. `None` is an in-memory set — tests,
    /// and a shelf whose data root could not be read, which is logged where
    /// it happens.
    store: Option<PathBuf>,
}

/// The shape on disk. Every field is something the pane shows or the next
/// launch needs; NOTHING in it can become a credential.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    version: u32,
    next_id: u64,
    sessions: Vec<Row>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: u64,
    hash: CredentialHash,
    label: String,
    created_ms: u64,
    last_seen_ms: u64,
    expires_at_ms: u64,
}

/// Epoch milliseconds, saturating at zero for a clock before 1970.
fn ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn from_ms(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

/// A label the file will hold: printable, and no longer than [`LABEL_MAX`].
///
/// Derived from a `User-Agent`, which a browser — or anything that can reach
/// the port — chose. Control characters would let a hostile client write a
/// newline into a line of the pane or a log; the bound keeps the file from
/// growing by whatever a client cares to send.
fn clean_label(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .filter(|c| !c.is_control())
        .take(LABEL_MAX)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "A browser".to_owned()
    } else {
        trimmed.to_owned()
    }
}

impl Sessions {
    /// An in-memory set. Forgets everything when dropped.
    pub fn new() -> Self {
        Self::default()
    }

    /// The set at `path`, read if the file exists and written on every change.
    ///
    /// Rows already past their expiry are dropped on the way in. A file this
    /// build cannot read — a later version, or bytes that are not the format —
    /// is an error rather than an empty set: the caller decides whether to
    /// start empty, and says so where it can be seen.
    pub fn persisted(path: impl Into<PathBuf>) -> io::Result<Self> {
        Self::persisted_at(path, SystemTime::now())
    }

    /// [`Sessions::persisted`] with the clock injected.
    pub fn persisted_at(path: impl Into<PathBuf>, now: SystemTime) -> io::Result<Self> {
        let path = path.into();
        let inner = load(&path, now)?.unwrap_or_default();
        Ok(Self {
            inner: Mutex::new(inner),
            store: Some(path),
        })
    }

    /// Issue a credential for an authorization that was earned.
    ///
    /// Takes [`crate::Granted`] by value rather than an `AttemptId` a caller
    /// could have got anywhere: the type is the proof that six correct digits
    /// arrived, and it can only be built by [`crate::DeviceAuth::submit`].
    ///
    /// `label` describes the device for the pane — "Safari on iPhone" — and is
    /// bounded here whatever the caller passed.
    ///
    /// ⚠️ A credential that cannot be SAVED is not issued. It would work until
    /// the next restart and then vanish, and the reader would be told the
    /// shelf was fine. The error goes back to the handshake instead, which
    /// fails loudly with the disk as the reason.
    pub fn issue(
        &self,
        granted: crate::Granted,
        now: SystemTime,
        label: &str,
    ) -> io::Result<Credential> {
        let credential = Credential::fresh();
        let hash = credential.hash();
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        guard.next_id += 1;
        let id = SessionId(guard.next_id);
        guard.live.insert(
            hash.clone(),
            Session {
                id,
                attempt: Some(granted.attempt),
                label: clean_label(label),
                created: now,
                last_seen: now,
                expires_at: now + CREDENTIAL_TTL,
            },
        );
        if let Err(error) = self.save(&guard) {
            /* ROLLED BACK, id and all — nothing was issued. */
            guard.live.remove(&hash);
            guard.next_id -= 1;
            return Err(error);
        }
        Ok(credential)
    }

    /// Ask whether a presented credential is currently good. Grants nothing.
    ///
    /// Records the sighting: `last_seen` moves to `now` (to the minute), and
    /// the file follows it best-effort — an unrecordable "last seen" must not
    /// log a reader out, and a disk that cannot be written will be reported
    /// by the next change that matters.
    pub fn validate(&self, presented: &Credential, now: SystemTime) -> Result<Admission, Rejected> {
        let hash = presented.hash();
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        let generation = guard.generation;
        let Some(session) = guard.live.get_mut(&hash) else {
            return Err(Rejected::Unknown);
        };
        if now >= session.expires_at {
            guard.live.remove(&hash);
            let _ = self.save(&guard);
            return Err(Rejected::Expired);
        }
        let expires_at = session.expires_at;
        let moved = now
            .duration_since(session.last_seen)
            .is_ok_and(|since| since >= LAST_SEEN_GRANULARITY);
        if moved {
            session.last_seen = now;
            let _ = self.save(&guard);
        }
        Ok(Admission {
            hash,
            generation,
            expires_at,
        })
    }

    /// Register a connection against an admission, re-checking the present.
    ///
    /// ⚠️ **THE GENERATION IS `revoke_all`'S ALONE, and it used to be every
    /// revocation's.** `revoke` bumped it too, so signing one browser out
    /// rejected an admission ALREADY IN FLIGHT for a completely unrelated
    /// credential — the second browser's handshake failed, with
    /// `RevokedMeanwhile`, about a revocation that was not theirs. Failing
    /// closed is the safe direction, which is exactly why it went unnoticed:
    /// the reader sees an occasional handshake that has to be retried.
    ///
    /// The liveness re-check below is what closes finding 7's window, per
    /// credential, and it is unaffected. The generation exists for the one
    /// thing a per-credential check cannot see: `revoke_all` is a statement
    /// about the WHOLE SET, so an admission taken before it must fail even
    /// though its own credential is being removed in the same breath.
    pub fn admit(&self, admission: Admission) -> Result<SessionId, Rejected> {
        let guard = self.inner.lock().expect("sessions mutex poisoned");
        /* THE RE-CHECK, which is the whole point of the two-phase shape. */
        let Some(session) = guard.live.get(&admission.hash) else {
            return Err(Rejected::RevokedMeanwhile);
        };
        if guard.generation != admission.generation {
            return Err(Rejected::RevokedMeanwhile);
        }
        Ok(session.id)
    }

    /// Revoke one credential. `applied` is the session it closed, if any, so
    /// the caller can tear down the live channel that belongs to it.
    ///
    /// ⚠️ **This does not close anything by itself.** Plan §7 lists four things
    /// revocation touches; this module owns one of them. The caller must close
    /// the live channel, abort in-flight streams, and drop the router's grant
    /// cache entry. A revocation that only forgets the credential leaves an
    /// open socket answering requests.
    pub fn revoke(&self, credential: &Credential) -> Outcome<Option<SessionId>> {
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        /* THE GENERATION IS NOT TOUCHED HERE — see [`Sessions::admit`].
         * Removing the credential is what fails an in-flight admission for THIS
         * browser, and bumping the generation as well failed every other
         * browser's too. */
        let applied = guard.live.remove(&credential.hash()).map(|s| s.id);
        let saved = self.save(&guard);
        Outcome { applied, saved }
    }

    /// Revoke everything. The "this laptop was stolen" button.
    ///
    /// The generation moves, so an admission already in flight for ANY
    /// credential fails — this is a statement about the whole set. The
    /// caller closes every socket and retires whatever pairing material is on
    /// screen; this module does not know about either.
    pub fn revoke_all(&self) -> Outcome<Vec<SessionId>> {
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        let mut applied: Vec<SessionId> = guard.live.values().map(|s| s.id).collect();
        applied.sort();
        guard.live.clear();
        guard.generation += 1;
        let saved = self.save(&guard);
        Outcome { applied, saved }
    }

    /// The attempt a live credential came from, while this process remembers
    /// it. `None` for a credential read back from disk — see [`Session`].
    pub fn attempt_of(&self, credential: &Credential) -> Option<AttemptId> {
        self.inner
            .lock()
            .expect("sessions mutex poisoned")
            .live
            .get(&credential.hash())
            .and_then(|s| s.attempt.clone())
    }

    /// Every credential this shelf has issued and not revoked, by session id.
    ///
    /// ⚠️ **THIS IS THE LIST A READER REVOKES FROM, and there was none.** The
    /// Browsers pane enumerated live SOCKETS instead, which is a different set:
    /// a browser that signed in and then closed its tab holds a credential good
    /// for [`CREDENTIAL_TTL`] — ninety days — and has no socket, so it did not
    /// appear, and there was no way to cut it off. It simply came back.
    ///
    /// Sorted, so the pane's order does not depend on hash iteration.
    pub fn live_sessions(&self) -> Vec<SessionId> {
        let guard = self.inner.lock().expect("sessions mutex poisoned");
        let mut ids: Vec<SessionId> = guard.live.values().map(|s| s.id).collect();
        ids.sort();
        ids
    }

    /// What the pane shows: every unexpired credential, oldest first, with the
    /// device it was issued to and when it was last seen.
    pub fn records(&self, now: SystemTime) -> Vec<SessionRecord> {
        let guard = self.inner.lock().expect("sessions mutex poisoned");
        let mut records: Vec<SessionRecord> = guard
            .live
            .values()
            .filter(|s| now < s.expires_at)
            .map(|s| SessionRecord {
                id: s.id,
                label: s.label.clone(),
                created: s.created,
                last_seen: s.last_seen,
                expires_at: s.expires_at,
            })
            .collect();
        records.sort_by_key(|r| r.id);
        records
    }

    /// Revoke by durable session id. `applied` says whether anything was live
    /// under that id, so the caller can close whatever channel it holds.
    ///
    /// Returns the ID rather than the credential, because the credential is
    /// not here to return: the set holds hashes. The pipe closes sockets by
    /// the same id, so nothing downstream needs the plaintext either.
    pub fn revoke_by_id(&self, id: SessionId) -> Outcome<Option<SessionId>> {
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        let found = guard
            .live
            .iter()
            .find(|(_, session)| session.id == id)
            .map(|(hash, _)| hash.clone());
        /* One browser, so no generation bump — see `revoke`. */
        let applied = found
            .and_then(|hash| guard.live.remove(&hash))
            .map(|s| s.id);
        let saved = self.save(&guard);
        Outcome { applied, saved }
    }

    pub fn live_count(&self) -> usize {
        self.inner
            .lock()
            .expect("sessions mutex poisoned")
            .live
            .len()
    }

    /// Write the set to its file, whole, atomically. A no-op for an in-memory
    /// set.
    fn save(&self, inner: &Inner) -> io::Result<()> {
        let Some(path) = &self.store else {
            return Ok(());
        };
        let mut rows: Vec<Row> = inner
            .live
            .iter()
            .map(|(hash, s)| Row {
                id: s.id.0,
                hash: hash.clone(),
                label: s.label.clone(),
                created_ms: ms(s.created),
                last_seen_ms: ms(s.last_seen),
                expires_at_ms: ms(s.expires_at),
            })
            .collect();
        /* SORTED, so two saves of the same set are the same bytes. */
        rows.sort_by_key(|r| r.id);
        let file = File {
            version: FILE_VERSION,
            next_id: inner.next_id,
            sessions: rows,
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
        write_private(path, &bytes)
    }
}

/// Read the set at `path`. `None` when there is no file yet.
fn load(path: &Path, now: SystemTime) -> io::Result<Option<Inner>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let file: File = serde_json::from_slice(&bytes)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if file.version != FILE_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} is session file version {}, and this build reads version {FILE_VERSION}",
                path.display(),
                file.version
            ),
        ));
    }
    let mut inner = Inner {
        next_id: file.next_id,
        generation: 0,
        live: HashMap::new(),
    };
    for row in file.sessions {
        let expires_at = from_ms(row.expires_at_ms);
        /* Past its ceiling: not read back. The next save drops it from the
         * file too. */
        if now >= expires_at {
            continue;
        }
        /* IDS NEVER RUN BACKWARDS. A file whose rows outnumber its counter is
         * one somebody edited; the counter follows the rows rather than
         * handing a fresh browser an id a listed one already has. */
        inner.next_id = inner.next_id.max(row.id);
        inner.live.insert(
            row.hash,
            Session {
                id: SessionId(row.id),
                attempt: None,
                label: clean_label(&row.label),
                created: from_ms(row.created_ms),
                last_seen: from_ms(row.last_seen_ms),
                expires_at,
            },
        );
    }
    Ok(Some(inner))
}

/// Write `bytes` to `path` atomically, readable by this user alone.
///
/// The same shape as the peer identity's `write_new`: the directory is made
/// private, the bytes go to a sibling temp file created with mode 0600, the
/// temp file is fsynced and renamed over the target, and the mode is
/// re-asserted on the final path in case a leftover from an earlier crash
/// was created before the mode applied.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("the session file has no parent directory"))?;
    std::fs::create_dir_all(dir)?;
    tighten_dir(dir)?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    tighten_file(path)?;
    if let Ok(dir_file) = std::fs::File::open(dir) {
        /* Persist the rename. Directory fsync is Unix-only in effect; on
         * Windows opening a directory as a file fails, hence the `if let`. */
        let _ = dir_file.sync_all();
    }
    Ok(())
}

#[cfg(unix)]
fn tighten_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::metadata(path)?.permissions();
    if perms.mode() & 0o777 != 0o600 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(unix)]
fn tighten_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::metadata(path)?.permissions();
    if perms.mode() & 0o777 != 0o700 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn tighten_file(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn tighten_dir(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DeviceAuth, Outcome as CodeOutcome};
    use std::time::Instant;

    /// A real grant, because `Granted` cannot be built any other way — which is
    /// the property being relied on.
    fn granted(auth: &DeviceAuth) -> crate::Granted {
        let now = Instant::now();
        let offer = auth.begin(now);
        let digits = offer.code.digits().to_vec();
        match auth.submit(auth.reserve(now).unwrap(), &digits, now) {
            CodeOutcome::Granted(g) => g,
            other => panic!("expected a grant, got {other:?}"),
        }
    }

    fn issue(sessions: &Sessions, auth: &DeviceAuth, now: SystemTime) -> Credential {
        sessions
            .issue(granted(auth), now, "Safari on iPhone")
            .expect("an in-memory or writable set issues")
    }

    /// A scratch directory of this test's own, so two suites cannot share a
    /// file and a leftover cannot decide a later run.
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "paper-webauth-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    #[test]
    fn an_issued_credential_validates_and_admits() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let credential = issue(&sessions, &auth, now);
        let admission = sessions.validate(&credential, now).expect("valid");
        assert!(sessions.admit(admission).is_ok());
    }

    #[test]
    fn an_unknown_credential_is_unknown() {
        let sessions = Sessions::new();
        let stranger = Credential::from_presented("not-a-credential");
        assert_eq!(
            sessions.validate(&stranger, SystemTime::now()).err(),
            Some(Rejected::Unknown)
        );
    }

    #[test]
    fn two_credentials_are_distinct() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let first = issue(&sessions, &auth, now);
        let second = issue(&sessions, &auth, now);
        assert_ne!(first.as_str(), second.as_str());
        assert_eq!(first.as_str().len(), 64, "256 bits, hex");
    }

    #[test]
    fn a_revoked_credential_stops_validating() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let credential = issue(&sessions, &auth, now);
        assert!(sessions.revoke(&credential).applied.is_some());
        assert_eq!(
            sessions.validate(&credential, now).err(),
            Some(Rejected::Unknown)
        );
        assert_eq!(sessions.live_count(), 0);
    }

    #[test]
    fn validate_then_revoke_then_admit_fails_closed() {
        /* FINDING 7, exactly. The barrier the plan asks for: the admission is
         * taken, the revocation lands, and the admission must not register. */
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let credential = issue(&sessions, &auth, now);

        let admission = sessions
            .validate(&credential, now)
            .expect("valid at this moment");
        assert!(sessions.revoke(&credential).applied.is_some());

        assert_eq!(
            sessions.admit(admission).err(),
            Some(Rejected::RevokedMeanwhile)
        );
    }

    #[test]
    fn revoke_all_reaches_an_admission_already_in_flight() {
        /* What the generation counter buys over the liveness re-check alone:
         * a different credential's revocation still fails a pending admission,
         * because `revoke_all` is a statement about the whole set. */
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let mine = issue(&sessions, &auth, now);
        let admission = sessions.validate(&mine, now).expect("valid");
        let _ = sessions.revoke_all();
        assert_eq!(
            sessions.admit(admission).err(),
            Some(Rejected::RevokedMeanwhile)
        );
    }

    #[test]
    fn revoking_one_credential_leaves_the_others_working() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let doomed = issue(&sessions, &auth, now);
        let spared = issue(&sessions, &auth, now);
        let _ = sessions.revoke(&doomed);

        assert_eq!(
            sessions.validate(&doomed, now).err(),
            Some(Rejected::Unknown)
        );
        let admission = sessions
            .validate(&spared, now)
            .expect("the other one survives");
        assert!(
            sessions.admit(admission).is_ok(),
            "one revocation must not log everyone out"
        );
    }

    #[test]
    fn a_credential_past_its_ceiling_expires_and_is_forgotten() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let credential = issue(&sessions, &auth, now);
        let later = now + CREDENTIAL_TTL + Duration::from_secs(1);
        assert_eq!(
            sessions.validate(&credential, later).err(),
            Some(Rejected::Expired)
        );
        assert_eq!(
            sessions.live_count(),
            0,
            "an expired credential is dropped, not kept"
        );
    }

    #[test]
    fn the_issuing_attempt_survives_on_the_session() {
        /* Finding 9's binding, past issuance: the credential remembers which
         * attempt earned it rather than which attempt is current. */
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let grant = granted(&auth);
        let attempt = grant.attempt.clone();
        let credential = sessions.issue(grant, now, "test").expect("issued");

        auth.begin(Instant::now()); // the code rotates underneath
        assert_eq!(sessions.attempt_of(&credential), Some(attempt));
    }

    /// A BROWSER THAT IS NOT CONNECTED IS STILL A BROWSER, and the shelf had
    /// no way to name one.
    ///
    /// The Browsers pane listed live SOCKETS. A browser that signs in and then
    /// closes its tab holds a credential for [`CREDENTIAL_TTL`] — ninety days —
    /// and holds no socket, so it was absent from the only list there was and
    /// could not be revoked. It simply reconnected. The credential outlives the
    /// socket by design; the list has to outlive it too.
    #[test]
    fn a_credential_is_listable_and_revocable_with_no_socket_involved() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let away = issue(&sessions, &auth, now);
        let other = issue(&sessions, &auth, now);

        /* Nothing here has ever had a socket — that is the whole point. */
        let listed = sessions.live_sessions();
        assert_eq!(listed.len(), 2, "both credentials are listed");

        let id = sessions
            .validate(&away, now)
            .and_then(|admission| sessions.admit(admission))
            .expect("live");
        let removed = sessions.revoke_by_id(id).applied;
        assert_eq!(removed, Some(id), "the right one, by its durable id");

        assert_eq!(sessions.validate(&away, now).err(), Some(Rejected::Unknown));
        assert_eq!(sessions.live_sessions().len(), 1, "and only that one");
        assert!(
            sessions.validate(&other, now).is_ok(),
            "revoking one browser must not log the others out"
        );
    }

    #[test]
    fn revoking_an_id_that_is_not_live_changes_nothing() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let held = issue(&sessions, &auth, now);
        assert!(sessions
            .revoke_by_id(SessionId::from_u64(9999))
            .applied
            .is_none());
        assert!(sessions.validate(&held, now).is_ok());
    }

    /// ⚠️ **ONE BROWSER'S REVOCATION MUST NOT FAIL ANOTHER'S HANDSHAKE.**
    ///
    /// `revoke` used to bump the generation, and `admit` compares it — so an
    /// admission already in flight for a completely unrelated credential was
    /// rejected with `RevokedMeanwhile`, about a revocation that was not
    /// theirs. It fails CLOSED, which is why it went unnoticed: the reader sees
    /// an occasional handshake that has to be retried.
    #[test]
    fn revoking_one_browser_does_not_fail_anothers_admission_in_flight() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let mine = issue(&sessions, &auth, now);
        let theirs = issue(&sessions, &auth, now);

        /* My handshake is under way… */
        let admission = sessions.validate(&mine, now).expect("valid");
        /* …and somebody else signs out in the middle of it. */
        assert!(sessions.revoke(&theirs).applied.is_some());

        assert!(
            sessions.admit(admission).is_ok(),
            "another browser signing out is not a revocation of this one"
        );
    }

    /// AND THE ADMISSION KNOWS WHEN IT RUNS OUT.
    ///
    /// Expiry was checked at the handshake and nowhere else, and a WebSocket
    /// outlives the request that made it — so a browser connecting on day 89
    /// held an authenticated channel indefinitely. `Sessions` cannot close a
    /// socket; it can say when the credential stops being good, which is what
    /// the caller holding one needs.
    #[test]
    fn an_admission_carries_the_credentials_ceiling() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let credential = issue(&sessions, &auth, now);

        let admission = sessions.validate(&credential, now).expect("valid");
        assert_eq!(admission.expires_at(), now + CREDENTIAL_TTL);

        /* And it is the ISSUE time's ceiling, not the moment of asking — a
         * credential does not get a fresh ninety days for being presented. */
        let later = now + Duration::from_secs(60 * 60 * 24);
        let again = sessions.validate(&credential, later).expect("still valid");
        assert_eq!(again.expires_at(), now + CREDENTIAL_TTL);
    }

    /// `Credential` MUST NOT BE PRINTABLE, and the doc comment saying so is not
    /// a mechanism.
    ///
    /// This is the one string in the system whose appearance in a log is a
    /// compromise. A derived `Debug` is how it would get there — not because
    /// somebody logs it deliberately, but because it rides inside something
    /// else that is logged: a `#[derive(Debug)]` struct that holds one, a
    /// `.unwrap()` on a `Result<_, Credential>`, an `assert_eq!` in a test.
    /// Every one of those is a compile error while this holds, and all of them
    /// become one-line edits the moment it does not.
    ///
    /// Rust cannot assert the ABSENCE of a trait impl on stable, so this reads
    /// the source — the same instrument `tauri-plugin-inference`'s `limits.rs`
    /// uses on `commands.rs`, and for the same reason: the property is real,
    /// cheap to break by accident, and silent when broken.
    #[test]
    fn the_credential_cannot_be_printed() {
        let derives = credential_derives();
        assert!(
            !derives.contains("Debug"),
            "Credential derives Debug. It is the one value whose appearance in a \
             log is a compromise, and Debug is how it gets into one — inside \
             another struct's derived output, or an unwrap, or an assert. \
             Use `as_str()` at a call site instead, where the escape is visible."
        );
    }

    /// The derive list immediately above `pub struct Credential(`.
    fn credential_derives() -> &'static str {
        let source = include_str!("sessions.rs");
        let at = source.find("pub struct Credential(").expect(
            "Credential is gone, or is no longer a tuple struct — this guard cannot see it",
        );
        let before = &source[..at];
        let derive_at = before
            .rfind("#[derive(")
            .expect("Credential has no derive list at all — check this guard still points at it");
        &before[derive_at..]
    }

    // ── the set on disk ─────────────────────────────────────────────────────

    /// A RESTART FORGOT EVERY BROWSER, under a cookie promising ninety days.
    #[test]
    fn a_credential_survives_a_reload_from_disk() {
        let dir = scratch();
        let path = dir.join("webhost").join("sessions.json");
        let (auth, now) = (DeviceAuth::new(), SystemTime::now());

        let credential = {
            let sessions = Sessions::persisted_at(&path, now).expect("a fresh set");
            issue(&sessions, &auth, now)
        };

        /* THE SHELF RESTARTS. Everything in memory is gone; the file is not. */
        let reloaded = Sessions::persisted_at(&path, now).expect("the set reads back");
        let admission = reloaded
            .validate(&credential, now + Duration::from_secs(60))
            .expect("the browser is still signed in");
        let id = reloaded.admit(admission).expect("and admits");
        assert_eq!(reloaded.live_count(), 1);

        /* AND IDS KEEP COUNTING. A fresh browser after the restart must not be
         * handed the id a listed one already has, or a revoke-by-id names the
         * wrong phone. */
        let later = issue(&reloaded, &auth, now);
        let later_id = reloaded
            .validate(&later, now)
            .and_then(|a| reloaded.admit(a))
            .expect("live");
        assert!(later_id > id, "ids must continue past the reloaded ones");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn expiry_is_honoured_across_a_reload() {
        let dir = scratch();
        let path = dir.join("sessions.json");
        let (auth, now) = (DeviceAuth::new(), SystemTime::now());
        let credential = {
            let sessions = Sessions::persisted_at(&path, now).expect("a fresh set");
            issue(&sessions, &auth, now)
        };

        /* IT DID SURVIVE — asserted first, or the absence below would be true
         * of a set that never wrote anything. A knockout of `save` passed
         * this test's first draft. */
        assert!(
            Sessions::persisted_at(&path, now)
                .expect("the set reads back")
                .validate(&credential, now)
                .is_ok(),
            "the credential must be on disk for its expiry there to mean anything"
        );

        /* Ninety days and a second later, on a new process. */
        let later = now + CREDENTIAL_TTL + Duration::from_secs(1);
        let reloaded = Sessions::persisted_at(&path, later).expect("the set reads back");
        assert_eq!(
            reloaded.validate(&credential, later).err(),
            Some(Rejected::Unknown),
            "an expired row is not read back at all"
        );
        assert!(reloaded.records(later).is_empty());

        /* And one that expires AFTER the reload, while the process runs. */
        let credential = issue(&reloaded, &auth, later);
        let past = later + CREDENTIAL_TTL;
        assert_eq!(
            reloaded.validate(&credential, past).err(),
            Some(Rejected::Expired)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_revocation_survives_a_reload() {
        let dir = scratch();
        let path = dir.join("sessions.json");
        let (auth, now) = (DeviceAuth::new(), SystemTime::now());
        let (kept, doomed) = {
            let sessions = Sessions::persisted_at(&path, now).expect("a fresh set");
            let kept = issue(&sessions, &auth, now);
            let doomed = issue(&sessions, &auth, now);
            let revoked = sessions.revoke(&doomed);
            assert!(revoked.applied.is_some());
            revoked.saved.expect("saved");
            (kept, doomed)
        };
        let reloaded = Sessions::persisted_at(&path, now).expect("the set reads back");
        assert_eq!(
            reloaded.validate(&doomed, now).err(),
            Some(Rejected::Unknown),
            "a revoked browser must not come back after a restart"
        );
        assert!(reloaded.validate(&kept, now).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn revoke_all_survives_a_reload() {
        let dir = scratch();
        let path = dir.join("sessions.json");
        let (auth, now) = (DeviceAuth::new(), SystemTime::now());
        let (one, two) = {
            let sessions = Sessions::persisted_at(&path, now).expect("a fresh set");
            let one = issue(&sessions, &auth, now);
            let two = issue(&sessions, &auth, now);
            (one, two)
        };
        /* BOTH ARE ON DISK, asserted before the sweep — otherwise "unknown
         * after the reload" is true of a set that never saved a thing. */
        let reloaded = Sessions::persisted_at(&path, now).expect("the set reads back");
        assert!(reloaded.validate(&one, now).is_ok());
        assert!(reloaded.validate(&two, now).is_ok());
        let all = reloaded.revoke_all();
        assert_eq!(all.applied.len(), 2);
        all.saved.expect("saved");
        drop(reloaded);

        let reloaded = Sessions::persisted_at(&path, now).expect("the set reads back");
        assert_eq!(reloaded.validate(&one, now).err(), Some(Rejected::Unknown));
        assert_eq!(reloaded.validate(&two, now).err(), Some(Rejected::Unknown));
        assert_eq!(reloaded.live_count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// THE FILE NEVER HOLDS THE CREDENTIAL. What it holds is the hash, which
    /// names the browser without being able to become it.
    #[test]
    fn the_file_holds_the_hash_and_never_the_credential() {
        let dir = scratch();
        let path = dir.join("sessions.json");
        let (auth, now) = (DeviceAuth::new(), SystemTime::now());
        let sessions = Sessions::persisted_at(&path, now).expect("a fresh set");
        let credential = issue(&sessions, &auth, now);

        let written = std::fs::read_to_string(&path).expect("the file");
        assert!(
            !written.contains(credential.as_str()),
            "the credential is in the file: {written}"
        );
        let CredentialHash(hex) = credential.hash();
        assert!(written.contains(&hex), "the hash is not: {written}");
        assert!(written.contains("Safari on iPhone"), "{written}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AND THE FORMAT CANNOT CARRY IT, which is a stronger claim than the test
    /// above makes: that one shows this build does not write it; this one
    /// shows no edit to the row could, short of first making `Credential`
    /// serialisable — on the `Debug` precedent, where the absence of a trait
    /// is the mechanism and reading the source is the only way to assert it.
    #[test]
    fn the_file_format_cannot_carry_the_credential() {
        assert!(
            !credential_derives().contains("Serialize"),
            "Credential derives Serialize: the plaintext can now be written to disk by any \
             struct that holds one"
        );
        let source = include_str!("sessions.rs");
        let at = source
            .find("struct Row {")
            .expect("the on-disk row is gone — this guard cannot see it");
        let end = source[at..].find("\n}\n").expect("a closed struct") + at;
        let row = &source[at..end];
        let fields: Vec<&str> = row
            .lines()
            .filter(|line| {
                line.trim_start()
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_alphabetic())
            })
            .collect();
        for field in fields {
            assert!(
                !field.contains("Credential") || field.contains("CredentialHash"),
                "the on-disk row holds a Credential: {field}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_this_user_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let path = dir.join("webhost").join("sessions.json");
        let (auth, now) = (DeviceAuth::new(), SystemTime::now());
        let sessions = Sessions::persisted_at(&path, now).expect("a fresh set");
        let _ = issue(&sessions, &auth, now);

        let mode = std::fs::metadata(&path)
            .expect("the file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "the session file must be private");
        let dir_mode = std::fs::metadata(path.parent().expect("a parent"))
            .expect("the directory")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700, "and so must its directory");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A DISK THAT CANNOT BE WRITTEN: nothing is issued, and a revocation is
    /// applied anyway — with `saved` saying it will not survive a restart.
    #[test]
    fn an_unwritable_store_refuses_to_issue_and_keeps_a_revocation_applied() {
        let dir = scratch();
        /* The "directory" the file would live in is a FILE, so nothing under
         * it can be created. */
        let blocker = dir.join("webhost");
        std::fs::write(&blocker, b"in the way").expect("a blocking file");
        let path = blocker.join("sessions.json");
        let (auth, now) = (DeviceAuth::new(), SystemTime::now());

        /* Built directly rather than through `persisted_at`, which would
         * refuse the path on the READ (a path under a file is `ENOTDIR`, not
         * "no file yet"). The question here is what the WRITE does. */
        let sessions = Sessions {
            inner: Mutex::new(Inner::default()),
            store: Some(path.clone()),
        };
        let refused = sessions.issue(granted(&auth), now, "x");
        assert!(
            refused.is_err(),
            "a credential that cannot be saved must not be issued"
        );
        assert_eq!(
            sessions.live_count(),
            0,
            "and nothing is left behind in memory"
        );

        /* A revocation of something that IS live (issued while the disk was
         * fine) still lands in memory when the disk fails. */
        let working = Sessions::new();
        let credential = issue(&working, &auth, now);
        let unsaved = Sessions {
            inner: Mutex::new(Inner {
                next_id: 1,
                generation: 0,
                live: {
                    let mut live = HashMap::new();
                    live.insert(
                        credential.hash(),
                        Session {
                            id: SessionId(1),
                            attempt: None,
                            label: "x".into(),
                            created: now,
                            last_seen: now,
                            expires_at: now + CREDENTIAL_TTL,
                        },
                    );
                    live
                },
            }),
            store: Some(path),
        };
        let outcome = unsaved.revoke(&credential);
        assert_eq!(
            outcome.applied,
            Some(SessionId(1)),
            "applied in memory regardless"
        );
        assert!(
            outcome.saved.is_err(),
            "and the caller is told it did not reach the disk"
        );
        assert_eq!(
            unsaved.validate(&credential, now).err(),
            Some(Rejected::Unknown)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn records_carry_the_label_and_the_times() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let credential = sessions
            .issue(granted(&auth), now, "Chrome on Android")
            .expect("issued");
        let later = now + Duration::from_secs(60 * 60);
        let _ = sessions.validate(&credential, later).expect("valid");

        let records = sessions.records(later);
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.label, "Chrome on Android");
        assert_eq!(record.created, now);
        assert_eq!(record.last_seen, later, "a validation is a sighting");
        assert_eq!(record.expires_at, now + CREDENTIAL_TTL);
    }

    #[test]
    fn last_seen_moves_to_the_minute_not_to_the_millisecond() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let credential = issue(&sessions, &auth, now);
        let _ = sessions
            .validate(&credential, now + Duration::from_secs(30))
            .expect("valid");
        assert_eq!(
            sessions.records(now)[0].last_seen,
            now,
            "under a minute: unchanged"
        );
        let _ = sessions
            .validate(&credential, now + Duration::from_secs(61))
            .expect("valid");
        assert_eq!(
            sessions.records(now)[0].last_seen,
            now + Duration::from_secs(61)
        );
    }

    /// The label comes from a `User-Agent` a client chose. Bounded and
    /// printable here, whatever the caller did with it first.
    #[test]
    fn a_label_is_bounded_and_printable() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), SystemTime::now());
        let hostile = format!("Safari\non\r\x1b[31mMac{}", "!".repeat(200));
        sessions
            .issue(granted(&auth), now, &hostile)
            .expect("issued");
        let label = sessions.records(now)[0].label.clone();
        assert!(label.chars().all(|c| !c.is_control()), "{label:?}");
        assert!(label.chars().count() <= LABEL_MAX, "{label:?}");
        assert!(label.starts_with("Safarion"), "{label:?}");

        sessions.issue(granted(&auth), now, "   ").expect("issued");
        assert_eq!(sessions.records(now)[1].label, "A browser");
    }

    #[test]
    fn a_file_from_a_later_version_is_refused_rather_than_read_wrongly() {
        let dir = scratch();
        let path = dir.join("sessions.json");
        std::fs::write(&path, br#"{"version":99,"nextId":1,"sessions":[]}"#).expect("written");
        let error = Sessions::persisted_at(&path, SystemTime::now())
            .err()
            .expect("a later version must be refused");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let _ = std::fs::remove_dir_all(dir);
    }
}
