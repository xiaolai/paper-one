import { liveCards, type CardKind } from '../cards'
import { createCard } from '../cardStore'
import type { ServiceContext } from '../capability'
import type { ServiceEnvironment } from './environment'
import { descriptorOf, num, readInput, reqStr, str } from './input'
import { pages } from './paging'
import { SERVICE_ERRORS, refuse } from './refusals'
import { cardRow, type CardRow, type RemovedRow } from './rows'

/**
 * `card.*` — the made thing (phase 11, WI-11.3/11.5).
 *
 * A card is cross-book and lives in no folder: the whole collection is one
 * value in the flat store. So there is no per-book read to pay for and no
 * `get` — a caller that wants one card lists and picks, on a collection whose
 * whole point is that it is small enough to browse.
 *
 * `getSnapshot().all` is already filtered to live rows; the tombstones stay
 * in the stored list because a merge needs them, and no snapshot ever shows
 * one. `liveCards` here is belt to that brace for a caller reading `stored()`.
 */

export function cardList(env: ServiceEnvironment) {
  return (req: unknown, ctx: ServiceContext): AsyncIterable<readonly CardRow[]> => {
    const input = readInput(descriptorOf('card.list'), req)
    const rows = liveCards(env.services.cards.getSnapshot().all).map(cardRow)
    return pages(rows, ctx.signal, num(input, 'limit'))
  }
}

export function cardAdd(env: ServiceEnvironment) {
  return async (req: unknown): Promise<CardRow> => {
    const input = readInput(descriptorOf('card.add'), req)
    /* THE TABLE DECLARES THE VOCABULARY. `choices` on the field is what
     * refuses anything outside it, in the same place every other malformed
     * body is refused — and the generated reference prints the list, which a
     * check written here could not. */
    const kindRaw = str(input, 'kind') ?? 'Idea'
    const bookId = str(input, 'book') ?? ''
    if (bookId !== '' && !env.services.library.getSnapshot().some((one) => one.bookId === bookId)) {
      throw refuse(SERVICE_ERRORS.notFound, `no book ${bookId}`)
    }
    const card = createCard({
      bookId,
      kind: kindRaw as CardKind,
      body: reqStr(input, 'text'),
      answer: '',
      source: '',
      cfi: null,
    })
    await env.services.cards.add(card)
    return cardRow(card)
  }
}

export function cardRemove(env: ServiceEnvironment) {
  return async (req: unknown): Promise<RemovedRow> => {
    const input = readInput(descriptorOf('card.remove'), req)
    const id = reqStr(input, 'card')
    const known = env.services.cards.stored().some((one) => one.id === id && one.deletedAt === undefined)
    if (!known) return { id, removed: false }
    await env.services.cards.remove(id)
    return { id, removed: true }
  }
}
