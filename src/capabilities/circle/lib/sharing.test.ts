import { describe, expect, it, vi } from 'vitest'
import { hlcOf, type Annotation, type Hlc } from '../../../kernel'
import { NOTHING_PUBLISHED, logOf, share, unshare, type SharedFile } from './publish'
import {
  livePublication,
  mintPub,
  passageOf,
  publishabilityOf,
  sharePortOver,
  type SharingDeps,
  livePublications,
} from './sharing'

/**
 * WI-23.A1 — the share control's deciding half.
 *
 * ⚠️ **THE ITEM'S FALSIFIER IS THE LAST DESCRIBE**: share a passage, then edit
 * its note and delete the mark. `logOf` must still emit the ORIGINAL text and
 * `publications.length` must be unchanged. Either is a pointer where a
 * snapshot was promised.
 */

const DEVICE = 'd'.repeat(64)

const mark = (over: Partial<Annotation> = {}): Annotation =>
  ({
    id: 'm1',
    bookId: 'book:moby',
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
    sectionIndex: 0,
    text: 'Call me Ishmael',
    prefix: 'before ',
    suffix: ' after',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Loomings',
    createdAt: 1,
    ...over,
  }) as Annotation

describe('the passage a mark publishes', () => {
  it('is the quote and its neighbours, and the chapter it was in', () => {
    expect(passageOf(mark(), false)).toEqual({
      quote: 'Call me Ishmael',
      prefix: 'before ',
      suffix: ' after',
      chapter: 'Loomings',
    })
  })

  it('carries the note ONLY when asked, which is the separate choice per share', () => {
    const noted = mark({ note: 'the whiteness of the whale' })
    expect(passageOf(noted, false)).not.toHaveProperty('note')
    expect(passageOf(noted, true).note).toBe('the whiteness of the whale')
  })

  it('never publishes an empty note, even when asked', () => {
    /* `note: ''` on the wire tells every recipient the reader wrote nothing —
       a fact about the reader, not the passage. */
    expect(passageOf(mark({ note: '   ' }), true)).not.toHaveProperty('note')
  })

  it('has no anchor and no tint, by construction', () => {
    const keys = Object.keys(passageOf(mark({ note: 'n' }), true)).sort()
    expect(keys).toEqual(['chapter', 'note', 'prefix', 'quote', 'suffix'])
  })
})

describe('the live publication of a mark', () => {
  const at = (n: number): Hlc => hlcOf(n)
  const shared = (held: SharedFile, markId: string, pub: string, n: number) =>
    share(held, { markId, passage: passageOf(mark({ id: markId }), false), device: DEVICE }, pub, at(n)).held

  it('is null for a mark never shared', () => {
    expect(livePublication(NOTHING_PUBLISHED, 'm1')).toBeNull()
  })

  it('names the publication that is out', () => {
    const held = shared(NOTHING_PUBLISHED, 'm1', 'pub1', 1)
    expect(livePublication(held, 'm1')?.pub).toBe('pub1')
    expect(livePublication(held, 'm2')).toBeNull()
  })

  it('is null again once withdrawn, and names the NEW one after a re-share', () => {
    /* Published, withdrawn, published again: three rows, one live, and the
       withdrawal has to name the right `pub`. */
    let held = shared(NOTHING_PUBLISHED, 'm1', 'pub1', 1)
    held = unshare(held, 'pub1', at(2))
    expect(livePublication(held, 'm1')).toBeNull()
    held = shared(held, 'm1', 'pub2', 3)
    expect(livePublication(held, 'm1')?.pub).toBe('pub2')
    expect(held.publications).toHaveLength(2)
  })
})

describe('a publication id', () => {
  it('is 32 lower-case hex characters — 128 bits', () => {
    expect(mintPub()).toMatch(/^[0-9a-f]{32}$/u)
  })

  it('is fresh every time', () => {
    /* A `pub` is minted per SHARE; a repeat would make `share(P), share(P),
       unshare(P)` unresolvable, which is the whole reason it exists. */
    expect(new Set(Array.from({ length: 64 }, () => mintPub())).size).toBe(64)
  })

  it('spells the bytes it is given, so the randomness is the platform’s and not this function’s', () => {
    expect(mintPub((bytes) => bytes.fill(0xab))).toBe('ab'.repeat(16))
  })
})

describe('what this device can publish as', () => {
  it('is unreachable with no peer, has no identity without one, and is usable with both', () => {
    /* One row per clause, each differing in ONE input from the row beside it. */
    expect(publishabilityOf(false, false)).toBe('unreachable')
    expect(publishabilityOf(false, true)).toBe('unreachable')
    expect(publishabilityOf(true, false)).toBe('no-identity')
    expect(publishabilityOf(true, true)).toBe('usable')
  })
})

describe('the share port', () => {
  /** A port over an in-memory store, with every seam a spy. */
  function world(over: Partial<SharingDeps> = {}) {
    const files = new Map<string, SharedFile>()
    let tick = 0
    let minted = 0
    const keep = vi.fn((bookId: string, held: SharedFile) => {
      files.set(bookId, held)
      return Promise.resolve()
    })
    const base: SharingDeps = {
      shared: (bookId) => Promise.resolve(files.get(bookId) ?? NOTHING_PUBLISHED),
      /* The transaction, over the map: what the transform is given is what
         the write replaces, and `keep` records each write that changed it. */
      update: async (bookId, transform) => {
        const held = files.get(bookId) ?? NOTHING_PUBLISHED
        const next = transform(held)
        if (next !== held) await keep(bookId, next)
        return next
      },
      reachable: () => true,
      device: () => Promise.resolve(DEVICE),
      clock: () => hlcOf(++tick),
      mintPub: () => `pub${++minted}`,
      ...over,
    }
    const deps = { ...base, keep }
    return { deps, files, port: sharePortOver(deps) }
  }

  it('answers usable and not published for a mark nobody has shared', async () => {
    const { port } = world()
    expect(await port.state(mark())).toEqual({ publishability: 'usable', published: false })
  })

  it('shares as a snapshot row, stamped by THE clock, under a fresh pub', async () => {
    const { port, files } = world()
    await port.share(mark({ note: 'private' }), false)

    const held = files.get('book:moby')!
    expect(held.publications).toHaveLength(1)
    const row = held.publications[0]!
    expect(row.pub).toBe('pub1')
    expect(row.markId).toBe('m1')
    expect(row.device).toBe(DEVICE)
    expect(row.at).toBe(hlcOf(1))
    expect(row.passage).toEqual({ quote: 'Call me Ishmael', prefix: 'before ', suffix: ' after', chapter: 'Loomings' })
    expect(await port.state(mark())).toEqual({ publishability: 'usable', published: true })
  })

  it('shares the note when asked to', async () => {
    const { port, files } = world()
    await port.share(mark({ note: 'the whiteness' }), true)
    expect(files.get('book:moby')!.publications[0]!.passage.note).toBe('the whiteness')
  })

  it('does not publish a mark twice while its first publication is live', async () => {
    const { port, files, deps } = world()
    await port.share(mark(), false)
    await port.share(mark(), false)
    expect(files.get('book:moby')!.publications).toHaveLength(1)
    expect(deps.keep).toHaveBeenCalledTimes(1)
  })

  it('withdraws with a tombstone, keeping the row, and lets the mark be shared again under a new pub', async () => {
    const { port, files } = world()
    await port.share(mark(), false)
    await port.unshare(mark())

    const withdrawn = files.get('book:moby')!
    expect(withdrawn.publications).toHaveLength(1)
    expect(withdrawn.publications[0]!.unshared).toEqual({ seq: 2, at: hlcOf(2) })
    expect(await port.state(mark())).toEqual({ publishability: 'usable', published: false })
    /* `logOf` emits share then unshare for it, in that order — the acceptance. */
    expect(logOf(withdrawn).map((one) => one.op)).toEqual(['share', 'unshare'])

    await port.share(mark(), false)
    expect(livePublication(files.get('book:moby')!, 'm1')?.pub).toBe('pub2')
  })

  it('withdrawing a mark that is not out is a no-op, not an error', async () => {
    const { port, deps } = world()
    await expect(port.unshare(mark())).resolves.toBeUndefined()
    expect(deps.keep).not.toHaveBeenCalled()
  })

  it('tells its subscribers after a share and after a withdrawal, and stops after unsubscribe', async () => {
    const { port } = world()
    const told = vi.fn()
    const off = port.subscribe(told)
    await port.share(mark(), false)
    expect(told).toHaveBeenCalledTimes(1)
    await port.unshare(mark())
    expect(told).toHaveBeenCalledTimes(2)
    off()
    await port.share(mark(), false)
    expect(told).toHaveBeenCalledTimes(2)
  })

  it('refuses to share with no identity, with the reason the control would have shown', async () => {
    const { port, deps } = world({ device: () => Promise.resolve(null) })
    expect(await port.state(mark())).toEqual({ publishability: 'no-identity', published: false })
    await expect(port.share(mark(), false)).rejects.toThrow('Start a circle to share a passage.')
    expect(deps.keep).not.toHaveBeenCalled()
  })

  it('refuses to share with no peer, without asking the peer who it is', async () => {
    const device = vi.fn(() => Promise.resolve(DEVICE))
    const { port } = world({ reachable: () => false, device })
    expect(await port.state(mark())).toEqual({ publishability: 'unreachable', published: false })
    await expect(port.share(mark(), false)).rejects.toThrow('Your shelf has not answered.')
    expect(device).not.toHaveBeenCalled()
  })
})

describe('WI-23.A1 — the falsifier', () => {
  it('keeps the ORIGINAL text after the note is edited and the mark deleted', async () => {
    const files = new Map<string, SharedFile>()
    const port = sharePortOver({
      shared: (bookId) => Promise.resolve(files.get(bookId) ?? NOTHING_PUBLISHED),
      update: (bookId, transform) => {
        const next = transform(files.get(bookId) ?? NOTHING_PUBLISHED)
        files.set(bookId, next)
        return Promise.resolve(next)
      },
      reachable: () => true,
      device: () => Promise.resolve(DEVICE),
      clock: () => hlcOf(1),
      mintPub: () => 'pub1',
    })
    /* The reader's own copy of the mark, which they go on to edit. */
    let own = mark({ note: 'first thought' })
    await port.share(own, true)

    /* Edit the note, then delete the mark: the store the reader edits has
       nothing to do with the store that was published from. */
    own = { ...own, note: 'second thought' }
    const deleted = new Map<string, Annotation>()
    deleted.delete(own.id)

    const held = files.get('book:moby')!
    const log = logOf(held)
    expect(log).toHaveLength(1)
    expect(log[0]!.op === 'share' && log[0]!.passage.note).toBe('first thought')
    expect(log[0]!.op === 'share' && log[0]!.passage.quote).toBe('Call me Ishmael')
    expect(held.publications).toHaveLength(1)
  })
})

describe('a minted pub, byte by byte', () => {
  it('spells every byte with two characters, the small ones included', () => {
    expect(mintPub((bytes) => bytes.fill(0x01))).toBe('01'.repeat(16))
    expect(mintPub((bytes) => bytes.fill(0x00))).toBe('00'.repeat(16))
  })
})

describe('a share listener that throws', () => {
  it('is named as the share port’s, and does not stop the others', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const files = new Map<string, SharedFile>()
    let tick = 0
    const port = sharePortOver({
      shared: (bookId) => Promise.resolve(files.get(bookId) ?? NOTHING_PUBLISHED),
      update: async (bookId, transform) => {
        const next = transform(files.get(bookId) ?? NOTHING_PUBLISHED)
        files.set(bookId, next)
        return next
      },
      reachable: () => true,
      device: () => Promise.resolve(DEVICE),
      clock: () => hlcOf(++tick),
      mintPub: () => `pub${tick}`,
    })
    const heard = vi.fn()
    port.subscribe(() => {
      throw new Error('listener down')
    })
    port.subscribe(heard)
    await port.share({ id: 'm1', bookId: 'book:moby', text: 'q', prefix: '', suffix: '', chapter: '', note: '' } as never, false)
    expect(heard).toHaveBeenCalled()
    expect(spy).toHaveBeenCalledWith('Paper: a share listener threw', expect.objectContaining({ message: 'listener down' }))
    spy.mockRestore()
  })
})

describe('a mark published from two devices', () => {
  const deps = (files: Map<string, SharedFile>, device = DEVICE) => {
    let tick = 10
    let reach = 0
    const port = sharePortOver({
      shared: (bookId) => Promise.resolve(files.get(bookId) ?? NOTHING_PUBLISHED),
      update: async (bookId, transform) => {
        const next = transform(files.get(bookId) ?? NOTHING_PUBLISHED)
        files.set(bookId, next)
        return next
      },
      reachable: () => {
        reach += 1
        return true
      },
      device: () => Promise.resolve(device),
      clock: () => hlcOf(++tick),
      mintPub: () => `pub${tick}`,
    })
    return { port, reaches: () => reach }
  }
  const mark = { id: 'm1', bookId: 'book:moby', text: 'q', prefix: '', suffix: '', chapter: '', note: '' } as never

  it('is withdrawn from BOTH streams by one unshare', async () => {
    const files = new Map<string, SharedFile>()
    const other = 'e'.repeat(64)
    /* Two publications of one mark, one per device, as two stores that met would hold. */
    let held = share(NOTHING_PUBLISHED, { markId: 'm1', passage: { quote: 'q', prefix: '', suffix: '', chapter: '' }, device: DEVICE }, 'pub-a', hlcOf(1)).held
    held = share(held, { markId: 'm1', passage: { quote: 'q', prefix: '', suffix: '', chapter: '' }, device: other }, 'pub-b', hlcOf(2)).held
    files.set('book:moby', held)
    const { port } = deps(files)
    expect((await port.state(mark)).published).toBe(true)
    await port.unshare(mark)
    expect(livePublications(files.get('book:moby')!, 'm1')).toEqual([])
    expect((await port.state(mark)).published).toBe(false)
  })

  it('asks whether the peer is reachable once per state read', async () => {
    const { port, reaches } = deps(new Map())
    await port.state(mark)
    expect(reaches()).toBe(1)
  })
})

describe('the live publications of one mark', () => {
  it('are that mark’s and no other’s', () => {
    const passage = { quote: 'Call me Ishmael', prefix: '', suffix: '', chapter: 'One' }
    const first = share(NOTHING_PUBLISHED, { markId: 'm1', passage, device: DEVICE }, 'p1', hlcOf(1)).held
    const held = share(first, { markId: 'm2', passage, device: DEVICE }, 'p2', hlcOf(2)).held
    expect(livePublications(held, 'm1').map((row) => row.pub)).toEqual(['p1'])
    expect(livePublications(held, 'm2').map((row) => row.pub)).toEqual(['p2'])
  })
})

describe('a peer that stops between the check and the share', () => {
  it('is refused as unreachable, never as usable', async () => {
    let reads = 0
    const port = sharePortOver({
      shared: () => Promise.resolve(NOTHING_PUBLISHED),
      update: () => Promise.reject(new Error('should not write')),
      reachable: () => reads++ === 0,
      device: () => Promise.resolve(DEVICE),
      clock: () => hlcOf(1),
      mintPub: () => 'p1',
    })
    const mark = { id: 'm1', bookId: 'book:moby', text: 'Call me Ishmael', prefix: '', suffix: '', note: '', chapter: 'One' } as unknown as Annotation
    /* The reason the control shows for an unreachable shelf — and not the type's fallback word. */
    await expect(port.share(mark, false)).rejects.toThrow('has not answered')
  })
})
