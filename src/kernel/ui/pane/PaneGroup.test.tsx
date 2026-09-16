// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneGroup } from './PaneGroup'

/**
 * THE ACCORDION, ON ITS OWN.
 *
 * It was measured only through `Settings`, whose tests render it dozens of
 * times and assert what the groups HOLD — so what the heading itself says was
 * held by nothing: a count that vanished from a closed group, or a hint that
 * never reached its tooltip, left every one of those tests green. These assert
 * the heading and the body, and nothing a panel puts in them.
 */

afterEach(cleanup)

/** One group, with only what an assertion cares about varied. */
function group(over: { open?: boolean; count?: number; hint?: string; tool?: boolean; group?: string } = {}) {
  const onToggle = vi.fn()
  const { container } = render(
    <PaneGroup
      title="Light"
      open={over.open ?? true}
      onToggle={onToggle}
      {...(over.count === undefined ? {} : { count: over.count })}
      {...(over.hint === undefined ? {} : { hint: over.hint })}
      {...(over.group === undefined ? {} : { group: over.group })}
      {...(over.tool ? { tool: <button type="button">Sort</button> } : {})}
    >
      <p>a row inside</p>
    </PaneGroup>,
  )
  const heading = screen.getByRole('heading', { level: 4 })
  return { onToggle, container, heading, toggle: within(heading).getByRole('button') }
}

describe('a pane group', () => {
  /* THE HEADING IS THE CONTROL, and a screen reader finds it by heading
     navigation — a button in a `div` was one it could press and never reach. */
  it('is a level-four heading whose button opens and closes the body it names', () => {
    const { toggle, onToggle, container } = group()
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const body = container.querySelector(`[id="${toggle.getAttribute('aria-controls') ?? ''}"]`)
    expect(body, 'aria-controls names nothing').not.toBeNull()
    expect(body!.textContent).toBe('a row inside')

    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  /* CLOSED, THE BODY STAYS AND ITS ROWS GO — `aria-controls` keeps pointing at
     something (#136), and a contributed row does no work nobody can see. */
  it('keeps a closed body, hidden and empty, and draws the rows only when open', () => {
    const { toggle, container } = group({ open: false })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const body = container.querySelector<HTMLElement>(`[id="${toggle.getAttribute('aria-controls') ?? ''}"]`)
    expect(body, 'a closed group dropped the element aria-controls names').not.toBeNull()
    expect(body!.hidden).toBe(true)
    expect(screen.queryByText('a row inside')).toBeNull()
    cleanup()

    const opened = group({ open: true })
    const shown = opened.container.querySelector<HTMLElement>(
      `[id="${opened.toggle.getAttribute('aria-controls') ?? ''}"]`,
    )
    expect(shown!.hidden).toBe(false)
    expect(screen.getByText('a row inside')).toBeTruthy()
  })

  /* SO A CLOSED GROUP STILL SAYS WHETHER IT IS WORTH OPENING — nothing
     included, which is an answer, and a group that is named rather than
     counted draws no number at all. */
  it('says how much it holds on the heading, zero included, and nothing when it is not counted', () => {
    const { toggle } = group({ open: false, count: 0 })
    expect(toggle.textContent).toBe('Light0')
    expect(toggle.querySelector('span')?.textContent).toBe('0')
    cleanup()

    const counted = group({ count: 12 })
    expect(counted.toggle.querySelector('span')?.textContent).toBe('12')
    cleanup()

    const named = group()
    expect(named.toggle.textContent).toBe('Light')
    expect(named.toggle.querySelector('span'), 'an uncounted group drew an empty count').toBeNull()
  })

  it('carries its hint as the heading’s tooltip, and no tooltip without one', () => {
    expect(group({ hint: 'How the page is lit' }).toggle.getAttribute('title')).toBe('How the page is lit')
    cleanup()
    expect(group().toggle.hasAttribute('title')).toBe(false)
  })

  /* BESIDE THE HEADING, because a button may not hold a button — and so the
     heading is named for the group, not for its sort control too. */
  it('draws its tool beside the heading, not inside it', () => {
    const { heading } = group({ tool: true })
    const sort = screen.getByRole('button', { name: 'Sort' })
    expect(heading.contains(sort)).toBe(false)
    expect(heading.parentElement!.contains(sort)).toBe(true)
    expect(heading.textContent).toBe('Light')
  })

  /* So a panel can scroll a requested group into view (phase 17, L3). */
  it('names itself in its panel when it is given a name', () => {
    const { heading } = group({ group: 'models' })
    expect(heading.parentElement!.getAttribute('data-group')).toBe('models')
  })
})
