import type { GlossContext, GlossProvider } from '../../../kernel'
import type { Controller } from './controller'
import { mintRequestId, type InferencePlugin } from './plugin'

/**
 * The gloss provider — bound by `inference`, and by nothing else.
 *
 * ⚠️ **NO CODE PATH FROM HERE REACHES AN AGENT.** This file imports the
 * plugin's `gloss` command and the controller, and neither can reach
 * `agentAsk`. That is the enforcement F8 asks for: an agent would open a
 * session and start a turn to define one word — seconds, and a subscription
 * turn spent, for a gesture a reader makes dozens of times a chapter.
 *
 * # The cache, and why it is keyed the way it is
 *
 * A reader re-reading a chapter looks the same word up twice, and the second
 * time should cost nothing. The key is the term AND the sentence, because the
 * whole point of the feature is the sense that is on this page — the same
 * word in two sentences is two different glosses and must not share an entry.
 *
 * It is dropped when the model changes, because **a gloss is an answer from a
 * particular model and not a fact**. Keeping it across a model swap would
 * show a reader Qwen's answer under a label that says something else.
 */

/**
 * How many glosses to remember.
 *
 * A chapter's worth of lookups, not a session's: these are short strings, but
 * the sentence is part of every key, so the entries are not free. Oldest out
 * first — a reader moving through a book does not return to chapter one's
 * vocabulary.
 */
const CACHE_LIMIT = 200

/**
 * What the model is told. Short, and every line of it is load-bearing.
 *
 * `Do not repeat the word` is there because `DCSCopyTextDefinition`'s doubled
 * headword is the exact failure this feature was written to avoid, and a
 * model asked to define a word will lead with it by default. `one or two
 * sentences` bounds it to what a popover can hold. `the sense used here` is
 * the feature: a dictionary gives every sense of *close*, and this gives the
 * one on the page.
 */
export const GLOSS_SYSTEM_PROMPT = [
  'You define a word or phrase as it is used in one specific sentence from a book.',
  'Answer in one or two sentences, plain prose, no formatting and no quotation marks.',
  'Give only the sense used here, not every sense the word has.',
  'Do not repeat the word as a headword and do not restate the sentence.',
  'If the sentence does not make the sense clear, say so plainly in one sentence.',
].join(' ')

/** The user turn: the sentence, then the term. */
export function glossQuestion(term: string, context: GlossContext): string {
  return [
    `Book: ${context.bookTitle}`,
    `Sentence: ${context.sentence}`,
    `Define, in this sentence: ${term}`,
  ].join('\n')
}

/**
 * A cache key. The term and the sentence, normalised for whitespace and case
 * so that a selection differing only in a line break is a hit rather than a
 * second request.
 */
export function glossKey(term: string, context: GlossContext): string {
  const flatten = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()
  return `${flatten(term)}\u0000${flatten(context.sentence)}`
}

export interface GlossProviderOptions {
  readonly plugin: InferencePlugin
  readonly controller: Controller
}

export interface BoundGlossProvider extends GlossProvider {
  /** Drop the cache — the model changed, so the answers are another model's. */
  clearCache(): void
  /** How many entries are held. For a test and a diagnostic. */
  cacheSize(): number
}

export function createGlossProvider({ plugin, controller }: GlossProviderOptions): BoundGlossProvider {
  /* A Map, for insertion order: JavaScript's Map iterates oldest-first, which
   * is the eviction order this wants and costs no bookkeeping. */
  const cache = new Map<string, string>()
  let cachedFor: string | null = null

  return {
    /* Resolved per call rather than captured: a reader who installs a model
     * while the pane is open must get a working Look up without a restart. */
    get available(): boolean {
      return controller.textModel() !== null
    },

    async gloss(term: string, context: GlossContext, signal: AbortSignal): Promise<string> {
      const model = controller.textModel()
      if (model === null) {
        throw new Error('No gloss provider is bound. Check `available` before calling gloss().')
      }
      /* THE MODEL CHANGED. Everything remembered was another model's answer,
       * and a gloss is not a fact. */
      if (cachedFor !== model) {
        cache.clear()
        cachedFor = model
      }

      const key = glossKey(term, context)
      const hit = cache.get(key)
      if (hit !== undefined) return hit

      /* THE READINESS WAIT RACES THE ABORT. A cold start can take seconds —
       * the daemon binds, probes accelerators, loads a model — and a reader
       * who selected a word and moved on would otherwise be held for the full
       * startup before their abort was noticed. Found by audit. */
      const ready = await Promise.race([
        controller.ensureReady(),
        new Promise<'aborted'>((resolve) => {
          if (signal.aborted) resolve('aborted')
          else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
        }),
      ])
      if (ready === 'aborted' || signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      if (!ready) throw new Error('The runtime is not running')

      const requestId = mintRequestId('gloss')
      const abort = (): void => void plugin.cancel(requestId).catch(() => {})
      signal.addEventListener('abort', abort, { once: true })
      try {
        const answer = (
          await plugin.gloss(requestId, model, GLOSS_SYSTEM_PROMPT, glossQuestion(term, context))
        ).trim()
        /* An empty answer is NOT cached and NOT returned as a definition: an
         * empty amber mark beside a word reads as "this word means nothing". */
        if (answer === '') throw new Error('The model returned nothing')
        cache.set(key, answer)
        while (cache.size > CACHE_LIMIT) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        return answer
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },

    clearCache: () => {
      cache.clear()
      cachedFor = null
    },
    cacheSize: () => cache.size,
  }
}
