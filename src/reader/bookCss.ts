import type { Theme } from '../lib/state'
import { READING_STEPS } from '../lib/metrics'

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
 * §14 fallback chain. Literata leads for Latin, Cyrillic and Greek; the
 * per-script Noto faces and the CJK packs are appended as they are embedded.
 */
const READING_STACK = [
  "'Literata Variable'",
  'Literata',
  "'Charis SIL'",
  'Georgia',
  'serif',
].join(', ')

export interface BookCssOptions {
  readonly stepIdx: number
  readonly theme: Theme
  readonly justify: boolean
  readonly hyphenate: boolean
}

export function bookCss({ stepIdx, theme, justify, hyphenate }: BookCssOptions): string {
  const step = READING_STEPS[stepIdx] ?? READING_STEPS[2]
  if (!step) throw new Error('READING_STEPS is empty')
  const c = BOOK_COLOURS[theme]

  return `
@namespace epub "http://www.idpf.org/2007/ops";

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
  /* The containing block for the ruler's band. foliate centres the measure by
   * giving body its own width and auto side margins, so anchoring the band to
   * body is what sizes it to the text column. Without this, body is static and
   * the band resolves its insets against the viewport instead — spanning the
   * full width of the scroller and running out past the measure on both sides. */
  position: relative;
  /* Transparent so the reading ruler's band is visible beneath the text.
   * The band is a negative-z-index child of body, and negative descendants
   * paint BEFORE the backgrounds of in-flow blocks — so a body background of
   * its own (which plenty of EPUBs set) would cover the band completely. The
   * page colour lives on the html rule above, so nothing is lost by clearing
   * it here. Note: no backticks in this file's CSS comments — it is a template
   * literal, and one would end the string. */
  background: transparent;
  font-family: ${READING_STACK};
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

/* An EPUB that indents its paragraphs should keep doing so; one that does not
 * should not have indentation invented for it. */
p + p {
  margin-top: 0;
}

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

@media (prefers-reduced-motion: reduce) {
  .paper-ruler-band {
    transition-duration: 90ms;
  }
}

/* §01 Marks: your own highlights are a gold fill in light themes and a rule in
 * Night, where a pale fill would glare. */
.paper-mark {
  background: ${theme === 'night' ? 'transparent' : c.mark};
  box-shadow: inset 0 -1px 0 ${c.markRule};
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
