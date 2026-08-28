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
    /// sweep through this; a second call replaces the first, which is why
    /// there is one caller.
    pub fn start_after(&self, task: JoinHandle<()>) {
        *self
            .before_start
            .lock()
            .expect("before_start is never poisoned") = Some(task);
    }

    async fn await_before_start(&self) {
        // Taken out under the lock, awaited outside it: a `std::sync::Mutex`
        // guard must not live across an await.
        let pending = self
            .before_start
            .lock()
            .expect("before_start is never poisoned")
            .take();
        if let Some(task) = pending {
            // A sweep that panicked is a logged failure, not a node that never
            // starts.
            if let Err(err) = task.await {
                log::warn!("peer: the .part sweep did not finish: {err}");
            }
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
