// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { DEFAULT_SPACING } from '../../core/metrics'
import { markPalette, noteSheets } from './bookCss'

/**
 * WHAT THE COMPONENT DOES WITH A BOOK — the half `FoliateView.test.tsx` cannot
 * reach.
 *
 * ## Why this file exists
 *
 * ⚠️ **EVERY TEST NEXT DOOR PASSES `file: null`**, and with no file
 * `FoliateView` never builds a `ReaderSession` at all. So "survives every
 * reading setting changing under it" and "takes a changing set of marks without
 * reopening the book" re-rendered a component that had nothing open: the
 * settings path, the marks path, the generation guard and the teardown were all
 * skipped, and the assertion left — that `onError` was never called — is true of
 * a component that does nothing whatsoever.
 *
 * ⚠️ **AND THE MID-STARTUP UNMOUNT TEST CONTROLLED NOTHING.** Startup is a chain
 * of awaits behind a dynamic import; unmounting "during" it meant unmounting at
 * whatever moment the event loop happened to be at, which in jsdom is usually
 * before the import has even resolved. It asserted that a synchronous `unmount`
 * did not throw, which is the one part of that race that was never in doubt.
 *
 * ## Why the session is a stand-in
 *
 * A real `ReaderSession` cannot open a book in jsdom — foliate's `View` is a
 * custom element and there is no layout to paginate into — and its own races
 * are proven in `session.test.ts` without React in the way. What is under test
 * HERE is the component's side of the contract: that it builds a session for a
 * file, hands settings changes to the open one rather than replacing it, and
 * disposes exactly one per book however the tree comes down.
 *
 * A stand-in whose `start` never resolves is what makes "mid-startup" a state
 * the test chooses rather than a moment it hopes for.
 */

const sessions = vi.hoisted(() => ({
  built: [] as {
    callbacks: Record<string, (...args: unknown[]) => unknown>
    finish: () => void
    fail: (cause: unknown) => void
    redraws: number
    started: unknown[]
    deps: Record<string, unknown>[]
    disposed: number
    settings: number
    /** Whether the host was still in the document at each `dispose`. */
    hostConnectedAtDispose: boolean[]
  }[],
  /** Held open until a test settles it — this is what "mid-startup" means. */
  finish: null as null | (() => void),
  /** What `session.view` answers; null, as during startup, unless a test sets it. */
  view: null as null | { renderer: unknown },
}))

vi.mock('./session', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...real,
    ReaderSession: class {
      readonly own = {
        callbacks: {} as Record<string, (...args: unknown[]) => unknown>,
        finish: () => {},
        fail: (_cause: unknown) => {},
        redraws: 0,
        started: [] as unknown[],
        deps: [] as Record<string, unknown>[],
        disposed: 0,
        settings: 0,
        hostConnectedAtDispose: [] as boolean[],
      }
      readonly host: HTMLElement
      disposed = false
      constructor(host: HTMLElement, callbacks: Record<string, (...args: unknown[]) => unknown>) {
        this.host = host
        this.own.callbacks = callbacks
        sessions.built.push(this.own)
      }
      start(source: unknown, deps: Record<string, unknown>) {
        this.own.started.push(source)
        this.own.deps.push(deps)
        return new Promise<void>((resolve, reject) => {
          sessions.finish = resolve
          this.own.finish = resolve
          this.own.fail = reject
        })
      }
      dispose() {
        this.disposed = true
        this.own.disposed += 1
        this.own.hostConnectedAtDispose.push(this.host.isConnected)
      }
      /* The surface `FoliateView` reaches for while a book is open. Counting
         the settings calls is how "handed to the open session" is told apart
         from "the session was replaced". */
      applySettings() {
        this.own.settings += 1
      }
      applyVars() {}
      setFootnoteMount() {}
      closeFootnote() {}
      drawMarks() {}
      redraw() {}
      redrawMarks() {
        this.own.redraws += 1
      }
      get view() {
        return sessions.view
      }
    },
  }
})

/* What the lazily imported pieces are, so a test can see what was handed on. */
const lazy = vi.hoisted(() => ({
  overlayer: {
    highlight: (..._args: unknown[]): unknown => 'painted',
    underline: () => 'underline',
    squiggly: () => 'wave',
  },
  balanced: [] as unknown[][],
  pdfHooks: [] as Record<string, (...args: unknown[]) => unknown>[],
  sheets: [] as { name: string; reason: string; onSubmit: (password: string) => void }[],
}))

vi.mock('foliate-js/overlayer.js', () => ({ Overlayer: lazy.overlayer }))
vi.mock('./markGeometry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  balanceRects: (...args: unknown[]) => {
    lazy.balanced.push(args)
    return ['balanced']
  },
}))
/* FoliateView takes only a type from makePdf statically; the real module
   loads pdf.js, which needs a browser this environment does not have. */
vi.mock('./makePdf', () => ({
  makePdf: (_input: unknown, hooks: Record<string, (...args: unknown[]) => unknown>) => {
    lazy.pdfHooks.push(hooks)
    return 'a PDF book'
  },
}))
vi.mock('../overlays/PasswordSheet', async () => {
  const { createElement } = await import('react')
  return {
    PasswordSheet: (sheet: (typeof lazy.sheets)[number]) => {
      lazy.sheets.push(sheet)
      return createElement('div', { role: 'dialog', 'aria-label': sheet.reason })
    },
  }
})

const { FoliateView } = await import('./FoliateView')

const callbacks = () => ({
  onToc: vi.fn(),
  onRelocate: vi.fn(),
  onDocument: vi.fn(),
  onMeta: vi.fn(),
  onCover: vi.fn(),
  onError: vi.fn(),
  onNavigator: vi.fn(),
  onSelection: vi.fn(),
  onMarkDrawn: vi.fn(),
  onLink: vi.fn(),
  onExternalLink: vi.fn(),
  onFootnote: vi.fn(),
  onPlate: vi.fn(),
  onLength: vi.fn(),
  onFileDropped: vi.fn(),
  onPageIntent: vi.fn(),
  onFixedLayout: vi.fn(),
  onDirection: vi.fn(),
})

/**
 * A full prop set, with `over` applied.
 *
 * Cast at the end rather than annotated per field: `over` is a loose record so
 * a test can vary any prop, and the component's own type is what the cast
 * restores. `FoliateView.test.tsx` spells the base out the same way.
 */
const props = (over: Record<string, unknown> = {}): ComponentProps<typeof FoliateView> =>
  ({
  lastLocation: null,
  file: null,
  generation: 0,
  stepIdx: 6,
  measure: 700,
  pageMargins: 20,
  theme: 'paper' as const,
  typeface: 'literata',
  spacing: DEFAULT_SPACING,
  align: 'justified' as const,
  brightness: 0,
  contrast: 0,
  animated: true,
  paginated: true,
  style: {},
  marks: [],
  palette: {},
  ...over,
  }) as unknown as ComponentProps<typeof FoliateView>

const book = (name = 'Moby-Dick.epub') => new File(['PK'], name)

/**
 * jsdom has no `ResizeObserver`; this one records what it was asked to watch
 * and lets a test deliver the notification by hand.
 */
const observers: { callback: () => void; observed: Element[]; disconnected: boolean }[] = []
class RecordingObserver {
  readonly own: (typeof observers)[number]
  constructor(callback: () => void) {
    this.own = { callback, observed: [], disconnected: false }
    observers.push(this.own)
  }
  observe(target: Element) {
    this.own.observed.push(target)
  }
  unobserve() {}
  disconnect() {
    this.own.disconnected = true
  }
}

/** The stage's height as jsdom will report it — jsdom has no layout. */
let stageHeight = 0
const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')

beforeEach(() => {
  lazy.balanced = []
  lazy.pdfHooks = []
  lazy.sheets = []
  sessions.built = []
  sessions.finish = null
  sessions.view = null
  observers.length = 0
  stageHeight = 0
  vi.stubGlobal('ResizeObserver', RecordingObserver)
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get: () => stageHeight,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (realClientHeight) Object.defineProperty(Element.prototype, 'clientHeight', realClientHeight)
})

describe('a book that is open', () => {
  it('builds a session for a file, and none without one', () => {
    render(<FoliateView {...props({ ...callbacks() })} />)
    expect(sessions.built, 'no file, nothing to open').toHaveLength(0)

    cleanup()
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    expect(sessions.built, 'a file must reach a session').toHaveLength(1)
    expect(sessions.built[0]?.started).toHaveLength(1)
  })

  /**
   * ⚠️ **A SETTINGS CHANGE MUST NOT REOPEN THE BOOK**, which is the whole reason
   * every settings prop travels through refs and an update effect rather than
   * through the session's identity. Reopening loses the reading position.
   *
   * Next door this was re-rendered with `file: null`, so there was no session to
   * replace and the assertion held vacuously.
   */
  it('hands every reading setting to the session it already has', () => {
    const spies = callbacks()
    const file = book()
    const { rerender } = render(<FoliateView {...props({ ...spies, file })} />)
    expect(sessions.built).toHaveLength(1)

    for (const change of [
      { theme: 'night' as const },
      { typeface: 'crimson' },
      { stepIdx: 9 },
      { measure: 420, pageMargins: 24 },
      { align: 'ragged' as const },
      { brightness: 0.8, contrast: 1.2 },
      { paginated: false },
      { animated: false },
      { spacing: { ...DEFAULT_SPACING, line: 3 } },
    ]) {
      rerender(<FoliateView {...props({ ...spies, file, ...change })} />)
    }

    expect(sessions.built, 'a settings change reopened the book').toHaveLength(1)
    expect(sessions.built[0]?.disposed, 'and it must not have been torn down').toBe(0)
    expect(spies.onError).not.toHaveBeenCalled()
  })

  /* MARKS ARRIVE LATE and change often — they are drawn onto a book that is
     already open, so a new array must not reopen anything either. */
  it('takes a changing set of marks without reopening the book', () => {
    const spies = callbacks()
    const file = book()
    const { rerender } = render(<FoliateView {...props({ ...spies, file })} />)
    rerender(
      <FoliateView
        {...props({
          ...spies,
          file,
          marks: [{ id: 'm1', cfi: 'epubcfi(/6/4!/4/2)', kind: 'highlight' }],
        })}
      />,
    )
    rerender(<FoliateView {...props({ ...spies, file, marks: [] })} />)

    expect(sessions.built, 'a new marks array reopened the book').toHaveLength(1)
    expect(spies.onError).not.toHaveBeenCalled()
  })

  /* A NEW BOOK IS A NEW SESSION, and the old one goes. Otherwise the previous
     book's view, iframes and listeners stay alive behind the new one. */
  it('replaces the session when the book changes, disposing the old one', () => {
    const spies = callbacks()
    const { rerender } = render(
      <FoliateView {...props({ ...spies, file: book('One.epub'), generation: 1 })} />,
    )
    rerender(<FoliateView {...props({ ...spies, file: book('Two.epub'), generation: 2 })} />)

    expect(sessions.built, 'a second book must get its own session').toHaveLength(2)
    expect(sessions.built[0]?.disposed, 'the first book was left running').toBe(1)
    expect(sessions.built[1]?.disposed).toBe(0)
  })

  /**
   * ⚠️ **THE GENERATION IS WHAT REOPENS THE SAME FILE.** Re-reading a book the
   * reader just closed, or retrying one that failed to open, hands back the
   * IDENTICAL `File` object — so `file` alone cannot see it, and without the
   * generation in the effect's dependencies the second open silently does
   * nothing at all. The test above cannot say this: two different books are two
   * different `File`s, and `file` alone is enough for that.
   */
  it('reopens the same file when the generation moves', () => {
    const spies = callbacks()
    const same = book()
    const { rerender } = render(<FoliateView {...props({ ...spies, file: same, generation: 1 })} />)
    expect(sessions.built).toHaveLength(1)

    /* THE SAME OBJECT, deliberately. */
    rerender(<FoliateView {...props({ ...spies, file: same, generation: 2 })} />)
    expect(sessions.built, 'the same book asked for again was never reopened').toHaveLength(2)
    expect(sessions.built[0]?.disposed, 'and the first attempt was left running').toBe(1)
  })

  /* AND A RENDER THAT CHANGES NEITHER REOPENS NOTHING — the other half, which
     is what stops the fix above from being "reopen on every render". */
  it('reopens nothing when neither the file nor the generation moves', () => {
    const spies = callbacks()
    const same = book()
    const { rerender } = render(<FoliateView {...props({ ...spies, file: same, generation: 1 })} />)
    rerender(<FoliateView {...props({ ...spies, file: same, generation: 1 })} />)
    rerender(<FoliateView {...props({ ...spies, file: same, generation: 1 })} />)
    expect(sessions.built).toHaveLength(1)
  })
})

describe('unmounting while the book is still opening', () => {
  /**
   * ⚠️ **"MID-STARTUP" IS NOW A STATE THE TEST CHOOSES.** Next door it was
   * whatever moment the event loop happened to be at, which in jsdom is before
   * the dynamic import has even resolved — so the race the case is named for
   * was never entered. `start` is held open here, so the unmount lands squarely
   * inside it.
   */
  it('disposes the session it built, exactly once', () => {
    const { unmount } = render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    expect(sessions.built).toHaveLength(1)
    expect(sessions.built[0]?.disposed, 'nothing should be disposed while it is opening').toBe(0)

    expect(() => unmount()).not.toThrow()
    expect(sessions.built[0]?.disposed, 'a session outlived the component that built it').toBe(1)
  })

  /* AND THE START THAT LANDS AFTERWARDS IS NOT A CRASH. The promise settles
     into a tree that is already gone; an unhandled rejection there takes the
     whole app down rather than one book. */
  it('survives the open landing after the component has gone', async () => {
    const spies = callbacks()
    const { unmount } = render(<FoliateView {...props({ ...spies, file: book() })} />)
    unmount()

    sessions.finish?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spies.onError).not.toHaveBeenCalled()
    expect(sessions.built[0]?.disposed).toBe(1)
  })
})

describe('closing the book', () => {
  /**
   * ⚠️ **THE SESSION IS DISPOSED WHILE ITS HOST IS STILL IN THE DOCUMENT.**
   * Disposing runs foliate's teardown, and foliate's `View.destroy` stops
   * watching the section by reading `iframe.contentDocument` — which is null
   * once the iframe has left the document. Disposed from a passive effect,
   * React had already removed the host: the observer was never unobserved,
   * fired on the dead iframe, and `View.expand()` threw a TypeError on
   * `null.documentElement` on every close.
   */
  it('disposes before the host leaves the document', () => {
    const { unmount } = render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    unmount()
    expect(sessions.built[0]?.hostConnectedAtDispose).toEqual([true])
  })
})

describe('the figure cap follows the page', () => {
  const figureCap = (doc: Document) => doc.documentElement.style.getPropertyValue('--paper-figure-height')
  const openDoc = () => document.implementation.createHTMLDocument('section')

  /* STARTUP READS THE STAGE AS IT IS. The first section is written to through
     `applyVars`, so the height has to be known before the book opens. */
  it('hands the measured page height to every document the session writes to', () => {
    stageHeight = 600
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    const deps = sessions.built[0]?.deps[0] as { applyVars: (doc: Document) => void }
    const doc = openDoc()
    deps.applyVars(doc)
    expect(figureCap(doc)).toBe('570px')
  })

  it('watches its own stage, and stops when it goes', () => {
    const { container, unmount } = render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    expect(observers).toHaveLength(1)
    expect(observers[0]?.observed).toEqual([container.firstElementChild])
    unmount()
    expect(observers[0]?.disconnected).toBe(true)
  })

  /**
   * ⚠️ **A RESIZE REWRITES THE CAP ON THE OPEN DOCUMENTS**, and only the cap's
   * variables — no settings effect re-runs. The cap was `95vh`, which tracked
   * the window for free and fed a ResizeObserver loop in scrolled flow; a pixel
   * cap does not track anything, so this is what keeps it a share of the page.
   */
  it('rewrites the cap when the page changes height, and not when it does not', () => {
    stageHeight = 600
    const doc = openDoc()
    sessions.view = { renderer: { getContents: () => [{ doc }] } }
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)

    stageHeight = 900
    observers[0]?.callback()
    expect(figureCap(doc)).toBe('855px')

    /* A width change notifies too, and the cap does not read width. */
    doc.documentElement.style.setProperty('--paper-figure-height', 'untouched')
    observers[0]?.callback()
    expect(figureCap(doc)).toBe('untouched')
  })

  /* THE SESSION'S OWN SETTINGS PASS CARRIES THE HEIGHT TOO — it is what
     writes the sections already on screen when the book first lays out. */
  it('hands the measured page height to the settings pass the session runs', () => {
    stageHeight = 600
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    const deps = sessions.built[0]?.deps[0] as { applySettings: (view: unknown) => void }
    const doc = openDoc()
    deps.applySettings({
      renderer: { setAttribute() {}, getAttribute: () => null, toggleAttribute() {}, getContents: () => [{ doc }] },
    })
    expect(figureCap(doc)).toBe('570px')
  })

  it('takes a resize with no book open', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<FoliateView {...props({ ...callbacks() })} />)
    stageHeight = 700
    expect(() => observers[0]?.callback()).not.toThrow()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('remembers a resize that lands before the book has a renderer', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    stageHeight = 600
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    stageHeight = 700
    expect(() => observers[0]?.callback()).not.toThrow()
    expect(error, 'nothing to write to is not a failure').not.toHaveBeenCalled()
    error.mockRestore()

    const deps = sessions.built[0]?.deps[0] as { applyVars: (doc: Document) => void }
    const doc = openDoc()
    deps.applyVars(doc)
    expect(figureCap(doc)).toBe('665px')
  })

  /* A RENDERER THAT THROWS MID-RESIZE IS LOGGED, NOT LET LOOSE. The callback
     runs outside React, so an exception there would surface as an uncaught
     error at the window with nothing to say which book it belonged to. */
  it('logs a resize it could not apply instead of throwing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    sessions.view = {
      renderer: {
        getContents: () => {
          throw new Error('gone')
        },
      },
    }
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    stageHeight = 500
    expect(() => observers[0]?.callback()).not.toThrow()
    expect(error).toHaveBeenCalledWith('Paper: resizing the figure cap failed', expect.any(Error))
    error.mockRestore()
  })
})

/** The one session built so far, which every test below opens exactly one of. */
const only = (at = 0) => {
  const built = sessions.built[at]
  if (!built) throw new Error(`no session ${at} was built`)
  return built
}
const depsOf = <T,>(at = 0) => only(at).deps[0] as T
const sectionDoc = () => document.implementation.createHTMLDocument('section')
const fakeRenderer = (doc: Document) => ({
  setAttribute() {},
  getAttribute: () => null,
  toggleAttribute() {},
  getContents: () => [{ doc }],
})
const figureCapOf = (doc: Document) => doc.documentElement.style.getPropertyValue('--paper-figure-height')

describe('what the session is told', () => {
  /* EVERY CALLBACK READS THE HANDLERS OF THE LATEST RENDER, and the ones that
     belong to a book say which generation it was. */
  it('forwards every event to the latest handlers, with the generation where one is owed', () => {
    const first = callbacks()
    const file = book()
    const { rerender } = render(<FoliateView {...props({ ...first, file, generation: 3 })} />)
    const latest: Record<string, ReturnType<typeof vi.fn>> = callbacks()
    rerender(<FoliateView {...props({ ...latest, file, generation: 3 })} />)
    const told = only().callbacks
    const a = { one: 1 }
    const b = { two: 2 }
    for (const name of ['onToc', 'onRelocate', 'onMeta', 'onCover', 'onError', 'onNavigator', 'onLength', 'onFixedLayout', 'onDirection']) {
      told[name]?.(a)
      expect(latest[name], name).toHaveBeenCalledWith(3, a)
    }
    told.onDocument?.(a, 7)
    expect(latest.onDocument).toHaveBeenCalledWith(3, a, 7)
    for (const name of ['onSelection', 'onFootnote', 'onPlate', 'onFileDropped', 'onPageIntent']) {
      told[name]?.(a)
      expect(latest[name], name).toHaveBeenCalledWith(a)
    }
    for (const name of ['onMarkDrawn', 'onLink', 'onExternalLink']) {
      told[name]?.(a, b)
      expect(latest[name], name).toHaveBeenCalledWith(a, b)
    }
    for (const spy of Object.values(first)) expect(spy).not.toHaveBeenCalled()
  })

  it('reads the marks, the overlays and the palette as they are now', () => {
    const file = book()
    const marks = [{ id: 'first' }]
    const { rerender } = render(<FoliateView {...props({ ...callbacks(), file, marks })} />)
    const told = only().callbacks
    expect(told.getMarks?.()).toBe(marks)
    expect(told.getOverlays?.(), 'no overlays is an empty list').toEqual([])

    const later = [{ id: 'later' }]
    const overlays = [{ id: 'overlay' }]
    rerender(
      <FoliateView
        {...props({ ...callbacks(), file, marks: later, overlays, theme: 'night', brightness: 0.5, contrast: 1.1 })}
      />,
    )
    expect(told.getMarks?.()).toBe(later)
    expect(told.getOverlays?.()).toBe(overlays)
    expect(told.getPalette?.()).toEqual(markPalette('night', 0.5, 1.1))
  })
})

describe('what the session is handed to start with', () => {
  it('hands it foliate’s painters, with a fill moved onto the words first', async () => {
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    const painters = await depsOf<{ loadPainters: () => Promise<Record<string, unknown>> }>().loadPainters()
    expect(painters.underline).toBe(lazy.overlayer.underline)
    expect(painters.wave).toBe(lazy.overlayer.squiggly)

    const fill = painters.fill as (rects: unknown, options?: Record<string, unknown>) => unknown
    const doc = sectionDoc()
    const options = { doc, at: 'the range' }
    const highlight = vi.spyOn(lazy.overlayer, 'highlight')
    expect(fill([{ x: 1 }], options)).toBe('painted')
    expect(lazy.balanced[0]).toEqual([[{ x: 1 }], doc, 'the range'])
    expect(highlight).toHaveBeenCalledWith(['balanced'], options)

    fill([{ x: 2 }])
    expect(lazy.balanced[1], 'options are optional').toEqual([[{ x: 2 }], null, null])
  })

  it('passes a book straight through, and refuses a ranged source that is not a PDF', async () => {
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    const { prepare } = depsOf<{ prepare: (input: unknown) => Promise<unknown> }>()
    const epub = book()
    await expect(prepare(epub)).resolves.toBe(epub)
    await expect(prepare({ name: 'Moby-Dick.epub', range: () => null })).rejects.toThrow(
      'Paper: Moby-Dick.epub was given a range transport, and only a PDF can be read through one.',
    )
  })

  it('styles a note’s view with the note sheets', () => {
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    const setStyles = vi.fn()
    depsOf<{ styleNote: (view: unknown) => void }>().styleNote({ renderer: { setStyles } })
    expect(setStyles).toHaveBeenCalledWith(noteSheets())
  })
})

describe('a PDF', () => {
  const openPdf = async (input: unknown) => {
    render(<FoliateView {...props({ ...callbacks(), file: book('Ledger.pdf') })} />)
    await expect(depsOf<{ prepare: (input: unknown) => Promise<unknown> }>().prepare(input)).resolves.toBe('a PDF book')
    const hooks = lazy.pdfHooks[0]
    if (!hooks) throw new Error('makePdf was never reached')
    return hooks as { onPagePainted: () => void; password: (reason: string) => Promise<string | null> }
  }

  it('redraws the marks when a page has painted', async () => {
    const hooks = await openPdf(new File(['%PDF'], 'Ledger.pdf', { type: 'application/pdf' }))
    hooks.onPagePainted()
    expect(only().redraws).toBe(1)
  })

  it('asks for a password by the name of what was opened, a file or an address', async () => {
    const hooks = await openPdf('https://example.org/Ledger.pdf')
    act(() => {
      void hooks.password('needed')
    })
    expect(lazy.sheets.at(-1)?.name).toBe('https://example.org/Ledger.pdf')

    cleanup()
    lazy.pdfHooks = []
    sessions.built = []
    const fromFile = await openPdf(new File(['%PDF'], 'Ledger.pdf', { type: 'application/pdf' }))
    act(() => {
      void fromFile.password('needed')
    })
    expect(lazy.sheets.at(-1)?.name).toBe('Ledger.pdf')
  })

  it('answers no password for a book that has already gone', async () => {
    const hooks = await openPdf(new File(['%PDF'], 'Ledger.pdf', { type: 'application/pdf' }))
    cleanup()
    /* Raced against a deadline: an asking that never settles must fail this
       test, not hang it. */
    const unanswered = new Promise((resolve) => setTimeout(() => resolve('never answered'), 50))
    await expect(Promise.race([hooks.password('needed'), unanswered])).resolves.toBeNull()
    expect(lazy.sheets).toHaveLength(0)
  })

  /* A SHEET THAT HAS BEEN REPLACED CANNOT ANSWER FOR THE ONE THAT REPLACED IT. */
  it('ignores an answer from a sheet that is no longer the one asking', async () => {
    const hooks = await openPdf(new File(['%PDF'], 'Ledger.pdf', { type: 'application/pdf' }))
    act(() => {
      void hooks.password('needed')
    })
    const stale = lazy.sheets.at(-1)
    act(() => {
      void hooks.password('wrong')
    })
    act(() => stale?.onSubmit('too late'))
    expect(screen.getByRole('dialog', { name: 'wrong' })).toBeTruthy()
  })
})

describe('when the open settles', () => {
  /* READY COUNTS EACH OPEN THAT FINISHES — and never one a replaced book
     finishes late, which would paint the new book's marks before it can hold
     them. The marks are one list throughout, so only `ready` can re-run the
     effect that draws them. */
  it('counts each open it finishes, and not one a replaced book finishes late', async () => {
    const file = book()
    const marks: unknown[] = []
    const { rerender } = render(<FoliateView {...props({ ...callbacks(), file, marks, generation: 0 })} />)
    rerender(<FoliateView {...props({ ...callbacks(), file, marks, generation: 1 })} />)
    await act(async () => only(0).finish())
    expect(only(1).redraws, 'a disposed open moved ready').toBe(0)

    await act(async () => only(1).finish())
    expect(only(1).redraws).toBe(1)

    rerender(<FoliateView {...props({ ...callbacks(), file, marks, generation: 2 })} />)
    expect(only(2).redraws).toBe(0)
    await act(async () => only(2).finish())
    expect(only(2).redraws, 'a second open must move ready again').toBe(1)
  })

  it('says the reader failed to start when start throws past its own reporting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spies = callbacks()
    render(<FoliateView {...props({ ...spies, file: book(), generation: 4 })} />)
    const cause = new Error('boom')
    await act(async () => only().fail(cause))
    expect(error).toHaveBeenCalledWith('Paper: the reader failed to start', cause)
    expect(spies.onError).toHaveBeenCalledWith(4, 'The reader failed to start.')
    error.mockRestore()
  })

  it('logs, and tells nobody, when the book that failed has gone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spies = callbacks()
    const { unmount } = render(<FoliateView {...props({ ...spies, file: book() })} />)
    unmount()
    const cause = new Error('late')
    await act(async () => only().fail(cause))
    expect(error).toHaveBeenCalledWith('Paper: the reader failed to start', cause)
    expect(spies.onError).not.toHaveBeenCalled()
    error.mockRestore()
  })

  /* A SETTING CHANGES THE OPEN BOOK once it is ready: the variables are
     written to what is on screen and the marks repainted in the new palette. */
  it('re-sets the open book when a setting changes, and not before it is ready', async () => {
    stageHeight = 600
    const doc = sectionDoc()
    sessions.view = { renderer: fakeRenderer(doc) }
    const file = book()
    const marks: unknown[] = []
    const { rerender } = render(<FoliateView {...props({ ...callbacks(), file, marks })} />)
    expect(figureCapOf(doc), 'nothing is written before the open settles').toBe('')

    await act(async () => only().finish())
    expect(figureCapOf(doc)).toBe('570px')

    doc.documentElement.style.removeProperty('--paper-figure-height')
    const redraws = only().redraws
    rerender(<FoliateView {...props({ ...callbacks(), file, marks, theme: 'night' })} />)
    expect(figureCapOf(doc)).toBe('570px')
    expect(only().redraws).toBe(redraws + 1)
  })
})
