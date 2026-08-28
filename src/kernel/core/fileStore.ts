import type { MarkStorage } from './marks'

/**
 * The reader's own work, on disk instead of in the webview.
 *
 * Marks, cards and the library have lived in three `localStorage` keys: a store
 * with a quota, no backup, and an operating system free to evict it. `writeJson`
 * reports the failure honestly and cannot prevent it. For an application whose
 * value accumulates over years of reading, that is the wrong floor.
 *
 * WHY THIS LOOKS SYNCHRONOUS. The card store (`cardStore`) publishes and
 * persists in one pass, and the settings store reads its envelope the moment
 * it is built — a preference or a card appearing a frame late is one that
 * flickers. Filesystem access is asynchronous, so rather than make the
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
  /**
   * What this run found on disk that it could not read — or null.
   *
   * `aside` is where the damaged file went, or null when it could not be
   * moved and the next write will replace it. Reported rather than only
   * logged: a reader who lost their cards and settings to a truncated file
   * learned it from an empty pane with nothing to say why, and a console
   * line is not where a reader looks. Boot says it where they do.
   */
  readonly damaged: { readonly aside: string | null } | null
}

/** The filesystem operations this needs, injected so it can be tested. */
export interface FileSystem {
  read: (path: string) => Promise<string | null>
  /** Must be atomic: a torn write loses every mark, not one. */
  write: (path: string, text: string) => Promise<void>
  /**
   * Move a damaged store aside, so the next write cannot destroy it.
   *
   * ⚠️ **`to` IS A REQUEST, AND THE ANSWER IS WHERE IT WENT.** `rename`
   * REPLACES its destination on every filesystem this ships to, so an
   * implementation that honours `to` literally destroys the quarantine an
   * earlier corruption left at that name — the one thing moving a damaged
   * file aside exists to prevent. An implementation must therefore be free to
   * choose a neighbouring name, and the caller must be told which: `aside` is
   * reported to the reader as the file their work is in, and a path nothing
   * wrote is the same lie as no quarantine at all. Answering `void` means the
   * requested name was used.
   *
   * Optional: a filesystem that cannot rename is still usable, and the store
   * then behaves as it did before this existed.
   */
  quarantine?: (path: string, to: string) => Promise<string | void>
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
 * the card and settings stores read their storage once, when they are built.
 */
export async function openFileStore({
  fs,
  path = STORE_FILE,
  legacy = null,
  schedule = (fn) => void Promise.resolve().then(fn),
}: FileStoreOptions): Promise<FileStore> {
  /* Null-prototype, so a key like `toString` or `__proto__` is data rather
   * than an inherited function or a prototype write. The keys are ours today;
   * the object should not care. */
  let contents: Contents = Object.create(null) as Contents
  let migrated = false
  let damaged: FileStore['damaged'] = null

  const existing = await fs.read(path)
  if (existing !== null) {
    const readable = parse(existing)
    if (readable === null) {
      /* Unreadable. Moved aside rather than left in place, because leaving it
       * meant the next mark the reader made overwrote it — the ONLY copy of
       * their work, destroyed by the recovery path that claimed to preserve it.
       * The store then starts empty, which is what a reader sees either way;
       * the difference is whether the old bytes still exist afterwards. */
      const asked = `${path}.corrupt`
      if (fs.quarantine) {
        try {
          /* WHERE IT ACTUALLY WENT, not where it was asked to go — see the
           * seam. An implementation that avoids destroying an earlier
           * quarantine has to choose a different name, and reporting the
           * requested one then sends the reader to a file nothing wrote. */
          const landed = await fs.quarantine(path, asked)
          const aside = typeof landed === 'string' && landed !== '' ? landed : asked
          console.error(`Paper: the store could not be read; moved it to ${aside}`)
          damaged = { aside }
        } catch (cause) {
          console.error('Paper: the store could not be read, and could not be moved aside', cause)
          damaged = { aside: null }
        }
      } else {
        /* NO SEAM IS NOT A MOVE. `fs.quarantine?.()` resolved undefined and
         * the report claimed the bytes were preserved at a path nothing
         * wrote — the next write then overwrote the reader's only copy,
         * under a notice saying it was safe. An absent seam is the
         * could-not-move case, told as such. */
        console.error('Paper: the store could not be read, and this filesystem cannot move it aside')
        damaged = { aside: null }
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
      /* PER KEY, because browser storage can throw on a read even after the
       * object itself was handed over (a revoked permission, a dying
       * profile) — and one throwing key used to reject the whole open,
       * which took the disk-backed store down over a LEGACY copy. */
      try {
        const value = legacy.getItem(key)
        if (value !== null) contents[key] = value
      } catch (cause) {
        console.error(`Paper: could not migrate ${key} from the old storage`, cause)
      }
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
  /**
   * Why the last write did not land, or null when it did — `healthy`'s cause,
   * kept so `flush` can raise the real failure rather than a summary of it.
   */
  let lastFailure: unknown = null

  const writeNow = async () => {
    const snapshot = JSON.stringify(contents)
    try {
      await fs.write(path, snapshot)
      healthy = true
      lastFailure = null
    } catch (cause) {
      healthy = false
      lastFailure = cause
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

    /**
     * A FLUSH THAT RESOLVES MEANS THE BYTES ARE DOWN.
     *
     * `writeNow` swallows so the QUEUE survives a bad write — chaining onto a
     * rejected promise would make every write after it reject too, and a
     * store that failed once would never save again. But the swallow also
     * made this resolve over a write that never happened, and its callers are
     * precisely the ones that need the answer: the app's shutdown step, which
     * reports a failed save, and the CLI's close, which turns one into a
     * non-zero exit rather than printing success over bytes that are not on
     * disk. Raised HERE, where there is an `await` to raise into, and nowhere
     * in the chain.
     */
    flush: async () => {
      if (dirty) chain()
      await inFlight
      if (lastFailure !== null) {
        throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure))
      }
    },

    get healthy() {
      return healthy
    },
    get migrated() {
      return migrated
    },
    get damaged() {
      return damaged
    },
  }

  /* A migration that produced something is written immediately: a reader who
   * upgrades and never makes another mark should still have the file. Marked
   * dirty explicitly, because seeding filled `contents` directly rather than
   * through `setItem` — so nothing had queued a write and the first flush wrote
   * nothing at all. */
  if (migrated) {
    dirty = true
    /* AND ITS FAILURE DOES NOT FAIL THE OPEN. `flush` raises a write that did
     * not land, which is what its callers need — but the seeded values are in
     * memory and still in the legacy store they were copied from, so a
     * refused migration write costs this run's durability (`healthy` says so,
     * and the next `setItem` throws) and not the reader's application.
     * Thrown, it would send the caller down its "could not open the store at
     * all" path and pin the whole session to window storage. */
    await store.flush().catch(() => {})
  }

  return store
}

/** The contents, or null when the payload is not a store at all. */
function parse(text: string): Contents | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    /* ONE invalid entry damns the file, deliberately. Every store above this
     * writes a JSON string, so a non-string entry means the file was not
     * written by this code — and FILTERING it meant the remainder was
     * accepted as healthy and the next write erased the dropped keys with no
     * quarantine and no notice. Damage is damage: `null` sends the whole
     * file down the move-aside path, where every byte survives and the boot
     * notice says so. */
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.every(([, v]) => typeof v === 'string')) return null
    return Object.assign(Object.create(null), Object.fromEntries(entries)) as Contents
  } catch {
    /* Reported to the caller rather than thrown. Throwing here would happen
     * before React mounts and take the whole application down — a reader whose
     * marks file was truncated would get no application at all, rather than one
     * that has lost some marks. The caller moves the file aside so it survives
     * the next write. */
    return null
  }
}
