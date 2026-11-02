// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedBook } from '../../core/bookIndex'
import { NO_TAG_PREFS, type TagPrefs } from '../../core/tagPrefs'
import type { TagPrefsStore } from '../hooks/useTagPrefs'
import { LibraryPanel, type LibraryPanelProps } from './LibraryPanel'

/**
 * THE LIBRARY PANEL, RENDERED ON ITS OWN, asked what it draws for a shelf and a
 * query and what each of its controls sends.
 *
 * `SidePane.behaviour.test.tsx` only asks whether this panel is the one drawn;
 * nothing asked which of its sections appear, and when. Every case here is a
 * shelf a reader could have — no source text is read.
 */

/**
 * A tag's menu places itself against its row, and in jsdom no element has a
 * box — the row would read as detached and the menu shut as it opened.
 * `SidePane.behaviour.test.tsx` carries the same stub for the same reason.
 */
Element.prototype.getBoundingClientRect = function (): DOMRect {
  return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
}

beforeEach(() => {
  /* jsdom has no `ResizeObserver`; the menu's placement watches its row. */
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A shelf row: only what the panel reads — its id, its tags, its subjects. */
const book = (bookId: string, over: { tags?: readonly string[]; subjects?: readonly string[] } = {}): IndexedBook =>
  ({ bookId, title: bookId, ...over }) as unknown as IndexedBook

const prefsStore = (prefs: Partial<TagPrefs> = {}): TagPrefsStore => ({
  prefs: { ...NO_TAG_PREFS, ...prefs },
  persistent: true,
  togglePinned: vi.fn(),
  setColour: vi.fn(),
  toggleHidden: vi.fn(),
  saveView: vi.fn(),
  renameView: vi.fn(),
  removeView: vi.fn(),
})

function propsOf(over: Partial<LibraryPanelProps> = {}): LibraryPanelProps {
  return {
    books: [],
    query: '',
    dispatch: vi.fn(),
    onRenameTag: vi.fn(),
    onRemoveTag: vi.fn(),
    tagPrefs: prefsStore(),
    lastRemoval: null,
    onUndoRemoveTag: vi.fn(),
    onAdoptTag: vi.fn(),
    onTagBooks: vi.fn(),
    ...over,
  }
}

function draw(over: Partial<LibraryPanelProps> = {}) {
  const props = propsOf(over)
  const view = render(<LibraryPanel {...props} />)
  return {
    ...view,
    props,
    dispatch: vi.mocked(props.dispatch),
    /** The same panel with some props changed — the host re-rendering it. */
    redraw: (next: Partial<LibraryPanelProps>) => view.rerender(<LibraryPanel {...props} {...next} />),
  }
}

/** A group's heading, by the word it starts with — `Views 2` names `Views`. */
const heading = (title: string) => screen.queryByRole('heading', { name: new RegExp(`^${title}`) })

/**
 * Every tag row drawn, in order, as the words on it: label then count.
 * A tag row is the scope button inside a row that takes dropped books.
 */
const tagRows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-over] > button[aria-pressed]')].map(
    (row) => row.textContent ?? '',
  )

/**
 * What the reader would see written in the tag list, in order: each tag row as
 * its words, and each group heading that is not a row as its word.
 */
const tagSection = (): string[] => {
  const body = document.getElementById(
    screen.getByRole('button', { name: 'Tags' }).getAttribute('aria-controls') ?? '',
  )
  const said: string[] = []
  for (const one of body?.querySelectorAll<HTMLElement>('button, div') ?? []) {
    const row =
      one.tagName === 'BUTTON' &&
      one.hasAttribute('aria-pressed') &&
      one.parentElement?.hasAttribute('data-over') === true
    const head = one.tagName === 'DIV' && one.children.length === 0 && (one.textContent ?? '') !== ''
    if (row || head) said.push(one.textContent ?? '')
  }
  return said
}

const queries = (dispatch: ReturnType<typeof draw>['dispatch']) =>
  dispatch.mock.calls.map(([action]) => (action as { query?: string }).query)

describe('an empty shelf', () => {
  it('says the shelf is empty and offers no tags and no views', () => {
    draw()
    expect(screen.getByText('Nothing on the shelf yet')).not.toBeNull()
    expect(heading('Tags')).toBeNull()
    expect(heading('Views')).toBeNull()
  })

  it('says nothing of emptiness once there is a book', () => {
    draw({ books: [book('a', { tags: ['Sea'] })] })
    expect(screen.queryByText('Nothing on the shelf yet')).toBeNull()
  })
})

describe('saved views', () => {
  const kept = { id: 'v1', name: 'In flight', query: 'is:reading' }

  it('are not offered over an unscoped shelf with nothing saved', () => {
    draw({ books: [book('a', { tags: ['Sea'] })] })
    expect(heading('Views')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save this view' })).toBeNull()
  })

  it('are listed when one is kept, with no offer to save an unscoped shelf', () => {
    draw({ books: [book('a')], tagPrefs: prefsStore({ views: [kept] }) })
    expect(heading('Views')?.textContent).toBe('Views1')
    expect(screen.getByRole('button', { name: 'In flight' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save this view' })).toBeNull()
  })

  it('offer no second copy of the view already chosen', () => {
    draw({ books: [book('a')], query: 'is:reading', tagPrefs: prefsStore({ views: [kept] }) })
    expect(screen.getByRole('button', { name: 'In flight' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Save this view' })).toBeNull()
  })

  it('offer to save a scope with nothing kept yet, and save it under the name given', () => {
    const tagPrefs = prefsStore()
    draw({ books: [book('a')], query: 'is:reading', tagPrefs })
    expect(heading('Views')?.textContent).toBe('Views0')
    fireEvent.click(screen.getByRole('button', { name: 'Save this view' }))
    const name = screen.getByRole('textbox', { name: 'Name for this view' })
    fireEvent.change(name, { target: { value: 'Now' } })
    fireEvent.submit(name)
    expect(vi.mocked(tagPrefs.saveView).mock.calls).toEqual([['Now', 'is:reading']])
    expect(screen.getByRole('button', { name: 'Save this view' })).not.toBeNull()
  })
})

describe('the tag section', () => {
  it('lists the reader’s tags, most used first, and by name at the press of its tool', () => {
    draw({ books: [book('a', { tags: ['Sea'] }), book('b', { tags: ['Sea', 'Art'] })] })
    expect(tagRows()).toEqual(['Sea2', 'Art1'])
    const tool = screen.getByRole('button', { name: 'Sort tags by name' })
    expect(tool.getAttribute('title')).toBe('Sort by name')
    expect(tool.querySelector('svg')?.getAttribute('class')).toContain('lucide-arrow-down-a-z')

    fireEvent.click(tool)
    expect(tagRows()).toEqual(['Art1', 'Sea2'])
    const back = screen.getByRole('button', { name: 'Sort tags by how many books' })
    expect(back.getAttribute('title')).toBe('Sort by count')
    expect(back.querySelector('svg')?.getAttribute('class')).toContain('lucide-arrow-down-wide-narrow')

    fireEvent.click(back)
    expect(tagRows()).toEqual(['Sea2', 'Art1'])
  })

  it('groups tags on the slash, under a row where the prefix is a tag and a heading where it is not', () => {
    draw({
      books: [
        book('a', { tags: ['Fiction', 'Fiction/Sea', 'Fiction/Ships'] }),
        book('b', { tags: ['Fiction/Sea', 'Poetry/Odes', 'Art'] }),
      ],
    })
    expect(tagSection()).toEqual(['Fiction1', 'Sea2', 'Ships1', 'Art1', 'Poetry', 'Odes1'])
  })

  it('keeps every group and every member when the order is turned', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    draw({
      books: [
        book('a', { tags: ['Fiction/Sea', 'Poetry/Odes'] }),
        book('b', { tags: ['Fiction/Sea', 'Poetry/Odes', 'Poetry/Lays'] }),
        book('c', { tags: ['Poetry/Odes'] }),
      ],
    })
    expect(tagSection()).toEqual(['Poetry', 'Odes3', 'Lays1', 'Fiction', 'Sea2'])
    fireEvent.click(screen.getByRole('button', { name: 'Sort tags by name' }))
    expect(tagSection()).toEqual(['Fiction', 'Sea2', 'Poetry', 'Lays1', 'Odes3'])
    expect(error).not.toHaveBeenCalled()
  })
})

describe('the name filter', () => {
  /** Thirteen tags, one per book — one more than the field waits for — and a book with none. */
  const thirteen = [
    ...Array.from({ length: 13 }, (_, at) => book(`b${at}`, { tags: [`T${String(at + 1).padStart(2, '0')}`] })),
    book('bare'),
  ]

  it('is not offered for a list short enough to read', () => {
    draw({ books: thirteen.slice(1) })
    expect(tagRows()).toHaveLength(12)
    expect(screen.queryByRole('searchbox', { name: 'Filter the tag list' })).toBeNull()
  })

  it('is offered for a longer one, narrows it, and stays while it holds text however short the list gets', () => {
    const { redraw } = draw({ books: thirteen })
    const field = screen.getByRole('searchbox', { name: 'Filter the tag list' })
    expect(screen.getByRole('button', { name: /^Untagged/ })).not.toBeNull()

    fireEvent.change(field, { target: { value: 't1' } })
    expect(tagRows()).toEqual(['T101', 'T111', 'T121', 'T131'])
    /* A name filter is about tags, and the untagged are not one. */
    expect(screen.queryByRole('button', { name: /^Untagged/ })).toBeNull()

    redraw({ query: 'tag:T10' })
    expect(tagRows()).toEqual(['T101'])
    expect(screen.getByRole('searchbox', { name: 'Filter the tag list' })).toHaveProperty('value', 't1')
  })
})

describe('the untagged row', () => {
  it('is absent when every book carries a tag of the reader’s', () => {
    draw({ books: [book('a', { tags: ['Sea'] })] })
    expect(screen.queryByRole('button', { name: /^Untagged/ })).toBeNull()
  })

  it('counts the books with none, and scopes to them', () => {
    const { dispatch } = draw({ books: [book('a', { tags: ['Sea'] }), book('b', { subjects: ['History'] })] })
    const untagged = screen.getByRole('button', { name: /^Untagged/ })
    expect(untagged.textContent).toBe('Untagged1')
    expect(untagged.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(untagged)
    expect(queries(dispatch)).toEqual(['is:untagged'])
  })

  it('stays, lit, while it is the scope, even with nothing behind it', () => {
    draw({ books: [book('a', { tags: ['Sea'] })], query: 'is:untagged' })
    const untagged = screen.getByRole('button', { name: /^Untagged/ })
    expect(untagged.textContent).toBe('Untagged0')
    expect(untagged.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('hidden subjects', () => {
  const shelf = [book('a', { tags: ['Sea'], subjects: ['History', 'Travel', 'Maps'] })]
  const hiddenLine = () => screen.queryByText(/hidden$/)

  it('are not mentioned when none is hidden', () => {
    draw({ books: shelf })
    expect(hiddenLine()).toBeNull()
  })

  it('are counted in the singular, and all shown again at one press', () => {
    const tagPrefs = prefsStore({ hiddenSubjects: ['history'] })
    draw({ books: shelf, tagPrefs })
    expect(hiddenLine()?.textContent).toBe('1 subject hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(vi.mocked(tagPrefs.toggleHidden).mock.calls).toEqual([['history']])
  })

  it('are counted in the plural', () => {
    const tagPrefs = prefsStore({ hiddenSubjects: ['history', 'travel'] })
    draw({ books: shelf, tagPrefs })
    expect(hiddenLine()?.textContent).toBe('2 subjects hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(vi.mocked(tagPrefs.toggleHidden).mock.calls).toEqual([['history'], ['travel']])
  })
})

describe('the subjects group', () => {
  it('lists what only publishers say, apart from the reader’s tags', () => {
    draw({ books: [book('a', { tags: ['Sea'], subjects: ['History'] })] })
    const subjects = heading('Subjects')
    expect(subjects?.textContent).toBe('Subjects1')
    expect(tagRows()).toEqual(['Sea1', 'History1'])
  })

  it('is absent from a shelf whose publishers said nothing', () => {
    draw({ books: [book('a', { tags: ['Sea'] })] })
    expect(heading('Subjects')).toBeNull()
  })
})

describe('the way back from a removal', () => {
  const said = () => screen.queryByText(/^Removed/)?.textContent

  it('is not offered when nothing was removed', () => {
    draw({ books: [book('a', { tags: ['Sea'] })] })
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('names the tag and the one book it came off, and undoes at a press', () => {
    const { props } = draw({ books: [book('a')], lastRemoval: { tag: 'Sea', bookIds: ['a'] } })
    expect(said()).toBe('Removed Sea from 1 book')
    fireEvent.click(within(screen.getByText(/^Removed/).parentElement!).getByRole('button', { name: 'Undo' }))
    expect(props.onUndoRemoveTag).toHaveBeenCalledTimes(1)
  })

  it('counts the books in the plural', () => {
    draw({ books: [book('a'), book('b')], lastRemoval: { tag: 'Sea', bookIds: ['a', 'b'] } })
    expect(said()).toBe('Removed Sea from 2 books')
  })
})
