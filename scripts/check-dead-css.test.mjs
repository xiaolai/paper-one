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
