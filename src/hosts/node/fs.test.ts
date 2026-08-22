import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTENT_EXTENSIONS } from '../../kernel'
import { appPresence, makeDataDir, nodeIndexFs, nodeSizePort, nodeTextFs, under } from './fs'

/**
 * The Node seam, held to the behaviours the kernel actually depends on
 * (WI-11.2).
 *
 * Not "does `readFile` read a file" — that is `node:fs`'s business. What is
 * asserted here is every place the kernel LEANS on a specific answer: that a
 * missing `books/` throws so the scan can tell "no library yet" from
 * "unreadable"; that a rename carries a directory's contents, because
 * `trashBook` moves a folder with exactly one call; that a path leaving the
 * data directory is refused before it reaches the disk.
 */

/**
 * Make `path` unreadable, and PROVE it — or answer false.
 *
 * `chmod(…, 0o000)` is not a denial everywhere. On Windows it is close to a
 * no-op, and root is exempt from the mode bits entirely — so a test built on
 * it PASSES on those platforms by never exercising the failure it names,
 * which is the vacuous-check class this repository keeps finding. Two of them
 * were here, and one had no guard at all.
 *
 * The denial is verified by attempting the read. When it did not take, the
 * mode is put back and `false` is returned, and the caller SKIPS rather than
 * asserting — a test that cannot run should say so, not quietly succeed.
 */
async function denyAccess(path: string, kind: 'file' | 'directory' = 'file'): Promise<boolean> {
  if (process.platform === 'win32' || process.getuid?.() === 0) return false
  await chmod(path, 0o000)
  const denied = await (kind === 'file' ? readFile(path) : readdir(path)).then(
    () => false,
    () => true,
  )
  if (!denied) await chmod(path, kind === 'file' ? 0o644 : 0o755)
  return denied
}

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paper-node-fs-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const bytes = (value: string) => new TextEncoder().encode(value)

describe('under', () => {
  it('resolves a relative path inside the root', () => {
    expect(under('/data', 'books/aaa/book.json')).toBe(resolve('/data', 'books/aaa/book.json'))
  })

  it('answers the root itself for an empty path — the boot mkdir names one', () => {
    expect(under('/data', '')).toBe(resolve('/data'))
  })

  it('refuses a path that climbs out', () => {
    expect(() => under('/data', '../secrets')).toThrow(/leaves the data directory/)
    expect(() => under('/data', 'books/../../secrets')).toThrow(/leaves the data directory/)
  })

  /* A `startsWith` on the joined string calls this one INSIDE the root. It is
   * not: `/data-backup` is a sibling of `/data` that shares its first six
   * characters, and a host that wrote there would corrupt another library. */
  it('refuses a sibling directory whose name starts with the root', () => {
    expect(() => under('/data', '../data-backup/index.json')).toThrow(/leaves the data directory/)
  })

  it('refuses an absolute path outright', () => {
    expect(() => under('/data', '/etc/passwd')).toThrow(/absolute/)
  })
})

describe('nodeIndexFs', () => {
  it('writes, reads, and reports existence', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('books/aaa')
    expect(await fs.exists('books/aaa/book.json')).toBe(false)
    await fs.writeFile('books/aaa/book.json', bytes('{"title":"x"}'))
    expect(await fs.exists('books/aaa/book.json')).toBe(true)
    expect(text(await fs.readFile('books/aaa/book.json'))).toBe('{"title":"x"}')
  })

  it('makes a directory recursively, and does not mind one that is there', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('a/b/c')
    await fs.mkdir('a/b/c')
    expect(await fs.exists('a/b/c')).toBe(true)
  })

  /* The scan is the ONE caller that must see this failure: an empty listing
   * and an unreadable directory mean very different things, and answering `[]`
   * for both is how a full library reports itself as empty. */
  it('throws on a directory that is not there', async () => {
    const root = await freshRoot()
    await expect(nodeIndexFs(root).readDir('books')).rejects.toThrow()
  })

  it('lists a directory, saying which entries are directories', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('books/aaa')
    await fs.writeFile('books/aaa/book.json', bytes('{}'))
    await fs.writeFile('index.json', bytes('{}'))
    const top = await fs.readDir('')
    expect(top.find((one) => one.name === 'books')?.isDirectory).toBe(true)
    expect(top.find((one) => one.name === 'index.json')?.isDirectory).toBe(false)
  })

  it('carries a directory and everything in it through one rename', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('books/aaa')
    await fs.writeFile('books/aaa/book.json', bytes('{}'))
    await fs.writeFile('books/aaa/marks.json', bytes('[]'))
    await fs.mkdir('trash')
    await fs.rename('books/aaa', 'trash/aaa')
    expect(await fs.exists('books/aaa')).toBe(false)
    expect(text(await fs.readFile('trash/aaa/marks.json'))).toBe('[]')
  })

  it('removes one file and refuses one that is not there', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.writeFile('one.json', bytes('{}'))
    await fs.remove('one.json')
    expect(await fs.exists('one.json')).toBe(false)
    await expect(fs.remove('one.json')).rejects.toThrow()
  })

  it('removes a directory whole, and is content when it was already gone', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('trash/aaa')
    await fs.writeFile('trash/aaa/book.json', bytes('{}'))
    await fs.removeDir('trash/aaa')
    expect(await fs.exists('trash/aaa')).toBe(false)
    await expect(fs.removeDir('trash/aaa')).resolves.toBeUndefined()
  })

  /**
   * THE JOURNAL'S PRIMITIVE — present, and a REAL append.
   *
   * The contents assertion below says the bytes ended up right. It says
   * nothing about how: a read-modify-write implementation produces exactly the
   * same file, and the journal appends one line per mutation over the life of
   * a library — so an O(n) append is O(n²) over a session, on the write path
   * that guards the reader's edits. That is the property worth pinning, and
   * "the final contents are correct" cannot see it.
   *
   * Measured rather than asserted about: appending one line to an existing
   * megabyte must not read that megabyte back.
   */
  it('appends without rewriting', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('sync')
    await fs.appendFile?.('sync/journal.jsonl', bytes('one\n'))
    await fs.appendFile?.('sync/journal.jsonl', bytes('two\n'))
    expect(text(await fs.readFile('sync/journal.jsonl'))).toBe('one\ntwo\n')
  })

  it('does not read the file back in order to append to it', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('sync')
    await fs.writeFile('sync/journal.jsonl', bytes('one\n'))

    /* WRITE-ONLY, which is the whole test and needs no clock.
     *
     * A real append opens for writing and never reads; a read-modify-write
     * has to read first and cannot. Timing the two was the first attempt and
     * was a bad one — a rewrite of a megabyte and a rewrite of a megabyte are
     * the same speed, so the margin was noise. This is the property itself.
     *
     * Skipped for root, who is exempt from the mode bits and would make it
     * pass by not applying. */
    if (process.getuid?.() === 0) return
    await chmod(join(root, 'sync/journal.jsonl'), 0o222)
    try {
      await expect(fs.appendFile?.('sync/journal.jsonl', bytes('two\n'))).resolves.toBeUndefined()
    } finally {
      await chmod(join(root, 'sync/journal.jsonl'), 0o644)
    }

    /* And it really appended — the earlier line is still there, so the write
     * did not simply replace the file. */
    expect(text(await fs.readFile('sync/journal.jsonl'))).toBe('one\ntwo\n')
  })

  it('refuses every operation on a path outside the root', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await expect(fs.readFile('../escape')).rejects.toThrow(/leaves the data directory/)
    await expect(fs.writeFile('../escape', bytes('x'))).rejects.toThrow(/leaves the data directory/)
    await expect(fs.mkdir('../escape')).rejects.toThrow(/leaves the data directory/)
    await expect(fs.remove('../escape')).rejects.toThrow(/leaves the data directory/)
    await expect(fs.removeDir('../escape')).rejects.toThrow(/leaves the data directory/)
    await expect(fs.rename('a', '../escape')).rejects.toThrow(/leaves the data directory/)
    /* THE SOURCE TOO. `rename` takes two paths and checking one of them is
     * checking half a door: a source outside the root MOVES a file the reader
     * never offered — and moving it out of the way is as destructive as
     * writing over it. */
    await expect(fs.rename('../escape', 'a')).rejects.toThrow(/leaves the data directory/)
    await expect(fs.readDir('../escape')).rejects.toThrow(/leaves the data directory/)
    await expect(fs.exists('../escape')).rejects.toThrow(/leaves the data directory/)
    /* APPEND IS A WRITE. It was left out of this list while it was the
     * journal's newest primitive, so the one operation that can extend an
     * arbitrary file forever was the one operation nothing here refused.
     * Asserted present first: `?.` on a missing method yields `undefined`,
     * and `expect(undefined).rejects` is a test that cannot fail. */
    expect(typeof fs.appendFile).toBe('function')
    await expect(fs.appendFile?.('../escape', bytes('x'))).rejects.toThrow(/leaves the data directory/)
  })
})

describe('nodeTextFs', () => {
  it('answers null for a file that is not there, rather than throwing', async () => {
    const root = await freshRoot()
    expect(await nodeTextFs(root).read('paper.store.v1.json')).toBeNull()
  })

  it('round-trips text', async () => {
    const root = await freshRoot()
    const fs = nodeTextFs(root)
    await fs.write('paper.store.v1.json', '{"a":1}')
    expect(await fs.read('paper.store.v1.json')).toBe('{"a":1}')
  })

  /* THE OTHER FAILURES MUST NOT LOOK LIKE ABSENCE.
   *
   * `null` means "there is no store here", and the caller's answer to that is
   * to start an empty one. A permission error or a directory in the store's
   * place answered `null` too would present a library the reader still has as
   * a library they never had, and the first write would then replace it. Only
   * `ENOENT`/`ENOTDIR` may become `null`; everything else is thrown. */
  it('throws rather than answering null when the store is unreadable', async () => {
    const root = await freshRoot()
    const fs = nodeTextFs(root)

    /* A DIRECTORY where the file belongs — EISDIR. */
    await nodeIndexFs(root).mkdir('paper.store.v1.json')
    await expect(fs.read('paper.store.v1.json')).rejects.toThrow()

    /* AND A FILE THAT WILL NOT OPEN — EACCES. Skipped for root, who is
     * exempt from the mode bits and would make this pass by not applying. */
    const other = await freshRoot()
    const guarded = nodeTextFs(other)
    await guarded.write('paper.store.v1.json', '{"kept":true}')
    const at = join(other, 'paper.store.v1.json')
    if (!(await denyAccess(at))) return
    try {
      await expect(guarded.read('paper.store.v1.json')).rejects.toThrow()
    } finally {
      await chmod(at, 0o644)
    }
  })

  /* Through a neighbour and a rename: a truncated store loses EVERY mark
   * rather than one, so the destination must never be opened for writing. */
  it('leaves no temporary file behind on success', async () => {
    const root = await freshRoot()
    await nodeTextFs(root).write('paper.store.v1.json', '{}')
    const names = (await nodeIndexFs(root).readDir('')).map((one) => one.name)
    expect(names).toEqual(['paper.store.v1.json'])
  })

  it('leaves the previous bytes intact when the write fails, and clears the temporary', async () => {
    const root = await freshRoot()
    const fs = nodeTextFs(root)
    await fs.write('paper.store.v1.json', '{"kept":true}')
    /* THE DIRECTORY IS MADE UNWRITABLE, so the temporary cannot be created at
     * all. This used to squat the temp path with a directory of the same
     * name — which worked only while every write shared one `.writing`
     * filename, and that sharing was the defect: two writers clobbered each
     * other's bytes and one rename published the other's content. The temp
     * name is private per write now, so the failure has to be induced
     * somewhere both writers would meet it. */
    await chmod(root, 0o555)
    await expect(fs.write('paper.store.v1.json', '{"lost":true}')).rejects.toThrow()
    await chmod(root, 0o755)
    expect(await fs.read('paper.store.v1.json')).toBe('{"kept":true}')
    expect((await nodeIndexFs(root).readDir('')).map((one) => one.name)).toEqual(['paper.store.v1.json'])
  })

  /* THE CASE THE TEST ABOVE CANNOT REACH.
   *
   * An unwritable directory fails BEFORE the temporary exists, so "no leftover
   * temporary" is true there whether the cleanup runs or not — a check that
   * cannot fail. Here the temporary is written and the RENAME is what fails,
   * which is the only arrangement in which the `catch`'s `rm` is load-bearing.
   * A leaked temp per failed write fills a reader's library with debris that
   * nothing ever collects. */
  it('clears the temporary when the publish fails after it was written', async () => {
    const root = await freshRoot()
    const fs = nodeTextFs(root)
    /* A NON-EMPTY DIRECTORY in the store's place: `rename` onto it cannot
     * succeed, and the write has already reached disk by then. */
    await nodeIndexFs(root).mkdir('paper.store.v1.json')
    await nodeIndexFs(root).writeFile('paper.store.v1.json/occupied', bytes('x'))
    await expect(fs.write('paper.store.v1.json', '{"doomed":true}')).rejects.toThrow()
    const names = (await nodeIndexFs(root).readDir('')).map((one) => one.name)
    expect(names).toEqual(['paper.store.v1.json'])
  })

  it('moves a damaged store aside', async () => {
    const root = await freshRoot()
    const fs = nodeTextFs(root)
    await writeFile(join(root, 'paper.store.v1.json'), 'not json')
    await fs.quarantine?.('paper.store.v1.json', 'paper.store.v1.json.corrupt')
    expect(await fs.read('paper.store.v1.json')).toBeNull()
    expect(await readFile(join(root, 'paper.store.v1.json.corrupt'), 'utf8')).toBe('not json')
  })
})

describe('nodeSizePort', () => {
  it('measures a book’s content file and the library whole', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('books/aaa')
    await fs.writeFile('books/aaa/content.epub', bytes('twelve bytes'))
    await fs.writeFile('index.json', bytes('{}'))
    const port = nodeSizePort(root)
    expect(await port.contentBytes('aaa')).toBe(12)
    expect(await port.contentBytes('nobody')).toBeNull()
    expect(await port.libraryBytes()).toBe(14)
  })

  it('answers null for a book with no bytes, rather than zero', async () => {
    const root = await freshRoot()
    await nodeIndexFs(root).mkdir('books/aaa')
    expect(await nodeSizePort(root).contentBytes('aaa')).toBeNull()
  })

  /* EVERY FORMAT THE SHELF STORES, not the one that happens to be first.
   *
   * `contentBytes` walks `CONTENT_EXTENSIONS`, and exercising it with an epub
   * alone would pass for an implementation that only ever looked for an epub —
   * so a reader's Kindle or comic library would report no size at all, and the
   * storage pane would show a library that isn't there. Driven off the shared
   * list, so a format added to the kernel is measured here without this file
   * being touched. */
  it('measures every content format the kernel declares', async () => {
    expect(CONTENT_EXTENSIONS.length).toBeGreaterThan(1)
    for (const [index, ext] of CONTENT_EXTENSIONS.entries()) {
      const root = await freshRoot()
      const fs = nodeIndexFs(root)
      const body = 'b'.repeat(index + 1)
      await fs.mkdir('books/aaa')
      await fs.writeFile(`books/aaa/content.${ext}`, bytes(body))
      expect(await nodeSizePort(root).contentBytes('aaa')).toBe(body.length)
    }
  })

  /* A DIRECTORY IS NOT A FILE. `content.epub/` — an interrupted unpack, or a
   * bundle format written by hand — must not be reported as a size, and
   * `stat` answers happily for one. */
  it('answers null when the content path is a directory', async () => {
    const root = await freshRoot()
    await nodeIndexFs(root).mkdir('books/aaa/content.epub')
    expect(await nodeSizePort(root).contentBytes('aaa')).toBeNull()
  })

  /* A PARTIAL TOTAL IS NOT AN EXACT ONE. The whole point of `null` in this
   * port is "nobody can say", and a number that is quietly short is worse
   * than no number — a reader would believe their library is smaller than it
   * is. */
  it('answers null when any part of the walk could not be read', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('books/aaa')
    await fs.writeFile('books/aaa/content.epub', bytes('bytes'))
    await fs.mkdir('books/locked')
    /* UNGUARDED BEFORE: as root, or on Windows, the chmod changed nothing and
     * `libraryBytes()` answered a perfectly good number — so the assertion
     * below passed while proving the opposite of what it says. */
    if (!(await denyAccess(join(root, 'books/locked'), 'directory'))) return
    try {
      expect(await nodeSizePort(root).libraryBytes()).toBeNull()
    } finally {
      await chmod(join(root, 'books/locked'), 0o755)
    }
  })
})

describe('makeDataDir', () => {
  it('creates the directory and answers with the resolved path', async () => {
    const root = await freshRoot()
    const nested = join(root, 'deep', 'library')
    expect(await makeDataDir(nested)).toBe(resolve(nested))
    expect(await nodeIndexFs(nested).readDir('')).toEqual([])
  })
})

/**
 * THE WINDOWS CROSS-DRIVE ESCAPE, provable on a Mac.
 *
 * `under()` runs on the platform's `path`, so the dangerous input cannot be
 * constructed here — POSIX has no drive-relative paths. What CAN be shown is
 * the shape of the danger, using `path.win32` directly: a drive-relative
 * path is not absolute, and `relative()` between two drives answers with an
 * absolute path that begins with neither `..` nor the root. Any containment
 * test that checks only those two things accepts it.
 *
 * This is why `under()` rejects an absolute `rel` unconditionally rather than
 * behind a platform check — a guard that only runs where it was written is
 * how the hole survived in the first place.
 */
describe('the containment rule, against Windows path semantics', () => {
  it('a drive-relative path is not absolute, and escapes across drives', () => {
    expect(win32.isAbsolute('D:outside')).toBe(false)
    const full = win32.resolve('C:\\data\\library', 'D:outside')
    const rel = win32.relative('C:\\data\\library', full)
    /* The old rule — reject only `..` and `..\` — would have let this pass. */
    expect(rel === '..' || rel.startsWith(`..${win32.sep}`)).toBe(false)
    /* The rule `under()` uses now catches it. */
    expect(win32.isAbsolute(rel)).toBe(true)
  })
})

/**
 * `appPresence` decides whether `paper` may open the sync journal, so an
 * answer of `absent` when the app is live puts a second writer on
 * `journal.jsonl`. Three answers rather than two: everything it cannot decide
 * is `unknown`, and the caller treats that as `running`.
 */
describe('appPresence', () => {
  it('answers one of the three, and never throws, whatever the platform', async () => {
    await expect(appPresence()).resolves.toMatch(/^(running|absent|unknown)$/)
  })

  /* THE DIRECTION THAT MATTERS. A platform it cannot probe must never answer
   * `absent`, because `absent` is the only answer that unlocks journalling. */
  it('never answers `absent` on a platform it cannot probe', async () => {
    if (process.platform === 'darwin') return
    await expect(appPresence()).resolves.toBe('unknown')
  })

  it('is false when no Paper bundle is running', async () => {
    /* Nothing in a test environment runs `Paper.app/Contents/MacOS/`. If this
     * ever fails on a developer's machine it is because their own Paper is
     * open — which is exactly the state the CLI must detect, so the failure
     * would be the function working. */
    const running = (await appPresence()) === 'running'
    if (running) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { stdout } = await promisify(execFile)('pgrep', ['-f', 'Paper.app/Contents/MacOS/'])
      expect(stdout.trim()).not.toBe('')
    } else {
      expect(running).toBe(false)
    }
  })
})

/* `rename` REPLACES its destination, so quarantining twice to the same
 * `.corrupt` name destroyed the earlier copy — the one holding whatever the
 * reader might still have recovered. The point of moving a damaged file aside
 * is that it is still there. */
describe('repeated quarantine', () => {
  it('keeps the earlier copy instead of overwriting it', async () => {
    const root = await freshRoot()
    const fs = nodeTextFs(root)

    await writeFile(join(root, 'paper.store.v1.json'), 'first damage')
    await fs.quarantine?.('paper.store.v1.json', 'paper.store.v1.json.corrupt')
    await writeFile(join(root, 'paper.store.v1.json'), 'second damage')
    await fs.quarantine?.('paper.store.v1.json', 'paper.store.v1.json.corrupt')

    /* The first one still holds what it held. */
    expect(await readFile(join(root, 'paper.store.v1.json.corrupt'), 'utf8')).toBe('first damage')
    /* And the second is beside it rather than on top of it. */
    expect(await readFile(join(root, 'paper.store.v1.json.corrupt.1'), 'utf8')).toBe('second damage')
  })
})

/* A folder is not supposed to hold two content files, but it can. When
 * `contentBytes` chose by `CONTENT_EXTENSIONS` order and `content.locate`
 * chose alphabetically, one answer named `azw3` and carried the epub's byte
 * count — two fields describing two different files, in one answer about one
 * book. */
describe('a folder holding two content files', () => {
  it('measures the one CONTENT_EXTENSIONS prefers, not the alphabetically first', async () => {
    const root = await freshRoot()
    const fs = nodeIndexFs(root)
    await fs.mkdir('books/book_two')
    /* `azw3` sorts before `epub`; `epub` comes first in the preference list. */
    await fs.writeFile('books/book_two/content.azw3', new Uint8Array(11))
    await fs.writeFile('books/book_two/content.epub', new Uint8Array(22))
    expect(await nodeSizePort(root).contentBytes('book_two')).toBe(22)
  })
})
