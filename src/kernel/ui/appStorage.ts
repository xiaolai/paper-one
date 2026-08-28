import { invoke } from '@tauri-apps/api/core'
import { BaseDirectory, exists, mkdir, readTextFile, rename } from '@tauri-apps/plugin-fs'
import { openFileStore, type FileStore, type FileSystem } from '../core/fileStore'
import type { MarkStorage } from '../core/marks'
import { inTauri } from './inTauri'

/**
 * The application's own store, resolved once at boot.
 *
 * `fileStore` holds the rules and knows nothing about Tauri; this is the half
 * that touches the filesystem, so the rules can be tested against a fake and
 * this can stay small enough to read.
 */

const DIR = { baseDir: BaseDirectory.AppData } as const

/**
 * Write through a temporary file and a rename, synced.
 *
 * A truncated store loses EVERY mark rather than one, and `writeTextFile` on a
 * path that already exists truncates before it writes — so a crash or a full
 * disk in the middle leaves nothing recoverable. A rename over a complete file
 * is atomic on every filesystem this ships to — and, since phase 20's D3,
 * durable across a power cut too: `write_atomic` is the app's own command,
 * the same one the vault writes `book.json` through (`vaultFsTauri.ts`), and
 * the store is written at the full level because it is the cards and the
 * settings, whole.
 */
const tauriFs: FileSystem = {
  read: async (path) => {
    if (!(await exists(path, DIR))) return null
    return readTextFile(path, DIR)
  },
  write: (path, text) =>
    invoke('write_atomic', new TextEncoder().encode(text), {
      headers: { path: encodeURIComponent(path), level: 'full' },
    }),
  /* ANSWERS THE NAME IT ACTUALLY USED, which is the half of the seam's
   * contract this adapter has to keep: `to` is what the store ASKED for, and
   * a second corruption is quarantined beside the first rather than over it,
   * so the two disagree exactly when it matters. The boot notice reads this
   * answer, and reporting the asked-for name would tell the reader to look at
   * a file nothing wrote. */
  quarantine: async (path, to) => {
    const landed = await freeQuarantinePath(to, (at) => exists(at, DIR))
    await rename(path, landed, { oldPathBaseDir: DIR.baseDir, newPathBaseDir: DIR.baseDir })
    return landed
  },
}

/**
 * A destination for a damaged store that does not destroy the last one.
 *
 * ⚠️ **A SECOND CORRUPTION MUST NOT ERASE THE FIRST.** `fileStore` asks for
 * `<path>.corrupt` every time, and `rename` REPLACES its destination — so a
 * store that went bad twice quarantined twice to one name and the earlier
 * copy, the one holding whatever the reader might still have recovered, was
 * gone. The whole point of moving a damaged file aside is that it is still
 * there.
 *
 * `src/hosts/node/fs.ts` had already been given exactly this and the webview
 * half was left with the plain rename — the same defect, in the host almost
 * every reader actually runs.
 *
 * The plain name is used when it is free, so the ordinary single-fault case
 * keeps the name the caller asked for and the notice `damageNotice` writes is
 * the truth. A collision takes a suffix; the loop is bounded, and running out
 * REFUSES rather than falling back on the last candidate — a
 * hundred-and-first copy clarifies nothing, and overwriting the hundredth
 * clarifies less.
 *
 * ONLY A DEFINITE "NOT THERE" MEANS FREE. `exists` rejects for a path it
 * cannot interrogate, and reading that as absence would hand the rename a
 * destination it silently replaces — the one outcome this exists to prevent.
 * An unreadable candidate is skipped like an occupied one.
 */
export async function freeQuarantinePath(
  to: string,
  taken: (path: string) => Promise<boolean>,
): Promise<string> {
  for (let n = 0; n <= 100; n += 1) {
    const candidate = n === 0 ? to : `${to}.${n}`
    try {
      if (!(await taken(candidate))) return candidate
    } catch {
      continue
    }
  }
  throw new Error(
    `cannot quarantine the store: ${to} and .1 through .100 all exist. ` +
      'Something is producing corrupt files faster than they can be looked at; ' +
      'move the existing quarantines aside before this can continue.',
  )
}

/** The window's storage, or null where it is disabled by policy. */
export function localStore(): MarkStorage | null {
  try {
    return window.localStorage
  } catch {
    // Throws outright when storage is disabled, rather than returning null.
    return null
  }
}

/* `inTauri` MOVED TO `./inTauri.ts`, and its absence here is the point: four
 * modules imported only that two-line `window` check from this file and got
 * `@tauri-apps/plugin-fs` with it. See that file's header. */

/** The store, and what opening it had to say — see `openAppStorage`. */
export interface AppStorage {
  readonly storage: FileStore | ReturnType<typeof localStore>
  /**
   * One sentence for the reader when the store was not what it should have
   * been — damaged and moved aside, damaged and stuck, or not openable at all
   * — or null. It used to be a console line (WI-20.36), and a reader who
   * lost their cards and settings to a truncated file learned it from an
   * empty pane with nothing to say why.
   */
  readonly notice: string | null
}

/** What the store held: everything a `MarkStorage` key names, which since
 *  phase 4 is the cards, the settings and the tag preferences. */
const KEPT_THERE = 'your cards, settings and tag preferences'

/**
 * Open the reader's store, falling back to the webview's own storage.
 *
 * The fallback is not a nicety. The dev server serves this application at
 * `localhost:14201` and it is opened in an ordinary browser to check layout,
 * where there is no filesystem and no IPC — and a boot that threw there would
 * make the app unopenable outside the shell.
 *
 * Returning `localStorage` in that case is exactly the old behaviour, which is
 * the right fallback: the reader keeps working, with the durability the
 * environment can offer.
 */
export async function openAppStorage(): Promise<AppStorage> {
  if (!inTauri()) return { storage: localStore(), notice: null }

  try {
    // AppData is not created for us, and `writeTextFile` will not create it.
    await mkdir('', { ...DIR, recursive: true })
    const storage = await openFileStore({ fs: tauriFs, legacy: localStore() })
    return { storage, notice: damageNotice(storage.damaged) }
  } catch (cause) {
    /* Loud, and not fatal. A reader whose disk is unavailable should still get
     * an application — with their existing localStorage data, which is where
     * everything was until this phase and is left in place precisely so that
     * this fallback still has something to offer.
     *
     * The notice says PLAINLY that this session's changes stay behind: a later
     * healthy launch prefers the disk store, and nothing merges the fallback
     * session back into it — merging cannot be told apart from resurrecting
     * the pre-migration values the legacy keys deliberately still hold. An
     * announced limit, not a silent one. And when window storage is itself
     * disabled, the sentence must not claim a durability that does not exist:
     * that session holds changes in memory only. */
    console.error('Paper: could not open the store on disk; falling back to localStorage', cause)
    const fallback = localStore()
    return {
      storage: fallback,
      notice:
        fallback === null
          ? `Paper could not open its store on disk, and window storage is disabled — changes to ${KEPT_THERE} will not outlive this session.`
          : `Paper could not open its store on disk, so ${KEPT_THERE} are kept in the window's storage for this session — changes made now will not reach the disk store when it recovers.`,
    }
  }
}

/** The sentence for a store that would not read, or null for one that did. */
export function damageNotice(damaged: FileStore['damaged']): string | null {
  if (damaged === null) return null
  return damaged.aside === null
    ? `The file holding ${KEPT_THERE} could not be read, and could not be moved aside — the next change will replace it.`
    : `The file holding ${KEPT_THERE} could not be read; it was moved to ${damaged.aside}, and Paper started with an empty one.`
}
