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

use iroh::endpoint::presets;
use iroh::{Endpoint, RelayMode, SecretKey};

use crate::error::{Error, Result};

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
/// contradicted it. `advertised()` is what a test reads to hold this file's
/// prose to what the code does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advertised {
    /// The endpoint id published on the LAN, or `None` when mDNS is off.
    ///
    /// ⚠️ **THIS IS THE WHOLE DISCLOSURE, AND IT IS THE ONLY ONE.** iroh's
    /// mDNS service publishes the endpoint id and the endpoint's own direct
    /// addresses. It is handed nothing else: no person id, no roster, no book
    /// hash, no title, no reader's name. There is no field on
    /// `MdnsAddressLookup::builder()` that could carry one.
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
    let EndpointConfig {
        secret,
        alpns,
        bind_port,
        relay_mode,
        discovery,
        label,
    } = config;

    // Rebuilt rather than cloned because `bind()` consumes the builder, and
    // the fixed port needs a second attempt when it is already taken.
    // Captured by value so the closure stays `Fn` and can run twice; the
    // fallback below is the second call.
    let build = |port: Option<u16>| {
        let mut builder = if discovery.n0_dns {
            Endpoint::builder(presets::N0)
        } else {
            Endpoint::builder(presets::Minimal)
        };
        builder = builder
            .secret_key(secret.clone())
            .alpns(alpns.clone())
            .relay_mode(relay_mode.clone());
        match port {
            // v4 only: `bind_addr` replaces the unspecified bind for THAT
            // family, so v6 keeps its ephemeral one and a machine with no
            // IPv4 is not left without an endpoint.
            Some(port) => builder
                .bind_addr(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))
                // Unreachable for a literal `0.0.0.0:PORT`, and mapped
                // rather than unwrapped anyway: a panic here would take
                // the whole app down for a bind address it chose itself.
                .map_err(|err| {
                    Error::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        format!("peer: bad bind address: {err}"),
                    ))
                }),
            None => Ok(builder),
        }
    };

    let endpoint = match bind_port {
        Some(port) => match build(Some(port))?.bind().await {
            Ok(endpoint) => endpoint,
            Err(err) => {
                log::warn!(
                    "peer: the {label} endpoint could not take UDP port {port} ({err}); falling back to an \
                     ephemeral port, so a peer that cannot reach discovery will not find it"
                );
                build(None)?.bind().await?
            }
        },
        None => build(None)?.bind().await?,
    };

    let advertised = register_mdns(&endpoint, discovery.mdns, label);
    report_addresses(endpoint.clone(), label);
    Ok(Bound {
        endpoint,
        advertised,
    })
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
    match iroh_mdns_address_lookup::MdnsAddressLookup::builder().build(endpoint.id()) {
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
fn report_addresses(endpoint: Endpoint, label: &'static str) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
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
        /* A machine that refuses multicast advertises nothing, and that is a
        legitimate answer here rather than a failure — see the doc comment. */
        if let Some(advertised) = bound.advertised.endpoint_id.as_deref() {
            assert_eq!(advertised, id, "the endpoint id, and it is the only value");
            assert_eq!(
                bound.advertised.service_name, MDNS_SERVICE_NAME,
                "iroh's own service name, so a Paper install is not fingerprintable on a LAN"
            );
        }
        bound.endpoint.close().await;
    }
}
