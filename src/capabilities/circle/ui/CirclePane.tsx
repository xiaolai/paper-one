import { CAPABILITY_UI } from '../../../kernel'
import type { PersonPort } from '../../peer'
import type { CirclePort } from '../lib/circlePort'
import type { ListsPort } from '../lib/listsPort'
import { IdentitySection } from './IdentitySection'
import { OwnLists } from './OwnLists'
import { PairingSection } from './PairingSection'
import { RosterSection } from './RosterSection'
import { usePairing } from './usePairing'
import { usePerson } from './usePerson'

/**
 * The circle, as a screen — WI-22.D3's surface.
 *
 * ## What this page is for, and what it deliberately is not
 *
 * ⚠️ **A FRIEND'S PASSAGES ARE DRAWN IN THE BOOK, NOT LISTED HERE.** That is
 * `surfaces.md`'s decision and this screen does not relitigate it: a shared
 * passage belongs on the page it is about, underlined where the sentence is,
 * and a list of quotes in a side panel is a second place to read the same book
 * badly. What is here is everything a reader cannot see by turning a page —
 * **who** is in the circle, **which device** they are speaking from, and
 * whether their own identity is one dead laptop from being gone.
 *
 * ## Four things, each with state of its own
 *
 * The screen READS once — `usePerson`: the custody status and the roster,
 * together, because the status carries the circle's size — and hands what
 * it read to four sections that ACT on their own:
 *
 *  - `IdentitySection` — the custody marker, the twelve words, the one
 *    button that mints. Keyed by the person, so a phrase read for the last
 *    identity cannot land under the next one's id.
 *  - `PairingSection` over `usePairing` — offer, join, answer. The hook is
 *    called here, in every state, because a result must re-read the roster
 *    even while the screen is still reading.
 *  - `RosterSection` — the people, each row its own: the shelf switch, their
 *    shelf, Remove.
 *  - `OwnLists` — the reader's lists, each row its own.
 *
 * ⚠️ **NOTHING IS SHARED BETWEEN THEM BUT THE READ.** One `busy` and one
 * trouble line for the whole screen meant a person who could not be removed
 * was reported beside the offer link, and a note that would not save held
 * the shelf switch. An act now blocks and reports the controls that asked
 * for it, and no others.
 */

export interface CirclePaneProps {
  /**
   * `null` on a composition with no `peer` — the browser client.
   *
   * ⚠️ **NO PLUGIN IS NO CIRCLE, WHICH IS A STATE AND NOT AN ERROR.** A screen
   * that threw here would take the whole side pane down on the one platform
   * that legitimately cannot have this feature.
   */
  readonly port: PersonPort | null
  /**
   * The circle's own port — the per-person shelf switch (WI-23.C2), the
   * Friends view (WI-23.C4) and the purge (WI-23.C3). Absent or `null`
   * before the capability has started, which draws the people and none of
   * the three.
   */
  readonly circle?: CirclePort | null
  /** The reader's own lists — WI-23.E1. Absent or `null` before start, which draws none. */
  readonly lists?: ListsPort | null
  /** How this screen opens one of the reader's own books — see `PaneContext.openBook`. */
  readonly openBook?: (bookId: string) => void
}

export function CirclePane({ port, circle = null, lists = null, openBook }: CirclePaneProps) {
  const { status, people, failure, refresh } = usePerson(port)
  const pairing = usePairing(port, refresh)

  if (port === null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>A circle needs Paper's own app on this device.</p>
      </div>
    )
  }

  if (failure !== null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Paper could not read your circle. {failure}</p>
        <div className={CAPABILITY_UI.actions}>
          <button type="button" className={CAPABILITY_UI.button} onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (status === null) return <div className={CAPABILITY_UI.section} />

  /* No identity: the one section that can make one, and nothing that would
     need it — the roster is empty by construction, and a pairing needs a
     person to pair as. */
  if (!status.hasIdentity) return <IdentitySection key="" port={port} status={status} refresh={refresh} />

  return (
    <>
      <IdentitySection key={status.personId ?? ''} port={port} status={status} refresh={refresh} />
      <PairingSection pairing={pairing} />
      <RosterSection port={port} circle={circle} people={people} refresh={refresh} {...(openBook ? { openBook } : {})} />
      {lists === null ? null : <OwnLists lists={lists} {...(openBook ? { openBook } : {})} />}
    </>
  )
}
