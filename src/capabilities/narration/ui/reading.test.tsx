// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReadingStore, useReading, whole, type Reading, type ReadingStore } from './reading'
import type { Speech } from './useSpeech'

afterEach(cleanup)

/* Only `speech.speaking` is read here, by `speakingOf`; the store carries the
   value through without looking inside it. */
const reading = (speaking: boolean): Reading => ({
  speech: { speaking } as Speech,
  listenRefusal: null,
  hasBook: true,
  lang: 'en',
  voices: [],
  packs: [],
})

describe('the store', () => {
  it('has nothing until the host has published', () => {
    expect(createReadingStore().read()).toBeNull()
  })

  it('tells each listener, until it stops listening', () => {
    const store = createReadingStore()
    const one = vi.fn()
    const two = vi.fn()
    const off = store.subscribe(one)
    store.subscribe(two)
    const value = reading(true)
    store.publish(value)
    expect(store.read()).toBe(value)
    expect(one).toHaveBeenCalledTimes(1)
    off()
    store.publish(reading(false))
    expect(one).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(2)
  })

  it('still tells the rest, and holds the value, when a listener throws', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createReadingStore()
    const after = vi.fn()
    store.subscribe(() => {
      throw new Error('a broken subscriber')
    })
    store.subscribe(after)
    const value = reading(true)
    store.publish(value)
    expect(store.read()).toBe(value)
    expect(after).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0]?.[0]).toBe('Paper: a reading host subscriber threw while being notified')
    logged.mockRestore()
  })

  it('has nothing again once the host withdraws, and says so', () => {
    /* A host that has gone said things that no longer hold: a Listen control
       still drawing its last reading would offer a press nothing answers. */
    const store = createReadingStore()
    const told = vi.fn()
    store.publish(reading(true))
    store.subscribe(told)
    store.withdraw()
    expect(store.read()).toBeNull()
    expect(told).toHaveBeenCalledTimes(1)
  })

  it('hands back the whole reading, as published', () => {
    const value = reading(false)
    expect(whole(value)).toBe(value)
    expect(whole(null)).toBeNull()
  })
})

describe('a value from the store', () => {
  const speakingOf = (value: Reading | null) => value?.speech.speaking ?? null

  function Reader({ store }: { store: ReadingStore }) {
    return <output>{String(useReading(store, speakingOf))}</output>
  }

  it('is what the store held at mount', () => {
    const store = createReadingStore()
    store.publish(reading(true))
    render(<Reader store={store} />)
    expect(screen.getByRole('status').textContent).toBe('true')
  })

  it('catches a publish made in the same commit, by something earlier in the tree', () => {
    /* WHY THE HOST COMES FIRST: this reader rendered before it published, and it
       has no later publish to wait for. */
    const store = createReadingStore()
    function Earlier() {
      useLayoutEffect(() => store.publish(reading(true)), [])
      return null
    }
    render(
      <>
        <Earlier />
        <Reader store={store} />
      </>,
    )
    expect(screen.getByRole('status').textContent).toBe('true')
  })

  it('follows a later publish, and stops following at unmount', () => {
    const store = createReadingStore()
    const view = render(<Reader store={store} />)
    expect(screen.getByRole('status').textContent).toBe('null')
    act(() => store.publish(reading(false)))
    expect(screen.getByRole('status').textContent).toBe('false')
    act(() => store.withdraw())
    expect(screen.getByRole('status').textContent, 'and a withdrawal').toBe('null')
    view.unmount()
    expect(() => store.publish(reading(true))).not.toThrow()
  })

  it('is right on the first render, not only after the layout effect', () => {
    /* A first render with nothing in it is what `useState`'s initialiser is
       there to prevent: the layout effect would correct it before paint, but a
       consumer that renders nothing on `null` would have rendered nothing. */
    const store = createReadingStore()
    store.publish(reading(true))
    const seen: unknown[] = []
    function Recorder() {
      const value = useReading(store, speakingOf)
      seen.push(value)
      return null
    }
    render(<Recorder />)
    expect(seen[0]).toBe(true)
  })

  it('follows a different store when it is handed one', () => {
    const one = createReadingStore()
    one.publish(reading(true))
    const two = createReadingStore()
    two.publish(reading(false))
    const view = render(<Reader store={one} />)
    expect(screen.getByRole('status').textContent).toBe('true')
    view.rerender(<Reader store={two} />)
    expect(screen.getByRole('status').textContent).toBe('false')
    act(() => two.publish(reading(true)))
    expect(screen.getByRole('status').textContent, 'and listens to it').toBe('true')
  })
})
