import { useState, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import type { DevicesModel } from './devicesModel'
import { qrDataUri } from './devicesModel'

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
        <span className={ui.value}>
          {snapshot.role ?? '…'} · {snapshot.endpointId ? `${snapshot.endpointId.slice(0, 8)}…` : '…'}
        </span>
      </div>

      {/* The desktop stays reachable only while Paper runs — stated, per the plan. */}
      <div className={ui.hint}>Syncing needs Paper running on your Mac; the tray keeps it alive with the window closed.</div>

      <div className={ui.actions}>
        <button type="button" className={ui.button} onClick={() => void model.beginPairing()}>
          Pair a new device…
        </button>
        {snapshot.offer && (
          <button type="button" className={ui.button} onClick={() => void model.cancelPairing()}>
            Cancel pairing
          </button>
        )}
        {syncNow && (
          <button type="button" className={ui.button} onClick={syncNow}>
            Sync now
          </button>
        )}
      </div>

      {snapshot.offer && (
        <div className={ui.figure}>
          <img src={qrDataUri(snapshot.offer.svg)} alt="Pairing QR code" width={192} height={192} />
          <div className={ui.hint}>Scan from the other device, or paste the code below there.</div>
          <code className={ui.code}>{snapshot.offer.url}</code>
        </div>
      )}

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
          placeholder="Pair with a code (paper://pair?…)"
          aria-label="Pairing code"
          className={ui.field}
        />
        {/* The one action this surface is FOR — see `CAPABILITY_UI.button`. */}
        <button type="submit" className={`${ui.button} ${ui.buttonPrimary}`}>
          Pair
        </button>
      </form>

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

      {snapshot.peers.map((peer) => (
        <div key={peer.id} className={ui.row}>
          <span className={ui.grow}>
            {peer.name}
            <span className={ui.value}>
              {' '}
              · {peer.role} · {peer.grants.length ? peer.grants.join(', ') : 'no grants'}
              {peer.lastSeenAt ? ` · seen ${new Date(peer.lastSeenAt).toLocaleString()}` : ''}
            </span>
          </span>
          <button type="button" className={`${ui.button} ${ui.buttonDanger}`} onClick={() => void model.forget(peer.id)}>
            Revoke
          </button>
        </div>
      ))}

      {snapshot.transfers.map((transfer) => (
        <div key={transfer.transferId} className={ui.row}>
          <span className={ui.grow}>Transfer {transfer.transferId}</span>
          <span className={ui.value}>
            {transfer.state === 'running'
              ? `${Math.round((transfer.received / Math.max(1, transfer.total)) * 100)}%`
              : transfer.state === 'failed'
                ? `failed (${transfer.error ?? 'unknown'})`
                : 'done'}
          </span>
        </div>
      ))}

      <label className={ui.row}>
        <span className={ui.grow}>Local network only</span>
        <input
          type="checkbox"
          className={ui.toggle}
          checked={snapshot.localOnly}
          onChange={(event) => model.setLocalOnly(event.target.checked)}
        />
      </label>
      <div className={ui.hint}>Saved now; keeping the connection off relays lands with the two-instance work.</div>
    </div>
  )
}
