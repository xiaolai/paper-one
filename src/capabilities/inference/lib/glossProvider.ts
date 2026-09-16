import { messageOf } from '../../../kernel'
import type { GlossContext, GlossProvider } from '../../../kernel'
import { readerFailure, type Controller, type ReportFailure } from './controller'
import { cancelRequest, errorKind, mintRequestId, type InferencePlugin } from './plugin'

/**
 * The gloss provider — bound by `inference`, and by nothing else.
 *
 * ⚠️ **NO CODE PATH FROM HERE REACHES AN AGENT.** It is handed two of the
 * plugin's commands — `gloss`, and `cancel` to abandon one — and the
 * controller, and none of the three can reach `agentAsk`. That is the
 * enforcement F8 asks for: an agent would open a session and start a turn to
 * define one word — seconds, and a subscription turn spent, for a gesture a
 * reader makes dozens of times a chapter.
 *
 * (This said the file imported the `gloss` command while the option it read
 * was the WHOLE plugin, `agentAsk` included — an enforcement held by habit and
 * not by the type. `GlossProviderOptions.plugin` names the two now; corrected
 * 2026-09-13, by audit.)
 *
 * # The cache, and why it is keyed the way it is
 *
 * A reader re-reading a chapter looks the same word up twice, and the second
 * time should cost nothing. The key is THE QUESTION — the exact string the
 * model is sent — because the whole point of the feature is the sense that is
 * on this page: the same word in two sentences is two different glosses and
 * must not share an entry. A key computed beside the request rather than being
 * it is how two different questions came to share one; see `glossQuestion`.
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
 * `one or two sentences` bounds it to what a popover can hold. `the sense used
 * here` is the feature: a dictionary gives every sense of *close*, and this
 * gives the one on the page.
 *
 * ⚠️ **"DO NOT REPEAT THE WORD" DID NOT WORK, AND IT WAS MEASURED NOT WORKING.**
 * `DCSCopyTextDefinition`'s doubled headword is the failure this feature was
 * written to avoid, and a model asked to define a word leads with it by
 * default. The prohibition was here from the start and the answers still opened
 * `wharves are the docks…` and `in this context, los wharves son…`; a stronger
 * prohibition fared no better. What worked — seven of seven, on 2026-09-13 — is
 * showing the SHAPE of a good opening instead of naming the bad one
 * (`dev-docs/plans/evidence/wi-17-5-answer-languages.md`). The example uses
 * `wharves`, and answers about other words did not echo it.
 *
 * The language line is WI-17.5's, and it is the SYSTEM prompt's rather than
 * the question's only in its wording: which language to use is a line in the
 * question, where the cache key sees it — see `glossQuestion`.
 */
export const GLOSS_SYSTEM_PROMPT = [
  'You define a word or phrase as it is used in one specific sentence from a book.',
  'Answer in one or two sentences, plain prose, no formatting and no quotation marks.',
  'Give only the sense used here, not every sense the word has.',
  'Start straight with the meaning, the way a dictionary entry does: for wharves, begin with something like "Structures along a shore where ships dock", never "Wharves are" and never "In this sentence".',
  'Do not restate the sentence.',
  'If the sentence does not make the sense clear, say so plainly in one sentence.',
  'Write the answer in the language the request names. When it names two languages, write one sentence in each, the first language first, each on its own line.',
].join(' ')

/**
 * Whitespace collapsed to single spaces, and the edges trimmed.
 *
 * APPLIED TO WHAT IS SENT, not to a copy of it kept for the cache — which is
 * the whole of the fix below. A selection differing only in a line break is
 * genuinely the same question, so it should be normalised once, on the way to
 * the model, and the key falls out of that rather than being computed beside it.
 *
 * It also makes `glossQuestion` INJECTIVE, which the key depends on: no field
 * can contain a newline afterwards, so the three-line question cannot be
 * confused with a different one whose title happened to contain
 * `\nSentence: `.
 */
function squeezed(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * The user turn: the sentence, then the term.
 *
 * ⚠️ **THIS IS ALSO THE CACHE KEY**, and that is a correctness property rather
 * than a saving. There used to be a separate `glossKey`, and a key computed
 * beside a request can disagree with it — this one did, in two directions:
 *
 * - **It LOWERCASED the term and the sentence.** The question does not, so
 *   `March` and `march` in one sentence are two different questions with one
 *   cache entry: select the verb after the month and you were served the
 *   month's definition. `Polish`/`polish`, `Bank`/`bank`, and every proper noun
 *   that is also a common word have the same shape.
 * - **It normalised whitespace the request did not.** Two windows differing
 *   only in a line break were one entry AND two different questions, so which
 *   one the model saw depended on which was asked first.
 *
 * A cache is only correct when its key is its request. So there is one string
 * now and it is both: two identical questions share an answer, and nothing else
 * does. That also settles the audit's "two books with the same title collide" —
 * same title, same sentence, same term IS the same question, and serving one
 * answer for it is the cache working rather than a collision. The book's
 * identity is deliberately not in it: the model never sees an id, so an id
 * could only ever split entries that ought to be shared.
 *
 * ⚠️ **THE ANSWER LANGUAGE IS A LINE OF IT, AND THAT IS THE WHOLE OF WI-17.5's
 * CACHE REQUIREMENT.** A key without it would serve every word already looked
 * up back in the old language after the reader switched, silently, for as long
 * as the process lived — the same class of error as serving another model's
 * answer, which the cache already refuses. In the question, the key has it by
 * construction and there is nothing separate to remember. The names are
 * English because the model is told in English; the order is the order asked.
 */
export function glossQuestion(term: string, context: GlossContext): string {
  return [
    `Book: ${squeezed(context.bookTitle)}`,
    `Sentence: ${squeezed(context.sentence)}`,
    `Answer in: ${context.answerIn.map((one) => squeezed(one.name)).join(', then ')}`,
    `Define, in this sentence: ${squeezed(term)}`,
  ].join('\n')
}

export interface GlossProviderOptions {
  /** The two commands a gloss uses, and no others — see the header on `agentAsk`. */
  readonly plugin: Pick<InferencePlugin, 'gloss' | 'cancel'>
  readonly controller: Controller
  /** Told when a cancel fails for a reason that is not the expected race. */
  readonly report?: ReportFailure | undefined
  /**
   * The settings section a model is installed from — `inference:models`,
   * handed in by the capability that declares it, so the id is written once.
   */
  readonly installAt: string
}

export interface BoundGlossProvider extends GlossProvider {
  /**
   * How many entries are held. For a test and a diagnostic.
   *
   * ⚠️ **`clearCache()` STOOD BESIDE THIS AND NOTHING CALLED IT.** Its comment
   * said "drop the cache — the model changed", which is a job `gloss` does for
   * itself against `cachedFor` on the way in; the method was a second way to do
   * it that no composition root, no teardown and no pane ever reached, kept
   * alive by one test asserting that it worked. A public method with one test
   * and no caller is not a spare handle, it is a second answer waiting to
   * disagree with the first.
   */
  cacheSize(): number
}

export function createGlossProvider({ plugin, controller, report: reportTo, installAt }: GlossProviderOptions): BoundGlossProvider {
  /* A Map, for insertion order: JavaScript's Map iterates oldest-first, which
   * is the eviction order this wants and costs no bookkeeping. */
  const cache = new Map<string, string>()
  let cachedFor: string | null = null

  /* ⚠️ **A REPORTER THAT CANNOT REPLACE WHAT IT REPORTS.** It is called from two
   * places that cannot survive it throwing: the lookup's rejection handler,
   * where the throw BECAME the rejection — the reader was told the reporter's
   * error instead of the runtime's — and `cancelRequest`'s, which nothing
   * awaits, where it escaped as an unhandled rejection. `controller.ts` and the
   * companion's `provider.ts` each guard theirs for the same reason (2026-09-13
   * audit). */
  const report: ReportFailure = (event, fields) => {
    try {
      reportTo?.(event, fields)
    } catch (thrown) {
      console.error('inference gloss: the failure reporter itself threw', thrown, 'while reporting', event)
    }
  }

  /* ONE READING OF "IS THERE A RUNTIME", for both getters below — they are the
     two halves of one decision (`decideLookUp`), and two spellings of it are
     how they came to disagree. */
  const hasRuntime = (): boolean => controller.getSnapshot().runtime.kind !== 'absent'

  return {
    /* Resolved per call rather than captured: a reader who installs a model
     * while the pane is open must get a working Look up without a restart.
     *
     * ⚠️ **AND A MODEL IS NOT ENOUGH.** This read the model alone, so with one
     * on disk and the runtime absent it answered yes while `installAt` answered
     * "nowhere" — one snapshot, two readings — and Look up drew a live control
     * whose every press failed at the launch (2026-09-13 audit). */
    get available(): boolean {
      return controller.textModel() !== null && hasRuntime()
    },

    /**
     * THE MODELS SECTION WHILE THERE IS A RUNTIME TO INSTALL A MODEL INTO,
     * and `null` while there is not.
     *
     * ⚠️ **THIS WAS THE CONSTANT `true`**, on the argument that `inference`
     * composing is exactly what puts the Local models section in Settings —
     * `start()` never fails on absence (F2) — so there was "no state in which
     * this provider is bound and the reader has nowhere to install a model".
     * There is one, and WI-20.21 measured what it cost: with the runtime
     * absent, Look up offered "Install one", the pane took the download, 2.5 GB
     * landed, and every lookup then failed with "The runtime is not
     * installed". Somewhere to send the reader is only worth sending them if
     * something can be done there.
     *
     * So this follows the runtime, read per call like `available` — and with
     * it null the reader UI draws no Look up control at all, because
     * `available` reads the same runtime and is false with it. That is the
     * same answer a browser or a phone gets (`decideLookUp` → `none`), and the
     * honest one: nothing the reader can do from here changes it. A build that
     * did not compose `inference` keeps the port's `NO_GLOSS` default, where
     * the field is `null` for the other reason. See `GlossProvider.installAt`.
     */
    get installAt(): string | null {
      return hasRuntime() ? installAt : null
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

      /* Cancelled is cancelled, cached or not: a lookup the reader abandoned
         used to succeed from the cache and reject from the model, so what
         `useGloss` saw depended on whether the word had been asked before. */
      signal.throwIfAborted()
      /* THE REQUEST IS THE KEY — see `glossQuestion`. Built once and used for
       * both, so there is no second expression that could normalise
       * differently from the one that reaches the model. */
      const question = glossQuestion(term, context)
      const hit = cache.get(question)
      if (hit !== undefined) return hit

      /* THE READINESS WAIT RACES THE ABORT. A cold start can take seconds —
       * the daemon binds, probes accelerators, loads a model — and a reader
       * who selected a word and moved on would otherwise be held for the full
       * startup before their abort was noticed. Found by audit. */
      /* ⚠️ THE LISTENER IS NAMED AND REMOVED, and it used to be neither. An
       * anonymous `() => resolve('aborted')` was attached with `{ once: true }`
       * — which fires once, but is only REMOVED by firing. When
       * `ensureReady()` won the race, as it does on every ordinary lookup, the
       * listener stayed attached to the caller's signal for its whole life.
       * `useGloss` mints a fresh `AbortController` per ask so the signal dies
       * quickly and the leak is bounded there; a caller that reuses one
       * accumulates a listener per lookup. Found by audit. */
      /* ⚠️ **`start()`, NOT `ensureReady()` — AND THE DIFFERENCE IS WHAT THE
       * READER IS TOLD.** The boolean collapsed every way a launch can fail
       * into one, so the line below said "The runtime is not running" about a
       * runtime that was never INSTALLED, while the controller one call away
       * had already computed that exact sentence from the plugin's `kind` and
       * had nowhere to put it. The cause now arrives here and goes through the
       * same `readerFailure` the plugin's own rejections do (2026-09-13 audit,
       * round 2). The controller reports it; this only speaks. */
      let wake!: (launch: null) => void
      const woken = new Promise<null>((resolve) => {
        wake = resolve
      })
      const onAbort = (): void => wake(null)
      /* ATTACHED BEFORE THE LAUNCH IS ASKED FOR, so an abort that `start()`
         itself sets off — it runs synchronously up to its first await — is
         heard like any other, with no second test for a signal that was
         already aborted when the wait began. */
      signal.addEventListener('abort', onAbort)
      let launch: { readonly cause: unknown } | null
      try {
        launch = await Promise.race([
          /* CARRIED, NOT THROWN. A rejection would win the race outright and
             talk about a runtime the reader no longer needs — the abort below
             has to be able to win a tie. */
          controller.start().then(
            () => null,
            (cause: unknown) => ({ cause }),
          ),
          woken,
        ])
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      /* ⚠️ **THE SIGNAL SAYS WHETHER THE READER LEFT, NOT WHICH SIDE WON.** An
         abort landing as the launch settled leaves the launch's answer in hand
         and the reader gone. This read `ready === 'aborted' || signal.aborted`:
         two readings of one fact, the first never true without the second, so
         the label decided nothing the signal did not (2026-09-14, mutation
         sweep). The race now only WAKES the wait. */
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      if (launch !== null) throw readerFailure(launch.cause, signal)

      const requestId = mintRequestId('gloss')
      /* One cancel, one place — see `cancelRequest`. This and
       * `inferencePort`'s `withCancel` both swallowed every failure, and
       * fixing one copy is how the other stayed broken. */
      const abort = (): void => cancelRequest(plugin, requestId, report)
      /* No `{ once: true }`: the `finally` below removes it however the call
         ends, and a signal aborts once, so the option could change nothing. */
      signal.addEventListener('abort', abort)
      try {
        const answer = (
          await plugin
            .gloss(requestId, model, GLOSS_SYSTEM_PROMPT, question)
            .catch((cause: unknown) => {
              /* ⚠️ **THE READER READS THIS, AND THEY USED TO READ NOTHING.**
               *
               * A rejection from the plugin is `{ kind, message }` — a plain
               * object, serialised by the crate's `error.rs`, NOT an `Error`.
               * `useGloss` turns a rejection into the reason `LookUpFace` draws with
               * `error instanceof Error ? error.message : 'No reason was
               * given.'`, so every plugin-side failure took the second branch:
               * the runtime not installed, not started, stopped, unreachable,
               * a model that would not resolve, a request already in flight —
               * all of them reached the reader as **No reason was given.**
               *
               * `detailFor` is the map from `kind` to a sentence in §11's
               * voice, and it has existed since WI-15.4. The gloss path could
               * not use it: `useGloss` is the KERNEL's and `detailFor` is this
               * capability's, and the kernel imports nothing from a
               * capability. So the translation belongs HERE, on the far side
               * of the port, which is the only place that has both.
               *
               * It mattered less when Dictionary.app sat behind a failed
               * gloss. Nothing sits behind it now.
               *
               * ⚠️ **ONLY THE PLUGIN'S OWN REJECTIONS CARRY A `kind`**, and the
               * three branches below are three different failures that an
               * audit found collapsed into one. `detailFor` maps only a
               * `kind`; everything else needs handling here, and the case
               * this whole translation was written for was in the half that
               * did not have any.
               *
               * ⚠️ **A BARE STRING WAS STILL REACHING THE READER AS NOTHING.**
               * Tauri rejects an unknown command with a plain STRING, not an
               * `Error` — `Command inference_gloss not found` — and the first
               * version of this rethrew any no-`kind` cause untouched, so
               * `useGloss`'s `error instanceof Error` was false and the reader
               * got **No reason was given.** exactly as before. That is the
               * failure this fix names in its own commit message, and the test
               * missed it by constructing an `Error`, which is the one shape
               * the real boundary never produces. A non-`Error` cause is
               * wrapped, preserving its text; a real `Error` is passed through
               * with its own message intact.
               *
               * ⚠️ **THE BRANCHES THEMSELVES ARE `readerFailure` NOW**, beside
               * `detailFor` where the sentences are. The companion's `failure`
               * was written as this catch "branch for branch" and nothing held
               * it to that: its last branch was `String(cause)`, so the same
               * rejection object told a reader looking up a word what happened
               * and a reader asking a question `[object Object]` (2026-09-13
               * audit, round 2). What stays here is the REPORT, because the two
               * disagree about it on purpose — see `readerFailure`.
               */
              const kind = errorKind(cause)

              /* ⚠️ **THE MAINTAINER'S HALF, WHICH DID NOT EXIST.** Everything
               * below decides what the READER is told, and every branch of it
               * throws away the only text that says what actually happened.
               * `RuntimeHttp` is the case that proves it: the variant carries a
               * status precisely so somebody can act on it — `error.rs` says
               * "deliberately carries a status and a route" — and it renders as
               * `the inference runtime answered 404 for /api/v1/chat/completions`.
               * `detailFor` maps it to "The runtime refused the request", which
               * is the right sentence for a reader and names neither the status
               * nor the route.
               *
               * So a failing gloss left NOTHING anywhere: not the status, not
               * the route, not the model. `controller.ts`'s `ReportFailure`
               * records the same lesson from the prefix bug — "the message this
               * reports is the maintainer's half, which is the sentence that
               * would have ended the search in a minute" — and the gloss path
               * simply had no such hook until now.
               *
               * Reported for every failure but the reader's OWN abort — a
               * cancellation nobody asked for is worth seeing in a log; one the
               * reader made by moving on is every selection change, and a
               * log full of those buries the failures. */
              if (!(kind === 'cancelled' && signal.aborted)) {
                report('inference.gloss-failed', { kind, model, message: messageOf(cause) })
              }

              /* THE READER'S OWN ABORT is passed through as itself, and only
               * when it really was one; everything else becomes the sentence
               * for its `kind`, or a readable `Error` when it has none. All
               * four branches are `readerFailure`. */
              throw readerFailure(cause, signal)
            })
        ).trim()
        /* An empty answer is NOT cached and NOT returned as a definition: an
         * empty amber mark beside a word reads as "this word means nothing". */
        if (answer === '') throw new Error('The model returned nothing')
        /* ⚠️ **ONLY IF THE CACHE IS STILL THIS MODEL'S.** Two lookups can be in
         * flight across a model change: A starts under model A, B starts under
         * B and clears the cache on the way in, then A lands and wrote its
         * answer into a cache now labelled B — so the next lookup of A's word
         * served A's model's answer under B's label. That is the precise thing
         * `cachedFor` exists to prevent, one await too early. The answer is
         * still RETURNED to the caller who asked for it; it is only not
         * remembered for a model that did not produce it. Found by audit. */
        if (cachedFor === model) {
          cache.set(question, answer)
        }
        /* OLDEST OUT FIRST, until the cache is back at its limit: a Map visits
           keys in insertion order, and deleting the key being visited is safe.
           A `while` stood here with an `undefined` guard that could never fire —
           the loop only ran while the map held more than the limit. */
        for (const oldest of cache.keys()) {
          if (cache.size <= CACHE_LIMIT) break
          cache.delete(oldest)
        }
        /* ⚠️ **CANCELLED IS CANCELLED AT THE END TOO, AND IT ONLY WAS AT THE
         * START.** The check on the way in exists because "a lookup the reader
         * abandoned used to succeed from the cache and reject from the model";
         * an abort landing while the plugin call SETTLED had the same shape
         * from the other side — the provider resolved, and only `useGloss`
         * dropping the answer hid it. A port that rejects on abort must do so
         * whenever the abort happened. Found by audit.
         *
         * AFTER the cache write, deliberately: the answer is a correct one for
         * this question and was already paid for, so the reader's next lookup
         * of the same word should still be free. What must not happen is
         * RESOLVING a call the caller cancelled. */
        signal.throwIfAborted()
        return answer
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },

    cacheSize: () => cache.size,
  }
}
