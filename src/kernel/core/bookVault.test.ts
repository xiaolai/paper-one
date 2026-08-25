import { describe, expect, it } from 'vitest'
import { BOOKS_DIR, contentPathIn } from './bookFolder'
import {
  extensionFor,
  readOwnedBook,
  readRangeOf,
  type VaultFs,
} from './bookVault'

/**
 * The vault, without Tauri.
 *
 * What can be asserted here is everything except the plugin call itself: path
 * derivation, the closed extension list, idempotence, and that a partial write
 * cannot be mistaken for a book. What CANNOT is whether the capability actually
 * permits the write — phase 2 shipped a grant naming the binary permissions
 * while the code called the text ones, with every automated check green. That
 * one needs the app.
 */

function fakeFs(seed: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(seed))
  const dirs = new Set<string>()
  const fs: VaultFs & { files: Map<string, Uint8Array>; dirs: Set<string>; failWrite?: string } = {
    files,
    dirs,
    readFile: async (path) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`no such file: ${path}`)
      return bytes
    },
    writeFile: async (path, bytes) => {
      if (fs.failWrite === path) throw new Error('disk full')
      files.set(path, bytes)
    },
    exists: async (path) => files.has(path),
    mkdir: async (path) => void dirs.add(path),
    remove: async (path) => void files.delete(path),
    removeDir: async (path: string) => {
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key)
      }
    },
    rename: async (from, to) => {
      const bytes = files.get(from)
      if (bytes) files.set(to, bytes)
      files.delete(from)
    },
  }
  return fs
}

const bytes = (text: string) => new TextEncoder().encode(text)

describe('extensionFor', () => {
  it('keeps a known extension, lowercased', () => {
    expect(extensionFor('Moby-Dick.EPUB')).toBe('epub')
  })

  it('falls back for a name with no extension', () => {
    expect(extensionFor('Moby-Dick')).toBe('bin')
  })

  /**
   * The reason the list is closed rather than sanitised.
   *
   * The extension comes off a filename the reader did not write, and it is
   * interpolated into a path. Splitting on a dot and taking the last segment is
   * the obvious implementation and it walks straight out of the vault — which
   * `$APPDATA/**` would then happily permit on the way past.
   */
  it('refuses an extension that would leave the directory', () => {
    expect(extensionFor('book../../../../etc/passwd')).toBe('bin')
    expect(contentPathIn('book:abc', 'evil../../../secrets')).toBe(`${BOOKS_DIR}/book_abc/content.bin`)
  })

  it('refuses an unknown extension rather than trusting it', () => {
    expect(extensionFor('payload.sh')).toBe('bin')
  })
})


describe('readOwnedBook', () => {
  /* The ORIGINAL name, not the vault's. The vault names by hash so copies
   * cannot collide; the reader routes on the extension and shows the name when
   * a book declares no title, and neither wants a hash. */
  it('returns a File carrying the name the book arrived with', async () => {
    const path = contentPathIn('book:a', 'Moby.epub')
    const fs = fakeFs({ [path]: bytes('WHALE') })
    const file = await readOwnedBook(fs, path, 'Moby-Dick.epub')
    expect(file.name).toBe('Moby-Dick.epub')
    expect(await file.text()).toBe('WHALE')
  })
})

describe('readRangeOf', () => {
  const WHOLE = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

  /** A filesystem with no ranged read — the fallback path. */
  const sliceOnly = {
    readFile: async () => WHOLE,
  } as unknown as VaultFs

  /** One that has it, and records what it was asked for. */
  function ranged() {
    const asked: { offset: number; length: number }[] = []
    const fs = {
      readFile: async () => {
        throw new Error('readFile must not be reached when readRange exists')
      },
      readRange: async (_path: string, offset: number, length: number) => {
        asked.push({ offset, length })
        return WHOLE.slice(offset, offset + length)
      },
    } as unknown as VaultFs
    return { fs, asked }
  }

  it('prefers a real ranged read and never reads the whole file', async () => {
    /* THE WHOLE POINT of the seam. `content.read` serves a book a slice at a
       time; falling back per slice is O(n²) over the book, and a 300 MB scanned
       PDF would be re-read once per megabyte served. The fake's `readFile`
       throws so a regression cannot pass quietly. */
    const { fs, asked } = ranged()
    expect(await readRangeOf(fs, 'x', 3, 4)).toEqual(new Uint8Array([3, 4, 5, 6]))
    expect(asked).toEqual([{ offset: 3, length: 4 }])
  })

  it('falls back to reading and slicing when there is no ranged read', async () => {
    expect(await readRangeOf(sliceOnly, 'x', 2, 3)).toEqual(new Uint8Array([2, 3, 4]))
  })

  it('answers fewer bytes at the end of the file, not an error', async () => {
    /* The POSIX contract, and the one a caller assembling a stream already has
       to handle: a short answer means "that is all there was". */
    expect(await readRangeOf(sliceOnly, 'x', 8, 100)).toEqual(new Uint8Array([8, 9]))
  })

  it('answers nothing past the end', async () => {
    expect(await readRangeOf(sliceOnly, 'x', 50, 10)).toEqual(new Uint8Array(0))
  })

  it('answers nothing for a zero length, without touching the file', async () => {
    const never = {
      readFile: async () => {
        throw new Error('should not read for a zero-length slice')
      },
    } as unknown as VaultFs
    expect(await readRangeOf(never, 'x', 0, 0)).toEqual(new Uint8Array(0))
  })

  it('refuses a negative offset or length rather than guessing', async () => {
    /* `slice` treats a negative index as counting from the END, so a negative
       offset would quietly answer bytes from the wrong part of the book. */
    await expect(readRangeOf(sliceOnly, 'x', -1, 4)).rejects.toThrow(/must not be negative/)
    await expect(readRangeOf(sliceOnly, 'x', 0, -4)).rejects.toThrow(/must not be negative/)
  })

  it('does not keep the whole file alive behind one slice', async () => {
    /* `subarray` shares the buffer: holding one chunk of a 300 MB book would
       hold all 300 MB. `slice` copies. */
    const got = await readRangeOf(sliceOnly, 'x', 2, 2)
    expect(got.buffer.byteLength).toBe(2)
  })
})
