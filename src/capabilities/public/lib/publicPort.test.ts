import { describe, expect, it, vi } from 'vitest'
import { MAX_BOOKS_WITH_PUBLIC, folderForFetch, type IndexedBook, type Library } from '../../../kernel'
import type { SharedBook, SharePort, ShareService } from '../../peer'
import { publicPortOver } from './publicPort'

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

/** A library that records the refreshes it was asked for. */
function libraryOf(books: readonly IndexedBook[]): Library & { readonly refreshed: string[] } {
  const refreshed: string[] = []
  const listeners = new Set<() => void>()
  return {
    refreshed,
    getSnapshot: () => books,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refreshContent: (bookId: string) => {
      refreshed.push(bookId)
      return Promise.resolve()
    },
    /** Only for tests that want to see a library change reach the pane. */
    fire: () => {
      for (const listener of [...listeners]) listener()
    },
  } as unknown as Library & { readonly refreshed: string[] }
}

/** A share port that records what it was told, and offers nothing to start. */
function fakeShare(): SharePort & {
  readonly offers: { folder: string; name: string; hash: string }[]
  readonly notes: string[]
  readonly withdrawals: { hash: string; service: ShareService }[]
  readonly fetches: { hash: string; folder: string; name: string }[]
  rows: SharedBook[]
} {
  const offers: { folder: string; name: string; hash: string }[] = []
  const notes: string[] = []
  const withdrawals: { hash: string; service: ShareService }[] = []
  const fetches: { hash: string; folder: string; name: string }[] = []
  const port = {
    offers,
    notes,
    withdrawals,
    fetches,
    rows: [] as SharedBook[],
    offered: () => Promise.resolve(port.rows),
    offerBytes: (folder: string, name: string, hash: string) => {
      offers.push({ folder, name, hash })
      return Promise.resolve()
    },
    offerNotes: (hash: string) => {
      notes.push(hash)
      /* As the real port does: what is offered is what `offered()` then
         reports, which is what any quota is counted from. */
      if (!port.rows.some((one) => one.hash === hash)) port.rows.push({ hash, bytes: false, notes: true, noteCount: 0 })
      return Promise.resolve()
    },
    withdraw: (hash: string, service: ShareService) => {
      withdrawals.push({ hash, service })
      return Promise.resolve()
    },
    publishNote: () => Promise.resolve(1),
    shareId: () => Promise.resolve('fake-share-id'),
    resolve: () => Promise.resolve([]),
    fetch: (hash: string, folder: string, name: string) => {
      fetches.push({ hash, folder, name })
      return Promise.resolve(1)
    },
    /** What a provider will answer with, per hash. Empty means "nobody". */
    fetchable: new Map<string, string[]>(),
    fetchNotes: (hash: string, _providers?: readonly string[], since?: number) => {
      const held = (port as unknown as { fetchable: Map<string, string[]> }).fetchable.get(hash)
      if (held === undefined) return Promise.reject(new Error(`that provider has nothing for ${hash}`))
      const from = since ?? 0
      const records = held.slice(from)
      return Promise.resolve({ records, next: from + records.length, generation: 1, more: false })
    },
  }
  return port
}

/* `Record<string, unknown>` rather than `Partial<IndexedBook>`: under
   `exactOptionalPropertyTypes` a fixture cannot spell "this optional field is
   explicitly absent", and several cases below are exactly about that. */
const book = (over: Record<string, unknown> = {}): IndexedBook =>
  ({ bookId: 'book:1', title: 'A', author: 'B', hasContent: true, ext: 'epub', contentHash: HASH, ...over }) as IndexedBook

describe('forBook', () => {
  it('reports the state and the sentence for a book that cannot be offered', () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ contentHash: undefined })]), () => share, () => {})
    return port.forBook('book:1').then((state) => {
      expect(state?.offerability).toBe('no-content-hash')
      expect(state?.absentBecause).not.toBeNull()
      expect(state?.mayAnnotate).toBe(false)
      expect(state?.hash).toBeNull()
    })
  })

  it('answers null for a book the library does not have', async () => {
    const port = publicPortOver(libraryOf([]), () => fakeShare(), () => {})
    expect(await port.forBook('book:missing')).toBeNull()
  })

  it('carries the two switches and the note count apart', async () => {
    const share = fakeShare()
    share.rows = [{ hash: HASH, bytes: false, notes: true, noteCount: 3 }]
    const port = publicPortOver(libraryOf([book()]), () => share, () => {})
    const state = await port.forBook('book:1')
    expect(state).toMatchObject({ bytes: false, notes: true, noteCount: 3, offerability: 'offerable' })
  })

  /* ⚠️ **"NOTHING WILL BE DELETED" IS THE WRONG ANSWER OVER A FILE WE COULD
     NOT READ.** The count is what the surface uses to tell a reader what
     stopping publication destroys, and an unreadable annotation file reported
     zero — the single most reassuring number, produced by the one case that
     warrants a warning. `null` is a third answer and the surface says it. */
  it('reports an uncountable annotation file as unknown rather than as none', async () => {
    const share = fakeShare()
    share.rows = [{ hash: HASH, bytes: false, notes: true, noteCount: null }]
    const port = publicPortOver(libraryOf([book()]), () => share, () => {})
    const state = await port.forBook('book:1')
    expect(state?.noteCount, 'an unreadable file was reported as "no annotations"').toBeNull()
  })

  it('reports a book with no row at all as none, which is what it is', async () => {
    const share = fakeShare()
    share.rows = []
    const port = publicPortOver(libraryOf([book()]), () => share, () => {})
    const state = await port.forBook('book:1')
    expect(state?.noteCount).toBe(0)
  })

  it('says a book whose bytes are elsewhere may still be annotated', async () => {
    /* ⚠️ **WI-25.9 AT THE SURFACE.** The control that publishes an opinion must
       not be gated on holding a copy. */
    const port = publicPortOver(libraryOf([book({ hasContent: false })]), () => fakeShare(), () => {})
    const state = await port.forBook('book:1')
    expect(state?.offerability).toBe('no-content')
    expect(state?.mayAnnotate).toBe(true)
  })
})

describe('offerBytes', () => {
  it('sends the folder and the content name the vault uses', async () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ ext: 'pdf' })]), () => share, () => {})
    await port.offerBytes('book:1')
    expect(share.offers).toEqual([{ folder: 'book_1', name: 'content.pdf', hash: HASH }])
  })

  it('refuses a book that is not offerable, at the boundary and not only at the button', async () => {
    /* ⚠️ **A CONTROL-ONLY CHECK GETS THIS WRONG.** The two disagree exactly
       when a book loses its bytes between a render and a click. */
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ hasContent: false })]), () => share, () => {})
    await expect(port.offerBytes('book:1')).rejects.toThrow(/does not hold/u)
    expect(share.offers).toEqual([])
  })

  it('refuses a book with no digest rather than offering it under nothing', async () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ contentHash: undefined })]), () => share, () => {})
    await expect(port.offerBytes('book:1')).rejects.toThrow(/fingerprint/u)
    expect(share.offers).toEqual([])
  })

  it('tells its listeners once the offer landed', async () => {
    const share = fakeShare()
    const changed = vi.fn()
    const port = publicPortOver(libraryOf([book()]), () => share, changed)
    const listener = vi.fn()
    port.subscribe(listener)
    await port.offerBytes('book:1')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('offerNotes', () => {
  it('needs the name and not the bytes', async () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ hasContent: false })]), () => share, () => {})
    await port.offerNotes('book:1')
    expect(share.notes).toEqual([HASH])
    expect(share.offers, 'offering notes offered the book').toEqual([])
  })

  it('refuses a book with no digest', async () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ contentHash: undefined })]), () => share, () => {})
    await expect(port.offerNotes('book:1')).rejects.toThrow(/fingerprint/u)
  })
})

describe('importBook — the guard, honoured', () => {
  it('fetches a book nobody here has into a folder of its own', async () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([]), () => share, () => {})
    const plan = await port.importBook(HASH, 'epub')
    expect(plan).toEqual({ kind: 'into-new', folder: folderForFetch(HASH), why: 'no-candidate' })
    expect(share.fetches).toEqual([{ hash: HASH, folder: folderForFetch(HASH), name: 'content.epub' }])
  })

  it('fetches into a held row whose digest agrees and whose bytes are missing', async () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ hasContent: false })]), () => share, () => {})
    expect(await port.importBook(HASH, 'epub')).toEqual({ kind: 'into-held', bookId: 'book:1' })
    expect(share.fetches[0]?.folder).toBe('book_1')
  })

  it('fetches nothing when the exact bytes are here', async () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book()]), () => share, () => {})
    expect(await port.importBook(HASH, 'epub')).toEqual({ kind: 'already-held', bookId: 'book:1' })
    expect(share.fetches).toEqual([])
  })

  it('never writes into a book whose digest disagrees, however it matched', async () => {
    /* ⚠️ **WI-25.4, AT THE ONE PLACE IT CAN ACTUALLY BE BROKEN.** A candidate
       is looked up by `contentHash` alone, so a held book with a different one
       is not a candidate at all — and if it ever became one, the folder would
       still be the staging one. Both halves are asserted. */
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ contentHash: OTHER, hasContent: false })]), () => share, () => {})
    const plan = await port.importBook(HASH, 'epub')
    expect(plan).toEqual({ kind: 'into-new', folder: folderForFetch(HASH), why: 'no-candidate' })
    expect(share.fetches[0]?.folder).not.toBe('book_1')
  })

  it('refuses a format Paper does not store rather than writing it as one', async () => {
    /* A hash carries no format; a default would write a PDF into
       `content.epub` and every reader of `extensionFor` would believe it. */
    const share = fakeShare()
    const port = publicPortOver(libraryOf([]), () => share, () => {})
    await expect(port.importBook(HASH, 'exe')).rejects.toThrow(/does not store/u)
    expect(share.fetches).toEqual([])
  })
})

describe('without a share port', () => {
  it('reads a book’s state and refuses every act', async () => {
    const port = publicPortOver(libraryOf([book()]), () => null, () => {})
    /* Reading still works — a composition with no plugin is a state, not an
       error, and the pane draws the book rather than failing. */
    expect(await port.forBook('book:1')).toMatchObject({ bytes: false, notes: false })
    await expect(port.offerBytes('book:1')).rejects.toThrow(/not available/u)
    await expect(port.offerNotes('book:1')).rejects.toThrow(/not available/u)
    await expect(port.withdraw('book:1', 'bytes')).rejects.toThrow(/not available/u)
    await expect(port.importBook(HASH, 'epub')).rejects.toThrow(/not available/u)
  })
})

describe('importBook and the held book’s format', () => {
  it('refuses a caller’s extension that disagrees with the held record', async () => {
    /* ⚠️ **MEASURED BY AUDIT: FETCHING A KNOWN PDF HASH AS `epub` WROTE
       `content.epub` WHILE THE RECORD STILL OPENED `content.pdf`** — a book
       with two content files, one of which nothing reads. */
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ hasContent: false, ext: 'pdf' })]), () => share, () => {})
    await expect(port.importBook(HASH, 'epub')).rejects.toThrow(/stored as a pdf/u)
    expect(share.fetches).toEqual([])
  })

  it('uses the held record’s format when the caller agrees', async () => {
    const share = fakeShare()
    const port = publicPortOver(libraryOf([book({ hasContent: false, ext: 'pdf' })]), () => share, () => {})
    await port.importBook(HASH, 'pdf')
    expect(share.fetches[0]?.name).toBe('content.pdf')
  })
})

describe('offerNotes and the device-wide book quota', () => {
  it('refuses once as many books as this device will hold already publish', async () => {
    /* ⚠️ **`MAX_BOOKS_WITH_PUBLIC` WAS DECLARED AND NEVER READ**, so the
       claimed device-wide bound did not exist — found by audit. */
    const share = fakeShare()
    share.rows = Array.from({ length: MAX_BOOKS_WITH_PUBLIC }, (_, i) => ({
      hash: `${i}`.padStart(64, '0'),
      bytes: false,
      notes: true,
      noteCount: 1,
    }))
    const port = publicPortOver(libraryOf([book()]), () => share, () => {})
    await expect(port.offerNotes('book:1')).rejects.toThrow(/as many books/u)
    expect(share.notes).toEqual([])
  })

  it('lets a book already publishing carry on', async () => {
    const share = fakeShare()
    share.rows = [
      ...Array.from({ length: MAX_BOOKS_WITH_PUBLIC - 1 }, (_, i) => ({
        hash: `${i}`.padStart(64, '0'),
        bytes: false,
        notes: true,
        noteCount: 1,
      })),
      { hash: HASH, bytes: false, notes: true, noteCount: 3 },
    ]
    const port = publicPortOver(libraryOf([book()]), () => share, () => {})
    await port.offerNotes('book:1')
    expect(share.notes).toEqual([HASH])
  })
})

describe('what a subscriber hears', () => {
  it('hears the library change, not only this port’s own writes', () => {
    /* ⚠️ **EVERYTHING `forBook` REPORTS IS READ OUT OF THE LIBRARY.** A
       fingerprint arriving from the enrichment pass, a content eviction or a
       removal changes this port's answer and used to reach nobody — the open
       pane showed the previous answer until the reader clicked something. */
    const library = libraryOf([book()])
    const port = publicPortOver(library, () => fakeShare(), () => {})
    let told = 0
    const off = port.subscribe(() => {
      told += 1
    })
    ;(library as unknown as { fire: () => void }).fire()
    expect(told).toBe(1)
    /* And it stops hearing when it unsubscribes — a listener left on the
       library after the pane closed would outlive the pane. */
    off()
    ;(library as unknown as { fire: () => void }).fire()
    expect(told).toBe(1)
  })

  it('refreshes the library’s idea of the bytes after a fetch lands', async () => {
    /* ⚠️ **`hasContent` IS CACHED AND THE PLUGIN WRITES BEHIND IT.** Without
       the refresh the row still reported the book as missing its file, so the
       next import fetched the same bytes again, for ever. */
    const library = libraryOf([book({ hasContent: false })])
    const share = fakeShare()
    const port = publicPortOver(library, () => share, () => {})
    await port.importBook(HASH, 'epub', [])
    expect(library.refreshed).toEqual(['book:1'])
  })

  it('lets only one of two concurrent publications take the last slot', async () => {
    /* ⚠️ **A COUNT READ IN ONE `await` AND ACTED ON IN THE NEXT IS NOT A
       QUOTA.** Both calls saw a count under the limit and both published, so
       the device passed a bound it reports as absolute. */
    const share = fakeShare()
    share.rows = Array.from({ length: MAX_BOOKS_WITH_PUBLIC - 1 }, (_, i) => ({
      hash: `${i}`.padStart(64, '0'),
      bytes: false,
      notes: true,
      noteCount: 0,
    }))
    /* ⚠️ **THE WINDOW IS THE ROUND TRIP, SO THE FAKE HAS TO HAVE ONE — AND
       ONE `setTimeout` IS NOT IT.** `offered()` crosses a process boundary in
       production, so two calls can have reads in flight AT THE SAME TIME. A
       fake that answers each read on its own timer does not reproduce that:
       Node drains microtasks between timer callbacks, so the first call
       finishes publishing before the second one's read is even taken, and the
       defect hides. Everything that asks before the answer comes back gets
       the SAME snapshot, which is what a round trip means. */
    let waiting: ((rows: readonly SharedBook[]) => void)[] = []
    share.offered = () =>
      new Promise<readonly SharedBook[]>((resolve) => {
        waiting.push(resolve)
        if (waiting.length > 1) return
        setTimeout(() => {
          const asked = waiting
          waiting = []
          const snapshot = [...share.rows]
          for (const answer of asked) answer(snapshot)
        }, 0)
      })
    const library = libraryOf([book({ bookId: 'book:1', contentHash: HASH }), book({ bookId: 'book:2', contentHash: OTHER })])
    const port = publicPortOver(library, () => share, () => {})
    const both = await Promise.allSettled([port.offerNotes('book:1'), port.offerNotes('book:2')])
    expect(both.filter((one) => one.status === 'fulfilled')).toHaveLength(1)
    expect(share.notes).toHaveLength(1)
  })
})
