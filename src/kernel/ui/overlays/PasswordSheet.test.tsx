// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PasswordSheet } from './PasswordSheet'

afterEach(cleanup)

const mount = (reason: 'needed' | 'wrong' = 'needed') => {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  render(<PasswordSheet name="Locked.pdf" reason={reason} onSubmit={onSubmit} onCancel={onCancel} />)
  return { onSubmit, onCancel }
}

describe('PasswordSheet', () => {
  it('names the file and asks for its password', () => {
    mount()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Locked.pdf')
    expect(dialog.textContent).toMatch(/password/i)
    expect(dialog.textContent).not.toMatch(/wrong/i)
    /* Focus moved INTO the modal. `OverlaySheet` puts it on the field first —
       but it selects the first VISIBLE focusable by `offsetParent`, which
       jsdom, having no layout, reports null for everything; so here the sheet
       takes focus itself, which is the sheet's documented fallback and still
       inside the dialog. The field-first rule is the sheet's own test's. */
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('says so when the last password was wrong, rather than asking as if for the first time', () => {
    mount('wrong')
    expect(screen.getByRole('dialog').textContent).toMatch(/wrong/i)
  })

  it('hands the typed password over on Unlock, and on Enter', () => {
    const { onSubmit } = mount()
    const field = screen.getByLabelText('Password')
    fireEvent.change(field, { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(onSubmit).toHaveBeenCalledWith('secret')

    fireEvent.change(field, { target: { value: 'again' } })
    fireEvent.submit(field.closest('form')!)
    expect(onSubmit).toHaveBeenLastCalledWith('again')
  })

  it('does not submit an empty password — there is nothing to try', () => {
    const { onSubmit } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cancels on the button, on Escape, and on the scrim', () => {
    const { onCancel, onSubmit } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByLabelText('Password'), { key: 'Escape' })
    fireEvent.pointerDown(document.querySelector('[data-overlay-scrim]')!, { isPrimary: true, button: 0 })
    expect(onCancel).toHaveBeenCalledTimes(3)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps Escape from reaching the host, whose own Escape dismisses something else', () => {
    mount()
    const reached = vi.fn()
    document.addEventListener('keydown', reached)
    try {
      fireEvent.keyDown(screen.getByLabelText('Password'), { key: 'Escape' })
      expect(reached).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', reached)
    }
  })
})
