import type { MarkTint } from '../../core/marks'
import type { MarkPalette } from './session'
import type { Align, ReadingStyle, SpacingIndices, Theme, Typeface } from '../state'
import {
  DEFAULT_READING_STYLE,
  FIGURE_HEIGHTS,
  MOTION,
  FIGURE_WIDTHS,
  MINIMUM_SIZES,
  PARAGRAPH_INDENT,
  readingStep,
  spacingAt,
  stepAt,
} from '../../core/metrics'
import { dimBackground, inkFor } from '../../core/palette'
import { faceById } from '../../core/typefaces'
import { opticalScale } from '../fontProbe'
import { FLOOR_VAR, SMALL_ATTR, SMALL_VAR, markSmallText } from './markSmallText'

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
/**
 * Is this page colour dark enough that the book's own ink will not read on it?
 *
 * Rec. 601 luma, which is the same weighting the corpus scan used to find that
 * 860 of 1,957 books declare a text colour below this line. The threshold is
 * generous on purpose: it decides whether to TAKE OVER the book's colours, and
 * doing that to a page that did not need it is the more damaging mistake.
 */
/**
 * HOW ONE STATIC SHEET SERVES EVERY CONFIGURATION (WI-14.3).
 *
 * A custom property cannot make a stylesheet disappear — that objection killed
 * the first version of the fidelity dial, and it is correct. An
 * ATTRIBUTE-PRESENCE SELECTOR on the root can, and it is what Readium has used
 * for years: :root[style*="--USER__textColor"]. A property written into the
 * root's inline style makes every rule keyed to its NAME apply, and removing
 * the property makes every one of them stop. The sheet never changes.
 *
 * THE NAME, NEVER THE VALUE. [style*="--paper-dark-page: 1"] would depend on
 * how a browser chooses to serialise a declaration it was handed through
 * setProperty — whitespace included. So a switch is a property that is either
 * PRESENT or ABSENT, and bookVars returns null for absent so the difference
 * cannot be expressed as an empty string by accident.
 *
 * THE TWO WRAPPERS ADD NO SPECIFICITY, and that is the whole of why the split
 * is behaviour-preserving. :where() contributes zero, so:
 *
 *   WHEN_DARK + img[data-paper-matte]  is (0,1,1), as img[data-paper-matte]
 *   ROOT_WHEN_DARK +  *:not(a)         is (0,1,1), as :root *:not(a)
 *
 * Which one a rule takes depends on whether its ORIGINAL selector already had
 * :root as an ancestor. Getting that backwards is silent: the rule goes on
 * matching and merely wins or loses one argument it did not use to.
 */
const WHEN_DARK = ':where(:root[style*="--paper-dark-page"]) '
const ROOT_WHEN_DARK = ':root:where([style*="--paper-dark-page"])'

/**
 * The same mechanism for the fidelity dial — see Fidelity.
 *
 * PRESENT MEANS PAPER WINS. The house typography sits unmarked in the before
 * sheet, where a book that states anything beats it; this gate repeats it in
 * after, where Paper beats the book on source order. Take the property away
 * and the repeat stops matching, so the book keeps its own links, headings and
 * blockquotes and Paper's remain only as a default for books that state none.
 *
 * Zero added specificity again, and here it is load-bearing rather than tidy:
 * at (0,1,1) this would start beating .chapter h1, which today wins. The
 * dial is meant to hand typography BACK, never to take more of it.
 */
const WHEN_PAPER = ':where(:root[style*="--paper-fidelity-paper"]) '

/**
 * WI-14.4's settings, each a gate of the same shape.
 *
 * ONE FUNCTION RATHER THAN FIFTEEN CONSTANTS, because the shape is the whole
 * of it and fifteen near-identical strings is fifteen chances to mistype a
 * property name — which fails SILENTLY, as a rule that never matches.
 *
 * THE NAME IS A PREFIX MATCH, and two of these have to be read with that in
 * mind. [style*="--paper-figure-hairline"] cannot collide with
 * --paper-figure-height, but [style*="--paper-indent"] WOULD have collided
 * with a --paper-indent-on beside it, which is one of the reasons there is no
 * such property. A test asserts no gate name is a prefix of another.
 */
export const when = (name: string) => `:where(:root[style*="${name}"]) `

const DARK_INK = `
 
/* THE READER'S INK WINS ON A DARK PAGE, WHEREVER THE BOOK SPEAKS.
 *
 * Paper sets colour on html and reaches everything else by INHERITANCE —
 * and inheritance is consulted only where the cascade produced no value at
 * all. So any colour the book declares anywhere beats it. Measured over 1,957
 * books: 1,400 (71.5%) declare a text colour somewhere and 860 (43.9%) declare
 * one dark enough to vanish here. A reader choosing a dark theme and getting
 * black text is a control being overruled, which this sheet refuses everywhere
 * else.
 *
 * color: inherit !important, NOT color: <ink> !important, and that is
 * the whole trick — taken from Readium CSS, which has had it for years. The
 * value stays in ONE place, on the root, and every element is forced back onto
 * the chain the book broke. A rule naming the ink instead reaches only the
 * elements it selects: an earlier draft of this forced the marked prose
 * containers and a nested <span style="color:#000"> stayed black, because
 * forcing a parent only makes the child inherit and the child's own
 * declaration beats inheritance. The identical rule the defect is made of.
 *
 * FOUR PARTS, none of them optional:
 *
 *  - :not(a) — links keep their own colour, or every link in the book
 *    dissolves into the body text.
 *  - background-color: transparent — the half the defect's own description
 *    missed. A callout with background: #fff is a white slab on a dark page
 *    however right its text colour is.
 *  - border-color: currentColor — a rule or table border hard-coded black
 *    is invisible here otherwise.
 *  - svg text { fill } — SVG text takes fill, not color, so a colour rule
 *    never touches it however broad.
 *
 * :root * and not *: the root itself must keep the page colour, and an
 * important transparent background on it would take the theme away entirely.
 * Paper's own painted elements are excluded by name for the same reason — the
 * ruler band, the spoken word, and A MATTED FIGURE, which is painted in the
 * colour sampled from its own corners.
 *
 * THE MATTE EXCLUSION IS NOT DECORATION. Without it this rule silently deletes
 * the matte on exactly the pages it exists for: important beats non-important
 * whatever the specificity, so background-color: transparent !important at
 * (0,3,1) defeats img[data-paper-matte] at (0,1,1) every time. Shipped that way
 * for one commit, where the feature did nothing on a dark page and everything
 * on the light pages that never needed it.
 *
 * WHAT THIS COSTS, honestly: a book that colours dialogue by speaker loses
 * that here. Apple takes the same trade and gives the publisher an opt-out by
 * name — "if you do not specify class=ibooks-dark-theme-use-custom-text-color,
 * Apple Books uses white text when a reader selects a dark theme". Paper's
 * equivalent is the fidelity setting, and until it exists the reader's theme
 * wins, which is the same default Apple ships.
 *
 * STILL MISSING: an image with a baked-in white background is untouched by any
 * of this — background-color does not reach pixels. Readium darkens and
 * inverts behind their own settings; that is the image work, not this. */
/* THE ROOT'S OWN COLOUR IS FORCED TOO, and leaving it unmarked was a hole in
   the middle of this rule. Everything below inherits from the root — that is
   the whole mechanism — so a publisher who wins the root wins the document:
   html.chapter { background: #fff; color: #111 } outranks Paper's bare html
   rule, and every descendant then dutifully inherits the publisher's ink onto
   a page the reader asked to be dark.

   Readium marks the root for exactly this reason, and WI-14.1 quotes the rule
   with the mark on it — :root[style*="--USER__textColor"] { color: var(…)
   !important } — while Paper shipped the descendants marked and the root not.
   color-scheme goes with them, or form controls and scrollbars keep the
   publisher's light idea of the page. */
${ROOT_WHEN_DARK} {
  color: var(--paper-ink) !important;
  background: var(--paper-surface) !important;
  color-scheme: var(--paper-color-scheme) !important;
}

${ROOT_WHEN_DARK} *:not(a) {
  color: inherit !important;
  border-color: currentColor !important;
}

/* THE BACKGROUND EXEMPTIONS ARE THEIR OWN RULE, because they are exemptions
   from clearing a background and nothing else. Folded into the rule above, the
   exclusion also took color and border-color away from a matted figure —
   which is not what "keep your own background" means. */
${ROOT_WHEN_DARK} *:not(a):not(.paper-ruler-band):not(.paper-spoken-word):not([data-paper-matte]) {
  background-color: transparent !important;
}

${ROOT_WHEN_DARK} svg text {
  fill: currentColor !important;
  stroke: none !important;
}
`

/**
 * The plate itself. See matteFigures for how the colour is chosen.
 *
 * ONLY ON A DARK PAGE. Written unconditionally first, while every word of its
 * rationale was about dark pages — so Paper, Slate, Sepia and Sage all gained
 * padding and a radius around every flat-backed figure, for a problem none of
 * them has. A 16px ornament took roughly 25px of padding at the default line
 * and more than doubled the box it occupies, which quietly undid the
 * "max-width, never width" promise the rule above makes about small images.
 *
 * MARKED, because it is Paper painting, not a default: unmarked it loses to any
 * publisher background, and losing means the slab comes back.
 *
 * The padding is capped in em as well as in the line, so it stays in
 * proportion to a small image instead of swallowing it.
 */
const MATTE = `
${WHEN_DARK}img[data-paper-matte] {
  background: var(--paper-matte) !important;
  padding: min(calc(var(--paper-line) * 0.375), 0.5em); /* constant: half the type it sits in, so a 16px ornament keeps its proportions */
  border-radius: calc(var(--paper-line) * 0.125);
}
`

export function isDark(hex: string): boolean {
  /**
   * THE WHOLE STRING, AND BOTH LENGTHS.
   *
   * `parseInt` stops at the first character it cannot read, so `#ffgarbage`
   * parsed as `0xff` — a very dark blue — and returned true for a string that
   * is not a colour. And a three-digit hex is a real CSS colour that this read
   * as a six-digit one: `#fff` became `0x000fff`, which is `rgb(0, 15, 255)`,
   * luma 38, DARK. White reported as dark, and every rule gated on a dark page
   * would have come on over it.
   *
   * Paper's own five themes are all six-digit, so nothing shipped wrong — but
   * this is exported, `pageFilter` decides a PDF's inversion with it, and "no
   * caller passes a short hex today" is not a property anything checks.
   */
  const raw = hex.trim().replace(/^#/, '')
  const full = /^[0-9a-f]{3}$/i.test(raw) ? raw.replace(/./g, (c) => c + c) : raw
  if (!/^[0-9a-f]{6}$/i.test(full)) return false
  const n = Number.parseInt(full, 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return (r * 299 + g * 587 + b * 114) / 1000 < 90
}

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
   * How a line fills its measure, and whether words may break to help it.
   *
   * REPLACES a justify boolean and a hyphenate boolean — two settings for
   * one decision, with four combinations of which only three are worth having.
   * ALIGNS lists those three, so the reader cycles decisions rather than
   * assembling one from parts:
   *
   *   justified             both edges flush, long words broken to fit
   *   justified-no-hyphens  both edges flush, the word spaces stretched instead
   *   ragged                reading edge flush, the far edge left uneven
   *
   * The middle one is the one to be careful about rather than the one to
   * forbid — measured on a page, the worst word gap goes from 12px hyphenated
   * to 27px without, against a natural space of 4px, which is what rivers are.
   * See the note where this is used for the rest of the measurements.
   */
  readonly align: Align
  /** How open the type is set — see SPACING. */
  readonly spacing: SpacingIndices
  /**
   * The reader's brightness and contrast, RESOLVED rather than as indices.
   *
   * The book is an iframe with its own document, so the custom properties the
   * app writes for these do not reach it — it has to be told. See
   * bookColours.
   */
  readonly brightness: number
  readonly contrast: number
  /**
   * How the book is SET — WI-14.4's fifteen, including the fidelity dial.
   *
   * OPTIONAL, AND EVERY DEFAULT IS THE BEHAVIOUR PAPER ALREADY SHIPPED, so a
   * caller that says nothing gets exactly what it got before these existed.
   * DEFAULT_READING_STYLE is where that promise is kept, and a test holds the
   * sheets to it.
   */
  readonly style?: Partial<ReadingStyle>
}

/**
 * The reader's settings, as the custom properties the two sheets read.
 *
 * THIS IS THE CONTRACT (WI-14.3). Everything that varies is here; everything
 * that does not is in the sheets, which are built once. A settings change used
 * to rebuild all 585 lines of the stylesheet as a string — re-running
 * `hostFontFaces()` against `document.styleSheets` on the way — and re-inject
 * it, forcing a full CSS re-parse in every open document, for a change of one
 * number. Now it is a property write.
 *
 * That is the visible half. The invisible half is why the phase needed it:
 * adding a setting meant editing a template literal, so there was nowhere to
 * put a fidelity dial and no way for PDF to share any of it.
 *
 * `null` MEANS REMOVE, and it is not the same as an empty string. Two of these
 * are switches read by an attribute-presence selector — see `WHEN_DARK` — and
 * for those, presence IS the value. Writing `--paper-dark-page: ` with nothing
 * after it leaves the property present and every dark rule in force on a white
 * page.
 */
export type BookVars = Readonly<Record<string, string | null>>

export function bookVars({
  stepIdx,
  theme,
  typeface,
  align,
  spacing,
  brightness,
  contrast,
  style,
}: BookCssOptions): BookVars {
  const set: ReadingStyle = { ...DEFAULT_READING_STYLE, ...style }
  const step = readingStep(stepIdx)
  /* THE THREE STATES, RESOLVED INTO THE TWO PROPERTIES THEY MEAN. Alignment and
     hyphenation are separate declarations but not separate settings — see
     ALIGNS, which lists the three combinations worth offering and leaves the
     fourth unreachable. */
  const flush = align !== 'ragged'
  const breakWords = align === 'justified'
  const c = bookColours(theme, brightness, contrast)
  const face = faceById(typeface)
  /* THE SIZE THE READER ASKED FOR, CORRECTED FOR THIS FACE. Two faces at 21px
   * do not read the same size — see typefaces.ts — so a reader who switched
   * face found their book had silently changed size and raised the step to
   * compensate, which changed their measure as well. Rounded, because a
   * fractional font-size lands text on half pixels. */
  const size = Math.round(step.size * opticalScale(face))
  /* THE LINE BOX IS THE GRID, and everything else is measured against it.
   * Paragraph spacing is a multiple of it rather than a length so that opening
   * the leading opens the space between paragraphs with it — otherwise a reader
   * who loosened their lines got paragraphs that looked tighter than before.
   *
   * THE READER'S LEADING IS ALSO KEPT AS A RATIO, because the two are wanted in
   * different places. Prose gets the line BOX, in pixels, so consecutive
   * paragraphs sit on one grid. A heading has no business on that grid — its
   * type is a different size — but it does have business following the Line
   * control, and before WI-14.0 it did not: it took a hardcoded 1.2 and the
   * setting stopped at the prose. Same shape as F1, a control that appears
   * global and is not. */
  const lineScale = spacingAt('line', spacing.line)
  const line = Math.round(step.line * lineScale)
  /* IS THE PAGE DARK? Asked of the colour rather than of the theme's NAME.
     theme === 'night' was the test, in one place, and the moment a second
     place needed the same answer it became a fact stored twice — the next dark
     theme would have set color-scheme correctly and left every book's own
     black text unforced, which is a defect nothing would report. */
  const darkPage = isDark(c.surface)

  return {
    '--paper-ink': c.ink,
    '--paper-surface': c.surface,
    '--paper-accent': c.accent,
    '--paper-band': c.band,
    '--paper-mark': c.mark,
    '--paper-color-scheme': darkPage ? 'dark' : 'light',
    '--paper-size': `${size}px`,
    /* THE READER'S LINE, not the step's. Paragraphs, lists and quotes all read
       this rather than the body's own line-height, so leaving the step's value
       on `body` would have let the setting move the body and nothing else —
       which is every block of prose in the book. */
    '--paper-line': `${line}px`,
    '--paper-line-scale': String(lineScale),
    /* Written unconditionally, including at zero: an author stylesheet may set
       either of these, and a rule that appeared only when the reader had moved
       it would leave the book's own tracking in force at the default — so "0"
       would mean two different things depending on the book. */
    '--paper-letter': `${spacingAt('letter', spacing.letter)}em`,
    '--paper-word': `${spacingAt('word', spacing.word)}em`,
    '--paper-family': face.stack,
    /* START, NEVER LEFT. The flush edge is on the left in English, on the right
       in Arabic and at the top in vertical Japanese: one behaviour, three
       appearances, and the document says which it is. Nothing here detects
       anything — a logical value follows the book's own dir and writing-mode,
       and a heuristic guessing direction from character ranges would be worse
       than the declaration it was overriding. */
    '--paper-align': flush ? 'justify' : 'start',
    '--paper-hyphens': breakWords ? 'auto' : 'manual',
    /* THE PARAGRAPH SPACING, AND THE SEPARATION SETTING CAN TAKE IT AWAY.
       SPACING.paragraph deliberately has no zero step — it had one and
       withdrew it, because "nothing here indents a paragraph, so no space
       between them runs the prose together". Something does now, and this is
       where the two controls meet: choosing indent zeroes the space without
       moving the reader's position on the spacing scale, so the value is still
       there when they choose space again. The Settings panel hides that row
       while it cannot do anything, rather than leaving a dead control. */
    '--paper-para': set.separation === 'indent' ? '0' : String(spacingAt('paragraph', spacing.paragraph)),
    /* THE VALUE IS THE SWITCH, which is Readium's own idiom —
       :root[style*="--USER__textColor"] { color: var(--USER__textColor) }. A
       separate --paper-indent-on beside it would be two properties that must
       agree, and the rule needs a gate rather than a zero: text-indent: 0
       !important on every prose paragraph would take a book's own indent away
       in the state where the reader asked for no indent AT ALL. */
    '--paper-indent': set.separation === 'space' ? null : `${PARAGRAPH_INDENT}em`,
    /* THE FIGURE CAP, IN ONE UNIT OR THE OTHER. A share of the measure is what
       a figure has always taken; em makes it grow with the type instead,
       which is what a reader who enlarges the text for their eyes rather than
       for the layout is asking for. The number is the same either way — 95 of
       the measure, or 95 tenths of an em — so the scale reads the same in both. */
    '--paper-figure-width': set.figureScalesWithText
      ? `${stepAt(FIGURE_WIDTHS, set.figureWidth) / 10}em`
      : `${stepAt(FIGURE_WIDTHS, set.figureWidth)}%`,
    '--paper-figure-height': `${stepAt(FIGURE_HEIGHTS, set.figureHeight)}vh`,
    /* inherit rather than absent, because pre and code take the browser's
       monospace by default and the reader asking for the book's face means the
       BOOK's, not the UA's. */
    '--paper-code-family': set.codeFace === 'paper' ? faceById('plex').stack : 'inherit',
    /* THE SWITCHES. Presence, never a value — see WHEN_DARK. A null here is
       a property REMOVED from the root, which is what makes the rule keyed to
       its name stop matching; an empty string would leave it in force. */
    '--paper-dark-page': darkPage ? '1' : null,
    '--paper-fidelity-paper': set.fidelity === 'paper' ? '1' : null,
    '--paper-drop-cap': set.flourish === 'drop-cap' ? '1' : null,
    '--paper-small-caps': set.flourish === 'small-caps' ? '1' : null,
    '--paper-heading-scale': set.headingScale === 'paper' ? '1' : null,
    '--paper-quote-rule': set.blockquote === 'indent' ? null : '1',
    '--paper-quote-tint': set.blockquote === 'tint' ? '1' : null,
    '--paper-code-wrap': set.codeWrap === 'wrap' ? '1' : null,
    '--paper-figure-hairline': set.figureFrame === 'hairline' ? '1' : null,
    '--paper-figure-shadow': set.figureFrame === 'shadow' ? '1' : null,
    '--paper-table-shrink': set.wideTables === 'shrink' ? '1' : null,
    '--paper-note-prose': set.noteSize === 'prose' ? '1' : null,
    '--paper-figure-scale': set.figureScalesWithText ? '1' : null,
    '--paper-cjk-space': set.cjkSpacing ? '1' : null,
    /* A FLOOR IS AN OVERRIDE OF THE AUTHOR'S PROPORTIONS, so step 0 is off and
       the property is absent rather than set to zero — a max(1em, 0px) would
       be a rule that runs on every element in every book to accomplish
       nothing. See MINIMUM_SIZES for the 8.5px that bought this. */
    '--paper-min-size': stepAt(MINIMUM_SIZES, set.minimumSize) === 0
      ? null
      : `${stepAt(MINIMUM_SIZES, set.minimumSize)}px`,
  }
}

/**
 * Write the contract onto a document's root.
 *
 * INLINE ON `:root`, WHICH IS NOT AN IMPLEMENTATION DETAIL. A rule in a
 * stylesheet would carry the same values, and the two switches would stop
 * working: `[style*="--paper-dark-page"]` reads the root's `style` ATTRIBUTE,
 * and a custom property declared in a sheet never appears there. That is
 * Readium's mechanism and it is the reason the fidelity dial can exist at all.
 *
 * Every document that shows the book's text needs this — the page's, and the
 * note popover's, which renders in a view the session did not build. A document
 * that misses it has no `--paper-line`, so every `calc(var(--paper-line) * 1.5)`
 * in the sheets is invalid at computed-value time and silently drops. See the
 * test that asserts the sheets read no variable this does not define.
 */
export function applyBookVars(doc: Document, options: BookCssOptions): void {
  const root = doc.documentElement as HTMLElement | null
  if (!root?.style) return
  const before = measurementKey(root)
  for (const [name, value] of Object.entries(bookVars(options))) {
    if (value === null) root.style.removeProperty(name)
    else root.style.setProperty(name, value)
  }
  /* THE ACCESSIBILITY FLOOR'S MEASUREMENTS ARE RELATIVE TO THE BASE, AND THE
     BASE JUST MOVED. `markSmallText` stores each small element's size as a
     share of the root, which holds for `em`, `rem` and `%` and NOT for an
     absolute size: a book's `.note { font-size: 12px }` keeps its 12px while
     the root changes underneath it, so the stored share goes stale. Roughly 1%
     of the library sizes text absolutely.

     Only when the base actually moved, which is the reading step and the
     typeface and nothing else — a theme or a brightness change costs nothing
     here. And skipped on the FIRST write, when there is no previous value: the
     session's load handler runs the walk itself, after the book's own
     stylesheet has landed. */
  if (before !== '' && before !== measurementKey(root)) markSmallText(doc)
}

/**
 * Everything on the root that can change a computed font size in the document.
 *
 * NOT JUST `--paper-size`, which is what this compared first and was not
 * enough. The heading scale gives `h1`-`h6` sizes they did not have, and the
 * note size resets the popover's own blocks — so an `h5` measured at the UA's
 * 0.83em is marked as small text, and turning Paper's heading scale on takes it
 * to 1.1em while the mark and its 0.83 ratio stay. The floor rule is
 * `!important`, so it would then SHRINK the heading to 0.83rem: the exact
 * damage `markSmallText` exists to avoid, arriving through a stale measurement
 * rather than through a bad selector.
 *
 * A KEY RATHER THAN THREE COMPARISONS, so adding a size-affecting setting is
 * one entry here and not a fourth branch somebody has to remember.
 */
export function measurementKey(root: HTMLElement): string {
  return ['--paper-size', '--paper-heading-scale', '--paper-note-prose']
    .map((name) => root.style.getPropertyValue(name))
    .join('|')
}

/**
 * The two sheets, in the order foliate takes them.
 *
 * `before` is PREPENDED to the book's head and `after` is APPENDED to it — see
 * `paginator.js`, which creates both and hands them out as a tuple. So the
 * cascade the reader gets is:
 *
 *   before                house defaults, unmarked
 *   the book's stylesheet
 *   the book's inline styles
 *   after                 the reader's controls, marked
 *
 * WHICH TIER A RULE BELONGS IN IS DECIDED BY ONE QUESTION, and the corpus
 * answers it rather than taste: can an inline style defeat it, and does that
 * matter. 90.5% of books carry inline styles and they beat `before`, the book's
 * own sheet and `after` alike — everything except `!important`. So `before`
 * cannot hold a reader's control; it can only hold a default that stands down
 * gracefully in a book that speaks.
 *
 * A FOURTH SHEET EXISTS AND IS NAMED RATHER THAN IGNORED.
 * `generatedContent.ts` appends one at runtime, against selectors read out of
 * the book itself, carrying `content: none !important`. It is not a tier: it is
 * a narrowly-proven repair for a rule whose box can only ever be empty, and it
 * is marked because it must survive anything appended after it.
 *
 * (A code span is kept on ONE line throughout this file. Split across a line
 * break it leaves an odd backtick on each, which the compiler ignores and every
 * line-based reader of this file does not — see the guard in
 * `bookTokens.test.ts`, which was added after one cost an afternoon.)
 */
export type BookSheets = readonly [before: string, after: string]

/**
 * `@namespace` IS PER STYLESHEET, and this is the trap the split had waiting.
 *
 * The noteref rule is `a[epub|type~="noteref"]`, which needs the prefix
 * declared in the sheet that uses it. Splitting one sheet into two and leaving
 * the declaration in the other does not error: the selector simply stops
 * matching, every footnote link loses its superscript, and nothing anywhere
 * says why. Each sheet carries its own prologue.
 */
const PROLOGUE = '@namespace epub "http://www.idpf.org/2007/ops";'

/**
 * The house typography, written ONCE and placed in both tiers.
 *
 * `gate` is empty for `before` and `WHEN_PAPER` for `after`. That is the whole
 * of the fidelity dial: under `paper` the `after` copy applies and Paper wins on
 * source order, exactly as it did when there was one sheet; under `publisher`
 * the copy matches nothing and the book keeps its own, with `before` left as a
 * default for books that state none.
 *
 * ONE SOURCE, because two copies of nine declarations that must agree is a
 * drift waiting to happen, and the drift would be invisible: the sheets would
 * still parse and only one configuration would be wrong.
 *
 * MEASURED, NOT ASSUMED. These three selectors are the contested house
 * typography WI-14.0 measured over 1,957 books — links (1,134 books declare a
 * text-decoration), headings (912 a margin, 831 a weight, 425 a line-height)
 * and blockquotes (690 a margin, 50 a font-style). The other rows of that table
 * are not here and should not be: `body { text-align }` and
 * `body { font-family }` are the READER'S controls, which no dial may take
 * away, and `img { max-width }` turned out not to compete at all.
 */
const house = (gate: string) => `
${gate}h1, ${gate}h2, ${gate}h3, ${gate}h4, ${gate}h5, ${gate}h6 {
  font-weight: 600; /* constant: the house weight for a heading; a weight is a step of the face, not of any scale here */
  /* THE HOUSE RATIO, TIMES THE READER'S LINE SETTING. A flat 1.2 was the one
     place the Line control could not reach, so a reader who opened their
     leading got every paragraph in the book to move and every chapter title to
     stay exactly where it was. At the default the setting is 1 and this is 1.2,
     which is what it has always been. */
  line-height: calc(1.2 * var(--paper-line-scale));
  /* Round the heading's own space to the grid even though its line box is
     not on it — this is the cheapest way to stop a chapter opener pushing all
     following text permanently off the baseline. */
  margin-block: calc(var(--paper-line) * 1.5) var(--paper-line);
  text-wrap: balance;
}

${gate}a {
  color: var(--paper-accent);
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--paper-accent) 30%, transparent);
}

${gate}blockquote {
  margin-inline: calc(var(--paper-line) * 0.75);
  font-style: italic;
}
`

/**
 * The `before` sheet: house defaults, and nothing marked.
 *
 * NOTHING IN HERE IS !important, and a test holds it to that. The tier only
 * means anything because a book that states a view wins here; a marked rule in
 * `before` would beat the book from the wrong end of the cascade and make the
 * two sheets one again.
 */
const BEFORE = `
${PROLOGUE}

/* A <font> TAG IS FURNITURE FROM 1997, AND IT OUTRANKS THE READER.
 *
 * 114 books ship them, 308,899 of them between them — an affected book is
 * saturated, averaging over two thousand. They carry size= (205,416), color=
 * (102,602) and face= (21,085), and every one of those is a PRESENTATIONAL
 * HINT: a declared value on the element, so it beats anything the reader's
 * settings reach it by, which is inheritance.
 *
 * A hint loses to any author rule, so this one line is the whole fix, and it
 * belongs in this tier for exactly that reason — a book with real CSS for these
 * elements still wins. Measured before writing it: 24 books style the font
 * element in CSS, 114 use the tag, and ZERO do both, so nothing in the library
 * is affected by which of the two wins here.
 *
 * <center> IS LEFT ALONE. 1,666 books contain one, almost always exactly one —
 * a title page, a dedication. That is the book composing, and markProse
 * already exists to tell composition from a converter's default.
 */
font {
  font: inherit;
  color: inherit;
}
${house('')}
/* WI-14.4's house settings. Every one is unmarked and in this tier, which is
 * what the plan's tier column says and what makes them DEFAULTS: a book that
 * states a view on its own headings, quotations, code or tables goes on
 * winning, and these reach the books that state none. The reader's controls —
 * separation, note size, the figure's text-scaling and the minimum size — are
 * in the other sheet, marked, for the opposite reason.
 */

/* THE OPENING FLOURISH. Both states are pseudo-elements, which draw nothing
 * into the document — and that is not a convenience. Every mark in this app is
 * CFI-anchored with 32 characters of context either side, and inserting so much
 * as a span would invalidate all of them. markProse says which paragraph the
 * opening is, because CSS cannot: p:first-of-type matches the first paragraph
 * of every blockquote, note and aside in the chapter as readily as the one the
 * chapter opens with. */
${when('--paper-drop-cap')}p[data-paper-opening]::first-letter {
  /* -webkit- ONLY, AND THAT IS MEASURED, NOT CAUTION. Asked of the running
     app: CSS.supports('initial-letter', '2') is false and the prefixed form is
     true. The unprefixed property is written beside it so this starts working
     the day WebKit ships it, and neither is a fallback for the other — an
     unsupported declaration is dropped and the supported one stands. */
  -webkit-initial-letter: 3; /* constant: three lines deep, which is what a drop cap is in print */
  initial-letter: 3; /* constant: three lines deep, the unprefixed spelling of the line above */
  margin-inline-end: 0.1em; /* constant: the sidebearing a raised initial needs, in its own size */
  font-weight: 600; /* constant: the house weight for an initial, which is a step of the face */
}

${when('--paper-small-caps')}p[data-paper-opening]::first-line {
  font-variant-caps: small-caps;
  letter-spacing: 0.04em; /* constant: small caps need opening up or they set as a dark band */
}

/* HEADINGS ON ONE SCALE, for a shelf of converted books that each invented
 * their own. Off by default: Paper has never set a heading's SIZE, and that is
 * deliberate — h1 { font-size: 2.25em } resolves against the reader's base, so
 * the author's proportions survive whole. This takes them. */
${when('--paper-heading-scale')}h1 { font-size: 2em; }   /* constant: the classic double-body first level */
${when('--paper-heading-scale')}h2 { font-size: 1.6em; } /* constant: one step down the same fourth */
${when('--paper-heading-scale')}h3 { font-size: 1.3em; } /* constant: one step down again */
${when('--paper-heading-scale')}h4,
${when('--paper-heading-scale')}h5,
${when('--paper-heading-scale')}h6 { font-size: 1.1em; } /* constant: barely above the prose, which is what a fourth level is */

/* A QUOTATION, SET APART. The indent is what the sheet has always done and is
 * the default; the rule and the tint are the two other ways print does it. */
${when('--paper-quote-rule')}blockquote {
  border-inline-start: 2px solid color-mix(in srgb, var(--paper-ink) 25%, transparent); /* constant: a rule the eye reads as a rule, not as a hairline border */
  padding-inline-start: calc(var(--paper-line) * 0.5);
  font-style: normal;
}

${when('--paper-quote-tint')}blockquote {
  background: color-mix(in srgb, var(--paper-ink) 5%, transparent); /* constant: a tint at the threshold of visible, so the quote is set apart and not boxed */
  padding-block: calc(var(--paper-line) * 0.25);
  padding-inline-end: calc(var(--paper-line) * 0.5);
  border-radius: 3px; /* constant: enough that the corner is not hard, as the ruler band is */
}

/* CODE. The face is one property; what a line too long for the measure does is
 * the other, and it is the same question a wide table asks below. */
pre, code, kbd, samp {
  font-family: var(--paper-code-family);
}

/* SCROLL IS THE DEFAULT AND WRAP IS THE CHOICE, because scrolling alters
 * nothing: the lines stay where the author broke them. What Paper does today is
 * neither — an unstyled pre spills out of the column and is simply cut off. */
pre {
  overflow-x: auto;
}

${when('--paper-code-wrap')}pre {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  overflow-x: visible;
}

/* A WIDE TABLE, and the same two answers. display: block is what makes the
 * table itself the scroll port — there is no wrapper to give it one, and there
 * will not be: inserting an element invalidates every CFI in the section. */
table {
  /* display: block IS THE WHOLE RULE, not decoration beside it. overflow-x
     is not honoured on a display: table box, so this branch scrolled nothing
     at all until an audit read the comment against the code — the comment had
     said so from the start. Making the table a block box gives it a scroll port
     of its own; its rows stay a table by anonymous-box generation. */
  display: block;
  overflow-x: auto;
}

${when('--paper-table-shrink')}table {
  display: table;
  table-layout: fixed;
  width: 100%;
  overflow-x: visible;
}

/* THE FIGURE, and the settings that size and frame it — see markFigures for
 * which images are figures and why CSS cannot answer that question. */
img[data-paper-figure],
svg[data-paper-figure] {
  max-width: var(--paper-figure-width);
  max-height: var(--paper-figure-height);
}

${when('--paper-figure-hairline')}img[data-paper-figure],
${when('--paper-figure-hairline')}svg[data-paper-figure] {
  border: 1px solid color-mix(in srgb, var(--paper-ink) 20%, transparent);
}

${when('--paper-figure-shadow')}img[data-paper-figure],
${when('--paper-figure-shadow')}svg[data-paper-figure] {
  box-shadow: 0 2px 12px color-mix(in srgb, var(--paper-ink) 18%, transparent); /* constant: one soft drop, the plate lifted off the page */
}

/* SPACE BETWEEN CJK AND LATIN. text-autospace, never pangu.js and never
 * anything that inserts a character: 7 books of 1,957 carry substantial CJK,
 * and not one of them is worth invalidating a reader's marks for. Asked of the
 * running app rather than assumed — this WebKit supports the property, so the
 * control is real rather than a row that does nothing. */
${when('--paper-cjk-space')}body {
  text-autospace: ideograph-alpha ideograph-numeric;
}
`

/**
 * The `after` sheet, without the bundled faces — see `bookSheets`.
 *
 * THE READER'S CONTROLS LIVE HERE AND NOWHERE ELSE, because a control that an
 * inline style can defeat is not a control, and only `!important` beats one.
 */
const AFTER_BODY = `
html {
  color-scheme: var(--paper-color-scheme);
  color: var(--paper-ink);
  background: var(--paper-surface);
  /* THE BASE, ON THE ROOT, AND THIS IS WHERE IT HAS TO BE.
   *
   * rem resolves against the ROOT, never against body — so a size declared
   * only on body leaves every rem in the book pinned to the browser's
   * 16px, whatever the reader does with the control. Measured across the whole
   * library: 618 of the 1,831 books that ship any CSS size text in rem, and
   * they carry 52,361 such declarations between them. A THIRD OF THE LIBRARY
   * had text the size setting could not move — chapter titles, drop caps,
   * whole paragraphs — while the prose beside it scaled.
   *
   * ALMOST NO BOOK CONTESTS THIS: 4 of the 1,831 set a font-size on html, and
   * the mark below is what decides those four. Read from a 400-book sample
   * first, where the count was 0 and the mark looked like belt-and-braces; the
   * full library says otherwise, which is the whole reason the sample was
   * re-run over all 1,960.
   *
   * !important because the BASE IS THE READER'S, and 12 of those books mark
   * their own font-size important. Forcing the base is safe in a way that
   * forcing a descendant is not: h1 { font-size: 2.25em } still resolves to
   * 2.25 x the base, so the author's proportions survive intact. It is only
   * ever the starting number that is taken. */
  font-size: var(--paper-size) !important;
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
  font-family: var(--paper-family);
  /* FROM THE ROOT, so there is one number rather than two that must agree.
   * Marked for the same reason the root is: a book that adjusts its own body
   * size is stating a default, and the default is precisely what the reader's
   * control owns. 15 of 372 books do; Paper already overrode all of them by
   * source order, and this keeps that true against a higher-specificity rule
   * such as body.chapter. */
  font-size: 1rem !important;
  line-height: var(--paper-line);
  letter-spacing: var(--paper-letter);
  word-spacing: var(--paper-word);
  text-align: var(--paper-align);
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
  -webkit-hyphens: var(--paper-hyphens);
  hyphens: var(--paper-hyphens);
  -webkit-font-smoothing: antialiased;
  overflow-wrap: break-word;
}

/* Prose spacing is a multiple of the line box, so consecutive paragraphs stay
 * on grid even though headings and figures will not. */
/* THE READER'S OWN SETTINGS, AND THEREFORE NOT DEFAULTS.
 *
 * Everything the before sheet injects is a default that a book may override.
 * These are not: they are controls a reader operated, and a control that
 * silently does nothing is worse than no control.
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
  /* THE GRID, OR THE TEXT'S OWN LINE — whichever is taller.
   *
   * A flat var(--paper-line) is right for prose at the base and wrong for
   * prose that is not. Books enlarge a paragraph — an opener, a pull quote —
   * and 44 declarations across 400 books set a prose element at 1.5rem or
   * more, up to 4rem. Those were sized against the browser's 16px, so
   * p { font-size: 2rem } came out 32px inside a 34px line and just cleared
   * it. Now that rem follows the reader, the same rule is 42px at the
   * default step, and a fixed 34px line would lay one line of it across the
   * next. The 4rem case has been overlapping all along.
   *
   * max() keeps the reading grid EXACTLY where the grid is the right answer:
   * at the 21/34 default, prose stays on grid until 28.3px — 1.35rem — so the
   * 50 declarations at 1.2rem are untouched and only deliberately-enlarged
   * text gets a line of its own. The setting still moves every line of prose
   * in the book; it simply stops being able to crush the exceptions. */
  line-height: max(var(--paper-line), 1.2em) !important; /* constant: the floor, one-and-a-fifth of the enlarged text own size */
  letter-spacing: var(--paper-letter) !important;
  word-spacing: var(--paper-word) !important;
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
 * in the contract rather than going on the elements, so changing the setting is
 * still one property write and the marks never need revisiting. */
/* THE ELEMENT IS NAMED AS WELL AS THE MARKER, and it buys one thing: weight.
 *
 * [data-paper-prose] alone is specificity (0,1,0), and a book that writes
 * p.body { text-align: justify !important } is (0,1,1) — higher, so it wins
 * even against an important declaration here. Naming the element takes this to
 * (0,1,1) too, and a tie goes to the later origin, which is this sheet.
 *
 * It does not win everything and is not meant to. p[data-paper-prose] is one
 * attribute and one element, so it TIES anything of the same weight — p.body,
 * and .chapter p as well, both of which are one class and one element — and a
 * tie goes to this sheet. What still beats it is two classes deep:
 * .chapter p.body is (0,2,1). Measured over 400 EPUBs, 1.2% use !important on
 * paragraph alignment at all, so this closes the common half of a rare case for
 * the cost of four selectors. */
p[data-paper-prose],
li[data-paper-prose],
blockquote[data-paper-prose],
dd[data-paper-prose] {
  text-align: var(--paper-align) !important;
  /* Hyphenation rides with the alignment rather than sitting in the rule above,
     because it is half of the same setting and must land on the same elements.
     A centred dedication that asked for hyphens: manual is the book composing,
     and keeps what it asked for — that rule matches the element and this one
     does not reach it. Composition that expressed NO view on hyphenation still
     inherits the reader's from body above, which is right: the setting is a
     default, and an element that said nothing has not been overruled. */
  -webkit-hyphens: var(--paper-hyphens) !important;
  hyphens: var(--paper-hyphens) !important;
}

p {
  margin: 0 0 calc(var(--paper-line) * var(--paper-para)) !important;
}

/* THE OTHER HALF OF PARAGRAPH SEPARATION — see SEPARATIONS. Print has two
 * answers and they are alternatives; both is offered because real books set
 * an indent and a small space together and a reader may want to match one.
 *
 * +, WHICH IS THE CONVENTION AND NOT A TRICK. The first paragraph after a
 * heading takes no indent, because there is nothing above it to be told apart
 * from — and an adjacent-sibling selector says exactly that and nothing else.
 * Against the PROSE MARKER on both sides, so a centred dedication following a
 * centred epigraph is not indented into running text.
 *
 * GATED ON THE VALUE ITSELF, Readium's idiom: no property, no rule. Written as
 * text-indent: 0 !important in the off state it would take a book's own
 * indent away from a reader who asked for none — Paper overriding in the state
 * that means "do not override". */
${when('--paper-indent')}p[data-paper-prose] + p[data-paper-prose] {
  text-indent: var(--paper-indent) !important;
}

/* A FLOOR UNDER THE SMALLEST TEXT — F5. The median book's smallest relative
 * size is 0.70 of the base and the 5th percentile is 0.50, so at the smallest
 * step that is 11.9px typically and 8.5px in one book in twenty. The reader
 * chose the step; the book chose the 0.50, against a base that has since moved
 * under it.
 *
 * NOT max(1em, floor) ON *, which is the obvious rule and is wrong: inside
 * font-size, 1em is the PARENT's size, so h1 { font-size: 2em } would resolve
 * to the parent's and every heading, note and drop cap in the library would
 * flatten into the size of the text around it. spacing.test.ts has said so for
 * a long time and caught that rule the day it was written.
 *
 * The element's OWN ratio is measured once and written on it — see
 * markSmallText, which answers a question CSS cannot ask. Above the floor an
 * element keeps its ratio exactly; below it, it is raised to the floor and no
 * further. Only elements SMALLER than the base are marked, so no rule here can
 * reach a heading at all.
 *
 * Off by default: a floor IS an override of the author's proportions, so it is
 * offered rather than imposed. */
${when(FLOOR_VAR)}[${SMALL_ATTR}] {
  font-size: max(calc(var(${SMALL_VAR}) * 1rem), var(${FLOOR_VAR})) !important;
}

/* An adjacent-sibling paragraph rule was here, zeroing margin-top, and it did
 * nothing the rule above does not already do: the shorthand sets margin-top to
 * 0 for every paragraph, at the same specificity. Its comment described
 * indentation, which neither rule touches. All it could still do was override
 * an author's own adjacent-paragraph spacing on a stylesheet that matched this
 * specificity exactly — not something the injected sheet should decide.
 * (And no backticks in here: this is a template literal, as the rule further
 * down says out loud.) */
${house(WHEN_PAPER)}
/* NOT FIDELITY-GATED, AND THE MEASUREMENT IS WHY. This was listed among the
 * house rules a book contests, on the reading that a book's img { width }
 * competes with it. It does not — width and max-width are different properties
 * and both apply — and the declaration that would compete, the book's own
 * max-width, is in 7 books of 1,957. There is nothing here to hand back, and it
 * is a safety rule besides: without it an oversized image overruns the column
 * whoever the fidelity belongs to. */
img, svg, video {
  max-width: 100%;
  height: auto;
}

/* A FIGURE, which is not the same thing as an image — see markFigures. 45.0%
   of the images in this library sit beside text, and centring those at 95% of
   the measure turns a drop cap or a gaiji into a full-width plate mid-sentence.
   The attribute is the answer to a question CSS cannot ask: does this image's
   block carry any words. */
/* THE CAPS MOVED TO THE OTHER SHEET WITH WI-14.4, and only the caps. What a
   figure IS — a block, centred in the measure — is not a setting and stays
   here; how wide and how tall it may be became two, and the plan's tier column
   puts them among the house defaults. */
img[data-paper-figure],
svg[data-paper-figure] {
  display: block;
  margin-inline: auto;
}

/* MATTED IN ITS OWN COLOUR, so the white it was exported with becomes a plate
   rather than a slab. The colour is sampled from the image's four corners at
   load — see matteFigures — and set as a custom property on the element; only
   images that HAVE a flat opaque background get the attribute, so a transparent
   PNG is left exactly as it is.

   This is the alternative to filtering. Darkening or inverting an image damages
   the artwork, and invert() on a photograph is grotesque; a bare border does
   not change a white rectangle into anything but a bordered white rectangle.
   Extending the image's own background outward is how a printed book mounts a
   plate on coloured stock: nothing is altered, and it stops looking broken. */
${MATTE}
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
  z-index: -1; /* constant: one layer behind the text, which is not a depth on any scale */
  inset-inline: -10px; /* constant: clear of the glyphs, so it reads as a band rather than a box */
  background: var(--paper-band);
  border-radius: 3px; /* constant: enough that the corner is not hard, which is a threshold and not a size */
  pointer-events: none;
  /* FROM THE MOTION TABLE, not a literal beside it. This was 90ms written out
     here while MOTION.rulerTrack held the same value and nothing read it — so
     the token was decoration and changing it did nothing. The token is the
     value now, and the reduced-motion variant below shortens it. */
  transition: top ${MOTION.rulerTrack};
}

/* §08 keeps the ruler's track under reduced motion — it is a reading aid, not
 * decoration — but shortens it. This used to restate 90ms, the same value as
 * the rule above, so the branch existed and did nothing: a reader who asks for
 * reduced motion got exactly the animation they asked to be spared. 40ms still
 * reads as the band moving rather than teleporting. */
@media (prefers-reduced-motion: reduce) {
  .paper-ruler-band {
    transition-duration: 40ms; /* constant: still movement rather than a teleport, which is what reduced motion asks for */
  }
}

/* The word being read aloud. Behind the text like the ruler's band, and for
 * the same reason — a fill over the glyphs would obscure the one word the
 * reader is being asked to follow. It takes the mark colour rather than a
 * colour of its own: §01 has no token for speech, and inventing one would be
 * a colour the themes do not re-value. */
.paper-spoken-word {
  position: absolute;
  z-index: -1; /* constant: one layer behind the text, as the ruler band is */
  background: var(--paper-mark);
  border-radius: 2px; /* constant: enough that the corner is not hard, on a box the size of one word */
  pointer-events: none;
}

::selection {
  background: color-mix(in srgb, var(--paper-accent) 24%, transparent);
}
${DARK_INK}
/* A FIGURE'S CAP GROWS WITH THE TYPE, when the reader asks it to.
 *
 * IN THIS TIER, unlike the rest of the figure settings, and the plan's tier
 * column is right about that: a share of the measure is a house default, and
 * "make the pictures bigger when I make the text bigger" is a reader saying
 * something about their eyes. The value is one property either way — see
 * --paper-figure-width — so what this rule adds is the mark, which is what
 * lets it beat a book's own inline width on the image. */
${when('--paper-figure-scale')}img[data-paper-figure],
${when('--paper-figure-scale')}svg[data-paper-figure] {
  max-width: var(--paper-figure-width) !important;
}

/* Footnote and endnote links are targets for the popover, not destinations.
 * The epub prefix this needs is declared at the head of THIS sheet — see
 * PROLOGUE, and the note there about what happens when it is not. */
a[epub|type~="noteref"] {
  vertical-align: super;
  font-size: 0.75em; /* constant: three quarters of its own context, the printer own reference size */
  border-bottom: none;
}
`.trim()

/**
 * The two sheets to hand `renderer.setStyles`.
 *
 * Static but for the bundled faces, which cannot be: `hostFontFaces()` reads
 * the host's own `document.styleSheets`, and a book opened before the webfont
 * CSS has landed would otherwise pin an empty result for the session. It caches
 * once it finds something, so this is one array join on the common path.
 *
 * THE FACES BELONG IN `after` AND ONLY THERE. The last matching `@font-face`
 * for a family wins, so a copy in `before` could be shadowed by a book that
 * declares a face of the same name — and the bundled Literata the whole reading
 * typography is specified around would silently become somebody else's.
 */
let cachedSheets: BookSheets | null = null
let cachedSheetFaces: string | null = null

export function bookSheets(): BookSheets {
  const faces = hostFontFaces()
  /* Cached on the faces rather than unconditionally, and handed back by
     IDENTITY: the caller skips `setStyles` when the tuple has not changed, and
     setting a style element's textContent to the same string still re-parses
     the sheet in every open document. That is the cost F4 names. */
  if (cachedSheets && cachedSheetFaces === faces) return cachedSheets
  cachedSheetFaces = faces
  cachedSheets = [
    BEFORE,
    [
      PROLOGUE,
      '',
      '/* The bundled faces, carried in from the host — see hostFontFaces(). Without',
      ' * them the stack below falls through to Georgia in every book. */',
      faces,
      AFTER_BODY,
    ].join('\n'),
  ] as const
  return cachedSheets
}

/**
 * A NOTE IS NOT SUBORDINATE TO ANYTHING IN A POPOVER.
 *
 * Books set notes smaller than the text — measured on What's Our Problem?,
 * .footnote is 70% and .footnote2 is 75% — and on the page that is right: a
 * note at the foot of a page is subordinate to the prose it annotates, and the
 * reduction is how print says so. In a popover there IS no prose beside it.
 * The note is alone in its own box, the reason for the reduction is absent, and
 * all it costs there is legibility.
 *
 * BY STRUCTURE, NOT BY CLASS NAME. There is no generic selector for "the rule
 * that shrinks notes" — every book spells it differently. What is the same in
 * every book is the SHAPE of what the popover holds: FootnoteHandler extracts
 * the note into the document body, so the note's own blocks are body's direct
 * children and nothing else is. Resetting those to the base leaves everything
 * NESTED — a citation at 0.9em, an emphasised run — proportional, which is the
 * author's typography and stays.
 *
 * MARKED, BECAUSE IT IS THE READER'S AND NOT A DEFAULT. `body > *` is (0,0,1)
 * and a book's own `.footnote { font-size: 70% }` is (0,1,0) — higher, so
 * unmarked this loses to the very rule it exists to answer and the 11.2px note
 * comes back on any book that names its notes by class. WI-14.4 puts the Note
 * size setting in the `after` tier, and `after` means marked; it shipped
 * unmarked and an audit caught it.
 */
const NOTE_CSS = `
${when('--paper-note-prose')}body > * { font-size: 1rem !important; }
`

/**
 * The page's two sheets, with the note's one extra rule in the appended tier.
 *
 * Cached against the tuple it was built from, so it too is stable by identity
 * — the caller skips on identity, and a fresh array every call would defeat
 * it silently rather than loudly.
 */
let cachedNoteSheets: BookSheets | null = null
let cachedNoteSheetsFrom: unknown = null

export function noteSheets(): BookSheets {
  const sheets = bookSheets()
  if (!cachedNoteSheets || cachedNoteSheetsFrom !== sheets) {
    cachedNoteSheetsFrom = sheets
    cachedNoteSheets = [sheets[0], sheets[1] + NOTE_CSS] as const
  }
  return cachedNoteSheets
}

/**
 * `var(--paper-*)` substituted from a contract, for a test that wants to read
 * the value a declaration resolves to.
 *
 * FOR TESTS AND DIAGNOSTICS. The app never does this — the whole point of the
 * split is that the sheet is not rebuilt — but an assertion about what a reader
 * SEES is an assertion about the resolved value, and reading it any other way
 * would be asserting the contract against itself.
 */
export function resolveBookVars(css: string, vars: BookVars): string {
  return css.replace(/var\((--paper-[\w-]+)\)/g, (whole, name: string) => vars[name] ?? whole)
}

/**
 * Both sheets, resolved, as one string — what the document effectively sees.
 *
 * FOR TESTS AND DIAGNOSTICS, and it is not what the app builds. The two
 * attribute-presence switches cannot be represented here, because they read the
 * root's inline `style`: a rule gated on `--paper-dark-page` appears in this
 * string whatever the theme, and whether it APPLIES is decided by `bookVars`.
 * A test about a switch asserts the variable, not this.
 */
export function resolvedBookCss(options: BookCssOptions): string {
  const [before, after] = bookSheets()
  return resolveBookVars(`${before}\n${after}`, bookVars(options))
}
