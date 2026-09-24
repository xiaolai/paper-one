// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PassageIndexStatus } from '../../../kernel'
import type { PassageIndex } from '../lib/port'
import { makeProgress } from '../lib/progress'
import {
  buildLine,
  coverageLine,
  LISTED,
  PassagesPane,
  POLL_MS,
  sizeLine,
  unreadableLine,
} from './PassagesPane'

afterEach(cleanup)

function status(over: Partial<PassageIndexStatus> = {}): PassageIndexStatus {
  return {
    books: 2,
    sections: 40,
    chars: 100_000,
    indexBytes: 4_000_000,
    textBytes: 8_000_000,
    analysis: 'paper/1',
    unreadable: [],
    ...over,
  }
}

function portOver(over: Partial<PassageIndex> = {}): PassageIndex {
  return {
    search: async () => [],
    status: async () => status(),
    put: async () => true,
    note: async () => {},
    flush: async () => {},
    forget: async () => {},
    rekey: async () => true,
    pending: async () => [],
    indexed: async () => [],
    rebuild: async () => {},
    retry: async () => 0,
    ...over,
  }
}

/**
 * The sentences, asked directly.
 *
 * ⚠️ **PHASE 30 SHIPPED A PANE WHOSE SIZE AND LANGUAGES WERE IN THE DOM THE
 * WHOLE TIME AND CLIPPED TO NOTHING** — invisible to every query and to every
 * test, and found only by looking at the running app. What a DOM query can
 * still check is that the right SENTENCE was chosen, so the choosing is
 * exported and asked without rendering.
 */
describe('the sentences', () => {
  it('counts books and chapters, and says so in words a person reads', () => {
    expect(coverageLine(status())).toBe('2 books · 40 chapters')
  })

  it('says “nothing yet” rather than “0 books”', () => {
    /* ⚠️ **A COUNT MAY BE ZERO AND IS NOT A SIZE.** Phase 30 shipped
     * *"Downloading · unknown size of 2.3 GB"* by sending a count of received
     * bytes through a formatter that correctly refuses a zero SIZE. */
    expect(coverageLine(status({ books: 0, sections: 0 }))).toBe('Nothing indexed yet')
  })

  it('gets the singular right', () => {
    expect(coverageLine(status({ books: 1, sections: 1 }))).toBe('1 book · 1 chapter')
  })

  it('reports BOTH stores, because both are on the disk', () => {
    /* Reporting only the postings would understate what the feature occupies by
     * roughly half — which is the number a reader deciding whether to keep it
     * actually needs. */
    /* `packSize` counts in MiB, as the rest of the app does — 12 000 000 bytes
       is 11 MB by that measure, and the point of this case is not the unit but
       that the TOTAL is drawn and the postings named inside it. */
    expect(sizeLine(status())).toBe('11 MB · 4 MB of it postings')
    /* And the total really is BOTH: with no retained text the two halves of the
       sentence agree, which is what proves the first number is a sum. */
    expect(sizeLine(status({ textBytes: 0 }))).toBe('4 MB · 4 MB of it postings')
  })

  it('says nothing about unreadable books when there are none', () => {
    expect(unreadableLine(status())).toBeNull()
  })

  it('names how many books could not be read, and gets the singular right', () => {
    const one = { bookId: 'book:b', why: 'no text', at: 1 }
    expect(unreadableLine(status({ unreadable: [one] }))).toMatch(/^1 book could not be read/u)
    expect(unreadableLine(status({ unreadable: [one, { ...one, bookId: 'c' }] }))).toMatch(
      /^2 books could not be read/u,
    )
  })
})

describe('how far the build has got', () => {
  it('says nothing before any sweep has run, rather than inventing a denominator', () => {
    expect(buildLine(status(), { wanted: 0, sweeping: false, swept: false })).toBeNull()
  })

  it('says nothing once the shelf has been swept', () => {
    /* A finished index needs no progress line; the count above it is the whole
       answer. */
    expect(buildLine(status(), { wanted: 1959, sweeping: false, swept: true })).toBeNull()
  })

  it('counts the shelf, not the index — which is the whole point', () => {
    /* ⚠️ *"300 books"* on a shelf of 1 959 reads as a finished index that found
     * three hundred books. The denominator is what says otherwise, and only the
     * capability has it. */
    expect(buildLine(status({ books: 300 }), { wanted: 1959, sweeping: true, swept: false })).toBe(
      'Building · 300 of 1959 books',
    )
  })

  it('tells a build that is running from one that stopped part way', () => {
    expect(buildLine(status({ books: 300 }), { wanted: 1959, sweeping: false, swept: false })).toBe(
      'Paused · 300 of 1959 books',
    )
  })

  it('never reports more done than there are books', () => {
    /* The plugin can hold a book the shelf has since evicted — the sweep's diff
       takes it out, and until then the count must not read as 2001 of 1959. */
    expect(buildLine(status({ books: 2001 }), { wanted: 1959, sweeping: true, swept: false })).toBe(
      'Building · 1959 of 1959 books',
    )
  })
})

describe('the pane', () => {
  it('says what is indexed', async () => {
    await act(async () => {
      render(<PassagesPane port={portOver()} progress={makeProgress()} />)
    })
    expect(screen.getByText('2 books · 40 chapters')).toBeTruthy()
  })

  it('draws the progress line while a sweep is running, and drops it after', async () => {
    const progress = makeProgress()
    progress.set({ wanted: 1959, sweeping: true, swept: false })
    await act(async () => {
      render(<PassagesPane port={portOver()} progress={progress} />)
    })
    expect(screen.getByText('Building · 2 of 1959 books')).toBeTruthy()
    await act(async () => {
      progress.set({ wanted: 1959, sweeping: false, swept: true })
    })
    expect(screen.queryByText(/Building ·/u)).toBeNull()
  })

  it('says the index could not be read rather than showing zeroes', async () => {
    /* ⚠️ Reported as zeroes, a reader is told nothing is indexed while the
     * shelf is in fact fully searchable — and `statusOf` refuses a malformed
     * answer precisely so this end can say so. */
    await act(async () => {
      render(
        <PassagesPane
          port={portOver({
            status: async () => {
              throw new Error('the state file will not parse')
            },
          })}
        />,
      )
    })
    expect(screen.getByText(/could not be read: the state file will not parse/u)).toBeTruthy()
    expect(screen.queryByText(/Nothing indexed yet/u)).toBeNull()
  })

  it('lists the books that could not be read by NAME, with the reason', async () => {
    /* ⚠️ **IT LISTED IDS, AND THE PANEL WAS USELESS.** Observed on the real
     * shelf: twenty-one rows of `book:d2ce87555111dbb3472e62b5c8a763c3`, every
     * record accurate, and no way for a reader to tell which of their books is
     * missing from search. */
    const progress = makeProgress()
    progress.bindTitles((id) => (id === 'book:b' ? 'A Book of Pictures' : undefined))
    await act(async () => {
      render(
        <PassagesPane
          progress={progress}
          port={portOver({
            status: async () =>
              status({ unreadable: [{ bookId: 'book:b', why: 'it holds no text', at: 1 }] }),
          })}
        />,
      )
    })
    expect(screen.getByText('A Book of Pictures')).toBeTruthy()
    expect(screen.queryByText('book:b')).toBeNull()
    expect(screen.getByText('it holds no text')).toBeTruthy()
  })

  it('falls back to the id for a book the shelf no longer has', async () => {
    /* A real state: a note outlives the book it is about until the next sweep's
       diff takes it out. */
    await act(async () => {
      render(
        <PassagesPane
          progress={makeProgress()}
          port={portOver({
            status: async () =>
              status({ unreadable: [{ bookId: 'book:gone', why: 'it holds no text', at: 1 }] }),
          })}
        />,
      )
    })
    expect(screen.getByText('book:gone')).toBeTruthy()
  })

  it('counts the rest rather than drawing a hundred rows', async () => {
    const many = Array.from({ length: LISTED + 5 }, (_one, index) => ({
      bookId: `book:${index}`,
      why: 'no text',
      at: index,
    }))
    await act(async () => {
      render(<PassagesPane port={portOver({ status: async () => status({ unreadable: many }) })} />)
    })
    expect(screen.getByText('…and 5 more.')).toBeTruthy()
  })

  it('re-reads while it is open', async () => {
    vi.useFakeTimers()
    try {
      const read = vi.fn(async () => status())
      await act(async () => {
        render(<PassagesPane port={portOver({ status: read })} />)
      })
      const once = read.mock.calls.length
      await act(async () => {
        vi.advanceTimersByTime(POLL_MS)
      })
      expect(read.mock.calls.length).toBeGreaterThan(once)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rebuilds when asked, and re-reads afterwards', async () => {
    const rebuild = vi.fn(async () => {})
    const read = vi.fn(async () => status())
    await act(async () => {
      render(<PassagesPane port={portOver({ rebuild, status: read })} />)
    })
    const before = read.mock.calls.length
    const button = screen.getByRole('button', { name: 'Rebuild the index' })
    await act(async () => {
      button.click()
    })
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(read.mock.calls.length).toBeGreaterThan(before)
  })

  it('starts only one rebuild however fast the reader presses', async () => {
    /* ⚠️ **A RENDER SNAPSHOT IS NOT A LOCK, AND `disabled` IS NOT EITHER.** The
     * attribute only exists on the render that has not happened yet, so two
     * presses before React commits the first both see the old state. Phase 30's
     * `VoicesPane.remove` had exactly this defect. */
    let release = () => {}
    const rebuild = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await act(async () => {
      render(<PassagesPane port={portOver({ rebuild })} />)
    })
    const button = screen.getByRole('button', { name: 'Rebuild the index' })
    await act(async () => {
      button.click()
      button.click()
      button.click()
    })
    expect(rebuild).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
    })
  })

  it('offers a way back for a book recorded unreadable in error', async () => {
    /* ⚠️ **WITHOUT IT THERE IS NONE.** A disk that was momentarily busy leaves
     * the same record as a book that genuinely holds no text, and nothing can
     * tell the two apart from a thrown value — so the book would never be
     * looked at again until its bytes changed. Rebuilding does NOT clear the
     * notes, on purpose. */
    const retry = vi.fn(async () => 1)
    const read = vi.fn(async () =>
      status({ unreadable: [{ bookId: 'book:b', why: 'the disk was busy', at: 1 }] }),
    )
    await act(async () => {
      render(<PassagesPane port={portOver({ retry, status: read })} />)
    })
    const before = read.mock.calls.length
    await act(async () => {
      screen.getByRole('button', { name: 'Try these again' }).click()
    })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(read.mock.calls.length).toBeGreaterThan(before)
  })

  it('offers no way back when nothing could not be read', () => {
    /* A control for a list that is empty is a control that reports nothing. */
    render(<PassagesPane port={portOver()} />)
    expect(screen.queryByRole('button', { name: 'Try these again' })).toBeNull()
  })

  it('says a failed rebuild failed', async () => {
    await act(async () => {
      render(
        <PassagesPane
          port={portOver({
            rebuild: async () => {
              throw new Error('the disk is full')
            },
          })}
        />,
      )
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Rebuild the index' }).click()
    })
    expect(screen.getByText(/the disk is full/u)).toBeTruthy()
  })

  it('says it is reading before the first answer arrives', async () => {
    /* Not zeroes, and not an empty panel: the difference between "still
       looking" and "nothing is indexed" is the whole of what a reader wants
       from this panel in its first second. */
    render(<PassagesPane port={portOver({ status: () => new Promise(() => {}) })} />)
    expect(screen.getByText('Reading the index…')).toBeTruthy()
    await act(async () => {})
  })
})
