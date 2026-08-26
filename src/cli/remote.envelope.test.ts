import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPeerPort, linkedWires, type Channel, type FakeWire, type PeerPort } from '../capabilities/peer'
import {
  PAGE_ROWS,
  SERVICE_NAMES,
  buildServices,
  createKernelServices,
  readServices,
  type BookRow,
  type IndexedBook,
  type KernelServices,
  type ServiceContribution,
} from '../kernel'
import { fakeFs } from '../kernel/testkit'
import { paper } from './paper'
import { remoteCaller } from './remote'
import { EXIT, runCommand } from './run'

/**
 * `paper --shelf <key> …` — the identical command table over the envelope
 * (WI-11.6).
 *
 * WHAT IS REAL, AND WHAT IS NOT — stated precisely, because the earlier
 * version of this note said "the whole path except the socket" and that
 * overstated it in a way that matters.
 *
 * REAL: the kernel's whole service table, `buildServices`, the router, the
 * envelope's codec and its frames, `createClient`, the CLI's own `remoteCaller`
 * and `runCommand` — the same argv, the same rendering, the same exit codes.
 *
 * NOT REAL: `linkedWires()` replaces `PeerWire`, which is the Tauri plugin.
 * So the SESSION, the peer records, the event plumbing and the grant STORE are
 * the fake's, not `peers.rs`'s. What is genuinely exercised about grants is
 * that the ROUTER asks on every frame and honours the answer — which is the
 * property this file is for — not that the plugin stores or revokes them
 * correctly. That belongs to the Rust tests, and it has them.
 *
 * The three things the plan asks for are the three describe blocks below:
 * every command answers; a command whose grant the caller lacks fails with
 * `forbidden` AND a non-zero exit; a cancelled command sends `cancel` and the
 * handler stops.
 */

/* SEVERAL PAGES, not two. With `PAGE_ROWS + 11` the whole library is two
 * pages, so "the shelf stopped early" cannot be distinguished from "the shelf
 * finished" — and the router pulls one page ahead, which by itself accounts
 * for the second. Six pages leaves room to see the difference. */
const MANY = PAGE_ROWS * 5 + 11
const PAGES = Math.ceil(MANY / PAGE_ROWS)

function seed(index: number): IndexedBook {
  return {
    bookId: `b${String(index).padStart(4, '0')}`,
    title: `Title ${index}`,
    author: index % 2 === 0 ? 'Even Author' : 'Odd Author',
    tags: index % 3 === 0 ? ['philosophy'] : [],
    addedAt: 1_700_000_000_000 + index,
    hasContent: true,
  }
}

const books: readonly IndexedBook[] = Array.from({ length: MANY }, (_one, index) => seed(index))

interface Shelf {
  readonly channel: Channel
  readonly services: KernelServices
  /** The shelf's PORT, not its wire — see the revocation case. */
  readonly shelfPort: PeerPort
  /** Both wires, so a test can watch the frames actually crossing. */
  readonly wires: { shelf: FakeWire; satchel: FakeWire }
  readonly satchelId: string
  /** How many pages the shelf's handler for `service` actually produced. */
  pagesBuilt(service: string): number
  /** Whether the shelf's handler for `service` had its signal aborted. */
  wasCancelled(service: string): boolean
  close(): Promise<void>
}

const open: Shelf[] = []

/**
 * A shelf serving the whole table, and an open channel to it from a satchel.
 *
 * `grants` is what the SHELF believes the satchel holds — set on the shelf's
 * own peer record, which is where the plugin keeps it and where the router
 * asks. Narrowing it later and re-asking is what the revocation case does.
 */
/* `blob:*` IS IN THE DEFAULT SET, and its absence was a finding. `content.read`
 * is gated on `blob:read` — the grant the Devices pane renders as "book files"
 * — rather than on `book:read`, so a peer told it cannot have the files cannot
 * stream them either. This fixture is a peer that CAN, which is what the
 * whole-table sweep below needs; `a_peer_denied_book_files` is the other half. */
async function serveOverTheWire(
  grants: readonly string[] = ['book:*', 'blob:*', 'mark:*', 'card:*', 'shelf:*'],
): Promise<Shelf> {
  const wires = linkedWires()
  const shelfPort = createPeerPort(wires.shelf)
  const satchelPort = createPeerPort(wires.satchel)
  /* BYTES FOR ONE BOOK, so `content.read` crosses this wire for real rather
   * than being exempted from it. The envelope is what a browser reads a book
   * through, and a chunked byte stream is the one service here whose framing
   * a small fixture would not exercise. */
  const services = createKernelServices({
    /* ⚠️ **A BOOK REACHES THE TRASH ONLY IF IT HAS A FOLDER.** `book.remove`
     * moves the folder aside, and `trash.list` reads what is there — so a row
     * that exists only in the index is removed from the shelf and leaves
     * nothing recoverable behind. `b0001` and `b0002` are given records for
     * that reason: `trash.empty` is the one irreversible verb here and the
     * case worth testing is a trash that HOLDS something. */
    fs: fakeFs({
      'books/b0000/content.epub': 'PK\u0003\u0004 pretend epub bytes',
      'books/b0001/record.json': JSON.stringify({ title: 'Title 1', addedAt: 1 }),
      'books/b0002/record.json': JSON.stringify({ title: 'Title 2', addedAt: 2 }),
      /* ⚠️ **A JACKET, BECAUSE `cover.read` WAS ONLY EVER ASKED ABOUT A BOOK
       * THAT HAS NONE.** An empty stream is a legitimate answer — most books
       * have no artwork — and it is also what a `cover.read` that is completely
       * broken answers. The browser client draws every shelf row through this
       * service, so the byte path is the one that matters and it had no case at
       * all. Bytes chosen so the chunking is visible in the assertion. */
      'books/b0000/cover.jpg': 'JACKETBYTES',
    }),
    storage: null,
    initialBooks: books,
  })
  /* WHAT THE HANDLER ACTUALLY PRODUCED. Cancellation is about work stopping on
   * the SHELF, and nothing here could see that: the assertions were all about
   * the client's own iterator, which a client that never sends `cancel`
   * satisfies just as well. Counted by wrapping each stream handler's pages. */
  const pages = new Map<string, number>()
  const signals = new Map<string, AbortSignal>()
  const counted: readonly ServiceContribution[] = buildServices({ services }).map((one) => ({
    ...one,
    handler: (req, ctx) => {
      signals.set(one.name, ctx.signal)
      const answer = one.handler(req, ctx)
      if (typeof answer !== 'object' || answer === null || !(Symbol.asyncIterator in answer)) return answer
      const inner = answer as AsyncIterable<unknown>
      return (async function* () {
        for await (const page of inner) {
          pages.set(one.name, (pages.get(one.name) ?? 0) + 1)
          yield page
        }
      })()
    },
  }))
  /* AWAITED. It happens to mutate synchronously today, so a missing `await`
   * passed — and an implementation that became asynchronous would race
   * `serve()` below, with any rejection arriving as an unhandled one. */
  await wires.shelf.setGrants(wires.satchel.id, grants)
  const unserve = await shelfPort.serve(counted)
  const channel = await satchelPort.connect(wires.shelf.id)
  const shelf: Shelf = {
    channel,
    services,
    shelfPort,
    wires,
    satchelId: wires.satchel.id,
    pagesBuilt: (service) => pages.get(service) ?? 0,
    wasCancelled: (service) => signals.get(service)?.aborted === true,
    close: async () => {
      /* NOT SWALLOWED. Teardown used to `.catch(() => {})` here, so a session
       * that could not be closed — a leak, a double close, a cleanup that
       * throws — left every run green. A failure in teardown is a finding
       * about the code under test, not noise to be silenced. */
      try {
        await channel.close()
      } finally {
        unserve()
      }
    },
  }
  open.push(shelf)
  return shelf
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

/**
 * One command, over the envelope, exactly as `paper --shelf` runs it.
 *
 * `close` IS A NO-OP HERE and that is a deliberate narrowing, not an
 * oversight: the harness owns the session, and a command that tore down the
 * channel would take the next assertion's shelf with it. The production
 * close path — where `runCommand` owns the channel and closes it on success
 * AND on failure — is exercised by its own case below, which is the one that
 * would have caught a caller that stopped closing.
 */
async function overTheWire(shelf: Shelf, argv: readonly string[]): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const code = await runCommand(argv, async () => remoteCaller({ channel: shelf.channel, close: async () => {} }), {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('every command, over the envelope', () => {
  it('answers a req and a stream with what the shelf holds', async () => {
    const shelf = await serveOverTheWire()
    const one = JSON.parse((await overTheWire(shelf, ['book', 'get', 'b0003', '--json'])).out) as BookRow
    expect(one.title).toBe('Title 3')

    const many = JSON.parse((await overTheWire(shelf, ['book', 'list', '--json'])).out) as BookRow[]
    expect(many).toHaveLength(MANY)
    /* MORE THAN ONE PAGE crossed the wire — the paging is real over a session
     * and not an artefact of a small fixture. */
    expect(MANY).toBeGreaterThan(PAGE_ROWS)
  })

  it('answers every read service the shelf can answer, with the same argv the local caller takes', async () => {
    const shelf = await serveOverTheWire()
    const argvFor: Readonly<Record<string, readonly string[]>> = {
      'book.list': ['book', 'list'],
      'book.get': ['book', 'get', 'b0000'],
      'book.search': ['book', 'search', 'tag:philosophy'],
      'mark.list': ['mark', 'list', 'b0000'],
      'card.list': ['card', 'list'],
      'tag.list': ['tag', 'list'],
      'trash.list': ['trash', 'list'],
      'content.locate': ['content', 'locate', 'b0000'],
      'content.read': ['content', 'read', 'b0000'],
      'cover.read': ['cover', 'read', 'b0000'],
      'shelf.status': ['shelf', 'status'],
    }
    /* Derived from the table, so a read service added without a case here
     * fails this test rather than sliding past it. `device.list` is the one
     * exclusion and it is named: it needs a transport the SHELF does not have
     * in this harness either. */
    expect(Object.keys(argvFor).sort()).toEqual(
      readServices()
        .map((one) => one.name)
        .filter((name) => name !== 'device.list')
        .sort(),
    )
    for (const [name, argv] of Object.entries(argvFor)) {
      const run = await overTheWire(shelf, [...argv, '--json'])
      expect({ name, code: run.code, err: run.err }).toEqual({ name, code: EXIT.ok, err: '' })
      expect(() => JSON.parse(run.out)).not.toThrow()
    }

    /**
     * ⚠️ **THE LOOP CHECKS EXIT STATUS AND PARSEABILITY, AND THAT IS ALL.**
     *
     * A handler that answered `[]` for every service satisfies it. That is
     * tolerable for eleven services at once — the point of the loop is that
     * every row of the table crosses the envelope — but not for the ONE whose
     * framing a small fixture would not exercise, and which the fixture goes
     * out of its way to seed bytes for.
     *
     * `content.read` is a chunked byte stream, and it is how a browser reads a
     * book. Empty is exactly what it answered before the shelf bound a size
     * port, and the loop above could not tell the difference.
     */
    const read = await overTheWire(shelf, ['content', 'read', 'b0000', '--json'])
    const chunks = JSON.parse(read.out) as { bookId: string; offset: number; bytes: string }[]
    expect(chunks.length, 'content.read answered nothing for a book with bytes').toBeGreaterThan(0)
    const carried = chunks.map((c) => atob(c.bytes)).join('')
    expect(carried, 'the bytes the shelf holds are not the bytes that crossed').toBe(
      'PK\u0003\u0004 pretend epub bytes',
    )
    /* CONTIGUOUS AND THIS BOOK'S. A gap, a repeat or another book's bytes join
       into something that decodes and is wrong — see `covers.ts`, where the
       same shape produced a picture rather than an error. */
    let at = 0
    for (const chunk of chunks) {
      expect(chunk.bookId).toBe('b0000')
      expect(chunk.offset, 'content.read is not contiguous').toBe(at)
      at += atob(chunk.bytes).length
    }

    /**
     * ⚠️ **`cover.read` WAS ONLY EVER ASKED ABOUT A BOOK WITH NO JACKET.**
     *
     * An empty stream is a legitimate answer — most books have none — and it is
     * also what a `cover.read` that is entirely broken answers. Every shelf row
     * the browser client draws goes through this service, so the byte path is
     * the one that matters, and it had no case at all.
     */
    const jacket = JSON.parse((await overTheWire(shelf, ['cover', 'read', 'b0000', '--json'])).out) as {
      bookId: string
      offset: number
      bytes: string
    }[]
    expect(jacket.length, 'cover.read answered nothing for a book with a jacket').toBeGreaterThan(0)
    expect(jacket.map((c) => atob(c.bytes)).join('')).toBe('JACKETBYTES')
    expect(jacket.every((c) => c.bookId === 'b0000')).toBe(true)

    /* AND A BOOK WITH NO JACKET IS STILL AN EMPTY STREAM, not a refusal —
       otherwise the shelf reports an error per row on a library of two
       thousand. Both answers, so neither can be mistaken for the other. */
    const none = await overTheWire(shelf, ['cover', 'read', 'b0001', '--json'])
    expect(none.code).toBe(EXIT.ok)
    expect(JSON.parse(none.out)).toEqual([])
  })

  it('writes through the wire, and the shelf holds the change', async () => {
    const shelf = await serveOverTheWire()
    expect((await overTheWire(shelf, ['book', 'set', 'b0001', '--title', 'Renamed remotely'])).code).toBe(EXIT.ok)
    expect(shelf.services.library.getSnapshot().find((one) => one.bookId === 'b0001')?.title).toBe('Renamed remotely')
  })

  it('carries a service refusal across unchanged, code and all', async () => {
    const shelf = await serveOverTheWire()
    const run = await overTheWire(shelf, ['book', 'get', 'nope'])
    expect(run.code).toBe(EXIT.refused)
    expect(run.err).toContain('not-found')
    expect(run.err).toContain('no book nope')
  })

  /**
   * EVERY WRITE, NOT ONLY `book.set` — with a real body, over the wire, and
   * with the shelf's own state as the assertion.
   *
   * The suite around this exercised nine reads and one write, and the
   * table-wide loop below only proves each NAME is registered: it sends `{}`,
   * which every write refuses as malformed, so a write whose handler was
   * broken, whose grant was wrong, or whose answer did not survive the codec
   * would have passed it. These are the calls that CHANGE the reader's
   * library, from a machine that is not theirs.
   */
  it('runs every write service over the wire and the shelf holds the result', async () => {
    const shelf = await serveOverTheWire(['book:*', 'mark:*', 'card:*', 'shelf:*'])
    const shelfOf = () => shelf.services.library.getSnapshot()

    /* book.add — a new row on the shelf. */
    expect((await overTheWire(shelf, ['book', 'add', 'newbook', 'A New Book', 'An Author'])).code).toBe(EXIT.ok)
    expect(shelfOf().find((one) => one.bookId === 'newbook')?.title).toBe('A New Book')

    /* tag.add / tag.rename / tag.remove — the reader's own vocabulary. */
    expect(JSON.parse((await overTheWire(shelf, ['tag', 'add', 'sea', '--book', 'newbook', '--json'])).out)).toEqual({
      tag: 'sea',
      books: 1,
    })
    expect(shelfOf().find((one) => one.bookId === 'newbook')?.tags).toContain('sea')
    expect(JSON.parse((await overTheWire(shelf, ['tag', 'rename', 'sea', 'ocean', '--json'])).out)).toEqual({
      tag: 'ocean',
      books: 1,
    })
    expect(JSON.parse((await overTheWire(shelf, ['tag', 'remove', 'ocean', '--json'])).out)).toEqual({
      tag: 'ocean',
      books: 1,
    })

    /* mark.add / mark.set / mark.remove — the reader's annotations. */
    const added = JSON.parse(
      (await overTheWire(shelf, ['mark', 'add', 'newbook', 'epubcfi(/6/4!/4/2/1)', 'the whale', '--json'])).out,
    ) as { id: string }
    expect(added.id).toBeTruthy()
    expect((await overTheWire(shelf, ['mark', 'set', added.id, '--note', 'a note'])).code).toBe(EXIT.ok)
    expect(JSON.parse((await overTheWire(shelf, ['mark', 'remove', added.id, '--json'])).out)).toMatchObject({
      removed: true,
    })

    /* card.add / card.remove. */
    const card = JSON.parse((await overTheWire(shelf, ['card', 'add', 'a thought', '--json'])).out) as { id: string }
    expect(card.id).toBeTruthy()
    expect(JSON.parse((await overTheWire(shelf, ['card', 'remove', card.id, '--json'])).out)).toMatchObject({
      removed: true,
    })

    /**
     * ⚠️ **THIS EVICTED A BOOK THAT NEVER HAD BYTES.** `newbook` was created by
     * `book.add` above and has no content file, so `here: false` was already
     * true before the command ran — the case proved that evicting nothing
     * answers "nothing here", which an evict that did nothing at all also
     * answers. The verb DELETES a reader's downloaded book; the case worth
     * having is the one where there was something to delete.
     */
    expect(
      JSON.parse((await overTheWire(shelf, ['content', 'locate', 'b0000', '--json'])).out),
      'the fixture seeds bytes for b0000 — see serveOverTheWire',
    ).toMatchObject({ bookId: 'b0000', here: true })

    expect(JSON.parse((await overTheWire(shelf, ['content', 'evict', 'b0000', '--json'])).out)).toMatchObject({
      bookId: 'b0000',
      here: false,
    })
    /* AND THE BYTES ARE ACTUALLY GONE, asked a second way. The verb's own
       answer is the thing under test, so it cannot also be the evidence. */
    expect(
      JSON.parse((await overTheWire(shelf, ['content', 'locate', 'b0000', '--json'])).out),
      'evict answered "here: false" over a book whose bytes are still there',
    ).toMatchObject({ bookId: 'b0000', here: false })

    /* AND EVICTING WHAT IS ALREADY GONE IS NOT AN ERROR — idempotent, which is
       what makes the verb safe to retry. */
    expect(JSON.parse((await overTheWire(shelf, ['content', 'evict', 'newbook', '--json'])).out)).toMatchObject({
      bookId: 'newbook',
      here: false,
    })

    /* book.remove then book.restore — the recoverable pair. */
    expect(JSON.parse((await overTheWire(shelf, ['book', 'remove', 'newbook', '--json'])).out)).toMatchObject({
      removed: true,
    })
    expect(shelfOf().some((one) => one.bookId === 'newbook')).toBe(false)
    expect(JSON.parse((await overTheWire(shelf, ['book', 'restore', 'newbook', '--json'])).out)).toMatchObject({
      bookId: 'newbook',
      restored: true,
    })
    expect(shelfOf().some((one) => one.bookId === 'newbook')).toBe(true)
  })

  /* THE ADMIN VERBS refuse `unsupported` over the wire when no port is bound,
   * which is the same answer they give locally — and NOT `internal`, which is
   * what an untranslated port failure would have crossed as. */
  it('answers the administrative verbs with the same refusal a local caller gets', async () => {
    const shelf = await serveOverTheWire(['shelf:*', 'device:*'])
    for (const argv of [['shelf', 'sync'], ['shelf', 'verify'], ['device', 'list']]) {
      const run = await overTheWire(shelf, argv)
      expect({ argv, code: run.code }, argv.join(' ')).toEqual({ argv, code: EXIT.refused })
      expect(run.err, argv.join(' ')).toContain('unsupported')
    }
  })

  /* AND `trash.empty`, the one irreversible verb, still demands its count
   * across the wire — the confirmation is not a client-side courtesy. */
  it('holds trash.empty to its count over the wire', async () => {
    const shelf = await serveOverTheWire(['shelf:*', 'book:*'])
    /**
     * ⚠️ **THIS RAN AGAINST AN EMPTY TRASH, AND CONFIRMED WITH ZERO.**
     *
     * `trash.empty 0` over an empty trash deletes nothing whether the count is
     * honoured or not, so the one irreversible verb on the shelf was tested
     * only in the case where being wrong costs nothing. The confirmation exists
     * for a trash that HOLDS books, and that is the case here now: a wrong
     * count must refuse while they are still recoverable, and the right one
     * must name what it destroyed.
     */
    expect((await overTheWire(shelf, ['book', 'remove', 'b0001'])).code).toBe(EXIT.ok)
    expect((await overTheWire(shelf, ['book', 'remove', 'b0002'])).code).toBe(EXIT.ok)
    const inTrash = JSON.parse((await overTheWire(shelf, ['trash', 'list', '--json'])).out) as unknown[]
    expect(inTrash, 'two books should be recoverable').toHaveLength(2)

    /* A WRONG COUNT REFUSES, and the books are still there afterwards — which
       is the whole point of the confirmation and is not what the exit code
       alone would have proved. */
    const wrong = await overTheWire(shelf, ['trash', 'empty', '3'])
    expect(wrong.code).toBe(EXIT.refused)
    expect(wrong.err).toContain('conflict')
    expect(
      JSON.parse((await overTheWire(shelf, ['trash', 'list', '--json'])).out),
      'a refused empty must leave the trash untouched',
    ).toHaveLength(2)

    /* AND ZERO REFUSES TOO, over a trash of two: the count is a statement about
       what the caller believes is there, not a formality. */
    expect((await overTheWire(shelf, ['trash', 'empty', '0'])).code).toBe(EXIT.refused)

    const emptied = JSON.parse((await overTheWire(shelf, ['trash', 'empty', '2', '--json'])).out) as {
      emptied: number
      bookIds: string[]
    }
    expect(emptied.emptied).toBe(2)
    expect([...emptied.bookIds].sort(), 'the answer must name what it destroyed').toEqual(['b0001', 'b0002'])
    expect(JSON.parse((await overTheWire(shelf, ['trash', 'list', '--json'])).out)).toHaveLength(0)
    /**
     * NOT RESTORABLE — and it says so with `restored: false` rather than by
     * refusing.
     *
     * "Irreversible" is the property `trash.empty` exists to be careful about,
     * and this is the only assertion that states it. The exit code is `ok`
     * deliberately: asking to restore a book that is not in the trash is a
     * question with an answer, not an error — and answering it `true` would be
     * the failure worth catching, because a caller acting on that would show a
     * reader a book that is gone.
     */
    const back = await overTheWire(shelf, ['book', 'restore', 'b0001', '--json'])
    expect(back.code).toBe(EXIT.ok)
    expect(JSON.parse(back.out)).toMatchObject({ bookId: 'b0001', restored: false })
  })

  it('registers the whole table on the router', async () => {
    const shelf = await serveOverTheWire()
    /* Every name answers SOMETHING — an answer or a typed refusal — and none
     * answers `unknown-service`, which is what a name the router never saw
     * would give. */
    for (const name of SERVICE_NAMES) {
      const failed = await shelf.channel.call(name, {}).catch((error: unknown) => error)
      expect(String(failed)).not.toContain('unknown-service')
    }
  })
})

describe('a grant the caller lacks', () => {
  it('fails with forbidden and a non-zero exit', async () => {
    const shelf = await serveOverTheWire(['mark:read'])
    const run = await overTheWire(shelf, ['book', 'list'])
    expect(run.code).toBe(EXIT.refused)
    expect(run.err).toContain('forbidden')
    /* And the one it DOES hold still works, so the refusal is about the
     * grant rather than about the session. */
    expect((await overTheWire(shelf, ['mark', 'list', 'b0000'])).code).toBe(EXIT.ok)
  })

  /**
   * A PEER DENIED "BOOK FILES" CANNOT STREAM THE BOOK.
   *
   * `describeGrants` shows `blob:read` to the reader as "book files" and shows
   * a peer without it as having only "Books, highlights, reading position".
   * `content.read` was gated on `book:read`, so that peer was told it could not
   * have the files and could stream every byte of every one of them. The
   * sentence in the pane was the boundary a reader was actually reading.
   *
   * The positive half matters as much as the negative: `book.list` still works,
   * so this is a refusal about the FILES and not a peer that lost everything.
   */
  it('refuses content.read to a peer denied book files, while the rest still works', async () => {
    const shelf = await serveOverTheWire(['book:*', 'mark:*', 'card:*', 'shelf:*'])

    const bytes = await overTheWire(shelf, ['content', 'read', 'b0000'])
    expect(bytes.code).toBe(EXIT.refused)
    expect(bytes.err).toContain('forbidden')

    /* Everything the pane DOES promise this peer. */
    expect((await overTheWire(shelf, ['book', 'list'])).code).toBe(EXIT.ok)
    expect((await overTheWire(shelf, ['content', 'locate', 'b0000'])).code).toBe(EXIT.ok)

    /* And granting the file permission is what turns it on — so the refusal is
       about `blob:read` and not about something else being absent. */
    await shelf.shelfPort.setGrants(shelf.satchelId, ['book:*', 'blob:read'])
    expect((await overTheWire(shelf, ['content', 'read', 'b0000'])).code).toBe(EXIT.ok)
  })

  it('takes effect on an OPEN session when the shelf narrows the grants', async () => {
    const shelf = await serveOverTheWire()
    expect((await overTheWire(shelf, ['book', 'get', 'b0000'])).code).toBe(EXIT.ok)
    /* THROUGH THE PORT, not the wire. The port holds the live grant cache the
     * router asks on every frame, and `setGrants` is what refreshes it and
     * rechecks open connections; writing to the wire directly leaves the
     * cache stale and the revocation invisible.
     *
     * The first version of this test did exactly that and read the resulting
     * pass-through as the app failing to revoke — which is WI-8.6's retracted
     * finding in miniature: invoking a plugin command directly skips what the
     * layer above it does on the way past. */
    await shelf.shelfPort.setGrants(shelf.satchelId, ['mark:read'])
    const after = await overTheWire(shelf, ['book', 'get', 'b0000'])
    expect(after.code).toBe(EXIT.refused)
    expect(after.err).toContain('forbidden')
  })
})

/**
 * A CANCELLED COMMAND — proved on the WIRE and at the HANDLER, not at the
 * local iterator.
 *
 * These asserted `iterator.next().done` after `return()`, and a page count
 * after `break`. Both describe the CLIENT's own object: a client that simply
 * stopped reading — never sending `cancel`, leaving the shelf building pages
 * for a caller that has gone — satisfies both. The two things worth knowing
 * are that a `cancel` frame crossed and that the handler stopped, and neither
 * was observed.
 */
describe('a cancelled command', () => {
  it('sends a cancel frame, and the shelf stops building pages', async () => {
    const shelf = await serveOverTheWire()
    const caller = remoteCaller({ channel: shelf.channel, close: async () => {} })
    const iterator = caller.stream('book.list', {})[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect((first.value as BookRow[]).length).toBe(PAGE_ROWS)
    expect(shelf.wasCancelled('book.list')).toBe(false)

    /* `return()` is what `break` calls, and it is the client's cue to send
     * `cancel`. */
    await iterator.return?.()
    expect((await iterator.next()).done).toBe(true)

    /* THE SHELF'S OWN HANDLER SAW IT. Its `ctx.signal` is aborted only by the
     * router, and only when a `cancel` frame for that request arrives — so
     * this is the frame's arrival observed where it has an effect, which is
     * the thing worth asserting. A client that simply stopped reading would
     * leave this false. */
    expect(shelf.wasCancelled('book.list')).toBe(true)

    /* AND THE WORK STOPPED. `pagesBuilt` counts what the handler actually
     * produced: the whole library is more than two pages, and after the
     * cancel it must not have built the rest. */
    /* ONE PAGE AHEAD IS THE ROUTER'S LOOKAHEAD and is expected; the REST of the
     * library is what must not be built. */
    expect(shelf.pagesBuilt('book.list')).toBeLessThanOrEqual(2)
    expect(PAGES).toBeGreaterThan(3)

    /* The session survives — a cancelled command must not cost the caller
     * the connection. */
    expect((await overTheWire(shelf, ['book', 'get', 'b0000'])).code).toBe(EXIT.ok)
  })

  it('sends a cancel when the caller breaks out of the loop', async () => {
    const shelf = await serveOverTheWire()
    const caller = remoteCaller({ channel: shelf.channel, close: async () => {} })
    let pages = 0
    for await (const _page of caller.stream('book.list', {})) {
      pages += 1
      break
    }
    expect(pages).toBe(1)
    /* THE FRAME CROSSES ASYNCHRONOUSLY. `break` calls `return()`, which sends
     * `cancel`; the loop does not wait for the shelf to receive it. */
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shelf.wasCancelled('book.list')).toBe(true)
    /* ONE PAGE AHEAD IS THE ROUTER'S LOOKAHEAD and is expected; the REST of the
     * library is what must not be built. */
    expect(shelf.pagesBuilt('book.list')).toBeLessThanOrEqual(2)
    expect(PAGES).toBeGreaterThan(3)
    expect((await overTheWire(shelf, ['shelf', 'status'])).code).toBe(EXIT.ok)
  })

  /* AND A STREAM READ TO THE END SENDS NO CANCEL. Otherwise the assertions
   * above would pass for a client that cancels everything, which tells a
   * shelf a completed read was abandoned. */
  it('sends no cancel for a stream that was read to the end', async () => {
    const shelf = await serveOverTheWire()
    const run = await overTheWire(shelf, ['book', 'list', '--json'])
    expect(run.code).toBe(EXIT.ok)
    expect(JSON.parse(run.out)).toHaveLength(MANY)
    expect(shelf.wasCancelled('book.list')).toBe(false)
    expect(shelf.pagesBuilt('book.list')).toBe(PAGES)
  })
})

describe('paper --shelf', () => {
  /**
   * THE PRODUCTION CLOSE PATH, which every other case here replaces.
   *
   * `overTheWire` hands `remoteCaller` a no-op `close` so the harness can keep
   * the session for the next assertion — a deliberate narrowing, and it means
   * nothing else in this file exercises `runCommand`'s contract that the
   * caller is closed on success AND on failure. A remote caller that stopped
   * closing would leak a session per command, and every other test would stay
   * green.
   */
  it('closes the caller it was given, whether the command succeeded or failed', async () => {
    for (const [argv, expected] of [
      [['--shelf', 'k', 'book', 'get', 'b0000'], EXIT.ok],
      [['--shelf', 'k', 'book', 'get', 'nope'], EXIT.refused],
    ] as const) {
      const shelf = await serveOverTheWire()
      let closed = 0
      const code = await paper({
        argv,
        sinks: { out: () => {}, err: () => {} },
        remote: async () =>
          remoteCaller({
            channel: shelf.channel,
            close: async () => void (closed += 1),
          }),
      })
      expect(code, argv.join(' ')).toBe(expected)
      expect(closed, argv.join(' ')).toBe(1)
    }
  })

  /* AND A CLOSE THAT FAILS IS THE ANSWER, not a footnote after one. A write
   * whose caller could not be closed may not have landed, and reporting
   * success would tell a script otherwise. */
  it('reports a failure to close rather than announcing success over it', async () => {
    const shelf = await serveOverTheWire()
    const err: string[] = []
    const out: string[] = []
    const code = await paper({
      argv: ['--shelf', 'k', 'book', 'set', 'b0005', '--title', 'x'],
      sinks: { out: (line) => out.push(line), err: (line) => err.push(line) },
      remote: async () =>
        remoteCaller({
          channel: shelf.channel,
          close: async () => {
            throw new Error('the session would not close')
          },
        }),
    })
    expect(code).toBe(EXIT.refused)
    expect(err.join('\n')).toMatch(/could not be closed cleanly/)
    expect(out).toEqual([])
  })

  it('runs the identical command through the remote caller it is given', async () => {
    const shelf = await serveOverTheWire()
    const out: string[] = []
    const code = await paper({
      argv: ['--shelf', 'the-shelf', 'book', 'get', 'b0002', '--json'],
      sinks: { out: (line) => out.push(line), err: () => {} },
      remote: async () => remoteCaller({ channel: shelf.channel, close: async () => {} }),
    })
    expect(code).toBe(EXIT.ok)
    expect((JSON.parse(out.join('\n')) as BookRow).title).toBe('Title 2')
  })

  /* The one difference a reader is allowed to see, besides latency: a grant
   * refusal where one applies. */
  it('exits non-zero on a grant refusal, and says forbidden', async () => {
    const shelf = await serveOverTheWire(['mark:read'])
    const err: string[] = []
    const code = await paper({
      argv: ['--shelf', 'the-shelf', 'book', 'list'],
      sinks: { out: () => {}, err: (line) => err.push(line) },
      remote: async () => remoteCaller({ channel: shelf.channel, close: async () => {} }),
    })
    expect(code).toBe(EXIT.refused)
    expect(err.join('\n')).toContain('forbidden')
  })

  /**
   * A `--shelf` WRITE MUST NOT TOUCH THIS MACHINE'S LIBRARY AT ALL.
   *
   * The shelf owns its own library and takes its own lock; a local lock here
   * would block the app on this machine over a write that is not about it.
   *
   * IT USED TO OMIT `dataDir`, which meant the assertion "no lock is taken"
   * was made against the REAL application directory: if the routing ever
   * regressed, the test would have written a lock into the developer's own
   * Paper — and, worse, could have PASSED while doing it, because nothing
   * looked. A temporary directory is given, and it is then checked to be
   * untouched, which is the assertion the old one only claimed.
   */
  it('takes no advisory lock — and touches nothing locally — for a remote write', async () => {
    const shelf = await serveOverTheWire()
    const dataDir = await mkdtemp(join(tmpdir(), 'paper-remote-'))
    try {
      const code = await paper({
        argv: ['--shelf', 'the-shelf', 'book', 'set', 'b0004', '--title', 'Remote write'],
        dataDir,
        sinks: { out: () => {}, err: () => {} },
        remote: async () => remoteCaller({ channel: shelf.channel, close: async () => {} }),
      })
      expect(code).toBe(EXIT.ok)
      expect(shelf.services.library.getSnapshot().find((one) => one.bookId === 'b0004')?.title).toBe('Remote write')

      /* NOTHING WAS CREATED. Not a lock, not an index, not a `books/` — the
       * local host was never opened. An empty directory is the whole
       * assertion, and it is one the old test could not make. */
      expect(await readdir(dataDir)).toEqual([])
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  /* AND THE SAME FOR A READ, which takes no lock either way — so this is
   * about the host never being opened rather than about locking. */
  it('opens no local host for a remote read', async () => {
    const shelf = await serveOverTheWire()
    const dataDir = await mkdtemp(join(tmpdir(), 'paper-remote-'))
    try {
      const code = await paper({
        argv: ['--shelf', 'the-shelf', 'book', 'list'],
        dataDir,
        sinks: { out: () => {}, err: () => {} },
        remote: async () => remoteCaller({ channel: shelf.channel, close: async () => {} }),
      })
      expect(code).toBe(EXIT.ok)
      expect(await readdir(dataDir)).toEqual([])
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
