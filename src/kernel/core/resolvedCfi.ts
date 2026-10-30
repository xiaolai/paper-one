declare const RESOLVED: unique symbol

/**
 * A CFI that ADDRESSES A PASSAGE IN THE BUILD NOW OPEN — WI-22.A1.
 *
 * A nominal type over `string`, so a plain string cannot reach the painter.
 * `docs/design/circle/surfaces.md` asks for it by name and says why:
 *
 * > That invariant is carried by a comment here, which is weaker than the rest
 * > of this codebase manages. **If this is built, the honest shape is a nominal
 * > type** — `ResolvedCfi`, minted only by the resolver — so the compiler
 * > refuses an unresolved one at the painter's door, the way `MarkAnchor`
 * > narrowing already refuses a bookmark there.
 *
 * ## Why the brand lives HERE and the mint does not
 *
 * ⚠️ **This type was declared in `ui/reader/reanchor.ts`, which made
 * `core/marks.ts` import from `ui/` to name it** — a core domain module
 * depending on a DOM-facing one, backwards, and flagged as such by review. The
 * TYPE is a piece of vocabulary that `marks`, `markStore` and the painter all
 * need; the MINT is the resolver's alone. Splitting them puts each where it
 * belongs and costs nothing at runtime, because this file has no runtime.
 *
 * It is also the split this repository already prescribes for its own reason:
 * `reanchor.ts` imports `foliate-js/epubcfi.js`, and *"a pure value sharing a
 * module with a platform binding takes the whole subtree down with it"*
 * (AGENTS.md, and `vaultFsTauri.ts` split from `bookVault.ts`). Naming this
 * type no longer drags the resolver into anyone's import graph.
 *
 * ## What it is a claim about, and what it is not
 *
 * It says the path was derived from a range in a document with THIS build's
 * structure. It does NOT say the passage is still there, that the document is
 * still mounted, or that the CFI parses — those are the painter's business and
 * `attachMark` already tolerates all three failing.
 *
 * ⚠️ It is also NOT generation-bound, which `docs/design/circle/review.md`
 * records: *"`ResolvedCfi` brands a string but is not generation-bound, while
 * the cache correctly keys on `contentHash` because different bytes can share a
 * sampled `bookId`."* True as built and deliberately so — `reanchorCache`
 * carries the generation separately (WI-22.A3), and binding it here would mean
 * a type parameter on every mark. An overlay seam that hands anchors across a
 * session boundary (Stage D) would need the stronger claim.
 *
 * ## Why the brand is a `unique symbol` and not a string literal
 *
 * A `{ readonly __brand: 'resolved' }` intersection is forgeable by anyone who
 * writes the same object literal type, which makes the brand a naming
 * convention. The symbol is `declare`d and never exported, so no module but
 * this one can name it — there is no spelling of `ResolvedCfi` available
 * anywhere else. It is `declare const`, so it costs nothing at runtime and
 * erases completely.
 *
 * ## The two places one is minted
 *
 * 1. **`cfiFor` in `ui/reader/reanchor.ts`** — the only `as ResolvedCfi` in
 *    production. Sound because of its ARGUMENT: it takes a live `Range`, which
 *    is a pair of node references and therefore IS the evidence that the
 *    document is here and has the structure the path is derived from. A foreign
 *    passage arrives as three strings and cannot produce one.
 * 2. **`isPlaced` in `marks.ts`** — a type predicate, so no cast, and a
 *    CHECKED one: `unplaced === undefined && cfi !== ''`. ⚠️ It is the weaker
 *    of the two and says so in its own comment: it establishes that no foreign
 *    path was carried across an import and that a path exists, not that the
 *    path was re-derived this session. That is the honest reading of a mark
 *    read back off disk, whose cfi was minted by route 1 in an earlier session
 *    against the same `bookId`. Re-deriving every stored anchor on every open
 *    is the cost the CFI exists to avoid.
 */
export type ResolvedCfi = string & { readonly [RESOLVED]: true }
