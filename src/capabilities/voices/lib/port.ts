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
import { asProgress, packOf, progressOf } from './rows'
import { voicesWire, type VoicesWire } from './wire'

/** The port over a wire. */
export function voicesPortOver(wire: VoicesWire = voicesWire()): SpeechEnginePort {
  return {
    async catalogue(): Promise<readonly VoicePack[]> {
      const rows = await wire.catalogue()
      const packs: VoicePack[] = []
      for (const raw of Array.isArray(rows) ? rows : []) {
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
      /* Subscribed BEFORE the call, so the first bytes are not missed: a
       * 2.5 GB download reports early and often, and a listener attached after
       * the call loses however much arrived first. */
      const stop = await wire.onProgress((payload) => {
        const progress = progressOf(payload)
        if (progress && progress.pack === packId) onProgress(asProgress(progress))
      })
      const abort = () => {
        /* Stopping is the plugin's to do: it holds the token the fetch loop
         * waits on, and it is what leaves nothing half-installed. */
        void wire.stop(packId)
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        await wire.install(packId)
      } finally {
        signal?.removeEventListener('abort', abort)
        stop()
      }
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
      return {
        pcm: Uint8Array.from(row.pcm ?? []),
        sampleRate: row.sampleRate,
        words: row.words ?? [],
        skipped: row.skipped ?? [],
      }
    },

    async release(): Promise<void> {
      await wire.release()
    },
  }
}
