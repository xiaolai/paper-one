import { describe, expect, it, vi } from 'vitest'
import { createSettingsStore } from '../../../kernel'
import type { InferenceSnapshot } from './controller'
import {
  AUTOMATIC,
  GLOSS_ROUTE_SETTING,
  ROUTE_FAILURE_KINDS,
  answeringRoute,
  createRouteStore,
  endpointRouteId,
  followLocal,
  inAnsweringOrder,
  isLocalRoute,
  localRouteId,
  usableLocal,
  usableRemote,
} from './glossRoute'
import type { Probe, Route } from './plugin'

/**
 * WHICH ROUTE ANSWERS A LOOKUP — the rule, case by case.
 *
 * The owner's decision of 2026-09-18: any usable route may answer — the local
 * model (an opt-in download), an OpenAI-compatible endpoint, Claude, Codex —
 * the reader's choice when it can, and otherwise the first Automatic finds, in
 * that order. `glossProvider.test.ts` holds that the provider obeys this; these
 * hold the rule itself, so a wrong order or a wrong reading of "usable" fails
 * here by name rather than as a lookup answered by the wrong thing.
 */

/** A probe route that can answer, of the kind its id names. */
const usable = (id: string): Route => ({
  id,
  kind: id.startsWith('endpoint:') ? 'endpoint' : id.startsWith('agent:') ? 'agent' : 'local',
  label: id,
  detail: null,
  unusable: null,
  installed: true,
})
/** The same route, unable to answer — the sentence and the code together, as `probe.rs` emits them. */
const unusable = (id: string): Route => ({ ...usable(id), unusable: 'No key', reason: 'noKey' })

const snapshot = (
  runtime: InferenceSnapshot['runtime']['kind'],
  models: readonly (readonly [string, boolean])[],
): Pick<InferenceSnapshot, 'runtime' | 'models'> => ({
  runtime: runtime === 'absent' ? { kind: 'absent', reason: 'x' } : ({ kind: runtime } as InferenceSnapshot['runtime']),
  models: models.map(([id, installed]) => ({ id, label: id, license: 'Apache-2.0', bytes: 1, installed })),
})

describe('the reader’s choice, as a setting', () => {
  it('names its key and Automatic as its default', () => {
    expect(GLOSS_ROUTE_SETTING.key).toBe('inference.glossRoute')
    expect(GLOSS_ROUTE_SETTING.fallback).toBe(AUTOMATIC)
    expect(AUTOMATIC).toBe('')
  })

  it.each(['', 'local:qwen3-4b-instruct-2507-q4-k-m', 'endpoint:groq', 'agent:claude', 'agent:codex'])(
    'keeps %o, which is a route or Automatic',
    (raw) => {
      expect(GLOSS_ROUTE_SETTING.parse(raw)).toBe(raw)
    },
  )

  /* THE TRUST BOUNDARY: a value this refuses becomes Automatic, so the worst a
     damaged settings file can do is let the first usable route answer. */
  it.each([
    [42, 'not a string'],
    [null, 'null'],
    [['agent:claude'], 'a list'],
    ['claude', 'a name with no kind'],
    ['agent:', 'a kind with no name'],
    ['web:claude', 'a kind no route has'],
    ['agent: claude', 'a space in it'],
    ['agent:claude\n', 'a trailing newline'],
    [' agent:claude', 'a leading space'],
  ] as const)('refuses %o — %s', (raw: unknown, _why: string) => {
    expect(GLOSS_ROUTE_SETTING.parse(raw)).toBeUndefined()
  })

  it('takes a route of exactly the bound, and refuses one character more', () => {
    const at = `local:${'a'.repeat(250)}`
    expect(at.length, 'the case is not at the bound, so this measures nothing').toBe(256)
    expect(GLOSS_ROUTE_SETTING.parse(at)).toBe(at)
    expect(GLOSS_ROUTE_SETTING.parse(`${at}a`)).toBeUndefined()
  })

  /* A CAPABILITY'S SETTING IS DURABLE WITHOUT A SECOND REGISTRATION —
     `SettingsStore.set` writes through, which `GLOSS_PROMPT_SETTING`'s own
     relaunch case measures the same way: a second store over the same storage. */
  it('is still there when a fresh store opens over the same storage', () => {
    const held = new Map<string, string>()
    const storage = {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
    } as unknown as Storage
    createSettingsStore({ storage }).set(GLOSS_ROUTE_SETTING, 'agent:claude')
    expect(createSettingsStore({ storage }).get(GLOSS_ROUTE_SETTING)).toBe('agent:claude')
  })
})

describe('route ids', () => {
  it('spells a local and an endpoint route as the probe does, and knows a local one', () => {
    expect(localRouteId('qwen')).toBe('local:qwen')
    expect(endpointRouteId('groq')).toBe('endpoint:groq')
    expect(isLocalRoute('local:qwen')).toBe(true)
    expect(isLocalRoute('endpoint:local')).toBe(false)
    expect(isLocalRoute('agent:claude')).toBe(false)
  })
})

describe('Automatic’s order', () => {
  /* The order measured cheapest-and-fastest first: the local model, then
     endpoints, then Claude, then Codex — and an agent this build does not know
     last rather than refused. STABLE: endpoints keep the probe's order. */
  it('puts the local model first, endpoints in probe order, then Claude, then Codex, then any other agent', () => {
    const order = inAnsweringOrder([
      usable('agent:other'),
      usable('agent:codex'),
      usable('endpoint:second'),
      usable('agent:claude'),
      usable('local:qwen'),
      usable('endpoint:first'),
    ]).map((route) => route.id)
    expect(order).toEqual(['local:qwen', 'endpoint:second', 'endpoint:first', 'agent:claude', 'agent:codex', 'agent:other'])
  })

  it('leaves the list it was given as it was', () => {
    const given = [usable('agent:codex'), usable('local:qwen')]
    inAnsweringOrder(given)
    expect(given.map((route) => route.id)).toEqual(['agent:codex', 'local:qwen'])
  })
})

describe('the local model, from the controller', () => {
  /* A model with nothing to run it is not an answer — the 2026-09-13 audit
     found `available` saying yes over exactly that. */
  it('is no route at all while the runtime is absent, however many models are on disk', () => {
    expect(usableLocal(snapshot('absent', [['qwen', true]]), 'qwen')).toEqual([])
  })

  it('puts the preferred model first, then every other installed one, and nothing not installed', () => {
    const models = [['a', true], ['b', true], ['c', false]] as const
    expect(usableLocal(snapshot('installed', models), 'b')).toEqual(['local:b', 'local:a'])
    expect(usableLocal(snapshot('ready', models), 'a')).toEqual(['local:a', 'local:b'])
  })

  it('is nothing when nothing is installed', () => {
    expect(usableLocal(snapshot('degraded', [['a', false]]), null)).toEqual([])
  })
})

describe('the route that answers', () => {
  const local = ['local:qwen']

  it('is the local model on Automatic, whatever else can answer', () => {
    expect(answeringRoute(AUTOMATIC, local, [usable('agent:claude'), usable('endpoint:groq')])).toBe('local:qwen')
  })

  /* THE CASE THE DECISION WAS MADE FOR: no download, and Look up still works. */
  it('is the first usable endpoint on Automatic when there is no local model, then Claude, then Codex', () => {
    const everything = [usable('agent:codex'), usable('agent:claude'), unusable('endpoint:keyless'), usable('endpoint:groq')]
    expect(answeringRoute(AUTOMATIC, [], everything)).toBe('endpoint:groq')
    expect(answeringRoute(AUTOMATIC, [], everything.filter((route) => route.kind !== 'endpoint'))).toBe('agent:claude')
    expect(answeringRoute(AUTOMATIC, [], [usable('agent:codex'), unusable('agent:claude')])).toBe('agent:codex')
  })

  it('is the reader’s choice when it can answer, over the local model', () => {
    expect(answeringRoute('agent:codex', local, [usable('agent:claude'), usable('agent:codex')])).toBe('agent:codex')
    expect(answeringRoute('endpoint:groq', local, [usable('endpoint:groq')])).toBe('endpoint:groq')
  })

  it('is a local model the reader chose by name, when it is installed', () => {
    expect(answeringRoute('local:small', ['local:big', 'local:small'], [])).toBe('local:small')
  })

  /* WI-15.11: a choice that cannot answer falls back — it is not an error, and
     it is not a reason to answer with nothing. */
  it('is Automatic’s answer while the reader’s choice cannot answer', () => {
    expect(answeringRoute('agent:claude', local, [unusable('agent:claude')])).toBe('local:qwen')
    expect(answeringRoute('endpoint:gone', [], [usable('agent:codex')])).toBe('agent:codex')
  })

  /* ⚠️ **THE PROBE'S LOCAL ROUTES ARE NEVER READ.** A probe that predates a
     removal still calls the model usable; the controller knows it is gone. */
  it('does not answer with a local model the probe calls usable and the controller does not', () => {
    expect(answeringRoute('local:qwen', [], [usable('local:qwen')])).toBeNull()
    expect(answeringRoute(AUTOMATIC, [], [usable('local:qwen')])).toBeNull()
  })

  it('is nothing when nothing can answer', () => {
    expect(answeringRoute(AUTOMATIC, [], [])).toBeNull()
    expect(answeringRoute('agent:claude', [], [unusable('agent:claude'), unusable('endpoint:groq')])).toBeNull()
  })

  it('lists the usable probed routes in Automatic’s order, and never a local one', () => {
    expect(usableRemote([usable('agent:codex'), usable('local:qwen'), unusable('agent:claude'), usable('endpoint:groq')])).toEqual([
      'endpoint:groq',
      'agent:codex',
    ])
  })
})

describe('the failures that say the probe was wrong', () => {
  /* EXACTLY THESE: each is something a fresh probe would report. An endpoint
     that answered no, one that could not be reached, and a runtime failure are
     not things a probe asks about, and each probe spawns the agent CLIs. */
  it('are the ones a fresh probe would report, and no others', () => {
    expect([...ROUTE_FAILURE_KINDS].sort()).toEqual(
      ['agentMissing', 'agentSignedOut', 'agentUnsupportedVersion', 'keychain', 'modelUnknown'].sort(),
    )
  })
})

/** A promise the test resolves when it wants the probe under test to land. */
function pending<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve: (value) => resolve(value) }
}

const answer = (...routes: Route[]): Probe => ({ routes, runtimeVersion: null })

describe('the held probe', () => {
  it('holds nothing before a probe has answered, says when one is out, and holds what it found', async () => {
    const landing = pending<Probe>()
    const store = createRouteStore({ plugin: { probe: () => landing.promise } })
    expect(store.getSnapshot()).toEqual({ routes: null, probing: false })

    const refreshed = store.refresh()
    expect(store.getSnapshot()).toEqual({ routes: null, probing: true })
    landing.resolve(answer(usable('agent:claude')))
    await refreshed
    expect(store.getSnapshot()).toEqual({ routes: [usable('agent:claude')], probing: false })
  })

  /* WHAT WAS KNOWN STAYS KNOWN while the next probe is out — a list that
     emptied on every refresh would flicker every row in the section. */
  it('keeps the last answer while the next probe is out', async () => {
    const later = pending<Probe>()
    const probe = vi.fn().mockResolvedValueOnce(answer(usable('agent:claude'))).mockReturnValueOnce(later.promise)
    const store = createRouteStore({ plugin: { probe } })
    await store.refresh()
    const again = store.refresh()
    expect(store.getSnapshot()).toEqual({ routes: [usable('agent:claude')], probing: true })
    later.resolve(answer())
    await again
  })

  /* LAST ISSUED WINS: the CLIs a probe spawns finish in no particular order. */
  it('lets the newer probe’s answer stand when an older one lands after it', async () => {
    const older = pending<Probe>()
    const newer = pending<Probe>()
    const probe = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const store = createRouteStore({ plugin: { probe } })
    const first = store.refresh()
    const second = store.refresh()
    newer.resolve(answer(usable('agent:codex')))
    await second
    older.resolve(answer(usable('agent:claude')))
    await first
    expect(store.getSnapshot()).toEqual({ routes: [usable('agent:codex')], probing: false })
  })

  /* A PROBE THAT FAILED IS NO ROUTES — nothing is sent anywhere on the strength
     of an older answer — and it is REPORTED, because an empty list is also what
     a machine with nothing set up looks like. It never rejects. */
  it('reads a failed probe as no routes, and reports it', async () => {
    const report = vi.fn()
    const probe = vi.fn().mockResolvedValueOnce(answer(usable('agent:claude'))).mockRejectedValueOnce({ kind: 'agentMissing', message: 'no claude on PATH' })
    const store = createRouteStore({ plugin: { probe }, report })
    await store.refresh()
    await expect(store.refresh()).resolves.toBeUndefined()
    expect(store.getSnapshot()).toEqual({ routes: [], probing: false })
    expect(report.mock.calls).toEqual([['inference.probe-failed', { message: 'no claude on PATH' }]])
  })

  it('still settles when the reporter itself throws', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createRouteStore({
        plugin: { probe: () => Promise.reject(new Error('spawn refused')) },
        report: () => {
          throw new Error('reporter broke')
        },
      })
      await expect(store.refresh()).resolves.toBeUndefined()
      expect(store.getSnapshot().routes).toEqual([])
      expect(said).toHaveBeenCalledWith(
        'inference routes: the failure reporter itself threw',
        expect.objectContaining({ message: 'reporter broke' }),
        'while reporting a failed probe',
      )
    } finally {
      said.mockRestore()
    }
  })

  it('tells its subscribers, and stops telling one that left', async () => {
    const store = createRouteStore({ plugin: { probe: async () => answer() } })
    let told = 0
    const leave = store.subscribe(() => {
      told += 1
    })
    await store.refresh()
    /* Twice: the probe going out, and its answer landing. */
    expect(told).toBe(2)
    leave()
    await store.refresh()
    expect(told).toBe(2)
  })

  it('names a subscriber that throws, and still tells the others', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createRouteStore({ plugin: { probe: async () => answer() } })
      const broke = new Error('a subscriber broke')
      store.subscribe(() => {
        throw broke
      })
      let told = 0
      store.subscribe(() => void (told += 1))
      await store.refresh()
      expect(told).toBe(2)
      expect(said).toHaveBeenCalledWith('Paper: a gloss routes subscriber threw while being notified', broke)
    } finally {
      said.mockRestore()
    }
  })

  /* A STOPPED STORE ASKS NOTHING AND WRITES NOTHING — a probe spawns
     processes, and one landing after the capability stopped is nobody's. */
  it('asks nothing once disposed, and lets a probe already out land on nothing', async () => {
    const landing = pending<Probe>()
    const probe = vi.fn().mockReturnValueOnce(landing.promise)
    const store = createRouteStore({ plugin: { probe } })
    const out = store.refresh()
    store.dispose()
    landing.resolve(answer(usable('agent:claude')))
    await out
    expect(store.getSnapshot().routes, 'a probe landed on a stopped store').toBeNull()

    await store.refresh()
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('following the local model', () => {
  /** A controller-shaped store whose local routes the test sets. */
  const world = () => {
    const listeners = new Set<() => void>()
    let local: readonly string[] = []
    return {
      controller: {
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
      current: () => local,
      set: (next: readonly string[]) => {
        local = next
        for (const listener of listeners) listener()
      },
      listeners,
    }
  }

  /* ONE PROBE PER CHANGE, not one per notification: the controller notifies
     on every byte of a download. */
  it('probes again when the local routes change, and at no other notification', () => {
    const w = world()
    const refresh = vi.fn()
    followLocal(w.controller, w.current, refresh)
    w.set([])
    expect(refresh, 'a notification that changed nothing cost a probe').not.toHaveBeenCalled()
    w.set(['local:qwen'])
    w.set(['local:qwen'])
    expect(refresh).toHaveBeenCalledTimes(1)
    w.set([])
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  /* READ AT THE START, so a caller that has just probed does not probe again
     for a state it already saw. */
  it('takes what the local routes are when it starts as already seen', () => {
    const w = world()
    w.set(['local:qwen'])
    const refresh = vi.fn()
    followLocal(w.controller, w.current, refresh)
    w.set(['local:qwen'])
    expect(refresh).not.toHaveBeenCalled()
  })

  it('stops following when asked', () => {
    const w = world()
    const refresh = vi.fn()
    const stop = followLocal(w.controller, w.current, refresh)
    stop()
    expect(w.listeners.size).toBe(0)
    w.set(['local:qwen'])
    expect(refresh).not.toHaveBeenCalled()
  })
})
