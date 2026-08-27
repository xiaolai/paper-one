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
use crate::endpoints::{Endpoint, EndpointStore};
use crate::error::{Error, Result};
use crate::generate::{self, ChatRequest, Message};
use crate::install::{self, Progress};
use crate::limits;
use crate::manifest::ModelEntry;
use crate::probe::{self, Probe, Route};
use crate::speech;
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
/// A lock on one model's artifacts, held for as long as the guard lives.
///
/// SERIALISED BY WHAT IS WRITTEN, not by who asked. `begin` keys on the
/// caller's `request_id`, which only stops the same request twice — so two
/// installs of the SAME model under different ids both ran, both fetched, and
/// both wrote the staging path derived from that model's id. A remove could
/// land in the middle of either, because it carries no request id at all.
///
/// The registry is reused rather than a second map introduced: the guard's
/// `Drop` already releases on every exit path, including a cancellation and a
/// panic, which is the property that makes this safe to hold across an await.
/// The `model:` prefix cannot collide with a minted request id — those are
/// `<kind>-<n>` — and the busy error names the model rather than the key.
fn lock_model(state: &InferenceState, model: &str) -> Result<crate::requests::Guard> {
    state
        .requests()
        .begin(&format!("model:{model}"))
        .map_err(|_| Error::RequestBusy(model.to_owned()))
}

#[tauri::command]
pub async fn inference_install_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    request_id: String,
    model: String,
    progress: Channel<Progress>,
) -> Result<()> {
    limits::within("request id", &request_id, limits::MAX_REQUEST_ID)?;
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    /* Held for the whole download, so a second install of this model — or a
     * remove of it — waits rather than writing the same staging path. */
    let _artifacts = lock_model(&state, &model)?;
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
    /* THE SAME LOCK THE INSTALL TAKES. Removing a model's artifacts while
     * they are being fetched is the same collision from the other side, and
     * this command carries no request id to have been serialised by. */
    let _artifacts = lock_model(&state, &model)?;
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
    /// Which model is resident, as a MANIFEST ID — never the daemon's own
    /// string.
    ///
    /// ⚠️ **THE DAEMON'S MODEL FIELDS CARRY ABSOLUTE ARTIFACT PATHS**, which
    /// is documented in `daemon.rs` and is why this used to hand the webview a
    /// path under the reader's home directory. The webview renders untrusted
    /// book HTML; `agentask.rs` drops paths at its parse boundary for exactly
    /// this reason, and a health reading is not an exemption from it.
    ///
    /// So the daemon's answer is matched against the catalogue and the
    /// catalogue's id is what crosses. Anything that matches nothing is
    /// `None`: an unrecognised string is not a fact worth leaking to say.
    pub model_loaded: Option<String>,
}

#[tauri::command]
pub async fn inference_resource_usage<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<ResourceUsage> {
    /* The guard is dropped before the request, as in `inference_generate` —
    otherwise a memory reading blocks behind whatever is streaming. */
    let request = {
        let daemon = state.daemon().await?;
        daemon.health_request()
    };
    let health = crate::daemon::Daemon::read_health(request).await?;
    let _ = &app;
    Ok(ResourceUsage {
        // Not reported by `/api/v1/health`; `None` until it is read from a
        // route that genuinely carries it, rather than a plausible zero.
        resident_bytes: None,
        model_loaded: health
            .model_loaded
            .and_then(|loaded| manifest_id_for(&state, &loaded)),
    })
}

/// The manifest id whose artifacts the daemon's `model_loaded` string names.
///
/// Matched by SHAPE rather than by equality, because the daemon answers with
/// whatever it was handed — a path, a file name, or the id — and only one of
/// those is safe to forward. `None` when nothing matches.
fn manifest_id_for(state: &InferenceState, loaded: &str) -> Option<String> {
    let manifest = state.manifest().ok()?;
    manifest
        .models
        .iter()
        .find(|model| {
            loaded == model.id
                || model
                    .artifacts
                    .iter()
                    .any(|artifact| loaded.ends_with(&artifact.file))
        })
        .map(|model| model.id.clone())
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

    /* Whether the DAEMON took each one, which is a separate fact from whether
    Paper has it stored — see `UnusableReason::NotRegistered`. */
    let unregistered = state.unregistered().await;
    for endpoint in state.endpoints(&app)?.list()? {
        let registered = !unregistered.contains(&endpoint.id);
        routes.push(probe::endpoint_route(&endpoint, registered));
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
/// # Membership is not usability, and it is not modality
///
/// ⚠️ The first version checked only that the string appeared in the catalogue,
/// which is three separate holes at once:
///
/// - **an uninstalled model resolved.** `inference_probe` reports it as
///   `notInstalled` and the pane offers `[Install]`, and this said yes to it —
///   so a caller bypassing the pane reached the daemon with a model whose
///   artifacts are not on disk, and got a load failure instead of a refusal.
/// - **a keyless endpoint resolved.** The probe marks it `noKey` for the same
///   reason and this did not, so the request went out to be rejected upstream.
/// - **the modality was never checked.** A speech model resolved for
///   `inference_generate` and a text model for `inference_speak`. Untrusted
///   book HTML naming a voice as its answering model is not a hypothetical:
///   the whole point of the closed set is that the caller is not trusted.
///
/// So the check is the same one the probe publishes — `usable()` — rather than
/// a second, laxer opinion sitting behind it. One decision, two readers.
///
/// Still `async`, and now for a reason: the audit's note that this awaited
/// nothing was true of the membership check it replaces. Asking whether a
/// model's artifacts are on disk is a filesystem read, and doing it with
/// `tokio::fs` rather than a blocking twin keeps it off the runtime's thread.
async fn resolve_model<R: Runtime>(
    app: &AppHandle<R>,
    state: &InferenceState,
    model: &str,
    wanted: probe::Modality,
) -> Result<String> {
    let route = route_for(app, state, model).await?;
    if !route.usable() {
        /* The reason is already the reader's sentence, and the pane draws the
        action that fixes it — this only has to refuse. */
        return Err(Error::ModelUnknown(model.to_owned()));
    }
    if route.modality != wanted {
        return Err(Error::ModelUnknown(model.to_owned()));
    }
    Ok(model.to_owned())
}

/// The probe's own row for `model`, built the same way `inference_probe` does.
///
/// ⚠️ **ONE SELECTION ABSTRACTION, NOT TWO.** `Route::usable` existed and was
/// used only by this crate's tests, while the commands re-implemented a laxer
/// membership check and the TypeScript re-implemented usability a third time.
/// Three opinions about "can this answer" is two too many, and the one that
/// gated the actual request was the weakest of them.
async fn route_for<R: Runtime>(
    app: &AppHandle<R>,
    state: &InferenceState,
    model: &str,
) -> Result<probe::Route> {
    let manifest = state.manifest()?;
    if let Ok(entry) = manifest.model(model) {
        let layout = state.layout(app)?;
        let runtime_available = crate::paths::bundled_runtime(app).is_ok();
        let installed = install::is_installed(layout, entry).await;
        return probe::local_routes(
            &manifest,
            |m| m.id == entry.id && installed,
            runtime_available,
        )
        .into_iter()
        .find(|route| route.id == probe::local_route_id(model))
        .ok_or_else(|| Error::ModelUnknown(model.to_owned()));
    }
    /* The daemon's own verdict, so a route it refused is refused here too
    rather than reaching it a second time to be refused again. */
    let unregistered = state.unregistered().await;
    state
        .endpoints(app)?
        .list()?
        .iter()
        .find(|endpoint| endpoint.id == model)
        .map(|endpoint| probe::endpoint_route(endpoint, !unregistered.contains(&endpoint.id)))
        .ok_or_else(|| Error::ModelUnknown(model.to_owned()))
}

/// Which agent a route id names. The ids are the probe's own, never a path.
///
/// One function rather than the two verbatim copies this replaces: `agent_ask`
/// and `agent_sign_in` each spelled the match out, including the error
/// conversion, so a third agent — or a different spelling — would have had to
/// be added in both.
fn parse_agent_route(route: &str) -> Result<Agent> {
    match route {
        "agent:codex" => Ok(Agent::Codex),
        "agent:claude" => Ok(Agent::Claude),
        // A route id the probe did not mint. Never a path, never an argv.
        other => Err(Error::ModelUnknown(other.to_owned())),
    }
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
    /* BOUNDED BEFORE ANYTHING IS ALLOCATED, REGISTERED OR SENT. A closed
     * command surface bounds which verbs a webview can reach; it says nothing
     * about how much can be pushed through one. See `limits.rs`. */
    limits::within("request id", &request_id, limits::MAX_REQUEST_ID)?;
    limits::within("system prompt", &system, limits::MAX_SYSTEM)?;
    limits::within("question", &question, limits::MAX_QUESTION)?;
    let model = resolve_model(&app, &state, &model, probe::Modality::Text).await?;
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    /* ⚠️ THE DAEMON LOCK IS DROPPED BEFORE THE NETWORK WAIT. `state.daemon()`
     * hands back a mapped mutex guard, and holding it across a streamed
     * generation serialised every other daemon command behind this one — the
     * status poll, the memory reading, a voice test, a second question. A
     * `RequestBuilder` owns its client, so the guard is needed only to build
     * it. */
    let request = {
        let daemon = state.daemon().await?;
        daemon
            .model_request(reqwest::Method::POST, generate::CHAT_ROUTE)
            .json(&chat_request(model, system, question, MAX_ANSWER_TOKENS))
    };
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
    limits::within("request id", &request_id, limits::MAX_REQUEST_ID)?;
    limits::within("system prompt", &system, limits::MAX_SYSTEM)?;
    limits::within("question", &question, limits::MAX_QUESTION)?;
    /* RESOLVED, like `inference_generate`. The first version of the closed
     * argument set covered only the generate path, which left two commands
     * forwarding a caller-supplied model straight to the daemon — the exact
     * hole the header claims does not exist. An audit caught the omission. */
    let model = resolve_model(&app, &state, &model, probe::Modality::Text).await?;
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    /* Dropped before the wait, as in `inference_generate` — see there. */
    let request = {
        let daemon = state.daemon().await?;
        daemon
            .model_request(reqwest::Method::POST, generate::CHAT_ROUTE)
            .json(&chat_request(model, system, question, MAX_GLOSS_TOKENS))
    };
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
    // The reader's Faster / More thorough choice, from a closed set. `None`
    // — an older caller, or one that does not care — reads as their account
    // default, which is the only honest reading of "not asked".
    depth: Option<crate::agentask::Depth>,
    chunks: Channel<String>,
) -> Result<String> {
    limits::within("request id", &request_id, limits::MAX_REQUEST_ID)?;
    limits::within("prompt", &prompt, limits::MAX_AGENT_PROMPT)?;
    let which = parse_agent_route(&route)?;
    /* REGISTERED BEFORE THE PROBE, and the probe races cancellation.
     *
     * `agent::probe` spawns up to two child processes with a five-second
     * timeout each, and registration used to happen after it. A reader who
     * pressed Stop during that window cancelled a request id nothing had
     * begun — the cancel answered `RequestUnknown` and the turn then started
     * anyway, on their subscription. The guard has to exist before the first
     * slow await, not before the spawn. */
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    let probe = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(Error::Cancelled),
        probed = agent::probe(which) => probed,
    };
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
        depth.unwrap_or_default(),
        &cancel,
        {
            /* ⚠️ A SEND THAT FAILS CANCELS THE TURN, as it already did on the
             * local path. The webview dropped the channel — the pane closed,
             * the reader left — and swallowing that kept an agent CLI running
             * to the end of its turn. On a subscription route that is not a
             * wasted GPU cycle but a turn the reader has PAID for, spent on an
             * answer nobody will read. */
            let sink = cancel.clone();
            move |text| {
                if chunks.send(text).is_err() {
                    sink.trip();
                }
            }
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
    let which = parse_agent_route(&route)?;
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

/// Run one endpoint-store operation off the async runtime.
///
/// ⚠️ **THE STORE IS BLOCKING, AND SO IS THE KEYCHAIN.** `read`/`write` are
/// `std::fs`, and every key operation goes through the OS keychain, which on
/// macOS can put a modal prompt in front of the reader — an unbounded wait on
/// a tokio worker thread. Calling either straight from an `async` command
/// stalls the runtime, and with it every other command, the daemon's health
/// poll and any streaming answer.
async fn on_store<R, T>(
    app: &AppHandle<R>,
    state: &InferenceState,
    work: impl FnOnce(&EndpointStore) -> Result<T> + Send + 'static,
) -> Result<T>
where
    R: Runtime,
    T: Send + 'static,
{
    // Cloned rather than borrowed: `spawn_blocking` needs `'static`, and the
    // store is a path.
    let store = state.endpoints(app)?.clone();
    tokio::task::spawn_blocking(move || work(&store))
        .await
        .map_err(|join| Error::Io(std::io::Error::other(join.to_string())))?
}

#[tauri::command]
pub async fn inference_endpoints<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<Vec<Endpoint>> {
    on_store(&app, &state, |store| store.list()).await
}

#[tauri::command]
pub async fn inference_add_endpoint<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    id: String,
    label: String,
    base_url: String,
) -> Result<()> {
    /* ⚠️ ONE WRITER AT A TIME. `add` and `remove` read the list, edit it and
     * write it back through the same temporary path; nothing serialised them
     * and `#[tauri::command]`s run concurrently, so two at once lose an edit
     * or rename a half-written file over the reader's only copy. */
    let _writing = state.endpoint_writes().lock().await;
    on_store(&app, &state, move |store| store.add(&id, &label, &base_url)).await?;
    /* The daemon takes its keys and its provider registrations at spawn, so a
     * running one knows nothing about this until it is restarted. */
    state.reconfigure().await;
    Ok(())
}

#[tauri::command]
pub async fn inference_remove_endpoint<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    id: String,
) -> Result<()> {
    let _writing = state.endpoint_writes().lock().await;
    on_store(&app, &state, move |store| store.remove(&id)).await?;
    /* ⚠️ AND THIS IS THE HALF THAT MATTERS. Without it a key the reader
     * deleted stayed live in the running child's environment, with its
     * provider still registered, until the app was next launched. */
    state.reconfigure().await;
    Ok(())
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
    let _writing = state.endpoint_writes().lock().await;
    on_store(&app, &state, move |store| store.set_key(&id, &key)).await?;
    // A changed key is a changed spawn environment; an empty one is a clear.
    state.reconfigure().await;
    Ok(())
}

/* ──────────────────────────────── narration ─────────────────────────────── */

/// Synthesise speech (WI-15.9's `Test voice`).
///
/// The route, its one surprising field name and the cancellation are
/// `speech.rs`'s; what is left here is the policy every command in this module
/// is supposed to be.
#[tauri::command]
pub async fn inference_speak<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    request_id: String,
    model: String,
    text: String,
    voice: Option<String>,
) -> Result<Vec<u8>> {
    limits::within("request id", &request_id, limits::MAX_REQUEST_ID)?;
    limits::within("speech text", &text, limits::MAX_SPEECH_TEXT)?;
    /* SPEECH, and this is where the modality check earns itself: without it a
     * caller could name the text model here and the answering model in
     * `inference_generate` could be a voice. */
    let model = resolve_model(&app, &state, &model, probe::Modality::Speech).await?;
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    let body = speech::body(&model, &text, voice.as_deref());
    /* Dropped before the wait, as in `inference_generate` — see there. */
    let request = {
        let daemon = state.daemon().await?;
        daemon
            .model_request(reqwest::Method::POST, speech::SPEECH_ROUTE)
            .json(&body)
    };
    /* THE TRANSPORT IS `speech`'s. This command is policy — bound the input,
    resolve the model at the right modality, take the request slot — and
    everything after it was HTTP, which is what `commands.rs`'s own header
    says does not live here. */
    speech::collect(request, &cancel).await
}

/* ────────────────────────────── cancellation ────────────────────────────── */

/// Cancel any streaming request by the id its caller minted.
#[tauri::command]
pub async fn inference_cancel(state: State<'_, InferenceState>, request_id: String) -> Result<()> {
    limits::within("request id", &request_id, limits::MAX_REQUEST_ID)?;
    state.requests().cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every accepted route id, and a sample of the rejected ones.
    ///
    /// One function rather than the two verbatim matches this replaces —
    /// `agent_ask` and `agent_sign_in` each spelled it out, error conversion
    /// included, so a third agent would have had to be added in both and a
    /// drift between them would have been invisible.
    #[test]
    fn only_the_probe_s_own_agent_ids_are_accepted() {
        assert_eq!(parse_agent_route("agent:codex").unwrap(), Agent::Codex);
        assert_eq!(parse_agent_route("agent:claude").unwrap(), Agent::Claude);
        /* EVERY AGENT HAS ONE. A new variant with no arm here would fail this
        rather than silently becoming unreachable from the commands. */
        for agent in crate::agent::AGENTS {
            let id = crate::probe::agent_route_id(agent);
            assert_eq!(parse_agent_route(&id).unwrap(), agent, "{id}");
        }
    }

    /// ⚠️ NEVER A PATH, NEVER AN ARGV. The route string comes from a webview
    /// that renders untrusted book HTML, and what it names is a program to
    /// execute.
    #[test]
    fn anything_the_probe_did_not_mint_is_refused() {
        for bad in [
            "",
            "codex",
            "agent:",
            "agent:codex ",
            "AGENT:CODEX",
            "/usr/local/bin/codex",
            "agent:codex; rm -rf /",
            "local:qwen",
            "endpoint:proxy",
        ] {
            assert!(
                matches!(parse_agent_route(bad), Err(Error::ModelUnknown(_))),
                "{bad:?} was accepted as an agent route"
            );
        }
    }

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
