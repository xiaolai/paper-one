import { createElement } from 'react'
import type { Capability, CapabilityContext, Disposable } from '../../kernel'
import { ROUTE_SETTING } from './lib/settings'
import { inferencePort } from '../inference'
import { createCompanionProvider, type BoundCompanionProvider } from './lib/provider'
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
      render: () => (routesModel ? createElement(CompanionPane, { model: routesModel }) : null),
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
      if (routesModel === myRoutes) routesModel = null
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

    myProvider = createCompanionProvider({
      port,
      route: () => {
        const chosen = api.settings.get(ROUTE_SETTING)
        return chosen === '' ? null : chosen
      },
    })
    provider = myProvider
    unbindCompanion = api.services.bindCompanion(myProvider)

    myRoutes = createRoutesModel({ port, settings: api.settings })
    routesModel = myRoutes

    api.diagnostics.info('companion.started', { wired: true })
    return { dispose: stop }
  },
}

export { ROUTE_SETTING, TOOLS_SETTING } from './lib/settings'
export type { Passage, SourcePassage } from './lib/passages'
export { UNKNOWN_CITATION_NOTE, resolveCitations } from './lib/passages'
