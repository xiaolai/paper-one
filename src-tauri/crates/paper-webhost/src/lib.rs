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
//! ## What is NOT here yet
//!
//! The frame pipe to the webview, and the embedded SPA. The service router
//! lives in TypeScript — `serve(services)` is a method on the webview's peer
//! port — so this server can never answer a service call itself. It will pipe
//! frames, exactly as `tauri-plugin-peer` does. Anything that starts answering
//! service calls in Rust here is building a second copy of every handler.

pub mod assets;
pub mod pipe;

use std::sync::Arc;
use std::time::Instant;

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

/// The policy that stands between a shared book and everything else.
///
/// `script-src 'self'` with no `'unsafe-inline'`, no `'unsafe-eval'` and no
/// `blob:` — the three that would each, on their own, let a book's JavaScript
/// run in this origin.
///
/// `frame-src 'self' blob:` is deliberate and is NOT a hole: foliate needs to
/// put the book in an iframe, and the book is a blob. What matters is that the
/// frame cannot bring executable script into the parent's origin, which
/// `script-src` governs and this does not widen.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
     script-src 'self'; \
     style-src 'self'; \
     img-src 'self' blob: data:; \
     font-src 'self'; \
     connect-src 'self'; \
     frame-src 'self' blob:; \
     object-src 'none'; \
     base-uri 'none'; \
     form-action 'none'; \
     frame-ancestors 'none'";

/// Everything the HTTP surface needs. One live code, and every issued session.
pub struct WebHost {
    pub auth: DeviceAuth,
    pub sessions: Sessions,
    pub pipe: Pipe,
}

impl WebHost {
    pub fn new() -> Self {
        Self {
            auth: DeviceAuth::new(),
            sessions: Sessions::new(),
            pipe: Pipe::new(),
        }
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
         * cannot shadow `/api` or `/ws`, however a browser spells them. */
        .fallback(move |uri: axum::http::Uri| async move { assets::serve(client, &uri) })
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
        let session = state
            .sessions
            .admit(admission)
            .map_err(|_| StatusCode::UNAUTHORIZED)?;
        Ok(Self {
            session,
            credential,
        })
    }
}

/// `POST /api/auth/submit` — six digits in, a session cookie out.
async fn submit(
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
async fn session(_admitted: Admitted) -> StatusCode {
    /* The extractor is the whole endpoint: reaching this line means a live
     * credential, and failing to reach it is already a 401. */
    StatusCode::NO_CONTENT
}

/// `POST /api/auth/signout` — revoke this browser's credential.
///
/// Idempotent, and deliberately answers the same way whether or not anything
/// was revoked: a caller who can ask cannot use the answer to learn whether
/// some other credential exists.
async fn signout(
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
async fn upgrade(
    State(state): State<Arc<WebHost>>,
    admitted: Admitted,
    ws: WebSocketUpgrade,
) -> Response {
    let (outbound, receiver) = mpsc::channel(OUTBOUND_CAP);
    let Ok(socket) = state
        .pipe
        .open(admitted.session, admitted.credential, outbound)
    else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
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
    let pipe = Arc::clone(&state);
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        /* A PIPE RECORD IS OPENED BEFORE THE UPGRADE CAN FAIL, and axum's
         * default failure callback returns without running anything — so a
         * client that disconnects mid-handshake left a record nothing would
         * ever close. `MAX_SESSIONS_PER_CREDENTIAL` is four; four abandoned
         * handshakes and that credential could open no more sockets, for the
         * life of the process, with nothing logged. */
        .on_failed_upgrade(move |_error| pipe.pipe.close(socket_for_failure, "upgrade failed"))
        .on_upgrade(move |ws| pump(state, socket, ws, receiver))
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
) {
    loop {
        tokio::select! {
            /* Ends when the channel closes, which is what `Pipe::close` does by
             * dropping the sender. No second flag to keep in step. */
            frame = outbound.recv() => {
                let Some(frame) = frame else { break };
                if ws.send(Message::Binary(frame.into())).await.is_err() {
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
                    /* Nothing is dropped. Yielding lets the webview's drain run;
                     * the frame is retried by the browser because we simply
                     * stop reading, and TCP does the rest. */
                    Push::Backpressure => tokio::task::yield_now().await,
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
            /* Adversarial suite 8. `rendererIsolation.test.ts` guards the same
             * three strings for the Tauri build and cannot see this one. */
            assert!(!csp.contains("unsafe-inline"), "{csp}");
            assert!(!csp.contains("unsafe-eval"), "{csp}");
            assert!(!csp.contains("script-src 'self' blob:"), "{csp}");
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
