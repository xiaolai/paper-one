// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexFs, IndexedBook } from '../core/bookIndex'
import { META_SCHEMA, folderOf } from '../core/bookFolder'
import type { GlossContext, GlossProvider } from '../core/gloss'
import { bookIdFor } from '../core/marks'
import { fakeFs } from '../core/indexFsFake.testkit'
import { composeCapabilities, kernelApi } from '../core/registry'
import { createKernelServices } from '../core/services'

/**
 * Look up, as `App` wires it (phase 17) — the palette row, ⌃⌘D, Escape, the
 * install route, the answer language and what the provider is handed.
 *
 * ⚠️ **TWO HOOKS ARE WRAPPED, AND NEITHER IS REPLACED.** jsdom cannot parse a
 * book, so the reader never publishes a selection and never draws the selection
 * popup (a book in error replaces the stage). The wrappers run the REAL hooks
 * and only keep hold of two things: `setSelection`, which is exactly what the
 * session calls when the reader selects a passage, and the `LookUp` App built,
 * whose `onInstall` is exactly what the popup's "Install one" calls. Everything
 * between those two and the screen — the anchor, the press, the gloss, the
 * history, Settings — is the production code.
 */

const probe = vi.hoisted(() => ({
  setSelection: null as ((selection: import('./reader/session').SelectionSnapshot | null) => void) | null,
  lookUp: null as import('./hooks/useLookUp').LookUp | null,
  /** The book `App` last handed the lookup — null until the open book's id has landed. */
  reading: null as import('./hooks/useLookUp').LookUpOptions['reading'],
}))

vi.mock('./hooks/useMarking', async (importActual) => {
  const actual = await importActual<typeof import('./hooks/useMarking')>()
  return {
    ...actual,
    useMarking: (...args: Parameters<typeof actual.useMarking>) => {
      const marking = actual.useMarking(...args)
      probe.setSelection = marking.setSelection
      return marking
    },
  }
})

vi.mock('./hooks/useLookUp', async (importActual) => {
  const actual = await importActual<typeof import('./hooks/useLookUp')>()
  return {
    ...actual,
    useLookUp: (...args: Parameters<typeof actual.useLookUp>) => {
      const lookUp = actual.useLookUp(...args)
      probe.lookUp = lookUp
      probe.reading = args[0].reading
      return lookUp
    },
  }
})

import { App } from './App'

/* jsdom has no `scrollIntoView` (the palette's active row calls it) and no
   `ResizeObserver` (the reader measures its stage with one). */
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

const passages: HTMLElement[] = []

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const passage of passages.splice(0)) passage.remove()
  probe.setSelection = null
  probe.lookUp = null
  probe.reading = null
})

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0))
  })

const WILL_NOT_PARSE = 'File type not supported'
const LOOK_UP_ROW = 'Look up the selection'
const NEEDS_A_MODEL = 'Paper needs a language model to define “Ishmael”.'
const MODELS_BODY = 'Where a model is installed from'
const DEFINITION = 'the name the narrator asks to be called by'
const CFI = 'epubcfi(/6/4!/4/2,/1:8,/1:15)'

/** A build with `inference` composed and no model downloaded: nothing can define, and there is somewhere to go. */
const UNINSTALLED: GlossProvider = {
  available: false,
  installAt: 'inference:models',
  gloss: () => Promise.reject(new Error('nothing is installed to define with')),
}

/** The accelerator is Ctrl off macOS, and jsdom's user agent is nobody's Mac. */
const accel = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true })
/** ⌃⌘D off a Mac — Ctrl+Shift+D, on the physical key. Returns false when the window TOOK the key. */
const lookUpChord = () => fireEvent.keyDown(window, { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })
const escape = () => fireEvent.keyDown(window, { key: 'Escape' })

/** The whole window, with `inference`'s models section contributed so a reveal has somewhere to land. */
async function mount(fs: IndexFs | null, over: { readonly books?: readonly IndexedBook[]; readonly gloss?: GlossProvider } = {}) {
  const services = createKernelServices({ fs, storage: null, initialBooks: over.books ?? [] })
  if (over.gloss) services.bindGloss(over.gloss)
  const composition = await composeCapabilities(
    [
      {
        id: 'inference',
        settings: [{ id: 'inference:models', title: 'Local models', render: () => <p>{MODELS_BODY}</p> }],
      },
    ],
    kernelApi(services),
    new AbortController().signal,
  )
  render(<App services={services} fs={fs} composition={composition} />)
  await settle()
  return services
}

/** Moby-Dick opened from the shelf into the reader: an identity the shelf knows, and bytes jsdom cannot parse. */
async function readingMoby(gloss?: GlossProvider) {
  const BYTES = 'not really an epub'
  const bookId = await bookIdFor(new File([BYTES], 'content.epub'))
  const fs = fakeFs({
    [`${folderOf(bookId)}/book.json`]: JSON.stringify({ title: 'Moby-Dick', author: 'Herman Melville' }),
    [`${folderOf(bookId)}/content.epub`]: BYTES,
  }) as unknown as IndexFs
  const moby: IndexedBook = { bookId, title: 'Moby-Dick', author: 'Herman Melville', hasContent: true }
  const services = await mount(fs, { books: [moby], ...(gloss ? { gloss } : {}) })
  fireEvent.click(screen.getByTitle('Open Moby-Dick'))
  expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
  /* ⚠️ **AND THE BOOK'S ID, WHICH THE REFUSAL SAYS NOTHING ABOUT** (2026-09-15).
     The id is a SHA-256 digest that lands on libuv's thread pool whenever it
     lands, and jsdom refuses the bytes long before: one turn after the refusal
     was enough on an idle machine, and with every digest slowed by 40 ms five
     tests here found no book to look anything up in, and no row to tag. Waited
     for, the way `App.test.tsx`'s `pressUntilTaken` waits — for the state, not
     for a number of turns. */
  await waitFor(() => expect(probe.reading?.bookId, 'the open book’s id never landed').toBe(bookId), { timeout: 15_000 })
  await settle()
  return { services, bookId }
}

/** The empty reader: the reader screen, with no book in it. */
async function readingNothing(gloss?: GlossProvider) {
  const services = await mount(null, gloss ? { gloss } : {})
  fireEvent.click(screen.getByRole('button', { name: 'Open a book' }))
  await settle()
  return services
}

/** Select "Ishmael" in a passage with no `lang` — published the way the session publishes a selection. */
async function selectIshmael() {
  const passage = document.createElement('p')
  passage.textContent = 'Call me Ishmael. Some years ago I thought I would sail about a little.'
  document.body.append(passage)
  passages.push(passage)
  const range = document.createRange()
  range.setStart(passage.firstChild!, 8)
  range.setEnd(passage.firstChild!, 15)
  expect(range.toString()).toBe('Ishmael')
  act(() => {
    probe.setSelection!({ cfi: CFI, sectionIndex: 1, text: 'Ishmael', prefix: 'Call me ', suffix: '. Some years ago', range })
  })
  await settle()
}

async function openPalette(query: string) {
  accel('k')
  await settle()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search or ask' }), { target: { value: query } })
  await settle()
}

async function runCommand(query: string, label: string) {
  await openPalette(query)
  fireEvent.click(screen.getByText(label).closest('button')!)
  await settle()
}

/** Settings, with its closed-at-rest "Look up" group opened — or null when there is no such group. */
async function lookUpSettings(): Promise<HTMLSelectElement | null> {
  await runCommand('Settings', 'Open Settings')
  const group = screen.queryByRole('button', { name: 'Look up' })
  if (group === null) return null
  fireEvent.click(group)
  await settle()
  return screen.getByRole('combobox', { name: /^Define words in/u }) as HTMLSelectElement
}

describe('starting a lookup', () => {
  it('offers “Look up the selection” in the palette only with a selection in a book being read, and runs the one press', async () => {
    await readingMoby(UNINSTALLED)
    /* Open BEFORE the lookup starts, so the lookup turns the panel to it. */
    accel('2')
    await settle()

    await openPalette('Look up')
    expect(screen.queryByText(LOOK_UP_ROW)).toBeNull()
    escape()
    await settle()

    await selectIshmael()
    await runCommand('Look up', LOOK_UP_ROW)
    expect(probe.lookUp!.state).toEqual({ kind: 'unavailable', term: 'Ishmael', installAt: 'inference:models' })
    expect(screen.getByText(NEEDS_A_MODEL)).toBeTruthy()
  })

  it('looks the selection up on the chord, and with nothing selected leaves the key to the platform', async () => {
    await readingMoby(UNINSTALLED)
    accel('2')
    await settle()

    /* NOT TAKEN — on macOS the chord is the system's own Look Up, and a key
       swallowed to do nothing takes that away. */
    expect(lookUpChord()).toBe(true)
    await settle()
    expect(probe.lookUp!.state).toEqual({ kind: 'idle' })
    expect(screen.queryByText(NEEDS_A_MODEL)).toBeNull()

    await selectIshmael()
    expect(lookUpChord()).toBe(false)
    await settle()
    expect(probe.lookUp!.state).toEqual({ kind: 'unavailable', term: 'Ishmael', installAt: 'inference:models' })
    expect(screen.getByText(NEEDS_A_MODEL)).toBeTruthy()
  })

  it('offers nothing to look up in a reader with no book, whatever is selected', async () => {
    /* No book, no identity to file a lookup under and no anchor to hold it to —
       so no press, and neither the key nor the palette acts on the selection. */
    await readingNothing(UNINSTALLED)
    await selectIshmael()
    expect(probe.lookUp!.press).toBeNull()
    expect(lookUpChord()).toBe(true)
    await openPalette('Look up')
    expect(screen.queryByText(LOOK_UP_ROW)).toBeNull()
  })
})

describe('Escape', () => {
  it('closes an open layer first, and puts the lookup away only once no layer is open', async () => {
    await readingMoby(UNINSTALLED)
    accel('2')
    await settle()
    await selectIshmael()
    lookUpChord()
    await settle()
    expect(screen.getByText(NEEDS_A_MODEL)).toBeTruthy()

    accel('k')
    await settle()
    expect(screen.getByRole('textbox', { name: 'Search or ask' })).toBeTruthy()
    escape()
    await settle()
    /* The palette, and only the palette. */
    expect(screen.queryByRole('textbox', { name: 'Search or ask' })).toBeNull()
    expect(probe.lookUp!.state.kind).toBe('unavailable')
    expect(screen.getByText(NEEDS_A_MODEL)).toBeTruthy()

    escape()
    await settle()
    expect(probe.lookUp!.state).toEqual({ kind: 'idle' })
    expect(screen.queryByText(NEEDS_A_MODEL)).toBeNull()
  })

  /* ⚠️ **AND IT LEAVES AN IDLE ONE ALONE.** `dismiss` publishes a new idle
     state, which is a new `LookUp` object, and the keyboard map's effect lists
     that object — so dismissing what is already put away took the window's
     listener down and registered it again, on every Escape pressed with
     nothing on screen (2026-09-14). */
  it('does not rebuild the keyboard map for an Escape with nothing to put away', async () => {
    await readingMoby(UNINSTALLED)
    expect(probe.lookUp!.state).toEqual({ kind: 'idle' })
    const added = vi.spyOn(window, 'addEventListener')

    escape()
    await settle()
    expect(added.mock.calls.filter(([type]) => type === 'keydown')).toEqual([])
    expect(probe.lookUp!.state).toEqual({ kind: 'idle' })
  })
})

describe('“Install one”', () => {
  it('opens Settings with the section the provider named already open', async () => {
    await readingMoby(UNINSTALLED)
    await selectIshmael()
    lookUpChord()
    await settle()
    const said = probe.lookUp!.state
    if (said.kind !== 'unavailable' || said.installAt === null) throw new Error(`expected an install offer, got ${JSON.stringify(said)}`)
    /* Closed at rest, and Settings is not the panel on screen. */
    expect(screen.queryByText(MODELS_BODY)).toBeNull()

    /* What the popup's button does with the state it is drawing. */
    act(() => probe.lookUp!.onInstall!(said.installAt!))
    await settle()
    expect(screen.getByRole('button', { name: 'Local models' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(MODELS_BODY)).toBeTruthy()
  })
})

describe('the answer', () => {
  it('asks in the reader’s language, then in the one chosen in Settings, and files each answer under the open book', async () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('fr-FR')
    const gloss = vi.fn((_term: string, _context: GlossContext, _signal: AbortSignal) => Promise.resolve(DEFINITION))
    const { services, bookId } = await readingMoby({ available: true, installAt: null, gloss })
    accel('2')
    await settle()
    await selectIshmael()

    expect(lookUpChord()).toBe(false)
    await settle()
    expect(gloss).toHaveBeenCalledTimes(1)
    const [term, context, signal] = gloss.mock.calls[0]!
    expect(term).toBe('Ishmael')
    expect(context.sentence).toContain('Ishmael')
    /* What the SESSION reported of the book — nothing, since jsdom parses none —
       and not the shelf's title: `bookTitle` is never absent, only empty. */
    expect(context.bookTitle).toBe('')
    expect(context.answerIn.map((one) => one.tag)).toEqual(['fr'])
    expect(signal).toBeInstanceOf(AbortSignal)
    /* The Dictionary view draws it twice: as the lookup happening now, and as
       the history row the answer was filed into. */
    expect(screen.getByText('Looked up').closest('[role="status"]')?.textContent).toContain(DEFINITION)
    expect(screen.getAllByText(DEFINITION)).toHaveLength(2)

    const filed = services.lookups.getSnapshot().all
    expect(filed.map((one) => one.term)).toEqual(['ishmael'])
    expect(filed[0]!.occurrences).toEqual([
      expect.objectContaining({ bookId, cfi: CFI, spelled: 'Ishmael', gloss: DEFINITION, language: 'fr' }),
    ])

    const choice = await lookUpSettings()
    expect(choice?.value).toBe('reader')
    expect(screen.getByRole('option', { name: 'Your language — Français' })).toBeTruthy()
    fireEvent.change(choice!, { target: { value: 'de' } })
    await settle()
    expect((screen.getByRole('combobox', { name: /^Define words in/u }) as HTMLSelectElement).value).toBe('de')

    expect(lookUpChord()).toBe(false)
    await settle()
    expect(gloss).toHaveBeenCalledTimes(2)
    expect(gloss.mock.calls[1]![1].answerIn.map((one) => one.tag)).toEqual(['de'])
    expect(services.lookups.getSnapshot().all[0]!.occurrences[0]).toEqual(expect.objectContaining({ bookId, cfi: CFI, language: 'de' }))
  })

  it('offers the answer-language row only where there is a Look up — a model, or somewhere to install one', async () => {
    const cases: readonly (readonly [GlossProvider | undefined, boolean])[] = [
      /* The port's own default: no model, and nowhere to get one. */
      [undefined, false],
      [UNINSTALLED, true],
      [{ available: true, installAt: null, gloss: () => Promise.resolve(DEFINITION) }, true],
    ]
    for (const [gloss, offered] of cases) {
      await readingNothing(gloss)
      expect(await lookUpSettings() !== null).toBe(offered)
      cleanup()
    }
  })

  it('draws the window on a host with no `navigator` at all, and names English as the reader’s language', async () => {
    /* The platform is pinned so the chrome does not have to sniff a user agent
       either — what is under test is Look up's own read of the locale. */
    window.history.replaceState(null, '', '/?platform=linux')
    try {
      vi.stubGlobal('navigator', undefined)
      await readingNothing(UNINSTALLED)
      expect(typeof navigator).toBe('undefined')
      await lookUpSettings()
      expect(screen.getByRole('option', { name: 'Your language — English' })).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
      window.history.replaceState(null, '', '/')
    }
  })
})

describe('the lookup’s identity', () => {
  /* ⚠️ **`onInstall` WAS AN INLINE ARROW** (2026-09-13 audit), so `useLookUp`
     returned a new object on every render of `App` — and the keyboard map's
     effect lists `lookUp`, so it took its window listener down and put it back
     on every render, a keystroke in the shelf's search included. */
  it('does not rebuild the keyboard map on a render that changes nothing it reads', async () => {
    const BYTES = 'not really an epub'
    const bookId = await bookIdFor(new File([BYTES], 'content.epub'))
    const fs = fakeFs({
      [`${folderOf(bookId)}/book.json`]: JSON.stringify({ title: 'Moby-Dick', author: 'Herman Melville' }),
      [`${folderOf(bookId)}/content.epub`]: BYTES,
    }) as unknown as IndexFs
    await mount(fs, {
      books: [{ bookId, title: 'Moby-Dick', author: 'Herman Melville', hasContent: true, parsedAt: 1, metaSchema: META_SCHEMA }],
      gloss: UNINSTALLED,
    })
    const added = vi.spyOn(window, 'addEventListener')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the library' }), { target: { value: 'whale' } })
    await settle()

    expect(screen.getByText(/Nothing matches/u), 'the render happened').toBeTruthy()
    expect(added.mock.calls.filter(([type]) => type === 'keydown')).toEqual([])
  })
})

describe('the open book’s own commands', () => {
  it('are offered only while the reader is the screen — the reader stays mounted under the shelf', async () => {
    await readingMoby()
    await openPalette('Tags')
    expect(screen.getByText('Tags for this book…')).toBeTruthy()
    escape()
    await settle()

    /* ⌘L — up to the shelf, with the reader and its book still mounted beneath. */
    accel('l')
    await settle()
    expect(screen.getByTitle('Open Moby-Dick')).toBeTruthy()
    await openPalette('Tags')
    expect(screen.queryByText('Tags for this book…')).toBeNull()
  })
})
