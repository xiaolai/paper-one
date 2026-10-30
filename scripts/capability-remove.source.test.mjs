import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Source pins on `capability-remove.mjs`, and nothing else.
 *
 * ⚠️ **A SOURCE PIN IN A BUSY TEST FILE MAKES ITS SUBJECT UNJUDGEABLE, WHICH IS
 * WHY THIS FILE EXISTS RATHER THAN A CASE IN `capability-remove.test.mjs` OR
 * `verify-without.test.mjs`.** The mutation gate leaves a test that reads a
 * subject's SOURCE out of that subject's sweep, at HEAD and at the merge base
 * alike; once such a reader has itself changed against the base, the gate answers
 * `reading-changed` — not a pass, not a failure, nothing authorised. So a pin
 * buried among behavioural cases makes its subject unmeasurable whenever anybody
 * edits that file for an unrelated reason. `reanchor.source.test.ts`,
 * `SidePane.source.test.ts` and `state.source.test.ts` are the same pattern; this
 * is the first of them under `scripts/`.
 *
 * It was written as a case in `verify-without.test.mjs` first, for half an hour,
 * which would have put a pin in one of the busiest test files in the tree.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('./capability-remove.mjs', import.meta.url)), 'utf8')

describe('capability-remove’s source, pinned where CI depends on it', () => {
  /**
   * ⚠️ **THE REMOVAL SPAWNS THREE BINARIES, AND A JOB THAT LACKS ONE FAILS A
   * QUARTER OF AN HOUR IN.** `capability-remove.mjs` shells out to `git` (to
   * unstage a deleted directory), `rustfmt` (to format the `lib.rs` it rewrote —
   * a missing one is a refusal, deliberately, because an unformatted registration
   * would fail `cargo fmt --check` and present the operation as broken) and
   * `cargo` (`metadata --offline`, to prune `Cargo.lock`).
   *
   * ⚠️ **AND THE ONE CAPABILITY THAT CANNOT SHOW THIS IS THE ONE THAT RUNS
   * FIRST.** `removableCapabilities()` answers in sorted order, so `circle` leads
   * — and `circle` is the only removable capability with no Rust crate, so its
   * removal rewrites no `lib.rs` and no `Cargo.toml` and needs neither Rust tool.
   * Measured 2026-09-29 on the first run of `verify.yml`'s new `deletion` job,
   * which had shed the Rust toolchain: `circle` passed all twelve copied steps in
   * 209.4s, and then `passages` died at once on `rustfmt is not available`. A
   * green first capability is not evidence about the other four.
   *
   * So the SET is pinned, derived from the source rather than restated, and a
   * fourth binary fails here in milliseconds naming what `verify.yml` would have
   * to install. `spawnSync` is the only way that file reaches outside itself.
   */
  it('names every binary the removal needs, which the deletion job installs', () => {
    const spawned = [...SOURCE.matchAll(/spawnSync\(\s*'([^']+)'/gu)].map((found) => found[1])
    /* NON-EMPTY, or a regex that stopped matching would pass this for free. */
    expect(spawned.length).toBeGreaterThan(0)
    expect(
      [...new Set(spawned)].sort(),
      'verify.yml’s `deletion` job installs node, pnpm, rustfmt and cargo — a new binary here needs adding there',
    ).toEqual(['cargo', 'git', 'rustfmt'])
  })

  /**
   * ⚠️ **AND `--no-rustfmt` MUST STAY AVAILABLE WITHOUT BEING WHAT CI USES.** It
   * exists for a tree with no toolchain, and reaching for it in CI would be the
   * banned move: buying green by skipping the format, which then fails
   * `cargo fmt --check` on the real tree instead. Pinned so the flag cannot
   * quietly disappear and so nobody adds it to the workflow thinking it is free.
   */
  it('keeps an escape hatch for a tree with no toolchain', () => {
    expect(SOURCE).toContain('--no-rustfmt')
  })
})
