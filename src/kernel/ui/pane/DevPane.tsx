import { useMemo, useState } from 'react'
import type { DiagnosticEntry, DiagnosticLog } from '../../core/diagnosticsLog'
import type { CopyOutcome } from '../clipboard'
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

/**
 * Newest first, which is where a failure is.
 *
 * ⚠️ **REVERSED, AND IT USED TO SORT BY TIMESTAMP.** `Array.sort` is stable, so
 * entries sharing a millisecond kept their relative order — which is
 * OLDEST-first, the exact opposite of this panel's one ordering claim. Boot
 * writes several per millisecond (`composition.started`, then a `started` per
 * capability), so the case is not rare; it is the first screen a reader sees.
 *
 * The log's contract is already insertion order, oldest first, so reversing it
 * is both correct and cheaper than a comparator — and it does the right thing
 * across a clock that steps backwards, which a timestamp sort cannot.
 */
const newestFirst = (entries: readonly DiagnosticEntry[]): DiagnosticEntry[] => [...entries].reverse()

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

/**
 * The first segment of a compound scope — `sync` for `sync.push`.
 *
 * `split` always yields at least one element, so the `?? entry.scope` this
 * replaces was unreachable: `noUncheckedIndexedAccess` types it as possibly
 * undefined and the runtime never produces that. A fallback that cannot fire
 * reads as a case somebody thought about.
 */
function topScope(scope: string): string {
  return scope.slice(0, scope.indexOf('.') === -1 ? scope.length : scope.indexOf('.'))
}

/**
 * The fields, as text, whatever they turn out to be.
 *
 * ⚠️ **`JSON.stringify` IS NOT TOTAL, AND THIS WAS AN UNGUARDED CALL IN A
 * RENDER.** A `bigint` throws `TypeError`; so does a cycle. `Diagnostics`
 * redacts before anything reaches the log, but redaction is about SECRETS — it
 * bounds depth, width and string length and does not promise the result is
 * JSON-serialisable, and `fields` is `Record<string, unknown>` from every
 * caller in the app. One `report()` with a `bigint` in it would have taken the
 * whole panel down, on the surface a reader opens BECAUSE something is already
 * wrong. Found by audit.
 */
function fieldsText(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(fields, (_key, value) => (typeof value === 'bigint' ? `${value}n` : value), 1) ?? ''
  } catch {
    /* A cycle, or a `toJSON` that threw. The entry is still worth showing —
       its time, scope and event are what a reader is scanning for — so the
       fields degrade to a note rather than taking the row with them. */
    return '[fields could not be rendered]'
  }
}

/** `14:22:31.004` — the time of day, which is what a reader is correlating
 *  against. See `at`, which adds the date when the window spans one. */
function at(ms: number, withDate: boolean): string {
  const when = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  const clock = `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}.${String(when.getMilliseconds()).padStart(3, '0')}`
  /* ⚠️ **THE DATE APPEARS WHEN THE WINDOW SPANS ONE**, and it used to be
   * omitted outright under the reasoning that "nobody reads a pane across
   * midnight". A machine left running for days is precisely the case this panel
   * exists for — `sync-scenario.sh` drives two of them — so `03:14:07` with no
   * date is ambiguous exactly when the log is most worth reading. Shown only
   * when it distinguishes something, so an ordinary session keeps the short
   * form the eye can scan. */
  return withDate ? `${two(when.getMonth() + 1)}-${two(when.getDate())} ${clock}` : clock
}

/** Whether the window covers more than one local day — see `at`. */
function spansDays(entries: readonly DiagnosticEntry[]): boolean {
  if (entries.length < 2) return false
  const day = (ms: number) => new Date(ms).toDateString()
  const first = day(entries[0]!.at)
  return entries.some((entry) => day(entry.at) !== first)
}

export interface DevPaneProps {
  /** Absent when this build is not recording — see the header. */
  readonly log?: DiagnosticLog | undefined
  /** Whether recording is on at all, which is decided at boot. */
  readonly recording: boolean
  /**
   * Put the window on the clipboard as JSON Lines — the file's own format.
   *
   * ⚠️ **IT REPORTS, AND IT USED TO BE FIRE-AND-FORGET.** Typed as returning
   * nothing and called without a `catch`, a refused clipboard was an unhandled
   * rejection reaching the global fatal handler and a button that appeared to
   * work. `writeClipboard` answers with an outcome; this awaits it.
   */
  readonly onCopy?: ((jsonl: string) => Promise<CopyOutcome>) | undefined
  /**
   * Told after the window is cleared, so the file can catch up.
   *
   * ⚠️ **CLEARING EMPTIED MEMORY AND LEFT THE FILE.** `diagnostics.jsonl` is a
   * PROJECTION of the window — rewritten whole, which is the property that
   * makes it need no rotation — so a clear that did not tell the spool left the
   * file holding entries the app no longer has, until the next report happened
   * to rewrite it. A harness reading that file over ssh would have read the
   * past.
   */
  readonly onCleared?: (() => void) | undefined
}

export function DevPane({ log, recording, onCopy, onCleared }: DevPaneProps) {
  /** What the copy button last did. Cleared when the reader asks again. */
  const [copied, setCopied] = useState<CopyOutcome | null>(null)
  const [level, setLevel] = useState<LevelFilter>('all')
  const [scope, setScope] = useState('')
  /* A NONCE, not a subscription. The log has no `subscribe` — it is written
     from every corner of the app, including boot, and publishing each write
     would re-render this panel during the very work it is recording. The
     reader asks for a fresh read; nothing here moves under them. */
  const [nonce, setNonce] = useState(0)

  /* ONE SNAPSHOT, not two reads of the same log a nonce apart: the entries and
     the dropped count describe the same moment and are drawn together. */
  const { entries, dropped } = useMemo(() => {
    void nonce
    return log
      ? { entries: newestFirst(log.entries()), dropped: log.dropped() }
      : { entries: [] as DiagnosticEntry[], dropped: 0 }
  }, [log, nonce])

  /* The scopes actually present, so the filter offers what is there rather
     than a list somebody keeps. Top level only — `sync.push` files under
     `sync`, which is what the prefix match above makes true. */
  const scopes = useMemo(
    () => [...new Set(entries.map((entry) => topScope(entry.scope)))].sort(),
    [entries],
  )
  const shown = entries.filter((entry) => keeps(entry, level, scope))
  const dated = spansDays(entries)

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
          <button
            type="button"
            className={styles.devButton}
            onClick={() => {
              setCopied(null)
              void onCopy(log.toJsonl()).then(setCopied)
            }}
          >
            {copied === 'copied'
              ? 'Copied'
              : copied === 'refused'
                ? 'Clipboard refused'
                : copied === 'absent'
                  ? 'No clipboard here'
                  : 'Copy as JSONL'}
          </button>
        )}
        <button
          type="button"
          className={styles.devButton}
          onClick={() => {
            log?.clear()
            /* THE FILE IS A PROJECTION OF THE WINDOW, so emptying one without
               the other leaves the reader's own harness reading the past. */
            onCleared?.()
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
                <span className={styles.devTime}>{at(entry.at, dated)}</span>
                <span className={styles.devScopeTag}>{entry.scope}</span>
                <span className={styles.devEvent}>{entry.event}</span>
              </div>
              {Object.keys(entry.fields).length > 0 && (
                <pre className={styles.devFields}>{fieldsText(entry.fields)}</pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
