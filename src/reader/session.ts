import type { TocItem, View } from 'foliate-js/view.js'
import type { BookMeta, ReaderPosition } from '../lib/useBook'

/**
 * The reader's lifecycle, as a plain object.
 *
 * Startup is a chain of awaits — import the module, create the element, open
 * the book, configure the renderer, display the first section — and React can
 * unmount at any point in that chain. A bare `disposed` flag checked at each
 * step is easy to get subtly wrong and impossible to test, which is exactly
 * what the audit found: teardown could clear the view reference while an open
 * was still in flight, so the view that arrived afterwards had nothing left to
 * close it and kept its iframes, observers and listeners forever.
 *
 * Here disposal is a single latch. `dispose()` is idempotent and can be called
 * before, during, or after startup; `settle()` hands every completed step back
 * to the latch, so whichever side finishes last performs the close. None of it
 * touches React, so all of it can be asserted directly.
 */

/** One hit, flattened from foliate's mixed yield shapes. */
export interface SearchHit {
  readonly cfi: string
  readonly label: string
  readonly pre: string
  readonly match: string
  readonly post: string
}

export interface SessionCallbacks {
  onToc: (toc: readonly TocItem[]) => void
  onRelocate: (position: ReaderPosition) => void
  onDocument: (doc: Document | null) => void
  onMeta: (meta: BookMeta) => void
  onError: (message: string) => void
  onNavigator: (navigator: SessionNavigator | null) => void
}

export interface SessionNavigator {
  goTo: (target: string) => void
  /** Streams hits as they are found; stops when `signal` aborts. */
  search: (query: string, signal: AbortSignal) => AsyncGenerator<SearchHit>
}

export interface SessionDeps {
  /** Injected so tests can supply a fake instead of a real custom element. */
  createView: () => Promise<View>
  applySettings: (view: View) => void
}

export class ReaderSession {
  #disposed = false
  #view: View | null = null
  readonly #host: HTMLElement
  readonly #cb: SessionCallbacks

  constructor(host: HTMLElement, callbacks: SessionCallbacks) {
    this.#host = host
    this.#cb = callbacks
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /** The live view, or null before startup completes / after disposal. */
  get view(): View | null {
    return this.#view
  }

  /**
   * Hand a freshly-created view to the latch.
   *
   * Returns false when the session was disposed while the caller was awaiting,
   * having already closed the view it was given. Callers must stop on false —
   * that is the whole contract.
   */
  #settle(view: View): boolean {
    if (this.#disposed) {
      closeQuietly(view)
      return false
    }
    this.#view = view
    return true
  }

  async start(source: File | string, deps: SessionDeps): Promise<void> {
    let view: View
    try {
      view = await deps.createView()
    } catch (cause) {
      if (!this.#disposed) this.#cb.onError(message(cause, 'The reader failed to start.'))
      return
    }
    if (!this.#settle(view)) return

    view.style.position = 'absolute'
    view.style.inset = '0'
    this.#host.replaceChildren(view)

    /* Both listeners consult the latch before touching shared state. A closing
     * view still emits these, and without the guard a dying book overwrites the
     * document and position of the one that replaced it. */
    view.addEventListener('load', (event) => {
      if (this.#disposed) return
      const { doc } = (event as CustomEvent<{ doc: Document }>).detail
      this.#cb.onDocument(doc)
    })
    view.addEventListener('relocate', (event) => {
      if (this.#disposed) return
      const detail = (event as CustomEvent<{
        fraction: number
        tocItem?: { label?: string; href?: string } | null
      }>).detail
      this.#cb.onRelocate({
        fraction: detail.fraction,
        chapterLabel: detail.tocItem?.label ?? '',
        chapterHref: detail.tocItem?.href ?? '',
      })
    })

    try {
      await view.open(source)
    } catch (cause) {
      if (!this.#settle(view)) return
      this.#cb.onError(message(cause, 'This file could not be opened.'))
      return
    }
    if (!this.#settle(view)) return

    this.#cb.onToc(view.book.toc ?? [])
    this.#cb.onMeta(readMeta(view.book))
    this.#cb.onNavigator({
      goTo: (target) => void view.goTo(target),
      search: (query, signal) => runSearch(view, query, signal),
    })

    // Settings go on BEFORE the first paint, so the reader never flashes
    // foliate's defaults on the way to the configured layout.
    deps.applySettings(view)

    // `open` parses the book and attaches a renderer but navigates nowhere.
    // Without this the view stays empty with a populated table of contents and
    // no iframe, reporting no error to explain it.
    try {
      await view.init({ lastLocation: null, showTextStart: true })
    } catch (cause) {
      if (!this.#settle(view)) return
      this.#cb.onError(message(cause, 'This book could not be displayed.'))
      return
    }
    this.#settle(view)
  }

  /** Idempotent, and safe at any point in startup. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#cb.onDocument(null)
    this.#cb.onNavigator(null)
    const built = this.#view
    this.#view = null
    if (built) closeQuietly(built)
    this.#host.replaceChildren()
  }
}

/**
 * Closed views, so a view is never closed twice.
 *
 * Both `dispose()` and the post-await `#settle()` can legitimately reach the
 * same view: dispose closes what it holds, then the in-flight startup resolves
 * and hands the very same view back. The old `try/catch` hid the second close
 * rather than preventing it — and a swallowed double-close is precisely the
 * kind of thing that looks fine until foliate starts throwing on it.
 */
const CLOSED = new WeakSet<object>()

function closeQuietly(view: View): void {
  if (CLOSED.has(view)) return
  CLOSED.add(view)
  try {
    view.close()
  } catch {
    // close() throws when open() never got far enough to build a renderer.
  }
  view.remove?.()
}

/**
 * Flatten foliate's search stream into plain hits.
 *
 * It yields four different shapes — a progress number, a per-section group, a
 * bare hit, and finally the string 'done' — so the shape has to be narrowed
 * before anything downstream can render it. Section labels arrive on the group
 * and are carried onto the hits inside it, which is what lets a result say
 * which chapter it came from.
 */
async function* runSearch(
  view: View,
  query: string,
  signal: AbortSignal,
): AsyncGenerator<SearchHit> {
  let label = ''
  for await (const result of view.search({ query })) {
    if (signal.aborted) return
    if (result === 'done') return
    if (typeof result !== 'object' || result === null) continue
    if ('progress' in result) continue
    if ('subitems' in result) {
      label = result.label ?? ''
      for (const hit of result.subitems) {
        if (signal.aborted) return
        yield toHit(hit, label)
      }
      continue
    }
    if ('cfi' in result) yield toHit(result, label)
  }
}

function toHit(
  raw: { cfi: string; excerpt: { pre: string; match: string; post: string } },
  label: string,
): SearchHit {
  return {
    cfi: raw.cfi,
    label,
    pre: raw.excerpt?.pre ?? '',
    match: raw.excerpt?.match ?? '',
    post: raw.excerpt?.post ?? '',
  }
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

/** foliate's metadata is loosely typed: title may be a language map, author a
 *  string, an object, or an array of either. */
export function readMeta(book: { metadata?: unknown }): BookMeta {
  const md = (book.metadata ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ')
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>
      const name = rec['name']
      if (typeof name === 'string') return name
      const first = Object.values(rec)[0]
      if (typeof first === 'string') return first
    }
    return ''
  }
  return { title: text(md['title']), author: text(md['author']) }
}
