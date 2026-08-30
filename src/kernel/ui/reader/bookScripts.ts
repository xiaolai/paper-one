/**
 * A book's scripts do not run — twice over (phase 20, WI-20.30, D7).
 *
 * ## The boundary is the CSP, and this is what stands behind it
 *
 * foliate renders a book's documents in a same-origin iframe carrying
 * `allow-same-origin allow-scripts`, and its own README says why the sandbox
 * is therefore "useless" and the Content Security Policy is the real wall:
 * `script-src 'self'`, inherited by every `blob:` document. `csp-effect.mjs`
 * measures that wall on WebKit and Chromium, inline and external and framed,
 * every time somebody runs it. Nothing here replaces it.
 *
 * What this adds is the author's own advice: block scripts at the loader so a
 * book's `<script src>` is never even turned into an object URL, and strip
 * what the loader lets through — inline scripts and `on*` handlers, which its
 * source marks `TODO: replace inline scripts? probably not worth the
 * trouble`. Defence in depth: a CSP misconfigured in one shipped build, or one
 * engine's bug, meets a document with nothing left to run.
 *
 * ## Why it matters MORE on the phone than on the desktop
 *
 * The browser client's session carries a cookie the browser attaches to any
 * socket the page opens — a book's script could open `wss://…/ws` itself.
 * That is why the pump holds the browser to reads, and why the one write it
 * grants (`book.position`, bound to the book the client opened) waited for
 * this and for the measurement above before it existed.
 */

/**
 * The fork's resource loader dispatches `load` on the book's
 * `transformTarget` for every manifest item it is about to load, with
 * `{ type, isScript, allow: true }`, and awaits `allow` — a listener that
 * sets it false makes `loadItem` answer null: the item is never fetched,
 * never given a URL, and the element that referenced it is left pointing at
 * nothing. Structural, because the fork's `Book` type does not declare it and
 * a backend without one (PDF, CBZ) simply has no scripts to refuse.
 */
interface ResourceLoad {
  readonly isScript?: boolean
  allow?: boolean | Promise<boolean>
}

/**
 * The loader's OTHER event: `data`, dispatched from `createURL` with the
 * serialized content and its type, and awaited — a listener may replace
 * `detail.data` before the object URL is minted. The EPUB loader sends every
 * replaced document through it, and KF8 sends its skeletons.
 */
interface ResourceData {
  readonly type?: unknown
  data?: unknown
}

/** The types the loader serialises documents as — the ones worth parsing. */
const DOCUMENT_TYPES = new Set(['application/xhtml+xml', 'text/html', 'image/svg+xml'])

/**
 * Refuse every script resource this book asks its loader for, and strip the
 * ones a document CARRIES before the loader turns it into a URL.
 *
 * Takes any object, because the fork's `Book` type declares no
 * `transformTarget` and an all-optional parameter type is one TypeScript
 * refuses a `Book` for; the check is on the value — structural, not
 * `instanceof EventTarget`, which is realm-bound and would silently decline a
 * book built in another window (audit round 1, #829).
 *
 * TWO LISTENERS, AND THE `data` ONE IS THE LOAD-BEARING HALF (audit round 1,
 * #103/#104). The view-level strip in `session.ts` runs after the iframe's
 * `load`, which is after parse — an inline script would already have run were
 * the CSP ever absent, and a `<script src>` whose manifest entry LIES about
 * its type slips the `isScript` refusal. Stripping the serialized document
 * here, before the URL exists, closes both: the document the iframe parses
 * has nothing left to run, whatever the manifest claimed. The post-load strip
 * stays for the backends whose documents never pass through a loader.
 */
export function refuseBookScripts(book: object): void {
  stripSectionDocuments(book)
  const gate = (book as { readonly transformTarget?: unknown }).transformTarget as
    | Pick<EventTarget, 'addEventListener'>
    | null
    | undefined
  if (typeof gate?.addEventListener !== 'function') return
  gate.addEventListener('load', (event) => {
    const detail = (event as CustomEvent<ResourceLoad | undefined>).detail
    if (detail?.isScript === true) detail.allow = false
  })
  gate.addEventListener('data', (event) => {
    const detail = (event as CustomEvent<ResourceData | undefined>).detail
    if (!detail || typeof detail.type !== 'string' || !DOCUMENT_TYPES.has(detail.type)) return
    if (typeof detail.data !== 'string') return
    detail.data = stripSerialized(detail.data, detail.type)
  })
}

/** Books already wrapped, so a second `refuseBookScripts` does not nest one. */
const WRAPPED = new WeakSet<object>()

/**
 * ONE BOOK PRODUCES TWO DOCUMENTS, AND THE CFI IS ONLY VALID IF THEY AGREE.
 *
 * The `data` listener above strips what the LOADER serialises, which is what
 * the reader's iframe parses. It is not the only document a book makes:
 * `section.createDocument()` parses the RAW chapter, and that is what
 * `view.search()` builds its hits — and their CFIs — from.
 *
 * A CFI is a walk of child indices. Remove an element from one document and
 * every later sibling index shifts, so a CFI minted against the unstripped
 * document addresses DIFFERENT NODES in the stripped one. It does not throw.
 * It lands on the wrong passage — `markContext.ts`'s stated hazard, arriving
 * from inside a single build rather than across two. Measured on a chapter
 * whose script sits between two paragraphs: the second paragraph is the body's
 * child 2 in one document and child 1 in the other, so a search hit navigated
 * to the paragraph before the one it found.
 *
 * So the same strip runs on both. This is not a second security measure —
 * the loader path is what stands behind the CSP and that has not changed —
 * it is what makes the two documents ADDRESS THE SAME TEXT.
 *
 * Wrapping the section rather than patching the fork, because the fork is
 * pinned by commit (`package.json`) and a rebase onto upstream must not
 * silently drop this; a wrapper lives with the reason it exists and fails
 * loudly in `bookScripts.test.ts` if the fork stops routing search through
 * `createDocument`. `stripScripts` answers 0 and touches nothing on a document
 * with no scripts, so wrapping costs one query per section.
 */
function stripSectionDocuments(book: object): void {
  if (WRAPPED.has(book)) return
  const sections = (book as { readonly sections?: unknown }).sections
  /* A backend with no sections — PDF, CBZ — has no chapter documents to make
   * and no scripts in them. The same structural check the gate above uses. */
  if (!Array.isArray(sections)) return
  WRAPPED.add(book)
  for (const section of sections) {
    if (typeof section !== 'object' || section === null) continue
    const holder = section as { createDocument?: (...args: unknown[]) => Promise<Document> }
    const original = holder.createDocument
    if (typeof original !== 'function') continue
    holder.createDocument = async (...args: unknown[]): Promise<Document> => {
      const doc = await original.apply(holder, args)
      stripScripts(doc)
      return doc
    }
  }
}

/**
 * Strip a serialized document, answering the original text when it will not
 * parse — a malformed section is the renderer's problem to report, and a
 * strip that replaced it with a parser-error document would be this module
 * breaking a book the engine might have shown.
 */
function stripSerialized(text: string, type: string): string {
  const doc = new DOMParser().parseFromString(text, type as DOMParserSupportedType)
  if (doc.getElementsByTagName('parsererror').length > 0) return text
  if (stripScripts(doc) === 0) return text
  return type === 'text/html'
    ? (doc.documentElement?.outerHTML ?? text)
    : new XMLSerializer().serializeToString(doc)
}

/**
 * Strip what the loader leaves in a document: every `<script>` — inline or
 * `src`, HTML or SVG — and every `on*` attribute on every element.
 *
 * Called from the view's `load` before anything else reads the document, so
 * the watchers, the marks and the measurements see the stripped one. Returns
 * how much went, for a log line and for the tests; a book with nothing to
 * strip costs one query and answers 0.
 */
export function stripScripts(doc: Document): number {
  let removed = 0
  /* `getElementsByTagNameNS('*', 'script')` reaches an XHTML book's scripts
   * AND an inline SVG's, which `querySelectorAll('script')` does too in every
   * engine that matters — but a live collection shrinks as it is emptied, so
   * it is copied first. */
  for (const script of Array.from(doc.getElementsByTagNameNS('*', 'script'))) {
    script.remove()
    removed += 1
  }
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    /* Attributes are removed by NAME, copied first for the same reason the
     * scripts were: `NamedNodeMap` is live. `on` followed by a letter is the
     * whole HTML and SVG handler vocabulary — `onclick`, `onload`, `onbegin`
     * — and nothing else in either language starts that way. */
    for (const { name } of Array.from(el.attributes)) {
      if (/^on[a-z]/i.test(name)) {
        el.removeAttribute(name)
        removed += 1
      }
    }
  }
  return removed
}
