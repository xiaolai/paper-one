import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOKS_ONLY_BYTES, LIBRARY_FIXTURE, LIBRARY_FIXTURE_BYTES } from '../testkit'

/**
 * The TAURI size binding: the plugin calls it makes, and the paths it makes them
 * with.
 *
 * Half of a conformance pair — `src/hosts/node/fs.test.ts` asks the Node
 * binding the same question over the same fixture, and both are held to
 * `LIBRARY_FIXTURE_BYTES`. See `librarySizes.testkit.ts` for the defect that
 * pair exists for: two copies of one walk, one starting at `books/` and one at
 * the data root, so `shelf.status.bytes` depended on which host you asked.
 *
 * The plugin is mocked because it cannot run outside a webview. What is under
 * test is the BINDING — the path mapping and the `isFile` reading — and that it
 * feeds the shared walk rather than a copy of it.
 */

/* Hoisted: the mock factory runs before the module body, so the fixture it
   serves has to be reachable from inside it. */
const plugin = vi.hoisted(() => ({
  files: {} as Record<string, number>,
  /** Directories this fake refuses, the way a real one refuses on permissions. */
  refuse: [] as string[],
  readDirCalls: [] as string[],
  statCalls: [] as string[],
}))

vi.mock('@tauri-apps/plugin-fs', () => {
  /**
   * ⚠️ **THE PLUGIN JOINS ITS ARGUMENT ONTO THE BASE DIRECTORY**, and an empty
   * segment is not a path it resolves. The walk names the data root `''`; the
   * binding maps that to `'.'`. This fake models the same resolution, so a
   * binding that stopped mapping it would read as "no such directory" here.
   */
  const at = (path: string) => (path === '.' ? '' : path)
  return {
    BaseDirectory: { AppData: 'AppData' },
    stat: async (path: string) => {
      plugin.statCalls.push(path)
      const size = plugin.files[at(path)]
      if (size !== undefined) return { isFile: true, size }
      /* A DIRECTORY, or nothing at all. `isFile: false` is what the binding
         reads to answer null — and it must not answer 0, because "nobody can
         say" and "empty" are different answers to every caller of this port. */
      if (Object.keys(plugin.files).some((key) => key.startsWith(`${at(path)}/`))) {
        return { isFile: false, size: 0 }
      }
      throw new Error(`no such path: ${path}`)
    },
    readDir: async (path: string) => {
      plugin.readDirCalls.push(path)
      if (plugin.refuse.includes(at(path))) throw new Error(`refused: ${path}`)
      const prefix = at(path) === '' ? '' : `${at(path)}/`
      const found = new Map<string, boolean>()
      for (const key of Object.keys(plugin.files)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length).split('/')
        found.set(rest[0]!, rest.length > 1)
      }
      if (found.size === 0) throw new Error(`no such directory: ${path}`)
      return [...found].map(([name, isDirectory]) => ({ name, isDirectory }))
    },
  }
})

const { tauriSizePort } = await import('./bookSizesTauri')

beforeEach(() => {
  plugin.files = { ...LIBRARY_FIXTURE }
  plugin.refuse = []
  plugin.readDirCalls = []
  plugin.statCalls = []
})

afterEach(() => vi.restoreAllMocks())

describe('libraryBytes', () => {
  /**
   * ⚠️ **THIS WALKED `books/`, AND THE PORT PROMISES THE WHOLE LIBRARY.** The
   * desktop's total silently omitted `index.json`, the flat store, the sync
   * metadata and the trash — and it is the number a reader sees when deciding
   * whether to delete a book.
   */
  it('counts the whole data directory, not just the books', async () => {
    const bytes = await tauriSizePort.libraryBytes()
    expect(bytes).toBe(LIBRARY_FIXTURE_BYTES)
    expect(bytes, 'this is the answer the books/-only walk gave').not.toBe(BOOKS_ONLY_BYTES)
  })

  /* THE ROOT IS ASKED FOR BY A NAME THE PLUGIN TAKES. `''` resolves to nothing;
     `'.'` is the same directory spelled in a way it accepts. */
  it('asks the plugin for the data root by a name it resolves', async () => {
    await tauriSizePort.libraryBytes()
    expect(plugin.readDirCalls[0], 'the plugin will not resolve an empty segment').toBe('.')
  })

  /* AND ROOT FILES BY A RELATIVE NAME. `/index.json` is an ABSOLUTE path, which
     resolves outside the data directory rather than inside it. */
  it('names a file at the root without a leading slash', async () => {
    await tauriSizePort.libraryBytes()
    expect(plugin.statCalls, 'a leading slash escapes the data directory').toContain('index.json')
    expect(plugin.statCalls.some((path) => path.startsWith('/'))).toBe(false)
  })

  /**
   * A WALK THAT DID NOT FINISH HAS NO TOTAL. The partial answer is the
   * dangerous one: it is a number, it looks exact, and it is short by however
   * much could not be read.
   */
  it('answers null when a directory will not read', async () => {
    plugin.refuse = ['trash']
    expect(
      await tauriSizePort.libraryBytes(),
      'a total short by whatever could not be read is worse than no total',
    ).toBeNull()
  })

  /* AND ZERO IS A MEASUREMENT. A directory that read and held nothing is not
     the same as one nobody could open. */
  it('answers zero for a library that is there and empty', async () => {
    plugin.files = { 'keep.me': 0 }
    expect(await tauriSizePort.libraryBytes()).toBe(0)
  })
})

describe('contentBytes', () => {
  it('measures a book’s content file whatever its format', async () => {
    expect(await tauriSizePort.contentBytes('bk1')).toBe(100)
    expect(await tauriSizePort.contentBytes('bk2')).toBe(300)
  })

  it('answers null for a book with no content file', async () => {
    expect(await tauriSizePort.contentBytes('bk9')).toBeNull()
  })

  /* NULL, NEVER ZERO, for something that is not a file. Every caller has to
     tell "nobody can say" from "empty" before deciding whether a book's bytes
     are here at all. */
  it('answers null for a directory rather than zero', async () => {
    expect(await tauriSizePort.bytesAt('books/bk1')).toBeNull()
  })
})
