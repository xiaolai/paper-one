import { describe, expect, it } from 'vitest'
import { createKernelServices, scopeSettings } from '../../../kernel'
import { ROUTE_SETTING, TOOLS_SETTING } from '../lib/settings'
import type { InferencePort, Probe, Route } from '../../inference'
import { DEPTH_LABELS, DEPTH_ORDER, createRoutesModel, resolveRoute, rowFor } from './routesModel'

/**
 * Route fixtures that cannot be built into a state the probe never emits.
 *
 * The one generic builder this replaces defaulted to `installed: false` AND
 * `unusable: null` — a local model that is not on disk and yet has no reason
 * it cannot be used, which `probe.rs` never reports. Tests written on it were
 * asserting over a shape the implementation is entitled to assume away, so a
 * green result meant nothing in either direction.
 *
 * `local` therefore DERIVES its usability from installation, and only a
 * non-local route may be handed an arbitrary `unusable`.
 */
const agentRoute = (over: Partial<Route> & Pick<Route, 'id'>): Route => ({
  label: over.id,
  detail: null,
  unusable: null,
  installed: true,
  modality: 'text',
  ...over,
  kind: 'agent',
})

const endpointRoute = (over: Partial<Route> & Pick<Route, 'id'>): Route => ({
  label: over.id,
  detail: null,
  unusable: null,
  installed: true,
  modality: 'text',
  ...over,
  kind: 'endpoint',
})

/** Installed means usable; absent means "Not installed". Nothing in between. */
const localRoute = (
  over: Partial<Omit<Route, 'unusable' | 'kind'>> & Pick<Route, 'id'> & { installed: boolean },
): Route => ({
  label: over.id,
  detail: null,
  modality: 'text',
  ...over,
  kind: 'local',
  unusable: over.installed ? null : 'Not installed',
})

/* The generic builder is kept ONLY for the store suites, which need to name a
   route without caring about its kind. It routes through the three above so
   the coherence rule cannot be sidestepped by picking this one. */
const route = (over: Partial<Route> & Pick<Route, 'id' | 'kind'>): Route =>
  over.kind === 'local'
    ? localRoute({ ...over, installed: over.installed ?? false })
    : over.kind === 'agent'
      ? agentRoute(over)
      : endpointRoute(over)

const localReady = localRoute({ id: 'local:qwen', label: 'Qwen3-4B', detail: 'local · 2.5 GB', installed: true })
/* INSTALLED AND USABLE, and still not an answer — the only thing wrong with it
   is that it speaks. The absent speech model this replaces was unusable for a
   second reason, so it could not tell modality filtering from usability
   filtering. */
const voiceReady = localRoute({ id: 'local:kokoro', label: 'Kokoro', installed: true, modality: 'speech' })
const codexReady = agentRoute({ id: 'agent:codex', label: 'Codex', detail: 'ChatGPT · 0.149.0' })
const claudeOut = agentRoute({ id: 'agent:claude', label: 'Claude', unusable: 'Signed out', detail: '2.1.240' })
const endpointKeyless = endpointRoute({ id: 'endpoint:proxy', label: 'My proxy', unusable: 'No key' })

describe('resolveRoute', () => {
  it('uses the reader’s choice when it is usable', () => {
    const { inUse, fellBack } = resolveRoute('agent:codex', [localReady, codexReady])
    expect(inUse).toBe('agent:codex')
    expect(fellBack).toBe(false)
  })

  it('picks the local route first when nothing is chosen', () => {
    const { inUse, fellBack } = resolveRoute('', [codexReady, localReady])
    expect(inUse).toBe('local:qwen')
    /* Not a fall-back: the reader never chose anything, so nothing was lost. */
    expect(fellBack).toBe(false)
  })

  /* ── WI-15.11's ACCEPTANCE ─────────────────────────────────────────────
   * "uninstalling the model in use falls back to a named route and says so
   * rather than silently answering from somewhere else." */
  it('falls back to a named route and says it fell back', () => {
    const { inUse, fellBack } = resolveRoute('local:qwen', [codexReady])
    expect(inUse).toBe('agent:codex')
    expect(fellBack).toBe(true)
  })

  it('reports nothing in use when no route can answer', () => {
    const { inUse, fellBack } = resolveRoute('local:qwen', [claudeOut, endpointKeyless])
    expect(inUse).toBeNull()
    expect(fellBack).toBe(true)
  })

  it('never picks an unusable route', () => {
    const { inUse } = resolveRoute('', [claudeOut, endpointKeyless, codexReady])
    expect(inUse).toBe('agent:codex')
  })

  /* A speech model answers no questions. Picking one would make the composer
   * offer a route that cannot reply. */
  it('never picks a speech route to answer with', () => {
    /* `voiceReady` is INSTALLED and has no `unusable` reason, so the only
       thing that can exclude it is its modality. Passing an absent voice here
       — which the earlier fixture did — proved nothing: the usability filter
       alone would have dropped it. */
    const { inUse } = resolveRoute('', [voiceReady, codexReady])
    expect(inUse).toBe('agent:codex')
  })

  /* AND NOT EVEN WHEN IT IS THE STORED CHOICE. `use` cannot write one today,
     but a settings file carried over from the build whose voice picker shared
     this setter can, and honouring it would leave the composer pointed at a
     model that cannot reply. */
  it('refuses a stored speech route and falls back, saying so', () => {
    const { inUse, fellBack } = resolveRoute('local:kokoro', [voiceReady, codexReady])
    expect(inUse).toBe('agent:codex')
    expect(fellBack).toBe(true)
  })

  /* A speech route is not a usable route, so a shelf of nothing else answers
     nothing at all rather than answering with the voice. */
  it('reports nothing in use when only speech routes exist', () => {
    expect(resolveRoute('', [voiceReady]).inUse).toBeNull()
  })

  it('prefers local, then agent, then endpoint', () => {
    const endpointReady = endpointRoute({ id: 'endpoint:p', label: 'P', detail: 'endpoint' })
    expect(resolveRoute('', [endpointReady, codexReady, localReady]).inUse).toBe('local:qwen')
    expect(resolveRoute('', [endpointReady, codexReady]).inUse).toBe('agent:codex')
    expect(resolveRoute('', [endpointReady]).inUse).toBe('endpoint:p')
  })
})

describe('rowFor', () => {
  it('marks the route in use rather than offering it again', () => {
    expect(rowFor(localReady, 'local:qwen').action).toBe('in-use')
  })

  it('offers Use on a usable route that is not in use', () => {
    const row = rowFor(codexReady, 'local:qwen')
    expect(row.action).toBe('use')
    expect(row.value).toBe('ChatGPT · 0.149.0')
  })

  /* §07: disabled-and-says-why rather than a control that fails when pressed.
   * The reason goes in the value slot and the action is the one that fixes
   * it. */
  it('shows the reason and the action that fixes it, for a signed-out agent', () => {
    const row = rowFor(claudeOut, null)
    expect(row.value).toBe('Signed out')
    expect(row.action).toBe('sign-in')
    expect(row.unusable).toBe(true)
  })

  it('sends an uninstalled local model to Install rather than Use', () => {
    const row = rowFor(route({ id: 'local:x', kind: 'local', label: 'X', unusable: 'Not installed' }), null)
    expect(row.action).toBe('install')
  })

  it('offers no action for a route whose version is unsupported', () => {
    const row = rowFor(route({ id: 'agent:codex', kind: 'agent', label: 'Codex', unusable: 'Version not supported' }), null)
    expect(row.action).toBe('none')
    expect(row.value).toBe('Version not supported')
  })

  /* F6: an agent row's value is the plan tier and the CLI version — never a
   * model menu Paper invented beside it. */
  it('shows an agent’s plan and version and nothing model-shaped', () => {
    const row = rowFor(codexReady, null)
    expect(row.value).toBe('ChatGPT · 0.149.0')
    expect(row.value).not.toMatch(/gpt-|o[0-9]|sonnet|opus/i)
  })
})


/**
 * The store fixtures, defined ONCE.
 *
 * Three suites below had grown their own `probeOf`, `portWith` and `wiring`,
 * two of them near-identical and one of them silently dropping the sign-in
 * recorder. Three copies of a fake is three chances for the fake to disagree
 * with itself about what the port does, which is a failure mode no assertion
 * in any of them can see.
 */
const probeOf = (...routes: Route[]): Probe => ({ routes, runtimeVersion: '1.0' })

function portWith(probe: Probe | (() => Promise<Probe>)): { port: InferencePort; signedIn: string[] } {
  const signedIn: string[] = []
  const port = {
    generate: async () => '',
    agentAsk: async () => '',
    probe: typeof probe === 'function' ? probe : async () => probe,
    ensureReady: async () => true,
    signIn: async (id: string) => void signedIn.push(id),
    subscribe: () => () => {},
  } satisfies InferencePort
  return { port, signedIn }
}

/**
 * THE REAL GUARD. `scopeSettings` confines this capability to `companion.`
 * at every door, and the look-up mode is `kernel.lookUp` — so a store handed
 * in raw makes these suites pass over a pane that throws on its first render.
 * It did: both phase-15 panes read it through the scoped handle.
 */
function wiring() {
  const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
  return { settings: scopeSettings(services.settings, 'companion'), kernel: services }
}

/**
 * THE STORE ITSELF, not only the pure rows above.
 *
 * `useSyncExternalStore` puts three hard requirements on this object and none
 * of them are visible in a formatter test: the snapshot must be a STABLE
 * reference between changes (a fresh object per call is an infinite
 * re-render), `subscribe` must hand back a working unsubscribe, and a probe
 * that resolves after the pane has closed must not notify a listener that is
 * gone. Each is a defect that reproduces only in a running app.
 */
describe('the routes store', () => {
  it('is empty and loading until the first probe resolves', async () => {
    const { port } = portWith(probeOf(codexReady))
    const model = createRoutesModel({ port, ...wiring() })
    /* EMPTY, not merely `loading`. A model that exposed stale or half-built
       rows on the very first read would satisfy the flag alone, and that read
       is the one `useSyncExternalStore` performs during the first render —
       the exact moment there is nothing to show yet. */
    const first = model.getSnapshot()
    expect(first.loading).toBe(true)
    expect(first.rows).toEqual([])
    expect(first.inUse).toBeNull()
    expect(first.fellBack).toBe(false)
    expect(first.lookUp).toBeNull()
    expect(first.depth).toBeNull()

    await model.refresh()
    const then = model.getSnapshot()
    expect(then.loading).toBe(false)
    /* And the probe's contents actually arrived, so "still empty" cannot pass
       for "resolved". */
    expect(then.rows.map((row) => row.id)).toEqual(['agent:codex'])
    model.dispose()
  })

  /* THE STABLE REFERENCE. Two reads with nothing changed in between must be
     the SAME object, and a change must produce a different one. */
  it('returns one snapshot object until something changes', async () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf(route({ id: 'local', kind: 'local', installed: true })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    const before = model.getSnapshot()
    expect(model.getSnapshot()).toBe(before)
    model.setTools(true)
    const after = model.getSnapshot()
    expect(after).not.toBe(before)
    /* And stable again once rebuilt — the invalidation is per CHANGE, not
       per read, which is the half that stops the re-render loop. */
    expect(model.getSnapshot()).toBe(after)
    expect(after.tools).toBe(true)
    model.dispose()
  })

  it('notifies subscribers exactly once per change, and stops on unsubscribe', async () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf())
    const model = createRoutesModel({ port, settings, kernel })
    let seen = 0
    const stop = model.subscribe(() => void (seen += 1))

    /* EXACTLY ONE, NOT "AT LEAST ONE". `toBeGreaterThan(0)` accepts a store
       that notifies twice per refresh, and every extra notification is a
       React re-render of the whole pane — the cost this snapshot cache exists
       to avoid, invisible to a lower-bound assertion. */
    await model.refresh()
    expect(seen, 'one refresh produced more than one notification').toBe(1)

    model.setTools(true)
    expect(seen, 'one setting write produced more than one notification').toBe(2)

    stop()
    model.setTools(false)
    expect(seen, 'a detached listener was still notified').toBe(2)
    model.dispose()
  })

  it('reads a probe that fails as no routes rather than throwing', async () => {
    const { port } = portWith(async () => {
      throw new Error('the daemon is not there')
    })
    const model = createRoutesModel({ port, ...wiring() })
    await expect(model.refresh()).resolves.toBeUndefined()
    expect(model.getSnapshot().rows).toEqual([])
    expect(model.getSnapshot().loading).toBe(false)
    model.dispose()
  })

  /* A PROBE IN FLIGHT WHEN THE PANE CLOSES. `refresh` awaits four child
     processes; the reader can shut the group long before they answer, and a
     store that notified afterwards would call into a torn-down subscriber. */
  it('does not notify after dispose', async () => {
    let release: (probe: Probe) => void = () => {}
    const { port } = portWith(() => new Promise<Probe>((resolve) => void (release = resolve)))
    const model = createRoutesModel({ port, ...wiring() })
    let seen = 0
    model.subscribe(() => void (seen += 1))
    const inFlight = model.refresh()
    model.dispose()
    release(probeOf())
    await inFlight
    expect(seen).toBe(0)
  })

  /**
   * TWO REFRESHES IN FLIGHT, RESOLVING BACKWARDS.
   *
   * `port.probe()` spawns up to four child processes and they do not finish
   * in the order they started — a Codex sign-in check can outlast a whole
   * local scan. So the pane can issue a second refresh (reopened group, model
   * just installed) while the first is still out, and an unguarded
   * `probe = await port.probe()` writes whichever RESOLVES last.
   *
   * The disposal case below was the only deferred-probe test, and disposal is
   * the easy half: `disposed` catches it. Nothing caught this one, and its
   * symptom is a route list that is silently one generation out of date until
   * the group is closed and opened again.
   */
  it('keeps the newest probe when an older one resolves after it', async () => {
    const pending: ((probe: Probe) => void)[] = []
    const { port } = portWith(() => new Promise<Probe>((resolve) => void pending.push(resolve)))
    const model = createRoutesModel({ port, ...wiring() })

    const older = model.refresh()
    const newer = model.refresh()
    expect(pending, 'both refreshes should have reached the port').toHaveLength(2)

    /* BACKWARDS ON PURPOSE: the second call answers first, then the first. */
    pending[1]!(probeOf(codexReady))
    await newer
    expect(model.getSnapshot().rows.map((row) => row.id)).toEqual(['agent:codex'])

    pending[0]!(probeOf(localReady))
    await older
    expect(
      model.getSnapshot().rows.map((row) => row.id),
      'a superseded probe overwrote the current one',
    ).toEqual(['agent:codex'])
    model.dispose()
  })

  it('writes the chosen route, and signs in through the port', async () => {
    const { settings, kernel } = wiring()
    const { port, signedIn } = portWith(probeOf(route({ id: 'codex', kind: 'agent' })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    model.use('codex')
    expect(settings.get(ROUTE_SETTING)).toBe('codex')
    await model.signIn('codex')
    expect(signedIn).toEqual(['codex'])
    model.dispose()
  })

  /* THE REGRESSION, NAMED. `getSnapshot` is the `useSyncExternalStore` read
     that runs on mount, and it resolves the look-up label. Reading that
     through `settings` throws `namespace` under the real guard, which is what
     `Settings → Local models` and this pane both did in the running app. */
  it('builds a snapshot without touching the kernel namespace', async () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf(route({ id: 'local:m', kind: 'local', installed: true })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    expect(() => model.getSnapshot()).not.toThrow()
    expect(model.getSnapshot().lookUp).not.toBeNull()
    model.dispose()
  })

  it('sets tools through the settings store, not its own field', () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf())
    const model = createRoutesModel({ port, settings, kernel })
    model.setTools(true)
    expect(settings.get(TOOLS_SETTING)).toBe(true)
    model.dispose()
  })

  /* The cycle is over what is AVAILABLE, so a machine with one option cannot
     be cycled into a mode that does nothing. */
  it('cycles Look up only when there is more than one mode', () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf())
    const model = createRoutesModel({ port, settings, kernel })
    const before = kernel.lookUp()
    model.cycleLookUp(false, false)
    expect(kernel.lookUp()).toBe(before)
    model.cycleLookUp(true, true)
    expect(kernel.lookUp()).not.toBe(before)
    model.dispose()
  })
})

/**
 * THE EFFORT ROW, which is offered only while an agent is answering.
 *
 * The two flags it maps to — Codex's `model_reasoning_effort`, Claude's
 * `--model` alias — exist on the agent CLIs and nowhere else. A local model is
 * handed a model id and neither flag means anything to it, so the control is
 * ABSENT rather than present-and-inert, which is the same rule Look up
 * follows.
 */
describe('the effort control', () => {
  it('is absent when a local model is answering', async () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf(route({ id: 'local:m', kind: 'local', installed: true })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    expect(model.getSnapshot().inUse).toBe('local:m')
    expect(model.getSnapshot().depth).toBeNull()
    model.dispose()
  })

  it('shows the account default while an agent is answering', async () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf(route({ id: 'agent:codex', kind: 'agent' })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    expect(model.getSnapshot().depth).toBe(DEPTH_LABELS.default)
    model.dispose()
  })

  it('cycles the whole set and wraps back to the account default', async () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf(route({ id: 'agent:codex', kind: 'agent' })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    const seen = [model.getSnapshot().depth]
    for (let i = 0; i < DEPTH_ORDER.length; i++) {
      model.cycleDepth()
      seen.push(model.getSnapshot().depth)
    }
    /* IN ORDER, NOT AS A SET. A `Set` comparison discards the sequence, so a
       cycle that ran backwards — or in any other permutation — passed as long
       as it visited everything and wrapped. The order is the behaviour: it is
       what the reader sees each time they press the row. */
    expect(seen).toEqual([...DEPTH_ORDER.map((one) => DEPTH_LABELS[one]), DEPTH_LABELS[DEPTH_ORDER[0]!]])
    model.dispose()
  })

  /* The default has to be the reader's own account setting: anything else is
     Paper overriding a choice they already made with their money.

     NAMED FOR WHAT IT CHECKS. This is an ordering assertion and nothing more —
     that no flag is actually sent for `default` is a property of the adapter
     that builds the command line, and it is asserted where that happens
     (`agentask.rs`, `depth_args`), not here. The previous name claimed both
     and tested one. */
  it('puts the account default first in the cycle', () => {
    expect(DEPTH_ORDER[0]).toBe('default')
  })
})

/**
 * NOTHING THE PANE CAN PRESS SETS A NON-TEXT ANSWERING ROUTE.
 *
 * `use` writes `companion.route`, which is the route that ANSWERS. A voice
 * picker used to call the same setter with a speech route, so choosing a
 * narrator set the companion to a model that cannot answer a question; it
 * never fired only because the picker needed two usable speech models and the
 * catalogue ships one. The picker is gone, and this is what stops the next one
 * reaching for the same setter: every row the pane renders a `Use` on comes
 * from `rows`, and `rows` is text-only however many voices the probe returns.
 */
describe('the rows the pane can act on', () => {
  it('are text routes only, even when speech routes are usable', async () => {
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    const port = {
      generate: async () => '',
      agentAsk: async () => '',
      probe: async () =>
        probeOf(
          route({ id: 'agent:codex', kind: 'agent' }),
          route({ id: 'local:kokoro', kind: 'local', installed: true, modality: 'speech' }),
          route({ id: 'local:kokoro-2', kind: 'local', installed: true, modality: 'speech' }),
        ),
      ensureReady: async () => true,
      signIn: async () => {},
      subscribe: () => () => {},
    } satisfies InferencePort
    const model = createRoutesModel({
      port,
      settings: scopeSettings(services.settings, 'companion'),
      kernel: services,
    })
    await model.refresh()
    const ids = model.getSnapshot().rows.map((r) => r.id)
    expect(ids).toEqual(['agent:codex'])
    model.dispose()
  })
})
