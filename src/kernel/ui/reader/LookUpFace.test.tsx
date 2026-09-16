// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlossState } from '../hooks/useGloss'
import { LookUpFace } from './LookUpFace'
import { POPUP_H, shownFace, surfaceHeight } from './SelectionTools'

/** Plain DOM, not `@testing-library/jest-dom` — a matcher package this
 *  repository does not carry. */
const textOf = (el: Element): string => el.textContent ?? ''
const isVisible = (el: HTMLElement): boolean => {
  if (el.hasAttribute('hidden')) return false
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  return style?.display !== 'none' && style?.visibility !== 'hidden'
}

/**
 * The lookup face (phase 17, L1) — asserted by RENDERING, as the strip it
 * replaced was (WI-16.3), because the difference between the states is the
 * whole point and a source scan cannot tell "drawn apart" from "not drawn".
 *
 * The CSS half — is the definition amber, is the failure hidden by its own
 * rule — is the one question a render cannot answer in jsdom, and lives in
 * `screens/Reader.layout.test.ts` beside the stylesheet assertions it joined.
 */

afterEach(cleanup)

const draw = (state: Exclude<GlossState, { kind: 'idle' }>, over: { onBack?: () => void; onInstall?: (section: string) => void } = {}) =>
  render(<LookUpFace state={state} onBack={over.onBack ?? (() => {})} {...(over.onInstall ? { onInstall: over.onInstall } : {})} />)

describe('the lookup face', () => {
  it('shows the term and the definition when one arrived', () => {
    draw({ kind: 'ready', term: 'gam', text: 'A meeting of two whaling ships at sea.' })

    const said = screen.getByRole('status')
    expect(textOf(said)).toContain('gam')
    expect(textOf(said)).toContain('A meeting of two whaling ships at sea.')
    /* The amber box is what says "a machine wrote this". */
    expect(said.getAttribute('data-kind')).toBe('companion')
  })

  it('says it is looking, in the same element the answer will appear in', () => {
    draw({ kind: 'asking', term: 'gam' })

    const said = screen.getByRole('status')
    expect(textOf(said)).toContain('Looking…')
    expect(said.getAttribute('data-kind')).toBe('companion')
  })

  /* WI-17.5's `both`: the model's own line break separates the two languages,
     and the face must not flatten it into one run. */
  it('keeps the two lines of an answer given in two languages', () => {
    draw({ kind: 'ready', term: 'wharves', text: 'Structures where ships dock.\n码头。' })

    expect(textOf(screen.getByRole('status'))).toContain('Structures where ships dock.\n码头。')
  })

  describe('and the lookup that did not arrive', () => {
    const failed = { kind: 'failed', term: 'gam', reason: 'The model is still starting.' } as const

    /* The doctrine, as a rendering: an apology rendered in amber reads as a
       definition. */
    it('is drawn apart from a definition, and is not the companion box', () => {
      draw(failed)

      expect(screen.getByRole('status').getAttribute('data-kind')).not.toBe('companion')
    })

    it('is actually visible', () => {
      draw(failed)

      expect(isVisible(screen.getByRole('status'))).toBe(true)
    })

    it('says the app could not, in words, and names the term', () => {
      draw(failed)

      expect(textOf(screen.getByRole('status'))).toMatch(/couldn.t define/i)
      expect(textOf(screen.getByRole('status'))).toContain('gam')
    })

    it('still says what went wrong, rather than swallowing it', () => {
      draw(failed)

      expect(textOf(screen.getByRole('status'))).toContain('The model is still starting.')
    })

    it('renders into a different element from the one a definition uses', () => {
      const { container: ok } = draw({ kind: 'ready', term: 'gam', text: 'A meeting.' })
      const readyClass = ok.querySelector('[role="status"]')?.className
      cleanup()
      const { container: bad } = draw(failed)

      expect(readyClass).toBeTruthy()
      expect(bad.querySelector('[role="status"]')?.className).not.toBe(readyClass)
    })
  })

  /*
   * NOTHING INSTALLED TO ANSWER WITH — the state that exists because the
   * Dictionary.app hand-off was deleted, and phase 17's decision that a macOS
   * reader must get SOMETHING rather than a control that disappeared.
   */
  describe('and the lookup with nothing to answer it', () => {
    const absent = { kind: 'unavailable', term: 'gam', installAt: 'inference:models' } as const

    it('is not the companion box, because it is not a definition', () => {
      draw(absent, { onInstall: () => {} })

      expect(screen.getByRole('status').getAttribute('data-kind')).not.toBe('companion')
    })

    it('is actually visible', () => {
      draw(absent, { onInstall: () => {} })

      expect(isVisible(screen.getByRole('status'))).toBe(true)
    })

    it('names what is missing rather than reporting a failure', () => {
      draw(absent, { onInstall: () => {} })

      const said = screen.getByRole('status')
      expect(textOf(said)).toMatch(/language model/i)
      expect(textOf(said)).toContain('gam')
      expect(textOf(said)).not.toMatch(/couldn.t define/i)
    })

    /* L3: it goes to the SECTION the provider named, not to the top of a pane
       with that section collapsed under another band. */
    it('offers the way out, and it goes to the section the provider named', () => {
      const onInstall = vi.fn()
      draw(absent, { onInstall })

      screen.getByRole('button', { name: /install/i }).click()

      expect(onInstall).toHaveBeenCalledTimes(1)
      expect(onInstall).toHaveBeenCalledWith('inference:models')
    })

    it('offers no install where the caller gave no way to install', () => {
      draw(absent)

      expect(textOf(screen.getByRole('status'))).toMatch(/language model/i)
      expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
    })

    /* THE OTHER HALF: this screen has somewhere to send the reader, and the
       build has nothing to install into (WI-20.21). */
    it('offers no install where the build has nothing to install into', () => {
      draw({ ...absent, installAt: null }, { onInstall: () => {} })

      expect(textOf(screen.getByRole('status'))).toMatch(/language model/i)
      expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
    })

    it('renders into a different element from the one a definition uses', () => {
      const { container: ok } = draw({ kind: 'ready', term: 'gam', text: 'A meeting.' })
      const readyClass = ok.querySelector('[role="status"]')?.className
      cleanup()
      const { container: none } = draw(absent)

      expect(readyClass).toBeTruthy()
      expect(none.querySelector('[role="status"]')?.className).not.toBe(readyClass)
    })
  })

  describe('and the lookup that was never sent', () => {
    const long = { kind: 'tooLong' } as const

    it('is actually visible', () => {
      draw(long)

      expect(isVisible(screen.getByRole('status'))).toBe(true)
    })

    it('is not the companion box, because it is not a definition', () => {
      draw(long)

      expect(screen.getByRole('status').getAttribute('data-kind')).not.toBe('companion')
    })

    it('says what was wrong with the gesture and what to do instead', () => {
      draw(long)

      const said = screen.getByRole('status')
      expect(textOf(said)).toMatch(/too long/i)
      expect(textOf(said)).toMatch(/word or a short phrase/i)
      expect(textOf(said)).not.toMatch(/couldn.t define/i)
      expect(textOf(said)).not.toMatch(/language model/i)
    })

    it('does not quote the passage back', () => {
      draw(long)

      expect(textOf(screen.getByRole('status')).length).toBeLessThan(120)
    })

    it('offers no install, whatever the caller passes', () => {
      draw(long, { onInstall: () => {} })

      expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
    })
  })

  /* Every state carries the same way back, from one definition. */
  it.each([
    ['ready', { kind: 'ready', term: 'gam', text: 'A meeting.' } as const],
    ['asking', { kind: 'asking', term: 'gam' } as const],
    ['failed', { kind: 'failed', term: 'gam', reason: 'No model.' } as const],
    ['unavailable', { kind: 'unavailable', term: 'gam', installAt: 'inference:models' } as const],
    ['tooLong', { kind: 'tooLong' } as const],
  ])('goes back to the bar from the %s state by one control', (_name, state) => {
    const onBack = vi.fn()
    draw(state, { onBack })

    screen.getByRole('button', { name: 'Back to the selection tools' }).click()

    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

/**
 * Which face the popup shows, and how tall it is placed as — the two decisions
 * `SelectionTools` makes about a lookup, out of the component so they can be
 * RUN: the popup needs laid-out ranges in a book's iframe to render at all,
 * which jsdom does not have.
 */
describe('which face the popup shows', () => {
  it.each(['bar', 'marks', 'copy'] as const)('shows the lookup over the %s face while one is on', (face) => {
    expect(shownFace(face, { kind: 'asking', term: 'gam' })).toBe('lookup')
    expect(shownFace(face, { kind: 'tooLong' })).toBe('lookup')
  })

  it('shows the face the reader chose while nothing is being looked up', () => {
    expect(shownFace('marks', { kind: 'idle' })).toBe('marks')
  })
})

/*
 * ⚠️ THE PLACEMENT MUST BE TOLD THE LOOKUP'S REAL HEIGHT. `place` puts the popup
 * ABOVE the selection by subtracting the surface's height from the line's top,
 * so a lookup two hundred pixels tall placed as a forty-pixel bar would hang
 * down over the very words it defines.
 */
describe('how tall the popup is placed as', () => {
  it('places a lookup at the height it measured', () => {
    expect(surfaceHeight('lookup', 132)).toBe(132)
  })

  it('places every other face at the bar’s own height, which it is', () => {
    expect(surfaceHeight('bar', 132)).toBe(POPUP_H)
    expect(surfaceHeight('marks', 90)).toBe(POPUP_H)
  })

  it('places a lookup not yet measured at the bar’s height, not at nothing', () => {
    expect(surfaceHeight('lookup', 0)).toBe(POPUP_H)
  })
})
