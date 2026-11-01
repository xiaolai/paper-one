import {
  MarksScanFailed,
  createCard,
  createMark,
  folderOf,
  type KernelServices,
  type MarkStore,
  type NewMark,
} from '../../../kernel'
import { ArchiveOverLimit, planImport as planMarksImport } from './marksArchive'
import { exportMarksToFile, importMarksFromFile } from './marksFiles'
import { planImport } from './tagArchive'
import { exportTagsToFile, importTagsFromFile } from './tagFiles'

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
  readonly exportTags: () => void
  readonly importTags: () => void
  readonly exportMarks: () => void
  readonly importMarks: () => void
}

/* THE STORES, not a hook's views, and they are read when a row is pressed: this
   is no longer a component, so there is no render for a snapshot to be stale
   behind, and the palette holds nothing that needs rebuilding when one changes. */
export type ArchiveServices = Pick<KernelServices, 'library' | 'marks' | 'cards' | 'files' | 'notify'>

/*
 * NAMED, NOT COUNTED. An archive from another library matches nothing here, and an
 * import that reports only its successes leaves the reader believing it worked; a
 * refusal that names no book leaves them nothing to act on. Three titles fit in a
 * sentence; past that the count carries the rest.
 */
const nameThem = (books: readonly { readonly title: string }[]): string => {
  const named = books.slice(0, 3).map((one) => one.title || 'an untitled book').join(', ')
  return `${named}${books.length > 3 ? ` and ${books.length - 3} more` : ''}`
}

/**
 * The sentence for marks that would not read, ending in what the reader can do.
 *
 * THE ROUTE IS THE READER'S OWN, and there is no repair control on purpose: a
 * damaged file may still hold what they want, and only they know whether a copy
 * exists. A folder with no shelf row has no title, and its name is still somewhere
 * to look. No folders at all means the library would not list, and no book can be
 * blamed for that.
 */
function marksRefusal(cause: MarksScanFailed, shelf: readonly { readonly bookId: string; readonly title: string }[], undone: string): string {
  const titled = (folder: string) => {
    const book = shelf.find((one) => folderOf(one.bookId) === folder)
    return book ?? { title: `the folder ${folder.slice(folder.lastIndexOf('/') + 1)}` }
  }
  const { damaged, unsaved } = cause
  if (damaged.length === 0 && unsaved.length === 0) return `Your marks could not be read — nothing was ${undone}.`
  const facts: string[] = []
  const steps: string[] = []
  if (damaged.length > 0) {
    facts.push(`the marks for ${nameThem(damaged.map(titled))} could not be read`)
    steps.push(damaged.length === 1 ? 'Restore that marks file or remove the book' : 'Restore those marks files or remove the books')
  }
  if (unsaved.length > 0) {
    const one = unsaved.length === 1
    facts.push(`${one ? 'a change' : 'changes'} to the marks for ${nameThem(unsaved.map(titled))} ${one ? 'was' : 'were'} not saved`)
    steps.push(one ? 'open the book with the unsaved change again' : 'open the books with unsaved changes again')
  }
  const said = facts.join(' and ')
  const step = steps.join(', and ')
  return `${said[0]?.toUpperCase()}${said.slice(1)} — nothing was ${undone}. ${step[0]?.toUpperCase()}${step.slice(1)}, then try again.`
}

/**
 * Mint and write several marks for ONE book, in one store write.
 *
 * FAIL FAST on a draft naming another book. The store writes the batch under the
 * FIRST argument's file, so a mismatched draft would land in one book's file
 * while carrying another book's id — ownership corrupted quietly, surfacing only
 * when a later mutation routes by the id inside the row. The import below builds
 * both from the same plan entry; this guard is for the change that will not.
 */
export function addDrafts(marks: MarkStore, bookId: string, drafts: readonly NewMark[]): Promise<void> {
  const foreign = drafts.find((draft) => draft.bookId !== bookId)
  if (foreign) {
    return Promise.reject(
      new Error(`addMany for ${bookId} was handed a draft belonging to ${foreign.bookId}`),
    )
  }
  return marks.addMany(bookId, drafts.map((draft) => createMark(draft)))
}

export function createArchives({ library, marks, cards, files, notify }: ArchiveServices): Archives {
/* The reader's filing, out to a file and back — reporting through `notify`,
 * per the module header. A dismissed dialog says nothing at all, deliberately:
 * the reader closed it, they know, and a message about it is the app
 * narrating their own action. */
const exportTagsNow = (): void => {
  const books = library.getSnapshot()
  void exportTagsToFile(files, books, new Date())
    .then((written) => {
      if (!written) return
      const filed = books.filter((book) => (book.tags ?? []).length > 0).length
      notify(
        filed === 0
          ? 'No tags to export yet — nothing on the shelf is filed.'
          : `Exported the tags on ${filed} ${filed === 1 ? 'book' : 'books'}.`,
      )
    })
    .catch((cause: unknown) => {
      if (cause instanceof ArchiveOverLimit) {
        console.error('Paper: your filing is past what one archive can hold', cause)
        notify('You have more tags than one file can hold and be read back — nothing was exported.')
        return
      }
      console.error('Paper: could not export your tags', cause)
      notify('Those tags could not be written.')
    })
}

const importTagsNow = (): void => {
  /* WHICH STAGE FAILED decides the sentence. One catch used to answer every
   * rejection with "That file could not be read" — including a rejected
   * store write, for which that message is factually wrong and sends the
   * reader chasing the wrong problem (their file, not their disk). */
  let reading = true
  void (async () => {
    const picked = await importTagsFromFile(files)
    if (!picked) return
    if (!picked.archive) {
      notify('That file is not a Paper tag export.')
      return
    }
    const plan = planImport(picked.archive, library.getSnapshot())
    reading = false
    /* THE NUMBER THAT DID NOTHING IS WORTH SAYING TOO. An archive from
       another library matches nothing here, and an import that reports only
       its successes leaves the reader believing it worked. */
    const missed = plan.unmatched > 0 ? ` ${plan.unmatched} not on this shelf.` : ''
    if (plan.additions.length === 0) {
      notify(`Nothing to add — those tags are already here.${missed}`)
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
    const books = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'book' : 'books'}`
    const lost = failed > 0 ? ` ${books(failed)} could not be saved.` : ''
    /* ⚠️ THE TAG COUNT IS THE PLAN'S, AND THE PLAN IS ONLY TRUE IF EVERY WRITE
     * LANDED. `tagMany` answers in BOOKS — how many changed, how many failed —
     * so a partial write leaves no tag figure anybody can stand behind, and
     * this said "Added 412 tags across 3 books. 97 books could not be saved",
     * claiming all 412 for the three that landed. With every write refused it
     * read "Added 412 tags across 0 books", which is the cheerful notice over
     * an empty disk that the batching above exists to prevent.
     *
     * So the number is spent only on a whole import; a partial one counts the
     * books it actually changed, which is the thing that was measured. */
    notify(
      changed === 0 && failed === 0
        ? `Nothing to add — those tags are already here.${missed}`
        : changed === 0
          ? `Nothing was added.${lost}${missed}`
          : failed === 0
            ? `Added ${plan.tagsAdded.toLocaleString()} ${plan.tagsAdded === 1 ? 'tag' : 'tags'} across ${books(changed)}.${missed}`
            : `Added tags to ${books(changed)}.${lost}${missed}`,
    )
  })().catch((cause: unknown) => {
    console.error('Paper: could not import those tags', cause)
    notify(reading ? 'That file could not be read.' : 'The file was read, but those tags could not be saved.')
  })
}
/**
 * The reader's marginalia, out to a file and back.
 *
 * THE EMPTY-FILE TRAP, and it is why this awaits rather than reads.
 * `MarkSnapshot.all` and `.allBookmarks` are empty until `loadAll()` has run, and
 * the only caller of `loadAll` IN A RUNNING APP is the Marginalia panel
 * mounting. (`app/mobile/localMarks.ts` calls it twice more, and `MobileApp`
 * says in its own words that `localContent`/`localMarks`/`localPositions` are
 * "written and mounted by nothing" — so a grep finds three call sites and two
 * of them are unreachable. Said here because the bare claim reads as wrong to
 * anyone who greps it.) So an
 * export from the palette, in a session where that panel was never opened,
 * would have walked an empty list, written `{"version":1,"books":[]}` and
 * reported success — a backup that exists, opens, and contains nothing.
 *
 * That is "green is not evidence that anything happened" exactly, and it is
 * the worst possible shape for THIS feature: the file is not read again
 * until the day the reader needs it.
 *
 * `loadAllNow()` resolves with the rows rather than setting state and hoping
 * a re-render arrives first — see `MarkStore.loadAllNow`.
 *
 * AND A FAILED SCAN IS THE SAME TRAP WEARING A DIFFERENT CAUSE. A scan that
 * could not read the shelf leaves the same empty list behind as a shelf with
 * nothing on it, so the fixed export would still have written the empty
 * archive — over the reader's backup, reported as a success — for a disk that
 * would not answer. `loadAllNow` rejects with `MarksScanFailed` for that case,
 * and both handlers below refuse rather than write. The dialog is never even
 * opened, because the scan is awaited first.
 */
const exportMarksNow = (): void => {
  void (async () => {
    /* CARDS ARE NOT LAZY — `CardStore` holds every row from the start,
       because a card is explicitly cross-book and no surface ever asked for
       one book's. Only the marks need the scan. */
    const everyMark = await marks.loadAllNow()
    const written = await exportMarksToFile(files, library.getSnapshot(), everyMark, cards.getSnapshot().all, new Date())
    if (!written) return
    if (written.marks === 0 && written.cards === 0) {
      notify('Nothing to export yet — no marks and no cards.')
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
    notify(`Exported ${parts.join(' and ')} from ${written.books} ${written.books === 1 ? 'book' : 'books'}${note}.`)
  })().catch((cause: unknown) => {
    /* WHICH END FAILED decides the sentence, exactly as the tag import above.
       "could not be written" over a scan failure sends the reader to look at
       the disk they were about to write to, when the one that would not
       answer is the one their books are on — and nothing was written at all,
       which is the fact they most need. */
    if (cause instanceof MarksScanFailed) {
      console.error('Paper: could not read your marginalia to export it', cause)
      notify(marksRefusal(cause, library.getSnapshot(), 'exported'))
      return
    }
    /* NOT THE DISK'S FAULT, and retrying will not help. Said so the reader knows
       the backup they already have is still the one they have. */
    if (cause instanceof ArchiveOverLimit) {
      console.error('Paper: your marginalia is past what one archive can hold', cause)
      notify('You have more marks and cards than one file can hold and be read back — nothing was exported.')
      return
    }
    console.error('Paper: could not export your marginalia', cause)
    notify('Those marks could not be written.')
  })
}

const importMarksNow = (): void => {
  void (async () => {
    const picked = await importMarksFromFile(files)
    if (!picked) return
    if (!picked.archive) {
      notify('That file is not a Paper marginalia export.')
      return
    }
    const everyMark = await marks.loadAllNow()
    const plan = planMarksImport(picked.archive, library.getSnapshot(), everyMark, cards.getSnapshot().all)
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
    /* SETTLED, NOT RACED TO THE FIRST FAILURE. `Promise.all` rejected on one
     * book's write and reported "could not be read" for an import that had
     * read fine and LANDED most of its books — the reader retries the whole
     * file or gives up, both wrong. Each book's write settles on its own;
     * what failed is counted and said beside what landed. */
    /* ⚠️ **`mark.localAnchor.cfi` IS READ UNCONDITIONALLY HERE, AND THAT IS
     * SAFE ONLY BECAUSE `BookImport.marks` HOLDS ID-MATCHED ROWS** (WI-21.1).
     * `planImport` partitions each shelf book's archive rows by how they
     * matched and puts nothing else in that list, so every anchor reaching
     * `addMany` was written against these exact bytes. The invariant is
     * enforced there and invisible here, which is why it is written down: a
     * change that let name-matched rows back into `.marks` would put a foreign
     * CFI into the reader's own store from this line, silently. `unplacedBooks`
     * is where those rows go, and `cards` carries the name-matched half with
     * `localAnchor` already nulled. */
    /* ⚠️ **NAMED ONCE, BECAUSE THE OUTCOMES BELOW ARE SLICED BY POSITION.**
     * These writes sit BETWEEN the per-book writes and the cards write, so
     * every index into `settled` depends on how many there are. Recomputing
     * the filter at the read end is how `cardsFailed` came to read
     * `settled[plan.additions.length]` — the first UNPLACED write — and report
     * the card write's fate from a row that is not it. */
    const unplacedWrites = plan.additions.filter((one) => one.unplaced.length > 0)
    const settled = await Promise.allSettled([
      ...plan.additions.map((one) =>
        addDrafts(
          marks,
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
      /* ⚠️ **THE NAME-MATCHED MARKS, STORED WITHOUT THEIR ANCHORS** (WI-21.7).
       * A SECOND `addMany` per book rather than one merged call, because the
       * two lists are two different writes: the shape above reads
       * `mark.localAnchor.cfi` and this one must not, and merging them would
       * put the decision back inside a `map` where a later edit can lose it.
       *
       * `cfi: ''` with an `unplaced` record beside it is the only shape
       * `isMark` accepts an empty anchor in — see the field. `sectionIndex: 0`
       * is a placeholder and means nothing; the class the store puts these in
       * is what keeps them away from the painter, not the number. */
      ...unplacedWrites.map((one) =>
        addDrafts(
          marks,
          one.bookId,
          one.unplaced.map(({ mark, fromBook }) => ({
            bookId: one.bookId,
            cfi: '',
            sectionIndex: 0,
            text: mark.text,
            prefix: mark.prefix,
            suffix: mark.suffix,
            note: mark.note,
            kind: mark.kind,
            tint: mark.tint,
            style: mark.style,
            chapter: mark.chapter,
            unplaced: { reason: 'foreign-build' as const, fromBook },
          })),
        ),
      ),
      cards.addMany(
        [
          ...plan.additions.flatMap((one) => one.cards.map((card) => ({ ...card, bookId: one.bookId }))),
          ...plan.looseCards,
        ].map((card) => ({
          bookId: card.bookId,
          kind: card.kind,
          body: card.body,
          answer: card.answer,
          source: card.source,
          cfi: card.localAnchor?.cfi ?? null,
        })).map((draft) => createCard(draft)),
      ),
    ])
    for (const outcome of settled) {
      if (outcome.status === 'rejected') console.error('Paper: an import write failed', outcome.reason)
    }
    /* THE THREE GROUPS, SLICED IN THE ORDER THEY WERE QUEUED — see
     * `unplacedWrites`. Each boundary is derived from the list that produced
     * it, so adding a fourth group moves every index by construction rather
     * than by somebody remembering to. */
    const bookOutcomes = settled.slice(0, plan.additions.length)
    const unplacedOutcomes = settled.slice(
      plan.additions.length,
      plan.additions.length + unplacedWrites.length,
    )
    const cardsFailed = settled[plan.additions.length + unplacedWrites.length]?.status === 'rejected'
    /* ⚠️ **A BOOK IS COUNTED ONCE**, however many of its writes failed. A
     * name-matched book has two, and counting rejections rather than books
     * told the reader "2 books could not be saved" about one book. */
    const failedBookIds = new Set<string>()
    for (const [at, one] of plan.additions.entries()) {
      if (bookOutcomes[at]?.status === 'rejected') failedBookIds.add(one.bookId)
    }
    for (const [at, one] of unplacedWrites.entries()) {
      if (unplacedOutcomes[at]?.status === 'rejected') failedBookIds.add(one.bookId)
    }
    const failedBooks = failedBookIds.size
    /* ⚠️ WHAT LANDED, NOT WHAT WAS PLANNED. The sentence took its three
     * numbers from the plan and appended the failures as a qualifier, so an
     * import whose every write was refused still read "Added 812 marks and 40
     * cards across 96 books" with "96 books could not be saved" behind it —
     * the reader is told the thing happened and then told it did not. Each
     * book is one write and each settles on its own, so the counts are exactly
     * derivable: a fulfilled book contributed its marks, a rejected one
     * contributed none, and the cards are one write for the lot. */
    const marksAdded = plan.additions.reduce(
      (sum, one, at) => (bookOutcomes[at]?.status === 'fulfilled' ? sum + one.marks.length : sum),
      0,
    )
    const cardsAdded = cardsFailed ? 0 : plan.cardsAdded
    const booksTouched = bookOutcomes.filter((outcome) => outcome.status === 'fulfilled').length
    const lostWrites =
      failedBooks > 0 || cardsFailed
        ? ` ${[
            failedBooks > 0 ? `${failedBooks} ${failedBooks === 1 ? 'book' : 'books'}` : '',
            cardsFailed ? 'the cards' : '',
          ]
            .filter(Boolean)
            .join(' and ')} could not be saved.`
        : ''
    /* THE BOOKS THAT MATCHED NOTHING ARE NAMED — see `nameThem`. */
    const missing = plan.unmatched
    const missed = missing.length > 0 ? ` Not on this shelf: ${nameThem(missing)}.` : ''
    /* ⚠️ **A DIFFERENT SENTENCE FROM "not on this shelf" (WI-21.2).** These
     * books WERE found — by title and author — and their marks DO come across
     * now (WI-21.7); what could not come with them is the ANCHOR, written
     * against another build where the same path addresses different words.
     *
     * Stage 1 refused these marks and this line said "Not placed", which was
     * the honest word for throwing them away. They are kept now, so the
     * sentence says the thing that is true: the reader has their quote and
     * their note, and Paper cannot yet take them to the passage.
     *
     * NAMED, NOT COUNTED, for the same reason `unmatched` is: a reader who
     * loses the marks on a book they were not reading shrugs, and one who loses
     * them on the book they were reading needs to know it was that book. */
    const stranded = plan.unplacedBooks
    /* ⚠️ **WHAT LANDED, for the same reason `marksAdded` is** — this read
     * `plan.unplacedAdded`, the number PLANNED, so a refused write still
     * promised the reader their marks were kept. */
    const kept = unplacedWrites.reduce(
      (sum, one, at) => (unplacedOutcomes[at]?.status === 'fulfilled' ? sum + one.unplaced.length : sum),
      0,
    )
    /* GATED ON WHAT WAS KEPT, not on what was stranded. The two differ exactly
     * when the write was refused, and "0 marks kept without a place" is not a
     * smaller version of this sentence — it is the sentence denying itself.
     * `lostWrites` is what reports that case, and it does it in words. */
    const unplaced =
      kept > 0
        ? ` ${kept} ${kept === 1 ? 'mark' : 'marks'} kept without a place — another edition here: ${nameThem(stranded)}.`
        : ''
    const already = plan.duplicates > 0 ? ` ${plan.duplicates} already here.` : ''
    /* SAID, NOT SWALLOWED: two archived marks that overlapped each other were
       kept as one, and the reader who exported both deserves to hear it. */
    const folded = plan.folded > 0 ? ` ${plan.folded} overlapping ${plan.folded === 1 ? 'mark' : 'marks'} kept as one.` : ''
    notify(
      plan.marksAdded === 0 && plan.cardsAdded === 0 && plan.unplacedAdded === 0
        ? `Nothing to add.${already}${folded}${missed}${unplaced}`
        : marksAdded === 0 && cardsAdded === 0 && kept === 0
          ? /* Everything the plan had was refused. Saying so first is the
               whole point: the qualifier used to trail a claim that
               contradicted it.

               ⚠️ **AND `kept` COUNTS TOWARDS "SOMETHING WAS SAVED"** (WI-21.7).
               An unplaced mark IS saved — stored, listed, exported, synced —
               so a name-matched import with no id-matched rows took this
               branch and read "Nothing was saved. 3 marks kept without a
               place", which is the self-contradiction the comment above says
               this branch exists to prevent, arriving through the third class.
               MEASURED against a real import, on the reader's screen. */
            `Nothing was saved.${lostWrites}${already}${folded}${missed}${unplaced}`
          : marksAdded === 0 && cardsAdded === 0
            ? /* KEPT, AND NOTHING PLACED — `kept > 0`, since the branch above
                 took the case where it is zero. The unplaced sentence is the
                 whole of what happened, so it leads instead of trailing:
                 "Added 0 marks and 0 cards across 0 books" is not a truer
                 opening than "Nothing was saved" was, only a longer one. */
              `${unplaced.trim()}${lostWrites}${already}${folded}${missed}`
            : `Added ${marksAdded} ${marksAdded === 1 ? 'mark' : 'marks'} and ${cardsAdded} ${cardsAdded === 1 ? 'card' : 'cards'} across ${booksTouched} ${booksTouched === 1 ? 'book' : 'books'}.${lostWrites}${already}${folded}${missed}${unplaced}`,
    )
  })().catch((cause: unknown) => {
    /* Everything after the parse settles individually above, so a rejection
     * REACHING here is the read/parse/scan half — the sentence is finally
     * true. A failed `loadAllNow` is caught here too, deliberately: importing
     * against an unknown baseline would re-add every mark in the archive.
     *
     * AND SAID AS ITS OWN CAUSE. It is the reader's own shelf that would not
     * read, not the file they just chose, and "that file could not be read"
     * sends them to replace an archive that is perfectly good. */
    if (cause instanceof MarksScanFailed) {
      console.error('Paper: could not read your marginalia to import against it', cause)
      notify(marksRefusal(cause, library.getSnapshot(), 'imported'))
      return
    }
    /* THE FILE IS GOOD AND THE WHOLE OF IT WAS REFUSED, and "could not be read" would
       send the reader looking for damage. An import is additive, so a file split by
       hand comes in as two. */
    if (cause instanceof ArchiveOverLimit) {
      console.error('Paper: that marginalia is past what one archive can hold', cause)
      notify('That file holds more marks and cards than Paper can read from one file — nothing was imported.')
      return
    }
    console.error('Paper: could not import that marginalia', cause)
    notify('That file could not be read.')
  })
}

  return {
    exportTags: exportTagsNow,
    importTags: importTagsNow,
    exportMarks: exportMarksNow,
    importMarks: importMarksNow,
  }
}
