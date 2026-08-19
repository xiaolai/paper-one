/**
 * The mark tints, derived rather than picked.
 *
 * §01 gives a mark three tints and two roles: a pale FILL for the band drawn
 * behind the words, and a saturated RULE for the line drawn under them and for
 * the swatch that offers either. That is thirty values across five themes, and
 * thirty values chosen by eye drift — which is what this script exists to stop.
 * It prints the whole table from a model small enough to argue about:
 *
 *   - one HUE per tint,
 *   - one CHROMA per role,
 *   - one LIGHTNESS STEP from the page per role,
 *
 * with the chroma and the step allowed to differ between light pages and the
 * dark one, because those are the two situations a mark has to work in and they
 * are not the same problem.
 *
 * WHY OKLCH. The step has to be perceptual: the same WCAG contrast ratio is a
 * very different-looking band on white and on near-black, and the same sRGB
 * mix is a different amount of colour at every lightness. OKLCH's L is uniform
 * enough that one number means one apparent step on every theme.
 *
 * WHERE THE NUMBERS CAME FROM. Not invented — measured off what was already
 * shipping. The four light themes' own gold already agreed to within a few
 * thousandths (fill ΔL 0.063–0.074, rule ΔL 0.189–0.228, fill C 0.052–0.086,
 * rule C 0.113–0.129), so the light policy is those averages and the light
 * themes barely move. Night was the outlier, and only in one value: its rules
 * already sat at ΔL 0.34 and C 0.092, which is exactly what this reproduces,
 * while its FILL sat at ΔL 0.149 and C 0.055 — too dark and too grey to read as
 * a mark at all.
 *
 * Night's fill step is taken from Kindle's dark mode, sampled from a screenshot
 * on 2026-08-19: its band measures L 0.425, C 0.078 on a pure black page. Paper's
 * night page is L 0.212, so a step of 0.213 puts our band at the same ABSOLUTE
 * lightness Kindle puts its own. The chroma target of 0.075 is the same figure
 * from the other direction — it is what the light themes' fills already use, and
 * it is within a thousandth of Kindle's.
 *
 * Run: node scripts/mark-tints.mjs
 * Then paste into `src/reader/bookCss.ts` and `src/styles/tokens.css`, which
 * carry the same values for the book's document and the host's. They are two
 * tables because a book is an iframe and custom properties do not cross that
 * boundary; `markTints.test.ts` is what stops them disagreeing.
 */

/** The page and the ink of every theme, mirrored from `bookCss.ts`. */
const THEMES = {
  paper: { surface: '#FFFFFF', ink: '#17191B' },
  slate: { surface: '#DFE1DE', ink: '#1C2022' },
  sepia: { surface: '#F8F0E1', ink: '#2B2117' },
  sage: { surface: '#DDE6D8', ink: '#1B2419' },
  night: { surface: '#16191C', ink: '#E9EAE8' },
}

/**
 * THE BAND IS BLENDED, so the colour handed to the painter is not the colour
 * anybody sees.
 *
 * `Overlayer.highlight` paints its rects OVER the glyphs and sets
 * `mix-blend-mode` from `--overlayer-highlight-blend-mode` — a film at
 * `normal` would bury the words, so the mode is what makes a mark a
 * highlighter. On a light page that mode is `multiply`, which is what a real
 * highlighter does: it can only darken, so the glyphs survive.
 *
 * MULTIPLY IS THE WRONG OPERATOR ON A DARK PAGE, and this was the whole of
 * Night's ugliness. Multiplying a mid-tone band by a near-black page gives
 * something darker than the page: measured on the running app, a #5D4D15 band
 * over a #17191C page rendered as #060603 — a black smear that swallowed the
 * words rather than marking them. Night screens instead, which is multiply's
 * dual: it can only lighten, so on a dark page the glyphs survive for exactly
 * the same reason.
 *
 * So every fill below is generated twice. The MODEL describes what the reader
 * sees; the painter is handed whatever, blended against that theme's page,
 * produces it. Only `highlight` reads the property — `underline` and `squiggly`
 * paint normally — so the rules need none of this.
 */
const BLEND = { night: 'screen', default: 'multiply' }

/** One hue per tint. Yellow is the shipped gold's own; the other two are placed
 *  where they read as unmistakably green and unmistakably purple. */
const HUE = { yellow: 92, green: 145, purple: 310 }

/**
 * How much colour, and how far from the page, per role.
 *
 * A dark page takes MORE lightness and LESS chroma. More, because a band has to
 * climb further out of a dark page to be seen; less, because a saturated colour
 * on a dark ground reads as brighter than the same colour on a light one, and
 * at the light themes' rule chroma Night's gold loses its blue entirely and
 * turns acid.
 */
const POLICY = {
  light: { fill: { dL: 0.068, c: 0.075 }, rule: { dL: 0.212, c: 0.118 } },
  night: { fill: { dL: 0.213, c: 0.075 }, rule: { dL: 0.34, c: 0.092 } },
}

/** The floor every fill must clear for the text drawn on it. */
const INK_FLOOR = 4.5

const srgbToLinear = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : (((v / 255) + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
const parse = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
const format = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase()).join('')

const M1 = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]]
const M2 = [[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]]
const N1 = [[1, 0.3963377774, 0.2158037573], [1, -0.1055613458, -0.0638541728], [1, -0.0894841775, -1.2914855480]]
const N2 = [[4.0767416621, -3.3077115913, 0.2309699292], [-1.2684380046, 2.6097574011, -0.3413193965], [-0.0041960863, -0.7034186147, 1.7076147010]]

/** A colour's OKLCH lightness. */
function lightness(hex) {
  const rgb = parse(hex).map(srgbToLinear)
  const lms = M1.map((row) => Math.cbrt(row.reduce((sum, k, i) => sum + k * rgb[i], 0)))
  return M2[0].reduce((sum, k, i) => sum + k * lms[i], 0)
}

/** OKLCH back to sRGB, or null when the colour is outside the gamut. */
function fromLch(L, C, hueDeg) {
  const h = (hueDeg * Math.PI) / 180
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)]
  const lms = N1.map(([kl, ka, kb]) => (kl * L + ka * a + kb * b) ** 3)
  const rgb = N2.map((row) => row.reduce((sum, k, i) => sum + k * lms[i], 0))
  if (rgb.some((v) => v < -0.0005 || v > 1.0005)) return null
  return format(rgb.map((v) => linearToSrgb(Math.max(0, Math.min(1, v))) * 255))
}

/** The most chroma the sRGB gamut allows at this lightness and hue. */
function reachableChroma(L, hue, ceiling = 0.4) {
  let lo = 0
  let hi = ceiling
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2
    if (fromLch(L, mid, hue)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * How far past the policy step a hue has to go before it can hold the chroma.
 *
 * NOT EVERY HUE IS AVAILABLE AT EVERY LIGHTNESS. sRGB is a lopsided solid:
 * measured at the light themes' fill lightness of L 0.932, yellow reaches
 * chroma 0.094 and green 0.125, while purple tops out at 0.044 — barely a
 * colour. Held at the policy step, paper's purple fill came out a grey-lilac
 * that did not read as purple at all.
 *
 * So the step is a MINIMUM rather than a fixed distance: a hue the gamut cannot
 * serve there keeps stepping away from the page until it can. Deepening is the
 * right give because it is the one the eye forgives — a purple slightly darker
 * than the yellow beside it still reads as the same family of mark, while a
 * purple with the colour drained out of it reads as a smudge.
 *
 * A CEILING, because a runaway is possible in principle: a chroma target no
 * lightness can serve would walk this to black. Hitting it is a policy error,
 * and the script says so rather than shipping the nearest thing.
 */
const EXTRA_STEP_LIMIT = 0.2
const STEP_GRAIN = 0.002

function stepFor(page, dL, chroma, hue, toward, reachable = () => true) {
  let extra = 0
  while (extra <= EXTRA_STEP_LIMIT) {
    const L = page + toward * (dL + extra)
    if (reachableChroma(L, hue) >= chroma - 0.0005 && reachable(L)) break
    extra += STEP_GRAIN
  }
  if (extra > EXTRA_STEP_LIMIT) {
    console.error(`Nothing on hue ${hue} can be both this colourful and this far from the page.`)
    process.exit(1)
  }
  return dL + extra
}

/**
 * What the painter must be handed so the blend produces `wanted` on `page`.
 *
 * Both modes invert exactly, per channel, in the non-linear sRGB the CSS
 * compositing spec blends in — `multiply` is a product and `screen` is a
 * product of the complements. Neither inverse is always in range, and that is
 * a real constraint rather than a rounding problem: multiply can only darken,
 * so a band can never be lighter than the page in any channel, and screen can
 * only lighten. `blendable` is what keeps the generator from asking.
 */
function unblend(wanted, page, mode) {
  const w = parse(wanted).map((v) => v / 255)
  const p = parse(page).map((v) => v / 255)
  const raw = w.map((v, i) =>
    mode === 'screen' ? 1 - (1 - v) / (1 - p[i]) : v / p[i],
  )
  return format(raw.map((v) => Math.max(0, Math.min(1, v)) * 255))
}

/** What the reader actually sees, given what the painter was handed. */
function blend(given, page, mode) {
  const g = parse(given).map((v) => v / 255)
  const p = parse(page).map((v) => v / 255)
  return format(
    g.map((v, i) => (mode === 'screen' ? 1 - (1 - v) * (1 - p[i]) : v * p[i])).map((v) => v * 255),
  )
}

/** Whether the blend can reach this colour on this page without clamping. */
function blendable(wanted, page, mode) {
  const w = parse(wanted)
  const p = parse(page)
  return mode === 'screen' ? w.every((v, i) => v >= p[i] - 1) : w.every((v, i) => v <= p[i] + 1)
}

/** The colour at this lightness and hue, with as much of `chroma` as the gamut
 *  allows — which, after `stepFor`, is all of it. */
function colourAt(L, chroma, hue) {
  let lo = 0
  let hi = chroma
  let best = fromLch(L, 0, hue)
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2
    const got = fromLch(L, mid, hue)
    if (got) { best = got; lo = mid } else { hi = mid }
  }
  return best
}

const luminance = (hex) => {
  const [r, g, b] = parse(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const table = {}
let worstInk = Infinity
for (const [theme, { surface, ink }] of Object.entries(THEMES)) {
  const dark = theme === 'night'
  const policy = dark ? POLICY.night : POLICY.light
  const step = dark ? 1 : -1
  const page = lightness(surface)
  table[theme] = {}
  const mode = BLEND[theme] ?? BLEND.default
  for (const [tint, hue] of Object.entries(HUE)) {
    /* The band has to be reachable THROUGH THE BLEND as well as inside the
       gamut — two constraints, one search, because the answer to both is the
       same: step further from the page. */
    const fillStep = stepFor(page, policy.fill.dL, policy.fill.c, hue, step, (L) =>
      blendable(colourAt(L, policy.fill.c, hue), surface, mode),
    )
    const ruleStep = stepFor(page, policy.rule.dL, policy.rule.c, hue, step)
    const seen = colourAt(page + step * fillStep, policy.fill.c, hue)
    const given = unblend(seen, surface, mode)
    // What the reader sees after the round trip, which is what the model owns.
    const fill = blend(given, surface, mode)
    const rule = colourAt(page + step * ruleStep, policy.rule.c, hue)
    table[theme][tint] = { fill, given, rule }
    worstInk = Math.min(worstInk, contrast(ink, fill))
  }
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`${pad('theme', 8)}${pad('tint', 8)}${pad('fill', 10)}band   ink     ${pad('rule', 10)}line`)
for (const [theme, tints] of Object.entries(table)) {
  const { surface, ink } = THEMES[theme]
  for (const [tint, { fill, rule }] of Object.entries(tints)) {
    console.log(
      `${pad(theme, 8)}${pad(tint, 8)}${pad(fill, 10)}${contrast(fill, surface).toFixed(2)}   ` +
      `${contrast(ink, fill).toFixed(2)}   ${pad(rule, 10)}${contrast(rule, surface).toFixed(2)}`,
    )
  }
}
console.log(`\nworst ink-on-fill: ${worstInk.toFixed(2)} (floor ${INK_FLOOR})`)
if (worstInk < INK_FLOOR) {
  console.error('\nA fill makes its own words unreadable. Fix the policy before shipping this.')
  process.exit(1)
}

console.log('\n--- src/reader/bookCss.ts — what the PAINTER is handed ---')
for (const [theme, t] of Object.entries(table)) {
  console.log(
    `  ${theme}: mark: '${t.yellow.given}', markRule: '${t.yellow.rule}', ` +
    `markGreen: '${t.green.given}', markGreenRule: '${t.green.rule}', ` +
    `markPurple: '${t.purple.given}', markPurpleRule: '${t.purple.rule}',`,
  )
}
console.log('\n--- src/styles/tokens.css — what the reader SEES, for the swatches ---')
for (const [theme, t] of Object.entries(table)) {
  console.log(`  /* ${theme} */`)
  console.log(`  --mark-yellow:${t.yellow.fill}; --mark-yellow-rule:${t.yellow.rule};`)
  console.log(`  --mark-green:${t.green.fill}; --mark-green-rule:${t.green.rule};`)
  console.log(`  --mark-purple:${t.purple.fill}; --mark-purple-rule:${t.purple.rule};`)
}
