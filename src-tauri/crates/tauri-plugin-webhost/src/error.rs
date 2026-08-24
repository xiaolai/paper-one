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
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        /* The VARIANT NAME, not the message. A webview matching on prose is a
         * webview that breaks when the prose improves. */
        serializer.serialize_str(match self {
            Error::NoSuchSession => "no-such-session",
            Error::Backpressure => "backpressure",
            Error::FrameTooLarge => "frame-too-large",
        })
    }
}
