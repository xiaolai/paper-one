import { createElement } from 'react'
import {
  contentPathIn,
  extractSections,
  readOwnedBook,
  refuseBookScripts,
  storedBookName,
  type Capability,
  type CapabilityContext,
  type Disposable,
  type IndexedBook,
  type PassagesPort,
} from '../../kernel'
import { sweep, type BuildDeps } from './lib/builder'
import { generationOf, wantedFrom } from './lib/freshness'
import { passageIndexOver, type PassageIndex } from './lib/port'
import { theProgress } from './lib/progress'
import { PassagesPane } from './ui/PassagesPane'

/**
 * Searching the whole shelf.
 *
 * A reader asks the library a question and gets passages back, from any of
 * nearly two thousand books, whether or not the book is open — and a hit lands
 * on the words, not near them.
 *
 * ⚠️ **NOTHING IS SENT ANYWHERE TO BUILD IT.** The text comes from books already
 * on this device and the postings are built on this machine. There is no
 * network call in this capability at all, which is a property worth stating
 * because "search" in most products means the opposite.
 *
 * ## The extraction is HERE and not in the plugin, deliberately
 *
 * ⚠️ **ONE CANONICAL WALK, NOT A THIRD COPY.** `reanchor.ts` owns the walk that
 * turns a parsed section into one canonical string, and `reanchorIn` finds a
 * quote in that same form when a hit is landed. Both ends of library search are
 * therefore the same function. A Rust extractor inside the plugin would be a
 * second implementation of it, and the repository has measured what an
 * asymmetry between two such walks costs: `<p>done</p><p>Start</p>` indexed as
 * `doneStart`, *"a silent, total loss of context"* for every passage near a
 * paragraph start — at library scale, across every book.
 *
 * So the boundary is: **this capability says what the text IS, the plugin says
 * where the words ARE.** `ui/reader/passageText.ts` carries the argument in
 * full.
 *
 * ## Desktop only
 *
 * `platforms: ['desktop']` in the manifest, and the crate is behind the
 * `desktop` Cargo feature. A phone is a satchel with no room for a posting list
 * over a library it is receiving, and a browser has no filesystem to keep one
 * in. Both get the Search pane scoped to the open book, which is what the scope
 * switch makes cheap.
 */

/**
 * The port the Settings section draws from.
 *
 * ⚠️ **ONE PORT, MADE ONCE, AND NOT THE ONE `start` BINDS.** The section
 * outlives the composition: it can be drawn after a teardown, when the kernel's
 * slot is null, and a Settings section that answered "nothing is indexed"
 * because the app was being rebuilt would be a panel that empties itself for no
 * reason a reader can see. Every other capability's settings section does the
 * same thing for the same reason, and it costs one closure.
 */
let pane: PassageIndex | null = null
const panePort = (): PassageIndex => (pane ??= passageIndexOver())

/**
 * How long after the library settles before a sweep starts.
 *
 * ⚠️ **NOT ZERO, AND THE REASON IS THE LIBRARY'S OWN SHAPE.** `loadShelf`
 * publishes as it scans, so a 1 962-book launch emits many snapshots in a few
 * seconds; a sweep per snapshot would re-ask `pending()` over the whole shelf
 * each time. It is also the window in which a reader opens a book, and the one
 * thing this must never do is compete with an open.
 */
const SETTLE_MS = 5_000

/** How long a sweep may hold the thread before handing it back. */
const BREATHE_MS = 0

export const passages: Capability = {
  id: 'passages',
  requires: [],

  settings: [
    {
      id: 'passages:library-search',
      title: 'Library search',
      /* After Reading (10) and Voices (14), before Devices (20): searching the
       * library is part of how a reader uses their books, not part of what
       * talks to another machine. A declared number rather than a default, so
       * neither moves when the other changes its mind. */
      order: 16,
      render: () => createElement(PassagesPane, { port: panePort(), progress: theProgress }),
    },
  ],

  start(api: CapabilityContext, signal: AbortSignal): Disposable {
    /* TEARDOWN FIRST, ACQUISITIONS AFTER — the peer capability's posture, for
     * its reason: a `start` that throws halfway must leave nothing running. */
    const held: {
      bound: Disposable | null
      timer: ReturnType<typeof setTimeout> | null
      running: boolean
      /** A library change that arrived while a sweep was running. */
      changed: boolean
      stopped: boolean
    } = { bound: null, timer: null, running: false, changed: false, stopped: false }

    const stop = () => {
      if (held.stopped) return
      held.stopped = true
      if (held.timer !== null) clearTimeout(held.timer)
      held.timer = null
      held.bound?.dispose()
      held.bound = null
      signal.removeEventListener('abort', stop)
    }
    api.onCleanup(stop)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) return { dispose: stop }

    const port = passageIndexOver()
    /* THE KERNEL'S SLOT TAKES THE NARROW PORT. `passage.search` needs `search`
     * and `status`; the write half stays here. See `lib/port.ts`. */
    held.bound = api.services.bindPassages(port satisfies PassagesPort)

    /* ⚠️ **THE SHELF'S NAMES, SO THE UNREADABLE LIST IS SOMETHING A READER CAN
     * ACT ON.** The plugin is handed text and an id and never sees a title —
     * see `lib/progress.ts` for what the panel looked like without this. Read
     * at CALL time from the live snapshot rather than captured, so a book
     * renamed or removed answers the shelf's current answer. */
    theProgress.bindTitles((bookId) =>
      api.services.library.getSnapshot().find((one) => one.bookId === bookId)?.title,
    )

    const deps = buildDeps(api, port, () => !held.stopped)

    /* ⚠️ **A SWEEP IS SCHEDULED, NEVER RUN FROM THE SUBSCRIPTION.** The library
     * publishes once per change and a scan publishes many times; running here
     * would start a sweep per snapshot and each one would re-ask `pending()`
     * over the whole shelf. The timer coalesces them. */
    const schedule = () => {
      if (held.stopped) return
      /* ⚠️ **A CHANGE DURING A SWEEP IS REMEMBERED, NOT DROPPED.** This used to
       * return early while one was running, so a book imported mid-sweep waited
       * for the NEXT library change — which on a shelf nobody is editing is
       * never. The sweep that finishes reschedules itself instead. */
      if (held.running) {
        held.changed = true
        return
      }
      if (held.timer !== null) clearTimeout(held.timer)
      held.timer = setTimeout(() => {
        held.timer = null
        void run()
      }, SETTLE_MS)
    }

    const run = async () => {
      if (held.stopped || held.running) return
      held.running = true
      held.changed = false
      /* WHAT THE SHELF WANTS, published BEFORE the sweep — that is the number a
       * reader needs to read the count against, and reading it afterwards would
       * leave the panel saying "0 of 0" for the whole of the first build. */
      const wanted = deps.wanted().length
      theProgress.set({ ...theProgress.get(), wanted, sweeping: true })
      /* HELD OUTSIDE THE `try`, so the `finally` can say whether the sweep
       * finished. A sweep that threw did not. */
      let finished = false
      try {
        const outcome = await sweep(deps)
        finished = outcome.complete
        api.diagnostics.info('passages.sweep', { ...outcome })
        /* ⚠️ **AN INCOMPLETE SWEEP IS RESCHEDULED, NOT ABANDONED.** It ended
         * because the capability is stopping — in which case `schedule` is a
         * no-op — or because there is more to do than one pass. At 1 959 books
         * a sweep that never resumes is a library that is searchable in part
         * for ever. */
        /* MORE TO DO, or something changed while this ran. Both are reasons to
         * go again, and neither is a reason to spin: `schedule` waits out the
         * settle window, so a shelf that is being edited coalesces rather than
         * sweeping per change. */
        if ((!outcome.complete || held.changed) && !held.stopped) {
          held.running = false
          schedule()
        }
      } catch (cause) {
        /* ⚠️ **A FAILED SWEEP IS REPORTED AND DOES NOT STOP THE NEXT ONE.** The
         * commonest cause is a disk that is momentarily busy, and a backfill
         * that gives up for the session on one of those is a library that
         * silently stops becoming searchable.
         *
         * ⚠️ **AND IT USED TO STOP THE NEXT ONE ANYWAY, BY DOING NOTHING.** The
         * reschedule lived on the success path, so a sweep that threw left no
         * timer — including when a library change had arrived DURING it, which
         * is exactly when there is most to do. Found by an independent audit.
         * Rescheduled here; `schedule` waits out the settle window, so a disk
         * that keeps failing retries every few seconds rather than spinning. */
        api.diagnostics.warn('passages.sweep-failed', { error: messageOf(cause) })
        if (!held.stopped) {
          held.running = false
          schedule()
        }
      } finally {
        held.running = false
        theProgress.set({
          wanted: deps.wanted().length,
          sweeping: false,
          /* ⚠️ **ONLY A COMPLETE SWEEP MEANS "DONE LOOKING", and a sweep that
           * THREW did not finish either.** An interrupted one has not
           * established anything about the books it never reached, and saying
           * otherwise tells a reader the library is fully covered when a fifth
           * of it has not been opened. Once true it stays true: a later sweep
           * over a couple of new books does not put the panel back into "still
           * building" for the whole shelf. */
          swept: theProgress.get().swept || finished,
        })
      }
    }

    /* THE ONLY SIGNAL THERE IS. The library publishes one undifferentiated
     * "the snapshot changed" — there is no per-transition event to listen for —
     * so freshness is a DIFF taken at each settle, which also means a removal
     * that happened while the app was closed is noticed at the next launch. */
    /* ⚠️ **SO "TRY THESE AGAIN" ACTUALLY TRIES.** Clearing a note changes no
     * library, so nothing would have scheduled a sweep — see
     * `ProgressHolder.sweepNow`. */
    theProgress.bindSweep(schedule)

    const unsubscribe = api.services.library.subscribe(schedule)
    api.onCleanup(unsubscribe)
    schedule()

    api.diagnostics.info('passages.started', {})
    return { dispose: stop }
  },
}

/**
 * The builder's dependencies, over the kernel's library and the plugin.
 *
 * Exported for the capability's own tests, which is why it is a function of its
 * inputs rather than a closure inside `start`: the sweep's behaviour is the part
 * worth testing and it needs no composition to reach.
 */
export function buildDeps(
  api: CapabilityContext,
  port: PassageIndex,
  live: () => boolean,
): BuildDeps {
  const booksById = (): Map<string, IndexedBook> =>
    new Map(api.services.library.getSnapshot().map((book) => [book.bookId, book]))

  return {
    wanted: () => wantedFrom(api.services.library.getSnapshot()),
    pending: (books) => port.pending(books),
    indexed: () => port.indexed(),
    forget: async (bookIds) => {
      /* ONE MOMENT FOR THE WHOLE BATCH, read before the loop. Every book in it
       * was found unwanted by the same diff, so they were removed at the same
       * time as far as the index is concerned — and reading the clock per book
       * would make a slow batch's last removal look later than it was, which
       * is the direction that wrongly refuses a restore. */
      const at = Date.now()
      for (const bookId of bookIds) {
        if (!live()) return
        await port.forget(bookId, at)
      }
    },
    indexOne: async (bookId) => {
      const book = booksById().get(bookId)
      /* THE BOOK WENT AWAY BETWEEN THE LIST AND THE WORK. Not an error and not
       * a book that cannot be read — simply gone, and the next sweep's diff
       * will forget it. */
      if (!book) return 'skipped'
      const at = Date.now()
      const generation = generationOf(book)
      try {
        const extracted = await extractBook(api, book, live)
        if (extracted === null) return 'skipped'
        if (extracted.sections.length === 0) {
          /* ⚠️ **RECORDED, NEVER SKIPPED.** Skipped, it comes back in
           * `pending()` every sweep and is re-parsed for ever without ever
           * making progress. Recorded WITH THE GENERATION, it is tried again
           * when its bytes change and left alone until then — which is what the
           * note claimed to do before it carried one. */
          await port.note(bookId, generation, whyEmpty(extracted.unreadable), at)
          return 'unreadable'
        }
        const accepted = await port.put(
          bookId,
          generation,
          extracted.sections.map((one) => ({ index: one.index, text: one.text })),
          at,
        )
        /* THE RACE WI-31.3 NAMES: the book was forgotten while it was being
         * extracted. The plugin refused it, which is right, and the sweep must
         * not count it as done. */
        if (!accepted) return 'skipped'
        /* ⚠️ **A BOOK THAT LOST SOME OF ITS CHAPTERS IS NOT A BOOK THAT WAS
         * INDEXED, AND THIS THREW THAT AWAY.** `extracted.unreadable` was read
         * only when the book yielded NOTHING — so a book with thirty-seven good
         * chapters and three that would not parse was checkpointed as complete,
         * with no warning anywhere, and those three stayed unsearchable at that
         * generation for ever. That is the exact failure WI-31.7 exists to
         * prevent (*"a search that quietly omits a fifth of the library"*),
         * inside one book instead of across the shelf. Found by an independent
         * audit.
         *
         * The book IS indexed — the chapters that read are searchable and that
         * is worth having — and the gap is NAMED beside it. `note` no longer
         * clears the postings when what it records is partial, because there is
         * real coverage to keep; see `Store::note_partial`. */
        if (extracted.unreadable.length > 0 || extracted.truncated.length > 0) {
          /* ⚠️ **OUTSIDE THE DESTRUCTIVE CATCH, OR A FAILED WARNING DELETES THE
           * GOOD CHAPTERS.** A rejected `notePartial` fell into the extraction
           * catch below, which calls `note` — and `note` takes the book OUT of
           * search and records the generation as unreadable, so a disk that was
           * briefly busy destroyed thirty-seven working chapters and suppressed
           * the retry. The book IS indexed by this point; failing to write a
           * warning about it cannot be allowed to undo that. Found by the second
           * audit round. */
          try {
            await port.notePartial(bookId, generation, whyPartial(extracted), at)
          } catch (cause) {
            api.diagnostics.warn('passages.partial-note-failed', {
              book: bookId,
              error: messageOf(cause),
            })
          }
        }
        return 'indexed'
      } catch (cause) {
        /* ⚠️ **A BOOK THAT WILL NOT PARSE IS A FACT ABOUT THE BOOK, and a disk
         * that is busy is not.** Both arrive here, and only the first is worth
         * recording — but telling them apart is not possible from a thrown
         * value, so the honest thing is to record it WITH the message, which
         * `passages_note` shows to the reader verbatim. */
        try {
          await port.note(bookId, generation, `it could not be read: ${messageOf(cause)}`, at)
        } catch (noteFailed) {
          /* ⚠️ **A SWALLOWED NOTE FAILURE REPORTED A TERMINAL OUTCOME FOR WORK
           * NOTHING HAD RECORDED.** `.catch(() => {})` meant a disk that could
           * not be written left the sweep saying `unreadable` with no warning
           * persisted — so the book was neither searchable nor named, and the
           * next sweep would try it again and fail to record it again. Reported
           * as a SKIP instead: nothing was established, so nothing is claimed. */
          api.diagnostics.warn('passages.note-failed', {
            book: bookId,
            error: messageOf(noteFailed),
          })
          return 'skipped'
        }
        return 'unreadable'
      }
    },
    flush: () => port.flush(),
    live,
    breathe: () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, BREATHE_MS)
      }),
  }
}

/** Read a book's bytes and walk its sections. */
async function extractBook(
  api: CapabilityContext,
  book: IndexedBook,
  live: () => boolean,
): Promise<{
  sections: readonly { index: number; text: string }[]
  unreadable: readonly number[]
  truncated: readonly number[]
} | null> {
  const fs = api.services.fs
  /* NO FILESYSTEM IS NOT A BOOK THAT CANNOT BE READ. A host with no vault —
   * which a test composition is — has nothing to extract from, and recording
   * every book as unreadable would be a permanent wrong answer. */
  if (!fs) return null
  const name = storedBookName(book)
  /* ⚠️ **PATHS ARE RESOLVED THE WAY THE APP RESOLVES THEM, NEVER BY STRING.**
   * `storedBookName` handles a replicated record with no `ext` whose EPUB bytes
   * are stored as `.bin`, and `contentPathIn` chooses the extension. A literal
   * `books/<id>/content.epub` misses valid files — `bookVault.ts` records what
   * that guess cost once: *"the guess opened NOTHING and the reader was told
   * the file was missing with the file right there."* */
  const file = await readOwnedBook(fs, contentPathIn(book.bookId, name), name)
  /* LAZY, for the reason `parseBook.ts` loads its parsers lazily: foliate's
   * view module is half a megabyte, and a launch that indexes nothing must not
   * pay for it. `extractSections` itself is a static import — it is the kernel's
   * and is tiny. */
  const { makeBook } = await import('foliate-js/view.js')
  const parsed = await makeBook(file)
  /* ⚠️ **THE SAME STRIP THE READER APPLIES, AND THE INDEX IS THE OTHER HALF OF
   * THE PAIR.** The text indexed here has to be the text the landing searches,
   * and the landing searches a STRIPPED document — so an unstripped extraction
   * indexes script source as prose and shifts nothing the resolver can then
   * find. One walk at both ends means one document at both ends too. */
  refuseBookScripts(parsed as object)
  try {
    const sections = (parsed as { sections?: readonly unknown[] }).sections
    if (!Array.isArray(sections)) return { sections: [], unreadable: [], truncated: [] }
    const walked = await extractSections({
      sections: sections.length,
      documentFor: async (index) => {
        const section = sections[index] as { createDocument?: () => Promise<Document> } | null
        if (!section || typeof section.createDocument !== 'function') return null
        const doc = await section.createDocument()
        return doc.body ?? doc
      },
      live,
      breathe: () => new Promise<void>((resolve) => setTimeout(resolve, BREATHE_MS)),
    })
    /* ⚠️ **AN INTERRUPTED WALK IS NOT RECORDED.** A partial book written to the
     * index as though it were whole is a book whose later chapters are
     * permanently unsearchable with the state file saying it is done. */
    if (!walked.complete) return null
    return {
      sections: walked.sections.map((one) => ({ ...one })),
      unreadable: walked.unreadable,
      truncated: walked.truncated,
    }
  } finally {
    /* ⚠️ **ALWAYS.** `epub.js`, `fb2.js` and `comic-book.js` all define
     * `destroy()` — FB2 creates an object URL PER SECTION — and a pass over two
     * thousand books that never calls it leaks every one of them.
     * `parseBook.ts` records the same finding, having paid for it. */
    ;(parsed as { destroy?: () => void }).destroy?.()
  }
}

/** Why a book yielded nothing, in words the reader is shown verbatim. */
function whyEmpty(unreadable: readonly number[]): string {
  return unreadable.length > 0
    ? `${unreadable.length} ${unreadable.length === 1 ? 'chapter' : 'chapters'} could not be read, and the rest hold no text`
    : 'it holds no text this build could read'
}

/**
 * Why a book is only PARTLY searchable, in words the reader is shown verbatim.
 *
 * Both halves are named because they are different facts with different
 * remedies: a chapter that would not parse may read after a re-import, and a
 * chapter past the size bound never will.
 */
function whyPartial(extracted: {
  readonly unreadable: readonly number[]
  readonly truncated: readonly number[]
}): string {
  const said: string[] = []
  const { unreadable, truncated } = extracted
  if (unreadable.length > 0) {
    said.push(
      `${unreadable.length} ${unreadable.length === 1 ? 'chapter' : 'chapters'} could not be read`,
    )
  }
  if (truncated.length > 0) {
    said.push(
      `${truncated.length} ${truncated.length === 1 ? 'chapter was' : 'chapters were'} too long to index in full`,
    )
  }
  return `${said.join(', and ')} — the rest of the book is searchable`
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export { passageIndexOver } from './lib/port'
export type { PassageIndex } from './lib/port'
