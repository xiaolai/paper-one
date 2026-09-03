import type { ResolvedCfi } from './resolvedCfi'

/**
 * A `ResolvedCfi` from a bare string — **TESTS ONLY**, and the boundary check
 * is what keeps it that way.
 *
 * ## Why this is not a hole in WI-22.A1
 *
 * A1's falsifier is *"`rg 'as ResolvedCfi' src/` returns any hit outside the
 * resolver — if a second minting site exists, the type is decoration"*. The
 * grep returns two files: `ui/reader/reanchor.ts`, and this one. That is not a second
 * PRODUCTION minting site, and the difference is machine-checked rather than
 * argued: this module is reachable only through `src/kernel/testkit.ts`, and
 * `kernel-testkit-in-tests-only` in `.dependency-cruiser.cjs` fails the build
 * on an edge to that entry from anything but a `.test.ts` or a `.testkit.ts`.
 * `pnpm boundaries` is a `pnpm verify` step, so a production import of this is
 * a red gate and not an oversight — the same argument `fakeFs` already makes
 * for living behind that door rather than in `index.ts`.
 *
 * ## Why the tests need it at all
 *
 * The real mint takes a live `Range` as its evidence, which is the whole point
 * of A1. A session test's anchors are SENTINELS — `'here'`, `'elsewhere'`,
 * `'made-later'` — chosen so the assertion reads as which mark was drawn
 * rather than as an epubcfi. Routing them through `cfiFor` would produce real
 * paths and make every one of those assertions unreadable, to prove something
 * the resolver's own suite already proves.
 *
 * ⚠️ **Do not reach for this to get past a compile error in production code.**
 * The error is the feature: it means a passage with no anchor here is being
 * offered to the painter, which is the state phase 21 built the `unplaced`
 * class for. `isPlaced` is the answer — a real check, and it narrows.
 */
export const resolvedCfiForTesting = (cfi: string): ResolvedCfi => cfi as ResolvedCfi
