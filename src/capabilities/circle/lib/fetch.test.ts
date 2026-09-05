import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { blake3 } from '@noble/hashes/blake3.js'
import { createSpendLedger } from './spendLedger'
import { createCoverFetcher } from './covers'
import { base64Of } from './base64'
import { fakeFs } from '../../../kernel/testkit'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import { NOTHING_SPENT, canonicalJson, charge, makeHlc, type Hlc, type Passage, type Spend, hlcOf } from '../../../kernel'
import { pageCrypto } from './crypto'
import { answerLists, answerPages, answerShelf, welcome, workDigest, type BookLike, type Serving } from './exchange'
import { LIST_WINDOW_ROTATES_MS, MAX_ANSWERS_PER_LOG, fetchRound, listWindowOf, type Dialled, type FetchPorts, type PersonToFetch } from './fetch'
import { CIRCLE_SERVICES, MAX_LISTS_PER_REQUEST, parseListsRequest } from './protocol'
import { DEFAULT_BOUNDS, NOTHING_PUBLISHED, pagesFor, share, type Publisher, type SharedFile } from './publish'
import { delegationBytes, type SignedDelegation } from './receive'
import { NOTHING_SHELVED, syncShelf } from './shelf'
import { NOTHING_LISTED, createList, placeOnList, retitleList, type ListFile } from './lists'
import { NOTHING_SHARED, type ForeignFile } from './store'

hashes.sha512 = sha512

/**
 * The fetch driver, against an in-process publisher with real signatures —
 * WI-23.A2.
 *
 * ⚠️ **THE STAGE A ACCEPTANCE, IN MINIATURE**: a passage shared on A appears
 * in B's file with B having opened nothing — a round is the only thing that
 * runs. And the item's second falsifier: *"relaunch B and let one cadence run:
 * the number of pages fetched for a log B already held in full must be 0."*
 */

const NOW = 1_700_000_000_000

function keypair(seed: string) {
  const secret = utf8ToBytes(seed.padEnd(32, '.')).slice(0, 32)
  return { secret, id: bytesToHex(getPublicKey(secret)) }
}
const ALICE = keypair('alice')
const ALICE_LAPTOP = keypair('alice-laptop')
const ALICE_PHONE = keypair('alice-phone')
const BOB = keypair('bob')

const stamp = (n: number, device: string): Hlc => makeHlc(NOW + n, 0, device.slice(0, 16))
const passage = (quote: string): Passage => ({ quote, prefix: 'before ', suffix: ' after', chapter: 'One' })

function delegationFor(person: typeof ALICE, device: string): string {
  const body = { person: person.id, device, notBefore: NOW - 1_000, notAfter: NOW + 1_000_000, roster: 0 }
  const sig = bytesToHex(sign(utf8ToBytes(delegationBytes({ ...body, sig: '' } as SignedDelegation)), person.secret))
  return canonicalJson({ ...body, sig })
}

/** The one work both shelves hold — same claim on both sides. */
const MOBY: BookLike = { id: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247', languages: ['en'] }

/** Alice's publishing side: a store, a shelf of one book, and her laptop's key. */
function alice() {
  const files = new Map<string, SharedFile>()
  const ownLists = new Map<string, ListFile>()
  const lists = () => [...ownLists].map(([id, held]) => ({ id, held }))
  const publisher = (work: Publisher['work']): Publisher => ({
    person: ALICE.id,
    device: ALICE_LAPTOP.id,
    work,
    roster: [ALICE_LAPTOP.id, ALICE_PHONE.id],
    revocations: 0,
    delegation: delegationFor(ALICE, ALICE_LAPTOP.id),
    sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), ALICE_LAPTOP.secret))),
  })
  const serving: Serving = {
    books: [MOBY],
    shared: (bookId) => Promise.resolve(files.get(bookId) ?? NOTHING_PUBLISHED),
    seal: (bookId, held) => {
      files.set(bookId, held)
      return Promise.resolve()
    },
    publisher: (work) => Promise.resolve(publisher(work)),
    shelf: () => Promise.resolve(NOTHING_SHELVED),
    sealShelf: () => Promise.resolve(),
    lists: () => Promise.resolve(lists()),
    sealList: (id, held) => {
      ownLists.set(id, held)
      return Promise.resolve()
    },
    cover: () => Promise.resolve(null),
  }
  let seq = 0
  return {
    files,
    ownLists,
    serving,
    publisher,
    /** Alice shares one more passage from her laptop. */
    shareOne(quote: string) {
      seq += 1
      const held = files.get(MOBY.id) ?? NOTHING_PUBLISHED
      files.set(MOBY.id, share(held, { markId: `m${seq}`, passage: passage(quote), device: ALICE_LAPTOP.id }, `pub${seq}`, stamp(seq, ALICE_LAPTOP.id)).held)
    },
  }
}

/** A session to Alice's laptop, answering through the real exchange. */
function sessionTo(serving: Serving, answering = ALICE.id): Dialled & { readonly calls: string[]; closed: number } {
  const calls: string[] = []
  const session = {
    calls,
    closed: 0,
    call: async (service: string, body: unknown) => {
      calls.push(service)
      if (service === CIRCLE_SERVICES.hello.name) return welcome(body, answering)
      if (service === CIRCLE_SERVICES.pages.name) return answerPages(body, serving)
      /* The shelf, as a person the switch is on for is served it. */
      if (service === CIRCLE_SERVICES.shelf.name) return answerShelf(body, serving, true)
      if (service === CIRCLE_SERVICES.lists.name) return answerLists(body, serving, true)
      throw new Error(`no such service ${service}`)
    },
    close: () => {
      session.closed += 1
      return Promise.resolve()
    },
  }
  return session
}

/* ONE device to dial by default: every device that answers is dialled, and
   with the phone mapped to the laptop's session every count below would
   double. The tests about a second device name it. */
const alicePerson = (over: Partial<PersonToFetch> = {}): PersonToFetch => ({
  person: ALICE.id,
  devices: [ALICE_LAPTOP.id],
  revoked: [],
  roster: { epoch: 0 },
  ...over,
})

/** Bob's side: a store per `(book, person)`, a spend ledger, and the ports. */
function bob(over: Partial<FetchPorts> = {}) {
  const held = new Map<string, ForeignFile>()
  const spend = new Map<string, Spend>()
  const keep = vi.fn((bookId: string, person: string, file: ForeignFile) => {
    held.set(`${bookId}/${person}`, file)
    return Promise.resolve()
  })
  const spent = vi.fn((person: string, next: Spend) => {
    spend.set(person, next)
  })
  const keepShelf = vi.fn((person: string, file: ForeignFile) => {
    held.set(`shelf/${person}`, file)
    return Promise.resolve()
  })
  const keepList = vi.fn((person: string, listId: string, file: ForeignFile) => {
    held.set(`list/${person}/${listId}`, file)
    return Promise.resolve()
  })
  const ports: FetchPorts = {
    mine: () => Promise.resolve({ person: BOB.id }),
    people: () => Promise.resolve([alicePerson()]),
    relationship: () => Promise.resolve({ state: 'admitted', epoch: 1, changedAt: hlcOf(1) }),
    dialable: () => Promise.resolve(new Set([ALICE_LAPTOP.id, ALICE_PHONE.id])),
    dial: () => Promise.reject(new Error('nobody to dial — the test sets one')),
    books: () => [MOBY],
    held: (bookId, person) => Promise.resolve(held.get(`${bookId}/${person}`) ?? NOTHING_SHARED),
    keep,
    heldShelf: (person) => Promise.resolve(held.get(`shelf/${person}`) ?? NOTHING_SHARED),
    keepShelf: keepShelf,
    heldLists: (person) =>
      Promise.resolve(new Map([...held].filter(([key]) => key.startsWith(`list/${person}/`)).map(([key, file]) => [key.slice(`list/${person}/`.length), file]))),
    keepList,
    /* The ledger as `index.ts` keeps it: one step, read to commit. `spent`
       records each charge that landed, for the assertions that count them. */
    charge: (person, key, bytes, now, budget) => {
      const charged = charge(spend.get(person) ?? NOTHING_SPENT, key, bytes, now, budget)
      if (charged.allowed) spent(person, charged.spend)
      return charged.allowed
    },
    now: () => NOW,
    crypto: pageCrypto,
    ...over,
  }
  return {
    ports,
    held,
    keep,
    keepShelf,
    spent,
    spend,
    fromAlice: () => held.get(`${MOBY.id}/${ALICE.id}`) ?? NOTHING_SHARED,
    shelfOfAlice: () => held.get(`shelf/${ALICE.id}`) ?? NOTHING_SHARED,
    keepList,
    listOfAlice: (listId: string) => held.get(`list/${ALICE.id}/${listId}`) ?? NOTHING_SHARED,
  }
}

describe('a passage shared on A appears in B', () => {
  it('reaches B’s file in one round, with B having opened nothing', async () => {
    const a = alice()
    a.shareOne('Call me Ishmael')
    a.shareOne('the whiteness of the whale')
    const session = sessionTo(a.serving)
    const b = bob({ dial: () => Promise.resolve(session) })

    const report = await fetchRound(b.ports)

    expect(report.asked).toBe(1)
    expect(report.accepted).toBe(1)
    expect(report.refusals).toBe(0)
    expect(report.skipped).toEqual([])
    expect(b.fromAlice().entries.map((one) => one.passage.quote)).toEqual(['Call me Ishmael', 'the whiteness of the whale'])
    expect(b.fromAlice().entries.every((one) => one.person === ALICE.id)).toBe(true)
    /* Recorded under the relationship record's epoch — 1, the first
       admission, for a record read from nothing. */
    expect(b.fromAlice().entries.every((one) => one.epoch === 1)).toBe(true)
    /* The cursor and the chain head landed in the SAME file. */
    expect(b.fromAlice().cursor[ALICE_LAPTOP.id]).toBe(2)
    expect(b.fromAlice().heads[ALICE_LAPTOP.id]).toMatch(/^[0-9a-f]{64}$/u)
    /* The session was hello, then pages, then the shelf and the lists, and was closed. */
    expect(session.calls).toEqual([CIRCLE_SERVICES.hello.name, CIRCLE_SERVICES.pages.name, CIRCLE_SERVICES.shelf.name, CIRCLE_SERVICES.lists.name])
    expect(session.closed).toBe(1)
  })

  it('fetches 0 pages for a log already held in full — the relaunch falsifier', async () => {
    /* ⚠️ **THE CURSOR IS PERSISTED, SO A RELAUNCH DOES NOT START FROM ZERO.**
       `held` answers from the file the first round wrote; a second round asks
       from that cursor and Alice answers nothing. */
    const a = alice()
    a.shareOne('Call me Ishmael')
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)) })
    await fetchRound(b.ports)
    expect(b.keep).toHaveBeenCalledTimes(1)

    const again = await fetchRound(b.ports)
    expect(again.accepted).toBe(0)
    /* One call for the book's log, one for the shelf, one for the lists — all answered empty. */
    expect(again.calls).toBe(3)
    expect(b.keep).toHaveBeenCalledTimes(1)
    /* An empty answer costs nothing and charges nothing: the ledger was
       written once, by the round that fetched something. */
    expect(b.spent).toHaveBeenCalledTimes(1)
  })

  it('records entries under the relationship epoch the port names', async () => {
    const a = alice()
    a.shareOne('x')
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)), relationship: () => Promise.resolve({ state: 'admitted', epoch: 4, changedAt: hlcOf(1) }) })
    await fetchRound(b.ports)
    expect(b.fromAlice().entries[0]!.epoch).toBe(4)
  })

  it('keeps nothing and asks no further when every page in an answer is refused', async () => {
    /* A page signed by a key that is not the device it claims: `takePages`
       refuses it, and a round must neither write the unchanged file back nor
       follow `more` into a peer whose pages it cannot take. */
    const a = alice()
    a.shareOne('x')
    const forging: Serving = {
      ...a.serving,
      publisher: (work) => Promise.resolve({
        ...a.publisher(work),
        sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), ALICE_PHONE.secret))),
      }),
    }
    let pagesCalls = 0
    const session: Dialled = {
      call: async (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return welcome(body, ALICE.id)
        if (service === CIRCLE_SERVICES.shelf.name || service === CIRCLE_SERVICES.lists.name) return { pages: [], more: false }
        pagesCalls += 1
        const answer = await answerPages(body, forging)
        return { pages: answer!.pages, more: true }
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })

    const report = await fetchRound(b.ports)

    expect(report.refusals).toBe(1)
    expect(report.accepted).toBe(0)
    expect(pagesCalls).toBe(1)
    expect(b.keep).not.toHaveBeenCalled()
  })

  it('fetches only what is new once the log grows', async () => {
    const a = alice()
    a.shareOne('first')
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)) })
    await fetchRound(b.ports)

    a.shareOne('second')
    const report = await fetchRound(b.ports)
    expect(report.accepted).toBe(1)
    expect(b.fromAlice().entries.map((one) => one.passage.quote)).toEqual(['first', 'second'])
    expect(b.fromAlice().cursor[ALICE_LAPTOP.id]).toBe(2)
  })

  it('follows `more` across answers, keeping each as it lands', async () => {
    /* Two pages sealed separately — a share, a round that seals it, another
       share — then a FRESH recipient served one page per answer. */
    const a = alice()
    a.shareOne('first')
    await fetchRound(bob({ dial: () => Promise.resolve(sessionTo(a.serving)) }).ports)
    a.shareOne('second')
    const onePageAtATime: Dialled = {
      call: async (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return welcome(body, ALICE.id)
        const asked = body as { work: Publisher['work']; since: Record<string, number> }
        const held = a.files.get(MOBY.id) ?? NOTHING_PUBLISHED
        const built = await pagesFor(held, a.publisher(asked.work), asked.since, workDigest, { maxPages: 1, budget: DEFAULT_BOUNDS.budget })
        a.files.set(MOBY.id, built.held)
        return { pages: built.pages, more: built.more }
      },
      close: () => Promise.resolve(),
    }
    const fresh = bob({ dial: () => Promise.resolve(onePageAtATime) })

    const report = await fetchRound(fresh.ports)

    expect(report.accepted).toBe(2)
    /* Two answers for the log, then the shelf once and the lists once. */
    expect(report.calls).toBe(4)
    expect(fresh.keep).toHaveBeenCalledTimes(2)
    expect(fresh.fromAlice().entries.map((one) => one.passage.quote)).toEqual(['first', 'second'])
  })

  it('stops following `more` after the per-log cap, and picks up the rest next round', async () => {
    const a = alice()
    for (let n = 1; n <= MAX_ANSWERS_PER_LOG + 1; n++) {
      a.shareOne(`passage ${n}`)
      /* A throwaway recipient seals each share as its own page. */
      await fetchRound(bob({ dial: () => Promise.resolve(sessionTo(a.serving)) }).ports)
    }
    const onePageAtATime: Dialled = {
      call: async (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return welcome(body, ALICE.id)
        const asked = body as { work: Publisher['work']; since: Record<string, number> }
        const built = await pagesFor(a.files.get(MOBY.id)!, a.publisher(asked.work), asked.since, workDigest, { maxPages: 1, budget: DEFAULT_BOUNDS.budget })
        return { pages: built.pages, more: built.more }
      },
      close: () => Promise.resolve(),
    }
    const fresh = bob({ dial: () => Promise.resolve(onePageAtATime) })

    const first = await fetchRound(fresh.ports)
    /* The cap on the log, plus the one shelf call and the one lists call after it. */
    expect(first.calls).toBe(MAX_ANSWERS_PER_LOG + 2)
    expect(first.accepted).toBe(MAX_ANSWERS_PER_LOG)
    expect(fresh.fromAlice().entries).toHaveLength(MAX_ANSWERS_PER_LOG)

    const second = await fetchRound(fresh.ports)
    expect(second.accepted).toBe(1)
    expect(fresh.fromAlice().entries).toHaveLength(MAX_ANSWERS_PER_LOG + 1)
  })
})

describe('which chain is asked for — WI-23.B2', () => {
  /** A session that records every pages request it is asked. */
  function recording(serving: Serving, pages: { min: number; max: number }) {
    const asked: Record<string, unknown>[] = []
    const session: Dialled = {
      call: async (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) {
          /* A peer that speaks exactly `pages`: its welcome is what such a
             build would send, agreed re-derived on this side. */
          return { proto: 1, pages, person: ALICE.id, agreed: Math.min(pages.max, 2) }
        }
        asked.push(body as Record<string, unknown>)
        return answerPages(body, serving)
      },
      close: () => Promise.resolve(),
    }
    return { session, asked }
  }

  it('names v2 to a v2 peer, and names NO version to a v1 peer, whose parser would refuse one', async () => {
    const a = alice()
    a.shareOne('x')
    const v2 = recording(a.serving, { min: 1, max: 2 })
    await fetchRound(bob({ dial: () => Promise.resolve(v2.session) }).ports)
    expect(v2.asked[0]).toMatchObject({ v: 2 })

    const v1 = recording(a.serving, { min: 1, max: 1 })
    const b = bob({ dial: () => Promise.resolve(v1.session) })
    const report = await fetchRound(b.ports)
    expect(v1.asked[0]).not.toHaveProperty('v')
    /* And the v1 chain's pages were taken — under v1. */
    expect(report.accepted).toBe(1)
    expect(b.fromAlice().v).toBe(1)
  })

  it('asks from the start of a chain it has not fetched, not from a cursor held on another', async () => {
    /* ⚠️ A cursor is a position on ONE chain. Held for v1 and asked under
       v2, it would skip the v2 chain's opening pages for ever. */
    const a = alice()
    a.shareOne('x')
    const heldOnV1: ForeignFile = { ...NOTHING_SHARED, cursor: { [ALICE_LAPTOP.id]: 7 }, v: 1 }
    const v2 = recording(a.serving, { min: 1, max: 2 })
    const b = bob({ dial: () => Promise.resolve(v2.session), held: () => Promise.resolve(heldOnV1) })
    await fetchRound(b.ports)
    expect(v2.asked[0]!['since']).toEqual({})
    expect(v2.asked[0]!['v']).toBe(2)
    /* Whereas on the chain the cursor belongs to, it is used. */
    const v1 = recording(a.serving, { min: 1, max: 1 })
    await fetchRound(bob({ dial: () => Promise.resolve(v1.session), held: () => Promise.resolve(heldOnV1) }).ports)
    expect(v1.asked[0]).toMatchObject({ since: { [ALICE_LAPTOP.id]: 7 } })
  })
})

describe('the shelf, after the books — WI-23.C1/C3', () => {
  /** Alice's serving side with a published shelf of her own. */
  function aliceWithShelf(titles: readonly string[]) {
    const a = alice()
    let shelf = syncShelf(
      NOTHING_SHELVED,
      titles.map((title, i) => ({ bookId: `book:${i}`, title, author: 'A', languages: ['en'] })),
      ALICE_LAPTOP.id,
      stamp(50, ALICE_LAPTOP.id),
      () => `s${titles.length}-${Math.random()}`,
    )
    const serving: Serving = {
      ...a.serving,
      shelf: () => Promise.resolve(shelf),
      sealShelf: (held) => {
        shelf = held
        return Promise.resolve()
      },
    }
    return { ...a, serving, reshelve: (next: readonly string[]) => {
      shelf = syncShelf(shelf, next.map((title, i) => ({ bookId: `book:${i}`, title, author: 'A', languages: ['en'] })), ALICE_LAPTOP.id, stamp(60, ALICE_LAPTOP.id), () => `r${Math.random()}`)
    } }
  }
  /** A session answering the shelf too, as the real handler does for a person the switch is ON for. */
  const sessionWithShelf = (serving: Serving, discloses = true): Dialled & { readonly asked: string[] } => {
    const asked: string[] = []
    return {
      asked,
      call: async (service, body) => {
        asked.push(service)
        if (service === CIRCLE_SERVICES.hello.name) return welcome(body, ALICE.id)
        if (service === CIRCLE_SERVICES.pages.name) return answerPages(body, serving)
        return answerShelf(body, serving, discloses)
      },
      close: () => Promise.resolve(),
    }
  }

  it('lands Alice’s shelf in Bob’s shelf file, under her own folder', async () => {
    const a = aliceWithShelf(['Moby-Dick', 'Dune'])
    const session = sessionWithShelf(a.serving)
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(session.asked).toEqual([CIRCLE_SERVICES.hello.name, CIRCLE_SERVICES.pages.name, CIRCLE_SERVICES.shelf.name, CIRCLE_SERVICES.lists.name])
    expect(b.shelfOfAlice().works.map((one) => one.work.title).sort()).toEqual(['Dune', 'Moby-Dick'])
    expect(b.keepShelf).toHaveBeenCalledTimes(1)
    expect(report.accepted).toBe(1)
    /* The shelf's cursor and chain live in the shelf file, apart from any book's. */
    expect(b.shelfOfAlice().cursor[ALICE_LAPTOP.id]).toBe(2)
    expect(b.fromAlice().cursor).toEqual({})
  })

  it('follows the shelf as it changes, fetching only what is new', async () => {
    const a = aliceWithShelf(['Moby-Dick'])
    const b = bob({ dial: () => Promise.resolve(sessionWithShelf(a.serving)) })
    await fetchRound(b.ports)
    a.reshelve(['Moby-Dick', 'Dune'])
    const again = await fetchRound(b.ports)
    expect(again.accepted).toBe(1)
    expect(b.shelfOfAlice().works.map((one) => one.work.title).sort()).toEqual(['Dune', 'Moby-Dick'])
    a.reshelve(['Dune'])
    await fetchRound(b.ports)
    expect(b.shelfOfAlice().works.map((one) => one.work.title)).toEqual(['Dune'])
  })

  it('holds nothing for a person the switch is off for, and cannot tell that from an empty shelf', async () => {
    const a = aliceWithShelf(['Moby-Dick'])
    const b = bob({ dial: () => Promise.resolve(sessionWithShelf(a.serving, false)) })
    await fetchRound(b.ports)
    expect(b.shelfOfAlice().works).toEqual([])
    expect(b.keepShelf).not.toHaveBeenCalled()
  })

  it('asks a v1 peer for no shelf at all', async () => {
    const a = aliceWithShelf(['Moby-Dick'])
    const asked: string[] = []
    const v1: Dialled = {
      call: async (service, body) => {
        asked.push(service)
        if (service === CIRCLE_SERVICES.hello.name) return { proto: 1, pages: { min: 1, max: 1 }, person: ALICE.id, agreed: 1 }
        return answerPages(body, a.serving)
      },
      close: () => Promise.resolve(),
    }
    await fetchRound(bob({ dial: () => Promise.resolve(v1) }).ports)
    expect(asked).not.toContain(CIRCLE_SERVICES.shelf.name)
  })
})

describe('who is asked, and who is not', () => {
  it('asks nobody when this device has no identity', async () => {
    const dial = vi.fn(() => Promise.resolve(sessionTo(alice().serving)))
    const b = bob({ mine: () => Promise.resolve(null), dial })
    const report = await fetchRound(b.ports)
    expect(report).toEqual({ asked: 0, calls: 0, accepted: 0, refusals: 0, skipped: [] })
    expect(dial).not.toHaveBeenCalled()
  })

  it('skips a person whose relationship does not accept transport, without dialling', async () => {
    const dial = vi.fn(() => Promise.resolve(sessionTo(alice().serving)))
    for (const state of ['blocked', 'exited'] as const) {
      const b = bob({ relationship: () => Promise.resolve({ state, epoch: 1, changedAt: hlcOf(1) }), dial })
      const report = await fetchRound(b.ports)
      expect(report.skipped).toEqual([{ person: ALICE.id, why: 'not-admitted' }])
    }
    expect(dial).not.toHaveBeenCalled()
    /* And a MUTED person is still fetched from — muting stops the drawing,
       not the transport. */
    const muted = bob({ relationship: () => Promise.resolve({ state: 'muted', epoch: 1, changedAt: hlcOf(1) }), dial })
    expect((await fetchRound(muted.ports)).asked).toBe(1)
  })

  it('skips a person none of whose devices this side may dial', async () => {
    const dial = vi.fn(() => Promise.resolve(sessionTo(alice().serving)))
    const unknown = bob({ dialable: () => Promise.resolve(new Set<string>()), dial })
    expect((await fetchRound(unknown.ports)).skipped).toEqual([{ person: ALICE.id, why: 'no-device' }])
    /* A person met and not yet heard from has no devices at all. */
    const unheard = bob({ people: () => Promise.resolve([alicePerson({ devices: [] })]), dial })
    expect((await fetchRound(unheard.ports)).skipped).toEqual([{ person: ALICE.id, why: 'no-device' }])
    /* And a revoked device is not dialled however the roster once read. */
    const revoked = bob({ people: () => Promise.resolve([alicePerson({ devices: [ALICE_LAPTOP.id], revoked: [ALICE_LAPTOP.id] })]), dial })
    expect((await fetchRound(revoked.ports)).skipped).toEqual([{ person: ALICE.id, why: 'no-device' }])
    expect(dial).not.toHaveBeenCalled()
  })

  it('tries the next device when one is asleep, and skips the person when all are', async () => {
    const a = alice()
    a.shareOne('x')
    const dialled: string[] = []
    const b = bob({
      people: () => Promise.resolve([alicePerson({ devices: [ALICE_LAPTOP.id, ALICE_PHONE.id] })]),
      dial: (device) => {
        dialled.push(device)
        return device === ALICE_PHONE.id ? Promise.resolve(sessionTo(a.serving)) : Promise.reject(new Error('asleep'))
      },
    })
    const report = await fetchRound(b.ports)
    expect(dialled).toEqual([ALICE_LAPTOP.id, ALICE_PHONE.id])
    expect(report.asked).toBe(1)
    expect(report.accepted).toBe(1)

    const nobody = bob({ dial: () => Promise.reject(new Error('asleep')) })
    const none = await fetchRound(nobody.ports)
    expect(none.skipped).toEqual([{ person: ALICE.id, why: 'asleep', detail: 'asleep' }])
    expect(none.asked).toBe(0)
  })

  it('refuses a device that welcomes as somebody else, before asking for a page', async () => {
    /* A device on the wrong roster: every page would be `wrong-person`, and
       paying for them to learn that is paying twice. */
    const session = sessionTo(alice().serving, BOB.id)
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([{ person: ALICE.id, why: 'refused-hello' }])
    expect(session.calls).toEqual([CIRCLE_SERVICES.hello.name])
    expect(session.closed).toBe(1)
  })

  it('refuses a welcome this build cannot read', async () => {
    const session: Dialled = { call: () => Promise.resolve({ proto: 99 }), close: () => Promise.resolve() }
    const b = bob({ dial: () => Promise.resolve(session) })
    expect((await fetchRound(b.ports)).skipped).toEqual([{ person: ALICE.id, why: 'refused-hello' }])
  })

  it('counts an answer this build cannot read as a refusal and asks no further', async () => {
    let pagesCalls = 0
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.shelf.name || service === CIRCLE_SERVICES.lists.name) return Promise.resolve({ pages: [], more: false })
        pagesCalls += 1
        return Promise.resolve({ pages: 'not a list', more: false })
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.refusals).toBe(1)
    expect(pagesCalls).toBe(1)
    expect(b.keep).not.toHaveBeenCalled()
  })

  it('reports a person whose file will not read, with the reason, and still asks the others', async () => {
    /* One friend's unreadable file must not cost the round every other
       friend. Carol is asked first and fails; Alice is asked and served. */
    const a = alice()
    a.shareOne('x')
    const carol = keypair('carol')
    const carolPhone = keypair('carol-phone')
    const speaksFor = new Map<string, string>([[carolPhone.id, carol.id], [ALICE_LAPTOP.id, ALICE.id]])
    const b = bob({
      people: () => Promise.resolve([alicePerson({ person: carol.id, devices: [carolPhone.id] }), alicePerson()]),
      dialable: () => Promise.resolve(new Set([carolPhone.id, ALICE_LAPTOP.id])),
      dial: (device) => Promise.resolve(sessionTo(a.serving, speaksFor.get(device))),
    })
    const ports: FetchPorts = {
      ...b.ports,
      held: (bookId, person) =>
        person === carol.id ? Promise.reject(new Error('has no chain heads')) : b.ports.held(bookId, person),
    }

    const report = await fetchRound(ports)

    expect(report.skipped).toEqual([{ person: carol.id, why: 'failed', detail: 'has no chain heads' }])
    expect(report.asked).toBe(2)
    expect(report.accepted).toBe(1)
    expect(b.fromAlice().entries).toHaveLength(1)
  })

  it('reports a person whose relationship record would not read, and goes on to the next', async () => {
    const a = alice()
    a.shareOne('x')
    const carol = keypair('carol')
    const carolPhone = keypair('carol-phone')
    const speaksFor = new Map<string, string>([[carolPhone.id, carol.id], [ALICE_LAPTOP.id, ALICE.id]])
    const b = bob({
      people: () => Promise.resolve([alicePerson({ person: carol.id, devices: [carolPhone.id] }), alicePerson()]),
      dialable: () => Promise.resolve(new Set([carolPhone.id, ALICE_LAPTOP.id])),
      dial: (device) => Promise.resolve(sessionTo(a.serving, speaksFor.get(device))),
      relationship: (person) => (person === carol.id ? Promise.reject(new Error('record would not read')) : Promise.resolve({ state: 'admitted', epoch: 1, changedAt: hlcOf(1) })),
    })

    const report = await fetchRound(b.ports)

    /* The record is read inside the person's own boundary: the failure is
       theirs alone, and the round still asks the person after them. */
    expect(report.skipped).toEqual([{ person: carol.id, why: 'failed', detail: 'record would not read' }])
    expect(report.asked).toBe(1)
    expect(b.fromAlice().entries).toHaveLength(1)
  })
})

describe('the budget', () => {
  it('charges every answer against the person’s spend, and stops the person when it runs out', async () => {
    const a = alice()
    a.shareOne('a passage')
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)), budget: { perPeer: 10, perWork: 10, windowMs: 1_000 } })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([{ person: ALICE.id, why: 'over-budget' }])
    expect(report.accepted).toBe(0)
    expect(b.keep).not.toHaveBeenCalled()
  })

  it('persists what was charged through the ledger port', async () => {
    const a = alice()
    a.shareOne('a passage')
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)) })
    await fetchRound(b.ports)
    const spent = b.spend.get(ALICE.id)!
    expect(spent.total).toBeGreaterThan(0)
    expect(spent.byWork[MOBY.id]).toBe(spent.total)
    expect(spent.since).toBe(NOW)
  })
})

describe('the lists, after the shelf — WI-23.E1', () => {
  const by = (n: number) => ({ device: ALICE_LAPTOP.id, at: stamp(n, ALICE_LAPTOP.id) })
  /** Alice's serving side with two lists of her own. */
  function aliceWithLists() {
    const a = alice()
    let sea = createList(NOTHING_LISTED, 'Sea books', by(60))
    sea = placeOnList(sea, { pub: 'i1', work: { title: 'Moby-Dick', author: 'Melville', language: 'en' }, position: 1, note: 'start here' }, by(61))
    a.ownLists.set('aa11', sea)
    a.ownLists.set('bb22', createList(NOTHING_LISTED, 'Empty', by(62)))
    return a
  }

  it('lands each of Alice’s lists in its own file under her folder, folded, with its own cursor', async () => {
    const a = aliceWithLists()
    const session = sessionTo(a.serving)
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(session.calls).toEqual([CIRCLE_SERVICES.hello.name, CIRCLE_SERVICES.pages.name, CIRCLE_SERVICES.shelf.name, CIRCLE_SERVICES.lists.name])
    expect(b.listOfAlice('aa11').list).toMatchObject({ created: true, title: { value: 'Sea books' }, items: [{ pub: 'i1', position: 1, note: 'start here' }] })
    expect(b.listOfAlice('bb22').list.title?.value).toBe('Empty')
    expect(b.keepList).toHaveBeenCalledTimes(2)
    expect(report.accepted).toBe(2)
    expect(b.listOfAlice('aa11').cursor[ALICE_LAPTOP.id]).toBe(2)
    expect(b.listOfAlice('bb22').cursor[ALICE_LAPTOP.id]).toBe(1)
    /* Nothing about a list lands in the shelf file or a book's. */
    expect(b.shelfOfAlice().list).toEqual(NOTHING_SHARED.list)
    expect(b.fromAlice().list).toEqual(NOTHING_SHARED.list)

    /* A second round asks from each list's cursor and lands nothing. */
    const again = await fetchRound(b.ports)
    expect(again.accepted).toBe(0)
    expect(b.keepList).toHaveBeenCalledTimes(2)
  })

  it('discovers a list made after the first round, and follows a retitle on one it holds', async () => {
    const a = aliceWithLists()
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)) })
    await fetchRound(b.ports)
    a.ownLists.set('cc33', createList(NOTHING_LISTED, 'New', by(70)))
    a.ownLists.set('aa11', retitleList(a.ownLists.get('aa11')!, 'Whales', by(71)))
    const report = await fetchRound(b.ports)
    expect(report.accepted).toBe(2)
    expect(b.listOfAlice('cc33').list.title?.value).toBe('New')
    expect(b.listOfAlice('aa11').list.title?.value).toBe('Whales')
    expect(b.listOfAlice('aa11').list.items).toHaveLength(1)
  })

  it('refuses a page that is not a list’s, keeps nothing, and asks no further', async () => {
    const a = alice()
    const shelf = syncShelf(NOTHING_SHELVED, [{ bookId: 'b', title: 'Moby-Dick', author: 'A', languages: ['en'] }], ALICE_LAPTOP.id, stamp(50, ALICE_LAPTOP.id), () => 's1')
    const shelfPage = (await answerShelf({ since: {}, v: 3 }, { ...a.serving, shelf: () => Promise.resolve(shelf), sealShelf: () => Promise.resolve() }, true))!.pages
    expect(shelfPage).toHaveLength(1)
    let listsCalls = 0
    const session: Dialled = {
      call: async (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return welcome(body, ALICE.id)
        if (service === CIRCLE_SERVICES.lists.name) {
          listsCalls += 1
          return { pages: [...shelfPage, 'not json'], more: true }
        }
        if (service === CIRCLE_SERVICES.shelf.name) return { pages: [], more: false }
        return answerPages(body, a.serving)
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.refusals).toBe(2)
    expect(listsCalls).toBe(1)
    expect(b.keepList).not.toHaveBeenCalled()
  })

  it('does not ask a v2 peer for lists at all', async () => {
    const a = aliceWithLists()
    const calls: string[] = []
    const session: Dialled = {
      call: async (service, body) => {
        calls.push(service)
        if (service === CIRCLE_SERVICES.hello.name) return { proto: 1, pages: { min: 1, max: 2 }, person: ALICE.id, agreed: 2 }
        if (service === CIRCLE_SERVICES.shelf.name) return answerShelf(body, a.serving, true)
        if (service === CIRCLE_SERVICES.lists.name) throw new Error('a v2 peer has no such service')
        return answerPages(body, a.serving)
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([])
    expect(calls).not.toContain(CIRCLE_SERVICES.lists.name)
    expect(b.keepList).not.toHaveBeenCalled()
  })
})

describe('a shelf, or a list, disappears within one cadence of the switch going off — the Stage C exit', () => {
  const by = (n: number) => ({ device: ALICE_LAPTOP.id, at: stamp(n, ALICE_LAPTOP.id) })
  /** Alice's side with a shelf and a list, and a switch this side can turn. */
  function aliceShowing() {
    const a = alice()
    let shelf = syncShelf(NOTHING_SHELVED, [{ bookId: 'b', title: 'Moby-Dick', author: 'A', languages: ['en'] }], ALICE_LAPTOP.id, stamp(50, ALICE_LAPTOP.id), () => 's1')
    const serving: Serving = {
      ...a.serving,
      shelf: () => Promise.resolve(shelf),
      sealShelf: (held) => {
        shelf = held
        return Promise.resolve()
      },
    }
    a.ownLists.set('aa11', createList(NOTHING_LISTED, 'Sea books', by(60)))
    const state = { shown: true }
    const calls: string[] = []
    const session: Dialled = {
      call: (service, body) => {
        calls.push(service)
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.shelf.name) return answerShelf(body, serving, state.shown)
        if (service === CIRCLE_SERVICES.lists.name) return answerLists(body, serving, state.shown)
        return answerPages(body, serving)
      },
      close: () => Promise.resolve(),
    }
    return { a, state, calls, session }
  }

  it('keeps a shelf and a list that are still served, at the cost of one probe each when nothing is new', async () => {
    const { state, calls, session } = aliceShowing()
    const b = bob({ dial: () => Promise.resolve(session) })
    await fetchRound(b.ports)
    expect(b.shelfOfAlice().works).toHaveLength(1)
    expect(b.listOfAlice('aa11').list.created).toBe(true)
    calls.length = 0
    const again = await fetchRound(b.ports)
    expect(state.shown).toBe(true)
    expect(calls.filter((one) => one === CIRCLE_SERVICES.shelf.name)).toHaveLength(2)
    expect(calls.filter((one) => one === CIRCLE_SERVICES.lists.name)).toHaveLength(2)
    expect(again.calls).toBe(5)
    expect(b.keepShelf).toHaveBeenCalledTimes(1)
    expect(b.keepList).toHaveBeenCalledTimes(1)
    expect(b.shelfOfAlice().works).toHaveLength(1)
  })

  it('drops both once the switch is off, in the next round, and holds nothing of them after', async () => {
    const { state, session } = aliceShowing()
    const b = bob({ dial: () => Promise.resolve(session) })
    await fetchRound(b.ports)
    state.shown = false
    await fetchRound(b.ports)
    expect(b.shelfOfAlice()).toEqual(NOTHING_SHARED)
    expect(b.listOfAlice('aa11')).toEqual(NOTHING_SHARED)
    expect(b.keepShelf).toHaveBeenCalledTimes(2)
    expect(b.keepList).toHaveBeenCalledTimes(2)
    /* Off and empty: no probe for something not held, nothing written. */
    await fetchRound(b.ports)
    expect(b.keepShelf).toHaveBeenCalledTimes(2)
    expect(b.keepList).toHaveBeenCalledTimes(2)
    /* And back on: fetched from the start again, as a new chain would be. */
    state.shown = true
    await fetchRound(b.ports)
    expect(b.shelfOfAlice().works).toHaveLength(1)
    expect(b.listOfAlice('aa11').list.created).toBe(true)
  })

  it('does not drop a shelf on a probe the peer cannot answer', async () => {
    const { session, calls } = aliceShowing()
    const b = bob({ dial: () => Promise.resolve(session) })
    await fetchRound(b.ports)
    const refusing: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.shelf.name && calls.filter((one) => one === service).length > 1) return Promise.resolve({ pages: 'no', more: false })
        return session.call(service, body)
      },
      close: () => Promise.resolve(),
    }
    /* The second shelf call in this round is the probe; it comes back unreadable. */
    calls.length = 0
    calls.push(CIRCLE_SERVICES.shelf.name)
    const c = bob({ dial: () => Promise.resolve(refusing), heldShelf: () => Promise.resolve(b.shelfOfAlice()) })
    await fetchRound(c.ports)
    expect(c.keepShelf).not.toHaveBeenCalled()
    expect(b.shelfOfAlice().works).toHaveLength(1)
  })

  it('asks the DIALLED device for its last page, from one before its own cursor, and keeps the shelf only when that page comes back', async () => {
    const heads = { [ALICE_LAPTOP.id]: pageCrypto.hash('laptop-last'), [ALICE_PHONE.id]: pageCrypto.hash('phone-last') }
    /* The phone is furthest along, and comes FIRST, so "the last one seen"
       and "the furthest" are different answers. */
    const heldShelf: ForeignFile = {
      ...NOTHING_SHARED,
      v: 3,
      cursor: { [ALICE_PHONE.id]: 5, [ALICE_LAPTOP.id]: 2 },
      heads,
      works: [{ pub: 's1', work: { title: 'T', author: 'A', language: 'en' }, at: stamp(1, ALICE_LAPTOP.id) }],
    }
    const round = async (probeAnswer: unknown, shelf: ForeignFile = heldShelf) => {
      const asked: Record<string, unknown>[] = []
      const session: Dialled = {
        call: (service, body) => {
          if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
          if (service === CIRCLE_SERVICES.shelf.name) {
            asked.push(body as Record<string, unknown>)
            return Promise.resolve(asked.length === 1 ? { pages: [], more: false } : probeAnswer)
          }
          return Promise.resolve({ pages: [], more: false })
        },
        close: () => Promise.resolve(),
      }
      const b = bob({ dial: () => Promise.resolve(session), heldShelf: () => Promise.resolve(shelf) })
      const report = await fetchRound(b.ports)
      return { asked, b, report }
    }
    /* ⚠️ THE LAPTOP IS DIALLED, so the laptop's cursor steps back by one and
       the phone's stands — however far along the phone is. A device serves
       only its own stream: asked for the phone's last page, the laptop
       answered nothing, and the probe read the whole shelf as gone. */
    const kept = await round({ pages: ['laptop-last'], more: false })
    expect(kept.asked[1]).toEqual({ since: { [ALICE_PHONE.id]: 5, [ALICE_LAPTOP.id]: 1 }, v: 3 })
    expect(kept.b.keepShelf).not.toHaveBeenCalled()
    /* The book's log, the shelf, its probe, and the lists — asked once each. */
    expect(kept.report.calls).toBe(4)
    /* A page that is not the one held is not the shelf still served — by
       the LAPTOP: its stream goes, cursor, head and rows, and the phone's
       stands until the phone says so for itself. A row kept before devices
       were stamped can be nobody's but the device that served it, and goes
       with the first stream that goes. */
    const dropped = await round({ pages: ['some other page'], more: false })
    expect(dropped.b.keepShelf).toHaveBeenCalledWith(ALICE.id, expect.objectContaining({ cursor: { [ALICE_PHONE.id]: 5 }, heads: { [ALICE_PHONE.id]: heads[ALICE_PHONE.id] }, works: [] }), expect.any(Number))
    /* The phone's last page is not the laptop's: the laptop no longer serves what this side holds of it. */
    const theirs = await round({ pages: ['phone-last'], more: false })
    expect(theirs.b.keepShelf).toHaveBeenCalledWith(ALICE.id, expect.objectContaining({ cursor: { [ALICE_PHONE.id]: 5 } }), expect.any(Number))
    /* The last stream to go takes the file with it: the person-wide confirmation, one device at a time. */
    const last = await round({ pages: ['some other page'], more: false }, { ...heldShelf, cursor: { [ALICE_LAPTOP.id]: 2 }, heads: { [ALICE_LAPTOP.id]: heads[ALICE_LAPTOP.id]! } })
    expect(last.b.keepShelf).toHaveBeenCalledWith(ALICE.id, NOTHING_SHARED, expect.any(Number))
    /* An answer that will not read leaves the shelf alone, and fails nobody. */
    const unreadable = await round({ pages: 'no' })
    expect(unreadable.b.keepShelf).not.toHaveBeenCalled()
    expect(unreadable.report.skipped).toEqual([])
    /* A device this side holds no page from is not probed: it has nothing to re-send, and its silence says nothing. */
    const unheld = await round({ pages: ['phone-last'], more: false }, { ...heldShelf, cursor: { [ALICE_PHONE.id]: 5 } })
    expect(unheld.asked).toHaveLength(1)
    expect(unheld.b.keepShelf).not.toHaveBeenCalled()
    expect(unheld.report.calls).toBe(3)
  })

  it('does not probe a shelf with nothing fetched to ask for again, and keeps it', async () => {
    const heldShelf: ForeignFile = { ...NOTHING_SHARED, v: 3, works: [{ pub: 's1', work: { title: 'T', author: 'A', language: 'en' }, at: stamp(1, ALICE_LAPTOP.id) }] }
    let shelfCalls = 0
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.shelf.name) shelfCalls += 1
        return Promise.resolve({ pages: [], more: false })
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session), heldShelf: () => Promise.resolve(heldShelf) })
    const report = await fetchRound(b.ports)
    expect(shelfCalls).toBe(1)
    expect(b.keepShelf).not.toHaveBeenCalled()
    expect(report.skipped).toEqual([])
  })

  it('probes each list held under its own id, skips one never fetched, and drops the one no longer served', async () => {
    const heldList = (cursor: Record<string, number>, head: string): ForeignFile => ({
      ...NOTHING_SHARED,
      v: 3,
      cursor,
      heads: { [ALICE_LAPTOP.id]: pageCrypto.hash(head) },
      list: { created: true, deleted: false, items: [], removed: [] },
    })
    const asked: Record<string, unknown>[] = []
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.lists.name) {
          asked.push(body as Record<string, unknown>)
          const since = (body as { since: Record<string, unknown> }).since
          if ('aa11' in since && Object.keys(since).length === 1) return Promise.resolve({ pages: ['aa-last'], more: false })
          return Promise.resolve({ pages: [], more: false })
        }
        return Promise.resolve({ pages: [], more: false })
      },
      close: () => Promise.resolve(),
    }
    const b = bob({
      dial: () => Promise.resolve(session),
      heldLists: () =>
        Promise.resolve(
          new Map([
            ['aa11', heldList({ [ALICE_LAPTOP.id]: 3 }, 'aa-last')],
            ['bb22', heldList({ [ALICE_LAPTOP.id]: 1 }, 'bb-last')],
            ['cc33', heldList({}, 'never')],
          ]),
        ),
    })
    const report = await fetchRound(b.ports)
    /* The round's ask, then one probe per list with a cursor. */
    expect(asked).toHaveLength(3)
    expect(asked[1]).toEqual({ since: { aa11: { [ALICE_LAPTOP.id]: 2 } }, v: 3 })
    expect(asked[2]).toEqual({ since: { bb22: { [ALICE_LAPTOP.id]: 0 } }, v: 3 })
    expect(b.keepList).toHaveBeenCalledTimes(1)
    expect(b.keepList).toHaveBeenCalledWith(ALICE.id, 'bb22', NOTHING_SHARED, expect.any(Number))
    expect(report.calls).toBe(5)
  })

  it('counts a forged list page as a refusal and keeps nothing', async () => {
    const a = alice()
    a.ownLists.set('aa11', createList(NOTHING_LISTED, 'L', { device: ALICE_LAPTOP.id, at: stamp(60, ALICE_LAPTOP.id) }))
    const forging: Serving = {
      ...a.serving,
      publisher: (work) =>
        Promise.resolve({
          ...a.publisher(work),
          sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), ALICE_PHONE.secret))),
        }),
    }
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.lists.name) return answerLists(body, forging, true)
        return Promise.resolve({ pages: [], more: false })
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.refusals).toBe(1)
    expect(report.accepted).toBe(0)
    expect(b.keepList).not.toHaveBeenCalled()
  })

  it('stops following the shelf after the per-log cap, and picks up the rest next round', async () => {
    const a = alice()
    const books = Array.from({ length: MAX_ANSWERS_PER_LOG + 2 }, (_, i) => ({ bookId: `b${i}`, title: `Book ${i} ${'x'.repeat(700)}`, author: 'A', languages: ['en'] }))
    let shelf = syncShelf(NOTHING_SHELVED, books, ALICE_LAPTOP.id, stamp(50, ALICE_LAPTOP.id), () => `s${Math.random()}`)
    const serving: Serving = {
      ...a.serving,
      shelf: () => Promise.resolve(shelf),
      sealShelf: (held) => {
        shelf = held
        return Promise.resolve()
      },
    }
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.shelf.name) return answerShelf(body, serving, true, { maxPages: 1, budget: 1_200 })
        return Promise.resolve({ pages: [], more: false })
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const first = await fetchRound(b.ports)
    expect(first.accepted).toBe(MAX_ANSWERS_PER_LOG)
    expect(b.shelfOfAlice().works).toHaveLength(MAX_ANSWERS_PER_LOG)
    const second = await fetchRound(b.ports)
    expect(second.accepted).toBe(2)
    expect(b.shelfOfAlice().works).toHaveLength(MAX_ANSWERS_PER_LOG + 2)
  })

  describe('a record that moves to another epoch mid-round, at every point it is asked', () => {
    for (const reads of [1, 2, 3, 4, 5, 6, 7, 8]) {
      it(`writes nothing more once the record read for the ${reads}th time names a new epoch`, async () => {
        const { session } = aliceShowing()
        let asked = 0
        const keptAt: number[] = []
        const b = bob({
          dial: () => Promise.resolve(session),
          relationship: () => {
            asked += 1
            return Promise.resolve(asked <= reads ? { state: 'admitted', epoch: 1, changedAt: hlcOf(1) } : { state: 'admitted', epoch: 2, changedAt: hlcOf(2) })
          },
          keep: () => {
            keptAt.push(asked)
            return Promise.resolve()
          },
          keepShelf: () => {
            keptAt.push(asked)
            return Promise.resolve()
          },
          keepList: () => {
            keptAt.push(asked)
            return Promise.resolve()
          },
        })
        const report = await fetchRound(b.ports)
        expect(report.skipped.filter((one) => one.why === 'over-budget')).toEqual([])
        expect(keptAt.every((at) => at <= reads)).toBe(true)
      })
    }
  })

  describe('a probe the budget will not pay for', () => {
    it('ends the person’s round as over budget with the shelf and the list kept as they were, and records what the probe cost', async () => {
      const { state, session } = aliceShowing()
      const first = bob({ dial: () => Promise.resolve(session) })
      await fetchRound(first.ports)
      const used = first.spend.get(ALICE.id)!
      expect(used.total).toBeGreaterThan(0)
      /* A second reader with exactly that much budget: the pages fit, the probe does not. */
      const tight = bob({ dial: () => Promise.resolve(session), budget: { perPeer: used.total, perWork: used.total, windowMs: 60_000 } })
      await fetchRound(tight.ports)
      expect(tight.shelfOfAlice().works).toHaveLength(1)
      const before = tight.spend.get(ALICE.id)!.total
      const again = await fetchRound(tight.ports)
      expect(again.skipped).toEqual([{ person: ALICE.id, why: 'over-budget' }])
      expect(tight.shelfOfAlice().works).toHaveLength(1)
      expect(tight.listOfAlice('aa11').list.created).toBe(true)
      expect(tight.spend.get(ALICE.id)!.total).toBe(before)
      expect(state.shown).toBe(true)
    })

    it('records what a paid probe cost', async () => {
      const { session } = aliceShowing()
      const b = bob({ dial: () => Promise.resolve(session) })
      await fetchRound(b.ports)
      const before = b.spend.get(ALICE.id)!.total
      await fetchRound(b.ports)
      expect(b.spend.get(ALICE.id)!.total).toBeGreaterThan(before)
    })
  })

  describe('a shelf gone from the wire while the record stops admitting', () => {
    it('drops nothing on this disk once the record no longer admits', async () => {
      const { state, session } = aliceShowing()
      let asked = 0
      const b = bob({
        dial: () => Promise.resolve(session),
        relationship: () => {
          asked += 1
          /* Admitted through the first round; then the record goes blocked as the second round probes. */
          return Promise.resolve(asked <= 4 ? { state: 'admitted', epoch: 1, changedAt: hlcOf(1) } : { state: 'blocked', epoch: 1, changedAt: hlcOf(2) })
        },
      })
      await fetchRound(b.ports)
      expect(b.shelfOfAlice().works).toHaveLength(1)
      state.shown = false
      const keeps = b.keepShelf.mock.calls.length
      await fetchRound(b.ports)
      expect(b.keepShelf.mock.calls.length).toBe(keeps)
      expect(b.shelfOfAlice().works).toHaveLength(1)
    })
  })

  describe('a record that stops admitting mid-round, at every point it is asked', () => {
    for (const reads of [1, 2, 3, 4, 5, 6, 7, 8]) {
      it(`writes nothing more once the record read for the ${reads}th time no longer admits, and never calls it a budget`, async () => {
        const { session } = aliceShowing()
        let asked = 0
        const keptAt: number[] = []
        const b = bob({
          dial: () => Promise.resolve(session),
          relationship: () => {
            asked += 1
            return Promise.resolve(asked <= reads ? { state: 'admitted', epoch: 1, changedAt: hlcOf(1) } : { state: 'blocked', epoch: 1, changedAt: hlcOf(2) })
          },
          keep: () => {
            keptAt.push(asked)
            return Promise.resolve()
          },
          keepShelf: () => {
            keptAt.push(asked)
            return Promise.resolve()
          },
          keepList: () => {
            keptAt.push(asked)
            return Promise.resolve()
          },
        })
        const report = await fetchRound(b.ports)
        expect(report.skipped.filter((one) => one.why === 'over-budget')).toEqual([])
        expect(Number.isInteger(report.calls) && Number.isInteger(report.accepted) && Number.isInteger(report.refusals)).toBe(true)
        /* Every write happened while the record still admitted. */
        expect(keptAt.every((at) => at <= reads)).toBe(true)
      })
    }
  })

  describe('the roster and the count, as the round goes', () => {
    it('stops taking a person’s pages once their roster moved under the round, and counts only pages that were kept', async () => {
      const { session } = aliceShowing()
      let asked = 0
      const b = bob({
        dial: () => Promise.resolve(session),
        people: () => {
          asked += 1
          /* From the third look on, the laptop is revoked: the roster the round started with is gone. */
          return Promise.resolve([alicePerson(asked >= 3 ? { revoked: [ALICE_LAPTOP.id] } : {})])
        },
      })
      const report = await fetchRound(b.ports)
      expect(report.skipped.filter((one) => one.why === 'over-budget')).toEqual([])
      expect(b.keep.mock.calls.length + b.keepShelf.mock.calls.length + b.keepList.mock.calls.length).toBeLessThanOrEqual(1)
      /* A keep that fails leaves the report saying nothing was accepted for it. */
      /* This world shares a shelf and a list, no passages: the shelf's keep is the first write. */
      const c = bob({ dial: () => Promise.resolve(session), keepShelf: () => Promise.reject(new Error('disk full')) })
      const failed = await fetchRound(c.ports)
      expect(failed.accepted).toBe(0)
      expect(failed.skipped).toEqual([{ person: ALICE.id, why: 'failed', detail: 'disk full' }])
    })
  })
})

describe('every clause of the shelf and the list fetches — one row each', () => {
  const by = (n: number) => ({ device: ALICE_LAPTOP.id, at: stamp(n, ALICE_LAPTOP.id) })
  /** Alice with a shelf of two and a list of four, answering through the real exchange, with the list answer bounded. */
  function aliceWithBoth(bounds?: { maxPages: number; budget: number }, shelfMore = false) {
    const a = alice()
    let shelf = syncShelf(
      NOTHING_SHELVED,
      [
        { bookId: 'b1', title: 'Moby-Dick', author: 'A', languages: ['en'] },
        { bookId: 'b2', title: 'Dune', author: 'B', languages: ['en'] },
      ],
      ALICE_LAPTOP.id,
      stamp(50, ALICE_LAPTOP.id),
      () => `s${Math.random()}`,
    )
    const serving: Serving = {
      ...a.serving,
      shelf: () => Promise.resolve(shelf),
      sealShelf: (held) => {
        shelf = held
        return Promise.resolve()
      },
    }
    let sea = createList(NOTHING_LISTED, 'Sea books', by(60))
    /* A note long enough that a bounded answer carries one placement per page. */
    for (let i = 0; i < 4; i++) {
      sea = placeOnList(sea, { pub: `i${i}`, work: { title: `Book ${i}`, author: 'A', language: 'en' }, position: i + 1, note: 'x'.repeat(700) }, by(61 + i))
    }
    a.ownLists.set('aa11', sea)
    const asked: { service: string; body: Record<string, unknown> }[] = []
    let shelfAnswers = 0
    const session: Dialled = {
      call: async (service, body) => {
        asked.push({ service, body: body as Record<string, unknown> })
        if (service === CIRCLE_SERVICES.hello.name) return welcome(body, ALICE.id)
        if (service === CIRCLE_SERVICES.shelf.name) {
          const answer = await answerShelf(body, serving, true)
          /* A publisher saying there is more, once: the second answer is the real, empty one. */
          return shelfMore && shelfAnswers++ === 0 ? { pages: answer!.pages, more: true } : answer
        }
        if (service === CIRCLE_SERVICES.lists.name) return bounds ? answerLists(body, serving, true, bounds) : answerLists(body, serving, true)
        return answerPages(body, serving)
      },
      close: () => Promise.resolve(),
    }
    const shelfBytes = async () => (await answerShelf({ since: {}, v: 3 }, serving, true))!.pages.reduce((sum, page) => sum + page.length, 0)
    return { a, serving, asked, session, shelfBytes, services: () => asked.map((one) => one.service) }
  }

  it('charges the shelf against the budget and stops the person, asking for no lists after', async () => {
    const { session, services } = aliceWithBoth()
    const b = bob({ dial: () => Promise.resolve(session), budget: { perPeer: 50, perWork: 50, windowMs: 1_000 } })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([{ person: ALICE.id, why: 'over-budget' }])
    expect(services()).toEqual([CIRCLE_SERVICES.hello.name, CIRCLE_SERVICES.pages.name, CIRCLE_SERVICES.shelf.name])
    expect(b.keepShelf).not.toHaveBeenCalled()
    expect(b.spent).not.toHaveBeenCalled()
  })

  it('charges the lists against what the shelf left, records the spend, and stops the person', async () => {
    const { session, shelfBytes } = aliceWithBoth()
    const room = (await shelfBytes()) + 10
    const b = bob({ dial: () => Promise.resolve(session), budget: { perPeer: 1_000_000, perWork: room, windowMs: 1_000 } })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([{ person: ALICE.id, why: 'over-budget' }])
    expect(b.shelfOfAlice().works).toHaveLength(2)
    expect(b.keepList).not.toHaveBeenCalled()
    /* The shelf's spend was recorded; the refused lists' was not. */
    expect(b.spent).toHaveBeenCalledTimes(1)
    /* With room for both, both land and both spends are recorded. */
    const c = bob({ dial: () => Promise.resolve(session) })
    await fetchRound(c.ports)
    expect(c.spent).toHaveBeenCalledTimes(2)
    expect(c.listOfAlice('aa11').list.items).toHaveLength(4)
  })

  it('counts an unreadable shelf answer and an unreadable lists answer as one refusal each, and asks each no further', async () => {
    const shelfCalls: string[] = []
    const session: Dialled = {
      call: (service, body) => {
        shelfCalls.push(service)
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.pages.name) return Promise.resolve({ pages: [], more: false })
        return Promise.resolve({ pages: 'no', more: true })
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.refusals).toBe(2)
    expect(shelfCalls.filter((one) => one === CIRCLE_SERVICES.shelf.name)).toHaveLength(1)
    expect(shelfCalls.filter((one) => one === CIRCLE_SERVICES.lists.name)).toHaveLength(1)
    expect(report.calls).toBe(3)
  })

  it('asks the shelf and each list from the start of a chain it has not fetched', async () => {
    const { session, asked } = aliceWithBoth()
    const onV2: ForeignFile = { ...NOTHING_SHARED, cursor: { [ALICE_LAPTOP.id]: 7 }, heads: { [ALICE_LAPTOP.id]: 'h' }, v: 2 }
    const b = bob({
      dial: () => Promise.resolve(session),
      heldShelf: () => Promise.resolve(onV2),
      heldLists: () => Promise.resolve(new Map([['aa11', onV2]])),
    })
    await fetchRound(b.ports)
    const shelfAsk = asked.find((one) => one.service === CIRCLE_SERVICES.shelf.name)!.body
    expect(shelfAsk['since']).toEqual({})
    const listsAsk = asked.find((one) => one.service === CIRCLE_SERVICES.lists.name)!.body
    expect(listsAsk['since']).toEqual({ aa11: {} })
    /* And on the chain they belong to, the cursors are used. */
    const onV3 = { ...onV2, v: 3 }
    asked.length = 0
    await fetchRound(bob({ dial: () => Promise.resolve(session), heldShelf: () => Promise.resolve(onV3), heldLists: () => Promise.resolve(new Map([['aa11', onV3]])) }).ports)
    expect(asked.find((one) => one.service === CIRCLE_SERVICES.shelf.name)!.body['since']).toEqual({ [ALICE_LAPTOP.id]: 7 })
    expect(asked.find((one) => one.service === CIRCLE_SERVICES.lists.name)!.body['since']).toEqual({ aa11: { [ALICE_LAPTOP.id]: 7 } })
  })

  it('follows `more` on the shelf, and on a list from the cursor the last answer left, keeping each as it lands', async () => {
    const { session, asked } = aliceWithBoth({ maxPages: 1, budget: 1_200 }, true)
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([])
    expect(asked.filter((one) => one.service === CIRCLE_SERVICES.shelf.name)).toHaveLength(2)
    const listAsks = asked.filter((one) => one.service === CIRCLE_SERVICES.lists.name).map((one) => (one.body['since'] as Record<string, Record<string, number>>)['aa11'])
    expect(listAsks.length).toBeGreaterThan(2)
    expect(listAsks[0]).toBeUndefined()
    /* Each later ask starts where the answer before it left off. */
    const cursors = listAsks.slice(1).map((one) => one![ALICE_LAPTOP.id]!)
    expect(cursors[0]).toBeGreaterThan(0)
    expect(cursors.every((cursor, i) => i === 0 || cursor > cursors[i - 1]!)).toBe(true)
    /* Every answer carried a page, the last one saying there was no more: one keep per ask. */
    expect(b.keepList.mock.calls.length).toBe(listAsks.length)
    expect(b.listOfAlice('aa11').list.items).toHaveLength(4)
    expect(b.listOfAlice('aa11').list.title?.value).toBe('Sea books')
  })

  it('takes two pages of one list from one answer', async () => {
    const { session, asked } = aliceWithBoth({ maxPages: 2, budget: 1_200 })
    const b = bob({ dial: () => Promise.resolve(session) })
    await fetchRound(b.ports)
    expect(asked.filter((one) => one.service === CIRCLE_SERVICES.lists.name).length).toBeLessThan(5)
    expect(b.listOfAlice('aa11').list.items).toHaveLength(4)
  })

  it('stops following a list after the per-log cap, and picks up the rest next round', async () => {
    const a = alice()
    let long = createList(NOTHING_LISTED, 'Long', by(60))
    for (let i = 0; i < MAX_ANSWERS_PER_LOG + 2; i++) {
      long = placeOnList(long, { pub: `i${i}`, work: { title: `Book ${i}`, author: 'A', language: 'en' }, position: i + 1, note: 'x'.repeat(700) }, by(61 + i))
    }
    a.ownLists.set('aa11', long)
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.shelf.name) return Promise.resolve({ pages: [], more: false })
        if (service === CIRCLE_SERVICES.lists.name) return answerLists(body, a.serving, true, { maxPages: 1, budget: 1_200 })
        return answerPages(body, a.serving)
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const first = await fetchRound(b.ports)
    expect(first.accepted).toBe(MAX_ANSWERS_PER_LOG)
    const second = await fetchRound(b.ports)
    expect(second.accepted).toBeGreaterThan(0)
    expect(b.listOfAlice('aa11').list.items).toHaveLength(MAX_ANSWERS_PER_LOG + 2)
  })

  it('counts a forged shelf page as a refusal, keeps nothing, and asks no further', async () => {
    const { a, serving } = aliceWithBoth()
    const forging: Serving = {
      ...serving,
      publisher: (work) =>
        Promise.resolve({
          ...a.publisher(work),
          sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), ALICE_PHONE.secret))),
        }),
    }
    let shelfCalls = 0
    const session: Dialled = {
      call: async (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return welcome(body, ALICE.id)
        if (service === CIRCLE_SERVICES.lists.name) return { pages: [], more: false }
        if (service === CIRCLE_SERVICES.shelf.name) {
          shelfCalls += 1
          const answer = await answerShelf(body, forging, true)
          return { pages: answer!.pages, more: true }
        }
        return answerPages(body, a.serving)
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.refusals).toBe(1)
    expect(report.accepted).toBe(0)
    expect(shelfCalls).toBe(1)
    expect(b.keepShelf).not.toHaveBeenCalled()
  })

  it('asks a v2 peer for its shelf, and not for lists', async () => {
    const { serving } = aliceWithBoth()
    const calls: string[] = []
    const session: Dialled = {
      call: (service, body) => {
        calls.push(service)
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve({ proto: 1, pages: { min: 1, max: 2 }, person: ALICE.id, agreed: 2 })
        if (service === CIRCLE_SERVICES.shelf.name) return answerShelf(body, serving, true)
        if (service === CIRCLE_SERVICES.lists.name) throw new Error('a v2 peer has no such service')
        return answerPages(body, serving)
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    await fetchRound(b.ports)
    expect(calls).toContain(CIRCLE_SERVICES.shelf.name)
    expect(calls).not.toContain(CIRCLE_SERVICES.lists.name)
    expect(b.shelfOfAlice().works).toHaveLength(2)
  })

  it('refuses every page in a lists answer that names no list, one refusal each', async () => {
    const strays = ['[]', 'null', '{}', '{"work":null}', '{"work":[]}', '{"work":"x"}', '{"work":{"ids":"x"}}', '{"work":{"ids":[1]}}', '{"work":{"ids":["a","b"]}}', '{"work":{"ids":["paper.circle.list:"]}}', '{"work":{"ids":["other"]}}']
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.lists.name) return Promise.resolve({ pages: strays, more: false })
        return Promise.resolve({ pages: [], more: false })
      },
      close: () => Promise.resolve(),
    }
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.refusals).toBe(strays.length)
    expect(b.keepList).not.toHaveBeenCalled()
  })
})

describe('a relationship record that goes backwards during a round', () => {
  it('ends the person’s round with nothing more written — a purge under way reads as the undecided default', async () => {
    const a = alice()
    a.shareOne('x')
    a.shareOne('y')
    let reads = 0
    const dial = () => Promise.resolve(sessionTo(a.serving))
    const b = bob({
      dial,
      relationship: () => {
        reads += 1
        /* The record this round started with, then — the folder purged — the default stamped at the beginning of time. */
        return Promise.resolve(reads === 1 ? { state: 'admitted', epoch: 1, changedAt: hlcOf(50) } : { state: 'admitted', epoch: 1, changedAt: hlcOf(0) })
      },
    })
    const report = await fetchRound(b.ports)
    expect(report.asked).toBe(1)
    expect(b.fromAlice().entries, 'a purged person’s files were written again by the round in flight').toHaveLength(0)
  })
})

describe('the round, held to the letter — what a moved roster, a spent budget and a failed close do', () => {
  const ADMITTED = { state: 'admitted', epoch: 1, changedAt: hlcOf(1) } as const
  const BLOCKED = { state: 'blocked', epoch: 1, changedAt: hlcOf(2) } as const

  function aliceWithShelfAndList(withList = true) {
    const a = alice()
    let shelf = syncShelf(NOTHING_SHELVED, [{ bookId: 'b', title: 'Moby-Dick', author: 'A', languages: ['en'] }], ALICE_LAPTOP.id, stamp(50, ALICE_LAPTOP.id), () => 'shelf-pub')
    /* The seals PERSIST, as a real store's do: otherwise every round re-cuts and re-serves the same page and nothing is ever probed. */
    const serving: Serving = {
      ...a.serving,
      shelf: () => Promise.resolve(shelf),
      sealShelf: (held) => {
        shelf = held
        return Promise.resolve()
      },
    }
    if (withList) a.ownLists.set('aa11', createList(NOTHING_LISTED, 'Sea books', { device: ALICE_LAPTOP.id, at: stamp(60, ALICE_LAPTOP.id) }))
    return { a, serving }
  }

  it('warns, and goes on, when a session will not close', async () => {
    const a = alice()
    a.shareOne('Call me Ishmael')
    const session = { ...sessionTo(a.serving), close: () => Promise.reject(new Error('socket gone')) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = bob({ dial: () => Promise.resolve(session) })
    const report = await fetchRound(b.ports)
    expect(report.accepted).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not close the session'), expect.any(Error))
    warn.mockRestore()
  })

  it('keeps nothing from a person who left the roster while the round ran', async () => {
    const a = alice()
    a.shareOne('Call me Ishmael')
    let asked = 0
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)), people: () => Promise.resolve(asked++ === 0 ? [alicePerson()] : []) })
    const report = await fetchRound(b.ports)
    expect(b.keep).not.toHaveBeenCalled()
    expect(report.accepted).toBe(0)
    /* And SAID: a person whose round ended short is reported, not left to
       read as one with nothing new. */
    expect(report.skipped).toEqual([{ person: ALICE.id, why: 'not-admitted' }])
  })

  it.each([
    ['a roster epoch that moved', alicePerson({ roster: { epoch: 1 } })],
    ['a device that left', alicePerson({ devices: [ALICE_LAPTOP.id] })],
    ['a device replaced by another', alicePerson({ devices: [ALICE_LAPTOP.id, BOB.id] })],
    ['a revocation', alicePerson({ revoked: [ALICE_PHONE.id] })],
  ])('keeps nothing from a person whose roster moved under the round — %s', async (_what, moved) => {
    const a = alice()
    a.shareOne('Call me Ishmael')
    let asked = 0
    /* Two devices to start from, so a device leaving is a move. */
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)), people: () => Promise.resolve([asked++ === 0 ? alicePerson({ devices: [ALICE_LAPTOP.id, ALICE_PHONE.id] }) : moved]) })
    await fetchRound(b.ports)
    expect(b.keep).not.toHaveBeenCalled()
  })

  it('keeps what it took when the roster is read again unchanged', async () => {
    const a = alice()
    a.shareOne('Call me Ishmael')
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)), people: () => Promise.resolve([alicePerson()]) })
    expect((await fetchRound(b.ports)).accepted).toBe(1)
  })

  /* The relationship is read once more between the answer and the keep. A block
     that lands exactly there — after the answer was charged, before the pages
     were taken — ends the person's round with nothing kept, nothing more asked
     of them, the person reported as no longer admitted, and the calls still
     counted. It used to end only that LOG, and the round went on to the shelf
     and the lists of a person it had just been told not to read. */
  const flippingAfter = (session: ReturnType<typeof sessionTo>, service: string, onCall: number) => {
    let after = 0
    return () => {
      if (session.calls.includes(service)) after += 1
      return Promise.resolve(after >= onCall ? BLOCKED : ADMITTED)
    }
  }

  it('takes no passage once blocked between the answer and the keep', async () => {
    const a = alice()
    a.shareOne('Call me Ishmael')
    for (const onCall of [1, 2]) {
      const session = sessionTo(a.serving)
      const b = bob({ dial: () => Promise.resolve(session), relationship: flippingAfter(session, CIRCLE_SERVICES.pages.name, onCall) })
      const report = await fetchRound(b.ports)
      expect(b.keep).not.toHaveBeenCalled()
      expect(report.accepted).toBe(0)
      expect(report.skipped).toEqual([{ person: ALICE.id, why: 'not-admitted' }])
      expect(report.calls).toBeGreaterThanOrEqual(1)
      /* Nothing more asked of them: the shelf and the lists were not. */
      expect(session.calls).not.toContain(CIRCLE_SERVICES.shelf.name)
      expect(session.calls).not.toContain(CIRCLE_SERVICES.lists.name)
    }
  })

  it('takes no shelf once blocked between the answer and the keep', async () => {
    const { serving } = aliceWithShelfAndList()
    for (const onCall of [1, 2]) {
      const session = sessionTo(serving)
      const b = bob({ dial: () => Promise.resolve(session), relationship: flippingAfter(session, CIRCLE_SERVICES.shelf.name, onCall) })
      const report = await fetchRound(b.ports)
      expect(b.keepShelf).not.toHaveBeenCalled()
      expect(report.skipped).toEqual([{ person: ALICE.id, why: 'not-admitted' }])
      expect(session.calls).not.toContain(CIRCLE_SERVICES.lists.name)
      expect(Number.isFinite(report.calls)).toBe(true)
    }
  })

  it('takes no list once blocked between the answer and the keep', async () => {
    const { serving } = aliceWithShelfAndList()
    for (const onCall of [1, 2]) {
      const session = sessionTo(serving)
      const b = bob({ dial: () => Promise.resolve(session), relationship: flippingAfter(session, CIRCLE_SERVICES.lists.name, onCall) })
      const report = await fetchRound(b.ports)
      expect(b.keepList).not.toHaveBeenCalled()
      expect(report.skipped).toEqual([{ person: ALICE.id, why: 'not-admitted' }])
      expect(Number.isFinite(report.calls)).toBe(true)
    }
  })

  it('skips a person as over budget when the shelf answer cannot be paid for, and keeps no shelf', async () => {
    const { serving } = aliceWithShelfAndList()
    const b = bob({ dial: () => Promise.resolve(sessionTo(serving)), charge: () => false })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([{ person: ALICE.id, why: 'over-budget' }])
    expect(b.keepShelf).not.toHaveBeenCalled()
    expect(b.keepList).not.toHaveBeenCalled()
  })

  it('pays for a probe of a held shelf and of a held list, and is skipped when the shelf’s probe cannot be paid', async () => {
    const { serving } = aliceWithShelfAndList()
    const b = bob({ dial: () => Promise.resolve(sessionTo(serving)) })
    await fetchRound(b.ports)
    expect(b.shelfOfAlice().works).toHaveLength(1)
    const paid = b.spent.mock.calls.length
    /* A second round: nothing new, so the shelf and the list are probed — and each probe is paid for. */
    const again = await fetchRound(b.ports)
    expect(again.skipped).toEqual([])
    expect(b.spent.mock.calls.length).toBeGreaterThanOrEqual(paid + 2)
    expect(b.shelfOfAlice().works).toHaveLength(1)
  })

  it('skips a person whose shelf probe cannot be paid for, and keeps the shelf held', async () => {
    /* A shelf and NO list, so the only probe of the round is the shelf's: a
       refusal here is the shelf probe's, not another log's. */
    const { serving } = aliceWithShelfAndList(false)
    const b = bob({ dial: () => Promise.resolve(sessionTo(serving)) })
    await fetchRound(b.ports)
    expect(b.shelfOfAlice().works).toHaveLength(1)
    expect((await fetchRound(b.ports)).skipped).toEqual([])
    /* The shelf's own budget spent; the books' untouched. */
    b.spend.set(ALICE.id, { since: NOW, total: 0, byWork: { shelf: 16 * 1024 * 1024 } })
    const broke = await fetchRound(b.ports)
    expect(broke.skipped).toEqual([{ person: ALICE.id, why: 'over-budget' }])
    expect(b.shelfOfAlice().works).toHaveLength(1)
  })

  it('keeps a shelf, or a list, that went away only while its person is still admitted', async () => {
    for (const service of [CIRCLE_SERVICES.shelf.name, CIRCLE_SERVICES.lists.name]) {
      const { serving } = aliceWithShelfAndList()
      const state = { shown: true }
      const calls: string[] = []
      const session: Dialled = {
        call: (name, body) => {
          calls.push(name)
          if (name === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
          if (name === CIRCLE_SERVICES.shelf.name) return answerShelf(body, serving, state.shown)
          if (name === CIRCLE_SERVICES.lists.name) return answerLists(body, serving, state.shown)
          return answerPages(body, serving)
        },
        close: () => Promise.resolve(),
      }
      const b = bob({ dial: () => Promise.resolve(session) })
      await fetchRound(b.ports)
      expect(b.shelfOfAlice().works).toHaveLength(1)
      /* The switch goes off, and the relationship ends the moment the probe says so. */
      state.shown = false
      let probes = 0
      const c = bob({
        dial: () => Promise.resolve(session),
        heldShelf: b.ports.heldShelf,
        heldLists: b.ports.heldLists,
        relationship: () => {
          if (calls.filter((one) => one === service).length >= 2) probes += 1
          return Promise.resolve(probes >= 1 ? BLOCKED : ADMITTED)
        },
      })
      await fetchRound(c.ports)
      /* The one that went away under a person who was blocked at the probe is not written; the other, probed while still admitted, is. */
      expect(service === CIRCLE_SERVICES.shelf.name ? c.keepShelf : c.keepList).not.toHaveBeenCalled()
    }
  })

  it('pays for a probe of a held list, and is skipped when it cannot', async () => {
    const { a, serving } = aliceWithShelfAndList()
    const held = a.ownLists.get('aa11')!
    a.ownLists.set('aa11', placeOnList(held, { pub: 'i1', work: { title: 'Moby-Dick', author: 'A', language: 'en' }, position: 1, note: '' }, { device: ALICE_LAPTOP.id, at: stamp(61, ALICE_LAPTOP.id) }))
    const b = bob({ dial: () => Promise.resolve(sessionTo(serving)) })
    await fetchRound(b.ports)
    expect(Object.keys(b.listOfAlice('aa11').cursor)).toHaveLength(1)
    /* The shelf's probe is paid first each round and exhausts the budget as it is recorded; the list's probe is the one refused. */
    let charged = 0
    const c = bob({ dial: () => Promise.resolve(sessionTo(serving)), charge: () => charged++ < 1, heldShelf: b.ports.heldShelf, heldLists: b.ports.heldLists })
    const broke = await fetchRound(c.ports)
    expect(broke.skipped).toEqual([{ person: ALICE.id, why: 'over-budget' }])
    expect(c.keepList).not.toHaveBeenCalled()
  })
})

describe('every device of a person is asked — a device serves only its own stream', () => {
  it('takes the phone’s passages as well as the laptop’s, from one hello each', async () => {
    /* Their stores have met — the laptop's file holds the phone's row — but
       the laptop serves only its own stream, so dialling the first device
       that answered kept the phone's passages from ever arriving. */
    const a = alice()
    a.shareOne('from the laptop')
    a.files.set(MOBY.id, share(a.files.get(MOBY.id)!, { markId: 'm-phone', passage: passage('from the phone'), device: ALICE_PHONE.id }, 'pub-phone', stamp(9, ALICE_PHONE.id)).held)
    const phoneServing: Serving = {
      ...a.serving,
      publisher: (work) =>
        Promise.resolve({
          ...a.publisher(work),
          device: ALICE_PHONE.id,
          delegation: delegationFor(ALICE, ALICE_PHONE.id),
          sign: (message: string) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), ALICE_PHONE.secret))),
        }),
    }
    const dialled: string[] = []
    const b = bob({
      people: () => Promise.resolve([alicePerson({ devices: [ALICE_LAPTOP.id, ALICE_PHONE.id] })]),
      dial: (device) => {
        dialled.push(device)
        return Promise.resolve(sessionTo(device === ALICE_PHONE.id ? phoneServing : a.serving))
      },
    })
    const report = await fetchRound(b.ports)
    expect(dialled).toEqual([ALICE_LAPTOP.id, ALICE_PHONE.id])
    expect(report.asked).toBe(1)
    expect(report.accepted).toBe(2)
    expect(report.skipped).toEqual([])
    expect(b.fromAlice().entries.map((one) => one.passage.quote).sort()).toEqual(['from the laptop', 'from the phone'])
    expect(Object.keys(b.fromAlice().cursor).sort()).toEqual([ALICE_LAPTOP.id, ALICE_PHONE.id].sort())
  })

  it('ends the person at the first device that spends their budget, and asks no other', async () => {
    const a = alice()
    a.shareOne('x')
    const dialled: string[] = []
    const b = bob({
      people: () => Promise.resolve([alicePerson({ devices: [ALICE_LAPTOP.id, ALICE_PHONE.id] })]),
      dial: (device) => {
        dialled.push(device)
        return Promise.resolve(sessionTo(a.serving))
      },
      charge: () => false,
    })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([{ person: ALICE.id, why: 'over-budget' }])
    expect(dialled).toEqual([ALICE_LAPTOP.id])
  })

  it('reports a person refused by every device as refused, and one refused by only some as served', async () => {
    const a = alice()
    a.shareOne('x')
    const b = bob({
      people: () => Promise.resolve([alicePerson({ devices: [ALICE_LAPTOP.id, ALICE_PHONE.id] })]),
      dial: (device) => Promise.resolve(sessionTo(a.serving, device === ALICE_PHONE.id ? BOB.id : ALICE.id)),
    })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([])
    expect(report.accepted).toBe(1)
    const both = bob({
      people: () => Promise.resolve([alicePerson({ devices: [ALICE_LAPTOP.id, ALICE_PHONE.id] })]),
      dial: () => Promise.resolve(sessionTo(a.serving, BOB.id)),
    })
    expect((await fetchRound(both.ports)).skipped).toEqual([{ person: ALICE.id, why: 'refused-hello' }])
  })
})

describe('a lists request names at most what the peer’s parser reads', () => {
  it('names the first MAX_LISTS_PER_REQUEST held lists by id, and asks the rest from their start', async () => {
    /* Sixty-five held lists made every lists request invalid, and list
       synchronisation stopped for good. */
    const asked: Record<string, unknown>[] = []
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.lists.name) asked.push(body as Record<string, unknown>)
        return Promise.resolve({ pages: [], more: false })
      },
      close: () => Promise.resolve(),
    }
    const held = new Map(Array.from({ length: MAX_LISTS_PER_REQUEST + 1 }, (_, i) => [i.toString(16).padStart(4, '0'), { ...NOTHING_SHARED, v: 3 }] as const))
    const b = bob({ dial: () => Promise.resolve(session), heldLists: () => Promise.resolve(held) })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([])
    const since = asked[0]!['since'] as Record<string, unknown>
    expect(Object.keys(since)).toHaveLength(MAX_LISTS_PER_REQUEST)
    expect(Object.keys(since)).toEqual([...listWindowOf([...held.keys()], NOW)])
    /* And the request is one the peer reads. */
    expect(parseListsRequest(asked[0])).not.toBeNull()
  })

  it('is served the lists it named before a long list it did not — the window cannot be starved by what is outside it', async () => {
    /* ⚠️ END TO END. A held list outside the window is served from its
       beginning and its pages are put aside; served FIRST, one long such
       list filled every answer of every round, and the lists the window
       named were never reached. The peer serves the named lists first. */
    const by = (n: number) => ({ device: ALICE_LAPTOP.id, at: stamp(n, ALICE_LAPTOP.id) })
    const listOf = (seed: number, items: number) => {
      let held = createList(NOTHING_LISTED, `List ${seed}`, by(seed * 1000))
      for (let i = 1; i <= items; i++) held = placeOnList(held, { pub: `i${seed}-${i}`, work: { title: `T${i}`, author: 'A', language: 'en' }, position: i, note: '' }, by(seed * 1000 + i))
      return held
    }
    const ids = Array.from({ length: MAX_LISTS_PER_REQUEST + 2 }, (_, i) => i.toString(16).padStart(4, '0'))
    const window = new Set(listWindowOf(ids, NOW))
    const long = ids.find((id) => !window.has(id))!
    const a = alice()
    /* The long list FIRST in Alice's own order, and outside Bob's window. */
    a.ownLists.set(long, listOf(1, 80))
    ids.filter((id) => id !== long).forEach((id, i) => a.ownLists.set(id, listOf(i + 2, 1)))
    /* A few pages per answer, so the long list alone would fill one. */
    const session: Dialled = {
      call: (service, body) => {
        if (service === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE.id))
        if (service === CIRCLE_SERVICES.pages.name) return answerPages(body, a.serving)
        if (service === CIRCLE_SERVICES.shelf.name) return answerShelf(body, a.serving, true)
        if (service === CIRCLE_SERVICES.lists.name) return answerLists(body, a.serving, true, { maxPages: 4, budget: 200 })
        return Promise.reject(new Error(`no such service ${service}`))
      },
      close: () => Promise.resolve(),
    }
    const held = new Map(ids.map((id) => [id, { ...NOTHING_SHARED, v: 3 }] as const))
    const b = bob({ dial: () => Promise.resolve(session), heldLists: () => Promise.resolve(held) })
    const report = await fetchRound(b.ports)
    expect(report.skipped).toEqual([])
    const kept = b.keepList.mock.calls.map((call) => call[1] as string)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.every((id) => window.has(id))).toBe(true)
    expect(kept).not.toContain(long)
  })

  it('moves the window with the clock, so every held list is named within a few rounds', () => {
    const ids = Array.from({ length: MAX_LISTS_PER_REQUEST + 10 }, (_, i) => i.toString(16).padStart(4, '0'))
    const one = listWindowOf(ids, NOW)
    const next = listWindowOf(ids, NOW + LIST_WINDOW_ROTATES_MS)
    expect(one).toHaveLength(MAX_LISTS_PER_REQUEST)
    expect(one).not.toEqual(next)
    const named = new Set([...one, ...next])
    expect(named.size).toBe(ids.length)
    /* Within the bound, every list, every time. */
    expect(listWindowOf(ids.slice(0, MAX_LISTS_PER_REQUEST), NOW)).toEqual([...ids.slice(0, MAX_LISTS_PER_REQUEST)].sort())
  })
})

/* ONE BUDGET FOR THE ROUND AND THE JACKETS — WI-23.C5. The two production
   callers, over the one production ledger, interleaved across their awaits:
   the `spend`/`spent` pair let a round holding its own snapshot write back
   over a jacket's charge, and the two together spent past the budget. */
describe('the round and a jacket over one ledger', () => {
  /* Over the chunk boundary, under the jacket cap. */
  /* SMALL ON PURPOSE — see the note on `CHUNK` in `covers.test.ts`. A real
     512 KiB jacket is hashed and base64'd in JavaScript here too, and under
     coverage instrumentation it outran this file's default fifteen seconds.
     The fetcher follows `offset`/`more`, so the fake server picks the size. */
  const JACKET_CHUNK = 2048
  const jacket = new Uint8Array(JACKET_CHUNK + 100).map((_, i) => (i * 7) % 256)
  const digest = bytesToHex(blake3(jacket))
  /** A device serving the jacket chunk by chunk, as `answerCover` does. */
  const jacketSession = () => ({
    call: (service: string, body: unknown) => {
      if (service !== CIRCLE_SERVICES.cover.name) return Promise.reject(new Error(`no such service ${service}`))
      const asked = body as { pub: string; offset: number }
      const slice = jacket.subarray(asked.offset, Math.min(jacket.length, asked.offset + JACKET_CHUNK))
      return Promise.resolve({ offset: asked.offset, size: jacket.length, bytes: base64Of(slice), more: asked.offset + slice.length < jacket.length })
    },
    close: () => Promise.resolve(),
  })
  const fetcherOver = (ledger: ReturnType<typeof createSpendLedger>, budget?: Parameters<typeof ledger.charge>[4]) =>
    createCoverFetcher({
      fs: fakeFs() as never,
      dial: () => Promise.resolve(jacketSession()),
      charge: (person, bytes) => ledger.charge(person, 'cover', bytes, NOW, budget),
      now: () => NOW,
      capBytes: () => 64 * 1024 * 1024,
    })

  it('charges pages and a jacket to the one ledger, interleaved, and neither forgets the other’s charge', async () => {
    const ledger = createSpendLedger()
    const a = alice()
    a.shareOne('Call me Ishmael')
    a.shareOne('the whiteness of the whale')
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)), charge: (person, key, bytes, now, budget) => ledger.charge(person, key, bytes, now, budget) })
    const [report, bytes] = await Promise.all([fetchRound(b.ports), fetcherOver(ledger).ensure(ALICE.id, ALICE_LAPTOP.id, 'pub-jacket', digest)])
    expect(report.accepted).toBe(1)
    expect(bytes).toEqual(jacket)
    const spent = ledger.spend(ALICE.id)
    expect(spent.byWork['cover']).toBe(jacket.length)
    expect(spent.byWork[MOBY.id]).toBeGreaterThan(0)
    expect(spent.total).toBe(spent.byWork['cover']! + spent.byWork[MOBY.id]!)
  })

  it('holds the two to ONE budget: what the jacket spent, the round cannot spend again', async () => {
    const ledger = createSpendLedger()
    const budget = { perPeer: jacket.length + 10, perWork: jacket.length + 10, windowMs: 1_000 }
    const a = alice()
    a.shareOne('Call me Ishmael')
    const b = bob({ dial: () => Promise.resolve(sessionTo(a.serving)), charge: (person, key, bytes, now) => ledger.charge(person, key, bytes, now, budget) })
    const [bytes, report] = await Promise.all([fetcherOver(ledger, budget).ensure(ALICE.id, ALICE_LAPTOP.id, 'pub-jacket', digest), fetchRound(b.ports)])
    /* One of the two was refused — whichever asked second — and the total never passed the budget. */
    expect(ledger.spend(ALICE.id).total).toBeLessThanOrEqual(budget.perPeer)
    expect(bytes === null || report.skipped.some((one) => one.why === 'over-budget')).toBe(true)
  })
})
