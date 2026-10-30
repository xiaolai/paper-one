/**
 * A plate, described so the HOST document can draw it.
 *
 * The session finds the element; this says what the host needs and nothing
 * else. Pure apart from the one object URL it may mint, which is why the
 * release is handed back rather than kept: the caller owns the lifetime, and a
 * module that both created and forgot a URL is how a section's image goes
 * blank behind an open viewer.
 *
 * ⚠️ **THE FORK'S OWN BLOB IS REUSED, NOT COPIED, AND THAT WAS MEASURED.**
 * WI-32.A0 asked whether a `blob:` URL minted inside a section reaches the host
 * at all — blob URLs are origin-scoped, so the answer was not obvious. It does:
 * a section's `img.src` is `blob:http://localhost:14201/…`, the host's own
 * origin, and `new Image()` in the host answered `LOADED 1560x329`. So there is
 * no canvas copy here and there must not be one: a copy would double the
 * memory of every plate to buy nothing.
 *
 * ⚠️ **AND THAT BLOB BELONGS TO THE SECTION.** `release` is null for a raster
 * image precisely so nobody revokes it — revoking the fork's URL blanks the
 * image on the page behind the viewer, and the page is still there.
 */

/** What the host needs in order to draw a plate large. */
export interface PlateDetail {
  /** A URL the HOST document can load. */
  readonly src: string
  /** The book's own words for it, or empty. The viewer's accessible name. */
  readonly alt: string
  /**
   * Natural size, or 0 when the element cannot say.
   *
   * ZERO IS A REAL ANSWER, not a failure: an `<img>` the layout has not reached
   * reports 0, and an inline `<svg>` with no `viewBox` has no intrinsic size at
   * all. The viewer fits to the window and does not need this; it is here so a
   * caller can refuse to scale past 1:1, which needs the number or nothing.
   */
  readonly width: number
  readonly height: number
}

/** A plate, with the cleanup its source may require. */
export interface PlateHandle {
  readonly detail: PlateDetail
  /** Non-null only for a serialised `<svg>` — see the header. */
  readonly release: (() => void) | null
}

const XLINK = 'http://www.w3.org/1999/xlink'

/**
 * An image's href, however the book spelled it.
 *
 * ⚠️ **`getAttribute('xlink:href')` ASSUMES THE PREFIX IS LITERALLY `xlink`.**
 * It is a namespace, so `xl:href` and any other prefix bound to the same URI
 * are equally valid — and those fell through to serialisation, where the image
 * cannot load, producing a blank viewer. `getAttributeNS` asks by namespace.
 */
const hrefOf = (image: Element): string =>
  image.getAttribute('href') ?? image.getAttributeNS(XLINK, 'href') ?? ''

/**
 * The `<image>` this SVG is nothing but a wrapper for, or null.
 *
 * ⚠️ **A COMPOSED FIGURE IS NOT A WRAPPER, AND THE FIRST VERSION TOOK ANY SVG
 * CONTAINING AN `<image>`.** That reduced a diagram of three photographs with
 * labels and clipping to its FIRST photograph — enlarging a figure to show
 * something different from what is on the page, which is worse than not
 * enlarging it. The shortcut now applies only where the SVG draws nothing
 * else: exactly one `<image>`, and no shape, text or nested drawing beside it.
 */
const DRAWS = 'text, tspan, path, rect, circle, ellipse, line, polyline, polygon, use, foreignObject, svg'
const wrappedImage = (svg: Element): Element | null => {
  const images = svg.querySelectorAll('image')
  if (images.length !== 1) return null
  if (svg.querySelector(DRAWS)) return null
  return images[0] ?? null
}

const sizeFromViewBox = (svg: Element): readonly [number, number] => {
  const box = svg.getAttribute('viewBox')
  if (!box) return [0, 0]
  const parts = box.trim().split(/[\s,]+/u)
  if (parts.length !== 4) return [0, 0]
  const width = Number(parts[2])
  const height = Number(parts[3])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return [0, 0]
  if (width <= 0 || height <= 0) return [0, 0]
  return [width, height]
}

/**
 * Describe a plate, or answer null when it cannot be drawn.
 *
 * ⚠️ **AN IMAGE WITH NO `src` IS NULL RATHER THAN AN EMPTY VIEWER.** A book
 * that ships a broken reference renders a placeholder on the page; opening a
 * viewer over nothing would turn a visible defect into a blank modal the reader
 * has to dismiss.
 */
export function plateOf(el: Element): PlateHandle | null {
  const doc = el.ownerDocument
  const view = doc.defaultView
  if (el instanceof (view?.HTMLImageElement ?? HTMLImageElement)) {
    const img = el as HTMLImageElement
    /* `currentSrc` is what the browser actually chose — it differs from `src`
       whenever the book uses `srcset`, and showing the other one would enlarge
       a different file from the one on the page. It is empty before load, so
       `src` is the fallback rather than the first choice. */
    const src = img.currentSrc || img.src
    if (!src) return null
    return {
      detail: {
        src,
        alt: (img.getAttribute('alt') ?? '').trim(),
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
      },
      release: null,
    }
  }
  if (el.tagName.toLowerCase() !== 'svg') return null
  /**
   * ⚠️ **AN `<svg>` WRAPPING AN `<image>` MUST USE THE IMAGE, NOT THE SVG.**
   * A serialised SVG is shown through `<img>`, and an SVG loaded as an image
   * is a closed document: it may not fetch ANY external resource, blob URLs
   * included. So `<svg><image href="blob:…"/></svg>` serialises fine, loads
   * fine, and renders **blank**.
   *
   * That is not a rare shape — it is the EPUB cover-wrapper idiom. Measured
   * over 120 books: 5 carry an inline `<svg>`, and **all 5 of them have an
   * `<image>` inside it**. Taking the href directly is both the fix and the
   * simpler path: it is the same blob the page itself is showing.
   */
  const inner = wrappedImage(el)
  const href = inner ? hrefOf(inner) : ''
  if (href !== '') {
    const [width, height] = sizeFromViewBox(el)
    return {
      detail: {
        src: href,
        alt: (el.querySelector('title')?.textContent ?? '').trim(),
        width,
        height,
      },
      /* The book's own blob again, so nothing here owns it — the raster rule
         above, for the same reason. */
      release: null,
    }
  }
  /* A vector-only `<svg>`: no external reference, so `<img>` can show it.
     ⚠️ **IT IS SERIALISED WITHOUT THE BOOK'S STYLESHEET**, so a diagram whose
     colours and strokes come from a CSS rule OUTSIDE the element will lose
     them. Inlining computed styles would fix that and is not done: every
     inline SVG measured on this shelf is the wrapper case above, so the cost
     would buy nothing here. Revisit with a corpus that shows otherwise. */
  const markup = new (view?.XMLSerializer ?? XMLSerializer)().serializeToString(el)
  if (!markup) return null
  const url = view?.URL ?? URL
  const blob = new (view?.Blob ?? Blob)([markup], { type: 'image/svg+xml' })
  const src = url.createObjectURL(blob)
  const [width, height] = sizeFromViewBox(el)
  return {
    detail: {
      src,
      /* An `<svg>`'s accessible name is its `<title>`, which is the SVG
         spelling of what `alt` is for a raster image. */
      alt: (el.querySelector('title')?.textContent ?? '').trim(),
      width,
      height,
    },
    release: () => url.revokeObjectURL(src),
  }
}

/**
 * Which element a click in the book means to enlarge, or null.
 *
 * PURE, AND EXTRACTED FOR THAT REASON. The four refusals below are the whole
 * correctness of opening a plate, and while they lived inside the session's
 * private click handler the only way to reach them was to drive a real click
 * through a fake document. Each is a decision about an element; none of them
 * needs a session.
 *
 * ⚠️ **THE LINK IS CHECKED FROM THE TARGET, NOT FROM THE IMAGE.**
 * `<svg><a xlink:href="…"><rect/></a></svg>` puts the anchor INSIDE the
 * drawing, so asking the image for an anchor ancestor finds nothing and the
 * viewer opened on top of a link the reader was following. Asking from the
 * target covers that and the ordinary case — an image inside a link — because
 * the target is a descendant of both.
 *
 * ⚠️ **AND THE ANSWER IS THE OUTERMOST `<svg>`, NOT THE PIECE UNDER THE
 * POINTER.** `closest('img, svg')` stops at an inner `<svg>`, so a composed
 * illustration would enlarge to whichever fragment was clicked, losing the
 * drawing around it.
 */
export function plateTargetOf(target: Element | null, isEnlargeable: (el: Element) => boolean): Element | null {
  if (!target || typeof target.closest !== 'function') return null
  if (target.closest('a')) return null
  const hit = target.closest('img, svg')
  if (!hit) return null
  let outermost = hit
  for (let up = hit.parentElement; up; up = up.parentElement) {
    if (up.tagName.toLowerCase() === 'svg') outermost = up
  }
  if (!isEnlargeable(outermost)) return null
  return outermost
}
