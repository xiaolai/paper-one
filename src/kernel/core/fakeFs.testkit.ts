import type { TrashFs } from './bookTrash'
import type { IndexFs } from './bookIndex'

/**
 * An in-memory filesystem with the semantics that have bitten: `exists` is
 * true for a directory that has something in it, `rename` refuses to move a
 * non-empty directory onto a non-empty one, and a directory removal takes
 * what is under it.
 *
 * It was `bookTrash.test.ts`'s own, and it is the most honest of the fakes
 * that grew up beside each module's tests — see the note on `rename` — so it
 * is the one the contract suite runs the services over. Nothing here imports
 * a test runner; it is a fixture, not a test.
 */
export type FakeFs = TrashFs & IndexFs & { readonly store: Map<string, Uint8Array> }

export function fakeFs(files: Record<string, string> = {}): FakeFs {
  const store = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(files)) store.set(k, new TextEncoder().encode(v))
  const fs: FakeFs = {
    store,
    readDir: async (path) => {
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (!key.startsWith(`${path}/`)) continue
        const head = key.slice(path.length + 1).split('/')[0]
        if (head) names.add(head)
      }
      return [...names].map((name) => ({ name, isDirectory: !name.includes('.') }))
    },
    readFile: async (path) => {
      const bytes = store.get(path)
      if (!bytes) throw new Error('missing')
      return bytes
    },
    writeFile: async (path, bytes) => void store.set(path, bytes),
    // A prefix match, because these are directories.
    exists: async (path) => [...store.keys()].some((k) => k === path || k.startsWith(`${path}/`)),
    mkdir: async () => {},
    remove: async (path) => void store.delete(path),
    removeDir: async (path) => {
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key)
      }
    },
    /* REFUSES A NON-EMPTY DESTINATION, because `std::fs::rename` does. The
     * permissive version quietly succeeded at the exact move the real one
     * rejects — so a test for "removing a book whose trash entry still exists"
     * passed against the broken code as well as the fixed code, which is a test
     * that proves nothing. */
    rename: async (from, to) => {
      const moving = [...store.keys()].filter((k) => k === from || k.startsWith(`${from}/`))
      const occupied = [...store.keys()].some((k) => k === to || k.startsWith(`${to}/`))
      if (occupied && moving.some((k) => k !== from)) {
        throw new Error(`rename: ${to} is a non-empty directory`)
      }
      for (const key of moving) {
        const bytes = store.get(key)!
        store.set(key === from ? to : `${to}${key.slice(from.length)}`, bytes)
        store.delete(key)
      }
    },
  }
  return fs
}

/** One file as text, or null when it is not there. */
export function textAt(fs: FakeFs, path: string): string | null {
  const bytes = fs.store.get(path)
  return bytes ? new TextDecoder().decode(bytes) : null
}

/** One file as parsed JSON, or null when it is not there. */
export function jsonAt(fs: FakeFs, path: string): unknown {
  const text = textAt(fs, path)
  return text === null ? null : JSON.parse(text)
}
