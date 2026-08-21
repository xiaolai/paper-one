import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LEDGER, makeExists, parseArgs, run } from './check-feature-ledger.mjs'

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
