//! Keeping this device's circle credentials fresh, and its friends up to date.
//!
//! ⚠️ **EVERY PART OF THE CIRCLE WAS A THING SOMETHING ELSE HAD TO REMEMBER TO
//! DO.** `circle::should_renew` could say a delegation was due for renewal and
//! nothing ever asked it; `circle::introduce` could carry a revocation to a
//! friend and nothing ever called it. Both are correct, both were unreachable,
//! and the symptoms are the worst kind — a delegation that expires ninety days
//! after a reader last thought about it, and a revoked laptop that keeps its
//! access to everybody who has not happened to dial since.
//!
//! ## Why introductions repeat rather than happening once
//!
//! A hello is the ONLY thing that carries a roster, and a roster is the only
//! thing that carries a revocation. Introducing solely to devices that are not
//! yet trusted would mean a revocation never reaches the people who already
//! trust you — which is every person it matters to. So a round greets everyone,
//! on a cadence slow enough to be free and fast enough to matter.

use std::sync::Arc;
use std::time::Duration;

use crate::circle;
use crate::node::Node;

/// How often a device renews, re-greets, and carries its roster around.
///
/// ⚠️ **THIS IS A REVOCATION'S WORST-CASE DELIVERY TIME, and that is the number
/// to argue about.** A revoked device keeps whatever access a peer already
/// granted it until that peer hears otherwise, so the cadence is how long "I
/// revoked my stolen laptop" takes to mean anything on somebody else's
/// machine. Six hours is a compromise: a revocation is not an emergency stop —
/// `relationships.md` is explicit that forcing anything on a hostile peer is
/// out of scope — and a device that greets every friend every minute is a
/// device whose battery its owner notices.
///
/// A revocation made ON THIS DEVICE does not wait for it: see [`Keeper::now`].
pub const ROUND_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// The first round waits, so a launch is not a burst of dials.
///
/// A reader opening the app wants their book, and the network is the one thing
/// that can make that slow. Nothing here is urgent to the second.
pub const FIRST_ROUND_AFTER: Duration = Duration::from_secs(30);

/// What one round did. Returned rather than only logged so a test can assert
/// on it — a round that silently does nothing looks exactly like a round that
/// worked.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Round {
    /// Devices greeted, whatever they answered.
    pub greeted: usize,
    /// Devices that admitted this one.
    pub admitted: usize,
    /// Whether this round minted or renewed this device's credentials.
    pub renewed: bool,
}

/// One pass: renew if due, then greet every device of every person we know.
///
/// ⚠️ **A FAILED DIAL IS NOT A FAILED ROUND.** Most devices are asleep most of
/// the time; returning early on the first unreachable one would mean a single
/// offline friend stops a revocation reaching everybody else. Each is tried,
/// each failure is logged, and the round reports what it managed.
pub async fn round(node: &Arc<Node>) -> Round {
    let mut done = Round::default();
    let root = node.root().to_path_buf();
    let device = node.id().to_string();

    /* ⚠️ **OFF THE RUNTIME THREAD.** Renewal reads the OS keychain, which
     * blocks — behind a UI prompt on macOS. Inline, it stalls every connection
     * this node is serving, on a timer, for as long as a human takes to
     * notice a dialog. */
    let before = circle::read_mine(&root).ok().flatten();
    let renewed = {
        let root = root.clone();
        let device = device.clone();
        let keychain = node.keychain();
        tokio::task::spawn_blocking(move || {
            circle::mine_for(keychain.as_ref(), &root, &device, circle::now_ms())
        })
        .await
    };
    match renewed {
        Ok(Ok(mine)) => done.renewed = before.as_ref() != Some(&mine),
        /* A device with no identity has nothing to introduce and is not
        broken — it is a reader who has never shared. Not a warning. */
        Ok(Err(err)) => {
            log::debug!("circle: nothing to introduce with this round: {err}");
            return done;
        }
        Err(err) => {
            log::warn!("circle: the renewal task was dropped: {err}");
            return done;
        }
    }

    let people = match circle::known_people(&root) {
        Ok(people) => people,
        Err(err) => {
            log::warn!("circle: could not read the people file: {err}");
            return done;
        }
    };
    for person in &people {
        for theirs in &person.devices {
            /* Not this device, and not one this person has revoked — dialling
            a device we already know is finished is a round trip that can
            only fail. */
            if theirs == &device || person.revoked.iter().any(|r| r == theirs) {
                continue;
            }
            let addr = match crate::node::parse_peer_id(theirs) {
                Ok(id) => {
                    let hints = node
                        .peers()
                        .get(theirs)
                        .map(|record| record.last_addrs.clone())
                        .unwrap_or_default();
                    crate::session::endpoint_addr(id, &hints)
                }
                Err(err) => {
                    log::warn!("circle: {theirs} is not an endpoint key: {err}");
                    continue;
                }
            };
            done.greeted += 1;
            match circle::introduce(node, addr).await {
                Ok(true) => done.admitted += 1,
                /* Refused is an ANSWER — this reader is not in that person's
                circle yet — and it is theirs to make. Not a warning. */
                Ok(false) => log::debug!("circle: {theirs} did not admit this device"),
                Err(err) => log::debug!("circle: could not reach {theirs}: {err}"),
            }
        }
    }
    done
}

/// The loop. Runs until the node is dropped.
pub async fn keep(node: std::sync::Weak<Node>, wake: Arc<tokio::sync::Notify>) {
    tokio::time::sleep(FIRST_ROUND_AFTER).await;
    loop {
        let Some(node) = node.upgrade() else { return };
        let done = round(&node).await;
        if done.greeted > 0 || done.renewed {
            log::info!(
                "circle: greeted {} device(s), {} admitted{}",
                done.greeted,
                done.admitted,
                if done.renewed {
                    ", credentials renewed"
                } else {
                    ""
                }
            );
        }
        /* ⚠️ **THE NODE IS DROPPED BEFORE THE SLEEP, NOT HELD ACROSS IT.** An
         * `Arc<Node>` held for six hours is a node that cannot be dropped for
         * six hours — the app closes, the endpoint stays bound, and the next
         * launch cannot take the port. The upgrade is per round for exactly
         * this reason. */
        drop(node);
        tokio::select! {
            () = tokio::time::sleep(ROUND_EVERY) => {}
            /* A revocation made HERE does not wait six hours to be told. */
            () = wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::circle::{known_people, set_known_people, KnownPerson, Version};
    use crate::node::testkit::TestNode;
    use crate::person;
    use crate::role::Role;

    /// What alice's file says about bob, with `devices` as his roster.
    fn knows(person: &person::PersonId, devices: &[String]) -> KnownPerson {
        KnownPerson {
            person: person.to_string(),
            display_name: "A friend".into(),
            roster: Version { epoch: 0, hlc: 0 },
            roster_hash: String::new(),
            revoked: Vec::new(),
            devices: devices.to_vec(),
        }
    }

    /// Give `node` a person identity, and tell it where `other` lives.
    fn identify(node: &TestNode) -> person::PersonId {
        let keychain = node.node.keychain();
        let root = node.node.root().to_path_buf();
        person::ensure(keychain.as_ref(), &root).unwrap().0
    }

    /// Record `other`'s addresses so a round has somewhere to dial.
    fn note_address(on: &TestNode, other: &TestNode) {
        let addrs = other
            .node
            .endpoint()
            .addr()
            .ip_addrs()
            .map(|a| a.to_string())
            .collect();
        on.node
            .peers()
            .insert(crate::peers::PeerRecord {
                id: other.node.id().to_string(),
                name: "Their laptop".into(),
                platform: String::new(),
                role: Role::Shelf,
                grants: Vec::new(),
                paired_at: 0,
                last_seen_at: 0,
                last_addrs: addrs,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn a_round_mints_this_devices_credentials_when_it_has_none() {
        /* ⚠️ **`should_renew` COULD SAY A DELEGATION WAS DUE AND NOTHING EVER
        ASKED IT.** The whole renewal path was correct and unreachable: a
        delegation expired ninety days after a reader last thought about it,
        and the only symptom was a circle that quietly stopped working. */
        let bob = TestNode::start("keep-bob", Role::Shelf).await;
        identify(&bob);
        assert!(crate::circle::read_mine(bob.node.root()).unwrap().is_none());

        let done = round(&bob.node).await;

        assert!(done.renewed, "the round minted nothing");
        let mine = crate::circle::read_mine(bob.node.root()).unwrap().unwrap();
        assert_eq!(mine.delegation.delegation.device, bob.node.id().to_string());
        bob.close().await;
    }

    #[tokio::test]
    async fn a_reader_who_has_never_shared_is_not_a_failure() {
        /* No person identity is the ORDINARY state — the laziness the whole
        custody design rests on. A round that warned about it would put a
        red mark in front of every reader who does not use the circle. */
        let bob = TestNode::start("keep-quiet", Role::Shelf).await;

        let done = round(&bob.node).await;

        assert_eq!(done, Round::default(), "nothing minted, nothing greeted");
        assert!(crate::circle::read_mine(bob.node.root()).unwrap().is_none());
        bob.close().await;
    }

    #[tokio::test]
    async fn a_round_greets_the_devices_of_people_this_reader_knows() {
        /* ⚠️ **`introduce` HAD NO CALLER.** A second device of this person
        could never be admitted by anybody in the circle without pairing with
        each of them again — which is the entire thing the roster exists to
        avoid. */
        let alice = TestNode::start("keep-alice", Role::Shelf).await;
        let bob = TestNode::start("keep-bob2", Role::Shelf).await;
        let bob_person = identify(&bob);
        let alice_person = identify(&alice);
        /* Each knows the other's PERSON, and bob knows where alice lives. */
        set_known_people(
            alice.node.root(),
            &[knows(&bob_person, &[bob.node.id().to_string()])],
        )
        .unwrap();
        set_known_people(
            bob.node.root(),
            &[knows(&alice_person, &[alice.node.id().to_string()])],
        )
        .unwrap();
        note_address(&bob, &alice);

        let done = round(&bob.node).await;

        assert_eq!(done.greeted, 1, "alice was not greeted");
        assert_eq!(done.admitted, 1, "alice did not admit bob");
        /* And the admission is real: the ordinary ALPN can be dialled now. */
        assert!(alice.node.peers().get(&bob.node.id().to_string()).is_some());
        alice.close().await;
        bob.close().await;
    }

    #[tokio::test]
    async fn a_round_carries_a_revocation_to_somebody_who_already_trusts_us() {
        /* ⚠️ **THE REASON A ROUND GREETS EVERYONE RATHER THAN ONLY STRANGERS.**
        A hello is the only thing that carries a roster, and a roster is the
        only thing that carries a revocation. Greeting only devices that do not
        yet trust us would mean a revocation never reaches the people it
        matters to — which is precisely the ones who already trust us. */
        let alice = TestNode::start("keep-alice2", Role::Shelf).await;
        let bob = TestNode::start("keep-bob3", Role::Shelf).await;
        let bob_person = identify(&bob);
        let alice_person = identify(&alice);
        let stolen = iroh::SecretKey::generate().public().to_string();

        /* Alice already knows bob AND trusts his old laptop. */
        let mut entry = knows(&bob_person, &[bob.node.id().to_string(), stolen.clone()]);
        entry.display_name = "Bob".into();
        set_known_people(alice.node.root(), &[entry]).unwrap();
        alice
            .node
            .peers()
            .insert(crate::peers::PeerRecord {
                id: stolen.clone(),
                name: "Bob's old laptop".into(),
                platform: String::new(),
                role: Role::Shelf,
                grants: Vec::new(),
                paired_at: 0,
                last_seen_at: 0,
                last_addrs: Vec::new(),
            })
            .unwrap();

        set_known_people(
            bob.node.root(),
            &[knows(&alice_person, &[alice.node.id().to_string()])],
        )
        .unwrap();
        note_address(&bob, &alice);

        /* Bob's laptop is stolen. He revokes it. */
        {
            let keychain = bob.node.keychain();
            let root = bob.node.root().to_path_buf();
            let device = bob.node.id().to_string();
            let mut mine =
                crate::circle::mine_for(keychain.as_ref(), &root, &device, crate::circle::now_ms())
                    .unwrap();
            mine.roster.roster.devices.push(stolen.clone());
            mine.roster =
                crate::circle::sign_roster(keychain.as_ref(), &root, mine.roster.roster.clone())
                    .unwrap();
            crate::circle::write_mine(&root, &mine).unwrap();
            crate::circle::revoke_device(
                keychain.as_ref(),
                &root,
                &stolen,
                crate::circle::now_ms() + 1,
            )
            .unwrap();
        }

        let done = round(&bob.node).await;

        assert_eq!(done.admitted, 1, "alice did not admit bob");
        assert!(
            alice.node.peers().get(&stolen).is_none(),
            "the revocation did not reach somebody who already trusted the device"
        );
        let stored = known_people(alice.node.root()).unwrap();
        assert!(stored[0].revoked.contains(&stolen));
        alice.close().await;
        bob.close().await;
    }

    #[tokio::test]
    async fn a_round_does_not_dial_a_device_it_has_already_revoked() {
        /* A round trip that can only be refused. Cheap here, and less cheap on
        a phone that wakes its radio for it four times a day for ever. */
        let bob = TestNode::start("keep-bob4", Role::Shelf).await;
        let alice_person = {
            let alice = TestNode::start("keep-alice3", Role::Shelf).await;
            let id = identify(&alice);
            alice.close().await;
            id
        };
        identify(&bob);
        let gone = iroh::SecretKey::generate().public().to_string();
        let mut entry = knows(&alice_person, std::slice::from_ref(&gone));
        entry.revoked.push(gone);
        set_known_people(bob.node.root(), &[entry]).unwrap();

        let done = round(&bob.node).await;

        assert_eq!(done.greeted, 0, "greeted a device it knows is finished");
        bob.close().await;
    }

    #[tokio::test]
    async fn one_unreachable_friend_does_not_stop_the_others_being_told() {
        /* ⚠️ **MOST DEVICES ARE ASLEEP MOST OF THE TIME.** Returning on the
        first failed dial would mean one offline friend stops a revocation
        reaching everybody else — and the more friends a reader has, the more
        likely that is, which is exactly backwards. */
        let alice = TestNode::start("keep-alice4", Role::Shelf).await;
        let bob = TestNode::start("keep-bob5", Role::Shelf).await;
        let bob_person = identify(&bob);
        let alice_person = identify(&alice);
        set_known_people(
            alice.node.root(),
            &[knows(&bob_person, &[bob.node.id().to_string()])],
        )
        .unwrap();

        /* An unreachable device FIRST, then alice. */
        let asleep = iroh::SecretKey::generate().public().to_string();
        set_known_people(
            bob.node.root(),
            &[knows(&alice_person, &[asleep, alice.node.id().to_string()])],
        )
        .unwrap();
        note_address(&bob, &alice);

        let done = round(&bob.node).await;

        assert_eq!(done.greeted, 2, "it stopped at the first one");
        assert_eq!(done.admitted, 1, "alice was never reached");
        alice.close().await;
        bob.close().await;
    }
}
