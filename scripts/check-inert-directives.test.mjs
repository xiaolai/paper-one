import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { inertDirectives } from './check-inert-directives.mjs'

/**
 * `check-inert-directives`: a suppression is honest only if its tool runs.
 *
 * The gate has to turn on the MANIFEST rather than on the tree, and both
 * directions matter: it must find a directive for a tool nothing declares, and
 * it must go quiet the moment that tool is declared — otherwise installing the
 * linter would leave a check demanding the removal of the very comments the
 * linter needs, and the only way out would be to delete the gate.
 */

const SCRIPT = fileURLToPath(new URL('./check-inert-directives.mjs', import.meta.url))

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fixture(files, manifest = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'inert-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'f', ...manifest }))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

const DISABLE = '// eslint-disable-next-line react-hooks/exhaustive-deps\n'

describe('a suppression with no tool behind it', () => {
  it('is reported, with the file and line', () => {
    const root = fixture({ 'src/a.ts': `const x = 1\n${DISABLE}const y = 2\n` })
    expect(inertDirectives(root).found).toEqual([{ file: 'src/a.ts', line: 2, tool: 'eslint' }])
  })

  it.each([
    ['prettier', '// prettier-ignore\n'],
    ['biome', '// biome-ignore lint/style/noVar: reason\n'],
  ])('covers %s too, not just eslint', (tool, comment) => {
    const root = fixture({ 'src/a.ts': comment })
    expect(inertDirectives(root).found.map((f) => f.tool)).toEqual([tool])
  })
})

describe('a suppression whose tool is declared', () => {
  /* THE HALF THAT MAKES THE GATE SAFE TO ADOPT. Installing ESLint must turn
     this check off by itself; a gate that would then demand the deletion of
     every directive the new linter needs is a gate that gets deleted. */
  it.each([['dependencies'], ['devDependencies']])('is left alone when in %s', (field) => {
    const root = fixture({ 'src/a.ts': DISABLE }, { [field]: { eslint: '^9.0.0' } })
    const { found, live } = inertDirectives(root)
    expect(found).toEqual([])
    expect(live).toEqual(['eslint'])
  })

  it('still reports a DIFFERENT tool that is not declared', () => {
    // Installing one linter says nothing about the others.
    const root = fixture(
      { 'src/a.ts': `${DISABLE}// prettier-ignore\n` },
      { devDependencies: { eslint: '^9.0.0' } },
    )
    expect(inertDirectives(root).found.map((f) => f.tool)).toEqual(['prettier'])
  })
})

describe('the CLI', () => {
  it('exits 0 on this repository and names what it looked for', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(run.stdout).toContain('check-inert-directives: 0 inert')
    /* Says which linters it found, so "0 inert" cannot be read as "checked" by
       a reader who does not know whether it looked at anything. */
    expect(run.stdout).toMatch(/linters declared: (none|\w)/)
    expect(run.status).toBe(0)
  })
})
