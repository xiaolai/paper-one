// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Search } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterChips } from './FilterChips'

afterEach(cleanup)

/**
 * The chip row in its two shapes. Marginalia draws icons; a row handed no
 * icons draws each option as its word, and that shape has no other test.
 */
describe('filter chips', () => {
  const OPTIONS = ['All', 'Notes', 'Marks'] as const

  it('draw each option as its word when handed no icons, and say which one is on', () => {
    render(<FilterChips options={OPTIONS} active="Notes" onSelect={() => {}} label="Show" />)
    const chips = screen.getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual(['All', 'Notes', 'Marks'])
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    expect(chips.some((chip) => chip.hasAttribute('title') || chip.querySelector('svg') !== null)).toBe(false)
    expect(screen.getByRole('group', { name: 'Show' })).toBeTruthy()
  })

  it('draw each option as its icon when handed them, named by its word', () => {
    render(
      <FilterChips
        options={OPTIONS}
        active="All"
        onSelect={() => {}}
        label="Show"
        icons={{ All: Search, Notes: Search, Marks: Search }}
      />,
    )
    const notes = screen.getByRole('button', { name: 'Notes' })
    expect(notes.getAttribute('title')).toBe('Notes')
    expect(notes.textContent).toBe('')
    expect(notes.querySelector('svg')).not.toBeNull()
  })

  it('hand back the option pressed', () => {
    const onSelect = vi.fn()
    render(<FilterChips options={OPTIONS} active="All" onSelect={onSelect} label="Show" />)
    fireEvent.click(screen.getByRole('button', { name: 'Marks' }))
    expect(onSelect).toHaveBeenCalledWith('Marks')
  })
})
