import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  fold,
  makeHlc,
  signedBytes,
  type Entry,
  type Page,
  type WorkClaim,
} from '../../../kernel'
import { pageCrypto } from './crypto'
import {
  applyEntries,
  delegationBytes,
  readDelegation,
  takePages,
  type Ledger,
  type SignedDelegation,
} from './receive'
import { NOTHING_SHARED, type ForeignFile } from './store'

hashes.sha512 = sha512

/**
 * Taking a page, with the real crypto on both sides.
 *
 * ⚠️ **EVERY REFUSAL HERE IS REACHED BY SIGNING SOMETHING AND THEN BREAKING
 * IT**, not by handing the checker a stub that says no. `page.test.ts` proves
 * the ORDER of the checks against a fake `PageCrypto`; this proves the checks
 * decide anything at all.
 */

const NOW = 1_700_000_000_000
const WORK: WorkClaim = { ids: ['w1'], titles: ['t1'], author: 'a1', language: 'en' }

/** A device or person keypair, as hex. */
function keypair(seed: string) {
  const secret = utf8ToBytes(seed.padEnd(32, '.')).slice(0, 32)
  return { secret, id: bytesToHex(getPublicKey(secret)) }
}

const PERSON = keypair('person')
const DEVICE = keypair('device')
const OTHER_DEVICE = keypair('other-device')

const signWith = (secret: Uint8Array, message: string) =>
  bytesToHex(sign(utf8ToBytes(message), secret))

/** A delegation the PERSON really signed, in the shape `person.rs` emits. */
function delegation(over: Partial<SignedDelegation> = {}): string {
  const body: Omit<SignedDelegation, 'sig'> = {
    person: PERSON.id,
    device: DEVICE.id,
    notBefore: NOW - 1_000,
    notAfter: NOW + 1_000_000,
    roster: 0,
    ...over,
  }
  const sig = over.sig ?? signWith(PERSON.secret, delegationBytes({ ...body, sig: '' }))
  /* Canonical, because `readDelegation` requires the bytes it verifies to be
     the bytes that arrived — the same rule a page is held to. */
  return canonicalJson({ ...body, sig })
}

/** A page the DEVICE really signed. */
function page(over: Partial<Page> = {}, secret: Uint8Array = DEVICE.secret): string {
  const body: Omit<Page, 'sig'> = {
    v: 1,
    person: PERSON.id,
    work: WORK,
    device: DEVICE.id,
    from: 1,
    to: 1,
    prevPageHash: '',
    entries: [],
    roster: [DEVICE.id],
    revocations: 0,
    delegation: delegation(),
    ...over,
  }
  const sig = over.sig ?? signWith(secret, signedBytes('page', body.v, { ...body, sig: '' }))
  return canonicalJson({ ...body, sig })
}

/* A real stamp, not a cast: `Hlc` is a branded STRING, and casting an object
   into it made `fold`'s tie-break compare things that are not stamps.
   ⚠️ The HLC's device is the LEDGER's 16-hex node id, not the 64-hex endpoint
   key a page is signed with — `makeHlc` refuses the latter, which is how this
   was caught. The first sixteen characters are a stable stand-in for a test. */
const stampFor = (device: string, seq: number) => makeHlc(NOW + seq, 0, device.slice(0, 16))

const share = (pub: string, seq: number, device = DEVICE.id): Entry => ({
  op: 'share',
  pub,
  device,
  seq,
  at: stampFor(device, seq),
  passage: { quote: `q-${pub}`, prefix: 'p', suffix: 's', chapter: 'One' },
})

const unshare = (pub: string, seq: number, device = DEVICE.id): Entry => ({
  op: 'unshare',
  pub,
  device,
  seq,
  at: stampFor(device, seq),
})

const ledger = (over: Partial<Ledger> = {}): Ledger => ({
  held: NOTHING_SHARED,
  devices: [DEVICE.id, OTHER_DEVICE.id],
  revoked: [],
  epoch: 0,
  relationshipEpoch: 1,
  admitted: true,
  ...over,
})

const take = (raws: readonly string[], over: Partial<Ledger> = {}) =>
  takePages(raws, WORK, PERSON.id, ledger(over), pageCrypto, NOW)

describe('a page that is everything it should be', () => {
  it('is taken, and its entries are held', () => {
    /* The positive case first: a file of refusals passes just as happily
       against a checker that refuses everything. */
    const result = take([page({ entries: [share('p1', 1)] })])

    expect(result.refusals).toEqual([])
    expect(result.accepted).toBe(1)
    expect(result.held.entries.map((one) => one.pub)).toEqual(['p1'])
    expect(result.held.entries[0]?.person).toBe(PERSON.id)
    expect(result.held.entries[0]?.passage.quote).toBe('q-p1')
  })

  it('records the relationship epoch it arrived under', () => {
    /* `drawsEntry` compares it: a passage received before a block is not drawn
       after a readmission unless the reader asked for it. */
    const result = take([page({ entries: [share('p1', 1)] })], { relationshipEpoch: 4 })
    expect(result.held.entries[0]?.epoch).toBe(4)
  })

  it('advances the chain head so the next page can be checked at all', () => {
    /* ⚠️ **WITHOUT A STORED HEAD THE CHAIN IS A FIELD, NOT A CHAIN.** And it
       has to survive a relaunch, or a peer could reset it by waiting for the
       app to close. */
    const result = take([page({ entries: [share('p1', 1)] })])
    expect(result.held.heads[DEVICE.id]).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('reports a cursor drawn from what it accepted', () => {
    const result = take([page({ entries: [share('p1', 3)] })])
    expect(result.cursor[DEVICE.id]).toBe(3)
  })
})

describe('the delegation a page carries', () => {
  it('is refused when the person did not sign it', () => {
    /* Signed by the device instead of the root — the substitution the whole
       root/leaf split exists to make impossible. */
    const forged = delegation({ sig: signWith(DEVICE.secret, 'anything') })
    expect(take([page({ delegation: forged })]).refusals).toEqual(['bad-delegation'])
  })

  it('is refused when it names a different device than signed the page', () => {
    /* ⚠️ **OTHERWISE A DEVICE PRESENTS SOMEBODY ELSE'S VALID DELEGATION** and
       signs with its own key. Every field verifies; the page is still a
       stranger's. */
    const theirs = delegation({ device: OTHER_DEVICE.id })
    expect(take([page({ delegation: theirs })]).refusals).toEqual(['bad-delegation'])
  })

  it('is refused after it expires, with no tolerance at all', () => {
    /* `identity.md`: a tolerance on expiry is an extension granted to exactly
       the device you are trying to stop. */
    const expired = delegation({ notAfter: NOW })
    expect(take([page({ delegation: expired })]).refusals).toEqual(['bad-delegation'])
  })

  it('is forgiven five minutes of clock skew before it starts, and no more', () => {
    const soon = delegation({ notBefore: NOW + 4 * 60 * 1000 })
    expect(take([page({ delegation: soon })]).accepted).toBe(1)
    const later = delegation({ notBefore: NOW + 6 * 60 * 1000 })
    expect(take([page({ delegation: later })]).refusals).toEqual(['bad-delegation'])
  })

  it('accepts a delegation starting EXACTLY five minutes from now', () => {
    /* ⚠️ **THE BOUNDARY, WHICH `<` AND `<=` DISAGREE ABOUT AND NOTHING ELSE
       DOES.** Five minutes is the allowance, so the instant five minutes away
       is inside it — off by one here is an hour of a new device's pages
       refused for no reason anybody can see. */
    const edge = delegation({ notBefore: NOW + 5 * 60 * 1000 })
    expect(take([page({ delegation: edge })]).accepted).toBe(1)
  })

  it('is refused when it was minted under a superseded roster', () => {
    /* A succession is how a person disowns everything issued before it. */
    const old = delegation({ roster: 1 })
    expect(take([page({ delegation: old })], { epoch: 2 }).refusals).toEqual(['bad-delegation'])
  })

  it('is refused when it is not the canonical spelling of itself', () => {
    const { sig, ...rest } = JSON.parse(delegation()) as SignedDelegation
    /* Same members, same values, `sig` written FIRST — a second spelling of
       one statement, which is exactly what canonicalisation refuses. */
    const reordered = JSON.stringify({ sig, ...rest })
    expect(reordered).not.toBe(delegation())
    expect(readDelegation(reordered, PERSON.id, pageCrypto)).toBeNull()
  })

  it('is refused when it carries a field this build does not know', () => {
    const body = JSON.parse(delegation()) as SignedDelegation
    const extra = canonicalJson({ ...body, role: 'home' })
    expect(readDelegation(extra, PERSON.id, pageCrypto)).toBeNull()
  })

  it('reads a real one, so the refusals above are not vacuous', () => {
    expect(readDelegation(delegation(), PERSON.id, pageCrypto)).not.toBeNull()
  })
})

describe('every clause of the delegation shape', () => {
  /**
   * ⚠️ **ONE BAD DELEGATION EXERCISES ONE CLAUSE.** The rest are decoration
   * until something runs them — they can be deleted, or silently stop working,
   * and the suite stays green. One row per clause, each bad in exactly ONE way
   * so a later clause cannot mask the one under test.
   */
  const body = () => ({
    person: PERSON.id,
    device: DEVICE.id,
    notBefore: NOW - 1_000,
    notAfter: NOW + 1_000_000,
    roster: 0,
    sig: 'a'.repeat(128),
  })
  const read = (value: unknown) =>
    readDelegation(typeof value === 'string' ? value : canonicalJson(value), PERSON.id, pageCrypto)

  const bad: readonly (readonly [string, unknown])[] = [
    ['bytes that are not JSON', 'not json'],
    ['a delegation that is a list', []],
    ['a delegation that is a string', 'delegation'],
    ['a delegation that is a number', 7],
    ['a delegation that is null', null],
    ['a member this build does not know', { ...body(), role: 'home' }],
    ['a missing person', { ...body(), person: undefined }],
    ['a missing device', { ...body(), device: undefined }],
    ['a missing signature', { ...body(), sig: undefined }],
    ['a missing notBefore', { ...body(), notBefore: undefined }],
    ['a missing notAfter', { ...body(), notAfter: undefined }],
    ['a missing roster epoch', { ...body(), roster: undefined }],
    ['a person that is a number', { ...body(), person: 1 }],
    ['a device that is a number', { ...body(), device: 1 }],
    ['a signature that is a number', { ...body(), sig: 1 }],
    ['a fractional notBefore', { ...body(), notBefore: 1.5 }],
    ['a fractional notAfter', { ...body(), notAfter: 1.5 }],
    ['a fractional roster epoch', { ...body(), roster: 1.5 }],
    ['a notBefore that is a string', { ...body(), notBefore: '1' }],
    ['a roster epoch that is a string', { ...body(), roster: '1' }],
    /* Well-formed, signed by nobody — the shape is not the authority. */
    ['a signature nobody made', body()],
    /* Well-formed and signed, for somebody else. */
    ['a delegation naming another person', { ...body(), person: DEVICE.id }],
  ]

  for (const [what, value] of bad) {
    it(`refuses ${what}`, () => {
      expect(read(value)).toBeNull()
    })
  }

  it('refuses six members with the wrong names', () => {
    /* ⚠️ **THE COUNT ALONE IS NOT THE CHECK.** Six members of any names pass a
       length test, so `role` in place of `roster` would be accepted — and an
       unknown member is a field the signer can use to mean something the
       verifier never saw. */
    const { roster: _gone, ...rest } = body()
    expect(read({ ...rest, role: 0 })).toBeNull()
  })

  it('refuses the six required members plus an extra', () => {
    /* And the NAMES alone are not the check either: every required name is
       present here, and there is a seventh. */
    expect(read({ ...body(), extra: 1 })).toBeNull()
  })

  it('refuses a delegation missing SEVERAL members, not just one', () => {
    /* ⚠️ `every` and `some` are the same function on a one-element difference;
       a row missing two members is what tells "all present" from "any". */
    expect(read({ person: PERSON.id, device: DEVICE.id })).toBeNull()
  })

  /** A delegation the person really signed over exactly these fields. */
  const reallySigned = (over: Partial<SignedDelegation>) => {
    const fields = { ...body(), ...over }
    const sig = signWith(PERSON.secret, delegationBytes({ ...fields, sig: '' }))
    return canonicalJson({ ...fields, sig })
  }

  it('refuses a properly signed delegation whose window is not whole numbers', () => {
    /* ⚠️ **A FLOAT IS A VALUE WHOSE CANONICAL FORM IS NOT ITS OWN.** `1e21`
       spells itself `1e+21`, `-0` spells itself `0` — so two honest peers can
       disagree about the bytes of one delegation. Signing the fractional body
       correctly is what makes this test discriminate: the signature verifies,
       and only the integer check refuses it. */
    expect(read(reallySigned({ notAfter: NOW + 1.5 }))).toBeNull()
    expect(read(reallySigned({ notBefore: NOW - 0.5 }))).toBeNull()
    expect(read(reallySigned({ roster: 0.5 }))).toBeNull()
    /* And every one of those bodies IS otherwise acceptable. */
    expect(read(reallySigned({}))).not.toBeNull()
  })

  it('refuses a properly signed delegation that names somebody else', () => {
    /* ⚠️ **THE SIGNATURE IS CHECKED AGAINST THE PERSON THE CALLER ASKED
       ABOUT**, not against the one written inside — so without this comparison
       a delegation naming Bob, signed by Alice, verifies as Alice's and then
       claims to speak for Bob. */
    expect(read(reallySigned({ person: DEVICE.id }))).toBeNull()
  })

  it('reads a real one, so none of the above is vacuous', () => {
    expect(readDelegation(delegation(), PERSON.id, pageCrypto)).not.toBeNull()
  })
})

describe('the roster a page carries cannot vouch for the device that signed it', () => {
  it('refuses a device the HELD roster does not name, however the page lists it', () => {
    /* ⚠️ **`Page.roster` IS COVERED BY THE PAGE'S SIGNATURE — THE DEVICE'S, NOT
       THE PERSON'S.** So a device can put itself on a roster it is not on and
       sign that. A receiver using it would be asking the suspect for its own
       alibi. The roster this side checks against arrived root-signed over the
       introduction ALPN. */
    const stranger = keypair('stranger')
    const theirs = delegation({ device: stranger.id })
    const raw = page(
      { device: stranger.id, delegation: theirs, roster: [stranger.id] },
      stranger.secret,
    )

    expect(take([raw]).refusals).toEqual(['bad-delegation'])
  })

  it('refuses a device the person has revoked, whatever the page says', () => {
    expect(take([page()], { revoked: [DEVICE.id] }).refusals).toEqual(['bad-delegation'])
  })
})

describe('what a peer can send instead of a page', () => {
  it('refuses bytes that are not JSON', () => {
    expect(take(['not json']).refusals).toEqual(['unparseable'])
  })

  it('refuses JSON that is not an object', () => {
    for (const raw of ['[]', '"page"', '7', 'null']) {
      expect(take([raw]).refusals).toEqual(['unparseable'])
    }
  })

  it('refuses a page whose device is not a device id', () => {
    /* Named for what it is rather than reached through the signature check,
       which would answer `bad-signature` and send somebody looking at keys. */
    expect(take([page({ device: 7 as unknown as string })]).refusals).toEqual(['unparseable'])
  })

  it("refuses a page for somebody else's log", () => {
    expect(take([page({ person: OTHER_DEVICE.id })]).refusals).toEqual(['wrong-person'])
  })

  it('refuses a page for another book', () => {
    const elsewhere = { ids: ['zz'], titles: ['zz'], author: 'zz', language: 'fr' }
    expect(take([page({ work: elsewhere })]).refusals).toEqual(['wrong-work'])
  })

  it('refuses a page whose bytes are not their own canonical form', () => {
    const { sig, ...rest } = JSON.parse(page()) as Page
    const reordered = JSON.stringify({ sig, ...rest })
    expect(reordered).not.toBe(page())
    expect(take([reordered]).refusals).toEqual(['not-canonical'])
  })

  it('refuses a page with a float where an integer belongs', () => {
    expect(take([page({ from: 1.5 })]).refusals).toEqual(['non-integer'])
  })

  it('refuses a version this build does not speak', () => {
    expect(take([page({ v: 2 })]).refusals).toEqual(['version'])
  })

  it('refuses a page signed by a key that is not the device it claims', () => {
    /* Signed with the WRONG key, everything else valid. */
    expect(take([page({}, OTHER_DEVICE.secret)]).refusals).toEqual(['bad-signature'])
  })

  it('refuses a page whose signature is a peer-chosen string, without throwing', () => {
    for (const sig of ['', 'zz', 'f'.repeat(128), 'é'.repeat(128)]) {
      expect(() => take([page({ sig })])).not.toThrow()
      expect(take([page({ sig })]).accepted).toBe(0)
    }
  })
})

describe('the chain', () => {
  it('refuses page two before page one', () => {
    /* ⚠️ **A GAP IS A SUBSTITUTION UNTIL PROVEN OTHERWISE.** Merging a page
       whose predecessor never arrived accepts a log with a hole in it. */
    const second = page({ from: 2, to: 2, prevPageHash: 'a'.repeat(64) })
    expect(take([second]).refusals).toEqual(['chain'])
  })

  it('takes page two once page one has set the head', () => {
    const first = page({ entries: [share('p1', 1)] })
    const held = take([first]).held
    const second = page({
      from: 2,
      to: 2,
      prevPageHash: held.heads[DEVICE.id] as string,
      entries: [share('p2', 2)],
    })

    const result = takePages([second], WORK, PERSON.id, ledger({ held }), pageCrypto, NOW)

    expect(result.refusals).toEqual([])
    expect(result.held.entries.map((one) => one.pub).sort()).toEqual(['p1', 'p2'])
  })

  it('remembers the head across a reload, because it is on disk', () => {
    /* The head is a field of the stored file — a peer that could reset the
       chain by waiting for the app to close could substitute a page at will. */
    const held = take([page({ entries: [share('p1', 1)] })]).held
    const reloaded: ForeignFile = JSON.parse(JSON.stringify(held)) as ForeignFile
    expect(reloaded.heads[DEVICE.id]).toBe(held.heads[DEVICE.id])
  })

  it('does not stop a device over a page refused for a reason that is not a break', () => {
    /* ⚠️ **ONLY A BROKEN CHAIN OR A BAD SIGNATURE MEANS THE STREAM IS
       COMPROMISED.** An expired delegation is a publisher who has not renewed,
       not a hostile one — and treating every refusal as a break would let one
       stale page cost a friend everything else in the same batch, which is the
       failure `takePages` opens by saying it will not do. */
    /* An EXPIRED delegation, because that refusal comes out of `checkPage` —
       where the break is decided. A `wrong-work` page returns before that line
       and so cannot tell the two behaviours apart, which is what the first
       version of this test did. */
    const stale = page({ delegation: delegation({ notAfter: NOW }) })
    const honest = page({ entries: [share('good', 1)] })

    const result = take([stale, honest])

    expect(result.refusals).toEqual(['bad-delegation'])
    expect(result.accepted).toBe(1)
    expect(result.held.entries.map((one) => one.pub)).toEqual(['good'])
  })

  it('stops a device that sent one bad signature from trying again in the same batch', () => {
    /* ⚠️ **OTHERWISE A PEER SPRAYS VARIANTS AT ONE CHAIN POSITION UNTIL ONE
       STICKS.** Both pages below are chained on the same (empty) head, so the
       second is not refused by the chain — only by the fact that this device
       has already failed a signature in this batch. Without that, a bad
       signature costs an attacker one page and nothing else. */
    const forged = page({ entries: [share('bad', 1)] }, OTHER_DEVICE.secret)
    const honest = page({ entries: [share('good', 1)] })

    const result = take([forged, honest])

    expect(result.accepted).toBe(0)
    expect(result.refusals).toEqual(['bad-signature', 'chain'])
    expect(result.held.entries).toEqual([])
  })

  it('stops one device after a break without touching another', () => {
    /* ⚠️ **ONE BAD PAGE MUST NOT COST A FRIEND THEIR WHOLE HISTORY**, and it
       must not let the pages behind it through either: they would fail `chain`
       anyway, and accepting them is accepting a hole. */
    const otherDelegation = delegation({ device: OTHER_DEVICE.id })
    const good = page(
      { device: OTHER_DEVICE.id, delegation: otherDelegation, entries: [share('ok', 1, OTHER_DEVICE.id)] },
      OTHER_DEVICE.secret,
    )
    const broken = page({ prevPageHash: 'b'.repeat(64) })
    const after = page({ entries: [share('after', 2)] })

    const result = take([good, broken, after])

    expect(result.accepted).toBe(1)
    expect(result.refusals).toEqual(['chain', 'chain'])
    expect(result.held.entries.map((one) => one.pub)).toEqual(['ok'])
  })
})

describe('a person whose pages are not read at all', () => {
  it('is refused before anything is parsed', () => {
    /* `relationships.md` makes the TRANSPORT the boundary: a blocked peer must
       not be able to ask this side to parse anything. */
    const result = take([page(), 'not even json'], { admitted: false })
    expect(result.refusals).toEqual(['not-admitted', 'not-admitted'])
    expect(result.held).toEqual(NOTHING_SHARED)
    /* ⚠️ **AND THE CURSOR IS THE ONE ALREADY HELD, not one derived from pages
       nobody read.** A cursor moved over a refused page is a page never
       fetched again, and the gap is permanent and silent. */
    expect(result.cursor).toEqual({})
  })

  it('keeps the cursor it already had for a person who is not admitted', () => {
    const heads = { [DEVICE.id]: 'a'.repeat(64) }
    const result = take([page()], { admitted: false, held: { ...NOTHING_SHARED, heads } })
    expect(result.cursor).toEqual({ [DEVICE.id]: 0 })
  })
})

describe('applying entries is folding them', () => {
  it('withdraws a passage that arrives before its share', () => {
    /* ⚠️ **THE WHOLE REASON THE STORE HOLDS TOMBSTONES.** Two of a person's
       devices publish independently, so a withdrawal can land first — and one
       that is dropped comes straight back. */
    const withdrawn = applyEntries(NOTHING_SHARED, [unshare('p1', 1)], PERSON.id, 1, NOW)
    expect(withdrawn.withdrawn).toEqual(['p1'])

    const later = applyEntries(withdrawn, [share('p1', 2)], PERSON.id, 1, NOW)
    expect(later.entries).toEqual([])
    expect(later.withdrawn).toEqual(['p1'])
  })

  it('does not let a redelivery move a passage up the list', () => {
    /* `fold` keeps the earlier stamp; the stored entry has no `at`, so
       `receivedAt` is the ordering key and not overwriting it is the same
       guarantee by the same reasoning. */
    const first = applyEntries(NOTHING_SHARED, [share('p1', 1)], PERSON.id, 1, 100)
    const again = applyEntries(first, [share('p1', 1)], PERSON.id, 1, 999)
    expect(again.entries).toHaveLength(1)
    expect(again.entries[0]?.receivedAt).toBe(100)
  })

  it('agrees with folding the whole log, in every order', () => {
    /* ⚠️ **THE STORE KEEPS THE FOLDED RESULT, NOT THE LOG**, so applying pages
       one at a time has to give what folding the whole log would — for every
       interleaving, not for the cases somebody thought of. `fold` is the
       specification; this is the implementation that has to match it. */
    const pubs = ['a', 'b', 'c']
    const arb = fc.array(
      fc.tuple(fc.constantFrom(...pubs), fc.boolean(), fc.integer({ min: 1, max: 9 })),
      { minLength: 0, maxLength: 8 },
    )

    fc.assert(
      fc.property(arb, fc.array(fc.integer({ min: 0, max: 7 }), { maxLength: 8 }), (ops, cuts) => {
        const log: Entry[] = ops.map(([pub, isShare, seq]) =>
          isShare ? share(pub, seq) : unshare(pub, seq),
        )
        /* One shot, the specification. */
        const wanted = new Set(fold(log).map((one) => one.pub))

        /* Applied in batches, the way pages actually arrive. */
        let held: ForeignFile = NOTHING_SHARED
        let at = 0
        for (const cut of [...cuts, log.length].sort((a, b) => a - b)) {
          const slice = log.slice(at, Math.max(at, cut))
          at = Math.max(at, cut)
          held = applyEntries(held, slice, PERSON.id, 1, NOW)
        }
        held = applyEntries(held, log.slice(at), PERSON.id, 1, NOW)

        const got = new Set(held.entries.map((one) => one.pub))
        expect([...got].sort()).toEqual([...wanted].sort())
      }),
      { numRuns: 300 },
    )
  })
})

describe('the golden vector the Rust side pins', () => {
  it('builds the delegation bytes `person.rs` signs, field for field', () => {
    /* ⚠️ **TWO IMPLEMENTATIONS OF ONE FORMAT.** `wire.md` names the failure:
       a signature that verifies on one machine and fails on another looks like
       corruption rather than like a bug. Six fields joined by newlines is a
       format neither side can implement two ways — and this pins it anyway. */
    expect(
      delegationBytes({
        person: 'aa'.repeat(32),
        device: 'bb'.repeat(32),
        notBefore: 10,
        notAfter: 20,
        roster: 3,
        sig: 'ignored',
      }),
    ).toBe(`paper/circle/delegation/1\n${'aa'.repeat(32)}\n${'bb'.repeat(32)}\n10\n20\n3`)
  })
})
