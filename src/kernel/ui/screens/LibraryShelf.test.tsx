// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import type { BookStatus } from '../../core/capability'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * THE SHELF, DRIVEN — the first tests that load the library screen at all.
 *
 * Everything here was previously covered only by the parts that could be
 * pulled out of it: `bookIndex` knows how to sort, `useLibrary` knows how to
 * load. Nothing rendered the screen, so nothing could say whether a click
 * reached the sort it names, whether clearing a filter clears it, or whether
 * ⌘A stays out of the search field's way — all of which are decisions this
 * file makes and no other file can.
 *
 * The measured cost of that gap: loading this screen under coverage for the
 * first time moved the global function ratchet by more than a point, because
 * a file no test imports is reported as ONE function rather than its real
 * count. The number had been flattering, not passing.
 */

afterEach(cleanup)

/*
 * TWO THINGS JSDOM DOES NOT HAVE, both of which a menu needs to exist.
 *
 * `ResizeObserver` — `usePlacement` builds one the moment a menu opens, and
 * its absence throws before anything renders.
 *
 * A LAYOUT. jsdom reports every `getBoundingClientRect` as 0×0 at the origin,
 * and `placement.ts` reads a zero-sized anchor as wholly outside the viewport
 * — `fit: 'detached'` — which `useRowMenu` answers by closing the menu in the
 * same tick it opened. That behaviour is CORRECT (a menu whose row scrolled
 * away should go), so the fix belongs here: give the anchors a box. Between
 * them these are why the shelf's menus had no tests.
 */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

Element.prototype.getBoundingClientRect = function (): DOMRect {
  return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
}

const book = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({
    bookId: 'bk1',
    title: 'Bad Blood',
    author: 'Carreyrou, John',
    addedAt: 1,
    progress: 0.5,
    ...over,
  }) as IndexedBook

const BOOKS = [
  book(),
  book({ bookId: 'bk2', title: 'Seeing Like a State', author: 'Scott, James', tags: ['history'] }),
]

const shelf = {
  books: BOOKS,
  platform: 'macos',
  onOpen: vi.fn(),
  onAddBooks: vi.fn(),
  onRemove: vi.fn(),
  onTagBooks: vi.fn(),
  onUntagBooks: vi.fn(),
  lastRemoval: null,
  onUndoRemoveTag: vi.fn(),
  onSetFinished: vi.fn(),
  onAddFolder: vi.fn(),
  importing: null,
  enriching: 0,
  importNotice: null,
  libraryQuery: '',
  onQueryChange: vi.fn(),
  bookActions: [],
  bookStatuses: [],
} as const

describe('opening a book from the shelf', () => {
  it('hands the entry back, not its id', () => {
    /* `onOpen` takes the whole `IndexedBook` — the caller needs the folder and
       the format, and an id would send it back to the index for both. */
    const onOpen = vi.fn()
    render(<Library {...shelf} onOpen={onOpen} />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'bk1' }))
  })
})

describe('narrowing the shelf', () => {
  it('is a controlled field — the screen asks, it does not decide', () => {
    /* The query lives above this screen so a reader who opens a book and comes
       back finds the shelf as they left it. */
    const onQueryChange = vi.fn()
    render(<Library {...shelf} onQueryChange={onQueryChange} />)
    fireEvent.change(screen.getByLabelText('Search the library'), { target: { value: 'blood' } })
    expect(onQueryChange).toHaveBeenCalledWith('blood')
  })

  it('shows only what matches', () => {
    render(<Library {...shelf} libraryQuery="seeing" />)
    expect(screen.queryByTitle('Open Bad Blood')).toBeNull()
    expect(screen.getByTitle('Open Seeing Like a State')).toBeTruthy()
  })

  it('narrows to a tag when its pill is clicked', () => {
    const onQueryChange = vi.fn()
    render(<Library {...shelf} onQueryChange={onQueryChange} />)
    fireEvent.click(screen.getByTitle('Show everything tagged history'))
    expect(onQueryChange).toHaveBeenCalled()
    const asked = onQueryChange.mock.calls.at(0)![0]
    expect(typeof asked === 'function' ? asked('') : asked).toContain('tag:history')
  })

  it('offers the active filter back as one click to lift', () => {
    /* The `FilterChip`. A filter a reader cannot see is a shelf that has
       silently lost most of its books. */
    const onQueryChange = vi.fn()
    render(<Library {...shelf} libraryQuery="tag:history" onQueryChange={onQueryChange} />)
    fireEvent.click(screen.getByTitle('Clear this filter'))
    /* APPLIED, not merely called. The query is a controlled prop, so what
       arrives is an updater — and an updater that returned the query
       untouched would have satisfied "was called" while the chip stayed. */
    const asked = onQueryChange.mock.calls.at(-1)![0]
    const after = typeof asked === 'function' ? asked('tag:history') : asked
    expect(after).not.toContain('tag:history')
    expect(after.trim()).toBe('')
  })
})

describe('the select-all accelerator', () => {
  it('takes the whole shelf', () => {
    render(<Library {...shelf} />)
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    })
    /* Selection swaps the toolbar for a bulk bar and turns every card into a
       toggle — both books, so both say Deselect. */
    expect(screen.getByLabelText('Clear the selection')).toBeTruthy()
    expect(screen.getByTitle('Deselect Bad Blood')).toBeTruthy()
    expect(screen.getByTitle('Deselect Seeing Like a State')).toBeTruthy()
  })

  it('stays out of the search field, where ⌘A means select-all-text', () => {
    /* The documented precondition in `Library.tsx`. A reader mid-query who
       hits ⌘A wants their text, and selecting 1,962 books instead is the kind
       of surprise that costs the shortcut its trust everywhere. */
    render(<Library {...shelf} />)
    const field = screen.getByLabelText('Search the library')
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    })
    expect(screen.queryByLabelText('Clear the selection')).toBeNull()
  })
})

describe('the toolbar menus', () => {
  it('opens the sort menu and reorders the shelf by what was picked', () => {
    /* THE BOOKS, not just the button. The fixtures are arranged so recency
       and title disagree — with the old ones they happened to coincide, so a
       menu that changed its own label and sorted nothing would have passed. */
    const byTitle = [
      book({ bookId: 'z', title: 'Zeno', openedAt: 3000 }),
      book({ bookId: 'a', title: 'Anna', openedAt: 1000 }),
    ]
    const shown = () =>
      [...document.querySelectorAll('[title^="Open "]')].map((el) =>
        el.getAttribute('title')?.replace('Open ', ''),
      )
    render(<Library {...shelf} books={byTitle} />)
    expect(shown(), 'most recently opened first').toEqual(['Zeno', 'Anna'])

    fireEvent.click(screen.getByLabelText('Sort: Recently opened'))
    fireEvent.click(screen.getByText('Title'))
    expect(screen.getByLabelText('Sort: Title')).toBeTruthy()
    expect(shown(), 'now alphabetical').toEqual(['Anna', 'Zeno'])
  })

  it('offers the shelf\'s own tags and reading states to narrow by', () => {
    /* The menu is BUILT FROM THE SHELF — a tag appears because a book wears
       it, with its count — so it cannot offer a filter that matches nothing.
       The states are radios and the tags are checkboxes because one is a
       choice and the other is a set. */
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByLabelText('Narrow the shelf'))
    expect(screen.getByRole('menuitemradio', { name: 'Reading' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'Unread' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'Finished' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Untagged' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: /history/ })).toBeTruthy()
  })

  it('writes the pick into the query, where the field can show it', () => {
    /* Every filter is TEXT in one query — `is:reading`, `tag:history` — so the
       menu, the field and the chips are three views of one state rather than
       three states that have to be kept agreeing. */
    const onQueryChange = vi.fn()
    render(<Library {...shelf} onQueryChange={onQueryChange} />)
    fireEvent.click(screen.getByLabelText('Narrow the shelf'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Reading' }))
    expect(onQueryChange).toHaveBeenCalled()
    const asked = onQueryChange.mock.calls.at(-1)![0]
    expect(typeof asked === 'function' ? asked('') : asked).toContain('is:reading')
  })

  it('narrows by a tag picked from the menu', () => {
    const onQueryChange = vi.fn()
    render(<Library {...shelf} onQueryChange={onQueryChange} />)
    fireEvent.click(screen.getByLabelText('Narrow the shelf'))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /history/ }))
    const asked = onQueryChange.mock.calls.at(-1)![0]
    expect(typeof asked === 'function' ? asked('') : asked).toContain('tag:history')
  })

  it('switches between grid and list', () => {
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByLabelText('Switch to list view'))
    expect(screen.getByLabelText('Switch to grid view')).toBeTruthy()
  })
})

describe('a capability store that moves', () => {
  it('makes the shelf ask again', async () => {
    /* THE PULL LOOP. `BookStatus.of` is asked while the shelf draws and
       re-asked when `subscribe` fires — one listener for the screen, not one
       per row. Without this, a download would register its progress and no
       row would ever repaint to show it. */
    let fire = () => {}
    let answer: { label: string } | null = null
    const status: BookStatus = {
      id: 'test:moving',
      subscribe: (listener) => {
        fire = listener
        return () => {}
      },
      of: () => answer,
    }
    render(<Library {...shelf} bookStatuses={[status]} />)
    expect(screen.queryByText('Downloading 25%')).toBeNull()
    answer = { label: 'Downloading 25%' }
    await act(async () => { fire() })
    expect(screen.getAllByText('Downloading 25%').length).toBeGreaterThan(0)
  })
})
