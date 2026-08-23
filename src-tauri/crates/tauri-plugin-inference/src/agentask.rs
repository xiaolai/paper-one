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
    #[serde(default)]
    text: Option<String>,
}

/// Read one JSONL line from an agent. Returns the text to append, if any.
///
/// Pure and separately tested. Everything not named here is dropped — see the
/// module header for the list of what that includes.
pub fn parse_line(agent: Agent, line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    match agent {
        Agent::Codex => {
            let event: CodexEvent = serde_json::from_str(line).ok()?;
            // `item.completed` carrying an `agent_message` is the answer.
            // `thread.started`, `turn.started` and `turn.completed` carry a
            // thread id and token usage, and are dropped.
            if event.kind != "item.completed" {
                return None;
            }
            let item = event.item?;
            (item.kind == "agent_message").then_some(item.text?)
        }
        Agent::Claude => {
            let event: ClaudeEvent = serde_json::from_str(line).ok()?;
            // Only `stream_event` → `content_block_delta` → `text_delta`.
            // The `system`/`init`, `assistant` and `result` events carry the
            // working directory, session id, plugin paths and usage.
            if event.kind != "stream_event" {
                return None;
            }
            let inner = event.event?;
            if inner.kind != "content_block_delta" {
                return None;
            }
            inner.delta?.text
        }
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
    tokio::fs::create_dir_all(workdir).await?;

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

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::AgentMissing(agent.name())
        } else {
            Error::Io(e)
        }
    })?;

    /* The group, captured before anything can reap the child — `Child::id()`
     * is `None` after a wait, and every early return below may have waited. */
    let group = crate::procgroup::group_of(&child);

    /* THE SAME JOB-OBJECT GUARANTEE THE DAEMON GETS. Without this an agent
     * CLI on Windows was held only by its own handle, so cancelling killed the
     * leader and left whatever it had spawned running — the exact gap
     * `procgroup`'s header says the job object closes. Found by audit. */
    #[cfg(windows)]
    let _job = crate::procgroup::JobHandle::hold(&child)?;

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
    let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sink = std::sync::Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer).await {
                    Ok(0) => break,
                    Ok(_) => {
                        if let Ok(mut held) = sink.lock() {
                            /* Bounded: a child that loops printing must not
                             * grow this without limit. */
                            if held.len() < 4096 {
                                held.push_str(&String::from_utf8_lossy(&buffer));
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    /* EVERY EARLY RETURN BELOW TAKES THE GROUP DOWN. `?` on its own drops the
     * `Child`, and `kill_on_drop` reaches the leader only — so a missing
     * stdout or a read error left an agent turn running unattended, which on a
     * subscription route is a turn being spent on an answer nobody will read.
     * The closure is what makes that one line at each exit. */
    let take_down = |child: &mut tokio::process::Child| {
        let _ = crate::procgroup::terminate(child);
    };

    if let Some(mut stdin) = child.stdin.take() {
        /* The write races cancellation: a child that stops reading stdin —
         * one that failed to start, or is waiting on a prompt Paper will never
         * answer — would otherwise block here with no way out. */
        let wrote = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                take_down(&mut child);
                let _ = crate::procgroup::kill(&mut child, group).await;
                return Err(Error::Cancelled);
            }
            written = async {
                stdin.write_all(prompt.as_bytes()).await?;
                stdin.shutdown().await
            } => written,
        };
        if let Err(failure) = wrote {
            take_down(&mut child);
            let _ = crate::procgroup::kill(&mut child, group).await;
            return Err(Error::Io(failure));
        }
    }

    let Some(stdout) = child.stdout.take() else {
        take_down(&mut child);
        let _ = crate::procgroup::kill(&mut child, group).await;
        return Err(Error::AgentMalformed {
            agent: agent.name(),
            message: "no stdout".to_owned(),
        });
    };
    let mut lines = BufReader::new(stdout).lines();
    let mut answer = String::new();

    loop {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                // The reader gave up. Take the whole group down rather than
                // letting a subscription turn run on unattended.
                take_down(&mut child);
                let _ = crate::procgroup::kill(&mut child, group).await;
                return Err(Error::Cancelled);
            }
            line = lines.next_line() => line,
        };
        match next {
            Ok(Some(line)) => {
                if let Some(text) = parse_line(agent, &line) {
                    answer.push_str(&text);
                    on_delta(text);
                }
            }
            Ok(None) => break,
            Err(err) => {
                take_down(&mut child);
                let _ = crate::procgroup::kill(&mut child, group).await;
                return Err(Error::Io(err));
            }
        }
    }

    /* THE LAST TWO EXITS. `child.wait().await?` and the unsuccessful-exit
     * return below were the only post-spawn paths still leaving without a
     * group teardown — a `wait` that errors, or a CLI that exits non-zero
     * having already spawned a helper, left that helper running. Found by the
     * third audit round. `wait` reaps, so the group is captured above and
     * `kill` takes it as a parameter rather than reading a pid that is gone. */
    /* THE WAIT RACES CANCELLATION TOO. Every other await in this function
     * does, and this one did not: a child that closes stdout and then hangs —
     * flushing telemetry, waiting on a prompt nobody will answer — left
     * `wait()` pending with no way out, so the reader's Stop did nothing and a
     * subscription turn ran on unattended. EOF on stdout is not the end of the
     * process. */
    let status = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            take_down(&mut child);
            let _ = crate::procgroup::kill(&mut child, group).await;
            return Err(Error::Cancelled);
        }
        waited = child.wait() => match waited {
            Ok(status) => status,
            Err(failure) => {
                take_down(&mut child);
                let _ = crate::procgroup::kill(&mut child, group).await;
                return Err(Error::Io(failure));
            }
        },
    };
    /* A NONZERO EXIT IS A FAILED TURN, whatever arrived before it.
     *
     * This read `!status.success() && answer.is_empty()`, so a CLI that
     * streamed half an answer and then died returned `Ok` with the half — and
     * a truncated answer is indistinguishable from a complete one to every
     * caller above. Both CLIs exit 0 on success, so a nonzero status means the
     * turn did not finish, and saying so is the only honest option. */
    if !status.success() {
        let _ = crate::procgroup::kill(&mut child, group).await;
        let tail = stderr_tail
            .lock()
            .map(|held| held.trim().to_owned())
            .unwrap_or_default();
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
    /* THE GROUP GOES DOWN ON THE SUCCESS PATH TOO. A leader that exits
     * cleanly can still leave a detached helper holding the group — and one
     * that inherited stdout keeps a subscription turn alive after the answer
     * has been delivered. `wait` has reaped the leader; `group` was captured
     * before that, which is why this can still be taken down by id. */
    let _ = crate::procgroup::kill(&mut child, group).await;
    Ok(answer)
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
fn redact(tail: &str) -> String {
    const LIMIT: usize = 200;
    let first = tail
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let scrubbed: String = first
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
            ),
            Some("ok".to_owned())
        );
        // Everything else is dropped, thread id and usage included.
        for noise in [
            r#"{"type":"thread.started","thread_id":"01a02a73-22c2-7e40-8db8-d9f5229a7c1e"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":14692,"output_tokens":5}}"#,
        ] {
            assert_eq!(parse_line(Agent::Codex, noise), None, "{noise}");
        }
    }

    /// A reasoning or command item is not the answer.
    #[test]
    fn a_codex_item_that_is_not_an_agent_message_is_dropped() {
        assert_eq!(
            parse_line(
                Agent::Codex,
                r#"{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"thinking"}}"#
            ),
            None
        );
    }

    /// Claude, verbatim from `claude -p --output-format stream-json`.
    #[test]
    fn claude_delta_is_read() {
        assert_eq!(
            parse_line(
                Agent::Claude,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}},"session_id":"2117b276","uuid":"77cee48b"}"#
            ),
            Some("ok".to_owned())
        );
    }

    /// The init event is the biggest leak either CLI produces: cwd, session
    /// id, model, and every plugin's path under the reader's home directory.
    /// It must yield nothing.
    #[test]
    fn claudes_init_event_yields_nothing() {
        let init = r#"{"type":"system","subtype":"init","cwd":"/Users/someone/secret","session_id":"2117b276","model":"claude-opus-5","plugins":[{"name":"p","path":"/Users/someone/.claude/plugins/p"}],"tools":["Bash"]}"#;
        assert_eq!(parse_line(Agent::Claude, init), None);
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
            assert_eq!(parse_line(Agent::Claude, noise), None, "{noise}");
        }
    }

    #[test]
    fn malformed_and_blank_lines_are_skipped_by_both() {
        for agent in crate::agent::AGENTS {
            for line in ["", "   ", "not json", "{}", "[]"] {
                assert_eq!(parse_line(agent, line), None, "{agent:?} {line:?}");
            }
        }
    }

    /// The two agents' event shapes must not be read by each other's parser —
    /// a Codex answer fed to the Claude parser is not an answer.
    #[test]
    fn the_parsers_do_not_read_each_others_events() {
        let codex = r#"{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}"#;
        let claude = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"ok"}}}"#;
        assert_eq!(parse_line(Agent::Claude, codex), None);
        assert_eq!(parse_line(Agent::Codex, claude), None);
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
    /// error row into a wall, and only the first line carries the reason.
    #[test]
    fn redact_takes_one_bounded_line() {
        let many = format!("first line\nsecond line\n{}", "x".repeat(500));
        let said = redact(&many);
        assert_eq!(said, "first line");

        let long = redact(&"word ".repeat(200));
        assert!(said.chars().count() <= 200);
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
