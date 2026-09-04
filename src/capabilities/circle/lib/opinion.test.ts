import { describe, expect, it } from 'vitest'
import { hlcOf, type Hlc } from '../../../kernel'
import { liveReview, opinionOf, publishedOpinion, republish, type Opinion } from './opinion'
import { NOTHING_PUBLISHED, logOf, type SharedFile, MAX_TAGS } from './publish'

/**
 * WI-23.B4 — what the reader thinks of a book, published as entries.
 *
 * ⚠️ **THE ITEM'S FALSIFIER IS A COUNT.** With the switch off, zero rows for a
 * rating change; with it on, one. The switch is the caller's; what is proven
 * here is that a change publishes exactly one entry, an unchanged opinion
 * publishes none, and nothing is said for an opinion never given.
 */

const DEVICE = 'd'.repeat(64)
let tick = 0
const at = (): Hlc => hlcOf(++tick)
let minted = 0
const mint = () => `rev${++minted}`

const opinion = (over: Partial<Opinion> = {}): Opinion => ({ tags: [], review: '', ...over })

describe('the opinion a record holds', () => {
  it('is its status, stars, sorted tags and review text', () => {
    expect(
      opinionOf({
        status: { state: 'reading', at: hlcOf(1) },
        rating: 4,
        tags: ['whales', 'sea'],
        review: { text: 'r', at: hlcOf(2) },
      }),
    ).toEqual({ status: 'reading', stars: 4, tags: ['sea', 'whales'], review: 'r' })
  })

  it('is empty for a record that says nothing', () => {
    expect(opinionOf({})).toEqual({ tags: [], review: '' })
  })
})

describe('publishing what changed', () => {
  it('publishes nothing at all for an opinion never given', () => {
    const next = republish(NOTHING_PUBLISHED, opinion(), DEVICE, at(), mint)
    expect(next).toBe(NOTHING_PUBLISHED)
    expect(logOf(next)).toEqual([])
  })

  it('publishes each register once when it is first given', () => {
    const next = republish(NOTHING_PUBLISHED, opinion({ status: 'reading', stars: 4, tags: ['sea'], review: 'r' }), DEVICE, at(), mint)
    expect(logOf(next).map((one) => one.op)).toEqual(['status', 'rate', 'tag', 'review'])
    expect(logOf(next).map((one) => one.seq)).toEqual([1, 2, 3, 4])
    expect(publishedOpinion(next)).toEqual({ status: 'reading', stars: 4, tags: ['sea'], review: 'r' })
  })

  it('adds exactly ONE rate entry for a rating change, and none for a rating that did not change', () => {
    const rated = republish(NOTHING_PUBLISHED, opinion({ stars: 3 }), DEVICE, at(), mint)
    expect(rated.opinions).toHaveLength(1)
    const same = republish(rated, opinion({ stars: 3 }), DEVICE, at(), mint)
    expect(same).toBe(rated)
    const changed = republish(rated, opinion({ stars: 5 }), DEVICE, at(), mint)
    expect(changed.opinions.length - rated.opinions.length).toBe(1)
    expect(changed.opinions.at(-1)).toMatchObject({ op: 'rate', stars: 5, seq: 2 })
  })

  it('publishes a status change and nothing else beside it', () => {
    const first = republish(NOTHING_PUBLISHED, opinion({ status: 'want', stars: 2 }), DEVICE, at(), mint)
    const next = republish(first, opinion({ status: 'finished', stars: 2 }), DEVICE, at(), mint)
    expect(next.opinions.slice(first.opinions.length).map((one) => one.op)).toEqual(['status'])
  })

  it('publishes tags only once there are any, then publishes their clearing', () => {
    const none = republish(NOTHING_PUBLISHED, opinion({ stars: 1 }), DEVICE, at(), mint)
    expect(none.opinions.some((one) => one.op === 'tag')).toBe(false)
    const tagged = republish(none, opinion({ stars: 1, tags: ['sea'] }), DEVICE, at(), mint)
    expect(tagged.opinions.at(-1)).toMatchObject({ op: 'tag', tags: ['sea'] })
    /* Reordered is the same set, so nothing to say. */
    expect(republish(tagged, opinion({ stars: 1, tags: ['sea'] }), DEVICE, at(), mint)).toBe(tagged)
    const cleared = republish(tagged, opinion({ stars: 1, tags: [] }), DEVICE, at(), mint)
    expect(cleared.opinions.at(-1)).toMatchObject({ op: 'tag', tags: [] })
  })

  it('edits a review as a withdrawal plus a new publication under a new pub', () => {
    const first = republish(NOTHING_PUBLISHED, opinion({ review: 'first thought' }), DEVICE, at(), mint)
    const edited = republish(first, opinion({ review: 'second thought' }), DEVICE, at(), mint)
    expect(edited.reviews).toHaveLength(2)
    expect(edited.reviews[0]!.unreviewed).toBeDefined()
    expect(edited.reviews[1]!.pub).not.toBe(edited.reviews[0]!.pub)
    expect(liveReview(edited)?.text).toBe('second thought')
    expect(logOf(edited).map((one) => one.op)).toEqual(['review', 'unreview', 'review'])
    /* Every entry has its own sequence, in one stream. */
    expect(logOf(edited).map((one) => one.seq)).toEqual([1, 2, 3])
  })

  it('takes a review back with a withdrawal alone', () => {
    const first = republish(NOTHING_PUBLISHED, opinion({ review: 'words' }), DEVICE, at(), mint)
    const gone = republish(first, opinion({ review: '' }), DEVICE, at(), mint)
    expect(gone.reviews).toHaveLength(1)
    expect(liveReview(gone)).toBeNull()
    expect(publishedOpinion(gone).review).toBe('')
    /* And once taken back, saying nothing again says nothing. */
    expect(republish(gone, opinion({ review: '' }), DEVICE, at(), mint)).toBe(gone)
  })

  it('folds the published opinion by stamp, not by row order', () => {
    const late: SharedFile = {
      ...NOTHING_PUBLISHED,
      opinions: [
        { op: 'rate', stars: 5, device: DEVICE, seq: 2, at: hlcOf(20) },
        { op: 'rate', stars: 1, device: 'e'.repeat(64), seq: 1, at: hlcOf(10) },
      ],
    }
    expect(publishedOpinion(late).stars).toBe(5)
    /* So a stale row arriving after the newest does not make the newest
       look like a change. */
    expect(republish(late, opinion({ stars: 5 }), DEVICE, at(), mint)).toBe(late)
  })

  it('continues the device’s own sequence past its passages', () => {
    const held: SharedFile = {
      ...NOTHING_PUBLISHED,
      publications: [
        {
          pub: 'p1',
          markId: 'm1',
          device: DEVICE,
          seq: 7,
          at: hlcOf(1),
          passage: { quote: 'q', prefix: '', suffix: '', chapter: '' },
        },
      ],
    }
    const next = republish(held, opinion({ stars: 4 }), DEVICE, at(), mint)
    expect(next.opinions[0]!.seq).toBe(8)
  })
})

describe('every clause of the published fold — one row each', () => {
  const row = (op: 'status' | 'rate' | 'tag', n: number, value: unknown) =>
    ({ op, device: DEVICE, seq: n, at: hlcOf(n), ...(op === 'status' ? { state: value } : op === 'rate' ? { stars: value } : { tags: value }) }) as SharedFile['opinions'][number]
  const stored = (opinions: readonly SharedFile['opinions'][number][]): SharedFile => ({ ...NOTHING_PUBLISHED, opinions })

  it('takes the newest status by stamp, whichever row comes first', () => {
    expect(publishedOpinion(stored([row('status', 1, 'want'), row('status', 2, 'finished')])).status).toBe('finished')
    expect(publishedOpinion(stored([row('status', 2, 'finished'), row('status', 1, 'want')])).status).toBe('finished')
  })

  it('takes the newest tags by stamp, whichever row comes first, and sorts them', () => {
    expect(publishedOpinion(stored([row('tag', 1, ['a']), row('tag', 2, ['whales', 'sea'])])).tags).toEqual(['sea', 'whales'])
    expect(publishedOpinion(stored([row('tag', 2, ['whales', 'sea']), row('tag', 1, ['a'])])).tags).toEqual(['sea', 'whales'])
  })

  it('takes the newest stars by stamp, whichever row comes first', () => {
    expect(publishedOpinion(stored([row('rate', 1, 1), row('rate', 2, 5)])).stars).toBe(5)
    expect(publishedOpinion(stored([row('rate', 2, 5), row('rate', 1, 1)])).stars).toBe(5)
  })

  it('breaks an equal stamp by device and sequence, whichever order the file holds the rows in', () => {
    /* One device never stamps twice in one instant; if a file holds it, the
       rule is `compareEntries` — the later sequence — so two readers of the
       file agree, and so do two replicas holding the rows the other way round. */
    const later = { ...row('status', 1, 'finished'), seq: 2 }
    expect(publishedOpinion(stored([row('status', 1, 'want'), later])).status).toBe('finished')
    expect(publishedOpinion(stored([later, row('status', 1, 'want')])).status).toBe('finished')
    expect(publishedOpinion(stored([row('rate', 1, 1), { ...row('rate', 1, 5), seq: 2 }])).stars).toBe(5)
    expect(publishedOpinion(stored([{ ...row('rate', 1, 5), seq: 2 }, row('rate', 1, 1)])).stars).toBe(5)
    expect(publishedOpinion(stored([row('tag', 1, ['a']), { ...row('tag', 1, ['b']), seq: 2 }])).tags).toEqual(['b'])
    expect(publishedOpinion(stored([{ ...row('tag', 1, ['b']), seq: 2 }, row('tag', 1, ['a'])])).tags).toEqual(['b'])
  })

  it('reads each register from rows of its own kind only', () => {
    const only = (op: 'status' | 'rate' | 'tag', value: unknown) => publishedOpinion(stored([row(op, 1, value)]))
    expect(only('rate', 3)).toEqual({ stars: 3, tags: [], review: '' })
    expect(only('status', 'reading')).toEqual({ status: 'reading', tags: [], review: '' })
    expect(only('tag', ['sea'])).toEqual({ tags: ['sea'], review: '' })
    expect(publishedOpinion(NOTHING_PUBLISHED)).toEqual({ tags: [], review: '' })
  })

  it('leaves out a stars key the record does not have, rather than carrying undefined', () => {
    expect('stars' in opinionOf({})).toBe(false)
    expect('status' in opinionOf({})).toBe(false)
  })
})

describe('every clause of republish — one row each', () => {
  const mint = () => 'rev'
  it('says nothing again for a status, stars or tags that did not change', () => {
    const held = republish(NOTHING_PUBLISHED, opinion({ status: 'want', stars: 2, tags: ['sea'] }), DEVICE, at(), mint)
    expect(republish(held, opinion({ status: 'want', stars: 2, tags: ['sea'] }), DEVICE, at(), mint)).toBe(held)
  })

  it('does not publish an ABSENT status or stars over a published one', () => {
    /* The record has no status; the log has one. Nothing to say: absence is
       not a word, and `state: undefined` must never be written. */
    const held = republish(NOTHING_PUBLISHED, opinion({ status: 'want', stars: 2 }), DEVICE, at(), mint)
    const next = republish(held, opinion({}), DEVICE, at(), mint)
    expect(next).toBe(held)
    expect(next.opinions.every((one) => one.op !== 'status' || one.state !== undefined)).toBe(true)
  })

  it('publishes tags that differ in one element with the same count', () => {
    const held = republish(NOTHING_PUBLISHED, opinion({ tags: ['sea', 'whales'] }), DEVICE, at(), mint)
    const next = republish(held, opinion({ tags: ['sea', 'ships'] }), DEVICE, at(), mint)
    expect(next.opinions.at(-1)).toMatchObject({ op: 'tag', tags: ['sea', 'ships'] })
    /* The same count, the same elements: nothing. */
    expect(republish(next, opinion({ tags: ['sea', 'ships'] }), DEVICE, at(), mint)).toBe(next)
  })

  it('publishes each register alone when only it changed', () => {
    const held = republish(NOTHING_PUBLISHED, opinion({ status: 'want', stars: 2, tags: ['sea'], review: 'r' }), DEVICE, at(), mint)
    const status = republish(held, opinion({ status: 'reading', stars: 2, tags: ['sea'], review: 'r' }), DEVICE, at(), mint)
    expect(logOf(status).slice(4).map((one) => one.op)).toEqual(['status'])
    const stars = republish(held, opinion({ status: 'want', stars: 5, tags: ['sea'], review: 'r' }), DEVICE, at(), mint)
    expect(logOf(stars).slice(4).map((one) => one.op)).toEqual(['rate'])
    const tags = republish(held, opinion({ status: 'want', stars: 2, tags: [], review: 'r' }), DEVICE, at(), mint)
    expect(logOf(tags).slice(4).map((one) => one.op)).toEqual(['tag'])
  })
})

describe('the rest of republish and the fold — one row each', () => {
  const mint = () => 'rev'
  it('reads no status from a rating row', () => {
    const rated: SharedFile = { ...NOTHING_PUBLISHED, opinions: [{ op: 'rate', stars: 3, device: DEVICE, seq: 1, at: hlcOf(1) }] }
    expect('status' in publishedOpinion(rated)).toBe(false)
    expect('stars' in publishedOpinion(NOTHING_PUBLISHED)).toBe(false)
  })

  it('publishes an empty tag list over a published one, and nothing for nothing over nothing', () => {
    const tagged = republish(NOTHING_PUBLISHED, opinion({ tags: ['sea'] }), DEVICE, at(), mint)
    const cleared = republish(tagged, opinion({ tags: [] }), DEVICE, at(), mint)
    expect(cleared.opinions.at(-1)).toMatchObject({ op: 'tag', tags: [] })
    /* Nothing said and nothing to say — even beside a status row. */
    const status = republish(NOTHING_PUBLISHED, opinion({ status: 'want' }), DEVICE, at(), mint)
    expect(republish(status, opinion({ status: 'want', tags: [] }), DEVICE, at(), mint)).toBe(status)
  })

  it('takes back only the live review when the text changes, leaving an older withdrawal’s stamp alone', () => {
    let mints = 0
    const minted = () => `rev${++mints}`
    const first = republish(NOTHING_PUBLISHED, opinion({ review: 'one' }), DEVICE, at(), minted)
    const second = republish(first, opinion({ review: 'two' }), DEVICE, at(), minted)
    const older = second.reviews[0]!
    expect(older.unreviewed).toBeDefined()
    const third = republish(second, opinion({ review: 'three' }), DEVICE, at(), minted)
    expect(third.reviews[0]).toBe(older)
    expect(third.reviews.map((row) => [row.text, row.unreviewed !== undefined])).toEqual([
      ['one', true],
      ['two', true],
      ['three', false],
    ])
  })
})

describe('the live review is the newest by stamp, and a change takes every live one back', () => {
  it('picks the newest of two live reviews however the rows are ordered, and withdraws both on a change', () => {
    let mints = 0
    const minted = () => `rev${++mints}`
    /* Two devices each published a review; the file lists the phone's first. */
    const held: SharedFile = {
      ...NOTHING_PUBLISHED,
      reviews: [
        { pub: 'r-phone', text: 'phone', device: 'e'.repeat(64), seq: 1, at: hlcOf(9) },
        { pub: 'r-laptop', text: 'laptop', device: DEVICE, seq: 1, at: hlcOf(2) },
      ],
    }
    expect(liveReview(held)?.text).toBe('phone')
    expect(publishedOpinion(held).review).toBe('phone')
    const next = republish(held, opinion({ review: 'both, superseded' }), DEVICE, at(), minted)
    expect(next.reviews.filter((row) => row.unreviewed !== undefined).map((row) => row.pub).sort()).toEqual(['r-laptop', 'r-phone'])
    expect(liveReview(next)?.text).toBe('both, superseded')
    /* Both withdrawals in THIS device's stream — the phone's review included,
       which filed under the phone was a tombstone this device never served
       and a number the phone could mint again. */
    const gone = logOf(next).filter((one) => one.op === 'unreview')
    expect(gone.map((one) => [one.device, one.seq])).toEqual([
      [DEVICE, 2],
      [DEVICE, 3],
    ])
    expect(logOf(next).find((one) => one.op === 'review' && one.pub === 'rev1')).toMatchObject({ device: DEVICE, seq: 4 })
  })

  it('refuses a withdrawal that would need a sequence past the safe integers', () => {
    const held: SharedFile = {
      ...NOTHING_PUBLISHED,
      reviews: [
        { pub: 'a', text: 'a', device: DEVICE, seq: Number.MAX_SAFE_INTEGER - 1, at: hlcOf(1) },
        { pub: 'b', text: 'b', device: 'e'.repeat(64), seq: 1, at: hlcOf(2) },
      ],
    }
    /* The first take-back takes the last safe number; the second has none. */
    expect(() => republish(held, opinion({ review: 'c' }), DEVICE, hlcOf(3), () => 'c')).toThrow(/run out of sequence numbers/u)
  })
})

describe('registers stamped alike', () => {
  it('fold to the same winner whichever order the rows are read in', () => {
    const a = { op: 'status' as const, state: 'reading' as const, device: 'a'.repeat(64), seq: 1, at: hlcOf(7) }
    const b = { op: 'status' as const, state: 'finished' as const, device: 'b'.repeat(64), seq: 1, at: hlcOf(7) }
    const one: SharedFile = { ...NOTHING_PUBLISHED, opinions: [a, b] }
    const other: SharedFile = { ...NOTHING_PUBLISHED, opinions: [b, a] }
    expect(publishedOpinion(one).status).toBe(publishedOpinion(other).status)
    const ra = { op: 'rate' as const, stars: 2 as const, device: 'a'.repeat(64), seq: 2, at: hlcOf(8) }
    const rb = { op: 'rate' as const, stars: 5 as const, device: 'b'.repeat(64), seq: 2, at: hlcOf(8) }
    expect(publishedOpinion({ ...NOTHING_PUBLISHED, opinions: [ra, rb] }).stars).toBe(publishedOpinion({ ...NOTHING_PUBLISHED, opinions: [rb, ra] }).stars)
    const ta = { op: 'tag' as const, tags: ['x'], device: 'a'.repeat(64), seq: 3, at: hlcOf(9) }
    const tb = { op: 'tag' as const, tags: ['y'], device: 'b'.repeat(64), seq: 3, at: hlcOf(9) }
    expect(publishedOpinion({ ...NOTHING_PUBLISHED, opinions: [ta, tb] }).tags).toEqual(publishedOpinion({ ...NOTHING_PUBLISHED, opinions: [tb, ta] }).tags)
  })
})

describe('the tags a record publishes', () => {
  it('stop at the wire’s limit, the first by sort order', () => {
    const tags = Array.from({ length: 300 }, (_, i) => `tag${String(i).padStart(3, '0')}`)
    const published = opinionOf({ tags })
    expect(published.tags).toHaveLength(MAX_TAGS)
    expect(published.tags[0]).toBe('tag000')
    expect(published.tags.at(-1)).toBe('tag255')
  })
})

describe('rows that compare equal — one stamp, one device, one sequence', () => {
  it('keep the FIRST in file order, for the registers and for the reviews', () => {
    const twin = (state: 'want' | 'finished') => ({ op: 'status' as const, state, device: DEVICE, seq: 1, at: hlcOf(7) })
    expect(publishedOpinion({ ...NOTHING_PUBLISHED, opinions: [twin('want'), twin('finished')] }).status).toBe('want')
    expect(publishedOpinion({ ...NOTHING_PUBLISHED, opinions: [twin('finished'), twin('want')] }).status).toBe('finished')
    const rate = (stars: 1 | 5) => ({ op: 'rate' as const, stars, device: DEVICE, seq: 1, at: hlcOf(7) })
    expect(publishedOpinion({ ...NOTHING_PUBLISHED, opinions: [rate(1), rate(5)] }).stars).toBe(1)
    const tag = (tags: string[]) => ({ op: 'tag' as const, tags, device: DEVICE, seq: 1, at: hlcOf(7) })
    expect(publishedOpinion({ ...NOTHING_PUBLISHED, opinions: [tag(['a']), tag(['b'])] }).tags).toEqual(['a'])
    const review = (text: string) => ({ pub: text, text, device: DEVICE, seq: 2, at: hlcOf(8) })
    expect(liveReview({ ...NOTHING_PUBLISHED, reviews: [review('first'), review('second')] })?.text).toBe('first')
    /* And a genuinely later review still wins over an earlier one whichever order they are held in. */
    const later = { pub: 'later', text: 'later', device: DEVICE, seq: 3, at: hlcOf(9) }
    expect(liveReview({ ...NOTHING_PUBLISHED, reviews: [later, review('first')] })?.text).toBe('later')
  })
})

describe('reviews, ordered and taken back', () => {
  it('lets the later review win whichever order the rows are held in, and numbers two take-backs one after the other', () => {
    const first = { pub: 'first', text: 'first', device: DEVICE, seq: 2, at: hlcOf(8) }
    const later = { pub: 'later', text: 'later', device: DEVICE, seq: 3, at: hlcOf(9) }
    expect(liveReview({ ...NOTHING_PUBLISHED, reviews: [first, later] })?.text).toBe('later')
    const held = { ...NOTHING_PUBLISHED, reviews: [first, { ...later, device: 'e'.repeat(64), seq: 1 }] }
    const next = republish(held, opinion({ review: 'third' }), DEVICE, hlcOf(20), () => 'third')
    const gone = next.reviews.filter((row) => row.unreviewed !== undefined).map((row) => row.unreviewed!.seq)
    expect(gone).toEqual([3, 4])
  })
})
