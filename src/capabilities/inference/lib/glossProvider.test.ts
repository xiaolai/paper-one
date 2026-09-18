import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createSettingsStore, type Definition, type GlossContext } from '../../../kernel'
import { createController, type Controller, type InferenceSnapshot } from './controller'
import {
  createGlossProvider,
  definitionOf,
  withoutHeadword,
  glossQuestion,
  DEFAULT_GLOSS_PROMPT,
  GLOSS_PROMPT_SETTING,
  MAX_GLOSS_PROMPT,
} from './glossProvider'
import { AUTOMATIC, type RouteStore } from './glossRoute'
import type { InferencePlugin, Route } from './plugin'
import { refusalOf } from '../../../kernel/testkit'

const ENGLISH = { tag: 'en', name: 'English', label: 'English' } as const
const CHINESE = { tag: 'zh-Hans', name: 'Simplified Chinese', label: '简体中文' } as const
/** Where "Choose one" goes — the Look up section, which `index.ts` hands in. */
const LOOK_UP = 'inference:gloss'

/**
 * A controller standing in for the real one, with the one thing the old fakes
 * never needed: a SNAPSHOT. Which route answers reads the runtime and the
 * installed models from it (`usableLocal`), so a fake without one could not say
 * whether the local model can answer at all. Unless told otherwise, the runtime
 * is there and the model `textModel` names is installed — the ordinary state of
 * a machine that has taken the download.
 */
function asController(over: {
  readonly textModel: () => string | null
  readonly start: () => Promise<void>
  readonly getSnapshot?: () => Pick<InferenceSnapshot, 'runtime' | 'models'>
}): Controller {
  const installed = (): InferenceSnapshot => {
    const model = over.textModel()
    return {
      runtime: { kind: 'installed' },
      models: model === null ? [] : [{ id: model, label: model, license: 'Apache-2.0', bytes: 1, installed: true }],
      installing: null,
      removing: null,
      failure: null,
    }
  }
  return { getSnapshot: installed, ...over } as unknown as Controller
}

/**
 * The last probe, held as `RouteStore` holds it — `refresh` a spy, so a case
 * can see whether a failure asked for a fresh one.
 */
function probed(routes: readonly Route[]): Pick<RouteStore, 'getSnapshot' | 'refresh'> & {
  readonly refresh: ReturnType<typeof vi.fn>
} {
  return { getSnapshot: () => ({ routes, probing: false }), refresh: vi.fn(async () => {}) }
}

/** A probe route that can answer, of the kind its id names. */
const usable = (id: string, label = id): Route => ({
  id,
  kind: id.startsWith('endpoint:') ? 'endpoint' : id.startsWith('agent:') ? 'agent' : 'local',
  label,
  detail: null,
  unusable: null,
  installed: true,
})

/** The same route, unable to answer — `reason` and its sentence together, as `probe.rs` emits them. */
const unusable = (id: string): Route => ({ ...usable(id), unusable: 'Signed out', reason: 'signedOut' })

/**
 * The default, supplied the way the capability supplies the reader's — see
 * `GlossProviderOptions.prompt`.
 *
 * A FUNCTION rather than the string, because that is the contract and because
 * the cases below that change what it returns mid-session are measuring exactly
 * what the getter exists for: a provider handed the string would serve whatever
 * was stored when it was built for the rest of the session.
 */
const PROMPT = (): string => DEFAULT_GLOSS_PROMPT

const context: GlossContext = {
  sentence: 'He kept his own counsel, and the crew grew close about him.',
  bookTitle: 'Moby-Dick',
  answerIn: [ENGLISH],
}

function harness(
  over: Partial<InferencePlugin> = {},
  model: string | null = 'qwen',
  routing: { readonly route?: () => string; readonly routes?: ReturnType<typeof probed> } = {},
) {
  const plugin = {
    gloss: vi.fn(async () => 'Guarded; unwilling to share what he thought.'),
    cancel: vi.fn(async () => {}),
    ...over,
  } as unknown as InferencePlugin
  const controller = asController({
    textModel: () => model,
    start: async () => {},
  })
  /* Read the spies BACK OFF the assembled plugin, not from the defaults: an
   * override replaces the default, and returning the default would have the
   * test asserting against a function nothing calls — which is a test that
   * passes for the wrong reason. */
  const routes = routing.routes ?? probed([])
  return {
    plugin,
    controller,
    routes,
    gloss: plugin.gloss as unknown as ReturnType<typeof vi.fn>,
    cancel: plugin.cancel as unknown as ReturnType<typeof vi.fn>,
    provider: createGlossProvider({
      plugin,
      controller,
      prompt: PROMPT,
      route: routing.route ?? (() => AUTOMATIC),
      routes,
      installAt: LOOK_UP,
    }),
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
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/Start straight with the meaning, the way a dictionary entry does/)
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/never "Wharves are" and never "In this sentence"/)
  })

  it('tells the model not to restate the sentence', () => {
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/Do not restate the sentence/)
  })

  /**
   * ⚠️ **THE DEFAULT DESCRIBES NO FORMAT — THE SCHEMA OWNS IT.** A `pos:` line
   * stood here, pinned by two tests of its wording, and it broke 7 of 9 real
   * answers while both were green (`DEFAULT_GLOSS_PROMPT` has the table). This
   * pins the ABSENCE, which is the one thing a test of the prompt's text can
   * honestly say: whether the wording works is a question for the model, and
   * `live_gloss_answers_in_the_shape_it_asked_for` in the crate is how it is
   * asked. The part of speech and the JSON are `gloss.rs`'s, not this string's.
   */
  it('describes no answer format of its own — the schema owns the shape', () => {
    expect(DEFAULT_GLOSS_PROMPT).not.toMatch(/pos:/i)
    expect(DEFAULT_GLOSS_PROMPT).not.toMatch(/part of speech|part-of-speech/i)
    expect(DEFAULT_GLOSS_PROMPT).not.toMatch(/json/i)
    /* AND IT IS THE WORDING THAT MEASURED CLEAN: the WI-17.5 language line ends
       where it did before the `pos:` clause was appended to it. */
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/the first language first, each on its own line\.$/)
  })

  /* WI-17.5: the language is named in the question, and two languages come
     back as two lines in the order asked — measured inside the token bound. */
  it('tells the model to answer in the language named, and how to answer in two', () => {
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/Write the answer in the language the request names/)
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/one sentence in each, the first language first, each on its own line/)
  })

  it('asks for one sense, not every sense', () => {
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/only the sense used here/)
  })

  it('bounds the answer to what a popover can hold', () => {
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/one or two sentences/)
  })

  /* THE FRAME, AND THE WAY OUT. The first line is what is being asked of the
     model at all; the other is what it does when the page does not settle the
     sense, which is to say so rather than pick one. */
  it('says what a gloss is, and what to do when the sentence does not settle it', () => {
    expect(DEFAULT_GLOSS_PROMPT).toMatch(/^You define a word or phrase as it is used in one specific sentence from a book\. /)
    expect(DEFAULT_GLOSS_PROMPT).toContain('If the sentence does not make the sense clear, say so plainly in one sentence.')
  })

  it('reads as one paragraph, a space between its sentences', () => {
    expect(DEFAULT_GLOSS_PROMPT).toContain('from a book. Answer in one or two sentences')
    expect(DEFAULT_GLOSS_PROMPT).not.toMatch(/\n/)
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
 * THE PROMPT AS THE READER MAY REWRITE IT.
 *
 * Everything above pins the DEFAULT, which is where the measurements live. This
 * block is about the other half: that the setting's default IS that constant,
 * and that `parse` — the trust boundary — refuses every stored value that would
 * quietly stop Look up working.
 */
describe('the gloss prompt as a setting', () => {
  it('names its key, its default and the bounds of its parse', () => {
    expect(GLOSS_PROMPT_SETTING.key).toBe('inference.glossPrompt')
    /* ⚠️ **THE DEFAULT IS THE MEASURED PROMPT ITSELF, not a copy of it.** Two
       strings that start out equal are two strings that can be edited apart,
       and the block above would then be asserting about the one nothing sends. */
    expect(GLOSS_PROMPT_SETTING.fallback).toBe(DEFAULT_GLOSS_PROMPT)
    expect(MAX_GLOSS_PROMPT).toBeGreaterThan([...DEFAULT_GLOSS_PROMPT].length)
  })

  /* ⚠️ **AN EMPTY PROMPT IS THE CASE THE PARSE EXISTS FOR.** Stored, it would
     hand the model no instructions at all and every lookup in the app would
     quietly stop being a gloss — no error, no mark, just answers that are not
     definitions. Refused, the reader keeps the app they had. */
  it.each([
    ['', 'the empty string'],
    ['   \n\t ', 'whitespace alone'],
  ])('refuses %o — %s', (raw) => {
    expect(GLOSS_PROMPT_SETTING.parse(raw)).toBeUndefined()
  })

  it.each([42, null, undefined, {}, ['a prompt'], true])('refuses %o, which is not a prompt', (raw) => {
    expect(GLOSS_PROMPT_SETTING.parse(raw)).toBeUndefined()
  })

  it('keeps a prompt the reader wrote, exactly as they wrote it', () => {
    const theirs = 'Define the word in one sentence a nine-year-old would understand.'
    expect(GLOSS_PROMPT_SETTING.parse(theirs)).toBe(theirs)
    /* Trimmed only to DECIDE — see the setting. What is stored is their text. */
    expect(GLOSS_PROMPT_SETTING.parse(`${theirs}\n`)).toBe(`${theirs}\n`)
  })

  it('accepts a prompt of exactly the bound, and refuses one character more', () => {
    expect(GLOSS_PROMPT_SETTING.parse('a'.repeat(MAX_GLOSS_PROMPT))).toHaveLength(MAX_GLOSS_PROMPT)
    expect(GLOSS_PROMPT_SETTING.parse('a'.repeat(MAX_GLOSS_PROMPT + 1))).toBeUndefined()
  })

  /**
   * ⚠️ **THE BOUND IS CODE POINTS AND THE CHEAP GUARD IN FRONT OF IT IS UTF-16
   * UNITS**, which are the same number for every script and differ only outside
   * the basic plane. So the case that separates a correct implementation from
   * one that counts units is a prompt made entirely of surrogate pairs: exactly
   * the bound in code points, exactly twice it in units.
   */
  it('counts code points, not UTF-16 units', () => {
    const astral = '𝄞'.repeat(MAX_GLOSS_PROMPT)
    expect(astral.length, 'the fixture is not made of surrogate pairs, so this measures nothing').toBe(
      MAX_GLOSS_PROMPT * 2,
    )
    expect(GLOSS_PROMPT_SETTING.parse(astral)).toBe(astral)
    expect(GLOSS_PROMPT_SETTING.parse(`${astral}𝄞`)).toBeUndefined()
  })

  /* A value nothing here chose the size of, which is what the guard in front of
     the spread is for: found in bytes on disk, not typed into the field.

     ⚠️ **THE TITLE'S SECOND HALF WAS NOT ASSERTED, AND A SWEEP SAID SO.** The
     code-point count behind the guard refuses the same strings, so the answer
     alone cannot tell the guard is there — deleting it survived (2026-09-18).
     What the guard buys is that the string is never SPREAD into characters, and
     a spread goes through `String.prototype[Symbol.iterator]`, so that is what
     is watched. The count is read before anything else can iterate a string. */
  it('refuses a prompt far past the bound without reading it as characters', () => {
    const iterate = vi.spyOn(String.prototype, Symbol.iterator)
    let parsed: string | undefined
    let spreads: number
    try {
      parsed = GLOSS_PROMPT_SETTING.parse('a'.repeat(MAX_GLOSS_PROMPT * 10))
      spreads = iterate.mock.calls.length
    } finally {
      iterate.mockRestore()
    }
    expect(parsed).toBeUndefined()
    expect(spreads, 'the over-long prompt was read character by character').toBe(0)
    /* NON-VACUITY: the spy does see a spread — a prompt inside the bound is
       counted in code points, which is the read the guard exists to skip. */
    const seen = vi.spyOn(String.prototype, Symbol.iterator)
    try {
      GLOSS_PROMPT_SETTING.parse('a prompt within the bound')
      expect(seen.mock.calls.length, 'the spy cannot see a spread, so this measures nothing').toBeGreaterThan(0)
    } finally {
      seen.mockRestore()
    }
  })
})

/**
 * ⚠️ **A CAPABILITY'S SETTING NEEDS NO SECOND REGISTRATION ANYWHERE, AND THE
 * KERNEL'S DO.**
 *
 * AGENTS.md records that a new preference must be named in `useAppState`'s
 * write effect or it will not survive a relaunch — `developer` and
 * `hiddenPanes` were not, and the chord worked and did not last the night. That
 * rule is about the KERNEL's preferences, which `useAppState` mirrors into the
 * store by hand from `KERNEL_SETTINGS`. A capability's setting never enters that
 * mirror: `SettingsStore.set` writes through to storage itself, which is the
 * whole of what makes `circle.coverCapMB` and `sync.coverCapMB` durable today.
 *
 * Measured rather than argued, and measured the way `clock.test.ts` measures a
 * device id: one store writes, a SECOND store opened over the same storage
 * reads — which is what a relaunch is.
 */
describe('the reader’s prompt, across a relaunch', () => {
  const memory = (): Storage => {
    const held = new Map<string, string>()
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
    } as unknown as Storage
  }

  it('is still there when a fresh store opens over the same storage', () => {
    const theirs = 'Answer with the sense on this page, in one plain sentence.'
    const storage = memory()
    createSettingsStore({ storage }).set(GLOSS_PROMPT_SETTING, theirs)
    expect(createSettingsStore({ storage }).get(GLOSS_PROMPT_SETTING)).toBe(theirs)
  })

  it('is the default when nothing has been stored', () => {
    expect(createSettingsStore({ storage: memory() }).get(GLOSS_PROMPT_SETTING)).toBe(DEFAULT_GLOSS_PROMPT)
  })

  /* AND A STORED VALUE THE PARSE REFUSES IS THE DEFAULT TOO — the end of the
     trust boundary, measured through the real store rather than through the
     parser alone: `get` promises never to fail, so a damaged file leaves the
     reader with the app they had rather than with no instructions at all. */
  it('is the default when what is stored is not a prompt', () => {
    const storage = memory()
    createSettingsStore({ storage }).set(GLOSS_PROMPT_SETTING, '   ' as string)
    expect(createSettingsStore({ storage }).get(GLOSS_PROMPT_SETTING)).toBe(DEFAULT_GLOSS_PROMPT)
  })
})

/**
 * A reply in the PORTABLE shape the crate's schema asks for: the part of
 * speech, and a `first` meaning and — when two are given — a `second`. The
 * language each entry names is not read by the parse — the slot says which is
 * which — so every entry here says English.
 */
const schemaReply = (partOfSpeech: unknown, ...texts: unknown[]): string => {
  const slots = ['first', 'second'] as const
  if (texts.length > slots.length) throw new Error('the portable shape has two slots, and this reply was given more meanings')
  return JSON.stringify({
    definition: Object.fromEntries(texts.map((text, at) => [slots[at], { language: 'English', text }])),
    partOfSpeech,
  })
}

/**
 * A reply that satisfies `schema`, every free string holding its own PATH —
 * `$.partOfSpeech`, `$.definition.second.text` — so an assertion on the parse
 * says exactly which field it read.
 *
 * It knows only the keywords the crate's schema uses — `type`, `enum`,
 * `properties`, `required` — and THROWS on any other: a schema that grew a
 * shape this cannot build is a contract this file has stopped checking, and that
 * must be loud rather than a quietly smaller reply. An `enum` must name exactly
 * one value, which is how the portable shape pins each slot's language; a
 * choice between several is a shape this builder would have to guess at.
 *
 * (It read `const` and `prefixItems` until the portable shape replaced the
 * list: Claude's strict mode refuses `prefixItems`, OpenAI's refuses `const`
 * without a `type` — the gloss routes contract, §2.)
 */
function instanceOf(schema: unknown, path = '$'): unknown {
  if (typeof schema !== 'object' || schema === null) throw new Error(`${path}: not a schema`)
  const node = schema as Record<string, unknown>
  if ('enum' in node) {
    if (!Array.isArray(node.enum) || node.enum.length !== 1) throw new Error(`${path}: an enum of other than one value — ${JSON.stringify(node)}`)
    return node.enum[0]
  }
  if (node.type === 'string') return path
  if (node.type === 'object') {
    const properties = node.properties as Record<string, unknown>
    return Object.fromEntries((node.required as string[]).map((key) => [key, instanceOf(properties[key], `${path}.${key}`)]))
  }
  throw new Error(`${path}: a schema this builder does not know — ${JSON.stringify(node)}`)
}

/**
 * REPLIES THE LIVE MODEL WROTE — through the real request builder and the real
 * schema, against a running daemon, on 2026-09-18
 * (`live_gloss_answers_in_the_shape_it_asked_for`, Qwen3-4B-Instruct-2507,
 * the default prompt). Chosen for what no hand-written case had: the
 * indentation the grammar lets the model write, the keys in the order the
 * request carried them (`definition` before `partOfSpeech` — sorted, see
 * `gloss.rs`), and both orders of a two-language answer.
 *
 * VERBATIM, from the run against the PORTABLE shape (`definition: {first,
 * second}`), 2026-09-18 — they replaced replies measured in the list shape and
 * converted by hand. The third is chosen for what the model does worst: a
 * Chinese-first answer written dictionary-style and the English copying it,
 * both of which `withoutHeadword` takes off (the other runs of that case were
 * the same, and a Chinese-first `quarter` once answered only `一个季度` /
 * `a quarter` — a restatement no parse can turn into a definition).
 * The expected values were derived from each reply independently of this file's
 * parse, and read back by eye.
 */
const LIVE: readonly { readonly name: string; readonly term: string; readonly raw: string; readonly expected: Definition }[] = [
  {
    name: 'one language (“quarter”)',
    term: 'quarter',
    raw: '{ \"definition\": { \"first\": { \"language\": \"English\", \"text\": \"A three-month period, often used in business or financial contexts to track performance and progress.\" } },\"partOfSpeech\": \"noun\" }',
    expected: { text: 'A three-month period, often used in business or financial contexts to track performance and progress.', partOfSpeech: 'noun' },
  },
  {
    name: 'English, then Simplified Chinese (“transparent”)',
    term: 'transparent',
    raw: '{ \"definition\": { \"first\": { \"language\": \"English\", \"text\": \"Easy to understand and see, with no hidden parts or unclear information\" }, \"second\": { \"language\": \"Simplified Chinese\", \"text\": \"容易理解且清晰可见，没有隐藏部分或模糊信息\" } },\"partOfSpeech\": \"adjective\"}',
    expected: { text: 'Easy to understand and see, with no hidden parts or unclear information\n容易理解且清晰可见，没有隐藏部分或模糊信息', partOfSpeech: 'adjective' },
  },
  {
    name: 'Simplified Chinese, then English, both restating the headword (“transparent”)',
    term: 'transparent',
    raw: '{ \"definition\": { \"first\": { \"language\": \"Simplified Chinese\", \"text\": \"透明的，指事物清楚可见，没有隐藏或隐瞒\" }, \"second\": { \"language\": \"English\", \"text\": \"transparent, meaning clearly visible and free from hidden or concealed elements\" } },\"partOfSpeech\": \"adjective\"}',
    expected: { text: '事物清楚可见，没有隐藏或隐瞒\nClearly visible and free from hidden or concealed elements', partOfSpeech: 'adjective' },
  },
]

/**
 * THE SCHEMA'S OTHER HALF. `definitionOf` reads the JSON the crate's schema
 * (`gloss.rs`) makes the model write, so the cases below are that JSON.
 *
 * ⚠️ **A PARSE TESTED ONLY ON REPLIES SOMEBODY IMAGINED IS HOW 7 OF 9 REAL
 * ANSWERS BROKE PAST A GREEN SUITE.** The `pos:` parse this replaced was
 * measured on replies typed into this file, and the model wrote none of them.
 * So the evidence here comes in three kinds, and says which is which:
 *
 * - replies the LIVE MODEL wrote (`LIVE` above), verbatim;
 * - a reply BUILT FROM `fixtures/gloss-response-format.json`, the file the
 *   crate asserts its schema equals — so a field renamed on the Rust side fails
 *   here rather than in front of a reader;
 * - hand-written cases, for the one thing no model reply exercises: a reply
 *   that is NOT what the schema promised.
 *
 * What none of them can see is a daemon that stopped honouring the schema —
 * that needs the daemon, and the crate's ignored live test is how it is asked.
 *
 * ⚠️ **EVERY REFUSAL KEEPS THE WHOLE TEXT.** A part of speech that goes missing
 * costs a line of small grey type; a definition that goes missing is an empty
 * amber mark beside a word, which `core/gloss.ts` forbids in as many words.
 * There is no input for which this may answer with less text than it was given
 * — and a bad part of speech costs only the part of speech (see `definitionOf`).
 * `toStrictEqual` throughout: "absent" is the contract, and `toEqual` cannot
 * tell an absent field from one set to `undefined`.
 */
describe('the definition and part of speech the model wrote', () => {
  const MEANING = 'Structures along a shore where ships dock.'
  const FIXTURE = fileURLToPath(
    new URL('../../../../src-tauri/crates/tauri-plugin-inference/fixtures/gloss-response-format.json', import.meta.url),
  )

  /* ⚠️ **ONE FIXTURE, TWO HALVES.** The crate's `the_shape_is_the_one_the_parse_is_held_to`
     asserts it BUILDS exactly this file; this asserts the parse READS a reply
     built from it. A field renamed in `gloss.rs` alone fails there; the fixture
     updated to match fails here until `definitionOf` reads the new name. */
  it('reads a reply built from the schema the crate sends — the fixture both halves are held to', () => {
    const format = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { readonly json_schema: { readonly schema: unknown } }
    const reply = instanceOf(format.json_schema.schema)
    /* NON-VACUITY: the fixture is the two-language instance, so a builder that
       silently dropped `second` would pass the parse with half a definition. */
    expect(reply, 'the fixture is not the two-language portable shape, so this measures less than it says').toMatchObject({
      definition: { first: { language: 'English' }, second: { language: 'Simplified Chinese' } },
    })
    expect(definitionOf(JSON.stringify(reply), 'wharves')).toStrictEqual({
      text: '$.definition.first.text\n$.definition.second.text',
      partOfSpeech: '$.partOfSpeech',
    })
  })

  it.each(LIVE)('reads what the live model wrote, verbatim — $name', ({ raw, term, expected }) => {
    expect(definitionOf(raw, term)).toStrictEqual(expected)
  })

  it('reads the part of speech and the meaning, and nothing of the JSON around them', () => {
    expect(definitionOf(schemaReply('noun', MEANING), 'wharves')).toStrictEqual({ text: MEANING, partOfSpeech: 'noun' })
  })

  /* WI-17.5: two languages are two entries, drawn as two LINES in the order
     they came — the order the schema fixed, which is the order asked. The label
     is whatever the answer's language calls it; there is no vocabulary to hold
     it to. */
  it('draws two languages as two lines, in the order they came', () => {
    expect(definitionOf(schemaReply('noun', MEANING, '码头。'), 'wharves')).toStrictEqual({
      text: `${MEANING}\n码头。`,
      partOfSpeech: 'noun',
    })
    expect(definitionOf(schemaReply('名词', '码头。', MEANING), 'wharves')).toStrictEqual({
      text: `码头。\n${MEANING}`,
      partOfSpeech: '名词',
    })
  })

  /* ⚠️ **THE GRAMMAR PUTS WHITESPACE WHERE IT LIKES.** The live replies are
     indented with spaces and newlines, and a reader's prompt was measured
     drawing tabs. JSON reads all of it — CRLF included, which is the ending the
     `pos:` parse silently refused. */
  it('reads a reply whatever whitespace the grammar let the model write, CRLF and tabs included', () => {
    const indented = `{\r\n\t"definition": {\r\n\t\t"first": { "language": "English", "text": "${MEANING}" }\r\n\t},\r\n\t"partOfSpeech": "noun"\r\n}`
    expect(definitionOf(`  ${indented}\n `, 'wharves')).toStrictEqual({ text: MEANING, partOfSpeech: 'noun' })
  })

  it('trims each meaning and the label, and changes nothing else in them', () => {
    expect(definitionOf(schemaReply('  noun ', `  ${MEANING}\n`, ' 码头。 '), 'wharves')).toStrictEqual({
      text: `${MEANING}\n码头。`,
      partOfSpeech: 'noun',
    })
  })

  /* A meaning that happens to open like the retired marker is the model's own
     words — a term being defined could be `pos` — and nothing strips it. */
  it('leaves a label-like opening inside the meaning alone', () => {
    const text = 'pos: the point of sale, where a purchase is paid for.'
    expect(definitionOf(schemaReply('noun', text), 'wharves')).toStrictEqual({ text, partOfSpeech: 'noun' })
  })

  /* ⚠️ **THE RETIRED SHAPE, AND THE WORST AN OLD ANSWER COULD DO.** A prose
     reply — the `pos:` format this replaced, or a daemon that ignored the
     schema — is not JSON, and is drawn whole. The header on the provider says
     why no answer cached under the old format can reach this at all. */
  it('reads a reply in the retired pos: shape as all definition', () => {
    const retired = `pos: noun\n${MEANING}`
    expect(definitionOf(retired, 'wharves')).toStrictEqual({ text: retired })
    expect(definitionOf(`  ${MEANING}  `, 'wharves')).toStrictEqual({ text: MEANING })
  })

  it.each([
    ['cut off mid-object', `{ "definition": { "first": { "language": "English", "text": "${MEANING}" } }, "partOfSpeech":`],
    ['JSON null', 'null'],
    ['a JSON string', JSON.stringify(MEANING)],
    ['a JSON number', '42'],
    ['a list rather than an object', JSON.stringify([{ language: 'English', text: MEANING }])],
    ['a definition that is one string — the shape measured dropping a language', JSON.stringify({ definition: MEANING, partOfSpeech: 'noun' })],
    /* ⚠️ THE RETIRED LIST SHAPE IS READ BY NOTHING, deliberately: no route
       writes it, and a second parser for it would be a second answer waiting to
       disagree with the first. It is drawn whole, like any reply that is not
       the portable shape. */
    ['the retired list shape', JSON.stringify({ definition: [{ language: 'English', text: MEANING }], partOfSpeech: 'noun' })],
    ['a definition with no entries', schemaReply('noun')],
    ['a definition with a second meaning and no first', JSON.stringify({ definition: { second: { language: 'English', text: MEANING } }, partOfSpeech: 'noun' })],
    ['no definition at all', JSON.stringify({ partOfSpeech: 'noun' })],
    ['an entry with no text', JSON.stringify({ definition: { first: { language: 'English' } }, partOfSpeech: 'noun' })],
    ['an entry whose text is not a string', schemaReply('noun', 42)],
    ['an entry whose text is blank', schemaReply('noun', ' \n ')],
    ['an entry that is null', JSON.stringify({ definition: { first: null }, partOfSpeech: 'noun' })],
  ])('keeps the whole reply as the definition when it is %s', (_why, raw) => {
    expect(definitionOf(` ${raw} `, 'wharves')).toStrictEqual({ text: raw })
  })

  /* ⚠️ **ALL OR NOTHING.** A second language that came back empty is a language
     the reader asked for and would not get, and drawing the first alone would
     hide that — the definition would look whole and be half. */
  it('refuses a definition one language short rather than drawing half of it', () => {
    const half = schemaReply('noun', MEANING, '')
    expect(definitionOf(half, 'wharves')).toStrictEqual({ text: half })
    /* A SECOND THAT IS THERE AND EMPTY is not a second that is absent: `null`
       says a language was asked for and not given, where no `second` at all is
       the schema's own shape for one language. */
    const nothing = JSON.stringify({ definition: { first: { language: 'English', text: MEANING }, second: null }, partOfSpeech: 'noun' })
    expect(definitionOf(nothing, 'wharves')).toStrictEqual({ text: nothing })
  })

  it.each([
    ['missing', JSON.stringify({ definition: { first: { language: 'English', text: MEANING } } })],
    ['not a string', schemaReply(7, MEANING)],
    ['null', schemaReply(null, MEANING)],
    ['empty', schemaReply('', MEANING)],
    ['only whitespace', schemaReply(' \t ', MEANING)],
  ])('drops a part of speech that is %s, and keeps the meaning', (_why, raw) => {
    expect(definitionOf(raw, 'wharves')).toStrictEqual({ text: MEANING })
  })

  /* THE BOUND ITSELF, from both sides and after the trim, so a mutant that
     moves it by one is a failure rather than a matter of taste — and what is
     past it costs the label, never the meaning. */
  it('accepts a label at the cap and drops one past it, keeping the meaning', () => {
    const thirty = 'a'.repeat(30)
    expect(definitionOf(schemaReply(` ${thirty} `, MEANING), 'wharves')).toStrictEqual({ text: MEANING, partOfSpeech: thirty })
    expect(definitionOf(schemaReply(`${thirty}a`, MEANING), 'wharves')).toStrictEqual({ text: MEANING })
  })

  /* ⚠️ **CODE POINTS, NOT UTF-16 UNITS.** Sixteen astral characters are 32
     units and 16 code points, so a cap measured with `.length` would drop a
     perfectly short label written in a script outside the basic plane. */
  it('measures the label in code points, not in UTF-16 units', () => {
    const astral = '𝘯'.repeat(16)
    expect(astral.length, 'the fixture no longer distinguishes the two counts').toBeGreaterThan(30)
    expect(definitionOf(schemaReply(astral, MEANING), 'wharves')).toStrictEqual({ text: MEANING, partOfSpeech: astral })
  })

  /* A reply that is nothing at all is `gloss`'s to refuse, not this one's — and
     it must not become something here. */
  it('answers an empty reply with an empty definition and no part of speech', () => {
    expect(definitionOf('   ', 'wharves')).toStrictEqual({ text: '' })
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
    const controller = asController({
      textModel: () => model,
      start: async () => {},
      getSnapshot: () => ({ runtime: { kind: 'installed' }, models: [], installing: null, removing: null, failure: null }),
    })
    const provider = createGlossProvider({ plugin: {} as InferencePlugin, controller, prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP })
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
      models: async () => [{ id: 'qwen', label: 'Qwen', license: 'Apache-2.0', bytes: 1, installed: true }],
      start: async () => 1,
      installModel: async () => {},
      removeModel: async () => {},
      cancel: async () => {},
    })
    await onDisk.refresh()
    const provider = createGlossProvider({ plugin: {} as InferencePlugin, controller: onDisk, prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP })

    expect(onDisk.textModel(), 'no model reads as installed, so this measures nothing').toBe('qwen')
    expect(onDisk.getSnapshot().runtime.kind, 'the runtime did not read as absent, so this measures nothing').toBe('absent')
    expect(provider.available, 'Look up offered a definition no runtime can produce').toBe(false)
    /* And the way out is still offered: with no runtime an endpoint or an agent
       can answer, and the Look up section is where the reader chooses one. */
    expect(provider.installAt).toBe(LOOK_UP)
  })

  it('throws rather than answering when nothing is installed', async () => {
    const { provider } = harness({}, null)
    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow(/Choose what answers in Settings → Look up/u)
  })

  it('answers from the model and trims it', async () => {
    const { provider, gloss } = harness({ gloss: vi.fn(async () => '  Guarded.  ') as never })
    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({ text: 'Guarded.' })
    expect(gloss).toHaveBeenCalledTimes(1)
  })

  /* THE PORT CARRIES THE PAIR, and no JSON reaches a reader: the definition the
     popup draws is the meaning out of the reply, not the reply. */
  it('hands back the part of speech and the meaning, and none of the JSON they came in', async () => {
    const { provider } = harness({ gloss: vi.fn(async () => schemaReply('noun', 'Structures along a shore where ships dock.')) as never })
    await expect(provider.gloss('wharves', context, signal())).resolves.toStrictEqual({
      text: 'Structures along a shore where ships dock.',
      partOfSpeech: 'noun',
    })
  })

  /* ⚠️ **A REMEMBERED ANSWER AND A FRESH ONE ARE ONE ANSWER.** The cache keeps
     the model's raw reply — JSON text now — and the parse runs on the way OUT of
     it, so this passes only because the second lookup, which makes no request
     at all, is read the same way. Caching the parsed pair instead would pass
     today and serve a stale reading the first time the parse changed. */
  it('reads a cached answer the same way, without asking again', async () => {
    const { provider, gloss } = harness({ gloss: vi.fn(async () => schemaReply('名词', '码头。')) as never })
    const fresh = await provider.gloss('wharves', context, signal())
    const remembered = await provider.gloss('wharves', context, signal())

    expect(remembered).toStrictEqual(fresh)
    expect(remembered).toStrictEqual({ text: '码头。', partOfSpeech: '名词' })
    expect(gloss).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ **THE SCHEMA IS BUILT FROM THE SAME NAMES THE QUESTION ASKS IN.** The
   * question says `Answer in: …` in prose; the plugin builds one schema entry
   * per language from the list it is handed, and that entry is what makes the
   * right language arrive in the right line. Two lists would be free to
   * disagree, so both come from one derivation — and this watches the two
   * arrive TOGETHER, in both orders, because "English first" is the order a
   * shape that ignored the list would get right by accident.
   */
  it('asks the plugin in exactly the languages the question names, in the same order', async () => {
    const { provider, gloss } = harness()
    await provider.gloss('counsel', context, signal())
    await provider.gloss('counsel', { ...context, answerIn: [CHINESE, ENGLISH] }, signal())
    await provider.gloss('counsel', { ...context, answerIn: [ENGLISH, CHINESE] }, signal())

    expect(gloss.mock.calls.map((call) => [String(call[3]).split('\n')[2], call[4]])).toStrictEqual([
      ['Answer in: English', ['English']],
      ['Answer in: Simplified Chinese, then English', ['Simplified Chinese', 'English']],
      ['Answer in: English, then Simplified Chinese', ['English', 'Simplified Chinese']],
    ])
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

    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({ text: 'Guarded.' })
    await expect(provider.gloss('counsel', { ...context, answerIn: [CHINESE] }, signal())).resolves.toEqual({ text: '守口如瓶。' })
    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({ text: 'Guarded.' })

    expect(gloss).toHaveBeenCalledTimes(2)
    expect(provider.cacheSize()).toBe(2)
  })

  /* "The cache is dropped when the model changes, because a gloss is an
   * answer from a particular model and not a fact." */
  it('drops the cache when the model changes', async () => {
    let model = 'qwen'
    const gloss = vi.fn(async () => 'Guarded.')
    const controller = asController({ textModel: () => model, start: async () => {} })
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller,
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
    })
    await provider.gloss('counsel', context, signal())
    expect(provider.cacheSize()).toBe(1)

    model = 'another-model'
    await provider.gloss('counsel', context, signal())
    expect(gloss).toHaveBeenCalledTimes(2)
    expect(provider.cacheSize()).toBe(1)
  })

  /**
   * ⚠️ **AND THE SAME OF THE PROMPT, WHICH IS THE CORRECTNESS REQUIREMENT AND
   * NOT A NICETY.**
   *
   * The key is the QUESTION, and the system prompt is a separate argument that
   * is not in it — so without the invalidation a reader who rewrites their
   * prompt is served back answers produced under the old one, silently, for as
   * long as the process lives. Watched AT THE PLUGIN, where a served answer and
   * a fresh one differ, and asserted on the ANSWER as well as on the call count:
   * the whole failure is that the reader reads the wrong words, and a count
   * alone would pass for a cache that made the request and then returned the
   * stale entry anyway.
   */
  it('does not serve an answer produced under a prompt the reader has since changed', async () => {
    let prompt = DEFAULT_GLOSS_PROMPT
    const gloss = vi.fn(async (_id: string, _model: string, system: string) =>
      system === DEFAULT_GLOSS_PROMPT ? 'Guarded; unwilling to share what he thought.' : 'Kept his thoughts to himself.',
    )
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller: asController({ textModel: () => 'qwen', start: async () => {} }),
      prompt: () => prompt,
      route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
    })

    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({
      text: 'Guarded; unwilling to share what he thought.',
    })
    /* The same word, the same sentence, the same model — everything the key is
       made of is unchanged, which is exactly why the key cannot save this. */
    prompt = 'Say what the word means here, in the plainest words you have.'
    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({
      text: 'Kept his thoughts to himself.',
    })
    expect(gloss).toHaveBeenCalledTimes(2)
    expect(gloss.mock.calls.map((call) => call[2])).toEqual([DEFAULT_GLOSS_PROMPT, prompt])
    /* DROPPED, not added to: the old prompt's answers are not facts either. */
    expect(provider.cacheSize()).toBe(1)

    /* And back again is a third request, not the first answer returning. */
    prompt = DEFAULT_GLOSS_PROMPT
    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({
      text: 'Guarded; unwilling to share what he thought.',
    })
    expect(gloss).toHaveBeenCalledTimes(3)
  })

  /* THE READER'S PROMPT IS WHAT IS SENT, which is the half the cache case above
     cannot fail on its own — a provider that ignored the getter entirely would
     still answer differently once the cache was cleared. */
  it('sends the reader’s prompt rather than the default', async () => {
    const theirs = 'Define the word in one sentence a nine-year-old would understand.'
    const gloss = vi.fn(async (_id: string, _model: string, _system: string) => 'Guarded.')
    const mine = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller: asController({ textModel: () => 'qwen', start: async () => {} }),
      prompt: () => theirs,
      route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
    })
    await mine.gloss('counsel', context, signal())
    expect(gloss.mock.calls[0]?.[2]).toBe(theirs)
  })

  /**
   * ⚠️ **TWO FACTS IN ONE STRING CAN SPELL EACH OTHER'S VALUES.** The token the
   * cache is labelled with carries the model and the prompt; concatenated
   * plain, a model `a` under a prompt `bc…` and a model `ab` under a prompt
   * `c…` produce the SAME token — two genuinely different pairs sharing one
   * cache, which is the exact failure the token exists to prevent, arriving
   * through the token itself. The length prefix is what makes it injective, and
   * this is the case that can tell the two spellings apart.
   */
  it('tells two model-and-prompt pairs apart when their letters run together', async () => {
    let model = 'a'
    let prompt = 'bc is what this prompt says.'
    const gloss = vi.fn(async () => 'Guarded.')
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller: asController({ textModel: () => model, start: async () => {} }),
      prompt: () => prompt,
      route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
    })
    await provider.gloss('counsel', context, signal())

    model = 'ab'
    prompt = 'c is what this prompt says.'
    expect(`${'a'}${'bc is what this prompt says.'}`, 'the fixture does not collide, so this measures nothing').toBe(
      `${model}${prompt}`,
    )
    await provider.gloss('counsel', context, signal())
    expect(gloss, 'one pair’s answer was served for another’s').toHaveBeenCalledTimes(2)
  })

  /**
   * ⚠️ **A PROMPT CHANGE OPENS THE SAME WINDOW A MODEL CHANGE DOES** — the case
   * the guard on the cache WRITE is for, one await too late rather than one too
   * early. A lookup started under the old prompt lands after a lookup under the
   * new one has cleared the cache, and its answer must not be written into a
   * cache now labelled with a prompt that did not produce it.
   */
  it('does not remember an answer produced under a prompt the cache no longer holds', async () => {
    let prompt = DEFAULT_GLOSS_PROMPT
    const landing = deferred()
    const gloss = vi.fn(async (_id: string, _model: string, system: string) => {
      if (system === DEFAULT_GLOSS_PROMPT) {
        await landing.promise
        return 'the old prompt’s answer'
      }
      return 'the new prompt’s answer'
    })
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller: asController({ textModel: () => 'qwen', start: async () => {} }),
      prompt: () => prompt,
      route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
    })

    const inFlight = provider.gloss('counsel', context, signal())
    prompt = 'Say what the word means here, in the plainest words you have.'
    await provider.gloss('other', { ...context, sentence: 'A different sentence.' }, signal())
    landing.open()
    /* STILL ANSWERED — the caller asked and is owed a reply; what must not
       happen is the answer being REMEMBERED under a prompt that did not make it. */
    await expect(inFlight).resolves.toEqual({ text: 'the old prompt’s answer' })
    expect(provider.cacheSize(), 'the old prompt’s answer was cached under the new one').toBe(1)
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
    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({ text: 'Guarded.' })
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
    const gloss = vi.fn().mockRejectedValue({ kind: 'runtimeMissing', message: 'llama-server absent' })
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
    const controller = asController({
      textModel: () => 'qwen',
      start: async () => {
        throw { kind: 'notReady', message: 'the runtime did not become ready within 30s' }
      },
    })
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller,
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
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
    /* STOPPED, NOT ABSENT: an absent runtime makes the local model no route at
       all (`usableLocal`), so the lookup would never reach the launch. What is
       measured here is a runtime that READ as present and then refused to
       launch for a reason the plugin names. */
    const real = createController({
      status: async () => ({ state: 'stopped' }),
      models: async () => [
        { id: 'qwen', label: 'Qwen', license: 'Apache-2.0', bytes: 1, installed: true },
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
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
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
      if (asked !== 'local:qwen') return 'llama says'
      await new Promise<void>((resolve) => {
        releaseQwen = resolve
      })
      return 'qwen says'
    })
    const controller = asController({
      textModel: () => model,
      start: async () => {},
    })
    const provider = createGlossProvider({
      plugin: { gloss, cancel: vi.fn() } as unknown as InferencePlugin,
      controller,
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
    })

    const inFlight = provider.gloss('counsel', context, signal())
    model = 'llama'
    await provider.gloss('other', { ...context, sentence: 'A different sentence.' }, signal())
    releaseQwen()

    /* The caller who asked still gets their answer — it is only not REMEMBERED
       for a model that did not produce it. */
    await expect(inFlight).resolves.toEqual({ text: 'qwen says' })
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
      controller: asController({ textModel: () => 'qwen', start: async () => {} }),
      report,
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
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
      controller: asController({ textModel: () => 'qwen', start: async () => {} }),
      report,
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
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
      controller: asController({ textModel: () => 'qwen', start: async () => {} }),
      report,
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
    })
    void provider

    await withReport.gloss('counsel', context, signal()).catch(() => {})

    expect(report).toHaveBeenCalledWith('inference.gloss-failed', {
      kind: 'runtimeHttp',
      /* THE ROUTE, since any route may answer: a log line naming a model says
         nothing about whether Claude or an endpoint was the one that failed. */
      route: 'local:qwen',
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
        controller: asController({ textModel: () => 'qwen', start: async () => {} }),
        report: () => {
          throw new Error('reporter broke')
        },
        prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
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
      controller: asController({ textModel: () => 'qwen', start: async () => {} }),
      report,
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
    })

    await provider.gloss('counsel', context, reader.signal).catch(() => {})
    expect(report.mock.calls).toEqual(
      reported ? [['inference.gloss-failed', { kind, route: 'local:qwen', message: 'the daemon said so' }]] : [],
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
      controller: asController({ textModel: () => 'qwen', start: () => launched.promise }),
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
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
      controller: asController({
        textModel: () => 'qwen',
        start: () => {
          reader.abort()
          return launched.promise
        },
      }),
      prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
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
        controller: asController({ textModel: () => 'qwen', start: async () => {} }),
        report: () => {
          throw new Error('reporter broke')
        },
        prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP,
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

  /* ── WI-15.13's ACCEPTANCE, AS THE OWNER REVISED IT ─────────────────────
   * It read "no selection can reach an agent". Since 2026-09-18 an agent MAY
   * answer a lookup — but through `inference_gloss`, as one request for one
   * definition in the portable shape, never through the companion's
   * conversational, streamed `agentAsk`. So an agent bound into the plugin
   * surface is still never called, even when an agent is what answers. */
  it('asks an agent through the gloss command, never through the companion’s agent turn', async () => {
    const agentAsk = vi.fn(async () => 'an agent answered')
    const { provider, gloss } = harness({ agentAsk: agentAsk as never }, null, {
      route: () => 'agent:claude',
      routes: probed([usable('agent:claude', 'Claude')]),
    })
    await provider.gloss('counsel', context, signal())
    await provider.gloss('another', { ...context, sentence: 'A different sentence entirely.' }, signal())
    expect(gloss.mock.calls.map((call) => call[1]), 'the agent was not the route that answered').toEqual(['agent:claude', 'agent:claude'])
    expect(agentAsk).not.toHaveBeenCalled()
  })

  /* ⚠️ NOT YET PROBED IS UNKNOWN, NOT "NOTHING" — see `unprobed`. A reader
     with only Claude set up presses Look up before the launch probe lands: the
     control is offered, and the lookup waits for a probe and then answers with
     the route it found, instead of being told there is nothing to answer with. */
  it('offers Look up before the first probe lands, and waits for it at the press', async () => {
    let routes: readonly Route[] | null = null
    const store = {
      getSnapshot: () => ({ routes, probing: routes === null }),
      refresh: vi.fn(async () => {
        routes = [usable('agent:claude', 'Claude')]
      }),
    }
    const { provider, gloss } = harness({}, null, { route: () => AUTOMATIC, routes: store })
    expect(provider.available, 'unknown must not read as unavailable').toBe(true)
    await provider.gloss('counsel', context, signal())
    expect(store.refresh).toHaveBeenCalledTimes(1)
    expect(gloss.mock.calls.map((call) => call[1])).toEqual(['agent:claude'])
  })

  /* And a probe that lands with NOTHING usable is a real no: the control goes,
     and a press that got through says so in the reader's words. */
  it('says so in words when the probe it waited for found nothing', async () => {
    let routes: readonly Route[] | null = null
    const store = {
      getSnapshot: () => ({ routes, probing: false }),
      refresh: vi.fn(async () => {
        routes = []
      }),
    }
    const { provider } = harness({}, null, { route: () => AUTOMATIC, routes: store })
    const cause = await provider.gloss('counsel', context, signal()).then(() => null, (thrown: unknown) => thrown)
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/Settings → Look up/u)
    expect(provider.available, 'a probe that found nothing is a real no').toBe(false)
  })
})

/**
 * WHICH ROUTE ANSWERS — the owner's decision of 2026-09-18, through the
 * provider rather than beside it.
 *
 * `glossRoute.test.ts` holds the RULE (`answeringRoute`) case by case; these
 * hold that the provider obeys it where it matters — the route that reaches
 * the plugin, whether a runtime is started for it, what the cache is labelled
 * with, and when a held probe is asked again. A rule the provider does not
 * consult is a rule nothing measures.
 */
describe('which route answers', () => {
  /** A controller whose launches are counted. */
  const counted = (model: string | null) => {
    const start = vi.fn(async () => {})
    return { start, controller: asController({ textModel: () => model, start }) }
  }
  const build = (
    controller: Controller,
    routing: { readonly route?: () => string; readonly routes?: ReturnType<typeof probed> } = {},
    gloss: ReturnType<typeof vi.fn> = vi.fn(async () => 'Guarded.'),
  ) => ({
    gloss,
    provider: createGlossProvider({
      plugin: { gloss, cancel: vi.fn(async () => {}) } as unknown as InferencePlugin,
      controller,
      prompt: PROMPT,
      route: routing.route ?? (() => AUTOMATIC),
      routes: routing.routes ?? probed([]),
      installAt: LOOK_UP,
    }),
  })

  it('sends the local model as the probe spells its route', async () => {
    const { provider, gloss } = harness()
    await provider.gloss('counsel', context, signal())
    expect(gloss.mock.calls.map((call) => call[1])).toEqual(['local:qwen'])
  })

  /* THE CASE THE DECISION WAS MADE FOR: a reader who never took the 2.5 GB
     download still has a Look up — and no daemon is started for it. */
  it('answers with an endpoint when no local model can, and starts no runtime for it', async () => {
    const { start, controller } = counted(null)
    const { provider, gloss } = build(controller, { routes: probed([usable('endpoint:groq', 'Groq')]) })

    expect(provider.available).toBe(true)
    provider.warm()
    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({ text: 'Guarded.' })
    expect(gloss.mock.calls.map((call) => call[1])).toEqual(['endpoint:groq'])
    expect(start, 'a runtime was started for a route that does not run here').not.toHaveBeenCalled()
  })

  it('answers with the reader’s choice when it can, over an installed local model', async () => {
    const { start, controller } = counted('qwen')
    const { provider, gloss } = build(controller, {
      route: () => 'agent:claude',
      routes: probed([usable('agent:codex'), usable('agent:claude')]),
    })

    provider.warm()
    await provider.gloss('counsel', context, signal())
    expect(gloss.mock.calls.map((call) => call[1])).toEqual(['agent:claude'])
    expect(start, 'the local model was warmed for a lookup Claude answers').not.toHaveBeenCalled()
  })

  /* WI-15.11's rule, the companion's first: a choice that cannot answer is
     not an error — Automatic answers, and the choice is kept for when it can. */
  it('answers as Automatic while the reader’s choice cannot, and goes back to it when it can', async () => {
    let claude = unusable('agent:claude')
    const routes = { getSnapshot: () => ({ routes: [claude], probing: false }), refresh: vi.fn(async () => {}) }
    const { provider, gloss } = build(asController({ textModel: () => 'qwen', start: async () => {} }), {
      route: () => 'agent:claude',
      routes,
    })

    await provider.gloss('counsel', context, signal())
    claude = usable('agent:claude')
    await provider.gloss('counsel', context, signal())
    expect(gloss.mock.calls.map((call) => call[1])).toEqual(['local:qwen', 'agent:claude'])
  })

  it('is unavailable when nothing anywhere can answer, and throws rather than guess', async () => {
    const { provider } = build(asController({ textModel: () => null, start: async () => {} }), {
      routes: probed([unusable('agent:claude'), unusable('endpoint:groq')]),
    })
    expect(provider.available).toBe(false)
    await expect(provider.gloss('counsel', context, signal())).rejects.toThrow(/Choose what answers in Settings → Look up/u)
  })

  /* ⚠️ **ANOTHER ROUTE'S ANSWER IS NOT THIS ROUTE'S.** The cache is labelled
     with the route, so a reader who switches from the local model to Claude is
     asked again rather than served what the local model said. */
  it('asks again after the route changes, rather than serving another route’s answer', async () => {
    let route = AUTOMATIC
    const gloss = vi.fn(async (_id: string, asked: string) => `${asked} says`)
    const { provider } = build(
      asController({ textModel: () => 'qwen', start: async () => {} }),
      { route: () => route, routes: probed([usable('agent:claude')]) },
      gloss,
    )

    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({ text: 'local:qwen says' })
    route = 'agent:claude'
    await expect(provider.gloss('counsel', context, signal())).resolves.toEqual({ text: 'agent:claude says' })
    expect(gloss).toHaveBeenCalledTimes(2)
    expect(provider.cacheSize(), 'the other route’s answers were kept beside this one’s').toBe(1)
  })

  /* A PROBE THAT WAS WRONG IS ASKED AGAIN — and only one that was. Every probe
     spawns the agent CLIs, so a failure the probe cannot see (an endpoint that
     answered no, a runtime that stopped) must not cost one. */
  it.each([
    ['modelUnknown', true],
    ['agentSignedOut', true],
    ['agentMissing', true],
    ['agentUnsupportedVersion', true],
    ['keychain', true],
    ['endpointHttp', false],
    ['endpointUnreachable', false],
    ['runtimeExited', false],
    ['agentMalformed', false],
  ])('after %s, asks for a fresh probe: %s', async (kind, asked) => {
    const routes = probed([usable('agent:claude')])
    const { provider } = build(
      asController({ textModel: () => null, start: async () => {} }),
      { routes },
      vi.fn().mockRejectedValue({ kind, message: 'the route said so' }),
    )
    await provider.gloss('counsel', context, signal()).catch(() => {})
    expect(routes.refresh).toHaveBeenCalledTimes(asked ? 1 : 0)
  })

  /* A REJECTION THAT IS NOT THE PLUGIN'S names no kind, and asks for nothing. */
  it('asks for no probe after a failure that is not the plugin’s', async () => {
    const routes = probed([usable('agent:claude')])
    const { provider } = build(asController({ textModel: () => null, start: async () => {} }), { routes }, vi.fn().mockRejectedValue('Command inference_gloss not found'))
    await provider.gloss('counsel', context, signal()).catch(() => {})
    expect(routes.refresh).not.toHaveBeenCalled()
  })

  /* READ PER CALL: a probe that lands after the provider was built is the one a
     lookup is decided by — the start probe is exactly that. */
  it('reads the probe per lookup, so one that lands after it was built counts', () => {
    let routes: readonly Route[] = []
    const { provider } = build(asController({ textModel: () => null, start: async () => {} }), {
      routes: { getSnapshot: () => ({ routes, probing: false }), refresh: vi.fn(async () => {}) },
    })
    expect(provider.available).toBe(false)
    routes = [usable('agent:codex')]
    expect(provider.available).toBe(true)
  })

  /* A PROBE NOT YET ANSWERED is no routes, not an error: the local model still
     answers, read from the controller. */
  it('answers with the local model before any probe has answered', async () => {
    const { provider, gloss } = build(asController({ textModel: () => 'qwen', start: async () => {} }), {
      routes: { getSnapshot: () => ({ routes: null, probing: true }), refresh: vi.fn(async () => {}) },
    })
    expect(provider.available).toBe(true)
    await provider.gloss('counsel', context, signal())
    expect(gloss.mock.calls.map((call) => call[1])).toEqual(['local:qwen'])
  })
})

/**
 * `installAt` IS THE LOOK UP SECTION, WHATEVER THE RUNTIME.
 *
 * It followed the runtime — WI-20.21: with the runtime absent, "Install one"
 * took a 2.5 GB download into nothing, and every lookup then failed with "The
 * runtime is not installed". That rule was right while the local model was the
 * only thing that could answer. Since 2026-09-18 an endpoint or a signed-in CLI
 * can answer with no runtime at all, so there is always something to do in the
 * section where the choice is — and the offer reads "Choose one".
 *
 * AND IT SAYS WHERE, since phase 17's L3: the offer used to open Settings at the
 * top, with the section collapsed further down, because a boolean could not say
 * which section it meant.
 */
describe('installAt', () => {
  const withRuntime = (kind: 'absent' | 'installed' | 'ready') => {
    const runtime = kind === 'absent' ? { kind, reason: 'x' } : kind === 'ready' ? { kind, version: '1' } : { kind }
    const controller = asController({
      textModel: () => null,
      start: async () => {},
      getSnapshot: () => ({ runtime, models: [] }),
    })
    return createGlossProvider({ plugin: {} as InferencePlugin, controller, prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP })
  }

  it('is the section it was handed, with a runtime or without one', () => {
    for (const kind of ['absent', 'installed', 'ready'] as const) expect(withRuntime(kind).installAt, kind).toBe(LOOK_UP)
  })

  /* NON-VACUITY: nothing can answer in any of those states, so the offer is
     what the reader is shown rather than a definition. */
  it('is offered while nothing can answer', () => {
    expect(withRuntime('absent').available).toBe(false)
    expect(withRuntime('ready').available).toBe(false)
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

/*
 * ⚠️ **THE FIRST LOOKUP OF A SESSION PAID FOR THE RUNTIME.** `gloss` races
 * `controller.start()` against the reader's abort precisely because that start
 * "can take seconds" — a process bound, accelerators probed, a model loaded —
 * and every lookup after it is quick, because the daemon is shared. So the
 * reader met one slow lookup and then a fast feature, with nothing saying why.
 * `warm` moves that cost off the first ask; see `GlossProvider.warm`.
 */
describe('getting the runtime ready before anything is asked of it', () => {
  it('starts the runtime, without asking it anything', async () => {
    let started = 0
    const controller = asController({
      textModel: () => 'qwen',
      start: async () => {
        started += 1
      },
    })
    const plugin = { gloss: vi.fn(), cancel: vi.fn(async () => {}) } as unknown as InferencePlugin

    createGlossProvider({ plugin, controller, prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP }).warm()
    await Promise.resolve()

    expect(started).toBe(1)
    /* And nothing was generated: warming is not a question. */
    expect(plugin.gloss).not.toHaveBeenCalled()
  })

  /* A build with no model has nothing to start, and starting a daemon that
     cannot answer would spend a reader's battery on a selection. */
  it('starts nothing when no model is installed', async () => {
    let started = 0
    const controller = asController({
      textModel: () => null,
      start: async () => {
        started += 1
      },
    })
    const plugin = { gloss: vi.fn(), cancel: vi.fn(async () => {}) } as unknown as InferencePlugin

    createGlossProvider({ plugin, controller, prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP }).warm()
    await Promise.resolve()

    expect(started).toBe(0)
  })

  /* ⚠️ **ONLY FOR THE LOCAL MODEL.** An agent or an endpoint answers without the
     daemon, and warming it anyway would load a 2.5 GB model the reader chose
     not to use every time they selected a word. */
  it('starts nothing when the route that would answer is not the local model', async () => {
    let started = 0
    const controller = asController({
      textModel: () => 'qwen',
      start: async () => {
        started += 1
      },
    })
    createGlossProvider({
      plugin: { gloss: vi.fn(), cancel: vi.fn(async () => {}) } as unknown as InferencePlugin,
      controller,
      prompt: PROMPT,
      route: () => 'endpoint:groq',
      routes: probed([usable('endpoint:groq')]),
      installAt: LOOK_UP,
    }).warm()
    await Promise.resolve()

    expect(started).toBe(0)
  })

  /* ⚠️ **AND IT HAS NOBODY TO TELL.** The reader has selected a word and asked
     for nothing, so a failure here must not reach them — the real `gloss` takes
     the same road and reports its own failure in their words. A rejection that
     escaped would be an unhandled rejection in a React effect. */
  it('says nothing and throws nothing when the runtime will not start', async () => {
    const controller = asController({
      textModel: () => 'qwen',
      start: async () => {
        throw new Error('the runtime is not installed')
      },
    })
    const plugin = { gloss: vi.fn(), cancel: vi.fn(async () => {}) } as unknown as InferencePlugin

    const provider = createGlossProvider({ plugin, controller, prompt: PROMPT, route: () => AUTOMATIC, routes: probed([]), installAt: LOOK_UP })

    expect(() => provider.warm()).not.toThrow()
    await expect(Promise.resolve()).resolves.toBeUndefined()
  })
})

/**
 * ⚠️ **A MEANING THAT OPENS BY RESTATING ITS HEADWORD**, which the popup already
 * draws above it. Measured 2026-09-18 on the live model, 3 terms × 3 languages ×
 * 3 runs: 3–5 of 27 replies did it, identically through lemond and through the
 * bare `llama-server`, and ALWAYS in a shape the prompt forbids — a Chinese
 * answer written dictionary-style (`透明的，指…`) and the English after it
 * copying the shape (`transparent, meaning…`). A Chinese example added to the
 * prompt did not help (5 of 27), and the prompt is the READER'S to edit now, so
 * a fix that lived in it would last until somebody customised it.
 *
 * So the redundant opening is taken off in the parse, where it holds whatever
 * the prompt says — the argument that moved the answer's FORMAT into a schema.
 * CONSERVATIVE BY CONSTRUCTION: only the two explicit echo shapes are
 * recognised, and anything else comes back exactly as the model wrote it.
 */
describe('a meaning that restates its headword', () => {
  /* Every one of these is a reply the live model wrote on 2026-09-18. */
  it.each([
    ['transparent', '透明的，指系统运作清晰可见，没有隐藏或复杂的部分', '系统运作清晰可见，没有隐藏或复杂的部分'],
    ['transparent', 'transparent, meaning clearly visible and free from hidden or complex elements', 'Clearly visible and free from hidden or complex elements'],
    ['upending', 'To upend means to completely overturn or disrupt, often in a way that makes the previous system or structure no longer functional or effective.', 'To completely overturn or disrupt, often in a way that makes the previous system or structure no longer functional or effective.'],
    ['upending', '颠覆意味着彻底推翻或破坏，常常使先前的系统或结构不再有效或运作。', '彻底推翻或破坏，常常使先前的系统或结构不再有效或运作。'],
    ['upending', '彻底颠覆，指完全推翻并取代原有的结构或体系，使其被新的系统所替代。', '完全推翻并取代原有的结构或体系，使其被新的系统所替代。'],
    ['transparent', 'Transparent means clear and open, allowing everyone to see and understand the system.', 'Clear and open, allowing everyone to see and understand the system.'],
    ['quarter', 'A quarter is a three-month period in a year.', 'A three-month period in a year.'],
  ])('takes %s off the front of %s', (term, text, expected) => {
    expect(withoutHeadword(text, term)).toBe(expected)
  })

  /* The live model's OTHER replies, which open with the meaning — and one
     (`颠覆，使…`) that is echo-like but not one of the two shapes, left alone on
     purpose: the rule removes what it can recognise with certainty and nothing
     it would have to guess at. */
  it.each([
    ['quarter', 'A three-month period in a year, often used in business or financial reporting to track performance.'],
    ['upending', 'To bring into disarray or cause to collapse, especially by replacing or overturning a previous system or structure.'],
    ['transparent', 'Easy to understand and see, with no hidden parts or unclear elements'],
    ['quarter', '三个月为一个季度'],
    ['quarter', '一年中的三个月时期，常用于追踪业绩。'],
    ['upending', '颠覆，使原有状态被打破'],
    ['transparent', '容易理解且清晰可见，没有隐藏的部分或模糊的元素'],
    // The term used as an ordinary word later on is not an opening.
    ['transparent', 'Clear enough that transparent means nothing is hidden'],
    // A different word before the connector is not the headword.
    ['quarter', 'This means a three-month period'],
  ])('leaves an answer about %s that opens with its meaning alone: %s', (term, text) => {
    expect(withoutHeadword(text, term)).toBe(text)
  })

  /* NEVER LESS THAN SOMETHING: an answer that is nothing BUT the echo keeps it,
     for `core/gloss.ts`'s reason — an empty amber mark reads as "this word means
     nothing". */
  it('keeps an answer that would be empty without its opening', () => {
    expect(withoutHeadword('transparent means', 'transparent')).toBe('transparent means')
    expect(withoutHeadword('透明，指', 'transparent')).toBe('透明，指')
  })

  it('applies to every language of a two-language answer, in the parse', () => {
    const raw = JSON.stringify({
      definition: {
        first: { language: 'Simplified Chinese', text: '透明的，指系统运作清晰可见' },
        second: { language: 'English', text: 'transparent, meaning clearly visible' },
      },
      partOfSpeech: 'adjective',
    })
    expect(definitionOf(raw, 'transparent')).toStrictEqual({
      text: '系统运作清晰可见\nClearly visible',
      partOfSpeech: 'adjective',
    })
  })
})
