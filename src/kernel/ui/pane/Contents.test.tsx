// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TocItem } from 'foliate-js/view.js'
import { Contents } from './Contents'

/**
 * `Contents` had no test, which is why three defects in one component survived:
 * a row whose enabled state and click handler disagreed about what counts as a
 * destination, a heading announced as a disabled control, and the current entry
 * marked only for the stylesheet.
 */

afterEach(cleanup)

const item = (label: string, href: string | null, subitems?: TocItem[]): TocItem =>
  ({ label, href, ...(subitems ? { subitems } : {}) }) as unknown as TocItem

describe('a row that goes nowhere', () => {
  it('is not a control at all, rather than a disabled one', () => {
    /* ⚠️ **A HEADING WAS RENDERED AS `<button disabled>`**, which announces
       itself to a screen reader as a control that cannot be used RIGHT NOW — a
       different and false claim about `PART ONE`, which is a label over the rows
       beneath it and will never be usable. The stylesheet knew: its comment said
       "it is not a control that has been switched off, it is a label". */
    render(<Contents toc={[item('PART ONE', null)]} currentHref="" onGoTo={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'PART ONE' })).toBeNull()
    expect(screen.getByText('PART ONE')).toBeDefined()
  })

  it('treats an empty href as no destination, not as one', () => {
    /* ⚠️ **THE TWO TESTS DISAGREED ABOUT `''`.** `disabled={href === null}` left
       the row ENABLED while `href && onGoTo(href)` is falsy for an empty string —
       so it looked like a destination, took a click, and did nothing.
       `string | null` does not exclude `''`. */
    const onGoTo = vi.fn()
    render(<Contents toc={[item('Ghost', '')]} currentHref="" onGoTo={onGoTo} />)
    expect(screen.queryByRole('button', { name: 'Ghost' })).toBeNull()
    expect(onGoTo).not.toHaveBeenCalled()
  })
})

describe('a row that does go somewhere', () => {
  it('is a button, and navigates', () => {
    const onGoTo = vi.fn()
    render(<Contents toc={[item('One', '/1.html')]} currentHref="" onGoTo={onGoTo} />)
    screen.getByRole('button', { name: 'One' }).click()
    expect(onGoTo).toHaveBeenCalledWith('/1.html')
  })

  it('tells assistive technology which entry the reader is in', () => {
    /* ⚠️ **`data-current` IS FOR THE STYLESHEET AND NOTHING CARRIED THE FACT
       FURTHER**, so the row a listener is IN was indistinguishable from every
       other row. `location` is ARIA's value for the current place in a set. */
    render(
      <Contents
        toc={[item('One', '/1.html'), item('Two', '/2.html')]}
        currentHref="/2.html"
        onGoTo={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Two' }).getAttribute('aria-current')).toBe('location')
    expect(screen.getByRole('button', { name: 'One' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks no row current when the reader is somewhere the contents does not name', () => {
    render(<Contents toc={[item('One', '/1.html')]} currentHref="/elsewhere" onGoTo={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'One' }).getAttribute('aria-current')).toBeNull()
  })

  it('is disabled when the pane was given no way to navigate', () => {
    /* The one case `:disabled` is still for — a switched-off control, which is
       what §07's treatment describes. */
    render(<Contents toc={[item('One', '/1.html')]} currentHref="" />)
    expect(screen.getByRole('button', { name: 'One' })).toHaveProperty('disabled', true)
  })
})

describe('the tree', () => {
  it('renders nested entries in reading order', () => {
    render(
      <Contents
        toc={[item('One', '/1.html', [item('One.a', '/1a.html')]), item('Two', '/2.html')]}
        currentHref=""
        onGoTo={vi.fn()}
      />,
    )
    const labels = screen.getAllByRole('button').map((b) => b.textContent)
    expect(labels).toEqual(['One', 'One.a', 'Two'])
  })
})
