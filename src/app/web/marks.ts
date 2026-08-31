import {
  isPlaced,
  MARK_KINDS,
  MARK_STYLES,
  MARK_TINTS,
  isAnnotation,
  isBookmark,
  type Annotation,
  type Bookmark,
  type Mark,
  type MarkRow,
  type MarkTint,
} from '../../kernel'
import { byFirstId, id, num, oneOf, str } from './wireRow'
import type { ShelfChannel } from './channel'

/**
 * The shelf's marks, as a store a React view can read (phase 19, WI-19.9).
 *
 * ## Why this exists and `useMarks` does not serve
 *
 * `useMarks` owns a `MarkStorage` — a local file or `localStorage` — and this
 * client has neither. What it shares with that hook is the SHAPE a view reads,
 * which is all `Marginalia` needs: five members of the fourteen `MarksView`
 * declares. The pane's prop was narrowed to those five so a host without a
 * reading session can mount it.
 *
 * ## `mark.list` with no book is the whole shelf
 *
 * The service's own summary says "By book, or every mark on the shelf" — so the
 * cross-book view `Marginalia` browses is one call, not one call per book. That
 * is the fact that made this pane worth mounting at all; the desktop's own
 * `loadAll` warns it "costs a read per book", and over a channel that would be
 * 1 961 round trips.
 *
 * ## The row IS the mark
 *
 * `markRow` copies every field of `Mark` across, `prefix` and `suffix` included
 * since phase 19 — so `asMark` is a validation, not a translation, and stops
 * compiling if the two ever disagree.
 *
 * ## Writes are OPTIMISTIC and the snapshot is corrected by a re-read
 *
 * A reader deleting a highlight sees it go at once; the service call follows.
 * If the call is refused the next `refresh` puts it back, which is the honest
 * outcome — the mark IS still on the shelf. `persistent` turns false so the
 * pane can say the shelf stopped accepting writes, which is the same signal
 * `MarkSnapshot.persistent` carries on the desktop.
 */

/** What `Marginalia` reads. Five of `MarksView`'s fourteen members. */
export interface RemoteMarks {
  readonly all: readonly Annotation[]
  readonly allBookmarks: readonly Bookmark[]
  /** Annotations with no anchor in this library — see `MarkSnapshot.unplaced`.
   *  Never in `all`, so `Reader` never maps one to a drawable anchor. */
  readonly allUnplaced: readonly Annotation[]
  readonly persistent: boolean
  /* `MarkRef`, not `Mark` — a write needs only which mark and which book, which
   * is also all this client can be sure it has. */
  remove: (mark: MarkRef) => void
  setNote: (mark: MarkRef, note: string) => void
  /** Re-read every book's marks. One call here; one read per book on the desktop. */
  loadAll: () => void
  /**
   * Make a highlight, and hand back what the shelf made — or null if it
   * refused. NOT optimistic, unlike `remove` and `setNote`: a mark drawn on
   * the page before the shelf answered would carry an id the shelf never
   * issued, and the next `refresh` would erase it from under the reader.
   */
  add: (draft: MarkDraft) => Promise<Mark | null>
}

/** What a reader supplies to make a highlight. The rest the shelf decides. */
export interface MarkDraft {
  readonly bookId: string
  readonly cfi: string
  readonly sectionIndex: number
  readonly text: string
  readonly prefix: string
  readonly suffix: string
  readonly note: string
  readonly tint: MarkTint
  readonly chapter: string
}

/** Which mark, and in which book. */
export type MarkRef = { readonly id: string; readonly bookId: string }

/**
 * A wire row as the model.
 *
 * Thirteen fields straight across. `prefix` and `suffix` — the mark's recovery
 * context — were NOT on the wire until phase 19, so a mark read here had none
 * and a mark made from here was born without any. Both directions carry them
 * now; see `mark.add`'s row in the service table for why it mattered.
 */
export function asMark(row: MarkRow): Mark {
  return {
    id: row.id,
    bookId: row.bookId,
    cfi: row.cfi,
    sectionIndex: row.sectionIndex,
    text: row.text,
    prefix: row.prefix,
    suffix: row.suffix,
    note: row.note,
    kind: row.kind,
    tint: row.tint,
    style: row.style,
    chapter: row.chapter,
    createdAt: row.createdAt,
  }
}

/**
 * Rows out of a `mark.list` answer, ignoring anything that is not one.
 *
 * ⚠️ **EVERY FIELD IS READ, AND TWO USED TO BE.** This checked `id` and
 * `bookId` and then cast the rest — and `asMark` copies thirteen fields
 * straight across. A `text` that arrived as an object reached React, which
 * renders an object child by throwing; a `createdAt` that arrived as a string
 * sorted lexically; a `kind` this build has never heard of fell through every
 * switch to nothing. The row looked valid because the two fields anybody had
 * thought about were.
 *
 * A row missing anything REQUIRED is dropped rather than defaulted: a mark with
 * no `cfi` cannot be found in a book, and one with an invented `tint` is a
 * shelf and a client disagreeing about the wire, which is worth seeing.
 * `prefix`/`suffix` default to `''` because they genuinely may be absent — a
 * mark made before phase 19 has none.
 */
/** One shared empty list, so a client with none does not re-render on identity. */
const NONE: readonly Annotation[] = []

/**
 * The `unplaced` record a wire row carries, or undefined.
 *
 * The kernel's `readUnplaced` in one sentence, restated here because this file
 * parses SOMEBODY ELSE'S JSON and may not assume the shelf sent a well-formed
 * one — the same reason every other field on this row is read rather than cast.
 * A row claiming `unplaced: true`, or a reason this build has never heard of,
 * is not an unplaced mark and is refused with its missing anchor.
 */
function readUnplaced(value: unknown): Mark['unplaced'] {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (row['reason'] !== 'foreign-build') return undefined
  const fromBook = id(row['fromBook'])
  return fromBook === null ? undefined : { reason: 'foreign-build', fromBook }
}

export function parseMarks(answer: unknown): readonly Mark[] {
  if (!Array.isArray(answer)) return []
  const out: Mark[] = []
  for (const item of answer) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    /* AN ID AND A BOOK, or it is not a mark: React keys on the first and every
     * view groups by the second. */
    const rowId = id(row['id'])
    const bookId = id(row['bookId'])
    if (rowId === null || bookId === null) continue

    const cfi = str(row['cfi'])
    const sectionIndex = num(row['sectionIndex'])
    const text = str(row['text'])
    const note = str(row['note'])
    const chapter = str(row['chapter'])
    const createdAt = num(row['createdAt'])
    const kind = oneOf(MARK_KINDS, row['kind'])
    const tint = oneOf(MARK_TINTS, row['tint'])
    const style = oneOf(MARK_STYLES, row['style'])
    /* ⚠️ **AN UNPLACED MARK HAS NO `cfi` AND NO SECTION, AND THIS PARSER DROPPED
     * IT** (WI-21.7). The rule above — "a mark with no `cfi` cannot be found in
     * a book" — is right about a mark that is MISSING one and wrong about a mark
     * that declares it has none. Left as it was, a reader importing an archive
     * on the desktop would open the browser client and find those marks simply
     * gone, with nothing anywhere reporting a drop.
     *
     * Validated, not trusted: only a row that says WHY, in a word this build
     * knows, is allowed to arrive anchorless. Anything else still falls through
     * to the refusal below. */
    const unplaced = readUnplaced(row['unplaced'])
    if (unplaced !== undefined) {
      if (text === null || note === null || chapter === null || createdAt === null) continue
      if (kind === null || tint === null || style === null) continue
      out.push({
        id: rowId,
        bookId,
        cfi: '',
        sectionIndex: 0,
        text,
        prefix: str(row['prefix']) ?? '',
        suffix: str(row['suffix']) ?? '',
        note,
        kind,
        tint,
        style,
        chapter,
        createdAt,
        unplaced,
      })
      continue
    }
    if (
      cfi === null ||
      /* ⚠️ **AND EMPTY IS NOT A CFI.** `str` returns `''` unchanged, so the
         null test above never fired for an anchorless row and one arrived here
         WITHOUT the discriminator — which `resplit` then files under
         `allUnplaced` on `isPlaced` alone. The reader is shown a mark that
         lost its anchor as though it came from another edition, with the
         panel's explanation missing because there is no `unplaced` to read.
         The comment on the branch above already says anything unexplained
         "falls through to the refusal below"; it did not.
         This is the kernel's own rule — `isMark` admits an empty cfi only
         beside an `unplaced` — restated at the wire, where the JSON is
         somebody else's. Unreachable until WI-21.7 put anchorless rows on the
         wire at all, which is exactly why it needs pinning now. */
      cfi === '' ||
      sectionIndex === null ||
      text === null ||
      note === null ||
      chapter === null ||
      createdAt === null ||
      kind === null ||
      tint === null ||
      style === null
    ) {
      continue
    }

    out.push({
      id: rowId,
      bookId,
      cfi,
      sectionIndex,
      text,
      /* ABSENT IS LEGAL HERE, and only here: recovery context did not cross the
         wire before phase 19, so an older mark has none. */
      prefix: str(row['prefix']) ?? '',
      suffix: str(row['suffix']) ?? '',
      note,
      kind,
      tint,
      style,
      chapter,
      createdAt,
    } as Mark)
  }
  /* A REPEATED ID LOSES A ROW IN THE RECONCILER, not here — see `byFirstId`. */
  return byFirstId(out, (mark) => mark.id)
}

export interface MarksStore extends RemoteMarks {
  subscribe: (listener: () => void) => () => void
  /** Re-read the shelf. Called once at open and after a write is refused. */
  refresh: () => void
  dispose: () => void
}

export function createRemoteMarks(channel: ShelfChannel): MarksStore {
  let marks: readonly Mark[] = []
  let persistent = true
  let live = true
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const l of listeners) l()
  }

  /* SPLIT ONCE PER CHANGE, not per render. `getSnapshot`'s contract is identity
   * stability, and filtering in a getter would hand React a new array every
   * time it looked and re-render forever. */
  let annotations: readonly Annotation[] = []
  let bookmarks: readonly Bookmark[] = []
  let unplaced: readonly Annotation[] = NONE
  const resplit = (): void => {
    /* THREE CLASSES, as the kernel store splits them — `MarkSnapshot.unplaced`
     * says why. A mark with no anchor here is an annotation the reader can read
     * and cannot be sent to, so it belongs in the panel's list and out of
     * `all`, which is what the reader's own view paints from. */
    const live = marks.filter(isAnnotation)
    annotations = live.filter(isPlaced)
    unplaced = live.length === annotations.length ? NONE : live.filter((one) => !isPlaced(one))
    bookmarks = marks.filter(isBookmark)
    changed()
  }

  /**
   * WHICH REFRESH IS THE CURRENT ONE.
   *
   * ⚠️ `refresh` is reached from four places — the initial read, `Marginalia`'s
   * `loadAll` on mount, a mark being made, and the refusal path in `write` —
   * and each fires a detached async walk with nothing sequencing them. The one
   * that STARTS first can FINISH last, so a mark the reader has just made
   * disappears when an older answer lands on top of the newer one, and comes
   * back on the next refresh. Intermittent, and indistinguishable from the
   * shelf being wrong.
   */
  let generation = 0

  const refresh = (): void => {
    const mine = ++generation
    void (async () => {
      try {
        const seen: Mark[] = []
        /* NO `book`, which the service reads as every book — see the header. */
        for await (const page of channel.stream('mark.list', {})) {
          seen.push(...parseMarks(page))
        }
        if (!live || mine !== generation) return
        marks = seen
        resplit()
      } catch (cause) {
        /* NOT A CLEARED LIST. The marks last seen are real and the channel is
         * what went; emptying would tell a reader their highlights had been
         * deleted, which is alarming and false. */
        console.error('Paper: could not read your marks', cause)
      }
    })()
  }

  const write = (service: string, body: Record<string, unknown>): void => {
    void channel.call(service, body).catch((cause: unknown) => {
      console.error(`Paper: ${service} was refused`, cause)
      /* THE SHELF STOPPED ACCEPTING WRITES, and the pane says so. The optimistic
       * change is then undone by the re-read, which is the truth. */
      persistent = false
      refresh()
    })
  }

  refresh()

  return {
    get all() {
      return annotations
    },
    get allBookmarks() {
      return bookmarks
    },
    get allUnplaced() {
      return unplaced
    },
    get persistent() {
      return persistent
    },
    remove: (mark) => {
      marks = marks.filter((one) => one.id !== mark.id)
      resplit()
      write('mark.remove', { mark: mark.id, book: mark.bookId })
    },
    setNote: (mark, note) => {
      marks = marks.map((one) => (one.id === mark.id ? { ...one, note } : one))
      resplit()
      write('mark.set', { mark: mark.id, book: mark.bookId, note })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    loadAll: refresh,
    add: async (draft) => {
      try {
        const answer = await channel.call('mark.add', {
          book: draft.bookId,
          cfi: draft.cfi,
          section: draft.sectionIndex,
          text: draft.text,
          prefix: draft.prefix,
          suffix: draft.suffix,
          note: draft.note,
          colour: draft.tint,
          chapter: draft.chapter,
          kind: 'highlight',
        })
        const rows = parseMarks([answer])
        const made = rows[0]
        if (made === undefined) return null
        marks = [...marks, made]
        resplit()
        return made
      } catch (cause) {
        console.error('Paper: mark.add was refused', cause)
        persistent = false
        return null
      }
    },
    refresh,
    dispose: () => {
      live = false
      listeners.clear()
    },
  }
}
