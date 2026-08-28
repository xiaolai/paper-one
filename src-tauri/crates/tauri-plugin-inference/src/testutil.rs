//! Shared test scaffolding: scratch directories under the OS temp dir, one
//! per test, removed on drop. Nothing here is compiled into the plugin.
//!
//! The same shape as `tauri-plugin-peer`'s, deliberately — two sibling
//! plugins with two different scratch-directory conventions is one
//! convention too many, and this one costs no dependency.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::endpoints::Keychain;
use crate::error::{Error, Result};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A keychain that answers from memory and REFUSES the accounts it is told to.
///
/// The real one refuses in ways no test can provoke on purpose: a macOS
/// "Deny" on the access prompt, or a dev rebuild whose code signature no
/// longer matches the ACL on an entry an earlier build wrote. Each arrives as
/// a `keyring::Error` that is not `NoEntry` — the arm the store has to treat
/// as "this endpoint only", never as "no daemon today" (WI-20.20). This fake
/// is how that arm gets exercised without a prompt and without touching the
/// reader's keychain.
#[derive(Debug, Default)]
pub struct FakeKeychain {
    keys: Mutex<BTreeMap<String, String>>,
    refused: BTreeSet<String>,
}

impl FakeKeychain {
    /// Refuse every operation on these accounts, the way a denied prompt does.
    pub fn refusing(mut self, accounts: &[&str]) -> Self {
        self.refused
            .extend(accounts.iter().map(|account| (*account).to_owned()));
        self
    }

    /// Start with a key already stored under `account`.
    pub fn with_key(self, account: &str, key: &str) -> Self {
        self.keys
            .lock()
            .expect("fake keychain poisoned")
            .insert(account.to_owned(), key.to_owned());
        self
    }

    fn refuse_if_told(&self, account: &str) -> Result<()> {
        if self.refused.contains(account) {
            return Err(Error::Keychain(format!(
                "the user denied access to {account}"
            )));
        }
        Ok(())
    }
}

impl Keychain for FakeKeychain {
    fn read(&self, account: &str) -> Result<Option<String>> {
        self.refuse_if_told(account)?;
        Ok(self
            .keys
            .lock()
            .expect("fake keychain poisoned")
            .get(account)
            .cloned())
    }

    fn write(&self, account: &str, key: &str) -> Result<()> {
        self.refuse_if_told(account)?;
        self.keys
            .lock()
            .expect("fake keychain poisoned")
            .insert(account.to_owned(), key.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<()> {
        self.refuse_if_told(account)?;
        self.keys
            .lock()
            .expect("fake keychain poisoned")
            .remove(account);
        Ok(())
    }
}

/// A fresh, empty directory that is removed when the guard drops.
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    pub fn new(label: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "tauri-plugin-inference-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
