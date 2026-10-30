import { describe, expect, it } from 'vitest'
import { createHandover } from './importHandover'

/**
 * WHAT WAS COPIED IS ALWAYS RECORDED.
 *
 * Both import routes wrote their own version of this and both guarded the
 * handover with the import's generation token, so superseding an import — drop
 * a folder, then drop a book — threw away shelf records for books already
 * copied to disk. The bytes stayed; nothing pointed at them; the reader could
 * neither open nor remove them. Nothing failed, and the drop route's own
 * comment claimed the opposite three lines above the guard.
 *
 * There is no token in `createHandover`, which is the structural half of the
 * fix. These cases are the other half: they pin that everything added comes
 * out, in order, whatever the caller is doing.
 */
describe('the import handover', () => {
  const recorder = () => {
    const batches: string[][] = []
    return {
      batches,
      shelve: async (items: readonly string[]) => {
        batches.push([...items])
        return 0
      },
    }
  }

  /* AWAITED, because the handover is CHAINED — `shelve` runs in a microtask,
     not on the `add` that filled the batch. Asserting synchronously here was
     asserting that the chain had not started yet, which is true and useless. */
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('hands a batch over as soon as it is full, not at the end', async () => {
    const { batches, shelve } = recorder()
    const held = createHandover<string>(2, shelve)
    held.add('a')
    await tick()
    expect(batches, 'handed over before the batch was full').toEqual([])
    held.add('b')
    await tick()
    expect(batches, 'a full batch waited for the end of the import').toEqual([['a', 'b']])
  })

  it('hands over the remainder on flush, however few', async () => {
    const { batches, shelve } = recorder()
    const held = createHandover<string>(10, shelve)
    held.add('a')
    held.flush()
    await tick()
    expect(batches).toEqual([['a']])
  })

  /* THE REGRESSION. A caller cannot decline to record what it copied, because
     there is nothing here to decline with — and if someone adds a guard, this
     is what turns red. */
  it('records everything added, with no way for a caller to suppress it', async () => {
    const { batches, shelve } = recorder()
    const held = createHandover<string>(2, shelve)
    for (const one of ['a', 'b', 'c', 'd', 'e']) held.add(one)
    await held.settled()
    expect(batches.flat(), 'a copy was made and never recorded').toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('settles a trailing partial batch without a separate flush', async () => {
    const { batches, shelve } = recorder()
    const held = createHandover<string>(3, shelve)
    held.add('a')
    /* `settled()` flushes first: a caller that adds a last item and awaits
       would otherwise be told about writes that did not include it. */
    await held.settled()
    expect(batches).toEqual([['a']])
  })

  it('sums what every batch reported unsaved', async () => {
    let n = 0
    const held = createHandover<string>(1, async () => {
      n += 1
      return n
    })
    held.add('a')
    held.add('b')
    expect(await held.settled()).toBe(3)
  })

  /* CHAINED, NOT PARALLEL. `shelve` already writes several books at once, so
     overlapping batches would put the whole library in flight together. */
  it('never runs two handovers at once', async () => {
    let live = 0
    let most = 0
    const held = createHandover<string>(1, async () => {
      live += 1
      most = Math.max(most, live)
      await Promise.resolve()
      live -= 1
      return 0
    })
    for (const one of ['a', 'b', 'c']) held.add(one)
    await held.settled()
    expect(most).toBe(1)
  })

  /**
   * ⚠️ **A REJECTED BATCH USED TO TAKE EVERY BATCH BEHIND IT WITH IT.**
   *
   * `chain.then` on a rejected chain never runs its callback, so one failed
   * shelf write skipped the rest — the same orphan the header describes,
   * reached by a route the token could not guard because there is no token in
   * here.
   */
  describe('when one batch will not be shelved', () => {
    const failing = (at: number) => {
      const batches: string[][] = []
      return {
        batches,
        shelve: async (items: readonly string[]) => {
          batches.push([...items])
          if (batches.length === at) throw new Error('disk full')
          return 0
        },
      }
    }

    it('goes on shelving the batches behind it', async () => {
      const { batches, shelve } = failing(1)
      const held = createHandover<string>(1, shelve)
      for (const one of ['a', 'b', 'c']) held.add(one)
      await expect(held.settled()).rejects.toThrow('disk full')
      expect(batches.flat(), 'a copy was made and never recorded').toEqual(['a', 'b', 'c'])
    })

    /* The caller still hears about it — `useImportRun` folds this into the
       failure it reports — and it hears about the FIRST one. */
    it('raises the first cause once every batch has had its turn', async () => {
      const seen: string[] = []
      const held = createHandover<string>(1, async (items) => {
        seen.push(items[0] as string)
        throw new Error(`no room for ${items[0]}`)
      })
      for (const one of ['a', 'b']) held.add(one)
      await expect(held.settled()).rejects.toThrow('no room for a')
      expect(seen).toEqual(['a', 'b'])
    })
  })

  it('is idempotent when flushed with nothing pending', async () => {
    const { batches, shelve } = recorder()
    const held = createHandover<string>(2, shelve)
    held.flush()
    held.flush()
    await held.settled()
    expect(batches).toEqual([])
  })
})
