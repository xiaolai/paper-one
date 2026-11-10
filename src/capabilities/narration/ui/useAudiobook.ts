import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { messageOf } from '../../../kernel'
import type { ReadyBook, SpeechSkipPrefs } from '../../../kernel'
import { ExportCancelled, exportAudiobook, planChapters } from '../lib/audiobook'
import { narrationPlatform, pickDestination, releaseDestination, type NarrationEngine } from '../lib/wire'
import type { AudiobookControl } from '../lib/running'
import { engineVoiceFor, missingPackNotice, packVoiceOf, qualify } from '../lib/engineVoice'

/**
 * Exporting the open book, from the command palette.
 *
 * ⚠️ **THE VOICE IS THE ONE THE READER HEARS, AND THAT IS THE POINT OF PICKING
 * IT HERE RATHER THAN ASKING AGAIN.** `voiceFor` is the same function
 * `Speaker.speak` calls with the same stored choice, so a book exported after a
 * reader has set their voice sounds like the book they were listening to. A
 * second picker in the export dialog would be a second answer to a question
 * already settled — and the first time the two disagreed, nobody would know
 * which one had produced the file.
 *
 * ⚠️ **AND A BOOK WITH NO USABLE VOICE IS REFUSED RATHER THAN EXPORTED IN
 * WHATEVER THE PLATFORM HAS.** Reading aloud may fall through to the platform's
 * default, which is a reasonable thing to do for a few paragraphs the reader is
 * listening to and can stop. A twenty-minute render that produces a book in an
 * unexpected voice is not the same bargain.
 */

/**
 * The book being exported, and which of its words count.
 *
 * ⚠️ **`fixedLayout` IS REQUIRED, ON `ReadyBook`**, so a caller has to say which it
 * has. Defaulted to false it would read as "reflowable" for a caller that never
 * considered the question, which is the shape of the defect `run` refuses.
 */
export interface AudiobookSource extends ReadyBook {
  /**
   * What the READING skips, so the export skips the same.
   *
   * ⚠️ **NOT DEFAULTED HERE.** `collectText` has a default and taking it would
   * give the export its own opinion about whether a note body is spoken, so a
   * reader who turned notes on would hear them and not find them in the file.
   */
  readonly skip: SpeechSkipPrefs
}

export interface AudiobookDeps {
  readonly source: AudiobookSource | null
  readonly chosen: Readonly<Record<string, string>>
  readonly rate: number
  /**
   * The downloadable voices, or null where there are none to render with — and
   * then there is no export to offer.
   *
   * ⚠️ **THE PACKS ARE ASKED FOR WHEN AN EXPORT STARTS, NOT HANDED IN.** The
   * catalogue is the only voices an export can use, and a list captured at
   * render would be the one from before the reader's last download.
   *
   * ⚠️ **`findClip` AND `holdClips` CANNOT BE DEFAULTED, AND HERE THEY CANNOT
   * BE ABSENT.** They are the half of WI-34.4 that makes exporting a book the
   * reader has listened to cost only the muxing; an engine that is present
   * carries both.
   */
  readonly engine: NarrationEngine | null
  /** One line to the reader, on the notice line. */
  readonly say: (text: string) => void
}

export function useAudiobook(deps: AudiobookDeps): AudiobookControl | null {
  const [running, setRunning] = useState(false)
  /** The synchronous claim — see `run`. `running` is what the controls render. */
  const inFlight = useRef(false)
  /* A REF, not state: it is read inside the export loop between chapters, and a
   * captured `running` would be the value at the moment the export started.
   *
   * RESET IN ONE PLACE, the `finally` in `run`. It is only ever set while an
   * export is in flight, and that `finally` clears it with the claim — so every
   * export starts with it false, and a second reset at the start would be a line
   * no test could tell from its absence. */
  const stop = useRef(false)
  /**
   * Gives the picked destination back now — a no-op until one is picked.
   *
   * ⚠️ **A STOP DURING THE JOIN USED TO WAIT FOR THE JOIN, AND THE JOIN THEN
   * WROTE OVER THE READER'S FILE.** The token was released only in the
   * `finally`, after `package` had returned, so the plugin's commit never saw
   * the release and moved the book onto the name the reader chose. Released
   * when the stop lands, the commit refuses and whatever was there survives.
   */
  const letGo = useRef<() => void>(() => {})

  const { source, chosen, rate, engine, say } = deps

  /**
   * ⚠️ **A BOOK CLOSED DURING THE JOIN USED TO BE WRITTEN ANYWAY, OVER WHATEVER
   * THE READER HAD AT THAT NAME.** `cancelled` asks `live()` only between steps,
   * and the join is one step of minutes, so nothing gave the destination back
   * until it returned — after the plugin's commit had moved the book onto the
   * reader's file. The book going is now the reader's stop: the token goes back
   * as it happens, and the commit refuses it, as `letGo` records for a stop.
   *
   * `live()`, NOT IDENTITY: a chapter turn hands in a new book of the same
   * opening, which is still live and must not end the export. The book leaving
   * is the one whose cleanup runs. `letGo` does nothing while no destination is
   * held, so an export not yet at the dialog, or none at all, is not touched.
   */
  useEffect(
    () => () => {
      if (source && !source.live()) letGo.current()
    },
    [source],
  )

  /**
   * ⚠️ **ONE LONG FUNCTION, AND THAT IS THE DECISION RATHER THAN THE DEBT.** An
   * audit asked for this to be split — locking, cancellation, validation,
   * extraction, path selection, orchestration, progress and error presentation —
   * and argued the concentration caused the lifecycle defects around it. Three of
   * those defects were real and are fixed; the diagnosis is still worth
   * answering, because the fix it proposes would make the next one harder to see.
   *
   * What this body IS, is one linear sequence with a refusal at each step and
   * nothing that loops back: claim, pick a voice, read the book, plan, ask for a
   * path, export, report. Every branch is an early return. The two pieces of
   * state that matter — `inFlight.current` and `stop.current` — are claimed at
   * the top and released in exactly one `finally`, and the whole of their
   * lifetime is on one screen. Splitting it into `claim()`, `read()`,
   * `choosePath()` and `orchestrate()` would spread that lifetime across four
   * functions and a shared mutable ref, which is the shape the defects it names
   * came from in the first place: `running` used as a lock was a lifecycle fact
   * held in one place and read in another.
   *
   * So the length is accepted and the reason is written down. What would change
   * it is a second caller for any step — none exists, and a function extracted
   * for one caller is a name, not a boundary.
   */
  const run = useCallback(() => {
    /**
     * ⚠️ **`running` IS A RENDER SNAPSHOT, NOT A LOCK, AND IT WAS USED AS ONE.**
     * Two calls before React commits `setRunning(true)` both read `false` and both
     * start an export — sharing one `stop` flag, so either can cancel the other,
     * and until each got its own scratch directory they deleted each other's
     * chapters too. A palette row and an accelerator firing together is enough.
     *
     * The claim has to be synchronous, so it is a ref. `running` stays as the
     * thing the CONTROLS read, which is what state is for.
     */
    if (inFlight.current) {
      /* The same command stops it — see the capability's `commands`. Nothing is awaited here:
       * the loop notices between chapters and unwinds itself. */
      stop.current = true
      letGo.current()
      say('Stopping the export after this chapter…')
      return
    }
    if (!source || !engine) return
    /**
     * ⚠️ **A BOOK OF FIXED PAGES IS NOT EXPORTED AT ALL — the owner's decision,
     * 2026-09-21.**
     *
     * A chapter here is a spine section, and a PDF's sections are its PAGES. So
     * the export wrote one chapter per page: page seven came out as "Chapter 7"
     * wherever the contents did not name it, which is a claim about the book
     * that is not true — the thing `planChapters` says numbering must never do.
     * Folding unnamed sections into the one before them would make a PDF
     * exportable, and it was offered; giving the format up is what was chosen,
     * so this refuses rather than approximating a book of pages.
     *
     * Refused HERE, where the reader is told why, rather than by leaving the
     * command out: an absent row for the book in front of them is a question
     * with no answer. The same shape as the voice refusal below.
     */
    if (source.fixedLayout) {
      say('A book of fixed pages cannot be exported as an audiobook — its pages are not chapters.')
      return
    }

    inFlight.current = true
    void (async () => {
      setRunning(true)
      try {
        const packs = await engine.catalogue()
        /* ⚠️ **A DOWNLOADED VOICE IS ASKED FOR FIRST, AND IT SETTLES BOTH
         * REFUSALS BELOW.** The floor refuses every platform voice below
         * Enhanced, which on a Mac is all of them — so before this the export
         * was simply off there. A pack is not subject to that rule, and it
         * also has no `platform` case: it names a voice or it does not, where
         * the WebView's list can be empty or the book language-less and a
         * render needs a voice NAMED. */
        const downloaded = engineVoiceFor(packs, source.lang, chosen)
        /* ⚠️ **`packVoiceOf`, NOT A SECOND `find` OF ITS OWN.** This looked the
         * pack up inline, with a `?.family ?? ''` for a row that cannot be
         * missing — `engineVoiceFor` draws the id it answers with FROM these
         * packs — so the fallback was a value no test could ever see and the
         * lookup was the same rule written twice. One lookup, beside the
         * chooser, is what `engineVoice.ts` keeps `packVoiceOf` for. */
        const named = downloaded && packVoiceOf(packs, downloaded)
        const engineVoice = named ? qualify(named.pack.family, named.voice.id) : null
        /* ⚠️ **A DOWNLOADED VOICE IS THE ONLY ONE THAT CAN RENDER NOW.**
         * `narrate_render` over AVSpeechSynthesizer was deleted in phase 30:
         * every voice it reached on a Mac is below the floor the reading
         * refuses, so it could not produce a file anybody would want. The
         * platform's list is still consulted, but only to tell the two
         * refusals apart — a book whose language no pack reads, and one this
         * app would refuse to read at all. */
        if (engineVoice === null) {
          /* ⚠️ **THE REFUSALS SAY WHAT WOULD FIX THEM, AND THEY CHANGED SHAPE
           * IN PHASE 30.** They used to be about the platform's own voices and
           * the floor over them; with `narrate_render` deleted, the only
           * question is whether a pack reads this book's language. Each answer
           * is something a reader can act on, or plainly says it is not. */
          const language = source.lang?.trim() ?? ''
          say(
            language === ''
              ? 'This book does not say what language it is in, so no voice can be chosen for it.'
              : (missingPackNotice(packs, source.lang) ??
                'No downloadable voice reads this book’s language yet.'),
          )
          return
        }

        /* The engine-qualified name — the same string the reading stores, so
         * one choice serves both. */
        const voice = engineVoice

        say('Reading the book…')
        /* THE STOP GOES IN, rather than being checked only on the way out. A long
           book is seconds of parsing per section, so "Stopping…" used to sit on
           screen through hundreds of them. */
        const walk = await source.sectionTexts(() => stop.current, source.skip)
        if (stop.current) throw new ExportCancelled()
        /* ⚠️ **AN INCOMPLETE WALK IS REFUSED, NOT EXPORTED.** `sectionTexts` stops
         * when the book closes or is replaced, and it used to return a bare array
         * — so a book closed mid-read was written out as a FINISHED audiobook
         * missing everything after the section it got to. A short file is
         * indistinguishable from a short book, which is the trap `narrate`
         * records for an empty buffer mid-stream. */
        if (!walk.complete) {
          say('The book stopped being readable part way through — nothing was exported.')
          return
        }
        const chapters = planChapters(walk.sections)
        if (chapters.length === 0) {
          say('This book has no text to read aloud.')
          return
        }

        const destination = await pickDestination(source.title)
        /* ⚠️ **THE DIALOG IS ASKED AFTER THE BOOK IS READ, DELIBERATELY.** A
         * reader who picks a file name and is then told the book has nothing to
         * read has been made to do work for an answer that was already known. */
        if (!destination) return
        /* ONCE, whichever comes first: the stop, or the way out below. */
        let given: Promise<void> | null = null
        const giveBack = (): Promise<void> =>
          (given ??= releaseDestination(destination.token).catch(() => {}))
        letGo.current = () => {
          void giveBack()
        }

        try {
          const platform = await narrationPlatform(packs, engine)
          const result = await exportAudiobook(platform, {
            chapters,
            voice,
            rate,
            title: source.title,
            author: source.author,
            bookId: source.bookId,
            destination: destination.token,
            onProgress: (done, total, title) => {
              say(
                done >= total
                  ? 'Joining the chapters…'
                  : `Reading ${title} — ${done + 1} of ${total}…`,
              )
            },
            /* ⚠️ **AND THE BOOK GOING IS A STOP TOO.** This asked only for the
               reader's stop, so opening another book mid-export went on
               rendering the old one for minutes and then wrote its file.
               `manual-run-5.2.md` step 8 asks for a refusal with no file
               written; `live` is the same answer the walk above stops on. */
            cancelled: () => stop.current || !source.live(),
          })
          say(
            `Exported ${result.chapters} chapters, ${Math.round(result.durationMs / 60_000)} minutes, to ${result.name}.` +
              skippedNote(result.skipped) +
              leftBehindNote(result.leftBehind),
          )
        } finally {
          /* ⚠️ **THE TOKEN IS GIVEN BACK ON EVERY ROAD OUT.** The plugin holds a
             bounded number of picked destinations, so one left behind by a failed
             or stopped export is a place the next pick cannot have. A release
             that fails is not the reader's news: the export's own outcome is. */
          letGo.current = () => {}
          await giveBack()
        }
      } catch (cause) {
        if (cause instanceof ExportCancelled) {
          /* ⚠️ **THIS SAID "Nothing was left behind." UNCONDITIONALLY**, while
             `exportAudiobook` swallowed every tidy-up failure — so the one
             sentence a reader would act on was the one thing nobody had checked.
             A chapter of a ten-hour book is tens of megabytes. It is counted now,
             and the claim is only made when it is true. */
          /* ⚠️ **A STOP CAN COME TOO LATE TO UNDO THE FILE, AND THE READER USED TO
           * BE TOLD NOTHING ABOUT IT — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.**
           * The join cannot be interrupted, so a stop during it lands after the
           * packer has written the destination. Where that destination held an
           * earlier audiobook, removing the result would leave the reader with
           * NEITHER — so it is kept, and this is the sentence that says so. Without
           * it the notice claimed *"Nothing was left behind"* over a file that had
           * replaced one of theirs. */
          if (cause.book === 'replaced') {
            say(
              `The export was stopped, but the book had already been written over the file you chose.${leftBehindNote(cause.leftBehind)}`,
            )
            return
          }
          /* THE BOOK ITSELF, NAMED AS THE BOOK. A removal the plugin refused
             leaves the audiobook at the name the reader typed, and calling it a
             temporary file would send them looking in the wrong place. */
          if (cause.book === 'stuck') {
            say(
              `The export was stopped, but the book it had written could not be removed from where you chose.${leftBehindNote(cause.leftBehind)}`,
            )
            return
          }
          /* Read before the `finally` clears it: a stop the reader asked for is
             theirs, and one with no stop asked for is the book having gone. */
          const why = stop.current ? 'The export was stopped.' : 'The export stopped because the book was closed.'
          say(`${why}${leftBehindNote(cause.leftBehind) || ' Nothing was left behind.'}`)
          return
        }
        /* THE ENGINE'S OWN SENTENCE. Every refusal in `narrate` names what it
         * refused and why — a stalled voice, a chapter with no audio, a book too
         * long for the format — and replacing them with "the export failed"
         * would throw away the only thing that tells a reader what to do. */
        say(`The export failed: ${messageOf(cause)}`)
      } finally {
        stop.current = false
        inFlight.current = false
        setRunning(false)
      }
    })()
    /* NO `running` HERE. It is not read — the claim is `inFlight.current`, which
       is the whole point of that ref — so listing it only changed this callback's
       identity on every start and stop, for a value the body never looks at. */
  }, [source, engine, chosen, rate, say])

  /**
   * ⚠️ **MEMOISED BECAUSE A CONSUMER HAS TO BE ABLE TO DEPEND ON IT.** A fresh
   * object per render once kept the palette on the first `running: false` and
   * the first `run` closure: selecting the row again started a SECOND export
   * instead of stopping the first. The host publishes this control from an
   * effect, so a stable identity is also what keeps that effect from running on
   * every render — and every position update is a render.
   */
  const control = useMemo<AudiobookControl>(() => ({ running, run }), [running, run])
  /**
   * ⚠️ **AND A RUNNING EXPORT KEEPS ITS CONTROL EVEN WHEN THE BOOK GOES.**
   * This was once `if (!available || !source) return null`, so closing the book mid
   * export took the only way to stop it off the palette while the operation
   * carried on. The export now ends on its own at the next chapter once the book
   * is not `live`, but a chapter is minutes of rendering, and until it ends the
   * row is still the only thing that says an export is under way.
   *
   * `running` rather than `inFlight.current` on purpose: this decides what is
   * RENDERED, and a ref does not re-render when it changes. The ref is the
   * synchronous lock, the state is what the controls read — the same split the
   * claim in `run` is built on.
   */
  if (running) return control
  if (!engine || !source) return null
  return control
}

/**
 * What to add to a notice when the tidy-up could not finish.
 *
 * Empty when there is nothing to say, so the caller can use it as the test as
 * well as the text — a reader is told about leftover files or told nothing, and
 * never told a number that is zero.
 */
/**
 * What the engine would not say, where there was any.
 *
 * ⚠️ **THE EXPORT SAID NOTHING ABOUT THIS AND WAS THEREFORE DISHONEST — FOUND BY
 * AN INDEPENDENT AUDIT, 2026-09-30.** Both rendering roads drop passages the
 * engine refuses: a name it has no pronunciation for, a line it cannot read.
 * The reading tells a reader about each one as it reaches it; the export
 * reported the book as finished. A count is what the export owes them — *this is
 * not quite the whole book* — and the text of each passage belongs to the
 * reading, which is where the reader is at the words.
 *
 * Empty at zero, for the reason `leftBehindNote` is: a reader is told about
 * missing words or told nothing, and never told a number that is zero.
 */
function skippedNote(count: number): string {
  if (count <= 0) return ''
  return count === 1
    ? ' One passage could not be pronounced and is not in it.'
    : ` ${count} passages could not be pronounced and are not in it.`
}

function leftBehindNote(count: number): string {
  if (count <= 0) return ''
  return count === 1
    ? ' One temporary audio file could not be removed.'
    : ` ${count} temporary audio files could not be removed.`
}
