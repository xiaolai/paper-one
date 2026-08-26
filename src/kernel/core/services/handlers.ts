import type { ServiceContribution, ServiceHandler } from '../capability'
import { SERVICE_TABLE, readingGrant, type ServiceDescriptor, type ServiceName } from '../serviceTable'
import { bookAdd, bookGet, bookList, bookRemove, bookRestore, bookSearch, bookSet } from './book'
import { cardAdd, cardList, cardRemove } from './card'
import { contentEvict, contentLocate, contentRead, coverRead } from './content'
import { deviceForget, deviceGrant, deviceList } from './device'
import type { ServiceEnvironment } from './environment'
import { markAdd, markList, markRemove, markSet } from './mark'
import { SERVICE_ERRORS, refuse } from './refusals'
import { shelfStatus, shelfSync, shelfVerify } from './shelf'
import { tagAdd, tagList, tagRemove, tagRename } from './tag'
import { trashEmpty, trashList } from './trash'

/**
 * THE ONE PLACE A DECLARED SERVICE BECOMES A CALLABLE ONE (phase 11).
 *
 * `commands.rs` opens with the lesson this file is written against: "Adding a
 * command means four edits: here, `generate_handler!` in `lib.rs`, `COMMANDS`
 * in `build.rs`, and `permissions/default.toml`. Miss the handler or the
 * build list and the command is unreachable; miss the ACL and it is refused."
 * Three lists that must agree by hand.
 *
 * There is no second list here. `HANDLERS` is typed `Record<ServiceName, …>`,
 * where `ServiceName` is read off the table literal — so:
 *
 *   - a row added to the table with no handler is a COMPILE ERROR, naming the
 *     missing key. It cannot ship unreachable.
 *   - a handler for a name the table does not hold is a COMPILE ERROR too.
 *     It cannot ship un-grant-checked, because the grant comes from the row.
 *   - the grant, the name and the kind are read from the row at registration.
 *     There is nowhere to spell them a second time and therefore nowhere for
 *     them to drift.
 *
 * That is the whole mechanism, and it is why the "one edit" claim in WI-11.1
 * is checkable rather than aspirational: the edit is the table row. Writing
 * the handler is writing the behaviour, which is not a list.
 */

/** A handler built over the environment the composition root supplies. */
type HandlerFactory = (env: ServiceEnvironment) => ServiceHandler

/**
 * Every declared name, mapped to its behaviour. The type is what closes the
 * set; the order below follows the table so the two read alike.
 */
const HANDLERS: Readonly<Record<ServiceName, HandlerFactory>> = {
  'book.list': bookList,
  'book.get': bookGet,
  'book.add': bookAdd,
  'book.set': bookSet,
  'book.remove': bookRemove,
  'book.restore': bookRestore,
  'book.search': bookSearch,

  'mark.list': markList,
  'mark.add': markAdd,
  'mark.set': markSet,
  'mark.remove': markRemove,

  'card.list': cardList,
  'card.add': cardAdd,
  'card.remove': cardRemove,

  'tag.list': tagList,
  'tag.add': tagAdd,
  'tag.remove': tagRemove,
  'tag.rename': tagRename,

  'content.locate': contentLocate,
  'content.read': contentRead,
  'cover.read': coverRead,
  'content.evict': contentEvict,

  'device.list': deviceList,
  'device.grant': deviceGrant,
  'device.forget': deviceForget,

  'shelf.status': shelfStatus,
  'shelf.sync': shelfSync,
  'shelf.verify': shelfVerify,

  'trash.list': trashList,
  'trash.empty': trashEmpty,
}

/**
 * The handler for one descriptor, built over `env`.
 *
 * The cast is safe for every descriptor the TABLE produced, which is every
 * descriptor `buildServices` and `serviceDescriptor` hand out. It is not safe
 * for one a caller built by hand — this is a public export — and an unchecked
 * lookup would answer `undefined(env)`, a `TypeError` naming nothing. Refused
 * by name instead, with the same code a service outside the table gets
 * anywhere else.
 */
export function handlerFor(descriptor: ServiceDescriptor, env: ServiceEnvironment): ServiceHandler {
  const factory = HANDLERS[descriptor.name as ServiceName] as HandlerFactory | undefined
  if (!factory) throw refuse(SERVICE_ERRORS.unsupported, `${descriptor.name} is not in the service table`)
  return factory(env)
}

/**
 * The table as contributions, ready for the peer router or for an in-process
 * caller.
 *
 * `only` narrows the set — `readServices()` while the write half was still in
 * flight, a single noun for a test. It is a FILTER over the table and never a
 * second list: what it cannot do is produce a service the table does not
 * declare.
 */
export function buildServices(
  env: ServiceEnvironment,
  only?: readonly ServiceDescriptor[],
): readonly ServiceContribution[] {
  return (only ?? SERVICE_TABLE).map((descriptor) => ({
    name: descriptor.name,
    grant: descriptor.grant,
    handler: handlerFor(descriptor, env),
  }))
}

/** Just the read half — the ten services WI-11.3 landed first, because they
 *  carry no concurrency question and are worth having before the rest. */
export function buildReadServices(env: ServiceEnvironment): readonly ServiceContribution[] {
  return buildServices(env, SERVICE_TABLE.filter((one) => readingGrant(one.grant)))
}
