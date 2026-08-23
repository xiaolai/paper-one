import { describe, expect, it } from 'vitest'
import { fakeFs } from './fakeFs.testkit'
import { blobWorld, BOOK, CONTENT, deferred, servicesWith, spyRecorder } from './servicesWorld.testkit'
import { createKernelServices } from './services'

/**
 * Everything that writes inside `books/<id>/`, and the one door out of it.
 */

describe('blob deletion shares the folder’s lane', () => {
  it('queues on the same lane as every other writer to that folder', () => {
    const services = servicesWith(spyRecorder().recorder)
    /* Two distinct ids, one directory. */
    expect(services.library.lane('book:a/b')).toBe(services.library.lane('book:a_b'))
  })

  /**
   * AND `removeBlob` ACTUALLY TAKES THAT LANE.
   *
   * The case above compares two lane names and never calls `removeBlob`, so
   * the deletion could go back to queueing on the raw id — which is the
   * regression it is named for — without turning red. `folderOf` is
   * many-to-one, so `book:a/b` and `book:a_b` are two ids over one directory,
   * and a delete on one must wait behind a write on the other.
   */
  it('waits behind a write issued under the other spelling of its folder', async () => {
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
      initialBooks: [{ bookId: 'book:a_b', title: 'X', author: '', openedAt: 1 }],
      recorder: spyRecorder().recorder,
    })

    const writing = services.library.update('book:a_b', (record) => ({ ...record, title: 'Y' }))
    /* The OTHER spelling of the same folder. */
    const removing = services.removeBlob('book:a/b', 'content.epub')
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
