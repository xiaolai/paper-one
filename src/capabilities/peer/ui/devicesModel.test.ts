import { describe, expect, it } from 'vitest'
import { createKernelServices } from '../../../kernel'
import { fakeWire, linkWires } from '../lib/fakeWire.testkit'
import { createPeerPort } from '../lib/port'
import {
  LOCAL_ONLY_SETTING,
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
  describeRole,
  inlineQrSvg,
  pairingFault,
} from './devicesModel'

/**
 * WI-C.5 — the Devices section's logic, with no React: pairing from both
 * ends over the fake wire, the pending confirmation, the persisted
 * local-only preference, and the honest unavailable state.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function settingsOnly() {
  const map = new Map<string, string>()
  return createKernelServices({
    fs: null,
    storage: { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) },
  }).settings
}

describe('the devices model', () => {
  it('is honestly unavailable with no port', () => {
    const model = createDevicesModel({ port: null, settings: settingsOnly() })
    expect(model.getSnapshot().available).toBe(false)
  })

  it('pairs two devices end to end: QR offer, code, pending, confirm, peers listed', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-dev' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-dev' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire), settings: settingsOnly() })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire), settings: settingsOnly() })

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
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire), settings: settingsOnly() })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire), settings: settingsOnly() })
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
    const model = createDevicesModel({ port: createPeerPort(wire), settings: settingsOnly() })
    await model.pairWithCode('not-a-code')
    expect(model.getSnapshot().error).toMatch(/not a pairing URI/)
  })

  it('local-only is persisted under its settings key', () => {
    const settings = settingsOnly()
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-dev4' })
    const model = createDevicesModel({ port: createPeerPort(wire), settings })
    expect(model.getSnapshot().localOnly).toBe(false)
    model.setLocalOnly(true)
    expect(model.getSnapshot().localOnly).toBe(true)
    expect(settings.get(LOCAL_ONLY_SETTING)).toBe(true)
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
  it('says what a role DOES, because the reader cannot change what it IS', () => {
    /* `role.rs` fixes this at build time and the `PAPER_ROLE` override is
       debug-only, so "shelf" on screen named a choice nobody can make. */
    expect(describeRole('shelf')).toBe('Holds your library')
    expect(describeRole('satchel')).toBe('Reads from your library')
    expect(describeRole(null)).toBe('…')
  })

  it('names the pairing that cannot work, since the protocol will not refuse it', () => {
    /* Two desktops is the DEFAULT outcome — a desktop build is a shelf — and
       both sides record the pairing, both report ready, and no session ever
       opens. Measured: paired, mutual, silent for 34 hours, and the only
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
    const model = createDevicesModel({ port: createPeerPort(wire), settings: settingsOnly() })
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
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire), settings: settingsOnly() })

    await shelf.beginPairing('Shelf')
    const offer = shelf.getSnapshot().offer!
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire), settings: settingsOnly() })
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
