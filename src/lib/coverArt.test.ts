import { describe, expect, it } from 'vitest'
import type { VaultFs } from './bookVault'
import {
  COVERS_DIR,
  COVER_WIDTH,
  coverPath,
  downscaleCover,
  saveCover,
  scaledTo,
  type ImageOps,
} from './coverArt'

/**
 * Covers, without a webview.
 *
 * `createImageBitmap` and `OffscreenCanvas` exist only in a browser, so they sit
 * behind `ImageOps` and everything above the decode is asserted here: whether a
 * cover is fetched at all, what a book with no jacket does, what a corrupt image
 * does, and that the bitmap is released. Whether a real JPEG comes out the far
 * side needs the app.
 */

function fakeFs() {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const fs: VaultFs & { files: Map<string, Uint8Array>; dirs: Set<string> } = {
    files,
    dirs,
    readFile: async (path) => files.get(path) ?? Promise.reject(new Error('missing')),
    writeFile: async (path, bytes) => void files.set(path, bytes),
    exists: async (path) => files.has(path),
    mkdir: async (path) => void dirs.add(path),
    remove: async (path) => void files.delete(path),
  }
  return fs
}

/** Records what it was asked to do, and whether the bitmap was released. */
function fakeOps(over: { width?: number; height?: number; fail?: boolean } = {}) {
  const seen: { width: number; height: number }[] = []
  let closed = 0
  const ops: ImageOps = {
    decode: async (blob) => {
      if (over.fail) throw new Error('not an image')
      void blob
      return {
        width: over.width ?? 1600,
        height: over.height ?? 2400,
        close: () => {
          closed += 1
        },
      }
    },
    encode: async (_source, width, height) => {
      seen.push({ width, height })
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    },
  }
  return { ops, seen, closed: () => closed }
}

const jacket = () => new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' })

describe('coverPath', () => {
  it('files a jacket under the book id', () => {
    expect(coverPath('book:abc')).toBe(`${COVERS_DIR}/book_abc.jpg`)
  })

  /* The id comes back off a stored row, so a path segment built from one must
   * not be able to contain a slash whatever it says. */
  it('cannot be made to escape the directory', () => {
    expect(coverPath('../../etc/passwd')).toBe(`${COVERS_DIR}/______etc_passwd.jpg`)
  })
})

describe('scaledTo', () => {
  it('shrinks a publisher-sized jacket to shelf size, keeping the ratio', () => {
    expect(scaledTo(1600, 2400)).toEqual({ width: COVER_WIDTH, height: 600 })
  })

  /* A small cover blown up costs bytes and adds nothing — a 60px jacket should
   * stay 60px rather than become a 400px-wide blur. */
  it('never enlarges a jacket that is already small', () => {
    expect(scaledTo(60, 90)).toEqual({ width: 60, height: 90 })
  })

  it('never produces a zero dimension', () => {
    expect(scaledTo(1000, 1).height).toBeGreaterThanOrEqual(1)
  })
})

describe('downscaleCover', () => {
  it('encodes at the scaled size', async () => {
    const { ops, seen } = fakeOps({ width: 1600, height: 2400 })
    await downscaleCover(jacket(), ops)
    expect(seen).toEqual([{ width: COVER_WIDTH, height: 600 }])
  })

  /* `ImageBitmap` holds decoded pixels outside the JS heap and is not collected
   * on its own. Importing a folder without this leaks the whole library's
   * artwork. */
  it('releases the decoded bitmap', async () => {
    const { ops, closed } = fakeOps()
    await downscaleCover(jacket(), ops)
    expect(closed()).toBe(1)
  })

  /* A book with a corrupt cover is a book that opens fine and has no picture.
   * Failing the open over one would be the wrong trade by a wide margin. */
  it('returns null for an image that will not decode, rather than throwing', async () => {
    const { ops } = fakeOps({ fail: true })
    await expect(downscaleCover(jacket(), ops)).resolves.toBeNull()
  })
})

describe('saveCover', () => {
  it('writes the jacket and reports where it landed', async () => {
    const fs = fakeFs()
    const { ops } = fakeOps()
    const path = await saveCover(fs, 'book:a', { getCover: async () => jacket() }, ops)
    expect(path).toBe(`${COVERS_DIR}/book_a.jpg`)
    expect(fs.files.has(`${COVERS_DIR}/book_a.jpg`)).toBe(true)
    expect(fs.dirs.has(COVERS_DIR)).toBe(true)
  })

  /* Most PDFs, and the case the derived tint exists for. */
  it('reports nothing for a book that declares no cover', async () => {
    const fs = fakeFs()
    const { ops } = fakeOps()
    expect(await saveCover(fs, 'book:a', {}, ops)).toBeNull()
    expect(await saveCover(fs, 'book:a', { getCover: async () => null }, ops)).toBeNull()
    expect(fs.files.size).toBe(0)
  })

  it('reports nothing for an empty cover blob', async () => {
    const fs = fakeFs()
    const { ops } = fakeOps()
    const empty = new Blob([], { type: 'image/png' })
    expect(await saveCover(fs, 'book:a', { getCover: async () => empty }, ops)).toBeNull()
  })

  /* foliate's own extractor can throw on a malformed package. That is a book
   * without a picture, not a book that failed to open. */
  it('survives getCover throwing', async () => {
    const fs = fakeFs()
    const { ops } = fakeOps()
    const book = {
      getCover: () => Promise.reject(new Error('bad manifest')),
    }
    await expect(saveCover(fs, 'book:a', book, ops)).resolves.toBeNull()
  })
})
