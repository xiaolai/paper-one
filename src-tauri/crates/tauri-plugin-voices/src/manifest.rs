//! `voices.manifest.json` — what a voice pack is, and the only thing a download
//! is allowed to become.
//!
//! # Embedded, not read from disk
//!
//! `include_str!`, for the reason the deleted `models.manifest.json` recorded:
//! this file is what Paper checks a downloaded artifact AGAINST, so a manifest
//! the reader could edit is a digest check that can be edited to pass. Embedding
//! also means it cannot drift from the binary that verifies with it.
//!
//! The file lives at the repository root beside its schema, as
//! `capabilities.manifest.json` does, so an editor validates it in place and a
//! reviewer reads it as data rather than as a Rust literal.
//!
//! # What this module refuses, and why each one is a real failure
//!
//! Every rule here exists because the alternative is a download that cannot be
//! checked, or a file written somewhere it was not meant to go:
//!
//! - **A digest that is not 64 hex characters.** Without it nothing downstream
//!   can tell the right bytes from a captive portal's error page.
//! - **A URL with no 40-character revision in it.** A URL naming a branch
//!   answers differently tomorrow, and then the digest fails for a reader who did
//!   nothing wrong. Pinning is what makes the digest a fact rather than a race.
//! - **A size of zero, or a missing one.** The installer reports progress against
//!   the declared total and resumes against the declared size.
//! - **A path that escapes the pack.** `..`, a leading `/`, a Windows drive or a
//!   backslash: a pack's files are written by Paper, so the manifest decides
//!   where, and the answer may only ever be inside the pack's own directory.
//! - **Two packs with one id, or two artifacts at one path.** Both make the
//!   install order decide the result.

use serde::{Deserialize, Serialize};

/// The manifest format this build speaks.
pub const MANIFEST_VERSION: u32 = 1;

/// The catalogue, as shipped. See the module header for why it is embedded.
const EMBEDDED: &str = include_str!("../../../../voices.manifest.json");

/// Which engine reads a pack. The engine decides what the files mean.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    /// Kokoro 82M through ONNX Runtime, with Paper's own English front end.
    Kokoro,
    /// Qwen3-TTS through MLX, on Apple silicon only.
    Qwen,
}

impl Family {
    /// The name the interface stores a voice under.
    ///
    /// A reader's chosen voice is kept engine-qualified (`kokoro:af_heart`),
    /// because two packs may ship a voice of the same name and a bare id would
    /// silently resolve to whichever was listed first. These strings are that
    /// prefix, so they are part of a stored preference and may not be renamed
    /// without reading old values.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Kokoro => "kokoro",
            Self::Qwen => "qwen",
        }
    }
}

/// Where a pack is OFFERED. A build elsewhere does not list it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

impl Platform {
    /// The platform this build runs on, or `None` where no pack can be offered.
    #[must_use]
    pub fn current() -> Option<Self> {
        match std::env::consts::OS {
            "macos" => Some(Self::Macos),
            "windows" => Some(Self::Windows),
            "linux" => Some(Self::Linux),
            _ => None,
        }
    }
}

/// What the engine does with a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Model,
    Voice,
    Config,
    Lexicon,
    Licence,
}

/// One file of a pack, and everything needed to fetch and check it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    /// Where the file lands inside the pack.
    pub path: String,
    /// Where the bytes come from, pinned to a commit.
    pub url: String,
    /// Exact size.
    pub bytes: u64,
    /// Checked before the file is promoted out of staging.
    pub sha256: String,
    /// The licence these bytes arrive under, shown to the reader.
    pub licence: String,
    pub role: Role,
}

/// A voice the reader can choose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Voice {
    /// What the engine is asked for.
    pub id: String,
    /// What the reader sees.
    pub name: String,
    pub language: String,
    /// Who the voice is, in one phrase.
    pub note: String,
}

/// A downloadable pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub id: String,
    pub family: Family,
    pub name: String,
    pub summary: String,
    pub languages: Vec<String>,
    pub platforms: Vec<Platform>,
    /// Measured peak while rendering, plus headroom.
    pub minimum_memory_gb: u32,
    pub voices: Vec<Voice>,
    pub artifacts: Vec<Artifact>,
}

impl Pack {
    /// Every byte this pack costs to download.
    #[must_use]
    pub fn total_bytes(&self) -> u64 {
        self.artifacts.iter().map(|a| a.bytes).sum()
    }

    /// Whether this pack reads `language` — matched on the primary subtag, which
    /// is how `kernel.readingVoice` is keyed.
    #[must_use]
    pub fn reads(&self, language: &str) -> bool {
        let primary = language
            .split(['-', '_'])
            .next()
            .unwrap_or(language)
            .to_ascii_lowercase();
        self.languages
            .iter()
            .any(|l| l.eq_ignore_ascii_case(&primary))
    }
}

/// The catalogue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub packs: Vec<Pack>,
}

/// Why a manifest was refused. Every one names the artifact or pack at fault,
/// because a catalogue that will not load is otherwise a silent app with no voices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Unreadable(String),
    Version(u32),
    NoPacks,
    DuplicatePack(String),
    DuplicatePath { pack: String, path: String },
    NoVoices(String),
    NoLanguages(String),
    NoPlatforms(String),
    NoArtifacts(String),
    Digest { pack: String, path: String },
    Unpinned { pack: String, url: String },
    Size { pack: String, path: String },
    Licence { pack: String, path: String },
    EscapingPath { pack: String, path: String },
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable(why) => write!(f, "the voices manifest will not read: {why}"),
            Self::Version(v) => write!(
                f,
                "the voices manifest is version {v}, and this build speaks {MANIFEST_VERSION}"
            ),
            Self::NoPacks => write!(f, "the voices manifest offers no packs"),
            Self::DuplicatePack(id) => write!(f, "two packs are called {id}"),
            Self::DuplicatePath { pack, path } => {
                write!(f, "{pack} writes two artifacts to {path}")
            }
            Self::NoVoices(id) => write!(f, "{id} offers no voice"),
            Self::NoLanguages(id) => write!(f, "{id} reads no language"),
            Self::NoPlatforms(id) => write!(f, "{id} is offered on no platform"),
            Self::NoArtifacts(id) => write!(f, "{id} has no artifacts"),
            Self::Digest { pack, path } => write!(f, "{pack}'s {path} has no usable sha256"),
            Self::Unpinned { pack, url } => write!(
                f,
                "{pack} names an unpinned url, with no 40-character revision in it: {url}"
            ),
            Self::Size { pack, path } => write!(f, "{pack}'s {path} declares no size"),
            Self::Licence { pack, path } => write!(f, "{pack}'s {path} names no licence"),
            Self::EscapingPath { pack, path } => {
                write!(f, "{pack}'s {path} would be written outside the pack")
            }
        }
    }
}

impl std::error::Error for Refusal {}

/// A path Paper may write inside a pack: relative, no parent steps, no root, and
/// no backslash — which is a separator on Windows and an ordinary character here.
fn stays_inside(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Whether a URL names a 40-character revision, which is what makes the digest a
/// fact rather than a race with whoever moves the branch.
fn is_pinned(url: &str) -> bool {
    url.starts_with("https://")
        && url.split('/').any(|part| {
            part.len() == 40
                && part
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

fn is_sha256(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Read a catalogue and refuse everything the header lists.
///
/// # Errors
/// Returns the first [`Refusal`] the text earns, naming the pack or artifact.
pub fn parse(text: &str) -> Result<Manifest, Refusal> {
    let manifest: Manifest =
        serde_json::from_str(text).map_err(|e| Refusal::Unreadable(e.to_string()))?;
    if manifest.version != MANIFEST_VERSION {
        return Err(Refusal::Version(manifest.version));
    }
    if manifest.packs.is_empty() {
        return Err(Refusal::NoPacks);
    }
    let mut seen_packs = std::collections::BTreeSet::new();
    for pack in &manifest.packs {
        if !seen_packs.insert(pack.id.as_str()) {
            return Err(Refusal::DuplicatePack(pack.id.clone()));
        }
        if pack.voices.is_empty() {
            return Err(Refusal::NoVoices(pack.id.clone()));
        }
        if pack.languages.is_empty() {
            return Err(Refusal::NoLanguages(pack.id.clone()));
        }
        if pack.platforms.is_empty() {
            return Err(Refusal::NoPlatforms(pack.id.clone()));
        }
        if pack.artifacts.is_empty() {
            return Err(Refusal::NoArtifacts(pack.id.clone()));
        }
        let mut seen_paths = std::collections::BTreeSet::new();
        for artifact in &pack.artifacts {
            let at = || (pack.id.clone(), artifact.path.clone());
            if !stays_inside(&artifact.path) {
                let (pack, path) = at();
                return Err(Refusal::EscapingPath { pack, path });
            }
            if !seen_paths.insert(artifact.path.as_str()) {
                let (pack, path) = at();
                return Err(Refusal::DuplicatePath { pack, path });
            }
            if !is_sha256(&artifact.sha256) {
                let (pack, path) = at();
                return Err(Refusal::Digest { pack, path });
            }
            if !is_pinned(&artifact.url) {
                return Err(Refusal::Unpinned {
                    pack: pack.id.clone(),
                    url: artifact.url.clone(),
                });
            }
            if artifact.bytes == 0 {
                let (pack, path) = at();
                return Err(Refusal::Size { pack, path });
            }
            if artifact.licence.trim().is_empty() {
                let (pack, path) = at();
                return Err(Refusal::Licence { pack, path });
            }
        }
    }
    Ok(manifest)
}

/// The catalogue this build ships.
///
/// # Panics
/// Panics if the embedded manifest is not valid: it is checked by this crate's
/// tests, so a panic here means the binary was built from a tree whose tests
/// were not run — loud, at the first call, rather than a reader with no voices.
#[must_use]
pub fn embedded() -> Manifest {
    parse(EMBEDDED).expect("the embedded voices manifest is checked by this crate's tests")
}

/// The packs this machine may be offered: the right platform, and enough memory.
#[must_use]
pub fn offered(manifest: &Manifest, platform: Option<Platform>, memory_gb: u32) -> Vec<&Pack> {
    let Some(platform) = platform else {
        return Vec::new();
    };
    manifest
        .packs
        .iter()
        .filter(|pack| pack.platforms.contains(&platform) && pack.minimum_memory_gb <= memory_gb)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "packs": [{
                "id": "english-kokoro",
                "family": "kokoro",
                "name": "English",
                "summary": "reads English",
                "languages": ["en"],
                "platforms": ["macos"],
                "minimumMemoryGb": 4,
                "voices": [{"id": "af_heart", "name": "Heart", "language": "en-US", "note": "American."}],
                "artifacts": [{
                    "path": "model.onnx",
                    "url": "https://huggingface.co/owner/repo/resolve/dd4401a9add81ac692d20e240d22ec9dda82cc29/onnx/model.onnx",
                    "bytes": 325_532_171u64,
                    "sha256": "651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054",
                    "licence": "Apache-2.0",
                    "role": "model"
                }]
            }]
        })
    }

    /// Change one field of the single artifact and read the manifest back.
    fn with_artifact(key: &str, value: serde_json::Value) -> Result<Manifest, Refusal> {
        let mut doc = good();
        doc["packs"][0]["artifacts"][0][key] = value;
        parse(&doc.to_string())
    }

    #[test]
    fn the_shipped_catalogue_is_valid() {
        let manifest = parse(EMBEDDED).expect("the shipped catalogue must parse");
        assert_eq!(manifest.version, MANIFEST_VERSION);
        assert!(
            !manifest.packs.is_empty(),
            "a catalogue with no packs offers nothing"
        );
        for pack in &manifest.packs {
            assert!(pack.total_bytes() > 0, "{} declares no bytes", pack.id);
        }
    }

    #[test]
    fn a_catalogue_of_this_shape_is_accepted() {
        assert!(parse(&good().to_string()).is_ok());
    }

    #[test]
    fn an_artifact_without_a_digest_is_refused() {
        assert!(matches!(
            with_artifact("sha256", serde_json::json!("")),
            Err(Refusal::Digest { .. })
        ));
        // Right length, wrong alphabet: a digest that only looks like one.
        assert!(matches!(
            with_artifact("sha256", serde_json::json!("X".repeat(64))),
            Err(Refusal::Digest { .. })
        ));
    }

    #[test]
    fn an_unpinned_url_is_refused() {
        assert!(matches!(
            with_artifact(
                "url",
                serde_json::json!("https://huggingface.co/owner/repo/resolve/main/onnx/model.onnx")
            ),
            Err(Refusal::Unpinned { .. })
        ));
    }

    #[test]
    fn an_artifact_without_a_size_is_refused() {
        assert!(matches!(
            with_artifact("bytes", serde_json::json!(0)),
            Err(Refusal::Size { .. })
        ));
    }

    #[test]
    fn an_artifact_without_a_licence_is_refused() {
        assert!(matches!(
            with_artifact("licence", serde_json::json!("  ")),
            Err(Refusal::Licence { .. })
        ));
    }

    #[test]
    fn a_path_that_leaves_the_pack_is_refused() {
        for escape in [
            "../outside.onnx",
            "/etc/passwd",
            "voices/../../x",
            "C:/x",
            "a\\b",
        ] {
            assert!(
                matches!(
                    with_artifact("path", serde_json::json!(escape)),
                    Err(Refusal::EscapingPath { .. })
                ),
                "{escape} must not be writable"
            );
        }
    }

    #[test]
    fn a_pack_is_offered_only_where_its_platform_and_memory_allow() {
        let manifest = parse(EMBEDDED).expect("the shipped catalogue must parse");
        let mac = offered(&manifest, Some(Platform::Macos), 64);
        assert!(
            !mac.is_empty(),
            "the packs are offered on a Mac with memory to spare"
        );
        assert!(
            offered(&manifest, Some(Platform::Windows), 64).is_empty(),
            "no pack is offered on Windows yet"
        );
        assert!(
            offered(&manifest, None, 64).is_empty(),
            "a platform Paper does not know is offered nothing"
        );
        let smallest = manifest
            .packs
            .iter()
            .map(|p| p.minimum_memory_gb)
            .min()
            .expect("packs");
        assert!(
            offered(&manifest, Some(Platform::Macos), smallest - 1).is_empty(),
            "a machine under every floor is offered nothing"
        );
    }

    #[test]
    fn a_pack_reads_by_primary_subtag() {
        let manifest = parse(EMBEDDED).expect("the shipped catalogue must parse");
        let english = manifest
            .packs
            .iter()
            .find(|p| p.family == Family::Kokoro)
            .expect("english");
        assert!(english.reads("en"));
        assert!(english.reads("en-GB"));
        assert!(english.reads("EN_us"));
        assert!(!english.reads("zh"));
    }

    #[test]
    fn two_packs_with_one_id_are_refused() {
        let mut doc = good();
        let copy = doc["packs"][0].clone();
        doc["packs"].as_array_mut().expect("packs").push(copy);
        assert!(matches!(
            parse(&doc.to_string()),
            Err(Refusal::DuplicatePack(_))
        ));
    }

    #[test]
    fn two_artifacts_at_one_path_are_refused() {
        let mut doc = good();
        let copy = doc["packs"][0]["artifacts"][0].clone();
        doc["packs"][0]["artifacts"]
            .as_array_mut()
            .expect("artifacts")
            .push(copy);
        assert!(matches!(
            parse(&doc.to_string()),
            Err(Refusal::DuplicatePath { .. })
        ));
    }

    #[test]
    fn a_manifest_from_another_version_is_refused() {
        let mut doc = good();
        doc["version"] = serde_json::json!(2);
        assert!(matches!(parse(&doc.to_string()), Err(Refusal::Version(2))));
    }

    #[test]
    fn an_empty_catalogue_is_refused() {
        let doc = serde_json::json!({"version": 1, "packs": []});
        assert!(matches!(parse(&doc.to_string()), Err(Refusal::NoPacks)));
    }

    #[test]
    fn a_pack_with_no_voice_or_no_language_is_refused() {
        let mut doc = good();
        doc["packs"][0]["voices"] = serde_json::json!([]);
        assert!(matches!(parse(&doc.to_string()), Err(Refusal::NoVoices(_))));
        let mut doc = good();
        doc["packs"][0]["languages"] = serde_json::json!([]);
        assert!(matches!(
            parse(&doc.to_string()),
            Err(Refusal::NoLanguages(_))
        ));
        let mut doc = good();
        doc["packs"][0]["platforms"] = serde_json::json!([]);
        assert!(matches!(
            parse(&doc.to_string()),
            Err(Refusal::NoPlatforms(_))
        ));
        let mut doc = good();
        doc["packs"][0]["artifacts"] = serde_json::json!([]);
        assert!(matches!(
            parse(&doc.to_string()),
            Err(Refusal::NoArtifacts(_))
        ));
    }

    #[test]
    fn text_that_is_not_a_manifest_is_refused_rather_than_read_as_empty() {
        assert!(matches!(parse("not json"), Err(Refusal::Unreadable(_))));
        assert!(matches!(parse("{}"), Err(Refusal::Unreadable(_))));
    }
}
