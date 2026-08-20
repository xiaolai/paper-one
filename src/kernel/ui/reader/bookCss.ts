import type { MarkTint } from '../../core/marks'
import type { MarkPalette } from './session'
import type { Align, SpacingIndices, Theme, Typeface } from '../state'
import { readingStep, spacingAt } from '../../core/metrics'
import { dimBackground, inkFor } from '../../core/palette'
import { faceById } from '../../core/typefaces'
import { opticalScale } from '../fontProbe'

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
  /**
   * §01's three mark tints, each a pale FILL and the saturated RULE that names
   * it — the fill for a band behind the words, the rule for a line under them
   * and for the swatch that offers it.
   *
   * Green and purple are not eyeballed. Each is its theme's own gold, held at
   * the same presence against that theme's page and rotated in hue: the rules
   * match the gold rule's contrast against the surface, and the fills match the
   * gold fill's, so no tint reads louder than another and none of them reads
   * louder here than it did before there was a choice. `markTints.test.ts`
   * asserts both, along with the 4.5:1 floor for ink on every fill.
   */
  mark: string
  markRule: string
  markGreen: string
  markGreenRule: string
  markPurple: string
  markPurpleRule: string
  /** §01's companion hue, darkened per theme to clear 4.5:1 on its own tint. */
  amber: string
  /** The reading ruler's band. `--wash` — one step off the page, never a tint. */
  band: string
}

/* EXPORTED so the invariants can be checked. The tints are derived rather than
   picked — see the note on `mark` above — and a derivation nothing asserts is
   just a story about where some hex values came from. `markTints.test.ts` holds
   the three properties they were derived to have, and checks that `tokens.css`
   still agrees with this table. */
export const BOOK_COLOURS: Record<Theme, BookColours> = {
  paper: { ink: '#17191B', surface: '#FFFFFF', accent: '#1B3A6B', mark: '#FAE8AF', markRule: '#D5B75A', markGreen: '#CAF7CA', markGreenRule: '#88CE8A', markPurple: '#E9CCFF', markPurpleRule: '#D1A4F3', amber: '#9E5A16', band: '#F2F3F1' },
  slate: { ink: '#1C2022', surface: '#DFE1DE', accent: '#23456F', mark: '#FCE4A8', markRule: '#B79A3B', markGreen: '#C5F5C7', markGreenRule: '#6CB06E', markPurple: '#E6C4FF', markPurpleRule: '#B388D4', amber: '#8A4C11', band: '#CBCFCA' },
  sepia: { ink: '#2B2117', surface: '#F8F0E1', accent: '#2C5578', mark: '#F3E8B8', markRule: '#C7AA4C', markGreen: '#C1F7D5', markGreenRule: '#7BC07D', markPurple: '#D2BCFF', markPurpleRule: '#C397E4', amber: '#985614', band: '#EBDFC9' },
  sage: { ink: '#1B2419', surface: '#DDE6D8', accent: '#2A4F6B', mark: '#FFE2AF', markRule: '#B99C3D', markGreen: '#CAF2CF', markGreenRule: '#6EB270', markPurple: '#E2BAFF', markPurpleRule: '#B68AD6', amber: '#8F5013', band: '#C7D4C1' },
  night: { ink: '#E9EAE8', surface: '#16191C', accent: '#8FB4E8', mark: '#533E00', markRule: '#85702A', markGreen: '#1F471B', markGreenRule: '#4E8050', markPurple: '#4C2D5B', markPurpleRule: '#83629A', amber: '#D9A25E', band: '#1E2226' },
}

/**
 * A theme's book colours at the reader's brightness and contrast.
 *
 * The BACKGROUNDS dim — the page, the ruler's band, and a highlight's fill,
 * which is a background however it is drawn. The INK moves with contrast and is
 * floored. The accent and the rule colours are left alone, as `--accent` is in
 * the app: they are brand and annotation, not the page and not the prose.
 *
 * THE BOOK NEEDS ITS OWN because it is an iframe with its own document, and the
 * custom properties the app writes for brightness and contrast do not cross
 * that boundary — a dimmed app had a page dimmed everywhere except the one
 * surface the reader is looking at. Same two rules, different table.
 */
function bookColours(theme: Theme, brightness: number, contrast: number): BookColours {
  const base = BOOK_COLOURS[theme]
  const surface = dimBackground(base.surface, brightness)
  return {
    ...base,
    surface,
    band: dimBackground(base.band, brightness),
    /* All three FILLS dim: a fill is a background however it is drawn, and a
       dimmed page with full-brightness marks leaves the marks as the only
       thing on screen that did not move. The RULES do not, for the same reason
       `accent` does not — they are annotation, not page. */
    mark: dimBackground(base.mark, brightness),
    markGreen: dimBackground(base.markGreen, brightness),
    markPurple: dimBackground(base.markPurple, brightness),
    ink: inkFor(base.ink, surface, contrast),
  }
}

/**
 * The colours the Overlayer paints marks with, for one theme.
 *
 * Concrete values rather than custom properties: the Overlayer sets `fill` as a
 * presentation ATTRIBUTE, and `var()` is not valid in one — marks would draw
 * black. Derived from the same table as the injected stylesheet so the drawn
 * mark and the CSS one cannot drift apart.
 *
 * NIGHT NO LONGER OVERRIDES THE STYLE. §05 used to say a mark becomes a rule
 * there, because "a pale fill would glare" — and that was right while the
 * reader had no say: a fill was the only drawing there was, so turning it into
 * a rule on the one theme it hurt was a kindness rather than a contradiction.
 * It stopped being either once fill and underline became a CHOICE. A reader who
 * picks a fill on Night and is given a rule has been overruled without being
 * told, and the two styles become indistinguishable on exactly the theme people
 * read longest on. The glare it guarded against is not there anyway: Night's
 * fills are dark — its gold is #4A3B18 — so a band on Night is a deepening of
 * the page, not a light on it.
 */
export function markPalette(theme: Theme, brightness: number, contrast: number): MarkPalette {
  /* The same adjusted table the stylesheet uses: read from `BOOK_COLOURS`
     directly, a dimmed book would have kept full-brightness highlights — the
     one thing on the page that had not moved. */
  const c = bookColours(theme, brightness, contrast)
  const fill: Record<MarkTint, string> = {
    yellow: c.mark,
    green: c.markGreen,
    purple: c.markPurple,
  }
  const rule: Record<MarkTint, string> = {
    yellow: c.markRule,
    green: c.markGreenRule,
    purple: c.markPurpleRule,
  }
  return { fill, rule, companion: c.amber }
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
/* THE STACKS LIVE IN `typefaces.ts` NOW, with the faces themselves. They were
 * a table here and a second table in the settings panel, and a third of the
 * decision — which faces exist at all — was in `panes.ts`. One registry. */

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
  /**
   * Justified, or flush to the reading edge.
   *
   * REPLACES a `justify` boolean and a `hyphenate` boolean, which were two
   * settings for one decision and allowed a combination that is simply bad
   * typography: justified WITHOUT hyphens, which opens rivers at this measure.
   * Collapsing them made that unrepresentable, and it still is.
   *
   * It also made ragged-with-hyphens unrepresentable, and that one was a loss
   * rather than a saving — it is ordinary typography, and it halves the rag.
   * So hyphenation is no longer on this axis at all; both values hyphenate, and
   * this setting means only what its name says. See the note where it is used
   * for the measurements.
   */
  readonly align: Align
  /** How open the type is set — see `SPACING`. */
  readonly spacing: SpacingIndices
  /**
   * The reader's brightness and contrast, RESOLVED rather than as indices.
   *
   * The book is an iframe with its own document, so the custom properties the
   * app writes for these do not reach it — it has to be told. See
   * `bookColours`.
   */
  readonly brightness: number
  readonly contrast: number
}

export function bookCss({
  stepIdx,
  theme,
  typeface,
  align,
  spacing,
  brightness,
  contrast,
}: BookCssOptions): string {
  const step = readingStep(stepIdx)
  /* THE THREE STATES, RESOLVED INTO THE TWO PROPERTIES THEY MEAN. Alignment and
     hyphenation are separate declarations but not separate settings — see
     `ALIGNS`, which lists the three combinations worth offering and leaves the
     fourth unreachable. */
  const flush = align !== 'ragged'
  const breakWords = align === 'justified'
  const c = bookColours(theme, brightness, contrast)
  const face = faceById(typeface)
  const stack = face.stack
  /* THE SIZE THE READER ASKED FOR, CORRECTED FOR THIS FACE. Two faces at 21px
   * do not read the same size — see `typefaces.ts` — so a reader who switched
   * face found their book had silently changed size and raised the step to
   * compensate, which changed their measure as well. Rounded, because a
   * fractional font-size lands text on half pixels. */
  const size = Math.round(step.size * opticalScale(face))
  /* THE LINE BOX IS THE GRID, and everything else is measured against it.
   * Paragraph spacing is a multiple of it rather than a length so that opening
   * the leading opens the space between paragraphs with it — otherwise a reader
   * who loosened their lines got paragraphs that looked tighter than before. */
  const line = Math.round(step.line * spacingAt('line', spacing.line))
  const letter = spacingAt('letter', spacing.letter)
  const word = spacingAt('word', spacing.word)
  const para = spacingAt('paragraph', spacing.paragraph)

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
  /* THE READER'S LINE, not the step's. Paragraphs, lists and quotes all read
     this rather than the body's own line-height, so leaving the step's value
     here would have let the setting move the body and nothing else — which is
     every block of prose in the book. */
  --paper-line: ${line}px;
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
  font-size: ${size}px;
  line-height: ${line}px;
  /* Written unconditionally, including at zero: an author stylesheet may set
   * either of these, and a rule that appears only when the reader has moved it
   * would leave the book's own tracking in force at the default — so "0" would
   * mean two different things depending on the book. */
  letter-spacing: ${letter}em;
  word-spacing: ${word}em;
  /* START, NEVER LEFT — and no backticks in here, per the rule this file states
   * further up: it is a template literal and one would end the string.
   *
   * The flush edge is on the left in English, on the right in Arabic and at the
   * top in vertical Japanese: one behaviour, three appearances, and the
   * document says which it is. Nothing here detects anything. A logical value
   * follows the book's own dir and writing-mode, and a heuristic guessing
   * direction from character ranges would be worse than the declaration it was
   * overriding. */
  text-align: ${flush ? 'justify' : 'start'};
  /* HYPHENATION IS HALF OF THE ALIGNMENT SETTING, not a switch of its own.
   *
   * The three states ALIGNS offers are two of alignment and two of hyphenation
   * minus the pairing nobody wants, and the pairing that survives on each side
   * is not arbitrary:
   *
   *   justified            breaks words, so the spaces need not stretch
   *   justified-no-hyphens keeps words whole, so the spaces stretch instead
   *   ragged               keeps words whole, and lets the line end early
   *
   * The middle one is the one to be careful about rather than the one to
   * forbid. With both edges flush and no word allowed to break, the only place
   * the slack can go is between the words, and at a narrow measure that opens
   * rivers of white down the page. It is offered because a reader who does not
   * want words broken is entitled to say so, and because the alternative to
   * offering it is the reader believing the app cannot do it.
   *
   * Ragged carries no hyphenation by decision rather than by mechanics.
   * Measured on a real book at the 660px measure, hyphens do halve the rag —
   * 15px mean against 29px, 34px worst against 73px — so the case for them is
   * real. It is overruled: a rag is what a reader picking ragged asked for.
   *
   * Hyphenating needs the document's language and does nothing at all without
   * it, silently — which is why the session supplies one when the book has not.
   * See ensureLang there. */
  -webkit-hyphens: ${breakWords ? 'auto' : 'manual'};
  hyphens: ${breakWords ? 'auto' : 'manual'};
  -webkit-font-smoothing: antialiased;
  overflow-wrap: break-word;
}

/* Prose spacing is a multiple of the line box, so consecutive paragraphs stay
 * on grid even though headings and figures will not. */
/* THE READER'S OWN SETTINGS, AND THEREFORE NOT DEFAULTS.
 *
 * Everything else this stylesheet injects is a default that a book may override
 * — that is stated at the top of the file and it is right. These four are not:
 * they are controls a reader operated, and a control that silently does nothing
 * is worse than no control.
 *
 * A BOOK BEATS AN ELEMENT SELECTOR WITHOUT TRYING. Measured on a real one, On
 * China ships p.nonindent { margin-bottom: 0em } — one class, specificity
 * (0,1,1), against our (0,0,1) — so paragraph spacing computed to 0px and the
 * control did nothing at all on that book. Calibre writes rules like it by the
 * hundred. Raising the selector only starts an arms race a book can always win
 * with one more class, so the reader's four are marked instead.
 *
 * Declared on the prose elements rather than left to inherit from body: an
 * inherited value loses to any rule that matches the element, so body-level
 * tracking would have been defeated by the same p.class it was meant to survive.
 */
p, li, blockquote, dd {
  line-height: var(--paper-line) !important;
  letter-spacing: ${letter}em !important;
  word-spacing: ${word}em !important;
}

/* ALIGNMENT IS THE READER'S TOO, BUT IT CANNOT SIMPLY JOIN THE RULE ABOVE.
 *
 * It is a control, so the argument at the head of that rule applies unchanged:
 * left to inherit from body it loses to any rule that matches the element, and
 * measured over 400 books in the library, 32% set paragraph alignment ONLY from
 * a class — on all of those the Alignment setting did exactly nothing, in
 * either position.
 *
 * What stops it being one more property in that list is that text-align is
 * the one place where a book is not stating a default but COMPOSING. 45% of
 * those same 400 centre paragraphs from a class — dedications, epigraphs,
 * verse, chapter numbers — and !important on p flattens every one of them
 * into running prose. That is not the reader's setting winning, it is the book
 * being damaged by it.
 *
 * So the reader's alignment is applied only where the book expressed no view
 * worth keeping: markProse in session.ts marks the elements whose own
 * alignment is a justification decision — justify, start, or the reading edge —
 * and leaves centred and far-edge text unmarked and untouched. The VALUE stays
 * here in CSS rather than going on the elements, so changing the setting is
 * still one stylesheet swap and the marks never need revisiting. */
[data-paper-prose] {
  text-align: ${flush ? 'justify' : 'start'} !important;
  /* Hyphenation rides with the alignment rather than sitting in the rule above,
     because it is half of the same setting and must land on the same elements.
     Marked prose is the reader's; a centred dedication that asked for
     hyphens: manual is the book composing, and keeps what it asked for. */
  -webkit-hyphens: ${breakWords ? 'auto' : 'manual'} !important;
  hyphens: ${breakWords ? 'auto' : 'manual'} !important;
}

p {
  margin: 0 0 calc(var(--paper-line) * ${para}) !important;
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
