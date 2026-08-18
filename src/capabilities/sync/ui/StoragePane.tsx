import { useEffect, useSyncExternalStore } from 'react'
import { DEGRADED_DETAIL } from '../lib/status'
import type { StorageModel } from './storageModel'

/**
 * The Storage section (WI-C.5), rendered by the kernel's Settings pane.
 * Decisions live in `storageModel.ts` (tested, no React); this adapter
 * draws the snapshot: what is downloaded, what covers cost, and how the
 * last sync went.
 */

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }
const dim: React.CSSProperties = { opacity: 0.7, fontSize: '0.85em' }

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function StoragePane({ model }: { readonly model: StorageModel }) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  useEffect(() => {
    void model.refresh()
  }, [model])

  const { status } = snapshot
  return (
    <div>
      <div style={row}>
        <span style={{ flex: 1 }}>Sync</span>
        <span style={dim}>
          {status.state === 'degraded'
            ? (status.detail ?? DEGRADED_DETAIL)
            : status.state === 'syncing'
              ? 'Syncing…'
              : status.lastSyncAt
                ? `Last synced ${new Date(status.lastSyncAt).toLocaleTimeString()}`
                : 'Not synced yet'}
        </span>
      </div>

      <div style={row}>
        <span style={{ flex: 1 }}>Downloaded books</span>
        <span style={dim}>{snapshot.downloads.length}</span>
      </div>
      {snapshot.downloads.map((download) => (
        <div key={download.book} style={row}>
          <span style={{ flex: 1 }}>{download.title}</span>
          <span style={dim}>{formatBytes(download.size)}</span>
          <button
            type="button"
            disabled={snapshot.busy === download.book}
            onClick={() => void model.removeDownload(download.book)}
          >
            Remove download
          </button>
        </div>
      ))}

      <div style={row}>
        <span style={{ flex: 1 }}>Cover cache</span>
        <span style={dim}>{formatBytes(snapshot.coverBytes)} of</span>
        <input
          type="number"
          min={1}
          value={snapshot.coverCapMB}
          aria-label="Cover cache cap, megabytes"
          style={{ width: '5em' }}
          onChange={(event) => void model.setCoverCapMB(Number(event.target.value))}
        />
        <span style={dim}>MB</span>
      </div>
    </div>
  )
}
