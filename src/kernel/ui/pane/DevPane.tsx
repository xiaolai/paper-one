import { useMemo, useState } from 'react'
import type { DiagnosticEntry, DiagnosticLog } from '../../core/diagnosticsLog'
import styles from './SidePane.module.css'

/**
 * The Developer panel — what this run has reported about itself.
 *
 * ## Why the log and nothing else
 *
 * `diagnosticsLog.ts` was written for two readers and only ever had one. Its
 * header names them: *"a dev pane that wants the window, and a harness over ssh
 * that wants the file."* The file half shipped; this is the pane half, which
 * has been a comment describing a surface that did not exist.
 *
 * The case it records is worth restating, because it is the whole argument for
 * a panel rather than a devtools console. `scripts/sync-scenario.sh` drives two
 * machines over ssh; when a convergence step timed out, the satchel had ALREADY
 * written why — `sync.session-failed`, with the refusal kind — into a console on
 * the far end of an ssh connection. WI-8.6 could not read it, guessed, wrote the
 * guess down as an explanation, and that guess shaped the feature's
 * documentation for weeks. A pane on the machine is what makes the app's own
 * account reachable by the person standing in front of it.
 *
 * ## What is worth looking at, which is not a new question
 *
 * The events already exist and there are about thirty of them. They are not a
 * miscellany — every one was added at the moment somebody could not answer a
 * question without it, which is why the useful set is the recorded set rather
 * than something to design now:
 *
 * - **`boot`, and `composition.*`** — how long the shelf took, whether the
 *   cache was trusted or rescanned (`boot`'s own comment: *"the answer to 'why
 *   is launch slow' is usually `rescanned`"*), and which capabilities started,
 *   failed or were disposed. A capability that did not compose is survivable by
 *   design, so this is the only place it is visible.
 * - **`sync.*`** — sessions, refused pushes, quarantined journals and marks.
 *   The ssh case above is this scope.
 * - **`peer.*`, `webhost.pump`** — roles and the transport under them.
 * - **`inference.*`, `gloss.sentence`** — the runtime, downloads, and whether
 *   the sentence walk is finding real sentences or falling back. That last one
 *   is a RATIO nothing else can show: a build where every lookup falls back and
 *   one where the feature works are otherwise indistinguishable from outside.
 * - **`shutdown.*`** — what did not get to finish.
 *
 * ## What it deliberately does not do
 *
 * **No live tail and no auto-scroll.** A panel that moves while it is being
 * read is a panel nobody can read. It renders the window as it was when the
 * pane was opened or refreshed, and says how many entries fell off the back.
 *
 * **It cannot turn recording on.** That is `DIAGNOSTICS_SWITCH`, a FILE, and
 * `diagnosticsLog.ts` says why: the decision is made at boot, before the
 * services that hold settings exist. A switch here would appear to work and
 * change nothing until the next launch.
 */

/** Newest first, which is where a failure is. */
const NEWEST_FIRST = (a: DiagnosticEntry, b: DiagnosticEntry) => b.at - a.at

/** The levels, in the order a reader narrows by: everything, then the trouble. */
const LEVELS = ['all', 'warn', 'error'] as const
type LevelFilter = (typeof LEVELS)[number]

function keeps(entry: DiagnosticEntry, level: LevelFilter, scope: string): boolean {
  if (level === 'warn' && entry.level === 'info') return false
  if (level === 'error' && entry.level !== 'error') return false
  /* THE SCOPE IS COMPOUND — `sync`, `sync.push` — so a prefix match is what
     "show me sync" means. An exact match would hide every child of the scope
     the reader picked, which is the half they are usually after. */
  return scope === '' || entry.scope === scope || entry.scope.startsWith(`${scope}.`)
}

/** `14:22:31.004` — the time of day, which is what a reader is correlating
 *  against. The date is in the file; nobody reads a pane across midnight. */
function at(ms: number): string {
  const when = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}.${String(when.getMilliseconds()).padStart(3, '0')}`
}

export interface DevPaneProps {
  /** Absent when this build is not recording — see the header. */
  readonly log?: DiagnosticLog | undefined
  /** Whether recording is on at all, which is decided at boot. */
  readonly recording: boolean
  /** Put the window on the clipboard as JSON Lines — the file's own format. */
  readonly onCopy?: ((jsonl: string) => void) | undefined
}

export function DevPane({ log, recording, onCopy }: DevPaneProps) {
  const [level, setLevel] = useState<LevelFilter>('all')
  const [scope, setScope] = useState('')
  /* A NONCE, not a subscription. The log has no `subscribe` — it is written
     from every corner of the app, including boot, and publishing each write
     would re-render this panel during the very work it is recording. The
     reader asks for a fresh read; nothing here moves under them. */
  const [nonce, setNonce] = useState(0)

  const entries = useMemo(() => {
    void nonce
    return log ? [...log.entries()].sort(NEWEST_FIRST) : []
  }, [log, nonce])
  const dropped = useMemo(() => {
    void nonce
    return log?.dropped() ?? 0
  }, [log, nonce])

  /* The scopes actually present, so the filter offers what is there rather
     than a list somebody keeps. Top level only — `sync.push` files under
     `sync`, which is what the prefix match above makes true. */
  const scopes = useMemo(
    () => [...new Set(entries.map((entry) => entry.scope.split('.')[0] ?? entry.scope))].sort(),
    [entries],
  )
  const shown = entries.filter((entry) => keeps(entry, level, scope))

  if (!recording) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>Diagnostics are not being recorded</p>
        <p className={styles.emptyBody}>
          This build records nothing unless it is asked to. Create a file named{' '}
          <code>diagnostics.on</code> in the data directory and relaunch, and what the app reports
          about itself will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className={styles.devPanel}>
      <div className={styles.filterBar}>
        {LEVELS.map((one) => (
          <button
            key={one}
            type="button"
            className={styles.filter}
            data-on={level === one}
            onClick={() => setLevel(one)}
          >
            {one === 'all' ? 'All' : one === 'warn' ? 'Warnings' : 'Errors'}
          </button>
        ))}
        <span className={styles.filterDivider} />
        <select
          className={styles.devScope}
          value={scope}
          onChange={(event) => setScope(event.currentTarget.value)}
          aria-label="Scope"
        >
          <option value="">Every scope</option>
          {scopes.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.devActions}>
        <button type="button" className={styles.devButton} onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </button>
        {onCopy && log && (
          <button type="button" className={styles.devButton} onClick={() => onCopy(log.toJsonl())}>
            Copy as JSONL
          </button>
        )}
        <button
          type="button"
          className={styles.devButton}
          onClick={() => {
            log?.clear()
            setNonce((n) => n + 1)
          }}
        >
          Clear
        </button>
      </div>

      {/* SAID, NOT SWALLOWED. The window is bounded by construction, so a long
          run drops its oldest entries — and a reader who cannot see that the
          window moved will read the first line as the beginning of the run. */}
      {dropped > 0 && (
        <p className={styles.devDropped}>
          {dropped} older {dropped === 1 ? 'entry has' : 'entries have'} fallen out of the window.
        </p>
      )}

      {shown.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing to show</p>
          <p className={styles.emptyBody}>
            {entries.length === 0
              ? 'This run has reported nothing yet.'
              : 'No entry matches these filters.'}
          </p>
        </div>
      ) : (
        <ol className={styles.devLog}>
          {shown.map((entry, index) => (
            <li
              /* THE INDEX IS PART OF THE KEY, and on purpose: two entries can
                 share a millisecond, a scope and an event — a loop that reports
                 per book does exactly that — and a key that collides drops rows
                 silently. The list is re-sorted whole on every read, so there is
                 no reordering for a positional key to get wrong. */
              key={`${entry.at}:${entry.scope}:${entry.event}:${index}`}
              className={styles.devEntry}
              data-level={entry.level}
            >
              <div className={styles.devEntryHead}>
                <span className={styles.devTime}>{at(entry.at)}</span>
                <span className={styles.devScopeTag}>{entry.scope}</span>
                <span className={styles.devEvent}>{entry.event}</span>
              </div>
              {Object.keys(entry.fields).length > 0 && (
                <pre className={styles.devFields}>{JSON.stringify(entry.fields, null, 1)}</pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
