//! What the plugin holds between commands: the host, the port it bound, and
//! whether the webview is listening.

use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Instant;

use paper_webhost::pipe::{Send, WebSessionId};
use paper_webhost::WebHost;

use crate::commands::{Browser, BrowserSession, CodeOffer};
use crate::Error;

pub struct WebHostState {
    pub host: Arc<WebHost>,
    /// 0 until the listener binds. An atomic rather than a lock because it is
    /// written once and read by every status call.
    port: AtomicU16,
    ready: AtomicBool,
}

impl WebHostState {
    pub fn new(host: Arc<WebHost>) -> Self {
        Self {
            host,
            port: AtomicU16::new(0),
            ready: AtomicBool::new(false),
        }
    }

    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::SeqCst);
    }

    pub fn port(&self) -> Option<u16> {
        match self.port.load(Ordering::SeqCst) {
            0 => None,
            port => Some(port),
        }
    }

    pub fn set_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn begin_code(&self) -> CodeOffer {
        let offer = self.host.auth.begin(Instant::now());
        CodeOffer {
            code: String::from_utf8_lossy(offer.code.digits()).into_owned(),
            expires_in_ms: offer.expires_in.as_millis() as u64,
        }
    }

    pub fn cancel_code(&self) {
        self.host.auth.cancel();
    }

    /// The live SOCKETS, for the webview's pump.
    ///
    /// ⚠️ **NOT THE LIST A READER REVOKES FROM** — see [`Self::browsers`]. These
    /// ids are what `webhost_session_recv` and `webhost_send` address, and they
    /// exist only while a socket is open. The two were one list, and conflating
    /// them is what made a disconnected browser unrevokable.
    pub fn sessions(&self) -> Vec<BrowserSession> {
        self.host
            .pipe
            .live_ids()
            .into_iter()
            .map(|WebSessionId(id)| BrowserSession { id })
            .collect()
    }

    /// Every browser that holds a credential, connected or not.
    ///
    /// This is what the Browsers pane lists. A browser that signed in and closed
    /// its tab keeps a credential for ninety days; it had no socket, so it was
    /// absent from the only list there was, and the reader had no way to cut it
    /// off before it came back.
    ///
    /// `connected` is derived rather than stored: a socket's `admitted` id is
    /// the authorization session it belongs to, so "is this browser here right
    /// now" is a question about the pipe and not a second piece of state to keep
    /// in step.
    pub fn browsers(&self) -> Vec<Browser> {
        let open: Vec<_> = self
            .host
            .pipe
            .live_ids()
            .into_iter()
            .filter_map(|socket| self.host.pipe.admitted(socket))
            .collect();
        self.host
            .sessions
            .live_sessions()
            .into_iter()
            .map(|id| Browser {
                id: id.as_u64(),
                connected: open.contains(&id),
            })
            .collect()
    }

    /// Cut one browser off: both halves, in the order plan §7 requires.
    ///
    /// Takes the DURABLE authorization id, not a socket id. Revoking by socket
    /// could only ever reach a browser that happened to be connected.
    pub fn revoke(&self, id: u64) {
        /* Forget the credential FIRST so a reconnect cannot slip through the
         * gap, then close whatever sockets it holds. `Sessions::revoke` alone
         * leaves an open socket answering requests, which its own doc comment
         * warns about — and a browser with no socket at all is exactly the case
         * this ordering has to cover, because there is nothing to close. */
        if let Some(credential) = self
            .host
            .sessions
            .revoke_by_id(paper_webauth::sessions::SessionId::from_u64(id))
        {
            self.host.pipe.close_credential(&credential, "revoked");
        }
    }

    pub fn send(&self, session: u64, frame: Vec<u8>) -> Result<(), Error> {
        match self.host.pipe.send(WebSessionId(session), frame) {
            Send::Sent => Ok(()),
            Send::Backpressure => Err(Error::Backpressure),
            Send::TooLarge => Err(Error::FrameTooLarge),
            Send::Gone => Err(Error::NoSuchSession),
        }
    }

    pub fn recv(&self, session: u64) -> Vec<Vec<u8>> {
        /* Everything waiting, not a page of it. The webview drains in a loop
         * until it gets an empty answer, exactly as it does for the peer
         * plugin, so a cap here would only add a round trip. */
        self.host.pipe.drain(WebSessionId(session), usize::MAX)
    }
}
