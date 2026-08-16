import { describe, expect, it } from 'vitest'
import { folderOf, trashOf } from './bookFolder'
import { TRASH_DAYS, emptyExpired, restoreBook, trashBook, type TrashFs } from './bookTrash'

/**
 * Removing a book takes the reader's tags, their place in it and their marks
 * with it — because those live in its folder. That is not a file the reader
 * owns; it is what they wrote. So the folder moves rather than going away.
 */

function fakeFs(files: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(files)) store.set(k, new TextEncoder().encode(v))
  const fs: TrashFs & { store: Map<string, Uint8Array> } = {
    store,
    readDir: async (path) => {
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (!key.startsWith(`${path}/`)) continue
        const head = key.slice(path.length + 1).split('/')[0]
        if (head) names.add(head)
      }
      return [...names].map((name) => ({ name, isDirectory: !name.includes('.') }))
    },
    readFile: async (path) => {
      const bytes = store.get(path)
      if (!bytes) throw new Error('missing')
      return bytes
    },
    writeFile: async (path, bytes) => void store.set(path, bytes),
    // A prefix match, because these are directories.
    exists: async (path) => [...store.keys()].some((k) => k === path || k.startsWith(`${path}/`)),
    mkdir: async () => {},
    remove: async (path) => void store.delete(path),
    removeDir: async (path) => {
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key)
      }
    },
    rename: async (from, to) => {
      for (const key of [...store.keys()]) {
        if (key !== from && !key.startsWith(`${from}/`)) continue
        const bytes = store.get(key)!
        store.set(key === from ? to : `${to}${key.slice(from.length)}`, bytes)
        store.delete(key)
      }
    },
  }
  return fs
}

const shelved = (id = 'book_a') => ({
  [`${folderOf(id)}/book.json`]: '{"title":"Moby-Dick","author":"M","tags":["Sea"]}',
  [`${folderOf(id)}/content.epub`]: 'WHALE',
  [`${folderOf(id)}/marks.json`]: '[{"cfi":"x"}]',
})

describe('trashBook', () => {
  it('moves the whole folder, marks and all', async () => {
    const fs = fakeFs(shelved())
    expect(await trashBook(fs, 'book_a')).toBe(true)
    expect(fs.store.has(`${folderOf('book_a')}/book.json`)).toBe(false)
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(true)
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
  })

  it('reports nothing to remove for a book that is not there', async () => {
    expect(await trashBook(fakeFs(), 'book_a')).toBe(false)
  })
})

describe('restoreBook', () => {
  /**
   * The property that makes removal safe to offer.
   *
   * Re-adding the same bytes lands on the same folder name, because the id is
   * derived from content — so a reader who removes a book and adds it again
   * finds their highlights waiting, and nothing had to remember they might.
   */
  it('puts a book back with everything it owned', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(new TextDecoder().decode(fs.store.get(`${folderOf('book_a')}/book.json`)!)).toContain(
      'Sea',
    )
    expect(fs.store.has(`${folderOf('book_a')}/marks.json`)).toBe(true)
  })

  it('does not leave the removal stamp behind', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    await restoreBook(fs, 'book_a')
    expect(fs.store.has(`${folderOf('book_a')}/.removed`)).toBe(false)
  })

  it('reports nothing to restore when the trash is empty', async () => {
    expect(await restoreBook(fakeFs(), 'book_a')).toBe(false)
  })
})


describe('emptyExpired', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('deletes a book that has been in the trash longer than its stay', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    const gone = await emptyExpired(fs, Date.now() + (TRASH_DAYS + 1) * DAY)
    expect(gone).toEqual(['book_a'])
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(false)
  })

  it('leaves one that is still within its stay', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    expect(await emptyExpired(fs, Date.now() + DAY)).toEqual([])
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(true)
  })

  /**
   * Erring towards KEEPING, which is the only direction that cannot lose work.
   *
   * A folder with no stamp — hand-moved, or written by a version that did not
   * stamp — has no age, and deleting something of unknown age to reclaim disk is
   * the wrong trade against somebody's annotations.
   */
  it('leaves a folder whose stamp is missing or unreadable', async () => {
    const fs = fakeFs({ [`${trashOf('book_a')}/book.json`]: '{}' })
    expect(await emptyExpired(fs, Date.now() + 10_000 * DAY)).toEqual([])
    fs.store.set(`${trashOf('book_a')}/.removed`, new TextEncoder().encode('not a number'))
    expect(await emptyExpired(fs, Date.now() + 10_000 * DAY)).toEqual([])
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(true)
  })

  it('is quiet when there is no trash at all', async () => {
    expect(await emptyExpired(fakeFs())).toEqual([])
  })
})

/**
 * The case restore was actually asked for, and refused.
 *
 * An import writes `content.epub` FIRST and puts the book on the shelf second,
 * so by the time anything calls `restoreBook` the live folder already exists.
 * Renaming the trashed folder onto it fails, and returning false there left the
 * reader's tags, place and marks in the trash — at the exact moment
 * content-derived identity was about to hand them back.
 */
describe('restoring onto a folder that is already there', () => {
  const withContentOnly = (id = 'book_a') => ({
    [`${folderOf(id)}/content.epub`]: 'FRESH BYTES',
  })

  it('brings back the record and the marks', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    // The import lands while the old copy is still in the trash.
    for (const [k, v] of Object.entries(withContentOnly())) {
      fs.store.set(k, new TextEncoder().encode(v))
    }
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(new TextDecoder().decode(fs.store.get(`${folderOf('book_a')}/book.json`)!)).toContain(
      'Sea',
    )
    expect(fs.store.has(`${folderOf('book_a')}/marks.json`)).toBe(true)
  })

  /* The bytes just written WIN. They are the current copy; the trashed one is
   * the same book by definition, since the id is the content. */
  it('keeps the freshly imported content rather than the trashed copy', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/content.epub`, new TextEncoder().encode('FRESH BYTES'))
    await restoreBook(fs, 'book_a')
    expect(new TextDecoder().decode(fs.store.get(`${folderOf('book_a')}/content.epub`)!)).toBe(
      'FRESH BYTES',
    )
  })

  it('empties the trash entry behind it', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/content.epub`, new TextEncoder().encode('FRESH'))
    await restoreBook(fs, 'book_a')
    expect([...fs.store.keys()].some((k) => k.startsWith(`${trashOf('book_a')}/`))).toBe(false)
  })
})

/**
 * A restore that cannot finish must not delete what it failed to move.
 *
 * The first entry-by-entry version swallowed each rename failure and then
 * emptied the trash regardless — so an entry that failed to move was deleted
 * instead. A restore that loses the thing it is restoring is worse than one
 * that refuses.
 */
describe('restoring when something is in the way', () => {
  it('leaves a trashed file behind rather than deleting it, when a live one wins', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    // A live marks file, which is the collision that would cost the reader work.
    fs.store.set(`${folderOf('book_a')}/marks.json`, new TextEncoder().encode('[]'))
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
    // The record still came back — one collision does not stop the rest.
    expect(fs.store.has(`${folderOf('book_a')}/book.json`)).toBe(true)
  })

  it('keeps the stamp on what it left, so the sweep can still age it', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/marks.json`, new TextEncoder().encode('[]'))
    await restoreBook(fs, 'book_a')
    expect(fs.store.has(`${trashOf('book_a')}/.removed`)).toBe(true)
    const DAY = 24 * 60 * 60 * 1000
    expect(await emptyExpired(fs, Date.now() + (TRASH_DAYS + 1) * DAY)).toEqual(['book_a'])
  })

  it('does not delete an entry whose move failed', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    const rename = fs.rename
    fs.rename = async (from, to) => {
      if (from.endsWith('marks.json')) throw new Error('locked')
      return rename(from, to)
    }
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
  })
})
