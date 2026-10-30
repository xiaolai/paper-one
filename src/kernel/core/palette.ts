/**
 * Dimming the app without a filter, and holding the text legible while it dims.
 *
 * WHY NOT `filter: brightness()`, which is the obvious way. Two reasons, and the
 * first is fatal here: a `filter` on an element makes it the containing block
 * for every `position: fixed` descendant. Measured in this app, a fixed child
 * of a filtered ancestor moved from (0,0) to (200,120) — and every menu Paper
 * draws is `position: fixed`, placed by `usePlacement` in viewport coordinates.
 * A root-level filter would silently misplace every dropdown, book menu and the
 * command palette.
 *
 * The second reason is that it would not do the job anyway. A filter dims the
 * text and the page by the same factor, so the contrast RATIO is unchanged and
 * the page simply gets murkier — less readable, no more comfortable. It would
 * also dim book covers, which are content rather than chrome.
 *
 * So the palette moves instead, and the two controls divide it the way their
 * names do:
 *
 *   BRIGHTNESS is the window's background — the surface, the page behind it,
 *   the hover fills and the rules. Every theme, one direction: down toward
 *   black. It was polarity-dependent first, dimming the TEXT on a dark theme on
 *   the reasoning that the text is what a dark screen emits — true, and beside
 *   the point: a control called Brightness that moves the text on one theme and
 *   the background on another is a control a reader cannot predict.
 *
 *   CONTRAST is the font, and only the font.
 *
 * THE RULES DIM WITH THE BACKGROUND, which is not obvious and is not optional.
 * `--line` on Paper has a luminance of 0.85; at the dimmest step the surface
 * reaches 0.52 — so a border left alone would be LIGHTER than the page it sits
 * on, and every hairline in the app would read as an inverted seam.
 */

/** A colour as this app writes them: `#RRGGBB`. */
export type Hex = string

function channels(hex: Hex): [number, number, number] {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: [number, number, number]): Hex {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`
}

/**
 * WCAG relative luminance — the same definition the contrast ratios in
 * `tokens.css` were measured against, so a number computed here is comparable
 * to the ones written down there.
 */
export function luminance(hex: Hex): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast, 1…21. */
export function contrastRatio(a: Hex, b: Hex): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** A straight sRGB blend. `amount` 0 keeps `from`, 1 becomes `to`. */
export function mix(from: Hex, to: Hex, amount: number): Hex {
  const t = Math.max(0, Math.min(1, amount))
  /* The ends return the caller's own string. A no-op blend that still went
     through hex would rewrite `#FFFFFF` as `#ffffff`, so "unchanged" would not
     compare equal to unchanged. */
  if (t === 0) return from
  if (t === 1) return to
  const [ar, ag, ab] = channels(from)
  const [br, bg, bb] = channels(to)
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t])
}

/** The six colours a theme's brightness and contrast can move. */
export interface Palette {
  /* The background, all of it — what `brightness` moves. */
  readonly surface: Hex
  readonly bg: Hex
  readonly wash: Hex
  readonly line: Hex
  readonly line2: Hex
  readonly line3: Hex
  /* The font — what `contrast` moves. */
  readonly ink: Hex
  readonly ink2: Hex
  readonly muted: Hex
}

const BLACK = '#000000'
const WHITE = '#FFFFFF'

/**
 * The floor no setting may cross.
 *
 * 4.5:1 is the ratio `tokens.css` publishes measured values against, and it is
 * body-text's threshold rather than a target — a reader who turns the contrast
 * all the way down should get soft text, not unreadable text. `muted` is held
 * to the same floor because it carries counts, dates and status, which are read
 * rather than glanced at.
 */
const FLOOR = 4.5

/**
 * Push `ink` until it clears the floor against `page`.
 *
 * TOWARD WHICHEVER END THE PAGE HAS ROOM FOR, which is not the same as away
 * from the ink. On a page dimmed to mid-grey, black text tops out at 3.6:1 and
 * white reaches 5.9 — so "away from the ink" chose the direction that could
 * never get there, and the floor silently failed on exactly the settings it
 * exists for. The page decides, and the answer is the end it contrasts with
 * more.
 *
 * Stepped rather than solved: the relation between a blend fraction and a
 * contrast ratio is not linear, and twenty steps of 5% is exact enough for a
 * value that will be rounded to a byte.
 */
function clearFloor(ink: Hex, page: Hex): Hex {
  if (contrastRatio(ink, page) >= FLOOR) return ink
  const away = contrastRatio(BLACK, page) >= contrastRatio(WHITE, page) ? BLACK : WHITE
  for (let step = 1; step <= 20; step += 1) {
    const tried = mix(ink, away, step / 20)
    if (contrastRatio(tried, page) >= FLOOR) return tried
  }
  /* Unreachable for a page this app can produce — `BRIGHTNESS` is bounded so
   * the page never reaches the mid grey where neither end clears 4.5. Returning
   * the most legible thing available is still better than returning the
   * illegible thing that was asked for. */
  return away
}

/**
 * A background at a reader's brightness.
 *
 * Exported because the BOOK is not this palette. It is an iframe with its own
 * document, and a custom property set on the app does not cross that boundary —
 * so the book is drawn from its own table of concrete colours (the Overlayer
 * paints marks as presentation attributes, where `var()` is not valid). That
 * table has to be adjusted by the same rules, and the way to keep two things
 * following one rule is one function, not two copies of it.
 */
export function dimBackground(colour: Hex, brightness: number): Hex {
  return mix(colour, BLACK, 1 - Math.max(0, Math.min(1, brightness)))
}

/**
 * A text colour at a reader's contrast, never under the floor.
 *
 * `page` is the background it will be read on — after dimming, since that is
 * what it has to contrast with.
 */
export function inkFor(colour: Hex, page: Hex, contrast: number): Hex {
  const away = luminance(page) > luminance(colour) ? BLACK : WHITE
  const pushed = contrast >= 0 ? mix(colour, away, contrast) : mix(colour, page, -contrast)
  return clearFloor(pushed, page)
}

/**
 * The palette a reader's brightness and contrast produce.
 *
 * `brightness` is the fraction of the theme's own light to keep, 1 being the
 * theme untouched. `contrast` pushes the text away from the page when positive
 * and lets it settle toward the page when negative.
 *
 * WHAT DIMS DEPENDS ON THE POLARITY, which is read from the theme rather than
 * configured: whichever of page and text is brighter is the one emitting the
 * light, and that is the one that comes down. Getting this from the colours
 * means a theme added later needs no entry anywhere.
 */
export function adjustPalette(base: Palette, brightness: number, contrast: number): Palette {
  /* THE BACKGROUND, in every theme and in one direction. A light page darkens
   * toward grey; a dark page darkens toward black, which is a real preference
   * and what an OLED screen does with it. The rules come too — see the note at
   * the top for what happens when they do not. */
  const surface = dimBackground(base.surface, brightness)
  const bg = dimBackground(base.bg, brightness)
  const wash = dimBackground(base.wash, brightness)
  const line = dimBackground(base.line, brightness)
  const line2 = dimBackground(base.line2, brightness)
  const line3 = dimBackground(base.line3, brightness)

  /* THE FONT, and only the font. Away from the page means darker on a light one
   * and lighter on a dark one, judged against the page AFTER dimming — on a
   * theme dimmed far enough the polarity is not the one the theme started
   * with. */
  return {
    surface,
    bg,
    wash,
    line,
    line2,
    line3,
    ink: inkFor(base.ink, surface, contrast),
    ink2: inkFor(base.ink2, surface, contrast),
    muted: inkFor(base.muted, surface, contrast),
  }
}