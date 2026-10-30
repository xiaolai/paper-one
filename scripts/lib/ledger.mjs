/**
 * The rules behind `pnpm ledger:check` — the ledgers describe code that exists,
 * and the code's own registries are described somewhere in the ledgers.
 *
 * ⚠️ **RECOVERED FROM `a1f256f^`, NOT REWRITTEN.** Everything from `splitRow`
 * down to `checkLedger` is the gate this repository deleted on 2026-09-04 when
 * both ledgers moved into gitignored `dev-docs/`. It was correct; what was
 * wrong was that it had no input on a clean checkout. Its comments are kept
 * verbatim because each one is a defect somebody already paid for — the
 * unescaped-pipe split, the trailing slash that made a directory resolve while
 * the finding message stayed wrong, and "one candidate, never a search".
 *
 * `checkCoverage` is the part that is new, and it is the part that answers the
 * question five ledger passes kept failing to.
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
 * (`scripts/check-ledger.mjs`); everything about what a path claim IS
 * and where it resolves to is decided here, where it can be tested against a
 * fake tree.
 */

/** The five states the ledger's own legend defines. */
export const STATES = Object.freeze(['Shipped', 'Partial', 'Stub', 'Absent', 'Unknown'])

/**
 * The headers that mark an inventory table. Nothing else is scanned.
 *
 * TWO, because two ledgers write one shape with two names for the last column:
 * `dev-docs/feature-ledger.md` says "How to confirm", `dev-docs/library-ledger.md` says
 * "Note". Matching only the first is how the library ledger went eighteen rows
 * and every path stale without this check ever looking at it — the gate existed
 * and simply did not cover the file. A list rather than a loosened pattern, so
 * a table with a THIRD name for that column is a table nobody scanned and is
 * discovered by its rows never being checked, not by them being half-checked.
 */
export const TABLE_HEADERS = Object.freeze([
  '| Capability | State | Where | How to confirm |',
  '| Capability | State | Where | Note |',
])

/** The primary header, and what test fixtures build with. */
export const TABLE_HEADER = TABLE_HEADERS[0]

/**
 * Every document a name may be described in.
 *
 * ⚠️ **THREE, NOT TWO, AND `service-table.md` IS WHY.** The service table's 31
 * `<noun>.<verb>` names are declared once in `core/serviceTable.ts` and
 * documented in `dev-docs/service-table.md`; the feature ledger carries ONE row
 * for the table as a whole. Requiring all 31 in the ledger would push it into
 * being a second service table, which is the exact thing `commands.rs`'s
 * opening comment and `serviceTable.test.ts` exist to prevent. So coverage asks
 * *is this name described anywhere in the documents that describe the app*, and
 * `service-table.md` — a document the 2026-08-27 audit found two services
 * behind — is one of them.
 */
export const COVERAGE_DOCUMENTS = Object.freeze([
  'dev-docs/feature-ledger.md',
  'dev-docs/library-ledger.md',
  'dev-docs/service-table.md',
])

/**
 * Names deliberately not required to appear, each with the reason.
 *
 * EMPTY, AND THAT IS THE MEASUREMENT. On 2026-09-10 the coverage check was run
 * against 108 names and reported 24 uncovered; every one was then either an
 * identifier the ledger already described in prose (written into its row) or a
 * surface with no row at all (five of those, given rows). **Nothing needed
 * excusing.** An allowlist that starts at 24 is not an allowlist, it is a way
 * of turning the check off — so the entries were spent rather than accepted,
 * and this stays empty until something genuinely cannot be described.
 */
// Stryker disable next-line ArrayDeclaration: a non-empty list hands `new Map` an entry that is not a pair, so it throws while this module is imported, every covering suite fails to LOAD, and Stryker's vitest runner reports it Survived (verified by hand 2026-09-15) — the list's emptiness is asserted by `check-ledger.test.mjs`.
export const COVERAGE_EXCEPTIONS = readOnlyMap([])

/**
 * Which declared names are written down nowhere.
 *
 * CASE-INSENSITIVE, and that is a decision rather than a convenience. A theme's
 * id is `sepia` and the ledger calls it `Sepia`; a face is `literata` and the
 * row says `Literata`. Those are the same name, and a check that demanded the
 * identifier's exact casing would be demanding the ledger stop being written
 * for a person — which is what it is for.
 *
 * ⚠️ **IT ASKS "IS THIS NAME ANYWHERE", NOT "DOES IT HAVE A ROW OF ITS OWN",
 * AND THE WEAKER QUESTION IS THE ONE IT ANSWERS.** Before 2026-09-10 the word
 * `fidelity` appeared exactly once in the ledger, inside another row's
 * justification, and would have passed this check while the dial it names had
 * no row. Say that plainly rather than let a green run be read as more than it
 * is: what this catches is a surface described NOWHERE, which is the failure
 * that has cost this repository three whole sections and fifteen settings.
 *
 * ⚠️ **A PLAIN `includes` IS NOT ENOUGH, AND THE KNOWN POSITIVE IS WHAT SHOWED
 * IT.** The first version asked whether the documents CONTAINED the name, and
 * the test for it — rename `trash.empty` in `service-table.md` and watch the
 * check fire — did not fire, because `trash.emptyX` still contains
 * `trash.empty`. On the real documents that made at least three names pass on a
 * coincidence: `book.get` inside `book.getCover()`, `flourish` inside
 * `FLOURISHES`, `separation` inside `SEPARATIONS`. A coverage check that a
 * superstring satisfies is a check that reports the reassuring answer.
 *
 * So a name must appear NOT FOLLOWED BY another word character, and not
 * PRECEDED by one either. `.` and `` ` `` are not word characters, so
 * `ReadingStyle.fidelity` and `` `separation` `` both count as naming their
 * field, while `bookXlist` does not match `book.list` and `trash.emptyX` does
 * not match `trash.empty`.
 *
 * ⚠️ **THIS IS NOT WEAKER THAN `\b` AND AN EARLIER COMMENT HERE CLAIMED IT WAS.**
 * `\bfidelity\b` accepts `ReadingStyle.fidelity` too, for the same reason.
 * Lookarounds are used because a name may begin or end with a non-word
 * character — `book.list` starts and ends on word characters, but `\b` is
 * defined against the pattern's own edges and stops being reliable once the
 * name itself carries punctuation.
 *
 * `text` is the concatenation of every coverage document, lowercased once.
 *
 * `exceptions` is a parameter rather than a direct read of the module constant
 * for the reason `checkLedger` takes `exists`: the production list is EMPTY and
 * is asserted empty, so the excusing path would otherwise be unreachable code
 * that only a future entry could exercise — which is to say, tested for the
 * first time on the day somebody needs it to work.
 */
const NAMED_IN = (name) => new RegExp(`(?<!\\w)${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?!\\w)`, 'u')

export function checkCoverage(names, text, exceptions = COVERAGE_EXCEPTIONS) {
  const haystack = text.toLowerCase()
  const findings = []
  const excused = []
  for (const name of names) {
    if (NAMED_IN(name.toLowerCase()).test(haystack)) continue
    const why = exceptions.get(name)
    if (why !== undefined) {
      excused.push(`note: ${name} — ${why}`)
      continue
    }
    findings.push(
      finding(
        'LEDGER_UNCOVERED',
        name,
        'the app declares this and no ledger mentions it — a surface with no row is the failure these documents exist to prevent',
      ),
    )
  }
  return { findings, excused, checked: names.length }
}

/**
 * Paths named in a `Where` cell that are deliberately NOT in this repository.
 *
 * An allowlist rather than a silent skip, because "this file is somewhere else"
 * is a fact worth stating once and seeing on every run. The check reports these
 * as notes.
 *
 * The list cannot rot: `ledger.test.mjs` reads the real ledger and fails when
 * an entry here is named by no `Where` cell.
 *
 * Built by `readOnlyMap`, which is genuinely immutable where
 * `Object.freeze(new Map())` was not — see the note there. That guard lives in the test and
 * not in `checkLedger`, because "nothing uses this any more" is a fact about
 * the WHOLE ledger, and `checkLedger` must stay honest over a fragment.
 */
/**
 * A lookup table nothing can add to, remove from or empty.
 *
 * ⚠️ **`Object.freeze(new Map())` DOES NOT DO THIS, AND THAT IS WHY THIS EXISTS.**
 * Freezing a Map seals the object's own properties and leaves `.set()`,
 * `.delete()` and `.clear()` fully working — an adversarial audit on 2026-09-10
 * exercised all three against `EXTERNAL` and `COVERAGE_EXCEPTIONS` and used an
 * inserted entry to suppress a real finding. `const` already prevents
 * rebinding, so the freeze was buying nothing and reading as though it were.
 *
 * Exposes only what the callers use, so there is no mutating method to reach.
 */
function readOnlyMap(entries) {
  const held = new Map(entries)
  /* EXACTLY THE READERS THE CALLERS USE, and no writer. `values()` and
     `entries()` were here in the first draft and nothing called either — an
     unused method is dead code whether or not it is harmless, and the
     `scripts/lib/**` function-coverage gate is at 100% precisely so that a
     surface nobody reaches cannot be added quietly. Iteration stays, because
     `ledger.test.mjs` walks `EXTERNAL` with `for…of` to hold every excused
     path to a reason. `keys()` went the same way on 2026-09-15: its one caller
     was a test in the suite a clone skips, so every CI leg measured it
     unreached — which the ENOENT that suite used to throw had hidden. */
  return Object.freeze({
    get: (key) => held.get(key),
    has: (key) => held.has(key),
    [Symbol.iterator]: () => held.entries(),
    get size() {
      return held.size
    },
  })
}

export const EXTERNAL = readOnlyMap([
    ['paginator.js', 'foliate-js fork (github:xiaolai/foliate-js), not this repo'],
    /* The footnote detection the popover is built on — `epub:type`, the ARIA
       roles and the superscript heuristic. Upstream's, MIT, and shipped in the
       fork Paper pins; named in the ledger because it is where that behaviour
       actually lives, and a Where cell pointing at `src/` would be a lie. */
    ['foliate-js/footnotes.js', 'foliate-js fork, not this repo'],
])

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
  /* ⚠️ A TABLE INSIDE A CODE FENCE IS AN EXAMPLE OF A TABLE, NOT ONE. Neither
     ledger has one today, so this is a trap rather than a live defect — but the
     documents explain their own format, and the first time somebody shows the
     row shape in a fence it would be parsed, checked and reported against. */
  /* Only the lines BETWEEN fences are recorded, and only a header is looked up
     in them. A fence line starts with neither a header nor a pipe, so it is
     never read as either, and a table's rows stop at it before reaching
     anything fenced. Recording the fence lines too, and testing every row as
     well as the header, changed nothing any input could show — mutation
     testing found both on 2026-09-15. */
  const fenced = new Set()
  let inFence = false
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) fenced.add(i)
  }
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue
    if (!TABLE_HEADERS.includes(lines[i].trim())) continue
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim().startsWith('|')) break
      if (isSeparator(line)) continue
      const cells = splitRow(line)
      const at = `${j + 1}`
      if (cells.length !== 4) {
        findings.push(
          /* `split` always yields at least one cell, so there is a first. */
          finding('LEDGER_ROW_SHAPE', `line ${at}`, `${cells.length} cells, expected 4 — ${cells[0]}`),
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
  /* A token that is nothing but a line suffix strips to '', which has neither
     a separator nor an extension, so the two tests below refuse it already. */
  if (bare.includes('/')) return true
  return SOURCE_EXTENSIONS.some((ext) => bare.endsWith(ext))
}

/**
 * Tokens that LOOK like a path and cannot be checked as one.
 *
 * ⚠️ **THESE USED TO VANISH, AND A ROW WITH NOTHING ELSE IN IT PASSED.**
 * `isPathClaim` rejects `$APPDATA/books/<bookId>/` and
 * `src/capabilities/{peer,sync}` on purpose — they name no single file — but
 * "rejected" meant "not a claim", so a `Where` cell containing only a template
 * produced **zero claims and zero findings** and read exactly like a row that
 * had been checked. Measured 2026-09-11.
 *
 * The comments on `isPathClaim` already call writing such a pair as one span
 * "the mistake"; this is what makes saying so cost something. A token is
 * path-LIKE when it carries a separator or a source extension, and unusable
 * when it also carries a shell or template character.
 */
export function vagueClaims(where) {
  return codeSpans(where).filter((token) => {
    /* A path claim carries none of these characters, so this is also what
       keeps a claim from being counted twice. */
    if (!/[$<>{}*]/.test(token)) return false
    const bare = token.replace(/[$<>{}*]/g, '')
    return bare.includes('/') || SOURCE_EXTENSIONS.some((ext) => bare.endsWith(ext))
  })
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
 * removal copy cannot otherwise tell where it is — and `removedDirs` is what
 * that removal actually deleted, from `DELETED_DIRS_ENV`. Claims under those
 * directories become notes rather than findings: the ledger describes the app
 * as SHIPPED, and a copy with `sync` deleted is a proof harness, not a state
 * anyone runs. ONLY those directories are excused, so a removal that took
 * something else with it is still a finding.
 *
 * ⚠️ **`removedDirs` REPLACED A GUESS THAT WAS WRONG TWICE** (2026-09-19). This
 * derived the directory itself as `src/capabilities/<removed>`, which misses a
 * capability whose `ts` differs from its `id` — the manifest permits that — and
 * misses `src-tauri/crates/<crate>` entirely, which `capability-remove` deletes
 * for every capability that has one. `verify:without webhost` failed on a
 * ledger row naming the crate the removal had just correctly deleted, and the
 * comment here said only one directory was ever deleted. `circle`, the one
 * capability the proof had been run on, has no crate, so nothing showed it.
 *
 * `removed` is now only the NAME in the note. With no `removedDirs` nothing is
 * excused, which is the fail-closed direction: an under-excused claim is a
 * visible finding, where an over-excused one is silence.
 */
export function checkLedger({ markdown, exists, removed, removedDirs = [] }) {
  const { rows, findings } = parseRows(markdown)
  /* Named for what it holds rather than `excused`, which this file already
     uses for something else one function up. */
  const excusedDirs = Array.isArray(removedDirs)
    ? removedDirs.filter((dir) => typeof dir === 'string' && dir !== '')
    : []
  const notes = []
  const seenExternal = new Set()
  let claimCount = 0

  const legend = legendStates(markdown)
  if (legend !== null && !sameStates(legend, STATES)) {
    findings.push(
      finding(
        'LEDGER_LEGEND',
        /* The CALLER knows which document this is; hardcoding one name meant a
           library-ledger legend error pointed at the feature ledger. */
        'the State legend',
        `the State legend lists ${legend.join(', ') || 'no state this check can read'}; this check knows ${STATES.join(', ')}`,
      ),
    )
  }

  for (const row of rows) {
    const at = `line ${row.line}`
    const state = normalizeState(row.state)
    if (!STATES.includes(state)) {
      findings.push(finding('LEDGER_STATE', at, `${JSON.stringify(row.state)} is not one of ${STATES.join(', ')}`))
    }
    for (const token of vagueClaims(row.where)) {
      claimCount++
      findings.push(
        finding(
          'LEDGER_PATH_VAGUE',
          at,
          `${token} names no single file — spell the paths out separately, or this row is checked by nothing`,
        ),
      )
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
      /* ⚠️ NORMALISE BEFORE COMPARING. `src/capabilities/sync/../peer/x.ts` is a
         claim about PEER, and a raw prefix test handed it the excusal meant for
         the deleted `sync`. Measured 2026-09-11. */
      const normalised = resolved.path.split('/').reduce((parts, part) => {
        if (part === '.' || part === '') return parts
        if (part === '..') return parts.slice(0, -1)
        return [...parts, part]
      }, []).join('/')
      if (excusedDirs.some((dir) => normalised === dir || normalised.startsWith(`${dir}/`))) {
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

/**
 * The states the ledger's own legend table defines, or null if it has no
 * legend table.
 *
 * ⚠️ **A LEGEND WITH NO ROW THIS CAN READ IS STILL A LEGEND** (2026-09-15).
 * It returned null for one, the answer for "no legend", so a legend whose every
 * state was written in a shape the row pattern does not read — `` `Shipped` ``,
 * `*Shipped*` — switched the legend check off without a word, while the same
 * shape in ONE row was reported. A surviving mutant showed that nothing could
 * tell the two apart. It answers the empty list now, which is refused.
 *
 * ⚠️ **ANCHORED TO THE `State | Meaning` HEADER RATHER THAN SCANNED FOR SHAPE.**
 * The first version matched any bold single-word first cell in a two-column
 * row anywhere in the document, so an unrelated glossary would have produced a
 * legend error about states it never mentioned. Both ledgers happen to contain
 * exactly the five today; that made the scan look correct rather than make it
 * correct.
 */
function legendStates(markdown) {
  const lines = markdown.split('\n')
  const at = lines.findIndex((l) => /^\|\s*State\s*\|\s*Meaning\s*\|$/u.test(l.trim()))
  if (at === -1) return null
  const found = []
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('|')) break
    /* The separator needs no test of its own: its first cell holds no word
       character, so this pattern finds no state in it. */
    const m = /^\|\s*(?:\*\*)?(\w+)(?:\*\*)?\s*\|/u.exec(line)
    if (m !== null) found.push(m[1])
  }
  return found
}

/* MEMBERSHIP, NOT ORDER. Reordering the same five states changes no definition,
   and reporting it as legend drift trains a reader to ignore the finding. */
const sameStates = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((s) => b.includes(s))

export function formatSummary(s) {
  return `${s.rows} rows, ${s.claims} path claims checked, ${s.findings} findings`
}
