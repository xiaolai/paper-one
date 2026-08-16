import { describe, expect, it } from 'vitest'
import type { VaultFs } from './bookVault'
import {
  BOOKS_DIR,
  contentPathIn,
  coverPathIn,
  folderOf,
  marksPathIn,
  mergeParsed,
  parseRecord,
  readBook,
  recordPath,
  trashOf,
  updateBook,
  writeBook,
  type BookRecord,
} from './bookFolder'

/**
 * A book as one directory.
 *
 * What is asserted here is the shape, the trust boundary and the merge rule.
 * What needs the app is whether the capability permits these writes — a
 * permission naming the wrong thing is green in every automated check, and this
 * project has shipped that twice.
 */

function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(seed)) files.set(k, new TextEncoder().encode(v))
  const dirs = new Set<string>()
  const fs: VaultFs & { files: Map<string, Uint8Array>; dirs: Set<string>; failWrite?: string } = {
    files,
    dirs,
    readFile: async (path) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`no such file: ${path}`)
      return bytes
    },
    writeFile: async (path, bytes) => {
      if (fs.failWrite === path) throw new Error('disk full')
      files.set(path, bytes)
    },
    /* A DIRECTORY EXISTS WHEN SOMETHING IS IN IT, which is what the real
     * `exists` reports and what this fake claimed otherwise. An exact match made
     * every directory look absent, so a guard that asks about one passed here
     * for the wrong reason and failed on disk. */
    exists: async (path) => [...files.keys()].some((k) => k === path || k.startsWith(`${path}/`)),
    mkdir: async (path) => void dirs.add(path),
    remove: async (path) => void files.delete(path),
    removeDir: async (path: string) => {
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key)
      }
    },
    rename: async (from, to) => {
      const bytes = files.get(from)
      if (bytes) files.set(to, bytes)
      files.delete(from)
    },
  }
  return fs
}

const book = (over: Partial<BookRecord> = {}): BookRecord => ({
  title: 'Moby-Dick',
  author: 'Herman Melville',
  ...over,
})

describe('paths', () => {
  it('names a folder by the content id', () => {
    expect(folderOf('book:abc')).toBe(`${BOOKS_DIR}/book_abc`)
    expect(recordPath('book:abc')).toBe(`${BOOKS_DIR}/book_abc/book.json`)
    expect(coverPathIn('book:abc')).toBe(`${BOOKS_DIR}/book_abc/cover.webp`)
    expect(marksPathIn('book:abc')).toBe(`${BOOKS_DIR}/book_abc/marks.json`)
  })

  /* The extension still comes off a filename the reader did not write, and is
   * still interpolated into a path. The closed list moves with it. */
  it('refuses an extension that would leave the folder', () => {
    expect(contentPathIn('book:a', 'evil../../../secrets')).toBe(`${BOOKS_DIR}/book_a/content.bin`)
  })

  it('cannot be made to escape by a hostile id', () => {
    expect(folderOf('../../etc')).toBe(`${BOOKS_DIR}/______etc`)
  })
})

describe('parseRecord', () => {
  it('reads a record back', () => {
    const written = JSON.stringify(book({ tags: ['Sea'], progress: 0.4 }))
    expect(parseRecord(written)).toMatchObject({ title: 'Moby-Dick', tags: ['Sea'], progress: 0.4 })
  })

  it('survives nonsense', () => {
    expect(parseRecord('not json')).toBeNull()
    expect(parseRecord(null)).toBeNull()
    expect(parseRecord('[1,2,3]')).toBeNull()
  })

  /* A `subjects` that is not an array of strings crashes the shelf the moment
   * it renders — the same trust boundary the flat store needed. */
  it('drops a field of the wrong type rather than passing it through', () => {
    const raw = JSON.stringify({ title: 'T', author: 'A', subjects: 42, tags: ['ok', 7] })
    const parsed = parseRecord(raw)
    expect(parsed?.subjects).toBeUndefined()
    expect(parsed?.tags).toEqual(['ok'])
  })

  /* Built from known fields, so an unknown key never reaches memory. */
  it('does not carry an unknown key through', () => {
    const parsed = parseRecord(JSON.stringify({ title: 'T', author: 'A', surprise: 'x' }))
    expect(parsed && 'surprise' in parsed).toBe(false)
  })

  it('clamps a hand-edited progress', () => {
    expect(parseRecord(JSON.stringify({ title: 'T', author: 'A', progress: 4 }))?.progress).toBe(1)
  })

  /* A book with no title is still a book — the filename stands in. */
  it('accepts a record with an empty title', () => {
    expect(parseRecord(JSON.stringify({ author: 'A' }))?.title).toBe('')
  })
})

describe('writeBook', () => {
  it('writes the record and creates the folder', async () => {
    const fs = fakeFs()
    await writeBook(fs, 'book:a', book())
    expect(fs.dirs.has(folderOf('book:a'))).toBe(true)
    expect(await readBook(fs, 'book:a')).toMatchObject({ title: 'Moby-Dick' })
  })

  /**
   * `book.json` IS the book as far as the shelf is concerned.
   *
   * A truncated one would lose the reader's tags and position with no error
   * anywhere, so the write goes to a neighbour and is renamed into place.
   */
  it('leaves no partial record when the write fails', async () => {
    const fs = fakeFs()
    fs.failWrite = `${recordPath('book:a')}.writing`
    await expect(writeBook(fs, 'book:a', book())).rejects.toThrow('disk full')
    expect(fs.files.has(recordPath('book:a'))).toBe(false)
    expect(fs.files.has(`${recordPath('book:a')}.writing`)).toBe(false)
  })

  it('moves the temporary file rather than writing twice', async () => {
    const fs = fakeFs()
    let writes = 0
    const counted: VaultFs = {
      ...fs,
      writeFile: async (p, b) => {
        writes += 1
        await fs.writeFile(p, b)
      },
    }
    await writeBook(counted, 'book:a', book())
    expect(writes).toBe(1)
  })
})

describe('updateBook', () => {
  it('changes one field and leaves the rest', async () => {
    const fs = fakeFs()
    await writeBook(fs, 'book:a', book({ tags: ['Sea'] }))
    await updateBook(fs, 'book:a', (r) => ({ ...r, progress: 0.5 }))
    expect(await readBook(fs, 'book:a')).toMatchObject({ tags: ['Sea'], progress: 0.5 })
  })

  /* A write racing a removal must do nothing rather than recreate the folder —
   * otherwise removing a book while its position is being saved brings it back. */
  it('does nothing for a book that is not there', async () => {
    const fs = fakeFs()
    expect(await updateBook(fs, 'gone', (r) => r)).toBe(false)
    expect(fs.files.size).toBe(0)
  })

  it('writes nothing when the change returns its input', async () => {
    const fs = fakeFs()
    await writeBook(fs, 'book:a', book())
    let writes = 0
    const counted: VaultFs = {
      ...fs,
      writeFile: async (p, b) => {
        writes += 1
        await fs.writeFile(p, b)
      },
    }
    await updateBook(counted, 'book:a', (r) => r)
    expect(writes).toBe(0)
  })
})

/**
 * The rule phase 3 got wrong, stated as a function.
 *
 * `recordOpen` spread a fresh parse over the previous row and erased the
 * reader's tags on every reopen — one function away from the field separation
 * that existed to prevent exactly that.
 */
describe('mergeParsed', () => {
  const lived = book({
    tags: ['To reread'],
    position: 'epubcfi(/6/4)',
    progress: 0.4,
    finished: true,
    addedAt: 1,
  })

  it('keeps everything the book cannot know about', () => {
    const merged = mergeParsed(lived, book({ title: 'Corrected' }))
    expect(merged).toMatchObject({
      tags: ['To reread'],
      position: 'epubcfi(/6/4)',
      progress: 0.4,
      finished: true,
      addedAt: 1,
    })
  })

  /* The book IS the authority on its own metadata, or a corrected OPF could
   * never take effect. */
  it('lets the book replace what the book declares', () => {
    const merged = mergeParsed(lived, book({ title: 'Corrected', subjects: ['New'] }))
    expect(merged.title).toBe('Corrected')
    expect(merged.subjects).toEqual(['New'])
  })

  it('is the parse itself for a book with no previous record', () => {
    const parsed = book({ title: 'New' })
    expect(mergeParsed(null, parsed)).toBe(parsed)
  })
})

/**
 * A position save landing while the reader removes the book.
 *
 * `updateBook` reads, applies, writes — and `writeBook` calls `mkdir`, so a
 * removal in between left the folder recreated holding nothing but a record: a
 * book resurrected as an empty shell, with its content and marks in the trash.
 *
 * The check that was supposed to catch this asked whether the folder existed
 * AFTER the write, which `writeBook` had just guaranteed. It could not fire.
 */
describe('a write racing a removal', () => {
  it('does not resurrect the book, and says it did not write', async () => {
    const fs = fakeFs({
      [`${folderOf('book_a')}/book.json`]: '{"title":"Moby-Dick","author":"M"}',
      [`${folderOf('book_a')}/content.epub`]: 'WHALE',
    })
    const wrote = await updateBook(fs, 'book_a', (record) => {
      // The removal happens between the read and the write.
      for (const key of [...fs.files.keys()]) {
        if (!key.startsWith(`${folderOf('book_a')}/`)) continue
        fs.files.set(`${trashOf('book_a')}/${key.split('/').pop()}`, fs.files.get(key)!)
        fs.files.delete(key)
      }
      return { ...record, position: 'epubcfi(/6/14)' }
    })
    expect(wrote).toBe(false)
    expect([...fs.files.keys()].some((k) => k.startsWith(`${folderOf('book_a')}/`))).toBe(false)
    expect(fs.files.has(`${trashOf('book_a')}/content.epub`)).toBe(true)
  })

  /* And the ordinary case still writes — including for a book that was removed
   * and put back before this call started, which is what the `before` check
   * distinguishes. */
  it('writes normally when an unrelated trashed copy is sitting there', async () => {
    const fs = fakeFs({
      [`${folderOf('book_a')}/book.json`]: '{"title":"Moby-Dick","author":"M"}',
      [`${trashOf('book_a')}/book.json`]: '{"title":"An older removal","author":""}',
    })
    expect(await updateBook(fs, 'book_a', (r) => ({ ...r, finished: true }))).toBe(true)
    expect((await readBook(fs, 'book_a'))?.finished).toBe(true)
  })
})
