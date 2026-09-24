import { useCallback } from 'react'
import type { IndexedBook } from '../../core/bookIndex'
import { contentPathIn } from '../../core/bookFolder'
import { isMissingFile, readOwnedBook, storedBookName, type VaultFs } from '../../core/bookVault'
import type { PassageHit } from '../../core/ports'
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
  const { fs, books, jumpTo, onProblem } = deps
  return useCallback(
    (hit: PassageHit) => {
      void openPassage(hit, { fs, books, jumpTo, onProblem }).then((outcome) => {
        if (outcome.kind === 'jumped') jumpTo(outcome.place)
        else onProblem(outcome.why)
      })
    },
    [fs, books, jumpTo, onProblem],
  )
}

/* Re-exported so a caller reading this module finds the four landing sentences
   where the landing is used, rather than having to know which reader module
   owns them. */
export { whyNotLanded }
export type { Landing }
