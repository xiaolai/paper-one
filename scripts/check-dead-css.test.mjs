import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { deadClasses, main, scanSources, undefinedClasses, unfollowedStylesheets } from './check-dead-css.mjs'

/* Held from before the import above runs the module to just after it: a guard that ran the
   module as a program on import would call `process.exit` there, and vitest makes that an
   error of the whole file, with no test failing. Recorded instead, a test can say so. */
const importing = vi.hoisted(() => {
  const exits = []
  const exit = process.exit
  process.exit = (code) => {
    exits.push(code)
  }
  return { exits, restore: () => (process.exit = exit) }
})
importing.restore()

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
/* One synchronous delete of every fixture tree: 3 s for the whole file alone, past
   the hook's default 10 s during a full `test:coverage` on a loaded machine. */
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}, 60_000)

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

/*
 * FIRST IN THE FILE, ON PURPOSE. One stylesheet is one origin, whichever import
 * reached it: two imports of it held by one binding are one stylesheet, refused once.
 * Were each import its own origin, what a binding holds would grow every pass and
 * the walk would never settle; this row fails before any row that would hang.
 */
describe('one stylesheet, however many imports reach it', () => {
  it('is one origin, refused once', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/A.tsx': "import a from './A.module.css'\nimport b from './A.module.css'\nexport const f = (x: boolean, k: string) => { const s = x ? a : b; return s[k] }\n",
    })
    expect(unfollowedStylesheets(root).map((one) => one.how)).toEqual(['a key this cannot read: name the class'])
  })
})

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

  it('points at an escaped class by what its name means', () => {
    /* `.a\:b` declares `a:b`. Searching the text for `.a:b` finds nothing, and
       the report said line 0, a line no file has. */
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n.a\\:b { color: blue; }\n.\\31 x { color: blue; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => styles.live\n",
    })
    expect(deadClasses(root).dead.map((d) => [d.name, d.line])).toEqual([
      ['1x', 3],
      ['a:b', 2],
    ])
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

  /* A `from` read only when something followed it on the same line: a rule
     closed on the next line kept a class called `.from` alive, and the path, and
     an `@value` import, whose path is gone by the time it is read, declared only
     its first name. */
  it.each([
    ['a cross-file composes closed on the next line', ".a { color: red;\n  composes: b from './B.module.css'\n}\n.from { color: red; }", ['from'], 2],
    ['a composes with no space after its colon', '.a { composes:b c; }\n.b { color: red; }\n.c { color: red; }', [], 3],
    ['a composes list', '.a { composes: b, c; }\n.b { color: red; }\n.c { color: red; }', [], 3],
  ])('reads %s', (_what, css, dead, used) => {
    const root = fixture({
      'src/A.module.css': `${css}\n`,
      'src/B.module.css': '.b { color: red; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const A = () => styles.a\n",
    })
    expect(deadClasses(root).dead.map((d) => d.name)).toEqual(dead)
    expect(deadClasses(root).used).toBe(used)
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
    expect(run.stdout).toMatch(/check-dead-css: [1-9]\d* modules, [1-9]\d* classes used, 0 unreachable, 0 undefined, 0 unfollowed/)
    expect(run.status).toBe(0)
  })

  /* The guard, in-process: a child runs the file from disk, so only these see a change to
     it. Whether this file is the one node started is `isProcessEntry`'s to say, and has its
     own tests; here it is told. */
  afterEach(() => {
    vi.doUnmock('./lib/entry.mjs')
    vi.restoreAllMocks()
    vi.resetModules()
  })
  const load = async (entry) => {
    vi.doMock('./lib/entry.mjs', () => ({ isProcessEntry: () => entry }))
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.resetModules()
    await import('./check-dead-css.mjs')
    return { exit, printed: write.mock.calls.map(([text]) => text).join('') }
  }

  it('runs, and exits with what it found, when node starts this file', async () => {
    const { exit, printed } = await load(true)
    expect(exit.mock.calls).toEqual([[0]])
    expect(printed).toMatch(/^check-dead-css: [1-9]\d* modules, [1-9]\d* classes used, 0 unreachable, 0 undefined, 0 unfollowed\n$/)
  })

  it('did not exit when this file imported it', () => {
    expect(importing.exits).toEqual([])
  })

  it('neither prints nor exits when imported', async () => {
    const { exit, printed } = await load(false)
    expect(exit).not.toHaveBeenCalled()
    expect(printed).toBe('')
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

  /* It ends, though the two aliases feed each other, and the read goes against both. */
  it('settles on a binding reassigned between stylesheets, and reads it against each', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/B.module.css': '.other { color: red; }\n',
      'src/A.tsx': "import a from './A.module.css'\nimport b from './B.module.css'\nlet s = a\ns = b\nlet t = s\ns = t\nexport const f = () => [s.live, b.other]\n",
    })
    expect(missing(root)).toEqual(['live'])
    expect(names(root)).toEqual([])
  })

  it('reads a conditional between stylesheets against each, since nothing says which ran', () => {
    const root = fixture({
      'src/A.module.css': '.both { color: red; }\n.onlyA { color: red; }\n',
      'src/B.module.css': '.both { color: red; }\n',
      'src/A.tsx': "import a from './A.module.css'\nimport b from './B.module.css'\nexport const f = (x: boolean) => {\n  const s = x ? a : b\n  return [s.both, s.onlyA]\n}\n",
    })
    expect(missing(root)).toEqual(['onlyA'])
    expect(names(root)).toEqual([])
  })

  it('reads a namespace import through default as the stylesheet it is', () => {
    const root = over("import * as css from './A.module.css'\nexport const f = () => [css.default.live, css.default.gone]")
    expect(missing(root)).toEqual(['gone'])
    expect(names(root)).toEqual([])
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
    ['a conditional alias', `${IMPORT}export const f = (x: boolean, y: any) => { const s = x ? styles : y; return s.gone }`],
    ['a fallback alias', `${IMPORT}export const f = (y: any) => { const s = y ?? styles; return s.gone }`],
    ['a fallback assignment', `${IMPORT}export const f = (y: any) => { let s = y; s ??= styles; return s.gone }`],
    ['an awaited alias', `${IMPORT}export const f = async () => { const s = await styles; return s.gone }`],
    ['an element of an array', `${IMPORT}const all = [styles]\nexport const f = () => all[0].gone`],
    ['an element at an index nobody can read', `${IMPORT}const all = [styles]\nexport const f = (i: number) => all[i].gone`],
    ['an array pattern', `${IMPORT}const [s] = [styles]\nexport const f = () => s.gone`],
    ['an array pattern over a named array', `${IMPORT}const all = [styles]\nconst [s] = all\nexport const f = () => s.gone`],
    ['an array assignment pattern', `${IMPORT}export const f = () => { let s: any; [s] = [styles]; return s.gone }`],
    ['the rest of an array pattern', `${IMPORT}const [...all] = [styles]\nexport const f = () => all[0].gone`],
    ['a loop over an array', `${IMPORT}export const f = () => { for (const s of [styles]) return s.gone }`],
    ['a loop over a named array', `${IMPORT}const all = [styles]\nexport const f = () => { for (const s of all) return s.gone }`],
    ['a loop assigning a name', `${IMPORT}export const f = () => { let s: any; for (s of [styles]) return s.gone }`],
    ['a callback of an array method', `${IMPORT}export const f = () => [styles].map((s) => s.gone)`],
    ['a callback named in the file', `${IMPORT}const read = (s: any) => s.gone\nexport const f = () => [styles].map(read)`],
    ['a spread array', `${IMPORT}const all = [styles]\nconst more = [...all]\nexport const f = () => more[0].gone`],
    ['a slice of an array', `${IMPORT}const all = [styles]\nexport const f = () => all.slice(0)[0].gone`],
    ['a key of an object', `${IMPORT}const o = { s: styles }\nexport const f = () => o.s.gone`],
    ['a shorthand key of an object', `${IMPORT}const s = styles\nconst o = { s }\nexport const f = () => o.s.gone`],
    ['a literal lookup on an object', `${IMPORT}const o = { s: styles }\nexport const f = () => o['s'].gone`],
    ['a key of an object in an object', `${IMPORT}const o = { a: { s: styles } }\nexport const f = () => o.a.s.gone`],
    ['a spread into an object', `${IMPORT}const o = { ...styles }\nexport const f = () => o.gone`],
    ['a pattern over an object', `${IMPORT}const o = { s: styles }\nconst { s } = o\nexport const f = () => s.gone`],
    ['what an arrow returns', `${IMPORT}const get = () => styles\nexport const f = () => get().gone`],
    ['what a function returns', `${IMPORT}function get() { return styles }\nexport const f = () => get().gone`],
    ['what a function returns of what it was handed', `${IMPORT}const id = (s: any) => s\nexport const f = () => id(styles).gone`],
    ['an argument of a function in the file', `${IMPORT}const read = (s: any) => s.gone\nexport const f = () => read(styles)`],
    ['an argument of a function declared later', `${IMPORT}export const f = () => read(styles)\nfunction read(s: any) { return s.gone }`],
    ['a rest parameter', `${IMPORT}const read = (...all: any[]) => all[0].gone\nexport const f = () => read(styles)`],
    ['a namespace pattern', "import * as css from './A.module.css'\nconst { default: s } = css\nexport const f = () => s.gone"],
    ['a dynamic import', "export const f = async () => (await import('./A.module.css')).default.gone"],
    ['a dynamic import, destructured', "export const f = async () => { const { default: s } = await import('./A.module.css'); return s.gone }"],
    ['a dynamic import, then', "export const f = () => import('./A.module.css').then((m) => m.default.gone)"],
    ['a dynamic import of a joined constant', "const at = './A.module' + '.css'\nexport const f = async () => (await import(at)).default.gone"],
    ['a dynamic import, read as a namespace', "export const f = async () => (await import('./A.module.css')).gone"],
    ['a require', "export const f = () => require('./A.module.css').default.gone"],
    ['a reflective read', `${IMPORT}export const f = () => Reflect.get(styles, 'gone')`],
    ['an own-key test', `${IMPORT}export const f = () => Object.hasOwn(styles, 'gone')`],
    ['a reflective test', `${IMPORT}export const f = () => Reflect.has(styles, 'gone')`],
    ['a descriptor', `${IMPORT}export const f = () => Object.getOwnPropertyDescriptor(styles, 'gone')`],
    ['a reflective descriptor', `${IMPORT}export const f = () => Reflect.getOwnPropertyDescriptor(styles, 'gone')`],
    ['an inherited own-key test', `${IMPORT}export const f = () => Object.hasOwnProperty(styles, 'gone')`],
    ['an in test', `${IMPORT}export const f = () => 'gone' in styles`],
    ['a constant key', `${IMPORT}const k = 'gone'\nexport const f = () => styles[k]`],
    ['a joined key', `${IMPORT}export const f = () => styles['go' + 'ne']`],
    ['a template key over a constant', `${IMPORT}const k = 'go'\nexport const f = () => styles[\`\${k}ne\`]`],
    ['a key of a constant object', `${IMPORT}const K = { a: 'gone' }\nexport const f = () => styles[K.a]`],
    ['a key from a list', `${IMPORT}export const f = () => { for (const k of ['gone']) return styles[k] }`],
    ['a constant key in a pattern', `${IMPORT}const k = 'gone'\nconst { [k]: g } = styles\nexport const f = () => g`],
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
 * A STYLESHEET CROSSES A FILE as well as a binding. Each row reaches the class from
 * `src/use.tsx` through `src/re.ts`, which the gate can see the other side of.
 */
describe('a stylesheet that crosses a file', () => {
  const crossing = (re, use, extra = {}) =>
    fixture({ 'src/A.module.css': '.target { color: red; }\n', 'src/re.ts': `${re}\n`, 'src/use.tsx': `${use}\n`, ...extra })
  const IMPORT = "import styles from './A.module.css'\n"

  it.each([
    ['a re-export of the default', "export { default as s } from './A.module.css'", "import { s } from './re'\nexport const f = () => s.NAME"],
    ['a re-export as the default', "export { default } from './A.module.css'", "import s from './re'\nexport const f = () => s.NAME"],
    ['a re-exported namespace', "export * as css from './A.module.css'", "import { css } from './re'\nexport const f = () => css.default.NAME"],
    ['an exported binding, by list', `${IMPORT}export { styles }`, "import { styles as s } from './re'\nexport const f = () => s.NAME"],
    ['an exported binding, renamed', `${IMPORT}export { styles as s }`, "import { s } from './re'\nexport const f = () => s.NAME"],
    ['an exported alias', `${IMPORT}export const s = styles`, "import { s } from './re'\nexport const f = () => s.NAME"],
    ['a default export', `${IMPORT}export default styles`, "import s from './re'\nexport const f = () => s.NAME"],
    ['a default export of a conditional', `${IMPORT}export default (globalThis as any).x ?? styles`, "import s from './re'\nexport const f = () => s.NAME"],
    ['an exported function that returns one', `${IMPORT}export const get = () => styles`, "import { get } from './re'\nexport const f = () => get().NAME"],
    ['an exported declaration that returns one', `${IMPORT}export function get() { return styles }`, "import { get } from './re'\nexport const f = () => get().NAME"],
    ['a default function that returns one', `${IMPORT}export default function get() { return styles }`, "import get from './re'\nexport const f = () => get().NAME"],
    ['a namespace of a source', `${IMPORT}export const s = styles`, "import * as re from './re'\nexport const f = () => re.s.NAME"],
    ['a pattern over a namespace of a source', `${IMPORT}export const s = styles`, "import * as re from './re'\nconst { s } = re\nexport const f = () => s.NAME"],
    ['a function off a namespace of a source', `${IMPORT}export const get = () => styles`, "import * as re from './re'\nexport const f = () => re.get().NAME"],
    ['a dynamic import of a source', `${IMPORT}export const s = styles`, "export const f = async () => (await import('./re')).s.NAME"],
    ['a read in the file handed it', "export const read = (s: any) => s.NAME", `import styles from './A.module.css'\nimport { read } from './re'\nexport const f = () => read(styles)`],
    ['a read in a function declaration handed it', "export function read(s: any) { return s.NAME }", `import styles from './A.module.css'\nimport { read } from './re'\nexport const f = () => read(styles)`],
    ['a read in a rest parameter handed it', "export const read = (...all: any[]) => all[0].NAME", `import styles from './A.module.css'\nimport { read } from './re'\nexport const f = () => read(styles)`],
    ['a function off a namespace handed it', "export const read = (s: any) => s.NAME", `import styles from './A.module.css'\nimport * as re from './re'\nexport const f = () => re.read(styles)`],
    ['what comes back from the file it was handed to', 'export const id = (s: any) => s', `import styles from './A.module.css'\nimport { id } from './re'\nexport const f = () => id(styles).NAME`],
  ])('follows %s', (_what, re, use) => {
    const named = (name) => crossing(re.replace('NAME', name), use.replace('NAME', name))
    expect(names(named('target'))).toEqual([])
    expect(undefinedClasses(named('gone')).map((u) => u.name)).toEqual(['gone'])
    expect(names(named('gone'))).toEqual(['target'])
    expect(unfollowedStylesheets(named('target'))).toEqual([])
  })

  it.each([
    ['a re-export of a re-export', "export { s } from './re'"],
    ['a renaming re-export of a re-export', "export { s as t, s } from './re'"],
    ['a re-export of everything', "export * from './re'"],
  ])('follows %s, a round later', (_what, middle) => {
    const root = crossing("export { default as s } from './A.module.css'", "import { s } from './middle'\nexport const f = () => s.gone", { 'src/middle.ts': `${middle}\n` })
    expect(undefinedClasses(root).map((u) => u.name)).toEqual(['gone'])
  })

  it('reads a class named in a re-export of the stylesheet', () => {
    const root = crossing("export { target, gone } from './A.module.css'", 'export {}')
    expect(undefinedClasses(root).map((u) => u.name)).toEqual(['gone'])
    expect(names(root)).toEqual([])
  })

  it('takes everything in a stylesheet re-exported whole as read', () => {
    expect(names(crossing("export * from './A.module.css'", 'export {}'))).toEqual([])
  })

  it('takes no default through a re-export of everything, as the language does not', () => {
    const root = crossing("export { default } from './A.module.css'", "import s from './middle'\nexport const f = () => s.target", { 'src/middle.ts': "export * from './re'\n" })
    expect(names(root)).toEqual(['target'])
  })

  it('reads a function handed a stylesheet against that stylesheet only', () => {
    const root = fixture({
      'src/A.module.css': '.target { color: red; }\n',
      'src/B.module.css': '.other { color: red; }\n',
      'src/re.ts': 'export const read = (s: any) => s.target\n',
      'src/use.tsx': "import a from './A.module.css'\nimport b from './B.module.css'\nimport { read } from './re'\nexport const f = () => [read(a), b.other]\n",
    })
    expect(undefinedClasses(root)).toEqual([])
    expect(names(root)).toEqual([])
  })
})

describe('a stylesheet read whole', () => {
  it.each([
    ['Object.keys', 'export const f = () => Object.keys(styles)'],
    ['Object.values', 'export const f = () => Object.values(styles)'],
    ['Object.entries', 'export const f = () => Object.entries(styles)'],
    ['Object.getOwnPropertyNames', 'export const f = () => Object.getOwnPropertyNames(styles)'],
    ['Object.getOwnPropertyDescriptors', 'export const f = () => Object.getOwnPropertyDescriptors(styles)'],
    ['Reflect.ownKeys', 'export const f = () => Reflect.ownKeys(styles)'],
    ['a loop over its keys', 'export const f = () => { for (const k in styles) return k }'],
    ['an alias', 'const s = styles\nexport const f = () => Object.keys(s)'],
  ])('keeps every class alive through %s', (_what, line) => {
    const root = fixture({ 'src/A.module.css': '.one { color: red; }\n.two { color: red; }\n', 'src/A.tsx': `import styles from './A.module.css'\n${line}\n` })
    expect(names(root)).toEqual([])
    expect(unfollowedStylesheets(root)).toEqual([])
  })

  it('keeps alive only the stylesheet it read', () => {
    const root = fixture({
      'src/A.module.css': '.one { color: red; }\n',
      'src/B.module.css': '.other { color: red; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const f = () => Object.keys(styles)\n",
    })
    expect(names(root)).toEqual(['other'])
  })
})

/*
 * WHAT CANNOT BE FOLLOWED IS REFUSED, BY FILE AND LINE. Reporting nothing here is the
 * failure this gate exists to stop: a class read that way could be missing, or be all
 * that keeps a rule alive, and a clean run would say neither.
 */
describe('what the gate refuses to guess at', () => {
  const IMPORT = "import styles from './A.module.css'\nimport { g } from 'somewhere'\n"
  const refused = (source, extra = {}) =>
    unfollowedStylesheets(fixture({ 'src/A.module.css': '.live { color: red; }\n', 'src/A.tsx': `${source}\n`, ...extra }))

  it.each([
    ['a computed key', `${IMPORT}export const f = (k: string) => styles[k]`, 'a key this cannot read: name the class'],
    ['a key that is only partly known', `${IMPORT}export const f = (k: string) => styles[\`a\${k}\`]`, 'a key this cannot read: name the class'],
    ['one branch of a key that cannot be read', `${IMPORT}export const f = (k: string, x: boolean) => styles[x ? 'live' : k]`, 'a key this cannot read: name the class'],
    ['a computed pattern key', `${IMPORT}export const f = (k: string) => { const { [k]: v } = styles; return v }`, 'a key this cannot read: name the class'],
    ['a computed read of what was handed in', 'export const f = (styles: any, k: string) => styles[k]', 'a key this cannot read: name the class'],
    ['a call nothing here can see into', `${IMPORT}export const f = () => g(styles)`, 'handed to a call'],
    ['a constructor', `${IMPORT}export const f = () => new (g as any)(styles)`, 'handed to a call'],
    ['a call on an alias', `${IMPORT}const s = styles\nexport const f = () => g(s)`, 'handed to a call'],
    ['a prop under another name', `${IMPORT}export const F = (X: any) => <X s={styles} />`, 'handed as a prop'],
    ['a spread into props', `${IMPORT}export const F = (X: any) => <X {...styles} />`, 'spread into props'],
    ['a spread into a call', `${IMPORT}const all = [styles]\nexport const f = () => g(...all)`, 'handed on in an array or object'],
    ['a member assigned', `${IMPORT}export const f = (o: any) => { o.s = styles }`, 'assigned to a member'],
    ['a class member', `${IMPORT}export class C { s = styles }`, 'used'],
    ['a method returning one', `${IMPORT}export class C { get() { return styles } }`, 'returned'],
    ['an object method returning one', `${IMPORT}export const o = { get() { return styles } }`, 'returned'],
    ['a callback returning one', `${IMPORT}export const f = () => g(() => styles)`, 'returned'],
    ['an anonymous default function returning one', `${IMPORT}export default () => styles`, 'returned'],
    ['a function that returns one, handed on', `${IMPORT}const get = () => styles\nexport const f = () => g(get)`, 'a function that returns it, handed on'],
    ['a function that returns one, renamed', `${IMPORT}const get = () => styles\nconst other = get\nexport const f = () => other().live`, 'a function that returns it, handed on'],
    ['an array returned', `${IMPORT}export const f = () => [styles]`, 'held by an array'],
    ['an object returned', `${IMPORT}export const f = () => ({ s: styles })`, 'held by an object'],
    ['an object handed to a call', `${IMPORT}export const f = () => g({ s: styles })`, 'held by an object'],
    ['an object exported', `${IMPORT}export const o = { s: styles }`, 'held by an object'],
    ['an array exported', `${IMPORT}export const all = [styles]`, 'held by an array'],
    ['a name holding an object, handed on', `${IMPORT}const o = { s: styles }\nexport const f = () => g(o)`, 'handed on in an array or object'],
    ['a name holding an array, handed on', `${IMPORT}const all = [styles]\nexport const f = () => g(all)`, 'handed on in an array or object'],
    ['a name holding an object, returned', `${IMPORT}const o = { s: styles }\nexport const f = () => o`, 'handed on in an array or object'],
    ['a name holding an array, exported by list', `${IMPORT}const all = [styles]\nexport { all }`, 'exported in an array or object'],
    ['a key nobody can read holding one', `${IMPORT}export const f = (k: string) => { const o = { [k]: styles }; return o[k] }`, 'held under a key this cannot read'],
    ['an object read by a key nobody can read', `${IMPORT}const o = { s: styles }\nexport const f = (k: string) => o[k]`, 'read by a key this cannot read'],
    ['an array handed to a hook of somebody else', `${IMPORT}export const f = () => (g as any)(() => 1, [styles])`, 'held by an array'],
    ['a stylesheet written into a string', `${IMPORT}export const f = () => \`\${styles}\``, 'written into a string'],
    ['a stylesheet chosen at run time', 'export const f = (x: string) => import(`./${x}.module.css`)', 'a stylesheet chosen at run time'],
    ['every key of one handed in', 'export const f = (styles: any) => Object.keys(styles)', 'every key of a stylesheet handed in, whose module is not known'],
  ])('refuses %s', (_what, source, how) => {
    expect(refused(source).map((one) => one.how)).toContain(how)
  })

  it('refuses a module of a source read by a key nobody can read, when that module holds one', () => {
    const found = refused("import * as re from './re'\nexport const f = (k: string) => re[k]", { 'src/re.ts': "export { default as s } from './A.module.css'\n" })
    expect(found.map((one) => one.how)).toEqual(['a module read by a key this cannot read'])
  })

  it('refuses a function taken off a module without being called', () => {
    const found = refused("import * as re from './re'\nexport const f = () => { const { get } = re; return get().live }", { 'src/re.ts': "import styles from './A.module.css'\nexport const get = () => styles\n" })
    expect(found.map((one) => one.how)).toEqual(['a function that returns it, handed on'])
  })

  /* Only `ns.fn()`, called where it is read, is followed; these reach the same function
     and are not. */
  it.each([
    ['by a literal key', "import * as re from './re'\nexport const f = () => re['get']().live", "re['get']"],
    ['by name, and called later', "import * as re from './re'\nconst g = re.get\nexport const f = () => g().live", 're.get'],
  ])('refuses a function taken off a module %s', (_what, source, what) => {
    expect(refused(source, { 'src/re.ts': "import styles from './A.module.css'\nexport const get = () => styles\n" })).toEqual([
      { file: 'src/A.tsx', line: 2, what, how: 'a function that returns it, handed on' },
    ])
  })

  it('quotes what it refuses on one line, cut at sixty characters', () => {
    expect(refused(`${IMPORT}export const f = (k: string) => styles[k +\n  'a-suffix-long-enough-to-run-well-past-the-sixty-character-cut']`)).toEqual([
      { file: 'src/A.tsx', line: 3, what: "styles[k + 'a-suffix-long-enough-to-run-well-past-the-sixty-", how: 'a key this cannot read: name the class' },
    ])
  })

  it('names the file and the line', () => {
    expect(refused(`${IMPORT}export const a = 1\nexport const f = () => g(styles)`)).toEqual([
      { file: 'src/A.tsx', line: 4, what: 'styles', how: 'handed to a call' },
    ])
  })

  it.each([
    ['a stylesheet handed on as styles, in JSX', `${IMPORT}export const F = (X: any) => <X styles={styles} />`],
    ['a stylesheet handed on as styles, in an object', `${IMPORT}export const f = () => g({ styles })`],
    ['a stylesheet in a named array', `${IMPORT}const all = [styles]\nexport const f = () => all[0].live`],
    ['a local of that name made from something else', "import { g } from 'somewhere'\nexport const f = (el: any, k: string) => { const styles = g(el); g(styles); return [styles[k], Object.keys(styles)] }"],
    ['a function that returns one, called', `${IMPORT}const get = () => styles\nexport const f = () => get().live`],
    ['a test of whether it is there', `${IMPORT}export const f = () => (styles ? 1 : 2)`],
    ['a comparison', `${IMPORT}export const f = (x: any) => styles === x`],
    ['a named object holding it as styles, handed on', `${IMPORT}const o = { styles }\nexport const f = () => g(o)`],
    ['a stylesheet as a default in a pattern', `${IMPORT}export const f = (o: any) => { let s: any; ({ s = styles } = o); return s.live }`],
    ['a dependency list', `${IMPORT}import { useMemo } from 'react'\nexport const f = () => useMemo(() => styles.live, [styles])`],
    ['a dependency list, by namespace', `${IMPORT}import * as React from 'react'\nexport const f = () => React.useEffect(() => {}, [styles])`],
    ['a layout effect\'s dependency list', `${IMPORT}export const f = (h: any) => useLayoutEffect(h, [styles])`],
    ['an insertion effect\'s dependency list', `${IMPORT}export const f = (h: any) => useInsertionEffect(h, [styles])`],
    ['a callback\'s dependency list', `${IMPORT}export const f = (h: any) => useCallback(h, [styles])`],
    ['an imperative handle\'s dependency list, which comes third', `${IMPORT}export const f = (r: any, h: any) => useImperativeHandle(r, h, [styles])`],
  ])('does not refuse %s', (_what, source) => {
    expect(refused(source)).toEqual([])
  })

  it('fails the command, with the place named', () => {
    const root = fixture({ 'src/A.module.css': '.live { color: red; }\n', 'src/A.tsx': `${IMPORT}export const a = styles.live\nexport const f = () => g(styles)\n` })
    expect(unfollowedStylesheets(root)).toHaveLength(1)
  })
})

/*
 * WHAT `lib/holders.mjs` FOLLOWS HAS TWO SIDES, and each row here is the far side of
 * one of its forms: the near neighbour that must not be taken for it, or the same
 * form asked for exactly what it says and nothing more. `toContain` cannot tell a
 * right refusal from a right refusal with a wrong one beside it, so each row states
 * the whole answer: what is missing, what stays dead, and every refusal.
 */
describe('the whole answer for each form a holder takes', () => {
  const IMPORT = "import styles from './A.module.css'\nimport { g } from 'somewhere'\n"
  const KEY = 'a key this cannot read: name the class'
  const OBJECT = 'held by an object'
  const ARRAY = 'held by an array'
  const HANDED_ON = 'handed on in an array or object'
  const TO_A_CALL = 'handed to a call'

  const answer = (source) => {
    const root = fixture({ 'src/A.module.css': '.unread { color: red; }\n', 'src/A.tsx': `${source}\n` })
    const scanned = scanSources(root)
    return {
      missing: undefinedClasses(root, undefined, scanned).map((u) => u.name).sort(),
      dead: deadClasses(root, undefined, scanned).dead.map((d) => d.name).sort(),
      refused: unfollowedStylesheets(root, undefined, scanned).map((one) => one.how).sort(),
    }
  }
  const expectAnswer = (source, expected) => expect(answer(source)).toEqual({ missing: [], dead: ['unread'], refused: [], ...expected })

  /* A key is read only when it can be nothing else. */
  it.each([
    ['a let, which can change', `${IMPORT}let k = 'gone'\nexport const f = () => styles[k]`, { refused: [KEY] }],
    ['two strings joined by anything but a plus', `${IMPORT}export const f = () => styles['go' - 'ne']`, { refused: [KEY] }],
    ['an unknown on the left of a join', `${IMPORT}export const f = (k: string) => styles[k + 'gone']`, { refused: [KEY] }],
    ['an unknown on the right of a join', `${IMPORT}export const f = (k: string) => styles['gone' + k]`, { refused: [KEY] }],
    ['a name nothing declares', `${IMPORT}export const f = () => styles[nowhere]`, { refused: [KEY] }],
    ['a constant defined by itself', `${IMPORT}const k: any = k\nexport const f = () => styles[k]`, { refused: [KEY] }],
    ['the member asked for, not the first', `${IMPORT}const K = { a: 'unread', b: 'gone' }\nexport const f = () => styles[K.b]`, { missing: ['gone'] }],
    ['a member a constant object does not have', `${IMPORT}const K = { a: 'gone' }\nexport const f = () => styles[K.b]`, { refused: [KEY] }],
    ['a member reaching a loop variable, which is not the variable', "function f(styles: any) { return styles[globalThis.k] }\nfor (var k of ['unread']) { f(k) }", { refused: [KEY] }],
  ])('a key from %s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* A pattern takes keys out of a value, and an object beside one is only a value. */
  it.each([
    ['a sum is no target', `${IMPORT}let a: any\n;[a + 1] = [styles]\nexport const f = () => a.gone`, {}],
    ['a parenthesised pattern is one', 'export const f = (p: any) => { let s: any; ({ styles: s }) = p; return s.unread }', { dead: [] }],
    ['an object assigned from is a value', 'export const f = () => { let a: any; let o: any; o = { styles: a }; return [o, a.unread] }', {}],
    ['an object added to is a value', 'export const f = () => { let a: any; ({ styles: a } + 1); return a.unread }', {}],
    ['a loop over a pattern takes from each', 'export const f = (p: any) => { let s: any; for ({ styles: s } of p) return s.unread }', { dead: [] }],
    ['an object looped over is a value', `${IMPORT}export const f = () => { let a: any; for (const x of { styles: a }) g(x); return a.unread }`, {}],
    ['a pattern in an array pattern is one', 'export const f = (p: any) => { let s: any; [{ styles: s }] = p; return s.unread }', { dead: [] }],
    ['an object in an object is a value', 'export const f = () => { let a: any; const o = { k: { styles: a } }; return [o, a.unread] }', {}],
    ['a pattern over a named object', `${IMPORT}const o = { s: styles }\nexport const f = () => { let s: any; ({ s } = o); return s.gone }`, { missing: ['gone'] }],
    ['a renaming pattern over a named object', `${IMPORT}const o = { s: styles }\nexport const f = () => { let t: any; ({ s: t } = o); return t.gone }`, { missing: ['gone'] }],
    ['the rest of a pattern over a named object holds no key', `${IMPORT}const o = { r: styles }\nexport const f = () => { let r: any; ({ ...r } = o); return r.gone }`, {}],
    ['a rest binding named like a key is not that key', `${IMPORT}const o = { rest: styles, s: 1 }\nconst { ...rest } = o\nexport const f = () => rest.gone`, {}],
    ['the rest of an array pattern assigned', `${IMPORT}export const f = () => { let r: any; [...r] = [styles]; return r[0].gone }`, { missing: ['gone'] }],
  ])('%s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* A method keeps the elements, or calls back with one, only if it is on the list. */
  it.each(['filter', 'concat', 'reverse', 'sort', 'toSorted', 'toReversed'])('`%s` keeps the elements it was called on', (method) => {
    expectAnswer(`${IMPORT}const all = [styles]\nexport const f = () => all.${method}()[0].gone`, { missing: ['gone'] })
  })
  it.each(['flatMap', 'forEach', 'filter', 'find', 'findLast', 'some', 'every', 'sort', 'toSorted'])('`%s` calls back with an element', (method) => {
    expectAnswer(`${IMPORT}const all = [styles]\nexport const f = () => all.${method}((s: any) => s.gone)`, { missing: ['gone'] })
  })
  it('a method of no known shape calls back with nothing', () => {
    expectAnswer(`${IMPORT}const all = [styles]\nexport const f = () => all.other((s: any) => s.gone)`, {})
  })
  it.each(['catch', 'finally'])('`.%s` on an `import()` waits for the module, and reads nothing', (method) => {
    expectAnswer(`${IMPORT}export const f = () => import('./A.module.css').${method}(g)`, {})
  })

  /* An array can be reached through whatever an array can be chosen by. */
  it.each([
    ['a conditional', `${IMPORT}export const f = (x: boolean) => { const all = x ? [styles] : []; return all[0].gone }`],
    ['a fallback', `${IMPORT}export const f = (x: any) => { const all = x ?? [styles]; return all[0].gone }`],
    ['an await', `${IMPORT}export const f = async () => { const all = await [styles]; return all[0].gone }`],
  ])('an array chosen by %s is read, and held by no name while it is chosen', (_what, source) => {
    expectAnswer(source, { missing: ['gone'], refused: [ARRAY] })
  })

  /* What a name nothing declares is assigned is held by no symbol, so by no other such name. */
  it.each([
    ['a value', `${IMPORT}nowhere = styles\nexport const f = () => other.gone`],
    ['an array', `${IMPORT}nowhere = [styles]\nexport const f = () => other[0].gone`],
  ])('%s assigned to an undeclared name reaches no other undeclared name', (_what, source) => {
    expectAnswer(source, {})
  })

  /* AN ALIAS CAN BE WRITTEN ABOVE WHAT IT COPIES, and what it copies can be settled last
     in a round, so each of these needs the round after the one that settled it. */
  it.each([
    ['a key of an object', `${IMPORT}const p = (x: any) => { const o = { s: x }; const t = o.s; return t.gone }\nexport const f = () => p(styles)`],
    ['a key under the root\'s own name, which no name binds', `${IMPORT}const p = (x: any) => { const o = { styles: x }; const t = o.styles; return t.gone }\nexport const f = () => p(styles)`],
    ['an element of an array', `${IMPORT}const p = (x: any) => { let list: any[] = []; const t = list[0]; list = [x]; return t.gone }\nexport const f = () => p(styles)`],
    ['what a function returns', `${IMPORT}const p = (x: any) => { const get = () => x; const t = get(); return t.gone }\nexport const f = () => p(styles)`],
  ])('another round follows %s settled late', (_what, source) => {
    expectAnswer(source, { missing: ['gone'] })
  })

  /* A member with the name of a holder holds nothing unless it is that holder. */
  it.each([
    ['a member of an object that holds none, under a key another does', `${IMPORT}const other = { s: 1 as any }\nconst o = { s: styles }\nexport const f = () => [other.s.gone, o.s.unread]`, { dead: [] }],
    ['a key nobody can read, of a type that names it', `${IMPORT}declare const k: 'a'\nconst a = styles\nconst o = { [k]: styles }\nexport const f = () => o.a.gone`, { refused: ['held under a key this cannot read'] }],
    ['a member of a namespace, which is the binding', `${IMPORT}namespace N { export const s = styles }\nexport const f = () => N.s.gone`, { missing: ['gone'] }],
  ])('%s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* What a function's parameters are handed. */
  it.each([
    ['a rest parameter takes from its own place on', `${IMPORT}const read = (a: any, ...rest: any[]) => rest[0].gone\nexport const f = () => read(styles, 1)`, {}],
    ['a parameter takes the elements of an array', `${IMPORT}const read = (all: any[]) => all[0].gone\nexport const f = () => read([styles])`, { missing: ['gone'], refused: [ARRAY] }],
  ])('%s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* A function bound to a name can be called. Any other, what it returns has left. */
  it.each([
    ['a return with no function round it', `${IMPORT}return styles`, { refused: ['returned'] }],
    ['a default function with no name', `${IMPORT}export default function () { return styles }`, { refused: ['returned'] }],
    ['an arrow under a key', `${IMPORT}export const o = { get: () => styles }`, { refused: ['returned'] }],
    ['a parenthesised arrow, which is still bound', `${IMPORT}const get = (() => styles)\nexport const f = () => get().gone`, { missing: ['gone'] }],
    ['a member of a function that returns one', `${IMPORT}const get = () => styles\nexport const f = () => get.call(null).gone`, { refused: ['a function that returns it, handed on'] }],
    ['a cast of one, called', `${IMPORT}const get = () => styles\nexport const f = () => (get as any)().gone`, { missing: ['gone'] }],
  ])('%s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* A name is what a thing is called, and a use is where a value goes. */
  it.each([
    ['a method called what being handed one looks like', `${IMPORT}export const o = { styles() { return 1 } }`, {}],
    ['a key taken from a namespace by a pattern', `${IMPORT}namespace N { export const get = () => styles }\nconst { get: h } = N\nexport const f = () => h`, {}],
    ['a shorthand key, which is a read of the name', `${IMPORT}const s = styles\nexport const f = () => g({ s })`, { refused: [OBJECT] }],
  ])('%s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* Which part of an expression the value stands in decides whether it goes on. */
  it.each([
    ['a key', `${IMPORT}export const f = (o: any) => o[styles]`, {}],
    ['a condition', `${IMPORT}export const f = () => g(styles ? 1 : 2)`, {}],
    ['a branch', `${IMPORT}export const f = (x: boolean) => g(x ? styles : 1)`, { refused: [TO_A_CALL] }],
    ['a fallback', `${IMPORT}export const f = (y: any) => g(y ?? styles)`, { refused: [TO_A_CALL] }],
    ['the last of a comma', `${IMPORT}export const f = () => g((1, styles))`, { refused: [TO_A_CALL] }],
    ['the first of a comma', `${IMPORT}export const f = () => g((styles, 1))`, {}],
    ['the left of an assignment to a member', `${IMPORT}const o = { s: styles }\nexport const f = () => { o.s = 1 }`, {}],
    ['a pattern assigned to', `${IMPORT}let s = styles\n;({ a: s } = g)`, {}],
    ['a spread into a call', `${IMPORT}export const f = () => g(...styles)`, { refused: ['spread into a call'] }],
    ['a spread into an object', `${IMPORT}export const f = () => g({ ...styles })`, { refused: ['spread into an object'] }],
    ['a spread into an array, returned', `${IMPORT}export const f = () => [...styles]`, { refused: ['spread into an array'] }],
    ['a spread into a named array', `${IMPORT}const all = [...styles]\nexport const f = () => all[0].gone`, {}],
    ['the callee', `${IMPORT}export const f = () => styles()`, {}],
  ])('a stylesheet as %s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })
  it.each([
    ['if', 'if (styles) g()'],
    ['while', 'while (styles) g()'],
    ['a negation', '!styles'],
    ['typeof', 'typeof styles'],
    ['a statement', 'styles'],
    ['delete', 'delete styles'],
    ['void', 'void styles'],
  ])('a stylesheet under %s goes nowhere', (_what, statement) => {
    expectAnswer(`${IMPORT}export const f = () => { ${statement} }`, {})
  })

  /* A container held by a name is followed. Anywhere else, what is in it has left. */
  it.each([
    ['the right of a fallback', `${IMPORT}export const f = (x: any) => x ?? [styles]`, { refused: [ARRAY] }],
    ['assigned to a member', `${IMPORT}export const f = (x: any) => { x.y = [styles] }`, { refused: [ARRAY] }],
    ['the left of a logical assignment', `${IMPORT}export const f = () => { [styles] ||= g }`, { refused: [ARRAY] }],
    ['looped over', `${IMPORT}export const f = () => { for (const s of [styles]) return s.gone }`, { missing: ['gone'] }],
    ['called', `${IMPORT}export const f = () => ([styles] as any)()`, { refused: [ARRAY] }],
    ['a key', `${IMPORT}export const f = (o: any) => o[[styles]]`, { refused: [ARRAY] }],
    ['in an object bound under a key nobody can read', `${IMPORT}export const f = (k: string) => { const o = { [k]: { s: styles } }; return 1 }`, { refused: [OBJECT] }],
    ['parenthesised, bound to a name, handed on', `${IMPORT}const o = ({ s: styles })\nexport const f = () => g(o)`, { refused: [HANDED_ON] }],
    ['in an object bound to a name, handed on', `${IMPORT}const o = { a: { s: styles } }\nexport const f = () => g(o)`, { refused: [HANDED_ON] }],
    ['spread into an object bound to a name, handed on', `${IMPORT}const o = { ...{ s: styles } }\nexport const f = () => g(o)`, { refused: [HANDED_ON, OBJECT] }],
    ['handed to a call, beside a name nothing declares', `${IMPORT}g({ s: styles })\nexport const f = () => nowhere`, { refused: [OBJECT] }],
    ['taken apart by a pattern, beside a name nothing declares', `${IMPORT}const { a } = { s: styles }\nexport const f = () => nowhere`, {}],
  ])('a container %s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* What becomes of the name holding one. */
  it.each([
    ['a key', `${IMPORT}const o = { s: styles }\nexport const f = (x: any) => x[o]`, { refused: [HANDED_ON] }],
    ['the target of a loop, which is written', `${IMPORT}let x = [styles]\nexport const f = () => { for (x of g) g() }`, {}],
    ['the target of an array pattern, which is written', `${IMPORT}let x = [styles]\nexport const f = () => { [x] = g }`, {}],
    ['the rest of an array pattern, which is written', `${IMPORT}let x = [styles]\nexport const f = () => { [...x] = g }`, {}],
    ['a value of an object pattern, which is written', `${IMPORT}let x = [styles]\nexport const f = () => { ({ a: x } = g) }`, {}],
    ['a shorthand of an object pattern, which is written', `${IMPORT}let x = [styles]\nexport const f = () => { ({ x } = g) }`, {}],
    ['the rest of an object pattern, which is written', `${IMPORT}let x = [styles]\nexport const f = () => { ({ ...x } = g) }`, {}],
    ['an element of an array, which is read', `${IMPORT}const x = [styles]\nexport const f = () => [x]`, { refused: [HANDED_ON] }],
    ['a term of a sum in an array pattern, which is read', `${IMPORT}const x = [styles]\nexport const f = () => { [x + 1] = g }`, { refused: [HANDED_ON] }],
    ['a member of a namespace, which is only a name', `${IMPORT}namespace N { export const all = [styles] }\nexport const f = () => N.all[0].gone`, { refused: [ARRAY] }],
    ['a value of an object, which is read', `${IMPORT}const x = [styles]\nexport const f = () => ({ a: x })`, { refused: [HANDED_ON] }],
    ['a shorthand of an object, which is read', `${IMPORT}const x = [styles]\nexport const f = () => ({ x })`, { refused: [HANDED_ON] }],
    ['spread into an object, which is read', `${IMPORT}const x = [styles]\nexport const f = () => ({ ...x })`, { refused: [HANDED_ON] }],
    ['the value of an export', `${IMPORT}const o = { s: styles }\nexport const p = o`, { refused: ['exported in an array or object'] }],
    ['assigned to a name', `${IMPORT}const all = [styles]\nexport const f = () => { let t: any; t = all; return 1 }`, {}],
    ['assigned to a member', `${IMPORT}const all = [styles]\nexport const f = (x: any) => { x.y = all }`, { refused: ['assigned to a member'] }],
    ['spread into a named array', `${IMPORT}const all = [styles]\nconst more = [...all]\nexport const f = () => more[0].gone`, { missing: ['gone'] }],
    ['spread into an array handed on', `${IMPORT}const all = [styles]\nexport const f = () => g([...all])`, { refused: ['spread into an array'] }],
    ['asked for its keys by Reflect', `${IMPORT}const o = { s: styles }\nexport const f = () => Reflect.ownKeys(o)`, {}],
    ['handed to a method of Object that reads no key', `${IMPORT}const o = { s: styles }\nexport const f = () => Object.freeze(o)`, { refused: [HANDED_ON] }],
  ])('a name holding a container as %s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* Only a call is known to reach a function in this file, and only the two reflections read. */
  it.each([
    ['a constructor in the file', `${IMPORT}const F = function (s: any) { }\nexport const f = () => new F(styles)`, { refused: [TO_A_CALL] }],
    ['a method of Object that reads no key', `${IMPORT}export const f = () => Object.freeze(styles)`, { refused: [TO_A_CALL] }],
    ['a method like a reflection, on something else', `${IMPORT}export const f = (x: any) => x.keys(styles)`, { refused: [TO_A_CALL] }],
    ['a reflective read with no key', `${IMPORT}export const f = () => Reflect.get(styles)`, {}],
    ['a reflection with nothing to read', `${IMPORT}export const f = () => Object.keys()`, {}],
  ])('handed to %s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* A local called what being handed one looks like is quiet only when it is made from something else. */
  it.each([
    ['a member of a namespace, which is no local', `${IMPORT}namespace N { export const styles = {} as any }\nexport const f = (k: string) => N.styles[k]`, { refused: [KEY] }],
    ['a local holding the import', "import a from './A.module.css'\nconst styles = a\nexport const f = (k: string) => styles[k]", { refused: [KEY] }],
    ['a local with nothing in it yet', 'export const f = (k: string) => { let styles: any; return styles[k] }', { refused: [KEY] }],
    ['a local read by a key that can be read', "import { g } from 'somewhere'\nconst styles = g(1)\nexport const f = () => styles['unread']", { dead: [] }],
  ])('a computed read of %s', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  /* A way through is not a read of the key it goes through. */
  it.each([
    ['`default`, by a literal', "import * as css from './A.module.css'\nexport const f = () => css['default'].gone", { missing: ['gone'] }],
    ['its own name', `${IMPORT}export const f = () => styles.styles.unread`, { dead: [] }],
  ])('%s is no class', (_what, source, expected) => {
    expectAnswer(source, expected)
  })

  it('a re-export of a name is said once, where the name holds it', () => {
    expectAnswer(`${IMPORT}export const all = [styles]\nexport { all as b } from './A'`, { refused: [ARRAY] })
  })
})

/*
 * WHAT A MODULE EXPORTS IS NOT EVERY DOT IN ITS SELECTORS. `:global` hands a class
 * to the page: the import holds no such key, so a read of it is `undefined`.
 */
/*
 * Each row is one turn of the walk across files that the forms above take for
 * granted: a name that is not exported, a module that is not a source, a call with
 * nothing to hand, a round that learns only a little more than the last.
 */
describe('what crosses a file, at the edges', () => {
  const IMPORT = "import styles from './A.module.css'\n"
  const answer = (files) => {
    const root = fixture({ 'src/A.module.css': '.live { color: red; }\n', ...files })
    const scanned = scanSources(root)
    return {
      missing: undefinedClasses(root, undefined, scanned).map((u) => u.name).sort(),
      dead: deadClasses(root, undefined, scanned).dead.map((d) => d.name).sort(),
      refused: unfollowedStylesheets(root, undefined, scanned).map((one) => one.how).sort(),
    }
  }
  const expectAnswer = (files, expected) => expect(answer(files)).toEqual({ missing: [], dead: ['live'], refused: [], ...expected })
  const HANDED = 'handed to a call'
  const RETURNS = 'a function that returns it, handed on'
  const RUN_TIME = 'a stylesheet chosen at run time'

  it('carries nothing a file does not export', () => {
    expectAnswer({
      'src/B.tsx': `${IMPORT}const s = styles\nfunction g() { return styles }\nexport const k = 1\n`,
      'src/C.tsx': "import { s, g } from './B'\nexport const f = () => [s.gone, g().gone]\n",
    }, {})
  })

  it('does not take a bare specifier for a file beside it', () => {
    expectAnswer({
      'src/B.tsx': `${IMPORT}export const s = styles\n`,
      'src/C.tsx': "import { s } from 'B'\nexport const f = () => s.gone\n",
    }, {})
  })

  it.each([
    ['a path with its extension', 'src/B.tsx', './B.tsx'],
    ['a .ts file', 'src/B.ts', './B'],
    ['a .tsx file', 'src/B.tsx', './B'],
    ['a directory with index.ts', 'src/lib/index.ts', './lib'],
    ['a directory with index.tsx', 'src/ui/index.tsx', './ui'],
  ])('resolves %s', (_what, at, specifier) => {
    const depth = at.split('/').length - 2
    const sheet = depth === 0 ? './A.module.css' : '../A.module.css'
    expectAnswer({
      [at]: `import styles from '${sheet}'\nexport const s = styles\n`,
      'src/C.tsx': `import { s } from '${specifier}'\nexport const f = () => s.gone\n`,
    }, { missing: ['gone'] })
  })

  it.each([
    ['an exported class', 'export class Paint {}', "import { Paint } from './R'\n", 'Paint(styles)', { refused: [HANDED] }],
    ['an exported let with no value', 'export let read: any', "import { read } from './R'\n", 'read(styles)', { refused: [HANDED] }],
    ['an exported constant that is no function', 'export const read: any = 1', "import { read } from './R'\n", 'read(styles)', { refused: [HANDED] }],
    ['a default function with a name', 'export default function paint(s: any) { return s.live }', "import paint from './R'\n", 'paint(styles)', { dead: [] }],
    ['a function of no parameters', 'export const read = () => 1', "import { read } from './R'\n", 'read(styles)', {}],
    ['a parameter beyond the last', 'export const read = (a: any) => a.live', "import { read } from './R'\n", 'read(1, styles)', {}],
    ['the first of a parameter and a rest', 'export const read = (a: any, ...rest: any[]) => a.live', "import { read } from './R'\n", 'read(styles)', { dead: [] }],
    ['a rest after a parameter', 'export const read = (a: any, ...rest: any[]) => rest[0].live', "import { read } from './R'\n", 'read(1, styles)', { dead: [] }],
    ['a function taken by a key', 'export const read = (s: any) => s.live', "import * as re from './R'\n", "re['read'](styles)", { refused: [HANDED] }],
  ])('hands a stylesheet to %s', (_what, callee, imported, call, expected) => {
    expectAnswer({ 'src/R.tsx': `${callee}\n`, 'src/C.tsx': `${IMPORT}${imported}export const f = () => ${call}\n` }, expected)
  })

  it('takes nothing from a file whose exports hold nothing, even when it is read', () => {
    expect(answer({
      'src/X.module.css': '.x { color: red; }\n',
      'src/B.tsx': 'export default 1\nexport const k = 1\nexport function g() { return 1 }\n',
      'src/C.tsx': "import d, { k, g } from './B'\nexport const f = () => [d.x, k.x, g().x]\n",
    })).toEqual({ missing: [], dead: ['live', 'x'], refused: [] })
  })

  it('carries every holder a file exports', () => {
    expectAnswer({
      'src/O.module.css': '.other { color: red; }\n',
      'src/B.tsx': `${IMPORT}import other from './O.module.css'\nexport const s = styles\nexport const t = other\n`,
      'src/C.tsx': "import { s, t } from './B'\nexport const f = () => [s.live, t.other, s.gone, t.lost]\n",
    }, { missing: ['gone', 'lost'], dead: [] })
  })

  it('reads a name two re-exports of everything both carry against both', () => {
    const root = fixture({
      'src/A.module.css': '.a { color: red; }\n',
      'src/B.module.css': '.b { color: red; }\n',
      'src/ra.ts': "export { default as s } from './A.module.css'\n",
      'src/rb.ts': "export { default as s } from './B.module.css'\n",
      'src/mid.ts': "export * from './ra'\nexport * from './rb'\n",
      'src/use.tsx': "import { s } from './mid'\nexport const f = () => [s.a, s.b]\n",
    })
    expect(undefinedClasses(root).map((u) => `${u.file} ${u.name}`).sort()).toEqual(['src/use.tsx a', 'src/use.tsx b'])
    expect(names(root)).toEqual([])
  })

  /* Each row learns something in its second round that leaves every name where it
     was and only a set larger, so a walk that stopped on names alone reads too little. */
  it.each([
    ['an export that grows under the same name', {
      'src/C.ts': "export { default as t } from './A.module.css'\n",
      'src/B.ts': "import { t } from './C'\nimport other from './O.module.css'\nexport const s = (globalThis as any).c ? t : other\n",
      'src/use.tsx': "import { s } from './B'\nexport const f = () => Object.keys(s)\n",
    }],
    ['a call that hands one only once its import is known', {
      'src/C.ts': "export { default as s } from './A.module.css'\n",
      'src/R.ts': 'export const read = (x: any) => Object.keys(x)\n',
      'src/B.ts': "import { s } from './C'\nimport { read } from './R'\nimport other from './O.module.css'\nexport const f = () => [read(s), Object.keys(other)]\n",
    }],
    ['what a call hands growing under the same parameter', {
      'src/C.ts': "export { default as s } from './A.module.css'\n",
      'src/R.ts': 'export const read = (x: any) => Object.keys(x)\n',
      'src/B.ts': "import other from './O.module.css'\nimport { read } from './R'\nexport const f = () => read(other)\n",
      'src/D.ts': "import { s } from './C'\nimport { read } from './R'\nexport const f = () => read(s)\n",
    }],
  ])('keeps walking while %s', (_what, files) => {
    expect(answer({ 'src/O.module.css': '.o { color: red; }\n', ...files })).toEqual({ missing: [], dead: [], refused: [] })
  })

  it('names a refused read on one line, however many it spans', () => {
    const root = fixture({ 'src/A.module.css': '.live { color: red; }\n', 'src/A.tsx': `${IMPORT}export const f = (k: string) => styles[\n    k\n  ]\n` })
    expect(unfollowedStylesheets(root).map((one) => one.what)).toEqual(['styles[ k ]'])
  })

  it.each([
    ['a name a file does not export', { 'src/B.ts': "export { default } from './A.module.css'\n", 'src/C.tsx': "import { k } from './B'\nexport const f = () => k.live\n" }, {}],
    ['a call of a name a module does not export', { 'src/B.tsx': `${IMPORT}export const s = styles\n`, 'src/C.tsx': "import * as ns from './B'\nexport const f = () => ns.unknown().live\n" }, {}],
    ['a name a module does not export', { 'src/B.tsx': `${IMPORT}export const get = () => styles\n`, 'src/C.tsx': "import * as re from './B'\nexport const f = () => re.nothing.live\n" }, {}],
    ['a require with nothing to load', { 'src/C.tsx': 'export const f = () => require().live\n' }, {}],
    ['a call that only looks like a load', { 'src/C.tsx': "declare const load: any\nexport const f = () => load('./A.module.css').default.live\n" }, {}],
    ['a require of a name', { 'src/C.tsx': 'export const f = (name: string) => require(name).live\n' }, {}],
    ['a require of a file that exports nothing', { 'src/B.ts': 'export const k = 1\n', 'src/C.tsx': "export const f = () => require('./B').live\n" }, {}],
    ['a require of a file that exports one', { 'src/B.tsx': `${IMPORT}export const s = styles\n`, 'src/C.tsx': "export const f = () => require('./B').s.live\n" }, { dead: [] }],
    ['a module of a file that exports none, read by any key', { 'src/B.ts': 'export const k = 1\n', 'src/C.tsx': `${IMPORT}import * as ns from './B'\nexport const f = (k: string) => [ns[k], styles.live]\n` }, { dead: [] }],
    ['a stylesheet required by a template', { 'src/C.tsx': 'export const f = (x: string) => require(`./${x}.module.css`)\n' }, { refused: [RUN_TIME] }],
    ['a stylesheet imported by a template', { 'src/C.tsx': 'export const f = (x: string) => import(`./${x}.module.css`)\n' }, { refused: [RUN_TIME] }],
    ['a run-time name passed to anything but a load', { 'src/C.tsx': "declare const load: any\nexport const f = (x: string) => load(x + '.module.css')\n" }, {}],
    ['a run-time load that names no stylesheet', { 'src/C.tsx': 'export const f = (x: string) => require(x + `.module`)\n' }, {}],
    ['a function that returns one, handed on', { 'src/B.tsx': `${IMPORT}export const get = () => styles\n`, 'src/C.tsx': "import * as re from './B'\ndeclare const g: any\nexport const f = () => g(re.get)\n" }, { refused: [RETURNS] }],
    ['a function that returns one, bound to a name', { 'src/B.tsx': `${IMPORT}export const get = () => styles\n`, 'src/C.tsx': "import * as re from './B'\nexport const h = re.get\n" }, { refused: [RETURNS] }],
  ])('reads %s', (_what, files, expected) => {
    expectAnswer(files, expected)
  })

  it.each([
    ['a default bound to a function first', { 'src/B.tsx': `${IMPORT}const get = () => styles\nexport default get\n`, 'src/C.tsx': "import get from './B'\nexport const f = () => get().gone\n" }],
    ['a function re-exported with everything', { 'src/B.tsx': `${IMPORT}export const get = () => styles\n`, 'src/M.ts': "export * from './B'\n", 'src/C.tsx': "import { get } from './M'\nexport const f = () => get().gone\n" }],
    ['a function re-exported by name', { 'src/B.tsx': `${IMPORT}export const get = () => styles\n`, 'src/M.ts': "export { get } from './B'\n", 'src/C.tsx': "import { get } from './M'\nexport const f = () => get().gone\n" }],
    ['a module of a source re-exported under a name', { 'src/B.tsx': `${IMPORT}export const s = styles\n`, 'src/M.ts': "export * as ns from './B'\n", 'src/C.tsx': "import { ns } from './M'\nexport const f = () => ns.s.gone\n" }],
  ])('follows %s', (_what, files) => {
    expectAnswer(files, { missing: ['gone'] })
  })

  /* A module of a source is held only when the source exports one, so where it
     goes, a stylesheet goes too, and what is read of it there is not known. */
  it.each([
    ['handed to a call', "declare const g: any\nexport const f = () => g(re)", HANDED],
    ['read for every value', 'export const f = () => Object.values(re)', 'every member of a module that holds one'],
    ['walked key by key', 'export const f = () => { for (const k in re) g(k) }\ndeclare const g: any', 'every member of a module that holds one'],
  ])('refuses a module of a source %s', (_what, use, how) => {
    expectAnswer({ 'src/B.tsx': `${IMPORT}export const s = styles\n`, 'src/C.tsx': `import * as re from './B'\n${use}\n` }, { refused: [how] })
  })

  /* Before this, a name bound by a pattern was not exported at all, and a class read
     through it on the other side was silently not read. */
  it.each([
    ['a pattern over a module of a source', "import * as re from './R'\nexport const { s } = re", 'export const s = styles', []],
    ['a renaming pattern over a namespace', "import * as css from './A.module.css'\nexport const { default: s } = css", '', []],
    ['a pattern over a module loaded at run time', "export const { default: s } = await import('./A.module.css')", '', []],
    ['a name after another in a pattern', "import * as re from './R'\nexport const { k, s } = re", 'export const s = styles\nexport const k = 1', []],
    ['a pattern nested in a pattern', "import * as re from './R'\nexport const { t: { s } } = { t: re }", 'export const s = styles', ['held by an object']],
    ['an array pattern', "import styles from './A.module.css'\nexport const [s] = [styles]", '', ['held by an array']],
    ['an array pattern after a hole', "import styles from './A.module.css'\nexport const [, s] = [1, styles]", '', ['held by an array']],
  ])('carries a stylesheet exported by %s', (_what, exporting, r, refused) => {
    expectAnswer({
      'src/R.tsx': `${IMPORT}${r}\n`,
      'src/B.tsx': `${exporting}\n`,
      'src/C.tsx': "import { s } from './B'\nexport const f = () => s.gone\n",
    }, { missing: ['gone'], refused })
  })

  it('re-exports no module of a source that exports nothing', () => {
    expectAnswer({
      'src/B.ts': 'export const k = 1\n',
      'src/M.ts': "export * as ns from './B'\n",
      'src/C.tsx': `${IMPORT}import { ns } from './M'\nexport const f = (k: string) => [ns[k], styles.live]\n`,
    }, { dead: [] })
  })
})

/*
 * MOST FILES ARE NOT WALKED, and that is half the gate's time: a file is walked only
 * when it mentions a stylesheet or is handed one. Each row says which.
 */
describe('which files are walked', () => {
  const walkedIn = (files, file) => {
    const root = fixture({ 'src/A.module.css': '.live { color: red; }\n', ...files })
    return scanSources(root).get(join(root, file)).walked
  }

  it.each([
    ['a file that mentions none', 'export const k = 1', false],
    ['a file that says styles', '// styles\nexport {}', true],
    ['a file that names a module', '// a.module\nexport {}', true],
    ['a file that imports at run time', '// import(\nexport {}', true],
    ['a file that requires', '// require(\nexport {}', true],
    ['a file that says xmodule', '// xmodule\nexport {}', false],
    ['a file that says reimport(', '// reimport(\nexport {}', false],
    ['a file that says unrequire(', '// unrequire(\nexport {}', false],
  ])('walks %s: %s', (_what, text, expected) => {
    expect(walkedIn({ 'src/C.ts': `${text}\n` }, 'src/C.ts')).toBe(expected)
  })

  it('walks a file that imports one from another source and mentions none', () => {
    expect(walkedIn({ 'src/B.tsx': "import styles from './A.module.css'\nexport const s = styles\n", 'src/C.ts': "import { s } from './B'\nexport const f = () => s\n" }, 'src/C.ts')).toBe(true)
  })

  it('walks a file handed one into a rest parameter, that mentions none', () => {
    expect(walkedIn({
      'src/B.tsx': "import styles from './A.module.css'\nimport { read } from './R'\nexport const f = () => read(styles)\n",
      'src/R.ts': 'export const read = (...all: any[]) => all\n',
    }, 'src/R.ts')).toBe(true)
  })
})

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

/*
 * WHAT A STYLESHEET'S TEXT DECLARES, read as the gate reads it: prose first gone,
 * then the blocks walked. Each row is a near neighbour of a rule, so a looser
 * reading shows as a class declared that is not, or a key lost that is there.
 */
describe('what a stylesheet declares, at the edges', () => {
  const declared = (css) => names(fixture({ 'src/A.module.css': `${css}\n`, 'src/A.tsx': 'export {}\n' }))
  const keyed = (css, ...keys) =>
    undefinedClasses(
      fixture({
        'src/A.module.css': `${css}\n`,
        'src/A.tsx': `import styles from './A.module.css'\nexport const A = () => [${keys.map((k) => `styles.${k}`).join(', ')}]\n`,
      }),
    ).map((u) => u.name)

  it.each([
    ['a string in double quotes', 'a::before { content: ".fake{"; }\n.real {}', ['real']],
    ['an escaped double quote in a string', 'a::before { content: "\\" .fake{ \\""; }\n.real {}', ['real']],
    ['an escaped space in a string', 'a::before { content: "\\ .fake{"; }\n.real {}', ['real']],
    ['a string in single quotes', "a::before { content: '.fake{'; }\n.real {}", ['real']],
    ['an escaped single quote in a string', "a::before { content: '\\' .fake{ \\''; }\n.real {}", ['real']],
    ['an escaped space in a single-quoted string', "a::before { content: '\\ .fake{'; }\n.real {}", ['real']],
    ['an unquoted url', 'a { background: url(x.fake{); }\n.real {}', ['real']],
    ['an unquoted url after a space', 'a { background: url( x.fake{); }\n.real {}', ['real']],
    ['a comment before the block', '.a/* note */ { color: red; }', ['a']],
    ['an escaped digit and a space', '.\\31 a { color: red; }', ['1a']],
    ['an escaped digit', '.\\31x { color: red; }', ['1x']],
    ['an escaped colon', '.\\:a { color: red; }', [':a']],
    ['an escaped digit and a space, inside', '.a\\31 b { color: red; }', ['a1b']],
    ['an escaped digit, inside', '.a\\31x { color: red; }', ['a1x']],
    ['an escaped bracket in a global function', ':global(.x\\) .y) { color: red; }', []],
    ['a nested bracket in a global function', ':global(:not(.a) .b) { color: red; }', []],
    ['a global switch after a local class', '.a :global .b { color: red; }', ['a']],
    ['a local function inside a global switch', ':global .x :local(.y,) .z { color: red; }', ['y']],
    ['a list inside a global switch', ':global .x:not(.y, .z) .w { color: red; }', []],
    ['a number after a class', '.a, .5 { color: red; }', ['a']],
    ['an escaped dot in an id', '#id\\.fake .a { color: red; }', ['a']],
    ['a rule inside @supports selector()', '@supports selector(.fake) { .real { color: red; } }', ['real']],
    ['a keyframe at a fraction', '@keyframes k { 12.5% { opacity: 0; } }\n.real {}', ['real']],
    ['two global rules in a global block', ':global { .x { color: red; } .y {} }\n.z {}', ['z']],
    ['a stray closing brace', '}\n.a { color: red; }', ['a']],
    ['a kept class and one only partly kept', '._kept { color: red; }\n.kept_on { color: red; }', ['kept_on']],
    ['a list ended by a comma inside a global switch', ':global :not(.x,) .y { color: red; }', []],
  ])('reads %s', (_what, css, dead) => {
    expect(declared(css)).toEqual(dead)
  })

  it.each([
    ['an @value with two spaces', '@value  a: 1px;', ['a'], []],
    ['an @value that is part of a declaration', '.r { --v: x @value b; }', ['b'], ['b']],
    ['@value names taken from a file', "@value a , b, c as d from './x.css';", ['a', 'b', 'c', 'd'], ['c']],
    ['@value after a rule', '.r { color: red; }\n@value v: 1px;', ['v'], []],
    ['a declaration in a rule', '.a { color: red; }', ['a', 'color'], ['color']],
    ['an :import of a file', ':import(./colors.css) { x: y; }', ['css', 'x'], ['css', 'x']],
    ['two :export keys', ':export { a: 1; b: 2; }', ['a', 'b'], []],
    ['an :export line with no value', ':export { lonely; shown: 1; }', ['lonely', 'shown'], ['lonely']],
    ['an :export key spaced from its colon', ':export { gap : 4px; }', ['gap'], []],
    ['an @value after a declaration with no colon', '.r { x @value y; }', ['e', 'y'], ['e', 'y']],
  ])('keys %s', (_what, css, read, missing) => {
    expect(keyed(css, ...read)).toEqual(missing)
  })

  it('counts lines through a comment that spans them', () => {
    const root = fixture({ 'src/A.module.css': '/* one\ntwo .orphan */\n.orphan { color: red; }\n', 'src/A.tsx': 'export {}\n' })
    expect(deadClasses(root).dead).toEqual([{ file: 'src/A.module.css', name: 'orphan', line: 3 }])
  })
})

describe('where the gate looks', () => {
  it('reads only under the roots it is given, and a root that is not there is no error', () => {
    const root = fixture({ 'src/A.module.css': '.orphan { color: red; }\n', 'other/X.module.css': '.elsewhere { color: red; }\n', 'src/A.tsx': 'export {}\n' })
    expect(names(root)).toEqual(['orphan'])
    expect(deadClasses(root, ['other', 'absent']).dead.map((d) => d.name)).toEqual(['elsewhere'])
    expect(deadClasses(root, ['absent'])).toEqual({ dead: [], modules: 0, used: 0 })
  })

  it('names a missing class once for each file that reads it', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/B.module.css': '.live { color: red; }\n',
      'src/A.tsx': "import a from './A.module.css'\nimport b from './B.module.css'\nexport const f = () => [a.gone, b.gone, a.lost, a.live, b.live]\n",
      'src/B.tsx': "import a from './A.module.css'\nexport const f = () => a.gone\n",
    })
    expect(undefinedClasses(root)).toEqual([
      { file: 'src/A.tsx', name: 'gone' },
      { file: 'src/A.tsx', name: 'lost' },
      { file: 'src/B.tsx', name: 'gone' },
    ])
  })

  it('takes a stylesheet nothing declares as declaring nothing', () => {
    const root = fixture({ 'src/A.tsx': "import styles from './Gone.module.css'\nexport const f = () => [styles.gone, Object.keys(styles)]\n" })
    expect(undefinedClasses(root)).toEqual([{ file: 'src/A.tsx', name: 'gone' }])
    expect(deadClasses(root)).toEqual({ dead: [], modules: 0, used: 1 })
  })

  it('reads every stylesheet however deep, and takes no link and no directory for one', () => {
    const root = fixture({
      'src/A.module.css': '.live { color: red; }\n',
      'src/A.tsx': "import styles from './A.module.css'\nexport const f = () => styles.live\n",
      'src/deep/er/B.module.css': '.deep { color: red; }\n',
      'src/Dir.module.css/inner.ts': 'export {}\n',
    })
    symlinkSync(join(root, 'src/A.module.css'), join(root, 'src/Link.module.css'))
    expect(deadClasses(root)).toEqual({ dead: [{ file: 'src/deep/er/B.module.css', name: 'deep', line: 1 }], modules: 2, used: 1 })
  })
})

describe('what the command prints, and how it exits', () => {
  const run = (files) => {
    const written = []
    const code = main({ root: fixture(files), stdout: { write: (text) => written.push(text) } })
    return { code, text: written.join('') }
  }
  const SHEET = '.live { color: red; }\n'
  const READ = "import styles from './A.module.css'\nimport { g } from 'somewhere'\n"
  const DEAD =
    '\nAn unreachable rule is shipped CSS that can never apply. Delete it, or\n' +
    'rename it with a leading `_` if it is kept deliberately — the exemption\n' +
    'belongs at the rule, where the next reader of this file will see it.\n'
  const MISSING = '\nA class no stylesheet declares reads as undefined and styles nothing, without\nan error. Restore the rule, or stop naming the class.\n'
  const UNFOLLOWED =
    '\nA stylesheet this cannot follow answers neither question above: a class read\n' +
    'that way could be missing, or be all that keeps a rule alive. Read the classes\n' +
    'by name, or hand the stylesheet on as `styles`, where its reader is seen.\n'

  it('exits 0 on a clean tree, and says what it looked at', () => {
    expect(run({ 'src/A.module.css': SHEET, 'src/A.tsx': `${READ}export const f = () => styles.live\n` })).toEqual({
      code: 0,
      text: 'check-dead-css: 1 modules, 1 classes used, 0 unreachable, 0 undefined, 0 unfollowed\n',
    })
  })

  it('exits 1 on an unreachable rule alone', () => {
    expect(run({ 'src/A.module.css': SHEET, 'src/A.tsx': 'export {}\n' })).toEqual({
      code: 1,
      text: 'src/A.module.css:1  .live — no source names `styles.live`\ncheck-dead-css: 1 modules, 0 classes used, 1 unreachable, 0 undefined, 0 unfollowed\n' + DEAD,
    })
  })

  it('exits 1 on a missing class alone', () => {
    expect(run({ 'src/A.module.css': SHEET, 'src/A.tsx': `${READ}export const f = () => [styles.live, styles.gone]\n` })).toEqual({
      code: 1,
      text: 'check-dead-css: 1 modules, 2 classes used, 0 unreachable, 1 undefined, 0 unfollowed\nsrc/A.tsx  .gone — named here, declared by no rule in the module it imports\n' + MISSING,
    })
  })

  it('exits 1 on a stylesheet it cannot follow alone', () => {
    expect(run({ 'src/A.module.css': SHEET, 'src/A.tsx': `${READ}export const f = () => [styles.live, g(styles)]\n` })).toEqual({
      code: 1,
      text: 'check-dead-css: 1 modules, 1 classes used, 0 unreachable, 0 undefined, 1 unfollowed\nsrc/A.tsx:3  styles — handed to a call\n' + UNFOLLOWED,
    })
  })

  it('reads this repository when given no root', () => {
    const written = []
    expect(main({ stdout: { write: (text) => written.push(text) } })).toBe(0)
    expect(written.join('')).toMatch(/^check-dead-css: [1-9]\d* modules, [1-9]\d* classes used, 0 unreachable, 0 undefined, 0 unfollowed\n$/)
  })
})
