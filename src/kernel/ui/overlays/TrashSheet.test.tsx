// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrashSheet } from './TrashSheet'
import { TRASH_KEPT_FOR, type TrashedBook } from '../../core/bookTrash'

/**
 * THE SURFACE THAT KEEPS A PROMISE THE APP WAS ALREADY MAKING.
 *
 * Removing a book showed a sheet saying the removal was "recoverable for two
 * weeks". It was — through `paper book restore`, in a terminal. `trash.list`
 * and `book.restore` had been services since phase 11 and nothing in the app
 * reached either, so the guarantee printed on screen could only be kept by a
 * reader who knew a CLI existed.
 *
 * It matters most on a SECOND DEVICE. A removal replicates, so a book deleted
 * on a laptop leaves the desktop too — silently — and the reader who did not
 * delete it had no way to ask what happened or undo it.
 */

afterEach(cleanup)

const row = (over: Partial<TrashedBook> = {}): TrashedBook => ({
  folder: 'bad-blood',
  bookId: 'bk1',
  title: 'Bad Blood',
  author: 'Carreyrou, John',
  removedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_000_000 + 14 * 24 * 60 * 60 * 1000,
  ...over,
})

const NOW = 1_700_000_000_000 + 24 * 60 * 60 * 1000

const shared = { loading: false, error: null, onRestore: vi.fn(), onDismiss: vi.fn(), now: NOW } as const

describe('the removed-books sheet', () => {
  it('lists what was removed, with how long is left to change your mind', () => {
    /* The days-left figure is the one that decides whether to act now, so it
       has to be on the row rather than a click away. */
    render(<TrashSheet {...shared} rows={[row()]} />)
    expect(screen.getByText('Bad Blood')).toBeTruthy()
    expect(screen.getByText('13 days left')).toBeTruthy()
  })

  it('puts a book back by id, not by folder', () => {
    /* `restore` takes the book id; the folder is a path detail and passing it
       would restore nothing while reporting success. */
    const onRestore = vi.fn()
    render(<TrashSheet {...shared} rows={[row()]} onRestore={onRestore} />)
    fireEvent.click(screen.getByTitle('Put Bad Blood back in the library'))
    expect(onRestore).toHaveBeenCalledWith('bk1')
  })

  it('says what the room is for when it is empty', () => {
    /* A reader opens this because a book vanished. "Nothing removed" alone
       leaves them unsure whether they are even in the right place. */
    render(<TrashSheet {...shared} rows={[]} />)
    expect(screen.getByText(/Nothing removed/)).toBeTruthy()
    expect(screen.getByText(/wait here for two weeks/)).toBeTruthy()
  })

  it('does not claim an empty trash while it is still reading one', () => {
    /* `listTrash` opens a `book.json` per folder. On a shelf with a
       fortnight of removals that is not instant, and "Nothing removed" shown
       in the gap is a wrong answer the reader may act on by re-importing. */
    render(<TrashSheet {...shared} rows={[]} loading />)
    expect(screen.queryByText(/Nothing removed/)).toBeNull()
    expect(screen.getByText(/Reading the trash/)).toBeTruthy()
  })

  it('offers a restore for every row, not just the first', () => {
    render(
      <TrashSheet
        {...shared}
        rows={[row(), row({ bookId: 'bk2', title: 'Seeing Like a State', folder: 'seeing' })]}
      />,
    )
    expect(screen.getAllByText('Restore').length).toBe(2)
  })

  it('reports an entry whose removal time could not be read as kept', () => {
    /* The sweep LEAVES those rather than guessing at an age, so the row must
       not imply a deadline that nothing will enforce. */
    render(<TrashSheet {...shared} rows={[row({ removedAt: null, expiresAt: null })]} />)
    expect(screen.getByText('Kept')).toBeTruthy()
  })

  it('measures every row against one now', () => {
    /* Two books removed in the same second must report the same days left. */
    render(
      <TrashSheet
        {...shared}
        rows={[row(), row({ bookId: 'bk2', title: 'Seeing Like a State', folder: 'seeing' })]}
      />,
    )
    expect(screen.getAllByText('13 days left').length).toBe(2)
  })

  it('closes on a click outside it', () => {
    /* THE SCRIM, not Escape. `OverlaySheet` traps Tab and dismisses on a
       primary pointer-down on the scrim; Escape belongs to the app's layer
       stack, which closes the topmost layer — so a test that pressed Escape
       here would be asserting a mechanism this component does not own. */
    const onDismiss = vi.fn()
    const { container } = render(<TrashSheet {...shared} rows={[row()]} onDismiss={onDismiss} />)
    const scrim = container.querySelector('[data-overlay-scrim]')
    expect(scrim).toBeTruthy()
    fireEvent.pointerDown(scrim!, { isPrimary: true, button: 0 })
    expect(onDismiss).toHaveBeenCalled()
  })

  it('says a read FAILED rather than that the trash is empty', () => {
    /* `listTrash` throws for a trash that exists and will not read — on
       purpose, so unreadable is never reported as empty. Collapsing that into
       "Nothing removed" tells a reader their book is gone on the one surface
       built to get it back. */
    render(<TrashSheet {...shared} rows={[]} error="EACCES" />)
    expect(screen.getByText(/could not be read/)).toBeTruthy()
    expect(screen.queryByText(/Nothing removed/)).toBeNull()
  })

  it('names a book whose record could not be read', () => {
    /* `listTrash` returns an empty title for an unreadable `book.json`, which
       is one of the reasons a book needs rescuing in the first place. The old
       row was blank above a button reading "Put  back in the library". */
    render(<TrashSheet {...shared} rows={[row({ title: '', folder: 'bad-blood' })]} />)
    expect(screen.getByText('bad-blood')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restore bad-blood' })).toBeTruthy()
  })

  it('gives each restore button the book\'s name, not just "Restore"', () => {
    /* Every button had the same accessible name, so a screen-reader user
       could not tell which book they were about to put back. */
    render(
      <TrashSheet
        {...shared}
        rows={[row(), row({ bookId: 'bk2', title: 'Seeing Like a State', folder: 'seeing' })]}
      />,
    )
    expect(screen.getByRole('button', { name: 'Restore Bad Blood' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restore Seeing Like a State' })).toBeTruthy()
  })

  it('takes the retention window from the constant that governs the sweep', () => {
    /* `TRASH_KEPT_FOR` exists precisely to stop this copy drifting from
       `TRASH_DAYS`, and the empty state had "two weeks" typed into it. */
    render(<TrashSheet {...shared} rows={[]} />)
    expect(screen.getByText(new RegExp(TRASH_KEPT_FOR))).toBeTruthy()
  })

  it('shows the row working, and refuses a second press', async () => {
    /* A restore moves a folder file by file — slow and fallible — and the
       button used to be fire-and-forget, so a reader with a large book
       pressed a control that looked untouched and pressed it again. */
    let release = () => {}
    const onRestore = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    render(<TrashSheet {...shared} rows={[row()]} onRestore={onRestore} />)
    const button = screen.getByRole('button', { name: 'Restore Bad Blood' })
    fireEvent.click(button)
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Restoring…')).toBeTruthy()
    fireEvent.click(button)
    expect(onRestore).toHaveBeenCalledTimes(1)
    release()
    await waitFor(() => expect(screen.getByText('Restore')).toBeTruthy())
  })

  it('gives the row back when the restore fails', async () => {
    /* Both failure shapes. A dead button on the surface that exists to undo a
       deletion is the worst place to leave one. */
    for (const failing of [
      () => Promise.reject(new Error('EIO')),
      () => {
        throw new Error('EIO')
      },
    ]) {
      render(<TrashSheet {...shared} rows={[row()]} onRestore={failing} />)
      const button = screen.getByRole('button', { name: 'Restore Bad Blood' }) as HTMLButtonElement
      fireEvent.click(button)
      await waitFor(() => expect(button.disabled, 'the row let go').toBe(false))
      cleanup()
    }
  })

  it('announces itself as a dialog, named', () => {
    /* A reader on a screen reader is told what took the window. */
    render(<TrashSheet {...shared} rows={[row()]} />)
    expect(screen.getByRole('dialog', { name: 'Removed books' })).toBeTruthy()
  })
})
