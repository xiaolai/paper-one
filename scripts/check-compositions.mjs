import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORMS, createFsProbe, parseManifest, validateManifest } from './lib/architecture.mjs'
import { checkCompositionFiles, checkRustSurfaces, formatFinding } from './lib/compositions.mjs'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm compositions:check` — the manifest, the three composition roots, the
 * Cargo features, the `.plugin()` registrations and the ACL grants describe
 * the same set of capabilities (ADR decision 6; WI-5.9).
 *
 * For each platform, the capabilities `src/app/composition.<platform>.ts`
 * imports must be exactly the manifest entries whose `platforms` name it.
 * For each entry with a `crate`, the app crate must depend on it by path,
 * the platform features must compile it exactly where the manifest composes
 * it, `lib.rs` must register it, and its `permissions` must be granted. The
 * rules are `scripts/lib/compositions.mjs`; this is the shell: read the
 * files, print one line per finding, exit 0 clean / 1 findings / 2 when the
 * check itself could not run (unreadable or invalid manifest, bad usage).
 *
 * `--root <dir>` runs it over another tree — the deletion test's copy.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-compositions.mjs [--root <dir>]'
export const MANIFEST_NAME = 'capabilities.manifest.json'
export const CARGO_TOML = 'src-tauri/Cargo.toml'
export const LIB_RS = 'src-tauri/src/lib.rs'
export const ACL_DIR = 'src-tauri/capabilities'
export const CRATES_DIR = 'src-tauri/crates'

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

/** A file's text, or null when it is not a readable file. */
export function readOrNull(root, rel) {
  try {
    return readFileSync(path.join(root, rel), 'utf8')
  } catch (error) {
    /* ONLY absence is null. A permission or I/O failure reported as
     * "missing" lets a check quietly skip a file that exists — and lets a
     * removal treat unreadable state as already-clean. */
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** Every `*.json` under `dir`, recursively, as `[{ file, text }]` with
 *  root-relative posix names, sorted. An absent directory is an empty list. */
export function readAclFiles(root, dir = ACL_DIR) {
  const out = []
  const walk = (rel) => {
    let names
    try {
      names = readdirSync(path.join(root, rel))
    } catch {
      return
    }
    for (const name of names.sort()) {
      const child = `${rel}/${name}`
      let st
      try {
        st = statSync(path.join(root, child))
      } catch {
        continue
      }
      if (st.isDirectory()) walk(child)
      else if (name.endsWith('.json')) out.push({ file: child, text: readFileSync(path.join(root, child), 'utf8') })
    }
  }
  walk(dir)
  return out
}

/** Directory names under `src-tauri/crates/`, sorted; empty when absent. */
export function listCrates(root) {
  try {
    return readdirSync(path.join(root, CRATES_DIR))
      .filter((name) => statSync(path.join(root, CRATES_DIR, name)).isDirectory())
      .sort()
  } catch {
    return []
  }
}

/**
 * The manifest under `root`, parsed and validated, or an error message. The
 * check reads `platforms`, `ts`, `crate` and `permissions` from it, so an
 * invalid manifest cannot be checked against anything.
 */
export function loadManifest(root) {
  const text = readOrNull(root, MANIFEST_NAME)
  if (text === null) return { error: `cannot read ${MANIFEST_NAME} under ${root}` }
  const parsed = parseManifest(text)
  const findings = parsed.findings.length > 0 ? parsed.findings : validateManifest(parsed.manifest, createFsProbe(root))
  if (findings.length > 0) {
    const lines = findings.map((f) => `  ${f.code} ${f.path === '' ? '(root)' : f.path}: ${f.message}`)
    return { error: `${MANIFEST_NAME} is invalid (${findings.length} findings; see pnpm architecture:check):\n${lines.join('\n')}` }
  }
  return { manifest: parsed.manifest }
}

/**
 * The whole check over `root`: `{ findings, notes, summary }`. `notes` are
 * informational lines — a crate under `src-tauri/crates/` no manifest entry
 * claims is one, so the log says the Rust rules did not run for it.
 */
export function checkCompositions(root) {
  const loaded = loadManifest(root)
  if (loaded.error !== undefined) throw new Error(loaded.error)
  const { manifest } = loaded
  const findings = [...checkCompositionFiles(manifest, (rel) => readOrNull(root, rel))]
  const rust = checkRustSurfaces(manifest, {
    cargoToml: readOrNull(root, CARGO_TOML),
    libRs: readOrNull(root, LIB_RS),
    acl: readAclFiles(root),
  })
  findings.push(...rust.findings)
  const claimed = new Set(manifest.capabilities.map((entry) => entry.crate).filter((c) => typeof c === 'string'))
  const notes = listCrates(root)
    .filter((name) => !claimed.has(name))
    .map((name) => `note: ${CRATES_DIR}/${name} is claimed by no manifest entry — its features, registration and grants are not checked`)
  return {
    findings,
    notes,
    summary: {
      platforms: PLATFORMS.length,
      capabilities: manifest.capabilities.length,
      crates: rust.crates,
      findings: findings.length,
    },
  }
}

export function formatSummary(s) {
  return `compositions-check: ${s.platforms} platforms, ${s.capabilities} capabilities, ${s.crates} crates checked, ${s.findings} findings`
}

function main(argv) {
  const args = parseArgs(argv, process.cwd())
  if (args.error !== undefined) {
    process.stderr.write(`compositions-check: ${args.error}\n${USAGE}\n`)
    return 2
  }
  const { findings, notes, summary } = checkCompositions(args.root)
  const lines = [...findings.map(formatFinding), ...notes, formatSummary(summary)]
  process.stdout.write(`${lines.join('\n')}\n`)
  return findings.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`compositions-check: ${cause?.message ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
