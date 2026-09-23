//! What can go wrong while a pack is being fetched, and the name the reader is
//! given for it.
//!
//! Every variant here names WHAT failed, because the alternative — one
//! "download failed" — is the defect `sync/lib/status.ts` records at length: a
//! classifier that cannot tell a refusal from a truncation leaves nine written
//! sentences unreachable.

/// A failure a reader may see.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// The manifest itself is wrong — see `manifest::Refusal`.
    #[error("{0}")]
    Manifest(#[from] crate::manifest::Refusal),
    /// No pack in the catalogue answers to that id.
    #[error("there is no voice pack called {0}")]
    UnknownPack(String),
    /// A path from the manifest that may not be written.
    #[error("{0} is not a path inside the pack")]
    BadPath(String),
    #[error("{route} answered {status}")]
    Http { status: u16, route: String },
    #[error("{route} could not be reached: {why}")]
    Unreachable { route: String, why: String },
    #[error("{route} answered in a way this download cannot use: {why}")]
    Malformed { route: String, why: String },
    #[error("{path} arrived as {got} bytes where the catalogue says {expected}")]
    SizeMismatch {
        path: String,
        expected: u64,
        got: u64,
    },
    #[error("{path} did not match its digest: expected {expected}, got {got}")]
    DigestMismatch {
        path: String,
        expected: String,
        got: String,
    },
    /// The reader stopped it. Not a failure, and reported as neither.
    #[error("the download was stopped")]
    Cancelled,
}

/// The short name the front end branches on, never the message. The same rule
/// as the peer plugin's refusal kinds: a sentence is for a person to read, and
/// a kind is for code to switch on.
impl Error {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::Manifest(_) => "manifest",
            Self::UnknownPack(_) => "unknownPack",
            Self::BadPath(_) => "badPath",
            Self::Http { .. } => "http",
            Self::Unreachable { .. } => "unreachable",
            Self::Malformed { .. } => "malformed",
            Self::SizeMismatch { .. } => "sizeMismatch",
            Self::DigestMismatch { .. } => "digestMismatch",
            Self::Cancelled => "cancelled",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
