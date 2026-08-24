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

pub mod pipe;

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use paper_webauth::sessions::{Credential, Sessions};
use paper_webauth::{DeviceAuth, Outcome, Refused};
use pipe::Pipe;
use serde::Deserialize;

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
pub fn router(state: Arc<WebHost>) -> Router {
    Router::new()
        .route("/api/auth/submit", post(submit))
        .route("/api/auth/session", axum::routing::get(session))
        .route("/api/auth/signout", post(signout))
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
fn set_cookie(credential: &Credential) -> String {
    format!(
        "{SESSION_COOKIE}={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}",
        credential.as_str(),
        60 * 60 * 24 * 90
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
async fn session(
    State(state): State<Arc<WebHost>>,
    request_headers: axum::http::HeaderMap,
) -> StatusCode {
    let Some(credential) = presented(&request_headers) else {
        return StatusCode::UNAUTHORIZED;
    };
    match state.sessions.validate(&credential, Instant::now()) {
        /* The admission is taken and dropped. This endpoint answers a question
         * and registers nothing, which is exactly what `validate` is for. */
        Ok(_admission) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::UNAUTHORIZED,
    }
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
        router(state).oneshot(request).await.expect("infallible")
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
    }

    #[tokio::test]
    async fn a_wrong_code_is_unauthorized_and_sets_nothing() {
        let state = host();
        let _ = live_code(&state);
        let response = call(
            Arc::clone(&state),
            json_post("/api/auth/submit", r#"{"code":"000000"}"#, None),
        )
        .await;
        // 1-in-10^6 that the live code really is 000000; the fixture accepts it.
        if response.status() == StatusCode::NO_CONTENT {
            return;
        }
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
        for _ in 0..5 {
            let _ = call(
                Arc::clone(&state),
                json_post("/api/auth/submit", r#"{"code":"000000"}"#, None),
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
        let socket = state
            .pipe
            .open(admitted, credential.clone())
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

    #[tokio::test]
    async fn the_body_of_a_refusal_says_nothing_about_the_code() {
        let state = host();
        let _ = live_code(&state);
        let response = call(
            state,
            json_post("/api/auth/submit", r#"{"code":"000000"}"#, None),
        )
        .await;
        let body = to_bytes(response.into_body(), 4096).await.expect("a body");
        assert!(body.is_empty(), "a refusal must not describe the code");
    }
}
