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
 */

const foliate = vi.hoisted(() => ({ handlers: [] as EventTarget[] }))

vi.mock('foliate-js/footnotes.js', () => ({
  FootnoteHandler: class extends EventTarget {
    constructor() {
      super()
      foliate.handlers.push(this)
    }
    handle() {
      return Promise.resolve()
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
function noteView() {
  const calls: string[] = []
  return {
    calls,
    view: {
      close: () => calls.push('close'),
      remove: () => calls.push('remove'),
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

const view = () =>
  ({
    style: {} as CSSStyleDeclaration,
    book: { toc: [], metadata: {} },
    addEventListener: () => {},
    open: async () => {},
    init: async () => {},
    close: () => {},
    remove: () => {},
    renderer: { setAttribute: () => {}, addEventListener: () => {} },
  }) as unknown as View

/** A started session, plus the handler its listeners are on. */
async function started() {
  foliate.handlers.length = 0
  const host = fakeHost()
  const { cb, calls } = callbacks()
  const session = new ReaderSession(host, cb)
  await session.start('book.epub', {
    createView: async () => view(),
    loadPainters: () => Promise.resolve({ fill: 'FILL', underline: 'UNDERLINE', wave: 'WAVE' }) as never,
    /* THE PASS-THROUGH — `prepare` is required; see `SessionDeps.prepare`. */
    prepare: (source: unknown) => Promise.resolve(source),
    applySettings: () => {},
    applyVars: () => {},
  })
  const handler = foliate.handlers[0]
  expect(handler, 'the session should have built a footnote handler').toBeDefined()
  return { session, host, calls, handler: handler! }
}

/**
 * Put a note on screen, exactly as `FootnoteHandler` does.
 *
 * ⚠️ **`before-render` CARRIES `{ view }`**, and a fake that sent something else
 * left `view` undefined — which threw inside the dispatch rather than failing an
 * assertion. Both events, in order, because `before-render` is what attaches the
 * view and `render` is what publishes it.
 */
function showNote(handler: EventTarget, note: { view: View }) {
  handler.dispatchEvent(new CustomEvent('before-render', { detail: { view: note.view } }))
  handler.dispatchEvent(
    new CustomEvent('render', { detail: { view: note.view, href: 'notes.xhtml#n1', type: 'footnote' } }),
  )
}

describe('closing a book with a note open', () => {
  it('closes and detaches the note’s view', async () => {
    const { session, handler } = await started()
    const note = noteView()
    showNote(handler, note)
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
    const { session, handler } = await started()
    const elsewhere = fakeHost()
    session.setFootnoteMount(elsewhere)
    const note = noteView()
    showNote(handler, note)

    session.dispose()
    expect(note.calls, 'a note mounted outside the host was never released').toEqual(['close', 'remove'])
  })

  /* AND THE HOST IS TOLD. `closeFootnote` skips this once `#disposed` is set,
     so without it a host holds a note for a session that no longer exists and
     draws something nothing can close. */
  it('tells the host the note is gone', async () => {
    const { session, handler, calls } = await started()
    showNote(handler, noteView())
    session.dispose()
    expect(calls['onFootnote']?.at(-1), 'the host was left holding a note').toEqual([null])
  })

  /* IDEMPOTENT, like the rest of dispose. Releasing a view twice is a close on
     a closed view, which is the thing `releaseNoteView` exists to order. */
  it('releases the note once, however many times dispose is called', async () => {
    const { session, handler } = await started()
    const note = noteView()
    showNote(handler, note)
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
