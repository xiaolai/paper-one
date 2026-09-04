import { describe, expect, it } from 'vitest'
import type { BookRecord } from '../../../kernel'
import { makeHlc } from './clock'
import { toWire } from './merge'
import {
  parsePullPage,
  parsePullRequest,
  parsePushAck,
  parsePushGroup,
  parseContentAnswer,
  parseSyncHello,
  parseWireCards,
  parseWireMarks,
  parseSyncWelcome,
} from './protocol'

/**
 * The wire's parsers, pinned on the rules an audit found them missing (audit-
 * fix round 1, findings #57–59, #331–335, #716). Every rule here is of one
 * shape: a message that would have been REINTERPRETED — thinned, coerced,
 * or read with less in it — is refused instead. An accepted push is acked
 * and the ack clears the sender's revision, so "accept less than was sent"
 * is "lose it for good"; nothing on this boundary may be quiet.
 */

const HLC = makeHlc(1_700_000_000_000, 0, 'ffffffffffffffff')
const record: BookRecord = { title: 'T', author: 'A', addedAt: 1_700_000_000_000 }
const wire = toWire(record)
const mark = {
  id: 'm1',
  bookId: 'book:x',
  kind: 'highlight',
  cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:4)',
  sectionIndex: 0,
  text: 'four',
  note: '',
  chapter: 'One',
  createdAt: 1_700_000_000_000,
}
const card = {
  id: 'c1',
  bookId: 'book:x',
  kind: 'Idea',
  body: 'an idea',
  answer: '',
  source: 'x',
  cfi: 'epubcfi(/6/2!/4/2)',
  createdAt: 1_700_000_000_000,
}

describe('parseWireMarks and parseWireCards refuse a list they would thin', () => {
  it('a valid marks list survives whole', () => {
    expect(parseWireMarks([mark])).toHaveLength(1)
  })
  it('one malformed row refuses the whole list rather than dropping the row', () => {
    expect(parseWireMarks([mark, { id: 'bad' }])).toBeNull()
  })
  it('a duplicated mark id refuses the list — the dedupe is a thinning too', () => {
    expect(parseWireMarks([mark, { ...mark }])).toBeNull()
  })
  it('a valid cards list survives whole, and a thinned one is refused', () => {
    expect(parseWireCards([card])).toHaveLength(1)
    expect(parseWireCards([card, { id: 'bad' }])).toBeNull()
    expect(parseWireCards([card, { ...card }])).toBeNull()
  })
})

describe('parsePushGroup — revisions correlate with payloads', () => {
  const base = { book: 'book:x', hasContent: false }
  it('a record rev needs its record, or a removal, or a restore', () => {
    expect(parsePushGroup({ ...base, revs: { record: 1 }, record: wire })).not.toBeNull()
    expect(parsePushGroup({ ...base, revs: { record: 1 } })).toBeNull()
    expect(parsePushGroup({ ...base, revs: { record: 1, removed: 2 }, removed: { at: HLC } })).not.toBeNull()
    expect(parsePushGroup({ ...base, revs: { record: 1, removed: 2 }, record: wire, live: { at: HLC } })).not.toBeNull()
  })
  it('a marks rev needs marks, or intent', () => {
    expect(parsePushGroup({ ...base, revs: { marks: 1 }, marks: [mark] })).not.toBeNull()
    expect(parsePushGroup({ ...base, revs: { marks: 1 }, marks: [] })).not.toBeNull()
    expect(parsePushGroup({ ...base, revs: { marks: 1 } })).toBeNull()
  })
  it('a removed rev needs a removal or a restore behind it', () => {
    expect(parsePushGroup({ ...base, revs: { removed: 1 } })).toBeNull()
    expect(parsePushGroup({ ...base, revs: { removed: 1 }, removed: { at: HLC } })).not.toBeNull()
  })
  it('a payload may travel without its rev — a restore re-sends the record under `removed`', () => {
    expect(parsePushGroup({ ...base, revs: { removed: 1 }, record: wire, live: { at: HLC } })).not.toBeNull()
  })
  it('cards live only in the reserved empty-book group, and that group carries only cards', () => {
    expect(parsePushGroup({ book: '', hasContent: false, revs: { cards: 1 }, cards: [card] })).not.toBeNull()
    expect(parsePushGroup({ ...base, revs: { cards: 1 }, cards: [card] })).toBeNull()
    expect(parsePushGroup({ ...base, revs: { record: 1 }, record: wire, cards: [card] })).toBeNull()
    expect(parsePushGroup({ book: '', hasContent: false, revs: { cards: 1 } })).toBeNull()
  })
})

describe('required and optional fields are typed, not coerced', () => {
  it('`hasContent` must be a boolean — absent is malformed, not false', () => {
    expect(parsePushGroup({ book: 'book:x', revs: { record: 1 }, record: wire })).toBeNull()
    expect(parsePushGroup({ book: 'book:x', hasContent: 'yes', revs: { record: 1 }, record: wire })).toBeNull()
    expect(parsePushGroup({ book: 'book:x', hasContent: false, revs: { record: 1 }, record: wire })).not.toBeNull()
  })
  it('a present optional of the wrong type refuses the message instead of vanishing', () => {
    const ok = { book: 'book:x', hasContent: false, revs: { record: 1 }, record: wire }
    expect(parsePushGroup({ ...ok, contentHash: 42 })).toBeNull()
    expect(parsePushGroup({ ...ok, format: ['epub'] })).toBeNull()
    expect(parsePushGroup({ ...ok, size: -1 })).toBeNull()
    expect(parsePushGroup({ ...ok, size: 1.5 })).toBeNull()
    expect(parsePushGroup({ ...ok, size: Number.MAX_SAFE_INTEGER + 2 })).toBeNull()
    expect(parsePushGroup({ ...ok, size: 12, contentHash: 'ab'.repeat(32), format: 'epub' })).toMatchObject({ size: 12 })
  })
  it('a cover needs a nonnegative safe size', () => {
    const ok = { book: 'book:x', hasContent: false, revs: { record: 1 }, record: wire }
    expect(parsePushGroup({ ...ok, cover: { name: 'cover.jpg', size: -3, hash: 'ab'.repeat(32) } })).toBeNull()
    expect(parsePushGroup({ ...ok, cover: { name: 'cover.jpg', size: 3, hash: 'ab'.repeat(32) } })).toMatchObject({ cover: { size: 3 } })
  })
  it('pull rows follow the same rules', () => {
    const row = { book: 'book:x', seq: 1, record: wire, hasContent: false }
    const page = (r: Record<string, unknown>) => parsePullPage({ rows: [r], removals: [], nextSince: 1, done: true })
    expect(page(row)).not.toBeNull()
    expect(page({ ...row, hasContent: undefined })).toBeNull()
    expect(page({ ...row, size: 'big' })).toBeNull()
    expect(page({ ...row, coverAt: -1 })).toBeNull()
    expect(page({ ...row, marksDigest: 7 })).toBeNull()
    /* A present hash is a digest, as a push group's is — a pull row was the
       one message that took any string for it. */
    expect(page({ ...row, contentHash: 'h' })).toBeNull()
    expect(page({ ...row, contentHash: 'AB'.repeat(32) })).toBeNull()
    expect(page({ ...row, contentHash: 'ab'.repeat(32) })).toMatchObject({ rows: [{ contentHash: 'ab'.repeat(32) }] })
  })
})

describe('sequences and versions are finite safe integers', () => {
  it('a seq past 2^53 is refused', () => {
    const ack = { book: 'book:x', revs: { record: Number.MAX_SAFE_INTEGER + 2 } }
    expect(parsePushAck(ack)).toBeNull()
    expect(parsePushAck({ book: 'book:x', revs: { record: 1 } })).not.toBeNull()
  })
  it('an infinite or fractional version bound is refused', () => {
    const hello = (sync: unknown) => parseSyncHello({ proto: 1, journalFormat: 1, services: { sync }, device: 'd', role: 'shelf', clock: HLC })
    expect(hello([1, Number.POSITIVE_INFINITY])).toBeNull()
    expect(hello([1.5, 2])).toBeNull()
    expect(hello([-1, 2])).toBeNull()
    expect(hello([2, 2])).not.toBeNull()
  })
  it('an inverted pull window is refused', () => {
    expect(parsePullRequest({ since: 5, until: 3 })).toBeNull()
    expect(parsePullRequest({ since: 3, until: 3 })).not.toBeNull()
    expect(parsePullRequest({ since: 3, until: 5, cardsDigest: 9 })).toBeNull()
  })
})

describe('the numbers a hello and a content answer may carry', () => {
  const HELLO = { proto: 1, journalFormat: 1, services: { sync: [4, 5] }, device: 'd', role: 'shelf', clock: '018bcfe56809-0000-1d8865efc2eaef44' }
  it('reads a hello with integer versions and refuses fractions, negatives and NaN', () => {
    expect(parseSyncHello(HELLO)).not.toBeNull()
    for (const proto of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '1']) expect(parseSyncHello({ ...HELLO, proto })).toBeNull()
    for (const journalFormat of [0.5, -2, Number.NaN]) expect(parseSyncHello({ ...HELLO, journalFormat })).toBeNull()
    /* Zero is a version: the first format, the first protocol. */
    expect(parseSyncHello({ ...HELLO, proto: 0, journalFormat: 0 })).not.toBeNull()
  })

  const ANSWER = { folder: 'books/b', name: 'content.epub', size: 12, contentHash: 'a'.repeat(64), coverName: null }
  it('reads a content answer with a byte count and a digest, and refuses anything else in their place', () => {
    expect(parseContentAnswer(ANSWER)).toEqual(ANSWER)
    for (const size of [-1, 1.5, Number.NaN, '12']) expect(parseContentAnswer({ ...ANSWER, size })).toBeNull()
    for (const contentHash of ['x', 'A'.repeat(64), 'a'.repeat(63), 7]) expect(parseContentAnswer({ ...ANSWER, contentHash })).toBeNull()
  })

  it('takes the cover’s facts as one tuple, all or none', () => {
    const facts = { ...ANSWER, coverName: 'cover.jpg', coverSize: 3, coverHash: 'b'.repeat(64) }
    expect(parseContentAnswer(facts)).toEqual(facts)
    expect(parseContentAnswer({ ...ANSWER, coverName: 'cover.jpg' })).toEqual({ ...ANSWER, coverName: 'cover.jpg' })
    expect(parseContentAnswer({ ...facts, coverHash: undefined })).toBeNull()
    expect(parseContentAnswer({ ...facts, coverSize: undefined })).toBeNull()
    expect(parseContentAnswer({ ...facts, coverSize: -1 })).toBeNull()
    expect(parseContentAnswer({ ...facts, coverHash: 'short' })).toBeNull()
    expect(parseContentAnswer({ ...facts, coverName: null })).toBeNull()
  })
})

describe('parseSyncWelcome', () => {
  const welcome = { services: { sync: [1, 1] }, clock: '018bcfe56809-0000-1d8865efc2eaef44', epoch: 'e1', hubSeq: 0, journalFormat: 1 }
  it('reads a well-formed welcome', () => {
    expect(parseSyncWelcome(welcome)).toEqual({ clock: welcome.clock, epoch: 'e1', hubSeq: 0, journalFormat: 1, services: { sync: [1, 1] } })
  })
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', Number.MAX_SAFE_INTEGER + 1])('refuses a journal format of %s, as the hello does', (journalFormat) => {
    expect(parseSyncWelcome({ ...welcome, journalFormat })).toBeNull()
  })
})

describe('parseContentAnswer, held to the letter', () => {
  const HASH = 'ab'.repeat(32)
  const answer = { folder: 'books/x', name: 'content.epub', size: 0, contentHash: HASH, coverName: null }
  it('reads a size of zero and a whole hash, and refuses a hash with anything before or after its sixty-four characters', () => {
    expect(parseContentAnswer(answer)).toMatchObject({ size: 0, contentHash: HASH })
    expect(parseContentAnswer({ ...answer, contentHash: `x${HASH}` })).toBeNull()
    expect(parseContentAnswer({ ...answer, contentHash: `${HASH}x` })).toBeNull()
    expect(parseContentAnswer({ ...answer, contentHash: 7 })).toBeNull()
    expect(parseContentAnswer({ ...answer, size: -1 })).toBeNull()
  })
  it('reads a cover of zero bytes with its hash, and refuses a cover hash that is not a string', () => {
    expect(parseContentAnswer({ ...answer, coverName: 'cover.jpg', coverSize: 0, coverHash: HASH })).toMatchObject({ coverSize: 0, coverHash: HASH })
    expect(parseContentAnswer({ ...answer, coverName: 'cover.jpg', coverSize: 0, coverHash: 7 })).toBeNull()
    expect(parseContentAnswer({ ...answer, coverName: 'cover.jpg', coverSize: -1, coverHash: HASH })).toBeNull()
    expect(parseContentAnswer({ ...answer, coverName: 'cover.jpg', coverSize: 1, coverHash: `${HASH}x` })).toBeNull()
  })
})

describe('a pull page names each journal position once, and a hash is a digest or nothing', () => {
  const DIGEST = 'ab'.repeat(32)
  const row = { book: 'book:x', seq: 1, record: wire, hasContent: false }
  const page = (over: Record<string, unknown>) => parsePullPage({ rows: [], removals: [], nextSince: 3, done: true, ...over })

  it('refuses a removal with no book, or one that is not a removal at all', () => {
    expect(page({ removals: [{ book: 'book:x', seq: 2, at: HLC }] })).not.toBeNull()
    expect(page({ removals: [{ book: '', seq: 2, at: HLC }] })).toBeNull()
    expect(page({ removals: [{ book: 7, seq: 2, at: HLC }] })).toBeNull()
    expect(page({ removals: [null] })).toBeNull()
    expect(page({ removals: ['book:x'] })).toBeNull()
  })

  it('refuses a page that carries one seq twice, across rows and removals alike', () => {
    expect(page({ rows: [row], removals: [{ book: 'book:y', seq: 2, at: HLC }] })).not.toBeNull()
    expect(page({ rows: [row], removals: [{ book: 'book:y', seq: 1, at: HLC }] })).toBeNull()
    expect(page({ rows: [row, { ...row, book: 'book:y' }] })).toBeNull()
    expect(page({ removals: [{ book: 'book:x', seq: 2, at: HLC }, { book: 'book:y', seq: 2, at: HLC }] })).toBeNull()
  })

  it('accepts the empty hash a shelf answers when it could not hash, and nothing else short of a digest', () => {
    const answer = { folder: 'f', name: 'content.epub', size: 0, contentHash: '', coverName: null }
    expect(parseContentAnswer(answer)).toMatchObject({ contentHash: '' })
    expect(parseContentAnswer({ ...answer, contentHash: 'h' })).toBeNull()
    expect(parseContentAnswer({ ...answer, contentHash: DIGEST })).toMatchObject({ contentHash: DIGEST })
  })

  it('holds a pushed content hash and cover hash to the digest rule', () => {
    const ok = { book: 'book:x', hasContent: false, revs: { record: 1 }, record: wire }
    expect(parsePushGroup({ ...ok, contentHash: '' })).toBeNull()
    expect(parsePushGroup({ ...ok, contentHash: 'h' })).toBeNull()
    expect(parsePushGroup({ ...ok, contentHash: 'A'.repeat(64) })).toBeNull()
    expect(parsePushGroup({ ...ok, cover: { name: 'cover.jpg', size: 3, hash: 'h' } })).toBeNull()
    expect(parsePushGroup({ ...ok, cover: { name: 'cover.jpg', size: 3, hash: DIGEST } })).toMatchObject({ cover: { hash: DIGEST } })
    expect(parsePushGroup({ ...ok, cover: { name: 'cover.webp', size: 3, hash: DIGEST } })).toMatchObject({ cover: { name: 'cover.webp' } })
    expect(parsePushGroup({ ...ok, cover: { name: 'cover.png', size: 3, hash: DIGEST } })).toBeNull()
  })
})
