import { createElement } from 'react'
import type { Capability, CapabilityContext, Disposable } from '../../kernel'
import { DEPTH_SETTING, ROUTE_SETTING } from './lib/settings'
import { inferencePort } from '../inference'
import { createCompanionProvider, effectiveRoute, type BoundCompanionProvider } from './lib/provider'
import { createRoutesModel, type RoutesModel } from './ui/routesModel'
import { CompanionPane } from './ui/CompanionPane'

/**
 * The `companion` capability — the provider binding, and which route answers.
 *
 * It `requires` `inference` and delegates to it, rather than the two sharing
 * a binding: there is exactly one writer per port, and **the agent adapters
 * never appear on the gloss path at all** (F8). With `companion` absent,
 * failed, or set to an agent, the gloss still works — the two features fail
 * separately because they are two features.
 *
 * # It is not one capability with the runtime, and F2 is why
 *
 * [Phase 5's diagram](../../../docs/plans/phase-05-kernel-capabilities.md)
 * draws the capability row as `peer — sync — companion — social`: one
 * `companion`, sketched before there was anything to put in it. A single
 * capability owning both the sidecar and the provider choice has exactly one
 * failure mode, and it is the common one — first launch, nothing downloaded —
 * taking the two routes that need no download down with it.
 */

/* ---------------------------------------------------------- runtime state */

let routesModel: RoutesModel | null = null
/**
 * Whether this platform has a system dictionary, as the kernel answers it.
 *
 * Kept beside `routesModel` because `render` is called by the settings pane
 * with no arguments, and this is a fact from `start`. Not derivable here: the
 * platform lives behind the kernel's React entry, which
 * `kernel-public-entry-only` puts out of a capability's reach — see
 * `KernelServices.hasDictionary`.
 */
let systemDictionary = false
let provider: BoundCompanionProvider | null = null

/** The bound provider, for a test and for the reader UI's thread. */
export function companionProvider(): BoundCompanionProvider | null {
  return provider
}

export const companion: Capability = {
  id: 'companion',
  requires: ['inference'],

  settings: [
    {
      id: 'companion:provider',
      title: 'Companion',
      /* ABOVE Storage (10) and Devices (20): the companion is a reading
       * surface, and the two below it are about machines and bytes. */
      order: 5,
      render: () =>
        routesModel
          ? createElement(CompanionPane, {
              model: routesModel,
              /* ASKED, NOT DEFAULTED. The prop used to be optional and this
                 call passed nothing, so macOS — the one platform with a
                 system dictionary — was told it had none. */
              hasDictionary: systemDictionary,
            })
          : null,
    },
  ],

  start(api: CapabilityContext, signal: AbortSignal): Disposable {
    let stopped = false
    let unbindCompanion: Disposable | null = null
    let myRoutes: RoutesModel | null = null
    let myProvider: BoundCompanionProvider | null = null

    const stop = (): void => {
      if (stopped) return
      stopped = true
      signal.removeEventListener('abort', stop)
      if (routesModel === myRoutes) {
        routesModel = null
        systemDictionary = false
      }
      if (provider === myProvider) provider = null
      try {
        unbindCompanion?.dispose()
      } catch (error) {
        api.diagnostics.warn('companion.teardown-step-failed', {
          label: 'unbindCompanion',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      myRoutes?.dispose()
    }
    api.onCleanup(stop)
    signal.addEventListener('abort', stop, { once: true })

    const port = inferencePort()
    if (port === null) {
      /* `inference` composed but did not publish a port — a browser tab, or a
       * platform without the plugin. NOT a failed start: the panel says the
       * companion is unavailable, exactly as it does today, and the reader's
       * marks and notes are unaffected. Throwing here would be F2's trap with
       * the roles reversed. */
      api.diagnostics.info('companion.started', { wired: false })
      return { dispose: stop }
    }

    myRoutes = createRoutesModel({
      port,
      settings: api.settings,
      kernel: api.services,
      report: (event, fields) => api.diagnostics.warn(event, fields),
    })
    routesModel = myRoutes
    systemDictionary = api.services.hasDictionary()

    myProvider = createCompanionProvider({
      port,
      /**
       * ONE ANSWER TO "WHICH ROUTE ANSWERS", and it is the model's.
       *
       * `ROUTE_SETTING`'s own header says `''` means "pick the best usable
       * one", which `resolveRoute` does — for the SETTINGS PANE. This getter
       * returned `null` for the same state, so a reader signed into Codex saw
       * the pane say `Codex · In use` while the Companion panel said the
       * companion was not available and refused to send. Two surfaces, one
       * question, opposite answers, and the false one was the common case: it
       * is what every reader sees before they ever open the settings group.
       *
       * The stored preference still wins; only the fall-back is read from the
       * one place that computes it.
       */
      route: () => {
        return effectiveRoute(api.settings.get(ROUTE_SETTING), myRoutes?.getSnapshot().inUse ?? null)
      },
      /* Both read per call, and both from THIS capability's own namespace —
         `companion.route` and `companion.depth`, which `scopeSettings` allows
         and the kernel's own settings are not. */
      depth: () => api.settings.get(DEPTH_SETTING),
    })
    provider = myProvider
    unbindCompanion = api.services.bindCompanion(myProvider)

    /* PROBED ONCE AT START, so the answer above EXISTS before the panel's
     * first render. WI-15.10 refuses a probe on a timer — four child
     * processes behind a shut pane is a reader's battery spent on a question
     * nobody asked — and this is not one: it is the single question the
     * Companion panel asks the moment it opens, and without it the panel's
     * first answer is a false negative. Unawaited, and a failure leaves the
     * snapshot empty, which reads as "nothing chosen" exactly as before. */
    void myRoutes.refresh()

    api.diagnostics.info('companion.started', { wired: true })
    return { dispose: stop }
  },
}

export { DEPTH_SETTING, ROUTE_SETTING, TOOLS_SETTING } from './lib/settings'
export type { Passage, SourcePassage } from './lib/passages'
export { UNKNOWN_CITATION_NOTE, resolveCitations } from './lib/passages'
