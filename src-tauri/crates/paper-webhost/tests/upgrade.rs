//! The handshake, over a real socket.
//!
//! # Why this file exists rather than another `oneshot` case
//!
//! Every test in `lib.rs` drives the router in process with
//! `ServiceExt::oneshot`. That is the right tool for a handler — it exercises
//! the real extractors and the real headers with no port and no reactor — and
//! it **cannot perform a WebSocket handshake at all**. `oneshot` returns the
//! `101` response and drops the connection; `on_upgrade`'s future never runs,
//! so nothing that happens *after* the upgrade has ever been tested.
//!
//! That is most of this surface. The socket is where the session is registered,
//! where frames cross in both directions, where revocation lands, and where a
//! credential's socket budget is spent. An audit of `lib.rs` named the gap
//! plainly: "the suite deliberately never performs a real WebSocket upgrade,
//! leaving successful setup, upgrade-failure cleanup, revocation races, expiry,
//! origin enforcement, size limits, and `pump` backpressure untested".
//!
//! It is not a hypothetical gap. The browser client's read path worked once by
//! hand and then stopped, and **not one check in this repository went red** —
//! because the only thing that could have seen it was a real handshake.
//!
//! # What this file can and cannot see
//!
//! `paper-webhost` does not answer services. It moves frames between a socket
//! and a session inbox; the *webview* drains that inbox and runs the router.
//! So the assertions here are about the shelf's half of the wire — a frame the
//! client sends arriving in `drain`, a frame `send` reaches the client, and the
//! session being VISIBLE in `live_ids` while the socket is open.
//!
//! That last one is the one worth having. It is exactly what the webview polls
//! through `webhost_sessions` to decide which sessions to serve, and a session
//! that never appears there is a browser that connects and is answered by
//! nobody — which is the failure that went unseen.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::Request;
use futures_util::{SinkExt, StreamExt};
use paper_webhost::assets::NO_CLIENT;
use paper_webhost::pipe::Push;
use paper_webhost::{router, WebHost, SESSION_COOKIE};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;

/// A shelf on a real loopback port, and the address to reach it on.
///
/// Port 0: the OS picks. A fixed port makes a suite that fails when it is run
/// twice at once, and CI runs suites twice at once.
struct Shelf {
    state: Arc<WebHost>,
    origin: String,
}

async fn shelf() -> Shelf {
    let state = Arc::new(WebHost::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback port");
    let origin = format!(
        "127.0.0.1:{}",
        listener.local_addr().expect("an address").port()
    );
    let app = router(Arc::clone(&state), NO_CLIENT);
    /* DETACHED. The server outlives each request and dies with the test's
     * runtime, which is what a `#[tokio::test]` gives us for free. */
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Shelf { state, origin }
}

/// Six digits from the shelf, as the Browsers pane would show them.
fn live_code(shelf: &Shelf) -> String {
    let offer = shelf.state.auth.begin(Instant::now());
    String::from_utf8(offer.code.digits().to_vec()).expect("ascii digits")
}

/// Trade a code for the session cookie.
///
/// The POST goes through the router IN PROCESS and the socket below goes over a
/// real port — deliberately, and not for convenience. The endpoint's own
/// behaviour is covered by `lib.rs`'s cases; what is worth proving HERE is that
/// the cookie the endpoint SETS is the cookie the handshake ACCEPTS. Both halves
/// touch the same `WebHost`, so the credential is the same object either way,
/// and the pair travels between them exactly as a browser would send it back.
async fn sign_in(shelf: &Shelf, code: &str) -> String {
    let request = Request::builder()
        .method("POST")
        .uri("/api/auth/submit")
        .header("content-type", "application/json")
        .body(Body::from(format!(r#"{{"code":"{code}"}}"#)))
        .expect("a request");

    let response = router(Arc::clone(&shelf.state), NO_CLIENT)
        .oneshot(request)
        .await
        .expect("infallible");
    assert_eq!(response.status(), 204, "the code should have been accepted");

    let cookie = response
        .headers()
        .get("set-cookie")
        .expect("a session cookie")
        .to_str()
        .expect("ascii")
        .to_owned();
    /* Just the name=value pair, as a browser sends it back — the attributes are
     * instructions to the browser, not part of what it presents. */
    let pair = cookie
        .split(';')
        .next()
        .expect("a cookie pair")
        .trim()
        .to_owned();
    assert!(
        pair.starts_with(SESSION_COOKIE),
        "unexpected cookie: {pair}"
    );
    pair
}

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Open `/ws` carrying `cookie`, exactly as a browser does.
async fn connect(shelf: &Shelf, cookie: Option<&str>) -> Result<Client, String> {
    let mut request = format!("ws://{}/ws", shelf.origin)
        .into_client_request()
        .expect("a ws request");
    if let Some(cookie) = cookie {
        request
            .headers_mut()
            .insert("cookie", cookie.parse().expect("an ascii cookie"));
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _response)) => Ok(socket),
        Err(error) => Err(error.to_string()),
    }
}

/// Poll `condition` until it holds, or give up.
///
/// The handshake completes on the client before the server's `on_upgrade`
/// future has necessarily run, so "the session is registered" is a thing that
/// becomes true rather than one that is true. A bare assertion after `connect`
/// would be a race that passes on a fast machine.
async fn until(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..200 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn a_signed_in_browser_appears_in_live_ids_while_its_socket_is_open() {
    /* THE ASSERTION THIS FILE WAS WRITTEN FOR.
     *
     * `live_ids` is what the webview polls through `webhost_sessions` to decide
     * which sessions to serve. A socket the client sees as open, that never
     * appears here, is a browser that connects and is answered by nobody — no
     * error, no refusal, just silence. That is the failure the phase-18 plan
     * records as unexplained, and no in-process test could have seen it. */
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;

    assert!(
        shelf.state.pipe.live_ids().is_empty(),
        "nothing is open yet"
    );
    let socket = connect(&shelf, Some(&cookie))
        .await
        .expect("the socket should open");

    until("the session to be registered", || {
        shelf.state.pipe.live_count() == 1
    })
    .await;

    let ids = shelf.state.pipe.live_ids();
    assert_eq!(ids.len(), 1);
    /* AND IT KNOWS WHOSE IT IS. `close_credential` is how a sign-out reaches a
     * live socket, and it can only do that if the record carries the
     * credential. */
    assert!(shelf.state.pipe.credential_of(ids[0]).is_some());

    drop(socket);
}

#[tokio::test]
async fn a_socket_without_a_credential_is_refused_before_it_opens() {
    let shelf = shelf().await;
    let refused = connect(&shelf, None)
        .await
        .expect_err("no cookie, no socket");
    assert!(
        refused.contains("401"),
        "expected an unauthorized handshake: {refused}"
    );
    assert_eq!(
        shelf.state.pipe.live_count(),
        0,
        "and nothing was registered"
    );
}

#[tokio::test]
async fn a_frame_the_browser_sends_lands_in_the_inbox() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let mut socket = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;
    let id = shelf.state.pipe.live_ids()[0];

    socket
        .send(Message::Binary(b"a frame".to_vec().into()))
        .await
        .expect("send");

    until("the frame to arrive", || {
        !shelf.state.pipe.drain(id, 8).is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_frame_the_shelf_sends_reaches_the_browser() {
    /* THE OTHER DIRECTION, which is the one an answer travels. */
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let mut socket = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;
    let id = shelf.state.pipe.live_ids()[0];

    shelf.state.pipe.send(id, b"an answer".to_vec());

    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("the answer should arrive")
        .expect("a message")
        .expect("not an error");
    assert_eq!(message, Message::Binary(b"an answer".to_vec().into()));
}

#[tokio::test]
async fn revoking_a_credential_closes_the_socket_the_browser_is_holding() {
    /* Adversarial suite 6, at the layer it actually happens. The in-process
     * tests prove `close_credential` returns the ids; only a real socket can
     * show the client being disconnected. */
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let mut socket = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;

    let credential = shelf
        .state
        .pipe
        .credential_of(shelf.state.pipe.live_ids()[0])
        .expect("the credential behind the socket");
    shelf.state.sessions.revoke(&credential);
    shelf.state.pipe.close_credential(&credential, "signed out");

    /* THE CLIENT SEES IT END. Draining to `None` — or to a close or an error —
    is the socket going away; only the timeout can fail this, which is the
    point: a revocation the client never learns about leaves it waiting on a
    shelf that has forgotten it. */
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = socket.next().await {
            if matches!(message, Ok(Message::Close(_)) | Err(_)) {
                break;
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the socket should have been closed");
    /* AND THE SHELF LET IT GO. A client that disconnects while the record stays
    open spends that credential's share for the life of the process. */
    until("the session to be released", || {
        shelf.state.pipe.live_count() == 0
    })
    .await;
}

#[tokio::test]
async fn a_revoked_credential_cannot_open_a_second_socket() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let first = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;

    let credential = shelf
        .state
        .pipe
        .credential_of(shelf.state.pipe.live_ids()[0])
        .expect("the credential");
    shelf.state.sessions.revoke(&credential);

    let refused = connect(&shelf, Some(&cookie))
        .await
        .expect_err("a revoked credential must not open another");
    assert!(refused.contains("401"), "expected unauthorized: {refused}");
    drop(first);
}

#[tokio::test]
async fn an_oversized_message_ends_the_socket() {
    /* An oversized message ENDS the socket rather than being dropped and
     * ignored — a client that can keep sending them is a client that can keep
     * costing the shelf whatever assembling one costs.
     *
     * ⚠️ THIS DOES NOT PROVE THE SIZE CAP, and the name used to claim it did.
     * `Pipe::push` also refuses over `MAX_FRAME` and closes, so the socket ends
     * either way — measured, by removing `max_message_size` and watching this
     * pass unchanged. What differs is only whether axum assembled up to its
     * 64 MiB default first, and from the client that shows as one flavour of
     * connection reset versus another, which is an OS detail and not a contract
     * worth asserting on.
     *
     * The cap itself is held by `the_upgrade_is_bounded_by_the_protocols_own_cap`
     * in `lib.rs`, which reads the source. Two halves: this one is the
     * behaviour, that one is the bound. */
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let mut socket = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;

    let huge = vec![0_u8; paper_webhost::pipe::MAX_FRAME + 1];
    let _ = socket.send(Message::Binary(huge.into())).await;

    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        while socket.next().await.is_some() {}
    })
    .await;
    assert!(ended.is_ok(), "an oversized message must end the socket");
    until("the session to be gone", || {
        shelf.state.pipe.live_count() == 0
    })
    .await;
}

#[tokio::test]
async fn a_credential_cannot_hold_more_sockets_than_its_share() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;

    let mut held = Vec::new();
    for _ in 0..paper_webhost::pipe::MAX_SESSIONS_PER_CREDENTIAL {
        held.push(
            connect(&shelf, Some(&cookie))
                .await
                .expect("within the share"),
        );
    }
    until("every socket", || {
        shelf.state.pipe.live_count() == paper_webhost::pipe::MAX_SESSIONS_PER_CREDENTIAL
    })
    .await;

    let refused = connect(&shelf, Some(&cookie))
        .await
        .expect_err("one past the share must be refused");
    assert!(
        refused.contains("429"),
        "expected too-many-requests: {refused}"
    );

    /* AND THE SHARE IS RELEASED. A refusal that permanently consumed a slot
     * would make the cap a one-way ratchet. */
    drop(held.pop());
    until("the freed slot", || {
        shelf.state.pipe.live_count() == paper_webhost::pipe::MAX_SESSIONS_PER_CREDENTIAL - 1
    })
    .await;
    let again = connect(&shelf, Some(&cookie)).await;
    assert!(again.is_ok(), "a freed slot should be reusable");
}

/// A frame refused for size is a protocol violation; one refused for capacity
/// is not, and the two must not be confused.
#[tokio::test]
async fn backpressure_is_not_a_protocol_violation() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let socket = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;
    let id = shelf.state.pipe.live_ids()[0];

    /* Fill the inbox from this side, which is what a browser flooding it would
     * do, and check the shelf answers `Backpressure` rather than `TooLarge`. */
    let mut saw_backpressure = false;
    for _ in 0..(paper_webhost::pipe::INBOX_CAP + 8) {
        if matches!(
            shelf.state.pipe.push(id, vec![0_u8; 16]),
            Push::Backpressure
        ) {
            saw_backpressure = true;
            break;
        }
    }
    assert!(saw_backpressure, "the inbox should have pushed back");
    assert_eq!(
        shelf.state.pipe.live_count(),
        1,
        "backpressure must not close the session — it is a busy shelf, not a bad client"
    );
    drop(socket);
}
