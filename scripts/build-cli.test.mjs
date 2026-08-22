import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MIN_BYTES, OUT_DIR, OUT_FILE } from './build-cli.mjs'

/**
 * `bin/paper.mjs` is ONE FILE (phase 11, WI-11.4).
 *
 * The first version of this build left `node_modules` external, which is
 * Vite's SSR default and is wrong for a CLI that people copy. Two costs, and
 * the first was measured on a real second Mac rather than reasoned about:
 *
 *   - `foliate-js` is pinned to a COMMIT SHA, and the pin differs between
 *     branches of this repository. A bundle copied to another machine
 *     therefore resolved `compare` and `collapse` from a different fork
 *     commit than it was built against — in the dependency `AGENTS.md`
 *     records as having silently rewritten its API past a green `tsc`. The
 *     CLI orders marks with `compareMarks`, so it is not a theoretical
 *     mismatch.
 *   - it pulled `@tauri-apps/plugin-fs` into a Node process, reached through
 *     the kernel's public entry by `bookVault.ts` — harmless today, and a
 *     plugin that grew an import-time IPC check would break `paper` on a
 *     machine with no app.
 *
 * `scp bin/paper.mjs other-mac:` has to be a correct way to put the CLI
 * somewhere, not one that appears to work. This is what makes it so.
 *
 * It asserts the ARTIFACT rather than the config, because the config option
 * that does this is a top-level `ssr.noExternal` and the obvious place to put
 * it (`build.ssr`) is silently ignored — which is exactly how the first
 * version shipped.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = path.join(REPO_ROOT, OUT_DIR, OUT_FILE)

/** Every specifier the bundle imports at runtime. */
function imports(source) {
  const found = new Set()
  for (const match of source.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)) found.add(match[1])
  for (const match of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.add(match[1])
  return [...found].sort()
}

describe('the built CLI', () => {
  /* Built on demand rather than assumed present: `bin/` is gitignored, so a
   * fresh clone has none, and a test that skipped would be a test that never
   * ran anywhere it mattered. */
  it('builds', () => {
    const result = spawnSync('node', [path.join(REPO_ROOT, 'scripts', 'build-cli.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(existsSync(BUNDLE)).toBe(true)
    expect(statSync(BUNDLE).size).toBeGreaterThan(MIN_BYTES)
  }, 180_000)

  it('imports node: builtins and nothing else', () => {
    const outside = imports(readFileSync(BUNDLE, 'utf8')).filter((one) => !one.startsWith('node:'))
    expect(outside).toEqual([])
  })

  it('carries a shebang and is executable', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true)
    /* The owner-execute bit, masked out of the mode. */
    expect(statSync(BUNDLE).mode & 0o100).toBe(0o100)
  })

  /* END TO END, against a fixture library — the one assertion that proves the
   * bundle RUNS rather than merely parses. A bundle missing a dependency is a
   * file of the right size that throws on its first import. */
  it('answers a command against a library of its own', () => {
    /* Its OWN directory, never the reader's: `defaultDataDir()` resolves the
     * app's real library, and a test that ran there would open — and possibly
     * rewrite the index of — somebody's two thousand books. */
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paper-cli-selftest-'))
    try {
      const run = spawnSync('node', [BUNDLE, 'book', 'list', '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PAPER_DATA_DIR: dataDir },
      })
      expect(run.stderr).toBe('')
      expect(run.status).toBe(0)
      expect(JSON.parse(run.stdout)).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
