//! In-flight requests, and the one command that cancels any of them.
//!
//! Every streaming call in this crate — a generation, a gloss, a download, an
//! agent turn — is registered here under an id the CALLER minted, and
//! `inference_cancel(requestId)` is its own command (WI-15.0). One registry
//! rather than one per kind, because "abandon this" is one gesture from the
//! reader's side and the plan gives cancellation one command.
//!
//! # The caller mints the id, and that is a deliberate choice
//!
//! The alternative — the command returns an id the caller then cancels with —
//! has a race the reader can actually hit: `ask()` is called, the reader
//! presses Escape, and the cancel arrives before the id does. There is
//! nothing to cancel yet, so the answer streams on into a thread nobody is
//! watching. With the caller minting it, the id exists before the request
//! does and a cancel that arrives first is still meaningful.
//!
//! That makes ids untrusted input, so [`Registry::begin`] refuses one already
//! in flight rather than replacing it. Replacing would leave the first
//! caller's stream silently dead, which is the failure mode a duplicate id is
//! most likely to be.
//!
//! # Cancellation is cooperative, and the token is the whole mechanism
//!
//! Nothing is killed. A cancelled request's token is tripped, the loop
//! producing it notices at its next await point, and it stops — closing the
//! HTTP response, dropping the channel, and in an agent's case terminating
//! the child's process group. That is why every long operation in this crate
//! takes a [`Cancel`] and checks it, rather than being wrapped in something
//! that aborts it from outside: an aborted future leaves the daemon still
//! generating, which is a subscription turn or a GPU still spending.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::error::{Error, Result};

/// A handle a long operation checks to see whether the reader gave up.
#[derive(Debug, Clone)]
pub struct Cancel {
    rx: watch::Receiver<bool>,
    /// The sender, so a holder can trip its OWN token — see [`Cancel::trip`].
    tx: Option<std::sync::Arc<watch::Sender<bool>>>,
}

impl Cancel {
    /// Whether the reader has cancelled. Cheap; call it freely inside a loop.
    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// Cancel from the INSIDE.
    ///
    /// For the case where the work itself discovers there is nobody left to
    /// receive it — a `Channel::send` that fails because the webview dropped
    /// its end. Without this, a reader closing the pane left the daemon
    /// generating into a channel nothing was reading, which on a loaded
    /// machine is a GPU spent on an answer nobody will see.
    pub fn trip(&self) {
        if let Some(tx) = &self.tx {
            tx.send_replace(true);
        }
    }

    /// [`Error::Cancelled`] if the reader gave up, else `Ok(())`.
    ///
    /// The shape most call sites want: `cancel.check()?` at the top of each
    /// loop turn reads as a guard rather than as a branch.
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Resolve when cancelled. For `select!` against a read that would
    /// otherwise block — a streaming body that has gone quiet must not keep
    /// the reader waiting after they have pressed Escape.
    pub async fn cancelled(&self) {
        let mut rx = self.rx.clone();
        // Already tripped: return at once rather than waiting for a change
        // that has already happened.
        if *rx.borrow() {
            return;
        }
        while rx.changed().await.is_ok() {
            if *rx.borrow() {
                return;
            }
        }
        // The sender is gone, which means the registry dropped the entry.
        // Treat that as cancelled: there is nobody left to receive the
        // stream.
    }

    /// A token nobody will ever cancel, for a call with no reader behind it.
    ///
    /// The sender lives in a `OnceLock` rather than being leaked per call:
    /// `cancelled()` treats a dropped sender as cancellation, so this one has
    /// to outlive every receiver it hands out — and one static sender does
    /// that without leaking a channel on each invocation.
    pub fn never() -> Cancel {
        static NEVER: std::sync::OnceLock<watch::Sender<bool>> = std::sync::OnceLock::new();
        let tx = NEVER.get_or_init(|| watch::channel(false).0);
        Cancel {
            rx: tx.subscribe(),
            /* No sender: a token nobody can cancel includes its own holder. */
            tx: None,
        }
    }
}

/// A registered request. Dropping it retires the id.
///
/// A guard rather than an explicit `finish` call, because the paths that
/// leave a streaming command are many — a return, a `?`, a cancel, a panic —
/// and an id that outlives its request makes the next call with the same id
/// fail as [`Error::RequestBusy`] forever.
pub struct Guard {
    registry: Registry,
    id: String,
}

impl Guard {
    /// The token for this request.
    pub fn cancel(&self) -> Cancel {
        self.registry
            .token(&self.id)
            // The entry cannot be gone while this guard is alive — the guard
            // is what removes it — but a token that reports "cancelled" is a
            // safer answer than a panic if that ever stops being true.
            .unwrap_or_else(|| {
                let (_, rx) = watch::channel(true);
                Cancel { rx, tx: None }
            })
    }
}

impl std::fmt::Debug for Guard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Guard").field("id", &self.id).finish()
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.registry.retire(&self.id);
    }
}

/// Every request currently in flight.
#[derive(Clone, Default)]
pub struct Registry {
    inner: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
}

impl Registry {
    /// Register `id`, or refuse it if it is already in flight.
    pub fn begin(&self, id: &str) -> Result<Guard> {
        let mut map = self.inner.lock().expect("request registry poisoned");
        if map.contains_key(id) {
            return Err(Error::RequestBusy(id.to_owned()));
        }
        let (tx, _) = watch::channel(false);
        map.insert(id.to_owned(), tx);
        Ok(Guard {
            registry: self.clone(),
            id: id.to_owned(),
        })
    }

    /// Trip `id`'s token. [`Error::RequestUnknown`] if nothing is in flight
    /// under it — a cancel for something already finished is worth saying so
    /// rather than silently succeeding, because the UI uses it to tell "I
    /// stopped it" from "it had already stopped".
    pub fn cancel(&self, id: &str) -> Result<()> {
        let map = self.inner.lock().expect("request registry poisoned");
        match map.get(id) {
            /* `send_replace`, NOT `send`. `send` fails when no receiver is
             * alive AT THAT MOMENT and leaves the value unchanged — so a
             * cancel arriving in the window between a request registering and
             * its worker taking a token silently did nothing, and every later
             * `subscribe()` saw `false`. That window is the common case for a
             * reader pressing Escape early, which is the exact race the
             * caller-minted id exists to close. `send_replace` always stores
             * the value. Four tests caught this; it is not theoretical. */
            Some(tx) => {
                tx.send_replace(true);
                Ok(())
            }
            None => Err(Error::RequestUnknown(id.to_owned())),
        }
    }

    /// Trip every token. The app is exiting, or the daemon is going down and
    /// nothing streaming from it can still be answered.
    pub fn cancel_all(&self) {
        let map = self.inner.lock().expect("request registry poisoned");
        for tx in map.values() {
            tx.send_replace(true);
        }
    }

    fn token(&self, id: &str) -> Option<Cancel> {
        let map = self.inner.lock().expect("request registry poisoned");
        map.get(id).map(|tx| Cancel {
            rx: tx.subscribe(),
            tx: Some(std::sync::Arc::new(tx.clone())),
        })
    }

    fn retire(&self, id: &str) {
        let mut map = self.inner.lock().expect("request registry poisoned");
        map.remove(id);
    }

    /// How many requests are in flight. For a test and a diagnostic.
    pub fn in_flight(&self) -> usize {
        self.inner.lock().expect("request registry poisoned").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_registered_and_retired_by_its_guard() {
        let registry = Registry::default();
        assert_eq!(registry.in_flight(), 0);
        {
            let _guard = registry.begin("r1").unwrap();
            assert_eq!(registry.in_flight(), 1);
        }
        assert_eq!(registry.in_flight(), 0, "the guard retires the id on drop");
    }

    #[test]
    fn a_duplicate_id_is_refused_rather_than_replacing_the_first() {
        let registry = Registry::default();
        let first = registry.begin("r1").unwrap();
        let err = registry.begin("r1").unwrap_err();
        assert_eq!(err.kind(), "requestBusy");
        // And the first is still live and still cancellable.
        assert!(!first.cancel().is_cancelled());
        registry.cancel("r1").unwrap();
        assert!(first.cancel().is_cancelled());
    }

    #[test]
    fn cancelling_trips_the_token() {
        let registry = Registry::default();
        let guard = registry.begin("r1").unwrap();
        let cancel = guard.cancel();
        assert!(!cancel.is_cancelled());
        assert!(cancel.check().is_ok());

        registry.cancel("r1").unwrap();
        assert!(cancel.is_cancelled());
        assert_eq!(cancel.check().unwrap_err().kind(), "cancelled");
    }

    #[test]
    fn cancelling_something_that_finished_says_so() {
        let registry = Registry::default();
        {
            let _guard = registry.begin("r1").unwrap();
        }
        let err = registry.cancel("r1").unwrap_err();
        assert_eq!(err.kind(), "requestUnknown");
    }

    #[test]
    fn cancel_all_reaches_every_request() {
        let registry = Registry::default();
        let a = registry.begin("a").unwrap();
        let b = registry.begin("b").unwrap();
        let (ca, cb) = (a.cancel(), b.cancel());
        registry.cancel_all();
        assert!(ca.is_cancelled());
        assert!(cb.is_cancelled());
    }

    /// The race the caller-minted id exists to close: a cancel that arrives
    /// before the work starts is still meaningful, because the id was
    /// registered first.
    #[tokio::test]
    async fn a_cancel_that_arrives_first_is_still_honoured() {
        let registry = Registry::default();
        let guard = registry.begin("r1").unwrap();
        // The reader pressed Escape before the daemon answered.
        registry.cancel("r1").unwrap();
        // The work starts and immediately notices.
        assert!(guard.cancel().check().is_err());
    }

    #[tokio::test]
    async fn cancelled_resolves_when_tripped() {
        let registry = Registry::default();
        let guard = registry.begin("r1").unwrap();
        let cancel = guard.cancel();
        let waiter = tokio::spawn(async move { cancel.cancelled().await });
        // Give the waiter a moment to park, then trip it.
        tokio::task::yield_now().await;
        registry.cancel("r1").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("cancelled() must resolve")
            .unwrap();
    }

    #[tokio::test]
    async fn cancelled_resolves_immediately_when_already_tripped() {
        let registry = Registry::default();
        let guard = registry.begin("r1").unwrap();
        registry.cancel("r1").unwrap();
        let cancel = guard.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(2), cancel.cancelled())
            .await
            .expect("an already-tripped token must not wait for a change");
    }

    /// The send-failure path: the work discovers nobody is receiving it and
    /// stops itself, rather than generating into a dropped channel.
    #[test]
    fn a_holder_can_trip_its_own_token() {
        let registry = Registry::default();
        let guard = registry.begin("r1").unwrap();
        let cancel = guard.cancel();
        assert!(!cancel.is_cancelled());
        cancel.trip();
        assert!(cancel.is_cancelled());
        /* And every other holder of the same request sees it. */
        assert!(guard.cancel().is_cancelled());
    }

    #[test]
    fn a_never_token_cannot_be_tripped_even_by_its_holder() {
        let cancel = Cancel::never();
        cancel.trip();
        assert!(!cancel.is_cancelled());
    }

    #[tokio::test]
    async fn a_never_token_is_never_cancelled() {
        let cancel = Cancel::never();
        assert!(!cancel.is_cancelled());
        assert!(cancel.check().is_ok());
        // And it does not resolve — a token whose sender was dropped would.
        let waited =
            tokio::time::timeout(std::time::Duration::from_millis(50), cancel.cancelled()).await;
        assert!(waited.is_err(), "Cancel::never() must never resolve");
    }

    /// Two requests are independent: cancelling one leaves the other running.
    #[test]
    fn cancellation_is_per_request() {
        let registry = Registry::default();
        let a = registry.begin("a").unwrap();
        let b = registry.begin("b").unwrap();
        registry.cancel("a").unwrap();
        assert!(a.cancel().is_cancelled());
        assert!(!b.cancel().is_cancelled(), "b was not the one abandoned");
    }
    /// A model lock and a request id cannot collide, and a second holder waits.
    ///
    /// `commands::lock_model` serialises artifact writes on `model:<id>` in
    /// this same registry. That is only safe if a minted request id can never
    /// be spelled the same way — they are `<kind>-<n>` — and if the second
    /// holder is refused rather than admitted.
    #[test]
    fn a_model_lock_is_exclusive_and_cannot_collide_with_a_request() {
        let registry = Registry::default();
        let held = registry.begin("model:qwen").expect("the first holder");
        assert!(
            registry.begin("model:qwen").is_err(),
            "two writers were admitted to one model's artifacts"
        );
        // A different model is a different lock.
        let other = registry.begin("model:kokoro").expect("a different model");
        // And a minted request id is untouched by either.
        let request = registry.begin("install-1").expect("a request id");

        drop(held);
        registry
            .begin("model:qwen")
            .expect("the lock was not released when its guard was dropped");
        drop(other);
        drop(request);
    }
}
