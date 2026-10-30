import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Is the module whose `import.meta` this is the script node was started with?
 *
 * The guard around every `main()` in `scripts/`. It exists because the two
 * cheap answers are both wrong: comparing `process.argv[1]` to
 * `import.meta.url` textually says "no" for a script run through a symlink
 * (node resolves the entry to its real path, argv keeps the link), and a
 * guard that answers "no" when it cannot tell produces a script that exits 0
 * having done nothing — indistinguishable from one that ran.
 *
 * Node ≥ 24.2 answers the question itself (`import.meta.main`); the fallback
 * compares real paths, and throws when either side cannot be resolved rather
 * than guess.
 */
export function isProcessEntry(meta) {
  if (typeof meta.main === 'boolean') return meta.main

  const argv1 = process.argv[1]
  if (argv1 === undefined) return false // a REPL or `node -e`: nothing is the entry
  const self = fileURLToPath(meta.url)
  const candidate = path.resolve(argv1)
  if (candidate === self) return true

  const real = (file) => {
    try {
      return realpathSync(file)
    } catch (cause) {
      throw new Error(
        `Refusing to guess whether ${self} is the process entry: ` +
          `cannot resolve ${file} (${cause.code ?? cause.message})`,
        { cause },
      )
    }
  }
  return real(candidate) === real(self)
}
