import { describe, expect, it } from 'vitest'
import { writeQueue } from './writeQueue'

/**
 * Two writes to one file must not overlap, because they share a temporary path.
 *
 * And three writes queued behind one in flight should not all run: each persists
 * the whole collection, so the first two would write stale data and the third
 * would write what the second already had.
 */

const defer = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('writeQueue', () => {
  it('runs one task at a time for a key', async () => {
    const q = writeQueue()
    const first = defer()
    let running = 0
    let overlapped = false
    const task = (gate?: Promise<void>) => async () => {
      running += 1
      if (running > 1) overlapped = true
      if (gate) await gate
      running -= 1
    }
    const a = q.push('k', task(first.promise))
    const b = q.push('k', task())
    first.resolve()
    await Promise.all([a, b])
    expect(overlapped).toBe(false)
  })

  /* The coalescing rule: only the newest waiting value is worth writing. */
  it('drops a superseded write rather than running it', async () => {
    const q = writeQueue()
    const gate = defer()
    const ran: string[] = []
    void q.push('k', async () => {
      ran.push('first')
      await gate.promise
    })
    void q.push('k', async () => void ran.push('second'))
    const last = q.push('k', async () => void ran.push('third'))
    gate.resolve()
    await last
    expect(ran).toEqual(['first', 'third'])
  })

  it('keeps different keys independent', async () => {
    const q = writeQueue()
    const ran: string[] = []
    await Promise.all([
      q.push('a', async () => void ran.push('a')),
      q.push('b', async () => void ran.push('b')),
    ])
    expect(ran.sort()).toEqual(['a', 'b'])
  })

  /* A failing write must not wedge the key forever. */
  it('carries on after a task throws', async () => {
    const q = writeQueue()
    const ran: string[] = []
    await q.push('k', async () => {
      throw new Error('disk full')
    }).catch(() => {})
    await q.push('k', async () => void ran.push('after'))
    expect(ran).toEqual(['after'])
  })

  /**
   * The distinction the two methods exist for.
   *
   * `push` writes a whole state, so the superseded one is redundant. `append`
   * applies a CHANGE — a tag, then a position — and dropping either loses what
   * it was carrying. One queue with only `push` silently lost the first of any
   * two edits made to one book in the same tick.
   */
  it('runs every appended task, in order', async () => {
    const q = writeQueue()
    const ran: string[] = []
    const gate = defer()
    void q.append('k', async () => {
      ran.push('first')
      await gate.promise
    })
    void q.append('k', async () => void ran.push('second'))
    const last = q.append('k', async () => void ran.push('third'))
    gate.resolve()
    await last
    expect(ran).toEqual(['first', 'second', 'third'])
  })

  it('carries on appending after a task throws', async () => {
    const q = writeQueue()
    const ran: string[] = []
    const failed = q.append('k', async () => {
      throw new Error('disk full')
    })
    const after = q.append('k', async () => void ran.push('after'))
    await failed.catch(() => {})
    await after
    expect(ran).toEqual(['after'])
  })

  /**
   * The two modes share a key, so `push` must not throw away an `append`.
   *
   * Editing a mark in a book that is closed appends a read-modify-write; opening
   * that book and highlighting something pushes a whole snapshot. Clearing the
   * line outright dropped the first edit, and the row it belonged to came back.
   */
  it('a pushed snapshot supersedes other snapshots, never a pending change', async () => {
    const q = writeQueue()
    const ran: string[] = []
    const gate = defer()
    void q.push('k', async () => {
      ran.push('running')
      await gate.promise
    })
    void q.append('k', async () => void ran.push('change'))
    void q.push('k', async () => void ran.push('snapshot-1'))
    const last = q.push('k', async () => void ran.push('snapshot-2'))
    gate.resolve()
    await last
    expect(ran).toEqual(['running', 'change', 'snapshot-2'])
  })

  /* A thrown value that happens to be falsy is still a failure. Testing the
   * error's truthiness resolved `throw undefined` as a success, so a write that
   * failed reported that it had saved. */
  it('rejects when a task throws something falsy', async () => {
    const q = writeQueue()
    let settled = 'neither'
    await q
      .push('k', async () => {
        throw undefined
      })
      .then(
        () => (settled = 'resolved'),
        () => (settled = 'rejected'),
      )
    expect(settled).toBe('rejected')
  })

  /**
   * The one moment that cannot be deferred: the window closing.
   *
   * Everything here is asynchronous on purpose — a page turn must not wait on a
   * disk — and that is right until the process is about to go away, when an
   * unfinished write is a lost highlight.
   */
  describe('idle', () => {
    it('resolves immediately when nothing is queued', async () => {
      await expect(writeQueue().idle()).resolves.toBeUndefined()
    })

    it('waits for what is running and what is behind it', async () => {
      const q = writeQueue()
      const gate = defer()
      const ran: string[] = []
      void q.append('k', async () => {
        await gate.promise
        ran.push('first')
      })
      void q.append('k', async () => void ran.push('second'))
      void q.append('other', async () => void ran.push('elsewhere'))
      gate.resolve()
      await q.idle()
      expect(ran.sort()).toEqual(['elsewhere', 'first', 'second'])
    })

    /* A task that queues another — the library writes a record, then the index
     * on a different key from inside the first task's continuation. Waiting once
     * would return between the two and call the queue empty. */
    it('waits for work a running task starts', async () => {
      const q = writeQueue()
      const ran: string[] = []
      void q.append('a', async () => {
        ran.push('a')
        void q.push('b', async () => void ran.push('b'))
      })
      await q.idle()
      expect(ran).toEqual(['a', 'b'])
    })

    /* Resolves rather than rejects: the question is "is anything in flight",
     * and a failed write is not. Its own promise already carried the failure. */
    it('resolves even when a task threw', async () => {
      const q = writeQueue()
      void q.append('k', async () => {
        throw new Error('disk full')
      }).catch(() => {})
      await expect(q.idle()).resolves.toBeUndefined()
    })
  })
})
