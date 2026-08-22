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
 * So what ships is the seam and the not-configured state: a provider interface,
 * the message and citation shapes an answer would arrive in, and a panel that
 * says what is missing and what would fix it.
 *
 * Be clear about how much that is, because the comment here used to overstate
 * it. NOTHING in this build calls `ask`, consumes its stream, or renders a
 * message — the conversation view does not exist. Wiring a provider is
 * therefore two pieces of work, not one: implement this interface, and build
 * the thread that displays what it returns. The types below are a considered
 * proposal for the second piece, not an implementation of it, and they should
 * be changed freely if a real provider makes a different shape obvious. What
 * is here is what `ask` itself needs — a question, a context and citations —
 * and nothing further.
 */

/** Where a claim came from in the book, so §13's citation rule can be met. */
export interface Citation {
  /** The anchor, navigable through the same `goTo` a search hit uses. */
  readonly cfi: string
  /** What to show — "¶2 · line 6" in the design. */
  readonly label: string
}

/* `CompanionRole` and `CompanionMessage` were declared here and referenced by
 * nothing — not even by the provider interface below. They described a message
 * list this build does not have, guessed at before anything needed to render
 * one, which is the same speculative shape the header now warns about. The
 * thread's types belong with the thread. */

/**
 * One passage of the book, with where it came from.
 *
 * THE MODEL NEVER SEES `cfi` OR `label`. A provider numbers these, sends the
 * text under `[1]`, `[2]`, and maps the model's `[n]` back through the table
 * it built. A model handed the word "CFI" emits a syntactically plausible one
 * that points at nothing — in exactly the register §13's citation rule exists
 * to prevent — so it is never asked for one.
 */
export interface AskPassage {
  readonly text: string
  /** The anchor, navigable through the same `goTo` a search hit uses. */
  readonly cfi: string
  /** What a citation chip shows — "¶2 · line 6" in the design. */
  readonly label: string
}

/** What the companion is allowed to see. It is grounded in this book only. */
export interface AskContext {
  readonly bookTitle: string
  readonly chapterLabel: string
  /** The passage the reader selected, when the question is about one. */
  readonly selection: string | null
  /**
   * The book text the answer may be grounded in, in reading order.
   *
   * SUPPLIED BY THE CALLER, because assembling it means reading the rendered
   * view and that is the reader UI's business — the provider owns the
   * numbering, the prompt and the mapping back, which are the parts that must
   * be identical on every route. Empty is legal and means the provider has
   * nothing to cite, which it must say rather than answer around.
   */
  readonly passages: readonly AskPassage[]
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
  async *ask() {
    throw new Error(
      'The companion has no provider. Check `configured` before calling ask().',
    )
  },
}

/** What the not-configured state tells the reader, in §11's voice. */
export const NOT_CONFIGURED_REASON =
  'Asking needs a model, and none is configured in this build.'
