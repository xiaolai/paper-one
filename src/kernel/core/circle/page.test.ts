import { describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../canonicalJson'
import { hlcOf } from '../hlc'
import type { Entry } from './log'
import {
  carriedBy,
  chainHash,
  checkPage,
  integersOnly,
  isCanonical,
  isEntryShape,
  isPageShape,
  MAX_ENTRIES_PER_PAGE,
  MAX_PAGE_CHARS,
  negotiate,
  paginate,
  signedBytes,
  SUPPORTED,
  WIRE_VERSION,
  type Page,
  type PageCrypto,
} from './page'

/** WI-22.C1's pages, WI-22.C4's negotiation, and the review's signature blocker. */

const entry = (pub: string, seq: number, note = ''): Entry => ({
  op: 'share',
  pub,
  device: 'd1',
  seq,
  at: hlcOf(seq),
  passage: { quote: `q${pub}`, prefix: 'p', suffix: 's', chapter: 'Ch. 1', ...(note ? { note } : {}) },
})

const page = (over: Partial<Page> = {}): Page => ({
  v: WIRE_VERSION,
  person: 'alice',
  work: { ids: ['1a'.repeat(32)], titles: ['2b'.repeat(32)], author: '3c'.repeat(32), language: 'en' },
  device: 'd1',
  from: 1,
  to: 1,
  prevPageHash: '',
  entries: [entry('p1', 1)],
  roster: ['d1', 'd2'],
  revocations: 0,
  delegation: 'deleg',
  sig: 'SIG',
  ...over,
})

/* A crypto that accepts exactly one signature, so a test can tell "verified"
   from "not checked" — a fake that always says yes proves nothing. */
const crypto = (accept: string): PageCrypto => ({
  verify: (_key, message, sig) => sig === 'SIG' && message === accept,
  hash: (value) => `h(${value.length})`,
})

/** The publication an entry names, or null for a register — which names none. */
const pubOf = (e: Entry): string | null => ('pub' in e ? e.pub : null)

describe('version negotiation', () => {
  it('picks the highest both speak', () => {
    expect(negotiate({ min: 1, max: 3 }, { min: 2, max: 5 })).toBe(3)
    expect(negotiate(SUPPORTED, SUPPORTED)).toBe(WIRE_VERSION)
  })

  it('answers null when there is no overlap, rather than guessing', () => {
    /* ⚠️ A peer too old to talk to is TOLD that, not handed bytes it will
       reject field by field. `SYNC_VERSION`'s history is an unbumped peer
       stripping an unknown field, ACKing the stripped row, and the equal-stamp
       ACK erasing the sender's data — on an append-only log that is a lost
       history, not a lost field. */
    expect(negotiate({ min: 1, max: 1 }, { min: 2, max: 2 })).toBeNull()
    expect(negotiate({ min: 3, max: 4 }, { min: 1, max: 2 })).toBeNull()
  })
})

describe('signedBytes', () => {
  it('separates domains, so a roster signature is not a delegation signature', () => {
    /* ⚠️ `review.md`'s *"cross-type signature substitution"* check. Without the
       type in the preamble the same bytes verify as either. */
    const value = { person: 'alice', v: 1 }
    expect(signedBytes('roster', 1, value)).not.toBe(signedBytes('delegation', 1, value))
    expect(signedBytes('page', 1, value).startsWith('paper.circle.1.page\n')).toBe(true)
  })

  it('separates versions, so a v1 signature cannot be replayed as v2', () => {
    const value = { person: 'alice' }
    expect(signedBytes('page', 1, value)).not.toBe(signedBytes('page', 2, value))
  })

  it('excludes the signature itself, whatever it holds', () => {
    expect(signedBytes('page', 1, { a: 1, sig: 'X' })).toBe(signedBytes('page', 1, { a: 1, sig: 'Y' }))
  })

  it('does not depend on key order', () => {
    expect(signedBytes('page', 1, { a: 1, b: 2 })).toBe(signedBytes('page', 1, { b: 2, a: 1 }))
  })
})

describe('isCanonical — verification by re-serialisation', () => {
  it('accepts the canonical spelling', () => {
    const value = { b: 2, a: 1 }
    expect(isCanonical(canonicalJson(value), value)).toBe(true)
  })

  it('refuses a different key order', () => {
    expect(isCanonical('{"b":2,"a":1}', { a: 1, b: 2 })).toBe(false)
  })

  it('refuses what JSON.parse has already destroyed the evidence of', () => {
    /* ⚠️ **THE WHOLE TRICK.** A duplicate member is gone by the time any parser
       of ours runs — `JSON.parse('{"a":1,"a":2}')` is `{a:2}` and nothing can
       tell. Re-serialising and comparing bytes catches it without ever needing
       to see it: the received bytes are longer than the canonical ones. */
    const received = '{"a":1,"a":2}'
    expect(isCanonical(received, JSON.parse(received) as unknown)).toBe(false)
  })

  it('refuses exponent form and -0, which canonical JSON cannot reproduce', () => {
    expect(isCanonical('{"n":1e2}', JSON.parse('{"n":1e2}') as unknown)).toBe(false)
    expect(isCanonical('{"n":-0}', JSON.parse('{"n":-0}') as unknown)).toBe(false)
  })

  it('refuses an escaped spelling of a character we emit raw', () => {
    /* Two encoders disagreeing about `é` is a signature that verifies on one
       machine and fails on another, which is the failure that looks like
       corruption rather than like a bug. */
    expect(isCanonical('{"s":"\\u00e9"}', JSON.parse('{"s":"\\u00e9"}') as unknown)).toBe(false)
  })
})

describe('integersOnly', () => {
  it('accepts integers at any depth', () => {
    expect(integersOnly({ a: 1, b: [2, { c: 3 }] })).toBe(true)
  })

  it('refuses a float, because its canonical form is not its own', () => {
    expect(integersOnly({ at: 1.5 })).toBe(false)
    expect(integersOnly([1, 2.25])).toBe(false)
  })

  it('refuses the numbers JSON.stringify rewrites', () => {
    expect(integersOnly({ n: -0 })).toBe(true /* -0 IS a safe integer */)
    expect(integersOnly({ n: 1e21 })).toBe(false)
    expect(integersOnly({ n: Number.NaN })).toBe(false)
    expect(integersOnly({ n: Number.POSITIVE_INFINITY })).toBe(false)
  })
})

const speaks = () => true

describe('checkPage', () => {
  const good = page()
  const bytes = canonicalJson(good)
  const ok = crypto(signedBytes('page', WIRE_VERSION, good))

  it('accepts a page that is canonical, integral, chained and signed', () => {
    expect(checkPage(good, bytes, ok, 'key', '', speaks)).toBeNull()
  })

  it('refuses a version it does not speak', () => {
    const other = page({ v: 99 })
    expect(checkPage(other, canonicalJson(other), ok, 'key', '', speaks)).toBe('version')
  })

  it('refuses a page whose bytes are not its canonical form', () => {
    expect(checkPage(good, `${bytes} `, ok, 'key', '', speaks)).toBe('not-canonical')
  })

  it('refuses a gap in the chain rather than merging a log with a hole', () => {
    /* ⚠️ `prevPageHash` exists so a gap or a substitution in one device's
       stream is detectable. Merging past it accepts a log missing pages and
       says nothing. */
    expect(checkPage(good, bytes, ok, 'key', 'some-other-hash', speaks)).toBe('chain')
  })

  it('refuses a bad signature', () => {
    const forged = page({ sig: 'NOPE' })
    expect(checkPage(forged, canonicalJson(forged), ok, 'key', '', speaks)).toBe('bad-signature')
  })

  it('checks the cheap things before the signature', () => {
    /* ⚠️ A signature check is the expensive step, and a peer that can make us
       do it for free on malformed input has found a cheap way to spend our CPU.
       A page that is BOTH mis-versioned and unsigned must refuse on the
       version — which is the observable half of the ordering. */
    const bad = page({ v: 99, sig: 'NOPE' })
    let verified = false
    const counting: PageCrypto = {
      verify: () => {
        verified = true
        return false
      },
      hash: () => '',
    }
    expect(checkPage(bad, canonicalJson(bad), counting, 'key', '', speaks)).toBe('version')
    expect(verified).toBe(false)
  })
})

describe('paginate', () => {
  it('splits by encoded size, not by count', () => {
    /* ⚠️ A count is a proxy that is wrong for exactly the notes that matter.
       One long note and three bare highlights must not page the same way. */
    const long = entry('big', 1, 'x'.repeat(400))
    /* Measured: a bare highlight encodes to ~125 bytes and this one to ~540.
       A budget of 400 therefore takes two bare entries and cannot take the
       long one beside anything — which a COUNT of two per page would get
       exactly backwards. */
    const pages = paginate([long, entry('a', 2), entry('b', 3)], 400)
    expect(pages).toHaveLength(2)
    expect(pages[0]!.map(pubOf)).toEqual(['big'])
    expect(pages[1]!.map(pubOf)).toEqual(['a', 'b'])

    /* And the same three entries page differently at a different budget, which
       is the property itself rather than one arrangement of it. */
    expect(paginate([long, entry('a', 2), entry('b', 3)], 700).map((one) => one.length)).toEqual([1, 2])
  })

  it('emits an oversized entry as its own page rather than looping for ever', () => {
    /* ⚠️ It will be refused downstream by the frame cap, which is the right
       place — but a pager that never emitted it would HANG, and a hang is the
       one failure that looks like nothing at all. */
    const huge = entry('huge', 1, 'x'.repeat(5000))
    const pages = paginate([huge], 100)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toHaveLength(1)
  })

  it('loses nothing and keeps the order', () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(`p${i}`, i + 1))
    const pages = paginate(entries, 500)
    expect(pages.flat().map(pubOf)).toEqual(entries.map(pubOf))
  })

  it('answers nothing for nothing', () => {
    expect(paginate([], 500)).toEqual([])
  })
})

describe('the delegation the page carries is actually checked', () => {
  const good = page()
  const bytes = canonicalJson(good)
  const ok = crypto(signedBytes('page', WIRE_VERSION, good))

  it('refuses a perfectly signed page from a device that may not speak', () => {
    /* ⚠️ **THE DEFECT THIS AUDIT FOUND, AND IT WAS THE SECURITY PROPERTY OF THE
       WHOLE STAGE.** `checkPage` took the verifying key as a caller-supplied
       argument with no linkage to `page.delegation`, `page.roster` or
       `page.revocations` — the three fields `wire.md` says a page carries
       *"because they are needed to check it"*. Nothing read any of them, and
       `maySpeak` had been written in `identity.ts` and wired to nothing.

       So a page from a device revoked yesterday verified cleanly: the signature
       proves the bytes are intact and says nothing whatever about whether their
       author is still allowed to write them. That is WI-22.B2's acceptance —
       *"a peer holding version n refuses anything signed by a device revoked at
       ≤ n"* — and it was absent. */
    expect(checkPage(good, bytes, ok, 'key', '', () => false)).toBe('may-not-speak')
  })

  it('refuses before spending a signature check on it', () => {
    /* A device that may not speak is refused whatever it signed, and the
       signature is the expensive step. */
    let verified = false
    const counting: PageCrypto = {
      verify: () => {
        verified = true
        return true
      },
      hash: () => '',
    }
    expect(checkPage(good, bytes, counting, 'key', '', () => false)).toBe('may-not-speak')
    expect(verified).toBe(false)
  })

  it('is a REQUIRED argument, so a caller cannot forget it', () => {
    /* Injected rather than optional: an optional check is one a call site added
       later simply does not pass. TypeScript refuses a `checkPage` call without
       it, which is the part that keeps this fixed. */
    expect(checkPage.length).toBeGreaterThanOrEqual(6)
  })
})

describe('the chain can be extended, not only checked', () => {
  it('computes the hash the next page must carry', () => {
    /* ⚠️ `crypto.hash` was required of every caller and never called: the chain
       could be verified and not extended, which is not a chain but a field. */
    const first = page()
    const bytes = canonicalJson(first)
    const sha = (value: string) => `sha(${value.length})`
    const next = page({ prevPageHash: chainHash({ verify: () => true, hash: sha }, bytes) })

    expect(next.prevPageHash).toBe(sha(bytes))
    const ok = crypto(signedBytes('page', WIRE_VERSION, next))
    expect(checkPage(next, canonicalJson(next), ok, 'key', next.prevPageHash, speaks)).toBeNull()
  })

  it('hashes the RECEIVED bytes, so the chain commits to what was signed', () => {
    const seen: string[] = []
    chainHash({ verify: () => true, hash: (v) => (seen.push(v), 'h') }, '{"exact":"bytes"}')
    expect(seen).toEqual(['{"exact":"bytes"}'])
  })
})

describe("WI-22.C1's strongest falsifier, run on an actual page", () => {
  it('serialises a page and finds no epubcfi anywhere in the bytes', () => {
    /* ⚠️ **THE PLAN CALLS THIS "the strongest one in this plan" and it was not
       being run.** The existing check greps `fold()`'s output, which is a list
       of held publications and not a page — so the thing that actually crosses
       the wire was never inspected.

       *"Serialise a page and grep the bytes for `epubcfi`. Any hit is phase
       21's defect reintroduced at scale, on a surface where it reaches
       strangers' data rather than the reader's own."* */
    const full = page({
      entries: [
        entry('p1', 1),
        entry('p2', 2, 'a note about the passage'),
        { op: 'unshare', pub: 'p3', device: 'd1', seq: 3, at: hlcOf(3) },
      ],
    })
    const bytes = canonicalJson(full)

    expect(bytes).not.toContain('epubcfi')
    expect(bytes).not.toContain('cfi')
    /* And the two fields that leak the reader's own vocabulary. */
    expect(bytes).not.toContain('tint')
    expect(bytes).not.toContain('style')
    /* A positive control: the passage text IS there, so this is grepping a page
       with content rather than an empty one. */
    expect(bytes).toContain('a note about the passage')
  })
})

describe('which entries a version carries — WI-23.B2', () => {
  const stamped = { device: 'd', seq: 1, at: hlcOf(1) }
  const every: readonly Entry[] = [
    { ...stamped, op: 'share', pub: 'p', passage: { quote: 'q', prefix: '', suffix: '', chapter: '' } },
    { ...stamped, op: 'unshare', pub: 'p' },
    { ...stamped, op: 'status', state: 'reading' },
    { ...stamped, op: 'rate', stars: 3 },
    { ...stamped, op: 'tag', tags: ['sea'] },
    { ...stamped, op: 'review', pub: 'r', text: 't' },
    { ...stamped, op: 'unreview', pub: 'r' },
    { ...stamped, op: 'shelf', pub: 's', work: { title: 'T', author: 'A', language: 'en' } },
    { ...stamped, op: 'unshelf', pub: 's' },
    { ...stamped, op: 'create', title: 'L' },
    { ...stamped, op: 'retitle', title: 'M' },
    { ...stamped, op: 'place', pub: 'i', work: { title: 'T', author: 'A', language: 'en' }, position: 1, note: '' },
    { ...stamped, op: 'remove', pub: 'i' },
    { ...stamped, op: 'delete' },
  ]

  it('lets v1 carry passages only, v2 the nine, and v3 the lists too', () => {
    expect(every.filter((one) => carriedBy(1, one)).map((one) => one.op)).toEqual(['share', 'unshare'])
    expect(every.filter((one) => carriedBy(2, one)).map((one) => one.op)).toEqual([
      'share',
      'unshare',
      'status',
      'rate',
      'tag',
      'review',
      'unreview',
      'shelf',
      'unshelf',
    ])
    expect(every.filter((one) => carriedBy(3, one))).toEqual(every)
  })

  it('lets a version this build does not know carry nothing at all', () => {
    expect(every.some((one) => carriedBy(4, one))).toBe(false)
    expect(every.some((one) => carriedBy(0, one))).toBe(false)
  })

  it('publishes v3, and reads all three', () => {
    expect(WIRE_VERSION).toBe(3)
    expect(SUPPORTED).toEqual({ min: 1, max: 3 })
  })

  it('lets two peers who both speak only v1 agree on v1', () => {
    /* The overlap is one version wide; `>=` against `>` is the whole of it. */
    expect(negotiate({ min: 1, max: 1 }, { min: 1, max: 1 })).toBe(1)
  })
})

describe('integers only, over every shape', () => {
  it('accepts a safe integer at any depth, and nothing that is not one', () => {
    expect(integersOnly(7)).toBe(true)
    expect(integersOnly(1.5)).toBe(false)
    expect(integersOnly({ a: [1, { b: 2 }] })).toBe(true)
    expect(integersOnly({ a: [1, { b: 2.5 }] })).toBe(false)
    /* ONE float among integers is enough: `some` would let it through. */
    expect(integersOnly({ a: 1, b: 2, c: 0.5 })).toBe(false)
    expect(integersOnly([1, 2, 3.5])).toBe(false)
  })

  it('answers true for null and for strings, which hold no number', () => {
    expect(integersOnly(null)).toBe(true)
    expect(integersOnly('1.5')).toBe(true)
    expect(integersOnly(undefined)).toBe(true)
  })

  it('refuses a page with a float where an integer belongs, before the signature', () => {
    const floated = { ...page(), from: 1.5 }
    const counting = { verify: vi.fn(() => true), hash: () => 'h' }
    expect(checkPage(floated, canonicalJson(floated), counting, "key", "", () => true, floated.v)).toBe("non-integer")
    expect(counting.verify).not.toHaveBeenCalled()
  })
})

describe('the page budget, at its boundary', () => {
  it('fills a page to the budget exactly, and splits one character past it', () => {
    /* Each entry costs its canonical bytes, a comma sits between two, and a
       page starts at the two bytes an empty list costs — exactly what the
       list would serialise to, and not a byte more. */
    const a = entry('a', 1)
    const b = entry('b', 2)
    const exactly = canonicalJson([a, b]).length
    expect(exactly).toBe(2 + canonicalJson(a).length + 1 + canonicalJson(b).length)
    expect(paginate([a, b], exactly)).toHaveLength(1)
    expect(paginate([a, b], exactly - 1)).toHaveLength(2)
  })
})

describe('the shape of a page and of an entry', () => {
  /* Each kind with EXACTLY its fields — a `status` carries no `pub`, an
     `unshare` no passage — because that is now what the shape demands. */
  const NAMES_A_PUB = new Set(['share', 'unshare', 'review', 'unreview', 'shelf', 'unshelf', 'place', 'remove'])
  const PASSAGE = { quote: 'q', prefix: '', suffix: '', chapter: '' }
  const entry = (over: Record<string, unknown> = {}) => {
    const op = typeof over['op'] === 'string' ? over['op'] : 'share'
    return {
      op,
      device: 'd',
      seq: 1,
      at: '018bcfe56809-0000-1d8865efc2eaef44',
      ...(NAMES_A_PUB.has(op) ? { pub: 'p' } : {}),
      ...(op === 'share' ? { passage: PASSAGE } : {}),
      ...over,
    }
  }
  it('reads every kind with its fields, and refuses each without them', () => {
    const okay = [
      entry(),
      entry({ op: 'unshare' }),
      entry({ op: 'status', state: 'want' }),
      entry({ op: 'rate', stars: 5 }),
      entry({ op: 'tag', tags: ['a'] }),
      entry({ op: 'review', text: 't' }),
      entry({ op: 'unreview' }),
      entry({ op: 'shelf', work: { title: 'T', author: 'A', language: 'en', identifier: 'i', cover: 'ab'.repeat(32) } }),
      entry({ op: 'unshelf' }),
      entry({ op: 'create', title: 'L' }),
      entry({ op: 'retitle', title: 'M' }),
      entry({ op: 'place', work: { title: 'T', author: 'A', language: 'en' }, position: 1, note: '' }),
      entry({ op: 'remove' }),
      entry({ op: 'delete' }),
    ]
    for (const one of okay) expect(isEntryShape(one)).toBe(true)
    const bad = [
      entry({ op: 'sing' }),
      /* A cover is a digest the recipient fetches by (WI-23.C5), not a word and not a path. */
      entry({ op: 'shelf', work: { title: 'T', author: 'A', language: 'en', cover: 'not a digest' } }),
      entry({ op: 'shelf', work: { title: 'T', author: 'A', language: 'en', cover: 'AB'.repeat(32) } }),
      entry({ op: 'shelf', work: { title: 'T', author: 'A', language: 'en', cover: `${'ab'.repeat(32)}x` } }),
      entry({ op: 'shelf', work: { title: 'T', author: 'A', language: 'en', cover: `x${'ab'.repeat(32)}` } }),
      entry({ pub: '' }),
      entry({ passage: { quote: 'q' } }),
      entry({ passage: { quote: 'q', prefix: '', suffix: '', chapter: '', note: 7 } }),
      entry({ op: 'status', state: 'done' }),
      entry({ op: 'rate', stars: 6 }),
      entry({ op: 'tag', tags: 'a' }),
      entry({ op: 'review', text: 1 }),
      entry({ op: 'shelf', work: { title: 'T' } }),
      entry({ op: 'shelf', work: { title: 'T', author: 'A', language: 'en', cover: 1 } }),
      entry({ op: 'create', title: 1 }),
      entry({ op: 'place', work: { title: 'T', author: 'A', language: 'en' }, position: 'first', note: '' }),
      entry({ op: 'place', work: { title: 'T', author: 'A', language: 'en' }, position: 1 }),
      entry({ device: 1 }),
      entry({ seq: '1' }),
      entry({ at: 1 }),
      entry({ at: 'yesterday' }),
      /* The disclosure rule, enforced: an `unshare` carrying the passage it withdraws. */
      entry({ op: 'unshare', passage: PASSAGE }),
      entry({ op: 'status', state: 'want', pub: 'p' }),
      entry({ extra: 1 }),
      entry({ passage: { quote: 'q', prefix: '', suffix: '', chapter: '', extra: 1 } }),
      'share',
      null,
    ]
    for (const one of bad) expect(isEntryShape(one)).toBe(false)
  })

  it('reads a page whose every field is what it says, and refuses one field short or wrong', () => {
    const whole = page()
    expect(isPageShape(whole)).toBe(true)
    for (const over of [
      { work: 'w' },
      { work: { ...whole.work, ids: 'x' } },
      { work: { ...whole.work, language: 1 } },
      { entries: 'none' },
      { entries: [{ op: 'share' }] },
      { entries: Array.from({ length: MAX_ENTRIES_PER_PAGE + 1 }, () => whole.entries[0] ?? entry()) },
      { v: '2' },
      { person: 1 },
      { device: 1 },
      { from: '1' },
      { to: null },
      { prevPageHash: 1 },
      { roster: 'd' },
      { roster: Array.from({ length: 257 }, () => 'd') },
      { revocations: '0' },
      { delegation: 1 },
      { sig: 1 },
      { extra: 1 },
      { work: { ...whole.work, extra: 1 } },
    ]) {
      expect(isPageShape({ ...whole, ...over })).toBe(false)
    }
    expect(isPageShape([])).toBe(false)
    expect(isPageShape(null)).toBe(false)
  })

  it('refuses a page past the frame cap before looking at its chain', () => {
    const big = page({ prevPageHash: 'x'.repeat(64) })
    const bytes = canonicalJson(big)
    const padded = bytes + ' '.repeat(MAX_PAGE_CHARS)
    expect(checkPage(big, padded, crypto(signedBytes('page', WIRE_VERSION, big)), 'key', '', speaks)).not.toBe('chain')
    expect(checkPage(big, padded, crypto(signedBytes('page', WIRE_VERSION, big)), 'key', '', speaks)).toBe('not-canonical')
    /* A canonical page that is simply too long: the cap, not the chain. */
    const long = page({ delegation: 'd'.repeat(MAX_PAGE_CHARS) })
    expect(checkPage(long, canonicalJson(long), crypto(signedBytes('page', WIRE_VERSION, long)), 'key', 'not-the-prev', speaks)).toBe('too-large')
  })
})

describe('the entries a page carries are its own', () => {
  const okay = crypto(signedBytes('page', WIRE_VERSION, page()))
  it('refuses a page whose entries belong to another device or fall outside its range, after the chain and before the signature', () => {
    const stranger = page({ entries: [{ ...page().entries[0]!, device: 'other' }] })
    expect(checkPage(stranger, canonicalJson(stranger), okay, 'key', '', speaks)).toBe('malformed')
    const outside = page({ from: 5, to: 6 })
    expect(checkPage(outside, canonicalJson(outside), okay, 'key', '', speaks)).toBe('malformed')
    const backwards = page({ from: 2, to: 1, entries: [] })
    expect(checkPage(backwards, canonicalJson(backwards), okay, 'key', '', speaks)).toBe('malformed')
    const zero = page({ from: 0, to: 0, entries: [] })
    expect(checkPage(zero, canonicalJson(zero), okay, 'key', '', speaks)).toBe('malformed')
    /* A gap is still a gap first. */
    expect(checkPage(stranger, canonicalJson(stranger), okay, 'key', 'not-the-prev', speaks)).toBe('chain')
  })
})

describe('what a version carries, checked on the page itself', () => {
  it('refuses a v1 page holding a kind only v2 carries, as malformed', () => {
    const status: Entry = { op: 'status', state: 'reading', device: 'd1', seq: 1, at: hlcOf(1) }
    const v1 = page({ v: 1, entries: [status] })
    expect(checkPage(v1, canonicalJson(v1), crypto(signedBytes('page', 1, v1)), 'key', '', speaks, 1)).toBe('malformed')
    /* The same entry on a v2 page is carried, and reaches the signature. */
    const v2 = page({ v: 2, entries: [status] })
    expect(checkPage(v2, canonicalJson(v2), crypto(signedBytes('page', 2, v2)), 'key', '', speaks, 2)).toBeNull()
  })
})

describe('every clause of the entry shape — one row each', () => {
  const HLC = '018bcfe56809-0000-1d8865efc2eaef44'
  const stamped = (over: Record<string, unknown>) => ({ device: 'd', seq: 1, at: HLC, ...over })
  const PASSAGE = { quote: 'q', prefix: '', suffix: '', chapter: '' }
  const WORK = { title: 'T', author: 'A', language: 'en' }
  const good: Record<string, Record<string, unknown>> = {
    share: stamped({ op: 'share', pub: 'p', passage: PASSAGE }),
    unshare: stamped({ op: 'unshare', pub: 'p' }),
    status: stamped({ op: 'status', state: 'want' }),
    rate: stamped({ op: 'rate', stars: 3 }),
    tag: stamped({ op: 'tag', tags: ['a'] }),
    review: stamped({ op: 'review', pub: 'p', text: 't' }),
    unreview: stamped({ op: 'unreview', pub: 'p' }),
    shelf: stamped({ op: 'shelf', pub: 'p', work: WORK }),
    unshelf: stamped({ op: 'unshelf', pub: 'p' }),
    create: stamped({ op: 'create', title: 'L' }),
    retitle: stamped({ op: 'retitle', title: 'M' }),
    place: stamped({ op: 'place', pub: 'p', work: WORK, position: 1, note: '' }),
    remove: stamped({ op: 'remove', pub: 'p' }),
    delete: stamped({ op: 'delete' }),
  }
  it('reads every kind', () => {
    for (const [op, entry] of Object.entries(good)) expect(isEntryShape(entry), op).toBe(true)
    for (const state of ['want', 'reading', 'finished']) expect(isEntryShape({ ...good['status'], state })).toBe(true)
    for (const stars of [1, 2, 3, 4, 5]) expect(isEntryShape({ ...good['rate'], stars })).toBe(true)
    expect(isEntryShape({ ...good['share'], passage: { ...PASSAGE, note: 'n' } })).toBe(true)
    expect(isEntryShape({ ...good['shelf'], work: { ...WORK, identifier: 'i', cover: 'ab'.repeat(32) } })).toBe(true)
    expect(isEntryShape({ ...good['tag'], tags: Array.from({ length: 256 }, (_, i) => `t${i}`) })).toBe(true)
  })
  const bad: [string, Record<string, unknown>][] = [
    ['an unknown state', { ...good['status'], state: 'abandoned' }],
    ['a state that is not a string', { ...good['status'], state: 1 }],
    ['zero stars', { ...good['rate'], stars: 0 }],
    ['six stars', { ...good['rate'], stars: 6 }],
    ['stars as a string', { ...good['rate'], stars: '3' }],
    ['tags past the limit', { ...good['tag'], tags: Array.from({ length: 257 }, (_, i) => `t${i}`) }],
    ['tags with a number among them', { ...good['tag'], tags: ['a', 1] }],
    ['tags that are a string', { ...good['tag'], tags: 'a' }],
    ['a review with no text', { ...good['review'], text: undefined }],
    ['a review whose text is a number', { ...good['review'], text: 1 }],
    ['a title that is a number', { ...good['create'], title: 1 }],
    ['a retitle with no title', { ...good['retitle'], title: undefined }],
    ['a position that is a string', { ...good['place'], position: '1' }],
    ['a note that is a number', { ...good['place'], note: 1 }],
    ['a passage quote that is a number', { ...good['share'], passage: { ...PASSAGE, quote: 1 } }],
    ['a passage prefix that is a number', { ...good['share'], passage: { ...PASSAGE, prefix: 1 } }],
    ['a passage suffix that is a number', { ...good['share'], passage: { ...PASSAGE, suffix: 1 } }],
    ['a passage chapter that is a number', { ...good['share'], passage: { ...PASSAGE, chapter: 1 } }],
    ['a passage note that is a number', { ...good['share'], passage: { ...PASSAGE, note: 1 } }],
    ['a passage with a nameless field', { ...good['share'], passage: { ...PASSAGE, '': 'x' } }],
    ['a passage that is a string', { ...good['share'], passage: 'q' }],
    ['a work title that is a number', { ...good['shelf'], work: { ...WORK, title: 1 } }],
    ['a work author that is a number', { ...good['shelf'], work: { ...WORK, author: 1 } }],
    ['a work language that is a number', { ...good['shelf'], work: { ...WORK, language: 1 } }],
    ['a work identifier that is a number', { ...good['shelf'], work: { ...WORK, identifier: 1 } }],
    ['a work cover that is a number', { ...good['shelf'], work: { ...WORK, cover: 1 } }],
    ['a work with a field the schema does not name', { ...good['shelf'], work: { ...WORK, extra: 1 } }],
    ['a work that is a string', { ...good['shelf'], work: 'T' }],
    ['a work that is null', { ...good['place'], work: null }],
    ['a place whose work is an array', { ...good['place'], work: [] }],
    ['an op that is a number', { ...good['delete'], op: 7 }],
    ['a delete carrying a field', { ...good['delete'], pub: 'p' }],
    ['an entry whose device is a number', { ...good['delete'], device: 1 }],
    ['an entry whose seq is a string', { ...good['delete'], seq: '1' }],
    ['an entry with no stamp', { ...good['delete'], at: undefined }],
  ]
  for (const kind of ['unshare', 'unreview', 'unshelf', 'remove', 'review', 'shelf', 'place'] as const) {
    bad.push([`a ${kind} with an empty pub`, { ...good[kind], pub: '' }])
    bad.push([`a ${kind} whose pub is a number`, { ...good[kind], pub: 1 }])
  }
  bad.push(['a share with an empty pub', { ...good['share'], pub: '' }], ['a share whose pub is a number', { ...good['share'], pub: 1 }])
  for (const [what, entry] of bad) {
    it(`refuses ${what}`, () => {
      expect(isEntryShape(entry)).toBe(false)
    })
  }
})

describe('every clause of the page shape and check — one row each', () => {
  it('holds the claim, the entry count and each entry to the shape', () => {
    const whole = page()
    expect(isPageShape({ ...whole, work: { ...whole.work, author: 1 } })).toBe(false)
    expect(isPageShape({ ...whole, work: { ...whole.work, language: 1 } })).toBe(false)
    expect(isPageShape({ ...whole, entries: [entry('p1', 1), { op: 'share' }] })).toBe(false)
    /* Exactly the cap is a page; one over is not. */
    const one = entry('p1', 1)
    expect(isPageShape({ ...whole, entries: Array.from({ length: MAX_ENTRIES_PER_PAGE }, () => one) })).toBe(true)
    expect(isPageShape({ ...whole, entries: Array.from({ length: MAX_ENTRIES_PER_PAGE + 1 }, () => one) })).toBe(false)
  })

  it('refuses a page whose entries are not all its own, by device or by range', () => {
    const okay = { verify: () => true, hash: (value: string) => `h(${value.length})` }
    const check = (p: Page) => checkPage(p, canonicalJson(p), okay, 'key', '', speaks)
    expect(check(page({ from: 0, to: 1, entries: [] }))).toBe('malformed')
    expect(check(page({ from: 2, to: 1, entries: [] }))).toBe('malformed')
    expect(check(page({ from: 1, to: 2, entries: [entry('p1', 1), { ...entry('p2', 2), device: 'd2' } as Entry] }))).toBe('malformed')
    expect(check(page({ from: 1, to: 1, entries: [entry('p1', 1), entry('p2', 2)] }))).toBe('malformed')
    expect(check(page({ from: 2, to: 2, entries: [entry('p1', 1)] }))).toBe('malformed')
    /* One entry the version carries beside one it does not is still malformed. */
    const status: Entry = { op: 'status', state: 'reading', device: 'd1', seq: 1, at: hlcOf(1) }
    const placed: Entry = { op: 'place', pub: 'p', work: { title: 'T', author: 'A', language: 'en' }, position: 1, note: '', device: 'd1', seq: 2, at: hlcOf(2) }
    expect(checkPage(page({ v: 2, from: 1, to: 2, entries: [status, placed] }), canonicalJson(page({ v: 2, from: 1, to: 2, entries: [status, placed] })), okay, 'key', '', speaks, 2)).toBe('malformed')
  })

  it('accepts a page exactly at the size cap and refuses one character more', () => {
    const okay = { verify: () => true, hash: (value: string) => `h(${value.length})` }
    const sized = (quote: string): Page => page({ entries: [{ ...entry('p1', 1), passage: { quote, prefix: 'p', suffix: 's', chapter: 'Ch. 1' } } as Entry] })
    const base = canonicalJson(sized('')).length
    const exact = sized('x'.repeat(MAX_PAGE_CHARS - base))
    expect(canonicalJson(exact).length).toBe(MAX_PAGE_CHARS)
    expect(checkPage(exact, canonicalJson(exact), okay, 'key', '', speaks)).toBeNull()
    const over = sized('x'.repeat(MAX_PAGE_CHARS - base + 1))
    expect(checkPage(over, canonicalJson(over), okay, 'key', '', speaks)).toBe('too-large')
  })
})

describe('the entries a page carries belong to the log its claim names — WI-23.E1’s three logs', () => {
  const okay: PageCrypto = { verify: () => true, hash: () => 'h' }
  const speaks = () => true
  const check = (one: Page) => checkPage(one, canonicalJson(one), okay, 'key', '', speaks)
  const shelved: Entry = { op: 'shelf', pub: 's', device: 'd1', seq: 1, at: hlcOf(1), work: { title: 'T', author: 'A', language: 'en' } }
  const placed: Entry = { op: 'place', pub: 'x', device: 'd1', seq: 1, at: hlcOf(1), work: { title: 'T', author: 'A', language: 'en' }, position: 1, note: '' }
  const SHELF = { ids: ['paper.circle.shelf'], titles: [], author: '', language: '' }
  const LIST = { ids: ['paper.circle.list:aa11'], titles: [], author: '', language: '' }

  it('takes each kind on its own log', () => {
    expect(check(page())).toBeNull()
    expect(check(page({ work: SHELF, entries: [shelved] }))).toBeNull()
    expect(check(page({ work: LIST, entries: [placed] }))).toBeNull()
  })

  it('refuses a shelf or list operation on a per-work page, a passage on the shelf’s, and a shelving on a list’s', () => {
    /* ⚠️ Checked by version alone, a per-work page carried a `shelf` and the
       receiver applied it to the shelf section of a file about one book. */
    expect(check(page({ entries: [shelved] }))).toBe('malformed')
    expect(check(page({ entries: [placed] }))).toBe('malformed')
    expect(check(page({ work: SHELF, entries: [entry('p1', 1)] }))).toBe('malformed')
    expect(check(page({ work: LIST, entries: [shelved] }))).toBe('malformed')
  })

  it('refuses an empty page, one missing its first or last sequence, and one whose sequences do not climb', () => {
    /* ⚠️ Accepted, the receiver advanced its cursor to `to` and never asked for the omitted sequences again. */
    expect(check(page({ from: 1, to: 2, entries: [] }))).toBe('malformed')
    expect(check(page({ from: 1, to: 2, entries: [entry('p1', 1)] }))).toBe('malformed')
    expect(check(page({ from: 1, to: 2, entries: [entry('p2', 2)] }))).toBe('malformed')
    expect(check(page({ from: 1, to: 2, entries: [entry('p2', 2), entry('p1', 1)] }))).toBe('malformed')
    expect(check(page({ from: 1, to: 2, entries: [entry('p1', 1), { ...entry('p1', 1), pub: 'twin' } as Entry] }))).toBe('malformed')
    /* A gap between the ends is a page cut under an older version, and stands. */
    expect(check(page({ from: 1, to: 3, entries: [entry('p1', 1), entry('p3', 3)] }))).toBeNull()
  })
})

describe('the claim a page carries is one a request could ask for', () => {
  const whole = page()
  it('is digests within the bound, or exactly one reserved claim — and nothing between', () => {
    expect(isPageShape(whole)).toBe(true)
    expect(isPageShape({ ...whole, work: { ids: ['paper.circle.shelf'], titles: [], author: '', language: '' } })).toBe(true)
    expect(isPageShape({ ...whole, work: { ids: ['paper.circle.list:aa11'], titles: [], author: '', language: '' } })).toBe(true)
    expect(isPageShape({ ...whole, work: { ...whole.work, ids: ['#i'] } })).toBe(false)
    expect(isPageShape({ ...whole, work: { ...whole.work, titles: ['t'] } })).toBe(false)
    expect(isPageShape({ ...whole, work: { ...whole.work, author: 'a' } })).toBe(false)
    expect(isPageShape({ ...whole, work: { ...whole.work, language: 'english' } })).toBe(false)
    /* A reserved id beside a digest would match a book AND the shelf. */
    expect(isPageShape({ ...whole, work: { ...whole.work, ids: ['paper.circle.shelf', '1a'.repeat(32)] } })).toBe(false)
    expect(isPageShape({ ...whole, work: { ids: ['paper.circle.shelf'], titles: ['2b'.repeat(32)], author: '', language: '' } })).toBe(false)
    expect(isPageShape({ ...whole, work: { ...whole.work, ids: Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(64, '0')) } })).toBe(false)
    expect(isPageShape({ ...whole, work: { ...whole.work, ids: Array.from({ length: 16 }, (_, i) => i.toString(16).padStart(64, '0')) } })).toBe(true)
  })
})
