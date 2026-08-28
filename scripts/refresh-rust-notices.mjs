import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'
import {
  RUST_CRATES_PATH,
  RUST_LICENSES_DIR,
  SHIPPED_TARGETS,
  collectRustNotices,
  committedTexts,
  driftBetween,
  readRustCrates,
  serialiseCrates,
} from './lib/rustNotices.mjs'

/**
 * `pnpm docs:rust-notices` — read the cargo registry, commit the answer.
 *
 * THE SPLIT THIS SCRIPT EXISTS FOR. The notice's Rust half needs three things
 * that only a populated cargo registry can give: which crates the binary
 * links, what each declares, and the licence text each ships. The place that
 * needs the answer is a Vitest suite that runs BEFORE any cargo step, on
 * machines where the registry may hold nothing at all.
 *
 * So the expensive question is asked HERE, by hand or by `pnpm verify` after
 * `cargo test`, and its answer is committed as `scripts/lib/rust-crates.json`
 * plus one file per distinct licence text. The test reads those and
 * `src-tauri/Cargo.lock`, and never spawns anything.
 *
 * ⚠️ **`--offline` IS NOT PASSED, AND THAT IS THE WHOLE POINT.** `readCrates`
 * used to run `cargo metadata --offline --locked` from inside the test suite.
 * `--offline` exits 101 when any package in the lockfile is missing from the
 * local registry — which is the shape of a fresh clone, and the shape of a CI
 * runner that restored a `Swatinem/rust-cache` keyed on an older lockfile. So
 * any pull request touching `Cargo.lock` could redden `test:coverage` for a
 * reason having nothing to do with the change. Measured by holding
 * `zbus-4.4.0` out of the registry. Here, where fetching is allowed and a
 * network is expected, cargo simply fetches what it lacks.
 *
 * FOUR TARGETS, one `cargo metadata` each, and their union — see
 * `lib/rustNotices.mjs` for why the union rather than the host's own closure.
 * The first run on a machine that has only ever built for its own target
 * downloads the other three targets' crates, which takes a minute; every run
 * after is about four seconds.
 *
 * `--check` regenerates in memory and compares. It does not write, and it
 * names what drifted — a step in `pnpm verify`, placed after `cargo test
 * --workspace` so the registry is certainly populated by the time it runs.
 *
 * THIS SCRIPT DOES NOT WRITE `THIRD-PARTY-NOTICES.md`. It writes what that
 * document is rendered FROM; `pnpm docs:notices` renders it, and the notices
 * suite refuses a committed notice that disagrees with the render. Two
 * commands rather than one because the two answer to different things: this
 * one to the cargo registry, that one to `node_modules` — and only this one
 * needs a toolchain.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * One target's resolved graph.
 *
 * `--locked`, because this reads a lockfile and must not rewrite one:
 * `dev-docs/versioning.md` records what a quietly-rewritten `Cargo.lock` costs,
 * and a metadata call is not a thing anybody watches for that.
 */
export function cargoMetadata(root, target, spawn = spawnSync) {
  const run = spawn(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--filter-platform', target, '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml')],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  /* A spawn that never ran has `status: null` and its story in `run.error`.
   * The real cause travels — "cargo metadata failed: null" was the whole
   * message the last time this shape was written without it. */
  if (run.error) throw new Error(`cargo metadata for ${target} could not run: ${run.error.message}`, { cause: run.error })
  if (run.status !== 0) throw new Error(`cargo metadata for ${target} failed (exit ${run.status ?? `signal ${run.signal}`}): ${run.stderr}`)
  return JSON.parse(run.stdout)
}

/** The four closures, unioned, with every licence text they reference. */
export function collectFromCargo(root = REPO_ROOT, targets = SHIPPED_TARGETS, spawn = spawnSync) {
  return collectRustNotices(targets.map((target) => cargoMetadata(root, target, spawn)))
}

/**
 * What is committed, in the shape `driftBetween` compares against.
 *
 * A MISSING manifest is `{ crates: [] }` rather than a throw: on the first run
 * — and on any run after somebody deletes it — the useful answer is "every
 * crate is missing", which the drift report then gives crate by crate.
 *
 * A MALFORMED one still throws. `catch {}` around the whole read would turn a
 * truncated JSON file into "nothing is committed", and `--check` would then
 * report six hundred crates as newly added rather than saying the manifest is
 * broken. Only the absence is tolerated, and it is identified by its cause.
 */
export function committedState(cratesAt = RUST_CRATES_PATH, textsDir = RUST_LICENSES_DIR) {
  let crates = []
  try {
    crates = readRustCrates(cratesAt)
  } catch (error) {
    if (error?.cause?.code !== 'ENOENT') throw error
  }
  return { crates, texts: committedTexts(textsDir) }
}

/**
 * Write the manifest and the texts, and DELETE the texts nothing references.
 *
 * The deletion is the half that is easy to leave out and impossible to notice
 * missing: an upgraded crate's old text stays committed, still readable, still
 * describing a version that no longer ships, and every gate stays green
 * because nothing asks whether a file is still needed. `driftBetween` reports
 * the orphan; this removes it.
 */
export function writeState(collected, cratesAt = RUST_CRATES_PATH, textsDir = RUST_LICENSES_DIR) {
  mkdirSync(textsDir, { recursive: true })
  for (const [sha, text] of collected.texts) writeFileSync(path.join(textsDir, `${sha}.txt`), `${text}\n`)
  let removed = 0
  for (const sha of committedTexts(textsDir).keys()) {
    if (collected.texts.has(sha)) continue
    rmSync(path.join(textsDir, `${sha}.txt`))
    removed++
  }
  writeFileSync(cratesAt, serialiseCrates(collected.crates))
  return { written: collected.texts.size, removed }
}

/**
 * `0` when it wrote or found no drift, `1` on drift, `2` on a usage error.
 *
 * Every path and both streams arrive through `io` so the whole script can be
 * driven over a scratch directory with a fake cargo — a generator whose only
 * exercise is the run that produced the committed artefact is a generator
 * whose failure paths are unmeasured, and its failure paths are the ones that
 * decide whether the notice is complete.
 */
export function main(argv, io = {}) {
  const {
    root = REPO_ROOT,
    cratesAt = RUST_CRATES_PATH,
    textsDir = RUST_LICENSES_DIR,
    spawn = spawnSync,
    write = (out) => process.stdout.write(out),
    fail = (out) => process.stderr.write(out),
  } = io
  /* Anything that is not `--check` is refused, for the reason
   * `write-third-party-notices.mjs` records: the failure mode of tolerance
   * here is a WRITE. `--chek` fell through to write mode there and mutated a
   * committed document on what was meant to be a read. */
  const unknown = argv.filter((arg) => arg !== '--check')
  if (unknown.length > 0) {
    fail(`refresh-rust-notices: unknown argument ${JSON.stringify(unknown[0])} (only --check is taken)\n`)
    return 2
  }
  const fresh = collectFromCargo(root, SHIPPED_TARGETS, spawn)
  if (!argv.includes('--check')) {
    const { written, removed } = writeState(fresh, cratesAt, textsDir)
    write(`refresh-rust-notices: ${fresh.crates.length} crates, ${written} licence texts${removed > 0 ? `, ${removed} orphaned text${removed === 1 ? '' : 's'} removed` : ''}\n`)
    write('refresh-rust-notices: now run `pnpm docs:notices` to render THIRD-PARTY-NOTICES.md\n')
    return 0
  }
  const findings = driftBetween(fresh, committedState(cratesAt, textsDir))
  if (findings.length === 0) {
    write(`refresh-rust-notices: ${fresh.crates.length} crates and ${fresh.texts.size} licence texts, all current\n`)
    return 0
  }
  for (const finding of findings) fail(`refresh-rust-notices: ${finding}\n`)
  fail(`refresh-rust-notices: ${findings.length} finding${findings.length === 1 ? '' : 's'} — run \`pnpm docs:rust-notices\` and then \`pnpm docs:notices\`\n`)
  return 1
}

if (isProcessEntry(import.meta)) {
  process.exitCode = main(process.argv.slice(2))
}
