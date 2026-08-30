// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refuseBookScripts, stripScripts } from './bookScripts'
import { epubFixture } from './epubFixture.testkit'

/**
 * D7's defence in depth, proved on the REAL fork (WI-20.30).
 *
 * The CSP is the wall and `csp-effect.mjs` measures it; this is what stands
 * behind it. A chapter carrying a `<script src>`, an inline `<script>` and
 * an `onclick` goes through the pinned fork's own loader, so the assertion is
 * about what the fork DOES with a refusal — not about a fake of it.
 */

const SCRIPT_HREF = 'OEBPS/x.js'
const SCRIPTED_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title>
<script src="x.js"></script>
<script>window.top.ran = true</script>
</head>
<body onload="parent.ran = 'onload'"><p onclick="parent.ran = 'click'">Call me Ishmael.</p>
<svg xmlns="http://www.w3.org/2000/svg"><script>parent.ran = 'svg'</script><rect onbegin="1"/></svg>
</body></html>`

/** The fixture's manifest gains the script the chapter references. */
function scriptedBook(): File {
  return epubFixture({
    chapter: SCRIPTED_CHAPTER,
    extra: [{ href: SCRIPT_HREF, mediaType: 'application/javascript', data: 'parent.ran = "external"' }],
  })
}

/**
 * jsdom has no `URL.createObjectURL`, and the fork's loader turns every
 * resource it admits into one. Stubbed to RECORD: which blobs were minted is
 * exactly the observation — a refused script is never minted at all.
 */
/** Like `mintedUrls`, but the BLOBS — for reading a served document back. */
function mintedBlobs(): Blob[] {
  const blobs: Blob[] = []
  const url = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void }
  url.createObjectURL = (blob: Blob) => {
    blobs.push(blob)
    return `blob:fake/${blobs.length}`
  }
  url.revokeObjectURL = () => {}
  return blobs
}

function mintedUrls() {
  const minted: string[] = []
  const url = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void }
  const createObjectURL = vi.fn((blob: Blob) => {
    minted.push(blob.type)
    return `blob:fake/${minted.length}`
  })
  url.createObjectURL = createObjectURL
  url.revokeObjectURL = () => {}
  return minted
}

afterEach(() => {
  const url = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }
  delete url.createObjectURL
  delete url.revokeObjectURL
})

type Loadable = { load: () => Promise<string>; createDocument: () => Promise<Document> }

async function open(file: File) {
  const { makeBook } = await import('foliate-js/view.js')
  const book = await makeBook(file)
  return { book, section: book.sections[0] as Loadable }
}

/**
 * A chapter whose script sits BETWEEN two paragraphs, which is the shape that
 * makes the divergence visible.
 *
 * `SCRIPTED_CHAPTER`'s scripts are in `<head>` and after the prose, so removing
 * them moves nothing the reader ever anchors to. A script before a paragraph
 * moves that paragraph, and everything after it.
 */
const SCRIPT_BEFORE_PROSE = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>
<body><p>before</p><script>window.top.ran = true</script><p>needle</p><p>after</p></body></html>`

/**
 * The child-index path from the document to a node — WHAT A CFI ENCODES.
 *
 * An EPUB CFI is a walk of child indices, so two documents address a passage
 * with the same CFI exactly when its path is the same in both. Asserting the
 * path is therefore asserting the CFI, without needing a live `View` to mint
 * one: `view.getCFI` wants a renderer, and the divergence is a property of the
 * two documents rather than of anything rendered.
 */
function indexPath(node: Node): number[] {
  const path: number[] = []
  for (let step: Node | null = node; step?.parentNode; step = step.parentNode) {
    path.unshift(Array.prototype.indexOf.call(step.parentNode.childNodes, step))
  }
  return path
}

describe('refuseBookScripts, through the fork’s own loader', () => {
  it('control: with nothing refusing it, the fork mints a URL for the book’s script and points the element at it', async () => {
    const minted = mintedUrls()
    const { section } = await open(scriptedBook())
    await section.load()
    expect(minted).toContain('application/javascript')
  })

  it('refuses the script resource: never fetched, never a URL, and the element left pointing at nothing', async () => {
    const minted = mintedUrls()
    const { book, section } = await open(scriptedBook())
    refuseBookScripts(book)
    const url = await section.load()
    expect(url).toMatch(/^blob:/)
    expect(minted).not.toContain('application/javascript')
    /* The loader sets `src` to what `loadHref` answered, which for a refused
       item is null — a string no engine will fetch. */
    expect(minted).toContain('application/xhtml+xml')
  })

  it('is a no-op for a backend that has no loader to refuse', () => {
    expect(() => refuseBookScripts({})).not.toThrow()
  })

  it('strips the served chapter BEFORE its URL exists — nothing left to run at parse time', async () => {
    /* The view-level strip runs after the iframe's `load`, which is after
       parse: were the CSP ever absent, an inline script would already have
       run. The loader's `data` event carries the serialized chapter before
       the URL is minted, and the strip there is what makes "a document with
       nothing left to run" true at the only moment it matters (audit round
       1, #104). */
    const blobs = mintedBlobs()
    const { book, section } = await open(scriptedBook())
    refuseBookScripts(book)
    await section.load()
    const chapter = blobs.find((b) => b.type === 'application/xhtml+xml')
    expect(chapter).toBeDefined()
    const served = await chapter!.text()
    expect(served).toContain('Call me Ishmael.')
    expect(served).not.toContain('<script')
    expect(served).not.toContain('onclick')
    expect(served).not.toContain('onload')
  })

  it('a script the manifest mislabels is stripped with the element that named it', async () => {
    /* `isScript` trusts the manifest's declared type, so a book declaring its
       script `text/plain` slipped the loader refusal (audit round 1, #103).
       The element is gone from the served document either way now, so the
       mislabeled resource has nothing left to reference it. */
    const blobs = mintedBlobs()
    const { book, section } = await open(
      epubFixture({
        chapter: SCRIPTED_CHAPTER,
        extra: [{ href: SCRIPT_HREF, mediaType: 'text/plain', data: 'parent.ran = "external"' }],
      }),
    )
    refuseBookScripts(book)
    await section.load()
    const chapter = blobs.find((b) => b.type === 'application/xhtml+xml')
    const served = await chapter!.text()
    expect(served).not.toContain('<script')
  })
})

describe('stripScripts', () => {
  it('removes every script and every handler, and leaves the prose', () => {
    const doc = new DOMParser().parseFromString(SCRIPTED_CHAPTER, 'application/xhtml+xml')
    const removed = stripScripts(doc)
    expect(doc.getElementsByTagNameNS('*', 'script')).toHaveLength(0)
    expect(doc.querySelector('[onclick], [onload], [onbegin]')).toBeNull()
    expect(doc.querySelector('p')?.textContent).toBe('Call me Ishmael.')
    expect(doc.querySelector('rect')).not.toBeNull()
    /* Three scripts (two HTML, one SVG) and three handlers. */
    expect(removed).toBe(6)
  })

  it('answers 0 for a document with nothing to strip, and touches nothing in it', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p class="one" data-only="x">Hi</p></body></html>',
      'application/xhtml+xml',
    )
    expect(stripScripts(doc)).toBe(0)
    expect(doc.querySelector('p')?.getAttribute('data-only')).toBe('x')
  })

  it('is case-blind about the handler name, and does not take an attribute that merely starts with on', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p OnClick="1" on="keep" data-on="keep">Hi</p></body></html>',
      'text/html',
    )
    stripScripts(doc)
    const p = doc.querySelector('p')!
    expect(p.hasAttribute('onclick')).toBe(false)
    expect(p.getAttribute('on')).toBe('keep')
    expect(p.getAttribute('data-on')).toBe('keep')
  })

  it('reaches the chapter the fork loaded, which the loader itself leaves scripted', async () => {
    const { section } = await open(scriptedBook())
    const doc = await section.createDocument()
    /* The fork's own TODO: inline scripts are not its business. */
    expect(doc.getElementsByTagNameNS('*', 'script').length).toBeGreaterThan(0)
    stripScripts(doc)
    expect(doc.getElementsByTagNameNS('*', 'script')).toHaveLength(0)
    expect(doc.querySelector(`[onclick]`)).toBeNull()
    expect(doc.documentElement.textContent).toContain('Call me Ishmael.')
  })
})

/**
 * The two documents one book produces, and why they have to agree.
 *
 * `view.search()` builds its hits — and their CFIs — from the section's own
 * `createDocument()`, which the fork parses from the RAW chapter. The reader's
 * iframe parses what the loader served, which `refuseBookScripts` has stripped.
 * Remove an element and every later sibling index shifts, so the same CFI
 * addresses different words in the two documents. It does not throw; it lands
 * on the wrong passage, which is `markContext.ts`'s stated hazard arriving from
 * inside one build rather than across two.
 */
describe('the document search reads and the document the reader renders', () => {
  it('address the same passage by the same path', async () => {
    const blobs = mintedBlobs()
    const { book, section } = await open(epubFixture({ chapter: SCRIPT_BEFORE_PROSE }))
    refuseBookScripts(book)

    /* What the reader's iframe parses: the loader's serialized chapter. */
    await section.load()
    const chapter = blobs.find((b) => b.type === 'application/xhtml+xml')
    expect(chapter).toBeDefined()
    const rendered = new DOMParser().parseFromString(await chapter!.text(), 'application/xhtml+xml')

    /* What `view.search()` indexes. */
    const searched = await section.createDocument()

    const needle = (doc: Document): number[] => {
      const found = Array.from(doc.querySelectorAll('p')).find((p) => p.textContent === 'needle')
      expect(found, 'the fixture lost its needle').toBeDefined()
      return indexPath(found!)
    }

    expect(needle(searched)).toEqual(needle(rendered))
  })

  it('survives being destructured off the section and called with no receiver', async () => {
    /* The fork calls the method BOTH WAYS: as a property on its per-section
       path (view.js:502, :526 — the second is search's) and destructured and
       unbound on its whole-book path, `for (const [index, { createDocument }]
       of sections.entries())` then `await createDocument()` (view.js:532-534).
       This covers the second convention.

       IT CANNOT FAIL FROM A BINDING MISTAKE, and that is worth writing down
       because the obvious rationale for this test is wrong. Rewriting the
       wrapper as a `function` that forwards `this` was tried here: all twelve
       tests still passed. The fork's own `createDocument` does not read
       `this` — which is exactly why it can be destructured and called with no
       receiver in the first place — so forwarding `undefined` is harmless.
       What this pins is that the unbound PATH yields a stripped document at
       all, not how the wrapper binds. */
    const { book, section } = await open(epubFixture({ chapter: SCRIPT_BEFORE_PROSE }))
    refuseBookScripts(book)
    const { createDocument } = section
    const doc = await createDocument()
    expect(doc.getElementsByTagNameNS('*', 'script')).toHaveLength(0)
    expect(doc.querySelector('body')?.childNodes.length).toBe(3)
  })

  it('agree about how many children the body has', async () => {
    const blobs = mintedBlobs()
    const { book, section } = await open(epubFixture({ chapter: SCRIPT_BEFORE_PROSE }))
    refuseBookScripts(book)
    await section.load()
    const chapter = blobs.find((b) => b.type === 'application/xhtml+xml')
    const rendered = new DOMParser().parseFromString(await chapter!.text(), 'application/xhtml+xml')
    const searched = await section.createDocument()
    expect(searched.querySelector('body')?.childNodes.length).toBe(
      rendered.querySelector('body')?.childNodes.length,
    )
  })
})
