import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'
import { BUNDLED_PACKAGES, readCrates, readPackage, renderNotices } from './lib/notices.mjs'

/**
 * `pnpm docs:notices` — write `THIRD-PARTY-NOTICES.md` from what is installed.
 *
 * Four typefaces are bundled into every build under SIL OFL 1.1, whose §2
 * makes redistribution conditional on the copyright notice and the licence
 * travelling with the copies. Nothing carried them, so every shipped build
 * relied on terms it did not meet.
 *
 * `--check` compares instead of writing and exits 1 on a difference, so an
 * upgraded or added font cannot quietly leave the notice describing a build
 * that no longer exists.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const NOTICES = 'THIRD-PARTY-NOTICES.md'

export function currentNotices(root = REPO_ROOT) {
  return renderNotices(
    BUNDLED_PACKAGES.map((name) => readPackage(root, name)),
    readCrates(root),
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
