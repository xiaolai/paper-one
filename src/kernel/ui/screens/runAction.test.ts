import { describe, expect, it, vi } from 'vitest'
import { runBookAction } from './runAction'

/**
 * The one runner behind the card's fetch button and the book menu. `run` is
 * `void | Promise<void>`: it can throw before it returns anything or reject
 * after it has, and the two surfaces had drifted on which of the two they
 * said. Both are said here, under the action's id, and `settle` runs once
 * either way.
 */
const settled = () => new Promise((done) => setTimeout(done, 0))

describe('runBookAction', () => {
  it('starts the action synchronously and settles once it resolves', async () => {
    const run = vi.fn(() => Promise.resolve())
    const settle = vi.fn()
    runBookAction({ id: 'sync:fetch', run }, 'book:a', settle)
    expect(run).toHaveBeenCalledWith('book:a')
    expect(settle).not.toHaveBeenCalled()
    await settled()
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('says a rejection under the action’s id, and still settles', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const settle = vi.fn()
    runBookAction({ id: 'circle:boom', run: () => Promise.reject(new Error('the port went away')) }, 'book:a', settle)
    await settled()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('circle:boom'), expect.objectContaining({ message: 'the port went away' }))
    expect(settle).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('says a synchronous throw the same way, and settles at once', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const settle = vi.fn()
    runBookAction(
      {
        id: 'circle:early',
        run: () => {
          throw new Error('failed before the promise')
        },
      },
      'book:a',
      settle,
    )
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('circle:early'), expect.objectContaining({ message: 'failed before the promise' }))
    expect(settle).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('needs no settle to run', async () => {
    const run = vi.fn(() => undefined)
    expect(() => runBookAction({ id: 'circle:quiet', run }, 'book:a')).not.toThrow()
    await settled()
    expect(run).toHaveBeenCalledTimes(1)
  })
})
