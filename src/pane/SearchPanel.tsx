import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { ICON } from '../lib/metrics'
import type { Book, SearchHit } from '../lib/useBook'
import styles from './SidePane.module.css'

export interface SearchPanelProps {
  book: Book
}

/** Long enough that typing does not start a full-book scan per keystroke. */
const DEBOUNCE_MS = 250

/** Bounded so a common word cannot stream thousands of rows into the pane. */
const MAX_HITS = 200

type Status = 'idle' | 'searching' | 'done'

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
  const [hits, setHits] = useState<SearchHit[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const runId = useRef(0)

  const needle = query.trim()
  const hasBook = book.source !== null

  useEffect(() => {
    if (!hasBook || needle === '') {
      setHits([])
      setStatus('idle')
      return
    }

    /* Every run gets its own controller and id. The controller stops foliate
     * mid-spine when the query changes; the id stops a slower earlier run from
     * appending its hits to a newer query's list after the fact. */
    const controller = new AbortController()
    const id = ++runId.current
    const timer = setTimeout(() => {
      void (async () => {
        setStatus('searching')
        setHits([])
        const found: SearchHit[] = []
        try {
          for await (const hit of book.search(needle, controller.signal)) {
            if (controller.signal.aborted || runId.current !== id) return
            found.push(hit)
            // Publish incrementally so the first hits appear immediately.
            setHits([...found])
            if (found.length >= MAX_HITS) break
          }
        } catch {
          // A search aborted mid-spine is the normal path, not a failure.
        }
        if (!controller.signal.aborted && runId.current === id) setStatus('done')
      })()
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [needle, hasBook, book])

  return (
    <div className={styles.panel}>
      <div className={styles.searchField}>
        <Search size={14} strokeWidth={ICON.stroke} style={{ color: 'var(--muted)' }} />
        <input
          className={styles.searchInput}
          placeholder={hasBook ? 'Search this book…' : 'Open a book to search it'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={!hasBook}
          aria-label="Search this book"
        />
      </div>

      {!hasBook ? (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>
            Search covers the book you are reading. Open one first.
          </div>
        </div>
      ) : needle === '' ? (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>Type to search this book.</div>
        </div>
      ) : hits.length === 0 ? (
        <div className={styles.empty}>
          {status === 'searching' ? (
            <div className={styles.emptyBody}>Searching…</div>
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
          <div className={styles.panelMeta}>
            <span style={{ flex: 1 }}>
              {hits.length}
              {hits.length >= MAX_HITS ? '+' : ''} in this book
              {status === 'searching' ? ' · searching…' : ''}
            </span>
          </div>
          {/* Keyed by position as well as anchor. An EPUB CFI is unique per
              hit, but a PDF's anchor is its page number — several matches on
              one page share it, and React collapses the duplicates so only the
              last of them renders. */}
          {hits.map((hit, index) => (
            <button
              key={`${hit.cfi}:${index}`}
              type="button"
              className={styles.result}
              onClick={() => book.goTo(hit.cfi)}
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
