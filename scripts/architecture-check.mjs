import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collapse, createFsProbe, escapeControls, parseManifest, validateManifest } from './lib/architecture.mjs'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm architecture:check` — validate `capabilities.manifest.json` against
 * the rules in `scripts/lib/architecture.mjs` and the repository tree.
 *
 * SCOPE, stated so it is not mistaken for more: this checks the manifest's own
 * consistency (ids, `requires`, platforms, permissions) and that each `ts`
 * directory exists with an `index`. It does NOT check that the platform
 * compositions, `Cargo.toml`, `lib.rs` or the ACL grants actually MATCH the
 * manifest — that drift is `pnpm compositions:check`, and `pnpm verify` runs
 * both. A manifest that passes here can still disagree with the code.
 *
 * A thin shell: read the file, hand the text to the library, print one line
 * per finding and a summary. Exit 0 when clean, 1 when there are findings,
 * 2 for a usage error. The rules and their tests live in the library; this
 * file's own tests (`architecture-check.test.mjs`) cover only what is here —
 * arguments, the read step, the line format, and the exit code.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST_NAME = 'capabilities.manifest.json'
const USAGE = 'usage: node scripts/architecture-check.mjs [--root <dir>]'

/** `{ root }` or `{ error }`. Anything not understood is an error: a typo in
 *  a flag must not silently run the default. */
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
    /* JSON.stringify escapes C0 but not C1 or U+2028/29 — strip them so a
     * crafted argument cannot corrupt the terminal this errors to. */
    return { error: `unknown argument ${JSON.stringify(arg).replace(/[\u007f-\u009f\u2028\u2029]/g, '')}` }
  }
  return { root: root ?? REPO_ROOT }
}

/** Findings for the manifest under `root`: read, parse, validate. A file
 *  that cannot be read for any reason is a finding, not a crash. */
function check(root) {
  let text
  try {
    text = readFileSync(path.join(root, MANIFEST_NAME), 'utf8')
  } catch (cause) {
    const code = cause?.code ?? cause?.name ?? 'unknown'
    const detail = cause instanceof Error ? cause.message : String(cause)
    const message = escapeControls(collapse(`cannot read ${MANIFEST_NAME} (${code}): ${detail}`))
    return { manifest: null, findings: [{ code: 'MANIFEST_MISSING', path: '', message }] }
  }
  const { manifest, findings } = parseManifest(text)
  if (findings.length > 0) return { manifest, findings }
  return { manifest, findings: validateManifest(manifest, createFsProbe(root)) }
}

function main(argv) {
  const args = parseArgs(argv, process.cwd())
  if (args.error !== undefined) {
    process.stderr.write(`architecture-check: ${args.error}\n${USAGE}\n`)
    return 2
  }
  const { manifest, findings } = check(args.root)
  const lines = findings.map((f) => `${f.code} ${f.path === '' ? '(root)' : escapeControls(f.path)}: ${f.message}`)
  const count = Array.isArray(manifest?.capabilities) ? manifest.capabilities.length : 0
  lines.push(`architecture-check: ${count} capabilities, ${findings.length} findings (manifest + tree; composition/Cargo/ACL drift is compositions:check)`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return findings.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`architecture-check: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 1
  }
}
