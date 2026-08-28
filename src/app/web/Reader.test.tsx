// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Reader } from './Reader'
import type { ContentFacts, RemoteContent } from './content'
import { readingPositions, type PositionStore } from './positions'

/**
 * WHICH PATH A BOOK TAKES, and what happens when the shelf cannot say.
 *
 * The reader itself is `FoliateView`, which has its own suite and is exercised
 * by the desktop on every run. What is new here is the DECISION in front of it:
 * a PDF goes through a range transport so a phone never holds the whole file,
 * an EPUB is assembled into a `File` because a zip's directory is at the end,
 * and a shelf that cannot measure a PDF has no length to give a transport.
 *
 * That last branch is the one worth having a test for. `content.locate` answers
 * `size: null` whenever the shelf binds no size port — which the desktop app did
 * for the whole of phase 11 — and a transport built on `null` opens an empty
 * document with no error anywhere.
 */

/* pdf.js reads `DOMMatrix` at module scope and jsdom does not implement it.
 * Nothing here paints — a transport moves bytes — so the stub only has to
 * exist. Same reason `pdfRange.test.ts` carries one. */
const globals = globalThis as { DOMMatrix?: unknown }
globals.DOMMatrix ??= class {}

/**
 * ⚠️ **EVERY ELEMENT HAS A BOX**, and in jsdom none of them do.
 *
 * `useRowMenu` closes a menu whose anchor is `detached` — off screen, where its
 * items would stay focusable and exposed to assistive technology while nobody
 * can see them. jsdom answers every `getBoundingClientRect` with zeros, so
 * every anchor is detached and **no menu in this repository can be opened by a
 * test without this**: it opens and shuts inside the same commit, which reads
 * exactly like a control that does not work.
 *
 * That cost an hour and a reproduction in isolation. `LibraryShelf.test.tsx`
 * carries the same stub for the same reason.
 */
Element.prototype.getBoundingClientRect = function (): DOMRect {
  return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
}

/**
 * ⚠️ **WHAT `Reader` HANDS THE READER, CAPTURED — AND IT USED TO BE INVISIBLE.**
 *
 * `FoliateView` mounts a custom element and cannot render in jsdom, so several
 * tests below could only look at the surrounding chrome. That chrome is present
 * from the first frame, which made a whole class of assertion VACUOUS: "the
 * banner exists" was true before the decision under test had been made, and
 * true if it was never made at all. Three tests in this file asserted exactly
 * that and would have passed with the feature deleted.
 *
 * The decision is a PROP. `withView` mounts a fresh `Reader` over a stand-in
 * that records what it is given — the same idiom the page-intent tests below
 * already use, hoisted here so the source can be asserted rather than inferred.
 */
async function withView(
  render_: (Fresh: typeof Reader) => void,
): Promise<Record<string, unknown>> {
  const captured: Record<string, unknown> = {}
  vi.doMock('../../kernel/ui/reader/FoliateView', () => ({
    FoliateView: (props: Record<string, unknown>) => {
      Object.assign(captured, props)
      /* EVERY SOURCE, not just the last: the decision is "which one did it ever
         hand over", and a re-render with `file: null` would otherwise erase the
         answer. */
      ;(captured['sources'] as unknown[]).push(props['file'])
      return null
    },
  }))
  captured['sources'] = []
  vi.resetModules()
  const { Reader: Fresh } = await import('./Reader')
  render_(Fresh)
  return captured
}

/** The sources a captured view was handed, ignoring the empty ones. */
const sourcesOf = (captured: Record<string, unknown>) =>
  (captured['sources'] as unknown[]).filter((f) => f !== null)

afterEach(() => {
  cleanup()
  vi.doUnmock('../../kernel/ui/reader/FoliateView')
  vi.resetModules()
})

function shelf(facts: Partial<ContentFacts>) {
  const readRange = vi.fn(async () => new Uint8Array(0))
  const fileOf = vi.fn(async (_book: string, name: string) => new File(['PK'], name))
  const content = {
    locate: async (): Promise<ContentFacts> => ({ here: true, ext: 'epub', size: 10, ...facts }),
    readRange,
    fileOf,
  } as unknown as RemoteContent
  return { content, readRange, fileOf }
}

/** Positions over a store the test owns, so no browser storage is touched. */
function fakePositions(seed: Record<string, { cfi: string; at: number }> = {}) {
  let held: string | null = Object.keys(seed).length > 0 ? JSON.stringify(seed) : null
  const store: PositionStore = { getItem: () => held, setItem: (_k, v) => void (held = v) }
  return readingPositions(store, () => 1)
}

const open = (content: RemoteContent, positions = fakePositions()) =>
  render(
    <Reader content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={positions} />,
  )

describe('Reader', () => {
  it('assembles an EPUB into a file, under the name a parser routes on', async () => {
    const { content, fileOf } = shelf({ ext: 'epub' })
    open(content)
    /* THE SUFFIX IS REBUILT FROM WHAT THE SHELF STORES. The shelf sends a
       TITLE; every parser Paper uses routes on the extension, and foliate
       rejects a name without one as an unsupported type. */
    await waitFor(() => expect(fileOf).toHaveBeenCalledWith('one', 'Moby-Dick.epub'))
  })

  it('says so plainly when the shelf does not have the pages', async () => {
    const { content, fileOf } = shelf({ here: false })
    open(content)
    await screen.findByText(/does not have this book/i)
    expect(fileOf).not.toHaveBeenCalled()
  })

  /**
   * A PDF THE SHELF CANNOT MEASURE FALLS BACK, and does not build a transport.
   *
   * pdf.js is told a length before it asks for a byte of the file. `null` is a
   * real answer from `content.locate` — it is what a shelf with no size port
   * says about every book — and a transport of length `null` is a document of
   * no bytes, which opens as an empty PDF rather than as an error. Slower and
   * correct is the right way round.
   */
  it('fetches a PDF whole when the shelf could not measure it', async () => {
    const { content, fileOf, readRange } = shelf({ ext: 'pdf', size: null })
    open(content)
    await waitFor(() => expect(fileOf).toHaveBeenCalledWith('one', 'Moby-Dick.pdf'))
    expect(readRange, 'no transport should have been built').not.toHaveBeenCalled()
  })

  it('keeps the name as-is when the shelf reports no extension', async () => {
    const { content, fileOf } = shelf({ ext: null })
    open(content)
    await waitFor(() => expect(fileOf).toHaveBeenCalledWith('one', 'Moby-Dick'))
  })

  it('reports a failure to locate rather than rendering an empty reader', async () => {
    const content = {
      locate: async () => {
        throw new Error('the shelf went away')
      },
    } as unknown as RemoteContent
    open(content)
    await screen.findByText(/the shelf went away/i)
  })

  /**
   * THE PATH THIS WHOLE WORK ITEM EXISTS FOR.
   *
   * A measured PDF goes through a range transport, so pdf.js asks the shelf for
   * the byte ranges of the page it is drawing rather than the file. The
   * assertion is that `fileOf` is NEVER reached: falling back would work, and
   * would download a 300 MB scanned book to show page one.
   */
  it('gives a measured PDF a range transport and never fetches it whole', async () => {
    const { content, fileOf, readRange } = shelf({ ext: 'pdf', size: 614907 })
    const captured = await withView((Fresh) =>
      render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />),
    )

    /* ⚠️ **THIS USED TO ASSERT THAT THE BANNER EXISTED**, which is true from the
     * first frame and true if no transport were ever built. What the work item
     * is about is the SOURCE the reader is handed: a `{ range, name }` and not a
     * `File`. That is a prop, so it can be looked at. */
    await waitFor(() => expect(sourcesOf(captured)).toHaveLength(1))
    const source = sourcesOf(captured)[0] as { range?: unknown; name?: string }
    expect(source.range, 'a measured PDF must reach the reader as a range transport').toBeDefined()
    expect(source.name, 'named so pdf.js routes on the suffix').toBe('Moby-Dick.pdf')
    expect(source, 'a File here is the whole-download fallback').not.toBeInstanceOf(File)

    /* AND THE FILE WAS NEVER FETCHED. Falling back would work, and would
       download a 300 MB scanned book to show page one. */
    expect(fileOf).not.toHaveBeenCalled()
    expect(readRange, 'nothing has asked for a page yet').not.toHaveBeenCalled()
  })

  /**
   * A RANGE READ THAT FAILS HAS NOWHERE TO GO in pdf.js — it has an
   * `onDataRange` and no `onError` — so without surfacing it the book stops on
   * a blank page for ever.
   *
   * ⚠️ **THIS USED TO BUILD ITS OWN TRANSPORT AND EXERCISE THAT**, which tests
   * `pdfRange.ts` (already covered by its own file) and says nothing about the
   * one here. `Reader` supplies the `onFailure` that turns a dead transport into
   * something the reader can see, and a test that builds a second transport
   * would pass with `Reader`'s handler deleted. The transport under test is the
   * one `Reader` handed over.
   */
  it('surfaces a failed range read instead of leaving the page blank', async () => {
    const failing = {
      locate: async (): Promise<ContentFacts> => ({ here: true, ext: 'pdf', size: 64 }),
      readRange: async () => {
        throw new Error('the shelf went away')
      },
      fileOf: async () => new File([], 'x.pdf'),
    } as unknown as RemoteContent
    const captured = await withView((Fresh) =>
      render(<Fresh content={failing} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />),
    )
    await waitFor(() => expect(sourcesOf(captured)).toHaveLength(1))

    /* READER'S OWN TRANSPORT, asked for a range as pdf.js would. */
    const source = sourcesOf(captured)[0] as { range: { requestDataRange: (a: number, b: number) => void } }
    act(() => source.range.requestDataRange(0, 8))

    /* THE READER IS TOLD. `Reader`'s `onFailure` sets `problem`, which reaches
       the reading surface — a message, not a blank page waiting for ever. */
    expect(await screen.findByText(/the shelf went away/i)).toBeTruthy()
  })

  it('goes back to the shelf, from the reader and from a book it could not open', async () => {
    const onClose = vi.fn()
    const { content } = shelf({ ext: 'epub' })
    const { unmount } = render(
      <Reader content={content} bookId="one" name="Moby-Dick" onClose={onClose} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /shelf/i }))
    expect(onClose).toHaveBeenCalledOnce()
    unmount()

    /* AND FROM THE DEAD END. A book with no pages is the one screen where a
       reader has nothing else to press. */
    const missing = shelf({ here: false })
    render(<Reader content={missing.content} bookId="one" name="Moby" onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: /back to the shelf/i }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  /* A PHONE ROTATES, and the measure is derived from the stage's width. A
     reader that kept the portrait measure in landscape would set the page to
     half the screen and leave the rest white. */
  /**
   * A PHONE ROTATES, and the measure is derived from the stage's width. A
   * reader that kept the portrait measure in landscape would set the page to
   * half the screen and leave the rest white.
   *
   * ⚠️ **THIS USED TO ASSERT THAT THE BANNER SURVIVED.** The banner is present
   * from the first frame and survives anything that does not throw — so the
   * test passed with the resize listener removed, which is the only thing it
   * claimed to be about. The measure is a PROP, and a prop can be compared.
   */
  it('re-measures when the window changes size', async () => {
    const { content } = shelf({ ext: 'epub' })
    const captured = await withView((Fresh) =>
      render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />),
    )
    await waitFor(() => expect(captured['measure']).toBeTypeOf('number'))
    const portrait = captured['measure'] as number

    /* NARROWER, deliberately. A measure has a MAXIMUM — `proseGrid` will not
       set a line wider than the step's ideal however much room there is — so
       widening the window is the direction in which nothing is supposed to
       happen, and a test that asserted a change there would be asserting the
       opposite of the typography. Narrowing is where the stage binds. */
    act(() => {
      Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })

    await waitFor(() =>
      expect(
        captured['measure'],
        'the measure did not follow the window; the page keeps its old width',
      ).not.toBe(portrait),
    )
    /* AND IT FOLLOWED THE RIGHT WAY. Asserting only "it changed" would pass on
       a measure that grew when the window shrank. */
    expect(captured['measure'] as number).toBeLessThan(portrait)
    expect(captured['measure'] as number).toBeLessThanOrEqual(360)
  })

  /**
   * A BOOK REOPENS WHERE IT WAS LEFT.
   *
   * Kept in the browser rather than on the book's record: the pump grants this
   * client `readingGrant` and nothing else, so every write in the service table
   * is refused — deliberately, because a hostile EPUB shares this origin and a
   * socket it opens carries the reader's session. Widening that for a position
   * would widen it for `book.set`, which also carries a title and a tag list.
   *
   * **The cost is that a position does not sync**, and that is a real
   * limitation rather than a temporary one.
   */
  it('opens a book where it was left', async () => {
    const positions = fakePositions({ one: { cfi: 'epubcfi(/6/4!/4/2/10)', at: 1 } })
    const { content } = shelf({ ext: 'epub' })
    const captured = await withView((Fresh) =>
      render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={positions} />),
    )
    await waitFor(() => expect(sourcesOf(captured)).toHaveLength(1))

    /* ⚠️ **THIS USED TO CHECK ONLY THAT STORAGE WAS NOT OVERWRITTEN**, which is
     * true of a `Reader` that never reads the store at all — the feature could
     * be deleted and the test would stay green. Restoring a position means
     * HANDING IT TO THE READER, and that is a prop. */
    expect(
      captured['lastLocation'],
      'a stored position that never reaches the reader is a position nobody has',
    ).toBe('epubcfi(/6/4!/4/2/10)')
    /* AND STILL NOT OVERWRITTEN: a book that re-read the store on every
       relocate would be a book that could not be read at all. */
    expect(positions.get('one')).toBe('epubcfi(/6/4!/4/2/10)')
  })

  it('starts at the beginning for a book it has never opened', async () => {
    const positions = fakePositions()
    const { content } = shelf({ ext: 'epub' })
    const captured = await withView((Fresh) =>
      render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={positions} />),
    )
    await waitFor(() => expect(sourcesOf(captured)).toHaveLength(1))
    /* NULL, not a stale cfi from another book: `lastLocation` is what foliate
       navigates to, and a wrong one opens the book somewhere it has never
       been. */
    expect(captured['lastLocation']).toBeNull()
    expect(positions.get('one')).toBeNull()
  })

  /**
   * A BOOK THAT CANNOT BE TURNED IS ONE PAGE.
   *
   * `onPageIntent` and `onNavigator` were both no-ops when this surface first
   * shipped, so a book opened and stayed on its first page — a tap, a swipe and
   * the arrow keys all did nothing. Found by trying to turn a page against the
   * running shelf, which is the only place it was visible.
   *
   * The four intents are two pairs and are not interchangeable: a horizontal
   * gesture names a SIDE, which foliate resolves against the book's direction,
   * and a vertical one names a DIRECTION OF TRAVEL. Routing one through the
   * other reverses the wheel in a right-to-left book.
   */
  it('routes each page intent to the navigator it was given', async () => {
    const { content } = shelf({ ext: 'epub' })
    const seen: string[] = []
    const nav = {
      next: () => seen.push('next'),
      prev: () => seen.push('prev'),
      goLeft: () => seen.push('goLeft'),
      goRight: () => seen.push('goRight'),
    }

    /* Reach the props FoliateView was handed, which is where the wiring lives —
       the component itself cannot open a book in jsdom. */
    const captured: Record<string, unknown> = {}
    vi.doMock('../../kernel/ui/reader/FoliateView', () => ({
      FoliateView: (props: Record<string, unknown>) => {
        Object.assign(captured, props)
        return null
      },
    }))
    vi.resetModules()
    const { Reader: Fresh } = await import('./Reader')
    render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />)
    await waitFor(() => expect(captured['onNavigator']).toBeTypeOf('function'))

    ;(captured['onNavigator'] as (g: number, n: unknown) => void)(0, nav)
    const intent = captured['onPageIntent'] as (i: string) => void
    for (const one of ['left', 'right', 'next', 'prev']) intent(one)
    expect(seen).toEqual(['goLeft', 'goRight', 'next', 'prev'])

    /* AND AN INTENT BEFORE THE BOOK IS OPEN IS NOT A CRASH. The navigator
       arrives when the session finishes parsing; a gesture in that window is
       ordinary, not exceptional. */
    ;(captured['onNavigator'] as (g: number, n: unknown) => void)(0, null)
    expect(() => intent('next')).not.toThrow()

    vi.doUnmock('../../kernel/ui/reader/FoliateView')
    vi.resetModules()
  })

  /**
   * THE THREE SHEETS, and the rule that only one is open.
   *
   * Contents, Search and Notes all cover the reading surface, so a second
   * opened over the first would leave the reader two dismissals from the book.
   * The Notes control is drawn only when this host HAS marks — absent, not
   * disabled, like every other capability this client lacks.
   */
  it('opens one sheet at a time, and offers Notes only when there are marks', async () => {
    const { content } = shelf({ ext: 'epub' })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )

    const removed: { id: string; bookId: string }[] = []
    const marks = {
      all: [
        {
          id: 'm1',
          bookId: 'one',
          cfi: 'epubcfi(/6/2)',
          sectionIndex: 0,
          text: 'the whale',
          prefix: '',
          suffix: '',
          note: '',
          kind: 'highlight',
          tint: 'yellow',
          style: 'fill',
          chapter: 'One',
          createdAt: 1,
        },
      ],
      allBookmarks: [],
      persistent: true,
      remove: (m: { id: string; bookId: string }) => removed.push(m),
      setNote: () => {},
      loadAll: () => {},
      subscribe: () => () => {},
      refresh: () => {},
      dispose: () => {},
    }

    const captured: Record<string, unknown> = {}
    vi.doMock('../../kernel/ui/reader/FoliateView', () => ({
      FoliateView: (props: Record<string, unknown>) => {
        Object.assign(captured, props)
        return null
      },
    }))
    vi.resetModules()
    const { Reader: Fresh } = await import('./Reader')
    render(
      <Fresh
        content={content}
        bookId="one"
        name="Moby-Dick"
        onClose={vi.fn()}
        positions={fakePositions()}
        marks={marks as never}
        titleOf={() => 'Another'}
      />,
    )
    await waitFor(() => expect(captured['onToc']).toBeTypeOf('function'))
    ;(captured['onToc'] as (g: number, t: unknown) => void)(0, [{ label: 'One', href: 'c1.xhtml' }])
    ;(captured['onMeta'] as (g: number, m: unknown) => void)(0, { title: 'Moby-Dick' })

    /* ONE SHEET, WITH TABS. The chrome carries a single control — Tools —
       and Contents, Search and Notes are tabs at the sheet's foot. Switching a
       tab swaps the body; there is no second sheet to leave open. */
    fireEvent.click(await screen.findByRole('button', { name: 'Tools' }))
    expect(screen.queryByRole('button', { name: 'One' })).not.toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Search' }))
    expect(screen.queryByRole('button', { name: 'One' })).toBeNull()
    expect(screen.queryByLabelText('Search this book')).not.toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Notes' }))
    expect(screen.queryByLabelText('Search this book')).toBeNull()

    vi.doUnmock('../../kernel/ui/reader/FoliateView')
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  /* NO MARKS, NO CONTROL. A host without them draws no Notes button rather
     than a disabled one — the convention this client uses everywhere. */
  it('draws no Notes control when this host has no marks', async () => {
    const { content } = shelf({ ext: 'epub' })
    render(<Reader content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: '‹ Shelf' })).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull()
  })

  /**
   * THE READING PREFERENCES (WI-19.9).
   *
   * Mounted rather than rebuilt: `pane/Settings.tsx` with seven of its setters
   * omitted, so a host with no ruler, no side pane and no brightness filter
   * draws none of those rows. What it writes goes through the KERNEL'S OWN
   * settings store over `localStorage` — the real keys and the real validators,
   * not a second definition of what a theme may be.
   */
  it('applies the reader’s stored preferences, and writes a change back', async () => {
    const { content } = shelf({ ext: 'epub' })
    /* jsdom HAS NO `ResizeObserver`, and `Settings`' groups measure themselves
       to animate open. A stub that observes nothing is enough: this test is
       about what the pane WRITES, not about how tall it is. */
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    /**
     * ⚠️ **SEEDED WITH VALUES THAT ARE NOT THE DEFAULTS.**
     *
     * This started EMPTY and then asserted `theme === 'paper'` and a typeface of
     * "any string" — which are `KERNEL_SETTINGS`' own fallbacks. So the read
     * half was satisfied by a `Reader` that never opened the store at all: the
     * whole persistence path could be deleted and it stayed green. A stored
     * preference is only stored if a DIFFERENT value comes back.
     */
    const store: Record<string, string> = {
      'paper.settings.v1': JSON.stringify({
        version: 1,
        values: {
          'kernel.theme': 'sepia',
          /* ⚠️ OFF, DELIBERATELY. `themeFollowsOs` defaults to TRUE and, when
             on, the applied theme is chosen from `prefers-color-scheme` rather
             than from the stored value — so a stored theme is invisible until
             the reader has picked one explicitly. That is correct behaviour and
             it is also what makes this assertion about the store rather than
             about the OS. */
          'kernel.themeFollowsOs': false,
          'kernel.typeface': 'crimson',
          'kernel.align': 'ragged',
        },
      }),
    }
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
    })

    const captured: Record<string, unknown> = {}
    vi.doMock('../../kernel/ui/reader/FoliateView', () => ({
      FoliateView: (props: Record<string, unknown>) => {
        Object.assign(captured, props)
        return null
      },
    }))
    vi.resetModules()
    const { Reader: Fresh } = await import('./Reader')
    render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />)
    await waitFor(() => expect(captured['theme']).toBeTypeOf('string'))

    /* THE STORED VALUES REACH THE BOOK, which is the whole point of storing
       them — a preference the renderer never sees is a preference nobody has.
       Each one is a value the defaults do not produce, so a reader that never
       consulted the store answers differently. */
    expect(captured['theme'], 'the stored theme never reached the book').toBe('sepia')
    expect(captured['typeface'], 'the stored typeface never reached the book').toBe('crimson')
    expect(captured['align'], 'the stored alignment never reached the book').toBe('ragged')

    fireEvent.click(await screen.findByRole('button', { name: 'Tools' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reading' }))
    fireEvent.click(await screen.findByRole('button', { name: /Night/i }))

    /* AN EXPLICIT PICK TURNS OFF OS FOLLOWING — `state.ts` states the rule for
       the desktop, and without it here the chosen theme was overridden on the
       next render and the control did nothing you could see. */
    const written = JSON.parse(store['paper.settings.v1'] ?? '{}') as {
      values?: Record<string, unknown>
    }
    expect(written.values?.['kernel.theme']).toBe('night')
    expect(written.values?.['kernel.themeFollowsOs']).toBe(false)
    await waitFor(() => expect(captured['theme']).toBe('night'))

    /* THE SEVEN THIS HOST CANNOT ACT ON ARE NOT DRAWN. A row for a reading
       ruler that is not mounted would be a control that cannot act. */
    expect(screen.queryByText('Reading ruler')).toBeNull()
    expect(screen.queryByText('Side pane position')).toBeNull()
    expect(screen.queryByText('Brightness')).toBeNull()

    /**
     * EVERY SETTING THIS SURFACE OFFERS WRITES ITS OWN KEY.
     *
     * ⚠️ **THIS USED TO CLICK EVERY CONTROL AND CHECK THAT THE STORE CHANGED
     * AT ALL.** One working setter satisfies that, and the theme click above
     * has already written — so the assertion was true before this block ran.
     * Six of the seven setters could have been inert and it would have passed.
     *
     * Each is a SEPARATE inline setter on this surface, and a setter that
     * stopped writing changes nothing on screen, so only the store can say. The
     * keys are named one at a time.
     *
     * ⚠️ SCOPED TO THE SHEET, and the GROUP SUMMARIES are skipped. The bar's own
     * icons are buttons too, and clicking one closes the sheet — every row after
     * it is then detached and nothing is written. So is clicking a summary,
     * which collapses its group. Both look identical to a pane of dead
     * controls.
     */
    const sheet = () => document.querySelector('[role="dialog"]')
    const GROUPS = /^(appearance|text|spacing|paragraphs|blocks|figures|page)$/i
    /* ⚠️ **THE GROUPS OPEN FIRST, and the sweep used to skip them entirely.**
     * A collapsed group renders no rows, so `kernel.spacing` — which lives
     * under one — had no control to click and was never written. Skipping the
     * summaries was right for the SWEEP (clicking one collapses it and detaches
     * every row after it) and wrong as a way to reach what is inside them. */
    for (const summary of [...(sheet()?.querySelectorAll('button') ?? [])]) {
      if (GROUPS.test((summary.textContent ?? '').trim()) && summary.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(summary)
      }
    }
    const rows = [...(sheet()?.querySelectorAll('button') ?? [])].filter(
      (b) => !GROUPS.test((b.textContent ?? '').trim()),
    )
    expect(rows.length).toBeGreaterThan(5)
    /* ⚠️ **THE TYPEFACE IS A MENU, NOT A ROW**, and it is held out of the sweep.
     * `FacePicker` is a button that OPENS a list, and the list does not exist
     * until it is clicked — so a snapshot of the sheet's buttons cannot contain
     * a face to pick. Worse, clicking it mid-sweep opens a menu that the NEXT
     * row's click then dismisses, so the sweep left it shut and wrote nothing.
     * The old assertion ("the store changed at all") was already satisfied by
     * the theme click above and never noticed. Found by naming the keys. */
    const opener = screen.getByRole('button', { name: /^Typeface:/ })
    fireEvent.click(opener)
    const faces = screen.getAllByRole('menuitemradio')
    const other = faces.find((f) => f.getAttribute('aria-checked') !== 'true')
    expect(other, 'the face menu offered nothing to change to').toBeDefined()
    fireEvent.click(other!)

    for (const one of rows) {
      if (one !== opener && one.isConnected) fireEvent.click(one)
    }

    const keysWritten = () =>
      Object.keys(
        (JSON.parse(store['paper.settings.v1'] ?? '{}') as { values?: Record<string, unknown> }).values ?? {},
      )
    /* THE SEVEN `WEB_SETTINGS` DECLARES, derived rather than listed — a setting
       added to that table with no control here fails this rather than being
       noticed later by a reader whose choice does nothing. */
    const { WEB_SETTINGS } = await import('./settings')
    for (const setting of Object.values(WEB_SETTINGS)) {
      expect(keysWritten(), `nothing ever wrote ${setting.key}`).toContain(setting.key)
    }

    vi.doUnmock('../../kernel/ui/reader/FoliateView')
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  /**
   * THE TABLE OF CONTENTS (WI-19.9).
   *
   * `FoliateView` has raised `onToc` all along and this client passed `ignore`,
   * so a reader on a phone could move through a book one page at a time and no
   * other way. The pane is the kernel's own `pane/Contents.tsx` — 61 lines,
   * browser-safe, mounted rather than reimplemented.
   */
  it('offers the book’s contents, and goes where one is chosen', async () => {
    const { content } = shelf({ ext: 'epub' })
    const went: string[] = []
    const nav = {
      next: () => {},
      prev: () => {},
      goLeft: () => {},
      goRight: () => {},
      goTo: (target: string) => went.push(target),
    }

    const captured: Record<string, unknown> = {}
    vi.doMock('../../kernel/ui/reader/FoliateView', () => ({
      FoliateView: (props: Record<string, unknown>) => {
        Object.assign(captured, props)
        return null
      },
    }))
    vi.resetModules()
    const { Reader: Fresh } = await import('./Reader')
    render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />)
    await waitFor(() => expect(captured['onToc']).toBeTypeOf('function'))

    /* NO CONTENTS, NO TAB. A book that declares none gets no Contents tab in
       the tools sheet — an absent capability is an absent control, never a
       disabled one. The sheet itself is still reachable: Search and Reading
       need no contents. */
    fireEvent.click(await screen.findByRole('button', { name: 'Tools' }))
    expect(screen.queryByRole('button', { name: 'Contents' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))

    ;(captured['onNavigator'] as (g: number, n: unknown) => void)(0, nav)
    ;(captured['onToc'] as (g: number, t: unknown) => void)(0, [
      { label: 'Chapter One', href: 'c1.xhtml' },
      { label: 'Chapter Two', href: 'c2.xhtml' },
    ])
    ;(captured['onRelocate'] as (g: number, p: unknown) => void)(0, {
      cfi: 'epubcfi(/6/2)',
      chapterHref: 'c1.xhtml',
    })

    /* The reader's chrome has ONE control — Tools — and Contents is the first
       tab of the sheet it opens, so opening Tools lands on the contents. */
    fireEvent.click(await screen.findByRole('button', { name: 'Tools' }))

    /* WHICH ENTRY IS CURRENT comes from `chapterHref`, not the label: labels
       repeat across a book and matching on them marks every duplicate. */
    const one = await screen.findByRole('button', { name: 'Chapter One' })
    expect(one.getAttribute('data-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Chapter Two' }).getAttribute('data-current')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Chapter Two' }))
    expect(went).toEqual(['c2.xhtml'])
    /* AND THE SHEET CLOSES. It covers the book, so leaving it open after a
       choice would hide the page the reader just asked for. */
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Chapter Two' })).toBeNull())

    vi.doUnmock('../../kernel/ui/reader/FoliateView')
    vi.resetModules()
  })

  /**
   * TAP TO TURN, on the book's own document.
   *
   * A page intent reaches the reader from ONE gesture — the wheel — and a phone
   * has none: Playwright says "Mouse wheel is not supported in mobile WebKit",
   * which is the device and not the harness. So the surface shipped a book that
   * opened and could not be advanced on the one kind of device it is for.
   *
   * The book is in an iframe, so the listener has to live on the document
   * `onDocument` hands over — and be REMOVED when that document goes, because
   * foliate loads one per section and keeps neighbours alive. Without the
   * teardown a book accumulates a listener per section read.
   */
  /**
   * ⚠️ **A FAILURE THE READER CANNOT SEE IS A BLANK PAGE.**
   *
   * `problem` reached `SearchPanel` alone — a pane behind a centre tap and a
   * tab — so a dropped channel or a range read that failed left the reading
   * surface empty with its explanation folded inside a panel nobody had reason
   * to open. The one failure this surface cannot afford to be quiet about is
   * the one where there is nothing to look at.
   */
  it('says on the page when the renderer reports a failure', async () => {
    const { content } = shelf({ ext: 'epub' })
    const captured: Record<string, unknown> = {}
    vi.doMock('../../kernel/ui/reader/FoliateView', () => ({
      FoliateView: (props: Record<string, unknown>) => {
        Object.assign(captured, props)
        return null
      },
    }))
    vi.resetModules()
    const { Reader: Fresh } = await import('./Reader')
    render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />)
    await waitFor(() => expect(captured['onError']).toBeTypeOf('function'))

    expect(screen.queryByRole('alert')).toBeNull()
    act(() => {
      ;(captured['onError'] as (g: number, m: string) => void)(0, 'the shelf stopped answering')
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the shelf stopped answering')

    /* AND IT CAN BE PUT AWAY, so a transient failure does not sit over the book
       for the rest of the session. */
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    vi.doUnmock('../../kernel/ui/reader/FoliateView')
    vi.resetModules()
  })

  it('turns the page from a tap on the book, and lets go of the document after', async () => {
    const { content } = shelf({ ext: 'epub' })
    const seen: string[] = []
    const nav = {
      next: () => seen.push('next'),
      prev: () => seen.push('prev'),
      goLeft: () => seen.push('goLeft'),
      goRight: () => seen.push('goRight'),
    }

    const captured: Record<string, unknown> = {}
    vi.doMock('../../kernel/ui/reader/FoliateView', () => ({
      FoliateView: (props: Record<string, unknown>) => {
        Object.assign(captured, props)
        return null
      },
    }))
    vi.resetModules()
    const { Reader: Fresh } = await import('./Reader')
    render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />)
    await waitFor(() => expect(captured['onDocument']).toBeTypeOf('function'))
    ;(captured['onNavigator'] as (g: number, n: unknown) => void)(0, nav)

    /* A book document, 300px wide, as foliate would hand one over. */
    const doc = document.implementation.createHTMLDocument('a section')
    Object.defineProperty(doc.documentElement, 'clientWidth', { value: 300, configurable: true })
    const watch = captured['onDocument'] as (g: number, d: Document | null) => void
    watch(0, doc)

    const tapAt = (x: number, target: Element = doc.body) => {
      target.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: 100, bubbles: true }))
      target.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: 100, bubbles: true }))
    }

    tapAt(10)
    tapAt(290)
    tapAt(150)
    expect(seen, 'the outer thirds turn, the middle does not').toEqual(['goLeft', 'goRight'])

    /* A LINK WINS — foliate is already handling it, and turning as well would
       leave the reader somewhere they did not choose. */
    const link = doc.createElement('a')
    link.href = '#somewhere'
    doc.body.append(link)
    seen.length = 0
    tapAt(290, link)
    expect(seen).toEqual([])

    /**
     * ⚠️ **A RELEASE WITH NO PRESS IS NOT A TAP**, and it used to be the best
     * possible one: `moved` fell back to `0`, which is a clean tap in the
     * middle of the target it landed on. A release that entered the stage from
     * outside, or arrived after the listener was attached mid-gesture, turned
     * the page.
     */
    seen.length = 0
    doc.body.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 100, bubbles: true }))
    expect(seen, 'a pointerup with no matching pointerdown must do nothing').toEqual([])

    /**
     * AND A SECOND FINGER DOES NOT STEAL THE FIRST'S ORIGIN.
     *
     * The press was tracked as a bare coordinate, so a second `pointerdown`
     * overwrote it — and the first finger's release was then measured from the
     * second's position. A pinch that happens to end near an edge read as a
     * tap there.
     */
    seen.length = 0
    doc.body.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 150, clientY: 100, bubbles: true }),
    )
    doc.body.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 2, clientX: 290, clientY: 100, bubbles: true }),
    )
    doc.body.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 2, clientX: 290, clientY: 100, bubbles: true }),
    )
    expect(seen, "the second finger's release is not the first finger's tap").toEqual([])

    /* `pointercancel` IS THE BROWSER TAKING THE GESTURE OVER, and no
       `pointerup` follows it — so an origin left behind waits to be paired with
       an unrelated release. */
    seen.length = 0
    doc.body.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 3, clientX: 290, clientY: 100, bubbles: true }),
    )
    doc.body.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 3, bubbles: true }))
    doc.body.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 3, clientX: 290, clientY: 100, bubbles: true }),
    )
    expect(seen, 'a cancelled gesture must not turn the page').toEqual([])

    /* AND THE CONTROLS A BOOK MAY CARRY. The list was `a, button, input,
       [role="button"]`; a book is a document a stranger wrote, and choosing
       from a `<select>` inside one turned the page at the same time. */
    seen.length = 0
    for (const tag of ['select', 'textarea', 'summary']) {
      const control = doc.createElement(tag)
      doc.body.append(control)
      tapAt(290, control)
    }
    expect(seen, 'interacting with a control must not also turn the page').toEqual([])

    /* AND THE DOCUMENT IS RELEASED. `onDocument(null)` is the teardown; a tap
       after it must reach nothing. */
    watch(0, null)
    seen.length = 0
    tapAt(10)
    expect(seen, 'the listener must be gone with the document').toEqual([])

    vi.doUnmock('../../kernel/ui/reader/FoliateView')
    vi.resetModules()
  })

  /**
   * ⚠️ **NO TAP IN AN EPUB 3 BOOK TURNED A PAGE.**
   *
   * The control list held a bare `[role]`, on the reasoning that a role is
   * only ever put on something meant to be interacted with. EPUB 3 puts one
   * on every chapter: `<section role="doc-chapter">` is the structural
   * semantics inflection the spec recommends, and `epub:type="chapter"` is
   * mapped to it by every current authoring tool. `closest` walked up from
   * the tapped paragraph to that section, found a role, and refused — so a
   * book that followed the spec could be opened and never advanced.
   *
   * The widget roles are the ones a press already belongs to; a document role
   * names what the text IS, and a tap on prose is a tap on prose.
   */
  it('turns the page from a tap inside a chapter that carries a role, and not on a widget', async () => {
    const { content } = shelf({ ext: 'epub' })
    const seen: string[] = []
    const nav = {
      next: () => seen.push('next'),
      prev: () => seen.push('prev'),
      goLeft: () => seen.push('goLeft'),
      goRight: () => seen.push('goRight'),
    }

    const captured: Record<string, unknown> = {}
    vi.doMock('../../kernel/ui/reader/FoliateView', () => ({
      FoliateView: (props: Record<string, unknown>) => {
        Object.assign(captured, props)
        return null
      },
    }))
    vi.resetModules()
    const { Reader: Fresh } = await import('./Reader')
    render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />)
    await waitFor(() => expect(captured['onDocument']).toBeTypeOf('function'))
    ;(captured['onNavigator'] as (g: number, n: unknown) => void)(0, nav)

    const doc = document.implementation.createHTMLDocument('a chapter')
    Object.defineProperty(doc.documentElement, 'clientWidth', { value: 300, configurable: true })
    ;(captured['onDocument'] as (g: number, d: Document | null) => void)(0, doc)

    const tapAt = (x: number, target: Element) => {
      target.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: 100, bubbles: true }))
      target.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: 100, bubbles: true }))
    }

    /* The shape EPUB 3 prescribes and the tools produce: the whole chapter
       under one roled section, the reader's finger on a paragraph inside it. */
    const chapter = doc.createElement('section')
    chapter.setAttribute('role', 'doc-chapter')
    const paragraph = doc.createElement('p')
    paragraph.textContent = 'Call me Ishmael.'
    chapter.append(paragraph)
    doc.body.append(chapter)

    tapAt(290, paragraph)
    tapAt(10, paragraph)
    expect(seen, 'a tap on prose inside a roled chapter is a page turn').toEqual(['goRight', 'goLeft'])

    /* AND A WIDGET INSIDE THAT SAME CHAPTER STILL WINS. The narrowing must
       not have thrown the widget roles out with the document ones. */
    seen.length = 0
    for (const role of ['button', 'link', 'checkbox', 'textbox', 'slider']) {
      const widget = doc.createElement('div')
      widget.setAttribute('role', role)
      chapter.append(widget)
      tapAt(290, widget)
    }
    expect(seen, 'a tap on an ARIA widget must not also turn the page').toEqual([])

    ;(captured['onDocument'] as (g: number, d: Document | null) => void)(0, null)
    vi.doUnmock('../../kernel/ui/reader/FoliateView')
    vi.resetModules()
  })
})

/**
 * ⚠️ **A FOOTNOTE LINK DID NOTHING AT ALL ON THIS SURFACE.**
 *
 * `ReaderSession` intercepts a note's link — `preventDefault`, so foliate does
 * not navigate — renders the note into a view of its own, and parks that view
 * off screen until a host says where to put it. This surface passed `ignore` to
 * `onFootnote` and never said, so a reader tapping a superscript got no
 * navigation, no note, and nothing to dismiss. The extraction had worked and it
 * was rendered a hundred thousand pixels to the left.
 */
describe('a note the reader taps', () => {
  /* ⚠️ **THE POPOVER MEASURES THE NOTE'S OWN DOCUMENT** — it polls
   * `view.renderer.getContents()[0].doc.body.scrollHeight` and stays invisible
   * until that is above zero, because a box sized before the note has laid out
   * is a box sized wrong. A bare element reports nothing and the note never
   * appears, which is indistinguishable from the defect under test. */
  const note = {
    view: Object.assign(document.createElement('div'), {
      renderer: { getContents: () => [{ doc: { body: { scrollHeight: 44 } } }] },
    }),
    href: 'notes.xhtml#n1',
    type: 'footnote',
    at: null,
  }

  it('is given somewhere to render, and somewhere to be shown', async () => {
    const { content } = shelf({ ext: 'epub' })
    const mounts: (HTMLElement | null)[] = []
    const captured = await withView((Fresh) =>
      render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />),
    )
    await waitFor(() => expect(captured['onNavigator']).toBeTypeOf('function'))

    /* THE SESSION'S SIDE, as the real navigator presents it. */
    ;(captured['onNavigator'] as (g: number, n: unknown) => void)(0, {
      next: () => {},
      prev: () => {},
      goLeft: () => {},
      goRight: () => {},
      goTo: () => {},
      search: async function* () {},
      setFootnoteMount: (mount: HTMLElement | null) => mounts.push(mount),
      closeFootnote: () => mounts.push(null),
    })

    /* ⚠️ **THE MOUNT IS THE WHOLE FIX.** Without it the session renders the note
       into its own off-screen fallback and the reader sees nothing — which is
       exactly what `ignore` produced. */
    await waitFor(() =>
      expect(
        mounts.filter((one) => one !== null).length,
        'nothing told the session where to render a note',
      ).toBeGreaterThan(0),
    )
  })

  it('is drawn once the session says it has rendered one', async () => {
    const { content } = shelf({ ext: 'epub' })
    const captured = await withView((Fresh) =>
      render(<Fresh content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} positions={fakePositions()} />),
    )
    await waitFor(() => expect(captured['onFootnote']).toBeTypeOf('function'))

    /* NOT `ignore`. The prop used to be a function that returns, which is
       indistinguishable from this one until you look at what appears. */
    await act(async () => {
      ;(captured['onFootnote'] as (n: unknown) => void)(note)
    })
    expect(
      document.querySelector('[data-footnote]') ?? screen.queryByRole('dialog'),
      'the note was rendered and nowhere on this screen shows it',
    ).not.toBeNull()
  })
})
