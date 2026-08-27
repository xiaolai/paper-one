import { describe, expect, it } from 'vitest'
import { fakeFs } from './fakeFs.testkit'
import { makeHlc, type Hlc } from './hlc'
import { createLibrary, type AddOutcome } from './libraryStore'
import { readPresence, writePresence } from './presence'
import { spyRecorder } from './servicesWorld.testkit'
import { writeQueue } from './writeQueue'
import type { BookRecord } from './bookFolder'

/**
 * THE PRESENCE FLIP, ON THE WIRE AND IN THE LANE — the library's half of the
 * fix for a page turn that undid a removal (phase 20, WI-20.1).
 *
 * Three things the ledger relies on, each refuted into existence by a refute
 * round: a re-add of a removed book records a `removed` bracket BEFORE its
 * record, so the wire can tell a restore from a stale edit; an add carrying
 * a stamp is refused inside the lane when the register holds a later
 * removal; and a removal that arrives from elsewhere is judged by the
 * register and moves the folder in the same lane task.
 */
const DEV = 'a1b2c3d4e5f60718'
const t = (ms: number): Hlc => makeHlc(ms, 0, DEV)
const rec = (title: string): BookRecord => ({ title, author: 'A', addedAt: 50 })

function world(files: Record<string, string> = {}, now = 1_000) {
  const fs = fakeFs(files)
  const spy = spyRecorder()
  let wall = now
  const library = createLibrary({ fs, queue: writeQueue(), initial: [], recorder: spy.recorder, clock: () => t(++wall) })
  return { fs, spy, library, presence: async () => (await readPresence(fs))['book_a'] }
}

describe('a re-add of a removed book', () => {
  it('records the flip as a removed bracket, then the record — and restores from the trash', async () => {
    const { fs, spy, library, presence } = world({
      'trash/book_a/book.json': JSON.stringify({ bookId: 'book_a', title: 'A', author: 'A', addedAt: 50, tags: ['Sea'] }),
      'trash/book_a/.removed': '900',
    })
    await writePresence(fs, { book_a: { state: 'removed', at: t(900) } })
    const outcome: AddOutcome = await library.add('book_a', rec('A'))
    expect(outcome).toBe('added')
    expect(spy.kinds).toEqual(['removed', 'record'])
    expect(spy.commits.map((c) => c.what)).toEqual(['removed', 'record'])
    expect((await presence())?.state).toBe('live')
    expect(await fs.exists('books/book_a/book.json')).toBe(true)
    expect(await fs.exists('trash/book_a')).toBe(false)
  })

  it('records only the record for a book the register never removed', async () => {
    const { spy, library } = world()
    expect(await library.add('book_a', rec('A'))).toBe('added')
    expect(spy.kinds).toEqual(['record'])
  })
})

describe('a guarded add — one that arrived from elsewhere', () => {
  it('is refused inside the lane by a later local removal, leaving nothing behind', async () => {
    const { fs, spy, library, presence } = world({
      'trash/book_a/book.json': JSON.stringify({ bookId: 'book_a', title: 'A', author: 'A', addedAt: 50 }),
      'trash/book_a/.removed': '900',
    })
    await writePresence(fs, { book_a: { state: 'removed', at: t(900) } })
    expect(await library.add('book_a', rec('A'), false, { asOf: t(800) })).toBe('removed-since')
    /* NO BRACKET WAS BEGUN — a begun-and-abandoned one would be recovered
       at the next open as a phantom local commit, and pushed. */
    expect(spy.kinds).toEqual([])
    expect(library.getSnapshot()).toEqual([])
    expect(await fs.exists('books/book_a')).toBe(false)
    expect((await presence())).toEqual({ state: 'removed', at: t(900) })
  })

  it('wins over an earlier removal and stamps the register with the WIRE stamp, not this clock', async () => {
    const { fs, spy, library, presence } = world({
      'trash/book_a/book.json': JSON.stringify({ bookId: 'book_a', title: 'A', author: 'A', addedAt: 50 }),
      'trash/book_a/.removed': '900',
    })
    await writePresence(fs, { book_a: { state: 'removed', at: t(900) } })
    expect(await library.add('book_a', rec('A'), false, { asOf: t(950) })).toBe('added')
    expect(spy.kinds).toEqual(['removed', 'record'])
    expect(await presence()).toEqual({ state: 'live', at: t(950) })
    expect(library.getSnapshot().map((one) => one.bookId)).toEqual(['book_a'])
  })
})

describe('a removal that arrived from elsewhere', () => {
  it('loses to a later register and moves nothing; wins and moves the folder in the lane', async () => {
    const { fs, spy, library, presence } = world({}, 1_000)
    await library.add('book_a', rec('A')) // presence stays unset: never removed
    spy.kinds.length = 0
    /* The book's own record carries stamps near 1_001; a removal from the
       past loses to a live register written LATER than it. */
    await writePresence(fs, { book_a: { state: 'live', at: t(1_500) } })
    expect(await library.noteRemoteRemoval('book_a', t(1_200))).toBe('lost')
    expect(library.getSnapshot().map((one) => one.bookId)).toEqual(['book_a'])
    expect(await fs.exists('books/book_a/book.json')).toBe(true)
    expect(spy.kinds).toEqual([])

    expect(await library.noteRemoteRemoval('book_a', t(1_600))).toBe('removed')
    expect(library.getSnapshot()).toEqual([])
    expect(await fs.exists('trash/book_a/book.json')).toBe(true)
    expect(await presence()).toEqual({ state: 'removed', at: t(1_600) })
    expect(spy.kinds).toEqual(['removed'])
  })

  it('with no row, judges the register alone', async () => {
    const { library, presence } = world()
    expect(await library.noteRemoteRemoval('book_a', t(1_200))).toBe('removed')
    expect(await presence()).toEqual({ state: 'removed', at: t(1_200) })
    expect(await library.noteRemoteRemoval('book_a', t(1_100))).toBe('lost')
  })
})
