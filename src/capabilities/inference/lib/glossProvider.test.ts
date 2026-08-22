import { describe, expect, it, vi } from 'vitest'
import type { GlossContext } from '../../../kernel'
import type { Controller } from './controller'
import { createGlossProvider, glossKey, glossQuestion, GLOSS_SYSTEM_PROMPT } from './glossProvider'
import type { InferencePlugin } from './plugin'

const context: GlossContext = {
  sentence: 'He kept his own counsel, and the crew grew close about him.',
  bookTitle: 'Moby-Dick',
}

function harness(over: Partial<InferencePlugin> = {}, model: string | null = 'qwen') {
  const plugin = {
    gloss: vi.fn(async () => 'Guarded; unwilling to share what he thought.'),
    cancel: vi.fn(async () => {}),
    ...over,
  } as unknown as InferencePlugin
  const controller = {
    textModel: () => model,
    ensureReady: async () => true,
  } as unknown as Controller
  /* Read the spies BACK OFF the assembled plugin, not from the defaults: an
   * override replaces the default, and returning the default would have the
   * test asserting against a function nothing calls — which is a test that
   * passes for the wrong reason. */
  return {
    plugin,
    controller,
    gloss: plugin.gloss as unknown as ReturnType<typeof vi.fn>,
    cancel: plugin.cancel as unknown as ReturnType<typeof vi.fn>,
    provider: createGlossProvider({ plugin, controller }),
  }
}

const signal = (): AbortSignal => new AbortController().signal

describe('the gloss prompt', () => {
  /* `DCSCopyTextDefinition` doubles the headword, and a model asked to define
   * a word leads with it by default — the exact failure this feature exists
   * to avoid. */
  it('tells the model not to repeat the headword', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/[Dd]o not repeat the word/)
  })

  it('asks for one sense, not every sense', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/only the sense used here/)
  })

  it('bounds the answer to what a popover can hold', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/one or two sentences/)
  })

  it('carries the sentence and the term, and nothing wider', () => {
    const question = glossQuestion('counsel', context)
    expect(question).toContain(context.sentence)
    expect(question).toContain('counsel')
    expect(question).toContain('Moby-Dick')
  })
})

describe('glossKey', () => {
  it('is the same for a selection differing only in whitespace or case', () => {
    const a = glossKey('Counsel', context)
    const b = glossKey(' counsel ', { ...context, sentence: context.sentence.replace(/ /g, '\n') })
    expect(a).toBe(b)
  })

  /* The whole point of the feature is the sense on THIS page — the same word
   * in two sentences is two different glosses and must not share an entry. */
  it('differs for the same word in a different sentence', () => {
    const other = { ...context, sentence: 'The counsel for the defence rose slowly.' }
    expect(glossKey('counsel', context)).not.toBe(glossKey('counsel', other))
  })
})

describe('the gloss provider', () => {
  it('is unavailable with no text model installed', () => {
    const { provider } = harness({}, null)
    expect(provider.available).toBe(false)
  })

  it('becomes available when a model appears, without a rebind', () => {
    let model: string | null = null
    const controller = { textModel: () => model, ensureReady: async () => true } as unknown as Controller
    const provider = createGlossProvider({ plugin: {} as InferencePlugin, controller })
    expect(provider.available).toBe(false)
    model = 'qwen'
    expect(provider.available).toBe(true)
  })

  it('throws rather than answering when nothing is installed', async () => {
    const { provider } = harness({}, null)
    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow(/Check `available`/)
  })

  it('answers from the model and trims it', async () => {
    const { provider, gloss } = harness({ gloss: vi.fn(async () => '  Guarded.  ') as never })
    await expect(provider.gloss('counsel', context, signal())).resolves.toBe('Guarded.')
    expect(gloss).toHaveBeenCalledTimes(1)
  })

  /* ── WI-15.13's ACCEPTANCE ─────────────────────────────────────────────
   * "a second lookup of the same word in the same sentence makes no request." */
  it('makes no second request for the same word in the same sentence', async () => {
    const { provider, gloss } = harness()
    await provider.gloss('counsel', context, signal())
    await provider.gloss('counsel', context, signal())
    expect(gloss).toHaveBeenCalledTimes(1)
    expect(provider.cacheSize()).toBe(1)
  })

  it('does make a request for the same word in a different sentence', async () => {
    const { provider, gloss } = harness()
    await provider.gloss('counsel', context, signal())
    await provider.gloss('counsel', { ...context, sentence: 'The counsel rose.' }, signal())
    expect(gloss).toHaveBeenCalledTimes(2)
  })

  /* "The cache is dropped when the model changes, because a gloss is an
   * answer from a particular model and not a fact." */
  it('drops the cache when the model changes', async () => {
    let model = 'qwen'
    const gloss = vi.fn(async () => 'Guarded.')
    const controller = { textModel: () => model, ensureReady: async () => true } as unknown as Controller
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller,
    })
    await provider.gloss('counsel', context, signal())
    expect(provider.cacheSize()).toBe(1)

    model = 'another-model'
    await provider.gloss('counsel', context, signal())
    expect(gloss).toHaveBeenCalledTimes(2)
    expect(provider.cacheSize()).toBe(1)
  })

  /* An empty amber mark beside a word reads as "this word means nothing". */
  it('refuses an empty answer rather than caching it', async () => {
    const { provider } = harness({ gloss: vi.fn(async () => '   ') as never })
    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow(/returned nothing/)
    expect(provider.cacheSize()).toBe(0)
  })

  it('does not cache a failure', async () => {
    const gloss = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce('Guarded.')
    const { provider } = harness({ gloss: gloss as never })
    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow('nope')
    await expect(provider.gloss('counsel', context, signal())).resolves.toBe('Guarded.')
    expect(gloss).toHaveBeenCalledTimes(2)
  })

  it('refuses before asking when the runtime will not start', async () => {
    const gloss = vi.fn()
    const controller = { textModel: () => 'qwen', ensureReady: async () => false } as unknown as Controller
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller,
    })
    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow(/not running/)
    expect(gloss).not.toHaveBeenCalled()
  })

  it('cancels the request when the caller aborts', async () => {
    const controllerAbort = new AbortController()
    const { provider, cancel } = harness({
      gloss: vi.fn(async () => {
        controllerAbort.abort()
        return 'Guarded.'
      }) as never,
    })
    await provider.gloss('counsel', context, controllerAbort.signal)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not start when the signal is already aborted', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const { provider, gloss } = harness()
    await expect(provider.gloss('counsel', context, aborted.signal)).rejects.toThrow()
    expect(gloss).not.toHaveBeenCalled()
  })

  it('clears its cache on request', async () => {
    const { provider } = harness()
    await provider.gloss('counsel', context, signal())
    expect(provider.cacheSize()).toBe(1)
    provider.clearCache()
    expect(provider.cacheSize()).toBe(0)
  })

  /* ── WI-15.13's LOAD-BEARING ACCEPTANCE ────────────────────────────────
   * "no selection can reach an agent, checked by a test that binds an agent
   * to `ask` and asserts `gloss` never sees it."
   *
   * The provider is built from the plugin's `gloss` command and the
   * controller. Neither can reach `agentAsk`: it is not among the functions
   * this provider is given, and there is no branch here that could select
   * one. This asserts that structurally — an agent bound into the plugin
   * surface is never called, however the gloss is used. */
  it('never reaches an agent, however it is called', async () => {
    const agentAsk = vi.fn(async () => 'an agent answered')
    const { provider } = harness({ agentAsk: agentAsk as never })
    await provider.gloss('counsel', context, signal())
    await provider.gloss('another', { ...context, sentence: 'A different sentence entirely.' }, signal())
    expect(agentAsk).not.toHaveBeenCalled()
  })
})
