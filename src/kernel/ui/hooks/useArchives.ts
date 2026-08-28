import { useCallback } from 'react'
import { canArchiveMarks, exportMarksToFile, importMarksFromFile } from '../marksFiles'
import { canArchiveTags, exportTagsToFile, importTagsFromFile } from '../tagFiles'
import { planImport } from '../../core/tagArchive'
import { planImport as planMarksImport } from '../../core/marksArchive'
import type { CardsView } from './useCards'
import type { LibraryView } from './useLibrary'
import type { MarksView } from './useMarks'

/**
 * The reader's filing and their marginalia, out to a file and back.
 *
 * # Why this is not in `App`
 *
 * Four handlers, a hundred and seventy lines, and every one of them is the
 * same errand: pick a file, plan a merge, write it, and say what happened in
 * one sentence. None of it touches the reader's position, the screen, the
 * keyboard map or anything else `App` coordinates — it was simply written
 * where it was first needed.
 *
 * `App` is the component this repository's own audit calls a god component,
 * and the way out is not one large motion: it is taking whole errands out, one
 * at a time, where each is genuinely separable. This is one of them.
 *
 * BOTH KINDS REPORT THROUGH ONE NOTICE, which is the shelf's own line for
 * "something just happened to your library" — an archive written silently is
 * indistinguishable from a dialog the reader dismissed, and an import that
 * merged nothing looks exactly like one that failed. A dismissed dialog says
 * nothing at all, deliberately: the reader closed it, they know, and a message
 * about it is the app narrating their own action.
 */

export interface Archives {
  /** Null where this build cannot write a file — the palette then omits it. */
  readonly exportTags: (() => void) | null
  readonly importTags: (() => void) | null
  readonly exportMarks: (() => void) | null
  readonly importMarks: (() => void) | null
}

export interface ArchivesOptions {
  /* THE HOOK VIEWS, not the stores: these read `library.books` and
     `cards.all`, which are the rendered snapshots, and write through the same
     handles every other surface does. */
  readonly library: LibraryView
  readonly marks: MarksView
  readonly cards: CardsView
  /** Where every one of these says what happened. */
  readonly notice: (text: string) => void
}

export function useArchives({ library, marks, cards, notice }: ArchivesOptions): Archives {
/**
 * The reader's filing, out to a file and back.
 *
 * BOTH REPORT THROUGH `importNotice`, which is the shelf's own line for
 * "something just happened to your library" — an archive written silently is
 * indistinguishable from a dialog the reader dismissed, and an import that
 * merged nothing looks exactly like one that failed.
 *
 * A dismissed dialog says nothing at all, deliberately: the reader closed it,
 * they know, and a message about it is the app narrating their own action.
 */
const exportTagsNow = useCallback(() => {
  void exportTagsToFile(library.books, new Date())
    .then((path) => {
      if (!path) return
      const filed = library.books.filter((book) => (book.tags ?? []).length > 0).length
      notice(
        filed === 0
          ? 'No tags to export yet — nothing on the shelf is filed.'
          : `Exported the tags on ${filed} ${filed === 1 ? 'book' : 'books'}.`,
      )
    })
    .catch((cause: unknown) => {
      console.error('Paper: could not export your tags', cause)
      notice('Those tags could not be written.')
    })
}, [library.books])

const importTagsNow = useCallback(() => {
  void (async () => {
    const picked = await importTagsFromFile()
    if (!picked) return
    if (!picked.archive) {
      notice('That file is not a Paper tag export.')
      return
    }
    const plan = planImport(picked.archive, library.books)
    /* THE NUMBER THAT DID NOTHING IS WORTH SAYING TOO. An archive from
       another library matches nothing here, and an import that reports only
       its successes leaves the reader believing it worked. */
    const missed = plan.unmatched > 0 ? ` ${plan.unmatched} not on this shelf.` : ''
    if (plan.additions.length === 0) {
      notice(`Nothing to add — those tags are already here.${missed}`)
      return
    }
    /* ONE BATCHED CALL, AWAITED, exactly as the marks import below. This
     * looped `tagBooks` once per archived book in one synchronous pass —
     * two thousand write chains in flight in a single tick, the flood the
     * library's `addMany` documents — and said "Added N" before a single
     * write had landed, so a full disk produced a cheerful notice and no
     * tags. The books figure is the STORE's answer, what actually changed on
     * disk, and what could not be saved is said in the same breath. */
    const { changed, failed } = await library.tagMany(plan.additions)
    const lost =
      failed > 0 ? ` ${failed.toLocaleString()} ${failed === 1 ? 'book' : 'books'} could not be saved.` : ''
    notice(
      changed === 0 && failed === 0
        ? `Nothing to add — those tags are already here.${missed}`
        : `Added ${plan.tagsAdded.toLocaleString()} ${plan.tagsAdded === 1 ? 'tag' : 'tags'} across ${changed.toLocaleString()} ${changed === 1 ? 'book' : 'books'}.${lost}${missed}`,
    )
  })().catch((cause: unknown) => {
    console.error('Paper: could not import those tags', cause)
    notice('That file could not be read.')
  })
}, [library])
/**
 * The reader's marginalia, out to a file and back.
 *
 * THE EMPTY-FILE TRAP, and it is why this awaits rather than reads.
 * `MarksView.all` and `.allBookmarks` are empty until `loadAll()` has run,
 * and the only caller of `loadAll` is the Marginalia panel mounting. So an
 * export from the palette, in a session where that panel was never opened,
 * would have walked an empty list, written `{"version":1,"books":[]}` and
 * reported success — a backup that exists, opens, and contains nothing.
 *
 * That is "green is not evidence that anything happened" exactly, and it is
 * the worst possible shape for THIS feature: the file is not read again
 * until the day the reader needs it.
 *
 * `loadAllNow()` resolves with the rows rather than setting state and hoping
 * a re-render arrives first — see `MarksView.loadAllNow`.
 */
const exportMarksNow = useCallback(() => {
  void (async () => {
    /* CARDS ARE NOT LAZY — `CardStore` holds every row from the start,
       because a card is explicitly cross-book and no surface ever asked for
       one book's. Only the marks need the scan. */
    const everyMark = await marks.loadAllNow()
    const written = await exportMarksToFile(library.books, everyMark, cards.all, new Date())
    if (!written) return
    if (written.marks === 0 && written.cards === 0) {
      notice('Nothing to export yet — no marks and no cards.')
      return
    }
    const parts = [
      `${written.marks} ${written.marks === 1 ? 'mark' : 'marks'}`,
      `${written.cards} ${written.cards === 1 ? 'card' : 'cards'}`,
    ]
    /* SAYS WHICH FORMAT, because Markdown is a reading copy that cannot be
       imported back — and a reader told only "exported" could keep one as
       their only backup. */
    const note = written.format === 'md' ? ' as Markdown, which cannot be imported back' : ''
    notice(`Exported ${parts.join(' and ')} from ${written.books} ${written.books === 1 ? 'book' : 'books'}${note}.`)
  })().catch((cause: unknown) => {
    console.error('Paper: could not export your marginalia', cause)
    notice('Those marks could not be written.')
  })
}, [marks, cards, library.books])

const importMarksNow = useCallback(() => {
  void (async () => {
    const picked = await importMarksFromFile()
    if (!picked) return
    if (!picked.archive) {
      notice('That file is not a Paper marginalia export.')
      return
    }
    const everyMark = await marks.loadAllNow()
    const plan = planMarksImport(picked.archive, library.books, everyMark, cards.all)
    /* ONE WRITE PER BOOK, AND ONE FOR THE CARDS — and every one of them
     * AWAITED before the notice below claims anything.
     *
     * This looped `marks.add` and `cards.make` per row and reported success
     * without waiting for any of them. Two defects in one shape: each call
     * is a whole-file read-mutate-write, so a thousand-mark archive rewrote
     * a growing file a thousand times and the card store re-serialised its
     * entire global list per card; and "Added N marks" appeared whether or
     * not a single write had landed, so a full disk produced a cheerful
     * notice and no marginalia. */
    await Promise.all([
      ...plan.additions.map((one) =>
        marks.addMany(
          one.bookId,
          one.marks.map((mark) => ({
            bookId: one.bookId,
            cfi: mark.localAnchor.cfi,
            sectionIndex: mark.localAnchor.sectionIndex,
            text: mark.text,
            prefix: mark.prefix,
            suffix: mark.suffix,
            note: mark.note,
            kind: mark.kind,
            tint: mark.tint,
            style: mark.style,
            chapter: mark.chapter,
          })),
        ),
      ),
      cards.makeMany(
        plan.additions.flatMap((one) =>
          one.cards.map((card) => ({
            bookId: one.bookId,
            kind: card.kind,
            body: card.body,
            answer: card.answer,
            source: card.source,
            cfi: card.localAnchor?.cfi ?? null,
          })),
        ),
      ),
    ])
    /* THE BOOKS THAT MATCHED NOTHING ARE NAMED, not counted. An archive from
       another library matches nothing here, and an import that reports only
       its successes leaves the reader believing it worked. Three titles fit
       in a sentence; past that the count carries the rest. */
    const missing = plan.unmatched
    const named = missing.slice(0, 3).map((one) => one.title || 'an untitled book').join(', ')
    const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : ''
    const missed = missing.length > 0 ? ` Not on this shelf: ${named}${rest}.` : ''
    const already = plan.duplicates > 0 ? ` ${plan.duplicates} already here.` : ''
    /* SAID, NOT SWALLOWED: two archived marks that overlapped each other were
       kept as one, and the reader who exported both deserves to hear it. */
    const folded = plan.folded > 0 ? ` ${plan.folded} overlapping ${plan.folded === 1 ? 'mark' : 'marks'} kept as one.` : ''
    notice(
      plan.marksAdded === 0 && plan.cardsAdded === 0
        ? `Nothing to add.${already}${folded}${missed}`
        : `Added ${plan.marksAdded} ${plan.marksAdded === 1 ? 'mark' : 'marks'} and ${plan.cardsAdded} ${plan.cardsAdded === 1 ? 'card' : 'cards'} across ${plan.booksTouched} ${plan.booksTouched === 1 ? 'book' : 'books'}.${already}${folded}${missed}`,
    )
  })().catch((cause: unknown) => {
    console.error('Paper: could not import that marginalia', cause)
    notice('That file could not be read.')
  })
}, [marks, cards, library.books])

  /* NULL WHERE THE BUILD CANNOT DO IT, so the palette omits the row rather
     than offering one that would refuse — the same rule every other
     conditional command follows. The checks are the file layer's own. */
  return {
    exportTags: canArchiveTags() ? exportTagsNow : null,
    importTags: canArchiveTags() ? importTagsNow : null,
    exportMarks: canArchiveMarks() ? exportMarksNow : null,
    importMarks: canArchiveMarks() ? importMarksNow : null,
  }
}
