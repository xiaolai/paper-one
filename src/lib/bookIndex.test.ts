import { describe, expect, it, vi } from 'vitest'
import { BOOKS_DIR } from './bookFolder'
import {
  INDEX_FILE,
  hasContentFile,
  invalidateIndex,
  loadShelf,
  parseIndex,
  scanAllMarks,
  scanBooks,
  writeIndex,
  type IndexFs,
} from './bookIndex'
import { fakeFs } from './indexFsFake.testkit'

/**
 * The index is a CACHE and the folders are the truth.
 *
 * Every case here is one of those two sentences: losing the cache costs a
 * rescan, and a disagreement is settled by the folder.
 */

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

  /* ONE BAD ROW COSTS THE WHOLE CACHE. It used to cost only that row — and a
   * cache missing one book still AGREED with the directory (the book's folder
   * is on disk and in `folders` alike), so it was trusted, and the book was
   * hidden on every launch with nothing left to notice. Refusing outright
   * turns the same corruption into one rescan, which rewrites the cache clean. */
  it('refuses the whole cache over one entry it cannot validate', () => {
    const raw = JSON.stringify({
      version: 1,
      books: [{ title: 'no id' }, { bookId: 'a', title: 'T', author: 'A' }],
    })
    expect(parseIndex(raw)).toBeNull()
  })

  /* A bad FIELD is not a bad row: it is bounded by the same parser the folder
   * uses, so the cache cannot hold a shape the record could not. */
  it('sanitises a malformed field without losing the row', () => {
    const raw = JSON.stringify({
      version: 1,
      books: [{ bookId: 'a', title: 'T', author: 'A', subjects: 42 }],
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

/**
 * The second launch of a fresh install.
 *
 * The first writes an empty index for a library that does not exist yet. The
 * next finds that cache, goes to check it against the directory, and `books/`
 * has still never been created — so refusing to swallow the read failure told a
 * brand-new reader their library could not be read before they had one.
 */
describe('a cached index with no books directory', () => {
  it('is an empty shelf, not an unreadable one', async () => {
    const fs = fakeFs({ [INDEX_FILE]: JSON.stringify({ version: 1, books: [] }) })
    const { books } = await loadShelf(fs)
    expect(books).toEqual([])
  })
})

/**
 * A folder that is not a book yet.
 *
 * `scanBooks` deliberately skips a directory with no `book.json` — a
 * half-finished import is simply not on the shelf. But the cache was checked by
 * comparing the DIRECTORY listing against the cached BOOKS, which is a different
 * question: the stray folder disagreed forever. Every launch rescanned, wrote an
 * index that still did not mention it, and disagreed again. One abandoned folder
 * turned the cache off permanently, and quietly.
 */
describe('a stray folder beside the books', () => {
  const withStray = () =>
    fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: '{"title":"Moby-Dick","author":"M"}',
      [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE',
      // An import that never finished: bytes, no record.
      [`${BOOKS_DIR}/half_done/content.epub`]: 'PARTIAL',
    })

  it('is scanned once and then the cache is believed', async () => {
    const fs = withStray()
    expect((await loadShelf(fs)).rescanned).toBe(true)
    expect((await loadShelf(fs)).rescanned).toBe(false)
  })

  it('still notices a book actually appearing', async () => {
    const fs = withStray()
    await loadShelf(fs)
    fs.store.set(
      `${BOOKS_DIR}/book_b/book.json`,
      new TextEncoder().encode('{"title":"New","author":"N"}'),
    )
    expect((await loadShelf(fs)).rescanned).toBe(true)
  })

  it('still notices the stray folder going away', async () => {
    const fs = withStray()
    await loadShelf(fs)
    fs.store.delete(`${BOOKS_DIR}/half_done/content.epub`)
    expect((await loadShelf(fs)).rescanned).toBe(true)
  })
})

describe('invalidateIndex', () => {
  /* The cache is only sound while it is not BEHIND the records it summarises,
     and `book.json` is explicitly allowed to be newer. A run whose index
     rewrite failed after the record landed leaves a cache that still agrees
     about folders and is wrong about contents — and `loadShelf` would trust it
     for ever, so a tag written just before the failure would come back missing
     on the next launch and stay missing. */
  it('removes the cached shelf so the next launch rescans', async () => {
    const fs = fakeFs(twoBooks)
    await writeIndex(fs, await scanBooks(fs))
    expect(await fs.exists(INDEX_FILE)).toBe(true)

    await invalidateIndex(fs)

    expect(await fs.exists(INDEX_FILE)).toBe(false)
    const after = await loadShelf(fs)
    expect(after.rescanned).toBe(true)
    expect(after.books).toHaveLength(2)
  })

  it('says nothing when there is no cache to throw away', async () => {
    // Called on every write failure, including the first one of a fresh library.
    const fs = fakeFs(twoBooks)
    await expect(invalidateIndex(fs)).resolves.toBeUndefined()
  })

  it('survives a filesystem that refuses to delete', async () => {
    /* It runs on the FAILURE path, where the disk is already refusing writes.
       An invalidation that threw would replace a stale cache with an unhandled
       rejection — a worse outcome than the thing it is cleaning up after. */
    const fs = fakeFs(twoBooks)
    await writeIndex(fs, await scanBooks(fs))
    const refusing: IndexFs = {
      ...fs,
      remove: () => Promise.reject(new Error('read-only filesystem')),
    }
    await expect(invalidateIndex(refusing)).resolves.toBeUndefined()
  })
})

/**
 * What a scan is allowed to COST.
 *
 * Every filesystem call is an IPC round-trip into the Tauri process, and
 * `main.tsx` awaits the scan before React mounts — so the call count IS the
 * time the window stays blank. The scan used to probe each folder up to ten
 * times, one at a time: `exists` for the record, the read, then `exists` once
 * per known format for the bytes. One listing per folder answers everything
 * the probes asked, and this pins the budget so the probes cannot creep back.
 */
describe('what a scan costs', () => {
  function countedFs(files: Record<string, string>) {
    const fs = fakeFs(files)
    const calls = { readDir: 0, readFile: 0, exists: 0 }
    const counted: IndexFs = {
      ...fs,
      readDir: (path) => {
        calls.readDir += 1
        return fs.readDir(path)
      },
      readFile: (path) => {
        calls.readFile += 1
        return fs.readFile(path)
      },
      exists: (path) => {
        calls.exists += 1
        return fs.exists(path)
      },
    }
    return { counted, calls }
  }

  it('pays one listing per folder, one read per book, and no probes', async () => {
    const { counted, calls } = countedFs({
      ...twoBooks,
      [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE',
      // A stray folder costs its listing and nothing more.
      [`${BOOKS_DIR}/half_done/content.epub`]: 'PARTIAL',
    })
    const books = await scanBooks(counted)
    expect(books).toHaveLength(2)
    expect(calls.readDir).toBe(1 + 3)
    expect(calls.readFile).toBe(2)
    expect(calls.exists).toBe(0)
  })

  /* Concurrency must not reorder the shelf: the rows come back in the order
   * the directory listed them, exactly as the serial walk produced. */
  it('keeps the rows in listing order', async () => {
    const files: Record<string, string> = {}
    const names = ['book_e', 'book_a', 'book_c', 'book_b', 'book_d']
    for (const name of names) files[`${BOOKS_DIR}/${name}/book.json`] = record(name)
    const fs = fakeFs(files)
    const listed = (await fs.readDir(BOOKS_DIR)).map((one) => one.name)
    const books = await scanBooks(fs)
    expect(books.map((one) => one.title)).toEqual(listed)
  })
})

/**
 * The pooled walk must be invisible from outside: same rows, same order, same
 * failure policy as the serial walk it replaced. These are the cases where a
 * pool differs from a loop if it is going to.
 */
describe('the pooled walk, behaving like the serial one', () => {
  it('keeps listing order even when folders finish out of order', async () => {
    const files: Record<string, string> = {}
    for (const name of ['book_e', 'book_a', 'book_c']) {
      files[`${BOOKS_DIR}/${name}/book.json`] = record(name)
    }
    const fs = fakeFs(files)
    const listed = (await fs.readDir(BOOKS_DIR)).map((one) => one.name)
    /* Every folder's listing is HELD at a gate, then released in reverse — a
     * completion order the immediate-resolution fake can never produce, which
     * is why the plain ordering test above cannot catch a pool that emits in
     * completion order. */
    const gates = new Map<string, () => void>()
    const gated: IndexFs = {
      ...fs,
      readDir: async (path) => {
        const listing = await fs.readDir(path)
        if (path === BOOKS_DIR) return listing
        await new Promise<void>((resolve) => gates.set(path, resolve))
        return listing
      },
    }
    const scanning = scanBooks(gated)
    await vi.waitFor(() => expect(gates.size).toBe(3))
    for (const name of [...listed].reverse()) gates.get(`${BOOKS_DIR}/${name}`)!()
    const books = await scanning
    expect(books.map((one) => one.title)).toEqual(listed)
  })

  /* The serial walk's `exists` probe skipped a folder that vanished between
   * the root listing and its turn; the pool must walk past it too, not count
   * it as a record that failed. */
  it('walks past a folder that vanished after the listing', async () => {
    const fs = fakeFs({ [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha') })
    const vanished: IndexFs = {
      ...fs,
      readDir: async (path) => {
        if (path === BOOKS_DIR)
          return [...(await fs.readDir(path)), { name: 'ghost', isDirectory: true }]
        if (path === `${BOOKS_DIR}/ghost`) throw new Error('gone')
        return fs.readDir(path)
      },
    }
    const books = await scanBooks(vanished)
    expect(books.map((one) => one.title)).toEqual(['Alpha'])
  })

  /* And a library that is ALL vanished folders is an empty shelf, not an
   * unreadable one — the all-unreadable throw is for records that failed. */
  it('does not call a vanished library unreadable', async () => {
    const fs = fakeFs({})
    const vanished: IndexFs = {
      ...fs,
      readDir: async (path) => {
        if (path === BOOKS_DIR) return [{ name: 'ghost', isDirectory: true }]
        throw new Error('gone')
      },
    }
    expect(await scanBooks(vanished)).toEqual([])
  })

  /* The dangerous misclassification: a folder that will not list and whose
   * `exists` probe ALSO answers false — which is what a metadata error looks
   * like through Tauri's fs. The scan cannot tell it from a vanished folder,
   * so what matters is what it WRITES: a snapshot claiming to have seen the
   * folder would make the trust check agree forever over a shelf missing that
   * book. Left out of the snapshot, the next launch's listing disagrees and
   * rescans until the folder reads or truly goes. */
  it('never lets a folder it could not see into a trusted snapshot', async () => {
    const fs = fakeFs({ [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha') })
    const blind: IndexFs = {
      ...fs,
      readDir: async (path) => {
        if (path === BOOKS_DIR)
          return [...(await fs.readDir(path)), { name: 'blind', isDirectory: true }]
        if (path === `${BOOKS_DIR}/blind`) throw new Error('metadata error')
        return fs.readDir(path)
      },
      // The fake's exists answers false for 'books/blind' already — no keys.
    }
    expect((await loadShelf(blind)).rescanned).toBe(true)
    expect((await loadShelf(blind)).rescanned).toBe(true)
  })

  it('does not trust an empty shelf it produced while blind', async () => {
    const fs = fakeFs({})
    const blind: IndexFs = {
      ...fs,
      readDir: async (path) => {
        if (path === BOOKS_DIR) return [{ name: 'blind', isDirectory: true }]
        throw new Error('metadata error')
      },
    }
    expect((await loadShelf(blind)).books).toEqual([])
    // The launch after must NOT believe that empty cache over a listed folder.
    expect((await loadShelf(blind)).rescanned).toBe(true)
  })

  /* Gone and broken stay different answers: a folder that is still there and
   * will not list is a failure to read, and a library made entirely of those
   * is reported rather than shown empty. */
  it('still counts a folder that is there and will not list', async () => {
    const fs = fakeFs({ [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha') })
    const broken: IndexFs = {
      ...fs,
      readDir: async (path) => {
        if (path === `${BOOKS_DIR}/book_a`) throw new Error('EIO')
        return fs.readDir(path)
      },
    }
    await expect(scanBooks(broken)).rejects.toThrow('could not be read')
  })
})

/**
 * What the index remembers about the DIRECTORY, across ordinary rewrites.
 *
 * The scan records every folder it saw so a stray one cannot distrust the
 * cache forever. But every mutation rewrites the whole index file — so a
 * rewrite that simply omitted the field DELETED it, and one tag written in a
 * library with one stray folder put every later launch back on the full-scan
 * path. The strays are carried forward; the book folders are rebuilt from the
 * books being written, so the field stays current as books come and go.
 */
describe('the folders an index remembers', () => {
  it('carries a stray folder across an ordinary rewrite', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha'),
      [`${BOOKS_DIR}/half_done/content.epub`]: 'PARTIAL',
    })
    await loadShelf(fs)
    // A mutation-shaped write: the caller knows its books and no folders.
    await writeIndex(fs, await scanBooks(fs))
    expect((await loadShelf(fs)).rescanned).toBe(false)
  })

  it('keeps the folder set current with the books being written', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha'),
      [`${BOOKS_DIR}/book_b/book.json`]: record('Beta'),
      [`${BOOKS_DIR}/half_done/content.epub`]: 'PARTIAL',
    })
    const { books } = await loadShelf(fs)
    // The app removes book_b: its folder goes, and the write omits its row.
    fs.store.delete(`${BOOKS_DIR}/book_b/book.json`)
    await writeIndex(fs, books.filter((one) => one.bookId !== 'book_b'))
    // Blindly PRESERVING the old listing would disagree here and rescan.
    expect((await loadShelf(fs)).rescanned).toBe(false)
  })

  it('asserts nothing for an index that never recorded folders', async () => {
    const fs = fakeFs({})
    await writeIndex(fs, [{ bookId: 'book_a', title: 'T', author: '', hasContent: true }])
    const stored = JSON.parse(new TextDecoder().decode(fs.store.get(INDEX_FILE)!)) as {
      folders?: unknown
    }
    expect(stored.folders).toBeUndefined()
  })
})

describe('scanAllMarks', () => {
  it('collects marks in listing order and skips a book whose file will not read', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/marks.json`]: JSON.stringify([1]),
      [`${BOOKS_DIR}/book_b/marks.json`]: 'not json',
      [`${BOOKS_DIR}/book_c/marks.json`]: JSON.stringify([2, 3]),
    })
    expect(await scanAllMarks(fs)).toEqual([1, 2, 3])
  })

  it('throws when the library itself will not list', async () => {
    const fs = fakeFs({ [`${BOOKS_DIR}/book_a/marks.json`]: '[]' })
    const broken: IndexFs = {
      ...fs,
      readDir: async (path) => {
        if (path === BOOKS_DIR) throw new Error('EIO')
        return fs.readDir(path)
      },
    }
    await expect(scanAllMarks(broken)).rejects.toThrow('EIO')
  })
})

describe('hasContentFile', () => {
  /* NULL is "could not look", and it is load-bearing: collapsed into false it
   * was written into a trusted cache as a measurement, disabling a book whose
   * bytes were there all along. */
  it('answers null, not false, when it cannot look', async () => {
    const fs = fakeFs({})
    const failing: IndexFs = {
      ...fs,
      readDir: async () => {
        throw new Error('EIO')
      },
    }
    expect(await hasContentFile(failing, 'book_a')).toBeNull()
  })

  it('finds the bytes from one listing', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha'),
      [`${BOOKS_DIR}/book_a/content.pdf`]: 'bytes',
    })
    expect(await hasContentFile(fs, 'book_a')).toBe(true)
  })

  /* A half-finished write is not the book: `content.epub.writing` must not
   * count, or a crash mid-import produces a row that claims bytes it lost. */
  it('does not mistake a temporary neighbour for the book', async () => {
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha'),
      [`${BOOKS_DIR}/book_a/content.epub.writing`]: 'half',
    })
    expect(await hasContentFile(fs, 'book_a')).toBe(false)
  })

  it('is false for a record with no bytes, and for no folder at all', async () => {
    const fs = fakeFs({ [`${BOOKS_DIR}/book_a/book.json`]: record('Alpha') })
    expect(await hasContentFile(fs, 'book_a')).toBe(false)
    expect(await hasContentFile(fs, 'book_gone')).toBe(false)
  })

  /* Takes the book's ID — `book:abc` lives in `book_abc`, and the caller must
   * not have to know that. */
  it('resolves the folder from the id', async () => {
    const fs = fakeFs({ [`${BOOKS_DIR}/book_abc/content.epub`]: 'bytes' })
    expect(await hasContentFile(fs, 'book:abc')).toBe(true)
  })
})
