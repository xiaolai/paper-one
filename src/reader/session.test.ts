import { describe, expect, it } from 'vitest'
import type { View } from 'foliate-js/view.js'
import { ReaderSession, readMeta } from './session'
import type { SessionCallbacks } from './session'

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
}

function fakeView(overrides: Partial<Record<'open' | 'init', () => Promise<void>>> = {}): FakeView {
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  const view = {
    style: {} as CSSStyleDeclaration,
    closed: 0,
    removed: 0,
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
    close() {
      view.closed += 1
    },
    remove() {
      view.removed += 1
    },
    renderer: { setAttribute: () => {}, setStyles: () => {} },
  } as unknown as FakeView
  return view
}

function callbacks(): SessionCallbacks & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {}
  const rec = (name: string) => (...args: unknown[]) => {
    ;(calls[name] ??= []).push(args)
  }
  return {
    calls,
    onToc: rec('onToc'),
    onRelocate: rec('onRelocate'),
    onDocument: rec('onDocument'),
    onMeta: rec('onMeta'),
    onError: rec('onError'),
    onNavigator: rec('onNavigator'),
  } as SessionCallbacks & { calls: Record<string, unknown[][]> }
}

const deps = (view: View) => ({
  createView: () => Promise.resolve(view),
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
    const nav = cb.calls['onNavigator']?.[0]?.[0] as { goTo: unknown; search: unknown }
    expect(nav.goTo).toBeTypeOf('function')
    expect(nav.search).toBeTypeOf('function')
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
      applySettings: () => {},
    })

    session.dispose()
    release()
    await started

    expect(view.closed).toBe(1)
    expect(session.view).toBeNull()
  })

  it('closes a view when disposal lands mid-open', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const view = fakeView({ open: () => gate })
    const session = new ReaderSession(fakeHost(), callbacks())

    const started = session.start('book.epub', deps(view))
    await Promise.resolve()
    session.dispose()
    release()
    await started

    expect(view.closed).toBe(1)
  })

  it('closes a view when disposal lands mid-init', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const view = fakeView({ init: () => gate })
    const session = new ReaderSession(fakeHost(), callbacks())

    const started = session.start('book.epub', deps(view))
    await Promise.resolve()
    await Promise.resolve()
    session.dispose()
    release()
    await started

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
