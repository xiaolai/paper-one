import { createMark, isPlaced, type Annotation, type Mark, type MarkStore } from '../../kernel'
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
  const placedOf = (all: readonly Annotation[]) => all.filter(isPlaced)

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
      void marks.loadAll().catch(report('read every book’s marks'))
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
      return mark
    },

    subscribe: (listener) => marks.subscribe(listener),

    /* THE OPEN BOOK'S FILE, RE-READ. `MarkStore.open` puts the read on that
       book's write queue, which is what makes the answer it gets the current
       answer rather than the file as it was before a highlight in flight. */
    refresh: () => {
      const { bookId } = marks.getSnapshot()
      if (bookId === null) return
      void marks.open(bookId).catch(report('re-read this book’s marks'))
    },

    dispose: () => {
      /* Nothing to drop. The browser client's store owns a channel and a
         polling cursor; this one is a view over a store the composition root
         built and will tear down with the app. */
    },
  }
}
