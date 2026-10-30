// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMark, type Annotation, type MarkAppearance, type NewMark, type Placed } from '../../core/marks'
import type { SelectionSnapshot } from '../reader/session'
import { useMarking } from './useMarking'
import type { Book } from './useBook'
import type { MarksView } from './useMarks'

/**
 * The focus request's lifetime — the half of WI-20.15 that lives in the owner.
 *
 * `focusMark` asked and nothing ever answered: the request sat in state for
 * the life of the session, and every consumer that mounted or re-ran saw it
 * again. The Marginalia panel now says when it has honoured one, and the
 * owner clears it — but only THAT one, because a second request can land
 * while the first is still being scrolled to, and a clear that did not check
 * would throw the newer request away.
 */

afterEach(cleanup)

const book = () =>
  ({
    bookId: 'open-book',
    drawMark: vi.fn(),
    eraseMark: vi.fn(),
    deselect: vi.fn(),
    doc: null,
    position: { chapterLabel: 'Loomings' },
  }) as unknown as Book

const marks = () => ({ current: [], add: vi.fn(), remove: vi.fn() }) as unknown as MarksView

/**
 * ⚠️ **THE SURFACES OFFERED MARK FOR A SELECTION `mark` REFUSES** (2026-09-13
 * audit, #202). `view.getCFI` answers `''` for a range it cannot address, and
 * `mark` refuses that — rightly — so the reader pressed Mark or Note and
 * nothing happened. The rule is this hook's, so the hook says it; a surface
 * that spelled `cfi === ''` for itself would be a second copy of the rule.
 */
describe('whether the selection can be marked', () => {
  const selecting = (cfi: string) =>
    ({ cfi, sectionIndex: 0, text: 'gams', prefix: '', suffix: '', range: {} as Range }) as never

  it('holds exactly when `mark` would lay one down', () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useMarking(book(), marks()))
    expect(result.current.canMark, 'nothing is selected').toBe(false)

    act(() => result.current.setSelection(selecting('epubcfi(/6/4!/4/2,/1:0,/1:4)')))
    expect(result.current.canMark).toBe(true)

    act(() => result.current.setSelection(selecting('')))
    expect(result.current.canMark, 'a selection with no anchor was offered for marking').toBe(false)
    expect(result.current.mark('', { tint: 'yellow', style: 'fill' })).toBeNull()
    quiet.mockRestore()
  })

  it('does not hold without a book to keep the mark in', () => {
    const noBook = { ...book(), bookId: null } as unknown as Book
    const { result } = renderHook(() => useMarking(noBook, marks()))
    act(() => result.current.setSelection(selecting('epubcfi(/6/4!/4/2,/1:0,/1:4)')))
    expect(result.current.canMark).toBe(false)
  })
})

describe('a focus request', () => {
  it('is cleared once the panel says it has been honoured', () => {
    const { result } = renderHook(() => useMarking(book(), marks()))
    act(() => result.current.focusMark('m1', true))
    const asked = result.current.focus
    expect(asked).toMatchObject({ id: 'm1', edit: true })

    act(() => result.current.clearFocus(asked!.nonce))
    expect(result.current.focus).toBeNull()
  })

  it('survives a clear that names an older request', () => {
    const { result } = renderHook(() => useMarking(book(), marks()))
    act(() => result.current.focusMark('m1'))
    const first = result.current.focus!.nonce
    act(() => result.current.focusMark('m2'))
    /* The panel finished with m1 after m2 had been asked for. m2 is still
       owed; clearing on m1's word would lose it. */
    act(() => result.current.clearFocus(first))
    expect(result.current.focus).toMatchObject({ id: 'm2' })
  })

  it('asks to see a mark unless it is told to open the editor', () => {
    const { result } = renderHook(() => useMarking(book(), marks()))
    act(() => result.current.focusMark('m1'))
    const seeing = result.current.focus!
    expect(seeing).toMatchObject({ id: 'm1', edit: false })

    act(() => result.current.focusMark('m1', true))
    expect(result.current.focus).toMatchObject({ id: 'm1', edit: true })
    /* The same mark asked for twice is two requests, or the second click does nothing. */
    expect(result.current.focus!.nonce).not.toBe(seeing.nonce)
  })

  it('need not exist for the panel’s clear to be harmless', () => {
    /* The panel can answer after the request has already gone — a remount, a
       second clear. Nothing is asked for, so nothing changes. */
    const { result } = renderHook(() => useMarking(book(), marks()))
    act(() => result.current.clearFocus(1))
    expect(result.current.focus).toBeNull()
  })
})

const GREEN_WAVE: MarkAppearance = { tint: 'green', style: 'wave' }

const selectionOf = (over: Partial<SelectionSnapshot> = {}): SelectionSnapshot => ({
  cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)',
  sectionIndex: 0,
  text: 'Ishmael',
  prefix: 'Call me ',
  suffix: '. Some years',
  range: {} as Range,
  ...over,
})

/** A highlight the open book already keeps, over the passage `selectionOf` sits inside. */
const kept = (over: Partial<NewMark> = {}) =>
  createMark({
    bookId: 'open-book',
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:20)',
    sectionIndex: 0,
    text: 'Call me Ishmael. Som',
    prefix: '',
    suffix: '',
    note: 'what I thought about it',
    kind: 'highlight',
    tint: 'purple',
    style: 'underline',
    chapter: 'Loomings',
    ...over,
  }) as Placed<Annotation>

/** A marks view whose `add` mints the way the real one does, holding `current` still. */
const keeping = (current: readonly Placed<Annotation>[] = [], add = (draft: NewMark) => createMark(draft)) =>
  ({ current, add: vi.fn(add), remove: vi.fn() }) as unknown as MarksView & {
    add: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  }

type Spied = Book & {
  drawMark: ReturnType<typeof vi.fn>
  eraseMark: ReturnType<typeof vi.fn>
  deselect: ReturnType<typeof vi.fn>
}

/**
 * The ⌘D path: a selection in, a mark out.
 *
 * The draft handed to the store is asserted WHOLE, because every field of it is
 * something a reader sees again — the passage, the words either side that
 * re-anchor it, the chapter it says it came from, and the note.
 */
describe('marking the selection', () => {
  it('lays down exactly the passage selected, in the appearance asked for, and consumes the selection', () => {
    const reader = book() as Spied
    const view = keeping()
    const { result } = renderHook(() => useMarking(reader, view))
    act(() => result.current.setSelection(selectionOf({ sectionIndex: 2 })))

    let made: Placed<Annotation> | null = null
    act(() => {
      made = result.current.mark('a gam', GREEN_WAVE)
    })

    expect(view.add).toHaveBeenCalledTimes(1)
    expect(view.add).toHaveBeenCalledWith({
      bookId: 'open-book',
      cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)',
      sectionIndex: 2,
      text: 'Ishmael',
      prefix: 'Call me ',
      suffix: '. Some years',
      note: 'a gam',
      kind: 'highlight',
      tint: 'green',
      style: 'wave',
      chapter: 'Loomings',
    })
    expect(made, 'the mark handed back is not the one the store minted').toBe(view.add.mock.results[0]!.value)
    /* Drawn now, not when the section next rebuilds its overlay. */
    expect(reader.drawMark).toHaveBeenCalledWith(made)
    expect(reader.eraseMark, 'nothing was under the selection to replace').not.toHaveBeenCalled()
    /* §07: acting on a selection consumes it. */
    expect(reader.deselect).toHaveBeenCalledTimes(1)
    expect(result.current.selection).toBeNull()
  })

  it('leaves the selection standing when the caller is still trying appearances', () => {
    const reader = book() as Spied
    const { result } = renderHook(() => useMarking(reader, keeping()))
    const trying = selectionOf()
    act(() => result.current.setSelection(trying))

    act(() => void result.current.mark('', GREEN_WAVE, true))

    expect(reader.drawMark).toHaveBeenCalledTimes(1)
    expect(reader.deselect).not.toHaveBeenCalled()
    expect(result.current.selection).toBe(trying)
  })

  it('writes nothing with no selection, and nothing with no book to keep it in', () => {
    const reader = book() as Spied
    const view = keeping()
    const { result } = renderHook(() => useMarking(reader, view))
    expect(result.current.mark('', GREEN_WAVE)).toBeNull()

    const noBook = { ...book(), bookId: null } as unknown as Spied
    const elsewhere = renderHook(() => useMarking(noBook, view))
    act(() => elsewhere.result.current.setSelection(selectionOf()))
    expect(elsewhere.result.current.mark('', GREEN_WAVE)).toBeNull()

    expect(view.add).not.toHaveBeenCalled()
    expect(reader.drawMark).not.toHaveBeenCalled()
    expect(noBook.drawMark).not.toHaveBeenCalled()
  })

  it('says out loud that a selection with no anchor cannot be marked, and writes nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reader = book() as Spied
    const view = keeping()
    const { result } = renderHook(() => useMarking(reader, view))
    act(() => result.current.setSelection(selectionOf({ cfi: '' })))

    expect(result.current.mark('a gam', GREEN_WAVE)).toBeNull()
    expect(warn).toHaveBeenCalledWith('Paper: this selection has no anchor, so it cannot be marked')
    expect(view.add).not.toHaveBeenCalled()
    expect(reader.drawMark).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('finds the mark a selection sits inside, and none before anything is selected', () => {
    const before = kept()
    const { result } = renderHook(() => useMarking(book(), keeping([before])))
    expect(result.current.selected).toBe(null)

    act(() => result.current.setSelection(selectionOf()))
    expect(result.current.selected, 'part of a marked passage did not find its mark').toBe(before)
  })

  it('keeps the note already written on a passage marked again with none, and replaces its drawing', () => {
    const reader = book() as Spied
    const before = kept()
    const view = keeping([before])
    const { result } = renderHook(() => useMarking(reader, view))
    const drawn = {} as Range
    act(() => result.current.onMarkDrawn(before.cfi, drawn))
    act(() => result.current.setSelection(selectionOf()))

    let made: Placed<Annotation> | null = null
    act(() => {
      made = result.current.mark('', GREEN_WAVE)
    })

    expect(view.add.mock.calls[0]![0], 'marking a passage again deleted the note on it').toMatchObject({
      note: 'what I thought about it',
    })
    /* A different anchor: the old highlight is taken off the page and out of
       the margin's measurements, and the new one drawn. */
    expect(reader.eraseMark).toHaveBeenCalledWith(before)
    expect(result.current.ranges.has(before.cfi), 'the replaced mark’s range was left for the margin').toBe(false)
    expect(reader.drawMark).toHaveBeenCalledWith(made)
  })

  it('writes the note it is given over the one already on the passage', () => {
    const view = keeping([kept()])
    const { result } = renderHook(() => useMarking(book(), view))
    act(() => result.current.setSelection(selectionOf()))

    act(() => void result.current.mark('a later thought', GREEN_WAVE))

    expect(view.add.mock.calls[0]![0]).toMatchObject({ note: 'a later thought' })
  })

  it('leaves the old drawing alone when the new mark lands exactly on it', () => {
    const reader = book() as Spied
    const before = kept()
    const { result } = renderHook(() => useMarking(reader, keeping([before])))
    const drawn = {} as Range
    act(() => result.current.onMarkDrawn(before.cfi, drawn))
    act(() => result.current.setSelection(selectionOf({ cfi: before.cfi })))

    act(() => void result.current.mark('', GREEN_WAVE))

    expect(reader.eraseMark).not.toHaveBeenCalled()
    expect(result.current.ranges.get(before.cfi)).toBe(drawn)
    expect(reader.drawMark).toHaveBeenCalledTimes(1)
  })

  it('refuses loudly, before erasing anything, a mark the store handed back with no anchor', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reader = book() as Spied
    const before = kept()
    const view = keeping([before], (draft) => ({ ...createMark(draft), cfi: '' }))
    const { result } = renderHook(() => useMarking(reader, view))
    const drawn = {} as Range
    act(() => result.current.onMarkDrawn(before.cfi, drawn))
    const standing = selectionOf()
    act(() => result.current.setSelection(standing))

    let made: Placed<Annotation> | null = 'not asked' as never
    act(() => {
      made = result.current.mark('', GREEN_WAVE)
    })

    expect(made).toBeNull()
    const minted = view.add.mock.results[0]!.value as { id: string }
    expect(error).toHaveBeenCalledWith('Paper: a mark was created with no anchor and was not drawn', minted.id)
    /* The superseded highlight is still drawn and still measured: bailing out
       after the erase would trade it for nothing. */
    expect(reader.eraseMark).not.toHaveBeenCalled()
    expect(result.current.ranges.get(before.cfi)).toBe(drawn)
    expect(reader.drawMark).not.toHaveBeenCalled()
    expect(reader.deselect).not.toHaveBeenCalled()
    expect(result.current.selection).toBe(standing)
    error.mockRestore()
  })
})

describe('the ranges foliate drew', () => {
  it('holds one per anchor, and republishes only when one changes', () => {
    const { result } = renderHook(() => useMarking(book(), keeping()))
    expect(result.current.ranges.size).toBe(0)

    const first = {} as Range
    act(() => result.current.onMarkDrawn('epubcfi(/6/4!/4/2,/1:0,/1:20)', first))
    expect(result.current.ranges.get('epubcfi(/6/4!/4/2,/1:0,/1:20)')).toBe(first)

    /* The margin re-measures on this map's identity — the same range drawn
       again must not make it. */
    const measured = result.current.ranges
    act(() => result.current.onMarkDrawn('epubcfi(/6/4!/4/2,/1:0,/1:20)', first))
    expect(result.current.ranges).toBe(measured)

    const redrawn = {} as Range
    act(() => result.current.onMarkDrawn('epubcfi(/6/4!/4/2,/1:0,/1:20)', redrawn))
    expect(result.current.ranges.get('epubcfi(/6/4!/4/2,/1:0,/1:20)')).toBe(redrawn)
    expect(result.current.ranges).not.toBe(measured)
  })

  it('goes, with the selection, when the section’s document is replaced', () => {
    const reader = book()
    const view = keeping()
    const first = document.implementation.createHTMLDocument('one')
    const { result, rerender } = renderHook(({ doc }) => useMarking({ ...reader, doc } as Book, view), {
      initialProps: { doc: first as Document },
    })
    act(() => {
      result.current.onMarkDrawn('epubcfi(/6/4!/4/2,/1:0,/1:20)', {} as Range)
      result.current.setSelection(selectionOf())
    })

    rerender({ doc: first })
    expect(result.current.ranges.size, 'a render of the same document dropped its ranges').toBe(1)

    rerender({ doc: document.implementation.createHTMLDocument('two') })
    expect(result.current.ranges.size, 'the last chapter’s ranges were measured against this one').toBe(0)
    expect(result.current.selection, 'a selection in the replaced document survived it').toBeNull()
  })
})

describe('unmarking', () => {
  it('takes the row and the drawing away for a mark in the book on screen', () => {
    const reader = book() as Spied
    const view = keeping()
    const target = kept()
    const { result } = renderHook(() => useMarking(reader, view))
    act(() => result.current.onMarkDrawn(target.cfi, {} as Range))

    act(() => result.current.unmark(target))

    expect(view.remove).toHaveBeenCalledWith(target)
    expect(reader.eraseMark).toHaveBeenCalledWith(target)
    expect(result.current.ranges.has(target.cfi)).toBe(false)
  })

  it('leaves the ranges as they were for a mark foliate never drew', () => {
    const reader = book() as Spied
    const { result } = renderHook(() => useMarking(reader, keeping()))
    act(() => result.current.onMarkDrawn('epubcfi(/6/4!/4/2,/1:40,/1:60)', {} as Range))
    const measured = result.current.ranges

    act(() => result.current.unmark(kept()))

    expect(reader.eraseMark).toHaveBeenCalledTimes(1)
    expect(result.current.ranges, 'forgetting a range that was never held republished the map').toBe(measured)
  })

  it('takes another book’s row away without touching this book’s drawing at the same anchor', () => {
    const reader = book() as Spied
    const view = keeping()
    const theirs = kept({ bookId: 'another-book' })
    const { result } = renderHook(() => useMarking(reader, view))
    const drawn = {} as Range
    act(() => result.current.onMarkDrawn(theirs.cfi, drawn))

    act(() => result.current.unmark(theirs))

    expect(view.remove).toHaveBeenCalledWith(theirs)
    expect(reader.eraseMark).not.toHaveBeenCalled()
    expect(result.current.ranges.get(theirs.cfi)).toBe(drawn)
  })

  it('takes an unplaced mark’s row away, with nothing drawn to erase', () => {
    const reader = book() as Spied
    const view = keeping()
    const waiting = createMark({
      ...kept(),
      cfi: '',
      unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
    }) as Annotation
    const { result } = renderHook(() => useMarking(reader, view))

    act(() => result.current.unmark(waiting))

    expect(view.remove).toHaveBeenCalledWith(waiting)
    expect(reader.eraseMark).not.toHaveBeenCalled()
  })

  it('follows the book on screen when it changes', () => {
    const first = book() as Spied
    const second = { ...book(), bookId: 'second-book' } as unknown as Spied
    const firstView = keeping()
    const secondView = keeping()
    const { result, rerender } = renderHook(({ reader, view }) => useMarking(reader, view), {
      initialProps: { reader: first, view: firstView },
    })
    rerender({ reader: second, view: secondView })
    const target = kept({ bookId: 'second-book' })

    act(() => result.current.unmark(target))

    expect(secondView.remove).toHaveBeenCalledWith(target)
    expect(firstView.remove).not.toHaveBeenCalled()
    expect(second.eraseMark).toHaveBeenCalledWith(target)
  })
})
