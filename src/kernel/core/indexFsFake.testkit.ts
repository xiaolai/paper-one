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
  /* Per path, because the assertion worth making is "this file was
     rewritten once", not "the disk was touched once". */
  const written = new Map<string, number>()
  const fs: IndexFs & {
    store: Map<string, Uint8Array>
    reads: () => number
    writes: (path: string) => number
  } = {
    store,
    reads: () => reads,
    writes: (path) => written.get(path) ?? 0,
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
    writeFile: async (path, bytes) => {
      written.set(path, (written.get(path) ?? 0) + 1)
      store.set(path, bytes)
    },
    /* A DIRECTORY EXISTS when anything lives under it — same reasoning as
     * `rename`. Answering only for exact keys made `trashBook`'s "is the folder
     * there" guard false for every folder, so removal silently moved nothing in
     * tests while working fine in the app. */
    exists: async (path) => {
      if (store.has(path)) return true
      for (const key of store.keys()) if (key.startsWith(`${path}/`)) return true
      return false
    },
    mkdir: async () => {},
    remove: async (path) => void store.delete(path),
    removeDir: async (path: string) => {
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key)
      }
    },
    rename: async (from, to) => {
      /* A RENAME COUNTS AS A WRITE OF ITS DESTINATION. Durable writes here go
       * temp-file-then-rename, so counting only `writeFile` per path reports
       * zero for every file the app actually rewrites — a counter that always
       * answers zero is worse than none. */
      written.set(to, (written.get(to) ?? 0) + 1)
      /* A DIRECTORY MOVES WITH ITS CONTENTS, as the real call does. Directories
       * are implicit here — a folder is the keys under it — so renaming one is
       * a prefix rewrite. Moving only the exact key made `trashBook`'s one
       * rename silently leave every file behind, which is a fake refuting the
       * property the code under test is built on. */
      const bytes = store.get(from)
      if (bytes) store.set(to, bytes)
      store.delete(from)
      for (const key of [...store.keys()]) {
        if (!key.startsWith(`${from}/`)) continue
        store.set(`${to}${key.slice(from.length)}`, store.get(key)!)
        store.delete(key)
      }
    },
  }
  return fs
}
