import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeExists } from '../check-feature-ledger.mjs'
import { DELETED_ENV } from '../verify-without.mjs'
import {
  EXTERNAL,
  STATES,
  TABLE_HEADER,
  TABLE_HEADERS,
  checkLedger,
  formatFinding,
  formatSummary,
  isPathClaim,
  normalizeState,
  parseRows,
  pathClaims,
  resolveClaim,
  splitRow,
} from './ledger.mjs'

/**
 * The ledger rules, one by one, over markdown handed in — what counts as a
 * table, what counts as a path claim among the identifiers and code fragments
 * beside it, where a claim resolves, and each finding of the whole check.
 *
 * The cases that matter are the REJECTIONS. A checker that accepted
 * `$APPDATA/books/<bookId>/` or found `session.ts` by searching would pass a
 * ledger whose `Where` column had stopped saying where — which is the failure
 * this guard exists for, not a missing file.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const LEDGER_FILE = path.join(REPO_ROOT, 'docs/feature-ledger.md')
const SEP = '|---|---|---|---|'
const table = (...rows) => [TABLE_HEADER, SEP, ...rows].join('\n')
/** A tree where only these paths exist. */
const treeOf = (...paths) => (rel) => paths.includes(rel)

/**
 * THE SECOND HEADER IS SCANNED, and this is what says so.
 *
 * `docs/library-ledger.md` writes "Note" where `docs/feature-ledger.md` writes
 * "How to confirm". Matching only the first is why the library ledger went
 * unchecked for nine phases: the gate ran, found its one table shape, and
 * reported zero findings over a file it had never opened a row of.
 */
describe('the table headers', () => {
  it('scans both shapes the two ledgers write', () => {
    const rowOf = (header) =>
      parseRows([header, SEP, '| A | Shipped | `core/a.ts` | x |'].join('\n')).rows
    for (const header of TABLE_HEADERS) {
      expect(rowOf(header).map((r) => r.where), header).toEqual(['`core/a.ts`'])
    }
  })

  it('scans nothing under a header with a third name for that column', () => {
    /* Not a loosened pattern: an unrecognised table is INVISIBLE, which shows
       up as its rows never being checked rather than as half of them being. */
    expect(parseRows(['| Capability | State | Where | Why |', SEP, '| A | Shipped | `core/a.ts` | x |'].join('\n')).rows)
      .toEqual([])
  })

  it('keeps TABLE_HEADER as the first of them, which fixtures build with', () => {
    expect(TABLE_HEADER).toBe(TABLE_HEADERS[0])
  })
})

describe('splitRow', () => {
  it('takes the cells between the outer pipes', () => {
    expect(splitRow('| a | b | c | d |')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps an escaped pipe inside its cell', () => {
    expect(splitRow(String.raw`| a | b \| c | d | e |`)).toEqual(['a', String.raw`b \| c`, 'd', 'e'])
  })
})

describe('parseRows', () => {
  it('reads the rows of an inventory table and numbers their lines', () => {
    const { rows, findings } = parseRows(table('| Cap | Shipped | `core/a.ts` | how |'))
    expect(findings).toEqual([])
    expect(rows).toEqual([{ line: 3, capability: 'Cap', state: 'Shipped', where: '`core/a.ts`', confirm: 'how' }])
  })

  it('ignores tables that are not the inventory', () => {
    const other = ['| Code | Reader | Why |', '|---|---|---|', '| Rst | Readest | peer |'].join('\n')
    expect(parseRows(other).rows).toEqual([])
  })

  it('stops at the first line that is not a row, so prose after a table is not swallowed', () => {
    const md = `${table('| A | Shipped | — | x |')}\n\nSome prose | with a pipe in it.`
    expect(parseRows(md).rows).toHaveLength(1)
  })

  it('reads every inventory table in the file', () => {
    const md = `${table('| A | Shipped | — | x |')}\n\n## Next\n\n${table('| B | Absent | — | y |')}`
    expect(parseRows(md).rows.map((r) => r.capability)).toEqual(['A', 'B'])
  })

  it('reports a row that is not four cells rather than reshaping it', () => {
    const { rows, findings } = parseRows(table('| A | Shipped | — |'))
    expect(rows).toEqual([])
    expect(findings[0].code).toBe('LEDGER_ROW_SHAPE')
    expect(findings[0].message).toContain('3 cells')
  })
})

describe('normalizeState', () => {
  it('sees through bold', () => {
    expect(normalizeState('**Shipped**')).toBe('Shipped')
  })

  it('sees through a narrowing parenthetical', () => {
    expect(normalizeState('Shipped (macOS)')).toBe('Shipped')
  })

  it('leaves anything else alone, so the finding can name it', () => {
    expect(normalizeState('Mostly done')).toBe('Mostly done')
  })
})

describe('isPathClaim', () => {
  it.each(['core/marks.ts', 'ui/reader/wordSnap/', 'scripts/mark-tints.mjs', 'paginator.js', 'ui/pane/SidePane.tsx:273'])(
    'accepts %s',
    (token) => expect(isPathClaim(token)).toBe(true),
  )

  it.each([
    'MARK_TINTS',
    'ensureLang',
    'workId',
    "kind: 'bookmark'",
    'hyphens: auto',
    'book.getCover()',
    'check-compositions',
  ])('rejects the identifier or fragment %s', (token) => expect(isPathClaim(token)).toBe(false))

  it.each(['$APPDATA/books/<bookId>/', 'src/capabilities/{peer,sync}', 'content.<ext>', 'src/**/*.ts'])(
    'rejects the template or glob %s — it names no single file',
    (token) => expect(isPathClaim(token)).toBe(false),
  )
})

describe('pathClaims', () => {
  it('takes the claims and leaves the identifiers, in order', () => {
    const where = '`core/metrics.ts` `SPACING`, `ui/reader/bookCss.ts`'
    expect(pathClaims(where)).toEqual(['core/metrics.ts', 'ui/reader/bookCss.ts'])
  })

  it('strips a line suffix, because a line number is not part of a path', () => {
    expect(pathClaims('`ui/screens/Reader.tsx:663`')).toEqual(['ui/screens/Reader.tsx'])
  })

  it('finds nothing in a cell that is only prose', () => {
    expect(pathClaims('Settings → Page → Flow')).toEqual([])
  })
})

describe('resolveClaim', () => {
  it('resolves the kernel shorthands', () => {
    expect(resolveClaim('core/marks.ts')).toEqual({ path: 'src/kernel/core/marks.ts' })
    expect(resolveClaim('ui/pane/Settings.tsx')).toEqual({ path: 'src/kernel/ui/pane/Settings.tsx' })
  })

  it('takes anything else from the repo root', () => {
    expect(resolveClaim('scripts/mark-tints.mjs')).toEqual({ path: 'scripts/mark-tints.mjs' })
  })

  it('drops a trailing slash so a directory and its name are one claim', () => {
    expect(resolveClaim('ui/reader/wordSnap/')).toEqual({ path: 'src/kernel/ui/reader/wordSnap' })
  })

  it('refuses a bare filename rather than searching for it', () => {
    /* The whole point of the column is to say WHERE. A checker that found some
     * `session.ts` would let the column stop answering that. */
    expect(resolveClaim('session.ts').error).toContain('names no directory')
  })
})

describe('checkLedger', () => {
  it('passes a ledger whose paths all exist', () => {
    const md = table('| A | Shipped | `core/a.ts` | how |')
    const result = checkLedger({ markdown: md, exists: treeOf('src/kernel/core/a.ts') })
    expect(result.findings).toEqual([])
    expect(result.summary).toEqual({ rows: 1, claims: 1, findings: 0 })
  })

  it('names a path that does not exist, with what it resolved to', () => {
    const md = table('| A | Shipped | `core/gone.ts` | how |')
    const [f] = checkLedger({ markdown: md, exists: treeOf() }).findings
    expect(f.code).toBe('LEDGER_PATH_MISSING')
    expect(f.message).toBe('core/gone.ts → src/kernel/core/gone.ts does not exist')
  })

  it('catches the kernel carve — a path under the old lib/ root', () => {
    /* The drift this guard was written for: every Where cell said `lib/…`
     * for months after the directory stopped existing. */
    const md = table('| A | Shipped | `lib/marks.ts` | how |')
    const [f] = checkLedger({ markdown: md, exists: treeOf('src/kernel/core/marks.ts') }).findings
    expect(f.code).toBe('LEDGER_PATH_MISSING')
  })

  it('accepts a directory as an answer', () => {
    const md = table('| A | Shipped | `ui/reader/wordSnap/` | how |')
    expect(checkLedger({ markdown: md, exists: treeOf('src/kernel/ui/reader/wordSnap') }).findings).toEqual([])
  })

  it('reports an external path as a note and not a finding', () => {
    const md = table('| A | Shipped | fork `paginator.js` | how |')
    const result = checkLedger({ markdown: md, exists: treeOf() })
    expect(result.findings).toEqual([])
    expect(result.notes[0]).toContain('paginator.js')
  })

  it('refuses a state the legend does not define', () => {
    const md = table('| A | Mostly | `core/a.ts` | how |')
    const [f] = checkLedger({ markdown: md, exists: treeOf('src/kernel/core/a.ts') }).findings
    expect(f.code).toBe('LEDGER_STATE')
    expect(f.message).toContain('Mostly')
  })

  it('refuses a legend that has drifted from the states this check knows', () => {
    const legend = ['| **Shipped** | done |', '| **Nearly** | not done |'].join('\n')
    const md = `${legend}\n\n${table('| A | Shipped | — | how |')}`
    const codes = checkLedger({ markdown: md, exists: treeOf() }).findings.map((f) => f.code)
    expect(codes).toContain('LEDGER_LEGEND')
  })

  it('reports a vague claim separately from a missing one', () => {
    const md = table('| A | Shipped | `session.ts` | how |')
    const [f] = checkLedger({ markdown: md, exists: treeOf() }).findings
    expect(f.code).toBe('LEDGER_PATH_VAGUE')
  })
})

describe('output', () => {
  it('prints a finding as code, where, message', () => {
    expect(formatFinding({ code: 'X', where: 'line 3', message: 'nope' })).toBe('X line 3: nope')
  })

  it('prints a summary that says how much was actually checked', () => {
    expect(formatSummary({ rows: 107, claims: 120, findings: 0 })).toBe(
      'features-check: 107 rows, 120 path claims checked, 0 findings',
    )
  })
})

describe('the constants the ledger and this check share', () => {
  it('knows the five states', () => {
    expect(STATES).toEqual(['Shipped', 'Partial', 'Stub', 'Absent', 'Unknown'])
  })

  it('gives every external path a reason', () => {
    for (const [claim, reason] of EXTERNAL) {
      expect(claim).not.toBe('')
      expect(reason.length).toBeGreaterThan(10)
    }
  })
})

/**
 * And the real thing. The unit cases above run over fragments; these two run
 * over the committed ledger and the tree beside it, which is the only place
 * the guard's actual claim — "this document describes code that exists" — can
 * be made.
 */
/**
 * UNCONDITIONAL, and it used to be `describe.skipIf(!existsSync(LEDGER_FILE))`.
 *
 * The reasoning was that a tree without the ledger — a source archive, a copy
 * made without docs — should skip rather than fail. But the file is COMMITTED,
 * so the condition is true in every real checkout, and the gate was buying a
 * theoretical case at a real cost: three names in `tests/ledger.json` that are
 * collected only where the file exists. That ledger cannot hold a conditional
 * name, because "gone" and "not collected here" are the same observation to
 * it — the exact hazard its own header warns about, sitting in it.
 *
 * A tree genuinely missing the file now FAILS here, by name, which is the
 * better answer anyway: a ledger check that quietly does not run is
 * indistinguishable from one that passed.
 */
describe('the committed ledger', () => {
  const markdown = existsSync(LEDGER_FILE)
    ? readFileSync(LEDGER_FILE, 'utf8')
    : /* Not thrown at module scope: a throw there takes the whole FILE down,
       * including the suites below that have nothing to do with this one. An
       * empty document fails the "makes real claims" assertion by name. */
        ''
  /* Honours DELETED_ENV for the same reason the shell does: this suite runs
   * inside `verify:without`'s copy, where one capability's directory is gone
   * on purpose. */
  const result = checkLedger({ markdown, exists: makeExists(REPO_ROOT), removed: process.env[DELETED_ENV] })

  it('names only paths that exist', () => {
    expect(result.findings.map(formatFinding)).toEqual([])
  })

  it('is worth checking — it makes real claims, not none', () => {
    /* A parser that silently matched nothing would report zero findings and
     * mean nothing by it. */
    expect(result.summary.rows).toBeGreaterThan(50)
    expect(result.summary.claims).toBeGreaterThan(50)
  })

  it('names every path the EXTERNAL allowlist excuses, so the list cannot rot', () => {
    expect([...EXTERNAL.keys()].filter((claim) => !result.external.has(claim))).toEqual([])
  })
})

describe('a tree the removal proof has just edited', () => {
  /* `verify:without sync` deletes src/capabilities/sync and then runs the
   * gates. The Sync row names that directory, and the ledger is not wrong for
   * describing the app as shipped — so the claim is excused, by name. */
  const md = table('| Sync | Partial | `src/capabilities/sync`, `src/capabilities/peer` | how |')
  const tree = treeOf('src/capabilities/peer')

  it('is a finding with no capability removed', () => {
    expect(checkLedger({ markdown: md, exists: tree }).findings.map((f) => f.code)).toEqual(['LEDGER_PATH_MISSING'])
  })

  it('is a note when that capability is the one the run deleted', () => {
    const result = checkLedger({ markdown: md, exists: tree, removed: 'sync' })
    expect(result.findings).toEqual([])
    expect(result.notes.join()).toContain('was deleted by this run')
  })

  it('excuses only that capability, not a sibling the removal should not have touched', () => {
    const result = checkLedger({ markdown: md, exists: treeOf(), removed: 'sync' })
    expect(result.findings.map((f) => f.message)).toEqual([
      'src/capabilities/peer → src/capabilities/peer does not exist',
    ])
  })
})
