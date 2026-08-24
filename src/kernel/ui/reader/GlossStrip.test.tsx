// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlossStrip } from './GlossStrip'

/** Plain DOM, not `@testing-library/jest-dom`. One matcher package is a
 *  dependency this repository does not carry, and these four lines are what it
 *  would have been used for. */
const textOf = (el: Element): string => el.textContent ?? ''
const isVisible = (el: HTMLElement): boolean => {
  if (el.hasAttribute('hidden')) return false
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  return style?.display !== 'none' && style?.visibility !== 'hidden'
}

/**
 * WI-16.3, asserted by RENDERING rather than by reading the source back.
 *
 * The earlier version of these cases scanned `Reader.tsx` and
 * `Reader.module.css` for the right class names, and an audit named exactly
 * what that misses: adding `hidden` to the failed element, or `display: none`
 * to its rule, leaves every source assertion green while the failure vanishes
 * from the screen. A test that cannot tell "drawn apart" from "not drawn" is
 * not testing the thing the section is about.
 *
 * So the strip is its own component now, and these mount it. Two CSS
 * assertions remain at the bottom, and they are supplemental: CSS Modules give
 * jsdom hashed class names and no stylesheet, so "is it amber" is still a
 * question only the stylesheet can answer.
 */

afterEach(cleanup)

describe('the gloss strip', () => {
  it('shows nothing at all when there is no lookup', () => {
    const { container } = render(<GlossStrip state={{ kind: 'idle' }} onDismiss={() => {}} />)

    expect(container.innerHTML).toBe('')
  })

  it('shows the term and the definition when one arrived', () => {
    render(
      <GlossStrip
        state={{ kind: 'ready', term: 'gam', text: 'A meeting of two whaling ships at sea.' }}
        onDismiss={() => {}}
      />,
    )

    const strip = screen.getByRole('status')
    expect(textOf(strip)).toContain('gam')
    expect(textOf(strip)).toContain('A meeting of two whaling ships at sea.')
    /* The amber box is what says "a machine wrote this", and `marks.ts`
       reserves the companion kind for it. */
    expect(strip.getAttribute('data-kind')).toBe('companion')
  })

  it('says it is looking, in the same place the answer will appear', () => {
    render(<GlossStrip state={{ kind: 'asking', term: 'gam' }} onDismiss={() => {}} />)

    const strip = screen.getByRole('status')
    expect(textOf(strip)).toContain('Looking…')
    /* Deliberately the SAME element as `ready`: "Looking…" cannot be mistaken
       for a definition, and moving it would make every lookup jump between two
       places on its way to an answer. */
    expect(strip.getAttribute('data-kind')).toBe('companion')
  })

  describe('and the lookup that did not arrive', () => {
    const failed = {
      kind: 'failed',
      term: 'gam',
      reason: 'The model is still starting.',
    } as const

    /*
     * The doctrine, as a rendering: `core/gloss.ts` says an apology must never
     * be resolved as a definition "because an apology rendered in amber reads
     * as a definition". The port throws to honour it; the view used to undo it
     * by putting all three states through one amber element.
     */
    it('is drawn apart from a definition, and is not the companion box', () => {
      render(<GlossStrip state={failed} onDismiss={() => {}} />)

      const strip = screen.getByRole('status')
      expect(strip.getAttribute('data-kind')).not.toBe('companion')
    })

    /* The audit's own mutation: an element that is present in the DOM and
     * invisible passes every source scan and shows the reader nothing. */
    it('is actually visible', () => {
      render(<GlossStrip state={failed} onDismiss={() => {}} />)

      expect(isVisible(screen.getByRole('status'))).toBe(true)
    })

    it('says the app could not, in words, and names the term', () => {
      render(<GlossStrip state={failed} onDismiss={() => {}} />)

      /* A bare clause — "the model is still starting" — sitting where a
         definition goes still scans as one. The word is what says otherwise. */
      expect(textOf(screen.getByRole('status'))).toMatch(/couldn.t define/i)
      expect(textOf(screen.getByRole('status'))).toContain('gam')
    })

    it('still says what went wrong, rather than swallowing it', () => {
      render(<GlossStrip state={failed} onDismiss={() => {}} />)

      expect(textOf(screen.getByRole('status'))).toContain('The model is still starting.')
    })

    /* Non-vacuity for the pair above: the ready state and the failed state must
     * not render into the same element, or "drawn apart" means nothing. */
    it('renders into a different element from the one a definition uses', () => {
      const { container: ok } = render(
        <GlossStrip state={{ kind: 'ready', term: 'gam', text: 'A meeting.' }} onDismiss={() => {}} />,
      )
      const readyClass = ok.firstElementChild?.className
      cleanup()
      const { container: bad } = render(<GlossStrip state={failed} onDismiss={() => {}} />)

      expect(readyClass).toBeTruthy()
      expect(bad.firstElementChild?.className).not.toBe(readyClass)
    })
  })

  /* Both states carry the same control, from one definition — written twice,
   * its label or glyph would drift apart for no reason anyone could name. */
  it.each([
    ['ready', { kind: 'ready', term: 'gam', text: 'A meeting.' } as const],
    ['asking', { kind: 'asking', term: 'gam' } as const],
    ['failed', { kind: 'failed', term: 'gam', reason: 'No model.' } as const],
  ])('is dismissed from the %s state by one control', (_name, state) => {
    const onDismiss = vi.fn()
    render(<GlossStrip state={state} onDismiss={onDismiss} />)

    screen.getByRole('button', { name: 'Dismiss' }).click()

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
