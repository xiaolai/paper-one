import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCssTokens, declaredIn, referencedIn, writtenInCode } from './check-css-tokens.mjs'

/**
 * `check-css-tokens`: what makes a custom property defined, and what does not.
 *
 * THE GATE EXISTS BECAUSE AN UNDEFINED PROPERTY IS SILENT. `var(--ink-muted)`
 * with nothing defining `--ink-muted` is not an error, not a warning and not a
 * fallback — the declaration is dropped and the element inherits. The browser
 * client shipped with five invented names and the only signal was a book title
 * touching the edge of a phone.
 *
 * A FALSE POSITIVE IS THE FAILURE THAT MATTERS MORE, because it is the one that
 * teaches people to ignore the gate — and this check earned that lesson: its
 * first run called 23 of its 26 findings wrong, because it looked only at
 * stylesheets and most of this app's geometry is written from TypeScript. So
 * most of what follows is proof that a legitimately-defined name does NOT trip
 * it, one definition style at a time.
 */

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A tree holding `files` (path → content), rooted where the gate expects. */
function fixture(files) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'css-tokens-'))
  roots.push(root)
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

const undefinedNames = (files) =>
  checkCssTokens(fixture(files))
    .findings.map((f) => f.name)
    .sort()

describe('what it reports', () => {
  it('reports a reference nothing defines', () => {
    expect(undefinedNames({ 'src/a.css': '.x { color: var(--nope); }' })).toEqual(['--nope'])
  })

  it('names the file and the line, so the finding is actionable', () => {
    const root = fixture({ 'src/ui/a.css': '.x {\n  color: red;\n  border: 1px solid var(--nope);\n}' })
    const [finding] = checkCssTokens(root).findings
    expect(finding.file).toBe(join('src', 'ui', 'a.css'))
    expect(finding.line).toBe(3)
  })

  /* SEVERAL REFERENCES ON ONE LINE. The track grid is written as
   * `grid-template-columns: var(--a) var(--b) var(--c)`, so a per-line "first
   * match wins" scan would report one of three. */
  it('reports every reference on a line, not the first', () => {
    const css = '.x { grid-template-columns: var(--a) var(--b) var(--c); }'
    expect(undefinedNames({ 'src/a.css': css })).toEqual(['--a', '--b', '--c'])
  })

  /**
   * A FALLBACK DOES NOT EXCUSE THE NAME.
   *
   * `var(--radius-chip, 6px)` survives, so nothing looks wrong — and the token
   * is then decorative: the value it was supposed to track can change without
   * anything on screen following it. That exact case is recorded in
   * `metrics.ts`, where `--radius-chip` had to be published after the fact.
   */
  it('reports a reference that has a fallback', () => {
    expect(undefinedNames({ 'src/a.css': '.x { border-radius: var(--nope, 6px); }' })).toEqual(['--nope'])
  })
})

describe('what it must never report', () => {
  it('accepts a name declared in the same stylesheet', () => {
    expect(undefinedNames({ 'src/a.css': ':root { --gap: 4px; }\n.x { margin: var(--gap); }' })).toEqual([])
  })

  it('accepts a name declared in a different stylesheet', () => {
    const files = { 'src/tokens.css': ':root { --gap: 4px; }', 'src/a.css': '.x { margin: var(--gap); }' }
    expect(undefinedNames(files)).toEqual([])
  })

  /* TOKENS ARE PACKED SEVERAL TO A LINE in `tokens.css`. A line-anchored
   * pattern finds `--ink` and misses `--ink-2` and `--muted`, which is how the
   * first attempt at this idea produced ten names when five were real. */
  it('accepts names packed several to a declaration line', () => {
    const files = {
      'src/tokens.css': ':root { --ink:#17191B; --ink-2:#3D4348; --muted:#5F666C; }',
      'src/a.css': '.x { color: var(--ink); border-color: var(--ink-2); outline-color: var(--muted); }',
    }
    expect(undefinedNames(files)).toEqual([])
  })

  /**
   * THE 23-OF-26 CASE. Most of this app's geometry never appears in a
   * stylesheet: `metrics.ts` publishes it onto the root, `Reader.tsx` writes
   * the track grid as an inline style object, `bookCss.ts` writes from a table.
   * Each of those styles is proved separately, because each is a different way
   * for the check to go blind.
   */
  it('accepts a name published from a style object', () => {
    const files = {
      'src/metrics.ts': "export const M = { '--control-sm': px(24) }",
      'src/a.css': '.x { height: var(--control-sm); }',
    }
    expect(undefinedNames(files)).toEqual([])
  })

  it('accepts a name written with setProperty', () => {
    const files = {
      'src/apply.ts': "root.style.setProperty('--scale-factor', String(scale))",
      'src/a.css': '.x { zoom: var(--scale-factor); }',
    }
    expect(undefinedNames(files)).toEqual([])
  })

  it('accepts a name written from a .tsx inline style', () => {
    const files = {
      'src/Reader.tsx': "const style = { '--track-gap': `${grid.gap}px` } as CSSProperties",
      'src/a.css': '.x { gap: var(--track-gap); }',
    }
    expect(undefinedNames(files)).toEqual([])
  })

  it('accepts a name held in a constant and written indirectly', () => {
    const files = {
      'src/marks.ts': "const SMALL_VAR = '--paper-small'\nel.style.setProperty(SMALL_VAR, share)",
      'src/a.css': '.x { font-size: var(--paper-small); }',
    }
    expect(undefinedNames(files)).toEqual([])
  })
})

describe('what code counts as a definition', () => {
  /**
   * PROSE IS NOT A DEFINITION.
   *
   * A doc comment describing a token would otherwise vouch for it forever —
   * which is exactly how a name outlives the code that used to write it, with
   * the comment as the only thing keeping the gate quiet.
   */
  it('ignores a token named in a comment', () => {
    expect(writtenInCode(' * Each sample carries `--face-scale`, the same correction')).toEqual(new Set())
    expect(writtenInCode("// see '--face-scale'")).toEqual(new Set())
    expect(writtenInCode("/* '--face-scale' */")).toEqual(new Set())
  })

  it('counts a token in code on the same file as a comment mentioning another', () => {
    const text = " * talks about `--described`\nreturn { '--written': scale }"
    expect(writtenInCode(text)).toEqual(new Set(['--written']))
  })

  it('counts single quotes, double quotes and backticks alike', () => {
    expect(writtenInCode(`a('--one'); b("--two"); c(\`--three\`)`)).toEqual(
      new Set(['--one', '--two', '--three']),
    )
  })

  /**
   * A TRAILING COMMENT IS PROSE TOO, and the old scan only skipped lines that
   * STARTED with a comment marker. A token named after real code on the same
   * line vouched for itself.
   */
  it('ignores a token named in a comment that follows code', () => {
    expect(writtenInCode("const a = 1 // see '--noted'")).toEqual(new Set())
    expect(writtenInCode("const a = 1 /* see '--noted' */")).toEqual(new Set())
  })

  /* …and a multi-line block comment, which no line-prefix test can see the
     middle of. */
  it('ignores a token named inside a multi-line comment', () => {
    const text = "/*\n  the palette writes '--ink'\n*/\nreturn { '--real': 1 }"
    expect(writtenInCode(text)).toEqual(new Set(['--real']))
  })

  /**
   * ⚠️ **A READ IS NOT A DEFINITION.** `getPropertyValue('--x')` ASKS for a
   * token and defines nothing — so counting it made a name that no stylesheet
   * declares and nothing ever sets look defined, purely because something
   * looked it up. That is the exact defect this gate exists to catch, hiding
   * behind the gate itself. `useAppPalette` reads nine tokens this way.
   */
  it('does not count a token that is only read back', () => {
    expect(writtenInCode("getComputedStyle(el).getPropertyValue('--asked')")).toEqual(new Set())
    expect(writtenInCode("cs.getPropertyValue('--asked')")).toEqual(new Set())
  })

  it('still counts a token that is written, next to one that is read', () => {
    const text = "cs.getPropertyValue('--asked'); el.style.setProperty('--set', x)"
    expect(writtenInCode(text)).toEqual(new Set(['--set']))
  })

  /* NOT `\/\/.*$`. That eats the `//` in a URL and takes the rest of the line
     with it — including the write that follows. Same trap `check-browser-safe`
     records; both scanners have now fallen into it. */
  it('does not lose a write that follows a URL on the same line', () => {
    const text = `const u = "https://x/y"; el.style.setProperty('--kept', 1)`
    expect(writtenInCode(text)).toEqual(new Set(['--kept']))
  })
})

/**
 * A COMMENTED-OUT DECLARATION IS NOT A DECLARATION.
 *
 * `/* --dead: red; *\/` matched the same pattern a live rule does, so a token
 * somebody had commented out went on satisfying every `var()` referencing it —
 * and this gate, whose whole job is to find a `var()` that resolves to nothing,
 * reported clean. The dead name looked alive because its gravestone was
 * legible.
 */
describe('what a stylesheet counts as a declaration', () => {
  it('ignores a declaration inside a comment', () => {
    expect(declaredIn(':root{ /* --dead: red; */ --live: blue; }')).toEqual(new Set(['--live']))
  })

  it('ignores a var() inside a comment, so it is not reported as undefined', () => {
    expect(referencedIn('a{ /* color: var(--dead); */ color: var(--live); }').map((r) => r.name)).toEqual([
      '--live',
    ])
  })

  /* Comments are BLANKED rather than removed, so the line a reference sits on
     is still the line the finding names. */
  it('keeps line numbers right across a multi-line comment', () => {
    const css = '/*\n a\n b\n*/\na{ color: var(--live) }'
    expect(referencedIn(css)).toEqual([{ name: '--live', line: 5 }])
  })
})

describe('the scan itself', () => {
  /**
   * NO STYLESHEETS IS NOT A PASS.
   *
   * "every reference resolves" is trivially true of nothing, so an empty scan
   * would report success while measuring a tree it never found — the same
   * shape as a green build that silently did no work.
   */
  it('refuses to pass when it found no stylesheets at all', () => {
    const { findings, files } = checkCssTokens(fixture({ 'src/a.ts': 'export const x = 1' }))
    expect(files).toBe(0)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/no stylesheets/)
  })

  it('finds stylesheets at any depth', () => {
    expect(undefinedNames({ 'src/a/b/c/deep.css': '.x { color: var(--nope); }' })).toEqual(['--nope'])
  })

  it('counts every reference it looked at, so a silent no-op is visible', () => {
    const files = { 'src/tokens.css': ':root { --gap: 4px; }', 'src/a.css': '.x { margin: var(--gap); }' }
    expect(checkCssTokens(fixture(files)).references).toBe(1)
  })
})

describe('the parsers', () => {
  it('reads a declaration with or without space before the colon', () => {
    expect(declaredIn('--a:1px; --b : 2px;')).toEqual(new Set(['--a', '--b']))
  })

  /* A REFERENCE IS NOT A DECLARATION. `var(--x)` has no colon after the name,
   * so it must not make itself defined — which would render the gate inert. */
  it('does not treat a reference as its own declaration', () => {
    expect(declaredIn('.x { color: var(--nope); }')).toEqual(new Set())
  })

  it('reads a reference with space after the paren', () => {
    expect(referencedIn('.x { color: var( --a ); }').map((r) => r.name)).toEqual(['--a'])
  })
})
