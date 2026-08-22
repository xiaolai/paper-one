import type { SettingsStore } from '../../../kernel'
import { LOOK_UP_LABELS, type KernelServices } from '../../../kernel'
import type { InferencePort, Probe, Route } from '../../inference'
import { ROUTE_SETTING, TOOLS_SETTING } from '../lib/settings'

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
  readonly voices: readonly RouteRow[]
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

/**
 * The voice rows — and there are none below two.
 *
 * **Reading aloud is its own list, and only when there is a choice.** One
 * voice model installed is not a decision, and a picker offering one row is a
 * control that asks a question with one answer.
 */
export function voiceRows(routes: readonly Route[], inUse: string | null): readonly RouteRow[] {
  const voices = routes.filter((route) => route.modality === 'speech' && route.unusable === null)
  return voices.length < 2 ? [] : voices.map((route) => rowFor(route, inUse))
}

export interface RoutesModel {
  getSnapshot(): RoutesSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  use(id: string): void
  signIn(id: string): Promise<void>
  cycleLookUp(hasDictionary: boolean, hasGloss: boolean): void
  setTools(value: boolean): void
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
  voices: [],
  loading: true,
}

export function createRoutesModel({ port, settings, kernel }: RoutesModelOptions): RoutesModel {
  const listeners = new Set<() => void>()
  let probe: Probe | null = null
  let cached: RoutesSnapshot | null = EMPTY
  let disposed = false

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
      voices: voiceRows(probe.routes, inUse),
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
      try {
        probe = await port.probe()
      } catch {
        probe = { routes: [], runtimeVersion: null }
      }
      if (!disposed) invalidate()
    },
    use: (id) => settings.set(ROUTE_SETTING, id),
    signIn: (id) => port.signIn(id),
    /* One cycle, in the kernel — this was written out here and in
       `inference`'s store, identically, which is one algorithm in two files. */
    cycleLookUp: (hasDictionary, hasGloss) => kernel.cycleLookUp(hasDictionary, hasGloss),
    setTools: (value) => settings.set(TOOLS_SETTING, value),
    dispose: () => {
      disposed = true
      unsubscribeSettings()
      listeners.clear()
    },
  }
}
