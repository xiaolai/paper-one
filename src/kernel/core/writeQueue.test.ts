import { describe, expect, it } from 'vitest'
import { MAX_APPENDED, MAX_APPENDED_SHARED, WriteQueueFull, writeQueue } from './writeQueue'

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
  /* ⚠️ **A TASK THAT ENQUEUES ON ITS OWN KEY USED TO START A SECOND DRAIN.**
     `running.set(key, drain(key))` evaluates the call first, and an async body
     runs synchronously to its first `await` — which is the task itself. So the
     task ran with the key unregistered, and an enqueue from inside it saw no
     drain and started one. Two drains on one key is the single thing this queue
     exists to prevent, and if the second finished first it cleared the
     registration the first was still using, so `idle()` never returned.

     The inner enqueue is SYNCHRONOUS, inside the task body, which is the only
     shape that reaches the window. */
  it('a task that enqueues on its own key does not start a second drain', async () => {
    const queue = writeQueue()
    const order: string[] = []
    let inner: Promise<void> | null = null

    await queue.append('book_a', async () => {
      order.push('outer:start')
      /* No await before this: the whole point is that it happens while the
         outer task is still the running one. */
      inner = queue.append('book_a', async () => {
        order.push('inner')
      })
      await Promise.resolve()
      order.push('outer:end')
    })
    await inner
    await queue.idle()

    expect(order, 'the inner task interleaved with the outer one').toEqual([
      'outer:start',
      'outer:end',
      'inner',
    ])
  })

  /* The other half of the same defect: the second drain's `running.delete`
     removed a registration the first drain still owned, so the queue reported
     work in flight for ever.
     
     ⚠️ **THIS ONE IS A GUARD, NOT A REPRODUCTION, AND SAYS SO.** Reverting the
     fix does NOT fail it — the hang needs the second drain to finish first,
     which this shape does not force. The test above is what actually catches
     the defect. Kept because a queue that stops settling is the worst failure
     it has and the cheapest to assert; recorded as a guard so nobody reads a
     green tick here as evidence the ordering is right.
     
     The timeout is a liveness bound, not a performance assertion: `idle()`
     here settles in microtasks, and two seconds only distinguishes "settles"
     from "never". */
  it('settles idle after a task enqueues on its own key', async () => {
    const queue = writeQueue()
    let inner: Promise<void> | null = null
    await queue.append('book_a', async () => {
      inner = queue.append('book_a', async () => {})
    })
    await inner
    const settled = await Promise.race([
      queue.idle().then(() => 'idle'),
      new Promise((go) => setTimeout(() => go('hung'), 2_000)),
    ])
    expect(settled, 'idle() never returned — a stale key was left registered').toBe('idle')
  })

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

describe('the appended line is bounded — WI-26.7', () => {
  it('refuses past the cap rather than growing', () => {
    /* ⚠️ **`append` HAD NO LENGTH LIMIT AND `push` DOES NOT NEED ONE.** A
       `replace` supersedes its predecessor, so its line is one deep however
       fast they arrive; an `append` supersedes nothing, deliberately. That was
       safe while every caller was the reader and stops being safe the moment a
       caller is a stranger's arrival rate. */
    const queue = writeQueue()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    /* One running, then the line fills behind it. */
    const running = queue.append('book', () => held)
    const waiting: Promise<void>[] = []
    for (let i = 0; i < MAX_APPENDED; i += 1) waiting.push(queue.append('book', () => Promise.resolve()))
    const refused = queue.append('book', () => Promise.resolve())
    release()
    return Promise.all([
      expect(refused).rejects.toBeInstanceOf(WriteQueueFull),
      running,
      ...waiting,
    ])
  })

  it('says which key was full, so a caller can report it', () => {
    const queue = writeQueue()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = queue.append('book:42', () => held)
    const waiting = Array.from({ length: MAX_APPENDED }, () => queue.append('book:42', () => Promise.resolve()))
    const refused = queue.append('book:42', () => Promise.resolve()).catch((error: unknown) => error)
    release()
    return refused.then((error) => {
      expect((error as WriteQueueFull).key).toBe('book:42')
      expect((error as Error).message).toContain('book:42')
      return Promise.all([running, ...waiting])
    })
  })

  it('leaves room again once the line drains', () => {
    const queue = writeQueue()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = queue.append('book', () => held)
    const waiting = Array.from({ length: MAX_APPENDED }, () => queue.append('book', () => Promise.resolve()))
    release()
    return Promise.all([running, ...waiting])
      .then(() => queue.idle())
      .then(() => queue.append('book', () => Promise.resolve()))
  })

  it('does not bound another key, and does not bound push', () => {
    /* One flooded book must not stop the reader's other books saving, and a
       `replace` line cannot exceed one waiting task anyway. */
    const queue = writeQueue()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = queue.append('flooded', () => held)
    const waiting = Array.from({ length: MAX_APPENDED }, () => queue.append('flooded', () => Promise.resolve()))
    const elsewhere = queue.append('quiet', () => Promise.resolve())
    const replaces = Array.from({ length: MAX_APPENDED + 10 }, () => queue.push('flooded', () => Promise.resolve()))
    release()
    return Promise.all([elsewhere, running, ...waiting, ...replaces])
  })
})

describe('the shared lane refuses before the reader’s own writing does', () => {
  const fill = (queue: ReturnType<typeof writeQueue>, n: number, mode: 'append' | 'appendShared') =>
    Array.from({ length: n }, () => queue[mode]('book', () => Promise.resolve()))

  it('leaves room for a private edit when a flood has taken its share', async () => {
    /* ⚠️ **MEASURED BY AUDIT: ONE CAP FOR BOTH MEANT FILLING A BOOK'S QUEUE
       WITH PUBLIC TASKS MADE THE NEXT PRIVATE EDIT REJECT** — WI-26.7's
       objective inverted. */
    const queue = writeQueue()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = queue.append('book', () => held)
    const flood = fill(queue, MAX_APPENDED_SHARED, 'appendShared')
    const refusedPublic = queue.appendShared('book', () => Promise.resolve()).catch((e: unknown) => e)
    /* The reader's own edit still goes in. */
    const mine = queue.append('book', () => Promise.resolve())
    release()
    expect(await refusedPublic).toBeInstanceOf(WriteQueueFull)
    await Promise.all([running, mine, ...flood])
  })

  it('still refuses a private edit once the WHOLE line is full', () => {
    const queue = writeQueue()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = queue.append('book', () => held)
    const waiting = fill(queue, MAX_APPENDED, 'append')
    const refused = queue.append('book', () => Promise.resolve())
    release()
    return Promise.all([expect(refused).rejects.toBeInstanceOf(WriteQueueFull), running, ...waiting])
  })

  it('names the count and the bound that actually refused it', async () => {
    /* ⚠️ **THE MESSAGE NAMED `MAX_APPENDED` WHATEVER REFUSED THE CALLER**, so a
       shared-lane task turned away at 128 reported "already has 256 writes
       waiting" — a number that was not the queue's and not the bound. */
    const queue = writeQueue()
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = queue.append('book:1', () => blocked)
    const waiting: Promise<unknown>[] = []
    for (let i = 0; i < MAX_APPENDED_SHARED; i += 1) {
      waiting.push(queue.appendShared('book:1', () => Promise.resolve()))
    }
    const refused = await queue.appendShared('book:1', () => Promise.resolve()).then(
      () => null,
      (cause: unknown) => cause,
    )
    expect(refused).toBeInstanceOf(WriteQueueFull)
    expect((refused as WriteQueueFull).waiting).toBe(MAX_APPENDED_SHARED)
    expect((refused as WriteQueueFull).cap).toBe(MAX_APPENDED_SHARED)
    expect((refused as WriteQueueFull).message).toContain(`${MAX_APPENDED_SHARED} writes waiting`)
    expect((refused as WriteQueueFull).message, 'the reader’s own bound was named').not.toContain(
      `${MAX_APPENDED} writes waiting`,
    )
    release()
    await running
    await Promise.all(waiting)
  })
})
