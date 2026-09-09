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
mod circle;
mod commands;
mod data_root;
mod endpoint;
mod error;
mod events;
mod frame;
mod identity;
mod keeper;
mod keyfile;
mod node;
mod pairing;
mod paths;
mod peers;
mod person;
mod role;
mod session;
mod share;
mod state;
mod store;
#[cfg(test)]
mod testutil;

pub use blobs::{FetchRequest, HashResult, GRANT_READ};
pub use data_root::{data_root, guard_inside_root, TEST_DATA_DIR_ENV};
pub use endpoint::{Advertised, Discovery, APP_BIND_PORT, SHARE_BIND_PORT};
pub use error::{Error, Result};
pub use events::{null_sink, EventSink, PeerEvent};
pub use node::{Node, NodeConfig};
pub use pairing::{PairOffer, PairStart, PairUri, PAIR_ALPN};
pub use paths::{Access, BlobTarget};
pub use peers::{grant_covers, PeerRecord};
pub use role::{local_role, Role, ROLE_ENV};
pub use session::PEER_ALPN;
pub use share::notes::NOTES_ALPN;
pub use share::policy::{SharePolicy, ShareService};
pub use share::{ContentHash, ShareConfig, ShareNode};
pub use state::PeerState;

/// The host says this process holds the library and may touch its files.
///
/// ⚠️ **THE HOST EMITS IT; NOTHING HERE DOES.** Tauri initialises plugins
/// before the application's own `setup`, where the desktop library lock is
/// taken — so everything this plugin starts at launch would otherwise run in a
/// process the lock is about to refuse. See `PeerState::hold_library`.
pub const LIBRARY_HELD_EVENT: &str = "paper://library-held";

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Listener, Manager, RunEvent, Runtime};

/// The plugin. Manages a [`PeerState`] and closes its node on exit.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("peer")
        .invoke_handler(tauri::generate_handler![
            commands::peer_status,
            commands::peer_local_role,
            commands::peer_set_local_role,
            commands::paper_data_root,
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
            commands::peer_person_status,
            commands::peer_person_ensure,
            commands::peer_person_phrase,
            commands::peer_person_restore,
            commands::peer_person_forget,
            commands::peer_person_delegate,
            commands::peer_circle_people,
            commands::peer_circle_mine,
            commands::peer_circle_roster,
            commands::peer_page_sign,
            commands::peer_circle_introduce,
            commands::peer_circle_revoke,
            commands::peer_circle_remember,
            commands::peer_circle_forget,
            commands::peer_share_offered,
            commands::peer_share_offer_bytes,
            commands::peer_share_offer_notes,
            commands::peer_share_withdraw,
            commands::peer_share_publish_note,
            commands::peer_share_resolve,
            commands::peer_share_fetch,
            commands::peer_voice_status,
            commands::peer_voice_next_seq,
            commands::peer_voice_sign,
            commands::peer_voice_rotate,
            commands::peer_voice_sweep,
        ])
        .setup(|app, _api| {
            let state = PeerState::default();
            /* THE `.part` SWEEP RUNS BEFORE THE NODE, NOT BEFORE THE WINDOW. A
             * walk of `books/` at launch is a walk the shelf otherwise avoids
             * — its index is the whole point of `index.json` — so it goes to
             * a blocking thread, and the node waits for it instead of the
             * reader: the node is the only route to a transfer, and a fetch
             * that resumed from a `.part` the sweep then unlinked would land
             * its bytes in an unnamed inode and fail at the rename with the
             * wrong diagnosis. Ordered, the race cannot exist. */
            /* ⚠️ **AND IT WAITS FOR THE LIBRARY LOCK, WHICH IT DID NOT.**
             * Tauri initialises plugins BEFORE the application's own `setup`,
             * and the desktop lock is taken there — so this sweep ran in a
             * second Paper that the lock was about to refuse, deleting `.part`
             * files out of the FIRST process's library. Those are not stale
             * files: a live fetch is writing into them. Found by audit. */
            match data_root(app) {
                Ok(root) => {
                    /* The handle rather than the local `state`: this task runs
                     * after `app.manage` below, so it can ask for the managed
                     * state — and that is the one the application's own setup
                     * will call `hold_library` on. */
                    let handle = app.clone();
                    state.start_after(tauri::async_runtime::spawn(async move {
                        handle.state::<PeerState>().library_granted().await;
                        tauri::async_runtime::spawn_blocking(move || {
                            blobs::sweep_abandoned_parts(&root, std::time::SystemTime::now()).log();
                        })
                        .await
                        .ok();
                    }))
                }
                Err(err) => log::warn!(
                    "peer: no data root at setup; abandoned .part files are not swept this run: {err}"
                ),
            }
            /* ⚠️ **THE GATE IS OPENED BY THE APPLICATION, NEVER HERE.** A
             * `#[cfg(not(feature = "desktop"))]` sat at this line and was
             * always true: `desktop` is a feature of the APP crate, not of this
             * one, so the plugin opened its own gate on every platform and the
             * wait it exists for never happened. Clippy's unexpected-cfg lint
             * is what said so. The host decides — see `hold_library`. */
            /* ⚠️ **AN EVENT, NOT A CALL FROM THE APPLICATION.** The host has to
             * say when this process may touch the library (see
             * `PeerState::hold_library`), and having `src-tauri/src/lib.rs` name
             * `tauri_plugin_peer` to say it makes this plugin unremovable:
             * `capability:remove` refuses a `lib.rs` that still references the
             * crate after its `.plugin()` line is cut, and `removal.test.mjs`
             * failed exactly there. A string both sides know keeps the host
             * ignorant of which plugins care. */
            {
                let handle = app.clone();
                app.listen(LIBRARY_HELD_EVENT, move |_| {
                    handle.state::<PeerState>().hold_library();
                });
            }
            app.manage(state);
            /* ⚠️ **A BOOK OFFERED YESTERDAY IS OFFERED TODAY, AND IT WAS NOT.**
             * The policy file survives a relaunch and the endpoint did not, so
             * the Publish pane read the file and showed a book as offered while
             * nothing served it. `resume_share` reads that file and starts the
             * endpoint only when something is actually offered, so an
             * installation that has never published stays exactly as idle as
             * it was. Spawned rather than awaited: setup runs before the
             * window, and binding a UDP port is not something a reader should
             * wait behind. */
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<PeerState>();
                /* The share endpoint opens the blob store and binds a port —
                 * neither belongs to a process that does not hold the library.
                 * Same reason as the sweep above. */
                state.library_granted().await;
                match state.resume_share(&handle).await {
                    Ok(true) => log::info!("peer: the share endpoint resumed for this device's offers"),
                    Ok(false) => {}
                    Err(err) => log::warn!(
                        "peer: this device has public offers and the share endpoint did not start: {err}"
                    ),
                }
            });
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
