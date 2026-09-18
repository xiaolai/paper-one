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
//!   with `.no_proxy()` so a reader's `HTTP_PROXY` cannot route the key and
//!   their questions through somebody else's server.
//!
//! Nothing lets a caller choose a URL for either.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tokio::sync::Mutex;

use crate::daemon::{Daemon, SHUTDOWN_GRACE};
use crate::endpoints::EndpointStore;
use crate::error::{Error, Result};
use crate::lineage::{self, Recovery};
use crate::manifest::Manifest;
use crate::paths::{bundled_runtime, bundled_runtime_dir, data_root, Layout};
use crate::requests::Registry;
use crate::runtime::RuntimeManifest;
use crate::spawn::{mint_token, plan_spawn, SpawnInputs};

/// Which installed model the server is launched on, and where its weights are.
///
/// THE FIRST INSTALLED ENTRY, IN MANIFEST ORDER — which today is the only
/// entry (`manifest.rs` pins one). `llama-server` runs in single-model mode, so
/// this is the model every question is answered by until the server stops;
/// `None` when nothing is installed, which `ensure_started` refuses by name
/// rather than launching a server with nothing to load.
async fn model_to_launch(
    layout: &Layout,
    manifest: &Manifest,
) -> Result<Option<(String, std::path::PathBuf)>> {
    for model in &manifest.models {
        if !crate::install::is_installed(layout, model).await {
            continue;
        }
        let weights = model.weights().ok_or_else(|| {
            Error::ManifestMalformed(format!("model {:?} has no weights artifact", model.id))
        })?;
        return Ok(Some((
            model.id.clone(),
            layout.model_path(&model.id, &weights.file)?,
        )));
    }
    Ok(None)
}

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
    /// Artifact locks, kept APART from `requests` — see `commands::lock_model`.
    model_locks: Registry,
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
    // (`unregistered` lived here: the endpoints lemond refused to register at
    // its last start. There is no registration now — `probe::NotConnected`.)
    /// How many times the daemon has been dropped for a configuration change.
    /// For a test and a diagnostic — see [`InferenceState::reconfigurations`].
    reconfigured: AtomicU64,
    downloads: OnceLock<reqwest::Client>,
    /// The clients an endpoint lookup goes through (`cloud.rs`), built once.
    endpoints_http: OnceLock<crate::cloud::Clients>,
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
        tokio::task::spawn_blocking(move || work(&store))
            .await
            .map_err(|join| Error::Io(std::io::Error::other(join.to_string())))?
    }

    /// How many times [`InferenceState::reconfigure`] has run. For a test and
    /// a diagnostic: it is the only trace a reconfigure leaves when no daemon
    /// was up to be dropped.
    pub fn reconfigurations(&self) -> u64 {
        self.reconfigured.load(Ordering::Relaxed)
    }

    /// The in-flight request registry. Every key in it is CALLER-MINTED.
    pub fn requests(&self) -> &Registry {
        &self.requests
    }

    /// The artifact locks — one per model id, held across an install or a
    /// removal.
    ///
    /// ⚠️ **A SECOND REGISTRY, AND IT USED TO BE THE ONE ABOVE.** `lock_model`
    /// took `requests().begin("model:{id}")`, and its comment argued the prefix
    /// "cannot collide with a minted request id — those are `<kind>-<n>`". That
    /// is true of the ids PAPER mints and says nothing about the ones the
    /// command surface accepts: `request_id` is a caller-supplied string
    /// bounded only by `MAX_REQUEST_ID`, from a webview this crate treats as
    /// untrusted by construction. So a caller could hold `model:<id>` as its
    /// own request id and block that model's install and removal for as long as
    /// it liked — or collide with one in progress and be told its lookup was
    /// busy. Two namespaces in one map is one namespace; separating them is
    /// what makes the comment's claim true rather than aspirational.
    pub fn model_locks(&self) -> &Registry {
        &self.model_locks
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
                .unwrap_or_else(|err| {
                    /* Building fails only if the TLS backend cannot
                     * initialise — practically never. The fallback keeps
                     * downloads possible but LOSES the read timeout and the
                     * user agent, so it does not get to happen silently:
                     * behaviour changing exactly on the exceptional path is
                     * how a stall on a broken network became undiagnosable. */
                    log::warn!(
                        "inference: the download client could not be built ({err}); using a bare client with no read timeout"
                    );
                    reqwest::Client::new()
                })
        })
    }

    /// The clients for an OpenAI-compatible endpoint, built on first use.
    pub fn cloud(&self) -> Result<&crate::cloud::Clients> {
        if let Some(clients) = self.endpoints_http.get() {
            return Ok(clients);
        }
        let clients = crate::cloud::Clients::new()?;
        Ok(self.endpoints_http.get_or_init(|| clients))
    }

    /// The manifest this build ships.
    pub fn manifest(&self) -> Result<Manifest> {
        Manifest::shipped()
    }

    /// Where the runtime is, without starting anything.
    pub async fn status<R: Runtime>(&self, app: &AppHandle<R>) -> RuntimeStatus {
        /* The request is BUILT under the lock and SENT outside it. The
         * health client's timeout is ten seconds, and a status probe that
         * held the daemon mutex across a wedged check queued stop,
         * reconfiguration and every request-builder behind a read-only
         * question — the same trap `inference_resource_usage` already
         * documents at its `health_request` call. */
        let probe = self.daemon.lock().await.as_ref().map(|daemon| {
            let plan = daemon.plan();
            (plan.port, plan.version.clone(), daemon.health_request())
        });
        if let Some((port, version, request)) = probe {
            /* A HELD DAEMON IS NOT A LIVE ONE. This reported `Ready` for
             * anything in the slot and turned a failed health check into an
             * EMPTY VERSION STRING — so a daemon that had crashed read as
             * running with an unknown version, and the settings row said so.
             * A health check that will not answer is the definition of not
             * ready. Found by audit. The version is the pinned llama.cpp
             * build the plan was made from — the server reports none. */
            return match crate::daemon::Daemon::read_health(request).await {
                Ok(health) if health.status == "ok" => RuntimeStatus::Ready { version, port },
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
             * Returning it unconditionally meant a crashed server could
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
        bundled_runtime(app)?;
        let layout = self.layout(app)?.clone();
        /* A MODEL FIRST, before anything is hashed or launched. The server is
         * launched ON a model (single-model mode), so with none installed
         * there is nothing to start — and lemond's answer, a daemon up with
         * nothing to answer with, only moved this refusal to the question. */
        let (model_id, model) = model_to_launch(&layout, &self.manifest()?)
            .await?
            .ok_or(Error::NoModelInstalled)?;
        /* VERIFIED BEFORE EVERY SPAWN, not once at install. The manifest
         * names every file of the staged runtime — `llama-server` and the
         * libraries it loads by name from its own directory — and a byte that
         * differs, a file that is missing, or a file the manifest never heard
         * of refuses the launch and names itself. This is the whole of what
         * stands between the bytes on disk and `exec` (WI-20.24): upstream
         * signs nothing, and a file that was never quarantined is a file
         * Gatekeeper never looks at. */
        let runtime_dir = bundled_runtime_dir(app)?;
        let backend = RuntimeManifest::load(&runtime_dir)
            .await?
            .verify(&runtime_dir)
            .await?;
        /* A DAEMON A PREVIOUS PAPER LEFT RUNNING is collected before a new
         * one is spawned, under the lock this function holds — so the
         * record it reads can only be an earlier process's, never the one a
         * daemon of this process just wrote. `recover_orphans` does the
         * same at launch; whichever runs first finds it (WI-20.23). */
        self.collect_orphans(&layout).await;
        let plan = plan_spawn(&SpawnInputs {
            backend,
            model,
            model_id,
            record_path: layout.daemon_record(),
            port: free_port()?,
            api_key: mint_token(),
        });
        let port = plan.port;
        let daemon = Daemon::start(plan).await?;

        *slot = Some(daemon);
        Ok(port)
    }

    /// Collect a daemon a previous Paper left running, if the record beside
    /// the layout names one that is still ours — see `lineage.rs`.
    ///
    /// Called at launch, from the plugin's setup. Takes the daemon slot and
    /// does nothing when it is occupied: a record on disk while a daemon of
    /// THIS process holds the slot is that daemon's own, and reading it
    /// would kill the runtime the reader is using.
    pub async fn recover_orphans<R: Runtime>(&self, app: &AppHandle<R>) {
        let layout = match self.layout(app) {
            Ok(layout) => layout.clone(),
            Err(err) => {
                log::warn!("inference: no layout to look for an orphaned runtime under: {err}");
                return;
            }
        };
        let slot = self.daemon.lock().await;
        if slot.is_some() {
            return;
        }
        self.collect_orphans(&layout).await;
    }

    /// The half that does the work. Called with the daemon slot LOCKED and
    /// EMPTY, by both entry points.
    async fn collect_orphans(&self, layout: &Layout) {
        let record = layout.daemon_record();
        match lineage::recover(&record, &lineage::OsProcesses, SHUTDOWN_GRACE).await {
            Recovery::Nothing => {}
            Recovery::Stale => log::info!(
                "inference: the runtime record at {} named nothing of ours; removed",
                record.display()
            ),
            Recovery::Collected { pgid, port, forced } => log::warn!(
                "inference: collected a runtime a previous Paper left running — group {pgid}, port {port}{}",
                if forced { ", killed after the grace" } else { "" }
            ),
            // The OS would not enumerate the group, so nothing was signalled
            // and the record stays; the next launch asks again.
            Recovery::Unknown { pgid } => log::warn!(
                "inference: could not tell what is in runtime group {pgid}; the record at {} stays for the next launch",
                record.display()
            ),
        }
    }

    /// Drop a running daemon so the next start is made from what is on disk
    /// now.
    ///
    /// ⚠️ **THE SERVER IS LAUNCHED ON ONE MODEL**, so a model the reader
    /// removed stays loaded — its gigabytes resident, still answering — until
    /// the server stops. `inference_remove_model` calls this. (It was called
    /// for endpoint changes too, while cloud keys rode lemond's environment;
    /// nothing about an endpoint reaches the server now.)
    ///
    /// Stopping rather than restarting: `ensure_started` runs before every
    /// question, so the next use brings it back with the current
    /// configuration, and a settings command does not spend a process launch.
    /// The teardown trips the in-flight tokens, so a reader watching an
    /// answer gets a cancellation rather than a stall — the same contract
    /// every other daemon teardown has.
    pub async fn reconfigure(&self) {
        self.reconfigured.fetch_add(1, Ordering::Relaxed);
        self.take_down().await;
    }

    /// The one teardown, shared by [`Self::reconfigure`] and [`Self::stop`].
    ///
    /// The slot lock is HELD ACROSS the child's shutdown, deliberately. Both
    /// callers used to `take()` and release before awaiting `Daemon::stop`,
    /// and `ensure_started` could spawn a REPLACEMENT while the old teardown
    /// still ran — whose `GroupHold` then removed the daemon record the new
    /// daemon had just written, leaving the new group unrecoverable after a
    /// kill. `ensure_started` already holds the same lock across the whole
    /// start; teardown gets the same discipline. The tokens are tripped
    /// AFTER the slot empties: a request arriving mid-teardown finds
    /// `NotRunning` instead of registering against a process on its way out,
    /// and before the process goes, so a watched answer still ends in a
    /// cancellation rather than a stall.
    async fn take_down(&self) {
        let mut slot = self.daemon.lock().await;
        let taken = slot.take();
        self.requests.cancel_all();
        if let Some(daemon) = taken {
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
        self.take_down().await;
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
    fn a_free_port_is_not_zero() {
        let a = free_port().unwrap();
        let b = free_port().unwrap();
        assert_ne!(a, 0);
        assert_ne!(b, 0);
        /* No cross-call inequality assertion: the OS genuinely may hand the
         * same ephemeral port twice once the first listener closes, so
         * `a != b` would be a flake — and the disjunction that stood here
         * (`a != b || a != 0`) was satisfied by the line above already,
         * asserting nothing. Distinctness is the OS's business; non-zero and
         * bindable is this function's. */
    }

    #[test]
    fn absent_is_a_state_rather_than_an_error() {
        let status = RuntimeStatus::Absent {
            reason: "No runtime at /x/runtime.manifest.json".to_owned(),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "absent");
        assert!(json["reason"]
            .as_str()
            .unwrap()
            .contains("runtime.manifest"));
    }

    #[test]
    fn the_three_runtime_states_are_distinct() {
        let states = [
            RuntimeStatus::Absent {
                reason: String::new(),
            },
            RuntimeStatus::Stopped,
            RuntimeStatus::Ready {
                version: "b10375".to_owned(),
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

    /// Nothing installed is a refusal BY NAME, and the name is the fix: the
    /// server is launched on a model, and lemond's answer — a daemon up with
    /// nothing to load — only moved the failure to the question.
    #[tokio::test]
    async fn with_no_model_installed_there_is_nothing_to_launch() {
        let dir = crate::testutil::ScratchDir::new("state");
        let layout = Layout::under(dir.path());
        layout.ensure().unwrap();
        let manifest = Manifest::shipped().unwrap();
        assert!(model_to_launch(&layout, &manifest).await.unwrap().is_none());
        assert_eq!(Error::NoModelInstalled.kind(), "noModelInstalled");
    }

    /// And an installed one is launched by its WEIGHTS' path, under its id.
    #[tokio::test]
    async fn the_installed_model_is_launched_by_its_weights() {
        let dir = crate::testutil::ScratchDir::new("state");
        let layout = Layout::under(dir.path());
        layout.ensure().unwrap();
        let manifest = Manifest::shipped().unwrap();
        let model = &manifest.models[0];
        let weights = model.weights().unwrap();
        let path = layout.model_path(&model.id, &weights.file).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // `is_installed` checks the size, so a sparse file of the right length
        // stands in for gigabytes this test has no business writing.
        std::fs::File::create(&path)
            .unwrap()
            .set_len(weights.bytes)
            .unwrap();
        assert_eq!(
            model_to_launch(&layout, &manifest).await.unwrap(),
            Some((model.id.clone(), path))
        );
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
