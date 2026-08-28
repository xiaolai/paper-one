import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENVELOPE_ERRORS, ServiceCallError, serviceError } from '../../kernel/core/envelope'
import { makeHlc } from '../../kernel'
import type { ShelfChannel } from './channel'
import { WRITE_DEBOUNCE_MS, remotePositions, startingPlace } from './remotePositions'

/**
 * The phone's place reaches the shelf, and the shelf's reaches the phone
 * (WI-20.30, D7). The shelf half is `positionServices.test.ts` over the real
 * services; the pump's binding is `pump.test.ts`. What is proved here is the
 * client's side: which place a book opens at, and that a turn becomes ONE
 * write, after the reader has settled, and survives the link being down.
 */

const DEVICE = '0123456789abcdef'
const CFI = 'epubcfi(/6/24!/4/2/1:0)'

function shelf(rows: Record<string, { position?: string; positionAt?: string; progress?: number }>) {
  const calls: { service: string; body: Record<string, unknown> }[] = []
  let failWith: unknown = null
  const opened = new Set<(channel: ShelfChannel) => void>()
  const channel: ShelfChannel & { onOpened(fn: (channel: ShelfChannel) => void): () => void } = {
    call: async (service, body) => {
      calls.push({ service, body: body as Record<string, unknown> })
      if (failWith !== null) throw failWith
      if (service === 'book.get') {
        const row = rows[(body as { book: string }).book]
        if (row === undefined) throw new ServiceCallError(service, serviceError('not-found', 'no such book'))
        return { bookId: (body as { book: string }).book, ...row }
      }
      if (service === 'book.position') return { bookId: (body as { book: string }).book }
      throw new Error(`unexpected ${service}`)
    },
    stream: () => {
      throw new Error('no streams here')
    },
    close: () => {},
    onClosed: () => () => {},
    onOpened: (fn) => {
      opened.add(fn)
      return () => opened.delete(fn)
    },
  }
  return {
    channel,
    calls,
    fail: (cause: unknown) => (failWith = cause),
    reopen: () => opened.forEach((fn) => fn(channel)),
    writes: () => calls.filter((one) => one.service === 'book.position').map((one) => one.body),
  }
}

const dropped = () => new ServiceCallError('book.position', serviceError(ENVELOPE_ERRORS.disconnected, 'gone', true))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('startingPlace', () => {
  it('starts from the shelf when its place is newer than this device’s — desktop at chapter 12, phone opens at 12', () => {
    const decided = startingPlace({ cfi: 'epubcfi(/6/8)', at: 1_000 }, { cfi: 'epubcfi(/6/24)', progress: 0.5, at: 2_000 })
    expect(decided).toEqual({ cfi: 'epubcfi(/6/24)', from: 'shelf' })
  })

  it('keeps this device’s place when it is the newer, or the same age', () => {
    expect(startingPlace({ cfi: 'A', at: 2_000 }, { cfi: 'B', progress: 0, at: 1_000 })).toEqual({ cfi: 'A', from: 'device' })
    expect(startingPlace({ cfi: 'A', at: 2_000 }, { cfi: 'B', progress: 0, at: 2_000 })).toEqual({ cfi: 'A', from: 'device' })
  })

  it('takes whichever side has a place at all, and nothing when neither does', () => {
    expect(startingPlace(null, { cfi: 'B', progress: 0, at: 1 })).toEqual({ cfi: 'B', from: 'shelf' })
    expect(startingPlace({ cfi: 'A', at: 1 }, null)).toEqual({ cfi: 'A', from: 'device' })
    expect(startingPlace(null, null)).toEqual({ cfi: null, from: 'none' })
  })
})

describe('read', () => {
  it('reads the shelf’s place with the wall clock of its stamp', async () => {
    const { channel } = shelf({ one: { position: CFI, positionAt: makeHlc(1_700_000_000_000, 3, DEVICE), progress: 0.4 } })
    expect(await remotePositions(channel).read('one')).toEqual({ cfi: CFI, progress: 0.4, at: 1_700_000_000_000 })
  })

  it('answers null for a book with no place, and reads an unstamped one as older than anything', async () => {
    const { channel } = shelf({ none: {}, old: { position: CFI } })
    const remote = remotePositions(channel)
    expect(await remote.read('none')).toBeNull()
    expect(await remote.read('old')).toEqual({ cfi: CFI, progress: 0, at: 0 })
  })

  it('lets a shelf that cannot be asked throw, so the caller can fall back to the device', async () => {
    const { channel, fail } = shelf({})
    fail(dropped())
    await expect(remotePositions(channel).read('one')).rejects.toThrow(/gone/)
  })
})

describe('write', () => {
  it('sends ONE write for a run of turns, after the reader has settled, carrying the last place', async () => {
    const { channel, writes } = shelf({})
    const remote = remotePositions(channel)
    remote.write('one', 'epubcfi(/6/2)', 0.1)
    remote.write('one', 'epubcfi(/6/4)', 0.2)
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 1)
    expect(writes()).toEqual([])
    remote.write('one', 'epubcfi(/6/6)', 0.3)
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(writes()).toEqual([{ book: 'one', position: 'epubcfi(/6/6)', progress: 0.3 }])
  })

  /**
   * ONE INSTANCE, MANY BOOKS. There is one of these per LINK, so the reader
   * who puts a book down and opens another is still using it. The debounce
   * was a single timer, restarted by any book's write, which made the wait
   * "two seconds after the last turn of ANYTHING": book A's settled position
   * was pushed back by every page turn in book B and went nowhere until B was
   * closed. A book's own quiet is what sends it.
   */
  it('gives each book its own quiet — a turn in one does not push another’s settled place back', async () => {
    const { channel, writes } = shelf({})
    const remote = remotePositions(channel)
    remote.write('one', 'epubcfi(/6/2)', 0.1)
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 1)
    /* A different book, one tick before the first one settles. */
    remote.write('two', 'epubcfi(/6/4)', 0.2)
    await vi.advanceTimersByTimeAsync(1)
    expect(writes()).toEqual([{ book: 'one', position: 'epubcfi(/6/2)', progress: 0.1 }])
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(writes()).toEqual([
      { book: 'one', position: 'epubcfi(/6/2)', progress: 0.1 },
      { book: 'two', position: 'epubcfi(/6/4)', progress: 0.2 },
    ])
  })

  /**
   * FLUSH IS A PROMISE THE READER LEAVES ON. `Reader.tsx` awaits it from its
   * unmount cleanup, so what it resolves over is what the reader is told
   * landed. It used to skip a book whose write was already out — reading "in
   * flight" as "handled" — and resolve without having attempted the newer
   * place that arrived in between. The delivery's own tail did get to it, so
   * nothing was lost while the tab stayed open; a tab that went away in that
   * window lost the last page turn, silently.
   */
  it('waits for a delivery already out, rather than resolving over a newer place it never tried', async () => {
    /* A shelf that HOLDS each call until this test lets it go. The shared
       helper above answers within the same microtask, and against that a
       flush which returns immediately and a flush which waits are
       indistinguishable — the in-flight delivery's tail happens to run first
       either way. The defect only shows over a call that takes time, which is
       every real one. */
    const sent: string[] = []
    const holding: (() => void)[] = []
    const channel: ShelfChannel = {
      call: async (_service, body) => {
        sent.push((body as { position: string }).position)
        await new Promise<void>((resolve) => holding.push(resolve))
        return { bookId: 'one' }
      },
      stream: () => {
        throw new Error('no streams here')
      },
      close: () => {},
      onClosed: () => () => {},
    }
    const land = async () => {
      holding.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }

    const remote = remotePositions(channel)
    remote.write('one', 'epubcfi(/6/2)', undefined)
    const started = remote.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['epubcfi(/6/2)'])

    /* One more turn, and the book closes while the first write is still out. */
    remote.write('one', 'epubcfi(/6/4)', undefined)
    let closed = false
    const closing = remote.flush().then(() => (closed = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(closed, 'flush resolved over a place it had not attempted').toBe(false)

    await land()
    expect(sent).toEqual(['epubcfi(/6/2)', 'epubcfi(/6/4)'])
    expect(closed).toBe(false)

    await land()
    await closing
    expect(closed).toBe(true)
    await started
  })

  it('keeps a write the link could not carry, and sends it when the link is back', async () => {
    const { channel, writes, fail, reopen } = shelf({})
    const remote = remotePositions(channel)
    fail(dropped())
    remote.write('one', CFI, 0.5)
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(writes()).toHaveLength(1)
    fail(null)
    reopen()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes()).toHaveLength(2)
    expect(writes()[1]).toEqual({ book: 'one', position: CFI, progress: 0.5 })
  })

  it('reports and drops a write refused for good, rather than queueing it for ever', async () => {
    const { channel, writes, fail, reopen } = shelf({})
    const onRefused = vi.fn()
    const remote = remotePositions(channel, { onRefused })
    fail(new ServiceCallError('book.position', serviceError('forbidden', 'not your book')))
    remote.write('one', CFI, 0.5)
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(onRefused).toHaveBeenCalledWith('one', expect.any(ServiceCallError))
    fail(null)
    reopen()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes()).toHaveLength(1)
  })

  it('sends a newer place that arrived while the last was in flight, and omits a progress it was not given', async () => {
    const { channel, writes } = shelf({})
    const remote = remotePositions(channel)
    remote.write('one', 'epubcfi(/6/2)', undefined)
    const flushed = remote.flush()
    remote.write('one', 'epubcfi(/6/4)', undefined)
    await flushed
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(writes()).toEqual([
      { book: 'one', position: 'epubcfi(/6/2)' },
      { book: 'one', position: 'epubcfi(/6/4)' },
    ])
  })

  it('flushes on demand — the book is closing — and writes nothing after dispose', async () => {
    const { channel, writes } = shelf({})
    const remote = remotePositions(channel)
    remote.write('one', CFI, 0.5)
    await remote.flush()
    expect(writes()).toHaveLength(1)
    remote.dispose()
    remote.write('one', 'epubcfi(/6/9)', 0.9)
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(writes()).toHaveLength(1)
  })
})
