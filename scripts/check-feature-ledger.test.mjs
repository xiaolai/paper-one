import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LEDGER, LEDGERS, makeExists, parseArgs, run } from './check-feature-ledger.mjs'

/**
 * The shell around `scripts/lib/ledger.mjs`: how it is invoked, how it asks
 * the filesystem, and what it does with a tree that has no ledger in it.
 *
 * The rules themselves are `lib/ledger.test.mjs`. What is worth asserting here
 * is the part a pure function cannot: that `--root` is honoured (the deletion
 * test runs this over a copy), that a directory answers as well as a file, and
 * that a missing ledger is a SKIP rather than a wall of findings.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const scratch = () => mkdtempSync(path.join(tmpdir(), 'paper-ledger-'))

describe('parseArgs', () => {
  it('defaults to the repo it lives in', () => {
    expect(parseArgs([], '/anywhere').root).toBe(REPO_ROOT)
  })

  it('resolves --root against the working directory', () => {
    expect(parseArgs(['--root', 'copy'], '/tmp/x').root).toBe(path.resolve('/tmp/x', 'copy'))
  })

  it('refuses --root with no directory after it', () => {
    expect(parseArgs(['--root'], '/x').error).toContain('needs a directory')
    expect(parseArgs(['--root', '--other'], '/x').error).toContain('needs a directory')
  })

  it('refuses --root twice rather than picking one', () => {
    expect(parseArgs(['--root', 'a', '--root', 'b'], '/x').error).toContain('twice')
  })

  it('refuses an argument it does not know', () => {
    expect(parseArgs(['--deep'], '/x').error).toContain('--deep')
  })
})

describe('makeExists', () => {
  const exists = makeExists(REPO_ROOT)

  it('answers for a file', () => {
    expect(exists('scripts/check-feature-ledger.mjs')).toBe(true)
  })

  it('answers for a directory, which is a legitimate Where', () => {
    expect(exists('src/kernel/ui/reader/wordSnap')).toBe(true)
  })

  it('answers false for something absent', () => {
    expect(exists('src/kernel/core/nothing-here.ts')).toBe(false)
  })
})

describe('run', () => {
  it('passes over the real repository', () => {
    const result = run(REPO_ROOT)
    expect(result.findings).toEqual([])
    expect(result.skipped).toBeUndefined()
  })

  it('skips a tree with no ledger rather than inventing findings', () => {
    /* `pnpm verify:without <id>` runs the gates over a copy. A copy without
     * docs/ must not fail for a reason that has nothing to do with the
     * capability being removed. */
    const result = run(scratch())
    expect(result.skipped).toContain(LEDGER)
    expect(result.findings).toEqual([])
  })

  /**
   * BOTH LEDGERS, and this is the assertion that the second one is covered.
   *
   * `docs/library-ledger.md` sat outside this gate from phase 5 to phase 14
   * and went eighteen rows and every path stale inside it. Checking one file
   * while the summary says "features-check" is a gate answering a narrower
   * question than its name — so the list is pinned here rather than left to
   * whoever next reads the script.
   */
  it('checks every ledger in LEDGERS, and each passes over the real repository', () => {
    expect(LEDGERS).toContain('docs/feature-ledger.md')
    expect(LEDGERS).toContain('docs/library-ledger.md')
    for (const ledger of LEDGERS) {
      const result = run(REPO_ROOT, process.env, ledger)
      expect(result.skipped, ledger).toBeUndefined()
      expect(result.findings.map((f) => `${ledger}: ${f.code} ${f.where} ${f.message}`), ledger).toEqual([])
      /* Each one makes real claims — a ledger the parser silently matched
         nothing in would report zero findings and mean nothing by it. */
      expect(result.summary.claims, ledger).toBeGreaterThan(20)
    }
  })

  it('reads the ledger it is given, not always the default', () => {
    const root = scratch()
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    writeFileSync(
      path.join(root, 'docs/library-ledger.md'),
      ['| Capability | State | Where | Note |', '|---|---|---|---|', '| A | Shipped | `core/gone.ts` | x |'].join('\n'),
    )
    /* The default ledger is absent here, so asking for it skips... */
    expect(run(root).skipped).toContain(LEDGER)
    /* ...while the one that IS here is read, header and all. */
    const named = run(root, process.env, 'docs/library-ledger.md')
    expect(named.skipped).toBeUndefined()
    expect(named.findings.map((f) => f.code)).toEqual(['LEDGER_PATH_MISSING'])
  })

  it('reports against the tree it was pointed at, not this one', () => {
    const root = scratch()
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    writeFileSync(
      path.join(root, LEDGER),
      ['| Capability | State | Where | How to confirm |', '|---|---|---|---|', '| A | Shipped | `core/a.ts` | x |'].join(
        '\n',
      ),
    )
    const missing = run(root)
    expect(missing.findings.map((f) => f.code)).toEqual(['LEDGER_PATH_MISSING'])

    mkdirSync(path.join(root, 'src/kernel/core'), { recursive: true })
    writeFileSync(path.join(root, 'src/kernel/core/a.ts'), '')
    expect(run(root).findings).toEqual([])
  })
})
