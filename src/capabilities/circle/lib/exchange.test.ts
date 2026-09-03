import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import { WIRE_VERSION, canonicalJson, makeHlc, type Passage } from '../../../kernel'
import { pageCrypto } from './crypto'
import {
  answerPages,
  bookFor,
  bookVia,
  claimOf,
  indexOf,
  welcome,
  type BookLike,
  type Serving,
} from './exchange'
import { CIRCLE_PROTO, CIRCLE_VERSION } from './protocol'
import { NOTHING_PUBLISHED, share, type Publisher, type SharedFile } from './publish'
import { delegationBytes, takePages, type Ledger, type SignedDelegation } from './receive'
import { NOTHING_SHARED } from './store'

hashes.sha512 = sha512

const NOW = 1_700_000_000_000

function keypair(seed: string) {
  const secret = utf8ToBytes(seed.padEnd(32, '.')).slice(0, 32)
  return { secret, id: bytesToHex(getPublicKey(secret)) }
}
const PERSON = keypair('person')
const DEVICE = keypair('device')

const MOBY: BookLike = {
  id: 'book:moby',
  title: 'Moby-Dick; or, The Whale',
  author: 'Herman Melville',
  identifier: 'isbn:9780142437247',
  languages: ['en-GB'],
}

const passage = (quote: string): Passage => ({ quote, prefix: 'a', suffix: 'b', chapter: 'One' })

function delegationFor(device: string): string {
  const body = {
    person: PERSON.id,
    device,
    notBefore: NOW - 1_000,
    notAfter: NOW + 1_000_000,
    roster: 0,
  }
  const sig = bytesToHex(
    sign(utf8ToBytes(delegationBytes({ ...body, sig: '' } as SignedDelegation)), PERSON.secret),
  )
  return canonicalJson({ ...body, sig })
}

const publisher = (): Publisher => ({
  person: PERSON.id,
  device: DEVICE.id,
  work: claimOf(MOBY),
  roster: [DEVICE.id],
  revocations: 0,
  delegation: delegationFor(DEVICE.id),
  sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), DEVICE.secret))),
})

function published(): SharedFile {
  return share(
    NOTHING_PUBLISHED,
    { markId: 'm1', passage: passage('call me ishmael'), device: DEVICE.id },
    'pub1',
    makeHlc(NOW, 0, DEVICE.id.slice(0, 16)),
  ).held
}

function serving(over: Partial<Serving> = {}): Serving {
  return {
    books: [MOBY],
    shared: () => Promise.resolve(published()),
    seal: () => Promise.resolve(),
    publisher: () => Promise.resolve(publisher()),
    ...over,
  }
}

const ask = (over: Record<string, unknown> = {}) => ({
  work: claimOf(MOBY),
  since: {},
  ...over,
})

describe('which book a work claim means', () => {
  it('finds the book by a shared identifier', () => {
    /* The strong key: two builds of one book with the same ISBN. */
    const theirs = claimOf({ ...MOBY, id: 'x', title: 'Moby-Dick', languages: ['en-US'] })
    expect(bookFor([MOBY], theirs)?.id).toBe('book:moby')
  })

  it('falls back to title, author and language when there is no identifier', () => {
    /* ⚠️ **THE CORPUS PROVED THIS CASE.** Two of three builds title the book
       *Moby-Dick; or, The Whale* and the third titles it *Moby-Dick*; compared
       as one string they are two works, so the weak key failed on exactly the
       population it exists to serve. `titles` is a SET for that reason. */
    const { identifier: _none, ...mine } = MOBY
    const theirs = claimOf({ id: 'x', title: 'Moby-Dick', author: 'Herman Melville', languages: ['en'] })
    expect(bookFor([mine], theirs)?.id).toBe('book:moby')
  })

  it('does not weak-match two spellings of one author', () => {
    /* ⚠️ **A LIMITATION, RECORDED RATHER THAN ASSUMED AWAY.** `normaliseName`
       folds case and punctuation and drops a leading article; it does NOT
       reorder, so a build cataloguing *Melville, Herman* and one cataloguing
       *Herman Melville* have different weak keys and will not meet. The strong
       key still joins them whenever either build declares an identifier, which
       is the common case for anything bought rather than scanned.

       Written as a test rather than a comment so that a later normaliser which
       DOES fold name order fails here and is noticed, instead of silently
       widening what two readers are told is the same book. */
    const { identifier: _none, ...mine } = MOBY
    const inverted = claimOf({ id: 'x', title: 'Moby-Dick', author: 'Melville, Herman', languages: ['en'] })
    expect(bookFor([mine], inverted)).toBeNull()
  })

  it('prefers a strong match over a weak one, whatever order the shelf was read in', () => {
    /* ⚠️ **OTHERWISE WHICH BOOK A FRIEND'S PASSAGES LAND IN DEPENDS ON DIRECTORY
       ORDER.** A shared identifier is evidence; a title and an author in one
       language is a guess that is right most of the time. */
    const weak: BookLike = { id: 'weak', title: 'Moby-Dick', author: 'Herman Melville', languages: ['en'] }
    const strong: BookLike = { ...MOBY, id: 'strong' }
    expect(bookFor([weak, strong], claimOf(MOBY))?.id).toBe('strong')
    expect(bookFor([strong, weak], claimOf(MOBY))?.id).toBe('strong')
  })

  it('finds nothing for a book this shelf does not have', () => {
    const other = claimOf({ id: 'y', title: 'Bleak House', author: 'Charles Dickens', languages: ['en'] })
    expect(bookFor([MOBY], other)).toBeNull()
  })

  it('never matches two books that declare no language', () => {
    /* A book declaring no language has told us nothing; treating two silences
       as agreement merges an English log and a Chinese one. */
    const silent = { id: 's', title: 'Untitled', author: 'Anon' }
    const another = { id: 't', title: 'Untitled', author: 'Anon' }
    expect(bookFor([silent], claimOf(another))).toBeNull()
  })

  it('keeps every book that shares an index key, not just the first', () => {
    /* ⚠️ **TWO EDITIONS OF ONE BOOK SHARE A KEY.** Dropping the second means a
       reader who owns both is offered their friend's passages against
       whichever copy happened to be indexed first — and if that copy is the
       one they are not reading, against no copy at all. */
    const paperback: BookLike = { ...MOBY, id: 'book:moby-paperback' }
    const index = indexOf([MOBY, paperback])

    const key = [...index.keys()].find((one) => (index.get(one) ?? []).length > 1)
    expect(key, 'the two editions share no index key at all').toBeDefined()
    expect(index.get(key as string)?.map((one) => one.id)).toEqual([
      'book:moby',
      'book:moby-paperback',
    ])
  })

  it('agrees with itself through the index', () => {
    /* The index is generous on purpose — a hit is a CANDIDATE, and `matchWork`
       still decides. It must not be generous enough to disagree. */
    const shelf = [MOBY, { id: 'b', title: 'Bleak House', author: 'Dickens', languages: ['en'] }]
    expect(bookVia(indexOf(shelf), claimOf(MOBY))?.id).toBe(bookFor(shelf, claimOf(MOBY))?.id)
  })
})

describe('the hello', () => {
  it('agrees a version both sides can read', () => {
    const answer = welcome({ proto: CIRCLE_PROTO, pages: { min: 1, max: 9 }, person: PERSON.id }, PERSON.id)
    expect(answer?.agreed).toBe(WIRE_VERSION)
    expect(answer?.pages).toEqual(CIRCLE_VERSION)
  })

  it('refuses a peer with no overlap rather than guessing one', () => {
    /* An unbumped peer stripping a field it does not know, then ACKing the
       stripped row, is how `SYNC_VERSION` erased a sender's data. */
    expect(welcome({ proto: CIRCLE_PROTO, pages: { min: 99, max: 99 }, person: PERSON.id }, PERSON.id)).toBeNull()
  })

  it('refuses a hello this build cannot parse', () => {
    expect(welcome({ proto: 2, pages: CIRCLE_VERSION, person: PERSON.id }, PERSON.id)).toBeNull()
    expect(welcome('hello', PERSON.id)).toBeNull()
  })
})

describe('answering a request for pages', () => {
  it('serves what was published, and the other side takes it', async () => {
    /* Both halves again, this time through the surface a peer actually calls. */
    const answer = await answerPages(ask(), serving())
    expect(answer?.pages.length).toBeGreaterThan(0)

    const ledger: Ledger = {
      held: NOTHING_SHARED,
      devices: [DEVICE.id],
      revoked: [],
      epoch: 0,
      relationshipEpoch: 1,
      admitted: true,
    }
    const taken = takePages(answer?.pages ?? [], claimOf(MOBY), PERSON.id, ledger, pageCrypto, NOW)

    expect(taken.refusals).toEqual([])
    expect(taken.held.entries[0]?.passage.quote).toBe('call me ishmael')
  })

  it('answers a book this shelf does not have with nothing, not an error', () => {
    /* ⚠️ **"NO" IS THE ORDINARY ANSWER AND THE COMMON ONE.** An error here puts
       a failure in front of a reader for the fact that their friend owns a book
       they do not. */
    const other = claimOf({ id: 'y', title: 'Bleak House', author: 'Dickens', languages: ['en'] })
    return expect(answerPages(ask({ work: other }), serving())).resolves.toEqual({
      pages: [],
      more: false,
    })
  })

  it('answers a book with nothing shared the same way', async () => {
    /* ⚠️ **DELIBERATELY INDISTINGUISHABLE FROM THE CASE ABOVE.** Telling a peer
       "I have that book but have shared nothing" discloses the reader's library
       one request at a time. */
    const empty = await answerPages(ask(), serving({ shared: () => Promise.resolve(NOTHING_PUBLISHED) }))
    const absent = await answerPages(
      ask({ work: claimOf({ id: 'y', title: 'Bleak House', author: 'Dickens', languages: ['en'] }) }),
      serving(),
    )
    expect(empty).toEqual(absent)
  })

  it('refuses a request this build cannot parse', async () => {
    expect(await answerPages({ work: 'moby', since: {} }, serving())).toBeNull()
    expect(await answerPages(null, serving())).toBeNull()
  })

  it('says nothing when this device has no identity to publish with', async () => {
    const answer = await answerPages(ask(), serving({ publisher: () => Promise.resolve(null) }))
    expect(answer).toEqual({ pages: [], more: false })
  })

  it('writes the sealed boundaries before the pages go out', async () => {
    /* ⚠️ **OF THE TWO ORDERS ONLY THIS ONE FAILS SAFE.** A page served under a
       boundary that was never recorded is re-paginated on the next fetch, and
       every recipient holding it then refuses the one after with `chain`. A
       boundary recorded and not served costs a round trip. */
    const seal = vi.fn((_book: string, _held: SharedFile) => Promise.resolve())
    const answer = await answerPages(ask(), serving({ seal }))

    expect(seal).toHaveBeenCalledTimes(1)
    const wrote = seal.mock.calls[0] as unknown as [string, SharedFile]
    expect(wrote[1].sealed.length).toBeGreaterThan(0)
    expect(answer?.pages.length).toBeGreaterThan(0)
  })

  it('does not write when there was nothing new to seal', async () => {
    const sealed = { ...published(), sealed: [{ device: DEVICE.id, from: 1, to: 1 }] }
    const seal = vi.fn((_book: string, _held: SharedFile) => Promise.resolve())
    await answerPages(ask(), serving({ shared: () => Promise.resolve(sealed), seal }))
    expect(seal).not.toHaveBeenCalled()
  })
})
