import { describe, expect, it, vi } from 'vitest'
import { fakeFs } from './fakeFs.testkit'
import { MAX_COVER_BYTES, createCoverFactsPass, measureCover, publishableCover } from './coverFacts'
import type { BookRecord } from './bookFolder'

const port = (size = 12) => ({ hashFile: vi.fn((_folder: string, _name: string) => Promise.resolve({ blake3: 'ab'.repeat(32), size })) })

describe('measuring a jacket — WI-23.C5', () => {
  it('hashes cover.jpg by the folder’s segment, falls back to the legacy name, and answers null with no jacket', async () => {
    const hashes = port()
    expect(await measureCover(fakeFs({ 'books/book_a/cover.jpg': 'j' }), hashes, 'book:a')).toEqual({ name: 'cover.jpg', size: 12, hash: 'ab'.repeat(32) })
    expect(hashes.hashFile).toHaveBeenCalledWith('book_a', 'cover.jpg')
    expect(await measureCover(fakeFs({ 'books/book_a/cover.webp': 'j' }), hashes, 'book:a')).toMatchObject({ name: 'cover.webp' })
    expect(await measureCover(fakeFs(), hashes, 'book:a')).toBeNull()
  })

  it('is publishable only when measured and within the bound — at both ends', () => {
    expect(publishableCover({})).toBeUndefined()
    expect(publishableCover({ coverFacts: { name: 'cover.jpg', size: MAX_COVER_BYTES, hash: 'ab'.repeat(32) } })).toBe('ab'.repeat(32))
    expect(publishableCover({ coverFacts: { name: 'cover.jpg', size: MAX_COVER_BYTES + 1, hash: 'ab'.repeat(32) } })).toBeUndefined()
    expect(publishableCover({ coverFacts: { name: 'cover.jpg', size: 1, hash: 'ab'.repeat(32) } })).toBe('ab'.repeat(32))
    /* An empty jacket is one no friend can fetch: the protocol refuses a
       zero-sized answer. Advertising its digest offers a cover that fails. */
    expect(publishableCover({ coverFacts: { name: 'cover.jpg', size: 0, hash: 'ab'.repeat(32) } })).toBeUndefined()
  })
})

describe('the pass over the library', () => {
  function world(files: Record<string, string>, rows: readonly { bookId: string; coverFacts?: BookRecord['coverFacts'] }[], hashes: ReturnType<typeof port> | null = port()) {
    const held: { bookId: string; coverFacts?: NonNullable<BookRecord['coverFacts']> }[] = rows.map((row) => (row.coverFacts ? { bookId: row.bookId, coverFacts: row.coverFacts } : { bookId: row.bookId }))
    const fs = fakeFs(files)
    /* The store's `updateAfter`, as the fake: the hook is asked over the same fs, and a refusal writes nothing. */
    const updateAfter = vi.fn(async (bookId: string, hooks: { before: (target: { exists(path: string): Promise<boolean> }, live: string) => Promise<'go' | 'refuse'> }, change: (record: BookRecord) => BookRecord) => {
      if ((await hooks.before(fs, bookId)) === 'refuse') return
      const at = held.findIndex((row) => row.bookId === bookId)
      held[at] = change(held[at] as unknown as BookRecord) as unknown as (typeof held)[number]
    })
    const pass = createCoverFactsPass({ fs, library: { getSnapshot: () => held, updateAfter }, hashes: () => hashes, batch: 2 })
    return { pass, held, update: updateAfter, updateAfter, hashes, fs }
  }

  it('stamps a batch of unmeasured jackets, leaves the measured alone, and converges to nothing', async () => {
    const w = world(
      { 'books/book_a/cover.jpg': 'a', 'books/book_b/cover.jpg': 'b', 'books/book_c/cover.webp': 'c', 'books/book_d/cover.jpg': 'd' },
      [{ bookId: 'book:a' }, { bookId: 'book:b' }, { bookId: 'book:c' }, { bookId: 'book:d', coverFacts: { name: 'cover.jpg', size: 1, hash: 'ff'.repeat(32) } }],
    )
    expect(await w.pass.runOnce()).toBe(2)
    expect(await w.pass.runOnce()).toBe(1)
    expect(await w.pass.runOnce()).toBe(0)
    expect(w.held.map((row) => row.coverFacts?.name)).toEqual(['cover.jpg', 'cover.jpg', 'cover.webp', 'cover.jpg'])
    /* The measured one was never re-hashed. */
    expect(w.hashes!.hashFile).toHaveBeenCalledTimes(3)
  })

  it('does not look twice at a book with no jacket, nor at one the port refused', async () => {
    const hashes = port()
    hashes.hashFile.mockRejectedValueOnce(new Error('unreadable'))
    const w = world({ 'books/book_a/cover.jpg': 'a' }, [{ bookId: 'book:a' }, { bookId: 'book:none' }], hashes)
    expect(await w.pass.runOnce()).toBe(0)
    expect(await w.pass.runOnce()).toBe(0)
    expect(hashes.hashFile).toHaveBeenCalledTimes(1)
    /* The lane was taken once, to measure the jacket the port refused; the book with no jacket took none. */
    expect(w.updateAfter).toHaveBeenCalledTimes(1)
    expect(w.held.every((row) => row.coverFacts === undefined)).toBe(true)
  })

  it('does nothing without a port, and keeps a stamp another writer made first — without counting it', async () => {
    const w = world({ 'books/book_a/cover.jpg': 'a' }, [{ bookId: 'book:a' }], null)
    expect(await w.pass.runOnce()).toBe(0)
    const raced = world({ 'books/book_a/cover.jpg': 'a' }, [{ bookId: 'book:a' }])
    /* The record already holds facts by the time the update lands: the pass
       yields to them — and answers 0, because the count is of records THIS
       pass stamped, and it stamped none. It used to answer 1 for another
       writer's work. */
    raced.updateAfter.mockImplementationOnce(async (_bookId, _hooks, change) => {
      const already = { bookId: 'book:a', coverFacts: { name: 'cover.jpg' as const, size: 5, hash: 'cd'.repeat(32) } } as unknown as BookRecord
      expect(change(already)).toBe(already)
    })
    expect(await raced.pass.runOnce()).toBe(0)
  })

  /* THE BATCH BOUNDS THE BOOKS LOOKED AT, not the stamps. Counting stamps let
     one run walk a whole library of jacketless books — two probes each — while
     promising a bounded pass. */
  it('counts every book it looks at against the batch, jacketless or not', async () => {
    const w = world(
      { 'books/book_c/cover.jpg': 'c' },
      [{ bookId: 'book:a' }, { bookId: 'book:b' }, { bookId: 'book:c' }],
    )
    /* Batch 2: a and b are looked at and found jacketless; c waits for the next run. */
    expect(await w.pass.runOnce()).toBe(0)
    expect(w.held[2]?.coverFacts).toBeUndefined()
    expect(await w.pass.runOnce()).toBe(1)
    expect(w.held[2]?.coverFacts?.name).toBe('cover.jpg')
  })

  /* ONE PASS AT A TIME. Every stamp is a library change and every change is
     another call; two passes in flight hashed the same books twice. */
  it('runs ONE pass after the current one for every call made during it, and never two at once', async () => {
    const w = world({ 'books/book_a/cover.jpg': 'a', 'books/book_b/cover.jpg': 'b', 'books/book_c/cover.jpg': 'c' }, [{ bookId: 'book:a' }, { bookId: 'book:b' }, { bookId: 'book:c' }])
    const first = w.pass.runOnce()
    const second = w.pass.runOnce()
    const third = w.pass.runOnce()
    /* Not joined to the running pass — that one is past the books the
       call would stamp — and not a pass each: one follow-up, shared. */
    expect(second).not.toBe(first)
    expect(third).toBe(second)
    expect(await first).toBe(2)
    /* The follow-up began only after the first ended: two jackets hashed by then, not three. */
    expect(w.hashes!.hashFile).toHaveBeenCalledTimes(2)
    expect(await second).toBe(1)
    expect(w.hashes!.hashFile).toHaveBeenCalledTimes(3)
    /* And once everything has settled, the next call is a new pass. */
    expect(await w.pass.runOnce()).toBe(0)
  })

  it('converges when every stamp is a library change that asks for another pass — the real subscription', async () => {
    /* `circle` runs the pass from the library's change feed, and each stamp
       fires that feed from inside the pass. Joined to the running pass, the
       notification was dropped, and a shelf of six jackets measured two. */
    const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((one) => [`books/book_${one}/cover.jpg`, one]))
    const w = world(files, ['a', 'b', 'c', 'd', 'e', 'f'].map((one) => ({ bookId: `book:${one}` })))
    const passes: Promise<number>[] = []
    const onChange = (): void => {
      passes.push(w.pass.runOnce())
    }
    w.updateAfter.mockImplementation(async (bookId, hooks, change) => {
      if ((await hooks.before(w.fs, bookId)) === 'refuse') return
      const at = w.held.findIndex((row) => row.bookId === bookId)
      w.held[at] = change(w.held[at] as unknown as BookRecord) as unknown as (typeof w.held)[number]
      onChange()
    })
    passes.push(w.pass.runOnce())
    /* Drain: every pass a change asked for, and the passes those asked for. */
    for (let i = 0; i < passes.length; i++) await passes[i]
    expect(w.held.every((row) => row.coverFacts !== undefined)).toBe(true)
    /* Six jackets, six hashes — nothing measured twice on the way. */
    expect(w.hashes!.hashFile).toHaveBeenCalledTimes(6)
  })

  it('measures INSIDE the lane: a removal queued ahead leaves nothing to stamp, and a replacement is stamped as itself', async () => {
    /* Measured outside the lane, a stamp queued behind a removal restored
       facts for a deleted file, and a same-name replacement received the
       digest of the file it replaced. The hasher answers for the bytes that
       are there when the lane asks. */
    const hashes = {
      hashFile: vi.fn((folder: string, name: string) => {
        const bytes = w.fs.store.get(`books/${folder}/${name}`)
        if (!bytes) return Promise.reject(new Error('gone'))
        return Promise.resolve({ blake3: (bytes[0]! === 0x61 ? 'aa' : 'bb').repeat(32), size: bytes.length })
      }),
    }
    const w = world({ 'books/book_a/cover.jpg': 'a' }, [{ bookId: 'book:a' }], hashes)
    /* The lane's turn comes after a removal: the fake runs it first. */
    const order: string[] = []
    w.updateAfter.mockImplementationOnce(async (bookId, hooks, change) => {
      w.fs.store.delete('books/book_a/cover.jpg')
      order.push('lane')
      if ((await hooks.before(w.fs, bookId)) === 'refuse') return
      w.held[0] = change(w.held[0] as unknown as BookRecord) as unknown as (typeof w.held)[number]
    })
    expect(await w.pass.runOnce()).toBe(0)
    expect(w.held[0]).not.toHaveProperty('coverFacts')
    /* The measurement happened in the lane — after the removal, not before it — so there was nothing to measure, and nothing was hashed. */
    expect(order).toEqual(['lane'])
    expect(hashes.hashFile).not.toHaveBeenCalled()
    /* A replacement under the same name, ahead of a fresh pass, is measured as itself. */
    w.fs.store.set('books/book_a/cover.jpg', new TextEncoder().encode('bbbb'))
    const again = createCoverFactsPass({ fs: w.fs, library: { getSnapshot: () => w.held, updateAfter: w.updateAfter }, hashes: () => hashes, batch: 2 })
    expect(await again.runOnce()).toBe(1)
    expect(w.held[0]?.coverFacts).toEqual({ name: 'cover.jpg', size: 4, hash: 'bb'.repeat(32) })
  })

  /* A FAILURE IS A WAIT, NOT A VERDICT. A jacket the port would not hash —
     being replaced under it, a port briefly gone — used to be parked for the
     life of the pass. It is tried again after a wait that doubles with each
     failure, so a transient fault costs a few passes and a permanent one does
     not cost a probe per change. */
  it('retries a book the port refused, after a wait that grows with each failure', async () => {
    const hashes = port()
    hashes.hashFile.mockRejectedValueOnce(new Error('unreadable')).mockRejectedValueOnce(new Error('still unreadable'))
    const w = world({ 'books/book_a/cover.jpg': 'a' }, [{ bookId: 'book:a' }], hashes)
    /* Run 1 fails; runs 2 skip it; run 3 tries again and fails; runs 4–6 skip; run 7 succeeds. */
    const stamped: number[] = []
    for (let run = 1; run <= 7; run += 1) stamped.push(await w.pass.runOnce())
    expect(stamped).toEqual([0, 0, 0, 0, 0, 0, 1])
    expect(hashes.hashFile).toHaveBeenCalledTimes(3)
    expect(w.held[0]?.coverFacts?.name).toBe('cover.jpg')
  })
})

describe('the pass, held to the letter', () => {
  it('serves a jacket of exactly one mebibyte and no more', () => {
    expect(MAX_COVER_BYTES).toBe(1_048_576)
  })

  it('does not look at the disk without a port, and does not look twice at a book found without a jacket', async () => {
    const exists = vi.fn(() => Promise.resolve(false))
    const rows = [{ bookId: 'book:none' }]
    const idle = createCoverFactsPass({ fs: { exists }, library: { getSnapshot: () => rows, updateAfter: vi.fn() }, hashes: () => null })
    expect(await idle.runOnce()).toBe(0)
    expect(exists).not.toHaveBeenCalled()
    const pass = createCoverFactsPass({ fs: { exists }, library: { getSnapshot: () => rows, updateAfter: vi.fn() }, hashes: () => port() })
    expect(await pass.runOnce()).toBe(0)
    const looked = exists.mock.calls.length
    expect(looked).toBeGreaterThan(0)
    expect(await pass.runOnce()).toBe(0)
    expect(exists).toHaveBeenCalledTimes(looked)
  })
})
