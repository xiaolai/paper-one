//! The plugin's one error type, and how it crosses the IPC boundary.
//!
//! Every command returns `Result<T, Error>`. Over IPC an error serializes as
//! `{ "kind": "<camelCase tag>", "message": "<human text>" }`, so the webview
//! can branch on `kind` and never has to parse `message`. Keep the kinds
//! stable: they are the plugin's error contract with the TypeScript side.

use std::path::PathBuf;

use serde::ser::{Serialize, SerializeStruct, Serializer};

use crate::role::Role;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Tauri(#[from] tauri::Error),

    #[error("the iroh endpoint failed to bind: {0}")]
    Bind(#[from] iroh::endpoint::BindError),

    /// `fs_fsync` was handed a relative path. Paths are resolved against no
    /// working directory here — the caller states the whole path.
    #[error("path is not absolute: {}", .0.display())]
    PathNotAbsolute(PathBuf),

    /// The path contains a `..` component. Refused before any prefix check
    /// runs, because `<root>/../elsewhere` passes a naive prefix test.
    #[error("path contains a `..` component: {}", .0.display())]
    PathNotNormalized(PathBuf),

    /// The path is not under the storage root — lexically, or after symlinks
    /// are resolved.
    #[error("path {} is outside the data root {}", path.display(), root.display())]
    PathOutsideDataRoot { path: PathBuf, root: PathBuf },

    /// A path that has to travel over IPC as a string is not valid Unicode.
    #[error("path is not valid Unicode: {}", .0.display())]
    PathNotUnicode(PathBuf),

    /// `PAPER_TEST_DATA_DIR` was set to something other than an absolute path.
    #[error("PAPER_TEST_DATA_DIR must be an absolute path, got {}", .0.display())]
    DataRootNotAbsolute(PathBuf),

    /// `PAPER_ROLE` was set to something other than `shelf` or `satchel`. A
    /// misspelt override fails the command rather than quietly meaning
    /// "shelf".
    #[error("PAPER_ROLE must be `shelf` or `satchel`, got {0:?}")]
    UnknownRole(String),

    // ── identity ────────────────────────────────────────────────────────
    /// `peer/identity.key` exists but is not 32 bytes. Nothing is generated
    /// over it: a device that silently got a new identity would lose every
    /// pairing it had, and the file is worth a look first.
    #[error("identity key {} has {len} bytes, expected 32", path.display())]
    IdentityCorrupt { path: PathBuf, len: u64 },

    // ── peers ───────────────────────────────────────────────────────────
    /// `peer/peers.json` exists but does not parse. Never treated as an
    /// empty list — that would drop every paired device on a bad write.
    #[error("peers file {} is malformed: {source}", path.display())]
    PeersMalformed {
        path: PathBuf,
        source: serde_json::Error,
    },

    /// `peer/peers.json` declares a format this build does not speak.
    /// Refused rather than read as version 1 — a future format silently
    /// reinterpreted is a store scrambled with every field looking fine.
    #[error("peers file {} is format {version}; this build speaks {supported}", path.display())]
    PeersUnsupportedVersion {
        path: PathBuf,
        version: u32,
        supported: u32,
    },

    /// A string that should name a peer is not an iroh endpoint id.
    #[error("not an endpoint id: {0:?}")]
    InvalidPeerId(String),

    /// No record with that id.
    #[error("unknown peer {0}")]
    PeerUnknown(String),

    // ── paths ───────────────────────────────────────────────────────────
    /// A blob folder name outside `^[A-Za-z0-9_]{1,80}$`.
    #[error("invalid blob folder name {0:?}")]
    InvalidFolder(String),

    /// A blob name outside the closed set.
    #[error("invalid blob name {0:?}")]
    InvalidBlobName(String),

    /// A blob name that may be served but never written (`cover.webp`).
    #[error("blob name {0:?} is read-only")]
    ReadOnlyBlobName(String),

    /// The book folder a transfer was writing into is no longer there —
    /// trashed mid-transfer. The `.part` is not promoted and the folder is
    /// not recreated.
    #[error("book folder {0:?} is gone")]
    FolderGone(String),

    // ── network ─────────────────────────────────────────────────────────
    #[error("connect failed: {0}")]
    Connect(#[from] iroh::endpoint::ConnectError),

    #[error("connection error: {0}")]
    Connection(#[from] iroh::endpoint::ConnectionError),

    #[error("stream write failed: {0}")]
    StreamWrite(#[from] iroh::endpoint::WriteError),

    #[error("stream read failed: {0}")]
    StreamRead(#[from] iroh::endpoint::ReadError),

    #[error("stream ended early: {0}")]
    StreamReadExact(#[from] iroh::endpoint::ReadExactError),

    #[error("stream already closed: {0}")]
    StreamClosed(#[from] iroh::endpoint::ClosedStream),

    /// A frame's declared length is above the cap (`frame::MAX_FRAME`,
    /// carried here so the message cannot go stale if the cap moves).
    /// Nothing was allocated for it.
    #[error("frame of {size} bytes exceeds the {max}-byte cap")]
    FrameTooLarge { size: u32, max: u32 },

    /// A control frame (hello, pairing, blob request/header) did not parse.
    #[error("malformed control frame: {0}")]
    FrameMalformed(String),

    /// The remote closed, or something did not arrive, within the deadline.
    #[error("timed out: {0}")]
    Timeout(&'static str),

    // ── pairing ─────────────────────────────────────────────────────────
    #[error("invalid pairing URI: {0}")]
    PairUriInvalid(String),

    #[error("unsupported pairing version {0:?}")]
    UnsupportedPairVersion(String),

    /// The remote's role is not the one this step requires (a satchel must
    /// dial a shelf; on `peer/1` the role in the hello must match the
    /// persisted one).
    #[error("role mismatch: expected {expected:?}, got {got:?}")]
    RoleMismatch { expected: Role, got: Role },

    /// `peer_pair_confirm` was called with no satchel waiting.
    #[error("no pairing awaiting confirmation")]
    NoPendingPairing,

    /// The shelf said no — with its reason string (`refused`, `bad-mac`,
    /// `expired`, `no-pending`, `timeout`, `role-mismatch`, `bad-ack-mac`).
    #[error("pairing refused: {0}")]
    PairingRefused(String),

    // ── sessions ────────────────────────────────────────────────────────
    /// The remote closed the connection during the plugin hello, with the
    /// reason it gave (`unknown-peer`, `not-ready`, `role-mismatch`, …).
    #[error("session refused: {0}")]
    SessionRefused(String),

    #[error("unknown session {0}")]
    SessionUnknown(u64),

    /// The session cap (global or per-peer) is reached; a further session is
    /// refused rather than letting a peer spawn unbounded connections/tasks.
    #[error("too many open sessions")]
    TooManySessions,

    /// A blob fetch needs an open session with the peer; there is none.
    #[error("no open session with peer {0}")]
    NoSession(String),

    // ── blobs ───────────────────────────────────────────────────────────
    /// The serving side declined before sending a byte (`ungranted`,
    /// `not-found`, `invalid-folder`, `invalid-name`, `bad-offset`).
    #[error("blob refused: {0}")]
    BlobRefused(String),

    /// The server's header disagrees with what the caller expected. The
    /// caller's record is stale, or the remote's file changed.
    #[error("blob header mismatch: expected {expected}, got {got}")]
    BlobMismatch { expected: String, got: String },

    /// The bytes that arrived do not hash to the expected BLAKE3. The
    /// `.part` was deleted.
    #[error("blob hash mismatch")]
    BlobHashMismatch,

    /// The advertised (or requested) blob size is above the accepted maximum.
    /// Refused before a byte is written, so a peer cannot fill the disk with a
    /// huge or lying size.
    #[error("blob of {size} bytes exceeds the {max}-byte maximum")]
    BlobTooLarge { size: u64, max: u64 },

    /// The stream ended before `size` bytes arrived. The `.part` is kept
    /// for a resume.
    #[error("blob transfer interrupted after {received} of {total} bytes")]
    BlobInterrupted { received: u64, total: u64 },

    /// A transfer into that target is already running.
    #[error("a transfer into {0} is already running")]
    TransferBusy(String),
}

impl Error {
    /// The stable tag the webview switches on.
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Io(_) => "io",
            Error::Tauri(_) => "tauri",
            Error::Bind(_) => "bind",
            Error::PathNotAbsolute(_) => "pathNotAbsolute",
            Error::PathNotNormalized(_) => "pathNotNormalized",
            Error::PathOutsideDataRoot { .. } => "pathOutsideDataRoot",
            Error::PathNotUnicode(_) => "pathNotUnicode",
            Error::DataRootNotAbsolute(_) => "dataRootNotAbsolute",
            Error::UnknownRole(_) => "unknownRole",
            Error::IdentityCorrupt { .. } => "identityCorrupt",
            Error::PeersMalformed { .. } => "peersMalformed",
            Error::PeersUnsupportedVersion { .. } => "peersUnsupportedVersion",
            Error::InvalidPeerId(_) => "invalidPeerId",
            Error::PeerUnknown(_) => "peerUnknown",
            Error::InvalidFolder(_) => "invalidFolder",
            Error::InvalidBlobName(_) => "invalidBlobName",
            Error::ReadOnlyBlobName(_) => "readOnlyBlobName",
            Error::FolderGone(_) => "folderGone",
            Error::Connect(_) => "connect",
            Error::Connection(_) => "connection",
            Error::StreamWrite(_) => "streamWrite",
            Error::StreamRead(_) => "streamRead",
            Error::StreamReadExact(_) => "streamReadExact",
            Error::StreamClosed(_) => "streamClosed",
            Error::FrameTooLarge { .. } => "frameTooLarge",
            Error::FrameMalformed(_) => "frameMalformed",
            Error::Timeout(_) => "timeout",
            Error::PairUriInvalid(_) => "pairUriInvalid",
            Error::UnsupportedPairVersion(_) => "unsupportedPairVersion",
            Error::RoleMismatch { .. } => "roleMismatch",
            Error::NoPendingPairing => "noPendingPairing",
            Error::PairingRefused(_) => "pairingRefused",
            Error::SessionRefused(_) => "sessionRefused",
            Error::SessionUnknown(_) => "sessionUnknown",
            Error::TooManySessions => "tooManySessions",
            Error::NoSession(_) => "noSession",
            Error::BlobRefused(_) => "blobRefused",
            Error::BlobMismatch { .. } => "blobMismatch",
            Error::BlobHashMismatch => "blobHashMismatch",
            Error::BlobTooLarge { .. } => "blobTooLarge",
            Error::BlobInterrupted { .. } => "blobInterrupted",
            Error::TransferBusy(_) => "transferBusy",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("Error", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// The shared root resolver's failures, as this plugin's kinds — so the wire
/// sees `dataRootNotAbsolute` and `io` exactly as it always did.
impl From<paper_data_root::Error> for Error {
    fn from(err: paper_data_root::Error) -> Self {
        match err {
            paper_data_root::Error::NotAbsolute(path) => Error::DataRootNotAbsolute(path),
            paper_data_root::Error::Io(io) => Error::Io(io),
            paper_data_root::Error::Tauri(tauri) => Error::Tauri(tauri),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_kind_and_message() {
        let err = Error::PathNotAbsolute(PathBuf::from("books/a"));
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "pathNotAbsolute");
        assert_eq!(json["message"], "path is not absolute: books/a");
    }

    #[test]
    fn every_kind_is_distinct() {
        // `Bind`, `Tauri` and the iroh stream/connection errors wrap foreign
        // non-exhaustive types that cannot be constructed here; their tags
        // (`bind`, `tauri`, `connect`, `connection`, `streamWrite`,
        // `streamRead`, `streamReadExact`, `streamClosed`) are distinct from
        // the rest by inspection.
        let all = [
            Error::Io(std::io::Error::other("x")).kind(),
            Error::PathNotAbsolute(PathBuf::new()).kind(),
            Error::PathNotNormalized(PathBuf::new()).kind(),
            Error::PathOutsideDataRoot {
                path: PathBuf::new(),
                root: PathBuf::new(),
            }
            .kind(),
            Error::PathNotUnicode(PathBuf::new()).kind(),
            Error::DataRootNotAbsolute(PathBuf::new()).kind(),
            Error::UnknownRole(String::new()).kind(),
            Error::IdentityCorrupt {
                path: PathBuf::new(),
                len: 0,
            }
            .kind(),
            Error::PeersMalformed {
                path: PathBuf::new(),
                source: serde_json::from_str::<u8>("x").unwrap_err(),
            }
            .kind(),
            Error::PeersUnsupportedVersion {
                path: PathBuf::new(),
                version: 0,
                supported: 0,
            }
            .kind(),
            Error::InvalidPeerId(String::new()).kind(),
            Error::PeerUnknown(String::new()).kind(),
            Error::InvalidFolder(String::new()).kind(),
            Error::InvalidBlobName(String::new()).kind(),
            Error::ReadOnlyBlobName(String::new()).kind(),
            Error::FolderGone(String::new()).kind(),
            Error::FrameTooLarge { size: 0, max: 0 }.kind(),
            Error::FrameMalformed(String::new()).kind(),
            Error::Timeout("").kind(),
            Error::PairUriInvalid(String::new()).kind(),
            Error::UnsupportedPairVersion(String::new()).kind(),
            Error::RoleMismatch {
                expected: Role::Shelf,
                got: Role::Satchel,
            }
            .kind(),
            Error::NoPendingPairing.kind(),
            Error::PairingRefused(String::new()).kind(),
            Error::SessionRefused(String::new()).kind(),
            Error::SessionUnknown(0).kind(),
            Error::TooManySessions.kind(),
            Error::NoSession(String::new()).kind(),
            Error::BlobRefused(String::new()).kind(),
            Error::BlobMismatch {
                expected: String::new(),
                got: String::new(),
            }
            .kind(),
            Error::BlobHashMismatch.kind(),
            Error::BlobTooLarge { size: 0, max: 0 }.kind(),
            Error::BlobInterrupted {
                received: 0,
                total: 0,
            }
            .kind(),
            Error::TransferBusy(String::new()).kind(),
        ];
        let unique: std::collections::BTreeSet<_> = all.iter().collect();
        assert_eq!(unique.len(), all.len());
        // The wrapped-foreign variants named in the comment above, by
        // inspection of `kind()` — folded into the same uniqueness check, so
        // a new variant that reuses one of THEIR tags fails here too instead
        // of hiding behind "cannot be constructed".
        let foreign = [
            "bind",
            "tauri",
            "connect",
            "connection",
            "streamWrite",
            "streamRead",
            "streamReadExact",
            "streamClosed",
        ];
        let with_foreign: std::collections::BTreeSet<&str> =
            all.iter().copied().chain(foreign).collect();
        assert_eq!(with_foreign.len(), all.len() + foreign.len());
    }
}
