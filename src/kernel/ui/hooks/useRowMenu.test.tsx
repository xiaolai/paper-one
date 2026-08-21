// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRowMenu } from './useRowMenu'

/**
 * The keyboard model behind `role="menu"`.
 *
 * `role="menu"` is a promise to a reader who cannot see the popup: there are
 * items, arrows walk them, Home and End jump, and Escape gives the trigger
 * back. The hook's item query asked for `[role="menuitem"]` and nothing else,
 * so a menu whose rows report a state — radios for one-of, checkboxes for
 * many-of, which is what a FILTER menu is made of — had an item list of length
 * zero. Every branch below it returned early. The promise was declared and
 * nothing kept it, which is worse than not declaring it: a screen reader
 * announces a menu, and the keys that are supposed to work do nothing.
 *
 * These are about the QUERY, which is the part that silently matched nothing.
 */

afterEach(cleanup)

/* jsdom HAS NO ResizeObserver, and `usePlacement` — which the hook builds on —
   observes the surface to keep a menu on screen. A no-op stands in: placement
   is not what these assert, and without it the hook throws on mount. */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

function Menu({ role, open = true, onClose = () => {} }: { role: string; open?: boolean; onClose?: () => void }) {
  const anchor = useRef<HTMLDivElement | null>(null)
  const { moreRef, menuRef } = useRowMenu(open, anchor, onClose, { menu: true })
  return (
    <div ref={anchor}>
      <button type="button" ref={moreRef}>
        open
      </button>
      {open && (
      <div ref={menuRef} role="menu">
        {['one', 'two', 'three'].map((label) => (
          <button key={label} type="button" role={role}>
            {label}
          </button>
        ))}
        <input type="search" data-menu-item="" aria-label="Filter" />
      </div>
      )}
    </div>
  )
}

const press = (key: string) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

describe('useRowMenu’s keyboard walk', () => {
  /* All three ARIA menu-item roles, because a filter menu is built from the two
     that were missing and there is no reason for the query to know them apart. */
  for (const role of ['menuitem', 'menuitemradio', 'menuitemcheckbox']) {
    it(`walks rows whose role is ${role}`, () => {
      render(<Menu role={role} />)
      press('ArrowDown')
      expect(document.activeElement?.textContent).toBe('one')
      press('ArrowDown')
      expect(document.activeElement?.textContent).toBe('two')
      press('End')
      /* PAST THE ROWS to the opted-in field, which is the last item — a menu's
         own filter cannot wear a menu role without ceasing to be announced as
         a search box, so it opts in by attribute instead. */
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter')
    })
  }

  /* FOCUS GOES BACK TO THE TRIGGER when the menu closes with focus inside it.
     For a keyboard reader that is the whole difference between closing a menu
     and being dropped at the top of the window to start over.
     The check that guards it used to run against `menuRef.current` — read in a
     PASSIVE cleanup, which React runs after it has already detached the ref of
     the unmounted menu. So the containment test was asked of null every time
     and the restore never happened, for any of the four menus that ask for
     this behaviour. The menu below unmounts on close, exactly as they do. */
  it('gives focus back to the trigger when the menu closes under it', () => {
    const { rerender } = render(<Menu role="menuitemcheckbox" />)
    press('ArrowDown')
    expect(document.activeElement?.textContent).toBe('one')

    rerender(<Menu role="menuitemcheckbox" open={false} />)
    /* The trigger ITSELF, by identity. `textContent` would also read 'open' off
       `document.body` — jsdom's fallback when the focused node is removed — so
       the loose assertion passes whether or not anything was restored. */
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'open' }))
  })

  /* AND NOT WHEN THE READER PUT IT SOMEWHERE ELSE. A pointer user who clicked
     away has already chosen where focus belongs; dragging it back to the
     trigger would take it off what they just clicked. */
  it('leaves focus alone when it had already moved outside the menu', () => {
    const outside = document.createElement('button')
    outside.textContent = 'elsewhere'
    document.body.append(outside)
    const { rerender } = render(<Menu role="menuitemcheckbox" />)
    press('ArrowDown')
    outside.focus()

    rerender(<Menu role="menuitemcheckbox" open={false} />)
    expect(document.activeElement?.textContent).toBe('elsewhere')
    outside.remove()
  })

  it('leaves Home and End to the caret while the reader is typing in the filter', () => {
    render(<Menu role="menuitemcheckbox" />)
    screen.getByLabelText('Filter').focus()
    const prevented = vi.fn()
    const event = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })
    event.preventDefault = prevented
    document.dispatchEvent(event)

    expect(prevented).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter')
  })
})
