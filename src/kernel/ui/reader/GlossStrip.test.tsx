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


  /*
   * ── NOTHING INSTALLED TO ANSWER WITH ──────────────────────────────────
   *
   * The state that only exists because the Dictionary.app hand-off was
   * deleted. Before that, a macOS reader with no model pressed Look up and got
   * the system dictionary; now they get this, and phase 17's decision is that
   * they must get SOMETHING — "the control simply disappearing on macOS leaves
   * a reader who used it yesterday with no explanation and no discoverable
   * route back."
   */
  describe('and the lookup with nothing to answer it', () => {
    const absent = { kind: 'unavailable', term: 'gam', installable: true } as const

    /* Same doctrine as the failure, and it matters more here: this text is
       about Paper, not about the word, so amber would be the app labelling its
       own apology as a definition of "gam". */
    it('is not the companion box, because it is not a definition', () => {
      render(<GlossStrip state={absent} onDismiss={() => {}} onInstall={() => {}} />)

      expect(screen.getByRole('status').getAttribute('data-kind')).not.toBe('companion')
    })

    it('is actually visible', () => {
      render(<GlossStrip state={absent} onDismiss={() => {}} onInstall={() => {}} />)

      expect(isVisible(screen.getByRole('status'))).toBe(true)
    })

    /* SAYS WHY, and does not say "couldn't". Nothing failed — there is a
       download between the reader and the feature, which is a different
       sentence and a different feeling. */
    it('names what is missing rather than reporting a failure', () => {
      render(<GlossStrip state={absent} onDismiss={() => {}} onInstall={() => {}} />)

      const strip = screen.getByRole('status')
      expect(textOf(strip)).toMatch(/language model/i)
      expect(textOf(strip)).toContain('gam')
      expect(textOf(strip)).not.toMatch(/couldn.t define/i)
    })

    /* THE WHOLE JUSTIFICATION FOR DRAWING THE BUTTON AT ALL. §07 forbids a
       control that cannot act; this state is allowed to exist only because the
       one it offers does. A strip that reported the absence and offered no way
       out would be the dead button in a longer form. */
    it('offers the way out, and it works', () => {
      const onInstall = vi.fn()
      render(<GlossStrip state={absent} onDismiss={() => {}} onInstall={onInstall} />)

      screen.getByRole('button', { name: /install/i }).click()

      expect(onInstall).toHaveBeenCalledTimes(1)
    })

    /*
     * AND IT OFFERS NOTHING WHERE THERE IS NOWHERE TO GO. The sentence still
     * renders — saying "Paper needs a language model" on a browser client is
     * TRUE; offering to install one there would not be.
     *
     * ⚠️ **THIS COMMENT USED TO CALL THE CASE UNREACHABLE IN THE APP**, on the
     * grounds that `decideLookUp` answers `none` without an install route so
     * the state is never entered. It is reachable: `decideLookUp` reads the
     * provider when the button is DRAWN and `useGloss.ask` reads it when the
     * button is PRESSED, and a model uninstalled in between arrives here from a
     * button drawn as `gloss`. Hence the second case below, which is that
     * window and is the one that used to offer a 2.5 GB download into a runtime
     * that is not there (WI-20.21).
     */
    it('offers no install where the caller gave no way to install', () => {
      render(<GlossStrip state={absent} onDismiss={() => {}} />)

      expect(textOf(screen.getByRole('status'))).toMatch(/language model/i)
      expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
    })

    /* THE OTHER HALF, and the one that is not about the caller at all: this
       screen HAS somewhere to send the reader, and the build has nothing to
       install into. Both have to be true before an offer is honest. */
    it('offers no install where the build has nothing to install into', () => {
      render(
        <GlossStrip state={{ ...absent, installable: false }} onDismiss={() => {}} onInstall={() => {}} />,
      )

      expect(textOf(screen.getByRole('status'))).toMatch(/language model/i)
      expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
    })

    /* Non-vacuity, as for the failure: this must not be the element a
       definition renders into. */
    it('renders into a different element from the one a definition uses', () => {
      const { container: ok } = render(
        <GlossStrip state={{ kind: 'ready', term: 'gam', text: 'A meeting.' }} onDismiss={() => {}} />,
      )
      const readyClass = ok.firstElementChild?.className
      cleanup()
      const { container: none } = render(<GlossStrip state={absent} onDismiss={() => {}} />)

      expect(readyClass).toBeTruthy()
      expect(none.firstElementChild?.className).not.toBe(readyClass)
    })
  })

  /**
   * A PASSAGE RATHER THAN A TERM.
   *
   * ⚠️ **THE STATE THIS DESCRIBES USED TO BE NOTHING AT ALL.** `lookUpPress`
   * held the term bound and `return`ed on it, so a reader who selected more
   * than 120 code points and pressed Look up got no definition, no message and
   * no diagnostic — a live button that did nothing, which is exactly what the
   * deleted `lookUpTauri.ts` warned about and what `unavailable` above was
   * added to remove for the other half of the same question.
   */
  describe('and the lookup that was never sent', () => {
    const long = { kind: 'tooLong' } as const

    it('is actually visible', () => {
      render(<GlossStrip state={long} onDismiss={() => {}} />)

      expect(isVisible(screen.getByRole('status'))).toBe(true)
    })

    /* NOT amber, for `.glossFailed`'s reason: this is Paper speaking about
       itself, and nothing here is a definition of anything. */
    it('is not the companion box, because it is not a definition', () => {
      render(<GlossStrip state={long} onDismiss={() => {}} />)

      expect(screen.getByRole('status').getAttribute('data-kind')).not.toBe('companion')
    })

    /* SAYS WHAT TO DO. Nothing failed and no model is missing, so it must
       borrow neither of the other two sentences. */
    it('says what was wrong with the gesture and what to do instead', () => {
      render(<GlossStrip state={long} onDismiss={() => {}} />)

      const strip = screen.getByRole('status')
      expect(textOf(strip)).toMatch(/too long/i)
      expect(textOf(strip)).toMatch(/word or a short phrase/i)
      expect(textOf(strip)).not.toMatch(/couldn.t define/i)
      expect(textOf(strip)).not.toMatch(/language model/i)
    })

    /* IT NAMES NO TERM, and that is the point rather than an omission: the
       term here is a paragraph, and neither `.glossFailedSaid` nor
       `.glossAbsentSaid` ellipsizes. There is nowhere for it to go. */
    it('does not quote the passage back', () => {
      render(<GlossStrip state={long} onDismiss={() => {}} />)

      expect(textOf(screen.getByRole('status')).length).toBeLessThan(120)
    })

    /* NO INSTALL OFFER. Nothing about this is fixed by downloading a model,
       and the state carries no `installable` for a caller to misread. */
    it('offers no install, whatever the caller passes', () => {
      render(<GlossStrip state={long} onDismiss={() => {}} onInstall={() => {}} />)

      expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
    })
  })

  /* All five states carry the same control, from one definition — written
   * five times, its label or glyph would drift apart for no reason anyone
   * could name. */
  it.each([
    ['ready', { kind: 'ready', term: 'gam', text: 'A meeting.' } as const],
    ['asking', { kind: 'asking', term: 'gam' } as const],
    ['failed', { kind: 'failed', term: 'gam', reason: 'No model.' } as const],
    ['unavailable', { kind: 'unavailable', term: 'gam', installable: true } as const],
    ['tooLong', { kind: 'tooLong' } as const],
  ])('is dismissed from the %s state by one control', (_name, state) => {
    const onDismiss = vi.fn()
    render(<GlossStrip state={state} onDismiss={onDismiss} />)

    screen.getByRole('button', { name: 'Dismiss' }).click()

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
