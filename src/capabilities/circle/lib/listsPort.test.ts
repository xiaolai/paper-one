import { describe, expect, it, vi } from 'vitest'
import { hlcOf, type Hlc } from '../../../kernel'
import { MAX_LIST_NOTE, MAX_LIST_TITLE, MAX_WORK_FIELD, NOTHING_LISTED, placeOnList, stateOf, type ListFile } from './lists'
import { NO_IDENTITY, NO_SUCH_LIST, TOO_MANY_LISTS, listsPortOver, type ListsDeps } from './listsPort'
import { MAX_LISTS_PER_REQUEST } from './protocol'

/**
 * WI-23.E1 from the screen's side: every act is a row on the list's file,
 * nothing is written without an identity, and two acts in flight land in
 * sequence order.
 */

const DEVICE = 'd'.repeat(64)
const BOOKS = [
  { bookId: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247', languages: ['en'] },
  { bookId: 'book:dune', title: 'Dune', author: 'Frank Herbert', languages: ['en'] },
]

function world(over: Partial<ListsDeps> = {}) {
  const files = new Map<string, ListFile>()
  let tick = 0
  let minted = 0
  const keep = vi.fn((id: string, held: ListFile) => {
    files.set(id, held)
    return Promise.resolve()
  })
  const base: ListsDeps = {
    ids: () => Promise.resolve([...files.keys()].sort()),
    read: (id) => Promise.resolve(files.get(id) ?? NOTHING_LISTED),
    update: async (id, transform) => {
      const held = files.get(id) ?? NOTHING_LISTED
      const next = transform(held)
      if (next !== held) await keep(id, next)
      return next
    },
    books: () => BOOKS,
    device: () => Promise.resolve(DEVICE),
    clock: (): Hlc => hlcOf(++tick),
    mintPub: () => `pub${++minted}`,
    ...over,
  }
  const deps = { ...base, keep }
  return { deps, files, port: listsPortOver(deps) }
}

describe('the reader’s own lists', () => {
  it('creates, places at the end, keeps a placed book’s spot on a second placement, removes, retitles and deletes', async () => {
    const { port, files } = world()
    const id = await port.create('Sea books')
    expect(id).toBe('pub1')
    await port.place(id, 'book:moby', 'start here')
    await port.place(id, 'book:dune')
    let [list] = await port.lists()
    expect(list).toEqual({
      id,
      title: 'Sea books',
      items: [
        { pub: 'pub2', title: 'Moby-Dick', author: 'Herman Melville', position: 1, note: 'start here', bookId: 'book:moby' },
        { pub: 'pub3', title: 'Dune', author: 'Frank Herbert', position: 2, note: '', bookId: 'book:dune' },
      ],
    })
    /* The same book again: the same pub, the same spot, a new note. */
    await port.place(id, 'book:moby', 'read it twice')
    ;[list] = await port.lists()
    expect(list!.items.map((one) => [one.pub, one.position, one.note])).toEqual([
      ['pub2', 1, 'read it twice'],
      ['pub3', 2, ''],
    ])
    await port.takeOff(id, 'pub2')
    await port.retitle(id, 'Whales')
    ;[list] = await port.lists()
    expect(list!.title).toBe('Whales')
    expect(list!.items.map((one) => one.pub)).toEqual(['pub3'])
    /* The file is the log: six rows, in this device's sequence. */
    expect(files.get(id)!.rows.map((row) => [row.op, row.seq])).toEqual([
      ['create', 1],
      ['place', 2],
      ['place', 3],
      ['place', 4],
      ['remove', 5],
      ['retitle', 6],
    ])
    await port.delete(id)
    expect(await port.lists()).toEqual([])
    expect(stateOf(files.get(id)!).deleted).toBe(true)
  })

  it('lists by title, leaves out one never created, and links only the books still on the shelf', async () => {
    const { port, files } = world()
    const z = await port.create('Zebras')
    const a = await port.create('Aardvarks')
    await port.place(a, 'book:moby')
    /* A file of placements with no create is not a list. */
    files.set('stray', { rows: [{ op: 'place', pub: 'x', work: { title: 'T', author: 'A', language: 'en' }, position: 1, note: '', device: DEVICE, seq: 1, at: hlcOf(1) }], sealed: [] })
    /* A placed book that has since left the shelf still shows, unlinked. */
    files.set(z, {
      ...files.get(z)!,
      rows: [...files.get(z)!.rows, { op: 'place', pub: 'gone', work: { title: 'Emma', author: 'Jane Austen', language: 'en' }, position: 1, note: '', device: DEVICE, seq: 2, at: hlcOf(9) }],
    })
    const lists = await port.lists()
    expect(lists.map((one) => one.title)).toEqual(['Aardvarks', 'Zebras'])
    expect(lists[0]!.items[0]!.bookId).toBe('book:moby')
    expect(lists[1]!.items[0]).toMatchObject({ title: 'Emma', bookId: null })
  })

  it('writes nothing without an identity, and says why', async () => {
    const { port, deps } = world({ device: () => Promise.resolve(null) })
    await expect(port.create('L')).rejects.toThrow(NO_IDENTITY)
    await expect(port.place('x', 'book:moby')).rejects.toThrow(NO_IDENTITY)
    await expect(port.takeOff('x', 'p')).rejects.toThrow(NO_IDENTITY)
    await expect(port.retitle('x', 'T')).rejects.toThrow(NO_IDENTITY)
    await expect(port.delete('x')).rejects.toThrow(NO_IDENTITY)
    expect(deps.keep).not.toHaveBeenCalled()
    /* Reading needs nobody. */
    expect(await port.lists()).toEqual([])
  })

  it('refuses to place a book that is not on the shelf, and the next act still runs', async () => {
    const { port, files } = world()
    const id = await port.create('L')
    await expect(port.place(id, 'book:nowhere')).rejects.toThrow(/not on the shelf/u)
    await port.place(id, 'book:dune')
    expect(files.get(id)!.rows.map((row) => row.op)).toEqual(['create', 'place'])
  })

  it('lands two acts in flight in sequence order, and tells a subscriber after each', async () => {
    const { port, files } = world()
    const told = vi.fn()
    const off = port.subscribe(told)
    const id = await port.create('L')
    await Promise.all([port.place(id, 'book:moby'), port.place(id, 'book:dune'), port.retitle(id, 'M')])
    expect(files.get(id)!.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4])
    expect(told).toHaveBeenCalledTimes(4)
    off()
    await port.delete(id)
    expect(told).toHaveBeenCalledTimes(4)
  })

  it('tells nobody after dispose', async () => {
    const { port } = world()
    const told = vi.fn()
    port.subscribe(told)
    port.dispose()
    await port.create('L')
    expect(told).not.toHaveBeenCalled()
  })
})

describe('every clause of the port — one row each', () => {
  it('stamps every row with this device and the clock’s stamp', async () => {
    const { port, files } = world()
    const id = await port.create('L')
    await port.place(id, 'book:moby')
    expect(files.get(id)!.rows.map((row) => [row.device, row.at])).toEqual([
      [DEVICE, hlcOf(1)],
      [DEVICE, hlcOf(2)],
    ])
  })

  it('refuses with the share control’s own sentence', async () => {
    const { port } = world({ device: () => Promise.resolve(null) })
    await expect(port.create('L')).rejects.toThrow('Start a circle to keep a list.')
    expect(NO_IDENTITY).toBe('Start a circle to keep a list.')
  })
})

describe('acts on a list that is not there', () => {
  it('refuse a list never made and one deleted, by name, and write nothing', async () => {
    const { port, deps } = world()
    for (const act of [() => port.retitle('nowhere', 'T'), () => port.place('nowhere', 'book:moby'), () => port.takeOff('nowhere', 'p'), () => port.delete('nowhere')]) {
      await expect(act()).rejects.toThrow(NO_SUCH_LIST)
    }
    expect(deps.keep).not.toHaveBeenCalled()
    const id = await port.create('L')
    await port.delete(id)
    const writes = (deps.keep as ReturnType<typeof vi.fn>).mock.calls.length
    await expect(port.place(id, 'book:moby')).rejects.toThrow(NO_SUCH_LIST)
    await expect(port.retitle(id, 'M')).rejects.toThrow(NO_SUCH_LIST)
    expect((deps.keep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writes)
  })
})

describe('the words a list carries are bounded', () => {
  it('refuses a title or a note the file would not read back, and cuts a work’s fields rather than refusing the book', async () => {
    const w = world()
    await expect(w.port.create('x'.repeat(MAX_LIST_TITLE + 1))).rejects.toThrow(/at most 200 characters/u)
    const id = await w.port.create('Sea books')
    await expect(w.port.retitle(id, 'x'.repeat(MAX_LIST_TITLE + 1))).rejects.toThrow(/at most 200 characters/u)
    await expect(w.port.place(id, 'book:moby', 'x'.repeat(MAX_LIST_NOTE + 1))).rejects.toThrow(/at most 2000 characters/u)
    await w.port.place(id, 'book:moby', 'x'.repeat(MAX_LIST_NOTE))
    const [view] = await w.port.lists()
    expect(view!.items).toHaveLength(1)
  })
})

describe('a list with no room for another position', () => {
  it('refuses the placement rather than minting a position the file would not read', async () => {
    const w = world()
    const id = await w.port.create('Sea books')
    const held = w.files.get(id)!
    w.files.set(id, placeOnList(held, { pub: 'far', work: { title: 'Far', author: 'A', language: 'en' }, position: Number.MAX_SAFE_INTEGER, note: '' }, { device: 'd'.repeat(64), at: hlcOf(5) }))
    await expect(w.port.place(id, 'book:moby')).rejects.toThrow(/no room for another position/u)
  })

  it('still takes a note on a book already placed — no position is minted for an update', async () => {
    const w = world()
    const id = await w.port.create('Sea books')
    await w.port.place(id, 'book:moby')
    const held = w.files.get(id)!
    w.files.set(id, placeOnList(held, { pub: 'far', work: { title: 'Far', author: 'A', language: 'en' }, position: Number.MAX_SAFE_INTEGER, note: '' }, { device: 'd'.repeat(64), at: hlcOf(5) }))
    await expect(w.port.place(id, 'book:moby', 'read this first')).resolves.toBeUndefined()
  })
})

describe('the lists a circle carries, bounded', () => {
  it('refuses one list more than a friend’s request can name a cursor for — deleted lists counted', async () => {
    /* A sixty-fifth list made every request for this reader's lists invalid,
       and their lists stopped reaching anybody. */
    const { port } = world()
    for (let i = 0; i < MAX_LISTS_PER_REQUEST; i++) await port.create(`List ${i}`)
    await expect(port.create('one more')).rejects.toThrow(TOO_MANY_LISTS)
    /* A deleted list is still a file a friend holds a cursor for. */
    const [first] = await port.lists()
    await port.delete(first!.id)
    await expect(port.create('still one more')).rejects.toThrow(TOO_MANY_LISTS)
  })
})

describe('a book whose title is past the field bound', () => {
  it('is placed once, found again on a second placement, and linked back to the shelf — one cut for the work and the claim', async () => {
    /* Cut on the item and not on the claim, the item read as a book the
       reader did not have, and a second placement made a duplicate. */
    const long = { bookId: 'book:long', title: 'x'.repeat(2_000), author: 'Somebody', languages: ['en'] }
    const { port } = world({ books: () => [...BOOKS, long] })
    const id = await port.create('Long ones')
    await port.place(id, 'book:long', 'first')
    await port.place(id, 'book:long', 'second')
    const [list] = await port.lists()
    expect(list!.items).toHaveLength(1)
    expect(list!.items[0]).toMatchObject({ note: 'second', bookId: 'book:long' })
    expect(list!.items[0]!.title).toHaveLength(MAX_WORK_FIELD)
  })
})
