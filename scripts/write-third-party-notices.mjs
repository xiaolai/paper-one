import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'
import { BUNDLED_LIBRARIES, BUNDLED_PACKAGES, BUNDLED_TRANSITIVE, readCrates, readPackage, renderNotices } from './lib/notices.mjs'
import { readRustCrates } from './lib/rustNotices.mjs'

/**
 * `pnpm docs:notices` — write `THIRD-PARTY-NOTICES.md` from what is installed.
 *
 * Four typefaces are bundled into every build under SIL OFL 1.1, whose §2
 * makes redistribution conditional on the copyright notice and the licence
 * travelling with the copies. Nothing carried them, so every shipped build
 * relied on terms it did not meet.
 *
 * The same was true of every JavaScript dependency the bundle carries — React,
 * pdf.js, foliate-js, Lucide and the Tauri API, under MIT, ISC and Apache-2.0,
 * all of which say the same thing about the notice travelling with the copy.
 * `BUNDLED_LIBRARIES` is that half; see `lib/notices.mjs`.
 *
 * `--check` compares instead of writing and exits 1 on a difference, so an
 * upgraded or added dependency cannot quietly leave the notice describing a
 * build that no longer exists.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const NOTICES = 'THIRD-PARTY-NOTICES.md'

export function currentNotices(root = REPO_ROOT) {
  return renderNotices(
    BUNDLED_PACKAGES.map((name) => readPackage(root, name)),
    /* The direct dependencies AND what they bring with them — `scheduler`
       reaches every bundle through `react-dom` and appeared in neither table
       until the walk in the notices test went looking. */
    [...BUNDLED_LIBRARIES, ...BUNDLED_TRANSITIVE].map((entry) => readPackage(root, entry)),
    readCrates(root),
    /* The several hundred Rust crates the desktop binary links — read from
       what `pnpm docs:rust-notices` committed, never from cargo. See
       `readCrates` for what a cargo call inside this path cost. */
    { crates: readRustCrates() },
  )
}

/** What is committed, or null when nothing is. */
export function committedNotices(root = REPO_ROOT) {
  try {
    return readFileSync(path.join(root, NOTICES), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function main(argv) {
  /* Anything that is not `--check` is refused, because the failure mode of
   * tolerance here is a WRITE: `--chek` fell through to write mode and
   * mutated the committed notice on what was meant to be a read. */
  const unknown = argv.filter((arg) => arg !== '--check')
  if (unknown.length > 0) {
    process.stderr.write(`write-third-party-notices: unknown argument ${JSON.stringify(unknown[0])} (only --check is taken)\n`)
    return 2
  }
  const check = argv.includes('--check')
  const generated = currentNotices()
  if (!check) {
    writeFileSync(path.join(REPO_ROOT, NOTICES), generated)
    /* `trimEnd` before counting: the generated text ends in a newline, and
     * counting split parts read one line high (151 for a 150-line file). */
    process.stdout.write(`write-third-party-notices: ${NOTICES} (${generated.trimEnd().split('\n').length} lines)\n`)
    return 0
  }
  const committed = committedNotices()
  if (committed === generated) {
    process.stdout.write(`write-third-party-notices: ${NOTICES} is current\n`)
    return 0
  }
  process.stderr.write(
    committed === null
      ? `write-third-party-notices: ${NOTICES} is missing — run \`pnpm docs:notices\`\n`
      : `write-third-party-notices: ${NOTICES} has drifted from the installed packages — run \`pnpm docs:notices\`\n`,
  )
  return 1
}

if (isProcessEntry(import.meta)) {
  process.exitCode = main(process.argv.slice(2))
}
