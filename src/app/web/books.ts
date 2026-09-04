import type { BookRow, IndexedBook, Hlc } from '../../kernel'
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
/* Shared with the other stores — see `wireRow.ts`, which was extracted when
 * `marks.ts` and `cards.ts` turned out to be casting where this file reads. */
import { byFirstId, num, str, strings } from './wireRow'
import { READING_STATES, STARS, isContentHash, isHlc, type ReadingState, type Stars } from '../../kernel'

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
      /* WI-21.3. Carried rather than dropped for the reason the header gives:
         the row IS the kernel's type, so adding a field to the wire stops this
         file compiling until `parseRows` decides what to do with it — which is
         the conversation that should happen, and did. */
      identifier: str(row['identifier']),
      series: str(row['series']),
      seriesIndex: num(row['seriesIndex']),
      publisher: str(row['publisher']),
      published: str(row['published']),
      languages: strings(row['languages']),
      subjects: strings(row['subjects']),
      tags: strings(row['tags']),
      position: str(row['position']),
      progress: within01(num(row['progress'])),
      finished: row['finished'] === true,
      /* The reader's own opinion (WI-23.B3), read as the row declares it: a
         status outside the kernel's own vocabulary is a shelf disagreeing
         about the wire and reads as nothing said, never as a fourth state.
         AGAINST `READING_STATES`, not a list spelled out here — the three
         words were restated inline, and a fourth state added to the kernel
         would have read as "nothing said" on every browser shelf. */
      status: (READING_STATES as readonly unknown[]).includes(row['status']) ? (row['status'] as ReadingState) : null,
      /* A stamp that is not an HLC is no stamp: it would be cast to one
         further down and merged as though it ordered anything. */
      statusAt: stamp(row['statusAt']),
      rating: stars(row['rating']),
      ratingAt: stamp(row['ratingAt']),
      review: str(row['review']),
      reviewAt: stamp(row['reviewAt']),
      addedAt: num(row['addedAt']),
      openedAt: num(row['openedAt']),
      format: FORMATS.has(row['format'] as string) ? (row['format'] as BookRow['format']) : null,
      /* A DIGEST OR NOTHING — the kernel's one rule, `isContentHash`. This
         took any string, and `asIndexedBook` then published it as the row's
         cache generation: a shelf sending `"h"` handed every view a
         generation that no real hash could ever equal, so changed bytes
         reused it. The record parser and the sync wire refuse the same
         shape; the browser was the door with no guard on it. */
      contentHash: isContentHash(row['contentHash']) ? row['contentHash'] : null,
      /* THREE STATES, NOT TWO. `hasContent` is present / absent / never
       * measured, and `?? false` would collapse the third into "absent" — a
       * definite answer this client has no grounds to give. */
      hasContent: typeof row['hasContent'] === 'boolean' ? row['hasContent'] : null,
    })
  }
  /* ⚠️ A DUPLICATE `bookId` IS NOT HARMLESS. Every list here keys on it, and
     React resolves a repeated key by rendering one of the two and discarding
     the other — a book that vanishes from the shelf, three screens from the
     cause. The comment above says "a duplicate or missing key is a rendering
     bug"; only the missing half was actually handled. */
  return byFirstId(rows, (row) => row.bookId)
}

const stamp = (value: unknown): Hlc | null => (isHlc(value) ? value : null)
/** A progress is a fraction of the book: outside 0–1 it is clamped, and not a number at all reads as none — the record parser's own rule. `num` has already refused anything that is not finite. */
const within01 = (value: number | null): number => (value === null ? 0 : Math.min(1, Math.max(0, value)))
const stars = (value: unknown): Stars | null => (STARS as readonly unknown[]).includes(value) ? (value as Stars) : null

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
      row.identifier === other.identifier &&
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
      row.status === other.status &&
      row.statusAt === other.statusAt &&
      row.rating === other.rating &&
      row.ratingAt === other.ratingAt &&
      row.review === other.review &&
      row.reviewAt === other.reviewAt &&
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
  /**
   * WHICH REFRESH IS THE CURRENT ONE.
   *
   * ⚠️ `refresh` is public and called from several places — mount, a manual
   * pull, the reconnect path — and nothing stopped two running at once. Each
   * awaits a stream, so the one that STARTED first can FINISH last: an older
   * shelf overwrote a newer one, and the status with it. The reader sees the
   * library go backwards, and a retry that "worked" leaves the stale answer on
   * screen.
   *
   * A generation rather than a mutex: refusing to start a second refresh would
   * make a manual pull silently do nothing while a slow poll is in flight. This
   * lets every refresh run and publishes only the newest.
   */
  let generation = 0
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
    const mine = ++generation
    /** Superseded by a later refresh, or torn down. */
    const stale = () => disposed || mine !== generation
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
      if (stale()) return
      const before = why
      why = thrown instanceof Error ? thrown.message : String(thrown)
      /* ONE WAKE-UP, NOT TWO. `setStatus` publishes when the status changes and
         this published again unconditionally, so every failure re-rendered
         every subscriber twice for one piece of news. */
      /* Once per piece of news — and a changed REASON is news, even when the
         state it lands in is the one already shown. */
      // Stryker disable next-line ConditionalExpression: the rows only change on a success, which clears the reason — so a state that moved under the same reason cannot be presented.
      const moved = state !== (rows.length > 0 ? 'stale' : 'failed') || why !== before
      state = rows.length > 0 ? 'stale' : 'failed'
      if (moved) publish()
      return
    }
    if (stale()) return
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
    /* ⚠️ CARRIED, not merely parsed and compared. `parseRows` reads it and
       `same` observes it, so a changed identifier already re-renders the shelf
       — and without this line the value was then DISCARDED before any consumer
       saw it: a re-render for a field nobody could read. WI-21.3 asks this row
       to "parse, compare and carry", and carrying is the third of the three. */
    ...(row.identifier !== null ? { identifier: row.identifier } : {}),
    /* The reader's own opinion (WI-23.B3), carried with the stamps the row
       has: a shelf drawn from the wire says what the reader said, and a
       register with no stamp on the wire is one with none here. */
    ...(row.status !== null && row.statusAt !== null ? { status: { state: row.status, at: row.statusAt as Hlc } } : {}),
    /* One to five, as the record holds it — `parseRows` already refused
       anything else, and `BookRow.rating` is typed `Stars | null` to say so;
       a second membership test here was a fallback no caller could reach. */
    ...(row.rating !== null ? { rating: row.rating, ...(row.ratingAt !== null ? { ratingAt: row.ratingAt as Hlc } : {}) } : {}),
    ...(row.review !== null && row.reviewAt !== null ? { review: { text: row.review, at: row.reviewAt as Hlc } } : {}),
    /* What the bytes are, and their digest — representable, and read by the
       shelf's own views, so a shelf drawn from the wire carries them too. */
    ...(row.format !== null ? { format: row.format } : {}),
    ...(row.contentHash !== null ? { contentHash: row.contentHash } : {}),
    ...(row.series !== null ? { series: row.series } : {}),
    ...(row.seriesIndex !== null ? { seriesIndex: row.seriesIndex } : {}),
    ...(row.publisher !== null ? { publisher: row.publisher } : {}),
    ...(row.published !== null ? { published: row.published } : {}),
    languages: row.languages,
    subjects: row.subjects,
    tags: row.tags,
    position: row.position,
    progress: row.progress,
    /* ONE FACT, NOT TWO — the kernel's own rule (`parseRecord`, the sync
       merge, `setStatus`): with a status on the wire, `finished` FOLLOWS it
       and is stamped by it, and the legacy flag speaks only for a row that
       carries no status. This copied the flag beside the status, so a row
       saying `reading` next to `finished: true` became a record that said
       both, and the status filter and the progress bar disagreed about it. */
    ...(row.status !== null && row.statusAt !== null
      ? { finished: row.status === 'finished', finishedAt: row.statusAt as Hlc }
      : { finished: row.finished }),
    ...(row.addedAt !== null ? { addedAt: row.addedAt } : {}),
    ...(row.openedAt !== null ? { openedAt: row.openedAt } : {}),
    ...(row.hasContent !== null ? { hasContent: row.hasContent } : {}),
  }
}
