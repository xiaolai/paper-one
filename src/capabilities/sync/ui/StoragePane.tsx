import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import { DEGRADED_DETAIL } from '../lib/status'
import { COVER_CAP_MAX_MB, COVER_CAP_MIN_MB } from './storageModel'
import type { StorageModel } from './storageModel'

/**
 * The Storage section (WI-C.5), rendered by the kernel's Settings pane: what
 * is downloaded, what covers cost, and how the last sync went.
 *
 * MOST decisions live in `storageModel.ts` — what counts as a download, the
 * cap's range, when a read is worth doing. This file is not a pure adapter,
 * and saying it was hid the ones it makes:
 *
 *   - WHICH STATUS LINE to show, and in what order of precedence.
 *   - WHEN A TYPED CAP IS COMMITTED — on blur or Enter, never per keystroke,
 *     because a per-keystroke commit turned `250` into a one-megabyte cap
 *     that evicted almost every cover before the second digit arrived.
 *   - WHAT AN EMPTY FIELD MEANS: no edit, not a cap of zero.
 *   - WHAT EACH DESTRUCTIVE BUTTON IS CALLED to a screen reader.
 *
 * All four are covered by `StoragePane.test.tsx`, which exists because none of
 * them were.
 *
 * Drawn with `CAPABILITY_UI`, the kernel's public class vocabulary — see the
 * note on `DevicesPane`. Nothing here invents a colour, a radius or a height.
 */

/**
 * Bytes, in the unit a reader can hold in their head.
 *
 * `null` is "nobody can say" and is a REAL answer here, not a defensive
 * branch: `SizePort` returns it for a directory it could not walk, which is
 * what the cover total and a book's size both come from. An em dash rather
 * than `0 B`, which would be a measurement nobody made.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function StoragePane({ model }: { readonly model: StorageModel }) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  /* The text being typed, or `null` when the field shows the committed value.
   * Held here rather than in the model because it is not a decision yet — it
   * is a half-finished one. */
  const [draft, setDraft] = useState<string | null>(null)
  const commitCap = useCallback(() => {
    if (draft === null) return
    const wanted = Number(draft)
    setDraft(null)
    /* The model refuses anything outside its own range, so a typo simply
     * leaves the committed value where it was. */
    if (draft.trim() !== '') void model.setCoverCapMB(wanted)
  }, [draft, model])
  useEffect(() => {
    void model.refresh()
  }, [model])

  const { status } = snapshot
  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Sync</span>
        {/* A LIVE REGION, because this changes without the reader doing
            anything — a sync starting, a peer going away. Announced politely
            so it waits for a pause rather than interrupting. */}
        <span className={ui.value} role="status" aria-live="polite">
          {status.state === 'degraded'
            ? (status.detail ?? DEGRADED_DETAIL)
            : status.state === 'syncing'
              ? 'Syncing…'
              : /* A DETAIL IS SHOWN WHATEVER THE STATE. `detail` was read only
                   when degraded, and production supplies one while idle too —
                   "Peer plugin unavailable" is the reason there will never be
                   a sync, and it was dropped in favour of "Not synced yet",
                   which reads as "not yet" rather than "not ever". */
                (status.detail ??
                  (status.lastSyncAt
                    ? `Last synced ${new Date(status.lastSyncAt).toLocaleTimeString()}`
                    : 'Not synced yet'))}
        </span>
      </div>

      {/* WHAT WENT WRONG, when something did. Every action here used to
          discard its rejection, so a failed eviction or an unsaved cap left
          the pane unchanged and the reader with no way to tell a refusal from
          a no-op. Also a live region: it appears without them doing anything
          further. */}
      {snapshot.failure !== null && (
        <div className={ui.row} role="alert">
          <span className={ui.grow}>{snapshot.failure}</span>
        </div>
      )}

      <div className={ui.row}>
        <span className={ui.grow}>Downloaded books</span>
        <span className={ui.value}>{snapshot.downloadCount}</span>
      </div>
      {/* THE COUNT IS THE TOTAL; THE ROWS ARE THE BIGGEST FEW.
          Every download used to be rendered, so a satchel holding a few
          hundred books paid for a few hundred rows every time Settings opened
          — and again on every shelf write while it stayed open — for a list
          nobody scrolls to the end of. The model bounds it and says how many
          it left out, which is said here rather than silently dropped. */}
      {snapshot.downloads.map((download) => (
        <div key={download.book} className={ui.row}>
          <span className={ui.grow}>{download.title}</span>
          <span className={ui.value}>{formatBytes(download.size)}</span>
          <button
            type="button"
            className={`${ui.button} ${ui.buttonDanger}`}
            disabled={snapshot.busy === download.book}
            /* NAMED PER BOOK. Every one of these was called "Evict", so a
               screen reader moving through a shelf of downloads heard the same
               word repeatedly with no way to tell which book it would free —
               on a destructive action. The visible label stays short. */
            aria-label={`Evict ${download.title}`}
            onClick={() => void model.removeDownload(download.book)}
          >
            Evict
          </button>
        </div>
      ))}

      {snapshot.downloadCount > snapshot.downloads.length && (
        <div className={ui.row}>
          <span className={ui.grow}>
            {`Showing the ${snapshot.downloads.length} largest of ${snapshot.downloadCount}.`}
          </span>
        </div>
      )}

      <div className={ui.row}>
        <span className={ui.grow}>Cover cache</span>
        <span className={ui.value}>{formatBytes(snapshot.coverBytes)} of</span>
        <input
          type="number"
          min={COVER_CAP_MIN_MB}
          max={COVER_CAP_MAX_MB}
          step={1}
          value={draft ?? snapshot.coverCapMB}
          aria-label="Cover cache cap, megabytes"
          className={`${ui.field} ${ui.fieldNarrow}`}
          /* COMMITTED WHEN THE EDIT IS FINISHED, not per keystroke. `onChange`
             fires on every character and each one wrote the setting and ran an
             eviction — so replacing `200` with `250` committed `2` first, and a
             one-megabyte cap evicted almost every cover before the second digit
             arrived. Covers do not come back; they are re-fetched from a peer,
             or not at all. */
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitCap}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitCap()
            /* Escape abandons the edit rather than committing it. */
            if (event.key === 'Escape') setDraft(null)
          }}
        />
        <span className={ui.value}>MB</span>
      </div>
    </div>
  )
}
