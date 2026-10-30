import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * This repository has no formatter, and nothing stopped an agent running one.
 *
 * ⚠️ **`npx prettier --write` REWROTE ELEVEN FILES ON 2026-09-26, 2 604 LINES IN
 * ONE TEST FILE ALONE.** There is no prettier, eslint, biome or editorconfig in
 * the tree, no `format` script and no devDependency — the style is hand-kept. So
 * `npx` fetched prettier, applied its DEFAULTS, and converted every string to
 * double quotes, terminated every statement with a semicolon and reflowed to 80
 * columns. None of that was asked for and all of it landed on pre-existing code.
 *
 * ⚠️ **AND IT WAS CAUGHT BY LUCK, WHICH IS WHY THIS FILE EXISTS.**
 * `check-inert-directives` went red — because the reflow moved seven `Stryker
 * disable` comments off the nodes they led — and only then did anyone look at the
 * diff. Nothing was watching for the churn itself. A gate that fails on the
 * fingerprint turns a reflex into a fast failure instead of a review problem.
 *
 * WHAT IS REFUSED, AND WHY EXACTLY THESE TWO
 *
 * A module specifier in double quotes, and an `import`/`export` line terminated
 * by a semicolon. Both are measured at **zero across 808 tracked source files**,
 * which is what makes this a ratchet on an invariant rather than a new policy —
 * and both are what a default-configured formatter produces on the first file it
 * touches. An `import` line also cannot be mistaken for prose, which a bare
 * "no trailing semicolon" rule can: 216 files hold one, every instance of it a
 * sentence inside a comment or a line of shell.
 *
 * NOT refused: semicolons anywhere else, quote style in ordinary strings, or line
 * width. Those need a parser to judge and this needs none — the point is to catch
 * a whole-file reformat at its first line, not to police style by hand.
 */

/**
 * The quote a module statement's specifier uses, or null for a line that is not
 * one.
 *
 * ⚠️ **PROSE BEGINNING WITH THE WORD "import" IS NOT AN IMPORT, AND THE FIRST
 * VERSION OF THIS SAID IT WAS.** `Library.tsx` holds the comment *"import is the
 * reader's own action and lasts seconds to minutes;"* — first word `import`, last
 * character a semicolon — and a rule that read only those two things reported the
 * repository's own clean source as foreign. So what is required is a SPECIFIER: a
 * quote after `from`, or after a bare `import`. English has neither.
 */
function specifierOf(line) {
  if (!/^\s*(?:import|export)\b/.test(line)) return null
  const found = /(?:\bfrom\s+|^\s*import\s+)(['"])/.exec(line)
  return found ? found[1] : null
}

/** The two fingerprints, each with the shape of the mistake it catches. */
const FOREIGN = [
  {
    what: 'a module specifier in double quotes',
    matches: (line) => specifierOf(line) === '"',
  },
  {
    what: 'an import or export terminated by a semicolon',
    matches: (line) => specifierOf(line) !== null && /;\s*$/.test(line),
  },
]

const SOURCE = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js'])

/** Every foreign-formatting line in `text`, as `line:column what`. */
export function foreignIn(text) {
  const found = []
  for (const [lineAt, line] of text.split('\n').entries()) {
    for (const { what, matches } of FOREIGN) {
      if (matches(line)) found.push(`${lineAt + 1} ${what}`)
    }
  }
  return found
}

/** `verify:without` sets this to the id it cut, and nothing else does. */
const DELETED_ENV = 'PAPER_VERIFY_WITHOUT'

describe('no foreign formatter has been run over this tree', () => {
  /* ⚠️ **NOT INSIDE THE DELETION PROOF'S COPY, WHICH HAS NO `.git`.** `pnpm
     verify:without <id>` copies the tree without it, so `git ls-files` there does
     not answer "nothing" — it THROWS. What source a repository tracks is a
     property of the repository, which cutting a capability does not change, and
     the real tree's `pnpm verify` runs this. The same rule and the same reason as
     `no-invisible-characters.test.mjs` and `check-build-artifacts.test.mjs`.

     The case below it is PURE and never skips: the scan's own proof that it can
     see what it looks for runs everywhere, so this skips a walk and never the
     detector. */
  beforeEach((context) => {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    }).stdout.trim()
    if (context.task.name.startsWith('finds none') && process.env[DELETED_ENV] !== undefined && inside !== 'true') {
      context.skip("the deletion proof's copy has no .git, so git cannot say what this repository tracks; the real tree's pnpm verify runs this")
    }
  })

  it('finds none in any tracked source file', () => {
    const root = resolve(import.meta.dirname, '..')
    const tracked = execFileSync('git', ['ls-files', '-z', 'src', 'scripts'], { cwd: root })
      .toString('utf8')
      .split('\0')
      .filter((path) => SOURCE.has(extname(path)))
    /* NON-EMPTY, or a git that answered nothing would pass this for free. */
    expect(tracked.length).toBeGreaterThan(100)

    const offenders = tracked.flatMap((path) =>
      foreignIn(readFileSync(resolve(root, path), 'utf8')).map((where) => `${path}:${where}`),
    )
    expect(
      offenders,
      'this repository has no formatter and its style is hand-kept — do not run one over it',
    ).toEqual([])
  })

  /* NON-VACUITY: the scan must be able to see what it is looking for, and must
     not see what it is not. Both halves matter — a detector that finds nothing
     looks exactly like a clean result, which `check-browser-safe` shipped twice
     before it worked. */
  it('can actually see each fingerprint', () => {
    expect(foreignIn('import { a } from "./a"')).toEqual(['1 a module specifier in double quotes'])
    expect(foreignIn("import { a } from './a';")).toEqual(['1 an import or export terminated by a semicolon'])
    expect(foreignIn('export { a } from "./a";')).toEqual([
      '1 a module specifier in double quotes',
      '1 an import or export terminated by a semicolon',
    ])
    expect(foreignIn('  import type { A } from "./a"')).toEqual(['1 a module specifier in double quotes'])
  })

  it('leaves this repository’s own style alone', () => {
    expect(foreignIn("import { a } from './a'")).toEqual([])
    expect(foreignIn("import type { A } from './a'")).toEqual([])
    expect(foreignIn("export { a } from './a'")).toEqual([])
    /* A double quote INSIDE a single-quoted specifier is this repository's style
       and must not match — the `from` clause is what is read, not the line. */
    expect(foreignIn("import { a } from './say-\"hello\"'")).toEqual([])
    /* And prose is not code. ⚠️ **THIS EXACT LINE IS IN `Library.tsx` AND THE
       FIRST VERSION OF THIS SCAN REPORTED IT** — first word `import`, last
       character a semicolon, and not an import at all. It is the reason the rule
       asks for a specifier rather than for those two things. */
    expect(foreignIn("                import is the reader's own action and lasts seconds to minutes;")).toEqual([])
    expect(foreignIn(' * resolves to per platform; that a legal bundle passes;')).toEqual([])
    expect(foreignIn('      major) next="$((maj + 1)).0.0" ;;')).toEqual([])
    /* A side-effect import is a module statement, and its style is single-quoted. */
    expect(foreignIn("import './register'")).toEqual([])
    expect(foreignIn('import "./register"')).toEqual(['1 a module specifier in double quotes'])
  })
})
