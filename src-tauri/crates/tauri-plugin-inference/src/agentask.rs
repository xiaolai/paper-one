//! One tool-free, read-only turn from an agent CLI (WI-15.6, WI-15.7).
//!
//! The plan is explicit about what Paper exposes of an agentic surface:
//! **tools off, one turn, no approvals, no resume, no working directory, no
//! library access.** Under those constraints an agent reduces to a grounded
//! question and a streamed answer, which is the one thing `ask` promises. The
//! day Paper wants a real coding-agent surface, that is a different interface
//! — not an extension of this one.
//!
//! # The lockdown is flags, and the flags were measured
//!
//! Every argument below was verified against the installed CLIs on
//! 2026-08-23. The finding that matters, because the obvious spelling is
//! wrong:
//!
//! **`claude --allowedTools ""` DOES NOT DISABLE TOOLS.** Run that way, the
//! session's `init` event still advertises `Bash`, `Edit`, `Write`, `Read`
//! and twenty more, and the reader's own hooks, plugins and skills load with
//! it. `--disallowed-tools "*"` is what actually yields `tools: []`, and
//! `--setting-sources ""` is what stops the reader's configuration — hooks
//! included — being loaded into a turn about a novel.
//!
//! An enumerated denylist was tried first and is the wrong shape: it left
//! seventeen tools standing, because anything the CLI adds later is enabled
//! by default and a list written today cannot name it. The wildcard is the
//! only spelling that closes by default rather than by enumeration.
//!
//! # The prompt goes on stdin, never in argv
//!
//! It carries book text — a chapter of a stranger's EPUB, numbered passages,
//! the reader's selection. argv is length-limited, appears in `ps` for every
//! user on the machine, and on some platforms is logged. stdin is private to
//! the process and unbounded.
//!
//! # Only the text crosses back
//!
//! Both CLIs emit far more than an answer. Claude's `init` event alone
//! carries the working directory, a session id, the model name, every
//! installed plugin's path under the reader's home directory, and the whole
//! slash-command list. Codex emits a thread id and token usage. **None of it
//! is forwarded.** The parsers below read exactly one field each and drop the
//! rest, for the same reason `agent.rs` gives no struct field to Claude's
//! email address: what is never carried in cannot later leak out.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::agent::Agent;
use crate::error::{Error, Result};
use crate::requests::Cancel;

/// How much the reader is willing to spend on one answer.
///
/// A CLOSED SET, and that is the whole security property: the two CLIs take a
/// model id and a reasoning effort as free strings, and this crate's contract
/// is that a caller names something from a set Paper controls — never a string
/// that reaches an argv. `Depth` is that set; nothing here interpolates.
///
/// The two adapters spend it on DIFFERENT AXES, because their CLIs offer
/// different ones, and both were measured on 2026-08-23:
///
/// - Codex takes `model_reasoning_effort`. At `low` a turn came back with
///   `reasoning_output_tokens: 0`; the supported values are the vendor's own
///   (`none, minimal, low, medium, high, xhigh, max`), which its API names in
///   the 400 it returns for anything else. That validation is at TURN time,
///   not at config-parse time — an invalid value costs a request before it
///   fails, which is the second reason this is an enum and not a string.
/// - Claude takes `--model`, whose aliases its own `--help` documents
///   (`fable`, `opus`, `sonnet`). `--model sonnet` reported
///   `model: claude-sonnet-5` in the init event with `tools: []` intact, so
///   the choice does not weaken the lockdown.
///
/// `Default` passes NO flag at all, which is the case that matters most: it
/// is the reader's own account default, the thing they are already paying
/// for, and Paper has no business overriding it unasked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Depth {
    #[default]
    Default,
    Faster,
    Thorough,
}

/// Build the argv for a tool-free, read-only, one-shot turn.
///
/// Pure, so every flag has a test that breaks when it is removed — the same
/// discipline `spawn.rs` applies to the daemon's configuration, and for the
/// same reason: these arguments are the whole of the sandbox.
pub fn turn_args(agent: Agent, workdir: &Path, depth: Depth) -> Vec<String> {
    let dir = workdir.to_string_lossy().into_owned();
    let mut args = match agent {
        Agent::Codex => vec![
            "exec".into(),
            // JSONL events rather than the human terminal UI. The plan
            // refuses to parse a TUI that changes between versions.
            "--json".into(),
            // No session files on disk. Paper offers no resume, so a
            // persisted thread would be state nothing can reach.
            "--ephemeral".into(),
            // Not the reader's ~/.codex/config.toml: it may add MCP servers,
            // a different model, or a sandbox policy Paper did not choose.
            "--ignore-user-config".into(),
            // Nor their execpolicy rules.
            "--ignore-rules".into(),
            // The working root is an empty directory (see `workdir`), which
            // is not a git repository — without this the run refuses.
            "--skip-git-repo-check".into(),
            "-s".into(),
            "read-only".into(),
            "-C".into(),
            dir,
            // The prompt arrives on stdin. See the module header.
            "-".into(),
        ],
        Agent::Claude => vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            // Token-by-token deltas rather than one block at the end.
            "--include-partial-messages".into(),
            // stream-json requires it.
            "--verbose".into(),
            // No user or project settings — and therefore no hooks. A
            // SessionStart hook firing because a reader asked about a novel
            // is somebody else's script in Paper's process tree.
            "--setting-sources".into(),
            String::new(),
            // No MCP servers, stated twice: an empty config AND strict mode,
            // so a project-level config cannot re-add them.
            "--strict-mcp-config".into(),
            "--mcp-config".into(),
            r#"{"mcpServers":{}}"#.into(),
            // No subagents.
            "--agents".into(),
            "{}".into(),
            // Deny everything, and allow nothing back.
            "--settings".into(),
            r#"{"permissions":{"deny":["*"],"allow":[]}}"#.into(),
            // THE ONE THAT ACTUALLY WORKS. See the module header.
            "--disallowed-tools".into(),
            "*".into(),
        ],
    };
    /* APPENDED, NOT WOVEN IN. The lockdown above is what every test in this
     * file asserts; adding the reader's choice at the end means no flag they
     * can pick sits between two flags that depend on each other's order, and
     * `Depth::Default` leaves the argv byte-for-byte what it has always
     * been. */
    match (agent, depth) {
        (_, Depth::Default) => {}
        (Agent::Codex, Depth::Faster) => {
            args.push("-c".into());
            args.push("model_reasoning_effort=low".into());
        }
        (Agent::Codex, Depth::Thorough) => {
            args.push("-c".into());
            args.push("model_reasoning_effort=high".into());
        }
        (Agent::Claude, Depth::Faster) => {
            args.push("--model".into());
            args.push("sonnet".into());
        }
        (Agent::Claude, Depth::Thorough) => {
            args.push("--model".into());
            args.push("opus".into());
        }
    }
    args
}

/// Codex's JSONL events, as much as Paper reads.
#[derive(Debug, Deserialize)]
struct CodexEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    item: Option<CodexItem>,
}

#[derive(Debug, Deserialize)]
struct CodexItem {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

/// Claude's stream-json events, as much as Paper reads.
#[derive(Debug, Deserialize)]
struct ClaudeEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    event: Option<ClaudeInner>,
}

#[derive(Debug, Deserialize)]
struct ClaudeInner {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    delta: Option<ClaudeDelta>,
}

#[derive(Debug, Deserialize)]
struct ClaudeDelta {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

/// Read one JSONL line from an agent. Returns the text to append, if any.
///
/// Pure and separately tested. Everything not named here is dropped — see the
/// module header for the list of what that includes.
///
/// # `Err` and `Ok(None)` are different answers
///
/// ⚠️ This returned `Option` and mapped a JSON parse failure to `None` with
/// `.ok()?`, which put "this event is not an answer" and "this is not the
/// protocol at all" in the same bucket. So a CLI whose output format had moved
/// — a version bump, a wrapper writing its own lines into the stream, a
/// truncated write — produced a turn that exited 0 with an empty or partial
/// answer and no indication anything had gone wrong. A partial answer is
/// indistinguishable from a complete one to every caller above, which is the
/// same argument the nonzero-exit branch makes.
///
/// `Ok(None)` is now only ever "valid JSON, not an answer event".
pub fn parse_line(agent: Agent, line: &str) -> Result<Option<String>> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let malformed = |message: String| Error::AgentMalformed {
        agent: agent.name(),
        message,
    };
    match agent {
        Agent::Codex => {
            let event: CodexEvent = serde_json::from_str(line)
                .map_err(|err| malformed(format!("unreadable event: {err}")))?;
            // `item.completed` carrying an `agent_message` is the answer.
            // `thread.started`, `turn.started` and `turn.completed` carry a
            // thread id and token usage, and are dropped.
            if event.kind != "item.completed" {
                return Ok(None);
            }
            let Some(item) = event.item else {
                return Ok(None);
            };
            Ok((item.kind == "agent_message")
                .then_some(item.text)
                .flatten())
        }
        Agent::Claude => {
            let event: ClaudeEvent = serde_json::from_str(line)
                .map_err(|err| malformed(format!("unreadable event: {err}")))?;
            // Only `stream_event` → `content_block_delta` → `text_delta`.
            // The `system`/`init`, `assistant` and `result` events carry the
            // working directory, session id, plugin paths and usage.
            if event.kind != "stream_event" {
                return Ok(None);
            }
            let Some(inner) = event.event else {
                return Ok(None);
            };
            if inner.kind != "content_block_delta" {
                return Ok(None);
            }
            let Some(delta) = inner.delta else {
                return Ok(None);
            };
            /* ⚠️ AND THE DELTA'S OWN TYPE. `content_block_delta` is a family:
             * `input_json_delta`, `thinking_delta` and `signature_delta` are
             * already in it, and anything the CLI adds later joins it. Matching
             * on the block and forwarding whatever `text` field turned up would
             * splice a tool call's arguments, or a reasoning trace, into the
             * answer the reader is shown. */
            if delta.kind != "text_delta" {
                return Ok(None);
            }
            Ok(delta.text)
        }
    }
}

/// How long one turn may take, and how long it may go quiet inside it.
///
/// ⚠️ **THERE WAS NO DEADLINE AT ALL.** A CLI that wedges — a network stall
/// with no timeout of its own, a prompt for input Paper will never answer, a
/// hung helper holding stdout open — kept the request slot and the subprocess
/// for as long as the app ran, and the only way out was the reader pressing
/// Stop on a pane they may have closed. Both bounds are needed: the whole-turn
/// one catches a CLI that streams forever, and the quiet one catches the far
/// more common case of a CLI that stops saying anything at all while a
/// thorough answer is still legitimately in progress.
const TURN_LIMIT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const QUIET_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

/// How much of a child's stderr is kept for the failure message.
const STDERR_TAIL_BYTES: usize = 4096;

/// A spawned agent process and everything it started, owned in one place.
///
/// ⚠️ **EVERY EXIT PATH USED TO CARRY ITS OWN TEARDOWN.** `ask` had nine
/// returns and each repeated `terminate` then `kill`; three had been missed at
/// one point or another — the success path, a `wait` that errors, a nonzero
/// exit — and each miss left a helper running, which on a subscription route is
/// a turn being spent on an answer nobody will read. Fixing instance N+1 with
/// the class unexamined is how that cost three separate audit rounds.
///
/// Worse, a branch cannot run at all when a future is dropped mid-await, which
/// is what cancelling the enclosing task does, and `kill_on_drop` reaches the
/// leader only. So the teardown belongs in a destructor, which always runs:
///
/// - [`Drop`] signals the group SYNCHRONOUSLY, which is all a destructor can
///   do, and leaves reaping to tokio's own `kill_on_drop` reaper.
/// - [`Turn::stop`] is the async form, which also reaps, and is what the
///   ordinary paths call.
///
/// Whichever runs, the group goes down. `stop` is idempotent, so calling it and
/// then dropping does not signal twice.
struct Turn {
    child: tokio::process::Child,
    /// Captured at spawn: `Child::id()` is `None` once anything has reaped it,
    /// and every path here may have. See `procgroup::group_of`.
    group: Option<u32>,
    stopped: bool,
    #[cfg(windows)]
    _job: Option<crate::procgroup::JobHandle>,
}

impl Turn {
    fn adopt(child: tokio::process::Child) -> Self {
        let group = crate::procgroup::group_of(&child);
        Self {
            child,
            group,
            stopped: false,
            #[cfg(windows)]
            _job: None,
        }
    }

    /// Signal the whole group, then reap it. Idempotent.
    ///
    /// Failures are logged rather than returned: they cannot mask the turn's
    /// own outcome — a teardown that failed must not turn a delivered answer
    /// into an error, nor a cancellation into an I/O failure — and a signal
    /// that genuinely failed is a maintainer's problem, which is what `log` is
    /// for here and in `daemon.rs`.
    async fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        if let Err(err) = crate::procgroup::terminate(&self.child) {
            log::warn!("inference: could not signal an agent's group: {err}");
        }
        if let Err(err) = crate::procgroup::kill(&mut self.child, self.group).await {
            log::warn!("inference: could not kill an agent's group: {err}");
        }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        let _ = crate::procgroup::terminate(&self.child);
        crate::procgroup::kill_now(self.group);
    }
}

/// The last `STDERR_TAIL_BYTES` of a child's stderr.
///
/// ⚠️ **A TAIL, AND ACTUALLY BOUNDED.** What this replaces kept the PREFIX
/// under an `if held.len() < 4096` check — so it was neither a tail nor a
/// bound: one long line appended in full took the buffer far past the limit,
/// and the interesting part of a CLI's stderr is what it said LAST, not the
/// login banner it opened with.
#[derive(Default)]
struct Tail {
    bytes: std::collections::VecDeque<u8>,
}

impl Tail {
    fn push(&mut self, chunk: &[u8]) {
        for &byte in chunk {
            if self.bytes.len() == STDERR_TAIL_BYTES {
                self.bytes.pop_front();
            }
            self.bytes.push_back(byte);
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.iter().copied().collect::<Vec<_>>()).into_owned()
    }
}

/// Run one turn, streaming text to `on_delta`. Returns the whole answer.
pub async fn ask(
    agent: Agent,
    program: &Path,
    workdir: &Path,
    prompt: &str,
    depth: Depth,
    cancel: &Cancel,
    mut on_delta: impl FnMut(String),
) -> Result<String> {
    /* ⚠️ THE ARGV AND `current_dir` MUST BE THE SAME DIRECTORY. Codex is told
     * its root with `-C <dir>`, and that argument is a `String` — so a path
     * that is not valid Unicode became something ELSE under
     * `to_string_lossy`, and the CLI was pointed at a directory that does not
     * exist while the process itself ran in the one that does. Rejected here
     * rather than silently rewritten. */
    if workdir.to_str().is_none() {
        return Err(Error::PathNotUnicode(workdir.to_path_buf()));
    }
    prepare_workdir(workdir).await?;

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(turn_args(agent, workdir, depth))
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .env("PAGER", "cat")
        .kill_on_drop(true);
    // The same process-group discipline the daemon gets: an agent CLI spawns
    // helpers, and cancelling must reach them rather than orphaning them.
    crate::procgroup::configure(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::AgentMissing(agent.name())
        } else {
            Error::Io(e)
        }
    })?;

    /* OWNED FROM HERE. Everything below may return, and none of it repeats a
     * teardown: `turn` holds the group, and the group goes down when it does. */
    let mut turn = Turn::adopt(child);

    /* THE SAME JOB-OBJECT GUARANTEE THE DAEMON GETS. Without this an agent
     * CLI on Windows was held only by its own handle, so cancelling killed the
     * leader and left whatever it had spawned running — the exact gap
     * `procgroup`'s header says the job object closes.
     *
     * ⚠️ ADOPTED FIRST, THEN HELD. `?` here used to run before anything owned
     * the child, so a job object that could not be created or assigned left a
     * process that had already started — and had already had time to spawn
     * descendants — with only `kill_on_drop`'s leader kill behind it. */
    #[cfg(windows)]
    {
        turn._job = Some(crate::procgroup::JobHandle::hold(&turn.child)?);
    }

    /* ⚠️ STDERR IS DRAINED, AND NOT DRAINING IT WAS A DEADLOCK.
     *
     * `Stdio::piped()` gives the child a pipe with a fixed kernel buffer. Both
     * CLIs write diagnostics there — a login notice, a deprecation warning, a
     * progress line — and once that buffer fills with nobody reading, the
     * child BLOCKS on its next write to stderr. It then never writes another
     * stdout event, so the loop below waits forever on a line that will not
     * come and `wait()` never returns. A verbose agent turn was enough.
     *
     * The bytes are kept for the failure message and otherwise dropped. */
    let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(Tail::default()));
    /* ⚠️ AND THE HANDLE IS KEPT. Detached, this task raced `wait()`: the
     * process could exit, the failure branch could read the buffer, and the
     * drain could deliver the last — and most explanatory — bytes afterwards.
     * The failure message was then empty or truncated, nondeterministically,
     * in exactly the case somebody is reading it. */
    let draining = child_stderr_drain(&mut turn.child, std::sync::Arc::clone(&stderr_tail));

    if let Some(mut stdin) = turn.child.stdin.take() {
        /* The write races cancellation: a child that stops reading stdin —
         * one that failed to start, or is waiting on a prompt Paper will never
         * answer — would otherwise block here with no way out. */
        let wrote = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                turn.stop().await;
                return Err(Error::Cancelled);
            }
            written = async {
                stdin.write_all(prompt.as_bytes()).await?;
                stdin.shutdown().await
            } => written,
        };
        if let Err(failure) = wrote {
            turn.stop().await;
            return Err(Error::Io(failure));
        }
    }

    let Some(stdout) = turn.child.stdout.take() else {
        turn.stop().await;
        return Err(Error::AgentMalformed {
            agent: agent.name(),
            message: "no stdout".to_owned(),
        });
    };
    let mut lines = BufReader::new(stdout).lines();
    let mut answer = String::new();
    /* WHETHER AN ANSWER EVENT WAS EVER SEEN, which `answer.is_empty()` cannot
     * tell from an answer event carrying an empty string. See the check after
     * the exit status. */
    let mut answered = false;
    let deadline = tokio::time::Instant::now() + TURN_LIMIT;

    loop {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                // The reader gave up. Take the whole group down rather than
                // letting a subscription turn run on unattended.
                turn.stop().await;
                return Err(Error::Cancelled);
            }
            () = tokio::time::sleep_until(deadline) => {
                turn.stop().await;
                return Err(Error::AgentMalformed {
                    agent: agent.name(),
                    message: format!("gave no answer within {}s", TURN_LIMIT.as_secs()),
                });
            }
            line = tokio::time::timeout(QUIET_LIMIT, lines.next_line()) => match line {
                Ok(line) => line,
                Err(_elapsed) => {
                    turn.stop().await;
                    return Err(Error::AgentMalformed {
                        agent: agent.name(),
                        message: format!("said nothing for {}s", QUIET_LIMIT.as_secs()),
                    });
                }
            },
        };
        match next {
            Ok(Some(line)) => {
                let parsed = match parse_line(agent, &line) {
                    Ok(parsed) => parsed,
                    Err(failure) => {
                        turn.stop().await;
                        return Err(failure);
                    }
                };
                if let Some(text) = parsed {
                    answered = true;
                    /* THE SAME BOUND THE DAEMON PATH TAKES, and for the same
                     * reason: the writer is another process, and an agent CLI
                     * that never stops emitting would otherwise grow this
                     * until the app died. */
                    if answer.len() + text.len() > crate::limits::MAX_ANSWER_BYTES {
                        turn.stop().await;
                        return Err(Error::FieldTooLarge {
                            field: "the answer",
                            limit: crate::limits::MAX_ANSWER_BYTES,
                        });
                    }
                    answer.push_str(&text);
                    on_delta(text);
                }
            }
            Ok(None) => break,
            Err(err) => {
                turn.stop().await;
                return Err(Error::Io(err));
            }
        }
    }

    /* THE WAIT RACES CANCELLATION TOO. Every other await in this function
     * does, and this one did not: a child that closes stdout and then hangs —
     * flushing telemetry, waiting on a prompt nobody will answer — left
     * `wait()` pending with no way out, so the reader's Stop did nothing and a
     * subscription turn ran on unattended. EOF on stdout is not the end of the
     * process. */
    let status = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            turn.stop().await;
            return Err(Error::Cancelled);
        }
        () = tokio::time::sleep_until(deadline) => {
            turn.stop().await;
            return Err(Error::AgentMalformed {
                agent: agent.name(),
                message: format!("did not exit within {}s", TURN_LIMIT.as_secs()),
            });
        }
        waited = turn.child.wait() => match waited {
            Ok(status) => status,
            Err(failure) => {
                turn.stop().await;
                return Err(Error::Io(failure));
            }
        },
    };

    /* THE DRAIN IS FINISHED BEFORE THE BUFFER IS READ. The process is gone, so
     * its stderr is at EOF and this cannot hang; without it the tail below is
     * whatever happened to have arrived, which is a race in the one branch
     * whose whole job is to explain a failure. */
    if let Some(handle) = draining {
        let _ = handle.await;
    }
    let tail = stderr_tail
        .lock()
        .map(|held| held.text().trim().to_owned())
        .unwrap_or_default();

    /* A NONZERO EXIT IS A FAILED TURN, whatever arrived before it.
     *
     * This read `!status.success() && answer.is_empty()`, so a CLI that
     * streamed half an answer and then died returned `Ok` with the half — and
     * a truncated answer is indistinguishable from a complete one to every
     * caller above. Both CLIs exit 0 on success, so a nonzero status means the
     * turn did not finish, and saying so is the only honest option. */
    if !status.success() {
        turn.stop().await;
        return Err(Error::AgentMalformed {
            agent: agent.name(),
            /* The child's own stderr, which is the half that says WHY —
             * "not logged in", "model unavailable", a rate limit. An exit
             * code alone sends whoever reads it back to the terminal. */
            message: if tail.is_empty() {
                format!("exited with {status}")
            } else {
                format!("exited with {status}: {}", redact(&tail))
            },
        });
    }

    /* ⚠️ AND A ZERO EXIT WITH NO ANSWER EVENT IS ALSO A FAILED TURN. This
     * returned `Ok("")`, which reaches the reader as a companion that answered
     * with nothing — the least actionable outcome there is. A CLI whose output
     * format has moved, or that quietly refused, exits 0 and emits events this
     * parser correctly finds nothing in; that is exactly the case worth
     * naming rather than rendering as an empty bubble. */
    if !answered {
        turn.stop().await;
        return Err(Error::AgentMalformed {
            agent: agent.name(),
            message: if tail.is_empty() {
                "finished without answering".to_owned()
            } else {
                format!("finished without answering: {}", redact(&tail))
            },
        });
    }

    /* THE GROUP GOES DOWN ON THE SUCCESS PATH TOO. A leader that exits
     * cleanly can still leave a detached helper holding the group — and one
     * that inherited stdout keeps a subscription turn alive after the answer
     * has been delivered. `wait` has reaped the leader; `group` was captured
     * before that, which is why this can still be taken down by id. */
    turn.stop().await;
    Ok(answer)
}

/// The empty, non-symlink directory the turn runs in.
///
/// ⚠️ `create_dir_all` ALONE DOES NOT ESTABLISH THIS. The path is persistent —
/// `<data root>/agent-root` — so `create_dir_all` succeeds over a directory
/// that already holds files from a previous build, and succeeds over a SYMLINK
/// to somewhere else entirely. Either one hands the agent a working root it can
/// read, which is the one thing the `-s read-only`/`-C <empty dir>` pair exists
/// to prevent: the argv locks the agent out of the reader's library by pointing
/// it at nothing, and a root with contents in it is no longer nothing.
async fn prepare_workdir(workdir: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(workdir).await {
        Ok(meta) if meta.file_type().is_symlink() => {
            /* Replaced rather than followed: whatever it points at is not
             * Paper's to empty, and running there is the case being refused. */
            tokio::fs::remove_file(workdir).await?;
        }
        Ok(meta) if meta.is_dir() => {
            /* Emptied rather than recreated wholesale, so a mount or a
             * permission the reader set on the directory itself survives. */
            let mut entries = tokio::fs::read_dir(workdir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if entry.file_type().await?.is_dir() {
                    tokio::fs::remove_dir_all(&path).await?;
                } else {
                    tokio::fs::remove_file(&path).await?;
                }
            }
            return Ok(());
        }
        Ok(_) => {
            // A plain file where the directory belongs.
            tokio::fs::remove_file(workdir).await?;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(Error::Io(err)),
    }
    tokio::fs::create_dir_all(workdir).await?;
    Ok(())
}

/// Drain the child's stderr into `sink`, returning the task to await later.
fn child_stderr_drain(
    child: &mut tokio::process::Child,
    sink: std::sync::Arc<std::sync::Mutex<Tail>>,
) -> Option<tokio::task::JoinHandle<()>> {
    let stderr = child.stderr.take()?;
    Some(tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut chunk = [0_u8; 1024];
        loop {
            match tokio::io::AsyncReadExt::read(&mut reader, &mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if let Ok(mut held) = sink.lock() {
                        held.push(&chunk[..read]);
                    }
                }
            }
        }
    }))
}

/// One line of a child's stderr, bounded and stripped of anything identifying.
///
/// THE REASON CROSSES, THE IDENTITY DOES NOT. The stderr tail is the half that
/// says WHY — "not logged in", "model unavailable", a rate limit — and an exit
/// code alone sends whoever reads it back to a terminal. But this string
/// reaches a webview that renders untrusted book HTML, and both CLIs write
/// absolute paths under the reader's home, and Claude's carries an account
/// address. `agent.rs` drops those at the parse boundary for exactly this
/// reason; an error message is not an exemption from it.
///
/// Bounded rather than parsed: no wording is matched, so nothing here goes
/// stale when a CLI rephrases itself. What is removed is removed by SHAPE.
///
/// ⚠️ THE LAST LINE, NOT THE FIRST. The buffer this reads is a TAIL — the final
/// few kilobytes of stderr — so its first line is very often a fragment of one,
/// cut wherever the ring buffer happened to start. Taking the first line
/// reported that fragment; and even with a complete buffer, a CLI's reason is
/// what it says LAST, after whatever banner or deprecation notice it opened
/// with.
fn redact(tail: &str) -> String {
    const LIMIT: usize = 200;
    let last = tail
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let scrubbed: String = last
        .split_whitespace()
        .map(|word| {
            if word.contains('@') || word.contains('/') || word.contains('\\') {
                "[…]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if scrubbed.chars().count() > LIMIT {
        scrubbed.chars().take(LIMIT).collect::<String>() + "…"
    } else {
        scrubbed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Each test names one flag of the lockdown, so removing that flag turns
     * exactly one red. These arguments ARE the sandbox — there is nothing
     * else between a book's text and an agent's tool call. */

    #[test]
    fn claude_disables_every_tool_with_the_wildcard() {
        let args = turn_args(Agent::Claude, Path::new("/tmp/empty"), Depth::Default);
        let i = args
            .iter()
            .position(|a| a == "--disallowed-tools")
            .expect("the flag");
        assert_eq!(
            args[i + 1],
            "*",
            "an enumerated denylist left 17 tools standing — measured, not guessed"
        );
        // And the spelling that does NOT work must not be what we rely on.
        assert!(
            !args
                .iter()
                .any(|a| a == "--allowedTools" || a == "--allowed-tools"),
            "--allowedTools \"\" does not disable tools; relying on it would be a silent hole"
        );
    }

    #[test]
    fn claude_loads_none_of_the_readers_configuration() {
        let args = turn_args(Agent::Claude, Path::new("/tmp/empty"), Depth::Default);
        let i = args
            .iter()
            .position(|a| a == "--setting-sources")
            .expect("the flag");
        assert_eq!(
            args[i + 1],
            "",
            "a reader's hooks must not run in a turn about a novel"
        );
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        let m = args
            .iter()
            .position(|a| a == "--mcp-config")
            .expect("the flag");
        assert_eq!(args[m + 1], r#"{"mcpServers":{}}"#);
        let a = args.iter().position(|x| x == "--agents").expect("the flag");
        assert_eq!(args[a + 1], "{}", "no subagents");
    }

    #[test]
    fn claude_streams_and_denies_by_default() {
        let args = turn_args(Agent::Claude, Path::new("/tmp/empty"), Depth::Default);
        assert!(args.iter().any(|a| a == "-p"));
        assert!(args.iter().any(|a| a == "--include-partial-messages"));
        let o = args
            .iter()
            .position(|a| a == "--output-format")
            .expect("the flag");
        assert_eq!(args[o + 1], "stream-json");
        let s = args
            .iter()
            .position(|a| a == "--settings")
            .expect("the flag");
        assert!(args[s + 1].contains(r#""deny":["*"]"#));
    }

    #[test]
    fn codex_is_read_only_ephemeral_and_ignores_the_readers_config() {
        let args = turn_args(Agent::Codex, Path::new("/tmp/empty"), Depth::Default);
        assert_eq!(args[0], "exec");
        assert!(args.iter().any(|a| a == "--json"));
        assert!(
            args.iter().any(|a| a == "--ephemeral"),
            "no session files on disk"
        );
        assert!(args.iter().any(|a| a == "--ignore-user-config"));
        assert!(args.iter().any(|a| a == "--ignore-rules"));
        assert!(args.iter().any(|a| a == "--skip-git-repo-check"));
        let s = args
            .iter()
            .position(|a| a == "-s")
            .expect("the sandbox flag");
        assert_eq!(args[s + 1], "read-only");
    }

    /// `Depth::Default` adds NOTHING. The reader's account default is what
    /// they already pay for, and the argv stays what every test above pins.
    #[test]
    fn the_default_depth_changes_no_argument() {
        for agent in crate::agent::AGENTS {
            let plain = turn_args(agent, Path::new("/tmp/empty"), Depth::Default);
            for arg in &plain {
                assert!(
                    !arg.contains("model_reasoning_effort") && arg != "--model",
                    "{agent:?} chose a model nobody asked for: {arg:?}"
                );
            }
        }
    }

    /// Each CLI spends the choice on the axis IT offers, both measured
    /// 2026-08-23 — Codex on reasoning effort, Claude on a documented model
    /// alias. Pinned by value, because an unsupported one is a 400 the reader
    /// pays a request to discover.
    #[test]
    fn each_agent_spends_the_choice_on_the_axis_its_cli_offers() {
        let codex_fast = turn_args(Agent::Codex, Path::new("/tmp/empty"), Depth::Faster);
        assert!(codex_fast.contains(&"model_reasoning_effort=low".to_owned()));
        let codex_deep = turn_args(Agent::Codex, Path::new("/tmp/empty"), Depth::Thorough);
        assert!(codex_deep.contains(&"model_reasoning_effort=high".to_owned()));

        let claude_fast = turn_args(Agent::Claude, Path::new("/tmp/empty"), Depth::Faster);
        assert!(claude_fast.contains(&"sonnet".to_owned()));
        let claude_deep = turn_args(Agent::Claude, Path::new("/tmp/empty"), Depth::Thorough);
        assert!(claude_deep.contains(&"opus".to_owned()));
    }

    /// THE LOCKDOWN SURVIVES EVERY CHOICE. A depth that quietly dropped a
    /// containment flag would be the worst kind of setting: one that trades
    /// safety for speed without saying so.
    #[test]
    fn no_depth_weakens_the_lockdown() {
        for agent in crate::agent::AGENTS {
            let plain = turn_args(agent, Path::new("/tmp/empty"), Depth::Default);
            for depth in [Depth::Faster, Depth::Thorough] {
                let args = turn_args(agent, Path::new("/tmp/empty"), depth);
                for flag in &plain {
                    assert!(
                        args.contains(flag),
                        "{agent:?} at {depth:?} dropped {flag:?}"
                    );
                }
                for arg in &args {
                    assert!(
                        !arg.contains("dangerous") && !arg.contains("bypass"),
                        "{agent:?} at {depth:?} was handed {arg:?}"
                    );
                }
            }
        }
    }

    /// Nothing dangerous, on either side. These flags exist and would make
    /// every other argument here pointless.
    #[test]
    fn no_bypass_flag_is_ever_passed() {
        for agent in crate::agent::AGENTS {
            for arg in turn_args(agent, Path::new("/tmp/empty"), Depth::Default) {
                assert!(
                    !arg.contains("dangerous") && !arg.contains("bypass"),
                    "{agent:?} was handed {arg:?}"
                );
            }
        }
    }

    /// The prompt is on stdin, so it must not appear in argv — and argv must
    /// end in the marker that says so for Codex.
    #[test]
    fn the_prompt_is_never_an_argument() {
        let args = turn_args(Agent::Codex, Path::new("/tmp/empty"), Depth::Default);
        assert_eq!(
            args.last().unwrap(),
            "-",
            "codex reads the prompt from stdin"
        );
        for agent in crate::agent::AGENTS {
            for arg in turn_args(agent, Path::new("/tmp/empty"), Depth::Default) {
                assert!(arg.len() < 200, "no argument should be carrying book text");
            }
        }
    }

    #[test]
    fn the_working_root_is_the_directory_it_was_given() {
        let args = turn_args(Agent::Codex, Path::new("/tmp/paper-empty"), Depth::Default);
        let c = args.iter().position(|a| a == "-C").expect("the flag");
        assert_eq!(args[c + 1], "/tmp/paper-empty");
    }

    // ── the parsers, against output captured from the real CLIs ───────────

    /// Codex, verbatim from `codex exec --json` on 2026-08-23.
    #[test]
    fn codex_answer_is_read_and_its_thread_id_is_not() {
        assert_eq!(
            parse_line(
                Agent::Codex,
                r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}"#
            )
            .ok(),
            Some(Some("ok".to_owned()))
        );
        // Everything else is dropped, thread id and usage included.
        for noise in [
            r#"{"type":"thread.started","thread_id":"01a02a73-22c2-7e40-8db8-d9f5229a7c1e"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":14692,"output_tokens":5}}"#,
        ] {
            assert_eq!(parse_line(Agent::Codex, noise).ok(), Some(None), "{noise}");
        }
    }

    /// A reasoning or command item is not the answer.
    #[test]
    fn a_codex_item_that_is_not_an_agent_message_is_dropped() {
        assert_eq!(
            parse_line(
                Agent::Codex,
                r#"{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"thinking"}}"#
            )
            .ok(),
            Some(None)
        );
    }

    /// Claude, verbatim from `claude -p --output-format stream-json`.
    #[test]
    fn claude_delta_is_read() {
        assert_eq!(
            parse_line(
                Agent::Claude,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}},"session_id":"2117b276","uuid":"77cee48b"}"#
            )
            .ok(),
            Some(Some("ok".to_owned()))
        );
    }

    /// The init event is the biggest leak either CLI produces: cwd, session
    /// id, model, and every plugin's path under the reader's home directory.
    /// It must yield nothing.
    #[test]
    fn claudes_init_event_yields_nothing() {
        let init = r#"{"type":"system","subtype":"init","cwd":"/Users/someone/secret","session_id":"2117b276","model":"claude-opus-5","plugins":[{"name":"p","path":"/Users/someone/.claude/plugins/p"}],"tools":["Bash"]}"#;
        assert_eq!(parse_line(Agent::Claude, init).ok(), Some(None));
    }

    #[test]
    fn claudes_other_events_yield_nothing() {
        for noise in [
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]},"session_id":"x"}"#,
            r#"{"type":"result","subtype":"success","is_error":false}"#,
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-5"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}"#,
        ] {
            assert_eq!(parse_line(Agent::Claude, noise).ok(), Some(None), "{noise}");
        }
    }

    #[test]
    fn blank_lines_are_skipped_by_both() {
        for agent in crate::agent::AGENTS {
            for line in ["", "   ", "\t"] {
                assert_eq!(
                    parse_line(agent, line).ok(),
                    Some(None),
                    "{agent:?} {line:?}"
                );
            }
        }
    }

    /// ⚠️ NOT THE SAME ANSWER AS "this event is not an answer".
    ///
    /// These used to be folded into `None` by `.ok()?`, so a CLI whose output
    /// format had moved produced a turn that exited 0 with an empty answer and
    /// nothing anywhere saying why. A line that is not the protocol fails the
    /// turn; a line that is the protocol and is not an answer does not.
    #[test]
    fn a_line_that_is_not_the_protocol_fails_the_turn() {
        for agent in crate::agent::AGENTS {
            for line in ["not json", "{}", "[]", r#"{"typo":"item.completed"}"#] {
                assert!(
                    matches!(parse_line(agent, line), Err(Error::AgentMalformed { .. })),
                    "{agent:?} {line:?} was treated as ordinary noise"
                );
            }
        }
    }

    /// `content_block_delta` is a family, and only one member is the answer.
    ///
    /// `input_json_delta` carries a tool call's arguments and `thinking_delta`
    /// carries a reasoning trace; both are already in the stream, and anything
    /// the CLI adds later joins it. Matching the block alone and forwarding
    /// whatever `text` turned up would splice either into the reader's answer.
    #[test]
    fn only_a_text_delta_is_the_answer() {
        for kind in ["input_json_delta", "thinking_delta", "signature_delta"] {
            let line = format!(
                r#"{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"{kind}","text":"leaked"}}}}}}"#
            );
            assert_eq!(
                parse_line(Agent::Claude, &line).ok(),
                Some(None),
                "a {kind} reached the answer"
            );
        }
    }

    /// The two agents' event shapes must not be read by each other's parser —
    /// a Codex answer fed to the Claude parser is not an answer.
    #[test]
    fn the_parsers_do_not_read_each_others_events() {
        let codex = r#"{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}"#;
        let claude = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"ok"}}}"#;
        assert_eq!(parse_line(Agent::Claude, codex).ok(), Some(None));
        assert_eq!(parse_line(Agent::Codex, claude).ok(), Some(None));
    }
    // ── the subprocess lifecycle, against a fake CLI ─────────────────────
    //
    // ⚠️ EVERYTHING ABOVE IS PURE. The argv and the parsers had tests; the
    // hundred and eighty lines that own a process — cancellation at each
    // phase, a nonzero exit after a delta, a zero exit with no answer, stderr
    // that outgrows its bound, a drain that finishes after `wait`, descendants
    // that outlive the leader — had none at all. Every defect this round found
    // in this file lived in exactly that gap, which is not a coincidence: the
    // covered half is the half that was correct.
    //
    // The fake is a shell script, so there is no second binary to build and
    // the behaviour under test is written where it is read.

    #[cfg(unix)]
    mod lifecycle {
        use super::*;
        use crate::testutil::ScratchDir;
        use std::os::unix::fs::PermissionsExt;
        use std::path::PathBuf;

        /// Write `body` as an executable `sh` script and return its path.
        fn fake_cli(dir: &Path, body: &str) -> PathBuf {
            let path = dir.join("fake-cli");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write the fake");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            path
        }

        /// A Codex `agent_message` line, which is what the parser reads.
        fn answer(text: &str) -> String {
            format!(
                r#"printf '%s\n' '{{"type":"item.completed","item":{{"type":"agent_message","text":"{text}"}}}}'"#
            )
        }

        struct World {
            _bin: ScratchDir,
            work: ScratchDir,
            program: PathBuf,
        }

        fn world(body: &str) -> World {
            let bin = ScratchDir::new("agent-bin");
            let program = fake_cli(bin.path(), body);
            World {
                _bin: bin,
                work: ScratchDir::new("agent-work"),
                program,
            }
        }

        async fn run(w: &World, cancel: &Cancel) -> (Result<String>, Vec<String>) {
            run_watching(w, cancel, |_| {}).await
        }

        /// `watch` sees each delta as it arrives — which is how the
        /// cancellation cases below trip at a KNOWN point in the turn rather
        /// than after a timer that has to guess at process start-up cost.
        async fn run_watching(
            w: &World,
            cancel: &Cancel,
            mut watch: impl FnMut(&str),
        ) -> (Result<String>, Vec<String>) {
            let mut deltas = Vec::new();
            let out = ask(
                Agent::Codex,
                &w.program,
                w.work.path(),
                "the question",
                Depth::Default,
                cancel,
                |text| {
                    watch(&text);
                    deltas.push(text);
                },
            )
            .await;
            (out, deltas)
        }

        /// A live request's token, with the registry kept alive alongside it.
        fn token() -> (crate::requests::Guard, Cancel) {
            let registry = crate::requests::Registry::default();
            let guard = registry.begin("t").expect("a fresh request");
            let cancel = guard.cancel();
            (guard, cancel)
        }

        #[tokio::test]
        async fn a_clean_turn_streams_its_answer_and_returns_it() {
            let w = world(&format!("cat > /dev/null\n{}", answer("hello")));
            let (out, deltas) = run(&w, &Cancel::never()).await;
            assert_eq!(out.expect("the answer"), "hello");
            assert_eq!(deltas, vec!["hello".to_owned()]);
        }

        /// ⚠️ A ZERO EXIT WITH NO ANSWER EVENT IS A FAILED TURN.
        ///
        /// This returned `Ok("")`, which reaches the reader as a companion
        /// that answered with nothing — the least actionable outcome there is,
        /// and the shape a CLI takes when its output format has moved or when
        /// it refuses quietly.
        #[tokio::test]
        async fn a_zero_exit_with_no_answer_is_not_a_successful_turn() {
            let w = world(r#"cat > /dev/null; printf '%s\n' '{"type":"turn.completed"}'"#);
            let (out, _) = run(&w, &Cancel::never()).await;
            match out {
                Err(Error::AgentMalformed { message, .. }) => {
                    assert!(message.contains("without answering"), "{message}");
                }
                other => panic!("an empty success was accepted: {other:?}"),
            }
        }

        /// ⚠️ A TRUNCATED ANSWER IS INDISTINGUISHABLE FROM A COMPLETE ONE.
        #[tokio::test]
        async fn a_nonzero_exit_after_a_delta_fails_rather_than_returning_the_half() {
            let w = world(&format!(
                "cat > /dev/null\n{}\nexit 3",
                answer("half an answ")
            ));
            let (out, _) = run(&w, &Cancel::never()).await;
            match out {
                Err(Error::AgentMalformed { message, .. }) => {
                    assert!(message.contains("exited with"), "{message}");
                }
                other => panic!("a half answer was returned as success: {other:?}"),
            }
        }

        /// The stderr tail is what says WHY, and it must be the LAST of it —
        /// the bound this replaces kept the prefix, so a CLI that opens with a
        /// banner reported the banner and dropped the reason.
        #[tokio::test]
        async fn the_failure_carries_the_end_of_stderr_not_its_beginning() {
            let w = world(
                r#"cat > /dev/null
i=0
while [ $i -lt 400 ]; do printf 'banner line %s\n' "$i" >&2; i=$((i+1)); done
printf 'not logged in\n' >&2
exit 1"#,
            );
            let (out, _) = run(&w, &Cancel::never()).await;
            match out {
                Err(Error::AgentMalformed { message, .. }) => {
                    assert!(message.contains("not logged in"), "{message}");
                }
                other => panic!("expected a failure carrying stderr: {other:?}"),
            }
        }

        /// A child that writes megabytes to stderr must neither deadlock nor
        /// grow the tail without limit.
        #[tokio::test]
        async fn a_flood_of_stderr_neither_deadlocks_nor_grows_without_bound() {
            let w = world(&format!(
                r#"cat > /dev/null
i=0
while [ $i -lt 3000 ]; do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa %s\n' "$i" >&2; i=$((i+1)); done
{}"#,
                answer("survived")
            ));
            let (out, _) = run(&w, &Cancel::never()).await;
            assert_eq!(out.expect("the answer"), "survived");
        }

        /// Cancellation while the child is still producing.
        ///
        /// Tripped ON the first delta rather than after a timer: the point
        /// under test is "a turn already streaming stops", and a timer would
        /// be racing process start-up to establish it.
        #[tokio::test]
        async fn cancelling_mid_stream_stops_the_turn() {
            let w = world(&format!(
                "cat > /dev/null\n{}\nsleep 30\n{}",
                answer("first"),
                answer("second")
            ));
            let (_guard, cancel) = token();
            let tripping = cancel.clone();
            let (out, deltas) = run_watching(&w, &cancel, |_| tripping.trip()).await;
            assert!(matches!(out, Err(Error::Cancelled)), "{out:?}");
            /* The first arrived; the second, thirty seconds later, did not. */
            assert_eq!(deltas, vec!["first".to_owned()]);
        }

        /// Cancellation before the child has said anything at all.
        #[tokio::test]
        async fn cancelling_before_the_first_line_stops_the_turn() {
            let w = world("cat > /dev/null; sleep 30");
            let (_guard, cancel) = token();
            cancel.trip();
            let (out, deltas) = run(&w, &cancel).await;
            assert!(matches!(out, Err(Error::Cancelled)), "{out:?}");
            assert!(deltas.is_empty());
        }

        /// ⚠️ EOF ON STDOUT IS NOT THE END OF THE PROCESS. A CLI that answers
        /// and then hangs — flushing telemetry, waiting on a prompt — left
        /// `wait()` pending with no way out, so Stop did nothing.
        #[tokio::test]
        async fn cancelling_while_the_child_hangs_after_its_answer_stops_the_turn() {
            let w = world(&format!(
                "cat > /dev/null\n{}\nexec 1>&-\nsleep 30",
                answer("done")
            ));
            let (_guard, cancel) = token();
            let tripping = cancel.clone();
            let (out, _) = run_watching(&w, &cancel, |_| tripping.trip()).await;
            assert!(matches!(out, Err(Error::Cancelled)), "{out:?}");
        }

        /// ⚠️ THE DESCENDANTS GO TOO, WHICH IS THE WHOLE POINT OF THE GROUP.
        ///
        /// `kill_on_drop` reaches the leader only. A CLI that has spawned a
        /// helper — both of them do — left that helper running after a cancel,
        /// which on a subscription route is a turn still being spent.
        #[tokio::test]
        async fn cancelling_takes_the_leader_s_children_down_with_it() {
            let marker = ScratchDir::new("agent-marker");
            let alive = marker.path().join("alive");
            let w = world(&format!(
                r#"cat > /dev/null
( i=0; while [ $i -lt 200 ]; do printf 'x' >> '{marker}'; sleep 0.05; i=$((i+1)); done ) &
while [ ! -s '{marker}' ]; do sleep 0.02; done
{answer}
sleep 30"#,
                marker = alive.display(),
                answer = answer("started")
            ));
            /* Cancelled once the leader has answered, which is also once its
            helper is certainly running — a timer would be guessing. */
            let (_guard, cancel) = token();
            let tripping = cancel.clone();
            let (out, _) = run_watching(&w, &cancel, |_| tripping.trip()).await;
            assert!(matches!(out, Err(Error::Cancelled)), "{out:?}");
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            assert!(
                alive.exists(),
                "the helper never ran, so this proves nothing"
            );

            let when_stopped = std::fs::metadata(&alive).expect("the marker").len();
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            let later = std::fs::metadata(&alive).expect("the marker").len();
            assert_eq!(
                later, when_stopped,
                "a descendant outlived the cancelled turn and kept writing"
            );
        }

        /// ⚠️ THE CASE NO BRANCH CAN COVER: the future itself is dropped.
        ///
        /// Cancelling the enclosing task — the app shutting down, a `timeout`
        /// elapsing, a `select!` losing — drops `ask` mid-await, and NONE of
        /// its explicit teardown paths run. `kill_on_drop` reaches the leader
        /// only, so before the owner existed this left the whole tree the CLI
        /// had built running with nobody holding it. This is the reason the
        /// teardown lives in a destructor rather than at each return.
        #[tokio::test]
        async fn dropping_the_turn_mid_await_still_takes_the_group_down() {
            let marker = ScratchDir::new("agent-dropped");
            let alive = marker.path().join("alive");
            let w = world(&format!(
                r#"cat > /dev/null
( i=0; while [ $i -lt 200 ]; do printf 'x' >> '{marker}'; sleep 0.05; i=$((i+1)); done ) &
while [ ! -s '{marker}' ]; do sleep 0.02; done
{answer}
sleep 30"#,
                marker = alive.display(),
                answer = answer("started")
            ));

            {
                let never = Cancel::never();
                /* DROPPED THE MOMENT THE FIRST DELTA ARRIVES, which the fake
                emits only after its helper has written — so "the helper was
                running when the future went away" is established by
                construction rather than by a timer racing process
                start-up. `select!` drops the losing branch's future, and no
                cancellation token is involved at all, so nothing inside
                `ask` gets the chance to clean up. */
                let (tx, rx) = tokio::sync::oneshot::channel::<()>();
                let mut tx = Some(tx);
                let turn = ask(
                    Agent::Codex,
                    &w.program,
                    w.work.path(),
                    "q",
                    Depth::Default,
                    &never,
                    |_| {
                        if let Some(tx) = tx.take() {
                            let _ = tx.send(());
                        }
                    },
                );
                tokio::select! {
                    finished = turn => panic!("the fake exited early: {finished:?}"),
                    _ = rx => {}
                }
            }

            assert!(
                alive.exists(),
                "the helper never ran, so this proves nothing"
            );
            let when_dropped = std::fs::metadata(&alive).expect("the marker").len();
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            assert_eq!(
                std::fs::metadata(&alive).expect("the marker").len(),
                when_dropped,
                "a descendant outlived the dropped turn and kept writing"
            );
        }

        /// The working root the agent is pointed at must be EMPTY, and
        /// `create_dir_all` over a persistent path does not make it so.
        #[tokio::test]
        async fn the_working_root_is_emptied_before_the_turn() {
            let w = world(&format!("cat > /dev/null\nls -A . >&2\n{}", answer("ok")));
            std::fs::write(w.work.path().join("left-over.txt"), "from a previous turn")
                .expect("seed");
            std::fs::create_dir_all(w.work.path().join("nested/deep")).expect("seed");

            let (out, _) = run(&w, &Cancel::never()).await;
            assert_eq!(out.expect("the answer"), "ok");
            let remaining: Vec<_> = std::fs::read_dir(w.work.path())
                .expect("read the root")
                .filter_map(|entry| entry.ok().map(|e| e.file_name()))
                .collect();
            assert!(
                remaining.is_empty(),
                "the agent was handed a working root with {remaining:?} in it"
            );
        }

        /// And a symlink where the root belongs is replaced, not followed —
        /// otherwise the "empty directory" the argv relies on is whatever the
        /// link points at.
        #[tokio::test]
        async fn a_symlinked_working_root_is_replaced_rather_than_followed() {
            let elsewhere = ScratchDir::new("agent-elsewhere");
            std::fs::write(elsewhere.path().join("secret.txt"), "not the agent's").expect("seed");
            let bin = ScratchDir::new("agent-bin");
            let program = fake_cli(bin.path(), &format!("cat > /dev/null\n{}", answer("ok")));
            let parent = ScratchDir::new("agent-parent");
            let link = parent.path().join("agent-root");
            std::os::unix::fs::symlink(elsewhere.path(), &link).expect("link");

            let out = ask(
                Agent::Codex,
                &program,
                &link,
                "q",
                Depth::Default,
                &Cancel::never(),
                |_| {},
            )
            .await;
            assert_eq!(out.expect("the answer"), "ok");
            assert!(
                elsewhere.path().join("secret.txt").exists(),
                "the link was followed and its target emptied"
            );
            assert!(!std::fs::symlink_metadata(&link)
                .expect("the root")
                .file_type()
                .is_symlink());
        }

        /// Protocol drift fails the turn rather than producing a quiet blank.
        #[tokio::test]
        async fn output_that_is_not_the_protocol_fails_the_turn() {
            let w = world(r#"cat > /dev/null; printf 'Welcome to the CLI!\n'"#);
            let (out, _) = run(&w, &Cancel::never()).await;
            match out {
                Err(Error::AgentMalformed { message, .. }) => {
                    assert!(message.contains("unreadable event"), "{message}");
                }
                other => panic!("non-protocol output was accepted: {other:?}"),
            }
        }

        #[tokio::test]
        async fn a_missing_program_is_named_rather_than_reported_as_io() {
            let dir = ScratchDir::new("agent-missing");
            let out = ask(
                Agent::Codex,
                &dir.path().join("nothing-here"),
                dir.path(),
                "q",
                Depth::Default,
                &Cancel::never(),
                |_| {},
            )
            .await;
            assert!(matches!(out, Err(Error::AgentMissing("Codex"))), "{out:?}");
        }
    }

    /// The reason survives; the identity does not.
    #[test]
    fn redact_keeps_the_reason_and_drops_what_identifies() {
        assert_eq!(redact("Not logged in"), "Not logged in");
        assert_eq!(
            redact("rate limit reached, retry in 60s"),
            "rate limit reached, retry in 60s"
        );

        let with_path = redact("failed reading /Users/someone/.codex/auth.json");
        assert!(with_path.starts_with("failed reading"), "{with_path}");
        assert!(
            !with_path.contains("someone"),
            "a home path reached the webview: {with_path}"
        );

        let with_email = redact("signed in as reader@example.test");
        assert!(
            !with_email.contains('@'),
            "an address reached the webview: {with_email}"
        );
    }

    /// ONE LINE, AND BOUNDED. A CLI that dumps a backtrace must not turn an
    /// error row into a wall.
    ///
    /// ⚠️ THE LAST LINE. What this reads is the TAIL of stderr, so its first
    /// line is routinely a fragment cut wherever the ring buffer began — and
    /// the reason a CLI gives is what it says last, after whatever banner it
    /// opened with. Taking the first line reported the banner, or half of one.
    #[test]
    fn redact_takes_one_bounded_line_from_the_end() {
        let many = format!("ne line\nsecond line\nnot logged in\n{}\n", "x".repeat(500));
        assert_eq!(redact(&many), "x".repeat(200) + "…");
        assert_eq!(
            redact("ne line\nsecond line\nnot logged in\n"),
            "not logged in"
        );

        let long = redact(&"word ".repeat(200));
        assert!(long.chars().count() <= 201, "{}", long.chars().count());
        assert!(long.ends_with('…'));
    }

    /// Leading blank lines are skipped rather than yielding an empty reason —
    /// an empty tail is what makes the caller fall back to the bare exit code.
    #[test]
    fn redact_skips_leading_blank_lines() {
        assert_eq!(redact("\n\n  \nNot logged in"), "Not logged in");
        assert_eq!(redact(""), "");
    }
}
