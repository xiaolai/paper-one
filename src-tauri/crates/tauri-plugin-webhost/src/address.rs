//! Where a phone should point its browser — and whether it can reach this
//! shelf at all (phase 18).
//!
//! ## Why a port number is not an answer
//!
//! The pane used to say "Serving on port 27182", which is true and useless: a
//! reader has to guess a hostname, and every guess they can make is wrong in a
//! way that fails silently.
//!
//! **The session cookie is `Secure`.** A browser reaching this shelf over plain
//! `http://` will accept the six digits, refuse to store the credential, and
//! land back on the code screen with nothing to say for itself. So a plain-HTTP
//! address is not a worse answer, it is a broken one, and offering it would be
//! the pane handing someone a URL that cannot work.
//!
//! ⚠️ **`http://localhost` IS NOT THE EXCEPTION IT LOOKS LIKE, and this file
//! said it was.** Browsers do treat it as a *secure context*, so the reasoning
//! seemed to follow. Measured 2026-08-25 against WebKit, it does not:
//!
//! ```text
//!   server, cookie supplied by curl  → 204
//!   page fetch over http://127.0.0.1 → 401
//!   ctx.cookies()                    → ['paper_session']
//! ```
//!
//! The cookie is STORED and then never SENT. `Secure` keys on the scheme being
//! `https`, and WebKit makes no localhost exception for transmission even
//! though it makes one for storage. Every browser on iOS is WebKit.
//!
//! So there is no working plain-HTTP path at all, on any machine, and this file
//! offers none. An earlier version had a `LocalOnly` state printing
//! `http://localhost:27182/`; it was removed rather than reworded. A URL that
//! cannot hold a sign-in is not a lesser answer to "where do I point my
//! browser" — it is a wrong one, and a reader who types six digits into it
//! watches them appear to work and then lands back on the code screen.
//!
//! What is left is two working-toward states and one working one. None of them
//! prints an address that cannot be used.
//!
//! ## What is asked, and of whom
//!
//! Tailscale, because it is the cheapest way for a home machine to get a
//! browser-trusted certificate: `tailscale serve` terminates TLS on a
//! `*.ts.net` name with a real Let's Encrypt certificate and proxies to a
//! loopback port. Two questions, in order:
//!
//!   1. `tailscale status` — is there a tailnet, and what is this machine
//!      called on it?
//!   2. `tailscale serve status` — is anything actually proxying to OUR port?
//!
//! **Both, and the second is the one that matters.** A tailnet name with no
//! serve config behind it is a URL that resolves and refuses the connection.
//! Printing it because Tailscale happened to be installed would be a guess
//! dressed as an answer.

use std::process::Command;

use serde::Serialize;

/// Where a browser should go, and whether it can get there.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Address {
    /// Reachable from anywhere on the tailnet, over TLS. The working case.
    Https { url: String },
    /// A tailnet exists and nothing is proxying to this port, so the client is
    /// unreachable from a phone. Carries the command that fixes it.
    NotServed { host: String, command: String },
    /// No tailnet, so no name a browser will trust and no route to make one.
    ///
    /// Deliberately carries NO url. The server is listening and the page would
    /// load; the sign-in would not stick. See the header.
    NoHttps { port: u16 },
    /// The server never bound; there is nothing to reach.
    Unavailable,
}

/// Run a command and return its stdout, or `None` for anything that went wrong.
///
/// A missing binary, a non-zero exit and unreadable output are ONE case on
/// purpose: each of them means "cannot answer", and telling them apart would
/// only tempt a caller into reporting a diagnosis it cannot support.
fn ask(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// The `tailscale` binary, wherever it is.
///
/// Homebrew's is on `PATH`; the Mac App Store build hides its CLI inside the
/// bundle and is not on `PATH` at all, which is the common case on a Mac and
/// would otherwise report "no tailnet" to someone plainly running one.
const CANDIDATES: &[&str] = &[
    "tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

fn tailscale(args: &[&str]) -> Option<String> {
    CANDIDATES.iter().find_map(|program| ask(program, args))
}

/// This machine's MagicDNS name, without the trailing dot.
///
/// Parsed out of `tailscale status --json` by hand rather than with a JSON
/// dependency: one string is wanted from a large document, and the shape
/// (`"Self": { … "DNSName": "host.tailnet.ts.net." }`) is stable.
pub fn parse_dns_name(status_json: &str) -> Option<String> {
    let self_at = status_json.find("\"Self\"")?;
    let key = status_json[self_at..].find("\"DNSName\"")? + self_at;
    let rest = &status_json[key + "\"DNSName\"".len()..];
    let open = rest.find('"')? + 1;
    let close = rest[open..].find('"')? + open;
    let name = rest[open..close].trim_end_matches('.');
    if name.is_empty() {
        return None;
    }
    Some(name.to_owned())
}

/// Whether a serve config mentions our loopback port.
///
/// A substring check rather than a parse. `tailscale serve status` prints the
/// proxy target verbatim (`http://127.0.0.1:27182`), and the question here is
/// only "is our port behind this name" — a wrong answer in the strict direction
/// costs a hint that says to run a command already run, which is recoverable.
pub fn serves_port(serve_status: &str, port: u16) -> bool {
    serve_status.contains(&format!("127.0.0.1:{port}"))
        || serve_status.contains(&format!("localhost:{port}"))
}

/// Resolve the address, asking Tailscale if it is there.
pub fn resolve(port: Option<u16>) -> Address {
    let Some(port) = port else {
        return Address::Unavailable;
    };
    let no_https = Address::NoHttps { port };

    let Some(status) = tailscale(&["status", "--json"]) else {
        return no_https;
    };
    let Some(host) = parse_dns_name(&status) else {
        return no_https;
    };

    let serve = tailscale(&["serve", "status"]).unwrap_or_default();
    if serves_port(&serve, port) {
        return Address::Https {
            url: format!("https://{host}/"),
        };
    }
    Address::NotServed {
        host: host.clone(),
        /* THE EXACT COMMAND, not a description of one. A reader who has to
         * translate "put a reverse proxy in front of it" into this line is a
         * reader who will not. */
        command: format!("tailscale serve --bg http://127.0.0.1:{port}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = r#"{"Version":"1.2","Self":{"ID":"n1","HostName":"studio","DNSName":"studio.tail1234.ts.net.","OS":"macOS"},"Peer":{}}"#;

    #[test]
    fn a_dns_name_loses_its_trailing_dot() {
        /* MagicDNS reports a fully-qualified name with the root dot on it. Left
         * in, the URL still resolves and looks wrong in every place it is
         * printed or copied. */
        assert_eq!(
            parse_dns_name(STATUS).as_deref(),
            Some("studio.tail1234.ts.net")
        );
    }

    #[test]
    fn a_status_without_a_self_is_no_answer() {
        assert_eq!(parse_dns_name("{}"), None);
        assert_eq!(parse_dns_name(""), None);
        assert_eq!(parse_dns_name(r#"{"Self":{"HostName":"x"}}"#), None);
    }

    #[test]
    fn an_empty_dns_name_is_no_answer_rather_than_an_empty_host() {
        /* `https:///` is what an empty name produces, and it is a link that
         * cannot be diagnosed from looking at it. */
        assert_eq!(parse_dns_name(r#"{"Self":{"DNSName":""}}"#), None);
        assert_eq!(parse_dns_name(r#"{"Self":{"DNSName":"."}}"#), None);
    }

    #[test]
    fn a_peers_dns_name_is_not_mistaken_for_this_machines() {
        /* `Self` is searched for FIRST and the key looked up after it. Scanning
         * for `DNSName` alone would find whichever appeared first in the
         * document, which on a busy tailnet is somebody else's laptop. */
        let with_peer_first = r#"{"Peer":{"n9":{"DNSName":"laptop.tail1234.ts.net."}},"Self":{"DNSName":"studio.tail1234.ts.net."}}"#;
        assert_eq!(
            parse_dns_name(with_peer_first).as_deref(),
            Some("studio.tail1234.ts.net")
        );
    }

    #[test]
    fn a_serve_config_is_recognised_only_for_our_own_port() {
        /* Another service behind the same tailnet name must not be read as this
         * one — it would print a working-looking URL that serves somebody
         * else's app. */
        let serve =
            "https://studio.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:27182\n";
        assert!(serves_port(serve, 27182));
        assert!(!serves_port(serve, 8080));
        assert!(!serves_port("No serve config", 27182));
    }

    #[test]
    fn no_port_means_there_is_nothing_to_reach() {
        assert_eq!(resolve(None), Address::Unavailable);
    }
}
