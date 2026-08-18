import { useState, useSyncExternalStore } from 'react'
import type { DevicesModel } from './devicesModel'
import { qrDataUri } from './devicesModel'

/**
 * The Devices section (WI-C.5), rendered by the kernel's Settings pane as a
 * contributed section. Everything it DECIDES lives in `devicesModel.ts`,
 * which is where the tests are (the no-jsdom rule); this file only draws
 * the snapshot and forwards intents.
 */

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }
const dim: React.CSSProperties = { opacity: 0.7, fontSize: '0.85em' }

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
    return <div style={dim}>Devices need the Paper app — there is no peer plugin in a browser tab.</div>
  }

  return (
    <div>
      <div style={row}>
        <span style={{ flex: 1 }}>This device</span>
        <span style={dim}>
          {snapshot.role ?? '…'} · {snapshot.endpointId ? `${snapshot.endpointId.slice(0, 8)}…` : '…'}
        </span>
      </div>

      {/* The desktop stays reachable only while Paper runs — stated, per the plan. */}
      <div style={dim}>Syncing needs Paper running on your Mac; the tray keeps it alive with the window closed.</div>

      <div style={row}>
        <button type="button" onClick={() => void model.beginPairing()}>
          Pair a new device…
        </button>
        {snapshot.offer && (
          <button type="button" onClick={() => void model.cancelPairing()}>
            Cancel pairing
          </button>
        )}
        {syncNow && (
          <button type="button" onClick={syncNow}>
            Sync now
          </button>
        )}
      </div>

      {snapshot.offer && (
        <div>
          <img src={qrDataUri(snapshot.offer.svg)} alt="Pairing QR code" width={192} height={192} />
          <div style={dim}>Scan from the other device, or paste the code below there.</div>
          <code style={{ fontSize: '0.75em', wordBreak: 'break-all' }}>{snapshot.offer.url}</code>
        </div>
      )}

      <form
        style={row}
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
          style={{ flex: 1 }}
        />
        <button type="submit">Pair</button>
      </form>

      {snapshot.sas && (
        <div style={row}>
          <span>
            Confirm on the other device. Code: <strong>{snapshot.sas}</strong>
          </span>
        </div>
      )}

      {snapshot.pending && (
        <div style={row}>
          <span style={{ flex: 1 }}>
            “{snapshot.pending.name}” ({snapshot.pending.platform}) asks to pair. Code: <strong>{snapshot.pending.sas}</strong>
          </span>
          <button type="button" onClick={() => void model.confirmPairing(true)}>
            Pair
          </button>
          <button type="button" onClick={() => void model.confirmPairing(false)}>
            Refuse
          </button>
        </div>
      )}

      {snapshot.lastResult && !snapshot.lastResult.ok && (
        <div style={dim}>Pairing did not finish: {snapshot.lastResult.reason ?? 'refused'}.</div>
      )}
      {snapshot.error && <div style={dim}>Something failed: {snapshot.error}</div>}

      {snapshot.peers.map((peer) => (
        <div key={peer.id} style={row}>
          <span style={{ flex: 1 }}>
            {peer.name}
            <span style={dim}>
              {' '}
              · {peer.role} · {peer.grants.length ? peer.grants.join(', ') : 'no grants'}
              {peer.lastSeenAt ? ` · seen ${new Date(peer.lastSeenAt).toLocaleString()}` : ''}
            </span>
          </span>
          <button type="button" onClick={() => void model.forget(peer.id)}>
            Revoke
          </button>
        </div>
      ))}

      {snapshot.transfers.length > 0 && (
        <div>
          {snapshot.transfers.map((transfer) => (
            <div key={transfer.transferId} style={{ ...row, ...dim }}>
              <span style={{ flex: 1 }}>Transfer {transfer.transferId}</span>
              <span>
                {transfer.state === 'running'
                  ? `${Math.round((transfer.received / Math.max(1, transfer.total)) * 100)}%`
                  : transfer.state === 'failed'
                    ? `failed (${transfer.error ?? 'unknown'})`
                    : 'done'}
              </span>
            </div>
          ))}
        </div>
      )}

      <label style={row}>
        <span style={{ flex: 1 }}>Local network only</span>
        <input
          type="checkbox"
          checked={snapshot.localOnly}
          onChange={(event) => model.setLocalOnly(event.target.checked)}
        />
      </label>
      <div style={dim}>Saved now; keeping the connection off relays lands with the two-instance work.</div>
    </div>
  )
}
