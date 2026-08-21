import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COPY_EXCLUDE } from './verify-without.mjs'

/**
 * NO SOURCE FILE IS SECRETLY BINARY.
 *
 * A single NUL byte in a text file changes what every tool will do with it, and
 * none of them say so:
 *
 *   — git calls it binary. No diff, no merge, no review. `tagArchive.ts` came
 *     through a 380-file merge as `Bin 0 -> 7666 bytes`, and rename detection
 *     could not see it either.
 *   — grep silently matches NOTHING in it. Not an error, not a warning: zero
 *     results, which reads exactly like "that string is not in this file".
 *     Half an hour was spent concluding `journal.ts` had no `seq` in it while
 *     it had fifty-seven, during a live debugging session.
 *
 * Both files were correct. In each, a NUL is a deliberate separator for a
 * composite key — `${what}<NUL>${book}`, and a directory joined to a file list
 * — chosen because it cannot occur in either part. The defect is writing it as
 * a RAW BYTE rather than as an escape. The escape is the identical value at
 * run time and leaves the file text — which is why this check names it in the
 * failure message rather than printing the byte.
 *
 * TWO OCCURRENCES IS A CLASS, which is why this is a check over the whole tree
 * and not a third fix. It reads what git tracks, so a fixture that is genuinely
 * binary — an icon, a font — is out of scope by extension rather than by
 * exception.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

/** Extensions that are text by definition. A `.png` is not on trial. */
const TEXT = new Set([
  '.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.jsonc',
  '.css', '.md', '.rs', '.toml', '.yml', '.yaml', '.html', '.svg', '.sh',
])

/**
 * Everything to check: what git tracks where there is a git, and what is on
 * disk where there is not.
 *
 * THERE IS NOT, IN EXACTLY ONE PLACE, and it is a place this check must still
 * run: `pnpm verify:without <id>` copies the working tree WITHOUT `.git` — see
 * `verify-without.mjs` for why a copy rather than a worktree — and then runs
 * the suite over it. `git ls-files` failed there with "not a git repository",
 * which took the whole file down at collection time and made the deletion
 * proof impossible to pass.
 *
 * The fallback is a WALK, not a skip. Git was never the subject here; it was
 * the enumeration, chosen because it answers "the tree as it will be cloned"
 * and so leaves out build output and ignored junk. The copy leaves the same
 * things out by construction — `COPY_EXCLUDE`, imported rather than restated
 * so the two cannot drift — so walking it asks the same question of the same
 * files. A check that stopped running in one of the two trees this repo gates
 * would be the defect this file was written to catch, wearing a hat.
 *
 * AND THE FALLBACK IS NARROW. It is taken only when `.git` is genuinely absent.
 * A checkout WITH a `.git` whose `git ls-files` fails is a real problem, and it
 * throws rather than quietly downgrading to the weaker enumeration — which is
 * how a check goes on reporting green over a question it stopped asking.
 */
function tracked() {
  if (existsSync(join(REPO, '.git'))) {
    return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
  }
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (COPY_EXCLUDE.includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(REPO, full).split(sep).join('/'))
    }
  }
  walk(REPO)
  return out
}

describe('source is text', () => {
  const files = tracked().filter((f) => TEXT.has(extname(f)))

  it('has files to check', () => {
    // A filter that matches nothing passes the assertion below it.
    expect(files.length).toBeGreaterThan(100)
  })

  it('contains no raw NUL byte', () => {
    const offenders = []
    for (const file of files) {
      const path = join(REPO, file)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue // tracked but not present — a worktree mid-operation
      }
      if (!stat.isFile()) continue
      const buffer = readFileSync(path)
      const at = buffer.indexOf(0)
      if (at !== -1) offenders.push(`${file} (byte ${at}) — write it as \\u0000`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
