//! The staged runtime's manifest, and the verification nothing spawns without.
//!
//! WI-20.24. The staged archive used to hold `lemond` alone; the backend it
//! actually runs — `llama-server` and the ten `@rpath` libraries beside it,
//! sixty-two files on macOS — was fetched by the daemon from GitHub inside
//! the first gloss, with no hash Paper controlled, and `spawn.rs` called it
//! "the vetted builtin". Upstream publishes neither signatures nor a
//! codesign step, `lemond`'s own checksum table has no llama.cpp entry, and
//! a binary libcurl downloaded carries no quarantine flag, so Gatekeeper
//! never looks at it. Only a hash Paper records itself stands between GitHub
//! and `exec`.
//!
//! So the staging script (`scripts/sync-inference-runtime.mjs`) carries the
//! whole backend directory beside `lemond` and writes [`MANIFEST_FILE`]: one
//! entry per file — size and SHA-256. This module reads it back and, BEFORE
//! EVERY SPAWN, checks every entry against the tree and the tree against
//! every entry. A byte flipped in a library refuses the spawn and names the
//! file; so does a file the manifest never heard of, because `llama-server`
//! loads its libraries by name from its own directory (`@loader_path` on
//! macOS, the executable's directory first on Windows), which is exactly the
//! shape a planted `version.dll` takes.
//!
//! # Regular files only, and the reason is measured
//!
//! The llama.cpp archives carry their libraries as versioned files plus
//! bare-name symlinks (`libggml.dylib → libggml.0.dylib`). The first draft
//! of the manifest recorded a link by its target — and `tauri-build`'s
//! resource copy is `fs::copy`, which DEREFERENCES: the tree under
//! `target/debug/runtime/` had a 59 872-byte regular file where the staged
//! tree had a link, and would have failed its own manifest on the first
//! spawn. So the staging script turns every link into the file it named,
//! the manifest lists nothing but regular files, and a symbolic link found
//! anywhere in the tree is a refusal in its own right.
//!
//! # The proof is a type
//!
//! `SpawnInputs` takes a [`VerifiedBackend`], and the only constructor is
//! [`RuntimeManifest::verify`]. A plan for a backend nobody checked is not a
//! value that can be built — the same move `daemon.rs` makes with
//! `ModelRequest`, for the same reason: a scan can only ask about the shapes
//! somebody thought of.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::digest::sha256_file;
use crate::error::{Error, Result};

/// Beside `lemond`, written by the staging script.
pub const MANIFEST_FILE: &str = "runtime.manifest.json";

/// The manifest format this crate reads; the script writes the same number.
pub const RUNTIME_MANIFEST_VERSION: u32 = 1;

/// Files that may sit in the tree without an entry: the staging script's own
/// stamp, the manifest itself, and the Finder's droppings. None is loadable.
const UNLISTED_BY_DESIGN: &[&str] = &[".version", MANIFEST_FILE, ".DS_Store"];

/// Which llama.cpp build the tree carries, which backend, and where the
/// server executable is — relative to the runtime directory.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LlamaCppPin {
    pub tag: String,
    pub backend: String,
    pub server: String,
}

/// One entry, as the file spells it. `deny_unknown_fields` so an entry of
/// a shape this build does not read — a `link`, say — refuses the manifest
/// rather than being taken for a file with two fields missing.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntry {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct RawManifest {
    version: u32,
    platform: String,
    lemonade: String,
    llamacpp: LlamaCppPin,
    files: Vec<RawEntry>,
}

/// A validated entry: a relative path with no way out, and the regular file
/// that must be there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Forward-slash relative, as the file spells it.
    pub path: String,
    pub bytes: u64,
    /// Lowercase hex.
    pub sha256: String,
}

/// The manifest, validated. Every path is relative and cannot traverse, the
/// server is a listed file, and the platform is this one.
///
/// ⚠️ **EVERY FIELD IS PRIVATE, AND THAT IS THE INVARIANT.** Three of them
/// used to be `pub`, which made `parse`'s validation a fact about the past
/// rather than about the value: a caller could parse a good manifest, set
/// `llamacpp.server` to `../../anything` or `backend` to a name the closed
/// alphabet refuses, and `verify` would hand back a [`VerifiedBackend`] for
/// an executable nothing hashed — the module header's "the proof is a type"
/// undone by a field assignment. Read them through the accessors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeManifest {
    platform: String,
    lemonade: String,
    llamacpp: LlamaCppPin,
    files: Vec<Entry>,
}

/// The backend a spawn may use — constructible only by [`RuntimeManifest::verify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedBackend {
    name: String,
    server: PathBuf,
}

impl VerifiedBackend {
    /// The backend's name in `lemond`'s vocabulary: `metal`, `cpu`, …
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The absolute path of `llama-server`, which is what `<backend>_bin` takes.
    pub fn server(&self) -> &Path {
        &self.server
    }

    /// For a test that plans a spawn and never runs one. `#[cfg(test)]`, so
    /// the invariant — a plan needs a verification — holds in a shipped build.
    #[cfg(test)]
    pub(crate) fn for_test(name: &str, server: &str) -> Self {
        VerifiedBackend {
            name: name.to_owned(),
            server: PathBuf::from(server),
        }
    }
}

/// Node's `${process.platform}-${process.arch}` for this machine — the key
/// the staging script stamps the manifest with, so a tree staged for another
/// platform is refused rather than executed.
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

fn refused(path: impl Into<PathBuf>, why: impl Into<String>) -> Error {
    Error::RuntimeUnverified {
        path: path.into(),
        why: why.into(),
    }
}

/// A relative path that stays inside the tree: forward slashes only, no
/// empty, `.` or `..` component, no drive letter, no backslash.
fn relative_component_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.starts_with('/')
        && !path.contains(':')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

impl RuntimeManifest {
    /// Parse and validate. A manifest that fails here names the reason as a
    /// verification refusal — it is the same failure to a reader: nothing
    /// was started.
    pub fn parse(text: &str) -> Result<RuntimeManifest> {
        let raw: RawManifest = serde_json::from_str(text)
            .map_err(|e| refused(MANIFEST_FILE, format!("the manifest would not parse: {e}")))?;
        if raw.version != RUNTIME_MANIFEST_VERSION {
            return Err(refused(
                MANIFEST_FILE,
                format!(
                    "manifest version {} is not the {} this build reads",
                    raw.version, RUNTIME_MANIFEST_VERSION
                ),
            ));
        }
        let here = platform_key();
        if raw.platform != here {
            return Err(refused(
                MANIFEST_FILE,
                format!(
                    "the runtime was staged for {} and this is {here}",
                    raw.platform
                ),
            ));
        }
        if raw.files.is_empty() {
            return Err(refused(MANIFEST_FILE, "the manifest lists no files"));
        }
        let mut seen = BTreeSet::new();
        let mut files = Vec::with_capacity(raw.files.len());
        for entry in raw.files {
            if !relative_component_path(&entry.path) {
                return Err(refused(&entry.path, "is not a plain relative path"));
            }
            if !seen.insert(entry.path.clone()) {
                return Err(refused(&entry.path, "is listed twice"));
            }
            if entry.sha256.len() != 64 || !entry.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(refused(&entry.path, "carries a malformed digest"));
            }
            files.push(Entry {
                path: entry.path,
                bytes: entry.bytes,
                sha256: entry.sha256.to_ascii_lowercase(),
            });
        }
        if !files.iter().any(|f| f.path == raw.llamacpp.server) {
            return Err(refused(
                &raw.llamacpp.server,
                "the server executable is not a file the manifest lists",
            ));
        }
        /* The backend NAME becomes an environment variable
         * (`LEMONADE_LLAMACPP_<NAME>_BIN`) and a JSON config key. The files
         * are digest-verified; the name was not constrained at all, so a
         * hand-edited manifest could smuggle whitespace, `=` or control
         * bytes into the child's environment. A closed alphabet, checked
         * where every other manifest invariant is. */
        if raw.llamacpp.backend.is_empty()
            || !raw
                .llamacpp
                .backend
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(refused(
                &raw.llamacpp.backend,
                "the backend name is not lowercase ascii",
            ));
        }
        Ok(RuntimeManifest {
            platform: raw.platform,
            lemonade: raw.lemonade,
            llamacpp: raw.llamacpp,
            files,
        })
    }

    /// Read `dir/runtime.manifest.json`. A runtime with no manifest is a
    /// runtime nothing can vouch for, and is refused by that name.
    pub async fn load(dir: &Path) -> Result<RuntimeManifest> {
        let path = dir.join(MANIFEST_FILE);
        let text = match tokio::fs::read_to_string(&path).await {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(refused(
                    path,
                    "the runtime has no manifest, so nothing can vouch for it",
                ));
            }
            Err(e) => return Err(Error::Io(e)),
        };
        Self::parse(&text)
    }

    /// The validated entries.
    pub fn files(&self) -> &[Entry] {
        &self.files
    }

    /// The platform key this tree was staged for — already checked against
    /// [`platform_key`] by [`parse`](Self::parse).
    pub fn platform(&self) -> &str {
        &self.platform
    }

    /// The Lemonade version the staging script recorded.
    pub fn lemonade(&self) -> &str {
        &self.lemonade
    }

    /// The llama.cpp pin: the tag, the backend name and the server's path
    /// inside the tree, all three validated by [`parse`](Self::parse).
    pub fn llamacpp(&self) -> &LlamaCppPin {
        &self.llamacpp
    }

    /// Every entry against the tree, then the tree against every entry.
    ///
    /// The digest is checked even when the size matches — a flipped byte
    /// keeps the length — and nothing is followed: a symbolic link where the
    /// manifest names a file is refused before its target is looked at, so a
    /// link pointing outside the tree at a file with the right bytes is
    /// still a path Paper did not stage.
    ///
    /// # ⚠️ Two things this does NOT prove, both accepted on purpose
    ///
    /// **The manifest is unsigned and sits inside the tree it vouches for.**
    /// It is the anchor for every hash below, so anyone who can write
    /// `runtime.manifest.json` can write the files beside it and restate
    /// their digests to match. What this establishes is INTEGRITY against a
    /// record — a flipped byte, a half-applied update, a planted
    /// `version.dll` — and not PROVENANCE. It does not answer an adversary
    /// who already holds write access to the runtime directory.
    ///
    /// **And it is time-of-check to time-of-use.** The hash is read here and
    /// the path is handed to `exec` later; a file replaced in between runs
    /// unverified. Nothing holds the files open across that gap, and on
    /// Windows nothing could hold them in a way that survives a rename.
    ///
    /// Both of these stand, and they stand as a DECISION rather than an
    /// oversight — D8, 2026-08-27. The runtime is in Application Support
    /// because it is not in the bundle yet, and the alternative it replaced
    /// was worse by a wide margin: lemond fetching `llama-server` from GitHub
    /// inside the first gloss, with no hash Paper controlled, over a libcurl
    /// download that carries no quarantine flag so Gatekeeper never looks at
    /// it. Two things bound the exposure meanwhile. This runs BEFORE EVERY
    /// SPAWN rather than once at install, so the race is one spawn wide
    /// instead of the life of the installation. And the boundary is the data
    /// directory's own permissions: anything that can write here can already
    /// write the reader's library and their books.
    ///
    /// What retires both at once is shipping the runtime INSIDE the bundle,
    /// codesigned under Paper's Team ID with hardened runtime. Then the
    /// anchor is Apple's rather than a JSON file beside the thing it
    /// describes, and the kernel checks the signature at `exec` — which is
    /// the same instant as the use, so there is no window left to race.
    /// Until that bundling step, this function is the guard.
    pub async fn verify(&self, dir: &Path) -> Result<VerifiedBackend> {
        for entry in &self.files {
            let path = dir.join(&entry.path);
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(refused(path, "is missing"));
                }
                Err(e) => return Err(Error::Io(e)),
            };
            if !meta.is_file() {
                return Err(refused(path, "is not a regular file"));
            }
            if meta.len() != entry.bytes {
                return Err(refused(
                    path,
                    format!(
                        "has size {} where the manifest says {}",
                        meta.len(),
                        entry.bytes
                    ),
                ));
            }
            let actual = sha256_file(&path).await?;
            if actual != entry.sha256 {
                return Err(refused(path, "has a digest the manifest does not"));
            }
        }

        let listed: BTreeSet<String> = self.files.iter().map(|f| f.path.clone()).collect();
        let root = dir.to_path_buf();
        /* OFF THE RUNTIME. The membership walk is `std::fs` end to end, and
         * it runs inside `ensure_started`, which holds the daemon lock — a
         * whole-tree scan on a cold or unhealthy disk stalled the async
         * runtime and everything queued on that lock with it. The same rule
         * `on_store` states for the endpoint store: blocking work goes to a
         * blocking thread. (The per-file stats above are 70 tiny calls and
         * the hashing already yields; the walk was the blocking chunk.) */
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut pending = vec![root.clone()];
            while let Some(folder) = pending.pop() {
                for entry in std::fs::read_dir(&folder)? {
                    let entry = entry?;
                    let path = entry.path();
                    let kind = entry.file_type()?;
                    if kind.is_dir() {
                        pending.push(path);
                        continue;
                    }
                    if kind.is_symlink() {
                        return Err(refused(path, "is a symbolic link, which nothing staged"));
                    }
                    let relative = path
                        .strip_prefix(&root)
                        .map_err(|_| refused(&path, "is outside the runtime directory"))?;
                    let name = relative.to_string_lossy().replace('\\', "/");
                    if listed.contains(name.as_str()) {
                        continue;
                    }
                    let bare = relative.to_string_lossy();
                    if UNLISTED_BY_DESIGN.contains(&bare.as_ref()) {
                        continue;
                    }
                    return Err(refused(path, "is not in the manifest"));
                }
            }
            Ok(())
        })
        .await
        .map_err(|join| Error::Io(std::io::Error::other(join.to_string())))??;

        Ok(VerifiedBackend {
            name: self.llamacpp.backend.clone(),
            server: dir.join(&self.llamacpp.server),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;
    use sha2::{Digest, Sha256};
    use std::path::{Path, PathBuf};

    /// A staged runtime the way `scripts/sync-inference-runtime.mjs` lays one
    /// out: `lemond`, its `resources/`, a backend directory with an
    /// executable and a library.
    struct Fixture {
        dir: ScratchDir,
        entries: Vec<serde_json::Value>,
    }

    fn hex(bytes: &[u8]) -> String {
        data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
    }

    fn fixture() -> Fixture {
        let dir = ScratchDir::new("runtime");
        let root = dir.path();
        let backend = root.join("backend").join("llamacpp").join("metal");
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::create_dir_all(&backend).unwrap();
        let files: [(&str, &[u8]); 4] = [
            ("lemond", b"lemond-bytes"),
            ("resources/defaults.json", b"{}"),
            ("backend/llamacpp/metal/llama-server", b"server-bytes"),
            ("backend/llamacpp/metal/libggml.0.dylib", b"library-bytes"),
        ];
        let mut entries = Vec::new();
        for (path, bytes) in files {
            std::fs::write(root.join(path), bytes).unwrap();
            entries.push(serde_json::json!({
                "path": path,
                "bytes": bytes.len(),
                "sha256": hex(bytes),
            }));
        }
        std::fs::write(root.join(".version"), "11.7.0 test llamacpp-b1 metal\n").unwrap();
        Fixture { dir, entries }
    }

    impl Fixture {
        fn manifest_with(&self, platform: &str, server: &str) -> String {
            serde_json::json!({
                "version": RUNTIME_MANIFEST_VERSION,
                "platform": platform,
                "lemonade": "11.7.0",
                "llamacpp": { "tag": "b10375", "backend": "metal", "server": server },
                "files": self.entries,
            })
            .to_string()
        }

        fn manifest(&self) -> String {
            self.manifest_with(&platform_key(), "backend/llamacpp/metal/llama-server")
        }

        fn write_manifest(&self) -> PathBuf {
            let path = self.dir.path().join(MANIFEST_FILE);
            std::fs::write(&path, self.manifest()).unwrap();
            path
        }

        fn root(&self) -> &Path {
            self.dir.path()
        }
    }

    fn refusal(err: crate::error::Error) -> (String, String) {
        assert_eq!(err.kind(), "runtimeUnverified", "{err}");
        match err {
            crate::error::Error::RuntimeUnverified { path, why } => {
                (path.to_string_lossy().into_owned(), why)
            }
            other => panic!("not a verification refusal: {other}"),
        }
    }

    #[tokio::test]
    async fn a_staged_runtime_verifies_and_names_its_backend() {
        let fx = fixture();
        fx.write_manifest();
        let manifest = RuntimeManifest::load(fx.root()).await.unwrap();
        let backend = manifest.verify(fx.root()).await.unwrap();
        assert_eq!(backend.name(), "metal");
        assert_eq!(
            backend.server(),
            fx.root()
                .join("backend")
                .join("llamacpp")
                .join("metal")
                .join("llama-server")
        );
    }

    /// The acceptance line: a flipped byte — same length, so a size check
    /// alone would pass it — refuses the spawn, and the refusal names the
    /// file.
    #[tokio::test]
    async fn a_flipped_byte_refuses_the_spawn_by_name() {
        let fx = fixture();
        fx.write_manifest();
        let lib = fx.root().join("backend/llamacpp/metal/libggml.0.dylib");
        let mut bytes = std::fs::read(&lib).unwrap();
        bytes[3] ^= 0x01;
        std::fs::write(&lib, &bytes).unwrap();

        let err = RuntimeManifest::load(fx.root())
            .await
            .unwrap()
            .verify(fx.root())
            .await
            .unwrap_err();
        let (path, why) = refusal(err);
        assert!(
            path.ends_with("libggml.0.dylib"),
            "the refusal must name the file: {path}"
        );
        assert!(why.contains("digest"), "{why}");
    }

    #[tokio::test]
    async fn a_missing_file_and_a_file_that_grew_are_each_named() {
        let fx = fixture();
        fx.write_manifest();
        let server = fx.root().join("backend/llamacpp/metal/llama-server");
        std::fs::write(&server, b"server-bytes-and-more").unwrap();
        let (path, why) = refusal(
            RuntimeManifest::load(fx.root())
                .await
                .unwrap()
                .verify(fx.root())
                .await
                .unwrap_err(),
        );
        assert!(path.ends_with("llama-server"), "{path}");
        assert!(why.contains("size"), "{why}");

        std::fs::remove_file(&server).unwrap();
        let (path, why) = refusal(
            RuntimeManifest::load(fx.root())
                .await
                .unwrap()
                .verify(fx.root())
                .await
                .unwrap_err(),
        );
        assert!(path.ends_with("llama-server"), "{path}");
        assert!(why.contains("missing"), "{why}");
    }

    /// `llama-server` loads its libraries by name from its own directory —
    /// `@rpath` is `@loader_path` on macOS, and on Windows the loader takes
    /// a DLL beside the executable before the system's. So a file the
    /// manifest does not know about, sitting in the runtime tree, is refused
    /// by name rather than ignored: it is exactly the shape a planted
    /// `version.dll` takes.
    #[tokio::test]
    async fn a_stranger_in_the_runtime_tree_is_refused_by_name() {
        let fx = fixture();
        fx.write_manifest();
        std::fs::write(
            fx.root().join("backend/llamacpp/metal/version.dll"),
            b"planted",
        )
        .unwrap();
        let (path, why) = refusal(
            RuntimeManifest::load(fx.root())
                .await
                .unwrap()
                .verify(fx.root())
                .await
                .unwrap_err(),
        );
        assert!(path.ends_with("version.dll"), "{path}");
        assert!(why.contains("not in the manifest"), "{why}");
    }

    /// The stamp the staging script leaves, the manifest itself, and the
    /// Finder's `.DS_Store` are the only files that may sit in the tree
    /// unlisted — none of them is loadable.
    #[tokio::test]
    async fn the_stamp_the_manifest_and_a_ds_store_are_not_strangers() {
        let fx = fixture();
        fx.write_manifest();
        std::fs::write(fx.root().join(".DS_Store"), b"finder").unwrap();
        RuntimeManifest::load(fx.root())
            .await
            .unwrap()
            .verify(fx.root())
            .await
            .unwrap();
    }

    /// The archives ship bare-name symlinks beside the versioned libraries,
    /// and `tauri-build`'s resource copy turns them into regular files — so
    /// the staged tree carries none, and one found anywhere is refused by
    /// name whatever it points at, before anything is followed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_symbolic_link_anywhere_in_the_tree_is_refused() {
        let fx = fixture();
        fx.write_manifest();
        let backend = fx.root().join("backend/llamacpp/metal");
        std::os::unix::fs::symlink("libggml.0.dylib", backend.join("libggml.dylib")).unwrap();
        let (path, why) = refusal(
            RuntimeManifest::load(fx.root())
                .await
                .unwrap()
                .verify(fx.root())
                .await
                .unwrap_err(),
        );
        assert!(path.ends_with("libggml.dylib"), "{path}");
        assert!(why.contains("symbolic link"), "{why}");

        // And where the manifest names a file, a link to a file with the
        // right bytes is still not it.
        std::fs::remove_file(backend.join("libggml.dylib")).unwrap();
        let lib = backend.join("libggml.0.dylib");
        let aside = backend.join("elsewhere.bin");
        std::fs::rename(&lib, &aside).unwrap();
        std::os::unix::fs::symlink("elsewhere.bin", &lib).unwrap();
        let (path, why) = refusal(
            RuntimeManifest::load(fx.root())
                .await
                .unwrap()
                .verify(fx.root())
                .await
                .unwrap_err(),
        );
        assert!(path.ends_with("libggml.0.dylib"), "{path}");
        assert!(why.contains("not a regular file"), "{why}");
    }

    #[tokio::test]
    async fn no_manifest_no_spawn() {
        let fx = fixture();
        let (path, why) = refusal(RuntimeManifest::load(fx.root()).await.unwrap_err());
        assert!(path.ends_with(MANIFEST_FILE), "{path}");
        assert!(why.contains("manifest"), "{why}");
    }

    #[test]
    fn a_manifest_that_traverses_or_repeats_is_refused_at_parse() {
        let fx = fixture();
        let traversing = fx
            .manifest()
            .replace("\"path\":\"lemond\"", "\"path\":\"../lemond\"");
        assert_eq!(
            RuntimeManifest::parse(&traversing).unwrap_err().kind(),
            "runtimeUnverified"
        );
        let absolute = fx
            .manifest()
            .replace("\"path\":\"lemond\"", "\"path\":\"/lemond\"");
        assert!(RuntimeManifest::parse(&absolute).is_err());
        let backslashed = fx
            .manifest()
            .replace("\"path\":\"lemond\"", "\"path\":\"a\\\\lemond\"");
        assert!(RuntimeManifest::parse(&backslashed).is_err());
        let repeated = fx.manifest().replace(
            "\"path\":\"resources/defaults.json\"",
            "\"path\":\"lemond\"",
        );
        assert!(RuntimeManifest::parse(&repeated).is_err());
    }

    #[test]
    fn the_server_must_be_a_listed_file_and_the_platform_this_one() {
        let fx = fixture();
        let unlisted = fx.manifest_with(&platform_key(), "backend/llamacpp/metal/llama-cli");
        assert!(RuntimeManifest::parse(&unlisted).is_err());
        let elsewhere = fx.manifest_with("plan9-mips", "backend/llamacpp/metal/llama-server");
        let (_, why) = refusal(RuntimeManifest::parse(&elsewhere).unwrap_err());
        assert!(why.contains("plan9-mips"), "{why}");
    }

    #[test]
    fn a_manifest_of_another_version_or_with_a_malformed_digest_is_refused() {
        let fx = fixture();
        let future = fx.manifest().replace(
            &format!("\"version\":{RUNTIME_MANIFEST_VERSION}"),
            &format!("\"version\":{}", RUNTIME_MANIFEST_VERSION + 1),
        );
        assert!(RuntimeManifest::parse(&future).is_err());
        let short = fx.manifest().replace(&hex(b"lemond-bytes"), "abc");
        assert!(RuntimeManifest::parse(&short).is_err());
        // A `link` entry — the first draft's shape — is refused outright
        // rather than read as a file with two fields missing.
        let linked = fx.manifest().replace(
            "\"path\":\"resources/defaults.json\"",
            "\"link\":\"x\",\"path\":\"resources/defaults.json\"",
        );
        assert!(RuntimeManifest::parse(&linked).is_err());
    }

    /// The key the staging script uses for the host — Node's
    /// `${process.platform}-${process.arch}` — and the one this crate
    /// computes for the same machine agree, or a correctly staged runtime
    /// would be refused everywhere.
    #[test]
    fn the_platform_key_is_node_s_spelling() {
        let key = platform_key();
        let (os, arch) = key.split_once('-').expect("os-arch");
        assert!(["darwin", "linux", "win32"].contains(&os), "{key}");
        assert!(["arm64", "x64"].contains(&arch), "{key}");
    }

    /// The tree `pnpm runtime:sync` staged on THIS machine, verified by the
    /// code that will verify it before every spawn.
    ///
    /// `#[ignore]`, and run by hand — `cargo test -p tauri-plugin-inference
    /// -- --ignored the_staged_tree` — because `vendor/inference/current/`
    /// is gitignored and absent on a fresh clone, and a test that quietly
    /// returns when its input is missing is green for the wrong reason. An
    /// ignored test is skipped LOUDLY, by name, in every run.
    #[ignore = "needs the staged runtime under vendor/inference/current; run by hand after pnpm runtime:sync"]
    #[tokio::test]
    async fn the_staged_tree_on_this_machine_verifies() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../vendor/inference/current")
            .canonicalize()
            .expect("vendor/inference/current is staged");
        let manifest = RuntimeManifest::load(&dir).await.unwrap();
        let backend = manifest.verify(&dir).await.unwrap();
        assert!(backend.server().is_file(), "{}", backend.server().display());
        assert!(
            manifest.files().len() > 40,
            "the backend is in the tree: {} entries",
            manifest.files().len()
        );
    }

    /// The exact shape `scripts/sync-inference-runtime.mjs` writes, pinned
    /// here so a change on either side fails the other.
    #[test]
    fn the_manifest_the_script_writes_parses() {
        let text = format!(
            r#"{{
  "version": 1,
  "platform": "{}",
  "lemonade": "11.7.0",
  "llamacpp": {{ "tag": "b10375", "backend": "metal", "server": "backend/llamacpp/metal/llama-server" }},
  "files": [
    {{ "path": "backend/llamacpp/metal/libggml.dylib", "bytes": 59872, "sha256": "{}" }},
    {{ "path": "backend/llamacpp/metal/llama-server", "bytes": 33472, "sha256": "{}" }},
    {{ "path": "lemond", "bytes": 10722528, "sha256": "{}" }}
  ]
}}"#,
            platform_key(),
            hex(b"l"),
            hex(b"a"),
            hex(b"b")
        );
        let manifest = RuntimeManifest::parse(&text).unwrap();
        assert_eq!(manifest.llamacpp().backend, "metal");
        assert_eq!(manifest.llamacpp().tag, "b10375");
        assert_eq!(manifest.lemonade(), "11.7.0");
        assert_eq!(manifest.files().len(), 3);
    }
}
