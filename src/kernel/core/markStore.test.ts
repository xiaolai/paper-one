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
    await marks.add(place())
    await marks.open(null)

    expect(marks.getSnapshot().bookmarks).toEqual([])
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
  it('lists every book’s bookmarks beside every book’s annotations', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    await marks.add(highlight())
    await marks.add(place())
    await marks.loadAll()

    expect(marks.getSnapshot().allBookmarks.map((m) => m.kind)).toEqual(['bookmark'])
    expect(marks.getSnapshot().all.map((m) => m.kind)).toEqual(['highlight'])
  })

  it('shares one empty list for a library with no bookmarks at all', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    await marks.add(highlight())
    const before = marks.getSnapshot().allBookmarks
    await marks.loadAll()
    expect(marks.getSnapshot().allBookmarks).toBe(before)
  })

  /* `all` stays annotations-only even though Marginalia shows both: the split
   * at the door is what keeps a bookmark out of the painter, the margin and a
   * selection. The panel takes the two lists and joins them itself. */
  it('keeps the two classes in separate lists, mixed only by whoever asks for both', async () => {
    const { store: marks } = store()
    await marks.open(BOOK)
    await marks.add(highlight())
    await marks.add(place())
    await marks.loadAll()

    /* Asserted by LENGTH and by id, not by `kind !== 'bookmark'`: `all` is
     * typed `readonly Annotation[]` now, so that comparison is one TypeScript
     * rejects as impossible — the guarantee moved from a runtime filter into
     * the type system. What can still regress is the filter dropping the wrong
     * rows, which is what this checks. */
    expect(marks.getSnapshot().all.map((m) => m.kind)).toEqual(['highlight'])
  })
})
