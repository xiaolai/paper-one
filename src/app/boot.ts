import type { IndexedBook } from '../kernel'

/**
 * THE SHELF'S BOOT ORDER, extracted from `main.tsx` so it can be tested.
 *
 * It lived inline in a boot function that reads `document`, mounts a React
 * root and imports native modules — the same place the quit handshake lived
 * before `shutdown.ts`, and for the same reason it left: none of its ordering
 * had ever been executed by a test. The order is the whole thing:
 *
 *   1. `migrate` — carry a phase-3 library across BEFORE the shelf is read,
 *      because the shelf is built by scanning book folders and a book that
 *      has not been migrated has no folder to find.
 *   2. `finishPendingRemovals` — a removal writes the presence register FIRST
 *      and moves the folder SECOND, so a crash between the two leaves a live
 *      folder the register says is gone. `presence.ts` describes launch
 *      recovery finishing that rename; NOTHING CALLED IT. The shelf showed
 *      the book while sync told every peer it was removed. Before the shelf
 *      is read, so the condemned folder is in the trash before a row is
 *      built for it.
 *   3. `loadShelf` — the cache when it can be trusted, a scan when not; a
 *      shelf that will not load is reported as unread, never as empty.
 *
 * Everything arrives as an argument — the composition root wraps its own
 * timing around each — so this file imports nothing native and the order is
 * asserted with fakes. The trash sweep is NOT here: it runs after the
 * services exist, on each book's lane (`Library.emptyExpiredTrash`), because
 * off the lanes it raced restores.
 *
 * `legacySources` is here too — the read step 1 is handed — for the same reason
 * the order is: it was inline in `bootApp.ts`, where no test could reach it.
 */

export interface BootDeps<F, L, O> {
  /** The library's filesystem, or null outside Tauri — then nothing runs. */
  readonly fs: F | null
  /** The phase-3 stores to carry across, or null when there is no store to read. */
  readonly legacy: (() => L) | null
  readonly migrate: (fs: F, legacy: L) => Promise<O>
  /** One line about what the migration did, or null for nothing. */
  readonly summarise: (outcomes: O) => string | null
  readonly finishPendingRemovals: (fs: F) => Promise<readonly string[]>
  readonly loadShelf: (fs: F) => Promise<{ readonly books: readonly IndexedBook[] }>
  readonly report: {
    readonly info: (message: string) => void
    readonly error: (message: string, cause: unknown) => void
  }
}

export interface Booted {
  readonly initialBooks: readonly IndexedBook[]
  /** The shelf could not be READ — which is not the same as having no books. */
  readonly shelfUnread: boolean
  /** The removals a crash left half done, finished now. */
  readonly recovered: readonly string[]
  /** The previous library could not be carried across — see `bootNoticeOf`. */
  readonly carryRefused: boolean
}

/**
 * What the reader is told when the previous library could not be carried across.
 *
 * ⚠️ **IT WAS SAID ONLY TO THE CONSOLE** (decided 2026-09-14). A migration refused
 * over a damaged legacy value leaves those books where they were and loads the
 * shelf without them, so the reader saw a library missing books with nothing to
 * say why. Nothing is lost — the refusal exists to keep the old values
 * repairable — and the sentence says both.
 */
export const CARRY_REFUSED_NOTICE =
  'Books from an earlier version of Paper could not be carried into your library. Nothing was deleted; they stay where they were.'

/** The launch notice: what the store said, then a refused carry, or null for neither. */
export function bootNoticeOf(storeNotice: string | null, booted: Pick<Booted, 'carryRefused'>): string | null {
  const said = [storeNotice, booted.carryRefused ? CARRY_REFUSED_NOTICE : null].filter((one): one is string => one !== null)
  return said.length === 0 ? null : said.join(' ')
}

export async function bootShelf<F, L, O>(deps: BootDeps<F, L, O>): Promise<Booted> {
  const { fs } = deps
  if (fs === null) return { initialBooks: [], shelfUnread: false, recovered: [], carryRefused: false }

  /* FAILURE IS SWALLOWED RATHER THAN FATAL. A migration that cannot run leaves
   * the phase-3 files untouched, which is recoverable; refusing to start is
   * not. It is SAID, though — to the console and, through `carryRefused`, to
   * the reader. */
  let carryRefused = false
  if (deps.legacy !== null) {
    try {
      const said = deps.summarise(await deps.migrate(fs, deps.legacy()))
      if (said) deps.report.info(`Paper: ${said}`)
    } catch (cause) {
      deps.report.error('Paper: could not carry the previous library across', cause)
      carryRefused = true
    }
  }

  /* BEST EFFORT, AND SAID. The recovery is per book inside; what can fail
   * here is reading the register at all, and a shelf must still load. */
  let recovered: readonly string[] = []
  try {
    recovered = await deps.finishPendingRemovals(fs)
    if (recovered.length > 0) {
      deps.report.info(
        `Paper: finished ${recovered.length} ${recovered.length === 1 ? 'removal' : 'removals'} a crash had left half done`,
      )
    }
  } catch (cause) {
    deps.report.error('Paper: could not finish pending removals', cause)
  }

  /* A SHELF THAT WILL NOT LOAD IS NOT AN EMPTY SHELF, and the reader is told
   * which. Swallowing it drew "Your library is empty" over a library that is
   * still on disk — the single most alarming thing this app can say. */
  try {
    const shelf = await deps.loadShelf(fs)
    return { initialBooks: shelf.books, shelfUnread: false, recovered, carryRefused }
  } catch (cause) {
    deps.report.error('Paper: could not read the library', cause)
    return { initialBooks: [], shelfUnread: true, recovered, carryRefused }
  }
}

/** The phase-3 stores as `migrateToFolders` takes them — its `MigrationSources`, structurally. */
export interface LegacySources {
  readonly rows: readonly Record<string, unknown>[]
  readonly marks: readonly unknown[]
}

/**
 * Read the phase-3 library rows and the shared marks store for the migration,
 * or THROW for either one that is there and will not read.
 *
 * ⚠️ **THIS WAS INLINE IN `bootApp.ts`, WHERE NO TEST COULD REACH IT, AND IT
 * CARRIED AN UNREADABLE MARKS VALUE ACROSS AS NO MARKS.** The fallback was `[]`
 * and a log line: the books migrated without a highlight or note on them,
 * `migrated.json` stamped every one as carried, and a repaired value could then
 * never be carried — the stamp, and a folder that has a record, both make the
 * migration pass a book by. Logging did not prevent the omission, and valid JSON
 * of the wrong shape (an object, `null`) did not even log (2026-09-13 verify).
 *
 * So a value that is there and will not read REFUSES THE WHOLE MIGRATION, and
 * `bootShelf` reports it and loads the shelf. Whole, because `paper.marks.v1` is
 * ONE value for every book — there is no single book to refuse — and because
 * `bootShelf` already states the policy this lands in: a migration that cannot
 * run leaves the phase-3 files untouched, which is recoverable. The cost is
 * stated rather than hidden: the books wait in the old store until the value
 * reads. The migration's own header names its failure mode as a reader's own
 * writing, and a book can be imported again where a note cannot.
 *
 * ⚠️ **THAT REVERSES A DECISION, DELIBERATELY.** The inline reader parsed the
 * two apart "so a malformed marks value does not stop the rows" — which is the
 * exact route by which the rows migrated and stamped without their marks. It
 * said a value that would not parse is SAID rather than silently emptied, and
 * that still holds: `bootShelf` reports the refusal with this clause as cause.
 *
 * ABSENT is nothing to carry. One ROW that is not an object is still dropped
 * alone — a legacy file is one a reader may have hand-edited, so a single bad
 * row must not cost the rest (the cast here used to be `as []`, which claims the
 * EMPTY-tuple type and let `[null, validRow]` through as rows). One MARK with no
 * book is `marksByBook`'s to drop.
 */
export function legacySources(storage: { getItem(key: string): string | null }): LegacySources {
  const rows = storedList(storage.getItem('paper.library.v1'), 'rows')
  const marks = storedList(storage.getItem('paper.marks.v1'), 'marks')
  return {
    rows: rows.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null),
    marks,
  }
}

/** One phase-3 value that must be a list: absent is empty, anything else that is not a list throws. */
function storedList(raw: string | null, what: 'rows' | 'marks'): readonly unknown[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`the previous library's ${what} are not JSON`, { cause })
  }
  if (!Array.isArray(parsed)) throw new Error(`the previous library's ${what} are not a list`)
  return parsed
}
