import { describe, expect, it } from 'vitest'
import type { IndexedBook } from '../bookIndex'
import { fakeFs } from '../fakeFs.testkit'
import { createKernelServices } from '../services'
import { tagRename } from './tag'

/**
 * **THE SNAPSHOT AUTHORISES; THE WRITER ANSWERS.**
 *
 * `tag.rename` counted the shelf BEFORE the write and used that one number
 * twice — to decide whether to refuse, and as the result. `tag.add` and
 * `tag.remove` were both moved off that pattern; this is the third of the
 * three, and until now the only one whose `books` described the shelf as it
 * stood when the request arrived rather than what the mutator moved.
 */
const RECORD = (bookId: string, tags: readonly string[]) =>
  JSON.stringify({ bookId, title: bookId, author: '', tags })

const ROW = (bookId: string, tags: readonly string[]): IndexedBook =>
  ({ bookId, title: bookId, author: '', tags, hasContent: true }) as IndexedBook

describe('tag.rename', () => {
  const world = () => {
    const fs = fakeFs({
      'books/one/book.json': RECORD('one', ['Sea']),
      'books/two/book.json': RECORD('two', ['Sea']),
    })
    const services = createKernelServices({
      fs,
      storage: null,
      initialBooks: [ROW('one', ['Sea']), ROW('two', ['Sea'])],
    })
    return { fs, env: { services } }
  }

  it('reports the books the writer actually changed', async () => {
    const { env } = world()
    expect(await tagRename(env)({ from: 'Sea', to: 'Ocean' })).toEqual({ tag: 'Ocean', books: 2 })
  })

  it('counts one rename per book when two run at once', async () => {
    /* The optimistic row moves as soon as the first call is made, so the
       second finds nothing to rename — the shelf ends under one name with
       every book that carried the original under it. */
    const { env } = world()
    const settled = await Promise.allSettled([
      tagRename(env)({ from: 'Sea', to: 'Ocean' }),
      tagRename(env)({ from: 'Sea', to: 'Water' }),
    ])

    const done = settled.filter((one) => one.status === 'fulfilled')
    expect(done).toHaveLength(1)
    expect(done[0]?.status === 'fulfilled' ? done[0].value : null).toEqual({ tag: 'Ocean', books: 2 })
  })

  it('refuses a tag no book carries, without reading a record to find out', async () => {
    const { env } = world()
    await expect(tagRename(env)({ from: 'Whales', to: 'Ocean' })).rejects.toMatchObject({ code: 'not-found' })
  })
})
