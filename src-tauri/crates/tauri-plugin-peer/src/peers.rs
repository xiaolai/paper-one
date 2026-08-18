//! The paired devices: `<root>/peer/peers.json`, one record per peer with its
//! role and grants. This is the allow-list `peer/1` accepts against and the
//! grant table the TypeScript envelope router consults before dispatch.
//!
//! Writes go to a temp sibling and are renamed into place, so a crash leaves
//! the previous file intact. A file that does not parse is a typed error,
//! never an empty list: an empty list would silently drop every pairing.
//!
//! Grants are opaque strings to the plugin (`sync:push`, `blob:read`, …) with
//! one rule: `<prefix>:*` covers every grant under that prefix. What a grant
//! means is the app's business.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::identity::PEER_DIR;
use crate::role::Role;

const PEERS_FILE: &str = "peers.json";
const FORMAT: u32 = 1;

/// One paired device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    /// The iroh endpoint id, in its 64-hex text form.
    pub id: String,
    /// The name the device gave itself when pairing.
    pub name: String,
    /// `macos`, `ios`, `android`, `windows`, `linux` — `std::env::consts::OS`
    /// on the device that paired.
    pub platform: String,
    pub role: Role,
    pub grants: Vec<String>,
    /// Unix milliseconds.
    pub paired_at: u64,
    /// Unix milliseconds.
    pub last_seen_at: u64,
    /// Address hints for the next dial: `ip:port` strings and relay URLs.
    pub last_addrs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileFormat {
    version: u32,
    peers: Vec<PeerRecord>,
}

/// The store: the file path and its in-memory contents. Every mutating
/// method persists before returning.
#[derive(Debug)]
pub struct PeerStore {
    path: PathBuf,
    peers: BTreeMap<String, PeerRecord>,
}

/// `<root>/peer/peers.json`.
pub fn peers_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(PEERS_FILE)
}

/// Unix milliseconds now.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Does `granted` cover `wanted`? Exact match, or `granted` is `<prefix>:*`
/// and `wanted` starts with `<prefix>:`.
pub fn grant_covers(granted: &str, wanted: &str) -> bool {
    if granted == wanted {
        return true;
    }
    match granted.strip_suffix(":*") {
        Some(prefix) if !prefix.is_empty() => wanted
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with(':')),
        _ => false,
    }
}

impl PeerStore {
    /// Load `<root>/peer/peers.json`; a missing file is an empty store.
    pub fn load(root: &Path) -> Result<Self> {
        let path = peers_path(root);
        let peers = match std::fs::read(&path) {
            Ok(bytes) => {
                let file: FileFormat =
                    serde_json::from_slice(&bytes).map_err(|source| Error::PeersMalformed {
                        path: path.clone(),
                        source,
                    })?;
                file.peers.into_iter().map(|p| (p.id.clone(), p)).collect()
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(err) => return Err(err.into()),
        };
        Ok(Self { path, peers })
    }

    pub fn list(&self) -> Vec<PeerRecord> {
        self.peers.values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<&PeerRecord> {
        self.peers.get(id)
    }

    /// Insert or replace, then persist.
    pub fn insert(&mut self, record: PeerRecord) -> Result<()> {
        self.peers.insert(record.id.clone(), record);
        self.save()
    }

    /// Remove and persist. Unknown id is an error, so a forget that did
    /// nothing is visible.
    pub fn remove(&mut self, id: &str) -> Result<PeerRecord> {
        let removed = self
            .peers
            .remove(id)
            .ok_or_else(|| Error::PeerUnknown(id.to_owned()))?;
        self.save()?;
        Ok(removed)
    }

    pub fn set_grants(&mut self, id: &str, grants: Vec<String>) -> Result<()> {
        let record = self
            .peers
            .get_mut(id)
            .ok_or_else(|| Error::PeerUnknown(id.to_owned()))?;
        record.grants = grants;
        self.save()
    }

    /// Unknown peers hold no grants.
    pub fn has_grant(&self, id: &str, grant: &str) -> bool {
        self.peers
            .get(id)
            .is_some_and(|p| p.grants.iter().any(|g| grant_covers(g, grant)))
    }

    /// Record a sighting: now, at these addresses.
    pub fn touch_seen(&mut self, id: &str, addrs: Vec<String>) -> Result<()> {
        let record = self
            .peers
            .get_mut(id)
            .ok_or_else(|| Error::PeerUnknown(id.to_owned()))?;
        record.last_seen_at = now_ms();
        if !addrs.is_empty() {
            record.last_addrs = addrs;
        }
        self.save()
    }

    /// Persist: temp sibling, fsync, rename, fsync the directory.
    pub fn save(&self) -> Result<()> {
        let tmp = self.write_temp()?;
        std::fs::rename(&tmp, &self.path)?;
        if let Some(dir) = self.path.parent() {
            if let Ok(dir_file) = std::fs::File::open(dir) {
                let _ = dir_file.sync_all();
            }
        }
        Ok(())
    }

    /// The first half of [`save`](Self::save): the complete new contents in
    /// a temp sibling, synced, not yet renamed. Split out so a test can
    /// leave the store in the "crashed before rename" state.
    fn write_temp(&self) -> Result<PathBuf> {
        let dir = self.path.parent().expect("peers path has a parent");
        std::fs::create_dir_all(dir)?;
        let tmp = self.path.with_extension("json.tmp");
        let file = FileFormat {
            version: FORMAT,
            peers: self.peers.values().cloned().collect(),
        };
        let bytes = serde_json::to_vec_pretty(&file).expect("peer records serialize");
        {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            use std::io::Write;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        Ok(tmp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    fn record(id: &str, role: Role, grants: &[&str]) -> PeerRecord {
        PeerRecord {
            id: id.to_owned(),
            name: format!("device {id}"),
            platform: "macos".to_owned(),
            role,
            grants: grants.iter().map(|g| g.to_string()).collect(),
            paired_at: 1_000,
            last_seen_at: 2_000,
            last_addrs: vec!["192.168.1.9:4433".to_owned()],
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_store() {
        let dir = ScratchDir::new("peers-missing");
        let store = PeerStore::load(dir.path()).unwrap();
        assert!(store.list().is_empty());
        assert!(!peers_path(dir.path()).exists(), "load does not write");
    }

    #[test]
    fn round_trips_records_through_the_file() {
        let dir = ScratchDir::new("peers-roundtrip");
        let mut store = PeerStore::load(dir.path()).unwrap();
        store
            .insert(record("aa", Role::Satchel, &["sync:*", "blob:*"]))
            .unwrap();
        store.insert(record("bb", Role::Shelf, &[])).unwrap();

        let again = PeerStore::load(dir.path()).unwrap();
        assert_eq!(again.list(), store.list());
        assert_eq!(again.get("aa").unwrap().role, Role::Satchel);
        assert_eq!(again.get("aa").unwrap().grants, vec!["sync:*", "blob:*"]);
        assert_eq!(
            again.get("bb").unwrap().last_addrs,
            vec!["192.168.1.9:4433"]
        );
        assert!(again.get("bb").is_some());
        assert!(!again.get("cc").is_some());

        let text = std::fs::read_to_string(peers_path(dir.path())).unwrap();
        assert!(text.contains("\"pairedAt\""), "camelCase on disk: {text}");
        assert!(text.contains("\"lastAddrs\""));
        assert!(text.contains("\"role\": \"satchel\""));
    }

    #[test]
    fn insert_replaces_by_id() {
        let dir = ScratchDir::new("peers-upsert");
        let mut store = PeerStore::load(dir.path()).unwrap();
        store.insert(record("aa", Role::Satchel, &[])).unwrap();
        let mut renamed = record("aa", Role::Satchel, &["sync:*"]);
        renamed.name = "renamed".into();
        store.insert(renamed).unwrap();
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.get("aa").unwrap().name, "renamed");
        assert_eq!(
            PeerStore::load(dir.path()).unwrap().get("aa").unwrap().name,
            "renamed"
        );
    }

    #[test]
    fn a_crashed_write_leaves_the_previous_file_intact() {
        let dir = ScratchDir::new("peers-atomic");
        let mut store = PeerStore::load(dir.path()).unwrap();
        store.insert(record("aa", Role::Satchel, &[])).unwrap();

        // Simulate the crash: the second generation is written to the temp
        // sibling and never renamed.
        store
            .peers
            .insert("bb".into(), record("bb", Role::Shelf, &[]));
        let tmp = store.write_temp().unwrap();
        assert!(tmp.exists());

        let reloaded = PeerStore::load(dir.path()).unwrap();
        assert_eq!(reloaded.list().len(), 1);
        assert!(reloaded.get("aa").is_some());
        assert!(!reloaded.get("bb").is_some());

        // And a completed save replaces it, temp file and all.
        store.save().unwrap();
        assert!(!tmp.exists());
        assert_eq!(PeerStore::load(dir.path()).unwrap().list().len(), 2);
    }

    #[test]
    fn a_malformed_file_is_a_typed_error_not_an_empty_store() {
        let dir = ScratchDir::new("peers-malformed");
        let path = peers_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{\"version\":1,\"peers\":[{\"id\":").unwrap();
        let err = PeerStore::load(dir.path()).unwrap_err();
        assert_eq!(err.kind(), "peersMalformed");
        assert!(err.to_string().contains("peers.json"));
    }

    #[test]
    fn wildcard_grants_cover_their_prefix_only() {
        assert!(grant_covers("sync:*", "sync:push"));
        assert!(grant_covers("sync:*", "sync:pull"));
        assert!(grant_covers("blob:*", "blob:read"));
        assert!(grant_covers("sync:push", "sync:push"));
        assert!(!grant_covers("sync:push", "sync:pull"));
        assert!(!grant_covers("sync:*", "syncfoo:push"));
        assert!(!grant_covers("sync:*", "sync"));
        assert!(!grant_covers("sync:*", "blob:read"));
        assert!(
            !grant_covers("*", "sync:push"),
            "a bare star is not a grant"
        );
        assert!(!grant_covers(":*", "sync:push"));
        assert!(!grant_covers("", "sync:push"));
    }

    #[test]
    fn has_grant_reads_the_record_and_unknown_ids_have_none() {
        let dir = ScratchDir::new("peers-grants");
        let mut store = PeerStore::load(dir.path()).unwrap();
        store
            .insert(record("aa", Role::Satchel, &["sync:*"]))
            .unwrap();
        assert!(store.has_grant("aa", "sync:push"));
        assert!(!store.has_grant("aa", "blob:read"));
        assert!(!store.has_grant("zz", "sync:push"));

        store.set_grants("aa", vec!["blob:read".into()]).unwrap();
        assert!(!store.has_grant("aa", "sync:push"));
        assert!(store.has_grant("aa", "blob:read"));
        assert!(PeerStore::load(dir.path())
            .unwrap()
            .has_grant("aa", "blob:read"));
    }

    #[test]
    fn unknown_ids_are_typed_errors_on_mutation() {
        let dir = ScratchDir::new("peers-unknown");
        let mut store = PeerStore::load(dir.path()).unwrap();
        assert_eq!(store.remove("zz").unwrap_err().kind(), "peerUnknown");
        assert_eq!(
            store.set_grants("zz", vec![]).unwrap_err().kind(),
            "peerUnknown"
        );
        assert_eq!(
            store.touch_seen("zz", vec![]).unwrap_err().kind(),
            "peerUnknown"
        );
        assert!(store.get("zz").is_none());
    }

    #[test]
    fn remove_forgets_and_persists() {
        let dir = ScratchDir::new("peers-remove");
        let mut store = PeerStore::load(dir.path()).unwrap();
        store.insert(record("aa", Role::Satchel, &[])).unwrap();
        store.insert(record("bb", Role::Satchel, &[])).unwrap();
        let gone = store.remove("aa").unwrap();
        assert_eq!(gone.id, "aa");
        assert!(!store.get("aa").is_some());
        let reloaded = PeerStore::load(dir.path()).unwrap();
        assert!(!reloaded.get("aa").is_some());
        assert!(reloaded.get("bb").is_some());
    }

    #[test]
    fn touch_seen_updates_time_and_keeps_old_addrs_when_none_given() {
        let dir = ScratchDir::new("peers-touch");
        let mut store = PeerStore::load(dir.path()).unwrap();
        store.insert(record("aa", Role::Satchel, &[])).unwrap();
        store.touch_seen("aa", vec![]).unwrap();
        let seen = store.get("aa").unwrap();
        assert!(seen.last_seen_at > 2_000);
        assert_eq!(seen.last_addrs, vec!["192.168.1.9:4433"]);
        store
            .touch_seen(
                "aa",
                vec!["10.0.0.2:1".into(), "https://relay.example/".into()],
            )
            .unwrap();
        assert_eq!(
            store.get("aa").unwrap().last_addrs,
            vec!["10.0.0.2:1", "https://relay.example/"]
        );
    }
}
