//! The two agent CLIs: finding them, gating their versions, and reading only
//! what they can honestly be asked.
//!
//! WI-15.10's half of WI-15.6 and WI-15.7. What a probe can truthfully report
//! about an agent is **presence, version, auth and the account's effective
//! plan** — and nothing else. Neither CLI enumerates models: `codex` exposes
//! model discovery only as an app-server protocol method and `claude` has no
//! equivalent at all, so a picked list beside an agent row would be a guess
//! dressed as a menu.
//!
//! # No shell, ever
//!
//! The executable is resolved by walking `PATH` **in Rust** and stat-ing each
//! candidate — never by handing a name to `sh -c` or to `which`. A `PATH`
//! lookup evaluated by a shell is a general runner wearing a different hat
//! (F5), and this crate's whole contract is that untrusted book HTML cannot
//! reach one. Once resolved, the absolute path is what gets executed, so the
//! binary that answered the version question is the binary that runs.
//!
//! # The version gate, and why it is not pedantry
//!
//! Both CLIs moved a version inside a day while the plan was being written —
//! Codex `0.148.0` → `0.149.0`, Claude Code `2.1.238` → `2.1.239`, with
//! nothing upgraded on purpose — and by the time this module was written
//! Claude had moved again, to `2.1.240`. Nothing about that is unusual, and
//! it is the whole argument: **`codex login status` answers in prose**, so
//! parsing it is exactly the version-fragile move this codebase refuses
//! elsewhere.
//!
//! So an unrecognised wording is reported as [`AuthState::VersionUnsupported`]
//! rather than guessed at. That is deliberately the *safe* direction: a reader
//! whose agent is fine and whose Paper is old sees "Version not supported"
//! and can update, which is recoverable. A reader whose status line changed
//! meaning and whose Paper guessed sees a route offered that will fail when
//! pressed, which §07 exists to prevent.
//!
//! # What is dropped at the boundary
//!
//! `claude auth status --json` returns an **email address, an organisation id
//! and an organisation name**. [`ClaudeAuth`] HAS NO FIELDS FOR THEM. Dropping
//! them at the parse boundary rather than declining to render them is the
//! point: no later surface — a settings pane, a log line, a diagnostics
//! bundle, a crash report — can reach for what was never carried in. An
//! account identity has no business in a reader's settings pane.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// How long an agent CLI gets to answer a probe question.
///
/// These are local processes answering a local question; a `--version` that
/// has not returned in five seconds is wedged, and the settings pane needs an
/// answer more than it needs this one.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Which agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Codex,
    Claude,
}

/// Both of them, in the order the settings pane lists them.
pub const AGENTS: [Agent; 2] = [Agent::Codex, Agent::Claude];

impl Agent {
    /// The executable's name on this platform.
    pub fn exe(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Agent::Codex, false) => "codex",
            (Agent::Codex, true) => "codex.exe",
            (Agent::Claude, false) => "claude",
            (Agent::Claude, true) => "claude.exe",
        }
    }

    /// What the settings pane calls it.
    pub fn label(self) -> &'static str {
        match self {
            Agent::Codex => "Codex",
            Agent::Claude => "Claude",
        }
    }

    /// A static name for error variants.
    pub fn name(self) -> &'static str {
        match self {
            Agent::Codex => "Codex",
            Agent::Claude => "Claude Code",
        }
    }

    /// The lowest version whose interface this build has been written
    /// against. Below it, the probe refuses rather than parsing hopefully.
    pub fn minimum_version(self) -> Version {
        match self {
            // `codex app-server` and `codex exec --json` both exist here.
            Agent::Codex => Version(0, 149, 0),
            // `claude auth status --json` answers a typed object here.
            Agent::Claude => Version(2, 1, 238),
        }
    }
}

/// A three-part version, compared numerically.
///
/// Parsed rather than string-matched: `0.149.0` and `0.150.0` sort correctly
/// only as numbers, and `2.1.240` vs `2.1.9` is the case a lexical compare
/// gets backwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Version(pub u32, pub u32, pub u32);

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

impl Version {
    /// The first `N.N.N` in a line of CLI output.
    ///
    /// Both CLIs wrap the number in prose — `codex-cli 0.149.0` and
    /// `2.1.240 (Claude Code)` — and neither wrapping is a contract, so what
    /// is looked for is the number and not the sentence around it.
    pub fn find(text: &str) -> Option<Version> {
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i].is_ascii_digit() {
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                    i += 1;
                }
                let candidate = &text[start..i];
                let parts: Vec<&str> = candidate.split('.').collect();
                if parts.len() == 3 {
                    if let (Ok(a), Ok(b), Ok(c)) = (
                        parts[0].parse::<u32>(),
                        parts[1].parse::<u32>(),
                        parts[2].parse::<u32>(),
                    ) {
                        return Some(Version(a, b, c));
                    }
                }
            } else {
                i += 1;
            }
        }
        None
    }
}

/// What a probe learned about one agent's sign-in.
///
/// Every arm carries the words the settings pane will show, which is
/// WI-15.10's rule that "a route that cannot say why is not usable".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum AuthState {
    /// Signed in. `plan` is the account's tier where the CLI reports one —
    /// `ChatGPT`, `max` — and is display text, never something Paper acts on.
    SignedIn { plan: Option<String> },
    /// Installed and supported, but nobody is signed in.
    SignedOut,
    /// The CLI answered in a wording this build does not recognise. See the
    /// module header for why this is the safe direction.
    VersionUnsupported,
}

/// Everything a probe can honestly report about one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbe {
    pub agent: Agent,
    /// Absolute, once resolved. `None` when the CLI is not installed.
    pub path: Option<String>,
    pub version: Option<Version>,
    /// `None` when there is no version to have an opinion about.
    pub auth: Option<AuthState>,
    /// Why this route is unusable, in the words the pane shows. `None` when
    /// it is usable.
    pub unusable: Option<&'static str>,
}

/// The reasons a route can be unusable, in §11's voice. Literals rather than
/// formatted strings: these are the exact words the settings pane renders.
pub const NOT_INSTALLED: &str = "Not installed";
pub const SIGNED_OUT: &str = "Signed out";
pub const VERSION_NOT_SUPPORTED: &str = "Version not supported";

impl AgentProbe {
    /// Not installed, and saying so.
    pub fn missing(agent: Agent) -> AgentProbe {
        AgentProbe {
            agent,
            path: None,
            version: None,
            auth: None,
            unusable: Some(NOT_INSTALLED),
        }
    }

    /// Whether this route can answer a question.
    pub fn usable(&self) -> bool {
        self.unusable.is_none()
    }
}

/// Find an executable by walking `PATH` in Rust.
///
/// Never a shell, never `which`. See the module header.
pub fn which(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|candidate| is_executable_file(candidate))
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        // `is_file` follows symlinks, which is right: a CLI installed by a
        // version manager is usually a symlink into a versioned directory.
        Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Run an agent CLI and capture its stdout.
///
/// The program is an ABSOLUTE PATH the caller already resolved, and the args
/// are literals from this module. Nothing here takes a string from a caller.
async fn run(program: &Path, args: &[&str]) -> Result<Output> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // A probe must not inherit a pager or an editor and then block on it.
    cmd.env("PAGER", "cat");
    cmd.env("NO_COLOR", "1");

    let output = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| Error::AgentMalformed {
            agent: "agent",
            message: format!("did not answer within {}s", PROBE_TIMEOUT.as_secs()),
        })??;
    Ok(Output {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

struct Output {
    ok: bool,
    stdout: String,
    stderr: String,
}

impl Output {
    /// Both streams. `claude` writes its version to stdout; a CLI that has
    /// decided a notice belongs on stderr should not read as silence.
    fn text(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }
}

/// Probe one agent: presence, version, auth.
///
/// Never throws for a missing CLI — WI-15.10's acceptance is that renaming a
/// binary "reports `Not installed` rather than throwing".
pub async fn probe(agent: Agent) -> AgentProbe {
    let Some(path) = which(agent.exe()) else {
        return AgentProbe::missing(agent);
    };
    let path_text = path.to_string_lossy().into_owned();

    let version = match run(&path, &["--version"]).await {
        /* THE EXIT CODE IS CHECKED, not just the text. A CLI that printed
         * something version-shaped on its way to failing — a partial install,
         * a missing runtime, a node binary that is not there — would
         * otherwise pass the gate on the strength of a number in an error
         * message. `9009` on Windows is exactly this case: a Store stub
         * answers where an interpreter does not. */
        Ok(out) if out.ok => Version::find(&out.text()),
        Ok(_) | Err(_) => None,
    };
    let Some(version) = version else {
        // It is on PATH but would not say what it is. Not a crash, and not a
        // guess: an unusable route that says why.
        return AgentProbe {
            agent,
            path: Some(path_text),
            version: None,
            auth: Some(AuthState::VersionUnsupported),
            unusable: Some(VERSION_NOT_SUPPORTED),
        };
    };

    if version < agent.minimum_version() {
        return AgentProbe {
            agent,
            path: Some(path_text),
            version: Some(version),
            auth: Some(AuthState::VersionUnsupported),
            unusable: Some(VERSION_NOT_SUPPORTED),
        };
    }

    let auth = match agent {
        Agent::Codex => probe_codex_auth(&path).await,
        Agent::Claude => probe_claude_auth(&path).await,
    };

    let unusable = match &auth {
        AuthState::SignedIn { .. } => None,
        AuthState::SignedOut => Some(SIGNED_OUT),
        AuthState::VersionUnsupported => Some(VERSION_NOT_SUPPORTED),
    };

    AgentProbe {
        agent,
        path: Some(path_text),
        version: Some(version),
        auth: Some(auth),
        unusable,
    }
}

/// `codex login status` answers in PROSE. See [`read_codex_status`].
async fn probe_codex_auth(path: &Path) -> AuthState {
    match run(path, &["login", "status"]).await {
        Ok(out) => read_codex_status(&out.text()),
        Err(_) => AuthState::VersionUnsupported,
    }
}

/// Read Codex's prose status line.
///
/// Observed 2026-08-23 against `codex-cli 0.149.0`: signed in answers the
/// single sentence `Logged in using ChatGPT`.
///
/// The wordings below are a CLOSED SET. Anything else is
/// [`AuthState::VersionUnsupported`] — not "probably signed out", and not a
/// substring search loose enough to match a sentence that has changed meaning.
/// This is the function WI-15.10's acceptance names: *"a stubbed `codex login
/// status` in an unexpected wording reports `Version not supported` rather
/// than guessing."*
pub fn read_codex_status(text: &str) -> AuthState {
    let line = text.trim();
    // Signed in: "Logged in using <method>". The method is display text.
    if let Some(rest) = line.strip_prefix("Logged in using ") {
        let plan = rest.lines().next().unwrap_or("").trim();
        return AuthState::SignedIn {
            plan: (!plan.is_empty()).then(|| plan.to_owned()),
        };
    }
    // Signed out: the wordings observed and documented for this version line.
    if line.starts_with("Not logged in") || line.starts_with("You are not logged in") {
        return AuthState::SignedOut;
    }
    AuthState::VersionUnsupported
}

/// What `claude auth status --json` answers, MINUS the identity.
///
/// The fields upstream also sends — `email`, `orgId`, `orgName` — are
/// deliberately absent. `serde` drops unknown keys, so they are gone at the
/// parse boundary and no later surface can reach for them. See the module
/// header, and `the_identity_fields_are_dropped_at_the_boundary` below.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuth {
    #[serde(default)]
    pub logged_in: bool,
    #[serde(default)]
    pub auth_method: Option<String>,
    #[serde(default)]
    pub subscription_type: Option<String>,
}

async fn probe_claude_auth(path: &Path) -> AuthState {
    match run(path, &["auth", "status", "--json"]).await {
        Ok(out) => read_claude_status(&out.stdout),
        Err(_) => AuthState::VersionUnsupported,
    }
}

/// Read Claude's typed status object.
///
/// A typed answer needs no prose parsing, so the failure mode here is a body
/// that is not the expected JSON at all — which is again reported as an
/// unsupported version rather than as "signed out".
pub fn read_claude_status(text: &str) -> AuthState {
    let Ok(auth) = serde_json::from_str::<ClaudeAuth>(text.trim()) else {
        return AuthState::VersionUnsupported;
    };
    if !auth.logged_in {
        return AuthState::SignedOut;
    }
    // The tier, where the account has one — `max`, `pro`. Falls back to the
    // auth method, which is what a first-party API-key account reports.
    AuthState::SignedIn {
        plan: auth.subscription_type.or(auth.auth_method),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_found_inside_either_cli_wrapping() {
        // Both observed on this machine, 2026-08-23.
        assert_eq!(Version::find("codex-cli 0.149.0"), Some(Version(0, 149, 0)));
        assert_eq!(
            Version::find("2.1.240 (Claude Code)"),
            Some(Version(2, 1, 240))
        );
        assert_eq!(Version::find("no numbers here"), None);
        assert_eq!(Version::find("1.2"), None, "two parts is not a version");
    }

    /// The comparison a lexical match gets backwards, which is the whole
    /// reason the version is parsed into numbers.
    #[test]
    fn versions_compare_numerically_not_lexically() {
        assert!(Version(2, 1, 240) > Version(2, 1, 9));
        assert!(Version(0, 150, 0) > Version(0, 149, 0));
        assert!(Version(2, 1, 240) > Version(2, 1, 238));
        // The string compare that would have been wrong.
        assert!("2.1.240" < "2.1.9", "lexically, which is why we do not");
    }

    #[test]
    fn codex_signed_in_is_read_from_the_observed_wording() {
        // Captured verbatim from `codex login status` on 2026-08-23.
        assert_eq!(
            read_codex_status("Logged in using ChatGPT"),
            AuthState::SignedIn {
                plan: Some("ChatGPT".to_owned())
            }
        );
    }

    #[test]
    fn codex_signed_out_is_read() {
        assert_eq!(read_codex_status("Not logged in"), AuthState::SignedOut);
    }

    /// WI-15.10's acceptance, verbatim: an unexpected wording reports
    /// `Version not supported` rather than guessing.
    #[test]
    fn an_unexpected_codex_wording_is_unsupported_rather_than_a_guess() {
        for stubbed in [
            "Authenticated as user via OAuth",
            "You're signed in!",
            "login: ok",
            "",
            "Logged out",
            // The nastiest case: a sentence that CONTAINS the old words but
            // has changed meaning. A substring search would call this
            // signed-in.
            "Warning: you are not Logged in using ChatGPT anymore",
        ] {
            assert_eq!(
                read_codex_status(stubbed),
                AuthState::VersionUnsupported,
                "{stubbed:?} must not be guessed at"
            );
        }
    }

    #[test]
    fn claude_signed_in_reports_the_tier() {
        // The observed shape, with the identity fields present exactly as the
        // CLI sends them — and values that are obviously not anyone's.
        let observed = r#"{
            "loggedIn": true,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "email": "someone@example.invalid",
            "orgId": "00000000-0000-0000-0000-000000000000",
            "orgName": "Example Org",
            "subscriptionType": "max"
        }"#;
        assert_eq!(
            read_claude_status(observed),
            AuthState::SignedIn {
                plan: Some("max".to_owned())
            }
        );
    }

    /// The plan's rule, as a test: the struct HAS NO FIELDS for the identity,
    /// so it cannot be rendered, logged or bundled into a diagnostic.
    ///
    /// This asserts the property structurally — the parsed value's debug
    /// rendering is the whole of what Paper carries forward, and the identity
    /// is not in it.
    #[test]
    fn the_identity_fields_are_dropped_at_the_boundary() {
        let observed = r#"{
            "loggedIn": true,
            "authMethod": "claude.ai",
            "email": "someone@example.invalid",
            "orgId": "00000000-0000-0000-0000-000000000000",
            "orgName": "Example Org",
            "subscriptionType": "max"
        }"#;
        let parsed: ClaudeAuth = serde_json::from_str(observed).unwrap();
        let carried = format!("{parsed:?}");
        for dropped in [
            "someone@example.invalid",
            "00000000",
            "Example Org",
            "email",
            "orgId",
        ] {
            assert!(
                !carried.contains(dropped),
                "{dropped} survived the parse boundary: {carried}"
            );
        }
        // And the same for the state the probe actually publishes.
        let state = read_claude_status(observed);
        let published = serde_json::to_string(&state).unwrap();
        assert!(!published.contains("example.invalid"));
        assert!(!published.contains("Example Org"));
    }

    #[test]
    fn claude_signed_out_is_read() {
        assert_eq!(
            read_claude_status(r#"{"loggedIn": false}"#),
            AuthState::SignedOut
        );
    }

    #[test]
    fn a_non_json_claude_answer_is_unsupported_rather_than_signed_out() {
        for stubbed in ["not json", "", "Logged in using ChatGPT"] {
            assert_eq!(
                read_claude_status(stubbed),
                AuthState::VersionUnsupported,
                "{stubbed:?}"
            );
        }
    }

    #[test]
    fn a_first_party_account_falls_back_to_the_auth_method() {
        assert_eq!(
            read_claude_status(r#"{"loggedIn": true, "authMethod": "apiKey"}"#),
            AuthState::SignedIn {
                plan: Some("apiKey".to_owned())
            }
        );
    }

    #[test]
    fn a_missing_cli_is_reported_rather_than_thrown() {
        let probe = AgentProbe::missing(Agent::Codex);
        assert_eq!(probe.unusable, Some(NOT_INSTALLED));
        assert!(!probe.usable());
        assert!(probe.path.is_none());
    }

    #[test]
    fn which_finds_nothing_for_a_name_that_does_not_exist() {
        assert!(which("paper-definitely-not-a-real-binary-xyzzy").is_none());
    }

    /// The resolver works on this platform, proven against a binary every
    /// unix has. Not asserting a specific path — that is the machine's
    /// business — only that resolution returns something absolute and
    /// executable.
    #[cfg(unix)]
    #[test]
    fn which_resolves_a_binary_that_exists() {
        let found = which("sh").expect("sh is on PATH");
        assert!(found.is_absolute());
        assert!(is_executable_file(&found));
    }

    #[test]
    fn the_windows_extension_is_carried() {
        if cfg!(windows) {
            assert_eq!(Agent::Codex.exe(), "codex.exe");
            assert_eq!(Agent::Claude.exe(), "claude.exe");
        } else {
            assert_eq!(Agent::Codex.exe(), "codex");
            assert_eq!(Agent::Claude.exe(), "claude");
        }
    }

    /// A version below the floor is refused even when the CLI is otherwise
    /// healthy — the gate is on the interface, not on whether it answered.
    #[test]
    fn the_floor_is_below_the_versions_this_build_was_written_against() {
        // Observed on this machine when the module was written.
        assert!(Version(0, 149, 0) >= Agent::Codex.minimum_version());
        assert!(Version(2, 1, 240) >= Agent::Claude.minimum_version());
        // And an older one is not.
        assert!(Version(0, 148, 0) < Agent::Codex.minimum_version());
        assert!(Version(2, 1, 237) < Agent::Claude.minimum_version());
    }
}
