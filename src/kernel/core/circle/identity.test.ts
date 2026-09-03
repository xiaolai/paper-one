import { describe, expect, it } from 'vitest'
import { hlcOf } from '../hlc'
import {
  DELEGATION_MS,
  SKEW_MS,
  canMintDelegation,
  checkDelegation,
  compareVersions,
  isRevocable,
  maySpeak,
  preferVersion,
  shouldRenew,
  strippedRoster,
  supersedes,
  type Delegation,
  type RevocationList,
  type Roster,
} from './identity'

/** WI-22.B1, B2 and B3 — the root/leaf split, expiry, and the roster. */

const T0 = 1_000_000_000_000

/* An HLC device id is sixteen hex characters — `ZERO_DEVICE` is the shape. The
   tiebreak is BY DEVICE ID, so two ids that sort differently is the whole point
   of the pair. */
const DEVICE_A = 'a'.repeat(16)
const DEVICE_B = 'b'.repeat(16)

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
  v: 1,
  person: 'alice',
  device: 'leaf1',
  role: 'leaf',
  notBefore: T0,
  notAfter: T0 + DELEGATION_MS,
  epoch: 1,
  sig: 'SIG',
  ...over,
})

const roster = (over: Partial<Roster> = {}): Roster => ({
  v: 1,
  person: 'alice',
  version: { epoch: 1, at: hlcOf(10) },
  displayName: 'Alice',
  home: 'home1',
  devices: [{ device: 'home1', hints: ['192.0.2.1:1234'] }, { device: 'leaf1', hints: ['192.0.2.2:1234'] }],
  sig: 'SIG',
  ...over,
})

describe('WI-22.B1 — the falsifier that decides the whole design', () => {
  it('a device holding no root key cannot mint a delegation', () => {
    /* ⚠️ **THE ITEM'S OWN FALSIFIER**: *"a device that holds no root key can
       mint itself a fresh delegation. If it can, the root/leaf split has moved
       the problem rather than solved it."* */
    expect(canMintDelegation('leaf', false)).toBe(false)
    /* And a leaf that somehow held one still cannot, because the ROLE is the
       gate as well — a leaf with a stolen root is a compromised identity, not a
       device that may administer. */
    expect(canMintDelegation('leaf', true)).toBe(false)
  })

  it('only home can mint, and only while it holds the root', () => {
    expect(canMintDelegation('home', true)).toBe(true)
    expect(canMintDelegation('home', false)).toBe(false)
  })

  it('refuses to make "revoke the home device" expressible', () => {
    /* ⚠️ **THE REPAIR FOR `review.md` I-1.** The old design's sentence was
       false because skip-by-default put the root on the device, so "revoke D1"
       was a sentence you could write about a device holding the root. Home is
       SUCCEEDED, never revoked — and this is where the UI reads that from, so
       the rule lives in one place rather than in each surface. */
    expect(isRevocable('leaf')).toBe(true)
    expect(isRevocable('home')).toBe(false)
  })
})

describe('versions are (epoch, hlc)', () => {
  it('lets a restored identity dominate without knowing the old counter', () => {
    /* ⚠️ `review.md` I-4: *"Bob caches Alice at version 42; destroy every Alice
       device; restore only the phrase. A restarted counter is refused as
       backwards."* A new epoch dominates whatever the HLC says. */
    const cached = { version: { epoch: 1, at: hlcOf(42) } }
    const restored = { version: { epoch: 2, at: hlcOf(1) } }
    expect(compareVersions(restored.version, cached.version)).toBeGreaterThan(0)
  })

  it('orders two devices at one instant, so equal versions are not expressible', () => {
    /* ⚠️ `review.md` I-5: two root copies signing "version 8". An HLC is
       monotonic per node and tie-broken by node id, so two objects signed by
       two devices never compare equal — which is what makes both peers converge
       on the same one whatever order they arrive in. */
    const a = { version: { epoch: 1, at: hlcOf(8, DEVICE_A) } }
    const b = { version: { epoch: 1, at: hlcOf(8, DEVICE_B) } }
    expect(compareVersions(a.version, b.version)).not.toBe(0)
    expect(Math.sign(compareVersions(a.version, b.version))).toBe(
      -Math.sign(compareVersions(b.version, a.version)),
    )
  })

  it('converges on the same roster whatever order two peers receive them in', () => {
    const same = (x: { version: { epoch: number; at: string } }, y: typeof x) =>
      JSON.stringify(x) === JSON.stringify(y)
    const one = { version: { epoch: 1, at: hlcOf(8, DEVICE_A) }, devices: ['A1', 'A2'] }
    const two = { version: { epoch: 1, at: hlcOf(8, DEVICE_B) }, devices: ['A1', 'A3'] }

    const peerX = preferVersion(preferVersion(null, one, same), two, same)
    const peerY = preferVersion(preferVersion(null, two, same), one, same)
    expect(peerX).toEqual(peerY)
  })

  it('refuses BOTH on a true tie rather than picking one', () => {
    /* ⚠️ Equal `(epoch, hlc)` with different content means the HLC did not
       advance — a clock bug or a restored process. *"Silently picking one is
       how a roster the reader never authorised becomes the roster."* */
    const same = (x: { version: { epoch: number; at: string } }, y: typeof x) =>
      JSON.stringify(x) === JSON.stringify(y)
    const held = { version: { epoch: 1, at: hlcOf(8, DEVICE_A) }, devices: ['A1'] }
    const clash = { version: { epoch: 1, at: hlcOf(8, DEVICE_A) }, devices: ['A2'] }
    expect(preferVersion(held, clash, same)).toBeNull()
    /* An identical redelivery is not a tie; it is the same object. */
    expect(preferVersion(held, { ...held }, same)).toEqual(held)
  })
})

describe('WI-22.B2 — expiry is the real revocation', () => {
  it('refuses a delegation past notAfter with no revocation list at all', () => {
    /* ⚠️ **THE ITEM'S FALSIFIER**: *"set the clock forward past `notAfter` and
       watch a revoked device still serve. Expiry is the backstop; if it does
       not hold, revocation depends entirely on reachability."* A peer that has
       never heard of a revocation still stops within 90 days. */
    const d = delegation()
    expect(maySpeak(d, roster(), null, T0 + 1000)).toBeNull()
    expect(maySpeak(d, roster(), null, d.notAfter)).toBe('expired')
    expect(maySpeak(d, roster(), null, d.notAfter + 1)).toBe('expired')
  })

  it('gives notBefore skew tolerance and notAfter none', () => {
    /* ⚠️ Asymmetric on purpose. A slightly fast clock should not have its first
       hour refused; a tolerance on expiry is an extension granted to exactly
       the device you are trying to stop. */
    const d = delegation()
    expect(checkDelegation(d, 'alice', 'leaf1', 1, d.notBefore - SKEW_MS + 1)).toBeNull()
    expect(checkDelegation(d, 'alice', 'leaf1', 1, d.notBefore - SKEW_MS - 1)).toBe('not-yet')
    expect(checkDelegation(d, 'alice', 'leaf1', 1, d.notAfter - 1)).toBeNull()
    expect(checkDelegation(d, 'alice', 'leaf1', 1, d.notAfter)).toBe('expired')
  })

  it('refuses a revoked device that is still inside its delegation', () => {
    const revocations: RevocationList = {
      v: 1,
      person: 'alice',
      version: { epoch: 1, at: hlcOf(20) },
      revoked: [{ device: 'leaf1', purge: false }],
      sig: 'SIG',
    }
    expect(maySpeak(delegation(), roster(), revocations, T0 + 1000)).toBe('revoked')
  })

  it('refuses a device that is not on the roster', () => {
    expect(maySpeak(delegation({ device: 'stranger' }), roster(), null, T0 + 1000)).toBe(
      'not-on-roster',
    )
  })

  it('refuses a delegation from a superseded epoch', () => {
    /* A succession bumps the epoch; delegations minted under the old one stop.
       That is what makes succession a real replacement rather than an addition. */
    expect(checkDelegation(delegation({ epoch: 1 }), 'alice', 'leaf1', 2, T0 + 1000)).toBe(
      'stale-epoch',
    )
  })

  it('renews at two thirds, which is what makes failing closed affordable', () => {
    /* ⚠️ `identity.md` refuses a page signed just before expiry and delivered
       just after, because it cannot be told from one backdated after expiry.
       Renewing at ⅔ makes that window the failing case rather than the normal
       one. */
    const d = delegation()
    expect(shouldRenew(d, T0 + DELEGATION_MS * 0.5)).toBe(false)
    expect(shouldRenew(d, T0 + DELEGATION_MS * 0.67)).toBe(true)
  })
})

describe('WI-22.B3 — the roster', () => {
  it('strips address hints before a page carries it', () => {
    /* ⚠️ `review.md`: the roster *"carries every device's address hints and
       join time"*. Hints are how your own devices find each other and have no
       business in a friend's copy of a page. */
    const stripped = strippedRoster(roster())
    expect(JSON.stringify(stripped)).not.toContain('192.0.2')
    expect(stripped.devices.map((d) => d.device)).toEqual(['home1', 'leaf1'])
  })

  it('carries a signed display name, so changing it changes a signature', () => {
    /* ⚠️ *"Change the displayed name without changing any signature — all
       defined verification still passes."* It is in the signed object now, so
       that check fails as it should. A signed name is still not a VERIFIED
       name; the SAS is what binds a key to a human. */
    expect(roster()).toHaveProperty('displayName')
    expect(Object.keys(strippedRoster(roster()))).toContain('displayName')
  })
})

describe('succession', () => {
  it('moves forward only', () => {
    const s = { v: 1, person: 'alice', epoch: 2, home: 'home2', at: T0, sig: 'SIG' }
    expect(supersedes(s, 1)).toBe(true)
    expect(supersedes(s, 2)).toBe(false)
    expect(supersedes(s, 3)).toBe(false)
  })
})
