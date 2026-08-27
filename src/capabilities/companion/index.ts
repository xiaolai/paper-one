import { createElement } from 'react'
import { createRenderSlot, openSession, type Capability, type CapabilityContext, type Disposable } from '../../kernel'
import { DEPTH_SETTING, ROUTE_SETTING } from './lib/settings'
import { inferencePort } from '../inference'
import { createCompanionProvider, effectiveRoute } from './lib/provider'
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
 * [Phase 5's diagram](../../../dev-docs/plans/phase-05-kernel-capabilities.md)
 * draws the capability row as `peer — sync — companion — social`: one
 * `companion`, sketched before there was anything to put in it. A single
 * capability owning both the sidecar and the provider choice has exactly one
 * failure mode, and it is the common one — first launch, nothing downloaded —
 * taking the two routes that need no download down with it.
 */

/* ---------------------------------------------------------- runtime state */

/**
 * What the settings section draws.
 *
 * A SLOT WITH RESTORATION, not a bare `let`. `render` is called by the pane
 * with no arguments, so this has to be module-scoped — and the hand-written
 * version could not tell a stop that follows a newer start from a stop of the
 * only start there is: two live compositions left the second's teardown
 * blanking a pane the first was still serving. See `createRenderSlot`.
 *
 * ⚠️ IT USED TO BE `{ model, hasDictionary }` — a pair, because the pane drew
 * the Look up cycle and the platform's dictionary was a fact from `start` that
 * could not be derived here. Both the row and the fact are gone, so the slot
 * holds the model alone again.
 */
const section = createRenderSlot<RoutesModel>()

/* ⚠️ NO MODULE-GLOBAL `provider`, AND NO `companionProvider()` ACCESSOR.
 *
 * There were both, with a comment saying they were "for a test and for the
 * reader UI's thread" — and neither read them. The thread takes the provider
 * from `services.companion()`, which is the port this capability binds, so the
 * global was a second reference to the same object with its own ownership
 * check, its own assignment and its own clearing on stop. One live path and
 * one dead one, and only the dead one looked like the public entry. */

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
      render: () => {
        const held = section.current()
        return held === null ? null : createElement(CompanionPane, { model: held })
      },
    },
  ],

  start(api: CapabilityContext, signal: AbortSignal): Disposable {
    /* EVERYTHING THIS ACQUIRES, OWNED BY ONE THING — see `openSession`. The
     * `stopped` flag, the listener removal and a guarded step per resource
     * were written out here, and `routesModel.dispose()` ran bare after the
     * one step that was guarded: a throw there escaped the abort listener with
     * `stopped` already true, so the registry's later cleanup returned at once
     * and could neither retry nor report it. */
    const session = openSession(api, signal, 'companion.teardown-step-failed')

    const port = inferencePort()
    if (port === null) {
      /* `inference` composed but did not publish a port — a browser tab, or a
       * platform without the plugin. NOT a failed start: the panel says the
       * companion is unavailable, exactly as it does today, and the reader's
       * marks and notes are unaffected. Throwing here would be F2's trap with
       * the roles reversed. */
      api.diagnostics.info('companion.started', { wired: false })
      return { dispose: session.stop }
    }

    const routes = createRoutesModel({
      port,
      settings: api.settings,
      report: (event, fields) => api.diagnostics.warn(event, fields),
    })
    session.own('routesModel', () => routes.dispose())
    /* HELD NOW, released later — `hold` is the acquisition and the disposer it
       returns is what the session owns. */
    const showing = section.hold(routes)
    session.own('section', () => showing.dispose())

    const boundProvider = createCompanionProvider({
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
        return effectiveRoute(api.settings.get(ROUTE_SETTING), routes.getSnapshot().inUse ?? null)
      },
      /* Both read per call, and both from THIS capability's own namespace —
         `companion.route` and `companion.depth`, which `scopeSettings` allows
         and the kernel's own settings are not. */
      depth: () => api.settings.get(DEPTH_SETTING),
    })
    const unbindCompanion = api.services.bindCompanion(boundProvider)
    session.own('unbindCompanion', () => unbindCompanion.dispose())

    /* PROBED ONCE AT START, so the answer above EXISTS before the panel's
     * first render. WI-15.10 refuses a probe on a timer — four child
     * processes behind a shut pane is a reader's battery spent on a question
     * nobody asked — and this is not one: it is the single question the
     * Companion panel asks the moment it opens, and without it the panel's
     * first answer is a false negative. Unawaited, and a failure leaves the
     * snapshot empty, which reads as "nothing chosen" exactly as before. */
    void routes.refresh()

    api.diagnostics.info('companion.started', { wired: true })
    return { dispose: session.stop }
  },
}

export { DEPTH_SETTING, ROUTE_SETTING } from './lib/settings'
export type { Passage, SourcePassage } from './lib/passages'
export { resolveCitations } from './lib/passages'
