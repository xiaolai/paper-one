// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Capability, ReaderContext, ReaderContribution, ReadingSurface } from '../../index'
import { composeCapabilities, kernelApi } from '../../core/registry'
import { createKernelServices } from '../../core/services'
import { ReaderControls, WindowHosts } from './readerContributions'
import { useReadingSurface, type BookFacts, type SurfaceDriver } from './readingSurface'
import { useAutoAdvance, type AutoAdvance } from './useAutoAdvance'

/**
 * What a capability gets from `windowHosts` and `readerControls`, over the real
 * surface and the real auto-advance, the way `App` wires them.
 *
 * ⚠️ **THE CONTRIBUTIONS COME THROUGH A REAL COMPOSITION**, so a renderer reaches
 * these components as the registry hands it over: copied and bound.
 */

afterEach(cleanup)

function page(text: string) {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const doc = frame.contentDocument!
  doc.body.innerHTML = `<p>${text}</p>`
  return doc
}

const SKIP = { notes: false }
const FACTS: Omit<BookFacts, 'doc'> = {
  generation: 1,
  bookId: 'book:1',
  meta: null,
  toc: [],
  fixedLayout: false,
  sectionTexts: async () => ({ sections: [], complete: true }),
}
const PAGING = { next: () => {}, prev: () => {}, nextSection: async () => 'unmoved' as const }

async function mount(capability: Omit<Capability, 'id'>, first: Document | null = page('First.')) {
  const composition = await composeCapabilities(
    [{ id: 'narration', ...capability }],
    kernelApi(createKernelServices({ fs: null, storage: null })),
    new AbortController().signal,
  )
  const api: { driver: SurfaceDriver | null; autoAdvance: AutoAdvance | null; doc: (doc: Document | null) => void } = {
    driver: null,
    autoAdvance: null,
    doc: () => {},
  }
  function Parent() {
    const [doc, setDoc] = useState(first)
    api.doc = setDoc
    const book = useMemo(() => ({ ...FACTS, doc }), [doc])
    const driver = useReadingSurface({ doc, place: { bookId: 'book:1', sectionIndex: 0 }, paging: PAGING, book })
    api.driver = driver
    const paceHeld = useSyncExternalStore(driver.subscribePace, driver.paceHeld)
    api.autoAdvance = useAutoAdvance({
      step: async () => true,
      pace: () => ({ bookWords: 60_000, sectionBytes: 1, spineBytes: 10, steps: 20 }),
      speaking: paceHeld,
      onReader: true,
      generation: 1,
    })
    const context: ReaderContext = { sectionKey: doc, surface: driver.surface }
    return (
      <>
        <WindowHosts hosts={composition.windowHosts} context={context} />
        <ReaderControls controls={composition.readerControls} context={context} />
      </>
    )
  }
  const view = render(<Parent />)
  return { api, view }
}

/** A host that holds the pace for as long as it is mounted and told to. */
function holdingHost(id: `${string}:${string}`) {
  const set: { holding?: (holding: boolean) => void; fail?: () => void } = {}
  function Holder({ surface }: { readonly surface: ReadingSurface }) {
    const [holding, setHolding] = useState(true)
    const [failed, setFailed] = useState(false)
    set.holding = setHolding
    set.fail = () => setFailed(true)
    if (failed) throw new Error('the engine went away')
    useEffect(() => (holding ? surface.holdPace() : undefined), [holding, surface])
    return null
  }
  const host: ReaderContribution = { id, render: ({ surface }) => <Holder surface={surface} /> }
  return { host, set }
}

describe('a window host holding the pace', () => {
  it('refuses the book its own turning until it lets go, and synchronously for whoever asks next', async () => {
    const { host, set } = holdingHost('narration:host')
    const { api } = await mount({ windowHosts: [host] })
    expect(api.driver?.paceHeld()).toBe(true)
    expect(api.autoAdvance?.offered).toBe(false)
    act(() => set.holding?.(false))
    expect(api.driver?.paceHeld()).toBe(false)
    expect(api.autoAdvance?.offered).toBe(true)
  })

  it('stops a book that was already turning itself, which does not start again on release', async () => {
    const { host, set } = holdingHost('narration:host')
    const { api } = await mount({ windowHosts: [host] })
    act(() => set.holding?.(false))
    act(() => api.autoAdvance?.start())
    expect(api.autoAdvance?.advancing).toBe(true)
    act(() => set.holding?.(true))
    expect(api.autoAdvance?.advancing).toBe(false)
    act(() => set.holding?.(false))
    expect(api.autoAdvance?.advancing, 'the reader did not ask for it back').toBe(false)
    expect(api.autoAdvance?.offered).toBe(true)
  })

  it('cannot release another holder: the pace stays held until the last one goes', async () => {
    const one = holdingHost('narration:one')
    const two = holdingHost('narration:two')
    const { api } = await mount({ windowHosts: [one.host, two.host] })
    act(() => one.set.holding?.(false))
    expect(api.autoAdvance?.offered, 'one holder is left').toBe(false)
    act(() => two.set.holding?.(false))
    expect(api.autoAdvance?.offered).toBe(true)
  })

  it('lets go when the window does', async () => {
    const { host } = holdingHost('narration:host')
    const { api, view } = await mount({ windowHosts: [host] })
    const driver = api.driver!
    view.unmount()
    expect(driver.paceHeld()).toBe(false)
  })
})

describe('a window host that falls over', () => {
  it('lets go of the pace, is logged by name, draws nothing, and leaves the others running', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failing = holdingHost('narration:failing')
      const running = holdingHost('narration:running')
      const { api, view } = await mount({ windowHosts: [failing.host, running.host] })
      act(() => running.set.holding?.(false))
      expect(api.driver?.paceHeld(), 'still held by the one about to fail').toBe(true)
      act(() => failing.set.fail?.())
      expect(api.driver?.paceHeld(), 'a hold died with its host').toBe(false)
      expect(said).toHaveBeenCalledWith('Paper: narration:failing failed to draw', expect.any(Error))
      expect(view.container.textContent, 'nowhere to say it: a host has no place in the window').toBe('')
      act(() => running.set.holding?.(true))
      expect(api.driver?.paceHeld(), 'the other host is still there').toBe(true)
    } finally {
      said.mockRestore()
    }
  })

  it('is refused by name when what it answers is nothing React can draw', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await mount({ windowHosts: [{ id: 'narration:host', render: () => ({ not: 'an element' }) }] })
      expect(said).toHaveBeenCalledWith('Paper: narration:host failed to draw', expect.any(Error))
    } finally {
      said.mockRestore()
    }
  })
})

describe('the section, as a contribution sees it', () => {
  it('reaches a host by render, in the commit that shows it, with the surface already answering for it', async () => {
    /* The whole of why a reading can follow the book from outside it: this is the
       same order `useSpeech` depends on (`readingSurface.ts`). */
    const seen: { key: unknown; text: string | undefined }[] = []
    function Follower({ sectionKey, surface }: ReaderContext) {
      useEffect(() => {
        seen.push({ key: sectionKey, text: surface.speakable(SKIP)?.text })
      }, [sectionKey, surface])
      return null
    }
    const first = page('First.')
    const second = page('Second.')
    const { api } = await mount({ windowHosts: [{ id: 'narration:host', render: (context) => <Follower {...context} /> }] }, first)
    act(() => api.doc(second))
    expect(seen.map((one) => one.key)).toEqual([first, second])
    expect(seen.map((one) => one.text?.trim())).toEqual(['First.', 'Second.'])
  })

  it('reaches a control the same way', async () => {
    const first = page('First.')
    const second = page('Second.')
    const { api } = await mount(
      {
        readerControls: [
          { id: 'narration:control', render: ({ sectionKey }) => <span>{sectionKey === first ? 'on first' : 'on another'}</span> },
        ],
      },
      first,
    )
    expect(screen.getByText('on first')).toBeTruthy()
    act(() => api.doc(second))
    expect(screen.getByText('on another')).toBeTruthy()
  })

  it('gives both the one surface for the window’s life, across books', async () => {
    const surfaces = new Set<unknown>()
    const note = ({ surface }: ReaderContext) => {
      surfaces.add(surface)
      return null
    }
    const { api } = await mount({
      windowHosts: [{ id: 'narration:host', render: note }],
      readerControls: [{ id: 'narration:control', render: note }],
    })
    act(() => api.doc(null))
    act(() => api.doc(page('Another.')))
    expect(surfaces.size).toBe(1)
  })
})

describe('a reader control', () => {
  it('draws what it answers, in order', async () => {
    const { view } = await mount({
      readerControls: [
        { id: 'narration:one', render: () => <button type="button">one</button> },
        { id: 'narration:two', render: () => <button type="button">two</button> },
      ],
    })
    expect([...view.container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['one', 'two'])
  })

  it('that falls over says so to the reader and takes nothing with it', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await mount({
        readerControls: [
          {
            id: 'narration:failing',
            render: () => {
              throw new Error('gone')
            },
          },
          { id: 'narration:fine', render: () => <button type="button">fine</button> },
        ],
      })
      expect(screen.getByText('A title bar control could not be drawn. Everything else still works.')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'fine' })).toBeTruthy()
      expect(said).toHaveBeenCalledWith('Paper: narration:failing failed to draw', expect.any(Error))
    } finally {
      said.mockRestore()
    }
  })
})
