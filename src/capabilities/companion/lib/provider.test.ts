import { describe, expect, it, vi } from 'vitest'
import type { AskContext } from '../../../kernel'
import type { InferencePort } from '../../inference'
import { createCompanionProvider, effectiveRoute, isAgentRoute, localModelOf } from './provider'

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
): { port: InferencePort; seen: string[]; signals: AbortSignal[] } {
  const seen: string[] = []
  /* EVERY SIGNAL THE PORT WAS HANDED. The agent branch used to be given none,
     and no test noticed because they all passed a signal nobody ever aborted —
     a cancellation contract asserted by never exercising it. */
  const signals: AbortSignal[] = []
  const port = {
    generate: async (
      model: string,
      _system: string,
      prompt: string,
      onChunk: (t: string) => void,
      signal: AbortSignal,
    ) => {
      seen.push(`generate:${model}`, prompt)
      signals.push(signal)
      return run(onChunk)
    },
    agentAsk: async (
      route: string,
      prompt: string,
      depth: string,
      onChunk: (t: string) => void,
      signal: AbortSignal,
    ) => {
      seen.push(`agent:${route}`, prompt, `depth:${depth}`)
      signals.push(signal)
      return run(onChunk)
    },
    probe: async () => ({ routes: [], runtimeVersion: null }),
    ensureReady: async () => true,
    signIn: async () => {},
    subscribe: () => () => {},
  } satisfies InferencePort
  return { port, seen, signals }
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

/**
 * CANCELLATION REACHES BOTH ROUTES.
 *
 * `ask`'s contract says the reader can abandon a long answer, and the port is
 * what turns that into a cancelled request. The agent branch was handed no
 * signal at all, so abandoning a Codex or Claude answer left the CLI running
 * and the reader's subscription being spent on text nobody would read — and
 * every test here passed, because each supplied a signal it never aborted.
 */
describe('cancellation', () => {
  it('hands the caller’s signal to the port, on every route', async () => {
    for (const route of ['agent:codex', 'local:qwen3-4b']) {
      const { port, signals } = portWith(async () => '')
      const provider = createCompanionProvider({ port, route: () => route, depth: () => 'default' })
      const controller = new AbortController()
      await drain(provider.ask('why?', CONTEXT, controller.signal))
      expect(signals, route).toHaveLength(1)
      expect(signals[0], `${route} was given a different signal`).toBe(controller.signal)
    }
  })

  /* THE SAME SIGNAL, so aborting it is observable by the port — which is what
     `withCancel` listens to in order to cancel the in-flight request. */
  it('gives the port a signal that actually fires', async () => {
    const { port, signals } = portWith(async () => '')
    const provider = createCompanionProvider({ port, route: () => 'agent:claude', depth: () => 'default' })
    const controller = new AbortController()
    await drain(provider.ask('why?', CONTEXT, controller.signal))
    let fired = false
    signals[0]?.addEventListener('abort', () => void (fired = true))
    controller.abort()
    expect(fired, 'aborting the caller’s controller did not reach the port’s signal').toBe(true)
  })
})

/**
 * THE TWO SURFACES AGREE ON WHICH ROUTE ANSWERS.
 *
 * The settings pane resolves `''` to the best usable route and shows it as
 * `In use`. The provider used to read the stored value raw and answer `null`
 * for the same state, so the panel said the companion was unavailable while
 * the pane said Codex was answering. Whichever half a reader met first, one of
 * them was lying.
 */
describe('the effective route', () => {
  it('takes the fall-back when nothing is stored, rather than refusing', () => {
    expect(effectiveRoute('', 'agent:codex')).toBe('agent:codex')
  })

  it('prefers what the reader actually chose', () => {
    expect(effectiveRoute('agent:claude', 'agent:codex')).toBe('agent:claude')
  })

  /* Nothing stored and nothing usable is the one case that is genuinely
     unconfigured — and the pane shows no `In use` row for it either. */
  it('is null only when there is nothing to fall back to', () => {
    expect(effectiveRoute('', null)).toBeNull()
  })
})

/**
 * TWO ASKS IN FLIGHT RESOLVE AGAINST THEIR OWN PASSAGES.
 *
 * The numbering used to live on the provider, so the second question
 * overwrote it before the first had finished — and the first answer's `[1]`
 * then resolved to the second question's paragraph. Every citation still
 * pointed somewhere plausible, which is the worst shape this defect could
 * take: nothing looks wrong.
 *
 * The old single-request test could not see it, and that is why it survived.
 */
describe('overlapping asks', () => {
  const passageIn = (text: string, cfi: string) => ({
    text: `${text} — padded past the minimum passage length so it is not dropped by numberPassages.`,
    cfi,
    label: '¶1 · line 1',
  })

  it('resolves each answer against the table it was numbered with', async () => {
    /* Both turns are opened, then finished in reverse order: the second
       question is numbered while the first is still streaming. */
    const finish: ((text: string) => void)[] = []
    const port = {
      generate: async (_m: string, _s: string, _p: string, onChunk: (t: string) => void) =>
        new Promise<string>((resolve) => {
          finish.push((text) => {
            onChunk(text)
            resolve('')
          })
        }),
      agentAsk: async () => '',
      probe: async () => ({ routes: [], runtimeVersion: null }),
      ensureReady: async () => true,
      signIn: async () => {},
      subscribe: () => () => {},
    } satisfies InferencePort

    const provider = createCompanionProvider({ port, route: () => 'local:m', depth: () => 'default' })
    const first = drain(
      provider.ask('one', { ...CONTEXT, passages: [passageIn('First', 'cfi/FIRST')] }, new AbortController().signal),
    )
    const second = drain(
      provider.ask('two', { ...CONTEXT, passages: [passageIn('Second', 'cfi/SECOND')] }, new AbortController().signal),
    )
    await vi.waitFor(() => expect(finish).toHaveLength(2))

    finish[0]?.('see [1].')
    finish[1]?.('see [1].')
    const [a, b] = await Promise.all([first, second])

    expect(a.done, 'the first answer cited the second question’s passage').toEqual([
      expect.objectContaining({ cfi: 'cfi/FIRST' }),
    ])
    expect(b.done).toEqual([expect.objectContaining({ cfi: 'cfi/SECOND' })])
  })
})
