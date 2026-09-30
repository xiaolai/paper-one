/**
 * The kernel's speech-engine port, over the voices plugin's wire.
 *
 * Pure but for the wire it is handed, which is what makes the whole of it
 * testable with no Tauri host — the shape `peer/lib/port.ts` uses, and the
 * reason its refusal-classifying defect could be measured at all.
 */

import type {
  ClipUsage,
  ClipsEvicted,
  InstallProgress,
  SpeechEnginePort,
  SpeechRequest,
  SpokenAudio,
  SpokenClip,
  VoicePack,
} from '../../../kernel'
import { textDigest } from '../../../kernel'
import {
  asProgress,
  clipOf,
  forgottenOf,
  packOf,
  pcmOfWav,
  progressOf,
  usageOf,
  type ClipRow,
} from './rows'
import { voicesWire, type ClipQuery, type VoicesWire } from './wire'


/**
 * A download the reader asked to stop, which did not stop.
 *
 * ⚠️ **A TYPE RATHER THAN A MESSAGE, BECAUSE THE CALLER HAS TO TELL IT FROM AN
 * ORDINARY STOP.** The pane says *"Download stopped. Nothing was left
 * half-installed."* whenever the signal aborted — which is right for the
 * ordinary case and exactly wrong here, where the stop was refused and the
 * download ran on to completion. Matching on the message would work until
 * somebody edited it; the same reason `BlobFetchError` carries a `kind`.
 *
 * ⚠️ **AND IT CARRIED A `stopFailed = true` FIELD THAT NOTHING READ.** Every
 * caller asks `instanceof`, which is what "a type rather than a message" means
 * — so the field was a second answer to a question already answered, and no
 * test could tell its value apart from any other. Removed 2026-09-24.
 */
export class StopFailed extends Error {}

/** The port over a wire. */
export function voicesPortOver(wire: VoicesWire = voicesWire()): SpeechEnginePort {
  return {
    async catalogue(): Promise<readonly VoicePack[]> {
      const rows = await wire.catalogue()
      /* ⚠️ **A LIST THAT IS NOT ONE IS REFUSED, NOT READ AS EMPTY.** This was
       * `Array.isArray(rows) ? rows : []`, which is the defect this repository
       * has already fixed in eighteen stores: *present and wrong* answered as
       * *absent*, so a plugin that returned a malformed reply looked exactly
       * like a device with no voices, and the pane said so. One bad ROW is
       * still dropped alone, which is the other half of that same rule. */
      if (!Array.isArray(rows)) {
        throw new Error('the voices plugin answered with something that is not a list of packs')
      }
      const packs: VoicePack[] = []
      for (const raw of rows) {
        const pack = packOf(raw)
        /* A row this version cannot read is LEFT OUT rather than shown half
         * built: the catalogue is embedded in the binary, so a row that will
         * not read is a build defect, and offering it would be offering a
         * download whose size nobody knows. */
        if (pack) packs.push(pack)
      }
      return packs
    },

    async install(
      packId: string,
      onProgress: (progress: InstallProgress) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      /* ⚠️ **AN ALREADY-ABORTED SIGNAL FIRES NOTHING**, so a listener is not a
       * cancellation check. `addEventListener('abort', …)` on a signal that has
       * already aborted never runs — the event was dispatched before anybody
       * was listening — and the download would have started regardless. */
      signal?.throwIfAborted()
      /* Subscribed BEFORE the call, so the first bytes are not missed: a
       * 2.5 GB download reports early and often, and a listener attached after
       * the call loses however much arrived first. */
      const stop = await wire.onProgress((payload) => {
        const progress = progressOf(payload)
        if (progress && progress.pack === packId) onProgress(asProgress(progress))
      })
      /* ⚠️ **AND ASKED AGAIN AFTER THE AWAIT**, which is the window the first
       * check cannot cover: subscribing is a round trip to the plugin, and a
       * reader who presses Stop during it would otherwise be heard by nobody. */
      if (signal?.aborted) {
        stop()
        signal.throwIfAborted()
      }
      /* A failed stop is READ, not dropped. `void`-ing this promise left an
       * unhandled rejection and, worse, let a download the reader stopped run
       * on to "Installed" with nothing saying the stop had failed. */
      /* A HOLDER, not a `let`: TypeScript narrows a `let` assigned inside a
         callback back to `null` wherever it is read, and working round that
         with a cast would be hiding a real question behind an assertion. */
      /**
       * ⚠️ **`null` MEANT BOTH *"the stop worked"* AND A REJECTION VALUE — FOUND
       * BY AN INDEPENDENT AUDIT, 2026-09-30, AND REPRODUCED.** The refusal was
       * held as `unknown` with `null` standing for success, so `Promise.reject(null)`
       * — which is legal, and which a plugin boundary can produce — read as a
       * clean stop and the reader was told *"Nothing was left half-installed"*
       * over a download that had not stopped. The same shape on the install
       * itself resolved a failure as a success.
       *
       * A TAGGED result, so the outcome and the value are two different things
       * and neither can stand in for the other.
       */
      const asked: { stopping?: Promise<void> } = {}
      /**
       * Why the stop failed, or nothing.
       *
       * ⚠️ **A CLOSURE VARIABLE RATHER THAN THE PROMISE'S VALUE, AND THAT IS THE
       * MUTATION SWEEP'S THIRD ANSWER TO ONE QUESTION.** It was
       * `{ failed: false, cause: null }` — `ObjectLiteral` to `{}` is the same
       * value, unkillable — and then `null` for success, where `ArrowFunction` to
       * `() => undefined` is the same value, unkillable again. **Every nullish or
       * all-falsy success value has a falsy twin.** Written here instead, the
       * success handler is not needed at all, so there is no arrow to mutate, and
       * the failure's `{ cause }` is the only literal left — emptying that one
       * loses the message a test reads.
       */
      let stopFailed: { readonly cause: unknown } | undefined
      const abort = () => {
        /* Stopping is the plugin's to do: it holds the token the fetch loop
         * waits on, and it is what leaves nothing half-installed.
         *
         * ⚠️ **SETTLED HERE RATHER THAN HELD RAW.** The read below may be a
         * whole round trip away, and a rejected promise nobody is waiting on
         * yet is an unhandled rejection. This held the raw promise and a
         * `.catch(() => {})` beside it to cover the gap — a line whose only
         * effect was on a warning, which no test could reach. Turning the
         * refusal into a VALUE closes the gap and leaves nothing unmeasurable. */
        /* `catch` AND NOT `then`: a success handler here would do nothing, and an
           arrow that does nothing has no mutant a test can tell from it. */
        asked.stopping = wire.stop(packId).catch((cause: unknown) => {
          stopFailed = { cause }
        })
      }
      /* No `{ once: true }`: an `AbortSignal` fires `abort` at most once, and
         the `finally` below takes the listener off on every road out — so the
         option could never be the thing that decided anything. */
      signal?.addEventListener('abort', abort)
      /* HELD RATHER THAN RETHROWN, so the stop below is asked about on BOTH
       * roads out of the install. Rethrowing here meant a stop that failed
       * beside an install that also failed was never looked at, and the reader
       * was told the download had stopped cleanly. */
      /* TAGGED, for the reason `asked.stopping` is: an install rejecting with
         `null` would otherwise resolve as a success. */
      /* `undefined` rather than a `failed: false` object, for the reason
         `stopFailed` above records: every all-falsy success value has a falsy
         twin no test can tell it from. */
      let refused: { readonly cause: unknown } | undefined
      try {
        await wire.install(packId)
      } catch (cause) {
        refused = { cause }
      } finally {
        signal?.removeEventListener('abort', abort)
        stop()
      }
      /* ⚠️ **THE STOP IS AWAITED, NOT SAMPLED.** Whether it failed may not be
       * known when the install settles — they are two round trips — so this
       * waits for the answer rather than reading a flag that might not be set
       * yet. A refused stop outranks the install's own error: it is the more
       * actionable news, and it is the one case where the pane's *"Nothing was
       * left half-installed"* would be false. */
      /* ⚠️ **NO GUARD IN FRONT OF THIS, BECAUSE `await undefined` IS AN ORDINARY
       * THING TO DO** — an install nobody stopped leaves `asked.stopping` unset and
       * this resolves at once. The guard that stood here (`if (stopping)`) could
       * never come back false in a way anything could observe: with it forced true,
       * `await undefined` gives `undefined`, which the check below reads as no
       * failure — the same outcome as skipping the block. The sweep reported it and
       * removing it is the repair. */
      await asked.stopping
      if (stopFailed) {
        throw new StopFailed(`the download could not be stopped: ${errorText(stopFailed.cause)}`)
      }
      if (refused) throw refused.cause
    },

    async remove(packId: string): Promise<void> {
      await wire.remove(packId)
    },

    /**
     * The section's audio: the clip already on disk, or a render that makes one.
     *
     * ⚠️ **THE SAMPLES COME FROM THE FILE AND NOT FROM THE COMMAND'S ANSWER.**
     * WI-34.0 measured one real section at 139 924 800 bytes; a command that
     * returned that would widen every sample to a decimal number on the way
     * across the IPC and hold the whole of it in the webview's heap twice. The
     * plugin writes a file and answers its path, and the fs plugin reads it as
     * bytes through the `$APPDATA` scope that was already granted.
     */
    async render(request: SpeechRequest): Promise<SpokenAudio> {
      const query = queryOf(request)
      /* ASKED BEFORE RENDERING, which is the whole of what this phase buys: a
         section the reader has heard before plays without the wait. */
      const found = await wire.clipFind(query)
      const clip = clipOf(
        found === null || found === undefined ? await wire.clipRender(query, request.text) : found,
      )
      const bytes = await wire.readClip(clip.stem)
      return {
        pcm: pcmOfWav(bytes, clip.sampleRate),
        sampleRate: clip.sampleRate,
        words: clip.words,
        skipped: clip.skipped,
        evicted: clip.evicted,
        clipPath: clip.path,
      }
    },

    /**
     * Whether this section is already rendered — asked without rendering.
     *
     * The samples are NOT read: the audiobook export names the file to the
     * packer and never needs its bytes in the webview.
     */
    async findClip(request: SpeechRequest): Promise<SpokenClip | null> {
      const found = await wire.clipFind(queryOf(request))
      if (found === null || found === undefined) return null
      return spokenClipOf(clipOf(found))
    },

    async holdClips(stems: readonly string[], hold: boolean): Promise<number> {
      const answered = await wire.clipHold(stems, hold)
      if (!Number.isInteger(answered) || (answered as number) < 0) {
        throw new Error('the rendered reading answered with a count that is not one')
      }
      return answered as number
    },

    async clipUsage(): Promise<ClipUsage> {
      return usageOf(await wire.clipUsage())
    },

    async forgetClips(bookId?: string): Promise<ClipsEvicted> {
      return forgottenOf(await wire.clipForget(bookId ?? null))
    },

    async release(): Promise<void> {
      await wire.release()
    },
  }
}

/** Whatever a rejection carries, as something a reader can read. */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * A request as the wire spells it.
 *
 * ⚠️ **THE SPOKEN DIGEST IS COMPUTED HERE AND NOWHERE ELSE.** It is a digest of
 * `request.text`, so deriving it from the request is the only spelling that
 * cannot disagree with what was sent — a caller that supplied its own could hand
 * over a digest of a string it did not render, and the failure would be a whole
 * chapter of misplaced word highlights with nothing throwing.
 */
function queryOf(request: SpeechRequest): ClipQuery {
  return {
    book: request.clip.bookId,
    section: request.clip.section,
    pack: request.packId,
    voice: request.voiceId,
    rate: request.rate ?? null,
    textDigest: request.clip.textDigest,
    spokenDigest: textDigest(request.text),
  }
}

/** A clip row as the export needs it: a path and a length, never the samples. */
function spokenClipOf(clip: ClipRow): SpokenClip {
  return {
    stem: clip.stem,
    path: clip.path,
    bytes: clip.bytes,
    sampleRate: clip.sampleRate,
    durationMs: clip.durationMs,
    words: clip.words,
    /* ⚠️ **DROPPED HERE UNTIL 2026-09-30, WHICH MADE AN INCOMPLETE EXPORT LOOK
       COMPLETE — FOUND BY AN INDEPENDENT AUDIT.** The store persists what the
       engine could not pronounce, the plugin answers it, and this mapping threw
       it away — so a chapter the reading had told the reader about came back
       through the export silently whole. A short book that says it is whole is
       the failure `narrate` names as the worst available. */
    skipped: clip.skipped,
  }
}
