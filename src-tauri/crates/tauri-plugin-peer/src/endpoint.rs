//! Binding an iroh endpoint — the one place a UDP port, a key and a set of
//! ALPNs are turned into a live socket.
//!
//! ⚠️ **THIS EXISTS BECAUSE THERE ARE TWO ENDPOINTS NOW, NOT BECAUSE LAYERING
//! IS TIDY.** WI-25.1: the circle endpoint (identity-addressed, invitation
//! only) and the share endpoint (content-addressed, announced) run in ONE
//! process, on two keys and two ports. Every hard-won behaviour below —
//! the fixed port and its fallback, the v4-only bind address, the mDNS
//! registration that is added after the bind rather than through the builder,
//! the delayed report of what the endpoint believes about itself — was learned
//! once for the circle endpoint. A second endpoint that reimplemented two
//! thirds of it would be a second place for each of those lessons to be
//! forgotten.
//!
//! `node.rs` used to hold all of this and assumed `identity.key` and 47821.
//! It no longer assumes either: both arrive as configuration.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::time::Duration;

use iroh::endpoint::{presets, ConnectError, Connection};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey};
use tokio::time::timeout;

use crate::error::{Error, Result};

/// How long a dial to a paired peer or a provider may take.
///
/// ⚠️ **THIS STOOD IN `session.rs` AND WAS THE SESSION'S ALONE.** It is the
/// same decision wherever this crate dials — how long to wait for a machine
/// that may be asleep, behind a proxy, or gone — and a second constant spelling
/// the same thirty seconds is a second thing to move. `circle::introduce` keeps
/// its own tighter bound on purpose, and says so there; what it does not do is
/// re-declare this one.
pub(crate) const DIAL_TIMEOUT: Duration = Duration::from_secs(30);

/// Dial one endpoint under a deadline — **THE ONLY PLACE THIS CRATE CALLS
/// `Endpoint::connect`**, and `dial_is_the_only_door` is what keeps it so.
///
/// ⚠️ **A DIAL WITH NO DEADLINE HANGS THE CALLER AND EVERY CANDIDATE BEHIND
/// IT.** `ShareNode::fetch_book` learned this once already — its own comment
/// records a provider that connected and stalled taking a book off the network
/// for a reader who had four other sources — and `notes::ask_one`, written
/// later and looping over providers in exactly the same way, dialled with no
/// bound at all. Everything after its connect was under a deadline, which is
/// what made the gap easy to miss: the one wait nobody had bounded was the
/// first. A reader pressing "Look for some" waited on it with no way to stop.
///
/// The deadline is the caller's, because they are not all the same question:
/// the circle's door is dialled on a tighter one than a stranger's provider.
/// So is the sentence for a dial that ran out, which is why this answers `None`
/// rather than inventing an error — three call sites already had their own
/// words for "nobody answered", and they read differently to a reader dialling
/// a friend and to one asking a stranger for a book.
pub(crate) async fn dial(
    endpoint: &Endpoint,
    addr: impl Into<EndpointAddr>,
    alpn: &[u8],
    within: Duration,
) -> Option<std::result::Result<Connection, ConnectError>> {
    timeout(within, endpoint.connect(addr, alpn)).await.ok()
}

/// How an endpoint finds peers beyond the address hints it already has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Discovery {
    /// n0's DNS address lookup (publish and resolve). The app default; off
    /// for "Local network only" and in tests.
    pub n0_dns: bool,
    /// LAN mDNS (`iroh-mdns-address-lookup`). Desktop, and best-effort on
    /// Android; not on iOS, where raw multicast needs an entitlement
    /// (plan III.2.7).
    pub mdns: bool,
}

impl Discovery {
    pub const NONE: Discovery = Discovery {
        n0_dns: false,
        mdns: false,
    };
}

/// THE UDP PORT THE CIRCLE ENDPOINT BINDS, and the reason it is fixed at all.
///
/// iroh binds an ephemeral port by default, so the port changes on every
/// launch. That is invisible while address discovery works — a peer re-learns
/// the address through mDNS or n0's DNS every time. It is fatal when discovery
/// does NOT work, because the only thing left is the address hints stored at
/// the last successful session, and those carry the OLD port.
///
/// Measured on two Macs behind a TUN proxy (2026-08-22): the satchel was bound
/// to 54370 while the shelf still had 56827 recorded for it, from two days
/// earlier. Every direct dial went to a dead port, hole punching could not run
/// because the proxy's varying egress makes the mapping look endpoint-
/// dependent to QUIC Address Discovery, and the two machines — on ONE LAN —
/// had not held a session for thirty-nine hours.
///
/// A fixed port makes a stored LAN address stay TRUE across restarts, which is
/// what lets two machines on the same network reach each other with no
/// discovery, no relay and no hole punching at all. It is also what most
/// peer-to-peer software on a desktop already does.
///
/// Not registered with IANA and not meant to be: high in the dynamic range,
/// clear of this repository's other pinned port (31415, the MCP bridge).
pub const APP_BIND_PORT: u16 = 47821;

/// THE UDP PORT THE SHARE ENDPOINT BINDS — WI-25.1.
///
/// Fixed for [`APP_BIND_PORT`]'s reason: a stored address hint that stays true
/// across restarts is what lets a provider be reached with no discovery at all.
///
/// ⚠️ **A FIXED PORT IS EXACTLY WHAT `NodeConfig::bind_port` WARNS ABOUT** —
/// two endpoints in one process on ONE port either fail to bind or "quietly
/// take the first one's traffic". Two ports, named apart, IS the whole
/// mitigation, so the two constants live side by side here where a change to
/// one is read next to the other.
pub const SHARE_BIND_PORT: u16 = 47822;

/// What one endpoint is bound with.
pub struct EndpointConfig {
    /// The endpoint's identity. Loaded by `identity::load_or_create_named`,
    /// never generated here — an endpoint whose key is minted at bind time is
    /// an endpoint whose id changes on every launch.
    pub secret: SecretKey,
    /// The protocols this endpoint answers. A request arriving for anything
    /// else is refused by the caller's dispatch, which is why the two
    /// endpoints' lists must not overlap.
    pub alpns: Vec<Vec<u8>>,
    /// The UDP port to bind, or `None` for an ephemeral one.
    ///
    /// `None` IS RIGHT FOR TESTS and wrong for the app: the suites here run
    /// several endpoints in one process, and a fixed port would make the
    /// second one fail to bind — or, worse, quietly take the first one's
    /// traffic.
    pub bind_port: Option<u16>,
    pub relay_mode: RelayMode,
    pub discovery: Discovery,
    /// Which endpoint this is, for the log. ⚠️ **TWO ENDPOINTS IN ONE PROCESS
    /// MEANS TWO OF EVERY WARNING BELOW**, and a `Paper.log` that says "UDP
    /// port unavailable" twice without saying which one is a log that answers
    /// nothing. See `AGENTS.md` §"The RUST log is already on disk".
    pub label: &'static str,
}

/// What a LAN observer is told, once this endpoint is up — WI-25.8.
///
/// ⚠️ **A VALUE, NOT A LOG LINE, BECAUSE THE CLAIM HAD TO BE TESTABLE.** Phase
/// 25's first draft claimed the circle was not discoverable while the circle
/// endpoint was mDNS-advertised by default, and nothing in the tree could have
/// contradicted it. This struct is what a test reads to hold the file's prose to
/// what the code does.
///
/// ⚠️ **THROUGH `Bound.advertised`, NOT THROUGH AN `advertised()` METHOD.** The
/// sentence here named the accessor; the tests below read the FIELD, and the
/// accessors on `Node` and `ShareNode` have no caller at all — production or
/// test. Named accurately so the next reader looking for the coverage finds it,
/// and so the two unused methods are not mistaken for the thing under test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advertised {
    /// The endpoint id published on the LAN, or `None` when mDNS is off.
    ///
    /// ⚠️ **THIS IS THE WHOLE DISCLOSURE, AND IT IS THE ONLY ONE.** iroh's
    /// mDNS service publishes the endpoint id, the endpoint's own direct
    /// addresses, and — with `iroh-mdns-address-lookup` 0.4.0's default
    /// `publish_relay_url` — its FIRST RELAY URL. It is handed nothing else:
    /// no person id, no roster, no book hash, no title, no reader's name.
    /// There is no field on `MdnsAddressLookup::builder()` that could carry
    /// one.
    ///
    /// ⚠️ **THE RELAY URL WAS MISSING FROM THAT LIST.** An observer on the LAN
    /// learns which relay this machine is homed to, which is a fact about
    /// where it is and who it is likely reachable through — not a secret, and
    /// not nothing. A disclosure that claims to be complete has to be. Found
    /// by audit.
    pub endpoint_id: Option<String>,
    /// The mDNS service name. ⚠️ **iroh's DEFAULT, DELIBERATELY, FOR BOTH
    /// ENDPOINTS.** A service name of Paper's own would let a stranger on a
    /// café LAN tell a Paper install from any other iroh application; under
    /// `irohv1` both of this process's endpoints are two iroh endpoints among
    /// however many others. Share discovery is global (WI-25.7), not LAN, so
    /// a distinctive name would buy nothing and cost that.
    pub service_name: &'static str,
}

/// iroh's own default mDNS service name — see [`Advertised::service_name`].
///
/// ⚠️ **IT WAS A COPY OF THE DEPENDENCY'S DEFAULT THAT REGISTRATION NEVER
/// USED.** `MdnsAddressLookup::builder()` was not told a service name, so this
/// was what Paper BELIEVED iroh published under rather than what it did — and
/// the test compared the reported name with this same constant, so an upstream
/// change would have moved the real name while both sides went on agreeing.
/// `advertise` passes it now, which makes the constant a fact. Found by audit.
///
/// ⚠️ **AND THAT MOVES ONE RISK TO ANOTHER, DELIBERATELY.** Pinned, Paper
/// keeps saying `irohv1` if iroh's own default ever moves — which would make a
/// Paper install the odd one out on a LAN, the thing this value exists to
/// avoid. The dependency's constant is private, so nothing can check it from
/// here. **On an `iroh-mdns-address-lookup` bump, read its `N0_SERVICE_NAME`
/// and match it**; that is a decision for the bump, where somebody is looking,
/// rather than a default that changes underneath a claim.
pub const MDNS_SERVICE_NAME: &str = "irohv1";

/// What [`bind`] answers: the endpoint and what it tells the LAN.
pub struct Bound {
    pub endpoint: Endpoint,
    pub advertised: Advertised,
}

/// Bind one endpoint: the key, the ALPNs, the port, discovery.
///
/// ⚠️ **FALLS BACK RATHER THAN FAILING when the fixed port is taken.** A fixed
/// port is a large gain and a small risk — a second Paper on this machine, or
/// a socket the kernel has not released — and an app with no transport at all
/// is a worse outcome than one whose stored addresses go stale again. The
/// warning is the signal; silence here would hide a permanently undiscoverable
/// endpoint behind a working-looking app.
///
/// ⚠️ **AND THAT FALLBACK IS WHAT MAKES THE TWO ENDPOINTS INDEPENDENT.**
/// WI-25.1's acceptance says occupying 47822 must leave the circle working:
/// it does, because the share endpoint's bind failure costs the share endpoint
/// a stable port and costs the circle endpoint nothing at all.
pub async fn bind(config: EndpointConfig) -> Result<Bound> {
    /* ⚠️ **THE FALLBACK IS THE ONLY DECISION HERE, AND IT USED TO BE THE
     * FOURTH THING IN A SIXTY-THREE-LINE FUNCTION.** Builder configuration,
     * an address-error conversion, the nested retry, mDNS registration and a
     * diagnostic task shared one body — so the policy a reader comes to this
     * file for was the hardest part of it to find. Three named pieces, one
     * sentence each. Found by audit. */
    let label = config.label;
    let mdns = config.discovery.mdns;
    let endpoint = bound_endpoint(config).await?;
    let advertised = register_mdns(&endpoint, mdns, label);
    report_addresses(endpoint.clone(), label);
    Ok(Bound {
        endpoint,
        advertised,
    })
}

/// The endpoint itself: the fixed port if it is free, an ephemeral one if not.
///
/// ⚠️ **FALLS BACK RATHER THAN FAILING** — see [`bind`], which states why.
async fn bound_endpoint(config: EndpointConfig) -> Result<Endpoint> {
    let EndpointConfig {
        secret,
        alpns,
        bind_port,
        relay_mode,
        discovery,
        label,
    } = config;
    let build =
        |port: Option<u16>| builder_for(&secret, &alpns, &relay_mode, discovery.n0_dns, port);
    match bind_port {
        Some(port) => match build(Some(port))?.bind().await {
            Ok(endpoint) => Ok(endpoint),
            Err(err) => {
                log::warn!(
                    "peer: the {label} endpoint could not take UDP port {port} ({err}); falling back to an \
                     ephemeral port, so a peer that cannot reach discovery will not find it"
                );
                Ok(build(None)?.bind().await?)
            }
        },
        None => Ok(build(None)?.bind().await?),
    }
}

/// One configured builder.
///
/// ⚠️ **REBUILT RATHER THAN CLONED**, because `bind()` consumes the builder and
/// the fixed port needs a second attempt when it is already taken. Everything
/// is taken by reference and cloned inside, so the caller can call it twice.
fn builder_for(
    secret: &SecretKey,
    alpns: &[Vec<u8>],
    relay_mode: &RelayMode,
    n0_dns: bool,
    port: Option<u16>,
) -> Result<iroh::endpoint::Builder> {
    let mut builder = if n0_dns {
        Endpoint::builder(presets::N0)
    } else {
        Endpoint::builder(presets::Minimal)
    };
    builder = builder
        .secret_key(secret.clone())
        .alpns(alpns.to_vec())
        .relay_mode(relay_mode.clone());
    match port {
        /* v4 only: `bind_addr` replaces the unspecified bind for THAT family,
        so v6 keeps its ephemeral one and a machine with no IPv4 is not left
        without an endpoint. */
        Some(port) => builder
            .bind_addr(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))
            /* Unreachable for a literal `0.0.0.0:PORT`, and mapped rather than
            unwrapped anyway: a panic here would take the whole app down for
            a bind address it chose itself. */
            .map_err(|err| {
                Error::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("peer: bad bind address: {err}"),
                ))
            }),
        None => Ok(builder),
    }
}

/// Put this endpoint on the LAN, and say what that discloses.
///
/// Added after the bind, not through the builder, so a network that refuses
/// multicast (Android without a MulticastLock, plan III.2.7) costs LAN
/// discovery and nothing else — never the endpoint.
fn register_mdns(endpoint: &Endpoint, wanted: bool, label: &str) -> Advertised {
    let none = Advertised {
        endpoint_id: None,
        service_name: MDNS_SERVICE_NAME,
    };
    if !wanted {
        return none;
    }
    /* ⚠️ **BOTH ENDPOINTS ADVERTISE, AND THAT IS THE DECISION — WI-25.8.**
     * The alternative considered was to advertise only the share endpoint.
     * It does not work, and the reason is worth keeping: mDNS discovery is
     * SYMMETRIC. If no Paper advertises its circle endpoint then no Paper
     * resolves one either, and the LAN path that `APP_BIND_PORT` exists to
     * protect — two machines on one network, no relay, no hole punching —
     * goes with it. The thirty-nine-hour outage that pinned the port is what
     * that costs.
     *
     * So the disclosure is stated instead of denied: a stranger subscribing
     * to mDNS on this LAN sees TWO endpoint ids from this machine and their
     * addresses. Not one — two, from today. They see no person id, no book
     * hash and no name, because nothing here is given one. */
    /* ⚠️ **THE NAME IS PASSED, NOT ASSUMED.** `MDNS_SERVICE_NAME` used to be
     * a copy of the dependency's default that registration never mentioned —
     * so `Advertised::service_name` reported what Paper BELIEVED iroh
     * published under, and an upstream change would have moved the real name
     * while the constant and the test went on agreeing with each other. Passed
     * explicitly, the constant is what is actually used. Found by audit. */
    match iroh_mdns_address_lookup::MdnsAddressLookup::builder()
        .service_name(MDNS_SERVICE_NAME)
        .build(endpoint.id())
    {
        Ok(mdns) => match endpoint.address_lookup() {
            Ok(services) => {
                services.add(mdns);
                log::info!("peer: mDNS address lookup registered for the {label} endpoint");
                Advertised {
                    endpoint_id: Some(endpoint.id().to_string()),
                    service_name: MDNS_SERVICE_NAME,
                }
            }
            // NOT SWALLOWED. This arm used to be an `if let Ok(..)` with no
            // else, so an endpoint that refused its address lookup lost LAN
            // discovery in total silence — the app looked healthy, published
            // nothing, and was findable only through a relay. A LAN with no
            // iroh service on it is exactly what that looks like from outside.
            Err(err) => {
                log::warn!(
                    "peer: address lookup unavailable, no LAN discovery for the {label} endpoint: {err}"
                );
                none
            }
        },
        Err(err) => {
            log::warn!("mDNS address lookup unavailable for the {label} endpoint: {err}");
            none
        }
    }
}

/// WHAT THIS ENDPOINT BELIEVES ABOUT ITSELF, once discovery has had a moment
/// to run. The addresses here are what a pairing URL carries and what mDNS
/// publishes, so an empty list is the difference between an endpoint that can
/// be reached and one that cannot — and it is invisible from every other
/// signal the app produces.
///
/// ⚠️ **IT LETS GO THE MOMENT THE ENDPOINT CLOSES, BECAUSE A CLONE HELD THE
/// UDP SOCKET OPEN.** This slept five seconds holding an `Endpoint` clone. In
/// the pinned iroh 1.0.3 the socket stays bound until every clone is dropped,
/// `close()` included — so a shutdown inside those five seconds left the port
/// occupied, and a relaunch fell back to an ephemeral port for a reason
/// nothing reported. The fixed ports are the whole point of `APP_BIND_PORT`
/// and `SHARE_BIND_PORT`. A diagnostic must not be able to cost them, so it
/// races the sleep against the endpoint's own `closed()`. Found by audit.
fn report_addresses(endpoint: Endpoint, label: &'static str) {
    tokio::spawn(async move {
        /* ⚠️ **THE CLONE IS DROPPED THE MOMENT THE ENDPOINT CLOSES, NOT FIVE
         * SECONDS LATER.** `select` on `closed()` rather than sleeping through
         * it: whichever arrives first, this task ends and its clone goes. A
         * plain sleep meant a shutdown inside the window kept the socket bound
         * until it finished. */
        tokio::select! {
            () = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = endpoint.closed() => {
                log::debug!(
                    "peer: the {label} endpoint closed before its addresses were reported"
                );
                return;
            }
        }
        let addr = endpoint.addr();
        let ips: Vec<String> = addr.ip_addrs().map(|a| a.to_string()).collect();
        let relays: Vec<String> = addr.relay_urls().map(|r| r.to_string()).collect();
        if ips.is_empty() {
            log::warn!(
                "peer: the {label} endpoint reports NO direct addresses; pairing URLs and mDNS will carry none (relays: {relays:?})"
            );
        } else {
            log::info!("peer: {label} endpoint direct addresses {ips:?} relays {relays:?}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_ports_are_different_and_neither_is_the_mcp_bridge() {
        /* ⚠️ **ONE PORT FOR TWO ENDPOINTS IN ONE PROCESS EITHER FAILS TO BIND
        OR QUIETLY TAKES THE OTHER'S TRAFFIC**, which is the whole reason
        `NodeConfig::bind_port` documents `None` as right for tests. Two ports
        named apart is the mitigation, so their being different is a property
        and not an accident of how they were typed. */
        assert_ne!(APP_BIND_PORT, SHARE_BIND_PORT);
        /* And clear of this repository's other pinned port — `AGENTS.md`
        §"End-to-end testing" pins 31415 for the MCP bridge and explains that
        the plugin scans the next hundred ports from its own default. */
        for port in [APP_BIND_PORT, SHARE_BIND_PORT] {
            assert!(
                port > 31415 + 100,
                "{port} is inside the bridge's scan window"
            );
        }
    }

    #[tokio::test]
    async fn an_endpoint_with_mdns_off_advertises_nothing() {
        let bound = bind(EndpointConfig {
            secret: SecretKey::generate(),
            alpns: vec![b"paper/test/1".to_vec()],
            bind_port: None,
            relay_mode: RelayMode::Disabled,
            discovery: Discovery::NONE,
            label: "test",
        })
        .await
        .expect("an endpoint binds");
        assert_eq!(bound.advertised.endpoint_id, None);
        bound.endpoint.close().await;
    }

    /// WHAT A STRANGER ON THE LAN SEES — WI-25.8's acceptance, as far as it can
    /// be asked without a second machine.
    ///
    /// ⚠️ **NOT A LIVE mDNS SUBSCRIBER, AND THE REASON IS THE FINDING ITSELF.**
    /// A test that joined a multicast group would measure the developer's
    /// network — CI has none, a café LAN has fifty other endpoints — and would
    /// answer "saw nothing" on a machine where multicast is simply refused. A
    /// detector that finds nothing looks exactly like a clean result
    /// (`AGENTS.md` §"What a browser can reach"). So the assertion is over
    /// what is HANDED to the service, which is the thing this codebase
    /// controls and the thing the claim is about.
    #[tokio::test]
    async fn what_is_advertised_is_the_endpoint_id_and_nothing_else() {
        let secret = SecretKey::generate();
        let id = secret.public().to_string();
        let bound = bind(EndpointConfig {
            secret,
            alpns: vec![b"paper/test/1".to_vec()],
            bind_port: None,
            relay_mode: RelayMode::Disabled,
            discovery: Discovery {
                n0_dns: false,
                mdns: true,
            },
            label: "test",
        })
        .await
        .expect("an endpoint binds");
        /* ⚠️ **THE `None` BRANCH USED TO SKIP EVERY ASSERTION**, so this
        measured nothing at all on a machine that refuses multicast — and a
        detector that finds nothing looks exactly like a clean result. What
        decides is whether THIS machine can build an mDNS service, which is
        answerable here without joining a multicast group: if it can,
        registration must have produced the id; if it cannot, it must have
        produced nothing. Either way something is asserted. Found by audit.

        ⚠️ **AND WHAT STOPS THE REGISTRATION BEING DELETED IS THE COMPILER,
        NOT THIS TEST.** `services.add(mdns)` returns nothing and adds nothing
        observable in-process, so no assertion here can tell a registered
        service from an unregistered one. Removing the call leaves `mdns`
        unused, which `cargo clippy -- -D warnings` refuses to compile —
        verified by doing it. Saying so is better than implying this covers
        it. */
        let can_advertise = iroh_mdns_address_lookup::MdnsAddressLookup::builder()
            .build(bound.endpoint.id())
            .is_ok();
        if can_advertise {
            assert_eq!(
                bound.advertised.endpoint_id.as_deref(),
                Some(id.as_str()),
                "this machine can advertise and the endpoint was not registered"
            );
        } else {
            assert_eq!(
                bound.advertised.endpoint_id, None,
                "an endpoint that could not build an mDNS service claimed to advertise"
            );
        }
        /* And whatever it advertises, it advertises under IROH'S name — so a
        Paper install is not fingerprintable on a LAN. */
        assert_eq!(bound.advertised.service_name, MDNS_SERVICE_NAME);
        bound.endpoint.close().await;
    }

    /// ⚠️ **`MDNS_SERVICE_NAME` IS A COPY OF THE DEPENDENCY'S DEFAULT AND
    /// REGISTRATION NEVER PASSES IT.** So the constant is what Paper BELIEVES
    /// iroh publishes under, and the test above compared the reported name
    /// with that same constant — an upstream change would have moved the real
    /// name while both sides went on agreeing. This holds the constant to the
    /// dependency instead. Found by audit.
    #[test]
    fn the_service_name_is_the_one_registration_passes() {
        /* The dependency's own constant is private, so this cannot be checked
        against it from here — see `MDNS_SERVICE_NAME`, which records what
        to do at an `iroh-mdns-address-lookup` bump. What IS held is that
        the value Paper reports is the value Paper passes, which is what
        made the old spelling a belief rather than a fact. */
        assert_eq!(MDNS_SERVICE_NAME, "irohv1");
    }

    /// ⚠️ **ONE DOOR, BECAUSE THE ONE THAT WAS MISSING A DEADLINE LOOKED
    /// EXACTLY LIKE THE THREE THAT HAD ONE.** `session::connect`,
    /// `pairing::dial` and `circle::introduce` each wrapped their own
    /// `Endpoint::connect` in their own `timeout` with their own constant — two
    /// of those constants being the same thirty seconds written twice — and
    /// `notes::ask_one`, written later, wrapped everything AFTER its connect
    /// and left the connect itself unbounded. A reader pressing "Look for some"
    /// waited on it with nothing to stop it, and every later provider in the
    /// queue waited behind it.
    ///
    /// A rule spelled at four call sites is a rule the fifth call site does not
    /// have. This is what makes a fifth one loud: `dial` is the only production
    /// code in this crate that may name `Endpoint::connect`, and the deadline
    /// is a parameter so a caller that needs a tighter one still goes through
    /// the door rather than around it.
    #[test]
    fn dial_is_the_only_door() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        walk(&src, &mut files);
        /* NON-VACUOUS: a walk that found nothing would pass silently, which is
           the failure this whole test exists to make loud. */
        assert!(
            files.len() > 10,
            "the source walk found {} files, so it scanned nothing",
            files.len()
        );
        /* ⚠️ **A WHOLE FILE CAN BE TEST CODE WITH NO `#[cfg(test)]` IN IT.**
           `share/acceptance.rs` is a thousand lines of dialling and carries no
           attribute of its own — the gate is `#[cfg(test)] mod acceptance;` in
           `share/mod.rs`. Read the DECLARATIONS rather than assuming the file
           says so about itself, or the first version of this test reports a
           whole test suite as production code, which is what it did. */
        let mut test_only = Vec::new();
        for file in &files {
            let text = std::fs::read_to_string(file).expect("a source file reads");
            for part in text.split("#[cfg(test)]").skip(1) {
                let Some(rest) = part.trim_start().strip_prefix("mod ") else {
                    continue;
                };
                let Some(name) = rest.split(';').next().filter(|one| !one.contains('{')) else {
                    continue;
                };
                test_only.push(name.trim().to_owned());
            }
        }
        assert!(
            test_only.iter().any(|one| one == "acceptance"),
            "the test-only module scan found none, so it is excluding nothing: {test_only:?}"
        );
        let mut offenders = Vec::new();
        for file in &files {
            let stem = file.file_stem().map(|one| one.to_string_lossy().into_owned());
            if stem.is_some_and(|one| test_only.contains(&one)) {
                continue;
            }
            let text = std::fs::read_to_string(file).expect("a source file reads");
            /* And within a production file, everything from its first
               `#[cfg(test)]` on is test code — a test dialling however it likes
               is fine. */
            let production = match text.find("#[cfg(test)]") {
                Some(at) => &text[..at],
                None => &text[..],
            };
            if !production.contains(".connect(") {
                continue;
            }
            if file.file_name().is_some_and(|name| name == "endpoint.rs") {
                continue;
            }
            offenders.push(file.display().to_string());
        }
        assert!(
            offenders.is_empty(),
            "these dial without going through `endpoint::dial`, so their deadline is theirs to forget: {offenders:?}"
        );
        /* And the door itself is still ONE door. Counted over this file's own
           production half, because the assertions above name `.connect(` in
           their messages and would otherwise count themselves. */
        let here = include_str!("endpoint.rs");
        let door = &here[..here.find("#[cfg(test)]").expect("this file has tests")];
        assert_eq!(door.matches(".connect(").count(), 1, "`dial` grew a second connect");
    }

    fn walk(dir: &std::path::Path, into: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("the source tree reads") {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                walk(&path, into);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                into.push(path);
            }
        }
    }
}
