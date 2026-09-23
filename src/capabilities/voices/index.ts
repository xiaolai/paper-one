import type { Capability, CapabilityContext, Disposable } from '../../kernel'
import { voicesPortOver } from './lib/port'

/**
 * The downloadable voices.
 *
 * A reader who wants a book read aloud on a Mac downloads a pack — a model, its
 * voices, and what the engine needs to turn text into sounds. Why Paper brings
 * its own engine at all is measured and recorded rather than assumed: macOS
 * withholds every voice above the compact tier from any caller Apple did not
 * sign, so the platform's own engine cannot reach a good voice for this app
 * through Web Speech or natively.
 *
 * ⚠️ **NOTHING SHIPS IN THE BUNDLE BUT CODE.** The weights are fetched on
 * request, pinned by revision and checked byte for byte against the manifest
 * embedded in the binary — see `manifest.rs` for why the catalogue is embedded
 * rather than fetched, and `install.rs` for what makes a stopped download leave
 * nothing half-installed.
 *
 * ⚠️ **DESKTOP ONLY, AND THE `cfg` IS WHAT ENFORCES IT.** `default = ["desktop"]`
 * in the crate must not pull ONNX Runtime or MLX into a phone build; the
 * capability's `platforms` says the same thing on this side, and a composition
 * that names it on a phone fails validation rather than building something that
 * cannot start.
 *
 * Licences of what it downloads, which the Settings section shows the reader:
 * Kokoro and Qwen3-TTS weights are Apache-2.0, misaki's lexicons Apache-2.0,
 * CMUdict BSD-2. What it LINKS is in `THIRD-PARTY-NOTICES.md`.
 */
export const voices: Capability = {
  id: 'voices',
  requires: [],

  start(api: CapabilityContext): Disposable {
    /* Bound only where there is a plugin, exactly as the peer capability binds
     * the hash port: unbound, every reader of the slot answers "no voice"
     * rather than failing, which is what a browser client and a phone get. */
    const port = voicesPortOver()
    const bound = api.services.bindSpeechEngines(port)
    api.diagnostics.info('voices.started', {})
    return {
      dispose: () => {
        bound.dispose()
        /* The reader's memory is the point: a model left loaded holds about
         * 2.5 GB, and a composition being torn down is the last moment
         * anything will ask for it back. */
        void port.release().catch(() => {})
      },
    }
  },
}

export { voicesPortOver } from './lib/port'
export { offered, packsFor, qualify, unqualify } from './lib/rows'
