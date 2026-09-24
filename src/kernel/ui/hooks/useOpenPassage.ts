import { useCallback, useEffect, useRef } from 'react'
import type { IndexedBook } from '../../core/bookIndex'
import { contentPathIn } from '../../core/bookFolder'
import { isMissingFile, readOwnedBook, storedBookName, type VaultFs } from '../../core/bookVault'
import type { PassageHit } from '../../core/ports'
import { refuseBookScripts } from '../reader/bookScripts'
import { landPassage, whyNotLanded, type Landing } from '../reader/landPassage'
import type { Place } from '../../core/jumpStack'

/**
 * Turning a library hit into a jump — the reader's half of phase 31.
 *
 * ## ⚠️ THE BOOK IS PARSED, NOT RENDERED, AND `view.search()` IS NEVER CALLED
 *
 * A hit names a section and carries a quote with a little of the text either
 * side. Landing it is `section.createDocument()` on that ONE section and the
 * canonical walk `reanchor.ts` already implements — so a hit in chapter 40 of a
 * book that is not open resolves exactly like one in the open book, and nothing
 * is laid out to do it. `landPassage.ts` carries the whole argument.
 *
 * ## ⚠️ A FAILED LANDING IS REPORTED BY CAUSE, NEVER AS ONE
 *
 * Stale generation, content evicted, quote absent and
 * ambiguous-after-prefix-and-suffix are four different sentences. **"The book
 * changed edition" is the wrong default** — `bookId` identifies the exact bytes,
 * so another edition is normally another book, and same-byte ambiguity is the
 * common case.
 *
 * ## ⚠️ AND A MISSING FILE IS NOT AN UNREADABLE ONE
 *
 * `App.openStored` learnt this the expensive way: a fallback written for
 * *absent* and handed *unreadable* hides the damage it should report. A book
 * whose bytes were evicted after the index was built gets a sentence about
 * eviction; a book whose bytes are there and will not parse gets a different
 * one.
 */

export interface OpenPassageDeps {
  readonly fs: VaultFs | null
  readonly books: readonly IndexedBook[]
  /** Go there. The same one the panels use, so a hit enters the jump stack. */
  readonly jumpTo: (target: Place) => void
  /** Say what went wrong, in the host's own notice. */
  readonly onProblem: (sentence: string) => void
}

/** What resolving one hit ended in — the pure part, so a case can ask directly. */
export type OpenOutcome =
  | { readonly kind: 'jumped'; readonly place: Place }
  | { readonly kind: 'refused'; readonly why: string }

/** The book is not on the shelf any more. */
const GONE = 'That book is no longer on your shelf.'
/** The bytes were deleted from this device after the index was built. */
const EVICTED =
  'That book’s file is not on this device any more, so Paper cannot open it to the passage.'
/** The bytes are there and will not read. */
const UNREADABLE = 'That book is on this device and could not be opened.'
/** There is no vault at all — a host with no filesystem. */
const NO_VAULT = 'This device cannot open books from the library index.'

/**
 * Resolve one hit against the shelf and the vault.
 *
 * Exported and pure-but-for-its-dependencies so every refusal can be driven
 * directly. A component that only reported them through a notice would collapse
 * five outcomes into one string on screen, which is the flattening
 * `librarySearch.ts` records for a `<select>`, wearing another hat.
 */
export async function openPassage(
  hit: PassageHit,
  deps: OpenPassageDeps,
): Promise<OpenOutcome> {
  if (!deps.fs) return { kind: 'refused', why: NO_VAULT }
  const book = deps.books.find((one) => one.bookId === hit.bookId)
  /* THE BOOK LEFT THE SHELF BETWEEN THE ROW BEING DRAWN AND THE ROW BEING
   * CLICKED. The same refusal `goToJump` already makes for a cross-book row. */
  if (!book) return { kind: 'refused', why: GONE }

  const name = storedBookName(book)
  let file: File
  try {
    /* ⚠️ **PATHS THE WAY THE APP RESOLVES THEM, NEVER BY STRING.**
     * `storedBookName` handles a replicated record with no `ext` whose EPUB
     * bytes are stored as `.bin`; a literal `books/<id>/content.epub` misses
     * valid files, which `bookVault.ts` records having cost once. */
    file = await readOwnedBook(deps.fs, contentPathIn(hit.bookId, name), name)
  } catch (cause) {
    /* ⚠️ **ABSENT AND UNREADABLE ARE TWO ANSWERS.** Eviction is the ordinary
     * case here — the index outlives the bytes on purpose — and it has an
     * obvious remedy the reader can act on. Damage does not, and telling them
     * their book was evicted when it is sitting there unreadable sends them to
     * download something they already have. */
    return { kind: 'refused', why: isMissingFile(cause) ? EVICTED : UNREADABLE }
  }

  const { makeBook } = await import('foliate-js/view.js')
  let parsed: { sections?: readonly unknown[]; destroy?: () => void }
  try {
    parsed = (await makeBook(file)) as typeof parsed
    /* ⚠️ **THE SCRIPT STRIP, AND WITHOUT IT THE LANDING ADDRESSES THE WRONG
     * WORDS.** A CFI is a path of CHILD INDICES. The reader's iframe never
     * receives a `<script>` — `refuseBookScripts` wraps `createDocument` at open
     * — so a path derived HERE from an unstripped parse is off by however many
     * scripts precede the passage, and lands on a different sentence with no
     * error anywhere. `reanchor.ts`'s header says exactly this and this file
     * did not do it; found by an independent audit. */
    refuseBookScripts(parsed)
  } catch {
    return { kind: 'refused', why: UNREADABLE }
  }
  try {
    const sections = parsed.sections
    if (!Array.isArray(sections)) return { kind: 'refused', why: UNREADABLE }
    const landing = await landPassage(hit, async (index) => {
      const section = sections[index] as { createDocument?: () => Promise<Document> } | null
      if (!section || typeof section.createDocument !== 'function') return null
      const doc = await section.createDocument()
      return doc.body ?? doc
    })
    if (landing.kind !== 'landed') {
      return { kind: 'refused', why: whyNotLanded(landing) ?? UNREADABLE }
    }
    return { kind: 'jumped', place: { bookId: hit.bookId, cfi: landing.cfi } }
  } finally {
    /* ⚠️ **ALWAYS.** `epub.js`, `fb2.js` and `comic-book.js` all define
     * `destroy()` — FB2 creates an object URL PER SECTION — and a reader who
     * clicks twenty results leaks twenty books without it. `parseBook.ts`
     * records the same finding, having paid for it. */
    parsed.destroy?.()
  }
}

/** The hook the reader's shell mounts. */
export function useOpenPassage(deps: OpenPassageDeps): (hit: PassageHit) => void {
  /* ⚠️ **RESOLVED AGAINST THE CURRENT SHELL, NEVER THE ONE THAT WAS THERE WHEN
   * THE ROW WAS CLICKED.** Opening a hit reads a file and parses a book, which
   * takes long enough for the reader to turn several pages — and `App`'s
   * `jumpTo` is rebuilt whenever `book.position.chapterLabel` moves, which a
   * page turn does. Captured in the callback's dependency list, the landing
   * called the `jumpTo` from the moment of the CLICK: a closure over the old
   * chapter, so the "← Back to …" line named a chapter the reader had already
   * left, and `books` was the shelf as it was rather than as it is. `App` does
   * not unmount when a book is closed, so the teardown below could never reach
   * any of it. Found by an independent audit.
   *
   * A ref updated after every commit, which is the ordinary shape for this: the
   * value read at resolution is the latest one that has rendered, and there is
   * no dependency list left to go stale. It also gives the returned callback a
   * genuinely stable identity, which is what the call site's comment already
   * claimed and did not have — `books` alone changes on every library publish.
   *
   * ⚠️ **AND A PAGE TURN MUST NOT CANCEL THE OPEN.** Invalidating on these
   * changes instead of reading through them would abandon the reader's own
   * request every time a timer published a snapshot. What supersedes a request
   * is another request, which is the identity below. */
  const latest = useRef(deps)
  useEffect(() => {
    latest.current = deps
  })
  /* ⚠️ **WHICH CLICK IS THE CURRENT ONE, AND THERE WAS NO SUCH THING.** Opening
   * a hit reads a file and parses a book, so two clicks race — and every result
   * was applied. Reproduced by an independent audit: click A, click B, land on
   * B, then land back on A when A finishes last. An identity rather than a
   * counter, for the reason phase 30 records: an empty object cannot collide by
   * construction and leaves no arithmetic to be wrong about. */
  const current = useRef<object>({})
  useEffect(
    () => () => {
      /* TEARDOWN INVALIDATES WHATEVER IS IN FLIGHT. A landing that resolves
       * after the whole shell has gone must not try to move anybody. */
      current.current = {}
    },
    [],
  )
  return useCallback((hit: PassageHit) => {
    const mine = {}
    current.current = mine
    void openPassage(hit, latest.current)
      .then((outcome) => {
        if (current.current !== mine) return
        const now = latest.current
        if (outcome.kind === 'jumped') now.jumpTo(outcome.place)
        else now.onProblem(outcome.why)
      })
      .catch((cause: unknown) => {
        /* ⚠️ **AN UNHANDLED REJECTION AND AN INERT CLICK.** `openPassage`
         * guards the file read and the parse, and the dynamic `import()` of
         * foliate sits outside both — so a failed chunk load rejected with
         * nobody listening and the row simply did nothing. Found by an
         * independent audit. */
        if (current.current !== mine) return
        latest.current.onProblem(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])
}

/* Re-exported so a caller reading this module finds the four landing sentences
   where the landing is used, rather than having to know which reader module
   owns them. */
export { whyNotLanded }
export type { Landing }
