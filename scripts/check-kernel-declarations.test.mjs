import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkDeclarations } from './check-kernel-declarations.mjs'

/**
 * The declaration scan over hand-made `.types/kernel` trees. What matters
 * is not the happy path — `rg` could do that — but that the scan cannot pass
 * by having nothing to read, and cannot pass over a declaration whose source
 * is gone.
 */

const SCRIPT = fileURLToPath(new URL('./check-kernel-declarations.mjs', import.meta.url))

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A root with `.types/kernel/<rel>` declarations and `src/kernel/<rel>` sources. */
function fixture({ decls = {}, sources = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kernel-decls-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(decls)) {
    const file = join(root, '.types', 'kernel', rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  for (const rel of sources) {
    const file = join(root, 'src', 'kernel', rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'export {}\n')
  }
  return root
}

function run(root) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

describe('checkDeclarations', () => {
  it('is clean when every declaration has a source and none mentions capabilities/', () => {
    const root = fixture({
      decls: { 'index.d.ts': 'export {}\n', 'core/a.d.ts': "export declare const a: number\n" },
      sources: ['index.ts', 'core/a.ts'],
    })
    expect(checkDeclarations(root)).toEqual({ findings: [], scanned: 2 })
  })

  it('reports a mention of capabilities/ with its file and line', () => {
    const root = fixture({
      decls: { 'core/a.d.ts': "export declare const a: number\nexport type P = import('../../capabilities/peer/index').Port\n" },
      sources: ['core/a.ts'],
    })
    expect(checkDeclarations(root).findings).toEqual([
      { code: 'MENTION', path: '.types/kernel/core/a.d.ts:2', message: "export type P = import('../../capabilities/peer/index').Port" },
    ])
  })

  it('does not count capabilities.manifest.json — the needle is the path segment', () => {
    const root = fixture({ decls: { 'core/a.d.ts': '/** read from capabilities.manifest.json */\nexport {}\n' }, sources: ['core/a.ts'] })
    expect(checkDeclarations(root).findings).toEqual([])
  })

  it('accepts a .tsx source for a declaration', () => {
    const root = fixture({ decls: { 'ui/App.d.ts': 'export {}\n' }, sources: ['ui/App.tsx'] })
    expect(checkDeclarations(root).findings).toEqual([])
  })

  it('reports a declaration whose source is gone as STALE, and still scans it', () => {
    const root = fixture({ decls: { 'core/gone.d.ts': "import '../../capabilities/x'\n" }, sources: [] })
    const codes = checkDeclarations(root).findings.map((f) => `${f.code} ${f.path}`)
    expect(codes).toEqual(['STALE .types/kernel/core/gone.d.ts', 'MENTION .types/kernel/core/gone.d.ts:1'])
  })

  it('reports MISSING when there is nothing to scan — an absent or empty .types/kernel is not a pass', () => {
    expect(checkDeclarations(fixture()).findings.map((f) => f.code)).toEqual(['MISSING'])
    const empty = fixture()
    mkdirSync(join(empty, '.types', 'kernel', 'core'), { recursive: true })
    expect(checkDeclarations(empty)).toEqual({
      findings: [{ code: 'MISSING', path: '.types/kernel', message: 'no declarations to scan — run `pnpm typecheck` (tsc -b) first' }],
      scanned: 0,
    })
  })
})

describe('the CLI', () => {
  it('exits 0 with a summary on a clean tree', () => {
    const { code, out, err } = run(fixture({ decls: { 'index.d.ts': 'export {}\n' }, sources: ['index.ts'] }))
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toBe('check-kernel-declarations: 1 declaration files, 0 findings\n')
  })

  it('exits 1 and prints one line per finding', () => {
    const { code, out } = run(fixture({ decls: { 'core/a.d.ts': "import '../../capabilities/x'\n" }, sources: [] }))
    expect(code).toBe(1)
    expect(out.trimEnd().split('\n')).toEqual([
      'STALE .types/kernel/core/a.d.ts: no source src/kernel/core/a.ts(x) — run `pnpm typecheck`, which rebuilds .types from clean',
      "MENTION .types/kernel/core/a.d.ts:1: import '../../capabilities/x'",
      'check-kernel-declarations: 1 declaration files, 2 findings',
    ])
  })

  it('exits 2 on an argument it does not understand', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/unknown argument "--nope"/)
  })
})
