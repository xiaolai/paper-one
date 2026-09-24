import { describe, expect, it, vi } from 'vitest'
import { sweep, type BuildDeps } from './builder'
import type { Wanted } from './freshness'

/**
 * The backfill, over fakes.
 *
 * At 1 959 books, **a backfill that begins again never finishes** — so every
 * case here is about what survives an interruption and what a sweep is allowed
 * to claim afterwards.
 */

function deps(over: Partial<BuildDeps> = {}): BuildDeps {
  return {
    wanted: () => [] as readonly Wanted[],
    pending: async () => [],
    indexOne: async () => 'indexed' as const,
    forget: async () => {},
    indexed: async () => [],
    flush: async () => {},
    live: () => true,
    breathe: async () => {},
    ...over,
  }
}

describe('a sweep', () => {
  it('indexes every book that is not current', async () => {
    const asked: string[] = []
    const outcome = await sweep(
      deps({
        wanted: () => [['a', 'g'], ['b', 'g']],
        pending: async () => ['a', 'b'],
        indexOne: async (bookId) => {
          asked.push(bookId)
          return 'indexed'
        },
      }),
    )
    expect(outcome).toMatchObject({ indexed: 2, complete: true })
    expect(asked).toEqual(['a', 'b'])
  })

  it('does the removals FIRST', async () => {
    /* ⚠️ **A SWEEP INTERRUPTED AFTER INDEXING AND BEFORE FORGETTING LEAVES A
     * REMOVED BOOK SEARCHABLE.** A reader who evicted a book and searched for
     * it immediately would find it. The other order leaves at worst a book
     * indexed a little later, which nobody can see. */
    const order: string[] = []
    await sweep(
      deps({
        wanted: () => [['a', 'g']],
        indexed: async () => ['a', 'gone'],
        pending: async () => ['a'],
        forget: async (ids) => {
          order.push(`forget:${ids.join(',')}`)
        },
        indexOne: async (id) => {
          order.push(`index:${id}`)
          return 'indexed'
        },
      }),
    )
    expect(order).toEqual(['forget:gone', 'index:a'])
  })

  it('forgets exactly what the shelf no longer wants', async () => {
    const forget = vi.fn(async () => {})
    const outcome = await sweep(
      deps({ wanted: () => [['a', 'g']], indexed: async () => ['a', 'b', 'c'], forget }),
    )
    expect(forget).toHaveBeenCalledWith(['b', 'c'])
    expect(outcome.forgotten).toBe(2)
  })

  it('does not call forget at all when there is nothing to forget', async () => {
    const forget = vi.fn(async () => {})
    await sweep(deps({ wanted: () => [['a', 'g']], indexed: async () => ['a'] }))
    expect(forget).not.toHaveBeenCalled()
  })

  it('counts a book that could not be read apart from one that was skipped', async () => {
    /* ⚠️ **SKIPPED, IT COMES BACK IN `pending()` EVERY SWEEP AND IS RE-PARSED
     * FOR EVER.** The two outcomes are different facts and the sweep reports
     * them separately, because a rising `unreadable` is a defect and a rising
     * `skipped` is a busy library. */
    const outcome = await sweep(
      deps({
        wanted: () => [['a', 'g'], ['b', 'g'], ['c', 'g']],
        pending: async () => ['a', 'b', 'c'],
        indexOne: async (id) =>
          id === 'a' ? 'indexed' : id === 'b' ? 'unreadable' : 'skipped',
      }),
    )
    expect(outcome).toMatchObject({ indexed: 1, unreadable: 1, skipped: 1, complete: true })
  })

  it('stops the moment it is no longer wanted, and says so', async () => {
    let done = 0
    const outcome = await sweep(
      deps({
        wanted: () => [['a', 'g'], ['b', 'g'], ['c', 'g']],
        pending: async () => ['a', 'b', 'c'],
        indexOne: async () => {
          done += 1
          return 'indexed'
        },
        live: () => done < 2,
      }),
    )
    expect(outcome.complete).toBe(false)
    expect(done).toBeLessThan(3)
  })

  it('asks whether it is still wanted BEFORE the work, not after', async () => {
    const indexOne = vi.fn(async () => 'indexed' as const)
    const outcome = await sweep(
      deps({ wanted: () => [['a', 'g']], pending: async () => ['a'], indexOne, live: () => false }),
    )
    expect(indexOne).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ indexed: 0, complete: false })
  })

  it('flushes on the way out of an interrupted sweep', async () => {
    /* ⚠️ **SO A QUIT COSTS AT MOST ONE BATCH.** Without it, the books between
     * the last automatic commit and the interruption are re-extracted on the
     * next launch — minutes, for nothing. */
    const flush = vi.fn(async () => {})
    let done = 0
    await sweep(
      deps({
        wanted: () => [['a', 'g'], ['b', 'g']],
        pending: async () => ['a', 'b'],
        indexOne: async () => {
          done += 1
          return 'indexed'
        },
        live: () => done < 1,
        flush,
      }),
    )
    expect(flush).toHaveBeenCalled()
  })

  it('flushes before it claims to be complete', async () => {
    /* ⚠️ Without it, `complete: true` is a claim about books the index has not
     * yet made durable — and the next launch's `pending()` would disagree. */
    const order: string[] = []
    await sweep(
      deps({
        wanted: () => [['a', 'g']],
        pending: async () => ['a'],
        indexOne: async () => {
          order.push('index')
          return 'indexed'
        },
        flush: async () => {
          order.push('flush')
        },
      }),
    )
    expect(order).toEqual(['index', 'flush'])
  })

  it('hands the main thread back between books', async () => {
    const breathe = vi.fn(async () => {})
    await sweep(
      deps({
        wanted: () => [['a', 'g'], ['b', 'g'], ['c', 'g']],
        pending: async () => ['a', 'b', 'c'],
        breathe,
      }),
    )
    expect(breathe).toHaveBeenCalledTimes(2)
  })

  it('reports an incomplete sweep when it is dead before it starts', async () => {
    const indexed = vi.fn(async () => [])
    const outcome = await sweep(deps({ live: () => false, indexed }))
    expect(outcome.complete).toBe(false)
    expect(indexed).not.toHaveBeenCalled()
  })

  it('stops between the removals and the indexing when it is asked to', async () => {
    const pending = vi.fn(async () => [])
    let asked = 0
    const outcome = await sweep(
      deps({
        wanted: () => [['a', 'g']],
        indexed: async () => ['gone'],
        pending,
        /* True for the first check, false for the one after the removals. */
        live: () => {
          asked += 1
          return asked < 2
        },
      }),
    )
    expect(pending).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ complete: false, forgotten: 1 })
  })

  it('is a no-op that claims completeness when there is nothing to do', async () => {
    const outcome = await sweep(deps())
    expect(outcome).toEqual({
      indexed: 0,
      unreadable: 0,
      skipped: 0,
      forgotten: 0,
      complete: true,
    })
  })
})
