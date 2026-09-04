// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexFs, IndexedBook } from '../core/bookIndex'
import type { ScreenContribution } from '../core/capability'
import type { TrashedBook } from '../core/bookTrash'
import { folderOf } from '../core/bookFolder'
import { bookIdFor } from '../core/marks'
import { fakeFs } from '../core/indexFsFake.testkit'
import { composeCapabilities, kernelApi } from '../core/registry'
import { createKernelServices } from '../core/services'

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
const trash = vi.hoisted(() => ({ scans: [] as { resolve(rows: TrashedBook[]): void }[] }))
vi.mock('../core/bookTrash', async (importActual) => ({
  ...(await importActual<typeof import('../core/bookTrash')>()),
  listTrash: () =>
    new Promise<TrashedBook[]>((resolve) => {
      trash.scans.push({ resolve })
    }),
}))

import { App } from './App'

afterEach(() => {
  cleanup()
  trash.scans.length = 0
})
/* jsdom has no `scrollIntoView` (the palette's active row calls it) and no
   `ResizeObserver` (the reader measures its stage with one). */
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

type ScreenContext = Parameters<ScreenContribution['render']>[0]

/** The whole window over `fs`, with one contributed screen that records what it is handed. */
async function mount(fs: IndexFs | null, over: { readonly books?: readonly IndexedBook[]; readonly bootNotice?: string } = {}) {
  const services = createKernelServices({ fs, storage: null, initialBooks: over.books ?? [] })
  const handed: ScreenContext[] = []
  const composition = await composeCapabilities(
    [
      {
        id: 'cap',
        screens: [
          {
            id: 'cap:one',
            label: 'Circle',
            render: (context) => {
              handed.push(context)
              return <p>drawn by the capability</p>
            },
          },
        ],
      },
    ],
    kernelApi(services),
    new AbortController().signal,
  )
  render(<App services={services} fs={fs} composition={composition} {...(over.bootNotice === undefined ? {} : { bootNotice: over.bootNotice })} />)
  await settle()
  return { services, handed }
}

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0))
  })

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
const WILL_NOT_PARSE = 'File type not supported'

/** The chord that reveals the developer surfaces — `event.code`, as the real key arrives. */
const developerChord = () => fireEvent.keyDown(window, { key: 'd', code: 'KeyD', metaKey: true, ctrlKey: true, altKey: true })
/** The accelerator is Ctrl off macOS, and jsdom's user agent is nobody's Mac. */
const accel = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true })

/** Open the palette from the keyboard — it answers on every screen — and run the command that matches `query`. */
async function runCommand(query: string, label: string) {
  accel('k')
  await settle()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search or ask' }), { target: { value: query } })
  await settle()
  fireEvent.click(screen.getByText(label).closest('button')!)
  await settle()
}

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

  it('takes a question no command matches to the companion, once the developer has revealed it', async () => {
    /* Enter on a query that matches nothing dismisses the palette and opens
       the companion pane — a reader's pane, so the reader screen; and one of
       the unfinished panes, so only after the chord. */
    await mount(null)
    fireEvent.click(screen.getByRole('button', { name: 'Open a book' }))
    await settle()
    developerChord()
    await settle()
    accel('k')
    await settle()
    const input = screen.getByRole('textbox', { name: 'Search or ask' })
    fireEvent.change(input, { target: { value: 'what is a whale' } })
    await settle()
    expect(screen.getByText(/No command matches/u)).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()
    expect(screen.queryByRole('textbox', { name: 'Search or ask' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Companion' }).some((one) => one.getAttribute('aria-pressed') === 'true')).toBe(true)
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
})
