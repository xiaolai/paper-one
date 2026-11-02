// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TabBar, type Tab } from './TabBar'

/**
 * WHAT A TAP ASKS FOR, AND WHICH TAB SAYS IT IS CURRENT.
 *
 * Both shells mount this bar, and both were tested only through it: the phone's
 * render test presses Settings and nothing else, and the browser's wiring test
 * stubs the bar out. So the one rule this component owns — Reading with no book
 * goes to the shelf — had no test, and neither had which tab is marked current.
 */

afterEach(cleanup)

function mount(active: Tab, hasBook: boolean) {
  const onSelect = vi.fn<(tab: Tab) => void>()
  render(<TabBar active={active} onSelect={onSelect} hasBook={hasBook} />)
  return onSelect
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

describe('TabBar', () => {
  it.each<Tab>(['library', 'reading', 'settings'])('marks %s, and only it, as the current page', (active) => {
    mount(active, true)
    const current = screen.getAllByRole('button').filter((tab) => tab.getAttribute('aria-current') === 'page')
    expect(current.map((tab) => tab.textContent?.toLowerCase())).toEqual([active])
  })

  it('asks for each tab by its own id while there is a book', () => {
    const onSelect = mount('library', true)
    press('Library')
    press('Reading')
    press('Settings')
    expect(onSelect.mock.calls).toEqual([['library'], ['reading'], ['settings']])
  })

  /* A tab that opens an empty reader is a tab that does nothing. */
  it('sends Reading to the shelf when there is no book, and leaves the others alone', () => {
    const onSelect = mount('settings', false)
    press('Reading')
    press('Library')
    press('Settings')
    expect(onSelect.mock.calls).toEqual([['library'], ['library'], ['settings']])
  })
})
