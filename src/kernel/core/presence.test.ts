import { describe, expect, it } from 'vitest'
import { folderOf, recordPath, trashOf, type BookRecord } from './bookFolder'
import { fakeFs, jsonAt, textAt } from './fakeFs.testkit'
import { hlcOf, makeHlc } from './hlc'
import {
  PRESENCE_PATH,
  finishPendingRemovals,
  notePresence,
  readPresence,
  recordStamp,
  writePresence,
} from './presence'

const DEV = 'a1b2c3d4e5f60718'
const t = (ms: number) => makeHlc(ms, 0, DEV)

describe('the register on disk', () => {
  it('round-trips, and an absent file is the empty register', async () => {
    const fs = fakeFs()
    expect(await readPresence(fs)).toEqual({})
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(5) } })
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'removed', at: t(5) } })
  })

  /* ⚠️ **UNREADABLE IS NOT THE EMPTY REGISTER, AND THIS FILE USED TO SAY IT
     WAS** — found by the 2026-09-13 audit, the same class as `readMarks` and
     `parseCards`. `notePresence` is a read-modify-write of the WHOLE file, so
     bytes that would not parse read as no removals and the next removal wrote
     `{ this one book }` over every other book's entry. That register is what
     outlives the trash: with it gone, a satchel that was in a drawer re-uploads
     the books the reader deleted — the deletion that resurrects this module's
     own header warns about. Each clause in its own words, because the two share
     a prefix. */
  it.each([
    ['not JSON', 'not json', /is not JSON/u],
    ['a list', '[1,2]', /is not a record of books/u],
    ['JSON null', 'null', /is not a record of books/u],
    ['a bare value', '42', /is not a record of books/u],
  ])('refuses a register that is %s, and leaves its bytes where they are', async (_what, raw, clause) => {
    const fs = fakeFs({ [PRESENCE_PATH]: raw })

    const cause = await readPresence(fs).then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(clause)

    const wrote = await notePresence(fs, 'book:a', 'removed', t(9)).then(
      () => null,
      (error: unknown) => error,
    )
    expect(wrote).toBeInstanceOf(Error)
    expect(textAt(fs, PRESENCE_PATH), 'the file it could not read must be intact').toBe(raw)
  })

  /* A READ THAT FAILED OVER A FILE THAT IS THERE is the same answer: this
     device's own register, momentarily unreadable, is not a register with
     nothing in it. Absence is the only empty one — `isMissingFile` is the
     distinction, as it is in `readBook`. */
  it('refuses a register it could not read at all, rather than starting again', async () => {
    const fs = fakeFs({ [PRESENCE_PATH]: JSON.stringify({ 'book:a': { state: 'removed', at: t(5) } }) })
    const held = textAt(fs, PRESENCE_PATH)
    fs.readFile = () => Promise.reject(new Error('EIO: the disk is busy'))

    const cause = await readPresence(fs).then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/EIO: the disk is busy/u)
    expect(textAt(fs, PRESENCE_PATH)).toBe(held)
  })

  it('keeps what the JSON parser said, as the cause of refusing a register that is not JSON', async () => {
    const cause = await readPresence(fakeFs({ [PRESENCE_PATH]: '{oops' })).then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).cause).toBeInstanceOf(SyntaxError)
  })

  /* THE PATH IS THE STORED FORMAT'S NAME. Every other case here reaches it
     through the constant, so none could notice it move — and a moved register
     is every removal this device ever recorded, forgotten on the first launch. */
  it('reads the register earlier builds wrote, at the path they wrote it', async () => {
    const fs = fakeFs({ 'sync/removed.json': JSON.stringify({ 'book:a': { state: 'removed', at: t(5) } }) })
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'removed', at: t(5) } })
  })

  /* NULL IS THE ONE MALFORMED ENTRY THAT CAN THROW. Every other shape that is
     not an entry reads as having no `state` and is dropped by the check below
     it; reading a property of `null` is a TypeError, which would refuse the
     whole register over one row. */
  it('drops an entry that is null alone, rather than refusing the register over it', async () => {
    const fs = fakeFs({
      [PRESENCE_PATH]: JSON.stringify({ 'book:null': null, 'book:good': { state: 'removed', at: t(5) } }),
    })
    expect(await readPresence(fs)).toEqual({ 'book:good': { state: 'removed', at: t(5) } })
  })

  it('drops a malformed entry alone and keeps the register beside it', async () => {
    const fs = fakeFs({
      [PRESENCE_PATH]: JSON.stringify({
        'book:good': { state: 'removed', at: t(5) },
        'book:badState': { state: 'gone', at: t(5) },
        'book:badStamp': { state: 'live', at: 'yesterday' },
        'book:notAnObject': 7,
        '': { state: 'live', at: t(5) },
      }),
    })
    expect(await readPresence(fs)).toEqual({ 'book:good': { state: 'removed', at: t(5) } })
  })

  it('is safe under prototype-named book ids', async () => {
    const fs = fakeFs({
      [PRESENCE_PATH]: JSON.stringify({ constructor: { state: 'removed', at: t(5) } }),
    })
    const presence = await readPresence(fs)
    expect(presence['constructor']).toEqual({ state: 'removed', at: t(5) })
    expect(Object.keys(presence)).toEqual(['constructor'])
  })
})

describe('notePresence — last writer wins', () => {
  it('writes a first entry, and a newer one over it', async () => {
    const fs = fakeFs()
    expect(await notePresence(fs, 'book:a', 'removed', t(5))).toBe(true)
    expect(await notePresence(fs, 'book:a', 'live', t(6))).toBe(true)
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'live', at: t(6) } })
  })

  it('refuses a stale write — a slow replica cannot roll a decision back', async () => {
    const fs = fakeFs()
    await notePresence(fs, 'book:a', 'live', t(9))
    expect(await notePresence(fs, 'book:a', 'removed', t(5))).toBe(false)
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'live', at: t(9) } })
  })

  it('holds the held value on an exact tie, and does not rewrite a repeat', async () => {
    const fs = fakeFs()
    await notePresence(fs, 'book:a', 'removed', t(5))
    expect(await notePresence(fs, 'book:a', 'live', t(5))).toBe(false)
    expect(await notePresence(fs, 'book:a', 'removed', t(5))).toBe(false)
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'removed', at: t(5) } })
  })

  it('writes a newer stamp for the state it already holds', async () => {
    /* A later word is the last word even when it says the same thing — a
       removal re-recorded after a re-add that lost its race must carry the
       later stamp, or the older one decides against whatever comes between. */
    const fs = fakeFs()
    await notePresence(fs, 'book:a', 'removed', t(5))
    expect(await notePresence(fs, 'book:a', 'removed', t(6))).toBe(true)
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'removed', at: t(6) } })
  })
})

describe('recordStamp', () => {
  it('is the newest of everything a record knows, legacy times included', () => {
    expect(recordStamp({ title: '', author: '' })).toBe(hlcOf(0))
    expect(recordStamp({ title: '', author: '', addedAt: 50, openedAt: 80 })).toBe(hlcOf(80))
    expect(
      recordStamp({ title: '', author: '', addedAt: 50, positionAt: t(90) }),
    ).toBe(t(90))
    expect(
      recordStamp({
        title: '',
        author: '',
        finishedAt: t(70),
        tagClock: { sea: { at: t(95), on: true, spelling: 'Sea' } },
      }),
    ).toBe(t(95))
  })

  /**
   * ⚠️ **THREE STAMPS WERE MISSING FROM THE HAND-WRITTEN LIST.** `status.at`,
   * `ratingAt` and `review.at` are all on a `BookRecord` and none of them was
   * read. This decides whether a live folder PREDATES the removal that names
   * it, so a record touched after the removal was written — a rating arriving
   * from a peer, a status set, a review typed — read as older than it was, and
   * `finishPendingRemovals` trashed a book the reader had just touched. Found
   * by audit.
   */
  it.each([
    ['a status', { status: { state: 'reading' as const, at: t(95) } }],
    ['a rating', { rating: 4 as const, ratingAt: t(95) }],
    ['a review', { review: { text: 'good', at: t(95) } }],
  ])('counts %s, which the hand-written list left out', (_what, over) => {
    /* Against an older stamp the list DID read, so what is measured is the new
       field winning rather than the record being empty. */
    expect(recordStamp({ title: '', author: '', positionAt: t(10), ...over })).toBe(t(95))
  })

  it('finds stamps by shape, and a record’s other strings do not have it', () => {
    /* ⚠️ **THE COST OF FINDING RATHER THAN LISTING, STATED.** The walk reads
       any value an `Hlc` shape matches, so a title that IS one would count —
       asserted below rather than left to be discovered. The direction is the
       safe one: a record that looks NEWER than it is leaves its folder
       standing, where the defect this replaces trashed a book. And no ordinary
       field has that shape: a title, an author, an origin path and an extension
       are all refused, which is what makes the walk usable at all. */
    expect(recordStamp({ title: 'Moby-Dick', author: 'Melville', origin: '/tmp/x.epub', ext: 'epub', positionAt: t(10) })).toBe(t(10))
    expect(recordStamp({ title: t(99), author: '', positionAt: t(10) })).toBe(t(99))
  })

  /* FOUR LEVELS AND NO FURTHER, as the walk's own note says: the deepest real
     stamp is three from the record, and one more is the room. Past that the
     walk stops, so a stamp nested deeper is not counted. */
  it('counts a stamp four levels down and none deeper', () => {
    const nested = {
      title: '',
      author: '',
      positionAt: t(10),
      four: { levels: { down: { at: t(40) } } },
      five: { levels: { further: { down: { at: t(50) } } } },
    } as BookRecord
    expect(recordStamp(nested)).toBe(t(40))
  })

  it('walks past a field a record holds as null', () => {
    /* `position` and `seriesIndex` may be null in a record. A walk that asked
       for the values of one would throw — and launch recovery's catch would
       then leave a removed book's folder standing. */
    expect(recordStamp({ title: '', author: '', position: null, seriesIndex: null, positionAt: t(10) })).toBe(t(10))
  })
})

describe('finishPendingRemovals — launch recovery', () => {
  const record = (addedAt: number) => JSON.stringify({ bookId: 'book:a', title: 'T', author: '', addedAt })

  it('finishes a removal the crash left half done', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: record(50) })
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    expect(await finishPendingRemovals(fs)).toEqual(['book:a'])
    expect(await fs.exists(folderOf('book:a'))).toBe(false)
    expect(await fs.exists(`${trashOf('book:a')}/book.json`)).toBe(true)
    // Into the ORDINARY trash, stamp and fortnight included.
    expect(textAt(fs, `${trashOf('book:a')}/.removed`)).toBeTruthy()
  })

  it('leaves a record newer than the removal — a re-add racing a crash', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: record(200) })
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    expect(await finishPendingRemovals(fs)).toEqual([])
    expect(await fs.exists(folderOf('book:a'))).toBe(true)
  })

  it('does nothing for live entries or folders already gone', async () => {
    const fs = fakeFs({ [recordPath('book:b')]: record(50) })
    await writePresence(fs, {
      'book:a': { state: 'removed', at: t(100) }, // no folder
      'book:b': { state: 'live', at: t(100) },
    })
    expect(await finishPendingRemovals(fs)).toEqual([])
    expect(await fs.exists(folderOf('book:b'))).toBe(true)
  })

  it('moves a folder whose record will not read — nothing says it is newer', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: 'not json' })
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    expect(await finishPendingRemovals(fs)).toEqual(['book:a'])
    expect(await fs.exists(folderOf('book:a'))).toBe(false)
  })

  it('one folder that will not move does not stop the others', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: record(50), [recordPath('book:b')]: record(50) })
    await writePresence(fs, {
      'book:a': { state: 'removed', at: t(100) },
      'book:b': { state: 'removed', at: t(100) },
    })
    const exists = fs.exists
    fs.exists = async (path) => {
      if (path === folderOf('book:a')) throw new Error('flaky disk')
      return exists(path)
    }
    expect(await finishPendingRemovals(fs)).toEqual(['book:b'])
  })

  it('moves a folder whose record is exactly as old as the removal — only NEWER stands', async () => {
    /* The removal was written knowing a record at least this old, so a tie is
       not a re-add racing a crash; it is the removal the crash interrupted. */
    const fs = fakeFs({ [recordPath('book:a')]: record(100) })
    await writePresence(fs, { 'book:a': { state: 'removed', at: hlcOf(100) } })
    expect(await finishPendingRemovals(fs)).toEqual(['book:a'])
    expect(await fs.exists(folderOf('book:a'))).toBe(false)
  })

  /* THE REGISTER IS KEPT FOR EVER, and this runs on every launch — so a book
     whose folder is long gone costs one question about the folder, not a read of
     a record that is not there, for every book the reader has ever removed. */
  it('reads no record for a book whose folder is already gone', async () => {
    const fs = fakeFs()
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    const read: string[] = []
    const readFile = fs.readFile
    fs.readFile = async (path) => {
      read.push(path)
      return readFile(path)
    }
    expect(await finishPendingRemovals(fs)).toEqual([])
    expect(read).toEqual([PRESENCE_PATH])
  })

  it('presence entries survive the finish — the register outlives the trash', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: record(50) })
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    await finishPendingRemovals(fs)
    expect(jsonAt(fs, PRESENCE_PATH)).toEqual({ 'book:a': { state: 'removed', at: t(100) } })
  })
})
