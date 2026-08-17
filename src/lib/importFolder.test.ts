import { describe, expect, it, vi } from 'vitest'
import { contentPathIn } from './bookFolder'
import type { VaultFs } from './bookVault'
import { collectBooks, importFolder, keepOwnCopy, summarise, type DirFs } from './importFolder'

/**
 * Folder import, without a filesystem.
 *
 * The walk, the bounds and the reporting are all here. What is not is whether
 * Tauri's `readDir` is permitted to read the folder a reader chose — that is a
 * capability question and it needs the app.
 */

function fakeDir(tree: Record<string, string[]>, files: Record<string, string> = {}) {
  const dirs = new Set(Object.keys(tree))
  const fs: DirFs & { written: Map<string, Uint8Array> } = {
    written: new Map(),
    readDir: async (path) => {
      const entries = tree[path]
      if (!entries) throw new Error(`no such directory: ${path}`)
      return entries.map((name) => ({ name, isDirectory: dirs.has(`${path}/${name}`) }))
    },
    readOutside: async (path) => {
      const body = files[path]
      if (body === undefined) throw new Error('unreadable')
      return new TextEncoder().encode(body)
    },
    readFile: async () => new Uint8Array(),
    writeFile: async (path, bytes) => void fs.written.set(path, bytes),
    exists: async (path) => fs.written.has(path),
    mkdir: async () => {},
    remove: async (path) => void fs.written.delete(path),
    removeDir: async (path: string) => {
      for (const key of [...fs.written.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) fs.written.delete(key)
      }
    },
    rename: async (from, to) => {
      const bytes = fs.written.get(from)
      if (bytes) fs.written.set(to, bytes)
      fs.written.delete(from)
    },
  }
  return fs
}

describe('collectBooks', () => {
  it('finds books at every depth', async () => {
    const fs = fakeDir({
      '/books': ['a.epub', 'sub', 'notes.txt'],
      '/books/sub': ['b.pdf'],
    })
    expect(await collectBooks(fs, '/books')).toEqual(['/books/a.epub', '/books/sub/b.pdf'])
  })

  it('ignores files that are not books', async () => {
    const fs = fakeDir({ '/books': ['cover.jpg', 'notes.txt', 'a.epub'] })
    expect(await collectBooks(fs, '/books')).toEqual(['/books/a.epub'])
  })

  /* `.git` and `.Trash` contain nothing a reader means by "my books" and can be
   * enormous. */
  it('skips dot-directories', async () => {
    const fs = fakeDir({ '/books': ['.git', 'a.epub'], '/books/.git': ['blob.epub'] })
    expect(await collectBooks(fs, '/books')).toEqual(['/books/a.epub'])
  })

  /**
   * The bound that stops an import hanging with no error.
   *
   * A symlinked folder can point at its own parent, and Tauri's `readDir` does
   * not resolve links — so an unbounded walk follows that loop forever.
   */
  it('stops at the depth limit rather than following a cycle', async () => {
    const tree: Record<string, string[]> = {}
    let path = '/loop'
    for (let i = 0; i < 40; i += 1) {
      tree[path] = ['down', `book${i}.epub`]
      path = `${path}/down`
    }
    const found = await collectBooks(fakeDir(tree), '/loop')
    expect(found.length).toBeLessThanOrEqual(9)
  })

  /* A permission error three levels down should cost that branch, not the whole
   * import — otherwise one unreadable subfolder yields nothing, unexplained. */
  it('skips a subdirectory it cannot read, keeping the rest', async () => {
    const fs = fakeDir({ '/books': ['a.epub', 'locked'] })
    expect(await collectBooks(fs, '/books')).toEqual(['/books/a.epub'])
  })

  it('returns nothing for a folder it cannot read at all', async () => {
    expect(await collectBooks(fakeDir({}), '/nowhere')).toEqual([])
  })
})

describe('importFolder', () => {
  const tree = { '/books': ['a.epub', 'b.epub'] }
  const files = { '/books/a.epub': 'ALPHA', '/books/b.epub': 'BETA' }

  it('copies every book it finds', async () => {
    const fs = fakeDir(tree, files)
    const outcomes = await importFolder(fs, '/books')
    expect(outcomes.map((one) => one.status)).toEqual(['added', 'added'])
    expect(fs.written.size).toBe(2)
  })

  /* Named individually. "4 of 300 failed" tells a reader nothing they can act
   * on; the path and the reason say which book and usually why. */
  it('names the book that failed and why, without stopping', async () => {
    const fs = fakeDir({ '/books': ['a.epub', 'broken.epub'] }, { '/books/a.epub': 'ALPHA' })
    const outcomes = await importFolder(fs, '/books')
    expect(outcomes[0]?.status).toBe('added')
    expect(outcomes[1]).toMatchObject({ path: '/books/broken.epub', status: 'failed' })
    expect(outcomes[1]?.reason).toBeTruthy()
  })

  it('reports progress as it goes', async () => {
    const seen: number[] = []
    await importFolder(fakeDir(tree, files), '/books', {
      onProgress: (p) => seen.push(p.done),
    })
    expect(seen[seen.length - 1]).toBe(2)
  })

  /* A book already in the vault is a duplicate, and saying so is what lets the
   * caller shelve it when no row refers to it. */
  it('reports a book it already holds as a duplicate rather than as added', async () => {
    const fs = fakeDir(tree, files)
    await importFolder(fs, '/books')
    const again = await importFolder(fs, '/books')
    expect(again.map((one) => one.status)).toEqual(['duplicate', 'duplicate'])
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcomes = await importFolder(fakeDir(tree, files), '/books', {
      signal: controller.signal,
    })
    expect(outcomes).toEqual([])
  })

  /* The yield between books is what keeps a 300-book import from freezing the
   * window. Asserted structurally: without it the loop never returns to the
   * task queue at all. */
  it('hands the main thread back between books', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    await importFolder(fakeDir(tree, files), '/books')
    expect(timeout).toHaveBeenCalled()
    timeout.mockRestore()
  })
})

describe('summarise', () => {
  it('says what happened in one line', () => {
    expect(
      summarise([
        { path: 'a', status: 'added' },
        { path: 'b', status: 'duplicate' },
        { path: 'c', status: 'failed' },
      ]),
    ).toBe('1 added, 1 already here, 1 could not be read')
  })

  it('mentions only what applies', () => {
    expect(summarise([{ path: 'a', status: 'added' }])).toBe('1 added')
  })

  it('says so when a folder held no books', () => {
    expect(summarise([])).toBe('No books found in that folder.')
  })
})

/**
 * Picking five books used to add one.
 *
 * Opening a book REPLACES the open one, so a loop that opened each picked file
 * in turn left React with a single source and shelved a single book. The other
 * four were selected, reported as nothing, and never arrived.
 */
describe('keepOwnCopy', () => {
  const fileOf = (name: string, body: string) => new File([body], name)

  function fakeFs() {
    const files = new Map<string, Uint8Array>()
    const fs: VaultFs & { files: Map<string, Uint8Array>; failWrite?: string } = {
      files,
      readFile: async (path) => {
        const bytes = files.get(path)
        if (!bytes) throw new Error('missing')
        return bytes
      },
      writeFile: async (path, bytes) => {
        if (fs.failWrite && path.startsWith(fs.failWrite)) throw new Error('disk full')
        files.set(path, bytes)
      },
      exists: async (path) => files.has(path),
      mkdir: async () => {},
      remove: async (path) => void files.delete(path),
      removeDir: async () => {},
      rename: async (from, to) => {
        const bytes = files.get(from)
        if (bytes) files.set(to, bytes)
        files.delete(from)
      },
    }
    return fs
  }

  it('keeps a copy and reports it as added', async () => {
    const fs = fakeFs()
    const out = await keepOwnCopy(fs, fileOf('moby.epub', 'WHALE'), '/Users/x/moby.epub')
    expect(out.status).toBe('added')
    expect(out.bookId).toBeTruthy()
    expect(fs.files.has(contentPathIn(out.bookId!, 'moby.epub'))).toBe(true)
  })

  /* Same bytes, same folder — so the second time is a duplicate rather than a
   * second copy, exactly as a folder import reports it. */
  it('reports the same bytes as a duplicate the second time', async () => {
    const fs = fakeFs()
    await keepOwnCopy(fs, fileOf('moby.epub', 'WHALE'), null)
    const again = await keepOwnCopy(fs, fileOf('moby-copy.epub', 'WHALE'), null)
    expect(again.status).toBe('duplicate')
  })

  it('falls back to the filename when there is no path', async () => {
    const fs = fakeFs()
    expect((await keepOwnCopy(fs, fileOf('moby.epub', 'W'), null)).path).toBe('moby.epub')
  })

  it('leaves no temporary file behind when the write fails', async () => {
    const fs = fakeFs()
    fs.failWrite = 'books'
    await expect(keepOwnCopy(fs, fileOf('moby.epub', 'W'), null)).rejects.toThrow()
    expect([...fs.files.keys()].some((k) => k.endsWith('.writing'))).toBe(false)
  })
})
