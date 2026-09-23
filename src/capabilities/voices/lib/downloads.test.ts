// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { STOPPED, makeDownloads } from './downloads'
import { StopFailed } from './port'
import type { InstallProgress } from '../../../kernel'

/** The value a rejected promise carries, whatever it is. */
async function refusalOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(() => null, (cause: unknown) => cause)
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

  it('stops nothing for a pack that is not downloading', () => {
    const downloads = makeDownloads()
    expect(() => downloads.stop('english-kokoro')).not.toThrow()
  })
})
