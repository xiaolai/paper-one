import type { SettingsStore } from '../../../kernel'
import { LOOK_UP_LABELS, createGenerations, type KernelServices } from '../../../kernel'
import type { Depth } from '../../inference'
import type { InferencePort, Probe, Route } from '../../inference'
import { DEPTH_SETTING, ROUTE_SETTING, TOOLS_SETTING } from '../lib/settings'

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
 * # `Look up` IS a cycle button, and that is not a contradiction
 *
 * The route list is a list because it GROWS — three local models, two agents
 * and an endpoint is six rows and climbing. `Look up` has at most three
 * states and cannot gain a fourth: there is a system dictionary or there is
 * not, and there is a local model or there is not. A cycle is right where the
 * set is closed and wrong where it is open, which is the distinction the
 * earlier draft missed by applying one answer to both.
 */

/** What a row's button does. */
export type RowAction = 'use' | 'install' | 'sign-in' | 'in-use' | 'none'

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
  readonly unusable: boolean
}

export interface RoutesSnapshot {
  readonly rows: readonly RouteRow[]
  /** The route in use, or null when nothing can answer. */
  readonly inUse: string | null
  /** True when the reader's stored choice is no longer usable. */
  readonly fellBack: boolean
  readonly lookUp: string | null
  readonly tools: boolean
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

/** Turn one probe route into a row, given what is in use. */
export function rowFor(route: Route, inUse: string | null): RouteRow {
  const unusable = route.unusable !== null
  const action: RowAction = unusable
    ? route.unusable === 'Not installed' && route.kind === 'local'
      ? 'install'
      : route.unusable === 'Signed out'
        ? 'sign-in'
        : 'none'
    : route.id === inUse
      ? 'in-use'
      : 'use'
  return {
    id: route.id,
    label: route.label,
    /* An unusable route shows the REASON, which is §07's disabled-and-says-why
     * rather than a control that fails when pressed. */
    value: unusable ? (route.unusable as string) : (route.detail ?? ''),
    action,
    unusable,
  }
}


export interface RoutesModel {
  getSnapshot(): RoutesSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  use(id: string): void
  signIn(id: string): Promise<void>
  cycleLookUp(hasDictionary: boolean, hasGloss: boolean): void
  setTools(value: boolean): void
  /** Advance the effort one place. */
  cycleDepth(): void
  dispose(): void
}

export interface RoutesModelOptions {
  readonly port: InferencePort
  readonly settings: SettingsStore
  /**
   * The kernel's own view of `Look up` — see `KernelServices.lookUp`.
   *
   * `LOOK_UP_SETTING` is `kernel.lookUp` and this capability's settings
   * handle is confined to `companion.`, so the value is unreachable through
   * `settings` and the read threw on the pane's first render.
   */
  readonly kernel: Pick<KernelServices, 'lookUp' | 'cycleLookUp'>
}

const EMPTY: RoutesSnapshot = {
  rows: [],
  inUse: null,
  fellBack: false,
  lookUp: null,
  tools: false,
  depth: null,
  loading: true,
}

export function createRoutesModel({ port, settings, kernel }: RoutesModelOptions): RoutesModel {
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

  const invalidate = (): void => {
    cached = null
    for (const listener of [...listeners]) listener()
  }
  const unsubscribeSettings = settings.subscribe(invalidate)

  const build = (): RoutesSnapshot => {
    if (probe === null) return EMPTY
    const chosen = settings.get(ROUTE_SETTING)
    const { inUse, fellBack } = resolveRoute(chosen, probe.routes)
    const hasGloss = probe.routes.some(
      (route) => route.kind === 'local' && route.modality === 'text' && route.installed,
    )
    return {
      rows: probe.routes.filter((route) => route.modality === 'text').map((route) => rowFor(route, inUse)),
      inUse,
      fellBack,
      /* `hasDictionary` is the reader UI's answer and is not known here, so
       * the row's label is resolved at render. `null` means "no control", and
       * the pane draws nothing. */
      lookUp: hasGloss ? LOOK_UP_LABELS[kernel.lookUp()] : null,
      tools: settings.get(TOOLS_SETTING),
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
      invalidate()
    },
    use: (id) => settings.set(ROUTE_SETTING, id),
    signIn: (id) => port.signIn(id),
    /* One cycle, in the kernel — this was written out here and in
       `inference`'s store, identically, which is one algorithm in two files. */
    cycleLookUp: (hasDictionary, hasGloss) => kernel.cycleLookUp(hasDictionary, hasGloss),
    setTools: (value) => settings.set(TOOLS_SETTING, value),
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
