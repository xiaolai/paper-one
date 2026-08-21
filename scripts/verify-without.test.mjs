import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { COPY_EXCLUDE, COPY_STEPS, DELETED_ENV, copyTree, digestTree, parseArgs, verifyWithout } from './verify-without.mjs'

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

  /* THE MARKER REACHES EVERY CHILD — see `DELETED_ENV`. Without it a gate
     inside the copy has no way to know it is in the copy, and the tell it used
     instead was the absence of `.git`, which is also true of any source archive
     or plain `cp -r`. A gate excusing a real defect there would report green
     over the thing it exists to catch. Asserted for every step rather than for
     one, because a gate added later is exactly the one that would be missed. */
  it('tells every gate in the copy which capability it deleted', () => {
    const src = source()
    const seen = []
    verifyWithout('example', {
      source: src,
      run: (step, _cwd, env) => (seen.push([step.name, env?.[DELETED_ENV]]), 0),
      log: () => {},
    })
    expect(seen.length).toBeGreaterThan(0)
    for (const [name, id] of seen) expect(id, `${name} was not told`).toBe('example')
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

/**
 * CI RUNS THIS SCRIPT WITH AN ARGUMENT, AND NOTHING CHECKED THE ARGUMENT.
 *
 * `.github/workflows/verify.yml` ends with a step named "Deletion is an
 * operation" — the physical proof of ADR 0001 decision 7. It ran
 * `pnpm verify:without example`, and the capability called `example` was
 * deleted in 19bac0e, whose subject is "Delete the capability that existed to
 * be deleted". The workflow was not updated with it.
 *
 * `capability:remove` refused the unknown id — correctly, and loudly — so the
 * step failed on every push from that commit onward, and the proof it exists to
 * run proved nothing for the whole of that time. A red step that has been red
 * long enough stops being read.
 *
 * So the argument is checked HERE, in the suite that gates every push, where a
 * rename fails in seconds instead of at the end of a 7-minute CI job. Two
 * things have to hold, and the second is the one that is easy to get wrong:
 * the id must be a capability the manifest declares, and NOTHING may require
 * it — `capability:remove` refuses to remove a capability another one depends
 * on, so naming `peer` here would fail just as surely as naming a ghost.
 */
describe('the workflow names a capability that can actually be removed', () => {
  const WORKFLOW = fileURLToPath(new URL('../.github/workflows/verify.yml', import.meta.url))
  const MANIFEST = fileURLToPath(new URL('../capabilities.manifest.json', import.meta.url))

  /**
   * Every `pnpm verify:without <id>` the workflow actually RUNS.
   *
   * Read from `run:` lines rather than from the file's raw text. A regex over
   * the whole document is satisfied by a commented-out step, a line in a
   * `name:`, or a paragraph of documentation — so the workflow could stop
   * running the deletion proof entirely and this check would go on passing on
   * the strength of the sentence explaining why it used to.
   *
   * A line-oriented read rather than a YAML parse: the repo has no YAML
   * dependency, and what has to be excluded here is a COMMENT, which is a
   * property of the line. A step disabled by `if:` would still slip through;
   * that is a narrower hole than the one this closes, and worth stating rather
   * than implying.
   */
  const namedIn = (file) => {
    const lines = readFileSync(file, 'utf8').split('\n')
    const found = []
    for (const [at, line] of lines.entries()) {
      if (/^\s*#/.test(line)) continue
      if (!/^\s*(-\s*)?run:/.test(line)) continue
      const ids = [...line.matchAll(/verify:without\s+([A-Za-z0-9._-]+)/g)].map((m) => m[1])
      if (ids.length === 0) continue
      /* AND THE STEP HAS TO BE ONE THAT ACTUALLY RUNS.
       *
       * A step can be switched off without being deleted: `if: false`, or any
       * condition that is constant, leaves the `run:` line sitting there
       * looking exactly like a live one. Reading only `run:` lines closed the
       * comment hole and left this one — the proof could be disabled in a way
       * that reads as deliberate to a human and as running to this check.
       *
       * The step's own block is where an `if:` lives, so it is looked for
       * between this line and the next `- name:`/`- uses:`/`- run:` above and
       * below. Anything statically false disqualifies the step; a genuine
       * expression (`if: github.ref == …`) is left alone, because a step that
       * runs on some pushes still runs the proof. */
      const indent = line.search(/\S/)
      let from = at
      while (from > 0 && !/^\s*-\s/.test(lines[from])) from -= 1
      let to = at + 1
      while (to < lines.length && !/^\s*-\s/.test(lines[to]) && !(lines[to].trim() && lines[to].search(/\S/) < indent - 2)) to += 1
      const step = lines.slice(from, to).join('\n')
      /* `-\s*` because the guard can be the step's FIRST key, where YAML
         writes it as `- if: false` — without it the one shape this is
         written to catch was the one it missed. */
      const guard = /^\s*(?:-\s*)?if:\s*(.+)$/m.exec(step)
      /* A TRAILING COMMENT IS STILL `false`. `if: false # disabled while we
         investigate` is the shape a switched-off step actually takes in the
         wild — nobody turns one off without saying why — and requiring the
         value to be the bare word meant the one spelling this is written to
         catch was the one it read as live. YAML ends a plain scalar at ` #`. */
      const value = guard ? guard[1].replace(/\s+#.*$/, '').trim() : ''
      const off = /^(false|'false'|"false"|\$\{\{\s*false\s*\}\})$/.test(value)
      if (off) continue
      found.push(...ids)
    }
    return found
  }

  const named = () => namedIn(WORKFLOW)

  it('runs the deletion proof at all', () => {
    // A regex that matches nothing passes every assertion below it.
    expect(named().length).toBeGreaterThan(0)
  })

  /* THE SCANNER IS HELD TO ITS OWN CLAIM. Every shape it says it ignores is
     put in front of it here, against a workflow written for the purpose — the
     real file cannot demonstrate a case it must not contain. Without this the
     three exclusions are assertions in a comment. */
  it('ignores a commented, documented, or switched-off proof', () => {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'wf-'))
    roots.push(dir)
    const scan = (yaml) => {
      const file = path.join(dir, 'verify.yml')
      writeFileSync(file, yaml)
      return namedIn(file)
    }

    expect(scan('jobs:\n  a:\n    steps:\n      - run: pnpm verify:without sync\n')).toEqual(['sync'])
    expect(scan('jobs:\n  a:\n    steps:\n      # - run: pnpm verify:without sync\n')).toEqual([])
    expect(scan('jobs:\n  a:\n    steps:\n      - name: pnpm verify:without sync\n')).toEqual([])
    expect(
      scan('jobs:\n  a:\n    steps:\n      - if: false\n        run: pnpm verify:without sync\n'),
    ).toEqual([])
    /* WITH THE REASON WRITTEN BESIDE IT, which is how a step is actually
       switched off — and the spelling the first version of this check read as
       a live step, because it required the value to be the bare word. */
    expect(
      scan(
        'jobs:\n  a:\n    steps:\n      - if: false # disabled while we investigate\n        run: pnpm verify:without sync\n',
      ),
    ).toEqual([])
    expect(
      scan("jobs:\n  a:\n    steps:\n      - if: 'false'\n        run: pnpm verify:without sync\n"),
    ).toEqual([])
    /* A REAL CONDITION IS NOT A DISABLED STEP. A proof that runs on pushes to
       main and not on a draft PR is still a proof that runs. */
    expect(
      scan(
        'jobs:\n  a:\n    steps:\n      - if: github.ref == \'refs/heads/main\'\n        run: pnpm verify:without sync\n',
      ),
    ).toEqual(['sync'])
  })

  /**
   * IS THIS THE REAL REPOSITORY, OR THE COPY THIS SCRIPT MAKES?
   *
   * It has to be asked, because the two look identical from inside once the
   * removal has run: a workflow naming a capability the manifest does not
   * declare is the `example` defect above in a checkout, and is simply the
   * proof doing its job in the copy.
   *
   * THE COPY SAYS SO OUTRIGHT — `verifyWithout` puts the id it deleted in the
   * child's environment, and nothing on the real tree sets it. The tell used to
   * be the ABSENCE of `.git`, which the copy does have in common with the real
   * repository's opposite — but so does a source archive, a `cp -r` of a
   * checkout, and anything unpacked from a tarball. In any of those, a stale
   * workflow reference would have been excused for a reason that has nothing to
   * do with this script, and the gate would report green over the exact defect
   * it exists to catch. Absence of a file is not evidence of intent; a name the
   * deleter wrote down is.
   */
  const deleted = () => process.env[DELETED_ENV]

  it('names only ids the manifest declares, and only ones nothing requires', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    const ids = manifest.capabilities.map((c) => c.id)
    for (const id of named()) {
      if (!ids.includes(id)) {
        /* THIS TEST IS ITSELF A TEST THAT NAMES A CAPABILITY FROM THE REAL
         * TREE — the exact class phase 5 wrote down as "a test the deletion
         * proof will find" — and the proof duly found it on the first run.
         *
         * In a checkout, an id the manifest does not declare is the defect
         * this whole block exists for, and it fails. In the copy, the id is
         * missing because `capability:remove` has just taken it out, which is
         * the point; asserted, not skipped, by requiring the removal to be
         * complete — the directory has to be gone too. */
        expect(
          deleted(),
          `verify:without ${id} — the manifest declares ${ids.join(', ')}`,
        ).toBe(id)
        const dir = fileURLToPath(new URL(`../src/capabilities/${id}`, import.meta.url))
        expect(existsSync(dir), `${id} left the manifest but its sources are still here`).toBe(false)
        continue
      }
      const dependents = manifest.capabilities
        .filter((c) => (c.requires ?? []).includes(id))
        .map((c) => c.id)
      expect(dependents, `verify:without ${id} — ${dependents.join(', ')} require it, so removal is refused`).toEqual([])
    }
  })
})
