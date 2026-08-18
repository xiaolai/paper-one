import { describe, expect, it } from 'vitest'
import { REQUIRES_RULE, cruiserViolations, formatViolation, undeclaredRequires } from './check-boundaries.mjs'
import { CASES, LEGAL_TREE, runCase, runCli } from './check-boundaries.selftest.mjs'

/**
 * The boundary selftest under Vitest, so `pnpm test` proves the boundary
 * check can fail. `check-boundaries.selftest.mjs` owns the cases and the
 * fixture tree; this file runs each of them (concurrently — every case is a
 * cruiser process) and adds what the standalone runner does not: the pure
 * `requires` pass on hand-made module lists, and the CLI's exit code and
 * line format end to end.
 */

describe('every illegal edge is rejected by the rule that owns it', () => {
  it.concurrent.each(CASES.map((c) => [c.name, c]))('%s', async (_name, testCase) => {
    const { violations, missing, unexpected } = await runCase(testCase)
    expect(missing, `not reported; saw:\n${violations.map(formatViolation).join('\n')}`).toEqual([])
    expect(unexpected.map(formatViolation)).toEqual([])
  }, 120_000)
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
  it('exits 0 on the legal tree and says what it cruised', () => {
    const { code, out, err } = runCli({})
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toMatch(/^check-boundaries: \d+ modules, \d+ dependencies, 0 violations\n$/)
  }, 120_000)

  it('exits 1 on a violation and prints it as one line naming the rule and the edge', () => {
    const { code, out } = runCli({
      'src/kernel/core/other.ts': "import { alpha } from '../../capabilities/alpha/index.ts'\nexport const other = alpha\nexport type OtherType = { m: number }\n",
    })
    expect(code).toBe(1)
    const lines = out.trimEnd().split('\n')
    expect(lines).toContain('no-kernel-to-capabilities src/kernel/core/other.ts -> src/capabilities/alpha/index.ts')
    expect(lines.at(-1)).toMatch(/^check-boundaries: \d+ modules, \d+ dependencies, [1-9]\d* violations$/)
  }, 120_000)

  it('exits 2 when the manifest cannot be trusted, rather than passing with an unchecked requires', () => {
    const { code, err } = runCli({ 'capabilities.manifest.json': '{ "capabilities": [ { "id": "alpha" } ] }' })
    expect(code).toBe(2)
    expect(err).toMatch(/capabilities\.manifest\.json is invalid/)
  }, 120_000)

  it('exits 2 when the tree has no kernel — a run that saw the wrong root must not pass', () => {
    const files = Object.fromEntries(Object.keys(LEGAL_TREE).filter((k) => k.startsWith('src/kernel/')).map((k) => [k, null]))
    const { code, err } = runCli(files)
    expect(code).toBe(2)
    expect(err).toMatch(/nothing under src\/kernel\/ was cruised/)
  }, 120_000)
})
