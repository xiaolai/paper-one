// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexFs, IndexedBook } from '../core/bookIndex'
import type { ScreenContribution } from '../core/capability'
import type { ImportOutcome } from '../core/importFolder'
import type { OpenRequests } from './openedFiles'
import type { DiagnosticLog } from '../core/diagnosticsLog'
import type { TrashedBook } from '../core/bookTrash'
import { settleBeforeDrain } from '../core/beforeClose'
import { createDiagnosticLog } from '../core/diagnosticsLog'
import { KERNEL_SETTINGS } from '../core/settings'
import { DEFAULT_STEP_IDX, PANE_TRACK, readingStep } from '../core/metrics'
import { MAX_FILES } from '../core/importFolder'
import { META_SCHEMA, folderOf } from '../core/bookFolder'
import { bookIdFor } from '../core/marks'
import { fakeFs } from '../core/indexFsFake.testkit'
import { composeCapabilities, kernelApi } from '../core/registry'
import { createKernelServices } from '../core/services'
import { UNFINISHED_PANE_IDS } from '../core/uiTypes'
import { PANE_TITLES } from './panes'
import readerStyles from './screens/Reader.module.css'

/**
 * `App`, mounted whole over the kernel's own services and a composition —
 * the wiring that no component test below it can see.
 *
 * What lives only here: what a contributed screen is HANDED; the trash
 * sheet's restore, whose row is released by `App`'s scan and not by the
 * sheet; the window's keyboard; the palette's own commands; and the shelf's
 * way into the reader and back. Nothing is mocked but the trash listing,
 * which has to be held open, and the two DOM APIs jsdom lacks.
 */

/* The trash listing is replaced so a scan can be held open: which scan
   answers, and when, is the whole subject of the restore test. */
const trash = vi.hoisted(() => ({
  scans: [] as { resolve(rows: TrashedBook[]): void; reject(cause: unknown): void }[],
}))
vi.mock('../core/bookTrash', async (importActual) => ({
  ...(await importActual<typeof import('../core/bookTrash')>()),
  listTrash: () =>
    new Promise<TrashedBook[]>((resolve, reject) => {
      trash.scans.push({ resolve, reject })
    }),
}))

/* THREE MORE SEAMS, EACH THE REAL FUNCTION UNTIL A TEST HOLDS IT. The races
   below are about which of two slow things lands last, and holding one open is
   the only way to put them in an order: an ARMED gate parks each call until
   `release`, and every other call goes straight through. */
const held = vi.hoisted(() => ({
  reads: { armed: false, waiting: [] as (() => void)[] },
  copies: {
    armed: false,
    /** Books held by NAME, for a run whose first copy must land and whose second must not. */
    names: new Set<string>(),
    waiting: [] as (() => void)[],
    signals: [] as (AbortSignal | undefined)[],
  },
  folders: {
    picks: [] as ((folder: string | null) => void)[],
    /** The picker's own failure, for the route that must say so rather than look cancelled. */
    refusePick: [] as ((cause: unknown) => void)[],
    walks: [] as (AbortSignal | undefined)[],
    /** Each walk's own handles, so a test can copy a book, report progress, or fail. */
    runs: [] as {
      readonly onCopied: (copied: readonly ImportOutcome[]) => void
      readonly onProgress: (progress: { done: number; total: number }) => void
      readonly done: (outcomes: readonly ImportOutcome[]) => void
      readonly fail: (cause: unknown) => void
    }[],
  },
  origins: [] as string[],
  /** Paths `readBookAt` refuses — the reader's own file, gone from where it was. */
  refuseOrigins: new Set<string>(),
  /** The native picker's answers, one per call, resolved or refused by the test. */
  pickers: [] as { resolve(picked: unknown): void; reject(cause: unknown): void }[],
}))
vi.mock('../core/bookVault', async (importActual) => {
  const actual = await importActual<typeof import('../core/bookVault')>()
  return {
    ...actual,
    readOwnedBook: async (...args: Parameters<typeof actual.readOwnedBook>) => {
      if (held.reads.armed) await new Promise<void>((go) => held.reads.waiting.push(go))
      return actual.readOwnedBook(...args)
    },
  }
})
vi.mock('../core/importFolder', async (importActual) => {
  const actual = await importActual<typeof import('../core/importFolder')>()
  return {
    ...actual,
    keepOwnCopy: async (...args: Parameters<typeof actual.keepOwnCopy>) => {
      held.copies.signals.push(args[3])
      /* By name as well as wholesale, so one book in the middle of a batch can
         be held while the ones before it finish — which is how "what a
         superseded run had already copied" is put in an order. */
      if (held.copies.armed || held.copies.names.has(args[1].name)) {
        await new Promise<void>((go) => held.copies.waiting.push(go))
      }
      return actual.keepOwnCopy(...args)
    },
    /* A walk that ends only when told to: the import stays running for as long
       as the test needs it to, what it was handed is kept, and an abort ends it
       the way it ends the real walk — with what it has, which here is nothing.
       It never ended at all, which left nothing for a teardown to wait on. */
    importFolder: (
      _fs: unknown,
      _root: string,
      options: {
        readonly signal?: AbortSignal
        readonly onCopied?: (copied: readonly ImportOutcome[]) => void
        readonly onProgress?: (progress: { done: number; total: number }) => void
      },
    ) => {
      held.folders.walks.push(options.signal)
      return new Promise<readonly ImportOutcome[]>((done, fail) => {
        options.signal?.addEventListener('abort', () => done([]))
        held.folders.runs.push({
          onCopied: (copied) => options.onCopied?.(copied),
          onProgress: (progress) => options.onProgress?.(progress),
          done,
          fail,
        })
      })
    },
  }
})
/* The shell's own window, for the one key that asks it to close. Inert until a
   test says this is Tauri — `inTauri` reads a global, and nothing calls into
   here while it is absent. */
const tauri = vi.hoisted(() => ({
  closes: 0,
  destroys: 0,
  /** What the window hands its close request to — the shell's own event, driven by a test. */
  onClose: [] as ((event: { preventDefault(): void }) => Promise<void>)[],
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: async () => {
      tauri.closes += 1
    },
    destroy: async () => {
      tauri.destroys += 1
    },
    minimize: async () => {},
    toggleMaximize: async () => {},
    onCloseRequested: async (handler: (event: { preventDefault(): void }) => Promise<void>) => {
      tauri.onClose.push(handler)
      return () => {}
    },
  }),
}))
vi.mock('../core/bookFiles', async (importActual) => ({
  ...(await importActual<typeof import('../core/bookFiles')>()),
  pickFolder: () =>
    new Promise<string | null>((resolve, reject) => {
      held.folders.picks.push(resolve)
      held.folders.refusePick.push(reject)
    }),
  /* The native picker, answered by the test — a list of books, an empty list
     for a cancelled dialog, or a rejection for one that broke. */
  pickBooks: () => new Promise<unknown>((resolve, reject) => held.pickers.push({ resolve, reject })),
  /* The reader's own file, which only the origin fallback reads: recorded, so a
     test can see whether the fallback was taken, and answered with the stored
     book's bytes, so a book it opens reaches the reader. */
  readBookAt: async (path: string) => {
    held.origins.push(path)
    if (held.refuseOrigins.has(path)) throw new Error(`no such file: ${path}`)
    return new File([BYTES], 'content.epub')
  },
}))

import { App } from './App'

/** Let every parked call through, and stop parking. */
const release = (gate: { armed: boolean; waiting: (() => void)[]; names?: Set<string> }) => {
  gate.armed = false
  gate.names?.clear()
  for (const go of gate.waiting.splice(0)) go()
}

/* ⚠️ **EVERY TEST STARTS FROM A CLEAN HARNESS, AND THIS DID NOT MAKE ONE**
   (2026-09-14, round 4). The gates were released AFTER the unmount, so a copy a
   test left parked went on running into the next test and pushed its signal
   into that test's list: the shutdown test passed alone and failed in the file,
   and round 3 loosened the test rather than stopping the leak. What a test
   leaves running is stopped here, by the window's own teardown —
   `settleBeforeDrain` reaches the import's `stop`, which aborts every run and
   waits for each to let go — with the gates opened so a parked copy can see its
   abort, and all of it before the window is unmounted. */
afterEach(async () => {
  await act(async () => {
    const stopped = settleBeforeDrain()
    release(held.reads)
    release(held.copies)
    await stopped
  })
  cleanup()
  trash.scans.length = 0
  held.copies.names.clear()
  held.copies.signals.length = 0
  held.folders.picks.length = 0
  held.folders.refusePick.length = 0
  held.folders.walks.length = 0
  held.folders.runs.length = 0
  held.origins.length = 0
  held.refuseOrigins.clear()
  held.pickers.length = 0
  tauri.closes = 0
  tauri.destroys = 0
  tauri.onClose.length = 0
})
/* jsdom has no `scrollIntoView` (the palette's active row calls it) and no
   `ResizeObserver` (the reader measures its stage with one). */
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never
/* NO NETWORK. A book opened from an address is identified by fetching it, and
   the reader fetches it again to parse — refused here, the way an address that
   cannot be reached is refused, rather than letting a test resolve a real host. */
globalThis.fetch = (async (input: unknown) => {
  throw new TypeError(`no network in this suite: ${String(input)}`)
}) as typeof fetch

type ScreenContext = Parameters<ScreenContribution['render']>[0]

/** The whole window over `fs`, with one contributed screen that records what it is handed. */
async function mount(
  fs: IndexFs | null,
  over: {
    readonly books?: readonly IndexedBook[]
    readonly bootNotice?: string
    readonly openRequests?: OpenRequests
    readonly diagnosticLog?: DiagnosticLog
    readonly onDiagnosticsCleared?: () => void
    /** The services, before the window is built over them — a shelf that refuses to write. */
    readonly before?: (services: ReturnType<typeof createKernelServices>) => void
    /** The composition root's own teardown, for a window that has one. */
    readonly beforeWindowClose?: () => Promise<unknown>
    /** More screens than the one this file's window always has. */
    readonly screens?: readonly ScreenContribution[]
    /** A second capability, for what the first cannot be — one whose id is a
     *  kernel command's prefix, say. */
    readonly capability?: Parameters<typeof composeCapabilities>[0][number]
  } = {},
) {
  const services = createKernelServices({ fs, storage: null, initialBooks: over.books ?? [] })
  over.before?.(services)
  const handed: ScreenContext[] = []
  const composition = await composeCapabilities(
    [
      {
        id: 'cap',
        screens: [
          {
            id: 'cap:one',
            label: 'Circle',
            icon: 'people',
            render: (context) => {
              handed.push(context)
              return <p>drawn by the capability</p>
            },
          },
          ...(over.screens ?? []),
        ],
      },
      ...(over.capability === undefined ? [] : [over.capability]),
    ],
    kernelApi(services),
    new AbortController().signal,
  )
  render(
    <App
      services={services}
      fs={fs}
      composition={composition}
      {...(over.bootNotice === undefined ? {} : { bootNotice: over.bootNotice })}
      {...(over.openRequests === undefined ? {} : { openRequests: over.openRequests })}
      {...(over.diagnosticLog === undefined ? {} : { diagnosticLog: over.diagnosticLog })}
      {...(over.onDiagnosticsCleared === undefined ? {} : { onDiagnosticsCleared: over.onDiagnosticsCleared })}
      {...(over.beforeWindowClose === undefined ? {} : { beforeWindowClose: over.beforeWindowClose })}
    />,
  )
  await settle()
  return { services, handed }
}

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0))
  })

/**
 * Wait for what the assertion is ABOUT, not for a number of turns.
 *
 * ⚠️ **A COPY IS A SHA-256 DIGEST AND AN ATOMIC WRITE, and neither finishes on
 * a timetable.** The digest runs on libuv's thread pool and lands whenever it
 * lands; `settle()` is one macrotask. Two of them were enough on an idle
 * machine and not under Stryker's instrumentation, where the batch was still
 * "Importing 1 of 2" when the summary was asserted — which failed another
 * subject's whole dry run (2026-09-15). The ceiling is a ceiling, not a guess:
 * this resolves the moment the state arrives.
 */
const eventually = (assertion: () => void) => waitFor(assertion, { timeout: 15_000 })
/* THE SAME CEILING FOR EVERY `findBy…`. Their default is one second, and a book
   the reader refuses has to reach foliate's dynamic import first — which an
   instrumented runner sharing the machine can take longer than that to do. */
configure({ asyncUtilTimeout: 15_000 })

/**
 * A shelf holding one book whose bytes ARE on disk and are not a book: the
 * id is derived from those bytes, as the reader derives it, so the open
 * book matches its shelf row. Every open of it reaches the reader, which
 * says the file will not parse — the one outcome jsdom can carry a book to.
 */
const BYTES = 'not really an epub'
async function shelfWithMoby() {
  const bookId = await bookIdFor(new File([BYTES], 'content.epub'))
  const fs = fakeFs({
    [`${folderOf(bookId)}/book.json`]: JSON.stringify({ title: 'Moby-Dick', author: 'Herman Melville' }),
    [`${folderOf(bookId)}/content.epub`]: BYTES,
  }) as unknown as IndexFs
  const moby: IndexedBook = { bookId, title: 'Moby-Dick', author: 'Herman Melville', hasContent: true }
  return { fs, moby }
}

/** A row the index still holds while its folder is gone. */
const GONE: IndexedBook = { bookId: 'book:gone', title: 'Gone', author: 'Nobody', hasContent: true }
const COULD_NOT_OPEN = 'That book could not be opened. Try adding it again.'
const COULD_NOT_READ = 'That book could not be read from your library.'
const WILL_NOT_PARSE = 'File type not supported'

/** The chord that reveals the developer surfaces — `event.code`, as the real key arrives. */
/* ⚠️ **Ctrl+Alt+D, BECAUSE THIS WINDOW IS NOT A MAC** — see `accel` below. It
   sent all four modifiers, the Mac's ⌘⌃⌥D, which off a Mac is Ctrl+Alt+Meta+D:
   a combo carrying the one modifier no binding takes, and it toggled developer
   options only because Meta was never read (2026-09-13 audit, #85, round 3). */
const developerChord = () => fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, altKey: true })
/** The accelerator is Ctrl off macOS, and jsdom's user agent is nobody's Mac. */
const accel = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true })
/**
 * Press an accelerator until the window takes it.
 *
 * ⚠️ **FOR A KEY BOUND TO THE OPEN BOOK'S ROW, WHICH WAITS ON A DIGEST.** The
 * row is found by the book's id, and the id is a SHA-256 digest that lands
 * whenever it lands — seeing the reader's refusal on screen says nothing about
 * it. A bound key is a taken one, and a press nothing takes does nothing, so
 * pressing until one is taken waits for exactly that state and no longer. Two
 * tests pressed ⌘T one turn after the refusal and failed with every digest
 * slowed by 40 ms (2026-09-15).
 */
const pressUntilTaken = (key: string, message: string) =>
  eventually(() => expect(accel(key), message).toBe(false))

/** Open the palette from the keyboard — it answers on every screen — and run the command that matches `query`. */
async function runCommand(query: string, label: string) {
  accel('k')
  await settle()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search or ask' }), { target: { value: query } })
  await settle()
  /* WITHIN THE PALETTE. The shelf's empty state draws its own "Add books…" and
     "Import a folder…", so a window-wide match is ambiguous exactly where the
     command matters most. */
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Search or ask' })).getByText(label).closest('button')!)
  await settle()
}

/**
 * Every button in the window drawn under `label`, chrome-faded ones included.
 *
 * ⚠️ **NOT `getByRole(..., { name })`, AND THE REASON IS LOAD-BEARING.** In the
 * reader the titlebar's chrome is `visibility: hidden` until the pointer nears
 * it. `{ hidden: true }` puts those elements back in the role query, but the
 * accessible NAME of an element inside a hidden subtree computes to empty — so
 * matching by name silently skips exactly the controls a test about the
 * titlebar is about. Two earlier versions of the test below passed with the
 * titlebar's filter deliberately removed because of this.
 *
 * The label each surface draws is the thing under test — they all take it from
 * `PANE_TITLES` — so this reads that, and does not ask the accessibility tree
 * to compute anything.
 */
const controlsLabelled = (label: string) =>
  screen
    .getAllByRole('button', { hidden: true })
    .filter((one) => (one.getAttribute('aria-label') ?? one.getAttribute('title') ?? one.textContent ?? '').trim() === label)

const row = (bookId: string, title: string): TrashedBook => ({ folder: bookId.replace(':', '_'), bookId, title, author: 'Someone', removedAt: 1_000, expiresAt: 2_000 })

describe('what a contributed screen is handed', () => {
  it('gets no `openBook` without a filesystem — a control that could open nothing is not offered', async () => {
    /* `openStored` returns at once with no filesystem, and a contribution
       reads the callback's presence to decide whether to draw an Open
       control. Handed over regardless, the browser client drew links that
       silently did nothing. */
    const { handed } = await mount(null)
    fireEvent.click(screen.getByRole('button', { name: 'Circle' }))
    await settle()
    expect(screen.getByText('drawn by the capability')).toBeTruthy()
    expect(handed.length).toBeGreaterThan(0)
    expect('openBook' in handed.at(-1)!).toBe(false)
    expect(handed.at(-1)!.openBook).toBeUndefined()
  })

  it('gets an `openBook` with a filesystem, which opens a shelf book by id and ignores an id the shelf does not hold', async () => {
    const { handed } = await mount(fakeFs() as unknown as IndexFs, { books: [GONE] })
    fireEvent.click(screen.getByRole('button', { name: 'Circle' }))
    await settle()
    const openBook = handed.at(-1)!.openBook
    expect(typeof openBook).toBe('function')
    /* An id nobody shelved opens nothing and says nothing. */
    openBook!('book:nope')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Library' }))
    await settle()
    expect(screen.queryByText(COULD_NOT_OPEN)).toBeNull()
    /* A shelved id goes through the same door a cover click does — here to
       a book whose folder is gone, which the shelf reports. */
    fireEvent.click(screen.getByRole('button', { name: 'Circle' }))
    await settle()
    handed.at(-1)!.openBook!(GONE.bookId)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Library' }))
    expect((await screen.findByRole('status')).textContent).toContain(COULD_NOT_OPEN)
  })
})

describe('restoring from the trash while the list is catching up', () => {
  it('keeps a restored row disabled until the NEWEST scan has answered — a superseded scan is not done', async () => {
    /* Two restores, one behind the other: the first's scan is overtaken by
       the second's. The overtaken scan used to resolve `done` having set
       nothing, so the first row was re-enabled over a list that still named
       its book — and, with the newer scan still pending, the same book could
       be restored a second time. */
    const { services } = await mount(fakeFs() as unknown as IndexFs)
    vi.spyOn(services.library, 'restore').mockResolvedValue({ state: 'restored' })
    await runCommand('Removed', 'Removed books…')
    expect(trash.scans).toHaveLength(1)
    await act(async () => trash.scans[0]!.resolve([row('book:a', 'Alpha'), row('book:b', 'Beta')]))
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Restore Alpha' }))
    await settle()
    expect(trash.scans).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Restore Beta' }))
    await settle()
    expect(trash.scans).toHaveLength(3)
    expect(services.library.restore).toHaveBeenCalledTimes(2)

    /* The overtaken scan answers — with the list as it was, both books still
       in it. It may set nothing, and it must not release its row either. */
    await act(async () => trash.scans[1]!.resolve([row('book:a', 'Alpha'), row('book:b', 'Beta')]))
    await settle()
    const alpha = screen.getByRole('button', { name: 'Restore Alpha' })
    expect(alpha.getAttribute('aria-busy')).toBe('true')
    expect((alpha as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Restore Beta' }).getAttribute('aria-busy')).toBe('true')

    /* The newest scan answers: the list is what the disk says, and only now are the rows released — there is nothing left to release. */
    await act(async () => trash.scans[2]!.resolve([]))
    await settle()
    expect(screen.queryByRole('button', { name: 'Restore Alpha' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore Beta' })).toBeNull()
    expect(screen.getByText(/Nothing removed/u)).toBeTruthy()

    /* And the sheet is dismissed from its own scrim, the way a reader taps out of it. */
    fireEvent.pointerDown(document.querySelector('[data-overlay-scrim]')!, { isPrimary: true, button: 0 })
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Removed books' })).toBeNull()
  })
})

describe('the keyboard, at the window', () => {
  it('reveals the Developer panel on ⌘⌃⌥D and hides it again on the same chord', async () => {
    /* Nothing on screen turns developer options on; the chord is the only way
       in, and it is a toggle. `PANES` names the panel `Developer`. */
    await mount(null)
    expect(screen.queryByRole('button', { name: 'Developer' })).toBeNull()
    developerChord()
    await settle()
    expect(screen.getByRole('button', { name: 'Developer' })).toBeTruthy()
    developerChord()
    await settle()
    expect(screen.queryByRole('button', { name: 'Developer' })).toBeNull()
  })

  /**
   * ⚠️ **THE ARROW KEYS PAGED THE BOOK UNDER THE SHEET** (2026-09-13 audit,
   * #207). Below §06's threshold the side pane stops being a track beside the
   * reader and becomes a SHEET over it. `Reader.onPageIntent` refuses a wheel
   * or a swipe there; this handler asked the screen and the layers and stopped,
   * so the same gesture was refused on the wheel and honoured on the keyboard,
   * turning a page the reader could not see.
   *
   * `fireEvent` answers false when the window took the key — which is what
   * `preventDefault` beside the page turn means.
   */
  it('leaves the page keys alone while the side pane is a sheet over the book', async () => {
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [moby] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    /* THE PREMISE, ASSERTED — and by the one control that says both halves of
       it. The scrim is drawn only when a pane is OPEN and this window is narrow
       enough to make it a SHEET; a wider one would leave the test about
       nothing. The pane is open from the boot state, so the control case is the
       closed one. */
    expect(
      screen.queryByRole('button', { name: 'Close the side pane' }),
      'the pane is not a sheet over the book, so there is nothing to test',
    ).toBeTruthy()

    accel('\\')
    await settle()
    expect(screen.queryByRole('button', { name: 'Close the side pane' }), 'the pane never closed').toBeNull()
    expect(fireEvent.keyDown(window, { key: 'ArrowRight' }), 'the reader did not take the page key').toBe(false)

    accel('\\')
    await settle()
    expect(screen.queryByRole('button', { name: 'Close the side pane' }), 'the pane never reopened').toBeTruthy()
    expect(
      fireEvent.keyDown(window, { key: 'ArrowRight' }),
      'an arrow key turned a page under the sheet, where the wheel is refused',
    ).toBe(true)
  })

  it('opens the palette on the accelerator + K, and Escape dismisses the top layer', async () => {
    await mount(null)
    expect(screen.queryByRole('textbox', { name: 'Search or ask' })).toBeNull()
    accel('k')
    await settle()
    expect(screen.getByRole('textbox', { name: 'Search or ask' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('textbox', { name: 'Search or ask' })).toBeNull()
  })

  /**
   * `resolveAccel` binds a letter under whatever modifiers it is handed and
   * leaves the accelerator to the window to check FIRST — so a plain K that
   * reached it would open the palette from a key the reader was typing, and a
   * plain \ would fold the pane away under them.
   */
  it('leaves a key pressed without the accelerator to the platform, even one the accelerator binds', async () => {
    await mount(null)
    expect(fireEvent.keyDown(window, { key: 'k' }), 'a plain K was taken as ⌘K').toBe(true)
    expect(fireEvent.keyDown(window, { key: '\\' }), 'a plain \\ was taken as ⌘\\').toBe(true)
    await settle()
    expect(screen.queryByRole('textbox', { name: 'Search or ask' }), 'a plain K opened the palette').toBeNull()
  })
})

describe('the palette’s own commands', () => {
  it('“Switch book…” opens the switcher over the shelf, and its row opens the book', async () => {
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [moby] })
    await runCommand('Switch', 'Switch book…')
    const switcher = screen.getByRole('dialog', { name: 'Switch book' })
    expect(within(switcher).getByRole('textbox', { name: 'Find a book' })).toBeTruthy()
    fireEvent.click(within(switcher).getByText('Moby-Dick').closest('button')!)
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Switch book' })).toBeNull()
    /* The reader, not the shelf: the bytes were read and handed to the parser, which refused them. */
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    expect(screen.queryByTitle('Open Moby-Dick')).toBeNull()
  })

  /**
   * ⚠️ **THE RULE HAD FOUR READERS AND SIX SURFACES.**
   *
   * `UNFINISHED_PANE_IDS` says removing an id from it is "the only edit
   * required" to ship a panel, and `paneFits` says it has five callers. Two
   * surfaces in this window never asked either: the titlebar drew the deleted
   * companion's button for every reader (whose click `paneFor` sent to
   * Contents, and whose `aria-pressed` could therefore never be true), and the
   * palette promised to take an unmatched query to that panel over the same
   * redirect.
   *
   * ⚠️ **THE PALETTE'S HALF IS GONE RATHER THAN FIXED.** Its `onAsk` had one
   * producer, the companion's panel, and that went with the AI features — so
   * an unmatched query now says so and Enter is inert, on every screen and
   * whatever the chord. The titlebar's half is still a live filter.
   *
   * Written over the LIST rather than over those two controls, so it is a rule
   * and not a pair of pins: a third unfinished panel, or a seventh surface that
   * draws one, fails here. It asserts on the shared titles from `panes.ts`,
   * which is where every surface takes its label from, so a surface drawing an
   * unfinished panel under the right name cannot pass.
   */
  it('offers no unfinished panel anywhere in the window until the chord reveals them', async () => {
    /* ⚠️ **A REAL BOOK, BECAUSE THE TITLEBAR'S BUTTONS ARE BEHIND `isReader`.**
       Written first against `mount(null)` and the empty state, where this
       passed with the titlebar's filter REMOVED — the block that draws the
       Companion button never rendered, so the assertion was reading a window
       that could not have failed it. The whole point is the titlebar, so the
       test has to be in the reader. */
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [moby] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    await settle()
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()

    /* NON-VACUOUS: this proves nothing if the list is empty, and the list is
       the whole subject. */
    expect(UNFINISHED_PANE_IDS.length).toBeGreaterThan(0)
    for (const id of UNFINISHED_PANE_IDS) {
      expect(controlsLabelled(PANE_TITLES[id])).toEqual([])
    }
    /* The finished panel beside it IS drawn, in both the titlebar group and
       the rail — the proof that this window renders the surfaces under test,
       so the emptiness above is the filter's doing and not the harness's. */
    expect(controlsLabelled(PANE_TITLES.toc).length).toBeGreaterThan(1)

    accel('k')
    await settle()
    const input = screen.getByRole('textbox', { name: 'Search or ask' })
    fireEvent.change(input, { target: { value: 'what is a whale' } })
    await settle()
    /* The palette still says it found nothing, and offers nowhere to send it. */
    expect(screen.getByText(/No command matches/u)).toBeTruthy()
    expect(screen.queryByText(/take it to/u)).toBeNull()

    /* And Enter is inert rather than dismissing the palette for a pane change
       that then lands somewhere else. */
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()
    expect(screen.getByRole('textbox', { name: 'Search or ask' })).toBeTruthy()

    /* The same window, one chord later: every one of them is offered. That is
       what makes the assertion above about the GATE and not about the panels
       having been deleted. */
    fireEvent.keyDown(window, { key: 'Escape' })
    await settle()
    developerChord()
    await settle()
    for (const id of UNFINISHED_PANE_IDS) {
      expect(controlsLabelled(PANE_TITLES[id]).length).toBeGreaterThan(0)
    }
  })
})

describe('the shelf', () => {
  it('narrows to the search, says when nothing matches, and comes back whole when the search is cleared', async () => {
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [moby] })
    expect(screen.getByTitle('Open Moby-Dick')).toBeTruthy()
    const search = screen.getByRole('searchbox', { name: 'Search the library' })
    fireEvent.change(search, { target: { value: 'zzz' } })
    await settle()
    expect(screen.queryByTitle('Open Moby-Dick')).toBeNull()
    expect(screen.getByText(/Nothing matches/u)).toBeTruthy()
    fireEvent.change(search, { target: { value: 'moby' } })
    await settle()
    expect(screen.getByTitle('Open Moby-Dick')).toBeTruthy()
  })

  it('opens a cover into the reader, which says when the file will not parse; “Close the book” closes it, and the empty state leads back to the shelf', async () => {
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [moby] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    /* Straight to the reader — a click on a cover takes you to what you opened. */
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    expect(screen.queryByTitle('Open Moby-Dick')).toBeNull()
    /* The book is the shelf's own row, so the palette offers to close it. */
    await runCommand('Close', 'Close the book')
    expect(await screen.findByText('No book open')).toBeTruthy()
    expect(screen.queryByText(WILL_NOT_PARSE)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Open the library · 1 book/u }))
    await settle()
    expect(screen.getByTitle('Open Moby-Dick')).toBeTruthy()
  })

  it('keeps what boot found wrong on the status line until the reader dismisses it', async () => {
    await mount(null, { bootNotice: 'Your settings file could not be read and was set aside.' })
    expect(screen.getByRole('status').textContent).toContain('set aside')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await settle()
    expect(screen.queryByText(/set aside/u)).toBeNull()
  })

  /* ⚠️ **A REPEAT IS A NEW NOTICE, WITH THE WHOLE OF ITS TIME** (2026-09-13
     audit). React bails out of setting the same string and the expiry was
     keyed on the string, so the same failure reported again shortly before
     the first one's time ran out vanished almost as it appeared. */
  it('gives a notice repeated just before the first ran out the whole of its own time', async () => {
    await mount(fakeFs() as unknown as IndexFs, { books: [{ ...GONE, parsedAt: 1, metaSchema: META_SCHEMA }] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      /* Microtasks only — the failed read is promise work, and a faked
         `setTimeout` would park `settle`. */
      const flush = () =>
        act(async () => {
          for (let turn = 0; turn < 50; turn += 1) await Promise.resolve()
        })
      const tick = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms)
        })
      fireEvent.click(screen.getByTitle('Open Gone'))
      await flush()
      expect(screen.getByRole('status').textContent).toContain(COULD_NOT_OPEN)

      await tick(11_000)
      fireEvent.click(screen.getByTitle('Open Gone'))
      await flush()
      /* Two seconds past where the FIRST notice's time ran out. */
      await tick(2_000)
      expect(screen.getByRole('status').textContent).toContain(COULD_NOT_OPEN)

      await tick(10_000)
      expect(screen.queryByText(COULD_NOT_OPEN)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * ⚠️ **THE ORIGIN IS FOR A BOOK WITH NO STORED COPY, NOT ONE WHOSE COPY WOULD NOT
 * READ** (2026-09-14, #103, round 4). `openStored` fell back to the reader's
 * original file after ANY vault failure. For a copy that is there and will not
 * read, that hid the failure — its cause was never logged — and healed nothing:
 * the intake's `keepContent` declines when the content file exists, so every
 * later open went to the origin again, until the origin moved and the book
 * could not be opened at all, with nothing on record to say why.
 */
describe('a shelf book whose stored copy cannot be read', () => {
  const ORIGIN = '/Users/reader/Books/Moby-Dick.epub'
  const withOrigin = (moby: IndexedBook): IndexedBook => ({ ...moby, parsedAt: 1, metaSchema: META_SCHEMA, origin: ORIGIN })

  it('opens from its origin when the copy is missing', async () => {
    const { moby } = await shelfWithMoby()
    const fs = fakeFs({
      [`${folderOf(moby.bookId)}/book.json`]: JSON.stringify({ title: 'Moby-Dick', author: 'Herman Melville' }),
    }) as unknown as IndexFs
    await mount(fs, { books: [withOrigin(moby)] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    expect(held.origins).toEqual([ORIGIN])
  })

  it('says a copy that is there and will not read, instead of opening the origin in its place', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fs: shelf, moby } = await shelfWithMoby()
    const fs = {
      ...shelf,
      readFile: async (path: string) => {
        if (path.endsWith('/content.epub')) throw new Error('Input/output error (os error 5)')
        return shelf.readFile(path)
      },
    } as unknown as IndexFs
    await mount(fs, { books: [withOrigin(moby)] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    /* The vault's own failure is what everything below is about, so it is what
       this waits for. */
    await eventually(() => expect(screen.getByRole('status').textContent).toContain(COULD_NOT_READ))
    expect(held.origins, 'an unreadable stored copy was replaced by the origin, silently').toEqual([])
    /* NOT "Try adding it again": adding a book whose content file is there
       writes nothing, so that advice changes nothing for this copy. */
    expect(screen.getByRole('status').textContent).toContain(COULD_NOT_READ)
    expect(
      quiet.mock.calls.some(
        (call) =>
          call[0] === 'Paper: could not read the stored book' &&
          call[1] === moby.bookId &&
          (call.at(-1) as Error | undefined)?.message === 'Input/output error (os error 5)',
      ),
      'the vault’s own failure was never logged, under the book it was about',
    ).toBe(true)
    quiet.mockRestore()
  })
})

/**
 * WHICH OPEN IS THE LAST ONE ASKED FOR — the 2026-09-13 audit's App rows. Each
 * is a race between two things App coordinates, so each is put in order here
 * by holding one of them open, over the real window.
 */
describe('the last thing the reader asked for', () => {
  /* Moby-Dick already parsed, so the background pass leaves its bytes alone
     and every read of them is one the test made. */
  async function parsedMoby() {
    const { fs, moby } = await shelfWithMoby()
    return { fs, moby: { ...moby, parsedAt: 1, metaSchema: META_SCHEMA } }
  }
  /** Loose files dropped on the window, the way a drop without a directory arrives. */
  const dropFiles = (files: readonly File[]) =>
    fireEvent.drop(window, { dataTransfer: { files, items: [], types: ['Files'] } })

  it('takes a held combo’s repeats as it took the first press, instead of handing them on', async () => {
    /* A suppressed repeat came back as "unbound", so the first press was
       Paper's and every repeat after it went to whatever the webview does
       with the combo. `fireEvent` answers false when the window took the key. */
    await mount(null)
    expect(fireEvent.keyDown(window, { key: 'k', ctrlKey: true })).toBe(false)
    expect(fireEvent.keyDown(window, { key: 'k', ctrlKey: true, repeat: true })).toBe(false)
    await settle()
    /* And did nothing with it: one press, one palette. */
    expect(screen.getByRole('textbox', { name: 'Search or ask' })).toBeTruthy()
  })

  /* ⚠️ **FOR THE WHOLE OF THE HOLD, WHATEVER CHANGES UNDER IT** (2026-09-13
     audit, #86, round 3). Whether a repeat was taken was asked of the binding
     at the repeat, so a press that switched its own binding off — ⌘D clears
     the selection it marks — handed every later repeat to the platform. A
     selection cannot be made in jsdom, so this changes the binding from
     outside instead: ⌘\ is unbound on a capability's screen, and the screen is
     changed mid-hold. The question the handler asks is the same. */
  it('keeps a held combo’s repeats once its binding has gone, and leaves a press it did not take to the platform', async () => {
    await mount(null)
    expect(fireEvent.keyDown(window, { key: '\\', ctrlKey: true }), 'the first press was not taken').toBe(false)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Circle' }))
    await settle()
    expect(screen.getByText('drawn by the capability')).toBeTruthy()
    expect(
      fireEvent.keyDown(window, { key: '\\', ctrlKey: true, repeat: true }),
      'a repeat went to the platform once the binding it was taken under had gone',
    ).toBe(false)
    fireEvent.keyUp(window, { key: '\\', ctrlKey: true })

    /* A fresh press there is the platform's — there is no pane to toggle — and
       it stays the platform's when the screen under it gets one back. */
    expect(fireEvent.keyDown(window, { key: '\\', ctrlKey: true }), 'a press with nothing to do was taken').toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Library' }))
    await settle()
    expect(
      fireEvent.keyDown(window, { key: '\\', ctrlKey: true, repeat: true }),
      'a repeat of the platform’s press was taken',
    ).toBe(true)
  })

  it('does not reopen a book whose read was still in flight when “Close the book” ran', async () => {
    /* Closing did not advance the open generation, so a read started before
       the close landed after it and put a book back on screen. */
    const { fs, moby } = await parsedMoby()
    await mount(fs, { books: [moby] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    accel('l')
    await settle()

    held.reads.armed = true
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    await settle()
    expect(held.reads.waiting).toHaveLength(1)
    await runCommand('Close', 'Close the book')

    release(held.reads)
    await settle()
    await settle()
    /* Still the shelf: the superseded read opened nothing. */
    expect(screen.getByTitle('Open Moby-Dick')).toBeTruthy()
  })

  it('does not open an import’s book over one opened while it was copying', async () => {
    /* The import's token and the open's were two counters, so an import's
       closing `openBook` landed on top of the book chosen since. */
    const { fs, moby } = await parsedMoby()
    await mount(fs, { books: [moby] })
    held.copies.armed = true
    dropFiles([new File(['one'], 'one.epub'), new File(['two'], 'two.epub')])
    await settle()
    expect(held.copies.waiting).toHaveLength(1)

    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    accel('l')
    await settle()

    release(held.copies)
    /* The bookkeeping finishes whatever happens — both books are shelved. */
    expect(await screen.findByTitle('Open two')).toBeTruthy()
    await settle()
    /* And the reader was not moved off the shelf into the import's book. */
    expect(screen.getByTitle('Open Moby-Dick')).toBeTruthy()
  })

  it('hands each copy the run’s signal, which a newer intake aborts', async () => {
    /* `keepOwnCopy` stops between the hash and the write when told to; the
       route passed it nothing to be told with. */
    await mount(fakeFs() as unknown as IndexFs)
    held.copies.armed = true
    dropFiles([new File(['one'], 'one.epub'), new File(['two'], 'two.epub')])
    await settle()
    const [signal] = held.copies.signals
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)

    dropFiles([new File(['three'], 'three.epub')])
    await settle()
    expect(signal!.aborted).toBe(true)
  })

  /* ⚠️ **A RESERVATION, NOT A READ OF THE LAST RENDER** (2026-09-13 audit, #98,
     round 3). Round 1 asked `busy` again after the picker, which is state: two
     choices landing in one turn both read the render from before either had
     started, and the second superseded the first. A book on the shelf, so the
     empty state's own folder button is not drawn beside the palette's. */
  it('starts one walk for choices that land together, and opens no second picker over the first', async () => {
    const { fs, moby } = await parsedMoby()
    await mount(fs, { books: [moby] })
    await runCommand('Import a folder', 'Import a folder…')
    await runCommand('Import a folder', 'Import a folder…')

    /* Every picker that did open answers in ONE turn, with no render between. */
    await act(async () => {
      for (const [index, pick] of [...held.folders.picks].entries()) pick(`/folder-${index}`)
    })
    await settle()
    expect(held.folders.walks, 'two choices landing together started two walks').toHaveLength(1)
    expect(held.folders.walks[0]!.aborted, 'the admitted walk was superseded').toBe(false)
    expect(held.folders.picks, 'a second picker opened while the first was choosing').toHaveLength(1)
  })

  /* ⚠️ **AND A DROP THAT HAD ALREADY FINISHED WHEN THE FOLDER CAME BACK**
     (2026-09-14, #98, round 4). The reservation refused only an import still
     running at that moment, so one that started and ended while the reader was
     choosing left nothing to see, and the stale choice started a walk behind
     it. The dropped book opening in the reader is what says the drop is over. */
  it('refuses a folder chosen after a drop started and finished while the picker was open', async () => {
    const { fs, moby } = await parsedMoby()
    await mount(fs, { books: [moby] })
    await runCommand('Import a folder', 'Import a folder…')
    dropFiles([new File(['one'], 'one.epub'), new File(['two'], 'two.epub')])
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    await settle()

    await act(async () => held.folders.picks[0]!('/chosen'))
    await settle()
    expect(held.folders.walks, 'a folder chosen before the drop started a walk after it').toHaveLength(0)
    accel('l')
    await settle()
    expect(screen.getByText(/that folder was not imported/u)).toBeTruthy()
  })

  /* The other route, which supersedes by design, starting while the reader is
     choosing: what comes back is refused rather than aborting it. */
  it('refuses a folder chosen while a drop was copying, instead of aborting the drop', async () => {
    const { fs, moby } = await parsedMoby()
    await mount(fs, { books: [moby] })
    await runCommand('Import a folder', 'Import a folder…')
    held.copies.armed = true
    dropFiles([new File(['one'], 'one.epub'), new File(['two'], 'two.epub')])
    await settle()
    const [signal] = held.copies.signals
    expect(signal).toBeInstanceOf(AbortSignal)

    await act(async () => held.folders.picks[0]!('/chosen'))
    await settle()
    expect(held.folders.walks, 'a walk started over the drop').toHaveLength(0)
    expect(signal!.aborted, 'the drop’s copying was aborted').toBe(false)
  })

  /* ⚠️ **THE WINDOW CLOSE AND ⌘Q WAIT ON ONE LIST** (2026-09-13 audit, #96).
     `App` stopped its import inside its own close handler, which ⌘Q never
     reaches; the stop is registered with `onBeforeDrain` now, and both
     teardowns ask `settleBeforeDrain`. What this holds: the registration is
     live while an import copies, it aborts the copy, and it does not let the
     drain go until the copy has let go. */
  it('registers the import’s stop with what the drain waits for, on every shutdown path', async () => {
    await mount(fakeFs() as unknown as IndexFs)
    held.copies.armed = true
    dropFiles([new File(['one'], 'one.epub'), new File(['two'], 'two.epub')])
    await settle()
    /* EXACTLY ONE, AND IT IS THIS DROP'S. For a round this asked of every
       signal, because the test above left a drop parked and its orphaned copy
       pushed a second, never-aborted signal in here — passing alone, failing in
       the file. `afterEach` stops what a test leaves running now, so a second
       signal is a leak again, and this says so (2026-09-14, round 4). */
    expect(held.copies.signals, 'a copy an earlier test left running is copying into this one').toHaveLength(1)
    const [signal] = held.copies.signals
    expect(signal!.aborted).toBe(false)

    let settled = false
    await act(async () => {
      void settleBeforeDrain().then(() => {
        settled = true
      })
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(signal!.aborted, 'the shutdown did not stop the copying').toBe(true)
    expect(settled, 'the drain was let go under an import still copying').toBe(false)

    release(held.copies)
    /* The drain is let go once the parked copy has seen its abort and the
       handover has settled — a digest and a write later, not two turns. */
    await eventually(() => expect(settled).toBe(true))
  })

  it('shows the reader for a jump within the open book made from the shelf', async () => {
    /* A jump into another book reaches `openBook`, which switches screens;
       one within the open book called `goTo` and nothing else, so a mark
       clicked in the shelf's Marginalia moved a book nobody could see. */
    const bookId = await bookIdFor(new File([BYTES], 'content.epub'))
    const mark = {
      id: 'm1', bookId, cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)', sectionIndex: 0, text: 'call me ishmael',
      prefix: '', suffix: '', note: '', kind: 'highlight', tint: 'yellow', style: 'fill', chapter: 'Loomings', createdAt: 1,
    }
    const fs = fakeFs({
      [`${folderOf(bookId)}/book.json`]: JSON.stringify({ title: 'Moby-Dick', author: 'Herman Melville' }),
      [`${folderOf(bookId)}/content.epub`]: BYTES,
      [`${folderOf(bookId)}/marks.json`]: JSON.stringify([mark]),
    }) as unknown as IndexFs
    await mount(fs, { books: [{ bookId, title: 'Moby-Dick', author: 'Herman Melville', hasContent: true, parsedAt: 1, metaSchema: META_SCHEMA }] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    accel('l')
    await settle()
    accel('2')
    await settle()

    fireEvent.click(await screen.findByRole('button', { name: /call me ishmael/u }))
    await settle()
    expect(screen.queryByTitle('Open Moby-Dick'), 'still on the shelf').toBeNull()
  })
})

/**
 * THE TRASH SHEET'S OWN STATES — the list is `App`'s, not the sheet's: which
 * scan may answer, what an unreadable trash says, and what a restore that did
 * not come all the way back says beside it.
 */
describe('the trash, as the window reads it', () => {
  /** "Removed books…" — offered from the shelf, which is where a reader notices one missing. */
  const openTrash = () => runCommand('Removed', 'Removed books…')
  const restoring = (title: string) => screen.getByRole('button', { name: `Restore ${title}` })

  it('answers empty without a scan where there is no filesystem to walk', async () => {
    await mount(null)
    await openTrash()
    expect(trash.scans, 'a scan was started with no filesystem').toHaveLength(0)
    expect(screen.getByText(/Nothing removed/u)).toBeTruthy()
  })

  it('says it is reading until the scan answers, then lists the newest first with an unknown stamp last', async () => {
    await mount(fakeFs() as unknown as IndexFs)
    await openTrash()
    expect(screen.getByText('Reading the trash…')).toBeTruthy()
    expect(screen.queryByText(/Nothing removed/u), 'an empty trash was reported before the scan answered').toBeNull()

    await act(async () =>
      trash.scans[0]!.resolve([
        /* ARRIVING ALMOST IN ORDER, which is what tells a sort from a shuffle:
           a comparator that only ever answers one way leaves an unsorted list
           looking sorted, and reverses one that already was. */
        { ...row('book:b', 'Beta'), removedAt: 3_000 },
        { ...row('book:d', 'Delta'), removedAt: 2_000 },
        /* No readable stamp: not old, UNKNOWN — so it sorts last rather than as 1970. */
        { ...row('book:c', 'Gamma'), removedAt: null },
        { ...row('book:a', 'Alpha'), removedAt: 1_000 },
      ]),
    )
    await settle()
    expect(
      screen.getAllByRole('button', { name: /^Restore / }).map((one) => one.getAttribute('aria-label')),
    ).toEqual(['Restore Beta', 'Restore Delta', 'Restore Alpha', 'Restore Gamma'])
  })

  it('says WHY the trash could not be read, rather than reporting it as empty', async () => {
    await mount(fakeFs() as unknown as IndexFs)
    await openTrash()
    await act(async () => trash.scans[0]!.reject(new Error('the trash directory would not open')))
    await settle()
    /* One box, two sentences and a break between them, so the match is on the
       box: what it could not do, and the disk's own words for why. */
    const said = screen.getByText(/The trash could not be read\./u).textContent
    expect(said).toContain('The trash could not be read.')
    expect(said).toContain('the trash directory would not open')
    expect(screen.queryByText(/Nothing removed/u), 'an unreadable trash was reported as an empty one').toBeNull()
  })

  it('lets a scan that was overtaken fail in silence — the newest scan owns the list', async () => {
    /* A superseded read must not answer either way: its failure is about a
       list two restores ago, and drawing it would replace rows the newer scan
       has already answered for. */
    const { services } = await mount(fakeFs() as unknown as IndexFs)
    vi.spyOn(services.library, 'restore').mockResolvedValue({ state: 'restored' })
    await openTrash()
    await act(async () => trash.scans[0]!.resolve([row('book:a', 'Alpha'), row('book:b', 'Beta')]))
    await settle()

    fireEvent.click(restoring('Alpha'))
    await settle()
    fireEvent.click(restoring('Beta'))
    await settle()
    expect(trash.scans).toHaveLength(3)

    await act(async () => trash.scans[1]!.reject(new Error('overtaken')))
    await settle()
    expect(screen.queryByText(/The trash could not be read\./u), 'an overtaken scan reported its failure').toBeNull()
    expect(restoring('Alpha')).toBeTruthy()
  })

  it('says what a restore did not do — some of it left here, a book already gone, or the fault itself', async () => {
    const { services } = await mount(fakeFs() as unknown as IndexFs)
    const restore = vi.spyOn(services.library, 'restore').mockResolvedValue({ state: 'partial', held: ['content.epub'] })
    await openTrash()
    await act(async () => trash.scans[0]!.resolve([row('book:a', 'Alpha')]))
    await settle()

    fireEvent.click(restoring('Alpha'))
    await settle()
    await act(async () => trash.scans[1]!.resolve([row('book:a', 'Alpha')]))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Some of that book could not be moved back. It is still here.')

    restore.mockResolvedValue({ state: 'absent' })
    fireEvent.click(restoring('Alpha'))
    await settle()
    await act(async () => trash.scans[2]!.resolve([row('book:a', 'Alpha')]))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('That book is no longer in the trash.')

    restore.mockRejectedValue(new Error('the folder would not move'))
    fireEvent.click(restoring('Alpha'))
    await settle()
    await act(async () => trash.scans[3]!.resolve([row('book:a', 'Alpha')]))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('the folder would not move')

    /* And a restore that worked says nothing at all. */
    restore.mockResolvedValue({ state: 'restored' })
    fireEvent.click(restoring('Alpha'))
    await settle()
    await act(async () => trash.scans[4]!.resolve([]))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the window without a filesystem', () => {
  it('opens nothing from the shelf, and says nothing about it either', async () => {
    /* `openStored` returns at once with no filesystem. Read past that guard it
       reaches the vault with nothing to read from, which fails — and reports a
       book that could not be read to a reader who has no library on disk. */
    await mount(null, { books: [GONE] })
    fireEvent.click(screen.getByTitle('Open Gone'))
    await settle()
    await settle()
    expect(screen.queryByText(COULD_NOT_READ), 'a book Paper never had was reported unreadable').toBeNull()
    expect(screen.queryByText(COULD_NOT_OPEN)).toBeNull()
    expect(screen.getByTitle('Open Gone'), 'the shelf was left for a book that cannot open').toBeTruthy()
  })
})

describe('the book switcher', () => {
  it('closes when a row is chosen, and when the reader taps out of it', async () => {
    /* The switcher is dismissed by its OWN dispatch: with no filesystem the
       chosen book opens nothing, so nothing else takes the layer down. */
    await mount(null, { books: [GONE] })
    await runCommand('Switch', 'Switch book…')
    const switcher = screen.getByRole('dialog', { name: 'Switch book' })
    fireEvent.click(within(switcher).getByText('Gone').closest('button')!)
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Switch book' }), 'the switcher stayed up over the book it opened').toBeNull()

    await runCommand('Switch', 'Switch book…')
    expect(screen.getByRole('dialog', { name: 'Switch book' })).toBeTruthy()
    fireEvent.pointerDown(document.querySelector('[data-overlay-scrim]')!, { isPrimary: true, button: 0 })
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Switch book' }), 'the switcher survived its own scrim').toBeNull()
  })
})

describe('the window’s own chrome', () => {
  it('heads a contributed screen with the label its capability gave it', async () => {
    await mount(null)
    fireEvent.click(screen.getByRole('button', { name: 'Circle' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'Circle', level: 1 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Not here' }), 'a composed screen was drawn as one that is not there').toBeNull()
  })

  it('closes the side pane from the sheet’s own scrim', async () => {
    /* The scrim is drawn only where the pane is a SHEET over the screen, which
       is what this window is; the button is the only way out of it. */
    await mount(null)
    fireEvent.click(screen.getByRole('button', { name: 'Close the side pane' }))
    await settle()
    expect(screen.queryByRole('button', { name: 'Close the side pane' }), 'the pane never closed').toBeNull()
  })

  it('publishes the platform’s metrics onto the document', async () => {
    /* Every surface reads these as custom properties; nothing else writes
       them, so a window that never applied them draws on defaults nobody chose. */
    document.documentElement.removeAttribute('style')
    await mount(null)
    expect(document.documentElement.style.getPropertyValue('--pane-track')).toBe(`${PANE_TRACK}px`)
  })

  it('records a capability command that takes a name the kernel already owns', async () => {
    /* ⚠️ **THE PALETTE KEEPS THE KERNEL'S ROW AND DROPS THE CAPABILITY'S — right
       for the reader, and silent for whoever wrote the composition.** So the
       fact goes where a release build can be asked for it, and a warning with no
       name in it would say only that SOMETHING collided. */
    const log = createDiagnosticLog()
    /* A capability's commands must carry its own id as their prefix, so the
       collision is a capability whose id IS a kernel prefix. */
    await mount(null, {
      diagnosticLog: log,
      capability: {
        id: 'reading',
        commands: () => [{ id: 'reading:progress', label: 'Mine', group: 'Reading', run: () => {} }],
      },
    })
    /* Rebuilt again, as every page turn rebuilds it: the list depends on app
       state, and a fact recorded per rebuild floods the ring. */
    developerChord()
    await settle()
    expect(log.entries().filter((one) => one.event === 'duplicate.id'), 'once, however often').toEqual([
      expect.objectContaining({
        level: 'warn',
        scope: 'commands',
        event: 'duplicate.id',
        fields: { id: 'reading:progress' },
      }),
    ])
  })

  it('keeps the kernel’s row, and runs, where there is no log to tell', async () => {
    /* The log is optional — a window built without one must still drop the
       duplicate rather than throw on the way to recording it. */
    await mount(null, {
      capability: {
        id: 'reading',
        commands: () => [{ id: 'reading:progress', label: 'Mine', group: 'Reading', run: () => {} }],
      },
    })
    expect(document.body.textContent).not.toBe('')
  })

  it('hands the Developer panel this run’s diagnostics, and tells the spool when they are cleared', async () => {
    /* The log is the composition root's, not this window's — and clearing the
       window without the file leaves a harness reading entries the app no
       longer has. */
    const log = createDiagnosticLog()
    log.record({ at: 1_000, level: 'info', scope: 'circle', event: 'a peer answered', fields: {} })
    const cleared = vi.fn()
    await mount(null, { diagnosticLog: log, onDiagnosticsCleared: cleared })
    developerChord()
    await settle()
    fireEvent.click(controlsLabelled('Developer')[0]!)
    await settle()
    expect(screen.getByText('a peer answered')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await settle()
    expect(cleared, 'the window was cleared and the file it projects was not told').toHaveBeenCalledTimes(1)
    expect(screen.getByText('This run has reported nothing yet.')).toBeTruthy()
  })
})

describe('the theme, and the system’s own', () => {
  /** A `matchMedia` this test drives: jsdom has none, so the window reports no preference at all. */
  function systemDark(dark: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    let matches = dark
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('dark') ? matches : false,
        media: query,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      }),
    })
    return {
      set: async (next: boolean) => {
        matches = next
        await act(async () => {
          for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent)
        })
      },
      stop: () => {
        delete (window as { matchMedia?: unknown }).matchMedia
      },
    }
  }
  const themeNow = () => document.querySelector('[data-theme]')?.getAttribute('data-theme')

  it('follows the system while the reader has not chosen, and stops the moment they do', async () => {
    const system = systemDark(true)
    try {
      await mount(null)
      expect(themeNow(), 'the window opened light under a dark system').toBe('night')
      await system.set(false)
      expect(themeNow()).toBe('paper')
      await system.set(true)
      expect(themeNow(), 'the window followed the system once and then stopped').toBe('night')

      /* The reader takes it over, and the system stops deciding. */
      await runCommand('Follow the system', 'Stop following the system appearance')
      await system.set(false)
      expect(themeNow(), 'the system overrode a theme the reader had chosen').toBe('night')
    } finally {
      system.stop()
    }
  })
})

/**
 * WHAT A DROP SAYS IT DID — the notices, which are the whole of what makes a
 * drop distinguishable from a window that did nothing.
 */
describe('a drop, and what the window says about it', () => {
  /** Loose files, the way a drop with no directory in it arrives. */
  const dropFiles = (files: readonly File[]) =>
    fireEvent.drop(window, { dataTransfer: { files, items: [], types: ['Files'] } })
  /** One dropped entry: a book the walker can read, or one it cannot. */
  const entry = (name: string, bytes: string | null) => ({
    isDirectory: false,
    isFile: true,
    name,
    file: (ok: (file: File) => void, fail: (cause: unknown) => void) =>
      bytes === null ? fail(new Error('the entry would not open')) : ok(new File([bytes], name)),
  })
  /** A drop that carries the directory API, which is what counts the unreadable ones. */
  const dropEntries = (entries: readonly unknown[]) =>
    fireEvent.drop(window, {
      dataTransfer: {
        files: [],
        items: entries.map((one) => ({ kind: 'file', webkitGetAsEntry: () => one })),
        types: ['Files'],
      },
    })
  const noticed = () => screen.getByRole('status').textContent

  it('tells a drop with no book in it apart from one whose books would not open', async () => {
    await mount(null)
    dropFiles([new File(['notes'], 'notes.txt')])
    await settle()
    expect(noticed()).toContain('Nothing Paper can open was in that drop.')

    dropEntries([entry('one.epub', null)])
    await settle()
    expect(noticed()).toContain('Nothing in that drop could be read — 1 item failed.')

    dropEntries([entry('one.epub', null), entry('two.epub', null)])
    await settle()
    expect(noticed()).toContain('Nothing in that drop could be read — 2 items failed.')
  })

  it('carries what a drop lost into the notice for the one book that opened', async () => {
    /* A single book has no summary to fold the count into, so the count stands
       alone — dropped, a partly unreadable drop was reported only where a
       filesystem happened to be there to summarise it. */
    const fs = fakeFs() as unknown as IndexFs
    await mount(fs)
    dropEntries([entry('good.epub', BYTES), entry('bad.epub', null)])
    expect(await screen.findByText(WILL_NOT_PARSE), 'the readable book never opened').toBeTruthy()
    expect(noticed()).toContain('1 item could not be read.')
    expect(held.copies.signals, 'a single dropped book was put through the import').toHaveLength(0)
  })

  it('lets the reader put a notice away in the reader, where it is drawn', async () => {
    /* The notice is one slot shared with the import's own progress, and a
       reader who has read it should be able to have it back. */
    const fs = fakeFs() as unknown as IndexFs
    await mount(fs)
    dropFiles([new File(['notes'], 'notes.txt')])
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Open a book' }))
    await settle()
    expect(noticed()).toContain('Nothing Paper can open was in that drop.')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await settle()
    expect(screen.queryByText('Nothing Paper can open was in that drop.'), 'the notice would not go').toBeNull()
  })

  it('says nothing of its own about a drop that lost nothing, and leaves what is on screen', async () => {
    /* The note is the only thing this route has to say up front. With none,
       a standing notice is the reader's — clearing it here took away the only
       account of the drop before it. */
    const fs = fakeFs() as unknown as IndexFs
    await mount(fs)
    dropFiles([new File(['notes'], 'notes.txt')])
    await settle()
    expect(noticed()).toContain('Nothing Paper can open was in that drop.')

    dropFiles([new File([BYTES], 'good.epub')])
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    await settle()
    expect(noticed(), 'a drop with nothing to say wiped the notice before it').toContain(
      'Nothing Paper can open was in that drop.',
    )
  })

  it('announces a ceiling and a failure in one sentence, with a space between them', async () => {
    /* Both counts are announced rather than applied quietly: a reader who drops
       six thousand books and is shown five thousand has otherwise been told
       something untrue by omission. Dropped with no filesystem, there is no
       summary to fold them into, so the sentence is the whole notice. */
    const entries = [entry('bad.epub', null)]
    for (let index = 0; index <= MAX_FILES; index += 1) entries.push(entry(`book-${index}.epub`, 'one'))
    await mount(null)
    dropEntries(entries)
    await eventually(() =>
      expect(noticed()).toContain(
        `That drop held more than ${MAX_FILES} books — took the first ${MAX_FILES}. 1 item could not be read.`,
      ),
    )
  })

  it('folds what a batch lost into the summary, and says neither before the copying is done', async () => {
    const fs = fakeFs() as unknown as IndexFs
    await mount(fs)
    held.copies.armed = true
    dropEntries([entry('one.epub', 'one'), entry('two.epub', 'two'), entry('bad.epub', null)])
    await settle()
    expect(held.copies.signals, 'the batch never started copying').toHaveLength(1)
    expect(screen.queryByText(/could not be read/u), 'the count was said over the progress bar').toBeNull()

    release(held.copies)
    /* The summary lands when BOTH copies have been hashed and written and the
       shelf's write chain has settled — see `eventually`. */
    await eventually(() => expect(noticed()).toContain('2 added 1 item could not be read.'))
  })

  it('reports a book the disk refused beside the ones that landed, and names it on the console', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = await bookIdFor(new File(['bad'], 'bad.epub'))
    const shelf = fakeFs()
    const fs = {
      ...shelf,
      writeFile: async (path: string, bytes: Uint8Array) => {
        if (path.includes(folderOf(refused))) throw new Error('the disk is full')
        return shelf.writeFile(path, bytes)
      },
    } as unknown as IndexFs
    await mount(fs)
    dropFiles([new File(['good'], 'good.epub'), new File(['bad'], 'bad.epub')])
    await eventually(() => expect(noticed()).toContain('1 added, 1 could not be read'))
    expect(
      quiet.mock.calls.filter((call) => call[0] === 'Paper: could not add' && call[1] === 'bad.epub'),
      'the book the disk refused was not named on the console',
    ).toHaveLength(1)
    quiet.mockRestore()
  })

  it('says the whole batch could not be added when the shelf itself refuses', async () => {
    /* `run` folds a settle that rejects into the same failure the work's would
       be — the shelf write chain is part of the lifecycle, not part of the work. */
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(fakeFs() as unknown as IndexFs, {
      before: (services) => {
        vi.spyOn(services.library, 'addMany').mockRejectedValue(new Error('the shelf would not write'))
      },
    })
    dropFiles([new File(['one'], 'one.epub'), new File(['two'], 'two.epub')])
    await eventually(() => expect(noticed()).toContain('Those books could not be added.'))
    expect(quiet.mock.calls.some((call) => call[0] === 'Paper: the import failed')).toBe(true)
    quiet.mockRestore()
  })

  it('names the import a second drop replaced, and keeps what the replaced one had copied', async () => {
    const fs = fakeFs() as unknown as IndexFs
    await mount(fs)
    /* The first book copies; the second is held, so the drop that supersedes
       this run lands between the two. */
    held.copies.names.add('two.epub')
    dropFiles([new File(['one'], 'one.epub'), new File(['two'], 'two.epub'), new File(['three'], 'three.epub')])
    /* The second copy starts only once the first has been hashed and written. */
    await eventually(() => expect(held.copies.signals).toHaveLength(2))

    /* ONE book, so no second bar goes up over what this drop has to say. */
    dropFiles([new File(['four'], 'four.epub')])
    await eventually(() => expect(screen.getByText(WILL_NOT_PARSE)).toBeTruthy())
    release(held.copies)
    accel('l')
    /* What the replaced run had copied reaches the shelf once its handover has
       flushed and settled — which is also when its loop is over for good. */
    await eventually(() => expect(screen.getByTitle('Open one')).toBeTruthy())

    expect(noticed(), 'the import that was replaced was replaced in silence').toContain(
      'That replaced the import already running.',
    )
    /* The superseded run stopped between books rather than copying the rest. */
    expect(held.copies.signals, 'a superseded run went on copying').toHaveLength(2)
    expect(screen.queryByTitle('Open three'), 'a superseded run shelved a book it never copied').toBeNull()
  })

  it('counts the books as it copies them', async () => {
    await mount(fakeFs() as unknown as IndexFs)
    held.copies.armed = true
    dropFiles([new File(['one'], 'one.epub'), new File(['two'], 'two.epub')])
    await settle()
    expect(screen.getByRole('status').textContent).toContain('Importing 0 of 2')
  })

  it('counts what could not be read in the plural, beside the one book that opened', async () => {
    await mount(fakeFs() as unknown as IndexFs)
    dropEntries([entry('good.epub', BYTES), entry('bad.epub', null), entry('worse.epub', null)])
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    await eventually(() => expect(noticed()).toContain('2 items could not be read.'))
  })

  it('says nothing over the reader while a batch is copying, even with something lost to report', async () => {
    /* THE READER DRAWS THE NOTICE, and draws no progress bar — so a note set
       up front is on screen there for the whole of the copy, and then replaced
       by the summary that already carries it. The shelf's bar hides that; the
       reader does not. */
    await mount(fakeFs() as unknown as IndexFs)
    fireEvent.click(screen.getByRole('button', { name: 'Open a book' }))
    await settle()
    held.copies.armed = true
    dropEntries([entry('one.epub', 'one'), entry('two.epub', 'two'), entry('bad.epub', null)])
    await eventually(() => expect(held.copies.signals).toHaveLength(1))
    expect(screen.queryByText(/could not be read/u), 'the count was said over the reader while the batch copied').toBeNull()

    release(held.copies)
    await eventually(() => expect(noticed()).toContain('2 added 1 item could not be read.'))
  })
})

/** The one status line the window has, wherever it is drawn. */
const noticeText = () => screen.getByRole('status').textContent

describe('the book picker', () => {
  /** Run "Add books…" and answer the picker with `settle`d effect. */
  const picked = async (answer: unknown) => {
    await runCommand('Add books', 'Add books…')
    expect(held.pickers, 'no picker was opened').toHaveLength(1)
    await act(async () => held.pickers[0]!.resolve(answer))
    await settle()
  }

  it('opens what was picked', async () => {
    await mount(fakeFs() as unknown as IndexFs)
    await picked([{ file: new File([BYTES], 'moby.epub'), path: '/Users/reader/moby.epub' }])
    expect(await screen.findByText(WILL_NOT_PARSE), 'the picked book never reached the reader').toBeTruthy()
  })

  it('says nothing at all when the reader closes the picker', async () => {
    /* A cancelled picker resolves empty. Nothing was asked for, so nothing is
       reported — and the reader is left where they were. */
    await mount(fakeFs() as unknown as IndexFs)
    await picked([])
    expect(screen.queryByText('Those books could not be added.')).toBeNull()
    expect(screen.queryByRole('status'), 'a cancelled picker was reported as a failure').toBeNull()
    expect(screen.queryByText(WILL_NOT_PARSE), 'something was opened by a picker that gave nothing back').toBeNull()
  })

  it('says the picker failed rather than letting a broken dialog look like a change of mind', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(fakeFs() as unknown as IndexFs)
    await runCommand('Add books', 'Add books…')
    await act(async () => held.pickers[0]!.reject(new Error('the dialog would not open')))
    await settle()
    expect(noticeText()).toContain('The file picker failed — nothing was added.')
    expect(quiet.mock.calls.some((call) => call[0] === 'Paper: the book picker failed')).toBe(true)
    quiet.mockRestore()
  })

  it('says the ADD failed when what was picked could not be taken in — not that the picker did', async () => {
    /* ONE CATCH PER STAGE. A rejected add answered "The file picker failed",
       which sent the reader back to pick files that had already been chosen. */
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(fakeFs() as unknown as IndexFs)
    await picked([
      {
        path: '/Users/reader/moby.epub',
        get file(): File {
          throw new Error('the handle the picker gave back has gone')
        },
      },
    ])
    expect(noticeText()).toContain('Those books could not be added.')
    expect(quiet.mock.calls.some((call) => call[0] === 'Paper: could not add the picked books')).toBe(true)
    expect(
      quiet.mock.calls.some((call) => call[0] === 'Paper: the book picker failed'),
      'a failed add was reported as a failed picker',
    ).toBe(false)
    quiet.mockRestore()
  })
})

describe('books the launch carried', () => {
  /** The shell's own queue: a subscription, and a delivery the test makes. */
  function shell() {
    let deliver: ((paths: readonly string[]) => void) | null = null
    return {
      requests: {
        subscribe: (handler: (paths: readonly string[]) => void) => {
          deliver = handler
          return () => {
            deliver = null
          }
        },
      },
      hand: async (paths: readonly string[]) => {
        await act(async () => deliver?.(paths))
        await settle()
      },
    }
  }

  it('opens what a launch carried, and says when none of it could be read', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const launch = shell()
    await mount(fakeFs() as unknown as IndexFs, { openRequests: launch.requests })
    await launch.hand(['/books/moby.epub'])
    expect(await screen.findByText(WILL_NOT_PARSE), 'a double-clicked book never opened').toBeTruthy()

    held.refuseOrigins.add('/books/gone.epub')
    await launch.hand(['/books/gone.epub'])
    await settle()
    expect(noticeText()).toContain('Nothing that was opened could be read — 1 file failed.')
    quiet.mockRestore()
  })

  it('says on the console when a launch cannot be taken in, and leaves the window standing', async () => {
    /* The payload crosses a process boundary; a delivery that is not a list of
       paths is a rejection nobody else would hear. */
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const launch = shell()
    await mount(fakeFs() as unknown as IndexFs, { openRequests: launch.requests })
    await launch.hand(undefined as unknown as readonly string[])
    expect(quiet.mock.calls.some((call) => call[0] === 'Paper: could not open what the launch carried')).toBe(true)
    expect(screen.getByRole('button', { name: 'Add books' }), 'the window came down with it').toBeTruthy()
    quiet.mockRestore()
  })
})

describe('importing a folder', () => {
  const chooseFolder = () => runCommand('Import a folder', 'Import a folder…')

  it('says the folder picker failed, and lets the reader try again', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(fakeFs() as unknown as IndexFs)
    await chooseFolder()
    await act(async () => held.folders.refusePick[0]!(new Error('the dialog would not open')))
    await settle()
    expect(noticeText()).toContain('The folder picker failed — nothing was imported.')
    expect(quiet.mock.calls.some((call) => call[0] === 'Paper: the folder picker failed')).toBe(true)
    expect(held.folders.walks, 'a walk started over a picker that never answered').toHaveLength(0)

    /* The reservation went back: the next attempt gets a picker of its own. */
    await chooseFolder()
    expect(held.folders.picks, 'the route refused every later import').toHaveLength(2)
    quiet.mockRestore()
  })

  it('gives the reservation back when the reader cancels, and starts no walk', async () => {
    await mount(fakeFs() as unknown as IndexFs)
    await chooseFolder()
    await act(async () => held.folders.picks[0]!(null))
    await settle()
    expect(held.folders.walks, 'a cancelled picker started a walk').toHaveLength(0)
    expect(screen.queryByText(/could not be imported/u)).toBeNull()

    await chooseFolder()
    expect(held.folders.picks, 'a cancelled choice held the reservation for the rest of the session').toHaveLength(2)
  })

  it('shelves what the walk copied as it copies, and says what the walk did', async () => {
    const fs = fakeFs() as unknown as IndexFs
    await mount(fs)
    await chooseFolder()
    await act(async () => held.folders.picks[0]!('/Users/reader/Books'))
    await settle()
    expect(held.folders.runs).toHaveLength(1)

    const bookId = await bookIdFor(new File([BYTES], 'content.epub'))
    const ruined = await bookIdFor(new File(['ruined'], 'content.epub'))
    const copied: ImportOutcome[] = [
      { path: '/Users/reader/Books/moby.dick.epub', status: 'added', bookId, name: 'moby.dick.epub' },
      /* ⚠️ **A FAILED OUTCOME IS NOT A BOOK, however much it knows about one.**
         The walk reports what it could not copy beside what it could, and a row
         for bytes that never landed is a book the shelf cannot open. */
      { path: '/Users/reader/Books/ruined.epub', status: 'failed', bookId: ruined, name: 'ruined.epub' },
    ]
    await act(async () => {
      held.folders.runs[0]!.onProgress({ done: 1, total: 2 })
      held.folders.runs[0]!.onCopied(copied)
    })
    expect(screen.getByRole('status').textContent).toContain('Importing 1 of 2')

    await act(async () => held.folders.runs[0]!.done(copied))
    await eventually(() => expect(noticeText()).toContain('1 added, 1 could not be read'))
    /* THE FILENAME AS A TITLE, its last suffix taken off and nothing else. */
    expect(screen.getByTitle('Open moby.dick')).toBeTruthy()
    expect(screen.queryByTitle('Open ruined'), 'a book that failed to copy was put on the shelf').toBeNull()
    const record = JSON.parse(
      new TextDecoder().decode((fs as unknown as { store: Map<string, Uint8Array> }).store.get(`${folderOf(bookId)}/book.json`)!),
    ) as Record<string, unknown>
    expect(record.title).toBe('moby.dick')
    /* EMPTY, not a guess: an import knows no author, and an invented one would
       be the book's own account of itself. */
    expect(record.author).toBe('')
    /* WHERE IT CAME FROM, so the book can be reopened when the copy is gone. */
    expect(record.origin).toBe('/Users/reader/Books/moby.dick.epub')
    expect(record.ext).toBe('epub')
  })

  it('lets a placeholder stand aside for a book the shelf already knows', async () => {
    /* SPARSE: everything an import supplies but the extension is a guess from a
       filename, and folding a guess into a parse overwrote the real title and
       author of every book in a re-imported folder. */
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [{ ...moby, parsedAt: 1, metaSchema: META_SCHEMA }] })
    await chooseFolder()
    await act(async () => held.folders.picks[0]!('/Users/reader/Books'))
    await settle()
    const copied: ImportOutcome[] = [
      { path: '/Users/reader/Books/moby-dick-1851.epub', status: 'duplicate', bookId: moby.bookId, name: 'moby-dick-1851.epub' },
    ]
    await act(async () => held.folders.runs[0]!.onCopied(copied))
    await act(async () => held.folders.runs[0]!.done(copied))
    /* Settled when the walk's own summary is said — the placeholder has been
       offered to the shelf by then, and refused or not. */
    await eventually(() => expect(noticeText()).toContain('0 added, 1 already here'))
    expect(screen.getByTitle('Open Moby-Dick'), 'a filename was written over a parsed title').toBeTruthy()
    expect(screen.queryByTitle('Open moby-dick-1851')).toBeNull()
  })

  it('says a folder that would not be walked could not be imported', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(fakeFs() as unknown as IndexFs)
    await chooseFolder()
    await act(async () => held.folders.picks[0]!('/Users/reader/Books'))
    await settle()
    await act(async () => held.folders.runs[0]!.fail(new Error('the folder would not read')))
    await settle()
    await settle()
    expect(noticeText()).toContain('That folder could not be imported.')
    expect(quiet.mock.calls.some((call) => call[0] === 'Paper: the folder import failed')).toBe(true)
    quiet.mockRestore()
  })
})

describe('a shelf book with somewhere else to look', () => {
  const parsed = (moby: IndexedBook, origin: string): IndexedBook => ({
    ...moby,
    parsedAt: 1,
    metaSchema: META_SCHEMA,
    origin,
  })
  /** A shelf whose row is there and whose stored copy never was. */
  async function shelfWithNoCopy(origin: string) {
    const { moby } = await shelfWithMoby()
    const fs = fakeFs({
      [`${folderOf(moby.bookId)}/book.json`]: JSON.stringify({ title: 'Moby-Dick', author: 'Herman Melville' }),
    }) as unknown as IndexFs
    await mount(fs, { books: [parsed(moby, origin)] })
  }

  it('opens an address as an address, and never looks for a file of that name', async () => {
    await shelfWithNoCopy('https://example.org/moby.epub')
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    await eventually(() => expect(screen.queryByTitle('Open Moby-Dick'), 'the address was never opened').toBeNull())
    expect(held.origins, 'an address was looked for on the reader’s own disk').toEqual([])
  })

  it('reads a plain http address the same way, scheme and all', async () => {
    await shelfWithNoCopy('http://example.org/moby.epub')
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    await eventually(() => expect(screen.queryByTitle('Open Moby-Dick'), 'the address was never opened').toBeNull())
    expect(held.origins, 'an http address was looked for on disk').toEqual([])
  })

  it('does not take a path for an address because one is spelled inside it', async () => {
    /* The anchor is the whole of it: a file whose name carries a scheme is
       still a file, and reading it as an address would report the one book
       most likely to still be there as unopenable. */
    const odd = ' https://example.org/moby.epub'
    await shelfWithNoCopy(odd)
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    await eventually(() => expect(screen.queryByTitle('Open Moby-Dick')).toBeNull())
    expect(held.origins, 'a path with an address in its name was never read as a file').toEqual([odd])
  })

  it('opens the reader’s own file, and falls back to the address only when the file is gone', async () => {
    const path = '/Users/reader/Books/Moby-Dick.epub'
    const gone = '/Users/reader/Books/Bartleby.epub'
    const { moby } = await shelfWithMoby()
    const bartleby = await bookIdFor(new File(['bartleby'], 'content.epub'))
    const fs = fakeFs({
      [`${folderOf(moby.bookId)}/book.json`]: JSON.stringify({ title: 'Moby-Dick', author: 'Herman Melville' }),
      [`${folderOf(bartleby)}/book.json`]: JSON.stringify({ title: 'Bartleby', author: 'Herman Melville' }),
    }) as unknown as IndexFs
    held.refuseOrigins.add(gone)
    await mount(fs, {
      books: [
        parsed(moby, path),
        parsed({ bookId: bartleby, title: 'Bartleby', author: 'Herman Melville', hasContent: true }, gone),
      ],
    })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE), 'the reader’s own file never opened').toBeTruthy()
    expect(held.origins).toEqual([path])

    /* A book whose file is gone from where it was: the path is tried and then
       opened as an address, which fails one step later in the reader — where an
       unopenable book belongs. */
    accel('l')
    await eventually(() => expect(screen.getByTitle('Open Bartleby')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Open Bartleby'))
    await eventually(() => expect(screen.queryByTitle('Open Bartleby'), 'nothing was opened once the file was gone').toBeNull())
    expect(held.origins).toEqual([path, gone])
  })

  it('says nothing about a read the reader has already moved on from', async () => {
    /* A superseded read must not report itself: the notice would be about a
       book the reader abandoned, over the one they chose. */
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, {
      books: [
        { ...GONE, parsedAt: 1, metaSchema: META_SCHEMA },
        { ...moby, parsedAt: 1, metaSchema: META_SCHEMA },
      ],
    })
    held.reads.armed = true
    fireEvent.click(screen.getByTitle('Open Gone'))
    await settle()
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    await settle()
    expect(held.reads.waiting).toHaveLength(2)

    release(held.reads)
    await settle()
    await settle()
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    expect(screen.queryByText(COULD_NOT_OPEN), 'a superseded read reported itself over the book chosen since').toBeNull()
  })
})

describe('the accelerators the window owns', () => {
  /** Moby-Dick open in the reader, off a shelf that holds it. */
  async function reading() {
    const { fs, moby } = await shelfWithMoby()
    const mounted = await mount(fs, { books: [{ ...moby, parsedAt: 1, metaSchema: META_SCHEMA }] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    await settle()
    return mounted
  }

  it('opens the tags of the book being read, and the sheet closes from its own scrim', async () => {
    await reading()
    await pressUntilTaken('t', 'the open book’s tags were never offered')
    await eventually(() => expect(screen.getByRole('dialog', { name: 'Tags for this book' })).toBeTruthy())
    fireEvent.pointerDown(document.querySelector('[data-overlay-scrim]')!, { isPrimary: true, button: 0 })
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Tags for this book' }), 'the tag sheet survived its own scrim').toBeNull()
  })

  it('offers the open book’s tags only for a book the shelf holds', async () => {
    /* `openRow` is the row for the OPEN book — a book opened from anywhere but
       the shelf has none, and there is nothing to write a tag into. */
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [{ ...moby, parsedAt: 1, metaSchema: META_SCHEMA }] })
    fireEvent.drop(window, {
      dataTransfer: { files: [new File(['a different book entirely'], 'other.epub')], items: [], types: ['Files'] },
    })
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    await settle()

    accel('k')
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search or ask' }), { target: { value: 'Tags' } })
    await settle()
    expect(screen.queryByText('Tags for this book…'), 'a book the shelf does not hold was offered its tags').toBeNull()
    /* And the key is as dead as the row — `hasBook` is the same question —
       which means NOT TAKEN: ⌘T is the platform's where there is nothing to tag. */
    fireEvent.keyDown(window, { key: 'Escape' })
    await settle()
    expect(accel('t'), 'a key with nothing to do was taken from the platform').toBe(true)
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Tags for this book' })).toBeNull()
  })

  it('steps the type up, down, and back to the size it started at', async () => {
    const { services } = await reading()
    const size = () => services.settings.get(KERNEL_SETTINGS.textSize)
    const started = size()
    accel('=')
    await settle()
    expect(size(), 'the type did not grow').toBeGreaterThan(started)

    accel('-')
    accel('-')
    await settle()
    expect(size(), 'the type did not shrink').toBeLessThan(started)

    accel('0')
    await settle()
    expect(size()).toBe(readingStep(DEFAULT_STEP_IDX).size)
  })

  it('closes the panel a digit opened when the same digit is pressed again', async () => {
    await mount(null)
    accel('2')
    await settle()
    expect(screen.getByRole('button', { name: 'Close the side pane' }), 'the pane never opened').toBeTruthy()
    accel('2')
    await settle()
    expect(screen.queryByRole('button', { name: 'Close the side pane' }), 'the digit reopened the panel it closes').toBeNull()
  })

  it('asks the shell to close the window on Ctrl+Q', async () => {
    /* Ctrl+Q is bound where there is no application menu to own it — and it is
       the WINDOW'S close, so the teardown the quit handshake runs still runs. */
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    try {
      await mount(null)
      fireEvent.keyDown(window, { key: 'q', ctrlKey: true })
      await settle()
      expect(tauri.closes, 'Ctrl+Q did not reach the window').toBe(1)
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    }
  })
})

describe('taking a book off the shelf', () => {
  it('removes it from its own row menu', async () => {
    /* `usePlacement` reads a layout jsdom does not have, and a zero-sized
       anchor reads as off screen — so the menu closes in the tick it opened. */
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
    }
    try {
      const { fs, moby } = await shelfWithMoby()
      await mount(fs, { books: [{ ...moby, parsedAt: 1, metaSchema: META_SCHEMA }] })
      fireEvent.click(screen.getByLabelText('More for Moby-Dick'))
      await settle()
      fireEvent.click(screen.getByLabelText('Remove Moby-Dick'))
      await settle()
      fireEvent.click(screen.getByLabelText(/^Remove Moby-Dick — the file you imported is kept/u))
      await eventually(() => expect(screen.queryByTitle('Open Moby-Dick'), 'the book stayed on the shelf').toBeNull())
    } finally {
      Element.prototype.getBoundingClientRect = rect
    }
  })
})

describe('a folder import, seen from the reader', () => {
  it('says nothing of a refused choice about a folder that was not refused, and offers no second walk', async () => {
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [{ ...moby, parsedAt: 1, metaSchema: META_SCHEMA }] })
    fireEvent.click(screen.getByRole('button', { name: 'Open a book' }))
    await settle()
    await runCommand('Import a folder', 'Import a folder…')
    await act(async () => held.folders.picks[0]!('/Users/reader/Books'))
    await eventually(() => expect(held.folders.runs).toHaveLength(1))
    /* The walk ADMITTED: the reader draws notices, so a refusal said over an
       admitted walk would be on screen for the whole of it. */
    expect(
      screen.queryByText(/that folder was not imported/u),
      'an admitted walk was reported as a refused one',
    ).toBeNull()

    /* And while it walks, the palette does not offer to start another. */
    accel('k')
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search or ask' }), { target: { value: 'Import a folder' } })
    await settle()
    expect(
      within(screen.getByRole('dialog', { name: 'Search or ask' })).queryByText('Import a folder…'),
      'a second folder import was offered while one was walking',
    ).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    await settle()

    await act(async () => held.folders.runs[0]!.done([]))
    await eventually(() => expect(screen.getByRole('status').textContent).toContain('No books found in that folder.'))
  })
})

describe('the trash across restores and reopenings', () => {
  const openTrash = () => runCommand('Removed', 'Removed books…')
  const restoring = (title: string) => screen.getByRole('button', { name: `Restore ${title}` })
  const cannotRead = () => screen.queryByText(/The trash could not be read\./u)
  const DAY = 24 * 60 * 60 * 1000

  it('clears a failed read the moment a newer scan starts, and says nothing about a scan that was overtaken', async () => {
    const { services } = await mount(fakeFs() as unknown as IndexFs)
    const answers: ((outcome: { state: 'restored' }) => void)[] = []
    vi.spyOn(services.library, 'restore').mockImplementation(
      () => new Promise((resolve) => answers.push(resolve as (outcome: { state: 'restored' }) => void)),
    )
    await openTrash()
    await act(async () => trash.scans[0]!.resolve([row('book:a', 'Alpha'), row('book:b', 'Beta')]))
    await settle()

    fireEvent.click(restoring('Alpha'))
    fireEvent.click(restoring('Beta'))
    await settle()
    expect(answers).toHaveLength(2)

    /* Alpha comes back and its rescan fails: the sheet says why. */
    await act(async () => answers[0]!({ state: 'restored' }))
    await eventually(() => expect(trash.scans).toHaveLength(2))
    await act(async () => trash.scans[1]!.reject(new Error('the trash directory would not open')))
    await eventually(() => expect(cannotRead()).toBeTruthy())

    /* Beta comes back, and its rescan STARTS: the failure it replaces is gone at
       once, and nothing is drawn in its place but what the list now holds. */
    await act(async () => answers[1]!({ state: 'restored' }))
    await eventually(() => expect(trash.scans).toHaveLength(3))
    expect(cannotRead(), 'a failure outlived the scan that replaced it').toBeNull()
    expect(screen.getByText(/Nothing removed/u)).toBeTruthy()

    await act(async () => trash.scans[2]!.resolve([]))
    await settle()
    expect(cannotRead()).toBeNull()
  })

  it('lets a scan that was overtaken answer late without drawing an older list over the newer one', async () => {
    const { services } = await mount(fakeFs() as unknown as IndexFs)
    vi.spyOn(services.library, 'restore').mockResolvedValue({ state: 'restored' })
    await openTrash()
    await act(async () => trash.scans[0]!.resolve([row('book:a', 'Alpha'), row('book:b', 'Beta')]))
    await settle()

    fireEvent.click(restoring('Alpha'))
    await eventually(() => expect(trash.scans).toHaveLength(2))
    fireEvent.click(restoring('Beta'))
    await eventually(() => expect(trash.scans).toHaveLength(3))

    /* The NEWER scan answers first… */
    await act(async () => trash.scans[2]!.resolve([]))
    await eventually(() => expect(screen.getByText(/Nothing removed/u)).toBeTruthy())
    /* …and the older one, still holding both books, lands after it. */
    await act(async () => trash.scans[1]!.resolve([row('book:a', 'Alpha'), row('book:b', 'Beta')]))
    await settle()
    expect(screen.queryByRole('button', { name: 'Restore Alpha' }), 'an overtaken scan drew its list over the newer one').toBeNull()
    expect(screen.getByText(/Nothing removed/u)).toBeTruthy()
  })

  it('opens afresh every time — no rows, no failure and no old clock from the last time it was open', async () => {
    const { services } = await mount(fakeFs() as unknown as IndexFs)
    vi.spyOn(services.library, 'restore').mockResolvedValue({ state: 'partial', held: ['content.epub'] })
    const now = Date.now()
    await openTrash()
    await act(async () =>
      trash.scans[0]!.resolve([{ ...row('book:a', 'Alpha'), removedAt: now - 2 * 60 * 60 * 1000, expiresAt: now + 3 * DAY - 60_000 }]),
    )
    await settle()
    /* Measured against the moment the sheet opened, not against 1970. */
    expect(screen.getByText('3 days left')).toBeTruthy()

    fireEvent.click(restoring('Alpha'))
    await eventually(() => expect(trash.scans).toHaveLength(2))
    await act(async () => trash.scans[1]!.resolve([row('book:a', 'Alpha')]))
    await eventually(() => expect(screen.getByRole('alert')).toBeTruthy())

    /* Closed and opened again: a new scan is out, and the sheet says so rather
       than showing the last list or the last failure. */
    fireEvent.pointerDown(document.querySelector('[data-overlay-scrim]')!, { isPrimary: true, button: 0 })
    await settle()
    await openTrash()
    expect(trash.scans).toHaveLength(3)
    expect(screen.getByText('Reading the trash…'), 'the last list was shown as this one').toBeTruthy()
    expect(screen.queryByRole('alert'), 'the last restore’s failure was shown again').toBeNull()
  })
})

describe('closing the window', () => {
  const asShell = () => Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  const noShell = () => delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  /** The shell's close request, as the window receives it. */
  const requestClose = () =>
    act(async () => {
      await tauri.onClose.at(-1)!({ preventDefault() {} })
    })

  it('drains its own write queue before it goes, and says when the queue will not drain', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    asShell()
    try {
      let drains = 0
      await mount(null, {
        before: (services) => {
          vi.spyOn(services, 'drain').mockImplementation(async () => {
            drains += 1
            throw new Error('the queue would not drain')
          })
        },
      })
      await eventually(() => expect(tauri.onClose.length).toBeGreaterThan(0))
      await requestClose()
      expect(drains, 'the window closed without draining its queue').toBe(1)
      expect(
        quiet.mock.calls.some((call) => call[0] === 'Paper: the write queue did not drain before closing'),
        'a queue that would not drain was not reported',
      ).toBe(true)
      expect(quiet.mock.calls.some((call) => call[0] === 'Paper: the teardown before closing failed')).toBe(false)
      expect(tauri.destroys, 'the window was held open').toBe(1)
    } finally {
      noShell()
      quiet.mockRestore()
    }
  })

  it('runs the composition’s own teardown instead, where there is one', async () => {
    asShell()
    try {
      let drains = 0
      let teardowns = 0
      await mount(null, {
        before: (services) => {
          vi.spyOn(services, 'drain').mockImplementation(async () => {
            drains += 1
          })
        },
        beforeWindowClose: async () => {
          teardowns += 1
        },
      })
      await eventually(() => expect(tauri.onClose.length).toBeGreaterThan(0))
      await requestClose()
      expect(teardowns, 'the composition’s teardown never ran').toBe(1)
      expect(drains, 'the kernel drained a queue the composition owns the teardown of').toBe(0)
      expect(tauri.destroys).toBe(1)
    } finally {
      noShell()
    }
  })
})

describe('keys the window holds and gives back', () => {
  it('offers to close a book only when one is open', async () => {
    await mount(null)
    accel('k')
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search or ask' }), { target: { value: 'Close the book' } })
    await settle()
    expect(within(screen.getByRole('dialog', { name: 'Search or ask' })).queryByText('Close the book')).toBeNull()
  })

  it('reads ⌘ as the accelerator on a Mac, and leaves Control to the text fields', async () => {
    window.history.replaceState(null, '', '/?platform=macos')
    try {
      await mount(null)
      expect(fireEvent.keyDown(window, { key: 'k', ctrlKey: true }), 'Control-K was taken on a Mac').toBe(true)
      await settle()
      expect(screen.queryByRole('textbox', { name: 'Search or ask' })).toBeNull()
      expect(fireEvent.keyDown(window, { key: 'k', metaKey: true })).toBe(false)
      await settle()
      expect(screen.getByRole('textbox', { name: 'Search or ask' })).toBeTruthy()
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })

  it('gives a key back when it comes up, so a later repeat of it is the platform’s', async () => {
    await mount(null)
    expect(accel('k'), 'the first press was not taken').toBe(false)
    fireEvent.keyUp(window, { key: 'k', ctrlKey: true })
    expect(
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true, repeat: true }),
      'a key the window had given back was still treated as held',
    ).toBe(true)
  })

  it('keeps a held key through another key coming up, and through a press it did not take', async () => {
    await mount(null)
    expect(accel('\\'), 'the first press was not taken').toBe(false)
    fireEvent.keyUp(window, { key: 'Shift' })
    expect(
      fireEvent.keyDown(window, { key: '\\', ctrlKey: true, repeat: true }),
      'another key coming up gave this one back',
    ).toBe(false)
    expect(accel('j'), 'an unbound combo was taken').toBe(true)
    expect(
      fireEvent.keyDown(window, { key: '\\', ctrlKey: true, repeat: true }),
      'a press of another key the window did not take gave this one back',
    ).toBe(false)
  })

  it('gives a key back when a fresh press of it is not taken, even with no key-up between', async () => {
    await mount(null)
    expect(accel('\\')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Circle' }))
    await settle()
    /* No pane here, so this press is the platform's — and so is the key now. */
    expect(accel('\\'), 'a press with nothing to do was taken').toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Library' }))
    await settle()
    expect(
      fireEvent.keyDown(window, { key: '\\', ctrlKey: true, repeat: true }),
      'the platform’s press came back as the window’s',
    ).toBe(true)
  })
})

describe('the titlebar and the screens under it', () => {
  const chip = () => screen.getByTitle('Switch book').textContent

  it('names the app with nothing open, names a book it cannot title Untitled, and offers the way back to it', async () => {
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [{ ...moby, parsedAt: 1, metaSchema: META_SCHEMA }] })
    expect(chip(), 'the titlebar did not name the app').toBe('Paper')
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    /* Opened and unparsed: no title of its own, no chapter, no author. */
    expect(chip()).toBe('Untitled')
    accel('l')
    await settle()
    expect(screen.getByRole('button', { name: 'Back to the book' }), 'the shelf forgot there is a book open').toBeTruthy()
  })

  it('leaves the reader inert under every screen but its own', async () => {
    await mount(null)
    /* The pane closed, so the only thing that can make the reader inert is the
       reader's own flag, not the sheet over it. */
    accel('\\')
    await settle()
    /* The reader's own root, by the class its stylesheet gives it. */
    const reader = () => document.querySelector(`.${readerStyles.reader}`)!
    expect(reader().hasAttribute('inert'), 'the reader was live under the shelf').toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open a book' }))
    await settle()
    expect(reader().hasAttribute('inert'), 'the reader was inert on its own screen').toBe(false)
  })

  it('says the Developer panel has nothing to show when this run is not recording', async () => {
    await mount(null)
    developerChord()
    await settle()
    fireEvent.click(controlsLabelled('Developer')[0]!)
    await settle()
    expect(screen.getByText('Diagnostics are not being recorded')).toBeTruthy()
  })

  it('draws each contributed screen as itself, and says so when the composition no longer offers it', async () => {
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    const signal = new AbortController().signal
    const withScreens = await composeCapabilities(
      [
        {
          id: 'cap',
          screens: [
            { id: 'cap:one', label: 'Circle', icon: 'people', render: () => <p>drawn by the circle</p> },
            { id: 'cap:two', label: 'Commons', icon: 'people', render: () => <p>drawn by the commons</p> },
          ],
        },
      ],
      kernelApi(services),
      signal,
    )
    const { rerender } = render(<App services={services} fs={null} composition={withScreens} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Commons' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'Commons', level: 1 })).toBeTruthy()
    expect(screen.getByText('drawn by the commons')).toBeTruthy()

    /* The same window, composed without it: the screen it is on is no longer
       anybody's, and it says that rather than drawing nothing. */
    const withoutScreens = await composeCapabilities([], kernelApi(services), signal)
    rerender(<App services={services} fs={null} composition={withoutScreens} />)
    await settle()
    expect(screen.getByRole('heading', { name: 'Not here', level: 1 })).toBeTruthy()
    expect(screen.getByText('That screen belongs to something this copy of Paper is not running.')).toBeTruthy()
  })
})

describe('the tag sheet over the book being read', () => {
  it('edits that book’s own tags, and suggests the ones already on the shelf', async () => {
    const { fs, moby } = await shelfWithMoby()
    const typee: IndexedBook = {
      bookId: 'book:typee',
      title: 'Typee',
      author: 'Herman Melville',
      hasContent: true,
      parsedAt: 1,
      metaSchema: META_SCHEMA,
      tags: ['seafaring'],
    }
    await mount(fs, { books: [{ ...moby, parsedAt: 1, metaSchema: META_SCHEMA, tags: ['whales'] }, typee] })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    await pressUntilTaken('t', 'the open book’s tags were never offered')
    const sheet = await screen.findByRole('dialog', { name: 'Tags for this book' })
    expect(within(sheet).getByRole('button', { name: 'Remove whales' }), 'the sheet was not editing the open book').toBeTruthy()

    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Add a tag' }), { target: { value: 'sea' } })
    await settle()
    expect(
      within(within(sheet).getByRole('listbox', { name: 'Tags to add' })).getByText('seafaring'),
      'the shelf’s own tags were not offered',
    ).toBeTruthy()
  })
})

describe('the listeners the window puts up', () => {
  it('takes down every keyboard, page-hide and visibility listener it added when it goes', async () => {
    const watched = new Set(['keydown', 'keyup', 'pagehide', 'visibilitychange'])
    const spies = [
      vi.spyOn(window, 'addEventListener'),
      vi.spyOn(window, 'removeEventListener'),
      vi.spyOn(document, 'addEventListener'),
      vi.spyOn(document, 'removeEventListener'),
    ] as const
    try {
      await mount(null)
      cleanup()
      const pairs = (spy: (typeof spies)[number]) =>
        spy.mock.calls.filter(([type]) => watched.has(String(type))).map(([type, listener]) => [String(type), listener] as const)
      for (const [add, remove] of [
        [spies[0], spies[1]],
        [spies[2], spies[3]],
      ] as const) {
        const added = pairs(add)
        const removed = pairs(remove)
        expect(added.length, 'the window put up none of the listeners under test').toBeGreaterThan(0)
        for (const [type, listener] of added) {
          expect(
            removed.some(([gone, was]) => gone === type && was === listener),
            `a ${type} listener outlived the window`,
          ).toBe(true)
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('the Settings panel, as the window hands it over', () => {
  /* ⚠️ **THE WINDOW PROBES THE MACHINE'S FACES AND HANDS THE LIST DOWN, AND
     NOTHING HERE HAD EVER OPENED IT** (2026-09-15). Settings takes `offered`
     from `App`, and a list that never arrived was a menu that threw the first
     time a reader opened it — invisible to every test that left the menu shut.
     jsdom has no canvas to probe with, so the machine has none of the named
     faces and the list is the bundled three. */
  it('offers the typefaces this machine has, in the panel’s own menu', async () => {
    /* `usePlacement` reads a layout jsdom does not have, and a zero-sized
       anchor reads as off screen — so the menu closes in the tick it opened. */
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
    }
    try {
      await mount(null)
      await runCommand('Settings', 'Open Settings')
      fireEvent.click(screen.getByRole('button', { name: 'Typeface: Literata' }))
      await settle()
      const menu = screen.getByRole('menu', { name: 'Typeface' })
      expect(
        within(menu).getAllByRole('menuitemradio').map((item) => item.textContent),
        'the panel was not handed the faces this machine has',
      ).toEqual(['Literata', 'Instrument Sans', 'IBM Plex Mono'])
    } finally {
      Element.prototype.getBoundingClientRect = rect
    }
  })

  /* A window with no storage keeps its settings for the session only, and the
     panel says so — from the store's own flag, which `App` reads and hands on. */
  it('says the settings are not being saved where there is no storage to save them in', async () => {
    await mount(null)
    await runCommand('Settings', 'Open Settings')
    expect(
      screen.getByText(/These settings are not being saved/u),
      'a window that cannot save its settings let the reader believe it could',
    ).toBeTruthy()
  })
})

describe('the library search the window wires up', () => {
  /* ⚠️ **THE WHOLE OF PHASE 31 REACHES THE SIDE PANE THROUGH TWO SPREADS AND
   * ONE HOOK CALL**, and nothing asserted any of them arrived. Emptying either
   * object leaves the app exactly as it was before the phase — a Search pane
   * with no scope switch — and every test still passed, because none looked. */
  const HIT = {
    bookId: 'book:gone',
    sectionIndex: 3,
    offset: 17,
    quote: 'the whale',
    prefix: 'and then we saw ',
    suffix: ' rise beside the boat',
    score: 1.5,
  }

  /** A capability that binds nothing but a passage index. */
  function indexing(search: (q: string, limit?: number) => Promise<readonly unknown[]>) {
    return {
      id: 'passages',
      start: (api: { services: { bindPassages: (port: unknown) => { dispose: () => void } } }) => {
        const bound = api.services.bindPassages({
          search,
          status: async () => ({
            books: 1, sections: 1, chars: 1, indexBytes: 1, textBytes: 1,
            analysis: 'paper/1', unreadable: [],
          }),
        })
        return { dispose: () => bound.dispose() }
      },
    } as unknown as Parameters<typeof composeCapabilities>[0][number]
  }

  /** Open Moby-Dick and put the Search pane on screen beside it. */
  async function readingWith(search: (q: string, limit?: number) => Promise<readonly unknown[]>) {
    const { fs, moby } = await shelfWithMoby()
    await mount(fs, { books: [moby], capability: indexing(search) })
    fireEvent.click(screen.getByTitle('Open Moby-Dick'))
    expect(await screen.findByText(WILL_NOT_PARSE)).toBeTruthy()
    /* The digits map to the OFFERED panes, and `cards` is unfinished, so which
     * one Search is cannot be written down — it is found by asking. */
    for (const digit of ['1', '2', '3', '4', '5', '6']) {
      accel(digit)
      await settle()
      if (screen.queryByLabelText(/^Search (this book|every book)$/u)) return
    }
    throw new Error('no digit opened the Search pane')
  }

  it('offers the scope switch once a passage index is bound', async () => {
    await readingWith(async () => [])
    expect(screen.queryByRole('radio', { name: 'Every book' })).not.toBeNull()
  })

  it('reports a hit whose book left the shelf by CAUSE, which needs the real shelf', async () => {
    /* ⚠️ **THIS IS WHAT PINS THE HOOK'S ARGUMENT OBJECT.** Emptied, the hook
     * gets no filesystem and every hit is refused with "this device cannot open
     * books from the library index" — a sentence about the DEVICE, for a
     * problem that is about one book. With the real arguments the same click
     * says the book is no longer on the shelf, which is true and actionable. */
    await readingWith(async () => [HIT])
    fireEvent.click(screen.getByRole('radio', { name: 'Every book' }))
    fireEvent.change(screen.getByLabelText('Search every book'), { target: { value: 'whale' } })
    const row = await screen.findByRole('button', { name: /the whale/u }, { timeout: 4000 })
    fireEvent.click(row)
    await settle()
    expect(screen.queryByText(/no longer on your shelf/u)).not.toBeNull()
    expect(screen.queryByText(/cannot open books from the library index/u)).toBeNull()
  })
})
