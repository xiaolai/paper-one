import type { AskContext, Citation, CompanionProvider } from '../../../kernel'
import type { InferencePort } from '../../inference'
import {
  COMPANION_SYSTEM_PROMPT,
  buildQuestion,
  numberPassages,
  resolveCitations,
  type Passage,
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
}

export interface BoundCompanionProvider extends CompanionProvider {
  /** The passages the last answer was grounded in, for the citation map. */
  lastPassages(): readonly Passage[]
}

/** Whether a route id names an agent rather than the local runtime. */
export function isAgentRoute(route: RouteId): boolean {
  return route.startsWith('agent:')
}

/** The model id inside a `local:` route. */
export function localModelOf(route: RouteId): string | null {
  return route.startsWith('local:') ? route.slice('local:'.length) : null
}

export function createCompanionProvider({
  port,
  route,
}: CompanionProviderOptions): BoundCompanionProvider {
  let numbered: readonly Passage[] = []

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
    ): AsyncGenerator<string, readonly Citation[] | void> {
      const chosen = route()
      if (chosen === null) {
        throw new Error('The companion has no provider. Check `configured` before calling ask().')
      }

      numbered = numberPassages(context.passages)
      const prompt = buildQuestion(
        context.bookTitle,
        context.chapterLabel,
        numbered,
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

      const running = (
        isAgentRoute(chosen)
          ? port.agentAsk(chosen, prompt, push)
          : port.generate(localModelOf(chosen) ?? '', COMPANION_SYSTEM_PROMPT, prompt, push, signal)
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
       * citation pointing somewhere plausible. */
      return resolveCitations(answer, numbered).citations
    },

    lastPassages: () => numbered,
  }
}
