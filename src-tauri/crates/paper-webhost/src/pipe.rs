//! The frame pipe: a browser's WebSocket on one side, the webview on the other
//! (phase 18, WI-18.4b).
//!
//! ## Why this carries frames instead of answering anything
//!
//! The service router lives in TypeScript. `serve(services)` is a method on the
//! webview's peer port, and `HANDLERS` in `services/handlers.ts` is typed over
//! `serviceTable.ts` so a row without a handler will not compile. There is no
//! second copy of that in Rust and there must not be: a server that answered
//! `book.list` here would be a second implementation of every service, drifting
//! from the first the day either changed.
//!
//! So this is a pipe. Bytes from the browser land in a session's inbox and the
//! webview drains them; bytes from the webview go back out. Exactly the shape
//! `tauri-plugin-peer`'s `session.rs` has, for exactly the same reason.
//!
//! ## The bounds are copied deliberately, and so is the distinction between them
//!
//! `session.rs` learned this the expensive way and its comment says so: a
//! frame-count cap alone allowed "4096 frames of up to 4 MiB … ~16 GiB per
//! session". The byte budget is the real memory ceiling and the frame count is
//! a secondary bound against a flood of tiny frames.
//!
//! Two failures that look alike and are not:
//!
//!   - **Over budget** is [`Push::Backpressure`], which HANDS THE FRAME BACK.
//!     The session is fine; the caller stops reading the socket until the
//!     webview drains, and retries the frame it is still holding.
//!
//!     ⚠️ This used to say "nothing is dropped … TCP does the rest, as QUIC flow
//!     control does for the peer", and the analogy is what made it wrong. QUIC
//!     flow control acts before the peer's data is acknowledged; by the time
//!     `push` is called the WebSocket message has already been reassembled and
//!     ACKed, so there is nothing left for TCP to retransmit. The caller in
//!     `lib.rs` believed the sentence, yielded, and let the frame drop. The
//!     variant carries the bytes now, so the promise is enforced by the type
//!     rather than by this paragraph.
//!   - **Over `MAX_FRAME`** is [`Push::TooLarge`], which **closes the session**.
//!     A frame larger than the ceiling is not a busy peer, it is a peer not
//!     speaking the protocol, and `session.rs` closes for it at once.
//!
//! Collapsing those two would either drop data under load or keep a
//! protocol-violating socket open. Both have a test here.
//!
//! ## Revocation reaches in here
//!
//! Plan §7 lists four things a revocation must touch, and the one
//! `paper_webauth` could not own is the live channel. [`Pipe::close_credential`]
//! is that half: revoking a credential closes every session it opened, so a
//! browser cannot keep answering on a socket it already had.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use paper_webauth::sessions::{Credential, SessionId};
use tokio::sync::{mpsc, Notify};

/// The largest frame this side will accept. The peer transport's number, so a
/// service answer that fits one wire fits the other.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;
/// Frames buffered before the reader stops pulling. Secondary to the bytes.
pub const INBOX_CAP: usize = 4096;
/// The real memory ceiling per session.
pub const INBOX_BYTE_CAP: usize = 8 * 1024 * 1024;
/// Sessions across every browser — a bound on tasks and descriptors.
pub const MAX_SESSIONS: usize = 64;
/// Sessions one credential may hold at once. A tab reconnecting can overlap a
/// not-yet-reaped drop; a browser opening many is refused.
pub const MAX_SESSIONS_PER_CREDENTIAL: usize = 4;
/// Frames queued toward one browser before the webview is told to slow down.
///
/// Bounded rather than unbounded, and that is the whole point: an unbounded
/// channel turns a browser that has stopped reading into memory growth on the
/// shelf, which is the same bug the inbox's byte budget exists to prevent —
/// only pointing the other way.
///
/// ⚠️ **A FRAME COUNT IS NOT A MEMORY BOUND**, which the module header says
/// about the inbox and this constant then ignored. 256 slots at up to
/// [`MAX_FRAME`] is ~1 GiB queued toward ONE browser, and [`MAX_SESSIONS`] of
/// them is ~64 GiB — arrived at by exactly the reasoning the inbox's own cap
/// was written to refuse, one direction over. [`OUTBOUND_BYTE_CAP`] is the real
/// ceiling; this stays as the secondary bound against a flood of tiny frames,
/// which is the shape a byte budget cannot see.
pub const OUTBOUND_CAP: usize = 256;
/// The real memory ceiling for what is queued toward one browser.
///
/// The inbox's number, and deliberately the same: the two queues hold the same
/// kind of thing for the same reason, and two ceilings that differ invite the
/// question of why without having an answer.
pub const OUTBOUND_BYTE_CAP: usize = 8 * 1024 * 1024;
/// The ceiling across EVERY browser at once.
///
/// ⚠️ **A PER-SESSION CAP IS NOT A HOST CAP**, which is the same mistake a frame
/// count makes one level down and is just as easy to stop at. `OUTBOUND_BYTE_CAP`
/// alone permits 8 MiB × [`MAX_SESSIONS`] = 512 MiB of queued output before
/// anything refuses — reachable by sixty-four browsers each behaving perfectly
/// reasonably and none of them individually over its own budget.
///
/// A quarter of the per-session sum: generous for the realistic case (a handful
/// of browsers, one of them streaming a book) and far below the arithmetic that
/// makes the per-session cap look sufficient.
pub const OUTBOUND_BYTE_CAP_GLOBAL: usize = 128 * 1024 * 1024;

/// A live browser socket.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct WebSessionId(pub u64);

/// Why a socket was not accepted.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenRefused {
    /// The whole host is at its ceiling.
    TooManySessions,
    /// This credential already holds its share.
    TooManyForCredential,
}

/// What happened to a frame bound for the browser.
#[derive(Debug, PartialEq, Eq)]
pub enum Send {
    /// Queued for the socket.
    Sent,
    /// The browser is not keeping up. Nothing dropped; try again after a wait.
    Backpressure,
    /// Over [`MAX_FRAME`]. Refused WITHOUT closing — a frame this big coming
    /// from our own webview is a bug on this side, not a hostile peer, and
    /// killing the reader's session over it would hide the bug behind a
    /// disconnect.
    TooLarge,
    /// No such session, or it is closed, or the socket task is gone.
    Gone,
}

/// What happened to a frame from the browser.
#[derive(Debug, PartialEq, Eq)]
pub enum Push {
    /// Buffered for the webview.
    Accepted,
    /// Over budget. **Carries the frame back**, because "nothing dropped" has to
    /// be something the type system says rather than something a comment claims.
    ///
    /// It claimed it and was wrong. The caller in `lib.rs` matched this variant,
    /// yielded, and let the frame — a local it still owned — fall out of scope,
    /// under a note explaining that the browser would retransmit it. The browser
    /// would not: `ws.recv()` had already returned the message, so it was
    /// acknowledged at the TCP layer long before the inbox refused it. One
    /// request or response of the envelope vanished, under load only, in
    /// silence. Handing the frame back makes losing it take an explicit `_`.
    Backpressure(Vec<u8>),
    /// Over [`MAX_FRAME`]. The session is now closed.
    TooLarge,
    /// No such session, or it is already closed.
    Gone,
}

struct WebSession {
    credential: Credential,
    /// The authorization session this socket belongs to, kept so a caller can
    /// tie a socket back to what admitted it.
    admitted: SessionId,
    inbox: VecDeque<Vec<u8>>,
    inbox_bytes: usize,
    /// Toward the browser. Dropped on close, which ends the socket's write
    /// task without needing a second signal.
    outbound: Option<mpsc::Sender<Vec<u8>>>,
    /// Woken when a frame lands in `inbox`, so a reader can WAIT for one
    /// rather than ask again in a moment. See [`Pipe::wait_for_frames`].
    arrived: Arc<Notify>,
    /// Bytes handed to `outbound` and not yet reported drained by the pump.
    ///
    /// The channel counts messages, so this is the only place the SIZE of what
    /// is queued exists. It is decremented by [`Pipe::drained`], which the pump
    /// calls for each frame it takes off the channel — the queue's other end is
    /// in `lib.rs`, so the count cannot be maintained here alone.
    outbound_bytes: usize,
    closed: Option<String>,
}

#[derive(Default)]
struct Inner {
    next: u64,
    sessions: HashMap<WebSessionId, WebSession>,
    /// Bytes queued toward EVERY browser. See [`OUTBOUND_BYTE_CAP_GLOBAL`].
    outbound_bytes_total: usize,
}

/// Mark a session closed and give up everything queued on it, in BOTH
/// directions. Returns the outbound bytes the host's total should release.
///
/// ⚠️ ONE PLACE, because there were three and one of them was wrong. `close`,
/// `close_credential` and `reap` each abandoned a session's queues by hand;
/// dropping the outbound sender discards whatever tokio had buffered, and the
/// per-session byte count went with the record — but `outbound_bytes_total` was
/// left holding bytes no longer queued anywhere. It only ever grew. A few
/// revocations and every browser is backpressured against a budget nothing is
/// using, which is a shelf that has silently stopped answering.
fn abandon(session: &mut WebSession, reason: &str) -> usize {
    if session.closed.is_none() {
        session.closed = Some(reason.to_owned());
    }
    /* WAKE A WAITER SO IT SEES THE CLOSE. Without this a `wait_for_frames`
     * already parked on this session sits out its whole timeout before
     * noticing, which turns a revocation into a delay. */
    session.arrived.notify_one();
    session.inbox.clear();
    session.inbox_bytes = 0;
    let freed = session.outbound_bytes;
    session.outbound_bytes = 0;
    /* DROPPING THE SENDER IS THE SIGNAL. The socket's write task is awaiting
     * this channel; closing it ends that task without a second flag to keep in
     * step. Whatever tokio had buffered goes with it, which is exactly why the
     * bytes have to be released here. */
    session.outbound = None;
    freed
}

/// Every live browser socket and the frames waiting on each.
#[derive(Default)]
pub struct Pipe {
    inner: Mutex<Inner>,
}

impl Pipe {
    pub fn new() -> Self {
        Self::default()
    }

    /// Accept a socket that has already been admitted.
    ///
    /// Takes the [`SessionId`] rather than a credential alone so a socket
    /// cannot exist without an admission having happened — the two-phase check
    /// in `paper_webauth::sessions` is what produces one.
    pub fn open(
        &self,
        admitted: SessionId,
        credential: Credential,
        outbound: mpsc::Sender<Vec<u8>>,
    ) -> Result<WebSessionId, OpenRefused> {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        if guard.sessions.len() >= MAX_SESSIONS {
            return Err(OpenRefused::TooManySessions);
        }
        let held = guard
            .sessions
            .values()
            .filter(|s| s.credential == credential && s.closed.is_none())
            .count();
        if held >= MAX_SESSIONS_PER_CREDENTIAL {
            return Err(OpenRefused::TooManyForCredential);
        }
        guard.next += 1;
        let id = WebSessionId(guard.next);
        guard.sessions.insert(
            id,
            WebSession {
                credential,
                admitted,
                inbox: VecDeque::new(),
                inbox_bytes: 0,
                arrived: Arc::new(Notify::new()),
                outbound: Some(outbound),
                outbound_bytes: 0,
                closed: None,
            },
        );
        Ok(id)
    }

    /// A frame from the browser, bound for the webview.
    pub fn push(&self, id: WebSessionId, frame: Vec<u8>) -> Push {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        let Some(session) = guard.sessions.get_mut(&id) else {
            return Push::Gone;
        };
        if session.closed.is_some() {
            return Push::Gone;
        }
        /* A PROTOCOL VIOLATION, NOT A BUSY PEER. Checked before the budget so
         * an oversized frame arriving at a full inbox still closes rather than
         * being reported as backpressure and retried forever. */
        if frame.len() > MAX_FRAME {
            session.closed = Some("frame too large".to_owned());
            session.inbox.clear();
            session.inbox_bytes = 0;
            return Push::TooLarge;
        }
        if session.inbox.len() >= INBOX_CAP
            || session.inbox_bytes.saturating_add(frame.len()) > INBOX_BYTE_CAP
        {
            /* The frame goes back to the caller rather than out of scope here.
             * See the note on `Push::Backpressure`. */
            return Push::Backpressure(frame);
        }
        session.inbox_bytes += frame.len();
        session.inbox.push_back(frame);
        /* WAKE ANYONE WAITING. `Notify` stores one permit, so a wake that
         * arrives between a drain finding nothing and the waiter awaiting is
         * kept rather than lost. */
        session.arrived.notify_one();
        Push::Accepted
    }

    /// A frame from the webview, bound for the browser. Never waits.
    pub fn send(&self, id: WebSessionId, frame: Vec<u8>) -> Send {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        /* THE HOST'S BUDGET FIRST, before the session's. Sixty-four sessions
         * each inside their own 8 MiB is half a gigabyte the host never agreed
         * to. Read before the mutable borrow below, which the shared total
         * cannot coexist with. */
        let total = guard.outbound_bytes_total;
        let Some(session) = guard.sessions.get_mut(&id) else {
            return Send::Gone;
        };
        if total.saturating_add(frame.len()) > OUTBOUND_BYTE_CAP_GLOBAL {
            return Send::Backpressure;
        }
        if frame.len() > MAX_FRAME {
            return Send::TooLarge;
        }
        /* THE BYTE BUDGET, checked before the channel's slot count. A browser
         * that stops reading holds whatever is queued; 256 slots said nothing
         * about how much that is. See `OUTBOUND_BYTE_CAP`. */
        if session.outbound_bytes.saturating_add(frame.len()) > OUTBOUND_BYTE_CAP {
            return Send::Backpressure;
        }
        let Some(outbound) = session.outbound.as_ref() else {
            return Send::Gone;
        };
        let len = frame.len();
        match outbound.try_send(frame) {
            Ok(()) => {
                session.outbound_bytes += len;
                guard.outbound_bytes_total += len;
                Send::Sent
            }
            Err(mpsc::error::TrySendError::Full(_)) => Send::Backpressure,
            Err(mpsc::error::TrySendError::Closed(_)) => Send::Gone,
        }
    }

    /// The pump took `bytes` off the outbound channel; free that much budget.
    ///
    /// The queue's far end lives in `lib.rs`, so this count cannot be kept here
    /// alone. Saturating rather than asserting: a close can clear the record
    /// between the `recv` and this call, and turning that race into a panic
    /// would trade a leak nobody notices for a crash everybody does.
    pub fn drained(&self, id: WebSessionId, bytes: usize) {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        if let Some(session) = guard.sessions.get_mut(&id) {
            /* THE SESSION'S OWN COUNT DECIDES HOW MUCH THE HOST RELEASES, and
             * subtracting `bytes` from both did not.
             *
             * The pump calls this AFTER awaiting `ws.send`, and a revocation
             * landing during that await runs `abandon`, which zeroes the
             * session and releases its whole outbound total at once. This call
             * then arrived and took the same bytes out of the host's counter a
             * second time — leaving it BELOW what is really queued, so other
             * sessions could push past a budget the host thought it had.
             *
             * Clamping to what the session still holds makes the two counters
             * move together by construction: after `abandon` the session holds
             * nothing, so nothing further is released. */
            let taken = bytes.min(session.outbound_bytes);
            session.outbound_bytes -= taken;
            guard.outbound_bytes_total = guard.outbound_bytes_total.saturating_sub(taken);
        }
    }

    /// Bytes queued toward every browser at once. For tests and diagnostics.
    pub fn outbound_bytes_total(&self) -> usize {
        self.inner
            .lock()
            .expect("pipe mutex poisoned")
            .outbound_bytes_total
    }

    /// Bytes currently queued toward `id`'s browser. For tests and diagnostics.
    pub fn outbound_bytes(&self, id: WebSessionId) -> usize {
        self.inner
            .lock()
            .expect("pipe mutex poisoned")
            .sessions
            .get(&id)
            .map_or(0, |session| session.outbound_bytes)
    }

    /// Up to `max` frames for the webview, oldest first. Never waits.
    pub fn drain(&self, id: WebSessionId, max: usize) -> Vec<Vec<u8>> {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        let Some(session) = guard.sessions.get_mut(&id) else {
            return Vec::new();
        };
        let take = max.min(session.inbox.len());
        let out: Vec<Vec<u8>> = session.inbox.drain(..take).collect();
        session.inbox_bytes -= out.iter().map(Vec::len).sum::<usize>();
        out
    }

    /// Wait until this session has a frame, or until `timeout` passes, then
    /// drain up to `max`.
    ///
    /// ⚠️ **THIS EXISTS BECAUSE THE WEBVIEW WAS ASKING TWENTY-FIVE TIMES A
    /// SECOND, PER SESSION, TO BE TOLD "NOTHING".** `drain` returns
    /// immediately, so the TypeScript pump polled it every 40 ms — at the
    /// host's own `MAX_SESSIONS` that is 1,600 IPC round trips a second before
    /// a single byte of useful traffic.
    ///
    /// A longer poll interval was the obvious answer and is the wrong one: the
    /// interval bounds how long a reader waits for the FIRST frame of a
    /// request they have just made by tapping the page, so lengthening it
    /// trades idle CPU for exactly the latency that is felt. Waiting instead
    /// gives both — the call returns the instant a frame arrives, and costs one
    /// IPC per `timeout` while nothing is happening.
    ///
    /// The mutex is never held across the await: the `Notify` is cloned out
    /// under the guard and the guard is dropped before waiting.
    pub async fn wait_for_frames(
        &self,
        id: WebSessionId,
        max: usize,
        timeout: std::time::Duration,
    ) -> Vec<Vec<u8>> {
        let arrived = {
            let guard = self.inner.lock().expect("pipe mutex poisoned");
            let Some(session) = guard.sessions.get(&id) else {
                return Vec::new();
            };
            /* ALREADY WAITING FRAMES SHORT-CIRCUIT, so a busy session never
             * pays the wait at all. */
            if !session.inbox.is_empty() || session.closed.is_some() {
                drop(guard);
                return self.drain(id, max);
            }
            Arc::clone(&session.arrived)
        };
        /* The timeout is what makes this a poll rather than a subscription: a
         * session closed while we wait wakes nobody, and the caller has to come
         * back and see that for itself. */
        let _ = tokio::time::timeout(timeout, arrived.notified()).await;
        self.drain(id, max)
    }

    /// Close one socket. Idempotent; the first reason is the one kept.
    pub fn close(&self, id: WebSessionId, reason: &str) {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        let freed = match guard.sessions.get_mut(&id) {
            Some(session) => abandon(session, reason),
            None => 0,
        };
        guard.outbound_bytes_total = guard.outbound_bytes_total.saturating_sub(freed);
    }

    /// Close every socket a credential opened, and say which.
    ///
    /// **This is the half of revocation `paper_webauth` cannot do.** Its
    /// `revoke` forgets the credential; without this the browser keeps a live
    /// socket and goes on answering, which its doc comment warns about.
    pub fn close_credential(&self, credential: &Credential, reason: &str) -> Vec<WebSessionId> {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        let mut closed = Vec::new();
        let mut freed = 0;
        for (id, session) in guard.sessions.iter_mut() {
            if &session.credential == credential && session.closed.is_none() {
                freed += abandon(session, reason);
                closed.push(*id);
            }
        }
        guard.outbound_bytes_total = guard.outbound_bytes_total.saturating_sub(freed);
        closed.sort();
        closed
    }

    /// Drop a closed socket's record. Called when its task has finished, so the
    /// map does not grow for the life of the process.
    pub fn reap(&self, id: WebSessionId) {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        /* THE HOST'S TOTAL FOLLOWS THE RECORD OUT. `close` normally zeroes this
         * first, but `reap` is also reachable for a session that was never
         * closed — and a removed record takes its per-session counter with it,
         * so anything still counted globally could never be released by anyone.
         * The leak is one-way and permanent: enough sockets and every browser
         * is backpressured for ever, on a budget nothing is actually using. */
        if let Some(session) = guard.sessions.remove(&id) {
            guard.outbound_bytes_total = guard
                .outbound_bytes_total
                .saturating_sub(session.outbound_bytes);
        }
    }

    /// Why a socket closed, if it has.
    pub fn closed_reason(&self, id: WebSessionId) -> Option<String> {
        self.inner
            .lock()
            .expect("pipe mutex poisoned")
            .sessions
            .get(&id)
            .and_then(|s| s.closed.clone())
    }

    /// The authorization session behind a socket.
    pub fn admitted(&self, id: WebSessionId) -> Option<SessionId> {
        self.inner
            .lock()
            .expect("pipe mutex poisoned")
            .sessions
            .get(&id)
            .map(|s| s.admitted)
    }

    /// Every live socket, oldest first. For the shelf's Devices list.
    pub fn live_ids(&self) -> Vec<WebSessionId> {
        let guard = self.inner.lock().expect("pipe mutex poisoned");
        let mut ids: Vec<WebSessionId> = guard
            .sessions
            .iter()
            .filter(|(_, s)| s.closed.is_none())
            .map(|(id, _)| *id)
            .collect();
        ids.sort();
        ids
    }

    /// The credential behind a socket, so a caller can revoke the whole
    /// browser rather than the one connection it happened to name.
    pub fn credential_of(&self, id: WebSessionId) -> Option<Credential> {
        self.inner
            .lock()
            .expect("pipe mutex poisoned")
            .sessions
            .get(&id)
            .map(|s| s.credential.clone())
    }

    pub fn live_count(&self) -> usize {
        self.inner
            .lock()
            .expect("pipe mutex poisoned")
            .sessions
            .values()
            .filter(|s| s.closed.is_none())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use paper_webauth::sessions::Sessions;
    use paper_webauth::{DeviceAuth, Outcome};
    use std::time::Instant;

    /// A channel whose receiver is kept alive by the caller. Dropping the
    /// receiver would make every `send` report `Gone`, which is correct
    /// behaviour and a confusing test failure.
    fn wire() -> (mpsc::Sender<Vec<u8>>, mpsc::Receiver<Vec<u8>>) {
        mpsc::channel(OUTBOUND_CAP)
    }

    /// A real credential and the admission behind it, because `open` should not
    /// be reachable without one.
    fn admitted(sessions: &Sessions) -> (SessionId, Credential) {
        let auth = DeviceAuth::new();
        let now = Instant::now();
        let offer = auth.begin(now);
        let digits = offer.code.digits().to_vec();
        let grant = match auth.submit(auth.reserve(now).unwrap(), &digits, now) {
            Outcome::Granted(g) => g,
            other => panic!("expected a grant, got {other:?}"),
        };
        let credential = sessions.issue(grant, now);
        let admission = sessions.validate(&credential, now).expect("valid");
        (sessions.admit(admission).expect("admitted"), credential)
    }

    #[test]
    fn frames_round_trip_oldest_first() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");

        assert_eq!(pipe.push(socket, b"one".to_vec()), Push::Accepted);
        assert_eq!(pipe.push(socket, b"two".to_vec()), Push::Accepted);
        assert_eq!(
            pipe.drain(socket, 10),
            vec![b"one".to_vec(), b"two".to_vec()]
        );
        assert!(pipe.drain(socket, 10).is_empty());
    }

    #[test]
    fn drain_respects_its_maximum_and_keeps_the_rest() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");
        for n in 0..5u8 {
            assert_eq!(pipe.push(socket, vec![n]), Push::Accepted);
        }
        assert_eq!(pipe.drain(socket, 2), vec![vec![0], vec![1]]);
        assert_eq!(pipe.drain(socket, 99), vec![vec![2], vec![3], vec![4]]);
    }

    #[test]
    fn an_oversized_frame_closes_the_session_rather_than_backpressuring() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");

        assert_eq!(pipe.push(socket, vec![0u8; MAX_FRAME + 1]), Push::TooLarge);
        assert_eq!(
            pipe.closed_reason(socket).as_deref(),
            Some("frame too large")
        );
        /* And it stays closed — a following well-formed frame is not accepted. */
        assert_eq!(pipe.push(socket, b"hello".to_vec()), Push::Gone);
    }

    #[test]
    fn an_oversized_frame_closes_even_when_the_inbox_is_already_full() {
        /* The ordering that matters: checking the budget first would report
         * this as backpressure and leave a protocol-violating socket open. */
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");
        while pipe.push(socket, vec![0u8; 64 * 1024]) == Push::Accepted {}
        assert_eq!(pipe.push(socket, vec![0u8; MAX_FRAME + 1]), Push::TooLarge);
    }

    #[test]
    fn the_byte_budget_backpressures_and_a_drain_clears_it() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");
        let chunk = vec![0u8; 1024 * 1024];

        let mut accepted = 0;
        while pipe.push(socket, chunk.clone()) == Push::Accepted {
            accepted += 1;
        }
        assert_eq!(accepted, INBOX_BYTE_CAP / chunk.len());
        /* THE REFUSED FRAME COMES BACK, byte for byte. Asserting the variant
         * alone would have passed for the whole time `lib.rs` was dropping it —
         * what the caller can still do with the bytes is the property. */
        let refused = vec![7u8; 1024 * 1024];
        assert_eq!(
            pipe.push(socket, refused.clone()),
            Push::Backpressure(refused),
            "backpressure must return the frame it would not take"
        );
        assert!(
            pipe.closed_reason(socket).is_none(),
            "backpressure must not close"
        );

        /* Draining frees the budget, which is what makes it backpressure
         * rather than a wall. */
        let _ = pipe.drain(socket, 1);
        assert_eq!(pipe.push(socket, chunk), Push::Accepted);
    }

    /// THE OUTBOUND QUEUE IS BOUNDED IN BYTES, not only in slots.
    ///
    /// `OUTBOUND_CAP` is 256 and `MAX_FRAME` is 4 MiB, so the slot count alone
    /// permitted ~1 GiB queued toward one browser and ~64 GiB across
    /// `MAX_SESSIONS` — the same arithmetic the module header rehearses for the
    /// inbox, pointing the other way, in a queue that had no byte budget at all.
    /// A browser that stops reading is all it takes.
    #[test]
    fn the_outbound_budget_bounds_bytes_and_a_drain_clears_it() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        /* THE RECEIVER IS HELD. Elsewhere in this file `wire().0` drops it,
         * which is harmless for `push` and fatal here: a closed channel makes
         * `try_send` return `Closed` and every `send` answer `Gone`, so the
         * whole test would pass through its loop zero times and assert nothing
         * about the budget. */
        let (sender, _receiver) = wire();
        let socket = pipe.open(id, credential, sender).expect("open");
        let chunk = vec![0u8; 1024 * 1024];

        let mut sent = 0;
        while pipe.send(socket, chunk.clone()) == Send::Sent {
            sent += 1;
        }
        /* THE BYTES ARE THE BOUND, NOT THE SLOTS. Eight 1 MiB frames fill the
         * budget while 248 of the 256 slots are still free — which is exactly
         * the difference this test exists for. */
        assert_eq!(sent, OUTBOUND_BYTE_CAP / chunk.len());
        assert!(
            sent < OUTBOUND_CAP,
            "the byte budget must bite first; a test that fills the slots proves nothing"
        );
        assert_eq!(pipe.outbound_bytes(socket), OUTBOUND_BYTE_CAP);
        assert_eq!(pipe.send(socket, chunk.clone()), Send::Backpressure);
        assert!(
            pipe.closed_reason(socket).is_none(),
            "a slow browser is not a bad one"
        );

        /* Backpressure, not a wall: the pump reports what it wrote and the
         * budget frees. Without that call the queue fills once, for ever. */
        pipe.drained(socket, chunk.len());
        assert_eq!(pipe.send(socket, chunk), Send::Sent);
    }

    /// AND A CEILING ACROSS EVERY BROWSER, not only per browser.
    ///
    /// The per-session cap alone permits `OUTBOUND_BYTE_CAP` × `MAX_SESSIONS`
    /// — half a gigabyte — reached by sixty-four browsers each comfortably
    /// inside its own budget. That is the same arithmetic the frame count made
    /// one level down, which the module header rehearses at length; stopping at
    /// the per-session number repeats it.
    #[test]
    fn the_outbound_budget_also_bounds_every_session_together() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let chunk = vec![0u8; 1024 * 1024];
        /* Held, or every `try_send` reports `Gone` — see the note in the
         * per-session test. */
        let mut wires = Vec::new();
        let mut sockets = Vec::new();

        /* Enough sessions that the GLOBAL cap bites before the per-session one:
         * each stops at 8 MiB, and the host stops at 128 MiB. */
        let needed = OUTBOUND_BYTE_CAP_GLOBAL / OUTBOUND_BYTE_CAP + 1;
        assert!(
            needed <= MAX_SESSIONS,
            "the test needs more sessions than the host allows"
        );
        for _ in 0..needed {
            let (id, credential) = admitted(&sessions);
            let (sender, receiver) = wire();
            wires.push(receiver);
            sockets.push(pipe.open(id, credential, sender).expect("open"));
        }

        let mut accepted = 0;
        'filling: for socket in &sockets {
            loop {
                match pipe.send(*socket, chunk.clone()) {
                    Send::Sent => accepted += 1,
                    Send::Backpressure => break,
                    other => panic!("unexpected {other:?}"),
                }
                if pipe.outbound_bytes_total() >= OUTBOUND_BYTE_CAP_GLOBAL {
                    break 'filling;
                }
            }
        }

        assert_eq!(
            pipe.outbound_bytes_total(),
            OUTBOUND_BYTE_CAP_GLOBAL,
            "the host budget is what stopped it"
        );
        assert!(
            accepted * chunk.len() < OUTBOUND_BYTE_CAP * MAX_SESSIONS,
            "the per-session caps alone would have allowed far more"
        );

        /* A session still inside its OWN budget is refused, because the host is
         * not. That is the whole difference between the two ceilings. */
        let last = *sockets.last().expect("a socket");
        assert!(pipe.outbound_bytes(last) < OUTBOUND_BYTE_CAP);
        assert_eq!(pipe.send(last, chunk.clone()), Send::Backpressure);

        /* And a drain frees the host's budget, not just the session's. */
        pipe.drained(sockets[0], chunk.len());
        assert_eq!(pipe.send(last, chunk), Send::Sent);
    }

    /// ABANDONING A SESSION RELEASES ITS SHARE OF THE HOST'S BUDGET.
    ///
    /// `close` drops the outbound sender, which discards whatever tokio had
    /// buffered — and the per-session counter leaves with the record when
    /// `reap` runs. The GLOBAL total was left holding bytes that were no longer
    /// queued anywhere and that nobody could ever release: a one-way leak, so a
    /// few revocations would backpressure every browser against a budget
    /// nothing was using. The shelf stops answering and nothing says why.
    #[test]
    fn closing_and_reaping_release_the_host_budget() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let chunk = vec![0u8; 1024 * 1024];

        for close_first in [true, false] {
            let (id, credential) = admitted(&sessions);
            let (sender, _receiver) = wire();
            let socket = pipe.open(id, credential.clone(), sender).expect("open");
            for _ in 0..4 {
                assert_eq!(pipe.send(socket, chunk.clone()), Send::Sent);
            }
            assert_eq!(pipe.outbound_bytes_total(), 4 * chunk.len());

            /* Both orders, because both happen: the pump closes then reaps, and
             * a revocation can close a socket whose task reaps later. */
            if close_first {
                pipe.close(socket, "done");
                assert_eq!(
                    pipe.outbound_bytes_total(),
                    0,
                    "closing gives up the queue, so the host's total must give it up too"
                );
            }
            pipe.reap(socket);
            assert_eq!(
                pipe.outbound_bytes_total(),
                0,
                "a reaped record takes its per-session count with it — the host's total \
                 has to be released here or it can never be released at all"
            );
        }
    }

    /// AND A DRAIN AFTER A CLOSE RELEASES NOTHING TWICE.
    ///
    /// The pump reports a write AFTER awaiting it, so a revocation during that
    /// await gets there first: `abandon` zeroes the session and hands the host
    /// back its whole outbound total. The late `drained` used to subtract the
    /// same bytes again, pushing the host's counter BELOW what was really
    /// queued — the leak pointing the other way, letting other sessions past a
    /// budget that was no longer telling the truth.
    #[test]
    fn a_drain_that_lands_after_a_close_releases_nothing_twice() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let chunk = vec![0u8; 1024 * 1024];

        /* One session that will be closed mid-write, and one that keeps its
         * queue — so the host's total has a known non-zero value to check. */
        let (id_a, cred_a) = admitted(&sessions);
        let (sender_a, _recv_a) = wire();
        let closing = pipe.open(id_a, cred_a, sender_a).expect("open");
        let (id_b, cred_b) = admitted(&sessions);
        let (sender_b, _recv_b) = wire();
        let keeping = pipe.open(id_b, cred_b, sender_b).expect("open");

        assert_eq!(pipe.send(closing, chunk.clone()), Send::Sent);
        assert_eq!(pipe.send(keeping, chunk.clone()), Send::Sent);
        assert_eq!(pipe.outbound_bytes_total(), 2 * chunk.len());

        /* The revocation lands while the pump is inside `ws.send`. */
        pipe.close(closing, "revoked");
        assert_eq!(
            pipe.outbound_bytes_total(),
            chunk.len(),
            "only B's frame is queued"
        );

        /* …and the pump's report arrives afterwards. */
        pipe.drained(closing, chunk.len());
        assert_eq!(
            pipe.outbound_bytes_total(),
            chunk.len(),
            "B's frame is still queued; a late drain from A must not release it"
        );
    }

    /// AND A REVOCATION RELEASES IT TOO, by the same route.
    #[test]
    fn closing_a_credential_releases_the_host_budget() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let (sender, _receiver) = wire();
        let socket = pipe.open(id, credential.clone(), sender).expect("open");
        assert_eq!(pipe.send(socket, vec![0u8; 1024 * 1024]), Send::Sent);
        assert!(pipe.outbound_bytes_total() > 0);

        pipe.close_credential(&credential, "revoked");
        assert_eq!(pipe.outbound_bytes_total(), 0);
    }

    /// WAITING RETURNS THE MOMENT A FRAME LANDS, and not before.
    ///
    /// The webview asked every 40 ms per session to be told "nothing" — 1,600
    /// IPC round trips a second at `MAX_SESSIONS`, before any real traffic. A
    /// longer interval was the wrong trade: it bounds how long a reader waits
    /// for the first frame of a request they have just made. Waiting keeps that
    /// latency and removes the idle cost.
    #[tokio::test]
    async fn waiting_returns_as_soon_as_a_frame_arrives() {
        let (pipe, sessions) = (Arc::new(Pipe::new()), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");

        /* Nothing waiting: the call parks rather than answering empty. */
        let waiter = {
            let pipe = Arc::clone(&pipe);
            tokio::spawn(async move {
                pipe.wait_for_frames(socket, usize::MAX, std::time::Duration::from_secs(5))
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(
            !waiter.is_finished(),
            "an empty inbox must be waited on, not answered"
        );

        pipe.push(socket, b"a frame".to_vec());
        let frames = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("the push should have woken the waiter")
            .expect("the task");
        assert_eq!(frames, vec![b"a frame".to_vec()]);
    }

    #[tokio::test]
    async fn waiting_does_not_wait_at_all_when_frames_are_already_there() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");
        pipe.push(socket, b"already here".to_vec());

        /* A busy session must never pay the wait. The timeout is long enough
         * that returning at all proves the short circuit ran. */
        let frames = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            pipe.wait_for_frames(socket, usize::MAX, std::time::Duration::from_secs(30)),
        )
        .await
        .expect("a session with frames must answer at once");
        assert_eq!(frames, vec![b"already here".to_vec()]);
    }

    /// AND A CLOSE WAKES THE WAITER, or a revocation becomes a delay.
    #[tokio::test]
    async fn closing_wakes_a_waiting_reader() {
        let (pipe, sessions) = (Arc::new(Pipe::new()), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");

        let waiter = {
            let pipe = Arc::clone(&pipe);
            tokio::spawn(async move {
                pipe.wait_for_frames(socket, usize::MAX, std::time::Duration::from_secs(30))
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        pipe.close(socket, "revoked");

        let frames = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("the close should have woken the waiter")
            .expect("the task");
        assert!(frames.is_empty());
    }

    /// …and a timeout answers empty rather than hanging for ever.
    #[tokio::test]
    async fn waiting_gives_up_after_its_timeout() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");
        let frames = pipe
            .wait_for_frames(socket, usize::MAX, std::time::Duration::from_millis(30))
            .await;
        assert!(frames.is_empty());
    }

    #[test]
    fn the_frame_count_bounds_a_flood_of_tiny_frames() {
        /* The bound the byte budget cannot provide: empty frames cost no bytes
         * and would grow the queue without limit. */
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");
        for _ in 0..INBOX_CAP {
            assert_eq!(pipe.push(socket, Vec::new()), Push::Accepted);
        }
        assert_eq!(
            pipe.push(socket, Vec::new()),
            Push::Backpressure(Vec::new())
        );
    }

    #[test]
    fn one_credential_cannot_hold_more_than_its_share() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        for _ in 0..MAX_SESSIONS_PER_CREDENTIAL {
            pipe.open(id, credential.clone(), wire().0)
                .expect("within the share");
        }
        assert_eq!(
            pipe.open(id, credential, wire().0),
            Err(OpenRefused::TooManyForCredential)
        );
    }

    #[test]
    fn a_closed_session_frees_the_credentials_share() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let mut sockets = Vec::new();
        for _ in 0..MAX_SESSIONS_PER_CREDENTIAL {
            sockets.push(pipe.open(id, credential.clone(), wire().0).expect("open"));
        }
        pipe.close(sockets[0], "done");
        assert!(
            pipe.open(id, credential, wire().0).is_ok(),
            "a reconnect after a close must not be refused"
        );
    }

    #[test]
    fn revoking_a_credential_closes_every_socket_it_opened() {
        /* PLAN §7's fourth thing. `Sessions::revoke` forgets the credential;
         * without this the browser keeps answering on a live socket. */
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (mine_id, mine) = admitted(&sessions);
        let (other_id, other) = admitted(&sessions);
        let a = pipe.open(mine_id, mine.clone(), wire().0).expect("open");
        let b = pipe.open(mine_id, mine.clone(), wire().0).expect("open");
        let spared = pipe.open(other_id, other, wire().0).expect("open");

        assert!(sessions.revoke(&mine).is_some());
        let closed = pipe.close_credential(&mine, "revoked");

        assert_eq!(closed, vec![a.min(b), a.max(b)]);
        assert_eq!(pipe.closed_reason(a).as_deref(), Some("revoked"));
        assert_eq!(pipe.push(a, b"anything".to_vec()), Push::Gone);
        assert!(
            pipe.closed_reason(spared).is_none(),
            "one revocation must not close another browser's socket"
        );
    }

    #[test]
    fn closing_drops_whatever_was_buffered() {
        /* A revoked socket's queued frames must not be drainable afterwards —
         * they were sent by a browser that is no longer trusted. */
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential.clone(), wire().0).expect("open");
        assert_eq!(pipe.push(socket, b"queued".to_vec()), Push::Accepted);
        pipe.close_credential(&credential, "revoked");
        assert!(pipe.drain(socket, 10).is_empty());
    }

    #[test]
    fn close_is_idempotent_and_keeps_the_first_reason() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");
        pipe.close(socket, "first");
        pipe.close(socket, "second");
        assert_eq!(pipe.closed_reason(socket).as_deref(), Some("first"));
    }

    #[test]
    fn live_ids_lists_the_open_sockets_only() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let first = pipe.open(id, credential.clone(), wire().0).expect("open");
        let second = pipe.open(id, credential.clone(), wire().0).expect("open");
        assert_eq!(pipe.live_ids(), vec![first, second]);

        pipe.close(first, "done");
        assert_eq!(pipe.live_ids(), vec![second]);
    }

    #[test]
    fn a_socket_knows_the_credential_behind_it() {
        /* Revoking by socket must cut the whole BROWSER off, not the one
         * connection the caller happened to name. */
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let one = pipe.open(id, credential.clone(), wire().0).expect("open");
        let two = pipe.open(id, credential.clone(), wire().0).expect("open");

        let found = pipe.credential_of(one).expect("a credential");
        assert_eq!(pipe.close_credential(&found, "revoked"), vec![one, two]);
    }

    #[test]
    fn a_reaped_session_is_gone_entirely() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        let (id, credential) = admitted(&sessions);
        let socket = pipe.open(id, credential, wire().0).expect("open");
        pipe.close(socket, "done");
        pipe.reap(socket);
        assert_eq!(pipe.push(socket, b"x".to_vec()), Push::Gone);
        assert!(pipe.admitted(socket).is_none());
        assert_eq!(pipe.live_count(), 0);
    }

    #[test]
    fn the_host_refuses_past_its_ceiling() {
        let (pipe, sessions) = (Pipe::new(), Sessions::new());
        /* Distinct credentials, so the per-credential share is not what bites. */
        let mut opened = 0;
        while opened < MAX_SESSIONS {
            let (id, credential) = admitted(&sessions);
            pipe.open(id, credential, wire().0)
                .expect("under the ceiling");
            opened += 1;
        }
        let (id, credential) = admitted(&sessions);
        assert_eq!(
            pipe.open(id, credential, wire().0),
            Err(OpenRefused::TooManySessions)
        );
    }
}
