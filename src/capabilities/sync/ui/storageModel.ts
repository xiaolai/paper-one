import { atomicWrite, type IndexFs, type KernelServices } from '../../../kernel'
import { COVER_CAP_SETTING, type CoverCache } from '../lib/coverCache'
import type { SyncStatus, SyncStatusStore } from '../lib/status'

/**
 * The Storage section's MODEL (WI-C.5) — no React, so the logic tests run
 * in the node project; `StoragePane.tsx` is the adapter. What it knows:
 * which books hold bytes here, what each download cost (recorded at
 * download time in `sync/downloads.json` — sizes are not stat-able through
 * the kernel fs, so the ledger of downloads is the honest source; a book
 * whose bytes predate it shows no size rather than a guess), the cover
 * cache's bytes against its cap, and the sync status line.
 */

export const DOWNLOADS_INDEX_PATH = 'sync/downloads.json'

/**
 * How long a burst of shelf changes has to go quiet before this reads again.
 *
 * Short enough that a download finishing appears to land at once; long
 * enough that an import writing two thousand rows, and the parse pass that
 * follows it writing them all again, cost one read rather than four thousand.
 */
const REFRESH_QUIET_MS = 250

export interface DownloadRow {
  readonly book: string
  readonly title: string
  /** Bytes, as the download recorded them. Known for every row here, because
   *  the ledger IS the row list — see `refresh`. */
  readonly size: number
}

export interface StorageSnapshot {
  readonly downloads: readonly DownloadRow[]
  readonly coverBytes: number
  readonly coverCapMB: number
  readonly status: SyncStatus
  readonly busy: string | null
}

export interface StorageModel {
  getSnapshot(): StorageSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  removeDownload(book: string): Promise<void>
  setCoverCapMB(mb: number): Promise<void>
  dispose(): void
}

/* ------------------------------------------------- the downloads ledger */

export async function readDownloadSizes(fs: IndexFs): Promise<Readonly<Record<string, number>>> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await fs.readFile(DOWNLOADS_INDEX_PATH)))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [book, size] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof size === 'number' && Number.isFinite(size) && size >= 0) out[book] = size
    }
    return out
  } catch {
    return {}
  }
}

/* ONE writer at a time: record and drop are each a read-modify-write over
 * one file, so a download landing while another's removal drops its row
 * could lose an entry — or collide on the same `.writing` neighbour. The
 * writers are serialised here, at the only place they exist. */
let writing: Promise<unknown> = Promise.resolve()
const serialWrite = <T,>(task: () => Promise<T>): Promise<T> => {
  const next = writing.then(task, task)
  writing = next.catch(() => {})
  return next
}

export function recordDownloadSize(fs: IndexFs, book: string, size: number): Promise<void> {
  return serialWrite(async () => {
    const held = { ...(await readDownloadSizes(fs)), [book]: size }
    await atomicWrite(fs, DOWNLOADS_INDEX_PATH, new TextEncoder().encode(JSON.stringify(held)))
  })
}

export function dropDownloadSize(fs: IndexFs, book: string): Promise<void> {
  return serialWrite(async () => {
    const held = { ...(await readDownloadSizes(fs)) }
    if (!(book in held)) return
    delete held[book]
    await atomicWrite(fs, DOWNLOADS_INDEX_PATH, new TextEncoder().encode(JSON.stringify(held)))
  })
}

/* --------------------------------------------------------------- model */

export interface StorageModelOptions {
  readonly services: KernelServices
  readonly coverCache: CoverCache | null
  readonly status: SyncStatusStore
  /** The ledger's device-local removal, or null before sync started. */
  readonly removeDownload: ((book: string) => Promise<void>) | null
}

export function createStorageModel({ services, coverCache, status, removeDownload }: StorageModelOptions): StorageModel {
  const { library, settings, fs } = services
  let snapshot: StorageSnapshot = {
    downloads: [],
    coverBytes: 0,
    coverCapMB: settings.get(COVER_CAP_SETTING),
    status: status.getSnapshot(),
    busy: null,
  }
  const listeners = new Set<() => void>()
  const publish = (next: Partial<StorageSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }

  /**
   * THE LEDGER IS THE LIST, not the shelf.
   *
   * This filtered the shelf by `hasContent === true` — every book whose bytes
   * are on this machine — and called the result "downloads". On a library of
   * two thousand imported books that listed all two thousand, every one with
   * a size of "—" because the ledger only records what a peer actually sent.
   *
   * It was not merely noise. Each row carries a Remove download button, and
   * that button reaches `ledger.removeDownload`, which calls `removeBlob` on
   * the book's own content file. So the pane offered to delete the bytes of
   * books the reader had imported themselves, under a word that promises the
   * opposite — that a copy is being reclaimed, not lost.
   *
   * A book fetched from a peer BEFORE the ledger existed is not listed and
   * cannot be reclaimed here. That is the honest trade: no size to show, no
   * record that it ever was a download, and the alternative is guessing —
   * which is what produced the button above.
   */
  const collect = async (): Promise<Pick<StorageSnapshot, 'downloads' | 'coverBytes' | 'coverCapMB' | 'status'>> => {
    const sizes = fs ? await readDownloadSizes(fs) : {}
    const downloads = library
      .getSnapshot()
      .flatMap((row) => {
        const size = sizes[row.bookId]
        if (size === undefined || row.hasContent !== true) return []
        return [{ book: row.bookId, title: row.title || row.bookId, size }]
      })
    const coverBytes = coverCache ? await coverCache.totalBytes() : 0
    return { downloads, coverBytes, coverCapMB: settings.get(COVER_CAP_SETTING), status: status.getSnapshot() }
  }

  /* AT MOST ONE READ IN FLIGHT, and at most one waiting behind it. `refresh`
   * is two filesystem reads and a walk of the whole shelf, and it was fired
   * once per shelf change — so a two-thousand-book import ran it two thousand
   * times, and the parse pass that follows ran it two thousand more.
   *
   * A caller awaiting `refresh` still gets a snapshot taken AFTER its own
   * change: the loop runs again for anything that arrived while it was
   * reading, and the promise every caller holds is the one that resolves
   * when the loop is done.
   *
   * Coalescing alone does not bound a long burst — the writes are seconds
   * apart, not microseconds — which is what `REFRESH_QUIET_MS` is for. The
   * two together turn "once per book" into "at most once per quiet period,
   * and only while somebody is looking". */
  let stale = false
  let reading: Promise<void> | null = null
  let again = false
  const refresh = (): Promise<void> => {
    if (reading) {
      again = true
      return reading
    }
    reading = (async () => {
      try {
        do {
          again = false
          stale = false
          publish(await collect())
        } while (again)
      } finally {
        reading = null
      }
    })()
    return reading
  }

  /**
   * The shelf changed. Read again — LATER, and only if anybody is looking.
   *
   * Two guards, and they answer different halves of the same waste. This
   * model is built when the capability starts, not when the Storage section
   * is opened, so without the listener check it did its two reads for the
   * whole session on behalf of a pane that was almost never on screen. And
   * within a burst — an import, or the parse pass filling in two thousand
   * titles one at a time — even a visible pane wants one read at the end of
   * the burst rather than one per book.
   *
   * `stale` is what makes the deferral safe: a change that arrived while
   * nothing was subscribed is remembered, and `subscribe` reads it back.
   */
  let timer: ReturnType<typeof setTimeout> | null = null
  const shelfChanged = (): void => {
    stale = true
    if (listeners.size === 0 || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, REFRESH_QUIET_MS)
  }

  const offs = [
    library.subscribe(shelfChanged),
    status.subscribe(() => publish({ status: status.getSnapshot() })),
  ]

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      /* What was missed while nobody was watching. The pane's own mount
       * effect also calls `refresh`, so this is belt and braces — but the
       * model is public and the next subscriber may not be that pane. */
      if (stale) void refresh()
      return () => void listeners.delete(listener)
    },
    refresh,
    removeDownload: async (book) => {
      if (!removeDownload) return
      publish({ busy: book })
      try {
        /* The action OWNS the ledger delete AND its size row — dropping the
         * row here too was a second delete of the same entry. */
        await removeDownload(book)
      } finally {
        publish({ busy: null })
        await refresh()
      }
    },
    setCoverCapMB: async (mb) => {
      if (!(Number.isFinite(mb) && mb > 0)) return
      settings.set(COVER_CAP_SETTING, mb)
      if (coverCache) await coverCache.evict()
      await refresh()
    },
    dispose: () => {
      for (const off of offs.splice(0)) off()
      if (timer !== null) clearTimeout(timer)
      timer = null
      listeners.clear()
    },
  }
}
