import { isAnnotation, isBookmark, type Annotation, type Bookmark, type Mark, type MarkRow, type MarkTint } from '../../kernel'
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

/** Rows out of a `mark.list` answer, ignoring anything that is not one. */
export function parseMarks(answer: unknown): readonly Mark[] {
  if (!Array.isArray(answer)) return []
  const out: Mark[] = []
  for (const item of answer) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    /* AN ID AND A BOOK, or it is not a mark: React keys on the first and every
     * view groups by the second. */
    if (typeof row['id'] !== 'string' || row['id'] === '') continue
    if (typeof row['bookId'] !== 'string' || row['bookId'] === '') continue
    out.push(asMark(row as unknown as MarkRow))
  }
  return out
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
  const resplit = (): void => {
    annotations = marks.filter(isAnnotation)
    bookmarks = marks.filter(isBookmark)
    changed()
  }

  const refresh = (): void => {
    void (async () => {
      try {
        const seen: Mark[] = []
        /* NO `book`, which the service reads as every book — see the header. */
        for await (const page of channel.stream('mark.list', {})) {
          seen.push(...parseMarks(page))
        }
        if (!live) return
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
