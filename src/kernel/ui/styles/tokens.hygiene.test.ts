import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../../core/palette'

/**
 * THE OTHER HALF OF THE GUARD: not "is a token used where one belongs", which
 * `tokens.test.ts` answers, but "is the token set itself sound".
 *
 * Three questions, none of which anything in this repository could answer
 * before, each found by an audit rather than by a failing build:
 *
 *   1. Does every token something reads EXIST? — `check-css-tokens.mjs` asks
 *      this of stylesheets, and it is the one of the three that was covered.
 *      What it could not see is below.
 *   2. Does every token that EXISTS get read? A published property with no
 *      `var()` behind it is a promise nobody collects. `metrics.ts` states this
 *      rule in its own words — *"ONLY TOKENS SOMETHING READS … nine of them had
 *      accumulated here"* — and nothing enforced it, so three had accumulated
 *      again on the other side of the system.
 *   3. Does every theme answer for every colour? A theme is *"a set of values
 *      and nothing else"* by `tokens.css`'s own account, which only holds if
 *      each one re-values what it needs to. The shadow families and `--scrim`
 *      are deliberately inherited; `--danger` is re-valued by two themes and not
 *      by a third, and the only thing that said so was a prose comment.
 *
 * And a fourth that is not about the set but about what the set CLAIMS:
 * `tokens.css`'s header says §10 *"publishes measured (not estimated) ratios"*.
 * Those five pairs hold. The pair nobody measured did not — see the contrast
 * block at the foot of this file.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..', '..')
const TOKENS = join(HERE, 'tokens.css')

function filesUnder(dir: string, ext: readonly string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, ext))
    else if (ext.some((one) => name.endsWith(one))) out.push(full)
  }
  return out
}

const blank = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))

/**
 * `tokens.css` as blocks: the selector, and what it defines.
 *
 * Read from the FILE rather than from a table copied into a test. `palette.ts`'s
 * own tests pin two ratios against hexes typed into the test file under a
 * comment claiming they are *"read from `tokens.css`"* — so editing a theme
 * cannot fail them. Everything here reads the real bytes, which is the only
 * reading that can go red when somebody changes a colour.
 */
function themeBlocks(): { selector: string; tokens: Map<string, string> }[] {
  const src = blank(readFileSync(TOKENS, 'utf8'))
  const out: { selector: string; tokens: Map<string, string> }[] = []
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ')
    const tokens = new Map<string, string>()
    for (const d of (m[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      tokens.set(d[1] ?? '', (d[2] ?? '').trim())
    }
    if (tokens.size > 0) out.push({ selector, tokens })
  }
  return out
}

/** Every `--name` any theme block defines. */
function definedTokens(): Set<string> {
  const all = new Set<string>()
  for (const block of themeBlocks()) for (const name of block.tokens.keys()) all.add(name)
  return all
}

/**
 * Every `--name` anything READS, across stylesheets and TypeScript both.
 *
 * ⚠️ **THE TYPESCRIPT HALF IS WHY THIS IS NOT JUST A CSS SCAN.** A token can be
 * read by `getPropertyValue('--x')`, by an inline `style={{ '--x': … }}`, by a
 * template that builds a `var(--x)` string, or by `bookCss.ts` writing a whole
 * stylesheet into the book's document. A dead-token check that looked only at
 * `.css` would call all of those dead and delete a live token, which is a worse
 * failure than the one it is trying to prevent.
 *
 * Deliberately GENEROUS about HOW a name is read: any appearance in CODE counts.
 * That direction is the safe one — it can miss a token that is genuinely dead
 * (because something merely mentions it), and it will never call a live one
 * dead. `check-css-tokens.mjs` makes the same trade in the same direction and
 * says so.
 *
 * ⚠️ **BUT A COMMENT IS NOT A READ, AND THAT DISTINCTION IS THE WHOLE POINT.**
 * `--shadow-window` was dead precisely because `WindowShell.module.css` names it
 * in a comment while the rule below draws with something else. A scan that
 * counted prose would have called it live and reported a clean sweep — so
 * comments are blanked before the names are collected, in TypeScript as well as
 * in CSS.
 *
 * ⚠️ **AND THIS FILE IS EXCLUDED FROM ITS OWN SCAN**, which is not a
 * convenience: it discusses dead tokens BY NAME, so counting itself would let a
 * token be kept alive by the very test complaining that it is dead. Blanking
 * comments already removes the prose; skipping the file removes the rest.
 */
function readTokens(): Set<string> {
  const read = new Set<string>()
  const here = fileURLToPath(import.meta.url)
  for (const file of filesUnder(SRC, ['.css', '.ts', '.tsx'])) {
    if (file === TOKENS || file === here) continue
    /* Block comments in both languages, and TypeScript's line comments. A `//`
       inside a string is blanked too, which can only ever make this stricter. */
    const src = blank(readFileSync(file, 'utf8')).replace(/\/\/[^\n]*/g, '')
    for (const m of src.matchAll(/--[a-z][\w-]*/gi)) read.add(m[0])
  }
  return read
}

describe('every token the design system defines is read by something', () => {
  /**
   * ⚠️ **THREE TOKENS WERE DEFINED FOR EVERY THEME AND READ BY NOTHING**, found
   * by audit on 2026-09-18: `--mark-ink`, `--shadow-window` and `--shadow-knob`.
   * `--shadow-window` is the instructive one — `WindowShell.module.css` names it
   * in a COMMENT, describing the elevation the window has, while the rule below
   * uses something else. A grep for the name finds it; a check for what draws
   * with it does not.
   *
   * A dead token is worse than clutter because it reads as a decision. Somebody
   * looking for how the window is elevated finds `--shadow-window`, in five
   * themes, with a comment about elevation, and learns a fact about the app that
   * is not true — which is exactly what `metrics.ts` records happening on its
   * own side of the system, to nine properties at once.
   */
  it('has no token nothing reads', () => {
    const read = readTokens()
    const dead = [...definedTokens()].filter((name) => !read.has(name)).sort()
    expect(
      dead,
      `\n${dead.length} token(s) defined in tokens.css and read by nothing:\n  ${dead.join('\n  ')}\n\n` +
        'Either use it or delete it. A token nobody reads reads as a decision.\n',
    ).toEqual([])
  })

  /* Non-vacuity: the scan must be able to find a name, or "nothing is dead"
     means "I read no files".
     ⚠️ The absent name is BUILT rather than written, because a literal here
     would be a name this file contains — and this file was in the scan until it
     found itself and said the name was read. Skipping the file fixed that; the
     assembly keeps this honest if the skip ever regresses. */
  it('is reading real files', () => {
    const read = readTokens()
    expect(read.has('--space-8')).toBe(true)
    expect(read.has('--ink')).toBe(true)
    expect(read.has(['--no', 'such', 'token', 'as', 'this'].join('-'))).toBe(false)
    expect(definedTokens().size).toBeGreaterThan(40)
  })
})

/**
 * WHAT A THEME MUST ANSWER FOR, and what it may inherit.
 *
 * `:root` is Paper and defines everything. Every other theme is an attribute
 * selector that re-values what its own paper requires — so a token it does NOT
 * re-value is a claim that Paper's value is right on that paper too. Sometimes
 * that is true and sometimes it is an omission, and the two are
 * indistinguishable by looking.
 *
 * So the exceptions are listed here WITH THEIR REASONS, and anything else
 * missing is a failure. The list is the argument, exactly as `SCALED`'s is in
 * `tokens.test.ts`.
 */
const MAY_INHERIT: ReadonlyMap<string, string> = new Map([
  [
    '--tl-red',
    "macOS draws the traffic lights and owns their colours; they are the same on every theme because they are not Paper's.",
  ],
  ['--tl-amber', 'As `--tl-red`.'],
  ['--tl-green', 'As `--tl-red`.'],
  ['--tl-rim', 'As `--tl-red`.'],
  /* ⚠️ **`--shadow-window` AND `--shadow-knob` WERE EXCUSED HERE AND ARE NOW
     DELETED** — the dead-token check above found them, so their excuses went
     with them, which is what `excuses no token the root does not define` is
     for. The anchor moved to `--shadow-card`, which is drawn. */
  [
    '--shadow-card',
    "Elevation is re-valued only by Night, which `tokens.css` states: a light-theme shadow disappears on a dark page, and the light themes' papers are close enough in value to share one.",
  ],
  ['--shadow-jacket', 'As `--shadow-card`.'],
  ['--shadow-pop', 'As `--shadow-card`.'],
  ['--shadow-pill', 'As `--shadow-card`.'],
  ['--scrim', 'As `--shadow-card`: a scrim over a light page is the same scrim.'],
  /* ⚠️ **FOUND BY THIS CHECK ON ITS FIRST RUN, AND THE OMISSION IS CORRECT.**
     Slate and sage each carry their own `--danger` with the same stated reason:
     the root red measures under 4.5:1 on that theme's `--wash`. Sepia does not,
     and that reads like the third of three being forgotten — but it is not.
     Sepia's inherited red measures 5.77:1 on its `--surface` and 4.96:1 on its
     `--wash`, so it has nothing to fix. The contrast block below is what
     establishes that, rather than this sentence. */
  [
    '--danger',
    "Sepia alone inherits the root red, because it is the one light theme that does not need its own: 5.77:1 on its --surface and 4.96:1 on its --wash, both measured by the contrast check in this file. Slate and sage fall under the floor on --wash and carry their own.",
  ],
])

describe('every theme answers for every colour', () => {
  const blocks = themeBlocks()
  const root = blocks.find((b) => b.selector.includes(':root') && b.tokens.has('--ink'))
  const themes = blocks.filter((b) => /\[data-theme=/.test(b.selector) && !b.selector.includes(':root'))

  it('found the root block and the themes', () => {
    expect(root, 'no :root block defining --ink in tokens.css').toBeTruthy()
    expect(themes.length).toBeGreaterThanOrEqual(4)
  })

  /**
   * ⚠️ **`--danger` IS RE-VALUED BY SLATE AND SAGE AND NOT BY SEPIA**, and the
   * only thing that said so was prose. Both comments give the same reason — the
   * root red measures under 4.5:1 on that theme's `--wash` — which is a
   * measurement, so whether sepia needs one is a question with an answer rather
   * than a matter of taste. It does not: sepia's own pairs clear the floor (see
   * the contrast block below, which is what now says so).
   *
   * That is the shape of the whole problem here. Every omission has an answer;
   * none of them was written anywhere a build could read.
   */
  it('re-values every colour the root defines, or says why it inherits', () => {
    const gaps: string[] = []
    for (const theme of themes) {
      for (const name of root?.tokens.keys() ?? []) {
        if (theme.tokens.has(name)) continue
        if (MAY_INHERIT.has(name)) continue
        gaps.push(`${theme.selector} does not re-value ${name}`)
      }
    }
    expect(
      gaps,
      `\n${gaps.length} token(s) a theme neither re-values nor is excused from:\n  ${gaps.join('\n  ')}\n\n` +
        'Either give the theme its own value, or add the token to MAY_INHERIT with the reason.\n',
    ).toEqual([])
  })

  /* An excuse for a token that no longer exists is a reason nobody can check,
     and it would silently cover a real omission if the name came back. */
  it('excuses no token the root does not define', () => {
    const stale = [...MAY_INHERIT.keys()].filter((name) => !root?.tokens.has(name))
    expect(stale, `\nMAY_INHERIT names token(s) the root does not define:\n  ${stale.join('\n  ')}\n`).toEqual([])
  })

  /**
   * An excuse must say something, or the table is a skip-list wearing a
   * comment. A CROSS-REFERENCE counts — "As `--tl-red`." is how four traffic
   * lights share one argument without four copies of it that can drift apart —
   * but only to an entry that carries a real reason itself, so a chain of
   * references cannot bottom out in nothing.
   */
  it('gives every excuse a reason, or points at one', () => {
    const SUBSTANTIAL = 20
    for (const [name, why] of MAY_INHERIT) {
      if (why.length > SUBSTANTIAL) continue
      const referred = [...(why.matchAll(/--[\w-]+/g))].map((m) => m[0])
      expect(referred, `${name}: too short to be a reason and names no other token`).not.toEqual([])
      for (const other of referred) {
        expect(MAY_INHERIT.get(other)?.length ?? 0, `${name} points at ${other}`).toBeGreaterThan(SUBSTANTIAL)
      }
    }
  })
})

/**
 * THE CONTRAST FLOOR, COMPUTED FROM THE FILE.
 *
 * ⚠️ **THE RATIOS WERE A CLAIM IN A COMMENT AND NOTHING READ THE COLOURS.**
 * `tokens.css` opens by saying the amber *"was darkened per theme during the
 * design pass to clear 4.5:1"* and points at §10, which *"publishes measured
 * (not estimated) ratios for five pairs across five themes"*. All twenty-five of
 * those hold — measured here, from the real bytes, not taken on trust.
 *
 * ⚠️ **AND THE PAIR THAT WAS NOT IN THE PUBLISHED FIVE FAILED ON THREE THEMES.**
 * `--muted` on `--wash` measures 3.88:1 on slate, 3.94 on sage and 3.97 on
 * sepia. It had two live call sites. They were changed to `--ink-2`, which
 * clears the floor everywhere, and the palette was left alone — but the lesson
 * is the general one: **a pairing nobody measured is a pairing nobody checked,
 * and the set of pairs the design measured is not the set the app draws.**
 *
 * So this table is not §10's five. It is every ink-on-ground pair the
 * stylesheets actually produce, and it is meant to grow when a new one appears.
 */
const FLOOR = 4.5

/** The ink/ground pairs the app draws, as token names. */
const PAIRS: ReadonlyArray<readonly [ink: string, ground: string]> = [
  ['--ink', '--surface'],
  ['--ink', '--bg'],
  ['--ink', '--wash'],
  ['--ink-2', '--surface'],
  ['--ink-2', '--bg'],
  ['--ink-2', '--wash'],
  ['--muted', '--surface'],
  ['--muted', '--bg'],
  ['--muted', '--wash'],
  ['--accent', '--surface'],
  ['--accent', '--accent-bg'],
  /* The accent on the hover/pressed wash — a lit tool in the selection popup, a
     lit tab, a chosen row. Five stylesheets draw it. Added when the lookup's
     speak control took it for its "speaking" state and the pair turned out not
     to be in this table, which is the growth this table is FOR: the set the app
     draws is not the set anybody measured. 5.61:1 at its worst, on sage. */
  ['--accent', '--wash'],
  ['--danger', '--surface'],
  ['--danger', '--wash'],
  ['--amber', '--surface'],
  ['--amber', '--amber-bg'],
]

/**
 * ⚠️ **`--muted` ON `--wash` IS IN THIS TABLE BECAUSE THE COLOUR MOVED, NOT
 * BECAUSE THE PAIRING WAS ALWAYS FINE.** It measured 3.88 / 3.94 / 3.97 on
 * slate, sage and sepia. The first fix moved the two rules that co-declared it
 * to `--ink-2` and left the palette alone — and that was the wrong fix, for a
 * reason worth keeping: the pairing also arrives by INHERITANCE, a `--wash`
 * hover background over a `--muted` child and a `--wash` field with a `--muted`
 * placeholder, so it cannot be hunted call site by call site. `tokens.css`
 * carries the numbers; `--muted` is 10% darker on those three themes and every
 * ground now clears the floor.
 *
 * The general lesson is the one this table is built on: **a pair the design
 * measured is not the set the app draws.** `--muted` on `--bg` — the commonest
 * pairing in the app, since every secondary label sits on the page — was under
 * the floor on three themes and was in nobody's list of five.
 */
describe('every ink the app draws on every ground it draws it on clears 4.5:1', () => {
  const blocks = themeBlocks()
  const root = blocks.find((b) => b.selector.includes(':root') && b.tokens.has('--ink'))!
  const themes = [
    { name: 'paper', tokens: root.tokens },
    ...blocks
      .filter((b) => /\[data-theme=/.test(b.selector) && !b.selector.includes(':root'))
      .map((b) => ({ name: b.selector, tokens: b.tokens })),
  ]

  /* A theme inherits what it does not re-value, so each colour is resolved
     against the root exactly as the cascade would resolve it. Reading a theme's
     own block alone would report a pair as absent when it is merely inherited. */
  const resolve = (tokens: Map<string, string>, name: string): string | undefined =>
    tokens.get(name) ?? root.tokens.get(name)

  it('holds every pair on every theme', () => {
    const failures: string[] = []
    let checked = 0
    for (const theme of themes) {
      for (const [ink, ground] of PAIRS) {
        const a = resolve(theme.tokens, ink)
        const b = resolve(theme.tokens, ground)
        if (!a || !b) {
          failures.push(`${theme.name}: ${ink} or ${ground} has no value at all`)
          continue
        }
        if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) continue
        checked += 1
        const ratio = contrastRatio(a, b)
        if (ratio < FLOOR) {
          failures.push(`${theme.name}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1 (${a} on ${b})`)
        }
      }
    }
    expect(checked, 'no pair was resolvable — the parse found nothing').toBeGreaterThan(50)
    expect(
      failures,
      `\n${failures.length} pair(s) under ${FLOOR}:1:\n  ${failures.join('\n  ')}\n\n` +
        'Either re-value the colour on that theme, or stop drawing that pairing and\n' +
        'remove it from PAIRS with a note saying where it went.\n',
    ).toEqual([])
  })

  /**
   * Non-vacuity, against the values that were actually failing.
   *
   * ⚠️ **THIS USED TO ASSERT THAT SLATE'S OWN PAIR STILL FAILED**, which was
   * true when it was written and became false the moment the colour was fixed —
   * a non-vacuity check that a real fix turns red. The literals below are the
   * PRE-FIX hexes, kept as data rather than read from the file, so this measures
   * the arithmetic against a known-bad pair for good. If it ever passes, the
   * contrast function is broken and every ratio above is meaningless.
   */
  it('would catch a pair under the floor', () => {
    expect(contrastRatio('#5C6367', '#D6D9D5')).toBeLessThan(FLOOR)
    expect(contrastRatio('#7A6A54', '#F3EAD9')).toBeLessThan(FLOOR)
    /* And the fixed values must clear it, or the fix is not what it claims. */
    expect(contrastRatio('#53595D', '#D6D9D5')).toBeGreaterThanOrEqual(FLOOR)
    expect(contrastRatio('#6F604C', '#F3EAD9')).toBeGreaterThanOrEqual(FLOOR)
  })
})
