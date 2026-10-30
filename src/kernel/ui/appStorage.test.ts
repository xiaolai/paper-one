import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_FILE, type FileStore } from '../core/fileStore'
import type { MarkStorage } from '../core/marks'
import { damageNotice, freeQuarantinePath, openAppStorage } from './appStorage'

/* The app's data directory, as the two Tauri halves this module binds to see
   it. Hoisted: the mock factories run before the module body. */
const disk = vi.hoisted(() => ({
  /** Directories that exist under the data root; `''` is the root itself. */
  dirs: new Set<string>(),
  files: new Map<string, string>(),
  /** The sync level of every `write_atomic` that landed. */
  levels: [] as string[],
  /** What `mkdir` fails with, the way an unmounted or read-only disk does. */
  refuse: null as Error | null,
}))

/**
 * The fs plugin, held to what its Rust side does rather than to what this
 * module happens to call (`tauri-plugin-fs` 2.5, `commands.rs`):
 *
 * - a path with no base directory is resolved as it stands, which for a
 *   relative path is outside every scope — "forbidden path";
 * - `mkdir` is a `DirBuilder`, so without `recursive` an existing directory
 *   is an error (EEXIST), and every launch after the first has one;
 * - `rename` REPLACES its destination.
 */
vi.mock('@tauri-apps/plugin-fs', () => {
  const APP_DATA = 'AppData'
  const scoped = (base: unknown, path: string) => {
    if (base !== APP_DATA) throw new Error(`forbidden path: ${path}`)
  }
  return {
    BaseDirectory: { AppData: APP_DATA },
    exists: async (path: string, options?: { baseDir?: unknown }) => {
      scoped(options?.baseDir, path)
      return disk.files.has(path)
    },
    readTextFile: async (path: string, options?: { baseDir?: unknown }) => {
      scoped(options?.baseDir, path)
      const text = disk.files.get(path)
      if (text === undefined) throw new Error(`failed to open file at path: ${path}: No such file or directory`)
      return text
    },
    mkdir: async (path: string, options?: { baseDir?: unknown; recursive?: boolean }) => {
      scoped(options?.baseDir, path)
      if (disk.refuse) throw disk.refuse
      if (disk.dirs.has(path) && options?.recursive !== true) {
        throw new Error(`failed to create directory at path: ${path}: File exists`)
      }
      disk.dirs.add('')
      disk.dirs.add(path)
    },
    rename: async (from: string, to: string, options?: { oldPathBaseDir?: unknown; newPathBaseDir?: unknown }) => {
      scoped(options?.oldPathBaseDir, from)
      scoped(options?.newPathBaseDir, to)
      const text = disk.files.get(from)
      if (text === undefined) throw new Error(`failed to rename ${from}: No such file or directory`)
      disk.files.delete(from)
      disk.files.set(to, text)
    },
  }
})

/** `write_atomic` (`src-tauri/src/atomic.rs`): its headers, its levels, its refusals. */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, body: unknown, options?: { headers?: Record<string, string> }) => {
    if (command !== 'write_atomic') throw new Error(`Command ${command} not found`)
    const path = options?.headers?.path
    if (path === undefined) throw 'write_atomic: missing the path header'
    const level = options?.headers?.level
    if (level === undefined) throw 'write_atomic: missing the level header'
    if (level !== 'full' && level !== 'barrier') throw `write_atomic: unknown sync level ${JSON.stringify(level)}`
    if (!(body instanceof Uint8Array)) throw 'write_atomic: unexpected invoke body'
    disk.dirs.add('')
    disk.files.set(decodeURIComponent(path), new TextDecoder().decode(body))
    disk.levels.push(level)
  },
}))

/** The window's storage, as a map. */
const storageHolding = (entries: Record<string, string> = {}): MarkStorage => {
  const held = new Map(Object.entries(entries))
  return { getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) }
}

/** A window inside the shell or outside it, whose storage may be disabled by policy — which THROWS on access. */
const windowWith = (shell: boolean, storage: MarkStorage | 'disabled') => {
  const view: Record<string, unknown> = shell ? { __TAURI_INTERNALS__: {} } : {}
  Object.defineProperty(view, 'localStorage', {
    get: () => {
      if (storage === 'disabled') throw new DOMException('The operation is insecure.', 'SecurityError')
      return storage
    },
  })
  vi.stubGlobal('window', view)
}

beforeEach(() => {
  disk.dirs.clear()
  disk.files.clear()
  disk.levels.length = 0
  disk.refuse = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * ⚠️ **A SECOND CORRUPTION MUST NOT ERASE THE FIRST.**
 *
 * `fileStore` asks for `<path>.corrupt` every time it moves a damaged store
 * aside, and `rename` REPLACES its destination — so a store that went bad
 * twice quarantined twice to one name and the earlier copy was gone. The Node
 * host was given a guarded destination and the webview host, which is the one
 * almost every reader runs, was left with the plain rename.
 *
 * This is the destination choice on its own, because that is the whole of it:
 * the rename around it is the plugin's.
 */
describe('choosing where a damaged store goes', () => {
  /** A fake directory: the names in it are taken, everything else is free. */
  const holding = (...taken: readonly string[]) => {
    const there = new Set(taken)
    return async (path: string) => there.has(path)
  }

  const ASIDE = 'store.json.corrupt'

  /* The ordinary single-fault case keeps the name the caller asked for, which
     is also the name `damageNotice` tells the reader to look for. */
  it('uses the plain name when nothing is there', async () => {
    expect(await freeQuarantinePath(ASIDE, holding())).toBe(ASIDE)
    expect(damageNotice({ aside: ASIDE })).toContain(ASIDE)
  })

  it('takes a suffix rather than replacing an earlier quarantine', async () => {
    expect(await freeQuarantinePath(ASIDE, holding(ASIDE))).toBe(`${ASIDE}.1`)
  })

  it('keeps counting past a run of them', async () => {
    const there = holding(ASIDE, `${ASIDE}.1`, `${ASIDE}.2`)
    expect(await freeQuarantinePath(ASIDE, there)).toBe(`${ASIDE}.3`)
  })

  /**
   * ⚠️ **ONLY A DEFINITE "NOT THERE" MEANS FREE.** `exists` rejects for a path
   * it cannot interrogate, and reading that as absence hands the rename a
   * destination it silently replaces — the one outcome this exists to prevent.
   */
  it('skips a candidate it could not interrogate', async () => {
    const there = async (path: string) => {
      if (path === ASIDE) throw new Error('permission denied')
      return false
    }
    expect(await freeQuarantinePath(ASIDE, there)).toBe(`${ASIDE}.1`)
  })

  /* REFUSES rather than falling back on the last candidate. A
     hundred-and-first copy clarifies nothing; overwriting the hundredth
     clarifies less. */
  it('refuses when every candidate is taken', async () => {
    const every = async () => true
    const cause = await freeQuarantinePath(ASIDE, every).then(() => null, (e: unknown) => e)
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe(
      `cannot quarantine the store: ${ASIDE} and .1 through .100 all exist. ` +
        'Something is producing corrupt files faster than they can be looked at; ' +
        'move the existing quarantines aside before this can continue.',
    )
  })

  /* THE LAST CANDIDATE IS TESTED, which is the off-by-one the Node host had:
     a loop that assigns `.100` and then exits holds a name it never asked
     about, and the rename below replaces it. */
  it('uses the hundredth when only it is free', async () => {
    const there = async (path: string) => path !== `${ASIDE}.100`
    expect(await freeQuarantinePath(ASIDE, there)).toBe(`${ASIDE}.100`)
  })
})

/**
 * The one sentence a reader is told about their store — asserted WHOLE, since a
 * sentence that lost what it is about still contains the path.
 */
describe('what the reader is told about a damaged store', () => {
  it('says nothing about a store that read cleanly', () => {
    expect(damageNotice(null)).toBeNull()
  })

  it('names where a damaged store was moved', () => {
    expect(damageNotice({ aside: 'store.json.corrupt.2' })).toBe(
      'The file holding your cards, settings and tag preferences could not be read; it was moved to store.json.corrupt.2, and Paper started with an empty one.',
    )
  })

  /* NOTHING SAVED AND NOTHING LOST, which is what the store does in that state
     — it refuses every write rather than replacing the only copy. */
  it('says nothing is being saved when the damaged store could not be moved aside', () => {
    expect(damageNotice({ aside: null })).toBe(
      'The file holding your cards, settings and tag preferences could not be read, and could not be moved aside — so nothing is being saved this session, and the file is left exactly as it was.',
    )
  })
})

/**
 * Opening the store: the file in the app's data directory inside the shell, the
 * window's own storage outside it, and a sentence whenever the reader is getting
 * less than the file.
 *
 * The plugin and the command are faked at the IPC boundary, and only there;
 * `fileStore`'s rules run for real against them.
 */
describe('opening the store', () => {
  const CARDS = 'paper.cards.v1'

  /* The dev server opens this app in an ordinary browser tab, where a boot that
     reached for the filesystem would make the app unopenable. */
  it('hands back the window storage, with nothing to say, outside the shell', async () => {
    const local = storageHolding({ [CARDS]: '[]' })
    windowWith(false, local)
    const opened = await openAppStorage()
    expect(opened.storage).toBe(local)
    expect(opened.notice).toBeNull()
    expect([...disk.dirs], 'a browser tab reached for the filesystem').toEqual([])
  })

  it('answers null outside the shell where window storage is disabled by policy', async () => {
    windowWith(false, 'disabled')
    const opened = await openAppStorage()
    expect(opened.storage).toBeNull()
    expect(opened.notice).toBeNull()
  })

  /* EVERY LAUNCH AFTER THE FIRST finds the directory already there, and a
     non-recursive `mkdir` refuses one — which would pin every session after the
     first to window storage. The legacy copy disagrees with the file on
     purpose: the file wins, and a store that ignored it would migrate. */
  it('reads the store already on disk, in a data directory that already exists', async () => {
    disk.dirs.add('')
    disk.files.set(STORE_FILE, JSON.stringify({ [CARDS]: '["from the disk"]' }))
    windowWith(true, storageHolding({ [CARDS]: '["from the old storage"]' }))
    const opened = await openAppStorage()
    expect(opened.notice).toBeNull()
    expect(opened.storage?.getItem(CARDS)).toBe('["from the disk"]')
    expect((opened.storage as FileStore).migrated).toBe(false)
  })

  /* A FIRST LAUNCH: no directory, no file, and the reader's work still in the
     window's storage. The directory is created and nothing inside it, and what
     was carried over is on disk before the open resolves. */
  it('creates the data directory on a first launch, and writes what it carried over', async () => {
    windowWith(true, storageHolding({ [CARDS]: '["a card"]' }))
    const opened = await openAppStorage()
    expect(opened.notice).toBeNull()
    expect((opened.storage as FileStore).migrated).toBe(true)
    expect([...disk.dirs]).toEqual([''])
    expect(JSON.parse(disk.files.get(STORE_FILE) ?? 'null')).toEqual({ [CARDS]: '["a card"]' })
  })

  /* THROUGH THE ATOMIC COMMAND, AT THE FULL LEVEL: a torn store loses every
     card and setting, not one. */
  it('writes a change through the atomic write, synced in full', async () => {
    disk.dirs.add('')
    disk.files.set(STORE_FILE, JSON.stringify({}))
    windowWith(true, storageHolding())
    const { storage } = await openAppStorage()
    storage?.setItem(CARDS, '["a new card"]')
    await (storage as FileStore).flush()
    expect(JSON.parse(disk.files.get(STORE_FILE) ?? 'null')).toEqual({ [CARDS]: '["a new card"]' })
    expect(disk.levels).toEqual(['full'])
  })

  /* ⚠️ **A SECOND CORRUPTION MUST NOT ERASE THE FIRST, AND THE NOTICE NAMES
     THE FILE THAT WAS WRITTEN.** `fileStore` asks for `.corrupt` every time;
     the adapter answers where the bytes actually went. */
  it('moves a damaged store beside an earlier quarantine, and tells the reader where', async () => {
    disk.dirs.add('')
    disk.files.set(STORE_FILE, '{"paper.cards.v1": "[tru')
    disk.files.set(`${STORE_FILE}.corrupt`, 'the first damage')
    windowWith(true, storageHolding())
    const opened = await openAppStorage()
    expect(opened.notice).toBe(
      `The file holding your cards, settings and tag preferences could not be read; it was moved to ${STORE_FILE}.corrupt.1, and Paper started with an empty one.`,
    )
    expect(disk.files.get(`${STORE_FILE}.corrupt`), 'the earlier quarantine was replaced').toBe('the first damage')
    expect(disk.files.get(`${STORE_FILE}.corrupt.1`)).toBe('{"paper.cards.v1": "[tru')
    expect(disk.files.has(STORE_FILE)).toBe(false)
  })

  /* Loud, and not fatal — and PLAIN that this session's changes stay behind. */
  it('falls back to the window storage when the disk will not open, and says changes stay there', async () => {
    const refusal = new Error('failed to create directory: Read-only file system')
    disk.refuse = refusal
    const local = storageHolding()
    windowWith(true, local)
    const opened = await openAppStorage()
    expect(opened.storage).toBe(local)
    expect(opened.notice).toBe(
      "Paper could not open its store on disk, so your cards, settings and tag preferences are kept in the window's storage for this session — changes made now will not reach the disk store when it recovers.",
    )
    expect(console.error).toHaveBeenCalledWith(
      'Paper: could not open the store on disk; falling back to localStorage',
      refusal,
    )
  })

  /* And no durability is claimed that does not exist: the session is memory. */
  it('says changes will not outlive the session when window storage is disabled too', async () => {
    disk.refuse = new Error('failed to create directory: Read-only file system')
    windowWith(true, 'disabled')
    const opened = await openAppStorage()
    expect(opened.storage).toBeNull()
    expect(opened.notice).toBe(
      'Paper could not open its store on disk, and window storage is disabled — changes to your cards, settings and tag preferences will not outlive this session.',
    )
  })
})
