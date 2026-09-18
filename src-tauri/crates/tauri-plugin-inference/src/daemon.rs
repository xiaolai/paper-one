//! The supervised `llama-server`: start it, prove it is ready, talk to it,
//! stop it. ("The daemon" throughout this crate, a name it kept from the
//! `lemond` it replaced on 2026-09-18 — see `spawn.rs`.)
//!
//! One process, owned outright. Paper mints its credential, launches it into
//! its own process group, waits for it to answer its own health route, and
//! takes the whole group down again on the way out. Nothing here is a general
//! runner: the program is the verified server (`runtime.rs`), the argv is
//! `spawn::plan_spawn`'s closed list, and no caller supplies either.
//!
//! # Readiness is asked, never assumed
//!
//! `spawn` returning is not readiness — the server binds its socket some way
//! into startup and then LOADS THE MODEL, answering `/health` with 503 until it
//! has. A request made before that fails in a way that looks nothing like
//! "still starting". So [`Daemon::start`] polls `/health` until it answers
//! `ok` or the deadline passes, and a deadline that passes carries the child's
//! own log tail, because the useful half of that failure is always what the
//! child said before giving up.
//!
//! # The key never leaves this process
//!
//! F5: the webview renders untrusted book HTML. Handing it the key to get
//! native `fetch` streaming would hand book HTML the reader's model — and, on
//! the runtime this replaced, a backend installer. So the key is minted here,
//! lives in this struct, and every request to the server is made by this
//! module. The webview gets typed commands and a `Channel`, and no URL it
//! chooses.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::error::{unreachable, Error, Result};
use crate::lineage::{GroupHold, GroupRecord, OsProcesses, Processes};
use crate::spawn::SpawnPlan;

/// How long to wait for the server to answer its health route `ok` before
/// giving up on the launch.
///
/// ⚠️ **IT WAS 30 s, AND THE MODEL LOAD WAS NOT INSIDE IT.** lemond answered
/// its health route in 0.1–0.2 s and loaded the model on the first REQUEST,
/// so the 2.5 GB read was paid inside `GLOSS_CEILING` (90 s) by the reader's
/// first lookup. `llama-server` loads at start and says `ok` only after, so the
/// load moved here and the budget moved with it. Measured on an M5 (2026-09-18):
/// 0.5–0.9 s warm, 7.9 s for a first launch. Ninety is for the reader on a slow
/// disk, who should get a working app rather than a failure a retry fixes.
///
/// A launch that has genuinely FAILED does not wait this out: a child that
/// exits is noticed on the next poll, with its own last words attached.
const READY_TIMEOUT: Duration = Duration::from_secs(90);

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
/// A generation's answer arrives a token at a time, and on a machine that has
/// been busy for a minute it arrives slowly: measured on a fanless M5, decode
/// fell from 45 to about 10 tokens a second after 100 s of sustained work. A
/// total ten-second deadline cuts that answer off mid-sentence.
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
/// about three and a half minutes — twice that if it queued behind another on
/// the server's one slot (`-np 1`). Nothing legitimate approaches ten minutes;
/// a request that does is wedged.
///
/// It is a REQUEST-level override, so it coexists with the client's
/// `read_timeout` rather than replacing it — verified in reqwest 0.13.4, where
/// `read_timeout` lives on the client config and is applied independently of
/// the per-request deadline. Two different questions: "has it gone quiet?" and
/// "has this gone on too long?"
pub(crate) const MODEL_CEILING: Duration = Duration::from_secs(600);

/// The ceiling on a GLOSS, which is a different question from the one above.
///
/// ⚠️ **`MODEL_CEILING` WAS THE ONLY BOUND ON A LOOKUP**, and every word of its
/// reasoning is about a generation: 1024 tokens at five a second, plus a cold
/// model load. A gloss asks for 160 tokens and `core/gloss.ts` says why the
/// number cannot simply be inherited — *"it is wanted in milliseconds because a
/// reader has stopped reading to wait for it."* Ten minutes of **Looking…**
/// beside a word, with dismiss as the only way out, is not a bound on that; it
/// is the absence of one wearing the companion's clothes.
///
/// Ninety seconds, against the work in the same way the ten minutes was:
/// 160 tokens at a slow five per second is half a minute, and the server has
/// ONE slot, so a lookup can wait behind whatever else is being answered. It
/// is not the one to three seconds a gloss actually costs on a cool machine.
/// Past this the server is wedged, and the reader has been staring at a
/// spinner for a minute and a half.
///
/// (It used to be sized for a cold 2.5 GB model load too, which the first
/// gloss paid under lemond. The load happens at start now — `READY_TIMEOUT`.)
///
/// A REQUEST-level override, like `MODEL_CEILING`, so it coexists with the
/// client's `read_timeout` — and it is BELOW `MODEL_SILENCE` (120s), which
/// means a gloss that goes quiet is answered by this rather than waiting out a
/// silence window sized for a streamed reply.
pub const GLOSS_CEILING: Duration = Duration::from_secs(90);

/// How long the tree gets to shut down cleanly before it is killed.
///
/// The server frees the model and its GPU allocations on the way out, and a
/// loaded 2.5 GB model takes a moment to let go of. Past this, the reader
/// closing the app matters more than a clean unload. (lemond overran it on
/// every stop measured, pausing two seconds of its own for "GPU driver
/// cleanup".)
///
/// `pub(crate)`: the launch-time recovery of a group a previous Paper left
/// running (`lineage.rs`) gives it the same grace, for the same reason.
pub(crate) const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// How many lines of the child's output to keep.
///
/// Only ever shown attached to a failure, and only ever from this process —
/// it is not a log file and nothing persists it. Bounded because a server
/// that fails in a loop would otherwise grow this without limit.
const LOG_TAIL_LINES: usize = 40;

/// A running daemon.
pub struct Daemon {
    child: Child,
    /// The process group, captured at spawn — see `procgroup::group_of`;
    /// `Child::id()` is `None` after a reap, and the grace loop reaps — and
    /// the record on disk that names it. Both go when this does, by ANY
    /// route: `stop` is the ordered teardown, and the hold's `Drop` is what
    /// still runs when a future is cancelled mid-await or a panic unwinds
    /// through here (WI-20.23).
    hold: GroupHold,
    plan: SpawnPlan,
    client: reqwest::Client,
    /// The client for requests a MODEL answers — see `MODEL_SILENCE`.
    model_client: reqwest::Client,
    log: LogTail,
    /// The pipe readers, kept so an error tail can WAIT for the last lines
    /// — see [`Daemon::drain_readers`]. Dropping a handle detaches the task,
    /// which is exactly what the drain does after its bounded wait.
    readers: Vec<tokio::task::JoinHandle<()>>,
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

/// The server's health route, named once.
///
/// UNAUTHENTICATED in llama-server — it and `/v1/models` answer without the
/// key, deliberately upstream — so a health answer proves the server is up
/// and says NOTHING about whether the key works. The request still carries
/// it, which costs nothing and keeps one request builder.
const HEALTH_ROUTE: &str = "/health";

impl Daemon {
    /// Launch the child and wait for it to answer.
    pub async fn start(plan: SpawnPlan) -> Result<Daemon> {
        /* THE PLAN CARRIES THE KEY, checked at the door. `request` and
         * `model_request` index `env[API_KEY_ENV]`, and a plan without it
         * would panic THERE — mid-question, far from whoever built the plan.
         * Plans are built by `spawn.rs`, which always sets it; this turns a
         * future construction bug into a loud failure at start, where the
         * stack still names the culprit. */
        assert!(
            plan.env.contains_key(crate::spawn::API_KEY_ENV),
            "SpawnPlan carries no {} — spawn.rs always sets it",
            crate::spawn::API_KEY_ENV
        );

        let mut cmd = Command::new(&plan.program);
        cmd.args(&plan.args).current_dir(&plan.working_dir);
        /* ⚠️ CLEARED FIRST, SET SECOND — the order is the guarantee. Paper's
         * own `LLAMA_API_KEY` sits in the namespace being cleared, and
         * `Command` keeps the LAST instruction per variable, so an inherited
         * key is replaced and never survives beside ours. A name that is not
         * Unicode cannot be one llama.cpp reads: it asks `getenv` for ASCII
         * literals. */
        let inherited = std::env::vars_os().filter_map(|(name, _)| name.into_string().ok());
        for name in plan.inherited_removals(inherited) {
            cmd.env_remove(name);
        }
        for (key, value) in &plan.env {
            cmd.env(key, value);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // A Paper that EXITS must not leave a daemon holding the port.
            // This is the backstop under the ordered shutdown, not a
            // replacement for it — and it does nothing for a Paper that is
            // killed, which `lineage.rs` and the death signal below are for.
            .kill_on_drop(true);
        crate::procgroup::configure(&mut cmd);
        arm_death_signal(&mut cmd);

        let mut child = spawn_child(cmd).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::RuntimeMissing(plan.program.clone())
            } else {
                Error::Io(e)
            }
        })?;

        /* ⚠️ The child RUNS before this assignment lands — a Windows process
         * cannot be spawned pre-assigned to a Job Object without the
         * suspended-thread dance (CREATE_SUSPENDED, assign, ResumeThread),
         * which this crate does not attempt. In the microseconds between
         * spawn and hold, a descendant could be spawned outside the job.
         * Accepted: `llama-server` in single-model mode forks nothing, and
         * the recovery record below covers the group by identity anyway. */
        #[cfg(windows)]
        let job = crate::procgroup::JobHandle::hold(&child)?;

        /* WRITTEN BEFORE ANYTHING IS AWAITED. A Paper killed between here
         * and readiness has still spawned a group, and the record is the
         * only thing the next launch can find it by. Best-effort: a record
         * that could not be written is logged, and the daemon still runs —
         * the reader asked for an answer, not for bookkeeping. */
        let group = crate::procgroup::group_of(&child);
        let leader = child.id().unwrap_or(0);
        let record = GroupRecord {
            pgid: group.unwrap_or(leader),
            leader_pid: leader,
            leader_started_at: OsProcesses.started_at(leader).unwrap_or(0),
            exe: plan.program.clone(),
            port: plan.port,
        };
        if let Err(err) = crate::lineage::write_record(&plan.record_path, &record) {
            log::warn!(
                "inference: could not record the runtime's process group at {}: {err}",
                plan.record_path.display()
            );
        }
        let hold = GroupHold::new(group, plan.record_path.clone());

        let log = LogTail::default();
        // Both pipes are drained. Not for the log alone: a child whose stdout
        // pipe fills up BLOCKS, and a daemon that stops making progress
        // because nobody is reading its chatter is a hang with no symptom.
        // The handles are KEPT so an error path can wait for the tail —
        // `try_wait` can observe the exit while the readers still hold the
        // final, usually most useful, lines.
        let mut readers = Vec::new();
        if let Some(out) = child.stdout.take() {
            readers.push(spawn_reader(out, log.clone()));
        }
        if let Some(err) = child.stderr.take() {
            readers.push(spawn_reader(err, log.clone()));
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

        let mut daemon = Daemon {
            child,
            hold,
            plan,
            client,
            model_client,
            log,
            readers,
            #[cfg(windows)]
            _job: job,
        };
        /* A STARTUP FAILURE MUST TAKE THE GROUP WITH IT. Returning `Err` here
         * drops the `Daemon`, and `kill_on_drop` sends SIGKILL to the LEADER
         * only — so a `lemond` that had already spawned a backend left it
         * holding the GPU and the model's several gigabytes, with nothing left
         * that knew its pid. Found by audit; the `?` shorthand was the bug.
         * `llama-server` forks nothing, and the group is still what is
         * stopped: the rule is about what the code can promise, not about
         * which program happens to be behind it today. */
        if let Err(failure) = daemon.await_ready().await {
            daemon.stop().await;
            return Err(failure);
        }
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
                self.drain_readers().await;
                return Err(Error::RuntimeExited {
                    status: status.to_string(),
                    tail: self.log.text(),
                });
            }
            /* THE STATUS IS CHECKED, not merely the parse. `Health` has a
             * `#[serde(default)]` — which is right, because upstream adds
             * fields — but it also means `{}` deserializes happily, so "the
             * route answered with valid JSON" was being read as "the daemon is
             * ready". A proxy, a captive portal or a half-initialised server
             * can all produce that. And while the model LOADS, llama-server
             * answers 503 — an `Err` here, so the poll simply goes round. */
            /* BOUNDED BY THE DEADLINE, not just checked against it. The
             * health client's own timeout is ten seconds, so a request
             * STARTED just before the deadline used to overshoot it by up to
             * that much — `READY_TIMEOUT` read as a suggestion. `timeout_at`
             * cuts the in-flight request at the line. */
            if let Ok(Ok(health)) = tokio::time::timeout_at(deadline, self.health()).await {
                if health.status == "ok" {
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                self.drain_readers().await;
                return Err(Error::NotReady {
                    secs: READY_TIMEOUT.as_secs(),
                    tail: self.log.text(),
                });
            }
            tokio::time::sleep_until(std::cmp::min(
                deadline,
                tokio::time::Instant::now() + POLL_EVERY,
            ))
            .await;
        }
    }

    /// Wait, briefly, for the pipe readers before quoting the tail.
    ///
    /// `try_wait` can observe the exit while the readers still hold the
    /// child's LAST buffered lines — usually the diagnostic that says why.
    /// Bounded, because a pipe inherited by a grandchild never reaches EOF;
    /// a reader that is still going after the wait is detached by the drop,
    /// exactly as it was when nothing held the handles at all.
    async fn drain_readers(&mut self) {
        for mut reader in self.readers.drain(..) {
            let _ = tokio::time::timeout(Duration::from_millis(250), &mut reader).await;
        }
    }

    /// The server's health. (The route is public; see `HEALTH_ROUTE`.)
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
            .bearer_auth(self.plan.api_key())
    }

    /// The same, for a request a MODEL answers — a generation or a gloss.
    ///
    /// Two call sites, both in `commands.rs`, and the split is by what answers
    /// rather than by route so that a third long-running command cannot
    /// inherit the control plane's deadline by accident. See `MODEL_SILENCE`.
    pub fn model_request(&self, method: reqwest::Method, route: &str) -> ModelRequest {
        let built = self
            .model_client
            .request(method, format!("{}{route}", self.plan.base_url()))
            // BOTH BOUNDS. `read_timeout` on the client catches silence;
            // this catches a request that never stops making just enough
            // progress to reset it. See `MODEL_CEILING`.
            .timeout(MODEL_CEILING)
            .bearer_auth(self.plan.api_key());
        ModelRequest(built, MODEL_CEILING)
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

    /// The plan this daemon was launched from.
    pub fn plan(&self) -> &SpawnPlan {
        &self.plan
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
         * moment `lemond` itself was gone — but `lemond` was a supervisor, and
         * a backend that ignored SIGTERM outlived its parent. Returning early
         * meant the group never received SIGKILL and the model stayed
         * resident. The leader is the server itself now; the group is killed
         * anyway, because SIGKILL to an empty group is a harmless ESRCH and a
         * leader that grows a child next year should not reopen this. */
        if let Err(err) = crate::procgroup::kill(&mut self.child, self.hold.group()).await {
            log::warn!("inference: could not kill the runtime group: {err}");
        }
        /* THE RECORD IS THE HOLD'S TO REMOVE, and only after a kill that was
         * delivered. This used to unlink it here, unconditionally, one line
         * after logging that the kill had failed — so an EPERM or a member
         * wedged in the kernel ended with a live group and its only key
         * thrown away, and the `GroupHold::drop` that runs as `self` falls
         * out of scope here could no longer preserve what was already gone.
         * `recover` learned this rule first (`lineage.rs`); the ordered path
         * saying it differently was the whole defect. */
    }
}

/// Arm a death signal on the child where the platform has one.
///
/// Linux: `PR_SET_PDEATHSIG(SIGKILL)` — the mechanism Lemonade used on the
/// `llama-server` it launched, and now Paper's own. Two things about it are easy to get wrong and are handled
/// here. First, the signal fires when the THREAD that forked the child dies,
/// not the process — so the child is spawned from a keeper thread that lives
/// for the process ([`spawn_child`]), never from a blocking-pool thread that
/// tokio retires after ten idle seconds. Second, it arms only from the
/// `prctl` on, so a parent that died between `fork` and `prctl` has already
/// reparented the child; `getppid` is re-checked against the pid captured
/// before the fork, and a child that finds a stranger there exits instead of
/// becoming the orphan this exists to prevent.
///
/// macOS has no such signal (verified: no `prctl.h` in the SDK); Windows has
/// the Job Object. Both are covered by the record and the hold instead.
#[cfg(target_os = "linux")]
fn arm_death_signal(cmd: &mut Command) {
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: the closure runs between fork and exec and calls only
    // async-signal-safe syscalls; it allocates nothing and touches no lock.
    unsafe {
        cmd.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(std::io::Error::other(
                    "the parent exited before the death signal was armed",
                ));
            }
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn arm_death_signal(_cmd: &mut Command) {}

/// A spawned child NOBODY HAS TAKEN RESPONSIBILITY FOR YET: dropping one
/// takes its whole process group down, and only the caller that actually
/// receives it disarms that.
///
/// ⚠️ **`send` RETURNING `Ok` IS NOT DELIVERY.** The keeper below used to
/// clean up on `Err` alone — the caller cancelled between asking and the
/// answer — but tokio's `oneshot::Sender::send` returns `Ok` the moment the
/// value is QUEUED and documents the receiver as free to drop immediately
/// afterwards. The queued `Child` is then dropped by the channel with
/// `kill_on_drop` and nothing else, which reaches the LEADER only: a leader
/// that had already forked a child (as `lemond` did) leaves it holding the
/// GPU, the model's several gigabytes and the port, with nothing left that
/// knows its pid. That is the same failure the whole `procgroup` module exists to
/// prevent, arriving through the one path that had no owner. So the group
/// travels ARMED and the handover is what disarms it — the state "spawned,
/// unowned, unkillable" is no longer a value this code can hold.
#[cfg(unix)]
struct ArmedChild {
    child: Option<Child>,
    /// Captured at spawn, for the reason `procgroup::group_of` gives.
    group: Option<u32>,
}

#[cfg(unix)]
impl ArmedChild {
    fn new(child: Child) -> ArmedChild {
        ArmedChild {
            group: crate::procgroup::group_of(&child),
            child: Some(child),
        }
    }

    /// The receiver owns the child now; there is nothing left to kill.
    fn disarm(mut self) -> Child {
        self.child.take().expect("an armed child is disarmed once")
    }
}

#[cfg(unix)]
impl Drop for ArmedChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if let Some(pgid) = self.group {
            // SAFETY: a plain syscall on two integers. ESRCH — the group is
            // already gone — is the outcome asked for and needs no branch.
            unsafe { libc::killpg(pgid as libc::pid_t, libc::SIGKILL) };
        }
        let _ = child.start_kill();
    }
}

/// Spawn the child from a thread that lives as long as the process.
///
/// On Unix every spawn goes through ONE keeper thread, started on first use
/// and never retired. The death signal above is the reason it exists — a
/// child whose forking thread has gone is a child whose death signal has
/// already fired, or never will — and it runs on macOS too, so the thread
/// and the channel are exercised on the platform the tests run on rather
/// than only on the one that needs them. `tokio::process::Command::spawn`
/// needs a runtime context for its reaper; the keeper enters the caller's.
///
/// The child crosses the channel as an [`ArmedChild`], which is what covers
/// a caller that goes away — by either half of that race; see the type.
#[cfg(unix)]
async fn spawn_child(cmd: Command) -> std::io::Result<Child> {
    use std::sync::OnceLock;
    use tokio::sync::oneshot;

    struct Job {
        cmd: Command,
        runtime: tokio::runtime::Handle,
        reply: oneshot::Sender<std::io::Result<ArmedChild>>,
    }

    static KEEPER: OnceLock<std::sync::mpsc::Sender<Job>> = OnceLock::new();

    let keeper = KEEPER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("inference-keeper".to_owned())
            .spawn(move || {
                for mut job in rx {
                    let _entered = job.runtime.enter();
                    /* Whatever comes back from `send` — the `Err` that hands
                     * the value straight back, or an `Ok` whose receiver
                     * never reads it — is a drop of an armed child, and the
                     * group goes with it. */
                    let _ = job.reply.send(job.cmd.spawn().map(ArmedChild::new));
                }
            })
            .expect("the inference keeper thread could not be started");
        tx
    });
    let (reply, answer) = oneshot::channel();
    keeper
        .send(Job {
            cmd,
            runtime: tokio::runtime::Handle::current(),
            reply,
        })
        .map_err(|_| std::io::Error::other("the inference keeper thread is gone"))?;
    answer
        .await
        .map_err(|_| std::io::Error::other("the inference keeper thread dropped the spawn"))?
        .map(ArmedChild::disarm)
}

#[cfg(windows)]
async fn spawn_child(mut cmd: Command) -> std::io::Result<Child> {
    cmd.spawn()
}

/// What `/health` answers `ok` with. Only the field Paper acts on.
///
/// `{"status":"ok"}` once the model is loaded; 503 with an error body while it
/// loads, which never reaches this parse. `#[serde(default)]`, because
/// upstream adds fields — which is also why an EMPTY object parses, and why
/// readiness asks for `ok` rather than for a parse.
///
/// (There were `version`, `model_loaded` and `websocket_port` here, all
/// lemond's. The version is the pinned build's now — `SpawnPlan::version` —
/// and the loaded model is the one the server was launched on.)
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Health {
    #[serde(default)]
    pub status: String,
}

/// Drain one of the child's pipes into the tail, line by line.
/// One retained line is capped here; the bytes past it are still CONSUMED —
/// the pipe must drain whatever the tail keeps — but dropped, with the line
/// marked. `read_until` had no cap at all, so one unterminated line (a
/// progress bar that never prints its newline, a looping backend) grew a
/// buffer without bound inside Paper's own process.
const LINE_CAP: usize = 64 * 1024;

fn spawn_reader<R>(pipe: R, log: LogTail) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        /* BYTES, not `lines()`. `lines()` yields `Err(InvalidData)` on a
         * byte sequence that is not UTF-8 and the old loop ENDED there —
         * leaving the pipe undrained, so the child blocked on its next write
         * once the buffer filled and the daemon simply stopped. A backend
         * that prints a raw byte in a progress bar is enough. The tail is
         * diagnostics, so a lossy conversion is exactly right here. */
        fn take_line(log: &LogTail, buffer: &mut Vec<u8>, truncated: &mut bool) {
            while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                buffer.pop();
            }
            let mut line = String::from_utf8_lossy(buffer).into_owned();
            if *truncated {
                line.push_str(" …[line truncated]");
            }
            log.push(line);
            buffer.clear();
            *truncated = false;
        }
        let mut reader = BufReader::new(pipe);
        let mut buffer: Vec<u8> = Vec::new();
        let mut truncated = false;
        loop {
            let (ended_line, consumed) = {
                let chunk = match reader.fill_buf().await {
                    Ok([]) => break,
                    Ok(chunk) => chunk,
                    Err(_) => break,
                };
                let (piece, ended, used) = match chunk.iter().position(|&b| b == b'\n') {
                    Some(at) => (&chunk[..at], true, at + 1),
                    None => (chunk, false, chunk.len()),
                };
                let room = LINE_CAP.saturating_sub(buffer.len());
                let keep = piece.len().min(room);
                buffer.extend_from_slice(&piece[..keep]);
                if keep < piece.len() {
                    truncated = true;
                }
                (ended, used)
            };
            reader.consume(consumed);
            if ended_line {
                take_line(&log, &mut buffer, &mut truncated);
            }
        }
        // The pipe closed mid-line: what it held is still the tail's business.
        if !buffer.is_empty() || truncated {
            take_line(&log, &mut buffer, &mut truncated);
        }
    })
}

/// The client for an endpoint's model requests — bounded by SILENCE, as the
/// daemon's model client is (see [`MODEL_SILENCE`]).
///
/// `proxied` is false for a loopback endpoint (`http://localhost…`): a system
/// proxy must never see a request for this machine, which carries the reader's
/// key and their question. A remote endpoint takes the reader's system proxy,
/// which is the only route to a provider some readers have.
pub(crate) fn endpoint_client(proxied: bool) -> Result<reqwest::Client> {
    let builder = reqwest::Client::builder()
        .read_timeout(MODEL_SILENCE)
        .user_agent(concat!("Paper/", env!("CARGO_PKG_VERSION")));
    let builder = if proxied { builder } else { builder.no_proxy() };
    builder
        .build()
        .map_err(|e| unreachable("endpoint client", e))
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
/// somebody thought of. So this is a TYPE. `generate::stream` takes a
/// `ModelRequest` (and `speech::collect` did, while there was one); the field
/// is private to this module, so `Daemon::model_request` is the only thing in the crate that can
/// make one, and an attempt to forge one elsewhere is `E0423`.
///
/// ⚠️ **BE EXACT ABOUT WHAT THAT BUYS, because the first version of this
/// comment was not.** It said routing a model answer through the control-plane
/// client is a compile error. It is not, and a verify pass produced the
/// counter-example: `daemon.request(POST, generate::CHAT_ROUTE).json(&b).send()`
/// compiles, and so does `post_json` on a model route. Both bypass
/// `stream` entirely and never mention this type.
///
/// What the type actually guarantees is narrower and still worth having: **an
/// answer cannot be READ as a model answer unless the request came from the
/// model client.** Every model-answered path in this crate goes through
/// `stream`, so the guarantee covers all of them today; what it cannot do is
/// stop somebody hand-rolling another path that reads a response itself. That is a smaller hole than the three scans left, and unlike them
/// it is written down accurately.
///
/// `post_json` and `get_json` stay on the control plane deliberately — health
/// and endpoint registration are exactly what that deadline is for.
pub struct ModelRequest(reqwest::RequestBuilder, Duration);

impl ModelRequest {
    /// Attach the JSON body, staying a `ModelRequest`.
    pub fn json<T: serde::Serialize + ?Sized>(self, value: &T) -> Self {
        ModelRequest(self.0.json(value), self.1)
    }

    /// Bring the deadline in below [`MODEL_CEILING`], for a caller whose work
    /// is smaller than the generation that number was reasoned about.
    ///
    /// ⚠️ **TIGHTEN ONLY, ENFORCED BY THE TYPE — AND IT USED TO BE ENFORCED BY
    /// A COMMENT.** The first version wrote `self.0.timeout(within.min(
    /// MODEL_CEILING))` behind a `debug_assert!` and claimed the name carried
    /// the rule. reqwest's `timeout` is last-call-wins, so
    /// `.deadline(90s).deadline(300s)` passed the assertion — both are under
    /// the ceiling — and left the request at FIVE MINUTES. The invariant held
    /// only for a single call, which is the one case that needs no invariant.
    /// Found by audit.
    ///
    /// The effective deadline is carried on the value now, so every call can
    /// only ever narrow what the last one left. A widening call is a no-op
    /// rather than a silent win.
    pub fn deadline(self, within: Duration) -> Self {
        let effective = within.min(self.1);
        ModelRequest(self.0.timeout(effective), effective)
    }

    /// The deadline this request will actually run under. For a test.
    #[cfg(test)]
    pub(crate) fn effective_deadline(&self) -> Duration {
        self.1
    }

    /// Hand the builder to whatever reads the answer.
    ///
    /// `pub(crate)` rather than `pub`: `generate` needs it and
    /// nothing outside this crate does. It does not weaken the invariant —
    /// what matters is that the CONSTRUCTOR is unreachable, and a private
    /// tuple field makes it so for every module but this one.
    pub(crate) fn into_builder(self) -> reqwest::RequestBuilder {
        self.0
    }

    /// A request an OPENAI-COMPATIBLE ENDPOINT answers (`cloud.rs`).
    ///
    /// THE SAME TWO BOUNDS as [`Daemon::model_request`], and that is why this
    /// constructor lives here rather than in `cloud.rs`: the invariant this type
    /// holds is "a model answer is read only from a request carrying both", and
    /// a second place that could build one would be a second place to forget
    /// one. The silence bound comes from [`endpoint_client`], the ceiling from
    /// here.
    ///
    /// `key` is `None` for a loopback endpoint the reader stored no key for —
    /// Ollama and LM Studio want none — and the request then carries no
    /// `Authorization` header at all rather than an empty one.
    pub(crate) fn to_endpoint(client: &reqwest::Client, url: String, key: Option<&str>) -> Self {
        let built = client.post(url).timeout(MODEL_CEILING);
        let built = match key {
            Some(key) => built.bearer_auth(key),
            None => built,
        };
        ModelRequest(built, MODEL_CEILING)
    }

    /// Build one from a bare builder, for a test that has no daemon.
    ///
    /// `#[cfg(test)]`, so it does not exist in a shipped build and cannot
    /// weaken the invariant the type is here to hold: in production
    /// `Daemon::model_request` remains the only constructor. A test that wants
    /// to exercise `stream` against a dead address has no daemon to
    /// ask, and making it spawn one to check a cancellation would be a worse
    /// test for no gain.
    #[cfg(test)]
    pub(crate) fn from_builder_for_test(builder: reqwest::RequestBuilder) -> Self {
        ModelRequest(builder, MODEL_CEILING)
    }
}

#[cfg(test)]
mod tests {
    /// ⚠️ **TIGHTEN ONLY, AND A `debug_assert!` DID NOT ENFORCE IT.** reqwest's
    /// `timeout` is last-call-wins, so two calls both under the ceiling left the
    /// request at whichever came second — the assertion passed and the deadline
    /// widened. The rule is on the value now.
    #[test]
    fn a_deadline_can_only_ever_narrow() {
        use std::time::Duration;
        let request = || {
            super::ModelRequest::from_builder_for_test(
                reqwest::Client::new().get("http://127.0.0.1:1/"),
            )
        };
        // It starts at the ceiling.
        assert_eq!(request().effective_deadline(), super::MODEL_CEILING);
        // One call tightens.
        assert_eq!(
            request()
                .deadline(super::GLOSS_CEILING)
                .effective_deadline(),
            super::GLOSS_CEILING
        );
        // A second, wider call does NOT widen — this is the case that used to.
        assert_eq!(
            request()
                .deadline(super::GLOSS_CEILING)
                .deadline(Duration::from_secs(300))
                .effective_deadline(),
            super::GLOSS_CEILING
        );
        // And nothing can exceed the ceiling from the start.
        assert_eq!(
            request()
                .deadline(Duration::from_secs(9_999))
                .effective_deadline(),
            super::MODEL_CEILING
        );
    }

    use super::*;

    /// The two commands a model answers really do go through the model
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
    /// two commands silently losing their model client in a refactor, and
    /// the compiler and `ModelRequest` are what actually hold the rule.
    #[test]
    fn the_commands_a_model_answers_are_wired_to_the_model_client() {
        let source = include_str!("commands.rs");
        let mut answered = Vec::new();
        for (at, _) in source.match_indices("async fn ") {
            let name: String = source[at + "async fn ".len()..]
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
        /* The gloss's local route is `gloss_locally` since Look up gained
        routes; an endpoint's model request is `cloud.rs`'s, built by
        `ModelRequest::to_endpoint`, and an agent is not an HTTP request. */
        for expected in ["inference_generate", "gloss_locally"] {
            assert!(
                answered.iter().any(|name| name == expected),
                "{expected} no longer reaches a model through the model client; found {answered:?}"
            );
        }
    }

    /// The keeper thread spawns for a runtime it is not on, and the child it
    /// hands back is one this runtime can wait on. A current-thread test
    /// runtime is the harder case: the reaper it registers with is driven by
    /// the very task that is awaiting the exit.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_keeper_thread_spawns_a_child_this_runtime_can_reap() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("exit 3");
        let mut child = spawn_child(cmd).await.expect("spawn through the keeper");
        let status = child.wait().await.expect("wait");
        assert_eq!(status.code(), Some(3));

        let mut again = Command::new("/bin/sh");
        again.arg("-c").arg("exit 4");
        let mut child = spawn_child(again).await.expect("the keeper is still there");
        assert_eq!(child.wait().await.unwrap().code(), Some(4));
    }

    /// AN ARMED CHILD NOBODY TOOK TAKES ITS GROUP WITH IT — the half of the
    /// keeper's race that `send` returning `Ok` hides. `kill_on_drop` alone
    /// would leave the grandchild running, which is exactly what this asserts
    /// against: a `sleep` in the leader's group stands in for a child the
    /// leader forked, as `lemond` forked its backend. Disarming is the other
    /// half: the caller that receives the child gets one nothing has
    /// signalled.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_armed_child_nobody_disarms_takes_its_group_down() {
        let dir = crate::testutil::ScratchDir::new("armed");
        let pidfile = dir.path().join("grandchild.pid");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", pidfile.display()));
        crate::procgroup::configure(&mut cmd);
        cmd.kill_on_drop(true);
        let armed = ArmedChild::new(cmd.spawn().expect("spawn"));

        let mut grandchild = 0;
        for _ in 0..250 {
            if let Ok(text) = tokio::fs::read_to_string(&pidfile).await {
                if let Ok(pid) = text.trim().parse::<i32>() {
                    grandchild = pid;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(grandchild > 0, "the helper shell never wrote its pidfile");
        // SAFETY: signal 0 delivers nothing; it only asks.
        assert_eq!(
            unsafe { libc::kill(grandchild, 0) },
            0,
            "the grandchild should be running before the drop"
        );

        drop(armed);

        let mut gone = false;
        for _ in 0..250 {
            if unsafe { libc::kill(grandchild, 0) } != 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            gone,
            "the grandchild survived: the drop signalled the leader, not the group"
        );

        // And a child that WAS handed over is untouched by the guard.
        let mut plain = Command::new("/bin/sh");
        plain.arg("-c").arg("exit 7");
        crate::procgroup::configure(&mut plain);
        let mut child = ArmedChild::new(plain.spawn().expect("spawn")).disarm();
        assert_eq!(child.wait().await.unwrap().code(), Some(7));
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

    /// Health parses from the shape b10375 actually answered with, captured
    /// from a running server rather than written from the documentation.
    #[test]
    fn health_parses_the_observed_shape() {
        let health: Health = serde_json::from_value(serde_json::json!({ "status": "ok" })).unwrap();
        assert_eq!(health.status, "ok");
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

    /// The READER must survive a byte sequence that is not UTF-8: `lines()`
    /// ended the loop there, leaving the pipe undrained so the child blocked
    /// on its next write and the daemon simply stopped. Driven through
    /// `spawn_reader` itself over a real async pipe — the earlier version of
    /// this test did the lossy conversion by hand and would have stayed green
    /// had the reader gone back to `lines()`.
    #[tokio::test]
    async fn the_reader_takes_text_that_is_not_valid_utf8_and_reads_on() {
        let log = LogTail::default();
        let (mut writer, reader) = tokio::io::duplex(64);
        let handle = spawn_reader(reader, log.clone());
        use tokio::io::AsyncWriteExt;
        writer
            .write_all(&[b'a', 0xFF, 0xFE, b'b', b'\n'])
            .await
            .unwrap();
        writer.write_all(b"after\n").await.unwrap();
        drop(writer);
        handle.await.unwrap();
        let text = log.text();
        assert!(text.contains('a') && text.contains('b'));
        assert!(
            text.contains('\u{FFFD}'),
            "the bad bytes are replaced, not dropped"
        );
        assert!(text.contains("after"), "the loop went on past them");
    }

    /// One unterminated line cannot grow without bound: past the cap the
    /// bytes are consumed — the pipe still drains — but dropped, and the
    /// retained line says it was cut. A line closed by EOF instead of a
    /// newline still reaches the tail.
    #[tokio::test]
    async fn an_endless_line_is_capped_and_marked_not_kept_whole() {
        let log = LogTail::default();
        let (mut writer, reader) = tokio::io::duplex(8 * 1024);
        let handle = spawn_reader(reader, log.clone());
        use tokio::io::AsyncWriteExt;
        let flood = vec![b'x'; LINE_CAP + 100_000];
        writer.write_all(&flood).await.unwrap();
        writer.write_all(b"\ntail-line\n").await.unwrap();
        writer.write_all(b"no-newline-at-eof").await.unwrap();
        drop(writer);
        handle.await.unwrap();
        let text = log.text();
        assert!(
            text.contains("…[line truncated]"),
            "{}",
            &text[..200.min(text.len())]
        );
        assert!(
            text.contains("tail-line"),
            "the reader kept going past the flood"
        );
        assert!(
            text.contains("no-newline-at-eof"),
            "an EOF-closed line still lands"
        );
        let longest = log.text().lines().map(str::len).max().unwrap_or(0);
        assert!(
            longest <= LINE_CAP + 32,
            "retained lines are bounded, got {longest}"
        );
    }

    /// A future version that adds fields, or drops ones Paper does not read,
    /// must not fail the launch.
    #[test]
    fn health_tolerates_a_changed_upstream_shape() {
        let sparse: Health = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(sparse.status, "");

        let extra: Health = serde_json::from_value(serde_json::json!({
            "status": "ok",
            "something_upstream_added_later": { "nested": true }
        }))
        .unwrap();
        assert_eq!(extra.status, "ok");
    }
}
