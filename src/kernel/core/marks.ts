/**
 * Marks — the annotation store.
 *
 * §15's lexicon is the vocabulary here, in code as well as in the interface: a
 * **mark** is a highlight in the text, a **note** is a written annotation. So a
 * mark carries an optional note rather than the two being separate records —
 * writing a note about a passage always highlights it, and there is no way to
 * have a note anchored to nothing.
 *
 * The anchor is a foliate CFI, which is what makes a mark survive a reflow: it
 * addresses a position in the book's own markup rather than an offset into a
 * rendered layout, so changing the reading step, the theme or the window width
 * moves the highlight with the words instead of stranding it.
 *
 * The anchoring and merge rules are pure, which is what lets them be tested
 * without a DOM or a book. Three functions here are NOT: the two storage
 * helpers, and `bookIdFor`, which since it began hashing content reads a file
 * or fetches a URL. Worth stating plainly — the header used to claim everything
 * but storage was pure, and identity quietly stopped being so.
 */

import { compare } from 'foliate-js/epubcfi.js'
import { identityParts } from './contentIdentity'
import { MAX_RECORD_FIELD, MAX_RECORD_POSITION } from './bookFolder'
import { hlcOf, isHlc, laterHlc, type Hlc } from './hlc'
import type { ResolvedCfi } from './resolvedCfi'

/**
 * WHAT A RECORD IS — no longer only whose it is.
 *
 * This field was PROVENANCE for as long as there were two things in the world
 * that could be written against a passage: §01 gives marks two of them and
 * draws them differently, your own highlight a gold fill and the companion's an
 * amber underline, and they were one type rather than two because everything
 * else about them — anchor, note, lifecycle, the Marginalia list — is identical.
 *
 * A bookmark broke that reading, and it is worth being plain about how rather
 * than quietly widening the union. A bookmark is not a third author; it is a
 * different KIND OF THING with the same shape — a place the reader chose to be
 * able to return to, carrying an anchor, a section, a chapter label and the
 * stamps, and carrying them so exactly that a separate record would have been
 * the same eleven fields under another name. What it does not have is a
 * drawing: nothing paints it into the text, so `tint` and `style` mean nothing
 * on one, and it never reaches a painter, the margin or the Marginalia list.
 *
 * PROVENANCE IS NOW DERIVED, not stored: the companion's is the one kind that
 * is not the reader's. That is the same information as before, asked as a
 * question instead of read off a field.
 *
 * The separation this buys is in `annotationsIn` and `bookmarksIn`, applied at
 * the ONE door the store publishes through — see `MarkSnapshot`. Nothing
 * downstream filters on this, and nothing downstream can be handed a bookmark
 * by accident.
 */
/**
 * The two CLASSES, each as its own list — and `MARK_KINDS` built from them.
 *
 * Membership, not exclusion. `AnnotationKind` was `Exclude<MarkKind,'bookmark'>`
 * and `isAnnotation` was `kind !== 'bookmark'`, which means every kind added in
 * future is drawable BY DEFAULT: a second undrawable kind would be handed
 * straight to the painters, the margin and selection resolution without anyone
 * choosing that. Adding a kind now means putting it in one of these two lists,
 * which is a decision rather than an omission.
 */
export const ANNOTATION_KINDS = ['highlight', 'companion'] as const
export const BOOKMARK_KINDS = ['bookmark'] as const

export const MARK_KINDS = [...ANNOTATION_KINDS, ...BOOKMARK_KINDS] as const
export type MarkKind = (typeof MARK_KINDS)[number]

/**
 * A kind that can be DRAWN — everything a painter, the margin column, the
 * Marginalia list and a selection may legitimately be handed.
 *
 * Derived from the registry above rather than by subtraction, so a kind that is
 * added without being classified does not quietly become drawable.
 *
 * This exists because the runtime split at `MarkSnapshot` was the ONLY thing
 * keeping a bookmark away from the painter. Nothing reached it — `getMarks`
 * hands over `snapshot.current`, which is annotations — but `MarkAnchor.kind`
 * accepted the whole union, so the promise was kept by every caller
 * remembering rather than by the types. `drawMark` is public on the navigator;
 * one future caller reading from the wrong list is all it would take, and a
 * bookmark drawn as a highlight is a gold band over a page the reader never
 * marked.
 */
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

/**
 * Which of the three tints the reader chose for a mark.
 *
 * SEPARATE FROM `kind`, and the separation is the whole point: `kind` is
 * PROVENANCE — whose mark this is — and this is APPEARANCE. The two were one
 * field for as long as there were only two marks in the world, yours and the
 * companion's, and "gold fill" was simply what "yours" looked like. A reader
 * who can choose green needs the two to come apart, or choosing a colour would
 * be claiming a passage was written by somebody else.
 */
export type MarkTint = 'yellow' | 'green' | 'purple'

/**
 * How a mark is drawn: a band behind the words, or one of three rules under
 * them.
 *
 * Every one of the three is a painter the Overlayer already has — `highlight`,
 * `underline` and `squiggly`. A double underline was here and is not any more:
 * upstream has no painter for one, the composed substitute was a rule too
 * close to `underline` to be worth choosing between, and a style in this union
 * that nothing draws correctly is a mark the reader can pick and then not see.
 */
export type MarkStyle = 'fill' | 'underline' | 'wave'

/** The three tints, in the order the selection bar offers them. */
export const MARK_TINTS: readonly MarkTint[] = ['yellow', 'green', 'purple']

/** Every style a stored mark may carry, whoever made it. */
export const MARK_STYLES: readonly MarkStyle[] = ['fill', 'underline', 'wave']

/**
 * The styles the reader may choose. NOT the wave.
 *
 * THE WAVE IS THE COMPANION'S, and reserving it is what keeps provenance
 * readable. §01 gave the companion an amber underline back when your own mark
 * was always a gold fill — shape and colour both said whose it was, redundantly.
 * That redundancy went when the reader gained styles of their own: with both
 * able to draw rules, the only thing separating a machine's claim from your own
 * reading was amber against yellow on a two-pixel line, and that is the one
 * distinction in this app that must never blur.
 *
 * The wave rather than every rule, which was the other candidate. A squiggle is
 * the strongest convention there is for "something automated has an opinion
 * here" — every spell checker ever written — so it reads as provisional without
 * being taught, which is exactly what a companion's claim is. And for the same
 * reason it is a poor shape for a reader's OWN mark: a squiggle under prose
 * reads as an error, which is the wrong note for "this is worth remembering".
 * Reserving it costs the reader a style they should not want.
 *
 * So the companion is distinguished on three independent channels rather than
 * one: a hue outside the reader's palette, a shape no reader's mark can be, and
 * the word — §10 is explicit that colour never carries meaning alone, and Notes
 * and the margin both label a companion row as well as tinting it.
 */
export const READER_STYLES: readonly MarkStyle[] = ['fill', 'underline']

/**
 * The two choices that decide how a mark is drawn.
 *
 * Passed EXPLICITLY to `mark` rather than read from app state inside it. A
 * swatch click has to mark in the tint that was clicked, and the dispatch that
 * records the new tint has not been applied yet at that moment — so a `mark`
 * that consulted state would lay down the previous colour, once, on the very
 * gesture that chose a new one.
 */
export interface MarkAppearance {
  readonly tint: MarkTint
  readonly style: MarkStyle
}

export interface Mark {
  readonly id: string
  /** Which book this belongs to. See `bookIdFor`. */
  readonly bookId: string
  /** foliate CFI. The anchor, and the sort key within a book. */
  readonly cfi: string
  /**
   * Which spine item the mark is in.
   *
   * Recorded at creation rather than derived from the CFI, because deriving it
   * needs foliate's CFI parser. foliate hands the renderer's annotations to the
   * overlay one section at a time (`create-overlay` carries an index), so
   * without this every mark in the book would have to be offered for every
   * section and resolved to find out where it belongs.
   */
  readonly sectionIndex: number
  /** The marked words, for the Marginalia list and the margin. */
  readonly text: string
  /**
   * The text immediately before and after the mark — see `markContext`.
   *
   * Empty when the mark sits at the edge of its section, or when it was made
   * before this field existed. Nothing reads it yet, and it is stored anyway:
   * a CFI locates a passage inside ONE package and resolves to the wrong text
   * in a different build of the same work without erroring, so re-finding a
   * passage needs the quote plus what surrounds it. The quote alone is not
   * enough — "the whale" occurs hundreds of times.
   *
   * It has to be captured at creation. Recovering it later means re-opening
   * the book and resolving the CFI, which is the operation that has already
   * failed by the time anyone needs this.
   */
  readonly prefix: string
  readonly suffix: string
  /** The written note. Empty when the mark is a bare highlight. */
  readonly note: string
  readonly kind: MarkKind
  /**
   * How this mark is drawn — see `MarkTint` and `MarkStyle`.
   *
   * ON THE MARK, not read from the current setting at draw time, because the
   * colour IS part of the annotation. A reader who puts agreements in green and
   * questions in purple has said something about each passage; redrawing their
   * history in whatever the toggle happens to hold now would erase it, and
   * would do so retroactively, every time they changed their mind about the
   * next passage.
   *
   * Both are absent from every mark written before this existed — which is all
   * of them — so neither is required by `readStoredMark`. See `readTint`.
   */
  readonly tint: MarkTint
  readonly style: MarkStyle
  /** TOC label at the time of marking, for "Ch. 1" in the Marginalia list. */
  readonly chapter: string
  readonly createdAt: number
  /**
   * Present when this mark has NO ANCHOR IN THIS LIBRARY (WI-21.7).
   *
   * ⚠️ **THE ONE STATE THAT MAKES AN EMPTY `cfi` LEGAL, and it is a discriminator
   * rather than a flag for that reason.** `readStoredMark` refuses an empty `cfi`
   * because *"nothing to resolve, so the mark can never be drawn — it sits in
   * the Marginalia list forever pointing at nothing"*, and that reasoning is
   * still exactly right. What it forbids is an anchorless mark that nobody
   * MEANT: this says the anchorlessness is deliberate, says where the mark came
   * from, and puts the mark in a class the painter is never handed.
   *
   * Stage 1 had no such state, so a name-matched import had to refuse the marks
   * outright — the plan's one user-visible regression. This is what lets them
   * come across, be read, be searched, and be re-anchored later.
   *
   * `sectionIndex` on an unplaced mark is 0 and means nothing. It is not −1:
   * `readStoredMark` refuses a negative index for a real reason (it matches no section
   * and would make the mark undrawable BY ACCIDENT), and safety that depends on
   * an out-of-range number is the shape this field exists to replace.
   */
  readonly unplaced?: UnplacedMark
  /* ---- The ledger's stamps (phase 6). Optional: a mark written before the
   * ledger has neither, and `markStamp` reads its `createdAt` instead. ---- */
  /** When the mark was last EDITED — a note written, a row merged. */
  readonly updatedAt?: Hlc
  /**
   * The tombstone. A removed mark KEEPS ITS ROW with this stamp on it,
   * because a deletion has to be able to travel: a row that simply vanishes
   * from the file looks, to a replica that still has it, like a row the
   * other side has not seen yet — and comes straight back. Every read model
   * filters to `liveMarks`, so a tombstone is invisible everywhere but the
   * file and the merge.
   */
  readonly deletedAt?: Hlc
}

/** A mark being created — the store assigns identity and time. */
export type NewMark = Omit<Mark, 'id' | 'createdAt'>


/**
 * Stable identity for a book across sessions.
 *
 * A File has no durable identifier — the same book re-picked from disk is a
 * different File object — so the identity has to come from the content.
 *
 * It is derived from the content rather than from the name and size, which is
 * what this used to be. Name and size collide in ways that are not exotic: two
 * files named `book.pdf` in different folders, or the same title from two
 * sources, and the reader silently gets the other book's marks, cards and
 * reading position. Revising a file without changing its length does the same
 * thing in reverse. Content also survives copying, moving and re-downloading,
 * which an mtime does not.
 *
 * WHY THE ENDS ARE NOT ENOUGH. This used to hash only the size and the first and
 * last 64KB, on the reasoning that 128KB spans an EPUB's mimetype and opening
 * spine item, or a PDF's header and trailer, and that no two different books
 * share those. That is a statement about the ends of a file, and it says nothing
 * at all about the middle. Reproduced on 2026-08-16: two files of equal length
 * with identical first and last 64KB and one differing kilobyte in between both
 * hashed to `file:97055b281d7b0385e0297135aece6323`, and one book's marks,
 * cards and reading position therefore belonged to the other.
 *
 * So a book that fits is hashed WHOLE, and identity is exact. Only above the
 * limit does this fall back to sampling, and then it probes the interior as
 * well as the ends.
 *
 * WHY A URL IS NO LONGER USED AS-IS. It was, and the same bytes therefore had
 * two identities depending on how they were opened — `url:/sample.epub` from the
 * address and `file:63d69499…` from the picker — so marks made on one did not
 * exist on the other. Identity is derived from CONTENT now, whatever route the
 * content arrived by, which is the property every later feature needs and the
 * reason the prefix is no longer named after a source.
 */
/* THE SAMPLING GEOMETRY MOVED TO `contentIdentity.ts`, and the move is not
 * tidying: that module imports NOTHING, which is what lets a plain `.mjs`
 * load it. Node strips TypeScript types but will not fill in a missing
 * extension, and this file's `./hlc` import is enough to make it unloadable
 * from a script — so `scripts/measure-book-identity.mjs` carried a second copy
 * of these numbers, held to this one by a parity test, on the false premise
 * that a `.mjs` cannot import a `.ts`. It can. The leaf split is the same
 * remedy `vaultFsTauri.ts` is, for the same shape of problem.
 *
 * RE-EXPORTED rather than re-declared, so every existing caller and test keeps
 * importing `identityParts` from here and the public surface does not move. */
export { FULL_HASH_LIMIT, INTERIOR_PROBES, SAMPLE_BYTES, identityParts, identityWindows } from './contentIdentity'

/** The content id of a blob, whatever route it arrived by. */
export async function contentId(blob: Blob): Promise<string> {
  const sample = new Blob(identityParts(blob))
  const digest = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer())
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
  // Half the digest. This is an identity, not a security boundary, and 128 bits
  // of it makes an accidental collision impossible in a personal library. If it
  // ever becomes the key a PEER uses to decide which book you are discussing,
  // that sentence stops being true and this needs revisiting.
  return `book:${hex.join('').slice(0, 32)}`
}

export async function bookIdFor(source: File | string): Promise<string> {
  if (typeof source !== 'string') return contentId(source)

  /* A URL is read rather than trusted. It costs one fetch, which the renderer
   * is about to make anyway and which the cache serves — and it is the only way
   * the same book opened two ways can be the same book. A failure here is
   * reported by the caller as "could not identify this book", which is the
   * honest outcome: a URL that cannot be fetched cannot be opened either. */
  const response = await fetch(source)
  if (!response.ok) throw new Error(`could not read ${source}: ${response.status}`)
  return contentId(await response.blob())
}

/**
 * Sort by CFI, so the Marginalia list reads in book order rather than in the order
 * the reader happened to make the marks.
 *
 * The comparison is foliate-js's own `epubcfi.compare`, not one written here.
 * Two attempts came before it and both were wrong:
 *
 *   Plain string order walks digit by digit, so `/2/10` sorts before `/2/4`
 *   and chapter 10's marks appear among chapter 4's. Any book with more than
 *   nine of anything hits it.
 *
 *   Natural order — numeric runs compared as numbers — fixes that and is still
 *   wrong, because a CFI is not a string with numbers in it. It carries
 *   ASSERTIONS: `/6/4[chap01ref]!/4` addresses the same place as `/6/4!/4`, and
 *   the bracketed part must not participate in ordering. `view.getCFI`
 *   generates assertions whenever the element it anchors to has an id, so this
 *   is what real books produce, not an exotic case. Checked against
 *   foliate-js's own test vectors, the hand-rolled version failed two of seven.
 *
 * It is a dependency we already ship, under MIT, exporting exactly this. There
 * was never a reason to reimplement the spec beside it.
 */
export function compareMarks(a: Mark, b: Mark): number {
  /* The SECTION first, because it is the one part of a mark's position that is
   * a plain number and is known to be right. Two CFIs from different spine
   * items are not comparable as strings at all — they address positions in
   * different documents — so a book whose sections carry structurally
   * different CFIs could interleave two chapters' marks. Comparing the section
   * first makes that unrepresentable, and leaves the CFI to do the only job it
   * is good at: ordering within one section. */
  if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex
  if (a.cfi === b.cfi) return a.createdAt - b.createdAt
  const order = compareCfi(a.cfi, b.cfi)
  return order !== 0 ? order : a.createdAt - b.createdAt
}

/**
 * Order two CFIs, tolerating one that will not parse.
 *
 * Measured rather than assumed, because the obvious guess is wrong: a malformed
 * STRING does not throw. `epubcfi.compare` parses `''`, `'not a cfi'` and
 * `'epubcfi('` alike into a degenerate path that simply sorts first. Only a
 * non-string throws, and `readStoredMark` already refuses to load one of those.
 *
 * So the catch is not load-bearing today — it is a boundary guard for a
 * comparator that is exported and sorts data coming out of storage, where one
 * bad row must never take the whole Marginalia list down with it. Equal, so the
 * pair falls through to creation time, which is what an unorderable pair has
 * always done here.
 */
export function compareCfi(a: string, b: string): number {
  try {
    return compare(a, b)
  } catch {
    return 0
  }
}

/**
 * The marks that are THERE — the filter every read model applies.
 *
 * A tombstoned row exists for the merge, not for the reader: it must never be
 * drawn, listed, counted or offered. Returns its input by identity when
 * nothing is deleted, the convention every store's change-detection relies on.
 */
export function liveMarks(marks: readonly Mark[]): readonly Mark[] {
  return marks.some((mark) => mark.deletedAt !== undefined)
    ? marks.filter((mark) => mark.deletedAt === undefined)
    : marks
}

/**
 * The two classes of record, as types.
 *
 * The split used to exist only at runtime, in `MarkSnapshot`, and that was the
 * whole of it: every downstream promise — nothing paints a bookmark, the
 * margin reserves no column for one, Notes never lists one — rested on each
 * consumer reading from the correct list. A `Mark` was a `Mark`, so the
 * compiler had no opinion. Naming the classes moves those promises into the
 * types, where forgetting one is a build failure instead of a gold band drawn
 * over a page the reader never marked.
 *
 * INTERSECTIONS RATHER THAN A DISCRIMINATED UNION OF TWO RECORD SHAPES, which
 * was the other candidate and is deliberately not taken. `Mark` is also the
 * WIRE type: `parseWireMarks` reads it off a peer's frame and `marksDigest` is
 * computed over it, so splitting the stored shape in two would put a protocol
 * change under a type-safety improvement. One record on disk and on the wire,
 * two views of it in the code.
 */
export type Annotation = Mark & { readonly kind: AnnotationKind }
/**
 * The reader's OWN mark on the text — the one kind a mark control is offered
 * on. A companion annotation is a claim somebody else's model made, and a
 * control that shares "what I marked" must not be handed one as though the
 * reader had; the type says so where the row's `kind` check used to.
 */
export type Highlight = Annotation & { readonly kind: 'highlight' }

export function isHighlight(mark: Annotation): mark is Highlight {
  return mark.kind === 'highlight'
}
export type Bookmark = Mark & { readonly kind: (typeof BOOKMARK_KINDS)[number] }

/**
 * Which side of the line a record is on.
 *
 * TYPE PREDICATES, so the answer narrows rather than merely being known. The
 * read models below are written in terms of these two and nothing else tests
 * `kind` directly, which is what keeps "which side is this on" a question with
 * exactly one implementation.
 */
export function isBookmark(mark: Mark): mark is Bookmark {
  return isBookmarkKind(mark.kind)
}

/** The class rule by KIND alone — for a row that is not yet a `Mark`, such
 *  as an archive's, so the archive and the store cannot disagree about which
 *  kinds are a bookmark. ONE copy; `isBookmark` and `sameClass` read it. */
export function isBookmarkKind(kind: MarkKind): boolean {
  return (BOOKMARK_KINDS as readonly string[]).includes(kind)
}

export function isAnnotation(mark: Mark): mark is Annotation {
  return (ANNOTATION_KINDS as readonly string[]).includes(mark.kind)
}

/**
 * Whether two records are the same KIND OF THING — both places, or both about
 * a passage.
 *
 * THE LINE THAT REPLACEMENT RESPECTS, and it is not `kind === kind`. A reader
 * marking over a passage the companion has claimed replaces it, and always
 * has; that is two kinds, one class, and it stays. What must never happen is a
 * bookmark and a highlight superseding one another because they share an
 * anchor — bookmarking the page you are reading would silently delete the
 * highlight you made on it, and re-marking that highlight would delete the
 * bookmark back. The two are not competing for the same place; they are not
 * the same kind of claim on it.
 */
export function sameClass(a: Mark, b: Mark): boolean {
  return isBookmark(a) === isBookmark(b)
}

/**
 * Why a mark has no anchor here, and what could be used to find one.
 *
 * PROVENANCE, NEVER AN ANCHOR. `fromBook` is the archive row's own `bookId` —
 * a foreign library's content id, meaningless as a path into this one — and it
 * is carried so a re-anchoring pass can say which import a mark arrived on, and
 * so a reader can be told. Nothing may resolve it.
 */
export interface UnplacedMark {
  /** Why it could not be placed. One value today; a union so a second reason
   *  has to be admitted here rather than overloading this one. */
  readonly reason: 'foreign-build'
  /** The `bookId` of the archive row it came from. Provenance only. */
  readonly fromBook: string
}

/**
 * A mark whose `cfi` addresses a passage in the build now open — WI-22.A1.
 *
 * The `Annotation` of the anchor world: `Annotation` narrows `kind` so the
 * painter's door can refuse a bookmark, and this narrows `cfi` so the same
 * door can refuse a passage with no anchor here. Both are produced the same
 * way — by a filter over a type predicate, never by a cast.
 */
export type Placed<T extends Mark> = T & { readonly cfi: ResolvedCfi }

/**
 * Whether a mark has an anchor in THIS library.
 *
 * ⚠️ **A TYPE PREDICATE, and that is the whole of WI-22.A1 on this side.** It
 * used to answer `boolean`, so `placedIn` handed the painter the same widened
 * type it was given and the guarantee lived in a comment. `isAnnotation` is
 * the precedent and the reason the shape is this one: a runtime check that
 * establishes an invariant should hand back the narrowed type, so a caller who
 * skips the check fails to build rather than failing to draw.
 *
 * The brand is `ResolvedCfi`, whose only cast is in `reanchor.ts`. Nothing is
 * asserted here that the two conditions do not establish: `unplaced` absent
 * means no foreign path was carried across an import, and a non-empty `cfi`
 * means there IS a path — which together is what `ResolvedCfi` claims.
 */
export const isPlaced = <T extends Mark>(mark: T): mark is Placed<T> =>
  mark.unplaced === undefined && mark.cfi !== ''

/**
 * The marks that can actually be drawn — placed annotations, nothing else.
 *
 * ⚠️ **THE FILTER THE OVERLAY NEEDS AND `annotationsIn` IS NOT.** An unplaced
 * mark IS about a passage: Marginalia lists it, search finds its text, the
 * reader can read their own note on it. It simply has nowhere to be painted.
 * Splitting on "is it an annotation" would either hide it from the list or
 * offer it to the painter, and both are wrong.
 *
 * Returns its input by identity when there is nothing to drop, the convention
 * every store's change-detection relies on. `every` with a type predicate
 * narrows the ARRAY, which is what lets that convention survive the stronger
 * return type — the same trick `annotationsIn` turns, and for the same reason.
 */
export function placedIn<T extends Mark>(marks: readonly T[]): readonly Placed<T>[] {
  return marks.every(isPlaced) ? marks : marks.filter(isPlaced)
}

/** The annotations with no anchor here — Marginalia's, and the resolver's. */
export function unplacedIn(marks: readonly Annotation[]): readonly Annotation[] {
  return marks.every((mark) => !isPlaced(mark)) ? marks : marks.filter((mark) => !isPlaced(mark))
}

/**
 * The records that are ABOUT A PASSAGE — a highlight of the reader's, or a
 * claim of the companion's.
 *
 * This is what gets painted into the text, listed in Notes, counted for the
 * margin and resolved against a selection. A bookmark is none of those things,
 * and this is the filter that means no consumer of any of them has to know
 * bookmarks exist.
 *
 * Returns its input by identity when there is nothing to drop, the convention
 * every store's change-detection relies on.
 */
export function annotationsIn(marks: readonly Mark[]): readonly Annotation[] {
  /* `every` with a type predicate narrows the ARRAY, which is what lets the
   * no-write convention survive the stronger return type: a list that is
   * already all annotations is handed back by identity, not copied to satisfy
   * the compiler. */
  return marks.every(isAnnotation) ? marks : marks.filter(isAnnotation)
}

/**
 * The records that are A PLACE — in book order, which is the order a reader
 * expects to find their own bookmarks in.
 *
 * SORTED HERE, unlike `annotationsIn`, because there is nowhere else it could
 * happen: the Marginalia list sorts its own rows after filtering across books, and
 * the bookmark list has no such step to hang a sort on. `compareMarks` is the
 * same ordering, section first and then CFI — see its note on why the two
 * cannot be compared the other way round.
 */
export function bookmarksIn(marks: readonly Mark[]): Bookmark[] {
  return marks.filter(isBookmark).sort(compareMarks)
}

/**
 * When a mark was last ACTED ON — edit or deletion, whichever is later — and,
 * for a mark from before the ledger, the moment it was made. This is the
 * stamp `mergeMarks` compares and a marks digest is computed over.
 */
export function markStamp(mark: Mark): Hlc {
  return laterHlc(mark.updatedAt, mark.deletedAt) ?? hlcOf(mark.createdAt)
}

/**
 * Which of two rows carrying ONE id stands — the rule `mergeMarks` states
 * below, in one function because two callers apply it. `dedupeById` is the
 * other, and it kept the first row it met instead: a second merge rule over
 * the same data.
 */
function laterMark(held: Mark, incoming: Mark): Mark {
  const mine = markStamp(held)
  const theirs = markStamp(incoming)
  if (mine < theirs) return incoming
  if (mine > theirs) return held
  return JSON.stringify(held) < JSON.stringify(incoming) ? incoming : held
}

/**
 * Fold two lists of one book's marks — LATEST ACTION WINS, per id.
 *
 * The row with the newer `markStamp` is taken WHOLE: a tombstone newer than
 * an edit deletes the mark, and an edit newer than a tombstone brings it back
 * — both are the same rule, and stating it as one rule is what makes the
 * merge a semilattice. Ties (two legacy rows stamped from one `createdAt`
 * that then diverged) fall to the serialised row, which is arbitrary but the
 * SAME arbitrary everywhere, so replicas converge instead of flapping.
 *
 * Commutative, associative and idempotent UP TO ORDER: the result keeps `a`'s
 * order and appends `b`'s new ids, so two argument orders give one set. Both
 * stores sort for display and the digest sorts by id, so order is not state.
 *
 * Returns `a` by identity when nothing in `b` changed anything — the no-write
 * convention.
 */
export function mergeMarks(a: readonly Mark[], b: readonly Mark[]): readonly Mark[] {
  const byId = new Map(a.map((mark) => [mark.id, mark] as const))
  let changed = false
  for (const incoming of b) {
    const held = byId.get(incoming.id)
    if (!held) {
      byId.set(incoming.id, incoming)
      changed = true
      continue
    }
    const winner = laterMark(held, incoming)
    /* A winner that is not `held` differs from it: `laterMark` keeps `held`
       at a tie of stamp and serialization. */
    if (winner !== held) {
      byId.set(incoming.id, winner)
      changed = true
    }
  }
  return changed ? [...byId.values()] : a
}

/**
 * The marks that earn a place in the margin column.
 *
 * A bare highlight does not: it is already visible as a fill on the words
 * themselves, and repeating it in the margin would fill the column with dots
 * that say nothing the text does not. What goes there is what cannot be read
 * off the page — a written note, and the companion's own marks.
 *
 * This is also what `markCount` counts, so the column is reserved exactly when
 * there is something to put in it. Counting every highlight instead would open
 * a 250px column to display nothing.
 */
export function marginMarks(marks: readonly Annotation[]): Annotation[] {
  return marks.filter((mark) => mark.note !== '' || mark.kind === 'companion')
}

/**
 * Add a mark, replacing any existing LIVE mark on the same book at the same
 * anchor.
 *
 * Re-highlighting an already-highlighted passage should not stack two marks at
 * one anchor: foliate would draw both, and the Marginalia list would show the
 * passage twice. Replacing keeps the newer note and colour.
 *
 * The replaced row is TOMBSTONED, not dropped — a replace is a removal of the
 * old mark wearing a new one, and a removal that leaves no row cannot travel:
 * a replica still holding the old mark would read its absence as "not seen
 * yet" and put it back. `at` stamps the tombstone; the default is the same
 * legacy clock every unstamped write gets.
 *
 * AND ONLY WITHIN A CLASS — see `sameClass`. A bookmark shares an anchor with
 * whatever the reader had highlighted on that page as a matter of course, and
 * without this the two take turns deleting each other.
 *
 * ⚠️ **AND ONLY BETWEEN PLACED MARKS — see `isPlaced`.** `cfi` is the anchor,
 * and `''` is the ABSENCE of one, not a location two marks can share. Reading
 * the empty string as an anchor made every unplaced mark supersede the last:
 * a name-matched import of N annotations kept exactly ONE, each row tombstoning
 * its predecessor inside the same `addMany` batch, with the survivor decided by
 * whatever order `planImport` happened to emit. MEASURED against a real import
 * — three marks in, one highlight and one bookmark left, and the only one
 * carrying the reader's note was the one destroyed. The notice said "3 marks
 * kept without a place" while it happened.
 *
 * `cfiOverlaps` already answers false for an empty CFI, so `upsertOverlapping`
 * found nothing to supersede and this rule underneath it did the damage anyway.
 * The two agree now.
 */
export function upsertMark(marks: readonly Mark[], mark: Mark, at: Hlc = hlcOf(Date.now())): Mark[] {
  const kept = marks
    /* THE SAME ID IS THE SAME RECORD, so the incoming row REPLACES it rather
     * than superseding it. Without this, re-adding a mark under an id already
     * present tombstoned the held row and appended the new one beside it —
     * leaving two rows sharing an id, which `dedupeById` then resolves on the
     * next load by keeping the FIRST. The first is the tombstone, so the mark
     * vanishes: a write that looked like an update, read back as a deletion.
     *
     * Not reachable from the app, where `createMark` mints a fresh uuid every
     * time and remote rows arrive through `mergeMarks` instead. `MarkStore.add`
     * takes a caller's mark, though, and a store that loses a record when
     * handed one it already holds is not a contract worth documenting around. */
    .filter((existing) => existing.id !== mark.id)
    .map((existing) =>
      existing.bookId === mark.bookId &&
      /* BOTH SIDES, not just the incoming one: "same anchor" is a claim about
       * a pair, and an unplaced row on either side means there is no anchor to
       * be the same. */
      isPlaced(existing) &&
      isPlaced(mark) &&
      existing.cfi === mark.cfi &&
      existing.deletedAt === undefined &&
      sameClass(existing, mark)
        ? { ...existing, deletedAt: at }
        : existing,
    )
  return [...kept, mark]
}

/*
 * BOTH RETURN THEIR INPUT BY IDENTITY WHEN NOTHING CHANGED. Every store applies
 * a change and asks "is this the same list?" to decide whether to publish and
 * whether to write; a `filter` that removed nothing and a `map` that changed
 * nothing still returned new arrays, so removing an id that was not there or
 * re-saving a note as it already was published a change nobody could see and
 * wrote the file over itself.
 */

/**
 * Remove a mark — which SETS ITS TOMBSTONE and keeps the row, so the
 * deletion can travel (see `Mark.deletedAt`). A mark already deleted, or not
 * there at all, is the input by identity. `at` is the deletion's stamp; the
 * default is the legacy clock, monotone only as far as the wall clock is,
 * which is enough with no sync composed.
 */
export function removeMark(marks: readonly Mark[], id: string, at: Hlc = hlcOf(Date.now())): readonly Mark[] {
  return marks.some((mark) => mark.id === id && mark.deletedAt === undefined)
    ? marks.map((mark) => (mark.id === id && mark.deletedAt === undefined ? { ...mark, deletedAt: at } : mark))
    : marks
}

/**
 * Write a note onto a LIVE mark, stamping the edit. A tombstoned row is left
 * alone: nothing on screen can reach one, and resurrection is the merge's
 * decision (`mergeMarks`), never a note edit's side effect.
 */
export function updateNote(
  marks: readonly Mark[],
  id: string,
  note: string,
  at: Hlc = hlcOf(Date.now()),
): readonly Mark[] {
  /* CUT HERE, AT THE WRITE. `validMarks` cuts a note to `MAX_MARK_NOTE` on
     every read, so a longer one written whole would be kept whole on disk
     and lose its tail the next time the file was read — a silent loss the
     editor never showed. The cut the reader sees is the cut the file keeps. */
  const kept = cutAt(note, MAX_MARK_NOTE)
  return marks.some((mark) => mark.id === id && mark.deletedAt === undefined && mark.note !== kept)
    ? marks.map((mark) =>
        mark.id === id && mark.deletedAt === undefined ? { ...mark, note: kept, updatedAt: at } : mark,
      )
    : marks
}

/**
 * Recolour a LIVE mark, stamping the edit.
 *
 * The twin of `updateNote`, and every rule it states holds here for the same
 * reasons: a tombstoned row is left alone (resurrection is the merge's
 * decision, never an edit's side effect), a change to the colour it already
 * has returns the input BY IDENTITY so nothing is written, and the stamp is
 * what makes the edit merge as newer on a peer.
 *
 * The colour IS part of the annotation — a reader who puts agreements in
 * green and questions in purple has said something about each passage — which
 * is why this exists as its own mutator rather than the tint being read from
 * whatever the toggle holds at draw time.
 */
export function setTint(
  marks: readonly Mark[],
  id: string,
  tint: MarkTint,
  at: Hlc = hlcOf(Date.now()),
): readonly Mark[] {
  return marks.some((mark) => mark.id === id && mark.deletedAt === undefined && mark.tint !== tint)
    ? marks.map((mark) => (mark.id === id && mark.deletedAt === undefined ? { ...mark, tint, updatedAt: at } : mark))
    : marks
}

/**
 * Give an UNPLACED mark the anchor a re-anchoring pass found for it — WI-22.A2.
 *
 * ⚠️ **THE WRITE THAT MAKES `unplaced` STOP BEING PERMANENT.** WI-21.7 built
 * the class so an import could keep a mark it had nowhere to draw, and
 * Marginalia says so in as many words: *"Paper has not found this passage here
 * yet."* This is the mutation that retires that sentence for one mark.
 *
 * It is a STORE WRITE and not a render-time decoration, which the plan states
 * as the item's first constraint. A mark resolved only in memory is resolved
 * again on every open and is invisible to export, to sync and to the browser
 * client — the exact class phase 21 spent three rounds removing.
 *
 * ## What it refuses, and why each refusal is not paranoia
 *
 *  - **A tombstoned row.** Resurrection is the merge's decision (`mergeMarks`),
 *    never an edit's side effect — `updateNote` and `setTint` both say this and
 *    it holds harder here, because a pass runs over every unplaced mark of a
 *    book without a reader having asked for anything.
 *  - **A mark that is already placed.** Nothing to do, and overwriting a good
 *    anchor with a re-derived one is how a mark moves off the words it was made
 *    on. `keyFor` refuses to cache one for the same reason.
 *  - **An empty `cfi`.** The one state `readStoredMark` refuses outright, and the
 *    resolver never produces it — so reaching this is a caller bug, and writing
 *    it would produce a mark that is neither placed nor legally unplaced.
 *  - **A negative `sectionIndex`.** `readStoredMark` refuses one, and `UnplacedMark`'s
 *    note says why: safety that depends on an out-of-range number is the shape
 *    that field exists to replace.
 *
 * ## What it deliberately does NOT do
 *
 * It does not tombstone a mark it now overlaps. `add` does, because there the
 * reader's own gesture said *"this passage"* and the row underneath is the one
 * that gesture resolved to. Here nobody gestured: a passage the reader marked
 * in this build and an imported mark of the same passage are two records that
 * happen to have met, and superseding either would delete a note the reader
 * wrote. Two highlights on one passage is visible and recoverable; a silently
 * deleted note is not.
 *
 * `unplaced` is REMOVED rather than set to undefined — `exactOptionalPropertyTypes`
 * is on, and a present-but-undefined key is a different value to `readStoredMark`,
 * to the JSON on disk and to the merge.
 */
export function placeMark(
  marks: readonly Mark[],
  id: string,
  /* `ResolvedCfi`, not `string` — WI-22.A1 applied to the one write that can
   * turn an unplaced mark into a placed one. Taking a bare string meant any
   * fabricated or foreign path could be persisted, have `unplaced` removed, and
   * later come back out of `current` wearing the brand: the resolver-only
   * invariant, bypassed by the single function whose whole job is to install an
   * anchor. `reanchorPass` produces one from a live Range; nothing else can. */
  cfi: ResolvedCfi,
  sectionIndex: number,
  at: Hlc = hlcOf(Date.now()),
): readonly Mark[] {
  if (cfi === '' || !Number.isInteger(sectionIndex) || sectionIndex < 0) return marks
  /* REFUSED, NOT INSTALLED: an anchor past the record's bound is one the
     read would refuse — the mark would be placed on screen and gone from
     the list at the next load. The write door is where a refusal is heard. */
  if (cfi.length > MAX_RECORD_POSITION) throw new Error(`a mark’s anchor may be at most ${MAX_RECORD_POSITION} characters`)
  const target = marks.find(
    (mark) => mark.id === id && mark.deletedAt === undefined && mark.unplaced !== undefined,
  )
  if (!target) return marks
  return marks.map((mark) => {
    if (mark !== target) return mark
    const { unplaced: _dropped, ...rest } = mark
    return { ...rest, cfi, sectionIndex, updatedAt: at }
  })
}

/** Identity. `randomUUID` needs a secure context, which a file:// build is not. */
export function newMarkId(): string {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return globalThis.crypto.randomUUID()
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * GENERIC over the draft, so the kind survives.
 *
 * A plain `(draft: NewMark) => Mark` widened every created record back to the
 * full union, which put the one place a highlight is made — `useMarking` —
 * one step away from the painter with a value the painter's own type now
 * refuses. Carrying the draft's type through costs nothing at runtime and
 * means `createMark({ kind: 'highlight', … })` IS an `Annotation` to the
 * compiler, with no cast anywhere to say so.
 */
export function createMark<T extends NewMark>(draft: T): Mark & Pick<T, 'kind'> {
  return { ...draft, id: newMarkId(), createdAt: Date.now() }
}

/**
 * The bounds a MARK's own fields carry, and the reason they exist at all.
 *
 * A mark is persisted and then read back — by `mark.list`, by the sync feed,
 * by every peer that pulls the book. Neither the marked text nor the note had
 * any bound, so a single request near the envelope's 4 MiB payload limit was
 * accepted, COMMITTED, and only then produced a response too large to send:
 * the caller saw an error over a mutation that had already happened, and
 * every later list of that book's marks failed the same way. A bound that
 * refuses before the write is the difference.
 *
 * Generous on purpose. A highlight is a passage, not a word — a dense page is
 * around three thousand characters — and a note is a reader's own writing,
 * which nothing should cut short at a paragraph. These are far past where
 * anyone writing in earnest will meet them, and far below the wire limit even
 * when a book carries hundreds of marks.
 */
export const MAX_MARK_TEXT = 8_000
export const MAX_MARK_NOTE = 8_000

/**
 * How much of the page a bookmark remembers.
 *
 * A highlight's `text` is what the reader selected, which is as long as they
 * meant it to be. A bookmark's is whatever was visible when they pressed the
 * key — a whole page — and storing that would put a screenful of prose into
 * `marks.json` for every bookmark, and onto the wire for every sync. What the
 * list needs is enough to recognise the place by, which is the opening line.
 */
export const BOOKMARK_TEXT_MAX = 140

/**
 * The opening line of a bookmarked page, as it is worth storing.
 *
 * COLLAPSED BEFORE IT IS CUT, and that order is the whole function. The text
 * comes off a rendered page, so it arrives carrying the newlines and the
 * indentation of the markup it was walked out of — a real capture began
 * `'y\n + ing \u279a\n simplify\n ing\n'`, in which a quarter of the budget
 * was whitespace. Cutting first spends the allowance on layout and leaves the
 * row saying less than it could.
 *
 * BY CODE POINT, not by `slice`. A string index is a UTF-16 unit, so cutting
 * at 140 can land between the halves of a surrogate pair and store a lone
 * surrogate — a character that is not a character, in a field that is written
 * to disk, sent over the wire and rendered. An emoji or a rarer CJK glyph at
 * the boundary is all it takes; spreading the string iterates whole code
 * points, so the cut can only fall between them.
 */
export function openingLine(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  /* BY GRAPHEME where the platform has a segmenter, by code point where it does
   * not. Code points fixed the lone-surrogate half of this — an emoji no longer
   * loses one of its two units — and they do not fix the rest of it: a flag is
   * two regional indicators, a family emoji is several joined by ZWJ, and an
   * accented letter can be a base plus a combining mark. Cutting between any of
   * those leaves a character the reader never wrote. `Intl.Segmenter` is in
   * every engine this ships on; the spread stays as the floor rather than as a
   * second answer, because it is strictly better than a `slice`. */
  const units =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(flat)].map(
          (part) => part.segment,
        )
      : [...flat]
  return units.slice(0, BOOKMARK_TEXT_MAX).join('')
}

/** Where a bookmark goes, and what was on the page there. */
export interface BookmarkDraft {
  readonly bookId: string
  readonly cfi: string
  readonly sectionIndex: number
  /** The opening words of the bookmarked page — truncated, see above. */
  readonly text: string
  readonly prefix: string
  readonly suffix: string
  readonly chapter: string
}

/**
 * A bookmark, as the fields a mark record needs.
 *
 * THE ONE PLACE A BOOKMARK IS BUILT, so the three fields that mean nothing on
 * one cannot be filled in differently by two callers.
 *
 * `note` is empty and stays empty: a bookmark is a place, not something
 * written, and a bookmark carrying a note would appear in the margin —
 * `marginMarks` keeps every row with one. That the split at the store's door
 * already stops it from getting there is not a reason to write a value whose
 * only correct handling is to be ignored.
 *
 * `tint` and `style` are exactly what a row WITHOUT them reads back as — see
 * `readTint` and `readStyle`. Nothing paints a bookmark, so the honest value
 * is the one that says nothing, and this is how that is spelled in a type that
 * requires both.
 */
export function bookmarkFrom(draft: BookmarkDraft): NewMark {
  return {
    ...draft,
    text: openingLine(draft.text),
    note: '',
    kind: 'bookmark',
    tint: 'yellow',
    style: 'fill',
  }
}

/**
 * Validate AND project one stored record, in one pass — or null.
 *
 * Storage is a trust boundary: the value is whatever is in localStorage, which
 * includes records written by an older build of this app and anything a user
 * pasted into devtools. A malformed row is refused rather than thrown on —
 * losing one mark from the SCREEN is recoverable, refusing to start the reader
 * is not. What is refused is not lost: `readStoredMarks` hands the row back
 * beside the marks, and the store keeps it where it was (see `applyElsewhere`).
 *
 * ⚠️ **PARSED ONCE.** The gate and the projection were two functions over one
 * row, and `unplaced` was read by each — validated to decide whether an empty
 * cfi was legal, then validated again to write the checked value — three
 * parses of one field per row on a long list. One read decides both.
 *
 * The right TYPE is not the same as a usable value, and every one of these
 * gets through a type check while breaking something specific:
 *
 *   empty id       React keys collide, and `remove(id)` deletes both marks
 *   empty cfi      nothing to resolve, so the mark can never be drawn — it
 *                  sits in the Marginalia list forever pointing at nothing
 *   bad index      a fractional or negative sectionIndex matches no section,
 *                  so `drawSection` never offers the mark to an overlay
 *   bad createdAt  NaN/Infinity sorts unpredictably, scrambling the order of
 *                  every OTHER mark on the same anchor — and a NEGATIVE one
 *                  is finite, so it passes that check while still sorting
 *                  before every real mark, which is the same bug wearing a
 *                  plausible number. These are epoch milliseconds; there is
 *                  no such thing as one from before 1970 here.
 *
 * BOUNDED LIKE THE RECORD'S OWN FIELDS: an id, a book and a position that a
 * peer or a stale store hands over are held to the limits `bookFolder.ts`
 * holds a record to, so a row cannot outgrow the wire that carries it. The
 * identity fields are refusals, not cuts — an id or an anchor cut short is a
 * different mark — and `checkMarkIdentity` refuses the same bounds at every
 * write door, so a row past them is one an older build or a hand wrote.
 */
function readStoredMark(value: unknown): Mark | null {
  if (typeof value !== 'object' || value === null) return null
  const m = value as Record<string, unknown>
  const { id, bookId, cfi, sectionIndex, text, note, kind, chapter, createdAt, updatedAt, deletedAt } = m
  if (typeof id !== 'string' || id === '' || id.length > MAX_RECORD_FIELD) return null
  if (typeof bookId !== 'string' || bookId === '' || bookId.length > MAX_RECORD_FIELD) return null
  if (typeof cfi !== 'string' || cfi.length > MAX_RECORD_POSITION) return null
  /* ⚠️ EMPTY ONLY WITH AN EXPLICIT `unplaced` BESIDE IT (WI-21.7). The
     original refusal is unchanged in spirit — an anchorless mark nobody
     meant still corrupts the list — and what is admitted is the mark that
     SAYS it has no anchor here and why. A row with an empty cfi and no
     reason is still refused. The one read of the field: what decided the
     gate is what is written. */
  const unplaced = readUnplaced(m['unplaced'])
  if (cfi === '' && unplaced === undefined) return null
  if (typeof sectionIndex !== 'number' || !Number.isSafeInteger(sectionIndex) || sectionIndex < 0) return null
  if (typeof text !== 'string' || typeof note !== 'string') return null
  /* AGAINST THE REGISTRY, not against a pair written out here. The two were
   * spelled inline for as long as there were two, and a third kind then has
   * to be added in a place a reader of `MarkKind` has no reason to look —
   * with the failure being that every bookmark on disk is refused on load,
   * silently, because `validMarks` filters rather than throws. */
  if (!MARK_KINDS.includes(kind as MarkKind)) return null
  /* CUT, NOT REFUSED — a chapter label is display only, and a row is never
     refused over one: a long label was saved by the reader (nothing bounded
     it at the write) and displayed, and then the whole mark vanished on the
     next read. */
  if (typeof chapter !== 'string') return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) return null
  /* The stamps, kept only when they ARE stamps — a malformed one is
   * dropped alone, and the mark stands as a legacy row (`markStamp`
   * falls back to `createdAt`). Refusing the whole mark over a bad
   * stamp would let one hand-edit delete a highlight. */
  const updated = isHlc(updatedAt) ? updatedAt : undefined
  const deleted = isHlc(deletedAt) ? deletedAt : undefined
  /* LATEST ACTION WINS ON THE ROW ITSELF. A row carrying an edit NEWER
   * than its tombstone is a row the merge rule says is alive — but every
   * read model decides liveness by the tombstone's mere presence, so the
   * two disagreed. Canonicalised here, at the one door rows come through:
   * the older action is cleared, and field presence IS the merge's
   * answer. A tombstone at or above the edit stays — deleted. */
  const tombstone = deleted !== undefined && !(updated !== undefined && updated > deleted) ? deleted : undefined
  const which = kind as MarkKind
  /* WRITTEN FIELD BY FIELD, NOT SPREAD. `...rest` carried every key the
   * file held — a raw `unplaced` that `readUnplaced` had just refused,
   * and any key the shape does not know — into memory, the digest and
   * the wire. What leaves this door is the checked value of each field
   * the type names, and nothing else. */
  return {
    id,
    bookId,
    cfi: cfi as Mark['cfi'],
    sectionIndex,
    kind: which,
    chapter: cutAt(chapter, MAX_RECORD_FIELD),
    createdAt,
    /* THE SAME BOUNDS THE SERVICE TABLE REFUSES AT, applied at the one
     * door stored rows come through. The table refuses an oversized mark
     * on the way in; a peer's `mergeRemote` and a hand-edited file do not
     * pass the table, and a row past the bound made every later answer
     * that carried it too large for the transport. Cut, not dropped: a
     * highlight with an over-long quote is still the reader's highlight. */
    text: cutAt(text, MAX_MARK_TEXT),
    // Absent for every mark made before context was stored, which is most of
    // them. Empty is the honest reading: there is nothing extra to re-anchor
    // with — NOT a reason to drop a mark the reader made.
    prefix: readContext(m['prefix']),
    suffix: readContext(m['suffix']),
    tint: readTint(m['tint']),
    note: noteForKind(cutAt(note, MAX_MARK_NOTE), which),
    style: styleForKind(readStyle(m['style']), which),
    /* Absent for every placed mark, which is all of them until an archive brings one across. */
    ...(unplaced === undefined ? {} : { unplaced }),
    ...(updated !== undefined ? { updatedAt: updated } : {}),
    ...(tombstone !== undefined ? { deletedAt: tombstone } : {}),
  }
}

/**
 * Refuse a mark whose IDENTITY is past the record's bounds — at a write door.
 *
 * `boundedMark` cuts what can be cut; an id, a book id or an anchor cannot
 * be, because cut short each names a different mark. Refused at the write,
 * where a refusal is a failure the reader is shown; refused only on the read,
 * as it was, a mark was saved, displayed, and quietly gone on the next load.
 */
export function checkMarkIdentity(mark: Pick<Mark, 'id' | 'bookId' | 'cfi'>): void {
  if (mark.id.length > MAX_RECORD_FIELD) throw new Error(`a mark id may be at most ${MAX_RECORD_FIELD} characters`)
  if (mark.bookId.length > MAX_RECORD_FIELD) throw new Error(`a mark’s book id may be at most ${MAX_RECORD_FIELD} characters`)
  if (mark.cfi.length > MAX_RECORD_POSITION) throw new Error(`a mark’s anchor may be at most ${MAX_RECORD_POSITION} characters`)
}

/**
 * Context is optional on the way in, and always a string on the way out —
 * CUT TO THE SAME BOUND `text` is cut to.
 *
 * The bound was applied to `text` and `note` here and to `prefix`/`suffix` in
 * `marksArchive`, and this door had neither: a hand-edited file or a peer's
 * `mergeRemote` could put a whole chapter in `prefix`, and every later answer
 * carrying that mark was then too large for the transport — the exact failure
 * the cut on `text` exists to prevent, wearing the field beside it. The service
 * table refuses both at `MAX_MARK_TEXT` on the way in (`book.mark.add`), so
 * that is the bound, and it is the same one on every door.
 */
/**
 * The `unplaced` record a stored row carries, or undefined.
 *
 * VALIDATED, not cast. This is the only thing standing between "an empty cfi
 * that was meant" and "an empty cfi that is corruption", so a row claiming
 * `unplaced: true`, or `unplaced: {}`, or a reason nothing understands, is not
 * an unplaced mark and its empty cfi is refused as it always was.
 */
function readUnplaced(value: unknown): UnplacedMark | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (row['reason'] !== 'foreign-build') return undefined
  const fromBook = row['fromBook']
  if (typeof fromBook !== 'string' || fromBook === '') return undefined
  return { reason: 'foreign-build', fromBook: cutAt(fromBook, 200) }
}

/**
 * The first `max` UTF-16 units of a string, never ending on a lone high
 * surrogate: a pair split in two is a character the reader never wrote, and
 * one that no longer round-trips through the wire's canonical JSON. The bound
 * stays in UTF-16 units — the service table's — so what is cut here is what
 * the table would have refused.
 */
function cutAt(value: string, max: number): string {
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd8_00 && last <= 0xdb_ff ? cut.slice(0, -1) : cut
}

/**
 * A mark cut to the bounds `validMarks` applies on the read — for the WRITE
 * door, so the two agree. Every cut field: a label, a quote, its context and
 * a note written past the bound were kept whole on disk and shortened on the
 * next read, so the reader saw one mark and reloaded another. The identity
 * fields are not cut here either: an id or an anchor cut short is a different
 * mark, and the read refuses those rather than shortening them.
 *
 * The same object when nothing is over the bound, so a caller comparing by
 * identity sees no change.
 */
export function boundedMark<M extends Mark>(mark: M): M {
  const chapter = cutAt(mark.chapter, MAX_RECORD_FIELD)
  const text = cutAt(mark.text, MAX_MARK_TEXT)
  const prefix = cutAt(mark.prefix, MAX_MARK_TEXT)
  const suffix = cutAt(mark.suffix, MAX_MARK_TEXT)
  const note = cutAt(mark.note, MAX_MARK_NOTE)
  if (chapter === mark.chapter && text === mark.text && prefix === mark.prefix && suffix === mark.suffix && note === mark.note) {
    return mark
  }
  return { ...mark, chapter, text, prefix, suffix, note }
}

function readContext(value: unknown): string {
  return typeof value === 'string' ? cutAt(value, MAX_MARK_TEXT) : ''
}

/**
 * The tint a stored row carries, or yellow.
 *
 * DELIBERATELY NOT PART OF `readStoredMark`, and this is the entire compatibility
 * story: every mark written before this field existed lacks it, so requiring it
 * would drop the reader's whole history on the first launch after the upgrade —
 * silently, because `validMarks` filters rather than throws. The same reasoning
 * as `prefix` and `suffix`, and the same shape, so the next optional field has
 * a pattern to follow rather than a precedent to guess at.
 */
function readTint(value: unknown): MarkTint {
  return MARK_TINTS.includes(value as MarkTint) ? (value as MarkTint) : 'yellow'
}

/**
 * The style a stored row carries, or a fill.
 *
 * FILL, even though a mark made in Night was DRAWN as a rule before this
 * existed. That was §05 substituting for a choice the reader could not make,
 * not a choice they made — reading it back as `underline` would freeze one
 * theme's drawing rule into a permanent property of the mark, and it would do
 * so for marks made on every other theme too, since nothing recorded which
 * theme was on at the time.
 */
function readStyle(value: unknown): MarkStyle {
  return MARK_STYLES.includes(value as MarkStyle) ? (value as MarkStyle) : 'fill'
}

/**
 * The style a mark of this KIND may actually wear.
 *
 * Enforced on the way IN as well as on the way out, because a guarantee the
 * store does not keep is decoration. The reader can no longer choose a wave —
 * `READER_STYLES` does not offer one — but marks made before that was true are
 * on disk, and a reader's mark drawn as a wave says "a machine wrote this"
 * about a passage the reader marked themselves. It is read back as the nearest
 * thing the reader could have meant, which is the plain rule under it.
 *
 * The other direction is left alone: a companion mark carries whatever it
 * carries, because the painter ignores it entirely and draws amber regardless.
 */
/**
 * The note a mark of this KIND may actually carry — empty, for a bookmark.
 *
 * The same door and the same reasoning as `styleForKind`: a guarantee the store
 * does not keep is decoration. `bookmarkFrom` writes an empty note and says
 * why, but that only governs bookmarks THIS build makes. A row hand-edited on
 * disk, or arriving from a peer, is whatever it is — and Marginalia's Notes
 * filter is `note !== ''`, so a bookmark carrying one is listed and counted as
 * a piece of writing. It is read back as what a bookmark can be.
 */
function noteForKind(note: string, kind: MarkKind): string {
  return kind === 'bookmark' ? '' : note
}

function styleForKind(style: MarkStyle, kind: MarkKind): MarkStyle {
  if (kind === 'companion') return style
  return READER_STYLES.includes(style) ? style : 'underline'
}

/** Parse a stored payload, keeping only the rows that survive validation. */
export function parseMarks(raw: string | null): Mark[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return validMarks(parsed)
}

/**
 * The same validation, for a value that has already been parsed.
 *
 * `readMarks` returns `unknown[]` off a book's folder, and every caller was
 * re-serialising it just to hand it back to `parseMarks` — `parseMarks(JSON
 * .stringify(raw))`, four times. A round trip through a string to reach a
 * function whose first act is to undo it, on every mark of every book the Notes
 * pane lists.
 */
export function validMarks(parsed: unknown): Mark[] {
  return readStoredMarks(parsed).marks
}

/**
 * The rows that read, and the rows that did not — VERBATIM, for the store to
 * keep where they were.
 *
 * ⚠️ **A ROW THIS BUILD CANNOT READ IS NOT THE STORE'S TO DESTROY.** Every
 * write rewrites the file whole from the marks that read, so a row refused on
 * the read — an id past the bound an older build never enforced, a stamp
 * hand-edited into nonsense — was gone from disk at the next highlight, with
 * nothing anywhere saying so. Refused rows come back beside the marks; the
 * store writes them back untouched and says how many it is keeping aside.
 */
export function readStoredMarks(parsed: unknown): { readonly marks: Mark[]; readonly refused: readonly unknown[] } {
  if (!Array.isArray(parsed)) return { marks: [], refused: [] }
  const marks: Mark[] = []
  const refused: unknown[] = []
  for (const row of parsed) {
    const mark = readStoredMark(row)
    if (mark === null) refused.push(row)
    else marks.push(mark)
  }
  return { marks: dedupeById(marks), refused }
}

/**
 * One row per id, reconciled by `mergeMarks`'s rule.
 *
 * Everything downstream addresses a mark BY ID and assumes that is unique:
 * `remove` drops every row matching an id and `setNote` rewrites every one of
 * them. Nothing enforced it. A store carrying duplicate ids — a legacy write, a
 * hand-edited value, a merge across two devices — therefore turned one delete
 * into several, across books, silently. Enforced here because this is the only
 * door stored data comes through, so a single check makes the assumption true
 * for every caller rather than asking each of them to defend itself.
 *
 * ⚠️ **THE FIRST ROW USED TO WIN**, on the reasoning that it is the oldest and
 * a later duplicate is the likelier corruption. That is a SECOND merge rule
 * over the same data, and it disagrees with the one every other reader of a
 * duplicate id applies: a legacy pair whose tombstone happens to be serialised
 * first kept the tombstone and threw away the replacement written after it —
 * a mark the reader could see, gone at the next load, with the row that
 * replaced it discarded by the deduplicator. Latest action wins here too, and
 * ties fall the same way, so a device that folds a pair and one that merges it
 * reach the same list.
 *
 * The POSITION is the first row's. Order is not state — both stores sort for
 * display and the digest sorts by id — so keeping it costs nothing and keeps
 * a list that had no duplicates identical to its input.
 */
function dedupeById(marks: readonly Mark[]): Mark[] {
  const at = new Map<string, number>()
  const kept: Mark[] = []
  for (const mark of marks) {
    const where = at.get(mark.id)
    if (where === undefined) {
      at.set(mark.id, kept.length)
      kept.push(mark)
      continue
    }
    kept[where] = laterMark(kept[where]!, mark)
  }
  return kept
}

/**
 * The storage surface this module needs, which is the part of the Storage
 * interface it actually calls. Narrow on purpose: it is what lets the tests
 * pass a plain object instead of standing up a localStorage double.
 */
export interface MarkStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}
