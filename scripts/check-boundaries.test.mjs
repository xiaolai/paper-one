import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CRUISE_TIMEOUT_MS,
  DEPCRUISE,
  REQUIRES_RULE,
  cruise,
  cruiserViolations,
  formatViolation,
  undeclaredRequires,
} from './check-boundaries.mjs'
import { CASES, LEGAL_TREE, caseFailure, runAll, runCli } from './check-boundaries.selftest.mjs'

/**
 * The boundary selftest under Vitest, so `pnpm test` proves the boundary
 * check can fail. `check-boundaries.selftest.mjs` owns the cases and the
 * fixture tree; this file runs them through its `runAll` — each case an
 * IN-PROCESS cruise, not a child process; the only spawns here are `runCli`'s
 * four — and adds what the standalone runner does not: the pure `requires`
 * pass on hand-made module lists, and the CLI's exit code and line format end
 * to end.
 */

/**
 * ONE CRUISE PER CASE PER `pnpm verify`, not two.
 *
 * `CASES` used to run twice: once through this file's `it.concurrent.each`,
 * and again through the selftest's own `main`, which was `verify.mjs` step 7.
 * `boundaries:selftest` is gone from `STEPS`, and this is now the only place
 * they run — kept over the standalone runner because `test:ledger` names
 * TESTS: cases behind a script leave the ledger, and a deleted case then
 * disappears exactly the way the twelve `pageTurn` tests did. The two
 * asserted the same two conditions, so nothing narrowed.
 *
 * THE COUNT IS DELIBERATELY NOT WRITTEN HERE. It was "27" in four comments
 * while the list held 28, and phase 11 took it to 35 without any of them
 * moving — a number in prose that nothing checks is the same defect the
 * feature ledger's path check exists for. `CASES.length` is the answer.
 *
 * `runAll` rather than `it.concurrent`: the cap is `defaultWidth()`, an
 * explicit `min(6, availableParallelism())` that this repository chose, where
 * `it.concurrent` was governed by vitest's `maxConcurrency` default while
 * competing with every other test file in the run. `runAll` catches per case,
 * so a case that throws fails its OWN name here rather than the hook.
 */
describe('every illegal edge is rejected by the rule that owns it', () => {
  /** Case name -> result, filled once before the assertions below. */
  let results

  beforeAll(async () => {
    results = await runAll(CASES)
    /* 300s, not the 120s a single case used to get: this hook now runs all of
       them. The whole set measures ~3.9s at this cap on an idle machine
       (2026-08-23, 35 cases, three runs within 200ms of each other); the
       21.6s this note used to quote predates both the current cap and the
       current list. The margin is for a loaded machine, not for the set. */
  }, 300_000)

  it.each(CASES.map((c) => [c.name, c]))('%s', (_name, testCase) => {
    const result = results[CASES.indexOf(testCase)]
    expect(caseFailure(result, testCase) ?? 'ok').toBe('ok')
  })
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
  it('exits 0 on the legal tree and says what it cruised', async () => {
    const { code, out, err } = await runCli({})
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toMatch(/^check-boundaries: \d+ modules, \d+ dependencies, 0 violations\n$/)
  }, 120_000)

  it('exits 1 on a violation and prints it as one line naming the rule and the edge', async () => {
    const { code, out } = await runCli({
      'src/kernel/core/other.ts': "import { alpha } from '../../capabilities/alpha/index.ts'\nexport const other = alpha\nexport type OtherType = { m: number }\n",
    })
    expect(code).toBe(1)
    const lines = out.trimEnd().split('\n')
    expect(lines).toContain('no-kernel-to-capabilities src/kernel/core/other.ts -> src/capabilities/alpha/index.ts')
    expect(lines.at(-1)).toMatch(/^check-boundaries: \d+ modules, \d+ dependencies, [1-9]\d* violations$/)
  }, 120_000)

  it('exits 2 when the manifest cannot be trusted, rather than passing with an unchecked requires', async () => {
    const { code, err } = await runCli({ 'capabilities.manifest.json': '{ "capabilities": [ { "id": "alpha" } ] }' })
    expect(code).toBe(2)
    expect(err).toMatch(/capabilities\.manifest\.json is invalid/)
  }, 120_000)

  it('exits 2 when the tree has no kernel — a run that saw the wrong root must not pass', async () => {
    const files = Object.fromEntries(Object.keys(LEGAL_TREE).filter((k) => k.startsWith('src/kernel/')).map((k) => [k, null]))
    const { code, err } = await runCli(files)
    expect(code).toBe(2)
    expect(err).toMatch(/nothing under src\/kernel\/ was cruised/)
  }, 120_000)
})

/**
 * EVERY RULE HAS A CASE, enforced rather than requested.
 *
 * `.dependency-cruiser.cjs`'s own header says "a rule added here needs a
 * fixture there" — and nothing checked it. Two rules had none: the browser
 * client's kernel allow-list, and the rule keeping `@tauri-apps` out of the
 * web build, which did not exist at all until it was tested by hand. A rule
 * nobody has watched fail is a comment, which is the sentence the selftest
 * opens with.
 *
 * `REQUIRES_RULE` is checked by `check-boundaries.mjs` over the cruise's JSON
 * rather than by the cruiser, so it is named here as the one rule whose case
 * carries it as a value.
 */
describe('the rule list and the case list', () => {
  it('has a case for every rule the cruiser config declares', async () => {
    const config = await import('../.dependency-cruiser.cjs')
    const declared = (config.default ?? config).forbidden.map((rule) => rule.name)
    /* NOT EMPTY. A config that failed to load, or a shape that changed, would
       make every assertion below vacuous — which is how a completeness check
       stops checking completeness. */
    expect(declared.length).toBeGreaterThan(10)

    const covered = new Set(CASES.flatMap((one) => one.expect))
    const uncovered = declared.filter((name) => !covered.has(name))
    expect(uncovered, 'every forbidden rule needs a case in check-boundaries.selftest.mjs').toEqual([])
  })

  /* AND NO CASE NAMES A RULE THAT IS GONE. A case expecting a deleted rule can
     never pass, but one expecting a RENAMED rule fails for a reason that reads
     as the edge being legal — which sends the next reader to the wrong file. */
  it('names no rule the config does not declare', async () => {
    const config = await import('../.dependency-cruiser.cjs')
    const declared = new Set((config.default ?? config).forbidden.map((rule) => rule.name))
    declared.add(REQUIRES_RULE)
    const unknown = [...new Set(CASES.flatMap((one) => one.expect))].filter((name) => !declared.has(name))
    expect(unknown, 'a case expects a rule the config no longer has').toEqual([])
  })
})

/**
 * THE TWO WAYS THIS CHECK HAD NEVER RUN ON WINDOWS.
 *
 * Both found the first time the Windows leg got far enough to reach it, and
 * neither is visible from macOS or Linux — which is the reason they are
 * pinned here rather than left to the platform that already agrees.
 */
describe('the cruiser is spawned in a way all three platforms can', () => {
  /* REMOVED AFTERWARDS, AND NEVER FATALLY. Windows keeps a handle on a
     directory while anything is using it and releases it on its own schedule,
     so a removal racing a just-killed child fails `EPERM`. A leftover
     temporary directory is free; a red gate over one is not. */
  /* A directory nothing here deletes, so the child may hold it open freely. */
  const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
  const scratch = []
  afterAll(() => {
    for (const dir of scratch.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* The OS will have it. */
      }
    }
  })

  it('runs the package entry through node, never the .bin shim', () => {
    /* pnpm writes an EXTENSIONLESS shell script at `node_modules/.bin/depcruise`
       beside the `.CMD`. `existsSync` finds it and `spawn` cannot execute it on
       Windows, so the step failed with `ENOENT` on every run. A `.mjs` handed
       to `process.execPath` has no shim, no shell and no quoting. */
    expect(DEPCRUISE.endsWith('.mjs')).toBe(true)
    expect(DEPCRUISE).not.toContain(`${path.sep}.bin${path.sep}`)
  })

  it('gives up on a cruiser that never answers, rather than waiting out the timeout', async () => {
    /* WHAT THIS HOLDS, precisely, because the neighbouring defect is closed by
       construction rather than by a test. `spawn`'s own `timeout` option arms
       a timer it does not clear when the SPAWN ITSELF fails — measured at 1 ms
       for the error and 3002 ms for the exit against a 3 s timeout, which at
       five minutes is what the Windows leg did after printing its `ENOENT`.
       That path is now unreachable: the thing spawned is `process.execPath`,
       which exists wherever node is running, and the test above is what keeps
       it so.

       This one holds the other half. Under `spawn`'s timeout a cruiser that
       never answers was killed and then reported as `did not answer in JSON
       (exit null)` — a parse failure, naming the wrong cause, for a run that
       simply ran long. A timeout says it timed out. */
    const dir = mkdtempSync(path.join(tmpdir(), 'paper-cruise-'))
    const never = path.join(dir, 'never-answers.mjs')
    writeFileSync(never, 'setTimeout(() => {}, 60_000)\n')
    const started = Date.now()
    /* THE CHILD'S WORKING DIRECTORY IS THE REPOSITORY, NOT `dir`, and that is
       load-bearing on Windows. `cruise` passes its root as the child's `cwd`,
       and a process's current directory is an OPEN HANDLE there: killing the
       child does not release it synchronously, so removing `dir` immediately
       afterwards failed `EPERM` — `force: true` does not help, because the
       directory is in use rather than read-only. On POSIX, unlinking a
       directory a live process sits in is legal, which is why this passed on
       both other legs and only appeared under the `scripts` project's own
       concurrency, where the kill and the remove land closest together.
       `dir` holds the fake binary and nothing holds `dir`. */
    await expect(cruise(REPO_ROOT, { bin: never, timeoutMs: 200 })).rejects.toThrow(/did not answer within 200 ms/)
    expect(Date.now() - started).toBeLessThan(10_000)
    /* AND THE REMOVAL IS DEFERRED AND FORGIVING. A temporary directory left
       behind costs nothing; a red gate over one costs a run. */
    scratch.push(dir)
  })

  it('keeps a real timeout far above what one cruise costs', () => {
    expect(CRUISE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })
})
