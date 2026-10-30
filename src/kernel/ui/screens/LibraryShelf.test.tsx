// @vitest-environment jsdom
import { useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import styles from './Library.module.css'
import { BOOK_DRAG_TYPE } from '../../core/bookDrag'
import type { BookAction, BookStatus } from '../../core/capability'
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

/** The titles the shelf is showing, in the order it is showing them. */
const shown = () =>
  [...document.querySelectorAll('[title^="Open "]')].map((el) =>
    el.getAttribute('title')?.replace('Open ', ''),
  )

/** The grid — or the list — the cells are drawn into. */
const rack = () => document.querySelector('[data-scroll] > div') as HTMLElement

const press = (init: KeyboardEventInit, at: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    at.dispatchEvent(event)
  })
  return event
}

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

  /* ⚠️ ONE ESCAPE, ONE LAYER. The menu's own Escape handler stops propagation,
     which cannot stop the shelf's listener: both are on `document`. So the
     shelf has to know a toolbar menu is open, and until 2026-09-13 it did not —
     Escape closed Sort AND dropped the selection. */
  it('lets Escape close a toolbar menu before it lets the selection go', () => {
    render(<Library {...shelf} />)
    const press = (init: KeyboardEventInit) =>
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
      })
    press({ key: 'a', metaKey: true })
    fireEvent.click(screen.getByLabelText('Sort: Recently opened'))
    expect(screen.getByRole('menu', { name: 'Sort' })).toBeTruthy()

    press({ key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Sort' })).toBeNull()
    expect(screen.queryByLabelText('Clear the selection'), 'one Escape took the menu and the selection').toBeTruthy()

    press({ key: 'Escape' })
    expect(screen.queryByLabelText('Clear the selection')).toBeNull()
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

  /* ⚠️ THE SHELF READS `of` WHILE IT RENDERS AND SUBSCRIBES IN A PASSIVE EFFECT,
     so a store that publishes in between reaches nobody. A layout effect is
     exactly that moment — every layout effect runs before any passive one — and
     until 2026-09-13 what it said was lost until something else re-rendered. */
  it('hears what a store said before the shelf was listening', async () => {
    let answer: { label: string } | null = null
    const listeners = new Set<() => void>()
    const status: BookStatus = {
      id: 'test:early',
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      of: () => answer,
    }
    function PublishesFirst() {
      useLayoutEffect(() => {
        answer = { label: 'Downloaded just now' }
        for (const listener of [...listeners]) listener()
      }, [])
      return <Library {...shelf} bookStatuses={[status]} />
    }

    await act(async () => {
      render(<PublishesFirst />)
    })

    expect(listeners.size, 'the shelf never subscribed, so this proves nothing').toBe(1)
    expect(screen.getAllByText('Downloaded just now').length).toBeGreaterThan(0)
  })
})

/**
 * The foot says when a save did not land (WI-20.36). It is the one line the
 * shelf has for "something happened to your library", and a write that
 * failed is the thing most worth that line.
 */
describe('the foot, when a save did not land', () => {
  it('names the book, offers the retry, and can be dismissed', () => {
    const retry = vi.fn()
    const dismiss = vi.fn()
    render(
      <Library
        {...shelf}
        saveFailure={{ message: 'Couldn’t save “Bad Blood”', retry }}
        onDismissSaveFailure={dismiss}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Couldn’t save “Bad Blood”')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  /* The reader's own action that did not happen outranks the one that did:
     "1,959 added" over a failed save is the wrong thing to read. */
  it('outranks the import line, and offers no retry it cannot run', () => {
    render(
      <Library
        {...shelf}
        importNotice="Added 3 books."
        saveFailure={{ message: 'Couldn’t save “Bad Blood”', retry: null }}
        onDismissSaveFailure={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Couldn’t save')
    expect(screen.queryByText('Added 3 books.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('what boot had to say', () => {
  it('stands in the foot until dismissed, below a save that failed', () => {
    const dismiss = vi.fn()
    render(<Library {...shelf} bootNotice="The store could not be read." onDismissBootNotice={dismiss} />)
    expect(screen.getByRole('status').textContent).toContain('The store could not be read.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})

/**
 * THE FOUR ORDERINGS, EACH TELLING THE OTHER THREE APART.
 *
 * The fixtures are arranged so recency, title, author and progress all disagree
 * — with any two of them coinciding, a menu row that wrote the wrong `id` into
 * the shelf would sort the books into the right order by accident, which is
 * what let four of these rows go unmeasured.
 */
describe('the order the shelf opens in, and the four it offers', () => {
  const ordered = [
    book({ bookId: 'a', title: 'Anna', author: 'Zeta', openedAt: 3000, progress: 0.1 }),
    book({ bookId: 'b', title: 'Bede', author: 'Mu', openedAt: 1000, progress: 0.9 }),
    book({ bookId: 'c', title: 'Cato', author: 'Alpha', openedAt: 2000, progress: 0.5 }),
  ]
  const openMenu = () => fireEvent.click(screen.getByLabelText(/^Sort: /))
  const pick = (name: string) => {
    openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name }))
  }

  it('opens on recency, which no other ordering here agrees with', () => {
    render(<Library {...shelf} books={ordered} />)
    expect(shown()).toEqual(['Anna', 'Cato', 'Bede'])
  })

  it('ticks the ordering it is actually in', () => {
    /* The button's label falls back to the first option, so a menu that had
       lost track of the current order still READ right. The tick is what says
       which row the shelf is standing on. */
    render(<Library {...shelf} books={ordered} />)
    openMenu()
    expect(screen.getByRole('menuitemradio', { name: 'Recently opened' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Title' }).getAttribute('aria-checked')).toBe('false')
  })

  it('sorts by the row that was picked, and says which', () => {
    render(<Library {...shelf} books={ordered} />)
    pick('Author')
    expect(shown(), 'by author').toEqual(['Cato', 'Bede', 'Anna'])
    expect(screen.getByLabelText('Sort: Author')).toBeTruthy()

    pick('Progress')
    expect(shown(), 'by how far in').toEqual(['Bede', 'Cato', 'Anna'])
    expect(screen.getByLabelText('Sort: Progress')).toBeTruthy()

    pick('Recently opened')
    expect(shown(), 'and back to recency').toEqual(['Anna', 'Cato', 'Bede'])
  })
})

describe('the toolbar’s way in', () => {
  /* ABSENT MEANS NOT DRAWN — a `+` wired to nothing is the shelf offering
     something its host cannot do. Pinned in both directions, so the guard
     cannot be satisfied by drawing it for everyone or for no one. */
  it('offers a + that adds books, to a host that can add them', () => {
    const onAddBooks = vi.fn()
    render(<Library {...shelf} onAddBooks={onAddBooks} />)
    const add = screen.getByRole('button', { name: 'Add books' })
    expect(add.getAttribute('title')).toBe('Add books…')
    fireEvent.click(add)
    expect(onAddBooks).toHaveBeenCalledTimes(1)
  })

  it('draws no + for a host with no way to add a book', () => {
    const { onAddBooks: _a, ...readOnly } = shelf
    render(<Library {...readOnly} />)
    expect(screen.getByLabelText('Search the library'), 'the toolbar is there').toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add books' })).toBeNull()
  })
})

describe('the view toggle', () => {
  /* THE ICON IS THE DESTINATION and the label says so in words: a toggle that
     wore the state it was IN would read as the opposite control. */
  it('offers the view the reader is not in, and switches to it and back', () => {
    render(<Library {...shelf} />)
    const toggle = () => screen.getByRole('button', { name: /^Switch to (list|grid) view$/ })
    expect(toggle().getAttribute('title')).toBe('List view')
    expect(toggle().querySelector('svg')?.getAttribute('class')).toContain('lucide-list')
    expect(rack().className).toBe(styles.shelf)

    fireEvent.click(toggle())
    expect(screen.getByLabelText('Switch to grid view').getAttribute('title')).toBe('Grid view')
    expect(screen.getByLabelText('Switch to grid view').querySelector('svg')?.getAttribute('class')).toContain('lucide-layout-grid')
    expect(rack().className).toBe(styles.list)

    fireEvent.click(screen.getByLabelText('Switch to grid view'))
    expect(screen.getByLabelText('Switch to list view')).toBeTruthy()
    expect(rack().className, 'back in the grid, not in a third state').toBe(styles.shelf)
  })
})

/**
 * ONE MENU MAY ONLY CLOSE ITSELF.
 *
 * Both menus close through `useRowMenu`'s cleanup, which fires when `open` goes
 * false — AFTER the other menu has already set the union to its own name. An
 * unconditional close therefore erased the state the incoming menu had just
 * written, and the menu the reader had pressed never appeared.
 */
describe('one toolbar menu opening another', () => {
  it('leaves the incoming menu open when the outgoing one closes', () => {
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByLabelText('Narrow the shelf'))
    fireEvent.click(screen.getByLabelText(/^Sort: /))
    expect(screen.getByRole('menu', { name: 'Sort' })).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Untagged' }), 'the narrow menu went').toBeNull()
  })

  it('holds just as well the other way round', () => {
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByLabelText(/^Sort: /))
    fireEvent.click(screen.getByLabelText('Narrow the shelf'))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Untagged' })).toBeTruthy()
    expect(screen.queryByRole('menu', { name: 'Sort' })).toBeNull()
  })

  it('still lets Escape close the narrow menu', () => {
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByLabelText('Narrow the shelf'))
    press({ key: 'Escape' })
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Untagged' })).toBeNull()
  })
})

/**
 * THE CHIPS READ THE QUERY BACK, and each one is a click from lifting the term
 * it reports. A filter a reader cannot see is a shelf that has quietly lost
 * most of its books.
 */
describe('the filter chips', () => {
  const lifted = (onQueryChange: ReturnType<typeof vi.fn>, from: string) => {
    const asked = onQueryChange.mock.calls.at(-1)![0]
    return typeof asked === 'function' ? asked(from) : asked
  }

  it('draws no row at all over a shelf nothing is narrowing', () => {
    const { container } = render(<Library {...shelf} />)
    expect(container.querySelector(`.${styles.chips}`)).toBeNull()
  })

  it('offers the reading state back, and lifts it', () => {
    const onQueryChange = vi.fn()
    render(<Library {...shelf} libraryQuery="is:reading" onQueryChange={onQueryChange} />)
    const chip = screen.getByRole('button', { name: 'reading ✕' })
    expect(chip.hasAttribute('data-excluded'), 'a required term is not an exclusion').toBe(false)
    fireEvent.click(chip)
    expect(lifted(onQueryChange, 'is:reading').trim()).toBe('')
  })

  it('offers untagged back, and lifts it', () => {
    const onQueryChange = vi.fn()
    render(<Library {...shelf} libraryQuery="is:untagged" onQueryChange={onQueryChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'untagged ✕' }))
    expect(lifted(onQueryChange, 'is:untagged').trim()).toBe('')
  })

  it('reads an exclusion as one, and lifts that too', () => {
    /* "not Sea" rather than "Sea", so a reader glancing at the row knows which
       way each chip is narrowing. Same ✕, same clear. */
    const onQueryChange = vi.fn()
    render(<Library {...shelf} libraryQuery="-tag:history" onQueryChange={onQueryChange} />)
    const chip = screen.getByRole('button', { name: 'not history ✕' })
    expect(chip.getAttribute('data-excluded')).toBe('true')
    fireEvent.click(chip)
    expect(lifted(onQueryChange, '-tag:history').trim()).toBe('')
  })

  it('gives every exclusion its own chip, and its own ✕', () => {
    /* KEYED BY THE TAG, which is what makes the chips a list rather than two
       positions. Lifting the first one leaves the second one's own element
       standing — under one key shared by both, React matches them by position
       instead, and the chip the reader is left with is the one they cleared,
       wearing the other's words. */
    const onQueryChange = vi.fn()
    const { rerender } = render(
      <Library {...shelf} libraryQuery="-tag:history -tag:sea" onQueryChange={onQueryChange} />,
    )
    expect(screen.getByRole('button', { name: 'not history ✕' })).toBeTruthy()
    const sea = screen.getByRole('button', { name: 'not sea ✕' })

    rerender(<Library {...shelf} libraryQuery="-tag:sea" onQueryChange={onQueryChange} />)
    expect(screen.queryByRole('button', { name: 'not history ✕' })).toBeNull()
    expect(screen.getByRole('button', { name: 'not sea ✕' })).toBe(sea)
  })
})

describe('the selection hint', () => {
  it('names the modifier the reader’s own keyboard has', () => {
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'), { metaKey: true })
    expect(screen.getByText(/click to add/).textContent).toBe('⌘-click to add · ⇧-click for a run')
    cleanup()

    render(<Library {...shelf} platform="windows" />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'), { ctrlKey: true })
    expect(screen.getByText(/click to add/).textContent).toBe('Ctrl-click to add · ⇧-click for a run')
  })
})

describe('what the shelf answers on the keyboard', () => {
  it('takes Ctrl-A where the keyboard has no ⌘', () => {
    render(<Library {...shelf} platform="windows" />)
    press({ key: 'a', metaKey: true })
    expect(screen.queryByLabelText('Clear the selection'), '⌘ is not this platform’s key').toBeNull()
    press({ key: 'a', ctrlKey: true })
    expect(screen.getByLabelText('Clear the selection')).toBeTruthy()
  })

  it('answers ⌘A and no other chord', () => {
    render(<Library {...shelf} />)
    press({ key: 'b', metaKey: true })
    expect(screen.queryByLabelText('Clear the selection')).toBeNull()
  })

  it('leaves a bare letter to whatever else wants it', () => {
    render(<Library {...shelf} />)
    press({ key: 'a' })
    expect(screen.queryByLabelText('Clear the selection')).toBeNull()
  })

  it('stays out of a textarea, as it stays out of the search field', () => {
    render(<Library {...shelf} />)
    const note = document.createElement('textarea')
    document.body.append(note)
    try {
      press({ key: 'a', metaKey: true }, note)
      expect(screen.queryByLabelText('Clear the selection')).toBeNull()
    } finally {
      note.remove()
    }
  })

  it('takes the keystroke when it answers it, and leaves it when it does not', () => {
    /* ⌘A over a shelf showing nothing is the browser's own select-all-text, and
       swallowing it there would take a key the reader can still use away for
       an act that gathers no books. */
    const { rerender } = render(<Library {...shelf} />)
    expect(press({ key: 'a', metaKey: true }).defaultPrevented).toBe(true)
    rerender(<Library {...shelf} libraryQuery="nothing on this shelf is called this" />)
    expect(press({ key: 'a', metaKey: true }).defaultPrevented).toBe(false)
  })

  it('lets the selection go on Escape and on nothing else', () => {
    render(<Library {...shelf} />)
    press({ key: 'a', metaKey: true })
    press({ key: 'b' })
    expect(screen.getByLabelText('Clear the selection'), 'an unrelated key kept it').toBeTruthy()
    press({ key: 'Escape' })
    expect(screen.queryByLabelText('Clear the selection')).toBeNull()
  })
})

describe('dragging a book off the shelf', () => {
  const dragged = (title: string) => {
    const written: Record<string, string> = {}
    const dataTransfer = {
      setData: (type: string, value: string) => {
        written[type] = value
      },
      effectAllowed: '',
    }
    fireEvent.dragStart(screen.getByTitle(title).closest('[draggable]')!, { dataTransfer })
    return JSON.parse(written[BOOK_DRAG_TYPE] ?? 'null') as string[] | null
  }

  it('carries the whole selection when the card dragged is in it', () => {
    render(<Library {...shelf} />)
    press({ key: 'a', metaKey: true })
    expect(dragged('Deselect Bad Blood')?.sort()).toEqual(['bk1', 'bk2'])
  })

  it('carries the one card when it is not', () => {
    /* Finder's rule. A drag that quietly took the selection with it would move
       books the reader had not picked up. */
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'), { metaKey: true })
    expect(dragged('Select Seeing Like a State')).toEqual(['bk2'])
  })
})

describe('the tags the editors suggest', () => {
  it('follow the shelf when a book arrives wearing a new one', () => {
    const { rerender } = render(<Library {...shelf} />)
    rerender(
      <Library
        {...shelf}
        books={[...BOOKS, book({ bookId: 'bk3', title: 'Sea Room', tags: ['islands'] })]}
      />,
    )
    fireEvent.click(screen.getByLabelText('Narrow the shelf'))
    expect(screen.getByRole('menuitemcheckbox', { name: /islands/ })).toBeTruthy()
  })
})

/**
 * THE LIST'S TIMES ARE A CLAIM ABOUT NOW, and a window left open over lunch
 * kept whatever now its last unrelated render happened to read.
 */
describe('the minute the list keeps', () => {
  it('moves its times on with no render to prompt it, and only in the list', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-14T12:00:00Z'))
      render(<Library {...shelf} books={[book({ openedAt: Date.now() })]} />)
      expect(vi.getTimerCount(), 'the grid has no times to keep').toBe(0)

      fireEvent.click(screen.getByLabelText('Switch to list view'))
      expect(screen.getByText('Just now')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(screen.getByText('1 min')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(screen.getByText('2 min')).toBeTruthy()

      fireEvent.click(screen.getByLabelText('Switch to grid view'))
      expect(vi.getTimerCount(), 'and it stops when the list goes').toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * WHAT A RENDER OF THE SHELF COSTS, counted through work it causes — an action's
 * `when`, which every card asks while it draws.
 */
describe('the shelf’s own re-renders', () => {
  const counter = () => {
    const when = vi.fn(() => true)
    const action: BookAction = {
      id: 'test:fetch',
      label: 'Download',
      fetchesContent: true,
      when,
      run: () => {},
    }
    return { when, books: [book({ bookId: 'bk1', hasContent: false })], actions: [action] }
  }

  it('costs nothing at all when no capability has a store to watch', async () => {
    const { when, books, actions } = counter()
    render(<Library {...shelf} books={books} bookActions={actions} bookStatuses={[]} />)
    when.mockClear()
    await act(async () => {})
    expect(when).not.toHaveBeenCalled()
  })

  it('costs one deferred tick for a burst, not one per publication', async () => {
    /* The latch. A transfer publishes per frame, and each notification is a
       closure queued on the microtask queue — fifty in a tick must be one. */
    let fire = () => {}
    const status: BookStatus = {
      id: 'test:busy',
      subscribe: (listener) => {
        fire = listener
        return () => {}
      },
      of: () => null,
    }
    render(<Library {...shelf} bookStatuses={[status]} />)
    const queued = vi.spyOn(globalThis, 'queueMicrotask')
    try {
      await act(async () => {
        for (let i = 0; i < 50; i++) fire()
      })
      expect(queued.mock.calls.length).toBeLessThan(5)
    } finally {
      queued.mockRestore()
    }
  })

  it('asks again for every burst, not only for the first', async () => {
    /* The latch is released by the tick it queued. Left set, the shelf answered
       one publication and then went deaf for the session. */
    let fire = () => {}
    let answer: { label: string } | null = null
    const status: BookStatus = {
      id: 'test:twice',
      subscribe: (listener) => {
        fire = listener
        return () => {}
      },
      of: () => answer,
    }
    render(<Library {...shelf} bookStatuses={[status]} />)
    await act(async () => {})
    answer = { label: 'Downloading 25%' }
    await act(async () => {
      fire()
    })
    expect(screen.getAllByText('Downloading 25%').length).toBeGreaterThan(0)
  })

  it('lets a store go when the shelf stops watching it', async () => {
    const off = vi.fn()
    const status: BookStatus = {
      id: 'test:let-go',
      subscribe: () => off,
      of: () => null,
    }
    const { unmount } = render(<Library {...shelf} bookStatuses={[status]} />)
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('drops a tick queued by a store it no longer holds', async () => {
    /* A microtask queued just before the effect is torn down still fires — into
       a shelf that has unsubscribed, or whose providers have just been swapped.
       It must not spend a render on what it was told. */
    const { when, books, actions } = counter()
    let fire = () => {}
    const status: BookStatus = {
      id: 'test:going',
      subscribe: (listener) => {
        fire = listener
        return () => {}
      },
      of: () => null,
    }
    /* ONE array, held: a fresh `bookStatuses` on every render would resubscribe
       — and tick — for reasons that have nothing to do with what is measured. */
    const stores = [status]
    const { rerender } = render(
      <Library {...shelf} books={books} bookActions={actions} bookStatuses={stores} />,
    )
    await act(async () => {})
    /* What ONE render of this shelf costs, measured rather than assumed. */
    when.mockClear()
    act(() => {
      rerender(<Library {...shelf} books={books} bookActions={actions} bookStatuses={stores} enriching={1} />)
    })
    const perRender = when.mock.calls.length
    expect(perRender).toBeGreaterThan(0)

    /* THREE FLUSHES, AND THAT IS THE WHOLE TEST. Publishing and swapping the
       stores inside one `act` is one render whichever way the tick goes, which
       passes either way and measures nothing. Nothing awaits between the two
       lines below, so the microtask is still queued when the effect is torn
       down — the moment this is about. */
    when.mockClear()
    act(() => {
      fire()
    })
    act(() => {
      rerender(<Library {...shelf} books={books} bookActions={actions} bookStatuses={[]} enriching={1} />)
    })
    await act(async () => {})
    /* The swap itself, and nothing for the tick that arrived too late. */
    expect(when.mock.calls.length).toBe(perRender)
  })

  it('subscribes to the store it is given now, not the one it was given first', async () => {
    let fire = () => {}
    let answer: { label: string } | null = null
    const second: BookStatus = {
      id: 'test:second',
      subscribe: (listener) => {
        fire = listener
        return () => {}
      },
      of: () => answer,
    }
    const { rerender } = render(<Library {...shelf} bookStatuses={[]} />)
    rerender(<Library {...shelf} bookStatuses={[second]} />)
    await act(async () => {})
    answer = { label: 'Added from Laptop' }
    await act(async () => {
      fire()
    })
    expect(screen.getAllByText('Added from Laptop').length).toBeGreaterThan(0)
  })
})
