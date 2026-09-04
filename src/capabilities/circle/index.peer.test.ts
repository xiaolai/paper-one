import { describe, expect, it, vi } from 'vitest'
import { circlePathIn, hlcOf, relationshipPathIn, type IndexFs, type WriteQueue } from '../../kernel'
import { fakeFs, resolvedCfiForTesting } from '../../kernel/testkit'
import { claimOf, welcome } from './lib/exchange'
import { CIRCLE_PROTO, CIRCLE_SERVICES, CIRCLE_VERSION } from './lib/protocol'
import { readOwnShelf, syncShelf, updateOwnShelf } from './lib/shelf'
import { NOTHING_SHARED, writeForeign, writeHeldList } from './lib/store'
import { NOTHING_LISTED, createList, readOwnList, updateOwnList } from './lib/lists'
import { share, updateShared } from './lib/publish'

/**
 * The capability's wiring to the peer — the module slots `peerPort`,
 * `personPort` and `publishPort` — driven through `start`, the services a
 * friend calls, and one fetch round. The peer module is replaced whole: what
 * is under test is which port each seam reaches for, and what the seam does
 * when the port is not there.
 */
const slots = vi.hoisted(() => ({ peer: null as unknown, person: null as unknown, publish: null as unknown }))
vi.mock('../peer', () => ({
  peerPort: () => slots.peer,
  personPort: () => slots.person,
  publishPort: () => slots.publish,
}))
/* The cadence is replaced too, so a round runs when the test says and not
   thirty seconds later: `run` and `failed` are the driver's seams. */
const cadence = vi.hoisted(() => ({ run: null as null | (() => Promise<void>), failed: null as null | ((cause: unknown) => void) }))
vi.mock('./lib/cadence', async (importActual) => ({
  ...(await importActual<typeof import('./lib/cadence')>()),
  createCadence: (options: { run: () => Promise<void>; failed?: (cause: unknown) => void }) => {
    cadence.run = options.run
    cadence.failed = options.failed ?? null
    return { start: () => {}, stop: () => {} }
  },
}))

import { circle } from './index'

const ALICE = 'a1'.repeat(32)
const ALICE_LAPTOP = 'b1'.repeat(32)
const ALICE_PHONE = 'b2'.repeat(32)
const ME = 'c1'.repeat(32)
const MY_DEVICE = 'c2'.repeat(32)

const identity = () => ({
  person: ME,
  device: MY_DEVICE,
  delegation: { person: ME, device: MY_DEVICE, notBefore: 0, notAfter: 9_999_999_999_999, roster: 0, sig: 'ff'.repeat(64) },
  roster: [MY_DEVICE],
  revocations: 0,
})
const publishing = (over: Partial<{ mine: () => Promise<unknown>; sign: (message: string) => Promise<string> }> = {}) => ({
  mine: () => Promise.resolve(identity()),
  sign: () => Promise.resolve('ab'.repeat(64)),
  ...over,
})
const alice = (over: Partial<{ devices: readonly string[]; revoked: readonly string[] }> = {}) => ({
  person: ALICE,
  displayName: 'Alice',
  roster: { epoch: 0 },
  devices: [ALICE_LAPTOP, ALICE_PHONE],
  revoked: [],
  ...over,
})
const writes: WriteQueue = { append: (_lane, job) => job() } as WriteQueue
const BOOKS = [
  { bookId: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247', languages: ['en'] },
  { bookId: 'book:bare', title: 'Untitled' },
]
const library = (books: readonly Record<string, unknown>[] = BOOKS) => ({
  getSnapshot: () => books,
  lane: (id: string) => id,
  subscribe: () => () => {},
  patch: () => Promise.resolve(),
})
const relationship = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ person: ALICE, state: 'admitted', epoch: 1, admittedAt: hlcOf(1), changedAt: hlcOf(1), retain: 'keep', shelf: true, shelfAt: hlcOf(1), ...over })

function started(fs: IndexFs, books: readonly Record<string, unknown>[] = BOOKS, hashes: { hashFile(folder: string, name: string): Promise<{ blake3: string; size: number }> } | null = null) {
  const info = vi.fn()
  const warn = vi.fn()
  const disposable = circle.start!(
    {
      onCleanup: () => {},
      services: { fs, library: library(books), writes, clock: () => hlcOf(7), hashes: () => hashes },
      diagnostics: { info, warn, error: vi.fn(), child: () => ({}) },
    } as never,
    new AbortController().signal,
  ) as { dispose(): void }
  return { info, warn, dispose: () => disposable.dispose() }
}
const service = (name: string) => circle.services!.find((one) => one.name === name)!
const call = (name: string, request: unknown, peer = ALICE_LAPTOP) => service(name).handler(request, { peer } as never)
const settled = () => new Promise((done) => setTimeout(done, 0))

async function withOwnShelf(fs: IndexFs) {
  await updateOwnShelf(fs, writes, (before) => syncShelf(before, [{ bookId: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', languages: ['en'] }], MY_DEVICE, hlcOf(5), () => 'shelf-pub'))
}

describe('the hello a friend sends', () => {
  it('is refused with no person identity, and welcomed with one', async () => {
    slots.publish = null
    const run = started(fakeFs() as unknown as IndexFs)
    try {
      await expect(call(CIRCLE_SERVICES.hello.name, { proto: CIRCLE_PROTO, pages: CIRCLE_VERSION, person: ALICE })).rejects.toThrow(/no person identity/u)
      slots.publish = publishing()
      expect(await call(CIRCLE_SERVICES.hello.name, { proto: CIRCLE_PROTO, pages: CIRCLE_VERSION, person: ALICE })).toMatchObject({ person: ME })
      await expect(call(CIRCLE_SERVICES.hello.name, { proto: 99 })).rejects.toThrow(/not one this build answers/u)
    } finally {
      run.dispose()
      slots.publish = null
    }
  })
})

describe('the shelf, disclosed by the caller’s device', () => {
  it('serves a device the roster names, and nothing to a revoked one, an unknown one, or under a block', async () => {
    const fs = fakeFs({ [relationshipPathIn(ALICE)]: relationship() }) as unknown as IndexFs
    await withOwnShelf(fs)
    slots.publish = publishing()
    slots.person = { people: () => Promise.resolve([alice({ revoked: [ALICE_PHONE] })]) }
    const run = started(fs)
    try {
      const served = (await call(CIRCLE_SERVICES.shelf.name, { since: {}, v: 2 }, ALICE_LAPTOP)) as { pages: unknown[] }
      expect(served.pages.length).toBeGreaterThan(0)
      /* Sealed as it was served: the boundary is on disk. */
      expect((await readOwnShelf(fs)).sealed.length).toBeGreaterThan(0)
      const revoked = (await call(CIRCLE_SERVICES.shelf.name, { since: {}, v: 2 }, ALICE_PHONE)) as { pages: unknown[] }
      expect(revoked.pages).toEqual([])
      const unknown = (await call(CIRCLE_SERVICES.shelf.name, { since: {}, v: 2 }, 'd9'.repeat(32))) as { pages: unknown[] }
      expect(unknown.pages).toEqual([])
      const lists = (await call(CIRCLE_SERVICES.lists.name, { since: {}, v: 3 }, ALICE_LAPTOP)) as { pages: unknown[] }
      expect(lists.pages).toEqual([])
    } finally {
      run.dispose()
    }
    const blocked = fakeFs({ [relationshipPathIn(ALICE)]: relationship({ state: 'blocked' }) }) as unknown as IndexFs
    await withOwnShelf(blocked)
    const again = started(blocked)
    try {
      expect(((await call(CIRCLE_SERVICES.shelf.name, { since: {}, v: 2 }, ALICE_LAPTOP)) as { pages: unknown[] }).pages).toEqual([])
    } finally {
      again.dispose()
      slots.publish = null
      slots.person = null
    }
  })

  it('refuses to sign through a port the run no longer holds', async () => {
    const fs = fakeFs({ [relationshipPathIn(ALICE)]: relationship() }) as unknown as IndexFs
    await withOwnShelf(fs)
    /* The peer restarts between the identity and the signature: the port
       that answered `mine()` is not the one that would sign. */
    const first = publishing({
      mine: () => {
        slots.publish = publishing()
        return Promise.resolve(identity())
      },
    })
    slots.publish = publishing()
    slots.person = { people: () => Promise.resolve([alice()]) }
    const run = started(fs)
    try {
      await settled()
      slots.publish = first
      await expect(call(CIRCLE_SERVICES.shelf.name, { since: {}, v: 2 }, ALICE_LAPTOP)).rejects.toThrow(/cannot sign/u)
    } finally {
      run.dispose()
      slots.publish = null
      slots.person = null
    }
  })
})

describe('the reader’s own shelf, published at start', () => {
  it('carries what the record names and nothing for what it does not', async () => {
    const fs = fakeFs() as unknown as IndexFs
    slots.publish = publishing()
    const run = started(fs)
    try {
      await settled()
      const shelf = await readOwnShelf(fs)
      const works = shelf.works.map((row) => row.work)
      expect(works).toHaveLength(2)
      const moby = works.find((one) => one.title === 'Moby-Dick')!
      expect(moby).toMatchObject({ author: 'Herman Melville', identifier: 'isbn:9780142437247', language: 'en' })
      const bare = works.find((one) => one.title === 'Untitled')!
      expect(bare).not.toHaveProperty('identifier')
    } finally {
      run.dispose()
      slots.publish = null
    }
  })
})

describe('a fetch round through the peer', () => {
  it('asks nobody without an identity, dials through the peer with one, and reports a peer that has not started', async () => {
    const fs = fakeFs() as unknown as IndexFs
    slots.publish = null
    slots.person = { people: () => Promise.resolve([alice()]) }
    let run = started(fs)
    try {
      await cadence.run!()
      expect(run.info).toHaveBeenCalledWith('circle.fetch', expect.objectContaining({ asked: 0 }))
      run.dispose()

      slots.publish = publishing()
      slots.peer = null
      run = started(fs)
      await cadence.run!()
      /* No peer, no device to dial: the person is skipped before any dial. */
      expect(run.info).toHaveBeenCalledWith('circle.fetch', expect.objectContaining({ asked: 0, skips: [expect.objectContaining({ why: 'no-device' })] }))
      run.dispose()

      /* A peer that stops between listing its devices and the dial. */
      slots.peer = {
        listPeers: () => {
          slots.peer = null
          return Promise.resolve([{ id: ALICE_LAPTOP }])
        },
        connect: () => Promise.reject(new Error('not reached')),
      }
      run = started(fs)
      await cadence.run!()
      /* A dial that fails is a device asleep, and the reason travels with it. */
      expect(run.info).toHaveBeenCalledWith('circle.fetch', expect.objectContaining({ asked: 0, skips: [expect.objectContaining({ why: 'asleep', detail: expect.stringContaining('peer has not started') })] }))
      /* And a round that throws whole is said through diagnostics. */
      cadence.failed!(new Error('the round fell over'))
      expect(run.warn).toHaveBeenCalledWith('circle.fetch.failed', { message: 'the round fell over' })
      run.dispose()

      const calls: string[] = []
      const session = {
        call: (name: string, body: unknown) => {
          calls.push(name)
          if (name === CIRCLE_SERVICES.hello.name) return Promise.resolve(welcome(body, ALICE))
          return Promise.resolve({ pages: [], more: false })
        },
        close: () => Promise.resolve(),
      }
      slots.peer = { listPeers: () => Promise.resolve([{ id: ALICE_LAPTOP }]), connect: () => Promise.resolve(session) }
      run = started(fs)
      await cadence.run!()
      expect(run.info).toHaveBeenCalledWith('circle.fetch', expect.objectContaining({ asked: 1, skipped: 0 }))
      expect(calls[0]).toBe(CIRCLE_SERVICES.hello.name)
    } finally {
      run.dispose()
      slots.publish = null
      slots.person = null
      slots.peer = null
    }
  })
})

describe('what the run reads for a friend', () => {
  it('lists the lists held for them', async () => {
    const fs = fakeFs() as unknown as IndexFs
    await writeHeldList(fs, writes, ALICE, 'aa11', { ...NOTHING_SHARED, list: { created: true, title: { value: 'Sea books', at: hlcOf(1), device: ALICE_LAPTOP, seq: 1 }, deleted: false, items: [], removed: [] } } as never, () => {})
    slots.person = { people: () => Promise.resolve([alice()]), forgetPerson: () => Promise.resolve() }
    const run = started(fs)
    try {
      const pane = circle.screens![0]!.render({ openBook: null } as never) as { readonly props: { readonly circle: { friend(person: string): Promise<{ lists: readonly { title: string }[] }> } } }
      const friend = await pane.props.circle.friend(ALICE)
      expect(friend.lists.map((one) => one.title)).toEqual(['Sea books'])
    } finally {
      run.dispose()
      slots.person = null
    }
  })

  it('warns through diagnostics when a file will not read, and draws the rest', async () => {
    const fs = fakeFs({ [circlePathIn('book:moby', ALICE)]: 'not json at all' }) as unknown as IndexFs
    const run = started(fs)
    try {
      const overlay = circle.overlays![0]! as unknown as { forBook(request: unknown): Promise<unknown[]> }
      expect(await overlay.forBook({ bookId: 'book:moby', resolve: () => Promise.resolve(null) })).toEqual([])
      expect(run.warn).toHaveBeenCalledWith('circle.read-failed', expect.objectContaining({ person: ALICE, bookId: 'book:moby' }))
    } finally {
      run.dispose()
    }
  })
})

describe('what the overlay draws of a person, under their relationship', () => {
  const entry = (person: string) => ({
    person,
    pub: 'pub1',
    passage: { quote: 'Call me Ishmael', prefix: 'before ', suffix: ' after', chapter: 'One' },
    epoch: 1,
    receivedAt: 1000,
  })
  /* The kernel resolver's answer: everything it is handed, placed at one anchor. */
  const resolve = (pending: readonly { id: string }[]) =>
    Promise.resolve({ found: pending.map((one) => ({ id: one.id, cfi: resolvedCfiForTesting('epubcfi(/6/4!/4/2)'), sectionIndex: 1 })), missed: [], complete: true })

  it('draws an admitted person’s passage, nothing of a blocked one, and nothing of one whose record will not read — warning about that', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const [what, record, drawn] of [
        ['admitted', relationship(), 1],
        ['blocked', relationship({ state: 'blocked' }), 0],
        ['unreadable', 'not json at all', 0],
      ] as const) {
        const fs = fakeFs({ [relationshipPathIn(ALICE)]: record }) as unknown as IndexFs
        await writeForeign(fs, writes, (id) => id, 'book:moby', ALICE, { ...NOTHING_SHARED, entries: [entry(ALICE)] } as never, () => {})
        const run = started(fs)
        try {
          const overlay = circle.overlays![0]! as unknown as { forBook(request: unknown): Promise<unknown[]> }
          expect((await overlay.forBook({ bookId: 'book:moby', resolve })).length, what).toBe(drawn)
        } finally {
          run.dispose()
        }
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read the relationship'), expect.anything())
    } finally {
      warn.mockRestore()
    }
  })
})

describe('what a friend is served of the reader’s own lists and passages', () => {
  it('serves the lists, sealing them, and a shared passage, sealing it', async () => {
    const fs = fakeFs({ [relationshipPathIn(ALICE)]: relationship() }) as unknown as IndexFs
    await updateOwnList(fs, writes, 'aa11', () => createList(NOTHING_LISTED, 'Sea books', { device: MY_DEVICE, at: hlcOf(3) }))
    const passage = { quote: 'Call me Ishmael', prefix: '', suffix: '', chapter: 'One' }
    await updateShared(fs, writes, (id) => id, 'book:moby', (held) => share(held, { markId: 'm1', passage, device: MY_DEVICE }, 'pub1', hlcOf(5)).held)
    slots.publish = publishing()
    slots.person = { people: () => Promise.resolve([alice()]) }
    const run = started(fs)
    try {
      const lists = (await call(CIRCLE_SERVICES.lists.name, { since: {}, v: 3 }, ALICE_LAPTOP)) as { pages: unknown[] }
      expect(lists.pages.length).toBeGreaterThan(0)
      expect((await readOwnList(fs, 'aa11')).sealed.length).toBeGreaterThan(0)
      const ask = { work: claimOf({ id: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247', languages: ['en'] }), since: {}, v: 3 }
      const pages = (await call(CIRCLE_SERVICES.pages.name, ask)) as { pages: unknown[] }
      expect(pages.pages.length).toBeGreaterThan(0)
      /* Sealed on the way out: the same ask again re-serves the same page. */
      expect(((await call(CIRCLE_SERVICES.pages.name, ask)) as { pages: unknown[] }).pages).toEqual(pages.pages)
    } finally {
      run.dispose()
      slots.publish = null
      slots.person = null
    }
  })
})

describe('the shelf carries a jacket’s digest — WI-23.C5', () => {
  it('publishes the digest of a measured jacket within the bound, and none over it or unmeasured', async () => {
    const fs = fakeFs() as unknown as IndexFs
    slots.publish = publishing()
    const within = { name: 'cover.jpg' as const, size: 40_000, hash: 'ab'.repeat(32) }
    const over = { name: 'cover.jpg' as const, size: 1024 * 1024 + 1, hash: 'cd'.repeat(32) }
    const run = started(fs, [
      { bookId: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', coverFacts: within },
      { bookId: 'book:big', title: 'Big', author: 'B', coverFacts: over },
      { bookId: 'book:bare', title: 'Untitled' },
    ])
    try {
      await settled()
      const works = (await readOwnShelf(fs)).works.map((row) => [row.work.title, row.work.cover])
      expect(works).toEqual(
        expect.arrayContaining([
          ['Moby-Dick', 'ab'.repeat(32)],
          ['Big', undefined],
          ['Untitled', undefined],
        ]),
      )
    } finally {
      run.dispose()
      slots.publish = null
    }
  })

  it('measures an unmeasured jacket through the hash port, a few per pass, and publishes it', async () => {
    const fs = fakeFs({ 'books/book_moby/cover.jpg': 'jacket bytes' }) as unknown as IndexFs
    slots.publish = publishing()
    const hashFile = vi.fn((folder: string, name: string) => Promise.resolve({ blake3: 'ef'.repeat(32), size: 12, folder, name }))
    const rows: Record<string, unknown>[] = [{ bookId: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville' }]
    const info = vi.fn()
    /* A library whose `update` stamps the row and tells its subscribers, as the real one does. */
    const listeners = new Set<() => void>()
    const lib = {
      getSnapshot: () => rows,
      lane: (id: string) => id,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      patch: () => Promise.resolve(),
      update: async (bookId: string, change: (record: Record<string, unknown>) => Record<string, unknown>) => {
        const at = rows.findIndex((row) => row['bookId'] === bookId)
        rows[at] = change(rows[at]!)
        for (const listener of listeners) listener()
      },
    }
    const disposable = circle.start!(
      {
        onCleanup: () => {},
        services: { fs, library: lib, writes, clock: () => hlcOf(7), hashes: () => ({ hashFile }) },
        diagnostics: { info, warn: vi.fn(), error: vi.fn(), child: () => ({}) },
      } as never,
      new AbortController().signal,
    ) as { dispose(): void }
    try {
      await settled()
      await settled()
      expect(hashFile).toHaveBeenCalledWith('book_moby', 'cover.jpg')
      expect(rows[0]!['coverFacts']).toEqual({ name: 'cover.jpg', size: 12, hash: 'ef'.repeat(32) })
      expect((await readOwnShelf(fs)).works.map((row) => row.work.cover)).toEqual(['ef'.repeat(32)])
    } finally {
      disposable.dispose()
      slots.publish = null
    }
  })
})

describe('the jacket a friend is served — WI-23.C5', () => {
  const JACKET = new Uint8Array(3000).map((_, i) => i % 200)
  const facts = { name: 'cover.jpg' as const, size: JACKET.length, hash: 'ab'.repeat(32) }
  const MOBY = { bookId: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', coverFacts: facts }

  async function pubOf(fs: IndexFs) {
    await settled()
    return (await readOwnShelf(fs)).works.find((row) => row.work.cover === facts.hash)!.pub
  }

  async function withRun(record: string, jacket: Uint8Array, people: unknown[], inside: (pub: string) => Promise<void>) {
    const fs = fakeFs({ [relationshipPathIn(ALICE)]: record }) as unknown as IndexFs
    await fs.writeFile('books/book_moby/cover.jpg', jacket)
    slots.publish = publishing()
    slots.person = { people: () => Promise.resolve(people) }
    const run = started(fs, [MOBY])
    try {
      await inside(await pubOf(fs))
    } finally {
      run.dispose()
      slots.publish = null
      slots.person = null
    }
  }

  it('serves it to a device the roster names, and refuses the revoked, the wrong offset and an unknown pub with one sentence', async () => {
    await withRun(relationship(), JACKET, [alice({ revoked: [ALICE_PHONE] })], async (pub) => {
      const first = (await call(CIRCLE_SERVICES.cover.name, { pub, offset: 0 }, ALICE_LAPTOP)) as { offset: number; size: number; bytes: string; more: boolean }
      expect(first).toMatchObject({ offset: 0, size: JACKET.length, more: false })
      expect(Uint8Array.from(atob(first.bytes), (c) => c.charCodeAt(0))).toEqual(JACKET)
      await expect(call(CIRCLE_SERVICES.cover.name, { pub, offset: 0 }, ALICE_PHONE)).rejects.toThrow(/not one this build answers/u)
      await expect(call(CIRCLE_SERVICES.cover.name, { pub, offset: JACKET.length }, ALICE_LAPTOP)).rejects.toThrow(/not one this build answers/u)
      await expect(call(CIRCLE_SERVICES.cover.name, { pub: 'ab', offset: 0 }, ALICE_LAPTOP)).rejects.toThrow(/not one this build answers/u)
    })
  })

  it('refuses a person the switch is off for with the same sentence', async () => {
    await withRun(relationship({ shelf: false }), JACKET, [alice()], async (pub) => {
      await expect(call(CIRCLE_SERVICES.cover.name, { pub, offset: 0 }, ALICE_LAPTOP)).rejects.toThrow(/not one this build answers/u)
    })
  })

  it('serves each book its own jacket, and refuses one whose file is gone', async () => {
    const fs = fakeFs({ [relationshipPathIn(ALICE)]: relationship() }) as unknown as IndexFs
    await fs.writeFile('books/book_moby/cover.jpg', JACKET)
    const OTHER = new Uint8Array(100).fill(9)
    await fs.writeFile('books/book_dune/cover.jpg', OTHER)
    slots.publish = publishing()
    slots.person = { people: () => Promise.resolve([alice()]) }
    const other = { name: 'cover.jpg' as const, size: OTHER.length, hash: 'cd'.repeat(32) }
    const gone = { name: 'cover.jpg' as const, size: 5, hash: 'ef'.repeat(32) }
    const run = started(fs, [MOBY, { bookId: 'book:dune', title: 'Dune', author: 'Frank Herbert', coverFacts: other }, { bookId: 'book:bare', title: 'Bare', author: 'B', coverFacts: gone }])
    try {
      await settled()
      const works = (await readOwnShelf(fs)).works
      const dune = works.find((row) => row.work.cover === other.hash)!.pub
      const bare = works.find((row) => row.work.cover === gone.hash)!.pub
      const served = (await call(CIRCLE_SERVICES.cover.name, { pub: dune, offset: 0 }, ALICE_LAPTOP)) as { bytes: string; size: number }
      expect(served.size).toBe(OTHER.length)
      expect(Uint8Array.from(atob(served.bytes), (c) => c.charCodeAt(0))).toEqual(OTHER)
      await expect(call(CIRCLE_SERVICES.cover.name, { pub: bare, offset: 0 }, ALICE_LAPTOP)).rejects.toThrow(/not one this build answers/u)
    } finally {
      run.dispose()
      slots.publish = null
      slots.person = null
    }
  })

  it('refuses, with the one sentence, an entry whose book has since left the library', async () => {
    const fs = fakeFs({ [relationshipPathIn(ALICE)]: relationship() }) as unknown as IndexFs
    await fs.writeFile('books/book_moby/cover.jpg', JACKET)
    slots.publish = publishing()
    slots.person = { people: () => Promise.resolve([alice()]) }
    const rows: Record<string, unknown>[] = [MOBY]
    const run = started(fs, rows)
    try {
      const pub = await pubOf(fs)
      rows.splice(0, 1)
      await expect(call(CIRCLE_SERVICES.cover.name, { pub, offset: 0 }, ALICE_LAPTOP)).rejects.toThrow(/not one this build answers/u)
    } finally {
      run.dispose()
      slots.publish = null
      slots.person = null
    }
  })

  it('does not serve a file that changed size under its facts', async () => {
    await withRun(relationship(), JACKET.subarray(1), [alice()], async (pub) => {
      await expect(call(CIRCLE_SERVICES.cover.name, { pub, offset: 0 }, ALICE_LAPTOP)).rejects.toThrow(/not one this build answers/u)
    })
  })
})
