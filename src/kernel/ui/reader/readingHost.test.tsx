// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostStore, HostedTitleBar, ReadingHost, useHosted, type Hosted, type HostStore } from './readingHost'
import { useReadingSurface, type BookFacts, type SurfaceDriver } from './readingSurface'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'
import { useAutoAdvance, type AutoAdvance } from './useAutoAdvance'
import type { TitleBarProps } from '../shell/TitleBar'

/* THE TITLE BAR IS A CONSUMER HERE AND NOTHING MORE: its own cases read its
   controls. What is asked of it is that it is handed the live transport. */
vi.mock('../shell/TitleBar', () => ({
  TitleBar: ({ speech, bookTitle }: { speech: { speaking: boolean }; bookTitle: string }) => (
    <div data-testid="bar">
      {bookTitle}:{speech.speaking ? 'speaking' : 'silent'}
    </div>
  ),
}))
let synth: FakeSynth
const originalUtterance = globalThis.SpeechSynthesisUtterance

beforeEach(() => {
  synth = new FakeSynth()
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true })
  window.SpeechSynthesisUtterance = FakeUtterance as unknown as typeof SpeechSynthesisUtterance
})

afterEach(() => {
  cleanup()
  delete (window as { speechSynthesis?: unknown }).speechSynthesis
  window.SpeechSynthesisUtterance = originalUtterance
})

function page(text: string) {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const doc = frame.contentDocument!
  doc.documentElement.setAttribute('lang', 'en')
  doc.body.innerHTML = `<p>${text}</p>`
  return doc
}

const hosted = (speaking: boolean): Hosted => ({ speech: { speaking } as Hosted['speech'] })

describe('the store', () => {
  it('has nothing until the host has published', () => {
    expect(createHostStore().read()).toBeNull()
  })

  it('tells each listener, until it stops listening', () => {
    const store = createHostStore()
    const one = vi.fn()
    const two = vi.fn()
    const off = store.subscribe(one)
    store.subscribe(two)
    const value = hosted(true)
    store.publish(value)
    expect(store.read()).toBe(value)
    expect(one).toHaveBeenCalledTimes(1)
    off()
    store.publish(hosted(false))
    expect(one).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(2)
  })

  it('still tells the rest, and holds the value, when a listener throws', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createHostStore()
    const after = vi.fn()
    store.subscribe(() => {
      throw new Error('a broken subscriber')
    })
    store.subscribe(after)
    const value = hosted(true)
    store.publish(value)
    expect(store.read()).toBe(value)
    expect(after).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0]?.[0]).toBe('Paper: a reading host subscriber threw while being notified')
    logged.mockRestore()
  })
})

describe('a value from the store', () => {
  const speakingOf = (value: Hosted | null) => value?.speech.speaking ?? null

  function Reader({ store }: { store: HostStore }) {
    return <output>{String(useHosted(store, speakingOf))}</output>
  }

  it('is what the store held at mount', () => {
    const store = createHostStore()
    store.publish(hosted(true))
    render(<Reader store={store} />)
    expect(screen.getByRole('status').textContent).toBe('true')
  })

  it('catches a publish made in the same commit, by something earlier in the tree', () => {
    /* WHY THE HOST COMES FIRST: this reader rendered before it published, and it
       has no later publish to wait for. */
    const store = createHostStore()
    function Earlier() {
      useLayoutEffect(() => store.publish(hosted(true)), [])
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
    const store = createHostStore()
    const view = render(<Reader store={store} />)
    expect(screen.getByRole('status').textContent).toBe('null')
    act(() => store.publish(hosted(false)))
    expect(screen.getByRole('status').textContent).toBe('false')
    view.unmount()
    expect(() => store.publish(hosted(true))).not.toThrow()
  })

  it('is right on the first render, not only after the layout effect', () => {
    /* A first render with nothing in it is what `useState`'s initialiser is
       there to prevent: the layout effect would correct it before paint, but a
       consumer that renders nothing on `null` would have rendered nothing. */
    const store = createHostStore()
    store.publish(hosted(true))
    const seen: unknown[] = []
    function Recorder() {
      const value = useHosted(store, speakingOf)
      seen.push(value)
      return null
    }
    render(<Recorder />)
    expect(seen[0]).toBe(true)
  })

  it('follows a different store when it is handed one', () => {
    const one = createHostStore()
    one.publish(hosted(true))
    const two = createHostStore()
    two.publish(hosted(false))
    const view = render(<Reader store={one} />)
    expect(screen.getByRole('status').textContent).toBe('true')
    view.rerender(<Reader store={two} />)
    expect(screen.getByRole('status').textContent).toBe('false')
    act(() => two.publish(hosted(true)))
    expect(screen.getByRole('status').textContent, 'and listens to it').toBe('true')
  })
})


/* Only `bookTitle` is read, by the stand-in above. */
const TITLE_BAR = { bookTitle: 'Le Horla' } as unknown as Omit<TitleBarProps, 'speech'>

const NO_FACTS: Omit<BookFacts, 'doc' | 'sectionTexts'> = {
  generation: 1,
  bookId: 'book:1',
  meta: { title: 'Le Horla', author: 'Maupassant' },
  toc: [],
  fixedLayout: false,
}

/**
 * What `App` does with the host: the surface committed by the parent, the host
 * first among its children, and the auto-advance reading the pace.
 */
function mount(first: Document | null) {
  const store = createHostStore()
  const api: { driver: SurfaceDriver | null; autoAdvance: AutoAdvance | null } = { driver: null, autoAdvance: null }
  const set: { doc?: (doc: Document | null) => void } = {}
  const paging = { next: () => {}, prev: () => {} }
  const walk: BookFacts['sectionTexts'] = async () => ({ sections: [], complete: true })
  function Parent() {
    const [doc, setDoc] = useState(first)
    set.doc = setDoc
    const book = useMemo(() => ({ ...NO_FACTS, doc, sectionTexts: walk }), [doc])
    const driver = useReadingSurface({ doc, place: { bookId: 'book:1', sectionIndex: 0 }, paging, book })
    api.driver = driver
    const paceHeld = useSyncExternalStore(driver.subscribePace, driver.paceHeld)
    api.autoAdvance = useAutoAdvance({
      step: async () => true,
      pace: () => ({ bookWords: 60_000, sectionBytes: 1, spineBytes: 10, steps: 20 }),
      speaking: paceHeld,
      onReader: true,
      generation: NO_FACTS.generation,
    })
    return (
      <>
        <ReadingHost
          context={{ sectionKey: doc, surface: driver.surface }}
          prefs={{ notesAloud: false }}
          engine={null}
          store={store}
        />
        <HostedTitleBar store={store} {...TITLE_BAR} />
      </>
    )
  }
  const view = render(<Parent />)
  return {
    store,
    api,
    set,
    view,
    speech: () => store.read()!.speech,
    bar: () => screen.getByTestId('bar').textContent,
  }
}

describe('the host', () => {
  it('has published by the time the first commit is over', () => {
    const { store, bar } = mount(page('Words.'))
    expect(store.read()?.speech.available).toBe(true)
    expect(bar(), 'the title bar is there').toBe('Le Horla:silent')
  })

  it('reaches the title bar when a reading starts and when it stops', () => {
    const { speech, bar } = mount(page('Words.'))
    act(() => speech().start())
    expect(bar()).toBe('Le Horla:speaking')
    act(() => speech().stop())
    expect(bar()).toBe('Le Horla:silent')
  })

  it('reads the document the surface committed, and the next one', () => {
    const { speech, set } = mount(page('First section.'))
    act(() => speech().start())
    expect(synth.queued.at(-1)?.text).toContain('First')
    act(() => set.doc?.(page('Second section.')))
    expect(synth.queued.at(-1)?.text, 'a chapter turn is a step in the reading').toContain('Second')
    expect(speech().speaking).toBe(true)
  })
})

describe('the pace, as the book’s own turning sees it', () => {
  it('gives the book up when a reading starts, and is not offered during one', () => {
    const { speech, api } = mount(page('Words. More words.'))
    act(() => api.autoAdvance?.start())
    expect(api.autoAdvance?.advancing).toBe(true)
    act(() => speech().start())
    expect(api.autoAdvance?.advancing).toBe(false)
    expect(api.autoAdvance?.offered).toBe(false)
  })

  it('stays refused through a pause, and comes back when the reading ends', () => {
    const { speech, api } = mount(page('Words. More words.'))
    act(() => speech().start())
    act(() => speech().pause())
    expect(api.driver?.paceHeld(), 'paused').toBe(true)
    expect(api.autoAdvance?.offered).toBe(false)
    act(() => speech().stop())
    expect(api.driver?.paceHeld()).toBe(false)
    expect(api.autoAdvance?.offered).toBe(true)
  })

  it('is let go when the book closes under a reading', () => {
    const { speech, api, set } = mount(page('Words.'))
    act(() => speech().start())
    act(() => set.doc?.(null))
    expect(api.driver?.paceHeld()).toBe(false)
  })

  it('lets go when the host goes', () => {
    const { speech, api, view } = mount(page('Words.'))
    act(() => speech().start())
    const driver = api.driver!
    view.unmount()
    expect(driver.paceHeld()).toBe(false)
  })
})
