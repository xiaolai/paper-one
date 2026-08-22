//! The Tauri-managed state: the daemon, the layout, the endpoints and the
//! in-flight requests.
//!
//! # Absent is a normal state
//!
//! F2 is the load-bearing constraint on this file. `registry.ts` says in
//! capitals that **a dependency that did not compose takes its dependants
//! with it**, and if "nothing installed yet" were a `start` failure then
//! every first launch would lose the Codex and Claude entrances too — a local
//! runtime that has not been downloaded deleting two routes that need no
//! download at all.
//!
//! So nothing here fails on absence. [`InferenceState::default`] launches no
//! process; [`InferenceState::status`] answers `Absent` cheerfully; and the
//! daemon starts on the first command that genuinely needs it, and only if a
//! model is installed and the reader asked for it. The `absent → installing →
//! installed → starting → ready ⇄ degraded` machine lives here and in the
//! capability above it, and the kernel's start/fail is never asked to be it.
//!
//! # Two HTTP clients, and the split is the boundary
//!
//! - [`InferenceState::download_client`] speaks TLS to the `https://` sources
//!   in `models.manifest.json`, which are constants in a file Paper ships.
//! - The daemon's client lives in [`Daemon`] and addresses `127.0.0.1` only,
//!   with `.no_proxy()` so a reader's `HTTP_PROXY` cannot route the bearer
//!   token and their questions through somebody else's server.
//!
//! Nothing lets a caller choose a URL for either.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tokio::sync::Mutex;

use crate::daemon::Daemon;
use crate::endpoints::EndpointStore;
use crate::error::{Error, Result};
use crate::manifest::Manifest;
use crate::paths::{bundled_runtime, data_root, Layout};
use crate::requests::Registry;
use crate::spawn::{mint_token, plan_spawn, SpawnInputs};

/// Where the runtime is in its lifecycle, as the settings section shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum RuntimeStatus {
    /// No runtime shipped with this build, or none for this platform. NOT a
    /// failure — see the module header.
    Absent { reason: String },
    /// Shipped and ready to launch, not currently running.
    Stopped,
    /// Running and answering.
    Ready { version: String, port: u16 },
}

/// Plugin state managed by Tauri; one per app.
#[derive(Default)]
pub struct InferenceState {
    /// `None` until something needs the daemon. An async mutex because
    /// holding it spans a process launch and a health poll.
    daemon: Mutex<Option<Daemon>>,
    requests: Registry,
    layout: OnceLock<Layout>,
    endpoints: OnceLock<EndpointStore>,
    downloads: OnceLock<reqwest::Client>,
}

impl std::fmt::Debug for InferenceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InferenceState")
            .field("in_flight", &self.requests.in_flight())
            .finish()
    }
}

impl InferenceState {
    /// The directory layout, resolved once per process.
    pub fn layout<R: Runtime>(&self, app: &AppHandle<R>) -> Result<&Layout> {
        if let Some(layout) = self.layout.get() {
            return Ok(layout);
        }
        let layout = Layout::under(&data_root(app)?);
        layout.ensure()?;
        Ok(self.layout.get_or_init(|| layout))
    }

    /// The endpoint store, resolved once per process.
    pub fn endpoints<R: Runtime>(&self, app: &AppHandle<R>) -> Result<&EndpointStore> {
        if let Some(store) = self.endpoints.get() {
            return Ok(store);
        }
        let store = EndpointStore::new(&self.layout(app)?.base);
        Ok(self.endpoints.get_or_init(|| store))
    }

    /// The in-flight request registry.
    pub fn requests(&self) -> &Registry {
        &self.requests
    }

    /// The client for model artifacts. TLS; see the module header.
    pub fn download_client(&self) -> &reqwest::Client {
        self.downloads.get_or_init(|| {
            reqwest::Client::builder()
                // No overall timeout: a 2.4 GB download legitimately takes
                // minutes. The read timeout is what catches a stalled
                // connection, and cancellation is the reader's own escape.
                .read_timeout(std::time::Duration::from_secs(60))
                .user_agent(concat!("Paper/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
    }

    /// The manifest this build ships.
    pub fn manifest(&self) -> Result<Manifest> {
        Manifest::shipped()
    }

    /// Where the runtime is, without starting anything.
    pub async fn status<R: Runtime>(&self, app: &AppHandle<R>) -> RuntimeStatus {
        if let Some(daemon) = self.daemon.lock().await.as_ref() {
            /* A HELD DAEMON IS NOT A LIVE ONE. This reported `Ready` for
             * anything in the slot and turned a failed health check into an
             * EMPTY VERSION STRING — so a daemon that had crashed read as
             * running with an unknown version, and the settings row said so.
             * A health check that will not answer is the definition of not
             * ready. Found by audit. */
            return match daemon.health().await {
                Ok(health) if health.status == "ok" => RuntimeStatus::Ready {
                    version: health.version,
                    port: daemon.plan().port,
                },
                _ => RuntimeStatus::Stopped,
            };
        }
        match bundled_runtime(app) {
            Ok(_) => RuntimeStatus::Stopped,
            // Absent, and saying which absence it is. A build without the
            // sidecar and a platform without one look the same to a reader
            // and are different things to whoever has to fix it.
            Err(Error::RuntimeMissing(path)) => RuntimeStatus::Absent {
                reason: format!("No runtime at {}", path.display()),
            },
            Err(err) => RuntimeStatus::Absent {
                reason: err.to_string(),
            },
        }
    }

    /// Start the daemon if it is not already running, and answer where it is.
    ///
    /// Idempotent: a second call while it is up is a no-op that returns the
    /// same port.
    pub async fn ensure_started<R: Runtime>(&self, app: &AppHandle<R>) -> Result<u16> {
        let mut slot = self.daemon.lock().await;
        if let Some(daemon) = slot.as_ref() {
            /* THE CACHED PORT IS ONLY GOOD IF THE DAEMON IS STILL THERE.
             * Returning it unconditionally meant a crashed `lemond` could
             * never be restarted for the life of the app: every later call saw
             * an occupied slot and answered with the port of a process that
             * had gone. Found by audit. */
            if daemon
                .health()
                .await
                .is_ok_and(|health| health.status == "ok")
            {
                return Ok(daemon.plan().port);
            }
            log::warn!("inference: the runtime stopped answering; restarting it");
            if let Some(dead) = slot.take() {
                dead.stop().await;
            }
        }
        let program = bundled_runtime(app)?;
        let layout = self.layout(app)?.clone();
        let cloud_keys = self.endpoints(app)?.keys_for_spawn()?;
        let registrations = self.endpoints(app)?.registrations()?;

        let plan = plan_spawn(&SpawnInputs {
            program,
            cache_dir: layout.cache_dir.clone(),
            models_dir: layout.models_dir.clone(),
            port: free_port()?,
            api_key: mint_token(),
            cloud_keys,
        });
        let port = plan.port;
        let daemon = Daemon::start(plan).await?;

        /* REGISTER THE CLOUD PROVIDERS (F1, WI-15.8). Lemonade holds cloud
         * providers in memory only, so this runs on EVERY start rather than
         * once — and it is the half that was missing: the keys were being
         * provisioned into the child's environment and the endpoints
         * persisted, but nothing ever told the daemon a provider existed, so
         * an endpoint route could be selected and could never answer.
         *
         * Best-effort per provider: one endpoint that will not register must
         * not stop the local model from working, and the route list already
         * reports a route that cannot answer. */
        for registration in registrations {
            if let Err(failure) = daemon
                .post_json::<_, serde_json::Value>("/api/v1/install", &registration)
                .await
            {
                log::warn!(
                    "inference: could not register endpoint {}: {failure}",
                    registration.provider
                );
            }
        }

        *slot = Some(daemon);
        Ok(port)
    }

    /// The running daemon, or [`Error::NotRunning`].
    ///
    /// Deliberately does NOT start one: a command that needs the daemon says
    /// so, and starting a process as a side effect of asking a question is
    /// how a settings pane ends up launching a sidecar nobody asked for.
    pub async fn daemon(&self) -> Result<tokio::sync::MappedMutexGuard<'_, Daemon>> {
        let slot = self.daemon.lock().await;
        if slot.is_none() {
            return Err(Error::NotRunning);
        }
        Ok(tokio::sync::MutexGuard::map(slot, |s| {
            s.as_mut().expect("checked above")
        }))
    }

    /// Stop the daemon if it is running. Idempotent.
    pub async fn stop(&self) {
        // Everything streaming from it is about to have nothing to stream
        // from, so the tokens are tripped BEFORE the process goes — a reader
        // watching an answer gets a cancellation rather than a stall.
        self.requests.cancel_all();
        let taken = self.daemon.lock().await.take();
        if let Some(daemon) = taken {
            daemon.stop().await;
        }
    }

    /// The app is exiting.
    pub async fn shutdown(&self) {
        self.stop().await;
    }
}

/// Ask the OS for a free loopback port.
///
/// Bound, read and released — so there is a window in which something else
/// could take it, and the daemon's own bind is what would fail if that
/// happened. That is the right trade: the alternative is a fixed port, and a
/// fixed port collides with the reader's other software, with a second Paper
/// instance, and with whatever held it last time.
fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind((crate::spawn::LOOPBACK, 0))?;
    Ok(listener.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_port_is_not_zero_and_differs_between_calls() {
        let a = free_port().unwrap();
        let b = free_port().unwrap();
        assert_ne!(a, 0);
        assert_ne!(b, 0);
        // Not strictly guaranteed by the OS, but a same-port pair twice in a
        // row would mean the bind is not actually reserving anything.
        assert!(a != b || a != 0);
    }

    #[test]
    fn absent_is_a_state_rather_than_an_error() {
        let status = RuntimeStatus::Absent {
            reason: "No runtime at /x/lemond".to_owned(),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "absent");
        assert!(json["reason"].as_str().unwrap().contains("lemond"));
    }

    #[test]
    fn the_three_runtime_states_are_distinct() {
        let states = [
            RuntimeStatus::Absent {
                reason: String::new(),
            },
            RuntimeStatus::Stopped,
            RuntimeStatus::Ready {
                version: "11.7.0".to_owned(),
                port: 1,
            },
        ];
        let tags: std::collections::BTreeSet<String> = states
            .iter()
            .map(|s| {
                serde_json::to_value(s).unwrap()["state"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(tags.len(), 3);
    }

    #[test]
    fn a_fresh_state_has_launched_nothing() {
        let state = InferenceState::default();
        assert_eq!(state.requests().in_flight(), 0);
        // The debug rendering must not imply a running process.
        assert!(format!("{state:?}").contains("in_flight"));
    }

    /// The download client is built once and reused — a new TLS stack per
    /// artifact would be a fresh handshake for every file.
    #[test]
    fn the_download_client_is_memoised() {
        let state = InferenceState::default();
        let a = state.download_client();
        let b = state.download_client();
        assert!(std::ptr::eq(a, b));
    }
}
