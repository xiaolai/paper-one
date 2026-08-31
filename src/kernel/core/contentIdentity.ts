/**
 * What a book's identity is computed over — the sampling geometry, alone.
 *
 * ## Why this is its own file
 *
 * ⚠️ **A LEAF WITH NO IMPORTS, DELIBERATELY, so a plain `.mjs` can read it.**
 * Node strips TypeScript types natively, but its ESM resolver will not fill in
 * a missing extension — and this tree imports without one. So `marks.ts` cannot
 * be loaded from a script (`./hlc` resolves to nothing) while a module that
 * imports nothing at all loads perfectly.
 *
 * That is the same split `check-browser-safe.mjs` exists for, wearing different
 * clothes: *"a pure value sharing a module with a platform binding takes the
 * whole subtree down with it"* — here the binding is a bare relative import and
 * the consumer is Node rather than a browser, and the remedy is identical.
 * `vaultFsTauri.ts` out of `bookVault.ts` is the precedent.
 *
 * **The alternative was a second copy of these three numbers in
 * `scripts/measure-book-identity.mjs`, held to this one by a parity test.** That
 * copy existed, and it was defended on the grounds that a `.mjs` cannot import a
 * `.ts` — which is simply not true, and was never tested. The parity test it was
 * defended with then caught a REAL divergence in the sibling rule it did not
 * cover, which is the argument for deleting the duplication rather than
 * measuring it.
 *
 * ## What the geometry is
 *
 * Below `FULL_HASH_LIMIT` the whole file is hashed and identity is EXACT. Above
 * it, identity is APPROXIMATE: a size prefix, the first and last
 * `SAMPLE_BYTES`, and `INTERIOR_PROBES` windows between them.
 *
 * ⚠️ **THE APPROXIMATION IS A REAL TRADE AND NOT A ROUNDING ERROR.** A change
 * confined to a gap between probes leaves the id unchanged, so two such files
 * are ONE book to every mark, card and position. `marks.test.ts` proves it on
 * two 65 MiB blobs, and `scripts/measure-book-identity.mjs` measures how much of
 * a real shelf is over the line — 20 books of 1 959, on 2026-08-31, with 2.7 GB
 * that identity never looks at.
 */

/** How much is read at each end and at each interior probe. */
export const SAMPLE_BYTES = 64 * 1024

/**
 * Below this, the whole file is hashed and identity is EXACT.
 *
 * Set high on purpose. Sampling cannot be made reliable by adding probes: with
 * any fixed set of windows there are gaps between them, and a change that lands
 * in a gap is invisible however many probes there are. That is not a theory —
 * eight evenly spaced probes were tried first, and a four-kilobyte difference at
 * the exact midpoint of a nine-megabyte file fell cleanly between probes four
 * and five and produced identical ids.
 *
 * So the answer is not better sampling, it is not sampling. 64MB covers
 * essentially every EPUB and most PDFs outright; only scanned books exceed it.
 *
 * The cost is bounded and lands where it can be afforded. This runs on the open
 * path and races the parse — the saved reading position is keyed by this id and
 * read once the book is parsed — but a file large enough to be slow to hash is
 * far slower to parse, so the margin widens with size rather than narrowing.
 */
export const FULL_HASH_LIMIT = 64 * 1024 * 1024

/**
 * Probes through a file too large to hash whole.
 *
 * Above the limit identity is APPROXIMATE and this is the trade being made: a
 * change confined to a gap between probes leaves the id unchanged, and two such
 * books are one book to every mark, card and position. It is strictly better
 * than the ends-only scheme it replaces, and it is not exact. For real books of
 * this size — scans, mostly — two differing files that also share a byte length,
 * both ends and all sixteen probes is not a case that occurs by accident.
 */
export const INTERIOR_PROBES = 16

/**
 * The byte ranges identity is computed over, as `[start, end)` pairs.
 *
 * THE GEOMETRY, EXPRESSED AS OFFSETS — the form a reader working from a file
 * descriptor needs, and the form `identityParts` derives its slices from. One
 * expression, two consumers: the app hashes a `Blob` it already holds, and
 * `measure-book-identity.mjs` reads windows out of a file on disk without
 * loading half a gigabyte to answer a diagnostic question.
 *
 * Every window is clamped to `size`, so a caller reading these can treat a
 * short read as the file changing underneath it rather than as EOF.
 */
export function identityWindows(size: number): readonly (readonly [number, number])[] {
  if (size <= FULL_HASH_LIMIT) return [[0, size]]
  const windows: (readonly [number, number])[] = [[0, Math.min(SAMPLE_BYTES, size)]]
  for (let i = 1; i <= INTERIOR_PROBES; i++) {
    const at = Math.floor((size * i) / (INTERIOR_PROBES + 1))
    windows.push([at, Math.min(at + SAMPLE_BYTES, size)])
  }
  windows.push([Math.max(0, size - SAMPLE_BYTES), size])
  return windows
}

/**
 * The parts of a blob that identity is computed over.
 *
 * Exported for the tests, which assert the SHAPE of the sampling rather than
 * allocating a file large enough to trigger it — reading `size` and `slice` is
 * all this does, so a stand-in with those two members exercises it honestly.
 *
 * ⚠️ **THE SMALL CASE PUSHES THE BLOB ITSELF, NOT A SLICE OF IT**, and it is not
 * derived from `identityWindows` for that reason. `blob.slice(0, size)` would be
 * an equal-bytes copy and a needless one, and `marks.test.ts` asserts the
 * identity (`toBe(blob)`) rather than the equality. The SAMPLED case is derived,
 * which is where a second copy of the arithmetic could actually drift.
 */
export function identityParts(blob: Blob): BlobPart[] {
  // The size leads, so two files cannot agree by sampling alone.
  const parts: BlobPart[] = [`${blob.size}:`]
  if (blob.size <= FULL_HASH_LIMIT) {
    parts.push(blob)
    return parts
  }
  for (const [from, to] of identityWindows(blob.size)) parts.push(blob.slice(from, to))
  return parts
}
