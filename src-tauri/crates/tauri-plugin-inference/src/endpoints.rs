//! Cloud endpoints, and the keys that are never read back.
//!
//! WI-15.8. F1 settles the shape: Lemonade already **is** the API-key gateway
//! — `POST /v1/install` registers an OpenAI-compatible cloud provider by
//! `base_url`, and `collection.router` routes one request across local and
//! cloud backends. So Paper writes no OpenAI client. Local models and every
//! API-key route are one surface, one credential path, one adapter.
//!
//! # Why the key goes in the child's environment and not through the API
//!
//! `LEMONADE_<PROVIDER>_API_KEY` takes **precedence over runtime keys**. That
//! is a security primitive rather than a convenience: because the environment
//! outranks anything set at runtime, a key Paper provisioned at spawn cannot
//! be overridden by a later call to `/v1/cloud/auth`. So Paper provisions in
//! the environment and **never exposes `/v1/cloud/auth` to the webview**.
//! There is no command for it in `build.rs`, and that absence is the
//! mechanism — book HTML cannot reach a route that does not exist.
//!
//! # Why this is real work rather than a config line
//!
//! Lemonade holds cloud keys **in memory only**, so they are gone the moment
//! the daemon restarts and Paper must re-provision on every start. That means
//! a durable store, and the only honest durable store for a credential is the
//! OS keychain — not a file in the data root, which syncs, backs up and reads
//! as plaintext to anything with the reader's disk.
//!
//! # Write-only, structurally
//!
//! [`EndpointStore::set_key`] exists. There is **no `get_key` reachable from
//! a command**: the reader's key is written to the keychain and read back
//! only by [`EndpointStore::provisioning`], inside this process, on the path
//! to a child's environment. `build.rs` has `inference_set_endpoint_key` and
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
//! Now it is [`KeyState::Unreadable`] on the row and a skipped, named endpoint
//! in [`Provisioning`], and the daemon starts.

use std::collections::{BTreeMap, BTreeSet};
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

/// One registered OpenAI-compatible provider.
///
/// **No key field.** The key lives in the keychain under [`Endpoint::id`],
/// and this struct is what crosses IPC — so there is nothing here for a
/// serializer, a log line or a diagnostics bundle to spill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// The provider id. Also the keychain account name and the
    /// `LEMONADE_<ID>_API_KEY` stem, so it is a closed alphabet.
    pub id: String,
    /// What the settings row calls it.
    pub label: String,
    /// The OpenAI-compatible base URL. HTTPS only.
    pub base_url: String,
    /// Whether a key is stored, and whether that could be found out. A STATE,
    /// never the key.
    #[serde(default)]
    pub key_state: KeyState,
}

/// A provider id: `[a-z0-9-]`, so it is safe as an environment-variable stem
/// and as a keychain account.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A base URL Paper will hand the daemon.
///
/// HTTPS only, and no credentials in the URL. `https://user:pass@host` is a
/// key smuggled into a field that is displayed, logged and persisted in
/// plaintext — refused here rather than discovered in a screenshot.
pub fn valid_base_url(url: &str) -> bool {
    /* ⚠️ A PREFIX CHECK IS NOT VALIDATION, which is what this was:
     * `starts_with("https://")` accepted `https://` on its own, a URL with a
     * space in it, one with a fragment, and one with no host at all. Each
     * reaches the daemon as a provider registration that cannot resolve, so it
     * surfaces as a route that fails when pressed rather than as a value
     * refused when it was typed. Found by audit. */
    if !url.starts_with("https://") || url.len() > 400 {
        return false;
    }
    /* No whitespace or control characters anywhere: they cannot appear in a
     * URL unescaped, and a header built from one would be split by them. */
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let rest = &url["https://".len()..];
    /* No credentials, and no fragment — a base URL is a prefix Paper appends a
     * route to, and `#` would make everything after it part of the fragment. */
    if rest.contains('@') || rest.contains('#') {
        return false;
    }
    /* There has to BE a host. The authority is everything up to the first `/`
     * or `?`; an empty one is `https://` wearing a URL's clothes. */
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    !authority.is_empty()
        && authority
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':')
        && authority.chars().any(|c| c.is_ascii_alphanumeric())
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
        std::fs::write(&tmp, text)?;
        /* Windows cannot `rename` over an existing file, so every update
         * AFTER the first would fail there and strand the `.part`. The
         * remove-then-rename fallback is not atomic — a crash between the
         * two loses the old list — but the store's writes are serialised by
         * the command layer's mutex and a second Paper by the data-root
         * lock, and a lost list is re-creatable; a store that can never be
         * updated is not. Unix stays on the atomic rename. */
        match std::fs::rename(&tmp, &self.path) {
            Ok(()) => Ok(()),
            Err(_) if cfg!(windows) && self.path.exists() => {
                std::fs::remove_file(&self.path)?;
                std::fs::rename(&tmp, &self.path)?;
                Ok(())
            }
            Err(err) => Err(err.into()),
        }
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
    pub fn add(&self, id: &str, label: &str, base_url: &str) -> Result<()> {
        if !valid_id(id) {
            return Err(Error::ModelUnknown(id.to_owned()));
        }
        if !valid_base_url(base_url) {
            return Err(Error::ManifestMalformed(format!(
                "{base_url:?} must be an https URL without embedded credentials"
            )));
        }
        let mut stored = self.read()?;
        stored.endpoints.retain(|e| e.id != id);
        stored.endpoints.push(StoredEndpoint {
            id: id.to_owned(),
            label: label.to_owned(),
            base_url: base_url.to_owned(),
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

    /// One key, for this process only. An empty key reads as absent:
    /// `set_key("")` is a clear, and an empty `LEMONADE_X_API_KEY` still
    /// outranks a runtime key, so it would authenticate as nobody and be
    /// harder to diagnose than a missing variable.
    ///
    /// `pub(crate)` on purpose: no command may call this, and the module
    /// boundary is what enforces it.
    pub(crate) fn key(&self, id: &str) -> Result<Option<String>> {
        Ok(self.keychain.read(id)?.filter(|key| !key.is_empty()))
    }

    /// Everything a daemon start takes from the store — the ONE place keys
    /// are read — with the keychain's refusals kept per endpoint.
    ///
    /// A refusal for one endpoint skips THAT endpoint: it is neither
    /// provisioned nor registered, and it is named in `unreadable` so the
    /// start can say so. It is not an error, because the daemon a local model
    /// needs has nothing to do with the keychain (see the module header). The
    /// list failing to read is still an error: that is every endpoint, not
    /// one.
    pub(crate) fn provisioning(&self) -> Result<Provisioning> {
        let mut out = Provisioning::default();
        for endpoint in self.read()?.endpoints {
            match self.key(&endpoint.id) {
                Ok(Some(key)) => {
                    out.keys.insert(endpoint.id.clone(), key);
                    out.registrations.push(Registration {
                        backend: CLOUD_BACKEND,
                        provider: endpoint.id,
                        base_url: endpoint.base_url,
                    });
                }
                /* No key: omitted from both, rather than provisioned empty or
                 * registered as a provider that cannot authenticate. */
                Ok(None) => {}
                /* Refused: this endpoint's problem, and this endpoint's only.
                 * It is a WARNING because it is one — the endpoint stays
                 * listed, unusable, saying why — and it is not the `?` that
                 * used to take the whole start down with it. */
                Err(refused) => {
                    log::warn!(
                        "inference: the keychain would not read the key for endpoint {}; \
                         skipping it: {refused}",
                        endpoint.id
                    );
                    out.unreadable.insert(endpoint.id);
                }
            }
        }
        Ok(out)
    }
}

/// What a daemon start takes from the store. See
/// [`EndpointStore::provisioning`].
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Provisioning {
    /// Every key, by provider id, for the child's environment.
    pub keys: BTreeMap<String, String>,
    /// Every keyed endpoint, as a daemon registration.
    pub registrations: Vec<Registration>,
    /// The endpoints whose key the keychain would not read. Not provisioned,
    /// not registered, and named — so the start can log them and the probe
    /// can refuse to offer them.
    pub unreadable: BTreeSet<String>,
}

/// What `POST /v1/install` needs to register an OpenAI-compatible provider.
///
/// F1's other half, and **it was missing**: the store persisted an endpoint
/// and the spawn provisioned its key, but nothing ever told the daemon the
/// provider existed — so an endpoint route could be selected, would be listed
/// as usable, and could never answer. An audit caught it.
///
/// The key is NOT in this payload and must never be: `LEMONADE_<ID>_API_KEY`
/// is provisioned in the child's environment at spawn, where it outranks any
/// runtime key, and that precedence is the whole reason `/v1/cloud/auth` is
/// not exposed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Registration {
    /// ⚠️ **THE LITERAL STRING `"cloud"`, AND IT IS REQUIRED.**
    /// `POST /v1/install` is dispatched BY THIS FIELD: the spec says "any
    /// value other than `\"cloud\"` is treated as a local backend install".
    /// Omitting it — which the first version of this struct did — makes the
    /// daemon read a provider registration as a request to install a local
    /// backend named by a missing recipe, reject it, and leave the endpoint
    /// route listed and unable to answer. An audit caught it.
    pub backend: &'static str,
    pub provider: String,
    pub base_url: String,
}

/// The one value [`Registration::backend`] may hold.
pub const CLOUD_BACKEND: &str = "cloud";

#[cfg(test)]
mod tests {
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
        ] {
            assert!(!cases(group, key).is_empty(), "{group}.{key} is empty");
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
    /// `starts_with("https://")` test and reaches the daemon as a provider
    /// registration that cannot resolve.
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

    /// An empty key is a CLEAR. Stored, it made `list` report a key while the
    /// spawn omitted it — a row saying "configured" over a route that could
    /// never authenticate.
    #[test]
    fn an_empty_key_clears_rather_than_storing() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let keychain = crate::testutil::FakeKeychain::default().with_key("proxy", "sk-old");
        let store = EndpointStore::with_keychain(dir.path(), std::sync::Arc::new(keychain));
        store.add("proxy", "P", "https://a.example.com/v1").unwrap();
        store.set_key("proxy", "").unwrap();
        let provisioning = store.provisioning().unwrap();
        assert!(!provisioning.keys.contains_key("proxy"));
        assert!(provisioning.registrations.is_empty());
        assert_eq!(store.list().unwrap()[0].key_state, KeyState::Missing);
    }

    /// F1's other half: an endpoint with a key becomes a daemon registration,
    /// and the KEY IS NOT IN IT — it rides the child's environment, where it
    /// outranks any runtime key.
    #[test]
    fn a_registration_carries_the_base_url_and_never_the_key() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = EndpointStore::new(dir.path());
        store.add("proxy", "P", "https://a.example.com/v1").unwrap();
        /* No key stored, so nothing to register: a provider that cannot
         * authenticate would be offered by the router and fail. */
        assert!(store.provisioning().unwrap().registrations.is_empty());

        let registration = Registration {
            backend: CLOUD_BACKEND,
            provider: "proxy".to_owned(),
            base_url: "https://a.example.com/v1".to_owned(),
        };
        let json = serde_json::to_value(&registration).unwrap();
        /* The dispatch field. Without it the daemon reads this as a LOCAL
         * backend install and rejects it — the route then lists as usable and
         * never answers. */
        assert_eq!(json["backend"], "cloud");
        assert_eq!(json["provider"], "proxy");
        assert_eq!(json["base_url"], "https://a.example.com/v1");
        assert_eq!(
            json.as_object().unwrap().len(),
            3,
            "a registration has exactly three fields and none is a key"
        );
    }

    #[test]
    fn an_absent_file_is_an_empty_list_not_an_error() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = EndpointStore::new(dir.path());
        assert_eq!(store.list().unwrap(), Vec::new());
    }

    #[test]
    fn a_malformed_file_is_refused_rather_than_read_as_empty() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        std::fs::write(dir.path().join(ENDPOINTS_FILE), "{ not json").unwrap();
        let store = EndpointStore::new(dir.path());
        let err = store.list().unwrap_err();
        assert_eq!(err.kind(), "manifestMalformed");
    }

    #[test]
    fn endpoints_round_trip_without_carrying_a_key_field() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = EndpointStore::new(dir.path());
        store
            .add("proxy", "My proxy", "https://api.example.com/v1")
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
        let store = EndpointStore::new(dir.path());
        store
            .add("proxy", "First", "https://a.example.com/v1")
            .unwrap();
        store
            .add("proxy", "Second", "https://b.example.com/v1")
            .unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "Second");
        assert_eq!(listed[0].base_url, "https://b.example.com/v1");
    }

    #[test]
    fn a_bad_id_or_url_is_refused_at_add() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = EndpointStore::new(dir.path());
        assert!(store.add("Bad Id", "x", "https://a.example.com").is_err());
        assert!(store.add("ok", "x", "http://a.example.com").is_err());
        assert_eq!(store.list().unwrap().len(), 0, "nothing was written");
    }

    /// The IPC shape carries a key STATE, never a key.
    #[test]
    fn the_ipc_shape_carries_only_whether_a_key_exists() {
        let endpoint = Endpoint {
            id: "proxy".to_owned(),
            label: "My proxy".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            key_state: KeyState::Set,
        };
        let json = serde_json::to_value(&endpoint).unwrap();
        assert_eq!(json["keyState"], "set");
        let rendered = json.to_string();
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("apiKey"));
        // Structurally: the struct has exactly four fields and none is a key.
        assert_eq!(json.as_object().unwrap().len(), 4);
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

    /// A stored endpoint with no key is omitted from the spawn environment
    /// rather than provisioned empty — an empty value still outranks a
    /// runtime key (F1) and would authenticate as nobody.
    #[test]
    fn an_endpoint_without_a_key_is_not_provisioned() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = EndpointStore::new(dir.path());
        store
            .add("proxy", "My proxy", "https://a.example.com/v1")
            .unwrap();
        // No key set for it.
        let keys = store.provisioning().unwrap().keys;
        assert!(
            !keys.contains_key("proxy"),
            "an unkeyed endpoint must not become an empty env var"
        );
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
            .add("proxy", "My proxy", "https://a.example.com/v1")
            .unwrap();
        assert!(store.provisioning().unwrap().keys.contains_key("proxy"));
        store.remove("proxy").unwrap();
        assert_eq!(store.list().unwrap().len(), 0);
        assert!(!store.provisioning().unwrap().keys.contains_key("proxy"));
    }

    /// `remove` on an unkeyed id is still clean: `clear_key` treats absent as
    /// success, on the real keychain as on the fake.
    #[test]
    fn removing_an_unkeyed_endpoint_is_not_an_error() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = EndpointStore::new(dir.path());
        store
            .add("proxy", "My proxy", "https://a.example.com/v1")
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
        store.add("keyed", "K", "https://k.example.com/v1").unwrap();
        store.add("bare", "B", "https://b.example.com/v1").unwrap();
        store
            .add("denied", "D", "https://d.example.com/v1")
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

    /// WI-20.20 (a). One endpoint the keychain will not answer for must not
    /// stop the daemon: it is skipped, named, and the rest are provisioned.
    #[test]
    fn provisioning_skips_the_unreadable_endpoint_and_keeps_the_rest() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let store = store_with_one_refusal(&dir);
        let provisioning = store.provisioning().unwrap();
        assert_eq!(
            provisioning.keys,
            BTreeMap::from([("keyed".to_owned(), "sk-keyed".to_owned())])
        );
        assert_eq!(
            provisioning
                .registrations
                .iter()
                .map(|r| r.provider.as_str())
                .collect::<Vec<_>>(),
            ["keyed"]
        );
        assert_eq!(
            provisioning.unreadable,
            std::collections::BTreeSet::from(["denied".to_owned()]),
            "the refused endpoint is named, so the start can say so"
        );
        /* A keyless endpoint is neither refused nor provisioned: it is the
         * ordinary case the header describes, and it stays that way. */
        assert!(!provisioning.unreadable.contains("bare"));
    }

    /// The daemon still starts when EVERY key is unreadable — an empty
    /// provisioning, not an error. A local model has nothing to do with the
    /// keychain and must keep working through a keychain that has locked
    /// Paper out entirely.
    #[test]
    fn provisioning_succeeds_with_nothing_when_every_key_is_unreadable() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        let keychain = crate::testutil::FakeKeychain::default().refusing(&["a", "b"]);
        let store = EndpointStore::with_keychain(dir.path(), std::sync::Arc::new(keychain));
        store.add("a", "A", "https://a.example.com/v1").unwrap();
        store.add("b", "B", "https://b.example.com/v1").unwrap();
        let provisioning = store.provisioning().unwrap();
        assert!(provisioning.keys.is_empty());
        assert!(provisioning.registrations.is_empty());
        assert_eq!(provisioning.unreadable.len(), 2);
    }

    /// The LIST failing is still a failure: a malformed file is not a keychain
    /// refusal, and reading it as "no endpoints" would silently drop every
    /// endpoint the reader configured.
    #[test]
    fn provisioning_still_refuses_a_malformed_list() {
        let dir = crate::testutil::ScratchDir::new("endpoints");
        std::fs::write(dir.path().join(ENDPOINTS_FILE), "{ not json").unwrap();
        let store = EndpointStore::new(dir.path());
        assert_eq!(
            store.provisioning().unwrap_err().kind(),
            "manifestMalformed"
        );
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
        let store = EndpointStore::new(dir.path());
        store
            .add("proxy", "My proxy", "https://a.example.com/v1")
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
