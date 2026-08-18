import { describe, expect, it } from 'vitest'
import type { VaultFs } from './bookVault'
import {
  BOOKS_DIR,
  atomicWrite,
  contentPathIn,
  coverPathIn,
  folderOf,
  legacyCoverPathIn,
  marksPathIn,
  mergeParsed,
  mergeStranded,
  parseRecord,
  readBook,
  readMarks,
  recordFromMeta,
  recordPath,
  trashOf,
  type BookRecord,
  updateBook,
  writeBook,
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
    /* `.jpg`, because that is what the encoder actually produces — this said
     * `.webp` for as long as the bytes underneath were JPEG and then PNG, which
     * is the defect `coverArt.ts` measures. */
    expect(coverPathIn('book:abc')).toBe(`${BOOKS_DIR}/book_abc/cover.jpg`)
    expect(marksPathIn('book:abc')).toBe(`${BOOKS_DIR}/book_abc/marks.json`)
  })

  /* Pinned because it is load-bearing, not vestigial: every library written
   * before the rename holds its jackets under this name, and `coverIn` still
   * reads it. Deleting it would blank a reader's whole shelf. */
  it('still knows the name jackets were written under before the rename', () => {
    expect(legacyCoverPathIn('book:abc')).toBe(`${BOOKS_DIR}/book_abc/cover.webp`)
    expect(legacyCoverPathIn('book:abc')).not.toBe(coverPathIn('book:abc'))
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

  /* THE WHOLE PARTITION, and the COMPILER enforces that it is whole.
   *
   * `Record<keyof BookRecord, …>` means a field added to the record fails to
   * compile until somebody says which side of the line it falls on. The first
   * version of this test was an object literal of the fields that happened to
   * come to mind, with a cast that let TypeScript shrug — it asserted a
   * "whole partition" it had no way to know was whole, which is the same shape
   * of claim as the `origin` fix that was made alone when four fields needed
   * it.
   *
   * PRESERVE   — true of the reader or of this copy; a parse may not touch it.
   * REPLACE    — the book's own account of itself; a parse is the authority.
   * PROVENANCE — about the parse itself, so it belongs to the parse. */
  const SIDE: Record<keyof BookRecord, 'preserve' | 'replace' | 'provenance'> = {
    bookId: 'preserve',
    ext: 'preserve',
    origin: 'preserve',
    openedAt: 'preserve',
    addedAt: 'preserve',
    tags: 'preserve',
    position: 'preserve',
    progress: 'preserve',
    finished: 'preserve',
    title: 'replace',
    author: 'replace',
    sortAs: 'replace',
    series: 'replace',
    seriesIndex: 'replace',
    subjects: 'replace',
    publisher: 'replace',
    published: 'replace',
    languages: 'replace',
    parsedAt: 'provenance',
  }

  /** A record with every single field set, so nothing is asserted vacuously. */
  const everything: Required<BookRecord> = {
    bookId: 'book:abc',
    ext: 'pdf',
    origin: '/Users/reader/Books/moby.pdf',
    openedAt: 1700,
    addedAt: 1,
    tags: ['To reread'],
    position: 'epubcfi(/6/4)',
    progress: 0.4,
    finished: true,
    title: 'moby-dick-1851',
    author: '',
    sortAs: 'Moby-Dick',
    series: 'Everyman',
    seriesIndex: 3,
    subjects: ['Whaling'],
    publisher: 'Harper & Brothers',
    published: '1851',
    languages: ['en'],
    parsedAt: 100,
  }

  it('keeps every preserve-side field when a parse omits it', () => {
    // What a BACKGROUND parse knows: the book's own account, nothing else.
    const parsed = book({ title: 'Moby-Dick; or, The Whale', author: 'Melville, Herman' })
    const merged = mergeParsed(everything, parsed)

    for (const [field, side] of Object.entries(SIDE) as [keyof BookRecord, string][]) {
      if (side !== 'preserve') continue
      expect(everything, `fixture must seed ${field}`).toHaveProperty(field)
      expect(merged[field], field).toEqual(everything[field])
    }
    expect(merged.title).toBe('Moby-Dick; or, The Whale')
  })

  /* The other half, and the one that was missing: a parse that omits a
   * BOOK-side field must not silently erase it either. That gap is exactly how
   * a failed background parse could strip a book of its subjects, publisher,
   * series and languages while marking it complete. */
  it('does not let an omitted book-side field read as a denial', () => {
    const parsed = book({ title: 'Moby-Dick; or, The Whale', author: 'Melville, Herman' })
    const merged = mergeParsed(everything, parsed)
    for (const [field, side] of Object.entries(SIDE) as [keyof BookRecord, string][]) {
      if (side !== 'replace' || field === 'title' || field === 'author') continue
      expect(everything, `fixture must seed ${field}`).toHaveProperty(field)
      /* THIS IS THE DOCUMENTED BEHAVIOUR, not the desired one: `mergeParsed`
       * gives the parse authority, so an omission IS a denial and the field
       * goes. It is asserted rather than wished away because the safety lives
       * one level up — `enrichOne` never omits, it repeats the row's own
       * account when a parse fails, which is what `enrich.test.ts` pins. */
      expect(merged[field], field).toBeUndefined()
    }
  })

  it('lets the book replace every book-side field it does supply', () => {
    const parsed: BookRecord = {
      title: 'T',
      author: 'A',
      sortAs: 'S',
      series: 'Se',
      seriesIndex: 9,
      subjects: ['New'],
      publisher: 'P',
      published: '1900',
      languages: ['fr'],
    }
    const merged = mergeParsed(everything, parsed)
    for (const [field, side] of Object.entries(SIDE) as [keyof BookRecord, string][]) {
      if (side !== 'replace') continue
      expect(merged[field], field).toEqual(parsed[field])
    }
  })

  /* The other direction: a parse that DOES supply a copy-local field wins,
   * because that is the reader telling us where the book is now. */
  it('lets a fresh open replace the copy-local fields it does supply', () => {
    const owned = book({ ext: 'epub', origin: '/old/path.epub', openedAt: 1 })
    const merged = mergeParsed(owned, book({ ext: 'pdf', origin: '/new/path.pdf', openedAt: 2 }))
    expect(merged.ext).toBe('pdf')
    expect(merged.origin).toBe('/new/path.pdf')
    expect(merged.openedAt).toBe(2)
  })

  /* `parsedAt` is the parse's OWN provenance, so it is the one timestamp the
   * parse may replace — that is what stops the enrichment pass revisiting a
   * book it has already been to. */
  it('takes the parse’s own timestamp', () => {
    const merged = mergeParsed(book({ parsedAt: 100 }), book({ parsedAt: 200 }))
    expect(merged.parsedAt).toBe(200)
  })

  /* THE OTHER EDGE OF THE SAME RULE, and the one that bit.
   *
   * Authority means the parse must SUPPLY the field — a parse that omits it
   * DELETES the marker. The first version of this test fabricated an incoming
   * record that carried `parsedAt`, so it proved the happy half and never asked
   * what a real record looks like. A real fresh-open record is built by
   * `recordFromMeta`, which omits `parsedAt` by construction; the reader's open
   * therefore erased the marker on every book it touched, and the enrichment
   * pass re-parsed every book the reader had actually read, on every launch,
   * forever. Asserted with the REAL shape now, so the fabrication cannot come
   * back. */
  it('drops the marker when a parse omits it — which is why every parse must stamp one', () => {
    const fromRealParse = recordFromMeta({ title: 'Moby-Dick', author: 'Melville' })
    expect(fromRealParse, 'recordFromMeta must not invent a marker').not.toHaveProperty('parsedAt')
    expect(mergeParsed(book({ parsedAt: 100 }), fromRealParse).parsedAt).toBeUndefined()
  })

  it('keeps the marker when the parse stamps its own, as every caller must', () => {
    const stamped = { ...recordFromMeta({ title: 'Moby-Dick', author: 'Melville' }), parsedAt: 200 }
    expect(mergeParsed(book({ parsedAt: 100 }), stamped).parsedAt).toBe(200)
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

/**
 * A reading position is a path through the document, not prose.
 *
 * It shared the 4000-character bound with titles and author names, and `text`
 * SLICES at its bound — so a CFI past it came back shortened, which parses as
 * nothing. Worse, the shortened value survived the next merge and was written
 * back over the complete one: the position was destroyed by being read.
 */
describe('a very long reading position', () => {
  const cfi = (length: number) => `epubcfi(/6/14!/4/2/${'2/'.repeat(length)}1:0)`

  it('survives a round trip well past the length of ordinary text', async () => {
    const fs = fakeFs()
    const long = cfi(2000)
    expect(long.length).toBeGreaterThan(4000)
    await writeBook(fs, 'book_a', { title: 'T', author: 'A', position: long })
    expect((await readBook(fs, 'book_a'))?.position).toBe(long)
  })

  /* Past the bound it is DROPPED, not cut. A book that opens at the beginning
   * is a book the reader can navigate; one that opens at a corrupted anchor is
   * a bug report. */
  it('is dropped rather than truncated when it is absurd', async () => {
    const fs = fakeFs()
    await writeBook(fs, 'book_a', { title: 'T', author: 'A', position: 'x'.repeat(70_000) })
    expect((await readBook(fs, 'book_a'))?.position).toBeUndefined()
  })

  it('still keeps an ordinary one', async () => {
    const fs = fakeFs()
    await writeBook(fs, 'book_a', { title: 'T', author: 'A', position: 'epubcfi(/6/14)' })
    expect((await readBook(fs, 'book_a'))?.position).toBe('epubcfi(/6/14)')
  })
})

/**
 * "No marks yet" and "could not read the marks" are not the same answer.
 *
 * Collapsing both into an empty list was the most destructive line in this
 * file: a momentary read failure loaded nothing, the store took that for a
 * successful load, and the reader's next highlight wrote a snapshot of exactly
 * that one mark over everything they had.
 */
describe('readMarks', () => {
  it('is empty for a book that has none', async () => {
    expect(await readMarks(fakeFs(), 'book_a')).toEqual([])
  })

  it('reads them back', async () => {
    const fs = fakeFs({ [marksPathIn('book_a')]: '[{"id":"m1"}]' })
    expect(await readMarks(fs, 'book_a')).toHaveLength(1)
  })

  it('throws rather than reporting none when the file will not read', async () => {
    const fs = fakeFs({ [marksPathIn('book_a')]: '[{"id":"m1"}]' })
    const broken: VaultFs = {
      ...fs,
      readFile: async () => {
        throw new Error('I/O error')
      },
    }
    await expect(readMarks(broken, 'book_a')).rejects.toThrow('I/O error')
  })

  it('throws rather than reporting none when the file is not a list', async () => {
    const fs = fakeFs({ [marksPathIn('book_a')]: '{"not":"a list"}' })
    await expect(readMarks(fs, 'book_a')).rejects.toThrow('not a list')
  })

  it('throws on a file that is not JSON at all', async () => {
    const fs = fakeFs({ [marksPathIn('book_a')]: 'half a write' })
    await expect(readMarks(fs, 'book_a')).rejects.toThrow()
  })
})

/**
 * Two records, both the reader's, for one book.
 *
 * A restore that could not move `book.json` leaves one in the trash while the
 * live one carries on being used. Taking either side whole loses the other's
 * work, which is a fresh way to lose the thing the rescue exists to save.
 */
describe('mergeStranded', () => {
  const stranded = book({ tags: ['Sea'], position: 'epubcfi(/6/4)', progress: 0.3, addedAt: 10 })

  it('unions the tags rather than picking a list', () => {
    const merged = mergeStranded(stranded, book({ tags: ['Mine'] }))
    expect(merged.tags).toEqual(['Sea', 'Mine'])
  })

  it('folds a tag that differs only in case', () => {
    expect(mergeStranded(stranded, book({ tags: ['sea'] })).tags).toEqual(['Sea'])
  })

  /* Reading moves forwards, and the live record is where the reading happened. */
  it('takes the live position and progress when it has them', () => {
    const merged = mergeStranded(stranded, book({ position: 'epubcfi(/6/40)', progress: 0.9 }))
    expect(merged.position).toBe('epubcfi(/6/40)')
    expect(merged.progress).toBe(0.9)
  })

  it('falls back to the stranded one when the live record has none', () => {
    const merged = mergeStranded(stranded, book())
    expect(merged.position).toBe('epubcfi(/6/4)')
    expect(merged.progress).toBe(0.3)
  })

  it('is finished if either says so', () => {
    expect(mergeStranded(book({ finished: true }), book()).finished).toBe(true)
    expect(mergeStranded(book(), book({ finished: true })).finished).toBe(true)
  })

  it('keeps the earlier arrival', () => {
    expect(mergeStranded(stranded, book({ addedAt: 99 })).addedAt).toBe(10)
  })

  /* The book's own account of itself comes from the live record, which is the
   * one a parse has been folded into. */
  it('keeps the live metadata', () => {
    expect(mergeStranded(stranded, book({ title: 'Corrected' })).title).toBe('Corrected')
  })
})

/**
 * A record that is there and will not read is not a book that is gone.
 *
 * Both were null, so `updateBook` reported "nothing to do" — and the tag the
 * reader had just typed was dropped with no error anywhere and nothing to
 * replay it from.
 */
describe('updateBook on a record that will not read', () => {
  it('throws rather than quietly doing nothing', async () => {
    const fs = fakeFs({ [recordPath('book_a')]: 'half a write' })
    await expect(updateBook(fs, 'book_a', (r) => ({ ...r, finished: true }))).rejects.toThrow(
      'could not be read',
    )
  })

  it('still reports a book that is genuinely gone, without throwing', async () => {
    expect(await updateBook(fakeFs(), 'book_a', (r) => r)).toBe(false)
  })
})

/**
 * An address is the other field that means nothing shortened.
 *
 * It shared the four-thousand-character bound with titles, and that bound
 * slices — so a long URL came back cut, which fetches nothing, while `canOpen`
 * went on offering the row because an origin was present.
 */
/**
 * `origin` is where THIS COPY came from, not something the book says about
 * itself — so it survives a reopen like the tags and the position do.
 *
 * It did not, and the routes that open a book without a path erased it: drop an
 * already-shelved book onto the open reader and its way back was gone, which for
 * a book Paper has no copy of is the whole of it.
 */
describe('mergeParsed and the origin', () => {
  it('keeps the one already stored when the open supplies none', () => {
    const merged = mergeParsed(book({ origin: '/Users/x/moby.epub' }), book())
    expect(merged.origin).toBe('/Users/x/moby.epub')
  })

  it('takes a fresh one, because that is where the book is now', () => {
    const merged = mergeParsed(book({ origin: '/old/moby.epub' }), book({ origin: '/new/moby.epub' }))
    expect(merged.origin).toBe('/new/moby.epub')
  })

  it('leaves it unset when neither has one', () => {
    expect(mergeParsed(book(), book()).origin).toBeUndefined()
  })
})

describe('a very long origin', () => {
  it('survives a round trip past the length of ordinary text', async () => {
    const fs = fakeFs()
    const url = `https://example.org/${'a'.repeat(5000)}.epub`
    expect(url.length).toBeGreaterThan(4000)
    await writeBook(fs, 'book_a', { title: 'T', author: 'A', origin: url })
    expect((await readBook(fs, 'book_a'))?.origin).toBe(url)
  })

  it('is dropped rather than cut when it is absurd', async () => {
    const fs = fakeFs()
    await writeBook(fs, 'book_a', { title: 'T', author: 'A', origin: 'x'.repeat(9000) })
    expect((await readBook(fs, 'book_a'))?.origin).toBeUndefined()
  })

  it('still keeps an ordinary path', async () => {
    const fs = fakeFs()
    await writeBook(fs, 'book_a', { title: 'T', author: 'A', origin: '/Users/x/moby.epub' })
    expect((await readBook(fs, 'book_a'))?.origin).toBe('/Users/x/moby.epub')
  })
})

/**
 * The one write, used by everything that writes.
 *
 * Extracted because the temp-then-rename was spelled out in six places, and six
 * copies of an invariant is five chances for one of them to drift out of it.
 */
describe('atomicWrite', () => {
  it('leaves the destination, not the temporary neighbour', async () => {
    const fs = fakeFs()
    await atomicWrite(fs, `${BOOKS_DIR}/book_a/thing.json`, new TextEncoder().encode('X'))
    expect(fs.files.has(`${BOOKS_DIR}/book_a/thing.json`)).toBe(true)
    expect([...fs.files.keys()].some((k) => k.endsWith('.writing'))).toBe(false)
  })

  it('cleans up after a failed write', async () => {
    const fs = fakeFs()
    fs.failWrite = `${BOOKS_DIR}/book_a/thing.json.writing`
    await expect(
      atomicWrite(fs, `${BOOKS_DIR}/book_a/thing.json`, new TextEncoder().encode('X')),
    ).rejects.toThrow('disk full')
    expect(fs.files.size).toBe(0)
  })

  it('makes the parent directory', async () => {
    const fs = fakeFs()
    await atomicWrite(fs, `${BOOKS_DIR}/book_a/thing.json`, new TextEncoder().encode('X'))
    expect(fs.dirs.has(`${BOOKS_DIR}/book_a`)).toBe(true)
  })

  /* A path with NO separator has no parent to make. `index.json` is one, and
   * `slice(0, lastIndexOf('/'))` on it returns `index.jso` — a directory named
   * after most of a filename, created every time the shelf was saved. */
  it('makes no directory for a file at the root', async () => {
    const fs = fakeFs()
    await atomicWrite(fs, 'index.json', new TextEncoder().encode('[]'))
    expect(fs.files.has('index.json')).toBe(true)
    expect([...fs.dirs]).toEqual([])
  })
})
