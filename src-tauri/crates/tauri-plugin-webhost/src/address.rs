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

use crate::state::Bind;

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
    /// The listener has not answered yet. **ASK AGAIN** — this is the only
    /// state that resolves itself, and telling it apart from `Unavailable` is
    /// the whole reason `Bind` exists. It used to be reported as `Unavailable`,
    /// which the pane draws as a permanent failure a reader is asked to restart
    /// the app over.
    Binding,
    /// The bind was REFUSED; there is nothing to reach and there will not be.
    /// The plugin binds one pinned port and does not scan for another.
    Unavailable,
}

/// Run a command and return its stdout, or `None` for anything that went wrong.
///
/// A missing binary, a non-zero exit and unreadable output are ONE case on
/// purpose: each of them means "cannot answer", and telling them apart would
/// only tempt a caller into reporting a diagnosis it cannot support.
/// How long a Tailscale invocation may take before it is given up on.
///
/// ⚠️ **THERE WAS NO DEADLINE, AND THIS RUNS FROM AN ASYNC COMMAND.** A
/// `tailscale` that hangs — a wedged daemon, a control server that will not
/// answer, an NFS-mounted binary on a dead mount — held the calling thread with
/// no way out. It reaches the runtime through `spawn_blocking` now, so it can
/// no longer occupy an async worker; the timeout is what stops it occupying a
/// blocking one for ever.
///
/// Five seconds: `tailscale status` answers in milliseconds when the daemon is
/// up, and a reader watching the Browsers pane will not wait longer than this
/// to be told there is no tailnet.
const ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

fn ask(program: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    /* WAITED FOR WITH A DEADLINE, and killed past it. `output()` waits for ever
     * — there is no timeout on it — so a hung `tailscale` was a thread this
     * process never got back. */
    let deadline = std::time::Instant::now() + ASK_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }

    let mut stdout = child.stdout.take()?;
    let mut text = String::new();
    std::io::Read::read_to_string(&mut stdout, &mut text).ok()?;
    Some(text)
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
/// ⚠️ **PARSED, AND IT USED TO BE SEARCHED.** The old version found `"Self"`
/// and then searched from there to the END OF THE DOCUMENT for `"DNSName"` —
/// so on a tailnet whose `Self` carries no DNS name (MagicDNS off, or a node
/// that has not been issued one) it returned the first PEER's, and the pane
/// told the reader to point their browser at somebody else's machine. A `null`
/// value had the same shape: the next quoted key in the document came back as
/// a hostname.
///
/// `Self.DNSName` is one field of one named object, which is a thing a parser
/// can express and a substring search cannot.
pub fn parse_dns_name(status_json: &str) -> Option<String> {
    let status: serde_json::Value = serde_json::from_str(status_json).ok()?;
    let name = status.get("Self")?.get("DNSName")?.as_str()?;
    let name = name.trim_end_matches('.');
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
    let Ok(status) = serde_json::from_str::<serde_json::Value>(status_json) else {
        return false;
    };
    /* AN EMPTY LIST IS A NO, and so is `null` or absent. Both mean the tailnet
     * will issue for nothing, and only the presence of an entry means it will.
     *
     * Parsed rather than searched, for `parse_dns_name`'s reason: the old
     * version found the KEY anywhere in the document and read whatever followed
     * the next colon, which is a different field on any node that happens to
     * carry one. */
    status
        .get("CertDomains")
        .and_then(|value| value.as_array())
        .is_some_and(|domains| !domains.is_empty())
}

/// Whether a serve config proxies our loopback port **at the root**.
///
/// ⚠️ **THIS WAS A SUBSTRING SEARCH OVER THE WHOLE DOCUMENT**, and the answer it
/// gives is what decides whether the pane prints a URL. `tailscale serve status`
/// lists every handler a node has:
///
/// ```text
/// https://studio.tail1234.ts.net (tailnet only)
/// |-- /       proxy http://127.0.0.1:9000
/// |-- /books  proxy http://127.0.0.1:27182
/// ```
///
/// Our port is mentioned, so the old check said yes — and the pane printed
/// `https://studio.tail1234.ts.net/`, which reaches whatever is at `/`. That is
/// exactly the failure the not-served branch exists to prevent, stated in its
/// own comment: *"printing it because Tailscale happened to be installed would
/// be a guess dressed as an answer"*. A wrong answer here is not a recoverable
/// hint; it is an address the reader will type and that will not work.
///
/// So the PATH is read as well as the target, and only `/` counts. Still a
/// line scan rather than a JSON parse — `serve status` has no `--json` — but the
/// two facts it needs are on one line and in a fixed order.
///
/// The strict direction remains the safe one: a layout this cannot read costs a
/// hint telling the reader to run a command they have already run, which they
/// can see is done.
pub fn serves_port(serve_status: &str, port: u16) -> bool {
    let targets = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    serve_status.lines().any(|line| {
        /* A HANDLER LINE HAS A TARGET AND A PATH, in that order, separated by
         * the verb. Anything without ` proxy ` is a header, a blank, or prose. */
        let Some((left, right)) = line.split_once(" proxy ") else {
            return false;
        };
        if !targets.iter().any(|target| right.contains(target.as_str())) {
            return false;
        }
        root_path(left.trim())
    })
}

/// Whether the left-hand side of a handler line addresses the ROOT.
///
/// ⚠️ **TWO FORMATS, AND ONLY ONE OF THEM IS THE TREE.** `tailscale serve
/// status` prints a single root handler flat:
///
/// ```text
/// https://studio.example/ proxy http://127.0.0.1:27182
/// ```
///
/// and anything more as a tree under the name:
///
/// ```text
/// https://studio.tail1234.ts.net (tailnet only)
/// |-- /       proxy http://127.0.0.1:9000
/// |-- /books  proxy http://127.0.0.1:27182
/// ```
///
/// A parser that knew only the tree form reported the ordinary single-handler
/// case — the one nearly every reader has — as NOT SERVED, which is a hint
/// telling them to run a command they have already run. Caught by an existing
/// test using the flat fixture, which is the argument for having had one.
fn root_path(left: &str) -> bool {
    if let Some(rest) = left.strip_prefix("|--") {
        return rest.trim() == "/";
    }
    /* THE FLAT FORM IS A URL, and its path is what follows the host. `https://`
     * is fixed here rather than parsed: `serve` only ever prints a TLS name,
     * and the alternative is a URL crate for one field. */
    let Some(after_scheme) = left.split_once("://").map(|(_, rest)| rest) else {
        return false;
    };
    match after_scheme.split_once('/') {
        /* `https://host/` — the root, and the only path that serves it. */
        Some((_host, path)) => path.is_empty(),
        /* `https://host` with no slash at all is the same address. */
        None => true,
    }
}

/// Resolve the address, asking Tailscale if it is there.
///
/// The SHELLING OUT is all that is here; `decide` below is the judgement, so it
/// can be tested without a tailnet. That split is not decoration: the decision
/// this makes was wrong for every self-hosted control server and no test could
/// see it, because the only way in was two subprocesses.
pub fn resolve(bind: Bind) -> Address {
    let port = match bind {
        Bind::Bound(port) => port,
        /* NOT `Unavailable`. The listener binds on a spawned task, so every
         * launch passes through this state — and reporting it as a refusal told
         * a reader to quit whatever was holding the port when nothing was. */
        Bind::Pending => return Address::Binding,
        Bind::Failed => return Address::Unavailable,
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
        /* `localhost` is the same answer spelled differently, and Tailscale
        prints whatever the reader typed. */
        assert!(serves_port(
            "https://studio.tail1234.ts.net (tailnet only)\n|-- / proxy http://localhost:27182\n",
            27182
        ));
    }

    /// ⚠️ **OUR PORT ON A SUBPATH IS NOT OUR PORT AT THE ROOT.**
    ///
    /// This was a substring search over the whole document, so any mention
    /// counted — and the answer decides whether the pane prints
    /// `https://<host>/`. With another app at `/` and Paper at `/books`, that
    /// URL reaches the other app: a working-looking address that serves
    /// somebody else, which is precisely what the not-served branch exists to
    /// avoid printing.
    #[test]
    fn a_handler_on_a_subpath_does_not_serve_the_root() {
        let serve = "https://studio.tail1234.ts.net (tailnet only)\n                     |-- /      proxy http://127.0.0.1:9000\n                     |-- /books proxy http://127.0.0.1:27182\n";
        assert!(
            !serves_port(serve, 27182),
            "a handler at /books was read as serving the address the pane prints"
        );
        /* And the app that IS at the root reads as served, so the check has not
        simply become "no". */
        assert!(serves_port(serve, 9000));
    }

    /// A NAME THAT MENTIONS THE PORT IS NOT A HANDLER. Tailscale prints
    /// service names and node names too, and the old check counted any of them.
    #[test]
    fn a_mention_outside_a_handler_line_is_not_a_serve() {
        assert!(!serves_port(
            "svc:app-127.0.0.1:27182 (tailnet only)\n",
            27182
        ));
        assert!(!serves_port(
            "# note: we used to serve http://127.0.0.1:27182\n",
            27182
        ));
    }

    /// ⚠️ **TWO FORMATS, AND THE TREE IS THE RARER ONE.** A single root handler
    /// prints flat, with the path inside the URL; anything more prints as a
    /// tree. A parser that knew only the tree reported the ordinary case as not
    /// served — a hint telling the reader to run a command already run. Caught
    /// by an existing test using the flat fixture, which is the argument for
    /// having had one.
    #[test]
    fn both_shapes_of_serve_status_are_read() {
        /* Flat, which is what nearly every reader has. */
        assert!(serves_port(
            "https://studio.example/ proxy http://127.0.0.1:27182",
            27182
        ));
        assert!(serves_port(
            "https://studio.example proxy http://127.0.0.1:27182",
            27182
        ));
        /* Flat AND on a subpath — the same mistake in the other format. */
        assert!(!serves_port(
            "https://studio.example/books proxy http://127.0.0.1:27182",
            27182
        ));
        /* Tree, root. */
        assert!(serves_port("|-- / proxy http://127.0.0.1:27182", 27182));
    }

    /// ⚠️ **A PEER'S HOSTNAME IS NOT THIS MACHINE'S.**
    ///
    /// `parse_dns_name` found `"Self"` and then searched to the END of the
    /// document for `"DNSName"`. On a tailnet whose `Self` carries none —
    /// MagicDNS off, or a node not yet issued one — the first PEER's came back,
    /// and the pane told the reader to open somebody else's machine.
    #[test]
    fn a_self_without_a_dns_name_does_not_borrow_a_peers() {
        let status = r#"{
            "Self": { "HostName": "studio" },
            "Peer": { "n1": { "DNSName": "someone-else.tail1234.ts.net." } }
        }"#;
        assert_eq!(parse_dns_name(status), None);
    }

    /// And a `null` value is absent, not the next string in the file.
    #[test]
    fn a_null_dns_name_is_no_name() {
        let status = r#"{"Self":{"DNSName":null},"Peer":{"n1":{"DNSName":"other.ts.net."}}}"#;
        assert_eq!(parse_dns_name(status), None);
    }

    #[test]
    fn selfs_own_name_is_read_even_with_peers_before_it() {
        let status = r#"{
            "Peer": { "n1": { "DNSName": "other.tail1234.ts.net." } },
            "Self": { "DNSName": "studio.tail1234.ts.net." }
        }"#;
        assert_eq!(
            parse_dns_name(status).as_deref(),
            Some("studio.tail1234.ts.net")
        );
    }

    /// `CertDomains` ANYWHERE used to answer for the tailnet's.
    #[test]
    fn a_peers_cert_domains_do_not_answer_for_this_tailnet() {
        let status = r#"{
            "Self": { "DNSName": "studio.tail1234.ts.net." },
            "Peer": { "n1": { "CertDomains": ["other.tail1234.ts.net"] } }
        }"#;
        assert!(
            !can_issue_certificates(status),
            "a peer's certificate domains say nothing about this account"
        );
    }

    #[test]
    fn the_tailnets_own_cert_domains_answer_yes() {
        let status = r#"{"Self":{"DNSName":"s.ts.net."},"CertDomains":["s.ts.net"]}"#;
        assert!(can_issue_certificates(status));
        let none = r#"{"Self":{"DNSName":"s.ts.net."},"CertDomains":[]}"#;
        assert!(!can_issue_certificates(none));
        let null = r#"{"Self":{"DNSName":"s.ts.net."},"CertDomains":null}"#;
        assert!(!can_issue_certificates(null));
    }

    /// A document that is not JSON at all answers nothing, rather than
    /// whatever the search happened to land on.
    #[test]
    fn unparseable_status_answers_nothing() {
        assert_eq!(parse_dns_name("tailscale: command not found"), None);
        assert!(!can_issue_certificates("tailscale: command not found"));
    }

    #[test]
    fn no_port_means_there_is_nothing_to_reach() {
        assert_eq!(resolve(Bind::Failed), Address::Unavailable);
        /* AND PENDING IS NOT UNAVAILABLE. Every launch is `Pending` for a
        moment, and reporting that as a refusal is what put "port 27182 was
        already in use" in front of readers whose port was free. */
        assert_eq!(resolve(Bind::Pending), Address::Binding);
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
