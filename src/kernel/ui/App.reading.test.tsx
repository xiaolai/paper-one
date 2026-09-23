// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexFs, IndexedBook } from '../core/bookIndex'
import type { BookMeta, ReaderPosition } from '../core/bookMeta'
import type { MutationRecorder } from '../core/ports'
import type { SelectionSnapshot } from './reader/session'
import { META_SCHEMA, folderOf } from '../core/bookFolder'
import { bookIdFor } from '../core/marks'
import { fakeFs } from '../core/indexFsFake.testkit'
import { composeCapabilities, kernelApi } from '../core/registry'
import { createKernelServices } from '../core/services'
import { SETTINGS_STORAGE_KEY, SETTINGS_VERSION } from '../core/settings'

/**
 * `App` WITH A BOOK THAT ACTUALLY OPENS — the half of this window no test could
 * reach before.
 *
 * jsdom cannot run foliate: `<foliate-view>` is a custom element that
 * paginates into a layout there is none of, so every other suite over this
 * component watches a book fail to parse. Everything `App` coordinates AFTER a
 * book is open was therefore unreachable — the jump stack and its "← Back to …"
 * line, the rollback a failed cross-book open takes back, marking and
 * bookmarking from the keyboard, the jacket, the reading position, and what an
 * import writes into the shelf.
 *
 * ⚠️ **THE STAND-IN IS THE RENDERER, AND NOTHING ABOVE IT.** `ReaderSession` is
 * the seam where this app meets foliate — the same boundary
 * `FoliateView.session.test.tsx` stands in at, and for the same reason. It
 * publishes what a real session publishes (a navigator, the metadata, a
 * position) and records what it was asked to do; every line between it and the
 * screen is the production code, `App`'s own most of all.
 *
 * ⚠️ **AND NOTHING HERE COUNTS TURNS.** A book's id is a SHA-256 digest, which
 * lands on libuv's thread pool whenever it lands; a copy is a digest and a
 * write. This file waited a fixed number of macrotasks for them and one of its
 * neighbours failed another subject's dry run under instrumentation that way
 * (2026-09-15). Every wait now names the state it is waiting for — see
 * `eventually` and `open`.
 */

interface Publishing {
  source: unknown
  /** What the host had decided this book should open AT — read once, when a real session parses. */
  lastLocation: string | null
  readonly goTo: string[]
  readonly turns: string[]
  /** Every walk of this book for marks with no anchor in it. */
  readonly reanchored: { id: string }[][]
  /** The session has published — its book open, or refused. */
  published: boolean
}

const reader = vi.hoisted(() => ({
  /** Every book opened, in order. */
  opened: [] as Publishing[],
  /** The session on screen, for a test that drives it. */
  live: null as null | {
    relocate(cfi: string, chapter?: string): void
    select(snapshot: unknown): void
    overlays(): readonly unknown[]
    link(detail: unknown, event: Event): void
    external(detail: unknown, event: Event): void
    fail(message: string): void
  },
  /** The chapter every relocation reports itself in. */
  chapter: 'Loomings',
  /** The contents href every relocation reports itself at — `''` for a section
   *  the contents does not name, which is a real place to be. */
  chapterHref: 'chapter-1.xhtml',
  /** The author every book declares. */
  author: 'Herman Melville',
  /** The contents every book publishes. */
  toc: [] as { label: string; href: string }[],
  /** The prose the section on screen holds, or null for a book that publishes
   *  no document — which is what read-aloud has nothing to say about. */
  prose: null as string | null,
  /** What the section DECLARES, which is the only thing a pack can match on:
      `documentLang` reads `<html lang>` and `packsFor` answers nothing for a
      book that declares none. Null keeps every case that predates the packs
      exactly as it was. */
  lang: null as string | null,
  /** A jacket, for the one effect that files it. */
  cover: null as Blob | null,
  /** How many of the next opens fail the way a book the reader cannot see fails. */
  refuse: 0,
  /** Whether the session can pin down where the reader is — `ReaderSession.placeHere` answers null when it cannot. */
  pinned: true,
}))

/* THE PARSER IS FOLIATE'S TOO — the background pass reads a book with it, and
   in jsdom nothing parses. Held open by name so a test can put the pass and an
   import in an order. */
const parses = vi.hoisted(() => ({
  names: [] as string[],
  armed: false,
  waiting: [] as (() => void)[],
}))
vi.mock('./reader/parseBook', () => ({
  parseBook: async (file: File) => {
    parses.names.push(file.name)
    if (parses.armed) await new Promise<void>((go) => parses.waiting.push(go))
    return {
      meta: {
        pageCount: 0,
        title: `Parsed ${file.name.replace(/\.[^.]+$/u, '')}`,
        author: 'Herman Melville',
        identifier: '',
        sortAs: '',
        series: '',
        seriesIndex: null,
        subjects: [],
        publisher: '',
        published: '',
        languages: [],
        description: '',
        subtitle: '',
      },
      cover: null,
    }
  },
}))

/* THE READER'S OWN FILES — the origin fallback reads them, and so does a
   launch. Recorded, refused and held by path, because which of the three a
   book takes is the whole subject below. */
const disk = vi.hoisted(() => ({
  read: [] as string[],
  refuse: new Set<string>(),
  hold: new Set<string>(),
  waiting: [] as (() => void)[],
}))
vi.mock('../core/bookFiles', async (importActual) => ({
  ...(await importActual<typeof import('../core/bookFiles')>()),
  readBookAt: async (path: string) => {
    disk.read.push(path)
    if (disk.hold.has(path)) await new Promise<void>((go) => disk.waiting.push(go))
    if (disk.refuse.has(path)) throw new Error(`no such file: ${path}`)
    /* The book the ROW names, so a copy found this way is the same book as far
       as its identity — and the reader's own place in it — is concerned. */
    return new File(['another book entirely'], 'content.epub')
  },
}))

/* THE SHELL, for the two things here that ask it: whether a link may leave the
   app, and the window the titlebar draws its controls for. Inert until a test
   says this is Tauri — `inTauri` reads a global. */
const shell = vi.hoisted(() => ({ invoked: [] as string[] }))
vi.mock('@tauri-apps/api/core', async (importActual) => ({
  ...(await importActual<typeof import('@tauri-apps/api/core')>()),
  invoke: async (command: string) => {
    shell.invoked.push(command)
  },
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: async () => {},
    destroy: async () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    onCloseRequested: async () => () => {},
  }),
}))

vi.mock('./reader/session', async (importActual) => {
  const actual = await importActual<typeof import('./reader/session')>()
  /* The same digest the host runs to name the book — see `start`. */
  const { bookIdFor: identify } = await import('../core/marks')
  /* `any` throughout: this stands in for foliate-js, whose API is explicitly
     unstable (AGENTS.md), so pinning its shapes here would pin a fork we do not
     control. The real types are asserted where App reads them. */
  class StandIn {
    #callbacks: any
    #gone = false
    readonly own: Publishing = { source: null, lastLocation: null, goTo: [], turns: [], reanchored: [], published: false }
    #cfi = 'epubcfi(/6/4!/4/2,/1:0,/1:9)'

    constructor(_host: HTMLElement, callbacks: any) {
      this.#callbacks = callbacks
    }

    get disposed(): boolean {
      return this.#gone
    }

    get view(): null {
      return null
    }

    redrawMarks(): void {}

    dispose(): void {
      this.#gone = true
      if (reader.live === this.#surface) reader.live = null
    }

    #position(cfi: string): ReaderPosition {
      return {
        fraction: 0.25,
        chapterLabel: reader.chapter,
        chapterHref: reader.chapterHref,
        cfi,
        sectionIndex: 0,
        sectionExact: true,
      }
    }

    #navigator = {
      goTo: (target: string) => {
        this.own.goTo.push(target)
        /* A TURN LATER, as a real navigation is: `goTo` asks, and the
           relocation that answers arrives after it. Moved synchronously, the
           host's `placeHere` would report the DESTINATION as the place the
           jump left from, and the stack would record a departure from where
           the reader had just arrived. */
        if (target.startsWith('epubcfi')) {
          setTimeout(() => {
            if (!this.#gone) this.#relocate(target)
          }, 0)
        }
      },
      /* A generator that yields nothing: the reader asks for results and gets none. */
      search: async function* () {},
      drawMark: () => {},
      eraseMark: () => {},
      deselect: () => {},
      closeFootnote: () => {},
      setFootnoteMount: () => {},
      next: () => this.own.turns.push('next'),
      prev: () => this.own.turns.push('prev'),
      goLeft: () => this.own.turns.push('goLeft'),
      goRight: () => this.own.turns.push('goRight'),
      placeHere: () =>
        reader.pinned
          ? {
              cfi: this.#cfi,
              sectionIndex: 0,
              text: 'Call me Ishmael',
              prefix: '',
              suffix: '',
              chapter: reader.chapter,
            }
          : null,
      /* The walk a real session makes over the open book. It finds every
         passage it is handed, at one place, which is enough for the host's
         half: what it does with an answer. */
      reanchor: async (pending: readonly { id: string }[]) => {
        this.own.reanchored.push([...pending])
        return {
          found: pending.map((one) => ({ id: one.id, cfi: THERE, sectionIndex: 0 })),
          missed: [],
          complete: true,
          walked: 1,
        }
      },
    }

    #relocate(cfi: string): void {
      this.#cfi = cfi
      this.#callbacks.onRelocate(this.#position(cfi))
    }

    #surface = {
      relocate: (cfi: string, chapter?: string) => {
        if (chapter !== undefined) reader.chapter = chapter
        this.#relocate(cfi)
      },
      select: (snapshot: unknown) => this.#callbacks.onSelection(snapshot),
      /** What the renderer would paint for other readers, as it would read it. */
      overlays: () => this.#callbacks.getOverlays() as readonly unknown[],
      link: (detail: unknown, event: Event) => this.#callbacks.onLink(detail, event),
      external: (detail: unknown, event: Event) => this.#callbacks.onExternalLink(detail, event),
      fail: (message: string) => this.#callbacks.onError(message),
    }

    async start(source: unknown, deps: any): Promise<void> {
      this.own.source = source
      reader.opened.push(this.own)
      /* A REAL SESSION PUBLISHES WHEN THE BOOK HAS PARSED, which is long after
         the host has named it: the host hashes the same bytes to learn the
         book's id, and a parse is slower than a hash. So the stand-in hashes
         them too, and then gives React turns to commit what the host learned —
         ordered by the work, not by a count of turns that a loaded runner
         outgrows. */
      if (source instanceof File) await identify(source)
      for (let turn = 0; turn < 3; turn += 1) await new Promise((done) => setTimeout(done, 0))
      if (this.#gone) return
      this.own.lastLocation = deps.lastLocation()
      /* A book whose bytes arrived and which will not open — the terminal
         failure a real session reports through the same callback. */
      if (reader.refuse > 0) {
        reader.refuse -= 1
        this.#callbacks.onError('File type not supported')
        this.own.published = true
        return
      }
      const name = typeof source === 'string' ? source : ((source as File).name ?? '')
      const meta: BookMeta = {
        pageCount: 0,
        title: name.replace(/\.[^.]+$/u, '') || 'Untitled',
        author: reader.author,
        identifier: '',
        sortAs: '',
        series: '',
        seriesIndex: null,
        subjects: [],
        publisher: '',
        published: '',
        languages: [],
        description: '',
        subtitle: '',
      }
      this.#callbacks.onNavigator(this.#navigator)
      this.#callbacks.onToc(reader.toc)
      this.#callbacks.onFixedLayout(false)
      this.#callbacks.onDirection('ltr')
      this.#callbacks.onMeta(meta)
      if (reader.cover) this.#callbacks.onCover(reader.cover)
      /* THE SECTION'S OWN DOCUMENT, which is what read-aloud reads: `useSpeech`
         collects the text out of it, so a book that publishes none has nothing
         to say and the transport never appears. */
      if (reader.prose !== null) {
        const doc = document.implementation.createHTMLDocument('section')
        if (reader.lang !== null) doc.documentElement.setAttribute('lang', reader.lang)
        doc.body.innerHTML = reader.prose
        this.#callbacks.onDocument(doc)
      }
      this.#callbacks.onRelocate(this.#position(this.#cfi))
      reader.live = this.#surface
      this.own.published = true
    }
  }
  return { ...actual, ReaderSession: StandIn }
})

import { App } from './App'
import { FakeSynth, FakeUtterance } from './reader/speechSynth.testkit'
import { NO_GOOD_VOICE } from './reader/voiceChoice'

/* jsdom has no `scrollIntoView` (the palette's active row calls it) and no
   `ResizeObserver` (the reader measures its stage with one). */
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never
/* NO NETWORK. A book opened from an address is identified by fetching it —
   refused here, the way an address that cannot be reached is refused. */
globalThis.fetch = (async (input: unknown) => {
  throw new TypeError(`no network in this suite: ${String(input)}`)
}) as typeof fetch

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  reader.opened.length = 0
  reader.live = null
  reader.chapter = 'Loomings'
  reader.chapterHref = 'chapter-1.xhtml'
  reader.prose = null
  reader.lang = null
  reader.author = 'Herman Melville'
  reader.toc = []
  reader.cover = null
  reader.refuse = 0
  reader.pinned = true
  parses.names.length = 0
  release(parses)
  disk.read.length = 0
  disk.refuse.clear()
  disk.hold.clear()
  for (const go of disk.waiting.splice(0)) go()
  shell.invoked.length = 0
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

/** Let every parked parse through, and stop parking. */
const release = (gate: { armed: boolean; waiting: (() => void)[] }) => {
  gate.armed = false
  for (const go of gate.waiting.splice(0)) go()
}

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0))
  })
/** Several turns, where what is asserted is that something did NOT happen after a state the test already waited for. */
const settled = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn += 1) await settle()
}
/** Wait for what the assertion is about — see the header. The ceiling is a ceiling, never a guess. */
const eventually = (assertion: () => void) => waitFor(assertion, { timeout: 15_000 })
configure({ asyncUtilTimeout: 15_000 })
/** Real time, for the one thing here that is paced by it: the enrichment pass's breath between books. */
const breathe = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 300))
  })

/** Everything the window is saying at once — the reader draws more than one status line. */
const noticed = () => screen.getAllByRole('status').map((one) => one.textContent).join(' ')

const BYTES = 'not really an epub'
const OTHER = 'another book entirely'
const HERE = 'epubcfi(/6/4!/4/2,/1:0,/1:9)'
const THERE = 'epubcfi(/6/8!/4/2,/1:0,/1:9)'

/** The accelerator is Ctrl off macOS, and jsdom's user agent is nobody's Mac. */
/** The accelerator the app was mounted to expect — ⌘ where the URL pinned
 *  macOS, Ctrl everywhere else, which is what jsdom's user agent resolves to. */
const accel = (key: string) =>
  fireEvent.keyDown(window, {
    key,
    ...(new URLSearchParams(window.location.search).get('platform') === 'macos'
      ? { metaKey: true }
      : { ctrlKey: true }),
  })
const hint = () => screen.queryByRole('button', { name: /← Back to/u })

async function mount(
  fs: IndexFs | null,
  books: readonly IndexedBook[] = [],
  capabilities: Parameters<typeof composeCapabilities>[0] = [],
  openRequests?: { subscribe(handler: (paths: readonly string[]) => void): () => void },
  before?: (services: ReturnType<typeof createKernelServices>) => void,
) {
  const services = createKernelServices({ fs, storage: null, initialBooks: books })
  before?.(services)
  const composition = await composeCapabilities(capabilities, kernelApi(services), new AbortController().signal)
  render(
    <App
      services={services}
      fs={fs}
      composition={composition}
      {...(openRequests === undefined ? {} : { openRequests })}
    />,
  )
  await settle()
  return { services }
}

/**
 * A book on the shelf whose bytes are in the vault, filed under their own hash.
 *
 * ⚠️ **THE RECORD ON DISK SAYS WHAT THE ROW SAYS — PARSED.** It said only the
 * title and author, while the row claimed a parse. The first write through the
 * book's lane re-reads the record, so the row lost its parse marker at that
 * moment, and the shelf's enrichment pass then parsed the book again under the
 * stand-in's "Parsed Moby-Dick". Whether that had happened by the time a test
 * looked for "More for Moby-Dick" was decided by the clock — with every digest
 * slowed by 40 ms, it had (2026-09-15).
 */
async function shelved(bytes: string, name: string, over: Partial<IndexedBook> = {}) {
  const bookId = await bookIdFor(new File([bytes], 'content.epub'))
  const record = { title: name, author: 'Herman Melville', parsedAt: 1, metaSchema: META_SCHEMA }
  return {
    bookId,
    /** For a test that files the book's folder itself. */
    record,
    files: {
      [`${folderOf(bookId)}/book.json`]: JSON.stringify(record),
      [`${folderOf(bookId)}/content.epub`]: bytes,
    },
    row: { bookId, ...record, hasContent: true, ...over } as IndexedBook,
  }
}

const mark = (bookId: string, cfi: string, text: string) => ({
  id: `m-${text}`,
  bookId,
  cfi,
  sectionIndex: 0,
  text,
  prefix: '',
  suffix: '',
  note: '',
  kind: 'highlight',
  tint: 'yellow',
  style: 'fill',
  chapter: 'Loomings',
  createdAt: 1,
})

/** Open the shelf's book, and wait until the book it opened has published. */
async function open(title: string) {
  const before = reader.opened.length
  fireEvent.click(screen.getByTitle(`Open ${title}`))
  await eventually(() => {
    expect(reader.opened.length, `${title} never reached the reader`).toBeGreaterThan(before)
    expect(reader.opened.at(-1)!.published, `${title} never finished opening`).toBe(true)
  })
  await settle()
}

/** Run a palette command by its label, within the palette. */
async function runCommand(query: string, label: string) {
  accel('k')
  await settle()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search or ask' }), { target: { value: query } })
  await settle()
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Search or ask' })).getByText(label).closest('button')!)
  await settle()
}

/** Whether the palette offers a row with this label for this query — asked and put away again. */
async function paletteOffers(query: string, label: string) {
  accel('k')
  await settle()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search or ask' }), { target: { value: query } })
  await settle()
  const offered = within(screen.getByRole('dialog', { name: 'Search or ask' })).queryByText(label) !== null
  fireEvent.keyDown(window, { key: 'Escape' })
  await settle()
  return offered
}
const backOffered = () => paletteOffers('Back to where', 'Back to where you were')

/** What a file in the vault says now, or null when nothing is there. */
const stored = (fs: unknown, path: string): unknown => {
  const bytes = (fs as { store: Map<string, Uint8Array> }).store.get(path)
  return bytes === undefined ? null : (JSON.parse(new TextDecoder().decode(bytes)) as unknown)
}

describe('a jump inside the open book', () => {
  async function mobyWithAMark() {
    const moby = await shelved(BYTES, 'Moby-Dick')
    const fs = fakeFs({
      ...moby.files,
      [`${folderOf(moby.bookId)}/marks.json`]: JSON.stringify([mark(moby.bookId, THERE, 'call me ishmael')]),
    }) as unknown as IndexFs
    await mount(fs, [moby.row])
    await open('Moby-Dick')
    return moby
  }
  async function jumpToTheMark() {
    accel('2')
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: /call me ishmael/u }))
    await eventually(() => expect(reader.opened[0]!.goTo, 'the jump never reached the book').toContain(THERE))
  }

  it('goes there, and offers the way back by the chapter the reader left', async () => {
    await mobyWithAMark()
    expect(reader.opened, 'the book never opened').toHaveLength(1)
    await jumpToTheMark()
    expect(reader.opened[0]!.goTo).toEqual([THERE])
    expect(screen.getByRole('button', { name: /← Back to Loomings/u })).toBeTruthy()

    /* And the way back is the line's own button: it takes the reader back and
       goes, rather than lingering over a place they have already returned to. */
    fireEvent.click(screen.getByRole('button', { name: /← Back to Loomings/u }))
    await eventually(() => expect(reader.opened[0]!.goTo, 'the way back went nowhere').toEqual([THERE, HERE]))
    expect(hint()).toBeNull()
  })

  it('answers ⌘[ and ⌘] once a jump has been made, and nothing before', async () => {
    await mobyWithAMark()
    accel('[')
    await settled(2)
    expect(reader.opened[0]!.goTo, 'a jump back was taken with nowhere to go').toEqual([])

    await jumpToTheMark()
    /* The relocation the jump asked for has to land before "where the reader
       is" is the mark. */
    await settled(2)
    accel('[')
    await eventually(() => expect(reader.opened[0]!.goTo).toEqual([THERE, HERE]))
    await settled(2)
    accel(']')
    await eventually(() => expect(reader.opened[0]!.goTo, 'there was no way forward again').toEqual([THERE, HERE, THERE]))
  })

  it('records where a link inside the book left from, and says so', async () => {
    /* foliate navigates the link itself, so the host records the departure and
       stays out of the way — and SAYS it, which is the half that was silent. */
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')

    const event = new Event('link', { cancelable: true })
    await act(async () => reader.live!.link({ href: 'chapter-2.xhtml' }, event))
    expect(event.defaultPrevented, 'the host took a link foliate navigates itself').toBe(false)
    await eventually(() => expect(screen.getByRole('button', { name: /← Back to Loomings/u })).toBeTruthy())

    /* The stack learned it too, so ⌘[ has somewhere to go. */
    await act(async () => reader.live!.relocate(THERE))
    await settle()
    accel('[')
    await eventually(() => expect(reader.opened[0]!.goTo).toEqual([HERE]))
  })

  it('takes a link that leaves the book away from foliate, and says when it is refused', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')

    const event = new Event('external-link', { cancelable: true })
    await act(async () => reader.live!.external({ href_: 'javascript:alert(1)' }, event))
    expect(event.defaultPrevented, 'a book file was left to decide what this window does').toBe(true)
    await eventually(() => expect(noticed()).toContain('Paper only opens web links, and that one is javascript:'))
  })

  it('goes to a chapter the contents name, and offers the way back by the one it left', async () => {
    /* A contents row hands over an HREF — the string form of a jump, which the
       open book resolves itself. */
    reader.toc = [
      { label: 'Loomings', href: 'chapter-1.xhtml' },
      { label: 'The Carpet-Bag', href: 'chapter-2.xhtml' },
    ]
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    fireEvent.click(await screen.findByRole('button', { name: /The Carpet-Bag/u }))
    await eventually(() => expect(reader.opened[0]!.goTo, 'the contents row went nowhere').toEqual(['chapter-2.xhtml']))
    expect(screen.getByRole('button', { name: /← Back to Loomings/u }), 'a jump from the contents offered no way back').toBeTruthy()
    expect(screen.queryByText('That book is no longer on your shelf.'), 'an href was looked for on the shelf').toBeNull()
  })

  it('shows the reader for a jump made from the shelf, and leaves an open layer alone for one made in the reader', async () => {
    await mobyWithAMark()
    accel('l')
    await settle()
    expect(screen.getByTitle('Open Moby-Dick')).toBeTruthy()
    await jumpToTheMark()
    /* ON THE READER — the titlebar's way out of it is the library. */
    await eventually(() => expect(screen.getByTitle(/^Library · /u), 'the jump moved a book nobody could see').toBeTruthy())

    /* In the reader already, a jump is only a jump: it does not re-arrive, and
       re-arriving shuts every layer — here the palette the reader has open. */
    await settled(2)
    accel('k')
    await settle()
    expect(screen.getByRole('textbox', { name: 'Search or ask' })).toBeTruthy()
    accel('[')
    await eventually(() => expect(reader.opened[0]!.goTo).toEqual([THERE, HERE]))
    expect(screen.queryByRole('textbox', { name: 'Search or ask' }), 'a jump inside the reader shut the palette').toBeTruthy()
  })

  it('offers no way back from a place that names no chapter', async () => {
    /* The line reads "← Back to <chapter>", and a line naming nothing is a
       promise nobody can read. */
    reader.chapter = ''
    await mobyWithAMark()
    await jumpToTheMark()
    await settle()
    expect(hint(), 'a jump from nowhere named offered a way back to it').toBeNull()

    const event = new Event('link', { cancelable: true })
    await act(async () => reader.live!.link({ href: 'chapter-2.xhtml' }, event))
    await settle()
    expect(hint(), 'a link from nowhere named offered a way back to it').toBeNull()
  })

  /**
   * ⚠️ **A PLACE THE STACK CANNOT RECORD HAS NO WAY BACK TO OFFER** (2026-09-15).
   * `placeHere` answers null for a section still rendering or a spread whose
   * page is a guess, and the stack records no origin there — so a line naming
   * the chapter left was a button that went nowhere and a ⌘[ that was not
   * bound. The jump still gives up whatever was ahead: that is the stack's half,
   * and a `placeHere` that threw there instead left the way forward standing.
   */
  it('offers no way back from a place that cannot be pinned down, and still gives up the way forward', async () => {
    /* A way forward first, made where nothing is named, so no line is left over
       from it to be mistaken for the one under test. */
    reader.chapter = ''
    await mobyWithAMark()
    await jumpToTheMark()
    await settled(2)
    accel('[')
    await eventually(() => expect(reader.opened[0]!.goTo).toEqual([THERE, HERE]))
    await settled(2)
    expect(await paletteOffers('Forward', 'Forward again'), 'there was no way forward to give up').toBe(true)
    expect(hint(), 'a line was left over from the jumps before').toBeNull()

    await act(async () => reader.live!.relocate(HERE, 'Loomings'))
    reader.pinned = false
    fireEvent.click(await screen.findByRole('button', { name: /call me ishmael/u }))
    await eventually(() => expect(reader.opened[0]!.goTo, 'the jump never reached the book').toEqual([THERE, HERE, THERE]))
    await settled(2)
    expect(hint(), 'a jump from a place the stack could not record offered a way back to it').toBeNull()
    expect(await paletteOffers('Forward', 'Forward again'), 'the jump kept the way forward it gave up').toBe(false)
  })

  it('offers no way back from a link followed where the place cannot be pinned down', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    reader.pinned = false
    const event = new Event('link', { cancelable: true })
    await act(async () => reader.live!.link({ href: 'chapter-2.xhtml' }, event))
    await settled(2)
    expect(hint(), 'a link from a place the stack could not record offered a way back from it').toBeNull()
  })

  it('lets the way back fade on its own clock', async () => {
    await mobyWithAMark()
    accel('2')
    await settle()
    const row = await screen.findByRole('button', { name: /call me ishmael/u })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(row)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(hint(), 'the jump offered no way back').toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    expect(hint(), 'the way back stayed after its time was up').toBeNull()
  })

  it('names its own bookmark in the palette — offered to keep, then to give back', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    expect(await paletteOffers('bookmark', 'Bookmark this place'), 'a place that can be kept was not offered').toBe(true)
    expect(await paletteOffers('bookmark', 'Remove this bookmark')).toBe(false)

    accel('b')
    /* Kept in memory in the same turn — the store publishes before it writes. */
    await settled(2)
    expect(await paletteOffers('bookmark', 'Remove this bookmark'), 'a kept place was not offered for giving back').toBe(true)
    expect(await paletteOffers('bookmark', 'Bookmark this place'), 'a kept place was offered for keeping again').toBe(false)
  })
})

describe('a jump into another book', () => {
  /** Moby-Dick open, with a mark in another book on the same shelf. */
  async function twoBooks({ copy = true }: { copy?: boolean } = {}) {
    const one = await shelved(BYTES, 'Moby-Dick')
    const two = await shelved(OTHER, 'Bartleby')
    const fs = fakeFs({
      ...one.files,
      [`${folderOf(one.bookId)}/marks.json`]: JSON.stringify([mark(one.bookId, HERE, 'call me ishmael')]),
      [`${folderOf(two.bookId)}/book.json`]: JSON.stringify(two.record),
      [`${folderOf(two.bookId)}/marks.json`]: JSON.stringify([mark(two.bookId, THERE, 'i would prefer not to')]),
      ...(copy ? { [`${folderOf(two.bookId)}/content.epub`]: OTHER } : {}),
    }) as unknown as IndexFs
    const mounted = await mount(fs, [one.row, two.row])
    await open('Moby-Dick')
    return { ...mounted, one, two, fs }
  }
  /** Open Marginalia and click the other book's mark. */
  async function jumpToBartleby() {
    accel('2')
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: /i would prefer not to/u }))
  }

  it('opens the other book AT the mark, offers the way back, and spends the override once it has landed', async () => {
    const { two } = await twoBooks()
    await jumpToBartleby()
    await eventually(() => {
      expect(reader.opened, 'the other book never opened').toHaveLength(2)
      expect(reader.opened[1]!.published).toBe(true)
    })
    expect(reader.opened[1]!.lastLocation, 'the other book did not open at the mark').toBe(THERE)
    /* ACCEPTED, so the reader is told there is a way back — and the stack has
       one. A jump that answered `false` would leave both silent. */
    expect(screen.getByRole('button', { name: /← Back to Loomings/u })).toBeTruthy()
    expect(await backOffered()).toBe(true)

    /* AND THE OVERRIDE IS SPENT, ROLLBACK AND ALL. Opening the same book again
       lands where it was left, not at a mark clicked minutes ago — and the
       rollback that open carried was released when it landed, so this later
       open does not run it and take the jump off the stack. */
    accel('l')
    await settle()
    await open('Bartleby')
    expect(reader.opened).toHaveLength(3)
    expect(reader.opened[2]!.lastLocation, 'a spent override was applied to a later open').not.toBe(THERE)
    expect(await backOffered(), 'a later open ran the landed jump’s rollback').toBe(true)
    expect(two.bookId).toBeTruthy()
  })

  /* ⚠️ **ONLY A FAILURE TAKES A JUMP BACK — NOT THE ERROR BEFORE IT CLEARING**
     (2026-09-15). Every open clears the book's error, so a jump out of a book
     the reader was shown an error for changes `book.error` too, from the
     refusal to nothing, on the way into a book that opens. That is the one
     change of it that is not a failure, and the rollback must not run on it. */
  it('opens the other book at the mark when the book it leaves would not open', async () => {
    reader.refuse = 1
    await twoBooks()
    expect(await screen.findByText('File type not supported'), 'the book being left was not refused').toBeTruthy()
    await jumpToBartleby()
    await eventually(() => {
      expect(reader.opened, 'the other book never opened').toHaveLength(2)
      expect(reader.opened[1]!.published).toBe(true)
    })
    expect(reader.opened[1]!.lastLocation, 'the jump out of a refused book was taken back as it opened').toBe(THERE)
  })

  it('takes back the way back when the other book’s copy is gone', async () => {
    /* The hint, the override and the stack are all committed on the assumption
       that the open lands — and it is a read off disk that can fail. */
    await twoBooks({ copy: false })
    await jumpToBartleby()
    await eventually(() => expect(noticed()).toContain('That book could not be opened. Try adding it again.'))
    expect(hint(), 'a way back was offered from a jump that never happened').toBeNull()
    expect(await backOffered(), 'the stack kept a departure the reader never made').toBe(false)
  })

  it('takes back the override when the other book will not open, so a later open of it starts where it was left', async () => {
    const { two } = await twoBooks()
    reader.refuse = 1
    await jumpToBartleby()
    await eventually(() => {
      expect(reader.opened).toHaveLength(2)
      expect(reader.opened[1]!.published).toBe(true)
    })
    /* NOT `eventually`: the line fades by itself after six seconds, so waiting
       for it to be gone would be waiting for the fade. Turns only. */
    await settled(3)
    expect(hint(), 'the way back outlived the open it belonged to').toBeNull()
    expect(await backOffered()).toBe(false)

    /* The same book, opened deliberately: the mark's place was taken back with
       everything else the jump committed. */
    accel('l')
    await settle()
    await open('Bartleby')
    expect(reader.opened.at(-1)!.lastLocation, 'a failed jump sent a later open to its mark').not.toBe(THERE)
    expect(two.bookId).toBeTruthy()
  })

  it('refuses a jump back into a book that has left the shelf, and says so', async () => {
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
    }
    try {
      await twoBooks()
      await jumpToBartleby()
      await eventually(() => {
        expect(reader.opened).toHaveLength(2)
        expect(reader.opened[1]!.published).toBe(true)
      })

      /* Moby-Dick goes, while the way back still names it. */
      accel('l')
      await settle()
      fireEvent.click(screen.getByLabelText('More for Moby-Dick'))
      await settle()
      fireEvent.click(screen.getByLabelText('Remove Moby-Dick'))
      await settle()
      fireEvent.click(screen.getByLabelText(/^Remove Moby-Dick — the file you imported is kept/u))
      await eventually(() => expect(screen.queryByTitle('Open Moby-Dick')).toBeNull())

      accel('[')
      await eventually(() => expect(noticed()).toContain('That book is no longer on your shelf.'))
      expect(reader.opened, 'a book that is not on the shelf was opened anyway').toHaveLength(2)
      /* REFUSED, so the stack did not move: the way back is still on offer. */
      expect(await backOffered(), 'a refused jump consumed its own destination').toBe(true)
    } finally {
      Element.prototype.getBoundingClientRect = rect
    }
  })
})

describe('an intake while a jump is still opening', () => {
  /** Moby-Dick open, the other book's read held, and a jump into it accepted. */
  async function aJumpStillOpening() {
    const one = await shelved(BYTES, 'Moby-Dick')
    const two = await shelved(OTHER, 'Bartleby')
    const base = fakeFs({
      ...one.files,
      ...two.files,
      [`${folderOf(two.bookId)}/marks.json`]: JSON.stringify([mark(two.bookId, THERE, 'i would prefer not to')]),
    })
    /* Both slow halves held: the jump's read of the other book, and the
       import's copy — so what the test does next lands between the jump and
       its arrival. */
    const gates = { reads: [] as (() => void)[], writes: [] as (() => void)[], holdReads: false, holdWrites: false }
    const fs = {
      ...base,
      readFile: async (path: string) => {
        if (gates.holdReads && path === `${folderOf(two.bookId)}/content.epub`) {
          await new Promise<void>((go) => gates.reads.push(go))
        }
        return base.readFile(path)
      },
      writeFile: async (path: string, bytes: Uint8Array) => {
        if (gates.holdWrites && path.endsWith('.writing')) await new Promise<void>((go) => gates.writes.push(go))
        return base.writeFile(path, bytes)
      },
    } as unknown as IndexFs
    await mount(fs, [one.row, two.row])
    await open('Moby-Dick')

    gates.holdReads = true
    accel('2')
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: /i would prefer not to/u }))
    await eventually(() => expect(gates.reads, 'the other book was never asked for').toHaveLength(1))
    expect(screen.getByRole('button', { name: /← Back to Loomings/u }), 'the jump was never accepted').toBeTruthy()
    const letGo = async () => {
      gates.holdReads = false
      gates.holdWrites = false
      for (const go of gates.reads.splice(0)) go()
      for (const go of gates.writes.splice(0)) go()
      await settled(4)
    }
    return { gates, letGo }
  }

  it('takes back what the jump committed, at once rather than when the copying ends', async () => {
    /* Every intake ends in an open, so from the moment one starts it is the
       open the reader is waiting for — and the jump it replaced must not keep
       a way back to somewhere the reader is no longer going. */
    const { gates, letGo } = await aJumpStillOpening()
    gates.holdWrites = true
    fireEvent.drop(window, {
      dataTransfer: {
        files: [new File(['three'], 'three.epub'), new File(['four'], 'four.epub')],
        items: [],
        types: ['Files'],
      },
    })
    /* NOT `eventually` — the line fades by itself after six seconds. The drop
       reaches the intake in promises, so turns are enough and time is not
       allowed. */
    await settled(3)
    expect(hint(), 'the superseded jump kept its way back while the import copied').toBeNull()
    /* AT ONCE: the import's own book has not opened, so it was not the open at
       the end of the import that took the way back. */
    expect(reader.opened, 'the import had already opened its book, so this proved nothing').toHaveLength(1)
    await letGo()
  })

  it('takes back what the jump committed when the reader closes the book instead', async () => {
    /* Closing is the newest thing the reader asked for, so it retires the
       pending jump exactly as an open does — or the way back stays on the
       stack for a jump the reader walked away from. */
    const { letGo } = await aJumpStillOpening()
    expect(await backOffered(), 'the jump never reached the stack').toBe(true)
    await runCommand('Close the book', 'Close the book')
    expect(await backOffered(), 'the way back outlived the book the reader closed').toBe(false)
    await letGo()
    expect(reader.opened, 'the closed-over jump opened its book after all').toHaveLength(1)
  })
})

describe('marking and bookmarking from the keyboard', () => {
  /** A selection the session publishes, over a passage in a detached paragraph. */
  async function select(text: string) {
    const passage = document.createElement('p')
    passage.textContent = `Call me ${text}. Some years ago I thought I would sail about a little.`
    document.body.append(passage)
    const range = document.createRange()
    range.setStart(passage.firstChild!, 8)
    range.setEnd(passage.firstChild!, 8 + text.length)
    const snapshot: SelectionSnapshot = {
      cfi: HERE,
      sectionIndex: 0,
      text,
      prefix: 'Call me ',
      suffix: '. Some years ago',
      range,
    }
    await act(async () => reader.live!.select(snapshot))
    await settle()
    return () => passage.remove()
  }

  it('marks the selection in the tint the bar is showing, with no note of its own', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    const fs = fakeFs(moby.files) as unknown as IndexFs
    await mount(fs, [moby.row])
    await open('Moby-Dick')
    const done = await select('Ishmael')

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    const marks = () =>
      (stored(fs, `${folderOf(moby.bookId)}/marks.json`) ?? []) as { text: string; note: string; tint: string; style: string }[]
    await eventually(() => expect(marks().map((one) => one.text), 'the selection was never marked').toEqual(['Ishmael']))
    expect(marks()[0]!.note, 'a mark made by the key carried a note nobody wrote').toBe('')
    expect(marks()[0]!.tint).toBe('yellow')
    expect(marks()[0]!.style).toBe('fill')
    done()
  })

  it('keeps this place, gives it back, and does neither twice while the key is held', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    const fs = fakeFs(moby.files) as unknown as IndexFs
    await mount(fs, [moby.row])
    await open('Moby-Dick')

    const bookmarks = () => {
      const all = (stored(fs, `${folderOf(moby.bookId)}/marks.json`) ?? []) as { kind: string; deletedAt?: string }[]
      /* A REMOVAL IS A TOMBSTONE, not a missing row — the store keeps the
         headstone so a peer's copy cannot resurrect it. */
      return all.filter((one) => one.kind === 'bookmark' && one.deletedAt === undefined)
    }
    const tombstones = () =>
      ((stored(fs, `${folderOf(moby.bookId)}/marks.json`) ?? []) as { kind: string; deletedAt?: string }[]).filter(
        (one) => one.kind === 'bookmark' && one.deletedAt !== undefined,
      )
    /* ⌘B IS BOUND ONCE THIS BOOK'S MARKS HAVE BEEN READ — a place cannot be
       matched against marks nobody has loaded — and a bound key is a taken one,
       so pressing until the press is taken is waiting for exactly that. */
    await eventually(() => expect(fireEvent.keyDown(window, { key: 'b', ctrlKey: true }), 'the place could never be kept').toBe(false))
    await eventually(() => expect(bookmarks(), 'the place was never kept').toHaveLength(1))

    /* A HELD KEY'S REPEAT IS TAKEN AND NOTHING IS DONE: the repeat used to fall
       through to the binding below it. Written before the next press, so a
       repeat that did act would be on disk by the time the press is. */
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, repeat: true })
    await settled(3)
    expect(bookmarks(), 'a repeat of the held key acted a second time').toHaveLength(1)
    expect(tombstones(), 'a repeat of the held key took the bookmark back').toHaveLength(0)

    fireEvent.keyUp(window, { key: 'b', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    await eventually(() => expect(bookmarks(), 'the bookmark could not be given back').toHaveLength(0))
  })
})

describe('the page keys', () => {
  /** Moby-Dick open with the pane closed, so the reader takes the keys at all. */
  async function reading() {
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    accel('\\')
    await settle()
    return () => reader.opened[0]!.turns
  }
  const placed = <T extends HTMLElement>(element: T): T => {
    document.body.append(element)
    return element
  }

  it('turn the page from the window and from anything that is not a field or a control', async () => {
    const turns = await reading()
    expect(fireEvent.keyDown(window, { key: 'ArrowRight' }), 'the page key was not taken').toBe(false)
    expect(turns()).toEqual(['goRight'])
    const plain = placed(document.createElement('div'))
    try {
      expect(fireEvent.keyDown(plain, { key: 'ArrowLeft' }), 'a key from plain text was not taken').toBe(false)
      expect(turns()).toEqual(['goRight', 'goLeft'])
    } finally {
      plain.remove()
    }
    /* Not a page key at all, so not the reader's to take. */
    expect(fireEvent.keyDown(window, { key: 'x' }), 'a letter was taken as though it turned a page').toBe(true)
    expect(turns()).toEqual(['goRight', 'goLeft'])
  })

  it('leave a field, an editable passage and a control their own keys', async () => {
    const turns = await reading()
    const editable = document.createElement('div')
    /* jsdom does not compute this; a browser does, from `contenteditable`. */
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    const targets = [
      ['a text field', placed(document.createElement('input'))],
      ['a text area', placed(document.createElement('textarea'))],
      ['an editable passage', placed(editable)],
      ['a button', placed(document.createElement('button'))],
    ] as const
    try {
      for (const [what, target] of targets) {
        expect(fireEvent.keyDown(target, { key: 'ArrowRight' }), `the page key was taken from ${what}`).toBe(true)
        expect(fireEvent.keyDown(target, { key: ' ' }), `Space was taken from ${what}`).toBe(true)
      }
      expect(turns(), 'a page turned under the reader’s own focus').toEqual([])
    } finally {
      for (const [, target] of targets) target.remove()
    }
  })

  it('leave a key alone that something nearer the reader has already handled', async () => {
    const turns = await reading()
    const plain = placed(document.createElement('div'))
    const handled = (event: Event) => event.preventDefault()
    document.addEventListener('keydown', handled, { capture: true })
    try {
      fireEvent.keyDown(plain, { key: 'PageDown' })
      expect(turns(), 'a key another handler had taken turned the page as well').toEqual([])
    } finally {
      document.removeEventListener('keydown', handled, { capture: true })
      plain.remove()
    }
  })
})

describe('what the window files while a book is open', () => {
  it('files the book’s own jacket in its folder', async () => {
    /* The canvas is the platform's, and jsdom has none — so the encoder is
       stood in for and what is asserted is the file that lands. */
    const bitmaps = { close: () => {} }
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: async () => ({ width: 800, height: 1200, ...bitmaps }),
    })
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: class {
        getContext() {
          return { drawImage: () => {} }
        }
        async convertToBlob() {
          return new Blob(['a jacket'], { type: 'image/jpeg' })
        }
      },
    })
    try {
      reader.cover = new Blob(['a jacket'], { type: 'image/jpeg' })
      const moby = await shelved(BYTES, 'Moby-Dick')
      const fs = fakeFs(moby.files) as unknown as IndexFs
      await mount(fs, [moby.row])
      await open('Moby-Dick')
      await eventually(() =>
        expect(
          (fs as unknown as { store: Map<string, Uint8Array> }).store.has(`${folderOf(moby.bookId)}/cover.jpg`),
          'the book’s jacket was never filed',
        ).toBe(true),
      )
    } finally {
      delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap
      delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas
    }
  })

  it('records no jacket for a book that declares none', async () => {
    /* The jacket's write goes through the mutation recorder — the sync journal,
       in the app — whether or not anything is written, so asking for one with
       no cover tells every peer this book's jacket changed. */
    const kinds: string[] = []
    const recorder: MutationRecorder = {
      begin: async (book, what) => {
        kinds.push(what)
        return { book, what }
      },
      commit: async () => {},
    }
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row], [], undefined, (services) => {
      services.bindRecorder(recorder)
    })
    await open('Moby-Dick')
    /* The intake's own record write is the last thing an open writes. */
    await eventually(() => expect(kinds, 'the open wrote nothing at all').toContain('record'))
    await settled(3)
    expect(kinds, 'a jacket was recorded for a book with none').not.toContain('cover')
  })

  it('writes the reading position the moment the window is hidden, and not while it is on screen', async () => {
    /* The recorder holds a position for two seconds while the reader keeps
       moving. What is left unwritten when the app is hidden is the place they
       stopped at — on macOS, most of how an app is left. */
    const moby = await shelved(BYTES, 'Moby-Dick')
    const fs = fakeFs(moby.files) as unknown as IndexFs
    await mount(fs, [moby.row])
    await open('Moby-Dick')
    /* THE RECORDER'S OWN CLOCK IS STOPPED — see the `pagehide` test: its timer
       would otherwise write the position by itself, and a wait long enough for
       a loaded runner is long enough for it. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => reader.live!.relocate(THERE))

    const placed = () => (stored(fs, `${folderOf(moby.bookId)}/book.json`) as { position?: string }).position
    /* Turns of the event loop, never of the clock. */
    const turn = async (until: () => boolean) => {
      for (let step = 0; step < 500 && !until(); step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0)
        })
      }
    }
    expect(placed(), 'the position was written before anything asked for it').toBeUndefined()

    const visibility = (state: string) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
      fireEvent(document, new Event('visibilitychange'))
    }
    try {
      visibility('visible')
      await turn(() => false)
      expect(placed(), 'a window that is still on screen wrote its position').toBeUndefined()

      visibility('hidden')
      await turn(() => placed() === THERE)
      expect(placed(), 'the place the reader stopped at was lost').toBe(THERE)
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    }
  })

  it('writes the reading position when the page is torn down', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    const fs = fakeFs(moby.files) as unknown as IndexFs
    await mount(fs, [moby.row])
    await open('Moby-Dick')
    /* THE RECORDER'S OWN CLOCK IS STOPPED, because it writes by itself two
       seconds later — and a wait long enough for a loaded runner would be long
       enough for that timer to do the work `pagehide` is being asked to do. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => reader.live!.relocate(THERE))
    fireEvent(window, new Event('pagehide'))
    const placed = () => (stored(fs, `${folderOf(moby.bookId)}/book.json`) as { position?: string }).position
    /* The write itself is promises all the way down, so turning the event loop
       without moving the clock is enough for it — and is all this allows. */
    for (let turn = 0; turn < 500 && placed() !== THERE; turn += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
    }
    expect(placed(), 'pagehide lost the place').toBe(THERE)
  })

  it('writes the reading position when the window comes apart', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    const fs = fakeFs(moby.files) as unknown as IndexFs
    await mount(fs, [moby.row])
    await open('Moby-Dick')
    await act(async () => reader.live!.relocate(THERE))
    await settle()
    cleanup()
    await eventually(() =>
      expect(
        (stored(fs, `${folderOf(moby.bookId)}/book.json`) as { position?: string }).position,
        'the place was lost with the window',
      ).toBe(THERE),
    )
  })

  it('takes a book in: its bytes kept, its row written, and where it came from with it', async () => {
    /* The row is the index's, and its record has not landed — so what the open
       supplies is the whole of what the record says about where this copy came
       from. */
    const moby = await shelved(BYTES, 'Moby-Dick')
    const origin = '/Users/reader/Books/Moby-Dick.epub'
    const fs = fakeFs({ [`${folderOf(moby.bookId)}/content.epub`]: BYTES }) as unknown as IndexFs
    await mount(fs, [{ ...moby.row, origin }])
    await open('Moby-Dick')
    await eventually(() => expect(stored(fs, `${folderOf(moby.bookId)}/book.json`), 'the book was never taken in').not.toBeNull())
    const record = stored(fs, `${folderOf(moby.bookId)}/book.json`) as { origin?: string; title?: string }
    expect(record.origin, 'the open forgot where the book came from').toBe(origin)
  })

  it('keeps a book that was dropped on the window, bytes and row alike', async () => {
    const fs = fakeFs() as unknown as IndexFs
    await mount(fs)
    fireEvent.drop(window, {
      dataTransfer: { files: [new File([OTHER], 'bartleby.epub')], items: [], types: ['Files'] },
    })
    const bookId = await bookIdFor(new File([OTHER], 'content.epub'))
    await eventually(() => {
      expect(stored(fs, `${folderOf(bookId)}/book.json`), 'the dropped book was never taken in').not.toBeNull()
      expect(
        (fs as unknown as { store: Map<string, Uint8Array> }).store.has(`${folderOf(bookId)}/content.epub`),
        'the dropped book’s bytes were never kept',
      ).toBe(true)
    })
  })
})

describe('the titlebar over an open book', () => {
  const chip = () => screen.getByTitle('Switch book').textContent

  it('names the book and where in it the reader is — the chapter, else the author, else nothing', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    await eventually(() => expect(chip()).toBe('Moby-DickLoomings'))

    await act(async () => reader.live!.relocate(THERE, ''))
    await eventually(() => expect(chip(), 'with no chapter, the author').toBe('Moby-DickHerman Melville'))
  })

  it('names nothing under a book that declares no author, where no chapter is known', async () => {
    reader.chapter = ''
    reader.author = ''
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    await eventually(() => expect(chip()).toBe('Moby-Dick'))
  })
})

describe('a link that leaves the book, opened', () => {
  it('says nothing when the link opened, and leaves what was already said', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    /* A refusal first, so there is a notice for a success to leave alone. */
    await act(async () => reader.live!.external({ href_: 'javascript:alert(1)' }, new Event('external-link', { cancelable: true })))
    await eventually(() => expect(noticed()).toContain('Paper only opens web links'))

    /* Now as the shell, which may open a web address. */
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    await act(async () =>
      reader.live!.external({ href_: 'https://example.org/whaling' }, new Event('external-link', { cancelable: true })),
    )
    await eventually(() => expect(shell.invoked, 'the link was never handed to the shell').toContain('open_external'))
    await settle()
    expect(noticed(), 'a link that opened wiped the notice before it').toContain('Paper only opens web links')
  })
})

describe('the shelf filling itself in', () => {
  /** A shelf row nobody has opened: bytes in the vault, no parse. */
  async function unparsed(name: string, bytes: string) {
    const bookId = await bookIdFor(new File([bytes], 'content.epub'))
    return {
      bookId,
      files: {
        [`${folderOf(bookId)}/book.json`]: JSON.stringify({ title: name, author: '' }),
        [`${folderOf(bookId)}/content.epub`]: bytes,
      },
      row: { bookId, title: name, author: '', hasContent: true } as IndexedBook,
    }
  }

  it('reads a book nobody has opened and puts what it finds on the shelf', async () => {
    const one = await unparsed('moby-dick-1851', BYTES)
    await mount(fakeFs(one.files) as unknown as IndexFs, [one.row])
    expect(await screen.findByTitle('Open Parsed moby-dick-1851'), 'what the parse found never reached the shelf').toBeTruthy()
    expect(parses.names, 'the background pass never read the book').toHaveLength(1)
  })

  it('leaves the shelf alone while the reader is inside a book', async () => {
    /* A reader in a book is spending the main thread on page turns, and a
       background parse lands as a stutter in the one place this has to be
       smooth. `?book=` opens the window straight into the reader. */
    window.history.replaceState(null, '', '/?book=/sample.epub')
    try {
      const one = await unparsed('moby-dick-1851', BYTES)
      await mount(fakeFs(one.files) as unknown as IndexFs, [one.row])
      await eventually(() => expect(reader.opened[0]?.published, 'the reader never opened its book').toBe(true))
      /* The pass would have started at once — there is no breath before the
         first book — so a wait past one is a wait past it. */
      await breathe()
      expect(parses.names, 'the pass parsed under a reader who was in a book').toEqual([])

      /* And it starts as soon as they step back to the shelf. */
      accel('l')
      await eventually(() => expect(parses.names).toHaveLength(1))
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })

  it('stands down while books are still arriving', async () => {
    /* The import shelves as it copies, so its rows reach this pass while it is
       running — and a parse a second against a copy loop wanting the same
       thread is the one thing the pass exists to avoid. */
    const one = await unparsed('one-1851', BYTES)
    const two = await unparsed('two-1851', OTHER)
    const base = fakeFs({ ...one.files, ...two.files })
    const gate = { hold: false, waiting: [] as (() => void)[] }
    const fs = {
      ...base,
      writeFile: async (path: string, bytes: Uint8Array) => {
        if (gate.hold && path.endsWith('.writing')) await new Promise<void>((go) => gate.waiting.push(go))
        return base.writeFile(path, bytes)
      },
    } as unknown as IndexFs
    parses.armed = true
    await mount(fs, [one.row, two.row])
    await eventually(() => expect(parses.names, 'the pass did not start on the shelf').toHaveLength(1))

    gate.hold = true
    fireEvent.drop(window, {
      dataTransfer: {
        files: [new File(['three'], 'three.epub'), new File(['four'], 'four.epub')],
        items: [],
        types: ['Files'],
      },
    })
    await eventually(() => expect(gate.waiting.length, 'the import never reached its first write').toBeGreaterThan(0))
    release(parses)
    /* PAST THE BREATH the pass takes between books — before it, a second parse
       could not have started whether or not the import was honoured. */
    await breathe()
    expect(parses.names, 'the pass parsed a second book while an import was copying').toHaveLength(1)
    expect(gate.waiting.length, 'the import finished, so this proved nothing').toBeGreaterThan(0)

    gate.hold = false
    for (const go of gate.waiting.splice(0)) go()
    /* The import ends by OPENING the book it added, so the reader is in a book
       — the pass's other stand-down. Back to the shelf, where it works. */
    await eventually(() => expect(screen.queryByText(/^Importing /u)).toBeNull())
    await eventually(() => expect(reader.opened.at(-1)?.published).toBe(true))
    accel('l')
    await eventually(() => expect(parses.names.length, 'the pass never came back once the import was done').toBeGreaterThan(1))
  })
})

describe('what another reader marked, and what this reader could not place', () => {
  it('hands the renderer the passages a capability contributed for this book', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    const asked: string[] = []
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row], [
      {
        id: 'circle',
        overlays: [
          {
            id: 'circle:shared',
            forBook: async ({ bookId, resolve }) => {
              asked.push(bookId)
              /* ANCHORED IN THE OPEN BOOK, which is what the resolver is for —
                 a passage nobody could place is not drawn. */
              const walk = await resolve([{ id: 'shared-1', quote: 'call me ishmael', prefix: '', suffix: '' }])
              return walk.found.map((one) => ({
                person: 'person:queequeg',
                cfi: one.cfi,
                sectionIndex: one.sectionIndex,
                quote: 'call me ishmael',
                people: ['person:queequeg'],
                opinions: [{ pub: 'pub-1', audience: 'circle' as const, author: 'Queequeg', note: 'the best line' }],
              }))
            },
            subscribe: () => () => {},
          },
        ],
      },
    ])
    await open('Moby-Dick')
    await eventually(() => expect(reader.live!.overlays(), 'nothing another reader marked reached the renderer').toHaveLength(1))
    expect(asked, 'the capability was never asked about this book').toEqual([moby.bookId])
  })

  it('walks the open book for a mark that has no anchor here, and writes what it finds', async () => {
    /* An imported mark carries the words and no place in THIS build of the
       book. The walk happens once the book is parsed — run before that, it
       finds nothing and never comes back. */
    const moby = await shelved(BYTES, 'Moby-Dick')
    const fs = fakeFs({
      ...moby.files,
      /* An imported mark: the reader's own words, and no anchor in THIS build
         of the book — which is what the walk is for. */
      [`${folderOf(moby.bookId)}/marks.json`]: JSON.stringify([
        {
          ...mark(moby.bookId, '', 'a passage from elsewhere'),
          unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
        },
      ]),
    }) as unknown as IndexFs
    await mount(fs, [moby.row])
    await open('Moby-Dick')
    await eventually(() => {
      const written = stored(fs, `${folderOf(moby.bookId)}/marks.json`) as { cfi: string }[]
      expect(written[0]!.cfi, 'what the walk found was never written').toBe(THERE)
    })
    expect(reader.opened[0]!.reanchored.flat(), 'the book was walked more than once for one mark').toHaveLength(1)
  })
})

describe('removing the open book while it is still being taken in', () => {
  it('keeps it removed, rather than putting it back under its own intake', async () => {
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
    }
    const moby = await shelved(BYTES, 'Moby-Dick')
    const base = fakeFs(moby.files)
    /* The intake's own long step, held open: it asks whether the record is
       there before it keeps the bytes, and the removal lands while it waits. */
    const gate = { hold: true, waiting: [] as (() => void)[] }
    const fs = {
      ...base,
      exists: async (path: string) => {
        if (gate.hold && path.endsWith('/book.json')) await new Promise<void>((go) => gate.waiting.push(go))
        return base.exists(path)
      },
    } as unknown as IndexFs
    try {
      await mount(fs, [moby.row])
      await open('Moby-Dick')
      await eventually(() => expect(gate.waiting.length, 'the intake never reached its long step').toBeGreaterThan(0))
      accel('l')
      await settle()

      fireEvent.click(screen.getByLabelText('More for Moby-Dick'))
      await settle()
      fireEvent.click(screen.getByLabelText('Remove Moby-Dick'))
      await settle()
      fireEvent.click(screen.getByLabelText(/^Remove Moby-Dick — the file you imported is kept/u))
      await settle()

      gate.hold = false
      for (const go of gate.waiting.splice(0)) go()
      /* Settled when the removal has reached the trash — the last write of the
         two racing for this book's lane. */
      await eventually(() =>
        expect([...base.store.keys()].some((key) => key.startsWith('trash/')), 'the removal never landed').toBe(true),
      )
      await settled(4)
      expect(screen.queryByTitle('Open Moby-Dick'), 'the book came back under its own intake').toBeNull()
    } finally {
      Element.prototype.getBoundingClientRect = rect
      gate.hold = false
      for (const go of gate.waiting.splice(0)) go()
    }
  })
})

describe('a jump into a book whose stored copy is gone', () => {
  const ORIGIN = '/Users/reader/Books/Bartleby.epub'
  const ADDRESS = 'https://example.org/bartleby.epub'

  /** Moby-Dick open, and a mark in a book the vault holds no copy of. */
  async function jumpingTo(origin: string) {
    const one = await shelved(BYTES, 'Moby-Dick')
    const two = await shelved(OTHER, 'Bartleby')
    const fs = fakeFs({
      ...one.files,
      [`${folderOf(two.bookId)}/book.json`]: JSON.stringify(two.record),
      [`${folderOf(two.bookId)}/marks.json`]: JSON.stringify([mark(two.bookId, THERE, 'i would prefer not to')]),
    }) as unknown as IndexFs
    await mount(fs, [one.row, { ...two.row, origin }])
    await open('Moby-Dick')
    accel('2')
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: /i would prefer not to/u }))
    await eventually(() => {
      expect(reader.opened, 'the other book never opened at all').toHaveLength(2)
      expect(reader.opened[1]!.published).toBe(true)
    })
    return { one, two }
  }
  /* THE JUMP IS THE SAME JUMP, by whichever route the bytes arrived: what it
     committed is still the reader's, and a fallback that retired the rollback
     would take the way back with it. */
  const landedWithTheJumpIntact = async () => {
    expect(reader.opened, 'the other book never opened at all').toHaveLength(2)
    await settled(2)
    expect(screen.getByRole('button', { name: /← Back to Loomings/u }), 'the way back was taken away').toBeTruthy()
  }

  it('carries the jump through the reader’s own file, mark and all', async () => {
    await jumpingTo(ORIGIN)
    expect(disk.read).toEqual([ORIGIN])
    await landedWithTheJumpIntact()
    /* The file is this book's own copy, so the place the jump asked for still
       applies to it. */
    expect(reader.opened[1]!.lastLocation, 'the fallback opened the book at its saved place').toBe(THERE)
  })

  it('carries the jump through an address, without looking for a file of that name', async () => {
    await jumpingTo(ADDRESS)
    expect(disk.read, 'an address was looked for on the reader’s own disk').toEqual([])
    await landedWithTheJumpIntact()
    expect(reader.opened[1]!.source).toBe(ADDRESS)
  })

  it('carries the jump through the origin as an ADDRESS when the file is not there', async () => {
    /* ⚠️ **AND SAYS WHY THE PATH FAILED, BEFORE THE ADDRESS HAS A CHANCE TO.** If
       the address fails too, that is the failure the reader sees — and the
       reason the path failed, usually the useful one, was discarded by an empty
       `catch`. The line exists only to keep that evidence. */
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    disk.refuse.add(ORIGIN)
    await jumpingTo(ORIGIN)
    expect(disk.read).toEqual([ORIGIN])
    await landedWithTheJumpIntact()
    expect(reader.opened[1]!.source, 'the path was never tried as an address').toBe(ORIGIN)
    expect(said).toHaveBeenCalledWith(
      'Paper: could not read the book at its saved place, trying it as an address',
      expect.anything(),
    )
    said.mockRestore()
  })

  /* BOTH HALVES OF THE FALLBACK ARE GUARDED, and each has its own late answer:
     the file that arrives and the file that is not there. */
  it.each([
    ['whose file arrives late', false],
    ['whose file is gone, late', true],
  ])('opens nothing from a fallback the reader has moved on from — one %s', async (_how, gone) => {
    disk.hold.add(ORIGIN)
    if (gone) disk.refuse.add(ORIGIN)
    const one = await shelved(BYTES, 'Moby-Dick')
    const two = await shelved(OTHER, 'Bartleby')
    const fs = fakeFs({
      ...one.files,
      [`${folderOf(two.bookId)}/book.json`]: JSON.stringify(two.record),
    }) as unknown as IndexFs
    await mount(fs, [one.row, { ...two.row, origin: ORIGIN }])
    fireEvent.click(screen.getByTitle('Open Bartleby'))
    await eventually(() => expect(disk.read, 'the fallback never started').toEqual([ORIGIN]))
    expect(reader.opened, 'something opened before the file had been read').toHaveLength(0)

    /* The reader asks for another book while the fallback is still reading. */
    await open('Moby-Dick')
    expect(reader.opened).toHaveLength(1)

    disk.hold.clear()
    for (const go of disk.waiting.splice(0)) go()
    await settled(6)
    expect(reader.opened, 'a fallback the reader had moved on from opened its book').toHaveLength(1)
  })
})

describe('books a launch carried', () => {
  it('keeps the path they came from, so the shelf can open them again', async () => {
    /* The launch takes the picker's route, with the path kept beside the bytes
       — a `File` alone is a handle granted for one session. */
    let deliver: ((paths: readonly string[]) => void) | null = null
    const fs = fakeFs() as unknown as IndexFs
    await mount(fs, [], [], {
      subscribe: (handler: (paths: readonly string[]) => void) => {
        deliver = handler
        return () => {
          deliver = null
        }
      },
    })
    await act(async () => deliver?.(['/Users/reader/Books/Moby-Dick.epub']))

    const bookId = await bookIdFor(new File([OTHER], 'content.epub'))
    await eventually(() =>
      expect(stored(fs, `${folderOf(bookId)}/book.json`), 'the book the launch carried was never taken in').not.toBeNull(),
    )
    const record = stored(fs, `${folderOf(bookId)}/book.json`) as { origin?: string }
    expect(record.origin, 'the path the launch carried was not kept').toBe('/Users/reader/Books/Moby-Dick.epub')
  })
})

/**
 * ⚠️ **A PAGE TURN USED TO REINSTALL THE WHOLE KEYBOARD MAP.** The key handler's
 * effect listed the entire `book`, and `book` takes a new identity whenever any
 * of its values moves — its position among them — so every turn removed both
 * global key listeners and added them again. The body reads four stable
 * callbacks and whether a book is open; those are what it lists now. Counted
 * across real relocations, because "it re-ran" is invisible in behaviour: the
 * keys still worked, which is why nothing noticed.
 */
describe('turning a page', () => {
  it('does not reinstall the keyboard listeners', async () => {
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    await settle()

    const added = vi.spyOn(window, 'addEventListener')
    try {
      for (const cfi of [THERE, HERE, THERE]) {
        await act(async () => reader.live!.relocate(cfi))
        await settle()
      }
      const keydowns = added.mock.calls.filter(([type]) => type === 'keydown')
      expect(keydowns, 'no key listener was added for a page turn').toEqual([])
    } finally {
      added.mockRestore()
    }
  })
})

/**
 * NO VOICE RATHER THAN A BAD ONE, THROUGH THE WHOLE APP.
 *
 * The rule lives in `voiceChoice.ts` and the button in `TitleBar`, and each is
 * tested alone; what neither can see is the wire between them — `App` reading
 * the engine's live list through `useVoices`, asking `voiceFor` about the book on
 * screen, and handing the answer to the Listen control. A wire that went nowhere
 * would leave the button enabled over a reading the speaker refuses.
 */
describe('the Listen control and the voices this machine has', () => {
  afterEach(() => {
    delete (window as { speechSynthesis?: unknown }).speechSynthesis
    delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
  })

  /** A catalogue with one English pack, installed or not. */
  function withEnglishPack(installed: boolean) {
    return (services: ReturnType<typeof createKernelServices>) => {
      services.bindSpeechEngines({
        catalogue: async () => [
          {
            id: 'english-kokoro',
            name: 'English',
            summary: '',
            family: 'kokoro',
            languages: ['en'],
            bytes: 336_822_660,
            minimumMemoryGb: 4,
            voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
            installed,
          },
        ],
        install: async () => {},
        remove: async () => {},
        render: async () => ({ pcm: new Uint8Array(0), sampleRate: 24_000, words: [], skipped: [] }),
        release: async () => {},
      })
    }
  }

  async function listenWith(
    voices: readonly { name: string; lang: string; voiceURI: string }[],
    before?: (services: ReturnType<typeof createKernelServices>) => void,
  ) {
    const synth = new FakeSynth()
    synth.voices = [...voices]
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true })
    window.SpeechSynthesisUtterance = FakeUtterance as unknown as typeof SpeechSynthesisUtterance
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row], [], undefined, before)
    await open('Moby-Dick')
    /* The catalogue is READ, not handed over: `useVoicePacks` asks the port in
       an effect and publishes what comes back, so the first answer lands a few
       turns after the mount. */
    await settled()
    /* BY ITS LABEL ATTRIBUTE, not by role and name: the reading chrome is faded
       out until the pointer asks for it, which takes it out of the
       accessibility tree, and an element there computes an empty accessible
       name. What is under test is the control's state, not whether it shows. */
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]')
    expect(button, 'the Listen control is not in the title bar').not.toBeNull()
    return button!
  }

  it('is disabled, and says why, when every voice is below the floor — a Mac', async () => {
    const button = await listenWith([
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.super-compact.en-US.Samantha' },
    ])
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toBe(`Listen — ${NO_GOOD_VOICE}`)
  })

  it('reads when a voice above the floor is there', async () => {
    const button = await listenWith([
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
      { name: 'Zoe', lang: 'en-US', voiceURI: 'com.apple.voice.enhanced.en-US.Zoe' },
    ])
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('title')).toBe('Read this chapter aloud')
  })

  /**
   * ⚠️ **A DOWNLOADED PACK IS ASKED FIRST, AND NOTHING HELD `App` TO IT.** The
   * mutation gate found it: `engineVoiceFor(...)` in `listenRefusal` could be
   * replaced with `false` and every test still passed — so a Mac with the
   * English pack installed, where no platform voice clears the floor, would
   * show the control disabled saying no high-quality voice is available while
   * the reading was perfectly able to read the book. That exact sentence over
   * an installed pack is the defect WI-30.11 found in the running app.
   */
  it('reads on a downloaded pack even where every platform voice is below the floor', async () => {
    reader.prose = '<p>Call me Ishmael.</p>'
    reader.lang = 'en'
    const button = await listenWith(
      [{ name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }],
      withEnglishPack(true),
    )
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('title')).toBe('Read this chapter aloud')
  })

  /* And a pack that is OFFERED but not here names itself and its size, which is
     advice a reader can act on where NO_GOOD_VOICE alone is a dead end. */
  it('names the pack that would read it, when the pack is not installed', async () => {
    reader.prose = '<p>Call me Ishmael.</p>'
    reader.lang = 'en'
    const button = await listenWith(
      [{ name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }],
      withEnglishPack(false),
    )
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toMatch(/Download the English voice \(321 MB\)/u)
  })
})

describe('the reading transport over a real book', () => {
  /**
   * ⚠️ **ONE LOOKUP SERVES THE CONTROL AND THE STEP**, so what the transport
   * DRAWS and what the step TAKES cannot disagree. They were computed
   * separately once — a `stepChapter` here and another inside the action — and
   * the two were reconciled only by both being correct.
   *
   * This is the host's half of read-aloud: the hook knows how to speak, and
   * only the host knows what the next chapter is.
   */
  afterEach(() => {
    delete (window as { speechSynthesis?: unknown }).speechSynthesis
    delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
  })

  /** A machine with one voice the floor accepts. */
  function engine() {
    const synth = new FakeSynth()
    synth.voices = [
      { name: 'Zoe', lang: 'en-US', voiceURI: 'com.apple.voice.enhanced.en-US.Zoe', localService: true },
    ]
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true })
    window.SpeechSynthesisUtterance = FakeUtterance as unknown as typeof SpeechSynthesisUtterance
    return synth
  }

  /** A book open, read aloud, with the transport on screen. */
  async function reading(toc: readonly { label: string; href: string }[]) {
    const synth = engine()
    reader.toc = [...toc]
    reader.prose = '<p>Call me Ishmael. Some years ago.</p><p>It is a way I have.</p>'
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    await open('Moby-Dick')
    const listen = document.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]')
    expect(listen, 'the Listen control is not in the title bar').not.toBeNull()
    await act(async () => {
      listen!.click()
    })
    await settled()
    return { synth, session: reader.opened.at(-1)! }
  }

  const control = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

  it('offers the chapter ahead, and takes the reader there', async () => {
    const { session } = await reading([
      { label: 'One', href: 'chapter-1.xhtml' },
      { label: 'Two', href: 'chapter-2.xhtml' },
    ])
    expect(control('Next chapter'), 'the chapter ahead was not offered').not.toBeNull()
    expect(control('Previous chapter'), 'there is no chapter before the first').toBeNull()

    await act(async () => {
      control('Next chapter')!.click()
    })
    expect(session.goTo, 'the step did not take the reader anywhere').toContain('chapter-2.xhtml')
  })

  it('follows the reader into the next chapter, and offers the way back from there', async () => {
    /* ⚠️ **THE STEP IS A MEMO OVER THE READER'S PLACE**, and one that never
       recomputed would go on offering what was true where the reading began:
       forward from the first chapter for ever, and never back. */
    await reading([
      { label: 'One', href: 'chapter-1.xhtml' },
      { label: 'Two', href: 'chapter-2.xhtml' },
    ])
    expect(control('Previous chapter')).toBeNull()

    reader.chapterHref = 'chapter-2.xhtml'
    await act(async () => {
      reader.live!.relocate('epubcfi(/6/6!/4/2)')
    })
    await settled()
    expect(control('Previous chapter'), 'the step did not follow the reader').not.toBeNull()
    expect(control('Next chapter'), 'there is no chapter after the last').toBeNull()
  })

  it('offers no chapter step in a book whose contents names none', async () => {
    /* The transport is still there — sentences and paragraphs are the reader's
       whatever the contents says — and the chapter controls are absent rather
       than disabled, because there is genuinely nowhere to go. */
    await reading([])
    expect(control('Stop reading aloud'), 'the transport itself is missing').not.toBeNull()
    expect(control('Next chapter')).toBeNull()
    expect(control('Previous chapter')).toBeNull()
  })

  it('offers no chapter step from a section the contents does not name', async () => {
    /* A reader can be in a spine item no contents entry points at, and guessing
       a neighbour for it would move them somewhere they did not ask for. */
    reader.chapterHref = ''
    await reading([
      { label: 'One', href: 'chapter-1.xhtml' },
      { label: 'Two', href: 'chapter-2.xhtml' },
    ])
    expect(control('Next chapter')).toBeNull()
    expect(control('Previous chapter')).toBeNull()
  })

  it('reads at the speed the reader has stored, and at the one they change it to', async () => {
    /* ⚠️ **THE PREFERENCES ARE A MEMO OVER APP STATE**, and the engine reads
       them per utterance: a memo that never recomputed would hold the speed the
       session started at, so the transport's own speed control would move a
       number nobody hears. */
    const synth = engine()
    reader.prose = '<p>Call me Ishmael. Some years ago.</p><p>It is a way I have.</p>'
    const moby = await shelved(BYTES, 'Moby-Dick')
    const storage = new Map<string, string>([
      [SETTINGS_STORAGE_KEY, JSON.stringify({ version: SETTINGS_VERSION, values: { 'kernel.readingRate': 1.5 } })],
    ])
    const services = createKernelServices({
      fs: fakeFs(moby.files) as unknown as IndexFs,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      },
      initialBooks: [moby.row],
    })
    const composition = await composeCapabilities([], kernelApi(services), new AbortController().signal)
    render(<App services={services} fs={fakeFs(moby.files) as unknown as IndexFs} composition={composition} />)
    await settle()
    await open('Moby-Dick')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]')!.click()
    })
    await settled()
    expect(synth.queued.at(0)?.rate, 'the stored speed did not reach the engine').toBe(1.5)

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label^="Reading speed"]')!.click()
    })
    await settled()
    expect(
      document.querySelector('button[aria-label^="Reading speed"]')?.getAttribute('aria-label'),
      'the speed control did not move',
    ).toBe('Reading speed 1.75×')

    /* AND THE VOICE HEARS IT at the next sentence — the control moving is the
       state; the engine being given it is the memo the reading reads from. */
    await act(async () => {
      synth.queued.at(-1)?.dispatchEvent(new Event('end'))
    })
    /* After the sentence gap, which is a real timer here. */
    await waitFor(() => expect(synth.queued).toHaveLength(2))
    expect(synth.queued.at(-1)?.text.trim()).toBe('Some years ago.')
    expect(synth.queued.at(-1)?.rate, 'the next sentence was read at the old speed').toBe(1.75)
  })
})

/**
 * The audiobook export, as the palette offers it.
 *
 * ⚠️ **TWO GATES, AND EACH HAD NO CASE.** The engine exists on macOS alone, so
 * everywhere else the command must not be there at all — offered, it could only
 * refuse. And a book is ready for it only once its document is: the id resolves
 * from the bytes before the parse, and an export started in that gap reported
 * the reader's book as unreadable.
 */
describe('the audiobook export', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  async function openBook(platform: 'macos' | 'linux') {
    /* The platform is resolved once, at mount, from the URL override first. */
    window.history.replaceState(null, '', `/?platform=${platform}`)
    reader.prose = '<p>Call me Ishmael.</p>'
    const moby = await shelved(BYTES, 'Moby-Dick')
    await mount(fakeFs(moby.files) as unknown as IndexFs, [moby.row])
    return () => open('Moby-Dick')
  }

  it('is offered for an open book on the platform with the engine', async () => {
    const opening = await openBook('macos')
    expect(await paletteOffers('audiobook', 'Export as audiobook…'), 'offered with no book open').toBe(false)
    await opening()
    expect(await paletteOffers('audiobook', 'Export as audiobook…'), 'the open book was not offered').toBe(true)
  })

  it('is not offered where there is no engine to write it', async () => {
    const opening = await openBook('linux')
    await opening()
    expect(await paletteOffers('audiobook', 'Export as audiobook…')).toBe(false)
  })

  it('waits for the book’s document, which is what the walk runs over', async () => {
    const opening = await openBook('macos')
    reader.prose = null
    await opening()
    expect(await paletteOffers('audiobook', 'Export as audiobook…'), 'a book with no document yet').toBe(false)
  })
})
