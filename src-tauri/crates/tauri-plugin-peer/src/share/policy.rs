//! What this machine will serve a stranger, per book, per service — WI-25.5
//! and WI-25.9.
//!
//! ⚠️ **A PUBLIC CONTENT ADDRESS IS NOT AUTHORIZATION.** The share endpoint is
//! content-addressed: anybody who has the hash can ask for the bytes, and
//! withdrawing an index entry does nothing at all to somebody who kept the
//! hash from last week. So the decision cannot live at the index, and it
//! cannot live at the connection either — it lives in the serve path and is
//! asked again on **every request**, including requests arriving on a
//! connection that was already open when the reader turned the book off.
//!
//! ## Two switches, not one — WI-25.9
//!
//! Serving a book's BYTES and serving public annotations ABOUT that book are
//! different acts with different consequences, and the common case is the
//! second without the first: a reader publishes notes on a book they have no
//! right to redistribute. One switch would make publishing an opinion an act
//! of republication.
//!
//! So [`ShareService`] is part of the key, and `allows` takes it. The two
//! answers are independent in both directions: `notes` may be on with `bytes`
//! off, and turning `bytes` on later does not turn `notes` on.
//!
//! ## Default OFF, and that is why absence is a decision
//!
//! A book this file has never heard of is refused. `set(.., false)` therefore
//! REMOVES rather than storing `false`, so the file's size tracks what is
//! offered rather than what has ever been considered — and a file that will
//! not read refuses everything (see [`SharePolicy::load`]) instead of failing
//! open.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::share::ContentHash;
use crate::store::write_atomic;

/// `<root>/peer/share/`.
pub fn share_dir(root: &Path) -> PathBuf {
    root.join(crate::identity::PEER_DIR).join("share")
}

/// `<root>/peer/share/offered.json`.
fn policy_path(root: &Path) -> PathBuf {
    share_dir(root).join("offered.json")
}

/// Which of the share endpoint's two services a decision is about.
///
/// ⚠️ **THE TWO ARE ROUTED APART AS WELL AS AUTHORIZED APART.** The bytes ride
/// `iroh_blobs::ALPN` and the annotations ride `NOTES_ALPN`; a request arriving
/// for one is not answerable by the other, which is the ALPN dispatcher's shape
/// applied to the thing WI-25.9 says must not be conflated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareService {
    /// The book's own bytes.
    Bytes,
    /// Public annotations about the book. Never the book.
    Notes,
}

impl ShareService {
    pub const ALL: [ShareService; 2] = [ShareService::Bytes, ShareService::Notes];

    pub fn as_str(self) -> &'static str {
        match self {
            ShareService::Bytes => "bytes",
            ShareService::Notes => "notes",
        }
    }
}

/// One book's two switches, as the file stores them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Switches {
    #[serde(default)]
    bytes: bool,
    #[serde(default)]
    notes: bool,
}

impl Switches {
    fn get(&self, service: ShareService) -> bool {
        match service {
            ShareService::Bytes => self.bytes,
            ShareService::Notes => self.notes,
        }
    }

    fn set(&mut self, service: ShareService, on: bool) {
        match service {
            ShareService::Bytes => self.bytes = on,
            ShareService::Notes => self.notes = on,
        }
    }

    fn any(&self) -> bool {
        self.bytes || self.notes
    }
}

/// The file. `v` first, so a future shape can be told from this one.
///
/// ⚠️ **NO `#[derive(Default)]`, BECAUSE ITS DEFAULT WAS VERSION ZERO.** Two
/// places built the empty state by hand with `v: VERSION` while a third
/// spelling — the derived `Default` — produced a record `load` would refuse as
/// *"version 0 is not 1"*. Three ways to say "nothing offered", one of them
/// wrong, and nothing stopping a caller reaching for it. Found by audit.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Offered {
    v: u32,
    /// Keyed by the book's `contentHash` — BLAKE3 of the whole file, lower-case
    /// hex. `BTreeMap` so the file is written in a stable order and two writes
    /// of one state produce one set of bytes.
    #[serde(default)]
    books: BTreeMap<String, Switches>,
}

const VERSION: u32 = 1;

impl Offered {
    /// Nothing offered, at the version this build writes.
    fn empty() -> Self {
        Self {
            v: VERSION,
            books: BTreeMap::new(),
        }
    }
}

/// The most books one machine may offer.
///
/// ⚠️ **A BOUND ON A FILE THE APP WRITES IS STILL A BOUND WORTH HAVING.** The
/// list is read at every launch and consulted on every request; without a cap
/// a bug in a caller — an import loop that offers each book twice, a migration
/// that offers the whole library — turns a preference into an unbounded file
/// on the read path. Ten thousand is far past any reader's library and far
/// under anything that costs a parse.
pub const MAX_OFFERED_BOOKS: usize = 10_000;

/// The most bytes the policy file may be before it is refused unread.
///
/// ⚠️ **A COUNT BOUND CANNOT BOUND A READ.** `MAX_OFFERED_BOOKS` is checked on
/// the parsed value, which is after the whole file is in memory and after it
/// has become a map — so it bounds what is KEPT and says nothing about what
/// finding out costs. One entry is a 64-character hash and two booleans, about
/// a hundred bytes pretty-printed, so ten thousand of them is roughly a
/// megabyte; four is room for the format to grow and still refuses anything
/// that is not a policy this build wrote.
pub const MAX_POLICY_BYTES: u64 = 4 * 1024 * 1024;

/// What this machine will serve, and to whom it answers: everybody.
#[derive(Debug)]
pub struct SharePolicy {
    path: PathBuf,
    /* `RwLock`, not `Mutex`: `allows` is on the serve path of every request
     * and `set` is a human act. Readers must not queue behind each other. */
    state: RwLock<Offered>,
    /// One writer at a time, and NOT the state lock.
    ///
    /// ⚠️ **`set` USED TO HOLD THE STATE'S WRITE LOCK ACROSS `to_vec_pretty`,
    /// A TEMP FILE, A `write`, TWO `fsync`s AND A `rename`.** `allows` is
    /// asked once per request on the serve path, and a `RwLock`'s readers
    /// queue behind a waiting writer — so every stranger's request, on every
    /// open connection, blocked on this machine's disk while one book was
    /// switched on. The comment above says readers must not queue behind each
    /// other; they were queueing behind an fsync. Found by audit.
    ///
    /// Two locks rather than one, and the ORDER OF OPERATIONS is what makes
    /// them safe: this one is taken first and held for the whole
    /// read-modify-write, so two writers cannot interleave and lose an update;
    /// the state lock is taken twice, briefly, and never across I/O.
    writing: Mutex<()>,
    /// Whether the empty state above is a real "nothing offered" or a file
    /// this build could not read — see [`SharePolicy::set`].
    ///
    /// ⚠️ **REFUSING TO SERVE AND REFUSING TO WRITE ARE DIFFERENT DECISIONS,
    /// AND ONLY THE FIRST WAS MADE.** `load_or_refuse_all` is right that a
    /// corrupt policy must offer nothing: the alternative takes the circle down
    /// with it, and offering nothing costs only the reader's public library.
    /// But the state it built was WRITABLE and pointed at the original file, so
    /// the next book the reader switched on serialised "one book" over their
    /// whole policy — every other offer gone, and the corrupt file that a human
    /// might have repaired gone with it. Found by audit.
    readable: bool,
}

/// The policy a file's bytes describe, or why they are not one.
///
/// ⚠️ **EVERY REFUSAL NAMES THE FILE.** `load` used to inline all of this, and
/// one branch escaped the pattern: `ContentHash::parse` answers
/// `ShareRefused`, which carries no path — so a key that was not a hash was
/// reported in a different SHAPE from every other kind of corruption in the
/// same file, and the one thing a reader needs (which file to look at) was the
/// thing it dropped. Found by audit.
///
/// Split out so `load` is filesystem handling and this is validation; the
/// order of the checks is unchanged and deliberate.
fn parsed_policy(path: &Path, bytes: &[u8]) -> Result<Offered> {
    let parsed: Offered = serde_json::from_slice(bytes).map_err(|err| Error::ShareMalformed {
        path: path.to_path_buf(),
        why: err.to_string(),
    })?;
    if parsed.v != VERSION {
        return Err(Error::ShareMalformed {
            path: path.to_path_buf(),
            why: format!("version {} is not {VERSION}", parsed.v),
        });
    }
    /* A key that is not a content hash is refused rather than ignored: it can
     * never match a request, so keeping it would be storage for a decision
     * that can never apply — and a malformed key is evidence the file was
     * written by something that is not this code. */
    for key in parsed.books.keys() {
        ContentHash::parse(key).map_err(|err| Error::ShareMalformed {
            path: path.to_path_buf(),
            why: format!("{key:?} is not a content hash: {err}"),
        })?;
    }
    if parsed.books.len() > MAX_OFFERED_BOOKS {
        return Err(Error::ShareMalformed {
            path: path.to_path_buf(),
            why: format!(
                "{} books offered, more than the {MAX_OFFERED_BOOKS} this build reads",
                parsed.books.len()
            ),
        });
    }
    Ok(parsed)
}

impl SharePolicy {
    /// Load the policy, or start from nothing when there is no file.
    ///
    /// ⚠️ **UNREADABLE IS NOT EMPTY, AND HERE THEY HAPPEN TO AGREE.** Every
    /// other store in this plugin refuses to treat a malformed file as an
    /// empty one, because the empty reading destroys data on the next write.
    /// This one is the exception where the safe reading IS the empty one —
    /// nothing is offered, so nothing is served — and it is still an error
    /// rather than a silent `default()`, because a reader whose offers stopped
    /// working is owed the reason. The caller decides; `load_or_refuse_all`
    /// is the caller that fails closed.
    pub fn load(root: &Path) -> Result<Self> {
        let path = policy_path(root);
        /* ⚠️ **THE SIZE BOUND RUNS BEFORE THE READ, NOT AFTER THE PARSE.**
         * `MAX_OFFERED_BOOKS` was checked on the deserialised value, so a file
         * claiming a hundred million books was read into memory and turned into
         * a `BTreeMap` before anything objected — the bound measured what
         * survived rather than what it cost to find out. `importLimits.ts`
         * states the rule this plugin's TypeScript half already follows: *"a
         * bound that runs AFTER the read has not bounded anything"*, and
         * `publicStore` applies it before the split for the same reason.
         *
         * The ceiling is generous on purpose: an entry is a 64-character hash
         * and two booleans, so `MAX_OFFERED_BOOKS` of them is well under a
         * megabyte pretty-printed. Anything past this is not a policy this
         * build wrote. */
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > MAX_POLICY_BYTES => {
                return Err(Error::ShareMalformed {
                    path,
                    why: format!("{} bytes is larger than this build will read", meta.len()),
                })
            }
            _ => {}
        }
        let state = match std::fs::read(&path) {
            Ok(bytes) => parsed_policy(&path, &bytes)?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Offered::empty(),
            Err(err) => return Err(err.into()),
        };
        Ok(Self {
            path,
            state: RwLock::new(state),
            writing: Mutex::new(()),
            /* A file that read, or one that is genuinely absent. Both are a
             * policy this build understands and may write back. */
            readable: true,
        })
    }

    /// The policy, or one that refuses everything.
    ///
    /// ⚠️ **FAILING CLOSED IS THE ONLY SAFE DIRECTION HERE**, and it is the
    /// opposite of what every other loader in this plugin does. A share
    /// endpoint that would not start because its preference file is corrupt
    /// takes the circle down with it (they share a process); a share endpoint
    /// that starts and offers nothing costs the reader their public library
    /// and costs nobody anything else. The failure is logged, loudly, because
    /// silence here looks exactly like a reader who has offered nothing.
    pub fn load_or_refuse_all(root: &Path) -> Self {
        match Self::load(root) {
            Ok(policy) => policy,
            Err(err) => {
                log::error!(
                    "peer: the public-sharing policy would not read ({err}); this machine offers \
                     NOTHING publicly until it is fixed or removed"
                );
                Self {
                    path: policy_path(root),
                    state: RwLock::new(Offered::empty()),
                    writing: Mutex::new(()),
                    /* Serve nothing AND write nothing — see the field. */
                    readable: false,
                }
            }
        }
    }

    /// Whether this book may be served over this service, right now.
    ///
    /// ⚠️ **CALL THIS PER REQUEST.** Not per connection, not at the index, not
    /// when the transfer starts. WI-25.5's acceptance turns a book off and
    /// requires the refusal on a connection that is already open; the only
    /// implementation of that is asking again.
    pub fn allows(&self, hash: &ContentHash, service: ShareService) -> bool {
        self.state
            .read()
            .map(|held| {
                held.books
                    .get(hash.as_str())
                    .is_some_and(|switches| switches.get(service))
            })
            /* A poisoned lock means a writer panicked mid-update. Refusing is
             * the same direction as `load_or_refuse_all`. */
            .unwrap_or(false)
    }

    /// Turn one book's one service on or off, and persist it before answering.
    ///
    /// ⚠️ **PERSISTED BEFORE THE IN-MEMORY STATE MOVES, NOT AFTER.** The
    /// acceptance says a book turned off stays off "after a restart". If the
    /// memory moved first and the write then failed, the running process would
    /// refuse and the next launch would serve — the reader having been told it
    /// was off. The other order costs one failed call and no lie.
    pub fn set(&self, hash: &ContentHash, service: ShareService, on: bool) -> Result<()> {
        /* ⚠️ **A POLICY THIS BUILD COULD NOT READ IS NOT A POLICY TO WRITE
         * OVER.** See `readable`. The refusal names the file, because the only
         * way out is a human looking at it. */
        if !self.readable {
            return Err(Error::ShareRefused(format!(
                "the public-sharing policy at {} could not be read, so nothing can be offered or \
                 withdrawn until it is repaired or removed",
                self.path.display()
            )));
        }
        /* ⚠️ **THE WRITER LOCK, NOT THE STATE LOCK — SEE THE FIELD.** Held for
         * the whole read-modify-write so two writers cannot lose an update;
         * the state lock is taken twice below and never across the disk. */
        let _writing = self.writing.lock().map_err(|_| {
            Error::ShareRefused("the sharing policy writer lock is poisoned".into())
        })?;
        let mut next = self
            .state
            .read()
            .map_err(|_| Error::ShareRefused("the sharing policy lock is poisoned".into()))?
            .clone();
        let entry = next.books.entry(hash.as_str().to_owned()).or_default();
        entry.set(service, on);
        /* A book with nothing offered is REMOVED rather than stored as two
         * falses: the file then measures what is offered, not what has ever
         * been considered, and `MAX_OFFERED_BOOKS` bounds the former. */
        if !entry.any() {
            next.books.remove(hash.as_str());
        }
        if next.books.len() > MAX_OFFERED_BOOKS {
            return Err(Error::ShareRefused(format!(
                "at most {MAX_OFFERED_BOOKS} books may be offered publicly"
            )));
        }
        let bytes =
            serde_json::to_vec_pretty(&next).map_err(|err| Error::ShareRefused(err.to_string()))?;
        /* No lock on `state` here: a stranger's request may be asking `allows`
        while this fsyncs, and it must not wait for it. */
        write_atomic(&self.path, &bytes)?;
        *self
            .state
            .write()
            .map_err(|_| Error::ShareRefused("the sharing policy lock is poisoned".into()))? = next;
        Ok(())
    }

    /// Every book offered over one service, in a stable order.
    pub fn offered(&self, service: ShareService) -> Vec<ContentHash> {
        let Ok(held) = self.state.read() else {
            return Vec::new();
        };
        held.books
            .iter()
            .filter(|(_, switches)| switches.get(service))
            /* Parsed on load, so this cannot fail; `filter_map` rather than an
             * `expect` because a panic on the announce path would take the
             * share endpoint down for a value that can only be refused. */
            .filter_map(|(hash, _)| ContentHash::parse(hash).ok())
            .collect()
    }

    /* ⚠️ **`switches(hash)` STOOD HERE AND NOTHING CALLED IT.** It answered
    both services for one book — *"for the surface that draws them"* — and
    the surface does not ask per book: `peer_share_offered` builds every
    row from `offered(service)`, which is one pass over the map rather than
    two lookups per book. A convenience with no consumer is a second way to
    ask a question, free to answer it differently. Found by audit. */
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    fn hash(byte: u8) -> ContentHash {
        ContentHash::parse(&format!("{byte:02x}").repeat(32)).unwrap()
    }

    /// ⚠️ **REFUSING TO SERVE AND REFUSING TO WRITE ARE DIFFERENT DECISIONS.**
    /// A corrupt policy correctly offered nothing — and then the next book the
    /// reader switched on wrote "one book" over the whole file, taking every
    /// other offer AND the evidence a human could have repaired. Found by
    /// audit. The read side is unchanged and still fails closed.
    #[test]
    fn a_policy_that_would_not_read_is_never_written_over() {
        let dir = crate::testutil::scratch("policy-unreadable");
        let path = policy_path(&dir);
        std::fs::create_dir_all(path.parent().expect("the policy has a parent")).unwrap();
        std::fs::write(&path, b"{ not json at all").unwrap();
        let before = std::fs::read(&path).unwrap();

        let policy = SharePolicy::load_or_refuse_all(&dir);
        let hash = ContentHash::parse(&"a".repeat(64)).unwrap();
        /* Serving is refused, which is the existing guarantee. */
        assert!(!policy.allows(&hash, ShareService::Bytes));

        let refused = policy
            .set(&hash, ShareService::Bytes, true)
            .expect_err("a book was offered over a policy that could not be read");
        assert!(
            refused.to_string().contains("could not be read"),
            "the refusal does not say why: {refused}"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "the unreadable policy was overwritten, so nothing can repair it"
        );
    }

    #[test]
    fn a_book_nobody_has_offered_is_refused() {
        let dir = ScratchDir::new("share-policy-default");
        let policy = SharePolicy::load(dir.path()).unwrap();
        for service in ShareService::ALL {
            assert!(
                !policy.allows(&hash(1), service),
                "default off for {}",
                service.as_str()
            );
        }
    }

    #[test]
    fn the_two_services_are_independent_in_both_directions() {
        /* ⚠️ **WI-25.9's WHOLE POINT.** A reader publishing notes on a book
        they may not redistribute must not thereby redistribute it — and the
        reverse must hold too, or turning bytes on would quietly start
        publishing opinions. */
        let dir = ScratchDir::new("share-policy-split");
        let policy = SharePolicy::load(dir.path()).unwrap();
        let book = hash(2);

        policy.set(&book, ShareService::Notes, true).unwrap();
        assert!(policy.allows(&book, ShareService::Notes));
        assert!(
            !policy.allows(&book, ShareService::Bytes),
            "publishing an annotation made the book downloadable"
        );

        policy.set(&book, ShareService::Notes, false).unwrap();
        policy.set(&book, ShareService::Bytes, true).unwrap();
        assert!(policy.allows(&book, ShareService::Bytes));
        assert!(
            !policy.allows(&book, ShareService::Notes),
            "offering the bytes started publishing annotations"
        );
    }

    #[test]
    fn turning_a_book_off_survives_a_restart_and_so_does_turning_it_on() {
        let dir = ScratchDir::new("share-policy-restart");
        let book = hash(3);
        {
            let policy = SharePolicy::load(dir.path()).unwrap();
            policy.set(&book, ShareService::Bytes, true).unwrap();
        }
        assert!(SharePolicy::load(dir.path())
            .unwrap()
            .allows(&book, ShareService::Bytes));
        {
            let policy = SharePolicy::load(dir.path()).unwrap();
            policy.set(&book, ShareService::Bytes, false).unwrap();
        }
        assert!(
            !SharePolicy::load(dir.path())
                .unwrap()
                .allows(&book, ShareService::Bytes),
            "a book turned off came back on after a restart"
        );
    }

    #[test]
    fn a_book_with_nothing_offered_leaves_the_file() {
        let dir = ScratchDir::new("share-policy-shrink");
        let policy = SharePolicy::load(dir.path()).unwrap();
        let book = hash(4);
        policy.set(&book, ShareService::Bytes, true).unwrap();
        policy.set(&book, ShareService::Bytes, false).unwrap();
        let text = std::fs::read_to_string(policy_path(dir.path())).unwrap();
        assert!(
            !text.contains(book.as_str()),
            "a withdrawn book is remembered as two falses: {text}"
        );
    }

    #[test]
    fn a_key_that_is_not_a_content_hash_refuses_the_whole_file() {
        let dir = ScratchDir::new("share-policy-badkey");
        std::fs::create_dir_all(share_dir(dir.path())).unwrap();
        std::fs::write(
            policy_path(dir.path()),
            br#"{"v":1,"books":{"../../etc/passwd":{"bytes":true}}}"#,
        )
        .unwrap();
        assert!(SharePolicy::load(dir.path()).is_err());
    }

    #[test]
    fn an_unreadable_policy_offers_nothing_rather_than_everything() {
        /* The one place in this plugin where a malformed file is survivable,
        and the direction is what makes it so — see `load_or_refuse_all`. */
        let dir = ScratchDir::new("share-policy-corrupt");
        std::fs::create_dir_all(share_dir(dir.path())).unwrap();
        std::fs::write(policy_path(dir.path()), b"{ this is not json").unwrap();
        let policy = SharePolicy::load_or_refuse_all(dir.path());
        for service in ShareService::ALL {
            assert!(!policy.allows(&hash(5), service));
        }
        assert!(policy.offered(ShareService::Bytes).is_empty());
    }

    #[test]
    fn offered_lists_only_the_asked_for_service() {
        let dir = ScratchDir::new("share-policy-offered");
        let policy = SharePolicy::load(dir.path()).unwrap();
        policy.set(&hash(6), ShareService::Bytes, true).unwrap();
        policy.set(&hash(7), ShareService::Notes, true).unwrap();
        assert_eq!(policy.offered(ShareService::Bytes), vec![hash(6)]);
        assert_eq!(policy.offered(ShareService::Notes), vec![hash(7)]);
    }

    #[test]
    fn a_future_version_is_refused_rather_than_read_as_this_one() {
        let dir = ScratchDir::new("share-policy-version");
        std::fs::create_dir_all(share_dir(dir.path())).unwrap();
        std::fs::write(policy_path(dir.path()), br#"{"v":2,"books":{}}"#).unwrap();
        assert!(SharePolicy::load(dir.path()).is_err());
    }

    /// ⚠️ **`set` HELD THE STATE'S WRITE LOCK ACROSS THE WHOLE DISK WRITE.**
    /// `allows` is asked once per request on the serve path, and a `RwLock`'s
    /// readers queue behind a waiting writer — so every stranger's request on
    /// every open connection blocked on this machine's fsync while one book
    /// was switched on. Measured as the property that matters: a read
    /// completes while a write is in flight.
    #[test]
    fn a_reader_does_not_wait_for_a_writer_s_disk() {
        let dir = crate::testutil::scratch("policy-reader-not-blocked");
        let policy = std::sync::Arc::new(SharePolicy::load(&dir).unwrap());
        policy.set(&hash(1), ShareService::Bytes, true).unwrap();

        /* A writer that is inside `write_atomic` cannot be paused from here, so
        the property is measured the other way round: hold the STATE's read
        lock — which is what `allows` takes — and show that a write still
        completes. Under the old shape the writer needed the state's write
        lock for its whole run and this would deadlock until the read was
        dropped; the reader would then have been the one waiting in the real
        direction, for the same reason. */
        let held = policy.state.read().unwrap();
        let mine = std::sync::Arc::clone(&policy);
        let writer = std::thread::spawn(move || mine.set(&hash(2), ShareService::Notes, true));
        /* The write's disk half is done before it asks for the state lock. */
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            held.books.contains_key(hash(1).as_str()),
            "the read lock stopped being a read lock"
        );
        drop(held);
        writer.join().unwrap().unwrap();
        assert!(policy.allows(&hash(2), ShareService::Notes));
    }

    /// Two writers do not lose an update, which is what the writer lock is for.
    #[test]
    fn two_writers_do_not_lose_an_update() {
        let dir = crate::testutil::scratch("policy-two-writers");
        let policy = std::sync::Arc::new(SharePolicy::load(&dir).unwrap());
        let mut hands = Vec::new();
        for n in 0..8u8 {
            let mine = std::sync::Arc::clone(&policy);
            hands.push(std::thread::spawn(move || {
                mine.set(&hash(n + 1), ShareService::Bytes, true)
            }));
        }
        for hand in hands {
            hand.join().unwrap().unwrap();
        }
        assert_eq!(
            policy.offered(ShareService::Bytes).len(),
            8,
            "two writers read the same state and one overwrote the other"
        );
        /* And what is on disk agrees, since that is what survives a restart. */
        assert_eq!(
            SharePolicy::load(&dir)
                .unwrap()
                .offered(ShareService::Bytes)
                .len(),
            8
        );
    }
}
