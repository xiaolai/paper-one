//! `tauri-plugin-inference` — Paper's local inference runtime, as a Tauri
//! plugin.
//!
//! What it is (dev-docs/plans/phase-15-the-companion.md, WI-15.0): a supervised
//! `lemond` child, the per-launch bearer token that authenticates to it, the
//! Paper-owned cache and model directories, SHA-256 verification before any
//! artifact is activated, and the probes that report what the two agent CLIs
//! can honestly say about themselves. Policy-free in the same sense the peer
//! plugin is: it knows nothing of books, chapters, citations or the reader's
//! marks, and it never decides which route answers a question.
//!
//! # The contract, and it is one question
//!
//! > **Could untrusted book HTML reach this?**
//! >
//! > **Yes** → it lives here, behind a named command with a declared
//! > permission. Never a general runner, never a credential, never a URL the
//! > caller chooses.
//! > **No — it is a shape the reader sees** → it lives in TypeScript.
//!
//! Everything in this crate is an application of that question. Paper renders
//! EPUB documents written by strangers, and the daemon's control plane
//! (`/v1/install`, `/v1/pull`, `/v1/load`) downloads and executes backend
//! binaries. Handing the webview the bearer token to get native `fetch`
//! streaming would hand book HTML a backend installer, so the token stays
//! here and streaming returns over a Tauri `Channel` instead. That costs an
//! adapter and buys the only boundary that matters.
//!
//! # What it is not
//!
//! Not the `inference` capability. The capability — the state machine, the
//! settings section, the choice of which model answers — is TypeScript, in
//! `src/capabilities/inference/`. This crate holds only what must be held in
//! Rust, and a decision that could be made on either side is made there.
//!
//! Registered from the app's `lib.rs` as
//! `.plugin(tauri_plugin_inference::init())` on desktop only; the ACL grant
//! is `inference:default`.

mod agent;
mod agentask;
mod commands;
mod daemon;
mod digest;
mod endpoints;
mod error;
mod generate;
mod install;
mod limits;
mod lineage;
mod manifest;
mod paths;
mod probe;
mod procgroup;
mod requests;
mod runtime;
mod spawn;
mod speech;
mod state;
#[cfg(test)]
mod testutil;

pub use agent::{Agent, AgentProbe, AGENTS};
pub use daemon::{Daemon, Health};
pub use digest::{promote, sha256_file, verify, Expected};
pub use endpoints::{Endpoint, EndpointStore, KeyState};
pub use error::{Error, Result};
pub use install::Progress;
pub use lineage::{GroupRecord, Processes, Recovery, RECORD_FILE};
pub use manifest::{Manifest, Modality, ModelEntry, MANIFEST_VERSION};
pub use paths::{
    bundled_runtime, bundled_runtime_dir, data_root, runtime_exe_name, Layout, TEST_DATA_DIR_ENV,
};
pub use probe::{Probe, Route, RouteKind};
pub use runtime::{RuntimeManifest, VerifiedBackend, MANIFEST_FILE, RUNTIME_MANIFEST_VERSION};
pub use spawn::{
    backend_bin_var, cloud_key_var, mint_token, plan_spawn, SpawnInputs, SpawnPlan, API_KEY_ENV,
    CACHE_DIR_ENV, LOOPBACK,
};
pub use state::InferenceState;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, RunEvent, Runtime};

/// The plugin. Manages an [`InferenceState`] and stops the daemon on exit.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("inference")
        .invoke_handler(tauri::generate_handler![
            commands::inference_status,
            commands::inference_start,
            commands::inference_stop,
            commands::inference_models,
            commands::inference_install_model,
            commands::inference_remove_model,
            commands::inference_resource_usage,
            commands::inference_reveal_models_dir,
            commands::inference_generate,
            commands::inference_gloss,
            commands::inference_speak,
            commands::inference_probe,
            commands::inference_endpoints,
            commands::inference_add_endpoint,
            commands::inference_remove_endpoint,
            commands::inference_set_endpoint_key,
            commands::agent_ask,
            commands::agent_sign_in,
            commands::inference_cancel,
        ])
        .setup(|app, _api| {
            app.manage(InferenceState::default());
            /* A DAEMON THE LAST PAPER LEFT RUNNING is collected now, at
             * launch, rather than at the first gloss — it is holding the GPU
             * and the model's several gigabytes the whole time in between.
             * Off the main thread: it may wait the shutdown grace on a group
             * that is slow to let go (`lineage.rs`, WI-20.23). */
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                handle
                    .state::<InferenceState>()
                    .recover_orphans(&handle)
                    .await;
            });
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                // A daemon that just loses its parent keeps the port, the
                // model's several gigabytes and the GPU. `Exit` runs on the
                // main thread outside the async runtime, so blocking here is
                // fine — and this is the ORDERED shutdown; `kill_on_drop` and
                // the job object are the backstop under it, not instead of it.
                let state = app.state::<InferenceState>();
                tauri::async_runtime::block_on(state.shutdown());
            }
        })
        .build()
}
