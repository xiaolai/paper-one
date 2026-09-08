import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import { MAX_CLAIM_DIGESTS, SHELF_WORK, WIRE_VERSION, canonicalJson, makeHlc, type Entry, type Hlc, type Passage, type WorkClaim } from '../../../kernel'
import { pageCrypto } from './crypto'
import { delegationBytes, takePages, type Ledger, type SignedDelegation } from './receive'
import {
  DEFAULT_BOUNDS,
  envelopeOf,
  isSealedPage,
  logOf,
  nextSeqFor,
  NOTHING_PUBLISHED,
  pagesFor,
  readShared,
  share,
  unshare,
  updateShared,
  wireBytesOf,
  type Publisher,
  type SharedFile,
  boundariesInOrder,
  MAX_BOUNDARY_SPAN,
  MAX_TAGS,
  boundedAnswer,
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
const WORK: WorkClaim = { ids: ['1a'.repeat(32)], titles: ['2b'.repeat(32)], author: '3c'.repeat(32), language: 'en' }

function keypair(seed: string) {
  const secret = utf8ToBytes(seed.padEnd(32, '.')).slice(0, 32)
  return { secret, id: bytesToHex(getPublicKey(secret)) }
}
const PERSON = keypair('person')
const DEVICE = keypair('device')
const PHONE = keypair('phone')

const stamp = (n: number, device: string): Hlc => makeHlc(NOW + n, 0, device.slice(0, 16))

/** The publication an entry names, or null for a register — which names none. */
const pubOf = (one: Entry): string | null => ('pub' in one ? one.pub : null)

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
    held = unshare(held, 'a', DEVICE.id, stamp(3, DEVICE.id))

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
    held = unshare(held, 'pub1', DEVICE.id, stamp(3, DEVICE.id))
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
    const held = unshare(twoShares(), 'pub1', DEVICE.id, stamp(3, DEVICE.id))
    expect(held.publications).toHaveLength(2)
    expect(held.publications[0]?.passage.quote).toBe('first')
  })

  it('does not withdraw the same publication twice', () => {
    const once = unshare(twoShares(), 'pub1', DEVICE.id, stamp(3, DEVICE.id))
    const twice = unshare(once, 'pub1', DEVICE.id, stamp(9, DEVICE.id))
    expect(twice.publications[0]?.unshared?.seq).toBe(3)
  })

  it('never puts a passage on a withdrawal', () => {
    /* ⚠️ **A TOMBSTONE THAT REPEATED THE QUOTE WOULD DISCLOSE THE WITHDRAWN
       PASSAGE** to a peer who never saw the share — a retraction that publishes
       the thing being retracted. The type enforces it; this checks the value. */
    const held = unshare(twoShares(), 'pub1', DEVICE.id, stamp(3, DEVICE.id))
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

    expect(logOf(held).map(pubOf)).toEqual(['pub1', 'pub2'])
  })

  it('puts a withdrawal after the share it withdraws', () => {
    const held = unshare(twoShares(), 'pub1', DEVICE.id, stamp(9, DEVICE.id))
    const log = logOf(held)
    const shared = log.findIndex((one) => pubOf(one) === 'pub1' && one.op === 'share')
    const gone = log.findIndex((one) => pubOf(one) === 'pub1' && one.op === 'unshare')
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
    held = unshare(held, 'pub1', DEVICE.id, stamp(3, DEVICE.id))
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
    const held = { ...twoShares(), sealed: [{ device: PHONE.id, from: 1, to: 5, v: WIRE_VERSION }] }
    const built = await pagesFor(held, publisher(), {}, pageCrypto.hash)

    /* This device sealed its own pages, and the phone's boundary was left
       alone rather than consumed as though it were this device's. */
    const mine = built.held.sealed.filter((one) => one.device === DEVICE.id)
    expect(mine).toMatchObject([{ device: DEVICE.id, from: 1, to: 2, v: WIRE_VERSION }])
    expect(built.pages).toHaveLength(1)
    const first = JSON.parse(built.pages[0] as string) as { from: number; to: number }
    expect(first).toMatchObject({ from: 1, to: 2, v: WIRE_VERSION })
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
      expect.objectContaining({ from: 1, to: 1, v: WIRE_VERSION }),
      expect.objectContaining({ from: 2, to: 2, v: WIRE_VERSION }),
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
      sealed: [{ device: DEVICE.id, from: 1, to: 3, v: WIRE_VERSION }],
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
    const held = unshare(twoShares(), 'pub1', DEVICE.id, stamp(3, DEVICE.id))
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

describe('a request that is already caught up', () => {
  it('signs NOTHING to say there is nothing new', async () => {
    /* ⚠️ **IT SIGNED THE WHOLE CHAIN TO ANSWER AN EMPTY REQUEST.** The walk
       starts at the first page because `prevPageHash` links every page a device
       ever emitted — right when a page is going out, and there is none here. A
       reader polling every five minutes re-signed their entire history each
       time: one key operation per sealed page, per poll, for ever. */
    let held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('one'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    held = share(held, { markId: 'm2', passage: passage('two'), device: DEVICE.id }, 'p2', stamp(2, DEVICE.id)).held
    const sealed = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    expect(sealed.pages.length).toBeGreaterThan(0)

    const signer = publisher()
    const signs = vi.spyOn(signer, 'sign')
    const caught = await pagesFor(sealed.held, signer, { [DEVICE.id]: 99 }, pageCrypto.hash)
    expect(caught.pages).toEqual([])
    expect(signs).not.toHaveBeenCalled()
    /* ⚠️ **AND IT CARRIES THE SEALED LIST BACK.** The short-circuit returns
       early, and returning `sealed: []` from it would erase every boundary the
       store holds on the next write — the whole chain, on a poll that answered
       nothing. Nothing read the field. */
    expect(caught.held.sealed).toEqual(sealed.held.sealed)
  })

  it('asks from EXACTLY the last sequence sealed and is still told nothing', async () => {
    /* ⚠️ **`> wanted`, NOT `>= wanted`, AND ONLY A CURSOR AT THE EDGE SAYS SO.**
       The test above asks from 99, far past everything, where the two agree. A
       reader whose cursor is exactly the last `to` has already been served that
       page: answering it again re-signs the chain to re-send bytes they hold. */
    let held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('one'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    held = share(held, { markId: 'm2', passage: passage('two'), device: DEVICE.id }, 'p2', stamp(2, DEVICE.id)).held
    const sealed = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    const last = Math.max(...sealed.held.sealed.map((one) => one.to))

    const signer = publisher()
    const signs = vi.spyOn(signer, 'sign')
    const atEdge = await pagesFor(sealed.held, signer, { [DEVICE.id]: last }, pageCrypto.hash)
    expect(atEdge.pages).toEqual([])
    expect(signs).not.toHaveBeenCalled()
    /* And one before it IS served, so the edge is the edge and not a refusal
       of everything. */
    const before = await pagesFor(sealed.held, publisher(), { [DEVICE.id]: last - 1 }, pageCrypto.hash)
    expect(before.pages.length).toBeGreaterThan(0)
  })
})

describe('a boundary the reader would refuse for its SPAN', () => {
  it('is cut before the span reaches the limit', async () => {
    /* ⚠️ **THE WRITER BOUNDED SIZE AND COUNT AND NOT THE RANGE.**
       `isSealedPage` refuses a boundary whose `to - from` reaches
       `MAX_BOUNDARY_SPAN` — and a page's entries need not be contiguous, since
       filtering out another chain's leaves the survivors sparse. Two entries a
       million sequences apart therefore sealed a boundary this build's own
       reader rejects, and the store then failed its next read. */
    let held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('near'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    /* A second publication far past the span, as a sparse log produces. */
    const far = held.publications[0]!.seq + MAX_BOUNDARY_SPAN + 5
    held = { ...held, publications: [...held.publications, { ...held.publications[0]!, markId: 'm2', pub: 'p2', seq: far }] }

    const out = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    for (const boundary of out.held.sealed) {
      expect(boundary.to - boundary.from).toBeLessThan(MAX_BOUNDARY_SPAN)
      /* And every sealed boundary is one this build would read back. */
      expect(isSealedPage(boundary)).toBe(true)
    }
    /* ⚠️ **AND NOTHING WAS LOST IN THE CUTTING.** A splitter that dropped the
       run it had just closed would satisfy every assertion above — the
       boundaries it did keep are all within the span — and silently never
       serve one of the two publications. */
    expect(out.held.sealed.flatMap((one) => [one.from, one.to])).toContain(far)
  })

  it('cuts at EXACTLY the span, because that is the value the reader refuses', async () => {
    /* ⚠️ **THE LIMIT IS `>=`, AND ONLY A FIXTURE AT THE LIMIT SAYS SO.** The
       test above sits five past it, where `>` and `>=` agree. `isSealedPage`
       refuses a boundary whose `to - from` REACHES `MAX_BOUNDARY_SPAN`, so a
       pair exactly that far apart must be two boundaries — one apart, one
       boundary. */
    const atSpan = async (gap: number) => {
      let held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('near'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
      const far = held.publications[0]!.seq + gap
      held = { ...held, publications: [...held.publications, { ...held.publications[0]!, markId: 'm2', pub: 'p2', seq: far }] }
      const out = await pagesFor(held, publisher(), {}, pageCrypto.hash)
      for (const boundary of out.held.sealed) expect(isSealedPage(boundary), `gap ${gap}`).toBe(true)
      return out.held.sealed.length
    }
    expect(await atSpan(MAX_BOUNDARY_SPAN)).toBe(2)
    expect(await atSpan(MAX_BOUNDARY_SPAN - 1)).toBe(1)
  })
})

describe('a sealed page that lost an entry', () => {
  it('is refused rather than re-sent as a different page', async () => {
    /* ⚠️ **THE REBUILD WOULD HAVE SUCCEEDED AND BROKEN EVERY CHAIN.** A store
       that loses an entry inside a sealed page — a hand-edited file, a future
       migration dropping a row — rebuilds `[1,2,3]` as `[1,3]`, and that page
       PASSES `checkPage`, because gaps are legal: version filtering makes
       legitimate ones. So it goes out signed and canonical with different
       contents, a different hash, and a different `prevPageHash` for every
       page after it. Every recipient's chain broken, from a store that read
       cleanly. */
    let held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('one'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    held = share(held, { markId: 'm2', passage: passage('two'), device: DEVICE.id }, 'p2', stamp(2, DEVICE.id)).held
    held = share(held, { markId: 'm3', passage: passage('three'), device: DEVICE.id }, 'p3', stamp(3, DEVICE.id)).held
    const sealed = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    expect(sealed.held.sealed[0]).toMatchObject({ entries: 3 })

    /* The middle publication vanishes from the store, its boundary untouched. */
    const lost: SharedFile = { ...sealed.held, publications: sealed.held.publications.filter((row) => row.pub !== 'p2') }
    await expect(pagesFor(lost, publisher(), {}, pageCrypto.hash)).rejects.toThrow(/refusing to re-send it as a different page/u)
  })

  it('serves a boundary sealed before the count was recorded, as it always did', async () => {
    /* The count is absent on older stores; they cannot be checked and must not
       be refused for it. */
    const held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('x'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    const legacyBoundary: SharedFile = { ...held, sealed: [{ device: DEVICE.id, from: 1, to: 1, v: WIRE_VERSION }] }
    await expect(pagesFor(legacyBoundary, publisher(), {}, pageCrypto.hash)).resolves.toBeDefined()
  })
})

describe('a legacy boundary is pinned the first time it is served', () => {
  it('reproduces the same bytes after the roster changes', async () => {
    /* ⚠️ **IT REBUILT FROM LIVE STATE EVERY TIME.** A boundary sealed before
       roster, revocations and claim were recorded falls back to the
       publisher's CURRENT values — so pairing a new device, or revoking one,
       changed the bytes of pages already sent. Every recipient holding the old
       page then refuses the next one with `chain`, for ever, with nothing
       anywhere saying why.

       The fallback is what makes an old store readable at all. What was
       missing is that the values it picks are written down, so the SECOND
       serve cannot differ from the first. */
    const held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('x'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    /* A boundary as an older build wrote one: no roster, no revocations, no work. */
    const legacy: SharedFile = { ...held, sealed: [{ device: DEVICE.id, from: 1, to: 1, v: WIRE_VERSION }] }

    const first = await pagesFor(legacy, publisher(), {}, pageCrypto.hash)
    /* Served once, the boundary now carries what it was rendered with. */
    const laterRoster = { ...publisher(), roster: [...publisher().roster, 'ff'.repeat(32)], revocations: 3 }
    const second = await pagesFor(first.held, laterRoster, {}, pageCrypto.hash)
    expect(second.pages[0]).toBe(first.pages[0])
  })

  it('writes down each of the three fields, and pins a boundary missing only ONE of them', async () => {
    /* ⚠️ **ONE FIXTURE MISSING ALL THREE CANNOT TELL THE GUARD'S CLAUSES
       APART.** `roster !== undefined && revocations !== undefined && work
       !== undefined` decides whether a boundary needs pinning; with only an
       all-or-nothing fixture, any one of the three could be dropped from the
       guard and a boundary missing just that field would be served unpinned —
       for ever, because the pin is what stops the next serve differing. And
       nothing read the pinned VALUES, so the claim could be written down with
       its ids or its titles emptied. */
    const held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('x'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    const mine = publisher()
    const whole = { device: DEVICE.id, from: 1, to: 1, v: WIRE_VERSION, roster: [...mine.roster], revocations: mine.revocations, work: mine.work }

    for (const missing of ['roster', 'revocations', 'work'] as const) {
      const { [missing]: _gone, ...partial } = whole
      const legacy: SharedFile = { ...held, sealed: [partial as SharedFile['sealed'][number]] }
      const first = await pagesFor(legacy, mine, {}, pageCrypto.hash)
      const pinned = first.held.sealed[0]!
      expect(pinned.roster, missing).toEqual(mine.roster)
      expect(pinned.revocations, missing).toBe(mine.revocations)
      /* The claim in full — a pinned boundary with an empty `ids` names a
         different work, and every page rebuilt from it addresses nothing. */
      expect(pinned.work, missing).toEqual(mine.work)
      expect(pinned.work?.ids, missing).toEqual(mine.work.ids)
      expect(pinned.work?.titles, missing).toEqual(mine.work.titles)

      /* And it reproduces after the publisher moves, which is the point. */
      const later = { ...mine, roster: [...mine.roster, 'ff'.repeat(32)], revocations: mine.revocations + 3 }
      const second = await pagesFor(first.held, later, {}, pageCrypto.hash)
      expect(second.pages[0], missing).toBe(first.pages[0])
    }
  })
})

describe('an entry too big for a page', () => {
  it('is refused loudly rather than sealed into a page nobody can receive', async () => {
    /* ⚠️ **IT WAS SEALED ANYWAY, AND STOPPED THE STREAM FOR EVER.** `paginate`
       emits an oversized entry ALONE rather than dropping it — right, since
       dropping loses a publication silently — but nothing checked the result,
       so the page went out over `MAX_PAGE_CHARS`, every recipient refused it,
       and because pages are a chain every LATER page stayed stuck behind it.
       Measured by the audit: a 524 289-character quote made a 525 161-character
       page against a 524 288 limit.

       The recovery is in the message, because a person reading it is the only
       one who can take that publication back. */
    const huge = passage('x'.repeat(MAX_PAGE_CHARS))
    const held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: huge, device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    await expect(pagesFor(held, publisher(), {}, pageCrypto.hash)).rejects.toThrow(/it cannot be sent, and it blocks every later page/u)
  })

  it('takes an entry of EXACTLY the wire limit and refuses one character more', async () => {
    /* ⚠️ **THE REFUSAL IS `>`, AND A HALF-MEGABYTE FIXTURE CANNOT SAY SO.** The
       test above is far past the limit, where `>` and `>=` agree — so the bound
       could have been loosened by one and turned the largest sendable entry
       into an error nobody could act on. The two numbers come from the refusal
       itself rather than being written down here, because both move with the
       envelope. */
    const sealing = async (quote: number) => {
      const one = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('x'.repeat(quote)), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
      return pagesFor(one, publisher(), {}, pageCrypto.hash)
    }
    const refusal = await sealing(MAX_PAGE_CHARS).then(
      () => null,
      (cause: unknown) => (cause as Error).message,
    )
    const measured = /is (\d+) characters and a page holds (\d+)/u.exec(refusal ?? '')
    expect(measured, refusal ?? 'it was not refused at all').not.toBeNull()
    const [size, limit] = [Number(measured![1]), Number(measured![2])]
    /* Every character of the quote is one character of the entry, so the rest
       of the entry is a constant this arithmetic can lean on. */
    const overhead = size - MAX_PAGE_CHARS

    await expect(sealing(limit - overhead)).resolves.toMatchObject({ pages: expect.any(Array) })
    await expect(sealing(limit - overhead + 1)).rejects.toThrow(/it cannot be sent/u)
  })

  it('measures the page in CHARACTERS, so a Chinese passage that fits is sent', async () => {
    /* ⚠️ **THE LIMIT WAS COMPARED AGAINST A BYTE COUNT.** `wireLimit` is
       `MAX_PAGE_CHARS` less the envelope, and `checkPage` measures a page as
       `received.length` — characters. The guard summed `wireBytesOf`, the UTF-8
       bytes of the page's JSON-escaped self, which is about 2.8× that for CJK
       text. A passage well inside the limit was therefore refused as unsendable
       and its reader told to withdraw it. Every fixture was ASCII, where the
       two are within a rounding error of each other. */
    const held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('海'.repeat(Math.floor(MAX_PAGE_CHARS / 3))), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    const out = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    expect(out.pages).toHaveLength(1)
    /* And it is a page this build's own reader would take. */
    expect(out.pages[0]!.length).toBeLessThanOrEqual(MAX_PAGE_CHARS)
  })
})

describe('a publication id is an identity', () => {
  it('refuses a second publication carrying an id the book already has', () => {
    /* ⚠️ **NOTHING ENFORCED THIS, AND `unshare` PAID FOR IT.** Two rows sharing
       a `pub` were each withdrawn at `nextSeqFor` against the SAME unchanged
       store, so both took the same sequence — and the file that resulted fails
       its own next read. A publication that cannot be withdrawn without
       breaking the store it lives in. */
    const once = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('x'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    expect(() => share(once, { markId: 'm2', passage: passage('y'), device: DEVICE.id }, 'p1', stamp(2, DEVICE.id))).toThrow(/already has a publication called p1/u)
  })

  it('withdraws the row NAMED, not the first one it comes to', () => {
    /* ⚠️ **EVERY FIXTURE WITHDREW THE FIRST PUBLICATION.** With `pub1` always
       the target, "the first row whose id matches" and "the first row at all"
       are the same row — so the id check could be deleted and the wrong
       passage would be taken back with nothing noticing. */
    const held = unshare(twoShares(), 'pub2', DEVICE.id, stamp(3, DEVICE.id))
    expect(held.publications.find((one) => one.pub === 'pub1')?.unshared).toBeUndefined()
    expect(held.publications.find((one) => one.pub === 'pub2')?.unshared).toMatchObject({ seq: 3, device: DEVICE.id })
  })

  it('withdraws ONE row even in a store that already holds a duplicate', () => {
    /* A file written before the check above must still be repairable: two
       withdrawals at one sequence is what made it unreadable, so a store in
       that state is mended a row at a time rather than by writing another
       file nothing can load. */
    const one = share(NOTHING_PUBLISHED, { markId: 'm1', passage: passage('x'), device: DEVICE.id }, 'p1', stamp(1, DEVICE.id)).held
    const doubled: SharedFile = { ...one, publications: [...one.publications, { ...one.publications[0]!, markId: 'm2' }] }
    const after = unshare(doubled, 'p1', DEVICE.id, stamp(3, DEVICE.id))
    expect(after.publications.filter((row) => row.unshared)).toHaveLength(1)
  })
})

describe('a publication is a snapshot, not a view of the caller’s object', () => {
  it('does not change when the passage it was made from is edited afterwards', async () => {
    /* ⚠️ **THE CALLER'S OBJECT WAS STORED AS-IS.** Editing the mark afterwards
       edited the PUBLICATION — a signed record of what was shared, changing
       under a reader who had already shared it. `readonly` stops a write
       through THIS reference and nothing through the caller's, which holds the
       same object. */
    const passage = { quote: 'as published', prefix: '', suffix: '', chapter: 'One' }
    const { publication } = share(NOTHING_PUBLISHED, { markId: 'm1', passage, device: DEVICE.id }, 'p1', stamp(1, DEVICE.id))
    passage.quote = 'edited afterwards'
    expect(publication.passage.quote).toBe('as published')
  })
})

describe('reading and writing the publisher’s store', () => {
  it('round-trips what it wrote, boundaries and all', async () => {
    /* ⚠️ **WITH AN EMPTY `sealed` THE ROW CHECK IS NEVER RUN** — `[].every()`
       is vacuously true — so every clause of `isSealed` went unexercised while
       this test looked like a round trip. A store that round-trips only its
       empty case is not one. */
    const fs = fsWith()
    const held = { ...twoShares(), sealed: [{ device: DEVICE.id, from: 1, to: 2, v: WIRE_VERSION }] }
    await updateShared(fs, queueOf(), LANE, BOOK, () => held)
    expect(await readShared(fs, BOOK)).toEqual(held)
  })

  it('reads nothing published for a book nobody has shared from', async () => {
    expect(await readShared(fsWith(), BOOK)).toEqual(NOTHING_PUBLISHED)
  })

  describe('a boundary that froze a delegation nothing can read', () => {
    /* ⚠️ **THE HALF OF THE `sig` RENAME THAT IS NOT IN RUST.** `person.rs`
       spelled a delegation's signature `signature` until 2026-09-07 and
       `receive.ts` demands `sig`, so every page from a Rust-signing device was
       refused. Renaming the field fixes what is minted today and CANNOT reach a
       page already sealed — a boundary keeps the delegation as first served, on
       purpose — so a reader who shared before upgrading would keep a
       publication no friend can ever read, silently and for ever.

       Rebuilding is safe for exactly these: a page whose delegation cannot be
       parsed is refused before its signature is checked, so no peer ever held
       one, so no chain can break. That is why the drop is narrow. */
    const boundary = (delegation: unknown) => ({
      device: DEVICE.id,
      from: 1,
      to: 2,
      v: WIRE_VERSION,
      ...(delegation === undefined ? {} : { delegation }),
    })
    const readBack = async (delegation: unknown) => {
      const fs = fsWith({
        [sharedPathIn(BOOK)]: JSON.stringify({ ...NOTHING_PUBLISHED, sealed: [boundary(delegation)] }),
      })
      const held = await readShared(fs, BOOK)
      return held.sealed[0] as unknown as Record<string, unknown>
    }
    const live = JSON.stringify({
      device: DEVICE.id,
      notAfter: 2,
      notBefore: 1,
      person: PERSON.id,
      roster: 0,
      sig: 'a'.repeat(128),
    })

    it('drops the delegation so the page rebuilds with the one this device holds now', async () => {
      /* `pageOver` reads `boundary.delegation ?? publisher.delegation`, so an
         absent one takes the path a boundary sealed before the field existed
         already took. Dropped rather than corrected: there is nothing here to
         correct it to. */
      const dead = JSON.stringify({
        device: DEVICE.id,
        notAfter: 2,
        notBefore: 1,
        person: PERSON.id,
        roster: 0,
        signature: 'a'.repeat(128),
      })
      expect(await readBack(dead)).not.toHaveProperty('delegation')
    })

    it('keeps a delegation that names `sig`, so a live boundary still reproduces byte for byte', async () => {
      /* The other half, and the one that matters more: this must NOT rebuild
         pages a peer already holds. A migration that dropped every delegation
         would break every chain in the circle. */
      expect(await readBack(live)).toHaveProperty('delegation', live)
    })

    it.each([
      ['bytes that are not JSON', 'not json'],
      ['a delegation that is not an object', JSON.stringify('delegation')],
      ['a delegation that is a list', JSON.stringify([])],
      /* ⚠️ `null` is the one shape that cannot simply fall through to the
         member read: `null['sig']` throws rather than answering `undefined`. */
      ['a delegation that is null', JSON.stringify(null)],
      ['a delegation that is a number', JSON.stringify(7)],
      ['a sig that is not a string', JSON.stringify({ sig: 7 })],
    ])('drops %s, which is unreadable by the same argument', async (_name, value) => {
      expect(await readBack(value)).not.toHaveProperty('delegation')
    })

    it('leaves a NON-STRING to the store parser, which refuses it', async () => {
      /* A legacy spelling is a migration; a broken type is a defect. The first
         version of this dropped both and so repaired a malformed store into a
         valid one — see `unreadableDelegation`. The refusal itself is pinned by
         "refuses a delegation that is an object" below. */
      await expect(readBack({})).rejects.toThrow(/page boundaries/u)
    })

    it('leaves a boundary that never had one alone', async () => {
      expect(await readBack(undefined)).not.toHaveProperty('delegation')
    })
  })

  it('writes on the book’s own lane, never one derived here', async () => {
    /* ⚠️ `folderOf` is MANY-TO-ONE, so a lane keyed on the raw id splits one
       directory across two lanes — and a rekeyed book has to stay on the lane
       its earlier writes are still draining on. */
    const keys: string[] = []
    await updateShared(fsWith(), queueOf(keys), LANE, BOOK, () => twoShares())
    expect(keys).toEqual([LANE(BOOK)])
  })

  it('writes to the path beside marks.json, not inside circle/', async () => {
    /* ⚠️ **`peopleFor` LISTS `circle/` AND READS EVERY `*.json` AS A PERSON.**
       A publisher's file there would appear in the reader's own circle as
       somebody called `published`, and could not be removed because they do
       not exist. */
    const fs = fsWith()
    await updateShared(fs, queueOf(), LANE, BOOK, () => twoShares())
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
      /* A REAL stamp: with an unreadable one every row below was refused for the stamp, and the clause each row exists for went untested. */
      at: stamp(1, DEVICE.id),
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

    const boundary = () => ({ device: 'd', from: 1, to: 2, v: 2 })
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
      /* WI-23.B2: a boundary names its chain, or it is a boundary for no chain
         — save one written before the field existed, which is a v1 boundary
         and is read as one; see the describe below. */
      ['a boundary with a fractional chain version', [{ ...boundary(), v: 1.5 }]],
      ['a boundary with a chain version that is a string', [{ ...boundary(), v: '2' }]],
    ]
    it('refuses a list where only SOME boundaries are boundaries', async () => {
      /* ⚠️ **WITH ONE-ELEMENT FIXTURES `every` AND `some` ARE THE SAME
         FUNCTION**, so the difference between "all of these are valid" and "at
         least one is" went untested — and `some` accepts a file whose other
         boundaries are anything at all. */
      const sealed = [{ device: 'd', from: 1, to: 2, v: 2 }, null]
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

describe('the book-level rows the store keeps — WI-23.B2', () => {
  const rated = (): SharedFile => ({
    ...twoShares(),
    opinions: [{ op: 'rate', stars: 4, device: DEVICE.id, seq: 3, at: stamp(3, DEVICE.id) }],
    reviews: [{ pub: 'rev1', device: DEVICE.id, seq: 4, at: stamp(4, DEVICE.id), text: 'a whale of a book' }],
  })

  it('emits them as entries of the same stream, in stamp order', () => {
    const log = logOf(rated())
    expect(log.map((one) => one.op)).toEqual(['share', 'share', 'rate', 'review'])
    expect(log.find((one) => one.op === 'rate')).toMatchObject({ stars: 4, seq: 3 })
    expect(log.find((one) => one.op === 'review')).toMatchObject({ pub: 'rev1', text: 'a whale of a book', seq: 4 })
  })

  it('emits a withdrawn review as review then unreview, and the tombstone carries no text', () => {
    const held: SharedFile = {
      ...rated(),
      reviews: [{ ...rated().reviews[0]!, unreviewed: { seq: 5, at: stamp(5, DEVICE.id) } }],
    }
    const log = logOf(held)
    expect(log.map((one) => one.op)).toEqual(['share', 'share', 'rate', 'review', 'unreview'])
    const gone = log.find((one) => one.op === 'unreview')!
    expect(Object.hasOwn(gone, 'text')).toBe(false)
  })

  it('counts their sequence numbers, so a share cannot be minted at a number a rating holds', () => {
    /* ⚠️ Two entries at one `(device, seq)` is the collision the per-device
       key exists to make impossible — and the book-level rows are entries. */
    expect(nextSeqFor(rated(), DEVICE.id)).toBe(5)
    const withdrawn: SharedFile = {
      ...rated(),
      reviews: [{ ...rated().reviews[0]!, unreviewed: { seq: 9, at: stamp(9, DEVICE.id) } }],
    }
    expect(nextSeqFor(withdrawn, DEVICE.id)).toBe(10)
    expect(nextSeqFor(rated(), PHONE.id)).toBe(1)

    /* ⚠️ **A WITHDRAWAL BELONGS TO THE STREAM IT WAS STAMPED IN, NOT THE ROW'S** —
       for a PUBLICATION as well as a review. The laptop takes back what the
       phone published, in the laptop's stream, and the phone's next sequence
       must not be pushed past it. */
    const shared = twoShares()
    const crossed: SharedFile = {
      ...shared,
      publications: [{ ...shared.publications[0]!, device: PHONE.id, seq: 1, at: stamp(1, PHONE.id), unshared: { seq: 60, at: stamp(60, DEVICE.id), device: DEVICE.id } }],
    }
    expect(nextSeqFor(crossed, PHONE.id)).toBe(2)
    expect(nextSeqFor(crossed, DEVICE.id)).toBe(61)

    /* ⚠️ **A WITHDRAWAL BELONGS TO THE STREAM IT WAS STAMPED IN, NOT THE ROW'S.**
       The laptop takes back what the phone published, in the LAPTOP's stream —
       so the phone's next sequence must not be pushed past it. Every fixture
       here withdrew in the same stream as the row, so `withdrawnBy(...) ===
       device` could be replaced by `true` and no count moved. */
    const acrossDevices: SharedFile = {
      ...rated(),
      reviews: [{ ...rated().reviews[0]!, device: PHONE.id, seq: 1, at: stamp(1, PHONE.id), unreviewed: { seq: 40, at: stamp(40, DEVICE.id), device: DEVICE.id } }],
    }
    /* The laptop's own rows still cap it at 5; the phone's is capped by its
       own row, not by the laptop's withdrawal at 40. */
    expect(nextSeqFor(acrossDevices, PHONE.id)).toBe(2)
    expect(nextSeqFor(acrossDevices, DEVICE.id)).toBe(41)
  })

  it('refuses a publish switch that is not a boolean, null included', async () => {
    for (const publishOpinion of [null, 'yes', 1]) {
      const fs = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed: [], publishOpinion }) }) as unknown as VaultFs
      await expect(readShared(fs, BOOK)).rejects.toThrow(/publish switch/u)
    }
    const on = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed: [], publishOpinion: true }) }) as unknown as VaultFs
    expect((await readShared(on, BOOK)).publishOpinion).toBe(true)
  })

  it('round-trips through the file, and reads a file written before the rows existed as holding none', async () => {
    const fs = fakeFs({}) as unknown as VaultFs
    await updateShared(fs, queueOf(), LANE, BOOK, () => rated())
    expect(await readShared(fs, BOOK)).toEqual(rated())

    const older = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed: [] }) }) as unknown as VaultFs
    expect(await readShared(older, BOOK)).toEqual(NOTHING_PUBLISHED)
  })

  describe('every clause of the row shapes', () => {
    /* One row per clause, each bad in exactly one way. */
    const opinion = () => ({ op: 'rate', stars: 4, device: DEVICE.id, seq: 3, at: stamp(3, DEVICE.id) })
    const review = () => ({ pub: 'rev1', device: DEVICE.id, seq: 4, at: stamp(4, DEVICE.id), text: 'x' })
    const badOpinions: readonly (readonly [string, unknown])[] = [
      ['opinions that are a string', 'opinions'],
      ['opinions that are null', null],
      ['an opinion that is null', [null]],
      ['an opinion that is an array', [[]]],
      ['an opinion with no device', [{ ...opinion(), device: undefined }]],
      ['an opinion with a fractional seq', [{ ...opinion(), seq: 1.5 }]],
      ['an opinion with no stamp', [{ ...opinion(), at: undefined }]],
      ['an opinion of an op this build does not know', [{ ...opinion(), op: 'love' }]],
      ['an unknown op wearing a tag list', [{ op: 'love', tags: ['sea'], device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id) }]],
      ['a rating of six stars', [{ ...opinion(), stars: 6 }]],
      ['a rating that is a string', [{ ...opinion(), stars: '4' }]],
      ['a status this build does not know', [{ op: 'status', state: 'abandoned', device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id) }]],
      ['a status that is a number', [{ op: 'status', state: 1, device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id) }]],
      ['tags that are a string', [{ op: 'tag', tags: 'sea', device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id) }]],
      ['a tag that is a number', [{ op: 'tag', tags: [1], device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id) }]],
      /* One bad tag among good ones: `some` would let the list through. */
      ['a tag list where only SOME are tags', [{ op: 'tag', tags: ['sea', 1], device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id) }]],
      ['a list where only SOME are opinions', [opinion(), 'no']],
      /* EXACTLY the kind's fields, and the wire's bound on tags — a row is its entry. */
      ['an opinion carrying a field its kind does not name', [{ ...opinion(), extra: 1 }]],
      ['a tag list past the wire limit', [{ op: 'tag', tags: Array.from({ length: 257 }, (_, i) => `t${i}`), device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id) }]],
      ['an opinion with a zero seq', [{ ...opinion(), seq: 0 }]],
      ['an opinion whose stamp is not an HLC', [{ ...opinion(), at: 'yesterday' }]],
      ['an opinion with an empty device', [{ ...opinion(), device: '' }]],
    ]
    for (const [what, opinions] of badOpinions) {
      it(`refuses ${what}`, async () => {
        const fs = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed: [], opinions, reviews: [] }) }) as unknown as VaultFs
        await expect(readShared(fs, BOOK)).rejects.toThrow(/opinion list/u)
      })
    }
    const badReviews: readonly (readonly [string, unknown])[] = [
      ['reviews that are a string', 'reviews'],
      ['reviews that are null', null],
      ['a review that is null', [null]],
      ['a review with no pub', [{ ...review(), pub: undefined }]],
      ['a review with an empty pub', [{ ...review(), pub: '' }]],
      ['a review with no text', [{ ...review(), text: undefined }]],
      ['a review with no device', [{ ...review(), device: undefined }]],
      ['a review whose withdrawal is a string', [{ ...review(), unreviewed: 'gone' }]],
      ['a review whose withdrawal is null', [{ ...review(), unreviewed: null }]],
      ['a review whose withdrawal has a fractional seq', [{ ...review(), unreviewed: { seq: 1.5, at: stamp(1, DEVICE.id) } }]],
      ['a review whose withdrawal has no stamp', [{ ...review(), unreviewed: { seq: 5 } }]],
      ['a review whose withdrawal is not after it', [{ ...review(), seq: 5, unreviewed: { seq: 5, at: stamp(2, DEVICE.id) } }]],
      /* ⚠️ **AND THE SAME, WITH THE STREAM SAID OUT LOUD.** Every row above
         leaves the withdrawal's `device` off, which takes the branch that never
         looks at the row's own device — so the row's device could have been
         read from any key at all and nothing here moved. A withdrawal stamped
         in the row's OWN stream has to come after it. */
      ['a review withdrawn in its own stream at a sequence not after it', [{ ...review(), seq: 5, unreviewed: { seq: 5, at: stamp(5, DEVICE.id), device: DEVICE.id } }]],
      ['a review carrying a field it does not name', [{ ...review(), extra: 1 }]],
      ['a list where only SOME are reviews', [review(), 'no']],
    ]
    for (const [what, reviews] of badReviews) {
      it(`refuses ${what}`, async () => {
        const fs = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed: [], opinions: [], reviews }) }) as unknown as VaultFs
        await expect(readShared(fs, BOOK)).rejects.toThrow(/review list/u)
      })
    }
    it('reads a review withdrawn in ANOTHER stream at any sequence, which is the positive of the row above', async () => {
      /* The laptop takes back what the phone published: a different stream, so
         the sequences do not have to climb past each other. Without this the
         refusal above also passes for a checker that refuses every withdrawal
         carrying a device. */
      const reviews = [{ ...review(), seq: 5, unreviewed: { seq: 1, at: stamp(1, PHONE.id), device: PHONE.id } }]
      const fs = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed: [], opinions: [], reviews }) }) as unknown as VaultFs
      await expect(readShared(fs, BOOK)).resolves.toMatchObject({ reviews: [{ pub: 'rev1' }] })
    })

    it('reads every good shape, so none of the above is vacuous', async () => {
      const opinions = [
        opinion(),
        { op: 'status', state: 'reading', device: DEVICE.id, seq: 5, at: stamp(5, DEVICE.id) },
        { op: 'tag', tags: ['sea'], device: DEVICE.id, seq: 6, at: stamp(6, DEVICE.id) },
      ]
      const reviews = [review(), { ...review(), pub: 'rev2', seq: 7, unreviewed: { seq: 8, at: stamp(8, DEVICE.id) } }]
      const fs = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed: [], opinions, reviews }) }) as unknown as VaultFs
      const held = await readShared(fs, BOOK)
      expect(held.opinions).toHaveLength(3)
      expect(held.reviews).toHaveLength(2)
    })
  })

  it('serves a v1 page over the same range without the book-level entry — the inverse falsifier at the publisher', async () => {
    const held = rated()
    const v1 = await pagesFor(held, publisher(), {}, pageCrypto.hash, DEFAULT_BOUNDS, 1)
    const v2 = await pagesFor(held, publisher(), {}, pageCrypto.hash, DEFAULT_BOUNDS, 2)
    expect(v1.pages).toHaveLength(1)
    expect(v2.pages).toHaveLength(1)
    expect(v1.pages[0]).not.toBe(v2.pages[0])
    const ops = (raw: string) => (JSON.parse(raw) as { entries: { op: string }[] }).entries.map((one) => one.op)
    expect(ops(v1.pages[0]!)).toEqual(['share', 'share'])
    expect(ops(v2.pages[0]!)).toEqual(['share', 'share', 'rate', 'review'])
    /* Each chain seals its own boundary; neither consumed the other's. */
    expect(v1.held.sealed).toMatchObject([{ device: DEVICE.id, from: 1, to: 2, v: 1 }])
    expect(v2.held.sealed).toMatchObject([{ device: DEVICE.id, from: 1, to: 4, v: 2 }])
  })
})

describe('what a sealed page remembers — the roster it was signed with', () => {
  it('reproduces a page byte for byte after a device joins the roster, and links the next page to it', async () => {
    const held = twoShares()
    const first = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    expect(first.pages).toHaveLength(1)
    expect(first.held.sealed[0]).toMatchObject({ roster: [DEVICE.id, PHONE.id], revocations: 0, delegation: delegationFor(DEVICE.id) })
    /* A third device is paired: the roster grows and the delegation is re-minted. */
    const grown = publisher({ roster: [DEVICE.id, PHONE.id, 'c'.repeat(64)], revocations: 1 })
    const again = await pagesFor(first.held, grown, {}, pageCrypto.hash)
    expect(again.pages[0]).toBe(first.pages[0])
    /* And a page cut after the change carries the new roster, chained to the old bytes. */
    const more = share(first.held, { markId: 'm3', passage: passage('third'), device: DEVICE.id }, 'pub3', stamp(3, DEVICE.id)).held
    const next = await pagesFor(more, grown, { [DEVICE.id]: 2 }, pageCrypto.hash)
    expect(next.pages).toHaveLength(1)
    const page = JSON.parse(next.pages[0]!) as { roster: string[]; prevPageHash: string; revocations: number }
    expect(page.roster).toHaveLength(3)
    expect(page.revocations).toBe(1)
    expect(page.prevPageHash).toBe(pageCrypto.hash(first.pages[0]!))
  })

  it('rebuilds a boundary sealed before the roster was kept with the roster of today, as it always did', async () => {
    const held = twoShares()
    const first = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    const stripped = { ...first.held, sealed: first.held.sealed.map(({ roster: _r, revocations: _v, delegation: _d, ...rest }) => rest) }
    const again = await pagesFor(stripped, publisher(), {}, pageCrypto.hash)
    expect(again.pages[0]).toBe(first.pages[0])
  })
})

describe('the frame is measured, not assumed', () => {
  it('keeps every page under the frame cap however long the delegation is', async () => {
    let held = NOTHING_PUBLISHED
    for (let i = 0; i < 40; i++) {
      held = share(held, { markId: `m${i}`, passage: passage('x'.repeat(20_000)), device: DEVICE.id }, `pub${i}`, stamp(i + 1, DEVICE.id)).held
    }
    const heavy = publisher({ delegation: delegationFor(DEVICE.id) + ' '.repeat(100_000) })
    expect(envelopeOf(heavy, WIRE_VERSION)).toBeGreaterThan(100_000)
    const built = await pagesFor(held, heavy, {}, pageCrypto.hash, { maxPages: 64, budget: MAX_PAGE_CHARS - 2_048 })
    expect(built.pages.length).toBeGreaterThan(1)
    for (const page of built.pages) expect(page.length).toBeLessThanOrEqual(MAX_PAGE_CHARS)
  })
})

describe('every clause of a boundary and a publication on disk — one row each', () => {
  const boundary = () => ({ device: DEVICE.id, from: 1, to: 2, v: WIRE_VERSION })
  for (const [what, value, okay] of [
    ['a real boundary', boundary(), true],
    ['a boundary with its roster, revocations and delegation', { ...boundary(), roster: [DEVICE.id], revocations: 0, delegation: 'd' }, true],
    ['a first sequence of zero', { ...boundary(), from: 0 }, false],
    ['a range that runs backwards', { ...boundary(), from: 3, to: 2 }, false],
    ['a chain version of zero', { ...boundary(), v: 0 }, false],
    ['a roster with a number in it', { ...boundary(), roster: [1] }, false],
    ['a revocation count that is a float', { ...boundary(), revocations: 1.5 }, false],
    ['a delegation that is not a string', { ...boundary(), delegation: 7 }, false],
    ['a boundary that is a string', 'sealed', false],
  ] as const) {
    it(`${okay ? 'reads' : 'refuses'} ${what}`, () => {
      expect(isSealedPage(value)).toBe(okay)
    })
  }

  it('refuses a publication whose withdrawal or note will not read', async () => {
    const row = { pub: 'p', markId: 'm', device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id), passage: { quote: 'q', prefix: '', suffix: '', chapter: '' } }
    for (const bad of [
      { ...row, unshared: 'gone' },
      { ...row, unshared: { seq: 1.5, at: stamp(2, DEVICE.id) } },
      { ...row, unshared: { seq: 2 } },
      { ...row, unshared: [] },
      /* A withdrawal is AFTER the row it withdraws, on the same log. */
      { ...row, unshared: { seq: 1, at: stamp(2, DEVICE.id) } },
      { ...row, unshared: { seq: 2, at: stamp(2, DEVICE.id), extra: 1 } },
      { ...row, unshared: { seq: 2, at: 'yesterday' } },
      { ...row, at: 'yesterday' },
      { ...row, seq: 0 },
      { ...row, device: '' },
      { ...row, passage: { ...row.passage, note: { text: 'no' } } },
    ]) {
      const fs = fakeFs({ [sharedPathIn('book:x')]: JSON.stringify({ publications: [bad], sealed: [], opinions: [], reviews: [], publishOpinion: false }) }) as unknown as VaultFs
      await expect(readShared(fs, 'book:x')).rejects.toThrow(/publication list/u)
    }
    const good = fakeFs({ [sharedPathIn('book:x')]: JSON.stringify({ publications: [{ ...row, unshared: { seq: 2, at: stamp(2, DEVICE.id) }, passage: { ...row.passage, note: 'mine' } }], sealed: [], opinions: [], reviews: [], publishOpinion: false }) }) as unknown as VaultFs
    expect((await readShared(good, 'book:x')).publications[0]?.passage.note).toBe('mine')
  })
})

describe('changing the store as one step', () => {
  it('reads inside the lane, writes only what changed, and hands back what it wrote', async () => {
    const fs = fakeFs({}) as unknown as VaultFs
    const lanes: string[] = []
    const queue = { append: async (lane: string, job: () => Promise<void>) => { lanes.push(lane); await job() } } as never
    const first = await updateShared(fs, queue, (id) => `lane:${id}`, 'book:x', (held) => share(held, { markId: 'm', passage: passage('q'), device: DEVICE.id }, 'pub1', stamp(1, DEVICE.id)).held)
    expect(first.publications).toHaveLength(1)
    expect(lanes).toEqual(['lane:book:x'])
    expect(await readShared(fs, 'book:x')).toEqual(first)
    /* The same object back: nothing written. */
    const writes = (fs as unknown as { writes: (path: string) => number }).writes(sharedPathIn('book:x'))
    const same = await updateShared(fs, queue, (id) => `lane:${id}`, 'book:x', (held) => held)
    expect(same).toEqual(first)
    expect((fs as unknown as { writes: (path: string) => number }).writes(sharedPathIn('book:x'))).toBe(writes)
    /* And the transform sees what is on disk, not a snapshot taken before. */
    const second = await updateShared(fs, queue, (id) => `lane:${id}`, 'book:x', (held) => share(held, { markId: 'm2', passage: passage('r'), device: DEVICE.id }, 'pub2', stamp(2, DEVICE.id)).held)
    expect(second.publications.map((one) => one.pub)).toEqual(['pub1', 'pub2'])
  })
})

describe('the file, checked as the log it serves', () => {
  const opinion = () => ({ op: 'rate', stars: 4, device: DEVICE.id, seq: 3, at: stamp(3, DEVICE.id) })
  it('refuses a sequence held twice, whatever kinds hold it', async () => {
    const twice = { publications: [], sealed: [], opinions: [opinion(), { op: 'status', state: 'want', device: DEVICE.id, seq: opinion().seq, at: stamp(9, DEVICE.id) }], reviews: [] }
    const fs = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify(twice) }) as unknown as VaultFs
    await expect(readShared(fs, BOOK)).rejects.toThrow(/reuses a sequence/u)
  })

  it('refuses boundaries out of chain order, per device and version', async () => {
    const out = { publications: [], sealed: [{ device: DEVICE.id, from: 3, to: 4, v: 2 }, { device: DEVICE.id, from: 1, to: 2, v: 2 }], opinions: [], reviews: [] }
    const fs = fakeFs({ [sharedPathIn(BOOK)]: JSON.stringify(out) }) as unknown as VaultFs
    await expect(readShared(fs, BOOK)).rejects.toThrow(/out of order/u)
    /* Another version is another chain: its boundaries order on their own. */
    expect(boundariesInOrder([{ device: DEVICE.id, from: 1, to: 2, v: 2 }, { device: DEVICE.id, from: 1, to: 2, v: 3 }, { device: DEVICE.id, from: 3, to: 3, v: 2 }])).toBe(true)
    expect(boundariesInOrder([{ device: DEVICE.id, from: 1, to: 2, v: 2 }, { device: DEVICE.id, from: 2, to: 3, v: 2 }])).toBe(false)
  })

  it('rebuilds each opinion entry from its declared fields alone', () => {
    const held = { ...NOTHING_PUBLISHED, opinions: [{ ...opinion(), extra: 'not for the wire' } as never] }
    for (const entry of logOf(held)) expect(Object.keys(entry).sort()).toEqual(['at', 'device', 'op', 'seq', 'stars'].sort())
  })
})

describe('the answer as a whole', () => {
  it('stops before its pages outgrow the envelope, and says there is more', async () => {
    const unbounded = await pagesFor(twoShares(), publisher(), {}, pageCrypto.hash, { maxPages: 100, budget: 1 })
    expect(unbounded.pages.length).toBe(2)
    const bounded = await pagesFor(twoShares(), publisher(), {}, pageCrypto.hash, { maxPages: 100, budget: 1, maxChars: 1 })
    expect(bounded.pages.length).toBe(1)
    expect(bounded.more).toBe(true)
  })
})

describe('the store’s shapes, held to the wire', () => {
  it('refuses a boundary with an empty device, a roster past the wire’s bound, or a claim with a field the wire does not name', () => {
    const boundary = { device: DEVICE.id, from: 1, to: 1, v: 2 }
    expect(isSealedPage({ ...boundary, device: '' })).toBe(false)
    expect(isSealedPage({ ...boundary, roster: Array.from({ length: 257 }, () => 'd') })).toBe(false)
    expect(isSealedPage({ ...boundary, roster: Array.from({ length: 256 }, () => 'd') })).toBe(true)
    expect(isSealedPage({ ...boundary, work: { ids: [], titles: [], author: '', language: '', extra: 1 } })).toBe(false)
    expect(isSealedPage({ ...boundary, work: { ids: [], titles: [], author: '', language: '' } })).toBe(true)
    /* A range wider than a page's entry count is a page cut under an older version; a range no log reaches is not. */
    expect(isSealedPage({ ...boundary, to: 5_000 })).toBe(true)
    expect(isSealedPage({ ...boundary, to: MAX_BOUNDARY_SPAN + 1 })).toBe(false)
  })

  it('refuses a publication whose passage carries a field the wire does not name', async () => {
    const row = { pub: 'p', markId: 'm', device: DEVICE.id, seq: 1, at: stamp(1, DEVICE.id), passage: { quote: 'q', prefix: '', suffix: '', chapter: '', extra: 1 } }
    const fs = fakeFs({ [sharedPathIn('book:x')]: JSON.stringify({ publications: [row], sealed: [], opinions: [], reviews: [], publishOpinion: false }) }) as unknown as VaultFs
    await expect(readShared(fs, 'book:x')).rejects.toThrow(/publication list/u)
  })

  it('starts the next sequence past a sealed boundary, and refuses to run out of them', () => {
    expect(nextSeqFor({ ...NOTHING_PUBLISHED, sealed: [{ device: DEVICE.id, from: 1, to: 9, v: 2 }] }, DEVICE.id)).toBe(10)
    const full = { ...NOTHING_PUBLISHED, opinions: [{ op: 'rate' as const, stars: 4 as const, device: DEVICE.id, seq: Number.MAX_SAFE_INTEGER, at: stamp(1, DEVICE.id) }] }
    expect(() => nextSeqFor(full, DEVICE.id)).toThrow(/run out of sequence numbers/u)
  })
})

describe('the store’s parsers, one row per clause — the shape of what is read back', () => {
  const D = DEVICE.id
  const row = (over: Record<string, unknown> = {}) => ({ pub: 'p', markId: 'm', device: D, seq: 1, at: stamp(1, D), passage: { quote: 'q', prefix: 'a', suffix: 'b', chapter: 'c' }, ...over })
  const bound = (over: Record<string, unknown> = {}) => ({ device: D, from: 1, to: 2, v: WIRE_VERSION, ...over })
  const claim = (over: Record<string, unknown> = {}) => ({ ids: ['1a'.repeat(32)], titles: ['2b'.repeat(32)], author: '3c'.repeat(32), language: 'en', ...over })
  const tagRow = (tags: unknown) => ({ op: 'tag', tags, device: D, seq: 2, at: stamp(2, D) })
  const file = (over: Record<string, unknown>) => fsWith({ [sharedPathIn(BOOK)]: JSON.stringify({ publications: [], sealed: [], ...over }) })

  it('reads a well-formed row, boundary and register back', async () => {
    const held = await readShared(file({ publications: [row()], sealed: [bound({ work: claim(), roster: [D], revocations: 0, delegation: 'd' })], opinions: [tagRow(['sea'])] }), BOOK)
    expect(held.publications).toHaveLength(1)
    expect(held.sealed).toHaveLength(1)
    expect(held.opinions).toHaveLength(1)
  })

  it.each([
    ['a seq of zero', { publications: [row({ seq: 0 })] }, /publication list/u],
    ['a markId that is a number', { publications: [row({ markId: 1 })] }, /publication list/u],
    ['an empty device', { publications: [row({ device: '' })] }, /publication list/u],
    ['a prefix that is a number', { publications: [row({ passage: { quote: 'q', prefix: 1, suffix: 'b', chapter: 'c' } })] }, /publication list/u],
    ['a passage with a field the wire does not name', { publications: [row({ passage: { quote: 'q', prefix: 'a', suffix: 'b', chapter: 'c', extra: 1 } })] }, /publication list/u],
    ['a note that is a number', { publications: [row({ passage: { quote: 'q', prefix: 'a', suffix: 'b', chapter: 'c', note: 1 } })] }, /publication list/u],
    ['a chain version of zero', { sealed: [bound({ v: 0 })] }, /page boundaries/u],
    ['a chain version past this build', { sealed: [bound({ v: WIRE_VERSION + 1 })] }, /page boundaries/u],
    ['a roster with a number in it', { sealed: [bound({ roster: [D, 1] })] }, /page boundaries/u],
    ['a roster past two hundred and fifty-six', { sealed: [bound({ roster: Array.from({ length: 257 }, () => D) })] }, /page boundaries/u],
    ['revocations that are a string', { sealed: [bound({ revocations: '1' })] }, /page boundaries/u],
    ['a delegation that is an object', { sealed: [bound({ delegation: {} })] }, /page boundaries/u],
    ['a work that is a string', { sealed: [bound({ work: 'w' })] }, /page boundaries/u],
    ['a work that is an array', { sealed: [bound({ work: [] })] }, /page boundaries/u],
    ['a work that is null', { sealed: [bound({ work: null })] }, /page boundaries/u],
    ['a work with a field the claim does not name', { sealed: [bound({ work: claim({ extra: 1 }) })] }, /page boundaries/u],
    ['a work with ids that are a string', { sealed: [bound({ work: claim({ ids: '#a' }) })] }, /page boundaries/u],
    ['a work with an id that is a number', { sealed: [bound({ work: claim({ ids: [1] }) })] }, /page boundaries/u],
    ['a work with one id more than a claim may carry', { sealed: [bound({ work: claim({ ids: Array.from({ length: MAX_CLAIM_DIGESTS + 1 }, (_, i) => i.toString(16).padStart(64, '0')) }) })] }, /page boundaries/u],
    ['a work with an id that is not a digest', { sealed: [bound({ work: claim({ ids: ['#a'] }) })] }, /page boundaries/u],
    ['a work naming the shelf’s reserved id beside a digest', { sealed: [bound({ work: claim({ ids: [SHELF_WORK.ids[0], '1a'.repeat(32)] }) })] }, /page boundaries/u],
    ['a work with titles that are a string', { sealed: [bound({ work: claim({ titles: 't' }) })] }, /page boundaries/u],
    ['a work with a title that is a number', { sealed: [bound({ work: claim({ titles: [1] }) })] }, /page boundaries/u],
    ['a work with an author that is a number', { sealed: [bound({ work: claim({ author: 1 }) })] }, /page boundaries/u],
    ['a work with a language that is a number', { sealed: [bound({ work: claim({ language: 1 }) })] }, /page boundaries/u],
    ['a span as wide as the bound', { sealed: [bound({ from: 1, to: 1 + MAX_BOUNDARY_SPAN })] }, /page boundaries/u],
    ['a register that is null', { opinions: [null] }, /opinion list/u],
    ['a tag register past the bound', { opinions: [tagRow(Array.from({ length: MAX_TAGS + 1 }, () => 't'))] }, /opinion list/u],
    ['a tag register with a number in it', { opinions: [tagRow(['t', 1])] }, /opinion list/u],
  ])('refuses %s', async (_what, over, why) => {
    await expect(readShared(file(over), BOOK)).rejects.toThrow(why)
  })

  it.each([
    ['a span one short of the bound', { sealed: [bound({ from: 1, to: MAX_BOUNDARY_SPAN })] }],
    ['a narrow span high up, whose ends add to more than the bound', { sealed: [bound({ from: MAX_BOUNDARY_SPAN, to: MAX_BOUNDARY_SPAN + 1 })] }],
    ['a chain version of this build', { sealed: [bound({ v: WIRE_VERSION })] }],
    ['the first chain version', { sealed: [bound({ v: 1 })] }],
    ['a roster of two hundred and fifty-six', { sealed: [bound({ roster: Array.from({ length: 256 }, () => D) })] }],
    ['a work with as many ids as a claim may carry', { sealed: [bound({ work: claim({ ids: Array.from({ length: MAX_CLAIM_DIGESTS }, (_, i) => i.toString(16).padStart(64, '0')) }) })] }],
    ['a work that is the shelf’s reserved claim', { sealed: [bound({ work: SHELF_WORK })] }],
    ['a tag register at the bound', { opinions: [tagRow(Array.from({ length: MAX_TAGS }, () => 't'))] }],
    ['a register at the first sequence', { opinions: [{ ...tagRow(['t']), seq: 1, at: stamp(1, D) }] }],
  ])('accepts %s', async (_what, over) => {
    await expect(readShared(file(over), BOOK)).resolves.toBeDefined()
  })

  it('does not count another device’s sealed pages toward this device’s next sequence', () => {
    const held = { ...NOTHING_PUBLISHED, sealed: [{ device: PHONE.id, from: 1, to: 40, v: WIRE_VERSION }] }
    expect(nextSeqFor(held, D)).toBe(1)
    expect(nextSeqFor(held, PHONE.id)).toBe(41)
  })

  it('carries a tag register into its entry whole', () => {
    const held = { ...NOTHING_PUBLISHED, opinions: [{ op: 'tag' as const, tags: ['sea', 'whales'], device: D, seq: 1, at: stamp(1, D) }] }
    const entry = logOf(held).find((one) => one.op === 'tag')
    expect(entry).toMatchObject({ tags: ['sea', 'whales'] })
  })

  it('measures the envelope as the frame a page carries with no entries — plus the sixteen the brackets take', () => {
    const p = publisher()
    const frame = {
      v: WIRE_VERSION,
      person: p.person,
      work: p.work,
      device: p.device,
      /* The widest sequences a page can carry — measured as zeroes, a page
         filled to the budget high up in a long log went out past the cap. */
      from: Number.MAX_SAFE_INTEGER,
      to: Number.MAX_SAFE_INTEGER,
      prevPageHash: 'f'.repeat(64),
      entries: [],
      roster: [...p.roster],
      revocations: p.revocations,
      delegation: p.delegation,
      sig: 'f'.repeat(128),
    }
    expect(envelopeOf(p, WIRE_VERSION)).toBe(canonicalJson(frame).length + 16)
    expect(envelopeOf(p, WIRE_VERSION)).toBe(canonicalJson({ ...frame, from: 0, to: 0 }).length + 16 + 30)
  })

  it('re-serves a sealed page under the work it was sealed with, not the publisher’s current one', async () => {
    const first = await pagesFor(twoShares(), publisher(), {}, pageCrypto.hash)
    expect(first.pages.length).toBeGreaterThan(0)
    const moved = publisher({ work: { ...WORK, titles: ['another title'] } })
    const again = await pagesFor(first.held, moved, {}, pageCrypto.hash)
    expect((JSON.parse(again.pages[0]!) as { work: unknown }).work).toEqual(WORK)
  })

  it('serves at most the page cap, and says there is more', async () => {
    let held = NOTHING_PUBLISHED
    for (let i = 1; i <= 12; i++) held = share(held, { markId: `m${i}`, passage: passage(`passage number ${i} `.repeat(12)), device: D }, `pub${i}`, stamp(i, D)).held
    const sealed = await pagesFor(held, publisher(), {}, pageCrypto.hash, { ...DEFAULT_BOUNDS, budget: 600 })
    expect(sealed.pages.length).toBeGreaterThanOrEqual(3)
    const two = await pagesFor(sealed.held, publisher(), {}, pageCrypto.hash, { ...DEFAULT_BOUNDS, budget: 600, maxPages: 2 })
    expect(two.pages).toHaveLength(2)
    expect(two.more).toBe(true)
    const all = await pagesFor(sealed.held, publisher(), {}, pageCrypto.hash, { ...DEFAULT_BOUNDS, budget: 600, maxPages: sealed.pages.length })
    expect(all.pages).toHaveLength(sealed.pages.length)
    expect(all.more).toBe(false)
    /* The size budget, in bytes ON THE WIRE — the page JSON-escaped inside
       the envelope and UTF-8 encoded, which is more than its characters:
       exactly two pages' worth answers two; one byte less answers one. */
    const bytes = wireBytesOf(two.pages[0]!) + wireBytesOf(two.pages[1]!)
    expect(bytes).toBeGreaterThan(two.pages[0]!.length + two.pages[1]!.length)
    expect((await pagesFor(sealed.held, publisher(), {}, pageCrypto.hash, { ...DEFAULT_BOUNDS, budget: 600, maxChars: bytes })).pages).toHaveLength(2)
    expect((await pagesFor(sealed.held, publisher(), {}, pageCrypto.hash, { ...DEFAULT_BOUNDS, budget: 600, maxChars: bytes - 1 })).pages).toHaveLength(1)
  })

  it('weighs a page as the envelope carries it — escaped and encoded — so a page of prose in Chinese cannot outgrow the frame', () => {
    const ascii = '{"a":"b"}'
    expect(wireBytesOf(ascii)).toBe(new TextEncoder().encode(JSON.stringify(ascii)).length)
    /* Two backslashes and two quotes for the string's own, and one more for the string's delimiters. */
    expect(wireBytesOf(ascii)).toBe(ascii.length + 2 + 4)
    const prose = '{"quote":"白鲸"}'
    expect(wireBytesOf(prose)).toBeGreaterThan(prose.length + 4)
    expect(wireBytesOf(prose)).toBe(new TextEncoder().encode(JSON.stringify(prose)).length)
  })
})

describe('a withdrawal made by another of the reader’s devices', () => {
  const phone = (): Publisher =>
    publisher({ device: PHONE.id, delegation: delegationFor(PHONE.id), sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), PHONE.secret))) })
  const ops = (pages: readonly string[]): string[][] => pages.map((raw) => (JSON.parse(raw) as { entries: { op: string }[] }).entries.map((one) => one.op))

  it('is stamped in the WITHDRAWING device’s stream, counted there, and served by it', async () => {
    /* The phone takes back what the desktop published. Filed under the
       desktop, the tombstone was one the phone never served — `pagesOver`
       serves only the caller's own stream — and its number, minted from the
       phone's count, could collide with one the desktop minted later. */
    const held = unshare(twoShares(), 'pub1', PHONE.id, stamp(3, PHONE.id))
    expect(held.publications[0]?.unshared).toEqual({ device: PHONE.id, seq: 1, at: stamp(3, PHONE.id) })
    expect(nextSeqFor(held, PHONE.id)).toBe(2)
    expect(nextSeqFor(held, DEVICE.id)).toBe(3)
    expect(logOf(held).find((one) => one.op === 'unshare')).toMatchObject({ device: PHONE.id, seq: 1, pub: 'pub1' })

    /* The phone serves it; the desktop's chain does not carry it. */
    const fromPhone = await pagesFor(held, phone(), {}, pageCrypto.hash)
    expect(ops(fromPhone.pages)).toEqual([['unshare']])
    const fromDesk = await pagesFor(held, publisher(), {}, pageCrypto.hash)
    expect(ops(fromDesk.pages)).toEqual([['share', 'share']])

    /* And a recipient holding both streams no longer sees the passage. */
    const taken = takePages([...fromDesk.pages, ...fromPhone.pages], WORK, PERSON.id, ledger(), pageCrypto, NOW)
    expect(taken.refusals).toEqual([])
    expect(taken.held.entries.map((one) => one.pub)).toEqual(['pub2'])
    expect(taken.held.withdrawn).toEqual(['pub1'])
  })

  it('reads back from disk, and the row’s own stream keeps its own rule', async () => {
    const row = { pub: 'p', markId: 'm', device: DEVICE.id, seq: 3, at: stamp(1, DEVICE.id), passage: { quote: 'q', prefix: '', suffix: '', chapter: '' } }
    const fileWith = (unshared: unknown) =>
      fakeFs({ [sharedPathIn('book:x')]: JSON.stringify({ publications: [{ ...row, unshared }], sealed: [], opinions: [], reviews: [], publishOpinion: false }) }) as unknown as VaultFs
    /* Another device's stream starts from 1, whatever the row's own number. */
    const other = await readShared(fileWith({ seq: 1, at: stamp(2, PHONE.id), device: PHONE.id }), 'book:x')
    expect(logOf(other).find((one) => one.op === 'unshare')).toMatchObject({ device: PHONE.id, seq: 1 })
    /* A row written before the device was kept reads as the row's own. */
    const legacy = await readShared(fileWith({ seq: 4, at: stamp(2, DEVICE.id) }), 'book:x')
    expect(logOf(legacy).find((one) => one.op === 'unshare')).toMatchObject({ device: DEVICE.id, seq: 4 })
    for (const bad of [
      /* The row's own device, named, is held to the row's own rule. */
      { seq: 3, at: stamp(2, DEVICE.id), device: DEVICE.id },
      { seq: 1, at: stamp(2, PHONE.id), device: '' },
      { seq: 1, at: stamp(2, PHONE.id), device: 7 },
      { seq: 0, at: stamp(2, PHONE.id), device: PHONE.id },
    ]) {
      await expect(readShared(fileWith(bad), 'book:x')).rejects.toThrow(/publication list/u)
    }
  })
})

describe('a store 0.1.3 wrote — boundaries with no chain version', () => {
  /* That build sealed `{ device, from, to }`: one chain, nothing to name. A
     reader refusing it made every book with a page served before the upgrade
     unreadable on the first read after it. */
  const legacy = () => {
    const held = twoShares()
    return fakeFs({ [sharedPathIn('book:x')]: JSON.stringify({ publications: held.publications, sealed: [{ device: DEVICE.id, from: 1, to: 2 }] }) }) as unknown as VaultFs
  }

  it('reads such a boundary as v1, and reproduces the page it sealed on the v1 chain without re-cutting it', async () => {
    const held = await readShared(legacy(), 'book:x')
    expect(held.sealed).toEqual([{ device: DEVICE.id, from: 1, to: 2, v: 1 }])
    const v1 = await pagesFor(held, publisher(), {}, pageCrypto.hash, DEFAULT_BOUNDS, 1)
    expect(v1.pages).toHaveLength(1)
    expect(JSON.parse(v1.pages[0]!)).toMatchObject({ v: 1, from: 1, to: 2 })
    /* Nothing new SEALED — the boundary read is the boundary served, not
       re-cut — but it is now PINNED: a legacy boundary records the roster,
       revocations and claim it was rendered with, so a later roster change
       cannot alter the bytes of a page already sent. Range and chain
       unchanged; metadata gained. */
    expect(v1.held.sealed).toHaveLength(1)
    expect(v1.held.sealed[0]).toMatchObject({ device: DEVICE.id, from: 1, to: 2, v: 1 })
    expect(v1.held.sealed[0]).toHaveProperty('roster')
    expect(v1.held.sealed[0]).toHaveProperty('revocations')
  })

  it('seals the v2 chain afresh beside it — two chains, as `SealedPage.v` says', async () => {
    const held = await readShared(legacy(), 'book:x')
    const v2 = await pagesFor(held, publisher(), {}, pageCrypto.hash, DEFAULT_BOUNDS, 2)
    expect(v2.pages).toHaveLength(1)
    /* Two chains, side by side — and the v1 one is now pinned rather than
       rebuilt from live state on every serve. */
    expect(v2.held.sealed).toEqual([
      expect.objectContaining({ device: DEVICE.id, from: 1, to: 2, v: 1 }),
      expect.objectContaining({ device: DEVICE.id, from: 1, to: 2, v: 2 }),
    ])
  })

  it('still refuses a boundary naming a chain this build does not serve', async () => {
    const fs = fakeFs({ [sharedPathIn('book:x')]: JSON.stringify({ publications: [], sealed: [{ device: DEVICE.id, from: 1, to: 2, v: WIRE_VERSION + 1 }] }) }) as unknown as VaultFs
    await expect(readShared(fs, 'book:x')).rejects.toThrow(/page boundaries/u)
  })
})

/* THE TWO LIMITS, READ APART FROM THE SIGNING: a page count and a byte budget
   over the bytes that travel, the first page unconditional. */
describe('the bounded answer', () => {
  it('takes the first page whatever it costs, then only what fits beside the rest, and is full at the page cap', () => {
    const answer = boundedAnswer({ maxPages: 2, budget: 200, maxChars: 12 })
    expect(answer.full()).toBe(false)
    /* Ten bytes on the wire — eight and the quotes — and it would go at any size. */
    expect(answer.add('12345678')).toBe(true)
    /* Five more is fifteen, past twelve: it waits. */
    expect(answer.add('123')).toBe(false)
    expect(answer.pages).toEqual(['12345678'])
    expect(answer.full()).toBe(false)
    /* One that fits beside the first goes, and the cap is reached. */
    expect(answer.add('')).toBe(true)
    expect(answer.full()).toBe(true)
    expect(answer.pages).toEqual(['12345678', ''])
    /* A first page over the budget on its own still goes — or a cursor could never pass it. */
    const wide = boundedAnswer({ maxPages: 1, budget: 200, maxChars: 4 })
    expect(wide.add('a page wider than the budget')).toBe(true)
    expect(wide.full()).toBe(true)
  })
})
