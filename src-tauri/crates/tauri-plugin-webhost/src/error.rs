//! Typed refusals, so the webview matches on a code rather than a message.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no such browser session")]
    NoSuchSession,
    /// The browser is not keeping up. NOT an error to retry immediately: the
    /// caller should wait and try again, which is why it is distinct from a
    /// dead session rather than folded into one "send failed".
    #[error("the browser is not keeping up")]
    Backpressure,
    #[error("frame too large")]
    FrameTooLarge,
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
            Error::Internal => "internal",
        })
    }
}
