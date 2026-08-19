import { useEffect, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import { DEGRADED_DETAIL } from '../lib/status'
import type { StorageModel } from './storageModel'

/**
 * The Storage section (WI-C.5), rendered by the kernel's Settings pane.
 * Decisions live in `storageModel.ts` (tested, no React); this adapter
 * draws the snapshot: what is downloaded, what covers cost, and how the
 * last sync went.
 *
 * Drawn with `CAPABILITY_UI`, the kernel's public class vocabulary — see the
 * note on `DevicesPane`. Nothing here invents a colour, a radius or a height.
 */

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
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Sync</span>
        <span className={ui.value}>
          {status.state === 'degraded'
            ? (status.detail ?? DEGRADED_DETAIL)
            : status.state === 'syncing'
              ? 'Syncing…'
              : status.lastSyncAt
                ? `Last synced ${new Date(status.lastSyncAt).toLocaleTimeString()}`
                : 'Not synced yet'}
        </span>
      </div>

      <div className={ui.row}>
        <span className={ui.grow}>Downloaded books</span>
        <span className={ui.value}>{snapshot.downloads.length}</span>
      </div>
      {snapshot.downloads.map((download) => (
        <div key={download.book} className={ui.row}>
          <span className={ui.grow}>{download.title}</span>
          <span className={ui.value}>{formatBytes(download.size)}</span>
          <button
            type="button"
            className={`${ui.button} ${ui.buttonDanger}`}
            disabled={snapshot.busy === download.book}
            onClick={() => void model.removeDownload(download.book)}
          >
            Remove download
          </button>
        </div>
      ))}

      <div className={ui.row}>
        <span className={ui.grow}>Cover cache</span>
        <span className={ui.value}>{formatBytes(snapshot.coverBytes)} of</span>
        <input
          type="number"
          min={1}
          value={snapshot.coverCapMB}
          aria-label="Cover cache cap, megabytes"
          className={`${ui.field} ${ui.fieldNarrow}`}
          onChange={(event) => void model.setCoverCapMB(Number(event.target.value))}
        />
        <span className={ui.value}>MB</span>
      </div>
    </div>
  )
}
