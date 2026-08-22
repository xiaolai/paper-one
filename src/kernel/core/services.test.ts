import { describe, expect, it } from 'vitest'
import type { IndexedBook } from './bookIndex'
import { fakeFs } from './fakeFs.testkit'
import type { MutationKind, MutationRecorder, MutationToken } from './ports'
import { createKernelServices } from './services'

/**
 * The bind/unbind contract of the recorder and clock ports (C2).
 *
 * Binding is late — the sync journal arrives after the stores exist — and its
 * disposer must RESTORE the previous target, not leave the stores delegating
 * into a journal that has since closed. These tests drive a real write through
 * the store and watch which recorder it reaches.
 */

function spyRecorder(): { recorder: MutationRecorder; kinds: MutationKind[]; commits: MutationToken[] } {
  const kinds: MutationKind[] = []
  const commits: MutationToken[] = []
  return {
    kinds,
    commits,
    recorder: {
      begin: async (book: string, what: MutationKind): Promise<MutationToken> => {
        kinds.push(what)
        return { book, what }
      },
      commit: async (token: MutationToken) => {
        commits.push(token)
      },
    },
  }
}

const BOOK: IndexedBook = { bookId: 'book_x', title: 'X', author: '', openedAt: 1 }

function servicesWith(defaultRecorder: MutationRecorder) {
  const fs = fakeFs({ 'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }) })
  return createKernelServices({ fs, storage: null, initialBooks: [BOOK], recorder: defaultRecorder })
}

describe('bindRecorder / bindClock disposers', () => {
  it('restores the default recorder on dispose, so no write reaches a torn-down journal', async () => {
    const base = spyRecorder()
    const journal = spyRecorder()
    const services = servicesWith(base.recorder)

    const unbind = services.bindRecorder(journal.recorder)
    await services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await services.drain()
    expect(journal.kinds).toEqual(['record'])
    expect(base.kinds).toEqual([])

    unbind.dispose()
    await services.library.update('book_x', (record) => ({ ...record, title: 'B' }))
    await services.drain()
    // The write after unbind reaches the DEFAULT, never the unbound journal.
    expect(journal.kinds).toEqual(['record'])
    expect(base.kinds).toEqual(['record'])
  })

  it('frees the slot so the services can be bound again (re-composition)', async () => {
    const services = servicesWith(spyRecorder().recorder)
    const first = services.bindRecorder(spyRecorder().recorder)
    expect(() => services.bindRecorder(spyRecorder().recorder)).toThrow(/already bound/)
    first.dispose()
    expect(() => services.bindRecorder(spyRecorder().recorder)).not.toThrow()
  })

  it('dispose is idempotent and identity-guarded — an old disposer cannot unbind a newer target', async () => {
    const base = spyRecorder()
    const services = servicesWith(base.recorder)
    const first = services.bindRecorder(spyRecorder().recorder)
    first.dispose()
    const second = spyRecorder()
    services.bindRecorder(second.recorder)
    // The stale disposer fires again; it must not touch the new binding.
    first.dispose()
    await services.library.update('book_x', (record) => ({ ...record, title: 'C' }))
    await services.drain()
    expect(second.kinds).toEqual(['record'])
    expect(base.kinds).toEqual([])
  })

  it('bindClock returns a disposer that frees the slot', () => {
    const services = servicesWith(spyRecorder().recorder)
    const unbind = services.bindClock(() => '000000000000-0000-0000000000000000' as never)
    expect(() => services.bindClock(() => '000000000000-0000-0000000000000000' as never)).toThrow(/already bound/)
    unbind.dispose()
    expect(() => services.bindClock(() => '000000000000-0000-0000000000000000' as never)).not.toThrow()
  })
})

/**
 * A COMMIT MUST NEVER REACH A JOURNAL THAT DID NOT ISSUE ITS BEGIN.
 *
 * An unbind between begin and commit was already handled: the commit falls to
 * the default, the old journal keeps a dangling begin, and launch recovery
 * settles it because it cannot tell that from a crash. A REBIND was not.
 * Every capability reload unbinds and binds again, so "resolve the current
 * slot" handed the NEW journal a token it never issued — rejected, after the
 * file write had already happened, leaving a durable unjournalled mutation
 * and a write failure for something that did not fail.
 */
describe('a bracket that spans a rebind', () => {
  it('sends the commit to the default, not to the journal bound since', async () => {
    const base = spyRecorder()
    const second = spyRecorder()
    const services = servicesWith(base.recorder)

    /* The rebind happens INSIDE `begin`, which is the only way to hold a
     * bracket open across it without exposing the port: the store has already
     * called begin and has not yet called commit. */
    let unbind: { dispose(): void } | null = null
    const first: MutationRecorder = {
      begin: async (book: string, what: MutationKind): Promise<MutationToken> => {
        unbind?.dispose()
        services.bindRecorder(second.recorder)
        return { book, what }
      },
      commit: async () => {
        throw new Error('the issuing journal has closed and must not be committed to')
      },
    }
    unbind = services.bindRecorder(first)

    await services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await services.drain()

    /* The journal bound during the bracket must not have seen a token it
     * never issued. */
    expect(second.commits).toEqual([])
    /* It went to the default — where an unbind already sent it. */
    expect(base.commits).toHaveLength(1)
  })

  it('still commits to the same journal when nothing rebound', async () => {
    const base = spyRecorder()
    const journal = spyRecorder()
    const services = servicesWith(base.recorder)
    services.bindRecorder(journal.recorder)

    await services.library.update('book_x', (record) => ({ ...record, title: 'B' }))
    await services.drain()
    expect(journal.commits).toHaveLength(1)
    expect(base.commits).toEqual([])
  })
})

describe('blob deletion shares the folder’s lane', () => {
  it('queues on the same lane as every other writer to that folder', () => {
    const services = servicesWith(spyRecorder().recorder)
    /* Two distinct ids, one directory. */
    expect(services.library.lane('book:a/b')).toBe(services.library.lane('book:a_b'))
  })
})

/* A blob deletion CHANGES THE FOLDER, so it has to reach the journal like
 * every other folder mutation. It did not: a crash between the unlink and
 * whatever the caller did next left the bytes gone with no entry saying so —
 * invisible to the feed and to the unclean-shutdown verify pass. */
describe('blob deletion is journalled', () => {
  it('brackets a content delete as a `content` mutation', async () => {
    const journal = spyRecorder()
    const services = servicesWith(spyRecorder().recorder)
    services.bindRecorder(journal.recorder)
    await services.removeBlob('book_x', 'content.epub')
    await services.drain()
    expect(journal.kinds).toEqual(['content'])
  })

  it('brackets a cover delete as a `cover` mutation', async () => {
    const journal = spyRecorder()
    const services = servicesWith(spyRecorder().recorder)
    services.bindRecorder(journal.recorder)
    await services.removeBlob('book_x', 'cover.webp')
    await services.drain()
    expect(journal.kinds).toEqual(['cover'])
  })
})

/**
 * A REBIND THAT LANDS MID-WRITE.
 *
 * The cases above switch recorders BETWEEN completed writes, which is the easy
 * half. The hard half is the one the app actually does: the sync capability
 * binds during startup and unbinds during teardown, both while the write queue
 * may hold work — so a bracket can be OPENED against one recorder and closed
 * after the slot has moved.
 *
 * A commit routed to whichever recorder is current at commit time closes a
 * bracket the new one never opened, and leaves the old one's begin dangling
 * forever. A dangling begin is what the journal reads as an unfinished write
 * on every open, which is what drives recovery and the verify pass.
 */
describe('a recorder rebound while a write is in flight', () => {
  /** A recorder whose `begin` waits until the test lets it through. */
  function gated(): {
    recorder: MutationRecorder
    kinds: MutationKind[]
    commits: MutationToken[]
    began: Promise<void>
    release: () => void
  } {
    const kinds: MutationKind[] = []
    const commits: MutationToken[] = []
    let announce = (): void => {}
    let open = (): void => {}
    const began = new Promise<void>((resolve) => {
      announce = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      open = resolve
    })
    return {
      kinds,
      commits,
      began,
      release: () => open(),
      recorder: {
        begin: async (book: string, what: MutationKind): Promise<MutationToken> => {
          kinds.push(what)
          announce()
          await waiting
          return { book, what }
        },
        commit: async (token: MutationToken) => {
          commits.push(token)
        },
      },
    }
  }

  it('commits to the recorder that opened the bracket, not the one bound now', async () => {
    const first = gated()
    const second = spyRecorder()
    const services = servicesWith(spyRecorder().recorder)
    const unbind = services.bindRecorder(first.recorder)

    /* The write starts, and its `begin` is held open. */
    const writing = services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await first.began

    /* The journal is torn down and another bound WHILE the bracket is open —
     * exactly what a capability restart does. */
    unbind.dispose()
    services.bindRecorder(second.recorder)

    first.release()
    await writing
    await services.drain()

    /* THE BEGIN WENT TO THE RECORDER THAT WAS BOUND. */
    expect(first.kinds).toEqual(['record'])

    /* AND THE COMMIT REACHES NEITHER — it falls through to the default.
     *
     * This is `services.ts`'s documented choice, and it is written down here
     * because the cost was not: the old journal keeps a DANGLING BEGIN, and a
     * dangling begin is indistinguishable from a crash. So the NEXT open of
     * that library runs recovery and the unclean-shutdown verify pass for a
     * write that in fact completed — once, not forever: `recoverDangling`
     * commits the exact begin and the following clean close clears the flag
     * (`journal.test.ts`, "#5 close keeps the dirty flag"). The cost is one
     * verify pass, which on a large shelf is one digest per tracked surface
     * before the first paint, and it is paid on an ORDINARY restart rather
     * than on a crash.
     *
     * The alternative it rejects is worse in a different way: committing to
     * whatever is bound NOW hands a newly bound journal a token it never
     * issued, which it refuses — and the data write has already landed, so the
     * refusal reports a failure for something that did not fail.
     *
     * Pinned rather than argued about. If the routing changes, this is the
     * assertion that says which of the three outcomes was chosen. */
    expect(first.commits).toEqual([])
    expect(second.kinds).toEqual([])
    expect(second.commits).toEqual([])
  })

  it('sends the NEXT write to the recorder bound now', async () => {
    const first = spyRecorder()
    const second = spyRecorder()
    const services = servicesWith(spyRecorder().recorder)
    const unbind = services.bindRecorder(first.recorder)
    await services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await services.drain()

    unbind.dispose()
    services.bindRecorder(second.recorder)
    await services.library.update('book_x', (record) => ({ ...record, title: 'B' }))
    await services.drain()

    expect(first.kinds).toEqual(['record'])
    expect(second.kinds).toEqual(['record'])
  })
})

/**
 * `removeBlob` — THE ONE DOOR INTO `books/<id>/`.
 *
 * The existing cases cover the nominal names and a traversal attempt. What
 * they do not cover is what happens when the file is not there, when two
 * removals race, and whether the delete is bracketed at all — a delete that
 * reached disk without a journal entry could never replicate, which is the
 * defect this whole phase existed to remove.
 */
describe('removeBlob', () => {
  const CONTENT = 'books/book_x/content.epub'

  function blobWorld() {
    const spy = spyRecorder()
    const fs = fakeFs({
      'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }),
      [CONTENT]: 'bytes',
      'books/book_x/cover.jpg': 'jacket',
    })
    const services = createKernelServices({ fs, storage: null, initialBooks: [BOOK], recorder: spy.recorder })
    return { fs, services, spy }
  }

  it('brackets the delete, so it can replicate', async () => {
    const w = blobWorld()
    await w.services.removeBlob('book_x', 'content.epub')
    await w.services.drain()
    expect(w.fs.store.has(CONTENT)).toBe(false)
    /* A CONTENT surface, not a record one: the kind decides which key the
     * journal tracks and therefore what a peer is told changed. */
    expect(w.spy.kinds).toEqual(['content'])
    expect(w.spy.commits).toHaveLength(1)
  })

  it('brackets a cover under the cover surface, not content', async () => {
    const w = blobWorld()
    await w.services.removeBlob('book_x', 'cover.jpg')
    await w.services.drain()
    expect(w.spy.kinds).toEqual(['cover'])
  })

  /* REMOVING WHAT IS NOT THERE IS DONE, not an error — which is what makes a
   * retry safe after a partial failure. */
  it('is idempotent', async () => {
    const w = blobWorld()
    await w.services.removeBlob('book_x', 'content.epub')
    await expect(w.services.removeBlob('book_x', 'content.epub')).resolves.toBeUndefined()
    await w.services.drain()
    expect(w.fs.store.has(CONTENT)).toBe(false)
  })

  /**
   * TWO REMOVALS OF THE SAME FILE DO NOT INTERLEAVE.
   *
   * Both run on the book's own lane, so the exists-and-delete pair cannot be
   * separated by the other — which is what would let one report success over
   * a file the other had already taken, or leave one bracket open.
   */
  it('serialises two removals of the same blob', async () => {
    const w = blobWorld()
    await Promise.all([w.services.removeBlob('book_x', 'content.epub'), w.services.removeBlob('book_x', 'content.epub')])
    await w.services.drain()
    expect(w.fs.store.has(CONTENT)).toBe(false)
    /* Every begin matched by a commit — nothing left open. */
    expect(w.spy.commits).toHaveLength(w.spy.kinds.length)
  })

  /* A NAME OUTSIDE THE CLOSED SET IS REFUSED, and the record is not a blob:
   * `book.json` is the book as far as the shelf is concerned. */
  it('refuses anything outside the closed set, including the record', async () => {
    const w = blobWorld()
    for (const bad of ['book.json', 'marks.json', 'content.exe', 'cover.png', '../../etc/passwd', '']) {
      await expect(w.services.removeBlob('book_x', bad as 'cover.jpg'), bad).rejects.toThrow()
    }
    expect(w.fs.store.has('books/book_x/book.json')).toBe(true)
    expect(w.spy.kinds).toEqual([])
  })
})
