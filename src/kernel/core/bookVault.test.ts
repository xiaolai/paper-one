import { describe, expect, it } from 'vitest'
import { BOOKS_DIR, contentPathIn } from './bookFolder'
import {
  extensionFor,
  readOwnedBook,
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

