//! `tauri-plugin-peer` — Paper's peer transport, as a Tauri plugin.
//!
//! What it is (dev-docs/mobile-sync/plan.md, Part III, Phase B): the iroh
//! endpoint keyed by the device identity (`peer/identity.key`), the peer
//! list with roles and grants (`peer/peers.json`), pairing over
//! `one.paper.reader/pair/1`, an allow-listed accept loop on
//! `one.paper.reader/peer/1` with a per-session inbox drained after
//! `peer_ready`, and blob streams with resume and BLAKE3 verification into
//! validated targets under `books/` — policy-free: it knows nothing of
//! books, journals or services, never writes a book's own files, and checks
//! no grant but `blob:read` for the bytes it serves itself.
//!
//! Registered from the app's `lib.rs` as `.plugin(tauri_plugin_peer::init())`
//! on every platform; the ACL grant is `peer:default`.

mod blobs;
mod commands;
mod data_root;
mod error;
mod events;
mod frame;
mod identity;
mod node;
mod pairing;
mod paths;
mod peers;
mod role;
mod session;
mod state;
#[cfg(test)]
mod testutil;

pub use blobs::{FetchRequest, HashResult, GRANT_READ};
pub use data_root::{data_root, guard_inside_root, TEST_DATA_DIR_ENV};
pub use error::{Error, Result};
pub use events::{null_sink, EventSink, PeerEvent};
pub use node::{Discovery, Node, NodeConfig};
pub use pairing::{PairOffer, PairStart, PairUri, PAIR_ALPN};
pub use paths::{Access, BlobTarget};
pub use peers::{grant_covers, PeerRecord};
pub use role::{local_role, Role, ROLE_ENV};
pub use session::PEER_ALPN;
pub use state::PeerState;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, RunEvent, Runtime};

/// The plugin. Manages a [`PeerState`] and closes its node on exit.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("peer")
        .invoke_handler(tauri::generate_handler![
            commands::peer_status,
            commands::peer_local_role,
            commands::paper_data_root,
            commands::fs_fsync,
            commands::peer_list_peers,
            commands::peer_forget_peer,
            commands::peer_set_grants,
            commands::peer_has_grant,
            commands::peer_pair_begin,
            commands::peer_pair_cancel,
            commands::peer_pair_confirm,
            commands::peer_pair_from_uri,
            commands::peer_ready,
            commands::peer_connect,
            commands::peer_send,
            commands::peer_session_recv,
            commands::peer_close,
            commands::peer_blob_fetch,
            commands::peer_hash_file,
        ])
        .setup(|app, _api| {
            app.manage(PeerState::default());
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                // A QUIC endpoint that just vanishes leaves its peers to time
                // out; closing sends CONNECTION_CLOSE. `Exit` runs on the main
                // thread outside the async runtime, so blocking here is fine.
                let state = app.state::<PeerState>();
                tauri::async_runtime::block_on(state.close());
            }
        })
        .build()
}
