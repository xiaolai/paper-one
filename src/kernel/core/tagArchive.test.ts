import { describe, expect, it } from 'vitest'
import type { IndexedBook } from './bookIndex'
import { archiveName, exportTags, parseArchive, planImport, type TagArchive } from './tagArchive'

function book(over: Partial<IndexedBook> = {}): IndexedBook {
  return { bookId: 'b1', title: 'Moby-Dick', author: 'Melville', ...over }
}

const archiveOf = (books: TagArchive['books']): TagArchive => ({ version: 1, books })

describe('exporting', () => {
  it('writes only the reader’s own tags', () => {
    /* Publisher subjects come out of the book on every parse. Writing them here
       would back up something that regenerates itself, and importing them would
       forge provenance — a subject the reader never adopted arriving as theirs. */
    const shelf = [book({ tags: ['Sea'], subjects: ['Fiction', 'Adventure'] })]
    expect(exportTags(shelf).books[0]?.tags).toEqual(['Sea'])
  })

  it('leaves out books the reader has not filed', () => {
    const shelf = [book({ bookId: 'b1', tags: ['Sea'] }), book({ bookId: 'b2' })]
    expect(exportTags(shelf).books).toHaveLength(1)
  })

  it('names each book three ways, so the file serves two jobs', () => {
    /* The id restores into the same library exactly; the title and author carry
       the filing to a different download of the same work. */
    const [row] = exportTags([book({ tags: ['Sea'] })]).books
    expect(row).toEqual({ bookId: 'b1', title: 'Moby-Dick', author: 'Melville', tags: ['Sea'] })
  })

  it('round-trips through the parser', () => {
    const shelf = [book({ tags: ['Sea', 'Whales'] }), book({ bookId: 'b2', title: 'Emma', author: 'Austen', tags: ['Novels'] })]
    expect(parseArchive(JSON.stringify(exportTags(shelf)))).toEqual(exportTags(shelf))
  })
})

describe('reading a file nobody can vouch for', () => {
  it('refuses something that is not an archive', () => {
    for (const bad of ['', 'not json', '[]', 'null', '{"version":2,"books":[]}', '{"books":[]}']) {
      expect(parseArchive(bad), bad).toBeNull()
    }
  })

  it('keeps the good rows out of a file with broken ones', () => {
    /* A recovery path. Refusing the whole file over one bad row is the
       behaviour that makes a backup worthless at the moment it is needed. */
    const got = parseArchive(
      JSON.stringify({
        version: 1,
        books: [
          { bookId: 'b1', title: 'Moby-Dick', author: 'Melville', tags: ['Sea'] },
          'not a row',
          { bookId: 'b2', tags: [] },
          { tags: ['Orphan'] },
          { bookId: 'b3', title: 'Emma', tags: ['Novels', 42, 'novels'] },
        ],
      }),
    )
    expect(got?.books.map((b) => b.bookId)).toEqual(['b1', 'b3'])
    // Folded and de-duplicated on the way in, like every other tag.
    expect(got?.books[1]?.tags).toEqual(['Novels'])
  })

  it('drops a row that can be named neither way', () => {
    const got = parseArchive(JSON.stringify({ version: 1, books: [{ author: 'x', tags: ['a'] }] }))
    expect(got?.books).toEqual([])
  })
})

describe('planning an import', () => {
  const shelf = [
    book({ bookId: 'b1', title: 'Moby-Dick', author: 'Melville', tags: ['Sea'] }),
    book({ bookId: 'b2', title: 'Emma', author: 'Austen' }),
  ]

  it('matches on the id first', () => {
    const plan = planImport(archiveOf([{ bookId: 'b2', title: 'nothing like it', author: '', tags: ['Novels'] }]), shelf)
    expect(plan.additions).toEqual([{ bookId: 'b2', tags: ['Novels'] }])
  })

  it('falls back to the title and author, folded', () => {
    /* How filing follows a work to a different download of it, where the bytes
       — and so the id — are not the same. */
    const plan = planImport(archiveOf([{ bookId: 'gone', title: 'emma', author: 'AUSTEN', tags: ['Novels'] }]), shelf)
    expect(plan.additions).toEqual([{ bookId: 'b2', tags: ['Novels'] }])
  })

  it('refuses to guess when a name answers for two books', () => {
    /* Two editions of one title is exactly where a wrong guess puts someone's
       filing on the wrong book. */
    const twoEditions = [
      book({ bookId: 'b1', title: 'Emma', author: 'Austen' }),
      book({ bookId: 'b2', title: 'Emma', author: 'Austen' }),
    ]
    const plan = planImport(archiveOf([{ bookId: 'gone', title: 'Emma', author: 'Austen', tags: ['Novels'] }]), twoEditions)
    expect(plan.additions).toEqual([])
    expect(plan.unmatched).toBe(1)
  })

  it('adds only what the book does not already carry, by key', () => {
    /* An archive written before a rename holds the old spelling; adding it back
       beside the new one would undo the rename one book at a time. */
    const plan = planImport(archiveOf([{ bookId: 'b1', title: 'Moby-Dick', author: 'Melville', tags: ['sea', 'Whales'] }]), shelf)
    expect(plan.additions).toEqual([{ bookId: 'b1', tags: ['Whales'] }])
  })

  it('never removes a tag the archive does not mention', () => {
    /* Restoring a month-old backup must not silently delete a month of work.
       Merging is the only behaviour that cannot lose anything. */
    const plan = planImport(archiveOf([{ bookId: 'b1', title: 'Moby-Dick', author: 'Melville', tags: ['Whales'] }]), shelf)
    expect(plan.additions.flatMap((one) => one.tags)).not.toContain('Sea')
    expect(plan.additions).toEqual([{ bookId: 'b1', tags: ['Whales'] }])
  })

  it('counts what it would do, for saying so in a sentence', () => {
    const plan = planImport(
      archiveOf([
        { bookId: 'b1', title: 'Moby-Dick', author: 'Melville', tags: ['Whales', 'Sea'] },
        { bookId: 'b2', title: 'Emma', author: 'Austen', tags: ['Novels'] },
        { bookId: 'nope', title: 'Not here', author: '', tags: ['x'] },
      ]),
      shelf,
    )
    expect(plan.booksTouched).toBe(2)
    expect(plan.tagsAdded).toBe(2)
    expect(plan.unmatched).toBe(1)
  })

  it('plans nothing for an empty shelf', () => {
    const plan = planImport(archiveOf([{ bookId: 'b1', title: 'x', author: '', tags: ['a'] }]), [])
    expect(plan.additions).toEqual([])
    expect(plan.unmatched).toBe(1)
  })
})

describe('the file name', () => {
  it('is dated, because the useful question about a backup is when', () => {
    expect(archiveName(new Date(2026, 7, 19))).toBe('paper-tags-2026-08-19.json')
  })

  it('pads a single-digit month and day', () => {
    expect(archiveName(new Date(2026, 0, 5))).toBe('paper-tags-2026-01-05.json')
  })
})
