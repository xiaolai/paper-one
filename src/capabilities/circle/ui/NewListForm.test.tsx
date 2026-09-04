// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewListForm } from './NewListForm'

afterEach(cleanup)

describe('the one way a list starts', () => {
  it('offers Start only for a real title, hands over the trimmed title, and clears the field once the list exists', async () => {
    const onStart = vi.fn(() => Promise.resolve())
    render(<NewListForm busy={false} placeholder="A new list" onStart={onStart} />)
    const field = screen.getByLabelText('New list') as HTMLInputElement
    const start = () => screen.getByRole('button', { name: 'Start list' }) as HTMLButtonElement
    expect(start().disabled).toBe(true)
    fireEvent.change(field, { target: { value: '   ' } })
    expect(start().disabled).toBe(true)
    fireEvent.change(field, { target: { value: ' Whales ' } })
    expect(start().disabled).toBe(false)
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledWith('Whales'))
    await waitFor(() => expect(field.value).toBe(''))
  })

  it('keeps the title when starting fails, so the reader can try again, and is disabled while busy', async () => {
    const onStart = vi.fn(() => Promise.reject(new Error('no identity')))
    const view = render(<NewListForm busy={false} placeholder="A new list" onStart={onStart} />)
    const field = screen.getByLabelText('New list') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Whales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1))
    await new Promise((done) => setTimeout(done, 0))
    expect(field.value).toBe('Whales')
    view.rerender(<NewListForm busy={true} placeholder="A new list" onStart={onStart} />)
    expect((screen.getByRole('button', { name: 'Start list' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('New list') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('a start that answers false', () => {
  it('keeps the title for another try', async () => {
    const onStart = vi.fn(() => Promise.resolve(false))
    render(<NewListForm busy={false} placeholder="A new list" onStart={onStart} />)
    const field = screen.getByLabelText('New list') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Whales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    await waitFor(() => expect(onStart).toHaveBeenCalledWith('Whales'))
    await new Promise((done) => setTimeout(done, 0))
    expect(field.value).toBe('Whales')
  })
})
