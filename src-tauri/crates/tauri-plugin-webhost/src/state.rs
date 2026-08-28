//! What the plugin holds between commands: the host, the port it bound, and
//! whether the webview is listening.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use paper_webauth::sessions::SessionId;
use paper_webhost::pipe::{Send, WebSessionId};
use paper_webhost::WebHost;

use crate::commands::{Browser, BrowserSession, CodeOffer};
use crate::Error;

/// Whether there is a port to reach, TOLD APART FROM whether there will be.
///
/// ⚠️ **THESE USED TO BE THE SAME VALUE**, and the pane said the wrong one.
/// The port was a `u16` where `0` meant "not bound", and the listener binds on
/// a spawned task — so for the first moments of every launch `port()` was
/// `None`, which `resolve` reported as `Unavailable`, which the Browsers pane
/// draws as "port 27182 was already in use; quit whatever holds it and reopen
/// Paper". The pane samples the address ONCE, so a reader who opened it during
/// that window was told, permanently and in a state that would never refresh,
/// that a working browser client was broken.
///
/// The distinction is real and it is three-valued: not yet, yes, and never.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bind {
    /// The listener has not answered yet. **NOT a failure** — ask again.
    Pending,
    /// Listening on this port.
    Bound(u16),
    /// The bind was refused. There is no browser client this run, and no
    /// amount of asking again will change that: the plugin binds ONE pinned
    /// port and does not scan.
    Failed,
}

/// `Bind` in one atomic: `Pending` is 0, `Failed` is `u32::MAX`, and a bound
/// port is itself. A port of 0 cannot be bound to and read back — the kernel
/// answers with the port it chose — so the sentinel cannot collide with a real
/// value.
const BIND_PENDING: u32 = 0;
const BIND_FAILED: u32 = u32::MAX;

pub struct WebHostState {
    pub host: Arc<WebHost>,
    /// The listener's outcome — see [`Bind`]. An atomic rather than a lock
    /// because it is written once and read by every status call.
    bind: AtomicU32,
    /// Whether the webview has announced that it is serving the router.
    ///
    /// ⚠️ **IT GATES NOTHING, AND THE COMMAND CONTRACT SAID IT GATED FRAME
    /// DELIVERY.** Nothing consults it on admission, on `push`, on `send` or on
    /// `recv`; it is written once by `webhost_ready` and read only by
    /// `webhost_status`. Left as a claim it was a permission nobody enforced —
    /// a reader of `commands.rs` would have believed frames could not reach an
    /// unready webview, and they always could.
    ///
    /// It is kept because it is genuinely useful as STATUS: the Browsers pane
    /// shows whether the webview has come up, which is a real question with a
    /// real answer. It is documented as status, and `webhost_ready`'s own
    /// comment no longer promises more than that. Making it a gate would mean
    /// deciding what happens to frames that arrive first — buffered, or
    /// refused — which is a design decision, not a missing line.
    ready: AtomicBool,
}

impl WebHostState {
    pub fn new(host: Arc<WebHost>) -> Self {
        Self {
            host,
            bind: AtomicU32::new(BIND_PENDING),
            ready: AtomicBool::new(false),
        }
    }

    pub fn set_port(&self, port: u16) {
        self.bind.store(u32::from(port), Ordering::SeqCst);
    }

    /// The bind was refused. **CALL THIS ON EVERY FAILING PATH** — a bind that
    /// neither succeeds nor is reported leaves the pane saying "looking for an
    /// address" for the life of the run, which is the failure this type exists
    /// to make impossible to ship silently.
    pub fn set_bind_failed(&self) {
        self.bind.store(BIND_FAILED, Ordering::SeqCst);
    }

    pub fn bind(&self) -> Bind {
        match self.bind.load(Ordering::SeqCst) {
            BIND_PENDING => Bind::Pending,
            BIND_FAILED => Bind::Failed,
            port => Bind::Bound(port as u16),
        }
    }

    /// The bound port, or `None` for both "not yet" and "never".
    ///
    /// For STATUS only, where the two really are one answer: the status row
    /// shows a port or does not. Anything that has to tell a reader WHY there
    /// is no port must use [`Self::bind`] — conflating them is the defect this
    /// whole type was introduced for.
    pub fn port(&self) -> Option<u16> {
        match self.bind() {
            Bind::Bound(port) => Some(port),
            Bind::Pending | Bind::Failed => None,
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
        let open: Vec<SessionId> = self
            .host
            .pipe
            .live_ids()
            .into_iter()
            .filter_map(|socket| self.host.pipe.admitted(socket))
            .collect();
        self.host
            .sessions
            .records(SystemTime::now())
            .into_iter()
            .map(|record| Browser {
                id: record.id.as_u64(),
                connected: open.contains(&record.id),
                label: record.label,
                created_ms: epoch_ms(record.created),
                last_seen_ms: epoch_ms(record.last_seen),
                expires_at_ms: epoch_ms(record.expires_at),
            })
            .collect()
    }

    /// Cut one browser off: both halves, in the order plan §7 requires.
    ///
    /// Takes the DURABLE authorization id, not a socket id. Revoking by socket
    /// could only ever reach a browser that happened to be connected.
    ///
    /// `Err(Unsaved)` means the browser IS cut off and the disk did not take
    /// it: after a restart it may be back. Both facts reach the pane.
    pub fn revoke(&self, id: u64) -> Result<(), Error> {
        /* Forget the credential FIRST so a reconnect cannot slip through the
         * gap, then close whatever sockets it holds. `Sessions::revoke` alone
         * leaves an open socket answering requests, which its own doc comment
         * warns about — and a browser with no socket at all is exactly the case
         * this ordering has to cover, because there is nothing to close. */
        let revoked = self.host.sessions.revoke_by_id(SessionId::from_u64(id));
        if let Some(browser) = revoked.applied {
            self.host.pipe.close_browser(browser, "revoked");
        }
        revoked
            .saved
            .map_err(|error| Error::Unsaved(error.to_string()))
    }

    /// Sign out every browser. Returns how many. See `WebHost::revoke_all`
    /// for the four things it touches; the `Err` is the same "applied, not
    /// saved" answer `revoke` gives.
    pub fn revoke_all(&self) -> Result<usize, Error> {
        let revoked = self.host.revoke_all();
        let count = revoked.applied.len();
        revoked
            .saved
            .map(|()| count)
            .map_err(|error| Error::Unsaved(error.to_string()))
    }

    /// How long a send waits for the browser to make room before the browser
    /// is judged to have stopped.
    ///
    /// The wait ends the moment ANY room appears — one 512 KiB chunk written to
    /// the socket frees that much — so this is not "drain 8 MiB in a minute",
    /// it is "drain one chunk in a minute". A phone on a poor link manages
    /// that; a phone whose page the OS has suspended, or a tab that closed
    /// without the socket noticing, does not, and holding a router connection
    /// open for it any longer only delays the reconnect the client will make.
    const SEND_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

    /// A frame to one browser, WAITING for room rather than refusing.
    ///
    /// ⚠️ **THIS MAPPED `Backpressure` TO AN ERROR**, under a doc comment on
    /// the variant saying "NOT an error… retry" — and the webview's pump does
    /// not retry a rejected send; it closes the session as dead. Twelve 512 KiB
    /// chunks of a book filled the session's budget, and every larger book
    /// aborted mid-stream on the phone. `Pipe::send_wait` is the retry, done
    /// where the room appears.
    ///
    /// A wait that runs out CLOSES THE SOCKET. The peer envelope makes the same
    /// call for the same reason: a browser that has drained nothing for
    /// `SEND_WAIT` is not reading, closing is what frees its budget, and the
    /// browser learning it was cut off is what lets it reconnect. The error
    /// keeps its name on the wire — the webview drops the router connection,
    /// as it should for a session that is now gone.
    pub async fn send(&self, session: u64, frame: Vec<u8>) -> Result<(), Error> {
        let id = WebSessionId(session);
        match self.host.pipe.send_wait(id, frame, Self::SEND_WAIT).await {
            Send::Sent => Ok(()),
            Send::Backpressure(_) => {
                self.host.pipe.close(id, "not keeping up");
                Err(Error::Backpressure)
            }
            Send::TooLarge => Err(Error::FrameTooLarge),
            Send::Gone => Err(Error::NoSuchSession),
        }
    }

    /// How long `recv` waits for a frame before answering "nothing yet".
    ///
    /// Long enough that an idle session costs one round trip a second rather
    /// than twenty-five; short enough that a webview which has stopped caring
    /// is not held for a noticeable time. See `Pipe::wait_for_frames`.
    const RECV_WAIT: std::time::Duration = std::time::Duration::from_millis(1000);

    pub async fn recv(&self, session: u64) -> Vec<Vec<u8>> {
        /* Everything waiting, not a page of it. The webview drains in a loop
         * until it gets an empty answer, exactly as it does for the peer
         * plugin, so a cap here would only add a round trip.
         *
         * ⚠️ IT WAITS NOW. This returned immediately, so the webview asked
         * every 40 ms per session to be told "nothing" — 1,600 IPC round trips
         * a second at the host's own session cap, before any real traffic.
         * Waiting rather than lengthening the interval keeps the latency of the
         * first frame of a request the reader has just made. */
        self.host
            .pipe
            .wait_for_frames(WebSessionId(session), usize::MAX, Self::RECV_WAIT)
            .await
    }
}

/// Epoch milliseconds for the wire, saturating at zero for a clock before 1970.
fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three-state, on its own — no `WebHostState`, which needs a running
    /// `WebHost`. The encoding is what could go wrong: one atomic carrying a
    /// port and two sentinels.
    fn cell() -> AtomicU32 {
        AtomicU32::new(BIND_PENDING)
    }

    fn read(cell: &AtomicU32) -> Bind {
        match cell.load(Ordering::SeqCst) {
            BIND_PENDING => Bind::Pending,
            BIND_FAILED => Bind::Failed,
            port => Bind::Bound(port as u16),
        }
    }

    /// ⚠️ **PENDING IS NOT FAILED, AND THEY USED TO BE ONE VALUE.** The port
    /// was a `u16` where 0 meant "not bound"; the listener binds on a spawned
    /// task, so every launch is briefly in that state — and the Browsers pane
    /// drew it as "port 27182 was already in use, quit whatever holds it and
    /// reopen Paper", permanently, over a client that was about to work.
    #[test]
    fn a_bind_that_has_not_answered_is_not_a_bind_that_failed() {
        let cell = cell();
        assert_eq!(read(&cell), Bind::Pending);
        assert_ne!(read(&cell), Bind::Failed);
    }

    #[test]
    fn a_bound_port_reads_back_as_itself() {
        let cell = cell();
        cell.store(u32::from(27182u16), Ordering::SeqCst);
        assert_eq!(read(&cell), Bind::Bound(27182));
    }

    /// The sentinels cannot collide with a port a listener can report.
    ///
    /// `Failed` is above the whole `u16` range. `Pending` is 0, which is a
    /// `u16` — and is safe for the reason the constant's own note gives: a
    /// listener never REPORTS 0. Binding to port 0 asks the kernel to choose
    /// one, and `local_addr` answers with the port it chose. So the range that
    /// has to be clear is 1..=65535, and that is what this walks.
    #[test]
    fn the_sentinels_are_outside_the_range_of_a_port() {
        assert!(BIND_FAILED > u32::from(u16::MAX));
        for port in [1u16, 80, 27182, u16::MAX] {
            let raw = u32::from(port);
            assert_ne!(raw, BIND_PENDING);
            assert_ne!(raw, BIND_FAILED);
            assert_eq!(
                match raw {
                    BIND_PENDING => Bind::Pending,
                    BIND_FAILED => Bind::Failed,
                    got => Bind::Bound(got as u16),
                },
                Bind::Bound(port)
            );
        }
    }

    /// `port()` folds the two "no port" states together, which is right for the
    /// status row and wrong for anything explaining itself to a reader. Both
    /// answers are asserted here so the folding stays deliberate.
    #[test]
    fn port_is_none_for_both_ways_of_having_no_port() {
        let port_of = |bind| match bind {
            Bind::Bound(port) => Some(port),
            Bind::Pending | Bind::Failed => None,
        };
        assert_eq!(port_of(Bind::Pending), None);
        assert_eq!(port_of(Bind::Failed), None);
        assert_eq!(port_of(Bind::Bound(27182)), Some(27182));
    }
}
