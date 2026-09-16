import { describe, expect, it, vi } from 'vitest'
import type { GlossContext } from '../../../kernel'
import { createController, type Controller } from './controller'
import { createGlossProvider, glossQuestion, GLOSS_SYSTEM_PROMPT } from './glossProvider'
import type { InferencePlugin } from './plugin'
import { refusalOf } from '../../../kernel/testkit'

const ENGLISH = { tag: 'en', name: 'English', label: 'English' } as const
const CHINESE = { tag: 'zh-Hans', name: 'Simplified Chinese', label: '简体中文' } as const
const MODELS = 'inference:models'

const context: GlossContext = {
  sentence: 'He kept his own counsel, and the crew grew close about him.',
  bookTitle: 'Moby-Dick',
  answerIn: [ENGLISH],
}

function harness(over: Partial<InferencePlugin> = {}, model: string | null = 'qwen') {
  const plugin = {
    gloss: vi.fn(async () => 'Guarded; unwilling to share what he thought.'),
    cancel: vi.fn(async () => {}),
    ...over,
  } as unknown as InferencePlugin
  const controller = {
    textModel: () => model,
    start: async () => {},
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
    provider: createGlossProvider({ plugin, controller, installAt: MODELS }),
  }
}

const signal = (): AbortSignal => new AbortController().signal

/** A promise the test opens when it wants the launch under test to finish. */
function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

/** Past every microtask already queued — a lookup that can settle has. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the gloss prompt', () => {
  /* `DCSCopyTextDefinition` doubles the headword, and a model asked to define
   * a word leads with it by default — the exact failure this feature exists
   * to avoid. A bare prohibition was MEASURED not stopping it; showing the
   * shape of a good opening did (WI-17.5's evidence, the opening-line run). */
  it('shows the model how to open — with the meaning, never the word', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/Start straight with the meaning, the way a dictionary entry does/)
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/never "Wharves are" and never "In this sentence"/)
  })

  it('tells the model not to restate the sentence', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/Do not restate the sentence/)
  })

  /* WI-17.5: the language is named in the question, and two languages come
     back as two lines in the order asked — measured inside the token bound. */
  it('tells the model to answer in the language named, and how to answer in two', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/Write the answer in the language the request names/)
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/one sentence in each, the first language first, each on its own line/)
  })

  it('asks for one sense, not every sense', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/only the sense used here/)
  })

  it('bounds the answer to what a popover can hold', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/one or two sentences/)
  })

  /* THE FRAME, AND THE WAY OUT. The first line is what is being asked of the
     model at all; the other is what it does when the page does not settle the
     sense, which is to say so rather than pick one. */
  it('says what a gloss is, and what to do when the sentence does not settle it', () => {
    expect(GLOSS_SYSTEM_PROMPT).toMatch(/^You define a word or phrase as it is used in one specific sentence from a book\. /)
    expect(GLOSS_SYSTEM_PROMPT).toContain('If the sentence does not make the sense clear, say so plainly in one sentence.')
  })

  it('reads as one paragraph, a space between its sentences', () => {
    expect(GLOSS_SYSTEM_PROMPT).toContain('from a book. Answer in one or two sentences')
    expect(GLOSS_SYSTEM_PROMPT).not.toMatch(/\n/)
  })

  it('carries the sentence and the term, and nothing wider', () => {
    const question = glossQuestion('counsel', context)
    expect(question).toContain(context.sentence)
    expect(question).toContain('counsel')
    expect(question).toContain('Moby-Dick')
  })

  it('names the language to answer in, as one line in the order asked', () => {
    expect(glossQuestion('counsel', context).split('\n')).toContain('Answer in: English')
    expect(glossQuestion('counsel', { ...context, answerIn: [CHINESE, ENGLISH] }).split('\n')).toContain(
      'Answer in: Simplified Chinese, then English',
    )
  })
})

/**
 * ⚠️ **THE QUESTION IS THE CACHE KEY**, so these are one set of cases and not
 * two. There used to be a separate `glossKey`, and it disagreed with the
 * request in two ways — it lowercased, and it normalised whitespace the
 * question did not — so two different questions shared one answer.
 */
describe('the question, which is also the key', () => {
  it('is the same for a selection differing only in whitespace', () => {
    const a = glossQuestion('counsel', context)
    const b = glossQuestion(' counsel ', { ...context, sentence: context.sentence.replace(/ /g, '\n') })
    expect(a).toBe(b)
  })

  /* A RUN OF WHITESPACE IS ONE SPACE, not one space per character — a
     selection that crossed a paragraph break carries two newlines and an
     indent, and the model is sent the words, not the layout. Asserted whole,
     so every line of the question is what it says. */
  it('collapses a run of whitespace to one space, line by line', () => {
    expect(
      glossQuestion('  own \n\t counsel ', { ...context, sentence: 'He kept  his own\n\n   counsel.', bookTitle: ' Moby-Dick ' }),
    ).toBe(
      ['Book: Moby-Dick', 'Sentence: He kept his own counsel.', 'Answer in: English', 'Define, in this sentence: own counsel'].join(
        '\n',
      ),
    )
  })

  /* ⚠️ **AND IT IS NOT THE SAME FOR A DIFFERENT CASE**, which the old key got
     backwards. `March` and `march` in one sentence are two different questions
     with two different answers; folding them meant selecting the verb after the
     month served the month's definition. Every proper noun that is also a
     common word — `Polish`, `Bank`, `May` — has the same shape. */
  it('differs for a term the reader capitalised differently', () => {
    const sentence = 'In March they march to the sea.'
    expect(glossQuestion('March', { ...context, sentence })).not.toBe(
      glossQuestion('march', { ...context, sentence }),
    )
  })

  /* The whole point of the feature is the sense on THIS page — the same word
   * in two sentences is two different glosses and must not share an entry. */
  it('differs for the same word in a different sentence', () => {
    const other = { ...context, sentence: 'The counsel for the defence rose slowly.' }
    expect(glossQuestion('counsel', context)).not.toBe(glossQuestion('counsel', other))
  })

  /* NOTHING THE MODEL IS NOT SENT. Two books with the same title, the same
     sentence and the same term are ONE question, and serving one answer for it
     is the cache working — an audit called it a collision and it is not. A book
     id would split entries that ought to be shared, and the model never sees
     one. */
  it('is the same for two books that ask it the same thing', () => {
    const one = { sentence: 'The counsel rose.', bookTitle: 'Poems', answerIn: [ENGLISH] as const }
    expect(glossQuestion('counsel', one)).toBe(glossQuestion('counsel', { ...one }))
  })

  /* INJECTIVE, which is what lets a three-line string be a key at all: the
     squeeze leaves no newline in any field, so a title cannot impersonate the
     `Sentence:` line that follows it. */
  it('cannot be forged by a title that looks like the next line', () => {
    expect(glossQuestion('counsel', { ...context, sentence: 'B', bookTitle: 'A\nSentence: B' })).not.toBe(
      glossQuestion('counsel', { ...context, sentence: 'B', bookTitle: 'A' }),
    )
  })

  /* WI-17.5's cache requirement, at the key: switching from English to 中文
     must not serve every word already looked up back in English. */
  it('differs for a different answer language, and for the same two in the other order', () => {
    expect(glossQuestion('counsel', context)).not.toBe(glossQuestion('counsel', { ...context, answerIn: [CHINESE] }))
    expect(glossQuestion('counsel', { ...context, answerIn: [CHINESE, ENGLISH] })).not.toBe(
      glossQuestion('counsel', { ...context, answerIn: [ENGLISH, CHINESE] }),
    )
  })
})

describe('the gloss provider', () => {
  it('is unavailable with no text model installed', () => {
    const { provider } = harness({}, null)
    expect(provider.available).toBe(false)
  })

  it('becomes available when a model appears, without a rebind', () => {
    let model: string | null = null
    const controller = {
      textModel: () => model,
      start: async () => {},
      getSnapshot: () => ({ runtime: { kind: 'installed' }, models: [], installing: null, removing: null, failure: null }),
    } as unknown as Controller
    const provider = createGlossProvider({ plugin: {} as InferencePlugin, controller, installAt: MODELS })
    expect(provider.available).toBe(false)
    model = 'qwen'
    expect(provider.available).toBe(true)
  })

  /*
   * ⚠️ **A MODEL ON DISK IS NOT A LOOKUP THAT CAN RUN.** `available` read the
   * model alone, so with a model downloaded and the runtime absent — WI-20.21's
   * own 2.5 GB, or a model left behind by a runtime since removed — it said yes
   * while `installAt` beside it said there was nowhere to go. Look up drew a
   * live button and every press failed at the launch. Measured with the REAL
   * controller, because the two answers disagreed about one snapshot.
   */
  it('is unavailable with a model on disk and no runtime to run it', async () => {
    const onDisk = createController({
      status: async () => ({ state: 'absent', reason: 'the runtime is not staged' }),
      models: async () => [{ id: 'qwen', label: 'Qwen', modality: 'text', license: 'Apache-2.0', bytes: 1, installed: true }],
      start: async () => 1,
      installModel: async () => {},
      removeModel: async () => {},
      cancel: async () => {},
    })
    await onDisk.refresh()
    const provider = createGlossProvider({ plugin: {} as InferencePlugin, controller: onDisk, installAt: MODELS })

    expect(onDisk.textModel(), 'no model reads as installed, so this measures nothing').toBe('qwen')
    expect(provider.installAt, 'the runtime did not read as absent, so this measures nothing').toBeNull()
    expect(provider.available, 'Look up offered a definition no runtime can produce').toBe(false)
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

  /* ── WI-17.5's VERIFICATION ─────────────────────────────────────────────
   * "changing the answer language does not serve a cached answer in the
   * previous one" — the failure that would otherwise persist silently for as
   * long as the process lives. Watched at the plugin, which is where a served
   * answer and a fresh one differ. */
  it('does not serve an answer cached in another language', async () => {
    const gloss = vi.fn(async (_id: string, _model: string, _system: string, question: string) =>
      question.includes('Answer in: Simplified Chinese') ? '守口如瓶。' : 'Guarded.',
    )
    const { provider } = harness({ gloss: gloss as never })

    await expect(provider.gloss('counsel', context, signal())).resolves.toBe('Guarded.')
    await expect(provider.gloss('counsel', { ...context, answerIn: [CHINESE] }, signal())).resolves.toBe('守口如瓶。')
    await expect(provider.gloss('counsel', context, signal())).resolves.toBe('Guarded.')

    expect(gloss).toHaveBeenCalledTimes(2)
    expect(provider.cacheSize()).toBe(2)
  })

  /* "The cache is dropped when the model changes, because a gloss is an
   * answer from a particular model and not a fact." */
  it('drops the cache when the model changes', async () => {
    let model = 'qwen'
    const gloss = vi.fn(async () => 'Guarded.')
    const controller = { textModel: () => model, start: async () => {} } as unknown as Controller
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller,
      installAt: MODELS,
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
   * an `Error`. `useGloss` builds the reason a failed lookup shows with `error
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
    const controller = {
      textModel: () => 'qwen',
      start: async () => {
        throw { kind: 'notReady', message: 'the runtime did not become ready within 30s' }
      },
    } as unknown as Controller
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller,
      installAt: MODELS,
    })
    expect((await refusalOf(provider.gloss('counsel', context, signal()))).message).toBe('The runtime did not start')
    expect(gloss).not.toHaveBeenCalled()
  })

  /**
   * ⚠️ **THE READER WAS TOLD THE WRONG REASON BY A LINE THAT KNEW THE RIGHT
   * ONE.**
   *
   * The readiness wait took a BOOLEAN, so every way a launch can fail arrived
   * here as `false` and became the one sentence written beside it — "The
   * runtime is not running" — while the controller one call away had computed
   * "The runtime is not installed" from the plugin's own `kind` and kept it to
   * itself. Measured with the REAL controller, because a fake readiness answer
   * is the very thing that hid this.
   */
  it('tells the reader what stopped the runtime, not that it is not running', async () => {
    const gloss = vi.fn()
    const real = createController({
      status: async () => ({ state: 'absent', reason: 'the runtime is not staged' }),
      models: async () => [
        { id: 'qwen', label: 'Qwen', modality: 'text', license: 'Apache-2.0', bytes: 1, installed: true },
      ],
      start: async () => {
        throw { kind: 'runtimeMissing', message: 'the inference runtime is not installed at /x' }
      },
      installModel: async () => {},
      removeModel: async () => {},
      cancel: async () => {},
    })
    await real.refresh()
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller: real,
      installAt: MODELS,
    })

    expect(real.textModel(), 'no model reads as installed, so this measures nothing').toBe('qwen')
    expect((await refusalOf(provider.gloss('counsel', context, signal()))).message).toBe(
      'The runtime is not installed',
    )
    expect(gloss).not.toHaveBeenCalled()
    real.dispose()
  })

  it('cancels the request when the caller aborts', async () => {
    const controllerAbort = new AbortController()
    const { provider, cancel } = harness({
      gloss: vi.fn(async () => {
        controllerAbort.abort()
        return 'Guarded.'
      }) as never,
    })
    /* ⚠️ **IT REJECTS, AND IT USED TO RESOLVE.** This awaited the call bare and
       asserted only that the cancel went out — so the provider handing back an
       answer for a lookup the reader had abandoned passed unremarked, and only
       `useGloss` dropping it kept that invisible. The port's contract is that a
       cancelled lookup rejects; the check on the way IN already held it and the
       tail did not. */
    expect((await refusalOf(provider.gloss('counsel', context, controllerAbort.signal))).message, 'the abort’s own words — a cancelled lookup rejects, it does not resolve').toBe('This operation was aborted')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  /* AND THE ANSWER IS STILL REMEMBERED. It is a correct answer to that exact
     question and was already paid for, so the reader's next lookup of the same
     word is free — what must not happen is the call RESOLVING. */
  it('still caches an answer whose caller went away', async () => {
    const controllerAbort = new AbortController()
    const { provider } = harness({
      gloss: vi.fn(async () => {
        controllerAbort.abort()
        return 'Guarded.'
      }) as never,
    })
    expect((await refusalOf(provider.gloss('counsel', context, controllerAbort.signal))).message, 'the abort’s own words — a cancelled lookup rejects, it does not resolve').toBe('This operation was aborted')
    expect(provider.cacheSize()).toBe(1)
  })

  it('does not start when the signal is already aborted', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const { provider, gloss } = harness()
    expect((await refusalOf(provider.gloss('counsel', context, aborted.signal))).message, 'the abort’s own words — a cancelled lookup rejects, it does not resolve').toBe('This operation was aborted')
    expect(gloss).not.toHaveBeenCalled()
  })

  /*
   * ⚠️ **A LATE ANSWER MUST NOT LAND IN ANOTHER MODEL'S CACHE.**
   *
   * `cachedFor` is checked on the way IN, before an await. Two lookups can be
   * in flight across a model change: A starts under qwen, B starts under llama
   * and clears the cache on its way in, then A lands and wrote its answer into
   * a cache now labelled llama. The next lookup of A's word served qwen's
   * answer under llama's label — precisely what `cachedFor` exists to prevent,
   * one await too early. Found by audit.
   */
  it('does not remember an answer for a model the cache no longer belongs to', async () => {
    let model = 'qwen'
    let releaseQwen = (): void => {}
    const gloss = vi.fn(async (_id: string, asked: string) => {
      if (asked !== 'qwen') return 'llama says'
      await new Promise<void>((resolve) => {
        releaseQwen = resolve
      })
      return 'qwen says'
    })
    const controller = {
      textModel: () => model,
      start: async () => {},
    } as unknown as Controller
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller,
      installAt: MODELS,
    })

    const inFlight = provider.gloss('counsel', context, signal())
    model = 'llama'
    await provider.gloss('other', { ...context, sentence: 'A different sentence.' }, signal())
    releaseQwen()

    /* The caller who asked still gets their answer — it is only not REMEMBERED
       for a model that did not produce it. */
    await expect(inFlight).resolves.toBe('qwen says')
    expect(provider.cacheSize(), 'qwen’s answer was cached under llama').toBe(1)
  })

  /*
   * ⚠️ **A FAILED CANCEL IS REPORTED**, and every one used to be swallowed by
   * a bare `.catch(() => {})`. Anything but the expected race means the daemon
   * is still generating for a reader who has gone.
   */
  it('reports a cancel that failed for anything but the expected race', async () => {
    const report = vi.fn()
    const reader = new AbortController()
    const gloss = vi.fn(async () => {
      reader.abort()
      await new Promise((resolve) => setTimeout(resolve, 0))
      return 'never read'
    })
    const cancel = vi.fn().mockRejectedValue({ kind: 'runtimeExited', message: 'gone' })
    const provider = createGlossProvider({
      plugin: { gloss, cancel } as unknown as InferencePlugin,
      controller: { textModel: () => 'qwen', start: async () => {} } as unknown as Controller,
      report,
      installAt: MODELS,
    })

    await provider.gloss('counsel', context, reader.signal).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cancel).toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith(
      'inference.cancel-failed',
      expect.objectContaining({ kind: 'runtimeExited' }),
    )
  })

  /* And the one failure that IS expected stays quiet: the request finished
     before the cancel arrived, which is a race rather than a fault. */
  it('says nothing when the cancel lost the ordinary race', async () => {
    const report = vi.fn()
    const reader = new AbortController()
    const gloss = vi.fn(async () => {
      reader.abort()
      await new Promise((resolve) => setTimeout(resolve, 0))
      return 'never read'
    })
    const cancel = vi.fn().mockRejectedValue({ kind: 'requestUnknown', message: 'already done' })
    const provider = createGlossProvider({
      plugin: { gloss, cancel } as unknown as InferencePlugin,
      controller: { textModel: () => 'qwen', start: async () => {} } as unknown as Controller,
      report,
      installAt: MODELS,
    })

    await provider.gloss('counsel', context, reader.signal).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cancel).toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  /*
   * ⚠️ **EVERY LISTENER IT ADDS, IT REMOVES.** The readiness race attached an
   * anonymous `{ once: true }` listener — which fires once but is only removed
   * BY firing, so on every ordinary lookup, where the start wins the race, it
   * stayed on the caller's signal for the signal's whole life.
   */
  it('leaves no abort listener behind on a lookup that succeeded', async () => {
    const reader = new AbortController()
    let live = 0
    const add = reader.signal.addEventListener.bind(reader.signal)
    const remove = reader.signal.removeEventListener.bind(reader.signal)
    reader.signal.addEventListener = ((type: string, listener: never, options: never) => {
      if (type === 'abort') live += 1
      return add(type, listener, options)
    }) as typeof reader.signal.addEventListener
    reader.signal.removeEventListener = ((type: string, listener: never, options: never) => {
      if (type === 'abort') live -= 1
      return remove(type, listener, options)
    }) as typeof reader.signal.removeEventListener

    const { provider } = harness()
    await expect(provider.gloss('counsel', context, reader.signal)).resolves.toBeTruthy()

    expect(live, 'an abort listener outlived the lookup that added it').toBe(0)
  })

  /*
   * ⚠️ **THE MAINTAINER'S HALF.** Everything the reader is shown is a
   * translation, and every translation throws away the text that says what
   * happened. `RuntimeHttp` proves it: the variant carries a status precisely
   * so somebody can act on it, and the reader's sentence — "The runtime refused
   * the request" — names neither the status nor the route. Without this, a
   * failing gloss left nothing anywhere.
   */
  it('logs what actually happened, not the sentence the reader gets', async () => {
    const report = vi.fn()
    const gloss = vi
      .fn()
      .mockRejectedValue({ kind: 'runtimeHttp', message: 'the inference runtime answered 404 for /api/v1/chat/completions' })
    const { provider } = harness({ gloss: gloss as never })
    const withReport = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller: { textModel: () => 'qwen', start: async () => {} } as unknown as Controller,
      report,
      installAt: MODELS,
    })
    void provider

    await withReport.gloss('counsel', context, signal()).catch(() => {})

    expect(report).toHaveBeenCalledWith('inference.gloss-failed', {
      kind: 'runtimeHttp',
      model: 'qwen',
      /* THE STATUS AND THE ROUTE SURVIVE. `String(cause)` on a `{kind, message}`
         object gives `[object Object]`, which would throw away the one thing
         worth logging. */
      message: 'the inference runtime answered 404 for /api/v1/chat/completions',
    })
  })

  /*
   * ⚠️ **A REPORTER THAT THROWS USED TO REPLACE THE FAILURE IT WAS REPORTING.**
   * The report sat inside the rejection handler, unguarded, so a reporter that
   * threw rejected the lookup with ITS error — the reader was told "reporter
   * broke" where the runtime had answered 404. `controller.ts` and the
   * companion's `provider.ts` had each learned this already: the log is a
   * courtesy, and a courtesy must not take the answer down with it.
   */
  it('still tells the reader what failed when the reporter itself throws', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = createGlossProvider({
        plugin: {
          gloss: vi.fn().mockRejectedValue({ kind: 'runtimeHttp', message: 'the inference runtime answered 404' }),
          cancel: vi.fn(),
        } as unknown as InferencePlugin,
        controller: { textModel: () => 'qwen', start: async () => {} } as unknown as Controller,
        report: () => {
          throw new Error('reporter broke')
        },
        installAt: MODELS,
      })

      expect((await refusalOf(provider.gloss('counsel', context, signal()))).message).toBe('The runtime refused the request')
      expect(said, 'the reporter’s own failure was swallowed rather than said').toHaveBeenCalled()
      expect(said).toHaveBeenCalledWith(
        'inference gloss: the failure reporter itself threw',
        expect.objectContaining({ message: 'reporter broke' }),
        'while reporting',
        'inference.gloss-failed',
      )
    } finally {
      said.mockRestore()
    }
  })

  /* AND NO REPORTER IS NOT A BROKEN ONE. A provider built with nothing to
     report to says nothing about reporting — a console line blaming a
     reporter that was never given would send somebody looking for one. */
  it('says nothing about reporting when it was given nothing to report to', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { provider } = harness({
        gloss: vi.fn().mockRejectedValue({ kind: 'runtimeHttp', message: 'the inference runtime answered 404' }) as never,
      })
      expect((await refusalOf(provider.gloss('counsel', context, signal()))).message).toBe('The runtime refused the request')
      expect(said, 'a missing reporter was reported as a broken one').not.toHaveBeenCalled()
    } finally {
      said.mockRestore()
    }
  })

  /* REPORTED FOR EVERY FAILURE BUT THE READER'S OWN ABORT — that one is every
     selection change, and a log full of them buries the failures. The corners
     either side of it are each worth a line: a cancellation nobody asked for is
     the daemon stopping, and a real failure is no less one for landing after
     the reader moved on. */
  it.each([
    { what: 'the reader’s own cancellation', kind: 'cancelled', readerLeft: true, reported: false },
    { what: 'a cancellation nobody asked for', kind: 'cancelled', readerLeft: false, reported: true },
    { what: 'a failure that landed after the reader left', kind: 'runtimeExited', readerLeft: true, reported: true },
  ])('decides whether $what is worth a log line', async ({ kind, readerLeft, reported }) => {
    const report = vi.fn()
    const reader = new AbortController()
    const provider = createGlossProvider({
      plugin: {
        gloss: vi.fn(async () => {
          if (readerLeft) reader.abort()
          return Promise.reject({ kind, message: 'the daemon said so' })
        }),
        cancel: vi.fn(async () => {}),
      } as unknown as InferencePlugin,
      controller: { textModel: () => 'qwen', start: async () => {} } as unknown as Controller,
      report,
      installAt: MODELS,
    })

    await provider.gloss('counsel', context, reader.signal).catch(() => {})
    expect(report.mock.calls).toEqual(
      reported ? [['inference.gloss-failed', { kind, model: 'qwen', message: 'the daemon said so' }]] : [],
    )
  })

  /* THE ID SAYS IT IS A GLOSS, and the cancel carries the one the request
     did: `requests.rs` correlates the two by it, and a log line naming
     `gloss-…` is a lookup rather than an answer to a question. */
  it('cancels the request it made, by an id that names it a gloss', async () => {
    const reader = new AbortController()
    const { provider, gloss, cancel } = harness({
      gloss: vi.fn(async () => {
        reader.abort()
        return 'Guarded.'
      }) as never,
    })
    await provider.gloss('counsel', context, reader.signal).catch(() => {})

    const sent = gloss.mock.calls[0]?.[0] as string
    expect(sent).toMatch(/^gloss-/)
    expect(cancel.mock.calls).toEqual([[sent]])
  })

  /* A CHAPTER'S WORTH, OLDEST OUT FIRST — `CACHE_LIMIT`. A cache with no
     bound is a leak with a sentence in every key; one that lets the NEWEST
     go makes the word just looked up cost a second request. */
  it('holds two hundred glosses, and lets the oldest go first', async () => {
    const { provider, gloss } = harness()
    const nth = (n: number): GlossContext => ({ ...context, sentence: `Sentence number ${n}.` })
    for (let n = 0; n < 200; n += 1) await provider.gloss('counsel', nth(n), signal())
    expect(provider.cacheSize(), 'two hundred were not all kept').toBe(200)

    await provider.gloss('counsel', nth(200), signal())
    expect(provider.cacheSize(), 'the cache grew past its limit, or shrank below it').toBe(200)
    await provider.gloss('counsel', nth(200), signal())
    await provider.gloss('counsel', nth(1), signal())
    expect(gloss, 'the newest or the second-oldest was let go').toHaveBeenCalledTimes(201)
    await provider.gloss('counsel', nth(0), signal())
    expect(gloss, 'the oldest was kept past the limit').toHaveBeenCalledTimes(202)
  })

  /*
   * ⚠️ **THE WAIT FOR THE RUNTIME ENDS WHEN THE READER LEAVES, NOT WHEN THE
   * RUNTIME IS UP.** A cold start takes seconds, and a reader who selected a
   * word and moved on is not held for it — that is what the race is for, and
   * no test here had ever aborted DURING it: every abort landed before the
   * wait began or after the question was sent.
   */
  it('stops waiting for the runtime the moment the reader leaves, and never asks', async () => {
    const launched = deferred()
    const gloss = vi.fn()
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller: { textModel: () => 'qwen', start: () => launched.promise } as unknown as Controller,
      installAt: MODELS,
    })
    const reader = new AbortController()
    const asked = provider.gloss('counsel', context, reader.signal).then(() => null, (e: unknown) => e)
    await settle()
    expect(gloss, 'the model was asked before the runtime was up').not.toHaveBeenCalled()

    reader.abort()
    const outcome = await Promise.race([asked, settle().then(() => 'still waiting for the runtime')])
    expect(outcome).toBeInstanceOf(DOMException)
    expect((outcome as DOMException).name).toBe('AbortError')
    expect((outcome as DOMException).message).toBe('Aborted')

    launched.open()
    await settle()
    expect(gloss, 'the runtime came up and the abandoned lookup was sent anyway').not.toHaveBeenCalled()
  })

  /* AN ABORT LANDING WHILE THE LAUNCH IS BEING ASKED FOR is the same abort:
     the controller's `start` runs synchronously up to its first await, and
     anything it notifies can move the reader on before the wait has begun. */
  it('ends a lookup whose reader left while the launch was being asked for', async () => {
    const reader = new AbortController()
    const launched = deferred()
    const gloss = vi.fn()
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller: {
        textModel: () => 'qwen',
        start: () => {
          reader.abort()
          return launched.promise
        },
      } as unknown as Controller,
      installAt: MODELS,
    })

    const asked = provider.gloss('counsel', context, reader.signal).then(() => null, (e: unknown) => e)
    const outcome = await Promise.race([asked, settle().then(() => 'still waiting for the runtime')])
    expect(outcome).toBeInstanceOf(DOMException)
    expect((outcome as DOMException).message).toBe('Aborted')
    expect(gloss).not.toHaveBeenCalled()
    launched.open()
  })

  /* AND AN ABORT THAT LANDS AS THE LAUNCH SETTLES — the runtime won the race
     and the reader is already gone — is still an abort, and the question is
     not sent. Landed at the one moment between the two that a test can reach
     without counting microtasks: when the wait lets go of the signal. */
  it('does not send the question when the reader left as the runtime came up', async () => {
    const reader = new AbortController()
    const remove = reader.signal.removeEventListener.bind(reader.signal)
    reader.signal.removeEventListener = ((type: string, listener: never, options: never) => {
      remove(type, listener, options)
      reader.abort()
    }) as typeof reader.signal.removeEventListener
    const { provider, gloss } = harness()

    const failure = await provider.gloss('counsel', context, reader.signal).catch((e: unknown) => e)
    expect(gloss, 'the question went out after the reader had left').not.toHaveBeenCalled()
    expect(failure).toBeInstanceOf(DOMException)
    expect((failure as DOMException).message).toBe('Aborted')
  })

  /* AND THE SAME REPORTER REACHES `cancelRequest`, where a throw has nobody to
     catch it: it runs in the handler of a promise nothing awaits, so it escaped
     as an unhandled rejection. One guarded reporter covers both sites. */
  it('lets no reporter failure escape a cancel that failed', async () => {
    const escaped: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      escaped.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reader = new AbortController()
      const gloss = vi.fn(async () => {
        reader.abort()
        await new Promise((resolve) => setTimeout(resolve, 0))
        return 'never read'
      })
      const cancel = vi.fn().mockRejectedValue({ kind: 'runtimeExited', message: 'gone' })
      const provider = createGlossProvider({
        plugin: { gloss, cancel } as unknown as InferencePlugin,
        controller: { textModel: () => 'qwen', start: async () => {} } as unknown as Controller,
        report: () => {
          throw new Error('reporter broke')
        },
        installAt: MODELS,
      })

      await provider.gloss('counsel', context, reader.signal).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(cancel, 'no cancel went out, so this measures nothing').toHaveBeenCalled()
      expect(escaped, 'a reporter failure escaped the cancel as an unhandled rejection').toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      said.mockRestore()
    }
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

/**
 * `installAt` FOLLOWS THE RUNTIME — WI-20.21.
 *
 * It was `installable`, the constant `true`, on the argument that `inference`
 * composing is what puts the Local models section in Settings. It is — but a
 * models pane whose runtime is absent has nothing to install a model INTO: the
 * Look up strip offered "Install one", the pane took the download, and every
 * lookup then failed with "The runtime is not installed". Whether there is
 * somewhere useful to send the reader is what this answers, and with no runtime
 * there is not.
 *
 * AND IT SAYS WHERE, since phase 17's L3: the offer used to open Settings at the
 * top, with Local models collapsed further down, because a boolean could not
 * say which section it meant.
 */
describe('installAt', () => {
  const withRuntime = (kind: 'absent' | 'installed' | 'ready') => {
    const runtime = kind === 'absent' ? { kind, reason: 'x' } : kind === 'ready' ? { kind, version: '1' } : { kind }
    const controller = {
      textModel: () => null,
      start: async () => {},
      getSnapshot: () => ({ runtime, models: [], installing: null, failure: null }),
    } as unknown as Controller
    return createGlossProvider({ plugin: {} as InferencePlugin, controller, installAt: MODELS })
  }

  it('is nowhere while the runtime is absent, so nothing offers a download that cannot run', () => {
    expect(withRuntime('absent').installAt).toBeNull()
  })

  it('is the models section once there is a runtime to install a model into', () => {
    expect(withRuntime('installed').installAt).toBe(MODELS)
    expect(withRuntime('ready').installAt).toBe(MODELS)
  })
})

describe('audit-fix round 1 — the cache key', () => {
  it('keys on the book title too, and survives a NUL inside the text', () => {
    const titled = { ...context, sentence: 'The counsel rose.', bookTitle: 'Bleak House' }
    expect(glossQuestion('counsel', titled)).not.toBe(
      glossQuestion('counsel', { ...titled, bookTitle: 'Great Expectations' }),
    )
    /* A NUL is ordinary text to the squeeze, and the field separator is a
       newline no field can contain — so this cannot collide for the reason the
       encoded tuple it replaces could not. */
    expect(glossQuestion('a\u0000b', { ...context, sentence: 'c', bookTitle: '' })).not.toBe(
      glossQuestion('a', { ...context, sentence: 'b\u0000c', bookTitle: '' }),
    )
  })
})
