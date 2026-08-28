import { describe, expect, it } from 'vitest'
import {
  MAX_RECORD_FIELD,
  PAGE_ROWS,
  parseRecord,
  tagKey,
  SERVICE_ERRORS,
  SERVICE_NAMES,
  buildReadServices,
  buildServices,
  handlerFor,
  readServices,
  serviceDescriptor,
  type BookRow,
  type DevicePort,
  type ServiceDescriptor,
} from '../../../kernel'
import { ENVELOPE_ERRORS, ENVELOPE_VERSION, MAX_PAYLOAD_BYTES, ServiceCallError, encodeFrame } from './envelope'
import { FORBIDDEN, markRow, refusalCode, seedBook, serveTable } from './serviceTable.testkit'

/**
 * THE READ SERVICES, over the envelope (phase 11, WI-11.3).
 *
 * The plan asks for three cases per read service, and they are the three that
 * a read service can get wrong in a way nothing else would notice:
 *
 *   1. the happy path — it answers, with the shape the table declares
 *   2. a caller WITHOUT the grant — `forbidden`, and the handler never ran.
 *      "Never ran" is ASSERTED, by wrapping every built handler and recording
 *      entry: the refusal has to come before the body of the service, or a
 *      peer learns from timing and from side effects what it may not learn
 *      from the answer.
 *   3. a stream cancelled MID-PAGE — the generator stops. A stream that went
 *      on producing pages for a peer that has gone is a memory leak with a
 *      clock on it, on the one library size this was written for.
 *
 * The list of services under test is READ FROM THE TABLE (`readServices()`),
 * not written out here, so a read service added to the table with no case
 * fails this file rather than sliding past it.
 */

/** Enough books to fill more than one page, so paging and cancellation are
 *  observable rather than theoretical. */
const MANY = PAGE_ROWS * 2 + 7
const books = Array.from({ length: MANY }, (_one, index) =>
  seedBook(`b${String(index).padStart(4, '0')}`, {
    author: index % 2 === 0 ? 'Even Author' : 'Odd Author',
    tags: index % 3 === 0 ? ['philosophy'] : [],
    finished: index % 5 === 0,
    hasContent: index % 2 === 0,
    addedAt: 1_700_000_000_000 + index,
  }),
)

/** A body that satisfies each read service's required fields. */
const REQUEST: Readonly<Record<string, unknown>> = {
  'book.list': {},
  'book.get': { book: 'b0000' },
  'book.search': { query: 'Title b0001' },
  'mark.list': { book: 'b0000' },
  'card.list': {},
  'tag.list': {},
  'trash.list': {},
  'content.locate': { book: 'b0000' },
  /* A bounded slice, so the case does not depend on how long the fixture's
     content is. `content.read` refuses when the shelf has no filesystem, which
     is what this harness gives it — see the case below. */
  'content.read': { book: 'b0000', offset: 0, length: 16 },
  /* NO RANGE. A cover is drawn whole or not at all, so `cover.read` takes only
     the book — see its row in the table. */
  'cover.read': { book: 'b0000' },
  'shelf.status': {},
  'device.list': {},
}

/** Drain a stream into one flat list of rows. */
async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const rows: unknown[] = []
  for await (const page of iterable) rows.push(...(page as unknown[]))
  return rows
}

/** Every read service, from the table rather than from a list here. */
const READS: readonly ServiceDescriptor[] = readServices()

describe('the read services, service by service', () => {
  it('covers every read service the table declares', () => {
    expect(READS.map((one) => one.name).sort()).toEqual(Object.keys(REQUEST).sort())
  })

  for (const descriptor of READS) {
    const body = REQUEST[descriptor.name]

    it(`${descriptor.name} answers over the wire`, async () => {
      const shelf = serveTable({
        books,
        /* CONTENT FOR ONE BOOK, so `content.read` has bytes to answer with
           rather than refusing "no content on this shelf". The fake filesystem
           has no `readRange`, so this also exercises `readRangeOf`'s fallback —
           the path a test filesystem is expected to take. */
        files: {
          'books/b0000/content.epub': 'PK\u0003\u0004 pretend epub bytes',
          /* AND A JACKET, so `cover.read` has bytes to answer with. Its empty
             answer is the ORDINARY case — most books have none — so a fixture
             without one would make this case pass while proving nothing. */
          'books/b0000/cover.jpg': '\u00ff\u00d8\u00ff pretend jpeg bytes',
        },
        /* `device.list` and `shelf.sync` need ports; `shelf.status` does not,
         * and answers what it can. Bound here so the happy path of
         * `device.list` is a real answer rather than a refusal. */
        devices: {
          list: async () => [
            { id: 'phone', name: 'Phone', platform: 'ios', role: 'satchel', grants: ['book:read'], pairedAt: 1, lastSeenAt: 2 },
          ],
          grant: async (id: string, grants: readonly string[]) => ({
            id,
            name: 'Phone',
            platform: 'ios',
            role: 'satchel',
            grants,
            pairedAt: 1,
            lastSeenAt: 2,
          }),
          forget: async () => true,
        },
      })
      if (descriptor.kind === 'stream') {
        const rows = await drain(shelf.client.stream(descriptor.name, body))
        expect(Array.isArray(rows)).toBe(true)
      } else {
        await expect(shelf.client.call(descriptor.name, body)).resolves.toBeDefined()
      }
    })

    it(`${descriptor.name} is forbidden before the handler runs, without its grant`, async () => {
      /* Every grant BUT this one, so the refusal is about the grant the
       * service names and not about an empty list. */
      const others = ['book:read', 'book:write', 'mark:read', 'card:read', 'device:read', 'shelf:read'].filter(
        (grant) => grant !== descriptor.grant,
      )
      const shelf = serveTable({ books, grants: others })
      const attempt =
        descriptor.kind === 'stream'
          ? drain(shelf.client.stream(descriptor.name, body))
          : shelf.client.call(descriptor.name, body)
      expect(refusalCode(await attempt.catch((error: unknown) => error))).toBe(FORBIDDEN)
      /* THE HANDLER NEVER RAN. Recorded by wrapping the handler itself, so
       * this holds for every service in the table rather than only for the
       * ones that would have touched a store on the way past. */
      expect(shelf.ran).toEqual([])
    })
  }
})

describe('a stream cancelled mid-page', () => {
  /**
   * ⚠️ **THIS ASSERTED THAT THE CLIENT'S ITERATOR WAS DONE**, which
   * `iterator.return()` makes true on the spot — before any frame is sent, and
   * whether or not one ever is. A client that dropped the `cancel` on the floor
   * passed it, while the generator on the shelf went on building pages for a
   * peer that had gone. That is the leak the case is named for, and it was the
   * one thing it could not see.
   *
   * The question is about the SHELF, so the answer has to come from there:
   * `pagesOf` counts what the handler actually yielded.
   */
  it('stops producing pages when the caller stops reading', async () => {
    const shelf = serveTable({ books })
    const stream = shelf.client.stream('book.list', {})
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect((first.value as BookRow[]).length).toBe(PAGE_ROWS)

    /* MORE TO COME. The fixture is more than two pages, so a handler that
       stopped here stopped because it was told to. */
    expect(shelf.pagesOf('book.list')).toBeLessThan(Math.ceil(MANY / PAGE_ROWS))

    /* `return()` is what a `break` out of `for await` calls, and it is the
     * client's cue to send `cancel`. The router aborts the handler's signal;
     * the generator checks it before each yield, so no further page is
     * built. */
    await iterator.return?.()
    const after = await iterator.next()
    expect(after.done).toBe(true)

    const produced = shelf.pagesOf('book.list')
    /* SETTLED, so anything still running has had its chance to run. */
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      shelf.pagesOf('book.list'),
      'the handler went on building pages for a peer that had gone',
    ).toBe(produced)
    expect(produced, 'and it stopped well short of the whole shelf').toBeLessThan(
      Math.ceil(MANY / PAGE_ROWS),
    )
  })

  it('answers the whole shelf when nobody cancels — the paging is real', async () => {
    const shelf = serveTable({ books })
    const rows = (await drain(shelf.client.stream('book.list', {}))) as BookRow[]
    expect(rows).toHaveLength(MANY)
    /* Newest first, ids breaking the tie — a total order, so two calls agree. */
    expect(rows[0]?.bookId).toBe(`b${String(MANY - 1).padStart(4, '0')}`)
  })
})

describe('what the read services actually answer', () => {
  it('book.list narrows by every filter it declares, and they compose by AND', async () => {
    const shelf = serveTable({ books })
    const philosophy = (await drain(shelf.client.stream('book.list', { tag: 'Philosophy' }))) as BookRow[]
    /* Folded, so the caller's capital P finds the stored lower-case tag. */
    expect(philosophy.length).toBe(books.filter((one) => (one.tags ?? []).includes('philosophy')).length)

    const even = (await drain(shelf.client.stream('book.list', { author: 'even' }))) as BookRow[]
    expect(even.every((one) => one.author === 'Even Author')).toBe(true)

    const both = (await drain(shelf.client.stream('book.list', { tag: 'philosophy', finished: true }))) as BookRow[]
    expect(both.length).toBeLessThan(philosophy.length)
    expect(both.every((one) => one.finished && one.tags.includes('philosophy'))).toBe(true)

    const downloaded = (await drain(shelf.client.stream('book.list', { downloaded: false }))) as BookRow[]
    expect(downloaded.every((one) => !one.hasContent)).toBe(true)
  })

  it('book.list honours `since` as a delta over the stamps a shelf row carries', async () => {
    const shelf = serveTable({ books })
    const since = 1_700_000_000_000 + MANY - 3
    const rows = (await drain(shelf.client.stream('book.list', { since }))) as BookRow[]
    expect(rows.map((one) => one.addedAt).every((at) => (at ?? 0) >= since)).toBe(true)
    expect(rows).toHaveLength(3)
  })

  it('book.list stops at `limit`', async () => {
    const shelf = serveTable({ books })
    expect(await drain(shelf.client.stream('book.list', { limit: 5 }))).toHaveLength(5)
  })

  it('book.get answers one row and refuses an id the shelf does not hold', async () => {
    const shelf = serveTable({ books })
    const row = (await shelf.client.call('book.get', { book: 'b0003' })) as BookRow
    expect(row.title).toBe('Title b0003')
    expect(refusalCode(await shelf.client.call('book.get', { book: 'nope' }).catch((e: unknown) => e))).toBe('not-found')
  })

  it("book.search speaks the shelf's own query language", async () => {
    const shelf = serveTable({ books })
    const tagged = (await drain(shelf.client.stream('book.search', { query: 'tag:philosophy' }))) as BookRow[]
    expect(tagged.every((one) => one.tags.includes('philosophy'))).toBe(true)
    const excluded = (await drain(shelf.client.stream('book.search', { query: '-tag:philosophy' }))) as BookRow[]
    expect(excluded.every((one) => !one.tags.includes('philosophy'))).toBe(true)
    const finished = (await drain(shelf.client.stream('book.search', { query: 'is:finished' }))) as BookRow[]
    expect(finished.every((one) => one.finished)).toBe(true)
  })

  it('a wire row carries no device-local field', async () => {
    const shelf = serveTable({ books: [seedBook('one', { origin: '/Users/someone/Books/x.epub', ext: 'epub' })] })
    const row = (await shelf.client.call('book.get', { book: 'one' })) as Record<string, unknown>
    expect(row['origin']).toBeUndefined()
    expect(row['ext']).toBeUndefined()
    /* `content.locate` is the noun for this device's copy, and IS where `ext`
     * is told. */
    const where = (await shelf.client.call('content.locate', { book: 'one' })) as Record<string, unknown>
    expect(where['ext']).toBe('epub')
  })

  it('shelf.status answers what it can with no ports bound, and says null for the rest', async () => {
    /* `sizes: null` — the harness binds a real size port by default now, and
       "no ports bound" is exactly what this case is named for. */
    const shelf = serveTable({ books, sizes: null })
    const status = (await shelf.client.call('shelf.status', {})) as Record<string, unknown>
    expect(status['books']).toBe(MANY)
    expect(status['role']).toBeNull()
    expect(status['endpointId']).toBeNull()
    expect(status['journalSeq']).toBeNull()
    expect(status['bytes']).toBeNull()
  })

  it('device.list refuses by name where there is no transport, rather than answering empty', async () => {
    const shelf = serveTable({ books })
    const failure = await shelf.client.call('device.list', {}).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('unsupported')
  })

  it('refuses a body the input schema does not describe', async () => {
    const shelf = serveTable({ books })
    expect(refusalCode(await shelf.client.call('book.get', { boook: 'b0000' }).catch((e: unknown) => e))).toBe('malformed')
    expect(refusalCode(await shelf.client.call('book.get', {}).catch((e: unknown) => e))).toBe('malformed')
    expect(refusalCode(await shelf.client.call('book.get', { book: 7 }).catch((e: unknown) => e))).toBe('malformed')
    expect(refusalCode(await shelf.client.call('book.get', 'b0000').catch((e: unknown) => e))).toBe('malformed')
  })

  it('re-asks the grant on an open session, so a revocation takes effect mid-stream', async () => {
    const shelf = serveTable({ books })
    const stream = shelf.client.stream('book.list', {})
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    shelf.setGrants([])
    await expect(iterator.next()).rejects.toThrow()
  })
})

/**
 * WHAT THE 2026-08-21 AUDIT FOUND, one case each.
 *
 * Every one of these was reachable through the published table, and every one
 * was silent: an answer that looked right, a destroy that reported success, a
 * page that would have been refused by the transport. They are here rather
 * than beside their modules because the table is where they were reachable
 * from, and reaching them is the whole test.
 */
describe('what an audit of the published surface found', () => {
  it('refuses a book id with nothing in it — an empty folder segment is the LIBRARY', async () => {
    const shelf = serveTable({ books: [seedBook('real')] })
    for (const id of ['', '   ']) {
      expect(refusalCode(await shelf.client.call('book.add', { book: id, title: 'x' }).catch((e: unknown) => e))).toBe(
        'malformed',
      )
      expect(refusalCode(await shelf.client.call('book.remove', { book: id }).catch((e: unknown) => e))).toBe('malformed')
    }
    /* And the library is untouched. */
    expect(shelf.services.library.getSnapshot()).toHaveLength(1)
  })

  it('refuses a book whose FOLDER an existing book already owns', async () => {
    const shelf = serveTable({ books: [seedBook('book_a_b')] })
    /* `safeId` maps every character outside [A-Za-z0-9] to `_`, so these two
     * different ids are one directory. Compared by id alone, the add would
     * have written a record over a book that is already there. */
    const failure = await shelf.client.call('book.add', { book: 'book:a/b', title: 'x' }).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('conflict')
    expect(String(failure)).toContain('book_a_b')
  })

  it('refuses an explicitly empty book list rather than untagging the whole shelf', async () => {
    const shelf = serveTable({ books: [seedBook('one', { tags: ['sea'] }), seedBook('two', { tags: ['sea'] })] })
    expect(refusalCode(await shelf.client.call('tag.remove', { tag: 'sea', book: [] }).catch((e: unknown) => e))).toBe(
      'malformed',
    )
    /* Both books keep the tag: the refusal happened before any write. */
    const rows = (await drain(shelf.client.stream('book.list', { tag: 'sea' }))) as BookRow[]
    expect(rows).toHaveLength(2)
  })

  it('counts what a tag write CHANGED, not what it was handed', async () => {
    const shelf = serveTable({ books: [seedBook('one', { tags: ['sea'] }), seedBook('two')] })
    /* One of the two already carries it. */
    expect(await shelf.client.call('tag.add', { tag: 'sea', book: ['one', 'two'] })).toEqual({ tag: 'sea', books: 1 })
    /* And removing from a book that does not carry it counts as nothing. */
    expect(await shelf.client.call('tag.remove', { tag: 'nothing', book: ['one', 'two'] })).toEqual({
      tag: 'nothing',
      books: 0,
    })
  })

  /* THE HARNESS'S OWN STORE, asserted rather than assumed.
   *
   * `serveTable` used to prime only the in-memory index, so every write
   * service in this file ran against a shelf whose rows had no `book.json`
   * behind them — a state no real library reaches, and the one state where a
   * writer that loses the record's other fields still looks correct. */
  it('writes through to the record, keeping the fields the write did not name', async () => {
    const shelf = serveTable({ books: [seedBook('one', { author: 'Melville', series: 'none' })] })
    const before = shelf.fs.store.get('books/one/book.json')
    expect(before).toBeDefined()
    expect(JSON.parse(new TextDecoder().decode(before as Uint8Array))).toMatchObject({
      bookId: 'one',
      author: 'Melville',
    })

    expect(await shelf.client.call('book.set', { book: 'one', position: 'epubcfi(/6/4)', progress: 0.25 })).toMatchObject(
      { bookId: 'one', position: 'epubcfi(/6/4)', progress: 0.25 },
    )

    const after = JSON.parse(new TextDecoder().decode(shelf.fs.store.get('books/one/book.json') as Uint8Array))
    expect(after).toMatchObject({ position: 'epubcfi(/6/4)', progress: 0.25, author: 'Melville', series: 'none' })
  })

  /**
   * ONE REQUEST, ONE RECORD WRITE.
   *
   * `book.set` ran three separate store mutations, so two concurrent requests
   * interleaved into a record matching neither — and a failure partway left
   * the earlier fields persisted with nothing saying the request had only
   * half happened.
   */
  it('lands every field of one book.set together, or not at all', async () => {
    const shelf = serveTable({ books: [seedBook('one', { author: 'Melville', progress: 0.5 })] })
    const writes: string[] = []
    const store = shelf.fs.store
    const originalSet = store.set.bind(store)
    store.set = ((path: string, bytes: Uint8Array) => {
      if (path === 'books/one/book.json') writes.push(new TextDecoder().decode(bytes))
      return originalSet(path, bytes)
    }) as typeof store.set

    await shelf.client.call('book.set', {
      book: 'one',
      finished: true,
      position: 'epubcfi(/6/4)',
    })

    /* ONE write of the record, carrying both fields — and the position did
     * not reset the progress it never named. */
    expect(writes).toHaveLength(1)
    const landed = JSON.parse(writes[0] as string)
    expect(landed).toMatchObject({
      finished: true,
      position: 'epubcfi(/6/4)',
      progress: 0.5,
      author: 'Melville',
    })
    /* The ledger's registers are still stamped — the reason three separate
     * mutators existed — and stamped from one reading, so they agree. */
    expect(landed.finishedAt).toEqual(landed.positionAt)
    expect(typeof landed.finishedAt).toBe('string')
  })

  /**
   * A PARTIAL RESTORE IS NOT A RESTORE, and used to answer as one.
   *
   * `restoreBook` moves file by file and leaves behind any name a live file
   * already owns. That was reported as plain `restored: true`, so the reader
   * was told their book was back while its record sat in the trash ageing
   * towards the sweep that deletes it.
   */
  it('names what a restore had to leave in the trash', async () => {
    const shelf = serveTable({
      books: [],
      files: {
        'trash/one/book.json': JSON.stringify({ bookId: 'one', title: 'Moby-Dick', author: 'M' }),
        'trash/one/marks.json': '[]',
        'trash/one/.removed': String(1_700_000_000_000),
        /* A live marks file already owns that name, so the trashed one stays. */
        'books/one/marks.json': '[]',
      },
    })
    expect(await shelf.client.call('book.restore', { book: 'one' })).toEqual({
      bookId: 'one',
      restored: true,
      held: ['marks.json'],
    })
  })

  it('reports a book the trash never held, without claiming a restore', async () => {
    const shelf = serveTable({ books: [] })
    expect(await shelf.client.call('book.restore', { book: 'nobody' })).toEqual({
      bookId: 'nobody',
      restored: false,
      held: [],
    })
  })

  it('refuses a number outside its declared bounds rather than clamping it', async () => {
    const shelf = serveTable({ books })
    for (const body of [{ limit: -1 }, { limit: 1.5 }, { since: -1 }]) {
      expect(refusalCode(await drain(shelf.client.stream('book.list', body)).catch((e: unknown) => e))).toBe('malformed')
    }
    expect(
      refusalCode(await shelf.client.call('book.set', { book: 'b0000', position: 'x', progress: 2 }).catch((e: unknown) => e)),
    ).toBe('malformed')
  })

  it('pages by BYTES as well as rows, so one long highlight cannot burst a frame', async () => {
    /* A mark's `text` is bounded at `MAX_MARK_TEXT` (8 000) — at the table
     * on the way in and, since round 1 of the audit, at the storage door on
     * the way out, so a planted 64 KiB row is cut to the bound before it can
     * be paged. At the bound, 120 marks are ~960 KB: well past `PAGE_BYTES`
     * (512 KiB) and well under `PAGE_ROWS` (200) — a row-only pager would
     * have put them in one frame. */
    const long = 'x'.repeat(8_000)
    const shelf = serveTable({
      books: [seedBook('one')],
      files: {
        'books/one/marks.json': JSON.stringify(
          Array.from({ length: 120 }, (_one, index) => markRow(`m${index}`, 'one', { text: long })),
        ),
      },
    })
    const seen: number[] = []
    for await (const page of shelf.client.stream('mark.list', { book: 'one' })) seen.push((page as unknown[]).length)
    expect(seen.length).toBeGreaterThan(1)
    expect(Math.max(...seen)).toBeLessThan(120)
    expect(seen.reduce((total, one) => total + one, 0)).toBe(120)
  })

  it('gives book.get the registers a shelf listing does not carry', async () => {
    const shelf = serveTable({
      books: [seedBook('one', { positionAt: '0000000001-0000-a1b2c3d4e5f60718' as never })],
    })
    const one = (await shelf.client.call('book.get', { book: 'one' })) as Record<string, unknown>
    expect(one['positionAt']).toBe('0000000001-0000-a1b2c3d4e5f60718')
    expect(one['finishedAt']).toBeNull()
    expect(one['tagClock']).toBeNull()
    /* And a LIST row does not: a tag clock on every row of a 2 000-book
     * listing pays for the one caller that asked about one book. */
    const rows = (await drain(shelf.client.stream('book.list', {}))) as Record<string, unknown>[]
    expect(rows[0] && 'tagClock' in rows[0]).toBe(false)
  })

  it('refuses a grant that is not one, rather than storing a permission that matches nothing', async () => {
    const shelf = serveTable({
      devices: {
        list: async () => [],
        grant: async (id, grants) => ({ id, name: '', platform: '', role: 'satchel', grants, pairedAt: 0, lastSeenAt: 0 }),
        forget: async () => true,
      },
    })
    for (const grant of ['book', 'book:', ':read', 'a:b:c', 'book read', '*', 'Book:Read']) {
      expect(refusalCode(await shelf.client.call('device.grant', { device: 'x', grants: [grant] }).catch((e: unknown) => e))).toBe(
        'malformed',
      )
    }
    await expect(shelf.client.call('device.grant', { device: 'x', grants: ['book:read', 'mark:*'] })).resolves.toBeDefined()
  })
})

describe('what the audit’s verification pass then found', () => {
  it('evicts every stored content file, not the first one it sees', async () => {
    const shelf = serveTable({
      books: [seedBook('one', { hasContent: true })],
      files: { 'books/one/content.epub': 'EPUB', 'books/one/content.pdf': 'PDF' },
    })
    const after = (await shelf.client.call('content.evict', { book: 'one' })) as Record<string, unknown>
    expect(after['here']).toBe(false)
    /* Both gone. One left behind under a row saying the bytes are gone is a
     * lie the reader cannot see. */
    const fs = shelf.services.fs
    expect(await fs?.exists('books/one/content.epub')).toBe(false)
    expect(await fs?.exists('books/one/content.pdf')).toBe(false)
  })

  it('reports the extension the FOLDER holds, not the one the record forgot', async () => {
    /* A book whose bytes arrived over the wire has no device-local `ext`:
     * what travels is `format`. Reporting null for a file plainly on disk
     * sends a caller looking for bytes it was just told are here. */
    const shelf = serveTable({
      books: [seedBook('one', { hasContent: true })],
      files: { 'books/one/content.pdf': 'PDF' },
    })
    const where = (await shelf.client.call('content.locate', { book: 'one' })) as Record<string, unknown>
    expect(where['here']).toBe(true)
    expect(where['ext']).toBe('pdf')
  })

  it('counts one book once, however many times a caller names it', async () => {
    const shelf = serveTable({ books: [seedBook('one')] })
    expect(await shelf.client.call('tag.add', { tag: 'sea', book: ['one', 'one', 'one'] })).toEqual({
      tag: 'sea',
      books: 1,
    })
  })

  it('rethrows a write failure from mark.remove instead of reporting it as absent', async () => {
    const shelf = serveTable({
      books: [seedBook('one')],
      files: { 'books/one/marks.json': JSON.stringify([markRow('m1', 'one')]) },
    })
    /* The store knows the mark; the WRITE is what fails. Reported as
     * `removed: false`, a caller would believe their mark is gone while it is
     * still on disk. */
    const fs = shelf.services.fs
    const original = fs!.writeFile
    fs!.writeFile = async () => {
      throw new Error('disk full')
    }
    try {
      expect(refusalCode(await shelf.client.call('mark.remove', { mark: 'm1', book: 'one' }).catch((e: unknown) => e))).toBe(
        'internal',
      )
    } finally {
      fs!.writeFile = original
    }
    /* An id nobody has is still an absence, not a failure. */
    expect(await shelf.client.call('mark.remove', { mark: 'nope', book: 'one' })).toEqual({ id: 'nope', removed: false })
  })
})

describe('what the third pass found', () => {
  /* macOS's default APFS volume is case-INSENSITIVE, so `books/Case` and
   * `books/case` are one directory. Compared case-sensitively, the second
   * write replaces the first record while both calls report success. */
  it('refuses a book whose folder differs from an existing one only in case', async () => {
    const shelf = serveTable({ books: [seedBook('book_case')] })
    expect(refusalCode(await shelf.client.call('book.add', { book: 'BOOK:CASE', title: 'x' }).catch((e: unknown) => e))).toBe(
      'conflict',
    )
  })

  /* `parseRecord` SLICES a prose field, which is right for a hand-edited file
   * and wrong for an API: the write reports success with the caller's value
   * and stores a shorter one, and only the next read disagrees. */
  it('refuses a field past the bound the record enforces, rather than storing a shorter one', async () => {
    const shelf = serveTable({ books: [seedBook('one')] })
    const tooLong = 'x'.repeat(MAX_RECORD_FIELD + 1)
    /* `book.add`, since WI-20.7: `book.set` no longer takes a title at all, and
     * `add` is the one write left that carries a prose field to the record. */
    const failure = await shelf.client.call('book.add', { book: 'two', title: tooLong }).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('malformed')
    expect(String(failure)).toContain(String(MAX_RECORD_FIELD))
    /* Exactly at the bound is fine — the refusal is past it, not near it. */
    await expect(shelf.client.call('book.add', { book: 'three', title: 'y'.repeat(MAX_RECORD_FIELD) })).resolves.toBeDefined()
  })

  /**
   * WI-20.7 — A RENAME IS NOT OFFERED, and the refusal says so by name.
   *
   * `book.set --title` wrote through `patch` with no stamp, so the next open
   * or enrichment let the parse win again and sync's metadata group — taken
   * whole by `parsedAt`, which `patch` never moved — carried the old title
   * back. The service shipped an edit the kernel could not keep. Withdrawn
   * from the row rather than silently dropped: a caller sending the field is
   * told why, not "no such field", and the record is untouched.
   */
  it('refuses a title or an author on book.set by name — a rename is not offered', async () => {
    const shelf = serveTable({ books: [seedBook('one', { author: 'Melville' })] })
    for (const [field, value] of [
      ['title', 'Renamed'],
      ['author', 'Somebody Else'],
    ] as const) {
      const failure = await shelf.client.call('book.set', { book: 'one', [field]: value }).catch((e: unknown) => e)
      expect(refusalCode(failure)).toBe('malformed')
      expect(String(failure)).toContain(field)
      expect(String(failure)).toMatch(/rename/i)
    }
    const record = JSON.parse(new TextDecoder().decode(shelf.fs.store.get('books/one/book.json') as Uint8Array))
    expect(record).toMatchObject({ title: 'Title one', author: 'Melville' })
  })

  /* `hasContent` is derived from the folder and CACHED, and the index is
   * allowed to be behind. Trusting a stale `false` made `content.evict`
   * delete nothing and answer `here: false` over a file plainly on disk. */
  it('believes the folder over a stale hasContent, in both directions', async () => {
    const stale = serveTable({
      books: [seedBook('one', { hasContent: false })],
      files: { 'books/one/content.pdf': 'PDF' },
    })
    const found = (await stale.client.call('content.locate', { book: 'one' })) as Record<string, unknown>
    expect(found['here']).toBe(true)
    expect(found['ext']).toBe('pdf')
    const evicted = (await stale.client.call('content.evict', { book: 'one' })) as Record<string, unknown>
    expect(evicted['here']).toBe(false)
    expect(await stale.services.fs?.exists('books/one/content.pdf')).toBe(false)

    /* And the other way: a row claiming bytes over an empty folder. */
    const empty = serveTable({ books: [seedBook('two', { hasContent: true })] })
    const absent = (await empty.client.call('content.locate', { book: 'two' })) as Record<string, unknown>
    expect(absent['here']).toBe(false)
  })
})

describe('the contributions themselves', () => {
  it('registers exactly the table, in table order, with the table’s grants', () => {
    const shelf = serveTable()
    const built = buildServices({ services: shelf.services })
    expect(built.map((one) => one.name)).toEqual([...SERVICE_NAMES])
    for (const contribution of built) {
      expect(contribution.grant).toBe(serviceDescriptor(contribution.name)?.grant)
    }
  })

  it('narrows to the read half without inventing a second list', () => {
    const shelf = serveTable()
    const built = buildReadServices({ services: shelf.services })
    expect(built.map((one) => one.name).sort()).toEqual(READS.map((one) => one.name).sort())
  })

  /* `handlerFor` is a public export, so a descriptor built by hand can reach
   * it. An unchecked lookup answers `undefined(env)` — a `TypeError` naming
   * nothing — where a refusal names the service. */
  it('refuses a descriptor the table does not hold, by name', () => {
    const shelf = serveTable()
    const invented = { ...serviceDescriptor('book.get')!, name: 'book.destroy' as `${string}.${string}` }
    expect(() => handlerFor(invented as never, { services: shelf.services })).toThrow(
      expect.objectContaining({ code: 'unsupported' }) as never,
    )
  })
})

describe('mark.list, which has two halves to read', () => {
  /* The snapshot splits annotations from bookmarks at the one door every
   * subscriber reads through. A `mark.list` that read `all` alone would answer
   * "every mark" while silently omitting every bookmark on the shelf. */
  it('answers with bookmarks as well as annotations when no book is named', async () => {
    const shelf = serveTable({
      books: [seedBook('one'), seedBook('two')],
      files: {
        'books/one/marks.json': JSON.stringify([
          markRow('h1', 'one', { kind: 'highlight' }),
          markRow('b1', 'one', { kind: 'bookmark' }),
        ]),
        'books/two/marks.json': JSON.stringify([markRow('b2', 'two', { kind: 'bookmark' })]),
      },
    })
    const rows = (await drain(shelf.client.stream('mark.list', {}))) as { id: string; kind: string }[]
    expect(rows.map((one) => one.id).sort()).toEqual(['b1', 'b2', 'h1'])
    expect(rows.filter((one) => one.kind === 'bookmark')).toHaveLength(2)
  })

  it('answers with both halves for one book too', async () => {
    const shelf = serveTable({
      books: [seedBook('one')],
      files: {
        'books/one/marks.json': JSON.stringify([
          markRow('h1', 'one', { kind: 'highlight' }),
          markRow('b1', 'one', { kind: 'bookmark' }),
        ]),
      },
    })
    const rows = (await drain(shelf.client.stream('mark.list', { book: 'one' }))) as { id: string }[]
    expect(rows.map((one) => one.id).sort()).toEqual(['b1', 'h1'])
  })
})

/**
 * `device:manage` MUST NOT BE A GRANT-ALL.
 *
 * A peer holding it could name ITSELF, keep `device:manage`, and add every
 * other family — so one permission a human meant as "you may tidy the device
 * list" silently conferred the whole API. Conferring `device:manage` on a
 * third device turns one human decision into an escalation chain.
 *
 * The router's grant check passes in both cases: the caller HOLDS the grant.
 * These are rules the service itself owns, which is why they are refused in
 * the handler and answer `forbidden` — the same code the envelope already
 * uses for an authorization refusal.
 */
describe('device.grant refuses the escalation paths', () => {
  const devices: DevicePort = {
    list: async () => [],
    grant: async (id, grants) => ({
      id,
      name: id,
      platform: 'macos',
      role: 'satchel',
      grants,
      pairedAt: 1,
      lastSeenAt: 2,
    }),
    forget: async () => true,
  }

  it('refuses a peer rewriting its own grants', async () => {
    const shelf = serveTable({ grants: ['device:*'], devices })
    await expect(shelf.client.call('device.grant', { device: 'peer', grants: ['book:*'] })).rejects.toBeDefined()
    const code = await shelf.client.call('device.grant', { device: 'peer', grants: ['book:*'] }).catch(refusalCode)
    expect(code).toBe(FORBIDDEN)
  })

  it('refuses conferring device management over the wire', async () => {
    const shelf = serveTable({ grants: ['device:*'], devices })
    for (const grant of ['device:manage', 'device:*']) {
      const code = await shelf.client.call('device.grant', { device: 'other', grants: [grant] }).catch(refusalCode)
      expect(code, `${grant} must not be grantable`).toBe(FORBIDDEN)
    }
  })

  it('still grants an ordinary family to another device', async () => {
    const shelf = serveTable({ grants: ['device:*'], devices })
    await expect(shelf.client.call('device.grant', { device: 'other', grants: ['book:read'] })).resolves.toBeDefined()
  })
})

/**
 * THE BIGGEST LEGAL ANSWER MUST STILL FIT IN A FRAME.
 *
 * `book.get` is a `req`, not a `stream`: there is no second page for it to
 * spill into, so a response past `MAX_PAYLOAD_BYTES` is not a slow answer, it
 * is a wire error naming nothing. And the record's own bounds decide how big
 * that answer can be — 4 096 tag registers is a legal record, so the only
 * question is how long each may be.
 *
 * It did not fit. The clock parser bounded a register's spelling at
 * `MAX_RECORD_FIELD`, the general record-field cap, while every writer of a
 * tag goes through `normalizeTag` and cuts at sixty. A record hand-edited to
 * the parser's bound — or replicated from a peer that had one — produced a
 * 6.4 MB `book.get` response. Measured here rather than reasoned about,
 * because the arithmetic is exactly the kind that stays right in a comment
 * while a bound moves underneath it.
 */
describe('the largest response the record permits', () => {
  it('fits one frame, with a record filled to every bound it declares', async () => {
    const tagField = (serviceDescriptor('tag.add') as ServiceDescriptor).input.find((one) => one.name === 'tag')
    const tagMax = tagField?.maxLength
    expect(tagMax).toBeGreaterThan(0)

    /* The clock's own cap, read off the parser by filling past it. */
    const registers: Record<string, unknown> = {}
    for (let index = 0; index < 8_192; index += 1) {
      const spelling = `t${index}`.padEnd(tagMax as number, 'x')
      registers[spelling.toLowerCase()] = {
        on: true,
        at: '018f00000000-0001-abcdefabcdefabcd',
        spelling,
      }
    }
    const record = parseRecord(
      JSON.stringify({
        bookId: 'one',
        title: 'x'.repeat(MAX_RECORD_FIELD),
        author: 'x'.repeat(MAX_RECORD_FIELD),
        publisher: 'x'.repeat(MAX_RECORD_FIELD),
        series: 'x'.repeat(MAX_RECORD_FIELD),
        subjects: Array.from({ length: 64 }, (_one, index) => `s${index}`.padEnd(MAX_RECORD_FIELD, 'y')),
        tagClock: registers,
      }),
    )
    expect(record).not.toBeNull()
    /* The parser kept a real crowd of them — otherwise this measures nothing. */
    expect(Object.keys((record as { tagClock?: object }).tagClock ?? {}).length).toBeGreaterThan(1_000)

    /* AND THE BOUND THAT MAKES IT FIT, checked where it is enforced.
     *
     * A register spelled past the tag bound is refused outright rather than
     * sliced: slicing at a different length than `normalizeTag` uses is how
     * one tag becomes two spellings, and keeping it is what put the response
     * above at 6.4 MB. */
    const overlong = 'z'.repeat(MAX_RECORD_FIELD)
    const wide = parseRecord(
      JSON.stringify({
        title: 't',
        tagClock: { [tagKey(overlong)]: { on: true, at: '018f00000000-0001-abcdefabcdefabcd', spelling: overlong } },
      }),
    )
    expect(wide?.tagClock).toEqual({})
    /* The same register, spelled inside the bound, IS kept — so the line
     * above is refusing the length and not the fixture. */
    const narrow = 'z'.repeat(tagMax as number)
    expect(
      parseRecord(
        JSON.stringify({
          title: 't',
          tagClock: { [tagKey(narrow)]: { on: true, at: '018f00000000-0001-abcdefabcdefabcd', spelling: narrow } },
        }),
      )?.tagClock,
    ).toHaveProperty(tagKey(narrow))

    const shelf = serveTable({ books: [{ ...(record as object), bookId: 'one' } as never] })
    const answer = await shelf.client.call('book.get', { book: 'one' })
    const payload = new TextEncoder().encode(JSON.stringify(answer)).byteLength
    expect(payload).toBeLessThan(MAX_PAYLOAD_BYTES)
    /* And it really encodes — `encodeFrame` is what refuses an oversized one. */
    expect(() => encodeFrame({ v: ENVELOPE_VERSION, kind: 'res', service: 'book.get', id: 'r1', body: answer })).not.toThrow()
  })
})

/**
 * THE DECLARED SHAPE AND THE ACTUAL ONE.
 *
 * `kind`, `of` and `columns` describe what a service answers, and the CLI and
 * the generated reference both believe them. Until now nothing compared them
 * with what a handler RETURNS: a `req` row that quietly began answering many,
 * or a `columns` entry naming a field the row does not carry, passed every
 * drift test in the table's own suite — because those tests compare the table
 * against itself.
 *
 * `columns` is type-coupled now (a column must be a key of the shape `of`
 * names), which catches the second at compile time. This is the half a type
 * cannot reach: what the handler does at run time.
 */
describe('what the handlers actually answer', () => {
  const shelf = () =>
    serveTable({
      books: [seedBook('one', { hasContent: true }), seedBook('two')],
      files: {
        'books/one/marks.json': JSON.stringify([markRow('m1', 'one')]),
        'trash/gone/book.json': JSON.stringify({ bookId: 'gone', title: 'Gone', author: 'A' }),
        'trash/gone/.removed': String(1_700_000_000_000),
      },
      shelf: {
        facts: async () => ({ role: 'shelf', endpointId: 'ep', journalSeq: 1, epoch: 'e' }),
        sync: async () => ({ started: true, detail: null }),
        verify: async () => ({ ok: true, findings: [], notes: [] }),
      },
      devices: {
        list: async () => [
          { id: 'p1', name: 'A phone', platform: 'ios', role: 'satchel', grants: ['book:read'], pairedAt: 1, lastSeenAt: 2 },
        ],
        grant: async () => {
          throw new Error('not used here')
        },
        forget: async () => false,
      },
    })

  /** A body satisfying whatever the descriptor requires. */
  function bodyFor(descriptor: ServiceDescriptor): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const field of descriptor.input) {
      if (field.required !== true) continue
      out[field.name] =
        field.type === 'string'
          ? 'one'
          : field.type === 'number'
            ? (field.min ?? 0)
            : field.type === 'boolean'
              ? true
              : ['one']
    }
    return out
  }

  /**
   * A `req` ANSWERS ONE VALUE; A `stream` ANSWERS PAGES.
   *
   * The router refuses the mismatch — `is declared req but answered many
   * values` — so a handler that switched would fail at the call rather than
   * silently. Nothing exercised that for the whole table, which is what makes
   * this an assertion about every row rather than about the ones somebody
   * happened to write a case for.
   */

/**
 * Why a table-wide audit is allowed to skip a service.
 *
 * ⚠️ **BOTH AUDITS BELOW USED BARE `catch { continue }`.** A handler that
 * started throwing — an `internal`, a TypeError, anything — silently dropped out
 * of the sweep, and the only backstop was a loose count (`> half`). A service
 * failing outright is the LOUDEST thing these audits could have caught and it
 * was the one thing they were built to swallow.
 *
 * A skip is legitimate when the fixture cannot satisfy the request: a book id
 * this shelf does not have, a port nothing bound, a grant deliberately withheld.
 * Every one of those is a typed refusal with a nameable code. Anything else is
 * a defect and is rethrown.
 */
const SKIPPABLE: readonly string[] = [
  ENVELOPE_ERRORS.unknownService,
  ENVELOPE_ERRORS.unsupported,
  ENVELOPE_ERRORS.forbidden,
  SERVICE_ERRORS.notFound,
  SERVICE_ERRORS.unsupported,
  SERVICE_ERRORS.conflict,
  SERVICE_ERRORS.malformed,
  SERVICE_ERRORS.forbidden,
]

function skippable(name: string, thrown: unknown): void {
  const code = thrown instanceof ServiceCallError ? thrown.error.code : null
  if (code !== null && SKIPPABLE.includes(code)) return
  throw new Error(
    `${name} failed with something this fixture cannot excuse (${code ?? String(thrown)}). ` +
      'A refusal the fixture provoked is skippable; a handler that broke is the finding.',
  )
}

  it('answers with the kind each row declares, for every service in the table', async () => {
    const world = shelf()
    world.setGrants(['book:*', 'mark:*', 'card:*', 'device:*', 'shelf:*'])
    let checked = 0
    for (const name of SERVICE_NAMES) {
      const descriptor = serviceDescriptor(name) as ServiceDescriptor
      /* The DESTRUCTIVE verbs are skipped: this is about the answer's shape,
       * and running `trash.empty` here would destroy the fixture the rest of
       * the loop reads. Their shapes are asserted in their own suites. */
      if (descriptor.irreversible === true) continue
      const body = bodyFor(descriptor)
      if (descriptor.kind === 'req') {
        let answer: unknown
        try {
          answer = await world.client.call(name, body)
        } catch (thrown) {
          skippable(name, thrown)
          continue
        }
        expect(typeof answer === 'object' && answer !== null && Symbol.asyncIterator in answer, name).toBe(false)
      } else {
        const pages: unknown[] = []
        try {
          for await (const page of world.client.stream(name, body)) pages.push(page)
        } catch (thrown) {
          skippable(name, thrown)
          continue
        }
        /* Every page of a stream is an ARRAY of rows. A stream that yielded
         * one row per page rather than a page would still iterate. */
        for (const page of pages) expect(Array.isArray(page), name).toBe(true)
      }
      checked += 1
    }
    /* THE LOOP RAN. Every `continue` above is a service this fixture could not
     * drive, and a fixture that drove none of them would pass silently. */
    expect(checked).toBeGreaterThan(SERVICE_NAMES.length / 2)
  })

  /**
   * EVERY DECLARED COLUMN IS A FIELD THE ROW REALLY CARRIES.
   *
   * The type says it is a key of the shape `of` names; this says the handler
   * actually puts it there. A column that type-checks and is never populated
   * renders as an empty cell in the human table, on a field the generated
   * reference promises.
   */
  it('populates every column its row declares', async () => {
    const world = shelf()
    world.setGrants(['book:*', 'mark:*', 'card:*', 'device:*', 'shelf:*'])
    let checked = 0
    for (const name of SERVICE_NAMES) {
      const descriptor = serviceDescriptor(name) as ServiceDescriptor
      const columns = descriptor.output.columns
      if (!columns || descriptor.irreversible === true) continue
      const body = bodyFor(descriptor)
      let rows: unknown[] = []
      try {
        if (descriptor.kind === 'req') {
          const answer = await world.client.call(name, body)
          rows = Array.isArray(answer) ? answer : [answer]
        } else {
          for await (const page of world.client.stream(name, body)) rows.push(...(page as unknown[]))
        }
      } catch (thrown) {
        skippable(name, thrown)
        continue
      }
      const row = rows[0]
      if (row === undefined || typeof row !== 'object' || row === null) continue
      for (const column of columns) {
        expect(Object.keys(row), `${name} declares a column ${column} its row does not carry`).toContain(column)
      }
      checked += 1
    }
    expect(checked).toBeGreaterThan(3)
  })
})
