import { useCallback, useMemo, useRef, useState } from 'react'
import type { TocItem } from 'foliate-js/view.js'
import { ExportCancelled, exportAudiobook, planChapters } from '../reader/audiobook'
import { basename } from '../../core/bookFiles'
import { messageOf } from '../../core/messageOf'
import type { SpeechSkipPrefs } from '../reader/speechSkip'
import type { SectionTextWalk } from '../reader/session'
import { chooseAudiobookPath, tauriAudiobook } from '../reader/audiobookTauri'
import { voiceFor, type VoiceFacts } from '../reader/voiceChoice'

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

export interface AudiobookSource {
  readonly title: string
  readonly author: string
  readonly lang: string | null
  readonly toc: readonly TocItem[]
  readonly sectionTexts: (
    toc?: readonly TocItem[],
    shouldStop?: () => boolean,
    skip?: SpeechSkipPrefs,
  ) => Promise<SectionTextWalk>
  /**
   * What the READING skips, so the export skips the same.
   *
   * ⚠️ **NOT DEFAULTED HERE.** `collectText` has a default and taking it would
   * give the export its own opinion about whether a note body is spoken, so a
   * reader who turned notes on would hear them and not find them in the file.
   */
  readonly skip: SpeechSkipPrefs
}

export interface AudiobookControl {
  readonly running: boolean
  readonly run: () => void
}

export interface AudiobookDeps {
  /** Present only where the engine is — see `narrate`'s platform gate. */
  readonly available: boolean
  readonly source: AudiobookSource | null
  readonly voices: readonly VoiceFacts[]
  readonly chosen: Readonly<Record<string, string>>
  readonly rate: number
  /** One line to the reader. The same surface an import reports through. */
  readonly say: (text: string) => void
}

export function useAudiobook(deps: AudiobookDeps): AudiobookControl | null {
  const [running, setRunning] = useState(false)
  /** The synchronous claim — see `run`. `running` is what the controls render. */
  const inFlight = useRef(false)
  /* A REF, not state: it is read inside the export loop between chapters, and a
   * captured `running` would be the value at the moment the export started. */
  const stop = useRef(false)

  const { available, source, voices, chosen, rate, say } = deps

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
      /* The same command stops it — see `commands.ts`. Nothing is awaited here:
       * the loop notices between chapters and unwinds itself. */
      stop.current = true
      say('Stopping the export after this chapter…')
      return
    }
    if (!source) return

    inFlight.current = true
    void (async () => {
      stop.current = false
      setRunning(true)
      try {
        const voice = voiceFor(voices, source.lang, chosen)
        if (!voice) {
          /* The one refusal that is about the machine rather than the book: no
             voice this app would choose speaks the language it declares. */
          say('No installed voice can read this book — choose one in Settings first.')
          return
        }

        say('Reading the book…')
        /* THE STOP GOES IN, rather than being checked only on the way out. A long
           book is seconds of parsing per section, so "Stopping…" used to sit on
           screen through hundreds of them. */
        const walk = await source.sectionTexts(source.toc, () => stop.current, source.skip)
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

        const path = await chooseAudiobookPath(source.title)
        /* ⚠️ **THE DIALOG IS ASKED AFTER THE BOOK IS READ, DELIBERATELY.** A
         * reader who picks a file name and is then told the book has nothing to
         * read has been made to do work for an answer that was already known. */
        if (!path) return

        const platform = await tauriAudiobook()
        const result = await exportAudiobook(platform, {
          chapters,
          voice: voice.voiceURI,
          rate,
          title: source.title,
          author: source.author,
          path,
          onProgress: (done, total, title) => {
            say(
              done >= total
                ? 'Joining the chapters…'
                : `Reading ${title} — ${done + 1} of ${total}…`,
            )
          },
          cancelled: () => stop.current,
        })
        say(
          `Exported ${result.chapters} chapters, ${Math.round(result.durationMs / 60_000)} minutes, to ${nameOf(result.path)}.` +
            leftBehindNote(result.leftBehind),
        )
      } catch (cause) {
        if (cause instanceof ExportCancelled) {
          /* ⚠️ **THIS SAID "Nothing was left behind." UNCONDITIONALLY**, while
             `exportAudiobook` swallowed every tidy-up failure — so the one
             sentence a reader would act on was the one thing nobody had checked.
             A chapter of a ten-hour book is tens of megabytes. It is counted now,
             and the claim is only made when it is true. */
          say(`The export was stopped.${leftBehindNote(cause.leftBehind) || ' Nothing was left behind.'}`)
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
  }, [source, voices, chosen, rate, say])

  /**
   * ⚠️ **MEMOISED BECAUSE A CONSUMER HAS TO BE ABLE TO DEPEND ON IT.** A fresh
   * object per render is why `App`'s `commands` memo left `audiobook` out of its
   * dependency list — including it would have rebuilt every command on every
   * render, and every position update is a render. So the palette kept the first
   * `running: false` and the first `run` closure: selecting the row again started
   * a SECOND export instead of stopping the first, and the label never changed to
   * "Stop exporting the audiobook".
   *
   * That memo's own comment says a stale command is worse than a missing one
   * because it looks like it worked, which is exactly what happened. A stable
   * identity is what lets the dependency be declared honestly.
   */
  const control = useMemo<AudiobookControl>(() => ({ running, run }), [running, run])
  /**
   * ⚠️ **AND A RUNNING EXPORT KEEPS ITS CONTROL EVEN WHEN THE BOOK GOES.**
   * This was `if (!available || !source) return null`, so closing the book mid
   * export took the only way to stop it off the palette while the operation
   * carried on — reading, rendering and writing a file the reader could no longer
   * reach, and with `source` gone they could not start another to get the row
   * back either. The export captured everything it needs when it began; it does
   * not read `source` again, which is exactly why it survives, and exactly why
   * the control has to.
   *
   * `running` rather than `inFlight.current` on purpose: this decides what is
   * RENDERED, and a ref does not re-render when it changes. The ref is the
   * synchronous lock, the state is what the controls read — the same split the
   * claim in `run` is built on.
   */
  if (running) return control
  if (!available || !source) return null
  return control
}

/**
 * The file's own name, since the whole path is longer than a notice.
 *
 * ⚠️ **THE KERNEL'S `basename`, NOT A THIRD ONE.** This hand-rolled
 * `lastIndexOf('/')` knew only the POSIX separator, which is the same defect
 * `audiobookTauri`'s `discard` had beside it — two copies of one helper, both
 * wrong on Windows, in the same feature.
 */
function nameOf(path: string): string {
  return basename(path) || path
}

/**
 * What to add to a notice when the tidy-up could not finish.
 *
 * Empty when there is nothing to say, so the caller can use it as the test as
 * well as the text — a reader is told about leftover files or told nothing, and
 * never told a number that is zero.
 */
function leftBehindNote(count: number): string {
  if (count <= 0) return ''
  return count === 1
    ? ' One temporary audio file could not be removed.'
    : ` ${count} temporary audio files could not be removed.`
}
