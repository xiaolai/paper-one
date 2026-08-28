//! THE SPAWN CONFIGURATION — every default this crate overrides, and why.
//!
//! This module is pure: it turns a [`SpawnInputs`] into a [`SpawnPlan`] — a
//! program, an argv, an environment and a `config.json` — and touches no
//! filesystem and no process. That is what makes WI-15.0's acceptance
//! ("each of the eight lines has a test that breaks when it is removed")
//! something a unit test can hold rather than something an integration run
//! has to notice.
//!
//! # The configuration is not defaults plus overrides
//!
//! Every line below is a shipped default pointing the wrong way for an app
//! that redistributes and supervises this daemon. Measured against
//! `lemonade-embeddable-11.7.0-macos-arm64` on 2026-08-23 — the values are
//! quoted from the `resources/defaults.json` in that artifact, and each
//! "found" note is something the smoke test actually observed rather than
//! something read off the documentation:
//!
//! | key | ships as | Paper sets | found |
//! |---|---|---|---|
//! | `LEMONADE_CACHE_DIR` | `~/.cache/lemonade` | Paper-owned | `lemond --help` alone creates it |
//! | `models_dir` | `"auto"` | Paper-owned | `auto` resolved to `~/.cache/huggingface/hub` EVEN with the cache dir moved |
//! | `host` | `"localhost"` | `127.0.0.1` | `localhost` also resolves `::1`; the literal binds one stack |
//! | `broadcast` | `true` | `false` | UDP discovery beacon on by default |
//! | api key | none required | random per launch | without one, every route is open |
//! | `auto_check_model_updates` | `true` | `false` | Paper owns the manifest, not upstream |
//! | `llamacpp.prefer_system` | `true` | `false` | prefers a llama.cpp found on PATH over the vetted builtin |
//! | `inhibit_suspend` | `true` | `false` | a reader must not hold the machine awake |
//! | `no_fetch_executables` | `false` | `true` | the daemon fetched llama.cpp from GitHub inside the first gloss, unhashed (WI-20.24) |
//! | `llamacpp.<backend>_bin` | `"builtin"` | the verified `llama-server` | "builtin" is whatever the fetch left in the cache; a path is never downloaded |
//!
//! The last two are the same decision from two sides. `<backend>_bin` takes
//! the EXECUTABLE'S path — `lemond` execs it directly, with its directory as
//! the working directory (`llamacpp_server.cpp`) — and is read from the
//! environment before the config (`LEMONADE_LLAMACPP_<BACKEND>_BIN`,
//! `backend_utils.cpp`'s `get_bin_config_value`), so it is set on both, the
//! way `--no-broadcast` is: the config file is the one the daemon rewrites.
//! `llamacpp.backend` is pinned to the staged backend's name rather than
//! left `auto`, because `auto` on a machine with a GPU would pick a backend
//! nothing staged and, with fetching forbidden, fail at the first model.
//!
//! # Three channels, and they are not interchangeable
//!
//! The smoke test's most useful finding is that these settings arrive by
//! three different routes and each key accepts only its own:
//!
//! - **`config.json`, pre-written into the cache dir.** The ONLY channel for
//!   `models_dir`, `llamacpp.prefer_system`, `auto_check_model_updates` and
//!   `inhibit_suspend` — none of them has a CLI flag. Paper writes this file
//!   before every launch rather than once, because it is also the file the
//!   daemon rewrites at runtime.
//! - **CLI flags**, for `--host`, `--port` and `--no-broadcast`.
//! - **The environment**, for `LEMONADE_CACHE_DIR`, `LEMONADE_API_KEY` and
//!   the per-provider cloud keys (F1: `LEMONADE_<PROVIDER>_API_KEY` outranks
//!   any runtime key, which is what stops a client swapping the reader's).
//!
//! `--no-broadcast` IS BOTH, and the redundancy is deliberate: the flag was
//! observed to disable broadcasting for the run while leaving `broadcast:
//! true` in the config the daemon then rewrote. Either channel alone leaves a
//! way for the beacon to come back — the flag omitted from one spawn, or the
//! config file rewritten by the daemon — so both are set on every launch.
//!
//! # What could not be turned off
//!
//! The daemon starts a WebSocket server on a port it picks itself (9000 in
//! the smoke test; the plan's earlier probe saw 9002). `websocket_port: 0`
//! does NOT disable it — verified. What IS true, and is the reason this is
//! recorded rather than escalated: it inherits `--host`, so with the host
//! pinned to `127.0.0.1` it binds the loopback only, which `lsof` confirmed.
//! The plan asked to "prove bind/auth or disable"; disable is not on offer,
//! so this proves bind — see `daemon.rs`'s `websocket_is_loopback` check,
//! which asserts it at runtime rather than trusting this note.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rand::RngCore;

/// The loopback address the daemon binds, written out rather than named.
///
/// `localhost` is what ships, and it is not the same thing: it resolves to
/// both `127.0.0.1` and `::1`, so the daemon binds two stacks and a reader's
/// `/etc/hosts` decides what "local" means. The literal binds what Paper
/// meant.
pub const LOOPBACK: &str = "127.0.0.1";

/// The environment variable naming the daemon's cache directory.
pub const CACHE_DIR_ENV: &str = "LEMONADE_CACHE_DIR";

/// The environment variable carrying the per-launch bearer token.
pub const API_KEY_ENV: &str = "LEMONADE_API_KEY";

/// The config format this crate writes. The shipped `defaults.json` declares
/// `config_version: 2`; writing a file without it would leave the daemon to
/// guess which shape it is reading.
pub const CONFIG_VERSION: u32 = 2;

/// What a caller must decide before a daemon can be launched.
#[derive(Debug, Clone)]
pub struct SpawnInputs {
    /// The `lemond` executable Paper ships and supervises. Absolute.
    pub program: PathBuf,
    /// The backend the manifest verified — the only kind there is. A plan
    /// for an unverified backend cannot be built; see `runtime.rs`.
    pub backend: crate::runtime::VerifiedBackend,
    /// The Paper-owned cache directory. Need not exist — the daemon creates
    /// it, which WI-15.0's first acceptance line turns on.
    pub cache_dir: PathBuf,
    /// Where the daemon's process-group record goes (`lineage.rs`), so a
    /// Paper killed outright leaves the next launch something to collect.
    pub record_path: PathBuf,
    /// The Paper-owned model directory. Kept OUT of the cache directory on
    /// purpose: models are the expensive, reader-visible artifact ("Models
    /// folder … [Reveal]" in the settings sketch) and the cache is scratch.
    pub models_dir: PathBuf,
    /// The loopback port. Chosen by the caller, which is what lets a test
    /// bind its own and the app ask the OS for a free one.
    pub port: u16,
    /// The per-launch bearer token, hex. [`mint_token`] makes one.
    pub api_key: String,
    /// Cloud provider keys, by provider id (F1/WI-15.8). Provisioned into the
    /// CHILD'S ENVIRONMENT at spawn and never through `/v1/cloud/auth`,
    /// because `LEMONADE_<PROVIDER>_API_KEY` outranks a runtime key and that
    /// precedence is the thing stopping a client swapping the reader's.
    pub cloud_keys: BTreeMap<String, String>,
}

/// A launch, fully decided: nothing below this reads a default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Variables to SET on the child. See [`SpawnPlan::env_removals`] for the
    /// ones to clear.
    pub env: BTreeMap<String, String>,
    /// The `config.json` to write into `cache_dir` before launching.
    pub config: serde_json::Value,
    pub cache_dir: PathBuf,
    pub models_dir: PathBuf,
    /// See [`SpawnInputs::record_path`].
    pub record_path: PathBuf,
    pub port: u16,
}

/// The prefix of a per-provider cloud key (F1).
pub fn cloud_key_var(provider: &str) -> String {
    format!("LEMONADE_{}_API_KEY", provider.to_ascii_uppercase())
}

/// The environment variable naming a llama.cpp backend's executable — the
/// channel `lemond` reads BEFORE the config key of the same name.
pub fn backend_bin_var(backend: &str) -> String {
    format!("LEMONADE_LLAMACPP_{}_BIN", backend.to_ascii_uppercase())
}

/// Environment variables the child must NOT inherit.
///
/// The parent is Paper, and Paper's own environment is whatever the reader's
/// shell, launcher or CI happened to export. Two of these decide where
/// gigabytes land and one decides whether the daemon phones an observability
/// endpoint; inheriting any of them would silently undo a line above.
pub const ENV_REMOVALS: &[&str] = &[
    // Would move the model store back out from under `models_dir`.
    "HF_HOME",
    "HF_HUB_CACHE",
    "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    // Would point the daemon at a different resources/defaults.json than the
    // one Paper ships beside the binary it is launching.
    "LEMONADE_DEFAULTS_PATH",
    // A second key, separate from LEMONADE_API_KEY, that gates the control
    // plane. Paper mints its own; an inherited one is somebody else's.
    "LEMONADE_ADMIN_API_KEY",
    // Would widen the CORS origins the daemon accepts.
    "LEMONADE_ALLOWED_ORIGINS",
    // Would re-point the host/port the client half then would not find.
    "LEMONADE_HOST",
    "LEMONADE_PORT",
];

impl SpawnPlan {
    /// The variables to clear on the child, so an inherited one cannot undo a
    /// decision made here. See [`ENV_REMOVALS`].
    pub fn env_removals(&self) -> &'static [&'static str] {
        ENV_REMOVALS
    }

    /// The base URL of the daemon's HTTP API.
    pub fn base_url(&self) -> String {
        format!("http://{LOOPBACK}:{}", self.port)
    }

    /// Where the `config.json` goes.
    pub fn config_path(&self) -> PathBuf {
        self.cache_dir.join("config.json")
    }
}

/// Mint a per-launch bearer token: 32 random bytes, hex.
///
/// Per LAUNCH and not per install — a token that outlived the process would
/// be a credential at rest, and there is nothing for it to authenticate to
/// once the daemon it was minted for has exited.
pub fn mint_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    data_encoding::HEXLOWER.encode(&bytes)
}

/// Turn inputs into a launch. Pure.
pub fn plan_spawn(inputs: &SpawnInputs) -> SpawnPlan {
    let mut env = BTreeMap::new();
    env.insert(CACHE_DIR_ENV.to_owned(), path_string(&inputs.cache_dir));
    env.insert(API_KEY_ENV.to_owned(), inputs.api_key.clone());
    for (provider, key) in &inputs.cloud_keys {
        env.insert(cloud_key_var(provider), key.clone());
    }
    let server = path_string(inputs.backend.server());
    env.insert(backend_bin_var(inputs.backend.name()), server.clone());

    let args = vec![
        "--host".to_owned(),
        LOOPBACK.to_owned(),
        "--port".to_owned(),
        inputs.port.to_string(),
        // Both channels, on every launch — see the module header.
        "--no-broadcast".to_owned(),
    ];

    let config = serde_json::json!({
        "config_version": CONFIG_VERSION,
        // The only channel for this one: there is no --models-dir flag, and
        // `auto` resolves to the HuggingFace hub cache even with the cache
        // directory moved. Verified, not assumed.
        "models_dir": path_string(&inputs.models_dir),
        /* ⚠️ **THE KEY THAT MAKES AN INSTALLED MODEL VISIBLE**, and it was
         * empty — which is why the gloss answered `runtimeHttp` 404 on every
         * lookup with a 2.3 GB model sitting on disk.
         *
         * `models_dir` is the HUGGINGFACE HUB CACHE. Its shipped default is
         * `auto`, which resolves to `~/.cache/huggingface/hub`, and the layout
         * it expects is `models--<org>--<repo>/snapshots/<rev>/…`. Paper
         * writes `models/<manifest-id>/<artifact>.gguf`, which is not that, so
         * pointing `models_dir` at it hands the daemon an EMPTY cache:
         * `/api/v1/models` answered `{"data":[]}` while the Local models pane
         * said `Installed · 2.5 GB`.
         *
         * `extra_models_dir` is the one that takes a folder of loose GGUF
         * files — the daemon's own strings are `Scanning for GGUF models in: `
         * and three validations about it being a readable directory. Both are
         * set: the hub cache stays Paper-owned so nothing is written to the
         * reader's real `~/.cache`, and the scan finds what Paper downloaded.
         *
         * Paper never registers a model over the API — `install.rs` calls no
         * daemon endpoint at all — so this config key is the ONLY way an
         * installed model becomes reachable. That is what made the failure
         * total rather than intermittent. */
        "extra_models_dir": path_string(&inputs.models_dir),
        "host": LOOPBACK,
        "port": inputs.port,
        // The second half of the belt-and-braces above.
        "broadcast": false,
        // Paper owns the manifest (WI-15.1). An upstream update check would
        // make the activation slot disagree with the digest Paper recorded.
        "auto_check_model_updates": false,
        // A reader's laptop sleeps. A daemon idling behind a shut side pane
        // has no claim on that.
        "inhibit_suspend": false,
        // Telemetry is already off in the shipped defaults; stated anyway,
        // because "off by default upstream" is not a property Paper controls.
        "telemetry": { "enabled": false },
        /* NOTHING IS FETCHED. Ships `false`: the daemon downloaded llama.cpp
         * from GitHub inside the first gloss, with no hash Paper checked and
         * no quarantine flag for Gatekeeper to act on, and this file called
         * the result "the vetted builtin". The backend is the one the
         * manifest verified before this plan was built (WI-20.24). */
        "no_fetch_executables": true,
        "llamacpp": {
            // Ships `true`, which prefers a llama.cpp binary found on the
            // SYSTEM over the one inside the artifact Paper verified. That is
            // an unverified executable on the reader's PATH deciding how the
            // reader's book is read.
            "prefer_system": false,
            // Pinned rather than `auto`: on a machine with a GPU, `auto`
            // picks a backend nothing staged and fetching is forbidden.
            "backend": inputs.backend.name(),
            // The executable's path, which `lemond` execs directly and never
            // downloads. Also in the environment above, which outranks this
            // and survives the daemon rewriting the file.
            format!("{}_bin", inputs.backend.name()): server,
        },
    });

    SpawnPlan {
        program: inputs.program.clone(),
        args,
        env,
        config,
        cache_dir: inputs.cache_dir.clone(),
        models_dir: inputs.models_dir.clone(),
        record_path: inputs.record_path.clone(),
        port: inputs.port,
    }
}

/// A path as the string an environment variable or a JSON field carries.
///
/// Lossy on purpose and ONLY here: a non-Unicode path would otherwise fail
/// the launch, and the caller has already validated the roots it built these
/// from (`paths.rs`). Every path that crosses IPC goes through the typed
/// error instead.
fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "/opt/paper/runtime/backend/llamacpp/metal/llama-server";

    fn inputs() -> SpawnInputs {
        SpawnInputs {
            program: PathBuf::from("/opt/paper/runtime/lemond"),
            backend: crate::runtime::VerifiedBackend::for_test("metal", SERVER),
            cache_dir: PathBuf::from("/data/Paper/inference/runtime"),
            models_dir: PathBuf::from("/data/Paper/inference/models"),
            record_path: PathBuf::from("/data/Paper/inference/daemon.json"),
            port: 13399,
            api_key: "deadbeef".to_owned(),
            cloud_keys: BTreeMap::new(),
        }
    }

    /// WI-20.24. The shipped default lets the daemon fetch a backend from
    /// GitHub — inside the first gloss, with no hash Paper controls — and
    /// `spawn.rs` used to call that "the vetted builtin". Nothing is fetched:
    /// the backend is the one the manifest verified, and the daemon is told
    /// so on BOTH channels, because the env var outranks the config key and
    /// the config file is the one the daemon rewrites.
    #[test]
    fn executables_are_never_fetched() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.config["no_fetch_executables"],
            serde_json::Value::Bool(true),
            "ships false — the daemon downloads llama.cpp from GitHub with no hash Paper checks"
        );
    }

    #[test]
    fn the_backend_is_the_verified_one_on_both_channels() {
        let plan = plan_spawn(&inputs());
        assert_eq!(plan.config["llamacpp"]["backend"], "metal");
        assert_eq!(
            plan.config["llamacpp"]["metal_bin"], SERVER,
            "lemond's `<backend>_bin` takes the executable's path and never downloads"
        );
        assert_eq!(
            plan.env
                .get("LEMONADE_LLAMACPP_METAL_BIN")
                .map(String::as_str),
            Some(SERVER),
            "the env var outranks the config key, and survives the daemon rewriting config.json"
        );
    }

    #[test]
    fn the_record_path_travels_with_the_plan() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.record_path,
            PathBuf::from("/data/Paper/inference/daemon.json")
        );
    }

    /* Each test below names one line of the table in the module header. They
     * are written to FAIL WHEN THE LINE IS REMOVED, which is WI-15.0's
     * acceptance restated as code: deleting the `broadcast` key, the
     * `models_dir` key or the `--no-broadcast` argument each turns exactly
     * one of these red. */

    #[test]
    fn cache_dir_is_paper_owned() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.env.get(CACHE_DIR_ENV).map(String::as_str),
            Some("/data/Paper/inference/runtime"),
            "the cache dir must be set, or the daemon writes to ~/.cache/lemonade"
        );
    }

    /// ⚠️ **AN INSTALLED MODEL THE DAEMON CANNOT SEE.**
    ///
    /// `models_dir` is the HuggingFace hub cache — default `auto`, resolving
    /// to `~/.cache/huggingface/hub`, laid out as
    /// `models--<org>--<repo>/snapshots/<rev>/…`. Paper writes
    /// `models/<manifest-id>/<artifact>.gguf`, so pointing only `models_dir`
    /// at it hands the daemon an empty cache.
    ///
    /// Measured in the running app: `/api/v1/models` answered `{"data":[]}`
    /// with a 2.3 GB GGUF on disk, the Local models pane said
    /// `Installed · 2.5 GB`, and every gloss came back
    /// `the inference runtime answered 404 for /api/v1/chat/completions`.
    ///
    /// `extra_models_dir` is the folder-of-loose-GGUFs key — the daemon's own
    /// strings are `Scanning for GGUF models in: ` plus three validations
    /// about it being a readable directory. Paper registers nothing over the
    /// API (`install.rs` calls no daemon endpoint), so this key is the only
    /// route from "downloaded" to "answerable".
    #[test]
    fn extra_models_dir_points_at_the_models_paper_downloaded() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.config["extra_models_dir"],
            "/data/Paper/inference/models"
        );
        assert_ne!(
            plan.config["extra_models_dir"], "",
            "an empty extra_models_dir is the daemon scanning nowhere, which is a 404 per lookup"
        );
    }

    #[test]
    fn models_dir_is_paper_owned_and_not_auto() {
        let plan = plan_spawn(&inputs());
        assert_eq!(plan.config["models_dir"], "/data/Paper/inference/models");
        assert_ne!(
            plan.config["models_dir"], "auto",
            "`auto` resolves to ~/.cache/huggingface/hub even with the cache dir moved"
        );
    }

    #[test]
    fn host_is_the_loopback_literal_not_localhost() {
        let plan = plan_spawn(&inputs());
        let host = plan
            .args
            .windows(2)
            .find(|w| w[0] == "--host")
            .map(|w| w[1].clone());
        assert_eq!(host.as_deref(), Some("127.0.0.1"));
        assert_eq!(plan.config["host"], "127.0.0.1");
        assert_ne!(
            plan.config["host"], "localhost",
            "`localhost` binds ::1 as well and lets /etc/hosts decide what local means"
        );
    }

    #[test]
    fn broadcast_is_off_on_both_channels() {
        let plan = plan_spawn(&inputs());
        assert!(
            plan.args.iter().any(|a| a == "--no-broadcast"),
            "the flag is what disables the beacon for THIS run"
        );
        assert_eq!(
            plan.config["broadcast"],
            serde_json::Value::Bool(false),
            "the config is what stops it coming back on a spawn that omits the flag"
        );
    }

    #[test]
    fn an_api_key_is_always_provisioned() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.env.get(API_KEY_ENV).map(String::as_str),
            Some("deadbeef")
        );
    }

    #[test]
    fn model_update_checks_are_off() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.config["auto_check_model_updates"],
            serde_json::Value::Bool(false)
        );
    }

    #[test]
    fn a_system_llamacpp_is_never_preferred() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.config["llamacpp"]["prefer_system"],
            serde_json::Value::Bool(false),
            "ships true — an unverified binary on the reader's PATH would win"
        );
    }

    #[test]
    fn the_machine_may_still_sleep() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.config["inhibit_suspend"],
            serde_json::Value::Bool(false)
        );
    }

    #[test]
    fn telemetry_is_stated_off_rather_than_assumed() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.config["telemetry"]["enabled"],
            serde_json::Value::Bool(false)
        );
    }

    #[test]
    fn a_token_is_thirty_two_bytes_of_hex_and_never_repeats() {
        let a = mint_token();
        let b = mint_token();
        assert_eq!(a.len(), 64, "32 bytes, hex");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "per launch, not per install");
    }

    #[test]
    fn cloud_keys_ride_the_environment_under_the_documented_name() {
        let mut i = inputs();
        i.cloud_keys
            .insert("openai".to_owned(), "sk-test".to_owned());
        let plan = plan_spawn(&i);
        assert_eq!(
            plan.env.get("LEMONADE_OPENAI_API_KEY").map(String::as_str),
            Some("sk-test"),
            "F1: the env var outranks a runtime key, which is what /v1/cloud/auth must never be able to undo"
        );
    }

    #[test]
    fn inherited_cache_and_control_plane_vars_are_cleared() {
        let plan = plan_spawn(&inputs());
        let removals = plan.env_removals();
        for must in [
            "HF_HOME",
            "HF_HUB_CACHE",
            "LEMONADE_ADMIN_API_KEY",
            "LEMONADE_DEFAULTS_PATH",
            "LEMONADE_ALLOWED_ORIGINS",
        ] {
            assert!(
                removals.contains(&must),
                "{must} would silently undo a decision made in plan_spawn"
            );
        }
        // And nothing Paper itself sets may also be on the removal list, or
        // the launch would clear its own configuration.
        for key in plan.env.keys() {
            assert!(
                !removals.contains(&key.as_str()),
                "{key} is both set and cleared"
            );
        }
    }

    #[test]
    fn the_base_url_is_loopback() {
        let plan = plan_spawn(&inputs());
        assert_eq!(plan.base_url(), "http://127.0.0.1:13399");
    }

    #[test]
    fn the_config_goes_beside_the_cache() {
        let plan = plan_spawn(&inputs());
        assert_eq!(
            plan.config_path(),
            PathBuf::from("/data/Paper/inference/runtime/config.json")
        );
    }

    #[test]
    fn the_plan_names_no_general_runner() {
        let plan = plan_spawn(&inputs());
        // The argv is a closed list of flags this module wrote. Nothing in it
        // may come from a caller except the port, and nothing may name a
        // shell — F5's boundary, asserted rather than assumed.
        for arg in &plan.args {
            assert!(
                !arg.contains("sh") || arg == "--host",
                "unexpected argument {arg:?}"
            );
        }
        assert_eq!(plan.program, PathBuf::from("/opt/paper/runtime/lemond"));
    }
}
