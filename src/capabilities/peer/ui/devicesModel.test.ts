import { describe, expect, it, vi } from 'vitest'
import { fakeWire, linkWires } from '../lib/fakeWire.testkit'
import { createPeerPort } from '../lib/port'
import {
  READ_ONLY_GRANTS,
  ROLE_CHOICES,
  canJoinWithCode,
  canOfferInvite,
  grantsAreEnforceable,
  peerCanWrite,
  roleIsSettable,
  OWN_DEVICE_GRANTS,
  createDevicesModel,
  describeGrants,
  describeReach,
  describeRole,
  shelfNameOf,
  inlineQrSvg,
  pairingFault,
  grantsForWrite,
} from './devicesModel'

/**
 * WI-C.5 — the Devices section's logic, with no React: pairing from both
 * ends over the fake wire, the pending confirmation, the persisted
 * local-only preference, and the honest unavailable state.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the devices model', () => {
  it('is honestly unavailable with no port', () => {
    const model = createDevicesModel({ port: null })
    expect(model.getSnapshot().available).toBe(false)
  })

  it('pairs two devices end to end: QR offer, code, pending, confirm, peers listed', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-dev' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-dev' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire) })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire) })

    await shelf.beginPairing('My Mac')
    const offer = shelf.getSnapshot().offer
    expect(offer).not.toBeNull()
    /* INLINE, not a data URI: the theme has to reach the modules, and a data
       URI is opaque to CSS. See `inlineQrSvg`. */
    expect(inlineQrSvg(offer!.svg)).toMatch(/^<svg/)

    await satchel.pairWithCode(offer!.url)
    expect(satchel.getSnapshot().sas).not.toBeNull()
    await tick()
    const pending = shelf.getSnapshot().pending
    expect(pending?.id).toBe('satchel-dev')

    await shelf.confirmPairing(true)
    await tick()
    await tick()
    expect(shelf.getSnapshot().pending).toBeNull()
    expect(shelf.getSnapshot().peers.map((p) => p.id)).toEqual(['satchel-dev'])
    expect(shelf.getSnapshot().peers[0]?.grants).toEqual([...OWN_DEVICE_GRANTS])
    await satchel.refresh()
    expect(satchel.getSnapshot().peers.map((p) => p.id)).toEqual(['shelf-dev'])
    expect(satchel.getSnapshot().lastResult?.ok).toBe(true)
  })

  it('a refusal persists nothing and says so', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-dev2' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-dev2' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire) })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire) })
    await shelf.beginPairing()
    await satchel.pairWithCode(shelf.getSnapshot().offer!.url)
    await tick()
    await shelf.confirmPairing(false)
    await tick()
    await tick()
    expect(shelf.getSnapshot().peers).toEqual([])
    await satchel.refresh()
    expect(satchel.getSnapshot().peers).toEqual([])
    expect(satchel.getSnapshot().lastResult?.ok).toBe(false)
  })

  it('a bad code surfaces as an error, not a throw', async () => {
    const wire = fakeWire({ role: 'satchel', endpointId: 'satchel-dev3' })
    const model = createDevicesModel({ port: createPeerPort(wire) })
    await model.pairWithCode('not-a-code')
    expect(model.getSnapshot().error).toMatch(/not a pairing URI/)
  })

  it('offers no control this app cannot honour', () => {
    /* "Local network only" used to live here: a checkbox whose setting was
       stored and read by nothing, while every sync still crossed n0's relays.
       This test asserted the persistence and so PASSED for a control that did
       not work — the shape of test that makes a dead feature look alive. It
       comes back with the mobile transport work, which is where the iOS mDNS
       question that blocks it gets answered. */
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-dev4' })
    const model = createDevicesModel({ port: createPeerPort(wire) })
    expect('localOnly' in model.getSnapshot()).toBe(false)
    expect('setLocalOnly' in model).toBe(false)
  })
})

/**
 * THE WORDS THE PANE PUTS ON SCREEN.
 *
 * Not decoration: each of these replaced a protocol term the reader was being
 * asked to understand, and two of them replaced a term the reader could not act
 * on at all. They are pure functions so the sentences are reviewable without a
 * DOM, which is the same reason every other decision in this file lives here.
 */
describe('what the pane says about a device', () => {
  it('says what a role DOES, because the word alone does not tell a reader', () => {
    /* "Shelf" and "satchel" are the protocol's words, not the reader's. This
       used to add that the role could not be changed at all — true when
       `role.rs` fixed it at build time with only a debug `PAPER_ROLE`
       override, and false since a desktop can be asked. What survives is the
       reason the sentence exists: the reader picks by what a device DOES. */
    expect(describeRole('shelf')).toBe('Holds your library')
    expect(describeRole('satchel')).toBe('Reads from your library')
    expect(describeRole(null)).toBe('…')
  })

  it('names a stored pairing that cannot work, which the handshake cannot catch', () => {
    /* NOT AT PAIRING TIME. `pairing.rs` refuses a dialler whose hello is not
       a satchel ("role-mismatch"), so two shelves cannot COMPLETE a
       handshake. What it cannot see is a pairing that becomes same-role
       AFTERWARDS — which the reader-settable role now makes reachable, and is
       why `setRole` refuses while peers exist. Both sides then hold a record,
       both report ready, and no session ever
       symptom was a menu with no Download in it. */
    expect(pairingFault('shelf', 'shelf')).toMatch(/nothing will sync/)
    expect(pairingFault('satchel', 'satchel')).toMatch(/nothing to sync from/)
  })

  it('stays quiet about a pairing that can work, and about one it cannot judge', () => {
    expect(pairingFault('shelf', 'satchel')).toBeNull()
    expect(pairingFault('satchel', 'shelf')).toBeNull()
    expect(pairingFault(null, 'shelf')).toBeNull()
    expect(pairingFault('shelf', null)).toBeNull()
  })

  it('describes grants as artifacts, and reads a wildcard as covering its family', () => {
    expect(describeGrants(['sync:*', 'blob:*'])).toBe(
      'Books, highlights, reading position and book files — both ways',
    )
    expect(describeGrants(['sync:pull'])).toBe(
      'Books, highlights, reading position — receive only',
    )
  })

  it('does NOT split what the protocol cannot split', () => {
    /* `sync.pull`, `sync.marks` and `sync.content` all require `sync:pull`
       (`protocol.ts`), so "highlights but not books" is not expressible today.
       One phrase covering all of it is the honest rendering; a list of toggles
       would promise granularity the grant does not have. */
    expect(describeGrants(['sync:pull'])).not.toMatch(/highlights only|books only/)
  })

  it('falls back to the raw grant rather than inventing a reassuring phrase', () => {
    expect(describeGrants([])).toBe('Nothing yet')
    expect(describeGrants(['future:thing'])).toBe('future:thing')
  })
})

describe('the QR the plugin hands over', () => {
  it('drops the XML prolog, which HTML does not allow', () => {
    /* The `qrcode` crate emits one. Inline, the parser treats it as a bogus
       comment and leaves a stray node as the figure's first child. */
    expect(inlineQrSvg('<?xml version="1.0" standalone="yes"?>\n<svg><path/></svg>')).toBe(
      '<svg><path/></svg>',
    )
  })

  it('leaves an SVG that has none alone', () => {
    expect(inlineQrSvg('<svg><path/></svg>')).toBe('<svg><path/></svg>')
  })
})

/**
 * THE CHOICE THE READER MAKES BEFORE PAIRING.
 *
 * Role is a DEVICE property, not a relationship one: `sync/index.ts` binds it
 * once at start, a shelf "answers satchels; it does not dial them", and a
 * satchel resolves `shelfPeer()` as the single peer with role shelf. So it
 * cannot emerge from a pairing and cannot differ per peer — it has to be
 * settled first, which is what these guard.
 */
describe('where the reader says their books live', () => {
  it('offers both sides, in words the protocol does not use', () => {
    expect(ROLE_CHOICES.map((c) => c.role)).toEqual(['shelf', 'satchel'])
    for (const choice of ROLE_CHOICES) {
      /* "shelf" and "satchel" on screen were the confusing thing. The label is
         a fact about the reader's books; the role is what it means. */
      expect(`${choice.label} ${choice.detail}`.toLowerCase()).not.toMatch(/shelf|satchel/)
    }
  })

  it('is answerable only while nothing is paired', () => {
    /* Switching afterwards means reconciling a whole library against a
       metadata-only one, in both directions. That is a migration. */
    expect(roleIsSettable([])).toBe(true)
    expect(roleIsSettable([{ id: 'a' } as never])).toBe(false)
  })

  it('records the answer without claiming the running node changed', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'role-choice-dev' })
    const model = createDevicesModel({ port: createPeerPort(wire) })
    await model.refresh()
    expect(model.getSnapshot().roleNeedsRestart).toBe(false)

    await model.setRole('satchel')
    /* THE FLAG MOVES AND THE ROLE DOES NOT. `role.rs` is read when the node
       starts; publishing the new role here would put a sentence on screen that
       the next refresh would quietly contradict. */
    expect(model.getSnapshot().roleNeedsRestart).toBe(true)
    model.dispose()
  })
})

/**
 * A PAIRED DEVICE THAT MAY READ AND NOT WRITE.
 *
 * The protocol has always allowed it — `sync:pull` and `sync:push` are
 * separate grants and `blobs.rs` enforces `blob:read` on its own — and nothing
 * ever offered it: pairing wrote one wildcard pair and `peer_set_grants` was
 * called by nobody. These pin the narrowed set against the services it has to
 * keep working, because the failure mode is silent and remote.
 */
describe('restricting a paired device to reading', () => {
  it('keeps every service a reader still needs', () => {
    /* `sync.hello`, `sync.pull`, `sync.marks` and `sync.content` all take
       `sync:pull`; the byte path takes `blob:read`. Drop either entry and the
       device either cannot sync at all or cannot open a book. */
    expect(READ_ONLY_GRANTS).toContain('sync:pull')
    expect(READ_ONLY_GRANTS).toContain('blob:read')
  })

  it('withholds exactly the grant that admits a change', () => {
    expect(READ_ONLY_GRANTS).not.toContain('sync:push')
    expect(READ_ONLY_GRANTS.some((g) => g.endsWith(':*'))).toBe(false)
  })

  it('reads write-ness off the grant that decides it, not off the list shape', () => {
    expect(peerCanWrite(OWN_DEVICE_GRANTS)).toBe(true)
    expect(peerCanWrite(['sync:push'])).toBe(true)
    expect(peerCanWrite(READ_ONLY_GRANTS)).toBe(false)
    expect(peerCanWrite([])).toBe(false)
  })

  it('is offered only where the grant is actually checked', () => {
    /* Grants are checked by the side being CALLED, and a shelf answers
       satchels rather than dialling them — so a satchel's record of its shelf
       is never consulted and a switch there would do nothing. */
    expect(grantsAreEnforceable('shelf')).toBe(true)
    expect(grantsAreEnforceable('satchel')).toBe(false)
    expect(grantsAreEnforceable(null)).toBe(false)
  })

  it('writes the narrowed set through to the peer record', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'grant-shelf' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'grant-satchel' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire) })

    await shelf.beginPairing('Shelf')
    const offer = shelf.getSnapshot().offer!
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire) })
    await satchel.pairWithCode(offer.url)
    await tick()
    await shelf.confirmPairing(true)
    await tick()
    await shelf.refresh()

    const paired = shelf.getSnapshot().peers[0]!
    expect(peerCanWrite(paired.grants)).toBe(true)

    await shelf.setPeerCanWrite(paired.id, false)
    expect(peerCanWrite(shelf.getSnapshot().peers[0]!.grants)).toBe(false)

    await shelf.setPeerCanWrite(paired.id, true)
    expect(peerCanWrite(shelf.getSnapshot().peers[0]!.grants)).toBe(true)

    shelf.dispose()
    satchel.dispose()
  })
})

/**
 * PAIRING HAS A DIRECTION, and both halves were offered to both roles.
 *
 * Neither was merely redundant — Rust refuses each by name. `pairing.rs:426`
 * makes `begin()` a `RoleMismatch` on a satchel; `pairing.rs:545` makes the
 * far shelf refuse a hello whose role is not satchel. So each role was shown
 * one control that could only ever fail.
 */
describe('which half of pairing a device may do', () => {
  it('lets the library invite, and only the library', () => {
    /* The invite carries the OFFERER's endpoint, addresses and relay, and the
       joiner dials it — so the side being dialled has to be the always-on one. */
    expect(canOfferInvite('shelf')).toBe(true)
    expect(canOfferInvite('satchel')).toBe(false)
  })

  it('lets the reader join, and only the reader', () => {
    expect(canJoinWithCode('satchel')).toBe(true)
    expect(canJoinWithCode('shelf')).toBe(false)
  })

  it('offers neither before the role is known', () => {
    /* The pane renders during the first refresh. Showing both and retracting
       one is worse than showing neither for a frame. */
    expect(canOfferInvite(null)).toBe(false)
    expect(canJoinWithCode(null)).toBe(false)
  })

  it('never offers both to one device', () => {
    for (const role of ['shelf', 'satchel', null] as const) {
      expect(canOfferInvite(role) && canJoinWithCode(role)).toBe(false)
    }
  })
})

describe('what the write toggle is allowed to change', () => {
  /* It used to REPLACE the whole grant list, which was wrong in both
     directions: a peer holding anything this pane does not model — say
     `shelf:admin`, the one grant that can empty a trash — lost it to a toggle
     about writing; and a peer holding NO sync grants would have been GRANTED
     read access by the control whose only stated purpose is removing access. */

  it('adds write without disturbing a grant it does not own', () => {
    expect(grantsForWrite(['shelf:admin', 'sync:pull', 'blob:read'], true)).toEqual([
      'shelf:admin',
      ...OWN_DEVICE_GRANTS,
    ])
  })

  it('removes write without disturbing a grant it does not own', () => {
    expect(grantsForWrite(['shelf:admin', 'sync:*', 'blob:*'], false)).toEqual([
      'shelf:admin',
      ...READ_ONLY_GRANTS,
    ])
  })

  it('never grants read to a peer that held nothing', () => {
    /* The direction a permission must never move on its own. */
    expect(grantsForWrite([], false)).toEqual([])
    expect(grantsForWrite(['shelf:admin'], false)).toEqual(['shelf:admin'])
  })

  it('still grants write to a peer that held nothing, because that is the ask', () => {
    expect(grantsForWrite([], true)).toEqual([...OWN_DEVICE_GRANTS])
  })

  it('replaces the sync family rather than accumulating it', () => {
    /* Toggling twice must not leave both sets on the peer. */
    const on = grantsForWrite(['sync:pull', 'blob:read'], true)
    expect(grantsForWrite(on, false)).toEqual([...READ_ONLY_GRANTS])
  })
})

describe('the role control, and what it refuses', () => {
  /* The pane hides this control on a paired device, but hiding is not
     enforcing: the model is reachable, the write is durable, and a device
     that changes sides while paired leaves the pair with no shelf or two. */

  it('refuses before the peer list has been read', async () => {
    /* THE TRAP. An empty list before the first refresh looks exactly like a
       device with no peers, and `roleIsSettable` reads emptiness as safe —
       so the control was live in the gap, on a device that may be paired. */
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-r1' })
    const model = createDevicesModel({ port: createPeerPort(wire) })
    expect(model.getSnapshot().peersLoaded).toBe(false)
    await model.setRole('satchel')
    expect(wire.pendingRole, 'the plugin was never asked').toBeNull()
    expect(model.getSnapshot().roleNeedsRestart).toBe(false)
  })

  it('refuses once the device is actually paired', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-r3' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-r3' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire) })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire) })
    await shelf.beginPairing('My Mac')
    await satchel.pairWithCode(shelf.getSnapshot().offer!.url)
    await tick()
    await shelf.confirmPairing(true)
    await tick()
    await tick()
    expect(shelf.getSnapshot().peers.length).toBe(1)

    await shelf.setRole('satchel')
    expect(shelfWire.pendingRole, 'a paired device may not change sides').toBeNull()
  })

  it('refuses while the joiner is showing its SAS', async () => {
    /* THE THIRD WINDOW, which the guard NAMED and did not test. A satchel
       that has pasted a code holds no offer and no pending confirmation —
       only a SAS — and its peer list is still empty until the far shelf
       confirms, so `roleIsSettable` says yes and the control is on screen.
       Changing sides there and letting the confirmation land afterwards is
       exactly the durable two-shelf pair this guard exists to refuse. */
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-sas' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-sas' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire) })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire) })
    await satchel.refresh()
    await shelf.beginPairing('My Mac')
    await satchel.pairWithCode(shelf.getSnapshot().offer!.url)
    expect(satchel.getSnapshot().sas, 'the code the human is reading out').not.toBeNull()
    expect(satchel.getSnapshot().offer, 'the joiner holds no offer').toBeNull()
    expect(satchel.getSnapshot().pending, 'and nothing pending its confirmation').toBeNull()
    expect(satchel.getSnapshot().peers, 'no record until the shelf confirms').toEqual([])

    await satchel.setRole('shelf')
    expect(satchelWire.pendingRole, 'the plugin was never asked').toBeNull()
    expect(satchel.getSnapshot().roleNeedsRestart).toBe(false)
    /* AND IT DOES NOT NAME A BUTTON THIS SIDE HAS NOT GOT. Cancel is drawn
       inside the invite, which the joiner does not hold; waiting is what it
       does, and the shelf's answer or the attempt's timeout ends the wait. */
    expect(satchel.getSnapshot().error).toMatch(/Wait for the other device/)
    expect(satchel.getSnapshot().error).not.toMatch(/cancel/)
  })

  it('reports the role the node is RUNNING, not the one just chosen', async () => {
    /* The plugin stores the choice for the next launch. The fake used to
       apply it at once, so this exact assertion would have PASSED against a
       live switch the real one does not perform — a fake refuting the thing
       it stands in for. */
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-r4' })
    const model = createDevicesModel({ port: createPeerPort(wire) })
    await model.refresh()
    await model.setRole('satchel')
    await model.refresh()
    expect(model.getSnapshot().role, 'still the running role').toBe('shelf')
    expect(model.getSnapshot().roleNeedsRestart).toBe(true)

    wire.restart()
    await model.refresh()
    expect(model.getSnapshot().role, 'and now it is in force').toBe('satchel')
  })

  it('says a restart is needed only when the role actually changed', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-r2' })
    const model = createDevicesModel({ port: createPeerPort(wire) })
    await model.refresh()
    await model.setRole('shelf')
    expect(model.getSnapshot().roleNeedsRestart, 'chose what is already running').toBe(false)
    await model.setRole('satchel')
    expect(model.getSnapshot().roleNeedsRestart, 'chose the other side').toBe(true)
  })
})

describe('beginning a pairing while one is being confirmed', () => {
  it('leaves the confirmation the human is reading a SAS for', async () => {
    /* `pairBegin` REPLACES the attempt the backend holds, so testing `pending`
       only around the PUBLISH destroyed the confirmation in progress and then
       declined to show the new offer — losing both, with the pane still
       displaying a SAS that no longer matched anything. */
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-guard' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-guard' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire) })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire) })

    await shelf.beginPairing('My Mac')
    await satchel.pairWithCode(shelf.getSnapshot().offer!.url)
    await tick()
    const pending = shelf.getSnapshot().pending
    expect(pending?.id, 'a confirmation is in progress').toBe('satchel-guard')

    await shelf.beginPairing('My Mac')
    await tick()
    expect(shelf.getSnapshot().pending, 'it survived the second begin').toEqual(pending)

    /* And the confirmation still completes, which is the part that was
       actually broken: the attempt behind the SAS was still there. */
    await shelf.confirmPairing(true)
    await tick()
    await tick()
    expect(shelf.getSnapshot().peers.map((one) => one.id)).toEqual(['satchel-guard'])
  })
})

describe('an invite that has run out', () => {
  it('leaves the pane rather than staying copyable for ever', async () => {
    /* `expiresAt` was carried into the snapshot and read by nothing, so a QR
       and its copy button sat there indefinitely — and the obvious thing to
       do with a stale pane, copy the code and send it, produced a refusal on
       the other device with nothing here suggesting why. */
    vi.useFakeTimers()
    try {
      const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-exp' })
      const model = createDevicesModel({ port: createPeerPort(wire) })
      await model.beginPairing('My Mac')
      const offer = model.getSnapshot().offer
      expect(offer, 'an invite was minted').not.toBeNull()

      vi.advanceTimersByTime(offer!.expiresAt - Date.now() - 1)
      expect(model.getSnapshot().offer, 'still valid a millisecond before').not.toBeNull()

      vi.advanceTimersByTime(2)
      expect(model.getSnapshot().offer, 'gone once the attempt expired').toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops its timer on dispose, so nothing publishes into a dead model', async () => {
    vi.useFakeTimers()
    try {
      const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-exp2' })
      const model = createDevicesModel({ port: createPeerPort(wire) })
      await model.beginPairing('My Mac')
      const seen: number[] = []
      model.subscribe(() => seen.push(1))
      model.dispose()
      vi.advanceTimersByTime(10 * 60_000)
      expect(seen).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * WI-20.25 — the pane said "on your Mac" to every device: to the phone whose
 * library lives on a Linux desktop, and to the desktop itself. The sentence
 * now follows the role, and names the shelf by its pairing name.
 */
describe('where Paper has to be running', () => {
  const peer = (role: 'shelf' | 'satchel', name: string) => ({
    id: `${role}-x`,
    name,
    platform: 'macos',
    role,
    grants: [] as string[],
    pairedAt: 1,
    lastSeenAt: 1,
    lastAddrs: [] as string[],
  })

  it('names the shelf by its pairing name for a satchel', () => {
    const line = describeReach('satchel', shelfNameOf([peer('shelf', 'Study iMac')]))
    expect(line).toContain('Study iMac')
    expect(line).not.toMatch(/\bMac\b/)
  })

  it('says "the device that holds your library" for a satchel that is not paired yet', () => {
    expect(shelfNameOf([])).toBeNull()
    expect(shelfNameOf([peer('satchel', 'Phone')])).toBeNull()
    expect(describeReach('satchel', null)).toContain('the device that holds your library')
  })

  it('tells a shelf it is itself, and never guesses the hardware', () => {
    for (const role of ['shelf', null] as const) {
      const line = describeReach(role, null)
      expect(line).toContain('this device')
      expect(line).not.toMatch(/\bMac\b/)
    }
  })
})

describe('audit-fix round 1 — the devices model', () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('turning write off never adds a family the peer did not hold', () => {
    /* `sync:push` alone used to become `sync:pull` + `blob:read`; `blob:read`
       alone gained `sync:pull`. Each grant is demoted on its own. */
    expect(grantsForWrite(['sync:push'], false)).toEqual([])
    expect(grantsForWrite(['blob:read'], false)).toEqual(['blob:read'])
    expect(grantsForWrite(['sync:pull', 'sync:push'], false)).toEqual(['sync:pull'])
    expect(grantsForWrite(['blob:*'], false)).toEqual(['blob:read'])
  })

  it('names a grant it does not know beside the phrase for the ones it does', () => {
    expect(describeGrants(['sync:pull', 'shelf:admin'])).toBe('Books, highlights, reading position — receive only, plus shelf:admin')
    expect(describeGrants(['sync:pull'])).toBe('Books, highlights, reading position — receive only')
  })

  it('refuses to pair while a role change is waiting for a restart', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-restart' })
    const model = createDevicesModel({ port: createPeerPort(wire) })
    await model.refresh()
    await model.setRole('satchel')
    expect(model.getSnapshot().roleNeedsRestart).toBe(true)
    await model.beginPairing('Mine')
    expect(model.getSnapshot().offer).toBeNull()
    expect(model.getSnapshot().error).toMatch(/Restart Paper/)
    await model.pairWithCode('paper://pair/anything')
    expect(model.getSnapshot().sas).toBeNull()
    expect(model.getSnapshot().error).toMatch(/Restart Paper/)
  })

  it('refuses a role change while a pairing is in flight', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-offer' })
    const model = createDevicesModel({ port: createPeerPort(wire) })
    await model.refresh()
    await model.beginPairing('Mine')
    expect(model.getSnapshot().offer).not.toBeNull()
    await model.setRole('satchel')
    expect(model.getSnapshot().roleNeedsRestart).toBe(false)
    expect(model.getSnapshot().error).toMatch(/pairing in progress/)
  })

  it('does no IPC and publishes nothing after disposal', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-dead' })
    const port = createPeerPort(wire)
    const status = vi.spyOn(port, 'status')
    const model = createDevicesModel({ port })
    model.dispose()
    await model.refresh()
    expect(status).not.toHaveBeenCalled()
  })

  it('serialises grant edits for one peer, so the last toggle is what stands', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-g' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-g' })
    linkWires(shelfWire, satchelWire)
    /* THE FIRST WRITE IS THE SLOW ONE. Unserialised, both toggles read the
       same old list, the fast second write lands, then the slow first write
       lands LAST and carries the intent the reader had already reversed. */
    const raw = createPeerPort(shelfWire)
    let writes = 0
    const port: typeof raw = {
      ...raw,
      setGrants: async (id, grants) => {
        writes += 1
        if (writes % 2 === 1) await new Promise<void>((resolve) => setTimeout(resolve, 15))
        return raw.setGrants(id, grants)
      },
    }
    const shelf = createDevicesModel({ port })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire) })
    await shelf.beginPairing('Shelf')
    await satchel.pairWithCode(shelf.getSnapshot().offer!.url)
    await tick()
    await shelf.confirmPairing(true)
    await tick()
    await tick()
    const paired = shelf.getSnapshot().peers[0]!
    /* Two toggles, not awaited between: off then on. Unserialised, both read
       the same old list and the earlier intent could land last. */
    const off = shelf.setPeerCanWrite(paired.id, false)
    const on = shelf.setPeerCanWrite(paired.id, true)
    await Promise.all([off, on])
    expect(peerCanWrite(shelf.getSnapshot().peers[0]!.grants)).toBe(true)
    const off2 = shelf.setPeerCanWrite(paired.id, true)
    const on2 = shelf.setPeerCanWrite(paired.id, false)
    await Promise.all([off2, on2])
    expect(peerCanWrite(shelf.getSnapshot().peers[0]!.grants)).toBe(false)
  })
})
