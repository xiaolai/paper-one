import type { ServiceContext } from '../capability'
import type { DevicePort, DeviceRow, ServiceEnvironment } from './environment'
import { descriptorOf, readInput, reqList, reqStr } from './input'
import { SERVICE_ERRORS, refuse } from './refusals'
import type { RemovedRow } from './rows'

/**
 * `device.*` — a paired peer, its role and its grants (phase 11,
 * WI-11.3/11.5).
 *
 * Answered entirely through a PORT: pairing state lives in `peers.rs`, the
 * kernel imports nothing from a capability, and a Node process has no plugin
 * to ask. Absent, every verb here refuses `unsupported` BY NAME rather than
 * answering an empty list — "no devices" and "this host cannot see devices"
 * are very different facts, and a CLI that conflated them would report a
 * paired phone as forgotten.
 *
 * `device.pair` IS NOT HERE and must not be added. Pairing is a human act
 * with a SAS both people read aloud, and WI-8.6 recorded exactly what driving
 * it by command costs: `grants` is optional on the wire, the harness omitted
 * it, an empty grant list was stored, and the run concluded the app had an
 * asymmetric-grants defect it did not have. Invoking a command directly skips
 * the defaults the UI supplies. Pairing stays in the Devices pane.
 */

/** `<family>:<name>` or `<family>:*` — the spelling `grantCovers` matches and
 *  the one `peers.rs` stores. Lower-case and hyphenated, like every grant the
 *  service table declares. */
const GRANT = /^[a-z][a-z0-9-]*:([a-z][a-z0-9-]*|\*)$/

function port(env: ServiceEnvironment, name: string): DevicePort {
  const bound = env.services.devices()
  if (!bound) {
    throw refuse(SERVICE_ERRORS.unsupported, `${name} needs the peer transport, which is not composed on this host`)
  }
  return bound
}

export function deviceList(env: ServiceEnvironment) {
  return async (req: unknown): Promise<readonly DeviceRow[]> => {
    readInput(descriptorOf('device.list'), req)
    return port(env, 'device.list').list()
  }
}

export function deviceGrant(env: ServiceEnvironment) {
  return async (req: unknown, ctx: ServiceContext): Promise<DeviceRow> => {
    const input = readInput(descriptorOf('device.grant'), req)
    const target = reqStr(input, 'device')
    const grants = reqList(input, 'grants')
    /* A PEER MAY NOT REWRITE ITS OWN GRANTS.
     *
     * `device:manage` was otherwise a grant-all: a peer holding it could name
     * ITSELF, keep `device:manage`, and add every other family — so one
     * permission a human meant as "you may tidy the device list" silently
     * conferred the whole API. Pairing is where what a device may do is
     * decided, by a person comparing a SAS at two keyboards; this verb exists
     * to adjust OTHER devices, and refusing self is what keeps the two apart. */
    if (target === ctx.peer) {
      throw refuse(
        SERVICE_ERRORS.forbidden,
        'a device cannot change its own grants — ask the shelf, or re-pair',
      )
    }
    /* AND IT MAY NOT HAND THE SAME POWER ON.
     *
     * Conferring `device:manage` (or the family wildcard that includes it)
     * would let the receiver do this to a third device, and so on — an
     * escalation chain out of one human decision. The local Devices pane sets
     * grants through the plugin command rather than this service, so nothing
     * a reader does at their own keyboard is affected. */
    for (const grant of grants) {
      if (grant === 'device:manage' || grant === 'device:*') {
        throw refuse(
          SERVICE_ERRORS.forbidden,
          `${grant} is not grantable over the wire — device management is decided at pairing`,
        )
      }
    }
    /* EVERY grant is checked before ANY is written. A partial apply would
     * leave a peer holding a list nobody chose, and the caller with no way to
     * know which of their spellings was the bad one. */
    for (const grant of grants) {
      /* THE WHOLE GRAMMAR. "has a colon somewhere" let `book:`, `a:b:c` and
       * a value with a space in it be persisted — and a stored grant nothing
       * ever matches is a permission the reader believes they granted and
       * that silently does nothing. `<family>:<name>`, or `<family>:*` for
       * the family wildcard `grantCovers` understands; a bare `*` is not one,
       * because a wildcard names a family rather than a word. */
      if (!GRANT.test(grant)) {
        throw refuse(
          SERVICE_ERRORS.malformed,
          `${JSON.stringify(grant)} is not a grant — grants are <family>:<name>, or <family>:* for a whole family`,
        )
      }
    }
    return port(env, 'device.grant').grant(target, grants)
  }
}

export function deviceForget(env: ServiceEnvironment) {
  return async (req: unknown): Promise<RemovedRow> => {
    const input = readInput(descriptorOf('device.forget'), req)
    const id = reqStr(input, 'device')
    return { id, removed: await port(env, 'device.forget').forget(id) }
  }
}
