import { describe, expect, it } from 'vitest'
import type { PassageHit } from '../../core/ports'
import {
  byBook,
  countLine,
  IDLE,
  MAX_LIBRARY_HITS,
  NOTHING_ASKED,
  rejectedByQuery,
  SEARCHING,
  searchingAt,
  shownState,
  whyOf,
} from './librarySearch'

/**
 * The decidable half of library search, asked directly.
 *
 * ⚠️ **ASKED DIRECTLY BECAUSE THE PANEL FLATTENS ITS OWN ANSWERS.** Searching,
 * nothing found, no index, and a query that cannot be asked all render as a
 * paragraph of text, and `textContent` cannot say which state produced it —
 * the same measurement phase 30 made about a `<select>` reporting the empty
 * string for a value no option carries.
 */

function hit(over: Partial<PassageHit> = {}): PassageHit {
  return {
    bookId: 'book:a',
    sectionIndex: 0,
    offset: 0,
    quote: 'the whale',
    prefix: '',
    suffix: '',
    score: 1,
    ...over,
  }
}

describe('telling the reader’s mistake from the index’s', () => {
  it('reads the code the handler set, over the envelope', () => {
    /* ⚠️ **TWO DIFFERENT SENTENCES.** An unbalanced quotation mark is a query a
     * reader can correct; an index that will not open is not, and telling them
     * to try another spelling would send them to retype a perfectly good
     * question for ever. */
    expect(rejectedByQuery({ code: 'malformed', message: 'unbalanced' })).toBe(true)
    expect(rejectedByQuery({ code: 'unsupported', message: 'no index' })).toBe(false)
    expect(rejectedByQuery(new Error('the index will not open'))).toBe(false)
  })

  it('reads the KIND the plugin set, which is the road the app takes', () => {
    /* ⚠️ **THE DESKTOP IS THE ONLY PLATFORM WITH AN INDEX, AND IT DOES NOT GO
     * THROUGH THE ENVELOPE.** `PassagesPort` reaches the plugin directly, so the
     * refusal arrives as `{ kind: 'badQuery' }` and never as
     * `{ code: 'malformed' }`. Reading only the second reported every refused
     * query on the app as a broken index. */
    expect(rejectedByQuery({ kind: 'badQuery', message: 'one character' })).toBe(true)
    expect(rejectedByQuery({ kind: 'damaged', message: 'the state file' })).toBe(false)
    expect(rejectedByQuery({ kind: 'index', message: 'will not open' })).toBe(false)
  })

  it('treats anything that is not a refusal as not the reader’s fault', () => {
    for (const bad of [null, undefined, 'malformed', 7, []]) {
      expect(rejectedByQuery(bad), String(bad)).toBe(false)
    }
  })

  it('reads a sentence out of whatever was thrown', () => {
    expect(whyOf({ code: 'malformed', message: 'that is one character' })).toBe(
      'that is one character',
    )
    expect(whyOf(new Error('boom'))).toBe('boom')
    expect(whyOf('a bare string')).toBe('a bare string')
    /* An empty message is not a sentence; falling through to `String(cause)` at
       least names the shape rather than showing the reader a blank. */
    expect(whyOf({ message: '' })).not.toBe('')
  })
})

describe('the count above the results', () => {
  it('names the scope, so a narrower search is not read as a smaller library', () => {
    expect(countLine(3, false, false)).toBe('3 in your library')
  })

  it('says when it is still working', () => {
    expect(countLine(3, false, true)).toBe('3 in your library · searching…')
  })

  it('tells “exactly the cap” from “at least one more”', () => {
    /* The panel asks for one past the cap for exactly this. */
    expect(countLine(MAX_LIBRARY_HITS, false, false)).toBe(`${MAX_LIBRARY_HITS} in your library`)
    expect(countLine(MAX_LIBRARY_HITS + 1, true, false)).toBe(
      `${MAX_LIBRARY_HITS}+ in your library`,
    )
  })

  it('never reports more than it draws', () => {
    expect(countLine(9_999, true, false)).toContain(String(MAX_LIBRARY_HITS))
  })
})

describe('grouping by book', () => {
  it('keeps the ranking, by where each book’s best hit fell', () => {
    /* ⚠️ **A FLAT LIST LOSES WHICH BOOK IS WHICH.** The index answers
     * best-passage-first across the whole shelf, so two hits from one book
     * commonly sit either side of a hit from another — and a reader scanning for
     * *where did I read that?* looks for the book before the sentence. */
    const grouped = byBook([
      hit({ bookId: 'b', quote: 'first' }),
      hit({ bookId: 'a', quote: 'second' }),
      hit({ bookId: 'b', quote: 'third' }),
    ])
    expect(grouped.map(([bookId]) => bookId)).toEqual(['b', 'a'])
    expect(grouped[0]?.[1].map((one) => one.quote)).toEqual(['first', 'third'])
  })

  it('keeps every hit', () => {
    const hits = [hit({ bookId: 'a' }), hit({ bookId: 'b' }), hit({ bookId: 'a' })]
    expect(byBook(hits).flatMap(([, rows]) => rows)).toHaveLength(3)
  })

  it('answers nothing for nothing', () => {
    expect(byBook([])).toEqual([])
  })

  it('answers one group for one book', () => {
    expect(byBook([hit(), hit()]).map(([bookId]) => bookId)).toEqual(['book:a'])
  })
})

describe('the states with nothing in them', () => {
  /* ⚠️ **THESE WERE OBJECT LITERALS INSIDE THE COMPONENT, AND UNKILLABLE
   * THERE.** The first one is set at mount, when the scope is still the open
   * book and nothing renders the library half — so no case that drives the
   * pane could ever see it, and six mutants lived on those lines. Asked
   * directly, each is one assertion. */
  it('starts having asked nothing, at no needle', () => {
    expect(NOTHING_ASKED).toEqual({ needle: '', state: { kind: 'idle' } })
  })

  it('is searching for a needle that has been asked and not answered', () => {
    expect(searchingAt('whale')).toEqual({ needle: 'whale', state: { kind: 'searching' } })
  })

  it('names the two empty states by their own kind', () => {
    expect(IDLE.kind).toBe('idle')
    expect(SEARCHING.kind).toBe('searching')
  })
})

describe('what to draw for a needle, given what is held', () => {
  /* ⚠️ **ITS WINDOW IS ONE RENDER**, between the keystroke that changes the
   * needle and the effect that starts the new search — which a component test
   * flushes past, so the guard survived every case that drove the pane. This
   * is the same lesson `voicePickerValue` records: when a pure function's
   * answers are flattened by what draws them, ask the function. */
  const done = { kind: 'done' as const, hits: [] as readonly PassageHit[] }

  it('draws what was found when the answer is about this needle', () => {
    expect(shownState({ needle: 'whale', state: done }, 'whale')).toBe(done)
  })

  it('draws SEARCHING when the answer on hand is about an older needle', () => {
    /* The previous question's hits were both displayed and CLICKABLE during
     * the debounce, which is how a reader opened a passage they had not asked
     * for. */
    expect(shownState({ needle: 'whale', state: done }, 'harpoon')).toEqual({ kind: 'searching' })
  })

  it('draws SEARCHING for a failure that belongs to an older needle', () => {
    const failed = { kind: 'failed' as const, why: 'the index would not open' }
    expect(shownState({ needle: 'whale', state: failed }, 'harpoon')).toEqual({ kind: 'searching' })
    expect(shownState({ needle: 'whale', state: failed }, 'whale')).toBe(failed)
  })

  it('answers SEARCHING for an idle result, so nothing downstream has to know', () => {
    /* ⚠️ **IDLE CANNOT REACH THE PANEL, AND THE PANEL USED TO TEST FOR IT
     * ANYWAY.** The only idle result held is `NOTHING_ASKED`, whose needle is
     * empty, and an empty needle is answered before any state is read. The
     * branch there was dead code TypeScript could not see was dead — two
     * survivors sat on it. Collapsed here, `ShownState` makes it unsayable. */
    expect(shownState({ needle: 'whale', state: IDLE }, 'whale')).toEqual({ kind: 'searching' })
    expect(shownState(NOTHING_ASKED, '')).toEqual({ kind: 'searching' })
  })

  it('treats the empty needle like any other, rather than as a special case', () => {
    expect(shownState({ needle: '', state: IDLE }, '')).toEqual({ kind: 'searching' })
    expect(shownState({ needle: 'whale', state: IDLE }, '')).toEqual({ kind: 'searching' })
  })
})
