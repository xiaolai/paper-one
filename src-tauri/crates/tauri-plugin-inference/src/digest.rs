//! SHA-256 over a file, and the promotion that will not happen without it.
//!
//! WI-15.1's acceptance is *"an entry whose digest does not match is refused
//! at activation, and the previous slot is still the live one afterwards"*,
//! and WI-15.2's is *"killing the daemon mid-download leaves no partially
//! active artifact"*. Both are the same property from two directions, and
//! [`promote`] is where it lives: bytes are verified in `staging/` and then
//! RENAMED into `models/`, so there is no window in which a partially
//! written file is sitting in an activation slot.
//!
//! A rename within one directory tree is the atomic primitive this leans on.
//! It is why `staging/` is a sibling of `models/` and not a subdirectory of
//! somewhere else: `rename(2)` across filesystems is a copy, and a copy has
//! the window back.
//!
//! # Why SHA-256 and not BLAKE3
//!
//! BLAKE3 is already in the tree and is faster, and `tauri-plugin-peer` uses
//! it for blobs. It is the wrong hash here for one reason: those blobs are
//! bytes PAPER PRODUCED and is re-checking, so Paper picks the algorithm. A
//! model artifact's digest is published by whoever hosts it, and the only
//! digest worth checking is the one Paper can compare against that
//! publication. `models.manifest.json` records SHA-256 because that is what
//! the galleries publish.

use std::path::Path;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::error::{Error, Result};

/// How much of a multi-gigabyte file to hold in memory at once.
///
/// A model is 2.4 GB and the reader is using the machine for something else.
/// 1 MiB keeps the read syscall-efficient without the resident cost of a
/// larger window; the hash is I/O-bound at this size on every disk measured.
const CHUNK: usize = 1024 * 1024;

/// SHA-256 of a file, lowercase hex.
///
/// Streamed rather than read whole, which is not an optimisation: reading a
/// 2.4 GB artifact into a `Vec` to hash it is a 2.4 GB allocation on a
/// machine that is also holding a loaded model.
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

/// The size and digest a manifest entry claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub id: String,
    pub bytes: u64,
    /// Lowercase hex SHA-256.
    pub sha256: String,
}

/// Verify `staged` against `expected`, then rename it into `target`.
///
/// The order is deliberate and each step earns its place:
///
/// 1. **Size first.** It is one `stat` against a 2.4 GB hash, and a
///    truncated download — the common failure — is caught before the
///    expensive check runs.
/// 2. **Digest second.**
/// 3. **Rename last**, and only then. Everything before this point leaves
///    `target` exactly as it was, which is the "previous slot is still the
///    live one" half of the acceptance.
///
/// A failure at 1 or 2 REMOVES the staged file. Leaving it would mean the
/// next attempt resumes onto bytes already known to be wrong.
pub async fn promote(staged: &Path, target: &Path, expected: &Expected) -> Result<()> {
    let verified = verify(staged, expected).await;
    if verified.is_err() {
        // Best-effort: the error being reported is the interesting one, and a
        // staged file that could not be removed is rubbish in a scratch
        // directory rather than a wrong artifact in a live slot.
        let _ = tokio::fs::remove_file(staged).await;
        return verified;
    }
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(staged, target).await?;
    Ok(())
}

/// The two checks, without the rename. Split out so a caller can verify an
/// artifact already in place — the audit pass a settings pane can offer.
pub async fn verify(path: &Path, expected: &Expected) -> Result<()> {
    let meta = tokio::fs::metadata(path).await?;
    if meta.len() != expected.bytes {
        return Err(Error::SizeMismatch {
            id: expected.id.clone(),
            expected: expected.bytes,
            got: meta.len(),
        });
    }
    let got = sha256_file(path).await?;
    // Case-insensitive: a manifest hand-edited to uppercase hex is still
    // naming the same digest, and refusing it would be pedantry wearing a
    // security hat.
    if !got.eq_ignore_ascii_case(&expected.sha256) {
        return Err(Error::DigestMismatch {
            id: expected.id.clone(),
            expected: expected.sha256.clone(),
            got,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The SHA-256 of the empty input, and of `abc` — the published NIST
    /// vectors. A hash function tested only against its own output proves
    /// nothing.
    #[tokio::test]
    async fn matches_the_published_vectors() {
        let tmp = crate::testutil::ScratchDir::new("x");

        let empty = tmp.path().join("empty");
        tokio::fs::write(&empty, b"").await.unwrap();
        assert_eq!(
            sha256_file(&empty).await.unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let abc = tmp.path().join("abc");
        tokio::fs::write(&abc, b"abc").await.unwrap();
        assert_eq!(
            sha256_file(&abc).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// Larger than one CHUNK, so the streaming loop's boundary handling is
    /// exercised rather than assumed.
    #[tokio::test]
    async fn spans_more_than_one_chunk() {
        let tmp = crate::testutil::ScratchDir::new("x");
        let path = tmp.path().join("big");
        let bytes = vec![7u8; CHUNK * 2 + 13];
        tokio::fs::write(&path, &bytes).await.unwrap();

        let mut expect = Sha256::new();
        expect.update(&bytes);
        assert_eq!(
            sha256_file(&path).await.unwrap(),
            data_encoding::HEXLOWER.encode(&expect.finalize())
        );
    }

    async fn staged_with(tmp: &Path, contents: &[u8]) -> std::path::PathBuf {
        let staged = tmp.join("staged.part");
        tokio::fs::write(&staged, contents).await.unwrap();
        staged
    }

    #[tokio::test]
    async fn a_good_artifact_is_promoted() {
        let tmp = crate::testutil::ScratchDir::new("x");
        let staged = staged_with(tmp.path(), b"abc").await;
        let target = tmp.path().join("models/qwen/model.gguf");
        promote(
            &staged,
            &target,
            &Expected {
                id: "qwen".to_owned(),
                bytes: 3,
                sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                    .to_owned(),
            },
        )
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"abc");
        assert!(!staged.exists(), "the staged file moved rather than copied");
    }

    /// WI-15.1's acceptance, stated as a test: a bad digest is refused AND
    /// the previous slot survives.
    #[tokio::test]
    async fn a_bad_digest_leaves_the_previous_slot_live() {
        let tmp = crate::testutil::ScratchDir::new("x");
        let target = tmp.path().join("models/qwen/model.gguf");
        tokio::fs::create_dir_all(target.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&target, b"the previous model")
            .await
            .unwrap();

        let staged = staged_with(tmp.path(), b"abc").await;
        let err = promote(
            &staged,
            &target,
            &Expected {
                id: "qwen".to_owned(),
                bytes: 3,
                sha256: "0".repeat(64),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(err.kind(), "digestMismatch");
        assert_eq!(
            tokio::fs::read(&target).await.unwrap(),
            b"the previous model",
            "the live slot must be untouched by a failed activation"
        );
        assert!(
            !staged.exists(),
            "bytes known to be wrong must not be left for a resume to build on"
        );
    }

    #[tokio::test]
    async fn a_truncated_download_fails_on_size_before_it_is_hashed() {
        let tmp = crate::testutil::ScratchDir::new("x");
        let staged = staged_with(tmp.path(), b"ab").await;
        let err = verify(
            &staged,
            &Expected {
                id: "qwen".to_owned(),
                bytes: 3,
                sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                    .to_owned(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "sizeMismatch");
    }

    #[tokio::test]
    async fn uppercase_hex_in_a_manifest_still_matches() {
        let tmp = crate::testutil::ScratchDir::new("x");
        let staged = staged_with(tmp.path(), b"abc").await;
        verify(
            &staged,
            &Expected {
                id: "qwen".to_owned(),
                bytes: 3,
                sha256: "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
                    .to_owned(),
            },
        )
        .await
        .unwrap();
    }
}
