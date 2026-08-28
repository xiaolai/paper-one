//! The shelf's HTTP surface for the browser client (phase 18, WI-18.4a).
//!
//! Three endpoints and two headers. The endpoints turn six typed digits into a
//! session; the headers are what keep a book from stealing it.
//!
//! ## This server is plain HTTP, and that is not a mistake
//!
//! It binds loopback. TLS is terminated in front of it — `tailscale serve`, or
//! Caddy, or any reverse proxy the reader already runs. Putting a certificate
//! in here would mean an ACME client, a private key at rest, and renewal, to
//! duplicate something the proxy does better.
//!
//! ⚠️ **The whole auth design rests on that proxy existing.** Plan §2's claim
//! that six digits is enough is *because* an attacker cannot read the code in
//! flight or impersonate the shelf. Serve this port to a network directly and
//! both stop being true. The `Secure` attribute on the session cookie is the
//! backstop: a browser reaching this over plain `http://` will refuse to store
//! it, so the failure is a login that does not stick rather than a credential
//! travelling in the clear.
//!
//! ## Why the cookie rather than a token in JavaScript's reach
//!
//! `rendererIsolation.test.ts` states the property this repository already
//! lives by: foliate renders an EPUB in an iframe carrying `allow-same-origin
//! allow-scripts`, so *"book JavaScript [runs] in the application's own
//! origin"* and the Content Security Policy is *"not a hardening detail here,
//! it is the boundary."*
//!
//! A credential in `localStorage` is therefore readable by a hostile book. So
//! it is not in `localStorage`. It is an `HttpOnly` cookie: page script cannot
//! read it at all, and the browser attaches it to the WebSocket handshake by
//! itself because the shelf serves the SPA same-origin.
//!
//! ## What this server does NOT do, which is answer anything
//!
//! ⚠️ This section used to say the frame pipe and the embedded SPA were "not
//! here yet". Both are: [`pipe`] is a module of this crate and the router below
//! serves the embedded client as its fallback. What has not changed is the rule
//! the section was really about, so it is stated as a rule rather than as a
//! plan.
//!
//! The service router lives in TypeScript — `serve(services)` is a method on
//! the webview's peer port — so this server can never answer a service call
//! itself. It pipes frames, exactly as `tauri-plugin-peer` does. **Anything
//! that starts answering service calls in Rust here is building a second copy
//! of every handler**, which will drift from the first the day either changes.

pub mod assets;
pub mod pipe;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::oneshot;

use assets::Asset;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use paper_webauth::sessions::{Credential, Sessions, CREDENTIAL_TTL};
use paper_webauth::{DeviceAuth, Outcome, Refused};
use pipe::{Pipe, Push, WebSessionId, MAX_FRAME, OUTBOUND_CAP};
use serde::Deserialize;
use tokio::sync::mpsc;

/// The cookie the browser gets, and the only place its name is written.
pub const SESSION_COOKIE: &str = "paper_session";

/// How long the pump waits before re-offering a frame the inbox refused.
///
/// Well under the webview's own 40 ms drain poll, so capacity is claimed
/// promptly once it appears; far enough from zero that a full inbox costs a few
/// wakeups a second rather than a spinning core. See `pump`.
const RETRY: std::time::Duration = std::time::Duration::from_millis(4);

/// WHEN a held frame is next offered, as a value rather than as a `sleep` call.
///
/// ⚠️ **THIS EXISTS BECAUSE THE OBVIOUS SPELLING IS WRONG AND UNTESTABLE.**
/// `tokio::select!` rebuilds its futures on every pass, so
/// `sleep(RETRY)` inside one restarts from zero whenever the OTHER arm wins.
/// A browser being sent a book keeps the outbound arm ready continuously,
/// which re-armed the timer faster than it could ever elapse: the held frame
/// was never retried for as long as the stream lasted. That is the same lost
/// frame the holding was introduced to prevent, reached by starvation.
///
/// An integration test could not tell the two apart — a producer cannot be
/// made to outpace the pump reliably, so between bursts the relative timer got
/// its four milliseconds and the frame arrived anyway. The property that DOES
/// separate them is local and exact: **re-reading the deadline must not move
/// it.** That is what `deadline` promises and what `the_deadline_does_not_move`
/// checks, and it is false for every relative formulation.
#[derive(Default)]
struct RetryAt(Option<tokio::time::Instant>);

impl RetryAt {
    /// The instant to wake at, fixed on first read and stable after it.
    fn deadline(&mut self, now: tokio::time::Instant) -> tokio::time::Instant {
        *self.0.get_or_insert(now + RETRY)
    }

    /// The retry ran; the next one starts its own interval.
    fn taken(&mut self) {
        self.0 = None;
    }
}

/// The policy that stands between a shared book and everything else.
///
/// `script-src 'self'` with no `'unsafe-inline'`, no `'unsafe-eval'` and no
/// `blob:` — the three that would each, on their own, let a book's JavaScript
/// run in this origin.
///
/// `frame-src data: blob:` — and NOT `'self'`. foliate puts the book in an
/// iframe, and the book is a blob, so `blob:` is what a book needs. `'self'`
/// used to be there too, and it was the one route a book had that needed no
/// script at all: a `blob:` document inherits this policy, so an EPUB holding
/// nothing but `<iframe src="/">` loaded the REAL CLIENT inside the book —
/// its module executes under `script-src 'self'`, the browser attaches the
/// cookie to its `/ws`, and the book's own markup sits over it: clickjacking,
/// with every read the credential permits. Found in a refute round on
/// 2026-08-27; measured in `scripts/csp-effect.mjs`'s third route. Nothing
/// the client serves is legitimately framed by a book, so nothing is lost.
///
/// `style-src`, `font-src` and `worker-src` take `blob:` for the same reason
/// and on the same terms. foliate rewrites a book's stylesheets and embedded
/// fonts to object URLs, and pdf.js runs in a worker built from one. Without
/// them nothing fails loudly: the book renders unstyled, in a fallback face,
/// and a PDF does not render at all — which reads as a bad book rather than as
/// our policy.
///
/// ⚠️ `frame-ancestors` IS `'self'` AND NOT `'none'`, and the difference is a
/// book that renders against one that does not.
///
/// A blob document INHERITS the embedder's policy. foliate puts every book
/// document in an iframe as a `blob:` URL, so with `'none'` the book's own
/// frame has no permitted ancestor and the browser refuses to load it —
/// "Refused to load blob:… because it does not appear in the frame-ancestors
/// directive". `'self'` still refuses every OTHER origin, which is the
/// clickjacking protection this directive is for; what it stops refusing is
/// this page framing itself.
///
/// `media-src` is here for the same reason `font-src` is: a book may carry
/// audio or video, and it arrives as an object URL like everything else.
///
/// `'unsafe-inline'` on `style-src` is the desktop's answer too, and it is not
/// the boundary: inline CSS cannot execute JavaScript. It is here because the
/// client's own shell applies one and the page rendered UNSTYLED without it —
/// found by looking at the page, which is the only way this class of thing is
/// ever found.
///
/// **None of these is `script-src`, and that is the whole argument.**
/// Measured in WebKit and Chromium (`scripts/csp-effect.mjs`): with
/// `script-src 'self'`, a book's script does not run — neither an inline one
/// nor a `<script src>` pointing at an object URL, which is what every book
/// resource becomes. Widening the three above does not touch that.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
     script-src 'self'; \
     style-src 'self' 'unsafe-inline' blob:; \
     img-src 'self' data: blob:; \
     media-src 'self' data: blob:; \
     font-src 'self' data: blob:; \
     connect-src 'self'; \
     worker-src 'self' blob:; \
     frame-src data: blob:; \
     object-src 'none'; \
     base-uri 'none'; \
     form-action 'none'; \
     frame-ancestors 'self'";

/// Everything the HTTP surface needs. One live code, and every issued session.
pub struct WebHost {
    pub auth: DeviceAuth,
    pub sessions: Sessions,
    pub pipe: Pipe,
    /// See [`WebHost::pause_before_open`]. `None` in every build but a test's.
    admit_gate: Mutex<Option<oneshot::Sender<()>>>,
    admit_release: Mutex<Option<oneshot::Receiver<()>>>,
    /// See [`WebHost::failed_upgrades`].
    failed_upgrades: AtomicUsize,
}

impl WebHost {
    pub fn new() -> Self {
        Self {
            auth: DeviceAuth::new(),
            sessions: Sessions::new(),
            pipe: Pipe::new(),
            admit_gate: Mutex::new(None),
            admit_release: Mutex::new(None),
            failed_upgrades: AtomicUsize::new(0),
        }
    }

    /// How many handshakes opened a pipe record and then never became a
    /// socket — the browser gone between `Pipe::open` and the `101` reaching
    /// it. The count of times `upgrade`'s failure callback has run.
    ///
    /// A CONTROL, in the sense `pause_before_open` is a seam. That callback is
    /// reachable from a test only by a reset landing in a window a few
    /// microseconds wide, and a reset that misses it ends the socket through
    /// `pump` — which cleans up exactly as the callback must, so the two are
    /// indistinguishable afterwards. A test that cannot tell which path it
    /// took proves nothing about the one it names; this is what lets it tell.
    /// One atomic increment on a path that has already lost a connection —
    /// released after the reap and acquired here, so a reader that sees N has
    /// seen the N records go.
    pub fn failed_upgrades(&self) -> usize {
        self.failed_upgrades.load(Ordering::Acquire)
    }

    /// A TEST SEAM FOR THE ADMISSION WINDOW, and the reason it has to exist.
    ///
    /// `upgrade` admits a credential and then opens a pipe record, and the
    /// register-then-recheck below is what makes a revocation landing BETWEEN
    /// those two safe. A test that revokes before the handshake starts does not
    /// reach that window at all — it exercises the ordinary refusal, which is
    /// already covered, while claiming to cover the race.
    ///
    /// This pauses the next handshake exactly there: `reached` fires once
    /// admission has succeeded and before `Pipe::open` runs, and the handshake
    /// waits for `release`. Both are `None` in production; the cost is one
    /// `Option` check per socket, on a path that already does two subprocess-free
    /// validations and allocates a channel.
    ///
    /// The peer plugin carries the same seam, for the same window, under
    /// `#[cfg(test)]` — which is not available here because this crate's tests
    /// for it live in `tests/`, a separate crate.
    pub fn pause_before_open(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (reached_tx, reached_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        *self.admit_gate.lock().expect("admit gate") = Some(reached_tx);
        *self.admit_release.lock().expect("admit release") = Some(release_rx);
        (reached_rx, release_tx)
    }

    /// Wait at the seam, if a test armed one. A no-op otherwise.
    async fn admit_gate(&self) {
        let reached = self.admit_gate.lock().expect("admit gate").take();
        let release = self.admit_release.lock().expect("admit release").take();
        let (Some(reached), Some(release)) = (reached, release) else {
            return;
        };
        let _ = reached.send(());
        let _ = release.await;
    }
}

impl Default for WebHost {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
pub struct SubmitBody {
    pub code: String,
}

/// The router, with the policy headers already on it.
///
/// Separate from any binding so the tests drive the real handlers in-process.
pub fn router(state: Arc<WebHost>, client: &'static [Asset]) -> Router {
    Router::new()
        .route("/api/auth/submit", post(submit))
        .route("/api/auth/session", axum::routing::get(session))
        .route("/api/auth/signout", post(signout))
        .route("/ws", axum::routing::get(upgrade))
        /* THE CLIENT LAST, as a fallback. Registered routes are matched first,
         * so the single-page rule — an unknown path serves the entry document —
         * cannot shadow `/api` or `/ws`, however a browser spells them.
         *
         * ⚠️ AN UNKNOWN `/api` PATH IS A 404 AND USED TO BE THE SPA. The claim
         * above holds for the routes that EXIST; one that does not fell through
         * here and was answered with the entry document at status 200. A client
         * calling an endpoint this build lacks got HTML and a success code and
         * parsed it as an answer, so a typo in a service path became a mystery
         * about JSON rather than a 404. `api_missing` below is the scoped
         * fallback that answers first. */
        .fallback(move |uri: axum::http::Uri| async move {
            if uri.path() == "/ws" || uri.path().starts_with("/api/") {
                return StatusCode::NOT_FOUND.into_response();
            }
            assets::serve(client, &uri)
        })
        .layer(middleware::from_fn(policy_headers))
        .with_state(state)
}

/// Every response carries the policy, including the error ones.
///
/// A layer rather than a per-handler concern: a header added by each handler is
/// a header the next handler forgets, and the one that forgets is the 404 —
/// which is exactly the response an attacker can most easily provoke.
async fn policy_headers(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// The attributes that make the credential unreachable from page script.
///
/// `HttpOnly` is the one that defeats a hostile book. `Secure` refuses the
/// cookie over plain HTTP, which is what turns a missing reverse proxy into a
/// visible failure. `SameSite=Strict` is the CSRF defence, and every
/// state-changing endpoint here is a `POST` that reads no form.
///
/// `Max-Age` COMES FROM `CREDENTIAL_TTL`, not from arithmetic repeated here.
/// It was `60 * 60 * 24 * 90` — the same number `paper-webauth` computes for
/// its own ceiling, written out a second time. Two expirations that agree by
/// coincidence drift the first time either moves: shorten the server's and a
/// browser keeps presenting a credential that is already dead; lengthen it and
/// the cookie disappears from a browser the shelf still considers signed in.
/// Neither shows up as an error.
fn set_cookie(credential: &Credential) -> String {
    format!(
        "{SESSION_COOKIE}={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}",
        credential.as_str(),
        CREDENTIAL_TTL.as_secs()
    )
}

fn clear_cookie() -> String {
    format!("{SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0")
}

/// The credential this request presented, if any.
///
/// Hand-parsed rather than through a cookie crate: one name, no attributes to
/// interpret on the way in, and a dependency avoided. Splits on `;` and takes
/// the first exact name match.
fn presented(request_headers: &axum::http::HeaderMap) -> Option<Credential> {
    let raw = request_headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name.trim() == SESSION_COOKIE).then(|| Credential::from_presented(value.trim()))
    })
}

/// A request the browser itself says came from the page this shelf serves.
///
/// ## What `SameSite=Strict` does not cover
///
/// The cookie's `SameSite=Strict` is described above as "the CSRF defence", and
/// for a cross-*site* page it is. It says nothing about a hostile page on the
/// same site — and this shelf's public name is a tailnet one, `<host>.<tailnet>
/// .ts.net`, where every other machine on the tailnet is a sibling subdomain.
/// Whether those count as one site is a Public Suffix List question, decided in
/// a file this repository does not own and can change without notice. A
/// boundary that depends on someone else's list is not a boundary.
///
/// `/ws` had no check at all, which mattered more than the endpoints did: a
/// WebSocket outlives the request that made it, so a handshake that succeeds
/// once yields a read channel over the whole library — the shelf, the marks,
/// the cards, the book bytes — for as long as the socket is held.
///
/// ## Why Fetch Metadata rather than comparing `Origin` to `Host`
///
/// This server binds loopback behind a proxy it knows nothing about, so it does
/// not know its own public origin: `Host` here may be `127.0.0.1:<port>` while
/// the browser's `Origin` is the tailnet name. Comparing them would either
/// reject every real request or require configuration that can silently drift.
/// `Sec-Fetch-Site` is computed by the browser, cannot be set by page script,
/// and needs nothing from the deployment.
///
/// ## The absent case is allowed on purpose
///
/// A request carrying neither `Sec-Fetch-Site` nor `Origin` did not come from a
/// page context in a browser that implements either — so it cannot be the
/// attack this exists for. CSRF is a browser attack: it spends a credential the
/// browser attaches by itself. Something that is not a browser has no cookie to
/// spend, and is stopped by [`Admitted`] rather than by this. Failing closed
/// here would buy nothing and would break every non-browser caller.
pub struct SameOrigin;

impl<S: Sync> FromRequestParts<S> for SameOrigin {
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        if let Some(site) = parts
            .headers
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok())
        {
            /* `same-site` IS REFUSED, and it is the whole reason this exists.
             * `cross-site` was never going to arrive with a Strict cookie;
             * `same-site` is the sibling tailnet host, and it would. */
            return if site == "same-origin" {
                Ok(Self)
            } else {
                Err(StatusCode::FORBIDDEN)
            };
        }
        /* No Fetch Metadata: fall back to `Origin` against `Host`. Only useful
         * when the two are comparable, which behind a proxy they may not be —
         * so a mismatch is refused and an absent `Origin` is allowed, per the
         * note above. */
        let Some(origin) = parts
            .headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        else {
            return Ok(Self);
        };
        let host = parts
            .headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok());
        let authority = origin.split_once("://").map(|(_, rest)| rest);
        match (authority, host) {
            (Some(a), Some(h)) if a == h => Ok(Self),
            _ => Err(StatusCode::FORBIDDEN),
        }
    }
}

/// A request that carries a live credential.
///
/// AN EXTRACTOR, NOT A CHECK IN THE HANDLER, and the WebSocket route is why.
/// `WebSocketUpgrade` is itself an extractor: it rejects a non-upgradable
/// request with 426 *before* any handler body runs. With the credential check
/// in the body, an unauthenticated socket request was answered 426 — the
/// check never executed. Extractors run left to right, so naming this one
/// first is what makes the refusal happen before anything else looks at the
/// request.
///
/// It also means one implementation for every authenticated route rather than
/// the same three lines copied per handler.
pub struct Admitted {
    pub session: paper_webauth::sessions::SessionId,
    pub credential: Credential,
    /// When this credential stops being good — carried so the SOCKET can act
    /// on it. See `pump`, and `Admission::expires_at`.
    pub expires_at: Instant,
}

impl FromRequestParts<Arc<WebHost>> for Admitted {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<WebHost>,
    ) -> Result<Self, Self::Rejection> {
        let credential = presented(&parts.headers).ok_or(StatusCode::UNAUTHORIZED)?;
        /* BOTH PHASES. `validate` answers about a moment and `admit` re-checks
         * it; a WebSocket outlives the request that made it, so skipping the
         * second would reopen finding 7 exactly where it costs most. */
        let admission = state
            .sessions
            .validate(&credential, Instant::now())
            .map_err(|_| StatusCode::UNAUTHORIZED)?;
        let expires_at = admission.expires_at();
        let session = state
            .sessions
            .admit(admission)
            .map_err(|_| StatusCode::UNAUTHORIZED)?;
        Ok(Self {
            session,
            credential,
            expires_at,
        })
    }
}

/// `POST /api/auth/submit` — six digits in, a session cookie out.
///
/// `SameOrigin` FIRST, before the body is even read: a same-site page that
/// could POST here would spend the shelf's five attempts on codes of its own
/// choosing, and the reader — who is looking at the six digits on their own
/// screen — would find them already used.
async fn submit(
    _same_origin: SameOrigin,
    State(state): State<Arc<WebHost>>,
    Json(body): Json<SubmitBody>,
) -> Result<Response, StatusCode> {
    let now = Instant::now();
    /* THE RESERVATION IS TAKEN FIRST, and its refusal is answered without ever
     * looking at the submitted digits. That ordering is the rate limit; see
     * `paper_webauth`'s module header for why counting failures afterwards
     * counts nothing. */
    let reservation = match state.auth.reserve(now) {
        Ok(reservation) => reservation,
        Err(Refused::NoOffer) => return Err(StatusCode::CONFLICT),
        Err(Refused::Expired) => return Err(StatusCode::GONE),
        Err(Refused::NoAttemptsLeft) => return Err(StatusCode::TOO_MANY_REQUESTS),
    };

    match state.auth.submit(reservation, body.code.as_bytes(), now) {
        Outcome::Granted(granted) => {
            let credential = state.sessions.issue(granted, now);
            let mut response = StatusCode::NO_CONTENT.into_response();
            response.headers_mut().insert(
                header::SET_COOKIE,
                HeaderValue::from_str(&set_cookie(&credential))
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            );
            Ok(response)
        }
        /* Wrong and stale are ONE answer on the wire. Telling them apart tells
         * an attacker whether the code they guessed was the live one, which is
         * the single most useful thing they could learn from a failure. */
        Outcome::Wrong | Outcome::Stale => Err(StatusCode::UNAUTHORIZED),
    }
}

/// `GET /api/auth/session` — does this browser hold a live credential?
///
/// ⚠️ **`no-store`, WHICH IT DID NOT SAY.** This is a cacheable GET, and its
/// answer is authentication state: a browser or an intervening proxy could
/// reuse a 204 after a sign-out, or a 401 after signing in, and the client
/// would show the wrong screen with nothing to explain it. `POST` endpoints are
/// not cached by default; this one is the exception and has to say so.
async fn session(_admitted: Admitted) -> Response {
    /* The extractor is the whole endpoint: reaching this line means a live
     * credential, and failing to reach it is already a 401. */
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `POST /api/auth/signout` — revoke this browser's credential.
///
/// Idempotent, and deliberately answers the same way whether or not anything
/// was revoked: a caller who can ask cannot use the answer to learn whether
/// some other credential exists.
async fn signout(
    _same_origin: SameOrigin,
    State(state): State<Arc<WebHost>>,
    request_headers: axum::http::HeaderMap,
) -> Response {
    if let Some(credential) = presented(&request_headers) {
        /* BOTH HALVES, IN THIS ORDER. Forgetting the credential first means a
         * socket that closes a moment later cannot be re-opened in between;
         * closing first would leave a window where the browser reconnects with
         * a credential that is still good. `Sessions::revoke` warns that
         * forgetting alone leaves an open socket answering requests — this is
         * the call that stops it. */
        let _ = state.sessions.revoke(&credential);
        state.pipe.close_credential(&credential, "revoked");
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_cookie()).expect("a static cookie string is a valid header"),
    );
    response
}

/// `GET /ws` — the browser's frame channel.
///
/// **The gate is here and nowhere else.** Everything past the upgrade assumes
/// an admitted socket, so this is the one place a request without a live
/// credential must be turned away. It runs the two-phase check in full:
/// `validate` answers about a moment, `admit` re-checks that moment. Skipping
/// the second would reopen finding 7 on the exact path that matters most,
/// because a WebSocket outlives the request that created it.
///
/// ⚠️ **`SameOrigin` COMES FIRST, and until phase 18's audit there was nothing
/// in that position at all.** Holding a live credential was the only question
/// asked, and `SameSite=Strict` was trusted to decide who could ask it — which
/// covers a cross-site page and says nothing about a same-site one. The shelf's
/// public name is a tailnet subdomain with siblings, so "same site" is a
/// Public Suffix List question this repository does not get to answer. And the
/// prize is larger here than on any other route: a socket that opens once is a
/// read channel over the entire library until it is closed.
///
/// Extractors run left to right, which is the same ordering argument the note
/// on [`Admitted`] makes about `WebSocketUpgrade` — a check that runs after the
/// upgrade extractor does not run at all.
async fn upgrade(
    _same_origin: SameOrigin,
    State(state): State<Arc<WebHost>>,
    admitted: Admitted,
    ws: WebSocketUpgrade,
) -> Response {
    let (outbound, receiver) = mpsc::channel(OUTBOUND_CAP);
    /* CARRIED TO THE SOCKET. `admitted` is moved into the closure below, so the
     * deadline is taken out here — see `pump`. */
    let expires_at = admitted.expires_at;
    /* THE ADMISSION WINDOW, held open for a test that asks. Admission has
     * succeeded; the pipe record does not exist yet. See `pause_before_open`. */
    state.admit_gate().await;
    let Ok(socket) = state
        .pipe
        .open(admitted.session, admitted.credential.clone(), outbound)
    else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };

    /* REGISTER, THEN RE-CHECK — the third phase, and the one the two in
     * `Sessions` cannot supply.
     *
     * `Admitted` runs `validate` then `admit`, which closes the window between
     * asking and being told. It does not close the window between being told
     * and this socket EXISTING. A revocation landing in there does both of its
     * halves — forgets the credential, then closes every socket that credential
     * holds — and finds no socket, because `Pipe::open` had not run yet. A
     * moment later it runs, and the browser the reader just revoked is holding
     * a live authenticated channel while the Browsers pane says it is gone.
     *
     * The order here is what makes it airtight, and it is the same order
     * `Sessions::admit` uses: the socket is registered FIRST, so a revocation
     * after this point is guaranteed to find it. Only then do we ask whether
     * the credential is still good. Either the revocation precedes the check
     * and we refuse, or it follows the registration and `close_credential`
     * reaches us. There is no third arrangement. */
    if state
        .sessions
        .validate(&admitted.credential, Instant::now())
        .is_err()
    {
        state.pipe.close(socket, "revoked before registration");
        state.pipe.reap(socket);
        return StatusCode::UNAUTHORIZED.into_response();
    }

    /* THE PROTOCOL'S CAP, TOLD TO THE SOCKET ITSELF.
     *
     * `Pipe::push` refuses anything over `MAX_FRAME` — but it only sees a
     * message axum has already ASSEMBLED, and axum's defaults are 64 MiB per
     * message and 16 MiB per frame. So a browser could make the shelf buffer
     * sixteen times the protocol's own limit before the refusal fired, per
     * socket, across `MAX_SESSIONS` of them. The check downstream was real and
     * the memory was spent upstream of it.
     *
     * Set here rather than only in `pipe.rs` because this is where the buffer
     * is allocated; `Pipe::push` keeps its own check, since the two guard
     * different things — this one bounds the ASSEMBLY, that one bounds what
     * reaches the inbox. */
    let socket_for_failure = socket;
    let host = Arc::clone(&state);
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        /* A PIPE RECORD IS OPENED BEFORE THE UPGRADE CAN FAIL, and axum's
         * default failure callback returns without running anything — so a
         * client that disconnects mid-handshake left a record nothing would
         * ever close. `MAX_SESSIONS_PER_CREDENTIAL` is four; four abandoned
         * handshakes and that credential could open no more sockets, for the
         * life of the process, with nothing logged.
         *
         * ⚠️ AND CLOSED IS NOT GONE. The first fix closed the record and
         * stopped, which freed the credential's share and nothing else:
         * `Pipe::open` counts every record toward `MAX_SESSIONS`, closed or
         * not, and only `reap` removes one — every other exit path here does
         * both. Sixty-four abandoned handshakes, over any span of time, and
         * the shelf answered 429 to every browser for the life of the
         * process, with nothing in the Browsers pane to explain it. The
         * record's task is this closure — there is no socket, so no `pump`
         * will ever reap on its behalf. */
        .on_failed_upgrade(move |_error| {
            host.pipe.close(socket_for_failure, "upgrade failed");
            host.pipe.reap(socket_for_failure);
            host.failed_upgrades.fetch_add(1, Ordering::Release);
        })
        .on_upgrade(move |ws| pump(state, socket, ws, receiver, expires_at))
}

/// Move frames both ways until either end stops.
///
/// ONE TASK AND A `select!`, rather than a split with two. `axum`'s socket
/// exposes `recv` and `send` directly, so splitting would mean pulling in a
/// futures dependency to buy a concurrency the reader does not need: the only
/// thing a send blocks on is the socket buffer, and a browser that has stopped
/// draining SHOULD stop being read from. That is backpressure, not a stall.
async fn pump(
    state: Arc<WebHost>,
    socket: WebSessionId,
    mut ws: WebSocket,
    mut outbound: mpsc::Receiver<Vec<u8>>,
    expires_at: Instant,
) {
    /* THE CREDENTIAL'S OWN DEADLINE, ON THE SOCKET.
     *
     * ⚠️ Expiry was checked at the HANDSHAKE and nowhere else, and a WebSocket
     * outlives the request that made it. A browser connecting on day 89 held an
     * authenticated channel indefinitely — nothing re-read the credential once
     * the socket was open — so `CREDENTIAL_TTL` bounded only the act of
     * connecting. The whole point of an absolute ceiling is that a browser
     * forgotten on a borrowed laptop stops working on its own, and it did not.
     *
     * `tokio::time::Instant` from a `std::time::Instant`: the deadline is a
     * point, so the remaining duration is what carries across. Saturating,
     * because a credential can be past its ceiling before this runs. */
    let remaining = expires_at.saturating_duration_since(Instant::now());
    let expiry = tokio::time::sleep(tokio::time::Duration::from_secs_f64(
        remaining.as_secs_f64().min(u32::MAX as f64),
    ));
    tokio::pin!(expiry);
    /* THE FRAME THE INBOX REFUSED, HELD RATHER THAN DROPPED.
     *
     * This used to be `Push::Backpressure => yield_now().await`, under a comment
     * asserting "nothing is dropped… the frame is retried by the browser because
     * we simply stop reading, and TCP does the rest." Every clause of that is
     * wrong, and it is wrong in the direction that looks right.
     *
     * By the time `push` refuses, `ws.recv()` has already returned the message:
     * it was reassembled, ACKed at the TCP layer, and moved into `frame`, a
     * local that the match arm then dropped. TCP retransmits bytes the peer did
     * not acknowledge; these were acknowledged. The browser has no idea the
     * frame went nowhere and will never send it again. What was lost is one
     * request or one response of a binary envelope — silently, under load only,
     * which is the hardest possible shape to catch in the field.
     *
     * Holding it makes the claim true: the next loop iteration retries this
     * frame and does not read another until it lands. Not reading IS the
     * backpressure the comment wanted; it just has to happen with the frame
     * still in hand. */
    let mut pending: Option<Vec<u8>> = None;
    /* WHEN the held frame is next offered. Absolute, so a busy outbound arm
     * cannot push it further away — see `RetryAt`. */
    let mut retry_at = RetryAt::default();

    loop {
        /* WHILE A FRAME IS HELD: stop reading the socket, keep writing to it,
         * and retry on a TIMER.
         *
         * All three parts are load-bearing, and the first draft of this fix got
         * the third wrong. It retried under `yield_now()`, which yields to the
         * scheduler and comes straight back — so between the inbox filling and
         * the webview's next drain (a 40 ms poll from the TypeScript side) this
         * task spun at full speed, re-pushing a frame it had just been told
         * there was no room for. Holding the frame fixed the data loss and
         * bought a busy-wait.
         *
         * The timer is what makes waiting cheap. `RETRY` is well under the
         * webview's poll interval, so capacity is taken up promptly once it
         * appears, and the cost while full is a handful of wakeups a second
         * rather than a core.
         *
         * ⚠️ THE OUTBOUND ARM STAYS LIVE, which the first draft also lost: it
         * `continue`d past the `select!` entirely, so a full INBOX stalled
         * traffic in the opposite direction — a browser reading a book stopped
         * receiving it because of something it had SENT. The two directions are
         * independent and have to stay that way.
         *
         * A drain notification from `Pipe` would be tighter still. It is not
         * here because it would put a `Notify` on every session for a saving
         * measured in milliseconds on a path that is already the slow one. */
        if pending.is_some() {
            /* AN ABSOLUTE DEADLINE, NOT A FRESH `sleep(RETRY)` EACH TIME.
             *
             * `select!` builds its futures anew on every pass, so a relative
             * sleep restarts from zero whenever the OTHER arm wins. A browser
             * being sent a book keeps `outbound.recv()` ready, the timer was
             * therefore re-armed faster than it could ever elapse, and the held
             * frame was never retried for as long as the stream lasted — the
             * data loss this whole path exists to prevent, arrived at through
             * starvation instead of through dropping. `sleep_until` is
             * cancel-safe against the same instant: rebuilding it changes
             * nothing about when it fires. */
            let deadline = retry_at.deadline(tokio::time::Instant::now());
            tokio::select! {
                frame = outbound.recv() => {
                    let Some(frame) = frame else { break };
                    if state.pipe.closed_reason(socket).is_some() {
                        break;
                    }
                    let len = frame.len();
                    let sent = ws.send(Message::Binary(frame.into())).await;
                    state.pipe.drained(socket, len);
                    if sent.is_err() {
                        break;
                    }
                }
                () = tokio::time::sleep_until(deadline) => {
                    retry_at.taken();
                    let frame = pending.take().expect("checked immediately above");
                    match state.pipe.push(socket, frame) {
                        Push::Accepted => {}
                        Push::Backpressure(frame) => pending = Some(frame),
                        Push::TooLarge | Push::Gone => break,
                    }
                }
            }
            continue;
        }

        tokio::select! {
            /* THE CREDENTIAL RAN OUT. Closing rather than merely stopping, so
             * the browser learns and the record is reaped like any other end. */
            () = &mut expiry => {
                state.pipe.close(socket, "credential expired");
                break;
            }
            /* Ends when the channel closes, which is what `Pipe::close` does by
             * dropping the sender. No second flag to keep in step. */
            frame = outbound.recv() => {
                let Some(frame) = frame else { break };
                /* A REVOCATION MUST NOT BE OUTRUN BY THE QUEUE.
                 *
                 * `Pipe::close` revokes by dropping the sender, and the comment
                 * on the channel says that "ends the socket's write task
                 * without needing a second signal". It ends it EVENTUALLY:
                 * tokio's mpsc delivers everything already buffered before
                 * `recv` reports the close. Up to `OUTBOUND_BYTE_CAP` of book
                 * bytes were therefore written to a browser after the reader
                 * had revoked it — the one moment they had said they did not
                 * want that browser reading.
                 *
                 * Asking the pipe is the second signal, and it has to be here
                 * rather than only at the top of the loop: `recv` is what
                 * yields, so the close can land while this arm is waiting. */
                if state.pipe.closed_reason(socket).is_some() {
                    break;
                }
                /* THE BUDGET IS FREED HERE, because this is where the queue
                 * actually shortens. `Pipe::send` counts bytes in; the channel
                 * itself counts only messages, so without this call the byte
                 * budget fills once and never empties, and every browser
                 * eventually stops being sent anything. */
                let len = frame.len();
                let sent = ws.send(Message::Binary(frame.into())).await;
                state.pipe.drained(socket, len);
                if sent.is_err() {
                    break;
                }
            }
            incoming = ws.recv() => {
                let Some(Ok(message)) = incoming else { break };
                let frame = match message {
                    Message::Binary(bytes) => bytes.to_vec(),
                    /* TEXT IS NOT THE PROTOCOL. The envelope is binary; a text
                     * frame is a confused client or a probe, and accepting it
                     * would be a second encoding for both sides to agree
                     * about. */
                    Message::Text(_) => {
                        state.pipe.close(socket, "text frame");
                        break;
                    }
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => continue,
                };
                match state.pipe.push(socket, frame) {
                    Push::Accepted => {}
                    /* Held, not dropped — see the note on `pending`. */
                    Push::Backpressure(frame) => {
                        pending = Some(frame);
                        tokio::task::yield_now().await;
                    }
                    Push::TooLarge | Push::Gone => break,
                }
            }
        }
    }

    state.pipe.close(socket, "socket ended");
    state.pipe.reap(socket);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Method;
    use tower::ServiceExt;

    fn host() -> Arc<WebHost> {
        Arc::new(WebHost::new())
    }

    fn json_post(uri: &str, body: &str, cookie: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder
            .body(Body::from(body.to_owned()))
            .expect("a request")
    }

    fn get(uri: &str, cookie: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder.body(Body::empty()).expect("a request")
    }

    fn live_code(state: &WebHost) -> String {
        let offer = state.auth.begin(Instant::now());
        String::from_utf8(offer.code.digits().to_vec()).expect("ascii digits")
    }

    /// The same request, tagged with the `Sec-Fetch-Site` a browser would send.
    fn from_site(mut request: Request<Body>, site: &str) -> Request<Body> {
        request
            .headers_mut()
            .insert("sec-fetch-site", site.parse().expect("an ascii token"));
        request
    }

    async fn call(state: Arc<WebHost>, request: Request<Body>) -> Response {
        /* NO CLIENT in these tests: the endpoints are what is under test, and
         * embedding a bundle to exercise them would make the suite depend on a
         * JavaScript build having run. */
        router(state, assets::NO_CLIENT)
            .oneshot(request)
            .await
            .expect("infallible")
    }

    /// A six-digit code that is NOT the live one.
    ///
    /// A literal cannot promise that. Three tests here submitted `000000` and
    /// one of them returned success when the generated code happened to match
    /// — an assertion that skips itself once in a million runs, reporting green
    /// on the run where it mattered. Rotating one digit is guaranteed wrong and
    /// costs nothing.
    fn wrong(code: &str) -> String {
        code.chars()
            .enumerate()
            .map(|(i, c)| {
                if i == 0 {
                    char::from_digit((c.to_digit(10).unwrap_or(0) + 1) % 10, 10).unwrap_or('1')
                } else {
                    c
                }
            })
            .collect()
    }

    #[tokio::test]
    async fn the_right_code_sets_an_unreadable_cookie() {
        let state = host();
        let code = live_code(&state);
        let response = call(
            Arc::clone(&state),
            json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .expect("a session cookie")
            .to_str()
            .expect("ascii");

        /* THE ASSERTION THAT MATTERS. Finding 6 is defeated by these three
         * attributes and by nothing else in this crate; a change that drops
         * one of them must not be able to pass. */
        assert!(
            cookie.contains("HttpOnly"),
            "page script must not read it: {cookie}"
        );
        assert!(
            cookie.contains("Secure"),
            "must refuse a plaintext origin: {cookie}"
        );
        assert!(cookie.contains("SameSite=Strict"), "CSRF: {cookie}");
        assert!(cookie.starts_with(SESSION_COOKIE));

        /* ONE LIFETIME, NOT TWO THAT AGREE TODAY. `Max-Age` was arithmetic
         * repeated here — the same `60 * 60 * 24 * 90` that `CREDENTIAL_TTL`
         * computes. Either can move without the other, and neither direction
         * raises: shorten the server's and a browser goes on presenting a
         * credential that is already dead; lengthen it and the cookie vanishes
         * from a browser the shelf still thinks is signed in. */
        assert!(
            cookie.contains(&format!("Max-Age={}", CREDENTIAL_TTL.as_secs())),
            "the cookie's lifetime must be the credential's: {cookie}"
        );
    }

    #[tokio::test]
    async fn a_wrong_code_is_unauthorized_and_sets_nothing() {
        let state = host();
        let code = live_code(&state);
        let response = call(
            Arc::clone(&state),
            json_post(
                "/api/auth/submit",
                &format!(r#"{{"code":"{}"}}"#, wrong(&code)),
                None,
            ),
        )
        .await;
        /* NO ESCAPE HATCH. This used to submit a literal `000000` and RETURN
         * SUCCESSFULLY if the live code happened to be that — one run in a
         * million where the test asserted nothing and reported green. `wrong`
         * derives a code that cannot be the live one, so the branch is gone
         * rather than made rarer. */
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
    }

    #[tokio::test]
    async fn submitting_with_no_live_code_is_a_conflict_not_an_unauthorized() {
        /* The distinction is for the human: "nobody pressed the button on the
         * shelf" is a different fix from "you typed it wrong". */
        let state = host();
        let response = call(
            state,
            json_post("/api/auth/submit", r#"{"code":"123456"}"#, None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn the_sixth_attempt_is_refused_without_testing_the_code() {
        let state = host();
        let code = live_code(&state);
        /* A CODE THAT CANNOT BE RIGHT. A literal `000000` is the live code once
        in a million runs, and on that run the first submission SUCCEEDS —
        so the budget is never spent and the test asserts the opposite of
        what it is named for, in green. */
        let miss = wrong(&code);
        for _ in 0..5 {
            let _ = call(
                Arc::clone(&state),
                json_post("/api/auth/submit", &format!(r#"{{"code":"{miss}"}}"#), None),
            )
            .await;
        }
        /* The RIGHT code, refused — because the budget is spent before any
         * comparison happens. */
        let response = call(
            Arc::clone(&state),
            json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
    }

    #[tokio::test]
    async fn a_session_needs_the_cookie() {
        let state = host();
        assert_eq!(
            call(Arc::clone(&state), get("/api/auth/session", None))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                Arc::clone(&state),
                get("/api/auth/session", Some("paper_session=nonsense"))
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn a_granted_cookie_round_trips_and_signout_kills_it() {
        let state = host();
        let code = live_code(&state);
        let granted = call(
            Arc::clone(&state),
            json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
        )
        .await;
        let raw = granted
            .headers()
            .get(header::SET_COOKIE)
            .expect("cookie")
            .to_str()
            .expect("ascii");
        let pair = raw.split(';').next().expect("name=value");

        assert_eq!(
            call(Arc::clone(&state), get("/api/auth/session", Some(pair)))
                .await
                .status(),
            StatusCode::NO_CONTENT
        );

        let out = call(
            Arc::clone(&state),
            json_post("/api/auth/signout", "", Some(pair)),
        )
        .await;
        assert_eq!(out.status(), StatusCode::NO_CONTENT);
        assert!(out
            .headers()
            .get(header::SET_COOKIE)
            .expect("a clearing cookie")
            .to_str()
            .expect("ascii")
            .contains("Max-Age=0"));

        assert_eq!(
            call(Arc::clone(&state), get("/api/auth/session", Some(pair)))
                .await
                .status(),
            StatusCode::UNAUTHORIZED,
            "the credential must be dead after signout"
        );
    }

    #[tokio::test]
    async fn signing_out_closes_the_live_socket_not_just_the_credential() {
        /* PLAN §7, end to end. `Sessions::revoke` forgetting the credential is
         * not enough on its own — its own doc comment says a revocation that
         * only forgets leaves an open socket answering requests. This asserts
         * the HTTP path does both. */
        let state = host();
        let code = live_code(&state);
        let granted = call(
            Arc::clone(&state),
            json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
        )
        .await;
        let pair = granted.headers()[header::SET_COOKIE]
            .to_str()
            .expect("ascii")
            .split(';')
            .next()
            .expect("name=value")
            .to_owned();
        let value = pair.split_once('=').expect("name=value").1.to_owned();
        let credential = paper_webauth::sessions::Credential::from_presented(&value);

        // A socket the browser already holds, admitted the ordinary way.
        let admission = state
            .sessions
            .validate(&credential, Instant::now())
            .expect("valid");
        let admitted = state.sessions.admit(admission).expect("admitted");
        /* `_rx` is bound, not dropped: dropping the receiver closes the
         * channel, and a later `send` would then say `Gone` for a reason that
         * has nothing to do with what this test is about. */
        let (tx, _rx) = tokio::sync::mpsc::channel(crate::pipe::OUTBOUND_CAP);
        let socket = state
            .pipe
            .open(admitted, credential.clone(), tx)
            .expect("a live socket");
        assert_eq!(state.pipe.live_count(), 1);

        let _ = call(
            Arc::clone(&state),
            json_post("/api/auth/signout", "", Some(&pair)),
        )
        .await;

        assert_eq!(
            state.pipe.closed_reason(socket).as_deref(),
            Some("revoked"),
            "the socket must close, not merely the credential"
        );
        assert_eq!(state.pipe.live_count(), 0);
        assert_eq!(
            state.pipe.push(socket, b"still here?".to_vec()),
            crate::pipe::Push::Gone
        );
    }

    #[tokio::test]
    async fn a_cookie_header_carrying_other_cookies_still_resolves() {
        let state = host();
        let code = live_code(&state);
        let granted = call(
            Arc::clone(&state),
            json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
        )
        .await;
        let pair = granted.headers()[header::SET_COOKIE]
            .to_str()
            .expect("ascii")
            .split(';')
            .next()
            .expect("name=value")
            .to_owned();

        let crowded = format!("theme=dark; {pair}; other=1");
        assert_eq!(
            call(Arc::clone(&state), get("/api/auth/session", Some(&crowded)))
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn a_lookalike_cookie_name_is_not_the_session_cookie() {
        /* `paper_session_x=` must not be read as `paper_session=`. A
         * `starts_with` would have. */
        let state = host();
        let code = live_code(&state);
        let granted = call(
            Arc::clone(&state),
            json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
        )
        .await;
        let value = granted.headers()[header::SET_COOKIE]
            .to_str()
            .expect("ascii")
            .split(';')
            .next()
            .expect("pair")
            .split_once('=')
            .expect("name=value")
            .1
            .to_owned();

        let impostor = format!("paper_session_x={value}");
        assert_eq!(
            call(
                Arc::clone(&state),
                get("/api/auth/session", Some(&impostor))
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    /// A syntactically valid upgrade request, so the only thing under test is
    /// the credential check rather than axum's own header rejection.
    fn upgrade_request(cookie: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method(Method::GET)
            .uri("/ws")
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_VERSION, "13")
            .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder.body(Body::empty()).expect("a request")
    }

    async fn granted_cookie(state: &Arc<WebHost>) -> String {
        let code = live_code(state);
        let granted = call(
            Arc::clone(state),
            json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
        )
        .await;
        granted.headers()[header::SET_COOKIE]
            .to_str()
            .expect("ascii")
            .split(';')
            .next()
            .expect("name=value")
            .to_owned()
    }

    #[tokio::test]
    async fn the_socket_refuses_every_request_without_a_live_credential() {
        /* THE GATE. Everything past the upgrade assumes an admitted socket, and
         * a WebSocket outlives the request that made it — so a miss here is not
         * one leaked response but a live channel. */
        let state = host();
        for (label, cookie) in [
            ("no cookie at all", None),
            ("a nonsense value", Some("paper_session=nope")),
            ("an empty value", Some("paper_session=")),
            ("a lookalike name", Some("paper_session_x=anything")),
        ] {
            let response = call(Arc::clone(&state), upgrade_request(cookie)).await;
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "the socket opened for {label}"
            );
        }
    }

    #[tokio::test]
    async fn a_live_credential_gets_past_the_gate() {
        /* WHAT THIS CAN AND CANNOT SHOW. `oneshot` has no connection to
         * upgrade, so axum's own extractor answers 426 however good the
         * credential is — a 101 is not reachable from this harness.
         *
         * What it does show is the thing worth showing: the credential check
         * runs FIRST and passes, so the request reaches the upgrade machinery
         * instead of being turned away. A regression that broke the extractor
         * order would show up here as a 401.
         *
         * The real handshake is exercised by the two-device run (WI-18.11). */
        let state = host();
        let cookie = granted_cookie(&state).await;
        let status = call(Arc::clone(&state), upgrade_request(Some(&cookie)))
            .await
            .status();
        assert_ne!(
            status,
            StatusCode::UNAUTHORIZED,
            "a live credential was refused"
        );
        assert_eq!(
            status,
            StatusCode::UPGRADE_REQUIRED,
            "expected axum's own rejection, meaning the gate passed and the harness cannot upgrade"
        );
    }

    #[tokio::test]
    async fn a_revoked_credential_cannot_open_a_socket() {
        /* Finding 7 on the path that matters most: the credential was good a
         * moment ago and the browser still holds the cookie. */
        let state = host();
        let cookie = granted_cookie(&state).await;
        let _ = call(
            Arc::clone(&state),
            json_post("/api/auth/signout", "", Some(&cookie)),
        )
        .await;

        let response = call(Arc::clone(&state), upgrade_request(Some(&cookie))).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    /* NO HTTP-LEVEL TEST FOR THE PER-BROWSER SOCKET BOUND, deliberately.
     * `oneshot` cannot complete an upgrade, so the handler body never runs and
     * no socket is ever opened — a test here would assert on a code path it
     * did not reach. The bound is enforced in `Pipe::open` and tested there
     * (`one_credential_cannot_hold_more_than_its_share`), which is where it
     * lives. Writing a green test here would have been worse than none. */

    #[tokio::test]
    async fn every_response_carries_the_policy_including_the_failures() {
        let state = host();
        for request in [
            get("/api/auth/session", None),
            json_post("/api/auth/submit", r#"{"code":"1"}"#, None),
            get("/nope", None),
        ] {
            let response = call(Arc::clone(&state), request).await;
            let csp = response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .unwrap_or_else(|| panic!("no policy on {}", response.status()))
                .to_str()
                .expect("ascii");
            /* Adversarial suite 8, and it is about `script-src` SPECIFICALLY.
             *
             * This used to search the WHOLE policy for "unsafe-inline", which
             * was true while nothing needed it and became wrong the moment a
             * reading surface existed: `style-src` needs it — the client's own
             * shell applies an inline stylesheet, and without it the page
             * renders unstyled — and inline CSS cannot execute JavaScript.
             *
             * Plan §6 says what the decision actually is: "`script-src`
             * excludes `unsafe-inline`, `unsafe-eval` and `blob:`". A check
             * that guards more than the decision will one day refuse the
             * decision, which is what happened here.
             *
             * `scripts/csp-effect.mjs` measures what this shape DOES: in WebKit
             * and Chromium a book's script does not run, inline or from an
             * object URL. */
            let script_src = csp
                .split(';')
                .map(str::trim)
                .find(|part| part.starts_with("script-src"))
                .unwrap_or_else(|| panic!("no script-src in {csp}"));
            assert_eq!(script_src, "script-src 'self'", "the boundary moved: {csp}");
            assert!(csp.contains("object-src 'none'"), "{csp}");
        }
    }

    /// THE UPGRADE CARRIES THE PROTOCOL'S OWN CAP.
    ///
    /// `Pipe::push` refuses anything over `MAX_FRAME`, but it only sees a
    /// message axum has already ASSEMBLED — and axum's defaults are 64 MiB per
    /// message and 16 MiB per frame. Without these two calls the refusal is
    /// still correct and the memory is still spent, sixteen times the
    /// protocol's limit, per socket, across `MAX_SESSIONS` of them.
    ///
    /// `tests/upgrade.rs` proves the BEHAVIOUR — an oversized message ends the
    /// socket — and cannot prove the bound: removing these calls leaves that
    /// test passing unchanged, because `push` closes the socket too. The only
    /// client-visible difference is which flavour of connection reset arrives,
    /// which is an OS detail. So the bound is asserted here, against the source,
    /// the way `tauri-plugin-inference`'s `limits.rs` reads `commands.rs`.
    /// THE STATE-CHANGING ENDPOINTS REFUSE A PAGE THAT IS NOT OURS.
    ///
    /// `SameSite=Strict` is documented above as "the CSRF defence", and against
    /// a cross-site page it is. It says nothing about a same-site one, and this
    /// shelf's public name is a tailnet subdomain whose siblings may or may not
    /// count as the same site depending on the Public Suffix List — a file this
    /// repository does not own. Both endpoints are worth the check for
    /// different reasons: a forced `signout` is a denial of service the reader
    /// cannot explain, and a forged `submit` burns the five attempts guarding
    /// the six digits the reader is at that moment reading off their screen.
    #[tokio::test]
    async fn a_same_site_page_cannot_sign_out_or_spend_the_attempts() {
        let state = host();
        let code = live_code(&state);

        for site in ["same-site", "cross-site"] {
            let response = call(
                Arc::clone(&state),
                from_site(json_post("/api/auth/signout", "", None), site),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "signout from {site} must be refused"
            );

            let response = call(
                Arc::clone(&state),
                from_site(
                    json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
                    site,
                ),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "submit from {site} must be refused"
            );
        }

        /* AND THE ATTEMPTS WERE NEVER SPENT. The refusal has to happen before
         * `reserve`, or a forged POST still costs the reader a try each time —
         * a rate limit an attacker can drain is not one. The right code still
         * works, which is the proof. */
        let response = call(
            Arc::clone(&state),
            from_site(
                json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
                "same-origin",
            ),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::NO_CONTENT,
            "the shelf's own page must still be able to sign in"
        );
    }

    /// THE `Origin` FALLBACK, which no test reached.
    ///
    /// `SameOrigin` prefers Fetch Metadata and falls back to comparing `Origin`
    /// against `Host` when a client sends no `Sec-Fetch-Site`. The integration
    /// suite drives a tungstenite client, which sends neither header, so the
    /// whole fallback — including its refusal — was unexercised. In-process is
    /// the right place for it: the branch is about headers, not sockets.
    #[tokio::test]
    async fn a_mismatched_origin_is_refused_when_there_is_no_fetch_metadata() {
        let state = host();
        let code = live_code(&state);

        let with = |origin: Option<&str>, host_header: Option<&str>| {
            let mut request =
                json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None);
            if let Some(origin) = origin {
                request
                    .headers_mut()
                    .insert(header::ORIGIN, origin.parse().expect("ascii"));
            }
            if let Some(host_header) = host_header {
                request
                    .headers_mut()
                    .insert(header::HOST, host_header.parse().expect("ascii"));
            }
            request
        };

        /* A DIFFERENT AUTHORITY IS REFUSED. */
        let response = call(
            Arc::clone(&state),
            with(Some("https://evil.example"), Some("studio.tail1234.ts.net")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        /* An `Origin` with no comparable `Host` is refused too: the pair is the
         * only thing this branch can judge, and half of it is not evidence. */
        let response = call(Arc::clone(&state), with(Some("https://evil.example"), None)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        /* THE MATCHING PAIR IS ADMITTED, so the refusals above are about the
         * mismatch and not about the fallback refusing everything. */
        let response = call(
            Arc::clone(&state),
            with(
                Some("https://studio.tail1234.ts.net"),
                Some("studio.tail1234.ts.net"),
            ),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::NO_CONTENT,
            "the shelf's own page, identified by Origin alone, must still sign in"
        );
    }

    /// RE-READING THE RETRY DEADLINE MUST NOT MOVE IT.
    ///
    /// This is the whole difference between `sleep_until(deadline)` and
    /// `sleep(RETRY)` inside a `select!`. The macro rebuilds its futures every
    /// pass, so a relative sleep is `now + RETRY` each time — and with the
    /// outbound arm continuously ready, "each time" is sub-millisecond and the
    /// four milliseconds never elapse. The held frame is never retried while
    /// the shelf is streaming.
    ///
    /// An integration test could not see it: a producer cannot be made to
    /// outpace the pump reliably, so between bursts the relative timer got its
    /// interval and the frame arrived. This is the property that separates the
    /// two, checked where it is exact.
    #[tokio::test]
    async fn the_deadline_does_not_move_when_it_is_read_again() {
        let start = tokio::time::Instant::now();
        let mut retry = RetryAt::default();

        let first = retry.deadline(start);
        assert_eq!(
            first,
            start + RETRY,
            "the first read sets it one interval out"
        );

        /* The outbound arm winning, repeatedly, while the frame is still held.
         * A relative sleep would answer `later + RETRY` every time and the
         * deadline would recede for ever. */
        for step in 1..=10 {
            let later = start + std::time::Duration::from_millis(step);
            assert_eq!(
                retry.deadline(later),
                first,
                "re-reading the deadline {step}ms later must not postpone it",
            );
        }

        /* AND IT RESETS ONCE THE RETRY HAS RUN, or every later retry would fire
         * instantly against a deadline already in the past. */
        retry.taken();
        let after = start + std::time::Duration::from_millis(50);
        assert_eq!(retry.deadline(after), after + RETRY);
    }

    /// AN UNKNOWN `/api` PATH IS A 404, NOT THE CLIENT.
    ///
    /// The single-page fallback answered every unmatched path with the entry
    /// document at status 200 — so a client calling an endpoint this build does
    /// not have received HTML and a success code and parsed it as an answer. A
    /// typo in a service path became a mystery about JSON.
    #[tokio::test]
    async fn an_unknown_api_path_is_not_the_single_page_app() {
        let state = host();
        for path in ["/api/auth/nope", "/api/nothing", "/api/auth/session/extra"] {
            let response = call(Arc::clone(&state), get(path, None)).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
        /* AND AN ORDINARY PATH STILL GETS THE CLIENT — with `NO_CLIENT` here
         * that is the empty-bundle answer rather than a 404, which is what
         * distinguishes "no route" from "no bundle". */
        let ordinary = call(Arc::clone(&state), get("/some/reader/route", None)).await;
        assert_ne!(ordinary.status(), StatusCode::NOT_FOUND);
    }

    /// THE SESSION CHECK IS NOT CACHEABLE.
    ///
    /// It is a GET whose answer is authentication state. Without `no-store` a
    /// browser or an intervening proxy could reuse a 204 after a sign-out, or a
    /// 401 after signing in, and the client shows the wrong screen with nothing
    /// to explain it.
    #[tokio::test]
    async fn the_session_check_refuses_to_be_cached() {
        let state = host();
        let code = live_code(&state);
        let response = call(
            Arc::clone(&state),
            from_site(
                json_post("/api/auth/submit", &format!(r#"{{"code":"{code}"}}"#), None),
                "same-origin",
            ),
        )
        .await;
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .expect("a cookie")
            .to_owned();

        let session = call(Arc::clone(&state), get("/api/auth/session", Some(&cookie))).await;
        assert_eq!(session.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            session
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-store"),
        );
    }

    #[test]
    fn the_upgrade_is_bounded_by_the_protocols_own_cap() {
        let source = include_str!("lib.rs");
        let at = source
            .find("async fn upgrade(")
            .expect("the upgrade handler is gone — this guard cannot see it");
        let body_end = source[at..]
            .find("\nasync fn pump(")
            .expect("the upgrade handler no longer precedes `pump`");
        let body = &source[at..at + body_end];

        for call in ["max_message_size(MAX_FRAME)", "max_frame_size(MAX_FRAME)"] {
            assert!(
                body.contains(call),
                "the upgrade must set {call}: without it axum assembles up to its own 64 MiB \
                 default before Pipe::push refuses the frame, which is the memory this cap exists \
                 to refuse spending"
            );
        }
    }

    #[tokio::test]
    async fn the_body_of_a_refusal_says_nothing_about_the_code() {
        let state = host();
        let code = live_code(&state);
        let response = call(
            state,
            json_post(
                "/api/auth/submit",
                &format!(r#"{{"code":"{}"}}"#, wrong(&code)),
                None,
            ),
        )
        .await;
        /* THE STATUS IS ASSERTED FIRST, and that is not padding. With a literal
        `000000` this test passed when the code happened to match: the answer
        was 204, whose body is empty by definition, so "a refusal must not
        describe the code" held over something that was not a refusal. */
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = to_bytes(response.into_body(), 4096).await.expect("a body");
        assert!(body.is_empty(), "a refusal must not describe the code");
    }
}
