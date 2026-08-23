/**
 * What is being fetched right now, per book — the store behind the shelf row's
 * activity line.
 *
 * WHY THIS EXISTS AT ALL. Downloads reported themselves as a list of rows in
 * Settings reading "Transfer 1 — done": a counter, in a surface nobody opens
 * to watch a download, kept twenty deep including the finished ones. It could
 * not have been better written — `TransferProgress` carried no book, so no
 * surface downstream could attribute a byte to a title. The plugin's event
 * carries the blob folder now, and this is what turns that into a sentence on
 * the book the reader clicked.
 *
 * FORWARD MATCHING, NEVER AN INVERSE. `blobFolderOf(bookId)` derives the
 * folder from the book; going the other way would mean inverting `safeId`,
 * which is lossy by design. So a download registers the folder it EXPECTS when
 * it starts, and events are matched against that map. A transfer nobody
 * registered — a cover the cache fetched on its own, a peer's own business —
 * is ignored rather than guessed at.
 *
 * TERMINAL EVENTS CLEAR THE ENTRY. `done` and `failed` both end the activity:
 * the row goes back to saying what it always says, and the book's own state —
 * bytes present or not — is the record. A failure that vanishes silently is
 * the one real cost of that, and it is deliberate: the download either landed
 * or the menu still offers Download, which is a truer signal than a stale row
 * claiming a failure the reader has since retried.
 */

import type { TransferProgress } from '../../peer'

/** What the shelf row shows while a book is coming down. */
export interface Downloading {
  readonly received: number
  readonly total: number
}

export interface Downloads {
  /** Say a fetch is expected for this book, under this blob folder. */
  expect(bookId: string, folder: string): void
  /** Fold in a transfer event. Unregistered folders are ignored. */
  apply(event: TransferProgress): void
  /** Stop tracking — the download resolved, or its caller gave up. */
  forget(bookId: string): void
  /** What to say about this book, or null. */
  of(bookId: string): Downloading | null
  subscribe(listener: () => void): () => void
}

export function createDownloads(): Downloads {
  /** folder → bookId, so an event finds its book in one lookup. */
  const byFolder = new Map<string, string>()
  const active = new Map<string, Downloading>()
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of [...listeners]) listener()
  }

  const drop = (bookId: string) => {
    const had = active.delete(bookId)
    for (const [folder, id] of byFolder) if (id === bookId) byFolder.delete(folder)
    if (had) publish()
  }

  return {
    expect: (bookId, folder) => {
      byFolder.set(folder, bookId)
      /* Registered as zero-of-unknown rather than left absent: the reader
         clicked Download and the row must answer immediately, not when the
         first byte happens to arrive. `total` of 0 reads as indeterminate. */
      active.set(bookId, { received: 0, total: 0 })
      publish()
    },
    apply: (event) => {
      const bookId = byFolder.get(event.folder)
      if (bookId === undefined) return
      if (event.state === 'running') {
        active.set(bookId, { received: event.received, total: event.total })
        publish()
        return
      }
      drop(bookId)
    },
    forget: drop,
    of: (bookId) => active.get(bookId) ?? null,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * The sentence the row shows, and the fraction under it.
 *
 * A PERCENTAGE ONLY WHEN ONE IS KNOWN. A transfer reports its total from the
 * request, so the total is usually there — but a fetch that has registered and
 * not yet had an event has none, and inventing "0%" for it says the download
 * has stalled at the start rather than that it has just begun.
 */
export function describeDownload(one: Downloading): { label: string; fraction?: number } {
  if (!(one.total > 0)) return { label: 'Downloading…' }
  const fraction = Math.min(1, one.received / one.total)
  return { label: `Downloading ${Math.round(fraction * 100)}%`, fraction }
}
