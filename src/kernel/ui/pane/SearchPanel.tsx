import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { ICON } from '../../core/metrics'
import type { Book, SearchHit } from '../hooks/useBook'
import styles from './SidePane.module.css'

/**
 * What searching a book actually needs — five fields, not the whole `Book`.
 *
 * WHY THIS IS NARROWED. The prop was `Book`, an interface of two dozen members
 * covering opening, closing, marks, footnotes and speech. This pane reads five
 * of them, and declaring the other nineteen made it mountable only by a host
 * that could produce a whole reading session. The browser client has a
 * navigator with `search` and `goTo` and knows what it opened; it could satisfy
 * the five and not the twenty-four.
 *
 * Written as indexed access into `Book` rather than restated, so the two cannot
 * drift: change `search`'s signature and this fails to compile with it. Every
 * existing caller passes a `Book` and still type-checks — a narrower prop
 * accepts a wider argument, which is the whole point.
 */
export interface SearchableBook {
  readonly source: Book['source']
  readonly meta: Book['meta']
  readonly error: Book['error']
  readonly search: Book['search']
  readonly goTo: Book['goTo']
}

export interface SearchPanelProps {
  book: SearchableBook
}

/** Long enough that typing does not start a full-book scan per keystroke. */
const DEBOUNCE_MS = 250

/** Bounded so a common word cannot stream thousands of rows into the pane. */
const MAX_HITS = 200

/**
 * The results, and the query they belong to, as ONE value.
 *
 * Held apart — hits in one state, a status in another, the query in a third —
 * they can disagree, and they did on the frame that mattered most. Clearing
 * them at the top of the effect is not soon enough: an effect runs after paint,
 * so the render that first sees a new query still holds the old query's status,
 * and the panel announced "No matches for X" before anything had looked for X.
 * It was there for one frame per keystroke, which is exactly long enough to
 * read and impossible to catch in a test that waits for the search.
 *
 * One value cannot contradict itself: `needle` says what these hits are FOR, so
 * anything that does not match the query on screen is not a result yet.
 */
interface SearchResult {
  readonly needle: string
  readonly hits: readonly SearchHit[]
  readonly state: 'searching' | 'done' | 'failed'
}

/**
 * Search, over the open book.
 *
 * foliate walks the whole spine and yields hits as it finds them, so results
 * stream in rather than arriving at once — and every hit carries a CFI, which
 * is what makes a result navigable. Previously this filtered a fixture array
 * and handed chapter labels to `goTo`, which navigated nowhere.
 *
 * Still scoped to the OPEN BOOK. Searching the whole library needs the Tantivy
 * index the handoff describes, and the pane's "instant results" assume that
 * index exists before the user types.
 */
export function SearchPanel({ book }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult>({
    needle: '',
    hits: [],
    state: 'done',
  })
  const runId = useRef(0)

  const needle = query.trim()
  /* Ready, not merely loaded. `source !== null` is true from the instant a file
   * is handed over — while it is still being parsed, and after it has failed to
   * open — and searching then returns nothing at all, which the panel reported
   * as "No matches for X": a definite answer about a book that was never
   * searched. Metadata is published once the book is open, so it is the signal
   * that there is something to search. */
  const searchable = book.source !== null && book.meta !== null && book.error === null

  /* Depended on individually rather than through `book`.
   *
   * The Book object changes identity on every relocation, so an effect that
   * lists it restarts on every page turn — including the page turn caused by
   * clicking a result in this very list, which aborted the search that produced
   * it and cleared the results out from under the reader. These are stable. */
  const { search, goTo } = book

  useEffect(() => {
    if (!searchable || needle === '') {
      setResult({ needle, hits: [], state: 'done' })
      return
    }

    /* Every run gets its own controller and id. The controller stops foliate
     * mid-spine when the query changes; the id stops a slower earlier run from
     * appending its hits to a newer query's list after the fact. */
    const controller = new AbortController()
    const id = ++runId.current
    const timer = setTimeout(() => {
      void (async () => {
        const found: SearchHit[] = []
        try {
          for await (const hit of search(needle, controller.signal)) {
            if (controller.signal.aborted || runId.current !== id) return
            found.push(hit)
            // Publish incrementally so the first hits appear immediately.
            setResult({ needle, hits: [...found], state: 'searching' })
            /* Stops one PAST the cap, so the count can tell "exactly 200" from
             * "at least 201". Breaking at the cap and printing "200+" was a
             * claim about a hit nothing had looked for. The extra hit is not
             * shown; it only decides the label. */
            if (found.length > MAX_HITS) break
          }
        } catch (cause) {
          // A search aborted mid-spine is the normal path, not a failure — and
          // it is the ONLY thing this may swallow. A parser throwing halfway
          // through the spine used to land here too and be reported as "No
          // matches", which is a wrong answer rather than a missing one.
          if (controller.signal.aborted || runId.current !== id) return
          console.error('Paper: search failed', cause)
          setResult({ needle, hits: found, state: 'failed' })
          return
        }
        if (!controller.signal.aborted && runId.current === id) {
          setResult({ needle, hits: found, state: 'done' })
        }
      })()
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [needle, searchable, search])

  /* Nothing on screen may outlive the query it answers. A result for a
   * different needle is not a result — it is the previous question's answer,
   * and during the debounce it was both displayed and clickable. */
  const answered = result.needle === needle
  const hits = answered ? result.hits : []
  const searching = !answered || result.state === 'searching'

  return (
    <div className={styles.panel}>
      <div className={styles.searchField}>
        <Search size={14} strokeWidth={ICON.stroke} style={{ color: 'var(--muted)' }} />
        <input
          className={styles.searchInput}
          placeholder={searchable ? 'Search this book…' : 'Open a book to search it'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={!searchable}
          aria-label="Search this book"
        />
      </div>

      {!searchable ? (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>
            {book.source === null
              ? 'Search covers the book you are reading. Open one first.'
              : book.error !== null
                ? 'This book did not open, so there is nothing to search.'
                : 'This book is still opening.'}
          </div>
        </div>
      ) : needle === '' ? (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>Type to search this book.</div>
        </div>
      ) : hits.length === 0 ? (
        <div className={styles.empty}>
          {searching ? (
            <div className={styles.emptyBody}>Searching…</div>
          ) : result.state === 'failed' ? (
            <>
              <div className={styles.emptyTitle}>This book could not be searched</div>
              <div className={styles.emptyBody}>
                Something went wrong partway through. Try again, or reopen the
                book.
              </div>
            </>
          ) : (
            <>
              <div className={styles.emptyTitle}>No matches for “{needle}”</div>
              <div className={styles.emptyBody}>
                Searched this book. Try another spelling — searching the whole
                library is not built yet.
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          {/* A failure partway through still has hits to show, and the count
              below would otherwise present a truncated search as a complete
              one. It says which it is rather than quietly under-reporting. */}
          {result.state === 'failed' && answered && (
            <div className={styles.panelMeta}>
              <span>Search stopped early — these are the matches found so far.</span>
            </div>
          )}
          <div className={styles.panelMeta}>
            <span style={{ flex: 1 }}>
              {Math.min(hits.length, MAX_HITS)}
              {hits.length > MAX_HITS ? '+' : ''} in this book
              {searching ? ' · searching…' : ''}
            </span>
          </div>
          {/* Keyed by position as well as anchor. An EPUB CFI is unique per
              hit, but a PDF's anchor is its page number — several matches on
              one page share it, and React collapses the duplicates so only the
              last of them renders. */}
          {hits.slice(0, MAX_HITS).map((hit, index) => (
            <button
              key={`${hit.cfi}:${index}`}
              type="button"
              className={styles.result}
              onClick={() => goTo(hit.cfi)}
            >
              {hit.label && <span className={styles.resultAt}>{hit.label}</span>}
              <div className={styles.resultSnippet}>
                {hit.pre}
                <span className={styles.hit}>{hit.match}</span>
                {hit.post}
              </div>
            </button>
          ))}
        </>
      )}
    </div>
  )
}
