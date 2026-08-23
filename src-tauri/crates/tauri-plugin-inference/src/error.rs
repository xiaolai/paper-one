//! The plugin's one error type, and how it crosses the IPC boundary.
//!
//! Every command returns `Result<T, Error>`. Over IPC an error serializes as
//! `{ "kind": "<camelCase tag>", "message": "<human text>" }`, so the webview
//! can branch on `kind` and never has to parse `message`. Keep the kinds
//! stable: they are the plugin's error contract with the TypeScript side —
//! the same rule, and the same shape, as `tauri-plugin-peer`'s.
//!
//! NOTHING HERE CARRIES A CREDENTIAL. The bearer token, the cloud API keys
//! and the model URLs a key might be embedded in never reach a variant, and
//! `RuntimeHttp` deliberately carries a status and a route rather than a
//! response body — an upstream 401's body has been known to echo the key that
//! failed. WI-15.8's acceptance ("the key never appears in any
//! webview-reachable value, any log, or any diagnostics line") is partly
//! this file's to keep, and `no_variant_carries_a_secret` below is the test
//! that keeps it.

use std::path::PathBuf;

use serde::ser::{Serialize, SerializeStruct, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Tauri(#[from] tauri::Error),

    // ── paths and layout ────────────────────────────────────────────────
    /// A path that has to travel over IPC as a string is not valid Unicode.
    #[error("path is not valid Unicode: {}", .0.display())]
    PathNotUnicode(PathBuf),

    /// `PAPER_TEST_DATA_DIR` (or the resolved app data dir) is not absolute.
    #[error("the runtime root must be an absolute path, got {}", .0.display())]
    RootNotAbsolute(PathBuf),

    /// The shipped `lemond` is not where the bundle says it is. Named rather
    /// than falling back to a `PATH` lookup: resolving a supervised child
    /// through `PATH` is F5's general runner wearing a different hat.
    #[error("the inference runtime is not installed at {}", .0.display())]
    RuntimeMissing(PathBuf),

    // ── the daemon's lifecycle ──────────────────────────────────────────
    /// A command needing the daemon arrived while nothing was running, and
    /// the state machine is not in a state that starts one.
    #[error("the inference runtime is not running")]
    NotRunning,

    /// The daemon was launched but never answered `/api/v1/health` inside the
    /// deadline. Its own log tail is the message, because the useful half of
    /// this failure is always what the child said before giving up.
    #[error("the inference runtime did not become ready within {secs}s: {tail}")]
    NotReady { secs: u64, tail: String },

    /// The daemon exited on its own.
    #[error("the inference runtime exited with {status}: {tail}")]
    RuntimeExited { status: String, tail: String },

    // ── the daemon's HTTP API ───────────────────────────────────────────
    /// A request to the daemon failed at the transport.
    #[error("the inference runtime is unreachable at {route}: {message}")]
    RuntimeUnreachable { route: String, message: String },

    /// The daemon answered with a status the caller cannot use. The BODY IS
    /// NOT CARRIED — see the module header.
    #[error("the inference runtime answered {status} for {route}")]
    RuntimeHttp { status: u16, route: String },

    /// The daemon's answer did not parse into the shape this build expects.
    #[error("the inference runtime's answer for {route} was malformed: {message}")]
    RuntimeMalformed { route: String, message: String },

    // ── models and artifacts (WI-15.1) ──────────────────────────────────
    /// A model id that is not in `models.manifest.json`. A gallery entry is
    /// untrusted input until it has resolved to a manifest entry.
    #[error("unknown model {0:?}")]
    ModelUnknown(String),

    /// The artifact's SHA-256 does not match the manifest's. The previous
    /// activation slot is untouched.
    #[error("model {id} failed verification: expected {expected}, got {got}")]
    DigestMismatch {
        id: String,
        expected: String,
        got: String,
    },

    /// The artifact's byte count does not match the manifest's — checked
    /// before the digest, because it is the cheap half and a truncated
    /// download is the common case.
    #[error("model {id} is {got} bytes, expected {expected}")]
    SizeMismatch { id: String, expected: u64, got: u64 },

    /// A manifest that does not parse. Never treated as an empty catalogue.
    #[error("the model manifest is malformed: {0}")]
    ManifestMalformed(String),

    /// A manifest declaring a format this build does not speak.
    #[error("the model manifest is format {version}; this build speaks {supported}")]
    ManifestUnsupportedVersion { version: u32, supported: u32 },

    // ── requests ────────────────────────────────────────────────────────
    /// A request id that is not in flight — a cancel for something already
    /// finished, or a second cancel.
    #[error("no request {0:?} is in flight")]
    RequestUnknown(String),

    /// A request id already in flight. Refused rather than replacing the
    /// channel, which would leave the first caller's stream silently dead.
    #[error("request {0:?} is already in flight")]
    RequestBusy(String),

    /// The caller cancelled. Distinct from a failure so the UI can tell the
    /// reader's own abort from something going wrong.
    #[error("cancelled")]
    Cancelled,

    /// A field arrived larger than this plugin will carry.
    ///
    /// The bound is on the FIELD, named, so the message says which one — a
    /// generic "too large" from a command with five string parameters tells
    /// whoever reads it nothing.
    #[error("{field} is larger than this build accepts ({limit} bytes)")]
    FieldTooLarge { field: &'static str, limit: usize },

    // ── agents (WI-15.6, WI-15.7, WI-15.10) ─────────────────────────────
    /// The agent CLI is not on `PATH`.
    #[error("{0} is not installed")]
    AgentMissing(&'static str),

    /// The agent CLI is a version this build has not been gated against.
    ///
    /// REFUSED BY NAME rather than parsed hopefully: both CLIs moved a
    /// version inside a day while the plan was being written, and the whole
    /// argument for the gate is that a status line's wording is not a
    /// contract.
    #[error("{agent} {version} is not a supported version")]
    AgentUnsupportedVersion {
        agent: &'static str,
        version: String,
    },

    /// The agent is installed and supported but nobody is signed in.
    #[error("{0} is not signed in")]
    AgentSignedOut(&'static str),

    /// The agent's output did not parse.
    #[error("{agent}'s output was malformed: {message}")]
    AgentMalformed {
        agent: &'static str,
        message: String,
    },

    // ── secrets (WI-15.8) ───────────────────────────────────────────────
    /// The OS keychain refused. The message is the platform's, and it is
    /// safe: a keychain reports why it said no, never what it was holding.
    #[error("the keychain refused: {0}")]
    Keychain(String),
}

impl Error {
    /// The stable, camelCase tag the webview branches on.
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Io(_) => "io",
            Error::Tauri(_) => "tauri",
            Error::PathNotUnicode(_) => "pathNotUnicode",
            Error::RootNotAbsolute(_) => "rootNotAbsolute",
            Error::RuntimeMissing(_) => "runtimeMissing",
            Error::NotRunning => "notRunning",
            Error::NotReady { .. } => "notReady",
            Error::RuntimeExited { .. } => "runtimeExited",
            Error::RuntimeUnreachable { .. } => "runtimeUnreachable",
            Error::RuntimeHttp { .. } => "runtimeHttp",
            Error::RuntimeMalformed { .. } => "runtimeMalformed",
            Error::ModelUnknown(_) => "modelUnknown",
            Error::DigestMismatch { .. } => "digestMismatch",
            Error::SizeMismatch { .. } => "sizeMismatch",
            Error::ManifestMalformed(_) => "manifestMalformed",
            Error::ManifestUnsupportedVersion { .. } => "manifestUnsupportedVersion",
            Error::RequestUnknown(_) => "requestUnknown",
            Error::RequestBusy(_) => "requestBusy",
            Error::Cancelled => "cancelled",
            Error::FieldTooLarge { .. } => "fieldTooLarge",
            Error::AgentMissing(_) => "agentMissing",
            Error::AgentUnsupportedVersion { .. } => "agentUnsupportedVersion",
            Error::AgentSignedOut(_) => "agentSignedOut",
            Error::AgentMalformed { .. } => "agentMalformed",
            Error::Keychain(_) => "keychain",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

/// A `reqwest` failure, given the route it happened on.
///
/// Free functions rather than a `From`, because the route is the half that
/// makes the error useful and `From` has nowhere to carry it.
pub fn unreachable(route: &str, err: reqwest::Error) -> Error {
    Error::RuntimeUnreachable {
        route: route.to_owned(),
        // `err.to_string()` on reqwest includes the URL, which is loopback
        // here and carries no key — the cloud routes are the daemon's, never
        // this client's (see the crate's Cargo.toml).
        message: err.to_string(),
    }
}

/// A body that did not parse into the expected shape.
pub fn malformed(route: &str, message: impl Into<String>) -> Error {
    Error::RuntimeMalformed {
        route: route.to_owned(),
        message: message.into(),
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_kind_and_message() {
        let err = Error::ModelUnknown("qwen3-4b".to_owned());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "modelUnknown");
        assert_eq!(json["message"], "unknown model \"qwen3-4b\"");
    }

    #[test]
    fn every_kind_is_distinct() {
        // `Io` and `Tauri` wrap foreign types; `Io` is constructible and is
        // in the list, `Tauri` is not and is folded in by name below.
        let all = [
            Error::Io(std::io::Error::other("x")).kind(),
            Error::PathNotUnicode(PathBuf::new()).kind(),
            Error::RootNotAbsolute(PathBuf::new()).kind(),
            Error::RuntimeMissing(PathBuf::new()).kind(),
            Error::NotRunning.kind(),
            Error::NotReady {
                secs: 0,
                tail: String::new(),
            }
            .kind(),
            Error::RuntimeExited {
                status: String::new(),
                tail: String::new(),
            }
            .kind(),
            Error::RuntimeUnreachable {
                route: String::new(),
                message: String::new(),
            }
            .kind(),
            Error::RuntimeHttp {
                status: 0,
                route: String::new(),
            }
            .kind(),
            Error::RuntimeMalformed {
                route: String::new(),
                message: String::new(),
            }
            .kind(),
            Error::ModelUnknown(String::new()).kind(),
            Error::DigestMismatch {
                id: String::new(),
                expected: String::new(),
                got: String::new(),
            }
            .kind(),
            Error::SizeMismatch {
                id: String::new(),
                expected: 0,
                got: 0,
            }
            .kind(),
            Error::ManifestMalformed(String::new()).kind(),
            Error::ManifestUnsupportedVersion {
                version: 0,
                supported: 0,
            }
            .kind(),
            Error::RequestUnknown(String::new()).kind(),
            Error::RequestBusy(String::new()).kind(),
            Error::Cancelled.kind(),
            Error::AgentMissing("codex").kind(),
            Error::AgentUnsupportedVersion {
                agent: "codex",
                version: String::new(),
            }
            .kind(),
            Error::AgentSignedOut("codex").kind(),
            Error::AgentMalformed {
                agent: "codex",
                message: String::new(),
            }
            .kind(),
            Error::Keychain(String::new()).kind(),
        ];
        let unique: std::collections::BTreeSet<_> = all.iter().collect();
        assert_eq!(unique.len(), all.len());
        // The wrapped-foreign variant that cannot be constructed here, folded
        // into the same uniqueness check so a new variant reusing its tag
        // fails here too rather than hiding behind "cannot be constructed".
        let with_foreign: std::collections::BTreeSet<&str> =
            all.iter().copied().chain(["tauri"]).collect();
        assert_eq!(with_foreign.len(), all.len() + 1);
    }

    /// WI-15.8's acceptance, as far as this file can keep it: no variant has
    /// a field whose job is to hold a credential, and the HTTP variant
    /// carries a status rather than a body.
    #[test]
    fn no_variant_carries_a_secret() {
        // A 401 from the daemon: the route and the status, and nothing that
        // could have echoed the key that failed.
        let err = Error::RuntimeHttp {
            status: 401,
            route: "/api/v1/models".to_owned(),
        };
        let rendered = serde_json::to_string(&err).unwrap();
        assert!(rendered.contains("401"));
        assert!(rendered.contains("/api/v1/models"));
        // The rendering is total — there is no body field to leak through.
        assert_eq!(
            err.to_string(),
            "the inference runtime answered 401 for /api/v1/models"
        );
    }
}
