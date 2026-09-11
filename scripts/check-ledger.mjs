/**
 * `pnpm ledger:check` — the ledgers describe an app that exists, and the app
 * has no surface the ledgers never describe.
 *
 * The rules are `scripts/lib/ledger.mjs`; the names are `scripts/surfaces.mjs`.
 * This is the shell: read the documents, probe the tree, print one line per
 * finding, exit 0 clean / 1 findings / 2 when the check itself could not run.
 *
 * ## Three questions
 *
 * | | |
 * |---|---|
 * | `LEDGER_PATH_*`  | does every `Where` claim resolve to one file? |
 * | `LEDGER_STATE`   | is every `State` cell one of the five the legend defines? |
 * | `LEDGER_UNCOVERED` | is every name the app declares written down somewhere? |
 *
 * The first two are the gate this repository deleted in `a1f256f` and are
 * recovered unchanged. **The third is new**, and it is the one that answers the
 * failure five ledger passes kept rediscovering: not a row that drifted, a
 * whole surface nobody ever described. It would have caught the public layer,
 * the circle, and the fifteen reading settings — and on its first real run it
 * did catch five, which is how `sync:download`, `sync:evict`, the arrival
 * statuses and the Storage and Devices settings bands got rows.
 *
 * ## What it does NOT check, stated so a green run is not read wider
 *
 * ⚠️ **IT CANNOT TELL WHETHER A `State` CELL IS HONEST.** `Shipped` against
 * `Partial` is a judgement that needs somebody to read the code, and the
 * 2026-09-09 ledger pass is the record of what happens when it goes wrong:
 * twenty green protocol tests over a pairing that failed three times in four
 * for a real reader. No gate here can see that.
 *
 * ⚠️ **AND IT DOES NOT BIND A CLEAN CHECKOUT.** `dev-docs/` is gitignored whole
 * and deliberately — see `.gitignore` lines 56–65 — so on a clone there is
 * nothing to read. It **skips, loudly, naming the rule**, because a step that
 * quietly passes when its input is missing is the defect that got the previous
 * gate deleted rather than made conditional. `--require` turns that skip into a
 * failure, for anywhere that should have the documents and might not.
 *
 * What binds CI is the OTHER half: `scripts/surfaces.mjs` and its test are
 * tracked and run everywhere, so a registry cannot change shape unnoticed even
 * where no ledger exists.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'
import { COVERAGE_DOCUMENTS, checkCoverage, checkLedger, formatFinding, formatSummary } from './lib/ledger.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-ledger.mjs [--root <dir>] [--require]'

/* Not derived from how long the enumerator takes — it runs in well under a
   second — but set far past any real machine, so its only job is that a hang
   fails rather than hangs. The class `TRANSFER_LIVENESS` was fixed under. */
const ENUMERATOR_DEADLINE_MS = 120_000

/**
 * The two documents whose `Where` and `State` columns are checked.
 *
 * DERIVED FROM `COVERAGE_DOCUMENTS` rather than written again: coverage reads
 * three documents and the first two are these, so listing them twice meant
 * adding a ledger in one place and having its text silently skipped in the
 * other. `lib/ledger.mjs` owns the order and says why `service-table.md` is
 * third.
 */
export const LEDGERS = Object.freeze(COVERAGE_DOCUMENTS.filter((rel) => rel.endsWith('-ledger.md')))

export function parseArgs(argv, cwd) {
  let root
  let require_ = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--require') {
      require_ = true
      continue
    }
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: '--root needs a directory' }
      if (root !== undefined) return { error: '--root given twice' }
      root = path.resolve(cwd, value)
      i++
      continue
    }
    return { error: `unknown argument ${JSON.stringify(arg)}` }
  }
  return { root: root ?? REPO_ROOT, require: require_ }
}

/**
 * Does `rel` name something in the tree?
 *
 * A directory counts: `ui/reader/wordSnap/` is a legitimate answer to "where
 * does this live" for a capability spread over twelve modules.
 *
 * ONLY absence is false. A permission or I/O error reported as "missing" would
 * turn an unreadable tree into a wall of findings that all say the wrong thing.
 *
 * ⚠️ **`ENOTDIR` COUNTS AS ABSENT AND `ENOENT` ALONE DID NOT COVER IT.** A claim
 * like `package.json/child.ts` asks the kernel to walk THROUGH a file, which
 * raises `ENOTDIR` — and rethrowing it aborted the whole run on one malformed
 * claim instead of reporting that claim and carrying on. Found by an
 * adversarial audit on 2026-09-10, reproduced. Everything else still throws:
 * a permission error is not a missing file and must not be reported as one.
 */
export function makeExists(root) {
  const inside = path.resolve(root) + path.sep
  return (rel) => {
    /* ⚠️ **`path.join` LET `../` OUT OF THE TREE.** A `Where` cell reading
       `../../etc/passwd` resolved through the real filesystem and came back
       CLEAN, and under `removed` a claim like `sync/../peer/gone.ts` collected
       the excusal meant for the deleted capability. Canonicalise, then contain:
       a path that leaves the root is not a missing file, it is a claim that
       does not belong in a ledger about this repository. Found by audit
       2026-09-11, reproduced. */
    const full = path.resolve(root, rel)
    if (full !== path.resolve(root) && !full.startsWith(inside)) return false
    try {
      statSync(full)
      return true
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
      throw error
    }
  }
}

/**
 * Is `root` a directory that exists? A missing root is not a missing ledger.
 *
 * ⚠️ **A BLANKET CATCH REPORTED `EACCES` AS "is not a directory"**, which is a
 * confident wrong explanation for a root that exists and cannot be read. Only
 * absence answers false; anything else is a real failure and travels.
 */
function rootIsDirectory(root) {
  try {
    return statSync(root).isDirectory()
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
    throw error
  }
}

/**
 * Every declared name, from `surfaces.mjs` run as a child process.
 *
 * A CHILD rather than an import, because `surfaces.mjs` registers a loader hook
 * at import time and installing a resolver into this process to ask it a
 * question is a larger change than the question is worth.
 *
 * ⚠️ **IT RUNS THE TREE'S OWN COPY AND DOES NOT FALL BACK.** `--root` points at
 * a different checkout — the removal test's, where a capability has been
 * deleted — and its surfaces are genuinely different from this one's. Reading
 * this repository's registries and checking them against that copy's ledgers
 * would report findings about an app neither tree contains, which is worse than
 * failing.
 */
function declaredNames(root) {
  const script = path.join(root, 'scripts/surfaces.mjs')
  /* `process.execPath`, not the string 'node': the parent's own runtime is the
     one whose type stripping `surfaces.mjs` depends on, and a PATH that
     resolves `node` to a different version — or to nothing — would either
     change the answer or fail for a reason unrelated to the ledger. */
  /* stderr is CAPTURED, not inherited: the default lets a child that cannot
     start print a Node stack straight to the terminal, underneath findings the
     gate has already reported. The caller turns the throw into one line. */
  /* A DEADLINE, because `execFileSync` has none by default: an enumerator that
     hangs on an import or leaves a handle open would block the gate forever,
     and a gate that never returns is worse than one that fails. */
  const out = execFileSync(process.execPath, [script, '--names'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: ENUMERATOR_DEADLINE_MS,
  })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * `readNames` is injected for the same reason `checkLedger` takes `exists`: the
 * rules are worth testing over a fixture, and a fixture tree has no app in it
 * to enumerate. Production passes nothing and gets `declaredNames`.
 */
export function main(argv, cwd, out, readNames = declaredNames) {
  const args = parseArgs(argv, cwd)
  if (args.error !== undefined) {
    out(`${args.error}\n${USAGE}`)
    return 2
  }
  const { root } = args
  const exists = makeExists(root)

  /* ⚠️ A ROOT THAT DOES NOT EXIST IS NOT A CHECKOUT WITHOUT LEDGERS. Before
     this, `--root /nonsense` printed "not in this checkout, by design" and
     exited 0 — a confident, specific, false explanation for a directory that
     was never there. Found by an adversarial audit on 2026-09-10, reproduced. */
  if (!rootIsDirectory(root)) {
    out(`ledger:check: ${root} is not a directory — nothing was checked`)
    return 2
  }

  /* ONE PROBE EACH. Two `filter` passes asked the filesystem twice and could
     disagree if a file appeared between them — a ledger counted absent by the
     first and present by the second, or neither. */
  const present = []
  const missing = []
  for (const rel of LEDGERS) (exists(rel) ? present : missing).push(rel)

  /* THE LOUD SKIP, AND IT NOW REQUIRES *EVERY* LEDGER TO BE ABSENT.
   *
   * ⚠️ **ONE MISSING LEDGER USED TO SKIP BOTH.** Measured 2026-09-10: a tree
   * holding a feature ledger with an invalid State cell AND a path that names
   * no file returned 0 with neither finding reported, because the library
   * ledger next to it was absent. A partial set is not the clean-clone case
   * this skip exists for — it is a tree somebody is midway through, and the
   * documents that ARE there still get checked. */
  if (present.length === 0) {
    out(
      `ledger:check: SKIPPED — ${missing.join(', ')} not in this checkout, by design ` +
        `(.gitignore:65 ignores dev-docs/ whole). This gate binds the machine that writes ` +
        `the ledger and does not bind CI. Use --require to make this a failure.`,
    )
    return args.require ? 2 : 0
  }
  if (missing.length > 0) {
    /* ⚠️ THIS LINE USED TO PROMISE A CHECK THAT `--require` THEN SKIPPED. It
       announced "checking the N present" and returned 2 immediately, so a
       surviving ledger's findings never appeared and the message described work
       that did not happen. Found by audit 2026-09-11. It now says which. */
    out(
      args.require
        ? `ledger:check: ${missing.join(', ')} absent — validation ABORTED, the ${present.length} present were not checked`
        : `ledger:check: ${missing.join(', ')} absent — checking the ${present.length} present`,
    )
    /* ⚠️ **`--require` MEANS EVERY LEDGER, AND THE PARTIAL-SET FIX BROKE THAT.**
       Splitting "all absent" from "some absent" left `--require` enforced only
       on the first branch, so a tree missing one ledger whose other one passed
       returned 0 under the flag whose entire job is to refuse that. Caught by
       the verification pass on 2026-09-10 as a REGRESSION of the fix above,
       reproduced. The flag is answered here, before any result can mask it. */
    if (args.require) {
      out(`ledger:check: --require given and ${missing.length} of ${LEDGERS.length} ledgers are absent`)
      return 2
    }
  }

  let findings = 0
  const sources = new Map()
  for (const rel of present) {
    /* Read ONCE and reuse for coverage below: two reads of the same path can
       straddle an editor's save and check two different documents. */
    const markdown = readFileSync(path.join(root, rel), 'utf8')
    sources.set(rel, markdown)
    const result = checkLedger({ markdown, exists })
    /* ⚠️ THE SUMMARY USED TO PRINT BEFORE `LEDGER_EMPTY` WAS COUNTED, so an
       unreadable document announced "0 findings" on the line above the finding
       that failed the run. Shell-raised findings are folded in first. */
    const shellFindings = result.summary.rows === 0
      ? [`LEDGER_EMPTY ${rel}: no inventory rows were recognised — a renamed or reflowed header disables every check above`]
      : []
    out(`${rel}: ${formatSummary({ ...result.summary, findings: result.summary.findings + shellFindings.length })}`)
    for (const line of shellFindings) out(`  ${line}`)
    /* ⚠️ **ZERO ROWS IS A FINDING, NOT A CLEAN RESULT.** The parser keys on an
       exact header, so a renamed column or a reflowed table yields no rows —
       and no rows yields no findings, which reads exactly like a document that
       passed. `lib/ledger.test.mjs` already asserts the real ledger "makes real
       claims, not none"; this is that assertion inside the gate, where it
       protects any tree rather than only this one. */
    findings += shellFindings.length
    for (const f of result.findings) out(`  ${formatFinding(f)}`)
    for (const n of result.notes) out(`  ${n}`)
    findings += result.findings.length
  }

  const text = COVERAGE_DOCUMENTS.filter((rel) => exists(rel))
    .map((rel) => sources.get(rel) ?? readFileSync(path.join(root, rel), 'utf8'))
    .join('\n')
  /* ⚠️ A FAILING ENUMERATOR IS EXIT 2 WITH ONE LINE, NOT A STACK TRACE. A tree
     with no `scripts/surfaces.mjs` has no app to enumerate, which is a real
     "could not run" — but `execFileSync` throws with the child's entire stderr
     attached, and dumping a Node stack out of a gate buries the findings above
     it in noise. The path and state findings already printed stay printed. */
  let names
  try {
    names = readNames(root)
  } catch (error) {
    /* ⚠️ "Cannot find module" WAS READ AS "surfaces.mjs IS ABSENT", INCLUDING
       WHEN THE MISSING MODULE WAS ONE OF ITS DEPENDENCIES — so a broken import
       inside the enumerator was reported as a missing enumerator, pointing the
       reader at the wrong file. And `status`/`stderr` were dropped, leaving
       "unknown error" beside a child that had explained itself. Both found by
       audit 2026-09-11. */
    /* The child's own words, not just its first line: an `Error("underlying
       failure")` puts the cause several lines into a stack, and keeping only
       line one reported the throw site while discarding what it said. */
    const stderr = String(error?.stderr ?? '').trim()
    /* ⚠️ **THE CAUSE IS NOT ALWAYS IN THE FIRST FEW LINES.** Node prints the
       throw site, the source line and a caret BEFORE the message, so keeping
       the first three lines reported where the child failed and dropped what it
       said — measured by the round 3 verification with a real child, where
       `Error: underlying failure` was the fourth line. The `Error:` line is
       pulled out first and the surrounding lines kept only as context. */
    const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    const named = lines.find((l) => /^[\w$]*(Error|Exception):/u.test(l))
    const said = [named, ...lines.filter((l) => l !== named).slice(0, 2)].filter(Boolean).join(' / ')
    const missing = /Cannot find module '([^']+)'/u.exec(`${error?.message ?? ''}\n${stderr}`)?.[1]
    /* Compare the RESOLVED path, not the suffix: a dependency living at
       `/vendor/scripts/surfaces.mjs` ends with the same characters and was
       being reported as this checkout's missing enumerator. */
    if (error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
      out(`ledger:check: coverage NOT CHECKED — scripts/surfaces.mjs did not finish within ${ENUMERATOR_DEADLINE_MS / 1000}s`)
      return 2
    }
    const why = missing === undefined
      ? `could not run scripts/surfaces.mjs (${error?.code ?? `exit ${error?.status ?? 'unknown'}`})${said === '' ? '' : `: ${said.slice(0, 300)}`}`
      : path.resolve(missing) === path.join(root, 'scripts/surfaces.mjs')
        ? 'scripts/surfaces.mjs is not in that tree, so its declared names cannot be read'
        : `scripts/surfaces.mjs could not load ${missing} — the enumerator is present but its dependency is not`
    out(`ledger:check: coverage NOT CHECKED — ${why}`)
    return 2
  }

  /* ⚠️ AN EMPTY ENUMERATION USED TO PASS. `coverage: 0 declared names, 0
     described nowhere` reads exactly like a clean run, so a `surfaces.mjs` that
     started returning nothing would silently disable the only check that
     catches an undescribed surface. Found by audit 2026-09-11, reproduced. */
  if (names.length === 0) {
    out('ledger:check: coverage NOT CHECKED — the enumerator returned no names at all, which disables the only check that finds an undescribed surface')
    return 2
  }

  const coverage = checkCoverage(names, text)
  out(`coverage: ${coverage.checked} declared names, ${coverage.findings.length} described nowhere`)
  for (const f of coverage.findings) out(`  ${formatFinding(f)}`)
  for (const n of coverage.excused) out(`  ${n}`)
  findings += coverage.findings.length

  return findings === 0 ? 0 : 1
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.cwd(), (line) => process.stdout.write(`${line}\n`))
  } catch (error) {
    process.stderr.write(`ledger:check: ${error?.message ?? error}\n`)
    process.exitCode = 2
  }
}
