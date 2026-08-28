import { describe, expect, it } from 'vitest'
import type { IndexedBook } from './bookIndex'
import { fakeFs } from './fakeFs.testkit'
import { blobWorld, BOOK, CONTENT, deferred, servicesWith, spyRecorder } from './servicesWorld.testkit'
import { REMOVABLE_BLOB_KINDS } from './ports'
import { createKernelServices } from './services'

/**
 * Everything that writes inside `books/<id>/`, and the one door out of it.
 */

describe('blob deletion and the folder it names', () => {
  const OTHER: IndexedBook = { bookId: 'book:a_b', title: 'X', author: '', openedAt: 1 }

  it('queues on the same lane as every other writer to that folder', () => {
    const services = servicesWith(spyRecorder().recorder)
    /* Two distinct ids, one directory. */
    expect(services.library.lane('book:a/b')).toBe(services.library.lane('book:a_b'))
  })

  /**
   * ⚠️ AND THAT COLLISION IS REFUSED, NOT MERELY SERIALISED.
   *
   * `folderOf` sanitises an id into `books/<safeId>` — every character outside
   * [A-Za-z0-9] becomes `_` — so it stops traversal and does NOT stop
   * collision: `book:a/b` and `book:a_b` are two ids over one directory. A
   * caller holding the first could delete the second's content or its jacket,
   * and every check in `removeBlob` passed it. Sharing a lane made that
   * orderly; it did not make it right.
   *
   * The shelf is the authority on which id owns a folder.
   */
  it('refuses an id whose folder belongs to a different book on the shelf', async () => {
    const fs = fakeFs({
      'books/book_a_b/book.json': JSON.stringify({ bookId: 'book:a_b', title: 'X' }),
      'books/book_a_b/content.epub': 'bytes',
    })
    const spy = spyRecorder()
    const services = createKernelServices({
      fs,
      storage: null,
      initialBooks: [OTHER],
      recorder: spy.recorder,
    })

    await expect(services.removeBlob('book:a/b', 'content.epub')).rejects.toThrow(/does not own/)
    await services.drain()
    expect(fs.store.has('books/book_a_b/content.epub'), 'another book’s bytes were taken').toBe(true)
    expect(spy.kinds).toEqual([])
    /* And the book that DOES own it is still served. */
    await services.removeBlob('book:a_b', 'content.epub')
    await services.drain()
    expect(fs.store.has('books/book_a_b/content.epub')).toBe(false)
  })

  /* ⚠️ **AND THE OWNER IS READ INSIDE THE LANE.** The shelf was consulted
     before the queue was joined, which is a check-then-act across a lane
     boundary: the restore below is already queued for this folder when the
     deletion is asked for, and it publishes its row only when it runs. Judged
     on the snapshot from a moment earlier, the delete took the bytes of a book
     that had just come back. */
  it('refuses a folder claimed by a write already queued when the deletion arrives', async () => {
    const fs = fakeFs({
      'trash/book_a_b/book.json': JSON.stringify({ bookId: 'book:a_b', title: 'X' }),
      'trash/book_a_b/content.epub': 'bytes',
    })
    const services = createKernelServices({ fs, storage: null, initialBooks: [], recorder: spyRecorder().recorder })

    // The shelf is EMPTY here, so a check made now sees an unowned folder.
    const restoring = services.library.restore('book:a_b')
    const removing = services.removeBlob('book:a/b', 'content.epub')

    expect(await restoring).toEqual({ state: 'restored' })
    await expect(removing).rejects.toThrow(/does not own/)
    await services.drain()
    expect(fs.store.has('books/book_a_b/content.epub'), 'the restored book’s bytes were taken').toBe(true)
  })

  /* An id the shelf does not hold at all is an already-removed book, and
     absence is this operation's documented no-op — refusing it would turn a
     removal racing an eviction into an error for a caller doing the right
     thing. Only a folder owned by a DIFFERENT live book is refused. */
  it('leaves a book that is no longer on the shelf as an ordinary no-op', async () => {
    const fs = fakeFs({ 'books/book_gone/content.epub': 'bytes' })
    const services = createKernelServices({ fs, storage: null, initialBooks: [], recorder: spyRecorder().recorder })
    await expect(services.removeBlob('book_gone', 'content.epub')).resolves.toBeUndefined()
    await services.drain()
    expect(fs.store.has('books/book_gone/content.epub')).toBe(false)
  })

  /**
   * AND `removeBlob` ACTUALLY TAKES THE FOLDER'S LANE.
   *
   * The lane case above compares two names and never calls `removeBlob`, so
   * the deletion could go back to queueing somewhere else without turning it
   * red. A delete must wait behind a write to the same folder: the exists/
   * remove pair is atomic only against this queue.
   */
  it('waits behind a write already in flight to its folder', async () => {
    const order: string[] = []
    const gate = deferred()
    const fs = fakeFs({
      'books/book_a_b/book.json': JSON.stringify({ bookId: 'book:a_b', title: 'X' }),
      'books/book_a_b/content.epub': 'bytes',
    })
    const slow = {
      ...fs,
      writeFile: async (path: string, bytes: Uint8Array) => {
        order.push('write:start')
        await gate.promise
        order.push('write:end')
        return fs.writeFile(path, bytes)
      },
      remove: async (path: string) => {
        order.push('remove')
        return fs.remove(path)
      },
    }
    const services = createKernelServices({
      fs: slow,
      storage: null,
      initialBooks: [OTHER],
      recorder: spyRecorder().recorder,
    })

    const writing = services.library.update('book:a_b', (record) => ({ ...record, title: 'Y' }))
    const removing = services.removeBlob('book:a_b', 'content.epub')
    await Promise.resolve()
    gate.open()
    await Promise.all([writing, removing])
    await services.drain()

    expect(
      order.indexOf('remove'),
      'the delete entered the folder before the write had left it',
    ).toBeGreaterThan(order.indexOf('write:end'))
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
   * ⚠️ AND THE NO-OP JOURNALS NOTHING.
   *
   * The bracket used to open before the existence check, so removing a blob
   * that was already gone wrote a committed mutation for a change that did not
   * happen: the journal advanced, the feed carried an entry, and the next
   * unclean-shutdown verify pass had one more surface to digest — for a file
   * nobody touched. Both the second remove above and evicting a book whose
   * bytes a peer had already taken did exactly this.
   */
  it('journals nothing when the blob is already gone', async () => {
    const w = blobWorld()
    await w.services.removeBlob('book_x', 'content.epub')
    await w.services.drain()
    expect(w.spy.kinds, 'the real removal was not journalled, so this proves nothing').toEqual([
      'content',
    ])

    await w.services.removeBlob('book_x', 'content.epub')
    await w.services.drain()
    expect(w.spy.kinds, 'a removal that removed nothing opened a bracket').toEqual(['content'])
    expect(w.spy.commits).toHaveLength(1)
  })

  /* The SURFACE follows the name, from one map — see `REMOVABLE_BLOB_KINDS`.
     The classification used to be written out a second time in `removeBlob`,
     so a removable cover name added to the closed set would have been
     journalled as `content` and told every peer the BYTES had changed. */
  it('journals every removable name under the surface the map gives it', async () => {
    for (const [name, kind] of Object.entries(REMOVABLE_BLOB_KINDS)) {
      const spy = spyRecorder()
      const path = `books/book_x/${name}`
      const fs = fakeFs({
        'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }),
        [path]: 'bytes',
      })
      const services = createKernelServices({
        fs,
        storage: null,
        initialBooks: [BOOK],
        recorder: spy.recorder,
      })
      await services.removeBlob('book_x', name as 'cover.jpg')
      await services.drain()
      expect(fs.store.has(path), name).toBe(false)
      expect(spy.kinds, name).toEqual([kind])
    }
  })

  /**
   * TWO REMOVALS OF THE SAME FILE DO NOT INTERLEAVE.
   *
   * Both run on the book's own lane, so the exists-and-delete pair cannot be
   * separated by the other — which is what would let one report success over
   * a file the other had already taken, or leave one bracket open.
   */
  it('serialises two removals of the same blob', async () => {
    /* ORDERED, NOT COUNTED. Matching begin and commit totals is satisfied by
       fully interleaved work — both begins, then both commits — which is
       exactly the state this is meant to rule out. The critical section is
       observed instead: the second removal cannot enter it before the first
       has left. */
    const order: string[] = []
    const gate = deferred()
    const spy = spyRecorder()
    const base = fakeFs({
      'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }),
      [CONTENT]: 'bytes',
    })
    let entered = 0
    const fs = {
      ...base,
      exists: async (path: string) => {
        if (path === CONTENT) {
          entered += 1
          order.push(`enter:${entered}`)
          if (entered === 1) await gate.promise
          order.push(`leave:${entered}`)
        }
        return base.exists(path)
      },
    }
    const services = createKernelServices({ fs, storage: null, initialBooks: [BOOK], recorder: spy.recorder })

    const both = Promise.all([
      services.removeBlob('book_x', 'content.epub'),
      services.removeBlob('book_x', 'content.epub'),
    ])
    await Promise.resolve()
    gate.open()
    await both
    await services.drain()

    expect(base.store.has(CONTENT)).toBe(false)
    /* The first pair closes before the second opens. Interleaved, this reads
       `enter:1, enter:2, …`. */
    expect(order.slice(0, 2)).toEqual(['enter:1', 'leave:1'])
    /* And still: every begin matched by a commit, nothing left open. */
    expect(spy.commits).toHaveLength(spy.kinds.length)
  })

  /* A NAME OUTSIDE THE CLOSED SET IS REFUSED, and the record is not a blob:
   * `book.json` is the book as far as the shelf is concerned. */
  it('refuses anything outside the closed set, including the record', async () => {
    const w = blobWorld()
    /* THE WHOLE FILESYSTEM, BEFORE AND AFTER. Checking only that `book.json`
       survived would pass a refusal that deleted a DIFFERENT blob on its way
       to throwing — and "it threw" is not the property; "it changed nothing"
       is. */
    const before = [...w.fs.store.keys()].sort()
    for (const bad of ['book.json', 'marks.json', 'content.exe', 'cover.png', '../../etc/passwd', '']) {
      await expect(w.services.removeBlob('book_x', bad as 'cover.jpg'), bad).rejects.toThrow(/blob|name|closed/i)
      expect([...w.fs.store.keys()].sort(), `${bad} changed the tree`).toEqual(before)
    }
    expect(w.spy.kinds).toEqual([])
  })
})
