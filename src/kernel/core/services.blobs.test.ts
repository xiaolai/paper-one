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

  /* NO FILESYSTEM, NOTHING TO REMOVE — and still no name outside the set. The
     refusal is the operation's own, filesystem or none. */
  it('is a no-op without a filesystem, and still refuses a name outside the set', async () => {
    const spy = spyRecorder()
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [BOOK], recorder: spy.recorder })
    await expect(services.removeBlob('book_x', 'content.epub')).resolves.toBeUndefined()
    const cause = await services.removeBlob('book_x', 'book.json' as 'cover.jpg').then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('removeBlob: "book.json" is not a blob the kernel removes')
    expect(spy.kinds).toEqual([])
  })

  /* ANOTHER BOOK ON THE SHELF IS NOT A CLAIM ON THIS FOLDER. Only a row whose
     own folder is this one refuses the removal; a shelf with other books in it
     goes through exactly as a shelf with none. */
  it('removes a blob while another book sits on the shelf', async () => {
    const spy = spyRecorder()
    const fs = fakeFs({
      'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }),
      [CONTENT]: 'bytes',
      'books/book_y/book.json': JSON.stringify({ bookId: 'book_y', title: 'Y' }),
    })
    const services = createKernelServices({
      fs,
      storage: null,
      initialBooks: [BOOK, { bookId: 'book_y', title: 'Y', author: '', openedAt: 1 }],
      recorder: spy.recorder,
    })
    await expect(services.removeBlob('book_x', 'content.epub')).resolves.toBeUndefined()
    await services.drain()
    expect(fs.store.has(CONTENT)).toBe(false)
    expect(spy.kinds).toEqual(['content'])
  })

  /* AN ORPHANED FOLDER — no record at all — still has its blob cleared, a cover
     included: there are no facts to take off a record that is not there. */
  it('clears a jacket from a folder that holds no record', async () => {
    const spy = spyRecorder()
    const fs = fakeFs({ 'books/book_gone/cover.jpg': 'jacket' })
    const services = createKernelServices({ fs, storage: null, initialBooks: [], recorder: spy.recorder })
    await expect(services.removeBlob('book_gone', 'cover.jpg')).resolves.toBeUndefined()
    await services.drain()
    expect(fs.store.has('books/book_gone/cover.jpg')).toBe(false)
    expect(spy.kinds).toEqual(['cover'])
  })

  /* PRESENT BUT UNREADABLE IS NOT AN ORPHAN — and nor is a record the read
     calls missing while the folder says it is there. Tauri's fs errors carry no
     code, so "missing" is read off a message; a read that failed in the wrong
     words must not clear a jacket whose facts it could not take off. */
  it('refuses when the read calls the record missing and the folder says it is there', async () => {
    const w = blobWorld()
    const read = w.fs.readFile
    w.fs.readFile = async (path) => {
      if (path === 'books/book_x/book.json') throw new Error(`no such file: ${path}`)
      return read(path)
    }
    const cause = await w.services.removeBlob('book_x', 'cover.jpg').then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('removeBlob: book.json for book_x is there but could not be read')
    await w.services.drain()
    expect(w.fs.store.has('books/book_x/cover.jpg')).toBe(true)
    expect(w.spy.kinds).toEqual([])
  })

  /* A DELETE ANOTHER PROCESS WON IS DONE; one that failed with the file still
     there is not. The exists/remove pair is atomic only against this queue, so
     a remove that finds the file already gone is the ordinary absence — and a
     remove that could not take a file that is still there is the caller's to
     hear, in the disk's own words. */
  it('treats a delete another process already made as done, and raises one that left the file', async () => {
    const won = blobWorld()
    won.fs.remove = async (path) => {
      won.fs.store.delete(path)
      throw new Error(`no such file: ${path}`)
    }
    await expect(won.services.removeBlob('book_x', 'content.epub')).resolves.toBeUndefined()
    await won.services.drain()
    expect(won.spy.kinds).toEqual(['content'])
    expect(won.spy.commits).toHaveLength(1)

    const refused = blobWorld()
    const denied = new Error('permission denied')
    refused.fs.remove = async () => {
      throw denied
    }
    const cause = await refused.services.removeBlob('book_x', 'content.epub').then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBe(denied)
    expect(refused.fs.store.has(CONTENT)).toBe(true)
  })

  /* THE FACTS THE WRITE FINDS, NOT THE FACTS THE CHECK SAW. The record is read
     again where it is written, and something outside this queue can change it
     in between — here, the journal's own `begin`. Facts that no longer name the
     removed jacket are not this removal's to take. */
  it('takes off only facts that still name the jacket when the record is written', async () => {
    const hash = 'ab'.repeat(32)
    const recordAt = 'books/book_x/book.json'
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    for (const [what, replacement, expected] of [
      ['facts that still name it', { name: 'cover.jpg', size: 6, hash }, undefined],
      ['facts for the other name', { name: 'cover.webp', size: 9, hash }, { name: 'cover.webp', size: 9, hash }],
      ['no facts at all', undefined, undefined],
    ] as const) {
      const fs = fakeFs({ 'books/book_x/cover.jpg': 'jacket' })
      fs.store.set(recordAt, encode({ bookId: 'book_x', title: 'X', coverFacts: { name: 'cover.jpg', size: 6, hash } }))
      const services = createKernelServices({
        fs,
        storage: null,
        initialBooks: [BOOK],
        recorder: {
          begin: async (book, kind) => {
            if (kind === 'record') {
              fs.store.set(recordAt, encode({ bookId: 'book_x', title: 'X', ...(replacement ? { coverFacts: replacement } : {}) }))
            }
            return { book, what: kind }
          },
          commit: async () => {},
        },
      })
      await expect(services.removeBlob('book_x', 'cover.jpg'), what).resolves.toBeUndefined()
      await services.drain()
      const written = JSON.parse(new TextDecoder().decode(fs.store.get(recordAt))) as { coverFacts?: unknown }
      expect(written.coverFacts, what).toEqual(expected)
      expect(fs.store.has('books/book_x/cover.jpg'), what).toBe(false)
    }
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

/**
 * `drain`, STAGE BY STAGE — what the window closing waits for.
 *
 * The contract suite holds the two losses it was written for: a tick that
 * landed after its flush, and a failed flush abandoning the stages after it.
 * These hold what it raises and when it lets go: one failure as itself, several
 * as one error naming each — both index flushes among them — and not before a
 * write that arrived during its last flush has landed.
 */
describe('drain, stage by stage', () => {
  /* A FLAT STORE WITH NOTHING TO FLUSH IS NOT A FAILED STAGE. `flush` is
     optional on the storage the composition hands in — a browser's
     `localStorage` has none — and asking for one that is not there must not
     turn the last stage of a shutdown into an error. */
  it('lets go of a flat store that has no flush', async () => {
    const services = createKernelServices({ fs: null, storage: { getItem: () => null, setItem: () => {} }, initialBooks: [] })
    await expect(services.drain()).resolves.toBeUndefined()
  })

  it('raises a single stage that failed as that failure itself', async () => {
    const refused = new Error('the flat store would not flush')
    const storage = {
      getItem: () => null,
      setItem: () => {},
      flush: async () => {
        throw refused
      },
    }
    const services = createKernelServices({ fs: null, storage, initialBooks: [] })
    const cause = await services.drain().then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBe(refused)
  })

  /* BOTH FLUSHES ARE TRIED, AND BOTH ARE COUNTED. The index is flushed before
     the idle and again after it; an index that will not write fails each, and
     the flat store's refusal is a third. */
  it('raises several failed stages as one error that names each, in order', async () => {
    const fs = fakeFs({ 'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }) })
    const write = fs.writeFile
    fs.writeFile = async (path, bytes) => {
      if (path.startsWith('index.json')) throw new Error('the index would not write')
      return write(path, bytes)
    }
    const refused = new Error('the flat store would not flush')
    const services = createKernelServices({
      fs,
      storage: {
        getItem: () => null,
        setItem: () => {},
        flush: async () => {
          throw refused
        },
      },
      initialBooks: [BOOK],
    })
    await services.library.rememberPosition('book_x', 'epubcfi(/6/4!/4/2/1:0)', 0.6)
    const cause = await services.drain().then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(AggregateError)
    expect((cause as AggregateError).errors.at(-1)).toBe(refused)
    expect((cause as AggregateError).message).toBe(
      'drain: 3 stages failed — the index would not write; the index would not write; the flat store would not flush',
    )
  })

  /* NOT BEFORE THE QUEUE IS IDLE AGAIN. A write that arrives while the last
     flush is writing the index — the reader's final handover, say — is on the
     queue when that flush returns, and a drain that let go then would close
     the window over it. */
  it('lets go only once a write that arrived during its last flush has landed', async () => {
    const w = blobWorld()
    const write = w.fs.writeFile
    /* The late write takes a turn of the event loop to land, so a drain that
       did not wait for the queue again would already have let go. */
    const slow = deferred()
    let arrived: Promise<void> | null = null
    w.fs.writeFile = async (path, bytes) => {
      if (arrived === null && path.startsWith('index.json')) {
        arrived = w.services.library.update('book_x', (record) => ({ ...record, title: 'Handed over' }))
        setTimeout(() => slow.open(), 0)
      } else if (arrived !== null && path.startsWith('books/book_x/book.json')) {
        await slow.promise
      }
      return write(path, bytes)
    }
    /* A tick on the queue, not awaited: it lands during the drain's first idle,
       so the index is dirty only for the SECOND flush — the one whose write
       lets the late arrival in. */
    const tick = w.services.library.rememberPosition('book_x', 'epubcfi(/6/4!/4/2/1:0)', 0.5)
    await w.services.drain()
    const title = (JSON.parse(new TextDecoder().decode(w.fs.store.get('books/book_x/book.json'))) as { title?: string }).title
    expect(arrived, 'nothing arrived during the flush, so this proves nothing').not.toBeNull()
    expect(title, 'the drain let go with a write still on the queue').toBe('Handed over')
    await tick
    await arrived
  })
})
