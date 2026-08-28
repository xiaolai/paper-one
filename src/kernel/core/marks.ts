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
import { hlcOf, isHlc, laterHlc, type Hlc } from './hlc'

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
   * of them — so neither is required by `isMark`. See `readTint`.
   */
  readonly tint: MarkTint
  readonly style: MarkStyle
  /** TOC label at the time of marking, for "Ch. 1" in the Marginalia list. */
  readonly chapter: string
  readonly createdAt: number
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

export const MARKS_STORAGE_KEY = 'paper.marks.v1'

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
const SAMPLE_BYTES = 64 * 1024

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
const FULL_HASH_LIMIT = 64 * 1024 * 1024

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
const INTERIOR_PROBES = 16

/**
 * The parts of a blob that identity is computed over.
 *
 * Exported for the tests, which assert the SHAPE of the sampling rather than
 * allocating a file large enough to trigger it — reading `size` and `slice` is
 * all this does, so a stand-in with those two members exercises it honestly.
 */
export function identityParts(blob: Blob): BlobPart[] {
  // The size leads, so two files cannot agree by sampling alone.
  const parts: BlobPart[] = [`${blob.size}:`]
  if (blob.size <= FULL_HASH_LIMIT) {
    parts.push(blob)
    return parts
  }
  parts.push(blob.slice(0, SAMPLE_BYTES))
  for (let i = 1; i <= INTERIOR_PROBES; i++) {
    const at = Math.floor((blob.size * i) / (INTERIOR_PROBES + 1))
    parts.push(blob.slice(at, at + SAMPLE_BYTES))
  }
  parts.push(blob.slice(Math.max(0, blob.size - SAMPLE_BYTES)))
  return parts
}

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
 * non-string throws, and `isMark` already refuses to load one of those.
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
    if (winner !== held && JSON.stringify(winner) !== JSON.stringify(held)) {
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
  return marks.some((mark) => mark.id === id && mark.deletedAt === undefined && mark.note !== note)
    ? marks.map((mark) =>
        mark.id === id && mark.deletedAt === undefined ? { ...mark, note, updatedAt: at } : mark,
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
 * Validate one stored record.
 *
 * Storage is a trust boundary: the value is whatever is in localStorage, which
 * includes records written by an older build of this app and anything a user
 * pasted into devtools. A malformed row is dropped rather than thrown on —
 * losing one mark is recoverable, refusing to start the reader is not.
 */
type StoredMark = Omit<Mark, 'prefix' | 'suffix' | 'updatedAt' | 'deletedAt' | 'tint' | 'style'> & {
  readonly prefix?: unknown
  readonly suffix?: unknown
  readonly updatedAt?: unknown
  readonly deletedAt?: unknown
  readonly tint?: unknown
  readonly style?: unknown
}

function isMark(value: unknown): value is StoredMark {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  /* The right TYPE is not the same as a usable value, and every one of these
   * three gets through a type check while breaking something specific:
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
   * Dropping the row loses one mark. Keeping it corrupts a list. */
  return (
    typeof m['id'] === 'string' &&
    m['id'] !== '' &&
    typeof m['bookId'] === 'string' &&
    m['bookId'] !== '' &&
    typeof m['cfi'] === 'string' &&
    m['cfi'] !== '' &&
    typeof m['sectionIndex'] === 'number' &&
    Number.isInteger(m['sectionIndex']) &&
    m['sectionIndex'] >= 0 &&
    typeof m['text'] === 'string' &&
    typeof m['note'] === 'string' &&
    /* AGAINST THE REGISTRY, not against a pair written out here. The two were
     * spelled inline for as long as there were two, and a third kind then has
     * to be added in a place a reader of `MarkKind` has no reason to look —
     * with the failure being that every bookmark on disk is dropped on load,
     * silently, because `validMarks` filters rather than throws. */
    MARK_KINDS.includes(m['kind'] as MarkKind) &&
    typeof m['chapter'] === 'string' &&
    typeof m['createdAt'] === 'number' &&
    Number.isFinite(m['createdAt']) &&
    m['createdAt'] >= 0
  )
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
function readContext(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_MARK_TEXT) : ''
}

/**
 * The tint a stored row carries, or yellow.
 *
 * DELIBERATELY NOT PART OF `isMark`, and this is the entire compatibility
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
  if (!Array.isArray(parsed)) return []
  return dedupeById(
    parsed.filter(isMark).map((row) => {
      const { updatedAt, deletedAt, ...rest } = row
      /* The stamps, kept only when they ARE stamps — a malformed one is
       * dropped alone, and the mark stands as a legacy row (`markStamp`
       * falls back to `createdAt`). Dropping the whole mark over a bad
       * stamp would let one hand-edit delete a highlight. */
      const updated = isHlc(updatedAt) ? updatedAt : undefined
      const deleted = isHlc(deletedAt) ? deletedAt : undefined
      /* LATEST ACTION WINS ON THE ROW ITSELF. A row carrying an edit NEWER
       * than its tombstone is a row the merge rule says is alive — but every
       * read model decides liveness by the tombstone's mere presence, so the
       * two disagreed. Canonicalised here, at the one door rows come through:
       * the older action is cleared, and field presence IS the merge's
       * answer. A tombstone at or above the edit stays — deleted. */
      const tombstone =
        deleted !== undefined && !(updated !== undefined && updated > deleted) ? deleted : undefined
      return {
        ...rest,
        /* THE SAME BOUNDS THE SERVICE TABLE REFUSES AT, applied at the one
         * door stored rows come through. The table refuses an oversized mark
         * on the way in; a peer's `mergeRemote` and a hand-edited file do not
         * pass the table, and a row past the bound made every later answer
         * that carried it too large for the transport. Cut, not dropped: a
         * highlight with an over-long quote is still the reader's highlight. */
        text: rest.text.slice(0, MAX_MARK_TEXT),
        // Absent for every mark made before context was stored, which is most of
        // them. Empty is the honest reading: there is nothing extra to re-anchor
        // with — NOT a reason to drop a mark the reader made.
        prefix: readContext(row.prefix),
        suffix: readContext(row.suffix),
        tint: readTint(row.tint),
        note: noteForKind(rest.note.slice(0, MAX_MARK_NOTE), row.kind),
        style: styleForKind(readStyle(row.style), row.kind),
        ...(updated !== undefined ? { updatedAt: updated } : {}),
        ...(tombstone !== undefined ? { deletedAt: tombstone } : {}),
      }
    }),
  )
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

export function loadMarks(storage: MarkStorage): Mark[] {
  try {
    return parseMarks(storage.getItem(MARKS_STORAGE_KEY))
  } catch {
    // Safari throws on getItem when storage is disabled entirely.
    return []
  }
}

/**
 * Persist, reporting failure to the caller rather than throwing.
 *
 * Writing can fail for reasons the reader cannot fix — a full quota, private
 * browsing, storage switched off — and none of them should take the reader
 * down mid-highlight. The boolean exists so the caller can tell the user their
 * mark will not survive a reload, which is the honest thing to do and is
 * strictly better than a silent no-op.
 */
export function saveMarks(storage: MarkStorage, marks: readonly Mark[]): boolean {
  try {
    storage.setItem(MARKS_STORAGE_KEY, JSON.stringify(marks))
    return true
  } catch {
    return false
  }
}
