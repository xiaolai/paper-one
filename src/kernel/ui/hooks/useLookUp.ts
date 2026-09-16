import { useMemo } from 'react'
import type { GlossProvider } from '../../core/gloss'
import { answerLabel, answerLanguages, type AnswerChoice } from '../../core/glossLanguage'
import type { Lookups } from '../../core/lookupStore'
import type { LookupEntry } from '../../core/lookups'
import { messageOf } from '../../core/messageOf'
import type { Diagnostics } from '../../core/ports'
import { decideLookUp, lookUpPress, type LookUpAction } from '../lookUp'
import type { SelectionSnapshot } from '../reader/session'
import { askGloss, useGloss, type GlossState } from './useGloss'

/**
 * Look up, as ONE state the whole app reads (phase 17, WI-17.2).
 *
 * `useGloss` was called inside `Reader`, and Marginalia is a pane rendered
 * outside it — so the Dictionary view could not see a live lookup at all, and
 * the palette and the keyboard could not start one. This hook lives in `App`,
 * above both, and everything that shows or starts a lookup reads it: the
 * selection popup's lookup face, the Dictionary chip's live entry, the palette
 * row, the shortcut and Escape.
 *
 * ## What it adds to the gloss
 *
 * - THE ANCHOR, including the selection. The answer is drawn in the selection
 *   popup, so a gloss that outlived its selection would reappear over the next
 *   passage the reader chose. See `GlossAnchor`.
 * - THE LANGUAGE, resolved at the press from the reader's choice, the app's
 *   locale and the passage's own `lang` (WI-17.5).
 * - THE RECORDING. Every definition that arrives is filed in the lookup history
 *   (WI-17.1) under the book, anchor and chapter of the press that asked for it.
 *
 * ## What it deliberately cannot do
 *
 * OPEN A PANE. Phase 17's rule: opening the pane re-lays-out the book and moves
 * the word the reader is looking at. This hook takes no dispatch, so there is no
 * route from a lookup to a pane — the one navigation it knows is `onInstall`,
 * which the READER presses, and which the host owns.
 */

/** Where the reader is, for the anchor and the record. Null when not reading. */
export interface LookUpReading {
  readonly bookId: string
  readonly title: string
  /** The book's declared languages — the fallback for a passage with no `lang`. */
  readonly languages: readonly string[]
  readonly fixedLayout: boolean
  readonly chapterLabel: string
  /* The four the anchor is built from — see `GlossAnchor`. */
  readonly generation: number
  readonly sectionIndex: number | null
  readonly chapterHref: string
  readonly navigation: number
}

export interface LookUpOptions {
  readonly provider: GlossProvider
  readonly selection: SelectionSnapshot | null
  readonly reading: LookUpReading | null
  readonly choice: AnswerChoice
  /** The app's locale — `navigator.language`. */
  readonly readerLocale: string | undefined
  /** Where answered lookups are filed. Null files nothing. */
  readonly lookups: Pick<Lookups, 'record'> | null
  readonly diagnostics?: Diagnostics | undefined
  /** Open the settings section a model is installed from. Absent: nowhere to go. */
  readonly onInstall?: ((section: string) => void) | undefined
  /** Injected so a test can pin the time a lookup is filed at. */
  readonly now?: (() => number) | undefined
}

export interface LookUp {
  readonly state: GlossState
  readonly action: LookUpAction
  /**
   * Look the selection up — or null when there is nothing to do it with, or
   * nothing selected. One handler for the button, the palette row and the key,
   * so the three cannot disagree about whether a press does anything.
   */
  readonly press: (() => void) | null
  /** Put it away. */
  readonly dismiss: () => void
  readonly onInstall: ((section: string) => void) | undefined
}

export function useLookUp({
  provider,
  selection,
  reading,
  choice,
  readerLocale,
  lookups,
  diagnostics,
  onInstall,
  now = Date.now,
}: LookUpOptions): LookUp {
  /* THE ANCHOR — see `GlossAnchor` for every field. The selection's CFI rather
     than the snapshot's identity: the session republishes an equal selection as
     a new object (a keyup does, which is how the shortcut's own key release
     would have dismissed the lookup it had just started). */
  const anchor =
    reading === null || selection === null
      ? null
      : [
          reading.generation,
          /* `join` writes a null section as nothing, which is the answer wanted. */
          reading.sectionIndex,
          reading.chapterHref,
          reading.navigation,
          selection.sectionIndex,
          selection.cfi,
        ].join('|')
  const gloss = useGloss(provider, anchor)
  const { ask } = gloss
  const action = decideLookUp(provider.available, provider.installAt !== null && onInstall !== undefined)

  /* THE FIELDS A PRESS READS, NOT THE OBJECT THEY ARRIVE IN. `App` builds
     `reading` afresh on every render, so a press keyed on it — and on `gloss`,
     a fresh object every render too — was a new function on every render, and
     so was the lookup this hook returns, which the palette's memo and the
     keyboard map's effect both list (2026-09-13 audit). Keyed on the values, the
     press changes when one of them does and at no other time. */
  const place = useMemo(
    () =>
      reading === null
        ? null
        : {
            bookId: reading.bookId,
            chapterLabel: reading.chapterLabel,
            title: reading.title,
            fixedLayout: reading.fixedLayout,
            /* The one declared language a press reads — the fallback below. */
            bookLanguage: reading.languages[0],
          },
    [reading?.bookId, reading?.chapterLabel, reading?.title, reading?.fixedLayout, reading?.languages[0]],
  )

  /* THE PRESS EXISTS ONLY WHERE THERE IS SOMETHING TO LOOK UP — a selection, in
     a book being read — so its handler closes over values known to be there,
     rather than testing for them again on every press. */
  const press = useMemo(
    () =>
      place === null || selection === null
        ? null
        : lookUpPress(action, () => {
            /* EVERYTHING THE RECORD NEEDS IS TAKEN NOW, at the press — see
               `AskGlossContext.onAnswer`. */
            const { cfi } = selection
            askGloss({ ask }, selection, {
              fixedLayout: place.fixedLayout,
              diagnostics,
              bookTitle: place.title,
              answerIn: (locale) => answerLanguages(choice, { reader: readerLocale, book: locale ?? place.bookLanguage }),
              onAnswer: (answer) => {
                if (lookups === null) return
                fileLookUp(
                  lookups,
                  {
                    bookId: place.bookId,
                    cfi,
                    chapter: place.chapterLabel,
                    spelled: answer.term,
                    sentence: answer.sentence,
                    gloss: answer.text,
                    language: answerLabel(answer.answerIn),
                    at: now(),
                  },
                  diagnostics,
                )
              },
            })
          }),
    [action, place, selection, ask, diagnostics, choice, readerLocale, lookups, now],
  )

  return useMemo(
    () => ({ state: gloss.state, action, press, dismiss: gloss.dismiss, onInstall }),
    [gloss.state, gloss.dismiss, action, press, onInstall],
  )
}

/**
 * File an answered lookup, and say why when it does not land.
 *
 * LET GO: the definition is on screen whatever the history does, and an
 * unhandled rejection is not an answer to anything. A refused WRITE is what the
 * store's `persistent` flag reports, and the Dictionary view draws it.
 *
 * ⚠️ **BUT NOT SWALLOWED, WHICH IT WAS.** The rejection went to an empty
 * `catch`, and the flag cannot carry a cause — it says the history is not
 * saving and never why — while a failure before the write, a clock or a store
 * that threw, does not move the flag at all. So the cause is filed with the
 * diagnostics, GUARDED, because `Diagnostics` has no no-throw contract and a
 * throw in a rejection handler is an unhandled rejection of its own (2026-09-13
 * audit).
 */
function fileLookUp(lookups: Pick<Lookups, 'record'>, entry: LookupEntry, diagnostics: Diagnostics | undefined): void {
  void lookups.record(entry).catch((cause: unknown) => {
    try {
      /* Stryker disable next-line OptionalChaining: with no sink the property
         read throws inside this same `try`, whose `catch` drops it exactly as an
         absent sink drops the report — nothing can tell the two apart. */
      diagnostics?.warn('lookups.record-failed', { message: messageOf(cause) })
    } catch {
      /* Nothing to report it to — see above. */
    }
  })
}
