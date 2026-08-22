import { describe, expect, it } from 'vitest'
import { FORBIDDEN, refusalCode, serveTable } from './serviceTable.testkit'

/**
 * `trash.*` OVER THE REAL ROUTER — the two verbs nothing else can undo.
 *
 * The trash held the only handlers in the table with no focused coverage, and
 * they are the ones that matter most: `trash.empty` destroys a reader's work
 * permanently, and `trash.list` is what a caller reads to decide whether to
 * call it. Everything asserted here is a property those two must have and
 * that nothing else in the suite was watching.
 */

const REMOVED = 1_700_000_000_000

/** A trashed book, as the folder actually holds one. */
function trashed(folder: string, fields: { id?: string; title?: string; at?: number | null } = {}) {
  const record = JSON.stringify({ bookId: fields.id ?? folder, title: fields.title ?? `Title ${folder}`, author: 'A' })
  return {
    [`trash/${folder}/book.json`]: record,
    ...(fields.at === null ? {} : { [`trash/${folder}/.removed`]: String(fields.at ?? REMOVED) }),
  }
}

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const page of stream) out.push(page)
  return out
}

describe('trash.list', () => {
  it('answers oldest removal first, unstamped last, ties broken reproducibly', async () => {
    const shelf = serveTable({
      files: {
        ...trashed('newer', { at: REMOVED + 5_000 }),
        ...trashed('older', { at: REMOVED }),
        /* NO STAMP: the sweep will never delete these, so they are the least
         * urgent thing in the list and sort last. Two of them, so the
         * tie-break is exercised rather than assumed. */
        ...trashed('zzz', { at: null }),
        ...trashed('aaa', { at: null }),
      },
    })
    const rows = (await drain(shelf.client.stream('trash.list', {}))).flat() as { bookId: string }[]
    expect(rows.map((one) => one.bookId)).toEqual(['older', 'newer', 'aaa', 'zzz'])
  })

  /**
   * A STAMP LARGER THAN THE SENTINEL USED TO OUTRANK "NO STAMP".
   *
   * The comparator read `removedAt ?? Number.MAX_SAFE_INTEGER` as "sorts
   * last". `removedAt` is a number parsed off a file and any finite one is
   * accepted, so a `.removed` written in microseconds — or edited by hand —
   * landed past the sentinel and sorted AFTER the unstamped entries it was
   * meant to keep at the end.
   */
  it('keeps an unstamped entry last even beside an enormous stamp', async () => {
    const shelf = serveTable({
      files: {
        ...trashed('huge', { at: Number.MAX_SAFE_INTEGER * 4 }),
        ...trashed('none', { at: null }),
        ...trashed('ordinary', { at: REMOVED }),
      },
    })
    const rows = (await drain(shelf.client.stream('trash.list', {}))).flat() as { bookId: string }[]
    expect(rows.map((one) => one.bookId)).toEqual(['ordinary', 'huge', 'none'])
  })

  it('answers the same order twice, so a limited read is not a different set each time', async () => {
    const files = { ...trashed('b', { at: null }), ...trashed('a', { at: null }), ...trashed('c', { at: null }) }
    const first = (await drain(serveTable({ files }).client.stream('trash.list', { limit: 2 }))).flat()
    const again = (await drain(serveTable({ files }).client.stream('trash.list', { limit: 2 }))).flat()
    expect(first).toEqual(again)
    expect(first).toHaveLength(2)
  })

  /* ASKING FOR NOTHING COSTS NOTHING. `pages` yields no page for a limit of
   * zero, so this always LOOKED right — while the scan had already read two
   * files per trashed book to build rows nobody would receive. */
  it('reads nothing at all for a limit of zero', async () => {
    const shelf = serveTable({ files: { ...trashed('a'), ...trashed('b'), ...trashed('c') } })
    const reads: string[] = []
    const real = shelf.fs.readFile.bind(shelf.fs)
    shelf.fs.readFile = async (path: string) => {
      reads.push(path)
      return real(path)
    }
    expect(await drain(shelf.client.stream('trash.list', { limit: 0 }))).toEqual([])
    expect(reads.filter((path) => path.startsWith('trash/'))).toEqual([])

    /* And a non-zero limit still reads — so the assertion above is measuring
     * a skipped scan and not a broken fixture. */
    expect((await drain(shelf.client.stream('trash.list', { limit: 1 }))).flat()).toHaveLength(1)
    expect(reads.filter((path) => path.startsWith('trash/')).length).toBeGreaterThan(0)
  })

  it('is forbidden without its grant, before the handler runs', async () => {
    const shelf = serveTable({ grants: [], files: trashed('a') })
    expect(refusalCode(await drain(shelf.client.stream('trash.list', {})).catch((e: unknown) => e))).toBe(FORBIDDEN)
    expect(shelf.ran).not.toContain('trash.list')
  })
})

describe('trash.empty', () => {
  const ADMIN = ['shelf:*', 'book:*', 'mark:*', 'card:*', 'device:*']

  it('refuses a count that does not match, naming both numbers', async () => {
    const shelf = serveTable({ grants: ADMIN, files: { ...trashed('a'), ...trashed('b') } })
    const failure = await shelf.client.call('trash.empty', { count: 1 }).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('conflict')
    expect(String(failure)).toMatch(/holds 2 books, not 1/)
    /* And nothing was deleted. */
    expect((await drain(shelf.client.stream('trash.list', {}))).flat()).toHaveLength(2)
  })

  /**
   * THE SWAP THE COUNT CANNOT SEE.
   *
   * One book restored and another trashed leaves the count unchanged, so a
   * caller who reviewed the first list would destroy a book nobody looked at.
   * The membership list is what turns "as many as you saw" into "exactly what
   * you saw".
   */
  it('refuses a membership that changed while the count stayed the same', async () => {
    const shelf = serveTable({ grants: ADMIN, files: { ...trashed('a'), ...trashed('b') } })
    const failure = await shelf.client.call('trash.empty', { count: 2, books: ['a', 'c'] }).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('conflict')
    expect(String(failure)).toMatch(/now also holding b/)
    expect(String(failure)).toMatch(/no longer holding c/)
    expect((await drain(shelf.client.stream('trash.list', {}))).flat()).toHaveLength(2)
  })

  it('destroys exactly what was confirmed, and says which', async () => {
    const shelf = serveTable({ grants: ADMIN, files: { ...trashed('a'), ...trashed('b') } })
    expect(await shelf.client.call('trash.empty', { count: 2, books: ['a', 'b'] })).toEqual({
      emptied: 2,
      bookIds: ['a', 'b'],
    })
    expect((await drain(shelf.client.stream('trash.list', {}))).flat()).toEqual([])
    expect([...shelf.fs.store.keys()].some((path) => path.startsWith('trash/'))).toBe(false)
  })

  /**
   * A PARTIAL DESTROY IS NOT A SUCCESS, and it is NOT RETRYABLE.
   *
   * The confirmation is a count, and any deletion that did succeed has
   * already changed it — so an automatic retry of the identical request can
   * only fail the count check and look like a second, different fault.
   */
  it('refuses when only some entries could be removed, and is not retryable', async () => {
    const shelf = serveTable({ grants: ADMIN, files: { ...trashed('a'), ...trashed('b') } })
    const real = shelf.fs.removeDir.bind(shelf.fs)
    shelf.fs.removeDir = async (path: string) => {
      if (path.endsWith('/b')) throw new Error('EACCES')
      return real(path)
    }
    const failure = await shelf.client.call('trash.empty', { count: 2 }).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('unwritable')
    expect(String(failure)).toMatch(/deleted 1 of 2; still in the trash: b/)
    expect((failure as { error?: { retryable?: boolean } }).error?.retryable).toBe(false)
    /* The one that could not go is still there, so a caller can look again. */
    expect((await drain(shelf.client.stream('trash.list', {}))).flat()).toHaveLength(1)
  })

  /* THE GRANT IS `shelf:admin`, not `book:write`. The one irreversible verb in
   * the table does not travel with ordinary write access. */
  it('is forbidden to a peer holding every other grant', async () => {
    const shelf = serveTable({ grants: ['book:*', 'mark:*', 'card:*', 'device:*'], files: trashed('a') })
    expect(refusalCode(await shelf.client.call('trash.empty', { count: 1 }).catch((e: unknown) => e))).toBe(FORBIDDEN)
    expect(shelf.ran).not.toContain('trash.empty')
  })
})
