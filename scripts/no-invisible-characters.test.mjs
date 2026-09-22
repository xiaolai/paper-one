import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * No character that renders as nothing may be written RAW in source.
 *
 * ⚠️ **A SOFT HYPHEN WRITTEN AS ITSELF LOOKS LIKE AN EMPTY STRING.** `sentenceOf.ts`
 * held `const SOFT_HYPHEN = '<U+00AD>'` for months, and in review and in every diff
 * it read as `''` — so deleting it, replacing it, or pasting a different invisible
 * character in its place would not have shown. A sweep found the same in four
 * more production files (`reanchor.ts`, `markContext.ts`, `rangeText.ts`,
 * `sentenceCorpus.ts`) and a dozen test fixtures, soft hyphens, zero-width joiners
 * and a word joiner among them. Every one is an escape now, which means the same
 * character at run time and can be seen.
 *
 * ⚠️ **AND TWO OF THESE ARE WORSE THAN INVISIBLE.** U+2028 and U+2029 are LINE
 * TERMINATORS in JavaScript, so inside a regex literal they end it mid-pattern —
 * AGENTS.md records the incident, where an agent's backslash-u escape arrived in
 * the file as the raw character and broke three other agents' test runs. Inside a
 * string literal they are legal since ES2019, so the quiet case is a pattern that
 * does not match what its author wrote. That section's own check is a `grep -P`
 * run by hand; this runs in the gate.
 *
 * NOT scanned: `.md` and other prose, where a soft hyphen or a joiner can be text
 * meant for a reader; and anything git does not track.
 */

const INVISIBLE = new Map([
  [0x00ad, 'SOFT HYPHEN'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x2028, 'LINE SEPARATOR'],
  [0x2029, 'PARAGRAPH SEPARATOR'],
  [0x2060, 'WORD JOINER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
])

const SOURCE = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.css'])

/** Every raw invisible character in `text`, as `line:column NAME`. */
export function invisibleIn(text) {
  const found = []
  for (const [lineAt, line] of text.split('\n').entries()) {
    for (const [columnAt, character] of [...line].entries()) {
      const name = INVISIBLE.get(character.codePointAt(0) ?? -1)
      if (name) found.push(`${lineAt + 1}:${columnAt + 1} ${name}`)
    }
  }
  return found
}

/** `verify:without` sets this to the id it cut, and nothing else does. */
const DELETED_ENV = 'PAPER_VERIFY_WITHOUT'

describe('source holds no invisible character written raw', () => {
  /* ⚠️ **NOT INSIDE THE DELETION PROOF'S COPY, WHICH HAS NO `.git`.** `pnpm
     verify:without <id>` copies the tree without it, so `git ls-files` there
     does not answer "nothing" — it THROWS, and the case failed on the macOS leg
     of CI for a tree that was fine. What source a repository tracks is a
     property of the repository, which cutting a capability does not change, and
     the real tree's `pnpm verify` runs this. Only under the proof's own marker
     and only when git itself finds no work tree, so a checkout git cannot read
     anywhere else still fails loudly — `check-build-artifacts.test.mjs` states
     the same rule for the same reason.

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
      invisibleIn(readFileSync(resolve(root, path), 'utf8')).map((where) => `${path}:${where}`),
    )
    expect(offenders, 'write each as its escape — backslash, u, four hex digits').toEqual([])
  })

  /* NON-VACUITY: the scan must be able to see what it is looking for. Built from
     code points, because writing the characters here would be the defect. */
  it('can actually see each one', () => {
    for (const [codePoint, name] of INVISIBLE) {
      expect(invisibleIn(`a${String.fromCodePoint(codePoint)}b`), name).toEqual([`1:2 ${name}`])
    }
    expect(invisibleIn('plain text, and an escape: \\u00ad')).toEqual([])
  })
})
