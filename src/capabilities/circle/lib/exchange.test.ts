import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'

/* The jacket served in chunks is over the chunk boundary — half a megabyte
   hashed in JavaScript, twice; under coverage instrumentation that outruns
   the default fifteen seconds. The same allowance `covers.test.ts` makes,
   for the same jacket. */
vi.setConfig({ testTimeout: 60_000 })
import { MAX_COVER_BYTES } from '../../../kernel'
import { bytesOfBase64 } from './base64'
import { SHELF_WORK, WIRE_VERSION, canonicalJson, listWork, makeHlc, type Passage } from '../../../kernel'
import { NOTHING_LISTED, createList, placeOnList, type ListFile } from './lists'
import { COVER_CHUNK_BYTES, MAX_PAGES_PER_ANSWER, parseListsRequest, type PagesAnswer } from './protocol'
import { pageCrypto } from './crypto'
import {
  answerCover,
  answerPages,
  bookFor,
  bookVia,
  claimOf,
  indexOf,
  welcome,
  type BookLike,
  type Serving,
  answerLists,
  answerShelf,
} from './exchange'
import { CIRCLE_PROTO, CIRCLE_VERSION } from './protocol'
import { NOTHING_PUBLISHED, nextSeqFor, share, wireBytesOf, type Publisher, type SharedFile } from './publish'
import { delegationBytes, takePages, type Ledger, type SignedDelegation } from './receive'
import { NOTHING_SHELVED, syncShelf, workOf, type ShelfFile, type ShelvedBook } from './shelf'
import { claimOfShelved } from './circleView'
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
    shelf: () => Promise.resolve(NOTHING_SHELVED),
    sealShelf: () => Promise.resolve(),
    lists: () => Promise.resolve([]),
    sealList: () => Promise.resolve(),
    cover: () => Promise.resolve(null),
    ...over,
  }
}

/* A v2 caller's request — it names the version the hello agreed. A v1
   caller's has no `v` at all; see `PagesRequest.v`. */
const ask = (over: Record<string, unknown> = {}) => ({
  work: claimOf(MOBY),
  since: {},
  v: WIRE_VERSION,
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
    const sealed = { ...published(), sealed: [{ device: DEVICE.id, from: 1, to: 1, v: WIRE_VERSION }] }
    const seal = vi.fn((_book: string, _held: SharedFile) => Promise.resolve())
    await answerPages(ask(), serving({ shared: () => Promise.resolve(sealed), seal }))
    expect(seal).not.toHaveBeenCalled()
  })
})

describe('two chains, sealed separately — WI-23.B2', () => {
  const stamp = (n: number) => makeHlc(NOW + n, 0, DEVICE.id.slice(0, 16))
  const ledger = (): Ledger => ({
    held: NOTHING_SHARED,
    devices: [DEVICE.id],
    revoked: [],
    epoch: 0,
    relationshipEpoch: 1,
    admitted: true,
  })
  /** A publisher's store on disk, shared by every caller of the tests below. */
  function shelf() {
    const files = new Map<string, SharedFile>()
    let n = 0
    const serve = (): Serving =>
      serving({
        shared: (bookId) => Promise.resolve(files.get(bookId) ?? NOTHING_PUBLISHED),
        seal: (bookId, held) => {
          files.set(bookId, held)
          return Promise.resolve()
        },
      })
    return {
      files,
      serve,
      shareOne(quote: string) {
        n += 1
        const held = files.get(MOBY.id) ?? NOTHING_PUBLISHED
        files.set(MOBY.id, share(held, { markId: `m${n}`, passage: passage(quote), device: DEVICE.id }, `pub-${n}`, stamp(10 + n)).held)
      },
      /* A book-level entry, which only the v2 chain may carry. */
      rateIt(stars: 1 | 2 | 3 | 4 | 5) {
        n += 1
        const held = files.get(MOBY.id) ?? NOTHING_PUBLISHED
        files.set(MOBY.id, {
          ...held,
          opinions: [...held.opinions, { op: 'rate', stars, device: DEVICE.id, seq: nextSeqFor(held, DEVICE.id), at: stamp(10 + n) }],
        })
      },
    }
  }
  const pagesOf = async (serve: Serving, v: number) => {
    const answer = await answerPages(v === 1 ? ask({ v: undefined }) : ask({ v }), serve)
    return answer!.pages
  }
  /* A v1 caller has no `v` member at all — `ask({ v: undefined })` still
     spreads a key, so strip it the way a v1 build would never have had it. */
  const v1Ask = () => {
    const { v: _none, ...rest } = ask()
    return rest
  }

  it('serves the same log to a v1 and a v2 peer, and every page each holds is byte-identical after the log grows', async () => {
    /* ⚠️ **THE DESIGN'S OWN CHECK, and the falsifier is one changed byte.** */
    const alice = shelf()
    alice.shareOne('first')
    alice.rateIt(4)
    const v1First = (await answerPages(v1Ask(), alice.serve()))!.pages
    const v2First = await pagesOf(alice.serve(), WIRE_VERSION)
    expect(v1First.length).toBeGreaterThan(0)
    expect(v2First.length).toBeGreaterThan(0)

    alice.shareOne('second')
    alice.rateIt(5)
    const v1Again = (await answerPages(v1Ask(), alice.serve()))!.pages
    const v2Again = await pagesOf(alice.serve(), WIRE_VERSION)

    expect(v1Again.slice(0, v1First.length)).toEqual(v1First)
    expect(v2Again.slice(0, v2First.length)).toEqual(v2First)
    expect(v1Again.length).toBeGreaterThan(v1First.length)
    expect(v2Again.length).toBeGreaterThan(v2First.length)
    /* Two chains: the store holds boundaries for each, under its own version. */
    const sealed = alice.files.get(MOBY.id)!.sealed
    expect(sealed.some((one) => one.v === 1)).toBe(true)
    expect(sealed.some((one) => one.v === WIRE_VERSION)).toBe(true)
  })

  it('serves a v1 page with no book-level entry in it, and the v1 page is NOT the v2 page — the inverse', async () => {
    const alice = shelf()
    alice.shareOne('a passage')
    alice.rateIt(3)
    const [v1] = (await answerPages(v1Ask(), alice.serve()))!.pages
    const [v2] = await pagesOf(alice.serve(), WIRE_VERSION)
    expect(v1).not.toBe(v2)
    const v1Page = JSON.parse(v1!) as { v: number; entries: { op: string }[] }
    const v2Page = JSON.parse(v2!) as { v: number; entries: { op: string }[] }
    expect(v1Page.v).toBe(1)
    expect(v1Page.entries.map((one) => one.op)).toEqual(['share'])
    expect(v2Page.v).toBe(WIRE_VERSION)
    expect(v2Page.entries.map((one) => one.op)).toEqual(['share', 'rate'])
    /* And a v1 taker takes the v1 page, which is the point of serving it. */
    const taken = takePages([v1!], claimOf(MOBY), PERSON.id, ledger(), pageCrypto, NOW, 1)
    expect(taken.refusals).toEqual([])
    expect(taken.held.entries.map((one) => one.pub)).toEqual(['pub-1'])
  })

  it('serves nothing to a caller naming a version this build does not publish', async () => {
    const alice = shelf()
    alice.shareOne('x')
    expect(await answerPages(ask({ v: WIRE_VERSION + 1 }), alice.serve())).toBeNull()
  })
})

describe('answering a request for the shelf — WI-23.C1 and C2', () => {
  const shelfOf = (books: readonly { bookId: string; title: string; author: string }[]) =>
    syncShelf(NOTHING_SHELVED, books, DEVICE.id, makeHlc(NOW, 0, DEVICE.id.slice(0, 16)), () => `s${books.length}`)
  const withShelf = (held: ShelfFile) => serving({ shelf: () => Promise.resolve(held), publisher: () => Promise.resolve({ ...publisher(), work: SHELF_WORK }) })
  const ask = (over: Record<string, unknown> = {}) => ({ since: {}, v: WIRE_VERSION, ...over })

  it('serves the shelf to a person the switch is on for, and a recipient takes it', async () => {
    const answer = await answerShelf(ask(), withShelf(shelfOf([{ bookId: 'b1', title: 'Moby-Dick', author: 'Melville' }])), true)
    expect(answer?.pages.length).toBe(1)
    const taken = takePages(answer!.pages, SHELF_WORK, PERSON.id, { held: NOTHING_SHARED, devices: [DEVICE.id], revoked: [], epoch: 0, relationshipEpoch: 1, admitted: true }, pageCrypto, NOW, WIRE_VERSION)
    expect(taken.refusals).toEqual([])
    expect(taken.held.works.map((one) => one.work.title)).toEqual(['Moby-Dick'])
  })

  it('answers a person the switch is OFF for with bytes identical to a reader who owns nothing — the falsifier', async () => {
    const off = await answerShelf(ask(), withShelf(shelfOf([{ bookId: 'b1', title: 'Moby-Dick', author: 'Melville' }])), false)
    const empty = await answerShelf(ask(), withShelf(NOTHING_SHELVED), true)
    expect(JSON.stringify(off)).toBe(JSON.stringify(empty))
    expect(off).toEqual({ pages: [], more: false })
  })

  it('does not read or seal the shelf for a person the switch is off for', async () => {
    const shelf = vi.fn(() => Promise.resolve(shelfOf([{ bookId: 'b1', title: 'T', author: 'A' }])))
    const sealShelf = vi.fn(() => Promise.resolve())
    await answerShelf(ask(), serving({ shelf, sealShelf }), false)
    expect(shelf).not.toHaveBeenCalled()
    expect(sealShelf).not.toHaveBeenCalled()
  })

  it('refuses a request that names no version or a version with no shelf, and one this build cannot parse', async () => {
    const held = withShelf(shelfOf([{ bookId: 'b1', title: 'T', author: 'A' }]))
    const { v: _none, ...unversioned } = ask()
    expect(await answerShelf(unversioned, held, true)).toBeNull()
    expect(await answerShelf(ask({ v: 1 }), held, true)).toBeNull()
    expect(await answerShelf(ask({ v: WIRE_VERSION + 1 }), held, true)).toBeNull()
    expect(await answerShelf(ask({ work: SHELF_WORK }), held, true)).toBeNull()
    expect(await answerShelf('shelf', held, true)).toBeNull()
  })

  it('seals the boundaries before the pages go out, and not again when nothing is new', async () => {
    const sealShelf = vi.fn((_held: ShelfFile) => Promise.resolve())
    const held = shelfOf([{ bookId: 'b1', title: 'T', author: 'A' }])
    const serve = serving({ shelf: () => Promise.resolve(held), sealShelf, publisher: () => Promise.resolve({ ...publisher(), work: SHELF_WORK }) })
    await answerShelf(ask(), serve, true)
    expect(sealShelf).toHaveBeenCalledTimes(1)
    const sealed = sealShelf.mock.calls[0]![0]
    await answerShelf(ask(), serving({ shelf: () => Promise.resolve(sealed), sealShelf, publisher: () => Promise.resolve({ ...publisher(), work: SHELF_WORK }) }), true)
    expect(sealShelf).toHaveBeenCalledTimes(1)
  })
})

describe('answering a request for the lists — WI-23.E1, under WI-23.C2’s switch', () => {
  const by = (n: number) => ({ device: DEVICE.id, at: makeHlc(NOW + n, 0, DEVICE.id.slice(0, 16)) })
  const seaBooks = (): ListFile =>
    placeOnList(createList(NOTHING_LISTED, 'Sea books', by(1)), { pub: 'i1', work: { title: 'Moby-Dick', author: 'Melville', language: 'en' }, position: 1, note: 'start here' }, by(2))
  const withLists = (lists: readonly { id: string; held: ListFile }[], over: Partial<Serving> = {}) =>
    serving({ lists: () => Promise.resolve(lists), publisher: (work) => Promise.resolve({ ...publisher(), work }), ...over })
  const ask = (over: Record<string, unknown> = {}) => ({ since: {}, v: WIRE_VERSION, ...over })
  const ledger = () => ({ held: NOTHING_SHARED, devices: [DEVICE.id], revoked: [], epoch: 0, relationshipEpoch: 1, admitted: true })

  it('serves every list to a person the switch is on for, each page under its list’s claim, and a recipient takes it', async () => {
    const answer = await answerLists(ask(), withLists([{ id: 'aa11', held: seaBooks() }, { id: 'bb22', held: createList(NOTHING_LISTED, 'Empty', by(3)) }]), true)
    expect(answer?.pages.length).toBe(2)
    const claims = answer!.pages.map((raw) => (JSON.parse(raw) as { work: { ids: string[] } }).work.ids[0])
    expect(claims).toEqual(['paper.circle.list:aa11', 'paper.circle.list:bb22'])
    const taken = takePages([answer!.pages[0]!], listWork('aa11'), PERSON.id, ledger(), pageCrypto, NOW, WIRE_VERSION)
    expect(taken.refusals).toEqual([])
    expect(taken.held.list).toMatchObject({ created: true, title: { value: 'Sea books' }, items: [{ pub: 'i1', position: 1, note: 'start here' }] })
    /* A page of one list is refused against another list's chain. */
    expect(takePages([answer!.pages[0]!], listWork('bb22'), PERSON.id, ledger(), pageCrypto, NOW, WIRE_VERSION).refusals).toEqual(['wrong-work'])
  })

  it('answers a person the switch is OFF for with bytes identical to a reader with no lists — the falsifier', async () => {
    const off = await answerLists(ask(), withLists([{ id: 'aa11', held: seaBooks() }]), false)
    const none = await answerLists(ask(), withLists([]), true)
    expect(JSON.stringify(off)).toBe(JSON.stringify(none))
    expect(off).toEqual({ pages: [], more: false })
    /* And a reader with no identity to publish as says the same. */
    expect(JSON.stringify(await answerLists(ask(), withLists([{ id: 'aa11', held: seaBooks() }], { publisher: () => Promise.resolve(null) }), true))).toBe(JSON.stringify(none))
  })

  it('answers at most the cap of pages across every list, and says there is more', async () => {
    const many = (seed: number) => {
      let held = createList(NOTHING_LISTED, `List ${seed}`, by(seed * 100))
      for (let i = 1; i <= 80; i++) held = placeOnList(held, { pub: `i${seed}-${i}`, work: { title: `T${i}`, author: 'A', language: 'en' }, position: i, note: '' }, by(seed * 100 + i))
      return held
    }
    const answer = await answerLists(ask(), withLists([{ id: 'aa11', held: many(1) }, { id: 'bb22', held: many(2) }]), true, { maxPages: 1_000, budget: 200 })
    expect(answer?.pages.length).toBe(MAX_PAGES_PER_ANSWER)
    expect(answer?.more).toBe(true)
  })

  it('serves the lists the caller named before the rest, in the caller’s order — a long unnamed list cannot starve them', async () => {
    /* ⚠️ A caller with more lists than a cursor may name sends a window of
       cursors; the rest are served from their beginning, and one long list
       among them filled every answer before a named list behind it was
       reached. Named first: the cursor sent is the first thing honoured. */
    const many = (seed: number, items: number) => {
      let held = createList(NOTHING_LISTED, `List ${seed}`, by(seed * 100))
      for (let i = 1; i <= items; i++) held = placeOnList(held, { pub: `i${seed}-${i}`, work: { title: `T${i}`, author: 'A', language: 'en' }, position: i, note: '' }, by(seed * 100 + i))
      return held
    }
    const lists = withLists([
      { id: 'aa11', held: many(1, 80) },
      { id: 'bb22', held: many(2, 1) },
      { id: 'cc33', held: many(3, 1) },
    ])
    const claimsOf = (answer: PagesAnswer | null) => answer!.pages.map((raw) => (JSON.parse(raw) as { work: { ids: string[] } }).work.ids[0])
    /* Room for a few pages, two lists named: the named lists are served, in the caller's order, and the long unnamed one waits. */
    const named = await answerLists(ask({ since: { cc33: { [DEVICE.id]: 0 }, bb22: { [DEVICE.id]: 0 } } }), lists, true, { maxPages: 4, budget: 200 })
    const claims = claimsOf(named)
    expect(claims[0]).toBe('paper.circle.list:cc33')
    expect(claims).toContain('paper.circle.list:bb22')
    expect(claims).not.toContain('paper.circle.list:aa11')
    expect(named?.more).toBe(true)
    /* Nothing named: this side's own order, as before. */
    const nobody = await answerLists(ask(), lists, true, { maxPages: 2, budget: 200 })
    expect(claimsOf(nobody)).toEqual(['paper.circle.list:aa11', 'paper.circle.list:aa11'])
  })

  it('holds the answer to the caller’s page bound when it is under the cap, across every list', async () => {
    /* `bounds.maxPages` below the cap: the answer as a whole is held to it.
       ⚠️ It used to be a bound PER LIST — each list took up to `maxPages`,
       and the answer grew to the cap — so two lists under a bound of two
       answered four. The existing tests bound at a thousand could not see it. */
    const many = (seed: number) => {
      let held = createList(NOTHING_LISTED, `List ${seed}`, by(seed * 100))
      for (let i = 1; i <= 80; i++) held = placeOnList(held, { pub: `i${seed}-${i}`, work: { title: `T${i}`, author: 'A', language: 'en' }, position: i, note: '' }, by(seed * 100 + i))
      return held
    }
    const answer = await answerLists(ask(), withLists([{ id: 'aa11', held: many(1) }, { id: 'bb22', held: many(2) }]), true, { maxPages: 2, budget: 200 })
    expect(answer?.pages.length).toBe(2)
    expect(answer?.more).toBe(true)
    /* Both pages are the first list's: the bound was reached before the second list was begun. */
    expect(answer!.pages.map((raw) => (JSON.parse(raw) as { work: { ids: string[] } }).work.ids[0])).toEqual(['paper.circle.list:aa11', 'paper.circle.list:aa11'])
  })

  it('leaves the second list only the room the first did not take', async () => {
    const many = (seed: number, items: number) => {
      let held = createList(NOTHING_LISTED, `List ${seed}`, by(seed * 100))
      for (let i = 1; i <= items; i++) held = placeOnList(held, { pub: `i${seed}-${i}`, work: { title: `T${i}`, author: 'A', language: 'en' }, position: i, note: '' }, by(seed * 100 + i))
      return held
    }
    const bounds = { maxPages: 1_000, budget: 200 }
    const alone = await answerLists(ask(), withLists([{ id: 'aa11', held: many(1, 20) }]), true, bounds)
    const first = alone!.pages.length
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(MAX_PAGES_PER_ANSWER)
    const both = await answerLists(ask(), withLists([{ id: 'aa11', held: many(1, 20) }, { id: 'bb22', held: many(2, 80) }]), true, bounds)
    expect(both?.pages.length).toBe(MAX_PAGES_PER_ANSWER)
    expect(both?.more).toBe(true)
  })

  it('hands the second list the budget the first left, not the whole of it', async () => {
    const many = (seed: number) => {
      let held = createList(NOTHING_LISTED, `List ${seed}`, by(seed * 100))
      for (let i = 1; i <= 80; i++) held = placeOnList(held, { pub: `i${seed}-${i}`, work: { title: `T${i}`, author: 'A', language: 'en' }, position: i, note: '' }, by(seed * 100 + i))
      return held
    }
    const bounds = { maxPages: 1_000, budget: 200 }
    const alone = await answerLists(ask(), withLists([{ id: 'aa11', held: many(1) }]), true, bounds)
    const [first, second] = alone!.pages.map(wireBytesOf)
    /* Two pages and a little: the first list takes its two, and the second is
       left less than a page — which it does NOT take. ⚠️ It used to: a log's
       first page goes through `pagesOver` whatever the size budget says, so
       every list put one page over what was left, and the answer as a whole
       outgrew the frame. Only the ANSWER's first page is unconditional; the
       second list waits for the next request, which is what `more` says. */
    const maxChars = first! + second! + 50
    const both = await answerLists(ask(), withLists([{ id: 'aa11', held: many(1) }, { id: 'bb22', held: many(2) }]), true, { ...bounds, maxChars })
    expect(both?.pages.length).toBe(2)
    expect(both?.more).toBe(true)
    expect(both!.pages.reduce((sum, page) => sum + wireBytesOf(page), 0)).toBeLessThanOrEqual(maxChars)
    /* With room for the second list's first page, it is taken — and the budget still holds as a whole. */
    const third = await answerLists(ask(), withLists([{ id: 'aa11', held: many(1) }, { id: 'bb22', held: many(2) }]), true, { ...bounds, maxChars: first! + second! + first! })
    expect(third?.pages.length).toBe(3)
    expect(third!.pages.reduce((sum, page) => sum + wireBytesOf(page), 0)).toBeLessThanOrEqual(first! + second! + first!)
  })

  it('answers at most the character budget across every list, not per list', async () => {
    const many = (seed: number) => {
      let held = createList(NOTHING_LISTED, `List ${seed}`, by(seed * 100))
      for (let i = 1; i <= 80; i++) held = placeOnList(held, { pub: `i${seed}-${i}`, work: { title: `T${i}`, author: 'A', language: 'en' }, position: i, note: '' }, by(seed * 100 + i))
      return held
    }
    const answer = await answerLists(ask(), withLists([{ id: 'aa11', held: many(1) }, { id: 'bb22', held: many(2) }]), true, { maxPages: 1_000, budget: 200, maxChars: 400 })
    /* A list's first page is always cut, and one page of these lists is over
       the budget on its own — so the first list's first page is the whole
       answer, and the second list is not begun. Per list, each would have
       had a page. */
    expect(answer?.pages.length).toBe(1)
    expect(answer!.pages[0]!.length).toBeGreaterThan(400)
    expect(answer?.more).toBe(true)
  })

  it('does not read or seal a list for a person the switch is off for', async () => {
    const lists = vi.fn(() => Promise.resolve([{ id: 'aa11', held: seaBooks() }]))
    const sealList = vi.fn(() => Promise.resolve())
    await answerLists(ask(), serving({ lists, sealList }), false)
    expect(lists).not.toHaveBeenCalled()
    expect(sealList).not.toHaveBeenCalled()
  })

  it('asks from a cursor per list, and answers nothing for a list held in full', async () => {
    const serve = withLists([{ id: 'aa11', held: seaBooks() }])
    const first = await answerLists(ask(), serve, true)
    const page = JSON.parse(first!.pages[0]!) as { to: number }
    const again = await answerLists(ask({ since: { aa11: { [DEVICE.id]: page.to } } }), serve, true)
    expect(again).toEqual({ pages: [], more: false })
    /* A cursor for a list this reader does not have is ignored, not refused. */
    expect((await answerLists(ask({ since: { ff99: { [DEVICE.id]: 3 } } }), serve, true))?.pages).toHaveLength(1)
  })

  it('refuses a request naming a version with no lists, or no version, or one this build cannot parse', async () => {
    const serve = withLists([{ id: 'aa11', held: seaBooks() }])
    const { v: _none, ...unversioned } = ask()
    expect(await answerLists(unversioned, serve, true)).toBeNull()
    expect(await answerLists(ask({ v: 2 }), serve, true)).toBeNull()
    expect(await answerLists(ask({ v: WIRE_VERSION + 1 }), serve, true)).toBeNull()
    expect(await answerLists(ask({ since: { 'not hex': {} } }), serve, true)).toBeNull()
    expect(await answerLists('lists', serve, true)).toBeNull()
    expect(parseListsRequest(ask())).toEqual({ since: {}, v: WIRE_VERSION })
  })

  it('seals each list’s boundaries before its pages go out, and not again when nothing is new', async () => {
    const sealed = new Map<string, ListFile>([['aa11', seaBooks()]])
    const sealList = vi.fn((id: string, held: ListFile) => {
      sealed.set(id, held)
      return Promise.resolve()
    })
    const serve = withLists([], { lists: () => Promise.resolve([...sealed].map(([id, held]) => ({ id, held }))), sealList })
    await answerLists(ask(), serve, true)
    expect(sealList).toHaveBeenCalledTimes(1)
    expect(sealList.mock.calls[0]![0]).toBe('aa11')
    await answerLists(ask(), serve, true)
    expect(sealList).toHaveBeenCalledTimes(1)
  })

  it('caps one answer across lists and says there is more', async () => {
    const many = Array.from({ length: MAX_PAGES_PER_ANSWER + 1 }, (_, i) => ({ id: `a${i.toString(16).padStart(3, '0')}`, held: createList(NOTHING_LISTED, `L${i}`, by(i + 1)) }))
    const answer = await answerLists(ask(), withLists(many), true)
    expect(answer?.pages).toHaveLength(MAX_PAGES_PER_ANSWER)
    expect(answer?.more).toBe(true)
  })
})

describe('every clause of the shelf and list answers — one row each', () => {
  const by = (n: number) => ({ device: DEVICE.id, at: makeHlc(NOW + n, 0, DEVICE.id.slice(0, 16)) })
  const ask = (over: Record<string, unknown> = {}) => ({ since: {}, v: WIRE_VERSION, ...over })

  it('answers a shelf with nobody to publish as exactly as one nobody is shown', async () => {
    const shelf = syncShelf(NOTHING_SHELVED, [{ bookId: 'b1', title: 'T', author: 'A' }], DEVICE.id, by(1).at, () => 's1')
    const nobody = await answerShelf(ask(), serving({ shelf: () => Promise.resolve(shelf), publisher: () => Promise.resolve(null) }), true)
    expect(JSON.stringify(nobody)).toBe(JSON.stringify({ pages: [], more: false }))
  })

  it('says there is more when one list has more pages than one answer carries', async () => {
    let held = createList(NOTHING_LISTED, 'Long', by(1))
    for (let i = 0; i < 6; i++) {
      held = placeOnList(held, { pub: `i${i}`, work: { title: `Book ${i}`, author: 'A', language: 'en' }, position: i + 1, note: 'x'.repeat(200) }, by(i + 2))
    }
    const serve = serving({ lists: () => Promise.resolve([{ id: 'aa11', held }]), publisher: (work) => Promise.resolve({ ...publisher(), work }) })
    const answer = await answerLists(ask(), serve, true, { maxPages: 1, budget: 1_200 })
    expect(answer?.pages).toHaveLength(1)
    expect(answer?.more).toBe(true)
  })

  it('fills one answer to the cap exactly without saying there is more', async () => {
    const lists = Array.from({ length: MAX_PAGES_PER_ANSWER }, (_, i) => ({ id: `b${i.toString(16).padStart(3, '0')}`, held: createList(NOTHING_LISTED, `L${i}`, by(i + 1)) }))
    const answer = await answerLists(ask(), serving({ lists: () => Promise.resolve(lists), publisher: (work) => Promise.resolve({ ...publisher(), work }) }), true)
    expect(answer?.pages).toHaveLength(MAX_PAGES_PER_ANSWER)
    expect(answer?.more).toBe(false)
  })
})

describe('the cap bounds the work, not only the wire', () => {
  it('cuts and seals nothing for a list past the cap', async () => {
    const by = (n: number) => ({ device: DEVICE.id, at: makeHlc(NOW + n, 0, DEVICE.id.slice(0, 16)) })
    const lists = Array.from({ length: MAX_PAGES_PER_ANSWER + 3 }, (_, i) => ({ id: `c${i.toString(16).padStart(3, '0')}`, held: createList(NOTHING_LISTED, `L${i}`, by(i + 1)) }))
    const sealList = vi.fn(() => Promise.resolve())
    const answer = await answerLists({ since: {}, v: WIRE_VERSION }, serving({ lists: () => Promise.resolve(lists), sealList, publisher: (work) => Promise.resolve({ ...publisher(), work }) }), true)
    expect(answer?.pages).toHaveLength(MAX_PAGES_PER_ANSWER)
    expect(answer?.more).toBe(true)
    expect(sealList).toHaveBeenCalledTimes(MAX_PAGES_PER_ANSWER)
  })
})

describe('the shelf index', () => {
  it('is built once per books array and rebuilt for a new one', () => {
    const books = [{ id: 'b1', identifier: '', title: 'Dune', author: 'Herbert', language: 'en' }]
    const first = indexOf(books)
    expect(indexOf(books)).toBe(first)
    const next = indexOf([...books])
    expect(next).not.toBe(first)
    expect([...next.keys()]).toEqual([...first.keys()])
  })
})

describe('two editions that match alike', () => {
  it('resolve to the same one whichever order the shelf lists them in', () => {
    const one: BookLike = { id: 'book:b', identifier: 'isbn:1', title: 'Dune', author: 'Herbert', languages: ['en'] }
    const two: BookLike = { id: 'book:a', identifier: 'isbn:1', title: 'Dune', author: 'Herbert', languages: ['en'] }
    const claim = claimOf(one)
    expect(bookFor([one, two], claim)?.id).toBe('book:a')
    expect(bookFor([two, one], claim)?.id).toBe('book:a')
    const weakOnly: BookLike[] = [{ ...one, identifier: 'isbn:9' }, { ...two, identifier: 'isbn:8' }]
    const byTitle = claimOf({ id: 'x', title: 'Dune', author: 'Herbert', languages: ['en'] })
    expect(bookFor(weakOnly, byTitle)?.id).toBe('book:a')
    expect(bookFor([...weakOnly].reverse(), byTitle)?.id).toBe('book:a')
  })
})

describe('answering for a jacket — WI-23.C5', () => {
  const DIGEST = 'ab'.repeat(32)
  const JACKET = new Uint8Array(600 * 1024).map((_, i) => i % 251)
  const at = makeHlc(1_700_000_000_000 + 1, 0, DEVICE.id.slice(0, 16))
  const shelfWith = (cover?: string) =>
    syncShelf(NOTHING_SHELVED, [{ bookId: MOBY.id, title: 'Moby-Dick', author: 'Herman Melville', languages: ['en'], ...(cover === undefined ? {} : { cover }) }], DEVICE.id, at, () => 'abcd')
  const covered = (over: Partial<Serving> = {}) =>
    serving({ shelf: () => Promise.resolve(shelfWith(DIGEST)), cover: () => Promise.resolve({ hash: DIGEST, size: JACKET.length, bytes: JACKET }), ...over })

  it('serves the jacket in chunks by offset, each saying whether more follows', async () => {
    const first = (await answerCover({ pub: 'abcd', offset: 0 }, covered(), true))!
    expect(first).toMatchObject({ offset: 0, size: JACKET.length, more: true })
    const head = bytesOfBase64(first.bytes)!
    expect(head).toEqual(JACKET.subarray(0, COVER_CHUNK_BYTES))
    const second = (await answerCover({ pub: 'abcd', offset: head.length }, covered(), true))!
    expect(second).toMatchObject({ offset: head.length, size: JACKET.length, more: false })
    expect(bytesOfBase64(second.bytes)).toEqual(JACKET.subarray(head.length))
  })

  it('serves a jacket by ANY live row’s pub, not only the one row per book the shelf keeps', async () => {
    /* Two device stores that met hold two live rows for one book; a friend
       asks by whichever pub their page carried. */
    const work = { title: 'Moby-Dick', author: 'Herman Melville', language: 'en', cover: DIGEST }
    const twice: ShelfFile = {
      works: [
        { pub: 'abcd', bookId: MOBY.id, work, device: DEVICE.id, seq: 1, at },
        { pub: 'ef01', bookId: MOBY.id, work, device: 'e'.repeat(64), seq: 1, at },
      ],
      sealed: [],
    }
    const serve = covered({ shelf: () => Promise.resolve(twice) })
    expect(await answerCover({ pub: 'ef01', offset: 0 }, serve, true)).toMatchObject({ offset: 0, size: JACKET.length })
    expect(await answerCover({ pub: 'abcd', offset: 0 }, serve, true)).toMatchObject({ offset: 0, size: JACKET.length })
  })

  it.each([
    ['a person the switch is off for', covered(), false, { pub: 'abcd', offset: 0 }],
    ['a request the build does not read', covered(), true, { pub: 'abcd' }],
    ['a pub nobody holds', covered(), true, { pub: 'ab', offset: 0 }],
    ['an entry that named no cover', covered({ shelf: () => Promise.resolve(shelfWith()) }), true, { pub: 'abcd', offset: 0 }],
    ['a jacket this device no longer holds', covered({ cover: () => Promise.resolve(null) }), true, { pub: 'abcd', offset: 0 }],
    ['a file that changed under its digest', covered({ cover: () => Promise.resolve({ hash: 'cd'.repeat(32), size: JACKET.length, bytes: JACKET }) }), true, { pub: 'abcd', offset: 0 }],
    ['a file that changed size under its facts', covered({ cover: () => Promise.resolve({ hash: DIGEST, size: JACKET.length - 1, bytes: JACKET }) }), true, { pub: 'abcd', offset: 0 }],
    ['a jacket past what the circle serves', covered({ cover: () => Promise.resolve({ hash: DIGEST, size: MAX_COVER_BYTES + 1, bytes: new Uint8Array(MAX_COVER_BYTES + 1) }) }), true, { pub: 'abcd', offset: 0 }],
    ['an offset past the end', covered(), true, { pub: 'abcd', offset: JACKET.length }],
  ])('refuses %s with the one refusal', async (_what, serve, discloses, request) => {
    expect(await answerCover(request, serve, discloses)).toBeNull()
  })
})

describe('the claim of a book with a field past the bound', () => {
  it('is the claim of the work as published — cut — so a friend’s row links back to the reader’s copy', () => {
    /* Cut on the row and not on the claim, a long title matched nothing. */
    const long: BookLike = { id: 'book:long', title: 'x'.repeat(2_000), author: 'Somebody', languages: ['en'] }
    const asPublished = workOf(long as unknown as ShelvedBook & { bookId: string })
    expect(bookVia(indexOf([long]), claimOfShelved({ ...asPublished }))?.id).toBe('book:long')
  })
})
