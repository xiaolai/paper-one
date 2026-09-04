import { describe, expect, it } from 'vitest'
import { MAX_COVER_BYTES } from '../../../kernel'
import { WIRE_VERSION, type WorkClaim } from '../../../kernel'
import {
  CIRCLE_PROTO,
  CIRCLE_SERVICES,
  CIRCLE_VERSION,
  MAX_PAGES_PER_ANSWER,
  MAX_CURSOR_DEVICES,
  MAX_LISTS_PER_REQUEST,
  parseListsRequest,
  parseShelfRequest,
  MAX_PAGE_CHARS,
  agreedVersion,
  parseCircleHello,
  parseCircleWelcome,
  parsePagesAnswer,
  parsePagesRequest,
  MAX_CLAIM_DIGESTS,
  MAX_ANSWER_CHARS,
  COVER_CHUNK_BYTES,
  parseCoverAnswer,
  parseCoverRequest,
} from './protocol'

const PERSON = '207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6'
/* Digests, as a claim's fields are — the parser refuses anything shorter. */
const WORK: WorkClaim = { ids: ['a'.repeat(64)], titles: ['b'.repeat(64)], author: 'c'.repeat(64), language: 'en' }

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
    expect(parsePagesRequest(request())).toEqual({ work: WORK, since: {}, v: 1 })
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

  it('reads the page version the caller names, and takes an unnamed one as v1 — WI-23.B2', () => {
    /* A v1 caller's request predates the member; a v2 caller names its
       version. Named outside what this build publishes, the request is
       refused rather than answered with a chain nobody can build. */
    expect(parsePagesRequest({ ...request(), v: 3 })?.v).toBe(3)
    expect(parsePagesRequest({ ...request(), v: 2 })?.v).toBe(2)
    expect(parsePagesRequest({ ...request(), v: 1 })?.v).toBe(1)
    expect(parsePagesRequest(request())?.v).toBe(1)
    for (const v of [0, 4, 1.5, '2', null, -1]) {
      expect(parsePagesRequest({ ...request(), v })).toBeNull()
    }
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

  it('reads a range one version wide, which is what a peer that speaks one version sends', () => {
    /* `min === max` is a range; `max < min` is not. The two are one
       character apart in the parser. */
    expect(parseCircleHello({ ...hello(), pages: { min: 2, max: 2 } })?.pages).toEqual({ min: 2, max: 2 })
    expect(parseCircleHello({ ...hello(), pages: { min: 2, max: 1 } })).toBeNull()
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

describe('a request for the lists — WI-23.E1', () => {
  const DEVICE = 'd'.repeat(64)
  const good = () => ({ since: { aa11: { [DEVICE]: 3 }, bb22: {} }, v: WIRE_VERSION })

  it('reads a cursor per list, by id', () => {
    expect(parseListsRequest(good())).toEqual(good())
    expect(parseListsRequest({ since: {}, v: 3 })).toEqual({ since: {}, v: 3 })
  })

  const bad: readonly (readonly [string, unknown])[] = [
    ['not an object', 'lists'],
    ['null', null],
    ['no version — lists are a v3 log, so an unversioned caller has none', { since: {} }],
    ['version 2', { since: {}, v: 2 }],
    ['a version above what this build publishes', { since: {}, v: WIRE_VERSION + 1 }],
    ['a version that is not an integer', { since: {}, v: 3.5 }],
    ['a version that is a string', { since: {}, v: '3' }],
    ['an extra member', { ...good(), work: {} }],
    ['a since that is a string', { since: 'aa11', v: 3 }],
    ['a since that is null', { since: null, v: 3 }],
    ['a list id that is not hex', { since: { 'not hex': {} }, v: 3 }],
    ['a list id that is empty', { since: { '': {} }, v: 3 }],
    ['a list id that is too long', { since: { ['a'.repeat(65)]: {} }, v: 3 }],
    ['a cursor that is not one', { since: { aa11: { [DEVICE]: -1 } }, v: 3 }],
    ['a cursor keyed by something that is not a device', { since: { aa11: { alice: 1 } }, v: 3 }],
  ]
  for (const [what, value] of bad) {
    it(`refuses ${what}`, () => {
      expect(parseListsRequest(value)).toBeNull()
    })
  }

  it('takes the most lists a request may name, and refuses one more', () => {
    const most: Record<string, Record<string, number>> = {}
    for (let i = 0; i < MAX_LISTS_PER_REQUEST; i++) most[i.toString(16).padStart(4, '0')] = {}
    expect(parseListsRequest({ since: most, v: 3 })?.since).toEqual(most)
    most['ffff'] = {}
    expect(Object.keys(most)).toHaveLength(MAX_LISTS_PER_REQUEST + 1)
    expect(parseListsRequest({ since: most, v: 3 })).toBeNull()
  })
})

describe('a request for the shelf — every clause', () => {
  it('requires a version of at least 2, exactly the two members, and a cursor that reads', () => {
    expect(parseShelfRequest({ since: {}, v: 2 })).toEqual({ since: {}, v: 2 })
    expect(parseShelfRequest({ since: {} })).toBeNull()
    expect(parseShelfRequest({ since: {}, v: 1 })).toBeNull()
    expect(parseShelfRequest({ since: {}, v: WIRE_VERSION + 1 })).toBeNull()
    expect(parseShelfRequest({ since: {}, v: 2, work: {} })).toBeNull()
    expect(parseShelfRequest({ since: 'x', v: 2 })).toBeNull()
    expect(parseShelfRequest({ since: { alice: 1 }, v: 2 })).toBeNull()
    expect(parseShelfRequest({ v: 2 })).toBeNull()
    expect(parseShelfRequest('shelf')).toBeNull()
  })
})

describe('the shape of a claim in a request', () => {
  const okay = () => parsePagesRequest({ work: { ...WORK }, since: {}, v: WIRE_VERSION })
  it('reads digests of sixty-four hex characters, an empty author, and a language subtag or none', () => {
    expect(okay()?.work).toEqual(WORK)
    expect(parsePagesRequest({ work: { ...WORK, author: '', language: '' }, since: {}, v: WIRE_VERSION })?.work.language).toBe('')
  })
  for (const [what, work] of [
    ['an id that is not a digest', { ...WORK, ids: ['a'] }],
    ['a title that is not a digest', { ...WORK, titles: ['moby'] }],
    ['an author that is not a digest', { ...WORK, author: 'melville' }],
    ['a language that is not a subtag', { ...WORK, language: 'english' }],
    ['a language in capitals', { ...WORK, language: 'EN' }],
    ['more ids than a claim carries', { ...WORK, ids: Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(64, '0')) }],
  ] as const) {
    it(`refuses ${what}`, () => {
      expect(parsePagesRequest({ work, since: {}, v: WIRE_VERSION })).toBeNull()
    })
  }
})

describe('a work claim on the wire, held to the letter', () => {
  const HEX = 'ab'.repeat(32)
  const ask = (work: Record<string, unknown>) => parsePagesRequest({ work, since: {} })
  it('reads exactly the most digests a claim may carry and refuses one more, a non-string among them, or a digest with anything around it', () => {
    expect(ask({ ids: Array.from({ length: MAX_CLAIM_DIGESTS }, () => HEX), titles: [], author: '', language: '' })).not.toBeNull()
    expect(ask({ ids: Array.from({ length: MAX_CLAIM_DIGESTS + 1 }, () => HEX), titles: [], author: '', language: '' })).toBeNull()
    expect(ask({ ids: [HEX, 7], titles: [], author: '', language: '' })).toBeNull()
    expect(ask({ ids: [`x${HEX}`], titles: [], author: '', language: '' })).toBeNull()
    expect(ask({ ids: [`${HEX}x`], titles: [], author: '', language: '' })).toBeNull()
    expect(ask({ ids: [HEX], titles: [], author: 7, language: '' })).toBeNull()
    expect(ask({ ids: [HEX], titles: [], author: '', language: 7 })).toBeNull()
    expect(ask({ ids: [HEX], titles: [], author: HEX, language: 'en' })).not.toBeNull()
  })
})

describe('an answer, as a whole', () => {
  it('cannot promise more with nothing in hand, and cannot outgrow the envelope', () => {
    expect(parsePagesAnswer({ pages: [], more: true })).toBeNull()
    expect(parsePagesAnswer({ pages: [], more: false })).toEqual({ pages: [], more: false })
    const page = 'x'.repeat(MAX_PAGE_CHARS)
    expect(parsePagesAnswer({ pages: Array.from({ length: 6 }, () => page), more: false })).not.toBeNull()
    expect(parsePagesAnswer({ pages: Array.from({ length: 7 }, () => page), more: false })).toBeNull()
    expect(MAX_ANSWER_CHARS).toBe(6 * MAX_PAGE_CHARS)
  })
})

describe('the cover request and its answer — WI-23.C5', () => {
  it('reads a request naming a pub and an offset, exactly, and refuses everything else', () => {
    expect(parseCoverRequest({ pub: 'ab12', offset: 0 })).toEqual({ pub: 'ab12', offset: 0 })
    expect(parseCoverRequest({ pub: 'f'.repeat(64), offset: MAX_COVER_BYTES - 1 })).toEqual({ pub: 'f'.repeat(64), offset: MAX_COVER_BYTES - 1 })
    for (const bad of [
      null,
      'ab12',
      { pub: 'ab12' },
      { pub: 'ab12', offset: 0, more: true },
      { pub: '', offset: 0 },
      { pub: 'AB12', offset: 0 },
      { pub: 'g'.repeat(64), offset: 0 },
      { pub: 'a'.repeat(65), offset: 0 },
      { pub: 'ab12', offset: -1 },
      { pub: 'ab12', offset: 1.5 },
      { pub: 'ab12', offset: MAX_COVER_BYTES },
      { pub: 7, offset: 0 },
    ]) {
      expect(parseCoverRequest(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('reads an answer of one chunk, exactly, within the bounds a chunk and a jacket have', () => {
    const chunk = { offset: 0, size: 10, bytes: 'YWJj', more: true }
    expect(parseCoverAnswer(chunk)).toEqual(chunk)
    expect(parseCoverAnswer({ ...chunk, offset: 9, more: false })).toMatchObject({ offset: 9 })
    const chars = Math.ceil(COVER_CHUNK_BYTES / 3) * 4
    expect(parseCoverAnswer({ ...chunk, size: MAX_COVER_BYTES, bytes: 'A'.repeat(chars) })).not.toBeNull()
    for (const bad of [
      null,
      { ...chunk, extra: 1 },
      { offset: 0, size: 10, bytes: 'YWJj' },
      { ...chunk, offset: -1 },
      { ...chunk, offset: 10 },
      { ...chunk, size: 0 },
      { ...chunk, size: MAX_COVER_BYTES + 1 },
      { ...chunk, size: 1.5 },
      { ...chunk, bytes: '' },
      { ...chunk, bytes: 7 },
      { ...chunk, bytes: 'A'.repeat(chars + 1) },
      { ...chunk, more: 'yes' },
    ]) {
      expect(parseCoverAnswer(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
