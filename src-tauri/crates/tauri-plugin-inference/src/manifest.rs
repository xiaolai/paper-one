//! `models.manifest.json` — the provenance record, and the only thing a
//! gallery entry is allowed to become.
//!
//! WI-15.1. Lemonade's `server_models.json` carries a checkpoint, a recipe
//! and a rounded gigabyte count, and **no license and no per-model digest** —
//! confirmed against the `resources/server_models.json` inside
//! `lemonade-embeddable-11.7.0`, where the whole of `kokoro-v1` is
//! `{"checkpoint": "mikkoph/kokoro-onnx", "recipe": "kokoro", "suggested":
//! true, "labels": ["tts"], "size": 0.354}`. That cannot be a provenance
//! record, so Paper ships its own.
//!
//! # Embedded, not read from disk
//!
//! `include_str!`, and the reason is the manifest's job. This file is what
//! Paper checks a downloaded artifact AGAINST; a manifest the reader could
//! edit is a digest check that can be edited to pass. Embedding also means it
//! cannot drift from the binary that verifies with it — there is no version
//! of Paper whose manifest is from a different build.
//!
//! The file still lives at the repo root beside its schema, exactly as
//! `capabilities.manifest.json` does, so an editor validates it in place and
//! a reviewer reads it as data rather than as a Rust literal.
//!
//! # Artifacts are a list
//!
//! One model is routinely more than one file: Kokoro is a graph plus a voice
//! pack, and a large GGUF is published as numbered shards. An entry with a
//! single `file` field would have forced a fake second model to carry a voice
//! file that is not a model.

use serde::{Deserialize, Serialize};

use crate::digest::Expected;
use crate::error::{Error, Result};
use crate::paths::safe_component;

/// The manifest format this build speaks.
pub const MANIFEST_VERSION: u32 = 1;

/// The manifest, as shipped. See the module header for why it is embedded.
const EMBEDDED: &str = include_str!("../../../../models.manifest.json");

/// What a model does. Closed, because each arm is a code path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    /// Binds the companion (WI-15.4) and the gloss (WI-15.13).
    Text,
    /// Binds `Test voice` (WI-15.9).
    Speech,
}

/// Which runtime backend loads a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Llamacpp,
    Kokoro,
}

/// What an artifact is to its model.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactRole {
    /// The file the backend loads. The default, so an entry that names one
    /// artifact need not spell out what it is.
    #[default]
    Weights,
    /// Kokoro's voice pack.
    Voices,
}

/// One file a model is made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    pub file: String,
    pub source: String,
    pub sha256: String,
    pub bytes: u64,
    #[serde(default)]
    pub role: ArtifactRole,
}

/// One model Paper offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub label: String,
    pub modality: Modality,
    pub license: String,
    pub backend: Backend,
    pub artifacts: Vec<Artifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    /// Not sent to the webview: it is a note to a maintainer reading the
    /// manifest, and the settings pane has no place for it.
    #[serde(default, skip_serializing)]
    pub note: Option<String>,
}

impl ModelEntry {
    /// The total bytes a reader is about to wait for.
    pub fn total_bytes(&self) -> u64 {
        self.artifacts.iter().map(|a| a.bytes).sum()
    }

    /// The artifact the backend loads.
    pub fn weights(&self) -> Option<&Artifact> {
        self.artifacts
            .iter()
            .find(|a| a.role == ArtifactRole::Weights)
    }

    /// What [`crate::digest::verify`] needs for one artifact.
    pub fn expected(&self, artifact: &Artifact) -> Expected {
        Expected {
            id: format!("{}/{}", self.id, artifact.file),
            bytes: artifact.bytes,
            sha256: artifact.sha256.clone(),
        }
    }
}

/// The catalogue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub models: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct VersionProbe {
    version: u32,
}

impl Manifest {
    /// The manifest this build ships. Parsed once per call — it is a few
    /// kilobytes and nothing here is on a hot path.
    pub fn shipped() -> Result<Manifest> {
        Manifest::parse(EMBEDDED)
    }

    /// Parse and validate. Every rule below refuses rather than repairs.
    pub fn parse(text: &str) -> Result<Manifest> {
        // The VERSION IS READ FIRST, on its own. A version-2 manifest may
        // have a `models` array this build would happily deserialize into
        // something subtly wrong; refusing before the full parse is what
        // makes "never read as version 1" true rather than aspirational.
        let probe: VersionProbe =
            serde_json::from_str(text).map_err(|e| Error::ManifestMalformed(e.to_string()))?;
        if probe.version != MANIFEST_VERSION {
            return Err(Error::ManifestUnsupportedVersion {
                version: probe.version,
                supported: MANIFEST_VERSION,
            });
        }

        let manifest: Manifest =
            serde_json::from_str(text).map_err(|e| Error::ManifestMalformed(e.to_string()))?;

        let mut seen = std::collections::BTreeSet::new();
        for model in &manifest.models {
            // The id is a directory name. Checked HERE as well as by the
            // schema, because the schema is an editor's courtesy and this is
            // the thing that runs.
            safe_component(&model.id)
                .map_err(|_| Error::ManifestMalformed(format!("bad model id {:?}", model.id)))?;
            if !seen.insert(model.id.clone()) {
                return Err(Error::ManifestMalformed(format!(
                    "duplicate model id {:?}",
                    model.id
                )));
            }
            if model.artifacts.is_empty() {
                return Err(Error::ManifestMalformed(format!(
                    "model {:?} has no artifacts",
                    model.id
                )));
            }
            let mut files = std::collections::BTreeSet::new();
            for artifact in &model.artifacts {
                safe_component(&artifact.file).map_err(|_| {
                    Error::ManifestMalformed(format!("bad artifact file {:?}", artifact.file))
                })?;
                if !files.insert(artifact.file.clone()) {
                    return Err(Error::ManifestMalformed(format!(
                        "duplicate artifact {:?} in {:?}",
                        artifact.file, model.id
                    )));
                }
                // HTTPS ONLY. These are the only non-loopback URLs in the
                // system, and a manifest that could name http:// would make
                // the digest the only thing standing between a reader and a
                // tampered artifact.
                if !artifact.source.starts_with("https://") {
                    return Err(Error::ManifestMalformed(format!(
                        "artifact {:?} is not https",
                        artifact.file
                    )));
                }
                if artifact.sha256.len() != 64
                    || !artifact.sha256.chars().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(Error::ManifestMalformed(format!(
                        "artifact {:?} has no usable sha256",
                        artifact.file
                    )));
                }
                if artifact.bytes == 0 {
                    return Err(Error::ManifestMalformed(format!(
                        "artifact {:?} declares zero bytes",
                        artifact.file
                    )));
                }
            }
            if model.weights().is_none() {
                return Err(Error::ManifestMalformed(format!(
                    "model {:?} has no weights artifact",
                    model.id
                )));
            }
        }
        Ok(manifest)
    }

    /// One entry by id, or [`Error::ModelUnknown`].
    pub fn model(&self, id: &str) -> Result<&ModelEntry> {
        self.models
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| Error::ModelUnknown(id.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shipped file parses, and every rule above holds for it. This is
    /// the test that turns red when someone hand-edits the manifest.
    #[test]
    fn the_shipped_manifest_is_valid() {
        let manifest = Manifest::shipped().expect("the shipped manifest must parse");
        assert_eq!(manifest.version, MANIFEST_VERSION);
        assert!(!manifest.models.is_empty());
    }

    /// The plan picks exactly two models and says a third is a later decision
    /// with its own download. A manifest that quietly grew a third would be
    /// that decision made without anyone taking it.
    #[test]
    fn the_shipped_manifest_is_the_two_models_the_plan_picked() {
        let manifest = Manifest::shipped().unwrap();
        assert_eq!(
            manifest.models.len(),
            2,
            "two models is the scope; a third is a later decision with its own download"
        );
        let text = manifest
            .models
            .iter()
            .filter(|m| m.modality == Modality::Text)
            .count();
        let speech = manifest
            .models
            .iter()
            .filter(|m| m.modality == Modality::Speech)
            .count();
        assert_eq!((text, speech), (1, 1), "one LLM slot, one TTS slot");
    }

    /// Every artifact carries a real digest. The specific failure this
    /// guards: a placeholder digest shipped as a stand-in, which is a check
    /// that passes for a file nobody verified.
    #[test]
    fn no_artifact_ships_a_placeholder_digest() {
        let manifest = Manifest::shipped().unwrap();
        for model in &manifest.models {
            for artifact in &model.artifacts {
                assert_ne!(
                    artifact.sha256,
                    "0".repeat(64),
                    "{} carries a placeholder digest",
                    artifact.file
                );
                assert!(
                    artifact.bytes > 1024,
                    "{} declares an implausible byte count",
                    artifact.file
                );
            }
        }
    }

    /// Every model names a license. The reason this is a test and not a
    /// convention: it is the field Lemonade's own catalogue does not carry,
    /// and the reason this manifest exists at all.
    #[test]
    fn every_model_names_a_license() {
        for model in Manifest::shipped().unwrap().models {
            assert!(
                !model.license.trim().is_empty(),
                "{} has no license",
                model.id
            );
        }
    }

    #[test]
    fn kokoro_carries_its_voice_pack_as_a_second_artifact() {
        let manifest = Manifest::shipped().unwrap();
        let kokoro = manifest
            .models
            .iter()
            .find(|m| m.modality == Modality::Speech)
            .expect("a speech model");
        assert_eq!(
            kokoro.artifacts.len(),
            2,
            "a graph without its voices synthesises nothing"
        );
        assert!(kokoro
            .artifacts
            .iter()
            .any(|a| a.role == ArtifactRole::Voices));
        assert!(kokoro.weights().is_some());
    }

    #[test]
    fn a_future_version_is_refused_rather_than_read_as_this_one() {
        let err = Manifest::parse(r#"{"version": 2, "models": []}"#).unwrap_err();
        assert_eq!(err.kind(), "manifestUnsupportedVersion");
    }

    #[test]
    fn a_malformed_manifest_is_never_an_empty_catalogue() {
        let err = Manifest::parse("not json").unwrap_err();
        assert_eq!(err.kind(), "manifestMalformed");
    }

    fn one_model(patch: serde_json::Value) -> Result<Manifest> {
        let mut model = serde_json::json!({
            "id": "m",
            "label": "M",
            "modality": "text",
            "license": "Apache-2.0",
            "backend": "llamacpp",
            "artifacts": [{
                "file": "m.gguf",
                "source": "https://example.invalid/m.gguf",
                "sha256": "a".repeat(64),
                "bytes": 10,
                "role": "weights"
            }]
        });
        if let (Some(base), Some(over)) = (model.as_object_mut(), patch.as_object()) {
            for (k, v) in over {
                base.insert(k.clone(), v.clone());
            }
        }
        Manifest::parse(&serde_json::json!({ "version": 1, "models": [model] }).to_string())
    }

    #[test]
    fn a_baseline_entry_parses_so_the_negatives_below_mean_something() {
        one_model(serde_json::json!({})).expect("the baseline must be valid");
    }

    #[test]
    fn an_id_that_could_traverse_is_refused() {
        let err = one_model(serde_json::json!({ "id": "../../etc" })).unwrap_err();
        assert_eq!(err.kind(), "manifestMalformed");
    }

    #[test]
    fn a_plain_http_source_is_refused() {
        let err = one_model(serde_json::json!({
            "artifacts": [{
                "file": "m.gguf",
                "source": "http://example.invalid/m.gguf",
                "sha256": "a".repeat(64),
                "bytes": 10
            }]
        }))
        .unwrap_err();
        assert_eq!(err.kind(), "manifestMalformed");
    }

    #[test]
    fn an_entry_without_a_usable_digest_is_refused() {
        let err = one_model(serde_json::json!({
            "artifacts": [{
                "file": "m.gguf",
                "source": "https://example.invalid/m.gguf",
                "sha256": "nope",
                "bytes": 10
            }]
        }))
        .unwrap_err();
        assert_eq!(err.kind(), "manifestMalformed");
    }

    #[test]
    fn an_entry_with_no_artifacts_is_refused() {
        let err = one_model(serde_json::json!({ "artifacts": [] })).unwrap_err();
        assert_eq!(err.kind(), "manifestMalformed");
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let model = serde_json::json!({
            "id": "m", "label": "M", "modality": "text", "license": "X",
            "backend": "llamacpp",
            "artifacts": [{
                "file": "m.gguf", "source": "https://e.invalid/m",
                "sha256": "a".repeat(64), "bytes": 1
            }]
        });
        let err = Manifest::parse(
            &serde_json::json!({ "version": 1, "models": [model.clone(), model] }).to_string(),
        )
        .unwrap_err();
        assert_eq!(err.kind(), "manifestMalformed");
    }

    #[test]
    fn an_unknown_model_is_a_typed_refusal() {
        let err = Manifest::shipped().unwrap().model("nope").unwrap_err();
        assert_eq!(err.kind(), "modelUnknown");
    }

    #[test]
    fn total_bytes_sums_every_artifact() {
        let manifest = Manifest::shipped().unwrap();
        let kokoro = manifest.model("kokoro-v1-onnx").unwrap();
        assert_eq!(
            kokoro.total_bytes(),
            kokoro.artifacts.iter().map(|a| a.bytes).sum::<u64>()
        );
        assert!(kokoro.total_bytes() > kokoro.weights().unwrap().bytes);
    }

    /// The maintainer's note is for the manifest's readers, not the reader's
    /// settings pane.
    #[test]
    fn the_maintainer_note_does_not_cross_to_the_webview() {
        let manifest = Manifest::shipped().unwrap();
        let rendered = serde_json::to_string(&manifest).unwrap();
        assert!(
            !rendered.contains("\"note\""),
            "the note is skipped on serialize"
        );
    }
}
