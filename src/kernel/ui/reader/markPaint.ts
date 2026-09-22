/**
 * Drawing a mark — the reader's own, or another reader's passage — into
 * foliate's overlay.
 *
 * Out of `session.ts` because none of it reads the session's state. What a
 * mark looks like is decided from the annotation foliate hands back, the
 * painters and the palette; which section is live, and whether the book is
 * still open, stay the session's questions. The types are the vocabulary the
 * host hands the session to draw, and they live with the code that says what
 * they mean.
 */

import type { DrawAnnotationDetail, View } from 'foliate-js/view.js'
import type { ResolvedCfi } from './reanchor'
import { foreignWeight, type OverlayAudience } from '../../core/circle/foreign'
import {
  ANNOTATION_KINDS,
  MARK_STYLES,
  MARK_TINTS,
  type AnnotationKind,
  type MarkStyle,
  type MarkTint,
} from '../../core/marks'

/**
 * Enough of a mark to draw it.
 *
 * Deliberately not the stored `Mark`: the session has no business knowing what
 * a mark's note says or when it was made, and keeping the anchor narrow is what
 * lets the drawing be reasoned about without the store in view.
 */
export interface MarkAnchor {
  /**
   * `ResolvedCfi`, NOT `string` — WI-22.A1, and the twin of the `kind`
   * narrowing below.
   *
   * `kind` refuses a bookmark at this door; this refuses a passage with no
   * anchor in the build now open. The only way to hold one is to have gone
   * through `isPlaced`/`placedIn` (a checked narrowing) or `cfiFor` (the
   * resolver's own mint, which takes a live `Range` as its evidence). A
   * foreign passage arrives as three strings and can do neither, so the
   * compiler stops it here rather than the painter drawing it on whatever the
   * path happens to hit.
   *
   * `surfaces.md`: *"so the compiler refuses an unresolved one at the
   * painter's door, the way `MarkAnchor` narrowing already refuses a bookmark
   * there."*
   */
  readonly cfi: ResolvedCfi
  readonly sectionIndex: number
  /**
   * `AnnotationKind`, NOT `MarkKind` — a bookmark cannot be drawn.
   *
   * The runtime split at `MarkSnapshot` already keeps one away from here, and
   * that was the only thing doing so: this field took the whole union, so the
   * guarantee rested on every caller reading from the right list. `drawMark`
   * is public on the navigator. Narrowing it makes the compiler refuse a
   * bookmark at the painter's door instead.
   */
  readonly kind: AnnotationKind
  /* Carried on the anchor rather than looked up when the overlay draws: the
     painter runs inside a `draw-annotation` handler that has the annotation and
     nothing else, and giving it the store to search would be a second source of
     truth for what a mark looks like, resolved at a different moment. */
  readonly tint: MarkTint
  readonly style: MarkStyle
}

/**
 * Another reader's passage, ready to draw — WI-22.D2.
 *
 * ⚠️ **NOT A `MarkAnchor`, AND THE DIFFERENCE IS THE FEATURE.** A `MarkAnchor`
 * carries `tint` and `style`, which are the READER'S OWN vocabulary —
 * *"agreements in green and questions in purple"* — and `surfaces.md` forbids
 * a friend's mark claiming it: *"A friend's highlight drawn in your tints is a
 * passage you will remember marking and did not."* So this type has neither
 * field, and the wire does not carry them either. There is nothing to ignore.
 *
 * The deleted companion's amber is the precedent and the mechanism: its mark
 * was an amber underline whatever the reader had chosen for their own, because
 * there too the colour was not a preference — it was what said whose mark it
 * was.
 */
export interface ForeignAnchor {
  /** `ResolvedCfi` — the compiler refuses an unanchored passage here (A1). */
  readonly cfi: ResolvedCfi
  readonly sectionIndex: number
  /**
   * The Overlayer key — `circle:<person>:<pub>`.
   *
   * ⚠️ **SEPARATE FROM THE CFI, WHICH IS THE WHOLE POINT.** `review.md`'s
   * overlay blocker 1: `addAnnotation` keys the Overlayer on the annotation's
   * VALUE, so several readers at one CFI collapse into one entry and the last
   * writer wins — *"This breaks the feature's central case — '4 of 11 readers
   * marked this.'"* `Overlayer.add(key, range, …)` already takes them
   * separately; what does not is `addAnnotation`, and that is one line in our
   * own fork (`annotation.key ?? annotation.value`).
   *
   * ⚠️ **UNTIL THE FORK MOVES, THIS IS CARRIED AND IGNORED.** Passing it costs
   * nothing and changes nothing today; the day the fork lands, the collapse
   * stops without another edit here.
   */
  readonly key: string
  /**
   * Whether this came from the reader's circle or from the public layer.
   *
   * ⚠️ **A STRANGER'S MARK WAS DRAWN EXACTLY AS A FRIEND'S.** The public
   * capability said "stranger" by prefixing the person id it produced, which
   * `useOverlays` then dropped — so `attachForeign` labelled every one of them
   * with the circle's painter kind and the reader could not tell a passage
   * somebody they admitted had marked from one anybody at all had. Provenance
   * the reader is meant to SEE has to reach the painter. Found by audit.
   */
  readonly audience: OverlayAudience
  /**
   * How many readers marked this passage — see `foreignWeight`.
   *
   * Weight carries multiplicity because colour cannot WITHIN one audience:
   * there is one neutral hue for every friend, so the only channel left is how
   * heavy the rule is. That is what makes *"4 of 11 readers marked this"*
   * legible without a click, which WI-22.D2's falsifier asks for.
   *
   * ⚠️ **A PUBLIC MARK CANNOT RAMP ON UNBOUND VOICES**, because keys are free
   * — `readersAmong` floors at one and an unbound voice adds no identity, so a
   * thousand of them still draw as one.
   */
  readonly readers: number
}

/**
 * Concrete colours for the two mark provenances.
 *
 * Resolved by the caller at draw time rather than read from a custom property,
 * because the Overlayer sets `fill` as a presentation ATTRIBUTE, and `var()` is
 * not valid in one. Marks would silently draw black.
 */
export interface MarkPalette {
  /** The band drawn behind the words, per tint. */
  readonly fill: Record<MarkTint, string>
  /** The rule drawn under them, per tint — and the colour of the swatch that
   *  offers it, which is why the saturated value lives here and not only in a
   *  stylesheet. */
  readonly rule: Record<MarkTint, string>
  /**
   * The hue every foreign mark is drawn in — one, for every reader.
   *
   * ⚠️ **ONE HUE AND NOT A PALETTE.** Giving each friend a colour would put
   * them in competition with the reader's own three, and `MarkTint` is where
   * the reader's meaning lives. A single neutral rule says *"somebody else"*;
   * `readers` says how many, through weight.
   *
   * ⚠️ **THE DELETED COMPANION'S AMBER WAS THE PRECEDENT FOR THIS** — a hue
   * that is not a preference but a statement of whose mark it is. The mark is
   * gone and the argument is not.
   */
  readonly foreign: string
  /**
   * The hue a mark from OUTSIDE the circle is drawn in — one, for everybody.
   *
   * ⚠️ **QUIETER THAN `foreign`, AND THAT IS THE DECISION.** A friend had to
   * be admitted; a stranger needs only a key, and keys are free. So the public
   * layer is the one an attacker can fill, and a treatment that competed with
   * the reader's own marks would make filling it worth doing. Same SHAPE as a
   * friend's rule — hue is the channel, and one shape for everybody who is not
   * the reader keeps it that way.
   */
  readonly stranger: string
}

/**
 * The Overlayer's draw functions, passed in so foliate stays lazily loaded.
 *
 * One per `MarkStyle`. Named for the STYLE rather than for the Overlayer
 * function behind it — `wave` is foliate's `squiggly`, and §15's word is the
 * one the interface uses.
 *
 * ⚠️ **`wave` HAS NO READER-FACING PRODUCER** — `READER_STYLES` does not offer
 * it and the store reads a stored one back as an underline. It stays because
 * `styleOf` reads what foliate hands back, untyped, and a value the type system
 * never saw must still land on a painter rather than on `undefined`.
 */
export interface MarkPainters {
  readonly fill: unknown
  readonly underline: unknown
  readonly wave: unknown
}

/**
 * `Node.ELEMENT_NODE`, spelled as its value — the reason is `DOCUMENT_NODE`'s,
 * in `session.ts`: these paths are tested with no DOM, so there is no `Node`
 * global to read the constant off.
 */
const ELEMENT_NODE = 1

/**
 * Paint one annotation foliate asked for; true when it was one of the READER'S
 * marks, which is the only kind the caller reports.
 *
 * The body of the session's `draw-annotation` handler, and every comment in it
 * is about that event: foliate emits it once per mark per overlay, carrying the
 * annotation it was given, the live range, and a `draw` that takes a painter.
 */
export function paintAnnotation(
  detail: DrawAnnotationDetail,
  painters: MarkPainters,
  palette: MarkPalette,
): boolean {
  /* The book document travels with the draw options so the highlight
   * painter can read the font the rects were measured in — see
   * `balanceRects`. Taken from the range rather than added to the event
   * type, because the range is already in hand and cannot disagree. */
  /* From the EVENT, not rebuilt from the range. `startContainer` can be a
   * Document when a range spans a whole node, and `ownerDocument` on a
   * Document is null — so the reconstruction lost exactly the case it was
   * meant to cover. A Range always has a start container, so only the range
   * itself can be missing. */
  const doc = detail.doc ?? detail.range?.startContainer.ownerDocument ?? null
  /* The element the marked words are in, so the band is measured against
   * the font they are actually drawn in rather than the book's default —
   * a mark in a heading or a code span is not body text. */
  const container = detail.range?.startContainer ?? null
  const at =
    container && container.nodeType === ELEMENT_NODE
      ? (container as Element)
      : (container?.parentElement ?? null)
  /* ⚠️ **EVERY RULE PAINTER READS THIS, AND NONE OF THEM WERE TOLD.**
   * foliate's `underline`, `strikethrough` and `squiggly` each take
   * `writingMode` and put the rule on the block's far edge — under the
   * words horizontally, beside the column in a vertical book. Omitted, the
   * default is horizontal, so in a `vertical-rl` book every rule Paper
   * draws — the reader's own and a friend's — is struck across the text
   * instead of alongside it. The fill painter is
   * the only one that noticed vertical writing, and it noticed in order to
   * bail (`balanceRects`); the three that could simply have been told were
   * the ones left wrong. */
  const writingMode = writingModeAt(doc, at)
  /* The three values ride along on the annotation so the painter does not
   * have to look the mark up again: `annotation` carries whatever
   * `annotationFor` put on it, and reading the store from in here would be
   * a second answer to "what does this mark look like", resolved at a
   * different moment from the first. */
  /* WHAT MAY BE DRAWN, ASKED AS A WHITELIST. The last branch treats
   * everything it is handed as a reader's highlight, which would classify
   * by exclusion without this — so a `bookmark` arriving here would be
   * painted as a gold band over a passage the reader never marked. The
   * compile-time split makes that unreachable today: `getMarks` hands over
   * annotations and `MarkAnchor.kind` is `AnnotationKind`. This is the same
   * defensiveness the comment below asks for, applied to the field that
   * decides which painter runs rather than only to the ones that decide
   * what colour it is — foliate round-trips this object untyped, so the
   * value arriving here is not the value the type system saw. */
  /* ⚠️ **A WHITELIST THAT ONLY REFUSED STRINGS IS NOT A WHITELIST.** The
   * test was `typeof kind === 'string' && !includes(kind)`, so a `kind`
   * that was absent, `null` or a number fell PAST it and was painted by
   * the final branch as a yellow fill — a band over a passage the reader
   * never marked, which is the exact defect the comment above describes
   * for `bookmark`. Every mark this code draws sets `kind` (`annotationFor`
   * takes it from a required field), so nothing legitimate arrives without
   * one; foliate round-trips the object untyped, which is why the check
   * has to hold for values the type system never saw.
   *
   * `includes` IS THE WHOLE CHECK: over a list of strings it answers false for
   * anything not in it, a non-string included, so a `typeof` beside it could
   * change no outcome. */
  const annotation = detail.annotation as Readonly<Record<string, unknown>> | undefined
  const kind = annotation?.['kind']
  if (!(PAINTABLE_KINDS as readonly unknown[]).includes(kind)) return false
  /* Present from here: a paintable kind was read off it. */
  const carried = annotation as Readonly<Record<string, unknown>>
  if (kind === FOREIGN_KIND || kind === PUBLIC_KIND) {
    /* ⚠️ **AN UNDERLINE, IN ONE HUE, WITH WEIGHT CARRYING MULTIPLICITY.**
     * The reader's three tints say what THEY meant by a passage; a
     * friend's mark must not claim that vocabulary, so it gets none of
     * them and the colour is not a preference — it is what says whose mark
     * this is.
     *
     * A RULE and not a fill, because the central case is several people on
     * one sentence and fills stack illegibly. Weight is then the only
     * channel left, which is what makes "4 of 11 readers marked this"
     * readable without a click. */
    /* ⚠️ **AND A STRANGER'S IS QUIETER THAN A FRIEND'S, NOT LOUDER.**
     * `palette.stranger` is the only channel that separates them — the
     * shape is the same rule for both — and it is the more recessive of
     * the two on every theme. A passage somebody you admitted marked is worth more
     * of your attention than one anybody at all did, and free keys mean
     * the public layer is the one an attacker can fill. */
    detail.draw(painters.underline, {
      color: kind === PUBLIC_KIND ? palette.stranger : palette.foreign,
      /* `foreignWeight` reads anything that is not a finite count of at least
         one as one reader's worth — which is exactly the guard the untyped
         round-trip needs, so it takes the value as it came. A `readersOf`
         beside it applied the same guard a second time. */
      width: foreignWeight(carried['readers'] as number),
      writingMode,
    })
    /* ⚠️ **FALSE — A FOREIGN PASSAGE IS NOT ONE OF THE READER'S MARKS, so it
     * is not reported.** `onMarkDrawn` fills the map `useMarking` describes as
     * *"ranges for the marks foliate has drawn"*, which the margin
     * measures to place a control beside each one. Reporting a friend's
     * underline put an entry there for a CFI the reader has no mark at,
     * and nothing ever took it out again: `forgetRange` is called from
     * `unmark`, and a foreign passage is never unmarked. So the map grew a
     * Range per foreign mark per redraw, each retaining the DOM it points
     * into, for as long as the book stayed open. */
    return false
  }

  /* Read defensively. `Annotation` carries arbitrary values through
   * foliate untyped, and an annotation from an older build — or one
   * foliate has round-tripped — has neither field. Falling back to the
   * same default `validMarks` uses keeps one answer for "an old mark". */
  const tint = tintOf(carried['tint'])
  const style = styleOf(carried['style'])
  /* THE FILL COLOUR FOR A BAND, THE RULE COLOUR FOR A LINE, which is the
   * whole reason each tint is a pair: a fill saturated enough to read as a
   * 2px line makes its own words unreadable, and a rule pale enough to sit
   * behind text is not a line, it is a smudge. */
  if (style === 'fill') {
    detail.draw(painters.fill, { color: palette.fill[tint], doc, at })
  } else {
    detail.draw(painters[style], { color: palette.rule[tint], writingMode })
  }
  return true
}

/**
 * The object handed to foliate. `value` is the anchor it resolves; `kind` is
 * ours, carried through untouched and read back in `draw-annotation`.
 */
function annotationFor(
  anchor: MarkAnchor,
): { value: string; kind: AnnotationKind; tint: MarkTint; style: MarkStyle } {
  return { value: anchor.cfi, kind: anchor.kind, tint: anchor.tint, style: anchor.style }
}

/**
 * The `kind` a foreign mark carries through foliate.
 *
 * ⚠️ **NOT ADDED TO `ANNOTATION_KINDS`, and that is deliberate.** That list is
 * the STORED mark kinds — what `validMarks` accepts off disk and what
 * `Mark.kind` may be. A foreign passage is never a stored mark; putting it
 * there would make every reader of that constant have to remember the
 * exception. This is a painter kind, and `PAINTABLE_KINDS` is the whitelist
 * the draw handler checks.
 */
const FOREIGN_KIND = 'circle'

/**
 * The `kind` a PUBLIC mark carries through foliate.
 *
 * ⚠️ **A SECOND KIND RATHER THAN A FIELD ON THE FIRST**, because `kind` is
 * what the draw handler's whitelist is written over and what foliate
 * round-trips untyped. A treatment chosen from an extra property would have to
 * be read defensively at the painter — the reason `tintOf` and `styleOf` exist
 * — and a value that failed to round-trip would silently draw a stranger's
 * mark as a friend's, which is the defect this exists to fix.
 */
const PUBLIC_KIND = 'public'

/**
 * What the painter will draw, asked as a WHITELIST.
 *
 * ⚠️ The handler's own note explains why this is a whitelist rather than "not
 * a bookmark": classifying by exclusion means a `bookmark` arriving here is
 * painted as a band over a passage the reader never marked. Widening the
 * whitelist by one entry keeps that property; widening the *stored* kinds
 * would not.
 */
const PAINTABLE_KINDS: readonly string[] = [...ANNOTATION_KINDS, FOREIGN_KIND, PUBLIC_KIND]

/** One of the three tints, or yellow — the same default `validMarks` applies. */
function tintOf(value: unknown): MarkTint {
  return MARK_TINTS.includes(value as MarkTint) ? (value as MarkTint) : 'yellow'
}

/** One of the four styles, or a fill — again the default `validMarks` applies. */
function styleOf(value: unknown): MarkStyle {
  return MARK_STYLES.includes(value as MarkStyle) ? (value as MarkStyle) : 'fill'
}

/** How `attachMark` is asked to act — see it for why `report` exists. */
interface AttachOptions {
  readonly remove?: boolean
  readonly report?: boolean
}

/**
 * Attach or erase one FOREIGN mark.
 *
 * ⚠️ **`key` IS SENT AND IS IGNORED UNTIL THE FORK MOVES.** `addAnnotation`
 * currently keys the Overlayer on `value`, so several readers at one CFI still
 * collapse into one entry — `review.md`'s overlay blocker 1. `Overlayer.add`
 * already takes a key separately; the one line that connects them is
 * `annotation.key ?? annotation.value` in our own fork. Sending it now costs
 * nothing, changes nothing, and means the day the fork lands no edit is needed
 * here — which is the difference between a fix that is one commit away and one
 * that is one commit plus an archaeology session away.
 *
 * `report: false`, like the speculative offers `attachMark` makes: a foreign
 * mark is offered when the overlay is built and again when it lands, and
 * reporting the first attempt would log a line per mark per page.
 */
export async function attachForeign(view: View, anchor: ForeignAnchor, remove = false): Promise<boolean> {
  try {
    await view.addAnnotation(
      {
        value: anchor.cfi,
        key: anchor.key,
        kind: anchor.audience === 'public' ? PUBLIC_KIND : FOREIGN_KIND,
        readers: anchor.readers,
      },
      remove,
    )
    return true
  } catch {
    /* Same expected failure as `attachMark`'s: a CFI addresses a position in a
       document, and a PDF page has no text until it has been painted.
       ⚠️ ANSWERED rather than only swallowed — the session's `#foreignPass`
       needs to know whether an ERASE actually happened, because a withdrawal
       it cannot retry is a mark that stays on the page for ever. Still not
       reported: these are speculative offers made once per mark per page. */
    return false
  }
}

/**
 * Which way the marked text runs, as foliate's rule painters ask for it.
 *
 * Measured on the element the words are in rather than on `body`, for
 * `balanceRects`' reason: an EPUB is free to set `writing-mode` on a section,
 * a pull quote or a single element, so the book's default is not the answer.
 *
 * `undefined` when the document cannot be reached, which is exactly what
 * omitting the option meant — so an unreachable document is the old behaviour
 * rather than a new failure. A document torn down between the event and this
 * call is that case: it has no view to measure with, and the guard below is
 * what answers for it. The rule is still worth drawing; only its side is not
 * known. (A `try` around the measurement said the same thing a second time —
 * with a view and an element, `getComputedStyle` has nothing to throw about.)
 */
function writingModeAt(doc: Document | null, at: Element | null): string | undefined {
  const view = doc?.defaultView
  const target = at && at.ownerDocument === doc ? at : doc?.body
  if (!view || !target) return undefined
  return view.getComputedStyle(target).writingMode || undefined
}

/**
 * Attach or erase one mark, tolerating an anchor that does not resolve.
 *
 * Unlike the silent catches `session.ts` has had to remove, this failure is
 * expected and specific: a CFI addresses a position in a document, and a PDF
 * page has no text in it until it has been painted. Marks are offered when the
 * section's overlay is created — before that paint — and offered again once it
 * lands, which is when they take. Reporting the first attempt would log a line
 * per mark per page on every book that has any.
 *
 * Which is why `report` exists rather than the catch being unconditional. That
 * reasoning covers the speculative offer and NOTHING else: when the reader
 * marks a passage, or removes one, a failure means the mark they just made did
 * not appear, there is no retry coming, and swallowing it leaves them looking
 * at a page that quietly disagrees with the notes panel.
 */
export function attachMark(view: View, anchor: MarkAnchor, options: AttachOptions = {}): void {
  const { remove = false, report = false } = options
  const fail = (cause: unknown) => {
    if (report) console.error(`Paper: could not ${remove ? 'erase' : 'draw'} a mark`, cause)
  }
  try {
    void view.addAnnotation(annotationFor(anchor), remove).catch(fail)
  } catch (cause) {
    // Threw synchronously — same case, same reasoning.
    fail(cause)
  }
}
