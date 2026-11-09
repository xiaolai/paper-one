//! The destinations the reader picked, held by token, and what each token may
//! still do.
//!
//! ⚠️ **THE WINDOW NEVER HOLDS THE PATH.** The old `narrate_package` took a path
//! from the webview and wrote it, and the only thing standing between that and
//! an arbitrary write was a comment asking callers to get it from the save
//! dialog. The dialog is opened here now, and the window is handed a random
//! token for what the reader chose. A token is a capability for ONE book:
//!
//! ```text
//! Picked ──claim──▶ Packaging ──commit──▶ Committed ──discard──▶ Discarded
//!   │                   │  ╲
//!   release (gone)      │   abandon (gone): the package failed
//!                       release: marked, and commit then refuses
//! ```
//!
//! Every transition happens under one lock, the rename included, so two calls on
//! one token are serialised and a release can never land between the check and
//! the write.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::limits::{Refused, MAX_LIVE_TOKENS};
use crate::scratch::random_hex;
use crate::staged::Staged;

/// How many finished tokens are remembered, so a late `exists` or `discard`
/// still has an answer. The oldest are forgotten first.
const KEPT_FINISHED: usize = 32;

/// A file's identity, so a discard removes the file this export wrote and not
/// one that took its name afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId(u64, u64);

impl FileId {
    #[cfg(unix)]
    fn of(meta: &std::fs::Metadata) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        Some(Self(meta.dev(), meta.ino()))
    }

    #[cfg(not(unix))]
    fn of(_meta: &std::fs::Metadata) -> Option<Self> {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    Picked,
    Packaging {
        released: bool,
    },
    Committed {
        /// Whether something was at the destination before this export wrote
        /// it. Such a file is never removed: it replaced a book the reader had.
        existed: bool,
        id: Option<FileId>,
    },
    Discarded,
}

impl Phase {
    fn live(&self) -> bool {
        matches!(self, Self::Picked | Self::Packaging { .. })
    }
}

#[derive(Debug)]
struct Entry {
    target: PathBuf,
    phase: Phase,
    /// Insertion order, for forgetting the oldest finished token.
    seq: u64,
}

#[derive(Debug, Default)]
pub struct Destinations {
    inner: Mutex<Book>,
}

#[derive(Debug, Default)]
struct Book {
    entries: HashMap<String, Entry>,
    next: u64,
}

fn unknown() -> String {
    "that destination was never picked, or has already been used".to_owned()
}

impl Destinations {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Book>, String> {
        self.inner
            .lock()
            .map_err(|_| "the export's destinations were poisoned".to_owned())
    }

    /// Whether another destination may be picked now. Asked before the dialog
    /// opens, so a reader is not shown one whose answer would be refused.
    pub fn room(&self) -> Result<(), String> {
        let book = self.lock()?;
        if book.entries.values().filter(|e| e.phase.live()).count() >= MAX_LIVE_TOKENS {
            return Err(Refused::TooManyTokens.into());
        }
        Ok(())
    }

    /// Hold a picked destination, and answer the token for it.
    pub fn insert(&self, target: PathBuf) -> Result<String, String> {
        let mut book = self.lock()?;
        if book.entries.values().filter(|e| e.phase.live()).count() >= MAX_LIVE_TOKENS {
            return Err(Refused::TooManyTokens.into());
        }
        let token = random_hex(2);
        let seq = book.next;
        book.next += 1;
        book.entries.insert(
            token.clone(),
            Entry {
                target,
                phase: Phase::Picked,
                seq,
            },
        );
        Self::forget_oldest(&mut book);
        Ok(token)
    }

    fn forget_oldest(book: &mut Book) {
        loop {
            let finished: Vec<(&String, u64)> = book
                .entries
                .iter()
                .filter(|(_, e)| !e.phase.live())
                .map(|(token, e)| (token, e.seq))
                .collect();
            if finished.len() <= KEPT_FINISHED {
                return;
            }
            let Some(oldest) = finished
                .iter()
                .min_by_key(|(_, seq)| *seq)
                .map(|(token, _)| (*token).clone())
            else {
                return;
            };
            book.entries.remove(&oldest);
        }
    }

    /// Start packaging to a token's destination. A token is packaged once:
    /// a second claim — concurrent or later — is refused.
    pub fn claim(&self, token: &str) -> Result<PathBuf, String> {
        let mut book = self.lock()?;
        let entry = book.entries.get_mut(token).ok_or_else(unknown)?;
        match entry.phase {
            Phase::Picked => {
                entry.phase = Phase::Packaging { released: false };
                Ok(entry.target.clone())
            }
            Phase::Packaging { .. } => Err("that destination is already being written".to_owned()),
            Phase::Committed { .. } | Phase::Discarded => Err(unknown()),
        }
    }

    /// Move a finished book onto its token's destination.
    ///
    /// ⚠️ **UNDER THE LOCK, RENAME AND ALL.** A release that arrives while the
    /// book is being joined marks the token, and this refuses it — so a token
    /// released at any moment before this line can never be written, and one
    /// released after it is a no-op on a finished book.
    pub fn commit(&self, token: &str, staged: Staged) -> Result<(), String> {
        let mut book = self.lock()?;
        let entry = book.entries.get_mut(token).ok_or_else(unknown)?;
        match entry.phase {
            Phase::Packaging { released: false } => {}
            Phase::Packaging { released: true } => {
                book.entries.remove(token);
                /* `staged` drops here, which removes it. */
                return Err("the export was cancelled before the book was written".to_owned());
            }
            _ => return Err(unknown()),
        }
        let existed = std::fs::symlink_metadata(&entry.target).is_ok();
        /* ⚠️ **A FAILED MOVE FORGETS THE TOKEN HERE, NOT IN THE CALLER.** The
         * caller settles its claim before it reads this answer, so an entry left
         * in `Packaging` would never be abandoned, and each failed rename (a
         * locked or occupied target) would hold one of the live places until
         * the app restarted. */
        if let Err(error) = staged.commit(&entry.target) {
            book.entries.remove(token);
            return Err(error);
        }
        let id = std::fs::symlink_metadata(&entry.target)
            .ok()
            .and_then(|meta| FileId::of(&meta));
        entry.phase = Phase::Committed { existed, id };
        Self::forget_oldest(&mut book);
        Ok(())
    }

    /// Forget a token whose package failed, so it cannot be tried again.
    pub fn abandon(&self, token: &str) {
        if let Ok(mut book) = self.lock() {
            if matches!(
                book.entries.get(token).map(|e| &e.phase),
                Some(Phase::Packaging { .. })
            ) {
                book.entries.remove(token);
            }
        }
    }

    /// The window is done with a token. Before its package it is forgotten;
    /// during it, it is marked so the commit refuses; after it, nothing.
    pub fn release(&self, token: &str) -> Result<(), String> {
        let mut book = self.lock()?;
        let Some(entry) = book.entries.get_mut(token) else {
            return Ok(());
        };
        match entry.phase {
            Phase::Picked => {
                book.entries.remove(token);
            }
            Phase::Packaging { .. } => entry.phase = Phase::Packaging { released: true },
            Phase::Committed { .. } | Phase::Discarded => {}
        }
        Ok(())
    }

    /// Whether anything is at a token's destination now. A link counts.
    pub fn exists(&self, token: &str) -> Result<bool, String> {
        let book = self.lock()?;
        let entry = book.entries.get(token).ok_or_else(unknown)?;
        Ok(std::fs::symlink_metadata(&entry.target).is_ok())
    }

    /// Remove the book a token's package wrote — only once, only after the
    /// package, and only where nothing was at the destination before it.
    pub fn discard_book(&self, token: &str) -> Result<(), String> {
        let mut book = self.lock()?;
        let entry = book.entries.get_mut(token).ok_or_else(unknown)?;
        let id = match entry.phase {
            Phase::Committed { existed: false, id } => id,
            Phase::Committed { existed: true, .. } => {
                return Err(
                    "a file was already at that destination before the export, so it is kept"
                        .to_owned(),
                )
            }
            Phase::Discarded => return Err("that book has already been removed".to_owned()),
            Phase::Picked | Phase::Packaging { .. } => {
                return Err("that book has not been written".to_owned())
            }
        };
        let meta = std::fs::symlink_metadata(&entry.target)
            .map_err(|error| format!("cannot read the exported book: {error}"))?;
        if !meta.file_type().is_file() || FileId::of(&meta) != id {
            return Err(
                "the file at that destination is no longer the book this export wrote".to_owned(),
            );
        }
        std::fs::remove_file(&entry.target)
            .map_err(|error| format!("cannot remove the exported book: {error}"))?;
        entry.phase = Phase::Discarded;
        Ok(())
    }

    /// The phase of a token, for tests.
    #[cfg(test)]
    fn phase(&self, token: &str) -> Option<Phase> {
        self.lock()
            .ok()
            .and_then(|book| book.entries.get(token).map(|e| e.phase.clone()))
    }

    /// The name of a token's destination, which is all the window is told.
    pub fn name_of(target: &Path) -> String {
        target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn picked() -> (tempfile::TempDir, PathBuf, Destinations, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("Book.m4b");
        let destinations = Destinations::default();
        let token = destinations.insert(target.clone()).expect("insert");
        (dir, target, destinations, token)
    }

    fn staged_with(target: &Path, bytes: &[u8]) -> Staged {
        let (staged, mut file) = Staged::beside(target, "book").expect("stage");
        std::io::Write::write_all(&mut file, bytes).expect("write");
        staged
    }

    #[test]
    fn a_token_is_random_and_names_nothing_about_the_path() {
        let (_dir, _target, destinations, token) = picked();
        assert_eq!(token.len(), 32);
        assert!(!token.contains("Book"));
        let other = destinations
            .insert(PathBuf::from("/x/Book.m4b"))
            .expect("insert");
        assert_ne!(token, other);
    }

    #[test]
    fn a_package_consumes_the_token() {
        let (_dir, target, destinations, token) = picked();
        assert_eq!(destinations.claim(&token).expect("claim"), target);
        destinations
            .commit(&token, staged_with(&target, b"book"))
            .expect("commit");
        assert_eq!(std::fs::read(&target).expect("read"), b"book");
        assert!(destinations.claim(&token).is_err(), "packaged twice");
    }

    #[test]
    fn a_failed_package_consumes_the_token_too() {
        let (_dir, _target, destinations, token) = picked();
        destinations.claim(&token).expect("claim");
        destinations.abandon(&token);
        assert!(destinations.claim(&token).is_err());
        assert_eq!(destinations.phase(&token), None);
    }

    #[test]
    fn concurrent_claims_on_one_token_admit_exactly_one() {
        let (_dir, _target, destinations, token) = picked();
        let destinations = Arc::new(destinations);
        let admitted: usize = (0..8)
            .map(|_| {
                let destinations = Arc::clone(&destinations);
                let token = token.clone();
                std::thread::spawn(move || destinations.claim(&token).is_ok())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| usize::from(handle.join().expect("join")))
            .sum();
        assert_eq!(admitted, 1);
    }

    #[test]
    fn concurrent_discards_after_one_package_remove_the_book_exactly_once() {
        let (_dir, target, destinations, token) = picked();
        destinations.claim(&token).expect("claim");
        destinations
            .commit(&token, staged_with(&target, b"book"))
            .expect("commit");
        let destinations = Arc::new(destinations);
        let removed: usize = (0..8)
            .map(|_| {
                let destinations = Arc::clone(&destinations);
                let token = token.clone();
                std::thread::spawn(move || destinations.discard_book(&token).is_ok())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| usize::from(handle.join().expect("join")))
            .sum();
        assert_eq!(removed, 1);
        assert!(!target.exists());
    }

    #[test]
    fn a_discard_before_the_package_is_refused() {
        let (_dir, target, destinations, token) = picked();
        std::fs::write(&target, b"theirs").expect("theirs");
        assert!(destinations.discard_book(&token).is_err());
        destinations.claim(&token).expect("claim");
        assert!(destinations.discard_book(&token).is_err());
        assert_eq!(std::fs::read(&target).expect("read"), b"theirs");
    }

    #[test]
    fn a_discard_is_allowed_once() {
        let (_dir, target, destinations, token) = picked();
        destinations.claim(&token).expect("claim");
        destinations
            .commit(&token, staged_with(&target, b"book"))
            .expect("commit");
        destinations.discard_book(&token).expect("discard");
        assert_eq!(destinations.phase(&token), Some(Phase::Discarded));
        /* A NEW FILE AT THE NAME IS NOT TAKEN BY A SECOND DISCARD. */
        std::fs::write(&target, b"new").expect("new");
        assert!(destinations.discard_book(&token).is_err());
        assert_eq!(std::fs::read(&target).expect("read"), b"new");
    }

    #[test]
    fn a_discard_refuses_where_the_destination_existed_before_the_commit() {
        let (_dir, target, destinations, token) = picked();
        std::fs::write(&target, b"an earlier book").expect("earlier");
        destinations.claim(&token).expect("claim");
        destinations
            .commit(&token, staged_with(&target, b"book"))
            .expect("commit");
        let error = destinations.discard_book(&token).expect_err("refuses");
        assert!(error.contains("already at that destination"), "{error}");
        assert!(target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_discard_refuses_a_file_that_took_the_books_name_afterwards() {
        let (dir, target, destinations, token) = picked();
        destinations.claim(&token).expect("claim");
        destinations
            .commit(&token, staged_with(&target, b"book"))
            .expect("commit");
        let other = dir.path().join("other");
        std::fs::write(&other, b"someone else's").expect("other");
        std::fs::rename(&other, &target).expect("replace");
        assert!(destinations.discard_book(&token).is_err());
        assert_eq!(std::fs::read(&target).expect("read"), b"someone else's");
    }

    #[test]
    fn a_release_after_the_commit_is_a_no_op() {
        let (_dir, target, destinations, token) = picked();
        destinations.claim(&token).expect("claim");
        destinations
            .commit(&token, staged_with(&target, b"book"))
            .expect("commit");
        destinations.release(&token).expect("release");
        assert!(matches!(
            destinations.phase(&token),
            Some(Phase::Committed { existed: false, .. })
        ));
        assert!(target.exists());
        /* AND THE BOOK CAN STILL BE DISCARDED, which a release must not take. */
        destinations.discard_book(&token).expect("discard");
    }

    #[test]
    fn a_token_released_before_its_package_can_never_be_packaged() {
        let (_dir, _target, destinations, token) = picked();
        destinations.release(&token).expect("release");
        assert!(destinations.claim(&token).is_err());
    }

    #[test]
    fn a_token_released_during_its_package_can_never_commit() {
        let (_dir, target, destinations, token) = picked();
        destinations.claim(&token).expect("claim");
        destinations.release(&token).expect("release");
        let staged = staged_with(&target, b"book");
        let scratch = staged.path().to_path_buf();
        let error = destinations.commit(&token, staged).expect_err("refuses");
        assert!(error.contains("cancelled"), "{error}");
        assert!(!target.exists());
        assert!(
            !scratch.exists(),
            "the refused book was left beside the target"
        );
        /* AND THE TOKEN IS GONE, so nothing later can revive it. */
        assert!(destinations.claim(&token).is_err());
        assert!(destinations
            .commit(&token, staged_with(&target, b"x"))
            .is_err());
    }

    #[test]
    fn a_commit_whose_move_fails_forgets_its_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let destinations = Destinations::default();
        /* MORE FAILURES THAN THERE ARE LIVE PLACES, so a leak would show as
         * a refused pick. */
        for index in 0..MAX_LIVE_TOKENS + 1 {
            /* A NON-EMPTY DIRECTORY AT THE NAME, which no rename of a file
             * can replace. */
            let target = dir.path().join(format!("{index}.m4b"));
            std::fs::create_dir(&target).expect("dir");
            std::fs::write(target.join("inside"), b"x").expect("inside");
            destinations.room().expect("a failed commit held a place");
            let token = destinations.insert(target.clone()).expect("insert");
            destinations.claim(&token).expect("claim");
            let staged = staged_with(&target, b"book");
            let scratch = staged.path().to_path_buf();
            let error = destinations.commit(&token, staged).expect_err("refuses");
            assert!(error.contains("cannot move"), "{error}");
            assert_eq!(destinations.phase(&token), None);
            assert!(!scratch.exists(), "the unmoved book was left beside it");
            assert!(target.join("inside").exists());
        }
        destinations.room().expect("room");
    }

    #[test]
    fn an_unknown_token_is_refused_everywhere_except_release() {
        let destinations = Destinations::default();
        assert!(destinations.claim("nope").is_err());
        assert!(destinations.exists("nope").is_err());
        assert!(destinations.discard_book("nope").is_err());
        destinations
            .release("nope")
            .expect("a release of nothing is nothing");
    }

    #[test]
    fn the_live_tokens_are_capped_and_a_release_frees_a_place() {
        let destinations = Destinations::default();
        let mut tokens = Vec::new();
        for index in 0..MAX_LIVE_TOKENS {
            tokens.push(
                destinations
                    .insert(PathBuf::from(format!("/x/{index}.m4b")))
                    .expect("insert"),
            );
        }
        assert_eq!(destinations.room(), Err(Refused::TooManyTokens.to_string()));
        assert_eq!(
            destinations.insert(PathBuf::from("/x/over.m4b")),
            Err(Refused::TooManyTokens.to_string())
        );
        destinations.release(&tokens[0]).expect("release");
        destinations.room().expect("room");
    }

    #[test]
    fn exists_answers_for_the_destination() {
        let (_dir, target, destinations, token) = picked();
        assert!(!destinations.exists(&token).expect("exists"));
        std::fs::write(&target, b"x").expect("write");
        assert!(destinations.exists(&token).expect("exists"));
    }

    #[test]
    fn finished_tokens_are_forgotten_oldest_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        let destinations = Destinations::default();
        let mut tokens = Vec::new();
        for index in 0..KEPT_FINISHED + 3 {
            let target = dir.path().join(format!("{index}.m4b"));
            let token = destinations.insert(target.clone()).expect("insert");
            destinations.claim(&token).expect("claim");
            destinations
                .commit(&token, staged_with(&target, b"b"))
                .expect("commit");
            tokens.push(token);
        }
        assert_eq!(destinations.phase(&tokens[0]), None);
        assert!(destinations.phase(&tokens[KEPT_FINISHED + 2]).is_some());
    }

    #[test]
    fn the_window_is_told_the_name_and_not_the_path() {
        assert_eq!(
            Destinations::name_of(Path::new("/a/b/Book.m4b")),
            "Book.m4b"
        );
    }
}
