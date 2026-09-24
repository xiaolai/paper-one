import type { IndexedBook } from '../../../kernel'

/**
 * What the index has to be kept in step with, and what "in step" means.
 *
 * ⚠️ **"ADDED AND REMOVED" IS NOT THE LIFECYCLE.** `libraryStore.ts` has
 * `keepContent`, `refreshContent`, `evictContent`, `restore` and `rekeyBook`,
 * and sync calls every one of them. **Metadata can exist before bytes arrive**,
 * and **eviction removes bytes and keeps the book** — so a book can be on the
 * shelf, in the index, and have no file; or be on the shelf with a file and no
 * index entry. Each transition has a search availability, and they are stated
 * here rather than inferred at each call site.
 *
 * | transition | what the index does |
 * |---|---|
 * | metadata arrives, no bytes | nothing — there is no text to extract |
 * | bytes arrive (`keepContent`) | extract and index |
 * | bytes replaced (`refreshContent`, a re-import) | the generation moves, so re-extract |
 * | bytes evicted (`evictContent`) | FORGET — the book is still on the shelf and its text is not on this device |
 * | book trashed (`book.remove`) | forget |
 * | book restored | extract again, from whatever bytes came back |
 * | rekeyed | move the work; never re-extract |
 *
 * ⚠️ **EVICTION FORGETS, AND THAT IS A DECISION RATHER THAN AN OMISSION.** The
 * text is still on disk under `passages/text/`, so keeping it would let a reader
 * search a book whose bytes they deliberately deleted — and then land nowhere,
 * because landing parses the book. A hit that cannot be landed is worse than no
 * hit, which is the phase's own rule.
 */

/**
 * What identifies the BYTES a book's index was built from.
 *
 * ⚠️ **THE CONTENT HASH WHEN THERE IS ONE, AND A DESCRIPTION OF THE FILE WHEN
 * THERE IS NOT.** `contentHash` is BLAKE3 over the file and is exactly the right
 * answer — but it is computed by the peer plugin and is absent on a book nothing
 * has hashed yet, which on a fresh shelf is most of them. Waiting for one would
 * mean a library that becomes searchable only after sync has walked it.
 *
 * The fallback names what this device can see about the file: its extension and
 * its format. ⚠️ **THAT IS DELIBERATELY WEAK AND IT IS SAID SO HERE**: two
 * different files of the same format under one book id produce the same
 * generation, so a re-import that does not move the hash is not noticed. What
 * makes that acceptable is that `refreshContent` is the path a re-import takes
 * and the freshness driver re-extracts on it REGARDLESS of the generation — the
 * generation is the *steady-state* check, not the only one.
 *
 * ⚠️ **AND IT IS PREFIXED, SO THE TWO CANNOT BE CONFUSED.** A bare hash and a
 * bare description could in principle collide; `b3:` and `file:` make the answer
 * say which question it answered.
 */
export function generationOf(book: IndexedBook): string {
  const hash = book.contentHash
  if (typeof hash === 'string' && hash !== '') return `b3:${hash}`
  return `file:${book.ext ?? ''}/${book.format ?? ''}`
}

/**
 * Whether this book has text worth indexing on THIS device.
 *
 * ⚠️ **EPUB ONLY, AND THAT IS THE OWNER'S CHOICE RATHER THAN A LIMITATION OF
 * THE EXTRACTOR.** Measured the hour the phase was written: **1 959 of 1 962
 * books are EPUB (99.8 %)** — one PDF and two unrecorded. PDF extraction would
 * have been the largest risk in the phase, bought for one book.
 *
 * The other formats foliate can parse (MOBI, AZW3, FB2, CBZ) are not excluded
 * for any technical reason — `makeBook` handles them and the walk would work —
 * but nothing on this shelf is one, so nothing would exercise the path. A format
 * nothing tests is a format that breaks silently.
 */
export function indexable(book: IndexedBook): boolean {
  if (book.hasContent !== true) return false
  /* THE STORED EXTENSION FIRST, THEN WHAT TRAVELLED. `ext` is device-local and
   * says how THIS device named its copy; `format` is what sync carries. Reading
   * only the first is what made every replicated non-EPUB unopenable once —
   * `bookVault.storedBookName` records that defect in full. */
  const ext = book.ext ?? book.format ?? ''
  return ext.toLowerCase() === 'epub'
}

/** A book and the generation its index must match, as the plugin asks for it. */
export type Wanted = readonly [bookId: string, generation: string]

/**
 * Every book on the shelf whose text belongs in the index, with its generation.
 *
 * SORTED BY MOST RECENTLY OPENED, then most recently added — so a backfill of
 * 1 959 books makes the books a reader actually touches searchable first. The
 * phase's *"time to first searchable book"* bar is about the first book; which
 * book that is, is this line.
 */
export function wantedFrom(books: readonly IndexedBook[]): readonly Wanted[] {
  return books
    .filter(indexable)
    .slice()
    .sort((a, b) => recencyOf(b) - recencyOf(a))
    .map((book) => [book.bookId, generationOf(book)] as const)
}

function recencyOf(book: IndexedBook): number {
  const opened = typeof book.openedAt === 'number' ? book.openedAt : 0
  const added = typeof book.addedAt === 'number' ? book.addedAt : 0
  return Math.max(opened, added)
}

/**
 * Books the index holds that the shelf no longer wants there.
 *
 * ⚠️ **THIS IS WHAT MAKES AN EVICTION AND A REMOVAL REACH THE INDEX AT ALL.**
 * Neither emits an event this capability could listen for — the library
 * publishes one undifferentiated *"the snapshot changed"* — so the driver
 * compares what is indexed against what is wanted and forgets the difference.
 * Diffing rather than listening also means a removal that happened while the app
 * was closed is noticed on the next launch, which no listener could manage.
 */
export function unwanted(
  indexed: readonly string[],
  wanted: readonly Wanted[],
): readonly string[] {
  const keep = new Set(wanted.map(([bookId]) => bookId))
  return indexed.filter((bookId) => !keep.has(bookId))
}
