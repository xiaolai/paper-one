//! The supervised `lemond`: start it, prove it is ready, talk to it, stop it.
//!
//! One process, owned outright. Paper writes its configuration, mints its
//! credential, launches it into its own process group, waits for it to answer
//! its own health route, and takes the whole group down again on the way out.
//! Nothing here is a general runner: the program is the bundled binary
//! (`paths::bundled_runtime`), the argv is `spawn::plan_spawn`'s closed list,
//! and no caller supplies either.
//!
//! # Readiness is asked, never assumed
//!
//! `spawn` returning is not readiness — the daemon binds its sockets some
//! way into startup, and a request made before that fails with a connection
//! refusal that looks nothing like "still starting". So [`Daemon::start`]
//! polls `/api/v1/health` until it answers or the deadline passes, and a
//! deadline that passes carries the child's own log tail, because the useful
//! half of that failure is always what the child said before giving up.
//!
//! # The token never leaves this process
//!
//! F5: the webview renders untrusted book HTML, and the daemon's control
//! plane installs and executes backend binaries. Handing the webview the
//! bearer token to get native `fetch` streaming would hand book HTML a
//! backend installer. So the token is minted here, lives in this struct, and
//! every request to the daemon is made by this module. The webview gets typed
//! commands and a `Channel`, and no URL it chooses.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::error::{unreachable, Error, Result};
use crate::spawn::SpawnPlan;

/// How long to wait for the daemon to answer its health route before giving
/// up on the launch.
///
/// Generous, and the reason is measured: a cold start on the smoke-test
/// machine answered in well under a second, but the first launch after an
/// install also unpacks `resources/` and probes the accelerators, and a
/// reader on a slow disk should get a working app rather than a failure that
/// a retry fixes. A launch that has genuinely failed reports in 30s; nothing
/// waits on this except the reader who just pressed Install.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// The gap between health polls while starting.
const POLL_EVERY: Duration = Duration::from_millis(100);

/// How long a model may go SILENT before Paper gives up on it.
///
/// ⚠️ **THIS IS NOT A TOTAL DEADLINE, AND THAT IS THE WHOLE POINT.** The
/// client below carries `timeout(10s)`, which reqwest documents — and 0.13.4's
/// source says in as many words — as *"a total request timeout … applied from
/// when the request starts connecting until the response body has finished.
/// Also considered a total deadline."* That is right for `/api/v1/health`, which
/// is what the ten seconds was reasoned about; it is wrong for a chat
/// completion, whose body IS the answer arriving a token at a time.
///
/// The daemon loads a model on the FIRST request that needs it — `await_ready`
/// only polls for `status: "ok"`, and the health shape it parses reports
/// `model_loaded: null` — so the first gloss after a launch pays a 2.5 GB GGUF
/// read inside the same deadline as the generation. On a cold page cache that
/// alone can exceed ten seconds, and the reader gets a failed lookup on the
/// first thing they try.
///
/// So the streaming client is bounded by SILENCE instead, exactly as
/// `state.rs`'s download client is and for the same stated reason — *"no
/// overall timeout: a 2.4 GB download legitimately takes minutes. The read
/// timeout is what catches a stalled connection."* An answer that is still
/// arriving is a request still being served.
///
/// Two minutes is a backstop against a WEDGED daemon, not a budget for the
/// reader's patience: cancellation is wired all the way through
/// (`Cancel::cancelled` races every await in `generate::stream`, and `useGloss`
/// aborts on dismiss or on the next lookup), so a reader who has stopped
/// waiting is never held by this.
const MODEL_SILENCE: Duration = Duration::from_secs(120);

/// The absolute ceiling on one model-answered request.
///
/// ⚠️ **`MODEL_SILENCE` ALONE IS NOT A BOUND**, which an audit pointed out and
/// which is the flaw in replacing a total deadline with a read timeout and
/// stopping there: a response that emits ANY byte inside each 120-second
/// window runs for ever. An SSE keep-alive comment is such a byte, and so is a
/// model dribbling one token a minute. The old ten seconds was wrong for a
/// generation, but it was at least a ceiling; removing it without putting one
/// back traded a bound that was too tight for no bound at all.
///
/// Ten minutes is chosen against the work rather than as a round number:
/// `MAX_ANSWER_TOKENS` is 1024, and 1024 tokens at a slow five per second is
/// about three and a half minutes, plus a cold 2.5 GB model load. Nothing
/// legitimate approaches ten minutes; a request that does is wedged.
///
/// It is a REQUEST-level override, so it coexists with the client's
/// `read_timeout` rather than replacing it — verified in reqwest 0.13.4, where
/// `read_timeout` lives on the client config and is applied independently of
/// the per-request deadline. Two different questions: "has it gone quiet?" and
/// "has this gone on too long?"
const MODEL_CEILING: Duration = Duration::from_secs(600);

/// How long the tree gets to shut down cleanly before it is killed.
///
/// The daemon unloads models and releases GPU allocations on the way out
/// (`Unload all models` → `Evict all completed` → `Cleanup complete` in the
/// smoke test's log), and a loaded 2.4 GB model takes a moment to let go of.
/// Past this, the reader closing the app matters more than a clean unload.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// How many lines of the child's output to keep.
///
/// Only ever shown attached to a failure, and only ever from this process —
/// it is not a log file and nothing persists it. Bounded because a daemon
/// that fails in a loop would otherwise grow this without limit.
const LOG_TAIL_LINES: usize = 40;

/// A running daemon.
pub struct Daemon {
    child: Child,
    /// The process group, captured at spawn — see `procgroup::group_of`.
    /// `Child::id()` is `None` after a reap, and the grace loop reaps.
    group: Option<u32>,
    plan: SpawnPlan,
    client: reqwest::Client,
    /// The client for requests a MODEL answers — see `MODEL_SILENCE`.
    model_client: reqwest::Client,
    log: LogTail,
    /// The port its WebSocket chose for itself, once health has reported it.
    websocket_port: Option<u16>,
    #[cfg(windows)]
    _job: crate::procgroup::JobHandle,
}

/// The last few lines the child wrote, shared with the reader tasks.
#[derive(Clone, Default)]
pub struct LogTail(Arc<Mutex<VecDeque<String>>>);

impl LogTail {
    fn push(&self, line: String) {
        let mut lines = self.0.lock().expect("log tail poisoned");
        if lines.len() == LOG_TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    /// The tail as one string, oldest first.
    pub fn text(&self) -> String {
        let lines = self.0.lock().expect("log tail poisoned");
        lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

/// The daemon's health route, named once — see `SPEECH_ROUTE` in
/// `commands.rs` for the same reason.
const HEALTH_ROUTE: &str = "/api/v1/health";

impl Daemon {
    /// Write the configuration, launch the child, and wait for it to answer.
    ///
    /// The cache directory is NOT created here. WI-15.0's first acceptance
    /// line is that the daemon starts from a directory that did not exist,
    /// and the daemon makes its own — creating it first would turn that test
    /// into one that proves nothing.
    pub async fn start(plan: SpawnPlan) -> Result<Daemon> {
        // The config file has to exist before the launch, and it lives inside
        // the cache directory — so this one directory is created, and only
        // this one. The daemon still populates everything under it.
        if let Some(parent) = plan.config_path().parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(
            plan.config_path(),
            serde_json::to_vec_pretty(&plan.config).map_err(|e| {
                Error::ManifestMalformed(format!("could not render the runtime config: {e}"))
            })?,
        )
        .await?;

        let mut cmd = Command::new(&plan.program);
        cmd.args(&plan.args);
        for (key, value) in &plan.env {
            cmd.env(key, value);
        }
        for key in plan.env_removals() {
            cmd.env_remove(key);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // A Paper that is killed outright must not leave a daemon holding
            // the port. This is the backstop under the ordered shutdown, not
            // a replacement for it.
            .kill_on_drop(true);
        crate::procgroup::configure(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::RuntimeMissing(plan.program.clone())
            } else {
                Error::Io(e)
            }
        })?;

        #[cfg(windows)]
        let job = crate::procgroup::JobHandle::hold(&child)?;

        let log = LogTail::default();
        // Both pipes are drained. Not for the log alone: a child whose stdout
        // pipe fills up BLOCKS, and a daemon that stops making progress
        // because nobody is reading its chatter is a hang with no symptom.
        if let Some(out) = child.stdout.take() {
            spawn_reader(out, log.clone());
        }
        if let Some(err) = child.stderr.take() {
            spawn_reader(err, log.clone());
        }

        // No proxy, ever, on either client. A reader's `HTTP_PROXY` pointing
        // loopback traffic at somebody else's server would put the bearer
        // token and the reader's questions through it.
        let client = reqwest::Client::builder()
            // CONTROL PLANE ONLY — health, the model list, resource usage. The
            // daemon is on the loopback; one of these that has not been
            // answered in ten seconds is not going to be.
            //
            // ⚠️ This bound used to cover GENERATION too, because there was one
            // client. It is a TOTAL deadline, so it capped the whole streamed
            // answer at ten seconds — see `MODEL_SILENCE`.
            .timeout(Duration::from_secs(10))
            .no_proxy()
            .build()
            .map_err(|e| unreachable("client", e))?;

        let model_client = reqwest::Client::builder()
            // Bounded by SILENCE, not by total duration — see `MODEL_SILENCE`.
            // `read_timeout` exists only on the builder, never per request,
            // which is why this is a second client rather than an override at
            // the three call sites that need it.
            .read_timeout(MODEL_SILENCE)
            .no_proxy()
            .build()
            .map_err(|e| unreachable("model client", e))?;

        let group = crate::procgroup::group_of(&child);
        let mut daemon = Daemon {
            child,
            group,
            plan,
            client,
            model_client,
            log,
            websocket_port: None,
            #[cfg(windows)]
            _job: job,
        };
        /* A STARTUP FAILURE MUST TAKE THE GROUP WITH IT. Returning `Err` here
         * drops the `Daemon`, and `kill_on_drop` sends SIGKILL to the LEADER
         * only — so a `lemond` that had already spawned a backend left it
         * holding the GPU and the model's several gigabytes, with nothing left
         * that knew its pid. Found by audit; the `?` shorthand was the bug. */
        if let Err(failure) = daemon.await_ready().await {
            daemon.stop().await;
            return Err(failure);
        }
        daemon.note_websocket_port();
        Ok(daemon)
    }

    /// Poll health until it answers or the deadline passes.
    async fn await_ready(&mut self) -> Result<()> {
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        loop {
            // A child that has already exited will never answer, and waiting
            // out the full deadline to say so wastes thirty seconds of the
            // reader's time on a question already settled.
            if let Some(status) = self.child.try_wait()? {
                return Err(Error::RuntimeExited {
                    status: status.to_string(),
                    tail: self.log.text(),
                });
            }
            /* THE STATUS IS CHECKED, not merely the parse. Every field of
             * `Health` has a `#[serde(default)]` — which is right, because
             * upstream adds fields — but it also means `{}` deserializes
             * happily, so "the route answered with valid JSON" was being read
             * as "the daemon is ready". A proxy, a captive portal or a
             * half-initialised server can all produce that. */
            if let Ok(health) = self.health().await {
                if health.status == "ok" {
                    self.websocket_port = health.websocket_port;
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(Error::NotReady {
                    secs: READY_TIMEOUT.as_secs(),
                    tail: self.log.text(),
                });
            }
            tokio::time::sleep(POLL_EVERY).await;
        }
    }

    /// Note the WebSocket port the daemon chose for itself.
    ///
    /// ⚠️ **THERE IS NO RUNTIME CHECK HERE, AND TWO ATTEMPTS AT ONE WERE BOTH
    /// WRONG.** This is worth recording, because the third attempt would be
    /// wrong the same way.
    ///
    /// The daemon starts a WebSocket server on a port it picks itself, and
    /// `websocket_port: 0` does NOT turn it off — verified against 11.7.0,
    /// which chose 9000. What it DOES do is inherit `--host`, so with the host
    /// pinned to the loopback the socket is loopback-only.
    ///
    /// The first attempt connected to `127.0.0.1:<port>` and, on success,
    /// declared the socket loopback-only. That passes for a WILDCARD-bound
    /// socket too — which accepts loopback connections — so it passed in
    /// exactly the case it existed to catch.
    ///
    /// The second attempt tried to bind `0.0.0.0:<port>` and treated
    /// `AddrInUse` as proof of a wildcard listener. That is worse: a socket
    /// legitimately bound to `127.0.0.1:<port>` ALSO makes that bind fail, so
    /// the check rejected every healthy daemon. It shipped for one round and
    /// an audit caught it — an availability failure introduced by a fix for a
    /// security check that was not load-bearing.
    ///
    /// The honest position: a process cannot portably learn another process's
    /// bind address without walking the OS socket table, which is three
    /// platform implementations for a property already enforced upstream of
    /// it. **The enforcement is the `--host` pin in `spawn.rs`**, which is
    /// set on both the CLI and the config, has a test that fails when it is
    /// removed, and was confirmed by `lsof`/`Get-NetTCPConnection` on macOS,
    /// Linux and Windows during WI-15.3 — 127.0.0.1 on all three.
    ///
    /// A check that cannot fail proves nothing; a check that fails when it
    /// should not is worse than none. So this records the port for
    /// diagnostics and asserts nothing it cannot establish.
    fn note_websocket_port(&self) {
        if let Some(port) = self.websocket_port {
            log::info!(
                "inference: the runtime's websocket chose port {port}; it inherits --host, which is pinned to {}",
                crate::spawn::LOOPBACK
            );
        }
    }

    /// The daemon's health, authenticated.
    pub async fn health(&self) -> Result<Health> {
        self.get_json(HEALTH_ROUTE).await
    }

    /// The health request, built but not sent.
    ///
    /// For a caller that must not hold the daemon's mutex across the wait —
    /// `inference_resource_usage` is polled while a generation streams, and
    /// waiting on the same lock made a memory reading queue behind an answer.
    pub fn health_request(&self) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::GET, HEALTH_ROUTE)
    }

    /// Send a request built by [`Daemon::health_request`] and read the answer.
    pub async fn read_health(request: reqwest::RequestBuilder) -> Result<Health> {
        let response = request
            .send()
            .await
            .map_err(|e| unreachable(HEALTH_ROUTE, e))?;
        Self::parse(HEALTH_ROUTE, response).await
    }

    /// A GET against the daemon, with the bearer token attached.
    pub async fn get_json<T: serde::de::DeserializeOwned>(&self, route: &str) -> Result<T> {
        let response = self
            .request(reqwest::Method::GET, route)
            .send()
            .await
            .map_err(|e| unreachable(route, e))?;
        Self::parse(route, response).await
    }

    /// A POST against the daemon, with the bearer token attached.
    pub async fn post_json<B: serde::Serialize, T: serde::de::DeserializeOwned>(
        &self,
        route: &str,
        body: &B,
    ) -> Result<T> {
        let response = self
            .request(reqwest::Method::POST, route)
            .json(body)
            .send()
            .await
            .map_err(|e| unreachable(route, e))?;
        Self::parse(route, response).await
    }

    /// A request builder pointed at `route`, carrying the token.
    ///
    /// `route` is always a literal in this crate — there is no path a caller
    /// supplies, which is the same closed-set discipline the argv follows.
    ///
    /// ⚠️ **CONTROL PLANE.** Ten seconds, total. Anything a MODEL answers goes
    /// through [`Daemon::model_request`] instead; this one's deadline would cut
    /// the answer off mid-stream.
    pub fn request(&self, method: reqwest::Method, route: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{route}", self.plan.base_url()))
            .bearer_auth(&self.plan.env[crate::spawn::API_KEY_ENV])
    }

    /// The same, for a request a MODEL answers — a generation, a gloss, an
    /// utterance.
    ///
    /// Three call sites, all of them in `commands.rs`, and the split is by what
    /// answers rather than by route so that a fourth long-running command
    /// cannot inherit the control plane's deadline by accident. See
    /// `MODEL_SILENCE`.
    pub fn model_request(&self, method: reqwest::Method, route: &str) -> ModelRequest {
        let built = self
            .model_client
            .request(method, format!("{}{route}", self.plan.base_url()))
            // BOTH BOUNDS. `read_timeout` on the client catches silence;
            // this catches a request that never stops making just enough
            // progress to reset it. See `MODEL_CEILING`.
            .timeout(MODEL_CEILING)
            .bearer_auth(&self.plan.env[crate::spawn::API_KEY_ENV]);
        ModelRequest(built)
    }

    // (see `ModelRequest` below for why `model_request` returns a newtype)

    async fn parse<T: serde::de::DeserializeOwned>(
        route: &str,
        response: reqwest::Response,
    ) -> Result<T> {
        let status = response.status();
        if !status.is_success() {
            // The body is DISCARDED rather than attached — see `error.rs`.
            return Err(Error::RuntimeHttp {
                status: status.as_u16(),
                route: route.to_owned(),
            });
        }
        response
            .json::<T>()
            .await
            .map_err(|e| crate::error::malformed(route, e.to_string()))
    }

    /// The daemon's base URL, for the streaming paths that build their own
    /// request. Loopback, always.
    pub fn base_url(&self) -> String {
        self.plan.base_url()
    }

    /// The plan this daemon was launched from.
    pub fn plan(&self) -> &SpawnPlan {
        &self.plan
    }

    /// The child's recent output, for a diagnostic.
    pub fn log_tail(&self) -> String {
        self.log.text()
    }

    /// Stop the whole tree: ask, wait, then insist.
    ///
    /// Idempotent and never fails: a `stop` that returns an error gives the
    /// caller nothing to do — the app is exiting — and an error path here
    /// would be a reason for someone to skip calling it.
    pub async fn stop(mut self) {
        if let Err(err) = crate::procgroup::terminate(&self.child) {
            log::warn!("inference: could not signal the runtime group: {err}");
        }
        let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(err) => {
                    log::warn!("inference: could not wait on the runtime: {err}");
                    break;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                log::warn!(
                    "inference: the runtime did not exit within {}s; killing the group",
                    SHUTDOWN_GRACE.as_secs()
                );
                break;
            }
            tokio::time::sleep(POLL_EVERY).await;
        }
        /* THE GROUP IS KILLED WHETHER OR NOT THE LEADER EXITED, and this is
         * the whole point of the module. The loop above used to `return` the
         * moment `lemond` itself was gone — but `lemond` is a supervisor, and
         * a backend that ignored SIGTERM outlives its parent. Returning early
         * meant the group never received SIGKILL and the model stayed
         * resident. SIGKILL to an empty group is a harmless ESRCH. */
        if let Err(err) = crate::procgroup::kill(&mut self.child, self.group).await {
            log::warn!("inference: could not kill the runtime group: {err}");
        }
    }
}

/// What `/api/v1/health` answers. Only the fields Paper acts on.
///
/// Deliberately partial, and `#[serde(default)]` throughout: the daemon
/// reports pinned-model counts, per-modality ceilings and a telemetry block
/// that Paper has no use for, and a struct that named them would need
/// changing every time upstream added one.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Health {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub model_loaded: Option<String>,
    #[serde(default)]
    pub websocket_port: Option<u16>,
}

/// Drain one of the child's pipes into the tail, line by line.
fn spawn_reader<R>(pipe: R, log: LogTail)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        /* `read_until` OVER BYTES, not `lines()`. `lines()` yields
         * `Err(InvalidData)` on a byte sequence that is not UTF-8 and the
         * `while let Ok(..)` above ENDED THE LOOP there — leaving the pipe
         * undrained, so the child blocked on its next write once the buffer
         * filled and the daemon simply stopped. A backend that prints a raw
         * byte in a progress bar is enough. The tail is diagnostics, so a
         * lossy conversion is exactly right here. */
        let mut reader = BufReader::new(pipe);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer).await {
                Ok(0) => break,
                Ok(_) => {
                    while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                        buffer.pop();
                    }
                    log.push(String::from_utf8_lossy(&buffer).into_owned());
                }
                Err(_) => break,
            }
        }
    });
}

/// A request the MODEL client built, and the only thing a model answer can be
/// read from.
///
/// ⚠️ **THIS IS THE THIRD ATTEMPT AT ONE INVARIANT, AND THE FIRST THAT HOLDS.**
/// The rule is that a request a model answers must not carry the control
/// plane's ten-second total deadline. Two source-scanning tests tried to
/// enforce it and a verify pass defeated both: the first hard-coded three
/// command names, so it could not see a fourth; the second matched hard-coded
/// route constants, so a command on a new route walked past it. The third
/// asked whether `commands.rs` contained the text `.request(reqwest::Method`
/// — and `post_json`/`get_json` reach the control-plane client without ever
/// writing that text, as does an aliased import or a line break in the middle
/// of the call.
///
/// Every one of them failed the same way: a scan can only ask about the shapes
/// somebody thought of. So this is a TYPE. `generate::stream` and
/// `speech::collect` take a `ModelRequest`; the field is private to this
/// module, so `Daemon::model_request` is the only thing in the crate that can
/// make one, and an attempt to forge one elsewhere is `E0423`.
///
/// ⚠️ **BE EXACT ABOUT WHAT THAT BUYS, because the first version of this
/// comment was not.** It said routing a model answer through the control-plane
/// client is a compile error. It is not, and a verify pass produced the
/// counter-example: `daemon.request(POST, generate::CHAT_ROUTE).json(&b).send()`
/// compiles, and so does `post_json` on a model route. Both bypass
/// `stream`/`collect` entirely and never mention this type.
///
/// What the type actually guarantees is narrower and still worth having: **an
/// answer cannot be READ as a model answer unless the request came from the
/// model client.** Every model-answered path in this crate goes through
/// `stream` or `collect`, so the guarantee covers all of them today; what it
/// cannot do is stop somebody hand-rolling a fourth path that reads a response
/// itself. That is a smaller hole than the three scans left, and unlike them
/// it is written down accurately.
///
/// `post_json` and `get_json` stay on the control plane deliberately — health
/// and endpoint registration are exactly what that deadline is for.
pub struct ModelRequest(reqwest::RequestBuilder);

impl ModelRequest {
    /// Attach the JSON body, staying a `ModelRequest`.
    pub fn json<T: serde::Serialize + ?Sized>(self, value: &T) -> Self {
        ModelRequest(self.0.json(value))
    }

    /// Hand the builder to whatever reads the answer.
    ///
    /// `pub(crate)` rather than `pub`: `generate` and `speech` need it and
    /// nothing outside this crate does. It does not weaken the invariant —
    /// what matters is that the CONSTRUCTOR is unreachable, and a private
    /// tuple field makes it so for every module but this one.
    pub(crate) fn into_builder(self) -> reqwest::RequestBuilder {
        self.0
    }

    /// Build one from a bare builder, for a test that has no daemon.
    ///
    /// `#[cfg(test)]`, so it does not exist in a shipped build and cannot
    /// weaken the invariant the type is here to hold: in production
    /// `Daemon::model_request` remains the only constructor. A test that wants
    /// to exercise `stream`/`collect` against a dead address has no daemon to
    /// ask, and making it spawn one to check a cancellation would be a worse
    /// test for no gain.
    #[cfg(test)]
    pub(crate) fn from_builder_for_test(builder: reqwest::RequestBuilder) -> Self {
        ModelRequest(builder)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three commands a model answers really do go through the model
    /// client — non-vacuity for `ModelRequest`, and nothing more than that.
    ///
    /// ⚠️ **THIS TEST NO LONGER ENFORCES THE RULE, AND SAYING SO IS THE POINT.**
    /// Three earlier versions claimed to, and a verify pass defeated each in
    /// turn: hard-coded command names could not see a fourth command;
    /// hard-coded route constants could not see a new route; and a scan for
    /// `.request(reqwest::Method` could not see `post_json`, an aliased
    /// import, or a line break in the middle of the call. A guard that says it
    /// is closed and is not is worse than no guard, because the next person
    /// reads the comment rather than the code.
    ///
    /// `ModelRequest` holds the invariant now, at compile time, for every path
    /// that READS a model answer — see its docstring, which is careful about
    /// what that does and does not cover.
    ///
    /// What is left here is weaker than "the wiring is live", and the earlier
    /// wording overclaimed that too: this only finds the substring
    /// `model_request(` inside a roughly delimited function body, so a comment
    /// or a dead branch would satisfy it. It is a smoke check against the
    /// three commands silently losing their model client in a refactor, and
    /// the compiler and `ModelRequest` are what actually hold the rule.
    #[test]
    fn the_commands_a_model_answers_are_wired_to_the_model_client() {
        let source = include_str!("commands.rs");
        let mut answered = Vec::new();
        for (at, _) in source.match_indices("pub async fn ") {
            let name: String = source[at + "pub async fn ".len()..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            let body_end = source[at..]
                .find("\n}\n")
                .map(|end| at + end)
                .unwrap_or(source.len());
            if source[at..body_end].contains("model_request(") {
                answered.push(name);
            }
        }
        for expected in ["inference_generate", "inference_gloss", "inference_speak"] {
            assert!(
                answered.iter().any(|name| name == expected),
                "{expected} no longer reaches a model through the model client; found {answered:?}"
            );
        }
    }

    #[test]
    fn the_log_tail_is_bounded_and_keeps_the_end() {
        let log = LogTail::default();
        for i in 0..(LOG_TAIL_LINES * 3) {
            log.push(format!("line {i}"));
        }
        let text = log.text();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(
            lines.len(),
            LOG_TAIL_LINES,
            "a looping daemon must not grow this"
        );
        assert_eq!(
            *lines.last().unwrap(),
            format!("line {}", LOG_TAIL_LINES * 3 - 1),
            "the END is what a failure needs, not the beginning"
        );
    }

    #[test]
    fn an_empty_tail_renders_as_nothing_rather_than_panicking() {
        assert_eq!(LogTail::default().text(), "");
    }

    /// Health parses from the shape 11.7.0 actually answered with, captured
    /// from the smoke test rather than written from the documentation.
    #[test]
    fn health_parses_the_observed_shape() {
        let observed = serde_json::json!({
            "all_models_loaded": [],
            "max_models": { "llm": 1, "tts": 1 },
            "model_loaded": null,
            "pinned_helper_models": { "llm": 0 },
            "pinned_models": { "llm": 0 },
            "status": "ok",
            "telemetry": { "enabled": false },
            "update_check_done": true,
            "version": "11.7.0",
            "websocket_port": 9000
        });
        let health: Health = serde_json::from_value(observed).unwrap();
        assert_eq!(health.status, "ok");
        assert_eq!(health.version, "11.7.0");
        assert_eq!(health.websocket_port, Some(9000));
        assert_eq!(health.model_loaded, None);
    }

    /// ⚠️ AN EMPTY OBJECT PARSES, AND MUST NOT READ AS READY. Every field
    /// carries `#[serde(default)]` — which is right, because upstream adds
    /// fields — but it also means `{}` deserializes happily, so "the route
    /// answered with valid JSON" was being taken for "the daemon is ready".
    /// A proxy, a captive portal or a half-initialised server all produce
    /// that. `await_ready` now requires `status == "ok"`; this pins the
    /// property the check rests on.
    #[test]
    fn an_empty_health_object_is_not_ok() {
        let empty: Health = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_ne!(empty.status, "ok", "an empty body must never read as ready");

        let wrong: Health =
            serde_json::from_value(serde_json::json!({ "status": "starting" })).unwrap();
        assert_ne!(wrong.status, "ok");

        let good: Health = serde_json::from_value(serde_json::json!({ "status": "ok" })).unwrap();
        assert_eq!(good.status, "ok");
    }

    /// The log tail must survive a byte sequence that is not UTF-8: `lines()`
    /// ended the loop there, leaving the pipe undrained so the child blocked
    /// on its next write and the daemon simply stopped.
    #[test]
    fn the_log_tail_takes_text_that_is_not_valid_utf8() {
        let log = LogTail::default();
        log.push(String::from_utf8_lossy(&[b'a', 0xFF, 0xFE, b'b']).into_owned());
        let text = log.text();
        assert!(text.contains('a') && text.contains('b'));
        assert!(
            text.contains('\u{FFFD}'),
            "the bad bytes are replaced, not dropped"
        );
    }

    /// A future version that adds fields, or drops ones Paper does not read,
    /// must not fail the launch.
    #[test]
    fn health_tolerates_a_changed_upstream_shape() {
        let sparse: Health = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(sparse.status, "");
        assert_eq!(sparse.websocket_port, None);

        let extra: Health = serde_json::from_value(serde_json::json!({
            "status": "ok",
            "something_upstream_added_later": { "nested": true }
        }))
        .unwrap();
        assert_eq!(extra.status, "ok");
    }
}
