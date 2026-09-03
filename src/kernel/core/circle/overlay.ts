import type { ForeignAnnotation } from './foreign'
import type { ResolvedCfi } from '../resolvedCfi'

/**
 * The overlay seam — WI-22.D1, and the FOURTH contribution type.
 *
 * `Capability` already declares `panes`, `settings`, `services`, `commands`,
 * `bookActions`, `bookStatuses` and `clients`. This is the one
 * `docs/design/circle/surfaces.md` asks for and the composition did not have.
 *
 * ## The capability supplies DATA; the kernel's own painter draws it
 *
 * ⚠️ **`forBook` ANSWERS ANNOTATIONS, NEVER A DOM NODE AND NEVER A PAINT
 * CALLBACK.** Handing either back would put rendering inside a capability, and
 * the reader is the one surface this codebase keeps whole — the same line
 * `PaneContribution` does not cross either, since a pane renders into a slot
 * the kernel owns rather than drawing on the page.
 *
 * Every annotation carries a `ResolvedCfi` (WI-22.A1), so a passage that did
 * not resolve cannot be handed over at all: the compiler refuses it at this
 * boundary rather than the painter drawing it somewhere.
 *
 * ## Why it is async, and why it is handed a resolver
 *
 * ⚠️ `review.md`'s overlay blocker 4: *"`forBook` is synchronous and a
 * capability gets no sections, no async resolver port and no generation."*
 * `surfaces.md` requires a capability run `reanchor` BEFORE contributing —
 * *"contributing an unresolved passage would put a foreign path in front of the
 * painter, which is the defect all of phase 21 exists to remove"* — and
 * re-anchoring parses sections, which is asynchronous by nature.
 *
 * So the kernel hands over the port rather than the capability finding one.
 * That matters: the port goes through `section.createDocument()`, the object
 * `refuseBookScripts` wrapped at open. A capability that parsed the file itself
 * would get an UNSTRIPPED document and a path that can disagree by a child
 * index — which is `bookScripts.test.ts`'s *"address the same passage by the
 * same path"* failing silently.
 *
 * ## Why there is a revision signal
 *
 * ⚠️ *"the reader redraws only when its `marks` input changes, so a share
 * arriving mid-session can neither appear nor disappear."* `subscribe` is what
 * a page landing, a withdrawal, or a re-anchoring pass placing something tells
 * the kernel about. It is a signal and not a payload: the kernel calls
 * `forBook` again, which keeps one path for "what should be drawn" instead of
 * two that can disagree.
 */

/** One passage waiting for an anchor, as the resolver takes it. */
export interface PendingPassage {
  readonly id: string
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
}

/** Where the resolver found one. */
export interface ResolvedPassage {
  readonly id: string
  /**
   * ⚠️ **`ResolvedCfi`, and it was `string` — which made the brand optional at
   * the one seam it exists to guard.** A contributor took the resolver's answer
   * and had to widen it back with a cast to build a `ForeignAnnotation`; the
   * circle capability did exactly that (`fresh.cfi as never`), so any string
   * the port returned reached the painter. The invariant WI-22.A1 built was
   * intact everywhere except the place a foreign passage actually crosses.
   *
   * Typed here, no caller needs a cast: `reanchorPass` already produces the
   * brand, and nothing else can produce one at all.
   */
  readonly cfi: ResolvedCfi
  readonly sectionIndex: number
}

/** What a walk of the open book answered. */
export interface ResolveResult {
  readonly found: readonly ResolvedPassage[]
  readonly missed: readonly string[]
  /**
   * Whether the whole book was walked.
   *
   * ⚠️ **A CONTRIBUTOR MUST NOT TREAT AN INCOMPLETE WALK AS A MISS.** `false`
   * means the reader closed the book, or a section would not load — the pass
   * established nothing about what it did not reach, and caching those as
   * "not here" is a permanent wrong answer bought for one interrupted open.
   * `missed` is empty when this is `false`, so the honest reading is forced.
   */
  readonly complete: boolean
}

/**
 * The resolver, as a capability is given it.
 *
 * Structurally exactly `SessionNavigator.reanchor`, which Stage A built —
 * **the port this seam needs already existed before the seam did.** Declared
 * here rather than imported from the reader so `core/` keeps no dependency on
 * `ui/`, and so a capability can be tested against a fake without a DOM.
 */
export type ResolvePort = (pending: readonly PendingPassage[]) => Promise<ResolveResult>

/** What the kernel gives a contributor when it asks. */
export interface OverlayRequest {
  readonly bookId: string
  /** Anchor passages in the book that is OPEN. See the module header. */
  readonly resolve: ResolvePort
}

export interface OverlayContribution {
  /** `<capability>:<name>`, like a pane — so an id says who owns it. */
  readonly id: string
  /**
   * The annotations to draw in this book, already anchored HERE.
   *
   * ASYNC because anchoring parses sections. Answering `[]` is the ordinary
   * case for a book nobody has shared from.
   *
   * ⚠️ **NEVER THROWS FOR A BOOK IT CANNOT SERVE.** One contributor failing
   * must not cost the reader every other contributor's marks, and the kernel
   * treats a rejection as "no annotations" plus one reported line — the same
   * posture `enrichOne` takes, and for the same reason.
   */
  forBook(request: OverlayRequest): Promise<readonly ForeignAnnotation[]>
  /**
   * Tell the kernel something changed. Returns its own unsubscribe.
   *
   * A SIGNAL, not a payload — the kernel re-asks `forBook`, so there is one
   * path for "what should be drawn" rather than two that can disagree about it.
   */
  subscribe(listener: () => void): () => void
}
