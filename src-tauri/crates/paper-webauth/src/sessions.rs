//! The credential a browser holds after it types the right six digits, and the
//! revocation that takes it away (phase 18, WI-18.2 and WI-18.3).
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
//! ## What this module does NOT do
//!
//! It does not know what a cookie is. The `HttpOnly; Secure; SameSite=Strict`
//! attributes that keep a hostile EPUB from reading the credential
//! (`rendererIsolation.test.ts` — book JavaScript runs in the app's own origin)
//! are the server's business, in WI-18.4. This module only ever sees the
//! value.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::AttemptId;

/// How long a credential is good for, however active it is.
///
/// "Long-lived" in the plan means "the human does not retype six digits every
/// day", not "forever". An absolute ceiling means a browser forgotten on a
/// borrowed laptop stops working on its own.
pub const CREDENTIAL_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 90);

/// The opaque value a browser presents. 256 bits from the CSPRNG.
///
/// Deliberately not `Debug`: this is the one string in the system whose
/// appearance in a log is a compromise, and a derived `Debug` is how it would
/// get there.
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
}

/// A live browser session.
///
/// DURABLE, unlike a socket id: it identifies the CREDENTIAL, so it survives a
/// browser closing its tab and reconnecting. That is what makes it the right
/// thing to show a reader who is deciding what to revoke.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
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
    credential: Credential,
    generation: u64,
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

struct Session {
    id: SessionId,
    /// The attempt that earned this credential. Carried so a caller can answer
    /// "where did this come from" without a second table, and so the binding
    /// finding 9 asks for survives past issuance.
    attempt: AttemptId,
    issued_at: Instant,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    generation: u64,
    live: HashMap<Credential, Session>,
}

/// Every credential this shelf has issued and not revoked.
///
/// One mutex, taken synchronously, never held across an await — the same rule
/// [`crate::DeviceAuth`] follows and for the same reason.
#[derive(Default)]
pub struct Sessions {
    inner: Mutex<Inner>,
}

impl Sessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issue a credential for an authorization that was earned.
    ///
    /// Takes [`crate::Granted`] by value rather than an `AttemptId` a caller
    /// could have got anywhere: the type is the proof that six correct digits
    /// arrived, and it can only be built by [`crate::DeviceAuth::submit`].
    pub fn issue(&self, granted: crate::Granted, now: Instant) -> Credential {
        let credential = Credential::fresh();
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        guard.next_id += 1;
        let id = SessionId(guard.next_id);
        guard.live.insert(
            credential.clone(),
            Session {
                id,
                attempt: granted.attempt,
                issued_at: now,
            },
        );
        credential
    }

    /// Ask whether a presented credential is currently good. Grants nothing.
    pub fn validate(&self, presented: &Credential, now: Instant) -> Result<Admission, Rejected> {
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        let generation = guard.generation;
        let Some(session) = guard.live.get(presented) else {
            return Err(Rejected::Unknown);
        };
        if now.duration_since(session.issued_at) >= CREDENTIAL_TTL {
            guard.live.remove(presented);
            return Err(Rejected::Expired);
        }
        Ok(Admission {
            credential: presented.clone(),
            generation,
        })
    }

    /// Register a connection against an admission, re-checking the present.
    pub fn admit(&self, admission: Admission) -> Result<SessionId, Rejected> {
        let guard = self.inner.lock().expect("sessions mutex poisoned");
        /* THE RE-CHECK, which is the whole point of the two-phase shape. */
        let Some(session) = guard.live.get(&admission.credential) else {
            return Err(Rejected::RevokedMeanwhile);
        };
        if guard.generation != admission.generation {
            return Err(Rejected::RevokedMeanwhile);
        }
        Ok(session.id)
    }

    /// Revoke one credential. Returns the session it closed, if any, so the
    /// caller can tear down the live channel that belongs to it.
    ///
    /// ⚠️ **This does not close anything by itself.** Plan §7 lists four things
    /// revocation touches; this module owns one of them. The caller must close
    /// the live channel, abort in-flight streams, and drop the router's grant
    /// cache entry. A revocation that only forgets the credential leaves an
    /// open socket answering requests.
    pub fn revoke(&self, credential: &Credential) -> Option<SessionId> {
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        let removed = guard.live.remove(credential).map(|s| s.id);
        if removed.is_some() {
            guard.generation += 1;
        }
        removed
    }

    /// Revoke everything. The "this laptop was stolen" button.
    pub fn revoke_all(&self) -> Vec<SessionId> {
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        let ids = guard.live.values().map(|s| s.id).collect();
        guard.live.clear();
        guard.generation += 1;
        ids
    }

    /// The attempt a live credential came from.
    pub fn attempt_of(&self, credential: &Credential) -> Option<AttemptId> {
        self.inner
            .lock()
            .expect("sessions mutex poisoned")
            .live
            .get(credential)
            .map(|s| s.attempt.clone())
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
        ids.sort_by_key(|id| id.0);
        ids
    }

    /// Revoke by durable session id, returning the credential it removed so the
    /// caller can close whatever channel that credential is holding.
    ///
    /// The credential escapes here for the same reason [`Credential::as_str`]
    /// exists: the caller has a second half of the revocation to perform and
    /// cannot do it without one. It does not implement `Debug`, so it cannot
    /// ride into a log on the way.
    pub fn revoke_by_id(&self, id: SessionId) -> Option<Credential> {
        let mut guard = self.inner.lock().expect("sessions mutex poisoned");
        let found = guard
            .live
            .iter()
            .find(|(_, session)| session.id == id)
            .map(|(credential, _)| credential.clone())?;
        guard.live.remove(&found);
        guard.generation += 1;
        Some(found)
    }

    pub fn live_count(&self) -> usize {
        self.inner
            .lock()
            .expect("sessions mutex poisoned")
            .live
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DeviceAuth, Outcome};

    /// A real grant, because `Granted` cannot be built any other way — which is
    /// the property being relied on.
    fn granted(auth: &DeviceAuth, now: Instant) -> crate::Granted {
        let offer = auth.begin(now);
        let digits = offer.code.digits().to_vec();
        match auth.submit(auth.reserve(now).unwrap(), &digits, now) {
            Outcome::Granted(g) => g,
            other => panic!("expected a grant, got {other:?}"),
        }
    }

    #[test]
    fn an_issued_credential_validates_and_admits() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let credential = sessions.issue(granted(&auth, now), now);
        let admission = sessions.validate(&credential, now).expect("valid");
        assert!(sessions.admit(admission).is_ok());
    }

    #[test]
    fn an_unknown_credential_is_unknown() {
        let sessions = Sessions::new();
        let stranger = Credential::from_presented("not-a-credential");
        assert_eq!(
            sessions.validate(&stranger, Instant::now()).err(),
            Some(Rejected::Unknown)
        );
    }

    #[test]
    fn two_credentials_are_distinct() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let first = sessions.issue(granted(&auth, now), now);
        let second = sessions.issue(granted(&auth, now), now);
        assert_ne!(first.as_str(), second.as_str());
        assert_eq!(first.as_str().len(), 64, "256 bits, hex");
    }

    #[test]
    fn a_revoked_credential_stops_validating() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let credential = sessions.issue(granted(&auth, now), now);
        assert!(sessions.revoke(&credential).is_some());
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
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let credential = sessions.issue(granted(&auth, now), now);

        let admission = sessions
            .validate(&credential, now)
            .expect("valid at this moment");
        assert!(sessions.revoke(&credential).is_some());

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
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let mine = sessions.issue(granted(&auth, now), now);
        let admission = sessions.validate(&mine, now).expect("valid");
        sessions.revoke_all();
        assert_eq!(
            sessions.admit(admission).err(),
            Some(Rejected::RevokedMeanwhile)
        );
    }

    #[test]
    fn revoking_one_credential_leaves_the_others_working() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let doomed = sessions.issue(granted(&auth, now), now);
        let spared = sessions.issue(granted(&auth, now), now);
        sessions.revoke(&doomed);

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
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let credential = sessions.issue(granted(&auth, now), now);
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
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let grant = granted(&auth, now);
        let attempt = grant.attempt.clone();
        let credential = sessions.issue(grant, now);

        auth.begin(now); // the code rotates underneath
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
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let away = sessions.issue(granted(&auth, now), now);
        let other = sessions.issue(granted(&auth, now), now);

        /* Nothing here has ever had a socket — that is the whole point. */
        let listed = sessions.live_sessions();
        assert_eq!(listed.len(), 2, "both credentials are listed");

        let id = sessions
            .validate(&away, now)
            .and_then(|admission| sessions.admit(admission))
            .expect("live");
        let removed = sessions.revoke_by_id(id).expect("revoke by durable id");
        assert_eq!(removed.as_str(), away.as_str(), "the right credential");

        assert_eq!(sessions.validate(&away, now).err(), Some(Rejected::Unknown));
        assert_eq!(sessions.live_sessions().len(), 1, "and only that one");
        assert!(
            sessions.validate(&other, now).is_ok(),
            "revoking one browser must not log the others out"
        );
    }

    #[test]
    fn revoking_an_id_that_is_not_live_changes_nothing() {
        let (auth, sessions, now) = (DeviceAuth::new(), Sessions::new(), Instant::now());
        let held = sessions.issue(granted(&auth, now), now);
        assert!(sessions.revoke_by_id(SessionId::from_u64(9999)).is_none());
        assert!(sessions.validate(&held, now).is_ok());
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
        let source = include_str!("sessions.rs");
        let at = source.find("pub struct Credential(").expect(
            "Credential is gone, or is no longer a tuple struct — this guard cannot see it",
        );
        // The derive list immediately above the declaration.
        let before = &source[..at];
        let derive_at = before
            .rfind("#[derive(")
            .expect("Credential has no derive list at all — check this guard still points at it");
        let derives = &before[derive_at..];
        assert!(
            !derives.contains("Debug"),
            "Credential derives Debug. It is the one value whose appearance in a \
             log is a compromise, and Debug is how it gets into one — inside \
             another struct's derived output, or an unwrap, or an assert. \
             Use `as_str()` at a call site instead, where the escape is visible."
        );
    }
}
