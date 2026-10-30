//! `tauri-plugin-peer` — Paper's peer transport, as a Tauri plugin.
//!
//! What it is (dev-docs/mobile-sync/plan.md, Part III, Phase B): the iroh
//! endpoint keyed by the device identity (`peer/identity.key`), the peer
//! list with roles and grants (`peer/peers.json`), pairing over
//! `one.paper.reader/pair/1`, an allow-listed accept loop on
//! `one.paper.reader/peer/1` with a per-session inbox drained after
//! `peer_ready`, and blob streams with resume and BLAKE3 verification into
//! validated targets under `books/`.
//!
//! ⚠️ **"POLICY-FREE, CHECKS NO GRANT BUT `blob:read`" WAS TRUE OF PHASE B AND
//! IS NOT TRUE NOW.** Three later phases put authorization decisions in this
//! crate, and a crate header that understates what it decides is a header that
//! sends a reviewer to the wrong file:
//!
//! - **The circle** (phase 22) admits by ROSTER: `circle/` refuses a device
//!   whose person is not admitted, and revocation is enforced per request.
//! - **Public sharing** (phase 25) has `SharePolicy` — per book, per service,
//!   default off — asked on EVERY request rather than per connection, plus
//!   `ShareBounds`, which is a rate and concurrency policy of its own.
//! - **Public annotations** (phase 26) hold a second signing key, serve a
//!   book's annotation file to strangers, and ask that policy again.
//!
//! What is still true, and is the part worth keeping: it knows nothing of
//! books, journals or services as the app models them, and it never writes a
//! book's own files. What it decides is WHO MAY HAVE BYTES, in three
//! different ways, and it is where to look for that. Found by audit.
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

/// Said when this device has public offers and the share endpoint would not
/// start — see the resumption task.
///
/// ⚠️ **A LOG LINE IS NOT AN OBSERVABLE FAILURE.** A release build installs no
/// Rust logger at all (`src-tauri/src/lib.rs` pins the level under
/// `cfg!(debug_assertions)`), so the only record of a failed resumption went
/// nowhere — while the Publish pane, which reads the POLICY FILE, went on
/// showing the book as offered. The reader saw "offered" with nothing serving
/// it. Found by audit.
pub const SHARE_RESUME_FAILED_EVENT: &str = "paper://share-resume-failed";

/// How long exit waits for a polite goodbye before leaving it to the OS.
///
/// ⚠️ **THERE WAS NO DEADLINE, AND `Exit` BLOCKS THE MAIN THREAD.** The
/// shutdown chain includes the router's and the blob store's own, so one
/// stalled operation made the application unquittable — it had to be killed.
/// Past this the sockets close with the process and the peers time out, which
/// is what closing politely avoids and is strictly better than not quitting.
const EXIT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

use std::time::Duration;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Emitter, Listener, Manager, RunEvent, Runtime};

/// The plugin. Manages a [`PeerState`] and closes its node on exit.
///
/// ⚠️ **THE COMMAND INVENTORY IS IN THREE PLACES AND STAYS THERE.** This
/// handler list, `build.rs`'s `COMMANDS`, and `permissions/default.toml` each
/// name every command, and `commands.rs`'s `lists_agree` fails the build when
/// they disagree. Generating one from another is what an audit asked for, and
/// it is not available: `tauri::generate_handler!` needs the paths as literal
/// tokens at expansion time, and `build.rs` runs BEFORE the crate is compiled
/// — so neither list can be derived from the other without a third artifact
/// (a shared `include!`d file) that would itself become the fourth place to
/// keep in step. `commands.rs`'s own header records the same conclusion for
/// the same reason. The test is the mechanism; the repetition is the cost of
/// the macro, and it is bounded and loud.
/// How long the `.part` sweep waits for `app.manage` before giving up.
///
/// Far past any real interleaving — the two lines are microseconds apart in a
/// build that works — so its only job is that a state which is never managed
/// reports that instead of waiting forever. Housekeeping must not be the
/// reason an app fails to start.
const MANAGE_WAIT: Duration = Duration::from_secs(10);

/// How often it asks. Short enough that the sweep is not delayed by the wait.
const MANAGE_POLL: Duration = Duration::from_millis(5);

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
            commands::peer_share_id,
            commands::peer_share_offered,
            commands::peer_share_offer_bytes,
            commands::peer_share_offer_notes,
            commands::peer_share_withdraw,
            commands::peer_share_publish_note,
            commands::peer_share_resolve,
            commands::peer_share_fetch_notes,
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
                        /* ⚠️ **WAIT FOR `manage`, DO NOT ASSUME IT — AND THE
                         * COMMENT ABOVE ASSUMED IT.** It said *"this task runs
                         * after `app.manage` below"*, and nothing made that
                         * true: `spawn` can be polled before setup reaches the
                         * `app.manage(state)` line thirty lines down, and on
                         * two Macs it won that race EVERY time. `state()`
                         * panics when the type is not managed yet, the panic
                         * is caught and reported as a WARN, and the result is
                         * that `sweep_abandoned_parts` NEVER RUNS — silently,
                         * on every launch, since the sweep was added.
                         *
                         * Measured 2026-09-11 while building
                         * `public-scenario.sh`: three launches on
                         * a second Mac and one here, four for four, including
                         * unmodified 0.3.2 bundle. The log line is
                         * *"peer: the .part sweep did not finish: task N
                         * panicked with message \"state() called before
                         * manage() for tauri_plugin_peer::state::PeerState\""*.
                         *
                         * `try_state` asks instead of asserting. Bounded, so a
                         * build that never manages the state reports that
                         * rather than spinning or hanging: the sweep is
                         * housekeeping and must never be the reason an app
                         * fails to start. */
                        let mut waited = Duration::ZERO;
                        while handle.try_state::<PeerState>().is_none() {
                            if waited >= MANAGE_WAIT {
                                log::warn!(
                                    "peer: the .part sweep gave up waiting {MANAGE_WAIT:?} for PeerState to be managed"
                                );
                                return;
                            }
                            tokio::time::sleep(MANAGE_POLL).await;
                            waited += MANAGE_POLL;
                        }
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
                    /* ⚠️ **THE ANNOUNCE DECISION, SAID HERE AND NOT IN THE
                     * APP'S `setup`, AND NOT IN THIS PLUGIN'S EITHER.** An
                     * announce puts this machine's address, against a book's
                     * content hash, into a global and permanently queryable
                     * index, so it must be readable BEFORE anything touches a
                     * control. Three placements were tried and two were wrong:
                     *
                     * `ShareNode::start` — the share endpoint starts LAZILY,
                     * on the first command that offers or resolves, so the
                     * line arrived only after the act it exists to gate.
                     *
                     * This plugin's own `setup` — Tauri initialises plugins
                     * BEFORE the application's, `tauri_plugin_log` among them,
                     * so a `log::` call there has no logger yet and is
                     * discarded in silence. Measured: this plugin's later
                     * ASYNC lines reach `Paper.log` and a synchronous one
                     * from `setup` never did.
                     *
                     * The app's own `setup` — it works, and it made
                     * `src-tauri/src/lib.rs` name `tauri_plugin_peer` outside
                     * its `.plugin()` line, which is the coupling that makes
                     * this plugin unremovable (see the note above). Found by
                     * an independent audit the same day it was written.
                     *
                     * This listener is all three at once: inside the plugin,
                     * after every plugin is initialised, and before a reader
                     * can reach a control. */
                    log::info!(
                        "peer: share endpoint dht={}",
                        if crate::share::ShareConfig::for_app(std::path::PathBuf::new()).dht {
                            "on"
                        } else {
                            "off"
                        }
                    );
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
            /* ⚠️ **TRACKED, NOT DETACHED — SEE `PeerState::resuming`.** This
             * was a bare `spawn`, and `close()` only inspects the `OnceCell`s:
             * a resumption still INITIALISING at exit was invisible to it and
             * finished binding a UDP port after cleanup had run. */
            let handle = app.clone();
            app.state::<PeerState>()
                .resume_with(tauri::async_runtime::spawn(async move {
                    let state = handle.state::<PeerState>();
                    /* The share endpoint opens the blob store and binds a port —
                     * neither belongs to a process that does not hold the library.
                     * Same reason as the sweep above. */
                    state.library_granted().await;
                    match state.resume_share(&handle).await {
                        Ok(true) => {
                            log::info!("peer: the share endpoint resumed for this device's offers")
                        }
                        Ok(false) => {}
                        Err(err) => {
                            /* ⚠️ **A WARNING IS NOT AN OBSERVABLE FAILURE, AND A
                             * RELEASE BUILD INSTALLS NO RUST LOGGER AT ALL.** The
                             * Publish pane reads the POLICY FILE, which still says
                             * the book is offered — so a reader saw "offered" with
                             * nothing serving it and no way to find out. The event
                             * is what a surface can hear; `peer_share_offered`
                             * carries the same fact for a surface that asks. */
                            log::warn!(
                                "peer: this device has public offers and the share endpoint did not start: {err}"
                            );
                            let _ = handle.emit(SHARE_RESUME_FAILED_EVENT, err.to_string());
                        }
                    }
                }));
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                // A QUIC endpoint that just vanishes leaves its peers to time
                // out; closing sends CONNECTION_CLOSE. `Exit` runs on the main
                // thread outside the async runtime, so blocking here is fine.
                /* ⚠️ **UNDER A DEADLINE, AND IT HAD NONE.** The chain includes
                 * the router's and the blob store's own shutdowns; a stalled
                 * one blocked the MAIN THREAD for ever, which is an
                 * application that cannot be quit and has to be killed. A
                 * goodbye is worth waiting a moment for and is not worth
                 * hanging on: past the deadline the sockets are closed by the
                 * operating system anyway, and the peers time out — which is
                 * exactly the outcome closing politely was avoiding, reached
                 * only in the case where the polite path is broken. */
                let state = app.state::<PeerState>();
                let closed = tauri::async_runtime::block_on(async {
                    tokio::time::timeout(EXIT_DEADLINE, state.close()).await
                });
                if closed.is_err() {
                    log::warn!(
                        "peer: shutdown did not finish within {EXIT_DEADLINE:?}; leaving the rest to the operating system"
                    );
                }
            }
        })
        .build()
}
