import { describe, expect, it, vi } from 'vitest'
import { circle, circleChanged } from './index'
import { NO_LIST_HELD,
  peopleFor,
  purgeForeign,
  readForeign,
  writeForeign,
  type ForeignFile,
  type LaneFor,
} from './lib/store'
import {
  circlePathIn,
  hlcOf,
  type ForeignEntry,
  type IndexFs,
  type ResolveResult,
  type WriteQueue,
} from '../../kernel'
import { personListPathIn, personListsDirIn, personShelfPathIn } from '../../kernel'
import { NOTHING_SHARED, heldListIdsOf, readHeldList, readHeldShelf, writeHeldList, writeHeldShelf } from './lib/store'
/* ⚠️ THROUGH THE TESTKIT ENTRY, not the module. `kernel-testkit-in-tests-only`
   is what keeps this mint out of production, and `kernel-public-entry-only`
   refuses a capability reaching past the kernel's doors — so a test outside the
   kernel takes the testkit door like any other consumer. */
import { fakeFs, resolvedCfiForTesting } from '../../kernel/testkit'

/** A person still admitted, for every write here: the lane re-check is `store.ts`'s to prove. */
const ADMITS = () => Promise.resolve(true)

/**
 * A queue that runs its task and nothing else.
 *
 * ⚠️ **NOT the kernel's `writeQueue`, and the reason is a BOUNDARY.**
 * `kernel-public-entry-only` refuses anything outside the kernel reaching past
 * `src/kernel/index.ts`, and the real queue is not on it — only its TYPE is.
 * Exporting the function to make one test shorter would widen the supported
 * API for a test's convenience, which is exactly what that rule exists to
 * stop. Serialisation is not what these tests are about; the store's use of a
 * queue is.
 */
const queueOf = (keys: string[] = []): WriteQueue => ({
  append: (key, task) => {
    keys.push(key)
    return task()
  },
  push: (key, task) => {
    keys.push(key)
    return task()
  },
  /* Everything ran the moment it was appended, so there is never anything in
     flight to wait for. */
  idle: () => Promise.resolve(),
})

/**
 * The library's own lane resolver, as the capability hands it over.
 *
 * ⚠️ **A FAKE THAT FOLDS, because the real one does.** `folderOf` is
 * MANY-TO-ONE — `a/b` and `a_b` are two ids over one directory — and the whole
 * point of taking the lane from the library rather than deriving a second one
 * is that both land on the same key. A fake that just echoed the id would pass
 * whatever the store did with it.
 */
/** Entries with nothing withdrawn — what most of these tests mean by a file. */
const shared = (entries: readonly ForeignEntry[]): ForeignFile => ({
  entries,
  withdrawn: [],
  heads: {},
  cursor: {},
  v: 1,
  opinion: {},
  reviews: [],
  unreviewed: [],
  works: [],
  unshelved: [],
  list: NO_LIST_HELD,
})

/* The writers REQUIRE a change notification — see `writeForeign`. These tests
   are not about the signal, so they pass a no-op and the one that IS about it
   passes a spy. */
const NOTED = () => {}

/**
 * A library with nothing on it, for every start that is not ABOUT the shelf.
 * The opinion driver (WI-23.B4) subscribes to the library at start, so a
 * fixture with no library is a start that throws.
 */
const LIBRARY = {
  getSnapshot: () => [],
  lane: (id: string) => id,
  subscribe: () => () => {},
  patch: () => Promise.resolve(),
}

const LANE: LaneFor = (bookId) => `books/${bookId.replace(/[^a-zA-Z0-9]/gu, '_')}`

/**
 * A resolver that places everything it is handed, at one anchor.
 *
 * For the tests that are not ABOUT resolving. They used to avoid the resolver
 * by writing `resolved` into the file, which `readForeign` no longer reads
 * back — a cached anchor carries nothing that says which edition it was
 * computed against, so it is a claim with no evidence.
 */
const placesEverything = (cfi = 'epubcfi(/6/4!/4/2)', sectionIndex = 1) =>
  vi.fn((pending: readonly { id: string }[]) =>
    Promise.resolve({
      found: pending.map((one) => ({
        id: one.id,
        cfi: resolvedCfiForTesting(cfi),
        sectionIndex,
      })),
      missed: [],
      complete: true,
    }),
  )

/**
 * The `circle` capability — WI-22.D1, and the store WI-22.E3 purges.
 *
 * What is tested here is the half that exists: a file on disk becomes an
 * anchored annotation the painter can draw. Nothing fills that file yet; the
 * transport is Stage C and is gated on a release.
 */

const BOOK = 'book:moby'
/* A person id is a 64-hex public key (`PersonId` in `person.rs`). `safeId` is
   the identity function on hex, so the file name IS the id — which is what
   makes `isForeignEntry`'s exact comparison the right check rather than a
   stricter one that would reject real entries. The old fixture was
   `person-alice`, whose file is `person_alice.json`; that gap was the alias the
   check now refuses. */
const PERSON = 'a1'.repeat(32)

const entry = (over: Partial<ForeignEntry> = {}): ForeignEntry => ({
  pub: 'pub1',
  person: PERSON,
  passage: { quote: 'Call me Ishmael', prefix: 'before ', suffix: ' after', chapter: 'Ch. 1' },
  epoch: 1,
  receivedAt: 1000,
  ...over,
})

const fsWith = (files: Record<string, string> = {}): IndexFs =>
  fakeFs(files) as unknown as IndexFs

describe('the store', () => {
  it('reads nothing for a book nobody has shared from', async () => {
    expect(await readForeign(fsWith(), BOOK, PERSON)).toEqual(shared([]))
    expect(await peopleFor(fsWith(), BOOK)).toEqual([])
  })

  it('round-trips what it wrote', async () => {
    const fs = fsWith()
    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, shared([entry()]), NOTED, ADMITS)
    expect(await readForeign(fs, BOOK, PERSON)).toEqual(shared([entry()]))
    /* The file name IS the id, because `safeId` is the identity on hex —
       which is what lets `readForeign` compare the claimed author exactly. */
    expect(await peopleFor(fs, BOOK)).toEqual([PERSON])
  })

  it('THROWS on a file it cannot read, rather than answering empty', async () => {
    /* ⚠️ **`readMarks` calls this the most destructive line it ever had.** A
       book nobody shared from and a file that would not read look identical to
       a caller who collapses both to `[]` — so a momentary failure loads
       nothing and the next write puts that nothing on disk over everything the
       reader received. */
    const fs = fsWith({ [circlePathIn(BOOK, PERSON)]: '"not a file at all"' })
    await expect(readForeign(fs, BOOK, PERSON)).rejects.toThrow(/is not a circle file/u)

    /* ⚠️ **AND A FILE WHOSE WITHDRAWAL LIST WILL NOT READ THROWS TOO.** Reading
       it as "nothing withdrawn" un-withdraws every passage this person has
       taken back, and the next page that mentions one puts it back on screen —
       the failure the list exists to prevent, produced by the code that reads
       it. */
    const noList = fsWith({ [circlePathIn(BOOK, PERSON)]: '{"entries":[],"heads":{}}' })
    await expect(readForeign(noList, BOOK, PERSON)).rejects.toThrow(/withdrawal list/u)
    const badList = fsWith({ [circlePathIn(BOOK, PERSON)]: '{"entries":[],"withdrawn":[1],"heads":{}}' })
    await expect(readForeign(badList, BOOK, PERSON)).rejects.toThrow(/withdrawal list/u)
    const noEntries = fsWith({ [circlePathIn(BOOK, PERSON)]: '{"withdrawn":[],"heads":{}}' })
    await expect(readForeign(noEntries, BOOK, PERSON)).rejects.toThrow(/entry list/u)
  })

  it('never writes into marks.json', async () => {
    /* ⚠️ **THE BLOCKER THIS STORE EXISTS FOR.** A foreign passage in the marks
       file is carried by `exportMarks`, by the sync feed and by every one of
       the reader's own devices — as THEIR annotation. */
    const fs = fsWith()
    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, shared([entry()]), NOTED, ADMITS)
    expect(await fs.exists(`books/book_moby/marks.json`)).toBe(false)
    expect(circlePathIn(BOOK, PERSON)).toContain('/circle/')
  })

  it('keeps a hostile person id inside one path segment', async () => {
    /* A person id arrives from ANOTHER READER — the least trusted string here.
       `safeId`'s two promises are the ones needed: no slash, never empty. */
    expect(circlePathIn(BOOK, '../../etc/passwd')).not.toContain('..')
    expect(circlePathIn(BOOK, 'a/b')).toBe(circlePathIn(BOOK, 'a_b'))
    expect(() => circlePathIn(BOOK, '')).toThrow()
  })

  it('purges one person and leaves the others', async () => {
    /* WI-22.E3's `retain: 'purge'`. */
    const fs = fsWith()
    const queue = queueOf()
    await writeForeign(fs, queue, LANE, BOOK, 'alice', shared([entry({ person: 'alice' })]), NOTED, ADMITS)
    await writeForeign(fs, queue, LANE, BOOK, 'bob', shared([entry({ person: 'bob', pub: 'p2' })]), NOTED, ADMITS)

    await purgeForeign(fs, queue, LANE, BOOK, 'alice', NOTED)

    expect(await peopleFor(fs, BOOK)).toEqual(['bob'])
    expect(await readForeign(fs, BOOK, 'alice')).toEqual(shared([]))
  })

  it('creates the circle folder, which no book has until something does', async () => {
    /* ⚠️ **THE FIRST PRODUCTION WRITE WOULD HAVE FAILED.** `writeForeign` used a
       raw `fs.writeFile`, which creates no parent — and `circle/` does not
       exist until something makes it. Every test passed because the FAKE
       filesystem is permissive and made one implicitly, which is the exact
       shape of "green is not evidence that anything happened". */
    const fs = fsWith()
    expect(await fs.exists('books/book_moby/circle')).toBe(false)
    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, shared([entry()]), NOTED, ADMITS)
    expect(await fs.exists(circlePathIn(BOOK, PERSON))).toBe(true)
  })

  it('drops a malformed row and keeps the rest, rather than throwing later', async () => {
    /* ⚠️ Validation stopped at `Array.isArray`, so `[null]` parsed fine and the
       first `entry.passage.quote` downstream threw — AFTER the per-person error
       isolation had run, taking every other person's overlay down with it. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const good = entry()
      const fs = fsWith({
        [circlePathIn(BOOK, PERSON)]: JSON.stringify({ entries: [null, { pub: 'x' }, good, 42], withdrawn: [], heads: {}, cursor: {}, v: 1 }),
      })
      expect(await readForeign(fs, BOOK, PERSON)).toEqual(shared([good]))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("refuses a row claiming somebody else's authorship", async () => {
    /* ⚠️ The FILE is the authenticated statement of who sent something; the
       `person` field inside it is a claim. A record in Alice's file naming Bob
       would be checked against BOB's relationship epoch and shown under Bob's
       name. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fs = fsWith({
        [circlePathIn(BOOK, 'alice')]: JSON.stringify({ entries: [entry({ person: 'bob' })], withdrawn: [], heads: {}, cursor: {}, v: 1 }),
      })
      expect(await readForeign(fs, BOOK, 'alice')).toEqual(shared([]))
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['a section index that is not a number', { cfi: 'epubcfi(/6/4!/4/2)', sectionIndex: 'x' }],
    ['a section index below the first section', { cfi: 'epubcfi(/6/4!/4/2)', sectionIndex: -1 }],
    ['a fractional section index', { cfi: 'epubcfi(/6/4!/4/2)', sectionIndex: 1.5 }],
    ['an empty cfi', { cfi: '', sectionIndex: 0 }],
    ['a cfi that is not a string', { cfi: 42, sectionIndex: 0 }],
  ])('drops an anchor with %s, and keeps the passage', async (_what, resolved) => {
    /* ⚠️ `resolved` is a CACHE and it was never checked, while
       `isForeignEntry` asserted the whole `ForeignEntry` type around it — and
       `annotationsFor` SKIPS the resolver for any entry that already has one.
       A malformed anchor therefore went straight to the painter along the one
       path where nothing downstream looks at it again.

       Dropped, not refused: throwing the row away would lose a real passage
       somebody shared over a corrupted optimisation. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fs = fsWith({
        [circlePathIn(BOOK, 'alice')]: JSON.stringify({ entries: [{ ...entry({ person: 'alice' }), resolved }], withdrawn: [], heads: {}, cursor: {}, v: 1 }),
      })

      const [read] = (await readForeign(fs, BOOK, 'alice')).entries

      expect(read?.pub).toBe(entry().pub)
      expect(read?.resolved).toBeUndefined()
      expect(Object.keys(read as object)).not.toContain('resolved')
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves a well-formed cached anchor on disk too, because it cannot be checked', async () => {
    /* ⚠️ The shape is not the question. `epubcfi(/6/4!/4/2)` is well formed and
       addresses a DIFFERENT sentence in a different edition of the same book,
       and nothing stored beside it says which edition it was computed against
       — the reader's own cache is keyed on `contentHash`, this one on nothing.
       So a cached anchor is a claim with no evidence, and it is the one field
       `annotationsFor` never re-examines. */
    const fs = fsWith({
      [circlePathIn(BOOK, 'alice')]: JSON.stringify({
        entries: [
          { ...entry({ person: 'alice' }), resolved: { cfi: 'epubcfi(/6/4!/4/2)', sectionIndex: 0 } },
        ],
        withdrawn: [],
        heads: {},
        cursor: {},
        v: 1,
      }),
    })

    const [read] = (await readForeign(fs, BOOK, 'alice')).entries

    expect(read?.pub).toBe(entry().pub)
    expect(read?.resolved).toBeUndefined()
  })

  it('remembers a withdrawal for a share that has not arrived', async () => {
    /* ⚠️ **THE FILE WAS A BARE LIST, AND A LIST HAS NOWHERE TO PUT THIS.**
    `fold` states the guarantee in as many words — *"an `unshare` for a `pub`
    not yet seen is REMEMBERED, not dropped"* — because a withdrawal that is
    dropped comes straight back the moment the share it withdraws lands. Within
    one device the chain hash makes that impossible; across two devices of the
    same person it is ordinary, because their laptop can withdraw what their
    phone published and the two pages travel independently. */
    const fs = fsWith()
    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, { entries: [], withdrawn: ['p1'], heads: {}, cursor: {}, v: 1, opinion: {}, reviews: [], unreviewed: [], works: [], unshelved: [], list: NO_LIST_HELD }, NOTED, ADMITS)

    const held = await readForeign(fs, BOOK, PERSON)
    expect(held.withdrawn).toEqual(['p1'])
    expect(held.entries).toEqual([])
  })

  it('hides an entry whose pub has been withdrawn, whatever order they were written', async () => {
    /* A file holding both is a file that would draw a passage its author has
       taken back — with nothing the reader could do to stop it. */
    const fs = fsWith({
      [circlePathIn(BOOK, PERSON)]: JSON.stringify({
        entries: [entry(), entry({ pub: 'p2' })],
        withdrawn: [entry().pub],
        heads: {},
        cursor: {},
        v: 1,
      }),
    })

    const held = await readForeign(fs, BOOK, PERSON)

    expect(held.entries.map((one) => one.pub)).toEqual(['p2'])
    expect(held.withdrawn).toContain(entry().pub)
  })

  it('keeps a withdrawal list free of duplicates', async () => {
    /* Two devices withdrawing the same passage, or one page redelivered. The
       list is a SET; storing it twice grows a file that only ever grows. */
    const fs = fsWith({
      [circlePathIn(BOOK, PERSON)]: JSON.stringify({ entries: [], withdrawn: ['p1', 'p1', 'p2'], heads: {}, cursor: {}, v: 1 }),
    })

    expect((await readForeign(fs, BOOK, PERSON)).withdrawn).toEqual(['p1', 'p2'])
  })

  it('refuses a row whose author only ALIASES the file it sits in', async () => {
    /* ⚠️ **THE CHECK USED TO ACCEPT THIS, AND ARGUED FOR IT.** `safeId` maps
       every non-alphanumeric to `_`, so `a/b`, `a-b` and `a_b` share one file —
       and comparing THROUGH the path agreed that a row claiming any of them
       wrote the entries in `a_b.json`. The collision was already a fact about
       the layout; agreeing with it here made it a fact about who the reader is
       told wrote a passage.

       It costs nothing real to refuse: a person id is a 64-hex public key, and
       `safeId` is the identity on hex. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fs = fsWith({
        [circlePathIn(BOOK, 'a_b')]: JSON.stringify({ entries: [entry({ person: 'a/b' })], withdrawn: [], heads: {}, cursor: {}, v: 1 }),
      })
      expect(await readForeign(fs, BOOK, 'a_b')).toEqual(shared([]))
    } finally {
      warn.mockRestore()
    }
  })

  it('still accepts a row whose author is exactly the file it sits in', () => {
    // The refusal must not have taken the ordinary case with it.
    expect(circlePathIn(BOOK, PERSON)).toContain(PERSON)
  })

  it('lists people in a stable order, whatever the directory says', async () => {
    /* ⚠️ `drawable` groups several readers at one anchor into ONE mark, and the
       FIRST entry supplies its person, publication and overlay key. In
       directory order, a redraw could move the key and foliate would see a
       different annotation. */
    const fs = fsWith()
    const queue = queueOf()
    for (const who of ['zoe', 'alice', 'mike']) {
      await writeForeign(fs, queue, LANE, BOOK, who, shared([entry({ person: who })]), NOTED, ADMITS)
    }
    expect(await peopleFor(fs, BOOK)).toEqual(['alice', 'mike', 'zoe'])
  })

  it('writes on the library’s lane, not a second one derived here', async () => {
    /* ⚠️ **`folderOf` IS MANY-TO-ONE.** `book:a/b` and `book:a_b` are two ids
       over ONE directory, so a lane derived here puts them on two lanes over
       the same files — and a circle write could then interleave with a marks
       write, a folder move or a removal. The kernel has already paid for this
       exact defect once (`services.ts`: *"they took two lanes over the same
       files"*), and `Library.lane` says the rule in as many words: deriving it
       again elsewhere is a race that does not show up in a diff. */
    const keys: string[] = []
    await writeForeign(fsWith(), queueOf(keys), LANE, 'book:a/b', 'alice', shared([]), NOTED, ADMITS)
    await purgeForeign(fsWith(), queueOf(keys), LANE, 'book:a_b', 'alice', NOTED)

    expect(keys).toEqual([LANE('book:a/b'), LANE('book:a_b')])
    /* The two ids fold onto ONE lane, which is the whole point. */
    expect(new Set(keys).size).toBe(1)
  })

  it('purges somebody who sent nothing without complaining', async () => {
    /* A reader blocking somebody must not be told the block failed on the
       strength of their never having shared anything. */
    await expect(purgeForeign(fsWith(), queueOf(), LANE, BOOK, 'nobody', NOTED)).resolves.toBeUndefined()
  })
})

describe('the overlay contribution', () => {
  const overlay = circle.overlays![0]!

  const start = (fs: IndexFs) => {
    const disposable = circle.start!(
      { onCleanup: () => {}, services: { hashes: () => null, fs, library: LIBRARY, writes: queueOf(), clock: () => 'stamp' } } as never,
      new AbortController().signal,
    ) as { dispose(): void }
    return disposable
  }


  it('does not draw a withdrawn passage through the overlay either', async () => {
    /* The store hiding it is only half: `annotationsFor` reads through
       `readForeign`, so this is what a reader actually sees. */
    const fs = fsWith({
      [circlePathIn(BOOK, PERSON)]: JSON.stringify({
        entries: [entry()],
        withdrawn: [entry().pub],
        heads: {},
        cursor: {},
        v: 1,
      }),
    })
    const disposable = start(fs)

    const drawn = await overlay.forBook({ bookId: BOOK, resolve: placesEverything() })

    expect(drawn).toEqual([])
    disposable.dispose()
  })

  it('answers nothing before the capability has started', async () => {
    expect(await overlay.forBook({ bookId: BOOK, resolve: () => Promise.reject(new Error('no')) })).toEqual(
      [],
    )
  })

  it('anchors an unresolved passage through the kernel resolver, then draws it', async () => {
    /* ⚠️ **THE WHOLE SEAM, END TO END.** A file on disk holds a passage with no
       anchor here; the kernel hands over a resolver; the capability contributes
       an annotation whose cfi the painter can take. */
    const fs = fsWith()
    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, shared([entry()]), NOTED, ADMITS)
    const disposable = start(fs)

    const resolve = vi.fn(
      (): Promise<ResolveResult> =>
        Promise.resolve({
          /* The composite key, not the bare `pub` — a `pub` is minted by
             whoever shared the passage, so two people can mint the same one. */
          found: [
            {
              id: `circle:${PERSON}:pub1`,
              cfi: resolvedCfiForTesting('epubcfi(/6/4!/4/2)'),
              sectionIndex: 1,
            },
          ],
          missed: [],
          complete: true,
        }),
    )
    const drawn = await overlay.forBook({ bookId: BOOK, resolve })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.cfi).toBe('epubcfi(/6/4!/4/2)')
    expect(drawn[0]!.quote).toBe('Call me Ishmael')
    expect(drawn[0]!.readers).toBe(1)
    disposable.dispose()
  })

  it('draws NOTHING for a passage this build does not contain', async () => {
    /* The honest outcome, and not an error: a friend's passage that is not in
       your edition simply has nowhere to be painted. */
    const fs = fsWith()
    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, shared([entry()]), NOTED, ADMITS)
    const disposable = start(fs)

    const drawn = await overlay.forBook({
      bookId: BOOK,
      resolve: () => Promise.resolve({ found: [], missed: ['pub1'], complete: true }),
    })
    expect(drawn).toEqual([])
    disposable.dispose()
  })

  it('re-anchors a passage whose file already claimed an anchor', async () => {
    /* ⚠️ **AND IT USED TO TRUST THE FILE**, on the reasoning that a book whose
       entries all have an anchor should cost nothing on open. The optimisation
       is real and the version of it that shipped could not be checked: nothing
       stored beside a cached cfi says which edition produced it, so a later
       edition draws somebody's claim over text they never marked — and it is
       the one field `annotationsFor` never re-examines. It comes back when the
       cache carries the `contentHash` the reader's own one already does. */
    const fs = fsWith({
      [circlePathIn(BOOK, PERSON)]: JSON.stringify({
        entries: [{ ...entry(), resolved: { cfi: 'epubcfi(/6/4!/4/2)', sectionIndex: 1 } }],
        withdrawn: [],
        heads: {},
        cursor: {},
        v: 1,
      }),
    })
    const disposable = start(fs)

    const resolve = placesEverything()
    const drawn = await overlay.forBook({ bookId: BOOK, resolve })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(drawn).toHaveLength(1)
    disposable.dispose()
  })

  it('counts several readers on one passage as ONE mark', async () => {
    /* ⚠️ *"4 of 11 readers marked this"* — the feature's central case, and the
       one the painter used to collapse. */
    const fs = fsWith()
    const queue = queueOf()
    await writeForeign(fs, queue, LANE, BOOK, 'alice', shared([entry({ person: 'alice', pub: 'a' })]), NOTED, ADMITS)
    await writeForeign(fs, queue, LANE, BOOK, 'bob', shared([entry({ person: 'bob', pub: 'b' })]), NOTED, ADMITS)
    const disposable = start(fs)

    /* Both land at ONE anchor, which is the case: two people, one sentence. */
    const drawn = await overlay.forBook({ bookId: BOOK, resolve: placesEverything() })
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.readers).toBe(2)
    disposable.dispose()
  })

  it('does not hand one person’s anchor to another who minted the same pub', async () => {
    /* ⚠️ **A `pub` IS MINTED BY WHOEVER SHARED THE PASSAGE**, so it is unique
       to that person and not across the circle — and an admitted peer can pick
       an existing one on purpose. Keyed on `pub` alone, both entries landed on
       one record and took whichever anchor arrived last: Alice's mark drawn at
       Bob's sentence, and `foreignWeight` counting two readers of a passage
       only one of them marked. */
    const fs = fsWith()
    const queue = queueOf()
    await writeForeign(fs, queue, LANE, BOOK, 'alice', shared([
      entry({ person: 'alice', pub: 'same' }),
    ]), NOTED, ADMITS)
    await writeForeign(fs, queue, LANE, BOOK, 'bob', shared([
      entry({
        person: 'bob',
        pub: 'same',
        passage: {
          quote: 'a way of driving off the spleen',
          prefix: 'before ',
          suffix: ' after',
          chapter: 'Ch. 1',
        },
      }),
    ]), NOTED, ADMITS)
    const disposable = start(fs)

    /* Each pending passage is placed at its OWN section, so a swap shows. */
    const resolve = vi.fn((pending: readonly { id: string; quote: string }[]) =>
      Promise.resolve({
        found: pending.map((one) => ({
          id: one.id,
          cfi: resolvedCfiForTesting(`cfi-for-${one.quote}`),
          sectionIndex: one.quote === 'Call me Ishmael' ? 1 : 2,
        })),
        missed: [],
        complete: true,
      }),
    )
    const drawn = await overlay.forBook({ bookId: BOOK, resolve })

    /* Two people, two different passages, two marks — never one of weight 2. */
    expect(drawn).toHaveLength(2)
    expect(drawn.map((one) => one.readers)).toEqual([1, 1])
    expect(new Set(drawn.map((one) => one.cfi)).size).toBe(2)
    disposable.dispose()
  })

  it("one person's unreadable file does not cost the others theirs", async () => {
    /* `readForeign` throws by design. Letting that propagate would take the
       whole book's overlay down for one bad file — `enrichOne`'s posture, and
       the same reason. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fs = fsWith({ [circlePathIn(BOOK, 'broken')]: 'not json at all' })
      await writeForeign(fs, queueOf(), LANE, BOOK, 'alice', shared([entry({ person: 'alice' })]), NOTED, ADMITS)
      const disposable = start(fs)

      const drawn = await overlay.forBook({ bookId: BOOK, resolve: placesEverything() })
      expect(drawn).toHaveLength(1)
      expect(warn).toHaveBeenCalled()
      disposable.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  it('stops contributing once disposed', async () => {
    const fs = fsWith()
    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, shared([entry()]), NOTED, ADMITS)
    const disposable = start(fs)
    expect(await overlay.forBook({ bookId: BOOK, resolve: placesEverything() })).toHaveLength(1)

    disposable.dispose()
    expect(await overlay.forBook({ bookId: BOOK, resolve: placesEverything() })).toEqual([])
  })

  it('tells the reader when what is shared changes', async () => {
    /* ⚠️ **THE LISTENERS WERE ADDED, REMOVED, CLEARED — AND NEVER CALLED.**
       `subscribe` is the whole answer to *"a share arriving mid-session can
       neither appear nor disappear"*; a signal nothing fires is that promise
       made and not kept. */
    const fs = fsWith()
    const disposable = start(fs)
    const told = vi.fn()
    overlay.subscribe(told)

    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, shared([entry()]), circleChanged, ADMITS)

    expect(told).toHaveBeenCalledTimes(1)
    disposable.dispose()
  })

  it('stops telling a listener that unsubscribed', async () => {
    const fs = fsWith()
    const disposable = start(fs)
    const told = vi.fn()
    overlay.subscribe(told)()

    circleChanged()

    expect(told).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('tells the others when one listener throws', async () => {
    /* One surface failing to react must not stop the rest hearing. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const disposable = start(fsWith())
      const second = vi.fn()
      overlay.subscribe(() => {
        throw new Error('nope')
      })
      overlay.subscribe(second)

      circleChanged()

      expect(second).toHaveBeenCalledTimes(1)
      disposable.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  it('does not let an old run’s unsubscribe remove a newer run’s listener', async () => {
    /* ⚠️ **THE UNSUBSCRIBE LOOKED THE SET UP AGAIN ON THE WAY OUT.** After a
       restart it deleted from the NEW run's set — taking somebody else's
       subscription away and leaving its own in place. Capturing the set at
       subscribe time is what ties the removal to the thing that was added. */
    /* ⚠️ THE SAME FUNCTION subscribes under both runs, which is the case that
       discriminates: `delete` is by identity, so an unsubscribe aimed at the
       wrong set is a silent no-op for any OTHER listener. A panel that
       re-subscribes a stable callback across a restart is exactly this. */
    const told = vi.fn()
    const first = start(fsWith())
    const stale = overlay.subscribe(told)

    const second = start(fsWith())
    overlay.subscribe(told)

    /* The OLD run's unsubscribe, run after the new one is live. */
    stale()
    circleChanged()

    expect(told).toHaveBeenCalledTimes(1)
    first.dispose()
    second.dispose()
  })

  it('does not let an old run’s teardown silence a newer one', async () => {
    /* ⚠️ **`dispose` READ THE MODULE SLOT, NOT THE RUN IT BELONGED TO.** An
       overlapping restart replaced it; the OLD disposable then cleared the NEW
       run's listeners and nulled the slot, leaving a capability that is
       nominally started and contributes nothing. */
    const first = start(fsWith())
    const second = start(fsWith())
    const told = vi.fn()
    overlay.subscribe(told)

    first.dispose()
    circleChanged()

    expect(told).toHaveBeenCalledTimes(1)
    second.dispose()
  })

  it('starts with no filesystem rather than failing', async () => {
    /* A composition with no filesystem — the browser client — means no shared
       passages, not a failed capability. */
    const disposable = circle.start!({ onCleanup: () => {}, services: { hashes: () => null, fs: null } } as never, new AbortController().signal) as {
      dispose(): void
    }
    expect(await overlay.forBook({ bookId: BOOK, resolve: () => Promise.reject(new Error('x')) })).toEqual([])
    disposable.dispose()
  })
})

describe('through the real composition', () => {
  it('reaches the reader as a composed overlay, not just as an export', async () => {
    /* ⚠️ **THE POINT OF THIS WHOLE LAYER.** `src/kernel/core/circle/` was
       1 300 lines with no production importer — the state the plan opens by
       condemning: *"the circle's first dependency is not a key or a socket. It
       is a resolver nobody can reach."* This asserts the capability is
       genuinely composed and its overlay genuinely collected, which a unit test
       against the export cannot say. */
    const { composeCapabilities, createKernelServices, kernelApi } = await import('../../kernel')
    const { capabilities } = await import('../../app/composition.desktop')

    expect(capabilities.map((one) => one.id)).toContain('circle')

    /* A STUB `peer`, because `circle` declares it in `requires` and the real
       one binds a Tauri plugin this test has no business starting. What is
       under test is that the composition COLLECTS the overlay, not that peer
       works — and the registry refuses a composition whose `requires` does not
       resolve, so the id has to be present.

       `kernelApi(createKernelServices(...))` rather than a hand-built object:
       the real `KernelApi` has a `diagnostics.child`, and a fake missing one
       fails inside the registry with a message about the fake. */
    const composition = await composeCapabilities(
      [{ id: 'peer' }, circle],
      kernelApi(createKernelServices({ fs: null, storage: null })),
      new AbortController().signal,
    )

    expect(composition.overlays.map((one) => one.id)).toContain('circle:shared')
    /* WI-23.A1: the share control reaches Marginalia the same way — as a
       COLLECTED contribution, not an export nothing mounts. */
    expect(composition.markControls.map((one) => one.id)).toEqual(['circle:share'])
    /* WI-23.B4: the book's surface is a pane on the reader screen. */
    expect(composition.panes.map((one) => [one.id, [...one.screens]])).toEqual([['circle:book', ['reader']]])
    composition.dispose()
    /* And it stops contributing when the composition goes down, so a torn-down
       capability leaves no marks on the page. */
    expect(composition.overlays).toEqual([])
    expect(composition.markControls).toEqual([])
  })
})

describe('the share control contribution — WI-23.A1', () => {
  const shareControl = () => circle.markControls?.find((one) => one.id === 'circle:share')

  it('draws its control over NO port before the capability has started', () => {
    /* A row rendered before `start`, or after `dispose`, must not hold a port
       into a filesystem the run no longer owns. The control draws nothing
       for a null port, which is the honest rendering. */
    const element = shareControl()?.render({ id: 'm1', bookId: BOOK } as never) as {
      readonly props: { readonly port: unknown; readonly mark: { readonly id: string } }
    }
    expect(element.props.port).toBeNull()
    expect(element.props.mark.id).toBe('m1')
  })

  it('binds the control to this run’s port once started, and unbinds it on dispose', () => {
    const disposable = circle.start!(
      {
        onCleanup: () => {},
        services: {
          hashes: () => null,
          fs: fsWith(),
          library: LIBRARY,
          writes: queueOf(),
          clock: () => 'stamp',
        },
      } as never,
      new AbortController().signal,
    ) as { dispose(): void }
    const during = shareControl()?.render({ id: 'm1', bookId: BOOK } as never) as { readonly props: { readonly port: unknown } }
    expect(during.props.port).not.toBeNull()
    /* ONE port per run: two rows share it, so the effect each keys on it
       does not re-read the store on every render. */
    const again = shareControl()?.render({ id: 'm2', bookId: BOOK } as never) as { readonly props: { readonly port: unknown } }
    expect(again.props.port).toBe(during.props.port)
    disposable.dispose()
    const after = shareControl()?.render({ id: 'm1', bookId: BOOK } as never) as { readonly props: { readonly port: unknown } }
    expect(after.props.port).toBeNull()
  })

  it('answers the share state from this run’s store, and shares nothing without a peer', async () => {
    /* No peer has started in this process, so the port answers `unreachable`
       — and a share is refused with that reason rather than written. */
    const fs = fsWith()
    const disposable = circle.start!(
      {
        onCleanup: () => {},
        services: {
          fs,
          library: LIBRARY,
          writes: queueOf(),
          clock: () => 'stamp',
        },
      } as never,
      new AbortController().signal,
    ) as { dispose(): void }
    try {
      const element = shareControl()?.render({ id: 'm1', bookId: BOOK } as never) as {
        readonly props: { readonly port: { state(mark: unknown): Promise<unknown>; share(mark: unknown, note: boolean): Promise<void> } }
      }
      const mark = { id: 'm1', bookId: BOOK, text: 'q', prefix: '', suffix: '', chapter: '', note: '' }
      expect(await element.props.port.state(mark)).toEqual({ publishability: 'unreachable', published: false })
      await expect(element.props.port.share(mark, false)).rejects.toThrow('Your shelf has not answered.')
      expect(await fs.exists(`books/${BOOK.replace(/[^a-zA-Z0-9]/gu, '_')}/shared.json`)).toBe(false)
    } finally {
      disposable.dispose()
    }
  })
})

describe('every clause of every validity check', () => {
  /**
   * ⚠️ **FIFTY-THREE MUTANTS SURVIVED IN THIS FILE, AND THEY WERE ONE DEFECT.**
   * Each predicate below is a chain of clauses, and each was exercised by ONE
   * bad input — so deleting any other clause changed nothing any test could
   * see. A validity check tested that way is a check whose remaining clauses
   * are decoration: they can be removed, or silently stop working, and the
   * suite stays green.
   *
   * Tables rather than prose, one row per clause, because the failure mode is
   * a clause nobody wrote a case for and a table makes the omission visible.
   */

  const file = (over: Record<string, unknown>) =>
    fsWith({ [circlePathIn(BOOK, PERSON)]: JSON.stringify({ entries: [], withdrawn: [], heads: {}, cursor: {}, v: 1, ...over }) })

  describe('the chain-head map', () => {
    /* ⚠️ Reading a bad one as "no chain yet" resets every chain to its start,
       which is precisely the substitution `prevPageHash` refuses — granted by
       a relaunch. */
    const bad: readonly (readonly [string, unknown])[] = [
      ['a string', 'heads'],
      ['a number', 7],
      ['null', null],
      ['an array', []],
      ['an array of pairs', [['device', 'hash']]],
      ['a map to a number', { device: 1 }],
      ['a map to null', { device: null }],
      ['a map to an object', { device: {} }],
    ]
    for (const [what, heads] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ heads }), BOOK, PERSON)).rejects.toThrow(/chain heads/u)
      })
    }

    it('reads a real one, so the refusals above are not vacuous', async () => {
      const heads = { [PERSON]: 'a'.repeat(64) }
      expect((await readForeign(file({ heads }), BOOK, PERSON)).heads).toEqual(heads)
    })
  })

  describe('the fetch cursor — WI-23.A2', () => {
    /* ⚠️ Reading a bad one as "nothing fetched yet" re-fetches every log from
       zero, which is the defect the field was added to remove — granted by a
       relaunch. Absent is refused too: no file this capability wrote lacks
       one, and a hand-made file is one somebody can finish. */
    const bad: readonly (readonly [string, unknown])[] = [
      ['no cursor at all', undefined],
      ['a string', 'cursor'],
      ['a number', 7],
      ['null', null],
      ['an array', []],
      ['a map to a string', { device: '1' }],
      ['a map to a fraction', { device: 1.5 }],
      ['a map to a negative', { device: -1 }],
      ['a map to null', { device: null }],
      ['a map where only SOME values read', { d1: 1, d2: 'x' }],
    ]
    for (const [what, cursor] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ cursor }), BOOK, PERSON)).rejects.toThrow(/fetch cursor/u)
      })
    }

    it('reads a real one, zero included, so the refusals above are not vacuous', async () => {
      const cursor = { [PERSON]: 0, ['b'.repeat(64)]: 12 }
      expect((await readForeign(file({ cursor }), BOOK, PERSON)).cursor).toEqual(cursor)
    })
  })

  describe('the chain version — WI-23.B2', () => {
    /* A head read into the wrong chain is a chain that never verifies again. */
    const bad: readonly (readonly [string, unknown])[] = [
      ['no version at all', undefined],
      ['a string', '1'],
      ['null', null],
      ['zero', 0],
      ['a negative', -1],
      ['a fraction', 1.5],
    ]
    for (const [what, v] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ v }), BOOK, PERSON)).rejects.toThrow(/chain version/u)
      })
    }

    it('reads a real one, so the refusals above are not vacuous', async () => {
      expect((await readForeign(file({ v: 2 }), BOOK, PERSON)).v).toBe(2)
      expect((await readForeign(file({ v: 1 }), BOOK, PERSON)).v).toBe(1)
    })
  })

  describe('a file 0.1.3 wrote — heads, and neither cursor nor version', () => {
    /* That build persisted the chain heads and nothing about how far along
       them it was. Refused, every passage a friend sent before the upgrade
       threw on the first read after it. */
    it('reads as a chain started from nothing, with what is held kept', async () => {
      const held = await readForeign(
        file({ entries: [entry({ pub: 'kept' })], withdrawn: ['gone'], heads: { [PERSON]: 'a'.repeat(64) }, cursor: undefined, v: undefined }),
        BOOK,
        PERSON,
      )
      expect(held.entries.map((one) => one.pub)).toEqual(['kept'])
      expect(held.withdrawn).toEqual(['gone'])
      /* The heads go WITH the cursor: a head kept beside an empty cursor
         asks for the first page and refuses it as a gap, for ever. */
      expect(held.heads).toEqual({})
      expect(held.cursor).toEqual({})
      expect(held.v).toBe(1)
    })

    it('is the one shape read that way — one of the two alone is a hand-made file', async () => {
      await expect(readForeign(file({ cursor: undefined }), BOOK, PERSON)).rejects.toThrow(/fetch cursor/u)
      await expect(readForeign(file({ v: undefined }), BOOK, PERSON)).rejects.toThrow(/chain version/u)
    })
  })

  describe('the opinion — WI-23.B5', () => {
    /* ⚠️ Read as "nothing said", the next page naming an OLDER word would
       make it current again. One row per clause, each bad in one way. */
    const register = () => ({ value: 'reading', at: hlcOf(1), device: PERSON, seq: 1 })
    const bad: readonly (readonly [string, unknown])[] = [
      ['an opinion that is a string', 'reading'],
      ['an opinion that is null', null],
      ['an opinion that is an array', []],
      ['a status that is a string', { status: 'reading' }],
      ['a status that is null', { status: null }],
      ['a status that is a list', { status: [] }],
      ['stars that are a list', { stars: [] }],
      ['a status with no stamp', { status: { ...register(), at: undefined } }],
      ['a status with a stamp that is not one', { status: { ...register(), at: 'yesterday' } }],
      ['a status with no device', { status: { ...register(), device: undefined } }],
      ['a status with a fractional seq', { status: { ...register(), seq: 1.5 } }],
      ['a status this build does not know', { status: { ...register(), value: 'abandoned' } }],
      ['stars of six', { stars: { ...register(), value: 6 } }],
      ['stars that are a string', { stars: { ...register(), value: '4' } }],
      ['stars with no device', { stars: { ...register(), value: 4, device: undefined } }],
      ['tags that are a string', { tags: { ...register(), value: 'sea' } }],
      ['a tag that is a number', { tags: { ...register(), value: ['sea', 1] } }],
      ['tags with no stamp', { tags: { ...register(), value: ['sea'], at: undefined } }],
      ['a good status beside bad stars', { status: register(), stars: { ...register(), value: 9 } }],
    ]
    for (const [what, opinion] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ opinion }), BOOK, PERSON)).rejects.toThrow(/opinion/u)
      })
    }

    it('reads every good register, and an absent opinion as nothing said', async () => {
      const opinion = {
        status: register(),
        stars: { ...register(), value: 4, seq: 2 },
        tags: { ...register(), value: ['sea'], seq: 3 },
      }
      expect((await readForeign(file({ opinion }), BOOK, PERSON)).opinion).toEqual(opinion)
      expect((await readForeign(file({ opinion: undefined }), BOOK, PERSON)).opinion).toEqual({})
    })
  })

  describe('the review list and its withdrawals — WI-23.B5', () => {
    const review = () => ({ pub: 'r1', text: 'a whale of a book', at: hlcOf(1), epoch: 1 })
    const bad: readonly (readonly [string, unknown])[] = [
      ['reviews that are a string', 'r1'],
      ['a review that is null', [null]],
      ['a review with no pub', [{ ...review(), pub: undefined }]],
      ['a review with an empty pub', [{ ...review(), pub: '' }]],
      ['a review with no text', [{ ...review(), text: undefined }]],
      ['a review with a stamp that is not one', [{ ...review(), at: 'yesterday' }]],
      ['a review with an epoch of zero', [{ ...review(), epoch: 0 }]],
      ['a review with an epoch that is a float', [{ ...review(), epoch: 1.5 }]],
      ['a review with an epoch that is a string', [{ ...review(), epoch: '1' }]],
      ['a review with no epoch', [{ ...review(), epoch: undefined }]],
      ['a list where only SOME are reviews', [review(), 'no']],
    ]
    for (const [what, reviews] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ reviews }), BOOK, PERSON)).rejects.toThrow(/review list/u)
      })
    }

    it('reads a real one, hides one that was taken back, and reads an absent list as none', async () => {
      const held = await readForeign(file({ reviews: [review(), { ...review(), pub: 'r2' }], unreviewed: ['r2'] }), BOOK, PERSON)
      expect(held.reviews).toEqual([review()])
      expect(held.unreviewed).toEqual(['r2'])
      expect((await readForeign(file({ reviews: undefined, unreviewed: undefined }), BOOK, PERSON)).reviews).toEqual([])
    })

    for (const [what, unreviewed] of [
      ['a string', 'r1'],
      ['a number', 1],
      ['a list with a number in it', ['r1', 1]],
    ] as const) {
      it(`throws on review withdrawals that are ${what}`, async () => {
        await expect(readForeign(file({ unreviewed }), BOOK, PERSON)).rejects.toThrow(/review withdrawal list/u)
      })
    }
  })

  describe('the shelf and its withdrawals — WI-23.C3', () => {
    const work = () => ({ pub: 's1', at: hlcOf(1), work: { title: 'Moby-Dick', author: 'Herman Melville', language: 'en' } })
    const bad: readonly (readonly [string, unknown])[] = [
      ['a shelf that is a string', 'shelf'],
      ['a shelf that is null', null],
      ['a work that is null', [null]],
      ['a work with no pub', [{ ...work(), pub: undefined }]],
      ['a work with an empty pub', [{ ...work(), pub: '' }]],
      ['a work with a stamp that is not one', [{ ...work(), at: 'yesterday' }]],
      ['a work with no work', [{ ...work(), work: undefined }]],
      ['a work whose work is a string', [{ ...work(), work: 'Moby-Dick' }]],
      ['a work whose work is null', [{ ...work(), work: null }]],
      ['a work whose work is a list', [{ ...work(), work: [] }]],
      ['a work with no title', [{ ...work(), work: { author: 'A', language: 'en' } }]],
      ['a work with no author', [{ ...work(), work: { title: 'T', language: 'en' } }]],
      ['a work with no language', [{ ...work(), work: { title: 'T', author: 'A' } }]],
      ['a work whose identifier is a number', [{ ...work(), work: { ...work().work, identifier: 1 } }]],
      ['a work whose cover is a number', [{ ...work(), work: { ...work().work, cover: 1 } }]],
      ['a list where only SOME are works', [work(), 'no']],
    ]
    for (const [what, works] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ works }), BOOK, PERSON)).rejects.toThrow(/shelf/u)
      })
    }

    it('reads a real one, hides one taken back, and reads an absent shelf as empty', async () => {
      const withId = { ...work(), work: { ...work().work, identifier: 'isbn:1', cover: 'ab'.repeat(32) } }
      const held = await readForeign(file({ works: [withId, { ...work(), pub: 's2' }], unshelved: ['s2'] }), BOOK, PERSON)
      expect(held.works).toEqual([withId])
      expect(held.unshelved).toEqual(['s2'])
      expect((await readForeign(file({ works: undefined, unshelved: undefined }), BOOK, PERSON)).works).toEqual([])
    })

    for (const [what, unshelved] of [
      ['a string', 's1'],
      ['null', null],
      ['a list with a number in it', ['s1', 1]],
    ] as const) {
      it(`throws on shelf withdrawals that are ${what}`, async () => {
        await expect(readForeign(file({ unshelved }), BOOK, PERSON)).rejects.toThrow(/shelf withdrawal list/u)
      })
    }
  })

  describe('a list and its removals — WI-23.E1', () => {
    const item = () => ({ pub: 'i1', at: hlcOf(2), device: 'd'.repeat(64), seq: 2, position: 1, note: 'n', work: { title: 'Moby-Dick', author: 'Herman Melville', language: 'en' } })
    const list = (over: Record<string, unknown> = {}) => ({ created: true, title: { value: 'Sea', at: hlcOf(1), device: 'd'.repeat(64), seq: 1 }, deleted: false, items: [item()], removed: [], ...over })
    const bad: readonly (readonly [string, unknown])[] = [
      ['a list that is a string', 'list'],
      ['a list that is null', null],
      ['a list that is an array', []],
      ['no created flag', list({ created: undefined })],
      ['a created flag that is a string', list({ created: 'yes' })],
      ['no deleted flag', list({ deleted: undefined })],
      ['a title that is a string', list({ title: 'Sea' })],
      ['a title with no value', list({ title: { at: hlcOf(1), device: 'd'.repeat(64), seq: 1 } })],
      ['a title with no stamp', list({ title: { value: 'Sea' } })],
      ['items that are not a list', list({ items: 'i1' })],
      ['an item that is null', list({ items: [null] })],
      ['an item with no pub', list({ items: [{ ...item(), pub: undefined }] })],
      ['an item with no device', list({ items: [{ ...item(), device: undefined }] })],
      ['an item with a sequence that is not one', list({ items: [{ ...item(), seq: 1.5 }] })],
      ['an item with a position that is not an integer', list({ items: [{ ...item(), position: 1.5 }] })],
      ['an item with no note', list({ items: [{ ...item(), note: undefined }] })],
      ['an item with no work', list({ items: [{ ...item(), work: undefined }] })],
      ['an item whose work is null', list({ items: [{ ...item(), work: null }] })],
      ['a title that is null', list({ title: null })],
      ['a title that is a list', list({ title: [] })],
      ['removals that are not a list', list({ removed: 'i1' })],
      ['a removal that is a number', list({ removed: [1] })],
    ]
    for (const [what, value] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ list: value }), BOOK, PERSON)).rejects.toThrow(/list that will not read/u)
      })
    }

    it('reads a real one, hides a removed item, orders by the position rule, and reads an absent list as none', async () => {
      const later = { ...item(), pub: 'i2', seq: 3, at: hlcOf(3), position: 1 }
      const held = await readForeign(file({ list: list({ items: [later, item(), { ...item(), pub: 'i3', seq: 4 }], removed: ['i3', 'i3'] }) }), BOOK, PERSON)
      /* Same position: the earlier stamp first. */
      expect(held.list.items.map((one) => one.pub)).toEqual(['i1', 'i2'])
      expect(held.list.removed).toEqual(['i3'])
      expect(held.list.title).toEqual({ value: 'Sea', at: hlcOf(1), device: 'd'.repeat(64), seq: 1 })
      const untitled = await readForeign(file({ list: list({ title: undefined }) }), BOOK, PERSON)
      expect('title' in untitled.list).toBe(false)
      expect((await readForeign(file({ list: undefined }), BOOK, PERSON)).list).toEqual(NO_LIST_HELD)
    })

    it('names the list in the error for a list file that will not read', async () => {
      const fs = fsWith({ [personListPathIn(PERSON, 'aa11')]: JSON.stringify({ ...NOTHING_SHARED, list: 'no' }) })
      await expect(readHeldList(fs, PERSON, 'aa11')).rejects.toThrow(/lists\/aa11/u)
    })

    it('lists only the json files under the person, not a folder or a note beside them', async () => {
      const fs = fsWith()
      await writeHeldList(fs, queueOf(), PERSON, 'aa11', NOTHING_SHARED, () => {}, ADMITS)
      await fs.writeFile(`${personListsDirIn(PERSON)}/notes.txt`, new TextEncoder().encode('x'))
      await fs.writeFile(`${personListsDirIn(PERSON)}/folder/inside.json`, new TextEncoder().encode('{}'))
      expect(await heldListIdsOf(fs, PERSON)).toEqual(['aa11'])
    })

    it('keeps a held shelf in its own file under the person, tells the caller, reads it back, and names it when it will not read', async () => {
      const fs = fsWith()
      const noted = vi.fn()
      const held = { ...NOTHING_SHARED, works: [{ pub: 's1', at: hlcOf(1), work: { title: 'Moby-Dick', author: 'Herman Melville', language: 'en' } }] } as ForeignFile
      expect(await readHeldShelf(fs, PERSON)).toEqual(NOTHING_SHARED)
      await writeHeldShelf(fs, queueOf(), PERSON, held, noted, ADMITS)
      expect(noted).toHaveBeenCalledTimes(1)
      expect(await fs.exists(personShelfPathIn(PERSON))).toBe(true)
      expect(await readHeldShelf(fs, PERSON)).toEqual(held)
      await fs.writeFile(personShelfPathIn(PERSON), new TextEncoder().encode('"shelf"'))
      await expect(readHeldShelf(fs, PERSON)).rejects.toThrow(/\/shelf is not a circle file/u)
      /* A cover is a digest (WI-23.C5): a row with a word in its place is a shelf that will not read. */
      const worded = { ...held, works: [{ ...held.works[0]!, work: { ...held.works[0]!.work, cover: 'not a digest' } }] } as ForeignFile
      await fs.writeFile(personShelfPathIn(PERSON), new TextEncoder().encode(JSON.stringify(worded)))
      await expect(readHeldShelf(fs, PERSON)).rejects.toThrow(/has a shelf that will not read/u)
    })

    it('keeps a held list in its own file under the person, listed by id, and reads it back', async () => {
      const fs = fsWith()
      const held = { ...NOTHING_SHARED, list: list() } as ForeignFile
      expect(await heldListIdsOf(fs, PERSON)).toEqual([])
      const noted = vi.fn()
      await writeHeldList(fs, queueOf(), PERSON, 'bb22', held, noted, ADMITS)
      await writeHeldList(fs, queueOf(), PERSON, 'aa11', { ...held, list: list({ title: undefined }) } as ForeignFile, noted, ADMITS)
      expect(noted).toHaveBeenCalledTimes(2)
      expect(await heldListIdsOf(fs, PERSON)).toEqual(['aa11', 'bb22'])
      expect((await readHeldList(fs, PERSON, 'bb22')).list.title?.value).toBe('Sea')
      expect((await readHeldList(fs, PERSON, 'zz99')).list).toEqual(NO_LIST_HELD)
      expect(await fs.exists(personListPathIn(PERSON, 'bb22'))).toBe(true)
    })
  })

  describe('the withdrawal list', () => {
    const bad: readonly (readonly [string, unknown])[] = [
      ['a string', 'p1'],
      ['a number', 1],
      ['null', null],
      ['an object', { p1: true }],
      ['a list holding a number', [1]],
      ['a list holding null', [null]],
      ['a list holding an object', [{ pub: 'p1' }]],
    ]
    for (const [what, withdrawn] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ withdrawn }), BOOK, PERSON)).rejects.toThrow(/withdrawal list/u)
      })
    }
  })

  describe('the entry list', () => {
    const bad: readonly (readonly [string, unknown])[] = [
      ['a string', 'entries'],
      ['a number', 1],
      ['null', null],
      ['an object', { pub: 'p1' }],
    ]
    for (const [what, entries] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readForeign(file({ entries }), BOOK, PERSON)).rejects.toThrow(/entry list/u)
      })
    }
  })

  describe('one row of the entry list', () => {
    /* ⚠️ **EVERY FIELD, ONE ROW EACH.** A row missing any of these reached
       `annotationsFor` and threw on `entry.passage.quote` — AFTER the
       per-person isolation had run, so one malformed record took down every
       other person's overlay for that book. */
    const good = () => entry()
    const rows: readonly (readonly [string, unknown])[] = [
      ['a row that is null', null],
      ['a row that is a string', 'entry'],
      ['a row that is a number', 7],
      ['a row that is an array', []],
      ['no passage at all', { ...good(), passage: undefined }],
      ['a passage that is null', { ...good(), passage: null }],
      ['a passage that is a string', { ...good(), passage: 'quote' }],
      ['no pub', { ...good(), pub: undefined }],
      ['an empty pub', { ...good(), pub: '' }],
      ['a pub that is a number', { ...good(), pub: 1 }],
      ['no author', { ...good(), person: undefined }],
      ['an empty author', { ...good(), person: '' }],
      ['an author that is a number', { ...good(), person: 1 }],
      ['no epoch', { ...good(), epoch: undefined }],
      ['an epoch that is a string', { ...good(), epoch: '1' }],
      ['no receivedAt', { ...good(), receivedAt: undefined }],
      ['a receivedAt that is a string', { ...good(), receivedAt: '1' }],
      ['no quote', { ...good(), passage: { ...good().passage, quote: undefined } }],
      ['a quote that is a number', { ...good(), passage: { ...good().passage, quote: 1 } }],
      ['no prefix', { ...good(), passage: { ...good().passage, prefix: undefined } }],
      ['a prefix that is a number', { ...good(), passage: { ...good().passage, prefix: 1 } }],
      ['no suffix', { ...good(), passage: { ...good().passage, suffix: undefined } }],
      ['a suffix that is a number', { ...good(), passage: { ...good().passage, suffix: 1 } }],
      ['no chapter', { ...good(), passage: { ...good().passage, chapter: undefined } }],
      ['a chapter that is a number', { ...good(), passage: { ...good().passage, chapter: 1 } }],
    ]

    for (const [what, row] of rows) {
      it(`drops a row with ${what}, and keeps the good one beside it`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          const fs = file({ entries: [row, good()] })
          expect((await readForeign(fs, BOOK, PERSON)).entries).toEqual([good()])
        } finally {
          warn.mockRestore()
        }
      })
    }
  })

  it('names the book and the person when it drops a row', async () => {
    /* ⚠️ **A WARNING NOBODY CAN ATTRIBUTE IS A WARNING NOBODY ACTS ON.** This
       is the only trace a dropped passage leaves; without the two names it says
       a row went missing somewhere in the library. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await readForeign(file({ entries: [null] }), BOOK, PERSON)
      expect(warn).toHaveBeenCalledTimes(1)
      const said = String(warn.mock.calls[0]?.[0])
      expect(said).toContain(BOOK)
      expect(said).toContain(PERSON)
    } finally {
      warn.mockRestore()
    }
  })

  it('says a file of `null` is not a circle file, rather than throwing on a member of it', async () => {
    /* ⚠️ **`typeof null === 'object'`**, so `null` passes the first clause of
       the guard and only the explicit check catches it. Without that check the
       next line reads a member of `null` and the reader gets a `TypeError`
       naming an internal expression instead of a sentence naming their file. */
    const fs = fsWith({ [circlePathIn(BOOK, PERSON)]: 'null' })
    await expect(readForeign(fs, BOOK, PERSON)).rejects.toThrow(/is not a circle file/u)
  })

  describe('listing the people who have shared', () => {
    it('ignores a directory, a file with no .json, and one named only .json', async () => {
      /* ⚠️ **`.json` STRIPPED BY LENGTH, so a file named exactly `.json` would
         become the EMPTY person id** — and `circlePathIn('')` is a path
         `safeId` refuses outright. The filter is what keeps it from being
         asked. */
      const fs = {
        exists: () => Promise.resolve(true),
        readDir: () =>
          Promise.resolve([
            { name: 'alice.json', isDirectory: false },
            { name: 'nested', isDirectory: true },
            { name: 'notes.txt', isDirectory: false },
            { name: 'bob.json', isDirectory: true },
          ]),
      } as unknown as IndexFs

      expect(await peopleFor(fs, BOOK)).toEqual(['alice'])
    })

    it('answers an absent folder with nobody, not an error', async () => {
      /* Almost every book on a shelf has no circle folder at all; a throw here
         would fail the overlay pass for the common book rather than the rare
         one. */
      const fs = { exists: () => Promise.resolve(false), readDir: () => Promise.reject(new Error('never')) } as unknown as IndexFs
      expect(await peopleFor(fs, BOOK)).toEqual([])
    })

    it('sorts, because readDir order is not specified and this order decides a mark', async () => {
      /* `drawable` groups several readers at one anchor into ONE mark, and the
         FIRST entry supplies that mark's person and overlay key. */
      const fs = {
        exists: () => Promise.resolve(true),
        readDir: () =>
          Promise.resolve([
            { name: 'carol.json', isDirectory: false },
            { name: 'alice.json', isDirectory: false },
            { name: 'bob.json', isDirectory: false },
          ]),
      } as unknown as IndexFs

      expect(await peopleFor(fs, BOOK)).toEqual(['alice', 'bob', 'carol'])
    })
  })
})

describe('the services a friend calls', () => {
  const named = (name: string) => circle.services?.find((one) => one.name === name)

  it('contributes both, and gates both on the circle grant', () => {
    /* ⚠️ **`circle:read` IS GRANTED ONLY BY A CIRCLE PAIRING.** A device paired
       as a DEVICE — the reader's own laptop — must not be able to ask for
       pages, and a service with no grant would erase the distinction the two
       pairing kinds exist to make. */
    expect(named('circle.hello')?.grant).toBe('circle:read')
    expect(named('circle.pages')?.grant).toBe('circle:read')
    /* The shelf too (WI-23.C1): the same grant, and the per-person SWITCH
       decides the rest, inside the handler. */
    expect(named('circle.shelf')?.grant).toBe('circle:read')
    /* And the lists (WI-23.E1), under the same switch. */
    expect(named('circle.lists')?.grant).toBe('circle:read')
    /* And the jacket (WI-23.C5), under the same grant and the same switch. */
    expect(named('circle.cover')?.grant).toBe('circle:read')
    expect(circle.services).toHaveLength(5)
  })

  it('refuses the shelf and the lists before the capability has started', async () => {
    await expect(named('circle.shelf')?.handler({ since: {}, v: 2 }, { peer: 'd' } as never)).rejects.toThrow(/not started/u)
    await expect(named('circle.lists')?.handler({ since: {}, v: 3 }, { peer: 'd' } as never)).rejects.toThrow(/not started/u)
    await expect(named('circle.cover')?.handler({ pub: 'ab', offset: 0 }, { peer: 'd' } as never)).rejects.toThrow(/not started/u)
  })

  it('answers a device no roster names with the bytes a reader who owns nothing sends — WI-23.C2', async () => {
    /* No peer has started here, so nobody's roster names the caller; that is
       the same answer as a person the switch is off for, on purpose. */
    const disposable = circle.start!(
      { onCleanup: () => {}, services: { hashes: () => null, fs: fsWith(), library: LIBRARY, writes: queueOf(), clock: () => 'stamp' } } as never,
      new AbortController().signal,
    ) as { dispose(): void }
    try {
      const answer = await named('circle.shelf')?.handler({ since: {}, v: 2 }, { peer: 'd'.repeat(64) } as never)
      expect(JSON.stringify(answer)).toBe(JSON.stringify({ pages: [], more: false }))
      const lists = await named('circle.lists')?.handler({ since: {}, v: 3 }, { peer: 'd'.repeat(64) } as never)
      expect(JSON.stringify(lists)).toBe(JSON.stringify({ pages: [], more: false }))
      await expect(named('circle.lists')?.handler({ since: {}, v: 2 }, { peer: 'd'.repeat(64) } as never)).rejects.toThrow(/not one this build answers/u)
      /* And a request the build cannot parse is refused, not answered. */
      await expect(named('circle.shelf')?.handler({ since: {} }, { peer: 'd'.repeat(64) } as never)).rejects.toThrow(/not one this build answers/u)
    } finally {
      disposable.dispose()
    }
  })

  it('refuses before the capability has started', async () => {
    /* Not "answers emptily": a service reachable before its state exists is a
       handler reading a null, and the failure should name itself. */
    await expect(named('circle.pages')?.handler({}, {} as never)).rejects.toThrow(/not started/u)
  })

  it('refuses a request this build cannot parse, rather than answering one', async () => {
    const disposable = circle.start!(
      { onCleanup: () => {}, services: { hashes: () => null, fs: fsWith(), library: LIBRARY, writes: queueOf() } } as never,
      new AbortController().signal,
    ) as { dispose(): void }
    try {
      await expect(named('circle.pages')?.handler({ work: 'moby' }, {} as never)).rejects.toThrow(
        /not one this build answers/u,
      )
    } finally {
      disposable.dispose()
    }
  })

  it('stops answering once it is disposed', async () => {
    /* ⚠️ **A HANDLER THAT OUTLIVED ITS RUN WOULD READ ANOTHER RUN'S SERVICES**,
       or a null. The teardown is guarded the way `held` is. */
    const disposable = circle.start!(
      { onCleanup: () => {}, services: { hashes: () => null, fs: fsWith(), library: LIBRARY, writes: queueOf() } } as never,
      new AbortController().signal,
    ) as { dispose(): void }
    disposable.dispose()

    await expect(named('circle.pages')?.handler({}, {} as never)).rejects.toThrow(/not started/u)
  })
})

describe('the purge', () => {
  it('does not ask the filesystem to remove a file that is not there', async () => {
    /* ⚠️ **IDEMPOTENT, AND THE DOC PROMISES IT: a reader blocking somebody must
       not be told the block failed on the strength of their never having shared
       anything.** A real filesystem throws `ENOENT` on removing what is absent,
       so the `exists` check is the promise — not a saving. */
    const removed: string[] = []
    const fs = {
      exists: () => Promise.resolve(false),
      remove: (path: string) => {
        removed.push(path)
        return Promise.reject(new Error('ENOENT: no such file'))
      },
    } as unknown as IndexFs

    await expect(purgeForeign(fs, queueOf(), LANE, BOOK, PERSON, NOTED)).resolves.toBeUndefined()
    expect(removed).toEqual([])
  })

  it('tells the open book even when there was nothing to remove', async () => {
    /* ⚠️ **THE NOTIFICATION IS THE SEAM'S WHOLE ANSWER** to "a share arriving
       or leaving mid-session can neither appear nor disappear". A purge that
       removed the file and said nothing would leave the passages on screen
       until some unrelated redraw. */
    const told = vi.fn()
    await purgeForeign(fsWith(), queueOf(), LANE, BOOK, PERSON, told)
    expect(told).toHaveBeenCalledTimes(1)
  })
})

describe('the fetch driver, as the capability runs it — WI-23.A2', () => {
  /* ⚠️ **THE PULL-ON-OPEN FALSIFIER, AT THE LEVEL A BOOK CAN REACH.** The
     cadence module has no input a book could touch; this proves the
     capability gives it none either — the library's own change feed, which
     an open moves, is not something `start` subscribes the driver to. */
  const started = (info = vi.fn()) => {
    const listeners = new Set<() => void>()
    const library = {
      getSnapshot: () => [],
      lane: (id: string) => id,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const disposable = circle.start!(
      {
        onCleanup: () => {},
        services: { hashes: () => null, fs: fsWith(), library, writes: queueOf(), clock: () => 'stamp' },
        diagnostics: { info, warn: vi.fn(), error: vi.fn(), child: () => ({}) },
      } as never,
      new AbortController().signal,
    ) as { dispose(): void }
    return { disposable, info, open: () => listeners.forEach((one) => one()) }
  }

  it('runs no round in the ten seconds after a book is opened', async () => {
    vi.useFakeTimers()
    try {
      const { disposable, info, open } = started()
      await vi.advanceTimersByTimeAsync(5_000)
      /* "open a book": the library publishes a change (`openedAt` moved). */
      open()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(info).not.toHaveBeenCalled()
      disposable.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs a round on the cadence, reports it, and asks nobody with no peer', async () => {
    vi.useFakeTimers()
    try {
      const { disposable, info } = started()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(info).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledWith('circle.fetch', expect.objectContaining({ asked: 0, calls: 0, accepted: 0 }))
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(info).toHaveBeenCalledTimes(2)
      disposable.dispose()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(info).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs no driver at all on a composition with no filesystem', async () => {
    vi.useFakeTimers()
    try {
      const info = vi.fn()
      const disposable = circle.start!(
        { onCleanup: () => {}, services: { hashes: () => null, fs: null }, diagnostics: { info, warn: vi.fn(), error: vi.fn(), child: () => ({}) } } as never,
        new AbortController().signal,
      ) as { dispose(): void }
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(info).not.toHaveBeenCalled()
      disposable.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the disposer on the kernel’s stack — round 3 #97', () => {
  it('is registered with onCleanup, and running it takes the run down', () => {
    const cleanups: (() => void)[] = []
    circle.start!(
      { onCleanup: (dispose: () => void) => cleanups.push(dispose), services: { hashes: () => null, fs: fsWith(), library: LIBRARY, writes: queueOf(), clock: () => 'stamp' } } as never,
      new AbortController().signal,
    )
    expect(cleanups).toHaveLength(1)
    const control = () => circle.markControls?.find((one) => one.id === 'circle:share')
    expect((control()?.render({ id: 'm1', bookId: BOOK } as never) as { readonly props: { readonly port: unknown } }).props.port).not.toBeNull()
    cleanups[0]!()
    expect((control()?.render({ id: 'm1', bookId: BOOK } as never) as { readonly props: { readonly port: unknown } }).props.port).toBeNull()
  })
})

describe('a keep queued behind a purge — the admission re-asked inside the lane', () => {
  it('writes nothing for a person the record no longer admits, and still tells the listeners', async () => {
    const fs = fsWith()
    const noted = vi.fn()
    await writeForeign(fs, queueOf(), LANE, BOOK, PERSON, shared([entry()]), noted, () => Promise.resolve(false))
    expect(await fs.exists(circlePathIn(BOOK, PERSON))).toBe(false)
    expect(noted).toHaveBeenCalledTimes(1)
    await writeHeldShelf(fs, queueOf(), PERSON, NOTHING_SHARED, noted, () => Promise.resolve(false))
    expect(await fs.exists(personShelfPathIn(PERSON))).toBe(false)
    await writeHeldList(fs, queueOf(), PERSON, 'aa11', NOTHING_SHARED, noted, () => Promise.resolve(false))
    expect(await fs.exists(personListPathIn(PERSON, 'aa11'))).toBe(false)
  })

  it('asks on the lane, after whatever was queued before it — a purge included', async () => {
    const fs = fsWith({ [circlePathIn(BOOK, PERSON)]: JSON.stringify(shared([entry()])) })
    const order: string[] = []
    const queue = queueOf()
    /* The purge takes the lane first; the keep's question is answered after it ran. */
    const purged = queue.append(LANE(BOOK), async () => {
      order.push('purge')
      await fs.remove(circlePathIn(BOOK, PERSON))
    })
    const kept = writeForeign(fs, queue, LANE, BOOK, PERSON, shared([entry()]), () => {}, () => {
      order.push('asked')
      return Promise.resolve(false)
    })
    await Promise.all([purged, kept])
    expect(order).toEqual(['purge', 'asked'])
    expect(await fs.exists(circlePathIn(BOOK, PERSON))).toBe(false)
  })
})
