//! The probe: presence, version and auth for every route, in one typed shape.
//!
//! WI-15.10. It lands early in the plan's order — before the thread and well
//! before either adapter — because the route list (WI-15.11) and both
//! adapters read from it, and none of them can be built honestly against a
//! guess about what is installed.
//!
//! # One shape, four kinds of route, and no invented menu
//!
//! | Route | Present | Version | Auth |
//! |---|---|---|---|
//! | Local | the manifest's activation slot | `/api/v1/health` | n/a — the key is Paper's own |
//! | Codex | executable on `PATH` | `codex --version` | `codex login status` |
//! | Claude | executable on `PATH` | `claude --version` | `claude auth status --json` |
//! | Endpoint | a registered `base_url` | n/a | whether a key is stored |
//!
//! The local runtime enumerates models and **neither agent CLI does**. So a
//! preflight that returns a menu is honest for the local runtime and
//! dishonest for an agent: an agent row's detail is the plan tier and the CLI
//! version, and Paper does not invent a model list beside it. That asymmetry
//! is why [`RouteKind`] exists as a tag rather than every route being made to
//! look alike.
//!
//! # Every route says why it cannot be used
//!
//! [`Route::unusable`] is the words the settings pane shows — `Not
//! installed`, `Signed out`, `Version not supported` — and a route that
//! cannot say why is not usable. That is §07's disabled-and-says-why rather
//! than a control that fails when pressed, and it is what lets one list do
//! provisioning and selection at once (WI-15.11).
//!
//! # Refreshed when the group opens, never on a timer
//!
//! Nothing here polls. Each probe spawns up to four short-lived child
//! processes, and doing that on a timer behind a shut side pane would be a
//! reader's battery spent on a question nobody asked.

use serde::{Deserialize, Serialize};

use crate::agent::{self, Agent, AgentProbe, AuthState};
use crate::endpoints::Endpoint;
use crate::manifest::{Manifest, ModelEntry};

/// What kind of thing answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    /// A model on this machine, answered by the supervised daemon.
    Local,
    /// A coding-agent CLI running under the reader's own subscription.
    Agent,
    /// An OpenAI-compatible endpoint registered with the daemon (WI-15.8).
    Endpoint,
}

/// One row in the reader's "Answers with" list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    /// Stable across probes — the list keys and remembers rows by it, and the
    /// reader's choice is persisted as this string.
    pub id: String,
    pub kind: RouteKind,
    /// What the row is called.
    pub label: String,
    /// The row's right-hand value when it is usable — `local · 2.4 GB`,
    /// `ChatGPT · 0.149.0`. Display text, never parsed.
    pub detail: Option<String>,
    /// Why this route cannot answer, in the words the pane shows. `None`
    /// means usable.
    pub unusable: Option<String>,
    /// For a local route: whether the artifacts are on disk and verified.
    /// Always false for the other kinds, which have nothing to install.
    #[serde(default)]
    pub installed: bool,
    /// For a local route: what the download costs, so the row can say so
    /// before the reader commits to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// What this route can be used for. A speech model does not answer
    /// questions, and a text model does not read aloud.
    pub modality: Modality,
}

/// What a route is good for. Mirrors the manifest's own split, widened by the
/// agents and endpoints, which are text-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    Text,
    Speech,
}

impl From<crate::manifest::Modality> for Modality {
    fn from(m: crate::manifest::Modality) -> Modality {
        match m {
            crate::manifest::Modality::Text => Modality::Text,
            crate::manifest::Modality::Speech => Modality::Speech,
        }
    }
}

impl Route {
    pub fn usable(&self) -> bool {
        self.unusable.is_none()
    }
}

/// The whole answer: every route, and whether the runtime is up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub routes: Vec<Route>,
    /// The daemon's version when it is running, else `None`. Not a failure:
    /// absent is a normal state (F2), and the local rows still list what
    /// could be installed.
    pub runtime_version: Option<String>,
}

impl Probe {
    /// Every usable route, in list order.
    pub fn usable(&self) -> impl Iterator<Item = &Route> {
        self.routes.iter().filter(|r| r.usable())
    }

    /// One route by id.
    pub fn route(&self, id: &str) -> Option<&Route> {
        self.routes.iter().find(|r| r.id == id)
    }
}

/// The id a local model's route is known by.
pub fn local_route_id(model: &str) -> String {
    format!("local:{model}")
}

/// The id an agent's route is known by.
pub fn agent_route_id(agent: Agent) -> String {
    match agent {
        Agent::Codex => "agent:codex".to_owned(),
        Agent::Claude => "agent:claude".to_owned(),
    }
}

/// The id an endpoint's route is known by.
pub fn endpoint_route_id(id: &str) -> String {
    format!("endpoint:{id}")
}

/// A human byte count for a row's detail — `2.4 GB`, `354 MB`.
///
/// Decimal, not binary: the reader is comparing this against a download they
/// were quoted in the same units, and 2.5 GB shown as 2.3 GiB reads as a
/// different file.
pub fn human_bytes(bytes: u64) -> String {
    const GB: f64 = 1_000_000_000.0;
    const MB: f64 = 1_000_000.0;
    let n = bytes as f64;
    if n >= GB {
        format!("{:.1} GB", n / GB)
    } else if n >= MB {
        format!("{:.0} MB", n / MB)
    } else {
        format!("{bytes} B")
    }
}

/// Build the local rows from the manifest and what is on disk.
///
/// Pure: `installed` is decided by the caller, which is what lets this be
/// tested without a filesystem.
pub fn local_routes(
    manifest: &Manifest,
    installed: impl Fn(&ModelEntry) -> bool,
    runtime_available: bool,
) -> Vec<Route> {
    manifest
        .models
        .iter()
        .map(|model| {
            let is_installed = installed(model);
            let unusable = if !is_installed {
                Some(agent::NOT_INSTALLED.to_owned())
            } else if !runtime_available {
                // Installed but the runtime is not there to load it. Absent
                // is a normal state (F2) and this says so rather than
                // offering a row that fails when pressed.
                Some("Runtime not installed".to_owned())
            } else {
                None
            };
            Route {
                id: local_route_id(&model.id),
                kind: RouteKind::Local,
                label: model.label.clone(),
                detail: Some(format!("local · {}", human_bytes(model.total_bytes()))),
                unusable,
                installed: is_installed,
                bytes: Some(model.total_bytes()),
                modality: model.modality.into(),
            }
        })
        .collect()
}

/// Turn an agent probe into a row.
pub fn agent_route(probe: &AgentProbe) -> Route {
    let version = probe.version.map(|v| v.to_string());
    let detail = match (&probe.auth, &version) {
        // The plan tier and the CLI version — what the probe could honestly
        // learn. NOT a model menu (F6).
        (Some(AuthState::SignedIn { plan: Some(plan) }), Some(v)) => Some(format!("{plan} · {v}")),
        (Some(AuthState::SignedIn { plan: None }), Some(v)) => Some(v.clone()),
        (_, Some(v)) => Some(v.clone()),
        (_, None) => None,
    };
    Route {
        id: agent_route_id(probe.agent),
        kind: RouteKind::Agent,
        label: probe.agent.label().to_owned(),
        detail,
        /* THE VERSION IT NEEDS, not just that this one will not do.
         *
         * "Version not supported" is true and useless: the reader cannot act
         * on it without going to look up what Paper wants, and Paper already
         * knows — `minimum_version()` is the number this build was written
         * against. The other two reasons stay the literals they were, because
         * "Not installed" and "Signed out" each already name their own fix. */
        unusable: probe.unusable.map(|reason| {
            if reason == agent::VERSION_NOT_SUPPORTED {
                format!(
                    "{reason} — needs {} or newer",
                    probe.agent.minimum_version()
                )
            } else {
                reason.to_owned()
            }
        }),
        installed: false,
        bytes: None,
        // An agent answers questions and never reads aloud: WI-15.9's TTS is
        // the daemon's, and there is no code path from a voice to a session.
        modality: Modality::Text,
    }
}

/// Turn a registered endpoint into a row.
pub fn endpoint_route(endpoint: &Endpoint) -> Route {
    Route {
        id: endpoint_route_id(&endpoint.id),
        kind: RouteKind::Endpoint,
        label: endpoint.label.clone(),
        detail: endpoint.has_key.then(|| "endpoint".to_owned()),
        // An endpoint with no key cannot answer, and says so with the action
        // that fixes it rather than failing when pressed.
        unusable: (!endpoint.has_key).then(|| "No key".to_owned()),
        installed: false,
        bytes: None,
        modality: Modality::Text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::Version;

    fn manifest() -> Manifest {
        Manifest::shipped().unwrap()
    }

    #[test]
    fn human_bytes_reads_in_the_units_the_reader_was_quoted() {
        assert_eq!(human_bytes(2_497_281_120), "2.5 GB");
        assert_eq!(human_bytes(325_532_387), "326 MB");
        assert_eq!(human_bytes(512), "512 B");
    }

    #[test]
    fn an_uninstalled_local_model_says_so_and_still_lists() {
        let routes = local_routes(&manifest(), |_| false, true);
        assert_eq!(routes.len(), 2);
        for route in &routes {
            assert!(!route.usable());
            assert_eq!(route.unusable.as_deref(), Some("Not installed"));
            assert!(!route.installed);
            // Still carries the cost, so the row can quote it before the
            // reader commits to the download.
            assert!(route.bytes.unwrap() > 0);
        }
    }

    #[test]
    fn an_installed_local_model_is_usable_when_the_runtime_is_there() {
        let routes = local_routes(&manifest(), |_| true, true);
        assert!(routes.iter().all(|r| r.usable()), "all should be usable");
        assert!(routes.iter().all(|r| r.installed));
    }

    /// F2, as a row: a model on disk with no runtime to load it is not
    /// usable, and says which of the two is missing.
    #[test]
    fn an_installed_model_without_a_runtime_says_which_is_missing() {
        let routes = local_routes(&manifest(), |_| true, false);
        for route in &routes {
            assert_eq!(route.unusable.as_deref(), Some("Runtime not installed"));
            assert!(route.installed, "the model IS there — the runtime is not");
        }
    }

    #[test]
    fn a_signed_in_agent_shows_its_plan_and_version_and_no_model_menu() {
        let probe = AgentProbe {
            agent: Agent::Claude,
            path: Some("/usr/local/bin/claude".to_owned()),
            version: Some(Version(2, 1, 240)),
            auth: Some(AuthState::SignedIn {
                plan: Some("max".to_owned()),
            }),
            unusable: None,
        };
        let route = agent_route(&probe);
        assert!(route.usable());
        assert_eq!(route.detail.as_deref(), Some("max · 2.1.240"));
        assert_eq!(route.kind, RouteKind::Agent);
        // Nothing about the row invites a model choice — F6's prohibition.
        assert!(route.bytes.is_none());
        assert!(!route.installed);
    }

    #[test]
    fn a_missing_agent_is_a_row_that_says_why() {
        let route = agent_route(&AgentProbe::missing(Agent::Codex));
        assert!(!route.usable());
        assert_eq!(route.unusable.as_deref(), Some("Not installed"));
    }

    #[test]
    fn a_signed_out_agent_still_shows_its_version() {
        let probe = AgentProbe {
            agent: Agent::Codex,
            path: Some("/opt/homebrew/bin/codex".to_owned()),
            version: Some(Version(0, 149, 0)),
            auth: Some(AuthState::SignedOut),
            unusable: Some(agent::SIGNED_OUT),
        };
        let route = agent_route(&probe);
        assert!(!route.usable());
        assert_eq!(route.unusable.as_deref(), Some("Signed out"));
        assert_eq!(
            route.detail.as_deref(),
            Some("0.149.0"),
            "the version is still worth showing beside the reason"
        );
    }

    #[test]
    fn an_endpoint_without_a_key_is_unusable_and_says_so() {
        let endpoint = Endpoint {
            id: "proxy".to_owned(),
            label: "My proxy".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            has_key: false,
        };
        let route = endpoint_route(&endpoint);
        assert!(!route.usable());
        assert_eq!(route.unusable.as_deref(), Some("No key"));
    }

    #[test]
    fn an_endpoint_with_a_key_is_usable() {
        let endpoint = Endpoint {
            id: "proxy".to_owned(),
            label: "My proxy".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            has_key: true,
        };
        assert!(endpoint_route(&endpoint).usable());
    }

    /// Every route id is unique and namespaced, so the reader's persisted
    /// choice cannot collide across kinds.
    #[test]
    fn route_ids_are_namespaced_and_unique() {
        let mut routes = local_routes(&manifest(), |_| true, true);
        routes.push(agent_route(&AgentProbe::missing(Agent::Codex)));
        routes.push(agent_route(&AgentProbe::missing(Agent::Claude)));
        routes.push(endpoint_route(&Endpoint {
            id: "proxy".to_owned(),
            label: "P".to_owned(),
            base_url: "https://e.example.com".to_owned(),
            has_key: true,
        }));
        let ids: std::collections::BTreeSet<_> = routes.iter().map(|r| &r.id).collect();
        assert_eq!(ids.len(), routes.len(), "ids must not collide");
        for route in &routes {
            assert!(
                route.id.contains(':'),
                "{} is not namespaced by kind",
                route.id
            );
        }
    }

    /// An agent is never a speech route. The gloss and Test voice must not be
    /// able to reach one, and the modality tag is where that starts.
    #[test]
    fn no_agent_route_is_ever_a_speech_route() {
        for agent in crate::agent::AGENTS {
            let route = agent_route(&AgentProbe::missing(agent));
            assert_eq!(route.modality, Modality::Text);
        }
    }

    #[test]
    fn the_probe_finds_a_route_by_id_and_lists_only_usable_ones() {
        let probe = Probe {
            routes: local_routes(
                &manifest(),
                |m| m.modality == crate::manifest::Modality::Text,
                true,
            ),
            runtime_version: Some("11.7.0".to_owned()),
        };
        assert_eq!(
            probe.usable().count(),
            1,
            "only the text model is installed"
        );
        assert!(probe
            .route(&local_route_id("qwen3-4b-instruct-2507-q4-k-m"))
            .is_some());
        assert!(probe.route("nope").is_none());
    }
    /// A reader told "Version not supported" cannot act on it. Paper knows the
    /// number it wants — this is that number reaching the pane.
    #[test]
    fn an_unsupported_version_says_which_one_is_needed() {
        let row = agent_route(&AgentProbe {
            agent: Agent::Codex,
            path: Some("/usr/local/bin/codex".to_owned()),
            version: Some(Version(0, 1, 0)),
            auth: Some(AuthState::VersionUnsupported),
            unusable: Some(agent::VERSION_NOT_SUPPORTED),
        });
        let said = row.unusable.expect("a reason");
        assert!(said.starts_with(agent::VERSION_NOT_SUPPORTED), "{said}");
        assert!(
            said.contains(&Agent::Codex.minimum_version().to_string()),
            "the reason should name the version it needs: {said}"
        );
    }

    /// The other two reasons are unchanged — each already names its own fix,
    /// and a version number bolted onto "Not installed" would be noise.
    #[test]
    fn the_other_reasons_are_left_exactly_as_they_were() {
        let signed_out = agent_route(&AgentProbe {
            agent: Agent::Claude,
            path: Some("/usr/local/bin/claude".to_owned()),
            version: Some(Version(9, 9, 9)),
            auth: Some(AuthState::SignedOut),
            unusable: Some(agent::SIGNED_OUT),
        });
        assert_eq!(signed_out.unusable.as_deref(), Some(agent::SIGNED_OUT));
        assert_eq!(
            agent_route(&AgentProbe::missing(Agent::Claude))
                .unusable
                .as_deref(),
            Some(agent::NOT_INSTALLED)
        );
    }
}
