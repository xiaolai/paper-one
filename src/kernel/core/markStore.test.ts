import { describe, expect, it } from 'vitest'
import { marksPathIn, recordPath } from './bookFolder'
import { fakeFs } from './indexFsFake.testkit'
import { createMarkStore } from './markStore'
import { bookmarkFrom, createMark, type Mark, type NewMark } from './marks'
import { writeQueue } from './writeQueue'

/**
 * The split at the store's door.
 *
 * `marks.ts` proves the read models tell the two apart; this proves the STORE
 * applies them at the one place every subscriber reads through. That is the
 * whole of the bookmark design: annotations and bookmarks are one record in one
 * file under one merge, and no consumer downstream is ever handed the two
 * mixed. A filter that lived in each consumer instead would be four filters
 * that each have to remember.
 */

const BOOK = 'book:abc'

/** A book folder the store will write into — `applyElsewhere` refuses a
 *  targetId with no folder, which is how a change to a removed book is
 *  refused rather than recreating it. */
function libraryWith(bookId: string) {
  return fakeFs({ [recordPath(bookId)]: JSON.stringify({ bookId, title: 'A', author: 'B' }) })
}

function store(fs = libraryWith(BOOK)) {
  return { fs, store: createMarkStore({ fs, queue: writeQueue() }) }
}

const highlight = (over: Partial<NewMark> = {}): Mark =>
  createMark({
    bookId: BOOK,
    cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)',
    sectionIndex: 0,
    text: 'Ishmael',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Ch. 1',
    ...over,
  })

/** The draft a bookmark is built from, for a given book. */
const draftFor = (bookId: string) => ({
  bookId,
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:400)',
  sectionIndex: 0,
  text: 'Call me Ishmael',
  prefix: '',
  suffix: '',
  chapter: 'Ch. 1',
})

const place = (over: Partial<Parameters<typeof bookmarkFrom>[0]> = {}): Mark =>
  createMark(
    bookmarkFrom({
      bookId: BOOK,
      cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:400)',
      sectionIndex: 0,
      text: 'Call me Ishmael',
      prefix: '',
      suffix: '',
      chapter: 'Ch. 1',
      ...over,
    }),
  )

describe('the mark store splits bookmarks from annotations', () => {
  it('publishes each on its own side, from one file', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    await marks.add(highlight())
    await marks.add(place())

    const snapshot = marks.getSnapshot()
    expect(snapshot.current.map((m) => m.kind)).toEqual(['highlight'])
    expect(snapshot.bookmarks.map((m) => m.kind)).toEqual(['bookmark'])
  })

  /* ONE FILE, which is what buys the sync for nothing: bookmarks travel on the
   * marks group, under the same digest and the same merge, with no change to
   * the wire protocol at all. */
  it('writes both into the book’s one marks file', async () => {
    const { fs, store: marks } = store()
    await marks.open(BOOK)
    await marks.add(highlight())
    await marks.add(place())

    const written = JSON.parse(new TextDecoder().decode(fs.store.get(marksPathIn(BOOK))!)) as Mark[]
    expect(written.map((m) => m.kind).sort()).toEqual(['bookmark', 'highlight'])
  })

  /* Most books have no bookmarks, so the empty case is the common one — and
   * `bookmarksIn` filters AND sorts, so it cannot hand back its input by
   * identity the way the other read models do. Without the guard in `publish`
   * every change published a fresh empty array and re-rendered the pane for
   * nothing. */
  it('publishes one shared empty list for a book with no bookmarks', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    const before = marks.getSnapshot().bookmarks
    await marks.add(highlight())
    expect(marks.getSnapshot().bookmarks).toBe(before)
  })

  it('takes a bookmark off without touching the annotations beside it', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    const kept = highlight()
    const pin = place()
    await marks.add(kept)
    await marks.add(pin)

    await marks.remove(pin.id)

    expect(marks.getSnapshot().bookmarks).toEqual([])
    expect(marks.getSnapshot().current.map((m) => m.id)).toEqual([kept.id])
  })

  /* THE FAILURE THE CLASS GUARD PREVENTS, through the real write path: `add`
   * runs `upsertOverlapping`, and a bookmark of the page overlaps every
   * highlight on it. */
  it('does not delete a highlight when the page it is on is bookmarked', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    const kept = highlight()
    await marks.add(kept)
    await marks.add(place())

    expect(marks.getSnapshot().current.map((m) => m.id)).toEqual([kept.id])
  })

  /* "No bookmarks" and "not read yet" were the same empty list, and the two
   * surfaces that consume them both got it wrong: the panel announced an empty
   * book over one with bookmarks in it, and the toggle read an existing
   * bookmark as absent and re-placed it instead of removing it. */
  it('says whether the book has been read, so empty is not confused with pending', async () => {
    const { fs } = store()
    const fresh = createMarkStore({ fs, queue: writeQueue() })
    expect(fresh.getSnapshot().ready).toBe(false)

    await fresh.open(BOOK)
    expect(fresh.getSnapshot().ready).toBe(true)

    await fresh.open(null)
    expect(fresh.getSnapshot().ready).toBe(false)
  })

  /* The projections are derived once per SOURCE list, not once per publish —
   * `publish` runs for every change the store makes, and two of the three
   * projections filter while one also sorts. Handing subscribers new array
   * identities for an unchanged list defeats the memo they hang their
   * re-render decisions on. */
  it('does not hand out new lists when the open book’s marks did not change', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    await marks.add(highlight())
    await marks.add(place())
    const before = marks.getSnapshot()

    /* A publish driven by something ELSE. `loadAll` rewrites the cross-book
       list and publishes; the open book's own marks are untouched, so both of
       its projections must come back by identity.

       NOT a re-`open`, which is the stronger property this deliberately does
       not claim: re-opening re-reads the file and installs a fresh array, so
       its identity changes even for byte-identical content. Detecting that
       would cost a deep comparison on every publish to save a render that
       happens once per book change. */
    await marks.loadAll()
    const after = marks.getSnapshot()

    expect(after.current).toBe(before.current)
    expect(after.bookmarks).toBe(before.bookmarks)
  })

  /* Paired with the book asked for, exactly as the annotations are: a snapshot
   * belonging to another book must not light the ribbon over this one's
   * opening page. */
  it('empties both sides when the book is closed', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    /* BOTH CLASSES, because "both sides" was asserted with only a bookmark in
     * the store — an annotation left behind after a close would have passed. */
    await marks.add(highlight())
    await marks.add(place())
    await marks.open(null)

    expect(marks.getSnapshot().bookmarks).toEqual([])
    expect(marks.getSnapshot().current).toEqual([])
    expect(marks.getSnapshot().bookId).toBeNull()
  })

  it('reads bookmarks back off disk when the book is reopened', async () => {
    const { fs, store: marks } = store()
    await marks.open(BOOK)
    await marks.add(place())

    const reopened = createMarkStore({ fs, queue: writeQueue() })
    await reopened.open(BOOK)
    expect(reopened.getSnapshot().bookmarks.map((m) => m.kind)).toEqual(['bookmark'])
  })

  /* Marginalia browses BOTH classes across every book, so the cross-book read
   * has to answer for both — and it costs nothing extra, because `loadAll`
   * already scans every book's marks file and the two classes share it. */
  /* TWO BOOKS, because one proves nothing here: a `loadAll` that scanned only
   * the OPEN book would have passed the single-book version of this test, which
   * is the whole behaviour the cross-book projection exists to provide. */
  it('lists every book’s bookmarks beside every book’s annotations', async () => {
    const OTHER = 'book:def'
    const fs = libraryWith(BOOK)
    fs.store.set(
      recordPath(OTHER),
      new TextEncoder().encode(JSON.stringify({ bookId: OTHER, title: 'B', author: 'C' })),
    )
    const marks = createMarkStore({ fs, queue: writeQueue() })

    await marks.open(BOOK)
    await marks.add(highlight())
    await marks.add(place())
    await marks.open(OTHER)
    await marks.add(highlight({ bookId: OTHER }))
    await marks.add(createMark(bookmarkFrom({ ...draftFor(OTHER) })))
    await marks.loadAll()

    const snapshot = marks.getSnapshot()
    expect(snapshot.allBookmarks.map((m) => m.bookId).sort()).toEqual([BOOK, OTHER])
    expect(snapshot.all.map((m) => m.bookId).sort()).toEqual([BOOK, OTHER])
    /* And every row is on the right side of the split. By listing the kinds
       rather than testing `!== 'bookmark'`, which TypeScript now rejects as an
       impossible comparison — `all` is `Annotation[]`, so the guarantee has
       moved into the type. What can still regress is the filter dropping the
       wrong rows, which is what these two assert. */
    expect(snapshot.allBookmarks.map((m) => m.kind)).toEqual(['bookmark', 'bookmark'])
    expect(snapshot.all.map((m) => m.kind)).toEqual(['highlight', 'highlight'])
  })

  it('shares one empty list for a library with no bookmarks at all', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    await marks.add(highlight())
    const before = marks.getSnapshot().allBookmarks
    await marks.loadAll()
    expect(marks.getSnapshot().allBookmarks).toBe(before)
  })

  /* THE OVERLAPPING PAIR, which is this case's own invariant and not a second
   * airing of the one above. A bookmark anchors to the whole visible page, so
   * it covers every highlight on that page; `upsertOverlapping` would evict one
   * for the other were `sameClass` not guarding it. Both survive, and they
   * survive on OPPOSITE SIDES — which is the split at the door doing its work
   * on the hardest input there is, rather than on two marks that never met.
   *
   * Asserted by kind rather than by `kind !== 'bookmark'`: `all` is typed
   * `readonly Annotation[]`, so that comparison is one TypeScript rejects as
   * impossible — the guarantee moved from a runtime filter into the type. What
   * can still regress is the filter dropping the wrong rows. */
  it('keeps an overlapping bookmark and highlight both alive, one on each side', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    await marks.add(highlight())
    await marks.add(place())
    await marks.loadAll()

    const snapshot = marks.getSnapshot()
    expect(snapshot.all.map((m) => m.kind)).toEqual(['highlight'])
    expect(snapshot.allBookmarks.map((m) => m.kind)).toEqual(['bookmark'])
  })

  /**
   * A ROW FROM ANOTHER BOOK IS DELETED FROM THAT BOOK — even with the
   * cross-book list gone.
   *
   * Told which book, the store writes the tombstone there. Told only the id it
   * has to work the book out, and `ownerOf` does: the open book's list, then
   * the cross-book one. That second list is emptied whenever a rescan fails —
   * see `loadAll`'s catch — and Marginalia goes on SHOWING the rows it drew
   * before that happened. So the id-only call is the one that can arrive with
   * nothing left to resolve it: it rejects, the rejection is logged and
   * swallowed by the caller, and the row stays with nothing said. Both halves
   * are asserted, because the second is the reason the callers pass the mark.
   */
  it('removes another book’s mark from that book, with or without a cross-book list', async () => {
    const OTHER = 'book:def'
    const fs = libraryWith(BOOK)
    fs.store.set(
      recordPath(OTHER),
      new TextEncoder().encode(JSON.stringify({ bookId: OTHER, title: 'B', author: 'C' })),
    )
    const marks = createMarkStore({ fs, queue: writeQueue() })

    await marks.open(OTHER)
    const elsewhere = highlight({ bookId: OTHER })
    await marks.add(elsewhere)
    await marks.open(BOOK)
    await marks.add(highlight())
    await marks.loadAll()
    expect(marks.getSnapshot().all).toHaveLength(2)

    await marks.remove(elsewhere.id, OTHER)
    await marks.loadAll()

    expect(marks.getSnapshot().all.map((m) => m.bookId)).toEqual([BOOK])
    // And the open book kept its own, which a removal aimed at the wrong file
    // would not have proved either way.
    expect(marks.getSnapshot().current).toHaveLength(1)

    /* NOW WITH NOTHING TO LOOK IT UP IN. A second mark in the other book, and
       a failed scan between drawing the row and pressing its button — which is
       every scan after the library folder becomes unreadable. */
    const second = highlight({ bookId: OTHER, cfi: 'epubcfi(/6/4!/4/2,/1:60,/1:68)' })
    await marks.open(OTHER)
    await marks.add(second)
    await marks.open(BOOK)
    fs.store.clear()
    await marks.loadAll()
    expect(marks.getSnapshot().all).toEqual([])

    await expect(marks.remove(second.id, OTHER)).resolves.toBeUndefined()
    // Told only the id, there is nothing left to resolve it against.
    await expect(marks.remove(second.id)).rejects.toThrow(/no mark/)
  })

  /**
   * THE SCAN READS OUTSIDE THE WRITE QUEUE, so a write can land inside it.
   *
   * `loadAll` walks every book's folder, and there is no single key to take a
   * lock on for that — so the overlap is detected rather than prevented, and
   * this is the case that proves the detection. The scan reads the file as it
   * stood, a mark is made while it is still in flight, and the scan then
   * resolves holding rows that predate the mark. Publishing those rows loses
   * the mark from the cross-book list until something else forces a rescan.
   *
   * The gate goes AFTER the read, not before: gating the read would have made
   * the scan see the new mark and pass without the fix.
   */
  it('does not let a scan publish over a mark made while it was in flight', async () => {
    const real = libraryWith(BOOK)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    /* Armed only around the scan, and consumed by its first read — the write's
       own read of the same file must not wait on a gate only it could open. */
    let gate: Promise<void> | null = null
    const fs = {
      ...real,
      readFile: async (path: string) => {
        const bytes = await real.readFile(path)
        if (gate && path.endsWith('marks.json')) {
          const wait = gate
          gate = null
          await wait
        }
        return bytes
      },
    }
    const marks = createMarkStore({ fs, queue: writeQueue() })

    await marks.open(BOOK)
    await marks.add(highlight({ text: 'first' }))

    gate = held
    const scan = marks.loadAll()
    await marks.add(highlight({ text: 'second', cfi: 'epubcfi(/6/4!/4/2,/1:40,/1:48)' }))
    release()
    await scan

    expect(
      marks
        .getSnapshot()
        .all.map((m) => m.text)
        .sort(),
    ).toEqual(['first', 'second'])
  })
})

/**
 * THE ASSERTION THAT STOPS AN EMPTY BACKUP COMING BACK.
 *
 * The cross-book lists are empty until `loadAll` has scanned every book's
 * file, and for a long time the only caller of `loadAll` was the Marginalia
 * panel mounting. An export driven from the command palette, in a session
 * where that panel was never opened, would therefore have walked an empty list
 * and written a valid archive containing nothing — and reported success. The
 * reader does not find out until the day they need it.
 *
 * `useMarks.loadAllNow` is the fix: it scans and hands the rows straight back,
 * with no render in the path. This is the assertion beside it, because a fix
 * removes today's failure and only an assertion stops it returning while still
 * looking green.
 */
describe('every mark, without a panel having been opened', () => {
  it('is empty before a scan and complete after one', async () => {
    const { fs, store: marks } = store()
    await marks.open(BOOK)
    const kept = highlight()
    await marks.add(kept)

    /* A FRESH STORE over the same disk is the palette-without-the-panel case:
       the rows are on disk, nothing has scanned them, and `all` is empty. */
    const fresh = createMarkStore({ fs, queue: writeQueue() })
    expect(fresh.getSnapshot().all).toEqual([])

    await fresh.loadAll()
    const scanned = fresh.getSnapshot()
    expect([...scanned.all, ...scanned.allBookmarks].map((mark) => mark.id)).toEqual([kept.id])
  })
})

/**
 * ONE WRITE FOR A BATCH, and the same policy as adding them one by one.
 *
 * `add` is a whole-file read, mutate and rewrite, queued — correct for a
 * reader marking a passage, and quadratic for an import, which rewrote a
 * growing file once per mark. `addMany` exists for that second case, and the
 * risk in having two doors is that they diverge: these pin that the batch
 * applies the SAME overlap rule, not a faster one that skips it.
 */
describe('addMany', () => {
  const at = (cfi: string) => highlight({ cfi })

  it('lands every mark in the batch', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    await marks.addMany(BOOK, [
      at('epubcfi(/6/4!/4/2,/1:0,/1:5)'),
      at('epubcfi(/6/4!/4/4,/1:0,/1:5)'),
      at('epubcfi(/6/4!/4/6,/1:0,/1:5)'),
    ])
    const live = (await marks.forBook(BOOK)).filter((mark) => mark.deletedAt === undefined)
    expect(live).toHaveLength(3)
  })

  it('writes the book once rather than once per mark', async () => {
    const { fs, store: marks } = store()
    await marks.open(BOOK)
    const before = fs.writes(marksPathIn(BOOK))
    await marks.addMany(BOOK, [at('epubcfi(/6/4!/4/2,/1:0,/1:5)'), at('epubcfi(/6/4!/4/4,/1:0,/1:5)')])
    expect(fs.writes(marksPathIn(BOOK)) - before, 'a batch wrote once per mark').toBe(1)
  })

  /* THE SAME OVERLAP RULE. A batch containing two marks over one passage must
     resolve exactly as adding them in sequence does — the second replaces the
     first, and the first is tombstoned so the replacement travels. */
  it('applies the overlap rule within the batch', async () => {
    const { fs, store: marks } = store()
    await marks.open(BOOK)
    const first = at('epubcfi(/6/4!/4/2,/1:0,/1:20)')
    const second = at('epubcfi(/6/4!/4/2,/1:5,/1:12)')
    await marks.addMany(BOOK, [first, second])

    const live = await marks.forBook(BOOK)
    expect(live, 'an overlapping pair both survived a batch').toHaveLength(1)
    expect(live[0]?.id).toBe(second.id)

    /* THE TOMBSTONE IS IN THE FILE, not in `forBook` — which filters them, so
       asserting there would have looked right and checked nothing. The
       superseded row has to travel, which is the whole reason `add` tombstones
       rather than dropping. */
    const written = JSON.parse(new TextDecoder().decode(fs.store.get(marksPathIn(BOOK))!)) as Mark[]
    expect(
      written.find((mark) => mark.id === first.id)?.deletedAt,
      'the replaced mark was dropped instead of tombstoned',
    ).toBeDefined()
  })

  it('writes nothing for an empty batch', async () => {
    const { fs, store: marks } = store()
    await marks.open(BOOK)
    const before = fs.writes(marksPathIn(BOOK))
    await marks.addMany(BOOK, [])
    expect(fs.writes(marksPathIn(BOOK))).toBe(before)
  })
})

/**
 * A marks file that is THERE and will not read (WI-20.36).
 *
 * `readMarks` throws for one — the most destructive line in that file used to
 * collapse it into `[]` — and `open` caught the throw and installed the empty
 * list with `ready: true` and no flag. So the reader saw a book with no marks,
 * the ribbon offered to place a bookmark, and the only thing standing between
 * the next write and the damaged file was that the write's own read throws
 * too. The store now says so, and stops calling the book ready.
 */
describe('a marks file that will not read', () => {
  const damaged = '{"not": "a list"}'

  it('is reported as unreadable rather than installed as empty, and nothing is written over it', async () => {
    const { fs, store: s } = store()
    fs.store.set(marksPathIn(BOOK), new TextEncoder().encode(damaged))
    await s.open(BOOK)

    const before = s.getSnapshot()
    expect(before.unreadable).toBe(true)
    expect(before.ready).toBe(false)
    expect(before.current).toEqual([])

    await expect(s.add(highlight())).rejects.toThrow()
    expect(new TextDecoder().decode(fs.store.get(marksPathIn(BOOK)))).toBe(damaged)
    expect(s.getSnapshot().persistent).toBe(false)
  })

  it('is a fact about the open book, gone once another book reads', async () => {
    const other = 'book:other'
    const fs = fakeFs({
      [recordPath(BOOK)]: JSON.stringify({ bookId: BOOK, title: 'A', author: 'B' }),
      [recordPath(other)]: JSON.stringify({ bookId: other, title: 'C', author: 'D' }),
      [marksPathIn(BOOK)]: damaged,
    })
    const s = createMarkStore({ fs, queue: writeQueue() })
    await s.open(BOOK)
    expect(s.getSnapshot().unreadable).toBe(true)
    await s.open(other)
    expect(s.getSnapshot().unreadable).toBe(false)
    expect(s.getSnapshot().ready).toBe(true)
  })

  it('is not what a book with no marks file yet is', async () => {
    const { store: s } = store()
    await s.open(BOOK)
    expect(s.getSnapshot().unreadable).toBe(false)
    expect(s.getSnapshot().ready).toBe(true)
  })
})
