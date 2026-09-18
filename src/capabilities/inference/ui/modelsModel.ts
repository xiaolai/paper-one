import { messageOf, notifyAll } from '../../../kernel'
import { createGenerations } from '../../../kernel'
import type { Controller, InferenceSnapshot, ReportFailure, RuntimeState } from '../lib/controller'
import type { InferencePlugin } from '../lib/plugin'

/* ⚠️ **`Test voice` AND ITS SPEAKER WERE HERE, AND ARE DELETED WITH THE NEURAL
 * VOICE.** The row played a line through the manifest's speech model; that
 * model and `inference_speak` are gone, and pronunciation is the kernel's
 * system voice — `core/voice.ts` records why. What this model draws now is the
 * runtime, the catalogue, the memory figure and the folder. */

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
  readonly modelsDir: string | null
  readonly residentBytes: number | null
}

export interface ModelsModel {
  getSnapshot(): ModelsSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  /** Resolves false when the model did not end up installed — see the
   *  controller. Never rejects: the pane calls it fire-and-forget. */
  install(model: string): Promise<boolean>
  cancelInstall(): void
  uninstall(model: string): Promise<boolean>
  dispose(): void
}

/**
 * Decimal, not binary, and the reason is the reader rather than the
 * arithmetic: this number is compared against a download they were quoted in
 * the same units, and 2.5 GB shown as 2.3 GiB reads as a different file.
 *
 * A NON-BREAKING SPACE between the number and its unit, in every branch: the
 * value sits in a narrow right-hand cell, and a wrapped `2.5` / `GB` — measured
 * in the running app on 2026-09-18, in Local models — is a figure with its unit
 * on another line. A quantity and its unit are one token to a reader.
 *
 * `—` for an absent figure, NEVER `0`. `ResourceUsage.residentBytes` is null
 * rather than zero when the plugin cannot read the figure, and that honesty has
 * to survive translation — a `0` beside "Memory" is a claim that nothing is
 * resident, which is a different statement from "unknown".
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1_000) return `${bytes}\u00a0B`
  /* ⚠️ THE UNIT IS CHOSEN AFTER ROUNDING, NOT BEFORE IT. Testing the raw
     figure against each threshold and rounding afterwards printed `1000 KB`
     for anything from 999 500 bytes up, and `1000 MB` at the next boundary —
     four digits in a unit that only ever has three, for a reader comparing it
     against a download quoted as 1 MB. */
  const kb = Math.round(bytes / 1_000)
  if (kb < 1_000) return `${kb}\u00a0KB`
  const mb = Math.round(bytes / 1_000_000)
  if (mb < 1_000) return `${mb}\u00a0MB`
  return `${(bytes / 1_000_000_000).toFixed(1)}\u00a0GB`
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

/**
 * Whether the runtime is busy with THIS model's own download or verification.
 *
 * One predicate rather than the two verbatim copies this replaces: the row's
 * value and the row's button both ask it, and two spellings of one question is
 * how a row ends up showing `Downloading…` beside an `[Install]` button.
 */
export function isActiveInstall(runtime: RuntimeState, modelId: string): boolean {
  return (runtime.kind === 'installing' || runtime.kind === 'verifying') && runtime.model === modelId
}

/**
 * What an uninstalled row says when there is no runtime to run it.
 *
 * The routes pane's wording for the same fact (`probe.rs` emits it for a
 * local route whose runtime is missing), so the two panes agree.
 */
export const RUNTIME_MISSING_VALUE = 'Runtime not installed'

/** The right-hand value for one model's row. */
export function modelValue(
  model: { readonly id: string; readonly bytes: number; readonly installed: boolean },
  runtime: RuntimeState,
): string {
  if (isActiveInstall(runtime, model.id)) return runtimeValue(runtime)
  if (model.installed) return `Installed · ${formatBytes(model.bytes)}`
  /* THE REASON, NOT THE PRICE. Quoting a download cost beside a row that
     offers no download reads as an offer. */
  if (runtime.kind === 'absent') return RUNTIME_MISSING_VALUE
  return formatBytes(model.bytes)
}

/**
 * What the model's action button says — or that there is none.
 *
 * `[Install]` becomes `[Remove]` once installed, and `[Cancel]` during the
 * download — one button whose label is the action available now, rather than
 * three controls two of which are always disabled.
 *
 * ⚠️ **`runtime-missing` IS NOT A BUTTON**, and it is the case this ignored.
 * WI-20.21: `runtime.kind` was never read, so with the runtime absent every
 * row offered Install, the download succeeded, 2.5 GB landed, and every lookup
 * after it failed with "The runtime is not installed" — a model the reader
 * paid for and nothing could run. A row that cannot act shows why and no
 * control (§07), which is the routes pane's own rule for a route that cannot
 * answer. Removal is still offered for a model on disk: the file can be
 * deleted whether or not anything could have run it.
 */
export function modelAction(
  model: { readonly id: string; readonly installed: boolean },
  runtime: RuntimeState,
): 'install' | 'remove' | 'cancel' | 'runtime-missing' {
  if (isActiveInstall(runtime, model.id)) return 'cancel'
  if (model.installed) return 'remove'
  return runtime.kind === 'absent' ? 'runtime-missing' : 'install'
}

export interface ModelsModelOptions {
  readonly controller: Controller
  /**
   * The two commands this model reads, and no others.
   *
   * `Pick`, and it was the whole plugin: the `Test voice` speaker reached
   * `speak` and `cancel` through it. With the speaker gone the two reads below
   * are all that is left, and naming them lets a test double be written with no
   * cast — a cast is what stops the compiler checking the signatures.
   */
  readonly plugin: Pick<InferencePlugin, 'revealModelsDir' | 'resourceUsage'>
  /* ⚠️ **NO `settings`, AND IT WAS REQUIRED.** This model took a
   * `SettingsStore`, subscribed to it and never read it — `settings.get` is
   * called nowhere in this file, and the snapshot is the controller's plus a
   * models directory and a memory figure, neither of which is a preference. The inference capability declares NO setting at all:
   * `defineSetting` appears nowhere under it, so the scoped handle could not
   * have read anything that exists. What the subscription bought was a cache
   * invalidation and a re-render of the models pane on every settings write in
   * the app, for a snapshot that cannot change because of one — and a required
   * dependency every caller and every test had to construct. Found by audit. */
  /**
   * Told when a best-effort read fails.
   *
   * The models folder and the memory figure are allowed to be unknown, and
   * both used to reach `null` through a bare `.catch(() => null)` — so a
   * permission problem, a dropped IPC connection and a command that was never
   * registered were indistinguishable from a daemon that is simply not
   * running. The `null` is still the right answer for the reader; discarding
   * the reason was the mistake.
   */
  readonly report?: ReportFailure
}


export function createModelsModel({ controller, plugin, report }: ModelsModelOptions): ModelsModel {
  const listeners = new Set<() => void>()
  let modelsDir: string | null = null
  let residentBytes: number | null = null
  let disposed = false
  /* LAST ISSUED WINS. `refresh` makes three IPC calls and the pane calls it on
     every open, so two can be out at once — and without this the older one's
     `resourceUsage` lands last, or its failed `revealModelsDir` replaces a
     directory the newer one had successfully resolved with `null`. */
  const generations = createGenerations()

  const emit = (): void => {
    notifyAll(listeners, 'models')
  }

  /* One cached object per state, so `useSyncExternalStore` sees a stable
   * reference between changes — a fresh object per call is an infinite
   * re-render, and it is the classic way to write this wrong. */
  let cached: ModelsSnapshot | null = null
  const invalidate = (): void => {
    cached = null
    emit()
  }
  const unsubscribeController = controller.subscribe(invalidate)

  /** Best effort, but never silent: `null` when it could not be read, and the
      reason goes to the log rather than nowhere. */
  const attempt = async <T>(read: () => Promise<T>, event: string): Promise<T | null> => {
    try {
      return await read()
    } catch (error) {
      report?.(event, { message: messageOf(error) })
      return null
    }
  }

  return {
    getSnapshot: () => {
      if (cached === null) {
        const base = controller.getSnapshot()
        cached = { ...base, modelsDir, residentBytes }
      }
      return cached
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh: async () => {
      const mine = generations.claim()
      await controller.refresh()
      /* Both are best-effort and neither may fail the refresh: the models
       * folder is a convenience and the memory figure is honestly unknown
       * when the daemon is not running. */
      const [dir, resident] = await Promise.all([
        modelsDir === null
          ? attempt(() => plugin.revealModelsDir(), 'inference.models-dir-failed')
          : Promise.resolve(modelsDir),
        attempt(() => plugin.resourceUsage().then((usage) => usage.residentBytes), 'inference.resource-usage-failed'),
      ])
      /* GATHERED LOCALLY, COMMITTED TOGETHER, AND ONLY IF STILL CURRENT.
         Assigning each as it arrived meant a superseded refresh could write
         one field and a disposed one could write both. */
      if (!mine() || disposed) return
      modelsDir = dir
      residentBytes = resident
      invalidate()
    },
    install: (model) => controller.install(model),
    cancelInstall: () => controller.cancelInstall(),
    uninstall: (model) => controller.uninstall(model),

    dispose: () => {
      disposed = true
      unsubscribeController()
      listeners.clear()
    },
  }
}
