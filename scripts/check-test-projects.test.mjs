import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { compare, listTestFiles } from './check-test-projects.mjs'

/**
 * `check-test-projects`: the walk, the comparison, and the CLI over a real
 * Vitest project set. The CLI cases spawn Vitest against a temporary root
 * with its own `vitest.config.ts`, because the thing under test is that the
 * script reads Vitest's actual answer — a re-implementation of the globs
 * would be exactly the gap the script exists to close.
 */

const SCRIPT = fileURLToPath(new URL('./check-test-projects.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A root holding `files` (path → content), with this repository's
 *  `node_modules` linked in so a `vitest.config.ts` there can import
 *  `vitest/config`. Realpath'd so Vitest reports files under the same prefix
 *  the script resolves. */
function fixture(files) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'test-projects-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  return root
}

const CONFIG =
  "import { defineConfig } from 'vitest/config'\n" +
  'export default defineConfig({ test: { passWithNoTests: true, projects: [\n' +
  "  { test: { name: 'one', include: ['src/one/**/*.test.ts'] } },\n" +
  "  { test: { name: 'two', include: ['src/two/**/*.test.ts'] } },\n" +
  "  { test: { name: 'wide', include: ['src/**/*.wide.test.ts'] } },\n" +
  '] } })\n'
const TEST = "import { it } from 'vitest'\nit('x', () => {})\n"

function run(root) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', timeout: 120_000 })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

describe('listTestFiles', () => {
  it('finds *.test.* under src/ and scripts/ — .ts, .tsx, .mjs, contract tests — and nothing else', () => {
    const root = fixture({
      'src/a.test.ts': '',
      'src/deep/b.test.tsx': '',
      'src/deep/c.contract.test.ts': '',
      'src/deep/d.testkit.ts': '',
      'src/deep/e.ts': '',
      'scripts/f.test.mjs': '',
      'scripts/g.selftest.mjs': '',
      'other/h.test.ts': '',
    })
    expect(listTestFiles(root)).toEqual(['scripts/f.test.mjs', 'src/a.test.ts', 'src/deep/b.test.tsx', 'src/deep/c.contract.test.ts'])
  })

  it('tolerates a missing scan root and skips node_modules', () => {
    const root = fixture({ 'src/a.test.ts': '', 'src/node_modules/x/y.test.ts': '' })
    expect(listTestFiles(root)).toEqual(['src/a.test.ts'])
  })
})

describe('compare', () => {
  const collected = [
    { file: 'src/a.test.ts', project: 'one' },
    { file: 'src/b.test.ts', project: 'one' },
    { file: 'src/b.test.ts', project: 'two' },
    { file: 'lib/z.test.ts', project: 'two' },
    { file: 'src/w.ts', project: 'two' },
  ]

  it('reports an orphan, a double, a file outside the scan roots and one the walk would not recognise', () => {
    const { findings, counts } = compare(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], collected)
    expect(findings).toEqual([
      { code: 'DOUBLE', file: 'src/b.test.ts', message: 'included by 2 projects: one, two' },
      { code: 'ORPHAN', file: 'src/c.test.ts', message: 'no project includes this test file' },
      { code: 'OUTSIDE', file: 'lib/z.test.ts', message: 'collected by two outside src/, scripts/ — extend SCAN_ROOTS' },
      { code: 'UNSCANNED', file: 'src/w.ts', message: 'collected by two but not a *.test.* file this check recognises' },
    ])
    expect([...counts]).toEqual([
      ['one', 2],
      ['two', 3],
    ])
  })

  it('is clean when every file is collected exactly once', () => {
    const { findings } = compare(
      ['src/a.test.ts', 'src/b.test.ts'],
      [
        { file: 'src/a.test.ts', project: 'one' },
        { file: 'src/b.test.ts', project: 'two' },
      ],
    )
    expect(findings).toEqual([])
  })
})

describe('the CLI, against Vitest itself', () => {
  it('exits 0 with per-project counts when every test file belongs to exactly one project', () => {
    const root = fixture({ 'vitest.config.ts': CONFIG, 'src/one/a.test.ts': TEST, 'src/two/b.test.ts': TEST })
    const { code, out, err } = run(root)
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toBe('  one: 1 file\n  two: 1 file\ncheck-test-projects: 2 test files, 2 projects, 0 findings\n')
  }, 120_000)

  it('exits 1 on a file no project includes and on one two projects include', () => {
    const root = fixture({
      'vitest.config.ts': CONFIG,
      'src/one/a.test.ts': TEST,
      'src/one/a.wide.test.ts': TEST,
      'src/three/orphan.test.ts': TEST,
    })
    const { code, out } = run(root)
    expect(code).toBe(1)
    const lines = out.trimEnd().split('\n')
    expect(lines).toContain('DOUBLE src/one/a.wide.test.ts: included by 2 projects: one, wide')
    expect(lines).toContain('ORPHAN src/three/orphan.test.ts: no project includes this test file')
    expect(lines.at(-1)).toBe('check-test-projects: 3 test files, 2 projects, 2 findings')
  }, 120_000)

  it('exits 2 when Vitest cannot answer — a broken config is not "no files"', () => {
    const root = fixture({ 'vitest.config.ts': 'export default {\n', 'src/one/a.test.ts': TEST })
    const { code, err } = run(root)
    expect(code).toBe(2)
    expect(err).toMatch(/check-test-projects: Error: vitest list exited 1/)
  }, 120_000)
})
