import { useLayoutEffect, useState } from 'react'
import type { TocItem } from 'foliate-js/view.js'
import type {
  ReadingSurface,
  ReadyBook,
  SectionTextWalk,
  SpeechSkipPrefs,
  SpokenSection,
} from '../../core/ports'
import { notifyAll } from '../../core/notify'
import { textDigest } from './clipKey'
import { canonicalTextOf } from './passageText'
import { placeSpokenWord, removeSpokenWord } from './rulerBand'
import { collectText, documentLang, offsetIn, placeOfRange, rangeAt, textAtPoint } from './speech'
import { resolveSegmenterLocale } from './wordSnap/classify'
import { sentenceSpansOf } from './wordSnap/sentenceOf'

/**
 * The reader as read-aloud sees it: what `ReadingSurface` promises, over what
 * the app has committed.
 *
 * ⚠️ **EVERYTHING HERE READS WHAT WAS LAST COMMITTED, AND `App` COMMITS IT AFTER
 * ITS CHILDREN.** The host that runs the reading is a child of `App`, and a
 * child's effects run before its parent's. What makes that safe is that React
 * flushes every LAYOUT effect of a commit before any PASSIVE one, whichever
 * component they belong to: `useReadingSurface` writes in a layout effect, and
 * the reading's document effect is passive, so `speakable` already answers for
 * the incoming document when it asks. A child's LAYOUT effect would still see the
 * outgoing one, so none of them may read the surface. Written during render, as
 * these once were, a render React abandoned would leave the surface describing a
 * document the tree never showed (audit round 1, #505).
 *
 * ⚠️ **A SECTION IS A BINDING, NOT A VIEW OF WHATEVER IS ON SCREEN.** Painting,
 * clearing and tap offsets all use the document and the text the section was made
 * from, so an offset from a utterance that began in one section cannot land on
 * the words of another. Skip preferences change the text, so they change the
 * offsets: each `speakable` is a new section, and its taps map through its own
 * text.
 */

/**
 * Which book and which section is on screen, so a render can be addressed.
 *
 * ⚠️ **A WRONG SECTION INDEX COSTS A REDUNDANT RENDER AND NEVER WRONG AUDIO**,
 * which is what makes reading it from the reader's POSITION safe rather than
 * needing the session to answer for the document. The clip's key carries a digest
 * of the section's text as well as its index, so a stale index can only fail to
 * FIND a clip — and a clip it does find under a stale index has the same text
 * digest, which means the same words, which means the right audio.
 */
export interface SpeechPlace {
  /** A content hash, resolved after the first render: null until then. */
  readonly bookId: string | null
  /** The spine index, or null where the place cannot say: see `ClipKey.section`. */
  readonly sectionIndex: number | null
}

/**
 * Moving through the book.
 *
 * `next` is one page forward in READING order, not `goRight`, because the voice
 * is always ahead of where it was, and in a right-to-left book ahead is to the
 * left. The session's own `next` is exactly this and is what the arrow key runs.
 */
export interface SurfacePaging {
  readonly next: () => unknown
  /**
   * One page BACK in reading order.
   *
   * ⚠️ **ADDED FOR PHASE 34, AND ITS ABSENCE WAS A DEFECT FROM THE MOMENT SEEKING
   * LANDED — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** Every seek can go
   * backward, and with no way back the word being spoken was classified `behind`
   * and the reading carried on off the top of the page.
   */
  readonly prev: () => unknown
  /**
   * A whole chapter away, or absent where the book cannot say.
   *
   * ⚠️ **ABSENT, AND THE TRANSPORT HIDES THE BUTTON RATHER THAN DRAWING A DEAD
   * ONE.** It needs the TOC and the reader's place in it (`stepChapter` in
   * `tocOrder.ts` over `position.chapterHref`), and a book whose current spine
   * item no contents entry points at genuinely has no next chapter to offer.
   *
   * ⚠️ **`go` ANSWERS WHETHER IT MOVED.** A step that declines must not tear down
   * a pending sentence gap: see `useSpeech`'s `stepChapter`.
   */
  readonly chapter?: { can(by: 1 | -1): boolean; go(by: 1 | -1): boolean }
}

/** What a `ReadyBook` is made of, from `useBook`. */
export interface BookFacts {
  /** Which opening this is: what binds a walk to one book. See `readyBookOf`. */
  readonly generation: number
  readonly bookId: string | null
  readonly doc: Document | null
  readonly meta: { readonly title?: string | null; readonly author?: string | null } | null
  readonly toc: readonly TocItem[]
  readonly fixedLayout: boolean
  readonly sectionTexts: (
    toc: readonly TocItem[],
    shouldStop: () => boolean,
    skip: SpeechSkipPrefs,
  ) => Promise<SectionTextWalk>
}

/** One commit's worth of the reader. */
export interface SurfaceSource {
  readonly doc: Document | null
  readonly place: SpeechPlace
  readonly paging: SurfacePaging
  readonly book: BookFacts
}

/** The surface, and what only its owner may do with it. */
export interface SurfaceDriver {
  readonly surface: ReadingSurface
  /** Take a commit's values. Called from a layout effect, and nowhere else. */
  commit(source: SurfaceSource): void
  /** Whether anything holds the pace. A snapshot for `useSyncExternalStore`. */
  paceHeld(): boolean
  subscribePace(listener: () => void): () => void
}

/**
 * A walk that answers for one opening of one book.
 *
 * ⚠️ **THE NAVIGATOR BEHIND `sectionTexts` IS WHICHEVER BOOK IS OPEN NOW**, and
 * `useAudiobook` holds what it was given across a walk of minutes. So a book
 * replaced during an export could have its text filed under the old book's title
 * and voice. Past its generation this walks nothing and says it is not complete,
 * which is the answer the export already refuses by name.
 *
 * ⚠️ **READY MEANS A DOCUMENT, NOT AN ID.** The book's id resolves from the bytes
 * BEFORE the book is parsed, so gating on it alone offered, for the first moments
 * of every opening, an export whose walk had no navigator to ask. `doc` is
 * published only after the session has handed over its navigator.
 */
export function readyBookOf(facts: BookFacts, current: () => number): ReadyBook | null {
  if (!facts.bookId || !facts.doc) return null
  const live = () => current() === facts.generation
  return {
    bookId: facts.bookId,
    title: facts.meta?.title ?? 'Audiobook',
    author: facts.meta?.author ?? '',
    lang: documentLang(facts.doc),
    toc: facts.toc,
    /* A PDF, or an EPUB of fixed pages: the export refuses one, and says so. Read
       from the view rather than guessed from the file's extension: see
       `SessionCallbacks.onFixedLayout`. */
    fixedLayout: facts.fixedLayout,
    sectionTexts: async (shouldStop, skip) => {
      if (!live()) return { sections: [], complete: false }
      const walk = await facts.sectionTexts(facts.toc, () => shouldStop() || !live(), skip)
      return live() ? walk : { ...walk, complete: false }
    },
  }
}

/** The one section `speakable` makes: a document, a text, and nothing else. */
function sectionOver(
  doc: Document,
  place: SpeechPlace,
  skip: SpeechSkipPrefs,
  live: () => boolean,
): SpokenSection {
  const spoken = collectText(doc, skip)
  const lang = documentLang(doc)
  return {
    /* Empty until the hash resolves, as a clip's key always was. */
    bookId: place.bookId ?? '',
    sectionIndex: place.sectionIndex,
    lang,
    text: spoken.text,
    /* THE LOCALE IS RESOLVED, NOT PASSED THROUGH. `sentenceSpansOf` constructs an
     * `Intl.Segmenter` with it, and a book may declare anything at all in
     * `dc:language`: `resolveSegmenterLocale` already answers which tags are safe
     * to build one from, and `undefined` is its answer for a book that declares
     * none, which the segmenter reads as "let each sentence speak for itself by
     * script". */
    sentences: sentenceSpansOf(spoken.text, resolveSegmenterLocale(lang)),
    blocks: spoken.blocks,
    /* ⚠️ **OVER `indexText`'s CANONICAL FORM AND NOT OVER `text`.** It is the same
     * walk phase 31 indexes, so the audio key and the search index cannot disagree
     * about what a section says, and a skip choice cannot change it. The digest of
     * `text` itself is the engine port's to compute: see `SpeechRequest.clip`. */
    digest: textDigest(canonicalTextOf(doc)),
    live,
    paintWord(start, length) {
      if (!live()) return null
      const range = rangeAt(spoken, doc, start, length)
      if (!range) return null
      const placed = placeOfRange(range, doc)
      if (!placed) return null
      // Viewport coordinates, unadjusted: `placeSpokenWord` converts into body's
      // space, which is invariant under scrolling.
      placeSpokenWord(doc, placed.box)
      return placed.place
    },
    clearWord() {
      if (live()) removeSpokenWord(doc)
    },
    onTap(listener) {
      const onClick = (event: MouseEvent) => {
        if (!live()) return
        /* ⚠️ **FOUR THINGS A CLICK CAN BE THAT ARE NOT A REQUEST TO MOVE THE
           VOICE**: something else took it, it was not the plain main button, it
           landed on a link (a footnote keeps its own meaning), or it ended a
           selection the reader was making. */
        if (event.defaultPrevented || event.button !== 0) return
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
        const target = event.target as Element | null
        if (target && typeof target.closest === 'function' && target.closest('a')) return
        const selection = doc.defaultView?.getSelection()
        if (selection && !selection.isCollapsed) return
        const at = textAtPoint(doc, event.clientX, event.clientY)
        if (!at) return
        /* NULL IS A REAL ANSWER: a tap on text the voice does not read (a hidden
           note, a caption `collectText` skips) has nowhere in the sound to go. */
        const offset = offsetIn(spoken, at.node, at.offset)
        if (offset === null) return
        listener(offset)
      }
      doc.addEventListener('click', onClick)
      return () => doc.removeEventListener('click', onClick)
    },
  }
}

/** Listeners, and the one way of telling them. */
function listenerSet(what: string) {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    tell() {
      notifyAll(listeners, what)
    },
  }
}

export function createReadingSurface(initial: SurfaceSource): SurfaceDriver {
  let source = initial
  const generation = () => source.book.generation
  let book = readyBookOf(initial.book, generation)
  let holders = 0

  const chapterMoved = listenerSet('chapter availability')
  const bookMoved = listenerSet('ready book')
  const paceMoved = listenerSet('reading pace')

  const can = (by: 1 | -1) => source.paging.chapter?.can(by) ?? false

  const surface: ReadingSurface = {
    speakable(skip) {
      const doc = source.doc
      if (!doc) return null
      return sectionOver(doc, source.place, skip, () => source.doc === doc)
    },
    turn(by) {
      if (by === 1) source.paging.next()
      else source.paging.prev()
    },
    chapter: {
      can,
      go: (by) => source.paging.chapter?.go(by) ?? false,
      subscribe: chapterMoved.subscribe,
    },
    book: () => book,
    subscribeBook: bookMoved.subscribe,
    holdPace() {
      holders += 1
      if (holders === 1) paceMoved.tell()
      let held = true
      return () => {
        if (!held) return
        held = false
        holders -= 1
        if (holders === 0) paceMoved.tell()
      }
    },
  }

  return {
    surface,
    commit(next) {
      const before = source
      const couldBack = can(-1)
      const couldForward = can(1)
      source = next
      /* ⚠️ **THE BAND GOES WITH THE DOCUMENT, HERE AND NOT IN THE READING.** Once
         a section is not live its calls do nothing, so nothing holding it could
         take its own word out afterwards. */
      if (before.doc !== next.doc) removeSpokenWord(before.doc)
      if (before.book !== next.book) {
        book = readyBookOf(next.book, generation)
        bookMoved.tell()
      }
      if (can(-1) !== couldBack || can(1) !== couldForward) chapterMoved.tell()
    },
    paceHeld: () => holders > 0,
    subscribePace: paceMoved.subscribe,
  }
}

/**
 * The surface over what this component renders.
 *
 * ⚠️ **ONE OBJECT FOR THE COMPONENT'S LIFE, BECAUSE A HOST HOLDS IT ACROSS
 * BOOKS.** What changes is what it reads, and a `SpokenSection` is what binds a
 * reading to one document.
 */
export function useReadingSurface(source: SurfaceSource): SurfaceDriver {
  const [driver] = useState(() => createReadingSurface(source))
  /* COMMITTED, NOT ASSIGNED DURING RENDER: see the header. No dependency list, as
     `useSpeech`'s own refs have none: a fresh `paging` object per render is the
     ordinary case, and comparing it would be slower than taking it. */
  useLayoutEffect(() => driver.commit(source))
  return driver
}
