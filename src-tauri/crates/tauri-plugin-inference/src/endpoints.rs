//! Cloud endpoints, and the keys that are never read back.
//!
//! WI-15.8. What the reader stored — an id, a label, an OpenAI-compatible base
//! URL, a model name, and a key in the OS keychain. `cloud.rs` is what uses
//! them: Paper's own client, which sends a request straight to the endpoint.
//!
//! ⚠️ **THIS FILE WAS HALF OF A PATH THAT WENT AWAY ON 2026-09-18.** Lemonade
//! was the API-key gateway: `POST /v1/install` registered a provider by
//! `base_url`, the key rode the daemon's environment as
//! `LEMONADE_<PROVIDER>_API_KEY` (which outranked any runtime key), and the
//! store re-provisioned both on every start because Lemonade held them in
//! memory only. That path was never measured against a real provider, the
//! audit that preceded the removal found it probably never worked, and the
//! daemon it ran through is gone. The same day, `cloud.rs` replaced it: the
//! key is read from the keychain for each request and sent as that request's
//! bearer token, and nothing holds it anywhere else. Measured against
//! `llama-server` acting as a provider, with its real key and a wrong one; not
//! yet against a paid provider.
//!
//! The keychain is still the store, for the reason it always was: the only
//! honest durable store for a credential is the OS keychain — not a file in
//! the data root, which syncs, backs up and reads as plaintext to anything
//! with the reader's disk.
//!
//! # Write-only, structurally
//!
//! [`EndpointStore::set_key`] exists. There is **no `get_key` reachable from
//! a command**: the reader's key is written to the keychain and read back in
//! two places only — here, to learn whether it is there ([`KeyState`]), and
//! by the crate-private `EndpointStore::key`, for the request `cloud.rs`
//! sends and nothing else. `build.rs` has `inference_set_endpoint_key` and
//! no counterpart, so WI-15.8's acceptance — *"the key never appears in any
//! webview-reachable value"* — is a property of the command list rather than
//! of anybody's discipline. The settings field renders as dots because it is
//! genuinely unreadable, not because it is masked for show.
//!
//! # A keychain refusal is one endpoint's problem
//!
//! The keychain has THREE answers to "the key for `x`": here it is, there is
//! none, and *no* — a macOS "Deny" on the access prompt, or a dev rebuild
//! whose code signature no longer matches the ACL on an entry an earlier
//! build wrote. The third used to be handled two different ways in this file:
//! `list` folded it into `hasKey: false`, so the pane told a reader whose key
//! was sitting in the keychain to go and add one, while the spawn path
//! propagated it as an error, so one refused entry stopped the daemon — gloss
//! and local companion both dead over a credential neither needs (WI-20.20).
//! Now it is [`KeyState::Unreadable`] on the row, and no key is read on the
//! way to the server at all.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// The keychain service name every Paper credential is filed under.
const KEYCHAIN_SERVICE: &str = "one.paper.reader.inference";

/// The file the endpoint list lives in — the non-secret half.
const ENDPOINTS_FILE: &str = "endpoints.json";

/// The keychain, as this store uses it: three operations on one account.
///
/// A trait so a test can hand the store a keychain that REFUSES — which the
/// real one does on a denied prompt and after a rebuild the entry's ACL no
/// longer trusts — without touching the reader's keychain or raising a prompt.
/// `testutil::FakeKeychain` is the one implementation besides the OS's.
pub(crate) trait Keychain: Send + Sync + std::fmt::Debug {
    /// `Ok(None)` is "no entry", a normal state. `Err` is the keychain
    /// refusing to answer, which is a different fact and is kept as one.
    fn read(&self, account: &str) -> Result<Option<String>>;
    fn write(&self, account: &str, key: &str) -> Result<()>;
    /// Absent is success — deleting what is not there is the outcome asked
    /// for.
    fn delete(&self, account: &str) -> Result<()>;
}

/// The OS keychain under Paper's service name.
#[derive(Debug)]
struct OsKeychain;

impl OsKeychain {
    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| Error::Keychain(e.to_string()))
    }
}

impl Keychain for OsKeychain {
    fn read(&self, account: &str) -> Result<Option<String>> {
        match Self::entry(account)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Keychain(e.to_string())),
        }
    }

    fn write(&self, account: &str, key: &str) -> Result<()> {
        Self::entry(account)?
            .set_password(key)
            .map_err(|e| Error::Keychain(e.to_string()))
    }

    fn delete(&self, account: &str) -> Result<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Keychain(e.to_string())),
        }
    }
}

/// Whether an endpoint's key is there — THREE answers, because the keychain
/// gives three, and a boolean made the third one lie (see the module header).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyState {
    /// A key is stored. Never the key itself: this is how the settings row
    /// says "configured" without reading it back.
    Set,
    /// No key has been stored. The fix is to add one.
    #[default]
    Missing,
    /// The keychain would not say. The key may well be there; the fix is with
    /// the keychain, not the reader's provider, and telling them "no key"
    /// sends them to re-enter a credential that will be refused again.
    Unreadable,
}

/// One stored OpenAI-compatible provider.
///
/// **No key field.** The key lives in the keychain under [`Endpoint::id`],
/// and this struct is what crosses IPC — so there is nothing here for a
/// serializer, a log line or a diagnostics bundle to spill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// The provider id. Also the keychain account name, so it is a closed
    /// alphabet.
    pub id: String,
    /// What the settings row calls it.
    pub label: String,
    /// The OpenAI-compatible base URL: `https://`, or `http://` to a loopback
    /// host — see [`valid_base_url`].
    pub base_url: String,
    /// The model the endpoint is asked for, in the PROVIDER'S spelling.
    ///
    /// An endpoint stored before this field existed reads `""`, and its row
    /// says `No model name` rather than being offered: a request needs one,
    /// and there is no model name Paper could honestly guess for somebody
    /// else's server.
    #[serde(default)]
    pub model: String,
    /// Whether a key is stored, and whether that could be found out. A STATE,
    /// never the key.
    #[serde(default)]
    pub key_state: KeyState,
}

/// A provider id: `[a-z0-9-]`, so it is safe as a keychain account — and as
/// the environment-variable stem it was while keys rode lemond's environment,
/// which is a property worth keeping for whatever client comes next.
///
/// The length comes from [`crate::limits::MAX_ENDPOINT_ID`] rather than a
/// literal, because the commands bound the same field before it ever reaches
/// here and two numbers for one grammar is the drift this crate keeps
/// refusing to write.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= crate::limits::MAX_ENDPOINT_ID
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A base URL Paper will store and send the reader's key to.
///
/// HTTPS, and no credentials in the URL. `https://user:pass@host` is a key
/// smuggled into a field that is displayed, logged and persisted in plaintext
/// — refused here rather than discovered in a screenshot.
///
/// ⚠️ **`http://` ONLY TO THIS MACHINE**, since 2026-09-18: Ollama and LM Studio
/// serve an OpenAI-compatible API on `http://localhost:<port>/v1`, and a reader
/// who runs one is the reason to accept it — a local model Paper does not have
/// to ship. The host must be written as `localhost`, `127.0.0.1` or `[::1]`;
/// plain HTTP anywhere else would send the key across a network in the clear.
pub fn valid_base_url(url: &str) -> bool {
    /* ⚠️ A PREFIX CHECK IS NOT VALIDATION, which is what this was:
     * `starts_with("https://")` accepted `https://` on its own, a URL with a
     * space in it, one with a fragment, and one with no host at all. Each
     * reached lemond as a provider registration that cannot resolve, so it
     * surfaced as a route that failed when pressed rather than as a value
     * refused when it was typed. Found by audit. */
    let loopback_http = url.starts_with("http://");
    if !(url.starts_with("https://") || loopback_http)
        || url.len() > crate::limits::MAX_ENDPOINT_URL
    {
        return false;
    }
    /* No whitespace or control characters anywhere: they cannot appear in a
     * URL unescaped, and a header built from one would be split by them. */
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let rest = &url[url.find("://").map_or(0, |at| at + 3)..];
    /* No credentials, and no fragment — a base URL is a prefix Paper appends a
     * route to, and `#` would make everything after it part of the fragment. */
    if rest.contains('@') || rest.contains('#') {
        return false;
    }
    /* There has to BE a host. The authority is everything up to the first `/`
     * or `?`; an empty one is `https://` wearing a URL's clothes. */
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    if loopback_http {
        return is_loopback_authority(authority);
    }
    !authority.is_empty()
        && authority
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':')
        && authority.chars().any(|c| c.is_ascii_alphanumeric())
}

/// `localhost`, `127.0.0.1` or `[::1]`, with an optional port — the three
/// spellings of this machine that no DNS answer or hosts file can redirect
/// (`localhost` is resolved by the system resolver, which the RFC reserves to
/// the loopback). Nothing else earns `http://`.
fn is_loopback_authority(authority: &str) -> bool {
    /* The IPv6 literal carries colons of its own, so it is split off by its
    brackets; every other host ends at the first colon. */
    let (host, port) = match authority.strip_prefix("[::1]") {
        Some(port) => ("[::1]", port),
        None => authority.split_at(authority.find(':').unwrap_or(authority.len())),
    };
    let port_ok = port.is_empty()
        || port
            .strip_prefix(':')
            .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()));
    matches!(host, "localhost" | "127.0.0.1" | "[::1]") && port_ok
}

/// Whether a stored base URL addresses THIS MACHINE — which, for a URL
/// [`valid_base_url`] accepted, is exactly the `http://` ones.
pub fn is_loopback(base_url: &str) -> bool {
    base_url.starts_with("http://")
}

/// A model name as a provider spells it: `gpt-4.1-mini`, `qwen2.5:7b`,
/// `meta-llama/Llama-3.1-8B-Instruct`. Any printable characters, because
/// providers use `/`, `:`, `.` and `@`; no whitespace or control characters,
/// because the name goes into a JSON body and a stray newline in one is a paste
/// accident, not a model; and bounded by [`crate::limits::MAX_ENDPOINT_MODEL`].
pub fn valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= crate::limits::MAX_ENDPOINT_MODEL
        && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The endpoint list and the keychain behind it.
#[derive(Debug, Clone)]
pub struct EndpointStore {
    path: PathBuf,
    keychain: Arc<dyn Keychain>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    endpoints: Vec<StoredEndpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEndpoint {
    id: String,
    label: String,
    base_url: String,
    /// See [`Endpoint::model`]: absent in a list written before it existed.
    #[serde(default)]
    model: String,
}

impl EndpointStore {
    /// The store under a Paper-owned directory, over the OS keychain.
    pub fn new(base: &Path) -> EndpointStore {
        EndpointStore::with_keychain(base, Arc::new(OsKeychain))
    }

    /// The store over a keychain of the caller's choosing — a test's fake.
    ///
    /// `pub(crate)`: the OS keychain is the only one a shipped build uses, and
    /// this exists so the refusal arms can be exercised without one.
    pub(crate) fn with_keychain(base: &Path, keychain: Arc<dyn Keychain>) -> EndpointStore {
        EndpointStore {
            path: base.join(ENDPOINTS_FILE),
            keychain,
        }
    }

    fn read(&self) -> Result<Stored> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| {
                // Never treated as an empty list: that would silently drop
                // every endpoint the reader configured on one bad write.
                Error::ManifestMalformed(format!("{ENDPOINTS_FILE} is malformed: {e}"))
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Stored::default()),
            Err(err) => Err(Error::Io(err)),
        }
    }

    fn write(&self, stored: &Stored) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(stored)
            .map_err(|e| Error::ManifestMalformed(e.to_string()))?;
        // Write-then-rename: a crash mid-write must not leave a truncated
        // file that `read` would then refuse, locking the reader out of an
        // endpoint list they can no longer edit.
        let tmp = self.path.with_extension("json.part");
        /* ⚠️ **AND FSYNCED, WHICH IT WAS NOT.** `std::fs::write` returns once
         * the bytes are in the page cache, so a rename could reach the disk
         * ahead of the contents it publishes: power lost in that window leaves
         * a zero-length `endpoints.json`, which `read` refuses as
         * `ManifestMalformed` — and while keys were provisioned at every
         * start, that stopped the daemon for the LOCAL model too, until
         * somebody deleted the file by hand. The header two lines up says the
         * write-then-rename exists to stop exactly that lockout; without the
         * barrier it only stops the torn-write half of it.
         *
         * ⚠️ **A SECOND COPY OF `peer::store::write_atomic`, DELIBERATELY.**
         * That function does this correctly and is `pub` — within its own
         * crate. Reaching across would make `tauri-plugin-inference` depend on
         * `tauri-plugin-peer` for a filesystem primitive, which is a dependency
         * edge between two capabilities that otherwise share nothing; the app
         * crate's `atomic.rs` is equally out of reach, and one function is not
         * worth a fourth crate. Recorded so the next reader knows there are two
         * and which is the reference. */
        {
            use std::io::Write as _;
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
        }
        /* ONE RENAME, ON EVERY PLATFORM. This used to fall back to
         * remove-then-rename on Windows, on the belief that `rename` there
         * cannot replace an existing file — so every update after the first
         * would strand the `.part`. THE BELIEF IS WRONG about the call this
         * makes: `std::fs::rename` maps to `MoveFileEx` with
         * `MOVEFILE_REPLACE_EXISTING` (std's `sys/fs/windows.rs`), which is
         * exactly the atomic replace, and `role.rs` had already written that
         * down. What the fallback bought was nothing; what it cost was a
         * window with the old list unlinked and the new one not yet in
         * place, entered after ANY rename failure — a crash there loses
         * every endpoint the reader configured and orphans their keys in
         * the keychain. */
        if let Err(err) = std::fs::rename(&tmp, &self.path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err.into());
        }
        /* The rename is durable only once the DIRECTORY entry is — the same
         * second half `peer::store::write_atomic` documents. `if let`, so a
         * platform that cannot open a directory as a file (Windows) still has
         * the atomic rename; a sync that was attempted and failed is a
         * different fact and is reported. */
        if let Some(parent) = self.path.parent() {
            if let Ok(handle) = std::fs::File::open(parent) {
                handle.sync_all()?;
            }
        }
        Ok(())
    }

    /// Every endpoint, each saying whether a key is stored for it — or that
    /// the keychain would not say.
    pub fn list(&self) -> Result<Vec<Endpoint>> {
        let stored = self.read()?;
        Ok(stored
            .endpoints
            .into_iter()
            .map(|e| Endpoint {
                key_state: self.key_state(&e.id),
                id: e.id,
                label: e.label,
                base_url: e.base_url,
                model: e.model,
            })
            .collect())
    }

    /// The keychain's answer for one endpoint, as the three states.
    ///
    /// The refusal is logged HERE, once per read, because this is the only
    /// place that turns it into a state — a caller of `list` sees
    /// [`KeyState::Unreadable`] and nothing about why.
    fn key_state(&self, id: &str) -> KeyState {
        match self.key(id) {
            Ok(Some(_)) => KeyState::Set,
            Ok(None) => KeyState::Missing,
            Err(refused) => {
                log::warn!(
                    "inference: the keychain would not read the key for endpoint {id}: {refused}"
                );
                KeyState::Unreadable
            }
        }
    }

    /// Register an endpoint, or replace one with the same id.
    pub fn add(&self, id: &str, label: &str, base_url: &str, model: &str) -> Result<()> {
        if !valid_id(id) {
            return Err(Error::ModelUnknown(id.to_owned()));
        }
        if !valid_base_url(base_url) {
            return Err(Error::ManifestMalformed(format!(
                "{base_url:?} must be an https URL (or http to this machine) without embedded credentials"
            )));
        }
        if !valid_model_name(model) {
            return Err(Error::ManifestMalformed(format!(
                "{model:?} is not a model name"
            )));
        }
        let mut stored = self.read()?;
        stored.endpoints.retain(|e| e.id != id);
        stored.endpoints.push(StoredEndpoint {
            id: id.to_owned(),
            label: label.to_owned(),
            base_url: base_url.to_owned(),
            model: model.to_owned(),
        });
        self.write(&stored)
    }

    /// Forget an endpoint AND its key.
    ///
    /// Both, always. An endpoint removed from the list while its key stayed
    /// in the keychain is a credential the reader believes they deleted.
    pub fn remove(&self, id: &str) -> Result<()> {
        let mut stored = self.read()?;
        stored.endpoints.retain(|e| e.id != id);
        self.write(&stored)?;
        self.clear_key(id)
    }

    /// Store a key. WRITE-ONLY: nothing reachable from a command reads it
    /// back — see the module header.
    pub fn set_key(&self, id: &str, key: &str) -> Result<()> {
        if !valid_id(id) {
            return Err(Error::ModelUnknown(id.to_owned()));
        }
        /* AN EMPTY KEY IS A CLEAR, not a credential. Stored, it made `list`
         * report `hasKey: true` while `keys_for_spawn` silently omitted it —
         * a row saying "configured" over a route that could never
         * authenticate. One meaning, in one place. */
        if key.is_empty() {
            return self.clear_key(id);
        }
        /* THE ROW MUST EXIST. A key written for an id no row carries is an
         * orphaned keychain credential: `list` cannot show it, the pane
         * cannot remove it, and nothing ever spawns with it. Refused by the
         * same sentence an unknown model gets, naming the id. */
        if !self.read()?.endpoints.iter().any(|one| one.id == id) {
            return Err(Error::ModelUnknown(id.to_owned()));
        }
        self.keychain.write(id, key)
    }

    /// Remove a key. Absent is success — deleting what is not there is the
    /// outcome asked for.
    pub fn clear_key(&self, id: &str) -> Result<()> {
        self.keychain.delete(id)
    }

    /// One key, for THIS PROCESS only — the request a lookup sends to the
    /// endpoint (`cloud.rs`) and nothing else. An empty key reads as absent:
    /// `set_key("")` is a clear, and an empty key would authenticate as nobody
    /// and be harder to diagnose than a missing one.
    ///
    /// `pub(crate)` on purpose: no command may return this, and the module
    /// boundary is what enforces it — there is still no command that reads a
    /// key back (see the module header).
    pub(crate) fn key(&self, id: &str) -> Result<Option<String>> {
        Ok(self.keychain.read(id)?.filter(|key| !key.is_empty()))
    }
}

#[cfg(test)]
mod tests {
    /// A store over a keychain that is NOT THE DEVELOPER'S.
    ///
    /// ⚠️ Ten tests here called [`EndpointStore::new`], which is the OS
    /// keychain under Paper's own service name — and every one of them uses
    /// the account `proxy`, the obvious id for a reader to give a real
    /// endpoint. So the suite read whatever was configured on the machine it
    /// ran on (`an_endpoint_without_a_key_is_not_provisioned` fails outright
    /// where a `proxy` key exists), raised access prompts on macOS after
    /// every rebuild, and — through `remove` — DELETED a live credential.
    /// A test may not depend on the machine's secrets, and it certainly may
    /// not destroy them. `FakeKeychain` is the store's own seam for this;
    /// `OsKeychain` belongs to the shipped build alone.
    fn fake_store(dir: &crate::testutil::ScratchDir) -> EndpointStore {
        EndpointStore::with_keychain(
            dir.path(),
            std::sync::Arc::new(crate::testutil::FakeKeychain::default()),
        )
    }

    /// ⚠️ **ONE CORPUS, TWO VALIDATORS.** `endpointsModel.ts` refuses the same
    /// things in the reader's own words, beside the field, so a bad address is
    /// not a round trip and an error naming nothing they can act on. Two
    /// implementations of one rule is the shape that drifts, and neither side
    /// can see the other — so both read `fixtures/endpoint-validation.json`
    /// and assert their own answer against it. A rule changed on one side
    /// alone turns this red, or its twin.
    #[test]
    fn the_shared_corpus_says_what_this_accepts() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/endpoint-validation.json"))
                .expect("the shared corpus parses");

        let cases = |group: &str, key: &str| -> Vec<String> {
            corpus[group][key]
                .as_array()
                .unwrap_or_else(|| panic!("{group}.{key} is a list"))
                .iter()
                .map(|one| one.as_str().expect("a string").to_owned())
                .collect()
        };

        /* NON-EMPTY, so a corpus that failed to parse into the shape this
        reads cannot pass by comparing nothing. */
        for (group, key) in [
            ("ids", "valid"),
            ("ids", "invalid"),
            ("baseUrls", "valid"),
            ("baseUrls", "invalid"),
            ("models", "valid"),
            ("models", "invalid"),
        ] {
            assert!(!cases(group, key).is_empty(), "{group}.{key} is empty");
        }
        for name in cases("models", "valid") {
            assert!(
                valid_model_name(&name),
                "the corpus calls {name:?} a model name"
            );
        }
        for name in cases("models", "invalid") {
            assert!(
                !valid_model_name(&name),
                "the corpus refuses {name:?} as a model name"
            );
        }

        for id in cases("ids", "valid") {
            assert!(valid_id(&id), "the corpus calls {id:?} a valid name");
        }
        for id in cases("ids", "invalid") {
            assert!(!valid_id(&id), "the corpus calls {id:?} an invalid name");
        }
        for url in cases("baseUrls", "valid") {
            assert!(
                valid_base_url(&url),
                "the corpus calls {url:?} a valid address"
            );
        }
        for url in cases("baseUrls", "invalid") {
            assert!(
                !valid_base_url(&url),
                "the corpus calls {url:?} an invalid address"
            );
        }
    }

    use super::*;

    #[test]
    fn a_provider_id_is_a_closed_alphabet() {
        for good in ["openai", "my-proxy", "x1"] {
            assert!(valid_id(good), "{good}");
        }
        for bad in ["", "Open AI", "OPENAI", "a/b", "a_b", &"x".repeat(41)] {
            assert!(!valid_id(bad), "{bad:?} should be refused");
        }
    }

    /// A key smuggled into the URL would be displayed, logged and persisted
    /// in plaintext — the exact thing the keychain exists to prevent.
    #[test]
    fn a_url_with_embedded_credentials_is_refused() {
        assert!(valid_base_url("https://api.example.com/v1"));
        assert!(!valid_base_url("https://user:secret@api.example.com/v1"));
        assert!(!valid_base_url("http://api.example.com/v1"));
        assert!(!valid_base_url("ftp://api.example.com"));
        assert!(!valid_base_url(""));
    }

    /// A prefix check is not validation. Each of these passed the old
    /// `starts_with("https://")` test, and would reach a provider as a request
    /// that cannot resolve.
    #[test]
    fn a_url_that_is_only_a_scheme_is_refused() {
        for bad in [
            "https://",
            "https:// spaces.example.com",
            "https://example.com#frag",
            "https://?q=1",
            "https://\nexample.com",
        ] {
            assert!(!valid_base_url(bad), "{bad:?} should be refused");
        }
        for good in [
            "https://api.example.com/v1",
            "https://localhost:8443/v1",
            "https://api.example.com",
        ] {
            assert!(valid_base_url(good), "{good:?} should be accepted");
        }
    }

    /// An empty key is a CLEAR. Stored, it made `list` report a key over a
    /// route that could never authenticate.
    #[test]
    fn an_empty_key_clears_rather_than_storing() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let keychain = crate::testutil::FakeKeychain::default().with_key("proxy", "sk-old");
        let store = EndpointStore::with_keychain(dir.path(), std::sync::Arc::new(keychain));
        store
            .add("proxy", "P", "https://a.example.com/v1", "gpt-4.1-mini")
            .unwrap();
        store.set_key("proxy", "").unwrap();
        assert_eq!(store.list().unwrap()[0].key_state, KeyState::Missing);
    }

    #[test]
    fn an_absent_file_is_an_empty_list_not_an_error() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = fake_store(&dir);
        assert_eq!(store.list().unwrap(), Vec::new());
    }

    #[test]
    fn a_malformed_file_is_refused_rather_than_read_as_empty() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        std::fs::write(dir.path().join(ENDPOINTS_FILE), "{ not json").unwrap();
        let store = fake_store(&dir);
        let err = store.list().unwrap_err();
        assert_eq!(err.kind(), "manifestMalformed");
    }

    #[test]
    fn endpoints_round_trip_without_carrying_a_key_field() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = fake_store(&dir);
        store
            .add(
                "proxy",
                "My proxy",
                "https://api.example.com/v1",
                "gpt-4.1-mini",
            )
            .unwrap();

        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "proxy");
        assert_eq!(listed[0].base_url, "https://api.example.com/v1");

        // The persisted file has no place to put a key even if someone tried.
        let raw = std::fs::read_to_string(dir.path().join(ENDPOINTS_FILE)).unwrap();
        assert!(
            !raw.contains("key"),
            "the endpoint file must hold no secret"
        );
    }

    #[test]
    fn adding_the_same_id_twice_replaces_rather_than_duplicates() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = fake_store(&dir);
        store
            .add("proxy", "First", "https://a.example.com/v1", "gpt-4.1-mini")
            .unwrap();
        store
            .add(
                "proxy",
                "Second",
                "https://b.example.com/v1",
                "gpt-4.1-mini",
            )
            .unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "Second");
        assert_eq!(listed[0].base_url, "https://b.example.com/v1");
    }

    #[test]
    fn a_bad_id_or_url_is_refused_at_add() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = fake_store(&dir);
        assert!(store
            .add("Bad Id", "x", "https://a.example.com", "gpt-4.1-mini")
            .is_err());
        assert!(store
            .add("ok", "x", "http://a.example.com", "gpt-4.1-mini")
            .is_err());
        assert!(
            store
                .add("ok", "x", "https://a.example.com", "gpt 4")
                .is_err(),
            "a model name with a space in it is a paste accident"
        );
        assert_eq!(store.list().unwrap().len(), 0, "nothing was written");
        store
            .add("local", "Ollama", "http://localhost:11434/v1", "qwen2.5:7b")
            .expect("http to this machine is an endpoint Paper need not ship");
        assert_eq!(store.list().unwrap()[0].model, "qwen2.5:7b");
    }

    /// The IPC shape carries a key STATE, never a key.
    #[test]
    fn the_ipc_shape_carries_only_whether_a_key_exists() {
        let endpoint = Endpoint {
            id: "proxy".to_owned(),
            label: "My proxy".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            model: "gpt-4.1-mini".to_owned(),
            key_state: KeyState::Set,
        };
        let json = serde_json::to_value(&endpoint).unwrap();
        assert_eq!(json["keyState"], "set");
        assert_eq!(
            json["model"], "gpt-4.1-mini",
            "the model name is not a secret, and the pane shows it"
        );
        let rendered = json.to_string();
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("apiKey"));
        // Structurally: the struct has exactly five fields and none is a key.
        assert_eq!(json.as_object().unwrap().len(), 5);
        /* The three states are three distinct words on the wire, so the
         * TypeScript side cannot read one as another. */
        let tags: std::collections::BTreeSet<String> =
            [KeyState::Set, KeyState::Missing, KeyState::Unreadable]
                .iter()
                .map(|state| {
                    serde_json::to_value(state)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned()
                })
                .collect();
        assert_eq!(tags.len(), 3);
    }

    /// Removing an endpoint clears its key too — an endpoint gone from the
    /// list while its key stayed is a credential the reader thinks they
    /// deleted.
    #[test]
    fn removing_an_endpoint_also_clears_its_key() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let keychain = crate::testutil::FakeKeychain::default().with_key("proxy", "sk-1");
        let store = EndpointStore::with_keychain(dir.path(), std::sync::Arc::new(keychain));
        store
            .add(
                "proxy",
                "My proxy",
                "https://a.example.com/v1",
                "gpt-4.1-mini",
            )
            .unwrap();
        assert_eq!(store.key_state("proxy"), KeyState::Set);
        store.remove("proxy").unwrap();
        assert_eq!(store.list().unwrap().len(), 0);
        assert_eq!(
            store.key_state("proxy"),
            KeyState::Missing,
            "the key went with the row"
        );
    }

    /// `remove` on an unkeyed id is still clean: `clear_key` treats absent as
    /// success, on the real keychain as on the fake.
    #[test]
    fn removing_an_unkeyed_endpoint_is_not_an_error() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = fake_store(&dir);
        store
            .add(
                "proxy",
                "My proxy",
                "https://a.example.com/v1",
                "gpt-4.1-mini",
            )
            .unwrap();
        store.remove("proxy").unwrap();
        assert_eq!(store.list().unwrap().len(), 0);
    }

    /// A store over the fake keychain: `keyed` has a key, `bare` has none,
    /// and `denied` is an endpoint whose key the keychain refuses to read —
    /// the macOS "Deny", or a rebuilt binary the entry's ACL no longer trusts.
    fn store_with_one_refusal(dir: &crate::testutil::ScratchDir) -> EndpointStore {
        let keychain = crate::testutil::FakeKeychain::default()
            .with_key("keyed", "sk-keyed")
            .with_key("denied", "sk-denied")
            .refusing(&["denied"]);
        let store = EndpointStore::with_keychain(dir.path(), std::sync::Arc::new(keychain));
        store
            .add("keyed", "K", "https://k.example.com/v1", "gpt-4.1-mini")
            .unwrap();
        store
            .add("bare", "B", "https://b.example.com/v1", "gpt-4.1-mini")
            .unwrap();
        store
            .add("denied", "D", "https://d.example.com/v1", "gpt-4.1-mini")
            .unwrap();
        store
    }

    /// WI-20.20 (b). The keychain has THREE answers and the row used to show
    /// two: a refusal was folded into `hasKey: false`, so the pane told a
    /// reader whose key was sitting in the keychain to go and add one.
    #[test]
    fn a_key_the_keychain_will_not_read_is_unreadable_rather_than_missing() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = store_with_one_refusal(&dir);
        let state_of = |id: &str| {
            store
                .list()
                .unwrap()
                .into_iter()
                .find(|e| e.id == id)
                .unwrap_or_else(|| panic!("{id} is listed"))
                .key_state
        };
        assert_eq!(state_of("keyed"), KeyState::Set);
        assert_eq!(state_of("bare"), KeyState::Missing);
        assert_eq!(state_of("denied"), KeyState::Unreadable);
    }

    /// WI-20.20 (d), the store's half. The row is gone from the list whether
    /// or not the keychain let the key go, and the refusal is reported rather
    /// than swallowed — a key the reader believes deleted and cannot see is
    /// the one thing worse than one they can.
    #[test]
    fn a_removal_the_keychain_refuses_still_drops_the_row_and_says_so() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = store_with_one_refusal(&dir);
        let err = store.remove("denied").unwrap_err();
        assert_eq!(err.kind(), "keychain");
        assert!(
            store.list().unwrap().iter().all(|e| e.id != "denied"),
            "the row must go even when the key will not"
        );
    }

    /// A half-written file must not lock the reader out of their own list.
    #[test]
    fn a_write_leaves_no_partial_file_behind() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = fake_store(&dir);
        store
            .add(
                "proxy",
                "My proxy",
                "https://a.example.com/v1",
                "gpt-4.1-mini",
            )
            .unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty(), "a .part survived: {leftovers:?}");
    }
}
