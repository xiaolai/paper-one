// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useImportRun, type Imports, type ImportRun } from './useImportRun'
import type { ImportOutcome } from '../../core/importFolder'

/* React refuses to treat `act` as a test boundary without this, and says so on
   stderr rather than failing. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A promise the test opens when it wants the work to proceed. */
function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

const kept = (name: string): ImportOutcome => ({ path: name, status: 'added', name, bookId: name })

function harness(shelve: (outcomes: readonly ImportOutcome[]) => Promise<number>) {
  const notices: string[] = []
  let latest: Imports | null = null
  function Probe(): ReactNode {
    latest = useImportRun({ shelve, batch: 2, notice: (text) => void notices.push(text) })
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  return {
    notices,
    imports: (): Imports => {
      if (latest === null) throw new Error('the probe never rendered')
      return latest
    },
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

/**
 * THE IMPORT LIFECYCLE, ONCE.
 *
 * Two routes copy books in, and each had written out the same six things: a
 * generation token, an abort controller, the progress bar's lifetime, a
 * handover chained one batch behind the copying, the settle the notice waits
 * on, and the cleanup. They had drifted in three ways by the time an audit
 * read them side by side — one cleared its progress before the shelf writes
 * settled, one walked past its own settle when superseded, and one superseded
 * the other in silence. Every case below is one of those.
 */
describe('the import coordinator', () => {
  it('reports nothing at rest', () => {
    const world = harness(async () => 0)
    expect(world.imports().progress).toBeNull()
    expect(world.imports().busy).toBe(false)
    world.unmount()
  })

  it('shelves what the work hands over, and says what happened', async () => {
    const written: ImportOutcome[][] = []
    const world = harness(async (batch) => {
      written.push([...batch])
      return 0
    })

    await act(async () => {
      await world.imports().run(
        async (run) => {
          run.shelve(kept('a'))
          run.shelve(kept('b'))
          run.shelve(kept('c'))
          return [kept('a'), kept('b'), kept('c')]
        },
        { summarise: (outcomes, unsaved) => `${outcomes.length} in, ${unsaved} unsaved`, onFailure: () => {} },
      )
    })

    expect(written.flat().map((one) => one.name)).toEqual(['a', 'b', 'c'])
    expect(world.notices).toEqual(['3 in, 0 unsaved'])
    expect(world.imports().progress, 'the bar was left on screen').toBeNull()
    world.unmount()
  })

  /**
   * ⚠️ THE BAR GOES AWAY AFTER THE SHELF WRITES LAND, NOT BEFORE THEM.
   *
   * One route cleared it in a `finally` that ran before the settle, so every
   * control came back while records were still being written — the reader
   * could start a second import into a shelf the first had not finished
   * writing. The bar is what says "this is still happening".
   */
  it('stays busy until the shelf writes have settled', async () => {
    const writing = deferred()
    const world = harness(async () => {
      await writing.promise
      return 0
    })

    let running: Promise<void> | null = null
    await act(async () => {
      running = world.imports().run(
        async (run) => {
          run.shelve(kept('a'))
          return [kept('a')]
        },
        { summarise: () => 'done', onFailure: () => {} },
      )
      await Promise.resolve()
    })

    expect(world.imports().busy, 'the bar cleared before the writes landed').toBe(true)
    expect(world.imports().progress, 'the bar cleared before the writes landed').not.toBeNull()
    expect(world.notices, 'success was claimed before the writes landed').toEqual([])

    await act(async () => {
      writing.open()
      await running
    })
    expect(world.imports().busy).toBe(false)
    expect(world.notices).toEqual(['done'])
    world.unmount()
  })

  /**
   * ⚠️ A SUPERSEDED RUN STILL SHELVES WHAT IT COPIED.
   *
   * The bytes are on disk either way, and a copy with no shelf record is
   * invisible to the library and to removal alike — an orphan nobody can
   * reach. The token governs the NOTICE, never the bookkeeping.
   */
  it('shelves a superseded run’s books, and lets it say nothing', async () => {
    const written: ImportOutcome[] = []
    const world = harness(async (batch) => {
      written.push(...batch)
      return 0
    })

    const gate = deferred()
    let older: Promise<void> | null = null
    await act(async () => {
      older = world.imports().run(
        async (run) => {
          run.shelve(kept('before'))
          await gate.promise
          /* ⚠️ AFTER IT HAS BEEN SUPERSEDED, which is the case that matters: a
             walk goes on copying for as long as it takes to notice the signal,
             and every book it lands in that window still needs a record. */
          run.shelve(kept('after'))
          return [kept('before'), kept('after')]
        },
        { summarise: () => 'older finished', onFailure: () => {} },
      )
      await Promise.resolve()
    })

    /* A newer intake retires it — the case a drop during a folder walk makes. */
    act(() => world.imports().supersede())
    await act(async () => {
      gate.open()
      await older
    })

    expect(written.map((one) => one.name), 'a superseded run left its copies recordless').toEqual([
      'before',
      'after',
    ])
    expect(world.notices, 'a superseded run reported over the newer one').toEqual([])
    world.unmount()
  })

  /* AND ITS SIGNAL IS ABORTED, so it stops COPYING and not merely reporting. */
  it('aborts a superseded run’s signal', async () => {
    const world = harness(async () => 0)
    let seen: ImportRun | null = null
    const gate = deferred()
    let running: Promise<void> | null = null
    await act(async () => {
      running = world.imports().run(
        async (run) => {
          seen = run
          await gate.promise
          return []
        },
        { summarise: () => 'x', onFailure: () => {} },
      )
      await Promise.resolve()
    })

    expect((seen as ImportRun | null)?.signal.aborted).toBe(false)
    act(() => world.imports().supersede())
    expect((seen as ImportRun | null)?.signal.aborted, 'the work was never told to stop').toBe(true)
    await act(async () => {
      gate.open()
      await running
    })
    world.unmount()
  })

  it('reports progress while it runs, and ignores a superseded run’s', async () => {
    const world = harness(async () => 0)
    const gate = deferred()
    let running: Promise<void> | null = null
    let seen: ImportRun | null = null
    await act(async () => {
      running = world.imports().run(
        async (run) => {
          seen = run
          run.report({ done: 3, total: 10 })
          await gate.promise
          run.report({ done: 9, total: 10 })
          return []
        },
        { summarise: () => 'x', onFailure: () => {} },
      )
      await Promise.resolve()
    })
    expect(world.imports().progress).toEqual({ done: 3, total: 10 })

    act(() => world.imports().supersede())
    await act(async () => {
      gate.open()
      await running
    })
    expect(
      world.imports().progress,
      'a superseded run reported into the current one’s bar',
    ).not.toEqual({ done: 9, total: 10 })
    void seen
    world.unmount()
  })

  /* A failure is the caller's to word — the two routes say different things —
     and the lifecycle closes either way. */
  it('closes the lifecycle when the work throws, and hands the cause over', async () => {
    const onFailure = vi.fn()
    const world = harness(async () => 0)
    await act(async () => {
      await world.imports().run(
        async () => {
          throw new Error('the walk failed')
        },
        { summarise: () => 'never', onFailure },
      )
    })
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect((onFailure.mock.calls[0]?.[0] as Error).message).toBe('the walk failed')
    expect(world.notices, 'a failure was summarised as a success').toEqual([])
    expect(world.imports().busy, 'the bar was stranded by the failure').toBe(false)
    world.unmount()
  })

  /* AND IT STILL SHELVES WHAT IT COPIED BEFORE FAILING, for the same reason a
     superseded run does. */
  it('shelves what a failed run copied before it threw', async () => {
    const written: ImportOutcome[] = []
    const world = harness(async (batch) => {
      written.push(...batch)
      return 0
    })
    await act(async () => {
      await world.imports().run(
        async (run) => {
          run.shelve(kept('landed'))
          throw new Error('and then it failed')
        },
        { summarise: () => 'never', onFailure: () => {} },
      )
    })
    expect(written.map((one) => one.name)).toEqual(['landed'])
    world.unmount()
  })

  /**
   * ⚠️ AND WHEN THE SETTLE ITSELF REJECTS, WHICH IS NOT THE WORK FAILING.
   *
   * `settled()` is the chain of shelf writes, and one rejected write used to
   * throw straight out of `run` — past `setProgress(null)`, past `onFailure`,
   * past everything. The bar stayed on screen and `busy` stayed true for the
   * rest of the session: the folder route refuses to start while busy, so it
   * refused every later import, and the drop route went on superseding a run
   * that had already finished. A terminal catch was added at the call site and
   * said the right sentence; it could not put the bar away, because the state
   * is in here. This is the assertion that stops it coming back — `run` must
   * not reject for anything a caller can produce.
   */
  it('closes the lifecycle when a shelf write rejects', async () => {
    const onFailure = vi.fn()
    const world = harness(async () => {
      throw new Error('the disk is full')
    })

    await act(async () => {
      await world.imports().run(
        async (run) => {
          run.shelve(kept('a'))
          return [kept('a')]
        },
        { summarise: () => 'never', onFailure },
      )
    })

    expect(onFailure, 'a rejected shelf write was never reported').toHaveBeenCalledTimes(1)
    expect((onFailure.mock.calls[0]?.[0] as Error).message).toBe('the disk is full')
    expect(world.notices, 'a failed import was summarised as a success').toEqual([])
    expect(world.imports().progress, 'the bar was stranded by the settle').toBeNull()
    expect(world.imports().busy, 'every later import would now be refused').toBe(false)
    world.unmount()
  })

  /* WHEN BOTH FAIL, THE WORK'S CAUSE IS THE ONE REPORTED — it is the one that
     explains the other — and the settle's is logged rather than dropped. */
  it('reports the work’s failure over the settle’s, and loses neither', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onFailure = vi.fn()
    const world = harness(async () => {
      throw new Error('the disk is full')
    })

    await act(async () => {
      await world.imports().run(
        async (run) => {
          run.shelve(kept('a'))
          throw new Error('the walk failed')
        },
        { summarise: () => 'never', onFailure },
      )
    })

    expect((onFailure.mock.calls[0]?.[0] as Error).message).toBe('the walk failed')
    expect(
      logged.mock.calls.some((call) => (call[1] as Error | undefined)?.message === 'the disk is full'),
      'the settle’s cause was swallowed',
    ).toBe(true)
    expect(world.imports().busy).toBe(false)
    logged.mockRestore()
    world.unmount()
  })

  it('carries the unsaved count into the summary', async () => {
    const world = harness(async (batch) => batch.length)
    await act(async () => {
      await world.imports().run(
        async (run) => {
          run.shelve(kept('a'))
          return [kept('a')]
        },
        { summarise: (_outcomes, unsaved) => `${unsaved} did not land`, onFailure: () => {} },
      )
    })
    expect(world.notices).toEqual(['1 did not land'])
    world.unmount()
  })
})
