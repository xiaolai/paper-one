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
