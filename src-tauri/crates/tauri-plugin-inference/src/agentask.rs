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

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::agent::Agent;
use crate::error::{Error, Result};
use crate::requests::Cancel;

/// Build the argv for a tool-free, read-only, one-shot turn.
///
/// Pure, so every flag has a test that breaks when it is removed — the same
/// discipline `spawn.rs` applies to the daemon's configuration, and for the
/// same reason: these arguments are the whole of the sandbox.
pub fn turn_args(agent: Agent, workdir: &Path) -> Vec<String> {
    let dir = workdir.to_string_lossy().into_owned();
    match agent {
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
    }
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
    cancel: &Cancel,
    mut on_delta: impl FnMut(String),
) -> Result<String> {
    tokio::fs::create_dir_all(workdir).await?;

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(turn_args(agent, workdir))
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
    let status = match child.wait().await {
        Ok(status) => status,
        Err(failure) => {
            take_down(&mut child);
            let _ = crate::procgroup::kill(&mut child, group).await;
            return Err(Error::Io(failure));
        }
    };
    if !status.success() && answer.is_empty() {
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
                format!("exited with {status}: {tail}")
            },
        });
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Each test names one flag of the lockdown, so removing that flag turns
     * exactly one red. These arguments ARE the sandbox — there is nothing
     * else between a book's text and an agent's tool call. */

    #[test]
    fn claude_disables_every_tool_with_the_wildcard() {
        let args = turn_args(Agent::Claude, Path::new("/tmp/empty"));
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
        let args = turn_args(Agent::Claude, Path::new("/tmp/empty"));
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
        let args = turn_args(Agent::Claude, Path::new("/tmp/empty"));
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
        let args = turn_args(Agent::Codex, Path::new("/tmp/empty"));
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

    /// Nothing dangerous, on either side. These flags exist and would make
    /// every other argument here pointless.
    #[test]
    fn no_bypass_flag_is_ever_passed() {
        for agent in crate::agent::AGENTS {
            for arg in turn_args(agent, Path::new("/tmp/empty")) {
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
        let args = turn_args(Agent::Codex, Path::new("/tmp/empty"));
        assert_eq!(
            args.last().unwrap(),
            "-",
            "codex reads the prompt from stdin"
        );
        for agent in crate::agent::AGENTS {
            for arg in turn_args(agent, Path::new("/tmp/empty")) {
                assert!(arg.len() < 200, "no argument should be carrying book text");
            }
        }
    }

    #[test]
    fn the_working_root_is_the_directory_it_was_given() {
        let args = turn_args(Agent::Codex, Path::new("/tmp/paper-empty"));
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
}
