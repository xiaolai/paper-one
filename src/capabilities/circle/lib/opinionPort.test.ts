import { describe, expect, it, vi } from 'vitest'
import { hlcOf, type BookPatch, type Hlc } from '../../../kernel'
import { opinionPortOver, type BookRow, type OpinionDeps } from './opinionPort'
import { NOTHING_PUBLISHED, logOf, type SharedFile } from './publish'

/**
 * WI-23.B4 — the switch, and the driver behind it.
 *
 * ⚠️ **THE ITEM'S FALSIFIER**: count `shared.json` rows before and after a
 * rating change with the control off. The difference must be 0. Then on: 1.
 */

const DEVICE = 'd'.repeat(64)

/** A shelf of records, a store of files, and every seam a spy. */
function world(over: Partial<OpinionDeps> = {}) {
  const rows = new Map<string, BookRow>([['book:moby', { bookId: 'book:moby', title: 'Moby-Dick' }]])
  const files = new Map<string, SharedFile>()
  const listeners = new Set<() => void>()
  let tick = 0
  let minted = 0
  const keep = vi.fn((bookId: string, held: SharedFile) => {
    files.set(bookId, held)
    return Promise.resolve()
  })
  const gate: { hold: (() => Promise<void>) | null } = { hold: null }
  const base: OpinionDeps = {
    books: () => [...rows.values()],
    changes: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    patch: vi.fn((bookId: string, fields: BookPatch) => {
      const row = rows.get(bookId)!
      const at: Hlc = hlcOf(++tick)
      rows.set(bookId, {
        ...row,
        ...(fields.status === undefined ? {} : { status: { state: fields.status, at } }),
        ...(fields.rating === undefined ? {} : { rating: fields.rating }),
        ...(fields.review === undefined ? {} : { review: { text: fields.review, at } }),
      })
      for (const listener of listeners) listener()
      return Promise.resolve()
    }),
    shared: vi.fn((bookId: string) => Promise.resolve(files.get(bookId) ?? NOTHING_PUBLISHED)),
    /* The transaction over the map. `gate.hold` lets a test hold the read
       open, the way a slow disk would, to see what lands during a pass. */
    update: vi.fn(async (bookId: string, transform: (held: SharedFile) => SharedFile) => {
      await gate.hold?.()
      const held = files.get(bookId) ?? NOTHING_PUBLISHED
      const next = transform(held)
      if (next !== held) await keep(bookId, next)
      return next
    }),
    device: () => Promise.resolve(DEVICE),
    clock: () => hlcOf(++tick),
    mintPub: () => `rev${++minted}`,
    ...over,
  }
  const deps = { ...base, keep }
  const port = opinionPortOver(deps)
  return { deps, gate, rows, files, port, listeners, rowsOf: (bookId: string) => logOf(files.get(bookId) ?? NOTHING_PUBLISHED).length }
}

/* The library's feed fires synchronously; the driver's pass is async. */
const settled = () => new Promise((done) => setTimeout(done, 0))

describe('the reader’s own copy', () => {
  it('answers the record’s opinion, and null for a book not on the shelf', async () => {
    const { port, rows } = world()
    expect(await port.own('book:moby')).toEqual({ title: 'Moby-Dick', status: null, stars: null, review: '', tags: [] })
    rows.set('book:moby', {
      bookId: 'book:moby',
      title: 'Moby-Dick',
      status: { state: 'reading', at: hlcOf(1) },
      rating: 4,
      review: { text: 'r', at: hlcOf(2) },
      tags: ['sea'],
    })
    expect(await port.own('book:moby')).toEqual({ title: 'Moby-Dick', status: 'reading', stars: 4, review: 'r', tags: ['sea'] })
    expect(await port.own('book:none')).toBeNull()
  })

  it('writes through the library, one field per verb', async () => {
    const { port, deps } = world()
    await port.setStatus('book:moby', 'finished')
    await port.setStars('book:moby', 5)
    await port.setReview('book:moby', 'a whale of a book')
    expect(deps.patch).toHaveBeenNthCalledWith(1, 'book:moby', { status: 'finished' })
    expect(deps.patch).toHaveBeenNthCalledWith(2, 'book:moby', { rating: 5 })
    expect(deps.patch).toHaveBeenNthCalledWith(3, 'book:moby', { review: 'a whale of a book' })
  })
})

describe('the switch', () => {
  it('is off until turned on, and read from the store once', async () => {
    const { port, deps } = world()
    expect(await port.publishing('book:moby')).toBe(false)
    expect(await port.publishing('book:moby')).toBe(false)
    expect(deps.shared).toHaveBeenCalledTimes(1)
  })

  it('publishes NOTHING for a rating change while off — the falsifier', async () => {
    const { port, rowsOf } = world()
    expect(await port.publishing('book:moby')).toBe(false)
    await port.setStars('book:moby', 3)
    await settled()
    expect(rowsOf('book:moby')).toBe(0)
  })

  it('publishes exactly ONE rate entry for a rating change while on', async () => {
    const { port, rowsOf, files } = world()
    await port.setPublishing('book:moby', true)
    await settled()
    expect(files.get('book:moby')?.publishOpinion).toBe(true)
    const before = rowsOf('book:moby')
    await port.setStars('book:moby', 3)
    await settled()
    expect(rowsOf('book:moby') - before).toBe(1)
    await port.setStars('book:moby', 4)
    await settled()
    expect(rowsOf('book:moby') - before).toBe(2)
  })

  it('publishes the whole current opinion the moment it is turned on', async () => {
    const { port, rows, files } = world()
    rows.set('book:moby', {
      bookId: 'book:moby',
      title: 'Moby-Dick',
      status: { state: 'reading', at: hlcOf(1) },
      rating: 4,
      review: { text: 'r', at: hlcOf(2) },
      tags: ['sea'],
    })
    await port.setPublishing('book:moby', true)
    expect(logOf(files.get('book:moby')!).map((one) => one.op)).toEqual(['status', 'rate', 'tag', 'review'])
  })

  it('turned off, publishes nothing more and withdraws nothing', async () => {
    const { port, files, rowsOf } = world()
    await port.setPublishing('book:moby', true)
    await port.setStars('book:moby', 3)
    await settled()
    const held = rowsOf('book:moby')
    await port.setPublishing('book:moby', false)
    expect(files.get('book:moby')?.publishOpinion).toBe(false)
    await port.setStars('book:moby', 5)
    await settled()
    expect(rowsOf('book:moby')).toBe(held)
    expect(logOf(files.get('book:moby')!).every((one) => one.op !== 'unreview')).toBe(true)
  })

  it('tells its subscribers when the switch moves or something is published', async () => {
    const { port } = world()
    const told = vi.fn()
    const off = port.subscribe(told)
    await port.setPublishing('book:moby', true)
    expect(told).toHaveBeenCalled()
    const before = told.mock.calls.length
    await port.setStars('book:moby', 2)
    await settled()
    expect(told.mock.calls.length).toBeGreaterThan(before)
    off()
    const after = told.mock.calls.length
    await port.setStars('book:moby', 1)
    await settled()
    expect(told.mock.calls.length).toBe(after)
  })

  it('publishes nothing without an identity to publish as, and does not lose the switch', async () => {
    const { port, rowsOf, files } = world({ device: () => Promise.resolve(null) })
    await port.setPublishing('book:moby', true)
    await port.setStars('book:moby', 3)
    await settled()
    expect(rowsOf('book:moby')).toBe(0)
    expect(files.get('book:moby')?.publishOpinion).toBe(true)
  })
})

describe('the driver', () => {
  it('warms every book’s switch once, and publishes what a relaunch left unpublished', async () => {
    const files = new Map<string, SharedFile>([['book:moby', { ...NOTHING_PUBLISHED, publishOpinion: true }]])
    const shared = vi.fn((bookId: string) => Promise.resolve(files.get(bookId) ?? NOTHING_PUBLISHED))
    const { port, rows, deps } = world({ shared })
    rows.set('book:moby', { bookId: 'book:moby', title: 'Moby-Dick', rating: 5 })
    rows.set('book:other', { bookId: 'book:other', title: 'Other' })
    await port.warm()
    /* Two switches read; the watched book published through the transaction. */
    expect(shared.mock.calls.map((one) => one[0]).sort()).toEqual(['book:moby', 'book:other'])
    expect((deps.update as ReturnType<typeof vi.fn>).mock.calls.map((one) => one[0])).toEqual(['book:moby'])
    expect(deps.keep).toHaveBeenCalledTimes(1)
    expect((deps.keep as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ opinions: [{ op: 'rate', stars: 5 }] })
  })

  it('does not read the store for a watched book whose opinion did not change', async () => {
    const { port, deps, listeners } = world()
    await port.setPublishing('book:moby', true)
    await port.setStars('book:moby', 3)
    await settled()
    const reads = (deps.update as ReturnType<typeof vi.fn>).mock.calls.length
    /* A page turn: the library fires and nothing about the opinion moved. */
    for (const listener of listeners) listener()
    await settled()
    expect((deps.update as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads)
  })

  it('coalesces changes that land during a pass: three changes, at most two passes, the last word kept', async () => {
    /* The store answers at once until the gate is armed; then every read
       waits until the test lets it through. Which change the blocked pass
       happened to read is microtask order, not the property: the property is
       that three changes cost at most two passes and the newest word wins. */
    let gate: (() => void) | null = null
    const { port, deps, gate: hold } = world()
    await port.setPublishing('book:moby', true)
    const passes = () => (deps.update as ReturnType<typeof vi.fn>).mock.calls.length
    const reads = passes()
    const writesBefore = (deps.keep as ReturnType<typeof vi.fn>).mock.calls.length

    hold.hold = () =>
      new Promise<void>((resolve) => {
        gate = () => {
          gate = null
          resolve()
        }
      })
    await port.setStars('book:moby', 3)
    await port.setStars('book:moby', 4)
    await port.setStars('book:moby', 5)
    await settled()
    expect(passes() - reads).toBe(1)
    /* Let every blocked pass through, one at a time, until none is waiting. */
    for (let rounds = 0; rounds < 5; rounds++) {
      const release = gate as (() => void) | null
      if (release === null) break
      release()
      await settled()
    }
    expect(passes() - reads).toBeLessThanOrEqual(2)
    expect((deps.keep as ReturnType<typeof vi.fn>).mock.calls.length - writesBefore).toBeLessThanOrEqual(2)
    const last = (deps.keep as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as SharedFile
    expect(last.opinions.at(-1)).toMatchObject({ op: 'rate', stars: 5 })
  })

  it('stops listening once disposed', async () => {
    const { port, listeners, deps } = world()
    await port.setPublishing('book:moby', true)
    port.dispose()
    expect(listeners.size).toBe(0)
    await port.setStars('book:moby', 4)
    await settled()
    expect(deps.keep).toHaveBeenCalledTimes(1)
  })
})

describe('every clause of the driver — one row each', () => {
  it('reads the store once per register that changed, and never for one that did not', async () => {
    const { port, rows, deps, listeners } = world()
    await port.setPublishing('book:moby', true)
    const reads = () => (deps.update as ReturnType<typeof vi.fn>).mock.calls.length
    const fire = async () => {
      for (const listener of listeners) listener()
      await settled()
    }
    const base = () => rows.get('book:moby')!
    let before = reads()
    rows.set('book:moby', { ...base(), status: { state: 'reading', at: hlcOf(1) } })
    await fire()
    expect(reads() - before).toBe(1)
    before = reads()
    rows.set('book:moby', { ...base(), review: { text: 'r', at: hlcOf(2) } })
    await fire()
    expect(reads() - before).toBe(1)
    before = reads()
    rows.set('book:moby', { ...base(), tags: ['sea', 'whales'] })
    await fire()
    expect(reads() - before).toBe(1)
    before = reads()
    /* Same count, one tag different. */
    rows.set('book:moby', { ...base(), tags: ['sea', 'ships'] })
    await fire()
    expect(reads() - before).toBe(1)
    before = reads()
    /* Nothing changed: no read. */
    await fire()
    expect(reads() - before).toBe(0)
  })

  it('asks who it is exactly once per pass, and not at all when the switch is turned off', async () => {
    const device = vi.fn(() => Promise.resolve(DEVICE))
    const { port } = world({ device })
    await port.setPublishing('book:moby', true)
    expect(device).toHaveBeenCalledTimes(1)
    await port.setPublishing('book:moby', false)
    expect(device).toHaveBeenCalledTimes(1)
  })

  it('writes the switch only when it moves', async () => {
    const { port, deps } = world()
    await port.setPublishing('book:moby', true)
    await port.setPublishing('book:moby', true)
    /* One write for the switch; the empty opinion published nothing. */
    expect(deps.keep).toHaveBeenCalledTimes(1)
  })

  it('does not read the store for a watched book that has left the shelf', async () => {
    const { port, rows, deps, listeners } = world()
    await port.setPublishing('book:moby', true)
    const reads = (deps.update as ReturnType<typeof vi.fn>).mock.calls.length
    rows.delete('book:moby')
    for (const listener of listeners) listener()
    await settled()
    expect((deps.update as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads)
  })

  it('forgets what it last published when the switch turns on, so the store is re-read', async () => {
    /* Another device may have written the store meanwhile; what this side
       last published is not what is published. */
    const { port, rows, files, deps } = world()
    rows.set('book:moby', { bookId: 'book:moby', title: 'Moby-Dick', rating: 3 })
    await port.setPublishing('book:moby', true)
    const written = (deps.keep as ReturnType<typeof vi.fn>).mock.calls.length
    /* The store changes under us: the newest published rating is now 1. */
    files.set('book:moby', {
      ...files.get('book:moby')!,
      opinions: [{ op: 'rate', stars: 1, device: 'e'.repeat(64), seq: 9, at: hlcOf(99) }],
    })
    await port.setPublishing('book:moby', false)
    await port.setPublishing('book:moby', true)
    expect((deps.keep as ReturnType<typeof vi.fn>).mock.calls.length - written).toBe(3)
    const last = (deps.keep as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as SharedFile
    expect(last.opinions.at(-1)).toMatchObject({ op: 'rate', stars: 3 })
  })

  it('warms each switch once, however often it is asked', async () => {
    const shared = vi.fn((_bookId: string) => Promise.resolve(NOTHING_PUBLISHED))
    const { port, rows } = world({ shared })
    rows.set('book:other', { bookId: 'book:other', title: 'Other' })
    await port.warm()
    await port.warm()
    expect(shared.mock.calls.filter((one) => one[0] === 'book:other')).toHaveLength(1)
  })

  it('tells nobody after dispose', async () => {
    const { port } = world()
    const told = vi.fn()
    port.subscribe(told)
    port.dispose()
    await port.setPublishing('book:moby', true)
    expect(told).not.toHaveBeenCalled()
  })
})

describe('one queue for every write the port makes', () => {
  it('turns the switch off only after the pass in flight has finished its write', async () => {
    const w = world()
    await w.port.setPublishing('book:moby', true)
    const order: string[] = []
    const gate = deferred()
    w.gate.hold = () => {
      order.push('pass-held')
      w.gate.hold = null
      return gate.promise
    }
    /* A rating change starts a pass, whose transaction is now held open. */
    await w.port.setStars('book:moby', 4)
    await settled()
    const off = w.port.setPublishing('book:moby', false)
    let offDone = false
    void off.then(() => {
      offDone = true
    })
    await settled()
    expect(order).toEqual(['pass-held'])
    expect(offDone, 'the switch went off under a publication still in flight').toBe(false)
    gate.open()
    await off
    /* Both landed, in the order they were asked: the rating first, the switch after it. */
    const calls = (w.deps.update as ReturnType<typeof vi.fn>).mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(w.files.get('book:moby')!.publishOpinion).toBe(false)
    expect(logOf(w.files.get('book:moby')!).some((row) => row.op === 'rate')).toBe(true)
  })

  it('publishes nothing further once disposed, even from a pass already under way', async () => {
    const w = world()
    w.rows.set('book:other', { bookId: 'book:other', title: 'Other' })
    await w.port.setPublishing('book:moby', true)
    await w.port.setPublishing('book:other', true)
    const before = w.deps.keep.mock.calls.length
    const gate = deferred()
    w.gate.hold = () => {
      w.gate.hold = null
      return gate.promise
    }
    await w.port.setStars('book:moby', 3)
    await w.port.setStars('book:other', 5)
    await settled()
    w.port.dispose()
    gate.open()
    await settled()
    await settled()
    /* The one write that was already inside its transaction lands; the book after it is not published. */
    expect(w.deps.keep.mock.calls.length - before).toBeLessThanOrEqual(1)
  })
})

function deferred(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('the port, held to the letter', () => {
  it('names itself when a listener throws, and goes on telling the others', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = world()
    const heard = vi.fn()
    w.port.subscribe(() => {
      throw new Error('listener down')
    })
    w.port.subscribe(heard)
    await w.port.setPublishing('book:moby', true)
    expect(heard).toHaveBeenCalled()
    expect(spy).toHaveBeenCalledWith(`Paper: a opinion listener threw`, expect.objectContaining({ message: 'listener down' }))
    spy.mockRestore()
  })

  it('publishes nothing for a switched-on book that has left the shelf', async () => {
    const w = world()
    await w.port.setPublishing('book:moby', true)
    w.rows.delete('book:moby')
    const before = w.deps.keep.mock.calls.length
    await w.port.republishAll()
    expect(w.deps.keep.mock.calls.length).toBe(before)
  })

  it('answers one waiting pass to everybody who asks before it starts', async () => {
    const w = world()
    await w.port.setPublishing('book:moby', true)
    const gate = deferred()
    w.gate.hold = () => {
      w.gate.hold = null
      return gate.promise
    }
    /* A pass is under way; the next two asks share one waiting pass. */
    await w.port.setStars('book:moby', 4)
    await settled()
    const first = w.port.republishAll()
    const second = w.port.republishAll()
    expect(second).toBe(first)
    gate.open()
    await first
  })

  it('hands a failing pass to `failed`, and swallows it silently when nobody asked to be told', async () => {
    const failed = vi.fn()
    const w = world({ failed })
    await w.port.setPublishing('book:moby', true)
    w.deps.keep.mockImplementation(() => Promise.reject(new Error('disk gone')))
    await w.port.setStars('book:moby', 4)
    await settled()
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/could not be published/u) }))
    expect((failed.mock.calls[0]![0] as AggregateError).errors[0]).toMatchObject({ message: 'disk gone' })
    const quiet = world()
    await quiet.port.setPublishing('book:moby', true)
    quiet.deps.keep.mockImplementation(() => Promise.reject(new Error('disk gone')))
    await quiet.port.setStars('book:moby', 4)
    await settled()
  })

  it('publishes nothing for the book after the one in flight once disposed', async () => {
    const w = world()
    w.rows.set('book:other', { bookId: 'book:other', title: 'Other' })
    await w.port.setPublishing('book:moby', true)
    await w.port.setPublishing('book:other', true)
    const gate = deferred()
    w.gate.hold = () => {
      w.gate.hold = null
      return gate.promise
    }
    await w.port.setStars('book:moby', 3)
    await w.port.setStars('book:other', 5)
    await settled()
    const before = w.deps.keep.mock.calls.length
    w.port.dispose()
    gate.open()
    await settled()
    await settled()
    /* The write already inside its transaction lands; the book after it is not published. */
    expect(w.deps.keep.mock.calls.slice(before).map(([bookId]) => bookId)).toEqual(['book:moby'])
  })
})

describe('one book that will not publish', () => {
  it('does not starve the books after it, and the failure names it once the pass is done', async () => {
    const failed = vi.fn()
    const w = world({ failed })
    w.rows.set('book:other', { bookId: 'book:other', title: 'Other' })
    await w.port.setPublishing('book:moby', true)
    await w.port.setPublishing('book:other', true)
    w.deps.keep.mockImplementation((bookId: string, held: SharedFile) => {
      if (bookId === 'book:moby') return Promise.reject(new Error('moby will not write'))
      w.files.set(bookId, held)
      return Promise.resolve()
    })
    await w.port.setStars('book:moby', 3)
    await w.port.setStars('book:other', 5)
    await settled()
    await settled()
    expect(logOf(w.files.get('book:other') ?? NOTHING_PUBLISHED).some((row) => row.op === 'rate')).toBe(true)
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/could not be published/u) }))
  })

  it('does not stop the warm-up either', async () => {
    const w = world({ shared: (bookId) => (bookId === 'book:moby' ? Promise.reject(new Error('moby will not read')) : Promise.resolve({ ...NOTHING_PUBLISHED, publishOpinion: true })) })
    w.rows.set('book:other', { bookId: 'book:other', title: 'Other' })
    await expect(w.port.warm()).rejects.toThrow(/could not be warmed/u)
    expect(await w.port.publishing('book:other')).toBe(true)
  })
})

describe('the switch, read and moved at once', () => {
  it('reads the store once for two concurrent asks, and a move made meanwhile stands', async () => {
    const gate = deferred()
    let reads = 0
    const w = world({
      shared: () => {
        reads += 1
        return gate.promise.then(() => ({ ...NOTHING_PUBLISHED, publishOpinion: false }))
      },
    })
    const first = w.port.publishing('book:moby')
    const second = w.port.publishing('book:moby')
    expect(reads).toBe(1)
    gate.open()
    expect(await first).toBe(false)
    expect(await second).toBe(false)
  })

  it('tells subscribers the switch moved even when the publication after it fails, and writes nothing once disposed', async () => {
    const heard = vi.fn()
    const w = world()
    w.port.subscribe(heard)
    w.rows.set('book:moby', { bookId: 'book:moby', title: 'Moby-Dick', rating: 4 })
    let writes = 0
    w.deps.keep.mockImplementation((bookId: string, held: SharedFile) => {
      writes += 1
      if (writes > 1) return Promise.reject(new Error('disk full'))
      w.files.set(bookId, held)
      return Promise.resolve()
    })
    await w.port.setPublishing('book:moby', true).catch(() => {})
    expect(heard).toHaveBeenCalled()
    w.port.dispose()
    const before = (w.deps.update as ReturnType<typeof vi.fn>).mock.calls.length
    await w.port.setPublishing('book:moby', false)
    expect((w.deps.update as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
  })
})

describe('the switch, read and moved at once', () => {
  it('answers the switch a move set while the read was in flight, not what the read found', async () => {
    let release: (held: SharedFile) => void = () => {}
    const w = world({ shared: vi.fn(() => new Promise<SharedFile>((resolve) => (release = resolve))) })
    const asked = w.port.publishing('book:moby')
    await w.port.setPublishing('book:moby', true)
    release({ ...NOTHING_PUBLISHED, publishOpinion: false })
    expect(await asked).toBe(true)
    expect(await w.port.publishing('book:moby')).toBe(true)
  })

  it('does not run a pass queued behind a slow one once disposed', async () => {
    const device = vi.fn(() => Promise.resolve(DEVICE))
    const w = world({ device })
    await w.port.setPublishing('book:moby', true)
    let open: () => void = () => {}
    w.gate.hold = () => new Promise<void>((resolve) => (open = resolve))
    for (const listener of w.listeners) listener()
    await settled()
    const before = device.mock.calls.length
    for (const listener of w.listeners) listener()
    w.port.dispose()
    open()
    await settled()
    await settled()
    expect(device.mock.calls.length).toBe(before)
  })

  it('survives a pass that fails with nobody to tell, and a reporter that throws', async () => {
    /* The switch goes on; the pass then fails at the identity. */
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const quiet = world({ device: () => Promise.reject(new Error('peer gone')) })
    await quiet.port.setPublishing('book:moby', true).catch(() => {})
    for (const listener of quiet.listeners) listener()
    await settled()
    await settled()
    /* Nobody to tell is not an error to log: the optional call is what makes it optional. */
    expect(error).not.toHaveBeenCalled()
    const loud = world({
      failed: () => {
        throw new Error('reporter down')
      },
      device: () => Promise.reject(new Error('peer gone')),
    })
    await loud.port.setPublishing('book:moby', true).catch(() => {})
    for (const listener of loud.listeners) listener()
    await settled()
    await settled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not report a failed pass'), expect.any(Error))
    error.mockRestore()
  })
})

describe('warming with one file that will not read', () => {
  it('follows the switches that warmed before it reports the one that did not', async () => {
    const w = world({
      shared: vi.fn((bookId: string) => (bookId === 'book:dune' ? Promise.reject(new Error('dune will not read')) : Promise.resolve({ ...NOTHING_PUBLISHED, publishOpinion: true }))),
    })
    w.rows.set('book:dune', { bookId: 'book:dune', title: 'Dune' })
    await expect(w.port.warm()).rejects.toThrow(/1 book\(s\) could not be warmed/u)
    /* Moby's switch was on in its file, and its opinion is published on the warm. */
    expect(w.deps.update).toHaveBeenCalledWith('book:moby', expect.any(Function))
  })
})
