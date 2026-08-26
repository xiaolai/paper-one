// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BottomSheet } from './BottomSheet'

/**
 * WHAT AN `aria-modal` DIALOG MAKES INERT, and what this wrapper did to that.
 *
 * `OverlaySheet` inerts its OWN siblings, which is right wherever it is
 * rendered straight into the layer holding the page — how the desktop mounts
 * it. `BottomSheet` wraps it in a full-viewport positioned host, because the
 * sheet positions against its parent and needs one. So the sheet's only
 * sibling became the scrim, which is deliberately excluded, and nothing behind
 * the dialog was ever made inert: it announced itself as modal while the shelf
 * underneath stayed tabbable and readable to a screen reader.
 *
 * A wrapper that exists for layout must not silently change what a modal
 * means. The boundary is stated now rather than inferred, and this is what
 * holds it.
 */

afterEach(cleanup)

/**
 * The page, and a sheet over it, as ONE tree.
 *
 * Both rendered together on purpose. Testing Library CLEARS the container it is
 * given, so a page appended beforehand is removed before the sheet mounts — and
 * "what is behind the sheet" is precisely a question about them being siblings.
 * `main.web.tsx` mounts both at the same level.
 */
function open(onDismiss = vi.fn()) {
  const view = render(
    <>
      <div data-page="">
        <button type="button">Behind the sheet</button>
      </div>
      <BottomSheet label="Tools" height={0.6} onDismiss={onDismiss}>
        <button type="button">Inside the sheet</button>
      </BottomSheet>
    </>,
  )
  const page = view.container.querySelector('[data-page]') as HTMLElement
  return { page, view }
}

describe('what is behind the sheet', () => {
  it('is inert while the sheet is open', () => {
    const { page } = open()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(page.inert, 'the page behind an aria-modal dialog was left interactive').toBe(true)
  })

  it('is interactive again once the sheet goes', () => {
    const { page, view } = open()
    expect(page.inert).toBe(true)
    view.unmount()
    expect(page.inert, 'the page must be given back when the sheet goes').toBeFalsy()
  })

  /**
   * THE SCRIM IS NOT INERTED, and it is a sibling of the sheet. Marking it
   * inert takes its `pointerdown` with it and click-outside-to-dismiss stops
   * working — a modal that can only be left with the keyboard.
   */
  it('leaves the scrim able to take a click', () => {
    open()
    const scrim = document.body.querySelector('[data-overlay-scrim]')
    expect(scrim, 'the sheet should still draw a scrim').not.toBeNull()
    /* `inert` is a plain property in jsdom, so an untouched element reads
       `undefined` — which is what "was never inerted" looks like here. */
    expect((scrim as HTMLElement | null)?.inert ?? false).toBeFalsy()
  })

  /* AND THE SHEET'S OWN CONTENT IS REACHABLE, so the assertions above are
     about the page rather than about everything having been switched off. */
  it('leaves its own content interactive', () => {
    open()
    const inside = screen.getByRole('button', { name: 'Inside the sheet' })
    expect(inside.closest('[inert]')).toBeNull()
  })
})
