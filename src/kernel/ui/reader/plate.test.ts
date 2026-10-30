// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plateOf, plateTargetOf } from './plate'

/**
 * What the host is told about a plate.
 *
 * THE MEASUREMENT BEHIND THE WHOLE MODULE (WI-32.A0): a section's image is a
 * `blob:` URL on the HOST's own origin, and `new Image()` in the host loaded
 * it — so the fork's URL is reused rather than copied. Two of the cases below
 * exist to keep that decision visible: the raster path mints nothing and
 * releases nothing.
 */

const docOf = (html: string): Document =>
  new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')

const originals = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
afterEach(() => {
  URL.createObjectURL = originals.create
  URL.revokeObjectURL = originals.revoke
  vi.restoreAllMocks()
})

describe('plateOf, for a raster image', () => {
  it('hands back the element’s own source and mints nothing', () => {
    /* The point of A0: no copy. If this ever starts creating a URL, the
       viewer has begun doubling the memory of every plate. */
    const create = vi.fn(() => 'blob:should-not-happen')
    URL.createObjectURL = create as unknown as typeof URL.createObjectURL
    const d = docOf('<p><img src="http://x/a.png" alt="A rig"/></p>')
    const handle = plateOf(d.querySelector('img')!)
    expect(handle).not.toBeNull()
    expect(handle!.detail.src).toBe('http://x/a.png')
    expect(handle!.detail.alt).toBe('A rig')
    expect(create).not.toHaveBeenCalled()
  })

  it('offers no release, because the fork owns that URL', () => {
    /* Revoking the section's blob blanks the image on the page BEHIND the
       viewer, and the page is still there. Null is the whole guarantee. */
    const d = docOf('<p><img src="http://x/a.png"/></p>')
    expect(plateOf(d.querySelector('img')!)!.release).toBeNull()
  })

  it('trims the alt, and answers an empty string when the book gave none', () => {
    const d = docOf('<p><img src="http://x/a.png" alt="  spaced  "/></p>')
    expect(plateOf(d.querySelector('img')!)!.detail.alt).toBe('spaced')
    const bare = docOf('<p><img src="http://x/b.png"/></p>')
    expect(plateOf(bare.querySelector('img')!)!.detail.alt).toBe('')
  })

  it('refuses an image with no source rather than opening an empty viewer', () => {
    /* A broken reference already renders a placeholder on the page. Opening a
       blank modal over it turns a visible defect into one the reader has to
       dismiss. */
    const d = docOf('<p><img alt="nothing"/></p>')
    expect(plateOf(d.querySelector('img')!)).toBeNull()
  })

  it('reports natural size when the layout knows it, and 0 when it does not', () => {
    const d = docOf('<p><img src="http://x/a.png"/></p>')
    const img = d.querySelector('img')!
    expect(plateOf(img)!.detail.width).toBe(0)
    expect(plateOf(img)!.detail.height).toBe(0)
    Object.defineProperty(img, 'naturalWidth', { value: 1560, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 329, configurable: true })
    const sized = plateOf(img)!.detail
    expect(sized.width).toBe(1560)
    expect(sized.height).toBe(329)
  })

  it('prefers currentSrc, which is the file the page actually chose', () => {
    /* With `srcset` the two differ, and enlarging `src` would show a different
       file from the one the reader is looking at. */
    const d = docOf('<p><img src="http://x/small.png"/></p>')
    const img = d.querySelector('img')!
    Object.defineProperty(img, 'currentSrc', { value: 'http://x/large.png', configurable: true })
    expect(plateOf(img)!.detail.src).toBe('http://x/large.png')
  })
})

describe('plateOf, for an inline svg', () => {
  it('serialises it to a URL and hands back the release for it', () => {
    /* 10 % of the books on this shelf carry an inline `<svg>` (WI-32.A0), so
       this path is real. Unlike a raster image it has no URL of its own, so
       this module makes one — and must therefore be the thing that frees it. */
    const created: string[] = []
    const revoked: string[] = []
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:made-${created.length}`
      created.push(url)
      return url
    }) as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u)) as unknown as typeof URL.revokeObjectURL

    const d = docOf('<div><svg viewBox="0 0 40 20"><title>A flow</title></svg></div>')
    const handle = plateOf(d.querySelector('svg')!)
    expect(handle).not.toBeNull()
    expect(handle!.detail.src).toBe('blob:made-0')
    expect(handle!.detail.alt).toBe('A flow')
    expect(handle!.detail.width).toBe(40)
    expect(handle!.detail.height).toBe(20)

    expect(revoked).toEqual([])
    handle!.release!()
    expect(revoked).toEqual(['blob:made-0'])
  })

  it('answers 0 for a size the viewBox cannot give', () => {
    URL.createObjectURL = vi.fn(() => 'blob:x') as unknown as typeof URL.createObjectURL
    for (const box of ['', 'viewBox="0 0 40"', 'viewBox="0 0 nope 20"', 'viewBox="0 0 0 20"', 'viewBox="0 0 -4 20"']) {
      const d = docOf(`<div><svg ${box}></svg></div>`)
      const detail = plateOf(d.querySelector('svg')!)!.detail
      expect([detail.width, detail.height]).toEqual([0, 0])
    }
  })

  it('reads a viewBox separated by commas, which is valid SVG', () => {
    URL.createObjectURL = vi.fn(() => 'blob:x') as unknown as typeof URL.createObjectURL
    const d = docOf('<div><svg viewBox="0,0,80,40"></svg></div>')
    const detail = plateOf(d.querySelector('svg')!)!.detail
    expect([detail.width, detail.height]).toEqual([80, 40])
  })

  it('answers an empty name for an svg with no title', () => {
    URL.createObjectURL = vi.fn(() => 'blob:x') as unknown as typeof URL.createObjectURL
    const d = docOf('<div><svg viewBox="0 0 10 10"></svg></div>')
    expect(plateOf(d.querySelector('svg')!)!.detail.alt).toBe('')
  })
})

describe('plateOf, for anything else', () => {
  it('refuses an element that is neither an image nor an svg', () => {
    const d = docOf('<p><span>words</span></p>')
    expect(plateOf(d.querySelector('span')!)).toBeNull()
  })
})

describe('plateOf — the svg wrapper shortcut, and its limits', () => {
  it('uses the inner image, because an SVG shown through <img> cannot fetch one', () => {
    /* ⚠️ An SVG loaded as an image is a CLOSED document: it may not fetch any
       external resource, blob URLs included. So `<svg><image href="blob:…"/>`
       serialises fine, loads fine, and renders BLANK. It is also not a rare
       shape — it is the EPUB cover-wrapper idiom: of 120 books sampled, 5 have
       an inline `<svg>` and all 5 of them have an `<image>` in it. */
    const created = vi.fn(() => 'blob:should-not-be-called')
    URL.createObjectURL = created as unknown as typeof URL.createObjectURL
    const d = docOf('<div><svg viewBox="0 0 60 90"><image href="blob:cover"/></svg></div>')
    const handle = plateOf(d.querySelector('svg')!)!
    expect(handle.detail.src).toBe('blob:cover')
    expect(handle.detail.width).toBe(60)
    expect(handle.release).toBeNull()
    expect(created).not.toHaveBeenCalled()
  })

  it('reads an xlink href under ANY prefix, not just the literal “xlink”', () => {
    /* `getAttribute('xlink:href')` assumes a prefix; it is a namespace, so
       `xl:href` is equally valid and used to fall through to serialisation —
       a blank viewer. */
    const d = new DOMParser().parseFromString(
      '<div xmlns="http://www.w3.org/1999/xhtml"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xl="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><image xl:href="blob:odd"/></svg></div>',
      'application/xhtml+xml',
    )
    expect(plateOf(d.querySelector('svg')!)!.detail.src).toBe('blob:odd')
  })

  it('does NOT reduce a composed figure to its first image', () => {
    /* ⚠️ The first version took any SVG containing an `<image>`, so a diagram
       of three photographs with labels enlarged to ONE photograph — showing
       something different from what is on the page, which is worse than not
       enlarging at all. */
    URL.createObjectURL = vi.fn(() => 'blob:serialised') as unknown as typeof URL.createObjectURL
    const many = docOf('<div><svg viewBox="0 0 10 10"><image href="blob:a"/><image href="blob:b"/></svg></div>')
    expect(plateOf(many.querySelector('svg')!)!.detail.src).toBe('blob:serialised')
    const labelled = docOf('<div><svg viewBox="0 0 10 10"><image href="blob:a"/><text>inlet</text></svg></div>')
    expect(plateOf(labelled.querySelector('svg')!)!.detail.src).toBe('blob:serialised')
    const drawn = docOf('<div><svg viewBox="0 0 10 10"><image href="blob:a"/><path d="M0 0"/></svg></div>')
    expect(plateOf(drawn.querySelector('svg')!)!.detail.src).toBe('blob:serialised')
  })

  it('still serialises a vector-only svg, which has nothing external to fetch', () => {
    URL.createObjectURL = vi.fn(() => 'blob:vector') as unknown as typeof URL.createObjectURL
    const d = docOf('<div><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></div>')
    const handle = plateOf(d.querySelector('svg')!)!
    expect(handle.detail.src).toBe('blob:vector')
    expect(handle.release).not.toBeNull()
  })
})

describe('plateTargetOf — what a click in the book means', () => {
  const yes = () => true
  const pick = (html: string, sel: string, enlargeable: (el: Element) => boolean = yes) =>
    plateTargetOf(docOf(html).querySelector(sel), enlargeable)

  it('takes the image that was clicked', () => {
    const got = pick('<p><img src="a.png"/></p>', 'img')
    expect(got?.tagName.toLowerCase()).toBe('img')
  })

  it('refuses a link, so a cover that links to chapter one navigates instead', () => {
    expect(pick('<p><a href="c1.html"><img src="a.png"/></a></p>', 'img')).toBeNull()
  })

  it('refuses a link INSIDE an svg, which asking the image cannot see', () => {
    /* ⚠️ `<svg><a><rect/></a></svg>` puts the anchor inside the drawing, so
       `img.closest('a')` finds nothing and the viewer opened on top of a link
       the reader was following. Round 3 of the audit, 2026-09-25. */
    expect(pick('<div><svg><a href="x.html"><rect/></a></svg></div>', 'rect')).toBeNull()
  })

  it('answers the OUTERMOST svg, not the fragment under the pointer', () => {
    /* `closest('img, svg')` stops at an inner `<svg>`, so a composed
       illustration enlarged to whichever piece was clicked. */
    const got = pick('<div><svg id="outer"><svg id="inner"><rect/></svg></svg></div>', '#inner rect')
    expect(got?.getAttribute('id')).toBe('outer')
  })

  it('refuses an element that is no image at all', () => {
    expect(pick('<p><span>words</span></p>', 'span')).toBeNull()
  })

  it('refuses null, and anything without closest', () => {
    expect(plateTargetOf(null, yes)).toBeNull()
    expect(plateTargetOf({} as unknown as Element, yes)).toBeNull()
  })

  it('asks the enlargeable test, and refuses when it says no', () => {
    /* The inline glyph case — a drop cap, an equation set into a sentence. */
    expect(pick('<p>Once <img src="a.png"/> upon</p>', 'img', () => false)).toBeNull()
  })

  it('passes the OUTERMOST element to the enlargeable test, not the fragment', () => {
    const seen: string[] = []
    pick('<div><svg id="outer"><svg id="inner"><rect/></svg></svg></div>', '#inner rect', (el) => {
      seen.push(el.getAttribute('id') ?? el.tagName)
      return true
    })
    expect(seen).toEqual(['outer'])
  })
})
