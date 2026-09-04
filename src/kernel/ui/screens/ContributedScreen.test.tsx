// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContributedScreen } from './ContributedScreen'

/**
 * The frame the kernel draws around a capability's whole-window view.
 *
 * ⚠️ **THIS FILE EXISTS BECAUSE THE FIRST VERSION SHIPPED WITHOUT A FRAME.**
 * A contributed screen was rendered as a bare fragment into normal flow: the
 * content landed at the bottom of the window as unstyled text, the reader
 * stayed live behind it, and an empty pane sat beside it. Every test here
 * pins one of the three things that were wrong.
 */

afterEach(cleanup)

describe('the frame around a contributed screen', () => {
  it('covers the window rather than sitting in the flow', () => {
    /* Both of the kernel's own screens are `position: absolute; inset: 0` with
       a background and a z-index. A screen that is not is not a screen — it is
       loose text over whatever was already there. */
    const { container } = render(
      <ContributedScreen label="Circle" platform="macos" id="cap:one" render={() => <p>content</p>} />,
    )
    const root = container.firstElementChild as HTMLElement

    /* CSS Modules hash class names, so the assertion is that the root HAS its
       own class rather than what the class is called — the styling itself is
       `css:tokens`' and `css:check`'s business. */
    expect(root.className).not.toBe('')
    expect(root.getAttribute('data-platform')).toBe('macos')
  })

  it('carries the platform, because macOS insets the top for the traffic lights', () => {
    /* A capability cannot read `--titlebar-h` — it may reach the kernel only
       through the public entry — so it cannot inset itself. */
    const { container } = render(
      <ContributedScreen label="Circle" platform="windows" id="cap:one" render={() => <p>content</p>} />,
    )
    expect((container.firstElementChild as HTMLElement).getAttribute('data-platform')).toBe(
      'windows',
    )
  })

  it('titles the page with the label, so a capability cannot forget one', () => {
    /* And cannot title its page something other than the name on the control
       that got the reader here. */
    render(
      <ContributedScreen label="Circle" platform="macos" id="cap:one" render={() => <p>content</p>} />,
    )
    expect(screen.getByRole('heading', { name: 'Circle' })).toBeTruthy()
  })

  it('draws what the capability gave it', () => {
    render(
      <ContributedScreen label="Circle" platform="macos" id="cap:one" render={() => <p>the capability&rsquo;s own content</p>} />,
    )
    screen.getByText(/the capability’s own content/u)
  })
})

describe('a contributed screen that throws', () => {
  it('does not take the window with it', () => {
    /* ⚠️ **A CAPABILITY'S RENDERER RUNS INSIDE THE KERNEL'S TREE.** One that
       throws is an uncaught error during root render, and React's answer to
       that is to unmount EVERYTHING — the titlebar, the library, and the
       control that would take the reader back out. For a fault in a panel they
       were merely looking at. */
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <ContributedScreen
          label="Circle"
          platform="macos"
          id="cap:one"
          render={() => {
            throw new Error('the port went away')
          }}
        />,
      )

      /* The heading survives, so the reader can still see where they are. */
      expect(screen.getByRole('heading', { name: 'Circle' })).toBeTruthy()
      screen.getByText(/could not be drawn/u)
    } finally {
      warn.mockRestore()
    }
  })

  it('reports the failure rather than swallowing it', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <ContributedScreen
          label="Circle"
          platform="macos"
          id="cap:one"
          render={() => {
            throw new Error('the port went away')
          }}
        />,
      )
      expect(reported).toHaveBeenCalled()
    } finally {
      reported.mockRestore()
    }
  })

  it('says so plainly when no composition offers the screen', () => {
    /* A screen id in state that nothing provides — a capability removed between
       launches. Drawing nothing would be a blank window with no way out. */
    render(<ContributedScreen label="Not here" platform="macos" id="gone:one" />)

    screen.getByText(/not running/u)
  })
})

describe('the context a contributed screen is handed', () => {
  it('names no book, and carries the way to open one only when the shell gave it', () => {
    const shown = (context: { bookId: string | null; openBook?: unknown }) => (
      <p>
        {String(context.bookId)}:{typeof context.openBook}
      </p>
    )
    const open = () => {}
    const { unmount } = render(<ContributedScreen label="Circle" platform="macos" id="cap:one" render={shown} openBook={open} />)
    expect(screen.getByText('null:function')).toBeTruthy()
    unmount()
    render(<ContributedScreen label="Circle" platform="macos" id="cap:one" render={shown} />)
    expect(screen.getByText('null:undefined')).toBeTruthy()
  })
})
