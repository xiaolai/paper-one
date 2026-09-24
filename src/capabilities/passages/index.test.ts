// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { buildDeps, passages } from './index'
import type { PassageIndex } from './lib/port'
import type { CapabilityContext, Disposable, IndexedBook, PaneContext, PassagesPort } from '../../kernel'

/** What a contributed settings section is told when it is drawn. */
const DRAWN: PaneContext = { bookId: null }

/**
 * Start the capability and hand back its disposer.
 *
 * `Capability.start` is declared `Disposable | Promise<Disposable>` because a
 * capability MAY be async; this one is not, and the narrowing is asserted here
 * rather than cast — a `start` that became async would fail this line loudly
 * instead of leaving every teardown case silently awaiting nothing.
 */
function start(api: CapabilityContext, signal = new AbortController().signal): Disposable {
  const started = passages.start?.(api, signal)
  expect(started).toBeDefined()
  expect(started).not.toBeInstanceOf(Promise)
  return started as Disposable
}

/**
 * What the app is offered, and what the sweep does with what it finds.
 *
 * The pane is `PassagesPane.test.tsx`'s subject, the port is `port.test.ts`'s
 * and the walk is `builder.test.ts`'s. What only this file can see is whether
 * the capability offers any of them to the app at all, and whether the
 * dependencies it builds do what the builder is entitled to assume.
 */

function fakeIndex(over: Partial<PassageIndex> = {}): PassageIndex {
  return {
    search: vi.fn(async () => []),
    status: vi.fn(async () => ({
      books: 0,
      sections: 0,
      chars: 0,
      indexBytes: 0,
      textBytes: 0,
      analysis: 'paper/1',
      unreadable: [],
    })),
    put: vi.fn(async () => true),
    note: vi.fn(async () => {}),
    notePartial: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    rekey: vi.fn(async () => true),
    pending: vi.fn(async () => []),
    indexed: vi.fn(async () => []),
    rebuild: vi.fn(async () => {}),
    retry: vi.fn(async () => 0),
    ...over,
  }
}

function book(over: Partial<IndexedBook> = {}): IndexedBook {
  return {
    bookId: 'book:a',
    title: 'A Book',
    addedAt: 1,
    hasContent: true,
    ext: 'epub',
    ...over,
  } as IndexedBook
}

/** A context whose bindings and diagnostics a case can read back. */
function contextWith(options: { books?: readonly IndexedBook[]; fs?: unknown } = {}) {
  const bound: { port: PassagesPort | null; disposed: number } = { port: null, disposed: 0 }
  const info = vi.fn()
  const warn = vi.fn()
  const cleanups: (() => void)[] = []
  let notify: () => void = () => {}
  const services = {
    fs: options.fs ?? null,
    library: {
      getSnapshot: () => options.books ?? [],
      subscribe: (listener: () => void) => {
        notify = listener
        return () => {}
      },
    },
    bindPassages: (port: PassagesPort): Disposable => {
      bound.port = port
      return {
        dispose: () => {
          bound.disposed += 1
        },
      }
    },
  }
  const api = {
    services,
    diagnostics: { info, warn },
    onCleanup: (fn: () => void) => cleanups.push(fn),
  } as unknown as CapabilityContext
  return { api, bound, info, warn, cleanups, notify: () => notify() }
}

describe('what the app is offered', () => {
  it('is the passages capability, requiring nothing', () => {
    /* ⚠️ `requires` is a standing right to reach inside another capability, and
     * `capability-requires-used` refuses a declaration nothing uses. This one
     * needs none: the index is a kernel PORT, not another capability. */
    expect(passages.id).toBe('passages')
    expect(passages.requires).toEqual([])
  })

  it('contributes exactly one settings section, named and placed', () => {
    /* Every value here is a fact a reader meets in Settings, and every one of
     * them is a static mutant the gate can only name. */
    expect(passages.settings).toHaveLength(1)
    const section = passages.settings?.[0]
    expect(section?.id).toBe('passages:library-search')
    expect(section?.title).toBe('Library search')
    /* AFTER Reading (10) and Voices (14), BEFORE Devices (20) — searching your
     * library is part of how you use your books, not part of what talks to
     * another machine. A declared number, so neither moves when the other
     * changes its mind. */
    expect(section?.order).toBe(16)
  })

  it('draws something rather than nothing', () => {
    expect(passages.settings?.[0]?.render(DRAWN)).not.toBeNull()
  })

  it('contributes no pane, no screen and no command', () => {
    /* The Search PANE is the kernel's — library search is a SCOPE on a panel
     * that already exists, not a second panel beside it. A contributed pane
     * would have put two search boxes in the rail. */
    expect(passages.panes).toBeUndefined()
    expect(passages.screens).toBeUndefined()
    expect(passages.commands).toBeUndefined()
  })
})

describe('its lifetime', () => {
  it('binds the port and lets it go again', () => {
    const { api, bound } = contextWith()
    const started = start(api)
    expect(bound.port).not.toBeNull()
    expect(typeof bound.port?.search).toBe('function')
    started?.dispose()
    expect(bound.disposed).toBe(1)
  })

  it('binds nothing when the lifetime is over before it starts', () => {
    const controller = new AbortController()
    controller.abort()
    const { api, bound } = contextWith()
    start(api, controller.signal)
    expect(bound.port).toBeNull()
  })

  it('is safe to dispose twice', () => {
    const { api, bound } = contextWith()
    const started = start(api)
    started?.dispose()
    started?.dispose()
    expect(bound.disposed).toBe(1)
  })

  it('says it started', () => {
    const { api, info } = contextWith()
    const started = start(api)
    expect(info).toHaveBeenCalledWith('passages.started', {})
    started?.dispose()
  })
})

describe('the dependencies the sweep is given', () => {
  it('wants only the books that can be indexed, newest first', () => {
    const { api } = contextWith({
      books: [
        book({ bookId: 'old', addedAt: 1 }),
        book({ bookId: 'pdf', ext: 'pdf', addedAt: 9 }),
        book({ bookId: 'new', addedAt: 5 }),
      ],
    })
    const deps = buildDeps(api, fakeIndex(), () => true)
    expect(deps.wanted().map(([id]) => id)).toEqual(['new', 'old'])
  })

  it('asks the index what it holds rather than deriving it from the status', () => {
    const port = fakeIndex({ indexed: vi.fn(async () => ['book:a']) })
    const { api } = contextWith()
    return expect(buildDeps(api, port, () => true).indexed()).resolves.toEqual(['book:a'])
  })

  it('forgets each book, and stops when the sweep is no longer wanted', async () => {
    const forget = vi.fn(async () => {})
    const port = fakeIndex({ forget })
    const { api } = contextWith()
    let alive = true
    await buildDeps(api, port, () => alive).forget(['a', 'b'])
    expect(forget).toHaveBeenCalledTimes(2)
    /* ⚠️ **ONE MOMENT FOR THE WHOLE BATCH.** Read per book, a slow batch's last
     * removal looks later than it was — which is the direction that wrongly
     * refuses a restore begun in between. */
    const moments = forget.mock.calls.map((call) => (call as unknown[])[1])
    expect(new Set(moments).size).toBe(1)
    forget.mockClear()
    alive = false
    await buildDeps(api, port, () => alive).forget(['a', 'b'])
    expect(forget).not.toHaveBeenCalled()
  })

  it('skips a book that left the shelf between the list and the work', async () => {
    /* Not an error and not a book that cannot be read — simply gone. The next
     * sweep's diff forgets it. */
    const port = fakeIndex()
    const { api } = contextWith({ books: [] })
    await expect(buildDeps(api, port, () => true).indexOne('book:gone')).resolves.toBe('skipped')
    expect(port.note).not.toHaveBeenCalled()
  })

  it('skips rather than recording when there is no filesystem at all', async () => {
    /* ⚠️ A host with no vault has nothing to extract from, and recording every
     * book as unreadable would be a permanent wrong answer about a library it
     * simply cannot see. */
    const port = fakeIndex()
    const { api } = contextWith({ books: [book()], fs: null })
    await expect(buildDeps(api, port, () => true).indexOne('book:a')).resolves.toBe('skipped')
    expect(port.note).not.toHaveBeenCalled()
  })

  it('records a book whose bytes could not be read, rather than skipping it', async () => {
    /* ⚠️ **SKIPPED, IT COMES BACK IN `pending()` EVERY SWEEP AND IS RE-PARSED
     * FOR EVER.** Recorded, the reader is told which books are missing and it
     * is tried again when its bytes change. */
    const port = fakeIndex()
    const { api } = contextWith({
      books: [book()],
      fs: {
        readFile: async () => {
          throw new Error('the file is not there')
        },
      },
    })
    await expect(buildDeps(api, port, () => true).indexOne('book:a')).resolves.toBe('unreadable')
    expect(port.note).toHaveBeenCalledWith(
      'book:a',
      /* THE GENERATION IT FAILED AT — without it the note stops nothing and the
       * book is re-parsed on every sweep for ever. */
      expect.any(String),
      expect.stringContaining('could not be read'),
      expect.any(Number),
    )
  })

  it('only ever READS through the vault, so nothing it does can be journalled', async () => {
    /* ⚠️ **THE OTHER HALF OF THE BACKUP GATE**, and the assertion the phase plan
     * asks for: *nothing under `passages/` enters `sync/journal.jsonl`*.
     *
     * The index lives under `passages/` in the app data root — a SIBLING of
     * `books/`, written by the Rust plugin through `std::fs`, outside the vault
     * entirely. The journal records what is written THROUGH the kernel's
     * filesystem into a book folder, so the way this capability could reach it
     * is by writing there. It does not: the only thing it asks the vault for is
     * a book's own bytes.
     *
     * Asserted by giving it a filesystem that records every call, rather than by
     * reading the journal — a journal that happened to be empty is also what a
     * capability that wrote nothing YET looks like. */
    const calls: string[] = []
    const recorded = new Proxy(
      {
        readFile: async () => new TextEncoder().encode('bytes'),
      } as Record<string, unknown>,
      {
        get: (target, name) => {
          if (typeof name !== 'string') return undefined
          calls.push(name)
          return target[name] ?? (() => {
            throw new Error(`the passages capability called fs.${name}`)
          })
        },
      },
    )
    const { api } = contextWith({ books: [book()], fs: recorded })
    await buildDeps(api, fakeIndex(), () => true).indexOne('book:a')
    /* `readFile` and nothing else. Every other member of `VaultFs` — `writeFile`,
     * `remove`, `rename`, `mkdir` — is what would put a byte where sync can see
     * it. */
    expect([...new Set(calls)]).toEqual(['readFile'])
  })

  it('forwards the flush', async () => {
    const port = fakeIndex()
    const { api } = contextWith()
    await buildDeps(api, port, () => true).flush()
    expect(port.flush).toHaveBeenCalledTimes(1)
  })

  it('hands the main thread back when asked to breathe', async () => {
    const { api } = contextWith()
    await expect(buildDeps(api, fakeIndex(), () => true).breathe()).resolves.toBeUndefined()
  })
})
