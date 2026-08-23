import { describe, expect, it } from 'vitest'
import { createKernelServices, scopeSettings } from '../../../kernel'
import { ROUTE_SETTING, TOOLS_SETTING } from '../lib/settings'
import type { InferencePort, Probe, Route } from '../../inference'
import { DEPTH_LABELS, DEPTH_ORDER, createRoutesModel, resolveRoute, rowFor, voiceRows } from './routesModel'

const route = (over: Partial<Route> & Pick<Route, 'id' | 'kind'>): Route => ({
  label: over.id,
  detail: null,
  unusable: null,
  installed: false,
  modality: 'text',
  ...over,
})

const localReady = route({ id: 'local:qwen', kind: 'local', label: 'Qwen3-4B', detail: 'local · 2.5 GB', installed: true })
const localAbsent = route({ id: 'local:kokoro', kind: 'local', label: 'Kokoro', unusable: 'Not installed', modality: 'speech' })
const codexReady = route({ id: 'agent:codex', kind: 'agent', label: 'Codex', detail: 'ChatGPT · 0.149.0' })
const claudeOut = route({ id: 'agent:claude', kind: 'agent', label: 'Claude', unusable: 'Signed out', detail: '2.1.240' })
const endpointKeyless = route({ id: 'endpoint:proxy', kind: 'endpoint', label: 'My proxy', unusable: 'No key' })

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
    const { inUse } = resolveRoute('', [localAbsent, codexReady])
    expect(inUse).toBe('agent:codex')
  })

  it('prefers local, then agent, then endpoint', () => {
    const endpointReady = route({ id: 'endpoint:p', kind: 'endpoint', label: 'P', detail: 'endpoint' })
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

describe('voiceRows', () => {
  const bella = route({ id: 'local:kokoro-bella', kind: 'local', label: 'Kokoro · Bella', modality: 'speech' })
  const nicole = route({ id: 'local:kokoro-nicole', kind: 'local', label: 'Kokoro · Nicole', modality: 'speech' })

  /* "Reading aloud is its own list, and only when there is a choice. One
   * voice model installed is not a decision, and a picker offering one row is
   * a control that asks a question with one answer. It appears at two." */
  it('renders nothing at one voice', () => {
    expect(voiceRows([bella, localReady], null)).toEqual([])
  })

  it('renders nothing at no voices', () => {
    expect(voiceRows([localReady], null)).toEqual([])
  })

  it('appears at two', () => {
    const rows = voiceRows([bella, nicole], 'local:kokoro-bella')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.action).toBe('in-use')
    expect(rows[1]?.action).toBe('use')
  })

  it('does not count an unusable voice towards the two', () => {
    const absent = route({ id: 'local:k2', kind: 'local', label: 'K2', modality: 'speech', unusable: 'Not installed' })
    expect(voiceRows([bella, absent], null)).toEqual([])
  })
})

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
   * in raw makes this whole suite pass over a pane that throws on its first
   * render. It did: both phase-15 panes read it through the scoped handle.
   */
  function wiring() {
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    return { settings: scopeSettings(services.settings, 'companion'), kernel: services }
  }

  it('is empty and loading until the first probe resolves', async () => {
    const { port } = portWith(probeOf())
    const model = createRoutesModel({ port, ...wiring() })
    expect(model.getSnapshot().loading).toBe(true)
    await model.refresh()
    expect(model.getSnapshot().loading).toBe(false)
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

  it('notifies subscribers and stops on unsubscribe', async () => {
    const { settings, kernel } = wiring()
    const { port } = portWith(probeOf())
    const model = createRoutesModel({ port, settings, kernel })
    let seen = 0
    const stop = model.subscribe(() => void (seen += 1))
    await model.refresh()
    expect(seen).toBeGreaterThan(0)
    const after = seen
    stop()
    model.setTools(true)
    expect(seen).toBe(after)
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
  const probeOf = (...routes: Route[]): Probe => ({ routes, runtimeVersion: '1.0' })

  function portWith(probe: Probe): InferencePort {
    return {
      generate: async () => '',
      agentAsk: async () => '',
      probe: async () => probe,
      ensureReady: async () => true,
      signIn: async () => {},
      subscribe: () => () => {},
    } satisfies InferencePort
  }

  function wiring() {
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    return { settings: scopeSettings(services.settings, 'companion'), kernel: services }
  }

  it('is absent when a local model is answering', async () => {
    const { settings, kernel } = wiring()
    const port = portWith(probeOf(route({ id: 'local:m', kind: 'local', installed: true })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    expect(model.getSnapshot().inUse).toBe('local:m')
    expect(model.getSnapshot().depth).toBeNull()
    model.dispose()
  })

  it('shows the account default while an agent is answering', async () => {
    const { settings, kernel } = wiring()
    const port = portWith(probeOf(route({ id: 'agent:codex', kind: 'agent' })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    expect(model.getSnapshot().depth).toBe(DEPTH_LABELS.default)
    model.dispose()
  })

  it('cycles the whole set and wraps back to the account default', async () => {
    const { settings, kernel } = wiring()
    const port = portWith(probeOf(route({ id: 'agent:codex', kind: 'agent' })))
    const model = createRoutesModel({ port, settings, kernel })
    await model.refresh()
    const seen = [model.getSnapshot().depth]
    for (let i = 0; i < DEPTH_ORDER.length; i++) {
      model.cycleDepth()
      seen.push(model.getSnapshot().depth)
    }
    /* Every state visited, and back where it started. */
    expect(new Set(seen.slice(0, DEPTH_ORDER.length))).toEqual(
      new Set(DEPTH_ORDER.map((one) => DEPTH_LABELS[one])),
    )
    expect(seen[seen.length - 1]).toBe(seen[0])
    model.dispose()
  })

  /* The default has to be the reader's own account setting: anything else is
     Paper overriding a choice they already made with their money. */
  it('starts at the account default, which sends no flag at all', () => {
    expect(DEPTH_ORDER[0]).toBe('default')
  })
})
