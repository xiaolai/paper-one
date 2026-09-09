//! The Tauri-managed state: the node, started lazily on the first command
//! that needs it.
//!
//! Starting the node loads the identity, binds UDP sockets and — with relays
//! on — contacts n0's relays to learn a home relay. None of that belongs in
//! plugin setup, where it would cost every launch a network round trip
//! whether or not the reader ever pairs. It happens on the first command,
//! once; every later call gets the same node back. Events go out through
//! `app.emit` under the names in `events.rs`.

use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::OnceCell;

use crate::data_root::data_root;
use crate::error::Result;
use crate::events::EventSink;
use crate::node::{Node, NodeConfig};
use crate::role::local_role;
use crate::share::{ShareConfig, ShareNode};

/// Plugin state managed by Tauri; one per app.
///
/// ⚠️ **TWO NODES, STARTED SEPARATELY AND CLOSED TOGETHER — WI-25.1.** The
/// circle node and the share node are two endpoints on two keys and two
/// ports, and neither depends on the other: a share endpoint that will not
/// bind must not cost the reader their circle, and a machine that has never
/// offered a book publicly should never pay for a share endpoint's store.
/// So each is its own `OnceCell`, started on the first command that needs it,
/// and [`PeerState::close`] closes whichever exist.
#[derive(Default)]
pub struct PeerState {
    node: OnceCell<Arc<Node>>,
    /// The share endpoint — phase 25. Started on the first command that
    /// offers, withdraws or resolves publicly, which for most readers is
    /// never.
    share: OnceCell<Arc<ShareNode>>,
    /// The launch sweep of abandoned `.part` files
    /// (`blobs::sweep_abandoned_parts`), awaited once before the node starts.
    /// The node is the only route to a transfer, so ordering the two is what
    /// guarantees no fetch resumes from a file the sweep is about to unlink —
    /// and it lets the sweep leave the main thread at launch. `None` once
    /// awaited, or when setup scheduled nothing.
    before_start: Mutex<Option<JoinHandle<()>>>,
    /// Opened once this process is entitled to touch the library — see
    /// [`PeerState::hold_library`].
    library: Arc<tokio::sync::Notify>,
    /// Whether [`hold_library`](PeerState::hold_library) has been called, so a
    /// waiter arriving after it does not park for ever. `Notify` on its own
    /// only wakes tasks ALREADY waiting, which is the same trap the circle
    /// keeper's `notify_waiters` fell into.
    library_held: Arc<std::sync::atomic::AtomicBool>,
}

impl std::fmt::Debug for PeerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerState")
            .field("started", &self.node.initialized())
            .finish()
    }
}

impl PeerState {
    /// The node, starting it on first use. Concurrent first callers wait on
    /// the same start rather than each binding their own sockets.
    pub async fn node<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<Node>> {
        self.node
            .get_or_try_init(|| async {
                self.await_before_start().await;
                let root = data_root(app)?;
                let role = local_role(&root)?;
                let sink = tauri_sink(app.clone());
                Node::start(NodeConfig::for_app(root, role, sink)).await
            })
            .await
            .cloned()
    }

    /// Start the share endpoint if this device still has something offered.
    ///
    /// ⚠️ **PERSISTED OFFERS DID NOT RESUME SERVING AFTER A RELAUNCH.** Found
    /// by audit, and it is the worst shape a bug of this kind can have: the
    /// policy file survives, so the Publish pane reads it and shows the book as
    /// offered — while no share endpoint is running and nobody can fetch it.
    /// A reader would have had to make an unrelated change to turn their own
    /// library back on.
    ///
    /// ⚠️ **AND IT READS A FILE FIRST, SO AN INSTALLATION THAT HAS NEVER
    /// PUBLISHED STAYS IDLE.** That is the whole reason the endpoint is lazy:
    /// a second UDP port, a second key and a blob store are not a cost a
    /// reader who has offered nothing should pay. `SharePolicy::load` touches
    /// no network and starts nothing.
    pub async fn resume_share<R: Runtime>(&self, app: &AppHandle<R>) -> Result<bool> {
        let root = data_root(app)?;
        let offers = crate::share::policy::SharePolicy::load_or_refuse_all(&root);
        let offered = crate::share::policy::ShareService::ALL
            .iter()
            .any(|service| !offers.offered(*service).is_empty());
        if !offered {
            return Ok(false);
        }
        self.share_node(app).await?;
        Ok(true)
    }

    /// The share endpoint, starting it on first use.
    ///
    /// ⚠️ **NOT STARTED BESIDE THE CIRCLE NODE, AND THAT IS DELIBERATE.**
    /// Starting it opens a second UDP port, loads a second key and opens a
    /// blob store; a reader who never publishes anything should pay for none
    /// of that. Every command that reaches it is one a reader asked for — or
    /// [`resume_share`](Self::resume_share), which asks the file first.
    pub async fn share_node<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<ShareNode>> {
        self.share
            .get_or_try_init(|| async {
                let root = data_root(app)?;
                ShareNode::start(ShareConfig::for_app(root)).await
            })
            .await
            .cloned()
    }

    /// A task the node must not start before. Setup schedules the `.part`
    /// sweep through this, ONCE — a second call would silently detach the
    /// first barrier, so it is a programming error and says so.
    /// Say that this process holds the library and may touch its files.
    ///
    /// ⚠️ **TAURI RUNS PLUGIN SETUP BEFORE THE APPLICATION'S OWN**, so
    /// everything this plugin starts at setup runs BEFORE the desktop app has
    /// tried to take the library lock — including in a second Paper that the
    /// lock is about to refuse. That second process was sweeping abandoned
    /// `.part` files out of the FIRST one's library, which is not a stale-file
    /// cleanup but the deletion of staging files a live fetch is writing into,
    /// and it was opening the shared blob store beside it. Found by audit.
    ///
    /// Idempotent. A build with no library lock — every phone — calls it at
    /// setup, because there is nothing to wait for there and a gate that never
    /// opens is a device that never sweeps.
    pub fn hold_library(&self) {
        self.library_held
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.library.notify_waiters();
    }

    /// Wait until this process is entitled to touch the library.
    pub async fn library_granted(&self) {
        if self.library_held.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let waiting = self.library.notified();
        /* Re-checked after arming the waiter: `hold_library` between the load
         * above and this point would otherwise be missed entirely. */
        if self.library_held.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        waiting.await;
    }

    pub fn start_after(&self, task: JoinHandle<()>) {
        let replaced = self
            .before_start
            .lock()
            .expect("before_start is never poisoned")
            .replace(task);
        debug_assert!(replaced.is_none(), "start_after has ONE caller: setup");
        if replaced.is_some() {
            log::error!("peer: start_after called twice; the first barrier is detached");
        }
    }

    async fn await_before_start(&self) {
        // Taken out under the lock, awaited outside it: a `std::sync::Mutex`
        // guard must not live across an await.
        let pending = self
            .before_start
            .lock()
            .expect("before_start is never poisoned")
            .take();
        let Some(task) = pending else { return };
        /* CANCEL-SAFE: the first `node()` future can be dropped mid-await
         * (a command torn down), and the take() above would then have
         * DETACHED the barrier — the next caller would find `None` and start
         * the node with the sweep still running. The guard puts an
         * unfinished handle back on the way out, so a cancelled waiter
         * leaves the barrier standing for the next one. */
        struct PutBack<'a> {
            slot: &'a Mutex<Option<JoinHandle<()>>>,
            task: Option<JoinHandle<()>>,
        }
        impl Drop for PutBack<'_> {
            fn drop(&mut self) {
                /* Unconditionally: `tauri::async_runtime::JoinHandle` has no
                 * `is_finished`, and re-awaiting a handle whose task already
                 * completed just answers immediately — putting a finished one
                 * back costs the next caller one no-op await. */
                if let Some(task) = self.task.take() {
                    *self.slot.lock().expect("before_start is never poisoned") = Some(task);
                }
            }
        }
        let mut guard = PutBack {
            slot: &self.before_start,
            task: Some(task),
        };
        let outcome = guard.task.as_mut().expect("just set").await;
        guard.task = None; // Completed: nothing to put back.
                           // A sweep that panicked is a logged failure, not a node that never
                           // starts.
        if let Err(err) = outcome {
            log::warn!("peer: the .part sweep did not finish: {err}");
        }
    }

    /// Close the node if it was ever started. Waits for the QUIC close to go
    /// out, so peers see a clean close instead of an idle timeout.
    pub async fn close(&self) {
        if let Some(node) = self.node.get() {
            node.close().await;
        }
        /* ⚠️ **BOTH, AND THE SECOND ONE IS EASY TO FORGET.** An endpoint that
         * vanishes rather than closing leaves its peers to time out, and a
         * share endpoint that stays bound after the app closes takes 47822
         * with it — the same trap `Node::close` was written for, one port
         * over. */
        if let Some(share) = self.share.get() {
            share.close().await;
        }
    }
}

fn tauri_sink<R: Runtime>(app: AppHandle<R>) -> EventSink {
    Arc::new(move |event| {
        // A failed emit means no webview is listening; the plugin has
        // nothing better to do with it than move on.
        let _ = app.emit(event.name(), event.payload());
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ **THE GATE EXISTS BECAUSE PLUGIN SETUP RUNS BEFORE THE LIBRARY
    /// LOCK.** A second Paper that the lock was about to refuse had already
    /// swept `.part` files out of the holder's library — staging files a live
    /// fetch writes into, not stale ones. These assert the two halves that
    /// make the gate correct: it BLOCKS until granted, and it never parks a
    /// waiter that arrives late.
    #[tokio::test]
    async fn the_library_gate_blocks_until_it_is_granted() {
        let state = Arc::new(PeerState::default());
        let waiting = {
            let state = state.clone();
            tokio::spawn(async move { state.library_granted().await })
        };
        /* Not a performance assertion: a liveness one in the other direction.
        If the gate did not block, this would already have finished. */
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !waiting.is_finished(),
            "the gate let a caller through before the library was held"
        );
        state.hold_library();
        tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("the gate never opened")
            .expect("the waiter panicked");
    }

    /// ⚠️ **`Notify::notify_waiters` ONLY WAKES TASKS ALREADY WAITING**, so a
    /// gate built on it alone parks for ever anything that arrives after the
    /// grant — which is every command on a normally ordered launch. The circle
    /// keeper had exactly this defect under its own name; the flag beside the
    /// `Notify` is what removes it here.
    #[tokio::test]
    async fn a_caller_arriving_after_the_grant_does_not_park() {
        let state = PeerState::default();
        state.hold_library();
        tokio::time::timeout(std::time::Duration::from_secs(5), state.library_granted())
            .await
            .expect("a caller that arrived after the grant waited for ever");
    }

    #[tokio::test]
    async fn granting_twice_is_harmless() {
        let state = PeerState::default();
        state.hold_library();
        state.hold_library();
        tokio::time::timeout(std::time::Duration::from_secs(5), state.library_granted())
            .await
            .expect("a second grant closed the gate");
    }
}
