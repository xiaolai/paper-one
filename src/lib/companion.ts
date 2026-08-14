/**
 * The companion — its interface, and the absence of a provider for it.
 *
 * This project has no model credentials, and that is not a gap to be papered
 * over. §13's voice rules are explicit: every claim about the book cites a
 * location and links to it, and the companion answers from the book by default
 * and says when it is drawing on outside knowledge. Nothing that ships here can
 * satisfy that, because there is nothing to do the reading. Shipping invented
 * answers under an amber label would be worse than shipping none — the amber
 * is a provenance mark, and marking fabrications as companion output makes the
 * one signal the design relies on a lie.
 *
 * So what ships is the seam: a provider interface, a thread that would hold
 * real answers, and a not-configured state that says what is missing and what
 * would fix it. Wiring a real provider is then a matter of implementing one
 * interface, with the UI already built to display citations it cannot yet get.
 */

/** Where a claim came from in the book, so §13's citation rule can be met. */
export interface Citation {
  /** The anchor, navigable through the same `goTo` a search hit uses. */
  readonly cfi: string
  /** What to show — "¶2 · line 6" in the design. */
  readonly label: string
}

export type CompanionRole = 'you' | 'companion'

export interface CompanionMessage {
  readonly id: string
  readonly role: CompanionRole
  readonly text: string
  /** Always present for a companion message; empty means it cited nothing. */
  readonly citations: readonly Citation[]
}

/** What the companion is allowed to see. It is grounded in this book only. */
export interface AskContext {
  readonly bookTitle: string
  readonly chapterLabel: string
  /** The passage the reader selected, when the question is about one. */
  readonly selection: string | null
}

export interface CompanionProvider {
  /** Shown in the not-configured state so the reader knows what is missing. */
  readonly name: string
  /** False when the provider cannot answer — the UI stays in its empty state. */
  readonly configured: boolean
  /**
   * Stream an answer.
   *
   * A generator because §08's reply should appear as it is produced rather than
   * arriving whole, and because a reader must be able to abandon a long answer
   * — hence the signal, which every implementation is expected to honour.
   */
  ask(
    question: string,
    context: AskContext,
    signal: AbortSignal,
  ): AsyncGenerator<string, readonly Citation[] | void>
}

/**
 * The provider this build ships with.
 *
 * `ask` throws rather than returning an apology, because the UI must never
 * reach it: `configured` is false, so every affordance that would call it is
 * disabled per §07. If this ever throws, that is a bug in the caller and it
 * should be loud rather than showing the reader a fabricated non-answer.
 */
export const NOT_CONFIGURED: CompanionProvider = {
  name: 'No model configured',
  configured: false,
  // eslint-disable-next-line require-yield
  async *ask() {
    throw new Error(
      'The companion has no provider. Check `configured` before calling ask().',
    )
  },
}

/** What the not-configured state tells the reader, in §11's voice. */
export const NOT_CONFIGURED_REASON =
  'Asking needs a model, and none is configured in this build.'
