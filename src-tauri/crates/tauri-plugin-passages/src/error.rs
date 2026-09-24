//! What this plugin refuses with, and how a refusal reaches the webview.
//!
//! ⚠️ **A KIND, NOT A MESSAGE.** `src/capabilities/peer/lib/port.ts` records
//! what a plain `Error` costs across this boundary: `refusalKind` classifies by
//! the `kind` FIELD, so every failure that arrived as prose came out `unknown`
//! and every sentence written for a named cause was unreachable. The front end
//! branches on `kind`; `message` is for a person.

use serde::Serialize;

/// Everything that can go wrong, by the name the front end branches on.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The plugin has not been told where the data root is. Only reachable
    /// before `setup` has run, which is a defect rather than a state.
    #[error("the passages plugin has no data root yet")]
    NoRoot,

    /// A book id or a relative path that is not one Paper may write.
    #[error("{0} is not a path this plugin may use")]
    BadPath(String),

    /// The index will not open, or a segment will not read.
    #[error("the passage index could not be opened: {0}")]
    Index(String),

    /// A query this index cannot answer — an unbalanced quote, an empty query.
    #[error("{0}")]
    BadQuery(String),

    /// A stored file that is PRESENT and will not read.
    ///
    /// ⚠️ **NOT THE SAME AS ABSENT, AND THIS REPOSITORY HAS FIXED THAT
    /// CONFUSION IN EIGHTEEN STORES.** Absent means nothing was indexed yet and
    /// the answer is an empty index; present-and-unreadable means damage, and
    /// the caller is told so rather than being handed a blank page to save over
    /// it.
    #[error("{0} is there and will not read: {1}")]
    Damaged(String, String),

    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for Error {
    fn from(cause: std::io::Error) -> Self {
        Self::Io(cause.to_string())
    }
}

impl From<tantivy::TantivyError> for Error {
    fn from(cause: tantivy::TantivyError) -> Self {
        Self::Index(cause.to_string())
    }
}

impl Error {
    /// The word the front end branches on. One per variant, and no default:
    /// a variant added without a spelling here is a compile error.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NoRoot => "noRoot",
            Self::BadPath(_) => "badPath",
            Self::Index(_) => "index",
            Self::BadQuery(_) => "badQuery",
            Self::Damaged(_, _) => "damaged",
            Self::Io(_) => "io",
        }
    }
}

/// The wire shape of a refusal: a kind to branch on, a message to read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Refusal {
    kind: &'static str,
    message: String,
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        Refusal {
            kind: self.kind(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
