import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'

/* ⚠️ **THIS FILE KEEPS ITS BIG JACKET, AND IT IS THE ONLY ONE THAT SHOULD.**
   `answerCover` is the code that actually chunks at `COVER_CHUNK_BYTES`, so a
   jacket larger than that constant IS the property under test here: shrink it
   and the real 512 KiB boundary is covered nowhere.

   `covers.test.ts` and `fetch.test.ts` used to carry the same half-megabyte
   jacket and the same allowance, and for them the size was INCIDENTAL — the
   fetcher follows `offset`/`more` and never reads the constant, so their fake
   servers chunk at 2048 bytes now and their tests run in tens of milliseconds
   instead of timing out. That is why this comment no longer points at them.

   The cost here is real and bounded: ~4 s under coverage instrumentation on an
   idle machine, against the sixty below. The default fifteen is not enough —
   `covers.test.ts` blew a SIXTY-second budget intermittently on `main` before
   its jacket was shrunk, which is what a 3x margin buys you under parallel
   load. If this ever starts failing, the answer is not a bigger number: it is
   that the margin has gone and the test needs to stop hashing in JavaScript. */
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
  type Sealed,
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

/**
 * A serving transaction, as the store's queue runs one: read, step, write.
 *
 * ⚠️ **THE PAGES ARE CUT INSIDE IT.** `Serving` used to expose a read and a
 * seal as two calls, and two requests around a new share could cut the same
 * range two ways and disagree about what the first boundary was — see
 * `Serving.withShared`. A double that reads and writes in two steps would not
 * hold the fix it is testing.
 */
const transact = async <F, T>(read: () => F, write: (next: F) => void, step: (held: F) => Promise<Sealed<F, T>>): Promise<T> => {
  const held = read()
  const made = await step(held)
  if (made.held !== held) write(made.held)
  return made.answer
}

/** A store of one book's file, transacted — the default `withShared`. */
const oneBook = (read: () => SharedFile, write: (next: SharedFile) => void = () => {}) =>
  ((_bookId, step) => transact(read, write, step)) as Serving['withShared']

/** A store of lists, transacted — the ids come from it and so do the rows. */
const listsOf = (rows: readonly { id: string; held: ListFile }[], write: (id: string, next: ListFile) => void = () => {}): Partial<Serving> => ({
  listIds: () => Promise.resolve(rows.map((one) => one.id)),
  withList: (listId, step) => transact(() => rows.find((one) => one.id === listId)?.held ?? NOTHING_LISTED, (next) => write(listId, next), step),
})

function serving(over: Partial<Serving> = {}): Serving {
  return {
    books: [MOBY],
    withShared: oneBook(published),
    publisher: () => Promise.resolve(publisher()),
    shelf: () => Promise.resolve(NOTHING_SHELVED),
    withShelf: (step) => transact(() => NOTHING_SHELVED, () => {}, step),
    listIds: () => Promise.resolve([]),
    withList: (_listId, step) => transact(() => NOTHING_LISTED, () => {}, step),
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

describe('the fields a claim is made from', () => {
  it('leaves out each field the book does not carry, and carries each it does', () => {
    /* ⚠️ **EVERY FIXTURE WAS A WHOLE BOOK OR A BARE ONE.** Each of the four
       fields is spread conditionally, and with nothing between the two
       extremes any one of the conditions could be inverted or its value
       dropped: a claim built without the identifier still matched by title,
       and a claim built without the title still matched by identifier. A claim
       is how a request names a book, so a field that quietly vanishes from it
       is a request for something else.

       The digests are the assertion, because a claim is digests: two books
       differing in ONE field must not produce the same claim. */
    const whole = { id: 'x', title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247', languages: ['en'] }
    const full = claimOf(whole)
    expect(full.ids.length).toBeGreaterThan(0)
    expect(full.titles.length).toBeGreaterThan(0)
    expect(full.author).not.toBe('')
    expect(full.language).toBe('en')

    for (const missing of ['title', 'author', 'identifier', 'languages'] as const) {
      const { [missing]: _gone, ...rest } = whole
      expect(claimOf(rest as typeof whole), missing).not.toEqual(full)
    }
    /* And a book with none of them is a claim naming nothing, rather than a
       claim naming `undefined`. */
    expect(claimOf({ id: 'x' })).toEqual({ ids: [], titles: [], author: '', language: '' })
  })
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
    const empty = await answerPages(ask(), serving({ withShared: oneBook(() => NOTHING_PUBLISHED) }))
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
    const wrote: SharedFile[] = []
    const answer = await answerPages(ask(), serving({ withShared: oneBook(published, (next) => wrote.push(next)) }))

    expect(wrote).toHaveLength(1)
    expect(wrote[0]!.sealed.length).toBeGreaterThan(0)
    expect(answer?.pages.length).toBeGreaterThan(0)
  })

  it('does not write when there was nothing new to seal', async () => {
    const sealed = { ...published(), sealed: [{ device: DEVICE.id, from: 1, to: 1, v: WIRE_VERSION }] }
    const wrote: SharedFile[] = []
    await answerPages(ask(), serving({ withShared: oneBook(() => sealed, (next) => wrote.push(next)) }))
    expect(wrote).toEqual([])
  })
})

describe('two requests around one new share — the lost boundary', () => {
  it('cuts the second page from the boundaries the first sealed, not from an empty list', async () => {
    /* ⚠️ **THE PAGES WERE CUT OUTSIDE THE TRANSACTION THAT STORED THEM.**
       `Serving` exposed a read and a seal as two calls, so two requests
       arriving around a new share both read a file with no boundaries: one cut
       `[1]` and sent it, the other cut `[1, 2]` and sent that, and whichever
       wrote last decided what the store said the first boundary was. The
       recipient holding the other page then has a head that no later page
       chains to, and `checkPage` refuses everything after it as `chain` — for
       ever, because the page it holds is never re-sent.

       Here the two requests are interleaved deliberately: the second begins
       while the first is still deciding. Through one lane the second sees the
       first's boundary and continues the chain; through two calls it would not
       have. */
    const files = new Map<string, SharedFile>()
    files.set(MOBY.id, published())
    /* A queue of one lane, as the store's is. */
    let lane: Promise<unknown> = Promise.resolve()
    const serve = serving({
      withShared: (bookId, step) => {
        const mine = lane.then(async () => {
          const held = files.get(bookId) ?? NOTHING_PUBLISHED
          const made = await step(held)
          if (made.held !== held) files.set(bookId, made.held)
          return made.answer
        })
        lane = mine.catch(() => undefined)
        return mine as never
      },
    })

    const first = answerPages(ask(), serve)
    /* A second share lands, and a second request with it, before the first has
       finished deciding its boundary. */
    files.set(MOBY.id, share(files.get(MOBY.id)!, { markId: 'm2', passage: { quote: 'two', prefix: '', suffix: '', chapter: 'One' }, device: DEVICE.id }, 'pub2', makeHlc(NOW + 1, 0, DEVICE.id.slice(0, 16))).held)
    const second = answerPages(ask(), serve)
    const [a, b] = await Promise.all([first, second])

    /* The boundaries the store ended with cover every sequence exactly once
       and in order — which is what `isSealedPage` and `chainOrder` require and
       what a racing pair could not produce. */
    const sealed = [...files.get(MOBY.id)!.sealed].sort((x, y) => x.from - y.from)
    expect(sealed.length).toBeGreaterThan(0)
    let previous = 0
    for (const boundary of sealed) {
      expect(boundary.from).toBe(previous + 1)
      previous = boundary.to
    }
    /* And every page either request sent belongs to one of them. */
    for (const page of [...(a?.pages ?? []), ...(b?.pages ?? [])]) {
      const { from, to } = JSON.parse(page) as { from: number; to: number }
      expect(sealed.some((one) => one.from === from && one.to === to), `page ${from}-${to}`).toBe(true)
    }
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
        withShared: (bookId, step) => transact(() => files.get(bookId) ?? NOTHING_PUBLISHED, (next) => files.set(bookId, next), step),
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
  /* Named `shelved` and not `withShelf`: the port is called `withShelf`, and a
     helper sharing its name is one an override can silently miss — this used
     to set only the read port, so the transaction served an empty shelf. */
  const shelved = (held: ShelfFile) =>
    serving({
      shelf: () => Promise.resolve(held),
      withShelf: (step) => transact(() => held, () => {}, step),
      publisher: () => Promise.resolve({ ...publisher(), work: SHELF_WORK }),
    })
  const ask = (over: Record<string, unknown> = {}) => ({ since: {}, v: WIRE_VERSION, ...over })

  it('serves the shelf to a person the switch is on for, and a recipient takes it', async () => {
    const answer = await answerShelf(ask(), shelved(shelfOf([{ bookId: 'b1', title: 'Moby-Dick', author: 'Melville' }])), true)
    expect(answer?.pages.length).toBe(1)
    const taken = takePages(answer!.pages, SHELF_WORK, PERSON.id, { held: NOTHING_SHARED, devices: [DEVICE.id], revoked: [], epoch: 0, relationshipEpoch: 1, admitted: true }, pageCrypto, NOW, WIRE_VERSION)
    expect(taken.refusals).toEqual([])
    expect(taken.held.works.map((one) => one.work.title)).toEqual(['Moby-Dick'])
  })

  it('answers a person the switch is OFF for with bytes identical to a reader who owns nothing — the falsifier', async () => {
    const off = await answerShelf(ask(), shelved(shelfOf([{ bookId: 'b1', title: 'Moby-Dick', author: 'Melville' }])), false)
    const empty = await answerShelf(ask(), shelved(NOTHING_SHELVED), true)
    expect(JSON.stringify(off)).toBe(JSON.stringify(empty))
    expect(off).toEqual({ pages: [], more: false })
  })

  it('does not read or seal the shelf for a person the switch is off for', async () => {
    const opened: string[] = []
    const withShelf = vi.fn((step) => {
      opened.push('read')
      return transact(() => shelfOf([{ bookId: 'b1', title: 'T', author: 'A' }]), () => opened.push('write'), step)
    }) as unknown as Serving['withShelf']
    await answerShelf(ask(), serving({ withShelf }), false)
    expect(opened).toEqual([])
  })

  it('refuses a request that names no version or a version with no shelf, and one this build cannot parse', async () => {
    const held = shelved(shelfOf([{ bookId: 'b1', title: 'T', author: 'A' }]))
    const { v: _none, ...unversioned } = ask()
    expect(await answerShelf(unversioned, held, true)).toBeNull()
    expect(await answerShelf(ask({ v: 1 }), held, true)).toBeNull()
    expect(await answerShelf(ask({ v: WIRE_VERSION + 1 }), held, true)).toBeNull()
    expect(await answerShelf(ask({ work: SHELF_WORK }), held, true)).toBeNull()
    expect(await answerShelf('shelf', held, true)).toBeNull()
  })

  it('seals the boundaries before the pages go out, and not again when nothing is new', async () => {
    const wrote: ShelfFile[] = []
    const shelvedAs = (read: () => ShelfFile) =>
      serving({
        withShelf: (step) => transact(read, (next) => wrote.push(next), step),
        publisher: () => Promise.resolve({ ...publisher(), work: SHELF_WORK }),
      })
    await answerShelf(ask(), shelvedAs(() => shelfOf([{ bookId: 'b1', title: 'T', author: 'A' }])), true)
    expect(wrote).toHaveLength(1)
    const sealed = wrote[0]!
    await answerShelf(ask(), shelvedAs(() => sealed), true)
    expect(wrote).toHaveLength(1)
  })
})

describe('answering a request for the lists — WI-23.E1, under WI-23.C2’s switch', () => {
  const by = (n: number) => ({ device: DEVICE.id, at: makeHlc(NOW + n, 0, DEVICE.id.slice(0, 16)) })
  const seaBooks = (): ListFile =>
    placeOnList(createList(NOTHING_LISTED, 'Sea books', by(1)), { pub: 'i1', work: { title: 'Moby-Dick', author: 'Melville', language: 'en' }, position: 1, note: 'start here' }, by(2))
  const withLists = (lists: readonly { id: string; held: ListFile }[], over: Partial<Serving> = {}) =>
    serving({ ...listsOf(lists), publisher: (work) => Promise.resolve({ ...publisher(), work }), ...over })
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
    const touched: string[] = []
    const listIds = vi.fn(() => {
      touched.push('ids')
      return Promise.resolve(['aa11'])
    })
    const withList = ((listId, step) => {
      touched.push('open ' + listId)
      return transact(seaBooks, () => touched.push('write'), step)
    }) as Serving['withList']
    await answerLists(ask(), serving({ listIds, withList }), false)
    expect(touched).toEqual([])
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
    const wrote: string[] = []
    const serve = serving({
      listIds: () => Promise.resolve([...sealed.keys()]),
      withList: (listId, step) =>
        transact(
          () => sealed.get(listId) ?? NOTHING_LISTED,
          (next) => {
            wrote.push(listId)
            sealed.set(listId, next)
          },
          step,
        ),
      publisher: (work) => Promise.resolve({ ...publisher(), work }),
    })
    await answerLists(ask(), serve, true)
    expect(wrote).toEqual(['aa11'])
    await answerLists(ask(), serve, true)
    expect(wrote).toEqual(['aa11'])
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
    const serve = serving({ ...listsOf([{ id: 'aa11', held }]), publisher: (work) => Promise.resolve({ ...publisher(), work }) })
    const answer = await answerLists(ask(), serve, true, { maxPages: 1, budget: 1_200 })
    expect(answer?.pages).toHaveLength(1)
    expect(answer?.more).toBe(true)
  })

  it('fills one answer to the cap exactly without saying there is more', async () => {
    const lists = Array.from({ length: MAX_PAGES_PER_ANSWER }, (_, i) => ({ id: `b${i.toString(16).padStart(3, '0')}`, held: createList(NOTHING_LISTED, `L${i}`, by(i + 1)) }))
    const answer = await answerLists(ask(), serving({ ...listsOf(lists), publisher: (work) => Promise.resolve({ ...publisher(), work }) }), true)
    expect(answer?.pages).toHaveLength(MAX_PAGES_PER_ANSWER)
    expect(answer?.more).toBe(false)
  })
})

describe('the answer’s BYTE budget, across the lists', () => {
  const by = (n: number) => ({ device: DEVICE.id, at: makeHlc(NOW + n, 0, DEVICE.id.slice(0, 16)) })
  const long = (seed: number): ListFile => {
    let held = createList(NOTHING_LISTED, `L${seed}`, by(seed * 100))
    /* ⚠️ **LONG ENOUGH TO CUT INTO SEVERAL PAGES**, or the room handed down
       cannot be seen: a list that fits in one page fits whatever the budget
       says, and `maxBytes - bytes` and `maxBytes + bytes` produce the same
       single page. */
    for (let i = 0; i < 24; i++) {
      held = placeOnList(
        held,
        { pub: `i${seed}-${i}`, work: { title: `Book ${i}`, author: 'A', language: 'en' }, position: i + 1, note: 'x'.repeat(900) },
        by(seed * 100 + i + 1),
      )
    }
    return held
  }
  const four = () => ['aa11', 'bb22', 'cc33', 'dd44'].map((id, i) => ({ id, held: long(i + 1) }))
  const watched = (rows: readonly { id: string; held: ListFile }[]) => {
    const opened: string[] = []
    let signed = 0
    const serve = serving({
      listIds: () => Promise.resolve(rows.map((one) => one.id)),
      withList: (listId, step) => {
        opened.push(listId)
        return transact(() => rows.find((one) => one.id === listId)!.held, () => {}, step)
      },
      publisher: (work) =>
        Promise.resolve({
          ...publisher(),
          work,
          sign: (message: string) => {
            signed += 1
            return publisher().sign(message)
          },
        }),
    })
    return { opened, serve, signatures: () => signed }
  }
  const ask = (over: Record<string, unknown> = {}) => ({ since: {}, v: WIRE_VERSION, ...over })
  /* A small page budget, so each list is SEVERAL pages: with the default one
     the whole list fits in a single page and no bound below can be seen. */
  const cut = { maxPages: 20, budget: 1_200 }
  /** One page's worth of the answer's byte budget, measured rather than guessed. */
  const onePage = async () => {
    const whole = await answerLists(ask(), watched(four()).serve, true, cut)
    expect(whole?.pages.length).toBeGreaterThan(2)
    return wireBytesOf(whole!.pages[0]!)
  }

  it('stops OPENING lists once the bytes are spent, and says there is more', async () => {
    /* ⚠️ **THE BUDGET IS TWO BOUNDS AND ONLY THE PAGE COUNT WAS TESTED.** A
       caller with many lists could spend every byte of the frame on the first
       and still have this side read, cut and SIGN pages for the rest — work
       thrown away, and a key operation per page of it. The byte half of the
       guard had no fixture at all: with `bytes >= maxBytes` deleted, every list
       is opened however full the answer already is. */
    const tight = watched(four())
    const answer = await answerLists(ask(), tight.serve, true, { ...cut, maxChars: await onePage() })
    expect(answer?.pages).toHaveLength(1)
    expect(answer?.more).toBe(true)
    /* Spent exactly, so nothing after the first is opened. */
    expect(tight.opened).toEqual(['aa11'])
  })

  it('stops at the first list whose page will not fit, even when that list has nothing more', async () => {
    /* ⚠️ **`more = true` INSIDE THE PAGE LOOP IS WHAT ENDS THE ANSWER**, and
       every fixture hid it: a long list sets `more` again from its own
       `built.more` one line later, so the flag was true either way and the
       loop broke for the wrong reason. A SHORT list — one page, nothing after
       it — has no `built.more` to fall back on. Without the assignment the
       answer carries on opening lists it has no room for, signing a page for
       each.

       Two long lists fill the budget; the third is one page and does not fit;
       the fourth must never be opened. */
    const short = (seed: number): ListFile =>
      placeOnList(
        createList(NOTHING_LISTED, `S${seed}`, by(seed * 100)),
        { pub: `s${seed}`, work: { title: 'T', author: 'A', language: 'en' }, position: 1, note: 'y'.repeat(400) },
        by(seed * 100 + 1),
      )
    const rows = [
      { id: 'aa11', held: long(1) },
      { id: 'bb22', held: short(2) },
      { id: 'cc33', held: short(3) },
    ]
    const one = await onePage()
    const tight = watched(rows)
    /* Room for one page and a little — enough that the second list is opened,
       not enough that its page fits. */
    const answer = await answerLists(ask(), tight.serve, true, { ...cut, maxChars: one + 10 })

    expect(answer?.pages).toHaveLength(1)
    expect(answer?.more).toBe(true)
    expect(tight.opened).toEqual(['aa11', 'bb22'])
  })

  it('hands each list only the room that is LEFT, so nothing is signed to be thrown away', async () => {
    /* ⚠️ **THE ROOM PASSED DOWN IS `maxBytes - bytes`, AND NOTHING READ IT.**
       Handed the whole budget again — `maxBytes + bytes` — a later list walks
       its chain further and SIGNS pages the answer has no room for. The answer
       is the same either way, because the outer loop measures every page again
       before sending it; what differs is the work. A signature is the most
       expensive thing this path does, and counting them is the only way the
       difference shows.

       ⚠️ **AND ONE LIST IS ALWAYS CUT AND NOT SENT.** `pagesOver` lets a log's
       first page through whatever the room says — a page has to be sendable on
       its own — so the list the answer stops at is walked before this side
       learns it does not fit. Bounded to one, because the loop then breaks. */
    const one = await onePage()
    const tight = watched(four())
    const answer = await answerLists(ask(), tight.serve, true, { ...cut, maxChars: one * 2 + 1 })

    expect(answer?.pages).toHaveLength(2)
    expect(answer?.more).toBe(true)
    /* The first list fills the answer; the second is opened, walked as far as
       the ONE byte left allows, and sends nothing. The third and fourth are
       never opened. */
    expect(tight.opened).toEqual(['aa11', 'bb22'])
    /* ⚠️ **FOUR SIGNATURES, AND THE WHOLE POINT IS THAT IT IS NOT FIVE.**
       Handed the whole frame again instead of what is left, the second list
       walks one page further and signs it — measured, 5 — and the answer is
       byte for byte the same, because the outer loop weighs every page again.
       Only the count of the most expensive operation on this path shows it. */
    expect(tight.signatures()).toBe(4)
  })
})

describe('the cap bounds the work, not only the wire', () => {
  it('cuts and seals nothing for a list past the cap', async () => {
    const by = (n: number) => ({ device: DEVICE.id, at: makeHlc(NOW + n, 0, DEVICE.id.slice(0, 16)) })
    const lists = Array.from({ length: MAX_PAGES_PER_ANSWER + 3 }, (_, i) => ({ id: `c${i.toString(16).padStart(3, '0')}`, held: createList(NOTHING_LISTED, `L${i}`, by(i + 1)) }))
    const wrote: string[] = []
    const answer = await answerLists(
      { since: {}, v: WIRE_VERSION },
      serving({ ...listsOf(lists, (id) => wrote.push(id)), publisher: (work) => Promise.resolve({ ...publisher(), work }) }),
      true,
    )
    expect(answer?.pages).toHaveLength(MAX_PAGES_PER_ANSWER)
    expect(answer?.more).toBe(true)
    /* Nothing cut or sealed for a list past the cap. */
    expect(wrote).toHaveLength(MAX_PAGES_PER_ANSWER)
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
