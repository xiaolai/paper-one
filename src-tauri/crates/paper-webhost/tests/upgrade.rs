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
use paper_webauth::sessions::Credential;
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
     * runtime, which is what a `#[tokio::test]` gives us for free.
     *
     * ⚠️ **THE SERVE ERROR USED TO BE DISCARDED** — `let _ = axum::serve(..)`.
     * A server that failed to start, or died mid-test, then presented as
     * connection errors and timeouts in whichever case happened to run next, and
     * every one of those reads as a finding about the code under test. The
     * panic names the real cause where it happens.
     *
     * A CLEAN SHUTDOWN IS NOT ONE OF THESE. `axum::serve` returns `Ok` only when
     * it is asked to stop, and nothing here asks: the runtime is torn down under
     * it at the end of the test, which cancels this task rather than resolving
     * it. So any completion at all is unexpected, and both arms say so. */
    tokio::spawn(async move {
        match axum::serve(listener, app).await {
            Ok(()) => panic!("the test server stopped on its own; nothing asked it to"),
            Err(error) => panic!("the test server failed: {error}"),
        }
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
///
/// ⚠️ "Exactly as a browser does" was not true, and the gap was load-bearing.
/// tungstenite sends no Fetch Metadata, so every case here arrived with no
/// `Sec-Fetch-Site` — which is precisely the shape the shelf must allow (see
/// `SameOrigin`), so the whole suite would have stayed green with the
/// same-origin check absent, which for a while it was. The helper now sends
/// what a real browser sends; [`connect_from`] is how a test says otherwise.
async fn connect(shelf: &Shelf, cookie: Option<&str>) -> Result<Client, String> {
    connect_from(shelf, cookie, Some("same-origin")).await
}

/// [`connect`], with the browser's `Sec-Fetch-Site` chosen by the caller.
///
/// `None` means "send no Fetch Metadata at all" — a non-browser client, which
/// is allowed, because CSRF is a browser attack and something that is not a
/// browser has no ambient cookie to spend.
async fn connect_from(
    shelf: &Shelf,
    cookie: Option<&str>,
    site: Option<&str>,
) -> Result<Client, String> {
    let mut request = format!("ws://{}/ws", shelf.origin)
        .into_client_request()
        .expect("a ws request");
    if let Some(cookie) = cookie {
        request
            .headers_mut()
            .insert("cookie", cookie.parse().expect("an ascii cookie"));
    }
    if let Some(site) = site {
        request
            .headers_mut()
            .insert("sec-fetch-site", site.parse().expect("an ascii token"));
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
    /* AND IT KNOWS WHOSE IT IS. `close_browser` is how a sign-out reaches a
     * live socket, and it can only do that if the record carries the durable
     * id of the browser that opened it. */
    assert!(shelf.state.pipe.admitted(ids[0]).is_some());

    drop(socket);
}

/// A LIVE CREDENTIAL IS NOT ENOUGH; THE PAGE ASKING MUST BE OURS.
///
/// The cookie is `SameSite=Strict`, which was doing the whole job here and only
/// covers a cross-*site* page. This shelf's public name is `<host>.<tailnet>.ts
/// .net`; whether a sibling tailnet host is the same site is decided by the
/// Public Suffix List, which this repository neither owns nor tracks. A page on
/// such a host would send `Sec-Fetch-Site: same-site` and — before this — get a
/// socket, which is a read channel over the entire library for as long as it
/// holds it.
///
/// All four cases together, because the absent one is an ALLOW and pinning it
/// beside the refusals is what stops someone "fixing" it into a refusal that
/// breaks every non-browser caller.
#[tokio::test]
async fn only_a_same_origin_page_may_open_the_socket() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;

    for site in ["same-site", "cross-site", "none"] {
        let refused = connect_from(&shelf, Some(&cookie), Some(site)).await;
        assert!(
            refused.is_err(),
            "Sec-Fetch-Site: {site} must not open a socket, credential or no credential"
        );
    }

    /* No Fetch Metadata is ALLOWED and that is deliberate: it is not a browser
     * page context, so it cannot be spending a cookie the browser attached by
     * itself. `Admitted` is what stands in its way, and it already did. */
    let plain = connect_from(&shelf, Some(&cookie), None).await;
    assert!(
        plain.is_ok(),
        "a non-browser client with a real credential is not CSRF and must still connect"
    );
    drop(plain);

    let ours = connect_from(&shelf, Some(&cookie), Some("same-origin")).await;
    assert!(ours.is_ok(), "the shelf's own page must connect");
    drop(ours);
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

    /* ⚠️ **THE FRAMES USED TO BE DRAINED INSIDE THE PREDICATE AND THROWN AWAY.**
     *
     * `!drain(id, 8).is_empty()` asserts that SOMETHING arrived and then
     * discards it — so the one thing this file exists to check, that the bytes
     * the browser sent are the bytes the shelf holds, was never checked. A frame
     * truncated, reordered or replaced by the pipe would have passed. And the
     * drain is destructive, so there was nothing left to look at afterwards
     * even if someone wanted to. */
    let mut got: Vec<Vec<u8>> = Vec::new();
    until("the frame to arrive", || {
        got.extend(
            shelf
                .state
                .pipe
                .drain(id, 8)
                .into_iter()
                .map(|f| f.to_vec()),
        );
        !got.is_empty()
    })
    .await;
    assert_eq!(
        got,
        vec![b"a frame".to_vec()],
        "the bytes the browser sent are not the bytes the shelf holds"
    );
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
     * tests prove `close_browser` returns the ids; only a real socket can
     * show the client being disconnected. */
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let mut socket = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;

    let browser = shelf
        .state
        .pipe
        .admitted(shelf.state.pipe.live_ids()[0])
        .expect("the browser behind the socket");
    let _ = shelf.state.sessions.revoke_by_id(browser);
    shelf.state.pipe.close_browser(browser, "signed out");

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

/// A REVOKED BROWSER RECEIVES NOTHING THAT WAS ALREADY QUEUED FOR IT.
///
/// The test above proves the socket closes, and it reads to `Close` or an error
/// while ignoring every binary frame on the way — so it passed unchanged while
/// the shelf wrote up to `OUTBOUND_BYTE_CAP` of book bytes to a browser the
/// reader had just revoked. "It closed eventually" and "it stopped being sent
/// things" are different claims and only the second one is the promise.
///
/// The mechanism: `Pipe::close` revokes by dropping the outbound sender, and
/// tokio's mpsc hands the receiver everything already buffered BEFORE it
/// reports the close. The pump therefore went on writing queued frames for as
/// long as the queue lasted.
#[tokio::test]
async fn a_revoked_browser_is_sent_nothing_that_was_already_queued() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let mut socket = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;
    let id = shelf.state.pipe.live_ids()[0];

    /* Queue a pile of frames the browser has not read yet — a book being
     * streamed is exactly this shape. */
    const SECRET: &[u8] = b"book bytes the reader revoked access to";
    for _ in 0..32 {
        shelf.state.pipe.send(id, SECRET.to_vec());
    }

    let browser = shelf
        .state
        .pipe
        .admitted(id)
        .expect("the browser behind the socket");
    let _ = shelf.state.sessions.revoke_by_id(browser);
    shelf.state.pipe.close_browser(browser, "signed out");

    /* Read everything the client is given until the socket ends. Any binary
     * frame arriving here arrived AFTER the revocation. */
    let mut after_revocation = 0;
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = socket.next().await {
            match message {
                Ok(Message::Binary(bytes)) if bytes == SECRET => after_revocation += 1,
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    })
    .await;

    assert_eq!(
        after_revocation, 0,
        "a revoked browser must be sent nothing more; dropping the sender only ends the \
         channel AFTER tokio has delivered everything already buffered, so the queue has to \
         be checked rather than trusted to empty itself"
    );
}

/* THE RETRY DEADLINE IS TESTED IN `lib.rs`, NOT HERE, AND ON PURPOSE.
 *
 * `pump` re-offers a held frame on an ABSOLUTE deadline (`sleep_until`) rather
 * than a fresh `sleep(RETRY)`, because `select!` rebuilds its futures on every
 * pass: a relative sleep restarts from zero whenever the outbound arm wins, so
 * a shelf that is streaming would never retry the frame at all.
 *
 * An integration test for it was written HERE and deleted. It filled the inbox,
 * kept a producer pushing frames toward the browser, sent a sentinel and waited
 * — and it passed against the defect. A producer cannot be made to outpace the
 * pump reliably: between bursts `outbound.recv()` goes pending, the relative
 * timer gets its four milliseconds, and the sentinel arrives. Keeping it would
 * have added a case that looks like coverage and distinguishes nothing.
 *
 * `RetryAt` in `lib.rs` is what that decision became, and
 * `the_deadline_does_not_move_when_it_is_read_again` checks the property that
 * actually separates the two implementations: re-reading the deadline must not
 * postpone it. That test fails against every relative formulation. */

#[tokio::test]
async fn a_revoked_credential_cannot_open_a_second_socket() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let first = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;

    let browser = shelf
        .state
        .pipe
        .admitted(shelf.state.pipe.live_ids()[0])
        .expect("the browser");
    let _ = shelf.state.sessions.revoke_by_id(browser);

    let refused = connect(&shelf, Some(&cookie))
        .await
        .expect_err("a revoked credential must not open another");
    assert!(refused.contains("401"), "expected unauthorized: {refused}");
    drop(first);
}

/// SIGNING OUT EVERY BROWSER ENDS EVERY SOCKET, over the real wire.
///
/// The in-process test proves the pipe records close and the code is retired;
/// only real sockets can show two clients each LEARNING it, and each being
/// refused on the way back with the cookie it still holds — which is what
/// "the laptop was stolen" has to mean from the phone's side.
#[tokio::test]
async fn revoking_everything_ends_every_socket_and_refuses_every_cookie() {
    let shelf = shelf().await;
    let mut clients = Vec::new();
    let mut cookies = Vec::new();
    for _ in 0..2 {
        let code = live_code(&shelf);
        let cookie = sign_in(&shelf, &code).await;
        clients.push(connect(&shelf, Some(&cookie)).await.expect("a socket"));
        cookies.push(cookie);
    }
    until("both sessions", || shelf.state.pipe.live_count() == 2).await;

    let out = shelf.state.revoke_all();
    assert_eq!(out.applied.len(), 2, "both browsers are signed out");
    out.saved.expect("in memory, nothing to save");

    for mut socket in clients {
        let ended = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(message) = socket.next().await {
                if matches!(message, Ok(Message::Close(_)) | Err(_)) {
                    break;
                }
            }
        })
        .await;
        assert!(ended.is_ok(), "every socket should have been closed");
    }
    until("every session to be released", || {
        shelf.state.pipe.live_count() == 0
    })
    .await;

    for cookie in cookies {
        let refused = connect(&shelf, Some(&cookie))
            .await
            .expect_err("a signed-out cookie must not open a socket");
        assert!(refused.contains("401"), "expected unauthorized: {refused}");
    }
}

/// ⚠️ **A REVOCATION THAT LANDS BETWEEN ADMISSION AND `Pipe::open`.**
///
/// The case above revokes BEFORE the second handshake starts, so it exercises
/// the ordinary refusal — `Admitted` says no — and never reaches the window the
/// register-then-recheck in `upgrade` exists for.
///
/// That window is real. `Admitted` runs `validate` then `admit`, which closes
/// the gap between asking and being told; it does not close the gap between
/// being told and the socket EXISTING. A revocation arriving in there does both
/// of its halves — forgets the credential, then closes every socket it holds —
/// and finds no socket, because `Pipe::open` has not run. A moment later it
/// does, and the browser the reader just revoked is holding a live
/// authenticated channel while the Browsers pane says it is gone.
///
/// `pause_before_open` holds the handshake exactly there, so the revocation
/// lands inside the window rather than near it.
#[tokio::test]
async fn a_revocation_inside_the_admission_window_leaves_no_socket() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;

    /* THE CREDENTIAL THIS COOKIE CARRIES, read before the handshake so the
    revocation below can name it without a pipe record to look it up in —
    which is the whole point: there is no record yet. */
    let credential = Credential::from_presented(cookie.split_once('=').expect("a cookie pair").1);

    let (reached, release) = shelf.state.pause_before_open();
    let handshake = {
        let origin = shelf.origin.clone();
        let cookie = cookie.clone();
        tokio::spawn(async move {
            let mut request = format!("ws://{origin}/ws")
                .into_client_request()
                .expect("a ws request");
            request
                .headers_mut()
                .insert("cookie", cookie.parse().expect("an ascii cookie"));
            request
                .headers_mut()
                .insert("sec-fetch-site", "same-origin".parse().expect("a token"));
            tokio_tungstenite::connect_async(request)
                .await
                .map(|(socket, _)| socket)
                .map_err(|error| error.to_string())
        })
    };

    /* ADMITTED, AND NOT YET REGISTERED. */
    reached.await.expect("the handshake should reach the seam");
    assert_eq!(
        shelf.state.pipe.live_count(),
        0,
        "the seam should be before the pipe record exists"
    );

    /* THE REVOCATION, in the window. `close_browser` finds nothing to close —
    that is the whole point — so only the re-check after registration can
    stop this socket. */
    let revoked = shelf.state.sessions.revoke(&credential);
    if let Some(browser) = revoked.applied {
        shelf.state.pipe.close_browser(browser, "revoked");
    }

    release
        .send(())
        .expect("the handshake should still be waiting");
    let outcome = handshake.await.expect("the handshake task");
    assert!(
        outcome.is_err(),
        "a credential revoked mid-handshake opened a socket anyway"
    );

    /* AND NOTHING WAS LEFT BEHIND. A record opened and then refused must be
    closed AND reaped, or that credential's share is spent for the life of
    the process. */
    until("the record to be released", || {
        shelf.state.pipe.live_count() == 0
    })
    .await;
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
            Push::Backpressure(_)
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

/// A FRAME THAT ARRIVES AT A FULL INBOX MUST STILL ARRIVE.
///
/// The test above fills the inbox with `Pipe::push` from the test's own thread,
/// which is the shelf's side of the wire. That proves the *pipe* pushes back,
/// and it is blind to the thing that was actually broken: `pump` matched
/// `Push::Backpressure`, yielded, and let the frame — already read off the
/// socket, already ACKed — go out of scope. A comment above that line explained
/// that the browser would retransmit it. Nothing retransmits an application
/// message the receiver has consumed.
///
/// So the sentinel here goes through the REAL socket, into a REAL full inbox,
/// and the assertion is that it eventually lands once the webview drains — not
/// that a variant was returned. That is the difference between testing the
/// component and testing the loop that uses it, and only the second one fails
/// against the old `pump`.
#[tokio::test]
async fn a_frame_that_meets_a_full_inbox_is_delivered_after_the_drain() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;
    let mut socket = connect(&shelf, Some(&cookie)).await.expect("a socket");
    until("the session", || shelf.state.pipe.live_count() == 1).await;
    let id = shelf.state.pipe.live_ids()[0];

    /* Fill the inbox to its byte budget from this side, so the next frame off
     * the socket meets a closed door. */
    let filler = vec![0_u8; 1024 * 1024];
    while matches!(shelf.state.pipe.push(id, filler.clone()), Push::Accepted) {}

    const SENTINEL: &[u8] = b"the frame that must not vanish";
    socket
        .send(Message::Binary(SENTINEL.to_vec().into()))
        .await
        .expect("the client can always write; the shelf simply stops reading");

    /* Give the pump every chance to lose it before the drain — this is the
     * window the old code dropped the frame in. */
    tokio::time::sleep(Duration::from_millis(50)).await;

    /* Now be the webview: drain, which frees the budget the pump is waiting on. */
    let mut seen = 0;
    for _ in 0..200 {
        for frame in shelf.state.pipe.drain(id, 64) {
            if frame == SENTINEL {
                seen += 1;
            }
        }
        if seen > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    assert_eq!(
        seen, 1,
        "the frame the inbox refused must be retried and delivered exactly once, \
         not dropped while the pump waits for a retransmission that never comes"
    );
    drop(socket);
}

/// A raw upgrade request over a bare stream, abandoned after the shelf has
/// admitted it and BEFORE it can answer — a browser giving up in the sliver
/// between the handler opening a pipe record and hyper flushing the `101`.
///
/// # Why a bare stream, and why a reset rather than a close
///
/// tungstenite drives the whole handshake or none of it; there is no hook
/// between "request sent" and "response read". And the abandonment has to be a
/// RESET: after a plain close the shelf's first write still succeeds — the
/// kernel buffers it and the peer answers with a reset afterwards — so the
/// upgrade completes and `pump` finds the dead socket, which is the ordinary
/// exit. Only a write that FAILS makes hyper drop the connection with the
/// upgrade still pending, and that is the one path that reaches
/// `on_failed_upgrade`. `SO_LINGER` of zero turns the close into a reset.
///
/// # Why the request carries a line it does not need
///
/// While a handler is in flight hyper probes the socket for EOF and, on one,
/// DROPS the handler (`mid_message_detect_eof`: "found unexpected EOF on busy
/// connection"). A reset landing while the handler waits at the seam would
/// therefore never open a record at all — the wrong window. The probe skips the
/// socket while hyper's own read buffer holds unparsed bytes, so the request is
/// followed by the first line of a second one that never finishes: pipelined
/// and stalled, which HTTP permits. Those bytes park in the buffer, hyper stops
/// looking, and the reset is first met by the write of the `101`.
async fn abandon_a_handshake(shelf: &Shelf, cookie: &str) {
    let (reached, release) = shelf.state.pause_before_open();
    let stream = TcpStream::connect(&shelf.origin)
        .await
        .expect("a connection");
    let request = format!(
        "GET /ws HTTP/1.1\r\n\
         Host: {origin}\r\n\
         Connection: Upgrade\r\n\
         Upgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-Fetch-Site: same-origin\r\n\
         Cookie: {cookie}\r\n\
         \r\n\
         GET /ws HTTP/1.1\r\n",
        origin = shelf.origin
    );
    /* `try_write` in a loop rather than `write_all`: the dev build takes tokio
     * with `net` and not `io-util`, and a helper that leans on a feature a
     * sibling dependency happens to switch on is a helper that breaks when
     * that sibling changes. */
    let mut bytes = request.as_bytes();
    while !bytes.is_empty() {
        stream.writable().await.expect("writable");
        match stream.try_write(bytes) {
            Ok(written) => bytes = &bytes[written..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) => panic!("writing the request: {error}"),
        }
    }

    /* ADMITTED, AND PARKED BEFORE `Pipe::open`. */
    reached.await.expect("the handshake should reach the seam");

    /* THE RESET. Then a moment for it to cross the loopback: the shelf's write
     * is what must meet it, and a write that wins the race succeeds, completes
     * the upgrade and ends through `pump` instead — reaped either way, which is
     * why the count below is asserted rather than assumed. */
    /* tokio deprecates `set_linger` because a linger WAIT blocks the runtime
     * thread on drop. A linger of zero is not a wait — it is the abort, the
     * one portable way to make a close send a reset — and the only other
     * routes to the option are an unstable std API or a crate this crate does
     * not take. */
    #[allow(deprecated)]
    let reset = stream.set_linger(Some(Duration::ZERO));
    reset.expect("SO_LINGER");
    drop(stream);
    tokio::time::sleep(Duration::from_millis(25)).await;

    release
        .send(())
        .expect("the handshake should still be waiting");
}

/// A browser that gives up mid-handshake must not keep its seat at the table.
///
/// ⚠️ `on_failed_upgrade` CLOSED the record and did not REAP it, and the two
/// are not the same thing: `Pipe::open` counts every record toward
/// `MAX_SESSIONS`, closed or not — only `reap` removes one — and every other
/// exit path reaps. Sixty-four abandoned handshakes, over any span of time,
/// and the shelf answered 429 to every browser for the life of the process,
/// with nothing logged and nothing in the Browsers pane to explain it.
///
/// One past the cap, so that under the defect the last abandonment is itself
/// refused at `open` and the browser after it is what the defect turns away.
#[tokio::test]
async fn a_handshake_the_browser_abandons_does_not_keep_its_seat() {
    let shelf = shelf().await;
    let code = live_code(&shelf);
    let cookie = sign_in(&shelf, &code).await;

    const ABANDONED: usize = paper_webhost::pipe::MAX_SESSIONS + 1;
    for _ in 0..ABANDONED {
        abandon_a_handshake(&shelf, &cookie).await;
    }
    until("the abandoned handshakes to be noticed", || {
        shelf.state.failed_upgrades() >= paper_webhost::pipe::MAX_SESSIONS
    })
    .await;

    let socket = connect(&shelf, Some(&cookie))
        .await
        .expect("sixty-five abandoned handshakes must not turn the next browser away");
    until("the session to be registered", || {
        shelf.state.pipe.live_count() == 1
    })
    .await;
    drop(socket);

    /* THE CONTROL. A reset that lost its race with the `101` ended through
     * `pump`, which reaps whether or not the callback does — so a shortfall
     * here means the case above proved less than it claims, and says so
     * rather than passing quietly. */
    let mut noticed = 0;
    for _ in 0..200 {
        noticed = shelf.state.failed_upgrades();
        if noticed == ABANDONED {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        noticed, ABANDONED,
        "{noticed} of {ABANDONED} abandoned handshakes reached `on_failed_upgrade`; \
         the rest were reaped by `pump`, and this test did not exercise the callback for them"
    );
}
