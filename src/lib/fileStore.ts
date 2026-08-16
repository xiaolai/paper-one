import type { MarkStorage } from './marks'

/**
 * The reader's own work, on disk instead of in the webview.
 *
 * Marks, cards and the library have lived in three `localStorage` keys: a store
 * with a quota, no backup, and an operating system free to evict it. `writeJson`
 * reports the failure honestly and cannot prevent it. For an application whose
 * value accumulates over years of reading, that is the wrong floor.
 *
 * WHY THIS LOOKS SYNCHRONOUS. `useStoredCollection` mutates, publishes and
 * persists in one synchronous pass, and `useMarking` draws a new mark
 * immediately afterwards — a highlight appearing a frame late is a highlight
 * that flickers. Filesystem access is asynchronous, so rather than make the
 * stores async and lose that, the file is read ONCE before React mounts and
 * held in memory. Reads are served from the cache; writes update the cache
 * synchronously and are flushed to disk behind them.
 *
 * So this implements `MarkStorage` exactly — `getItem`/`setItem` — and the
 * three stores above it are unchanged. What the data LOOKS like is unchanged
 * too: the same keys, holding the same JSON strings those stores already
 * produce. Only where it lives has moved, which is the whole of this phase's
 * remit; how it is encoded belongs to the phase that chooses a sync engine.
 */

/** Where the store lives, relative to the app's data directory. */
export const STORE_FILE = 'paper.store.v1.json'

/** The keys carried over from localStorage on first run. */
export const MIGRATED_KEYS = [
  'paper.marks.v1',
  'paper.cards.v1',
  'paper.library.v1',
] as const

type Contents = Record<string, string>

export interface FileStore extends MarkStorage {
  /** Write anything outstanding now. For teardown, and for tests. */
  flush: () => Promise<void>
  /** False once a write has failed — see the note on reporting, below. */
  readonly healthy: boolean
  /** True when the contents were seeded from localStorage on this run. */
  readonly migrated: boolean
}

/** The filesystem operations this needs, injected so it can be tested. */
export interface FileSystem {
  read: (path: string) => Promise<string | null>
  /** Must be atomic: a torn write loses every mark, not one. */
  write: (path: string, text: string) => Promise<void>
  /**
   * Move a damaged store aside, so the next write cannot destroy it.
   *
   * Optional: a filesystem that cannot rename is still usable, and the store
   * then behaves as it did before this existed.
   */
  quarantine?: (path: string, to: string) => Promise<void>
}

export interface FileStoreOptions {
  fs: FileSystem
  path?: string
  /** Where a first run inherits from. Null skips the migration entirely. */
  legacy?: MarkStorage | null
  /** Coalesces bursts — a page turn writes a position, and so does the next. */
  schedule?: (fn: () => void) => void
}

/**
 * Read the store, migrating from localStorage the first time.
 *
 * Awaited before React mounts. Rendering first and filling in afterwards would
 * show every reader an empty shelf and an unannotated book for a frame, and
 * `useStoredCollection` reads its storage once, in a `useState` initialiser.
 */
export async function openFileStore({
  fs,
  path = STORE_FILE,
  legacy = null,
  schedule = (fn) => void Promise.resolve().then(fn),
}: FileStoreOptions): Promise<FileStore> {
  let contents: Contents = {}
  let migrated = false

  const existing = await fs.read(path)
  if (existing !== null) {
    const readable = parse(existing)
    if (readable === null) {
      /* Unreadable. Moved aside rather than left in place, because leaving it
       * meant the next mark the reader made overwrote it — the ONLY copy of
       * their work, destroyed by the recovery path that claimed to preserve it.
       * The store then starts empty, which is what a reader sees either way;
       * the difference is whether the old bytes still exist afterwards. */
      const aside = `${path}.corrupt`
      try {
        await fs.quarantine?.(path, aside)
        console.error(`Paper: the store could not be read; moved it to ${aside}`)
      } catch (cause) {
        console.error('Paper: the store could not be read, and could not be moved aside', cause)
      }
    } else {
      contents = readable
    }
  } else if (legacy) {
    /* First run after the upgrade. The legacy values are COPIED, not moved:
     * leaving them in place costs a few kilobytes and means an interrupted
     * migration — or a downgrade — still finds the reader's work where it was.
     * Nothing here deletes anything a reader made. */
    for (const key of MIGRATED_KEYS) {
      const value = legacy.getItem(key)
      if (value !== null) contents[key] = value
    }
    migrated = Object.keys(contents).length > 0
  }

  let healthy = true
  /** Something has changed since the last write was chained. */
  let dirty = false
  /** A coalescing callback is queued and has not yet run. */
  let queued = false
  /** Writes run one after another, never overlapping. */
  let inFlight: Promise<void> = Promise.resolve()

  const writeNow = async () => {
    const snapshot = JSON.stringify(contents)
    try {
      await fs.write(path, snapshot)
      healthy = true
    } catch (cause) {
      healthy = false
      console.error('Paper: could not save to disk', cause)
    }
  }

  /* `dirty` and `queued` are two flags rather than one because they answer
   * different questions, and collapsing them wrote the file twice: a `flush`
   * arriving before the queued callback would chain a write and clear the flag,
   * and the callback would then chain a second one for the same change. */
  const chain = () => {
    dirty = false
    inFlight = inFlight.then(writeNow)
  }

  const enqueue = () => {
    dirty = true
    if (queued) return
    queued = true
    schedule(() => {
      queued = false
      if (dirty) chain()
    })
  }

  const store: FileStore = {
    getItem: (key) => contents[key] ?? null,

    setItem: (key, value) => {
      contents[key] = value
      /* Scheduled BEFORE the throw below, so an unhealthy store can recover.
       * Throwing first meant a single failed write was permanent: nothing was
       * ever queued again, so nothing ever succeeded again, and the reader was
       * told their work was unsaved forever with no way back. */
      enqueue()
      /* Reported on the NEXT write rather than this one. `MarkStorage.setItem`
       * is synchronous and signals failure by throwing, and a disk write cannot
       * have failed yet at the moment it is called — so a store that has gone
       * bad refuses the next write, and the reader is told one action later
       * than the fault. Better than a failure nobody ever hears about, and the
       * honest limit of a synchronous face on an asynchronous store. */
      if (!healthy) throw new Error('the previous save to disk failed')
    },

    flush: async () => {
      if (dirty) chain()
      await inFlight
    },

    get healthy() {
      return healthy
    },
    get migrated() {
      return migrated
    },
  }

  /* A migration that produced something is written immediately: a reader who
   * upgrades and never makes another mark should still have the file. Marked
   * dirty explicitly, because seeding filled `contents` directly rather than
   * through `setItem` — so nothing had queued a write and the first flush wrote
   * nothing at all. */
  if (migrated) {
    dirty = true
    await store.flush()
  }

  return store
}

/** The contents, or null when the payload is not a store at all. */
function parse(text: string): Contents | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    // Only string entries: every store above this writes a JSON string, and a
    // non-string here would reach `JSON.parse` in a parser expecting one.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => typeof v === 'string',
      ),
    ) as Contents
  } catch {
    /* Reported to the caller rather than thrown. Throwing here would happen
     * before React mounts and take the whole application down — a reader whose
     * marks file was truncated would get no application at all, rather than one
     * that has lost some marks. The caller moves the file aside so it survives
     * the next write. */
    return null
  }
}
