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

/**
 * `hasContent` is DERIVED by the scan and is not part of a record — so the cache
 * has to carry it explicitly or it is gone on the next launch.
 *
 * It was not, and rebuilding a cached entry through `parseRecord` dropped it.
 * `canOpen` reads `!== false`, so every row for a book Paper has no bytes for
 * came back enabled: the shelf told the truth exactly once, on the launch that
 * happened to rescan, and lied on every launch after it.
 */
describe('the cache remembers which books have bytes', () => {
  it('carries hasContent back out of the index', () => {
    const raw = JSON.stringify({
      version: 1,
      books: [
        { bookId: 'a', title: 'Has', author: '', hasContent: true },
        { bookId: 'b', title: 'Has not', author: '', hasContent: false },
      ],
    })
    const books = parseIndex(raw)!
    expect(books[0]?.hasContent).toBe(true)
    expect(books[1]?.hasContent).toBe(false)
  })

  it('leaves it unset for an index written before it was recorded', () => {
    const raw = JSON.stringify({ version: 1, books: [{ bookId: 'a', title: 'Old', author: '' }] })
    expect(parseIndex(raw)![0]).not.toHaveProperty('hasContent')
  })

  it('survives a round trip through writeIndex', async () => {
    const fs = fakeFs({})
    await writeIndex(fs, [{ bookId: 'a', title: 'T', author: '', hasContent: false }])
    const stored = new TextDecoder().decode(fs.store.get(INDEX_FILE)!)
    expect(parseIndex(stored)![0]?.hasContent).toBe(false)
  })
})

/**
 * An index written before `hasContent` was recorded is not trusted.
 *
 * `canOpen` reads an absent flag as openable, so believing such a cache put
 * rows for books Paper has no bytes for back on the shelf looking perfectly
 * fine — the shelf told the truth on the launch that scanned and lied on every
 * launch after it. One rescan fixes it permanently, because the index that
 * rescan writes carries the flag.
 */
describe('a cache from before the flag existed', () => {
  it('is rescanned rather than believed', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: '{"title":"Moby-Dick","author":"M"}',
      [INDEX_FILE]: JSON.stringify({
        version: 1,
        books: [{ bookId: 'book_a', title: 'Moby-Dick', author: 'M' }],
      }),
    })
    const { rescanned, books } = await loadShelf(fs)
    expect(rescanned).toBe(true)
    expect(books[0]?.hasContent).toBe(false)
  })

  it('is believed once it carries the flag', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: '{"title":"Moby-Dick","author":"M"}',
      [INDEX_FILE]: JSON.stringify({
        version: 1,
        books: [{ bookId: 'book_a', title: 'Moby-Dick', author: 'M', hasContent: false }],
      }),
    })
    expect((await loadShelf(fs)).rescanned).toBe(false)
  })
})

/**
 * A stored id is trusted only where it lives.
 *
 * Carrying a book onto a new id renames its directory atomically and stamps the
 * record afterwards, and the second step can fail on its own — leaving a record
 * claiming an id that resolves to a folder that is not there. The directory
 * wins, so the next write stamps it straight and nothing points at nothing.
 */
describe('a record whose id does not match its folder', () => {
  it('takes the id from the directory it is in', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_new/book.json`]: '{"bookId":"book:old","title":"Moby-Dick","author":"M"}',
    })
    const books = await scanBooks(fs)
    expect(books[0]?.bookId).toBe('book_new')
  })

  it('keeps a stored id that does resolve to its folder', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_abc/book.json`]: '{"bookId":"book:abc","title":"Moby-Dick","author":"M"}',
    })
    expect((await scanBooks(fs))[0]?.bookId).toBe('book:abc')
  })
})

/**
 * A library that will not read is not an empty library.
 *
 * `scanBooks` skipped every folder whose record failed and returned `[]`, so a
 * whole library of unreadable records resolved SUCCESSFULLY as empty — and both
 * screens then said "Your library is empty" over books that were all still on
 * disk. One damaged book still costs that book; the whole library failing is
 * reported.
 */
describe('a library whose records will not read', () => {
  it('throws rather than reporting an empty shelf', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: 'half a write',
      [`${BOOKS_DIR}/book_b/book.json`]: 'also broken',
    })
    await expect(scanBooks(fs)).rejects.toThrow('could not be read')
  })

  /* One damaged book among good ones costs that book, which is the rule the
   * scan is written around and the right one. */
  it('still skips a single damaged book when others load', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: 'half a write',
      [`${BOOKS_DIR}/book_b/book.json`]: '{"title":"Moby-Dick","author":"M"}',
    })
    const books = await scanBooks(fs)
    expect(books).toHaveLength(1)
  })

  /* A folder with no record at all is a half-written import, not a failure —
   * it is simply not on the shelf yet. */
  it('is quiet about a folder that has no record yet', async () => {
    const fs = fakeFs({ [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE' })
    expect(await scanBooks(fs)).toEqual([])
  })
})
