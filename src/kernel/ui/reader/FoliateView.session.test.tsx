// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SPACING } from '../../core/metrics'

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
    started: unknown[]
    deps: Record<string, unknown>[]
    disposed: number
    settings: number
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
        started: [] as unknown[],
        deps: [] as Record<string, unknown>[],
        disposed: 0,
        settings: 0,
      }
      constructor() {
        sessions.built.push(this.own)
      }
      start(source: unknown, deps: Record<string, unknown>) {
        this.own.started.push(source)
        this.own.deps.push(deps)
        return new Promise<void>((resolve) => {
          sessions.finish = resolve
        })
      }
      dispose() {
        this.own.disposed += 1
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
      get view() {
        return sessions.view
      }
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

  it('remembers a resize that lands before the book has a renderer', () => {
    stageHeight = 600
    render(<FoliateView {...props({ ...callbacks(), file: book() })} />)
    stageHeight = 700
    expect(() => observers[0]?.callback()).not.toThrow()

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
