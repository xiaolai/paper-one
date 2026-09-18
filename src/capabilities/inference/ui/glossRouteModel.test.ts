import { describe, expect, it, vi } from 'vitest'
import { createSettingsStore, type SettingsStore } from '../../../kernel'
import type { InferenceSnapshot } from '../lib/controller'
import { AUTOMATIC, GLOSS_ROUTE_SETTING, createRouteStore } from '../lib/glossRoute'
import type { Endpoint, Probe, Route } from '../lib/plugin'
import { choicesFor, createGlossRouteModel, whereTheWordsGo, type GlossRouteSnapshot } from './glossRouteModel'

/**
 * The **Answers with** list in Settings → Look up — what it offers, what it
 * marks `In use`, and the one sentence saying where a reader's words go.
 *
 * That sentence is the part a reader needs before choosing anything that is not
 * on this machine, so it is asserted WORD FOR WORD: "sent to Anthropic" and
 * "stays on this machine" are not interchangeable, and a pattern loose enough
 * to pass both would pass the wrong one.
 */

const route = (id: string, over: Partial<Route> = {}): Route => ({
  id,
  kind: id.startsWith('endpoint:') ? 'endpoint' : id.startsWith('agent:') ? 'agent' : 'local',
  label: id,
  detail: null,
  unusable: null,
  installed: true,
  ...over,
})
const signedOut = (id: string, label: string): Route => route(id, { label, unusable: 'Signed out', reason: 'signedOut' })

const endpoint = (over: Partial<Endpoint> & Pick<Endpoint, 'id'>): Endpoint => ({
  label: over.id,
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'llama-3.1-8b-instant',
  keyState: 'set',
  ...over,
})

const SENT = 'Each word you look up, with its sentence and the book’s title,'

describe('where the words go', () => {
  it('says a local answer stays on this machine', () => {
    expect(whereTheWordsGo('local:qwen', () => 'Qwen3-4B', [])).toBe(`${SENT} stays on this machine.`)
  })

  /* ⚠️ BY HOST, NOT BY LABEL: the label is whatever the reader typed, and an
     endpoint called "local" whose address is somebody's server must not read as
     though the words stayed here. */
  it('names an endpoint by the host its words are sent to, not by its label', () => {
    const remote = endpoint({ id: 'local', label: 'local', baseUrl: 'https://api.groq.com/openai/v1' })
    expect(whereTheWordsGo('endpoint:local', () => 'local', [remote])).toBe(`${SENT} is sent to api.groq.com.`)
    const ollama = endpoint({ id: 'ollama', baseUrl: 'http://localhost:11434/v1' })
    expect(whereTheWordsGo('endpoint:ollama', () => 'Ollama', [ollama])).toBe(`${SENT} is sent to localhost:11434.`)
  })

  /* An endpoint the list does not hold — removed since the probe — is named by
     the only name left for it rather than by nothing. */
  it('falls back to the label for an endpoint the list does not hold', () => {
    expect(whereTheWordsGo('endpoint:gone', () => 'Old proxy', [endpoint({ id: 'other' })])).toBe(`${SENT} is sent to Old proxy.`)
  })

  it('names the vendor an agent sends the words to, through the reader’s own CLI', () => {
    expect(whereTheWordsGo('agent:claude', () => 'Claude', [])).toBe(`${SENT} is sent to Anthropic through your signed-in CLI.`)
    expect(whereTheWordsGo('agent:codex', () => 'Codex', [])).toBe(`${SENT} is sent to OpenAI through your signed-in CLI.`)
    expect(whereTheWordsGo('agent:other', (id) => `the ${id} CLI`, [])).toBe(`${SENT} is sent through the agent:other CLI.`)
  })

  it('says what would make something answer, when nothing can', () => {
    expect(whereTheWordsGo(null, () => 'never asked', [])).toBe(
      'Nothing can answer yet. Install a model in Local models, add an endpoint in Cloud endpoints, or install and sign in to Claude or Codex.',
    )
  })
})

describe('the list', () => {
  const labelOf = (id: string): string => `«${id}»`
  const probed = [route('agent:codex', { label: 'Codex', detail: 'ChatGPT · 0.149.0' }), signedOut('agent:claude', 'Claude'), route('local:qwen', { label: 'Qwen3-4B', detail: 'local · 2.5 GB' })]

  it('offers Automatic first and every probed route after it, in Automatic’s order, each with the probe’s own words', () => {
    const choices = choicesFor(AUTOMATIC, 'local:qwen', 'local:qwen', ['local:qwen', 'agent:codex'], probed, labelOf)
    expect(choices).toEqual([
      { id: AUTOMATIC, label: 'Automatic', value: '«local:qwen»', action: 'in-use' },
      { id: 'local:qwen', label: 'Qwen3-4B', value: 'local · 2.5 GB', action: 'use' },
      { id: 'agent:claude', label: 'Claude', value: 'Signed out', action: 'none' },
      { id: 'agent:codex', label: 'Codex', value: 'ChatGPT · 0.149.0', action: 'use' },
    ])
  })

  it('marks the reader’s choice in use when it answers, and offers Automatic back', () => {
    const choices = choicesFor('agent:codex', 'agent:codex', 'local:qwen', ['local:qwen', 'agent:codex'], probed, labelOf)
    expect(choices.map((choice) => [choice.id, choice.action])).toEqual([
      [AUTOMATIC, 'use'],
      ['local:qwen', 'use'],
      ['agent:claude', 'none'],
      ['agent:codex', 'in-use'],
    ])
  })

  /* WHAT IS IN EFFECT: a stored choice that cannot answer leaves Automatic
     answering, so Automatic is what says `In use`. */
  it('marks Automatic in use while the reader’s choice cannot answer', () => {
    const choices = choicesFor('agent:claude', 'local:qwen', 'local:qwen', ['local:qwen', 'agent:codex'], probed, labelOf)
    expect(choices.map((choice) => [choice.id, choice.action])).toEqual([
      [AUTOMATIC, 'in-use'],
      ['local:qwen', 'use'],
      ['agent:claude', 'none'],
      ['agent:codex', 'use'],
    ])
  })

  /* SELECTABLE MEANS THE DECISION WOULD TAKE IT — the controller's word for a
     local model, not a probe that predates the download. */
  it('offers a local model the controller can run, whatever an older probe said of it', () => {
    const stale = route('local:qwen', { label: 'Qwen3-4B', unusable: 'Not installed', reason: 'notInstalled' })
    const [, row] = choicesFor(AUTOMATIC, 'local:qwen', 'local:qwen', ['local:qwen'], [stale], labelOf)
    expect(row?.action).toBe('use')
  })

  /* NOTHING TO SAY IS SAID AS NOTHING — a usable route with no detail draws an
     empty value, not "null". */
  it('draws an empty value beside a usable route that carries no detail', () => {
    const [, row] = choicesFor(AUTOMATIC, 'agent:claude', 'agent:claude', ['agent:claude'], [route('agent:claude', { label: 'Claude' })], labelOf)
    expect(row?.value).toBe('')
  })

  it('says so on the Automatic row when nothing can answer', () => {
    expect(choicesFor(AUTOMATIC, null, null, [], [signedOut('agent:claude', 'Claude')], labelOf)[0]).toEqual({
      id: AUTOMATIC,
      label: 'Automatic',
      value: 'Nothing can answer yet',
      action: 'in-use',
    })
  })
})

/* ------------------------------- the model ------------------------------- */

function memorySettings(): SettingsStore {
  const held = new Map<string, string>()
  return createSettingsStore({
    storage: {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
    } as unknown as Storage,
  })
}

/** A controller-shaped store: the local model it holds, and a way to change it. */
function localModel(installed: boolean) {
  const listeners = new Set<() => void>()
  let has = installed
  const snapshot = (): InferenceSnapshot => ({
    runtime: { kind: 'installed' },
    models: [{ id: 'qwen', label: 'Qwen3-4B', license: 'Apache-2.0', bytes: 1, installed: has }],
    installing: null,
    removing: null,
    failure: null,
  })
  return {
    controller: {
      getSnapshot: snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      textModel: () => (has ? 'qwen' : null),
    },
    install: () => {
      has = true
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

function world(over: { readonly installed?: boolean; readonly probe?: () => Promise<Probe>; readonly endpoints?: () => Promise<readonly Endpoint[]> } = {}) {
  const settings = memorySettings()
  const routes = createRouteStore({
    plugin: {
      probe:
        over.probe ??
        (async () => ({
          routes: [route('local:qwen', { label: 'Qwen3-4B' }), route('agent:claude', { label: 'Claude' }), route('endpoint:groq', { label: 'Groq' })],
          runtimeVersion: null,
        })),
    },
  })
  const local = localModel(over.installed ?? true)
  const report = vi.fn()
  const endpoints = vi.fn(over.endpoints ?? (async () => [endpoint({ id: 'groq', label: 'Groq' })]))
  const model = createGlossRouteModel({ settings, routes, controller: local.controller, plugin: { endpoints }, report })
  return { settings, routes, local, report, endpoints, model }
}

/** Every snapshot a subscriber was handed, read at the notification — the way the pane reads it. */
const watch = (model: { subscribe(listener: () => void): () => void; getSnapshot(): GlossRouteSnapshot }): GlossRouteSnapshot[] => {
  const seen: GlossRouteSnapshot[] = []
  model.subscribe(() => void seen.push(model.getSnapshot()))
  return seen
}

describe('the Answers with model', () => {
  /* BEFORE THE FIRST PROBE the local model still answers — it is the
     controller's to say — and Automatic names it by the catalogue's label. */
  it('names the local model on Automatic before any probe has answered', () => {
    const { model } = world()
    const snapshot = model.getSnapshot()
    expect(snapshot.answering).toBe('local:qwen')
    expect(snapshot.choices).toEqual([{ id: AUTOMATIC, label: 'Automatic', value: 'Qwen3-4B', action: 'in-use' }])
    expect(snapshot.where).toBe(`${SENT} stays on this machine.`)
    expect(snapshot.unavailableChoice).toBeNull()
  })

  it('probes, reads the endpoint list, and draws what it found when the section is opened', async () => {
    const { model, endpoints, settings } = world({ installed: false })
    const seen = watch(model)
    await model.refresh()
    expect(endpoints).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)?.choices.map((choice) => [choice.id, choice.action])).toEqual([
      [AUTOMATIC, 'in-use'],
      ['local:qwen', 'none'],
      ['endpoint:groq', 'use'],
      ['agent:claude', 'use'],
    ])
    /* The endpoint is Automatic's first usable route with no local model, and
       it is named by where the words go. */
    expect(seen.at(-1)?.where).toBe(`${SENT} is sent to api.groq.com.`)

    model.use('agent:claude')
    expect(settings.get(GLOSS_ROUTE_SETTING)).toBe('agent:claude')
    expect(seen.at(-1)?.answering, 'the pane was not told the choice changed').toBe('agent:claude')
    expect(seen.at(-1)?.where).toBe(`${SENT} is sent to Anthropic through your signed-in CLI.`)
  })

  it('names the choice that cannot answer, and answers as Automatic meanwhile', async () => {
    const { model, settings } = world({
      probe: async () => ({ routes: [signedOut('agent:claude', 'Claude'), route('agent:codex', { label: 'Codex' })], runtimeVersion: null }),
    })
    settings.set(GLOSS_ROUTE_SETTING, 'agent:claude')
    await model.refresh()
    expect(model.getSnapshot().answering).toBe('local:qwen')
    expect(model.getSnapshot().unavailableChoice).toBe('Claude')
    /* And the choice is KEPT, so it comes back by itself. */
    expect(settings.get(GLOSS_ROUTE_SETTING)).toBe('agent:claude')
  })

  /* A CHOICE NOTHING LISTS ANY MORE — an endpoint deleted — is still named,
     by the only name left for it. */
  it('names a choice the probe no longer lists by its id', async () => {
    const { model, settings } = world()
    settings.set(GLOSS_ROUTE_SETTING, 'endpoint:deleted')
    await model.refresh()
    expect(model.getSnapshot().unavailableChoice).toBe('endpoint:deleted')
  })

  /* A DOWNLOAD FINISHING WITH THE SECTION OPEN changes what Automatic means,
     and the section is told. */
  it('hears the local model arrive', async () => {
    const { model, local } = world({ installed: false, probe: async () => ({ routes: [], runtimeVersion: null }) })
    await model.refresh()
    const seen = watch(model)
    expect(model.getSnapshot().answering).toBeNull()
    local.install()
    expect(seen.at(-1)?.answering).toBe('local:qwen')
  })

  /* AN UNREADABLE LIST COSTS THE HOST IN ONE SENTENCE — the route's label
     stands in — and the log says why. */
  it('names an endpoint by its label when the list would not read, and reports it', async () => {
    const { model, report } = world({
      installed: false,
      endpoints: async () => {
        throw new Error('endpoints.json is malformed')
      },
    })
    await model.refresh()
    expect(model.getSnapshot().where).toBe(`${SENT} is sent to Groq.`)
    expect(report.mock.calls).toEqual([['inference.endpoints-failed', { message: 'endpoints.json is malformed' }]])
  })

  /* THE STABLE REFERENCE `useSyncExternalStore` requires. */
  it('returns one snapshot object until something changes', async () => {
    const { model, settings } = world()
    await model.refresh()
    const before = model.getSnapshot()
    expect(model.getSnapshot()).toBe(before)
    settings.set(GLOSS_ROUTE_SETTING, 'agent:claude')
    expect(model.getSnapshot()).not.toBe(before)
  })

  /* THE HOST ARRIVES WITH THE LIST, whichever of the two reads lands last. */
  it('hears the endpoint list when it lands after the probe', async () => {
    let land: (value: readonly Endpoint[]) => void = () => {}
    const { model } = world({ installed: false, endpoints: () => new Promise((resolve) => (land = resolve)) })
    const seen = watch(model)
    const refreshed = model.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(model.getSnapshot().where, 'the probe had not landed, so this measures nothing').toBe(`${SENT} is sent to Groq.`)
    land([endpoint({ id: 'groq', label: 'Groq' })])
    await refreshed
    expect(seen.at(-1)?.where).toBe(`${SENT} is sent to api.groq.com.`)
  })

  it('names a subscriber that throws, and still tells the others', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { model, settings } = world()
      const broke = new Error('a subscriber broke')
      model.subscribe(() => {
        throw broke
      })
      let told = 0
      model.subscribe(() => void (told += 1))
      settings.set(GLOSS_ROUTE_SETTING, 'agent:claude')
      expect(told).toBe(1)
      expect(said.mock.calls).toEqual([['Paper: a Look up routes subscriber threw while being notified', broke]])
    } finally {
      said.mockRestore()
    }
  })

  /* A LIST STILL BEING READ WHEN THE CAPABILITY STOPS lands on nobody. */
  it('tells nobody about an endpoint list that lands after it was disposed', async () => {
    let land: (value: readonly Endpoint[]) => void = () => {}
    const { model } = world({ endpoints: () => new Promise((resolve) => (land = resolve)) })
    let told = 0
    const refreshed = model.refresh()
    model.subscribe(() => void (told += 1))
    model.dispose()
    land([endpoint({ id: 'groq' })])
    await refreshed
    expect(told, 'a disposed list told its old subscribers about a late read').toBe(0)
  })

  it('stops listening to all three of its sources when disposed', async () => {
    const { model, settings, local, routes } = world()
    let told = 0
    model.subscribe(() => void (told += 1))
    model.dispose()
    settings.set(GLOSS_ROUTE_SETTING, 'agent:claude')
    local.install()
    await routes.refresh()
    expect(told).toBe(0)
    expect(local.listeners.size, 'the controller subscription outlived the model').toBe(0)
  })
})
