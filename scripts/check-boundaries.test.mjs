import { beforeAll, describe, expect, it } from 'vitest'
import { REQUIRES_RULE, cruiserViolations, formatViolation, undeclaredRequires } from './check-boundaries.mjs'
import { CASES, LEGAL_TREE, caseFailure, runAll, runCli } from './check-boundaries.selftest.mjs'

/**
 * The boundary selftest under Vitest, so `pnpm test` proves the boundary
 * check can fail. `check-boundaries.selftest.mjs` owns the cases and the
 * fixture tree; this file runs them through its `runAll` — each case an
 * IN-PROCESS cruise, not a child process; the only spawns here are `runCli`'s
 * four — and adds what the standalone runner does not: the pure `requires`
 * pass on hand-made module lists, and the CLI's exit code and line format end
 * to end.
 */

/**
 * ONE CRUISE PER CASE PER `pnpm verify`, not two.
 *
 * `CASES` used to run twice: once through this file's `it.concurrent.each`,
 * and again through the selftest's own `main`, which was `verify.mjs` step 7.
 * `boundaries:selftest` is gone from `STEPS`, and this is now the only place
 * they run — kept over the standalone runner because `test:ledger` names
 * TESTS: cases behind a script leave the ledger, and a deleted case then
 * disappears exactly the way the twelve `pageTurn` tests did. The two
 * asserted the same two conditions, so nothing narrowed.
 *
 * THE COUNT IS DELIBERATELY NOT WRITTEN HERE. It was "27" in four comments
 * while the list held 28, and phase 11 took it to 35 without any of them
 * moving — a number in prose that nothing checks is the same defect the
 * feature ledger's path check exists for. `CASES.length` is the answer.
 *
 * `runAll` rather than `it.concurrent`: the cap is `defaultWidth()`, an
 * explicit `min(6, availableParallelism())` that this repository chose, where
 * `it.concurrent` was governed by vitest's `maxConcurrency` default while
 * competing with every other test file in the run. `runAll` catches per case,
 * so a case that throws fails its OWN name here rather than the hook.
 */
describe('every illegal edge is rejected by the rule that owns it', () => {
  /** Case name -> result, filled once before the assertions below. */
  let results

  beforeAll(async () => {
    results = await runAll(CASES)
    /* 300s, not the 120s a single case used to get: this hook now runs all of
       them. The whole set measures ~3.9s at this cap on an idle machine
       (2026-08-23, 35 cases, three runs within 200ms of each other); the
       21.6s this note used to quote predates both the current cap and the
       current list. The margin is for a loaded machine, not for the set. */
  }, 300_000)

  it.each(CASES.map((c) => [c.name, c]))('%s', (_name, testCase) => {
    const result = results[CASES.indexOf(testCase)]
    expect(caseFailure(result, testCase) ?? 'ok').toBe('ok')
  })
})

describe('undeclaredRequires', () => {
  const manifest = {
    capabilities: [
      { id: 'alpha', ts: 'alpha-dir', platforms: ['desktop'], requires: ['beta'] },
      { id: 'beta', ts: 'beta', platforms: ['desktop'] },
    ],
  }
  const edge = (source, resolved) => ({ source, dependencies: [{ resolved }] })

  it('accepts an edge to a required capability, keyed by the ts directory, not the id', () => {
    expect(undeclaredRequires([edge('src/capabilities/alpha-dir/lib/x.ts', 'src/capabilities/beta/index.ts')], manifest)).toEqual([])
  })

  it('rejects an edge to a capability the importer does not require', () => {
    const out = undeclaredRequires([edge('src/capabilities/beta/index.ts', 'src/capabilities/alpha-dir/index.ts')], manifest)
    expect(out).toEqual([
      {
        rule: REQUIRES_RULE,
        from: 'src/capabilities/beta/index.ts',
        to: 'src/capabilities/alpha-dir/index.ts',
        message: 'beta does not list alpha in requires',
      },
    ])
  })

  it('rejects an edge from or to a capability directory the manifest does not list', () => {
    const from = undeclaredRequires([edge('src/capabilities/ghost/index.ts', 'src/capabilities/beta/index.ts')], manifest)
    expect(from.map((v) => v.message)).toEqual(['src/capabilities/ghost has no manifest entry'])
    const to = undeclaredRequires([edge('src/capabilities/beta/index.ts', 'src/capabilities/ghost/index.ts')], manifest)
    expect(to.map((v) => v.message)).toEqual(['src/capabilities/ghost has no manifest entry'])
  })

  it('judges only edges to another capability INDEX — internals are the cruiser rule, own files are not another capability', () => {
    const modules = [
      edge('src/capabilities/beta/index.ts', 'src/capabilities/alpha-dir/lib/internal.ts'),
      edge('src/capabilities/beta/index.ts', 'src/capabilities/beta/lib/own.ts'),
      edge('src/capabilities/beta/index.ts', 'src/kernel/index.ts'),
      edge('src/kernel/core/x.ts', 'src/capabilities/beta/index.ts'),
    ]
    expect(undeclaredRequires(modules, manifest)).toEqual([])
  })

  it('accepts index.tsx as an index too', () => {
    expect(undeclaredRequires([edge('src/capabilities/alpha-dir/index.ts', 'src/capabilities/beta/index.tsx')], manifest)).toEqual([])
  })
})

describe('cruiserViolations', () => {
  it('carries the rule name and spells a cycle out', () => {
    const out = cruiserViolations({
      summary: {
        violations: [
          { from: 'a.ts', to: 'b.ts', rule: { severity: 'error', name: 'no-circular' }, cycle: [{ name: 'b.ts' }, { name: 'a.ts' }] },
          { from: 'c.ts', to: 'd.ts', rule: { severity: 'error', name: 'x' } },
        ],
      },
    })
    expect(out.map(formatViolation)).toEqual(['no-circular a.ts -> b.ts (cycle: a.ts -> b.ts -> a.ts)', 'x c.ts -> d.ts'])
  })
})

describe('the CLI', () => {
  it('exits 0 on the legal tree and says what it cruised', async () => {
    const { code, out, err } = await runCli({})
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toMatch(/^check-boundaries: \d+ modules, \d+ dependencies, 0 violations\n$/)
  }, 120_000)

  it('exits 1 on a violation and prints it as one line naming the rule and the edge', async () => {
    const { code, out } = await runCli({
      'src/kernel/core/other.ts': "import { alpha } from '../../capabilities/alpha/index.ts'\nexport const other = alpha\nexport type OtherType = { m: number }\n",
    })
    expect(code).toBe(1)
    const lines = out.trimEnd().split('\n')
    expect(lines).toContain('no-kernel-to-capabilities src/kernel/core/other.ts -> src/capabilities/alpha/index.ts')
    expect(lines.at(-1)).toMatch(/^check-boundaries: \d+ modules, \d+ dependencies, [1-9]\d* violations$/)
  }, 120_000)

  it('exits 2 when the manifest cannot be trusted, rather than passing with an unchecked requires', async () => {
    const { code, err } = await runCli({ 'capabilities.manifest.json': '{ "capabilities": [ { "id": "alpha" } ] }' })
    expect(code).toBe(2)
    expect(err).toMatch(/capabilities\.manifest\.json is invalid/)
  }, 120_000)

  it('exits 2 when the tree has no kernel — a run that saw the wrong root must not pass', async () => {
    const files = Object.fromEntries(Object.keys(LEGAL_TREE).filter((k) => k.startsWith('src/kernel/')).map((k) => [k, null]))
    const { code, err } = await runCli(files)
    expect(code).toBe(2)
    expect(err).toMatch(/nothing under src\/kernel\/ was cruised/)
  }, 120_000)
})
