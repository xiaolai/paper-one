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
}

export async function bootShelf<F, L, O>(deps: BootDeps<F, L, O>): Promise<Booted> {
  const { fs } = deps
  if (fs === null) return { initialBooks: [], shelfUnread: false, recovered: [] }

  /* FAILURE IS SWALLOWED RATHER THAN FATAL. A migration that cannot run leaves
   * the phase-3 files untouched, which is recoverable; refusing to start is
   * not. */
  if (deps.legacy !== null) {
    try {
      const said = deps.summarise(await deps.migrate(fs, deps.legacy()))
      if (said) deps.report.info(`Paper: ${said}`)
    } catch (cause) {
      deps.report.error('Paper: could not carry the previous library across', cause)
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
    return { initialBooks: shelf.books, shelfUnread: false, recovered }
  } catch (cause) {
    deps.report.error('Paper: could not read the library', cause)
    return { initialBooks: [], shelfUnread: true, recovered }
  }
}
