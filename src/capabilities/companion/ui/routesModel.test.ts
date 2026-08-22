import { describe, expect, it } from 'vitest'
import type { Route } from '../../inference'
import { resolveRoute, rowFor, voiceRows } from './routesModel'

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
