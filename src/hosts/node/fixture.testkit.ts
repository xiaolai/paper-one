/**
 * ONE fixture library, as a map of relative path to text.
 *
 * Written once and read two ways — laid onto a real directory for the Node
 * host, and handed to the kernel's in-memory `IndexFs` for the seam the rest
 * of the suites run on — so "opens identically" is an assertion about two
 * hosts reading the SAME bytes, not two fixtures that happen to agree.
 *
 * Shaped as a phase-4 library: a book is a folder, `book.json` is the record,
 * `marks.json` sits beside it, and the content file's presence is what makes
 * `hasContent` true. No `index.json` — a first open has no cache, which is
 * the case a host has to get right before any other.
 */

/**
 * A record, whose `bookId` the caller CANNOT overwrite.
 *
 * `fields` was `Record<string, unknown>` spread AFTER `bookId`, so a caller
 * could hand it a `bookId` of its own and silently replace the identity this
 * helper's whole purpose is to fix. Typed as "the record, minus the fields
 * this function owns", so trying to is a compile error rather than a fixture
 * that quietly describes a different book.
 */
const record = (bookId: string, fields: Omit<Record<string, unknown>, 'bookId'> & { bookId?: never }): string =>
  JSON.stringify({ ...fields, bookId }, null, 2)

/**
 * A mark row as `marks.json` holds one.
 *
 * EVERY FIELD `isMark` demands is spelled out, because `validMarks` FILTERS
 * rather than throws: a row missing `sectionIndex` or carrying a kind outside
 * the registry is dropped silently, and a fixture built that way would assert
 * "two hosts read zero marks identically".
 */
/**
 * A mark row as `marks.json` holds one.
 *
 * EVERY FIELD `isMark` demands is spelled out, because `validMarks` FILTERS
 * rather than throws: a row missing `sectionIndex` or carrying a kind outside
 * the registry is dropped silently, and a fixture built that way would assert
 * "two hosts read zero marks identically".
 *
 * THE IDENTITY FIELDS ARE NOT OVERRIDABLE. `fields` was untyped and spread
 * LAST, so a caller could replace `id`, `bookId` or `cfi` — the three this
 * helper exists to keep consistent — and the fixture would then describe a
 * mark belonging to a book it was not filed under. The type forbids it; the
 * spread order no longer decides it.
 *
 * THE CFI CARRIES A NUMERIC STEP. It used to interpolate the mark's ID
 * (`epubcfi(/6/4!/4/2/m1)`), and an EPUB CFI path step is a NUMBER — foliate
 * parses `m1` as `NaN`, so both fixture marks were semantically malformed and
 * would compare equal to each other under any real CFI ordering. A fixture
 * that cannot be ordered hides every ordering defect there is.
 */
const mark = (
  id: string,
  book: string,
  step: number,
  fields: Omit<Record<string, unknown>, 'id' | 'bookId' | 'cfi'> & {
    id?: never
    bookId?: never
    cfi?: never
  },
): string =>
  JSON.stringify({
    sectionIndex: 0,
    text: '',
    note: '',
    kind: 'highlight',
    chapter: 'Ch. 1',
    createdAt: 1_700_000_000_000,
    ...fields,
    id,
    bookId: book,
    cfi: `epubcfi(/6/4!/4/2/${step * 2})`,
  })

/**
 * The books, their records and their marks. Three books: one finished with
 * two marks, one unread with bytes and no marks, one row with NO content file
 * at all — which is the case that made `hasContent` exist, and the one a host
 * that reported "openable" for everything would get wrong.
 */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'books/aaa/book.json': record('aaa', {
    title: 'The Wind in the Willows',
    author: 'Kenneth Grahame',
    tags: ['river', 'Classics'],
    finished: true,
    addedAt: 1_700_000_000_000,
  }),
  'books/aaa/content.epub': 'EPUB-AAA',
  /* Two marks at DISTINCT, ordered CFI steps — `/4/2/2` before `/4/2/4` — so
   * anything that sorts or resolves by position has two different positions
   * to tell apart. Both used to interpolate the mark's id into the path step,
   * which parses as `NaN`. */
  'books/aaa/marks.json': `[${mark('m1', 'aaa', 1, { text: 'messing about in boats', note: 'the whole thesis' })},${mark(
    'm2',
    'aaa',
    2,
    { text: 'Toad', kind: 'bookmark' },
  )}]`,
  'books/bbb/book.json': record('bbb', {
    title: 'Moby-Dick',
    author: 'Herman Melville',
    tags: ['Classics'],
    addedAt: 1_700_000_001_000,
  }),
  'books/bbb/content.epub': 'EPUB-BBB',
  'books/ccc/book.json': record('ccc', {
    title: 'A Record With No Bytes',
    author: 'Nobody',
    addedAt: 1_700_000_002_000,
  }),
}

/** What the fixture declares, so a test asserts against the library rather
 *  than against whatever the code happened to produce. */
export const FIXTURE = {
  books: 3,
  ids: ['aaa', 'bbb', 'ccc'] as const,
  withContent: ['aaa', 'bbb'] as const,
  marks: { aaa: 2, bbb: 0, ccc: 0 } as const,
  tags: { Classics: 2, river: 1 } as const,
} as const
