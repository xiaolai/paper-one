//! THE LAUNCH PLAN — every flag `llama-server` is started with, and why.
//!
//! This module is pure: it turns a [`SpawnInputs`] into a [`SpawnPlan`] — a
//! program, an argv and the environment to set — and touches no filesystem and
//! no process. That is what makes WI-15.0's acceptance ("each line of the
//! configuration table has a test that breaks when it is removed") something a
//! unit test can hold rather than something an integration run has to notice.
//!
//! # One process, launched on one model
//!
//! ⚠️ **THIS LAUNCHED `lemond` UNTIL 2026-09-18**, Lemonade's daemon, which in
//! turn launched the same `llama-server` this launches now. What it added was
//! measured before it went (the benchmark and the audit are in AGENTS.md, "The
//! inference runtime"): about one millisecond per request, and three costs.
//!
//! - **The model's port had no key.** lemond held the per-launch token on ITS
//!   port and started `llama-server` one port over with none, and with CORS
//!   reflecting any origin: an unauthenticated `POST /v1/chat/completions`
//!   answered 200, and `/slots` could show the text of recent lookups.
//! - **It sized the context from free memory at each launch** — 66 816 to
//!   117 018 tokens on one machine in one afternoon, a 10–16 GB footprint for
//!   a 2.5 GB model. The context below is fixed, and the same launch measured
//!   1.2 GB.
//! - **It loaded the model on the first request**, so the reader's first
//!   lookup paid 6–8 s of model load. A bare server loads at start, which
//!   `ensureReady` begins when a word is SELECTED, before Look up is pressed.
//!
//! Everything else it offered — a model registry, a backend installer, cloud
//! providers, a speech route — Paper had switched off, replaced, or never
//! measured working. So the launch is `llama-server` itself, in single-model
//! mode: one process, one port, one model, one key.
//!
//! # The table
//!
//! | flag | ships as | Paper sets | why |
//! |---|---|---|---|
//! | `--host` | `127.0.0.1` | `127.0.0.1` | stated, because "the default is loopback" is not a property Paper controls |
//! | `--port` | 8080 | a free port the OS chose | a fixed port collides with the reader's other software |
//! | `-m`, `--alias` | none | the installed GGUF, named by its manifest id | single-model mode; answers name the model by id, never by path |
//! | `LLAMA_API_KEY` | none — every route open | a key minted per launch | the hole lemond's arrangement left |
//! | `--cors-origins` | `*`, echoing any `Origin` with credentials | an origin no page can have | nothing in a browser has any business here |
//! | `--no-cors-credentials` | credentials allowed | refused | the same, for the other half of the header |
//! | `--no-slots` | `/slots` on | off | it exposes recent prompts, and Paper never reads it |
//! | `--no-ui` | a web UI on the port | off | a chat page in front of the reader's model |
//! | `--offline` | may download | never | the model is a verified file; nothing is fetched |
//! | `-c` | from the model (262 144) | [`CONTEXT_TOKENS`] | see the constant |
//! | `-np` | auto | 1 | one reader, one question at a time; the whole context to it |
//! | `--jinja`, `--reasoning-format auto` | the same | stated | the launch the lookup's quality was measured under |
//!
//! Anything not in the table is llama.cpp's default. The table is what Paper
//! DECIDED; a flag that decides nothing Paper cares about is not restated here.
//!
//! # The key rides the environment, never the argv
//!
//! `--api-key KEY` puts the key in the process's argument list, which every
//! user on the machine can read with `ps`. `LLAMA_API_KEY` is the same setting
//! through the environment, which only the process's own user (and root) can
//! read — the same exposure lemond's `LEMONADE_API_KEY` had, and no file on
//! disk to clean up after a crash.
//!
//! # And the child inherits NOTHING llama.cpp would read
//!
//! ⚠️ **llama.cpp READS ITS WHOLE CONFIGURATION FROM THE ENVIRONMENT TOO.**
//! Every flag has an `LLAMA_ARG_*` twin, and among them are `LLAMA_ARG_TOOLS`
//! (whose `all` enables a built-in `exec_shell_command`), `LLAMA_ARG_AGENT`,
//! `LLAMA_ARG_MEDIA_PATH` and `LLAMA_ARG_MODEL_URL`. A flag on the command line
//! outranks its variable, but a variable for a flag Paper does not pass is
//! simply obeyed — so a reader's shell, launcher or CI decides what the child
//! does. Every inherited variable in the namespaces below is cleared before
//! Paper's own are set ([`clears`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rand::RngCore;

/// The loopback address the server binds, written out rather than named.
///
/// `localhost` resolves to both `127.0.0.1` and `::1`, so a server bound to it
/// binds two stacks and a reader's `/etc/hosts` decides what "local" means.
/// The literal binds what Paper meant.
pub const LOOPBACK: &str = "127.0.0.1";

/// The environment variable carrying the per-launch key — `--api-key`'s own
/// variable, which is `LLAMA_API_KEY` and not the `LLAMA_ARG_API_KEY` the rest
/// of the table's pattern would suggest (read off `llama-server --help` for
/// b10375).
pub const API_KEY_ENV: &str = "LLAMA_API_KEY";

/// How many tokens one request may hold — prompt and answer together.
///
/// A LOOKUP needs under a thousand: a 700-character system prompt, one
/// sentence and 160 tokens of answer. 8 192 is that several times over, and
/// measured at a 1.2 GB footprint against lemond's 10–16 GB for the context it
/// sized from free memory.
///
/// ⚠️ **THE COMPANION IS THE ONE CALLER THIS BOUNDS**, and it is unfinished
/// (`UNFINISHED_PANE_IDS`). `limits.rs` lets it send 64 KB of question, which
/// in Chinese is more than this holds. A prompt that does not fit is REFUSED by
/// the server with an HTTP error, never silently cut, so the reader sees a
/// failure rather than an answer to half a question. When the companion
/// ships, size this against what it actually sends — do not raise it here on
/// a guess, because it is paid in memory on every reader's machine.
pub const CONTEXT_TOKENS: u32 = 8192;

/// An `Origin` no web page can have.
///
/// `.invalid` is reserved (RFC 6761) and never resolves, so no document is ever
/// served from it and no browser ever sends it. Naming it is how the CORS
/// allow-list says "nobody": llama-server's own default is `*`, which echoes
/// whatever `Origin` arrives and allows credentials with it.
pub const NO_BROWSER_ORIGIN: &str = "https://paper.invalid";

/// The namespaces an inherited variable is cleared from. See the module header.
///
/// `LLAMA_` is llama.cpp's own (`LLAMA_ARG_*`, `LLAMA_API_KEY`, `LLAMA_CACHE`,
/// `LLAMA_LOG_*`); `GGML_` is its tensor library's, where a variable can move
/// which Metal shader library is loaded; `HF_` is Hugging Face's, which decides
/// where a download lands and with whose token.
pub const CLEARED_PREFIXES: &[&str] = &["LLAMA_", "GGML_", "HF_"];

/// Two Hugging Face cache variables outside its `HF_` prefix.
pub const CLEARED_NAMES: &[&str] = &["HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE"];

/// Whether an inherited environment variable must not reach the child.
///
/// Case-insensitive, because Windows' environment is: `llama_arg_tools` and
/// `LLAMA_ARG_TOOLS` are one variable there.
pub fn clears(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    CLEARED_PREFIXES
        .iter()
        .any(|prefix| upper.starts_with(prefix))
        || CLEARED_NAMES.contains(&upper.as_str())
}

/// What a caller must decide before a server can be launched.
#[derive(Debug, Clone)]
pub struct SpawnInputs {
    /// The backend the runtime manifest verified — the only kind there is. A
    /// plan for an unverified executable cannot be built; see `runtime.rs`.
    pub backend: crate::runtime::VerifiedBackend,
    /// The installed GGUF, absolute.
    pub model: PathBuf,
    /// Its manifest id — what answers are named by (`--alias`), and what
    /// `inference_resource_usage` reports as loaded.
    pub model_id: String,
    /// Where the server's process-group record goes (`lineage.rs`), so a
    /// Paper killed outright leaves the next launch something to collect.
    pub record_path: PathBuf,
    /// The loopback port. Chosen by the caller, which is what lets a test bind
    /// its own and the app ask the OS for a free one.
    pub port: u16,
    /// The per-launch key, hex. [`mint_token`] makes one.
    pub api_key: String,
}

/// A launch, fully decided.
#[derive(Clone, PartialEq, Eq)]
pub struct SpawnPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Variables to SET on the child, AFTER every inherited one [`clears`]
    /// names has been removed — see [`SpawnPlan::inherited_removals`].
    pub env: BTreeMap<String, String>,
    /// See [`SpawnInputs::record_path`].
    pub record_path: PathBuf,
    pub port: u16,
    /// See [`SpawnInputs::model_id`].
    pub model_id: String,
    /// The llama.cpp build the runtime manifest pinned, e.g. `b10375` — what
    /// the settings row reports as the runtime's version.
    pub version: String,
    /// The directory the server runs IN — its own, which the manifest verified.
    ///
    /// ⚠️ **ggml LOADS BACKENDS FROM THE WORKING DIRECTORY TOO.** Its registry
    /// scans the executable's folder AND the current directory for
    /// `libggml-<backend>-*` / `ggml-*.dll` and loads the best-scoring one
    /// (`ggml-backend-reg.cpp`, b10375) — which is how the Linux and Windows
    /// builds find their CPU backends at all. The server inherited PAPER'S
    /// working directory, so a library planted there was loaded without the
    /// manifest ever seeing it (found 2026-09-18, reading the loader). Run in
    /// its own folder, both places the scan looks are the verified tree. lemond
    /// did the same for the server it launched.
    pub working_dir: PathBuf,
}

/* THE KEY IS NOT PRINTED. `SpawnPlan` derived `Debug` while the key sat in
 * `env`, so any `{plan:?}` — a log line, a failed `assert_eq!` — would have
 * written a live credential out. The shape is kept; the values are not. */
impl std::fmt::Debug for SpawnPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnPlan")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("record_path", &self.record_path)
            .field("port", &self.port)
            .field("model_id", &self.model_id)
            .field("version", &self.version)
            .field("working_dir", &self.working_dir)
            .finish()
    }
}

impl SpawnPlan {
    /// The inherited variables to clear on the child, given the names in
    /// Paper's own environment.
    ///
    /// Everything [`clears`] names, EXCEPT what this plan sets itself: Paper's
    /// own `LLAMA_API_KEY` is in the cleared namespace, and the launch removes
    /// before it sets, so an inherited key is replaced rather than kept.
    pub fn inherited_removals<I, S>(&self, inherited: I) -> Vec<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        inherited
            .into_iter()
            .map(|name| name.as_ref().to_owned())
            .filter(|name| clears(name) && !self.env.contains_key(name))
            .collect()
    }

    /// The base URL of the server's HTTP API.
    pub fn base_url(&self) -> String {
        format!("http://{LOOPBACK}:{}", self.port)
    }

    /// The per-launch key.
    pub fn api_key(&self) -> &str {
        &self.env[API_KEY_ENV]
    }
}

/// Mint a per-launch key: 32 random bytes, hex.
///
/// Per LAUNCH and not per install — a key that outlived the process would be a
/// credential at rest, and there is nothing for it to authenticate to once the
/// server it was minted for has exited.
pub fn mint_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    data_encoding::HEXLOWER.encode(&bytes)
}

/// Turn inputs into a launch. Pure.
pub fn plan_spawn(inputs: &SpawnInputs) -> SpawnPlan {
    /* The per-launch key invariant, ENFORCED rather than assumed: `mint_token`
     * is 64 lowercase hex characters, and a plan built with an empty or
     * hand-rolled key would authenticate nothing while looking configured.
     * Loud here, where the plan is made, not at the question. */
    assert!(
        inputs.api_key.len() == 64 && inputs.api_key.chars().all(|c| c.is_ascii_hexdigit()),
        "SpawnInputs.api_key is not a minted token — use mint_token()"
    );
    let mut env = BTreeMap::new();
    env.insert(API_KEY_ENV.to_owned(), inputs.api_key.clone());

    let args = vec![
        "-m".to_owned(),
        inputs.model.to_string_lossy().into_owned(),
        "--alias".to_owned(),
        inputs.model_id.clone(),
        "--host".to_owned(),
        LOOPBACK.to_owned(),
        "--port".to_owned(),
        inputs.port.to_string(),
        "-c".to_owned(),
        CONTEXT_TOKENS.to_string(),
        "-np".to_owned(),
        "1".to_owned(),
        "--cors-origins".to_owned(),
        NO_BROWSER_ORIGIN.to_owned(),
        "--no-cors-credentials".to_owned(),
        "--no-slots".to_owned(),
        "--no-ui".to_owned(),
        "--offline".to_owned(),
        "--jinja".to_owned(),
        "--reasoning-format".to_owned(),
        "auto".to_owned(),
    ];

    SpawnPlan {
        program: inputs.backend.server().to_path_buf(),
        args,
        env,
        record_path: inputs.record_path.clone(),
        port: inputs.port,
        model_id: inputs.model_id.clone(),
        version: inputs.backend.tag().to_owned(),
        /* The server's own directory. `server()` is `dir.join(<relative>)` of a
        verified tree, so it always has a parent; the fallback is never taken
        and would be a refusal-worthy tree anyway. */
        working_dir: inputs
            .backend
            .server()
            .parent()
            .map_or_else(|| inputs.backend.server().to_path_buf(), Path::to_path_buf),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "/opt/paper/runtime/backend/llamacpp/metal/llama-server";
    const MODEL: &str = "/data/Paper/inference/models/qwen/Qwen.gguf";

    fn inputs() -> SpawnInputs {
        SpawnInputs {
            backend: crate::runtime::VerifiedBackend::for_test("metal", SERVER),
            model: PathBuf::from(MODEL),
            model_id: "qwen".to_owned(),
            record_path: PathBuf::from("/data/Paper/inference/daemon.json"),
            port: 13399,
            // A real minted shape — `plan_spawn` asserts the invariant.
            api_key: "deadbeef".repeat(8),
        }
    }

    /// The value after `flag`, or `None`.
    fn value_of(plan: &SpawnPlan, flag: &str) -> Option<String> {
        plan.args
            .windows(2)
            .find(|pair| pair[0] == flag)
            .map(|pair| pair[1].clone())
    }

    /* Each test below names one line of the table in the module header, and is
     * written to FAIL WHEN THE LINE IS REMOVED — WI-15.0's acceptance restated
     * as code. The last test pins the whole argv, so a flag ADDED without a
     * line in the table fails too. */

    #[test]
    fn the_program_is_the_verified_server_and_nothing_else() {
        assert_eq!(plan_spawn(&inputs()).program, PathBuf::from(SERVER));
    }

    #[test]
    fn host_is_the_loopback_literal_not_localhost() {
        assert_eq!(
            value_of(&plan_spawn(&inputs()), "--host").as_deref(),
            Some("127.0.0.1")
        );
    }

    #[test]
    fn the_port_is_the_one_the_caller_chose() {
        let plan = plan_spawn(&inputs());
        assert_eq!(value_of(&plan, "--port").as_deref(), Some("13399"));
        assert_eq!(plan.base_url(), "http://127.0.0.1:13399");
    }

    /// Single-model mode, and the model is NAMED by its manifest id: an answer
    /// carries `model`, and under lemond that was the artifact's absolute path
    /// — the reader's home directory on every chunk (`generate.rs`).
    #[test]
    fn the_model_is_loaded_by_path_and_named_by_id() {
        let plan = plan_spawn(&inputs());
        assert_eq!(value_of(&plan, "-m").as_deref(), Some(MODEL));
        assert_eq!(value_of(&plan, "--alias").as_deref(), Some("qwen"));
        assert_eq!(plan.model_id, "qwen");
    }

    /// THE HOLE THIS REPLACED: lemond's backend listened with no key at all.
    #[test]
    fn a_key_is_always_provisioned_through_the_environment() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.env.get("LLAMA_API_KEY").map(String::as_str),
            Some("deadbeef".repeat(8).as_str())
        );
        assert_eq!(plan.api_key(), "deadbeef".repeat(8));
    }

    /// ⚠️ NEVER IN THE ARGV, which every user on the machine can read.
    #[test]
    fn the_key_is_never_on_the_command_line() {
        let plan = plan_spawn(&inputs());
        assert!(
            !plan
                .args
                .iter()
                .any(|arg| arg.contains(&"deadbeef".repeat(8)) || arg.starts_with("--api-key")),
            "{:?}",
            plan.args
        );
    }

    /// And never in a `{:?}`: a failed assertion or a log line printing the
    /// plan would otherwise write the credential out.
    #[test]
    fn the_key_is_never_printed() {
        let rendered = format!("{:?}", plan_spawn(&inputs()));
        assert!(!rendered.contains("deadbeef"), "{rendered}");
        assert!(rendered.contains("LLAMA_API_KEY"), "{rendered}");
    }

    /// The invariant `plan_spawn` asserts: a plan cannot be built around a key
    /// that is not a minted token.
    #[test]
    #[should_panic(expected = "not a minted token")]
    fn a_plan_with_an_unminted_key_dies_at_construction() {
        let mut bad = inputs();
        bad.api_key = "hunter2".to_owned();
        let _ = plan_spawn(&bad);
    }

    /// `*` is llama-server's default, and with credentials on it echoes any
    /// `Origin` — measured: a preflight from `https://evil.example` came back
    /// allowed. Nothing in a browser is a client of this port.
    #[test]
    fn no_browser_origin_is_allowed() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            value_of(&plan, "--cors-origins").as_deref(),
            Some("https://paper.invalid")
        );
        assert!(plan.args.iter().any(|a| a == "--no-cors-credentials"));
    }

    #[test]
    fn the_slots_endpoint_is_off_because_it_shows_prompts() {
        assert!(plan_spawn(&inputs()).args.iter().any(|a| a == "--no-slots"));
    }

    #[test]
    fn there_is_no_web_ui_on_the_port() {
        assert!(plan_spawn(&inputs()).args.iter().any(|a| a == "--no-ui"));
    }

    #[test]
    fn nothing_is_fetched() {
        assert!(plan_spawn(&inputs()).args.iter().any(|a| a == "--offline"));
    }

    #[test]
    fn the_context_is_fixed_rather_than_sized_from_free_memory() {
        let plan = plan_spawn(&inputs());
        assert_eq!(value_of(&plan, "-c").as_deref(), Some("8192"));
        assert_eq!(value_of(&plan, "-np").as_deref(), Some("1"));
    }

    #[test]
    fn the_template_settings_are_the_ones_quality_was_measured_under() {
        let plan = plan_spawn(&inputs());
        assert!(plan.args.iter().any(|a| a == "--jinja"));
        assert_eq!(
            value_of(&plan, "--reasoning-format").as_deref(),
            Some("auto")
        );
    }

    /// THE WHOLE ARGV, pinned — the closed list of flags this module wrote.
    /// Nothing in it comes from a caller except the port, the model's path
    /// and its id, and a flag added without a line in the table fails here.
    #[test]
    fn the_argv_is_exactly_the_table() {
        assert_eq!(
            plan_spawn(&inputs()).args,
            [
                "-m",
                MODEL,
                "--alias",
                "qwen",
                "--host",
                "127.0.0.1",
                "--port",
                "13399",
                "-c",
                "8192",
                "-np",
                "1",
                "--cors-origins",
                "https://paper.invalid",
                "--no-cors-credentials",
                "--no-slots",
                "--no-ui",
                "--offline",
                "--jinja",
                "--reasoning-format",
                "auto",
            ]
        );
    }

    /// ⚠️ ggml scans the WORKING DIRECTORY for backend libraries, so the
    /// server runs in its own verified folder — never in whatever directory
    /// Paper happened to be started from.
    #[test]
    fn the_server_runs_in_its_own_verified_folder() {
        assert_eq!(
            plan_spawn(&inputs()).working_dir,
            PathBuf::from("/opt/paper/runtime/backend/llamacpp/metal")
        );
    }

    #[test]
    fn the_version_is_the_pinned_llamacpp_build() {
        assert_eq!(plan_spawn(&inputs()).version, "b0000");
    }

    #[test]
    fn a_token_is_thirty_two_bytes_of_hex_and_never_repeats() {
        let a = mint_token();
        let b = mint_token();
        assert_eq!(a.len(), 64, "32 bytes, hex");
        // LOWERCASE hex, as documented — `is_ascii_hexdigit` also took A–F,
        // so the encoding contract was asserted by nothing.
        assert!(a
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_ne!(a, b, "per launch, not per install");
    }

    /// ⚠️ `LLAMA_ARG_TOOLS=all` is a shell tool, obeyed from the environment.
    #[test]
    fn every_inherited_llama_ggml_and_hf_variable_is_cleared() {
        for name in [
            "LLAMA_ARG_TOOLS",
            "LLAMA_ARG_AGENT",
            "LLAMA_ARG_HOST",
            "LLAMA_ARG_MODEL_URL",
            "LLAMA_CACHE",
            "GGML_METAL_PATH_RESOURCES",
            "HF_HOME",
            "HF_TOKEN",
            "HUGGINGFACE_HUB_CACHE",
            "TRANSFORMERS_CACHE",
            // Windows' environment is case-insensitive.
            "llama_arg_tools",
        ] {
            assert!(clears(name), "{name} would reach the child");
        }
        for name in ["PATH", "HOME", "TMPDIR", "LANG", "LLAMAS", "HFX"] {
            assert!(!clears(name), "{name} is not llama.cpp's to read");
        }
    }

    /// Removed BEFORE Paper's own are set, and never Paper's own: the launch's
    /// key is in the cleared namespace, and clearing it would start a server
    /// with no key — the exact hole this module exists to close.
    #[test]
    fn what_paper_sets_is_never_among_what_it_clears() {
        let plan = plan_spawn(&inputs());
        let removals = plan.inherited_removals(["LLAMA_API_KEY", "LLAMA_ARG_TOOLS", "PATH"]);
        assert_eq!(removals, ["LLAMA_ARG_TOOLS"]);
        for key in plan.env.keys() {
            assert!(clears(key), "{key} is set but in no cleared namespace");
            assert!(!plan.inherited_removals([key.as_str()]).contains(key));
        }
    }
}
