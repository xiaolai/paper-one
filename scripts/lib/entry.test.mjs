import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
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
const tmp = mkdtempSync(join(tmpdir(), 'entry-guard-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

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
})
