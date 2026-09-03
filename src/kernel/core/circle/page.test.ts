import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../canonicalJson'
import { hlcOf } from '../hlc'
import type { Entry } from './log'
import {
  SUPPORTED,
  WIRE_VERSION,
  chainHash,
  checkPage,
  integersOnly,
  isCanonical,
  negotiate,
  paginate,
  signedBytes,
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
  work: { ids: ['#i'], titles: ['#t'], author: '#a', language: 'en' },
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
    expect(pages[0]!.map((e) => e.pub)).toEqual(['big'])
    expect(pages[1]!.map((e) => e.pub)).toEqual(['a', 'b'])

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
    expect(pages.flat().map((e) => e.pub)).toEqual(entries.map((e) => e.pub))
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
