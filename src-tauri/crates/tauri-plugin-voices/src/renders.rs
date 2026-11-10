//! Renders in flight, by the id the webview gave each one, so a Stop can reach
//! the engine.
//!
//! ⚠️ **WHY THIS EXISTS: A STOPPED RENDER KEPT THE ENGINE.** Each engine is one
//! model behind one lock, so renders run one at a time. A render the reader had
//! walked away from used to run to its end — minutes, for a section — and the
//! render they asked for next waited behind it, with its deadline already
//! counting. A stop now reaches the engine loop through a [`Cancel`], and the
//! engine gives the lock up between one sentence or chunk and the next.
//!
//! ⚠️ **A STOP MAY ARRIVE BEFORE ITS RENDER DOES.** The two are separate
//! commands, and each runs as its own task, so nothing orders them. A stop for an
//! id not yet running is kept, and the render that arrives with that id starts
//! already stopped. Only the last [`EARLY_KEPT`] are kept: a stop for a render
//! that has already finished is one nothing will ever claim, and an unbounded
//! list of them would grow for as long as the app stays open.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use crate::cancel::{Cancel, Stopper};

/// How many stops are kept for renders that have not arrived. Far more than can
/// be in flight at once: the webview has one reading and one export.
pub const EARLY_KEPT: usize = 64;

/// The registry. One per plugin, in `VoicesState`.
#[derive(Debug, Default)]
pub struct Renders {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    live: HashMap<String, Stopper>,
    early: VecDeque<String>,
}

/// A render's place in the registry. Dropping it takes the render out, so a
/// render that ends in any way — answered, refused or panicked — is no longer
/// something a stop can find.
#[derive(Debug)]
pub struct Running<'a> {
    renders: &'a Renders,
    run: String,
}

impl Renders {
    /// Register a render under `run`, and hand back the token it must watch.
    ///
    /// The token is ALREADY STOPPED when a stop for this id arrived first.
    ///
    /// # Errors
    /// When the lock is poisoned, or when a render under this id is already
    /// running: two renders under one id would leave a stop able to reach only
    /// one of them.
    pub fn begin(&self, run: &str) -> Result<(Cancel, Running<'_>), String> {
        let mut inner = self.lock()?;
        if inner.live.contains_key(run) {
            return Err(format!("a render called {run} is already running"));
        }
        let (cancel, stopper) = Cancel::new();
        if let Some(at) = inner.early.iter().position(|id| id == run) {
            inner.early.remove(at);
            stopper.stop();
        }
        inner.live.insert(run.to_owned(), stopper);
        Ok((
            cancel,
            Running {
                renders: self,
                run: run.to_owned(),
            },
        ))
    }

    /// Stop the render under `run`, or the one that arrives with that id.
    ///
    /// ⚠️ **STOPPED IN PLACE, NOT TAKEN OUT.** A stopped render still runs until
    /// its engine loop next looks, and it keeps its id until it ends: this used
    /// to remove the entry, so a second render under the same id was let in
    /// beside it, and the first one's [`Running`] then removed the second's
    /// entry when it ended, leaving it out of reach of any stop.
    ///
    /// # Errors
    /// When the lock is poisoned.
    pub fn stop(&self, run: &str) -> Result<(), String> {
        let mut inner = self.lock()?;
        if let Some(stopper) = inner.live.get(run) {
            stopper.stop();
            return Ok(());
        }
        if !inner.early.iter().any(|id| id == run) {
            if inner.early.len() == EARLY_KEPT {
                inner.early.pop_front();
            }
            inner.early.push_back(run.to_owned());
        }
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
        self.inner
            .lock()
            .map_err(|_| "the renders in flight are poisoned".to_owned())
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        /* A poisoned lock here is a panic elsewhere; the entry is then left, and
         * the only cost is that a later stop for this finished id stops nothing. */
        if let Ok(mut inner) = self.renders.inner.lock() {
            inner.live.remove(&self.run);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_reaches_the_running_render() {
        let renders = Renders::default();
        let (cancel, _running) = renders.begin("a").expect("begin");
        assert!(!cancel.is_cancelled());
        renders.stop("a").expect("stop");
        assert!(cancel.is_cancelled());
    }

    #[test]
    fn a_stop_reaches_only_its_own_render() {
        let renders = Renders::default();
        let (a, _ra) = renders.begin("a").expect("begin a");
        let (b, _rb) = renders.begin("b").expect("begin b");
        renders.stop("b").expect("stop");
        assert!(!a.is_cancelled(), "the other render is untouched");
        assert!(b.is_cancelled());
    }

    #[test]
    fn a_stop_that_arrives_first_stops_the_render_that_follows() {
        let renders = Renders::default();
        renders.stop("a").expect("stop");
        let (cancel, _running) = renders.begin("a").expect("begin");
        assert!(cancel.is_cancelled(), "the render begins already stopped");
    }

    #[test]
    fn an_early_stop_is_claimed_once() {
        let renders = Renders::default();
        renders.stop("a").expect("stop");
        drop(renders.begin("a").expect("first"));
        let (again, _running) = renders.begin("a").expect("second");
        assert!(
            !again.is_cancelled(),
            "the stop belonged to the first render"
        );
    }

    #[test]
    fn a_finished_render_is_no_longer_running() {
        let renders = Renders::default();
        drop(renders.begin("a").expect("begin"));
        let (again, _running) = renders.begin("a").expect("the id is free again");
        assert!(!again.is_cancelled());
    }

    #[test]
    fn two_renders_under_one_id_are_refused() {
        let renders = Renders::default();
        let _first = renders.begin("a").expect("begin");
        assert!(renders.begin("a").is_err());
    }

    #[test]
    fn a_stopped_render_keeps_its_id_until_it_ends() {
        let renders = Renders::default();
        let first = renders.begin("a").expect("begin");
        renders.stop("a").expect("stop");
        assert!(
            renders.begin("a").is_err(),
            "a stopped render is still running, so its id is still taken"
        );
        drop(first);
        let (second, _running) = renders.begin("a").expect("the id is free once it ends");
        assert!(
            !second.is_cancelled(),
            "the first render's stop was its own"
        );
        renders.stop("a").expect("stop the second");
        assert!(
            second.is_cancelled(),
            "a stop reaches the render now under the id"
        );
    }

    #[test]
    fn early_stops_are_bounded_and_the_oldest_goes_first() {
        let renders = Renders::default();
        for n in 0..=EARLY_KEPT {
            renders.stop(&n.to_string()).expect("stop");
        }
        let (oldest, _a) = renders.begin("0").expect("begin oldest");
        assert!(!oldest.is_cancelled(), "the oldest early stop was let go");
        let (newest, _b) = renders
            .begin(&EARLY_KEPT.to_string())
            .expect("begin newest");
        assert!(newest.is_cancelled(), "the newest is still kept");
        let (second, _c) = renders.begin("1").expect("begin second");
        assert!(
            second.is_cancelled(),
            "and so is every one after the oldest"
        );
    }

    #[test]
    fn the_same_early_stop_twice_is_kept_once() {
        let renders = Renders::default();
        renders.stop("a").expect("stop");
        renders.stop("a").expect("stop again");
        drop(renders.begin("a").expect("first"));
        let (again, _running) = renders.begin("a").expect("second");
        assert!(!again.is_cancelled(), "one stop, one render");
    }
}
