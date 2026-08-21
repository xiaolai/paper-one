/**
 * The rules behind `pnpm features:check` — `docs/feature-ledger.md` describes
 * code that exists.
 *
 * WHAT THIS EXISTS FOR. The ledger is read to decide what to build next, which
 * makes a stale row worse than no row: a feature listed as Absent when it ships
 * is work someone is about to redo. Re-audited on 2026-08-21, ELEVEN rows had
 * drifted and nine of them understated the app — Alignment had shipped four
 * commits earlier, dictionary lookup had shipped and was wired, three tints and
 * two mark styles were live, and the shelf had gained search, removal, tags and
 * real cover art across three phases. Every `Where` path in the file still
 * pointed at `lib/…`, a directory the kernel carve had emptied months before.
 *
 * NOT EVERYTHING IN A LEDGER IS CHECKABLE, and the two halves are worth naming.
 * Whether a row's State is honest is a judgement — it needs someone to read the
 * code and decide whether "Shipped" is true. But the `Where` column is a claim
 * about the filesystem, and a filesystem answers. So this checks the half that
 * can be checked, and the value is not only the paths: a row whose path moved
 * is a row nobody has re-read, which is exactly where a stale State hides.
 *
 * PURE. Reading the ledger and probing the filesystem belong to the caller
 * (`scripts/check-feature-ledger.mjs`); everything about what a path claim IS
 * and where it resolves to is decided here, where it can be tested against a
 * fake tree.
 */

/** The five states the ledger's own legend defines. */
export const STATES = Object.freeze(['Shipped', 'Partial', 'Stub', 'Absent', 'Unknown'])

/** The header that marks a Part 1 inventory table. Nothing else is scanned. */
export const TABLE_HEADER = '| Capability | State | Where | How to confirm |'

/**
 * Paths named in a `Where` cell that are deliberately NOT in this repository.
 *
 * An allowlist rather than a silent skip, because "this file is somewhere else"
 * is a fact worth stating once and seeing on every run. The check reports these
 * as notes.
 *
 * The list cannot rot: `ledger.test.mjs` reads the real ledger and fails when
 * an entry here is named by no `Where` cell. That guard lives in the test and
 * not in `checkLedger`, because "nothing uses this any more" is a fact about
 * the WHOLE ledger, and `checkLedger` must stay honest over a fragment.
 */
export const EXTERNAL = Object.freeze(
  new Map([
    ['paginator.js', 'foliate-js fork (github:xiaolai/foliate-js), not this repo'],
    /* The footnote detection the popover is built on — `epub:type`, the ARIA
       roles and the superscript heuristic. Upstream's, MIT, and shipped in the
       fork Paper pins; named in the ledger because it is where that behaviour
       actually lives, and a Where cell pointing at `src/` would be a lie. */
    ['foliate-js/footnotes.js', 'foliate-js fork, not this repo'],
  ]),
)

/**
 * The two shorthand prefixes the ledger writes, and what they resolve to.
 *
 * `core/` and `ui/` are kernel-relative because every second row would
 * otherwise begin `src/kernel/`, which is noise in a column read a hundred
 * times. Everything else is repo-relative and must say so.
 */
const KERNEL_PREFIXES = Object.freeze(['core/', 'ui/'])
const KERNEL_ROOT = 'src/kernel/'

/** Extensions that make a backticked token a path even without a slash. */
const SOURCE_EXTENSIONS = Object.freeze([
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.py',
  '.css',
  '.rs',
  '.toml',
  '.json',
  '.md',
])

const finding = (code, where, message) => ({ code, where, message })

/** `f` as one line, the same shape `compositions.mjs` prints. */
export function formatFinding(f) {
  return `${f.code} ${f.where}: ${f.message}`
}

/**
 * Split a markdown table row into its cells.
 *
 * Splits on UNESCAPED pipes: a cell may contain `\|`, and a naive split would
 * silently turn one four-cell row into five and report a malformed table that
 * is perfectly well formed.
 */
export function splitRow(line) {
  const trimmed = line.trim()
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim())
}

const isSeparator = (line) => /^\|[\s:|-]+\|$/.test(line.trim())

/**
 * Every row of every Part 1 inventory table, with the line it came from.
 *
 * A table runs from its header until the first line that is not a table row,
 * so a table that loses its trailing blank line cannot swallow the prose after
 * it. A row without four cells is a finding rather than a silent reshape.
 */
export function parseRows(markdown) {
  const lines = markdown.split('\n')
  const rows = []
  const findings = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== TABLE_HEADER) continue
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim().startsWith('|')) break
      if (isSeparator(line)) continue
      const cells = splitRow(line)
      const at = `${j + 1}`
      if (cells.length !== 4) {
        findings.push(
          finding('LEDGER_ROW_SHAPE', `line ${at}`, `${cells.length} cells, expected 4 — ${cells[0] ?? ''}`),
        )
        continue
      }
      const [capability, state, where, confirm] = cells
      rows.push({ line: j + 1, capability, state, where, confirm })
    }
  }
  return { rows, findings }
}

/**
 * The State cell, reduced to the word the legend defines.
 *
 * `**Shipped**` and `Shipped (macOS)` are both the state `Shipped` — bold is
 * emphasis for a row worth noticing, and the parenthetical narrows the claim
 * without changing it. Anything else is returned verbatim so the caller can
 * name it in the finding.
 */
export function normalizeState(cell) {
  return cell
    .replace(/\*\*/g, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
}

/** Every `` `…` `` span in a cell. */
const codeSpans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])

/**
 * Is this backticked token claiming a file exists?
 *
 * The column carries three kinds of span and only one is a claim: paths
 * (`core/marks.ts`), identifiers (`MARK_TINTS`, `ensureLang`, `workId`) and
 * fragments of code or prose (`kind: 'bookmark'`, `hyphens: auto`).
 *
 * A token is REJECTED before anything else when it carries a shell or template
 * character — `$APPDATA/books/<bookId>/`, `src/capabilities/{peer,sync}` and
 * `content.<ext>` all look like paths and name no single file. Writing those as
 * one span is itself the mistake; the ledger spells such a pair out instead.
 *
 * What survives is a claim if it has a directory in it, or an extension that
 * only a source file has.
 */
export function isPathClaim(token) {
  if (/[$<>{}*\s]/.test(token)) return false
  const bare = token.replace(/:\d+$/, '')
  if (bare === '') return false
  if (bare.includes('/')) return true
  return SOURCE_EXTENSIONS.some((ext) => bare.endsWith(ext))
}

/** Every path claim in a `Where` cell, line suffixes stripped, in order. */
export function pathClaims(where) {
  return codeSpans(where)
    .filter(isPathClaim)
    .map((token) => token.replace(/:\d+$/, ''))
}

/**
 * Where a claim should be found, or why it cannot be resolved.
 *
 * One candidate, never a search. A checker that tries several roots and passes
 * on the first hit will happily accept `session.ts` because SOME `session.ts`
 * exists — which is how a column meant to say *where* a thing lives stops
 * saying it. A bare filename is a finding, not a lookup.
 */
export function resolveClaim(claim) {
  /* The trailing slash goes FIRST, before either branch. Stripping it on one
   * of them only is how `ui/reader/wordSnap/` resolved to a path ending in a
   * slash — which `statSync` accepts for a directory, so the run stayed green
   * and only the finding message would ever have shown it. */
  const bare = claim.replace(/\/+$/, '')
  if (KERNEL_PREFIXES.some((p) => bare.startsWith(p))) return { path: `${KERNEL_ROOT}${bare}` }
  if (!bare.includes('/')) {
    return { error: 'names no directory — write the path from the repo root, or from the kernel as core/… or ui/…' }
  }
  return { path: bare }
}

/**
 * Check a ledger against a tree.
 *
 * `exists(relativePath)` answers for a file OR a directory; the caller supplies
 * it so this stays testable without one. Returns findings (exit 1), notes
 * (external paths, printed but not fatal) and a summary.
 *
 * `removed` is a capability id that has just been DELETED from this tree —
 * `verify-without.mjs`'s `DELETED_ENV`, which exists because a gate inside the
 * removal copy cannot otherwise tell where it is. Claims under that
 * capability's directory become notes rather than findings: the ledger
 * describes the app as SHIPPED, and a copy with `sync` deleted is a proof
 * harness, not a state anyone runs. Only that one directory is excused, so a
 * removal that took something else with it is still a finding.
 */
export function checkLedger({ markdown, exists, removed }) {
  const { rows, findings } = parseRows(markdown)
  const removedDir = typeof removed === 'string' && removed !== '' ? `src/capabilities/${removed}` : null
  const notes = []
  const seenExternal = new Set()
  let claimCount = 0

  const legend = legendStates(markdown)
  if (legend !== null && !sameStates(legend, STATES)) {
    findings.push(
      finding(
        'LEDGER_LEGEND',
        'docs/feature-ledger.md',
        `the State legend lists ${legend.join(', ')}; this check knows ${STATES.join(', ')}`,
      ),
    )
  }

  for (const row of rows) {
    const at = `line ${row.line}`
    const state = normalizeState(row.state)
    if (!STATES.includes(state)) {
      findings.push(finding('LEDGER_STATE', at, `${JSON.stringify(row.state)} is not one of ${STATES.join(', ')}`))
    }
    for (const claim of pathClaims(row.where)) {
      claimCount++
      if (EXTERNAL.has(claim)) {
        seenExternal.add(claim)
        notes.push(`note: ${at} ${claim} — ${EXTERNAL.get(claim)}`)
        continue
      }
      const resolved = resolveClaim(claim)
      if (resolved.error !== undefined) {
        findings.push(finding('LEDGER_PATH_VAGUE', at, `${claim} ${resolved.error}`))
        continue
      }
      if (removedDir !== null && (resolved.path === removedDir || resolved.path.startsWith(`${removedDir}/`))) {
        notes.push(`note: ${at} ${claim} — capability "${removed}" was deleted by this run; the ledger describes the shipped app`)
        continue
      }
      if (!exists(resolved.path)) {
        findings.push(finding('LEDGER_PATH_MISSING', at, `${claim} → ${resolved.path} does not exist`))
      }
    }
  }

  return {
    findings,
    notes,
    external: seenExternal,
    summary: { rows: rows.length, claims: claimCount, findings: findings.length },
  }
}

/** The states the ledger's own legend table defines, or null if it has none. */
function legendStates(markdown) {
  const found = [...markdown.matchAll(/^\|\s*\*\*(\w+)\*\*\s*\|\s*[^|]+\|\s*$/gm)].map((m) => m[1])
  return found.length > 0 ? found : null
}

const sameStates = (a, b) => a.length === b.length && a.every((s, i) => s === b[i])

export function formatSummary(s) {
  return `features-check: ${s.rows} rows, ${s.claims} path claims checked, ${s.findings} findings`
}
