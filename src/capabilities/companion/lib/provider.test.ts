import { describe, expect, it } from 'vitest'
import type { AskContext } from '../../../kernel'
import type { InferencePort } from '../../inference'
import { createCompanionProvider, isAgentRoute, localModelOf } from './provider'

/**
 * The provider that answers on all three routes.
 *
 * WHAT IS WORTH PINNING HERE is the part that is identical on every route and
 * therefore has exactly one place to be wrong: the queue between the plugin's
 * callback and the generator, and the refusal to answer with no route. A
 * delta arriving between two `next()` calls has nowhere to go without that
 * queue, and the failure is a silently truncated answer — the reader sees a
 * sentence stop, and nothing anywhere reports it.
 */

const CONTEXT: AskContext = {
  bookTitle: 'Moby-Dick',
  chapterLabel: 'Loomings',
  selection: null,
  /* Past `MIN_PASSAGE_CHARS`, deliberately: a shorter one is dropped by
     `numberPassages`, and a fixture that fell under the floor would make this
     suite pass over a provider that grounded nothing. */
  passages: [
    {
      text: 'Call me Ishmael. Some years ago — never mind how long precisely — I thought I would sail about a little.',
      cfi: 'epubcfi(/6/4!/4/2)',
      label: '¶1 · line 1',
    },
  ],
}

function portWith(
  run: (onChunk: (text: string) => void) => Promise<string>,
): { port: InferencePort; seen: string[] } {
  const seen: string[] = []
  const port = {
    generate: async (model: string, _system: string, prompt: string, onChunk: (t: string) => void) => {
      seen.push(`generate:${model}`, prompt)
      return run(onChunk)
    },
    agentAsk: async (route: string, prompt: string, depth: string, onChunk: (t: string) => void) => {
      seen.push(`agent:${route}`, prompt, `depth:${depth}`)
      return run(onChunk)
    },
    probe: async () => ({ routes: [], runtimeVersion: null }),
    ensureReady: async () => true,
    signIn: async () => {},
    subscribe: () => () => {},
  } satisfies InferencePort
  return { port, seen }
}

const drain = async (stream: AsyncGenerator<string, unknown>): Promise<{ text: string; done: unknown }> => {
  let text = ''
  for (;;) {
    const step = await stream.next()
    if (step.done === true) return { text, done: step.value }
    text += step.value
  }
}

describe('route ids', () => {
  it('tells an agent route from a local one', () => {
    expect(isAgentRoute('agent:codex')).toBe(true)
    expect(isAgentRoute('local:qwen3-4b')).toBe(false)
  })

  it('reads the model id out of a local route, and only a local one', () => {
    expect(localModelOf('local:qwen3-4b')).toBe('qwen3-4b')
    expect(localModelOf('agent:codex')).toBeNull()
    expect(localModelOf('endpoint:x')).toBeNull()
  })
})

describe('the bound provider', () => {
  it('reports the chosen route as its name, and unconfigured with none', () => {
    let chosen: string | null = null
    const { port } = portWith(async () => '')
    const provider = createCompanionProvider({ port, route: () => chosen, depth: () => 'default' })
    expect(provider.configured).toBe(false)
    expect(provider.name).toBe('No model configured')
    chosen = 'local:qwen3-4b'
    /* READ PER CALL, so choosing a route needs no rebind and no restart. */
    expect(provider.configured).toBe(true)
    expect(provider.name).toBe('local:qwen3-4b')
  })

  it('refuses to ask with no route, on iteration rather than on call', async () => {
    const { port } = portWith(async () => '')
    const provider = createCompanionProvider({ port, route: () => null, depth: () => 'default' })
    const stream = provider.ask('why?', CONTEXT, new AbortController().signal)
    await expect(stream.next()).rejects.toThrow(/no provider/i)
  })

  /* THE QUEUE. Both deltas are pushed before the consumer asks for either, so
     a provider that yielded straight from the callback would lose the first. */
  it('keeps deltas that arrive before the consumer asks for them', async () => {
    const { port } = portWith(async (onChunk) => {
      onChunk('Because ')
      onChunk('the whale.')
      return ''
    })
    const provider = createCompanionProvider({ port, route: () => 'local:qwen3-4b', depth: () => 'default' })
    const { text } = await drain(provider.ask('why?', CONTEXT, new AbortController().signal))
    expect(text).toBe('Because the whale.')
  })

  it('sends the model id, not the route id, on a local route', async () => {
    const { port, seen } = portWith(async () => '')
    const provider = createCompanionProvider({ port, route: () => 'local:qwen3-4b', depth: () => 'default' })
    await drain(provider.ask('why?', CONTEXT, new AbortController().signal))
    expect(seen[0]).toBe('generate:qwen3-4b')
  })

  it('sends the whole route id to an agent, and never touches generate', async () => {
    const { port, seen } = portWith(async () => '')
    const provider = createCompanionProvider({ port, route: () => 'agent:codex', depth: () => 'thorough' })
    await drain(provider.ask('why?', CONTEXT, new AbortController().signal))
    expect(seen[0]).toBe('agent:agent:codex')
    expect(seen.some((one) => one.startsWith('generate:'))).toBe(false)
  })

  it('raises what the port raised, rather than ending the answer quietly', async () => {
    const { port } = portWith(async () => {
      throw new Error('the daemon went away')
    })
    const provider = createCompanionProvider({ port, route: () => 'local:qwen3-4b', depth: () => 'default' })
    await expect(drain(provider.ask('why?', CONTEXT, new AbortController().signal))).rejects.toThrow(
      /went away/,
    )
  })

  /* The citation map needs the numbering the answer was built against, not
     the passages a later render would produce. */
  it('remembers the passages the last answer was grounded in', async () => {
    const { port } = portWith(async (onChunk) => {
      onChunk('It is in [1].')
      return ''
    })
    const provider = createCompanionProvider({ port, route: () => 'local:qwen3-4b', depth: () => 'default' })
    expect(provider.lastPassages()).toEqual([])
    const { done } = await drain(provider.ask('where?', CONTEXT, new AbortController().signal))
    expect(provider.lastPassages()).toHaveLength(1)
    expect(done).toEqual([expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2)' })])
  })
})
