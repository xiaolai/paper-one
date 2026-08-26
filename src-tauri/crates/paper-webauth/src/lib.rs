//! The browser client's device authorization — a one-time 6-digit code,
//! atomically rate-limited (phase 18, WI-18.1).
//!
//! The shelf shows six digits. A human types them into a browser. The browser
//! posts them over TLS; this decides whether that browser gets a credential.
//!
//! WHAT PROTECTS THE CODE, and what does not. Six digits is ~20 bits and would
//! fall to an offline dictionary attack in milliseconds. Nothing here pretends
//! otherwise. Three other things do the work:
//!
//!   - **TLS**, above this crate: the shelf serves the SPA under its own
//!     browser-trusted certificate, so an attacker can neither read the code in
//!     flight nor impersonate the shelf to collect it.
//!   - **Single use**: a code that has been spent is dead, whatever it was.
//!   - **Atomic reservation**: five guesses, ever, per code — taken *before*
//!     the code is looked at, so concurrency cannot multiply the budget.
//!
//! ⚠️ **THIS REASONING DOES NOT SURVIVE A CHANGE OF TRANSPORT.** Over an
//! untrusted broker with no server certificate the first bullet is gone and the
//! code becomes a 20-bit secret on a hostile wire. That is what phase 19's PAKE
//! is for. Anything moving this flow onto another transport must revisit
//! `dev-docs/plans/phase-18-the-browser-client.md` §2 first.
//!
//! ## Why the reservation is taken before the comparison
//!
//! The obvious implementation counts failures: compare, and on a mismatch
//! increment. Under concurrency that counts nothing. A hundred requests all
//! read `attempts < 5`, all compare, and all answer — the attacker gets a
//! hundred verdicts against a five-verdict budget, which is a 1-in-10 000 code,
//! not a 1-in-200 000 one.
//!
//! So [`DeviceAuth::reserve`] decrements first and returns a [`Reservation`],
//! and the code cannot be tested without one. A reservation is **burned**
//! whether or not it is used: an attacker who opens a hundred connections and
//! abandons them has spent the budget, not banked it.
//!
//! ## Why a restart kills the code
//!
//! Nothing here is persisted, and that is the stronger choice rather than the
//! lazy one. The alternative — persisting the counter — leaves a code alive
//! across a restart and invites the question of whether an attacker who can
//! crash the shelf gets a fresh five. Dropping the whole attempt on restart
//! answers it: they get zero, and a human reads a new code off the screen.
//!
//! The cost is a denial of service that a crashing shelf already is.
//!
//! ## Why issuance is bound to an attempt handle
//!
//! `pairing.rs` learned this one (its finding M9) and it applies unchanged:
//! a success that completes late must not be able to issue a credential for
//! whatever attempt happens to be current. Pause a winning submission, let the
//! code rotate, let an attacker start a new attempt, then resume — a caller
//! consulting "the current attempt" hands the attacker a credential.
//!
//! So [`Granted`] carries the [`AttemptId`] that earned it, and the caller must
//! bind what it issues to that value rather than to any live state.

pub mod sessions;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use subtle::ConstantTimeEq;

/// How many digits the human types.
pub const CODE_DIGITS: usize = 6;
/// How long a displayed code is good for.
pub const CODE_TTL: Duration = Duration::from_secs(90);
/// How many times a code may be tested. Reservations are burned, not returned,
/// so this is a budget over the code's whole life rather than a rate.
pub const MAX_ATTEMPTS: u8 = 5;

/// The digits, as ASCII. Never `Display`ed — the shelf renders it deliberately,
/// and a stray log line is the one leak TLS cannot cover.
#[derive(Clone)]
pub struct Code([u8; CODE_DIGITS]);

impl Code {
    /// The digits, for the shelf to draw. The ONLY way out of this type, so
    /// every escape is visible at a call site.
    pub fn digits(&self) -> &[u8; CODE_DIGITS] {
        &self.0
    }

    /// A uniformly random code from the thread CSPRNG.
    ///
    /// `rand::random` per digit rather than one `u32 % 1_000_000`: the modulo
    /// is biased (2³² is not a multiple of 10⁶) and, more to the point, a
    /// reader has to do arithmetic to see whether it is. Ten is a divisor of
    /// nothing here — each digit is drawn from `0..10` directly.
    fn fresh() -> Self {
        let mut digits = [0u8; CODE_DIGITS];
        for slot in digits.iter_mut() {
            *slot = b'0' + rand::random_range(0u8..10u8);
        }
        Self(digits)
    }

    /// Constant-time equality against caller-supplied bytes.
    ///
    /// Length is compared first and in the clear, which leaks only that — the
    /// number of digits is a published constant, not a secret.
    fn matches(&self, supplied: &[u8]) -> bool {
        if supplied.len() != CODE_DIGITS {
            return false;
        }
        self.0.ct_eq(supplied).into()
    }
}

/// The unguessable identity of one attempt to authorize a browser.
///
/// 128 bits, spelled exactly as `pairing.rs` spells its own — a caller must be
/// able to tell two attempts apart without being able to guess the other.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AttemptId(String);

impl AttemptId {
    fn fresh() -> Self {
        Self(format!("{:032x}", rand::random::<u128>()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What the shelf shows a human.
pub struct Offer {
    pub code: Code,
    pub attempt: AttemptId,
    /// For display only. The enforced deadline is monotonic and lives inside.
    pub expires_in: Duration,
}

/// Permission to test the code once. Burned on creation, never returned.
///
/// `#[must_use]`: dropping one without submitting is legal — that is what
/// "abandoned attempts burn their reservation" means — but doing it by accident
/// silently spends a fifth of the budget.
#[must_use = "a reservation is burned whether or not it is used"]
pub struct Reservation {
    attempt: AttemptId,
}

/// Why a reservation was refused, before any code was looked at.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// No code is on screen.
    NoOffer,
    /// The code aged out.
    Expired,
    /// The budget for this code is gone.
    NoAttemptsLeft,
}

/// What a submission decided.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Correct, first to arrive, and the code is now spent.
    Granted(Granted),
    /// Wrong digits.
    Wrong,
    /// Right digits, but another submission already spent this code, or the
    /// code rotated underneath this attempt.
    Stale,
}

/// A successful authorization, carrying the attempt that earned it.
///
/// The caller MUST bind whatever it issues to `attempt` rather than to any
/// notion of the current one — see the module header.
///
/// ## The field is `pub(crate)`, and that is the whole security property
///
/// `Sessions::issue` takes one of these BY VALUE rather than an `AttemptId`,
/// and its documentation says the type is the proof that six correct digits
/// arrived. That was false while the field was `pub`: `Offer::attempt` is
/// public, so any caller could call `begin`, copy the attempt out of the offer
/// it was handed, build `Granted { attempt }` and get a credential without
/// submitting anything at all. A capability token anyone can construct is not
/// a capability token; it is a struct.
///
/// `Reservation` beside it was already private, which is what made this
/// visible — two types with the same job and two different answers.
///
/// Nothing outside this crate reads the field; `paper-webhost` passes the
/// whole value through to `issue` opaquely, which is exactly the intended use.
#[derive(Debug, PartialEq, Eq)]
pub struct Granted {
    pub(crate) attempt: AttemptId,
}

/// The shelf's device-authorization state: at most one live code.
///
/// One mutex, taken synchronously and never held across an await — the property
/// `pairing.rs` names as what makes its own claim single-shot, and the reason
/// every method here is non-async.
#[derive(Default)]
pub struct DeviceAuth {
    inner: Mutex<Option<Pending>>,
}

struct Pending {
    code: Code,
    attempt: AttemptId,
    /// Monotonic, so a wall-clock change cannot stretch the window. The same
    /// reasoning as `pairing.rs`'s finding L10.
    expires_at: Instant,
    attempts_left: u8,
    spent: bool,
}

impl DeviceAuth {
    pub fn new() -> Self {
        Self::default()
    }

    /// Show a new code, replacing any live one.
    ///
    /// Replacing rather than refusing is deliberate: the human pressed the
    /// button, and a shelf that answered "there is already a code" would send
    /// them looking for a screen they may have closed. The displaced attempt
    /// dies here, which is exactly what [`Outcome::Stale`] reports to anyone
    /// still holding a reservation against it.
    pub fn begin(&self, now: Instant) -> Offer {
        let code = Code::fresh();
        let attempt = AttemptId::fresh();
        let mut guard = self.inner.lock().expect("device-auth mutex poisoned");
        *guard = Some(Pending {
            code: code.clone(),
            attempt: attempt.clone(),
            expires_at: now + CODE_TTL,
            attempts_left: MAX_ATTEMPTS,
            spent: false,
        });
        Offer {
            code,
            attempt,
            expires_in: CODE_TTL,
        }
    }

    /// Take one of the five attempts, before the code is looked at.
    pub fn reserve(&self, now: Instant) -> Result<Reservation, Refused> {
        let mut guard = self.inner.lock().expect("device-auth mutex poisoned");
        let pending = guard.as_mut().ok_or(Refused::NoOffer)?;
        if now >= pending.expires_at {
            *guard = None;
            return Err(Refused::Expired);
        }
        if pending.attempts_left == 0 {
            return Err(Refused::NoAttemptsLeft);
        }
        pending.attempts_left -= 1;
        Ok(Reservation {
            attempt: pending.attempt.clone(),
        })
    }

    /// Spend a reservation on one comparison.
    ///
    /// Takes the `Reservation` by value so a caller cannot test twice on one.
    pub fn submit(&self, reservation: Reservation, supplied: &[u8], now: Instant) -> Outcome {
        let mut guard = self.inner.lock().expect("device-auth mutex poisoned");
        let Some(pending) = guard.as_mut() else {
            return Outcome::Stale;
        };
        /* THE ATTEMPT MUST STILL BE THE ONE THIS RESERVATION WAS TAKEN AGAINST.
         * Without this a submission that wins slowly can land on whatever code
         * replaced its own — the M9 failure, in the shape it takes here. */
        if pending.attempt != reservation.attempt {
            return Outcome::Stale;
        }
        if now >= pending.expires_at {
            *guard = None;
            return Outcome::Stale;
        }
        if !pending.code.matches(supplied) {
            return Outcome::Wrong;
        }
        if pending.spent {
            return Outcome::Stale;
        }
        pending.spent = true;
        Outcome::Granted(Granted {
            attempt: pending.attempt.clone(),
        })
    }

    /// Drop any live code. Used when the shelf's pairing screen closes, and on
    /// the way out of a session that no longer needs one.
    pub fn cancel(&self) {
        *self.inner.lock().expect("device-auth mutex poisoned") = None;
    }

    /// How many attempts remain, for tests and for the shelf's own display.
    pub fn attempts_left(&self) -> Option<u8> {
        self.inner
            .lock()
            .expect("device-auth mutex poisoned")
            .as_ref()
            .map(|p| p.attempts_left)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn code_of(offer: &Offer) -> Vec<u8> {
        offer.code.digits().to_vec()
    }

    /// The refusal, or `None` when a reservation was granted.
    ///
    /// Exists so no assertion has to compare a `Reservation`. Deriving `Debug`
    /// and `PartialEq` on a capability token to satisfy `assert_eq!` would make
    /// a live permission printable and comparable, which is precisely what that
    /// type exists to prevent.
    fn refusal(result: Result<Reservation, Refused>) -> Option<Refused> {
        result.err()
    }

    #[test]
    fn a_fresh_code_is_six_ascii_digits() {
        let auth = DeviceAuth::new();
        let offer = auth.begin(Instant::now());
        assert_eq!(offer.code.digits().len(), CODE_DIGITS);
        assert!(offer.code.digits().iter().all(|b| b.is_ascii_digit()));
    }

    #[test]
    fn codes_differ_across_offers() {
        /* Not a randomness test — a wiring test. A constant seed or a counter
         * would pass everything else in this file and fail here. 40 draws of a
         * 10^6 space collide with probability ~7.8e-4; a fixed generator
         * collides with probability 1. */
        let auth = DeviceAuth::new();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..40 {
            seen.insert(code_of(&auth.begin(Instant::now())));
        }
        assert!(
            seen.len() > 35,
            "only {} distinct codes in 40 draws",
            seen.len()
        );
    }

    #[test]
    fn every_digit_position_varies() {
        /* Catches the generator that randomises one digit and pads the rest,
         * which the previous test would not. */
        let auth = DeviceAuth::new();
        let draws: Vec<Vec<u8>> = (0..60)
            .map(|_| code_of(&auth.begin(Instant::now())))
            .collect();
        for position in 0..CODE_DIGITS {
            let distinct: std::collections::HashSet<u8> =
                draws.iter().map(|d| d[position]).collect();
            assert!(
                distinct.len() > 4,
                "digit {position} took only {} values",
                distinct.len()
            );
        }
    }

    #[test]
    fn the_right_code_is_granted_once_and_then_stale() {
        let auth = DeviceAuth::new();
        let now = Instant::now();
        let offer = auth.begin(now);
        let digits = code_of(&offer);

        let first = auth.submit(auth.reserve(now).unwrap(), &digits, now);
        assert_eq!(
            first,
            Outcome::Granted(Granted {
                attempt: offer.attempt.clone()
            })
        );

        let second = auth.submit(auth.reserve(now).unwrap(), &digits, now);
        assert_eq!(second, Outcome::Stale, "a spent code must not grant twice");
    }

    /// Six digits that are NOT the ones on screen.
    ///
    /// A literal cannot promise that, and four tests here submitted `000000`.
    /// One in a million runs it IS the live code, and on that run the
    /// submission is GRANTED — so `a_wrong_code_is_wrong` asserts the opposite
    /// of its name, and the budget tests never spend a budget. Rotating one
    /// digit is guaranteed wrong and costs nothing.
    fn wrong_digits(offer: &Offer) -> Vec<u8> {
        let mut digits = code_of(offer);
        digits[0] = b'0' + ((digits[0] - b'0') + 1) % 10;
        digits
    }

    #[test]
    fn a_wrong_code_is_wrong_and_costs_an_attempt() {
        let auth = DeviceAuth::new();
        let now = Instant::now();
        let offer = auth.begin(now);
        assert_eq!(auth.attempts_left(), Some(MAX_ATTEMPTS));
        assert_eq!(
            auth.submit(auth.reserve(now).unwrap(), &wrong_digits(&offer), now),
            Outcome::Wrong
        );
        assert_eq!(auth.attempts_left(), Some(MAX_ATTEMPTS - 1));
    }

    #[test]
    fn a_short_or_long_submission_is_wrong_not_a_panic() {
        let auth = DeviceAuth::new();
        let now = Instant::now();
        auth.begin(now);
        assert_eq!(
            auth.submit(auth.reserve(now).unwrap(), b"", now),
            Outcome::Wrong
        );
        assert_eq!(
            auth.submit(auth.reserve(now).unwrap(), b"12345", now),
            Outcome::Wrong
        );
        assert_eq!(
            auth.submit(auth.reserve(now).unwrap(), b"1234567", now),
            Outcome::Wrong
        );
    }

    #[test]
    fn the_budget_is_five_and_the_sixth_is_refused_without_testing() {
        let auth = DeviceAuth::new();
        let now = Instant::now();
        let offer = auth.begin(now);
        let digits = code_of(&offer);
        /* WRONG BY CONSTRUCTION. A literal `000000` is the live code once in a
        million runs, and on that run the first submission is GRANTED — so
        the budget is never spent and this test passes having proven the
        opposite of its name. */
        let miss = wrong_digits(&offer);
        for _ in 0..MAX_ATTEMPTS {
            let _ = auth.submit(auth.reserve(now).unwrap(), &miss, now);
        }
        /* The RIGHT code, refused — because the refusal happens before any
         * comparison. This is the assertion that distinguishes a real budget
         * from a counter incremented after the fact. */
        assert_eq!(refusal(auth.reserve(now)), Some(Refused::NoAttemptsLeft));
        assert!(auth.attempts_left() == Some(0));
        let _ = digits;
    }

    #[test]
    fn an_abandoned_reservation_is_burned() {
        let auth = DeviceAuth::new();
        let now = Instant::now();
        auth.begin(now);
        for _ in 0..MAX_ATTEMPTS {
            drop(auth.reserve(now).unwrap());
        }
        assert_eq!(refusal(auth.reserve(now)), Some(Refused::NoAttemptsLeft));
    }

    #[test]
    fn an_expired_code_refuses_before_testing_and_is_dropped() {
        let auth = DeviceAuth::new();
        let now = Instant::now();
        auth.begin(now);
        let later = now + CODE_TTL + Duration::from_millis(1);
        assert_eq!(refusal(auth.reserve(later)), Some(Refused::Expired));
        assert_eq!(
            refusal(auth.reserve(later)),
            Some(Refused::NoOffer),
            "the expired code is gone"
        );
    }

    #[test]
    fn a_reservation_cannot_outlive_its_code() {
        /* Finding 9, in the shape it takes here. The winner is paused, the code
         * rotates, and the pause is released. It must not grant against the
         * code that replaced its own. */
        let auth = DeviceAuth::new();
        let now = Instant::now();
        let first = auth.begin(now);
        let digits = code_of(&first);
        let reservation = auth.reserve(now).unwrap();

        let second = auth.begin(now);
        assert_ne!(first.attempt, second.attempt);

        assert_eq!(auth.submit(reservation, &digits, now), Outcome::Stale);
    }

    #[test]
    fn a_rotation_does_not_grant_the_new_code_to_the_old_attempt() {
        /* The same race with the attacker's digits: holding a reservation from
         * attempt A, submitting attempt B's code must still be Stale rather
         * than Granted. */
        let auth = DeviceAuth::new();
        let now = Instant::now();
        auth.begin(now);
        let reservation = auth.reserve(now).unwrap();
        let second = auth.begin(now);
        assert_eq!(
            auth.submit(reservation, &code_of(&second), now),
            Outcome::Stale
        );
    }

    #[test]
    fn cancel_kills_the_code() {
        let auth = DeviceAuth::new();
        let now = Instant::now();
        let offer = auth.begin(now);
        auth.cancel();
        assert_eq!(refusal(auth.reserve(now)), Some(Refused::NoOffer));
        let _ = offer;
    }

    #[test]
    fn a_hundred_concurrent_guesses_get_exactly_five_comparisons() {
        /* Adversarial suite 1. The reason `reserve` exists: a hundred threads
         * racing one code must consume one budget, not a hundred. */
        let auth = Arc::new(DeviceAuth::new());
        let now = Instant::now();
        let offer = auth.begin(now);
        /* WRONG BY CONSTRUCTION — see `wrong_digits`. With a literal, one run in
        a million has a thread GRANT the code, which spends the offer and
        changes what the surviving threads are racing for. */
        let miss = Arc::new(wrong_digits(&offer));
        let tested = Arc::new(AtomicUsize::new(0));

        std::thread::scope(|scope| {
            for _ in 0..100 {
                let auth = Arc::clone(&auth);
                let tested = Arc::clone(&tested);
                let miss = Arc::clone(&miss);
                scope.spawn(move || {
                    if let Ok(reservation) = auth.reserve(now) {
                        tested.fetch_add(1, Ordering::SeqCst);
                        let _ = auth.submit(reservation, &miss, now);
                    }
                });
            }
        });

        assert_eq!(tested.load(Ordering::SeqCst), MAX_ATTEMPTS as usize);
    }

    #[test]
    fn a_hundred_concurrent_correct_submissions_grant_exactly_once() {
        /* Adversarial suite 2. Only five can reserve, all five hold the right
         * digits, and single-use must still let exactly one through. */
        let auth = Arc::new(DeviceAuth::new());
        let now = Instant::now();
        let offer = auth.begin(now);
        let digits = Arc::new(code_of(&offer));
        let granted = Arc::new(AtomicUsize::new(0));

        std::thread::scope(|scope| {
            for _ in 0..100 {
                let auth = Arc::clone(&auth);
                let digits = Arc::clone(&digits);
                let granted = Arc::clone(&granted);
                scope.spawn(move || {
                    if let Ok(reservation) = auth.reserve(now) {
                        if matches!(auth.submit(reservation, &digits, now), Outcome::Granted(_)) {
                            granted.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                });
            }
        });

        assert_eq!(granted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_restart_is_modelled_as_a_dropped_code() {
        /* Adversarial suite 4, in the form this design takes: nothing is
         * persisted, so a restart cannot hand an attacker a fresh budget
         * because it does not hand them a live code either. */
        let auth = DeviceAuth::new();
        let now = Instant::now();
        let offer = auth.begin(now);
        let digits = code_of(&offer);
        let miss = wrong_digits(&offer);
        for _ in 0..MAX_ATTEMPTS {
            let _ = auth.submit(auth.reserve(now).unwrap(), &miss, now);
        }
        drop(auth);

        let restarted = DeviceAuth::new();
        assert_eq!(refusal(restarted.reserve(now)), Some(Refused::NoOffer));
        /* And the old digits are worth nothing against the restarted shelf. */
        let fresh = restarted.begin(now);
        let outcome = restarted.submit(restarted.reserve(now).unwrap(), &digits, now);
        if code_of(&fresh) != digits {
            assert_eq!(outcome, Outcome::Wrong);
        }
    }

    /// THE TWO CAPABILITY TOKENS KEEP THEIR FIELDS TO THEMSELVES.
    ///
    /// `Reservation` is permission to test the code once; `Granted` is proof
    /// that six correct digits arrived. Both are handed to a caller that must
    /// not be able to make another — `Sessions::issue` takes a `Granted` BY
    /// VALUE precisely so the type carries the authorization.
    ///
    /// `Granted::attempt` was `pub`, which made that false. `Offer::attempt` is
    /// public, so any caller could call `begin`, copy the attempt out of the
    /// offer, build `Granted { attempt }` and be issued a credential without
    /// submitting anything. `Reservation` beside it was already private, and
    /// two types with the same job and two different answers is what a guard is
    /// for.
    ///
    /// Rust cannot assert a field's visibility from inside the crate — every
    /// field is reachable here, which is the whole difficulty — so this reads
    /// the source, as `sessions.rs`'s printability guard does.
    #[test]
    fn the_capability_tokens_cannot_be_built_by_a_caller() {
        let source = include_str!("lib.rs");
        for name in ["Granted", "Reservation"] {
            let header = format!("pub struct {name} {{");
            let at = source.find(&header).unwrap_or_else(|| {
                panic!("{name} is gone, or is no longer a braced struct — this guard cannot see it")
            });
            /* AFTER THE OPENING BRACE. Slicing from the declaration includes
             * `pub struct` itself, so the check matched its own header and
             * failed on a struct with no public field at all. */
            let opens = at + header.len();
            let body_end = source[opens..]
                .find('}')
                .unwrap_or_else(|| panic!("{name}'s declaration does not close"));
            let body = &source[opens..opens + body_end];
            assert!(
                !body.trim().is_empty(),
                "{name} has no fields — is this guard still pointed at the right thing?"
            );
            assert!(
                !body.contains("pub "),
                "{name} has a public field. It is a capability token: `Sessions::issue` takes a \
                 `Granted` by value because the TYPE is the proof, and a caller that can build one \
                 from an `AttemptId` it already holds needs no code at all. Use `pub(crate)`."
            );
        }
    }
}
