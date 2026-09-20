import { useCallback, useMemo, useRef, useState } from 'react'
import type { TocItem } from 'foliate-js/view.js'
import { ExportCancelled, exportAudiobook, planChapters } from '../reader/audiobook'
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
  ) => Promise<SectionTextWalk>
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
  /* A REF, not state: it is read inside the export loop between chapters, and a
   * captured `running` would be the value at the moment the export started. */
  const stop = useRef(false)

  const { available, source, voices, chosen, rate, say } = deps

  const run = useCallback(() => {
    if (running) {
      /* The same command stops it — see `commands.ts`. Nothing is awaited here:
       * the loop notices between chapters and unwinds itself. */
      stop.current = true
      say('Stopping the export after this chapter…')
      return
    }
    if (!source) return

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
        const walk = await source.sectionTexts(source.toc, () => stop.current)
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
          `Exported ${result.chapters} chapters, ${Math.round(result.durationMs / 60_000)} minutes, to ${nameOf(result.path)}.`,
        )
      } catch (cause) {
        if (cause instanceof ExportCancelled) {
          say('The export was stopped. Nothing was left behind.')
          return
        }
        /* THE ENGINE'S OWN SENTENCE. Every refusal in `narrate` names what it
         * refused and why — a stalled voice, a chapter with no audio, a book too
         * long for the format — and replacing them with "the export failed"
         * would throw away the only thing that tells a reader what to do. */
        say(`The export failed: ${messageOf(cause)}`)
      } finally {
        stop.current = false
        setRunning(false)
      }
    })()
  }, [running, source, voices, chosen, rate, say])

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
  if (!available || !source) return null
  return control
}

/** The file's own name, since the whole path is longer than a notice. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  /* Tauri rejects an `invoke` with the SERIALISED Rust error, which is a plain
   * value and never an `Error` — the same shape `peer/lib/port.ts` records
   * losing a refusal's name to. A string is what `narrate`'s commands return. */
  if (typeof cause === 'string') return cause
  return 'no reason was given'
}
