import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  rename,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { STORE_FILE, openFileStore, type FileStore, type FileSystem } from '../core/fileStore'
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

/** The temporary name an atomic write goes through. */
const TEMP_FILE = `${STORE_FILE}.writing`

/**
 * Write through a temporary file and a rename.
 *
 * A truncated store loses EVERY mark rather than one, and `writeTextFile` on a
 * path that already exists truncates before it writes — so a crash or a full
 * disk in the middle leaves nothing recoverable. A rename over a complete file
 * is atomic on every filesystem this ships to.
 */
const tauriFs: FileSystem = {
  read: async (path) => {
    if (!(await exists(path, DIR))) return null
    return readTextFile(path, DIR)
  },
  write: async (path, text) => {
    await writeTextFile(TEMP_FILE, text, DIR)
    await rename(TEMP_FILE, path, { oldPathBaseDir: DIR.baseDir, newPathBaseDir: DIR.baseDir })
  },
  quarantine: (path, to) =>
    rename(path, to, { oldPathBaseDir: DIR.baseDir, newPathBaseDir: DIR.baseDir }),
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
     * this fallback still has something to offer. */
    console.error('Paper: could not open the store on disk; falling back to localStorage', cause)
    return {
      storage: localStore(),
      notice: `Paper could not open its store on disk, so ${KEPT_THERE} are kept in the window's storage for this session.`,
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
