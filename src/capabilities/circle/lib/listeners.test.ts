import { describe, expect, it, vi } from 'vitest'
import { createListeners, createTurns, settled, tellEach } from './listeners'

/**
 * The one way a port tells its subscribers — and the one way a callback it
 * does not wait on is held to account, whether it throws or rejects.
 */

describe('telling every listener', () => {
  it('tells each on its own: one that throws does not silence the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const heard = vi.fn()
    tellEach(
      new Set([
        () => {
          throw new Error('down')
        },
        heard,
      ]),
      'test',
    )
    expect(heard).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Paper: a test listener threw', expect.objectContaining({ message: 'down' }))
    warn.mockRestore()
  })

  it('catches a listener that REJECTS — an async function is assignable to a void callback — rather than leaving it unhandled', async () => {
    /* ⚠️ The synchronous `try` caught a throw and let a rejection escape. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      tellEach(new Set([(async () => { throw new Error('later') }) as () => void]), 'test')
      await new Promise((done) => setTimeout(done, 0))
      expect(warn).toHaveBeenCalledWith('Paper: a test listener failed', expect.objectContaining({ message: 'later' }))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      warn.mockRestore()
    }
  })

  it('iterates a copy, so a listener unsubscribing while told does not skip the next', () => {
    const listeners = createListeners('test')
    const second = vi.fn()
    const off = listeners.subscribe(() => off())
    listeners.subscribe(second)
    listeners.tell()
    expect(second).toHaveBeenCalledTimes(1)
    /* Let go: nothing is told after `clear`. */
    listeners.clear()
    listeners.tell()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('settles a callback either way, naming who failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    settled(() => Promise.reject(new Error('no')), 'the reporter')
    await new Promise((done) => setTimeout(done, 0))
    expect(warn).toHaveBeenCalledWith('Paper: the reporter failed', expect.objectContaining({ message: 'no' }))
    settled(() => 'fine', 'the reporter')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('a thenable that is not a Promise', () => {
  it('is caught the same way — a promise from another realm, or a library’s own, fails `instanceof`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const thenable = { then: (_ok: unknown, no: (cause: unknown) => void) => queueMicrotask(() => no(new Error('elsewhere'))) }
    expect(thenable instanceof Promise).toBe(false)
    settled(() => thenable, 'the reporter')
    await new Promise((done) => setTimeout(done, 0))
    expect(warn).toHaveBeenCalledWith('Paper: the reporter failed', expect.objectContaining({ message: 'elsewhere' }))
    warn.mockRestore()
  })
})

describe('turns, one per key', () => {
  it('runs two acts on one key in order, keys apart at once, and lets a turn go once it has settled', async () => {
    const turns = createTurns()
    const order: string[] = []
    let release: (() => void) | null = null
    const first = turns.inTurn('bob', () => new Promise<void>((done) => { release = () => { order.push('first'); done() } }))
    const second = turns.inTurn('bob', async () => { order.push('second') })
    const other = turns.inTurn('carol', async () => { order.push('carol') })
    await other
    expect(order).toEqual(['carol'])
    /* Carol's turn is let go a tick after it settles; Bob's is still held. */
    await new Promise((done) => setTimeout(done, 0))
    expect(turns.pending()).toBe(1)
    release!()
    await first
    await second
    expect(order).toEqual(['carol', 'first', 'second'])
    /* ⚠️ Let go: a port that outlives a thousand acts does not hold a thousand promises. */
    await new Promise((done) => setTimeout(done, 0))
    expect(turns.pending()).toBe(0)
    /* A turn that failed is let go too, and the next act on the key still runs. */
    await expect(turns.inTurn('bob', () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    await expect(turns.inTurn('bob', async () => 'yes')).resolves.toBe('yes')
    await new Promise((done) => setTimeout(done, 0))
    expect(turns.pending()).toBe(0)
  })
})
