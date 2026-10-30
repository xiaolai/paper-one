import { describe, expect, it } from 'vitest'
import { FORBIDDEN, refusalCode, seedBook, serveTable } from './serviceTable.testkit'

/**
 * `tag.*` OVER THE REAL ROUTER — the reader's own vocabulary for their shelf.
 *
 * Two properties run through every case here and neither is obvious from the
 * handlers:
 *
 *   1. A tag folds by KEY. `Sea` and `sea` are one tag, and so is a
 *      publisher's `SEA` — so "does this book carry it" is never a string
 *      comparison.
 *   2. The count in the answer comes from the WRITER, not from a snapshot. A
 *      book whose publisher subjects already carry the key is skipped by the
 *      store while an unrescanned row still shows no such tag, so a count
 *      predicted from the shelf reported books as changed that nothing was
 *      written for.
 *
 * `tag.rename` is the destructive one — it rewrites a name across every book
 * that carries it — and had no service-level test at all.
 */

/** A book whose record carries the given reader tags and publisher subjects. */
function book(id: string, tags: readonly string[] = [], subjects: readonly string[] = []) {
  return seedBook(id, { ...(tags.length ? { tags } : {}), ...(subjects.length ? { subjects } : {}) })
}

const ADMIN = ['book:*', 'mark:*', 'card:*', 'device:*', 'shelf:*']

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const page of stream) out.push(page)
  return out
}

/** What `books/<id>/book.json` holds now. */
function record(shelf: ReturnType<typeof serveTable>, id: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(shelf.fs.store.get(`books/${id}/book.json`) as Uint8Array))
}

describe('tag.add and tag.remove', () => {
  it('counts the books the store actually wrote, not the ones asked for', async () => {
    const shelf = serveTable({ books: [book('one'), book('two', ['sea'])] })
    /* Two named, one already carrying it. */
    expect(await shelf.client.call('tag.add', { tag: 'sea', book: ['one', 'two'] })).toEqual({ tag: 'sea', books: 1 })
    /* And nothing to remove is nothing removed. */
    expect(await shelf.client.call('tag.remove', { tag: 'nothing', book: ['one'] })).toEqual({
      tag: 'nothing',
      books: 0,
    })
  })

  /**
   * A PUBLISHER'S SUBJECT ALREADY CARRIES THE TAG.
   *
   * The store folds a book's own tags AND its `subjects` together, so a book
   * whose publisher already said `Philosophy` is skipped by `tag.add
   * philosophy`. Counting from the in-memory row instead reported that book
   * as changed with nothing written for it — and the row and the record can
   * legitimately disagree, because an unrescanned row has no subjects on it.
   */
  it('does not count a book whose publisher subject already folds to the tag', async () => {
    const shelf = serveTable({ books: [book('one', [], ['Philosophy']), book('two')] })
    expect(await shelf.client.call('tag.add', { tag: 'philosophy', book: ['one', 'two'] })).toEqual({
      tag: 'philosophy',
      books: 1,
    })
    /* The record for `one` was genuinely not rewritten. */
    expect(record(shelf, 'one').tags).toBeUndefined()
  })

  it('counts one book once, however many times a caller names it', async () => {
    const shelf = serveTable({ books: [book('one')] })
    expect(await shelf.client.call('tag.add', { tag: 'sea', book: ['one', 'one', 'one'] })).toEqual({
      tag: 'sea',
      books: 1,
    })
  })

  /* AN EXPLICITLY EMPTY LIST IS NOT "THE WHOLE SHELF". `--book ,,` collapses
   * to `[]`, and reading that as every book turns a selection the caller
   * believes is empty into a bulk mutation. */
  it('refuses an empty book list rather than untagging the shelf', async () => {
    const shelf = serveTable({ books: [book('one', ['sea']), book('two', ['sea'])] })
    const failure = await shelf.client.call('tag.remove', { tag: 'sea', book: [] }).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('malformed')
    expect(String(failure)).toMatch(/omit it entirely/)
    expect(record(shelf, 'one').tags).toEqual(['sea'])
  })

  /* OMITTING IT DOES mean the whole shelf, and answers how many carried it. */
  it('removes a tag shelf-wide when no book is named', async () => {
    const shelf = serveTable({ books: [book('one', ['sea']), book('two', ['sea']), book('three')] })
    expect(await shelf.client.call('tag.remove', { tag: 'sea' })).toEqual({ tag: 'sea', books: 2 })
    const rows = (await drain(shelf.client.stream('tag.list', {}))).flat() as { tag: string }[]
    expect(rows.map((one) => one.tag)).not.toContain('sea')
  })
})

describe('tag.rename', () => {
  it('carries every book over and answers with the new name', async () => {
    const shelf = serveTable({ books: [book('one', ['sea']), book('two', ['Sea']), book('three', ['land'])] })
    /* Folded: `sea` and `Sea` are one tag, so both books move. */
    expect(await shelf.client.call('tag.rename', { from: 'sea', to: 'ocean' })).toEqual({ tag: 'ocean', books: 2 })
    const rows = (await drain(shelf.client.stream('tag.list', {}))).flat() as { tag: string; count: number }[]
    expect(rows.find((one) => one.tag === 'ocean')?.count).toBe(2)
    expect(rows.find((one) => one.tag === 'sea')).toBeUndefined()
  })

  /* RENAMING ONTO AN EXISTING NAME MERGES rather than failing. Tags fold by
   * key, so the books end up under one tag — which is what a reader who typed
   * the other spelling meant. */
  it('merges into a tag that already exists', async () => {
    const shelf = serveTable({ books: [book('one', ['sea']), book('two', ['ocean'])] })
    expect(await shelf.client.call('tag.rename', { from: 'sea', to: 'ocean' })).toEqual({ tag: 'ocean', books: 1 })
    const rows = (await drain(shelf.client.stream('tag.list', {}))).flat() as { tag: string; count: number }[]
    expect(rows.find((one) => one.tag === 'ocean')?.count).toBe(2)
  })

  /**
   * A PUBLISHER'S SUBJECT IS NOT THE READER'S TAG, AND CANNOT BE RENAMED.
   *
   * Subjects are replaced wholesale whenever a book is re-parsed, so a rename
   * of one would be undone by the next parse with nothing saying why. The
   * refusal names the reason rather than reporting zero books changed.
   */
  it('refuses a name only a publisher uses', async () => {
    const shelf = serveTable({ books: [book('one', [], ['Philosophy'])] })
    const failure = await shelf.client.call('tag.rename', { from: 'philosophy', to: 'thought' }).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('not-found')
    expect(String(failure)).toMatch(/as your own tag/)
    /* Untouched. */
    expect(record(shelf, 'one').subjects).toEqual(['Philosophy'])
  })

  it('refuses a name nothing carries', async () => {
    const shelf = serveTable({ books: [book('one', ['sea'])] })
    expect(
      refusalCode(await shelf.client.call('tag.rename', { from: 'nothing', to: 'x' }).catch((e: unknown) => e)),
    ).toBe('not-found')
  })

  /* THE BOUNDS ARE THE TABLE'S, on both ends of a destructive verb. */
  it('refuses an overlong or empty spelling on either side', async () => {
    const shelf = serveTable({ books: [book('one', ['sea'])] })
    const long = 'x'.repeat(500)
    for (const body of [{ from: long, to: 'x' }, { from: 'sea', to: long }, { from: '  ', to: 'x' }, { from: 'sea', to: '  ' }]) {
      expect(refusalCode(await shelf.client.call('tag.rename', body).catch((e: unknown) => e)), JSON.stringify(body)).toBe(
        'malformed',
      )
    }
    expect(record(shelf, 'one').tags).toEqual(['sea'])
  })

  it('is forbidden without book:write, before the handler runs', async () => {
    const shelf = serveTable({ grants: ['book:read'], books: [book('one', ['sea'])] })
    expect(
      refusalCode(await shelf.client.call('tag.rename', { from: 'sea', to: 'ocean' }).catch((e: unknown) => e)),
    ).toBe(FORBIDDEN)
    expect(shelf.ran).not.toContain('tag.rename')
  })

  /* CONCURRENT RENAMES DO NOT INTERLEAVE INTO A THIRD ANSWER. Each runs
   * whole, so the shelf ends under one of the two names and every book that
   * carried the original is under it. */
  it('serialises two renames of the same tag', async () => {
    const shelf = serveTable({ grants: ADMIN, books: [book('one', ['sea']), book('two', ['sea'])] })
    const [first, second] = await Promise.allSettled([
      shelf.client.call('tag.rename', { from: 'sea', to: 'ocean' }),
      shelf.client.call('tag.rename', { from: 'sea', to: 'water' }),
    ])
    /* One of them found the tag; whichever ran second found nothing to
     * rename and said so rather than reporting a rename that did not
     * happen. */
    const settled = [first, second]
    expect(settled.filter((one) => one.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    const rows = (await drain(shelf.client.stream('tag.list', {}))).flat() as { tag: string; count: number }[]
    expect(rows.filter((one) => one.tag === 'sea')).toEqual([])
    const landed = rows.filter((one) => one.tag === 'ocean' || one.tag === 'water')
    expect(landed.reduce((sum, one) => sum + one.count, 0)).toBe(2)
  })
})
