import { describe, expect, it, vi } from 'vitest'
import { hlcOf, newRelationship, type Hlc, type Relationship } from '../../../kernel'
import { COVER_WIDTH, RECENT_LIMIT, circlePortOver, type CirclePortDeps, type FriendBook } from './circlePort'
import { NOTHING_SHARED, type ForeignFile } from './store'

/**
 * WI-23.C2's switch and WI-23.C4's Friends view, from the screen's side.
 *
 * ⚠️ **THE C4 FALSIFIER**: a book on Bob's shelf that this reader ALSO has
 * must link to the reader's own copy — `bookVia` over the claim — and one
 * they do not have must not link anywhere. Count the links: equal to the
 * intersection, exactly.
 */

const BOB = 'b0'.repeat(32)

function world(over: Partial<CirclePortDeps> = {}) {
  const records = new Map<string, Relationship>()
  const people: { person: string; displayName: string }[] = [{ person: BOB, displayName: 'Bob' }]
  const shelves = new Map<string, ForeignFile>()
  const perBook = new Map<string, ForeignFile>()
  const lists = new Map<string, Map<string, ForeignFile>>()
  let tick = 0
  const listeners = new Set<() => void>()
  let books: ReturnType<CirclePortDeps['books']> = [
    { id: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247', languages: ['en'] },
    { id: 'book:dune', title: 'Dune', author: 'Frank Herbert', languages: ['en'] },
  ]
  const deps: CirclePortDeps = {
    clock: () => hlcOf(++tick),
    books: () => books,
    people: () => Promise.resolve(people),
    relationship: (person: string) => Promise.resolve(records.get(person) ?? newRelationship(person, hlcOf(0))),
    writeRelationship: vi.fn((record: Relationship) => {
      records.set(record.person, record)
      return Promise.resolve(record)
    }),
    heldShelf: (person) => Promise.resolve(shelves.get(person) ?? NOTHING_SHARED),
    heldOf: (bookId, person) => Promise.resolve(perBook.get(`${bookId}/${person}`) ?? NOTHING_SHARED),
    heldLists: (person) => Promise.resolve(lists.get(person) ?? new Map()),
    coverOf: vi.fn(() => Promise.resolve(null)),
    /* Signals as the real purge does — through `onChanged` — which is the
       one notification a forget produces. */
    purge: vi.fn(() => {
      for (const listener of listeners) listener()
      return Promise.resolve()
    }),
    forgetPeer: vi.fn(() => Promise.resolve()),
    warn: vi.fn(),
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...over,
  }
  const setBooks = (next: ReturnType<CirclePortDeps['books']>) => {
    books = next
  }
  return { deps, records, shelves, perBook, lists, people, listeners, setBooks, port: circlePortOver(deps) }
}

const at = (n: number): Hlc => hlcOf(n)

describe('the shelf switch, per person', () => {
  it('is off for a person nothing has been decided about, and turns under a new stamp', async () => {
    const { port, deps } = world()
    expect(await port.showsShelf(BOB)).toBe(false)
    await port.setShowsShelf(BOB, true)
    expect(await port.showsShelf(BOB)).toBe(true)
    expect(deps.writeRelationship).toHaveBeenCalledTimes(1)
    /* Already on: nothing written for saying so again. */
    await port.setShowsShelf(BOB, true)
    expect(deps.writeRelationship).toHaveBeenCalledTimes(1)
    await port.setShowsShelf(BOB, false)
    expect(await port.showsShelf(BOB)).toBe(false)
  })

  it('tells subscribers when the switch moves, and when the store changes under a fetch', async () => {
    const { port, listeners } = world()
    const told = vi.fn()
    const off = port.subscribe(told)
    await port.setShowsShelf(BOB, true)
    expect(told).toHaveBeenCalledTimes(1)
    for (const listener of listeners) listener()
    expect(told).toHaveBeenCalledTimes(2)
    off()
    await port.setShowsShelf(BOB, false)
    expect(told).toHaveBeenCalledTimes(2)
  })
})

describe('the Friends view', () => {
  const work = (pub: string, title: string, author: string, identifier?: string) => ({
    pub,
    at: at(1),
    work: { title, author, language: 'en', ...(identifier === undefined ? {} : { identifier }) },
  })

  it('links exactly the books the reader also has — the falsifier', async () => {
    const { port, shelves } = world()
    shelves.set(BOB, {
      ...NOTHING_SHARED,
      works: [
        /* The same identifier: a strong match. */
        work('s1', 'Moby Dick', 'H. Melville', 'isbn:9780142437247'),
        /* No identifier, but title, author and language agree: a weak match. */
        work('s2', 'Dune', 'Frank Herbert'),
        /* A book the reader does not have. */
        work('s3', 'Ulysses', 'James Joyce'),
        /* A title the reader has, by another author: no match. */
        work('s4', 'Dune', 'Somebody Else'),
      ],
    })
    const view = await port.friend(BOB)
    expect(view.shelf.map((one) => [one.title, one.own])).toEqual([
      ['Moby Dick', 'book:moby'],
      ['Dune', 'book:dune'],
      ['Ulysses', null],
      ['Dune', null],
    ])
    /* The count of links IS the intersection: two. */
    expect(view.shelf.filter((one) => one.own !== null)).toHaveLength(2)
  })

  it('lists what a friend did lately on the books the reader has, newest first', async () => {
    const { port, perBook } = world()
    perBook.set(`book:moby/${BOB}`, {
      ...NOTHING_SHARED,
      opinion: {
        status: { value: 'finished', at: at(5), device: 'd', seq: 1 },
        stars: { value: 4, at: at(7), device: 'd', seq: 2 },
      },
      reviews: [{ pub: 'r1', text: 'a whale of a book', at: at(6), epoch: 1 }],
    })
    perBook.set(`book:dune/${BOB}`, {
      ...NOTHING_SHARED,
      opinion: { status: { value: 'reading', at: at(9), device: 'd', seq: 3 } },
    })
    const view = await port.friend(BOB)
    expect(view.recent.map((one) => [one.title, one.kind, one.value])).toEqual([
      ['Dune', 'status', 'is reading'],
      ['Moby-Dick', 'rate', '4 of 5'],
      ['Moby-Dick', 'review', 'a whale of a book'],
      ['Moby-Dick', 'status', 'finished'],
    ])
  })

  it('is empty for a person who has shown nothing', async () => {
    expect(await world().port.friend(BOB)).toEqual({ shelf: [], recent: [], lists: [] })
  })
})

describe('forgetting a person', () => {
  it('purges their files across every book before the peer forgets them, and says so', async () => {
    const { port, deps, listeners } = world()
    const told = vi.fn()
    port.subscribe(told)
    const order: string[] = []
    ;(deps.purge as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('purge')
      /* The purge is what says so, as the real one does through `onChanged`. */
      for (const listener of listeners) listener()
      return Promise.resolve()
    })
    ;(deps.forgetPeer as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('forget')
      return Promise.resolve()
    })
    await port.forget(BOB)
    expect(order).toEqual(['purge', 'forget'])
    expect(deps.purge).toHaveBeenCalledWith(BOB, ['book:moby', 'book:dune'])
    expect(told).toHaveBeenCalledTimes(1)
  })

  it('stops listening once disposed', () => {
    const { port, listeners } = world()
    port.dispose()
    expect(listeners.size).toBe(0)
  })
})

describe('the circle’s view of a book, through the port — WI-23.D1–D3', () => {
  it('reads everyone the peer names, by signed name, and is empty for a book the reader does not have', async () => {
    const { port, shelves, perBook, people } = world()
    people.push({ person: 'c'.repeat(64), displayName: 'Carol' })
    shelves.set(BOB, {
      ...NOTHING_SHARED,
      works: [
        { pub: 'p1', work: { title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247', language: 'en' }, at: at(1) },
        { pub: 'p2', work: { title: 'Emma', author: 'Jane Austen', language: 'en' }, at: at(2) },
      ],
    })
    perBook.set(`book:moby/${'c'.repeat(64)}`, { ...NOTHING_SHARED, opinion: { stars: { value: 5, at: at(3), device: 'd', seq: 1 } } })
    const view = await port.book('book:moby')
    expect(view.people.map((one) => [one.name, one.has, one.stars])).toEqual([
      ['Bob', true, null],
      ['Carol', false, 5],
    ])
    expect(view.alsoRead).toMatchObject([{ title: 'Emma', author: 'Jane Austen', names: ['Bob'], own: null }])
    expect(await port.book('book:nowhere')).toEqual({ people: [], alsoRead: [] })
  })

  it('reads reviews under the relationship record it holds, so a re-admission hides the old epoch', async () => {
    const { port, records, perBook } = world()
    perBook.set(`book:moby/${BOB}`, { ...NOTHING_SHARED, reviews: [{ pub: 'r', text: 'old', at: at(2), epoch: 1 }] })
    expect((await port.book('book:moby')).people[0]?.reviews.map((one) => one.text)).toEqual(['old'])
    records.set(BOB, { ...newRelationship(BOB, at(1)), epoch: 2 })
    expect((await port.book('book:moby')).people).toEqual([])
  })
})

describe('a friend’s lists, through the port — WI-23.E1', () => {
  it('shows the lists that exist and are not deleted, by title, with each item linked to the reader’s copy if any', async () => {
    const { port, lists } = world()
    const item = (pub: string, title: string, author: string, note: string) => ({ pub, work: { title, author, language: 'en' }, position: 1, note, at: at(1), device: 'd'.repeat(64), seq: 1 })
    lists.set(
      BOB,
      new Map([
        ['zz', { ...NOTHING_SHARED, list: { created: true, title: { value: 'Zebras', at: at(1), device: 'd', seq: 1 }, deleted: false, items: [item('i1', 'Moby-Dick', 'Herman Melville', 'start here')], removed: [] } }],
        ['aa', { ...NOTHING_SHARED, list: { created: true, title: { value: 'Aardvarks', at: at(1), device: 'd', seq: 1 }, deleted: false, items: [item('i2', 'Emma', 'Jane Austen', '')], removed: [] } }],
        ['gone', { ...NOTHING_SHARED, list: { created: true, title: { value: 'Gone', at: at(1), device: 'd', seq: 1 }, deleted: true, items: [], removed: [] } }],
        ['stray', { ...NOTHING_SHARED, list: { created: false, deleted: false, items: [item('i3', 'T', 'A', '')], removed: [] } }],
      ]),
    )
    const view = await port.friend(BOB)
    expect(view.lists).toEqual([
      { id: 'aa', title: 'Aardvarks', items: [{ pub: 'i2', title: 'Emma', author: 'Jane Austen', note: '', own: null }] },
      { id: 'zz', title: 'Zebras', items: [{ pub: 'i1', title: 'Moby-Dick', author: 'Herman Melville', note: 'start here', own: 'book:moby' }] },
    ])
  })
})

describe('every clause of the Friends view — one row each', () => {
  const register = (value: 'want' | 'reading' | 'finished', n: number) => ({ value, at: at(n), device: 'd', seq: n })

  it('orders what a friend did newest first whatever order the books come in, keeps insertion order at an equal stamp, and stops at the limit', async () => {
    const { port, perBook, setBooks } = world()
    /* Moby first in the shelf with the OLDER stamp; Dune newer. */
    perBook.set(`book:moby/${BOB}`, { ...NOTHING_SHARED, opinion: { status: register('want', 1), stars: { value: 3, at: at(1), device: 'd', seq: 2 } } })
    perBook.set(`book:dune/${BOB}`, { ...NOTHING_SHARED, opinion: { status: register('reading', 5) } })
    const view = await port.friend(BOB)
    expect(view.recent.map((one) => [one.title, one.kind, one.value])).toEqual([
      ['Dune', 'status', 'is reading'],
      ['Moby-Dick', 'status', 'wants to read'],
      ['Moby-Dick', 'rate', '3 of 5'],
    ])
    /* More than the limit: the newest RECENT_LIMIT, and no more. */
    const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) => ({ id: `book:${i}`, title: `B${i}`, languages: ['en'] }))
    setBooks(many)
    for (const [i, book] of many.entries()) perBook.set(`${book.id}/${BOB}`, { ...NOTHING_SHARED, opinion: { status: register('finished', i + 10) } })
    const capped = await port.friend(BOB)
    expect(capped.recent).toHaveLength(RECENT_LIMIT)
    expect(capped.recent[0]!.title).toBe(`B${RECENT_LIMIT + 4}`)
  })

  it('names a book with no title as nothing, and a created list with no title yet the same', async () => {
    const { port, perBook, lists, setBooks } = world()
    setBooks([{ id: 'book:untitled', languages: ['en'] }])
    perBook.set(`book:untitled/${BOB}`, { ...NOTHING_SHARED, opinion: { status: register('finished', 1) } })
    lists.set(BOB, new Map([['aa', { ...NOTHING_SHARED, list: { created: true, deleted: false, items: [], removed: [] } }]]))
    const view = await port.friend(BOB)
    expect(view.recent).toEqual([{ kind: 'status', bookId: 'book:untitled', title: '', value: 'finished', at: at(1) }])
    expect(view.lists).toEqual([{ id: 'aa', title: '', items: [] }])
  })

  it('orders two lists with one title by id', async () => {
    const { port, lists } = world()
    const titled = (n: number) => ({ ...NOTHING_SHARED, list: { created: true, title: { value: 'Same', at: at(n), device: 'd', seq: 1 }, deleted: false, items: [], removed: [] } })
    lists.set(BOB, new Map([['bb', titled(1)], ['aa', titled(2)]]))
    expect((await port.friend(BOB)).lists.map((one) => one.id)).toEqual(['aa', 'bb'])
  })

  it('tells nobody after dispose, even about a switch it moved', async () => {
    const { port } = world()
    const told = vi.fn()
    port.subscribe(told)
    port.dispose()
    await port.setShowsShelf(BOB, true)
    expect(told).not.toHaveBeenCalled()
  })
})

describe('the port’s contract, held to the letter', () => {
  it('says nothing for a switch that did not move', async () => {
    const { port, listeners } = world()
    let heard = 0
    port.subscribe(() => void (heard += 1))
    await port.setShowsShelf(BOB, false)
    expect(heard).toBe(0)
    await port.setShowsShelf(BOB, true)
    expect(heard).toBe(1)
    expect(listeners.size).toBeGreaterThanOrEqual(0)
  })

  it('leaves a review from an earlier admission out of what a friend did lately', async () => {
    const { port, records, perBook } = world()
    records.set(BOB, { ...newRelationship(BOB, at(1)), epoch: 2 })
    perBook.set(`book:moby/${BOB}`, {
      ...NOTHING_SHARED,
      reviews: [
        { pub: 'r-old', text: 'from before', at: at(2), epoch: 1 },
        { pub: 'r-new', text: 'from now', at: at(3), epoch: 2 },
      ],
    })
    const view = await port.friend(BOB)
    expect(view.recent.map((one) => one.value)).toEqual(['from now'])
  })

  it('ends the relationship before purging, so a round in flight stops writing', async () => {
    const { port, deps, records } = world()
    const order: string[] = []
    ;(deps.writeRelationship as ReturnType<typeof vi.fn>).mockImplementation((record: Relationship) => {
      order.push(`write:${record.state}`)
      records.set(record.person, record)
      return Promise.resolve(record)
    })
    ;(deps.purge as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('purge')
      return Promise.resolve()
    })
    ;(deps.forgetPeer as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('forget')
      return Promise.resolve()
    })
    await port.forget(BOB)
    expect(order).toEqual(['write:exited', 'purge', 'forget'])
  })
})

describe('a listener that throws', () => {
  it('is named as the circle’s, and does not stop the others', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { port } = world()
    const heard = vi.fn()
    port.subscribe(() => {
      throw new Error('listener down')
    })
    port.subscribe(heard)
    await port.setShowsShelf(BOB, true)
    expect(heard).toHaveBeenCalled()
    expect(spy).toHaveBeenCalledWith(`Paper: a circle listener threw`, expect.objectContaining({ message: 'listener down' }))
    spy.mockRestore()
  })
})

describe('what a friend did lately, under the epoch', () => {
  it('leaves out a register or a shelf row from an earlier admission', async () => {
    const { port, records, perBook, shelves } = world()
    records.set(BOB, { ...newRelationship(BOB, at(1)), epoch: 2 })
    perBook.set(`book:moby/${BOB}`, { ...NOTHING_SHARED, opinion: { status: { value: 'finished', at: at(2), device: 'd', seq: 1, epoch: 1 }, stars: { value: 4, at: at(3), device: 'd', seq: 2, epoch: 2 } } })
    shelves.set(BOB, { ...NOTHING_SHARED, works: [{ pub: 's-old', work: { title: 'Old', author: '', language: 'en' }, at: at(1), epoch: 1 }, { pub: 's-new', work: { title: 'New', author: '', language: 'en' }, at: at(2), epoch: 2 }] })
    const view = await port.friend(BOB)
    expect(view.recent.map((one) => one.value)).toEqual(['4 of 5'])
    expect(view.shelf.map((one) => one.title)).toEqual(['New'])
  })
})

describe('the shelf switch, as it stands and in order', () => {
  it('reads as off under a relationship that carries nothing, whatever the stored switch says', async () => {
    const { port, records } = world()
    records.set(BOB, { ...newRelationship(BOB, at(1)), state: 'blocked', shelf: true })
    expect(await port.showsShelf(BOB)).toBe(false)
    records.set(BOB, { ...newRelationship(BOB, at(1)), state: 'muted', shelf: true })
    expect(await port.showsShelf(BOB)).toBe(true)
  })

  it('applies two opposite flips in the order they were asked, the later standing', async () => {
    const { port, deps, records } = world()
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 5))
    ;(deps.writeRelationship as ReturnType<typeof vi.fn>).mockImplementation(async (record: Relationship) => {
      await gate
      records.set(record.person, record)
      return record
    })
    const on = port.setShowsShelf(BOB, true)
    const off = port.setShowsShelf(BOB, false)
    await Promise.all([on, off])
    expect(records.get(BOB)?.shelf).toBe(false)
    expect(deps.writeRelationship).toHaveBeenCalledTimes(2)
  })

  it('reads a large shelf’s files a few at a time, and all of them', async () => {
    const { port, setBooks, deps } = world()
    setBooks(Array.from({ length: 30 }, (_, i) => ({ id: `book:${i}`, title: `B${i}`, author: '', languages: ['en'] })))
    let inFlight = 0
    let most = 0
    let reads = 0
    ;(deps as { heldOf: unknown }).heldOf = async () => {
      inFlight += 1
      most = Math.max(most, inFlight)
      reads += 1
      await new Promise((done) => setTimeout(done, 1))
      inFlight -= 1
      return NOTHING_SHARED
    }
    const fresh = circlePortOver(deps)
    await fresh.friend(BOB)
    expect(reads).toBe(30)
    expect(most).toBeLessThanOrEqual(8)
    expect(port).toBeDefined()
  })
})

describe('a friend’s jacket — WI-23.C5', () => {
  it('names the device and the digest on the row, and hands the picture over as a data URL when both are there', async () => {
    const { port, deps, shelves } = world()
    shelves.set(BOB, {
      ...NOTHING_SHARED,
      works: [
        { pub: 's1', at: at(1), device: 'd1', epoch: 1, work: { title: 'Moby-Dick', author: 'Herman Melville', language: 'en', cover: 'ab'.repeat(32) } },
        { pub: 's2', at: at(2), device: 'd1', epoch: 1, work: { title: 'Dune', author: 'Frank Herbert', language: 'en' } },
      ],
    } as never)
    const view = await port.friend(BOB)
    expect(view.shelf.map((one) => [one.pub, one.device, one.cover])).toEqual([
      ['s1', 'd1', 'ab'.repeat(32)],
      ['s2', 'd1', null],
    ])
    /* The type the BYTES say, not a declared JPEG: a legacy jacket can be a PNG under any name. */
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    ;(deps.coverOf as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jpeg)
    expect(await port.cover(BOB, view.shelf[0]!)).toBe(`data:image/jpeg;base64,${btoa(String.fromCharCode(...jpeg))}`)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    ;(deps.coverOf as ReturnType<typeof vi.fn>).mockResolvedValueOnce(png)
    expect(await port.cover(BOB, view.shelf[0]!)).toMatch(/^data:image\/png;base64,/u)
    /* Bytes that are no picture this build knows say so, and the browser sniffs them. */
    ;(deps.coverOf as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new TextEncoder().encode('jpeg'))
    expect(await port.cover(BOB, view.shelf[0]!)).toBe(`data:application/octet-stream;base64,${btoa('jpeg')}`)
    /* And the row's signal beside them — none here, and the transfer is told so. */
    expect(deps.coverOf).toHaveBeenCalledWith(BOB, 'd1', 's1', 'ab'.repeat(32), undefined)
    /* No digest, no ask; and a fetch that answers nothing draws nothing. */
    expect(await port.cover(BOB, view.shelf[1]!)).toBeNull()
    expect(await port.cover(BOB, { ...view.shelf[0]!, device: null })).toBeNull()
    /* The three draws above, and nothing for the two rows that name no jacket. */
    expect(deps.coverOf).toHaveBeenCalledTimes(3)
    expect(await port.cover(BOB, view.shelf[0]!)).toBeNull()
  })
})

describe('the switch and a forget, on one person’s turn', () => {
  it('refuses the switch for a person the peer no longer names', async () => {
    const { port, deps } = world()
    await expect(port.setShowsShelf('e9'.repeat(32), true)).rejects.toThrow(/not in your circle/u)
    expect(deps.writeRelationship).not.toHaveBeenCalled()
  })

  it('runs a flip queued behind a forget after the peer has forgotten them — and refuses it as such', async () => {
    const { port, deps, people, records } = world()
    ;(deps.forgetPeer as ReturnType<typeof vi.fn>).mockImplementation((person: string) => {
      people.splice(people.findIndex((one) => one.person === person), 1)
      return Promise.resolve()
    })
    const gone = port.forget(BOB)
    const flipped = port.setShowsShelf(BOB, true)
    await gone
    await expect(flipped).rejects.toThrow(/not in your circle/u)
    /* The exited record stands, with no grant written over it. */
    expect(records.get(BOB)).toMatchObject({ state: 'exited', shelf: false })
  })

  it('lets go of a person’s turn once it has settled', async () => {
    const { port } = world()
    await port.setShowsShelf(BOB, true)
    await port.setShowsShelf(BOB, false)
    /* Observable only through behaviour: a later act still runs in order. */
    await expect(port.setShowsShelf(BOB, true)).resolves.toBeUndefined()
    expect(await port.showsShelf(BOB)).toBe(true)
  })
})

describe('a friend’s lists, under the relationship — WI-23.E1 meets WI-23.D3', () => {
  const work = { title: 'Moby-Dick', author: 'Herman Melville', language: 'en' }
  const item = (pub: string, epoch?: number) => ({ pub, work, position: 1, note: '', at: at(1), device: 'd1', seq: 1, ...(epoch === undefined ? {} : { epoch }) })
  const title = (value: string, epoch?: number) => ({ value, at: at(1), device: 'd1', seq: 1, ...(epoch === undefined ? {} : { epoch }) })
  const listHeld = (over: Record<string, unknown> = {}) => ({ ...NOTHING_SHARED, list: { created: true, createdEpoch: 1, title: title('Sea books', 1), deleted: false, items: [item('x', 1)], removed: [], ...over } })

  it('shows nothing of a muted or blocked person’s lists', async () => {
    const { port, lists, records } = world()
    lists.set(BOB, new Map([['aa', listHeld()]]))
    expect((await port.friend(BOB)).lists).toHaveLength(1)
    records.set(BOB, { ...newRelationship(BOB, at(0)), state: 'muted' })
    expect((await port.friend(BOB)).lists).toEqual([])
    records.set(BOB, { ...newRelationship(BOB, at(0)), state: 'blocked' })
    expect((await port.friend(BOB)).lists).toEqual([])
  })

  it('hides a list retained from an earlier epoch, and the items placed under one, after a re-admission', async () => {
    const { port, lists, records } = world()
    records.set(BOB, { ...newRelationship(BOB, at(0)), epoch: 2 })
    lists.set(
      BOB,
      new Map([
        ['old', listHeld({ createdEpoch: 1 })],
        ['new', listHeld({ createdEpoch: 2, title: title('New', 2), items: [item('x', 1), item('y', 2)] })],
        ['unstamped', listHeld({ createdEpoch: undefined, title: title('Unstamped'), items: [item('z')] })],
      ]),
    )
    const view = await port.friend(BOB)
    expect(view.lists.map((one) => [one.id, one.items.map((it) => it.pub)])).toEqual([['new', ['y']]])
  })

  it('draws no part that arrived under the old relationship, whatever arrived later — the creation, the title, each item on its own', async () => {
    /* ⚠️ One epoch on the whole list, moved by its newest page, re-exposed
       everything the old relationship had retained the moment one item was
       placed under the new one. Each part answers for itself. */
    const { port, lists, records } = world()
    records.set(BOB, { ...newRelationship(BOB, at(0)), epoch: 2 })
    lists.set(
      BOB,
      new Map([
        /* Created under the old relationship, an item placed under the new: not drawn — its existence is old. */
        ['revived', listHeld({ createdEpoch: 1, title: title('Old', 1), items: [item('x', 1), item('y', 2)] })],
        /* Created under the new, its title retitled under… the old? Impossible by order — but a title's epoch is its own: an old one is not drawn. */
        ['retitled', listHeld({ createdEpoch: 2, title: title('Stale', 1), items: [item('z', 2)] })],
      ]),
    )
    const view = await port.friend(BOB)
    expect(view.lists.map((one) => [one.id, one.title, one.items.map((it) => it.pub)])).toEqual([['retitled', '', ['z']]])
  })

  it('keeps a deletion whatever its epoch — a withdrawal is never revived by a re-admission', async () => {
    const { port, lists, records } = world()
    records.set(BOB, { ...newRelationship(BOB, at(0)), epoch: 2 })
    lists.set(BOB, new Map([['gone', listHeld({ createdEpoch: 2, title: title('Gone', 2), deleted: true, items: [item('x', 2)] })]]))
    expect((await port.friend(BOB)).lists).toEqual([])
  })
})

describe('a friend’s jackets, a few at a time — WI-23.C5', () => {
  const book = (pub: string): FriendBook => ({ pub, title: 'T', author: 'A', language: 'en', own: null, device: 'd1', cover: 'ab'.repeat(32) })

  it('fetches at most COVER_WIDTH at once, the rest waiting their turn', async () => {
    let inFlight = 0
    let most = 0
    const releases: (() => void)[] = []
    const coverOf = vi.fn(() => {
      inFlight += 1
      most = Math.max(most, inFlight)
      return new Promise<Uint8Array | null>((done) => {
        releases.push(() => {
          inFlight -= 1
          done(new Uint8Array([0xff, 0xd8, 0xff]))
        })
      })
    })
    const { port } = world({ coverOf })
    const asked = Array.from({ length: COVER_WIDTH + 3 }, (_, i) => port.cover(BOB, book(`s${i}`)))
    await new Promise((done) => setTimeout(done, 0))
    expect(coverOf).toHaveBeenCalledTimes(COVER_WIDTH)
    while (releases.length > 0) {
      releases.shift()!()
      await new Promise((done) => setTimeout(done, 0))
    }
    expect((await Promise.all(asked)).every((one) => one?.startsWith('data:image/jpeg'))).toBe(true)
    expect(most).toBe(COVER_WIDTH)
    expect(coverOf).toHaveBeenCalledTimes(COVER_WIDTH + 3)
  })

  it('does not dial for a request abandoned before its turn, and answers it null', async () => {
    const coverOf = vi.fn(() => Promise.resolve<Uint8Array | null>(null))
    const { port } = world({ coverOf })
    /* Every slot taken, then one more that is abandoned before a slot frees. */
    const held = Array.from({ length: COVER_WIDTH }, (_, i) => port.cover(BOB, book(`s${i}`)))
    const abandon = new AbortController()
    const waiting = port.cover(BOB, book('late'), abandon.signal)
    abandon.abort()
    await Promise.all(held)
    expect(await waiting).toBeNull()
    expect(coverOf).toHaveBeenCalledTimes(COVER_WIDTH)
    /* Abandoned before it was even asked: null, no dial. */
    const gone = new AbortController()
    gone.abort()
    expect(await port.cover(BOB, book('never'), gone.signal)).toBeNull()
    expect(coverOf).toHaveBeenCalledTimes(COVER_WIDTH)
  })

  it('reports a fetch that failed through the diagnostics, and draws nothing', async () => {
    const warn = vi.fn()
    const { port } = world({ coverOf: () => Promise.reject(new Error('the disk said no')), warn })
    expect(await port.cover(BOB, book('s1'))).toBeNull()
    expect(warn).toHaveBeenCalledWith('circle.cover-failed', expect.objectContaining({ person: BOB, pub: 's1', message: 'the disk said no' }))
  })

  it('answers null and says so when the RECORD read fails — the whole of it is caught, not the fetch alone', async () => {
    /* A rejection from the relationship read left `cover` rejecting, and the
       row's empty handler swallowed it with no record anywhere. */
    const warn = vi.fn()
    const { port } = world({ relationship: () => Promise.reject(new Error('the record would not read')), warn })
    await expect(port.cover(BOB, book('s1'))).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith('circle.cover-failed', expect.objectContaining({ person: BOB, pub: 's1', message: 'the record would not read' }))
  })

  it('hands the row’s signal to the transfer, so abandoning the row can stop the bytes', async () => {
    const coverOf = vi.fn((_person: string, _device: string, _pub: string, _digest: string, _signal?: AbortSignal) => Promise.resolve(null))
    const { port } = world({ coverOf })
    const abandon = new AbortController()
    await port.cover(BOB, book('s1'), abandon.signal)
    expect(coverOf).toHaveBeenCalledTimes(1)
    expect(coverOf.mock.calls[0]![4]).toBe(abandon.signal)
  })
})

describe('a person’s turn, let go', () => {
  it('holds no turn once every act on the person has settled', async () => {
    /* A port that outlives a thousand toggles must not hold a thousand promises. */
    const { port } = world()
    await port.setShowsShelf(BOB, true)
    await port.setShowsShelf(BOB, false)
    await new Promise((done) => setTimeout(done, 0))
    expect(port.pendingTurns()).toBe(0)
    const flips = Promise.all([port.setShowsShelf(BOB, true), port.setShowsShelf(BOB, false)])
    expect(port.pendingTurns()).toBe(1)
    await flips
    await new Promise((done) => setTimeout(done, 0))
    expect(port.pendingTurns()).toBe(0)
  })
})

describe('a jacket for a person the record no longer admits', () => {
  it('is neither fetched nor answered from disk', async () => {
    const coverOf = vi.fn(() => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff])))
    const { port, records } = world({ coverOf })
    records.set(BOB, { ...newRelationship(BOB, at(0)), state: 'exited' })
    const book: FriendBook = { pub: 's1', title: 'T', author: 'A', language: 'en', own: null, device: 'd1', cover: 'ab'.repeat(32) }
    expect(await port.cover(BOB, book)).toBeNull()
    expect(coverOf).not.toHaveBeenCalled()
  })
})
