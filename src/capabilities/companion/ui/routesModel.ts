import type { SettingsStore } from '../../../kernel'
import { createGenerations } from '../../../kernel'
import type { Depth } from '../../inference'
import { reasonOf, type InferencePort, type Probe, type Route } from '../../inference'
import { DEPTH_SETTING, ROUTE_SETTING } from '../lib/settings'

/**
 * The route list's decisions — no React, so they can be tested.
 *
 * # One list, because the reader has one question
 *
 * The reader's question is *"which one answers?"*, not *"which provider, and
 * then which model?"*. Those were two rows in an earlier draft of the plan
 * and they are one question, so they are one list: every usable route is a
 * row — each installed local model, Codex, Claude, and each registered
 * endpoint.
 *
 * # A list, not a menu, and the boundary decides it
 *
 * `CAPABILITY_UI` has `paper-cap-row` (a div) and `paper-cap-button` (a pill)
 * and nothing in between — so a row-as-radio is unavailable, but **a row
 * whose action is the selector** is. That is also the shape the model list
 * already uses, which is why one list can do provisioning and selection at
 * once: a local model that is not installed carries `Install` instead of
 * `Use`, and nothing becomes two lists.
 *
 * Two earlier drafts got this wrong in the same direction — first a full-bleed
 * clickable row (the kernel's `CycleRow`, built from a CSS Module hashed at
 * build time and reachable only by importing it, which
 * `kernel-public-entry-only` forbids), then a cycle button, which is
 * buildable but does not survive seven routes.
 *
 * # The route list is a list because it GROWS
 *
 * Three local models, two agents and an endpoint is six rows and climbing. A
 * cycle is right where the set is CLOSED and wrong where it is open, which is
 * the distinction the earlier draft missed by applying one answer to both.
 *
 * ⚠️ THIS SECTION USED TO SAY "`Look up` IS a cycle button, and that is not a
 * contradiction" — the closed three-state set was the counter-example that
 * made the rule legible. There is no such control: the system-dictionary
 * hand-off is deleted and the gloss is the whole of Look up. Caught by audit,
 * one commit after the row it described stopped existing.
 */

/** What a row's button does. */
export type RowAction = 'use' | 'install' | 'sign-in' | 'in-use' | 'none' | 'check-again'

/**
 * What the effort row shows, and the order it cycles in.
 *
 * `default` FIRST and named for what it is: the reader's own account setting,
 * which they already pay for. The other two are Paper asking their CLI to
 * spend less or more, and each adapter spends it on the axis its own CLI
 * offers — see `agentask.rs`.
 */
export const DEPTH_ORDER: readonly Depth[] = ['default', 'faster', 'thorough']
export const DEPTH_LABELS: Readonly<Record<Depth, string>> = {
  default: 'Account default',
  faster: 'Faster',
  thorough: 'More thorough',
}

export interface RouteRow {
  readonly id: string
  readonly label: string
  /** The right-hand value: the detail when usable, the reason when not. */
  readonly value: string
  readonly action: RowAction
  /* ⚠️ `unusable: boolean` WAS HERE and nothing outside a test read it — the
   * pane draws `action` and `value`, both of which already say it. Removed as
   * dead public surface; the tests that asserted it now assert what the reader
   * actually sees. Found by audit. */
}

export interface RoutesSnapshot {
  readonly rows: readonly RouteRow[]
  /* ⚠️ `signingIn: string | null` WAS HERE. The FACT it recorded still is —
   * a module-local `signingIn` still drives every row through `actionFor` —
   * but nothing outside a test read it off the snapshot: the pane draws
   * `action` and `value`, which is where a waiting row already says
   * `Check again` and `Waiting for sign-in…`. Removed as dead public surface;
   * the tests that asserted it assert the row instead. Found by audit.
   *
   * The behaviour is worth keeping written down, because it was a real defect.
   * SIGNING IN USED TO CHANGE NOTHING ON SCREEN: `agent_sign_in` launches the
   * vendor's own login in a browser and returns at once — the credential is
   * theirs and Paper never holds it — so nothing here learned that it had
   * finished. The row went on saying `Signed out` however long the reader
   * spent logging in, and pressing it again launched a second flow. So the
   * press is a state: the row says it is waiting and offers `Check again`,
   * which re-probes. One flow at a time, and a way out of it. */
  /** The route in use, or null when nothing can answer. */
  readonly inUse: string | null
  /** True when the reader's stored choice is no longer usable. */
  readonly fellBack: boolean
  /**
   * The effort label, or null when the control does not apply.
   *
   * NULL FOR A LOCAL MODEL, because neither flag exists there: `lemond` is
   * handed a model id, not a reasoning effort or an alias. A row that did
   * nothing when pressed is the thing §07 exists to prevent.
   */
  readonly depth: string | null
  readonly loading: boolean
}

/**
 * Which route actually answers, given what the reader chose and what the
 * probe found.
 *
 * WI-15.11's acceptance names the hard case: *"uninstalling the model in use
 * falls back to a named route and says so rather than silently answering from
 * somewhere else."* So a stored choice that is no longer usable does NOT
 * silently become the first row — the caller is told it fell back, and the
 * stored value is left alone so re-installing restores it without the reader
 * asking twice.
 */
export function resolveRoute(
  chosen: string,
  routes: readonly Route[],
): { readonly inUse: string | null; readonly fellBack: boolean } {
  const usable = routes.filter((route) => route.unusable === null && route.modality === 'text')
  if (usable.length === 0) return { inUse: null, fellBack: chosen !== '' }
  if (usable.some((route) => route.id === chosen)) return { inUse: chosen, fellBack: false }
  /* Local before agent before endpoint: the local route costs the reader
   * nothing per question and is the one the phase is built around. */
  const order: Record<string, number> = { local: 0, agent: 1, endpoint: 2 }
  const sorted = [...usable].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
  return { inUse: sorted[0]!.id, fellBack: chosen !== '' }
}

/**
 * Turn one probe route into a row, given what is in use.
 *
 * `signingIn` is the route the reader has a login flow open for, if any — see
 * `RoutesSnapshot.signingIn`.
 */
export function rowFor(route: Route, inUse: string | null, signingIn: string | null = null): RouteRow {
  const action = actionFor(route, inUse, signingIn)
  return {
    id: route.id,
    label: route.label,
    value: valueFor(route, action),
    action,
  }
}

/**
 * Which control a route offers, exhaustively and in one direction.
 *
 * ⚠️ **IT WAS A FOUR-LEVEL NESTED TERNARY**, and the precedence of the states
 * inside it could only be read by counting brackets. Early returns say the
 * same thing in the order it is actually decided: usable first, then the two
 * reasons that have a fix, then the ones that do not. Found by audit.
 *
 * ⚠️ THE CODE, NOT THE SENTENCE. This compared `route.unusable` against the
 * exact strings `'Not installed'` and `'Signed out'`, so the wording in
 * `probe.rs` and the button drawn here were the same field: rephrasing a
 * reason turned `[Install]` into a dead row silently. It also had to add
 * `kind === 'local'` to tell a model Paper can download from a CLI the reader
 * must install, because those two share a sentence — they no longer share a
 * code.
 */
function actionFor(route: Route, inUse: string | null, signingIn: string | null): RowAction {
  if (route.unusable === null) return route.id === inUse ? 'in-use' : 'use'
  const reason = reasonOf(route)
  if (reason === 'notInstalled') return 'install'
  if (reason !== 'signedOut') return 'none'
  /* Already waiting on a login this reader opened: offer the way to find out
     rather than a second copy of the flow. */
  return route.id === signingIn ? 'check-again' : 'sign-in'
}

/**
 * The row's right-hand side: the detail when usable, the reason when not.
 *
 * An unusable route shows the REASON, which is §07's disabled-and-says-why
 * rather than a control that fails when pressed.
 */
function valueFor(route: Route, action: RowAction): string {
  if (action === 'check-again') return 'Waiting for sign-in…'
  return route.unusable ?? route.detail ?? ''
}


export interface RoutesModel {
  getSnapshot(): RoutesSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  use(id: string): void
  signIn(id: string): Promise<void>
  /** Advance the effort one place. */
  cycleDepth(): void
  dispose(): void
}

export interface RoutesModelOptions {
  readonly port: InferencePort
  readonly settings: SettingsStore
  /* ⚠️ `kernel: Pick<KernelServices, 'lookUp' | 'cycleLookUp'>` USED TO BE
   * HERE. This pane drew the Look up cycle, and the value it cycled was
   * `kernel.lookUp` — unreachable through `settings`, because `scopeSettings`
   * confines this capability to `companion.` and the read threw on the pane's
   * first render. The accessors existed to get around that. The row, the
   * setting and the accessors are all deleted together: there is one Look up
   * behaviour now, so there is nothing to cycle. */
  /**
   * Told when launching a vendor's login flow fails.
   *
   * A missing CLI, a spawn that was refused. The reader sees the row return to
   * `Sign in…`; this is the maintainer's half, which was previously the
   * rejection of a promise nobody caught.
   */
  readonly report?: (event: string, fields: Record<string, unknown>) => void
}

const EMPTY: RoutesSnapshot = {
  rows: [],
  inUse: null,
  fellBack: false,
  depth: null,
  loading: true,
}

export function createRoutesModel({ port, settings, report }: RoutesModelOptions): RoutesModel {
  const listeners = new Set<() => void>()
  let probe: Probe | null = null
  let cached: RoutesSnapshot | null = EMPTY
  let disposed = false
  /* LAST ISSUED WINS, NOT LAST RESOLVED. `probe()` spawns up to four child
     processes and they do not finish in the order they were started, so an
     unguarded `probe = await port.probe()` lets a slow EARLIER refresh land on
     top of a fast later one — the pane then shows a route list that was
     already superseded, and nothing refreshes again until the group reopens. */
  const generations = createGenerations()
  let signingIn: string | null = null

  const invalidate = (): void => {
    cached = null
    for (const listener of [...listeners]) listener()
  }
  const unsubscribeSettings = settings.subscribe(invalidate)

  const build = (): RoutesSnapshot => {
    if (probe === null) return EMPTY
    const chosen = settings.get(ROUTE_SETTING)
    const { inUse, fellBack } = resolveRoute(chosen, probe.routes)
    return {
      rows: probe.routes
        .filter((route) => route.modality === 'text')
        .map((route) => rowFor(route, inUse, signingIn)),
      inUse,
      fellBack,
      /* Offered only while an AGENT answers — the two flags this maps to
         exist on the agent CLIs and nowhere else. */
      depth:
        probe.routes.find((route) => route.id === inUse)?.kind === 'agent'
          ? DEPTH_LABELS[settings.get(DEPTH_SETTING)]
          : null,
      loading: false,
    }
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
    /* REFRESHED WHEN THE GROUP IS OPENED, NEVER ON A TIMER (WI-15.10). Each
     * probe spawns up to four short-lived child processes; doing that behind
     * a shut side pane would be a reader's battery spent on a question nobody
     * asked. */
    refresh: async () => {
      const mine = generations.claim()
      let found: Probe
      try {
        found = await port.probe()
      } catch {
        found = { routes: [], runtimeVersion: null }
      }
      /* Superseded, or the pane closed while the children ran. Either way this
         result is nobody's, and writing it would be the stale overwrite. */
      if (!mine() || disposed) return
      probe = found
      /* THE WAIT ENDS AT THE NEXT PROBE, whatever it says. If the login
         worked the route is usable and the row moves to `Use`; if it did not,
         the row goes back to `Sign in…` so the reader can try again rather
         than waiting on a flow that has already failed. Either way this
         terminates — a pending state with no exit is worse than none. */
      signingIn = null
      invalidate()
    },
    use: (id) => settings.set(ROUTE_SETTING, id),
    signIn: async (id) => {
      /* Claimed BEFORE the await, so a second press cannot open a second
         flow while the first is being launched. */
      signingIn = id
      invalidate()
      try {
        await port.signIn(id)
      } catch (error) {
        signingIn = null
        invalidate()
        report?.('companion.sign-in-failed', {
          route: id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
    cycleDepth: () => {
      const at = DEPTH_ORDER.indexOf(settings.get(DEPTH_SETTING))
      settings.set(DEPTH_SETTING, DEPTH_ORDER[(at + 1) % DEPTH_ORDER.length] as Depth)
    },
    dispose: () => {
      disposed = true
      /* Retire every in-flight probe too, so a late arrival cannot write
         `probe` on a torn-down model even if `disposed` were ever relaxed. */
      generations.claim()
      unsubscribeSettings()
      listeners.clear()
    },
  }
}
