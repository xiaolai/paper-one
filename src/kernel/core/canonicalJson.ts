/**
 * ONE serialisation for one meaning — sorted keys at every depth.
 *
 * ## Why this is in the kernel rather than in `sync`
 *
 * It lived inside the sync capability, where it is the tie-breaker for every
 * last-writer-wins register and the input to every digest. The circle needs the
 * SAME function to compute signed bytes, and one capability cannot simply reach
 * into another: `capability-only-via-index` permits an edge only through the
 * target's public entry and only when the manifest lists it in `requires`, and
 * this was not on that entry. Requiring a whole capability in order to borrow a
 * string function would be a dependency for the wrong reason.
 *
 * ⚠️ The move is also why this header names no capability path. Kernel
 * declarations are checked for exactly that (`check-kernel-declarations`), so a
 * comment pointing back down at the caller is a gate failure — the kernel does
 * not know who its consumers are, in prose either.
 *
 * ⚠️ **AND IT HAD TO MOVE BEFORE THE FIRST SIGNATURE WAS MINTED.**
 * `docs/design/circle/wire.md` states the ordering as a hard constraint: two
 * canonicalisers disagreeing about key order is a signature that verifies on
 * one machine and fails on another, and the failure looks like corruption
 * rather than like a bug. A second copy written later is the whole hazard, so
 * the split happens first and `sync` imports it from here.
 *
 * Same shape as `core/contentIdentity.ts`, carved out of `marks.ts` for the
 * same reason: a leaf in `core/`, no imports, browser-safe by construction.
 *
 * ## What it guarantees, and what it does not
 *
 * It guarantees that two objects which are equal by structure serialise to
 * equal bytes. It does NOT guarantee that arbitrary JSON round-trips: numbers
 * go through `JSON.stringify`, so `-0` becomes `0` and `1e21` becomes
 * `1e+21`. The circle's answer is not to widen this — it is to forbid floats in
 * signed objects entirely and to verify by RE-SERIALISATION, comparing these
 * bytes against the bytes received. See `wire.md` §"Signatures are fully
 * specified".
 */

/**
 * A value with every object's keys sorted, recursively.
 *
 * ⚠️ **The accumulator has a NULL PROTOTYPE**, and the reason is a defect this
 * repository actually shipped: a tag clock's keys are reader-chosen,
 * `JSON.parse` makes `__proto__` an own key, and assigning that onto a plain
 * `{}` hits the prototype setter instead of the dictionary — so the key
 * silently vanished from every digest.
 */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value).sort()) {
      out[key] = sortedDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Canonical JSON: sorted keys at every depth. Tie-breakers, digests and
 *  signed bytes all read THIS, never `JSON.stringify` raw. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedDeep(value))
}
