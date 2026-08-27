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

  /*
   * ── WHAT THE READER IS TOLD WHEN IT FAILS ─────────────────────────────
   *
   * A rejection from the plugin is `{ kind, message }` — a plain object, not
   * an `Error`. `useGloss` builds the strip's second line with `error
   * instanceof Error ? error.message : 'No reason was given.'`, so before this
   * translation EVERY plugin-side failure reached the reader as **No reason
   * was given.**: the runtime not installed, not started, stopped,
   * unreachable, a model that would not resolve.
   *
   * It was survivable while Dictionary.app sat behind a failed gloss. The
   * hand-off is deleted, so this line is the whole of what the reader learns.
   */
  it('turns a plugin rejection into a sentence the reader can act on', async () => {
    const gloss = vi.fn().mockRejectedValue({ kind: 'runtimeMissing', message: 'lemonade-server absent' })
    const { provider } = harness({ gloss: gloss as never })

    const failure = await provider.gloss('counsel', context, signal()).catch((e: unknown) => e)

    /* AN `Error`, because that is the only shape `useGloss` reads a message
       off — a `{kind, message}` object reaches the reader as nothing at all. */
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('The runtime is not installed')
  })

  /* Non-vacuity: two different kinds must not collapse to one sentence, or the
     assertion above would pass against a hard-coded string. */
  it('says something different for a different kind', async () => {
    const gloss = vi.fn().mockRejectedValue({ kind: 'runtimeExited', message: 'exit status: 1' })
    const { provider } = harness({ gloss: gloss as never })

    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow('The runtime stopped')
  })

  /*
   * ⚠️ AND IT DOES NOT TRANSLATE WHAT IT DID NOT RECOGNISE. A rejection with
   * no `kind` did not come from the crate, so `detailFor` would map it to its
   * default — **Something went wrong** — destroying the real message on the
   * way. `errorKind` states the rule: a rejection with no `kind` is a Tauri or
   * webview failure, and treating it as one of the plugin's own puts the wrong
   * sentence in front of the reader.
   *
   * This is the case that made the prefix bug cost an afternoon: every command
   * was invoked without `plugin:inference|`, every call rejected with the bare
   * string `Command inference_gloss not found`, and the one sentence that would
   * have ended the search was the one a default swallows.
   */
  it('passes a rejection that is not the plugin’s through untouched', async () => {
    const gloss = vi.fn().mockRejectedValue(new Error('Command inference_gloss not found'))
    const { provider } = harness({ gloss: gloss as never })

    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow(
      'Command inference_gloss not found',
    )
  })

  /* The reader's own abort is not a fault and must not be dressed as one —
     `useGloss` drops it, and a translated `cancelled` would race that drop and
     flash a sentence at somebody who had already moved on. */
  it('leaves the reader’s own cancellation as a cancellation', async () => {
    /* ABORTED DURING THE CALL, not before it. A signal that is already aborted
       never reaches the plugin at all — `gloss` races the readiness wait
       against it and throws `AbortError` first — so seeding one would have
       tested the early guard while claiming to test this branch. */
    const reader = new AbortController()
    const gloss = vi.fn(async () => {
      reader.abort()
      return Promise.reject({ kind: 'cancelled', message: 'cancelled' })
    })
    const { provider } = harness({ gloss: gloss as never })

    const failure = await provider.gloss('counsel', context, reader.signal).catch((e: unknown) => e)

    expect(failure).toEqual({ kind: 'cancelled', message: 'cancelled' })
  })

  /*
   * ⚠️ AND `cancelled` DOES NOT ALWAYS MEAN THE READER. Rust cancels in-flight
   * requests when the daemon stops, and that arrives with a signal nobody
   * aborted. Passing it through there showed the reader nothing at all while
   * the lookup silently ended — `useGloss` drops a cancellation, so the strip
   * stayed on "Looking…" with no answer coming. Found by audit.
   */
  it('translates a cancellation the reader did not ask for', async () => {
    const gloss = vi.fn().mockRejectedValue({ kind: 'cancelled', message: 'cancelled' })
    const { provider } = harness({ gloss: gloss as never })

    const failure = await provider.gloss('counsel', context, signal()).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('The runtime stopped before it answered')
  })

  /*
   * ⚠️ **THE CASE THE TRANSLATION WAS WRITTEN FOR, AND THE ONE ITS FIRST TEST
   * MISSED.**
   *
   * Tauri rejects an unknown command with a plain STRING — `Command
   * inference_gloss not found` — not an `Error`. The first version of this
   * suite asserted that shape with `new Error(...)`, which passed while the
   * real boundary still produced a string, and a string is not an `Error`, so
   * `useGloss` rendered **No reason was given.** exactly as before the fix.
   *
   * A test that constructs the one shape the boundary never emits is a test
   * that agrees with itself. This one uses the shape Tauri actually rejects
   * with.
   */
  it('makes a bare string rejection readable rather than passing it through', async () => {
    const gloss = vi.fn().mockRejectedValue('Command inference_gloss not found')
    const { provider } = harness({ gloss: gloss as never })

    const failure = await provider.gloss('counsel', context, signal()).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Command inference_gloss not found')
  })

  /* NOT translated, though — it has no `kind`, so `detailFor` would map it to
     "Something went wrong" and destroy the only account of what happened. */
  it('does not translate a rejection it did not recognise', async () => {
    const gloss = vi.fn().mockRejectedValue('Command inference_gloss not found')
    const { provider } = harness({ gloss: gloss as never })

    await expect(provider.gloss('counsel', context, signal())).rejects.not.toThrow(
      'Something went wrong',
    )
  })

  /* The kinds an audit found reaching the default. Each one is a different
     thing to do about it, and "Something went wrong" is none of them.
     ⚠️ WORDED FOR EVERY CALLER. `detailFor` is shared with the install and
     removal paths, and the first version of these two expectations pinned
     gloss-specific wording ("That LOOKUP is already running", "That PASSAGE is
     too long to look up") that misreported an install collision. The verify
     pass caught the wording; these expectations then caught me changing it
     without re-running them. */
  it.each([
    ['modelUnknown', 'That model is not available'],
    ['requestBusy', 'That request is already running'],
    ['fieldTooLarge', 'That request was too large'],
    ['runtimeHttp', 'The runtime refused the request'],
  ])('says something specific for %s', async (kind, expected) => {
    const gloss = vi.fn().mockRejectedValue({ kind, message: 'x' })
    const { provider } = harness({ gloss: gloss as never })

    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow(expected)
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
