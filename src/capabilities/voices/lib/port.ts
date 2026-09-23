/**
 * The kernel's speech-engine port, over the voices plugin's wire.
 *
 * Pure but for the wire it is handed, which is what makes the whole of it
 * testable with no Tauri host — the shape `peer/lib/port.ts` uses, and the
 * reason its refusal-classifying defect could be measured at all.
 */

import type {
  InstallProgress,
  SpeechEnginePort,
  SpeechRequest,
  SpokenAudio,
  VoicePack,
} from '../../../kernel'
import { asProgress, packOf, progressOf, spokenOf } from './rows'
import { voicesWire, type VoicesWire } from './wire'

/**
 * A download the reader asked to stop, which did not stop.
 *
 * ⚠️ **A TYPE RATHER THAN A MESSAGE, BECAUSE THE CALLER HAS TO TELL IT FROM AN
 * ORDINARY STOP.** The pane says *"Download stopped. Nothing was left
 * half-installed."* whenever the signal aborted — which is right for the
 * ordinary case and exactly wrong here, where the stop was refused and the
 * download ran on to completion. Matching on the message would work until
 * somebody edited it; the same reason `BlobFetchError` carries a `kind`.
 */
export class StopFailed extends Error {
  readonly stopFailed = true
}

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
      const asked: { stopping: Promise<void> | null } = { stopping: null }
      const abort = () => {
        /* Stopping is the plugin's to do: it holds the token the fetch loop
         * waits on, and it is what leaves nothing half-installed. */
        const stopping = wire.stop(packId)
        /* Read below; this only keeps it from being unhandled in between. */
        stopping.catch(() => {})
        asked.stopping = stopping
      }
      signal?.addEventListener('abort', abort, { once: true })
      /* HELD RATHER THAN RETHROWN, so the stop below is asked about on BOTH
       * roads out of the install. Rethrowing here meant a stop that failed
       * beside an install that also failed was never looked at, and the reader
       * was told the download had stopped cleanly. */
      let refused: unknown = null
      try {
        await wire.install(packId)
      } catch (cause) {
        refused = cause
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
      const stopping = asked.stopping
      if (stopping) {
        const failed = await stopping.then(
          () => null,
          (cause: unknown) => cause,
        )
        if (failed !== null) {
          throw new StopFailed(`the download could not be stopped: ${errorText(failed)}`)
        }
      }
      if (refused !== null) throw refused
    },

    async remove(packId: string): Promise<void> {
      await wire.remove(packId)
    },

    async render(request: SpeechRequest): Promise<SpokenAudio> {
      const row = await wire.render(
        request.packId,
        request.voiceId,
        request.text,
        request.rate ?? null,
      )
      return spokenOf(row)
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
