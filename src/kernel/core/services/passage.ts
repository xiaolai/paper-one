import type { PassageHit } from '../ports'
import type { ServiceContext } from '../capability'
import type { ServiceEnvironment } from './environment'
import { descriptorOf, num, readInput, reqStr } from './input'
import { SERVICE_ERRORS, refuse } from './refusals'

/**
 * `passage.search` — the text inside every indexed book (phase 31, WI-31.5).
 *
 * ⚠️ **`book.search` IS A DIFFERENT QUESTION AND THIS DOES NOT TOUCH IT.** That
 * row is the shelf field's query over `index.json` — title, author, `tag:`,
 * `-tag:`, `is:` — which is the library searching everything it knows ABOUT a
 * book. This searches what is written in one. Two meanings on one name is what
 * `serviceTable.ts` exists to prevent, so this is a new noun.
 *
 * ## The two refusals, and why each is by name
 *
 * ⚠️ **NO INDEX IS `unsupported`, NOT AN EMPTY LIST OF HITS.** A host with no
 * `passages` capability — the browser client, a phone, the local CLI — cannot
 * answer this question at all, and an empty stream says *"nothing in your
 * library says that"*, which is a wrong answer rather than a missing one. It is
 * the same rule `device.*` follows for an unbound device port, and the same rule
 * the whole *"an unreadable file is not an empty one"* family follows: absent
 * and empty are two answers.
 *
 * ⚠️ **AND A QUERY THE INDEX CANNOT ANSWER IS `malformed`, NOT "no matches".**
 * An unbalanced quotation mark, or a single CJK character — which the plugin's
 * bigram analysis holds only where it stood alone — comes back with the reason.
 * Reported as an empty result a reader retypes a query that can never work.
 *
 * ## What is NOT here
 *
 * The local CLI's refusal. `openNodeServices` composes no capabilities — its own
 * header says *"WHAT IT DELIBERATELY DOES NOT DO. It composes no
 * capabilities."* — so a `paper passage search` run against this machine finds
 * the slot unbound and is refused by the paragraph above, with the sentence the
 * CLI prints. Over `--shelf` it reaches a running app, which has one. That is
 * the whole of the CLI story and it needed no code here.
 */
export function passageSearch(env: ServiceEnvironment) {
  return async function* (req: unknown, ctx: ServiceContext): AsyncGenerator<readonly PassageHit[]> {
    const input = readInput(descriptorOf('passage.search'), req)
    const query = reqStr(input, 'query')
    /* READ AT CALL TIME, like every other late-bound port. A port bound during
     * the `passages` capability's `start` has to reach a handler that was built
     * before it — `checkNamespaces` runs before anything starts. */
    const index = env.services.passages()
    if (!index) {
      throw refuse(
        SERVICE_ERRORS.unsupported,
        'this device has no passage index — the library can be searched on the shelf that built one',
      )
    }
    const limit = num(input, 'limit')
    let hits: readonly PassageHit[]
    try {
      hits = await index.search(query, limit)
    } catch (cause) {
      /* ⚠️ **A REFUSED QUERY IS `malformed`, AND EVERYTHING ELSE IS RE-THROWN
       * UNCHANGED.** The plugin answers `badQuery` for a question it cannot ask
       * — an unbalanced quotation mark, a lone CJK character — which is the
       * caller's to fix and must reach them as such. An index that will not open
       * is not the caller's to fix, and dressing it as a bad query would send
       * them to retype a perfectly good question for ever.
       *
       * Re-thrown rather than translated, because `SERVICE_ERRORS` has no
       * `internal` and deliberately: this file's own header says the envelope
       * turns anything it does not recognise into a bare `internal`, and a
       * handler inventing one would be claiming to know more about the failure
       * than it does. */
      if (kindOf(cause) === 'badQuery') {
        throw refuse(SERVICE_ERRORS.malformed, messageOf(cause))
      }
      throw cause
    }
    /* ONE FRAME, not a page each. The plugin has already bounded the answer and
     * the whole of it is in memory by the time this runs; splitting it would
     * buy nothing and cost a round trip per frame. The row is a `stream` so a
     * later change CAN page without a wire change — which is the reason to
     * declare it a stream rather than the reason to send several frames now. */
    if (ctx.signal?.aborted) return
    if (hits.length > 0) yield hits
  }
}

/** The `kind` a plugin refusal carries, when it carries one. */
function kindOf(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null
  const kind = (cause as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

function messageOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const message = (cause as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return cause instanceof Error ? cause.message : String(cause)
}
