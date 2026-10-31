// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeCapabilities, createKernelServices, kernelApi, type IndexFs } from '../../kernel'

/**
 * Switched off, at the capability's own door: no sweep, nothing bound, and the
 * index on disk untouched. That the Search pane then keeps to the open book is
 * `SearchPanel.test.tsx`'s, for a host with no `searchLibrary`.
 */

const index = vi.hoisted(() => ({
  over: vi.fn(() => ({
    search: vi.fn(async () => []),
    status: vi.fn(async () => ({ books: 0, sections: 0, chars: 0, indexBytes: 0, textBytes: 0, analysis: 'paper/1', unreadable: [] })),
    put: vi.fn(async () => true),
    note: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    rekey: vi.fn(async () => true),
    pending: vi.fn(async () => []),
    indexed: vi.fn(async () => []),
  })),
}))

vi.mock('./lib/port', async (original) => ({
  ...(await original<typeof import('./lib/port')>()),
  passageIndexOver: index.over,
}))

const { passages } = await import('./index')
const { theProgress } = await import('./lib/progress')

/** A filesystem that refuses to be touched, holding the index a reader built. */
function untouchable(): IndexFs {
  const refuse = vi.fn(async () => {
    throw new Error('the switched-off capability touched the disk')
  })
  return new Proxy({} as IndexFs, { get: () => refuse })
}

const launch = (switchedOff: ReadonlySet<string>, fs: IndexFs | null = null) => {
  const services = createKernelServices({ fs, storage: null })
  return composeCapabilities([passages], kernelApi(services), new AbortController().signal, { switchedOff }).then(
    (composition) => ({ services, composition }),
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  index.over.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('library search, switched off', () => {
  it('offers a switch in words a reader knows', () => {
    expect(passages.toggle?.title).toBe('Library search')
    expect(`${passages.toggle?.title} ${passages.toggle?.summary}`).not.toMatch(/plugin|capability/i)
  })

  it('runs no sweep however long the app stays up, binds nothing, and is not a failure', async () => {
    const sweeping = vi.spyOn(theProgress, 'set')
    const { services, composition } = await launch(new Set(['passages']))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(index.over).not.toHaveBeenCalled()
    expect(sweeping).not.toHaveBeenCalled()
    expect(services.passages()).toBeNull()
    expect(composition.settings).toEqual([])
    expect(composition.failures).toEqual([])
    expect(composition.standing).toEqual([expect.objectContaining({ id: 'passages', state: 'off' })])
    composition.dispose()
    sweeping.mockRestore()
  })

  it('leaves the disk alone, which is where the index stays', async () => {
    const fs = untouchable()
    const { composition } = await launch(new Set(['passages']), fs)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled()
    expect(vi.mocked(fs.remove)).not.toHaveBeenCalled()
    composition.dispose()
  })

  it('comes back whole when it is turned on again: the slot, the settings and the sweep', async () => {
    const sweeping = vi.spyOn(theProgress, 'set')
    const { services, composition } = await launch(new Set())
    expect(services.passages()).not.toBeNull()
    expect(composition.settings.map((one) => one.id)).toEqual(['passages:library-search'])
    expect(composition.standing).toEqual([expect.objectContaining({ id: 'passages', state: 'on' })])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sweeping).toHaveBeenCalledWith(expect.objectContaining({ sweeping: true }))
    composition.dispose()
    sweeping.mockRestore()
  })
})
