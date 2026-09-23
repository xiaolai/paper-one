//! The reader's Stop, as something a download can wait on.
//!
//! Recovered from the deleted `tauri-plugin-inference`, narrowed to what a
//! download needs. A `watch` channel rather than a flag, because the fetch loop
//! must be able to WAIT on it inside `select!` — polling a boolean between
//! chunks would leave a stopped download running until the next chunk arrives,
//! which on a stalled connection is the whole timeout.

use tokio::sync::watch;

use crate::error::{Error, Result};

/// A token a caller holds and the work watches.
#[derive(Debug, Clone)]
pub struct Cancel {
    rx: watch::Receiver<bool>,
}

/// The other end: dropping it does NOT cancel, because a download that outlives
/// the handle to it is still a download the reader asked for.
#[derive(Debug)]
pub struct Stopper {
    tx: watch::Sender<bool>,
}

impl Cancel {
    /// A fresh token and the handle that stops it.
    #[must_use]
    pub fn new() -> (Self, Stopper) {
        let (tx, rx) = watch::channel(false);
        (Self { rx }, Stopper { tx })
    }

    /// A token nothing will ever stop, for a caller that has no Stop to offer.
    #[must_use]
    pub fn never() -> Self {
        let (_, rx) = watch::channel(false);
        Self { rx }
    }

    /// Whether the reader has stopped it. Cheap; call it freely inside a loop.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// [`Error::Cancelled`] if the reader gave up, else `Ok(())`.
    ///
    /// The shape most call sites want: `cancel.check()?` at the top of each loop
    /// turn reads as a guard rather than as a branch.
    ///
    /// # Errors
    /// [`Error::Cancelled`].
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Resolves when the reader stops it — and immediately if they already have.
    pub async fn cancelled(&self) {
        let mut rx = self.rx.clone();
        // `borrow` first: `changed()` waits for the NEXT change, so a token
        // already stopped would otherwise hang the caller for ever.
        if *rx.borrow() {
            return;
        }
        while rx.changed().await.is_ok() {
            if *rx.borrow() {
                return;
            }
        }
        // Every sender is gone and nothing stopped it: wait for ever rather than
        // resolve, so `select!` keeps the download running.
        std::future::pending::<()>().await;
    }
}

impl Stopper {
    /// Stop the work this token belongs to.
    pub fn stop(&self) {
        self.tx.send_replace(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_fresh_token_is_not_cancelled() {
        let (cancel, _stopper) = Cancel::new();
        assert!(!cancel.is_cancelled());
        assert!(cancel.check().is_ok());
    }

    #[tokio::test]
    async fn stopping_is_seen_by_every_holder() {
        let (cancel, stopper) = Cancel::new();
        let other = cancel.clone();
        stopper.stop();
        assert!(cancel.is_cancelled() && other.is_cancelled());
        assert!(matches!(cancel.check(), Err(Error::Cancelled)));
    }

    #[tokio::test]
    async fn waiting_resolves_when_it_is_stopped() {
        let (cancel, stopper) = Cancel::new();
        let waiter = tokio::spawn(async move { cancel.cancelled().await });
        stopper.stop();
        tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("a stopped token must resolve its waiter")
            .expect("the waiting task");
    }

    #[tokio::test]
    async fn waiting_on_an_already_stopped_token_returns_at_once() {
        let (cancel, stopper) = Cancel::new();
        stopper.stop();
        tokio::time::timeout(std::time::Duration::from_secs(5), cancel.cancelled())
            .await
            .expect("`changed` waits for the NEXT change, so this is the case that hangs");
    }

    #[tokio::test]
    async fn dropping_the_stopper_does_not_cancel_the_work() {
        let (cancel, stopper) = Cancel::new();
        drop(stopper);
        assert!(!cancel.is_cancelled(), "a download outliving its handle is still wanted");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), cancel.cancelled())
                .await
                .is_err(),
            "and nothing may resolve its waiter"
        );
    }

    #[tokio::test]
    async fn a_token_nothing_can_stop_never_resolves() {
        let cancel = Cancel::never();
        assert!(!cancel.is_cancelled());
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), cancel.cancelled())
            .await
            .is_err());
    }
}
