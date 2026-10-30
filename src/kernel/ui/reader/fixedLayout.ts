import { BRIGHTNESS, CONTRAST, stepAt } from '../../core/metrics'
import type { Theme } from '../../core/uiTypes'
import { BOOK_COLOURS, isDark } from './bookCss'

/**
 * WHAT A FIXED-LAYOUT BOOK CAN TAKE FROM THE READER, AND WHAT IT CANNOT
 * (WI-14.5).
 *
 * A PDF is not a document with a stylesheet. `makePdf` turns it into one HTML
 * page per PDF page and `foliate-fxl` renders those, but the words are PIXELS
 * that pdf.js has painted onto a canvas — so there is no text to resize, no
 * line to lead, no measure to set, and no colour to declare. `setStyles` is
 * not merely unimplemented on that renderer; there is almost nothing for a
 * stylesheet to say.
 *
 * THE POINT OF WRITING IT DOWN. Today which settings reach a PDF is an accident
 * of where each one happens to be implemented: the layout attributes reach it
 * because `applyLayout` sets them on any renderer, the stylesheet does not
 * because `setStyles` is optional and `foliate-fxl` has no such method. Neither
 * of those is a decision anybody made, and neither is visible from the Settings
 * panel — so a reader moves a control and nothing happens, with nothing to say
 * why. This states the split, and a test holds the code to it.
 *
 * WHAT ROUND 3 WAS RIGHT ABOUT. The item as first written said theme,
 * brightness, contrast and margins "apply to the pdf.js page as readily as to
 * an EPUB document", which is false as stated — the fixed-layout renderer paints
 * to canvas inside a closed shadow root and observes only `zoom`. There IS a
 * mechanism, and it is not a stylesheet: both renderers put `part="filter"` on
 * their iframe and `view.js` exports it (`exportparts="head,foot,filter"`), so
 * the HOST can style that frame from outside two closed shadow roots. Verified
 * in the running app rather than inferred from the source.
 *
 * WHICH MAKES THE CONTRACT THIS:
 *
 *   the reader's LIGHT      brightness, contrast   a filter over the frame
 *   the reader's PAGE       a dark theme           an inversion, and it is a
 *                                                  real change to the artwork
 *   the reader's TYPE       size, measure, face,   nothing. There is no type.
 *                           spacing, alignment,
 *                           and WI-14.4's fifteen
 *   the reader's FLOW       paginated / scrolled   the `zoom` attribute, which
 *                                                  is fxl's own spelling of it
 *   the reader's MARGINS    pageMargins            nothing. They go to the
 *                                                  renderer through
 *                                                  `applyLayout`, and fxl
 *                                                  observes only `zoom`.
 */
/**
 * The settings, by the name the STATE uses.
 *
 * A UNION, NOT A STRING, and the first version of this table proved why: it
 * said `flow` where the field is `pageLayout`, so
 * `REACHES_FIXED_LAYOUT.has('pageLayout')` was false while the table read as
 * though it covered it. A contract whose keys are unchecked strings documents
 * whatever it happens to say, which is the state this item exists to replace.
 */
export type FixedLayoutSetting =
  | 'brightness'
  | 'contrast'
  | 'theme'
  | 'pageLayout'
  | 'pageMargins'
  | 'stepIdx'
  | 'measure'
  | 'typeface'
  | 'spacing'
  | 'align'
  | 'readingStyle'

export interface FixedLayoutSupport {
  readonly setting: FixedLayoutSetting
  readonly reaches: boolean
  readonly how: string
}

export const FIXED_LAYOUT_CONTRACT: readonly FixedLayoutSupport[] = [
  { setting: 'brightness', reaches: true, how: 'a filter over the page frame' },
  { setting: 'contrast', reaches: true, how: 'a filter over the page frame' },
  { setting: 'theme', reaches: true, how: 'inverted on a dark page; the page colour itself is pixels' },
  { setting: 'pageLayout', reaches: true, how: 'the zoom attribute, which is fxl’s spelling of flow' },
  /**
   * NOT REACHED, AND THE FIRST VERSION OF THIS TABLE SAID IT WAS.
   *
   * The claim was "the container, which is the app's own layout" — and
   * `pageMargins` is not applied by the container at all. It goes to the
   * renderer through `applyLayout`, which writes `margin`, `gap` and
   * `max-inline-size`; `foliate-fxl`'s `observedAttributes` is `['zoom']` and
   * it reads none of them. The page keeps the margins the PDF was made with.
   *
   * Caught by an audit of this file, which is the outcome the table is for: a
   * contract nobody can check is a longer way of writing the accident.
   */
  { setting: 'pageMargins', reaches: false, how: 'fxl observes only zoom; applyLayout’s margin attributes are ignored' },
  { setting: 'stepIdx', reaches: false, how: 'a fixed-layout page has no type to resize' },
  { setting: 'measure', reaches: false, how: 'the page carries its own width' },
  { setting: 'typeface', reaches: false, how: 'the glyphs are painted into the canvas' },
  { setting: 'spacing', reaches: false, how: 'there are no line boxes to open' },
  { setting: 'align', reaches: false, how: 'the lines are already broken' },
  { setting: 'readingStyle', reaches: false, how: 'every one of the fifteen is typographic' },
]

/** The settings a fixed-layout book takes, by name. */
export const REACHES_FIXED_LAYOUT: ReadonlySet<FixedLayoutSetting> = new Set(
  FIXED_LAYOUT_CONTRACT.filter((one) => one.reaches).map((one) => one.setting),
)

export interface PageFilterOptions {
  readonly theme: Theme
  /** Index into `BRIGHTNESS`. */
  readonly brightness: number
  /** Index into `CONTRAST`. */
  readonly contrast: number
}

/**
 * The reader's light and page, as a CSS filter for a fixed-layout page.
 *
 * `none` AT THE DEFAULTS, AND THAT IS NOT A MICRO-OPTIMISATION. A filter of any
 * kind promotes the frame to its own compositing layer and forces every page
 * turn through it; `brightness(1) contrast(1)` is a no-op that costs exactly as
 * much as a real one. A reader who has touched nothing gets no filter at all.
 *
 * THE INVERSION IS A REAL CHANGE TO THE ARTWORK, and this is the one place in
 * the phase where that is accepted rather than refused. WI-14.6 argues at
 * length against filtering an image — "invert() on a photograph is grotesque" —
 * and mattes a figure in its own sampled colour instead. Nothing of the kind is
 * available here: the page IS the image, there are no corners to sample and no
 * background to extend, and the alternative to inverting is a white page in a
 * reader who asked for a dark one. Every PDF reader that offers a dark mode
 * does this, for the same reason.
 *
 * `hue-rotate(180deg)` AFTER THE INVERT is what keeps colour usable. Inversion
 * alone takes a blue diagram to orange; rotating the hue back returns it to
 * roughly its own colour against the now-dark page. Black text and white paper
 * are unaffected either way, being unsaturated.
 *
 * CONTRAST IS MAPPED, NOT PASSED. `CONTRAST` runs from -0.35 to 0 where 0 means
 * the theme untouched — it is a REDUCTION, as `spacing.test.ts` asserts — and
 * CSS `contrast()` takes 1 for unchanged. So `1 + c`, which lands the scale on
 * 0.65 … 1 and can never harden past the theme, exactly as the ink cannot.
 */
export function pageFilter({ theme, brightness, contrast }: PageFilterOptions): string {
  const parts: string[] = []
  if (isDark(BOOK_COLOURS[theme].surface)) parts.push('invert(1)', 'hue-rotate(180deg)')
  const light = stepAt(BRIGHTNESS, brightness)
  if (light !== 1) parts.push(`brightness(${light})`)
  const hardness = 1 + stepAt(CONTRAST, contrast)
  if (hardness !== 1) parts.push(`contrast(${hardness})`)
  return parts.length === 0 ? 'none' : parts.join(' ')
}
