import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFsProbe, parseManifest, validateManifest } from './lib/architecture.mjs'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm boundaries` — the kernel/capability boundary, enforced.
 *
 * Runs dependency-cruiser over `src/` with `.dependency-cruiser.cjs` and
 * prints every violation, one per line, then adds the one rule that config
 * cannot express: `capability-requires-declared` — a capability may import
 * another capability's `index.ts` only if its entry in
 * `capabilities.manifest.json` lists that capability in `requires`. That
 * needs the manifest, which a cruiser rule cannot read, so it is a pass over
 * the cruise's own JSON output here.
 *
 * Fails closed at every step that could otherwise turn into a quiet pass:
 * a manifest that will not parse or validate, a cruise that returns no
 * modules (wrong directory), an unparsable cruiser answer. Exit 0 when the
 * tree is clean, 1 on any violation, 2 on a usage error or when the check
 * itself could not run.
 *
 * `--root <dir>` runs the same check over another tree — the selftest's
 * fixture trees — with the same config; the rules match paths relative to
 * that root.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-boundaries.mjs [--root <dir>]'
export const CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.cjs')
export const MANIFEST_NAME = 'capabilities.manifest.json'
/** The one rule that lives here rather than in the config. */
export const REQUIRES_RULE = 'capability-requires-declared'
/**
 * The cruiser's own entry, run through `node` rather than through the shim.
 *
 * IT USED TO BE `node_modules/.bin/depcruise`, and that cannot be spawned on
 * Windows: pnpm writes an extensionless shell script there beside the `.CMD`,
 * `existsSync` finds it, and `spawn` without a shell gets `ENOENT` — so
 * `pnpm boundaries` had never once run on the Windows leg. `shell: true`
 * would fix the spawn and hand the path back to a command interpreter, which
 * is a quoting bug waiting for a checkout with a space in its name.
 *
 * Still not `require.resolve`d — the package's `exports` map hides its bin
 * from resolution, which is what the note here used to say. A path join does
 * not consult `exports`, and `dependency-cruiser` is a direct devDependency,
 * so pnpm links it at this exact place on all three platforms.
 */
export const DEPCRUISE = path.join(REPO_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs')

/** One cruise of this repository is most of a second; this is a hang, not a slow run. */
export const CRUISE_TIMEOUT_MS = 300_000

const CAPABILITY_FILE = /^src\/capabilities\/([^/]+)\/(.+)$/
const CAPABILITY_INDEX = /^src\/capabilities\/([^/]+)\/index\.tsx?$/

/** `{ root }` or `{ error }`. Anything not understood is an error. */
function parseArgs(argv, cwd) {
  let root
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
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
  return { root: root ?? REPO_ROOT }
}

/**
 * The manifest under `root`, parsed and validated. Throws when it cannot be
 * trusted: `requires` is read from it, and an invalid manifest must fail the
 * boundary check rather than pass it with a `requires` nobody checked.
 */
export function loadManifest(root) {
  const file = path.join(root, MANIFEST_NAME)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    throw new Error(`cannot read ${MANIFEST_NAME} under ${root}: ${cause?.code ?? cause?.message}`, { cause })
  }
  const parsed = parseManifest(text)
  const findings = parsed.findings.length > 0 ? parsed.findings : validateManifest(parsed.manifest, createFsProbe(root))
  if (findings.length > 0) {
    const lines = findings.map((f) => `  ${f.code} ${f.path === '' ? '(root)' : f.path}: ${f.message}`)
    throw new Error(`${MANIFEST_NAME} is invalid (${findings.length} findings; see pnpm architecture:check):\n${lines.join('\n')}`)
  }
  return parsed.manifest
}

/**
 * dependency-cruiser's JSON output for `src` under `root`, using this
 * repository's config. Rejects when the cruiser could not run or did not
 * answer in JSON. A non-zero exit alone is NOT an error — the CLI exits with
 * the violation count, and the violations are what we came for.
 *
 * Asynchronous so the selftest can run its fixture trees a few at a time.
 *
 * ⚠️ **ONE CRUISE IS ABOUT HALF A SECOND, AND THAT SENTENCE WAS 20× WRONG FOR
 * MONTHS.** It said "most of a second" and stayed true only until the
 * repository grew: `options.tsConfig` pointed at `tsconfig.base.json`, which
 * names no `files` and no `include`, so TypeScript's default took every file
 * under the repository root — and each cruise of a ten-file fixture paid for
 * parsing the whole tree. Measured 2026-09-02 at 22,671 ms; 481 ms once the
 * cruiser was given a config with an empty file set. A number in a comment
 * that nothing checks is the defect `check-boundaries.test.mjs` now carries
 * assertions for.
 */
export function cruise(root, { bin = DEPCRUISE, timeoutMs = CRUISE_TIMEOUT_MS } = {}) {
  if (!existsSync(bin)) throw new Error(`${bin} is missing — run pnpm install`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '--config', CONFIG, '--output-type', 'json', '--no-cache', 'src'], {
      cwd: root,
    })
    let out = ''
    let err = ''
    /* OUR OWN TIMER, not `spawn`'s `timeout` option, and this is a measured
       fault rather than a preference. Node arms that timer and does not clear
       it when the SPAWN ITSELF fails: the `error` event arrives in a
       millisecond and the process then sits until the timer expires. Measured
       at `timeout: 3000` — error at 1 ms, exit at 3002 ms — which at the real
       five minutes is what the Windows leg did after it had already printed
       the `ENOENT`. Five minutes of a run that knew its answer immediately.
       A timer held here is one that can be cleared on every path out. */
    let settled = false
    let timer
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(reject, new Error(`depcruise did not answer within ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk) => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (err += chunk))
    child.on('error', (cause) => finish(reject, cause))
    child.on('close', (status) => {
      let parsed
      try {
        parsed = JSON.parse(out)
      } catch (cause) {
        finish(reject, new Error(`depcruise did not answer in JSON (exit ${status}):\n${err}${out}`.trimEnd(), { cause }))
        return
      }
      if (!Array.isArray(parsed?.modules) || !Array.isArray(parsed?.summary?.violations)) {
        finish(reject, new Error('depcruise JSON has no modules/summary.violations'))
        return
      }
      finish(resolve, parsed)
    })
  })
}

/**
 * Cross-capability edges the manifest does not declare. Pure: the cruise's
 * `modules` and the (validated) manifest in, violations out.
 *
 * Only edges to another capability's `index.ts` are judged here — an edge to
 * anything else under another capability is `cap-to-other-cap-internal`,
 * already reported by the cruiser. A capability directory that has no
 * manifest entry cannot have declared anything, so its edges are undeclared
 * too, and the message says which end is unlisted.
 */
export function undeclaredRequires(modules, manifest) {
  const byDir = new Map()
  for (const entry of manifest.capabilities) byDir.set(entry.ts, entry)
  const violations = []
  for (const module of modules) {
    const from = CAPABILITY_FILE.exec(module.source)
    if (!from) continue
    const fromDir = from[1]
    for (const dependency of module.dependencies) {
      const to = CAPABILITY_INDEX.exec(dependency.resolved)
      if (!to || to[1] === fromDir) continue
      const toDir = to[1]
      const importer = byDir.get(fromDir)
      const target = byDir.get(toDir)
      let reason
      if (!importer) reason = `src/capabilities/${fromDir} has no manifest entry`
      else if (!target) reason = `src/capabilities/${toDir} has no manifest entry`
      else if (!(importer.requires ?? []).includes(target.id)) {
        reason = `${importer.id} does not list ${target.id} in requires`
      }
      if (reason === undefined) continue
      violations.push({ rule: REQUIRES_RULE, from: module.source, to: dependency.resolved, message: reason })
    }
  }
  return violations
}

/** The cruiser's own violations, in this script's shape. A cycle is reported
 *  once per edge the cruiser reports, with the cycle spelled out. */
export function cruiserViolations(cruiseResult) {
  return cruiseResult.summary.violations.map((v) => {
    const out = { rule: v.rule.name, from: v.from, to: v.to }
    if (Array.isArray(v.cycle) && v.cycle.length > 0) {
      out.message = `cycle: ${[v.from, ...v.cycle.map((step) => (typeof step === 'string' ? step : step.name))].join(' -> ')}`
    }
    return out
  })
}

/**
 * The whole check over `root`: `{ violations, cruised }`. Rejects (rather
 * than resolving to an empty list) when nothing under `src/kernel/` was
 * cruised — a run that saw no kernel saw the wrong tree.
 */
export async function checkBoundaries(root) {
  const manifest = loadManifest(root)
  const result = await cruise(root)
  const kernelModules = result.modules.filter((m) => m.source.startsWith('src/kernel/')).length
  if (kernelModules === 0) {
    throw new Error(`nothing under src/kernel/ was cruised in ${root} (${result.modules.length} modules) — wrong root?`)
  }
  const violations = [...cruiserViolations(result), ...undeclaredRequires(result.modules, manifest)]
  violations.sort((a, b) => a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  return { violations, cruised: { modules: result.modules.length, dependencies: result.summary.totalDependenciesCruised } }
}

export function formatViolation(v) {
  return `${v.rule} ${v.from} -> ${v.to}${v.message ? ` (${v.message})` : ''}`
}

async function main(argv) {
  const args = parseArgs(argv, process.cwd())
  if (args.error !== undefined) {
    process.stderr.write(`check-boundaries: ${args.error}\n${USAGE}\n`)
    return 2
  }
  const { violations, cruised } = await checkBoundaries(args.root)
  const lines = violations.map(formatViolation)
  lines.push(
    `check-boundaries: ${cruised.modules} modules, ${cruised.dependencies} dependencies, ${violations.length} violations`,
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  return violations.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`check-boundaries: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
