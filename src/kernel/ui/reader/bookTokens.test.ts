import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE STYLESHEET THE READER ACTUALLY READS, HELD TO THE STANDARD THE APP'S OWN
 * ARE (WI-14.0).
 *
 * `tokens.test.ts` reads every `.css` file the app ships and refuses a raw
 * value where a scale exists. `bookCss.ts` is a TypeScript template literal, so
 * not one line of it was gated — and it is the only stylesheet in the product a
 * reader looks at for hours. Audited, it carried `font-weight: 600`,
 * `line-height: 1.2`, `font-size: 0.75em` on a noteref, `inset-inline: -10px`,
 * two border radii, a `90ms` transition with a `40ms` reduced-motion variant,
 * and `24%` on `::selection`. Every one of those is a decision, and none of
 * them was written down as one.
 *
 * WHAT COUNTS AS TOKENIZED HERE IS NOT WHAT COUNTS IN THE APP, because the book
 * is a separate document and CANNOT SEE `tokens.css` — custom properties do not
 * cross an iframe boundary. Its scale is the reader's own settings, which reach
 * it two ways:
 *
 *   — `${...}`, a value interpolated from `metrics.ts` or from the settings.
 *   — `var(--paper-*)`, the line box and the rest of the variable contract.
 *
 * A number built out of either is a DERIVATION, which is the thing this guard
 * wants people to write: `calc(var(--paper-line) * 1.5)` says "a line and a
 * half" and follows the reader's leading, where `51px` says nothing and follows
 * nothing.
 *
 * THE ESCAPE HATCH IS AT THE SITE, never in a list here. A value that should be
 * a constant carries `/* constant: why *\/` on its own line, so the next person
 * to read the rule reads the reason with it — the same argument
 * `check-dead-css.mjs` makes for its `_` prefix. A list in this file would grow
 * a line at a time until nobody read it, and would put the reason in the one
 * place a person editing the rule is not looking.
 *
 * TWO DELIBERATE DIVERGENCES FROM `tokens.test.ts`, both because a book is not
 * the app's chrome:
 *
 *   — Viewport units are NOT structure here. `100dvh` in a panel is the window;
 *     `max-height: 95vh` on a figure is a typographic cap somebody chose, and
 *     WI-14.4 turns it into a setting.
 *   — A bare number outside a function is a chosen ratio, not arithmetic.
 *     `line-height: 1.2` and `font-weight: 600` are exactly the values the
 *     audit found, and a guard that waved bare numbers through would have
 *     found neither.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOK_CSS = join(HERE, 'bookCss.ts')

/** A number carrying a unit. Longest alternatives first, or `90ms` reads as
 *  `90m` followed by `s`. Percent is absent on purpose — see `PERCENT`. */
const UNITED = /-?\d*\.?\d+(rem|em|ex|ch|px|pt|pc|in|cm|mm|ms|s|dvh|dvw|svh|svw|vh|vw|deg|turn)\b/g

/** A bare number: a ratio, a weight, a stacking level. */
const BARE = /(?:^|[\s:,(])(-?\d*\.?\d+)(?![\w%.])/g

/** The marker that says a value is a constant on purpose, and why. */
const CONSTANT = /\/\*\s*constant:\s*(\S[^*]{14,})\*\//

/** A `${...}` in the source — the reader's settings, reaching the sheet. */
const INTERPOLATED = /\$\{[^}]*\}/g

/** What one is replaced by: readable in a failure, and carrying no digit, so
 *  a hidden interpolation can never be mistaken for a constant. */
const INTERPOLATION = '<setting>'

/**
 * Quantities that choose nothing, and are therefore not decisions.
 *
 *   — `1px` is a hairline: the thinnest line a screen can draw, not a choice
 *     between thicknesses. `tokens.test.ts` grants the same exemption for the
 *     same reason, and `-1px` is it in the other direction.
 *   — `1em` and `1rem` name the size already in force — the inherited one and
 *     the reader's base. A multiplier of one selects nothing, exactly as
 *     `100%` selects nothing. `0.75em` is a choice and is not here.
 */
const NOT_A_CHOICE = new Set(['1px', '-1px', '1em', '1rem'])

export interface Declaration {
  readonly line: number
  readonly property: string
  readonly value: string
  readonly reason: string | null
}

/**
 * Every CSS declaration written inside `bookCss.ts`, with its source line.
 *
 * LINE BY LINE, tracking which lines are inside a template literal, because the
 * marker has to be found on the declaration's own line and a parse that
 * flattened the file would lose that. The file states, twice, that it contains
 * no backtick inside a CSS comment — that is what makes the toggle below safe,
 * and it is why the rule is written down there rather than assumed here.
 *
 * A line carrying a backtick is a boundary — `const X = \``, `\`.trim()` — and
 * never carries a declaration, so membership is decided by the state the line
 * STARTED in.
 */
export function declarationsIn(source: string): Declaration[] {
  const out: Declaration[] = []
  let inTemplate = false
  let inComment = false
  source.split('\n').forEach((raw, i) => {
    const startedInTemplate = inTemplate
    const ticks = (raw.match(/`/g) ?? []).length
    if (ticks % 2 === 1) inTemplate = !inTemplate
    /* A template literal that holds no rule block is JavaScript building a
       string — `url(...)` in `absoluteUrls` — not a stylesheet. */
    if (!startedInTemplate || ticks > 0) return

    const reason = CONSTANT.exec(raw)?.[1]?.trim() ?? null
    /* Comments hold prose full of numbers and property names. Blanked, not
       dropped, so nothing shifts. */
    let text = raw
    if (inComment) {
      const close = text.indexOf('*/')
      if (close === -1) return
      text = ' '.repeat(close + 2) + text.slice(close + 2)
      inComment = false
    }
    text = text.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length))
    const open = text.indexOf('/*')
    if (open !== -1) {
      text = text.slice(0, open)
      inComment = true
    }
    // At-rules are not declarations, and `@namespace epub "http://…/2007/ops"`
    // reads as one with a number in it.
    if (text.trim().startsWith('@')) return
    /* INTERPOLATIONS ARE HIDDEN BEFORE THE BRACES ARE READ. `${...}` carries a
       `{`, so a value regex that stops at one truncated
       `color-mix(in srgb, ${c.accent} 24%, transparent)` to `color-mix(in srgb, $`
       — which then looked like a value with no quantity in it. The one rule
       that matters here is that a hidden interpolation must not be mistaken
       for a constant, and `INTERPOLATION` carries no digits. */
    const hidden = text.replace(INTERPOLATED, INTERPOLATION)
    for (const m of hidden.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]?/g)) {
      out.push({ line: i + 1, property: m[1] ?? '', value: (m[2] ?? '').trim(), reason })
    }
  })
  return out
}

/**
 * The quantities in a value that somebody chose, after the reader's own
 * settings and the book's scale are taken out.
 *
 * Percentages and `0` are not quantities — `max-width: 95%` says "most of what
 * is there" and `margin: 0` is the absence of a margin. That is
 * `tokens.test.ts`'s list and the reasoning carries over unchanged.
 */
export function chosenQuantities(value: string): string[] {
  const rest = value
    // The reader's settings, interpolated in. Not a constant at all.
    .replace(INTERPOLATED, ' ')
    .replaceAll(INTERPOLATION, ' ')
    // The book document's own scale.
    .replace(/var\(--[\w-]+(?:\s*,[^()]*)?\)/g, ' ')
  const found = [...rest.matchAll(UNITED)].map((m) => m[0]).filter((q) => !NOT_A_CHOICE.has(q))
  /* A bare number INSIDE a function is arithmetic against the scale —
     `calc(var(--paper-line) * 1.5)` is a line and a half. Outside one it is a
     ratio somebody picked. */
  const outsideFunctions = rest.replace(/[a-z-]*\([^()]*\)/gi, ' ')
  for (const m of outsideFunctions.matchAll(BARE)) {
    const n = m[1] ?? ''
    if (Number(n) === 0) continue
    found.push(n)
  }
  return found
}

describe('the book’s stylesheet is held to the app’s standard (WI-14.0)', () => {
  const source = readFileSync(BOOK_CSS, 'utf8')
  const declarations = declarationsIn(source)

  it('finds the stylesheet at all', () => {
    // A guard that scans nothing passes for the wrong reason — the same trap
    // `tokens.test.ts` names, and the same answer.
    expect(declarations.length).toBeGreaterThan(40)
  })

  it('has no chosen quantity without a written reason', () => {
    const offences = declarations
      .filter((d) => d.reason === null && chosenQuantities(d.value).length > 0)
      .map((d) => `  bookCss.ts:${d.line}  ${d.property}: ${d.value}`)
    expect(
      offences,
      `\n${offences.length} values in the book sheet are neither derived from the reader's settings nor written down as constants.\nDerive them from \`var(--paper-*)\` or an interpolation, or mark the line \`/* constant: why */\`:\n${offences.join('\n')}\n`,
    ).toEqual([])
  })

  /* A marker that says nothing is worse than no marker: it reads as diligence
   * and records no decision. `CONSTANT` demands fifteen characters, which is
   * too short to be a sentence and long enough to refuse "why". */
  it('accepts no constant marker that gives no reason', () => {
    expect(CONSTANT.test('/* constant: x */')).toBe(false)
    expect(CONSTANT.test('/* constant: the house weight for a heading */')).toBe(true)
  })

  /**
   * NO BACKTICK INSIDE A CSS COMMENT — THE THIRD TIME PAID FOR THE CHECK.
   *
   * `bookCss.ts` says twice, in its own prose, that it contains no backtick in
   * a CSS comment because it is a template literal and one would end the
   * string. Writing `/* `display: block` is the rule *\/` inside a rule block
   * does exactly that: the literal terminates mid-CSS, and what follows is
   * parsed as TypeScript. The failure is a wall of `TS1005: ';' expected` on
   * lines that have nothing wrong with them, pointing well past the cause.
   *
   * It happened three times while this phase was written. Two of them cost more
   * time than the rule they were documenting. A convention stated in prose and
   * checked by nothing is a convention that gets broken by the next person in a
   * hurry, which is the argument `tokens.test.ts` makes for its own existence.
   */
  it('has no backtick inside the CSS, which would end the template literal', () => {
    const offences: string[] = []
    let inTemplate = false
    source.split('\n').forEach((raw, i) => {
      const startedInTemplate = inTemplate
      const ticks = (raw.match(/`/g) ?? []).length
      if (ticks % 2 === 1) inTemplate = !inTemplate
      /* A line that OPENS or CLOSES a template carries an odd count and is not
         inside one at its start; a line inside one must carry none at all. */
      if (startedInTemplate && ticks > 0 && raw.trim() !== '`' && raw.trim() !== '`.trim()') {
        offences.push(`  bookCss.ts:${i + 1}  ${raw.trim()}`)
      }
    })
    expect(
      offences,
      `\n${offences.length} backticks inside the CSS — each one ends the template literal:\n${offences.join('\n')}\n`,
    ).toEqual([])
    /* AND THE WALK ABOVE ONLY MEANS ANYTHING IF IT ENDS WHERE IT STARTED. An
       UNBALANCED backtick in a TypeScript doc comment — one opening a code span
       that closes on the next line — is invisible to the compiler and flips
       this walk's state for the whole rest of the file, so every doc comment
       after it reads as CSS and every real offence after it reads as prose.
       That happened, and it is why this line is here rather than the count
       being trusted. */
    expect(inTemplate, 'a backtick is unbalanced — the scan above read the file wrongly').toBe(false)
  })

  /* The guard has to be able to fail, or it is decoration. */
  it('would catch a raw value if one appeared', () => {
    expect(chosenQuantities('font-weight: 600')).toContain('600')
    expect(chosenQuantities('600')).toEqual(['600'])
    expect(chosenQuantities('1.2')).toEqual(['1.2'])
    expect(chosenQuantities('90ms ease')).toEqual(['90ms'])
    expect(chosenQuantities('0.75em')).toEqual(['0.75em'])
    expect(chosenQuantities('95vh')).toEqual(['95vh'])
    // Derivations, which is what this guard wants written instead.
    expect(chosenQuantities('calc(var(--paper-line) * 1.5)')).toEqual([])
    expect(chosenQuantities('${size}px')).toEqual([])
    expect(chosenQuantities('var(--paper-line)')).toEqual([])
    // Structure, not quantity.
    expect(chosenQuantities('100%')).toEqual([])
    expect(chosenQuantities('0')).toEqual([])
    expect(chosenQuantities('auto')).toEqual([])
    // A multiplier of one selects nothing; a hairline is not a thickness.
    expect(chosenQuantities('1rem !important')).toEqual([])
    expect(chosenQuantities('1px solid currentColor')).toEqual([])
    expect(chosenQuantities('2px solid currentColor')).toEqual(['2px'])
    // A unit inside a calc is still a chosen quantity — the same case
    // `tokens.test.ts` probes with `calc(var(--a) - 7px)`.
    expect(chosenQuantities('calc(var(--paper-line) - 7px)')).toEqual(['7px'])
  })

  it('reads declarations out of the template literals and nothing else', () => {
    const parsed = declarationsIn(
      ['const A = `', 'p { color: red; font-size: 2px }', '`', 'const b = `url(${x})`'].join('\n'),
    )
    expect(parsed.map((d) => d.property)).toEqual(['color', 'font-size'])
    expect(parsed[1]?.line).toBe(2)
  })

  it('reads a marker on the declaration’s own line, and not one on another', () => {
    const parsed = declarationsIn(
      ['const A = `', 'p { z-index: -1; /* constant: behind the text, by one */ }', 'p { top: 3px }', '`'].join('\n'),
    )
    expect(parsed[0]?.reason).toBe('behind the text, by one')
    expect(parsed[1]?.reason).toBe(null)
  })

  it('does not read prose in a CSS comment as a declaration', () => {
    const parsed = declarationsIn(
      ['const A = `', '/* the margin: 12px it used to carry */', 'p { color: red }', '`'].join('\n'),
    )
    expect(parsed.map((d) => d.property)).toEqual(['color'])
  })

  it('does not read a comment that spans lines as declarations', () => {
    const parsed = declarationsIn(
      ['const A = `', '/* it was', ' * font-size: 9px, once', ' */', 'p { color: red }', '`'].join('\n'),
    )
    expect(parsed.map((d) => d.property)).toEqual(['color'])
  })
})
