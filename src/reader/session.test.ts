import { describe, expect, it } from 'vitest'
import type { View } from 'foliate-js/view.js'
import { ReaderSession, readMeta } from './session'
import type { MarkAnchor, SessionCallbacks } from './session'

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
  turns: { next: number; prev: number }
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
  'open' | 'init' | 'close' | 'goTo' | 'next' | 'prev' | 'search' | 'addAnnotation' | 'getCFI' | 'deselect'
>

function fakeView(overrides: Partial<Record<'open' | 'init', () => Promise<void>>> = {}): FakeView {
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  const view: ViewCalls & Omit<FakeView, keyof View> & Record<string, unknown> = {
    style: {} as CSSStyleDeclaration,
    closed: 0,
    removed: 0,
    turns: { next: 0, prev: 0 },
    listeners,
    book: { toc: [{ label: 'One', href: 'a.xhtml' }], metadata: { title: 'T', author: 'A' } },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      ;(listeners[type] ??= []).push(fn)
    },
    emit: (type: string, detail: unknown) => {
      for (const fn of listeners[type] ?? []) fn({ detail })
    },
    open: overrides.open ?? (() => Promise.resolve()),
    init: overrides.init ?? (() => Promise.resolve()),
    goTo: () => Promise.resolve(),
    next: () => {
      view.turns.next += 1
      return Promise.resolve()
    },
    prev: () => {
      view.turns.prev += 1
      return Promise.resolve()
    },
    // eslint-disable-next-line require-yield
    search: async function* () {
      return
    },
    annotations: [] as { value: string; kind: string; remove: boolean }[],
    deselected: 0,
    addAnnotation(annotation: unknown, remove = false) {
      view.annotations.push({ ...(annotation as { value: string; kind: string }), remove })
      return Promise.resolve()
    },
    getCFI: (index: number) => `cfi(${index})`,
    deselect() {
      view.deselected += 1
    },
    close() {
      view.closed += 1
    },
    remove() {
      view.removed += 1
    },
    renderer: { setAttribute: () => {}, setStyles: () => {} },
  }
  return view as unknown as FakeView
}

const PALETTE = { highlight: '#F3E6C0', companion: '#9E5A16', highlightAsRule: false }

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
    onError: rec('onError'),
    onNavigator: rec('onNavigator'),
    onSelection: rec('onSelection'),
    onMarkDrawn: rec('onMarkDrawn'),
    onMarkActivated: rec('onMarkActivated'),
    onFileDropped: rec('onFileDropped'),
    getMarks: () => marks,
    getPalette: () => PALETTE,
  }
  return Object.assign(cb, { calls })
}

const painters = { highlight: 'HIGHLIGHT', underline: 'UNDERLINE' }

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
    expect(cb.calls['onMeta']?.[0]?.[0]).toEqual({ title: 'T', author: 'A' })
    const nav = cb.calls['onNavigator']?.[0]?.[0] as {
      goTo: unknown
      search: unknown
      next: () => void
      prev: () => void
    }
    expect(nav.goTo).toBeTypeOf('function')
    expect(nav.search).toBeTypeOf('function')

    // Called, not merely present. These are what the arrow keys are wired to,
    // and a published callback that throws on the first press is the failure
    // this exercises.
    nav.next()
    nav.prev()
    expect(view.turns).toEqual({ next: 1, prev: 1 })

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

describe('ReaderSession marks', () => {
  const anchor = (over: Partial<MarkAnchor> = {}): MarkAnchor => ({
    cfi: 'epubcfi(/6/4)',
    sectionIndex: 0,
    kind: 'highlight',
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

    expect(view.annotations).toEqual([{ value: 'here', kind: 'highlight', remove: false }])
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

  it('paints your mark as a fill and the companion\'s as a rule', async () => {
    const view = fakeView()
    const session = new ReaderSession(fakeHost(), callbacks())
    await session.start('book.epub', deps(view))

    const painted: unknown[] = []
    const draw = (fn: unknown) => painted.push(fn)
    view.emit('draw-annotation', { draw, annotation: { kind: 'highlight' }, range: null })
    view.emit('draw-annotation', { draw, annotation: { kind: 'companion' }, range: null })

    expect(painted).toEqual(['HIGHLIGHT', 'UNDERLINE'])
  })

  it('paints your mark as a rule in Night, where a fill would glare', async () => {
    const view = fakeView()
    const cb = callbacks()
    cb.getPalette = () => ({ highlight: '#8A6E2C', companion: '#D9A25E', highlightAsRule: true })
    const session = new ReaderSession(fakeHost(), cb)
    await session.start('book.epub', deps(view))

    const painted: { fn: unknown; color: unknown }[] = []
    view.emit('draw-annotation', {
      draw: (fn: unknown, options: { color: string }) => painted.push({ fn, color: options.color }),
      annotation: { kind: 'highlight' },
      range: null,
    })

    expect(painted).toEqual([{ fn: 'UNDERLINE', color: '#8A6E2C' }])
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

    expect(view.annotations).toEqual([
      { value: 'x', kind: 'highlight', remove: false },
      { value: 'x', kind: 'highlight', remove: true },
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

describe('readMeta', () => {
  it('reads plain strings', () => {
    expect(readMeta({ metadata: { title: 'Moby-Dick', author: 'Melville' } })).toEqual({
      title: 'Moby-Dick',
      author: 'Melville',
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
    expect(readMeta({})).toEqual({ title: '', author: '' })
  })
})
