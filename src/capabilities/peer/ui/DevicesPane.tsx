import { useState, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import type { DevicesModel } from './devicesModel'
import {
  ROLE_CHOICES,
  canJoinWithCode,
  canOfferInvite,
  describeGrants,
  describeReach,
  describeRole,
  grantsAreEnforceable,
  inlineQrSvg,
  pairingFault,
  peerCanWrite,
  roleIsSettable,
  shelfNameOf,
} from './devicesModel'

/**
 * The Devices section (WI-C.5), rendered by the kernel's Settings pane as a
 * contributed section. Everything it DECIDES lives in `devicesModel.ts`,
 * which is where most of the tests are; this file mostly draws the snapshot
 * and forwards intents.
 *
 * "MOSTLY". This said the model was where the tests are "(the no-jsdom rule)",
 * and four other capability panes have carried jsdom tests since — so the
 * sentence had stopped describing a rule and started describing this pane
 * being the one with no tests at all. `DevicesPane.test.tsx` covers what the
 * pane alone decides; the one that found this was where the invite appears
 * when the clipboard refuses it.
 *
 * It draws with `CAPABILITY_UI`, the kernel's public class vocabulary. It used
 * to draw with two hand-rolled inline objects and bare form controls, which
 * meant the browser's own chrome — a system-blue submit button and a
 * default-bordered field — inside a pane where everything else was Paper's.
 * Nothing here should invent a colour, a radius or a height: if a control
 * needs one this vocabulary has not got, the answer is a rule in
 * `kernel/ui/styles/capability.css`, not a `style=` here, or every capability
 * gets its own idea of what Paper looks like.
 */

export interface DevicesPaneProps {
  readonly model: DevicesModel
  /** "Sync now" — supplied by the sync capability through the peer's slot;
   *  null renders no button (sync not composed, or not started yet). */
  readonly syncNow: (() => void) | null
}

export function DevicesPane({ model, syncNow }: DevicesPaneProps) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  const [code, setCode] = useState('')
  /* Reset by the offer's identity, so a second pairing does not open already
     saying "Copied" about an invite the reader has not copied. */
  const [copiedFor, setCopiedFor] = useState<string | null>(null)
  const copied = copiedFor !== null && copiedFor === snapshot.offer?.url
  /* A failed copy is SAID — the reader was about to paste an empty clipboard
     into the other device — and, like the success, it belongs to one offer. */
  const [copyFailedFor, setCopyFailedFor] = useState<string | null>(null)
  const copyFailed = copyFailedFor !== null && copyFailedFor === snapshot.offer?.url
  const setCopied = (outcome: 'yes' | 'failed') => {
    const url = snapshot.offer?.url ?? null
    setCopiedFor(outcome === 'yes' ? url : null)
    setCopyFailedFor(outcome === 'failed' ? url : null)
  }
  /* One role write at a time, and one grant edit per peer at a time — the
     controls wait for their own write (audit-fix #310, #312). */
  const [settingRole, setSettingRole] = useState(false)
  const [updatingGrants, setUpdatingGrants] = useState<ReadonlySet<string>>(() => new Set())

  if (!snapshot.available) {
    /* INSIDE A SECTION, like every other state this pane can be in. The
       section is what carries the inset that lines a contributed row up with
       the kernel's own, so a bare hint returned here sat ten pixels left of
       everything above it. */
    return (
      <div className={ui.section}>
        <div className={ui.hint}>Devices need the Paper app — there is no peer plugin in a browser tab.</div>
      </div>
    )
  }

  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>This device</span>
        {/* WHAT IT DOES, NOT WHAT THE PROTOCOL CALLS IT. The endpoint id went
            with the role's spelling: eight hex characters a reader can neither
            read out nor act on, in the one row that has to make sense first. */}
        <span className={ui.value}>{describeRole(snapshot.role)}</span>
      </div>

      {/* THE CHOICE, ASKED AS A FACT ABOUT THEIR BOOKS.
          Offered only while nothing is paired: changing sides afterwards means
          reconciling a whole library against a metadata-only one, which is a
          migration and not a toggle. Revoking every device offers it again. */}
      {snapshot.peersLoaded && roleIsSettable(snapshot.peers) && (
        <>
          <div className={ui.row}>
            <span className={ui.grow}>Where do your books live?</span>
          </div>
          <div className={ui.actions}>
            {ROLE_CHOICES.map((choice) => (
              <button
                key={choice.role}
                type="button"
                className={`${ui.button}${snapshot.role === choice.role ? ` ${ui.buttonPrimary}` : ''}`}
                aria-pressed={snapshot.role === choice.role}
                disabled={settingRole}
                onClick={() => {
                  /* One write at a time: two quick clicks used to start two
                     durable writes whose completion order chose the role. */
                  setSettingRole(true)
                  void model.setRole(choice.role).finally(() => setSettingRole(false))
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <div className={ui.hint}>
            {ROLE_CHOICES.find((c) => c.role === snapshot.role)?.detail ??
              'Pick where the whole library is kept.'}
          </div>
          {/* The node read its role when it started; the file is what changed.
              Saying so is better than a switch that appears to have worked. */}
          {snapshot.roleNeedsRestart && (
            <div className={ui.hint}>Quit and reopen Paper to apply this, then pair.</div>
          )}
        </>
      )}

      {/* The shelf stays reachable only while Paper runs — stated, per the plan,
          for the role this device has and by the shelf's own name. */}
      <div className={ui.hint}>{describeReach(snapshot.role, shelfNameOf(snapshot.peers))}</div>

      {/* ONE ACTION, AND ONLY WHILE THERE IS NOTHING TO CANCEL.
          Three unrelated buttons used to sit in this row — offer, cancel, and
          a sync trigger that has nothing to do with pairing. Worse, the offer
          button stayed live while an offer was open, and `begin()` says "a
          second call replaces the first": pressing it again silently killed
          the invite the reader had just copied. The offer IS the state now, so
          the button that mints one steps aside while it exists, and Cancel
          lives with the invite it cancels. */}
      {canOfferInvite(snapshot.role) && !snapshot.offer && (
        <div className={ui.actions}>
          <button type="button" className={ui.button} onClick={() => void model.beginPairing()}>
            Pair a new device…
          </button>
        </div>
      )}

      {snapshot.offer && (
        <div className={ui.figure}>
          {/* THE INVITE IS A STRING, AND THE QR IS THE PHONE'S VERSION OF IT.
              The pane used to lead with a 192px picture and then print the URI
              underneath as text — a 100-character `paper://pair?…` with a key
              in it, which nobody reads and nobody can retype. Two Macs cannot
              photograph each other, so the string is the primary path and the
              button is what moves it. */}
          <div className={ui.actions}>
            <button
              type="button"
              className={`${ui.button} ${ui.buttonPrimary}`}
              onClick={() => {
                void navigator.clipboard.writeText(snapshot.offer!.url).then(
                  () => setCopied('yes'),
                  /* Said, not swallowed: the reader was about to paste an empty
                     clipboard into the other device. */
                  () => setCopied('failed'),
                )
              }}
            >
              {copyFailed ? 'Couldn’t copy — select the code instead' : copied ? 'Copied' : 'Copy invite code'}
            </button>
            <button type="button" className={ui.button} onClick={() => void model.cancelPairing()}>
              Cancel
            </button>
          </div>
          {/* THE CODE ITSELF, AND ONLY WHEN THE BUTTON COULD NOT CARRY IT.
              The failure said "select the code instead" while the invite was
              nowhere on screen as text — a message naming an affordance that
              does not exist is worse than the failure it reports, because it
              sends the reader looking for something that was never drawn.
              `.paper-cap-code` is `user-select: all`, so one click takes the
              whole URI; the class was written for this string. It appears
              only on the failure, because the deliberate design is the button
              — a 100-character `paper://pair?…` with a key in it is not read
              and cannot be retyped. */}
          {copyFailed && <code className={ui.code}>{snapshot.offer.url}</code>}
          <div className={ui.hint}>
            Paste it into Devices on the other device. It is single-use and expires when you cancel.
          </div>
          {/* Inlined rather than an `<img>`, so the theme reaches it — see
              `.paper-cap-qr` in `capability.css`. The SVG is this process's own
              Rust rendering a URI it just minted. */}
          <div
            className={ui.qr}
            aria-label="Pairing QR code"
            role="img"
            dangerouslySetInnerHTML={{ __html: inlineQrSvg(snapshot.offer.svg) }}
          />
          <div className={ui.hint}>Or scan it with a phone.</div>
        </div>
      )}

      {/* THE JOINING HALF, and only on the side that can join — see
          `canJoinWithCode`. On a shelf this was a field whose every submission
          the far end would refuse. */}
      {canJoinWithCode(snapshot.role) && (
        <>
          <form
            className={ui.row}
            onSubmit={(event) => {
              event.preventDefault()
              if (!code.trim()) return
              /* Cleared only once the pairing has begun without an error: a
                 long code the reader typed used to vanish on a failure, with
                 no way to correct one character and try again. */
              void model.pairWithCode(code).then(() => {
                if (model.getSnapshot().error === null) setCode('')
              })
            }}
          >
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Paste the invite code from your library"
              aria-label="Pairing code"
              className={ui.field}
            />
            {/* The one action this surface is FOR — see `CAPABILITY_UI.button`. */}
            <button type="submit" className={`${ui.button} ${ui.buttonPrimary}`}>
              Pair
            </button>
          </form>
          <div className={ui.hint}>
            On the device that holds your library, choose “Pair a new device” and copy the invite.
          </div>
        </>
      )}

      {snapshot.sas && (
        <div className={ui.row}>
          <span className={ui.grow}>
            Confirm on the other device. Code: <strong>{snapshot.sas}</strong>
          </span>
        </div>
      )}

      {snapshot.pending && (
        <div className={ui.row}>
          <span className={ui.grow}>
            “{snapshot.pending.name}” ({snapshot.pending.platform}) asks to pair. Code: <strong>{snapshot.pending.sas}</strong>
          </span>
          <button type="button" className={`${ui.button} ${ui.buttonPrimary}`} onClick={() => void model.confirmPairing(true)}>
            Pair
          </button>
          <button type="button" className={`${ui.button} ${ui.buttonDanger}`} onClick={() => void model.confirmPairing(false)}>
            Refuse
          </button>
        </div>
      )}

      {snapshot.lastResult && !snapshot.lastResult.ok && (
        <div className={ui.hint}>Pairing did not finish: {snapshot.lastResult.reason ?? 'refused'}.</div>
      )}
      {snapshot.error && <div className={ui.hint}>Something failed: {snapshot.error}</div>}

      {snapshot.peers.map((peer) => {
        const fault = pairingFault(snapshot.role, peer.role)
        return (
          <div key={peer.id}>
            <div className={ui.row}>
              <span className={ui.grow}>{peer.name}</span>
              <span className={ui.value}>{describeRole(peer.role)}</span>
              <button
                type="button"
                className={`${ui.button} ${ui.buttonDanger}`}
                onClick={() => void model.forget(peer.id)}
              >
                Revoke
              </button>
            </div>
            {/* WHAT MOVES, in artifacts rather than in wildcards. */}
            <div className={ui.hint}>
              {describeGrants(peer.grants)}
              {/* LAST SEEN, NOT LAST SYNCED. `lastSeenAt` is stamped when the
                  transport made contact — a session that opened and moved
                  nothing counts — so "last synced" claimed a successful
                  exchange the field cannot vouch for, and a reader debugging
                  a silent pair was told it had synced a minute ago. */}
              {peer.lastSeenAt
                ? ` · last seen ${new Date(peer.lastSeenAt).toLocaleString()}`
                : ' · never seen'}
            </div>
            {/* OFFERED ONLY WHERE IT BITES. Grants are checked by the side
                being CALLED, and a shelf answers satchels rather than dialling
                them — so a satchel's record of its shelf is never consulted,
                and a switch there would do nothing. See `grantsAreEnforceable`. */}
            {grantsAreEnforceable(snapshot.role) && (
              <label className={ui.row}>
                <span className={ui.grow}>Let this device make changes</span>
                <input
                  type="checkbox"
                  className={ui.toggle}
                  checked={peerCanWrite(peer.grants)}
                  disabled={updatingGrants.has(peer.id)}
                  onChange={(event) => {
                    const next = event.target.checked
                    setUpdatingGrants((held: ReadonlySet<string>) => new Set(held).add(peer.id))
                    void model.setPeerCanWrite(peer.id, next).finally(() =>
                      setUpdatingGrants((held: ReadonlySet<string>) => {
                        const rest = new Set(held)
                        rest.delete(peer.id)
                        return rest
                      }),
                    )
                  }}
                />
              </label>
            )}
            {/* A PAIRING THAT CANNOT WORK SHOULD SAY SO. Nothing in the protocol
                refuses two shelves, and the only symptom is silence — see
                `pairingFault`. */}
            {fault && <div className={ui.hint}>{fault}</div>}
          </div>
        )
      })}

      {/* THE TRANSFER LIST IS GONE, and this is where it was.
          It rendered up to twenty rows of "Transfer 1 — done": a counter, kept
          after the work finished, in a surface nobody opens to watch a
          download. It could not have been written better — `TransferProgress`
          carried no book, so no wording could have said WHICH book. The event
          carries the blob folder now and the answer appears on the shelf row
          the reader clicked, which is where they were already looking. See
          `sync/lib/downloads.ts`. */}

      {/* NOT A PAIRING ACTION. It shared a row with offer and cancel, which is
          how three unrelated things came to sit side by side. Registered only
          on a satchel (`sync/index.ts` — a shelf answers rather than dials),
          so on a shelf it is absent rather than inert. */}
      {syncNow && (
        <div className={ui.actions}>
          <button type="button" className={ui.button} onClick={syncNow}>
            Sync now
          </button>
        </div>
      )}

    </div>
  )
}
