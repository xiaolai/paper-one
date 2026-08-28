import { describe, expect, it, vi } from 'vitest'
import { MIGRATED_KEYS, STORE_FILE, openFileStore, type FileSystem } from './fileStore'

/** An in-memory filesystem with the failures a real one has. */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  let failWrites = false
  const fs: FileSystem = {
    quarantine: (path, to) => {
      const value = files.get(path)
      if (value === undefined) return Promise.reject(new Error('no such file'))
      files.delete(path)
      files.set(to, value)
      return Promise.resolve()
    },
    read: (path) => Promise.resolve(files.get(path) ?? null),
    write: (path, text) => {
      if (failWrites) return Promise.reject(new Error('disk full'))
      writes.push(text)
      files.set(path, text)
      return Promise.resolve()
    },
  }
  return {
    fs,
    files,
    writes,
    fail: (on: boolean) => {
      failWrites = on
    },
  }
}

/** A localStorage stand-in holding what a reader upgraded with. */
function legacyStore(entries: Record<string, string>) {
  return {
    getItem: (key: string) => entries[key] ?? null,
    setItem: () => {},
  }
}

const MARKS = '[{"id":"m1"}]'
const CARDS = '[{"id":"c1"}]'

describe('openFileStore', () => {
  it('serves reads from the file it loaded', async () => {
    const { fs } = fakeFs({ [STORE_FILE]: JSON.stringify({ 'paper.marks.v1': MARKS }) })
    const store = await openFileStore({ fs })
    expect(store.getItem('paper.marks.v1')).toBe(MARKS)
    expect(store.getItem('paper.cards.v1')).toBeNull()
  })

  it('writes what was set, and reads it back before the flush lands', async () => {
    const { fs } = fakeFs()
    const store = await openFileStore({ fs })
    store.setItem('paper.marks.v1', MARKS)
    // Synchronous read-back is the contract the card and settings stores
    // depend on: they read once when built, before anything renders.
    expect(store.getItem('paper.marks.v1')).toBe(MARKS)
    await store.flush()
    expect(JSON.parse(await readBack(fs))).toEqual({ 'paper.marks.v1': MARKS })
  })

  it('coalesces a burst into one write', async () => {
    const { fs, writes } = fakeFs()
    const store = await openFileStore({ fs })
    // A page turn writes a position, and so does the next one.
    for (let i = 0; i < 20; i++) store.setItem('paper.library.v1', `[${i}]`)
    await store.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('[19]')
  })
})

describe('the migration from localStorage', () => {
  it('inherits every key on a first run', async () => {
    const { fs } = fakeFs()
    const store = await openFileStore({
      fs,
      legacy: legacyStore({ 'paper.marks.v1': MARKS, 'paper.cards.v1': CARDS }),
    })
    expect(store.migrated).toBe(true)
    expect(store.getItem('paper.marks.v1')).toBe(MARKS)
    expect(store.getItem('paper.cards.v1')).toBe(CARDS)
    // Written straight away: a reader who upgrades and never marks anything
    // again should still have the file.
    expect(JSON.parse(await readBack(fs))['paper.marks.v1']).toBe(MARKS)
  })

  it('knows every key it is responsible for', () => {
    expect([...MIGRATED_KEYS]).toEqual([
      'paper.marks.v1',
      'paper.cards.v1',
      'paper.library.v1',
    ])
  })

  /* The file wins once it exists. Re-reading localStorage on a later run would
   * resurrect marks the reader had since deleted. */
  it('does not migrate again once the file exists', async () => {
    const { fs } = fakeFs({ [STORE_FILE]: JSON.stringify({ 'paper.marks.v1': '[]' }) })
    const store = await openFileStore({ fs, legacy: legacyStore({ 'paper.marks.v1': MARKS }) })
    expect(store.migrated).toBe(false)
    expect(store.getItem('paper.marks.v1')).toBe('[]')
  })

  it('does nothing when there is nothing to inherit', async () => {
    const { fs, writes } = fakeFs()
    const store = await openFileStore({ fs, legacy: legacyStore({}) })
    expect(store.migrated).toBe(false)
    expect(writes).toHaveLength(0)
  })
})

describe('when the disk refuses', () => {
  /* The honest limit of a synchronous face on an asynchronous store: the write
   * cannot have failed yet when `setItem` returns, so the failure surfaces on
   * the NEXT one. One action late, rather than never. */
  it('reports a failed write on the following write', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs, fail } = fakeFs()
    const store = await openFileStore({ fs })

    fail(true)
    expect(() => store.setItem('paper.marks.v1', MARKS)).not.toThrow()
    await expect(store.flush()).rejects.toThrow('disk full')
    expect(store.healthy).toBe(false)
    expect(() => store.setItem('paper.marks.v1', CARDS)).toThrow('previous save')

    fail(false)
    await store.flush()
    expect(store.healthy).toBe(true)
    warn.mockRestore()
  })

  /* A FLUSH THAT RESOLVED OVER A WRITE THAT DID NOT HAPPEN. The queue must
     survive a bad write, so `writeNow` swallows — and the swallow reached the
     one caller that exists to confirm durability: the shutdown step and the
     CLI's close both took a resolved flush as "saved". */
  it('raises out of flush when the write did not land, and stays usable after', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs, fail, files } = fakeFs()
    const store = await openFileStore({ fs })

    fail(true)
    store.setItem('paper.marks.v1', MARKS)
    await expect(store.flush()).rejects.toThrow('disk full')
    /* Nothing on disk, and the store says so on its own account too. */
    expect(files.has(STORE_FILE)).toBe(false)
    expect(store.healthy).toBe(false)

    /* AND THE QUEUE IS NOT POISONED. Rejecting the chain itself would make
       every later write reject with the first failure for ever. */
    fail(false)
    // The set still reports the PREVIOUS failure — and still queues its write.
    expect(() => store.setItem('paper.cards.v1', CARDS)).toThrow('previous save')
    await expect(store.flush()).resolves.toBeUndefined()
    expect(JSON.parse(files.get(STORE_FILE) ?? '{}')['paper.cards.v1']).toBe(CARDS)
    warn.mockRestore()
  })

  it('still opens when the migration write is refused, rather than losing the store to it', async () => {
    /* The seeded values are in memory and still in the legacy store, so a
       refused migration write costs durability, not the application. */
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs, fail } = fakeFs()
    fail(true)
    const store = await openFileStore({ fs, legacy: legacyStore({ 'paper.marks.v1': MARKS }) })
    expect(store.migrated).toBe(true)
    expect(store.getItem('paper.marks.v1')).toBe(MARKS)
    expect(store.healthy).toBe(false)
    warn.mockRestore()
  })
})

describe('a store that will not parse', () => {
  /* This runs BEFORE React mounts. Throwing would take the whole application
   * down, so a reader with a truncated file would get no application at all
   * rather than one that has lost some marks. The bytes are kept — see the
   * next case for where they go. */
  it('reads as empty rather than throwing', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs } = fakeFs({ [STORE_FILE]: '{"paper.marks.v1": [trunca' })
    const store = await openFileStore({ fs })
    expect(store.getItem('paper.marks.v1')).toBeNull()
    warn.mockRestore()
  })

  /* And the damaged bytes SURVIVE. Left in place, the reader's next mark
   * overwrote them — the only copy of their work, destroyed by the recovery
   * path that claimed to preserve it. */
  it('moves the damaged file aside so the next write cannot destroy it', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const damaged = '{"paper.marks.v1": [trunca'
    const { fs, files } = fakeFs({ [STORE_FILE]: damaged })
    const store = await openFileStore({ fs })

    store.setItem('paper.marks.v1', MARKS)
    await store.flush()

    expect(files.get(`${STORE_FILE}.corrupt`)).toBe(damaged)
    expect(JSON.parse(files.get(STORE_FILE) ?? '{}')['paper.marks.v1']).toBe(MARKS)
    warn.mockRestore()
  })

  it('treats an entry that is not a string as damage to the whole file', async () => {
    /* It used to FILTER the bad entry and accept the remainder as healthy —
       so the next write erased the dropped key with no quarantine and no
       notice. Nothing this code writes is a non-string, so one means the
       file is not ours; the move-aside path keeps every byte. */
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs } = fakeFs({
      [STORE_FILE]: JSON.stringify({ 'paper.marks.v1': 42, 'paper.cards.v1': CARDS }),
    })
    const store = await openFileStore({ fs })
    expect(store.getItem('paper.marks.v1')).toBeNull()
    expect(store.getItem('paper.cards.v1')).toBeNull()
    expect(store.damaged).toEqual({ aside: `${STORE_FILE}.corrupt` })
    warn.mockRestore()
  })
})

async function readBack(fs: FileSystem): Promise<string> {
  return (await fs.read(STORE_FILE)) ?? ''
}

/**
 * A damaged store is ANNOUNCED, not only logged (WI-20.36). The quarantine
 * wrote a line to the console and started empty, and a reader who lost a
 * year of marks to a truncated file learned it from an empty Marginalia panel
 * with nothing to say why. The store now reports what it did so boot can
 * say it where the reader looks.
 */
describe('what the store has to say about its own file', () => {
  it('reports the damaged file it moved aside', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs } = fakeFs({ [STORE_FILE]: '{"paper.marks.v1": [trunca' })
    const store = await openFileStore({ fs })
    expect(store.damaged).toEqual({ aside: `${STORE_FILE}.corrupt` })
    warn.mockRestore()
  })

  /* ⚠️ **WHERE IT ACTUALLY WENT.** `rename` replaces its destination, so an
     implementation that must not destroy an earlier quarantine has to choose a
     neighbouring name — and the requested one is then a path nothing wrote,
     reported to the reader as the file holding their work. */
  it('reports the destination the filesystem answered with, not the one it asked for', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs, files } = fakeFs({ [STORE_FILE]: 'not json' })
    const taken = `${STORE_FILE}.corrupt`
    files.set(taken, 'an earlier corruption')
    const store = await openFileStore({
      fs: {
        ...fs,
        quarantine: async (from, to) => {
          const free = files.has(to) ? `${to}.1` : to
          await fs.quarantine!(from, free)
          return free
        },
      },
    })
    expect(store.damaged).toEqual({ aside: `${taken}.1` })
    // And the earlier quarantine is still where it was.
    expect(files.get(taken)).toBe('an earlier corruption')
    warn.mockRestore()
  })

  it('reports a damaged file it could not move, which the next write will replace', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs } = fakeFs({ [STORE_FILE]: 'not json' })
    const store = await openFileStore({ fs: { ...fs, quarantine: () => Promise.reject(new Error('EROFS')) } })
    expect(store.damaged).toEqual({ aside: null })
    warn.mockRestore()
  })

  it('reports a damaged file when this filesystem has no way to move it aside', async () => {
    /* `fs.quarantine?.()` resolved undefined, and the report claimed the
       bytes were moved to a path nothing wrote — the next write then
       overwrote the reader's only copy under a notice saying it was safe. */
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs } = fakeFs({ [STORE_FILE]: 'not json' })
    const { quarantine, ...bare } = fs
    void quarantine
    const store = await openFileStore({ fs: bare })
    expect(store.damaged).toEqual({ aside: null })
    warn.mockRestore()
  })

  it('treats one invalid entry as a damaged file, never as a healthy remainder', async () => {
    /* Filtered out, the surviving keys read as a healthy store and the next
       write erased the dropped one with no quarantine and no notice. */
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs } = fakeFs({ [STORE_FILE]: JSON.stringify({ 'paper.marks.v1': MARKS, rogue: 7 }) })
    const store = await openFileStore({ fs })
    expect(store.damaged).toEqual({ aside: `${STORE_FILE}.corrupt` })
    expect(store.getItem('paper.marks.v1')).toBeNull()
    warn.mockRestore()
  })

  it('migrates past a legacy key that throws, rather than refusing to open', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs } = fakeFs()
    const legacy = {
      getItem: (key: string) => {
        if (key === 'paper.marks.v1') throw new Error('SecurityError')
        return key === 'paper.cards.v1' ? 'kept' : null
      },
      setItem: () => {},
    }
    const store = await openFileStore({ fs, legacy })
    expect(store.getItem('paper.cards.v1')).toBe('kept')
    warn.mockRestore()
  })

  it('has nothing to say about a store that read', async () => {
    const { fs } = fakeFs({ [STORE_FILE]: JSON.stringify({ 'paper.marks.v1': MARKS }) })
    expect((await openFileStore({ fs })).damaged).toBeNull()
    const { fs: empty } = fakeFs()
    expect((await openFileStore({ fs: empty })).damaged).toBeNull()
  })
})
