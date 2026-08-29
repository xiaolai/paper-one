import { paper } from './paper'
import { openShelf } from './shelfLink'

/**
 * The bundled `paper` executable's first line (WI-11.4).
 *
 * Separate from `paper.ts` so that `paper()` stays a function a test can call
 * with its own argv and sinks, and this file — which reads `process.argv`,
 * writes to `process.stdout` and sets `process.exitCode` — is the only thing
 * in `src/cli/` that touches the process at all.
 *
 * `scripts/build-cli.mjs` bundles this into `bin/paper.mjs`, which is what
 * `package.json`'s `bin` points at. A bundle rather than the source, because
 * the tree imports without file extensions and Node's ESM resolver does not
 * fill them in; `pnpm build:cli` is one step and `pnpm verify` runs it.
 *
 * `exitCode` rather than `process.exit()`: `exit` truncates whatever stdout
 * has not flushed, which on a piped `paper book list --json` of two thousand
 * rows is most of the answer. Setting the code lets Node drain and leave.
 */
const code = await paper({
  argv: process.argv.slice(2),
  sinks: {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  /* THE REMOTE HALF, SUPPLIED HERE (WI-11.7). `paper()` has taken this seam
   * since WI-11.6 and nothing ever filled it, so `--shelf` answered "this
   * build cannot reach a remote shelf" — read for two phases as "no transport
   * exists", when what did not exist was this line.
   *
   * The composition root is where it belongs: `openShelf` reaches the kernel's
   * shelf channel and the environment, and `paper.ts`'s own note says the
   * envelope may be composed by a root and nobody else.
   *
   * `process.env` and stderr are passed IN rather than read there, so the rest
   * of `src/cli/` keeps the property this file exists for — that only this
   * file touches the process. */
  remote: (shelf) =>
    openShelf({
      key: shelf,
      env: process.env,
      note: (line) => process.stderr.write(`${line}\n`),
    }),
})
process.exitCode = code
