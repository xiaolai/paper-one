/**
 * What is being fetched right now, per book — the store behind the shelf row's
 * activity line.
 *
 * WHY THIS EXISTS AT ALL. Downloads reported themselves as a list of rows in
 * Settings reading "Transfer 1 — done": a counter, in a surface nobody opens
 * to watch a download, kept twenty deep including the finished ones. It could
 * not have been better written — `TransferProgress` carried no book, so no
 * surface downstream could attribute a byte to a title.
 *
 * IT NO LONGER GUESSES WHICH BOOK. The first version matched a GLOBAL stream
 * of transfer events to a book by blob folder, because the folder was the only
 * identifying thing an event carried. That was wrong in a way its own tests
 * could not see: a book's cover and its content live in the SAME folder — the
 * cover cache derives it with the same `blobFolderOf` — so a jacket fetched
 * while a download ran updated the reader's progress line with somebody else's
 * bytes, and the cover's terminal event cleared the row while the book was
 * still coming down.
 *
 * `port.fetchBlob` has always taken a per-request `onProgress`. The ledger
 * threads it through `download` now, so each fetch reports to the book that
 * asked for it and no correlation happens anywhere. What is left here is what
 * remains once the guessing is removed: a map, and the sentence drawn from it.
 */

/** What the shelf row shows while a book is coming down. */
export interface Downloading {
  readonly received: number
  readonly total: number
}

export interface Downloads {
  /** Say a fetch has begun for this book. */
  expect(bookId: string): void
  /** Bytes moved, reported by THAT book's own transfer. */
  progress(bookId: string, received: number, total: number): void
  /** Stop tracking — the download resolved, or its caller gave up. */
  forget(bookId: string): void
  /** What to say about this book, or null. */
  of(bookId: string): Downloading | null
  subscribe(listener: () => void): () => void
}

export function createDownloads(): Downloads {
  const active = new Map<string, Downloading>()
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of [...listeners]) listener()
  }

  return {
    expect: (bookId) => {
      /* Registered as zero-of-unknown rather than left absent: the reader
         clicked Download and the row must answer immediately, not when the
         first byte happens to arrive. `total` of 0 reads as indeterminate. */
      active.set(bookId, { received: 0, total: 0 })
      publish()
    },
    progress: (bookId, received, total) => {
      /* ONLY FOR A BOOK STILL BEING WATCHED. A late frame from a transfer
         whose caller already gave up must not put the row back. */
      if (!active.has(bookId)) return
      active.set(bookId, { received, total })
      publish()
    },
    forget: (bookId) => {
      if (active.delete(bookId)) publish()
    },
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
  /* FLOORED, so 100% means done. `Math.round` reported "Downloading 100%" at
     999 of 1000 bytes and then sat there — the one number a reader reads as
     "it has finished", shown while it had not. The bar keeps the true
     fraction; only the words are conservative. */
  return { label: `Downloading ${Math.floor(fraction * 100)}%`, fraction }
}
