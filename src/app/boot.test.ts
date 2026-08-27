import { describe, expect, it } from 'vitest'
import { finishPendingRemovals, hlcOf, loadShelf, type IndexedBook } from '../kernel'
import { fakeTrashFs } from '../kernel/testkit'
import { bootShelf, type BootDeps } from './boot'

/**
 * THE BOOT ORDER — migrate, finish the removals a crash left, then read the
 * shelf — and the one step of it that nothing had ever called.
 *
 * `finishPendingRemovals` was exported from the kernel, described in three
 * places as running at launch, and called by nobody. The order is asserted
 * with fakes; the recovery itself is asserted with the REAL functions over
 * one in-memory tree, because "the function is called" says nothing about
 * whether the folder the register condemned is gone before a row is built.
 */

type F = ReturnType<typeof fakeTrashFs>

function deps(order: string[], over: Partial<BootDeps<F, string, string>> = {}): BootDeps<F, string, string> {
  return {
    fs: fakeTrashFs(),
    legacy: () => 'legacy',
    migrate: async (_fs, legacy) => {
      order.push(`migrate:${legacy}`)
      return 'carried'
    },
    summarise: (outcomes) => `summary of ${outcomes}`,
    finishPendingRemovals: async () => {
      order.push('finish')
      return []
    },
    loadShelf: async () => {
      order.push('load')
      return { books: [] }
    },
    report: { info: (m) => order.push(`info:${m}`), error: (m) => order.push(`error:${m}`) },
    ...over,
  }
}

describe('the boot order', () => {
  it('migrates, finishes pending removals, then loads the shelf', async () => {
    const order: string[] = []
    const booted = await bootShelf(deps(order))
    expect(order).toEqual(['migrate:legacy', 'info:Paper: summary of carried', 'finish', 'load'])
    expect(booted).toEqual({ initialBooks: [], shelfUnread: false, recovered: [] })
  })

  it('does nothing outside Tauri', async () => {
    const order: string[] = []
    await bootShelf(deps(order, { fs: null }))
    expect(order).toEqual([])
  })

  it('skips the migration when there is no store to read, and says what recovery did', async () => {
    const order: string[] = []
    const booted = await bootShelf(deps(order, { legacy: null, finishPendingRemovals: async () => ['book_a', 'book_b'] }))
    expect(order).toEqual(['info:Paper: finished 2 removals a crash had left half done', 'load'])
    expect(booted.recovered).toEqual(['book_a', 'book_b'])
  })

  it('reports a migration or a recovery that fails and still reads the shelf', async () => {
    const order: string[] = []
    const books: IndexedBook[] = [{ bookId: 'book_a', title: 'A', author: '', openedAt: 1 } as IndexedBook]
    const booted = await bootShelf(
      deps(order, {
        migrate: async () => {
          throw new Error('no')
        },
        finishPendingRemovals: async () => {
          throw new Error('register unreadable')
        },
        loadShelf: async () => ({ books }),
      }),
    )
    expect(order).toEqual([
      'error:Paper: could not carry the previous library across',
      'error:Paper: could not finish pending removals',
    ])
    expect(booted.initialBooks).toBe(books)
    expect(booted.shelfUnread).toBe(false)
  })

  it('reports a shelf that will not load as UNREAD, not as empty', async () => {
    const order: string[] = []
    const booted = await bootShelf(
      deps(order, {
        loadShelf: async () => {
          throw new Error('disk')
        },
      }),
    )
    expect(booted).toMatchObject({ initialBooks: [], shelfUnread: true })
    expect(order.at(-1)).toBe('error:Paper: could not read the library')
  })
})

describe('launch recovery, with the real functions over one tree', () => {
  /**
   * The crash `presence.ts` describes: the register says `removed` at 100,
   * the folder is still live with a record from 50. Nothing called the
   * recovery, so the shelf built a row for a book every peer had been told
   * was gone. Booted: the folder is in the trash, and the shelf has no row.
   */
  it('finishes a removal the crash left half done BEFORE the shelf is read', async () => {
    const fs = fakeTrashFs({
      'books/book_a/book.json': JSON.stringify({ bookId: 'book_a', title: 'Gone', author: '', addedAt: 50 }),
      'books/book_a/content.epub': 'bytes',
      'books/book_b/book.json': JSON.stringify({ bookId: 'book_b', title: 'Kept', author: '', addedAt: 50 }),
      'books/book_b/content.epub': 'bytes',
      'sync/removed.json': JSON.stringify({ book_a: { state: 'removed', at: hlcOf(100) } }),
    })
    const order: string[] = []
    const booted = await bootShelf({
      fs,
      legacy: null,
      migrate: async () => 'nothing',
      summarise: () => null,
      finishPendingRemovals,
      loadShelf,
      report: { info: (m) => order.push(m), error: (m, cause) => order.push(`${m}: ${String(cause)}`) },
    })
    expect(booted.recovered).toEqual(['book_a'])
    expect(await fs.exists('books/book_a')).toBe(false)
    expect(await fs.exists('trash/book_a/book.json')).toBe(true)
    expect(booted.initialBooks.map((one) => one.bookId)).toEqual(['book_b'])
    expect(order).toEqual(['Paper: finished 1 removal a crash had left half done'])
  })
})
