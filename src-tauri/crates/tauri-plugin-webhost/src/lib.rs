//! The browser client's host, as a Tauri plugin (phase 18, WI-18.4d).
//!
//! Binds an HTTP server on loopback, and carries frames between it and the
//! webview. The HTTP surface itself is `paper-webhost`, which has no Tauri in
//! it and is tested without one; this is the wiring.
//!
//! ## The port is pinned, and bound to 127.0.0.1 explicitly
//!
//! Both halves of that were paid for already, by the automation bridge. From
//! `AGENTS.md`: the plugin "defaults to `0.0.0.0:9223` and scans the next 100
//! ports if that is taken, so two Tauri projects left on the default stack next
//! to each other and the MCP host attaches to whichever won the bind." And:
//! "The explicit `bind_address` matters too — the plugin's own default exposes
//! the bridge to the LAN."
//!
//! So: one port, never scanned for, and loopback stated rather than defaulted.
//! **A LAN bind here would be worse than it was for the bridge**, because the
//! whole auth design assumes an attacker cannot reach this socket directly —
//! `paper-webhost`'s header says so. TLS is terminated by a proxy in front.
//!
//! 27182 rather than a common development port: 5173, 8080, 3000 and 9000 all
//! belong to something a reader may already be running, and 31415/31416 are
//! this repository's own bridge and its tunnel. The digits of *e*, since the
//! bridge took π.
//!
//! ## If the port is taken, the plugin does not start and says so
//!
//! It does NOT scan for a free one. A shelf that quietly moved would leave the
//! reader's reverse proxy pointing at nothing, with no error anywhere — the
//! exact failure the bridge's scan produced. `status().port` is `null` and the
//! Devices pane can say why.

mod client;
mod commands;
mod error;
mod state;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

pub use error::Error;

use paper_webhost::{router, WebHost};
use state::WebHostState;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// The loopback port the browser client is served on. See the header.
pub const WEBHOST_PORT: u16 = 27182;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("webhost")
        .invoke_handler(tauri::generate_handler![
            commands::webhost_status,
            commands::webhost_begin_code,
            commands::webhost_cancel_code,
            commands::webhost_sessions,
            commands::webhost_revoke,
            commands::webhost_ready,
            commands::webhost_send,
            commands::webhost_session_recv,
        ])
        .setup(|app, _api| {
            let host = Arc::new(WebHost::new());
            /* ONE managed value, and the commands take the same `Arc`.
             * Managing a second `WebHostState` beside it compiled, ran, and
             * was wrong: the server task set the bound port on one object
             * while every command read the other, so `status().port` would
             * have been null forever with nothing failing anywhere. */
            let plugin_state = Arc::new(WebHostState::new(Arc::clone(&host)));
            app.manage(Arc::clone(&plugin_state));

            let serving = Arc::clone(&host);
            let announce = Arc::clone(&plugin_state);
            tauri::async_runtime::spawn(async move {
                let address = SocketAddr::from((Ipv4Addr::LOCALHOST, WEBHOST_PORT));
                match tokio::net::TcpListener::bind(address).await {
                    Ok(listener) => {
                        /* The bound port, read back rather than assumed — the
                         * one fact worth having if this is ever changed to
                         * accept 0. */
                        if let Ok(local) = listener.local_addr() {
                            announce.set_port(local.port());
                        }
                        if let Err(error) =
                            axum::serve(listener, router(serving, client::CLIENT)).await
                        {
                            log::error!("webhost: the server stopped: {error}");
                        }
                    }
                    /* LOUD AND NOT FATAL. The reader still has an app; what
                     * they do not have is a browser client, and `status()`
                     * reporting a null port is how the pane says so. */
                    Err(error) => {
                        log::error!(
                            "webhost: could not bind 127.0.0.1:{WEBHOST_PORT}: {error}. \
                             The browser client is unavailable this run; nothing else is affected."
                        );
                    }
                }
            });
            Ok(())
        })
        .build()
}
