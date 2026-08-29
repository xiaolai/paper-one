import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createKernelServices,
  loadShelf,
  type IndexedBook,
  type KernelServices,
} from '../../kernel'
import { fakeFs } from '../../kernel/testkit'
import { FIXTURE, FIXTURE_FILES } from './fixture.testkit'
import { APP_IDENTIFIER, DATA_DIR_ENV, defaultDataDir, openNodeServices } from './services'

/**
 * `kernel/core` under Node (WI-11.2).
 *
 * The claim is "the phase-4 fixture opens IDENTICALLY", so the test opens one
 * fixture two ways — through a real directory and through the in-memory
 * `IndexFs` every other kernel suite runs on — and compares the answers row
 * for row. A Node seam that is subtly different from the seam the app uses
 * would make every suite in the repository pass for a reason the CLI does not
 * share, which is exactly the failure this is written against.
 */

const roots: string[] = []

async function fixtureOnDisk(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paper-node-host-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const full = join(root, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

/** The same fixture through the seam the rest of the suites use. */
async function throughTheFake(): Promise<{ books: readonly IndexedBook[]; services: KernelServices }> {
  const fs = fakeFs({ ...FIXTURE_FILES })
  const shelf = await loadShelf(fs)
  return { books: shelf.books, services: createKernelServices({ fs, storage: null, initialBooks: shelf.books }) }
}

/** Rows compare by content, not by the order two directory listings gave. */
const byId = (books: readonly IndexedBook[]): IndexedBook[] =>
  [...books].sort((a, b) => a.bookId.localeCompare(b.bookId))

describe('defaultDataDir', () => {
  it('treats an empty HOME as no home, never as the current directory', () => {
    /* `HOME=` used to pass `??` as the empty string, and every platform path
     * then resolved relative to wherever the shell was. */
    expect(defaultDataDir({ HOME: '' }, 'darwin')).not.toMatch(/^Library/)
    expect(defaultDataDir({ HOME: '' }, 'darwin')).toBe(defaultDataDir({}, 'darwin'))
  })

  it('resolves the app data directory per platform, under the bundle identifier', () => {
    expect(defaultDataDir({ HOME: '/Users/x' }, 'darwin')).toBe(`/Users/x/Library/Application Support/${APP_IDENTIFIER}`)
    expect(defaultDataDir({ HOME: '/home/x' }, 'linux')).toBe(`/home/x/.local/share/${APP_IDENTIFIER}`)
    expect(defaultDataDir({ HOME: '/home/x', XDG_DATA_HOME: '/xdg' }, 'linux')).toBe(`/xdg/${APP_IDENTIFIER}`)
    /* SPELLED OUT, not built with `join`. The assertion used the HOST's
     * separator, so on a Mac it expected `C:\Roaming/one.paper.reader` — a
     * Windows drive with a POSIX separator, which is a path on neither system
     * — and agreed with a `defaultDataDir` that had the same bug. Two wrongs
     * that matched each other everywhere except on Windows, where nothing had
     * run. The answer for a named platform does not depend on the platform
     * asking, so the expectation should not either. */
    expect(defaultDataDir({ HOME: 'C:\\Users\\x', APPDATA: 'C:\\Roaming' }, 'win32')).toBe(
      `C:\\Roaming\\${APP_IDENTIFIER}`,
    )
    expect(defaultDataDir({ HOME: 'C:\\Users\\x' }, 'win32')).toBe(
      `C:\\Users\\x\\AppData\\Roaming\\${APP_IDENTIFIER}`,
    )
  })

  it('lets the environment name another, so a harness can point at a fixture', () => {
    expect(defaultDataDir({ HOME: '/Users/x', [DATA_DIR_ENV]: '/tmp/library' }, 'darwin')).toBe('/tmp/library')
    /* Empty is not a choice — it is an unset variable spelled badly, and a
     * host that honoured it would read the process's working directory. */
    expect(defaultDataDir({ HOME: '/Users/x', [DATA_DIR_ENV]: '' }, 'darwin')).toBe(
      `/Users/x/Library/Application Support/${APP_IDENTIFIER}`,
    )
  })
})

describe('openNodeServices', () => {
  it('builds KernelServices against a real library directory', async () => {
    const host = await openNodeServices({ dataDir: await fixtureOnDisk() })
    try {
      expect(host.services.library.getSnapshot()).toHaveLength(FIXTURE.books)
      expect(host.shelf.rescanned).toBe(true)
      expect(host.shelf.why).toBe('no cache')
      expect(host.services.fs).not.toBeNull()
      expect(host.services.storage).not.toBeNull()
    } finally {
      await host.close()
    }
  })

  it('makes the data directory when it is not there, and starts empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paper-node-host-'))
    roots.push(root)
    const host = await openNodeServices({ dataDir: join(root, 'not-yet') })
    try {
      expect(host.services.library.getSnapshot()).toEqual([])
      expect(host.dataDir).toBe(join(root, 'not-yet'))
    } finally {
      await host.close()
    }
  })

  it('reports the same book count, records and marks as the webview host does', async () => {
    const host = await openNodeServices({ dataDir: await fixtureOnDisk() })
    const fake = await throughTheFake()
    try {
      expect(host.services.library.getSnapshot()).toHaveLength(FIXTURE.books)
      expect(byId(host.services.library.getSnapshot())).toEqual(byId(fake.books))

      for (const id of FIXTURE.ids) {
        const fromDisk = await host.services.marks.forBook(id)
        const fromFake = await fake.services.marks.forBook(id)
        expect(fromDisk).toHaveLength(FIXTURE.marks[id])
        expect(fromDisk).toEqual(fromFake)
      }
    } finally {
      await host.close()
    }
  })

  it('derives hasContent from the folder, so a record with no bytes says so', async () => {
    const host = await openNodeServices({ dataDir: await fixtureOnDisk() })
    try {
      const withContent = host.services.library
        .getSnapshot()
        .filter((one) => one.hasContent === true)
        .map((one) => one.bookId)
        .sort()
      expect(withContent).toEqual([...FIXTURE.withContent].sort())
    } finally {
      await host.close()
    }
  })

  it('writes through to the directory, and a second open reads what it wrote', async () => {
    const dataDir = await fixtureOnDisk()
    const first = await openNodeServices({ dataDir })
    await first.services.library.tag('bbb', 'whales')
    await first.close()

    const second = await openNodeServices({ dataDir })
    try {
      const book = second.services.library.getSnapshot().find((one) => one.bookId === 'bbb')
      expect(book?.tags).toContain('whales')
      /* The first open wrote `index.json`, so the second trusts the cache —
       * which is the property that makes a CLI on a 2 000-book library
       * answer in one file read rather than two per book. */
      expect(second.shelf.rescanned).toBe(false)
      expect(second.shelf.why).toBe('cache')
    } finally {
      await second.close()
    }
  })

  it('persists settings and cards through the flat store', async () => {
    const dataDir = await fixtureOnDisk()
    const first = await openNodeServices({ dataDir })
    await first.services.cards.add({
      id: 'c1',
      bookId: 'aaa',
      kind: 'Idea',
      body: 'a card',
      answer: '',
      source: 'Ch. 1',
      cfi: null,
      createdAt: 1,
    })
    await first.close()

    const second = await openNodeServices({ dataDir })
    try {
      expect(second.services.cards.getSnapshot().all.map((one) => one.id)).toEqual(['c1'])
    } finally {
      await second.close()
    }
  })

  /* A shelf that will not load is NOT an empty shelf. The app cannot throw
   * there; a CLI must, or `paper book list` prints nothing and the reader
   * concludes their library is gone. */
  it('throws rather than reporting an empty library when the shelf cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paper-node-host-'))
    roots.push(root)
    /* `books` as a FILE: the listing fails with ENOTDIR, which is the shape
     * of an unreadable library rather than an absent one. */
    await writeFile(join(root, 'books'), 'not a directory')
    await expect(openNodeServices({ dataDir: root })).rejects.toThrow()
  })

  it('leaves every kernel port on its default — nothing journals, nothing serves', async () => {
    const host = await openNodeServices({ dataDir: await fixtureOnDisk() })
    try {
      /* Unbound, so binding succeeds — which is the observable form of "the
       * slot is free". A composed capability would have taken it. */
      const bound = host.services.bindRecorder({ begin: async (book, what) => ({ book, what }), commit: async () => {} })
      bound.dispose()
      const served = await host.services.serveServices([])
      served.dispose()
    } finally {
      await host.close()
    }
  })
})
