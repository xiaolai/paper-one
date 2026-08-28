import { messageOf } from './lib/messageOf'
import { createElement } from 'react'
import { createRenderSlot, openSession, type Capability, type CapabilityContext, type Disposable } from '../../kernel'
import { createController, type Controller } from './lib/controller'
import { createGlossProvider } from './lib/glossProvider'
import { cancelRequest, inferencePlugin, mintRequestId, type Depth, type InferencePlugin, type Probe } from './lib/plugin'
import { createModelsModel, downloadLine, type ModelsModel } from './ui/modelsModel'
import { ModelsPane } from './ui/ModelsPane'
import { createEndpointsModel, type EndpointsModel } from './ui/endpointsModel'
import { EndpointsPane } from './ui/EndpointsPane'

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
  /** Told when a cancel fails for a reason that is not the expected race. */
  readonly report: (event: string, fields: Record<string, unknown>) => void
} | null = null
/**
 * What the Local models section draws.
 *
 * ⚠️ THE SAME SLOT `companion` USES, and it had the same defect: a bare `let`
 * with an `=== mine` ownership check, which stops an OLD lifetime clearing a
 * newer one's value and does nothing about two LIVE ones. Two compositions
 * left the second overwriting the first, and stopping the second blanked a
 * pane the first was still serving. See `createRenderSlot`.
 */
const section = createRenderSlot<ModelsModel>()
/** The same slot again, for the Cloud endpoints section. */
const endpointsSection = createRenderSlot<EndpointsModel>()

/**
 * Which start is the current one.
 *
 * ⚠️ **AN OLD LIFETIME COULD STOP THE NEW ONE'S DAEMON.** `plugin.stop()` is
 * fire-and-forget and addresses the plugin-wide daemon, not this capability's
 * copy of it — there is only one. So on a rapid restart the outgoing
 * lifetime's stop could land AFTER the incoming one had started a daemon and
 * begun answering, cancelling its requests and killing its child process. The
 * ownership checks around `running` and the render slot do not cover it, because
 * the action they guard is scheduled and lands later.
 */
let lifetime = 0

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
    signal: AbortSignal,
    run: (requestId: string) => Promise<T>,
  ): Promise<T> => {
    /* ⚠️ CHECKED BEFORE THE LISTENER IS ADDED. `addEventListener('abort')` does
     * not replay an abort that has already happened, so a signal cancelled
     * before this ran registered a handler that would never fire and the work
     * started anyway. `generate` below makes that a real window rather than a
     * theoretical one: it awaits `ensureReady()` first, which is a process
     * launch, and a reader pressing Stop during it was ignored. */
    signal.throwIfAborted()
    const requestId = mintRequestId(prefix)
    const abort = (): void => cancelRequest(plugin, requestId, held.report)
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await run(requestId)
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  return {
    generate: async (model, system, question, onChunk, signal) => {
      /* Before the start as well as after it. The check here refuses to
         BEGIN a launch for a reader who has already given up; a launch in
         flight is not cancelled by an abort during it — the daemon is shared
         by every later question, and stopping it for one reader's Stop would
         cost the next question the seconds it just paid. `withCancel` checks
         again on the far side, so the request itself never starts. */
      signal.throwIfAborted()
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
      render: () => {
        const model = section.current()
        return model === null ? null : createElement(ModelsPane, { model })
      },
    },
    {
      id: 'inference:endpoints',
      title: 'Cloud endpoints',
      /* AFTER Local models (15), because it is the same subject one step
         further out: this machine's models, then somebody else's. */
      order: 16,
      render: () => {
        const model = endpointsSection.current()
        return model === null ? null : createElement(EndpointsPane, { model })
      },
    },
  ],

  start(api: CapabilityContext, signal: AbortSignal): Disposable {
    const plugin = inferencePlugin
    /* ONE reporter, handed to everything that reports — it was built four
       times, once per consumer. */
    const report = (event: string, fields: Record<string, unknown>): void => api.diagnostics.warn(event, fields)
    const controller = createController(plugin, report)
    const gloss = createGlossProvider({ plugin, controller, report })

    const myLifetime = ++lifetime
    /* EVERYTHING THIS ACQUIRES, OWNED BY ONE THING — see `openSession`. The
     * `stopped` flag, the listener removal, the guarded-step loop and a
     * nullable `let` per resource were written out here, and the one resource
     * that never made it into the list survived every teardown for months. */
    const session = openSession(api, signal, 'inference.teardown-step-failed')
    session.own('controller', () => controller.dispose())

    const unbindGloss = api.services.bindGloss(gloss)
    session.own('unbindGloss', () => unbindGloss.dispose())

    /* The library status bar's third rung (WI-15.12). A download is the
       reader's own action, it reports a count, and it stops — the import
       line's own stated grounds for holding that slot. Nothing is published
       at rest. */
    const unbindWorkLine = api.services.bindWorkLine({
      line: () => {
        const snapshot = controller.getSnapshot()
        return downloadLine(snapshot.runtime, snapshot.models)
      },
      subscribe: (listener) => controller.subscribe(listener),
    })
    session.own('unbindWorkLine', () => unbindWorkLine.dispose())

    const myRunning = { plugin, controller, report }
    running = myRunning
    /* Ownership before clearing: an older stop firing after a restart must not
       strip the newer start's state — the rule sync's own stop follows. */
    session.own('running', () => {
      if (running === myRunning) running = null
    })

    const models = createModelsModel({
      controller,
      plugin,
      settings: api.settings,
      report,
    })
    /* ⚠️ THE MODEL IS DISPOSED TOO. Only the tests ever called this, so in the
       running app a settings subscription, an `Audio` element, a blob URL and
       any voice request in flight survived every teardown and accumulated
       across restarts — a leak that is invisible because each one on its own
       is small. Owning it is what makes forgetting it impossible. */
    session.own('modelsModel', () => models.dispose())
    const showing = section.hold(models)
    session.own('section', () => showing.dispose())

    /* CLOUD ENDPOINTS (WI-15.8). Everything under this pane was built and
       tested and had no caller: the four commands existed, were permitted, and
       nothing under `src/` invoked them, so the keychain path, the
       provisioning and the per-start registration could never run in the app.
       An audit found it; the feature ledger had called it Shipped. */
    const endpoints = createEndpointsModel({ plugin, report })
    session.own('endpointsModel', () => endpoints.dispose())
    const showingEndpoints = endpointsSection.hold(endpoints)
    session.own('endpointsSection', () => showingEndpoints.dispose())

    /* The daemon is a CHILD PROCESS, and it must not outlive the capability
     * that owns it. Best-effort and unawaited: `dispose` is synchronous and
     * Rust stops it again on app exit anyway.
     *
     * ⚠️ ONLY IF NOTHING HAS STARTED SINCE. There is one daemon for the
     * plugin, not one per lifetime, so an outgoing stop landing after an
     * incoming start killed the NEW capability's runtime and cancelled its
     * requests. An ownership check made where the stop is REGISTERED cannot
     * cover it: that check runs now and this action lands later.
     *
     * OWNED LAST, so it is released FIRST — nothing else here depends on the
     * daemon, and the child process is the thing worth stopping soonest. */
    session.own('daemon', () => {
      /* Reported, not swallowed: a stop that fails is a daemon still running
         after the capability that owned it is gone. */
      if (lifetime === myLifetime) {
        void plugin.stop().catch((thrown: unknown) => report('inference.stop-failed', { message: messageOf(thrown) }))
      }
    })

    /* Read what is on disk, unawaited: `start` must not block the composition
     * on IPC, and the pane subscribes to the store so a late answer arrives
     * on its own. A failure here is a `degraded` state the pane shows, never
     * a `start` that throws — F2 again. */
    /* Not `.catch` — `refresh` never rejects, it degrades. The report goes
       through the controller's own hook, which is the only path a failure
       here actually takes. */
    void controller.refresh()

    api.diagnostics.info('inference.started', {})
    return { dispose: session.stop }
  },
}

/* THE DOWNLOAD LINE IS THE WORK-LINE BINDING, and only that.
 *
 * An `inferenceDownloadLine()` export lived here beside it, with a comment
 * saying `App` read it through the composition — which had stopped being true:
 * `App` reads the bound work-line service, and the export's only remaining
 * caller was a test of itself. Two implementations of one status line, one of
 * them dead and documented as live, is how the live one comes to be changed
 * without the dead one and nobody notices which is which. See `start`. */

export { DEPTHS, errorKind, reasonOf } from './lib/plugin'
/* `detailFor` and `errorKind` are what `companion` translates a failed answer
 * with (WI-20.18) — the same pair `glossProvider` uses, and for the same
 * reason: the reader's sentence for a `kind` has one home, and the kernel's
 * thread cannot reach it. */
export { detailFor } from './lib/controller'
export { messageOf } from './lib/messageOf'
/* ⚠️ EXACTLY WHAT `companion` IMPORTS, AND NOTHING ELSE. This list carried
 * `InstallProgress`, `ModelRow` and `RouteKind` too, plus the keep-loaded setting (since removed — see `ModelsPane`),
 * `useInference` and three controller types on their own lines — none of which
 * any module outside this directory imported. A capability barrel exists to
 * serve the capabilities that `require` this one, and `companion` is the only
 * one; a re-export past that is loaded with the barrel and read by nobody. */
export type { Depth, Probe, Route, UnusableReason } from './lib/plugin'
