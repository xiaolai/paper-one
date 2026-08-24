import { useState, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import type { DevicesModel } from './devicesModel'
import {
  ROLE_CHOICES,
  canJoinWithCode,
  canOfferInvite,
  describeGrants,
  describeRole,
  grantsAreEnforceable,
  inlineQrSvg,
  pairingFault,
  peerCanWrite,
  roleIsSettable,
} from './devicesModel'

/**
 * The Devices section (WI-C.5), rendered by the kernel's Settings pane as a
 * contributed section. Everything it DECIDES lives in `devicesModel.ts`,
 * which is where the tests are (the no-jsdom rule); this file only draws
 * the snapshot and forwards intents.
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
  const setCopied = (ok: boolean) => setCopiedFor(ok ? (snapshot.offer?.url ?? null) : null)

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
      {roleIsSettable(snapshot.peers) && (
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
                onClick={() => void model.setRole(choice.role)}
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

      {/* The desktop stays reachable only while Paper runs — stated, per the plan. */}
      <div className={ui.hint}>Syncing needs Paper running on your Mac; the tray keeps it alive with the window closed.</div>

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
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }}
            >
              {copied ? 'Copied' : 'Copy invite code'}
            </button>
            <button type="button" className={ui.button} onClick={() => void model.cancelPairing()}>
              Cancel
            </button>
          </div>
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
              if (code.trim()) void model.pairWithCode(code)
              setCode('')
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
            On the Mac that holds your library, choose “Pair a new device” and copy the invite.
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
                  onChange={(event) => void model.setPeerCanWrite(peer.id, event.target.checked)}
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
