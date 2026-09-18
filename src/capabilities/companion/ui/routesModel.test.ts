import { describe, expect, it, vi } from 'vitest'
import { createKernelServices, scopeSettings, type SettingsStore } from '../../../kernel'
import { DEPTH_SETTING, ROUTE_SETTING } from '../lib/settings'
import type { InferencePort, Probe, Route, UnusableReason } from '../../inference'
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
/**
 * The reason code beside its sentence, exactly as `probe.rs` emits them.
 *
 * BOTH OR NEITHER. `rowFor` branches on the code and the pane shows the text,
 * so a fixture carrying one without the other tests a route the probe cannot
 * produce — and would hide the very drift the split exists to prevent.
 */
const REASONS: Readonly<Record<UnusableReason, string>> = {
  notInstalled: 'Not installed',
  runtimeMissing: 'Runtime not installed',
  agentMissing: 'Not installed',
  signedOut: 'Signed out',
  versionUnsupported: 'Version not supported',
  noKey: 'No key',
  keyUnreadable: 'The keychain would not read its key',
  noModelName: 'No model name',
}

const because = (reason: UnusableReason | null) =>
  reason === null ? { unusable: null } : { unusable: REASONS[reason], reason }

const agentRoute = (
  over: Partial<Omit<Route, 'unusable' | 'reason' | 'kind'>> &
    Pick<Route, 'id'> & { reason?: UnusableReason },
): Route => ({
  label: over.id,
  detail: null,
  installed: true,
  ...over,
  ...because(over.reason ?? null),
  kind: 'agent',
})

const endpointRoute = (
  over: Partial<Omit<Route, 'unusable' | 'reason' | 'kind'>> &
    Pick<Route, 'id'> & { reason?: UnusableReason },
): Route => ({
  label: over.id,
  detail: null,
  installed: true,
  ...over,
  ...because(over.reason ?? null),
  kind: 'endpoint',
})

/** Installed means usable; absent means `notInstalled`. Nothing in between. */
const localRoute = (
  over: Partial<Omit<Route, 'unusable' | 'reason' | 'kind'>> &
    Pick<Route, 'id'> & { installed: boolean },
): Route => ({
  label: over.id,
  detail: null,
  ...over,
  kind: 'local',
  ...because(over.installed ? null : 'notInstalled'),
})

/* The generic builder is kept ONLY for the store suites, which need to name a
   route without caring about its kind. It routes through the three above so
   the coherence rule cannot be sidestepped by picking this one. */
const route = (
  over: Partial<Omit<Route, 'unusable' | 'reason'>> &
    Pick<Route, 'id' | 'kind'> & { reason?: UnusableReason },
): Route =>
  over.kind === 'local'
    ? localRoute({ ...over, installed: over.installed ?? false })
    : over.kind === 'agent'
      ? agentRoute(over)
      : endpointRoute(over)

const localReady = localRoute({ id: 'local:qwen', label: 'Qwen3-4B', detail: 'local · 2.5 GB', installed: true })
const codexReady = agentRoute({ id: 'agent:codex', label: 'Codex', detail: 'ChatGPT · 0.149.0' })
const claudeOut = agentRoute({ id: 'agent:claude', label: 'Claude', reason: 'signedOut', detail: '2.1.240' })
const endpointKeyless = endpointRoute({ id: 'endpoint:proxy', label: 'My proxy', reason: 'noKey' })

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

  /* THREE SPEECH-ROUTE CASES WERE HERE — never pick one, refuse a stored one,
     answer nothing when only speech routes exist. The probe reports no speech
     route any more: the neural voice is gone and every route is text. */

  it('prefers local, then agent, then endpoint', () => {
    const endpointReady = endpointRoute({ id: 'endpoint:p', label: 'P', detail: 'endpoint' })
    expect(resolveRoute('', [endpointReady, codexReady, localReady]).inUse).toBe('local:qwen')
    expect(resolveRoute('', [endpointReady, codexReady]).inUse).toBe('agent:codex')
    expect(resolveRoute('', [endpointReady]).inUse).toBe('endpoint:p')
  })

  /* THE ORDER IS THE RANK, NOT THE LIST. The case above lists the endpoint
     first; a comparator that ranked only one side honestly still passes it,
     and answers with the endpoint when the probe lists the agent first. */
  it('prefers an agent to an endpoint whichever order the probe lists them in', () => {
    const endpointReady = endpointRoute({ id: 'endpoint:p', label: 'P', detail: 'endpoint' })
    expect(resolveRoute('', [codexReady, endpointReady]).inUse).toBe('agent:codex')
    expect(resolveRoute('', [endpointReady, codexReady]).inUse).toBe('agent:codex')
  })

  /* Nothing was chosen, so nothing was lost: no route answering is not a
     fall-back from anything. */
  it('reports no fall-back when nothing can answer and nothing was chosen', () => {
    expect(resolveRoute('', [claudeOut, endpointKeyless])).toEqual({ inUse: null, fellBack: false })
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
  })

  it('sends an uninstalled local model to Install rather than Use', () => {
    const row = rowFor(localRoute({ id: 'local:x', label: 'X', installed: false }), null)
    expect(row.action).toBe('install')
  })

  /**
   * ⚠️ AND AN AGENT CLI THAT IS NOT INSTALLED IS NOT OFFERED ONE.
   *
   * The two read the same sentence — "Not installed" — and are opposite
   * situations: Paper downloads a local model, and the reader installs a CLI.
   * The branch that told them apart used to be `kind === 'local'` bolted onto
   * a string comparison, which is a coincidence held together by hand. They
   * carry different codes now.
   */
  it('offers no Install for an agent CLI that is not installed', () => {
    const row = rowFor(agentRoute({ id: 'agent:codex', label: 'Codex', reason: 'agentMissing' }), null)
    expect(row.value, 'the two still read the same to the reader').toBe('Not installed')
    expect(row.action).toBe('none')
  })

  /* AN ENDPOINT WITH A KEY AND NO MODEL NAME IS STILL UNUSABLE — one stored
     before endpoints carried the provider's model name — and says why rather
     than offering anything: the name is added in Cloud endpoints, not here.
     (It read `notConnected` while nothing connected an endpoint to an answer at
     all; Paper talks to one itself since the gloss routes contract.) */
  it('offers no action for an endpoint with no model name, and says so', () => {
    const row = rowFor(endpointRoute({ id: 'endpoint:proxy', label: 'My proxy', reason: 'noModelName' }), null)
    expect(row.action).toBe('none')
    expect(row.value).toBe('No model name')
  })

  it('offers no action for a route whose version is unsupported', () => {
    const row = rowFor(agentRoute({ id: 'agent:codex', label: 'Codex', reason: 'versionUnsupported' }), null)
    expect(row.action).toBe('none')
    expect(row.value).toBe('Version not supported')
  })

  /* THE ACTION FOLLOWS THE CODE, NOT THE WORDING. If `probe.rs` rephrases a
     reason — or a build translates one — the button must not change. */
  it('draws the same action whatever sentence the reason carries', () => {
    const rephrased: Route = {
      ...localRoute({ id: 'local:x', label: 'X', installed: false }),
      unusable: 'Nog niet geïnstalleerd',
    }
    expect(rowFor(rephrased, null).action).toBe('install')
    expect(rowFor(rephrased, null).value).toBe('Nog niet geïnstalleerd')
  })

  /* F6: an agent row's value is the plan tier and the CLI version — never a
   * model menu Paper invented beside it. */
  it('shows an agent’s plan and version and nothing model-shaped', () => {
    const row = rowFor(codexReady, null)
    expect(row.value).toBe('ChatGPT · 0.149.0')
    expect(row.value).not.toMatch(/gpt-|o[0-9]|sonnet|opus/i)
  })

  /* Nothing to say is said as nothing: the value slot is drawn as text. */
  it('shows nothing beside a usable route that carries no detail', () => {
    expect(rowFor(agentRoute({ id: 'agent:codex', label: 'Codex' }), null).value).toBe('')
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

/** A promise the test opens when it wants the operation under test to finish. */
function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

function portWith(probe: Probe | (() => Promise<Probe>)): { port: InferencePort; signedIn: string[] } {
  const signedIn: string[] = []
  const port = {
    generate: async () => '',
    agentAsk: async () => '',
    probe: typeof probe === 'function' ? probe : async () => probe,
    ensureReady: async () => true,
    signIn: async (id: string) => void signedIn.push(id),
  } satisfies InferencePort
  return { port, signedIn }
}

/**
 * THE REAL GUARD. `scopeSettings` confines this capability to `companion.` at
 * every door, so a store handed in raw makes these suites pass over a pane
 * that throws on its first render. It did: both phase-15 panes read a
 * `kernel.`-namespaced value through the scoped handle and threw.
 *
 * ⚠️ IT USED TO RETURN A `kernel` HANDLE TOO — `Pick<KernelServices, 'lookUp'
 * | 'cycleLookUp'>` — because the Look up cycle's value was `kernel.lookUp`
 * and therefore unreachable through `settings`. The row is deleted, so the
 * accessors are, so this returns the store alone. The guard itself still
 * earns its keep: `DEPTH_SETTING` is this capability's own and a raw store
 * would hide a namespace mistake in any future one.
 */
function wiring() {
  const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
  return { settings: scopeSettings(services.settings, 'companion') }
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
    const { settings } = wiring()
    const { port } = portWith(probeOf(route({ id: 'local', kind: 'local', installed: true })))
    const model = createRoutesModel({ port, settings })
    await model.refresh()
    const before = model.getSnapshot()
    expect(model.getSnapshot()).toBe(before)
    /* A REAL SETTING WRITE, which is the invalidation under test. This used
       to press the `Tools` toggle — a control that wrote a boolean nothing
       ever read, and is gone; the effort cycle is the same shape and does
       something. */
    model.cycleDepth()
    const after = model.getSnapshot()
    expect(after).not.toBe(before)
    /* And stable again once rebuilt — the invalidation is per CHANGE, not
       per read, which is the half that stops the re-render loop. */
    expect(model.getSnapshot()).toBe(after)
    model.dispose()
  })

  it('notifies subscribers exactly once per change, and stops on unsubscribe', async () => {
    const { settings } = wiring()
    const { port } = portWith(probeOf())
    const model = createRoutesModel({ port, settings })
    let seen = 0
    const stop = model.subscribe(() => void (seen += 1))

    /* EXACTLY ONE, NOT "AT LEAST ONE". `toBeGreaterThan(0)` accepts a store
       that notifies twice per refresh, and every extra notification is a
       React re-render of the whole pane — the cost this snapshot cache exists
       to avoid, invisible to a lower-bound assertion. */
    await model.refresh()
    expect(seen, 'one refresh produced more than one notification').toBe(1)

    model.cycleDepth()
    expect(seen, 'one setting write produced more than one notification').toBe(2)

    stop()
    model.cycleDepth()
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

  /**
   * SIGNING IN IS A STATE, NOT A GESTURE THAT VANISHES.
   *
   * ⚠️ `agent_sign_in` launches the vendor's own login in a browser and
   * returns at once — Paper never holds the credential — so nothing here ever
   * learned it had finished. The row went on saying `Signed out` for however
   * long the reader spent logging in, and pressing it again opened a SECOND
   * flow. There was no pending state, no error, and no re-probe.
   */
  describe('signing in', () => {
    const signedOut = route({ id: 'agent:codex', kind: 'agent', reason: 'signedOut' })

    it('says it is waiting, and offers the way to find out', async () => {
      const { port } = portWith(probeOf(signedOut))
      const model = createRoutesModel({ port, ...wiring() })
      await model.refresh()
      expect(model.getSnapshot().rows[0]?.action).toBe('sign-in')

      await model.signIn('agent:codex')
      const row = model.getSnapshot().rows[0]
      expect(row?.action, 'the row still offered a second login flow').toBe('check-again')
      expect(row?.value).toBe('Waiting for sign-in…')
      model.dispose()
    })

    /* ONE FLOW AT A TIME. The claim is made before the await, so a second
       press while the first is being launched cannot open another. */
    it('does not launch a second flow while one is being started', async () => {
      const gate = deferred()
      const started: string[] = []
      const port = {
        generate: async () => '',
        agentAsk: async () => '',
        probe: async () => probeOf(signedOut),
        ensureReady: async () => true,
        signIn: async (id: string) => {
          started.push(id)
          await gate.promise
        },
        } satisfies InferencePort
      const model = createRoutesModel({ port, ...wiring() })
      await model.refresh()

      const first = model.signIn('agent:codex')
      expect(model.getSnapshot().rows[0]?.action).toBe('check-again')
      gate.open()
      await first
      expect(started).toEqual(['agent:codex'])
      model.dispose()
    })

    /* AND THE WAIT TERMINATES. A pending state with no exit is worse than
       none: the next probe ends it whatever it says, so a login that worked
       shows `Use` and one that did not goes back to `Sign in…`. */
    it('ends the wait at the next probe, whichever way it went', async () => {
      let signedIn = false
      const port = {
        generate: async () => '',
        agentAsk: async () => '',
        probe: async () =>
          probeOf(signedIn ? codexReady : signedOut),
        ensureReady: async () => true,
        signIn: async () => {},
        } satisfies InferencePort
      const model = createRoutesModel({ port, ...wiring() })
      await model.refresh()
      await model.signIn('agent:codex')
      expect(model.getSnapshot().rows[0]?.action).toBe('check-again')

      /* Still signed out: back to offering the flow rather than waiting on
         one that has already failed. */
      await model.refresh()
      expect(model.getSnapshot().rows[0]?.action).toBe('sign-in')

      await model.signIn('agent:codex')
      signedIn = true
      await model.refresh()
      expect(model.getSnapshot().rows[0]?.action).toBe('in-use')
      model.dispose()
    })

    /* A LAUNCH THAT FAILS DOES NOT LEAVE THE ROW WAITING FOREVER, and it says
       so in the log — this used to be the rejection of a promise the pane
       discarded with `void`. */
    it('returns the row and reports when the flow will not launch', async () => {
      const events: { event: string; fields: Record<string, unknown> }[] = []
      const port = {
        generate: async () => '',
        agentAsk: async () => '',
        probe: async () => probeOf(signedOut),
        ensureReady: async () => true,
        signIn: async () => {
          throw new Error('Codex is not installed')
        },
        } satisfies InferencePort
      const model = createRoutesModel({
        port,
        ...wiring(),
        report: (event, fields) => void events.push({ event, fields }),
      })
      await model.refresh()

      await expect(model.signIn('agent:codex')).resolves.toBeUndefined()
      expect(model.getSnapshot().rows[0]?.action).toBe('sign-in')
      expect(events[0]?.event).toBe('companion.sign-in-failed')
      expect(events[0]?.fields.message).toBe('Codex is not installed')
      model.dispose()
    })

    /**
     * ⚠️ **AND IT SAID SO IN THE LOG AND NOWHERE ELSE.**
     *
     * The row goes back to `Sign in…` and the pane drew nothing, so a login
     * that could not be launched — no CLI installed, a spawn refused — looked
     * exactly like a press that was ignored, which is the one reading that
     * makes a reader press it again. The snapshot names the route and the
     * reason now, and the pane draws them (2026-09-13 audit, round 2).
     */
    const refusing = (cause: unknown) => {
      const port = {
        generate: async () => '',
        agentAsk: async () => '',
        probe: async () => probeOf(signedOut),
        ensureReady: async () => true,
        signIn: async () => {
          throw cause
        },
      } satisfies InferencePort
      return createRoutesModel({ port, ...wiring() })
    }

    it('names the route and the reason the reader can act on', async () => {
      const model = refusing({ kind: 'agentMissing', message: 'codex is not on PATH' })
      await model.refresh()
      await model.signIn('agent:codex')

      expect(model.getSnapshot().signInFailure, 'the reader was told nothing about a login that never opened').toEqual({
        route: 'agent:codex',
        reason: 'That agent is not installed',
      })
      model.dispose()
    })

    /* IT DESCRIBES THE LAST PRESS, not everything that has ever failed: the
       next attempt clears it before it can add a second, and the next probe
       clears it because whatever it reports is newer. */
    it('clears the reason when the reader tries again, and at the next probe', async () => {
      let refuse = true
      const port = {
        generate: async () => '',
        agentAsk: async () => '',
        probe: async () => probeOf(signedOut),
        ensureReady: async () => true,
        signIn: async () => {
          if (refuse) throw { kind: 'agentMissing', message: 'codex is not on PATH' }
        },
      } satisfies InferencePort
      const model = createRoutesModel({ port, ...wiring() })
      await model.refresh()
      await model.signIn('agent:codex')
      expect(model.getSnapshot().signInFailure, 'nothing failed, so this measures nothing').not.toBeNull()

      refuse = false
      await model.signIn('agent:codex')
      expect(model.getSnapshot().signInFailure, 'a press that worked still showed the last one’s reason').toBeNull()

      refuse = true
      await model.signIn('agent:codex')
      expect(model.getSnapshot().signInFailure).not.toBeNull()
      await model.refresh()
      expect(model.getSnapshot().signInFailure, 'a fresh probe still showed a reason it had just superseded').toBeNull()
      model.dispose()
    })

    /* A failure before the first probe has no row to sit beside, and the
       snapshot must still not contradict the model that holds it. */
    it('carries the reason even with no routes to draw it against', async () => {
      const model = refusing(new Error('the flow could not be launched'))
      await model.signIn('agent:codex')
      expect(model.getSnapshot().signInFailure).toEqual({ route: 'agent:codex', reason: 'Something went wrong' })
      model.dispose()
    })

    /* THE PANE IS ALREADY DRAWING THE WAIT when a launch fails — it read the
       snapshot the press produced — so the failure must be a change it is told
       about, not one it would only see on a read it has no reason to make. */
    it('tells the pane when a launch it is already showing fails', async () => {
      let refuse: (cause: unknown) => void = () => {}
      const port = {
        generate: async () => '',
        agentAsk: async () => '',
        probe: async () => probeOf(signedOut),
        ensureReady: async () => true,
        signIn: () => new Promise<void>((_done, fail) => void (refuse = fail)),
      } satisfies InferencePort
      const model = createRoutesModel({ port, ...wiring() })
      await model.refresh()
      let told = 0
      model.subscribe(() => void (told += 1))

      const pressed = model.signIn('agent:codex')
      expect(model.getSnapshot().rows[0]?.action).toBe('check-again')
      expect(told).toBe(1)
      refuse({ kind: 'agentMissing', message: 'codex is not on PATH' })
      await pressed

      expect(told, 'the failure changed the snapshot and nobody was told').toBe(2)
      expect(model.getSnapshot().rows[0]?.action).toBe('sign-in')
      expect(model.getSnapshot().signInFailure).toEqual({ route: 'agent:codex', reason: 'That agent is not installed' })
      model.dispose()
    })
  })

  it('writes the chosen route, and signs in through the port', async () => {
    const { settings } = wiring()
    const { port, signedIn } = portWith(probeOf(route({ id: 'codex', kind: 'agent' })))
    const model = createRoutesModel({ port, settings })
    await model.refresh()
    model.use('codex')
    expect(settings.get(ROUTE_SETTING)).toBe('codex')
    await model.signIn('codex')
    expect(signedIn).toEqual(['codex'])
    model.dispose()
  })

  /* THE REGRESSION, NAMED. `getSnapshot` is the `useSyncExternalStore` read
     that runs on mount, and it used to resolve the look-up label there —
     reading a `kernel.`-namespaced setting through the scoped handle, which
     throws `namespace` under the real guard. That is what `Settings → Local
     models` and this pane both did in the running app.
     The label is gone; the shape of the defect is not, so this stays as the
     assertion that the mount-time read is clean under the guard. */
  it('builds a snapshot without touching the kernel namespace', async () => {
    const { settings } = wiring()
    const { port } = portWith(probeOf(route({ id: 'local:m', kind: 'local', installed: true })))
    const model = createRoutesModel({ port, settings })
    await model.refresh()
    expect(() => model.getSnapshot()).not.toThrow()
    expect(model.getSnapshot().rows).not.toEqual([])
    model.dispose()
  })

  it('writes the effort through the settings store, not its own field', () => {
    const { settings } = wiring()
    const { port } = portWith(probeOf())
    const model = createRoutesModel({ port, settings })
    model.cycleDepth()
    expect(settings.get(DEPTH_SETTING)).toBe(DEPTH_ORDER[1])
    model.dispose()
  })

  /* ⚠️ AND NOTHING WRITES `companion.tools`. There was a persisted setting and
     a checkbox for it, and no answer path anywhere read either — so the row
     told the reader they had restricted the companion, or freed it, and
     neither was true. An inert privacy control fails convincingly, which is
     worse than not having one. This is what stops it coming back without the
     enforcement point that would make it mean something. */
  it('stores nothing under `companion.tools`', () => {
    const { settings } = wiring()
    const { port } = portWith(probeOf())
    const model = createRoutesModel({ port, settings })
    model.cycleDepth()
    model.use('agent:codex')
    /* Neither in the snapshot the pane draws from, nor reachable as a
       setting: `TOOLS_SETTING` no longer exists to be read. */
    expect(Object.keys(model.getSnapshot())).not.toContain('tools')
    model.dispose()
  })

  /* A failed probe is drawn as no routes, so the log is the only place a dead
     plugin and an empty machine differ. BOTH HALVES are asserted: the rows are
     what the reader sees, and nothing else here would notice a failed probe
     drawing a row it invented. */
  it('reports a probe that fails, with what it said', async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const { port } = portWith(async () => {
      throw new Error('the daemon is not there')
    })
    const model = createRoutesModel({ port, ...wiring(), report: (event, fields) => void events.push({ event, fields }) })
    await model.refresh()
    expect(events).toEqual([{ event: 'companion.probe-failed', fields: { message: 'the daemon is not there' } }])
    expect(model.getSnapshot().loading, 'the failed probe was never taken as an answer').toBe(false)
    expect(model.getSnapshot().rows).toEqual([])
    model.dispose()
  })

  /* A subscriber that throws is said, BY NAME, and does not stop the others. */
  it('names itself when a subscriber throws, and still tells the rest', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { port } = portWith(probeOf(codexReady))
      const model = createRoutesModel({ port, ...wiring() })
      const broke = new Error('the panel is gone')
      let told = 0
      model.subscribe(() => {
        throw broke
      })
      model.subscribe(() => void (told += 1))
      await model.refresh()
      expect(told).toBe(1)
      expect(said.mock.calls).toEqual([['Paper: a routes subscriber threw while being notified', broke]])
      model.dispose()
    } finally {
      said.mockRestore()
    }
  })

  /* STILL THE SAME OBJECT while there is nothing to draw. A settings write
     before the first probe changes nothing the pane shows, so the snapshot it
     reads must not become a new object that asks React to draw it again. */
  it('keeps the empty snapshot as one object while there is still no probe', () => {
    const { port } = portWith(probeOf(codexReady))
    const model = createRoutesModel({ port, ...wiring() })
    const first = model.getSnapshot()
    model.cycleDepth()
    expect(model.getSnapshot()).toBe(first)
    model.dispose()
  })

  /* THE ROUTE IN USE, not the first one listed: a signed-out agent listed ahead
     of the local model answering is not what the effort applies to. */
  it('offers the effort for the route in use, not for the first route listed', async () => {
    const { port } = portWith(probeOf(claudeOut, localReady))
    const model = createRoutesModel({ port, ...wiring() })
    await model.refresh()
    expect(model.getSnapshot().inUse).toBe('local:qwen')
    expect(model.getSnapshot().depth).toBeNull()
    model.dispose()
  })

  /* THE WORDS ON THE BUTTON, held to the letter: the cycle's order is asserted
     elsewhere through `DEPTH_LABELS` itself, which would pass over empty ones. */
  it('names each effort in the words the reader reads', async () => {
    const { port } = portWith(probeOf(codexReady))
    const model = createRoutesModel({ port, ...wiring() })
    await model.refresh()
    const seen = [model.getSnapshot().depth]
    model.cycleDepth()
    seen.push(model.getSnapshot().depth)
    model.cycleDepth()
    seen.push(model.getSnapshot().depth)
    expect(seen).toEqual(['Account default', 'Faster', 'More thorough'])
    model.dispose()
  })

  describe('once disposed', () => {
    /* A refresh begun AFTER dispose claims a generation of its own, so the
       generation guard cannot be what stops it. */
    it('changes nothing for a refresh begun after dispose', async () => {
      const { port } = portWith(probeOf(codexReady))
      const model = createRoutesModel({ port, ...wiring() })
      model.dispose()
      await model.refresh()
      expect(model.getSnapshot().loading).toBe(true)
      expect(model.getSnapshot().rows).toEqual([])
    })

    /* The settings store outlives the pane; a subscription left on it keeps a
       closed pane's model alive for as long as the app runs. */
    it('lets go of the settings store', () => {
      const { settings } = wiring()
      const live = new Set<() => void>()
      const counted: SettingsStore = {
        ...settings,
        subscribe: (listener) => {
          live.add(listener)
          const off = settings.subscribe(listener)
          return () => {
            live.delete(listener)
            off()
          }
        },
      }
      const { port } = portWith(probeOf())
      const model = createRoutesModel({ port, settings: counted })
      expect(live.size).toBe(1)
      model.dispose()
      expect(live.size, 'a disposed model is still subscribed to settings').toBe(0)
    })

    it('tells a subscriber nothing, a sign-in included', async () => {
      const { port } = portWith(probeOf(claudeOut))
      const model = createRoutesModel({ port, ...wiring() })
      let seen = 0
      model.subscribe(() => void (seen += 1))
      model.dispose()
      await model.signIn('agent:claude')
      expect(seen, 'a listener was told about a change after dispose').toBe(0)
    })
  })

  /* ⚠️ `cycles Look up only when there is more than one mode` WAS HERE. It
     pinned that a machine with one available mode could not be cycled into a
     mode that does nothing — a real rule while `Look up` had three modes. It
     has none: the system-dictionary hand-off is deleted and the gloss is the
     whole feature, so `cycleLookUp` is gone from this model and from the
     kernel. */
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
    const { settings } = wiring()
    const { port } = portWith(probeOf(route({ id: 'local:m', kind: 'local', installed: true })))
    const model = createRoutesModel({ port, settings })
    await model.refresh()
    expect(model.getSnapshot().inUse).toBe('local:m')
    expect(model.getSnapshot().depth).toBeNull()
    model.dispose()
  })

  it('shows the account default while an agent is answering', async () => {
    const { settings } = wiring()
    const { port } = portWith(probeOf(route({ id: 'agent:codex', kind: 'agent' })))
    const model = createRoutesModel({ port, settings })
    await model.refresh()
    expect(model.getSnapshot().depth).toBe(DEPTH_LABELS.default)
    model.dispose()
  })

  it('cycles the whole set and wraps back to the account default', async () => {
    const { settings } = wiring()
    const { port } = portWith(probeOf(route({ id: 'agent:codex', kind: 'agent' })))
    const model = createRoutesModel({ port, settings })
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
