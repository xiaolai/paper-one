import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeExists } from '../check-ledger.mjs'
import { DELETED_DIRS_ENV, DELETED_ENV } from '../verify-without.mjs'
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
const LEDGER_FILE = path.join(REPO_ROOT, 'dev-docs/feature-ledger.md')
const SEP = '|---|---|---|---|'
const table = (...rows) => [TABLE_HEADER, SEP, ...rows].join('\n')
/** A tree where only these paths exist. */
const treeOf = (...paths) => (rel) => paths.includes(rel)

/**
 * THE SECOND HEADER IS SCANNED, and this is what says so.
 *
 * `dev-docs/library-ledger.md` writes "Note" where `dev-docs/feature-ledger.md` writes
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

  it('finds the outer pipes of a row with whitespace around it', () => {
    expect(splitRow('  | a | b | c | d |  ')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('splits a row that leaves off its outer pipes, as GFM allows', () => {
    expect(splitRow('a | b | c | d')).toEqual(['a', 'b', 'c', 'd'])
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

  it('names the line and the first cell of a row that is not four cells', () => {
    expect(parseRows(table('| A | Shipped | — |')).findings).toEqual([
      { code: 'LEDGER_ROW_SHAPE', where: 'line 3', message: '3 cells, expected 4 — A' },
    ])
  })

  it('reads a table indented under a list item', () => {
    const md = [`  ${TABLE_HEADER}`, `  ${SEP}`, '  | Cap | Shipped | `core/a.ts` | how |'].join('\n')
    expect(parseRows(md)).toEqual({
      rows: [{ line: 3, capability: 'Cap', state: 'Shipped', where: '`core/a.ts`', confirm: 'how' }],
      findings: [],
    })
  })

  it('reads a separator written with spaces and alignment colons as a separator', () => {
    const md = [TABLE_HEADER, '| --- | :---: | ---: | :--- |', '| A | Shipped | — | x |'].join('\n')
    expect(parseRows(md).rows.map((r) => r.capability)).toEqual(['A'])
  })

  /* A separator is pipes, dashes, colons and spaces from END TO END. A row
     whose first or last cell is empty has a `|  |` at that end, and must not be
     skipped as though it were one. */
  it('reads a row whose first and last cells are empty, rather than taking it for a separator', () => {
    const { rows, findings } = parseRows(table('|  | Shipped | `core/a.ts` |  |'))
    expect(findings).toEqual([])
    expect(rows).toEqual([{ line: 3, capability: '', state: 'Shipped', where: '`core/a.ts`', confirm: '' }])
  })

  it('stops at prose that ends in a pipe, even with no blank line before it', () => {
    const { rows, findings } = parseRows(`${table('| A | Shipped | — | x |')}\nProse that ends in a pipe |`)
    expect(rows.map((r) => r.capability)).toEqual(['A'])
    expect(findings).toEqual([])
  })

  it('ignores a table inside an indented fence', () => {
    const md = ['   ```', table('| A | Done | `src/nope.ts` | how |'), '   ```'].join('\n')
    expect(parseRows(md)).toEqual({ rows: [], findings: [] })
  })

  it('does not open a fence on a line that only mentions one', () => {
    const md = ['Write ``` on a line of its own to open a fence.', '', table('| A | Shipped | — | x |')].join('\n')
    expect(parseRows(md).rows.map((r) => r.capability)).toEqual(['A'])
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

  it('sees through whitespace around the word', () => {
    expect(normalizeState(' Shipped ')).toBe('Shipped')
  })

  it('sees through a parenthetical however it is spaced', () => {
    expect(normalizeState('Shipped(macOS)')).toBe('Shipped')
    expect(normalizeState('Shipped (macOS) ')).toBe('Shipped')
  })

  /* Only a TRAILING parenthetical narrows a state. One anywhere else is part of
     what the cell says, and `(not) Shipped` is not Shipped. */
  it('keeps a parenthetical that does not end the cell', () => {
    expect(normalizeState('(not) Shipped')).toBe('(not) Shipped')
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

  /* ⚠️ A TOKEN THAT IS NOTHING BUT A LINE SUFFIX MUST BE REJECTED, and the
     consequence of accepting one is worse than it looks: `:12` strips to the
     empty string, an empty claim resolves to the repository ROOT, and the root
     exists — so it would pass silently rather than fail. */
  it.each([':12', ''])('rejects %o, which strips to nothing', (token) =>
    expect(isPathClaim(token)).toBe(false),
  )

  it('strips a line suffix from a bare filename before reading its extension', () => {
    expect(isPathClaim('paginator.js:12')).toBe(true)
  })

  it('strips only the line suffix that ends the token', () => {
    expect(isPathClaim('chapter:2.md:14')).toBe(true)
  })
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

  it('leaves a colon and a number inside a path where they are', () => {
    expect(pathClaims('`src/v:2/a.ts`')).toEqual(['src/v:2/a.ts'])
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

  it('drops every trailing slash, not only the last', () => {
    expect(resolveClaim('ui/reader/wordSnap//')).toEqual({ path: 'src/kernel/ui/reader/wordSnap' })
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

  /* ⚠️ THE LEGEND IS FOUND BY ITS OWN HEADER, NOT BY ROW SHAPE. This fixture
     carried only the rows, which the first version matched anywhere in the
     document — so it also matched any unrelated two-column table with a bold
     first cell. Anchoring means the fixture has to look like a legend, which is
     the point: the check should find THE legend, not a legend-shaped thing. */
  it('refuses a legend that has drifted from the states this check knows', () => {
    const legend = ['| State | Meaning |', '|---|---|', '| **Shipped** | done |', '| **Nearly** | not done |'].join('\n')
    const md = `${legend}\n\n${table('| A | Shipped | — | how |')}`
    const codes = checkLedger({ markdown: md, exists: treeOf() }).findings.map((f) => f.code)
    expect(codes).toContain('LEDGER_LEGEND')
  })

  it('does not mistake an unrelated glossary for the legend', () => {
    const glossary = ['| Term | Definition |', '|---|---|', '| **Example** | a thing |'].join('\n')
    const md = `${glossary}\n\n${table('| A | Shipped | — | how |')}`
    expect(checkLedger({ markdown: md, exists: treeOf() }).findings.map((f) => f.code)).not.toContain('LEDGER_LEGEND')
  })

  it('accepts the same five states in a different order', () => {
    const rows = ['Partial', 'Shipped', 'Stub', 'Absent', 'Unknown'].map((x) => `| **${x}** | x |`)
    const md = ['| State | Meaning |', '|---|---|', ...rows, '', table('| A | Shipped | — | how |')].join('\n')
    expect(checkLedger({ markdown: md, exists: treeOf() }).findings.map((f) => f.code)).not.toContain('LEDGER_LEGEND')
  })

  it('ignores a table inside a code fence', () => {
    const md = ['```', table('| A | Done | `src/nope.ts` | how |'), '```'].join('\n')
    const result = checkLedger({ markdown: md, exists: treeOf() })
    expect(result.summary.rows).toBe(0)
    expect(result.findings).toEqual([])
  })

  it('reports a template that names no single file, rather than dropping it', () => {
    /* A row whose only claim is a template used to yield zero claims and zero
       findings — unchecked, and indistinguishable from checked. */
    const md = table('| A | Shipped | `src/capabilities/{peer,sync}` | how |')
    const [f] = checkLedger({ markdown: md, exists: treeOf() }).findings
    expect(f.code).toBe('LEDGER_PATH_VAGUE')
    expect(f.message).toMatch(/names no single file/u)
  })

  /* Path-LIKE is two tests, not one: a separator OR a source extension. A glob
     with no slash — `settings*.ts` — takes the second branch, and only the
     first was exercised until the coverage gate said so. */
  it('reports a glob that carries an extension but no separator', () => {
    const md = table('| A | Shipped | `settings*.ts` | how |')
    expect(checkLedger({ markdown: md, exists: treeOf() }).findings.map((x) => x.code)).toEqual(['LEDGER_PATH_VAGUE'])
  })

  it('still says nothing about a template that is not path-like at all', () => {
    /* `kind: 'bookmark'` and friends must stay silent — the point is to catch a
       claim that LOOKS checkable, not to complain about prose. */
    const md = table('| A | Shipped | `${count} items` | how |')
    expect(checkLedger({ markdown: md, exists: treeOf() }).findings).toEqual([])
  })

  it('reports a vague claim separately from a missing one', () => {
    const md = table('| A | Shipped | `session.ts` | how |')
    const [f] = checkLedger({ markdown: md, exists: treeOf() }).findings
    expect(f.code).toBe('LEDGER_PATH_VAGUE')
  })

  it('says how to write a bare filename as a path', () => {
    const md = table('| A | Shipped | `session.ts` | how |')
    expect(checkLedger({ markdown: md, exists: treeOf() }).findings.map((f) => f.message)).toEqual([
      'session.ts names no directory — write the path from the repo root, or from the kernel as core/… or ui/…',
    ])
  })

  /* Ends in a brace, not an extension, so only the template characters taken
     out leave `….ts` at the end to be recognised as path-like. */
  it('reports a brace pair of filenames with no directory', () => {
    const md = table('| A | Shipped | `{bookVault.ts,vaultFsTauri.ts}` | how |')
    expect(checkLedger({ markdown: md, exists: treeOf() }).findings.map((f) => f.code)).toEqual(['LEDGER_PATH_VAGUE'])
  })

  it('counts a template it reports among the claims it checked', () => {
    const md = table('| A | Shipped | `src/capabilities/{peer,sync}` | how |')
    expect(checkLedger({ markdown: md, exists: treeOf() }).summary).toEqual({ rows: 1, claims: 1, findings: 1 })
  })

  it('says which external path it saw, and why it is excused', () => {
    const md = table('| A | Shipped | fork `paginator.js` | how |')
    const result = checkLedger({ markdown: md, exists: treeOf() })
    expect(result.notes).toEqual(['note: line 3 paginator.js — foliate-js fork (github:xiaolai/foliate-js), not this repo'])
    expect([...result.external]).toEqual(['paginator.js'])
  })

  it('names the state it refuses and the five it knows', () => {
    const md = table('| A | Mostly | `core/a.ts` | how |')
    expect(checkLedger({ markdown: md, exists: treeOf('src/kernel/core/a.ts') }).findings).toEqual([
      { code: 'LEDGER_STATE', where: 'line 3', message: '"Mostly" is not one of Shipped, Partial, Stub, Absent, Unknown' },
    ])
  })
})

/**
 * The legend, case by case. Every assertion reads the whole message, because a
 * legend the check cannot read is reported too — so "a LEDGER_LEGEND finding
 * exists" cannot tell a legend that was read and refused from one that was
 * never read at all.
 */
describe('the State legend', () => {
  const legendOf = (...rows) => ['| State | Meaning |', '|---|---|', ...rows].join('\n')
  const bold = (...states) => states.map((s) => `| **${s}** | x |`)
  const KNOWS = 'this check knows Shipped, Partial, Stub, Absent, Unknown'
  /** The legend findings of a ledger that is this legend and one clean row. */
  const legendFindings = (legend) =>
    checkLedger({ markdown: `${legend}\n\n${table('| A | Shipped | — | how |')}`, exists: treeOf() }).findings.filter(
      (f) => f.code === 'LEDGER_LEGEND',
    )
  const listed = (legend) => legendFindings(legend).map((f) => f.message)

  it('says where a drifted legend is and what both sides list', () => {
    expect(legendFindings(legendOf(...bold('Shipped', 'Nearly')))).toEqual([
      { code: 'LEDGER_LEGEND', where: 'the State legend', message: `the State legend lists Shipped, Nearly; ${KNOWS}` },
    ])
  })

  it('refuses a legend missing one of the five', () => {
    expect(listed(legendOf(...bold('Shipped', 'Partial', 'Stub', 'Absent')))).toEqual([
      `the State legend lists Shipped, Partial, Stub, Absent; ${KNOWS}`,
    ])
  })

  it('refuses a legend that lists one state twice', () => {
    expect(listed(legendOf(...bold('Shipped', 'Shipped', 'Partial', 'Stub', 'Absent')))).toEqual([
      `the State legend lists Shipped, Shipped, Partial, Stub, Absent; ${KNOWS}`,
    ])
  })

  it('refuses a legend of five with one of them wrong', () => {
    expect(listed(legendOf(...bold('Shipped', 'Partial', 'Stub', 'Absent', 'Nearly')))).toEqual([
      `the State legend lists Shipped, Partial, Stub, Absent, Nearly; ${KNOWS}`,
    ])
  })

  it('finds a legend written without spaces, or with whitespace after it', () => {
    const compact = ['|State|Meaning|', '|---|---|', '|**Shipped**|done|', '|**Nearly**|not done|'].join('\n')
    const trailing = ['| State | Meaning |   ', '|---|---|', ...bold('Shipped', 'Nearly')].join('\n')
    for (const legend of [compact, trailing]) {
      expect(listed(legend), legend).toEqual([`the State legend lists Shipped, Nearly; ${KNOWS}`])
    }
  })

  it('reads a legend indented under a list item', () => {
    const legend = legendOf(...bold('Shipped', 'Nearly'))
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    expect(listed(legend)).toEqual([`the State legend lists Shipped, Nearly; ${KNOWS}`])
  })

  it('reads a legend whose states are not bold', () => {
    expect(listed(legendOf('| Shipped | done |', '| Nearly | not done |'))).toEqual([
      `the State legend lists Shipped, Nearly; ${KNOWS}`,
    ])
  })

  it('reads a legend row that leaves off its closing pipe', () => {
    expect(listed(legendOf('| **Shipped** | done |', '| **Nearly** | not done'))).toEqual([
      `the State legend lists Shipped, Nearly; ${KNOWS}`,
    ])
  })

  it('skips a legend row whose first cell names no state, rather than reading the next cell', () => {
    const legend = legendOf(...bold('Shipped', 'Partial', 'Stub', 'Absent', 'Unknown'), '|  | Deprecated |')
    expect(listed(legend)).toEqual([])
  })

  /* A legend at the very end of the document has no line after it to stop at,
     and the loop must stop at the last line rather than read past it. */
  it('reads a legend that runs to the end of the document', () => {
    const md = `${table('| A | Shipped | — | how |')}\n\n${legendOf(...bold(...STATES))}`
    expect(checkLedger({ markdown: md, exists: treeOf() }).findings).toEqual([])
  })

  it('takes only a two-column table headed State and Meaning for the legend', () => {
    const wider = ['| State | Meaning | Since |', '|---|---|---|', '| **Nearly** | x | 2026 |'].join('\n')
    const later = ['| Area | State | Meaning |', '|---|---|---|', '| **Reader** | Shipped | done |'].join('\n')
    for (const doc of [wider, later]) expect(listed(doc), doc).toEqual([])
  })

  /* ⚠️ A LEGEND WITH NO ROW THIS CHECK CAN READ USED TO SWITCH THE CHECK OFF
     (2026-09-15, found by a surviving mutant). It was answered as "no legend",
     so writing every state as `Shipped` in backticks or italics was silent,
     while writing ONE of them that way was reported. */
  it('refuses a legend with no state it can read, rather than skipping the check', () => {
    const unreadable = `the State legend lists no state this check can read; ${KNOWS}`
    expect(listed(legendOf('| `Shipped` | done |', '| *Partial* | some |'))).toEqual([unreadable])
    expect(listed(legendOf())).toEqual([unreadable])
  })
})

describe('output', () => {
  it('prints a finding as code, where, message', () => {
    expect(formatFinding({ code: 'X', where: 'line 3', message: 'nope' })).toBe('X line 3: nope')
  })

  /* The `features-check: ` prefix this used to assert is gone on purpose. There
   * are TWO ledgers now and each gets its own line, so the shell prefixes the
   * DOCUMENT's name — `dev-docs/library-ledger.md: 58 rows, …` — and a summary
   * carrying the old gate's name as well would say the name of a command
   * nobody can run beside the name of the file it read. */
  it('prints a summary that says how much was actually checked, and does not name itself', () => {
    expect(formatSummary({ rows: 107, claims: 120, findings: 0 })).toBe('107 rows, 120 path claims checked, 0 findings')
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
/* ⚠️ **THIS SUITE WAS UNCONDITIONAL AND HAD TO STOP BEING SO.** When it was
 * written the ledger was committed, so a tree without the file was a broken
 * tree and failing by name was the right answer. `dev-docs/` is gitignored
 * whole since 2026-09-04, so on every clone the file is legitimately absent and
 * an unconditional suite here would fail CI for describing a document that is
 * not meant to be there — the mirror of the failure that deleted this gate.
 *
 * It declares its condition IN ITS TITLE, the convention `check-test-ledger.mjs`
 * keys on, so `tests/ledger.json` does not record names that only this machine
 * can collect. Everything above runs everywhere and is what binds CI. */
/* ⚠️ **AND A SKIPPED SUITE'S BODY STILL RUNS** (2026-09-14). Vitest collects a
 * `describe.skipIf` by CALLING its body, so the `it`s inside register as
 * skipped; the condition skips the tests, not the code around them. The read
 * sat at the top of this body, so on a checkout without the file `vitest list`
 * threw ENOENT and `test:ledger` stopped `pnpm verify` on all three CI legs —
 * every run on main from 2026-09-12, while this machine, which has the file,
 * stayed green. The read is in `beforeAll` now, which a skipped suite never
 * runs. */
describe.skipIf(!existsSync(LEDGER_FILE))('the local ledger (skipped when this checkout has no dev-docs/feature-ledger.md)', () => {
  let result
  beforeAll(() => {
    const markdown = readFileSync(LEDGER_FILE, 'utf8')
    /* Honours DELETED_ENV for the same reason the shell does: this suite runs
     * inside `verify:without`'s copy, where one capability's directory is gone
     * on purpose. */
    result = checkLedger({
      markdown,
      exists: makeExists(REPO_ROOT),
      removed: process.env[DELETED_ENV],
      /* ⚠️ **THE ID ALONE USED TO BE PASSED, AND THAT FAILED THE PROOF ON THE
         FIRST CAPABILITY WITH A CRATE.** `checkLedger` spelled the excused
         directory itself from the id; `verify:without webhost` then reported
         `src-tauri/crates/tauri-plugin-webhost/` — which the removal had just
         correctly deleted — as a missing path. What was deleted is now carried
         in, from `capability-remove`'s own rule. */
      removedDirs: (process.env[DELETED_DIRS_ENV] ?? '').split(':').filter((dir) => dir !== ''),
    })
  })

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
    expect([...EXTERNAL].map(([claim]) => claim).filter((claim) => !result.external.has(claim))).toEqual([])
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
    const result = checkLedger({ markdown: md, exists: tree, removed: 'sync', removedDirs: ['src/capabilities/sync'] })
    expect(result.findings).toEqual([])
    expect(result.notes.join()).toContain('was deleted by this run')
  })

  it('excuses only that capability, not a sibling the removal should not have touched', () => {
    const result = checkLedger({ markdown: md, exists: treeOf(), removed: 'sync', removedDirs: ['src/capabilities/sync'] })
    expect(result.findings.map((f) => f.message)).toEqual([
      'src/capabilities/peer → src/capabilities/peer does not exist',
    ])
  })

  /* The measured defect beside the normalisation in `checkLedger`: a raw prefix
     test handed a claim about PEER the excusal meant for the deleted `sync`. */
  it('does not excuse a claim that climbs out of the deleted capability', () => {
    const md = table('| Sync | Partial | `src/capabilities/sync/../peer/x.ts` | how |')
    const result = checkLedger({ markdown: md, exists: treeOf(), removed: 'sync', removedDirs: ['src/capabilities/sync'] })
    expect(result.findings.map((f) => f.code)).toEqual(['LEDGER_PATH_MISSING'])
    expect(result.notes).toEqual([])
  })

  it('excuses a claim that climbs into the deleted capability', () => {
    const md = table('| Sync | Partial | `src/capabilities/peer/../sync/x.ts` | how |')
    const result = checkLedger({ markdown: md, exists: treeOf(), removed: 'sync', removedDirs: ['src/capabilities/sync'] })
    expect(result.findings).toEqual([])
    expect(result.notes).toHaveLength(1)
  })

  it('excuses a claim under the deleted capability spelled with a `.` or an empty segment', () => {
    const md = table('| Sync | Partial | `src/capabilities/./sync/a.ts`, `src/capabilities//sync/b.ts` | how |')
    const result = checkLedger({ markdown: md, exists: treeOf(), removed: 'sync', removedDirs: ['src/capabilities/sync'] })
    expect(result.findings).toEqual([])
    expect(result.notes).toHaveLength(2)
  })

  /* ⚠️ **THE DEFECT THAT FAILED `verify:without webhost` (2026-09-19).** The
     excuse was derived here as `src/capabilities/<id>`, so a capability with a
     Rust crate lost `src-tauri/crates/<crate>` to the removal and then had the
     ledger's row about it reported as a missing path. Every capability the
     proof had been run on until then had no crate. What was deleted is passed
     in now, from `capability-remove`'s own `deletedDirsFor`. */
  it('excuses the deleted capability’s CRATE as well as its directory', () => {
    const md = table(
      '| Web host | Shipped | `src/capabilities/webhost`, `src-tauri/crates/tauri-plugin-webhost/` | how |',
    )
    const result = checkLedger({
      markdown: md,
      exists: treeOf(),
      removed: 'webhost',
      removedDirs: ['src/capabilities/webhost', 'src-tauri/crates/tauri-plugin-webhost'],
    })
    expect(result.findings).toEqual([])
    expect(result.notes).toHaveLength(2)
  })

  it('excuses the directory and NOT the crate when only the directory was deleted', () => {
    /* The other half of the pair: the list is what was deleted, not a licence
       to excuse anything that looks related. A capability with no crate must
       not excuse a crate claim that happens to name it. */
    const md = table(
      '| Web host | Shipped | `src/capabilities/webhost`, `src-tauri/crates/tauri-plugin-webhost/` | how |',
    )
    const result = checkLedger({
      markdown: md,
      exists: treeOf(),
      removed: 'webhost',
      removedDirs: ['src/capabilities/webhost'],
    })
    expect(result.findings.map((f) => f.message)).toEqual([
      'src-tauri/crates/tauri-plugin-webhost/ → src-tauri/crates/tauri-plugin-webhost does not exist',
    ])
    expect(result.notes).toHaveLength(1)
  })

  /* `removed` used to go into a template, so an absent one must never become
     the text of one: `src/capabilities/undefined`, or a `null/` prefix. It goes
     into no template now — the excused directories are given — and this holds
     the stronger property that with none given, nothing is excused at all. */
  it('excuses nothing when no capability was removed, even a path the absent value would spell', () => {
    const md = table('| A | Partial | `src/capabilities/undefined/x.ts`, `null/x.ts` | how |')
    const result = checkLedger({ markdown: md, exists: treeOf() })
    expect(result.findings.map((f) => f.message)).toEqual([
      'src/capabilities/undefined/x.ts → src/capabilities/undefined/x.ts does not exist',
      'null/x.ts → null/x.ts does not exist',
    ])
    expect(result.notes).toEqual([])
  })
})
