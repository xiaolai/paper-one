import { describe, expect, it } from 'vitest'
import { BOOKS_DIR } from './bookFolder'
import { INDEX_FILE, loadShelf, parseIndex, scanBooks, writeIndex, type IndexFs } from './bookIndex'

/**
 * The index is a CACHE and the folders are the truth.
 *
 * Every case here is one of those two sentences: losing the cache costs a
 * rescan, and a disagreement is settled by the folder.
 */

function fakeFs(files: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(files)) store.set(k, new TextEncoder().encode(v))
  let reads = 0
  const fs: IndexFs & { store: Map<string, Uint8Array>; reads: () => number } = {
    store,
    reads: () => reads,
    readDir: async (path) => {
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (!key.startsWith(`${path}/`)) continue
        const rest = key.slice(path.length + 1)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
      if (names.size === 0 && path === BOOKS_DIR && !store.size) throw new Error('no dir')
      return [...names].map((name) => ({ name, isDirectory: !name.includes('.') }))
    },
    readFile: async (path) => {
      reads += 1
      const bytes = store.get(path)
      if (!bytes) throw new Error(`no such file: ${path}`)
      return bytes
    },
    writeFile: async (path, bytes) => void store.set(path, bytes),
    exists: async (path) => store.has(path),
    mkdir: async () => {},
    remove: async (path) => void store.delete(path),
    removeDir: async (path: string) => {
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key)
      }
    },
    rename: async (from, to) => {
      const bytes = store.get(from)
      if (bytes) store.set(to, bytes)
      store.delete(from)
    },
  }
  return fs
}

const record = (title: string) => JSON.stringify({ title, author: 'A' })

const twoBooks = {
  [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha'),
  [`${BOOKS_DIR}/book_b/book.json`]: record('Beta'),
}

describe('scanBooks', () => {
  it('reads every book folder', async () => {
    const books = await scanBooks(fakeFs(twoBooks))
    expect(books.map((b) => b.title).sort()).toEqual(['Alpha', 'Beta'])
    expect(books.map((b) => b.bookId).sort()).toEqual(['book_a', 'book_b'])
  })

  /* One damaged book should cost that book, not the library. */
  it('skips a folder whose record will not parse, and keeps the rest', async () => {
    const books = await scanBooks(
      fakeFs({ ...twoBooks, [`${BOOKS_DIR}/book_c/book.json`]: 'not json' }),
    )
    expect(books).toHaveLength(2)
  })

  /* A half-written import — content but no record yet — is simply not on the
   * shelf until it is finished. That is correct rather than a special case. */
  it('skips a folder with no record at all', async () => {
    const books = await scanBooks(
      fakeFs({ ...twoBooks, [`${BOOKS_DIR}/book_c/content.epub`]: 'bytes' }),
    )
    expect(books).toHaveLength(2)
  })

  it('is an empty shelf when there is no library yet', async () => {
    expect(await scanBooks(fakeFs())).toEqual([])
  })
})

describe('parseIndex', () => {
  it('reads a cache back', () => {
    const raw = JSON.stringify({ version: 1, books: [{ bookId: 'a', title: 'T', author: 'A' }] })
    expect(parseIndex(raw)).toEqual([{ bookId: 'a', title: 'T', author: 'A' }])
  })

  /* Missing, corrupt and a version we do not know are ONE thing to the caller:
   * rescan. A cache that cannot be read has no claim on anything. */
  it('refuses anything it cannot trust', () => {
    expect(parseIndex(null)).toBeNull()
    expect(parseIndex('not json')).toBeNull()
    expect(parseIndex(JSON.stringify({ version: 2, books: [] }))).toBeNull()
    expect(parseIndex(JSON.stringify({ version: 1, books: 'nope' }))).toBeNull()
  })

  /* Validated through the same parser the folder uses, so the cache cannot hold
   * a shape the record could not. */
  it('drops an entry with no id, and sanitises the rest', () => {
    const raw = JSON.stringify({
      version: 1,
      books: [{ title: 'no id' }, { bookId: 'a', title: 'T', author: 'A', subjects: 42 }],
    })
    const books = parseIndex(raw)
    expect(books).toHaveLength(1)
    expect(books?.[0]?.subjects).toBeUndefined()
  })
})

describe('loadShelf', () => {
  it('uses the cache when it agrees with the folders', async () => {
    const fs = fakeFs(twoBooks)
    await writeIndex(fs, await scanBooks(fs))
    const before = fs.reads()
    const { books, rescanned } = await loadShelf(fs)
    expect(rescanned).toBe(false)
    expect(books).toHaveLength(2)
    // One read for the index, not one per book — the whole reason it exists.
    expect(fs.reads() - before).toBe(1)
  })

  /* Losing the cache is a rescan, not data loss. */
  it('rescans when the cache is missing', async () => {
    const fs = fakeFs(twoBooks)
    const { books, rescanned } = await loadShelf(fs)
    expect(rescanned).toBe(true)
    expect(books).toHaveLength(2)
  })

  it('rescans when the cache is corrupt', async () => {
    const fs = fakeFs({ ...twoBooks, [INDEX_FILE]: 'not json' })
    expect((await loadShelf(fs)).rescanned).toBe(true)
  })

  /**
   * THE FOLDER WINS.
   *
   * A book added or removed outside the app leaves the cache one out, and the
   * count check is what catches it. Deliberately weak: it does not try to detect
   * an edited record, because a reader who edits `book.json` by hand can delete
   * the index.
   */
  it('rescans when a book appeared outside the app', async () => {
    const fs = fakeFs(twoBooks)
    await writeIndex(fs, await scanBooks(fs))
    fs.store.set(`${BOOKS_DIR}/book_c/book.json`, new TextEncoder().encode(record('Gamma')))
    const { books, rescanned } = await loadShelf(fs)
    expect(rescanned).toBe(true)
    expect(books).toHaveLength(3)
  })

  it('rescans when a book disappeared outside the app', async () => {
    const fs = fakeFs(twoBooks)
    await writeIndex(fs, await scanBooks(fs))
    fs.store.delete(`${BOOKS_DIR}/book_b/book.json`)
    expect((await loadShelf(fs)).books).toHaveLength(1)
  })

  it('leaves a usable cache behind after a rescan', async () => {
    const fs = fakeFs(twoBooks)
    await loadShelf(fs)
    expect(fs.store.has(INDEX_FILE)).toBe(true)
    expect((await loadShelf(fs)).rescanned).toBe(false)
  })
})

describe('writeIndex', () => {
  it('leaves no partial cache when the write fails', async () => {
    const fs = fakeFs(twoBooks)
    const failing: IndexFs = {
      ...fs,
      writeFile: async () => {
        throw new Error('disk full')
      },
    }
    await expect(writeIndex(failing, [])).rejects.toThrow('disk full')
    expect(fs.store.has(INDEX_FILE)).toBe(false)
  })
})
