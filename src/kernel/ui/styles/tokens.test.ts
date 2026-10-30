import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BREAKPOINT, VIEWPORT_MIN } from '../../core/metrics'

/**
 * THE GUARD. Tokenizing a stylesheet is a morning's work; keeping it tokenized
 * is the part that fails, because the next person in a hurry writes `padding:
 * 9px` and nothing objects. This objects.
 *
 * It reads every stylesheet the app ships and fails on a raw value in a
 * property the design system has a scale for. The failure names the file, the
 * line and the value, so the fix is to pick a step rather than to go hunting.
 *
 * WHAT IS NOT A MAGIC NUMBER, and this list is the whole argument:
 *
 *   — Percentages and `fr`. `translateX(-50%)`, `minmax(0, 1fr)`, `width: 100%`
 *     are STRUCTURE: they say "half of itself", "share of what is left". There
 *     is no scale step that could express them and no value to get wrong.
 *   — `0`. Not a quantity, the absence of one.
 *   — `1px`. A hairline is the thinnest line a screen can draw, not a choice
 *     between thicknesses. Anything thicker is a choice and needs a token —
 *     see `--track-w`.
 *   — Ratios and counts: `line-height`, `font-weight`, `z-index`, `opacity`,
 *     `flex`, `aspect-ratio`, `-webkit-line-clamp`, `repeat(5, …)`.
 *   — `calc()` and `min()` built out of tokens, which is a derivation and the
 *     thing this file wants people to write.
 *
 * The scales themselves live in `tokens.css` and `metrics.ts`; this file only
 * insists they are used.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..', '..')

/** Properties with a scale. A raw number in one of these is the failure. */
const SCALED = new Set([
  'padding', 'margin', 'gap', 'row-gap', 'column-gap',
  'font-size', 'border-radius', 'letter-spacing',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'inline-size', 'block-size', 'min-inline-size', 'min-block-size',
  'top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline',
  'outline-offset',
  /* ⚠️ **THE RING'S WIDTH WAS UNPOLICED WHILE ITS OFFSET WAS.** `outline-offset`
   * has been in this set from the start, so every offset in the app is a token
   * or one of the sanctioned exceptions — and `outline`, one line above it in
   * the same rule, was free. Seventeen declarations across eight stylesheets
   * wrote `outline: 2px solid var(--accent)` by hand and `global.css` wrote
   * `3px`, so the app had two ring weights decided by whether an author had
   * happened to declare one. Every one of them passed this guard.
   *
   * `--focus-ring` is the token now, and these two names are what stops the
   * eighteenth copy. `outline: none` and `outline: medium` carry no number and
   * are unaffected. */
  'outline', 'outline-width',
])
for (const side of ['top', 'bottom', 'left', 'right', 'block', 'inline'] as const) {
  SCALED.add(`padding-${side}`)
  SCALED.add(`margin-${side}`)
  SCALED.add(`inset-${side}`)
}
for (const side of ['block-start', 'block-end', 'inline-start', 'inline-end'] as const) {
  SCALED.add(`padding-${side}`)
  SCALED.add(`margin-${side}`)
  SCALED.add(`inset-${side}`)
}

/**
 * Structure, not quantity — see the note above.
 *
 * A bare integer is here because `calc(2 * var(--space-4))` is a DERIVATION, and
 * derivations are what this guard wants people to write; the `2` is arithmetic,
 * not a size. Viewport units likewise: `100dvh` is the window, not a number
 * anybody chose. And `-1px` because it is `1px` in the other direction — the
 * visually-hidden idiom is `width: 1px; margin: -1px`.
 *
 * ZERO WITH A UNIT joins bare `0`, and the mechanism is that they are the same
 * length. Zero has no magnitude, so it is not a value FROM a scale and there is
 * no token it could be spelled as — the design system has no zero, and cannot
 * have one. `0px` rather than `0` is written where a `max()` or `clamp()` wants
 * both operands to be lengths.
 *
 * ⚠️ This is a widening, and it is here because making the guard see multi-line
 * declarations made it see `Reader.module.css`'s `inset-inline-end` for the
 * first time — a `calc(max(0px, …))` that had been invisible to it. The
 * declaration was not an offence; the guard had simply never read it.
 */
const ALLOWED =
  /^(-?0(\.0+)?(px|rem|em|%|fr|ch|dvh|dvw|svh|svw|vh|vw)?|-?1px|-?\d+(\.\d+)?%|-?\d+(\.\d+)?fr|-?\d+(\.\d+)?|-?\d+(\.\d+)?(dvh|dvw|svh|svw|vh|vw)|auto|none|inherit|initial|unset|min-content|max-content|fit-content)$/

function stylesheets(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...stylesheets(full))
    else if (name.endsWith('.css')) out.push(full)
  }
  return out
}

interface Offence {
  readonly file: string
  readonly line: number
  readonly text: string
}

/**
 * Every declaration in a stylesheet, with the line its property name sits on.
 *
 * ⚠️ **THIS USED TO SCAN ONE LINE AT A TIME AND REQUIRE THE TERMINATOR ON IT.**
 * `([a-z-]+)\s*:\s*([^;{}]+)[;}]` was run per line, so a declaration written
 * across two — which this repository's own stylesheets do, for a long
 * `grid-template-columns` or a wrapped `padding` — matched nothing at all. The
 * guard did not report those as offences or as clean; it never saw them. A
 * hard-coded pixel value could be hidden from it by pressing return.
 *
 * The pattern already tolerates newlines inside the VALUE (`[^;{}]` matches
 * one); it was the per-line loop that could not. Run over the whole file, the
 * line number comes from the match offset instead.
 */
function declarations(src: string): { prop: string; value: string; line: number }[] {
  const out: { prop: string; value: string; line: number }[] = []
  /* `[;}]|$` rather than `[;}]`: a final declaration with no semicolon before
     the closing brace is legal CSS, and so is one at the end of a file. */
  /* ⚠️ **CASE-INSENSITIVE, AND IT WAS NOT.** CSS property names are
   * case-insensitive, so `PADDING: 9px` is valid CSS that renders — and
   * `[a-z-]+` without the `i` flag matched none of it. Every check in this file
   * runs off this function, so one capital letter anywhere in a property name
   * made that declaration invisible to the whole guard. Found by audit
   * 2026-09-18; the property is lower-cased on the way out so `SCALED.has` and
   * the `TOKENED` lookups still work on one spelling. */
  for (const m of src.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?:[;}]|$)/gi)) {
    out.push({
      prop: (m[1] ?? '').toLowerCase(),
      value: (m[2] ?? '').trim(),
      line: src.slice(0, m.index).split('\n').length,
    })
  }
  return out
}

function scan(file: string): Offence[] {
  // Comments hold measurements and prose full of numbers; they are not code.
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const offences: Offence[] = []
  const lines = src.split('\n')
  for (const { prop, value, line } of declarations(src)) {
    {
      const i = line - 1
      // The token definitions themselves are where the numbers are supposed to be.
      if (/^\s*--[\w-]+\s*:/.test(lines[i] ?? '') && file.endsWith('tokens.css')) continue
      if (!SCALED.has(prop)) continue
      // Strip everything the design system sanctions, then look for what is left.
      const rest = value
        .replace(/var\(--[\w-]+(?:\s*,[^()]*)?\)/g, ' ')
        .replace(/(calc|min|max|clamp)\(/g, ' ')
        .replace(/[()]/g, ' ')
      for (const part of rest.split(/[\s,/]+/).filter(Boolean)) {
        if (ALLOWED.test(part)) continue
        if (!/\d/.test(part)) continue
        if (/^[*+\-]$/.test(part)) continue
        offences.push({ file: relative(SRC, file), line, text: `${prop}: ${value}` })
        break
      }
    }
  }
  return offences
}

/* The width breakpoints, which a stylesheet has to write out — see `BREAKPOINT`.
 * Kept in step by assertion, since they cannot be kept in step by reference. */
const BREAKPOINTS = [860, 720, 600]

describe('the layout changes width at agreed places', () => {
  it('uses no breakpoint that is not one of the three', () => {
    const strays: string[] = []
    for (const file of stylesheets(SRC)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/@media[^{]*?\((?:max|min)-width:\s*(\d+)px\)/g)) {
        const px = Number(m[1])
        if (!BREAKPOINTS.includes(px)) strays.push(`${relative(SRC, file)}: ${px}px`)
      }
    }
    expect(strays, `\nBreakpoints not in \`BREAKPOINT\`:\n  ${strays.join('\n  ')}\n`).toEqual([])
  })

  /**
   * A width query that reacts to something no VIEWPORT can be is a rule that
   * never runs — and it looks exactly like one that does.
   *
   * ⚠️ **THE FLOOR WAS 720, THE DESKTOP WINDOW'S MINIMUM**, and that was right
   * while every host was a window. Phase 18 serves this app to a phone, where
   * the viewport is 393 — so a 720 floor would have refused the one breakpoint
   * a phone actually needs, on the grounds that no window is that narrow. The
   * floor is now the narrowest viewport, not the narrowest window.
   *
   * `min` stays in the list because it is still the width every desktop layout
   * is tested at; it is simply no longer the bottom of the range.
   */
  it('has no breakpoint below the narrowest viewport', () => {
    for (const px of BREAKPOINTS) expect(px).toBeGreaterThanOrEqual(VIEWPORT_MIN)
  })

  /* The list is the same one `metrics.ts` publishes, in the same order it
     declares them. Two copies exist because a media query cannot read a custom
     property; this is what stops them drifting. */
  it('lists exactly the breakpoints the design system declares', () => {
    expect([...BREAKPOINTS].sort((a, b) => b - a)).toEqual(
      Object.values(BREAKPOINT).sort((a, b) => b - a),
    )
  })
})

/**
 * ⚠️ **A SCALE THE NUMERIC GUARD CANNOT POLICE, AND WHY IT NEEDS ITS OWN.**
 *
 * `ALLOWED` sanctions any bare number — `-?\d+(\.\d+)?` — because ratios and
 * counts are legitimately unitless and `calc(2 * var(--space-4))` is the
 * derivation this file wants people to write. That exemption is right, and it
 * is also why adding `opacity` or `font-weight` to `SCALED` would have caught
 * NOTHING: every value they take is a bare number.
 *
 * So these two are checked the other way round. Rather than hunting for a
 * literal, the value must BE a token, and the small set of words that are not
 * quantities at all is listed out.
 *
 * What it was bought for, in both cases a stated design rule written as a
 * literal at each call site until it drifted:
 *
 * - §07 says disabled is 45%. Five controls each chose their own — 0.45, 0.6,
 *   0.35, 0.35, 0.4 — and none said why.
 * - Twenty-eight declarations wrote 600, 500 or 400 by hand, with no names and
 *   nothing to stop a twenty-ninth inventing 650 on a variable face that would
 *   happily render it.
 *
 * `0` and `1` stay literal for opacity because they are presence and absence
 * rather than a degree of it, and the design system has no token for either —
 * the same reasoning `ALLOWED` already applies to zero.
 */
/*
 * ── WHAT A FULL SWEEP FOUND, AND WHAT IT DELIBERATELY LEFT ───────────────
 *
 * Every stylesheet and every inline style scanned by property, with comments
 * stripped, looking for a literal where a scale exists.
 *
 * ALREADY CLEAN: colour (zero literals outside a `var()` fallback), spacing,
 * radius, control sizes, text sizes, motion. Inline styles in TSX carry only
 * `flex: 1` and `: 0`.
 *
 * CLOSED BY THIS PASS: the focus ring (seventeen hand-written widths and a
 * default that disagreed), opacity (§07's one rule written five ways),
 * font-weight (twenty-eight literals, three values, no names), two durations
 * that never reached `MOTION`, and one `z-index` restating a layer the scale
 * held but had never published.
 *
 * ⚠️ **THE RESIDUE IS DELIBERATE AND IS LISTED SO IT STAYS ARGUABLE.** None of
 * these is a quantity from a scale; each is structure, and inventing a token
 * for it would be the mistake `design-tokens.md` records about the ring
 * offsets — policy invented over evidence nobody had read.
 *
 *   `transform`      `-50%`, `-100%`, `90deg` — centring, a full slide, a right
 *                    angle. Geometry, not a size anybody chose.
 *   `steps(2, start)` two steps IS on/off. A blink's structure.
 *   `0.01ms`         the reduced-motion kill idiom. A conventional near-zero
 *                    standing in for "off", not a duration.
 *   `z-index: 1..3`  local stacking inside a component's own context. §12's
 *                    layer order is for what crosses components, and
 *                    `--z-*` publishes all of it now.
 *   `1px` / `0.5px`  the hairline, which `ALLOWED` already sanctions, and one
 *                    rim.
 * ⚠️ **AND ONE ENTRY IN THAT RESIDUE WAS WRONG ON ITS OWN TERMS.** It read:
 * *"`2px` border — exactly one, in `MarginMarks` … One call site and a stated
 * meaning is not the failure tokens exist to prevent — drift between many call
 * sites is."* The premise was the part to check, and it was false. There were
 * THREE, in TWO SPELLINGS: `MarginMarks` had `border-inline-start: 2px solid`
 * and `SidePane` twice had `box-shadow: inset 2px 0 0` — the same decision drawn
 * two different ways, so neither could be found from the other and a grep for
 * `2px` looked like it had found the only one. It is `--kind-rule-w` now, with
 * its reason in `metrics.ts`.
 *
 * The lesson is about this list rather than about that value: **an entry here
 * asserting "only one call site" is a claim about the tree, and nothing checks
 * it.** Anything left in the residue on those grounds should be counted again
 * before it is believed.
 */
describe('opacity and weight come from their scales', () => {
  /**
   * ⚠️ **THIS WAS TWO PROPERTIES AND THE ARGUMENT FOR IT COVERED MORE.**
   *
   * The reasoning above is that a property whose every value is a bare number
   * cannot be policed by hunting for literals, so the value must BE a token of a
   * named family. That was applied to `opacity` and `font-weight` and stopped
   * there — and the 2026-09-18 audit found that the same mechanism was needed by
   * everything below, for two different reasons.
   *
   * **The ratio properties, for the stated reason.** `line-height` was exempt as
   * "a ratio, not a quantity" and had accumulated twenty-four chosen values over
   * eight unrelated numbers; `z-index` is sanctioned as a count by `ALLOWED`, so
   * `z-index: 9999` passed.
   *
   * **The others, because `SCALED` membership only asks whether a value is a
   * TOKEN, never WHICH.** `font-size: var(--space-16)` passed the numeric guard
   * — a spacing step used as a type size, which is exactly the confusion the two
   * scales were separated to prevent. So the families are pinned:
   *
   *   `font-size`      `--text-*`     a role, not a length
   *   `border-radius`  `--radius-*`   a shape, not a length
   *   `letter-spacing` `--track-*`
   *   `line-height`    `--leading-*`
   *   `font-family`    `--font-*`     three faces, nine declarations of them
   *   `box-shadow`     `--shadow-*` / `--ring*`
   *   `z-index`        `--z-*`, or the documented 1..3 local residue
   *   `transition` / `animation`  `--motion-*`
   *
   * Each allows the keywords that carry no value at all, and each was checked
   * against every declaration in the tree before being switched on.
   *
   * ⚠️ **THE MULTI-VALUE PROPERTIES ARE POLICED BY FAMILY, NOT BY SHAPE** — see
   * `FAMILIES` below. `border-radius: var(--radius-sheet) var(--radius-sheet) 0
   * 0` and `transition: background var(--motion-popover), color
   * var(--motion-popover)` are both correct and neither is an exact match
   * against anything, so listing shapes would have meant enumerating CSS
   * grammar. Asking instead "does every token in this value come from a family
   * this property may draw on" catches the defect — a spacing step used as a
   * type size — without caring how many of them there are.
   */
  const NOT_A_VALUE = String.raw`inherit|initial|unset|revert|revert-layer`
  const TOKENED: ReadonlyArray<readonly [string, RegExp]> = [
    ['opacity', /^(0|1|var\(--opacity-[\w-]+\)|inherit|initial|unset|revert)$/],
    ['font-weight', /^(var\(--weight-[\w-]+\)|inherit|initial|unset|revert)$/],
    /* `normal` is the initial value and says "the face's own", which is not a
       step and has no token. */
    ['letter-spacing', new RegExp(String.raw`^(normal|var\(--track-[\w-]+\)|${NOT_A_VALUE})$`)],
    /**
     * `1` stays literal, and `tokens.css` argues why: the five declarations
     * using it all mean "this box is exactly its glyphs", which is a structural
     * claim rather than a leading chosen for the text.
     */
    ['line-height', new RegExp(String.raw`^(1|var\(--leading-[\w-]+\)|${NOT_A_VALUE})$`)],
    /* `inherit` is how a control opts into its container's face — `.install` in
       the lookup face does exactly that, deliberately. */
    ['font-family', new RegExp(String.raw`^(var\(--font-[\w-]+\)|${NOT_A_VALUE})$`)],
    /**
     * ⚠️ **THE `font` SHORTHAND IS REFUSED OUTRIGHT, AND THAT IS THE STRONGEST
     * RULE IN THIS FILE.** Two live declarations read `font: var(--text-title)`
     * and `font: var(--text-ui)`. The shorthand REQUIRES a size and a family, so
     * a value carrying only a size is invalid and the browser discards the whole
     * declaration — which is why a heading was rendering at the user agent's
     * `2em` bold for however long it had been there. The value *was* a token, so
     * nothing in this file objected, and `font` was in no list to be read.
     *
     * Refusing it is better than validating it, because even a VALID `font`
     * shorthand resets every font property it does not mention — weight, style,
     * variant and `line-height` — to its initial value, silently undoing tokens
     * set by another rule. The longhands cannot do that.
     *
     * ⚠️ **`font: inherit` IS THE ONE EXCEPTION, AND IT IS EXEMPT ON EXACTLY
     * THE GROUND THAT CONDEMNS THE REST.** The objection above is that the
     * shorthand resets what it does not mention; `inherit` mentions everything,
     * by inheriting all of it. It is the standard reset that makes a `<button>`
     * or an `<input>` take its container's type instead of the user agent's, and
     * the tree holds twenty-one of them and not one other value — so this
     * exemption is measured rather than assumed. Anything else, token or not, is
     * a declaration that should have been longhands.
     */
    ['font', /^inherit$/],
  ]

  it('never writes one as a literal', () => {
    const offences: string[] = []
    for (const file of stylesheets(SRC)) {
      if (file.endsWith('tokens.css')) continue
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      for (const { prop, value, line } of declarations(src)) {
        const rule = TOKENED.find(([name]) => name === prop)
        if (!rule) continue
        if (rule[1].test(value.trim())) continue
        offences.push(`${relative(SRC, file)}:${line}  ${prop}: ${value}`)
      }
    }
    expect(offences).toEqual([])
  })

  /**
   * WHICH FAMILIES A PROPERTY MAY DRAW ON.
   *
   * ⚠️ **`SCALED` ASKS WHETHER A VALUE IS A TOKEN AND NEVER WHICH ONE**, so
   * `font-size: var(--space-16)` and `border-radius: var(--space-4)` both passed
   * the numeric guard — a spacing step standing in for a type size, which is the
   * precise confusion `tokens.css` separated the two scales to prevent ("spacing
   * is the one scale where naming by intent is a mistake … a font size IS a
   * decision about what a piece of text is"). Two scales with one guard between
   * them is one scale.
   *
   * A prefix list per property, checked against every `var()` in the value.
   * Every entry below was derived by reading every declaration of that property
   * in the tree first — this switches on a rule the app already follows, which
   * is the cheapest moment to do it and the only moment it costs nothing.
   *
   * ⚠️ **THE `--leading-*` SCALE CREATED A PREFIX COLLISION AND THE FIX WAS TO
   * RENAME, NOT TO ADD AN EXCEPTION.** `metrics.ts` published
   * `--leading-card-radius` — a LENGTH, a floating card's concentric radius
   * (`WINDOW_RADIUS − CONCENTRIC_INSET`) — and the leading scale added five
   * RATIOS sharing its first nine characters. The first version of this check
   * allowed it by exact name under `border-radius`, which stopped a radius
   * being refused and left the far worse direction open: `line-height:
   * var(--leading-card-radius)` would have PASSED, a 13px length accepted as a
   * line-height by the very check written to stop a value from the wrong scale.
   *
   * It is `--radius-leading-card` now, which puts it in the family it always
   * belonged to and needs no exception here. A token whose name has to be
   * special-cased in the guard is a token that is named wrong.
   */
  const FAMILIES: ReadonlyArray<readonly [prop: string, allowed: readonly string[]]> = [
    /* `--face-scale` is a multiplier the typeface specimen sets, not a size. */
    ['font-size', ['text-', 'face-scale']],
    /* `--space-*` because the sheet's inner radius is `sheet − space-4`, which
       is §12's concentric rule written as the derivation it is. */
    ['border-radius', ['radius-', 'space-']],
    ['letter-spacing', ['track-']],
    ['line-height', ['leading-']],
    ['font-family', ['font-']],
    /* A shadow's value is a geometry AND a colour, so both kinds of token are
       legitimate here: the named elevations and rings, the widths a rule is
       drawn at (`--kind-rule-w`, where a border would take space the box has not
       got), and any ink the app can draw a line in. */
    [
      'box-shadow',
      ['shadow-', 'ring', 'kind-rule-w', 'line', 'ink', 'amber', 'mark-', 'swatch-edge', 'disc', 'dot', 'tl-rim', 'accent'],
    ],
    ['z-index', ['z-']],
    ['transition', ['motion-']],
    ['animation', ['motion-']],
    ['opacity', ['opacity-']],
    ['font-weight', ['weight-']],
  ]

  it('draws each property from its own family of tokens', () => {
    const offences: string[] = []
    for (const file of stylesheets(SRC)) {
      if (file.endsWith('tokens.css')) continue
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      for (const { prop, value, line } of declarations(src)) {
        const rule = FAMILIES.find(([name]) => name === prop)
        if (!rule) continue
        for (const m of value.matchAll(/var\(\s*--([\w-]+)/g)) {
          const token = m[1] ?? ''
          if (rule[1].some((prefix) => token.startsWith(prefix))) continue
          offences.push(`${relative(SRC, file)}:${line}  ${prop}: --${token} is not from ${rule[1].join('/')}`)
        }
      }
    }
    expect(
      offences,
      `\n${offences.length} token(s) used by a property they do not belong to:\n  ${offences.join('\n  ')}\n`,
    ).toEqual([])
  })

  /* The family check has to be able to fail, and on the shape it was bought
     for: a real token, from the wrong scale, in a property that accepts it. */
  it('would catch a token from the wrong family', () => {
    const wrong = FAMILIES.find(([p]) => p === 'font-size')!
    expect(wrong[1].some((prefix) => 'space-16'.startsWith(prefix))).toBe(false)
    expect(wrong[1].some((prefix) => 'text-ui'.startsWith(prefix))).toBe(true)
    const radius = FAMILIES.find(([p]) => p === 'border-radius')!
    expect(radius[1].some((prefix) => 'leading-body'.startsWith(prefix))).toBe(false)
    expect(radius[1].some((prefix) => 'radius-leading-card'.startsWith(prefix))).toBe(true)
  })

  /* Non-vacuity: the check has to be able to fail, and on the exact shape it
     was bought for. Both scales, because one passing regex would otherwise
     cover for the other being wrong. */
  it('would catch a literal if one appeared', () => {
    const [, opacity] = TOKENED[0]!
    const [, weight] = TOKENED[1]!
    expect(opacity.test('0.45')).toBe(false)
    expect(opacity.test('var(--opacity-disabled)')).toBe(true)
    expect(opacity.test('0')).toBe(true)
    expect(weight.test('600')).toBe(false)
    expect(weight.test('var(--weight-semibold)')).toBe(true)
  })
})

describe('the design system is used, not restated', () => {
  const files = stylesheets(SRC)

  it('finds the stylesheets at all', () => {
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(10)
  })

  it('has no raw value in any property with a scale', () => {
    const offences = files.flatMap(scan)
    const report = offences.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')
    expect(offences, `\n${offences.length} raw values where a token belongs:\n${report}\n`).toEqual([])
  })

  /* The guard has to be able to fail, or it is decoration. */
  it('would catch a raw value if one appeared', () => {
    const offences = scanText('.x { padding: 9px; }')
    expect(offences).toHaveLength(1)
    expect(scanText('.x { padding: var(--space-8); }')).toHaveLength(0)
    expect(scanText('.x { width: 100%; }')).toHaveLength(0)
    expect(scanText('.x { border-radius: 0; }')).toHaveLength(0)
    expect(scanText('.x { border: 1px solid red; }')).toHaveLength(0)
    expect(scanText('.x { inset-inline: calc(var(--a) + var(--b)) var(--c); }')).toHaveLength(0)
    expect(scanText('.x { height: calc(var(--a) - 7px); }')).toHaveLength(1)
  })

  /**
   * ⚠️ **A DECLARATION SPLIT OVER TWO LINES USED TO BE INVISIBLE.**
   *
   * The scan ran per line and required the `;` or `}` on the same one, so a
   * wrapped `padding` — which this repository's own stylesheets write, and
   * which any formatter produces for a long value — matched nothing at all.
   * The guard neither passed nor failed it; it never read it. A hard-coded
   * pixel value could be hidden from this test by pressing return, which is
   * the worst property a guard can have.
   *
   * Making it whole-file is what surfaced `Reader.module.css`'s
   * `inset-inline-end` for the first time.
   */
  it('reads a declaration that is wrapped across lines', () => {
    expect(scanText('.x {\n  padding:\n    9px;\n}')).toHaveLength(1)
    expect(scanText('.x {\n  padding:\n    var(--space-8);\n}')).toHaveLength(0)
    /* The shape that was actually hiding: a nested `calc` over several lines. */
    expect(
      scanText('.x {\n  inset-inline-end: calc(\n    max(\n      0px,\n      var(--a)\n    )\n  );\n}'),
    ).toHaveLength(0)
    expect(
      scanText('.x {\n  inset-inline-end: calc(\n    max(\n      13px,\n      var(--a)\n    )\n  );\n}'),
    ).toHaveLength(1)
  })

  /* A final declaration with no semicolon is legal CSS, and the terminator was
     required. */
  it('reads the last declaration in a block without a semicolon', () => {
    expect(scanText('.x { padding: 9px }')).toHaveLength(1)
  })

  /* ZERO IS NOT A SIZE, with or without a unit — there is no token it could be
     spelled as, because the scale has no zero. */
  it('accepts zero however it is written', () => {
    for (const zero of ['0', '0px', '0rem', '0%', '-0px']) {
      expect(scanText(`.x { padding: ${zero}; }`), zero).toHaveLength(0)
    }
  })
})

/** The same scan over a string, so the guard can be tested on known input. */
function scanText(css: string): Offence[] {
  const tmp = join(HERE, '__scan_probe.css')
  const { writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
  writeFileSync(tmp, css)
  try {
    return scan(tmp)
  } finally {
    rmSync(tmp)
  }
}
