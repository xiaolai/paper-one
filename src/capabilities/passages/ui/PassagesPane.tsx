import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui, messageOf, packSize, type PassageIndexStatus } from '../../../kernel'
import type { PassageIndex } from '../lib/port'
import { theProgress, type Progress, type ProgressHolder } from '../lib/progress'

/**
 * Settings → **Library search**: how much of the shelf can be searched, and
 * which books could not be read.
 *
 * ⚠️ **THE UNREADABLE LIST IS WHAT THIS PANE IS FOR.** *A search that quietly
 * omits a fifth of the library is worse than one that says it is still
 * working* — the phase plan's own words — and a book absent from the index is
 * otherwise indistinguishable from a book with no matches. Every other number
 * here is context for that list.
 *
 * ⚠️ **AND THE TEXT SITS IN A `paper-cap-grow`, WHICH TRUNCATES.** Phase 30
 * shipped a Voices pane whose size, languages and memory floor were in the DOM
 * the whole time and clipped from 585 px into 271 px — invisible to every
 * query and to every test, and found only by looking at the running app. The
 * counts here are therefore in the row's `value`, which is the quiet right-hand
 * side and is sized to its contents, and the long prose is in a `hint`, which
 * wraps.
 */

/** How often the status is re-read while the pane is open. */
export const POLL_MS = 5_000

/**
 * How many unreadable books are listed before the rest are counted.
 *
 * A shelf where a hundred books failed is a fact worth stating; a hundred rows
 * is a panel nobody scrolls to the end of.
 */
export const LISTED = 12

/** The size of the whole index, as a sentence. */
export function sizeLine(status: PassageIndexStatus): string {
  /* ⚠️ **BOTH HALVES, BECAUSE BOTH ARE ON THE DISK.** The postings are what
   * answers a query and the retained text is what makes a tokenizer change cost
   * a rebuild instead of re-reading every book — reporting only the first would
   * understate what the feature occupies by roughly half, which is the number a
   * reader deciding whether to keep it actually needs. */
  return `${packSize(status.indexBytes + status.textBytes)} · ${packSize(status.indexBytes)} of it postings`
}

/**
 * Whether the build is still going, and roughly how far — WI-31.7's own words.
 *
 * ⚠️ **A COUNT ALONE IS NOT "HOW FAR".** *"300 books"* on a shelf of 1 959 reads
 * as a finished index that found three hundred books, and there is nothing on
 * the screen to say otherwise. The shelf's own count is the denominator, and
 * only the capability has it — see `lib/progress.ts`.
 *
 * `null` when there is nothing to say: no sweep has run in this process, so any
 * denominator would be invented.
 */
export function buildLine(status: PassageIndexStatus, progress: Progress): string | null {
  if (progress.wanted === 0) return null
  if (!progress.sweeping && progress.swept) return null
  const done = Math.min(status.books, progress.wanted)
  return progress.sweeping
    ? `Building · ${done} of ${progress.wanted} books`
    : `Paused · ${done} of ${progress.wanted} books`
}

/**
 * What the index covers, as a sentence.
 *
 * ⚠️ **`books` IS A COUNT AND MAY BE ZERO, so it is not put through a formatter
 * that refuses zero.** `sizeOf` in the Voices pane refuses zero correctly, for a
 * pack's SIZE — and phase 30 shipped *"Downloading · unknown size of 2.3 GB"*
 * by sending a count of received bytes through it. A function that refuses a
 * value because it is meaningless as one kind of quantity is the wrong function
 * for another kind where that value is ordinary.
 */
export function coverageLine(status: PassageIndexStatus): string {
  if (status.books === 0) return 'Nothing indexed yet'
  const books = `${status.books} ${status.books === 1 ? 'book' : 'books'}`
  const sections = `${status.sections} ${status.sections === 1 ? 'chapter' : 'chapters'}`
  return `${books} · ${sections}`
}

/** The sentence about books that could not be read, or null when there are none. */
export function unreadableLine(status: PassageIndexStatus): string | null {
  const count = status.unreadable.length
  if (count === 0) return null
  return count === 1
    ? '1 book could not be read, so it cannot be searched:'
    : `${count} books could not be read, so they cannot be searched:`
}

export function PassagesPane({
  port,
  progress = theProgress,
}: {
  readonly port: PassageIndex
  /** The app's holder; a case passes its own so two cannot leak into each other. */
  readonly progress?: ProgressHolder
}) {
  /* ⚠️ **SUBSCRIBED RATHER THAN POLLED.** The status is re-read on a timer
   * because it is the plugin's and crossing the IPC is what costs; this is in
   * the same process and changes exactly twice per sweep. */
  const building = useSyncExternalStore(progress.subscribe, progress.get, progress.get)
  const [status, setStatus] = useState<PassageIndexStatus | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [retrying, setRetrying] = useState(false)
  /* ⚠️ **A REF, NOT THE RENDERED FLAG.** `disabled` only exists on the render
   * that has not happened yet, so two presses before React commits the first
   * both see the old state and both start a rebuild. Phase 30's `VoicesPane.remove`
   * had exactly this defect and `useAudiobook` records it too. */
  const busy = useRef(false)
  /* Which read is the current one. An identity rather than a counter: whether
   * two increments could ever bring a number back to one an in-flight
   * continuation still holds is an argument, and an empty object cannot
   * collide by construction. */
  const asked = useRef<object>({})

  const read = useCallback(async () => {
    const mine = {}
    asked.current = mine
    try {
      const fresh = await port.status()
      if (asked.current !== mine) return
      setStatus(fresh)
      setFailed(null)
    } catch (cause) {
      if (asked.current !== mine) return
      /* ⚠️ **A FAILED READ IS SAID, NOT SHOWN AS ZERO.** `statusOf` refuses a
       * malformed answer rather than defaulting it, and this is the other end
       * of that decision: reported as zeroes, a reader is told nothing is
       * indexed while the shelf is in fact fully searchable. */
      setFailed(messageOf(cause))
    }
  }, [port])

  useEffect(() => {
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => clearInterval(timer)
  }, [read])

  const retry = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setRetrying(true)
    try {
      await port.retry()
      /* READ BACK, so the list empties on screen rather than waiting out the
       * poll. The books are not re-extracted here — that is the next sweep's —
       * and the list emptying is the honest report of what this button did. */
      await read()
    } catch (cause) {
      setFailed(messageOf(cause))
    } finally {
      busy.current = false
      setRetrying(false)
    }
  }, [port, read])

  const rebuild = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setRebuilding(true)
    try {
      await port.rebuild()
      await read()
    } catch (cause) {
      setFailed(messageOf(cause))
    } finally {
      busy.current = false
      setRebuilding(false)
    }
  }, [port, read])

  if (failed !== null) {
    return (
      <div className={ui.section}>
        <div className={ui.row}>
          <span className={ui.grow}>Library search</span>
        </div>
        <div className={ui.hint}>The index could not be read: {failed}</div>
      </div>
    )
  }

  if (status === null) {
    return (
      <div className={ui.section}>
        <div className={ui.hint}>Reading the index…</div>
      </div>
    )
  }

  const missing = unreadableLine(status)
  const listed = status.unreadable.slice(0, LISTED)
  const rest = status.unreadable.length - listed.length

  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Indexed</span>
        <span className={ui.value}>{coverageLine(status)}</span>
      </div>
      {buildLine(status, building) !== null && (
        <div className={ui.row}>
          <span className={ui.grow}>Progress</span>
          <span className={ui.value}>{buildLine(status, building)}</span>
        </div>
      )}
      <div className={ui.row}>
        <span className={ui.grow}>On disk</span>
        <span className={ui.value}>{sizeLine(status)}</span>
      </div>
      <div className={ui.hint}>
        Paper builds this from books already on this device. Nothing is sent
        anywhere, and searching works on whatever has been indexed so far.
      </div>

      {missing !== null && (
        <>
          <div className={ui.hint}>{missing}</div>
          {listed.map((one) => (
            <div className={ui.row} key={one.bookId}>
              {/* ⚠️ **THE TITLE, AND IT WAS THE ID.** Observed on the real
                  shelf: twenty-one rows of
                  `book:d2ce87555111dbb3472e62b5c8a763c3`, every record
                  accurate and the panel useless, because a reader cannot tell
                  which of their books is missing from search. The id is the
                  fallback for a book the shelf no longer has — which is a real
                  state, since a note outlives the book it is about until the
                  next sweep's diff. */}
              <span className={ui.grow}>{progress.titleOf(one.bookId) ?? one.bookId}</span>
              <span className={ui.value}>{one.why}</span>
            </div>
          ))}
          {rest > 0 && <div className={ui.hint}>…and {rest} more.</div>}
          {/* ⚠️ **THE REMEDY FOR A BOOK RECORDED IN ERROR, AND WITHOUT IT THERE
              IS NONE.** A note is what stops a book that yields nothing being
              re-parsed on every sweep for ever — and a disk that was momentarily
              busy produces exactly the same record, which nothing can tell apart
              from a thrown value. Recorded, that book would never be looked at
              again until its bytes changed. Rebuilding does NOT clear them, on
              purpose: re-deriving postings says nothing about which books could
              not be EXTRACTED. */}
          <div className={ui.actions}>
            <button
              type="button"
              className={ui.button}
              onClick={() => void retry()}
              disabled={retrying}
            >
              {retrying ? 'Trying again…' : 'Try these again'}
            </button>
          </div>
        </>
      )}

      <div className={ui.actions}>
        <button
          type="button"
          className={ui.button}
          onClick={() => void rebuild()}
          disabled={rebuilding}
        >
          {rebuilding ? 'Rebuilding…' : 'Rebuild the index'}
        </button>
      </div>
      <div className={ui.hint}>
        Rebuilding reads the text Paper already saved and opens no books. It is
        what a change to how words are split costs.
      </div>
    </div>
  )
}
