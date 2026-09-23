import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COPY_EXCLUDE, COPY_STEPS, DELETED_DIRS_ENV, DELETED_ENV, EXCLUDED, copyTree, deletedDirs, digestTree, main, parseArgs, removableCapabilities, verifyWithout } from './verify-without.mjs'
import { STEPS } from './verify.mjs'

/**
 * `pnpm verify:without <id>` — the mechanics: the copy leaves out what it
 * should and links node_modules; the kernel digest sees any byte change;
 * the run removes the capability in the copy, checks the kernel, runs the
 * copy's gates in order, and cleans up (or keeps). The gates themselves are
 * driven through an injected runner here; the real thing is the row's
 * Verify, run once by hand and by CI.
 */


const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * A scratch repository the caller fills in, cleaned up with the rest.
 *
 * `realpathSync` on the tmpdir because macOS's is a symlink and the picker
 * compares repo-relative paths it built itself.
 */
function inScratch(prefix, body) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), prefix))
  roots.push(root)
  body(root)
}

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

/**
 * ⚠️ **THE GATE MEASURED ONE THIRD OF ITS SUBJECT, AND THE THIRD IT MEASURED
 * WAS THE ONE THAT COULD NOT FAIL.**
 *
 * With no id, `main` took `removable[0]` and printed the rest as an aside.
 * `removableCapabilities()` sorts, so the choice was always `circle` — and
 * `circle` is the only removable capability in this tree with no Rust crate.
 * Two gates inside the copy assumed a removal deletes ONE directory, which is
 * true only without a crate; `verify:without webhost` failed on both the first
 * time it was run, on 2026-09-19, long after either could have been caught.
 */
describe('which capabilities the proof runs on', () => {
  /* ⚠️ **`removableCapabilities()` COSTS 2.7 s — IT SCANS EVERY SOURCE FILE**,
     and the first version of these cases called it once per assertion on top of
     the call `main` makes itself. Three of them then took 8 s of scanning each,
     which under load is a 60 s test timeout and reads as a defect in the code
     under test. Read ONCE for the block, and in `beforeAll` rather than in the
     body — a `describe` body runs even when its tests are skipped. */
  let removable
  beforeAll(() => {
    removable = removableCapabilities()
  })

  it('proves EVERY removable capability when none is named, in order', () => {
    const proved = []
    const lines = []
    const code = main([], { prove: (id) => (proved.push(id), { code: 0, dir: '' }), out: (l) => lines.push(l), err: () => {} })
    expect(code).toBe(0)
    expect(proved).toEqual(removable)
    expect(proved.length).toBeGreaterThan(1)
    expect(lines.join()).toContain(`proving all ${proved.length} removable`)
  })

  it('proves only the one named, when one is', () => {
    const proved = []
    expect(main(['circle'], { prove: (id) => (proved.push(id), { code: 0, dir: '' }), out: () => {}, err: () => {} })).toBe(0)
    expect(proved).toEqual(['circle'])
  })

  it('stops at the first failure and names the id, rather than a bare exit code', () => {
    const proved = []
    const lines = []
    const failing = removable[1]
    const code = main([], {
      prove: (id) => (proved.push(id), { code: id === failing ? 7 : 0, dir: '' }),
      out: (l) => lines.push(l),
      err: () => {},
    })
    expect(code).toBe(7)
    expect(proved).toEqual(removable.slice(0, 2))
    expect(lines.join()).toContain(`exit 7 without ${JSON.stringify(failing)}`)
  })

  it('carries --keep to every proof', () => {
    const kept = []
    main(['--keep'], { prove: (_id, opts) => (kept.push(opts.keep), { code: 0, dir: '' }), out: () => {}, err: () => {} })
    expect(kept.length).toBeGreaterThan(1)
    expect([...new Set(kept)]).toEqual([true])
  })

  it('refuses a bad argument with 2, and proves nothing', () => {
    const proved = []
    const errs = []
    expect(main(['--nope'], { prove: (id) => (proved.push(id), { code: 0, dir: '' }), out: () => {}, err: (l) => errs.push(l) })).toBe(2)
    expect(proved).toEqual([])
    expect(errs.join()).toContain('unknown argument')
  })
})

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
  })

  /**
   * The list ITSELF, entry by entry, in order.
   *
   * ⚠️ **IT WAS THREE `toContain`s, AND THE MUTATION GATE FOUND WHAT THAT
   * MISSES.** Every other entry could be replaced with the empty string and
   * nothing failed — so `.codex`, `.agents`, `.cc-suite` and `.DS_Store` were
   * decisions with no reader. This list is not an implementation detail: it is
   * what the deletion proof's copy leaves behind, and `no-binary-source.test.mjs`
   * WALKS with it because the copy has no `.git` to ask. An entry that quietly
   * stopped working there carries build output into a check that then fails on
   * somebody else's test fixture.
   *
   * Written out rather than derived, because a derived assertion would agree
   * with whatever the list says. Adding a toolchain means editing both, which
   * is the cost of saying the list is a decision.
   */
  it('excludes exactly what it says, and nothing else', () => {
    expect([...COPY_EXCLUDE]).toEqual([
      'node_modules',
      '.git',
      'dist',
      '.types',
      'coverage',
      'target', // Cargo
      '.build', // SwiftPM
      '.claude',
      '.codex',
      '.agents',
      '.cc-suite',
      '.DS_Store',
    ])
  })

  /**
   * And the steps the copy runs, in order, with the command each takes.
   *
   * ⚠️ **THE SAME GAP**: every step name and every argument array could be
   * emptied without a test noticing, and a step that runs `pnpm` with no
   * arguments proves nothing while still reporting a pass. The ORDER is part
   * of it — the cheap checks come before the builds, so a tree that will not
   * typecheck says so in seconds rather than after three bundles.
   */
  /**
   * The marker's NAME, as a literal.
   *
   * ⚠️ **EVERY TEST THAT READS IT READS `process.env` DIRECTLY, AND EVERY TEST
   * THAT ASSERTS IT WENT THROUGH THE CONSTANT** — so renaming the constant
   * changed both sides at once and nothing failed, which the mutation gate
   * found by emptying the string. `check-third-party-notices`,
   * `no-invisible-characters` and `kernel-entry` each skip on the literal
   * `PAPER_VERIFY_WITHOUT`; a rename that missed one of them would leave a
   * hard assertion running in a copy that cannot satisfy it, and the deletion
   * proof would fail for a reason that is not about the deletion.
   */
  it('names the two markers the copy’s own tests read', () => {
    expect(DELETED_ENV).toBe('PAPER_VERIFY_WITHOUT')
    expect(DELETED_DIRS_ENV).toBe('PAPER_VERIFY_WITHOUT_DIRS')
  })

  it('runs exactly these steps, in this order, with these arguments', () => {
    expect(COPY_STEPS.map((step) => [step.name, step.cmd, [...step.args]])).toEqual([
      ['typecheck', 'pnpm', ['typecheck']],
      ['boundaries', 'pnpm', ['boundaries']],
      ['architecture:check', 'pnpm', ['architecture:check']],
      ['compositions:check', 'pnpm', ['compositions:check']],
      ['test', 'pnpm', ['test']],
      ['build', 'pnpm', ['build']],
      ['build:ios', 'pnpm', ['build:ios']],
      ['build:android', 'pnpm', ['build:android']],
      ['build:web', 'pnpm', ['build:web']],
      ['build:cli', 'pnpm', ['build:cli']],
    ])
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
    /* THE REMOVAL FIRST, THEN THE STEPS IN `COPY_STEPS` ORDER — derived rather
       than restated, so adding a step is one edit and this still pins that the
       removal runs before any of them and that none is skipped. */
    expect(ran).toEqual(['capability:remove example', ...COPY_STEPS.map((step) => step.name)])
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

  /* ⚠️ **THE ID ALONE LEFT A GATE GUESSING, AND IT GUESSED WRONG** (2026-09-19).
     `checkLedger` and `cargo.test.mjs` both needed to know what the removal
     DELETED, and one of them spelled it from the id as `src/capabilities/<id>`
     — which misses a capability whose `ts` differs, and misses
     `src-tauri/crates/<crate>` entirely. `verify:without webhost` then failed
     on a ledger row naming the crate it had just correctly deleted; `circle`,
     the only capability the proof had been run on, has no crate.

     READ FROM THE SOURCE AND ONCE. The first step takes the entry out of the
     copy's manifest, so asking the copy afterwards answers about a capability
     that is already gone — and asking per step would re-read it for each. */
  it('tells every gate in the copy WHAT it deleted, not only which id', () => {
    const src = source()
    writeFileSync(
      path.join(src, 'capabilities.manifest.json'),
      JSON.stringify({ capabilities: [{ id: 'example', ts: 'example-dir', platforms: ['desktop'], crate: 'tauri-plugin-example' }] }),
    )
    const seen = []
    verifyWithout('example', {
      source: src,
      run: (step, _cwd, env) => (seen.push([step.name, env?.[DELETED_DIRS_ENV]]), 0),
      log: () => {},
    })
    expect(seen.length).toBeGreaterThan(0)
    for (const [name, dirs] of seen) {
      expect(dirs, `${name} was not told`).toBe('src/capabilities/example-dir:src-tauri/crates/tauri-plugin-example')
    }
  })

  it('tells them nothing was deleted when the source has no manifest, rather than throwing', () => {
    /* The fixture tree above has none, and `capability:remove` is the step that
       refuses such a tree by name. Excusing nothing is the fail-closed answer. */
    const seen = []
    verifyWithout('example', {
      source: source(),
      run: (step, _cwd, env) => (seen.push(env?.[DELETED_DIRS_ENV]), 0),
      log: () => {},
    })
    expect(seen.length).toBeGreaterThan(0)
    expect([...new Set(seen)]).toEqual([''])
  })

  it('THROWS on a manifest that is present and will not parse, rather than excusing nothing quietly', () => {
    /* The other side of the ENOENT answer above. Absent means "this tree has no
       capabilities", which the fixture genuinely is; unreadable means something
       is wrong, and a proof that answered "nothing was deleted" for it would
       excuse every stale reference in the copy for a reason nobody was told. */
    const src = source()
    writeFileSync(path.join(src, 'capabilities.manifest.json'), '{ not json')
    expect(() => deletedDirs('example', src)).toThrow(SyntaxError)
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

/**
 * ⚠️ **THE COPY'S STEP LIST DRIFTED FROM THE CANONICAL ONE AND NOTHING SAID SO.**
 *
 * `build:web` and `build:cli` are in `verify.mjs`'s `STEPS` and were absent
 * here, so the deletion proof could pass while the post-removal browser bundle
 * or the CLI was broken — the two surfaces a capability removal is most likely
 * to break, since one runs `assert-bundle` and the other bundles the host that
 * imports a capability directly (2026-09-19 audit).
 *
 * The list is not shared outright: the copy deliberately skips the slow and the
 * tree-specific steps. What is shared is the OBLIGATION — every canonical step
 * is run here or named in `EXCLUDED` with a reason, so the next step added to
 * `verify.mjs` cannot simply go missing.
 */
describe('the steps the copy runs', () => {
  const run = () => new Set(COPY_STEPS.map((step) => step.name))

  it('runs or excuses every canonical step, by name', () => {
    const excused = new Set(Object.keys(EXCLUDED))
    const orphans = STEPS.map((step) => step.name).filter((name) => !run().has(name) && !excused.has(name))
    expect(orphans, 'a step in verify.mjs is neither run in the copy nor excused in EXCLUDED').toEqual([])
  })

  /* EVERY SHIPPING BUILD, spelled out rather than derived — these are the ones
     the omission actually cost, and a case that names them fails if one is
     dropped again even were it excused by mistake. */
  it('builds every artefact the project ships', () => {
    for (const build of ['build', 'build:web', 'build:cli', 'build:ios', 'build:android']) {
      expect(run(), `the deletion proof does not run ${build}`).toContain(build)
    }
  })

  /* AN EXCUSE IS A REASON, not a name in a list. An empty string would satisfy
     the orphan check above and explain nothing to the next reader. */
  it('gives every excused step a reason, and excuses nothing it also runs', () => {
    for (const [name, why] of Object.entries(EXCLUDED)) {
      expect(why.length, `${name} is excused with no reason`).toBeGreaterThan(20)
      expect(run(), `${name} is both run and excused`).not.toContain(name)
    }
  })

  /* AND EVERY EXCUSE NAMES A REAL STEP — an excuse for a step that no longer
     exists is a line that outlived its reason, the `example` shape again. */
  it('excuses only steps that are in the canonical list', () => {
    const canonical = new Set(STEPS.map((step) => step.name))
    for (const name of Object.keys(EXCLUDED)) {
      expect(canonical, `${name} is excused but is not a step verify.mjs runs`).toContain(name)
    }
  })
})

describe('parseArgs and the CLI', () => {
  it('reads the id and --keep, refuses the rest', () => {
    expect(parseArgs(['example'])).toEqual({ id: 'example', keep: false })
    expect(parseArgs(['example', '--keep'])).toEqual({ id: 'example', keep: true })
    expect(parseArgs(['a', 'b'])).toEqual({ error: 'exactly one capability id is expected' })
    expect(parseArgs(['--x'])).toEqual({ error: 'unknown argument "--x"' })
  })

  /* NO ID IS THE ORDINARY CALL, and it used to be an error. The id is derived
     now — see `removableCapabilities` — so what an empty argv carries is the
     absence of an OVERRIDE, not a missing required value. `keep` still rides
     along, which is the pair a reader is most likely to get wrong. */
  it('takes no id at all, and still reads --keep', () => {
    expect(parseArgs([])).toEqual({ keep: false })
    expect(parseArgs(['--keep'])).toEqual({ keep: true })
  })
})

/**
 * WHICH CAPABILITY THE PROOF REMOVES IS DERIVED, NOT TYPED.
 *
 * The three conditions are `removableCapabilities`' own, and the cases below
 * are what stops that function answering vacuously — a picker that returns
 * everything, or nothing, would leave CI green either way.
 */
describe('removableCapabilities', () => {
  const manifest = () =>
    JSON.parse(readFileSync(fileURLToPath(new URL('../capabilities.manifest.json', import.meta.url)), 'utf8'))

  it('finds at least one, or the proof has quietly retired', () => {
    expect(removableCapabilities().length).toBeGreaterThan(0)
  })

  it('reads and normalises each source once, however many capabilities ask', () => {
    /* ⚠️ **THE ASSERTION THE FIX LEAVES BEHIND, BECAUSE THE DEFECT WAS
       INVISIBLE.** `importedOutside` used to read, strip and mask every source
       file once PER CAPABILITY. Nothing failed: the answer was right and the
       only symptom was time — which surfaced as `beforeAll` hitting Vitest's
       10 s hook bound during `pnpm test:coverage`, where nine workers compete,
       and not at all when the file ran alone. A timing test would be flaky on a
       shared machine; the number of reads is deterministic, so that is what is
       pinned.

       The lower bound matters as much as the duplicate check: a memo that
       accidentally returned early, or a scan that stopped finding sources, would
       satisfy "no file read twice" by reading nothing at all. */
    const reads = []
    const counted = (file, encoding) => {
      reads.push(file)
      return readFileSync(file, encoding)
    }
    removableCapabilities(undefined, counted)

    const seen = new Map()
    for (const file of reads) seen.set(file, (seen.get(file) ?? 0) + 1)
    expect([...seen].filter(([, n]) => n > 1)).toEqual([])
    expect(reads.length).toBeGreaterThan(100)
  })

  it('never offers one another capability requires', () => {
    const required = new Set(manifest().capabilities.flatMap((c) => c.requires ?? []))
    for (const id of removableCapabilities()) {
      expect(required.has(id), `${id} is required by another capability, so the remover refuses it`).toBe(false)
    }
  })

  /* THE CONDITION THAT WAS MISSING WHEN THIS WAS TYPED BY HAND. A host import
     survives `capability:remove`, so the tree stops typechecking and the lane
     is red for a reason its own argument check could not see. `sync` is the
     live example: `src/cli/paper.ts` imports it for `openLocalJournal`.

     ⚠️ **THIS CASE USED TO RE-IMPLEMENT THE SCAN IT WAS CHECKING** — the same
     `from '…'` regex, character for character — so it shared every defect the
     production copy had and could not have failed on one (2026-09-19 audit).
     A guard whose test stands in for the path it guards is a guard nobody has
     seen work, which is the lesson `measuredIn` paid for. It is a FIXTURE tree
     now, with one capability per defect the old regex had, and the assertion is
     on `removableCapabilities`' own answer. */
  it('reads an importer through either quote, a dynamic import, and neither a comment nor a longer name', () => {
    inScratch('picker-', (root) => {
      const cap = (id) => ({ id, ts: id, requires: [] })
      writeFileSync(
        path.join(root, 'capabilities.manifest.json'),
        JSON.stringify({ capabilities: ['alpha', 'beta', 'gamma', 'delta'].map(cap) }),
      )
      const src = path.join(root, 'src')
      for (const dir of ['alpha', 'beta', 'gamma', 'delta', 'delta-extra']) {
        mkdirSync(path.join(src, 'capabilities', dir), { recursive: true })
        writeFileSync(path.join(src, 'capabilities', dir, 'index.ts'), 'export const x = 1\n')
      }
      mkdirSync(path.join(src, 'host'), { recursive: true })
      /* Each host file is one defect the old regex had. */
      writeFileSync(path.join(src, 'host/a.ts'), 'import { x } from "../capabilities/alpha"\n')
      writeFileSync(path.join(src, 'host/b.ts'), "/* see from '../capabilities/beta' for why */\nexport const y = 1\n")
      writeFileSync(path.join(src, 'host/c.ts'), "const m = await import('../capabilities/gamma')\n")
      writeFileSync(path.join(src, 'host/d.ts'), "import { z } from '../capabilities/delta-extra'\n")

      expect(
        removableCapabilities(root),
        'alpha is double-quoted, gamma is dynamic — both are imported; beta is named only in a comment and delta only as a longer name, so both are free',
      ).toEqual(['beta', 'delta'])
    })
  })

  /* ⚠️ **SORTED, BECAUSE `main` TAKES THE FIRST AND A RUN HAS TO BE
     REPRODUCIBLE.** Left in the manifest's own order the choice would move
     whenever somebody added a row above another — so a failure seen in CI
     could be about a different capability from the one reproduced by hand,
     with nothing saying the subject had changed. The fixture lists them
     backwards for exactly that reason: a manifest already in order cannot
     tell a sort from no sort. */
  it('answers in a fixed order, whatever order the manifest lists them in', () => {
    inScratch('picker-sorted-', (root) => {
      const cap = (id) => ({ id, ts: id, requires: [] })
      writeFileSync(
        path.join(root, 'capabilities.manifest.json'),
        JSON.stringify({ capabilities: ['zulu', 'mike', 'alpha'].map(cap) }),
      )
      const src = path.join(root, 'src')
      for (const dir of ['zulu', 'mike', 'alpha']) {
        mkdirSync(path.join(src, 'capabilities', dir), { recursive: true })
        writeFileSync(path.join(src, 'capabilities', dir, 'index.ts'), 'export const x = 1\n')
      }
      mkdirSync(path.join(src, 'host'), { recursive: true })
      writeFileSync(path.join(src, 'host/a.ts'), 'export const y = 1\n')
      expect(removableCapabilities(root)).toEqual(['alpha', 'mike', 'zulu'])
    })
  })

  /* AND A TYPE-ONLY IMPORT IS STILL AN IMPORTER. `capability:remove` deletes the
     DIRECTORY, so `import type` stops resolving exactly as a value import does —
     which is why the picker does not simply call `parseCompositionImports`, the
     checker's helper, which skips them by design. */
  it('counts a type-only import, which the composition helper deliberately does not', () => {
    inScratch('picker-type-', (root) => {
      writeFileSync(
        path.join(root, 'capabilities.manifest.json'),
        JSON.stringify({ capabilities: [{ id: 'solo', ts: 'solo', requires: [] }] }),
      )
      const src = path.join(root, 'src')
      mkdirSync(path.join(src, 'capabilities/solo'), { recursive: true })
      writeFileSync(path.join(src, 'capabilities/solo/index.ts'), 'export type X = 1\n')
      mkdirSync(path.join(src, 'host'), { recursive: true })
      writeFileSync(path.join(src, 'host/a.ts'), "import type { X } from '../capabilities/solo'\nexport type Y = X\n")

      expect(removableCapabilities(root)).toEqual([])
    })
  })

  /* THE DIRECTORY IS `ts`, THE DEPENDENCY IS `id`, and they may differ. Every
     entry in the real manifest has them equal, which is why using `id` for both
     went unnoticed — the path simply existed. Here they differ, so a picker
     reading `id` for the path looks for `capabilities/one`, finds nothing, and
     reports the capability removable although a host imports it. */
  it('resolves the directory from ts, not from id', () => {
    inScratch('picker-ts-', (root) => {
      writeFileSync(
        path.join(root, 'capabilities.manifest.json'),
        JSON.stringify({ capabilities: [{ id: 'one', ts: 'the-one', requires: [] }] }),
      )
      const src = path.join(root, 'src')
      mkdirSync(path.join(src, 'capabilities/the-one'), { recursive: true })
      writeFileSync(path.join(src, 'capabilities/the-one/index.ts'), 'export const x = 1\n')
      mkdirSync(path.join(src, 'host'), { recursive: true })
      writeFileSync(path.join(src, 'host/a.ts'), "import { x } from '../capabilities/the-one'\n")

      expect(removableCapabilities(root)).toEqual([])
    })
  })

  /* A COMPOSITION ROOT IS EXEMPT — the remover edits those — AND ONLY THOSE. A
     helper beside them is an ordinary host: it was exempt under the old
     `composition.*` prefix, so an import there made a capability look free. */
  it('exempts the four composition roots and nothing else beside them', () => {
    inScratch('picker-roots-', (root) => {
      writeFileSync(
        path.join(root, 'capabilities.manifest.json'),
        JSON.stringify({ capabilities: [{ id: 'inroot', ts: 'inroot', requires: [] }, { id: 'inhelper', ts: 'inhelper', requires: [] }] }),
      )
      const src = path.join(root, 'src')
      for (const dir of ['inroot', 'inhelper']) {
        mkdirSync(path.join(src, 'capabilities', dir), { recursive: true })
        writeFileSync(path.join(src, 'capabilities', dir, 'index.ts'), 'export const x = 1\n')
      }
      mkdirSync(path.join(src, 'app'), { recursive: true })
      writeFileSync(path.join(src, 'app/composition.desktop.ts'), "import { x } from '../capabilities/inroot'\n")
      writeFileSync(path.join(src, 'app/composition.shared.ts'), "import { x } from '../capabilities/inhelper'\n")

      expect(
        removableCapabilities(root),
        'a real root is exempt; composition.shared.ts is an ordinary host and its import counts',
      ).toEqual(['inroot'])
    })
  })

  /* AND IT DOES NOT SIMPLY ANSWER EVERY CAPABILITY. `peer` is required by every
     other one, so a picker with no `requires` rule would hand CI an id the
     remover refuses — which is the shape the `example` years had. */
  it('leaves out a capability the manifest shows is depended on', () => {
    const required = manifest().capabilities.flatMap((c) => c.requires ?? [])
    expect(required.length, 'the manifest declares no dependencies, so this case proves nothing').toBeGreaterThan(0)
    expect(removableCapabilities()).not.toContain(required[0])
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
 *
 * THOSE TWO WERE NOT ENOUGH, and the third is why this step shipped red.
 * `sync` satisfies both — the manifest declares it, nothing requires it — and
 * `verify:without sync` still failed on every push, because `src/cli/paper.ts`
 * imports the capability directly for `openLocalJournal`. `capability:remove`
 * edits the manifest, the compositions, Cargo, `lib.rs` and the ACL; it has
 * never known about a host, so the removal succeeds and the TYPECHECK is what
 * fails, two steps later, in a message that names a module rather than the
 * argument that doomed it.
 *
 * So the third condition: no host may import the capability. `.dependency-
 * cruiser.cjs` PERMITS composition roots and `src/cli/` to import a capability
 * index, so this is not a boundary violation to be caught elsewhere — it is a
 * fact about which capabilities are removable, and it belongs here.
 *
 * Measured when this was last checked: `peer` is required by every other
 * capability; `sync`, `public` and `webhost` are each imported outside a
 * composition root. `circle` is the only capability in the tree that can
 * actually be removed, which is a much smaller claim than the one this lane was
 * making. (It was `companion` until the AI features were deleted whole.)
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
      /* THE ID IS OPTIONAL NOW — with none, the script derives it (see
         `removableCapabilities`), which is the ordinary call. So what is
         matched is the STEP, and an id is recorded only when one is written
         out. `(?!\S)` stops `verify:withoutx` counting as this step. */
      const runs = [...line.matchAll(/verify:without(?!\S)(?:\s+([A-Za-z0-9._-]+))?/g)]
      if (runs.length === 0) continue
      const ids = runs.map((m) => m[1]).filter((one) => one !== undefined)
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
      found.push({ ids })
    }
    return found
  }

  /** Every live `verify:without` step, and the ids any of them writes out. */
  const stepsIn = (file) => namedIn(file)
  const named = () => stepsIn(WORKFLOW).flatMap((step) => step.ids)

  it('runs the deletion proof at all', () => {
    // A scanner that matches nothing passes every assertion below it.
    expect(stepsIn(WORKFLOW).length).toBeGreaterThan(0)
  })

  /* THE SCANNER IS HELD TO ITS OWN CLAIM. Every shape it says it ignores is
     put in front of it here, against a workflow written for the purpose — the
     real file cannot demonstrate a case it must not contain. Without this the
     three exclusions are assertions in a comment. */
  it('ignores a commented, documented, or switched-off proof', () => {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'wf-'))
    roots.push(dir)
    /** The ids a scanned document names — `[]` for no live step AND for a live
        step with no id, which the two cases below tell apart. */
    const scan = (yaml) => {
      const file = path.join(dir, 'verify.yml')
      writeFileSync(file, yaml)
      return namedIn(file).flatMap((step) => step.ids)
    }
    /** How many live steps it found, which is the other half of the answer. */
    const steps = (yaml) => {
      const file = path.join(dir, 'verify.yml')
      writeFileSync(file, yaml)
      return namedIn(file).length
    }

    expect(scan('jobs:\n  a:\n    steps:\n      - run: pnpm verify:without sync\n')).toEqual(['sync'])
    /* ⚠️ **A STEP WITH NO ID IS THE ORDINARY ONE**, and it has to be told from
       a document with no step at all — the whole point of this scanner is to
       refuse a workflow that has stopped running the proof, and both answer
       `[]` for the ids. */
    expect(steps('jobs:\n  a:\n    steps:\n      - run: pnpm verify:without\n')).toBe(1)
    expect(scan('jobs:\n  a:\n    steps:\n      - run: pnpm verify:without\n')).toEqual([])
    expect(steps('jobs:\n  a:\n    steps:\n      - run: pnpm test\n')).toBe(0)
    /* AND NOT A LONGER WORD THAT STARTS THE SAME WAY. */
    expect(steps('jobs:\n  a:\n    steps:\n      - run: pnpm verify:withoutx\n')).toBe(0)
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
    expect(
      steps('jobs:\n  a:\n    steps:\n      - if: false\n        run: pnpm verify:without\n'),
      'a switched-off step with no id still has to read as switched off',
    ).toBe(0)
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

  /* THE CONDITION THAT WAS MISSING. A host import survives `capability:remove`,
     so the tree stops typechecking and the lane is red for a reason its own
     argument check could not see. Sources only: a capability's own directory is
     about to be deleted, and a composition root is the one place the remover
     already edits. */
  it('names only ids no host imports, since removal would leave the import behind', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url))
    for (const id of named()) {
      const own = path.join('capabilities', id) + path.sep
      const offenders = readdirSync(src, { recursive: true, encoding: 'utf8' })
        .filter((rel) => /\.tsx?$/.test(rel))
        .filter((rel) => !rel.startsWith(own) && !/^app[\\/]composition\./.test(rel))
        .filter((rel) => new RegExp(`from '[^']*capabilities/${id}'`).test(readFileSync(path.join(src, rel), 'utf8')))

      /* In the COPY the capability is gone, so nothing can import it and this
         is trivially empty — the same shape the manifest check uses. In a
         checkout it is the real assertion. */
      expect(
        offenders,
        `verify:without ${id} — ${offenders.join(', ')} import it, and capability:remove does not edit hosts`,
      ).toEqual([])
    }
  })
})

/**
 * The three conditions, driven over a FIXTURE tree rather than this repository.
 *
 * ⚠️ **ELEVEN MUTANTS SURVIVED IN `removableCapabilities` AND `importedOutside`
 * TOGETHER, AND EVERY ONE WAS REAL** — hand-applied on 2026-09-23, each with
 * the whole of this file still green. The cases above ask the real manifest
 * what it answers, which is a fact about this tree and not about the rule: with
 * `.some` turned into `.every`, with the composition roots' anchor dropped,
 * with `startsWith` turned into `endsWith`, this repository's answer happens not
 * to change. A fixture where each condition is the only thing that differs is
 * the only way to ask the rule itself.
 */
describe('removableCapabilities, over a tree built to test one thing at a time', () => {
  /** A repository with the capabilities named, and the sources given. */
  function repoWith(capabilities, sources = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'removable-'))
    roots.push(root)
    writeFileSync(path.join(root, 'capabilities.manifest.json'), JSON.stringify({ capabilities }))
    for (const [rel, text] of Object.entries(sources)) {
      const full = path.join(root, 'src', rel)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, text)
    }
    /* The four composition roots always exist: `removableCapabilities` builds
       its exempt set from `PLATFORMS`, and a root that is not on disk is simply
       never scanned, which would hide the anchor this asserts. */
    for (const platform of ['desktop', 'ios', 'android', 'web']) {
      const full = path.join(root, 'src/app', `composition.${platform}.ts`)
      mkdirSync(path.dirname(full), { recursive: true })
      if (!existsSync(full)) writeFileSync(full, sources[`app/composition.${platform}.ts`] ?? '')
    }
    return root
  }

  const leaf = (id, over = {}) => ({ id, requires: [], ...over })

  it('offers a leaf nothing requires and nothing imports', () => {
    expect(removableCapabilities(repoWith([leaf('alone')]))).toEqual(['alone'])
  })

  it('refuses one another capability requires — and asks whether ANY does, not whether all do', () => {
    /* ⚠️ `.some` → `.every` survived: with two capabilities where exactly one is
       required, `every` answers false for both and offers the required one. */
    const repo = repoWith([leaf('engine'), leaf('user', { requires: ['engine'] })])
    expect(removableCapabilities(repo)).toEqual(['user'])
  })

  it('treats a capability that declares no requires as requiring nothing', () => {
    /* ⚠️ `c.requires ?? []` → `c.requires && []` survived: for a capability with
       no `requires` field the second answers `undefined`, and `.includes` on it
       throws — which only shows where a manifest entry omits the field. */
    const repo = repoWith([{ id: 'bare' }, leaf('other')])
    expect(removableCapabilities(repo)).toEqual(['bare', 'other'])
  })

  it('refuses one a host file imports, and does not mind the capability importing itself', () => {
    /* ⚠️ `!rel.startsWith(own)` → `!rel.endsWith(own)` survived: a capability's
       OWN files stop being exempt, so every capability that imports itself looks
       imported from outside. */
    const repo = repoWith([leaf('used'), leaf('quiet')], {
      'capabilities/used/index.ts': "export const a = 1\n",
      'capabilities/used/lib/inner.ts': "import { a } from '../../used/index'\n",
      'capabilities/quiet/index.ts': "export const b = 2\n",
      'kernel/host.ts': "import { a } from '../capabilities/used'\n",
    })
    expect(removableCapabilities(repo)).toEqual(['quiet'])
  })

  it('does not count an import made by a composition root', () => {
    /* ⚠️ The exempt set is built by stripping `^src/` from each root's path, and
       `/src\//` without the anchor survived — it strips the first `src/`
       anywhere, which for these paths is the same place. A root whose own path
       does not begin with `src/` is what would tell them apart, and there is no
       such root, so the case asserts what the set is FOR instead: a composition
       root may import a capability and it stays removable. */
    const repo = repoWith([leaf('composed')], {
      'capabilities/composed/index.ts': "export const c = 3\n",
      'app/composition.desktop.ts': "import { composed } from '../capabilities/composed'\n",
    })
    expect(removableCapabilities(repo)).toEqual(['composed'])
  })

  it('looks in TypeScript and nowhere else', () => {
    /* ⚠️ `/\.tsx?$/` → `/\.tsx?/` survived: without the anchor a name that
       merely CONTAINS `.ts` is scanned, so a generated `x.ts.map` or a
       `y.tsx.bak` beside the source would be read as if it were source. */
    const repo = repoWith([leaf('js')], {
      'capabilities/js/index.ts': "export const d = 4\n",
      'kernel/host.ts.map': "import '../capabilities/js'\n",
      'kernel/other.tsx.bak': "import '../capabilities/js'\n",
    })
    expect(removableCapabilities(repo), 'only .ts and .tsx are source').toEqual(['js'])
  })

  it('matches a capability directory by its whole name, not by a prefix of one', () => {
    /* ⚠️ `path.join('capabilities', dir) + path.sep` lost either the separator
       or the word and survived both. Without the separator, `capabilities/pub`
       prefixes `capabilities/public`, so the longer one's files count as the
       shorter one's own and its imports stop being seen. */
    const repo = repoWith([leaf('pub'), leaf('public')], {
      'capabilities/pub/index.ts': "export const e = 5\n",
      'capabilities/public/index.ts': "import '../../kernel/host'\n",
      'kernel/host.ts': "import '../capabilities/public'\n",
    })
    expect(removableCapabilities(repo), 'public is imported from the kernel').toEqual(['pub'])
  })

  it('does not read a capability’s own file as evidence against it', () => {
    /* ⚠️ `own` decides which files are the capability's OWN, and two of its
       three mutants lived here: dropping the word `capabilities` makes the
       prefix `pub/`, which no path starts with, and `startsWith` turned into
       `endsWith` matches nothing at all. Either way every file is scanned, and
       a capability that names itself by a full path — which a deep file's
       import of its own index is — becomes a capability imported from outside
       itself. */
    const repo = repoWith([leaf('pub')], {
      'capabilities/pub/index.ts': "export const g = 7\n",
      'capabilities/pub/lib/deep.ts': "import { g } from '../../../capabilities/pub/index'\n",
    })
    expect(removableCapabilities(repo), 'nothing outside pub imports it').toEqual(['pub'])
  })

  it('matches a capability directory by its whole name, separator and all', () => {
    /* ⚠️ The third of `own`'s mutants: without the trailing separator,
       `capabilities/pub` is a prefix of `capabilities/public`, so the longer
       capability's files are read as the shorter one's own — and the import
       that should have refused `pub` is never seen. */
    const repo = repoWith([leaf('pub'), leaf('public')], {
      'capabilities/pub/index.ts': "export const h = 8\n",
      'capabilities/public/index.ts': "import '../../../capabilities/pub/index'\n",
    })
    expect(removableCapabilities(repo), 'public imports pub, from outside pub').toEqual(['public'])
  })

  it('reads the manifest and the tree as TEXT', () => {
    /* ⚠️ Both `'utf8'` arguments survived being emptied, because a Buffer
       coerces to a string in `JSON.parse` and in a regex test — so the answer
       is right and every later `path.join` is one Buffer away from throwing.
       Asserted by the only thing that can see it: a capability whose removal
       depends on reading a source file's CONTENTS. */
    const repo = repoWith([leaf('read')], {
      'capabilities/read/index.ts': "export const f = 6\n",
      'kernel/host.ts': "import '../capabilities/read'\n",
    })
    expect(removableCapabilities(repo), 'the import in host.ts must be read').toEqual([])
  })
})

describe('the command line', () => {
  it('names itself and its arguments when it refuses one', () => {
    /* ⚠️ `USAGE` survived being emptied: nothing asserted the one sentence a
       person sees when they get the arguments wrong. */
    const said = []
    const code = main(['--nonsense'], { prove: () => 0, out: () => {}, err: (line) => said.push(line) })
    expect(code).toBe(2)
    expect(said.join('')).toContain('usage: node scripts/verify-without.mjs [id] [--keep]')
    expect(said.join('')).toContain('unknown argument')
  })
})
