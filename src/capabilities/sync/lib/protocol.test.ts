import { describe, expect, it } from 'vitest'
import type { BookRecord } from '../../../kernel'
import { makeHlc } from './clock'
import { toWire } from './merge'
import {
  parsePullPage,
  parsePullRequest,
  parsePushAck,
  parsePushGroup,
  parseSyncHello,
  parseWireCards,
  parseWireMarks,
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
    expect(parsePushGroup({ ...ok, size: 12, contentHash: 'h', format: 'epub' })).toMatchObject({ size: 12 })
  })
  it('a cover needs a nonnegative safe size', () => {
    const ok = { book: 'book:x', hasContent: false, revs: { record: 1 }, record: wire }
    expect(parsePushGroup({ ...ok, cover: { name: 'cover.jpg', size: -3, hash: 'h' } })).toBeNull()
    expect(parsePushGroup({ ...ok, cover: { name: 'cover.jpg', size: 3, hash: 'h' } })).toMatchObject({ cover: { size: 3 } })
  })
  it('pull rows follow the same rules', () => {
    const row = { book: 'book:x', seq: 1, record: wire, hasContent: false }
    const page = (r: Record<string, unknown>) => parsePullPage({ rows: [r], removals: [], nextSince: 1, done: true })
    expect(page(row)).not.toBeNull()
    expect(page({ ...row, hasContent: undefined })).toBeNull()
    expect(page({ ...row, size: 'big' })).toBeNull()
    expect(page({ ...row, coverAt: -1 })).toBeNull()
    expect(page({ ...row, marksDigest: 7 })).toBeNull()
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
