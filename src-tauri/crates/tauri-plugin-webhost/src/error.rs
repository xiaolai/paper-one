//! Typed refusals, so the webview matches on a code rather than a message.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no such browser session")]
    NoSuchSession,
    /// The browser drained nothing for `WebHostState::SEND_WAIT`, and its
    /// socket has been closed for it.
    ///
    /// ⚠️ This used to mean "no room right now, retry" — and the webview did
    /// not retry; it closed the session as dead, so every book larger than the
    /// session budget aborted mid-stream. The retry is in Rust now
    /// (`Pipe::send_wait`), so by the time this reaches the webview the wait
    /// has already been made and lost. Kept distinct from `NoSuchSession` so
    /// the pane can say WHY the browser went.
    #[error("the browser is not keeping up")]
    Backpressure,
    #[error("frame too large")]
    FrameTooLarge,
    /// A revocation was APPLIED — the browser is cut off now — and could not
    /// be written to `webhost/sessions.json`, so after a restart the browser
    /// may be back. Distinct from a failure to revoke, which does not exist:
    /// the in-memory half never fails. The pane has to say both halves, and
    /// the message carries the disk's reason.
    #[error("the change could not be saved: {0}")]
    Unsaved(String),
    /// A blocking task did not come back — it panicked, or the runtime is
    /// shutting down.
    ///
    /// Distinct from the three above on purpose: those are answers ABOUT a
    /// session, and a webview acts on each differently. Folding this into
    /// `NoSuchSession` — which is what it briefly was — would tell the pane a
    /// browser had gone away because a subprocess helper fell over, and the
    /// pane would have redrawn its list accordingly.
    #[error("the command could not be completed")]
    Internal,
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        /* The VARIANT NAME, not the message. A webview matching on prose is a
         * webview that breaks when the prose improves. */
        serializer.serialize_str(match self {
            Error::NoSuchSession => "no-such-session",
            Error::Backpressure => "backpressure",
            Error::FrameTooLarge => "frame-too-large",
            Error::Unsaved(_) => "unsaved",
            Error::Internal => "internal",
        })
    }
}
