import { describe, expect, it } from 'vitest'
import {
  createKernelServices,
  parseRecord,
  readBook,
  readMarks,
  readPresence,
  validMarks,
  writeQueue,
  type BookRecord,
  type IndexedBook,
  type KernelServices,
  type Mark,
} from '../../../kernel'
import { createPeerPort, fakeWire, linkWires, type FakeWire, type PeerPort } from '../../peer'
import { createClock, type Clock } from './clock'
import { createJournal, type Journal } from './journal'
import { crashableFs, fsOver, type CrashableFs } from './journalFs.testkit'
import { SYNC_CURSOR_SETTING, createLedger, type Ledger, type SyncChannel } from './ledger'
import { canonicalJson, toWire } from './merge'
import { PUSHABLE } from './protocol'

/**
 * WI-C.2 — the star protocol, end to end over the FAKE WIRE: a shelf stack
 * and a satchel stack, each a REAL kernel (services over a crashable fs)
 * with the REAL journal bound as its recorder and the real clock as its
 * stamps, speaking the real envelope over two linked in-memory wires. The
 * cases are the plan's list (§III.5 WI-C.2), each named for the invariant
 * it pins.
 */

/* One wall for every device in a test, ticking once per stamp — so a step
 * that happens later in the test is later in HLC time, whichever device
 * takes it, and the LWW outcomes are the intended ones. */
let wall = 1_750_000_000_000
const nextWall = () => ++wall

let nextEndpoint = 0

interface Stack {
  readonly fs: CrashableFs
  readonly storage: { map: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void }
  readonly clock: Clock
  readonly journal: Journal
  readonly services: KernelServices
  readonly ledger: Ledger
  readonly wire: FakeWire
  readonly port: PeerPort
}

const flatStorage = () => {
  const map = new Map<string, string>()
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

/** Rows for services built over an EXISTING tree — a restart's `loadShelf`. */
const booksOn = (fs: CrashableFs): IndexedBook[] => {
  const rows: IndexedBook[] = []
  for (const [path, bytes] of fs.store) {
    const m = /^books\/([^/]+)\/book\.json$/.exec(path)
    if (!m) continue
    const record = parseRecord(new TextDecoder().decode(bytes))
    if (!record?.bookId) continue
    const hasContent = [...fs.store.keys()].some((k) => k.startsWith(`books/${m[1]}/content.`))
    rows.push({ ...record, bookId: record.bookId, hasContent })
  }
  return rows
}

async function makeStack(
  wire: FakeWire,
  role: 'shelf' | 'satchel',
  deviceId: string,
  fs: CrashableFs = crashableFs(),
): Promise<Stack> {
  const storage = flatStorage()
  const clock = createClock({ deviceId, now: nextWall })
  const journal = createJournal({ fs, queue: writeQueue(), clock: () => clock.now(), storage })
  await journal.open()
  const services = createKernelServices({ fs, storage, initialBooks: booksOn(fs) })
  services.bindRecorder(journal)
  services.bindClock(() => clock.now())
  const port = createPeerPort(wire)
  wire.serveBlob = (folder, name) => fs.store.get(`books/${folder}/${name}`) ?? null
  wire.landBlob = async (folder, name, bytes) => {
    await fs.writeFile(`books/${folder}/${name}`, bytes)
  }
  const ledger = createLedger({
    services,
    journal,
    clock,
    device: deviceId,
    role,
    fetchBlob: (peerId, folder, blob) =>
      port.fetchBlob({ peerId, folder, name: blob.name, expectedSize: blob.size, expectedHash: blob.hash }),
    hashFile: (folder, name) => wire.hashFile(folder, name),
    pageLimit: 3,
  })
  return { fs, storage, clock, journal, services, ledger, wire, port }
}

interface World {
  readonly shelf: Stack
  readonly satchel: Stack
  session(): Promise<Awaited<ReturnType<Ledger['runSession']>>>
  channel(): Promise<SyncChannel & { close(): Promise<void> }>
  stopServing(): void
}

async function makeWorld(): Promise<World> {
  const shelfWire = fakeWire({ role: 'shelf', endpointId: `shelf-${nextEndpoint++}` })
  const satchelWire = fakeWire({ role: 'satchel', endpointId: `satchel-${nextEndpoint++}` })
  linkWires(shelfWire, satchelWire)
  shelfWire.addPeer({ id: satchelWire.id, role: 'satchel', grants: ['sync:*', 'blob:*'] })
  satchelWire.addPeer({ id: shelfWire.id, role: 'shelf', grants: ['sync:*', 'blob:*'] })
  const shelf = await makeStack(shelfWire, 'shelf', 'aaaaaaaaaaaaaaaa')
  const satchel = await makeStack(satchelWire, 'satchel', 'bbbbbbbbbbbbbbbb')
  const stop = await shelf.port.serve(shelf.ledger.services())
  return {
    shelf,
    satchel,
    session: async () => {
      const channel = await satchel.port.connect(shelfWire.id)
      try {
        return await satchel.ledger.runSession(channel)
      } finally {
        await channel.close()
      }
    },
    channel: () => satchel.port.connect(shelfWire.id),
    stopServing: stop,
  }
}

const rec = (title: string): BookRecord => ({ title, author: 'A. Author', addedAt: nextWall() })

const mark = (id: string, bookId: string, note = ''): Mark => ({
  id,
  bookId,
  cfi: `epubcfi(/6/4!/4/2,/1:0,/1:5)`,
  sectionIndex: 0,
  text: `passage ${id}`,
  prefix: '',
  suffix: '',
  note,
  kind: 'highlight',
  chapter: 'One',
  createdAt: nextWall(),
})

/** The record as replication sees it, for convergence assertions. */
const wireOf = async (stack: Stack, book: string): Promise<string | null> => {
  const record = await readBook(stack.fs, book).catch(() => null)
  return record === null ? null : canonicalJson(toWire(record))
}

const pushableOutbox = (journal: Journal) =>
  journal.outbox().filter((entry) => (PUSHABLE as readonly string[]).includes(entry.what))

describe('the star protocol over two real stacks (WI-C.2)', () => {
  it('converges after push + pull: books, tags, marks travel both ways', async () => {
    const { shelf, satchel, session } = await makeWorld()
    await shelf.services.library.add('book:a', rec('Alpha'))
    await shelf.services.library.tag('book:a', 'Sea')
    await shelf.services.library.add('book:b', rec('Beta'))
    await shelf.services.marks.open('book:a')
    await shelf.services.marks.add(mark('m1', 'book:a', 'the whale'))
    await satchel.services.library.add('book:c', rec('Gamma'))

    const summary = await session()
    expect(summary.pushed).toBeGreaterThan(0)
    expect(summary.pulledRows).toBeGreaterThanOrEqual(2)

    // Both ends hold the same wire form of every book.
    for (const book of ['book:a', 'book:b', 'book:c']) {
      const ours = await wireOf(satchel, book)
      const theirs = await wireOf(shelf, book)
      expect(ours, book).not.toBeNull()
      expect(ours, book).toEqual(theirs)
    }
    // The mark travelled (its digest differed, sync.marks was pulled).
    const pulled = validMarks(await readMarks(satchel.fs, 'book:a'))
    expect(pulled.map((m) => m.id)).toEqual(['m1'])
    // And the satchel's row derived its tags from the clock the shelf sent.
    const a = await readBook(satchel.fs, 'book:a')
    expect(a?.tags).toEqual(['Sea'])
  })

  it('a second session moves nothing, and a third pulls nothing', async () => {
    const { shelf, satchel, session } = await makeWorld()
    await shelf.services.library.add('book:a', rec('Alpha'))
    await satchel.services.library.add('book:c', rec('Gamma'))
    await session()

    const shelfEntries = shelf.journal.entries().length
    const satchelEntries = satchel.journal.entries().length
    const second = await session()
    // ZERO ECHO: nothing pushed, and the re-served rows were identity
    // merges — neither journal grew a line.
    expect(second.pushed).toBe(0)
    expect(shelf.journal.entries().length).toBe(shelfEntries)
    expect(satchel.journal.entries().length).toBe(satchelEntries)

    const third = await session()
    expect(third.pushed).toBe(0)
    expect(third.pulledRows).toBe(0)
  })

  it('a hub edit pulls once and the next session pushes nothing (zero echo)', async () => {
    const { shelf, satchel, session } = await makeWorld()
    await shelf.services.library.add('book:a', rec('Alpha'))
    await session()

    await shelf.services.library.setFinished('book:a', true)
    const pullIt = await session()
    expect(pullIt.pulledRows).toBeGreaterThanOrEqual(1)
    expect((await readBook(satchel.fs, 'book:a'))?.finished).toBe(true)
    // The pulled application journalled origin: remote — nothing to push.
    expect(pushableOutbox(satchel.journal)).toEqual([])
    const next = await session()
    expect(next.pushed).toBe(0)
  })

  it('kill mid-page, then re-run: no gap, every book arrives', async () => {
    const { shelf, satchel, session } = await makeWorld()
    const titles = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven']
    for (const [i, title] of titles.entries()) await shelf.services.library.add(`book:${i}`, rec(title))

    // The page limit is 3; fail the SECOND pull call — after one durable page.
    const channel = await satchel.port.connect(shelf.wire.id)
    let pulls = 0
    const dying: SyncChannel = {
      peerId: channel.peerId,
      call: (service, body) => {
        if (service === 'sync.pull' && ++pulls === 2) throw new Error('killed mid-session')
        return channel.call(service, body)
      },
    }
    await expect(satchel.ledger.runSession(dying)).rejects.toThrow('killed mid-session')
    await channel.close()

    const applied = satchel.services.library.getSnapshot().length
    expect(applied).toBeGreaterThan(0)
    expect(applied).toBeLessThan(titles.length)
    // The cursor holds the durable page's end — the re-run starts there,
    // re-pulls nothing it has, and misses nothing it lacks.
    const cursor = satchel.services.settings.get(SYNC_CURSOR_SETTING)
    expect(cursor?.since).toBeGreaterThan(0)

    await session()
    expect(satchel.services.library.getSnapshot().length).toBe(titles.length)
    for (const [i] of titles.entries()) {
      expect(await wireOf(satchel, `book:${i}`)).toEqual(await wireOf(shelf, `book:${i}`))
    }
  })

  it('a local edit during the push survives, in the record and on the wire', async () => {
    const { shelf, satchel, session } = await makeWorld()
    await satchel.services.library.add('book:x', rec('Xenon'))
    await session()

    await satchel.services.library.rememberPosition('book:x', 'cfi-1', 0.25)
    const channel = await satchel.port.connect(shelf.wire.id)
    let editDuringPush: Promise<void> | null = null
    const interleaved: SyncChannel = {
      peerId: channel.peerId,
      call: async (service, body) => {
        const answer = await channel.call(service, body)
        if (service === 'sync.push' && editDuringPush === null) {
          /* Enqueued between the shelf's answer and the satchel applying the
           * ack — the exact window where a mislabelled edit would silently
           * never push. NOT awaited here: it interleaves with the ack on the
           * real write queue. */
          editDuringPush = satchel.services.library.rememberPosition('book:x', 'cfi-2', 0.5)
        }
        return answer
      },
    }
    await satchel.ledger.runSession(interleaved)
    await editDuringPush
    await channel.close()

    // The edit is in the record…
    expect((await readBook(satchel.fs, 'book:x'))?.position).toBe('cfi-2')
    // …and still push-eligible: the stale ack's CAS refused it.
    expect(pushableOutbox(satchel.journal).map((e) => `${e.what} ${e.book}`)).toContain('record book:x')

    // The next session carries it to the shelf.
    await session()
    expect((await readBook(shelf.fs, 'book:x'))?.position).toBe('cfi-2')
    expect(pushableOutbox(satchel.journal)).toEqual([])
  })

  it("a delayed ack after a newer pull keeps the pull's winners", async () => {
    const { shelf, satchel } = await makeWorld()
    await satchel.services.library.add('book:x', rec('Xenon'))
    const first = await satchel.port.connect(shelf.wire.id)
    await satchel.ledger.runSession(first)
    await first.close()

    // The satchel decides finished at t1…
    await satchel.services.library.setFinished('book:x', true)
    const channel = await satchel.port.connect(shelf.wire.id)
    const delayed: SyncChannel = {
      peerId: channel.peerId,
      call: async (service, body) => {
        const answer = await channel.call(service, body)
        if (service === 'sync.push') {
          /* …the shelf merges it and answers — and BEFORE the satchel
           * applies that ack, newer state (the shelf un-finishing at t2)
           * arrives as a pull would deliver it: merged in, origin remote. */
          await shelf.services.library.setFinished('book:x', false)
          const newer = await readBook(shelf.fs, 'book:x')
          await satchel.journal.markRemote([{ book: 'book:x', what: 'record' }], async () => {
            await satchel.services.library.update('book:x', () => newer as BookRecord)
          })
        }
        return answer
      },
    }
    await satchel.ledger.runSession(delayed)
    await channel.close()

    // The delayed ack (finished: true, older stamp) did not roll back the
    // pull's winner (finished: false, newer stamp).
    expect((await readBook(satchel.fs, 'book:x'))?.finished).toBe(false)
  })

  it('two satchels editing one book both end equal to the shelf', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: `shelf-${nextEndpoint++}` })
    const wireOne = fakeWire({ role: 'satchel', endpointId: `satchel-${nextEndpoint++}` })
    const wireTwo = fakeWire({ role: 'satchel', endpointId: `satchel-${nextEndpoint++}` })
    linkWires(shelfWire, wireOne)
    linkWires(shelfWire, wireTwo)
    shelfWire.addPeer({ id: wireOne.id, role: 'satchel', grants: ['sync:*', 'blob:*'] })
    shelfWire.addPeer({ id: wireTwo.id, role: 'satchel', grants: ['sync:*', 'blob:*'] })
    wireOne.addPeer({ id: shelfWire.id, role: 'shelf', grants: ['sync:*', 'blob:*'] })
    wireTwo.addPeer({ id: shelfWire.id, role: 'shelf', grants: ['sync:*', 'blob:*'] })
    const shelf = await makeStack(shelfWire, 'shelf', 'aaaaaaaaaaaaaaaa')
    const one = await makeStack(wireOne, 'satchel', 'cccccccccccccccc')
    const two = await makeStack(wireTwo, 'satchel', 'dddddddddddddddd')
    await shelf.port.serve(shelf.ledger.services())
    const sessionFor = async (satchel: Stack) => {
      const channel = await satchel.port.connect(shelfWire.id)
      try {
        return await satchel.ledger.runSession(channel)
      } finally {
        await channel.close()
      }
    }

    await shelf.services.library.add('book:x', rec('Xenon'))
    await sessionFor(one)
    await sessionFor(two)

    // Offline, both edit: one tags, the other (later) finishes.
    await one.services.library.tag('book:x', 'Ocean')
    await two.services.library.setFinished('book:x', true)

    // Push in either order, then everyone pulls until settled.
    await sessionFor(one)
    await sessionFor(two)
    await sessionFor(one)
    await sessionFor(two)

    const atShelf = await wireOf(shelf, 'book:x')
    expect(await wireOf(one, 'book:x')).toEqual(atShelf)
    expect(await wireOf(two, 'book:x')).toEqual(atShelf)
    const record = await readBook(shelf.fs, 'book:x')
    expect(record?.tags).toEqual(['Ocean'])
    expect(record?.finished).toBe(true)
  })

  it('a phone import is acked only after the bytes land, and pushes exactly once', async () => {
    const { shelf, satchel, session } = await makeWorld()
    const bytes = new TextEncoder().encode('the imported epub bytes')
    await satchel.services.library.add('book:imp', { ...rec('Imported'), ext: 'epub', format: 'epub' })
    await satchel.services.library.keepContent('book:imp', 'content.epub', new Blob([bytes]))
    await satchel.services.library.refreshContent('book:imp')
    expect(satchel.services.library.getSnapshot().find((b) => b.bookId === 'book:imp')?.hasContent).toBe(true)

    // First: the transfer cannot happen (the shelf's fetch is refused before
    // a byte — the satchel revoked blob:read) — the push must FAIL and
    // nothing may be acked.
    await satchel.wire.setGrants(shelf.wire.id, ['sync:*'])
    await expect(session()).rejects.toThrow()
    expect(pushableOutbox(satchel.journal).map((e) => e.what)).toContain('record')
    expect(shelf.fs.store.has('books/book_imp/content.epub')).toBe(false)

    // Then the link heals: the same push runs, the bytes land, the ack clears.
    await satchel.wire.setGrants(shelf.wire.id, ['sync:*', 'blob:*'])
    const summary = await session()
    expect(summary.pushed).toBeGreaterThan(0)
    expect(shelf.fs.store.get('books/book_imp/content.epub')).toEqual(bytes)
    expect(shelf.services.library.getSnapshot().find((b) => b.bookId === 'book:imp')?.hasContent).toBe(true)
    expect(pushableOutbox(satchel.journal)).toEqual([])

    // Pushes ONCE: the next session moves nothing.
    const again = await session()
    expect(again.pushed).toBe(0)
  })

  it('download and remove-download push nothing', async () => {
    const { shelf, satchel, session, channel } = await makeWorld()
    const bytes = new TextEncoder().encode('shelf bytes for download')
    await shelf.services.library.add('book:dl', { ...rec('Download me'), ext: 'epub', format: 'epub' })
    await shelf.fs.writeFile('books/book_dl/content.epub', bytes)
    await shelf.services.library.refreshContent('book:dl')
    await session()

    const open = await channel()
    await satchel.ledger.download(open, 'book:dl')
    await open.close()
    expect(satchel.fs.store.get('books/book_dl/content.epub')).toEqual(bytes)
    expect(satchel.services.library.getSnapshot().find((b) => b.bookId === 'book:dl')?.hasContent).toBe(true)
    expect(pushableOutbox(satchel.journal)).toEqual([])

    await satchel.ledger.removeDownload('book:dl')
    expect(satchel.fs.store.has('books/book_dl/content.epub')).toBe(false)
    expect(pushableOutbox(satchel.journal)).toEqual([])
    const after = await session()
    expect(after.pushed).toBe(0)
  })

  it('an epoch mismatch resets the cursor and re-pulls the catalog', async () => {
    const world = await makeWorld()
    const { shelf, satchel, session } = world
    await shelf.services.library.add('book:a', rec('Alpha'))
    await shelf.services.library.add('book:b', rec('Beta'))
    await session()
    const cursor = satchel.services.settings.get(SYNC_CURSOR_SETTING)
    expect(cursor?.since).toBeGreaterThan(0)

    // The shelf's journal is lost (a restore without sync/): a REBUILT
    // journal mints a new epoch over the same folders.
    world.stopServing()
    const view = new Map(shelf.fs.store)
    for (const key of [...view.keys()]) if (key.startsWith('sync/')) view.delete(key)
    const rebuilt = await makeStack(shelf.wire, 'shelf', 'aaaaaaaaaaaaaaaa', fsOver(view))
    await rebuilt.port.serve(rebuilt.ledger.services())

    const summary = await session()
    // since reset to 0: the whole catalog came again, and merged silently.
    expect(summary.pulledRows).toBeGreaterThanOrEqual(2)
    const after = satchel.services.settings.get(SYNC_CURSOR_SETTING)
    expect(after?.epoch).not.toBe(cursor?.epoch)
    expect(await wireOf(satchel, 'book:a')).toEqual(await wireOf(rebuilt, 'book:a'))
  })

  it('a crash between the file write and the commit is recovered and served', async () => {
    const world = await makeWorld()
    const { shelf, satchel, session } = world
    await shelf.services.library.add('book:a', rec('Alpha'))
    await session()

    // The shelf writes the folder, journals `begin` — and dies before commit.
    await shelf.journal.begin('book:a', 'record')
    const held = await readBook(shelf.fs, 'book:a')
    const edited: BookRecord = { ...(held as BookRecord), position: 'cfi-crash', positionAt: shelf.clock.now() }
    await shelf.fs.writeFile('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(edited)))

    // Restart the shelf over the exact bytes.
    world.stopServing()
    const revived = await makeStack(shelf.wire, 'shelf', 'aaaaaaaaaaaaaaaa', fsOver(new Map(shelf.fs.store)))
    await revived.port.serve(revived.ledger.services())

    // Recovery committed the dangling begin; the feed serves the edit.
    const summary = await session()
    expect(summary.pulledRows).toBeGreaterThanOrEqual(1)
    expect((await readBook(satchel.fs, 'book:a'))?.position).toBe('cfi-crash')
  })

  it('a satchel removal travels; a shelf removal reaches the satchel', async () => {
    const { shelf, satchel, session } = await makeWorld()
    await shelf.services.library.add('book:a', rec('Alpha'))
    await shelf.services.library.add('book:b', rec('Beta'))
    await session()

    // Shelf removes A; the satchel hears it on pull.
    await shelf.services.library.remove('book:a')
    await session()
    expect(satchel.services.library.getSnapshot().map((b) => b.bookId).sort()).toEqual(['book:b'])
    expect((await readPresence(satchel.fs))['book:a']?.state).toBe('removed')

    // Satchel removes B; the shelf hears it on push.
    await satchel.services.library.remove('book:b')
    await session()
    expect(shelf.services.library.getSnapshot()).toEqual([])
    expect((await readPresence(shelf.fs))['book:b']?.state).toBe('removed')
    expect(pushableOutbox(satchel.journal)).toEqual([])
  })

  it('a role mismatch is refused typed before any state moves', async () => {
    const { shelf, satchel } = await makeWorld()
    const rogue = createLedger({
      services: satchel.services,
      journal: satchel.journal,
      clock: satchel.clock,
      device: 'bbbbbbbbbbbbbbbb',
      role: 'shelf', // a shelf dialing a shelf
    })
    const before = shelf.journal.entries().length
    const channel = await satchel.port.connect(shelf.wire.id)
    await expect(rogue.runSession(channel)).rejects.toMatchObject({ error: { code: 'unsupported' } })
    await channel.close()
    // Nothing was written before the refusal.
    expect(shelf.journal.entries().length).toBe(before)
  })
})
