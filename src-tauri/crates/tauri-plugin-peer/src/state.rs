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

/// Plugin state managed by Tauri; one per app.
#[derive(Default)]
pub struct PeerState {
    node: OnceCell<Arc<Node>>,
    /// The launch sweep of abandoned `.part` files
    /// (`blobs::sweep_abandoned_parts`), awaited once before the node starts.
    /// The node is the only route to a transfer, so ordering the two is what
    /// guarantees no fetch resumes from a file the sweep is about to unlink —
    /// and it lets the sweep leave the main thread at launch. `None` once
    /// awaited, or when setup scheduled nothing.
    before_start: Mutex<Option<JoinHandle<()>>>,
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

    /// A task the node must not start before. Setup schedules the `.part`
    /// sweep through this, ONCE — a second call would silently detach the
    /// first barrier, so it is a programming error and says so.
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
    }
}

fn tauri_sink<R: Runtime>(app: AppHandle<R>) -> EventSink {
    Arc::new(move |event| {
        // A failed emit means no webview is listening; the plugin has
        // nothing better to do with it than move on.
        let _ = app.emit(event.name(), event.payload());
    })
}
