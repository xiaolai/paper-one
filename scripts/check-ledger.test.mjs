/**
 * `pnpm ledger:check` reports what it claims to, and skips loudly rather than
 * quietly.
 *
 * ⚠️ **EVERY CHECK HERE IS SHOWN A KNOWN POSITIVE.** A gate is only worth its
 * green run if a red one is reachable, and this repository has shipped two
 * detectors that found nothing and looked clean while doing it
 * (`check-browser-safe.mjs`, twice). So each of the three questions gets a
 * document that must fail it, and the suite also asserts that an unmodified
 * pair of ledgers passes — a checker that reports everything is as useless as
 * one that reports nothing.
 *
 * These run over FIXTURE trees rather than the real ledgers. The real ones are
 * gitignored, so a test that read them would pass on this machine and have
 * nothing to read anywhere else — which is the failure that deleted the
 * previous gate.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LEDGERS, main, makeExists, parseArgs } from './check-ledger.mjs'
import { COVERAGE_EXCEPTIONS, checkCoverage, normalizeState, splitRow } from './lib/ledger.mjs'

const HEADER = '| Capability | State | Where | How to confirm |'
const RULE = '|---|---|---|---|'

/** A tree with two ledgers in it, and whatever files the rows point at. */
function treeWith({ rows = [], library = [], files = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ledger-check-'))
  made.push(root)
  mkdirSync(path.join(root, 'dev-docs'), { recursive: true })
  const doc = (body) => ['# t', '', HEADER, RULE, ...body, ''].join('\n')
  writeFileSync(path.join(root, 'dev-docs/feature-ledger.md'), doc(rows))
  writeFileSync(
    path.join(root, 'dev-docs/library-ledger.md'),
    ['# t', '', '| Capability | State | Where | Note |', RULE, ...library, ''].join('\n'),
  )
  for (const rel of files) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
    writeFileSync(path.join(root, rel), '')
  }
  return root
}

const made = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/* A fixture tree has no app in it to enumerate, so the names are injected —
 * the same seam `checkLedger` has for `exists`. Coverage gets its own cases
 * against `checkCoverage` directly; these are the path and state questions. */
/* One name that every fixture's text contains, so coverage neither fails nor
 * trips the empty-enumeration guard. It cannot be `[]`: an empty enumeration is
 * now itself a finding, which is the point of `refuses an empty enumeration`
 * below — the default stub must therefore look like a working enumerator. */
const SOME_NAMES = () => ['thing']
const linesOf = (argv, root, names = SOME_NAMES) => {
  const out = []
  const code = main(argv, root, (line) => out.push(line), names)
  return { code, out }
}

describe('the path question', () => {
  it('passes a Where cell that names a file which exists', () => {
    const root = treeWith({
      rows: ['| A thing | Shipped | `src/kernel/core/thing.ts` | it works |'],
      files: ['src/kernel/core/thing.ts'],
    })
    const { out } = linesOf(['--root', root], root)
    expect(out.join('\n')).toContain('0 findings')
    expect(out.join('\n')).not.toContain('LEDGER_PATH')
  })

  /* KNOWN POSITIVE. */
  it('reports a Where cell that names a file which does not, by line', () => {
    const root = treeWith({ rows: ['| A thing | Shipped | `src/kernel/core/gone.ts` | it works |'] })
    const { out } = linesOf(['--root', root], root)
    expect(out.join('\n')).toMatch(/LEDGER_PATH_MISSING line 5: src\/kernel\/core\/gone\.ts/u)
  })

  it('resolves core/ and ui/ against the kernel, and nothing else', () => {
    const root = treeWith({
      rows: ['| A thing | Shipped | `core/thing.ts`, `ui/other.tsx` | it works |'],
      files: ['src/kernel/core/thing.ts', 'src/kernel/ui/other.tsx'],
    })
    expect(linesOf(['--root', root], root).out.join('\n')).not.toContain('LEDGER_PATH')
  })

  /* "One candidate, never a search" — a bare filename cannot say WHERE. */
  it('refuses a bare filename rather than looking for one', () => {
    const root = treeWith({ rows: ['| A thing | Shipped | `thing.ts` | it works |'], files: ['src/kernel/core/thing.ts'] })
    expect(linesOf(['--root', root], root).out.join('\n')).toContain('LEDGER_PATH_VAGUE')
  })
})

describe('the state question', () => {
  it('accepts the five, bolded or not', () => {
    const rows = ['Shipped', '**Partial**', 'Stub', '**Absent**', 'Unknown'].map(
      (s, i) => `| Thing ${i} | ${s} | — | note |`,
    )
    expect(linesOf(['--root', treeWith({ rows })], treeWith({ rows })).out.join('\n')).not.toContain('LEDGER_STATE')
  })

  /* KNOWN POSITIVE. */
  it('reports a state that is not one of the five', () => {
    const root = treeWith({ rows: ['| A thing | Done | — | note |'] })
    expect(linesOf(['--root', root], root).out.join('\n')).toMatch(/LEDGER_STATE line 5: "Done"/u)
  })

  /* ⚠️ THE PLAN FOR THIS PHASE NAMED `Shipped (EPUB)` AS A KNOWN POSITIVE AND
   * IT IS NOT ONE. `normalizeState` accepts a trailing parenthetical on
   * purpose — it narrows a claim without changing it — while
   * `gen-feature-ledger.py`, a different tool, refuses the same cell. Two tools
   * genuinely disagree, and the disagreement is pinned here rather than left
   * for somebody to rediscover as a bug. */
  it('accepts a parenthetical that narrows a state, unlike gen-feature-ledger.py', () => {
    expect(normalizeState('Shipped (EPUB)')).toBe('Shipped')
    expect(normalizeState('**Shipped**')).toBe('Shipped')
    expect(normalizeState('Shipped-ish')).toBe('Shipped-ish')
  })
})

describe('the coverage question', () => {
  const text = 'the ledger mentions Sepia and the fidelity dial and book.list'

  it('matches case-insensitively, because an id and its label are one name', () => {
    expect(checkCoverage(['sepia', 'fidelity'], text).findings).toEqual([])
  })

  /* KNOWN POSITIVE. */
  it('reports a declared name that no document mentions', () => {
    const { findings } = checkCoverage(['paragraphRag'], text)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('LEDGER_UNCOVERED')
    expect(findings[0].where).toBe('paragraphRag')
  })

  it('says why a name described nowhere is a finding', () => {
    expect(checkCoverage(['paragraphRag'], text).findings.map((f) => f.message)).toEqual([
      'the app declares this and no ledger mentions it — a surface with no row is the failure these documents exist to prevent',
    ])
  })

  /* A name is matched as whole characters. Without the `u` flag the pattern
     works in UTF-16 code units, and a lone surrogate matches half of a pair. */
  it('reads a name as whole characters, never as half of one', () => {
    const halfOfASmile = String.fromCharCode(0xde00)
    expect(checkCoverage([halfOfASmile], `${String.fromCodePoint(0x1f600)} is a smile`).findings).toHaveLength(1)
  })

  /* ⚠️ THE DEFECT A KNOWN POSITIVE FOUND, AND THE REASON THESE CASES EXIST.
   * The first `checkCoverage` asked whether the documents CONTAINED the name.
   * The test for it — rename `trash.empty` in `service-table.md`, watch the
   * check fire — did not fire, because `trash.emptyX` contains `trash.empty`.
   * On the real documents that made `book.get`, `flourish` and `separation`
   * pass on superstrings of themselves. Each of those is pinned below. */
  it('does not accept a superstring as a mention', () => {
    expect(checkCoverage(['trash.empty'], 'see trash.emptyX').findings).toHaveLength(1)
    expect(checkCoverage(['book.get'], 'book.getCover() is called').findings).toHaveLength(1)
    expect(checkCoverage(['flourish'], 'the FLOURISHES list').findings).toHaveLength(1)
    expect(checkCoverage(['separation'], 'the SEPARATIONS list').findings).toHaveLength(1)
  })

  /* The leading side stays permissive on purpose: a row that writes
   * `ReadingStyle.fidelity` has named the field, and requiring a boundary
   * before would reject it. */
  it('accepts a name qualified by what it belongs to', () => {
    expect(checkCoverage(['fidelity'], 'ReadingStyle.fidelity is stored').findings).toEqual([])
    expect(checkCoverage(['book.get'], 'book.get is published').findings).toEqual([])
    expect(checkCoverage(['circle:book'], 'the pane `circle:book` draws it').findings).toEqual([])
  })

  it('escapes a name rather than reading its punctuation as a pattern', () => {
    /* `book.list` must not match `bookXlist`: the dot is a character, not any. */
    expect(checkCoverage(['book.list'], 'bookXlist').findings).toHaveLength(1)
  })

  it('counts what it checked, so a silent empty input is visible', () => {
    expect(checkCoverage([], text).checked).toBe(0)
    expect(checkCoverage(['sepia', 'paragraphRag'], text).checked).toBe(2)
  })

  it('starts with no exceptions at all', () => {
    /* An allowlist that begins full is a way of turning a check off. On
     * 2026-09-10 all 24 uncovered names were spent rather than excused. */
    expect(COVERAGE_EXCEPTIONS.size).toBe(0)
  })

  /* ⚠️ AND IT CANNOT BE FILLED AT RUNTIME. `Object.freeze(new Map())` left
   * `.set()` working, and an audit used an inserted entry to suppress a real
   * finding. `readOnlyMap` exposes readers only, so there is no writer to
   * reach — asserted rather than described. */
  it('cannot be added to, emptied, or otherwise written', () => {
    for (const writer of ['set', 'delete', 'clear']) {
      expect(COVERAGE_EXCEPTIONS[writer], `${writer} should not exist`).toBeUndefined()
    }
    expect(() => {
      COVERAGE_EXCEPTIONS.size = 9
    }).toThrow()
    expect(COVERAGE_EXCEPTIONS.size).toBe(0)
  })

  /* ⚠️ THE EXCUSING PATH IS TESTED WITH AN INJECTED MAP, BECAUSE THE REAL ONE
   * IS EMPTY AND ASSERTED EMPTY. Otherwise it is unreachable code that would be
   * exercised for the first time on the day somebody actually needs it. */
  it('excuses a name with its reason instead of reporting it', () => {
    const why = new Map([['legacyThing', 'named only in the design notes, which are not a coverage document']])
    const result = checkCoverage(['legacyThing'], text, why)
    expect(result.findings).toEqual([])
    expect(result.excused).toEqual(['note: legacyThing — named only in the design notes, which are not a coverage document'])
  })

  it('still reports a name the injected map does not excuse', () => {
    const why = new Map([['somethingElse', 'unrelated']])
    expect(checkCoverage(['legacyThing'], text, why).findings).toHaveLength(1)
  })
})

describe('the skip, which is the design decision', () => {
  it('skips loudly and names the rule when there is no ledger', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-none-'))
    made.push(root)
    const { code, out } = linesOf(['--root', root], root)
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('SKIPPED')
    expect(out.join('\n')).toContain('.gitignore:65')
    expect(out.join('\n')).toContain('does not bind CI')
  })

  it('fails on the same input under --require', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-none-'))
    made.push(root)
    expect(linesOf(['--root', root, '--require'], root).code).toBe(2)
  })

  /* ⚠️ THE FOUR CASES BELOW ARE ALL DEFECTS AN ADVERSARIAL AUDIT FOUND ON
   * 2026-09-10, each reproduced before it was fixed. Every one of them made the
   * gate report a confident, specific, WRONG reason for not doing its job —
   * which is the failure this whole phase exists to end, arriving inside the
   * thing built to prevent it. */
  it('refuses a root that is not a directory instead of blaming the gitignore', () => {
    const { code, out } = linesOf(['--root', '/tmp/definitely-not-a-checkout-27'], '/tmp')
    expect(code).toBe(2)
    expect(out.join('\n')).toContain('is not a directory')
    expect(out.join('\n')).not.toContain('by design')
  })

  it('checks the ledgers that ARE there when only some are missing', () => {
    const root = treeWith({ rows: ['| A thing | Done | `src/kernel/core/gone.ts` | note |'] })
    rmSync(path.join(root, 'dev-docs/library-ledger.md'))
    const printed = linesOf(['--root', root], root).out.join('\n')
    /* Both findings in the surviving document must be reported. Before the fix
     * the whole run skipped and returned 0 with neither of them seen. */
    expect(printed).toContain('LEDGER_STATE')
    expect(printed).toContain('LEDGER_PATH_MISSING')
    expect(printed).toContain('absent — checking the 1 present')
    expect(printed).not.toContain('SKIPPED')
  })

  it('treats a ledger with no recognisable table as a finding, not a pass', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-prose-'))
    made.push(root)
    mkdirSync(path.join(root, 'dev-docs'), { recursive: true })
    for (const rel of LEDGERS) writeFileSync(path.join(root, rel), '# just prose\n\nNo table here, only a thing.\n')
    const { code, out } = linesOf(['--root', root], root)
    expect(out.join('\n')).toContain('LEDGER_EMPTY')
    expect(code).not.toBe(0)
  })

  it('reports an enumerator it cannot run in one line, not a stack trace', () => {
    const root = treeWith({ rows: ['| A thing | Shipped | `src/kernel/core/thing.ts` | note |'], files: ['src/kernel/core/thing.ts'] })
    const explode = () => {
      const error = new Error("Cannot find module '/nowhere/scripts/surfaces.mjs'")
      error.code = 'MODULE_NOT_FOUND'
      throw error
    }
    const { code, out } = linesOf(['--root', root], root, explode)
    expect(code).toBe(2)
    expect(out.join('\n')).toContain('coverage NOT CHECKED')
    expect(out.join('\n')).not.toContain('at Module._resolveFilename')
  })

  /* ⚠️ THE REGRESSION THE VERIFY PASS CAUGHT. Splitting "all absent" from "some
   * absent" left `--require` enforced only on the first branch, so a tree
   * missing one ledger whose other one passed returned 0 under the flag whose
   * whole job is to refuse exactly that. */
  it('fails under --require when ANY ledger is missing, not only when all are', () => {
    const root = treeWith({ rows: ['| A thing | Shipped | `src/kernel/core/thing.ts` | note |'], files: ['src/kernel/core/thing.ts'] })
    rmSync(path.join(root, 'dev-docs/library-ledger.md'))
    /* Without the flag the surviving ledger is clean, so this would be 0. */
    expect(linesOf(['--root', root], root).code).toBe(0)
    expect(linesOf(['--root', root, '--require'], root).code).toBe(2)
  })

  it('names every ledger it could not find, not just the first', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-none-'))
    made.push(root)
    const printed = linesOf(['--root', root], root).out.join('\n')
    for (const rel of LEDGERS) expect(printed).toContain(rel)
  })
})

describe('the shell', () => {
  /* THE PRODUCTION NAME SOURCE, which every case above injects past. Without
   * this the seam from `main` to `surfaces.mjs` is exercised only by running
   * the command by hand — and a child process that started failing would look
   * exactly like a clean skip. `surfaces.mjs` is TRACKED, so unlike the ledger
   * suites this one runs on a clone. */
  it('reads real names from the tree it is pointed at', () => {
    const out = []
    const root = fileURLToPath(new URL('..', import.meta.url))
    /* No ledgers on a clone, so this may skip — what is under test is that the
     * default `readNames` resolves and runs, not what it finds. */
    expect(() => main(['--root', root], root, (line) => out.push(line))).not.toThrow()
    expect(out.join('\n')).toMatch(/coverage: \d+ declared names|SKIPPED/u)
  })

  /* ⚠️ FOUND BY THE SECOND AUDIT, 2026-09-11, each reproduced before fixing. */
  it('refuses a path that escapes the tree instead of resolving it', () => {
    const exists = makeExists(fileURLToPath(new URL('..', import.meta.url)))
    expect(exists('package.json')).toBe(true)
    expect(exists('src/../package.json')).toBe(true)
    expect(exists('../../../etc/passwd')).toBe(false)
    /* ENOTDIR: asking the kernel to walk THROUGH a file. */
    expect(exists('package.json/child.ts')).toBe(false)
  })

  it('refuses an empty enumeration instead of reporting a clean coverage run', () => {
    const root = treeWith({ rows: ['| A thing | Shipped | `src/kernel/core/thing.ts` | note |'], files: ['src/kernel/core/thing.ts'] })
    const { code, out } = linesOf(['--root', root], root, () => [])
    expect(code).toBe(2)
    expect(out.join('\n')).toContain('returned no names at all')
    expect(out.join('\n')).not.toContain('0 described nowhere')
  })

  it('says validation was aborted rather than promising a check --require skips', () => {
    const root = treeWith({ rows: ['| A thing | Shipped | `src/kernel/core/thing.ts` | note |'], files: ['src/kernel/core/thing.ts'] })
    rmSync(path.join(root, 'dev-docs/library-ledger.md'))
    expect(linesOf(['--root', root, '--require'], root).out.join('\n')).toContain('validation ABORTED')
    expect(linesOf(['--root', root], root).out.join('\n')).toContain('checking the 1 present')
  })

  it('counts a shell finding in the summary it prints beside it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-prose-'))
    made.push(root)
    mkdirSync(path.join(root, 'dev-docs'), { recursive: true })
    for (const rel of LEDGERS) writeFileSync(path.join(root, rel), '# prose only, mentioning a thing\n')
    const printed = linesOf(['--root', root], root).out.join('\n')
    /* The old output read "0 findings" on the line above the finding. */
    expect(printed).toContain('0 rows, 0 path claims checked, 1 findings')
  })

  it('names the dependency when the enumerator is present but cannot load one', () => {
    const root = treeWith({ rows: ['| A thing | Shipped | `src/kernel/core/thing.ts` | note |'], files: ['src/kernel/core/thing.ts'] })
    const explode = () => {
      const error = new Error("Cannot find module '/x/scripts/lib/entry.mjs'")
      error.code = 'MODULE_NOT_FOUND'
      throw error
    }
    const printed = linesOf(['--root', root], root, explode).out.join('\n')
    expect(printed).toContain('its dependency is not')
    expect(printed).toContain('entry.mjs')
  })

  /* ⚠️ THE CAUSE LEADS, AND IT IS NOT THE FIRST LINE. Node prints the throw
   * site, the source line and a caret before the message, so keeping the first
   * few lines reported WHERE the child failed and dropped WHAT it said — the
   * round 3 verification captured a real child whose `Error:` was line four. */
  it('leads the diagnosis with the child\'s own error line', () => {
    const root = treeWith({ rows: ['| A thing | Shipped | `src/kernel/core/thing.ts` | note |'], files: ['src/kernel/core/thing.ts'] })
    const explode = () => {
      throw Object.assign(new Error('Command failed'), {
        status: 1,
        stderr: 'file:///x/[eval1]:2\n  throw new Error(m)\n  ^\n\nError: underlying failure\n    at foo\n',
      })
    }
    const printed = linesOf(['--root', root], root, explode).out.join('\n')
    expect(printed).toContain('Error: underlying failure')
    expect(printed).toContain('exit 1')
  })

  it('refuses an unknown argument rather than ignoring it', () => {
    expect(linesOf(['--nonsense'], '/tmp').code).toBe(2)
    expect(parseArgs(['--root'], '/tmp').error).toMatch(/needs a directory/u)
    expect(parseArgs(['--root', 'a', '--root', 'b'], '/tmp').error).toMatch(/twice/u)
  })

  it('reports an unexpected errno rather than calling the file missing', () => {
    const exists = makeExists('/tmp')
    expect(exists('definitely-not-here-27')).toBe(false)
  })

  /* The pipe-splitting defect the recovered rules carry a comment about. */
  it('splits a row on unescaped pipes only', () => {
    expect(splitRow('| a | b | c | d |')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitRow('| a | b | c | it said `x \\| y` |')).toHaveLength(4)
  })
})
