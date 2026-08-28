//! The commands the webview may call, and the test that keeps the four lists
//! honest.
//!
//! ADDING A COMMAND MEANS FOUR EDITS: a handler here, `generate_handler!` in
//! `lib.rs`, `COMMANDS` in `build.rs`, and `permissions/default.toml`. Miss the
//! handler or the build list and the command is unreachable; miss the ACL and
//! it is refused. That is `tauri-plugin-peer`'s comment, verbatim in substance,
//! because the trap is the same one.
//!
//! What is different here is [`tests::lists_agree`], which reads all four as
//! text and fails when they disagree. The peer plugin has the comment and no
//! check; this has both.

use serde::Serialize;
use std::sync::Arc;

use tauri::{command, AppHandle, Runtime, State};

use crate::address::Address;
use crate::state::WebHostState;
use crate::Error;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub plugin_version: String,
    /// The loopback port the server answers on, or `null` if it never bound.
    pub port: Option<u16>,
    /// Whether the webview has said it is listening for frames.
    pub ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOffer {
    /// The six digits, as a string, for the shelf to draw.
    ///
    /// SENSITIVE for its ninety seconds: anyone who reads this can pair a
    /// browser. It is returned because the shelf has to display it, and it is
    /// never logged.
    pub code: String,
    pub expires_in_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub id: u64,
}

/// A browser that holds a credential, whether or not it is connected.
///
/// DISTINCT FROM `BrowserSession`, and the distinction is the whole point. That
/// one is a live SOCKET, addressed by `webhost_session_recv` and `webhost_send`
/// and gone the moment a tab closes. This is the AUTHORIZATION — the thing a
/// reader means when they say "that phone" — and it lasts until it is revoked
/// or expires.
///
/// They were one list. A browser that signed in and closed its tab therefore
/// disappeared from the Browsers pane while its credential stayed good for
/// ninety days, and there was no way to cut it off before it reconnected.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    pub id: u64,
    /// Whether it is holding a socket right now. Shown, not enforced: a browser
    /// that is away is still a browser that can come back.
    pub connected: bool,
    /// The device, as described when it paired — "Safari on iPhone". What a
    /// reader tells their phone from their laptop by, when deciding which to
    /// revoke; a bare number could not.
    pub label: String,
    /// Epoch milliseconds. When the six digits were typed.
    pub created_ms: u64,
    /// Epoch milliseconds, to the minute. The last handshake or client boot.
    pub last_seen_ms: u64,
    /// Epoch milliseconds. When the credential stops being good on its own.
    pub expires_at_ms: u64,
}

#[command]
pub async fn webhost_status<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
) -> Result<Status, Error> {
    Ok(Status {
        plugin_version: env!("CARGO_PKG_VERSION").to_owned(),
        port: state.port(),
        ready: state.is_ready(),
    })
}

/// Where a phone should point its browser, and whether it can get there.
///
/// Asks Tailscale, so it is not instant — a subprocess, twice. Separate from
/// `webhost_status` for that reason: the pane polls status every few seconds
/// and asks this once.
///
/// ⚠️ **`spawn_blocking`, BECAUSE THE SUBPROCESSES BLOCK.** This ran them
/// directly on an async worker: a `tailscale` that hangs — a wedged daemon, a
/// control server that will not answer — occupied that worker until it
/// returned, and enough concurrent calls would exhaust the pool and stall every
/// other command in the app. `address::ask` also has a deadline now, so the
/// blocking thread is not held indefinitely either.
#[command]
pub async fn webhost_address<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
) -> Result<Address, Error> {
    let bind = state.bind();
    tauri::async_runtime::spawn_blocking(move || crate::address::resolve(bind))
        .await
        .map_err(|_| Error::Internal)
}

/// Show a new code. Replaces any code already on screen.
#[command]
pub async fn webhost_begin_code<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
) -> Result<CodeOffer, Error> {
    Ok(state.begin_code())
}

#[command]
pub async fn webhost_cancel_code<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
) -> Result<(), Error> {
    state.cancel_code();
    Ok(())
}

/// The live SOCKETS — what the webview's pump serves. Not the revocation list.
#[command]
pub async fn webhost_sessions<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
) -> Result<Vec<BrowserSession>, Error> {
    Ok(state.sessions())
}

/// Every browser holding a credential — what the Browsers pane lists.
#[command]
pub async fn webhost_browsers<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
) -> Result<Vec<Browser>, Error> {
    Ok(state.browsers())
}

/// Cut off one browser: forget its credential and close its sockets.
///
/// Takes the DURABLE id from `webhost_browsers`, not a socket id from
/// `webhost_sessions` — revoking by socket could only reach a browser that
/// happened to be connected at that moment.
#[command]
pub async fn webhost_revoke<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
    id: u64,
) -> Result<(), Error> {
    state.revoke(id)
}

/// Sign out every browser at once — the "this laptop was stolen" button.
///
/// Forgets every credential, closes every socket, retires the code on screen.
/// Answers how many browsers went. `unsaved` means they went and the disk did
/// not record it; see `WebHostState::revoke`.
#[command]
pub async fn webhost_revoke_all<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
) -> Result<usize, Error> {
    state.revoke_all()
}

/// The webview says it is serving the router.
///
/// ⚠️ THIS SAID "so frames may be delivered", which no code enforces. Nothing
/// consults the flag on admission, on push, on send or on recv — it is written
/// here and read only by `webhost_status`. It is STATUS, not a gate; see
/// `WebHostState::ready` for why it stays one and what making it a gate would
/// actually require deciding.
#[command]
pub async fn webhost_ready<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
) -> Result<(), Error> {
    state.set_ready();
    Ok(())
}

/// A frame from the webview to one browser.
///
/// ⚠️ **IT WAITS.** A browser that is not keeping up used to be answered
/// `backpressure` at once, and the webview treated that as the session being
/// dead. The plugin now waits for room — up to `WebHostState::SEND_WAIT` —
/// and answers `backpressure` only after a browser has drained nothing for
/// that long, at which point the socket is closed as well. See `state.rs`.
#[command]
pub async fn webhost_send<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
    session: u64,
    frame: Vec<u8>,
) -> Result<(), Error> {
    state.send(session, frame).await
}

/// Every frame waiting from one browser.
///
/// ⚠️ **IT WAITS UP TO A SECOND**, unlike the peer plugin's `session_recv`, and
/// the difference is deliberate. This one used to return immediately, so the
/// webview asked every 40 ms per session to be told "nothing" — 1,600 IPC round
/// trips a second at the host's own session cap, before a byte of real traffic.
///
/// Lengthening the interval was the obvious answer and the wrong one: the
/// interval bounds how long a reader waits for the first frame of a request
/// they have just made by tapping the page. Waiting here keeps that latency and
/// removes the idle cost. An empty answer still means "nothing right now".
#[command]
pub async fn webhost_session_recv<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, Arc<WebHostState>>,
    session: u64,
) -> Result<Vec<Vec<u8>>, Error> {
    Ok(state.recv(session).await)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    fn read(relative: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {relative}: {e}"))
    }

    /// Names between the quotes of a `= &["a", "b"]` list.
    ///
    /// The `=` is found FIRST and the `[` only after it. Taking the first `[`
    /// past the marker read `&[&str]` — the type annotation — and returned an
    /// empty set, which is the way a parser like this fails silently and makes
    /// the whole check pass on anything.
    fn quoted_after(text: &str, marker: &str) -> BTreeSet<String> {
        let start = text.find(marker).unwrap_or_else(|| panic!("no {marker}"));
        let equals = text[start..].find('=').expect("an assignment") + start;
        let open = text[equals..].find('[').expect("a list") + equals;
        let close = text[open..].find(']').expect("a closed list") + open;
        text[open..close]
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    /// THE CHECK THE PEER PLUGIN NEVER HAD.
    ///
    /// Four lists, kept by hand, that must agree. A command missing from
    /// `build.rs` is unreachable however correct the handler is; one missing
    /// from `default.toml` is refused at the ACL; one missing from
    /// `generate_handler!` never registers. All three fail at RUNTIME, in the
    /// app, with an error that names permissions rather than the omission.
    #[test]
    fn lists_agree() {
        let declared = quoted_after(&read("build.rs"), "const COMMANDS");

        // `generate_handler![a, b]` — bare paths, not quoted.
        let lib = read("src/lib.rs");
        let start = lib.find("generate_handler!").expect("a handler list");
        let open = lib[start..].find('[').expect("a list") + start;
        let close = lib[open..].find(']').expect("a closed list") + open;
        let registered: BTreeSet<String> = lib[open + 1..close]
            .split(',')
            .map(|entry| {
                entry
                    .trim()
                    .rsplit("::")
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_owned()
            })
            .filter(|entry| !entry.is_empty())
            .collect();

        // `allow-webhost-status` maps back to `webhost_status`.
        let acl: BTreeSet<String> =
            quoted_after(&read("permissions/default.toml"), "permissions =")
                .into_iter()
                .filter_map(|grant| grant.strip_prefix("allow-").map(|n| n.replace('-', "_")))
                .collect();

        // Handlers in THIS file, so a declared-but-unwritten command is caught.
        let source = read("src/commands.rs");
        let implemented: BTreeSet<String> = source
            .match_indices("pub async fn ")
            .map(|(at, marker)| {
                let rest = &source[at + marker.len()..];
                let end = rest.find(['<', '(']).unwrap_or(rest.len());
                rest[..end].trim().to_owned()
            })
            .filter(|name| name.starts_with("webhost_"))
            .collect();

        /* FIRST, because a parser that found nothing would otherwise report as
         * four confusing set differences instead of as itself. This assertion
         * has already earned its place once. */
        assert!(
            !declared.is_empty(),
            "the COMMANDS parser found nothing, which would make this check pass on anything"
        );
        assert_eq!(declared, registered, "build.rs vs generate_handler!");
        assert_eq!(declared, acl, "build.rs vs permissions/default.toml");
        assert_eq!(
            declared, implemented,
            "build.rs vs the handlers in this file"
        );
    }
}
