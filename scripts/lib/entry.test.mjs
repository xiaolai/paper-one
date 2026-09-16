import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isProcessEntry } from './entry.mjs'

/**
 * `isProcessEntry` is the guard every script in `scripts/` puts around its
 * `main()`. It has to be right in three situations that look alike from the
 * inside: run directly, run through a symlink, and imported by something else
 * (a test, another script). Node ≥ 24.2 answers the question itself with
 * `import.meta.main`; the fallback compares paths and must refuse to guess
 * rather than answer "no" — a script that silently does nothing looks exactly
 * like one that ran.
 */

const HELPER = fileURLToPath(new URL('./entry.mjs', import.meta.url))
/* Made before the first case, not at module scope: collecting a file runs its
   body and no hook — `vitest list` does exactly that, and `pnpm test:ledger`
   runs it, and so does a run whose name filter leaves no case here — so a
   directory made there was left behind. */
let tmp
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'entry-guard-'))
})
afterAll(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
})

/** A script that prints the guard's verdict for itself. */
function fixture(name) {
  const file = join(tmp, name)
  writeFileSync(
    file,
    `import { isProcessEntry } from ${JSON.stringify(pathToFileURL(HELPER).href)}\n` +
      'process.stdout.write(String(isProcessEntry(import.meta)))\n',
  )
  return file
}

function run(file) {
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

describe('isProcessEntry', () => {
  it('E-1 is false for a module imported under vitest', () => {
    expect(isProcessEntry(import.meta)).toBe(false)
  })

  it('E-2 is true for the script node was started with', () => {
    const { code, out, err } = run(fixture('direct.mjs'))
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toBe('true')
  })

  it('E-3 is true when the script is started through a symlink', () => {
    const target = fixture('linked-target.mjs')
    const link = join(tmp, 'linked.mjs')
    symlinkSync(target, link)
    const { code, out, err } = run(link)
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toBe('true')
  })

  it('E-4 is false when the script is imported by another entry', () => {
    const imported = fixture('imported.mjs')
    const outer = join(tmp, 'outer.mjs')
    writeFileSync(outer, `import ${JSON.stringify(pathToFileURL(imported).href)}\n`)
    const { code, out, err } = run(outer)
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toBe('false')
  })

  it('E-5 fallback without import.meta.main: lexical match, symlink, other file, and refusing to guess', () => {
    const self = join(tmp, 'self.mjs')
    writeFileSync(self, '')
    const other = join(tmp, 'other.mjs')
    writeFileSync(other, '')
    const link = join(tmp, 'self-link.mjs')
    symlinkSync(self, link)
    const meta = { url: pathToFileURL(self).href } // no `main`: the fallback path

    const saved = process.argv[1]
    try {
      process.argv[1] = self
      expect(isProcessEntry(meta)).toBe(true)

      process.argv[1] = link
      expect(isProcessEntry(meta)).toBe(true)

      process.argv[1] = other
      expect(isProcessEntry(meta)).toBe(false)

      process.argv[1] = join(tmp, 'does-not-exist.mjs')
      expect(() => isProcessEntry(meta)).toThrow(/Refusing to guess/)

      // The other side unresolvable: the module's own file is gone.
      process.argv[1] = other
      expect(() => isProcessEntry({ url: pathToFileURL(join(tmp, 'gone.mjs')).href })).toThrow(/Refusing to guess/)

      // No argv[1] at all (a REPL, `node -e`): not an entry, and no guess needed.
      process.argv[1] = undefined
      expect(isProcessEntry(meta)).toBe(false)
    } finally {
      process.argv[1] = saved
    }
  })

  /**
   * ⚠️ **THE ASSERTION THIS HELPER EXISTED WITHOUT FOR THE WHOLE OF ITS LIFE.**
   *
   * `isProcessEntry` was written, documented and tested, and then eleven
   * scripts went on hand-rolling the guard beside it — including two that
   * `pnpm verify` runs. `check-dead-css.mjs` and `check-inert-directives.mjs`
   * compared `process.argv[1]` to `fileURLToPath(import.meta.url)` textually,
   * so through any symlinked path (macOS `/tmp`, `/var`, a scratch copy, a
   * worktree) both printed NOTHING and exited 0. A gate that scans no files
   * and a gate that finds none are the same two lines of output apart, and
   * neither is distinguishable from the outside by its exit code.
   *
   * Two of the eleven were worse in the other direction:
   * `import.meta.url.endsWith(argv[1].split('/').pop())` matches on BASENAME,
   * so any process whose entry merely ends in the same filename ran an
   * imported module's `main()`.
   *
   * The rule is the narrow one that admits no judgement: after the fix,
   * NOTHING under `scripts/` reads `process.argv[1]` except this helper. That
   * is the only legitimate reason to want it — every other use is a guard
   * being written a twelfth time. `process.argv.slice(2)` (the flags) is
   * untouched by this and is what a script should read instead.
   */
  it('E-6 no script hand-rolls the entry guard — `process.argv[1]` is read only here', () => {
    const scripts = fileURLToPath(new URL('..', import.meta.url))
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const at = join(dir, e.name)
        if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'fixtures' ? [] : walk(at)
        return e.name.endsWith('.mjs') ? [at] : []
      })

    const self = fileURLToPath(import.meta.url)
    const helper = fileURLToPath(new URL('./entry.mjs', import.meta.url))
    const files = walk(scripts)
    /* NON-VACUOUS. A walk that found nothing would pass this silently, which
       is the exact failure shape the test exists to refuse. */
    expect(files.length).toBeGreaterThan(50)

    const offenders = files
      .filter((file) => file !== self && file !== helper)
      .filter((file) => /process\.argv\s*\[\s*1\s*\]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(scripts, file).split('\\').join('/'))

    expect(offenders).toEqual([])
  })
})
