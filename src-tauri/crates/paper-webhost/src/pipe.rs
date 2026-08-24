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
//!   - **Over budget** is [`Push::Backpressure`]. Nothing is dropped and the
//!     session is fine; the caller stops reading the socket until the webview
//!     drains. TCP does the rest, as QUIC flow control does for the peer.
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
use std::sync::Mutex;

use paper_webauth::sessions::{Credential, SessionId};
use tokio::sync::mpsc;

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
pub const OUTBOUND_CAP: usize = 256;

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
    /// Over budget. Nothing dropped; stop reading until a drain.
    Backpressure,
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
    closed: Option<String>,
}

#[derive(Default)]
struct Inner {
    next: u64,
    sessions: HashMap<WebSessionId, WebSession>,
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
                outbound: Some(outbound),
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
            return Push::Backpressure;
        }
        session.inbox_bytes += frame.len();
        session.inbox.push_back(frame);
        Push::Accepted
    }

    /// A frame from the webview, bound for the browser. Never waits.
    pub fn send(&self, id: WebSessionId, frame: Vec<u8>) -> Send {
        let guard = self.inner.lock().expect("pipe mutex poisoned");
        let Some(session) = guard.sessions.get(&id) else {
            return Send::Gone;
        };
        if frame.len() > MAX_FRAME {
            return Send::TooLarge;
        }
        let Some(outbound) = session.outbound.as_ref() else {
            return Send::Gone;
        };
        match outbound.try_send(frame) {
            Ok(()) => Send::Sent,
            Err(mpsc::error::TrySendError::Full(_)) => Send::Backpressure,
            Err(mpsc::error::TrySendError::Closed(_)) => Send::Gone,
        }
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

    /// Close one socket. Idempotent; the first reason is the one kept.
    pub fn close(&self, id: WebSessionId, reason: &str) {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        if let Some(session) = guard.sessions.get_mut(&id) {
            if session.closed.is_none() {
                session.closed = Some(reason.to_owned());
            }
            session.inbox.clear();
            session.inbox_bytes = 0;
            /* DROPPING THE SENDER IS THE SIGNAL. The socket's write task is
             * awaiting this channel; closing it ends that task without a
             * second flag to keep in step. */
            session.outbound = None;
        }
    }

    /// Close every socket a credential opened, and say which.
    ///
    /// **This is the half of revocation `paper_webauth` cannot do.** Its
    /// `revoke` forgets the credential; without this the browser keeps a live
    /// socket and goes on answering, which its doc comment warns about.
    pub fn close_credential(&self, credential: &Credential, reason: &str) -> Vec<WebSessionId> {
        let mut guard = self.inner.lock().expect("pipe mutex poisoned");
        let mut closed = Vec::new();
        for (id, session) in guard.sessions.iter_mut() {
            if &session.credential == credential && session.closed.is_none() {
                session.closed = Some(reason.to_owned());
                session.inbox.clear();
                session.inbox_bytes = 0;
                session.outbound = None;
                closed.push(*id);
            }
        }
        closed.sort();
        closed
    }

    /// Drop a closed socket's record. Called when its task has finished, so the
    /// map does not grow for the life of the process.
    pub fn reap(&self, id: WebSessionId) {
        self.inner
            .lock()
            .expect("pipe mutex poisoned")
            .sessions
            .remove(&id);
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
        assert_eq!(pipe.push(socket, chunk.clone()), Push::Backpressure);
        assert!(
            pipe.closed_reason(socket).is_none(),
            "backpressure must not close"
        );

        /* Draining frees the budget, which is what makes it backpressure
         * rather than a wall. */
        let _ = pipe.drain(socket, 1);
        assert_eq!(pipe.push(socket, chunk), Push::Accepted);
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
        assert_eq!(pipe.push(socket, Vec::new()), Push::Backpressure);
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
