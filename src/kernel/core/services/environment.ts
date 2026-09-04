import type { IndexedBook } from '../bookIndex'
import type { KernelServices } from '../services'
import { SERVICE_ERRORS, refuse } from './refusals'

/**
 * What the service handlers are built over (phase 11, WI-11.3).
 *
 * NOTE THE ADJACENCY: this directory sits beside `core/services.ts`, which is
 * the kernel's SERVICES OBJECT — the library, the marks, the cards. This
 * directory is the SERVICE TABLE's handlers, which are built over that
 * object. Two different senses of one word, kept apart by the plan's own
 * naming and by importing the file explicitly (`../services`) rather than
 * through any barrel.
 *
 * ONE FIELD, deliberately. Three of the table's nouns are not the kernel's to
 * answer for — `device` is the peer capability's, `shelf`'s role and journal
 * are the peer's and sync's, and bytes-on-disk is a HOST's — and every one of
 * them arrives as a LATE-BOUND PORT on `KernelServices` (`bindDevicePort`,
 * `bindShelfPort`, `bindSizePort`), read at call time by the handler that
 * needs it.
 *
 * Late-bound rather than passed in here, and the reason is an ordering one
 * that an environment of four fields would have got wrong. The registry
 * receives the built services BEFORE any capability has started, because
 * `checkNamespaces` has to refuse a name collision before anything runs — so
 * a port implemented by a capability cannot exist yet when `buildServices` is
 * called. Reading the slot at call time is what makes a port bound during
 * `peer.start()` reach a handler built before it.
 */
export interface ServiceEnvironment {
  readonly services: KernelServices
}

/* The port shapes live in `../ports`, with the kernel's other four. Re-exported
 * here so a reader of the handlers finds them where the handlers name them. */
export type { DevicePort, DeviceRow, HashPort, ShelfFacts, ShelfPort, SizePort } from '../ports'

/**
 * The book with this id, or a `not-found` refusal naming it.
 *
 * ONE COPY, shared by every noun that takes a book id. It lived twice — once
 * in `book.ts`, once in `content.ts` — with the same body and the same
 * message, which is two chances for the refusal a caller branches on to drift
 * apart by noun: `book.get` saying one thing about a missing book and
 * `content.locate` another about the same book.
 */
export function findBook(env: ServiceEnvironment, bookId: string): IndexedBook {
  const found = env.services.library.getSnapshot().find((one) => one.bookId === bookId)
  if (!found) throw refuse(SERVICE_ERRORS.notFound, `no book ${bookId}`)
  return found
}
