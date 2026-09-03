import { describe, expect, it } from 'vitest'
import { WIRE_VERSION, type WorkClaim } from '../../../kernel'
import {
  CIRCLE_PROTO,
  CIRCLE_SERVICES,
  CIRCLE_VERSION,
  MAX_PAGES_PER_ANSWER,
  MAX_CURSOR_DEVICES,
  MAX_PAGE_CHARS,
  agreedVersion,
  parseCircleHello,
  parseCircleWelcome,
  parsePagesAnswer,
  parsePagesRequest,
} from './protocol'

const PERSON = '207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6'
const WORK: WorkClaim = { ids: ['a'], titles: ['b'], author: 'c', language: 'en' }

const hello = () => ({ proto: CIRCLE_PROTO, pages: { ...CIRCLE_VERSION }, person: PERSON })
const welcome = () => ({ ...hello(), agreed: WIRE_VERSION })
const request = () => ({ work: { ...WORK }, since: {} })
const answer = () => ({ pages: ['{}'], more: false })

describe('what the wire accepts', () => {
  it('reads a well-formed hello, welcome, request and answer', () => {
    /* The positive case first: a suite of refusals passes just as happily
       against a parser that refuses everything. */
    expect(parseCircleHello(hello())).toEqual({
      proto: CIRCLE_PROTO,
      pages: CIRCLE_VERSION,
      person: PERSON,
    })
    expect(parseCircleWelcome(welcome())).toEqual({
      proto: CIRCLE_PROTO,
      pages: CIRCLE_VERSION,
      person: PERSON,
      agreed: WIRE_VERSION,
    })
    expect(parsePagesRequest(request())).toEqual({ work: WORK, since: {} })
    expect(parsePagesAnswer(answer())).toEqual({ pages: ['{}'], more: false })
  })

  it('gates both services on a grant', () => {
    /* A service with no grant is reachable by any paired device, which is not
       what a circle is. */
    for (const service of Object.values(CIRCLE_SERVICES)) {
      expect(service.grant).toBe('circle:read')
      expect(service.name.startsWith('circle.')).toBe(true)
    }
  })
})

describe('an unknown member is a refusal, not something to ignore', () => {
  /**
   * ⚠️ **THIS INVERTS THE RULE THE REST OF THE CODEBASE FOLLOWS, AND THE
   * INVERSION IS THE POINT.** Elsewhere a tolerant parser saves a reader's data
   * from one bad row. Here the SIGNATURE covers the bytes, so a field the
   * verifier ignored is a field the signer can use to mean something the
   * verifier never saw. `wire.md` states it; these tests hold it.
   */
  const cases: readonly (readonly [string, (extra: object) => unknown])[] = [
    ['hello', (extra) => parseCircleHello({ ...hello(), ...extra })],
    ['welcome', (extra) => parseCircleWelcome({ ...welcome(), ...extra })],
    ['request', (extra) => parsePagesRequest({ ...request(), ...extra })],
    ['answer', (extra) => parsePagesAnswer({ ...answer(), ...extra })],
  ]

  for (const [what, parse] of cases) {
    it(`refuses a ${what} carrying a field this build does not know`, () => {
      expect(parse({ andAlso: 1 })).toBeNull()
    })
  }

  it('refuses a work claim with an extra field', () => {
    expect(parsePagesRequest({ ...request(), work: { ...WORK, edition: 2 } })).toBeNull()
  })

  it('refuses a version range with an extra field', () => {
    expect(parseCircleHello({ ...hello(), pages: { min: 1, max: 1, hint: 2 } })).toBeNull()
  })
})

describe('what a peer can put in each field', () => {
  it('refuses anything that is not a plain object', () => {
    for (const value of [null, undefined, 1, 'x', [], [hello()], true]) {
      expect(parseCircleHello(value)).toBeNull()
      expect(parsePagesAnswer(value)).toBeNull()
    }
  })

  it('refuses a person id that is not a public key', () => {
    for (const person of [
      '',
      'alice',
      PERSON.slice(0, 63),
      `${PERSON}0`,
      PERSON.toUpperCase(),
      'g'.repeat(64),
      123,
      null,
    ]) {
      expect(parseCircleHello({ ...hello(), person })).toBeNull()
    }
  })

  it('refuses a display name where a key belongs', () => {
    /* ⚠️ A person id IS a key. `circle::admit` admits whoever the people file
       names, so a field that accepted a label would let one be installed. */
    expect(parseCircleHello({ ...hello(), person: 'Alice' })).toBeNull()
  })

  it('refuses a different protocol outright', () => {
    expect(parseCircleHello({ ...hello(), proto: CIRCLE_PROTO + 1 })).toBeNull()
    expect(parseCircleHello({ ...hello(), proto: '1' })).toBeNull()
  })

  it('refuses a range that is not one', () => {
    for (const pages of [
      { min: 2, max: 1 },
      { min: -1, max: 1 },
      { min: 1.5, max: 2 },
      { min: 1, max: Number.MAX_VALUE },
      { min: '1', max: '1' },
      null,
      [1, 1],
    ]) {
      expect(parseCircleHello({ ...hello(), pages })).toBeNull()
    }
  })

  it('refuses a cursor that is not a map of device to whole count', () => {
    for (const since of [0, -1, 1.5, '0', null, Number.NaN, [], [1]]) {
      expect(parsePagesRequest({ ...request(), since })).toBeNull()
    }
    for (const seq of [-1, 1.5, '0', null, Number.MAX_VALUE]) {
      expect(parsePagesRequest({ ...request(), since: { [PERSON]: seq } })).toBeNull()
    }
    /* A key that is not a device key — a label cannot address a stream. */
    expect(parsePagesRequest({ ...request(), since: { alice: 1 } })).toBeNull()
    expect(parsePagesRequest({ ...request(), since: { [PERSON.toUpperCase()]: 1 } })).toBeNull()
  })

  it('reads a real per-device cursor', () => {
    /* ⚠️ **PER DEVICE, AND A SINGLE NUMBER WAS WRONG.** `mergeLogs`: two of a
       person's devices both mint seq 11, so a scalar cursor over two streams
       either re-fetches everything or silently skips one. */
    const since = { [PERSON]: 7 }
    expect(parsePagesRequest({ ...request(), since })?.since).toEqual(since)
  })

  it('refuses a cursor key that only CONTAINS a device id', () => {
    /* ⚠️ **AN UNANCHORED PATTERN MATCHES A SUBSTRING**, so `x<64 hex>` and
       `<64 hex>x` would both pass — and the cursor would then be keyed by a
       string no device answers to, silently asking from zero for ever. */
    expect(parsePagesRequest({ ...request(), since: { [`x${PERSON}`]: 1 } })).toBeNull()
    expect(parsePagesRequest({ ...request(), since: { [`${PERSON}x`]: 1 } })).toBeNull()
  })

  it('accepts a cursor at zero, which is where every one starts', () => {
    expect(parsePagesRequest({ ...request(), since: { [PERSON]: 0 } })?.since).toEqual({
      [PERSON]: 0,
    })
  })

  it('accepts a cursor naming exactly as many devices as a person may have', () => {
    /* The bound is not off by one: the cap is what is allowed, not what is
       one too many. */
    const most: Record<string, number> = {}
    for (let i = 0; i < MAX_CURSOR_DEVICES; i++) most[i.toString(16).padStart(64, '0')] = 1
    expect(parsePagesRequest({ ...request(), since: most })).not.toBeNull()
  })

  it('refuses a cursor naming more devices than a person can have', () => {
    const many: Record<string, number> = {}
    for (let i = 0; i <= MAX_CURSOR_DEVICES; i++) {
      many[i.toString(16).padStart(64, '0')] = 1
    }
    expect(parsePagesRequest({ ...request(), since: many })).toBeNull()
  })

  it('refuses the right NUMBER of members with a wrong NAME', () => {
    /* ⚠️ **A COUNT AND A NAME CHECK ARE DIFFERENT CHECKS**, and a fixture that
       adds an extra field only ever exercises the count. Three members, one of
       them called something this build has never heard of. */
    const { person: _gone, ...rest } = hello()
    expect(parseCircleHello({ ...rest, who: PERSON })).toBeNull()
    const { agreed: _also, ...restWelcome } = welcome()
    expect(parseCircleWelcome({ ...restWelcome, settled: 1 })).toBeNull()
  })

  it('refuses a welcome for a protocol this build does not speak', () => {
    /* The hello is tested for this; the welcome was not, and it is the half a
       PEER controls. */
    expect(parseCircleWelcome({ ...welcome(), proto: CIRCLE_PROTO + 1 })).toBeNull()
    expect(parseCircleWelcome({ ...welcome(), proto: '1' })).toBeNull()
  })

  it('refuses a welcome with no readable range or no person', () => {
    expect(parseCircleWelcome({ ...welcome(), pages: 'any' })).toBeNull()
    expect(parseCircleWelcome({ ...welcome(), person: 'alice' })).toBeNull()
  })

  it('accepts a range that starts at zero', () => {
    /* ⚠️ **ZERO IS A VERSION.** `< 0` and `<= 0` differ only here, and a build
       that refused `min: 0` would refuse a peer whose lowest readable version
       is the first one anybody shipped. */
    expect(parseCircleHello({ ...hello(), pages: { min: 0, max: 1 } })).not.toBeNull()
  })

  it('refuses a person id wrapped in an array', () => {
    /* ⚠️ **A REGULAR EXPRESSION COERCES ITS ARGUMENT**, so `['<64 hex>']`
       stringifies to exactly the id and matches — and the parser would then
       hand an ARRAY downstream as a person id. The `typeof` test is what stops
       it, and nothing else does. */
    expect(parseCircleHello({ ...hello(), person: [PERSON] })).toBeNull()
  })

  it('refuses a work claim whose language is not a string', () => {
    /* `matchWork` compares it, and a non-string language would compare unequal
       to every real one — a book that silently matches nothing. */
    expect(parsePagesRequest({ ...request(), work: { ...WORK, language: 1 } })).toBeNull()
    expect(parsePagesRequest({ ...request(), work: { ...WORK, language: null } })).toBeNull()
  })

  it('refuses a work claim whose lists are not lists of strings', () => {
    expect(parsePagesRequest({ ...request(), work: { ...WORK, ids: [1] } })).toBeNull()
    expect(parsePagesRequest({ ...request(), work: { ...WORK, titles: 'b' } })).toBeNull()
    expect(parsePagesRequest({ ...request(), work: { ...WORK, author: 1 } })).toBeNull()
  })
})

describe('the bound that runs before a page is parsed', () => {
  /**
   * ⚠️ **`importLimits.ts` NAMES THE FAILURE: a bound that runs after the read
   * has not bounded anything.** A peer answering with a hundred thousand pages,
   * or one page of forty megabytes, must cost this side a length comparison —
   * not a hundred thousand `JSON.parse` calls.
   */
  it('refuses more pages than an answer may carry', () => {
    const many = Array.from({ length: MAX_PAGES_PER_ANSWER + 1 }, () => '{}')
    expect(parsePagesAnswer({ pages: many, more: false })).toBeNull()
  })

  it('accepts exactly the cap, so the bound is not off by one', () => {
    const most = Array.from({ length: MAX_PAGES_PER_ANSWER }, () => '{}')
    expect(parsePagesAnswer({ pages: most, more: false })).not.toBeNull()
  })

  it('refuses one page that is larger than a page may be', () => {
    expect(parsePagesAnswer({ pages: ['x'.repeat(MAX_PAGE_CHARS + 1)], more: false })).toBeNull()
  })

  it('accepts a page of exactly the cap, so the bound is not off by one', () => {
    /* The cap is what is ALLOWED. A publisher that fills a page to the limit
       would otherwise have every full page refused — and full pages are the
       ones carrying the long passages. */
    expect(parsePagesAnswer({ pages: ['x'.repeat(MAX_PAGE_CHARS)], more: false })).not.toBeNull()
  })

  it('refuses a page that is not a string, so nothing re-encodes it', () => {
    /* ⚠️ **A PAGE CROSSES AS THE BYTES IT WAS SIGNED AS.** Nested as an object
       it is re-encoded by the envelope's own JSON, and the string the recipient
       reconstructs is not the string the sender signed — so `isCanonical`
       refuses every page from a peer whose encoder orders keys differently,
       and the failure looks like corruption. */
    expect(parsePagesAnswer({ pages: [{ v: 1 }], more: false })).toBeNull()
  })

  it('refuses an answer that will not say whether there is more', () => {
    /* A missing `more` read as `false` would silently stop a backfill halfway
       and leave a reader with part of a friend's log for ever. */
    expect(parsePagesAnswer({ pages: [], more: 'yes' })).toBeNull()
    expect(parsePagesAnswer({ pages: [] })).toBeNull()
  })
})

describe('version negotiation', () => {
  it('agrees on the highest both can read', () => {
    expect(agreedVersion({ min: 1, max: 9 })).toBe(WIRE_VERSION)
  })

  it('refuses a peer with no overlap rather than guessing', () => {
    expect(agreedVersion({ min: WIRE_VERSION + 1, max: WIRE_VERSION + 2 })).toBeNull()
  })

  it('re-derives the agreed version instead of taking the peer at its word', () => {
    /* ⚠️ **A PEER THAT NAMES A VERSION OUTSIDE THE OVERLAP IS ASKING THIS SIDE
       TO READ PAGES IT CANNOT READ** — or, once v2 exists, to read v1 pages as
       v2. `SYNC_VERSION`'s history is the precedent: an unbumped peer stripped
       a field, ACKed the stripped row, and the ACK erased the sender's data. */
    expect(parseCircleWelcome({ ...welcome(), agreed: WIRE_VERSION + 1 })).toBeNull()
    expect(
      parseCircleWelcome({ ...welcome(), pages: { min: 99, max: 99 }, agreed: 99 }),
    ).toBeNull()
  })
})
