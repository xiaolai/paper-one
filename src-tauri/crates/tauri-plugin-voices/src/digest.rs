//! SHA-256 over a file, and the promotion that will not happen without it.
//!
//! Recovered from the deleted `tauri-plugin-inference`, where it carried four
//! rounds of audit fixes. The property it exists for is *"a stopped download
//! leaves no half-installed pack"*, and [`promote`] is where it lives: bytes are
//! verified in `staging/` and then RENAMED into `packs/`, so there is no window
//! in which a partly written file sits where an engine would load it.
//!
//! # Why SHA-256 and not BLAKE3
//!
//! BLAKE3 is already in the tree and is faster, and `tauri-plugin-peer` uses it
//! for blobs. It is the wrong hash here for one reason: those blobs are bytes
//! PAPER PRODUCED and is re-checking, so Paper picks the algorithm. A voice
//! pack's digest is published by whoever hosts it, and the only digest worth
//! checking is the one Paper can compare against that publication. Hugging Face
//! publishes SHA-256.

use std::path::Path;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::error::{Error, Result};

/// How much of a multi-gigabyte file to hold in memory at once.
///
/// A pack is 2.5 GB and the reader is using the machine for something else.
/// 1 MiB keeps the read syscall-efficient without the resident cost of a larger
/// window; the hash is I/O-bound at this size.
const CHUNK: usize = 1024 * 1024;

/// SHA-256 of a file, lowercase hex.
///
/// Streamed rather than read whole, which is not an optimisation: reading a
/// 1.8 GB artifact into a `Vec` to hash it is a 1.8 GB allocation on a machine
/// that may also be holding a loaded model.
///
/// # Errors
/// The underlying I/O failure.
pub async fn sha256_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let read = file.read(&mut buf).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(data_encoding::HEXLOWER.encode(&hasher.finalize()))
}

/// The size and digest the catalogue claims for one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    /// The artifact's path inside the pack, which is what a reader would look for.
    pub path: String,
    pub bytes: u64,
    /// Lowercase hex SHA-256.
    pub sha256: String,
}

/// Verify `staged` against `expected`, then rename it into `target`.
///
/// The order is deliberate and each step earns its place:
///
/// 1. **Size first.** One `stat` against a multi-gigabyte hash, and a truncated
///    download — the common failure — is caught before the expensive check runs.
/// 2. **Digest second.**
/// 3. **Rename last**, and only then. Everything before this point leaves
///    `target` exactly as it was.
///
/// A failure at 1 or 2 REMOVES the staged file. Leaving it would mean the next
/// attempt resumes onto bytes already known to be wrong — which, because a
/// resume skips a file that is already the declared size, is a pack that can
/// never install again and no way for the reader to clear it.
///
/// # Errors
/// [`Error::SizeMismatch`], [`Error::DigestMismatch`], or the I/O failure.
pub async fn promote(staged: &Path, target: &Path, expected: &Expected) -> Result<()> {
    let verified = verify(staged, expected).await;
    if verified.is_err() {
        // Best-effort: the error being reported is the interesting one, and a
        // staged file that could not be removed is rubbish in a scratch
        // directory rather than a wrong file where an engine would load it.
        let _ = tokio::fs::remove_file(staged).await;
        return verified;
    }
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(staged, target).await?;
    Ok(())
}

/// The two checks, without the rename. Split out so a caller can verify a file
/// already in place — which is what makes a pack auditable after the fact.
///
/// # Errors
/// [`Error::SizeMismatch`], [`Error::DigestMismatch`], or the I/O failure.
pub async fn verify(path: &Path, expected: &Expected) -> Result<()> {
    let meta = tokio::fs::metadata(path).await?;
    if meta.len() != expected.bytes {
        return Err(Error::SizeMismatch {
            path: expected.path.clone(),
            expected: expected.bytes,
            got: meta.len(),
        });
    }
    let got = sha256_file(path).await?;
    // Case-insensitive: a catalogue hand-edited to uppercase hex is still naming
    // the same digest, and refusing it would be pedantry wearing a security hat.
    if !got.eq_ignore_ascii_case(&expected.sha256) {
        return Err(Error::DigestMismatch {
            path: expected.path.clone(),
            expected: expected.sha256.clone(),
            got,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "paper-voices-digest-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// `printf 'hello' | shasum -a 256`
    const HELLO: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[tokio::test]
    async fn a_file_hashes_to_its_known_digest() {
        let dir = scratch();
        let file = dir.join("hello.txt");
        std::fs::write(&file, b"hello").expect("write");
        assert_eq!(sha256_file(&file).await.expect("hash"), HELLO);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_verified_file_is_renamed_into_place() {
        let dir = scratch();
        let staged = dir.join("staged");
        let target = dir.join("packs/english/model.bin");
        std::fs::write(&staged, b"hello").expect("write");
        let expected = Expected {
            path: "model.bin".into(),
            bytes: 5,
            sha256: HELLO.into(),
        };
        promote(&staged, &target, &expected).await.expect("promote");
        assert_eq!(std::fs::read(&target).expect("target"), b"hello");
        assert!(
            !staged.exists(),
            "the staged file moved rather than being copied"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_wrong_digest_leaves_the_previous_file_and_removes_the_staged_one() {
        let dir = scratch();
        let staged = dir.join("staged");
        let target = dir.join("model.bin");
        std::fs::write(&staged, b"tampered").expect("write");
        std::fs::write(&target, b"the one already here").expect("write");
        let expected = Expected {
            path: "model.bin".into(),
            bytes: 8,
            sha256: HELLO.into(),
        };
        let err = promote(&staged, &target, &expected)
            .await
            .expect_err("refused");
        assert!(matches!(err, Error::DigestMismatch { .. }), "{err}");
        assert_eq!(
            std::fs::read(&target).expect("target"),
            b"the one already here",
            "what was installed stays installed"
        );
        assert!(
            !staged.exists(),
            "a staged file known to be wrong must go, or every retry resumes onto it"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_short_file_is_named_a_size_failure_rather_than_a_digest_one() {
        let dir = scratch();
        let staged = dir.join("staged");
        std::fs::write(&staged, b"hell").expect("write");
        let expected = Expected {
            path: "model.bin".into(),
            bytes: 5,
            sha256: HELLO.into(),
        };
        let err = verify(&staged, &expected).await.expect_err("refused");
        assert!(
            matches!(
                err,
                Error::SizeMismatch {
                    expected: 5,
                    got: 4,
                    ..
                }
            ),
            "a truncated transfer reads as tampering unless it is named: {err}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_uppercase_digest_in_the_catalogue_still_matches() {
        let dir = scratch();
        let file = dir.join("hello.txt");
        std::fs::write(&file, b"hello").expect("write");
        let expected = Expected {
            path: "hello.txt".into(),
            bytes: 5,
            sha256: HELLO.to_uppercase(),
        };
        verify(&file, &expected)
            .await
            .expect("case is not the check");
        std::fs::remove_dir_all(&dir).ok();
    }
}
