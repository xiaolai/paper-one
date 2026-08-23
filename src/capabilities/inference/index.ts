import { createElement } from 'react'
import type { Capability, CapabilityContext, Disposable } from '../../kernel'
import { createController, type Controller } from './lib/controller'
import { createGlossProvider, type BoundGlossProvider } from './lib/glossProvider'
import { inferencePlugin, mintRequestId, type Depth, type InferencePlugin, type Probe } from './lib/plugin'
import { createModelsModel, downloadLine, type ModelsModel } from './ui/modelsModel'
import { ModelsPane } from './ui/ModelsPane'

/**
 * The `inference` capability — the local runtime, the model catalogue, and
 * the gloss.
 *
 * ⚠️ **IT NEVER FAILS TO START.** F2 is the reason this capability exists
 * separately from `companion` at all: `registry.ts` says in capitals that a
 * dependency which did not compose takes its dependants with it, and
 * `Settings.tsx` then renders `<id> is not running — its settings are
 * unavailable until the app is restarted`. If "nothing installed yet" were a
 * `start` failure, **every first launch would lose the Codex and Claude
 * entrances too** — a local runtime that has not been downloaded deleting two
 * routes that need no download at all.
 *
 * So `start()` binds a controller in `absent` and returns. It launches no
 * process at boot; the daemon starts on the first thing that genuinely needs
 * it, and only if a model is installed and the reader asked for it.
 *
 * **Not `lemonade`.** Naming a capability after a vendor would make the
 * fallback — LocalAI, if the Windows gate had failed — a rename of a
 * capability, a settings namespace and every persisted key under it.
 */

/* ---------------------------------------------------------- runtime state */

let running: {
  readonly plugin: InferencePlugin
  readonly controller: Controller
  readonly gloss: BoundGlossProvider
} | null = null
let modelsModel: ModelsModel | null = null

/**
 * The PORT — what `inference` offers the capabilities that `require` it.
 *
 * Deliberately narrow. `companion` gets generation, one agent turn and the
 * probe, and it does NOT get the gloss: that port is this capability's to
 * bind, so there is exactly one writer per port and the agent adapters never
 * appear on the gloss path at all (F8).
 */
export interface InferencePort {
  /** Stream an answer from a local model. */
  generate(
    model: string,
    system: string,
    question: string,
    onChunk: (text: string) => void,
    signal: AbortSignal,
  ): Promise<string>
  /** One tool-free turn from an agent CLI. */
  /**
   * One tool-free agent turn.
   *
   * THE SIGNAL IS NOT OPTIONAL HERE. `generate` has had one since it was
   * written; this took `null` and therefore ignored the reader's Stop, so a
   * cancelled question went on spending their subscription until the CLI
   * finished by itself.
   */
  agentAsk(
    route: string,
    prompt: string,
    depth: Depth,
    onChunk: (text: string) => void,
    signal: AbortSignal,
  ): Promise<string>
  /** Presence, version and auth for every route (WI-15.10). */
  probe(): Promise<Probe>
  /** Start the daemon if it is not up. False when it could not. */
  ensureReady(): Promise<boolean>
  signIn(route: string): Promise<void>
  subscribe(listener: () => void): () => void
}

/** The port, or null when `inference` has not started. */
export function inferencePort(): InferencePort | null {
  const held = running
  if (held === null) return null
  const { plugin, controller } = held

  /* Cancellation is wired to the caller's AbortSignal here rather than in the
   * plugin wrapper, so every consumer gets it without having to remember. */
  const withCancel = async <T,>(
    prefix: string,
    signal: AbortSignal | null,
    run: (requestId: string) => Promise<T>,
  ): Promise<T> => {
    const requestId = mintRequestId(prefix)
    const abort = (): void => void plugin.cancel(requestId).catch(() => {})
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await run(requestId)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  return {
    generate: async (model, system, question, onChunk, signal) => {
      if (!(await controller.ensureReady())) throw new Error('The runtime is not running')
      return withCancel('ask', signal, (id) => plugin.generate(id, model, system, question, onChunk))
    },
    /* NO `ensureReady` HERE, and it is not an omission: an agent route needs
     * no local daemon, which is the whole of F2's argument. Starting one to
     * ask Codex a question would make the download the local half needs a
     * prerequisite for the half that does not. */
    agentAsk: (route, prompt, depth, onChunk, signal) =>
      withCancel('agent', signal, (id) => plugin.agentAsk(id, route, prompt, depth, onChunk)),
    probe: () => plugin.probe(),
    ensureReady: () => controller.ensureReady(),
    signIn: (route) => plugin.agentSignIn(route),
    subscribe: (listener) => controller.subscribe(listener),
  }
}

/* -------------------------------------------------------------- capability */

export const inference: Capability = {
  id: 'inference',

  settings: [
    {
      id: 'inference:models',
      title: 'Local models',
      /* STORAGE-SHAPED, so it sits next to Storage. `peer/index.ts:53` says
       * the gap between Storage (10) and Devices (20) is there so something
       * can slot between without renumbering either, and bytes this machine
       * is holding is exactly that shape. */
      order: 15,
      render: () => (modelsModel ? createElement(ModelsPane, { model: modelsModel }) : null),
    },
  ],

  start(api: CapabilityContext, signal: AbortSignal): Disposable {
    const plugin = inferencePlugin
    const controller = createController(plugin, (event, fields) => api.diagnostics.warn(event, fields))
    const gloss = createGlossProvider({ plugin, controller })

    let stopped = false
    let unbindGloss: Disposable | null = null
    let unbindWorkLine: Disposable | null = null
    let myModels: ModelsModel | null = null
    let myRunning: typeof running = null

    const stop = (): void => {
      if (stopped) return
      stopped = true
      signal.removeEventListener('abort', stop)
      /* Ownership before clearing: an older stop firing after a restart must
       * not strip the newer start's state — the rule sync's own stop follows. */
      if (modelsModel === myModels) modelsModel = null
      if (running === myRunning) running = null
      for (const [label, unbind] of [
        ['unbindGloss', unbindGloss],
        ['unbindWorkLine', unbindWorkLine],
      ] as const) {
        try {
          unbind?.dispose()
        } catch (error) {
          api.diagnostics.warn('inference.teardown-step-failed', {
            label,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      controller.dispose()
      /* The daemon is a CHILD PROCESS, and it must not outlive the capability
       * that owns it. Best-effort and unawaited: `dispose` is synchronous and
       * Rust stops it again on app exit anyway. */
      void plugin.stop().catch(() => {})
    }
    api.onCleanup(stop)
    signal.addEventListener('abort', stop, { once: true })

    unbindGloss = api.services.bindGloss(gloss)
    /* The library status bar's third rung (WI-15.12). A download is the
       reader's own action, it reports a count, and it stops — the import
       line's own stated grounds for holding that slot. Nothing is published
       at rest. */
    unbindWorkLine = api.services.bindWorkLine({
      line: () => {
        const snapshot = controller.getSnapshot()
        return downloadLine(snapshot.runtime, snapshot.models)
      },
      subscribe: (listener) => controller.subscribe(listener),
    })
    myRunning = { plugin, controller, gloss }
    running = myRunning
    myModels = createModelsModel({ controller, plugin, settings: api.settings, kernel: api.services })
    modelsModel = myModels

    /* Read what is on disk, unawaited: `start` must not block the composition
     * on IPC, and the pane subscribes to the store so a late answer arrives
     * on its own. A failure here is a `degraded` state the pane shows, never
     * a `start` that throws — F2 again. */
    /* Not `.catch` — `refresh` never rejects, it degrades. The report goes
       through the controller's own hook, which is the only path a failure
       here actually takes. */
    void controller.refresh()

    api.diagnostics.info('inference.started', {})
    return { dispose: stop }
  },
}

export { KEEP_LOADED_SETTING, LOOK_UP_SETTING } from './lib/settings'
/**
 * The library status bar's download line, or null at rest (WI-15.12).
 *
 * Exported from the capability rather than pushed into the kernel, because
 * the kernel imports nothing from a capability: `App` reads it through the
 * composition, the same way it reads any other contributed value.
 */
export function inferenceDownloadLine(): string | null {
  const held = running
  if (held === null) return null
  const snapshot = held.controller.getSnapshot()
  return downloadLine(snapshot.runtime, snapshot.models)
}

export { useInference } from './ui/useInference'
export type { Controller, InferenceSnapshot, RuntimeState } from './lib/controller'
export { DEPTHS } from './lib/plugin'
export type { Depth, InstallProgress, ModelRow, Probe, Route, RouteKind } from './lib/plugin'
