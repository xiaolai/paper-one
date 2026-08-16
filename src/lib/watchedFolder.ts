/**
 * A folder Paper keeps an eye on.
 *
 * Drop a book into it from anywhere — a download, a sync client, another
 * machine — and it appears on the shelf without the reader doing anything.
 *
 * THE SENTENCE THIS RESTORES was in the reader's empty state for months while
 * nothing in the repository watched a folder: "or connect a folder to watch". It
 * was deleted in WI-3.0 precisely because a promise with no implementation is
 * worse than an absent feature. This is what earns it back.
 *
 * ONE FOLDER, NOT A LIST. A reader with books in five places wants those books
 * imported, not five watchers running; and the second folder is the one that
 * makes this a management screen rather than a setting. It can become a list
 * when somebody actually has two.
 */

import { importFolder, type DirFs, type ImportOutcome } from './importFolder'

export const WATCHED_FOLDER_KEY = 'paper.watchedFolder.v1'

/**
 * How long to wait after a change before re-reading the folder.
 *
 * A file arriving is not one event. A copy in progress emits create-then-write
 * repeatedly, and a sync client can emit dozens across a batch — re-importing on
 * each would read a half-written book and hash whatever had landed so far.
 * Waiting for quiet is what makes the import see finished files.
 *
 * Long enough to outlast a local copy, short enough that a reader who dropped a
 * book in does not wonder whether it worked.
 */
export const SETTLE_MS = 1500

export interface Watcher {
  stop: () => void
}

export interface WatchOps {
  /** Tauri's `watch`, narrowed to what this needs. Resolves to an unsubscribe. */
  watch: (path: string, onEvent: () => void, options: { recursive: boolean }) => Promise<() => void>
}

/**
 * Watch a folder, re-importing it once changes settle.
 *
 * Re-imports the WHOLE folder rather than the file that changed, which sounds
 * wasteful and is not: `ownBook` refuses a book it already holds by deriving the
 * destination from the content hash, so a re-import of ninety-nine known books
 * and one new one writes exactly one file. Reading them to hash them is the
 * cost, and it happens while the reader is doing something else.
 *
 * It also means a book that arrived while the app was closed is picked up, which
 * watching alone would miss entirely.
 */
export function watchFolder(
  fs: DirFs,
  ops: WatchOps,
  folder: string,
  onImported: (outcomes: ImportOutcome[]) => void,
  { settleMs = SETTLE_MS }: { settleMs?: number } = {},
): Promise<Watcher> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let again = false
  let stopped = false
  /* `importFolder` already takes a signal; without owning one, "Stop watching"
   * left a running import reading, hashing and copying the whole folder. */
  const aborter = new AbortController()

  const run = async () => {
    /* One import at a time. Two overlapping runs would both read the same
     * half-imported folder and race each other into the vault; `again` makes the
     * second wait rather than be dropped, so a change arriving mid-import is not
     * lost. */
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const outcomes = await importFolder(fs, folder, { signal: aborter.signal })
        if (stopped) return
        // Reported only when something actually landed. A watcher that announces
        // "0 added" every time a file is touched is noise.
        if (outcomes.some((one) => one.status === 'added')) onImported(outcomes)
      } while (again && !stopped)
    } finally {
      running = false
    }
  }

  const settle = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void run(), settleMs)
  }

  return ops.watch(folder, settle, { recursive: true }).then((unsubscribe) => {
    // Once at startup, for everything that arrived while the app was closed.
    settle()
    return {
      stop: () => {
        stopped = true
        aborter.abort()
        if (timer) clearTimeout(timer)
        unsubscribe()
      },
    }
  })
}
