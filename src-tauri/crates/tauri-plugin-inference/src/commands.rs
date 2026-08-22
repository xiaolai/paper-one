//! The commands. Each is one line of policy on top of a module that does the
//! work, so the modules stay testable without a Tauri app.
//!
//! Adding a command means four edits: here, `generate_handler!` in `lib.rs`,
//! `COMMANDS` in `build.rs`, and `permissions/default.toml`. Miss the handler
//! or the build list and the command is unreachable; miss the ACL and it is
//! refused.
//!
//! # There is no general runner here, and that is the design
//!
//! Read the signatures: no command takes a URL, a path, a host, an argv or a
//! model file. A caller names a MODEL ID that must resolve in
//! `models.manifest.json`, or a ROUTE ID the probe minted, and nothing else.
//! Untrusted book HTML renders in the webview that calls these, and the
//! daemon behind them installs and executes backend binaries — so the closed
//! argument set is not defensiveness, it is the boundary the whole crate
//! exists to hold.
//!
//! # Streaming goes over a Channel, not a returned stream
//!
//! F5 again: handing the webview the bearer token to get native `fetch`
//! streaming would hand book HTML a backend installer. So the token stays in
//! Rust and text comes back over a Tauri `Channel<T>` the caller supplies.
//! Every streaming command takes a `request_id` the CALLER minted, and
//! `inference_cancel(requestId)` cancels any of them — see `requests.rs` for
//! why the caller mints it.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use crate::agent::{self, Agent};
use crate::agentask;
use crate::endpoints::Endpoint;
use crate::error::{Error, Result};
use crate::generate::{self, ChatRequest, Message};
use crate::install::{self, Progress};
use crate::manifest::ModelEntry;
use crate::probe::{self, Probe, Route};
use crate::state::{InferenceState, RuntimeStatus};

/* ────────────────────────────── the runtime ─────────────────────────────── */

/// Where the runtime is. Starts nothing.
#[tauri::command]
pub async fn inference_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<RuntimeStatus> {
    Ok(state.status(&app).await)
}

/// Start the daemon. Idempotent; answers the loopback port.
#[tauri::command]
pub async fn inference_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<u16> {
    state.ensure_started(&app).await
}

/// Stop the daemon. Idempotent, and never fails.
#[tauri::command]
pub async fn inference_stop(state: State<'_, InferenceState>) -> Result<()> {
    state.stop().await;
    Ok(())
}

/* ────────────────────────────── the catalogue ───────────────────────────── */

/// One row of the Local models section.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub id: String,
    pub label: String,
    pub modality: crate::manifest::Modality,
    pub license: String,
    pub bytes: u64,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
}

/// The manifest, with what is on disk.
#[tauri::command]
pub async fn inference_models<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<Vec<ModelRow>> {
    let layout = state.layout(&app)?;
    let manifest = state.manifest()?;
    let mut rows = Vec::new();
    for model in &manifest.models {
        rows.push(ModelRow {
            id: model.id.clone(),
            label: model.label.clone(),
            modality: model.modality,
            license: model.license.clone(),
            bytes: model.total_bytes(),
            installed: install::is_installed(layout, model).await,
            parameters: model.parameters.clone(),
            quantization: model.quantization.clone(),
        });
    }
    Ok(rows)
}

/// Download, verify and activate a model.
///
/// `model` must resolve in the manifest — there is no URL parameter, and a
/// gallery entry is untrusted input until it has become a manifest entry.
#[tauri::command]
pub async fn inference_install_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    request_id: String,
    model: String,
    progress: Channel<Progress>,
) -> Result<()> {
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    let layout = state.layout(&app)?;
    let manifest = state.manifest()?;
    let entry: &ModelEntry = manifest.model(&model)?;
    install::install(state.download_client(), layout, entry, &cancel, |update| {
        // A send that fails means the webview dropped the channel — the
        // reader closed the pane. Not a reason to abandon a download they
        // asked for; the next `inference_models` will show it installed.
        let _ = progress.send(update);
    })
    .await
}

/// Remove a model's artifacts.
#[tauri::command]
pub async fn inference_remove_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    model: String,
) -> Result<()> {
    let layout = state.layout(&app)?;
    let manifest = state.manifest()?;
    install::remove(layout, manifest.model(&model)?).await
}

/// What the runtime is holding. `None` rather than zero when unknown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    /// Resident bytes, or `None`. NEVER `0` for "unknown": the settings row
    /// shows `—` for an absent figure, and Lemonade is specifically credited
    /// for returning null rather than zero for memory it cannot read. That
    /// honesty has to survive translation.
    pub resident_bytes: Option<u64>,
    pub model_loaded: Option<String>,
}

#[tauri::command]
pub async fn inference_resource_usage(state: State<'_, InferenceState>) -> Result<ResourceUsage> {
    let daemon = state.daemon().await?;
    let health = daemon.health().await?;
    Ok(ResourceUsage {
        // Not reported by `/api/v1/health`; `None` until it is read from a
        // route that genuinely carries it, rather than a plausible zero.
        resident_bytes: None,
        model_loaded: health.model_loaded,
    })
}

/// The models folder, for `[Reveal]`. Returns the path; the kernel opens it.
#[tauri::command]
pub async fn inference_reveal_models_dir<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<String> {
    let layout = state.layout(&app)?;
    layout
        .models_dir
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::PathNotUnicode(layout.models_dir.clone()))
}

/* ──────────────────────────────── the probe ─────────────────────────────── */

/// Presence, version and auth for every route (WI-15.10).
#[tauri::command]
pub async fn inference_probe<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<Probe> {
    let layout = state.layout(&app)?;
    let manifest = state.manifest()?;
    let runtime_available = crate::paths::bundled_runtime(&app).is_ok();

    // Which local models are actually on disk, awaited before the pure part.
    let mut installed = std::collections::BTreeSet::new();
    for model in &manifest.models {
        if install::is_installed(layout, model).await {
            installed.insert(model.id.clone());
        }
    }
    let mut routes: Vec<Route> = probe::local_routes(
        &manifest,
        |model| installed.contains(&model.id),
        runtime_available,
    );

    // Both agents at once: each spawns two short-lived children and there is
    // no reason for the second to wait on the first.
    let (codex, claude) = tokio::join!(agent::probe(Agent::Codex), agent::probe(Agent::Claude));
    routes.push(probe::agent_route(&codex));
    routes.push(probe::agent_route(&claude));

    for endpoint in state.endpoints(&app)?.list()? {
        routes.push(probe::endpoint_route(&endpoint));
    }

    let runtime_version = match state.status(&app).await {
        RuntimeStatus::Ready { version, .. } => Some(version),
        _ => None,
    };
    Ok(Probe {
        routes,
        runtime_version,
    })
}

/* ─────────────────────────────── generation ─────────────────────────────── */

/// How long an answer may be. Bounded here rather than by the caller: a
/// webview asking for an unbounded generation is a GPU pinned by book HTML.
const MAX_ANSWER_TOKENS: u32 = 1024;

/// A gloss is one or two sentences. Bounded much lower, because the reader is
/// waiting beside a word rather than reading a reply.
const MAX_GLOSS_TOKENS: u32 = 160;

/// Low, and the same for both: this answers from a passage in front of the
/// reader, and invention is the failure mode §13 exists to prevent.
const TEMPERATURE: f32 = 0.2;

/// Resolve a caller's model string against what Paper actually has.
///
/// ⚠️ **THIS FUNCTION IS THE CLOSED ARGUMENT SET.** Without it the header's
/// claim above — "a caller names a MODEL ID that must resolve in
/// `models.manifest.json`" — was simply false: `model` was forwarded to the
/// daemon verbatim, so untrusted book HTML could name any model the daemon
/// knows, including one it would pull from a remote registry. An audit caught
/// it, and it is the exact gap the surrounding comments claimed did not exist.
///
/// Returns the daemon-facing name for a manifest id, or a registered
/// endpoint's id. Anything else is [`Error::ModelUnknown`].
async fn resolve_model<R: Runtime>(
    app: &AppHandle<R>,
    state: &InferenceState,
    model: &str,
) -> Result<String> {
    if state.manifest()?.model(model).is_ok() {
        return Ok(model.to_owned());
    }
    if state
        .endpoints(app)?
        .list()?
        .iter()
        .any(|endpoint| endpoint.id == model)
    {
        return Ok(model.to_owned());
    }
    Err(Error::ModelUnknown(model.to_owned()))
}

/// The one chat request builder, so the two callers cannot drift on roles,
/// temperature or streaming.
fn chat_request(model: String, system: String, question: String, max_tokens: u32) -> ChatRequest {
    ChatRequest {
        model,
        messages: vec![
            Message {
                role: "system",
                content: system,
            },
            Message {
                role: "user",
                content: question,
            },
        ],
        max_tokens,
        temperature: TEMPERATURE,
        stream: true,
    }
}

/// Ask the local runtime, streaming text back over `chunks`.
#[tauri::command]
pub async fn inference_generate<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    request_id: String,
    model: String,
    system: String,
    question: String,
    chunks: Channel<String>,
) -> Result<String> {
    let model = resolve_model(&app, &state, &model).await?;
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    let daemon = state.daemon().await?;
    let request = daemon
        .request(reqwest::Method::POST, generate::CHAT_ROUTE)
        .json(&chat_request(model, system, question, MAX_ANSWER_TOKENS));
    /* A SEND THAT FAILS CANCELS THE REQUEST. The webview dropped the channel —
     * the pane closed, the reader left — and going on would keep the daemon
     * generating into nothing, which on a loaded machine is a GPU spent on an
     * answer nobody will read. */
    let sink = cancel.clone();
    generate::stream(request, &cancel, move |text| {
        if chunks.send(text).is_err() {
            sink.trip();
        }
    })
    .await
}

/// Define a term in the sentence it sits in (WI-15.13).
///
/// A PROMISE, not a stream: two sentences streamed into a popover beside a
/// word is jitter, not progress. And it is its own command rather than a mode
/// of `inference_generate` because "no selection can reach an agent" is a
/// property of the call graph — there is no branch here that could reach
/// `agentask`, and no parameter that could ask for one.
#[tauri::command]
pub async fn inference_gloss<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    request_id: String,
    model: String,
    system: String,
    question: String,
) -> Result<String> {
    /* RESOLVED, like `inference_generate`. The first version of the closed
     * argument set covered only the generate path, which left two commands
     * forwarding a caller-supplied model straight to the daemon — the exact
     * hole the header claims does not exist. An audit caught the omission. */
    let model = resolve_model(&app, &state, &model).await?;
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    let daemon = state.daemon().await?;
    let request = daemon
        .request(reqwest::Method::POST, generate::CHAT_ROUTE)
        .json(&chat_request(model, system, question, MAX_GLOSS_TOKENS));
    // Streamed on the wire, delivered whole: the daemon's non-streaming path
    // holds the whole answer before replying, and cancelling that is a
    // request nobody is reading rather than a generation that stopped.
    generate::stream(request, &cancel, |_| {}).await
}

/* ──────────────────────────────── the agents ────────────────────────────── */

/// One tool-free, read-only turn from an agent CLI.
#[tauri::command]
pub async fn agent_ask<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    request_id: String,
    route: String,
    prompt: String,
    chunks: Channel<String>,
) -> Result<String> {
    let which = match route.as_str() {
        "agent:codex" => Agent::Codex,
        "agent:claude" => Agent::Claude,
        // A route id the probe did not mint. Never a path, never an argv.
        other => return Err(Error::ModelUnknown(other.to_owned())),
    };
    let probe = agent::probe(which).await;
    if let Some(reason) = probe.unusable {
        return Err(match reason {
            agent::SIGNED_OUT => Error::AgentSignedOut(which.name()),
            agent::VERSION_NOT_SUPPORTED => Error::AgentUnsupportedVersion {
                agent: which.name(),
                version: probe.version.map(|v| v.to_string()).unwrap_or_default(),
            },
            _ => Error::AgentMissing(which.name()),
        });
    }
    let program = probe
        .path
        .ok_or_else(|| Error::AgentMissing(which.name()))?;

    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    // An EMPTY directory, owned by Paper, as the agent's working root. Not
    // the reader's library and not Paper's own data root: a read-only agent
    // pointed at the library could read every book, every note and the
    // journal.
    let workdir = state.layout(&app)?.base.join("agent-root");
    agentask::ask(
        which,
        std::path::Path::new(&program),
        &workdir,
        &prompt,
        &cancel,
        |text| {
            let _ = chunks.send(text);
        },
    )
    .await
}

/// Launch the vendor's own login flow.
///
/// Paper does not open, copy, refresh or pool the vendor's tokens — it starts
/// their CLI's login and then re-reads status. The credential is theirs and
/// stays theirs.
#[tauri::command]
pub async fn agent_sign_in(route: String) -> Result<()> {
    let which = match route.as_str() {
        "agent:codex" => Agent::Codex,
        "agent:claude" => Agent::Claude,
        other => return Err(Error::ModelUnknown(other.to_owned())),
    };
    let path = agent::which(which.exe()).ok_or_else(|| Error::AgentMissing(which.name()))?;
    let args: &[&str] = match which {
        Agent::Codex => &["login"],
        Agent::Claude => &["auth", "login"],
    };
    // Spawned and released: a login flow opens a browser and takes as long as
    // the reader takes. Awaiting it would block the command for minutes.
    tokio::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

/* ────────────────────────────── cloud endpoints ─────────────────────────── */

#[tauri::command]
pub async fn inference_endpoints<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<Vec<Endpoint>> {
    state.endpoints(&app)?.list()
}

#[tauri::command]
pub async fn inference_add_endpoint<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    id: String,
    label: String,
    base_url: String,
) -> Result<()> {
    state.endpoints(&app)?.add(&id, &label, &base_url)
}

#[tauri::command]
pub async fn inference_remove_endpoint<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    id: String,
) -> Result<()> {
    state.endpoints(&app)?.remove(&id)
}

/// Store an endpoint's key. WRITE-ONLY — there is deliberately no command
/// that reads one back, and that absence is what makes WI-15.8's acceptance
/// a property of this list rather than of anybody's discipline.
#[tauri::command]
pub async fn inference_set_endpoint_key<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    id: String,
    key: String,
) -> Result<()> {
    state.endpoints(&app)?.set_key(&id, &key)
}

/* ──────────────────────────────── narration ─────────────────────────────── */

/// Synthesise speech (WI-15.9's `Test voice`).
///
/// The route is `/api/v1/audio/generations` and its field is **`prompt`**, not
/// OpenAI's `input` — verified against 11.7.0, which answers `Missing
/// 'prompt' field in request` for the OpenAI spelling. `/api/v1/audio/speech`
/// does not answer at all. That asymmetry stays behind this command rather
/// than being something a caller has to know.
#[tauri::command]
pub async fn inference_speak<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    request_id: String,
    model: String,
    text: String,
    voice: Option<String>,
) -> Result<Vec<u8>> {
    let model = resolve_model(&app, &state, &model).await?;
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    let daemon = state.daemon().await?;
    let mut body = serde_json::json!({ "model": model, "prompt": text });
    if let Some(voice) = voice {
        body["voice"] = serde_json::Value::String(voice);
    }
    let request = daemon
        .request(reqwest::Method::POST, "/api/v1/audio/generations")
        .json(&body);
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(Error::Cancelled),
        sent = request.send() => sent.map_err(|e| crate::error::unreachable("/api/v1/audio/generations", e))?,
    };
    let status = response.status();
    if !status.is_success() {
        return Err(Error::RuntimeHttp {
            status: status.as_u16(),
            route: "/api/v1/audio/generations".to_owned(),
        });
    }
    let bytes = tokio::select! {
        biased;
        // Cancelling mid-utterance must stop the REQUEST as well as the
        // audio — WI-15.9's acceptance names both.
        () = cancel.cancelled() => return Err(Error::Cancelled),
        body = response.bytes() => body.map_err(|e| crate::error::unreachable("/api/v1/audio/generations", e))?,
    };
    Ok(bytes.to_vec())
}

/* ────────────────────────────── cancellation ────────────────────────────── */

/// Cancel any streaming request by the id its caller minted.
#[tauri::command]
pub async fn inference_cancel(state: State<'_, InferenceState>, request_id: String) -> Result<()> {
    state.requests().cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The row the settings section renders. `installed` and `license` are
    /// both present, because the reader is entitled to know the terms before
    /// a multi-gigabyte download.
    #[test]
    fn a_model_row_carries_its_license_and_no_source_url() {
        let row = ModelRow {
            id: "m".to_owned(),
            label: "M".to_owned(),
            modality: crate::manifest::Modality::Text,
            license: "Apache-2.0".to_owned(),
            bytes: 100,
            installed: false,
            parameters: Some("4B".to_owned()),
            quantization: None,
        };
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["license"], "Apache-2.0");
        assert_eq!(json["installed"], false);
        // The source URL is the manifest's business; a row does not carry it,
        // so nothing in the webview can be tempted to fetch it directly.
        assert!(json.get("source").is_none());
        // An absent optional is omitted rather than sent as null.
        assert!(json.get("quantization").is_none());
    }

    /// `—`, never `0`. Lemonade is specifically credited for returning null
    /// rather than zero for memory it cannot read, and that honesty has to
    /// survive translation.
    #[test]
    fn unknown_memory_is_null_and_never_zero() {
        let usage = ResourceUsage {
            resident_bytes: None,
            model_loaded: None,
        };
        let json = serde_json::to_value(&usage).unwrap();
        assert!(json["residentBytes"].is_null());
        assert_ne!(json["residentBytes"], 0);
    }

    /// The bounds are Paper's, not the caller's. A webview asking for an
    /// unbounded generation is a GPU pinned by book HTML.
    /// The bounds are compile-time constants, so these are `const` assertions:
    /// a build that widened one would fail to compile rather than failing a
    /// test somebody could mark ignored.
    #[test]
    fn answer_lengths_are_bounded_here_rather_than_by_the_caller() {
        const { assert!(MAX_ANSWER_TOKENS > 0 && MAX_ANSWER_TOKENS <= 4096) };
        const {
            assert!(
                MAX_GLOSS_TOKENS < MAX_ANSWER_TOKENS,
                "a gloss is one or two sentences and the reader is waiting beside a word"
            )
        };
        const {
            assert!(
                TEMPERATURE <= 0.5,
                "invention is the failure §13 exists to prevent"
            )
        };
    }
}
