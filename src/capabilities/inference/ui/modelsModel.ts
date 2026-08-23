import type { KernelServices, SettingsStore } from '../../../kernel'
import { LOOK_UP_LABELS, availableModes, effectiveMode, type LookUpMode } from '../../../kernel'
import type { Controller, InferenceSnapshot, RuntimeState } from '../lib/controller'
import { mintRequestId, type InferencePlugin } from '../lib/plugin'

/**
 * What `Test voice` says.
 *
 * One short sentence with a comma and a full stop, so the reader hears the
 * prosody rather than a single word — which is the only thing a voice test
 * actually tells them.
 */
export const TEST_VOICE_LINE = 'This is the voice Paper will read aloud with, once reading aloud arrives.'
import { KEEP_LOADED_SETTING } from '../lib/settings'

/**
 * The Local models section's decisions — no React, so they can be tested.
 *
 * `ModelsPane.tsx` is the adapter that draws what this decides. The split is
 * the same one `storageModel`/`StoragePane` uses, and for the same reason:
 * the interesting rules here are about what a row SAYS, and a rule that can
 * only be checked by rendering is a rule nobody checks.
 *
 * # Progress is a count, not a bar
 *
 * F3: `CAPABILITY_UI` is fourteen frozen class names and none of them is a
 * menu, a bar or a spinner. So a download reports as
 * `Downloading · 412 MB of 2.4 GB` in the same right-hand `value` slot
 * `StoragePane` already writes facts into. No new class, no new rule, nothing
 * for `css:check` to chase. If a bare number later reads as stalled, one
 * `progress` class is a small deliberate follow-up — not something to invent
 * ahead of the need.
 */

export interface ModelsSnapshot extends InferenceSnapshot {
  readonly lookUp: LookUpMode
  readonly keepLoaded: boolean
  readonly modelsDir: string | null
  readonly residentBytes: number | null
  readonly voiceTest: VoiceTest
}

/** What `Test voice` is doing. */
export type VoiceTest = 'idle' | 'speaking' | 'failed'

export interface ModelsModel {
  getSnapshot(): ModelsSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  install(model: string): Promise<void>
  cancelInstall(): void
  uninstall(model: string): Promise<void>
  cycleLookUp(hasDictionary: boolean): void
  setKeepLoaded(value: boolean): void
  /**
   * Play a short line through an installed voice (WI-15.9).
   *
   * THE MINIMUM HONEST CONSUMER of a TTS model. Read-aloud — sentence
   * alignment, highlight-follows-voice — is a separate phase, and shipping a
   * model nothing uses would be worse than shipping neither.
   */
  testVoice(): Promise<void>
  /** Stop the utterance AND the request behind it. */
  stopVoice(): void
  reveal(): Promise<string>
  dispose(): void
}

/**
 * Decimal, not binary, and the reason is the reader rather than the
 * arithmetic: this number is compared against a download they were quoted in
 * the same units, and 2.5 GB shown as 2.3 GiB reads as a different file.
 *
 * `—` for an absent figure, NEVER `0`. Lemonade is specifically credited for
 * returning null rather than zero for accelerator memory it cannot read, and
 * that honesty has to survive translation — a `0` beside "Memory" is a claim
 * that nothing is resident, which is a different statement from "unknown".
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`
  return `${bytes} B`
}

/**
 * The right-hand value for the Runtime row.
 *
 * Every state says what it is in the reader's words, and `degraded` says what
 * went wrong rather than showing a code.
 */
export function runtimeValue(runtime: RuntimeState): string {
  switch (runtime.kind) {
    case 'absent':
      return 'Not installed'
    case 'installing':
      return runtime.total > 0
        ? `Downloading · ${formatBytes(runtime.received)} of ${formatBytes(runtime.total)}`
        : 'Downloading…'
    case 'verifying':
      return 'Verifying…'
    case 'installed':
      return 'Ready to start'
    case 'starting':
      return 'Starting…'
    case 'ready':
      return runtime.version === '' ? 'Running' : `Running · ${runtime.version}`
    case 'degraded':
      return runtime.detail
  }
}

/**
 * The library status bar's download line — ONE finished sentence, or null.
 *
 * WI-15.12. A string rather than a count pair, because F3's rule reaches the
 * status bar too: the bar draws a fact, it does not compute one. Null at rest,
 * which is the whole of the work item's negative half — with no download
 * running the bar is byte-for-byte what it was.
 *
 * NOTHING IS RETURNED FOR READINESS. A standing "AI is ready" would be the
 * first thing ever to hold that slot at rest and would have to outrank an
 * import the reader just asked for. Readiness is not work.
 */
export function downloadLine(
  runtime: RuntimeState,
  models: readonly { readonly id: string; readonly label: string }[],
): string | null {
  if (runtime.kind === 'verifying') {
    return `Verifying ${labelOf(runtime.model, models)}`
  }
  if (runtime.kind !== 'installing') return null
  const label = labelOf(runtime.model, models)
  return runtime.total > 0
    ? `Downloading ${label} — ${formatBytes(runtime.received)} of ${formatBytes(runtime.total)}`
    : `Downloading ${label}`
}

function labelOf(id: string, models: readonly { readonly id: string; readonly label: string }[]): string {
  return models.find((model) => model.id === id)?.label ?? id
}

/** The right-hand value for one model's row. */
export function modelValue(
  model: { readonly id: string; readonly bytes: number; readonly installed: boolean },
  runtime: RuntimeState,
): string {
  if ((runtime.kind === 'installing' || runtime.kind === 'verifying') && runtime.model === model.id) {
    return runtimeValue(runtime)
  }
  if (model.installed) return `Installed · ${formatBytes(model.bytes)}`
  return formatBytes(model.bytes)
}

/**
 * What the model's action button says.
 *
 * `[Install]` becomes `[Remove]` once installed, and `[Cancel]` during the
 * download — one button whose label is the action available now, rather than
 * three controls two of which are always disabled.
 */
export function modelAction(
  model: { readonly id: string; readonly installed: boolean },
  runtime: RuntimeState,
): 'install' | 'remove' | 'cancel' {
  if ((runtime.kind === 'installing' || runtime.kind === 'verifying') && runtime.model === model.id) {
    return 'cancel'
  }
  return model.installed ? 'remove' : 'install'
}

/** The Look up row's current label, given what this platform and build have. */
export function lookUpValue(
  chosen: LookUpMode,
  hasDictionary: boolean,
  hasGloss: boolean,
): string | null {
  const modes = availableModes(hasDictionary, hasGloss)
  const mode = effectiveMode(chosen, modes)
  return mode === null ? null : LOOK_UP_LABELS[mode]
}

export interface ModelsModelOptions {
  readonly controller: Controller
  readonly plugin: InferencePlugin
  readonly settings: SettingsStore
  /**
   * The kernel's own view of `Look up`.
   *
   * NOT `settings`, and this is not a style choice: `LOOK_UP_SETTING` is
   * `kernel.lookUp`, and `scopeSettings` confines this capability's settings
   * handle to `inference.` at every door. Reading it through `settings` threw
   * `namespace` on the pane's first render — see `KernelServices.lookUp`.
   */
  readonly kernel: Pick<KernelServices, 'lookUp' | 'cycleLookUp'>
}

export function createModelsModel({ controller, plugin, settings, kernel }: ModelsModelOptions): ModelsModel {
  const listeners = new Set<() => void>()
  let modelsDir: string | null = null
  let residentBytes: number | null = null
  let voiceTest: VoiceTest = 'idle'
  let disposed = false
  let voiceRequest: string | null = null
  let playing: HTMLAudioElement | null = null
  let playingUrl: string | null = null

  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }

  /* One cached object per state, so `useSyncExternalStore` sees a stable
   * reference between changes — a fresh object per call is an infinite
   * re-render, and it is the classic way to write this wrong. */
  let cached: ModelsSnapshot | null = null
  const invalidate = (): void => {
    cached = null
    emit()
  }
  const releaseAudio = (): void => {
    playing?.pause()
    playing = null
    if (playingUrl !== null) {
      URL.revokeObjectURL(playingUrl)
      playingUrl = null
    }
  }
  const unsubscribeController = controller.subscribe(invalidate)
  const unsubscribeSettings = settings.subscribe(invalidate)

  return {
    getSnapshot: () => {
      if (cached === null) {
        const base = controller.getSnapshot()
        cached = {
          ...base,
          lookUp: kernel.lookUp(),
          keepLoaded: settings.get(KEEP_LOADED_SETTING),
          modelsDir,
          residentBytes,
          voiceTest,
        }
      }
      return cached
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh: async () => {
      await controller.refresh()
      /* Both are best-effort and neither may fail the refresh: the models
       * folder is a convenience and the memory figure is honestly unknown
       * when the daemon is not running. */
      if (modelsDir === null) {
        modelsDir = await plugin.revealModelsDir().catch(() => null)
      }
      residentBytes = await plugin
        .resourceUsage()
        .then((usage) => usage.residentBytes)
        .catch(() => null)
      if (!disposed) invalidate()
    },
    install: (model) => controller.install(model),
    cancelInstall: () => controller.cancelInstall(),
    uninstall: (model) => controller.uninstall(model),
    /* The kernel owns the cycle; this file owns only the answer to "is there
       a gloss on this machine", which is the controller's to give. */
    cycleLookUp: (hasDictionary) => kernel.cycleLookUp(hasDictionary, controller.textModel() !== null),
    setKeepLoaded: (value) => settings.set(KEEP_LOADED_SETTING, value),

    testVoice: async () => {
      const voice = controller.getSnapshot().models.find((m) => m.modality === 'speech' && m.installed)
      if (!voice || voiceTest === 'speaking') return
      /* CLAIMED BEFORE THE FIRST AWAIT, which is the whole of the fix.
       *
       * The reentrancy guard above read `voiceTest`, and `voiceTest` was set
       * to `speaking` only after `ensureReady()` resolved — so two presses of
       * Play both saw `idle`, both waited for the runtime, and both went on to
       * synthesise. Two requests, two `Audio` elements, and the first blob URL
       * overwritten before anything could revoke it. A guard on the far side
       * of an await guards nothing. */
      const requestId = mintRequestId('voice')
      voiceRequest = requestId
      voiceTest = 'speaking'
      invalidate()
      if (!(await controller.ensureReady())) {
        /* Ownership re-checked after every await from here on: a stop, a
         * second press, or a disposal during the start is why this request
         * may no longer be the one anybody is waiting for. */
        if (voiceRequest !== requestId || disposed) return
        voiceTest = 'failed'
        invalidate()
        return
      }
      if (voiceRequest !== requestId || disposed) return
      try {
        const bytes = await plugin.speak(requestId, voice.id, TEST_VOICE_LINE, null)
        if (voiceRequest !== requestId || disposed) return
        /* A blob URL rather than a data URL: the audio is hundreds of
           kilobytes, and base64 would put a megabyte-long string through the
           DOM to play four seconds of speech. Revoked on stop, so the bytes
           are released rather than held for the app's lifetime. */
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }))
        playingUrl = url
        const audio = new Audio(url)
        playing = audio
        audio.onended = () => {
          if (voiceRequest !== requestId) return
          voiceTest = 'idle'
          releaseAudio()
          invalidate()
        }
        await audio.play()
      } catch {
        if (voiceRequest !== requestId) return
        /* Cancelling is the reader's own doing and returns to idle; anything
           else is a failure the row says out loud. */
        voiceTest = voiceRequest === null ? 'idle' : 'failed'
        releaseAudio()
        invalidate()
      }
    },

    stopVoice: () => {
      const requestId = voiceRequest
      voiceRequest = null
      /* BOTH, which is what WI-15.9's acceptance names: "cancelling
         mid-utterance stops both the audio and the request". Stopping only the
         audio would leave the daemon synthesising into nothing. */
      if (requestId !== null) void plugin.cancel(requestId).catch(() => {})
      releaseAudio()
      voiceTest = 'idle'
      invalidate()
    },

    reveal: () => plugin.revealModelsDir(),
    dispose: () => {
      disposed = true
      /* An utterance must not outlive the pane that started it. */
      if (voiceRequest !== null) void plugin.cancel(voiceRequest).catch(() => {})
      voiceRequest = null
      releaseAudio()
      unsubscribeController()
      unsubscribeSettings()
      listeners.clear()
    },
  }
}
