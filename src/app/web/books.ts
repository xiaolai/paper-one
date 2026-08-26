import type { BookRow, IndexedBook } from '../../kernel'
import type { ShelfChannel } from './channel'

/**
 * The shelf's books, as a store a React view can read (phase 18, WI-18.7).
 *
 * ## Why this is not `LibraryStore`
 *
 * That interface is `add`, `addMany`, `update`, `remove`, `restore`, `lane` —
 * verbs about writing a folder on a disk this client does not have. A thin
 * client streams; importing a book is explicitly not built. Implementing those
 * to throw would be a type that lies about what it can do.
 *
 * What is shared is the shape a view consumes — `getSnapshot`/`subscribe` — and
 * that is deliberate: `libraryStore.ts`'s own header says the verbs live in the
 * store so "a remote service handler — a phone asking the shelf to tag a book —
 * has no component" and the hook is an adapter over those two. This is the
 * other end of the same idea.
 *
 * ## The one rule that makes or breaks it
 *
 * **`getSnapshot` must return the SAME array until something changes.**
 * `useSyncExternalStore` compares by identity: hand back a fresh array each
 * call and React re-renders, re-reads, sees a new array, and re-renders again —
 * for ever, at full speed, with no error anywhere. It presents as the app
 * hanging, and nothing in the network layer looks wrong.
 *
 * That is the failure this file was written most carefully to avoid, and it has
 * its own test.
 *
 * ## What a dropped socket does
 *
 * Nothing, to the snapshot. The books last seen stay on screen and `status()`
 * turns `stale`, so a view can say the shelf went away while still showing what
 * it had. Emptying the list on disconnect would tell a reader their library
 * vanished, which is both alarming and false.
 */

/** One book, as `book.list` answers.
 *
 * **The field is `bookId`, not `id`**, and this said `id` for a day. Every row
 * was dropped, the shelf rendered "0 books", and nothing failed: not a test,
 * not a type, not the network. The tests agreed because they were written from
 * the same assumption — a fixture is only as true as the guess behind it.
 *
 * Named exactly as `services/rows.ts` names it, so the next reader can compare
 * the two without a translation layer in between. */
export type { BookRow }

/**
 * ⚠️ **THE ROW IS THE KERNEL'S TYPE, IMPORTED — not a copy of it.**
 *
 * This was a hand-written interface with FIVE fields while the wire sent
 * EIGHTEEN. `services/rows.ts` had been carrying `tags`, `subjects`, `series`,
 * `addedAt`, `openedAt`, `format` and `hasContent` all along, and `parseRows`
 * dropped every one of them on the floor. The shelf could not filter by tag,
 * sort by when a book was added, or say "this one will not open" — not because
 * the shelf did not know, but because the client threw the answer away and
 * nobody could see it doing so.
 *
 * A restated type cannot notice that. Importing the real one means the two
 * cannot disagree at all: add a field to the wire and this file stops
 * compiling until `parseRows` decides what to do with it, which is the
 * conversation that should happen. That is strictly stronger than a test
 * comparing two field lists, and it is available only because WI-19.1 made
 * `src/kernel/index.ts` importable from a browser at all.
 */

/** What the store can say about itself. */
export type BooksStatus =
  /** No answer yet, and none has failed. */
  | 'loading'
  /** The snapshot is what the shelf last said, and the channel is live. */
  | 'ready'
  /** The snapshot is what the shelf last said, and the channel has gone. */
  | 'stale'
  /** Nothing was ever loaded, and the attempt failed. */
  | 'failed'

export interface RemoteBooks {
  /** The same array until something changes. See the header. */
  getSnapshot(): readonly BookRow[]
  subscribe(listener: () => void): () => void
  status(): BooksStatus
  /**
   * Why the last attempt failed, or null.
   *
   * ⚠️ THIS WAS SWALLOWED, and it cost an afternoon. `catch {}` turned every
   * refusal into the word "failed" — a refused service, a wrong shape, a dead
   * socket and a timeout all rendered identically, and the shelf said "not
   * answering" while the shelf was answering perfectly and saying no. A
   * discarded reason is a debugging session someone else has to repeat.
   */
  reason(): string | null
  /** Ask the shelf again. Safe to call at any time. */
  refresh(): Promise<void>
  dispose(): void
}

/* NULL FOR ANYTHING THAT IS NOT THE EXPECTED TYPE, never a coerced value. This
 * parses somebody else's JSON: a number where a string belongs is a shelf
 * disagreeing with this client about the wire, and `String(x)` would hide that
 * behind a plausible-looking row. */
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strings = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** The formats `services/rows.ts` can send. Anything else reads as unknown. */
const FORMATS = new Set(['epub', 'pdf', 'mobi', 'azw3', 'cbz', 'fb2', 'fbz', 'bin'])

/** The rows out of a `book.list` answer, ignoring anything unrecognised. */
export function parseRows(answer: unknown): readonly BookRow[] {
  if (!Array.isArray(answer)) return []
  const rows: BookRow[] = []
  for (const item of answer) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    /* A ROW WITHOUT AN ID IS NOT A BOOK. React keys on it and a duplicate or
     * missing key is a rendering bug three screens away from its cause. */
    if (typeof row['bookId'] !== 'string' || row['bookId'] === '') continue
    rows.push({
      bookId: row['bookId'],
      title: str(row['title']) ?? '',
      author: str(row['author']) ?? '',
      series: str(row['series']),
      seriesIndex: num(row['seriesIndex']),
      publisher: str(row['publisher']),
      published: str(row['published']),
      languages: strings(row['languages']),
      subjects: strings(row['subjects']),
      tags: strings(row['tags']),
      position: str(row['position']),
      progress: num(row['progress']) ?? 0,
      finished: row['finished'] === true,
      addedAt: num(row['addedAt']),
      openedAt: num(row['openedAt']),
      format: FORMATS.has(row['format'] as string) ? (row['format'] as BookRow['format']) : null,
      contentHash: str(row['contentHash']),
      /* THREE STATES, NOT TWO. `hasContent` is present / absent / never
       * measured, and `?? false` would collapse the third into "absent" — a
       * definite answer this client has no grounds to give. */
      hasContent: typeof row['hasContent'] === 'boolean' ? row['hasContent'] : null,
    })
  }
  return rows
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** True when two snapshots say the same thing. */
function same(a: readonly BookRow[], b: readonly BookRow[]): boolean {
  if (a.length !== b.length) return false
  return a.every((row, i) => {
    const other = b[i]!
    return (
      row.bookId === other.bookId &&
      row.title === other.title &&
      row.author === other.author &&
      row.series === other.series &&
      row.seriesIndex === other.seriesIndex &&
      row.publisher === other.publisher &&
      row.published === other.published &&
      sameList(row.languages, other.languages) &&
      sameList(row.subjects, other.subjects) &&
      /* TAGS ARE THE ONE MOST LIKELY TO CHANGE ALONE. Comparing the array by
       * reference would make a re-tag invisible to the shelf, which is the
       * exact bug `getSnapshot`'s stability contract invites. */
      sameList(row.tags, other.tags) &&
      row.position === other.position &&
      row.progress === other.progress &&
      row.finished === other.finished &&
      row.addedAt === other.addedAt &&
      row.openedAt === other.openedAt &&
      row.format === other.format &&
      row.contentHash === other.contentHash &&
      row.hasContent === other.hasContent
    )
  })
}

export function createRemoteBooks(channel: ShelfChannel): RemoteBooks {
  let rows: readonly BookRow[] = []
  let state: BooksStatus = 'loading'
  let why: string | null = null
  let disposed = false
  const listeners = new Set<() => void>()

  const publish = () => {
    for (const listener of [...listeners]) listener()
  }

  const setStatus = (next: BooksStatus) => {
    if (state === next) return
    state = next
    publish()
  }

  const unsubscribeClosed = channel.onClosed(() => {
    if (disposed) return
    /* THE BOOKS STAY. A reader mid-shelf whose shelf went to sleep should see
     * what they had and a note about it, not an empty library. */
    setStatus(rows.length > 0 ? 'stale' : 'failed')
  })

  const refresh = async () => {
    if (disposed) return
    /* `book.list` IS A STREAM, not a call.
     *
     * `serviceTable.ts` declares it `kind: 'stream'` — it answers many rows,
     * page by page — and asking for it with `call` earns
     * "protocol: stream frame for a plain call" from the router. The shelf was
     * answering correctly the whole time and saying no; the client was asking
     * the wrong question. Found in one run once the refusal stopped being
     * swallowed, and not before. */
    const collected: unknown[] = []
    try {
      for await (const item of channel.stream('book.list', {})) {
        /* A page may arrive as one row or as an array of them. Flattened here
         * so `parseRows` sees one shape whichever the shelf sends. */
        if (Array.isArray(item)) collected.push(...item)
        else collected.push(item)
      }
    } catch (thrown) {
      if (disposed) return
      why = thrown instanceof Error ? thrown.message : String(thrown)
      setStatus(rows.length > 0 ? 'stale' : 'failed')
      publish()
      return
    }
    if (disposed) return
    why = null
    const next = parseRows(collected)
    /* THE IDENTITY RULE. A new array is published only when the CONTENT
     * changed; an unchanged answer keeps the previous array, so a poll that
     * finds nothing new costs no render. Publishing a fresh array every time
     * would re-render the whole shelf on every refresh. */
    if (!same(rows, next)) {
      rows = next
      state = 'ready'
      publish()
      return
    }
    setStatus('ready')
  }

  void refresh()

  return {
    getSnapshot: () => rows,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    status: () => state,
    reason: () => why,
    refresh,
    dispose: () => {
      disposed = true
      unsubscribeClosed()
      listeners.clear()
    },
  }
}

/**
 * A wire row as the shelf screen wants it.
 *
 * `screens/Library.tsx` takes `IndexedBook[]` — `BookRecord` plus an id — and
 * the wire sends `BookRow`. The two carry the SAME FACTS and disagree only
 * about how they spell "absent": the record uses optional fields, the wire uses
 * `null`, because a field that is missing from JSON and a field that is
 * explicitly empty are different answers on a wire and the same answer in
 * TypeScript.
 *
 * ⚠️ **`hasContent` KEEPS ITS THIRD STATE.** Present, absent, and never
 * measured. `IndexedBook.hasContent` is `boolean | undefined` and that is
 * exactly the right shape for it: `undefined` is "nobody has looked", which is
 * what a browser can honestly say about a file on another machine's disk.
 * Coercing it to `false` would make the shelf claim every book is missing.
 */
export function asIndexedBook(row: BookRow): IndexedBook {
  return {
    bookId: row.bookId,
    title: row.title,
    author: row.author,
    ...(row.series !== null ? { series: row.series } : {}),
    ...(row.seriesIndex !== null ? { seriesIndex: row.seriesIndex } : {}),
    ...(row.publisher !== null ? { publisher: row.publisher } : {}),
    ...(row.published !== null ? { published: row.published } : {}),
    languages: row.languages,
    subjects: row.subjects,
    tags: row.tags,
    position: row.position,
    progress: row.progress,
    finished: row.finished,
    ...(row.addedAt !== null ? { addedAt: row.addedAt } : {}),
    ...(row.openedAt !== null ? { openedAt: row.openedAt } : {}),
    ...(row.hasContent !== null ? { hasContent: row.hasContent } : {}),
  }
}
