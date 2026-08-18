import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INDEX_FILE } from './bookIndex'
import { coverPathIn, folderOf, marksPathIn, recordPath, trashOf, type BookRecord } from './bookFolder'
import type { Card } from './cards'
import { createDiagnostics, redact } from './diagnostics'
import { fakeFs, jsonAt, type FakeFs } from './fakeFs.testkit'
import { hlcOf } from './hlc'
import type { Mark } from './marks'
import type { MarkStorage } from './marks'
import { NOOP_RECORDER, contentBlobPort, type MutationRecorder, type MutationToken } from './ports'
import { createKernelServices, type KernelServices } from './services'
import { KERNEL_SETTINGS, SETTINGS_STORAGE_KEY, createSettingsStore } from './settings'

/**
 * THE KERNEL-API RULE, as a test: the desktop UI and a remote service adapter
 * call the same non-React kernel API, or the second one drifts into a second
 * truth. So the same cases run twice below — once straight through the
 * services, once through a stand-in for a service handler that takes JSON
 * messages — and the two runs must leave the same files on disk and the same
 * snapshots in memory.
 *
 * Then the properties every adapter relies on: a subscriber hears once per
 * mutation; a mutator's promise settles only once the write is on disk; every
 * writer is bracketed by the `MutationRecorder`, in order; and the ports
 * behave as their contracts say.
 */

/* ---------------------------------------------------------------- fixtures */

const NOW = 1_700_000_000_000

const REC_A: BookRecord = { title: 'Moby-Dick', author: 'Herman Melville', ext: 'epub', addedAt: NOW }
const REC_B: BookRecord = { title: 'Walden', author: 'Henry David Thoreau', ext: 'epub', addedAt: NOW }

const mark = (id: string, sectionIndex: number, note = ''): Mark => ({
  id,
  bookId: 'book:a',
  cfi: `epubcfi(/6/${4 + sectionIndex * 2}!/4/2,/1:0,/1:5)`,
  sectionIndex,
  text: `passage ${id}`,
  prefix: '',
  suffix: '',
  note,
  kind: 'highlight',
  chapter: 'One',
  createdAt: NOW + sectionIndex,
})
const MARK_1 = mark('m1', 0)
const MARK_2 = mark('m2', 1)

const card = (id: string): Card => ({
  id,
  bookId: 'book:a',
  kind: 'Excerpt',
  body: `card ${id}`,
  answer: '',
  source: 'One',
  cfi: null,
  createdAt: NOW,
})
const CARD_1 = card('c1')
const CARD_2 = card('c2')

/** A `MarkStorage` over a map, with `flush` so the async contract has an edge to test. */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  const storage: MarkStorage & {
    readonly map: Map<string, string>
    flush: () => Promise<void>
    /** Make every flush wait until the returned release is called. */
    hold: () => () => void
  } = {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    flush: () => Promise.resolve(),
    hold: () => {
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      storage.flush = () => gate
      return () => {
        release()
        storage.flush = () => Promise.resolve()
      }
    },
  }
  return storage
}

interface World {
  readonly fs: FakeFs
  readonly storage: ReturnType<typeof memoryStorage>
  readonly kernel: KernelServices
}

function world(recorder: MutationRecorder = NOOP_RECORDER): World {
  const fs = fakeFs()
  const storage = memoryStorage()
  const kernel = createKernelServices({ fs, storage, recorder })
  return { fs, storage, kernel }
}

/** Everything a run leaves behind: files by path, and the three snapshots. */
function outcome({ fs, storage, kernel }: World) {
  const files: Record<string, unknown> = {}
  for (const path of [...fs.store.keys()].sort()) {
    const text = new TextDecoder().decode(fs.store.get(path)!)
    files[path] = path.endsWith('.json') ? JSON.parse(text) : text
  }
  return {
    files,
    flat: Object.fromEntries([...storage.map.entries()].map(([k, v]) => [k, JSON.parse(v) as unknown])),
    library: kernel.library.getSnapshot(),
    marks: kernel.marks.getSnapshot(),
    cards: kernel.cards.getSnapshot(),
  }
}

/* ------------------------------------------------- the remote-style adapter */

/**
 * What a service handler on the peer channel will look like: a JSON message
 * in, one kernel call out. Deliberately thin — the point of the rule is that
 * there is nothing else for it to be.
 */
type Message =
  | { op: 'add'; bookId: string; record: BookRecord; sparse?: boolean }
  | { op: 'update'; bookId: string; change: Partial<BookRecord> }
  | { op: 'position'; bookId: string; position: string; progress: number }
  | { op: 'finished'; bookId: string; finished: boolean }
  | { op: 'remove'; bookId: string }
  | { op: 'restore'; bookId: string }
  | { op: 'tag'; bookId: string; tag: string }
  | { op: 'untag'; bookId: string; tag: string }
  | { op: 'mark'; mark: Mark }
  | { op: 'note'; bookId: string; id: string; note: string }
  | { op: 'unmark'; bookId: string; id: string }
  | { op: 'card'; card: Card }
  | { op: 'discard'; id: string }

async function handle(kernel: KernelServices, wire: string): Promise<void> {
  const message = JSON.parse(wire) as Message
  switch (message.op) {
    case 'add':
      return kernel.library.add(message.bookId, message.record, message.sparse)
    case 'update':
      return kernel.library.update(message.bookId, (record) => ({ ...record, ...message.change }))
    case 'position':
      return kernel.library.rememberPosition(message.bookId, message.position, message.progress)
    case 'finished':
      return kernel.library.setFinished(message.bookId, message.finished)
    case 'remove':
      return kernel.library.remove(message.bookId)
    case 'restore':
      return void (await kernel.library.restore(message.bookId))
    case 'tag':
      return kernel.library.tag(message.bookId, message.tag)
    case 'untag':
      return kernel.library.untag(message.bookId, message.tag)
    case 'mark':
      return kernel.marks.add(message.mark)
    case 'note':
      return kernel.marks.updateNote(message.id, message.note, message.bookId)
    case 'unmark':
      return kernel.marks.remove(message.id, message.bookId)
    case 'card':
      return kernel.cards.add(message.card)
    case 'discard':
      return kernel.cards.remove(message.id)
  }
}

const send = (kernel: KernelServices, message: Message) => handle(kernel, JSON.stringify(message))

/* ------------------------------------------------------------- the cases */

/** The shared shape of the scenario: what happens, in order. */
async function throughTheServices({ kernel }: World): Promise<void> {
  const { library, marks, cards } = kernel
  await marks.open('book:a')
  await library.add('book:a', REC_A)
  await library.add('book:b', REC_B)
  await library.update('book:a', (record) => ({ ...record, subjects: ['Whaling'] }))
  await library.rememberPosition('book:a', 'epubcfi(/6/4!/4/2)', 0.25)
  await library.rememberPosition('book:a', 'epubcfi(/6/4!/4/2)', 0.25) // moved nothing: no write
  await library.setFinished('book:a', true)
  await library.tag('book:a', 'Sea')
  await library.tag('book:a', 'sea') // folded: the same tag
  await library.untag('book:b', 'nothing') // not there: no write
  await marks.add(MARK_1)
  await marks.add(MARK_2)
  await marks.updateNote(MARK_1.id, 'the whale')
  await marks.remove(MARK_2.id)
  await cards.add(CARD_1)
  await cards.add(CARD_2)
  await cards.remove(CARD_2.id)
  await library.remove('book:b')
  await library.restore('book:b')
}

async function throughTheAdapter({ kernel }: World): Promise<void> {
  await kernel.marks.open('book:a')
  await send(kernel, { op: 'add', bookId: 'book:a', record: REC_A })
  await send(kernel, { op: 'add', bookId: 'book:b', record: REC_B })
  await send(kernel, { op: 'update', bookId: 'book:a', change: { subjects: ['Whaling'] } })
  await send(kernel, { op: 'position', bookId: 'book:a', position: 'epubcfi(/6/4!/4/2)', progress: 0.25 })
  await send(kernel, { op: 'position', bookId: 'book:a', position: 'epubcfi(/6/4!/4/2)', progress: 0.25 })
  await send(kernel, { op: 'finished', bookId: 'book:a', finished: true })
  await send(kernel, { op: 'tag', bookId: 'book:a', tag: 'Sea' })
  await send(kernel, { op: 'tag', bookId: 'book:a', tag: 'sea' })
  await send(kernel, { op: 'untag', bookId: 'book:b', tag: 'nothing' })
  await send(kernel, { op: 'mark', mark: MARK_1 })
  await send(kernel, { op: 'mark', mark: MARK_2 })
  await send(kernel, { op: 'note', bookId: 'book:a', id: MARK_1.id, note: 'the whale' })
  await send(kernel, { op: 'unmark', bookId: 'book:a', id: MARK_2.id })
  await send(kernel, { op: 'card', card: CARD_1 })
  await send(kernel, { op: 'card', card: CARD_2 })
  await send(kernel, { op: 'discard', id: CARD_2.id })
  await send(kernel, { op: 'remove', bookId: 'book:b' })
  await send(kernel, { op: 'restore', bookId: 'book:b' })
}

beforeEach(() => {
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the same cases through the services and through a remote-style adapter', () => {
  it('leave identical files, flat-store contents and snapshots', async () => {
    const direct = world()
    await throughTheServices(direct)
    await direct.kernel.drain()

    const remote = world()
    await throughTheAdapter(remote)
    await remote.kernel.drain()

    const a = outcome(direct)
    const b = outcome(remote)
    expect(b.files).toEqual(a.files)
    expect(b.flat).toEqual(a.flat)
    expect(b.library).toEqual(a.library)
    expect(b.marks).toEqual(a.marks)
    expect(b.cards).toEqual(a.cards)
  })

  it('and what they leave is the state the cases describe', async () => {
    const w = world()
    await throughTheServices(w)
    await w.kernel.drain()
    const { fs, kernel } = w

    // book:a — finished, tagged once (folded), on disk and in the snapshot.
    expect(jsonAt(fs, recordPath('book:a'))).toMatchObject({
      title: 'Moby-Dick',
      subjects: ['Whaling'],
      position: 'epubcfi(/6/4!/4/2)',
      progress: 0.25,
      finished: true,
      tags: ['Sea'],
    })
    expect(kernel.library.getSnapshot().find((one) => one.bookId === 'book:a')).toMatchObject({
      position: 'epubcfi(/6/4!/4/2)',
      finished: true,
      tags: ['Sea'],
    })
    // book:b — removed, then restored: back in its folder, no trash entry, on the shelf.
    expect(fs.store.has(recordPath('book:b'))).toBe(true)
    expect(await fs.exists(trashOf('book:b'))).toBe(false)
    expect(kernel.library.getSnapshot().map((one) => one.bookId).sort()).toEqual(['book:a', 'book:b'])
    // The index describes the shelf as it ended up.
    expect((jsonAt(fs, INDEX_FILE) as { books: { bookId: string }[] }).books.map((one) => one.bookId).sort()).toEqual([
      'book:a',
      'book:b',
    ])
    /* marks — one LIVE, with its note and its edit stamp; the removed one
     * stays in the FILE as a tombstone (a deletion has to be able to travel)
     * and is hidden from `current`, which is a read model. The stamps are
     * deterministic because the wall clock is frozen at NOW and no sync is
     * composed, so the default clock stamps under the zero device. */
    const edited = { ...MARK_1, note: 'the whale', updatedAt: hlcOf(NOW) }
    expect(jsonAt(fs, marksPathIn('book:a'))).toEqual([edited, { ...MARK_2, deletedAt: hlcOf(NOW) }])
    expect(kernel.marks.getSnapshot().current).toEqual([edited])
    expect(kernel.marks.getSnapshot().persistent).toBe(true)
    // cards — one live in the snapshot; the discarded one a tombstone in the flat store.
    expect(JSON.parse(w.storage.map.get('paper.cards.v1')!)).toEqual([
      { ...CARD_2, deletedAt: hlcOf(NOW) },
      CARD_1,
    ])
    expect(kernel.cards.getSnapshot().all).toEqual([CARD_1])
  })
})

describe('a subscriber hears exactly once per mutation', () => {
  it('for the library, the marks and the cards', async () => {
    const w = world()
    const { library, marks, cards } = w.kernel
    await marks.open('book:a')
    await library.add('book:a', REC_A)
    await library.add('book:b', REC_B)
    await w.kernel.drain()

    const heard = { library: 0, marks: 0, cards: 0 }
    library.subscribe(() => void (heard.library += 1))
    marks.subscribe(() => void (heard.marks += 1))
    cards.subscribe(() => void (heard.cards += 1))

    await library.update('book:a', (record) => ({ ...record, subjects: ['Whaling'] }))
    expect(heard.library).toBe(1)
    await library.setFinished('book:a', true)
    expect(heard.library).toBe(2)
    await library.rememberPosition('book:a', 'epubcfi(/6/4!/4/2)', 0.25)
    expect(heard.library).toBe(3)
    await library.tag('book:a', 'Sea')
    expect(heard.library).toBe(4)
    await library.remove('book:b')
    expect(heard.library).toBe(5)
    await library.restore('book:b')
    expect(heard.library).toBe(6)
    /* `add` of a book that is already there: the optimistic row is the merge,
     * and the disk agrees, so the confirmation is silent. */
    await library.add('book:a', { ...REC_A, title: 'Moby-Dick; or, The Whale' })
    expect(heard.library).toBe(7)

    await marks.add(MARK_1)
    expect(heard.marks).toBe(1)
    await marks.updateNote(MARK_1.id, 'note')
    expect(heard.marks).toBe(2)
    await marks.remove(MARK_1.id)
    expect(heard.marks).toBe(3)

    await cards.add(CARD_1)
    expect(heard.cards).toBe(1)
    await cards.remove(CARD_1.id)
    expect(heard.cards).toBe(2)

    // A change that changes nothing is heard by nobody.
    await library.update('book:a', (record) => record)
    await library.setFinished('book:a', true)
    await library.rememberPosition('book:a', 'epubcfi(/6/4!/4/2)', 0.25)
    await cards.apply((prev) => prev)
    await marks.updateNote(MARK_1.id, 'gone', 'book:a')
    expect(heard).toEqual({ library: 7, marks: 3, cards: 2 })
  })

  it('and once for a whole remote batch', async () => {
    const w = world()
    const { library } = w.kernel
    await library.add('book:a', REC_A)
    await library.add('book:b', REC_B)
    await w.kernel.drain()
    let heard = 0
    library.subscribe(() => void (heard += 1))
    let indexWrites = 0
    const write = w.fs.writeFile
    w.fs.writeFile = async (path, bytes) => {
      if (path.startsWith(INDEX_FILE)) indexWrites += 1
      return write(path, bytes)
    }
    await library.applyRemoteRows([
      { bookId: 'book:a', change: (record) => ({ ...record, finished: true }) },
      { bookId: 'book:b', change: (record) => ({ ...record, progress: 0.5 }) },
      { bookId: 'book:zzz', change: (record) => ({ ...record, progress: 1 }) },
    ])
    expect(heard).toBe(1)
    expect(indexWrites).toBe(1)
    expect(jsonAt(w.fs, recordPath('book:a'))).toMatchObject({ finished: true })
    expect(jsonAt(w.fs, recordPath('book:b'))).toMatchObject({ progress: 0.5 })
  })
})

describe('MarkStore.mergeRemote respects tombstones — the ledger contract (phase 6)', () => {
  const stamp = (ms: number) => hlcOf(ms, 'a1b2c3d4e5f60718')

  it('an incoming tombstone deletes; a stale row changes nothing; a newer edit resurrects', async () => {
    const w = world()
    const { marks } = w.kernel
    await w.kernel.library.add('book:a', REC_A)
    await marks.open('book:a')
    await marks.add(MARK_1)
    await w.kernel.drain()

    // A tombstone stamped after the local edit deletes the mark — from the
    // read model at once, from the file never (the row stays, stamped).
    const dead = { ...MARK_1, deletedAt: stamp(NOW + 10) }
    await marks.mergeRemote('book:a', [dead])
    expect(marks.getSnapshot().current).toEqual([])
    expect(jsonAt(w.fs, marksPathIn('book:a'))).toEqual([dead])

    // A STALE incoming row — older than the tombstone — changes nothing:
    // an ack is merged, never assigned.
    await marks.mergeRemote('book:a', [{ ...MARK_1, updatedAt: stamp(NOW + 5) }])
    expect(jsonAt(w.fs, marksPathIn('book:a'))).toEqual([dead])
    expect(marks.getSnapshot().current).toEqual([])

    // And an edit stamped after the tombstone brings the mark back —
    // "latest action wins" cuts both ways, stated plainly.
    const revived = { ...MARK_1, note: 'written again', updatedAt: stamp(NOW + 20) }
    await marks.mergeRemote('book:a', [revived])
    expect(marks.getSnapshot().current).toEqual([revived])
    expect(jsonAt(w.fs, marksPathIn('book:a'))).toEqual([revived])
  })

  it('still rejects a mark that belongs to another book', async () => {
    const w = world()
    await w.kernel.library.add('book:a', REC_A)
    await expect(
      w.kernel.marks.mergeRemote('book:a', [{ ...MARK_1, bookId: 'book:b' }]),
    ).rejects.toThrow(/belongs to/)
  })
})

describe("a mutator's promise settles only once the write is durable", () => {
  /** Hold every file write until released; count on the caller to release. */
  function gate(fs: FakeFs) {
    let open!: () => void
    const held = new Promise<void>((resolve) => {
      open = resolve
    })
    const write = fs.writeFile
    fs.writeFile = async (path, bytes) => {
      await held
      return write(path, bytes)
    }
    return open
  }
  const settleOf = (p: Promise<unknown>) => {
    let state = 'pending'
    p.then(
      () => void (state = 'resolved'),
      () => void (state = 'rejected'),
    )
    return () => state
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('for a record write', async () => {
    const w = world()
    await w.kernel.library.add('book:a', REC_A)
    await w.kernel.drain()
    const open = gate(w.fs)
    const done = settleOf(w.kernel.library.update('book:a', (record) => ({ ...record, finished: true })))
    await tick()
    expect(done()).toBe('pending')
    expect(jsonAt(w.fs, recordPath('book:a'))).not.toMatchObject({ finished: true })
    open()
    await tick()
    expect(done()).toBe('resolved')
    expect(jsonAt(w.fs, recordPath('book:a'))).toMatchObject({ finished: true })
  })

  it('for a marks write', async () => {
    const w = world()
    await w.kernel.marks.open('book:a')
    await w.kernel.library.add('book:a', REC_A)
    await w.kernel.drain()
    const open = gate(w.fs)
    const done = settleOf(w.kernel.marks.add(MARK_1))
    await tick()
    expect(done()).toBe('pending')
    expect(w.fs.store.has(marksPathIn('book:a'))).toBe(false)
    open()
    await tick()
    expect(done()).toBe('resolved')
    expect(jsonAt(w.fs, marksPathIn('book:a'))).toEqual([MARK_1])
  })

  it('for a card write, which is durable when the flat store has flushed', async () => {
    const w = world()
    const release = w.storage.hold()
    const done = settleOf(w.kernel.cards.add(CARD_1))
    await tick()
    expect(done()).toBe('pending')
    release()
    await tick()
    expect(done()).toBe('resolved')
    expect(JSON.parse(w.storage.map.get('paper.cards.v1')!)).toEqual([CARD_1])
  })

  it('and rejects with the write error, leaving the store saying so', async () => {
    const w = world()
    await w.kernel.marks.open('book:a')
    await w.kernel.library.add('book:a', REC_A)
    await w.kernel.drain()
    w.fs.writeFile = async () => {
      throw new Error('disk full')
    }
    await expect(w.kernel.library.update('book:a', (record) => ({ ...record, finished: true }))).rejects.toThrow('disk full')
    await expect(w.kernel.marks.add(MARK_1)).rejects.toThrow('disk full')
    expect(w.kernel.marks.getSnapshot().persistent).toBe(false)
    w.storage.setItem = () => {
      throw new Error('quota')
    }
    await expect(w.kernel.cards.add(CARD_1)).rejects.toThrow('quota')
    expect(w.kernel.cards.getSnapshot().persistent).toBe(false)
  })
})

describe('every writer is bracketed by the recorder, begin before the write and commit after', () => {
  function spyRecorder(log: string[]): MutationRecorder {
    let n = 0
    return {
      begin: async (book, what) => {
        n += 1
        log.push(`begin ${what} ${book} #${n}`)
        return { book, what, n } as MutationToken & { n: number }
      },
      commit: async (token) => {
        log.push(`commit ${token.what} ${token.book} #${(token as MutationToken & { n: number }).n}`)
      },
    }
  }
  /** The log with the fs's own writes interleaved, so ORDER is what is asserted. */
  function watched(recorder: MutationRecorder, log: string[]) {
    const w = world(recorder)
    const write = w.fs.writeFile
    w.fs.writeFile = async (path, bytes) => {
      log.push(`write ${path}`)
      return write(path, bytes)
    }
    const rename = w.fs.rename
    w.fs.rename = async (from, to) => {
      log.push(`rename ${from} -> ${to}`)
      return rename(from, to)
    }
    const set = w.storage.setItem
    w.storage.setItem = (key, value) => {
      log.push(`set ${key}`)
      set(key, value)
    }
    return w
  }
  const between = (log: string[], from: string, to: string) =>
    log.slice(log.indexOf(from) + 1, log.indexOf(to))

  it('for the record, marks, removal, restore, cover, content, cards and refresh writers', async () => {
    const log: string[] = []
    const w = watched(spyRecorder(log), log)
    const { library, marks, cards } = w.kernel
    await marks.open('book:a')

    await library.add('book:a', REC_A)
    expect(between(log, 'begin record book:a #1', 'commit record book:a #1')).toEqual([
      `write ${recordPath('book:a')}.writing`,
      `rename ${recordPath('book:a')}.writing -> ${recordPath('book:a')}`,
    ])

    await library.update('book:a', (record) => ({ ...record, finished: true }))
    expect(between(log, 'begin record book:a #2', 'commit record book:a #2')).toEqual([
      `write ${recordPath('book:a')}.writing`,
      `rename ${recordPath('book:a')}.writing -> ${recordPath('book:a')}`,
    ])

    await marks.add(MARK_1)
    expect(between(log, 'begin marks book:a #3', 'commit marks book:a #3')).toEqual([
      `write ${marksPathIn('book:a')}.writing`,
      `rename ${marksPathIn('book:a')}.writing -> ${marksPathIn('book:a')}`,
    ])

    await library.keepContent('book:a', 'moby.epub', new Blob(['WHALE']))
    expect(between(log, 'begin content book:a #4', 'commit content book:a #4')).toEqual([
      `write ${folderOf('book:a')}/content.epub.writing`,
      `rename ${folderOf('book:a')}/content.epub.writing -> ${folderOf('book:a')}/content.epub`,
    ])

    /* The cover: `keepCover` needs an image decoder this environment does not
     * have, so it writes nothing and says so — the bracket still closes. */
    await library.keepJacket('book:a', new Blob(['not an image']))
    expect(log).toContain('begin cover book:a #5')
    expect(log).toContain('commit cover book:a #5')
    expect(w.fs.store.has(coverPathIn('book:a'))).toBe(false)

    await library.refreshContent('book:a')
    expect(log.indexOf('begin content book:a #6')).toBeLessThan(log.indexOf('commit content book:a #6'))
    expect(w.kernel.library.getSnapshot()[0]).toMatchObject({ hasContent: true })

    await cards.add(CARD_1)
    expect(between(log, 'begin cards book:a #7', 'commit cards book:a #7')).toEqual(['set paper.cards.v1'])

    await library.remove('book:a')
    const removal = between(log, 'begin removed book:a #8', 'commit removed book:a #8')
    /* THE PRESENCE REGISTER BEFORE THE TRASH RENAME — the order `presence.ts`
     * stakes replication on: a crash between the two leaves a removal that
     * recovery can finish, never one nothing recorded. */
    const presenceLanded = removal.indexOf(`rename sync/removed.json.writing -> sync/removed.json`)
    const folderMoved = removal.indexOf(`rename ${folderOf('book:a')} -> ${trashOf('book:a')}`)
    expect(presenceLanded).toBeGreaterThanOrEqual(0)
    expect(folderMoved).toBeGreaterThan(presenceLanded)
    expect(removal).toContain(`write ${trashOf('book:a')}/.removed`)

    await library.restore('book:a')
    const restored = between(log, 'begin removed book:a #9', 'commit removed book:a #9')
    expect(restored.some((line) => line.startsWith(`rename ${trashOf('book:a')}/`))).toBe(true)

    // Every begin has its commit, in order, and nothing is written outside a bracket.
    const begins = log.filter((line) => line.startsWith('begin '))
    const commits = log.filter((line) => line.startsWith('commit '))
    expect(commits.map((line) => line.replace('commit', 'begin'))).toEqual(begins)
    let open = 0
    for (const line of log) {
      if (line.startsWith('begin ')) open += 1
      else if (line.startsWith('commit ')) open -= 1
      else if (line.startsWith('write ') && !line.startsWith(`write ${INDEX_FILE}`)) expect(open).toBeGreaterThan(0)
      else if (line.startsWith('set ')) expect(open).toBeGreaterThan(0)
    }
  })

  it('leaves no commit when the write throws — the dangling begin is what a crash would leave', async () => {
    const log: string[] = []
    const w = watched(spyRecorder(log), log)
    await w.kernel.library.add('book:a', REC_A)
    w.fs.writeFile = async () => {
      throw new Error('disk full')
    }
    await expect(w.kernel.library.update('book:a', (record) => ({ ...record, finished: true }))).rejects.toThrow()
    expect(log).toContain('begin record book:a #2')
    expect(log).not.toContain('commit record book:a #2')
  })

  it('and the no-op recorder is the default and changes nothing', async () => {
    const withDefault = world()
    const withNoop = world(NOOP_RECORDER)
    await throughTheServices(withDefault)
    await throughTheServices(withNoop)
    await withDefault.kernel.drain()
    await withNoop.kernel.drain()
    expect(outcome(withNoop).files).toEqual(outcome(withDefault).files)
    const token = await NOOP_RECORDER.begin('book:a', 'record')
    expect(token).toEqual({ book: 'book:a', what: 'record' })
    await expect(NOOP_RECORDER.commit(token, 'digest')).resolves.toBeUndefined()
  })
})

describe('ContentBlobPort', () => {
  const port = contentBlobPort('/data/paper/')

  it('joins a folder name and a closed blob name under the root', () => {
    expect(port.root()).toBe('/data/paper')
    expect(port.target('book_abc', 'content.epub')).toBe('/data/paper/books/book_abc/content.epub')
    expect(port.target('book_abc', 'cover.jpg')).toBe('/data/paper/books/book_abc/cover.jpg')
    expect(port.target('book_abc', 'content.pdf')).toBe('/data/paper/books/book_abc/content.pdf')
  })

  it('refuses a folder that is not a book folder name', () => {
    for (const bad of ['..', '../x', 'a/b', '/etc', '', 'book:abc', 'x'.repeat(81), 'a b', 'a\\b']) {
      expect(() => port.target(bad, 'content.epub'), bad).toThrow()
    }
  })

  it('refuses a name outside the closed set', () => {
    for (const bad of ['content.exe', 'content.', 'cover.png', 'book.json', 'marks.json', '../content.epub']) {
      expect(() => port.target('book_abc', bad as 'cover.jpg'), bad).toThrow()
    }
  })

  it('refuses an empty root', () => {
    expect(() => contentBlobPort('')).toThrow()
  })
})

describe('SettingsStore', () => {
  it('round-trips through the flat store under one versioned key', () => {
    const storage = memoryStorage()
    const first = createSettingsStore({ storage })
    expect(first.get(KERNEL_SETTINGS.theme)).toBe('paper')
    first.set(KERNEL_SETTINGS.theme, 'night')
    first.set(KERNEL_SETTINGS.stepIdx, 4)
    expect(JSON.parse(storage.map.get(SETTINGS_STORAGE_KEY)!)).toEqual({
      version: 1,
      values: { 'kernel.theme': 'night', 'kernel.stepIdx': 4 },
    })
    const second = createSettingsStore({ storage })
    expect(second.get(KERNEL_SETTINGS.theme)).toBe('night')
    expect(second.get(KERNEL_SETTINGS.stepIdx)).toBe(4)
    expect(second.get(KERNEL_SETTINGS.typeface)).toBe('literata')
  })

  it('starts from defaults with nothing stored, and writes the envelope on the first set', () => {
    const storage = memoryStorage()
    const store = createSettingsStore({ storage })
    expect(storage.map.has(SETTINGS_STORAGE_KEY)).toBe(false)
    expect(store.get(KERNEL_SETTINGS.side)).toBe('right')
    store.set(KERNEL_SETTINGS.side, 'left')
    expect(JSON.parse(storage.map.get(SETTINGS_STORAGE_KEY)!)).toMatchObject({ version: 1 })
  })

  it('migrates an older envelope through the hook, keeping its values by default', () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ values: { 'kernel.theme': 'sage' } }),
    })
    expect(createSettingsStore({ storage }).get(KERNEL_SETTINGS.theme)).toBe('sage')
    const seen: unknown[] = []
    const migrated = createSettingsStore({
      storage,
      migrate: (found) => {
        seen.push(found)
        return { 'kernel.theme': 'slate' }
      },
    })
    expect(seen).toEqual([{ version: 0, values: { 'kernel.theme': 'sage' } }])
    expect(migrated.get(KERNEL_SETTINGS.theme)).toBe('slate')
    // And a missing envelope reaches the hook as null.
    const fresh: unknown[] = []
    createSettingsStore({ storage: memoryStorage(), migrate: (found) => (fresh.push(found), {}) })
    expect(fresh).toEqual([null])
  })

  it('ignores unknown keys and malformed values, and keeps the unknown keys on disk', () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        values: { 'kernel.theme': 42, 'kernel.stepIdx': 999, 'sync.interval': 30, 'kernel.side': 'left' },
      }),
    })
    const store = createSettingsStore({ storage })
    expect(store.get(KERNEL_SETTINGS.theme)).toBe('paper')
    expect(store.get(KERNEL_SETTINGS.stepIdx)).toBe(KERNEL_SETTINGS.stepIdx.fallback)
    expect(store.get(KERNEL_SETTINGS.side)).toBe('left')
    store.set(KERNEL_SETTINGS.theme, 'sepia')
    expect(JSON.parse(storage.map.get(SETTINGS_STORAGE_KEY)!).values).toMatchObject({ 'sync.interval': 30, 'kernel.theme': 'sepia' })
  })

  it('notifies once per change and not for a set that changes nothing', () => {
    const store = createSettingsStore({ storage: memoryStorage() })
    let heard = 0
    store.subscribe(() => void (heard += 1))
    const before = store.getSnapshot()
    store.set(KERNEL_SETTINGS.rulerOn, true)
    expect(heard).toBe(1)
    expect(store.getSnapshot()).not.toBe(before)
    const after = store.getSnapshot()
    store.set(KERNEL_SETTINGS.rulerOn, true)
    expect(heard).toBe(1)
    expect(store.getSnapshot()).toBe(after)
  })

  it('lives for the session with no storage at all', () => {
    const store = createSettingsStore({ storage: null })
    store.set(KERNEL_SETTINGS.theme, 'night')
    expect(store.get(KERNEL_SETTINGS.theme)).toBe('night')
  })
})

describe('Diagnostics', () => {
  it('redacts secrets, tokens, keys, bodies, text, peers and endpoints, however nested', () => {
    expect(
      redact({
        token: 'abc',
        authToken: 'def',
        peer_id: 'p1',
        count: 3,
        nested: { body: 'the envelope', ok: true, list: [{ text: 'a passage', page: 2 }] },
        endpoint: 'https://x',
        context: 'kept: not a whole word',
      }),
    ).toEqual({
      token: '[redacted]',
      authToken: '[redacted]',
      peer_id: '[redacted]',
      count: 3,
      nested: { body: '[redacted]', ok: true, list: [{ text: '[redacted]', page: 2 }] },
      endpoint: '[redacted]',
      context: 'kept: not a whole word',
    })
  })

  it('writes to the sink under its scope, redacted, and a child under a dotted scope', () => {
    const lines: [string, string, Record<string, unknown>][] = []
    const sink = {
      info: (m: string, f: Record<string, unknown>) => void lines.push(['info', m, f]),
      warn: (m: string, f: Record<string, unknown>) => void lines.push(['warn', m, f]),
      error: (m: string, f: Record<string, unknown>) => void lines.push(['error', m, f]),
    }
    const diag = createDiagnostics({ sink })
    diag.info('boot', { books: 2 })
    diag.child('sync').warn('pull-failed', { peerId: 'p1', reason: 'timeout' })
    diag.child('sync').child('journal').error('torn', {})
    expect(lines).toEqual([
      ['info', '[paper:kernel] boot', { books: 2 }],
      ['warn', '[paper:kernel.sync] pull-failed', { peerId: '[redacted]', reason: 'timeout' }],
      ['error', '[paper:kernel.sync.journal] torn', {}],
    ])
  })

  it('is the no-op when disabled', () => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const diag = createDiagnostics({ sink, enabled: false })
    diag.error('anything', { secret: 'x' })
    diag.child('sync').info('anything')
    expect(sink.info).not.toHaveBeenCalled()
    expect(sink.error).not.toHaveBeenCalled()
  })
})
