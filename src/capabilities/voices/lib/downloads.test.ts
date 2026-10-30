// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { STOPPED, makeDownloads } from './downloads'
import { StopFailed } from './port'
import type { InstallProgress } from '../../../kernel'

/** How long a promise here may take to settle before a case gives up on it. */
const SETTLE_MS = 2000

/**
 * The value a rejected promise carries, whatever it is — with a deadline.
 *
 * ⚠️ **A LIVENESS BOUND, NOT A PERFORMANCE ONE, AND IT IS WHAT TURNS A STOP
 * THAT DOES NOTHING INTO A FAILURE RATHER THAN A HANG.** Every promise in this
 * file settles in microseconds; what it awaits, though, is a download that only
 * ends because the registry aborted it — so a registry that lost its controller
 * leaves this waiting for ever. Under vitest's own 15 s bound that is a case
 * which takes half a minute to say anything, and **a mutation sweep can only
 * call it a wall-clock timeout, which is the one verdict meaning "whether a
 * test kills it is unknown"**. Measured 2026-09-24: with `stop`'s body emptied
 * the two cases below took 30.7 s between them and the gate reported
 * `repeated`, not `killed`. Two seconds is a thousand-fold margin, and it
 * reports by name.
 */
async function refusalOf(run: Promise<unknown>): Promise<unknown> {
  let bell: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    bell = setTimeout(() => reject(new Error('the download never settled')), SETTLE_MS)
  })
  try {
    return await Promise.race([run.then(() => null, (cause: unknown) => cause), deadline])
  } finally {
    clearTimeout(bell)
  }
}

describe('a download that outlives the pane', () => {
  it('says which pack is downloading, with the size the catalogue stated', () => {
    const downloads = makeDownloads()
    void downloads.begin('english-kokoro', 336_822_660, () => new Promise(() => {}))
    expect(downloads.states()['english-kokoro']).toEqual({
      progress: { kind: 'downloading', received: 0, total: 336_822_660 },
      error: null,
    })
  })

  it('joins a download already running rather than fetching it twice', async () => {
    /* ⚠️ Two panes, or one pane mounted twice across a reload, must not fetch
       the same gigabytes again. */
    const downloads = makeDownloads()
    const run = vi.fn(async () => {})
    await Promise.all([
      downloads.begin('english-kokoro', 1, run),
      downloads.begin('english-kokoro', 1, run),
    ])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports progress as it arrives', async () => {
    const downloads = makeDownloads()
    /* A HOLDER, not a `let`: TypeScript narrows a `let` assigned inside a
       callback back to `null` at the call site below, which reads as a type
       error over code that is correct. */
    const held: { report: ((p: InstallProgress) => void) | null } = { report: null }
    void downloads.begin('english-kokoro', 10, (r) => {
      held.report = r
      return new Promise(() => {})
    })
    held.report?.({ kind: 'downloading', received: 4, total: 10 })
    expect(downloads.states()['english-kokoro']?.progress).toEqual({ kind: 'downloading', received: 4, total: 10 })
  })

  it('ignores a report that arrives after the download is over', async () => {
    // Otherwise a late event puts a progress line back under a finished row.
    const downloads = makeDownloads()
    const held: { report: ((p: InstallProgress) => void) | null } = { report: null }
    await downloads.begin('english-kokoro', 10, (r) => {
      held.report = r
      return Promise.resolve()
    })
    held.report?.({ kind: 'downloading', received: 9, total: 10 })
    expect(downloads.states()['english-kokoro']?.progress).toBeNull()
  })

  it('aborts the download it is holding, which is the whole of what a stop can do', () => {
    /* Asserted on the SIGNAL rather than on what the download does with it, so
       the case says nothing about how long anything takes — and so a registry
       that lost its controller fails here in a millisecond rather than in the
       cases below, which can only find out by waiting. */
    const downloads = makeDownloads()
    const held: { signal: AbortSignal | null } = { signal: null }
    void downloads.begin('english-kokoro', 1, (_report, signal) => {
      held.signal = signal
      return new Promise(() => {})
    })
    downloads.stop('english-kokoro')
    expect(held.signal?.aborted, 'the registry kept the controller, and used it').toBe(true)
  })

  it('calls a stop the reader’s own doing, and a failure a failure', async () => {
    const downloads = makeDownloads()
    const stopped = downloads.begin('english-kokoro', 1, (_report, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    )
    downloads.stop('english-kokoro')
    await refusalOf(stopped)
    expect(downloads.states()['english-kokoro']?.error).toBe(STOPPED)

    const refused = downloads.begin('chinese-qwen', 1, async () => {
      throw new Error("the file's digest does not match the catalogue")
    })
    await refusalOf(refused)
    expect(downloads.states()['chinese-qwen']?.error).toMatch(/digest does not match/u)
  })

  it('says a stop that FAILED, rather than that nothing was left behind', async () => {
    /* ⚠️ An aborted signal says the reader ASKED to stop, not that it worked. */
    const downloads = makeDownloads()
    const work = downloads.begin('english-kokoro', 1, (_report, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new StopFailed('the download could not be stopped')), { once: true })
      }),
    )
    downloads.stop('english-kokoro')
    await refusalOf(work)
    expect(downloads.states()['english-kokoro']?.error).toMatch(/could not be stopped/u)
  })

  it('tells a watcher whenever the answer would change, and stops when it is let go', async () => {
    const downloads = makeDownloads()
    const seen: number[] = []
    const off = downloads.watch(() => seen.push(Object.keys(downloads.states()).length))
    await downloads.begin('english-kokoro', 1, async () => {})
    expect(seen.length).toBeGreaterThan(0)
    const before = seen.length
    off()
    await downloads.begin('chinese-qwen', 1, async () => {})
    expect(seen.length).toBe(before)
  })

  it('forgets a finished pack, and refuses to forget a running one', async () => {
    const downloads = makeDownloads()
    await downloads.begin('english-kokoro', 1, async () => {})
    downloads.clear('english-kokoro')
    expect(downloads.states()['english-kokoro']).toBeUndefined()

    void downloads.begin('chinese-qwen', 1, () => new Promise(() => {}))
    downloads.clear('chinese-qwen')
    expect(downloads.states()['chinese-qwen'], 'a running download is not forgotten').toBeDefined()
  })

  it('keeps every pack’s state, not only the one that changed last', () => {
    /* The registry is one object rebuilt on each change, so the rebuild has to
       carry what it is not changing: without that, starting a second download
       empties the first one's row while it is still running. */
    const downloads = makeDownloads()
    void downloads.begin('english-kokoro', 10, () => new Promise(() => {}))
    void downloads.begin('chinese-qwen', 20, () => new Promise(() => {}))
    expect(Object.keys(downloads.states()).sort()).toEqual(['chinese-qwen', 'english-kokoro'])
    expect(downloads.states()['english-kokoro']?.progress).toEqual({ kind: 'downloading', received: 0, total: 10 })
  })

  it('lets a pack be downloaded again once it has finished, or failed', async () => {
    /* The registry has to FORGET a download that ended, on both roads out.
       Holding on to it makes the next press hand back the run that already
       ended — a retry that fetches nothing and a row that never moves. */
    const downloads = makeDownloads()
    const ok = vi.fn(async () => {})
    await downloads.begin('english-kokoro', 1, ok)
    await downloads.begin('english-kokoro', 1, ok)
    expect(ok).toHaveBeenCalledTimes(2)

    const bad = vi.fn(async () => {
      throw new Error("the file's digest does not match the catalogue")
    })
    await refusalOf(downloads.begin('chinese-qwen', 1, bad))
    await refusalOf(downloads.begin('chinese-qwen', 1, bad))
    expect(bad).toHaveBeenCalledTimes(2)
  })

  it('names the subscription when a watcher throws, and tells the rest anyway', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const downloads = makeDownloads()
    const second = vi.fn()
    downloads.watch(() => {
      throw new Error('a pane that unmounted')
    })
    downloads.watch(second)
    void downloads.begin('english-kokoro', 1, () => new Promise(() => {}))
    expect(second, 'one throwing subscriber does not silence the next').toHaveBeenCalled()
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('voice download'),
      expect.objectContaining({ message: 'a pane that unmounted' }),
    )
    errors.mockRestore()
  })

  it('stops nothing for a pack that is not downloading', () => {
    const downloads = makeDownloads()
    expect(() => downloads.stop('english-kokoro')).not.toThrow()
  })
})
