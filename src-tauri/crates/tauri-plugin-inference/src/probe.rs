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

/// Why a route cannot answer, as a code the UI can branch on.
///
/// ⚠️ **THE SENTENCE WAS THE STATE.** `unusable` is display text in §11's
/// voice, and `routesModel.ts` decided which BUTTON to draw by comparing it
/// against the exact strings `"Not installed"` and `"Signed out"`. So the
/// wording and the behaviour were the same field: rephrasing a reason — or
/// translating one — silently turned an `[Install]` button into a dead row,
/// with nothing anywhere to catch it. Worse, the local rows borrowed
/// `agent::NOT_INSTALLED`, an agent-facing constant, purely because the two
/// sentences happened to read the same.
///
/// So the code crosses beside the text, and the text is derived FROM the code
/// — one place decides both, and they cannot disagree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnusableReason {
    /// A local model whose artifacts are not on disk. The fix is a download.
    NotInstalled,
    /// Installed, but the runtime that would load it is not there (F2).
    RuntimeMissing,
    /// An agent CLI that is not on the reader's PATH.
    AgentMissing,
    /// An agent CLI that is present but not logged in. The fix is a sign-in.
    SignedOut,
    /// An agent CLI too old for this build, or one it cannot read at all.
    ///
    /// `needs` is the version to move to, and is `None` when updating is not
    /// in fact the fix — a partial install, a Store stub, or a CLI NEWER than
    /// Paper whose auth wording this build does not recognise.
    VersionUnsupported { needs: Option<String> },
    /// A registered endpoint with no API key. The fix is to add one.
    NoKey,
    /// An endpoint the daemon refused to register.
    ///
    /// ⚠️ A row's usability was decided ENTIRELY from what Paper had persisted
    /// — an id, a URL and a key in the keychain — and registration with the
    /// daemon happens separately, best-effort, at start. So an endpoint whose
    /// registration failed (a URL the daemon will not accept, a provider it
    /// does not know, a daemon that was mid-restart) was reported usable, was
    /// selectable, and then failed at the question. Persisted is not
    /// registered.
    NotRegistered,
}

impl UnusableReason {
    /// The sentence the pane shows, in §11's voice: what happened, not a code.
    pub fn text(&self) -> String {
        match self {
            UnusableReason::NotInstalled | UnusableReason::AgentMissing => {
                agent::NOT_INSTALLED.to_owned()
            }
            UnusableReason::RuntimeMissing => "Runtime not installed".to_owned(),
            UnusableReason::SignedOut => agent::SIGNED_OUT.to_owned(),
            /* THE VERSION IT NEEDS, not just that this one will not do.
             * "Version not supported" is true and useless: the reader cannot
             * act on it without going to look up what Paper wants, and Paper
             * already knows. */
            UnusableReason::VersionUnsupported { needs: Some(needs) } => {
                format!("{} — needs {needs} or newer", agent::VERSION_NOT_SUPPORTED)
            }
            UnusableReason::VersionUnsupported { needs: None } => {
                agent::VERSION_NOT_SUPPORTED.to_owned()
            }
            UnusableReason::NoKey => "No key".to_owned(),
            UnusableReason::NotRegistered => "The runtime would not accept it".to_owned(),
        }
    }
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
    ///
    /// DISPLAY ONLY. Anything deciding what to DO reads `reason`; see
    /// [`UnusableReason`] for what happened when this field was both.
    pub unusable: Option<String>,
    /// The same fact as `unusable`, as a code. `None` means usable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<UnusableReason>,
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
    /// Whether this route can answer. **The one usability decision.**
    ///
    /// ⚠️ It used to be neither: this method existed and only the tests in
    /// this file called it, while `commands.rs` gated the actual request on a
    /// laxer catalogue-membership check and `routesModel.ts` re-derived
    /// usability a third time from the reason sentence. Three opinions about
    /// "can this answer", and the one guarding the request was the weakest.
    /// `resolve_model` now asks this.
    pub fn usable(&self) -> bool {
        self.reason.is_none()
    }

    /// Whether the fields say the same thing about the same route.
    ///
    /// The struct is a wire DTO and cannot make its contradictions
    /// unrepresentable — an endpoint marked installed, a local route with no
    /// size, a route whose sentence and code disagree are all constructible.
    /// So the invariants are stated here and checked over everything the three
    /// constructors can build; see `every_route_satisfies_its_invariants`.
    #[cfg(test)]
    fn invariants_hold(&self) -> std::result::Result<(), String> {
        if self.unusable.is_some() != self.reason.is_some() {
            return Err("half a reason: the sentence and the code disagree about usability".into());
        }
        if let (Some(text), Some(reason)) = (&self.unusable, &self.reason) {
            if text != &reason.text() {
                return Err(format!("the sentence {text:?} is not {reason:?}'s"));
            }
        }
        match self.kind {
            // Only a local route has artifacts to install or a size to quote.
            RouteKind::Local => {
                if self.bytes.is_none() {
                    return Err("a local route with no download size".into());
                }
            }
            RouteKind::Agent | RouteKind::Endpoint => {
                if self.installed {
                    return Err("a non-local route claiming to be installed".into());
                }
                if self.bytes.is_some() {
                    return Err("a non-local route quoting a download size".into());
                }
                if self.modality != Modality::Text {
                    return Err("a non-local route that is not text".into());
                }
            }
        }
        // An installed local route is one whose artifacts are on disk; the
        // reason for it being unusable can then only be the runtime.
        if self.installed && self.reason == Some(UnusableReason::NotInstalled) {
            return Err("installed and `notInstalled` at once".into());
        }
        if !self.installed && self.kind == RouteKind::Local && self.reason.is_none() {
            return Err("a local route that is usable without being installed".into());
        }
        Ok(())
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
    const KB: f64 = 1_000.0;
    let n = bytes as f64;
    if n < KB {
        return format!("{bytes} B");
    }
    /* ⚠️ THE UNIT IS CHOSEN AFTER ROUNDING, NOT BEFORE IT. Testing the raw
     * figure against each threshold and rounding afterwards printed `1000 MB`
     * for anything from 999 500 000 bytes up — four digits in a unit that only
     * ever has three, beside a download quoted in the next unit up. `KB` was
     * also simply missing, so a 4 KiB file read as `4096 B`.
     *
     * The same defect, and the same fix, as `formatBytes` in
     * `modelsModel.ts`: the two formatters are read side by side in the same
     * pane and must not disagree about where a boundary is. */
    let kb = (n / KB).round();
    if kb < 1_000.0 {
        return format!("{kb:.0} KB");
    }
    let mb = (n / MB).round();
    if mb < 1_000.0 {
        return format!("{mb:.0} MB");
    }
    format!("{:.1} GB", n / GB)
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
            let reason = if !is_installed {
                Some(UnusableReason::NotInstalled)
            } else if !runtime_available {
                // Installed but the runtime is not there to load it. Absent
                // is a normal state (F2) and this says so rather than
                // offering a row that fails when pressed.
                Some(UnusableReason::RuntimeMissing)
            } else {
                None
            };
            /* Once, not once per field: the detail and the row's own figure
            are the same number and were computed separately. */
            let bytes = model.total_bytes();
            Route {
                id: local_route_id(&model.id),
                kind: RouteKind::Local,
                label: model.label.clone(),
                detail: Some(format!("local · {}", human_bytes(bytes))),
                unusable: reason.as_ref().map(UnusableReason::text),
                reason,
                installed: is_installed,
                bytes: Some(bytes),
                modality: model.modality.into(),
            }
        })
        .collect()
}

/// Turn an agent probe into a row.
pub fn agent_route(probe: &AgentProbe) -> Route {
    let version = probe.version.map(|v| v.to_string());
    /* Only a SIGNED-IN agent WITH a plan adds anything to the version, which
     * the four-arm match this replaces obscured by spelling the version-only
     * case twice. */
    let plan = match &probe.auth {
        Some(AuthState::SignedIn { plan }) => plan.as_ref(),
        _ => None,
    };
    let detail = version.as_ref().map(|v| match plan {
        // The plan tier and the CLI version — what the probe could honestly
        // learn. NOT a model menu (F6).
        Some(plan) => format!("{plan} · {v}"),
        None => v.clone(),
    });
    let reason = probe.unusable.map(|text| match text {
        agent::NOT_INSTALLED => UnusableReason::AgentMissing,
        agent::SIGNED_OUT => UnusableReason::SignedOut,
        /* ⚠️ THE VERSION IT NEEDS, ONLY WHEN UPDATING IS ACTUALLY THE FIX.
         * `VersionUnsupported` arises three ways: a CLI genuinely too old, a
         * CLI that would not say what it is (a partial install, a missing
         * interpreter, Windows' Store stub), and one whose auth wording this
         * build does not recognise — which is usually a CLI NEWER than Paper.
         * Telling either of the last two to update names a remedy that will
         * not work, and for the newer one it is precisely backwards. */
        _ => UnusableReason::VersionUnsupported {
            needs: probe
                .version
                .is_some_and(|found| found < probe.agent.minimum_version())
                .then(|| probe.agent.minimum_version().to_string()),
        },
    });
    Route {
        id: agent_route_id(probe.agent),
        kind: RouteKind::Agent,
        label: probe.agent.label().to_owned(),
        detail,
        unusable: reason.as_ref().map(UnusableReason::text),
        reason,
        installed: false,
        bytes: None,
        // An agent answers questions and never reads aloud: WI-15.9's TTS is
        // the daemon's, and there is no code path from a voice to a session.
        modality: Modality::Text,
    }
}

/// Turn a registered endpoint into a row.
///
/// `registered` is whether the DAEMON accepted it, which is a separate fact
/// from whether Paper has it stored — see [`UnusableReason::NotRegistered`].
pub fn endpoint_route(endpoint: &Endpoint, registered: bool) -> Route {
    // No key first: it is the one the reader can act on, and an endpoint with
    // no key was never offered to the daemon to be refused.
    let reason = if !endpoint.has_key {
        Some(UnusableReason::NoKey)
    } else if !registered {
        Some(UnusableReason::NotRegistered)
    } else {
        None
    };
    Route {
        id: endpoint_route_id(&endpoint.id),
        kind: RouteKind::Endpoint,
        label: endpoint.label.clone(),
        detail: endpoint.has_key.then(|| "endpoint".to_owned()),
        // An endpoint that cannot answer says why, with the action that fixes
        // it where there is one, rather than failing when pressed.
        unusable: reason.as_ref().map(UnusableReason::text),
        reason,
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

    /// EVERY THRESHOLD, FROM BOTH SIDES.
    ///
    /// ⚠️ The three-figure rows are the ones that mattered. The unit was
    /// chosen from the raw byte count and the rounding applied afterwards, so
    /// anything from 999 500 000 bytes up printed `1000 MB` — four digits in
    /// a unit that only has three — and there was no KB row at all, so a 4 KiB
    /// file read as `4096 B`.
    ///
    /// The same defect and the same fix as `formatBytes` in `modelsModel.ts`.
    /// The two are read side by side in one pane and must agree about where a
    /// boundary is, which is why the cases match.
    #[test]
    fn human_bytes_promotes_its_unit_at_every_boundary() {
        for (bytes, expected) in [
            (0_u64, "0 B"),
            (999, "999 B"),
            (1_000, "1 KB"),
            (1_499, "1 KB"),
            (1_500, "2 KB"),
            (4_096, "4 KB"),
            (999_499, "999 KB"),
            (999_500, "1 MB"),
            (1_000_000, "1 MB"),
            (999_499_999, "999 MB"),
            (999_500_000, "1.0 GB"),
            (1_000_000_000, "1.0 GB"),
            (1_050_000_000, "1.1 GB"),
        ] {
            assert_eq!(human_bytes(bytes), expected, "{bytes}");
        }
    }

    /// ⚠️ THE CODE AND THE SENTENCE ARE ONE DECISION.
    ///
    /// `routesModel.ts` chose which BUTTON to draw by comparing `unusable`
    /// against the exact English strings `"Not installed"` and `"Signed out"`,
    /// so the wording and the behaviour were the same field. They are separate
    /// now, and this is what keeps them from drifting apart: every route any
    /// constructor can build has both or neither, and the text is the one its
    /// own code produces.
    #[test]
    fn every_route_satisfies_its_invariants() {
        let mut routes = local_routes(&manifest(), |_| false, true);
        routes.extend(local_routes(&manifest(), |_| true, false));
        routes.extend(local_routes(&manifest(), |_| true, true));
        for agent in crate::agent::AGENTS {
            routes.push(agent_route(&AgentProbe::missing(agent)));
            routes.push(agent_route(&AgentProbe {
                agent,
                path: Some("/usr/local/bin/cli".to_owned()),
                version: Some(Version(9, 9, 9)),
                auth: Some(AuthState::SignedOut),
                unusable: Some(agent::SIGNED_OUT),
            }));
            routes.push(agent_route(&AgentProbe {
                agent,
                path: Some("/usr/local/bin/cli".to_owned()),
                version: Some(Version(0, 0, 1)),
                auth: None,
                unusable: Some(agent::VERSION_NOT_SUPPORTED),
            }));
        }
        for has_key in [false, true] {
            for registered in [false, true] {
                routes.push(endpoint_route(
                    &Endpoint {
                        id: "e".to_owned(),
                        label: "E".to_owned(),
                        base_url: "https://example.invalid".to_owned(),
                        has_key,
                    },
                    registered,
                ));
            }
        }

        let mut unusable_seen = 0;
        for route in &routes {
            if route.reason.is_some() {
                unusable_seen += 1;
            }
            /* EVERY invariant, not only the reason pair: the struct is a wire
            DTO and cannot make its contradictions unrepresentable, so this
            is where they are ruled out — over everything all three
            constructors can build. */
            if let Err(broken) = route.invariants_hold() {
                panic!("{}: {broken}", route.id);
            }
        }
        assert!(
            unusable_seen > 0,
            "no unusable route was built, so this proves nothing"
        );
        assert!(
            routes.iter().any(|route| route.usable()),
            "no usable route was built either"
        );
    }

    /// ⚠️ PERSISTED IS NOT REGISTERED.
    ///
    /// A row's usability came entirely from what Paper had stored — an id, a
    /// URL, a key in the keychain — while registration with the daemon happens
    /// separately and best-effort at start. An endpoint the daemon refused was
    /// reported usable, was selectable, and failed at the question.
    #[test]
    fn an_endpoint_the_daemon_refused_is_not_offered() {
        let endpoint = Endpoint {
            id: "proxy".to_owned(),
            label: "P".to_owned(),
            base_url: "https://e.example.com".to_owned(),
            has_key: true,
        };
        assert!(endpoint_route(&endpoint, true).usable());

        let refused = endpoint_route(&endpoint, false);
        assert!(!refused.usable());
        assert_eq!(refused.reason, Some(UnusableReason::NotRegistered));

        /* A missing key outranks it: that is the one the reader can act on,
        and an endpoint with no key was never offered to be refused. */
        let keyless = Endpoint {
            has_key: false,
            ..endpoint
        };
        assert_eq!(
            endpoint_route(&keyless, false).reason,
            Some(UnusableReason::NoKey)
        );
    }

    /// The three actionable codes are distinguishable without reading English.
    #[test]
    fn the_codes_name_the_action_that_fixes_them() {
        let absent = &local_routes(&manifest(), |_| false, true)[0];
        assert_eq!(absent.reason, Some(UnusableReason::NotInstalled));

        let no_runtime = &local_routes(&manifest(), |_| true, false)[0];
        assert_eq!(no_runtime.reason, Some(UnusableReason::RuntimeMissing));

        let signed_out = agent_route(&AgentProbe {
            agent: Agent::Codex,
            path: Some("/usr/local/bin/codex".to_owned()),
            version: Some(Version(9, 9, 9)),
            auth: Some(AuthState::SignedOut),
            unusable: Some(agent::SIGNED_OUT),
        });
        assert_eq!(signed_out.reason, Some(UnusableReason::SignedOut));

        /* A local model that is not installed and an agent CLI that is not
        installed READ the same and are not the same thing: one is fixed by
        a download Paper performs, the other by the reader installing a CLI.
        The shared sentence is why the local rows used to borrow an
        agent-facing constant. */
        let no_cli = agent_route(&AgentProbe::missing(Agent::Claude));
        assert_eq!(no_cli.reason, Some(UnusableReason::AgentMissing));
        assert_ne!(no_cli.reason, absent.reason);
        assert_eq!(no_cli.unusable, absent.unusable);
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
        let route = endpoint_route(&endpoint, true);
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
        assert!(endpoint_route(&endpoint, true).usable());
    }

    /// Every route id is unique and namespaced, so the reader's persisted
    /// choice cannot collide across kinds.
    #[test]
    fn route_ids_are_namespaced_and_unique() {
        let mut routes = local_routes(&manifest(), |_| true, true);
        routes.push(agent_route(&AgentProbe::missing(Agent::Codex)));
        routes.push(agent_route(&AgentProbe::missing(Agent::Claude)));
        routes.push(endpoint_route(
            &Endpoint {
                id: "proxy".to_owned(),
                label: "P".to_owned(),
                base_url: "https://e.example.com".to_owned(),
                has_key: true,
            },
            true,
        ));
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
    /// AND ONLY WHEN UPDATING IS THE FIX. The same reason covers a CLI that
    /// would not say what it is, and one whose auth wording is newer than this
    /// build understands — telling either reader to update names a remedy that
    /// does not work, and for the newer CLI it is backwards.
    #[test]
    fn an_unreadable_or_newer_version_is_not_told_to_update() {
        let unreadable = agent_route(&AgentProbe {
            agent: Agent::Codex,
            path: Some("/usr/local/bin/codex".to_owned()),
            version: None,
            auth: Some(AuthState::VersionUnsupported),
            unusable: Some(agent::VERSION_NOT_SUPPORTED),
        });
        assert_eq!(
            unreadable.unusable.as_deref(),
            Some(agent::VERSION_NOT_SUPPORTED),
            "a CLI that would not name its version cannot be fixed by updating"
        );

        let newer = agent_route(&AgentProbe {
            agent: Agent::Codex,
            path: Some("/usr/local/bin/codex".to_owned()),
            version: Some(Version(99, 0, 0)),
            auth: Some(AuthState::VersionUnsupported),
            unusable: Some(agent::VERSION_NOT_SUPPORTED),
        });
        assert_eq!(
            newer.unusable.as_deref(),
            Some(agent::VERSION_NOT_SUPPORTED),
            "a CLI newer than this build must not be told to update"
        );
    }
}
