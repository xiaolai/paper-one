import { describe, expect, it, vi } from 'vitest'
import {
  createKernelServices,
  parseRecord,
  readBook,
  readMarks,
  readPresence,
  validMarks,
  writeQueue,
  type BookRecord,
  type Card,
  type IndexedBook,
  type KernelServices,
  type Mark,
} from '../../../kernel'
import { createPeerPort, fakeBlobHash, fakeWire, linkWires, type FakeWire, type PeerPort } from '../../peer'
import { createClock, makeHlc, type Clock } from './clock'
import { JOURNAL_KEY, createJournal, type Journal } from './journal'
import { crashableFs, fsOver, type CrashableFs } from './journalFs.testkit'
import { SYNC_CURSOR_SETTING, createLedger, type Ledger, type SyncChannel, type SyncSummary } from './ledger'
import { SYNC_QUARANTINE_SETTING } from './quarantine'
import { describeSession } from './status'
import { SYNC_JOURNAL_FORMAT, SYNC_PROTO, SYNC_VERSION } from './protocol'
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
  /** The journal's own write queue — so a test can hold journal appends. */
  readonly journalQueue: ReturnType<typeof writeQueue>
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
  /* Services FIRST: the journal's cards baseline reads the kernel's card
   * store (WI-10.4), so the store must exist before the journal opens. */
  const services = createKernelServices({ fs, storage, initialBooks: booksOn(fs) })
  /* THE KERNEL'S OWN QUEUE AND LANES, as both compositions wire it — the
   * world used to give the journal a private queue with the default raw
   * lane, and the fence ordering under test here (`JournalOptions.lane`'s
   * note) degraded to inline arming: the one seam the interleaving tests
   * exist for was the one seam the world wired differently. */
  const journalQueue = services.writes
  const journal = createJournal({
    fs,
    queue: journalQueue,
    lane: (book, what) => (what === 'cards' ? '' : services.library.lane(book)),
    clock: () => clock.now(),
    cards: () => services.cards.stored(),
  })
  await journal.open()
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
  return { fs, storage, clock, journal, journalQueue, services, ledger, wire, port }
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
  tint: 'yellow',
  style: 'fill',
  chapter: 'One',
  createdAt: nextWall(),
})

const cardOf = (id: string): Card => ({
  id,
  bookId: 'book:a',
  kind: 'Excerpt',
  body: `body ${id}`,
  answer: '',
  source: 'One',
  cfi: null,
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

  it('a book.json that will not read blocks the ack and holds the cursor — never a silently absent row', async () => {
    // PUSH side: the pusher's own copy breaks between the commit and the push.
    const pushWorld = await makeWorld()
    await pushWorld.satchel.services.library.add('book:x', rec('Xenon'))
    pushWorld.satchel.fs.store.set('books/book_x/book.json', new TextEncoder().encode('not json at all'))
    await expect(pushWorld.session()).rejects.toMatchObject({ code: 'unreadable' })
    // Nothing was acked; the row is still what there is to push.
    expect(pushableOutbox(pushWorld.satchel.journal).map((e) => `${e.what} ${e.book}`)).toContain('record book:x')

    // PULL side: the shelf cannot serve a row it holds but cannot read — the
    // page fails and the cursor must not advance past the unserved row.
    const pullWorld = await makeWorld()
    await pullWorld.shelf.services.library.add('book:z', rec('Zeta'))
    pullWorld.shelf.fs.store.set('books/book_z/book.json', new TextEncoder().encode('not json at all'))
    await expect(pullWorld.session()).rejects.toMatchObject({ error: { code: 'unreadable' } })
    expect(pullWorld.satchel.services.settings.get(SYNC_CURSOR_SETTING)).toBeNull()
  })

  it('an ack that does not name the pushed group acks nothing', async () => {
    const { shelf, satchel, session } = await makeWorld()
    await satchel.services.library.add('book:m', rec('Mismatch'))
    const channel = await satchel.port.connect(shelf.wire.id)
    const lying: SyncChannel = {
      peerId: channel.peerId,
      call: async (service, body) => {
        const answer = await channel.call(service, body)
        // A perfectly valid SHAPE that confirms nothing it was sent.
        if (service === 'sync.push') return { book: (body as { book: string }).book, revs: {} }
        return answer
      },
    }
    await expect(satchel.ledger.runSession(lying)).rejects.toThrow(/does not match/)
    await channel.close()
    expect(pushableOutbox(satchel.journal).map((e) => `${e.what} ${e.book}`)).toContain('record book:m')

    // An honest session then settles exactly that revision.
    await session()
    expect(pushableOutbox(satchel.journal)).toEqual([])
  })

  it('a pull page is judged against the cursor: non-advancing and regressing pages are refused', async () => {
    const { satchel } = await makeWorld()
    const answering = (page: unknown, hubSeq: number): SyncChannel => ({
      peerId: 'fake-shelf',
      call: async (service) => {
        if (service === 'sync.hello') {
          return {
            clock: makeHlc(1, 0, 'eeeeeeeeeeeeeeee'),
            epoch: 'e-fake',
            hubSeq,
            journalFormat: 1,
            // Speaks this build's version — an earlier one is refused, see SYNC_VERSION.
            services: { sync: [5, 5] },
          }
        }
        if (service === 'sync.pull') return page
        throw new Error(`unexpected call: ${service}`)
      },
    })
    // Not advancing and not terminal: an infinite loop, refused instead.
    await expect(
      satchel.ledger.runSession(answering({ rows: [], removals: [], nextSince: 0, done: false }, 10)),
    ).rejects.toThrow(/does not advance/)
    // Regressing behind the held cursor: a skip or a replay, refused.
    satchel.services.settings.set(SYNC_CURSOR_SETTING, { peerId: 'fake-shelf', epoch: 'e-fake', since: 5 })
    await expect(
      satchel.ledger.runSession(answering({ rows: [], removals: [], nextSince: 3, done: true }, 10)),
    ).rejects.toThrow(/outside/)
    // Past the head the hello promised: refused.
    await expect(
      satchel.ledger.runSession(answering({ rows: [], removals: [], nextSince: 99, done: true }, 10)),
    ).rejects.toThrow(/outside/)
    // And the refused pages moved the cursor nowhere.
    expect(satchel.services.settings.get(SYNC_CURSOR_SETTING)).toMatchObject({ since: 5 })
  })

  it('every stamp a pushed message carries is witnessed — a later local stamp beats it', async () => {
    const { shelf } = await makeWorld()
    const future = makeHlc(4_000_000_000_000, 0, 'ffffffffffffffff')
    const push = shelf.ledger.services().find((one) => one.name === 'sync.push')!
    await push.handler(
      {
        book: 'book:far',
        revs: { record: 1 },
        hasContent: false,
        record: { title: 'From the future', author: 'A', position: 'cfi-far', positionAt: future },
      },
      { peer: 'satchel-x' } as unknown as Parameters<typeof push.handler>[1],
    )
    // Post-hello state on a skewed clock must not outrank the shelf's next
    // local edit: the merge already applied `future`, so the next stamp the
    // shelf issues has to be strictly above it.
    expect(shelf.clock.now() > future).toBe(true)
  })

  it('a local card edit interleaved with a remote card apply keeps the local edit pushable', async () => {
    const { shelf, satchel, session } = await makeWorld()
    await shelf.services.cards.add(cardOf('c-shelf'))

    /* Hold the satchel's journal, so begins QUEUE rather than run — the
     * window in which a local edit and the remote apply are both in flight
     * on the one cards surface. */
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    void satchel.journalQueue.append(JOURNAL_KEY, () => gate)

    let localEdit: Promise<void> | null = null
    const channel = await satchel.port.connect(shelf.wire.id)
    const interleaved: SyncChannel = {
      peerId: channel.peerId,
      call: async (service, body) => {
        const answer = await channel.call(service, body)
        if (service === 'sync.pull' && localEdit === null) {
          /* Enqueued between the shelf's answer and the satchel applying the
           * page — with cards unfenced, the local begin consumed the remote
           * expectation here and the edit was journaled `remote`: an edit
           * that never pushes. NOT awaited: it interleaves on the queue. */
          localEdit = satchel.services.cards.add(cardOf('c-local'))
          setTimeout(openGate, 20)
        }
        return answer
      },
    }
    const summary = await satchel.ledger.runSession(interleaved)
    await localEdit
    await channel.close()
    expect(summary.pulledCards).toBe(true)

    // The remote apply journaled remote; the local edit stayed local and pushable.
    const origins = satchel.journal.entries().filter((e) => e.kind === 'commit' && e.what === 'cards').map((e) => e.origin)
    expect(origins).toContain('local')
    expect(origins).toContain('remote')
    expect(pushableOutbox(satchel.journal).map((e) => e.what)).toContain('cards')

    // And the next session carries the local card to the shelf.
    await session()
    const held = JSON.parse(shelf.storage.map.get('paper.cards.v1') ?? '[]') as { id: string }[]
    expect(held.map((one) => one.id).sort()).toEqual(['c-local', 'c-shelf'])
    expect(pushableOutbox(satchel.journal)).toEqual([])
  })

  it('a local record edit interleaved with a remote record apply keeps the local edit pushable', async () => {
    /* The cards case above passed from the day it was written — the cards
     * lane IS the raw `''` — while the book case failed silently: the
     * ledger's fence armed on the raw book id and the library writes on
     * `books/<safeId>`, so the fence ordered nothing. The journal fixed the
     * same defect once (`JournalOptions.lane`'s note) and the ledger's own
     * fence had kept the pre-fix key; `applyRemote` now goes through
     * `journal.markRemote`, which arms on the surface's real lane. */
    const { shelf, satchel, session } = await makeWorld()
    await shelf.services.library.add('book:fence', rec('Fence'))
    await satchel.services.library.add('book:fence', rec('Fence'))
    await session()

    await shelf.services.library.tag('book:fence', 'FromShelf')

    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    /* Held on the BOOK'S OWN LANE: the local edit below is queued behind the
     * gate, unbegun, when the remote apply arms its fence — the exact window
     * in which a raw-keyed fence arms on an empty lane and the local begin
     * then consumes the remote expectation. */
    void satchel.services.writes.append(satchel.services.library.lane('book:fence'), () => gate)

    let localEdit: Promise<void> | null = null
    const channel = await satchel.port.connect(shelf.wire.id)
    const interleaved: SyncChannel = {
      peerId: channel.peerId,
      call: async (service, body) => {
        const answer = await channel.call(service, body)
        if (service === 'sync.pull' && localEdit === null) {
          /* Enqueued between the shelf's answer and the satchel applying the
           * row — the window in which the satchel's own edit and the remote
           * apply are both in flight on one book's surface. NOT awaited: it
           * interleaves on the queue. */
          localEdit = satchel.services.library.tag('book:fence', 'FromSatchel')
          setTimeout(openGate, 20)
        }
        return answer
      },
    }
    await satchel.ledger.runSession(interleaved)
    await localEdit
    await channel.close()

    // The remote apply journaled remote; the local edit stayed local and pushable.
    /* ATTRIBUTION, EXACTLY — not mere presence. The raw-keyed fence armed
     * before the gated local edit began, so the LOCAL tag consumed the remote
     * expectation and journaled `remote` (unpushable) while the remote apply
     * journaled `local` (an echo): both origins present, both swapped, and a
     * containment assertion is blind to the swap. The gate makes the order
     * deterministic: the local tag begins first. */
    const afterAck = satchel.journal
      .entries()
      .filter((e) => e.kind === 'commit' && e.what === 'record' && e.book === 'book:fence')
      .map((e) => e.origin)
      .slice(1) // the setup add's own commit
    // First-session pull, then this session's pair: the gated local tag
    // begins first and is LOCAL; the remote apply follows and is REMOTE.
    expect(afterAck).toEqual(['remote', 'local', 'remote'])
    expect(pushableOutbox(satchel.journal).map((e) => `${e.book}/${e.what}`)).toContain('book:fence/record')

    // And the next session carries the satchel's tag to the shelf.
    await session()
    const held = shelf.services.library.getSnapshot().find((one) => one.bookId === 'book:fence')
    expect(held?.tags ?? []).toEqual(expect.arrayContaining(['FromShelf', 'FromSatchel']))
    expect(pushableOutbox(satchel.journal)).toEqual([])
  })

  /**
   * ⚠️ **THE PRESENCE CHECK REOPENED THE HOLE THE FENCE WAS BUILT TO CLOSE.**
   *
   * `applyRemote` requires every `run` to ENQUEUE SYNCHRONOUSLY: the fence
   * task arms the journal's one-shot remote expectation on the surface's own
   * lane, and the apply is enqueued in the same synchronous block, so nothing
   * can land between the two. The pull door's add then grew a check — "a
   * record for a book this device REMOVED must not re-add it" — written as an
   * `await readPresence(fs)` INSIDE `run`. That await is the gap: a local
   * write enqueued in it begins first, consumes the remote expectation, and
   * is journaled `remote` — dropped from the outbox and never pushed, while
   * the remote apply behind it journals `local`, an echo. Both origins are
   * present and both are wrong, which is why this asserts the SEQUENCE.
   *
   * The same import on two devices is the ordinary way to meet it: a book id
   * is derived from the bytes, so importing one file on the phone while the
   * shelf's row for it is being pulled is one book id, two writers, one lane.
   */
  it('a local add interleaved with a pulled add for the same book keeps the local edit pushable', async () => {
    const { shelf, satchel } = await makeWorld()
    /* Only on the shelf, so the satchel's pull treats it as an ADD. */
    await shelf.services.library.add('book:both', rec('Both'))

    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    void satchel.services.writes.append(satchel.services.library.lane('book:both'), () => gate)

    /* THE WINDOW, ENTERED WHERE IT ACTUALLY IS. The presence register is read
       once per pulled page, and the read is the only thing that moved: in the
       old code it happened INSIDE the apply, after the fence had armed, and
       now it happens before `applyRemote` is called at all. Hooking it puts
       the local write exactly where each version leaves the gap — in the gap
       for one, ahead of the fence for the other, which is the whole
       difference under test. Fired BEFORE the read is served, so an absent
       register (the ordinary case) still reaches it. */
    let pulling = false
    let localAdd: Promise<unknown> | null = null
    const readFile = satchel.fs.readFile
    satchel.fs.readFile = async (path: string) => {
      if (path === 'sync/removed.json' && pulling && localAdd === null) {
        localAdd = satchel.services.library.add('book:both', rec('Both, imported here'))
        setTimeout(openGate, 20)
      }
      return readFile(path)
    }

    const channel = await satchel.port.connect(shelf.wire.id)
    const interleaved: SyncChannel = {
      peerId: channel.peerId,
      call: async (service, body) => {
        const answer = await channel.call(service, body)
        /* Only the page's own apply may trip the hook: the satchel reads the
           register on its push side too, long before any of this. */
        if (service === 'sync.pull') pulling = true
        return answer
      },
    }
    try {
      await satchel.ledger.runSession(interleaved)
      await localAdd
    } finally {
      satchel.fs.readFile = readFile
      await channel.close()
    }
    expect(localAdd, 'the pulled page read no presence register, so this proves nothing').not.toBeNull()

    /* ATTRIBUTION, IN ORDER — not mere presence. The gated local add begins
       first and is LOCAL; the pulled add follows and is REMOTE. Swap them and
       the reader's own import is the thing that never leaves the phone. */
    const origins = satchel.journal
      .entries()
      .filter((e) => e.kind === 'commit' && e.what === 'record' && e.book === 'book:both')
      .map((e) => e.origin)
    expect(origins).toEqual(['local', 'remote'])
    expect(pushableOutbox(satchel.journal).map((e) => `${e.book}/${e.what}`)).toContain('book:both/record')
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

describe('carried findings — removals, content facts, and covers', () => {
  const pushHandler = (stack: Stack) => stack.ledger.services().find((one) => one.name === 'sync.push')!
  const asCtx = (handler: ReturnType<typeof pushHandler>['handler']) =>
    ({ peer: 'satchel-x' }) as unknown as Parameters<typeof handler>[1]

  /**
   * WI-20.1 — A PAGE TURN THAT UNDID A REMOVAL, and the three refute rounds
   * that shaped the fix. A record-only push for a book the shelf removed used
   * to reach `library.add` and restore it; a genuine restore must still win
   * when it is newer. The distinction is INTENT (a restore carries `live`),
   * ordered by the restore's own stamp, applied on the book's lane.
   */
  describe('WI-20.1 — a removed book is not resurrected by a stale record', () => {
    const pushTo = async (stack: Stack, group: Record<string, unknown>) => {
      const push = pushHandler(stack)
      return push.handler(group as never, asCtx(push.handler))
    }
    const removedAt = async (stack: Stack, book: string) => (await readPresence(stack.fs))[book]
    /* The wall ms a stamp encodes — its first hex field — so a test can build
       one a hair newer or older than the removal without an implausible year. */
    const wallOf = (h: string) => parseInt(h.split('-')[0]!, 16)
    const near = (ms: number) => makeHlc(ms, 0, 'ffffffffffffffff')

    it('(a) a stale record — a page turn older than the removal — leaves the book removed', async () => {
      const { shelf } = await makeWorld()
      await shelf.services.library.add('book:x', rec('Xenon'))
      await shelf.services.library.remove('book:x') // removed @ tR
      const stalePage = { ...rec('Xenon'), position: 'cfi-1', positionAt: makeHlc(1, 0, 'ffffffffffffffff') }
      await pushTo(shelf, { book: 'book:x', revs: { record: 1 }, hasContent: false, record: stalePage })
      expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:x')
      expect((await removedAt(shelf, 'book:x'))?.state).toBe('removed')
    })

    it('(b) a record NEWER than the removal, but no restore intent, still leaves it removed', async () => {
      const { shelf } = await makeWorld()
      await shelf.services.library.add('book:x', rec('Xenon'))
      await shelf.services.library.remove('book:x')
      /* A page turn stamped in the far future — newer than the removal, and
         still not a re-add. Intent, not stamps, is what decides. */
      const removal = wallOf((await removedAt(shelf, 'book:x'))!.at)
      const laterPage = { ...rec('Xenon'), position: 'cfi-2', positionAt: near(removal + 1_000) }
      await pushTo(shelf, { book: 'book:x', revs: { record: 1 }, hasContent: false, record: laterPage })
      expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:x')
      expect((await removedAt(shelf, 'book:x'))?.state).toBe('removed')
    })

    it('(c) a restore whose stamp beats the removal brings the book back', async () => {
      const { shelf } = await makeWorld()
      await shelf.services.library.add('book:x', rec('Xenon'))
      await shelf.services.library.remove('book:x')
      const held = await readPresence(shelf.fs)
      const later = near(wallOf(held['book:x']!.at) + 1_000)
      await pushTo(shelf, { book: 'book:x', revs: { removed: 1 }, hasContent: false, record: toWire(rec('Xenon')), live: { at: later } })
      expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).toContain('book:x')
      expect((await removedAt(shelf, 'book:x'))?.state).toBe('live')
      expect(held['book:x']?.state).toBe('removed') // it really was removed first
    })

    it('(e) a restore OLDER than the shelf\'s own removal loses', async () => {
      const { shelf } = await makeWorld()
      await shelf.services.library.add('book:x', rec('Xenon'))
      await shelf.services.library.remove('book:x') // removed @ tR (a fresh, large wall time)
      const older = near(wallOf((await readPresence(shelf.fs))['book:x']!.at) - 1_000)
      await pushTo(shelf, { book: 'book:x', revs: { removed: 1 }, hasContent: false, record: toWire(rec('Xenon')), live: { at: older } })
      expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:x')
      expect((await removedAt(shelf, 'book:x'))?.state).toBe('removed')
    })

    it('a genuine restore travels end to end: a re-added book comes back on the far side', async () => {
      const { shelf, satchel, session } = await makeWorld()
      await shelf.services.library.add('book:a', rec('Alpha'))
      await session() // both hold it
      await satchel.services.library.remove('book:a')
      await session() // the shelf hears the removal
      expect(shelf.services.library.getSnapshot()).toEqual([])
      await satchel.services.library.add('book:a', rec('Alpha')) // re-add on the satchel
      await session()
      expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).toContain('book:a')
      expect((await readPresence(shelf.fs))['book:a']?.state).toBe('live')
    })

    /* ⚠️ **PINNED, AND THE PIN MOVES WITH EVERY VOCABULARY WIDENING.** [3, 3]
       made `live` safe against a shelf from before it; [4, 4] since WI-21.3
       makes `identifier` and `metaSchema` safe against a shelf that would strip
       them, ACK the stripped row and erase the sender's own field. Same defect,
       third version. */
    it('speaks [5, 5]: the version bump that keeps a v4 peer from erasing the reader’s own rating', () => {
      /* [5, 5] since WI-23.B3 — `status`, `rating` and `review` are fields a
         v4 `parseRecord` strips, ACKs and thereby erases. Same defect, fourth
         version. */
      expect(SYNC_VERSION).toEqual([5, 5])
    })

    /* (i) THE BUMP IS THE WHOLE SAFETY OF `live.at` against a peer from before
       it existed: a [2, 2] shelf ignores the stamp and mints a fresh clock for
       a restore, a [2, 2] satchel never sends one. So each side refuses the
       other's range at the hello — typed, because the status line reads the
       code — and the sentence names both ranges, which is what a reader with
       two builds will need. The refusal exists on both sides; these are the
       cases that drive it, since a version pin alone proves only the number. */
    it('(i) a hello speaking [2, 2] is refused by the shelf — typed, naming both ranges', async () => {
      const { shelf } = await makeWorld()
      const hello = shelf.ledger.services().find((one) => one.name === 'sync.hello')!
      const older = {
        proto: SYNC_PROTO,
        journalFormat: SYNC_JOURNAL_FORMAT,
        services: { sync: [2, 2] },
        device: 'bbbbbbbbbbbbbbbb',
        role: 'satchel',
        clock: makeHlc(1, 0, 'bbbbbbbbbbbbbbbb'),
      }
      await expect(hello.handler(older as never, asCtx(hello.handler))).rejects.toMatchObject({
        code: 'unsupported',
        message: expect.stringMatching(/\[2, 2\].*\[5, 5\]/),
      })
    })

    it('(i) a welcome speaking [2, 2] is refused by the satchel — typed, naming both ranges', async () => {
      const { satchel } = await makeWorld()
      const olderShelf: SyncChannel = {
        peerId: 'old-shelf',
        call: async (service) => {
          if (service === 'sync.hello') {
            return {
              clock: makeHlc(1, 0, 'eeeeeeeeeeeeeeee'),
              epoch: 'e-old',
              hubSeq: 0,
              journalFormat: SYNC_JOURNAL_FORMAT,
              services: { sync: [2, 2] },
            }
          }
          throw new Error(`the session went past a hello it should have refused: ${service}`)
        },
      }
      await expect(satchel.ledger.runSession(olderShelf)).rejects.toMatchObject({
        code: 'unsupported',
        message: expect.stringMatching(/\[2, 2\].*\[5, 5\]/),
      })
    })

    /* THE TENTH: the marks-only variant, which the finding calls the worse
       one. A highlight made on a satchel that has not heard of the removal
       arrives as `revs.marks` and the marks — no record, no restore intent.
       Applied, `marks.mergeRemote` would `mkdir` `books/book_x/marks.json`
       beside `trash/book_x/`: a ghost folder the shelf shows as a book with no
       record. The guard skips it for a removed book with no `live`; the revs
       are acked so the satchel stops offering them, and its pull carries the
       removal. */
    it('the tenth — a marks-only group for a removed book writes no ghost folder, and its revs are acked', async () => {
      const { shelf } = await makeWorld()
      await shelf.services.library.add('book:x', rec('Xenon'))
      /* The detector against a known positive first: this is the folder a
         ghost would appear under, so the empty assertions below mean
         something. */
      expect(shelf.fs.store.has('books/book_x/book.json')).toBe(true)
      await shelf.services.library.remove('book:x')
      const ghost = () => [...shelf.fs.store.keys()].filter((k) => k.startsWith('books/book_x/'))
      expect(ghost()).toEqual([])
      /* The store refuses a write for a folder that is not there too (it
         checks before and after, and says so on the console) — so "no ghost"
         alone would hold with the ledger's guard gone. The ledger's rule is
         that a removed book with no restore intent is dropped BEFORE the store
         is asked, the same rule the record follows; the spy is what makes that
         the thing under test. */
      const merge = vi.spyOn(shelf.services.marks, 'mergeRemote')
      const ack = await pushTo(shelf, { book: 'book:x', revs: { marks: 1 }, hasContent: false, marks: [mark('m1', 'book:x', 'late')] })
      expect(merge).not.toHaveBeenCalled()
      merge.mockRestore()
      expect(ghost()).toEqual([])
      expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:x')
      expect((await removedAt(shelf, 'book:x'))?.state).toBe('removed')
      expect(ack).toMatchObject({ book: 'book:x', revs: { marks: 1 } })
    })

    it('the tenth, end to end — a satchel that marks a book the shelf removed ends with it removed too', async () => {
      const { shelf, satchel, session } = await makeWorld()
      await shelf.services.library.add('book:a', rec('Alpha'))
      await session() // both hold it
      await shelf.services.library.remove('book:a')
      await satchel.services.marks.open('book:a')
      await satchel.services.marks.add(mark('m1', 'book:a', 'unaware of the removal'))
      await session() // the satchel pushes its mark, then pulls the removal
      expect([...shelf.fs.store.keys()].filter((k) => k.startsWith('books/book_a/'))).toEqual([])
      expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:a')
      expect((await removedAt(shelf, 'book:a'))?.state).toBe('removed')
      expect(satchel.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:a')
      expect((await removedAt(satchel, 'book:a'))?.state).toBe('removed')
      expect(pushableOutbox(satchel.journal)).toEqual([])
    })

    /* (h) THE FAILPOINT, swept rather than picked. Round 3's objection was
       that a `removed` bracket begun AFTER observing the restore is lost to a
       crash between the presence flip and the begin — the recorder has no
       abort — while one begun unconditionally dirties every ordinary add. The
       answer was a pre-check inside the lane: `add` reads the register first
       and, only for a book it says is removed, runs the restore and the flip
       INSIDE `recorded(…, 'removed', …)`, before the record's own bracket.
       So the invariant is that at no crash point is the register live for the
       book without a `removed` rev in the journal — the begin precedes the
       flip, and a dangling begin is committed by launch recovery. The whole
       add is run over a crashable fs and every op boundary is reopened under
       every durability policy; a design that begins by observation fails
       this under `all` at the boundary between the flip and the begin. The
       removal's own rev is acked first, as a session would have, so the only
       `removed` the outbox can hold is the re-add's. `book:y` is the control:
       an ordinary add that must leave no phantom removal at any point. */
    it('(h) at no crash point during a re-add is the register live without a removed rev in the journal', async () => {
      const { shelf } = await makeWorld()
      const whats = (journal: Journal, book: string) => pushableOutbox(journal).filter((e) => e.book === book).map((e) => e.what)
      await shelf.services.library.add('book:x', rec('Xenon'))
      await shelf.services.library.remove('book:x')
      for (const entry of pushableOutbox(shelf.journal).filter((e) => e.book === 'book:x')) {
        await shelf.journal.ack('book:x', entry.what as 'record' | 'removed', entry.rev)
      }
      expect(whats(shelf.journal, 'book:x')).toEqual([])
      const start = shelf.fs.ops.length

      await shelf.services.library.add('book:x', rec('Xenon')) // the re-add
      await shelf.services.library.add('book:y', rec('Yttrium')) // the control

      expect(whats(shelf.journal, 'book:x').sort()).toEqual(['record', 'removed'])
      expect(whats(shelf.journal, 'book:y')).toEqual(['record'])
      expect((await removedAt(shelf, 'book:x'))?.state).toBe('live')

      /* THE ORDER ITSELF, read off the op log, because the sweep below cannot
         tell the two designs apart on its own: the journal's unclean-shutdown
         verify pass re-digests every key on open and commits a fresh rev for
         a register that moved — a second net under the lost-begin case. The
         pre-check is the first, and it is only a pre-check if the `removed`
         begin reaches the journal BEFORE the register is written live. */
      const ops = shelf.fs.ops.slice(start)
      const beginAt = ops.findIndex(
        (op) =>
          op.kind === 'append' &&
          op.path === 'sync/journal.jsonl' &&
          new TextDecoder()
            .decode(op.bytes)
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { kind: string; what: string; book: string })
            .some((e) => e.kind === 'begin' && e.what === 'removed' && e.book === 'book:x'),
      )
      const flipAt = ops.findIndex((op) => (op.kind === 'write' || op.kind === 'rename') && (op.to ?? op.path).endsWith('removed.json'))
      expect(beginAt, 'the removed begin was never journaled').toBeGreaterThanOrEqual(0)
      expect(flipAt, 'the register was never written').toBeGreaterThanOrEqual(0)
      expect(beginAt, 'the removed bracket must be begun before the register goes live').toBeLessThan(flipAt)

      let liveAt = 0
      for (const policy of ['all', 'torn', 'none'] as const) {
        for (let k = start; k < shelf.fs.ops.length; k++) {
          const view = fsOver(shelf.fs.durableView(k, policy))
          const reopened = await makeStack(fakeWire({ role: 'shelf', endpointId: `crash-${policy}-${k}` }), 'shelf', 'aaaaaaaaaaaaaaaa', view)
          const where = `${policy} after op ${k}`
          if ((await readPresence(reopened.fs))['book:x']?.state === 'live') {
            liveAt += 1
            expect(whats(reopened.journal, 'book:x'), `${where}: the register is live and the journal holds no removed rev`).toContain('removed')
          }
          expect(whats(reopened.journal, 'book:y'), `${where}: a phantom removal on an ordinary add`).not.toContain('removed')
        }
      }
      /* The sweep must have SEEN the live state, or it proved nothing. */
      expect(liveAt).toBeGreaterThan(0)
    })
  })

  it('#13 a stale removal does not beat a newer re-add already in the presence register', async () => {
    const { shelf } = await makeWorld()
    await shelf.services.library.add('book:x', rec('Xenon'))
    await shelf.services.library.remove('book:x') // presence {removed, tA}
    await shelf.services.library.add('book:x', rec('Xenon')) // re-add restores: {live, tB > tA}
    expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).toContain('book:x')

    // A removal stamped in the distant past — older than the re-add — arrives.
    const stale = makeHlc(1, 0, 'ffffffffffffffff')
    const push = pushHandler(shelf)
    await push.handler({ book: 'book:x', revs: { removed: 1 }, hasContent: false, removed: { at: stale } }, asCtx(push.handler))

    // The stale removal LOST the register: the book stays, still live — a fresh
    // mint would have removed it.
    expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).toContain('book:x')
    expect((await readPresence(shelf.fs))['book:x']?.state).toBe('live')
  })

  it('#15 a hasContent push with no verifiable way to fetch is refused, never acked', async () => {
    const { shelf } = await makeWorld()
    const push = pushHandler(shelf)
    // Claims content the shelf lacks, but sends no contentHash — un-fetchable,
    // un-verifiable, and so un-ackable.
    await expect(
      push.handler(
        { book: 'book:y', revs: { record: 1 }, hasContent: true, record: toWire(rec('Ylang')) },
        asCtx(push.handler),
      ),
    ).rejects.toMatchObject({ code: 'content-unavailable' })
    // Nothing was applied before the refusal.
    expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:y')
  })

  it('#16 a shelf with bytes but no stored hash hashes them, and refuses a conflicting push', async () => {
    const { shelf } = await makeWorld()
    await shelf.services.library.add('book:z', { ...rec('Zeta'), ext: 'epub', format: 'epub' })
    await shelf.fs.writeFile('books/book_z/content.epub', new TextEncoder().encode('the shelf bytes'))
    await shelf.services.library.refreshContent('book:z') // hasContent, but the record stores no hash
    expect(shelf.services.library.getSnapshot().find((b) => b.bookId === 'book:z')?.hasContent).toBe(true)

    const push = pushHandler(shelf)
    // A different hash than the shelf's actual bytes — a conflict, judged by
    // HASHING the held bytes rather than trusting an absent stored hash.
    await expect(
      push.handler(
        { book: 'book:z', revs: { record: 1 }, hasContent: true, contentHash: 'a'.repeat(64), format: 'epub', record: toWire(rec('Zeta')) },
        asCtx(push.handler),
      ),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('#17 a content push carries a verified size even when the record already stores a hash', async () => {
    const { shelf, satchel } = await makeWorld()
    const bytes = new TextEncoder().encode('some epub bytes to size and hash')
    await satchel.services.library.add('book:s', { ...rec('Sized'), ext: 'epub', format: 'epub' })
    await satchel.fs.writeFile('books/book_s/content.epub', bytes)
    await satchel.services.library.refreshContent('book:s')
    // A stored hash, as the lazy backfill leaves — the old path then pushed it
    // with no size at all.
    await satchel.services.library.update('book:s', (record) => ({ ...record, contentHash: 'b'.repeat(64) }))

    let pushed: Record<string, unknown> | null = null
    const channel = await satchel.port.connect(shelf.wire.id)
    const spy: SyncChannel = {
      peerId: channel.peerId,
      call: async (service, body) => {
        if (service === 'sync.push' && (body as { book?: string }).book === 'book:s') pushed = body as Record<string, unknown>
        return channel.call(service, body)
      },
    }
    await satchel.ledger.runSession(spy).catch(() => {})
    await channel.close()
    expect(pushed).not.toBeNull()
    expect(pushed!['hasContent']).toBe(true)
    expect(pushed!['size']).toBeGreaterThan(0)
  })

  it('#21 a cover is fetched even when the content is already present', async () => {
    const { shelf, satchel } = await makeWorld()
    const bytes = new TextEncoder().encode('shared epub bytes')
    const coverBytes = new TextEncoder().encode('a jacket')
    // The satchel holds the book, its content, and a cover.
    await satchel.services.library.add('book:c', { ...rec('Covered'), ext: 'epub', format: 'epub' })
    await satchel.fs.writeFile('books/book_c/content.epub', bytes)
    await satchel.fs.writeFile('books/book_c/cover.jpg', coverBytes)
    await satchel.services.library.refreshContent('book:c')

    // The shelf ALREADY has the identical content (so no content fetch), but
    // no cover.
    await shelf.services.library.add('book:c', { ...rec('Covered'), ext: 'epub', format: 'epub' })
    await shelf.fs.writeFile('books/book_c/content.epub', bytes)
    await shelf.services.library.refreshContent('book:c')
    expect(shelf.fs.store.has('books/book_c/cover.jpg')).toBe(false)

    // The satchel pushes: the content is already here, the cover is offered —
    // and the cover comes over anyway.
    const channel = await satchel.port.connect(shelf.wire.id)
    await satchel.ledger.runSession(channel)
    await channel.close()
    expect(shelf.fs.store.get('books/book_c/cover.jpg')).toEqual(coverBytes)
    /* And the record carries the jacket's facts, this device's own (WI-23.C5). */
    await shelf.services.drain()
    expect(shelf.services.library.getSnapshot().find((one) => one.bookId === 'book:c')?.coverFacts).toMatchObject({ name: 'cover.jpg', size: coverBytes.length })
  })

  it('stamps the facts of a jacket the shelf already holds identically, without fetching it again', async () => {
    const { shelf, satchel } = await makeWorld()
    const bytes = new TextEncoder().encode('shared epub bytes')
    const coverBytes = new TextEncoder().encode('a jacket')
    for (const side of [satchel, shelf]) {
      await side.services.library.add('book:c', { ...rec('Covered'), ext: 'epub', format: 'epub' })
      await side.fs.writeFile('books/book_c/content.epub', bytes)
      await side.fs.writeFile('books/book_c/cover.jpg', coverBytes)
      await side.services.library.refreshContent('book:c')
    }
    const opsBefore = shelf.fs.ops.length
    const channel = await satchel.port.connect(shelf.wire.id)
    await satchel.ledger.runSession(channel)
    await channel.close()
    await shelf.services.drain()
    expect(shelf.services.library.getSnapshot().find((one) => one.bookId === 'book:c')?.coverFacts).toMatchObject({ name: 'cover.jpg', size: coverBytes.length })
    /* Identical, so no byte moved: nothing was written under the jacket's name. */
    expect(shelf.fs.ops.slice(opsBefore).some((op) => op.path.includes('cover.jpg'))).toBe(false)
  })

  it('replaces a jacket the shelf holds under another hash, and stamps the new facts', async () => {
    const { shelf, satchel } = await makeWorld()
    const bytes = new TextEncoder().encode('shared epub bytes')
    const newer = new TextEncoder().encode('a newer jacket')
    await satchel.services.library.add('book:c', { ...rec('Covered'), ext: 'epub', format: 'epub' })
    await satchel.fs.writeFile('books/book_c/content.epub', bytes)
    await satchel.fs.writeFile('books/book_c/cover.jpg', newer)
    await satchel.services.library.refreshContent('book:c')
    await shelf.services.library.add('book:c', { ...rec('Covered'), ext: 'epub', format: 'epub' })
    await shelf.fs.writeFile('books/book_c/content.epub', bytes)
    await shelf.fs.writeFile('books/book_c/cover.jpg', new TextEncoder().encode('an old jacket'))
    await shelf.services.library.refreshContent('book:c')
    const channel = await satchel.port.connect(shelf.wire.id)
    await satchel.ledger.runSession(channel)
    await channel.close()
    await shelf.services.drain()
    expect(shelf.fs.store.get('books/book_c/cover.jpg')).toEqual(newer)
    expect(shelf.services.library.getSnapshot().find((one) => one.bookId === 'book:c')?.coverFacts).toMatchObject({ name: 'cover.jpg', size: newer.length })
  })

  describe('audit-fix round 1 — what the mini audit found in the ledger', () => {
    const pushHandlerOf = (stack: Stack) => stack.ledger.services().find((one) => one.name === 'sync.push')!
    const pushTo = async (stack: Stack, group: Record<string, unknown>) => {
      const push = pushHandlerOf(stack)
      return push.handler(group as never, ({ peer: 'satchel-x' }) as unknown as Parameters<typeof push.handler>[1])
    }

    it('(#55) both devices hold bytes and the push carries no hash: refused unverifiable, never merged blind', async () => {
      const { shelf } = await makeWorld()
      await shelf.services.library.add('book:c', { ...rec('Content'), ext: 'epub', format: 'epub' })
      await shelf.services.library.keepContent('book:c', 'content.epub', new Blob([new TextEncoder().encode('shelf bytes')]))
      await shelf.services.library.refreshContent('book:c')
      expect(shelf.services.library.getSnapshot().find((b) => b.bookId === 'book:c')?.hasContent).toBe(true)
      const before = shelf.services.library.getSnapshot().find((b) => b.bookId === 'book:c')
      /* The guard used to check identity only when the sender SENT a hash —
       * so a claim of content with no hash, onto a shelf that has bytes,
       * merged the record and acked it, and different files were treated as
       * one. The contract in its own comment says this case is a retryable
       * refusal; now it is. */
      await expect(
        pushTo(shelf, { book: 'book:c', revs: { record: 1 }, hasContent: true, record: toWire({ ...rec('Renamed'), ext: 'epub', format: 'epub' }) }),
      ).rejects.toMatchObject({ code: 'unverifiable', retryable: true })
      expect(shelf.services.library.getSnapshot().find((b) => b.bookId === 'book:c')?.title).toBe(before?.title)
    })

    /* THE SIZE STAMPED IS THE LOCAL FILE'S. On the already-here path nothing
     * verifies the offer's size against anything, and the peer's number was
     * stamped as this device's own measurement — a peer could make this shelf
     * publish a size for a jacket it never measured at that size. The hash
     * result carries the local length; that is what the record gets. */
    it('stamps the local size, not the offered one, for a jacket already held under the offered hash', async () => {
      const { shelf } = await makeWorld()
      const coverBytes = new TextEncoder().encode('a jacket already here')
      await shelf.services.library.add('book:c', rec('Covered'))
      await shelf.fs.writeFile('books/book_c/cover.jpg', coverBytes)
      await pushTo(shelf, {
        book: 'book:c',
        revs: { record: 1 },
        hasContent: false,
        record: toWire(rec('Covered')),
        cover: { name: 'cover.jpg', size: coverBytes.length + 100, hash: await fakeBlobHash(coverBytes) },
      })
      await shelf.services.drain()
      expect(shelf.services.library.getSnapshot().find((b) => b.bookId === 'book:c')?.coverFacts).toEqual({
        name: 'cover.jpg',
        size: coverBytes.length,
        hash: await fakeBlobHash(coverBytes),
      })
    })

    it('(#56) a pulled row for a book this device removed does not re-add it, and the removal still pushes', async () => {
      const { shelf, satchel, session } = await makeWorld()
      await shelf.services.library.add('book:r', rec('Removed here'))
      await session() // the satchel now holds book:r too
      expect(satchel.services.library.getSnapshot().map((b) => b.bookId)).toContain('book:r')

      /* The shelf edits the book — so its next page carries a row for it —
       * and the satchel removes it locally BETWEEN the session's push phase
       * (its outbox was empty then) and the pull's apply. The pull door used
       * to hand the row straight to `library.add`, which treats a bare add on
       * a removed book as a deliberate re-open: the removal was undone and a
       * restore of intent was journaled, to be pushed back as a resurrection. */
      await shelf.services.library.tag('book:r', 'Edited')
      let removed = false
      const channel = await satchel.port.connect(shelf.wire.id)
      const interleaved: SyncChannel = {
        peerId: channel.peerId,
        call: async (service, body) => {
          const answer = await channel.call(service, body)
          if (service === 'sync.pull' && !removed) {
            removed = true
            await satchel.services.library.remove('book:r')
          }
          return answer
        },
      }
      await satchel.ledger.runSession(interleaved)
      await channel.close()

      expect(satchel.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:r')
      expect((await readPresence(satchel.fs))['book:r']?.state).toBe('removed')
      // The outbox carries the removal and nothing that would resurrect it.
      expect(pushableOutbox(satchel.journal).map((e) => `${e.book}/${e.what}`)).toEqual(['book:r/removed'])

      // And the next session carries the removal to the shelf.
      await session()
      expect(shelf.services.library.getSnapshot().map((b) => b.bookId)).not.toContain('book:r')
      expect((await readPresence(shelf.fs))['book:r']?.state).toBe('removed')
    })

    it('(#328) a record revision whose file cannot be read is not offered — it stays in the outbox, unacked', async () => {
      const { satchel, session } = await makeWorld()
      await satchel.services.library.add('book:u', rec('Unreadable later'))
      await session()
      await satchel.services.library.tag('book:u', 'Edited') // a record rev in the outbox
      expect(pushableOutbox(satchel.journal).map((e) => `${e.book}/${e.what}`)).toEqual(['book:u/record'])
      /* The file goes away UNDER the outbox — a crash mid-rename, a folder
       * moved by hand. `buildGroup` used to advertise the rev with no record
       * behind it; the shelf acked what was advertised; the ack cleared the
       * rev, and the edit was marked pushed with nothing ever sent. */
      satchel.fs.store.delete('books/book_u/book.json')

      const summary = await session()
      expect(summary.pushed).toBe(0)
      /* NOT OFFERED — not merely refused. The shelf's parser now refuses a
       * rev with nothing behind it too (#59), which would keep the rev just
       * as well; but a refusal is a diagnostic and a status line about a
       * group the satchel should never have built. */
      expect(summary.refused).toEqual([])
      expect(pushableOutbox(satchel.journal).map((e) => `${e.book}/${e.what}`)).toEqual(['book:u/record'])
    })
  })
})

/**
 * WI-20.25 — one refusal does not wedge a satchel. `pushAll` aborted the
 * session on the first throw, so a `conflict` on one book was re-pushed first
 * every session and blocked every later push and the whole pull; and one
 * invalid marks answer failed the pull page forever, because the digest
 * comparison that schedules the fetch never re-fires for an advanced page.
 * The push side continues per book (every rev is CAS-acked independently);
 * the pull side sets the book aside and re-fetches it every session
 * regardless of digest, bounded.
 */
describe('one refusal does not wedge a satchel (WI-20.25)', () => {
  const enc = (text: string) => new TextEncoder().encode(text)

  it('a conflict on one book does not stop the next book or the pull, and the summary names it', async () => {
    const { shelf, satchel, session } = await makeWorld()
    // The shelf holds Z with bytes and no stored hash — #16's shape.
    await shelf.services.library.add('book:z', { ...rec('Zeta'), ext: 'epub', format: 'epub' })
    await shelf.fs.writeFile('books/book_z/content.epub', enc('the shelf bytes'))
    await shelf.services.library.refreshContent('book:z')
    // A shelf-only row the pull must still bring.
    await shelf.services.library.add('book:s', rec('Shelf-only'))
    // The satchel: Z with DIFFERENT bytes (a conflict when pushed), then B, a plain record.
    await satchel.services.library.add('book:z', { ...rec('Zeta'), ext: 'epub', format: 'epub' })
    await satchel.fs.writeFile('books/book_z/content.epub', enc('the satchel bytes'))
    await satchel.services.library.refreshContent('book:z')
    await satchel.services.library.add('book:b', rec('Bravo'))

    const summary = await session()
    expect(summary.refused).toEqual([expect.objectContaining({ book: 'book:z', kind: 'conflict' })])
    // B went through and was acked; Z is still what there is to push.
    expect(summary.pushed).toBe(1)
    expect(pushableOutbox(satchel.journal).map((e) => `${e.what} ${e.book}`)).toEqual(['record book:z'])
    expect(shelf.services.library.getSnapshot().map((b) => b.bookId).sort()).toEqual(['book:b', 'book:s', 'book:z'])
    // The pull ran after the refusal: the shelf-only row arrived and the cursor moved.
    expect(satchel.services.library.getSnapshot().map((b) => b.bookId).sort()).toEqual(['book:b', 'book:s', 'book:z'])
    expect(satchel.services.settings.get(SYNC_CURSOR_SETTING)?.since).toBeGreaterThan(0)
    // And the reader is told which book, by title.
    const line = describeSession(summary, { shelf: 'Study iMac', title: (book) => (book === 'book:z' ? 'Zeta' : null) })
    expect(line).toContain('“Zeta”')
  })

  /** A session over the real wire, with the shelf's marks answers tampered on the way back. */
  const tamperedSession = (
    world: Awaited<ReturnType<typeof makeWorld>>,
    tamper: (book: string, answer: unknown) => unknown,
    onMarksCall?: () => void,
  ): Promise<SyncSummary> =>
    (async () => {
      const channel = await world.satchel.port.connect(world.shelf.wire.id)
      const tampered: SyncChannel = {
        peerId: channel.peerId,
        call: async (service, body) => {
          const answer = await channel.call(service, body)
          if (service !== 'sync.marks') return answer
          onMarksCall?.()
          return tamper((body as { book: string }).book, answer)
        },
      }
      try {
        return await world.satchel.ledger.runSession(tampered)
      } finally {
        await channel.close()
      }
    })()

  it('an invalid marks answer is set aside, the page still advances, and a later session brings the repaired rows', async () => {
    const world = await makeWorld()
    const { shelf, satchel } = world
    await shelf.services.library.add('book:a', rec('Alpha'))
    await shelf.services.marks.add(mark('m1', 'book:a', 'the whale'))
    await shelf.services.library.add('book:b', rec('Bravo'))
    await shelf.services.marks.add(mark('m2', 'book:b', 'ahab'))

    // The shelf's answer for B carries a row that is not a mark.
    let broken = true
    const tamper = (book: string, answer: unknown) =>
      broken && book === 'book:b' ? { book, marks: [{ id: 'm2', note: 'not a mark' }] } : answer

    const first = await tamperedSession(world, tamper)
    expect(first.quarantine).toEqual({ held: 1, dropped: 0, repaired: 0 })
    // A's marks came; B's did not; the cursor is at the head all the same.
    expect(validMarks(await readMarks(satchel.fs, 'book:a')).map((m) => m.id)).toEqual(['m1'])
    expect(await readMarks(satchel.fs, 'book:b')).toEqual([])
    expect(satchel.services.settings.get(SYNC_QUARANTINE_SETTING)).toEqual({ peerId: shelf.wire.id, books: ['book:b'], dropped: 0 })
    const cursor = satchel.services.settings.get(SYNC_CURSOR_SETTING)?.since
    expect(cursor).toBeGreaterThan(0)

    // The shelf "repairs" the row — the same valid rows it always held — with
    // NO new seq: the digest scheduler will never re-fire for that page.
    broken = false
    const before = shelf.journal.entries().length
    const second = await tamperedSession(world, tamper)
    expect(shelf.journal.entries().length).toBe(before)
    expect(second.pulledRows).toBe(0)
    expect(second.quarantine).toEqual({ held: 0, dropped: 0, repaired: 1 })
    expect(validMarks(await readMarks(satchel.fs, 'book:b')).map((m) => m.id)).toEqual(['m2'])
    expect(satchel.services.settings.get(SYNC_QUARANTINE_SETTING).books).toEqual([])
    expect(satchel.services.settings.get(SYNC_CURSOR_SETTING)?.since).toBe(cursor)
  })

  it('the quarantine is bounded: seventy broken books leave sixty-four, and the next session asks for exactly those', async () => {
    const world = await makeWorld()
    const { shelf, satchel } = world
    for (let i = 0; i < 70; i += 1) {
      const book = `book:${String(i).padStart(2, '0')}`
      await shelf.services.library.add(book, rec(`Title ${i}`))
      await shelf.services.marks.add(mark(`m${i}`, book, 'note'))
    }
    const tamper = (book: string) => ({ book, marks: [{ id: 'nope' }] })

    const first = await tamperedSession(world, tamper)
    expect(first.quarantine).toEqual({ held: 64, dropped: 6, repaired: 0 })
    expect(satchel.services.settings.get(SYNC_QUARANTINE_SETTING).books.length).toBe(64)
    // Every row arrived and the cursor is at the head: the quarantine cost no page.
    expect(satchel.services.library.getSnapshot().length).toBe(70)

    // Still broken. The next session asks for exactly the held sixty-four —
    // not seventy, and not the ten thousand a hostile shelf could offer.
    let marksCalls = 0
    const second = await tamperedSession(world, tamper, () => void (marksCalls += 1))
    expect(marksCalls).toBe(64)
    expect(second.pulledRows).toBe(0)
    /* WHAT THIS SESSION DROPPED, not the list's lifetime count: reporting
     * the total made every session after one overflow read as a fresh
     * degradation, forever (audit-fix #342). The six are still on record. */
    expect(second.quarantine).toEqual({ held: 64, dropped: 0, repaired: 0 })
    expect(satchel.services.settings.get(SYNC_QUARANTINE_SETTING).dropped).toBe(6)
    // And the reader is told, with the overflow.
    const firstLine = describeSession(first, { shelf: 'Study iMac', title: () => null })
    expect(firstLine).toMatch(/64 books/)
    expect(firstLine).toMatch(/6 more/)
    const line = describeSession(second, { shelf: 'Study iMac', title: () => null })
    expect(line).toMatch(/64 books/)
    expect(line).not.toMatch(/more/)
  })
})
