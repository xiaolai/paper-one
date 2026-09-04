import { describe, expect, it, vi } from 'vitest'
import { atomicWrite } from './bookFolder'
import { scopeFs } from './registry'
import type { KernelServices } from './services'

/**
 * A capability's view of the filesystem — WI-10.3's scope, and the two
 * reviewed shapes outside it that WI-23 found it refusing.
 *
 * ⚠️ **THE CIRCLE WROTE UNDER `books/<id>/` AND THE SCOPE REFUSED IT.** Every
 * write the circle capability makes lands in a book's folder — a friend's
 * passages beside the marks, the publisher's own store beside them — and the
 * footprint review allowed exactly those two shapes. The wrapper did not know
 * the review existed, so the first production write of the transport would
 * have been a namespace error. These tests hold the two together.
 */

const bytes = new Uint8Array([1])

function rawFs() {
  const fs = {
    readFile: vi.fn(async () => bytes),
    readDir: vi.fn(async () => []),
    exists: vi.fn(async () => true),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    removeDir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    writeAtomic: vi.fn(async () => {}),
  }
  return fs as unknown as NonNullable<KernelServices['fs']> & typeof fs
}

describe('the circle’s two reviewed write shapes', () => {
  const OK = ['books/book_abc/circle/aa11bb22.json', 'books/book_abc/shared.json', 'books/book_abc/shared.json.writing', 'circle/aa11/shelf.json']
  const NOT = [
    'books/book_abc/marks.json',
    'books/book_abc/book.json',
    'books/book_abc/circle/a/b.json',
    'books/book_abc/circle/../marks.json',
    'books/../books/book_abc/shared.json.bak',
    'sync/journal.jsonl',
    'trash/book_abc/shared.json',
  ]

  it('lets the circle write, atomically and otherwise, exactly the paths its footprint review names', async () => {
    const fs = rawFs()
    const scoped = scopeFs(fs, 'circle')!
    for (const path of OK) {
      await expect(scoped.writeFile(path, bytes)).resolves.toBeUndefined()
      await expect(scoped.writeAtomic!(path, bytes, 'full')).resolves.toBeUndefined()
      await expect(scoped.remove(path)).resolves.toBeUndefined()
    }
    expect(fs.writeAtomic).toHaveBeenCalledTimes(OK.length)
  })

  it('refuses the circle everything else under books/, and refuses every other capability the circle’s shapes', async () => {
    const scoped = scopeFs(rawFs(), 'circle')!
    for (const path of NOT) {
      await expect(scoped.writeFile(path, bytes)).rejects.toThrow(/may only writeFile under "circle\/"/u)
      await expect(scoped.writeAtomic!(path, bytes, 'full')).rejects.toThrow(/may only writeAtomic/u)
    }
    const sync = scopeFs(rawFs(), 'sync')!
    for (const path of OK.slice(0, 3)) {
      await expect(sync.writeFile(path, bytes)).rejects.toThrow(/may only writeFile under "sync\/"/u)
    }
  })

  /* THE FALLBACK PATH, which every filesystem without `writeAtomic` takes —
     the fake one every test runs on among them. `atomicWrite` makes the
     file's parent first, and one review for every operation refused that
     `mkdir` while allowing the file inside it, so both reviewed shapes failed
     on exactly the platforms that fall back. The review is per operation:
     the two parents may be made, and nothing else outside the namespace may
     be made or taken down. */
  it('lets atomicWrite’s fallback make the reviewed files’ parents, and refuses any other mkdir or removeDir', async () => {
    const raw = rawFs()
    const { writeAtomic: _none, ...withoutAtomic } = raw
    const scoped = scopeFs(withoutAtomic as unknown as NonNullable<KernelServices['fs']>, 'circle')!
    expect(scoped.writeAtomic).toBeUndefined()
    await expect(atomicWrite(scoped, 'books/book_abc/circle/aa11bb22.json', bytes)).resolves.toBeUndefined()
    await expect(atomicWrite(scoped, 'books/book_abc/shared.json', bytes)).resolves.toBeUndefined()
    expect((raw.mkdir.mock.calls as readonly (readonly unknown[])[]).map((call) => call[0])).toEqual(['books/book_abc/circle', 'books/book_abc'])
    expect(raw.rename).toHaveBeenCalledTimes(2)
    await expect(scoped.mkdir('books/book_abc/marks')).rejects.toThrow(/may only mkdir under "circle\/"/u)
    await expect(scoped.mkdir('books/book_abc/shared.json')).rejects.toThrow(/may only mkdir/u)
    await expect(scoped.removeDir('books/book_abc')).rejects.toThrow(/may only removeDir under "circle\/"/u)
    await expect(scoped.removeDir('books/book_abc/circle')).rejects.toThrow(/may only removeDir/u)
    const sync = scopeFs(withoutAtomic as unknown as NonNullable<KernelServices['fs']>, 'sync')!
    await expect(sync.mkdir('books/book_abc')).rejects.toThrow(/may only mkdir under "sync\/"/u)
  })

  it('still lets every capability write under its own namespace, and read anywhere', async () => {
    const fs = rawFs()
    const scoped = scopeFs(fs, 'sync')!
    await expect(scoped.writeAtomic!('sync/journal.jsonl', bytes, 'full')).resolves.toBeUndefined()
    await expect(scoped.mkdir('sync')).resolves.toBeUndefined()
    await expect(scoped.readFile('books/book_abc/book.json')).resolves.toBe(bytes)
    expect(fs.writeAtomic).toHaveBeenCalledWith('sync/journal.jsonl', bytes, 'full')
  })

  it('offers writeAtomic on the wrapper exactly when the platform has it', () => {
    const fs = rawFs()
    expect(scopeFs(fs, 'circle')!.writeAtomic).toBeDefined()
    const { writeAtomic: _none, ...without } = fs
    expect(scopeFs(without as unknown as NonNullable<KernelServices['fs']>, 'circle')!.writeAtomic).toBeUndefined()
  })
})

describe('the reviewed shapes, edge by edge', () => {
  it('refuses a reviewed shape with anything before or after it, and a path that climbs out', async () => {
    const fs = rawFs()
    const scoped = scopeFs(fs, 'circle')!
    for (const path of ['x/books/b/circle/p.json', 'books/b/circle/p.json.bak', 'books/b/shared.json.bak', 'x/books/b/shared.json', '../books/b/shared.json']) {
      await expect(scoped.writeAtomic!(path, bytes, 'full')).rejects.toThrow(/may only writeAtomic/u)
    }
    expect(fs.writeAtomic).not.toHaveBeenCalled()
  })

  it('guards appendFile exactly as it guards the rest, and offers it only when the platform has it', async () => {
    const appendFile = vi.fn(async () => {})
    const fs = { ...rawFs(), appendFile } as unknown as NonNullable<KernelServices['fs']> & { appendFile: typeof appendFile }
    const scoped = scopeFs(fs, 'circle')!
    await expect(scoped.appendFile!('books/b/circle/p.json', bytes)).resolves.toBeUndefined()
    expect(appendFile).toHaveBeenCalledWith('books/b/circle/p.json', bytes)
    await expect(scoped.appendFile!('books/b/marks.json', bytes)).rejects.toThrow(/may only appendFile/u)
    expect(scopeFs(rawFs(), 'circle')!.appendFile).toBeUndefined()
  })
})
