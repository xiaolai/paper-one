import type { Theme, Typeface } from '../lib/state'
import { readingStep } from '../lib/metrics'

/**
 * The stylesheet injected into the book document.
 *
 * The handoff is explicit that this is a DEFAULT, not an invariant: "34px must
 * be injected into the book document as CSS, and EPUB stylesheets will
 * override parts of it. Headings, images, block quotes and footnotes will sit
 * off-grid regardless." So this sets the line box and lets the book win where
 * it insists, and the ruler measures real line rects from a Range rather than
 * assuming a constant step.
 *
 * The measure is NOT set here — foliate-js's paginator owns column width
 * through its `max-inline-size` attribute, and fighting it from inside the
 * document produces two competing widths.
 */

/** Token values per theme, mirrored from tokens.css for the book document,
 *  which cannot see the host's custom properties across the iframe boundary. */
interface BookColours {
  ink: string
  surface: string
  accent: string
  mark: string
  markRule: string
  /** §01's companion hue, darkened per theme to clear 4.5:1 on its own tint. */
  amber: string
  /** The reading ruler's band. `--wash` — one step off the page, never a tint. */
  band: string
}

const BOOK_COLOURS: Record<Theme, BookColours> = {
  paper: { ink: '#17191B', surface: '#FFFFFF', accent: '#1B3A6B', mark: '#F3E6C0', markRule: '#E0BE55', amber: '#9E5A16', band: '#F2F3F1' },
  slate: { ink: '#1C2022', surface: '#DFE1DE', accent: '#23456F', mark: '#DCCB92', markRule: '#B99B3F', amber: '#8A4C11', band: '#CBCFCA' },
  sepia: { ink: '#2B2117', surface: '#F8F0E1', accent: '#2C5578', mark: '#EEDBA6', markRule: '#C9A44E', amber: '#985614', band: '#EBDFC9' },
  sage: { ink: '#1B2419', surface: '#DDE6D8', accent: '#2A4F6B', mark: '#D8CE8C', markRule: '#AE9A3C', amber: '#8F5013', band: '#C7D4C1' },
  night: { ink: '#E9EAE8', surface: '#16191C', accent: '#8FB4E8', mark: '#4A3B18', markRule: '#8A6E2C', amber: '#D9A25E', band: '#1E2226' },
}

/**
 * The colours the Overlayer paints marks with, for one theme.
 *
 * Concrete values rather than custom properties: the Overlayer sets `fill` as a
 * presentation ATTRIBUTE, and `var()` is not valid in one — marks would draw
 * black. Derived from the same table as the injected stylesheet so the drawn
 * mark and the CSS one cannot drift apart.
 *
 * Night is the exception §05 calls for: a pale fill glares on a dark page, so
 * the reader's own mark becomes a rule and takes the rule's colour.
 */
export function markPalette(theme: Theme): {
  highlight: string
  companion: string
  highlightAsRule: boolean
} {
  const c = BOOK_COLOURS[theme]
  const night = theme === 'night'
  return {
    highlight: night ? c.markRule : c.mark,
    companion: c.amber,
    highlightAsRule: night,
  }
}

/**
 * §14 fallback chain, per face.
 *
 * Every leading family here MUST be one `main.tsx` imports, and the variable
 * name must match the `@font-face` rule that Fontsource ships — `hostFontFaces`
 * copies those rules into the book verbatim. Get the name wrong and there is no
 * error of any kind: an unknown family is simply skipped, the chain falls
 * through to Georgia or the platform's own, and the book looks plausible while
 * being set in something nobody chose. That already happened once, to the whole
 * app, for as long as it took someone to look closely at a serif.
 *
 * Each chain keeps a same-class fallback and then a generic, so a script
 * Fontsource does not cover degrades within its own genre rather than to a
 * serif in the middle of a sans-set book.
 */
const READING_STACKS: Record<Typeface, string> = {
  // Literata leads for Latin, Cyrillic and Greek; the per-script Noto faces and
  // the CJK packs are appended as they are embedded.
  literata: "'Literata Variable', Literata, 'Charis SIL', Georgia, serif",
  crimson: "'Crimson Pro Variable', 'Crimson Pro', Georgia, serif",
  instrument: "'Instrument Sans Variable', 'Instrument Sans', system-ui, sans-serif",
  plex: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
}

/**
 * The host's `@font-face` rules, for injection into the book.
 *
 * A book is an iframe with its own document, and `@font-face` does NOT inherit
 * across that boundary — a face registered in the host is simply unknown
 * inside it. So every book fell straight through §14's stack to Georgia, and
 * the bundled Literata that the whole reading typography is specified around
 * was never once used. Nothing reports it: an unknown family is not an error,
 * it is just the next entry in the fallback list.
 *
 * The rules are read back out of the host's own stylesheets rather than
 * restated here, so this cannot drift from what `main.tsx` actually imports.
 * `url()` is absolutised because the book document's base URL is a blob, and a
 * relative font path would resolve against that and 404.
 */
let cachedFaces: string | null = null

export function hostFontFaces(): string {
  if (cachedFaces) return cachedFaces
  const faces: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      // A cross-origin sheet throws on access. None of ours are, and one that
      // is cannot be read by anyone, so skipping is the only option.
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue
      faces.push(absoluteUrls(rule.cssText, sheet.href ?? document.baseURI))
    }
  }
  const css = faces.join('\n')
  // Only cached once something was found: a book opened before the font CSS
  // has landed would otherwise pin the empty result for the session.
  if (css) cachedFaces = css
  return css
}

function absoluteUrls(cssText: string, base: string): string {
  return cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (whole, quote: string, href: string) => {
    try {
      return `url(${quote}${new URL(href, base).href}${quote})`
    } catch {
      return whole
    }
  })
}

export interface BookCssOptions {
  readonly stepIdx: number
  readonly theme: Theme
  readonly typeface: Typeface
  readonly justify: boolean
  readonly hyphenate: boolean
}

export function bookCss({
  stepIdx,
  theme,
  typeface,
  justify,
  hyphenate,
}: BookCssOptions): string {
  const step = readingStep(stepIdx)
  const c = BOOK_COLOURS[theme]
  const stack = READING_STACKS[typeface]

  return `
@namespace epub "http://www.idpf.org/2007/ops";

/* The bundled faces, carried in from the host — see hostFontFaces(). Without
 * them the stack below falls through to Georgia in every book. */
${hostFontFaces()}

html {
  color-scheme: ${theme === 'night' ? 'dark' : 'light'};
  color: ${c.ink};
  background: ${c.surface};
  /* The line box is the unit everything else is a multiple of. */
  --paper-line: ${step.line}px;
  hanging-punctuation: allow-end last;
}

body {
  margin: 0;
  /* Transparent so the reading ruler's band is visible beneath the text.
   * The band is a negative-z-index child of body, and negative descendants
   * paint BEFORE the backgrounds of in-flow blocks — so a body background of
   * its own (which plenty of EPUBs set) would cover the band completely. The
   * page colour lives on the html rule above, so nothing is lost by clearing
   * it here. Note: no backticks in this file's CSS comments — it is a template
   * literal, and one would end the string. */
  background: transparent;
  font-family: ${stack};
  font-size: ${step.size}px;
  line-height: ${step.line}px;
  text-align: ${justify ? 'justify' : 'start'};
  -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
  hyphens: ${hyphenate ? 'auto' : 'manual'};
  -webkit-font-smoothing: antialiased;
  overflow-wrap: break-word;
}

/* Prose spacing is a multiple of the line box, so consecutive paragraphs stay
 * on grid even though headings and figures will not. */
p, li, blockquote, dd {
  line-height: var(--paper-line);
}

p {
  margin: 0 0 var(--paper-line);
}

/* An adjacent-sibling paragraph rule was here, zeroing margin-top, and it did
 * nothing the rule above does not already do: the shorthand sets margin-top to
 * 0 for every paragraph, at the same specificity. Its comment described
 * indentation, which neither rule touches. All it could still do was override
 * an author's own adjacent-paragraph spacing on a stylesheet that matched this
 * specificity exactly — not something the injected sheet should decide.
 * (And no backticks in here: this is a template literal, as the rule further
 * down says out loud.) */

h1, h2, h3, h4, h5, h6 {
  font-weight: 600;
  line-height: 1.2;
  /* Round the heading's own space to the grid even though its line box is
   * not on it — this is the cheapest way to stop a chapter opener pushing all
   * following text permanently off the baseline. */
  margin-block: calc(var(--paper-line) * 1.5) var(--paper-line);
  text-wrap: balance;
}

a {
  color: ${c.accent};
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, ${c.accent} 30%, transparent);
}

img, svg, video {
  max-width: 100%;
  height: auto;
}

blockquote {
  margin-inline: calc(var(--paper-line) * 0.75);
  font-style: italic;
}

/* The containing block for the ruler's band and the spoken-word box. foliate
 * centres the measure by giving body its own width and auto side margins, so
 * anchoring to body is what sizes the band to the text column; static body
 * would resolve its insets against the viewport instead, spanning the full
 * width of the scroller and running out past the measure on both sides.
 *
 * Conditional, not unconditional. Relative positioning on body also re-parents
 * any absolutely positioned content the BOOK places against the initial
 * containing block, and a reader who never switches the ruler on should not
 * have their book relaid out for a feature they are not using. rulerBand.ts
 * adds this class with the first overlay it injects and removes it with the
 * last. And no backticks in here, as the rule below already says: this is a
 * template literal and one would end the string. */
.paper-anchored {
  position: relative;
}

/* §12 layer 0 — the reading ruler's band, BEHIND the text.
 *
 * z-index: -1 is what puts it there: negative descendants paint after the
 * stacking context's own background and before in-flow content. Drawn from the
 * host it could not reach this layer at all, because the book's document paints
 * an opaque background over anything behind the iframe.
 *
 * Inset slightly past the measure on both sides so it reads as a band around
 * the line rather than a box clipped to the glyphs.
 *
 * §08 keeps the ruler's track under reduced motion — it is a reading aid, not
 * decoration — so the transition is shortened there rather than removed. */
.paper-ruler-band {
  position: absolute;
  z-index: -1;
  inset-inline: -10px;
  background: ${c.band};
  border-radius: 3px;
  pointer-events: none;
  transition: top 90ms ease;
}

/* §08 keeps the ruler's track under reduced motion — it is a reading aid, not
 * decoration — but shortens it. This used to restate 90ms, the same value as
 * the rule above, so the branch existed and did nothing: a reader who asks for
 * reduced motion got exactly the animation they asked to be spared. 40ms still
 * reads as the band moving rather than teleporting. */
@media (prefers-reduced-motion: reduce) {
  .paper-ruler-band {
    transition-duration: 40ms;
  }
}

/* The word being read aloud. Behind the text like the ruler's band, and for
 * the same reason — a fill over the glyphs would obscure the one word the
 * reader is being asked to follow. It takes the mark colour rather than a
 * colour of its own: §01 has no token for speech, and inventing one would be
 * a colour the themes do not re-value. */
.paper-spoken-word {
  position: absolute;
  z-index: -1;
  background: ${c.mark};
  border-radius: 2px;
  pointer-events: none;
}

::selection {
  background: color-mix(in srgb, ${c.accent} 24%, transparent);
}

/* Footnote and endnote links are targets for the popover, not destinations. */
a[epub|type~="noteref"] {
  vertical-align: super;
  font-size: 0.75em;
  border-bottom: none;
}
`.trim()
}
