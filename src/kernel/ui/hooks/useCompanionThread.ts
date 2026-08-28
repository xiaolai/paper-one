import { useCallback, useEffect, useRef, useState } from 'react'
import { UNKNOWN_CITATION_NOTE } from '../../core/companion'
import type { AskContext, Citation, CompanionProvider } from '../../core/companion'

/**
 * The thread — the conversation view `Companion.tsx`'s third branch has been
 * naming as unbuilt since the seam shipped.
 *
 * `companion.ts`'s header was right that wiring a provider is two pieces of
 * work and not one: implement the interface, and build the thread that
 * displays what it returns. This is the second piece.
 *
 * # One turn, and the history is display-only
 *
 * Messages accumulate here so the reader can see what they asked, but
 * **nothing prior is sent**: `ask` receives one question and the passages for
 * the reader's current position. That is the boundary the plan draws — tools
 * off, one turn, no approvals, no resume — and a thread that quietly resent
 * its own history would be the first step across it.
 *
 * # Everything it produces is amber, everywhere, forever
 *
 * Amber is a provenance mark, and marking fabrications with it makes the one
 * signal the design relies on worthless. So a reply carries the amber tokens
 * rather than the accent, and an answer whose citation could not be resolved
 * says so on its own line rather than quietly dropping it.
 */

export type ThreadRole = 'reader' | 'companion'

export interface ThreadMessage {
  readonly id: number
  readonly role: ThreadRole
  readonly text: string
  readonly citations: readonly Citation[]
  /** True while this message is still arriving. */
  readonly streaming: boolean
  /** Set when the answer failed, in the reader's words. */
  readonly failure: string | null
  /**
   * Set when the model cited a passage that was not sent.
   *
   * NOT a `failure`: the answer stands and the rest of its citations are
   * real. What was removed is one claim's link, and §13 says a claim whose
   * citation vanished must not stand unmarked — so it is said, on its own
   * line, rather than left to look like an answer that simply cited less.
   */
  readonly notice: string | null
}

export interface CompanionThread {
  readonly messages: readonly ThreadMessage[]
  readonly busy: boolean
  ask(question: string): void
  cancel(): void
  clear(): void
}

let nextId = 0

/**
 * The failure line, from whatever the provider raised.
 *
 * WI-20.18. This read `error instanceof Error ? error.message : 'The companion
 * could not answer'`, and the plugin behind the bound provider rejects with
 * `{ kind, message }` — a plain object — so every failure the capability had
 * not wrapped reached the reader as the sentence that names nothing. The
 * reader's sentence for a `kind` is the capability's to produce (it is the
 * only side that has `detailFor`), and the bound provider now does; what this
 * hook owes is to show the text it is handed rather than flatten it, so a
 * provider that did not translate still says what happened. The generic
 * sentence is for a rejection with no text at all.
 */
function failureLine(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown }
    if (typeof message === 'string' && message !== '') return message
  }
  return 'The companion could not answer'
}

export function useCompanionThread(
  provider: CompanionProvider,
  /**
   * The grounding, READ AT ASK TIME rather than passed as a value.
   *
   * A function because the passages come from walking the rendered document,
   * and computing them on every render would walk the reader's page on every
   * keystroke in the composer. It also makes "the reader turned the page
   * between opening the pane and pressing send" answer correctly: the context
   * is whatever is true when they ask.
   */
  contextOf: () => AskContext,
): CompanionThread {
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([])
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)

  /* A ref rather than a dependency, so the callback identity is stable and
   * the composer does not re-render on every scroll. */
  const latest = useRef(contextOf)
  latest.current = contextOf

  /* An unmounted pane must not leave a generation running: the daemon would
   * go on producing tokens, and on an agent route that is a subscription turn
   * spent on an answer nobody will read. */
  useEffect(
    () => () => {
      abort.current?.abort()
      abort.current = null
    },
    [],
  )

  const cancel = useCallback(() => {
    abort.current?.abort()
    abort.current = null
    setBusy(false)
    setMessages((prior) =>
      prior.map((message) => (message.streaming ? { ...message, streaming: false } : message)),
    )
  }, [])

  const ask = useCallback(
    (question: string) => {
      const trimmed = question.trim()
      if (trimmed === '' || !provider.configured) return
      /* One at a time. A second question while the first is streaming would
       * interleave two answers into one thread with no way to tell them
       * apart. */
      if (abort.current !== null) return

      const controller = new AbortController()
      abort.current = controller
      setBusy(true)

      const readerId = (nextId += 1)
      const replyId = (nextId += 1)
      setMessages((prior) => [
        ...prior,
        {
          id: readerId,
          role: 'reader',
          text: trimmed,
          citations: [],
          streaming: false,
          failure: null,
          notice: null,
        },
        {
          id: replyId,
          role: 'companion',
          text: '',
          citations: [],
          streaming: true,
          failure: null,
          notice: null,
        },
      ])

      const patch = (change: Partial<ThreadMessage>): void => {
        setMessages((prior) =>
          prior.map((message) => (message.id === replyId ? { ...message, ...change } : message)),
        )
      }

      void (async () => {
        let text = ''
        try {
          const stream = provider.ask(trimmed, latest.current(), controller.signal)
          let step = await stream.next()
          while (step.done !== true) {
            text += step.value
            patch({ text })
            step = await stream.next()
          }
          /* The generator's RETURN value is Paper's own mapping from `[n]`
           * back to a location, never anything the model produced — plus
           * whether any `[n]` named a passage that was never sent.
           *
           * ⚠️ THE SECOND HALF USED TO BE THROWN AWAY one layer down, so the
           * note WI-15.5 requires could not be shown by anything. See
           * `AnswerEnd`. */
          const end = step.value ?? undefined
          patch({
            text,
            citations: end?.citations ?? [],
            notice: end?.hadUnknownCitation === true ? UNKNOWN_CITATION_NOTE : null,
            streaming: false,
          })
        } catch (error) {
          if (controller.signal.aborted) {
            /* The reader's own abort. What arrived is kept — it is a real
             * partial answer — and nothing is reported as a failure. */
            patch({ text, streaming: false })
          } else {
            patch({ text, streaming: false, failure: failureLine(error) })
          }
        } finally {
          if (abort.current === controller) abort.current = null
          setBusy(false)
        }
      })()
    },
    [provider],
  )

  const clear = useCallback(() => {
    cancel()
    setMessages([])
  }, [cancel])

  return { messages, busy, ask, cancel, clear }
}
