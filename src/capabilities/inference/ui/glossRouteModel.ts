import { messageOf, notifyAll, type SettingsStore } from '../../../kernel'
import type { InferenceStore, ReportFailure } from '../lib/controller'
import {
  AUTOMATIC,
  GLOSS_ROUTE_SETTING,
  answeringRoute,
  endpointRouteId,
  inAnsweringOrder,
  isLocalRoute,
  localRouteId,
  usableLocal,
  usableRemote,
  type RouteStore,
} from '../lib/glossRoute'
import type { Endpoint, InferencePlugin, Route } from '../lib/plugin'
import { hostOf } from './endpointsModel'

/**
 * The **Answers with** list at the top of Settings → Look up — its decisions,
 * with no React, so they can be tested.
 *
 * `GlossPromptPane.tsx` draws what this decides. THE SAME SHAPE AS THE
 * COMPANION'S ROUTE LIST (`routesModel.ts`), for that file's reason:
 * `CAPABILITY_UI` has rows and buttons and no menu, so a row whose button is
 * the selector is the control — and it is the one a reader has already met.
 *
 * # What is listed, and in what order
 *
 * **Automatic** first, then every route the last probe reported, in the order
 * Automatic tries them (`inAnsweringOrder`) — so "Automatic answers with the
 * first of these that can" is true of the list on screen. A route that cannot
 * answer is listed with its reason and nothing to press: §07's
 * disabled-and-says-why, and a reader who sees `Signed out` beside Claude knows
 * what would make it an option.
 *
 * # "In use" is what is in EFFECT, not what was stored
 *
 * A stored choice that cannot answer now — a model removed, an agent signed out
 * — is kept exactly as it is (`GLOSS_ROUTE_SETTING`), and Look up answers as
 * Automatic meanwhile. So the Automatic row carries `In use` then, and a
 * sentence under the list says which route was chosen and why it is not the
 * one answering. The companion's list learned that a silent fallback is the
 * worse defect of the two (WI-15.11).
 */

/** What a row's control does. */
export type ChoiceAction = 'use' | 'in-use' | 'none'

export interface RouteChoice {
  /** `AUTOMATIC` for the Automatic row, a probe route id for the rest. */
  readonly id: string
  readonly label: string
  /** The row's quiet right-hand side — see `choicesFor`. */
  readonly value: string
  readonly action: ChoiceAction
}

export interface GlossRouteSnapshot {
  readonly choices: readonly RouteChoice[]
  /** True while a probe is out — the list may be about to change. */
  readonly checking: boolean
  /** The route answering the next lookup, or `null` when nothing can. */
  readonly answering: string | null
  /**
   * ONE QUIET SENTENCE: where a lookup's words go, for the route answering now —
   * or, when nothing can answer, what would change that. See `whereTheWordsGo`.
   */
  readonly where: string
  /**
   * The reader's stored choice, by its label, when it cannot answer now — the
   * fall-back the list must not keep quiet about — or `null`.
   */
  readonly unavailableChoice: string | null
}

/** What every lookup sends, whichever route it goes to — `glossQuestion` builds it. */
const WHAT_IS_SENT = 'Each word you look up, with its sentence and the book’s title,'

/**
 * Where the words go, per route — the sentence a reader needs before choosing
 * a route that is not on this machine.
 *
 * ⚠️ **AN ENDPOINT IS NAMED BY ITS HOST, NOT ITS LABEL.** The label is whatever
 * the reader typed into the name field; the host is where the words actually
 * go, and a row called `local` whose address is somebody's server must not read
 * as though it were this machine. The label is the fallback only when the
 * endpoint list has no entry for the route — which is an endpoint removed since
 * the last probe, and one the next probe will not list.
 *
 * AN AGENT IS NAMED BY ITS VENDOR, because that is who receives the words: the
 * CLI is the reader's own signed-in client, and the request leaves through it.
 */
export function whereTheWordsGo(route: string | null, labelOf: (route: string) => string, endpoints: readonly Endpoint[]): string {
  if (route === null) {
    return 'Nothing can answer yet. Install a model in Local models, add an endpoint in Cloud endpoints, or install and sign in to Claude or Codex.'
  }
  if (isLocalRoute(route)) return `${WHAT_IS_SENT} stays on this machine.`
  if (route.startsWith('endpoint:')) {
    const stored = endpoints.find((one) => endpointRouteId(one.id) === route)
    return `${WHAT_IS_SENT} is sent to ${stored === undefined ? labelOf(route) : hostOf(stored.baseUrl)}.`
  }
  if (route === 'agent:claude') return `${WHAT_IS_SENT} is sent to Anthropic through your signed-in CLI.`
  if (route === 'agent:codex') return `${WHAT_IS_SENT} is sent to OpenAI through your signed-in CLI.`
  return `${WHAT_IS_SENT} is sent through ${labelOf(route)}.`
}

/**
 * The list, given what was chosen, what can answer, and what the probe found.
 *
 * `usable` is the set `answeringRoute` chose from — the controller's local
 * routes and the probe's usable others — so a row offers `Use` exactly when
 * choosing it would make it the one that answers. The VALUE is the probe's own
 * words: the reason when it cannot answer, its detail when it can.
 */
export function choicesFor(
  chosen: string,
  answering: string | null,
  automatic: string | null,
  usable: readonly string[],
  probed: readonly Route[],
  labelOf: (route: string) => string,
): readonly RouteChoice[] {
  /* IN EFFECT: the stored choice when it is the one answering, Automatic
     otherwise — Automatic itself included, since no route answers as `''`. */
  const inEffect = chosen === answering ? chosen : AUTOMATIC
  const automaticRow: RouteChoice = {
    id: AUTOMATIC,
    label: 'Automatic',
    /* WHICH ROUTE AUTOMATIC MEANS TODAY, by name — "Automatic" alone says
       nothing about where a word is about to be sent. */
    value: automatic === null ? 'Nothing can answer yet' : labelOf(automatic),
    action: inEffect === AUTOMATIC ? 'in-use' : 'use',
  }
  return [
    automaticRow,
    ...inAnsweringOrder(probed).map((route): RouteChoice => {
      const selectable = usable.includes(route.id)
      return {
        id: route.id,
        label: route.label,
        value: route.unusable ?? route.detail ?? '',
        action: !selectable ? 'none' : route.id === inEffect ? 'in-use' : 'use',
      }
    }),
  ]
}

export interface GlossRouteModel {
  getSnapshot(): GlossRouteSnapshot
  subscribe(listener: () => void): () => void
  /** Probe again and re-read the endpoint list — the section was opened. Never rejects. */
  refresh(): Promise<void>
  /** Choose a route, or `AUTOMATIC`. */
  use(id: string): void
  dispose(): void
}

export interface GlossRouteModelOptions {
  readonly settings: SettingsStore
  readonly routes: RouteStore
  readonly controller: InferenceStore & { textModel(): string | null }
  /** Only the endpoint list — for the host an endpoint's words go to. */
  readonly plugin: Pick<InferencePlugin, 'endpoints'>
  readonly report?: ReportFailure | undefined
}

export function createGlossRouteModel({ settings, routes, controller, plugin, report }: GlossRouteModelOptions): GlossRouteModel {
  const listeners = new Set<() => void>()
  let endpoints: readonly Endpoint[] = []
  let cached: GlossRouteSnapshot | null = null

  const invalidate = (): void => {
    cached = null
    notifyAll(listeners, 'Look up routes')
  }
  /* EVERYTHING THE ANSWER IS MADE OF, heard: the choice, the probe, and the
     local model — a download finishing with this section open changes which
     route Automatic means. */
  const unsubscribe = [settings.subscribe(invalidate), routes.subscribe(invalidate), controller.subscribe(invalidate)]

  const build = (): GlossRouteSnapshot => {
    const chosen = settings.get(GLOSS_ROUTE_SETTING)
    const probe = routes.getSnapshot()
    const probed = probe.routes ?? []
    const local = controller.getSnapshot()
    const usableHere = usableLocal(local, controller.textModel())
    const answering = answeringRoute(chosen, usableHere, probed)
    /* A ROUTE BY ITS NAME: the probe's label, or — for the local model before
       the first probe has answered — the catalogue's, and the bare id only
       when neither knows it (a stored choice nothing lists any more). */
    const labelOf = (route: string): string =>
      probed.find((one) => one.id === route)?.label ??
      local.models.find((model) => localRouteId(model.id) === route)?.label ??
      route
    return {
      choices: choicesFor(chosen, answering, answeringRoute(AUTOMATIC, usableHere, probed), [...usableHere, ...usableRemote(probed)], probed, labelOf),
      checking: probe.probing,
      answering,
      where: whereTheWordsGo(answering, labelOf, endpoints),
      unavailableChoice: chosen === AUTOMATIC || chosen === answering ? null : labelOf(chosen),
    }
  }

  const readEndpoints = async (): Promise<void> => {
    try {
      endpoints = await plugin.endpoints()
    } catch (thrown) {
      /* THE SENTENCE FALLS BACK TO THE ROUTE'S LABEL, which is still the
         reader's own name for it — so a list that would not read costs the
         host in one sentence, and the log says why. */
      report?.('inference.endpoints-failed', { message: messageOf(thrown) })
      return
    }
    /* Told even after a dispose, which is harmless and says nothing: the
       listeners are gone by then, and so is the pane that held them. */
    invalidate()
  }

  return {
    getSnapshot: () => {
      if (cached === null) cached = build()
      return cached
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh: async () => {
      await Promise.all([routes.refresh(), readEndpoints()])
    },
    use: (id) => settings.set(GLOSS_ROUTE_SETTING, id),
    dispose: () => {
      for (const stop of unsubscribe) stop()
      /* A LIST STILL BEING READ lands after this and notifies — nobody, once
         these are gone. */
      listeners.clear()
    },
  }
}
