import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { View } from 'foliate-js/view.js'
import { ReaderSession, directionOf, readMeta } from './session'
import type { MarkAnchor, MarkPalette, SelectionSnapshot, SessionCallbacks } from './session'
import { buildFixture, elem, txt } from './wordSnap/domFake.testkit'
import { fakeDocument, type FakeDocument } from './wordSnap/documentFake.testkit'
import { selectionOver, type FakeSelection } from './wordSnap/selectionFake.testkit'
import { createReflowGuard } from './wordSnap/invalidate'

/**
 * These are the races the audit found and the earlier fix did not close: a
 * view created after disposal keeping its iframes alive, and a dying view
 * overwriting the state of the book that replaced it. Both are unreachable
 * through the UI by hand, which is why they survived two rounds of review.
 */

function fakeHost(): HTMLElement {
  const host = {
    children: [] as unknown[],
    replaceChildren(...nodes: unknown[]) {
      host.children = nodes
    },
  }
  return host as unknown as HTMLElement
}

interface FakeView extends View {
  closed: number
  removed: number
  listeners: Record<string, ((e: unknown) => void)[]>
  emit: (type: string, detail: unknown) => void
  /** Every addAnnotation call, so the drawing contract can be asserted. */
  annotations: { value: string; kind: string; remove: boolean }[]
  deselected: number
  /** Page turns, so a navigator that cannot turn a page is a failing test. */
  turns: { next: number; prev: number; left: number; right: number }
  /** What each `init` was asked to show — the restore contract, in order. */
  initCalls: (string | null)[]
  /** Writable here so a test can be a PDF; readonly on the real `View`. */
  isFixedLayout: boolean
}

/**
 * The methods the session actually calls on a view.
 *
 * Declared and CHECKED, because the cast at the bottom of `fakeView` erases
 * every guarantee that the fake resembles the real thing. It hid three: the
 * navigator published `next`, `prev` and `search` straight from a view that
 * implemented none of them, so every test passed while the buttons those
 * callbacks are wired to would have thrown on the first click. A structural
 * check here is what makes the fake fail to compile instead.
 */
type ViewCalls = Pick<
  View,
  | 'open'
  | 'init'
  | 'close'
  | 'goTo'
  | 'next'
  | 'prev'
  | 'goLeft'
  | 'goRight'
  | 'search'
  | 'addAnnotation'
  | 'getCFI'
  | 'deselect'
>

function fakeView(overrides: Partial<Record<'open' | 'init', () => Promise<void>>> = {}): FakeView {
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  const view: ViewCalls & Omit<FakeView, keyof View> & Record<string, unknown> = {
    style: {} as CSSStyleDeclaration,
    closed: 0,
    removed: 0,
    turns: { next: 0, prev: 0, left: 0, right: 0 },
    initCalls: [],
    listeners,
    book: { toc: [{ label: 'One', href: 'a.xhtml' }], metadata: { title: 'T', author: 'A' } },
    /* Settable, because the wheel gate reads it: a PDF is fixed-layout and
     * cannot scroll whatever `flow` says. */
    isFixedLayout: false,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      ;(listeners[type] ??= []).push(fn)
    },
    emit: (type: string, detail: unknown) => {
      for (const fn of listeners[type] ?? []) fn({ detail })
    },
    open: overrides.open ?? (() => Promise.resolve()),
    /* Records what it was asked to show before delegating. The restore is only
     * observable here: `init` is the one call that receives the saved position,
     * and a fake that swallowed its argument would let every assertion about
     * restoring pass against a session that never passed it on. */
    init: (options?: { lastLocation?: string | null }) => {
      view.initCalls.push(options?.lastLocation ?? null)
      return (overrides.init ?? (() => Promise.resolve()))()
    },
    goTo: () => Promise.resolve(),
    next: () => {
      view.turns.next += 1
      return Promise.resolve()
    },
    /* Present because `ViewCalls` demands it. They were added to the navigator
     * without being added here, and the cast at the bottom of this fake hid it:
     * every test passed while `book.goLeft()` would have thrown on the first
     * swipe. That is precisely the drift the structural check exists to stop,
     * and it only works if the Pick above lists every method. */
    goLeft: () => {
      view.turns.left += 1
      return Promise.resolve()
    },
    goRight: () => {
      view.turns.right += 1
      return Promise.resolve()
    },
    prev: () => {
      view.turns.prev += 1
      return Promise.resolve()
    },
    search: async function* () {
      return
    },
    annotations: [] as { value: string; kind: string; remove: boolean }[],
    deselected: 0,
    addAnnotation(annotation: unknown, remove = false) {
      view.annotations.push({ ...(annotation as { value: string; kind: string }), remove })
      return Promise.resolve()
    },
    /* Keyed on the RANGE, not only on the section. The old fake ignored its
     * second argument, so a CFI derived from a stale range and one derived from
     * a re-read range produced the same string — and every assertion that the
     * published CFI describes the selection as it stands would have passed
     * either way. Same defect class as the `fakeDoc` note at
     * `markGeometry.test.ts:53`. WI-9 depends on this being keyed; the WI-7
     * publish cases below already do. */
    getCFI: (index: number, range?: Range) => `cfi(${index}:${range?.toString() ?? ''})`,
    deselect() {
      view.deselected += 1
    },
    close() {
      view.closed += 1
    },
    remove() {
      view.removed += 1
    },
    /* Stores what it is given, because the session now READS `flow` back off it
     * to decide whether a wheel gesture is its business. A renderer that
     * forgets its own attributes cannot answer that, and a stub that returned a
     * constant would make the scrolled-flow case untestable. */
    renderer: (() => {
      const attrs = new Map<string, string>()
      return {
        setAttribute: (name: string, value: string) => void attrs.set(name, value),
        getAttribute: (name: string) => attrs.get(name) ?? null,
        toggleAttribute: (name: string, force: boolean) => {
          if (force) attrs.set(name, '')
          else attrs.delete(name)
          return force
        },
        setStyles: () => {},
        /* A scrollport, because for a FIXED-LAYOUT book the renderer element
         * IS one — `foliate-fxl` carries `:host { overflow: auto }`, so a page
         * scaled to the viewport's width overflows it and scrolls. The session
         * reads these three to decide whether a page has further to go.
         *
         * Defaulted to a page that exactly fits, which is the honest neutral:
         * every test written before this one meant "nothing to scroll", and
         * `scrollHeight === clientHeight` is how the DOM says that. */
        scrollTop: 0,
        scrollHeight: 600,
        clientHeight: 600,
      }
    })(),
  }
  return view as unknown as FakeView
}

/* Paper's own three tints. Written out rather than imported from `bookCss` so
   a change to the table shows up here as a decision rather than as a test that
   silently follows it. */
const PALETTE: MarkPalette = {
  fill: { yellow: '#F3E6C0', green: '#D1EED3', purple: '#F2E0FF' },
  rule: { yellow: '#E0BE55', green: '#85D288', purple: '#DDAFFF' },
  companion: '#9E5A16',
}

function callbacks(
  marks: readonly MarkAnchor[] = [],
): SessionCallbacks & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {}
  const rec = (name: string) => (...args: unknown[]) => {
    ;(calls[name] ??= []).push(args)
  }
  /* Annotated rather than cast. `as SessionCallbacks` on the literal below
   * would let a newly-required callback go unimplemented — which it did, and
   * the only signal was a TypeError at runtime in one test. */
  const cb: SessionCallbacks = {
    onToc: rec('onToc'),
    onRelocate: rec('onRelocate'),
    onDocument: rec('onDocument'),
    onMeta: rec('onMeta'),
    onCover: rec('onCover'),
    onError: rec('onError'),
    onNavigator: rec('onNavigator'),
    onSelection: rec('onSelection'),
    onMarkDrawn: rec('onMarkDrawn'),
    onFileDropped: rec('onFileDropped'),
    onPageIntent: rec('onPageIntent'),
    onFixedLayout: rec('onFixedLayout'),
    onDirection: rec('onDirection'),
    getMarks: () => marks,
    getPalette: () => PALETTE,
  }
  return Object.assign(cb, { calls })
}

const painters = { fill: 'FILL', underline: 'UNDERLINE', wave: 'WAVE' }

/** Every value `onSelection` has been handed, in order. Snapshots and nulls
 *  alike, because the nulls are half of what the selection contract says. */
const published = (cb: ReturnType<typeof callbacks>): (SelectionSnapshot | null)[] =>
  (cb.calls['onSelection'] ?? []).map((args) => args[0] as SelectionSnapshot | null)

const deps = (view: View) => ({
  createView: () => Promise.resolve(view),
  loadPainters: () => Promise.resolve(painters),
  applySettings: () => {},
})

describe('ReaderSession disposal', () => {
  it('opens normally and publishes toc, metadata and a navigator', async () => {
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    expect(cb.calls['onToc']).toHaveLength(1)
    expect(cb.calls['onMeta']?.[0]?.[0]).toMatchObject({ title: 'T', author: 'A' })
    const nav = cb.calls['onNavigator']?.[0]?.[0] as {
      goTo: unknown
      search: unknown
      next: () => void
      prev: () => void
      goLeft: () => void
      goRight: () => void
    }
    expect(nav.goTo).toBeTypeOf('function')
    expect(nav.search).toBeTypeOf('function')

    /* Called, not merely present. These are what the arrow keys and the wheel
     * gesture are wired to, and a published callback that throws on the first
     * press is the failure this exercises — which is exactly what `goLeft` and
     * `goRight` would have done, having been added to the navigator and to
     * nothing else. */
    nav.next()
    nav.prev()
    nav.goLeft()
    nav.goRight()
    expect(view.turns).toEqual({ next: 1, prev: 1, left: 1, right: 1 })

    expect(view.closed).toBe(0)
    expect(session.view).toBe(view)
  })

  it('closes a view that is created AFTER disposal', async () => {
    // The exact leak: cleanup runs while the dynamic import is still pending,
    // so the view arrives with nothing left to close it.
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks())
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))

    const started = session.start('book.epub', {
      createView: async () => {
        await gate
        return view
      },
      loadPainters: () => Promise.resolve(painters),
      applySettings: () => {},
    })

    session.dispose()
    release()
    await started

    expect(view.closed).toBe(1)
    expect(session.view).toBeNull()
  })

  /**
   * A promise that settles when the fake reaches the method under test.
   *
   * Counting microtask flushes does not work here and is not obviously wrong
   * when it fails: `start` awaits `Promise.allSettled`, which needs more turns
   * than the one or two these tests used to spend, so disposal landed BEFORE
   * `open` was ever called. Both tests passed — proving only what the
   * already-covered pre-open case proves, while claiming to cover the race
   * after it. Waiting on entry into the method is exact whatever the internals
   * do, and the call assertion below makes a regression to vacuity fail. */
  function entered(): { reached: Promise<void>; enter: () => void } {
    let enter: () => void = () => {}
    const reached = new Promise<void>((resolve) => (enter = resolve))
    return { reached, enter }
  }

  it('closes a view when disposal lands mid-open', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const open = entered()
    let opens = 0
    const view = fakeView({
      open: () => {
        opens += 1
        open.enter()
        return gate
      },
    })
    const session = new ReaderSession(fakeHost(), callbacks())

    const started = session.start('book.epub', deps(view))
    await open.reached
    session.dispose()
    release()
    await started

    expect(opens).toBe(1)
    expect(view.closed).toBe(1)
  })

  it('closes a view when disposal lands mid-init', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const init = entered()
    let inits = 0
    const view = fakeView({
      init: () => {
        inits += 1
        init.enter()
        return gate
      },
    })
    const session = new ReaderSession(fakeHost(), callbacks())

    const started = session.start('book.epub', deps(view))
    await init.reached
    session.dispose()
    release()
    await started

    expect(inits).toBe(1)
    expect(view.closed).toBe(1)
  })

  it('never closes twice, however many times dispose is called', async () => {
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks())
    await session.start('book.epub', deps(view))

    session.dispose()
    session.dispose()
    session.dispose()

    expect(view.closed).toBe(1)
  })

  it('ignores load and relocate from a disposed view', async () => {
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    const docsBefore = cb.calls['onDocument']?.length ?? 0
    session.dispose()
    view.emit('load', { doc: {} })
    view.emit('relocate', { fraction: 0.5, tocItem: { label: 'X', href: 'x' } })

    // dispose() itself reports one null document; nothing after it counts.
    expect(cb.calls['onDocument']).toHaveLength(docsBefore + 1)
    expect(cb.calls['onDocument']?.at(-1)?.[0]).toBeNull()
    expect(cb.calls['onRelocate'] ?? []).toHaveLength(0)
  })

  it('flattens foliate\'s mixed search yields into plain hits', async () => {
    const view = fakeView()
    // foliate yields four different shapes: a progress marker, a per-section
    // group, a bare hit, and finally the string 'done'.
    ;(view as unknown as { search: unknown }).search = async function* () {
      yield { progress: 0.5 }
      yield {
        label: 'Chapter One',
        subitems: [{ cfi: 'cfi/1', excerpt: { pre: 'a ', match: 'sea', post: ' b' } }],
      }
      yield { cfi: 'cfi/2', excerpt: { pre: 'c ', match: 'sea', post: ' d' } }
      yield 'done'
    }
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    const nav = cb.calls['onNavigator']?.[0]?.[0] as {
      search: (q: string, s: AbortSignal) => AsyncGenerator<unknown>
    }
    const hits: unknown[] = []
    for await (const hit of nav.search('sea', new AbortController().signal)) hits.push(hit)

    expect(hits).toEqual([
      { cfi: 'cfi/1', label: 'Chapter One', pre: 'a ', match: 'sea', post: ' b' },
      // The section label carries onto later bare hits, which is what lets a
      // result say which chapter it came from.
      { cfi: 'cfi/2', label: 'Chapter One', pre: 'c ', match: 'sea', post: ' d' },
    ])
  })

  it('stops searching when the signal aborts', async () => {
    const view = fakeView()
    ;(view as unknown as { search: unknown }).search = async function* () {
      yield { cfi: 'a', excerpt: { pre: '', match: 'x', post: '' } }
      yield { cfi: 'b', excerpt: { pre: '', match: 'x', post: '' } }
      yield 'done'
    }
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    const nav = cb.calls['onNavigator']?.[0]?.[0] as {
      search: (q: string, s: AbortSignal) => AsyncGenerator<unknown>
    }
    const controller = new AbortController()
    const hits: unknown[] = []
    for await (const hit of nav.search('x', controller.signal)) {
      hits.push(hit)
      controller.abort()
    }
    expect(hits).toHaveLength(1)
  })

  it('reports a startup failure instead of failing silently', async () => {
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', {
      createView: () => Promise.reject(new Error('module missing')),
      loadPainters: () => Promise.resolve(painters),
      applySettings: () => {},
    })
    expect(cb.calls['onError']?.[0]?.[0]).toBe('module missing')
  })

  it('stays silent when startup fails after disposal', async () => {
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    session.dispose()
    await session.start('book.epub', {
      createView: () => Promise.reject(new Error('module missing')),
      loadPainters: () => Promise.resolve(painters),
      applySettings: () => {},
    })
    expect(cb.calls['onError'] ?? []).toHaveLength(0)
  })

  it('surfaces an open failure with the book still closable', async () => {
    const view = fakeView({ open: () => Promise.reject(new Error('not an epub')) })
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('bad.epub', deps(view))

    expect(cb.calls['onError']?.[0]?.[0]).toBe('not an epub')
    session.dispose()
    expect(view.closed).toBe(1)
  })
})

describe('ReaderSession restore', () => {
  const AT = 'epubcfi(/6/14!/4/2/6,/1:0,/1:12)'

  it('opens the book where it was left', async () => {
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks())
    await session.start('book.epub', { ...deps(view), lastLocation: () => AT })
    expect(view.initCalls).toEqual([AT])
  })

  it('opens at the start when there is nothing saved', async () => {
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks())
    await session.start('book.epub', deps(view))
    expect(view.initCalls).toEqual([null])
  })

  /* The position is read AFTER the book is parsed, not when the session is
   * built. The id it is keyed by is derived from the file's content and
   * resolves on its own schedule, so a value read at construction is a value
   * read before it can exist. */
  it('reads the saved position after the book is open, not before', async () => {
    /* Null until the book is parsed, which is what the real value does: it is
     * keyed by an id derived from the file's content, resolved alongside the
     * open. A session that read this when it was constructed — or at any point
     * before `open` resolved — would see null and start every book at page one. */
    let saved: string | null = null
    const view = fakeView({
      open: () => {
        saved = AT
        return Promise.resolve()
      },
    })
    const session = new ReaderSession(fakeHost(), callbacks())
    await session.start('book.epub', { ...deps(view), lastLocation: () => saved })
    expect(view.initCalls).toEqual([AT])
  })

  /* Books are identified by hashing their ends, so a re-exported edition can
   * inherit a position from a file whose spine it no longer matches. Losing
   * the book over a stale bookmark is the worse of the two failures. */
  it('falls back to the start when the saved position will not resolve', async () => {
    let attempt = 0
    const view = fakeView({
      init: () => (attempt++ === 0 ? Promise.reject(new Error('bad CFI')) : Promise.resolve()),
    })
    const cb = callbacks()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', { ...deps(view), lastLocation: () => AT })

    expect(view.initCalls).toEqual([AT, null])
    // The reader is reading, not looking at an error about a bookmark.
    expect(cb.calls['onError'] ?? []).toHaveLength(0)
    // But it is not silent — a restore that never works must be findable.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports a book that cannot be displayed even from the start', async () => {
    const view = fakeView({ init: () => Promise.reject(new Error('no spine')) })
    const cb = callbacks()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', { ...deps(view), lastLocation: () => AT })

    expect(view.initCalls).toEqual([AT, null])
    expect(cb.calls['onError']?.[0]?.[0]).toBe('no spine')
    warn.mockRestore()
  })

  /* Disposal DURING the failing init, which is the only window the retry could
   * open. Disposing before `start` proves nothing here — the session bails long
   * before it reaches `init` — and a test written that way passes against a
   * retry with no guard on it at all. */
  it('does not retry a book the reader closed while it was restoring', async () => {
    let session: ReaderSession | null = null
    const view = fakeView({
      init: () => {
        session?.dispose()
        return Promise.reject(new Error('bad CFI'))
      },
    })
    const cb = callbacks()
    session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', { ...deps(view), lastLocation: () => AT })

    expect(view.initCalls).toEqual([AT])
    expect(cb.calls['onError'] ?? []).toHaveLength(0)
  })

  it('reports the CFI foliate publishes on relocate, so there is one to save', async () => {
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    view.emit('relocate', { fraction: 0.5, tocItem: { label: 'One', href: 'a' }, cfi: AT })
    expect(cb.calls['onRelocate']?.[0]?.[0]).toEqual({
      fraction: 0.5,
      chapterLabel: 'One',
      chapterHref: 'a',
      cfi: AT,
      /* Null because this relocation carries no range and no section has
       * been rendered under the fake view — which is exactly the state a
       * bookmark must refuse to be made in. See `ReaderPosition.sectionIndex`. */
      sectionIndex: null,
      /* And said out loud beside it, so the toggle can refuse for the same
         reason rather than working it out from a null. */
      sectionExact: false,
    })
  })

  it('reports a null cfi for a renderer that publishes none', async () => {
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    view.emit('relocate', { fraction: 0.5 })
    expect(
      (cb.calls['onRelocate']?.[0]?.[0] as { cfi: unknown }).cfi,
    ).toBeNull()
  })
})

/**
 * Where the reader IS, as a bookmark is made from it.
 *
 * The cheap half — the CFI and the section — rides every relocation, because
 * the ribbon and the toggle read it on every page turn. The expensive half is
 * `placeHere`, which walks the page's text and is therefore paid once, when
 * the reader asks for a bookmark rather than on every turn.
 */
describe('ReaderSession places', () => {
  const AT = 'epubcfi(/6/14!/4/2/6,/1:0,/1:12)'

  /**
   * A relocation's range: a text node belonging to the loaded document, and
   * just enough of a Range for the session to read a section and a line out of
   * it.
   *
   * `rangeText` falls back to `toString()` for a boundary it cannot walk — see
   * its own note on declining — so a minimal stand-in exercises the real path
   * rather than a mocked one.
   */
  function pageRange(doc: Document, text: string): Range {
    const node = { nodeType: 3, ownerDocument: doc, isConnected: true, data: text }
    return {
      startContainer: node,
      endContainer: node,
      startOffset: 0,
      endOffset: text.length,
      toString: () => text,
    } as unknown as Range
  }

  const relocated = (cb: ReturnType<typeof callbacks>) =>
    cb.calls['onRelocate']?.[0]?.[0] as { sectionIndex: number | null }

  async function reading() {
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))
    const doc = fakeDocument().asDocument()
    return { view, cb, session, doc }
  }

  /*
   * Exact, and it has to be: `compareMarks` and `findMark` both key on the
   * section, so a bookmark filed under the wrong one sorts into the wrong
   * chapter AND cannot be found again by the toggle that made it.
   *
   * THE CASE THAT SEPARATES THE TWO SOURCES is a section boundary in scrolled
   * flow, where two documents are on screen at once: the section rendered most
   * recently is the one BELOW, while the position being reported is still in
   * the one above. Taking the last render would file the bookmark one chapter
   * on from where the reader is standing. So the two are deliberately made to
   * disagree here — a test where they agree proves nothing about which was
   * read.
   */
  /*
   * THE RENDERER'S OWN INDEX WINS, and this is the case the other two sources
   * cannot get right. A fixed-layout SPREAD loads its left page and then its
   * right, and can afterwards display either without loading again — so the
   * last-rendered fallback answers "right" for both, and there is no range to
   * ask instead. A bookmark on the left page was filed under the right one and
   * the toggle could not find it.
   *
   * `section.current` is published on every relocation and was simply not
   * declared in `vite-env.d.ts`, which is why the inference existed at all.
   * Every source is made to disagree here on purpose: a test where they agree
   * proves nothing about which was read.
   */
  it('takes the section the renderer publishes, over the range and the last render', async () => {
    const { view, cb, doc } = await reading()
    view.emit('load', { doc, index: 4 })
    const next = fakeDocument().asDocument()
    view.emit('load', { doc: next, index: 5 })

    view.emit('relocate', {
      fraction: 0.5,
      cfi: AT,
      section: { current: 2, total: 40 },
      range: pageRange(doc, 'Call me Ishmael'),
    })

    expect(relocated(cb).sectionIndex).toBe(2)
  })

  /* A renderer that publishes no section falls back to the range's own
   * document — exact at a section boundary in scrolled flow, where two
   * documents are on screen and the last one RENDERED is the one below. */
  it('takes the section from the relocation’s own document, not the last rendered', async () => {
    const { view, cb, doc } = await reading()
    view.emit('load', { doc, index: 4 })
    const next = fakeDocument().asDocument()
    view.emit('load', { doc: next, index: 5 })

    view.emit('relocate', { fraction: 0.5, cfi: AT, range: pageRange(doc, 'Call me Ishmael') })

    expect(relocated(cb).sectionIndex).toBe(4)
  })

  /* The fallback, and every fixed-layout book takes it: `foliate-fxl` reports
   * no range at all. */
  it('falls back to the last rendered section when a relocation carries no range', async () => {
    const { view, cb, doc } = await reading()
    view.emit('load', { doc, index: 2 })

    view.emit('relocate', { fraction: 0.5, cfi: AT })

    expect(relocated(cb).sectionIndex).toBe(2)
  })

  it('builds a place from the page the reader is on', async () => {
    const { view, session, doc } = await reading()
    view.emit('load', { doc, index: 4 })
    view.emit('relocate', {
      fraction: 0.5,
      cfi: AT,
      tocItem: { label: 'Loomings', href: 'a' },
      range: pageRange(doc, 'Call me Ishmael'),
    })

    expect(session.placeHere()).toEqual({
      cfi: AT,
      sectionIndex: 4,
      /* From the SAME relocation as the anchor. Read off `ReaderPosition` by
       * the caller instead, it was a React commit behind — so a bookmark made
       * while crossing a chapter boundary filed this chapter's anchor under the
       * previous chapter's name. */
      chapter: 'Loomings',
      text: 'Call me Ishmael',
      prefix: '',
      suffix: '',
    })
  })

  /* A PDF is exactly the kind of book a reader wants to bookmark, and it
   * reports no range — so there is nothing to read a line out of. The place
   * still stands; only its remembered text is empty, and the list falls back
   * to the chapter for those. */
  it('still makes a place for a book that reports no range', async () => {
    const { view, session, doc } = await reading()
    view.emit('load', { doc, index: 0 })
    view.emit('relocate', { fraction: 0.5, cfi: AT })

    expect(session.placeHere()).toEqual({
      cfi: AT,
      sectionIndex: 0,
      chapter: '',
      text: '',
      prefix: '',
      suffix: '',
    })
  })

  /* THE CALLBACK FIRES for every section that loads, which is what keeps the
     ribbon's direction in step with a book whose sections disagree. What each
     answer should BE is `directionOf`'s own test, below. */
  it('reports the rendered direction of each section', async () => {
    const { view, cb, doc } = await reading()
    view.emit('load', { doc, index: 0 })
    expect(cb.calls['onDirection']?.at(-1)).toEqual(['ltr'])
    view.emit('load', { doc: fakeDocument().asDocument(), index: 1 })
    expect(cb.calls['onDirection']).toHaveLength(2)
  })

  /*
   * WHERE THE LAST RESORT IS WRONG, AND WHERE IT IS NOT.
   *
   * With no section and no range on the relocation, `#sectionOf` falls back to
   * "the section that rendered last". That is the section on screen whenever
   * ONE section is on screen — and it is a coin toss when two are, because
   * either can be the one the reader means without anything loading again. A
   * bookmark taking the coin toss points at a page they never opened, and
   * nothing afterwards can tell it from a good one.
   *
   * ASKED OF WHAT IS DISPLAYED, NOT OF WHAT IS LOADED. Counting live documents
   * was the first attempt and it is a proxy for the wrong thing: a renderer may
   * hold a spread's partner page in memory while showing one, and every such
   * book would then be refused a bookmark over a page nobody can see — a
   * working feature taken away to fix an edge case. The PDF case below is
   * exactly that, and it is the reason the count is not the rule.
   */
  it('refuses a place while a fixed-layout spread is showing two pages', async () => {
    const { view, session, doc } = await reading()
    view.isFixedLayout = true
    view.renderer.setAttribute('spread', 'auto')
    view.emit('load', { doc, index: 4 })
    view.emit('relocate', { fraction: 0.5, cfi: AT })

    expect(session.placeHere()).toBeNull()
  })

  /* THE SAME FAILURE FOR A REFLOWABLE BOOK, which reaches it a different way:
     scrolled flow can have the end of one section and the start of the next
     both on screen, and there the count IS the signal — a scrolled renderer
     holds live what it is showing. */
  it('refuses a place while scrolled flow is showing two sections', async () => {
    const { view, session, doc } = await reading()
    view.renderer.setAttribute('flow', 'scrolled')
    view.emit('load', { doc, index: 4 })
    view.emit('load', { doc: fakeDocument().asDocument(), index: 5 })
    view.emit('relocate', { fraction: 0.5, cfi: AT })

    expect(session.placeHere()).toBeNull()
  })

  /* AND A PDF STILL GETS ITS BOOKMARK. One page, no range, no section of its
     own — the book that needs ⌘B most and has the least to identify itself
     with. `spread: 'none'` is the renderer's word for a single page; a second
     document loaded behind it changes nothing, because it is not displayed. */
  it('still makes a place for a one-page fixed-layout book', async () => {
    const { view, session, doc } = await reading()
    view.isFixedLayout = true
    view.renderer.setAttribute('spread', 'none')
    view.emit('load', { doc, index: 4 })
    // The partner page, prefetched and not shown.
    view.emit('load', { doc: fakeDocument().asDocument(), index: 5 })
    view.emit('relocate', { fraction: 0.5, cfi: AT })

    expect(session.placeHere()?.sectionIndex).toBe(5)
  })

  /* A RENDERER THAT ANSWERS NEITHER QUESTION is trusted, which leaves this
     where it stood before any of it existed: no worse than before for anything
     already working. Refusing on silence would be guessing in the direction
     that breaks things. */
  it('still makes a place from the only rendered section', async () => {
    const { view, session, doc } = await reading()
    view.emit('load', { doc, index: 4 })
    view.emit('relocate', { fraction: 0.5, cfi: AT })

    expect(session.placeHere()?.sectionIndex).toBe(4)
  })

  /* AND THE FALLBACK STOPS NAMING A DOCUMENT THAT IS GONE. `#renderedIndex`
     was left pointing at a torn-down section, so dropping the most recently
     loaded of two named a document nothing could resolve while the other was
     still on screen — reported as confidently as any other answer. */
  it('falls back to what is left when the last-rendered section is torn down', async () => {
    const { view, session, doc } = await reading()
    const second = fakeDocument()
    view.emit('load', { doc, index: 4 })
    view.emit('load', { doc: second.asDocument(), index: 5 })
    view.emit('relocate', { fraction: 0.5, cfi: AT })
    expect(session.placeHere()?.sectionIndex).toBe(5)

    // `pagehide` on the section's own window is how a teardown reaches the
    // session — see `#onTeardown`.
    second.defaultView?.dispatch('pagehide')
    view.emit('relocate', { fraction: 0.5, cfi: AT })
    expect(session.placeHere()?.sectionIndex).toBe(4)
  })

  /* ONE RELOCATION, TAKEN WHOLE. `placeHere` used to be handed the CFI by its
   * caller and pair it with whatever range this session had most recently
   * seen; the host's copy lands a React commit later, so in the window between
   * two relocations the two described different pages. Here the session has
   * moved on and the place must describe where it moved TO, in every field. */
  it('answers for the latest relocation, never a mixture of two', async () => {
    const { view, session, doc } = await reading()
    view.emit('load', { doc, index: 1 })
    view.emit('relocate', {
      fraction: 0.1,
      cfi: AT,
      section: { current: 1, total: 40 },
      range: pageRange(doc, 'first page'),
    })
    const ELSEWHERE = 'epubcfi(/6/20!/4/2/2,/1:0,/1:9)'
    view.emit('relocate', {
      fraction: 0.9,
      cfi: ELSEWHERE,
      section: { current: 9, total: 40 },
      tocItem: { label: 'The Chase', href: 'z' },
      range: pageRange(doc, 'second page'),
    })

    /* EVERY field from the second relocation, the chapter included — the one
     * that was still being read off the caller's own render. */
    expect(session.placeHere()).toEqual({
      cfi: ELSEWHERE,
      sectionIndex: 9,
      chapter: 'The Chase',
      text: 'second page',
      prefix: '',
      suffix: '',
    })
  })

  /* Null rather than a degraded answer. A bookmark whose anchor cannot be
   * resolved is a row in a list that goes nowhere. */
  it('refuses a place with no anchor, and one with no section', async () => {
    const { view, session, doc } = await reading()
    view.emit('load', { doc, index: 1 })
    view.emit('relocate', { fraction: 0.5, cfi: null })
    expect(session.placeHere()).toBeNull()

    /* A REAL CFI AND NO SECTION, which is what the second half is FOR. It used
       to be a session that had never relocated at all — no anchor either — so
       an implementation that checked only the anchor passed it, and the section
       half of the rule was never exercised. No `load`, so nothing has rendered;
       no `section` and no `range` on the detail, so the three sources
       `#sectionOf` consults are all empty. */
    const fresh = await reading()
    fresh.view.emit('relocate', { fraction: 0.5, cfi: 'epubcfi(/6/20!/4/2/2,/1:0,/1:9)' })
    expect(fresh.session.placeHere()).toBeNull()
  })

  /* A range whose ends have left the document describes a page that has been
   * re-rendered since — the same check `publish` makes on a selection. The
   * place is still good; only its remembered text is not, so the text is
   * dropped rather than the bookmark. */
  it('drops the remembered text when the page it came from has been replaced', async () => {
    const { view, session, doc } = await reading()
    view.emit('load', { doc, index: 3 })
    const stale = pageRange(doc, 'Call me Ishmael')
    ;(stale.startContainer as unknown as { isConnected: boolean }).isConnected = false
    view.emit('relocate', { fraction: 0.5, cfi: AT, range: stale })

    expect(session.placeHere()).toEqual({
      cfi: AT,
      sectionIndex: 3,
      chapter: '',
      text: '',
      prefix: '',
      suffix: '',
    })
  })
})

describe('ReaderSession marks', () => {
  const anchor = (over: Partial<MarkAnchor> = {}): MarkAnchor => ({
    cfi: 'epubcfi(/6/4)',
    sectionIndex: 0,
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    ...over,
  })

  it('draws only the marks belonging to the section being built', async () => {
    // foliate offers one overlay per spine item. Handing it a mark from
    // another section would resolve a CFI that cannot land in this overlay.
    const view = fakeView()
    const cb = callbacks([
      anchor({ cfi: 'here', sectionIndex: 2 }),
      anchor({ cfi: 'elsewhere', sectionIndex: 5 }),
    ])
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    view.emit('create-overlay', { index: 2 })

    expect(view.annotations).toEqual([
      { value: 'here', kind: 'highlight', tint: 'yellow', style: 'fill', remove: false },
    ])
  })

  it('reads the store afresh for every overlay, so a new mark is drawn', async () => {
    // The store is read through a getter precisely so that a mark made after
    // startup is not missed when the section is rebuilt.
    const live: MarkAnchor[] = []
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks(live))
    await session.start('book.epub', deps(view))

    view.emit('create-overlay', { index: 0 })
    expect(view.annotations).toHaveLength(0)

    live.push(anchor({ cfi: 'made-later' }))
    view.emit('create-overlay', { index: 0 })
    expect(view.annotations.map((a) => a.value)).toEqual(['made-later'])
  })

  /** Draw one annotation and report the painter and colour it chose. */
  const paintOne = async (annotation: Record<string, unknown>) => {
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks())
    await session.start('book.epub', deps(view))
    const painted: { fn: unknown; color: unknown }[] = []
    view.emit('draw-annotation', {
      draw: (fn: unknown, options: { color: string }) => painted.push({ fn, color: options.color }),
      annotation,
      range: null,
    })
    void session
    return painted
  }

  it('draws a fill mark as a band in its tint', async () => {
    expect(await paintOne({ kind: 'highlight', tint: 'green', style: 'fill' })).toEqual([
      { fn: 'FILL', color: '#D1EED3' },
    ])
  })

  it.each([['underline', 'UNDERLINE']])(
    'draws a %s mark with its own painter, in the tint’s rule colour',
    async (style, painter) => {
    /* The RULE colour, not the fill: a pale band is invisible as a 2px line,
       which is the whole reason each tint is a pair. And one painter per style,
       because a style the union offers and nothing can draw is a mark the
       reader chooses and then cannot see. */
      expect(await paintOne({ kind: 'highlight', tint: 'purple', style })).toEqual([
        { fn: painter, color: '#DDAFFF' },
      ])
    },
  )

  it('falls back to a fill for a style this build does not know', async () => {
    // A mark written by a later build, read back by this one.
    expect(await paintOne({ kind: 'highlight', tint: 'green', style: 'dotted' })).toEqual([
      { fn: 'FILL', color: '#D1EED3' },
    ])
  })

  it('draws the companion’s mark as an amber WAVE whatever the reader chose', async () => {
    /* Here the colour is not a preference, it is whose mark this is — and so is
       the shape. The wave is reserved to the companion (`READER_STYLES`), which
       is what keeps a machine's claim from looking like the reader's own once
       the reader can draw rules too. A departure from §01, which specified an
       underline back when every reader's mark was a fill. */
    expect(await paintOne({ kind: 'companion', tint: 'green', style: 'fill' })).toEqual([
      { fn: 'WAVE', color: '#9E5A16' },
    ])
  })

  it('draws a reader’s underline as an underline, not the companion’s wave', async () => {
    // The pair above only means something if the reader's rule is a different one.
    expect(await paintOne({ kind: 'highlight', tint: 'green', style: 'underline' })).toEqual([
      { fn: 'UNDERLINE', color: '#85D288' },
    ])
  })

  it('falls back to a yellow fill for an annotation carrying neither', async () => {
    /* Every mark made before tints existed, and anything foliate has
       round-tripped. The same default `validMarks` applies, so a mark does not
       change appearance depending on which of the two resolved it. */
    expect(await paintOne({ kind: 'highlight' })).toEqual([
      { fn: 'FILL', color: '#F3E6C0' },
    ])
  })

  it('does not substitute a rule for a fill on any theme', async () => {
    /* §05 used to turn every Night mark into a rule, which was right while a
       fill was the only drawing there was. With the style a CHOICE, overriding
       it would overrule the reader silently and collapse the two styles into
       one on the theme people read longest on. */
    const view = fakeView()
    const cb = callbacks()
    cb.getPalette = () => ({
      fill: { yellow: '#4A3B18', green: '#2C4230', purple: '#433851' },
      rule: { yellow: '#8A6E2C', green: '#4B7D4D', purple: '#85659D' },
      companion: '#D9A25E',
    })
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    const painted: { fn: unknown; color: unknown }[] = []
    const draw = (fn: unknown, options: { color: string }) =>
      painted.push({ fn, color: options.color })
    view.emit('draw-annotation', {
      draw,
      annotation: { kind: 'highlight', tint: 'yellow', style: 'fill' },
      range: null,
    })
    view.emit('draw-annotation', {
      draw,
      annotation: { kind: 'highlight', tint: 'yellow', style: 'underline' },
      range: null,
    })

    expect(painted).toEqual([
      { fn: 'FILL', color: '#4A3B18' },
      { fn: 'UNDERLINE', color: '#8A6E2C' },
    ])
  })

  it('reports the live range a mark resolved to', async () => {
    // The only place that Range is obtainable — the margin marks need it to
    // sit beside the right line, and there is no public CFI-to-Range resolver.
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    const range = { id: 'a-range' }
    view.emit('draw-annotation', {
      draw: () => {},
      annotation: { value: 'cfi/9', kind: 'highlight' },
      range,
    })

    expect(cb.calls['onMarkDrawn']?.[0]).toEqual(['cfi/9', range])
  })

  it('erases through the same path it draws', async () => {
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    const nav = cb.calls['onNavigator']?.[0]?.[0] as {
      drawMark: (a: MarkAnchor) => void
      eraseMark: (a: MarkAnchor) => void
    }
    nav.drawMark(anchor({ cfi: 'x' }))
    nav.eraseMark(anchor({ cfi: 'x' }))

    /* The APPEARANCE rides along on the erase too. foliate matches an
       annotation by value, so it makes no difference to the removal — but a
       shape that differed between the two paths is exactly how the drawing
       and the erasing come to disagree about what a mark is. */
    expect(view.annotations).toEqual([
      { value: 'x', kind: 'highlight', tint: 'yellow', style: 'fill', remove: false },
      { value: 'x', kind: 'highlight', tint: 'yellow', style: 'fill', remove: true },
    ])
  })

  it('re-attaches marks for live sections when the theme changes', async () => {
    // The Overlayer's own redraw() reuses the options each mark was added
    // with, so it repaints the OLD colour. Re-adding is what re-reads it.
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks([anchor({ cfi: 'a' })]))
    await session.start('book.epub', deps(view))

    view.emit('create-overlay', { index: 0 })
    view.annotations.length = 0
    session.redrawMarks()

    expect(view.annotations.map((a) => a.value)).toEqual(['a'])
  })

  it('draws nothing for a section that has been torn down', async () => {
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks([anchor({ cfi: 'a' })]))
    await session.start('book.epub', deps(view))

    session.dispose()
    view.annotations.length = 0
    session.redrawMarks()

    expect(view.annotations).toHaveLength(0)
  })

  it('closes the view when the painters fail to load', async () => {
    // allSettled, not all: a rejected painters promise must not strand a view
    // that resolved successfully with nothing left holding it.
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', {
      createView: () => Promise.resolve(view),
      loadPainters: () => Promise.reject(new Error('overlayer missing')),
      applySettings: () => {},
    })

    expect(cb.calls['onError']?.[0]?.[0]).toBe('overlayer missing')
    session.dispose()
    expect(view.closed).toBe(1)
  })
})

/**
 * Gesture provenance, at the only level that can show it: registration.
 *
 * The state machine itself — which event marks a selection as pointer-produced,
 * which releases the pointer, and why a token beats a boolean — is asserted in
 * `wordSnap/gestureProvenance.test.ts`, against the same fake document. Two
 * facts about this lane put it there rather than here, and both are recorded at
 * the top of that file: WI-7 deliberately does not wire the snap, so there is
 * no consequence to observe at the session yet; and a `keydown` dispatched
 * through a session reaches `#watchKeys`, which builds a `KeyboardEvent` and
 * dispatches it on `window` — neither of which exists in plain node.
 *
 * What is left here is what only a real `load` can show: that the listeners
 * land on the right target, exactly once per section load, and that teardown
 * takes every one of them off again. That is the defect most likely to be
 * introduced by this work item, and nothing else in the suite would catch it.
 *
 * **Live-lane partner: none, and there cannot be one.** A real drag, a real
 * shift+arrow and a real interrupted gesture are unreachable from any harness —
 * the Tauri MCP bridge dispatches `isTrusted: false` events, which produce no
 * native selection and no `selectionchange`. The `live` lane exists
 * (`scripts/word-snap-live.mjs`) and covers the adapter, not the gesture.
 *
 * **This pairing is permanently unmet**; `dev-docs/manual-selection-checklist.md`
 * §1 is the cover.
 */
describe('ReaderSession gesture provenance', () => {
  const WORDS = 'the quick brown fox'

  /** A forward selection over `'ick bro'`. Node offsets, not flat coordinates:
   *  `'the quick brown fox'.slice(6, 13)`. */
  function selectedWords(): { selection: FakeSelection; words: Text } {
    const fixture = buildFixture(elem('p', { id: 'para' }, [txt(WORDS)]))
    const words = fixture.text(WORDS)
    return { selection: selectionOver({ node: words, offset: 6 }, { node: words, offset: 13 }), words }
  }

  /**
   * A wheel event as the session reads one, with a recordable `preventDefault`.
   *
   * Big enough on one axis to clear the pager's threshold in a single event, so
   * a test asserting an intent does not depend on the gesture arithmetic being
   * exercised somewhere else.
   */
  function wheelEvent(over: {
    isTrusted: boolean
    deltaX?: number
    deltaY?: number
    ctrlKey?: boolean
  }) {
    return {
      deltaX: 400,
      deltaY: 0,
      deltaMode: 0,
      ctrlKey: false,
      prevented: false,
      preventDefault(this: { prevented: boolean }) {
        this.prevented = true
      },
      ...over,
    }
  }

  async function loadedSection(): Promise<{
    doc: FakeDocument
    selection: FakeSelection
    session: ReaderSession
    view: ReturnType<typeof fakeView>
    cb: ReturnType<typeof callbacks>
    reload: () => void
  }> {
    const { selection } = selectedWords()
    const doc = fakeDocument({ selection })
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))
    const reload = (): void => view.emit('load', { doc: doc.asDocument(), index: 0 })
    reload()
    return { doc, selection, session, view, cb, reload }
  }

  /**
   * Every listener a loaded section has, whole.
   *
   * `toEqual` on the entire table rather than per-key checks, because the
   * failure being hunted is a LEAKED listener — a type nobody remembered to
   * assert. A per-key `toBe(1)` passes for exactly that.
   *
   * Two `pointerup`, two `keydown` and two `selectionchange` listeners is the
   * correct answer, not a leak: provenance and publishing are separate
   * concerns, and `#watchKeys` forwards keystrokes for a reason of its own.
   * Deliberately so — the criterion is that no listener depends on running
   * before another, which is what the ordering case below pins. A PDF page
   * document carries a third `pointerup` from `bindSelectionFix`
   * (`makePdf.ts:82`) on top of these.
   */
  const LOADED_DOCUMENT_LISTENERS = {
    pointerdown: 1,
    pointerup: 2,
    pointercancel: 1,
    keydown: 2,
    keyup: 1,
    // The trackpad swipe — one per document, passive, torn down with the rest.
    wheel: 1,
    selectionchange: 2,
    dragenter: 1,
    dragover: 1,
    drop: 1,
  }

  it('registers its listeners on the right target, and a section reload does not double them', async () => {
    const { doc, reload } = await loadedSection()
    const view = doc.defaultView
    if (!view) throw new Error('the fake document has no window')

    expect(doc.listenerCounts()).toEqual(LOADED_DOCUMENT_LISTENERS)
    /* `blur` on the WINDOW, matching `bindSelectionFix` (`makePdf.ts:87`): a
     * drag released outside the window delivers no pointer event to the
     * document at all. `pagehide` is `#onTeardown`'s own. */
    expect(view.listenerCounts()).toEqual({ blur: 1, pagehide: 1 })

    // foliate re-loads a section every time the reader returns to it.
    reload()
    reload()

    expect(doc.listenerCounts()).toEqual(LOADED_DOCUMENT_LISTENERS)
    expect(view.listenerCounts()).toEqual({ blur: 1, pagehide: 1 })
  })

  /* The wheel listener drives host NAVIGATION, and a book is attacker-controlled
   * HTML in a same-origin frame. `dispatchEvent(new WheelEvent(...))` from an
   * EPUB's own script would otherwise page the reader's book at will and clear
   * their selection — so the listener takes only real input.
   *
   * The same property the gesture checklist relies on when it says the MCP
   * bridge cannot fake a gesture: `isTrusted` is provenance, and it cannot be
   * forged from inside the page. */
  it('turns a page for real input and ignores a book`s synthetic wheel event', async () => {
    const { doc, cb } = await loadedSection()

    doc.dispatch('wheel', wheelEvent({ isTrusted: false }))
    expect(cb.calls['onPageIntent'] ?? []).toHaveLength(0)

    doc.dispatch('wheel', wheelEvent({ isTrusted: true }))
    expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('right')
  })

  /* The window must not move. An unconsumed wheel chains outwards until
   * something bounces, and on macOS that is the viewport — the whole
   * application dragged sideways and sprung back on every swipe. */
  it('consumes the gesture in paged flow, so nothing rubber-bands', async () => {
    const { doc, view } = await loadedSection()
    view.renderer.setAttribute('flow', 'paginated')

    const event = wheelEvent({ isTrusted: true })
    doc.dispatch('wheel', event)
    expect(event.prevented).toBe(true)
  })

  /* And leaves it alone where the book genuinely scrolls — consuming it there
   * would stop scrolling dead. */
  it('does not consume the gesture in scrolled flow', async () => {
    const { doc, view, cb } = await loadedSection()
    view.renderer.setAttribute('flow', 'scrolled')

    const event = wheelEvent({ isTrusted: true })
    doc.dispatch('wheel', event)
    expect(event.prevented).toBe(false)
    expect(cb.calls['onPageIntent'] ?? []).toHaveLength(0)
  })

  /* A PDF is fixed-layout, and `foliate-fxl` observes `zoom` and nothing else —
   * so `flow` sits on it unread and says nothing about whether the book
   * scrolls. Reading that attribute back as though it meant something made
   * every PDF stop responding to a swipe as soon as the reader had ever chosen
   * scrolled mode. `zoom` is the attribute that decides it here. */
  it('still pages a fixed-layout book whose flow says scrolled', async () => {
    const { doc, view, cb } = await loadedSection()
    view.isFixedLayout = true
    view.renderer.setAttribute('flow', 'scrolled')

    const event = wheelEvent({ isTrusted: true })
    doc.dispatch('wheel', event)
    expect(event.prevented).toBe(true)
    expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('right')
  })

  /**
   * A fixed-layout book in fit-width — a PDF in scroll mode.
   *
   * The renderer element is the scrollport itself, so unlike the paginator's
   * (which is sealed inside a closed shadow root) its position is readable, and
   * the answer can be exact rather than a blanket hands-off.
   */
  describe('a fixed-layout book scaled to the width', () => {
    /** A PDF page taller than the window, scrolled to `scrollTop`. */
    const scrollable = async (scrollTop: number) => {
      const loaded = await loadedSection()
      loaded.view.isFixedLayout = true
      loaded.view.renderer.setAttribute('zoom', 'fit-width')
      Object.assign(loaded.view.renderer, {
        scrollHeight: 2000,
        clientHeight: 600,
        scrollTop,
      })
      return loaded
    }

    it('lets the platform scroll a page that has further to go', async () => {
      const { doc, cb } = await scrollable(0)
      const event = wheelEvent({ deltaX: 0, deltaY: 40, isTrusted: true })
      doc.dispatch('wheel', event)
      expect(event.prevented).toBe(false)
      expect(cb.calls['onPageIntent'] ?? []).toHaveLength(0)
    })

    /* The half that makes a PDF read CONTINUOUSLY. Without it the reader
     * scrolls to the foot of page one and the trackpad goes dead, because in
     * this renderer one page is one section and nothing else moves. */
    it('turns the page once the foot of this one is reached', async () => {
      const { doc, cb } = await scrollable(1400)
      const event = wheelEvent({ deltaX: 0, deltaY: 40, isTrusted: true })
      doc.dispatch('wheel', event)
      expect(event.prevented).toBe(true)
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('next')
    })

    it('turns back at the head of the page', async () => {
      const { doc, cb } = await scrollable(0)
      const event = wheelEvent({ deltaX: 0, deltaY: -40, isTrusted: true })
      doc.dispatch('wheel', event)
      expect(event.prevented).toBe(true)
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('prev')
    })

    /* A sideways swipe means the page left or right wherever the reader has
     * scrolled to. Deciding it on the scroll position instead would make the
     * gesture work at the top of a page and silently do nothing in the middle
     * — the shape of bug that gets reported as "sometimes it ignores me". */
    it('pages sideways even when the page is scrolled mid-way', async () => {
      const { doc, cb } = await scrollable(700)
      const event = wheelEvent({ deltaX: 60, deltaY: 0, isTrusted: true })
      doc.dispatch('wheel', event)
      expect(event.prevented).toBe(true)
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('right')
    })

    /* A page that fits the window has nothing to scroll, and `scrollHeight`
     * lands a fraction over `clientHeight` on a scaled canvas. Without the
     * slack this hands back every event and the book wedges on that page. */
    it('pages when the page fits, despite a fractional overflow', async () => {
      const { doc, view, cb } = await loadedSection()
      view.isFixedLayout = true
      view.renderer.setAttribute('zoom', 'fit-width')
      Object.assign(view.renderer, { scrollHeight: 600.5, clientHeight: 600, scrollTop: 0 })

      const event = wheelEvent({ deltaX: 0, deltaY: 40, isTrusted: true })
      doc.dispatch('wheel', event)
      expect(event.prevented).toBe(true)
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('next')
    })
  })

  /**
   * A PINCH — a wheel event carrying `ctrlKey`.
   *
   * `wheelPager` already declines to page on one, so nothing turned; the defect
   * was that it declined AFTER `preventDefault`, cancelling the platform's zoom
   * and foliate's own pinch handling on the way past. A reader pinching a PDF
   * page got nothing, which reads as a missing feature rather than a suppressed
   * one.
   */
  it('leaves a pinch entirely alone', async () => {
    const { doc, cb } = await loadedSection()
    const event = wheelEvent({ isTrusted: true, ctrlKey: true })
    doc.dispatch('wheel', event)
    expect(event.prevented).toBe(false)
    expect(cb.calls['onPageIntent'] ?? []).toHaveLength(0)
  })

  /**
   * A scrolling box the BOOK's author made — a long code listing, a wide table.
   *
   * Ordinary book markup, and in paged flow the whole event was being consumed,
   * so a wheel over one turned the page and its content below the fold could
   * not be reached at all.
   */
  describe("over the book author's own scrolling box", () => {
    /** An element chain ending at BODY, with computed overflow per element. */
    const boxAt = (over: {
      overflowY?: string
      scrollTop?: number
      scrollHeight?: number
      clientHeight?: number
    }) => {
      const style = { overflowY: over.overflowY ?? 'auto', overflowX: 'visible' }
      const body = { nodeName: 'BODY', parentElement: null }
      return {
        nodeName: 'PRE',
        parentElement: body,
        scrollTop: over.scrollTop ?? 0,
        scrollHeight: over.scrollHeight ?? 900,
        clientHeight: over.clientHeight ?? 300,
        scrollLeft: 0,
        scrollWidth: 0,
        clientWidth: 0,
        ownerDocument: { defaultView: { getComputedStyle: () => style } },
      }
    }

    it('hands the gesture to a box that can still scroll', async () => {
      const { doc, cb } = await loadedSection()
      const event = { ...wheelEvent({ isTrusted: true, deltaX: 0, deltaY: 40 }), target: boxAt({}) }
      doc.dispatch('wheel', event)
      expect(event.prevented).toBe(false)
      expect(cb.calls['onPageIntent'] ?? []).toHaveLength(0)
    })

    /* At its end the box must give the gesture up, or the reader is stuck at the
     * foot of a listing with a page that will not turn. */
    it('takes it back once the box is scrolled to its end', async () => {
      const { doc, cb } = await loadedSection()
      const event = {
        ...wheelEvent({ isTrusted: true, deltaX: 0, deltaY: 40 }),
        target: boxAt({ scrollTop: 600 }),
      }
      doc.dispatch('wheel', event)
      expect(event.prevented).toBe(true)
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('next')
    })

    /* `hidden` is scrollable by script but not by a wheel, and books clip boxes
     * constantly — treating it as scrollable would swallow gestures at random. */
    it('ignores a merely clipped box', async () => {
      const { doc, cb } = await loadedSection()
      const event = {
        ...wheelEvent({ isTrusted: true, deltaX: 0, deltaY: 40 }),
        target: boxAt({ overflowY: 'hidden' }),
      }
      doc.dispatch('wheel', event)
      expect(event.prevented).toBe(true)
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('next')
    })
  })

  /**
   * Reading BACKWARDS through a scrolled PDF.
   *
   * One page is one section here, so scrolling up at the head of a page loads
   * the previous one — and it used to open at ITS head. The reader was then at
   * the top again, scrolled up again, and skipped backwards through the book
   * without seeing a word of it. Arriving backwards has to land on the foot.
   *
   * `requestAnimationFrame` does not exist in this environment, which is the
   * fallback path the code takes deliberately rather than throwing inside the
   * load handler — so the scroll lands synchronously here.
   */
  describe('arriving at a page by scrolling backwards', () => {
    const scrolledPdf = async () => {
      const loaded = await loadedSection()
      loaded.view.isFixedLayout = true
      loaded.view.renderer.setAttribute('zoom', 'fit-width')
      Object.assign(loaded.view.renderer, {
        scrollHeight: 2000,
        clientHeight: 600,
        scrollTop: 0,
      })
      return loaded
    }

    it('opens the previous page at its foot', async () => {
      const { doc, view, cb, reload } = await scrolledPdf()
      doc.dispatch('wheel', wheelEvent({ isTrusted: true, deltaX: 0, deltaY: -40 }))
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('prev')

      reload() // the previous page's document arrives
      expect(view.renderer.scrollTop).toBe(view.renderer.scrollHeight)
    })

    /* Forwards is the opposite: the head of the next page is where reading
     * should resume, so nothing must move it. */
    it('leaves a page reached forwards at its head', async () => {
      const { doc, view, cb, reload } = await scrolledPdf()
      view.renderer.scrollTop = 1400 // at the foot, so the next event pages
      doc.dispatch('wheel', wheelEvent({ isTrusted: true, deltaX: 0, deltaY: 40 }))
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('next')

      reload()
      expect(view.renderer.scrollTop).toBe(1400)
    })

    /* Arming is not proof that anything will load: `prev()` at the very first
     * page navigates nowhere. A plain flag stayed armed indefinitely, so the
     * next page the reader reached by ANY means — a tap in the contents, an
     * hour later — opened at its foot. The window bounds that to the moment. */
    it('does not send a much later page to its foot', async () => {
      const { doc, view, cb, reload } = await scrolledPdf()
      doc.dispatch('wheel', wheelEvent({ isTrusted: true, deltaX: 0, deltaY: -40 }))
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('prev')

      const realNow = performance.now.bind(performance)
      const late = realNow() + 5_000
      performance.now = () => late
      try {
        reload()
      } finally {
        performance.now = realNow
      }
      expect(view.renderer.scrollTop).toBe(0)
    })

    /**
     * The DEFERRED path, which the tests above never reach.
     *
     * Node has no `requestAnimationFrame`, so every case above takes the
     * synchronous fallback — meaning the frame callback, where the real hazard
     * lives, went unexercised. An occluded window does not CANCEL a frame, it
     * postpones it: the callback runs when the window comes back, potentially
     * minutes and several pages later. So the window is re-checked inside it.
     */
    describe('when the frame is deferred', () => {
      /** Installs a fake rAF that hands back its callback instead of running it. */
      const captureFrame = () => {
        const pending: (() => void)[] = []
        const real = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
        ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
          fn: () => void,
        ) => {
          pending.push(fn)
          return pending.length
        }
        return {
          pending,
          restore: () => {
            if (real === undefined) delete (globalThis as { requestAnimationFrame?: unknown })
              .requestAnimationFrame
            else (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = real
          },
        }
      }

      it('scrolls when the frame arrives promptly', async () => {
        const frame = captureFrame()
        try {
          const { doc, view, cb, reload } = await scrolledPdf()
          doc.dispatch('wheel', wheelEvent({ isTrusted: true, deltaX: 0, deltaY: -40 }))
          expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('prev')
          reload()
          expect(view.renderer.scrollTop).toBe(0) // nothing yet — it is deferred
          frame.pending.forEach((fn) => fn())
          expect(view.renderer.scrollTop).toBe(view.renderer.scrollHeight)
        } finally {
          frame.restore()
        }
      })

      /* The window came back long afterwards. The page on screen is no longer
       * the one the gesture was about, so the frame must do nothing. */
      it('does nothing when the window comes back much later', async () => {
        const frame = captureFrame()
        const realNow = performance.now.bind(performance)
        try {
          const { doc, view, reload } = await scrolledPdf()
          doc.dispatch('wheel', wheelEvent({ isTrusted: true, deltaX: 0, deltaY: -40 }))
          reload()
          performance.now = () => realNow() + 60_000
          frame.pending.forEach((fn) => fn())
          expect(view.renderer.scrollTop).toBe(0)
        } finally {
          performance.now = realNow
          frame.restore()
        }
      })

      it('does nothing once the session is disposed', async () => {
        const frame = captureFrame()
        try {
          const { doc, view, session, reload } = await scrolledPdf()
          doc.dispatch('wheel', wheelEvent({ isTrusted: true, deltaX: 0, deltaY: -40 }))
          reload()
          session.dispose()
          frame.pending.forEach((fn) => fn())
          expect(view.renderer.scrollTop).toBe(0)
        } finally {
          frame.restore()
        }
      })
    })

    /* A sideways swipe is a page turn, not a scroll, and a page turn lands at
     * the top however it was asked for. */
    it('leaves a page reached by a sideways swipe at its head', async () => {
      const { doc, view, cb, reload } = await scrolledPdf()
      doc.dispatch('wheel', wheelEvent({ isTrusted: true, deltaX: -60, deltaY: 0 }))
      expect(cb.calls['onPageIntent']?.[0]?.[0]).toBe('left')

      reload()
      expect(view.renderer.scrollTop).toBe(0)
    })
  })

  it('stops feeding the pager once the session is disposed', async () => {
    const { doc, cb, session } = await loadedSection()
    session.dispose()
    doc.dispatch('wheel', wheelEvent({ isTrusted: true }))
    expect(cb.calls['onPageIntent'] ?? []).toHaveLength(0)
  })

  it('takes every listener off again when the session is disposed', async () => {
    const { doc, session } = await loadedSection()
    const view = doc.defaultView
    if (!view) throw new Error('the fake document has no window')

    session.dispose()

    expect(doc.listenerCounts()).toEqual({})
    expect(view.listenerCounts()).toEqual({})
  })

  describe('clicking a mark', () => {
    /**
     * `show-annotation` is what foliate emits when a click hits a drawn mark,
     * and it carries the live range and the section index with the anchor.
     * Selecting that range is what puts the selection tools over the highlight,
     * so a reader recolours, restyles, notes, copies or removes a mark with the
     * same bar they made it with.
     */
    const clickMark = (view: ReturnType<typeof fakeView>, range: unknown) =>
      view.emit('show-annotation', { value: 'cfi/9', index: 0, range })

    it('selects the passage the mark covers, and publishes it', async () => {
      const { selection, view, cb } = await loadedSection()
      const range = selection.getRangeAt(0)

      clickMark(view, range)

      expect(selection.mutations).toBe(1)
      expect(published(cb)).toEqual([
        {
          cfi: 'cfi(0:ick bro)',
          sectionIndex: 0,
          text: 'ick bro',
          prefix: 'the qu',
          suffix: 'wn fox',
          range: selection.getRangeAt(0),
        },
      ])
    })

    it('publishes in the same turn rather than leaving it to the pointer snap', async () => {
      /* The click that hit the mark has already scheduled a snap, and that snap
         would publish the range too — a macrotask later and widened to whole
         words. Waiting for it would bring the bar up late, against an anchor
         that is not the mark's own. */
      const { selection, view, cb } = await loadedSection()
      clickMark(view, selection.getRangeAt(0))
      expect(published(cb)).toHaveLength(1)
    })

    it('does nothing when the event carries no range', async () => {
      /* `showAnnotation` resolves a CFI before emitting, and a CFI that will not
         resolve produces no range. Selecting nothing would be a bar hanging off
         a passage that could not be found. */
      const { selection, view, cb } = await loadedSection()
      clickMark(view, undefined)
      expect(selection.mutations).toBe(0)
      expect(published(cb)).toEqual([])
    })

    it('does nothing after the session is disposed', async () => {
      const { selection, view, cb, session } = await loadedSection()
      const range = selection.getRangeAt(0)
      session.dispose()
      clickMark(view, range)
      /* Disposal itself publishes a null — the popup coming down with the
         book. What must not appear is a SNAPSHOT, which would be a bar over a
         document that has been torn down. */
      expect(published(cb).filter(Boolean)).toEqual([])
      expect(selection.mutations).toBe(0)
    })
  })

  it('publishes on keyup without touching the selection — shift+arrow stays character-granular', async () => {
    const { doc, selection, cb } = await loadedSection()

    /* No `keydown` in this sequence, and it is not an oversight. Dispatching
     * one through a session reaches `#watchKeys`, which forwards it by building
     * a `KeyboardEvent` and dispatching it on `window` — neither global exists
     * in plain node, so the case would die inside key forwarding without ever
     * reaching the selection. The keydown half of a shift+arrow is asserted in
     * `wordSnap/gestureProvenance.test.ts`, where no forwarding is in the way. */
    doc.dispatch('selectionchange')
    doc.dispatch('keyup')

    expect(published(cb)).toEqual([
      {
          cfi: 'cfi(0:ick bro)',
          sectionIndex: 0,
          text: 'ick bro',
          prefix: 'the qu',
          suffix: 'wn fox',
          range: selection.getRangeAt(0),
        },
    ])
    // The whole point of the criterion: the reader's own character-granular
    // boundaries survive, which a snap on this path would destroy.
    expect(selection.mutations).toBe(0)
  })

  /**
   * One real macrotask, which is where WI-8 parks the snap.
   *
   * Real rather than faked, deliberately: the cases in this block are about the
   * gesture reaching the session at all, and letting the actual event loop
   * deliver the callback keeps them honest about the deferral being a macrotask
   * and not a fake-timer artefact. The cases that assert WHEN the snapshot
   * appears use fake timers, further down.
   */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('publishes the snapped words when a pointer gesture ends', async () => {
    /*
     * **Changed by WI-9, and this is the reason.** Until WI-9 this case was
     * characterization: WI-7 recorded provenance and deliberately snapped
     * nothing, so a completed drag published `'ick bro'` — exactly what the
     * reader dragged over — and a mutation would have meant the snap arrived
     * early and untested. WI-9 wires `applySnap` in, so the same gesture now
     * publishes the whole words it touched, one macrotask later.
     *
     * The whole snapshot is compared rather than its text, so a renamed or
     * added field is a failure here even though the WI-9 block below asserts
     * the fields individually.
     */
    const { doc, selection, cb } = await loadedSection()

    doc.dispatch('pointerdown')
    doc.dispatch('selectionchange')
    doc.dispatch('pointerup')
    await settle()

    expect(published(cb)).toEqual([
      {
        cfi: 'cfi(0:quick brown)',
        sectionIndex: 0,
        text: 'quick brown',
        prefix: 'the ',
        suffix: ' fox',
        range: selection.getRangeAt(0),
      },
    ])
    expect(selection.mutations).toBe(1)
  })

  it('publishes the same snapshot whichever pointerup listener runs first', async () => {
    /* `bindSelectionFix` puts its own `pointerup` on every PDF page document.
     * Both runs share one selection, so "deep-equal in both orders" compares
     * the same node identities and the pinned value below makes "both wrong in
     * the same way" a failure rather than a pass. */
    const { selection } = selectedWords()

    const run = async (
      order: 'stand-in first' | 'stand-in second',
    ): Promise<{ snapshots: (SelectionSnapshot | null)[]; standInRuns: number }> => {
      const doc = fakeDocument({ selection })
      const view = fakeView()
      const cb = callbacks()
      const session = new ReaderSession(fakeHost(), cb)
      await session.start('book.epub', deps(view))

      let standInRuns = 0
      const standIn = (): void => void (standInRuns += 1)
      if (order === 'stand-in first') doc.addEventListener('pointerup', standIn)
      view.emit('load', { doc: doc.asDocument(), index: 0 })
      if (order === 'stand-in second') doc.addEventListener('pointerup', standIn)

      doc.dispatch('pointerdown')
      doc.dispatch('selectionchange')
      doc.dispatch('pointerup')
      await settle()
      return { snapshots: published(cb), standInRuns }
    }

    const first = await run('stand-in first')
    const second = await run('stand-in second')

    expect(first.snapshots).toEqual(second.snapshots)
    expect(first.snapshots).toEqual([
      {
        cfi: 'cfi(0:quick brown)',
        sectionIndex: 0,
        text: 'quick brown',
        prefix: 'the ',
        suffix: ' fox',
        range: selection.getRangeAt(0),
      },
    ])
    expect([first.standInRuns, second.standInRuns]).toEqual([1, 1])
    /* **Changed by WI-9**: the pinned value was the unsnapped `'ick bro'` while
     * the snap was unwired, and both runs mutated nothing. ONE mutation across
     * two runs is the right count and not a leak of state between them: the two
     * runs share a selection, so the second finds it already snapped and
     * `applySnap` declines to write a selection that is already where it
     * belongs — applying twice mutates once. */
    expect(selection.mutations).toBe(1)
  })
})

/**
 * Provenance gates the SNAP, never the publish.
 *
 * Two guarantees meet at `pointerup` and they are not the same guarantee:
 *
 * 1. **A keyboard selection is never snapped.** WI-7's, and the reason
 *    `isPointerProduced()` exists at all.
 * 2. **A pointer gesture always publishes.** Older than this feature —
 *    `pointerup` used to call `publish` directly — and the popup is the only
 *    way a reader can mark, copy or look anything up.
 *
 * Wiring `pointerup` to schedule-only made the first one silently consume the
 * second: `deferredSnap` returns before `onSettled` when provenance reads
 * false, `onSettled` is the sole publish path, and so a pointer drag whose
 * provenance happens to read false produced **no toolbar at all** rather than
 * an unsnapped one. Two orderings reach it, and neither is exotic:
 *
 * - `pointerdown → pointerup → selectionchange`, because WebKit fires
 *   `selectionchange` asynchronously — the very asynchrony
 *   `gestureProvenance.ts` documents as the reason it compares a token instead
 *   of clearing one.
 * - `pointerdown → keydown → selectionchange → pointerup`, which is any
 *   keystroke during a drag, modifier keys included.
 *
 * So the cases below assert what `onSelection` was actually handed, at the
 * session, rather than what any one module returned: all three publish, and
 * only the third snaps. That last one overlaps the block above on purpose —
 * "publishes but does not snap" is only meaningful next to "publishes and
 * snaps", and a fix that quietly stopped snapping would satisfy the first two
 * alone.
 *
 * **Live-lane partner: none, and there cannot be one.** Every ordering here is
 * a claim about how WebKit sequences real events, and the bridge dispatches
 * `isTrusted: false` ones that produce no native selection at all.
 * **Permanently unmet**; `dev-docs/manual-selection-checklist.md` §1 — rows
 * 1.13 and 1.10 in particular — is the only cover.
 */
describe('ReaderSession — a pointer gesture always publishes', () => {
  const WORDS = 'the quick brown fox'

  interface Gesture {
    readonly doc: FakeDocument
    readonly selection: FakeSelection
    readonly cb: ReturnType<typeof callbacks>
  }

  /** A section over `'the quick brown fox'` with `'ick bro'` selected. */
  async function gesture(): Promise<Gesture> {
    const fixture = buildFixture(elem('p', { id: 'para' }, [txt(WORDS)]))
    const words = fixture.text(WORDS)
    const selection = selectionOver({ node: words, offset: 6 }, { node: words, offset: 13 })
    const doc = fakeDocument({ selection })
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))
    view.emit('load', { doc: doc.asDocument(), index: 0 })
    return { doc, selection, cb }
  }

  /** The macrotask WI-8 parks the snap in — real, as in the block above. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  const UNSNAPPED = {
    cfi: 'cfi(0:ick bro)',
    sectionIndex: 0,
    text: 'ick bro',
    prefix: 'the qu',
    suffix: 'wn fox',
  }
  const SNAPPED = {
    cfi: 'cfi(0:quick brown)',
    sectionIndex: 0,
    text: 'quick brown',
    prefix: 'the ',
    suffix: ' fox',
  }

  /*
   * `KeyboardEvent` and `window`, for the length of this block.
   *
   * `#watchKeys` forwards every keydown by constructing a real `KeyboardEvent`
   * and dispatching it on the host `window`, and this lane has neither global —
   * which is why the block above avoids keydown entirely (see its note at the
   * `keyup` case). This block cannot avoid it: "a keystroke arrives mid-drag"
   * IS one of the two orderings. Both stubs are host APIs rather than modules
   * of ours, the same permitted substitution as the fake timers elsewhere, and
   * they are removed again after every case so nothing leaks into a file that
   * asserts these globals are absent.
   */
  beforeEach(() => {
    class StubKeyboardEvent extends Event {
      constructor(type: string, init: EventInit = {}) {
        super(type, init)
      }
    }
    vi.stubGlobal('KeyboardEvent', StubKeyboardEvent)
    vi.stubGlobal('window', new EventTarget())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('publishes unsnapped when the selectionchange lands after the pointer is up', async () => {
    const { doc, selection, cb } = await gesture()

    doc.dispatch('pointerdown')
    doc.dispatch('pointerup')
    /* WebKit's trailing `selectionchange`. It arrives with the pointer already
     * up, so provenance never takes a token and the snap is correctly refused —
     * what must NOT follow is the toolbar going with it. */
    doc.dispatch('selectionchange')
    await settle()

    expect(published(cb)).toEqual([{ ...UNSNAPPED, range: selection.getRangeAt(0) }])
    expect(selection.mutations).toBe(0)
  })

  it('publishes unsnapped when a keystroke interrupts the drag', async () => {
    const { doc, selection, cb } = await gesture()

    doc.dispatch('pointerdown')
    // Escape, shift, anything at all: `abandon` drops the pointer flag, so the
    // selectionchange after it is not recorded as pointer-produced.
    doc.dispatch('keydown')
    doc.dispatch('selectionchange')
    doc.dispatch('pointerup')
    await settle()

    expect(published(cb)).toEqual([{ ...UNSNAPPED, range: selection.getRangeAt(0) }])
    expect(selection.mutations).toBe(0)
  })

  it('publishes snapped when the selectionchange lands inside the gesture', async () => {
    const { doc, selection, cb } = await gesture()

    doc.dispatch('pointerdown')
    doc.dispatch('selectionchange')
    doc.dispatch('pointerup')
    await settle()

    expect(published(cb)).toEqual([{ ...SNAPPED, range: selection.getRangeAt(0) }])
    expect(selection.mutations).toBe(1)
  })
})

/**
 * What `publish()` publishes — pinned, then changed on purpose.
 *
 * `#watchSelection` had no test of its own until WI-7, and the cases below were
 * written **before** WI-9 touched it, because "no regression" is not a claim
 * anyone can check against unpinned behaviour. Each one either survives the
 * change untouched — which is what makes it a regression test — or is listed in
 * WI-9's report with the reason it legitimately moved.
 *
 * The three that must never move are here for that reason: a punctuation-only
 * selection still publishes its punctuation, a whitespace-only one still
 * publishes `null`, and a collapse still clears the popup in the same turn
 * rather than a macrotask later.
 *
 * **Live-lane partner: partly the `live` lane, and no further.** Every case
 * drives fake events over a fake `Selection`. The block-boundary text
 * derivation is measured for real by `scripts/word-snap-live.mjs`
 * (`block-merge`, `br-merge`); the **drag** that produces the selection is
 * unreachable from any harness, since the Tauri MCP bridge dispatches
 * `isTrusted: false` events which produce no native selection. That half is
 * permanently unmet — `dev-docs/manual-selection-checklist.md` §1 — and the
 * live lane is manual-only besides.
 */
describe('ReaderSession publishes the selection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  interface Scene {
    readonly doc: FakeDocument
    readonly view: ReturnType<typeof fakeView>
    readonly cb: ReturnType<typeof callbacks>
    readonly session: ReaderSession
    readonly selection: FakeSelection
    /** A completed mouse drag, in WebKit's event order. It does NOT flush
     *  timers: when the snapshot appears is half of what these cases assert,
     *  so every flush is written out at the call site. */
    readonly drag: () => void
  }

  async function sectionOver(selection: FakeSelection): Promise<Scene> {
    const doc = fakeDocument({ selection })
    const view = fakeView()
    const cb = callbacks()
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))
    view.emit('load', { doc: doc.asDocument(), index: 0 })
    return {
      doc,
      view,
      cb,
      session,
      selection,
      drag: () => {
        doc.dispatch('pointerdown')
        doc.dispatch('selectionchange')
        doc.dispatch('pointerup')
      },
    }
  }

  /** A one-paragraph fixture and a selection over part of its only text node. */
  function overOneBlock(
    data: string,
    from: number,
    to: number,
  ): { selection: FakeSelection; node: Text } {
    const fixture = buildFixture(elem('p', { id: 'para' }, [txt(data)]))
    const node = fixture.text(data)
    return { selection: selectionOver({ node, offset: from }, { node, offset: to }), node }
  }

  const PUNCTUATED = 'a + b'

  describe('characterization — pinned before WI-9 changed publish()', () => {
    it('publishes nothing but nulls when the gesture ends with the selection collapsed', async () => {
      const { selection } = overOneBlock('the quick brown fox', 9, 9)
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      /* TWO nulls, and the count is pinned rather than tidied: the drag's
       * `selectionchange` clears the popup and the end of the gesture publishes
       * the collapsed selection as another null. Both are real calls today and
       * both must survive — an implementation that stopped publishing at the
       * end of a gesture would lose the popup for every selection that is not
       * snappable, and this is the cheapest place that shows it. */
      expect(published(scene.cb)).toEqual([null, null])
    })

    it('publishes null for a whitespace-only selection', async () => {
      /* `'a + b'.slice(1, 2)` — the space before the plus. Trimmed to nothing,
       * so there is no text to hang a popup on. */
      const { selection } = overOneBlock(PUNCTUATED, 1, 2)
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      expect(published(scene.cb)).toEqual([null])
    })

    it('publishes a punctuation-only selection exactly as it stands', async () => {
      /*
       * THE BASELINE. This literal is what WI-9's "a null snap changes nothing"
       * case is measured against, and it is why that case is a real assertion
       * rather than a restatement of the implementation: `'+'` has no word-like
       * segment anywhere in it, so the snap declines — and an implementation
       * that published `null` because the snap said `null` would silently take
       * the popup away from every punctuation and CJK selection in the book.
       */
      const { selection } = overOneBlock(PUNCTUATED, 2, 3)
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      expect(published(scene.cb)).toEqual([
        {
          cfi: 'cfi(0:+)',
          sectionIndex: 0,
          text: '+',
          prefix: 'a ',
          suffix: ' b',
          range: selection.getRangeAt(0),
        },
      ])
    })

    it('publishes null the moment the selection collapses, without waiting for a timer', async () => {
      /*
       * Click-to-dismiss. The assertion is sampled BEFORE any timer advance,
       * and that timing is the whole case: routing the clear through the same
       * deferral as the snap would make dismissing the popup lag by a frame,
       * undoing the split `#watchSelection` documents at `session.ts:512`.
       */
      const { selection } = overOneBlock('the quick brown fox', 6, 13)
      const scene = await sectionOver(selection)
      const { selection: collapsed } = overOneBlock('another paragraph entirely', 3, 3)

      scene.doc.defaultView?.setSelection(collapsed)
      scene.doc.dispatch('selectionchange')

      expect(published(scene.cb)).toEqual([null])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('publishes nothing at all once the session is disposed', async () => {
      const { selection } = overOneBlock('the quick brown fox', 6, 13)
      const scene = await sectionOver(selection)

      scene.session.dispose()
      scene.drag()
      vi.runAllTimers()

      // The single null is disposal's own — see `dispose()`.
      expect(published(scene.cb)).toEqual([null])
      expect(selection.mutations).toBe(0)
    })
  })

  describe('WI-9 — the snapped selection, published consistently', () => {
    const WORDS = 'the quick brown fox'

    /** `'the quick brown fox'.slice(6, 13)` — a drag that starts and ends
     *  inside a word, which is what a reader's drag almost always is. */
    const partialWords = () => overOneBlock(WORDS, 6, 13)

    it('publishes the snapped words, not the drag`s partial ones', async () => {
      const { selection } = partialWords()
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      const snapshot = published(scene.cb)[0]
      expect(snapshot?.text).toBe('quick brown')
      expect(snapshot?.text).not.toBe('ick bro')
      // One call, not two: the popup appears once, over the snapped words,
      // rather than appearing at the drag's boundaries and then jumping.
      expect(published(scene.cb)).toHaveLength(1)
    })

    it('publishes a cfi and a range that describe the snapped selection too', async () => {
      /*
       * The trap this work item exists for. `setBaseAndExtent` DETACHES a
       * previously captured `Range` — measured in WebKit, modelled in
       * `selectionFake.testkit.ts` — and the captured one keeps returning the
       * OLD text. So a `publish()` that held its range across the snap stores a
       * cfi and a text describing a selection the reader never made, under a
       * range that looks snapped.
       *
       * The fake `getCFI` is keyed on the range's text (see `fakeView`), which
       * is what makes the first assertion able to fail at all.
       */
      const { selection } = partialWords()
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      const snapshot = published(scene.cb)[0]
      expect(snapshot?.cfi).toBe('cfi(0:quick brown)')
      expect(snapshot?.cfi).not.toBe('cfi(0:ick bro)')
      // The range as well, so all three agree. `slice(4, 15)` is 'quick brown'.
      expect(snapshot?.range.toString()).toBe('quick brown')
      expect([snapshot?.range.startOffset, snapshot?.range.endOffset]).toEqual([4, 15])
      expect(selection.mutations).toBe(1)
    })

    it('does not snap inside the pointerup listeners — the write waits a macrotask', async () => {
      /* WI-8's reason, asserted where it is consumed: foliate's paginator turns
       * the page when a `selectionchange` arrives while its own pointer flag is
       * still up (`paginator.js:586`), and the flag comes down only once every
       * `pointerup` listener has run. The pair of samples IS the assertion —
       * either half alone passes for an implementation that never snaps. */
      const { selection } = partialWords()
      const scene = await sectionOver(selection)

      scene.drag()
      expect(selection.mutations).toBe(0)
      expect(published(scene.cb)).toEqual([])

      vi.runAllTimers()
      expect(selection.mutations).toBe(1)
      expect(published(scene.cb)).toHaveLength(1)
    })

    it('joins across a block boundary with a separator', async () => {
      /* `range.toString()` merges blocks: `<p>all done</p><p>Start here</p>`
       * really does yield `'all doneStart here'` in WebKit. That is a
       * pre-existing defect in stored mark text and in Copy, and WI-5's
       * flattener is what makes it cheap to fix here. */
      const fixture = buildFixture(
        elem('div', { id: 'page' }, [
          elem('p', { id: 'first' }, [txt('all done')]),
          elem('p', { id: 'second' }, [txt('Start here')]),
        ]),
      )
      const selection = selectionOver(
        { node: fixture.text('all done'), offset: 4 },
        { node: fixture.text('Start here'), offset: 5 },
      )
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      const snapshot = published(scene.cb)[0]
      expect(snapshot?.text).toBe('done\nStart')
      expect(snapshot?.text).not.toBe('doneStart')
      // The defect is in the RANGE's own text, which is left exactly as it is:
      // the fix belongs to what is published, not to where the highlight sits.
      expect(snapshot?.range.toString()).toBe('doneStart')
    })

    it('joins across a <br> with a separator', async () => {
      const fixture = buildFixture(
        elem('p', { id: 'para' }, [txt('one'), elem('br'), txt('two')]),
      )
      const selection = selectionOver(
        { node: fixture.text('one'), offset: 0 },
        { node: fixture.text('two'), offset: 3 },
      )
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      const snapshot = published(scene.cb)[0]
      expect(snapshot?.text).toBe('one\ntwo')
      expect(snapshot?.text).not.toBe('onetwo')
    })

    it('strips a soft hyphen from the text and leaves it in the range', async () => {
      /*
       * U+00AD is invisible, and UAX #29 ignores it (WB4, General_Category
       * `Cf`), so a snapped word legitimately contains one. It must go from the
       * published text — which becomes the stored mark text and what Copy puts
       * on the clipboard — and must NOT go from the range, which cannot be done
       * without moving the highlight's boundaries. The offset assertion is what
       * catches an implementation that mangled the range too: asserting only
       * the text would pass for one.
       */
      const { selection } = overOneBlock('hyphen­ation here', 2, 8)
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      const snapshot = published(scene.cb)[0]
      expect(snapshot?.text).toBe('hyphenation')
      expect(snapshot?.range.toString()).toContain('­')
      expect([snapshot?.range.startOffset, snapshot?.range.endOffset]).toEqual([0, 12])
    })

    it('publishes a punctuation-only selection unchanged when the snap declines', async () => {
      /*
       * The same value the characterization case above pinned, reached through
       * the wired path. **The easiest bug in this work item to introduce and
       * the hardest to notice**: publishing `null` because the snap returned
       * `null` silently takes the popup away from every punctuation and CJK
       * selection in the book.
       */
      const { selection } = overOneBlock(PUNCTUATED, 2, 3)
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      expect(published(scene.cb)).toEqual([
        {
          cfi: 'cfi(0:+)',
          sectionIndex: 0,
          text: '+',
          prefix: 'a ',
          suffix: ' b',
          range: selection.getRangeAt(0),
        },
      ])
      expect(selection.mutations).toBe(0)
    })

    it('leaves a CJK selection exactly where the reader put it', async () => {
      /* Han has no visible word boundaries, so WI-1's script gate blocks it and
       * both edges stay put — "no edge moved" is not the same answer as "there
       * was nothing to snap to", and this is the downstream consequence of
       * WI-3 keeping the two apart. */
      const { selection } = overOneBlock('中文测试', 1, 3)
      const scene = await sectionOver(selection)

      scene.drag()
      vi.runAllTimers()

      expect(published(scene.cb)[0]?.text).toBe('文测')
      expect(selection.mutations).toBe(0)
    })

    it('arms no snap for a keyup — shift+arrow stays character-granular', async () => {
      const { selection } = partialWords()
      const scene = await sectionOver(selection)

      scene.doc.dispatch('selectionchange')
      scene.doc.dispatch('keyup')

      expect(vi.getTimerCount()).toBe(0)
      expect(published(scene.cb)).toEqual([
        {
          cfi: 'cfi(0:ick bro)',
          sectionIndex: 0,
          text: 'ick bro',
          prefix: 'the qu',
          suffix: 'wn fox',
          range: selection.getRangeAt(0),
        },
      ])

      vi.runAllTimers()
      expect(selection.mutations).toBe(0)
      expect(published(scene.cb)).toHaveLength(1)
    })

    it('drops a pending snap when the session is disposed before it runs', async () => {
      /*
       * WI-8's `cancel()`, wired through `#onTeardown` — the registration that
       * makes disposal and section teardown one path. Without it the timer
       * still fires after the book is closed and `applySnap` writes to a
       * selection in a document nobody is reading: `publish()`'s disposal latch
       * would hide the publish but not the WRITE, which is why the mutation
       * counter is asserted here and not just the call log.
       */
      const { selection } = partialWords()
      const scene = await sectionOver(selection)

      scene.drag()
      expect(vi.getTimerCount()).toBe(1)
      scene.session.dispose()

      expect(vi.getTimerCount()).toBe(0)
      vi.runAllTimers()
      expect(selection.mutations).toBe(0)
      expect(published(scene.cb)).toEqual([null])
    })

    it('drops a pending snap when the section goes away before it runs', async () => {
      /* The same registration, reached by the other route: `pagehide` releases
       * a document's teardown list as foliate moves to the next section. */
      const { selection } = partialWords()
      const scene = await sectionOver(selection)

      scene.drag()
      scene.doc.defaultView?.dispatch('pagehide')

      expect(vi.getTimerCount()).toBe(0)
      vi.runAllTimers()
      expect(selection.mutations).toBe(0)
      expect(published(scene.cb)).toEqual([])
    })
  })

  /**
   * WI-11 — a PDF page repainting underneath a selection.
   *
   * `paint` bumps the page document's render generation at the top of every
   * repaint and then, once the canvas is drawn, calls `replaceChildren()` on
   * the `.textLayer` — destroying every node a snapped selection points at.
   * Two things must follow, and they fail for opposite half-implementations:
   *
   * - a snap pending across that window is **cancelled by the generation**,
   *   with the nodes still perfectly attached, and
   * - a snapshot already on screen is **invalidated**, so the popup does not
   *   float over a page that has been re-laid-out underneath it.
   *
   * The fixture is `div#textLayer > p#para > text` for the reason WI-8's is:
   * replacing the container's children leaves the paragraph and its text linked
   * to each other and severed from the document — the shape `replaceChildren()`
   * produces, and the only one that reaches `applySnap`'s connectivity guard
   * rather than its "no element above this node" one.
   *
   * **Live-lane partner: none, and there cannot be one.** That a real zoom on a
   * real PDF leaves no stale highlight lives in pdf.js and WebKit and is not
   * provable in process at any level of effort. The `live` lane exists
   * (`scripts/word-snap-live.mjs`) and does not reach it either — it needs a
   * selection made by a gesture, and the bridge dispatches `isTrusted: false`
   * events. No case below claims it. **Permanently unmet**, covered only by
   * `dev-docs/manual-selection-checklist.md` rows 2.5 – 2.8.
   */
  describe('WI-11 — a repaint under a live selection', () => {
    const WORDS = 'the quick brown fox'

    interface PdfScene extends Scene {
      /** What `paint` does at the top of every repaint: take a generation. */
      readonly repaint: () => void
      /** What `paint` does to the text layer once the canvas is drawn. Each
       *  call builds distinct text, because the fixture refuses duplicates. */
      readonly rebuildTextLayer: () => void
      /** Whether the words the reader dragged over are still in the document. */
      readonly attached: () => boolean
    }

    async function pdfPage(): Promise<PdfScene> {
      const fixture = buildFixture(
        elem('div', { id: 'textLayer' }, [elem('p', { id: 'para' }, [txt(WORDS)])]),
      )
      const words = fixture.text(WORDS)
      const selection = selectionOver({ node: words, offset: 6 }, { node: words, offset: 13 })
      const scene = await sectionOver(selection)
      /* The same guard `paint` builds, reached through the same document — a
       * second object over one shared counter, which is the seam's whole
       * purpose and is asserted directly in `wordSnap/invalidate.test.ts`. */
      const guard = createReflowGuard(scene.doc.asDocument())
      let painted = 0
      return {
        ...scene,
        repaint: () => void guard.bump(),
        rebuildTextLayer: () => {
          painted += 1
          fixture.replaceChildren('textLayer', [elem('p', {}, [txt(`repainted ${painted}`)])])
        },
        attached: () => words.isConnected,
      }
    }

    /*
     * The generation on its own. The nodes are deliberately left ATTACHED, so
     * `applySnap`'s connectivity check cannot be what stops the write and the
     * case can only pass if the bump reached the pending snap. The timer count
     * is asserted rather than only the mutation count, because a
     * guarded-but-live timer is a leak that looks identical from every other
     * angle — one per gesture, each retaining the page's document.
     *
     * Live partner (WI-12): "a zoom that starts and is superseded". **UNMET.**
     */
    it('cancels a pending snap when the page starts repainting, with every node still attached', async () => {
      const scene = await pdfPage()

      scene.drag()
      expect(vi.getTimerCount()).toBe(1)

      scene.repaint()

      expect(scene.attached()).toBe(true)
      expect(vi.getTimerCount()).toBe(0)

      vi.runAllTimers()
      expect(scene.selection.mutations).toBe(0)
      expect(scene.selection.toString()).toBe('ick bro')
      expect(published(scene.cb)).toEqual([])
    })

    /*
     * Cancelled, not disabled. Without the second gesture an implementation
     * that latched off after the first repaint — every zoom permanently
     * stopping word snapping for that page — passes the case above.
     */
    it('still snaps the next gesture after a repaint', async () => {
      const scene = await pdfPage()

      scene.drag()
      scene.repaint()
      vi.runAllTimers()
      expect(scene.selection.mutations).toBe(0)

      scene.drag()
      vi.runAllTimers()

      expect(scene.selection.mutations).toBe(1)
      expect(published(scene.cb)).toHaveLength(1)
      expect(published(scene.cb)[0]?.text).toBe('quick brown')
    })

    /*
     * The popup, and the reason this is not already covered elsewhere:
     * `useMarking.ts` clears the selection on a DOCUMENT change, and a
     * text-layer rebuild is not a document change. Without this the snapshot
     * survives the zoom holding a range whose nodes have left the document, and
     * the popup sits over a page that has been re-laid-out under it.
     *
     * The exact call sequence is asserted, not the last call: `[snapshot, null]`
     * says the popup appeared once and was cleared once.
     *
     * Live partner (WI-12): "zoom a real PDF with a live selection and confirm
     * no stale popup". **UNMET.**
     */
    it('clears a published snapshot when the text layer under it is rebuilt', async () => {
      const scene = await pdfPage()

      scene.drag()
      vi.runAllTimers()
      const snapshot = published(scene.cb)[0]
      expect(snapshot?.text).toBe('quick brown')

      scene.repaint()
      scene.rebuildTextLayer()

      expect(scene.attached()).toBe(false)
      expect(published(scene.cb)).toEqual([snapshot, null])
    })

    /*
     * Once, not once per step. A pinch is a stream of repaints, and clearing
     * unconditionally on each of them is the lazy way to pass the case above —
     * it churns the popup state continuously while the reader zooms.
     */
    it('clears it once, however many zoom steps follow', async () => {
      const scene = await pdfPage()

      scene.drag()
      vi.runAllTimers()
      const snapshot = published(scene.cb)[0]

      for (let step = 0; step < 5; step += 1) {
        scene.repaint()
        scene.rebuildTextLayer()
      }

      expect(published(scene.cb)).toEqual([snapshot, null])
    })

    /*
     * The popup the reader already dismissed is not dismissed a second time.
     * A click elsewhere collapses the selection and clears it through
     * `selectionchange`; a zoom after that has nothing left to take down. It
     * fails for a `publish` whose "is a popup up?" flag is only maintained on
     * the snapshot path, which is the plausible near-miss — the clear would go
     * straight to the callback and leave the flag saying `true` forever.
     */
    it('does not clear twice when the reader dismissed the popup before zooming', async () => {
      const scene = await pdfPage()

      scene.drag()
      vi.runAllTimers()
      const snapshot = published(scene.cb)[0]
      expect(snapshot?.text).toBe('quick brown')

      // A click elsewhere in the page: the selection collapses, the popup goes.
      const words = scene.selection.getRangeAt(0).startContainer
      scene.doc.defaultView?.setSelection(
        selectionOver({ node: words, offset: 0 }, { node: words, offset: 0 }),
      )
      scene.doc.dispatch('selectionchange')
      expect(published(scene.cb)).toEqual([snapshot, null])

      scene.repaint()
      scene.rebuildTextLayer()

      expect(published(scene.cb)).toEqual([snapshot, null])
    })

    /*
     * A zoom with nothing selected is silent. `onSelection(null)` on every
     * repaint would fire on every zoom step of every page, whether or not the
     * reader had ever selected anything.
     *
     * Live partner (WI-12): "zoom with nothing selected". **UNMET.**
     */
    it('publishes nothing at all for a repaint with nothing selected', async () => {
      const scene = await pdfPage()

      scene.repaint()
      scene.rebuildTextLayer()
      scene.repaint()
      scene.rebuildTextLayer()

      expect(scene.cb.calls['onSelection']).toBeUndefined()
    })

    /*
     * The belt, with the braces deliberately removed. No generation is taken
     * here, so the cancellation cannot be what saves this: the text layer is
     * simply gone by the time the macrotask runs, and both `applySnap`'s
     * run-time connectivity check and the publish must notice on their own.
     *
     * The published value is what changed. A snap that declines still settles,
     * and `publish` used to store whatever range the selection held — which
     * here describes text nobody can see any more.
     *
     * Live partner (WI-12): "zoom a real PDF mid-gesture". **UNMET.**
     */
    it('publishes nothing rather than a stale snapshot when the snap settles over nodes that have gone', async () => {
      const scene = await pdfPage()

      scene.drag()
      scene.rebuildTextLayer()
      vi.runAllTimers()

      expect(scene.attached()).toBe(false)
      expect(scene.selection.mutations).toBe(0)
      expect(scene.selection.toString()).toBe('ick bro')
      expect(published(scene.cb)).toEqual([null])
    })

    /*
     * BOTH ends, which is why `connectedRange` is an `&&`. A selection spanning
     * two blocks where a re-render takes only the second one leaves a range
     * with one live boundary and one dead one — not a half-success but a
     * selection nobody can see, and `applySnap` refuses to write one for the
     * same reason.
     *
     * It is also the crash path. `rangeText` falls back to `range.toString()`
     * when the flattener cannot reach both edges, and a range whose ends are in
     * two different trees has no text: WebKit answers with something arbitrary
     * and the modelled fake throws outright. `publish` runs from a timer and
     * from event listeners, where a throw has nowhere to go.
     */
    it('publishes nothing when a re-render takes away one end of the selection', async () => {
      const fixture = buildFixture(
        elem('div', { id: 'textLayer' }, [
          elem('p', { id: 'first' }, [txt('all done')]),
          elem('p', { id: 'second' }, [txt('Start here')]),
        ]),
      )
      const selection = selectionOver(
        { node: fixture.text('all done'), offset: 4 },
        { node: fixture.text('Start here'), offset: 5 },
      )
      const scene = await sectionOver(selection)

      // Only the SECOND paragraph is rebuilt: the start boundary stays put.
      fixture.replaceChildren('second', [txt('rebuilt')])
      expect(fixture.text('all done').isConnected).toBe(true)
      expect(fixture.text('Start here').isConnected).toBe(false)

      scene.doc.dispatch('keyup')

      expect(published(scene.cb)).toEqual([null])
    })

    /*
     * The repaint listener comes off with everything else. It is not a DOM
     * listener, so `LOADED_DOCUMENT_LISTENERS` cannot see it and the leak it
     * would cause — one live watcher per section the reader passes through,
     * each retaining a document — is invisible from every other angle. Exactly
     * the class of leak `#onTeardown`'s own `pagehide` note records.
     */
    it('stops listening for repaints when the section goes away', async () => {
      const scene = await pdfPage()

      scene.drag()
      vi.runAllTimers()
      const snapshot = published(scene.cb)[0]

      scene.doc.defaultView?.dispatch('pagehide')
      scene.repaint()
      scene.rebuildTextLayer()

      expect(published(scene.cb)).toEqual([snapshot])
    })

    /* The same registration reached by the other route: a section re-loaded
     * runs `#resetWatchers` first, so returning to a page must not leave two
     * watchers reacting to one repaint. */
    it('does not stack a repaint listener each time the section is re-loaded', async () => {
      const scene = await pdfPage()
      scene.view.emit('load', { doc: scene.doc.asDocument(), index: 0 })
      scene.view.emit('load', { doc: scene.doc.asDocument(), index: 0 })

      scene.drag()
      vi.runAllTimers()
      const snapshot = published(scene.cb)[0]
      expect(snapshot?.text).toBe('quick brown')

      scene.repaint()

      expect(published(scene.cb)).toEqual([snapshot, null])
    })
  })
})

/**
 * Every metadata field a book declared nothing for.
 *
 * Spread into the three cases below so each one states only what it is about.
 * Before this, each restated the entire `BookMeta` shape, so widening that type
 * failed three tests that had no opinion about the new fields — a shape assertion
 * pretending to be a behaviour assertion.
 */
const NO_META = {
  title: '',
  author: '',
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
  pageCount: 0,
}

describe('readMeta', () => {
  it('reads a page count, which only a PDF has', () => {
    /* `makePdf` is the only backend that sets it. Non-zero is what tells a
       citation the book can be cited by page at all — reflowable text has no
       page, because there the page is a property of the window. */
    expect(readMeta({ metadata: { pageCount: 412 } }).pageCount).toBe(412)
    expect(readMeta({ metadata: {} }).pageCount).toBe(0)
  })

  it('refuses a page count that is not a whole positive number', () => {
    // Storage and a book's own metadata are both untrusted; 0 means "no pages".
    for (const bad of [0, -3, 1.5, Number.NaN, Infinity, '12', null]) {
      expect(readMeta({ metadata: { pageCount: bad } }).pageCount).toBe(0)
    }
  })

  it('reads plain strings', () => {
    expect(readMeta({ metadata: { title: 'Moby-Dick', author: 'Melville' } })).toEqual({
      ...NO_META,
      title: 'Moby-Dick',
      author: 'Melville',
      identifier: '',
    })
  })

  it('reads a language map for the title', () => {
    expect(readMeta({ metadata: { title: { en: 'Whale' } } }).title).toBe('Whale')
  })

  it('reads an author object and a list of authors', () => {
    expect(readMeta({ metadata: { author: { name: 'Melville' } } }).author).toBe('Melville')
    expect(
      readMeta({ metadata: { author: [{ name: 'A' }, { name: 'B' }] } }).author,
    ).toBe('A, B')
  })

  it('returns empty strings rather than undefined when metadata is absent', () => {
    expect(readMeta({})).toEqual(NO_META)
  })

  /* The work's own identifier, which foliate parses out of the OPF and this
   * function used to throw away. It is what sharing between two READERS has to
   * be keyed on — `bookId` is the bytes, and two people never hold the same
   * bytes — so losing it here lost it everywhere. */
  it('keeps the work identifier the book declares', () => {
    expect(
      readMeta({ metadata: { title: 'T', identifier: 'urn:uuid:9f2a' } }).identifier,
    ).toBe('urn:uuid:9f2a')
  })

  /**
   * The fields foliate has been parsing all along while Paper discarded them.
   *
   * Every one of these comes out of an OPF a stranger wrote, so the cases below
   * are half "does it read the field" and half "what happens when the field is
   * hostile". The second half is the one that matters for a store which is read
   * whole and rewritten on every position save.
   */
  describe('the fields a library is built out of', () => {
    it('reads a series and its position', () => {
      const md = { belongsTo: { series: { name: 'Discworld', position: 5 } } }
      expect(readMeta({ metadata: md })).toMatchObject({ series: 'Discworld', seriesIndex: 5 })
    })

    /* EPUB allows a fractional position for a novella between two books, so
     * this is a float rather than an index into anything. */
    it('keeps a fractional series position', () => {
      const md = { belongsTo: { series: { name: 'S', position: 1.5 } } }
      expect(readMeta({ metadata: md }).seriesIndex).toBe(1.5)
    })

    it('takes the first when a book declares several series', () => {
      const md = { belongsTo: { series: [{ name: 'First' }, { name: 'Second' }] } }
      expect(readMeta({ metadata: md }).series).toBe('First')
    })

    /* A position that is not a number must not survive as NaN: it would
     * serialise to `null` through JSON and compare false against itself. */
    it('refuses a non-numeric series position', () => {
      const md = { belongsTo: { series: { name: 'S', position: 'later' } } }
      expect(readMeta({ metadata: md }).seriesIndex).toBeNull()
    })

    it('reads subjects, publisher, languages and the sort title', () => {
      const md = {
        subject: ['Philosophy', 'Ethics'],
        publisher: 'Penguin',
        language: ['en'],
        sortAs: 'Hobbit, The',
      }
      expect(readMeta({ metadata: md })).toMatchObject({
        subjects: ['Philosophy', 'Ethics'],
        publisher: 'Penguin',
        languages: ['en'],
        sortAs: 'Hobbit, The',
      })
    })

    /* An OPF may repeat a subject once per language. Shown twice on a row that
     * reads as a bug in the reader rather than in the book. */
    it('deduplicates repeated subjects', () => {
      expect(readMeta({ metadata: { subject: ['Ethics', 'Ethics'] } }).subjects).toEqual(['Ethics'])
    })

    it('accepts a single subject that is not in a list', () => {
      expect(readMeta({ metadata: { subject: 'Ethics' } }).subjects).toEqual(['Ethics'])
    })

    /* The date is kept as the string the book declared. EPUB dates are loosely
     * specified — `2011`, `2011-03`, and a full timestamp are all legal — and
     * parsing invents a January 1st in the reader's own timezone. */
    it('does not parse the published date into a date', () => {
      expect(readMeta({ metadata: { published: '2011' } }).published).toBe('2011')
    })

    it('caps a hostile field rather than storing it whole', () => {
      const huge = 'x'.repeat(50_000)
      const meta = readMeta({ metadata: { title: huge, description: huge } })
      expect(meta.title).toHaveLength(500)
      expect(meta.description).toHaveLength(4000)
    })

    it('caps a hostile list rather than storing every entry', () => {
      const many = Array.from({ length: 5_000 }, (_, i) => `tag-${i}`)
      expect(readMeta({ metadata: { subject: many } }).subjects).toHaveLength(32)
    })

    it('survives a book that declares none of them', () => {
      expect(readMeta({ metadata: { title: 'T' } })).toMatchObject({
        series: '',
        seriesIndex: null,
        subjects: [],
        languages: [],
      })
    })
  })

  it('treats a malformed identifier as no identifier', () => {
    // A package can put anything here; the rest of this function is defensive
    // about exactly that and this field is no different.
    for (const bad of [42, null, {}, ['a'], undefined]) {
      expect(readMeta({ metadata: { identifier: bad } }).identifier).toBe('')
    }
  })
})

/**
 * Which way a section's text runs.
 *
 * THREE SOURCES AND AN ORDER between them, which is the whole of it. The
 * ribbon positions itself against the PAGE rather than the window — its CSS is
 * written with `inset-inline-end` — so an RTL book reported as LTR puts it at
 * the wrong corner of the page it marks, with the arithmetic that finds the
 * page's edge mirrored along with it.
 *
 * Shaped objects rather than a jsdom document: what is under test is which of
 * the three is believed, and each case here is one of them contradicting
 * another. A real document would have to be coaxed into these states through
 * the very cascade this is deciding how to read.
 */
describe('directionOf', () => {
  const asDoc = (over: {
    computed?: string
    htmlDir?: string | null
    bodyDir?: string | null
    root?: boolean
  }): Document => {
    const html =
      over.root === false
        ? null
        : ({ getAttribute: () => over.htmlDir ?? null } as unknown as HTMLElement)
    return {
      documentElement: html,
      body: over.bodyDir === undefined ? null : { getAttribute: () => over.bodyDir },
      defaultView: over.computed
        ? { getComputedStyle: () => ({ direction: over.computed }) }
        : null,
    } as unknown as Document
  }

  it('believes what the page COMPUTED to, over what it declared', () => {
    /* The author's stylesheet has had its say by the time a section renders,
       and it can overrule the attribute in either direction. */
    expect(directionOf(asDoc({ computed: 'rtl', htmlDir: 'ltr' }))).toBe('rtl')
    expect(directionOf(asDoc({ computed: 'ltr', htmlDir: 'rtl' }))).toBe('ltr')
  })

  it('falls back to the declared direction with no view to compute against', () => {
    // A section that failed to parse hands back a document with no window.
    expect(directionOf(asDoc({ htmlDir: 'rtl' }))).toBe('rtl')
    expect(directionOf(asDoc({ bodyDir: 'rtl' }))).toBe('rtl')
  })

  it('answers ltr for a document that says nothing, and for one with no root', () => {
    expect(directionOf(asDoc({}))).toBe('ltr')
    expect(directionOf(asDoc({ root: false }))).toBe('ltr')
  })
})
