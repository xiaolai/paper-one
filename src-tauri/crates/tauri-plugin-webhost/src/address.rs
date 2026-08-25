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
    /// unreachable from a phone.
    ///
    /// `command` is the exact line that fixes it — WHEN there is one. It is
    /// `None` on a tailnet that cannot issue certificates at all, where the
    /// command would fail with an error that reads like an account problem.
    NotServed {
        host: String,
        command: Option<String>,
    },
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

/// Whether this tailnet can issue a browser-trusted certificate.
///
/// ⚠️ `tailscale serve` IS NOT AVAILABLE ON EVERY TAILNET, and the pane used to
/// assume it was. Serve terminates TLS with a certificate Tailscale issues for
/// the `.ts.net` name, so it needs Tailscale's own certificate infrastructure.
/// Against a self-hosted control server — Headscale — there is none: `tailscale
/// cert` answers *"your Tailscale account does not support getting TLS certs"*,
/// and HTTPS support for `serve` is an open feature request against Headscale
/// rather than a setting.
///
/// So the shelf asked a reader to run a command that could not work, and the
/// failure it produced read like something wrong with their account. Measured
/// on a Headscale tailnet, 2026-08-26.
///
/// `CertDomains` is the tailnet's answer: a list of domains it will issue for,
/// `null` or absent when it will issue for none. Parsed by hand for the same
/// reason `parse_dns_name` is — one fact out of a large document, and adding a
/// JSON dependency to a plugin to read one field is a poor trade.
pub fn can_issue_certificates(status_json: &str) -> bool {
    let Some(key) = status_json.find("\"CertDomains\"") else {
        return false;
    };
    let rest = &status_json[key + "\"CertDomains\"".len()..];
    let Some(colon) = rest.find(':') else {
        return false;
    };
    let value = rest[colon + 1..].trim_start();
    /* AN EMPTY LIST IS A NO, and so is `null`. Both mean the tailnet will issue
     * for nothing, and only the presence of an entry means it will. */
    let Some(without_bracket) = value.strip_prefix('[') else {
        return false;
    };
    !without_bracket.trim_start().starts_with(']')
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
///
/// The SHELLING OUT is all that is here; `decide` below is the judgement, so it
/// can be tested without a tailnet. That split is not decoration: the decision
/// this makes was wrong for every self-hosted control server and no test could
/// see it, because the only way in was two subprocesses.
pub fn resolve(port: Option<u16>) -> Address {
    let Some(port) = port else {
        return Address::Unavailable;
    };
    let Some(status) = tailscale(&["status", "--json"]) else {
        return Address::NoHttps { port };
    };
    let serve = tailscale(&["serve", "status"]).unwrap_or_default();
    decide(port, &status, &serve)
}

/// What the two Tailscale answers mean, with no subprocess in sight.
pub fn decide(port: u16, status: &str, serve: &str) -> Address {
    let no_https = Address::NoHttps { port };

    let Some(host) = parse_dns_name(status) else {
        return no_https;
    };

    if serves_port(serve, port) {
        return Address::Https {
            url: format!("https://{host}/"),
        };
    }
    Address::NotServed {
        host: host.clone(),
        /* THE EXACT COMMAND, not a description of one — a reader who has to
         * translate "put a reverse proxy in front of it" into this line is a
         * reader who will not.
         *
         * But ONLY when it can work. See `can_issue_certificates`: on a
         * self-hosted control server the command fails with an error about the
         * reader's account, which is both wrong and unactionable. */
        command: can_issue_certificates(status)
            .then(|| format!("tailscale serve --bg http://127.0.0.1:{port}")),
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

    /// THE COMMAND IS ONLY OFFERED WHEN IT CAN WORK.
    ///
    /// `tailscale serve` terminates TLS with a certificate Tailscale issues for
    /// the `.ts.net` name, so it needs Tailscale's own certificate
    /// infrastructure. A self-hosted control server has none: `tailscale cert`
    /// answers "your Tailscale account does not support getting TLS certs".
    ///
    /// The pane printed the command to every tailnet regardless, so a reader on
    /// Headscale was told to run a line that fails with an error about their
    /// account — wrong, and unactionable. Measured against a real Headscale
    /// tailnet, 2026-08-26.
    #[test]
    fn a_tailnet_that_cannot_issue_certificates_is_not_told_to_run_serve() {
        /* What Tailscale's own control server answers with HTTPS enabled. */
        assert!(can_issue_certificates(
            r#"{"Self":{},"CertDomains":["tail1234.ts.net"]}"#
        ));

        /* And the three ways a tailnet says no. `null` is what Headscale
         * answers; the other two are an empty list and the field being absent
         * altogether, which older clients do. */
        for status in [
            r#"{"Self":{},"CertDomains":null}"#,
            r#"{"Self":{},"CertDomains":[]}"#,
            r#"{"Self":{},"CertDomains": [ ]}"#,
            r#"{"Self":{"DNSName":"studio.example."}}"#,
        ] {
            assert!(
                !can_issue_certificates(status),
                "should not promise a certificate for {status}"
            );
        }
    }

    /// A NO IS NOT A MAYBE. Anything this cannot read is a tailnet that has not
    /// said it can issue, and offering the command on a guess is what produced
    /// the original defect.
    #[test]
    fn an_unreadable_answer_is_treated_as_no_certificates() {
        for status in [
            "",
            "{}",
            "not json at all",
            r#"{"CertDomains"}"#,
            r#"{"CertDomains":"#,
        ] {
            assert!(!can_issue_certificates(status), "{status:?}");
        }
    }

    /// THE DECISION ITSELF, over the two answers Tailscale gives.
    ///
    /// `can_issue_certificates` had tests and `resolve` did not, so removing
    /// the call and offering the command unconditionally left every test green
    /// — which is exactly the state the pane shipped in. A predicate nothing
    /// consults is a predicate that is not doing anything.
    #[test]
    fn the_decision_offers_a_command_only_to_a_tailnet_that_can_use_it() {
        let named = r#"{"Self":{"DNSName":"studio.example."},"CertDomains":["example"]}"#;
        let no_certs = r#"{"Self":{"DNSName":"studio.example."},"CertDomains":null}"#;

        match decide(27182, named, "") {
            Address::NotServed { command, .. } => {
                assert_eq!(
                    command.as_deref(),
                    Some("tailscale serve --bg http://127.0.0.1:27182")
                )
            }
            other => panic!("expected NotServed, got {other:?}"),
        }

        match decide(27182, no_certs, "") {
            Address::NotServed { command, .. } => assert_eq!(
                command, None,
                "a tailnet that cannot issue certificates must not be told to run serve"
            ),
            other => panic!("expected NotServed, got {other:?}"),
        }
    }

    /// AND SERVING WINS OVER EVERYTHING. A tailnet already proxying our port has
    /// a working address, whatever it says about issuing certificates — the
    /// certificate is evidently already there.
    #[test]
    fn a_served_port_reports_its_url_even_without_cert_domains() {
        let no_certs = r#"{"Self":{"DNSName":"studio.example."},"CertDomains":null}"#;
        match decide(
            27182,
            no_certs,
            "https://studio.example/ proxy http://127.0.0.1:27182",
        ) {
            Address::Https { url } => assert_eq!(url, "https://studio.example/"),
            other => panic!("expected Https, got {other:?}"),
        }
    }

    /// NO TAILNET NAME IS NO ADDRESS, and carries no URL on purpose: a
    /// plain-HTTP address loads and then cannot hold a sign-in.
    #[test]
    fn no_tailnet_name_reports_no_https() {
        assert!(matches!(
            decide(27182, "{}", ""),
            Address::NoHttps { port: 27182 }
        ));
    }
}
