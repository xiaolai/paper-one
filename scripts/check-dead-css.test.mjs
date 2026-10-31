import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { deadClasses, undefinedClasses } from './check-dead-css.mjs'

/**
 * `check-dead-css`: what counts as reaching a class, and what does not.
 *
 * THE GATE EXISTS BECAUSE A RULE OUTLIVES ITS COMPONENT SILENTLY — `.enriching`,
 * `.emptyAction` and `.popover` were all found by hand, and by the third it was
 * a class of defect rather than three mistakes. What makes a check like that
 * worth having is that it is neither blind nor noisy, and both halves are here:
 * a rule nothing can reach is reported, and every way a class IS reached is
 * proved not to trip it. A false positive is the failure that matters more,
 * because it is the one that teaches people to ignore the gate.
 */

const SCRIPT = fileURLToPath(new URL('./check-dead-css.mjs', import.meta.url))

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A tree holding `files` (path → content), rooted where the gate expects. */
function fixture(files) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dead-css-'))
  roots.push(root)
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

const names = (root) => deadClasses(root).dead.map((d) => d.name).sort()

describe('what the gate reports', () => {
  it('finds a rule no source names', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n.orphan { color: blue; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => styles.live\n",
    })
    expect(names(root)).toEqual(['orphan'])
  })

  it('points at the rule, not at the prose above it', () => {
    /* A class is usually described in a comment before it is defined, and this
       codebase's comments are long — reporting the comment's line sends the
       reader to the wrong place in a file where that can be forty lines off. */
    const root = fixture({
      'src/A.module.css': '/* about .orphan, at length */\n/* still about .orphan */\n.orphan { color: blue; }\n',
      'src/A.tsx': "export const A = () => null\n",
    })
    expect(deadClasses(root).dead[0]).toMatchObject({ name: 'orphan', line: 3 })
  })
})

describe('every way a class is reached', () => {
  /* Each of these was, or would have been, a false positive. The `composes`
     pair is not hypothetical: reading only the cross-file form reported
     `.groupTitle` as unreachable while three rules in its own stylesheet were
     built from it. */
  it.each([
    ['a source naming it', { 'src/A.tsx': "export const A = () => styles.target\n" }, {}],
    [
      'same-file composes',
      { 'src/A.tsx': 'export const A = () => styles.other\n' },
      { extra: '.other { composes: target; }\n' },
    ],
    [
      'cross-file composes',
      { 'src/A.tsx': "export const A = () => styles.b\n" },
      { second: ".b { composes: target from './A.module.css'; }\n" },
    ],
  ])('does not report it when reached by %s', (_what, sources, css) => {
    const root = fixture({
      'src/A.module.css': `.target { color: red; }\n${css.extra ?? ''}`,
      ...(css.second ? { 'src/B.module.css': css.second } : {}),
      ...sources,
    })
    expect(names(root)).not.toContain('target')
  })

  /* THE ESCAPE HATCH IS A RENAME, not a list in the script. An allowlist grows
     a line at a time until nobody reads it; a leading underscore is visible at
     the rule, to the next person who reads the CSS. */
  it('leaves an underscore-prefixed class alone', () => {
    const root = fixture({
      'src/A.module.css': '._keptOnPurpose { color: red; }\n',
      'src/A.tsx': 'export const A = () => null\n',
    })
    expect(names(root)).toEqual([])
  })

  /* Custom properties and decimals both start with characters a naive class
     regex swallows, and a gate that reports `--space-4` as a dead class is one
     nobody will run twice. */
  it('does not mistake a custom property or a decimal for a class', () => {
    const root = fixture({
      'src/A.module.css': ':root { --space-4: 4px; }\n.live { margin: 0.5rem var(--space-4); }\n',
      'src/A.tsx': 'export const A = () => styles.live\n',
    })
    expect(names(root)).toEqual([])
  })
})

/*
 * ⚠️ **THE OTHER DIRECTION, AND THE ONE THAT SHOWS.** A class named in markup that
 * no stylesheet declares reads as `undefined`, and React draws no attribute: no
 * error, no warning, a bare browser control in the middle of a designed pane.
 * The side pane's search field lost its whole rule that way, and this gate
 * passed through it because it only asked the question from the stylesheet's end.
 */
describe('a class the markup names and no stylesheet declares', () => {
  const missing = (root) => undefinedClasses(root).map((u) => `${u.file}: ${u.name}`)

  it('is reported, against the module that file imported', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/B.module.css': '.gone { color: red; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => styles.live + styles.gone\n",
    })
    expect(missing(root)).toEqual(['src/A.tsx: gone'])
  })

  it('is reported under any name the module was imported by', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/A.tsx': "import editorStyles from './A.module.css'\nexport const A = () => editorStyles.gone\n",
    })
    expect(missing(root)).toEqual(['src/A.tsx: gone'])
  })

  it('is reported whichever quotes the import uses', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/A.tsx': 'import styles from "./A.module.css"\nexport const A = () => styles.gone\n',
    })
    expect(missing(root)).toEqual(['src/A.tsx: gone'])
  })

  /* A comment describing the rule is exactly what survives a careless deletion,
     and it must not count as the rule. */
  it('is not declared by a comment that mentions it', () => {
    const root = fixture({
      'src/A.module.css': '/* wrap it in a .gone first */\n.live { color: red; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => styles.gone\n",
    })
    expect(missing(root)).toEqual(['src/A.tsx: gone'])
  })

  it('is not found in the import path, nor in a selector that only qualifies', () => {
    const root = fixture({
      'src/controls.module.css': '.a:hover .live { color: red; }\n',
      'src/A.tsx': "import controls from './controls.module.css'\nexport const A = () => [controls.a, controls.live]\n",
    })
    expect(missing(root)).toEqual([])
  })
})

/*
 * ⚠️ **PROSE IS NOT A READ, IN EITHER DIRECTION.** Reading the source as text
 * failed the gate over a comment recording that a class had gone, and, worse,
 * kept a dead rule alive for as long as a comment or a string mentioned it.
 */
describe('what reads a class, once the source is parsed', () => {
  const missing = (root) => undefinedClasses(root).map((u) => u.name)

  it('does not take a comment or a string for a read of a missing class', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/A.tsx':
        "import styles from './A.module.css'\n" +
        '// styles.gone was removed\n' +
        '/* styles.goneToo as well */\n' +
        "export const A = () => [styles.live, 'styles.goneThree', `styles.goneFour`]\n",
    })
    expect(missing(root)).toEqual([])
  })

  it('does not let a comment or a string keep a dead rule alive', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n.orphan { color: blue; }\n.orphanToo { color: blue; }\n',
      'src/A.tsx':
        "import styles from './A.module.css'\n" +
        '// styles.orphan\n' +
        "export const A = () => [styles.live, 'styles.orphanToo']\n",
    })
    expect(names(root)).toEqual(['orphan', 'orphanToo'])
  })

  it('does not take an import written in a comment or a string for an import', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/B.tsx': "/*\nimport notes from './A.module.css'\n*/\nexport const B = (notes: { gone: string }) => notes.gone\n",
    })
    expect(missing(root)).toEqual([])
  })

  it.each([
    ['JSX', 'export const A = () => <p className={styles.gone} />'],
    ['a template', 'export const A = () => `a ${styles.gone}`'],
    ['an optional chain', 'export const A = () => styles?.gone'],
    ['a non-null assertion', 'export const A = () => styles!.gone'],
    ['parentheses', 'export const A = () => (styles).gone'],
    ['a literal lookup', "export const A = () => styles['gone']"],
  ])('still finds a read in %s', (_how, line) => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/A.tsx': `import styles from './A.module.css'\n${line}\n`,
    })
    expect(missing(root)).toEqual(['gone'])
  })

  it('finds a read through a namespace import', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/A.tsx': "import * as sheet from './A.module.css'\nexport const A = () => sheet.gone\n",
    })
    expect(missing(root)).toEqual(['gone'])
  })
})

/*
 * ⚠️ **ONLY A SELECTOR DECLARES.** A dot anywhere in the stylesheet used to count,
 * so `url("./icon.svg")` declared `svg`, and `styles.svg` passed while reading
 * as undefined at run time.
 */
describe('what declares a class', () => {
  it.each([
    ['a quoted url', '.live { background: url("./icon.svg"); }'],
    ['a single-quoted url', ".live { background: url('./icon.svg'); }"],
    ['a bare url', '.live { background: url(./icon.svg); }'],
    ['a data url holding a semicolon', '.live { background: url(data:image/x;a.svg); }'],
    ['a string value', '.live { content: "a.svg"; }'],
    ['an import', "@import './theme.svg';\n.live { color: red; }"],
    ['an at-rule condition', '@supports (background: url("./a.svg")) { .live { color: red; } }'],
    ['an attribute value', '.live[href$=".svg"] { color: red; }'],
    ['a comment with an apostrophe before it', "/* don't */\n.live { content: 'a.svg'; }"],
  ])('is not %s', (_what, css) => {
    const root = fixture({
      'src/A.module.css': `${css}\n`,
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => [styles.live, styles.svg]\n",
    })
    expect(undefinedClasses(root).map((u) => u.name)).toEqual(['svg'])
  })

  it.each([
    ['a plain rule', '.target { color: red; }'],
    ['a compound selector', '.live.target { color: red; }'],
    ['a selector list', '.live,\n.target { color: red; }'],
    ['a pseudo-class argument', '.live:not(.target) { color: red; }'],
    ['a combinator', '.live > .target { color: red; }'],
    ['a rule inside an at-rule', '@media (min-width: 1px) { .target { color: red; } }'],
    ['a nested rule after a declaration', '.live { color: red; .target { color: blue; } }'],
    ['a rule after one with a url', '.live { background: url(./a.svg); }\n.target { color: red; }'],
  ])('is %s', (_what, css) => {
    const root = fixture({
      'src/A.module.css': `.live { color: red; }\n${css}\n`,
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => [styles.live, styles.target]\n",
    })
    expect(undefinedClasses(root)).toEqual([])
  })

  it('reports no dead class for a dot in a comment, a string or a url', () => {
    const root = fixture({
      'src/A.module.css': '/*\n.mentioned is prose\n*/\n.live { background: url( .relative/a.svg); }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => styles.live\n",
    })
    expect(names(root)).toEqual([])
  })
})

describe('a class reached under another import name', () => {
  /* `.popover` was deleted as unreachable while three files drew it, because
     they import the module as `editorStyles` and this gate read only `styles.`.
     The gate had removed a live rule. */
  it('is not unreachable', () => {
    const root = fixture({
      'src/A.module.css': '.popover { color: red; }\n',
      'src/A.tsx': "import editorStyles from './A.module.css'\nexport const A = () => editorStyles.popover\n",
    })
    expect(names(root)).toEqual([])
  })
})

describe('the CLI', () => {
  it('exits 0 on this repository, and says what it looked at', () => {
    /* Against the real tree, which is the run that gates every push. The
       counts are printed because a check reporting "0 unreachable" over 0
       modules looks exactly like one that worked. */
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(run.stdout).toMatch(/check-dead-css: [1-9]\d* modules, [1-9]\d* classes used, 0 unreachable, 0 undefined/)
    expect(run.status).toBe(0)
  })
})

/*
 * ⚠️ **A READ IS A BINDING, NOT A SPELLING.** The gate has been wrong twice about
 * a form it did not read, so these are the forms, whole: every way a source can
 * hold a stylesheet, and what it can do with it.
 */
describe('which binding a read goes through', () => {
  const missing = (root) => undefinedClasses(root).map((u) => u.name).sort()
  const over = (source) =>
    fixture({ 'src/A.module.css': '.live { color: red; }\n', 'src/A.tsx': `${source}\n` })
  const IMPORT = "import styles from './A.module.css'\n"

  it.each([
    ['a parameter', 'export const f = (styles: any) => styles.gone'],
    ['a destructured parameter', 'export const f = ({ styles }: any) => styles.gone'],
    ['a local in an inner block', 'export const f = () => { { const styles = {} as any; return styles.gone } }'],
    ['a function name', 'export const f = () => { function styles() {} return (styles as any).gone }'],
    ['a catch binding', 'export const f = () => { try { } catch (styles: any) { return styles.gone } }'],
  ])('does not take a read through %s that shadows the import for a read of the module', (_what, body) => {
    expect(missing(over(IMPORT + body))).toEqual([])
  })

  it('settles on a binding reassigned between stylesheets', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/B.module.css': '.other { color: red; }\n',
      'src/A.tsx': "import a from './A.module.css'\nimport b from './B.module.css'\nlet s = a\ns = b\nlet t = s\ns = t\nexport const f = () => [s.live, b.other]\n",
    })
    expect(missing(root)).toEqual([])
  })

  it('names its limit on a namespace import read through default, loudly', () => {
    const root = over("import * as css from './A.module.css'\nexport const f = () => css.default.live")
    expect(missing(root)).toEqual(['default'])
    expect(names(root)).toEqual(['live'])
  })

  it('takes nothing from a default that is not a stylesheet', () => {
    const root = over(`${IMPORT}export const f = (o: any) => { const { s = {} } = o; let t: any; ({ t = {} } = o); return [s.gone, t.gone, styles.live] }`)
    expect(missing(root)).toEqual([])
    expect(names(root)).toEqual([])
  })

  it('still reads the import outside the scope that shadows it', () => {
    const root = over(`${IMPORT}export const f = (styles: any) => styles.other\nexport const g = () => styles.gone`)
    expect(missing(root)).toEqual(['gone'])
  })

  it.each([
    ['an optional read', `${IMPORT}export const f = () => styles?.gone`],
    ['a template key', `${IMPORT}export const f = () => styles[\`gone\`]`],
    ['a key in a conditional', `${IMPORT}export const f = (x: boolean) => styles[x ? 'gone' : 'live']`],
    ['a key in a fallback', `${IMPORT}export const f = (x: any) => styles[x ?? 'gone']`],
    ['a named default import', "import { default as s } from './A.module.css'\nexport const f = () => s.gone"],
    ['a named import', "import { gone } from './A.module.css'\nexport const f = () => gone"],
    ['a renamed named import', "import { gone as g } from './A.module.css'\nexport const f = () => g"],
    ['an import assignment', "import s = require('./A.module.css')\nexport const f = () => s.gone"],
    ['a local alias', `${IMPORT}const s = styles\nexport const f = () => s.gone`],
    ['an alias of an alias, declared later', `${IMPORT}export const f = () => { const t = s; return t.gone }\nconst s = styles`],
    ['an assigned alias', `${IMPORT}let s: any\ns = styles\nexport const f = () => s.gone`],
    ['a defaulted parameter', `${IMPORT}export const f = (s = styles) => s.gone`],
    ['a destructuring', `${IMPORT}const { gone } = styles\nexport const f = () => gone`],
    ['a renaming destructuring', `${IMPORT}const { gone: g } = styles\nexport const f = () => g`],
    ['a computed destructuring', `${IMPORT}const { ['gone']: g } = styles\nexport const f = () => g`],
    ['a rest binding', `${IMPORT}const { live, ...rest } = styles\nexport const f = () => [live, rest.gone]`],
    ['a destructuring parameter default', `${IMPORT}export const f = ({ gone } = styles) => gone`],
    ['a destructuring assignment', `${IMPORT}let g: any\n;({ gone: g } = styles)\nexport const f = () => g`],
    ['a default inside a pattern', `${IMPORT}export const f = (o: any) => { const { s = styles } = o; return s.gone }`],
    ['a renamed default inside a pattern', `${IMPORT}export const f = (o: any) => { const { x: s = styles } = o; return s.gone }`],
    ['a nested default inside a pattern', `${IMPORT}export const f = (o: any) => { const { a: { s = styles } } = o; return s.gone }`],
    ['a default in a destructuring assignment', `${IMPORT}export const f = (o: any) => { let s: any; ({ s = styles } = o); return s.gone }`],
    ['a renamed default in a destructuring assignment', `${IMPORT}export const f = (o: any) => { let s: any; ({ x: s = styles } = o); return s.gone }`],
  ])('reports a missing class through %s', (_what, source) => {
    expect(missing(over(source))).toEqual(['gone'])
  })

  it.each([
    ['a destructuring', "import styles from './A.module.css'\nconst { target } = styles\nexport const f = () => target"],
    ['a named import', "import { target } from './A.module.css'\nexport const f = () => target"],
    ['a conditional key', "import styles from './A.module.css'\nexport const f = (x: boolean) => styles[x ? 'target' : 'other']"],
    ['a destructuring of what was handed in', 'export const f = ({ styles }: any) => { const { target } = styles; return target }'],
    ['a nested destructuring of what was handed in', 'export const f = ({ styles: { target } }: any) => target'],
    ['a renamed handing-in', 'export const f = ({ styles: s }: any) => s.target'],
    ['a member of what was handed in', 'export const f = (props: any) => props.styles.target'],
    ['a default inside a pattern', "import styles from './A.module.css'\nexport const f = (o: any) => { const { s = styles } = o; return s.target }"],
    ['a default in a destructuring assignment', "import styles from './A.module.css'\nexport const f = (o: any) => { let s: any; ({ s = styles } = o); return s.target }"],
    ['a renamed handing-in with a default', 'export const f = (p: any) => { const { styles: s = {} } = p; return s.target }'],
    ['a handing-in by assignment', 'export const f = (p: any) => { let s: any; ({ styles: s } = p); return s.target }'],
    ['a handing-in by assignment with a default', 'export const f = (p: any) => { let s: any; ({ styles: s = {} } = p); return s.target }'],
    ['a nested handing-in by assignment with a default', 'export const f = (p: any) => { let t: any; ({ styles: { target: t } = {} as any } = p); return t }'],
    ['a shadowing parameter, which is what handing in looks like', "import styles from './B.module.css'\nexport const f = (styles: any) => styles.target"],
  ])('keeps a class alive through %s', (_what, source) => {
    const root = fixture({
      'src/A.module.css': '.target { color: red; }\n.other { color: red; }\n',
      'src/B.module.css': '',
      'src/A.tsx': `${source}\n`,
      'src/C.tsx': "import styles from './A.module.css'\nexport const C = () => styles.other\n",
    })
    expect(names(root)).toEqual([])
  })
})

/*
 * WHAT A MODULE EXPORTS IS NOT EVERY DOT IN ITS SELECTORS. `:global` hands a class
 * to the page: the import holds no such key, so a read of it is `undefined`.
 */
describe('what a stylesheet exports', () => {
  const reading = (css, ...classes) =>
    fixture({
      'src/A.module.css': `${css}\n`,
      'src/A.tsx': `import styles from './A.module.css'\nexport const A = () => [${classes.map((c) => `styles.${c}`).join(', ')}]\n`,
    })
  const missing = (root) => undefinedClasses(root).map((u) => u.name).sort()

  it.each([
    ['a global function', ':global(.gone) { color: red; }'],
    ['a global function after a local class', '.live :global(.gone) { color: red; }'],
    ['a global function holding a list', ':global(.other, .gone) { color: red; }'],
    ['a nested paren in a global function', ':global(.other:not(.gone)) { color: red; }'],
    ['a switch to global', ':global .gone { color: red; }'],
    ['a switch to global after a local class', '.live :global .other .gone { color: red; }'],
    ['a global block', ':global { .gone { color: red; } }'],
    ['a block nested in a global block', ':global { @media (min-width: 1px) { .gone { color: red; } } }'],
    ['an unquoted attribute value', '[href$=.gone] { color: red; }'],
  ])('does not export a class from %s', (_what, css) => {
    expect(missing(reading(css, 'gone'))).toEqual(['gone'])
  })

  it.each([
    ['a local function', ':local(.target) { color: red; }'],
    ['a local function in a global switch', ':global .other :local(.target) { color: red; }'],
    ['a local switch', ':global .other :local .target { color: red; }'],
    ['a selector after a comma ends a global switch', ':global .other, .target { color: red; }'],
    ['a class beside a global function', ':global(.other) .target { color: red; }'],
    ['a local block in a global block', ':global { :local { .target { color: red; } } }'],
    ['a rule after a global block', ':global { .other { color: red; } }\n.target { color: red; }'],
    ['a pseudo-class list', ':is(.other, .target) { color: red; }'],
    ['nesting', '.other { &.target { color: red; } }'],
    ['an escaped name', '.target\\:x, .target { color: red; }'],
    ['an :export key', ':export { target: 1px; }'],
    ['an @value', '@value target: 1px;'],
  ])('exports what stands in %s', (_what, css) => {
    expect(missing(reading(css, 'target'))).toEqual([])
  })

  it('reads an escaped class under its unescaped name', () => {
    const root = fixture({
      'src/A.module.css': '.a\\:b { color: red; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => styles['a:b']\n",
    })
    expect(missing(root)).toEqual([])
    expect(names(root)).toEqual([])
  })

  it('does not call a global class dead, because no read could ever reach it', () => {
    const root = fixture({ 'src/A.module.css': ':global(.page) { color: red; }\n:global .also { color: red; }\n', 'src/A.tsx': 'export {}\n' })
    expect(names(root)).toEqual([])
  })

  it('calls a local class dead wherever in a selector it stands', () => {
    const root = fixture({
      'src/A.module.css': '.live.orphan { color: red; }\n:is(.alsoOrphan) { color: red; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => styles.live\n",
    })
    expect(deadClasses(root).dead.map((d) => [d.name, d.line])).toEqual([
      ['alsoOrphan', 2],
      ['orphan', 1],
    ])
  })
})
