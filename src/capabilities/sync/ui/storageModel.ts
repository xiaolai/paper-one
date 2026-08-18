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

export interface DownloadRow {
  readonly book: string
  readonly title: string
  /** Bytes, when the download recorded them; null for a copy that predates
   *  the ledger (an imported book, a shelf's own copy). */
  readonly size: number | null
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

export async function recordDownloadSize(fs: IndexFs, book: string, size: number): Promise<void> {
  const held = { ...(await readDownloadSizes(fs)), [book]: size }
  await atomicWrite(fs, DOWNLOADS_INDEX_PATH, new TextEncoder().encode(JSON.stringify(held)))
}

export async function dropDownloadSize(fs: IndexFs, book: string): Promise<void> {
  const held = { ...(await readDownloadSizes(fs)) }
  if (!(book in held)) return
  delete held[book]
  await atomicWrite(fs, DOWNLOADS_INDEX_PATH, new TextEncoder().encode(JSON.stringify(held)))
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

  const refresh = async (): Promise<void> => {
    const sizes = fs ? await readDownloadSizes(fs) : {}
    const downloads = library
      .getSnapshot()
      .filter((row) => row.hasContent === true)
      .map((row) => ({ book: row.bookId, title: row.title || row.bookId, size: sizes[row.bookId] ?? null }))
    const coverBytes = coverCache ? await coverCache.totalBytes() : 0
    publish({ downloads, coverBytes, coverCapMB: settings.get(COVER_CAP_SETTING), status: status.getSnapshot() })
  }

  const offs = [
    library.subscribe(() => void refresh()),
    status.subscribe(() => publish({ status: status.getSnapshot() })),
  ]

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh,
    removeDownload: async (book) => {
      if (!removeDownload) return
      publish({ busy: book })
      try {
        await removeDownload(book)
        if (fs) await dropDownloadSize(fs, book)
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
      listeners.clear()
    },
  }
}
