import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { ICON } from '../../core/metrics'
import type { PassageHit } from '../../core/ports'
import type { Book, SearchHit } from '../hooks/useBook'
import {
  byBook,
  countLine,
  MAX_LIBRARY_HITS,
  NOTHING_ASKED,
  rejectedByQuery,
  searchingAt,
  shownState,
  whyOf,
  type LibraryResult,
  type SearchScope,
} from './librarySearch'
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
  /**
   * Navigate to a hit THROUGH THE HOST, so the departure is recorded.
   *
   * A hit is a jump — non-linear, and the reader wants ⌘[ to bring them back
   * from it — and the ledger names search hits among the panels that push
   * onto the jump stack. This panel called `book.goTo` on its own, which
   * moved the reader and recorded nothing: no way back, no "← Back to" line,
   * and it looked exactly like a jump, which is why nothing noticed. The
   * other panels reach the host's `jumpTo` through a prop of this shape; now
   * this one does too. A bare CFI is a `JumpTarget`'s string arm.
   *
   * OPTIONAL, because the browser client mounts this over a navigator and
   * nothing else — it has no stack to push onto, and a hit there still has to
   * move the reader. Absent, the book's own `goTo` is used.
   */
  onGoTo?: (cfi: string) => void
  /**
   * Search the whole library — absent where this device cannot.
   *
   * ⚠️ **ABSENT, NOT A FUNCTION THAT ANSWERS NOTHING.** A browser client, a
   * phone and a build with the `passages` capability cut all lack an index, and
   * a stub returning an empty list would tell a reader *"nothing in your library
   * says that"* — a wrong answer rather than a missing one. Absent, the scope
   * switch is not drawn at all and the pane is exactly what it was before phase
   * 31, which is what makes `pnpm verify:without passages` pass.
   */
  searchLibrary?: (query: string, limit?: number) => Promise<readonly PassageHit[]>
  /**
   * Open a hit in another book.
   *
   * Separate from `onGoTo` because it is a different act: `onGoTo` moves within
   * the open book, and this one CHANGES which book is open. A host that can
   * search the library and not open a second book would draw results nothing
   * can act on, so the two arrive together or not at all.
   */
  onOpenPassage?: (hit: PassageHit) => void
  /** What a book is called, for the group headings. Falls back to the id. */
  titleOf?: (bookId: string) => string | undefined
}

/** Long enough that typing does not start a full-book scan per keystroke. */
/**
 * How long the field settles before either search is asked.
 *
 * EXPORTED for the same reason as `MAX_HITS`: a case that waits a number typed
 * into the test file cannot tell *never asked* from *not asked yet*, and two
 * guards survived the sweep on exactly that.
 */
export const DEBOUNCE_MS = 250

/** Bounded so a common word cannot stream thousands of rows into the pane. */
/**
 * How many in-book hits are drawn, and counted before the `+`.
 *
 * EXPORTED so a test reads the real bound rather than a copy of it — the rule
 * `palette.test.ts` is the cautionary tale for, where two ratios were pinned
 * against hexes typed into the test file under a comment claiming they came
 * from `tokens.css`, so editing a theme could not fail it.
 */
export const MAX_HITS = 200

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
export function SearchPanel({
  book,
  onGoTo,
  searchLibrary,
  onOpenPassage,
  titleOf,
}: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult>({
    needle: '',
    hits: [],
    state: 'done',
  })
  const runId = useRef(0)
  /* ⚠️ **DEFAULTS TO THE OPEN BOOK, ALWAYS.** A bare query silently meaning
   * something different from what it meant yesterday is why the phase plan
   * refused to put library search in the shelf field at all; the same argument
   * applies to this field. The reader asks for the library. */
  const [scope, setScope] = useState<SearchScope>('book')
  const [library, setLibrary] = useState<LibraryResult>(NOTHING_ASKED)
  /* ⚠️ **AN IDENTITY, NOT A COUNTER.** This only ever answers *is this still
   * the run on screen*, and `++` mutated to `--` answers it just as well — a
   * survivor no test can kill, because whether two steps could bring the number
   * back to one an in-flight run still holds is an argument rather than a fact.
   * An empty object cannot collide by construction, leaves no arithmetic to be
   * wrong about, and has no `ObjectLiteral` mutant of its own. Phase 30 records
   * the same fix for `EngineSpeaker`'s generation and `VoicesPane`'s `asked`. */
  const libraryRun = useRef<object>({})

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
    /* ⚠️ **NOT WHILE THE LIBRARY IS THE SCOPE.** Its results are not on screen,
     * and this is a walk of the whole SPINE per keystroke — the one expensive
     * thing this panel does. Left running it burned a full book scan for every
     * character typed into a field asking about a different question. */
    if (!searchable || needle === '' || scope === 'library') {
      /* Stryker disable next-line StringLiteral: nothing reads this value. Two
         places ask about `state` and both ask for a DIFFERENT one — `searching`
         asks whether it is 'searching', the empty body asks whether it is
         'failed' — so any third string renders identically. Verified by hand:
         the mutant applied at this line leaves all 53 cases green. It is 'done'
         because that is what it means, and 'done' is the only StringLiteral on
         this line, so the directive covers it and nothing else. */
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
  }, [needle, searchable, search, scope])

  /* ⚠️ **THE LIBRARY SEARCH IS ITS OWN EFFECT, not a branch inside the one
   * above.** The two have different cancellation: foliate's spine walk takes an
   * `AbortSignal` and stops mid-book, and a plugin call cannot be stopped at
   * all — the guard there is the run id, which discards a slower answer rather
   * than preventing it. Fused, the in-book search's `controller.abort()` would
   * look as though it stopped the library query, and nothing would have. */
  useEffect(() => {
    if (!searchLibrary || scope !== 'library' || needle === '') {
      /* ⚠️ **NOTHING IS RESET HERE, AND THERE USED TO BE A `setLibrary(idleAt(…))`.**
       * It and the `searchingAt` below were two pieces of code giving one
       * answer: leave the library scope and come back with the needle
       * unchanged, and EITHER of them alone stops the previous answer being
       * drawn as current. So neither could be killed — each covered for the
       * other, and the sweep reported both as survivors for ever. Measured by
       * removing them one at a time: with either present the case passes, with
       * both gone it fails.
       *
       * The one that stays is the one that says something — a search has
       * STARTED for this needle. Leaving stale state behind on the way out is
       * harmless: with no `searchLibrary`, or with the book as the scope, the
       * library half is not rendered at all, and an empty needle returns before
       * anything reads it. */
      return
    }
    const mine = {}
    libraryRun.current = mine
    setLibrary(searchingAt(needle))
    const timer = setTimeout(() => {
      void (async () => {
        try {
          /* ONE PAST THE CAP, so the count can tell "exactly 100" from "at
           * least 101" — the same reason the in-book loop stops one past. */
          const found = await searchLibrary(needle, MAX_LIBRARY_HITS + 1)
          if (libraryRun.current !== mine) return
          /* Stryker disable next-line StringLiteral: by the time this value is
             read, every other kind has already returned — idle, searching,
             rejected and failed each have their own branch above — so the last
             path reads `state.hits` and any third string renders identically.
             Verified by hand: the mutant applied here leaves all 54 cases
             green. */
          setLibrary({ needle, state: { kind: 'done', hits: found } })
        } catch (cause) {
          if (libraryRun.current !== mine) return
          /* ⚠️ **A QUERY THE INDEX REFUSED AND AN INDEX THAT WILL NOT OPEN ARE
           * DIFFERENT SENTENCES.** The first is the reader's to fix. Reported
           * as the second they stop trusting the feature; as the first they
           * retype a perfectly good question for ever. */
          setLibrary({
            needle,
            state: rejectedByQuery(cause)
              ? { kind: 'rejected', why: whyOf(cause) }
              : { kind: 'failed', why: whyOf(cause) },
          })
        }
      })()
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [needle, scope, searchLibrary])

  /* Nothing on screen may outlive the query it answers. A result for a
   * different needle is not a result — it is the previous question's answer,
   * and during the debounce it was both displayed and clickable. */
  const answered = result.needle === needle
  const hits = answered ? result.hits : []
  const searching = !answered || result.state === 'searching'

  /* ⚠️ **THE SCOPE IS OFFERED ONLY WHERE THE LIBRARY CAN ACTUALLY BE
   * SEARCHED.** A switch that is there and does nothing is worse than no switch:
   * a reader who chooses it is told their library holds nothing. This is also
   * what makes the pane degrade to exactly what it was before phase 31 when the
   * `passages` capability is not composed — a browser, a phone, or a tree with
   * it cut — which is what `pnpm verify:without` proves. */
  const canSearchLibrary = searchLibrary !== undefined
  const inLibrary = canSearchLibrary && scope === 'library'

  return (
    <div className={styles.panel}>
      <div className={styles.searchField}>
        {/* ON THE RAMP. It was 14, which `ICON` has no rung for — the ramp runs
            12, 13, 15, 17, 19, 32 — so it was a size arrived at by eye between
            two of them. `control` is the rung whose stated role is an icon
            inside a control, and a search field is one; it is the same 15 the
            rest of the app's field and button glyphs take. */}
        <Search size={ICON.control} strokeWidth={ICON.stroke} className={styles.searchGlyph} />
        <input
          className={styles.searchInput}
          placeholder={
            inLibrary
              ? 'Search every book…'
              : searchable
                ? 'Search this book…'
                : 'Open a book to search it'
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          /* ⚠️ **NOT DISABLED IN LIBRARY SCOPE, WHATEVER THE OPEN BOOK IS
           * DOING.** Searching the shelf does not need a book open — that is the
           * whole point of it — and the field went dead on the library screen
           * while the one feature that works there was selected. */
          disabled={!searchable && !inLibrary}
          aria-label={inLibrary ? 'Search every book' : 'Search this book'}
        />
      </div>

      {canSearchLibrary && (
        <div className={styles.panelMeta}>
          {/* A RADIO GROUP, NOT A `<select>`. Two mutually exclusive options
              both worth seeing at once, and — the reason that decides it — a
              `<select>` given a value no option carries reports the empty
              string and shows its first row, so its state is unreadable from
              the DOM. Phase 30 measured that and `librarySearch.ts` records it. */}
          <span role="radiogroup" aria-label="What to search" className={styles.scopeGroup}>
            {(['book', 'library'] as const).map((which) => (
              <button
                key={which}
                type="button"
                role="radio"
                aria-checked={scope === which}
                className={styles.scopeOption}
                data-chosen={scope === which ? 'true' : undefined}
                onClick={() => setScope(which)}
              >
                {which === 'book' ? 'This book' : 'Every book'}
              </button>
            ))}
          </span>
        </div>
      )}

      {inLibrary ? (
        <LibraryResults
          result={library}
          needle={needle}
          {...(titleOf ? { titleOf } : {})}
          {...(onOpenPassage ? { onOpenPassage } : {})}
        />
      ) : !searchable ? (
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
            <span className={styles.metaGrow}>
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
              /* The host's jump when there is one, the book's own `goTo` when
                 there is not — never both, which would move the reader twice
                 and stack the origin against a page that had already turned. */
              onClick={() => (onGoTo ?? goTo)(hit.cfi)}
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

/**
 * The library half of the panel.
 *
 * A component of its own rather than another arm of the ternary above: the
 * in-book branch is already four states deep, and the two lists differ in what
 * a row IS — an in-book hit is a CFI, a library hit is a book and a passage.
 */
function LibraryResults({
  result,
  needle,
  titleOf,
  onOpenPassage,
}: {
  readonly result: LibraryResult
  readonly needle: string
  readonly titleOf?: (bookId: string) => string | undefined
  readonly onOpenPassage?: (hit: PassageHit) => void
}) {
  /* Nothing on screen may outlive the query it answers — the same rule the
     in-book half states, and for the same reason: during the debounce the
     previous question's answer was both displayed and clickable. The decision
     is `shownState`'s, in `librarySearch.ts`, because its window is one render
     and no test that drives this component can see it. */
  const state = shownState(result, needle)

  if (needle === '') {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyBody}>
          Type to search every book Paper has indexed.
        </div>
      </div>
    )
  }
  /* ⚠️ **`idle` USED TO BE TESTED HERE TOO, AND IT CANNOT ARRIVE.** The only
     idle result this panel ever holds is `NOTHING_ASKED`, whose needle is
     empty — and an empty needle is answered above. `shownState` hands back
     SEARCHING for every result whose needle does not match, so by this line the
     state is searching, rejected, failed or done, never idle.

     It was reachable until the `setLibrary(idleAt(…))` on the guard path went;
     removing that redundancy is what made this branch dead, which is the shape
     worth noticing — **taking one of two overlapping guards away can leave the
     code that read the state it produced stranded.** The sweep found it
     immediately: two survivors on this line and nowhere else. */
  if (state.kind === 'searching') {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyBody}>Searching your library…</div>
      </div>
    )
  }
  if (state.kind === 'rejected') {
    /* ⚠️ **THE READER'S OWN QUERY, NAMED.** An unbalanced quotation mark and a
       single Chinese character are both questions the index cannot ask, and both
       have an obvious fix — which is why this says what the index said rather
       than "no matches". */
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>That search cannot be run</div>
        <div className={styles.emptyBody}>{state.why}</div>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>Your library could not be searched</div>
        <div className={styles.emptyBody}>{state.why}</div>
      </div>
    )
  }
  if (state.hits.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>No matches for “{needle}”</div>
        <div className={styles.emptyBody}>
          Searched every book Paper has indexed so far. Settings → Library search
          says how much that is.
        </div>
      </div>
    )
  }

  const capped = state.hits.length > MAX_LIBRARY_HITS
  const shown = state.hits.slice(0, MAX_LIBRARY_HITS)
  return (
    <>
      <div className={styles.panelMeta}>
        <span className={styles.metaGrow}>{countLine(state.hits.length, capped, false)}</span>
      </div>
      {byBook(shown).map(([bookId, hits]) => (
        <div key={bookId}>
          <div className={styles.resultAt}>{titleOf?.(bookId) ?? bookId}</div>
          {hits.map((hit, index) => (
            <button
              /* Stryker disable next-line StringLiteral: measured 2026-09-25 —
                 with every key in a group replaced by one constant, three rows
                 still drew, still updated when the answer changed and still
                 disappeared when it did. React warns about duplicate keys and
                 calls the result undefined; it does not drop them here, so no
                 test can kill this. Kept because "undefined behaviour happens
                 to work today" is not a thing to build on.

                 ⚠️ **AND THE DIRECTIVE HAS TO BE THE FIRST THING IN THE
                 COMMENT.** It was written below this paragraph once and Stryker
                 read the whole block as prose — the mutant came back in the
                 next sweep, exactly as `AGENTS.md` says it would.

                 Keyed by position as well as anchor. Within a group the book
                 is fixed and two passages in one section can share an offset
                 only if they ARE the same passage, so the anchor alone would
                 do; the position is what makes that true by construction
                 rather than by argument. (The claim that used to stand here,
                 that React "collapses duplicate keys to the last of them", is
                 not what React does — see the measurement above.) */
              key={`${hit.sectionIndex}:${hit.offset}:${index}`}
              type="button"
              className={styles.result}
              /* ⚠️ **ATTACHED ONLY WHEN THERE IS ONE, RATHER THAN CALLED
                 OPTIONALLY.** The row below is `disabled` exactly when this is
                 absent, so `onOpenPassage?.(…)` could never find it missing —
                 an optional call no test can reach, which the sweep reports as
                 a survivor for ever. Two pieces of code giving one answer; the
                 fix is to remove one. */
              {...(onOpenPassage ? { onClick: () => onOpenPassage(hit) } : {})}
              /* ⚠️ **A ROW NOTHING CAN ACT ON IS DISABLED RATHER THAN DRAWN AS
                 A LIVE CONTROL.** A host that can search the library and not
                 open a second book should not offer a click that does nothing —
                 the whole class of defect the ledger calls "a link that opens
                 nothing". */
              disabled={onOpenPassage === undefined}
            >
              <div className={styles.resultSnippet}>
                {hit.prefix}
                <span className={styles.hit}>{hit.quote}</span>
                {hit.suffix}
              </div>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
