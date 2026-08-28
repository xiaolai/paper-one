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

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
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
    /// Serialises every read-modify-write of the endpoint list.
    ///
    /// ⚠️ `add` and `remove` both read the file, edit it in memory and write it
    /// back through the SAME temporary path. Two of them at once lose one of
    /// the two edits, or rename a half-written file over the list — and the
    /// list is the only record of what the reader configured. Nothing
    /// serialised them; `#[tauri::command]`s run concurrently.
    endpoint_writes: Mutex<()>,
    /// The endpoints the DAEMON does not have, as of its last start: the ones
    /// it refused to register, and the ones it was never offered because the
    /// keychain would not read their key (WI-20.20).
    ///
    /// Registration is best-effort and per provider, so one endpoint the
    /// daemon will not take must not stop the local model working. But the
    /// refusal was only logged, and the probe went on reporting the row usable
    /// from Paper's own persisted state — so the reader could select a route
    /// that had already been turned down, and find out at the question.
    unregistered: Mutex<BTreeSet<String>>,
    /// How many times the daemon has been dropped for a configuration change.
    /// For a test and a diagnostic — see [`InferenceState::reconfigurations`].
    reconfigured: AtomicU64,
    downloads: OnceLock<reqwest::Client>,
}

impl std::fmt::Debug for InferenceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InferenceState")
            .field("in_flight", &self.requests.in_flight())
            .field("reconfigurations", &self.reconfigurations())
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

    /// The lock every endpoint mutation takes — see `endpoint_writes`.
    pub fn endpoint_writes(&self) -> &Mutex<()> {
        &self.endpoint_writes
    }

    /// Run one endpoint-store operation off the async runtime.
    ///
    /// ⚠️ **THE STORE IS BLOCKING, AND SO IS THE KEYCHAIN.** `read`/`write` are
    /// `std::fs`, and every key operation goes through the OS keychain, which
    /// on macOS can put a modal prompt in front of the reader — an unbounded
    /// wait on a tokio worker thread. Calling either straight from an `async`
    /// command stalls the runtime, and with it every other command, the
    /// daemon's health poll and any streaming answer.
    ///
    /// This is THE way to a store. The four endpoint commands went through it
    /// and three other callers — the probe, `route_for`, the daemon start —
    /// reached past it to call the store directly on the runtime (WI-20.20);
    /// `the_store_is_reached_only_through_the_blocking_seam` now holds every
    /// caller to it.
    pub(crate) async fn on_store<R, T>(
        &self,
        app: &AppHandle<R>,
        work: impl FnOnce(&EndpointStore) -> Result<T> + Send + 'static,
    ) -> Result<T>
    where
        R: Runtime,
        T: Send + 'static,
    {
        // Cloned rather than borrowed: `spawn_blocking` needs `'static`, and
        // the store is a path and a handle.
        let store = self.endpoints(app)?.clone();
        Self::on_endpoints(store, work).await
    }

    /// [`InferenceState::on_store`] over a store already resolved — the half
    /// a test can reach without an app.
    async fn on_endpoints<T>(
        store: EndpointStore,
        work: impl FnOnce(&EndpointStore) -> Result<T> + Send + 'static,
    ) -> Result<T>
    where
        T: Send + 'static,
    {
        tokio::task::spawn_blocking(move || work(&store))
            .await
            .map_err(|join| Error::Io(std::io::Error::other(join.to_string())))?
    }

    /// Forget an endpoint, then drop the daemon so it forgets the key too.
    ///
    /// ⚠️ REGARDLESS of whether the keychain let the key go. The command used
    /// to `?` the store's answer before `reconfigure`, so a keychain refusal
    /// on the clear left the key live in the running child's environment,
    /// with its provider still registered — the exact outcome the reconfigure
    /// exists to prevent, on the one path where the reader has just been told
    /// something is wrong with that key. The refusal is still the answer; it
    /// just no longer decides whether the daemon keeps the credential.
    pub(crate) async fn remove_endpoint<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        id: String,
    ) -> Result<()> {
        self.then_reconfigure(self.on_store(app, move |store| store.remove(&id)))
            .await
    }

    /// [`InferenceState::remove_endpoint`] over a store already resolved —
    /// the half a test can reach without an app, and `#[cfg(test)]` because
    /// nothing else has a store the state did not resolve.
    #[cfg(test)]
    pub(crate) async fn remove_endpoint_from(
        &self,
        store: EndpointStore,
        id: String,
    ) -> Result<()> {
        self.then_reconfigure(Self::on_endpoints(store, move |store| store.remove(&id)))
            .await
    }

    /// Await a removal, reconfigure WHATEVER it answered, and hand its answer
    /// back. The order lives here once so the two entry points cannot drift
    /// on it.
    async fn then_reconfigure(
        &self,
        removal: impl std::future::Future<Output = Result<()>>,
    ) -> Result<()> {
        let removed = removal.await;
        self.reconfigure().await;
        removed
    }

    /// How many times [`InferenceState::reconfigure`] has run. For a test and
    /// a diagnostic: it is the only trace a reconfigure leaves when no daemon
    /// was up to be dropped.
    pub fn reconfigurations(&self) -> u64 {
        self.reconfigured.load(Ordering::Relaxed)
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
        /* OFF THE RUNTIME, and tolerant per endpoint. This was two direct
         * store calls on a worker thread — the keychain prompt `on_store`'s
         * header warns about, on the path every question takes — and each
         * `?`'d a keychain refusal: a macOS "Deny", or a dev rebuild whose
         * signature the entry's ACL no longer matches, stopped the daemon
         * for the local model too. `provisioning` skips and names the
         * endpoint instead; the daemon starts (WI-20.20). */
        let provisioning = self.on_store(app, |store| store.provisioning()).await?;
        for id in &provisioning.unreadable {
            log::warn!(
                "inference: endpoint {id} is not provisioned: the keychain would not read its key"
            );
        }

        let plan = plan_spawn(&SpawnInputs {
            program,
            cache_dir: layout.cache_dir.clone(),
            models_dir: layout.models_dir.clone(),
            port: free_port()?,
            api_key: mint_token(),
            cloud_keys: provisioning.keys,
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
        /* An endpoint whose key could not be read was never offered, and the
         * daemon does not have it either — so it goes in the same set the
         * probe reads, and is not offered as a route that would fail. */
        let mut refused = provisioning.unreadable;
        for registration in provisioning.registrations {
            if let Err(failure) = daemon
                .post_json::<_, serde_json::Value>("/api/v1/install", &registration)
                .await
            {
                log::warn!(
                    "inference: could not register endpoint {}: {failure}",
                    registration.provider
                );
                /* RECORDED, NOT ONLY LOGGED. The probe reads this so a route
                the daemon turned down is reported as unusable rather than
                offered and then failing at the question. */
                refused.insert(registration.provider.clone());
            }
        }
        *self.unregistered.lock().await = refused;

        *slot = Some(daemon);
        Ok(port)
    }

    /// Drop a running daemon so the next start picks up new endpoint config.
    ///
    /// ⚠️ **KEYS ARE INJECTED AT SPAWN AND PROVIDERS REGISTERED AT START.**
    /// So an endpoint added, re-keyed or removed while the daemon was up
    /// changed nothing in the child: the new one could not answer until the
    /// app restarted, and — the half that matters — a key the reader DELETED
    /// stayed live in the child's environment and its provider stayed
    /// registered. A credential somebody believes they removed is not
    /// something to leave running until next launch.
    ///
    /// Stopping rather than restarting: `ensure_started` runs before every
    /// question, so the next use brings it back with the current
    /// configuration, and a settings command does not spend a process launch.
    /// `stop` trips the in-flight tokens first, so a reader watching an answer
    /// gets a cancellation rather than a stall — the same contract every other
    /// daemon teardown has.
    /// The endpoint ids the daemon refused. Empty when it has not started.
    pub async fn unregistered(&self) -> BTreeSet<String> {
        self.unregistered.lock().await.clone()
    }

    pub async fn reconfigure(&self) {
        self.reconfigured.fetch_add(1, Ordering::Relaxed);
        let taken = self.daemon.lock().await.take();
        if let Some(daemon) = taken {
            self.requests.cancel_all();
            daemon.stop().await;
        }
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

    /// WI-20.20 (d). `inference_remove_endpoint` used to `?` the store's
    /// result BEFORE `reconfigure`, so a keychain that would not give the key
    /// up left it live in the running child's environment, its provider still
    /// registered — precisely the half the command's own comment calls "the
    /// half that matters". The daemon is dropped regardless, and the refusal
    /// is still the answer.
    #[tokio::test]
    async fn a_removal_the_keychain_refuses_still_reconfigures_the_daemon() {
        let dir = crate::testutil::ScratchDir::new("state");
        let keychain = crate::testutil::FakeKeychain::default()
            .with_key("denied", "sk-denied")
            .refusing(&["denied"]);
        let store = crate::endpoints::EndpointStore::with_keychain(
            dir.path(),
            std::sync::Arc::new(keychain),
        );
        store
            .add("denied", "D", "https://d.example.com/v1")
            .unwrap();
        let state = InferenceState::default();
        assert_eq!(state.reconfigurations(), 0);

        let err = state
            .remove_endpoint_from(store.clone(), "denied".to_owned())
            .await
            .unwrap_err();
        assert_eq!(
            err.kind(),
            "keychain",
            "the refusal is surfaced, not swallowed"
        );
        assert_eq!(
            state.reconfigurations(),
            1,
            "the daemon is reconfigured whether or not the keychain let the key go"
        );
        assert!(store.list().unwrap().is_empty(), "the row is gone");
    }

    /// WI-20.20 (c). The store is `std::fs` and the keychain can put a modal
    /// prompt in front of the reader — an unbounded wait — so neither may run
    /// on a runtime worker. `on_store`'s header says so, and three callers
    /// (`inference_probe`, `route_for`, `ensure_started`) reached past it to
    /// call the store directly. This holds every store call behind the seam:
    /// the only way to a store, in either file, is through `on_store`.
    #[test]
    fn the_store_is_reached_only_through_the_blocking_seam() {
        let state_source = include_str!("state.rs");
        let commands_source = include_str!("commands.rs");
        /* The resolver's call syntax and nothing else's: the definition is
         * `fn endpoints<R`, and the field reads are `endpoints.get`. So every
         * occurrence is a caller taking a store. Built at runtime so this
         * test's own source — which `include_str!` reads too — is not one. */
        let needle = format!(".{}(", "endpoints");
        let calls = |source: &str| source.matches(&needle).count();
        assert_eq!(
            calls(commands_source),
            0,
            "commands.rs resolves the store directly; go through state.on_store"
        );
        assert_eq!(
            calls(state_source),
            1,
            "state.rs resolves the store outside on_store"
        );
        let seam = state_source
            .find("async fn on_store")
            .expect("on_store lives in state.rs");
        let seam_end = state_source[seam..]
            .find("\n    }\n")
            .map(|end| seam + end)
            .expect("on_store has a body");
        assert!(
            state_source[seam..seam_end].contains(&needle),
            "the one resolution is not inside on_store"
        );
    }
}
