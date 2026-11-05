// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Search } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterChips } from './FilterChips'

afterEach(cleanup)

/**
 * The chip row, drawn as icons and named by each option's word.
 */
describe('filter chips', () => {
  const OPTIONS = ['All', 'Notes', 'Marks'] as const
  const ICONS = { All: Search, Notes: Search, Marks: Search }

  it('draw each option as its icon, named by its word, and say which one is on', () => {
    render(<FilterChips options={OPTIONS} active="Notes" onSelect={() => {}} label="Show" icons={ICONS} />)
    const chips = screen.getAllByRole('button')
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual(['All', 'Notes', 'Marks'])
    expect(chips.map((chip) => chip.getAttribute('title'))).toEqual(['All', 'Notes', 'Marks'])
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    expect(chips.map((chip) => chip.getAttribute('data-on'))).toEqual(['false', 'true', 'false'])
    expect(chips.every((chip) => chip.textContent === '' && chip.querySelector('svg') !== null)).toBe(true)
    expect(screen.getByRole('group', { name: 'Show' })).toBeTruthy()
  })

  it('hand back the option pressed', () => {
    const onSelect = vi.fn()
    render(<FilterChips options={OPTIONS} active="All" onSelect={onSelect} label="Show" icons={ICONS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Marks' }))
    expect(onSelect).toHaveBeenCalledWith('Marks')
  })
})
