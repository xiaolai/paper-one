/**
 * Where a reader stopped, kept in the browser (phase 18).
 *
 * ## Why this is not `book.set`
 *
 * The desktop keeps a reading position on the book's record, and it syncs. The
 * browser client cannot: the pump grants it `readingGrant` and nothing else, so
 * every write in the service table is refused — deliberately, because a hostile
 * EPUB shares this origin and a socket it opens carries the reader's session.
 *
 * Widening that for a position would be widening it for `book.set`, which also
 * carries a title, an author and a tag list. So the position stays here.
 *
 * ## What that costs, said plainly
 *
 * **A position kept here is device-local and does not sync.** Read three
 * chapters on a phone and the desktop still opens where the desktop left off.
 * That is a real limitation and not a temporary one — closing it needs a write
 * path the plan deliberately does not create, and the day it exists this module
 * is what it replaces.
 *
 * ## Why `localStorage` is not the credential problem
 *
 * §6 of the plan is emphatic that the credential is NOT in storage, because a
 * book's script would share this origin and could read it. A reading position
 * is the opposite kind of value: a book that could read one learns where its
 * own reader is, which it already knows. `make-hostile-epub.py` probes both
 * storages for anything resembling `paper_session`, and this writes nothing of
 * the sort.
 *
 * ## Failing soft is the contract
 *
 * Storage throws on a full quota, in private browsing on some engines, and
 * whenever a reader has disabled it. **A lost position must never be a lost
 * book**, so every path here answers "no position" rather than raising. That is
 * why `get` returns `null` for a malformed store instead of repairing it.
 */

/** The one key. Namespaced, because the origin is shared with nothing else. */
const KEY = 'paper.reading-positions'

/**
 * How many books keep a position.
 *
 * A library is 1 961 books here and `localStorage` is about 5 MB per origin; a
 * CFI is a hundred-odd characters, so the whole library would fit. The cap is
 * not about the arithmetic — it is that an unbounded store has no worst case,
 * and a quota error is silent and permanent once reached.
 *
 * Least-recently-READ is what gets dropped, which is the honest order: a book
 * nobody has opened in five hundred books' time is one whose position nobody is
 * about to want.
 */
const KEEP = 500

interface Stored {
  /** The CFI foliate reported. */
  readonly cfi: string
  /** When it was written, for the eviction order. Not shown to anyone. */
  readonly at: number
}

export interface ReadingPositions {
  /** Where this book was left, or null. */
  get(bookId: string): string | null
  /** Remember where this book is now. Safe to call on every page turn. */
  set(bookId: string, cfi: string | null): void
  /**
   * This book is being read NOW — refresh its place in the eviction order
   * without moving its position. Called when a book is opened.
   *
   * `at` orders eviction and `set` only writes it when the cfi changes, so
   * without this it meant "last moved" rather than "last read": a reader who
   * reopens a favourite at the same line never refreshed it, and the book they
   * had open could age past the cap and be evicted. A no-op for a book with no
   * stored position — opening a book for the first time is `set`'s job.
   */
  touch(bookId: string): void
  /** Forget one book — for a book the shelf no longer has. */
  forget(bookId: string): void
}

/** Everything this module needs from storage, so a test needs no browser. */
export interface PositionStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A map with no prototype — see the note in `read`. */
const empty = (): Record<string, Stored> => Object.create(null) as Record<string, Stored>

/** The stored map, or an empty one for anything unreadable. */
function read(store: PositionStore): Record<string, Stored> {
  let raw: string | null
  try {
    raw = store.getItem(KEY)
  } catch {
    /* Reading can throw too — Safari's private mode has done exactly this. */
    return empty()
  }
  if (raw === null) return empty()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty()
    /* NO PROTOTYPE, because a book id is a KEY FROM STORAGE and storage is not
     * trusted input. `__proto__` is a perfectly valid string and assigning to
     * it on an object literal does not create an entry — it REPLACES the
     * object's prototype. A row under that key therefore vanished on read, and
     * a hostile or merely corrupt store could reach every later lookup on this
     * map through the prototype it had just installed. `constructor` and
     * `toString` are the same shape one step down: `bookId in all` and
     * `all[bookId]` both answer for keys nothing ever wrote.
     *
     * `Object.create(null)` has no prototype to replace and no inherited names
     * to collide with, which settles all three at once. `Object.entries` and
     * `Object.fromEntries` below are already own-property-only, so the write
     * path needs nothing further. */
    const out: Record<string, Stored> = Object.create(null) as Record<string, Stored>
    for (const [bookId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const row = value as Record<string, unknown>
      /* A ROW WITHOUT A CFI IS NOT A POSITION. `at` is allowed to be missing —
       * it only orders eviction — but a missing or empty cfi would send a
       * reader to the start of the book while claiming to restore them. */
      if (typeof row['cfi'] !== 'string' || row['cfi'] === '') continue
      out[bookId] = { cfi: row['cfi'], at: typeof row['at'] === 'number' ? row['at'] : 0 }
    }
    return out
  } catch {
    /* NOT REPAIRED, NOT CLEARED. A store this cannot parse is one something
     * else may own; overwriting it would be this module deciding that. Reading
     * as empty loses positions and nothing else. */
    return empty()
  }
}

/**
 * Reading positions over `store`.
 *
 * `now` is injected so eviction order is testable without waiting.
 */
export function readingPositions(
  store: PositionStore,
  now: () => number = () => Date.now(),
): ReadingPositions {
  const write = (all: Record<string, Stored>): void => {
    /* OLDEST FIRST OUT, and only when there are more than the cap. Sorting
     * every write is O(n log n) on at most `KEEP` entries, which is nothing
     * beside the JSON round trip that follows it. */
    const entries = Object.entries(all)
    const kept =
      entries.length <= KEEP
        ? entries
        : entries.sort(([, a], [, b]) => b.at - a.at).slice(0, KEEP)
    try {
      store.setItem(KEY, JSON.stringify(Object.fromEntries(kept)))
    } catch {
      /* A FULL QUOTA LOSES A POSITION, NOT A BOOK. There is nothing useful to
       * do here: the reader is mid-page-turn, and an alert about storage would
       * be the app interrupting reading to report on itself. */
    }
  }

  return {
    get: (bookId) => read(store)[bookId]?.cfi ?? null,

    set: (bookId, cfi) => {
      /* A NULL CFI IS NOT A POSITION. The fixed-layout renderer reports one for
       * some documents, and storing it would overwrite a good position with
       * nothing — so the previous one stands, which is the better answer. */
      if (cfi === null || cfi === '') return
      const all = read(store)
      /* AN UNCHANGED CFI STILL REFRESHES `at`, and returning early did not.
       *
       * `at` is what eviction sorts on, so it has to mean "last read" and not
       * "last MOVED". A reader who opens a favourite, reads a page, and comes
       * back to the same place reports the same cfi — so the book they are
       * actually reading kept the timestamp of the last time they turned a
       * page in it, aged past the cap, and was evicted while open. The write is
       * skipped only when neither field would change. */
      if (all[bookId]?.cfi === cfi) return
      write({ ...all, [bookId]: { cfi, at: now() } })
    },

    touch: (bookId) => {
      /* RECENCY IS NOT THE SAME QUESTION AS POSITION, and `at` had to answer
       * both. It orders eviction, so it has to mean "last read"; `set` only
       * writes it when the cfi CHANGES, so it actually meant "last moved".
       *
       * A reader who opens a favourite, reads a page, and comes back to the
       * same line reports the same cfi every time — so the book they had open
       * kept the timestamp of the last page turn, aged past the cap, and was
       * evicted while they were reading it.
       *
       * A separate verb rather than making `set` always write, deliberately.
       * `set` runs on every relocate the renderer raises, many of which report
       * an unchanged cfi; writing on each would put a `localStorage`
       * serialisation of up to 500 entries in the page-turn path for no new
       * information. This runs once, when a book is opened. */
      const all = read(store)
      const held = all[bookId]
      if (held === undefined) return
      write({ ...all, [bookId]: { cfi: held.cfi, at: now() } })
    },

    forget: (bookId) => {
      const all = read(store)
      if (!(bookId in all)) return
      const { [bookId]: _gone, ...rest } = all
      write(rest)
    },
  }
}

/**
 * The browser's own storage, or a store that remembers nothing.
 *
 * `localStorage` is a getter that THROWS in some configurations rather than
 * being absent — Chrome does this when a reader blocks site data — so touching
 * it needs the same care as using it.
 */
export function browserPositions(): ReadingPositions {
  try {
    return readingPositions(window.localStorage)
  } catch {
    const nothing: PositionStore = { getItem: () => null, setItem: () => {} }
    return readingPositions(nothing)
  }
}
