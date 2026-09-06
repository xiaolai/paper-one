import {
  boundedMark,
  createMark,
  isPlaced,
  type Annotation,
  type Mark,
  type MarkStore,
  type Placed,
} from '../../kernel'
import type { MarkDraft, MarkRef, MarksStore } from '../web/marks'

/**
 * The reader's marks, from THIS DEVICE'S OWN store.
 *
 * ## The same contract, the other implementation
 *
 * `MarksStore` is what `Reader` was written against — `all`, `allBookmarks`,
 * `allUnplaced`, `persistent`, four mutators and a subscription. The browser
 * client answers it by calling `mark.*` over a WebSocket against a shelf that
 * grants reads; the phone answers it from `MarkStore`, which owns the files.
 *
 * So the phone's reader can WRITE, where the browser client's cannot. That is
 * not a setting: `canWrite` is a prop, the browser passes false because a web
 * session's grant is deliberately read-only, and this host passes true because
 * the marks are on its own disk.
 *
 * ## `add` is not optimistic here either, and for a different reason
 *
 * The contract says a highlight must not be drawn before the store has made
 * it, because a mark carrying an id the shelf never issued is erased by the
 * next refresh. There is no shelf here — but the reason survives translation:
 * `MarkStore.add` REPLACES whatever the new mark overlaps, so what the reader
 * ends up with is not always what was drafted. Handing back the store's answer
 * rather than the draft is what keeps the page and the file agreeing.
 *
 * ⚠️ **AND THE MARK IS MINTED HERE, NOT IN THE STORE.** `createMark` is the
 * caller's job by design — the desktop needs the id and the anchor at once, to
 * draw it — so this module mints and the store folds it in. Minting in two
 * places is exactly why `createMark` is one function rather than an object
 * literal at each call site.
 */

export interface LocalMarksDeps {
  readonly marks: MarkStore
  /** Told when a write did not land. */
  readonly failed?: (what: string, cause: unknown) => void
}

/** `MarksStore` over the kernel's own mark store. */
export function localMarks({ marks, failed }: LocalMarksDeps): MarksStore {
  const report = (what: string) => (cause: unknown) => {
    failed?.(what, cause)
  }

  /* ⚠️ `MarkSnapshot.all` IS `Annotation[]`, NOT `Placed<Annotation>[]`, and
     the difference is deliberate on the kernel's side: `all` is CROSS-BOOK and
     `ResolvedCfi` means "addresses a passage in the build now open", so
     branding another book's anchors with it would say something false at the
     one door the brand exists to guard.

     `RemoteMarks.all` is the narrower type because `Reader` maps it straight
     to painter anchors. So the filter belongs here, at the boundary between
     the two — and it is a filter over a type predicate, so the compiler
     carries it rather than a comment. */
  /* CACHED BY SOURCE IDENTITY. `MarkStore` already projects its snapshot into
     stable arrays so a subscriber can compare by reference; filtering afresh on
     every getter access threw that away and handed `Marginalia` a new array
     each render, defeating the memoisation on the other side of the seam. Same
     input array, same output array. */
  let placedFrom: readonly Annotation[] | null = null
  let placedTo: Placed<Annotation>[] = []
  /* ⚠️ THE RETURN TYPE IS `Placed<Annotation>[]`, NOT `Annotation[]`, and the
     comment above this function says why: the narrowing is the point, and it
     is carried by the compiler rather than by prose. Widening it here — which
     an explicit `readonly Annotation[]` did — puts unplaced marks back in the
     type the painter accepts, silently. */
  const placedOf = (all: readonly Annotation[]): Placed<Annotation>[] => {
    if (all !== placedFrom) {
      placedFrom = all
      placedTo = all.filter(isPlaced)
    }
    return placedTo
  }

  return {
    get all() {
      return placedOf(marks.getSnapshot().all)
    },
    get allBookmarks() {
      return marks.getSnapshot().allBookmarks
    },
    get allUnplaced() {
      return marks.getSnapshot().allUnplaced
    },
    get persistent() {
      return marks.getSnapshot().persistent
    },

    remove: (mark: MarkRef) => {
      void marks.remove(mark.id, mark.bookId).catch(report('remove a mark'))
    },

    setNote: (mark: MarkRef, note: string) => {
      void marks.updateNote(mark.id, note, mark.bookId).catch(report('save a note'))
    },

    loadAll: () => {
      /* ⚠️ `loadAll` NEVER REJECTS. It catches its own scan failure, empties
         `all` and says so through `scanFailed` — so the `.catch(report(…))`
         that used to sit here was unreachable, and a library that would not
         read looked exactly like a library with no marks in it. The flag is
         the only signal there is, so it is what gets read. */
      void marks.loadAll().then(() => {
        if (marks.getSnapshot().scanFailed) {
          report('read every book’s marks')(new Error('the scan did not finish'))
        }
      })
    },

    add: async (draft: MarkDraft): Promise<Mark | null> => {
      const mark = createMark({
        kind: 'highlight',
        /* ⚠️ `'fill'` IS NOT A DEFAULT STANDING IN FOR A CHOICE. `MarkDraft` —
           the contract `Reader` writes against — carries a tint and no style,
           because the browser client's shelf decides it; and this surface's
           `SelectionBar` offers three tints and no style picker at all. So
           fill is the only style the phone's reader can produce, and reading
           one out of a setting here would invent a decision the reader was
           never given. The desktop's picker is a desktop surface. */
        style: 'fill',
        bookId: draft.bookId,
        cfi: draft.cfi,
        sectionIndex: draft.sectionIndex,
        text: draft.text,
        prefix: draft.prefix,
        suffix: draft.suffix,
        note: draft.note,
        tint: draft.tint,
        chapter: draft.chapter,
      })
      /* WHAT THE FILE KEEPS IS WHAT THE CALLER IS TOLD. `MarkStore.add` writes
         `boundedMark(raw)` — its own rule, "the cut the reader sees is the cut
         the file keeps" — and returning the uncut draft handed the reader a
         highlight whose text or note is longer than the one on disk, which the
         next read then shortens under them. Bounded here through the SAME
         function the store uses, rather than a second copy of the limits. */
      const stored = boundedMark(mark)
      try {
        await marks.add(mark)
      } catch (cause) {
        /* NULL IS THE CONTRACT'S "refused", and the caller draws nothing.
           Swallowing this and returning the mark would paint a highlight that
           is not in the file — the same failure the non-optimistic rule exists
           to prevent, arrived at from the other side. */
        report('make a highlight')(cause)
        return null
      }
      return stored
    },

    subscribe: (listener) => marks.subscribe(listener),

    /* THE OPEN BOOK'S FILE, RE-READ. `MarkStore.open` puts the read on that
       book's write queue, which is what makes the answer it gets the current
       answer rather than the file as it was before a highlight in flight.
       ⚠️ AND `open` ALONE REFRESHED NOTHING THIS ADAPTER SHOWS. It fills
       `snapshot.current`; every getter above reads `snapshot.all`, which only
       `loadAll` fills — so a reader who edited a highlight saw the old text
       until something else happened to scan the library. The browser adapter
       is the reference and does not have the split at all: there `loadAll` and
       `refresh` are literally one function.
       Both, then: `open` for the queue-correct read of the book being read —
       which is also what clears `unreadable` — and `loadAll` for the lists the
       reader is actually looking at. `loadAll` reads outside the write queue
       deliberately and guards itself with `writeGen`, so memory still wins for
       a book that moved under the scan. */
    refresh: () => {
      const { bookId } = marks.getSnapshot()
      /* Nothing to re-read with nothing open — the adapter's own contract, and
         a full library scan on a closed reader is work for no screen. */
      if (bookId === null) return
      /* ⚠️ `open` DOES NOT REJECT EITHER, and that is the other half of the
         same defect. A marks file that is there and will not read is caught
         inside `MarkStore.open`, which sets `unreadable` and publishes — so a
         `.catch` here is as unreachable as the one `loadAll` had. `unreadable`
         is the only signal, so it is the one that gets read. */
      void marks.open(bookId).then(() => {
        if (marks.getSnapshot().unreadable) {
          report('re-read this book’s marks')(new Error('this book’s marks file would not read'))
        }
      })
      void marks.loadAll().then(() => {
        if (marks.getSnapshot().scanFailed) {
          report('read every book’s marks')(new Error('the scan did not finish'))
        }
      })
    },

    dispose: () => {
      /* Nothing to drop. The browser client's store owns a channel and a
         polling cursor; this one is a view over a store the composition root
         built and will tear down with the app. */
    },
  }
}
