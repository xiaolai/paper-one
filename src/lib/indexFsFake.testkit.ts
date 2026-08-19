import { BOOKS_DIR } from './bookFolder'
import type { IndexFs } from './bookIndex'

/**
 * An `IndexFs` over a Map, for tests that need a library on disk.
 *
 * Extracted from `bookIndex.test.ts` when the `useLibrary` hook tests needed
 * the same thing — one fake, or the two drift on what a filesystem does and a
 * test passes against behaviour the other suite's fake refutes.
 *
 * The one deliberate quirk: `readDir` on a missing directory throws only for
 * `BOOKS_DIR`, and lists empty for anything else. The real plugin throws for
 * every missing directory, but the scan is the only caller that must SEE that
 * failure — it is how "no library yet" is told apart from "unreadable" — and
 * every other caller treats a missing folder as empty anyway. Throwing
 * everywhere would make each test seed folders it does not care about.
 */
export function fakeFs(files: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(files)) store.set(k, new TextEncoder().encode(v))
  let reads = 0
  const fs: IndexFs & { store: Map<string, Uint8Array>; reads: () => number } = {
    store,
    reads: () => reads,
    readDir: async (path) => {
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (!key.startsWith(`${path}/`)) continue
        const rest = key.slice(path.length + 1)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
      /* A MISSING DIRECTORY THROWS, whatever else is in the store. It used to
       * throw only when the store was entirely empty — so a test that seeded
       * `index.json` and no `books/` got an empty listing instead of the failure
       * the real `readDir` gives, and the case it was written for never ran. */
      if (names.size === 0 && path === BOOKS_DIR) throw new Error('no dir')
      return [...names].map((name) => ({ name, isDirectory: !name.includes('.') }))
    },
    readFile: async (path) => {
      reads += 1
      const bytes = store.get(path)
      if (!bytes) throw new Error(`no such file: ${path}`)
      return bytes
    },
    writeFile: async (path, bytes) => void store.set(path, bytes),
    exists: async (path) => store.has(path),
    mkdir: async () => {},
    remove: async (path) => void store.delete(path),
    removeDir: async (path: string) => {
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key)
      }
    },
    rename: async (from, to) => {
      const bytes = store.get(from)
      if (bytes) store.set(to, bytes)
      store.delete(from)
    },
  }
  return fs
}
