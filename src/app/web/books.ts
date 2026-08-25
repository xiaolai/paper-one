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

/** One book, as `book.list` answers. */
export interface BookRow {
  readonly id: string
  readonly title: string
  readonly author?: string
  readonly progress?: number
  readonly finished?: boolean
}

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
  /** Ask the shelf again. Safe to call at any time. */
  refresh(): Promise<void>
  dispose(): void
}

/** The rows out of a `book.list` answer, ignoring anything unrecognised. */
export function parseRows(answer: unknown): readonly BookRow[] {
  if (!Array.isArray(answer)) return []
  const rows: BookRow[] = []
  for (const item of answer) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    /* A ROW WITHOUT AN ID IS NOT A BOOK. React keys on it and a duplicate or
     * missing key is a rendering bug three screens away from its cause. */
    if (typeof row['id'] !== 'string' || row['id'] === '') continue
    rows.push({
      id: row['id'],
      title: typeof row['title'] === 'string' ? row['title'] : '',
      ...(typeof row['author'] === 'string' ? { author: row['author'] } : {}),
      ...(typeof row['progress'] === 'number' ? { progress: row['progress'] } : {}),
      ...(typeof row['finished'] === 'boolean' ? { finished: row['finished'] } : {}),
    })
  }
  return rows
}

/** True when two snapshots say the same thing. */
function same(a: readonly BookRow[], b: readonly BookRow[]): boolean {
  if (a.length !== b.length) return false
  return a.every((row, i) => {
    const other = b[i]!
    return (
      row.id === other.id &&
      row.title === other.title &&
      row.author === other.author &&
      row.progress === other.progress &&
      row.finished === other.finished
    )
  })
}

export function createRemoteBooks(channel: ShelfChannel): RemoteBooks {
  let rows: readonly BookRow[] = []
  let state: BooksStatus = 'loading'
  let disposed = false
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
    let answer: unknown
    try {
      answer = await channel.call('book.list', {})
    } catch {
      if (disposed) return
      setStatus(rows.length > 0 ? 'stale' : 'failed')
      return
    }
    if (disposed) return
    const next = parseRows(answer)
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
    refresh,
    dispose: () => {
      disposed = true
      unsubscribeClosed()
      listeners.clear()
    },
  }
}
