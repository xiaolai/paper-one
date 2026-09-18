import { createGenerations, defineSetting, messageOf, notifyAll } from '../../../kernel'
import type { Setting } from '../../../kernel'
import type { InferenceSnapshot, ReportFailure } from './controller'
import type { InferencePlugin, Route } from './plugin'

/**
 * WHICH ROUTE ANSWERS A LOOKUP — the reader's choice, what can answer now, and
 * the last probe that says so.
 *
 * ⚠️ **LOOK UP WAS ANSWERED BY THE LOCAL MODEL AND NOTHING ELSE, AND THAT WAS
 * F8.** An agent would "open a session and start a turn to define one word —
 * seconds, and a subscription turn spent, for a gesture a reader makes dozens
 * of times a chapter", and a metered endpoint was the same bill in another
 * envelope. The owner overturned it on 2026-09-18: the local model is a 2.5 GB
 * download a reader has to opt into, and a reader who has not should still be
 * able to look a word up. So any usable route may answer — the local model, an
 * OpenAI-compatible endpoint, the Claude CLI or the Codex CLI — and the reader
 * chooses in Settings → Look up, or leaves it on Automatic.
 *
 * What the cost argument still buys is the ORDER Automatic takes them in, which
 * is also the order of latency measured that day: the local model (about 1–2.5 s
 * a lookup, nothing spent), then endpoints in the order the probe lists them
 * (unmeasured, expected near the local model), then Claude (6–9 s), then Codex
 * (about 12 s). See `answeringRoute`.
 *
 * # Two sources, one answer
 *
 * THE LOCAL MODEL IS READ FROM THE CONTROLLER, and everything else from the
 * PROBE. The controller is the live authority for what is on disk and whether
 * the runtime is there — it is updated the moment a download or a removal
 * finishes, synchronously, and it is what a lookup's launch goes through. The
 * probe is the only thing that knows whether an endpoint has its key and its
 * model name, and whether an agent CLI is installed and signed in — but every
 * probe spawns the agent CLIs to ask them, so it is asked rarely (see
 * `RouteStore`) and its answer is held here rather than asked per lookup.
 */

/** The value of `GLOSS_ROUTE_SETTING` that means "whichever can answer first". */
export const AUTOMATIC = ''

/**
 * How long a stored route may be. The crate bounds a route id the way it bounds
 * a model id, and a longer one could only be a value nothing here wrote.
 */
const MAX_ROUTE = 256

/** A probe route id: `local:<id>`, `endpoint:<id>` or `agent:<name>`. */
const ROUTE_ID = /^(?:local|endpoint|agent):\S+$/u

/**
 * The route the reader chose for Look up, or `AUTOMATIC`.
 *
 * ⚠️ **A CHOICE IS NOT A PROMISE THAT IT CAN ANSWER.** The stored value is kept
 * exactly as the reader left it, whatever becomes of the route: a model removed,
 * an agent signed out, an endpoint deleted. `answeringRoute` treats a choice
 * that cannot answer now as Automatic, and the pane says so — and when the
 * route comes back, so does the choice, without the reader being asked twice.
 * That is the companion's rule too (`routesModel.resolveRoute`, WI-15.11).
 *
 * `parse` IS THE TRUST BOUNDARY (`core/ports.ts`): the settings file is JSON on
 * the reader's disk. Anything that is not the empty string or a route id's
 * shape is refused, and a refused value is the fallback, which is Automatic —
 * so the worst a damaged file can do is let the first usable route answer.
 * Nothing this parse lets through is ever sent anywhere on its own say-so: a
 * route reaches the plugin only when it matches a route that can answer now.
 */
export const GLOSS_ROUTE_SETTING: Setting<string> = defineSetting(
  // Stryker disable next-line StringLiteral: an empty key makes `defineSetting` throw while this module is imported, so every covering suite fails to load and Stryker's vitest runner reports it Survived — the key itself is asserted by `names its key and Automatic as its default`.
  'inference.glossRoute',
  AUTOMATIC,
  (raw) => {
    if (typeof raw !== 'string' || raw.length > MAX_ROUTE) return undefined
    return raw === AUTOMATIC || ROUTE_ID.test(raw) ? raw : undefined
  },
)

/** The route a local model answers on — the probe's own spelling (`probe.rs`). */
export const localRouteId = (model: string): string => `local:${model}`

/** The route an endpoint answers on — the probe's own spelling (`probe.rs`). */
export const endpointRouteId = (endpoint: string): string => `endpoint:${endpoint}`

/** Whether a route id is a local model's, which is the one kind that needs the runtime started. */
export const isLocalRoute = (route: string): boolean => route.startsWith('local:')

/**
 * Where a route falls in Automatic's order: the local model, then endpoints,
 * then Claude, then Codex — see the header for why this order.
 *
 * An agent this build has never heard of goes last rather than being refused:
 * the probe is the authority on what exists, and the order is only about which
 * to try first.
 */
function rank(route: Route): number {
  if (route.kind === 'local') return 0
  if (route.kind === 'endpoint') return 1
  if (route.id === 'agent:claude') return 2
  if (route.id === 'agent:codex') return 3
  return 4
}

/**
 * The routes in the order Automatic tries them — and the order the pane lists
 * them in, so "Automatic answers with the first of these that can" is true of
 * the list the reader is looking at. STABLE, so endpoints keep the probe's
 * order among themselves.
 */
export function inAnsweringOrder(routes: readonly Route[]): readonly Route[] {
  return [...routes].sort((a, b) => rank(a) - rank(b))
}

/**
 * The local routes that can answer now, the one Automatic uses first.
 *
 * NONE WHILE THE RUNTIME IS ABSENT, however many models are on disk: a model
 * with nothing to run it is not an answer, and a lookup sent to it fails at the
 * launch (the 2026-09-13 audit found `available` saying yes over exactly that).
 * `preferred` is the controller's `textModel()` — `glossModel`'s rule, smallest
 * first — and the other installed models follow it, so a reader who chose one of
 * them by name is answered by it.
 */
export function usableLocal(snapshot: Pick<InferenceSnapshot, 'runtime' | 'models'>, preferred: string | null): readonly string[] {
  if (snapshot.runtime.kind === 'absent') return []
  const installed = snapshot.models.filter((model) => model.installed && model.id !== preferred).map((model) => model.id)
  return (preferred === null ? installed : [preferred, ...installed]).map(localRouteId)
}

/**
 * The route that answers the next lookup, or `null` when nothing can.
 *
 * - **The reader's choice, when it can answer now.** A local choice is judged
 *   by the controller (`local`), anything else by the last probe.
 * - **Otherwise Automatic**: the preferred local model, then every usable
 *   endpoint in probe order, then Claude, then Codex.
 *
 * A LOCAL ROUTE IN THE PROBE IS NEVER READ HERE. The controller knows about a
 * download the moment it lands, and the probe knows only what was true when it
 * last ran — so a probe that predates an install or a removal must not decide
 * whether the local model answers.
 */
export function answeringRoute(chosen: string, local: readonly string[], probed: readonly Route[]): string | null {
  const remote = usableRemote(probed)
  /* AUTOMATIC NEEDS NO TEST OF ITS OWN: it is the empty string, and no route
     id is, so it is never among the routes that can answer. */
  if (local.includes(chosen) || remote.includes(chosen)) return chosen
  return local[0] ?? remote[0] ?? null
}

/**
 * The probed routes that can answer now, in Automatic's order — every one but
 * the local model's, which `usableLocal` reads from the controller instead.
 *
 * ONE DEFINITION OF "USABLE" for the decision and for the list that offers the
 * choice, so a row can never offer `Use` on a route the decision would pass
 * over. Usable is `unusable === null`, the probe's own sentence-and-code pair
 * read the way the companion reads it (`routesModel.resolveRoute`).
 */
export function usableRemote(probed: readonly Route[]): readonly string[] {
  return inAnsweringOrder(probed)
    .filter((route) => route.kind !== 'local' && route.unusable === null)
    .map((route) => route.id)
}

/**
 * The failure kinds that mean THE PROBE WAS WRONG about a route — so the next
 * lookup should not be decided by it.
 *
 * `modelUnknown` is the crate refusing a route its own probe calls unusable,
 * which is exactly a held probe gone stale; the `agent*` kinds are a CLI that
 * was installed and signed in when last asked and is not now; `keychain` is a
 * key the probe read and the lookup could not. Each is something a fresh probe
 * would report, after which Automatic moves on to the next route rather than
 * failing the same way on every word.
 *
 * NOT THE OTHERS. An endpoint that refused (`endpointHttp`) or could not be
 * reached (`endpointUnreachable`) is not something a probe asks about, and a
 * runtime failure is the controller's to know.
 */
export const ROUTE_FAILURE_KINDS: ReadonlySet<string | null> = new Set<string | null>([
  'modelUnknown',
  'agentMissing',
  'agentSignedOut',
  'agentUnsupportedVersion',
  'keychain',
])

/* ─────────────────────────────── the probe ─────────────────────────────── */

export interface RouteStoreSnapshot {
  /**
   * The last probe's routes, or `null` before any probe has answered.
   *
   * A PROBE THAT FAILED IS `[]`, not the routes before it: a route nobody could
   * ask about is not one to send a reader's words to on the strength of an
   * older answer. The failure is reported, and the local model — read from the
   * controller, not from here — still answers.
   */
  readonly routes: readonly Route[] | null
  /** True while a probe is out. */
  readonly probing: boolean
}

/**
 * The last probe, held — the one thing `answeringRoute` cannot ask for per
 * lookup.
 *
 * ⚠️ **NEVER ON A TIMER, AND NEVER PER LOOKUP.** Every probe spawns the agent
 * CLIs to ask them their version and whether they are signed in, and a lookup is
 * a gesture a reader makes dozens of times a chapter. So it is asked at four
 * moments, each one a reason to believe the answer changed: once when the
 * capability starts, when the Look up section is opened, when a local model is
 * installed or removed (`followLocal`), and after a lookup fails in a way that
 * says the probe was wrong (`ROUTE_FAILURE_KINDS`). The companion's route list
 * keeps its own and follows the same rule for the same reason.
 */
export interface RouteStore {
  getSnapshot(): RouteStoreSnapshot
  subscribe(listener: () => void): () => void
  /** Probe again. **Resolves; never rejects** — a failure is reported and read as no routes. */
  refresh(): Promise<void>
  dispose(): void
}

export interface RouteStoreOptions {
  readonly plugin: Pick<InferencePlugin, 'probe'>
  readonly report?: ReportFailure | undefined
}

const NOT_YET: RouteStoreSnapshot = { routes: null, probing: false }

export function createRouteStore({ plugin, report }: RouteStoreOptions): RouteStore {
  const listeners = new Set<() => void>()
  let snapshot = NOT_YET
  let disposed = false
  /* LAST ISSUED WINS. A probe runs child processes that finish in no
     particular order, so an older probe landing after a newer one would put
     back an answer that was already superseded. */
  const generations = createGenerations()

  const set = (next: RouteStoreSnapshot): void => {
    snapshot = next
    notifyAll(listeners, 'gloss routes')
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh: async () => {
      if (disposed) return
      const mine = generations.claim()
      set({ routes: snapshot.routes, probing: true })
      let routes: readonly Route[]
      try {
        routes = (await plugin.probe()).routes
      } catch (thrown) {
        /* REPORTED, because an empty list is also what a working machine with
           nothing set up looks like — the log is the only place the two can be
           told apart (the companion's route list learned this first). */
        try {
          report?.('inference.probe-failed', { message: messageOf(thrown) })
        } catch (again) {
          console.error('inference routes: the failure reporter itself threw', again, 'while reporting a failed probe')
        }
        routes = []
      }
      if (!mine() || disposed) return
      set({ routes, probing: false })
    },
    /* NO `listeners.clear()`: nothing notifies after this — `refresh` asks
       nothing once disposed, and a probe already out lands on nothing — so
       clearing would be a line no reader of the store could ever observe. */
    dispose: () => {
      disposed = true
    },
  }
}

/**
 * Probe again whenever the LOCAL answer changes — a model installed or removed,
 * a runtime that appeared or went away — and at no other notification.
 *
 * THE PROBE LISTS THE LOCAL MODELS TOO, and the Look up section draws them from
 * it; without this, a model installed with that section open stayed "Not
 * installed" beside an Automatic already answering with it. The controller
 * notifies on every byte of a download, so this compares what the local routes
 * ARE rather than probing on each notification: a download costs one probe, when
 * it lands.
 *
 * `current` is read now, so a caller that has just probed does not probe again
 * for a change it already saw.
 */
export function followLocal(
  controller: { subscribe(listener: () => void): () => void },
  current: () => readonly string[],
  refresh: () => void,
): () => void {
  /* COMPARED AS JSON, which has no separator to choose: two different lists
     can never spell the same key. */
  let seen = JSON.stringify(current())
  return controller.subscribe(() => {
    const now = JSON.stringify(current())
    if (now === seen) return
    seen = now
    refresh()
  })
}
