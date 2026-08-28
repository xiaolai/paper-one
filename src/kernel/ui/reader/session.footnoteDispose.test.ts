import { describe, expect, it, vi } from 'vitest'
import type { View } from 'foliate-js/view.js'

/**
 * WHAT HAPPENS TO AN OPEN NOTE WHEN THE BOOK CLOSES.
 *
 * ## The leak
 *
 * ⚠️ **`dispose` NEVER RELEASED `#footnoteView`.** A footnote is rendered into
 * its own `View` — a second foliate view with its own iframe, renderer and
 * listeners — and `setFootnoteMount` puts it OUTSIDE `#host`, which is how the
 * reader draws notes in the gloss strip. So `#host.replaceChildren()` did not
 * remove it: closing a book with a note open left that note on screen, over the
 * next book, with a live iframe behind it. One per book opened, for the life of
 * the window.
 *
 * The host was not told either. `closeFootnote` skips `onFootnote(null)` once
 * `#disposed` is set, so a host holding a `FootnoteRender` for a session that
 * no longer exists drew a note nothing could close.
 *
 * ## Why the handler is mocked, and why this is its own file
 *
 * `#footnoteView` is set from `FootnoteHandler`'s `before-render` and `render`
 * events, and there is no public way in. Replacing the handler with an
 * `EventTarget` the test can dispatch on is the smallest thing that reaches the
 * state — the session's own listeners are the code under test, unchanged.
 *
 * Its own file because the mock is module-wide, and `session.test.ts` drives
 * the real handler's heuristics.
 *
 * ⚠️ **THE NOTE IS OPENED THROUGH A CLICK, not by dispatching on a handler the
 * session happens to hold.** There is a handler per request now — see
 * `NoteRequest` — so its two listeners close over the request that built it,
 * and a test that reaches for "the session's handler" is testing a session
 * that no longer exists. Going in through the `link` event is also closer to
 * what the reader does, and it is what makes the cancellation cases below
 * expressible at all.
 */

const foliate = vi.hoisted(() => ({
  handlers: [] as EventTarget[],
  /** What the next `handle` calls answer, in order — a resolved note by default. */
  answers: [] as Promise<void>[],
}))

vi.mock('foliate-js/footnotes.js', () => ({
  FootnoteHandler: class extends EventTarget {
    constructor() {
      super()
      foliate.handlers.push(this)
    }
    handle() {
      return foliate.answers.shift() ?? Promise.resolve()
    }
  },
}))

const { ReaderSession } = await import('./session')
type SessionCallbacks = import('./session').SessionCallbacks

/**
 * A note's view: closed and detached exactly the way the real one is.
 *
 * ⚠️ **COMPLETE ENOUGH FOR `before-render` TO RUN.** The session watches the
 * note's links, cleans its document and configures its renderer before the note
 * is shown, and a fake missing any of those threw INSIDE the event dispatch —
 * which is asynchronous, so the assertions still passed while vitest reported an
 * unhandled error beside them. A test that throws and passes is worse than one
 * that fails.
 */
function noteView(order: string[] = []) {
  const calls: string[] = []
  return {
    calls,
    view: {
      close: () => {
        calls.push('close')
        order.push('note.close')
      },
      remove: () => {
        calls.push('remove')
        order.push('note.remove')
      },
      addEventListener: () => {},
      style: { cssText: '' } as CSSStyleDeclaration,
      renderer: { setAttribute: () => {}, addEventListener: () => {} },
      goTo: async () => {},
    } as unknown as View,
  }
}

function fakeHost(): HTMLElement {
  const host = {
    children: [] as unknown[],
    replaceChildren(...nodes: unknown[]) {
      host.children = nodes
    },
    /* ⚠️ A NOTE IS NOT NECESSARILY A CHILD OF THIS. `appendChild` records, so a
       test can show that clearing the host would not have reached the note. */
    appended: [] as unknown[],
    appendChild(node: unknown) {
      host.appended.push(node)
      return node
    },
  }
  return host as unknown as HTMLElement
}

function callbacks() {
  const calls: Record<string, unknown[][]> = {}
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      ;(calls[name] ??= []).push(args)
    }
  /* ANNOTATED, NOT CAST. `as SessionCallbacks` on the literal would let a newly
     required callback go unimplemented — which it has, and the only signal was
     a TypeError deep inside `start`. */
  const cb: SessionCallbacks = {
    onLink: rec('onLink'),
    onExternalLink: rec('onExternalLink'),
    onFootnote: rec('onFootnote'),
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
    getMarks: () => [],
    getPalette: () => ({ fill: {}, underline: {}, wave: {} }) as never,
  }
  return { calls, cb }
}

/**
 * The book's own view, recording into `order` beside the note's so the teardown
 * sequence can be asserted whole.
 *
 * `init` REPORTS A LOCATION before it resolves, as both renderers do — the
 * paginator's `#afterScroll` and the fixed-layout `#reportLocation` both
 * dispatch `relocate` synchronously on the navigation path. A fake that
 * resolved silently modelled the defect WI-20.14 fixes, and the session now
 * treats that silence as a book that displayed nothing.
 */
const view = (order: string[] = []) => {
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  const self = {
    style: {} as CSSStyleDeclaration,
    book: {
      toc: [],
      metadata: {},
      /* THE BOOK, NOT THE RENDERER, owns the parse — object URLs, a zip
         loader, a worker — and `View.close()` never touches it. */
      destroy: () => order.push('book.destroy'),
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      ;(listeners[type] ??= []).push(fn)
    },
    /** Fire one of the view's own events, the way foliate does. */
    emit: (type: string, detail: unknown) => {
      for (const fn of listeners[type] ?? []) fn(new CustomEvent(type, { detail, cancelable: true }))
    },
    open: async () => {},
    init: async () => {
      for (const fn of listeners['relocate'] ?? []) fn(new CustomEvent('relocate', { detail: { fraction: 0 } }))
    },
    close: () => order.push('view.close'),
    remove: () => order.push('view.remove'),
    renderer: { setAttribute: () => {}, addEventListener: () => {} },
    /* `#noteFailed` navigates the book to the note's href when a note cannot
       be shown in place, so a fake without this throws inside a promise
       chain — which passes and reports an unhandled error beside it. */
    went: [] as string[],
    goTo: async (href: string) => {
      self.went.push(href)
    },
  }
  return self
}

type FakeView = ReturnType<typeof view>

/**
 * A reference anchor complete enough for the backlink test to inspect.
 *
 * `isBacklink` reads both spellings of `epub:type`, the ARIA role, and walks
 * the parent chain; `anchorRectInHost` reads `ownerDocument`, and a null one
 * is the honest answer for a fake — the popover then has no anchor rect,
 * which is a case the session already handles.
 */
const anchorEl = () =>
  ({
    getAttribute: (name: string) => (name === 'href' ? 'notes.xhtml#n1' : null),
    getAttributeNS: () => null,
    matches: () => false,
    children: [] as unknown as HTMLCollection,
    parentElement: null,
    ownerDocument: null,
  }) as unknown as HTMLAnchorElement

/** A started session, and the book view its link events go through. */
async function started(order: string[] = []) {
  foliate.handlers.length = 0
  foliate.answers.length = 0
  const host = fakeHost()
  const { cb, calls } = callbacks()
  const session = new ReaderSession(host, cb)
  const book = view(order)
  await session.start('book.epub', {
    createView: async () => book as unknown as View,
    loadPainters: () => Promise.resolve({ fill: 'FILL', underline: 'UNDERLINE', wave: 'WAVE' }) as never,
    /* THE PASS-THROUGH — `prepare` is required; see `SessionDeps.prepare`. */
    prepare: (source: unknown) => Promise.resolve(source),
    applySettings: () => {},
    applyVars: () => {},
    protection: () => Promise.resolve(null),
  })
  return { session, host, calls, book }
}

/**
 * Follow a note reference, and hand back the handler that click created.
 *
 * The `link` event is the reader's click. The session offers it to a fresh
 * `FootnoteHandler`, whose `handle` here always takes it — so the request is
 * live and its two listeners are on the handler this returns.
 */
function clickNote(book: FakeView): EventTarget {
  const before = foliate.handlers.length
  book.emit('link', { a: anchorEl(), href: 'notes.xhtml#n1' })
  const handler = foliate.handlers[before]
  expect(handler, 'the click did not reach the footnote handler').toBeDefined()
  return handler!
}

/**
 * Render into a note's view, exactly as `FootnoteHandler` does.
 *
 * ⚠️ **`before-render` CARRIES `{ view }`**, and a fake that sent something else
 * left `view` undefined — which threw inside the dispatch rather than failing an
 * assertion. Both events, in order, because `before-render` is what attaches the
 * view and `render` is what publishes it.
 */
function renderInto(handler: EventTarget, note: { view: View }) {
  handler.dispatchEvent(new CustomEvent('before-render', { detail: { view: note.view } }))
  handler.dispatchEvent(
    new CustomEvent('render', { detail: { view: note.view, href: 'notes.xhtml#n1', type: 'footnote' } }),
  )
}

/** The whole flow: a click, and the note that click asked for. */
function showNote(book: FakeView, note: { view: View }) {
  renderInto(clickNote(book), note)
}

describe('closing a book with a note open', () => {
  it('closes and detaches the note’s view', async () => {
    const { session, book } = await started()
    const note = noteView()
    showNote(book, note)
    expect(note.calls, 'the note should be up, not released').toEqual([])

    session.dispose()
    expect(note.calls, 'a note view outlived the book it belonged to').toEqual(['close', 'remove'])
  })

  /**
   * ⚠️ **CLEARING THE HOST WOULD NOT HAVE REACHED IT.** This is the assumption
   * that made the leak invisible: `#host.replaceChildren()` looks like it tears
   * everything down, and a note mounted through `setFootnoteMount` is not a
   * child of the host at all.
   */
  it('releases it even when it was mounted outside the host', async () => {
    const { session, book } = await started()
    const elsewhere = fakeHost()
    session.setFootnoteMount(elsewhere)
    const note = noteView()
    showNote(book, note)

    session.dispose()
    expect(note.calls, 'a note mounted outside the host was never released').toEqual(['close', 'remove'])
  })

  /* AND THE HOST IS TOLD. `closeFootnote` skips this once `#disposed` is set,
     so without it a host holds a note for a session that no longer exists and
     draws something nothing can close. */
  it('tells the host the note is gone', async () => {
    const { session, book, calls } = await started()
    showNote(book, noteView())
    session.dispose()
    expect(calls['onFootnote']?.at(-1), 'the host was left holding a note').toEqual([null])
  })

  /* IDEMPOTENT, like the rest of dispose. Releasing a view twice is a close on
     a closed view, which is the thing `releaseNoteView` exists to order. */
  it('releases the note once, however many times dispose is called', async () => {
    const { session, book } = await started()
    const note = noteView()
    showNote(book, note)
    session.dispose()
    session.dispose()
    session.dispose()
    expect(note.calls).toEqual(['close', 'remove'])
  })

  it('does nothing about a note when none was open', async () => {
    const { session, calls } = await started()
    expect(() => session.dispose()).not.toThrow()
    /* Still told: a host that never had a note is unaffected by being told it
       has none, and the alternative is a branch that has to know. */
    expect(calls['onFootnote']?.at(-1)).toEqual([null])
  })
})

/**
 * ⚠️ **`View.close()` CLOSES THE RENDERER AND NEVER THE BOOK.** The fork's
 * `close` destroys and removes the renderer and nulls its own progress state;
 * the `Book` object — every backend's parse — is not its to release, and
 * nothing else released it either. A fixed-layout EPUB keeps every visited
 * section's blob URLs in `Loader.#cache`; CBZ holds two object URLs per page;
 * FB2 mints one per section at parse; MOBI holds `#resourceCache`. The
 * enrichment pass found and fixed this for ITS parse (`parseBook.ts`); the
 * reader's own path was missed, one book's resources per book opened.
 *
 * AFTER the note view and the book's view, because the note view SHARES the
 * book — which is why `releaseNoteView` correctly leaves it alone — and a book
 * destroyed under a renderer still tearing down is a renderer reading revoked
 * URLs.
 */
describe('closing a book releases the book', () => {
  it('destroys the book exactly once, after the note view is released and the view closed', async () => {
    const order: string[] = []
    const { session, book } = await started(order)
    const note = noteView(order)
    showNote(book, note)

    session.dispose()
    session.dispose()
    expect(order).toEqual(['note.close', 'note.remove', 'view.close', 'view.remove', 'book.destroy'])
  })
})

/**
 * WHICH NOTE A VIEW BELONGS TO — see `NoteRequest`.
 *
 * The session used to queue each click's anchor and shift one off at
 * `before-render`, which pairs by ARRIVAL rather than by identity. Neither
 * `resolveHref` nor a note's own render settles in click order, and the queue
 * could also come up empty. Every case below is a real reader action that the
 * pairing answered wrongly.
 */
describe('two notes in flight, and one the reader closed', () => {
  const noteFrom = (calls: Record<string, unknown[][]>) =>
    (calls['onFootnote'] ?? []).map(([one]) => one as { href: string } | null)

  /**
   * ⚠️ **THE VIEWS CROSSED.** Two clicks, and the SECOND note's view arrives
   * first — a shorter section, a warm cache. Under the queue it took the first
   * click's anchor and sequence, so it was released as superseded; the first
   * note then took the second's sequence, passed the check, and was shown at
   * the anchor of a reference the reader had moved on from.
   */
  it('shows the note that was clicked last, not the one that rendered first', async () => {
    const { book, calls } = await started()
    const first = clickNote(book)
    const second = clickNote(book)
    const late = noteView()
    const early = noteView()

    /* Out of order: the second click's note renders before the first's. */
    renderInto(second, early)
    renderInto(first, late)

    expect(
      noteFrom(calls).filter((one) => one !== null),
      'a superseded note was shown, and the one the reader asked for released',
    ).toHaveLength(1)
    expect(late.calls, 'the superseded note’s view was left alive').toEqual(['close', 'remove'])
    expect(early.calls, 'the note the reader asked for was released').toEqual([])
  })

  /**
   * ⚠️ **A CLOSED NOTE CAME BACK.** The reader dismisses the popover while the
   * note is still resolving; `closeFootnote` emptied the queue, so
   * `before-render` fell back to `{ at: null, seq: <current> }` — the CURRENT
   * sequence — which then passed `render`'s supersession check and put the
   * note they had just closed back on screen, at no anchor.
   */
  it('does not reopen a note the reader closed while it was resolving', async () => {
    const { session, book, calls } = await started()
    const handler = clickNote(book)
    session.closeFootnote()
    const before = (calls['onFootnote'] ?? []).length

    const note = noteView()
    renderInto(handler, note)

    expect(
      (calls['onFootnote'] ?? []).slice(before).map(([one]) => one),
      'the note the reader dismissed was shown again',
    ).toEqual([])
    /* And its view goes, rather than sitting detached with a live renderer. */
    expect(note.calls, 'the cancelled note’s view was never released').toEqual(['close', 'remove'])
  })

  /* The same for a note superseded by a newer click: released at
     `before-render`, so it is never mounted on the way to being discarded. */
  it('releases a superseded note’s view without mounting it', async () => {
    const { book, host } = await started()
    const stale = clickNote(book)
    clickNote(book)
    const note = noteView()
    renderInto(stale, note)
    expect(note.calls).toEqual(['close', 'remove'])
    expect(
      (host as unknown as { appended: unknown[] }).appended,
      'a superseded note was mounted before being thrown away',
    ).toEqual([])
  })
})

/**
 * ⚠️ **A STALE REJECTION USED TO CLOSE THE NOTE THAT REPLACED IT.**
 *
 * `#noteFailed` is the honest fallback for a note that will not render in
 * place: dismiss the popover, tell the host, and navigate to the note's href so
 * the reader still gets there. Applied to an OLD request it is none of those
 * things — it tears down the note the reader is currently looking at and sends
 * them to a place they moved on from. The render path had a supersession check
 * from the start; this road did not.
 */
describe('a note that fails after a newer one has opened', () => {
  it('leaves the newer note alone and does not navigate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { book, calls } = await started()

    let refuse: (cause: unknown) => void = () => {}
    foliate.answers.push(
      new Promise<void>((_resolve, reject) => {
        refuse = reject
      }),
    )
    clickNote(book)
    const second = clickNote(book)
    const note = noteView()
    renderInto(second, note)
    expect(calls['onFootnote']?.at(-1)?.[0], 'the newer note never opened').not.toBeNull()

    refuse(new Error('the note would not render'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      calls['onFootnote']?.at(-1)?.[0],
      'a superseded request closed the note the reader was reading',
    ).not.toBeNull()
    expect(book.went, 'a superseded request navigated the reader away').toEqual([])
    expect(note.calls, 'the open note’s view was released by an older failure').toEqual([])
    warn.mockRestore()
  })

  /* AND THE CURRENT ONE STILL FALLS BACK. Superseding must not turn the honest
     failure road off — a note that cannot be shown in place is still a place in
     the book, and the reader asked to go there. */
  it('still navigates when the request that failed is the current one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { book, calls } = await started()

    let refuse: (cause: unknown) => void = () => {}
    foliate.answers.push(
      new Promise<void>((_resolve, reject) => {
        refuse = reject
      }),
    )
    clickNote(book)
    refuse(new Error('the note would not render'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(book.went).toEqual(['notes.xhtml#n1'])
    expect(calls['onFootnote']?.at(-1)).toEqual([null])
    warn.mockRestore()
  })
})
