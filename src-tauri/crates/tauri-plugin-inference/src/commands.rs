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
//! commands start processes and spend the reader's GPU — so the closed
//! argument set is not defensiveness, it is the boundary the whole crate
//! exists to hold.
//!
//! # Streaming goes over a Channel, not a returned stream
//!
//! F5 again: handing the webview the key to get native `fetch` streaming would
//! hand book HTML the reader's model. So the key stays in Rust and text comes
//! back over a Tauri `Channel<T>` the caller supplies.
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
use crate::limits;
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

/// Start the server on the installed model. Idempotent; answers the loopback
/// port. With no model installed, `NoModelInstalled` — there is nothing to
/// launch it on.
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
/// ⚠️ **ITS OWN REGISTRY, AND IT USED TO SHARE THE REQUEST ONE.** This said
/// "the `model:` prefix cannot collide with a minted request id — those are
/// `<kind>-<n>`", which is a fact about the ids PAPER mints and not about the
/// ones this command surface ACCEPTS: `request_id` arrives from the webview
/// bounded only by `MAX_REQUEST_ID`, and this crate's whole premise is that the
/// webview is untrusted. A caller passing `model:<id>` as its own request id
/// held that model's install and removal for as long as it kept the request
/// open, and an install in progress made a lookup under the same string answer
/// "already running". Two namespaces in one map is one namespace — see
/// `InferenceState::model_locks`.
///
/// The registry TYPE is still reused rather than a bespoke lock: the guard's
/// `Drop` already releases on every exit path, including a cancellation and a
/// panic, which is the property that makes this safe to hold across an await.
/// The busy error names the model rather than the key.
fn lock_model(state: &InferenceState, model: &str) -> Result<crate::requests::Guard> {
    state
        .model_locks()
        .begin(model)
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
    limits::within("model id", &model, limits::MAX_MODEL_ID)?;
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
    /* BOUNDED BEFORE THE LOCK KEY IS BUILT FROM IT. `lock_model` formats the
     * id into `model:{model}` and a refusal copies it again into
     * `RequestBusy` — both happen before `manifest.model(&model)` gets to say
     * it is not a model at all. Missed when the other model commands were
     * bounded, because this one reads as a delete rather than as a command
     * that takes a string. */
    limits::within("model id", &model, limits::MAX_MODEL_ID)?;
    /* THE SAME LOCK THE INSTALL TAKES. Removing a model's artifacts while
     * they are being fetched is the same collision from the other side, and
     * this command carries no request id to have been serialised by. */
    let _artifacts = lock_model(&state, &model)?;
    let layout = state.layout(&app)?;
    let manifest = state.manifest()?;
    let entry = manifest.model(&model)?;
    /* ⚠️ THE SERVER STOPS FIRST, THEN THE FILE GOES. It is launched on this
     * model and maps its weights, so removing the file under it left the
     * gigabytes resident and still answering — and on Windows the delete
     * itself fails, because a file another process has mapped cannot be
     * removed there. Stopping is cheap: the next question starts it again,
     * and with nothing installed that start refuses by name. */
    state.reconfigure().await;
    install::remove(layout, entry).await
}

/// What the runtime is holding. `None` rather than zero when unknown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    /// Resident bytes, or `None`. NEVER `0` for "unknown": the settings row
    /// shows `—` for an absent figure, and a plausible zero is a lie the
    /// reader cannot catch.
    pub resident_bytes: Option<u64>,
    /// Which model is resident, as a MANIFEST ID — the one the server was
    /// launched on, while it answers `ok`.
    ///
    /// ⚠️ **NEVER A STRING THE SERVER REPORTS.** lemond's model fields carried
    /// the artifact's absolute path, which put the reader's home directory in
    /// front of a webview that renders untrusted book HTML; this matched that
    /// string back against the catalogue to avoid it. The server is launched
    /// on a model by manifest id now (`--alias`), so the id is simply known —
    /// nothing the server says is forwarded at all.
    pub model_loaded: Option<String>,
}

#[tauri::command]
pub async fn inference_resource_usage(state: State<'_, InferenceState>) -> Result<ResourceUsage> {
    /* The guard is dropped before the request, as in `inference_generate` —
    otherwise a memory reading blocks behind whatever is streaming. */
    let (request, launched_on) = {
        let daemon = state.daemon().await?;
        (daemon.health_request(), daemon.plan().model_id.clone())
    };
    let health = crate::daemon::Daemon::read_health(request).await?;
    Ok(ResourceUsage {
        // Not reported by `/health`; `None` until it is read from a route that
        // genuinely carries it, rather than a plausible zero.
        resident_bytes: None,
        model_loaded: (health.status == "ok").then_some(launched_on),
    })
}

/// The models folder. Returns the path; the caller decides what to do with it.
///
/// ⚠️ **THIS SAID "for `[Reveal]`", AND THERE IS NO SUCH CONTROL.** Its one
/// caller is `modelsModel.ts`, whose value `ModelsPane.tsx` draws as static
/// text beside "Memory" — nothing anywhere calls an opener, and the command's
/// name promises an action it does not perform. Kept because the PATH is what
/// the pane shows; renaming it is a wire change and would need the four command
/// lists moved together.
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

    /* Each one usable when its key and model name are in place — see
    `probe::endpoint_route`. The list reads the keychain once per endpoint, so
    it goes through the blocking seam like every other store call (WI-20.20). */
    for endpoint in state.on_store(&app, |store| store.list()).await? {
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
///
/// ⚠️ **THE REPLY IS JSON NOW, AND JSON COSTS TOKENS PROSE DID NOT** — keys,
/// quotes, and the indentation the grammar lets the model write between them.
/// Measured 2026-09-18 with the default prompt and `gloss::response_format`, 3
/// terms × 3 runs: one language used 51–56 tokens, two used 60–90, and all 27
/// finished `stop`. So the bound still has 70 tokens in hand and did not move.
/// What CAN reach it is a reader's own prompt asking for more (three senses,
/// measured: one of three replies spent its budget on tabs and ended `length`)
/// — and that ends in `AnswerTruncated`, a named refusal, never a fragment.
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
/// # Membership is not usability
///
/// ⚠️ The first version checked only that the string appeared in the catalogue,
/// which was three separate holes at once:
///
/// - **an uninstalled model resolved.** `inference_probe` reports it as
///   `notInstalled` and the pane offers `[Install]`, and this said yes to it —
///   so a caller bypassing the pane reached the daemon with a model whose
///   artifacts are not on disk, and got a load failure instead of a refusal.
/// - **a keyless endpoint resolved.** The probe marks it `noKey` for the same
///   reason and this did not, so the request went out to be rejected upstream.
/// - **the modality was never checked.** A speech model resolved for
///   `inference_generate`, and a text model for the speech command. That hole
///   closed twice: a check here, and then the speech model and its command
///   going altogether (2026-09-18), so every model is a text model.
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
) -> Result<String> {
    let route = route_for(app, state, model).await?;
    if !route.usable() {
        /* The reason is already the reader's sentence, and the pane draws the
        action that fixes it — this only has to refuse. */
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
    /* The probe's own row, which for an endpoint is never usable — so this
    refuses it at `resolve_model` rather than sending it anywhere. */
    let endpoints = state.on_store(app, |store| store.list()).await?;
    endpoints
        .iter()
        .find(|endpoint| endpoint.id == model)
        .map(probe::endpoint_route)
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
        /* A route id the probe did not mint. Never a path, never an argv —
         * but `to_owned` here COPIES whatever arrived into an error that
         * crosses IPC, which is why both callers bound the route first.
         * `every_string_parameter_of_every_command_is_bounded` in `limits.rs`
         * is what holds that, rather than this sentence. */
        other => Err(Error::ModelUnknown(other.to_owned())),
    }
}

/// The one chat request builder, so the two callers cannot drift on roles,
/// temperature or streaming. `response_format` is the gloss's alone — see
/// `ChatRequest::response_format`.
fn chat_request(
    model: String,
    system: String,
    question: String,
    max_tokens: u32,
    response_format: Option<serde_json::Value>,
) -> ChatRequest {
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
        response_format,
    }
}

/// The gloss's request, and the ONE place its schema is attached.
///
/// A function of its own rather than an inline `chat_request(…, Some(…))` so
/// the request `inference_gloss` sends is the request its tests serialise —
/// the schema going missing from it is the one regression no parse test can
/// see, because every reply a parse test reads is one somebody supplied.
fn gloss_request(
    model: String,
    system: String,
    question: String,
    language: &str,
    second_language: Option<&str>,
) -> ChatRequest {
    chat_request(
        model,
        system,
        question,
        MAX_GLOSS_TOKENS,
        Some(crate::gloss::response_format(language, second_language)),
    )
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
    limits::within("model id", &model, limits::MAX_MODEL_ID)?;
    limits::within("system prompt", &system, limits::MAX_SYSTEM)?;
    limits::within("question", &question, limits::MAX_QUESTION)?;
    /* REGISTERED BEFORE THE RESOLVE — the same rule the agent turn records.
     * `resolve_model` does filesystem and keychain work; a Stop pressed in
     * that window used to answer `RequestUnknown` and the generation then
     * started anyway. The token exists first, and the resolve's outcome is
     * checked against it. */
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    /* A SEND THAT FAILS CANCELS THE REQUEST. The webview dropped the channel —
     * the pane closed, the reader left — and going on would keep the model
     * generating into nothing, which on a loaded machine is a GPU spent on an
     * answer nobody will read, and on an endpoint is tokens paid for. */
    let sink = cancel.clone();
    let on_text = move |text: String| {
        if chunks.send(text).is_err() {
            sink.trip();
        }
    };
    /* ⚠️ AN ENDPOINT IS ANSWERED BY THE ENDPOINT. Once an endpoint could be
     * usable, the companion's route list could choose one, and this sent its id
     * to the LOCAL server as `model` — which, in single-model mode, answered
     * with the local model and named nothing. Found when Look up gained routes
     * (2026-09-18). A manifest model is local; anything else that resolves is a
     * stored endpoint. */
    if state.manifest()?.model(&model).is_err() {
        let (endpoint, key) = endpoint_and_key(&app, &state, &model).await?;
        cancel.check()?;
        let body = chat_request(
            endpoint.model.clone(),
            system,
            question,
            MAX_ANSWER_TOKENS,
            None,
        );
        return Ok(crate::cloud::ask(
            state.cloud()?,
            &endpoint,
            key.as_deref(),
            body,
            crate::daemon::MODEL_CEILING,
            &cancel,
            on_text,
        )
        .await?
        .text);
    }
    let model = resolve_model(&app, &state, &model).await?;
    cancel.check()?;
    /* ⚠️ THE DAEMON LOCK IS DROPPED BEFORE THE NETWORK WAIT. `state.daemon()`
     * hands back a mapped mutex guard, and holding it across a streamed
     * generation serialised every other daemon command behind this one — the
     * status poll, the memory reading, a second question. A
     * `RequestBuilder` owns its client, so the guard is needed only to build
     * it. */
    let request = {
        let daemon = state.daemon().await?;
        daemon
            .model_request(reqwest::Method::POST, generate::CHAT_ROUTE)
            .json(&chat_request(
                model,
                system,
                question,
                MAX_ANSWER_TOKENS,
                None,
            ))
    };
    /* THE TEXT, not the whole `Answer`. A generation STREAMS, so a reader
     * watching it arrive sees it stop — see `Error::AnswerTruncated` for why
     * that is the difference between this command and the gloss, and not a
     * looser rule here. */
    Ok(generate::stream(request, &cancel, on_text).await?.text)
}

/// A stored endpoint the probe calls usable, and its key for this one request.
///
/// THE PROBE'S OWN ROW DECIDES — the one usability decision — and the key is
/// read afterwards, in Rust, never handed to the webview. Both through the
/// blocking seam: the keychain can put a prompt in front of the reader. `None`
/// for a loopback endpoint stored without a key, which the probe allows.
async fn endpoint_and_key<R: Runtime>(
    app: &AppHandle<R>,
    state: &InferenceState,
    id: &str,
) -> Result<(crate::endpoints::Endpoint, Option<String>)> {
    let wanted = id.to_owned();
    let endpoint = state
        .on_store(app, move |store| store.list())
        .await?
        .into_iter()
        .find(|endpoint| endpoint.id == wanted)
        .ok_or_else(|| Error::ModelUnknown(id.to_owned()))?;
    if !probe::endpoint_route(&endpoint).usable() {
        return Err(Error::ModelUnknown(id.to_owned()));
    }
    let account = endpoint.id.clone();
    let key = state
        .on_store(app, move |store| store.key(&account))
        .await?;
    if key.is_none() && !crate::endpoints::is_loopback(&endpoint.base_url) {
        /* The probe said usable a moment ago and the key has gone since. */
        return Err(Error::ModelUnknown(id.to_owned()));
    }
    Ok((endpoint, key))
}

/// Define a term in the sentence it sits in (WI-15.13) — by whichever ROUTE the
/// reader's Look up answers with.
///
/// A PROMISE, not a stream: two sentences streamed into a popover beside a
/// word is jitter, not progress.
///
/// ⚠️ **FOUR ROUTES SINCE 2026-09-18, AND ONE OF THEM REVERSES F8.** `route` is
/// a probe route id — `local:<model>`, `endpoint:<id>`, `agent:claude`,
/// `agent:codex` — and the owner decided Look up may be answered by any of
/// them, the local model becoming an opt-in download rather than the only way
/// to define a word. This used to be its own command precisely so that "no
/// selection can reach an agent" was a property of the call graph; it is now a
/// choice the reader makes, with the cost of each route measured and shown
/// (agents: 6–12 s a word, against 1–2 s). A route the probe calls unusable is
/// refused here as it is everywhere.
///
/// THE ANSWER IS JSON, CONSTRAINED BY THE SAME SCHEMA ON EVERY ROUTE, and
/// `language` / `second_language` are what it is built from. Two parameters
/// rather than a list, so that no languages and three are not things a caller
/// can send. See `gloss.rs` for the schema and why it is the portable one.
///
/// (The `allow` sits ABOVE `#[tauri::command]` deliberately: `limits.rs` and
/// `plugin.contract.test.ts` find a command's parameters as the first `(`
/// after that attribute, and an attribute's own parenthesis in between would
/// hand them the wrong text.)
#[allow(clippy::too_many_arguments)] // one parameter per fact a gloss needs; a struct would hide which field `limits` bounds
#[tauri::command]
pub async fn inference_gloss<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    request_id: String,
    route: String,
    system: String,
    question: String,
    language: String,
    second_language: Option<String>,
) -> Result<String> {
    limits::within("request id", &request_id, limits::MAX_REQUEST_ID)?;
    limits::within("system prompt", &system, limits::MAX_SYSTEM)?;
    limits::within("question", &question, limits::MAX_QUESTION)?;
    limits::within("route id", &route, limits::MAX_MODEL_ID)?;
    limits::within("answer language", &language, limits::MAX_LANGUAGE_NAME)?;
    if let Some(second_language) = &second_language {
        limits::within(
            "second answer language",
            second_language,
            limits::MAX_LANGUAGE_NAME,
        )?;
    }
    /* REGISTERED BEFORE ANYTHING SLOW — the resolve, a keychain read, a
     * process spawn — for `inference_generate`'s reason: a Stop pressed in that
     * window must find a request to cancel. */
    let guard = state.requests().begin(&request_id)?;
    let cancel = guard.cancel();
    let ask = GlossAsk {
        system,
        question,
        language,
        second_language,
    };
    if let Some(model) = route.strip_prefix("local:") {
        gloss_locally(&app, &state, model, ask, &cancel).await
    } else if let Some(id) = route.strip_prefix("endpoint:") {
        gloss_at_endpoint(&app, &state, id, ask, &cancel).await
    } else {
        gloss_by_agent(&app, &state, &route, &ask, &cancel).await
    }
}

/// What one lookup asks, whichever route answers it: the command's parameters,
/// already bounded by `limits`, in one value that each route takes whole.
struct GlossAsk {
    system: String,
    question: String,
    language: String,
    second_language: Option<String>,
}

/// The local server's half of `inference_gloss` — what the command was, whole,
/// before it had routes.
async fn gloss_locally<R: Runtime>(
    app: &AppHandle<R>,
    state: &InferenceState,
    model: &str,
    ask: GlossAsk,
    cancel: &crate::requests::Cancel,
) -> Result<String> {
    /* RESOLVED, like `inference_generate`. The first version of the closed
     * argument set covered only the generate path, which left the gloss
     * forwarding a caller-supplied model straight to the daemon — the exact
     * hole the header claims does not exist. An audit caught the omission. */
    let model = resolve_model(app, state, model).await?;
    cancel.check()?;
    /* Dropped before the wait, as in `inference_generate` — see there. */
    let request = {
        let daemon = state.daemon().await?;
        daemon
            .model_request(reqwest::Method::POST, generate::CHAT_ROUTE)
            /* ⚠️ ITS OWN CEILING, because `MODEL_CEILING` is ten minutes and
             * every word of its reasoning is about a 1024-token generation.
             * A reader has stopped reading to wait for this one. See
             * `daemon::GLOSS_CEILING`. */
            .deadline(crate::daemon::GLOSS_CEILING)
            .json(&gloss_request(
                model,
                ask.system,
                ask.question,
                &ask.language,
                ask.second_language.as_deref(),
            ))
    };
    // Streamed on the wire, delivered whole: the daemon's non-streaming path
    // holds the whole answer before replying, and cancelling that is a
    // request nobody is reading rather than a generation that stopped.
    finished(generate::stream(request, cancel, |_| {}).await?)
}

/// The endpoint's half: the reader's URL, key and model, through `cloud.rs`.
async fn gloss_at_endpoint<R: Runtime>(
    app: &AppHandle<R>,
    state: &InferenceState,
    id: &str,
    ask: GlossAsk,
    cancel: &crate::requests::Cancel,
) -> Result<String> {
    let (endpoint, key) = endpoint_and_key(app, state, id).await?;
    cancel.check()?;
    let body = gloss_request(
        endpoint.model.clone(),
        ask.system,
        ask.question,
        &ask.language,
        ask.second_language.as_deref(),
    );
    finished(
        crate::cloud::ask(
            state.cloud()?,
            &endpoint,
            key.as_deref(),
            body,
            crate::daemon::GLOSS_CEILING,
            cancel,
            |_| {},
        )
        .await?,
    )
}

/// An agent CLI's half: one structured turn, through `agentask::gloss`.
async fn gloss_by_agent<R: Runtime>(
    app: &AppHandle<R>,
    state: &InferenceState,
    route: &str,
    ask: &GlossAsk,
    cancel: &crate::requests::Cancel,
) -> Result<String> {
    let which = parse_agent_route(route)?;
    /* `which`, NOT `agent::probe`. The probe spawns the CLI twice more — its
    version and its sign-in — and a lookup is already 6–12 s through an agent;
    the route list ran the probe when it offered this route. A reader signed
    out since then gets the CLI's own refusal, redacted, from the turn. */
    let program = agent::which(which.exe()).ok_or_else(|| Error::AgentMissing(which.name()))?;
    let base = state.layout(app)?.base.clone();
    let schema = crate::gloss::schema(&ask.language, ask.second_language.as_deref());
    let schema_file = schema_file(&base, &schema).await?;
    cancel.check()?;
    /* THE LOOKUP'S CEILING, which the turn runner does not know about: its own
    are ten minutes and two of silence, sized for a companion's answer. Dropping
    the turn on the deadline takes its process group down (`agentask::Turn`). */
    tokio::time::timeout(
        crate::daemon::GLOSS_CEILING,
        agentask::gloss(
            which,
            std::path::Path::new(&program),
            &base.join("agent-root"),
            &schema_file,
            &schema,
            &ask.system,
            &ask.question,
            cancel,
        ),
    )
    .await
    .map_err(|_| Error::AgentMalformed {
        agent: which.name(),
        message: format!(
            "gave no answer within {}s",
            crate::daemon::GLOSS_CEILING.as_secs()
        ),
    })?
}

/// Where Codex reads the schema from — `--output-schema` takes a FILE.
///
/// Named by the schema's own digest, so one file per language pair, written
/// once and reused; written to a temporary name and renamed, so a reader of the
/// path never sees half a schema. Outside the agent's working root, which must
/// stay empty (`agentask::prepare_workdir`).
async fn schema_file(
    base: &std::path::Path,
    schema: &serde_json::Value,
) -> Result<std::path::PathBuf> {
    use sha2::Digest;
    let bytes = schema.to_string();
    let digest = data_encoding::HEXLOWER.encode(&sha2::Sha256::digest(bytes.as_bytes()));
    let folder = base.join("gloss-schemas");
    let path = folder.join(format!("{}.json", &digest[..16]));
    if tokio::fs::metadata(&path)
        .await
        .is_ok_and(|meta| meta.is_file())
    {
        return Ok(path);
    }
    tokio::fs::create_dir_all(&folder).await?;
    let partial = folder.join(format!("{}.json.part", &digest[..16]));
    tokio::fs::write(&partial, bytes.as_bytes()).await?;
    tokio::fs::rename(&partial, &path).await?;
    Ok(path)
}

/// A gloss that FINISHED, or a refusal saying how it did not.
///
/// ⚠️ **A CUT-OFF DEFINITION IS NOT A DEFINITION**, and the gloss used to return
/// one as though it were. `MAX_GLOSS_TOKENS` is Paper's own bound, so hitting it
/// is an ordinary outcome rather than a daemon misbehaving — and because the
/// gloss is delivered WHOLE rather than streamed, nobody watches it stop. The
/// answer is JSON, so a cut-off one is not even a readable fragment: it is an
/// object with no closing brace, which `definitionOf` cannot parse and so draws
/// whole, keys and quotes and all, as the definition.
///
/// POSITIVE, and that is the fail-closed direction: only an explicit `stop` is
/// a finished answer. `length` is refused, and so is a stream that ended saying
/// NOTHING — a server killed mid-answer, a body that stopped without `[DONE]` —
/// which the first version of this check let through. Found by audit.
fn finished(answer: generate::Answer) -> Result<String> {
    if !answer.complete() {
        return Err(Error::AnswerTruncated {
            finish: answer.finish_label(),
            limit: MAX_GLOSS_TOKENS,
        });
    }
    Ok(answer.text)
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
    limits::within("route id", &route, limits::MAX_MODEL_ID)?;
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
    limits::within("route id", &route, limits::MAX_MODEL_ID)?;
    let which = parse_agent_route(&route)?;
    let path = agent::which(which.exe()).ok_or_else(|| Error::AgentMissing(which.name()))?;
    let args: &[&str] = match which {
        Agent::Codex => &["login"],
        Agent::Claude => &["auth", "login"],
    };
    // Spawned and released: a login flow opens a browser and takes as long as
    // the reader takes. Awaiting it would block the command for minutes —
    // but SOMETHING must wait, or the exited child sits as a zombie until
    // Paper quits. A detached task is that something.
    let mut child = tokio::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    tokio::spawn(async move {
        if let Err(err) = child.wait().await {
            log::warn!("inference: the sign-in process could not be reaped: {err}");
        }
    });
    Ok(())
}

/* ────────────────────────────── cloud endpoints ─────────────────────────── */

/* Every store call below goes through `state.on_store` — the store is
 * blocking and so is the keychain, and the seam is where that is explained. */

#[tauri::command]
pub async fn inference_endpoints<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
) -> Result<Vec<Endpoint>> {
    state.on_store(&app, |store| store.list()).await
}

#[tauri::command]
pub async fn inference_add_endpoint<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    id: String,
    label: String,
    base_url: String,
    model: String,
) -> Result<()> {
    /* THE ID IS BOUNDED HERE AND NOT ONLY IN THE STORE. `EndpointStore::add`
     * refuses an invalid id by copying it into `ModelUnknown`, and that error
     * crosses IPC — so the store's grammar check is a length check that
     * ALLOCATES AND ECHOES whatever it refuses. Bounded before the blocking
     * hop, like the label beside it and the key in `set_endpoint_key`. */
    limits::within("endpoint id", &id, limits::MAX_ENDPOINT_ID)?;
    limits::within("endpoint label", &label, limits::MAX_ENDPOINT_LABEL)?;
    limits::within("endpoint url", &base_url, limits::MAX_ENDPOINT_URL)?;
    limits::within("endpoint model", &model, limits::MAX_ENDPOINT_MODEL)?;
    /* ⚠️ ONE WRITER AT A TIME. `add` and `remove` read the list, edit it and
     * write it back through the same temporary path; nothing serialised them
     * and `#[tauri::command]`s run concurrently, so two at once lose an edit
     * or rename a half-written file over the reader's only copy. */
    let _writing = state.endpoint_writes().lock().await;
    state
        .on_store(&app, move |store| store.add(&id, &label, &base_url, &model))
        .await
}

#[tauri::command]
pub async fn inference_remove_endpoint<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, InferenceState>,
    id: String,
) -> Result<()> {
    /* ⚠️ THIS IS THE ONE THAT NEVER REACHED A GRAMMAR CHECK. `add` and
     * `set_key` call `valid_id`; `EndpointStore::remove` does not — it filters
     * the list by the id and then hands it straight to the keychain as an
     * account name. So nothing at all bounded this field, and the bound has to
     * be here rather than borrowed from a sibling command. */
    limits::within("endpoint id", &id, limits::MAX_ENDPOINT_ID)?;
    let _writing = state.endpoint_writes().lock().await;
    /* (This stopped the daemon afterwards, unconditionally, while cloud keys
     * rode lemond's environment: a key the reader deleted must not stay live
     * in a running child. No key reaches the server now, so there is nothing
     * to stop.) */
    state.on_store(&app, move |store| store.remove(&id)).await
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
    // Bounded BEFORE the blocking keychain write gets to allocate for it.
    // Both fields: the id is the keychain ACCOUNT the key is written under.
    limits::within("endpoint id", &id, limits::MAX_ENDPOINT_ID)?;
    limits::within("endpoint key", &key, limits::MAX_ENDPOINT_KEY)?;
    let _writing = state.endpoint_writes().lock().await;
    state
        .on_store(&app, move |store| store.set_key(&id, &key))
        .await
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

    /// `—`, never `0`: a plausible zero is a lie the reader cannot catch.
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

    /// ⚠️ **THE SCHEMA GOING MISSING IS THE REGRESSION NO PARSE TEST CAN SEE.**
    /// Every reply `definitionOf`'s tests read is one somebody supplied, so
    /// they stay green against a request that asks for prose — which is how
    /// the `pos:` line broke 7 of 9 real answers past a green suite. So the
    /// request itself is asserted: the gloss carries exactly the format
    /// `gloss.rs` builds, from the languages it was handed, and the companion's
    /// carries none (it streams prose a reader watches arrive).
    #[test]
    fn the_gloss_asks_for_its_schema_and_the_companion_does_not() {
        let gloss = serde_json::to_value(gloss_request(
            "qwen".to_owned(),
            "rules".to_owned(),
            "a question".to_owned(),
            "Simplified Chinese",
            Some("English"),
        ))
        .unwrap();
        assert_eq!(
            gloss["response_format"],
            crate::gloss::response_format("Simplified Chinese", Some("English"))
        );
        assert_eq!(gloss["max_tokens"], MAX_GLOSS_TOKENS);

        let one = serde_json::to_value(gloss_request(
            "qwen".to_owned(),
            "rules".to_owned(),
            "a question".to_owned(),
            "English",
            None,
        ))
        .unwrap();
        assert_eq!(
            one["response_format"],
            crate::gloss::response_format("English", None)
        );

        let companion = serde_json::to_value(chat_request(
            "qwen".to_owned(),
            "rules".to_owned(),
            "a question".to_owned(),
            MAX_ANSWER_TOKENS,
            None,
        ))
        .unwrap();
        assert!(companion.get("response_format").is_none(), "{companion}");
    }

    /// AND THE COMMAND SENDS THAT REQUEST. `inference_gloss` needs a Tauri app
    /// to run, so the half of the claim above that a unit test cannot reach —
    /// that the command builds its body with `gloss_request` and not with a
    /// bare `chat_request` — is read off its source, the way `limits.rs` reads
    /// its parameters.
    #[test]
    fn the_gloss_command_sends_the_request_with_the_schema() {
        let source = include_str!("commands.rs");
        let body_of = |name: &str| {
            let start = source
                .find(&format!("fn {name}<"))
                .unwrap_or_else(|| panic!("{name} is in commands.rs"));
            &source[start..start + source[start..].find("\n}\n").expect("its body ends")]
        };
        /* EVERY ROUTE, since there are four: the local server and an endpoint
        send the chat request with the schema, an agent is handed the schema
        itself, and none of them builds a bare `chat_request`. */
        for (route, sends_the_schema) in [
            ("gloss_locally", ".json(&gloss_request("),
            ("gloss_at_endpoint", "gloss_request("),
            ("gloss_by_agent", "crate::gloss::schema("),
        ] {
            let body = body_of(route);
            assert!(body.contains(sends_the_schema), "{route}: {body}");
            assert!(!body.contains("chat_request("), "{route}: {body}");
        }
        /* And the command reaches them all: a route kind with no branch would
        be a lookup that silently went somewhere else. */
        let command = body_of("inference_gloss");
        for route in ["gloss_locally(", "gloss_at_endpoint(", "gloss_by_agent("] {
            assert!(
                command.contains(route),
                "inference_gloss does not dispatch to {route}"
            );
        }
    }

    /// A server launched EXACTLY as the app launches one — the staged runtime,
    /// verified by `runtime.rs`, handed to `plan_spawn` and `Daemon::start` —
    /// on the GGUF named by `PAPER_LIVE_MODEL`. The live tests below measure
    /// the real launch, flags and all, rather than a server somebody started
    /// by hand with flags of their own.
    async fn live_server() -> crate::daemon::Daemon {
        let model = std::env::var("PAPER_LIVE_MODEL")
            .expect("PAPER_LIVE_MODEL, the path of an installed GGUF");
        let runtime = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../vendor/inference/current")
            .canonicalize()
            .expect("vendor/inference/current is staged — pnpm runtime:sync");
        let backend = crate::RuntimeManifest::load(&runtime)
            .await
            .expect("the staged runtime's manifest")
            .verify(&runtime)
            .await
            .expect("the staged runtime verifies");
        let port = std::net::TcpListener::bind((crate::LOOPBACK, 0))
            .and_then(|listener| listener.local_addr())
            .expect("a free port")
            .port();
        crate::daemon::Daemon::start(crate::plan_spawn(&crate::SpawnInputs {
            backend,
            model: model.into(),
            model_id: crate::Manifest::shipped().unwrap().models[0].id.clone(),
            record_path: std::env::temp_dir().join(format!("paper-live-{port}.json")),
            port,
            api_key: crate::mint_token(),
        }))
        .await
        .expect("the server started and answered its health route")
    }

    /// ⚠️ **THE ONE CHECK NOTHING OFFLINE CAN MAKE: THAT THE SERVER HONOURS
    /// THE SCHEMA.** Every test above proves what Paper SENDS. Whether it is
    /// compiled into a grammar — with `stream: true`, which is how the gloss
    /// asks — is a property of a process this crate does not own, and a server
    /// that dropped it would answer in prose, which the parse would fail soft
    /// on and draw whole, raw, beside every word.
    ///
    /// Run by hand; it launches its own server (`live_server`):
    ///
    /// ```sh
    /// PAPER_LIVE_MODEL="$HOME/Library/Application Support/one.paper.reader/inference/models/<id>/<file>.gguf" \
    /// cargo test -p tauri-plugin-inference --lib live_ -- --ignored --nocapture --test-threads=1
    /// ```
    ///
    /// (Until 2026-09-18 this attached to a running `lemond` by its port and
    /// the key read out of its environment. The 27-reply baseline recorded in
    /// AGENTS.md was taken that way, the last run against lemond.)
    ///
    /// `PAPER_LIVE_SYSTEM_PROMPT` names a file holding the system prompt to
    /// send — the app's `DEFAULT_GLOSS_PROMPT`, to measure what a reader gets;
    /// without it a one-line instruction is sent, which is enough for what this
    /// ASSERTS: the shape, which the grammar guarantees whatever the prompt
    /// says. `PAPER_LIVE_RUNS` repeats each case (default 1). Each reply is
    /// printed as `gloss-live` + the question and the raw text, both as JSON
    /// strings, for a harness that feeds them to `definitionOf`.
    ///
    /// The question is written in `glossQuestion`'s shape — a copy, because the
    /// builder is TypeScript; a copy that drifts changes the wording the model
    /// is asked in, not the shape this asserts.
    #[tokio::test]
    #[ignore = "launches a real server: PAPER_LIVE_MODEL and a staged runtime — see the doc comment"]
    async fn live_gloss_answers_in_the_shape_it_asked_for() {
        let daemon = live_server().await;
        let system = match std::env::var("PAPER_LIVE_SYSTEM_PROMPT") {
            Ok(path) => std::fs::read_to_string(path).expect("the system prompt file"),
            Err(_) => "You define a word as it is used in one sentence from a book.".to_owned(),
        };
        let runs: usize = std::env::var("PAPER_LIVE_RUNS")
            .map(|n| n.parse().expect("a count"))
            .unwrap_or(1);
        let manifest = crate::Manifest::shipped().expect("the shipped manifest");
        let model = manifest.models[0].id.clone();
        let cases = [
            ("quarter", "Most of our top-level objectives endured from quarter to quarter, typically for eighteen months."),
            ("upending", "Beginning with the personal computer in the 1980s, our history reflects a series of tech disruptions, with each new platform upending its predecessor."),
            ("transparent", "The system is powerful precisely because it is so simple—and so transparent."),
        ];
        let languages: [(&str, Option<&str>); 3] = [
            ("English", None),
            ("English", Some("Simplified Chinese")),
            ("Simplified Chinese", Some("English")),
        ];
        let registry = crate::requests::Registry::default();
        let mut failures = Vec::new();
        let mut asked = 0;
        for (first, then) in languages {
            for (term, sentence) in cases {
                for _ in 0..runs {
                    asked += 1;
                    let answer_in = std::iter::once(first)
                        .chain(then)
                        .collect::<Vec<_>>()
                        .join(", then ");
                    let question = format!(
                        "Book: Measure What Matters\nSentence: {sentence}\nAnswer in: {answer_in}\nDefine, in this sentence: {term}"
                    );
                    let guard = registry.begin("gloss-live").expect("a fresh request");
                    let request = daemon
                        .model_request(reqwest::Method::POST, generate::CHAT_ROUTE)
                        .deadline(crate::daemon::GLOSS_CEILING)
                        .json(&gloss_request(
                            model.clone(),
                            system.clone(),
                            question.clone(),
                            first,
                            then,
                        ));
                    let answer = generate::stream(request, &guard.cancel(), |_| {})
                        .await
                        .expect("the server answered");
                    drop(guard);
                    println!(
                        "gloss-live\t{}\t{}",
                        serde_json::to_string(&question).unwrap(),
                        serde_json::to_string(&answer.text).unwrap()
                    );
                    if let Some(why) = off_shape(&answer, first, then) {
                        failures.push(format!("{term} in {answer_in}: {why} — {:?}", answer.text));
                    }
                }
            }
        }
        daemon.stop().await;
        assert!(
            failures.is_empty(),
            "{} of {asked} replies were not in the shape asked for:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    /// ⚠️ **THE HOLE THE SWAP CLOSED, MEASURED ON THE REAL LAUNCH.** lemond held
    /// the key on its own port and started `llama-server` one port over with
    /// none: measured 2026-09-18, an unauthenticated `POST /v1/chat/completions`
    /// there answered 200, `/slots` answered 200, and a CORS preflight from
    /// `https://evil.example` came back allowed, credentials and all. Every
    /// line of that is asserted refused here, against a server `plan_spawn`
    /// launched — so a flag dropped from the table fails this, not a review.
    ///
    /// Run beside `live_gloss_…`; see its doc comment for the command.
    #[tokio::test]
    #[ignore = "launches a real server: PAPER_LIVE_MODEL and a staged runtime — see live_gloss_answers_in_the_shape_it_asked_for"]
    async fn live_server_refuses_whoever_lacks_the_key() {
        let daemon = live_server().await;
        let base = daemon.plan().base_url();
        let chat = format!("{base}{}", generate::CHAT_ROUTE);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let body = serde_json::json!({
            "messages": [{ "role": "user", "content": "Say ok." }],
            "max_tokens": 2,
        });
        let status = |response: reqwest::Result<reqwest::Response>| {
            response.expect("the server answered").status().as_u16()
        };

        let no_key = status(client.post(&chat).json(&body).send().await);
        let wrong_key = status(
            client
                .post(&chat)
                .bearer_auth("0".repeat(64))
                .json(&body)
                .send()
                .await,
        );
        let preflight = client
            .request(reqwest::Method::OPTIONS, &chat)
            .header("Origin", "https://evil.example")
            .header("Access-Control-Request-Method", "POST")
            .header(
                "Access-Control-Request-Headers",
                "content-type, authorization",
            )
            .send()
            .await
            .expect("the server answered the preflight");
        let allowed = preflight
            .headers()
            .get("access-control-allow-origin")
            .map(|value| value.to_str().unwrap_or("").to_owned());
        let slots = status(
            client
                .get(format!("{base}/slots"))
                .bearer_auth(daemon.plan().api_key())
                .send()
                .await,
        );
        let answered: serde_json::Value = client
            .post(&chat)
            .bearer_auth(daemon.plan().api_key())
            .json(&body)
            .send()
            .await
            .expect("the server answered the key")
            .json()
            .await
            .expect("a JSON answer");
        daemon.stop().await;

        assert_eq!(no_key, 401, "a request with no key must be refused");
        assert_eq!(
            wrong_key, 401,
            "a request with the wrong key must be refused"
        );
        assert!(
            !matches!(allowed.as_deref(), Some("https://evil.example" | "*")),
            "a foreign origin was allowed: {allowed:?}"
        );
        assert_ne!(slots, 200, "/slots shows recent prompts and must be off");
        assert_eq!(
            answered["model"],
            crate::Manifest::shipped().unwrap().models[0].id,
            "an answer names the model by id — never by the artifact's path, which is the reader's home directory"
        );
        assert!(
            answered["choices"][0]["message"]["content"].is_string(),
            "the key opens the door it is for: {answered}"
        );
    }

    /// ⚠️ **PAPER'S ENDPOINT CLIENT, MEASURED AGAINST A REAL OPENAI-COMPATIBLE
    /// SERVER WITH A REAL KEY** — the local `llama-server`, which speaks the
    /// same protocol, so the client's request, key, schema and error mapping are
    /// proved with no provider account. What it cannot show is a provider's own
    /// quirks; see `cloud.rs`'s header. Run beside `live_gloss_…`.
    #[tokio::test]
    #[ignore = "launches a real server: PAPER_LIVE_MODEL and a staged runtime — see live_gloss_answers_in_the_shape_it_asked_for"]
    async fn live_endpoint_answers_through_papers_own_client() {
        let daemon = live_server().await;
        let plan = daemon.plan();
        let endpoint = crate::endpoints::Endpoint {
            id: "local-llama".to_owned(),
            label: "This machine".to_owned(),
            base_url: format!("http://127.0.0.1:{}/v1", plan.port),
            model: plan.model_id.clone(),
            key_state: crate::endpoints::KeyState::Set,
        };
        assert!(crate::endpoints::valid_base_url(&endpoint.base_url));
        let clients = crate::cloud::Clients::new().expect("the clients build");
        let registry = crate::requests::Registry::default();
        let question = "Book: Measure What Matters\nSentence: The system is powerful precisely because it is so simple—and so transparent.\nAnswer in: Simplified Chinese, then English\nDefine, in this sentence: transparent";
        let body = || {
            gloss_request(
                endpoint.model.clone(),
                "You define a word as it is used in one sentence from a book.".to_owned(),
                question.to_owned(),
                "Simplified Chinese",
                Some("English"),
            )
        };
        let guard = registry.begin("endpoint-live").unwrap();
        let answered = crate::cloud::ask(
            &clients,
            &endpoint,
            Some(plan.api_key()),
            body(),
            crate::daemon::GLOSS_CEILING,
            &guard.cancel(),
            |_| {},
        )
        .await;
        drop(guard);
        let guard = registry.begin("endpoint-live-wrong-key").unwrap();
        let refused = crate::cloud::ask(
            &clients,
            &endpoint,
            Some(&"0".repeat(64)),
            body(),
            crate::daemon::GLOSS_CEILING,
            &guard.cancel(),
            |_| {},
        )
        .await;
        drop(guard);
        daemon.stop().await;

        let answer = answered.expect("the endpoint answered the right key");
        println!("endpoint-live\t{}", answer.text);
        assert_eq!(
            off_shape(&answer, "Simplified Chinese", Some("English")),
            None,
            "{}",
            answer.text
        );
        let refusal = refused.expect_err("a wrong key is refused");
        assert_eq!(refusal.kind(), "endpointHttp", "{refusal}");
        assert!(refusal.to_string().contains("401"), "{refusal}");
    }

    /// ⚠️ **THE AGENT ROUTES, THROUGH THE REAL CLIs.** Each is asked one
    /// two-language lookup with the lockdown `agentask::gloss_args` builds, and
    /// the answer must be in the shape the schema asked for. It spends a turn of
    /// the reader's subscription per agent, which is why it is ignored and names
    /// the agents it may use: `PAPER_LIVE_AGENTS=claude,codex`.
    #[tokio::test]
    #[ignore = "spends subscription turns: PAPER_LIVE_AGENTS=claude,codex"]
    async fn live_agents_answer_in_the_shape_asked_for() {
        let wanted = std::env::var("PAPER_LIVE_AGENTS").expect("PAPER_LIVE_AGENTS=claude,codex");
        let scratch = crate::testutil::ScratchDir::new("agent-gloss");
        let schema = crate::gloss::schema("English", Some("Simplified Chinese"));
        let schema_file = schema_file(scratch.path(), &schema).await.unwrap();
        let system =
            std::fs::read_to_string(std::env::var("PAPER_LIVE_SYSTEM_PROMPT").unwrap_or_default())
                .unwrap_or_else(|_| {
                    "You define a word as it is used in one sentence from a book.".to_owned()
                });
        let question = "Book: Measure What Matters\nSentence: The system is powerful precisely because it is so simple—and so transparent.\nAnswer in: English, then Simplified Chinese\nDefine, in this sentence: transparent";
        let registry = crate::requests::Registry::default();
        for name in wanted.split(',') {
            let which = parse_agent_route(&format!("agent:{}", name.trim())).unwrap();
            let program = agent::which(which.exe()).expect("the CLI is installed");
            let guard = registry.begin("agent-live").unwrap();
            let started = std::time::Instant::now();
            let text = agentask::gloss(
                which,
                std::path::Path::new(&program),
                &scratch.path().join("agent-root"),
                &schema_file,
                &schema,
                &system,
                question,
                &guard.cancel(),
            )
            .await
            .unwrap_or_else(|failure| panic!("{name}: {failure}"));
            drop(guard);
            println!(
                "agent-live\t{name}\t{:.1}s\t{text}",
                started.elapsed().as_secs_f64()
            );
            assert_eq!(
                off_shape_text(&text, "English", Some("Simplified Chinese")),
                None,
                "{name}: {text}"
            );
        }
    }

    /// What `live_gloss_answers_in_the_shape_it_asked_for` refuses: anything
    /// the schema should have made impossible. NOT a second `definitionOf` —
    /// this asks whether the grammar held, not what a reader is shown.
    fn off_shape(answer: &generate::Answer, first: &str, then: Option<&str>) -> Option<String> {
        if !answer.complete() {
            return Some(format!("finished {}", answer.finish_label()));
        }
        off_shape_text(&answer.text, first, then)
    }

    /// The shape half of [`off_shape`], for an answer that arrived whole — an
    /// agent's, which has no finish reason to read.
    fn off_shape_text(text: &str, first: &str, then: Option<&str>) -> Option<String> {
        let reply: serde_json::Value = match serde_json::from_str(text) {
            Ok(reply) => reply,
            Err(error) => return Some(format!("not JSON: {error}")),
        };
        if !reply["partOfSpeech"]
            .as_str()
            .is_some_and(|label| !label.trim().is_empty())
        {
            return Some("no part of speech".to_owned());
        }
        let wanted: Vec<&str> = std::iter::once(first).chain(then).collect();
        let Some(slots) = reply["definition"].as_object() else {
            return Some("no definition object".to_owned());
        };
        if slots.len() != wanted.len() {
            return Some(format!("{} slots, asked {}", slots.len(), wanted.len()));
        }
        let entries: Vec<&serde_json::Value> = crate::gloss::SLOTS
            .iter()
            .filter_map(|slot| slots.get(*slot))
            .collect();
        let named: Vec<&str> = entries
            .iter()
            .map(|one| one["language"].as_str().unwrap_or("?"))
            .collect();
        if named != wanted {
            return Some(format!("languages {named:?}, asked {wanted:?}"));
        }
        if entries.iter().any(|one| {
            !one["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
        }) {
            return Some("an empty meaning".to_owned());
        }
        None
    }
}
