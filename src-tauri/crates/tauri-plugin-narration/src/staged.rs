//! A file written beside its destination and moved into place only once whole.
//!
//! ⚠️ **`File::create` ON THE DESTINATION TRUNCATES IT BEFORE ANY WORK HAPPENS.**
//! `render` did that before it had even resolved the voice, so a bad voice
//! identifier emptied whatever was at that path; `package` went further and
//! REMOVED the destination on any failure, including ones that happened before
//! it had written a byte. Either way a reader who exported over an existing
//! audiobook lost it to a failure that had nothing to do with the file.
//!
//! ⚠️ **CREATED EXCLUSIVELY, EVERY TIME.** `create_new` is `O_CREAT | O_EXCL`,
//! which POSIX defines to fail on ANY existing name — a symlink included, and
//! without following it. So a link planted at a scratch name is refused rather
//! than written through. `m4b::write` used to stage with a plain `fs::write`,
//! which follows a link and truncates whatever it points at; it uses this now.

use std::fs::File;
use std::path::{Path, PathBuf};

/// How many names are tried before giving up. Each is unique to the process
/// and the moment, so a collision means something else is making them.
const ATTEMPTS: u32 = 8;

/// A scratch file this process created and will remove unless it is committed.
#[derive(Debug)]
pub struct Staged {
    path: PathBuf,
    done: bool,
}

impl Staged {
    /// A new, empty scratch file in the directory `target` is in.
    pub fn beside(target: &Path, what: &str) -> Result<(Self, File), String> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Self::beside_with(target, what, stamp)
    }

    /// As [`Staged::beside`], with the stamp given — so a test can occupy every
    /// name it will try.
    pub fn beside_with(target: &Path, what: &str, stamp: u128) -> Result<(Self, File), String> {
        let parent = target
            .parent()
            .ok_or_else(|| format!("{} has no directory to write into", target.display()))?;
        for attempt in 0..ATTEMPTS {
            let path = parent.join(Self::name(what, stamp, attempt));
            match File::options().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok((Self { path, done: false }, file)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("cannot write beside {}: {error}", target.display()))
                }
            }
        }
        Err(format!(
            "cannot find an unused scratch name beside {}",
            target.display()
        ))
    }

    /// The name of attempt `attempt`. Every one begins `.paper-`, which is what
    /// a test looks for to prove none was left behind.
    pub fn name(what: &str, stamp: u128, attempt: u32) -> String {
        format!(
            ".paper-{what}-{}-{stamp}-{attempt}.part",
            std::process::id()
        )
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Move the finished file onto the destination. A rename within one
    /// directory is atomic, so the destination is either the old file or the
    /// whole new one — never half of either.
    pub fn commit(mut self, target: &Path) -> Result<(), String> {
        std::fs::rename(&self.path, target)
            .map_err(|error| format!("cannot move the finished file into place: {error}"))?;
        self.done = true;
        Ok(())
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        /* ⚠️ **ONLY EVER THIS FILE.** The destination is never removed: it may
         * be a book the reader already had, and no failure here is a reason to
         * take it from them. */
        if self.done {
            return;
        }
        /* ⚠️ **A FAILED CLEANUP IS SAID OUT LOUD.** A drop cannot return an
         * error, so it logs: a scratch file the size of the book left behind is
         * the failure nobody notices until a disk is full. */
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "narration: could not remove the scratch file {}: {error}",
                    self.path.display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_staged_file_is_gone_unless_it_is_committed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("book.m4b");
        let (staged, _) = Staged::beside(&target, "book").expect("stage");
        let path = staged.path().to_path_buf();
        assert!(path.is_file());
        drop(staged);
        assert!(
            !path.exists(),
            "an uncommitted scratch file was left behind"
        );
        assert!(!target.exists());
    }

    #[test]
    fn a_committed_file_is_at_the_destination_and_nowhere_else() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("book.m4b");
        let (staged, mut file) = Staged::beside(&target, "book").expect("stage");
        std::io::Write::write_all(&mut file, b"whole").expect("write");
        let path = staged.path().to_path_buf();
        staged.commit(&target).expect("commit");
        assert_eq!(std::fs::read(&target).expect("read"), b"whole");
        assert!(!path.exists());
    }

    #[test]
    fn it_gives_up_rather_than_reuse_a_name_once_every_name_is_taken() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("book.m4b");
        for attempt in 0..ATTEMPTS {
            std::fs::write(dir.path().join(Staged::name("book", 7, attempt)), b"theirs")
                .expect("occupy");
        }
        let error = Staged::beside_with(&target, "book", 7).expect_err("refuses");
        assert!(error.contains("unused scratch name"), "{error}");
        /* AND NOTHING THAT WAS THERE WAS TOUCHED. */
        for attempt in 0..ATTEMPTS {
            assert_eq!(
                std::fs::read(dir.path().join(Staged::name("book", 7, attempt))).expect("read"),
                b"theirs"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_planted_at_the_name_is_not_followed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("book.m4b");
        let victim = dir.path().join("victim");
        std::fs::write(&victim, b"keep me").expect("victim");
        std::os::unix::fs::symlink(&victim, dir.path().join(Staged::name("book", 9, 0)))
            .expect("plant");
        let (staged, mut file) = Staged::beside_with(&target, "book", 9).expect("stage");
        std::io::Write::write_all(&mut file, b"overwritten").expect("write");
        assert_eq!(
            staged.path().file_name().and_then(|n| n.to_str()),
            Some(Staged::name("book", 9, 1).as_str()),
            "the planted name was used"
        );
        assert_eq!(std::fs::read(&victim).expect("read"), b"keep me");
    }
}
