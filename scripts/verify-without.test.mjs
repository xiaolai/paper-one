import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { COPY_EXCLUDE, COPY_STEPS, copyTree, digestTree, parseArgs, verifyWithout } from './verify-without.mjs'

/**
 * `pnpm verify:without <id>` — the mechanics: the copy leaves out what it
 * should and links node_modules; the kernel digest sees any byte change;
 * the run removes the capability in the copy, checks the kernel, runs the
 * copy's gates in order, and cleans up (or keeps). The gates themselves are
 * driven through an injected runner here; the real thing is the row's
 * Verify, run once by hand and by CI.
 */

const SCRIPT = fileURLToPath(new URL('./verify-without.mjs', import.meta.url))

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A small "repository": a package.json, a kernel, an excluded directory of each kind. */
function source() {
  const root = mkdtempSync(path.join(tmpdir(), 'verify-without-src-'))
  roots.push(root)
  const files = {
    'package.json': '{"name":"fixture"}\n',
    'src/kernel/index.ts': 'export const k = 1\n',
    'src/kernel/core/a.ts': 'export const a = 1\n',
    'src/capabilities/example/index.ts': 'export const example = 1\n',
    'node_modules/pkg/index.js': 'module.exports = 1\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
    'dist/index.html': '<html/>\n',
    '.types/kernel/index.d.ts': 'export {}\n',
    'coverage/lcov.info': '\n',
    'src-tauri/target/debug/app': 'binary\n',
    'src-tauri/src/lib.rs': 'fn main() {}\n',
    '.claude/settings.local.json': '{}\n',
    'src/app/composition.desktop.ts.capability-remove.tmp': 'stale\n',
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}

describe('copyTree', () => {
  it('copies everything but the excluded names and stale temp files, and links node_modules', () => {
    const src = source()
    const dest = copyTree(src)
    roots.push(dest)
    expect(readFileSync(path.join(dest, 'src/kernel/index.ts'), 'utf8')).toBe('export const k = 1\n')
    expect(readFileSync(path.join(dest, 'src-tauri/src/lib.rs'), 'utf8')).toBe('fn main() {}\n')
    for (const gone of ['.git', 'dist', '.types', 'coverage', 'src-tauri/target', '.claude', 'src/app/composition.desktop.ts.capability-remove.tmp']) {
      expect(existsSync(path.join(dest, gone))).toBe(false)
    }
    expect(lstatSync(path.join(dest, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(dest, 'node_modules/pkg/index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(dest.startsWith(realpathSync(tmpdir()))).toBe(true) // realpath'd, so Vite's module ids and the root agree
    expect(COPY_EXCLUDE).toContain('node_modules')
    expect(COPY_EXCLUDE).toContain('target')
  })

  it('does not link node_modules when the source has none', () => {
    const src = mkdtempSync(path.join(tmpdir(), 'verify-without-bare-'))
    roots.push(src)
    writeFileSync(path.join(src, 'a.txt'), 'a')
    const dest = copyTree(src)
    roots.push(dest)
    expect(existsSync(path.join(dest, 'node_modules'))).toBe(false)
    expect(readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('a')
  })
})

describe('digestTree', () => {
  it('changes with any byte, any name, and is empty for an absent directory', () => {
    const src = source()
    const before = digestTree(path.join(src, 'src/kernel'))
    expect(before).toMatch(/^[0-9a-f]{64}$/)
    expect(digestTree(path.join(src, 'src/kernel'))).toBe(before)
    writeFileSync(path.join(src, 'src/kernel/core/a.ts'), 'export const a = 2\n')
    const after = digestTree(path.join(src, 'src/kernel'))
    expect(after).not.toBe(before)
    writeFileSync(path.join(src, 'src/kernel/core/a.ts'), 'export const a = 1\n')
    expect(digestTree(path.join(src, 'src/kernel'))).toBe(before)
    writeFileSync(path.join(src, 'src/kernel/core/b.ts'), '')
    expect(digestTree(path.join(src, 'src/kernel'))).not.toBe(before)
    expect(digestTree(path.join(src, 'nowhere'))).toBe('')
  })
})

describe('verifyWithout', () => {
  it('removes in the copy, checks the kernel, runs the copy steps in order, cleans up, and returns 0', () => {
    const src = source()
    const ran = []
    const log = []
    let copyDir
    const run = (step, cwd) => {
      copyDir = cwd
      ran.push(step.name)
      expect(cwd).not.toBe(src)
      expect(existsSync(path.join(cwd, 'src/kernel/index.ts'))).toBe(true)
      return 0
    }
    const { code, dir } = verifyWithout('example', { source: src, run, log: (l) => log.push(l) })
    expect(code).toBe(0)
    expect(dir).toBe(copyDir)
    expect(ran).toEqual(['capability:remove example', ...COPY_STEPS.map((s) => s.name)])
    expect(ran).toEqual(['capability:remove example', 'typecheck', 'boundaries', 'architecture:check', 'compositions:check', 'test', 'build', 'build:ios', 'build:android'])
    expect(log.some((l) => l.startsWith('verify-without: src/kernel/ unchanged (sha256 '))).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(path.join(src, 'src/capabilities/example/index.ts'))).toBe(true)
  })

  it('fails when the removal touched the kernel, and keeps the copy with --keep', () => {
    const src = source()
    const ran = []
    const log = []
    const run = (step, cwd) => {
      ran.push(step.name)
      if (step.name.startsWith('capability:remove')) writeFileSync(path.join(cwd, 'src/kernel/index.ts'), 'export const k = 2\n')
      return 0
    }
    const { code, dir } = verifyWithout('example', { source: src, keep: true, run, log: (l) => log.push(l) })
    roots.push(dir)
    expect(code).toBe(1)
    expect(ran).toEqual(['capability:remove example'])
    expect(log).toContain('verify-without: capability:remove example changed a file under src/kernel/ — deletion must not touch the kernel')
    expect(log).toContain(`verify-without: kept ${dir}`)
    expect(existsSync(dir)).toBe(true)
  })

  it("returns the first failing step's code and stops there", () => {
    const src = source()
    const ran = []
    const { code, dir } = verifyWithout('example', {
      source: src,
      run: (step) => (ran.push(step.name), step.name === 'boundaries' ? 5 : 0),
      log: () => {},
    })
    expect(code).toBe(5)
    expect(ran).toEqual(['capability:remove example', 'typecheck', 'boundaries'])
    expect(existsSync(dir)).toBe(false)
  })
})

describe('parseArgs and the CLI', () => {
  it('reads the id and --keep, refuses the rest', () => {
    expect(parseArgs(['example'])).toEqual({ id: 'example', keep: false })
    expect(parseArgs(['example', '--keep'])).toEqual({ id: 'example', keep: true })
    expect(parseArgs([])).toEqual({ error: 'a capability id is required' })
    expect(parseArgs(['a', 'b'])).toEqual({ error: 'exactly one capability id is expected' })
    expect(parseArgs(['--x'])).toEqual({ error: 'unknown argument "--x"' })
    const bad = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('a capability id is required')
  })
})
