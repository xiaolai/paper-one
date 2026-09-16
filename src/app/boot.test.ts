import { describe, expect, it } from 'vitest'
import { finishPendingRemovals, hlcOf, loadShelf, type IndexedBook } from '../kernel'
import { fakeTrashFs } from '../kernel/testkit'
import { CARRY_REFUSED_NOTICE, bootNoticeOf, bootShelf, legacySources, type BootDeps } from './boot'

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
    expect(booted).toEqual({ initialBooks: [], shelfUnread: false, recovered: [], carryRefused: false })
  })

  it('does nothing outside Tauri', async () => {
    const order: string[] = []
    const booted = await bootShelf(deps(order, { fs: null }))
    expect(order).toEqual([])
    expect(booted).toEqual({ initialBooks: [], shelfUnread: false, recovered: [], carryRefused: false })
  })

  /* A MIGRATION WITH NOTHING TO SAY LEAVES NO LINE. `summarise` answers null
     for a run that carried nothing, and "Paper: null" in the console is a
     line somebody would go looking for the cause of. */
  it('says nothing about a migration that had nothing to say', async () => {
    const order: string[] = []
    await bootShelf(deps(order, { summarise: () => null }))
    expect(order).toEqual(['migrate:legacy', 'finish', 'load'])
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
    expect(booted.recovered, 'a recovery that failed reported removals it never finished').toEqual([])
    expect(booted.carryRefused, 'a refused carry was said only to the console').toBe(true)
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

describe('the notice a launch leaves', () => {
  /* ⚠️ **A LIBRARY THAT DID NOT CARRY ACROSS WAS SAID ONLY TO THE CONSOLE**
     (decided 2026-09-14). A migration refused over a damaged legacy value leaves
     those books where they were and loads the shelf without them — and the
     reader saw a shelf missing books with nothing to say why. */
  it('says a refused carry in the notice the app draws, beside what the store said', () => {
    expect(bootNoticeOf(null, { carryRefused: false })).toBeNull()
    expect(bootNoticeOf('The store said this.', { carryRefused: false })).toBe('The store said this.')
    expect(bootNoticeOf(null, { carryRefused: true })).toBe(CARRY_REFUSED_NOTICE)
    expect(bootNoticeOf('The store said this.', { carryRefused: true })).toBe(`The store said this. ${CARRY_REFUSED_NOTICE}`)
    expect(CARRY_REFUSED_NOTICE).toMatch(/could not be carried into your library/u)
    expect(CARRY_REFUSED_NOTICE, 'the reader must hear nothing was lost').toMatch(/Nothing was deleted/u)
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

/**
 * THE PHASE-3 STORES, READ FOR THE MIGRATION.
 *
 * ⚠️ **A MARKS VALUE THAT WOULD NOT READ WAS CARRIED ACROSS AS NO MARKS, AND
 * THE MIGRATION STAMPS.** `bootApp.ts` read `paper.marks.v1` with a fallback of
 * `[]` and logged; the books then migrated without a highlight or note on them,
 * `migrated.json` recorded every one as carried, and a repaired value could
 * never be carried after — `migrateToFolders` short-circuits on the stamp, and
 * on a folder that has a record. The log did not prevent the omission, and a
 * value that was valid JSON of the wrong shape did not even log. Found by the
 * 2026-09-13 verify.
 *
 * DECIDED: THE MIGRATION IS REFUSED, WHOLE. The marks value is ONE value for
 * every book, so there is no "that book" to refuse alone, and `bootShelf`
 * already states the policy this lands in — a migration that cannot run leaves
 * the phase-3 files untouched, which is recoverable. The cost is real and
 * stated: the books wait in the old store until the value reads. The
 * migration's own header says its failure mode is a reader's own writing; a
 * book can be imported again, and a note cannot.
 */
describe('reading the phase-3 stores for the migration', () => {
  const storeOf = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null })
  const ROW = { bookId: 'url_x', title: 'Walden' }
  const MARK = { id: 'm1', bookId: 'url_x', text: 'passage' }

  it('reads nothing stored as nothing to carry', () => {
    expect(legacySources(storeOf({}))).toEqual({ rows: [], marks: [] })
  })

  it('carries both lists as they are, dropping a row that is not a row', () => {
    expect(
      legacySources(
        storeOf({ 'paper.library.v1': JSON.stringify([ROW, null, 7]), 'paper.marks.v1': JSON.stringify([MARK]) }),
      ),
    ).toEqual({ rows: [ROW], marks: [MARK] })
  })

  it('carries rows with no marks value at all — absent marks are none', () => {
    expect(legacySources(storeOf({ 'paper.library.v1': JSON.stringify([ROW]) }))).toEqual({ rows: [ROW], marks: [] })
  })

  it.each([
    ['marks that are not JSON', { 'paper.marks.v1': '[{"id": "m1", trunc' }, /the previous library's marks are not JSON/u],
    ['marks that are an empty string', { 'paper.marks.v1': '' }, /the previous library's marks are not JSON/u],
    ['marks that are an object', { 'paper.marks.v1': JSON.stringify({ m1: MARK }) }, /the previous library's marks are not a list/u],
    ['marks that are JSON null', { 'paper.marks.v1': 'null' }, /the previous library's marks are not a list/u],
    ['rows that are not JSON', { 'paper.library.v1': '[{"bookId"' }, /the previous library's rows are not JSON/u],
    ['rows that are an object', { 'paper.library.v1': JSON.stringify({ url_x: ROW }) }, /the previous library's rows are not a list/u],
  ])('refuses %s rather than carrying them as none', (_name, extra, clause) => {
    const cause = (() => {
      try {
        legacySources(storeOf({ 'paper.library.v1': JSON.stringify([ROW]), 'paper.marks.v1': JSON.stringify([MARK]), ...extra }))
        return null
      } catch (error: unknown) {
        return error
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(clause)
  })

  /* THE PARSER'S OWN ACCOUNT TRAVELS WITH THE REFUSAL, as its cause — the
     console line `bootShelf` writes is where somebody repairing the value
     learns where it stopped reading. */
  it('keeps the parse failure as the cause of a value that is not JSON', () => {
    for (const extra of [{ 'paper.marks.v1': '[{"id": "m1", trunc' }, { 'paper.library.v1': '[{"bookId"' }]) {
      const cause = (() => {
        try {
          legacySources(storeOf(extra))
          return null
        } catch (error: unknown) {
          return error
        }
      })()
      expect(cause).toBeInstanceOf(Error)
      expect((cause as Error).cause).toBeInstanceOf(SyntaxError)
    }
  })

  /* THE WHOLE POINT, through the real order: a refused read is a migration that
     did not run — nothing written, nothing stamped — and the shelf still loads. */
  it('leaves the migration unrun, and the shelf loading, when the marks will not read', async () => {
    const order: string[] = []
    let migrated = false
    const booted = await bootShelf({
      fs: fakeTrashFs(),
      legacy: () => legacySources(storeOf({ 'paper.library.v1': JSON.stringify([ROW]), 'paper.marks.v1': '{}' })),
      migrate: async () => {
        migrated = true
        return 'carried'
      },
      summarise: () => null,
      finishPendingRemovals: async () => [],
      loadShelf: async () => ({ books: [] }),
      report: { info: (m) => order.push(m), error: (m, cause) => order.push(`${m}: ${(cause as Error).message}`) },
    })
    expect(migrated, 'the books were carried across without their marks').toBe(false)
    expect(order).toEqual([
      "Paper: could not carry the previous library across: the previous library's marks are not a list",
    ])
    expect(booted.shelfUnread).toBe(false)
  })
})
