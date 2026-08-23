import type { AnswerEnd, AskContext, CompanionProvider } from '../../../kernel'
import type { Depth, InferencePort } from '../../inference'
import {
  COMPANION_SYSTEM_PROMPT,
  buildAgentTurn,
  buildQuestion,
  numberPassages,
  resolveCitations,
} from './passages'

/**
 * The companion provider — bound by `companion`, and by nothing else.
 *
 * One `ask` for all three routes, and the audit's warning about agents is
 * answered rather than ignored. Agents have sessions, approvals, tool calls
 * and resume/fork semantics a model server does not, and erasing those
 * distinctions erases the safety boundary with them. That warning is about an
 * *agentic surface*. `ask` is nonetheless right here **because Paper
 * deliberately exposes none of that surface**: tools off, one turn, no
 * approvals, no resume, no working directory, no library access. Under those
 * constraints an agent genuinely does reduce to a grounded question and a
 * streamed answer.
 *
 * State the boundary rather than discovering it later: **the day Paper wants
 * a real coding-agent surface, that is a different interface, not an
 * extension of this one.**
 *
 * # Where the passages come from
 *
 * `AskContext.passages`, supplied by the caller, because assembling them
 * means reading the rendered view and that is the reader UI's business — and
 * because the kernel cannot import from a capability, so a setter on this
 * module would have been unreachable from the pane that needs it. What this
 * file owns is the numbering, the prompt and the mapping back: the parts that
 * must be identical on every route.
 */

/** Which route answers. Route ids are the probe's own (`local:…`, `agent:…`). */
export type RouteId = string

export interface CompanionProviderOptions {
  readonly port: InferencePort
  /** The chosen route id, read per call so a change needs no rebind. */
  readonly route: () => RouteId | null
  /**
   * How much of the reader's subscription this answer may spend — read per
   * call, for the same reason the route is: changing it must take effect on
   * the next question, not on the next restart.
   */
  readonly depth: () => Depth
}

/**
 * The provider this capability binds.
 *
 * ⚠️ IT HAD A `lastPassages()` ACCESSOR AND NOTHING CALLED IT. Its contract
 * was "the most recent answer's table", which is provider-wide mutable state
 * shared by every concurrent ask — the exact shape of the defect that made two
 * overlapping questions resolve each other's citations, and the reason the
 * table each answer is numbered against is now held locally. Keeping a public
 * reader for the floating value would have invited the same bug back through
 * the front door, and no caller wanted it.
 */
export type BoundCompanionProvider = CompanionProvider

/** Whether a route id names an agent rather than the local runtime. */
export function isAgentRoute(route: RouteId): boolean {
  return route.startsWith('agent:')
}

/**
 * Which route actually answers, given the reader's stored preference and the
 * fall-back the settings pane is showing.
 *
 * ONE FUNCTION BECAUSE THERE WAS ONE QUESTION AND TWO ANSWERS. `ROUTE_SETTING`
 * documents `''` as "pick the best usable one"; the pane implemented that with
 * `resolveRoute` and the provider did not, returning `null` for the same
 * state. A reader signed into Codex was told `Codex · In use` in Settings and
 * "the companion is not available" in the panel — and the false half was the
 * one they met first.
 *
 * Pure, and separated from the capability's wiring precisely so it can be
 * asserted: the getter that got this wrong was an inline closure nothing could
 * reach.
 */
export function effectiveRoute(stored: string, fallback: RouteId | null): RouteId | null {
  return stored === '' ? fallback : stored
}

/** The model id inside a `local:` route. */
export function localModelOf(route: RouteId): string | null {
  return route.startsWith('local:') ? route.slice('local:'.length) : null
}

/**
 * The daemon-facing model id inside a non-agent route, or null.
 *
 * BOTH PREFIXES, and that is the fix. The probe mints `local:<id>` and
 * `endpoint:<id>`; the plugin's `resolve_model` accepts the BARE id of either,
 * so a caller's job is to strip the namespace. Only `local:` was stripped, and
 * every other non-agent route fell through a `?? ''` — so a registered cloud
 * endpoint asked the daemon for a model called the empty string.
 *
 * Null for a shape this does not recognise, so the caller REFUSES rather than
 * sending an empty model and letting the daemon name the failure.
 */
export function modelIdOf(route: RouteId): string | null {
  for (const prefix of ['local:', 'endpoint:']) {
    if (route.startsWith(prefix)) return route.slice(prefix.length)
  }
  return null
}

/**
 * The model id for a non-agent route, or a refusal that names the route.
 *
 * An unrecognised route shape used to become `''`, which the daemon rejected
 * as an unknown model — an error naming nothing the reader or a maintainer
 * could act on. A route id Paper did not mint is Paper's mistake, and the
 * message says which id.
 */
function requireModelId(route: RouteId): string {
  const id = modelIdOf(route)
  if (id === null || id === '') {
    throw new Error(`The companion cannot answer on the route ${JSON.stringify(route)}.`)
  }
  return id
}

export function createCompanionProvider({
  port,
  route,
  depth,
}: CompanionProviderOptions): BoundCompanionProvider {

  return {
    get name(): string {
      return route() ?? 'No model configured'
    },
    get configured(): boolean {
      return route() !== null
    },

    async *ask(
      question: string,
      context: AskContext,
      signal: AbortSignal,
    ): AsyncGenerator<string, AnswerEnd | void> {
      const chosen = route()
      if (chosen === null) {
        throw new Error('The companion has no provider. Check `configured` before calling ask().')
      }

      /* THIS REQUEST'S OWN TABLE, AND ONLY THAT.
       *
       * There was a provider-wide `numbered` that the citation map at the end
       * read back, so two overlapping asks resolved the FIRST answer's `[n]`
       * against the SECOND question's passages and every citation pointed
       * confidently at the wrong paragraph. It survived that fix as backing
       * for a `lastPassages()` accessor nothing called; with the accessor gone
       * there is nothing provider-wide left to float. */
      const mine = numberPassages(context.passages)
      const prompt = buildQuestion(
        context.bookTitle,
        context.chapterLabel,
        mine,
        context.selection,
        question,
      )

      /* A queue between the Channel's callback and this generator: the plugin
       * pushes deltas whenever they arrive, and a generator can only yield
       * when its consumer asks. Without the queue, a delta arriving between
       * two `next()` calls would be dropped. */
      const pending: string[] = []
      let notify: (() => void) | null = null
      let finished = false
      let failure: unknown = null
      const push = (text: string): void => {
        pending.push(text)
        notify?.()
      }

      /* BOTH BRANCHES TAKE THE SIGNAL. The agent branch did not, so `ask`'s
         cancellation contract held for a local model and silently did not for
         a subscription route — the one where abandoning an answer actually
         costs the reader something. */
      const running = (
        isAgentRoute(chosen)
          ? port.agentAsk(chosen, buildAgentTurn(prompt), depth(), push, signal)
          : port.generate(requireModelId(chosen), COMPANION_SYSTEM_PROMPT, prompt, push, signal)
      )
        .then(() => {})
        .catch((error: unknown) => {
          failure = error
        })
        .finally(() => {
          finished = true
          notify?.()
        })

      let answer = ''
      while (!finished || pending.length > 0) {
        if (pending.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve
          })
          notify = null
          continue
        }
        const text = pending.shift() as string
        answer += text
        yield text
      }
      await running
      if (failure !== null) throw failure

      /* THE MAP BACK, and the drop. An index the table does not contain is
       * refused — never resolved to the nearest passage, which would be a
       * citation pointing somewhere plausible.
       *
       * ⚠️ AND THE FLAG TRAVELS WITH IT. This returned `.citations` alone, so
       * the one thing that knew a citation had been fabricated dropped that
       * fact on the way out and `UNKNOWN_CITATION_NOTE` could never be
       * rendered by anything. A drop the reader is not told about is the
       * failure mode the drop exists to prevent. */
      return resolveCitations(answer, mine)
    },

  }
}
