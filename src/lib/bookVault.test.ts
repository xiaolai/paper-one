import { describe, expect, it } from 'vitest'
import {
  BOOKS_DIR,
  disownBook,
  extensionFor,
  ownBook,
  ownsBook,
  readOwnedBook,
  vaultPath,
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
    expect(vaultPath('book:abc', 'evil../../../secrets')).toBe(`${BOOKS_DIR}/book_abc.bin`)
  })

  it('refuses an unknown extension rather than trusting it', () => {
    expect(extensionFor('payload.sh')).toBe('bin')
  })
})

describe('vaultPath', () => {
  it('names a copy by the content hash', () => {
    expect(vaultPath('book:abc123', 'Moby.epub')).toBe(`${BOOKS_DIR}/book_abc123.epub`)
  })

  /* `bookIdFor` produces `book:` plus hex, so this changes nothing in practice.
   * It is here because the id also comes back off a stored row, and a path
   * segment built from one must not be able to contain a slash whatever it
   * says. */
  it('cannot be made to escape by a hostile id', () => {
    expect(vaultPath('../../etc/passwd', 'x.epub')).toBe(`${BOOKS_DIR}/______etc_passwd.epub`)
  })
})

describe('ownBook', () => {
  it('copies the bytes in and reports where they landed', async () => {
    const fs = fakeFs()
    const entry = await ownBook(fs, 'book:a', 'Moby.epub', bytes('WHALE'))
    expect(entry.path).toBe(`${BOOKS_DIR}/book_a.epub`)
    expect(fs.files.get(entry.path)).toEqual(bytes('WHALE'))
  })

  it('creates the directory', async () => {
    const fs = fakeFs()
    await ownBook(fs, 'book:a', 'Moby.epub', bytes('WHALE'))
    expect(fs.dirs.has(BOOKS_DIR)).toBe(true)
  })

  /**
   * Duplicate refusal, and it is structural rather than a check.
   *
   * The destination is derived from the content hash, so a book Paper already
   * owns has nowhere else to go. Bulk import does not implement this; it only
   * surfaces it.
   */
  it('writes nothing when the same book is added twice', async () => {
    const fs = fakeFs()
    await ownBook(fs, 'book:a', 'Moby.epub', bytes('WHALE'))
    let writes = 0
    const counted: VaultFs = { ...fs, writeFile: async (p, b) => { writes += 1; await fs.writeFile(p, b) } }
    await ownBook(counted, 'book:a', 'Moby.epub', bytes('WHALE'))
    expect(writes).toBe(0)
  })

  /**
   * A truncated file at the real path would be treated as the book forever and
   * fail to parse with no clue why — so an interrupted write must not leave one.
   *
   * The failure is injected at the TEMPORARY path now, which is where the bytes
   * actually go: the first version of `ownBook` wrote the temp file and then
   * wrote the bytes again to the real path, so this case could only be provoked
   * by failing the second write. The rename replaced it, and this case had to
   * follow the bytes.
   */
  it('leaves no file at the real path when the write fails', async () => {
    const fs = fakeFs()
    const path = vaultPath('book:a', 'Moby.epub')
    fs.failWrite = `${path}.writing`
    await expect(ownBook(fs, 'book:a', 'Moby.epub', bytes('WHALE'))).rejects.toThrow('disk full')
    expect(fs.files.has(path)).toBe(false)
    expect(fs.files.has(`${path}.writing`)).toBe(false)
  })

  /* The rename is what makes it atomic, and the absence of one is exactly what
   * the audit found: the bytes must reach the real path by being MOVED there. */
  it('moves the temporary file into place rather than writing twice', async () => {
    const fs = fakeFs()
    let writes = 0
    const counted: VaultFs = {
      ...fs,
      writeFile: async (p, b) => {
        writes += 1
        await fs.writeFile(p, b)
      },
    }
    await ownBook(counted, 'book:a', 'Moby.epub', bytes('WHALE'))
    expect(writes).toBe(1)
  })

  /* `created` is how a duplicate is known. The byte count cannot say — it is the
   * input's length whether the file was written or reused. */
  it('reports whether it actually wrote', async () => {
    const fs = fakeFs()
    expect((await ownBook(fs, 'book:a', 'Moby.epub', bytes('WHALE'))).created).toBe(true)
    expect((await ownBook(fs, 'book:a', 'Moby.epub', bytes('WHALE'))).created).toBe(false)
  })

  it('cleans up its temporary neighbour', async () => {
    const fs = fakeFs()
    const entry = await ownBook(fs, 'book:a', 'Moby.epub', bytes('WHALE'))
    expect(fs.files.has(`${entry.path}.writing`)).toBe(false)
  })
})

describe('readOwnedBook', () => {
  /* The ORIGINAL name, not the vault's. The vault names by hash so copies
   * cannot collide; the reader routes on the extension and shows the name when
   * a book declares no title, and neither wants a hash. */
  it('returns a File carrying the name the book arrived with', async () => {
    const path = vaultPath('book:a', 'Moby.epub')
    const fs = fakeFs({ [path]: bytes('WHALE') })
    const file = await readOwnedBook(fs, path, 'Moby-Dick.epub')
    expect(file.name).toBe('Moby-Dick.epub')
    expect(await file.text()).toBe('WHALE')
  })
})

describe('ownsBook and disownBook', () => {
  it('reports whether a copy is held', async () => {
    const path = vaultPath('book:a', 'x.epub')
    const fs = fakeFs({ [path]: bytes('X') })
    expect(await ownsBook(fs, path)).toBe(true)
    expect(await ownsBook(fs, 'books/absent.epub')).toBe(false)
  })

  it('gives up the copy', async () => {
    const path = vaultPath('book:a', 'x.epub')
    const fs = fakeFs({ [path]: bytes('X') })
    await disownBook(fs, path)
    expect(fs.files.has(path)).toBe(false)
  })

  /* Forgetting a book twice, or one whose copy never landed, is not a failure
   * worth surfacing to someone who asked for it to be gone. */
  it('resolves when there was nothing to remove', async () => {
    const fs = fakeFs()
    await expect(disownBook(fs, 'books/absent.epub')).resolves.toBeUndefined()
  })
})
