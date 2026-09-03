import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { canonicalJson, makeHlc, type Hlc, type Passage, type WorkClaim } from '../../../kernel'
import { pageCrypto } from './crypto'
import { delegationBytes, takePages, type Ledger, type SignedDelegation } from './receive'
import {
  DEFAULT_BOUNDS,
  NOTHING_PUBLISHED,
  logOf,
  readShared,
  writeShared,
  nextSeqFor,
  pagesFor,
  share,
  unshare,
  type Publisher,
  type SharedFile,
} from './publish'
import { NOTHING_SHARED, type LaneFor } from './store'
import { MAX_PAGES_PER_ANSWER, MAX_PAGE_CHARS } from './protocol'
import { fakeFs } from '../../../kernel/testkit'
import { sharedPathIn, type VaultFs, type WriteQueue } from '../../../kernel'

hashes.sha512 = sha512

/**
 * The publisher's side, and the loop closed.
 *
 * ⚠️ **THE LAST TWO DESCRIBES ARE THE ONLY PLACE BOTH HALVES MEET.** Everything
 * else in this capability tests one direction against a fixture the same file
 * built. A page that `pagesFor` emits and `takePages` accepts is the first
 * evidence that the two agree about anything — and the first version did not:
 * the wire bytes were built with `signedBytes`, which DROPS `sig`, so every
 * page went out unsigned and no test on this side could see it.
 */

const NOW = 1_700_000_000_000
const WORK: WorkClaim = { ids: ['w1'], titles: ['t1'], author: 'a1', language: 'en' }

function keypair(seed: string) {
  const secret = utf8ToBytes(seed.padEnd(32, '.')).slice(0, 32)
  return { secret, id: bytesToHex(getPublicKey(secret)) }
}
const PERSON = keypair('person')
const DEVICE = keypair('device')
const PHONE = keypair('phone')

const stamp = (n: number, device: string): Hlc => makeHlc(NOW + n, 0, device.slice(0, 16))

const passage = (quote: string): Passage => ({
  quote,
  prefix: 'before ',
  suffix: ' after',
  chapter: 'One',
})

/** A delegation the person really signed, for `device`. */
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

const publisher = (over: Partial<Publisher> = {}): Publisher => ({
  person: PERSON.id,
  device: DEVICE.id,
  work: WORK,
  roster: [DEVICE.id, PHONE.id],
  revocations: 0,
  delegation: delegationFor(DEVICE.id),
  sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), DEVICE.secret))),
  ...over,
})

const ledger = (over: Partial<Ledger> = {}): Ledger => ({
  held: NOTHING_SHARED,
  devices: [DEVICE.id, PHONE.id],
  revoked: [],
  epoch: 0,
  relationshipEpoch: 1,
  admitted: true,
  ...over,
})

/** Two shares from the desktop. */
function twoShares(): SharedFile {
  let held = NOTHING_PUBLISHED
  held = share(held, { markId: 'm1', passage: passage('first'), device: DEVICE.id }, 'pub1', stamp(1, DEVICE.id)).held
  held = share(held, { markId: 'm2', passage: passage('second'), device: DEVICE.id }, 'pub2', stamp(2, DEVICE.id)).held
  return held
}

describe("the publisher's store", () => {
  it('keeps what was published rather than pointing at the mark', () => {
    /* ⚠️ **THE ROW WAS A POINTER, AND `wire.md` REFUSES IT.** Edit the note,
       delete the mark, restart — and the page already served cannot be
       reproduced, so the signature a friend still holds can never be checked
       again. It is also the right semantics: editing your note changes what you
       think, not what you said. */
    const held = twoShares()
    expect(held.publications[0]?.passage.quote).toBe('first')
    expect(held.publications[0]?.markId).toBe('m1')
  })

  it('mints a publication id per share, so two shares of one mark are two things', () => {
    /* `share(P), share(P), unshare(P)` has to be three unambiguous entries. */
    let held = NOTHING_PUBLISHED
    held = share(held, { markId: 'm1', passage: passage('x'), device: DEVICE.id }, 'a', stamp(1, DEVICE.id)).held
    held = share(held, { markId: 'm1', passage: passage('x'), device: DEVICE.id }, 'b', stamp(2, DEVICE.id)).held
    held = unshare(held, 'a', stamp(3, DEVICE.id))

    const log = logOf(held)
    expect(log.filter((one) => one.op === 'share')).toHaveLength(2)
    const tombstones = log.filter((one) => one.op === 'unshare')
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.pub).toBe('a')
  })

  it('gives a withdrawal its own sequence, and never reissues one', () => {
    /* ⚠️ **COUNTING ONLY SHARES REISSUES THE NUMBER THE WITHDRAWAL HOLDS**, and
       two entries at one `(device, seq)` is the collision the per-device key
       exists to make impossible. */
    let held = twoShares()
    expect(nextSeqFor(held, DEVICE.id)).toBe(3)
    held = unshare(held, 'pub1', stamp(3, DEVICE.id))
    expect(held.publications[0]?.unshared?.seq).toBe(3)
    expect(nextSeqFor(held, DEVICE.id)).toBe(4)

    const seqs = logOf(held).map((one) => one.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('counts sequences per device, so two of your machines are two streams', () => {
    /* `mergeLogs`: two desktops both minting seq 11 is one collision with a
       shared counter and two streams with a per-device one. */
    let held = twoShares()
    held = share(held, { markId: 'm3', passage: passage('third'), device: PHONE.id }, 'pub3', stamp(4, PHONE.id)).held
    expect(nextSeqFor(held, PHONE.id)).toBe(2)
    expect(nextSeqFor(held, DEVICE.id)).toBe(3)
  })

  it('keeps the row when it is withdrawn, tombstone and all', () => {
    const held = unshare(twoShares(), 'pub1', stamp(3, DEVICE.id))
    expect(held.publications).toHaveLength(2)
    expect(held.publications[0]?.passage.quote).toBe('first')
  })

  it('does not withdraw the same publication twice', () => {
    const once = unshare(twoShares(), 'pub1', stamp(3, DEVICE.id))
    const twice = unshare(once, 'pub1', stamp(9, DEVICE.id))
    expect(twice.publications[0]?.unshared?.seq).toBe(3)
  })

  it('never puts a passage on a withdrawal', () => {
    /* ⚠️ **A TOMBSTONE THAT REPEATED THE QUOTE WOULD DISCLOSE THE WITHDRAWN
       PASSAGE** to a peer who never saw the share — a retraction that publishes
       the thing being retracted. The type enforces it; this checks the value. */
    const held = unshare(twoShares(), 'pub1', stamp(3, DEVICE.id))
    for (const entry of logOf(held)) {
      if (entry.op === 'unshare') expect(Object.hasOwn(entry, 'passage')).toBe(false)
    }
  })
})

describe('the order of the log', () => {
  it('is by stamp, so a reader sees things in the order they were said', () => {
    /* ⚠️ **UNSORTED, THE LOG IS IN WHATEVER ORDER THE STORE HAPPENED TO HOLD**
       — which is insertion order per device, and therefore not an order at all
       once two devices are in play. `mergeLogs` merges by HLC for this reason;
       so does this. */
    let held = NOTHING_PUBLISHED
    held = share(held, { markId: 'm2', passage: passage('later'), device: DEVICE.id }, 'pub2', stamp(9, DEVICE.id)).held
    held = share(held, { markId: 'm1', passage: passage('earlier'), device: PHONE.id }, 'pub1', stamp(1, PHONE.id)).held

    expect(logOf(held).map((one) => one.pub)).toEqual(['pub1', 'pub2'])
  })

  it('puts a withdrawal after the share it withdraws', () => {
    const held = unshare(twoShares(), 'pub1', stamp(9, DEVICE.id))
    const log = logOf(held)
    const shared = log.findIndex((one) => one.pub === 'pub1' && one.op === 'share')
    const gone = log.findIndex((one) => one.pub === 'pub1' && one.op === 'unshare')
    expect(gone).toBeGreaterThan(shared)
  })
})

describe('the pages a publisher serves', () => {
  it('chains each page to the one before it', async () => {
    const { pages } = await pagesFor(twoShares(), publisher(), {}, pageCrypto.hash)
    expect(pages.length).toBeGreaterThan(0)
    const first = JSON.parse(pages[0] as string) as { prevPageHash: string }
    expect(first.prevPageHash).toBe('')
  })

  it('answers from the cursor rather than from the beginning', async () => {
    const held = twoShares()
    const all = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    const rest = await pagesFor(held, publisher(), { [DEVICE.id]: 99 }, pageCrypto.hash)
    expect(all.pages.length).toBeGreaterThan(0)
    expect(rest.pages).toEqual([])
  })

  it('serves only this device’s stream', async () => {
    /* The sequence is per device, so a page mixing two devices' entries has a
       `from`/`to` range that means nothing. */
    let held = twoShares()
    held = share(held, { markId: 'm3', passage: passage('phone'), device: PHONE.id }, 'pub3', stamp(4, PHONE.id)).held

    const { pages } = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    const entries = pages.flatMap(
      (raw) => (JSON.parse(raw) as { entries: { device: string }[] }).entries,
    )
    expect(entries.every((one) => one.device === DEVICE.id)).toBe(true)
  })

  it('pages this device’s stream in sequence order, whatever order the store holds', async () => {
    /* ⚠️ **`from`/`to` ARE A RANGE, AND A PAGE BUILT OUT OF ORDER HAS A RANGE
       THAT MEANS NOTHING** — the recipient's cursor then skips or re-fetches.
       The store is appended to in publication order, which is not sequence
       order once a withdrawal comes between two shares. */
    let held = twoShares()
    held = unshare(held, 'pub1', stamp(3, DEVICE.id))
    held = share(held, { markId: 'm3', passage: passage('third'), device: DEVICE.id }, 'pub3', stamp(4, DEVICE.id)).held

    const { pages } = await pagesFor(held, publisher(), {}, pageCrypto.hash, { maxPages: 32, budget: 1 })
    const ranges = pages.map((raw) => JSON.parse(raw) as { from: number; to: number })

    expect(ranges.map((one) => one.from)).toEqual([...ranges.map((one) => one.from)].sort((a, b) => a - b))
    for (const range of ranges) expect(range.to).toBeGreaterThanOrEqual(range.from)
  })

  it('ignores boundaries belonging to another device', async () => {
    /* ⚠️ **THE CHAIN IS PER DEVICE.** Counting the phone's sealed pages as this
       device's would put this device's first page behind a hash it never
       produced, and every recipient would refuse it as `chain` — and it would
       ALSO leave this device's own entries unsealed, so they would be
       re-paginated on every fetch. */
    const held = { ...twoShares(), sealed: [{ device: PHONE.id, from: 1, to: 5 }] }
    const built = await pagesFor(held, publisher(), {}, pageCrypto.hash)

    /* This device sealed its own pages, and the phone's boundary was left
       alone rather than consumed as though it were this device's. */
    const mine = built.held.sealed.filter((one) => one.device === DEVICE.id)
    expect(mine).toEqual([{ device: DEVICE.id, from: 1, to: 2 }])
    expect(built.pages).toHaveLength(1)
    const first = JSON.parse(built.pages[0] as string) as { from: number; to: number }
    expect(first).toMatchObject({ from: 1, to: 2 })
  })

  it('orders pages by sequence even when the stamps do not agree', async () => {
    /* ⚠️ **`from`/`to` ARE A SEQUENCE RANGE, AND `logOf` SORTS BY STAMP.** For
       one device the two orders normally coincide, because an HLC advances
       with every entry — so a fixture with tidy stamps cannot tell them apart.
       A publication stamped BEHIND its predecessor is what discriminates, and
       without the sequence sort its page carries a range that runs backwards.
       The recipient's cursor then skips or re-fetches, silently. */
    let held = NOTHING_PUBLISHED
    held = share(held, { markId: 'm1', passage: passage('one'), device: DEVICE.id }, 'pub1', stamp(9, DEVICE.id)).held
    held = share(held, { markId: 'm2', passage: passage('two'), device: DEVICE.id }, 'pub2', stamp(1, DEVICE.id)).held

    const built = await pagesFor(held, publisher(), {}, pageCrypto.hash, { maxPages: 32, budget: 1 })
    const ranges = built.pages.map((raw) => JSON.parse(raw) as { from: number; to: number })

    expect(ranges).toEqual([
      expect.objectContaining({ from: 1, to: 1 }),
      expect.objectContaining({ from: 2, to: 2 }),
    ])
  })

  it('does not put a hole in a page when a boundary outlives its entries', async () => {
    /* ⚠️ **A STORED BOUNDARY CAN COVER A SEQUENCE THAT IS NO LONGER THERE** —
       a file edited by hand, a row dropped by a migration. Pushing the missing
       entry would put a `null` inside `entries`, and the page goes out signed,
       canonical, and holding a hole no recipient can diagnose. */
    const held = {
      ...twoShares(),
      /* A range covering a third entry that was never published. */
      sealed: [{ device: DEVICE.id, from: 1, to: 3 }],
    }
    const built = await pagesFor(held, publisher(), {}, pageCrypto.hash)

    const page = JSON.parse(built.pages[0] as string) as { entries: unknown[] }
    expect(page.entries).toHaveLength(2)
    expect(page.entries.every((one) => one !== null && one !== undefined)).toBe(true)
  })

  it('does not change a page it has already served when the log grows', async () => {
    /* ⚠️ **THE DEFECT THE ROUND TRIP FOUND, AND THE REASON BOUNDARIES ARE
    WRITTEN DOWN.** `paginate` fills greedily from the start: a log of two
    entries yields the page `[e1, e2]`, and a log of three yields
    `[e1, e2, e3]` — a different first page, with different bytes and a
    different hash. Every recipient holding the old one then refuses the next
    with `chain`, and the symptom is a friend who silently stops receiving
    anything after their third passage. For ever. */
    let held = twoShares()
    const first = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    held = first.held

    held = share(held, { markId: 'm3', passage: passage('third'), device: DEVICE.id }, 'pub3', stamp(5, DEVICE.id)).held
    const again = await pagesFor(held, publisher(), {}, pageCrypto.hash)

    expect(again.pages[0]).toBe(first.pages[0])
    expect(again.pages.length).toBeGreaterThan(first.pages.length)
  })

  it('seals a boundary once and never moves it', async () => {
    let held = twoShares()
    held = (await pagesFor(held, publisher(), {}, pageCrypto.hash)).held
    const sealed = held.sealed
    held = share(held, { markId: 'm3', passage: passage('third'), device: DEVICE.id }, 'pub3', stamp(5, DEVICE.id)).held
    held = (await pagesFor(held, publisher(), {}, pageCrypto.hash)).held

    expect(held.sealed.slice(0, sealed.length)).toEqual(sealed)
  })

  it('seals boundaries that never overlap, however often it is asked', async () => {
    /* ⚠️ **THE ASSERTION THAT ACTUALLY CATCHES RE-PAGINATION, AND THE TWO
    ABOVE DO NOT.** Paginating the whole log again on every fetch produces
    boundaries like `[1-2]` then `[1-3]`: the PREFIX is unchanged and the first
    emitted page is byte-identical, so a test comparing either is satisfied.
    What is wrong is the overlap — entry 1 is now served in two different
    pages, and `sealed` grows by the whole log every time anybody fetches. A
    file that grows in proportion to how often your friends read is not a
    thing anybody notices until it is very large. */
    let held = twoShares()
    for (const [n, quote] of [[5, 'third'], [6, 'fourth'], [7, 'fifth']] as const) {
      held = (await pagesFor(held, publisher(), {}, pageCrypto.hash)).held
      /* Fetched twice between writes, as two friends would. */
      held = (await pagesFor(held, publisher(), {}, pageCrypto.hash)).held
      held = share(held, { markId: `m${n}`, passage: passage(quote), device: DEVICE.id }, `pub${n}`, stamp(n, DEVICE.id)).held
    }
    held = (await pagesFor(held, publisher(), {}, pageCrypto.hash)).held

    const mine = held.sealed.filter((one) => one.device === DEVICE.id)
    let top = 0
    for (const boundary of mine) {
      expect(boundary.from).toBeGreaterThan(top)
      expect(boundary.to).toBeGreaterThanOrEqual(boundary.from)
      top = boundary.to
    }
  })

  it('says there is more when it reaches the cap, and stops there', async () => {
    /* ⚠️ **A `more` THAT IS NEVER SET IS A BACKFILL THAT STOPS HALFWAY** and a
       reader who holds part of a friend's log for ever, with nothing anywhere
       saying so. Reached through `Bounds` because the real cap needs thirty
       megabytes of fixture. */
    let held = NOTHING_PUBLISHED
    for (let n = 1; n <= 5; n++) {
      held = share(held, { markId: `m${n}`, passage: passage(`q${n}`), device: DEVICE.id }, `pub${n}`, stamp(n, DEVICE.id)).held
    }
    /* A budget of nothing puts each entry on its own page. */
    const built = await pagesFor(held, publisher(), {}, pageCrypto.hash, { maxPages: 2, budget: 1 })

    expect(built.pages).toHaveLength(2)
    expect(built.more).toBe(true)
  })

  it('does not claim there is more when it served everything', async () => {
    const built = await pagesFor(twoShares(), publisher(), {}, pageCrypto.hash, {
      maxPages: 32,
      budget: 1,
    })
    expect(built.more).toBe(false)
    expect(built.pages).toHaveLength(2)
  })

  it('leaves room in the budget for the envelope around the page', async () => {
    /* ⚠️ **`MAX_PAGE_CHARS` IS WHAT THE RECIPIENT REFUSES PAST.** A page sized
       to it exactly does not fit in the frame that carries it, so a publisher
       using the whole number emits pages nobody can accept — and the symptom
       is a friend who receives everything except the long passages. */
    expect(DEFAULT_BOUNDS.budget).toBeLessThan(MAX_PAGE_CHARS)
    expect(DEFAULT_BOUNDS.budget).toBeGreaterThan(0)
    expect(DEFAULT_BOUNDS.maxPages).toBe(MAX_PAGES_PER_ANSWER)
  })

  it('carries the roster and the delegation the publisher gave it', async () => {
    /* The receiver does not TRUST the page's roster — it is covered by the
       device's signature, not the person's — but a page that dropped it would
       still be a page missing a field `wire.md` says it carries. */
    const { pages } = await pagesFor(twoShares(), publisher(), {}, pageCrypto.hash)
    const page = JSON.parse(pages[0] as string) as { roster: string[]; delegation: string }

    expect(page.roster).toEqual([DEVICE.id, PHONE.id])
    expect(page.delegation).toBe(delegationFor(DEVICE.id))
  })

  it('has nothing to say when nothing was published, and seals nothing', async () => {
    /* ⚠️ **AND SEALS NOTHING — `paginate` ANSWERS AN EMPTY LOG WITH AN EMPTY
       PAGE**, which without the filter becomes a boundary of `0..0` written to
       the store on every fetch of a book nobody has shared from. The page
       itself is never sent (its `to` is not past the cursor), so the only
       symptom is a file that grows for a reader who has published nothing. */
    const built = await pagesFor(NOTHING_PUBLISHED, publisher(), {}, pageCrypto.hash)
    expect(built.pages).toEqual([])
    expect(built.more).toBe(false)
    expect(built.held.sealed).toEqual([])
  })
})

describe('a page this side published is a page the other side takes', () => {
  it('is accepted, entries and all', async () => {
    /* ⚠️ **THE FIRST TEST IN WHICH BOTH HALVES ARE THE SHIPPING CODE.** It
       failed on the first run: the wire bytes were built with `signedBytes`,
       which drops `sig`, so the page went out unsigned. Nothing on the
       publishing side could have noticed. */
    const { pages } = await pagesFor(twoShares(), publisher(), {}, pageCrypto.hash)

    const taken = takePages(pages, WORK, PERSON.id, ledger(), pageCrypto, NOW)

    expect(taken.refusals).toEqual([])
    expect(taken.accepted).toBe(pages.length)
    expect(taken.held.entries.map((one) => one.pub).sort()).toEqual(['pub1', 'pub2'])
    expect(taken.held.entries[0]?.passage.quote).toBe('first')
  })

  it('carries a withdrawal all the way through to the reader not seeing it', async () => {
    const held = unshare(twoShares(), 'pub1', stamp(3, DEVICE.id))
    const { pages } = await pagesFor(held, publisher(), {}, pageCrypto.hash)

    const taken = takePages(pages, WORK, PERSON.id, ledger(), pageCrypto, NOW)

    expect(taken.refusals).toEqual([])
    expect(taken.held.entries.map((one) => one.pub)).toEqual(['pub2'])
    expect(taken.held.withdrawn).toEqual(['pub1'])
  })

  it('resumes from a cursor without breaking the chain', async () => {
    /* ⚠️ **THE CHAIN IS WALKED FROM THE FIRST PAGE EVEN WHEN THE ANSWER STARTS
       LATER.** `prevPageHash` links every page this device ever emitted, so a
       server that skipped ahead would emit a page whose predecessor the
       recipient holds and whose hash does not match it. */
    let held = twoShares()
    const first = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    /* ⚠️ **THE SEALED BOUNDARIES ARE WRITTEN BACK, AND THAT IS THE POINT.**
       Dropping them re-paginates the log on the next fetch, which changes the
       bytes of a page every recipient already holds. */
    held = first.held
    const after = takePages(first.pages, WORK, PERSON.id, ledger(), pageCrypto, NOW)
    expect(after.refusals).toEqual([])

    held = share(held, { markId: 'm3', passage: passage('third'), device: DEVICE.id }, 'pub3', stamp(5, DEVICE.id)).held
    const next = await pagesFor(held, publisher(), after.cursor, pageCrypto.hash)

    const taken = takePages(
      next.pages,
      WORK,
      PERSON.id,
      ledger({ held: after.held }),
      pageCrypto,
      NOW,
    )

    expect(taken.refusals).toEqual([])
    expect(taken.held.entries.map((one) => one.pub).sort()).toEqual(['pub1', 'pub2', 'pub3'])
  })

  it('is refused once the publishing device is revoked', async () => {
    /* The loop, closed the other way: a page that verified yesterday must stop
       verifying the moment its author says that device is finished. */
    const { pages } = await pagesFor(twoShares(), publisher(), {}, pageCrypto.hash)

    const taken = takePages(
      pages,
      WORK,
      PERSON.id,
      ledger({ revoked: [DEVICE.id] }),
      pageCrypto,
      NOW,
    )

    expect(taken.accepted).toBe(0)
    expect(taken.refusals.every((one) => one === 'bad-delegation')).toBe(true)
  })
})

/* ───────────────────────────────────────────── the store on a filesystem */

const fsWith = (files: Record<string, string> = {}) => fakeFs(files) as unknown as VaultFs

const queueOf = (keys: string[] = []): WriteQueue => ({
  append: (key, task) => {
    keys.push(key)
    return task()
  },
  push: (key, task) => {
    keys.push(key)
    return task()
  },
  idle: () => Promise.resolve(),
})

const LANE: LaneFor = (bookId) => `book:${bookId}`
const BOOK = 'book:moby'

describe('reading and writing the publisher’s store', () => {
  it('round-trips what it wrote, boundaries and all', async () => {
    /* ⚠️ **WITH AN EMPTY `sealed` THE ROW CHECK IS NEVER RUN** — `[].every()`
       is vacuously true — so every clause of `isSealed` went unexercised while
       this test looked like a round trip. A store that round-trips only its
       empty case is not one. */
    const fs = fsWith()
    const held = { ...twoShares(), sealed: [{ device: DEVICE.id, from: 1, to: 2 }] }
    await writeShared(fs, queueOf(), LANE, BOOK, held)
    expect(await readShared(fs, BOOK)).toEqual(held)
  })

  it('reads nothing published for a book nobody has shared from', async () => {
    expect(await readShared(fsWith(), BOOK)).toEqual(NOTHING_PUBLISHED)
  })

  it('writes on the book’s own lane, never one derived here', async () => {
    /* ⚠️ `folderOf` is MANY-TO-ONE, so a lane keyed on the raw id splits one
       directory across two lanes — and a rekeyed book has to stay on the lane
       its earlier writes are still draining on. */
    const keys: string[] = []
    await writeShared(fsWith(), queueOf(keys), LANE, BOOK, twoShares())
    expect(keys).toEqual([LANE(BOOK)])
  })

  it('writes to the path beside marks.json, not inside circle/', async () => {
    /* ⚠️ **`peopleFor` LISTS `circle/` AND READS EVERY `*.json` AS A PERSON.**
       A publisher's file there would appear in the reader's own circle as
       somebody called `published`, and could not be removed because they do
       not exist. */
    const fs = fsWith()
    await writeShared(fs, queueOf(), LANE, BOOK, twoShares())
    expect(await fs.exists(sharedPathIn(BOOK))).toBe(true)
    expect(sharedPathIn(BOOK)).not.toContain('/circle/')
  })

  describe('a file it cannot read throws rather than reading as empty', () => {
    /**
     * ⚠️ **READING IT AS "NOTHING PUBLISHED" MINTS SEQUENCE NUMBERS ALREADY
     * USED**, and two different entries at one `(device, seq)` is a log every
     * recipient must refuse for ever. One row per clause, because a predicate
     * exercised by one bad input has clauses nobody has ever run.
     */
    const bad: readonly (readonly [string, string])[] = [
      ['a list', '[]'],
      ['a string', '"published"'],
      ['a number', '7'],
      ['null', 'null'],
    ]
    for (const [what, body] of bad) {
      it(`throws on ${what}`, async () => {
        const fs = fsWith({ [sharedPathIn(BOOK)]: body })
        await expect(readShared(fs, BOOK)).rejects.toThrow(/not a publisher's store/u)
      })
    }

    /* ⚠️ **EACH ROW IS BAD IN EXACTLY ONE WAY, AND THE FIRST VERSION WAS NOT.**
       Every fixture carried `passage: {}` as filler, so the LAST clause
       rejected the row and the clause actually under test was never reached —
       twelve tests that all proved the same thing while reading as twelve.
       A masked clause looks exactly like a covered one. */
    const good = () => ({
      pub: 'p',
      markId: 'm',
      device: 'd',
      seq: 1,
      at: 'x',
      passage: { quote: 'q', prefix: 'a', suffix: 'b', chapter: 'c' },
    })
    const noList: readonly (readonly [string, unknown])[] = [
      ['no publication list', undefined],
      ['a publication list that is a string', 'rows'],
      ['a publication list that is an object', {}],
      ['a row that is null', [null]],
      ['a row that is a string', ['pub1']],
      ['a row that is a number', [7]],
      ['a row that is an array', [[]]],
      ['a row with no pub', [{ ...good(), pub: undefined }]],
      ['a row with an empty pub', [{ ...good(), pub: '' }]],
      ['a row with a pub that is a number', [{ ...good(), pub: 1 }]],
      ['a row with no markId', [{ ...good(), markId: undefined }]],
      ['a row with a markId that is a number', [{ ...good(), markId: 1 }]],
      ['a row with no device', [{ ...good(), device: undefined }]],
      ['a row with a device that is a number', [{ ...good(), device: 1 }]],
      ['a row with no stamp', [{ ...good(), at: undefined }]],
      ['a row with a stamp that is a number', [{ ...good(), at: 1 }]],
      ['a row with no seq', [{ ...good(), seq: undefined }]],
      ['a row with a fractional seq', [{ ...good(), seq: 1.5 }]],
      ['a row with a seq that is a string', [{ ...good(), seq: '1' }]],
      ['a row with no passage', [{ ...good(), passage: undefined }]],
      ['a row with a passage that is null', [{ ...good(), passage: null }]],
      ['a row with a passage that is a string', [{ ...good(), passage: 'q' }]],
      ['a row with no quote', [{ ...good(), passage: { ...good().passage, quote: undefined } }]],
      ['a row with a quote that is a number', [{ ...good(), passage: { ...good().passage, quote: 1 } }]],
      ['a row with no prefix', [{ ...good(), passage: { ...good().passage, prefix: undefined } }]],
      ['a row with no suffix', [{ ...good(), passage: { ...good().passage, suffix: undefined } }]],
      ['a row with no chapter', [{ ...good(), passage: { ...good().passage, chapter: undefined } }]],
    ]
    for (const [what, publications] of noList) {
      it(`throws on ${what}`, async () => {
        const fs = fsWith({ [sharedPathIn(BOOK)]: JSON.stringify({ publications, sealed: [] }) })
        await expect(readShared(fs, BOOK)).rejects.toThrow(/publication list/u)
      })
    }

    const boundary = () => ({ device: 'd', from: 1, to: 2 })
    const noBounds: readonly (readonly [string, unknown])[] = [
      ['no boundaries at all', undefined],
      ['boundaries that are a string', 'sealed'],
      ['boundaries that are an object', {}],
      ['a boundary that is null', [null]],
      ['a boundary that is a string', ['d']],
      ['a boundary that is an array', [[]]],
      ['a boundary with no device', [{ ...boundary(), device: undefined }]],
      ['a boundary with a device that is a number', [{ ...boundary(), device: 1 }]],
      ['a boundary with no from', [{ ...boundary(), from: undefined }]],
      ['a boundary with a fractional from', [{ ...boundary(), from: 1.5 }]],
      ['a boundary with a from that is a string', [{ ...boundary(), from: '1' }]],
      ['a boundary with no to', [{ ...boundary(), to: undefined }]],
      ['a boundary with a fractional to', [{ ...boundary(), to: 2.5 }]],
      ['a boundary with a to that is a string', [{ ...boundary(), to: '2' }]],
    ]
    it('refuses a list where only SOME boundaries are boundaries', async () => {
      /* ⚠️ **WITH ONE-ELEMENT FIXTURES `every` AND `some` ARE THE SAME
         FUNCTION**, so the difference between "all of these are valid" and "at
         least one is" went untested — and `some` accepts a file whose other
         boundaries are anything at all. */
      const sealed = [{ device: 'd', from: 1, to: 2 }, null]
      const fs = fsWith({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed }) })
      await expect(readShared(fs, BOOK)).rejects.toThrow(/page boundaries/u)
    })

    it('refuses a list where only SOME rows are publications', async () => {
      const publications = [good(), null]
      const fs = fsWith({ [sharedPathIn(BOOK)]: JSON.stringify({ publications, sealed: [] }) })
      await expect(readShared(fs, BOOK)).rejects.toThrow(/publication list/u)
    })

    for (const [what, sealed] of noBounds) {
      it(`throws on ${what}`, async () => {
        /* ⚠️ Reading these as "none sealed yet" re-paginates from the start,
           which changes the bytes of pages every recipient already holds and
           breaks their chains permanently. */
        const fs = fsWith({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed }) })
        await expect(readShared(fs, BOOK)).rejects.toThrow(/page boundaries/u)
      })
    }
  })
})
