import { describe, expect, it, vi } from 'vitest'
import { decideLookUp, isLookUpTerm, lookUpPress } from './lookUp'

/**
 * ⚠️ **THIS FILE USED TO PIN A NO-REGRESSION RULE THAT NO LONGER APPLIES.**
 *
 * WI-15.13's acceptance was *"with no model installed, `Look up` invokes
 * `look_up` exactly as it does today and Windows still shows no control"*, and
 * thirteen cases held `decideLookUp` to a three-mode routing over
 * `hasDictionary`, the gloss and a stored preference. The system-dictionary
 * hand-off is deleted, so the rule it protected is deliberately broken: a
 * macOS reader with no model no longer gets Dictionary.app.
 *
 * That is a REAL loss and it is not silent — it is the whole subject of the
 * `install` action below, which is what a reader gets instead of the feature
 * quietly disappearing. macOS's own Look Up is still on the right-click menu.
 */
describe('decideLookUp', () => {
  it('glosses when there is a model to gloss with', () => {
    expect(decideLookUp(true, true)).toBe('gloss')
  })

  /* THE GLOSS WINS OVER THE INSTALL PROMPT, which cannot happen in the app —
   * an available provider is by definition not one the reader needs to install
   * anything for — but is written down because the ordering is the reason this
   * is a function and not two nested ternaries at the call site. */
  it('glosses even where an install is on offer, never the other way round', () => {
    expect(decideLookUp(true, false)).toBe('gloss')
  })

  /*
   * ── THE DECISION THIS PHASE TURNS ON ──────────────────────────────────
   *
   * §07's rule is that a control which cannot act is the app describing a
   * feature it does not have, and this codebase applies it hard enough that
   * Windows and Linux showed NO Look up button for the whole life of the
   * feature. The rule is about controls that cannot act. A control that starts
   * a model install can act, so it stays.
   *
   * The alternative — the button simply vanishing on macOS the day the
   * hand-off was deleted — leaves a reader who used it yesterday with no
   * explanation and no discoverable route back.
   */
  it('offers the install where a model could be had but has not been', () => {
    expect(decideLookUp(false, true)).toBe('install')
  })

  /*
   * And the half that keeps the §07 rule honest. A browser client, iOS and
   * Android compose no `inference`, so the port keeps its `NO_GLOSS` default
   * and there is no models pane to send anyone to. Offering an install there
   * would be exactly the failure the rule exists to prevent — worse than the
   * dead button, because it names a route that does not exist.
   */
  it('draws nothing where there is neither a model nor a way to get one', () => {
    expect(decideLookUp(false, false)).toBe('none')
  })

  /* Two inputs, four combinations, and every one of them is above. Asserted
     as a count so a third input added later cannot slip in with its own cases
     untested — the previous version of this file had three inputs and eight of
     its twelve combinations were never written down. */
  it('has no fifth answer', () => {
    const seen = new Set(
      [true, false].flatMap((gloss) => [true, false].map((install) => decideLookUp(gloss, install))),
    )
    expect(seen).toEqual(new Set(['gloss', 'install', 'none']))
  })
})

describe('isLookUpTerm', () => {
  it('accepts a headword and a short phrase', () => {
    expect(isLookUpTerm('counsel')).toBe(true)
    expect(isLookUpTerm('kept his own counsel')).toBe(true)
  })

  it('refuses an empty or whitespace-only selection', () => {
    expect(isLookUpTerm('')).toBe(false)
    expect(isLookUpTerm('   \n ')).toBe(false)
  })

  /* Past 120 characters the reader has plainly not asked for a definition of a
   * word — they can select a whole chapter. It used to be the point past which
   * a `dict://` lookup found nothing; the reason changed and the number did
   * not. */
  it('refuses a selection past the point the feature could work', () => {
    expect(isLookUpTerm('a'.repeat(120))).toBe(true)
    expect(isLookUpTerm('a'.repeat(121))).toBe(false)
  })

  it('measures the collapsed length, so line breaks do not disqualify a phrase', () => {
    expect(isLookUpTerm(`kept his\n\n   own counsel`)).toBe(true)
  })

  /* COUNTED IN CODE POINTS. `String.length` is UTF-16 units, so an astral
   * character counts twice and a selection of 120 of them would be refused as
   * 240. There is no longer a Rust half to disagree with, but the bound is on a
   * TERM and a term of CJK extension characters is a term. */
  it('counts code points, not UTF-16 units', () => {
    expect(isLookUpTerm('𠮷'.repeat(120))).toBe(true)
    expect(isLookUpTerm('𠮷'.repeat(121))).toBe(false)
  })
})

/**
 * THE WIRING, RUN RATHER THAN READ.
 *
 * These three decisions lived inside `Reader.tsx`, which takes sixteen props
 * and renders foliate — so the only assertion anybody could write was
 * `useGloss.test.ts` scanning the file for a call. A source scan cannot tell a
 * working wiring from a plausible-looking one: it survives the action being
 * compared against a value it can never hold, and it survives the guard being
 * dropped. Both of those are cases below.
 */
describe('lookUpPress', () => {
  it('draws no control where there is nothing to look up with', () => {
    expect(lookUpPress('none', () => 'counsel', () => {})).toBeNull()
  })

  it('acts for a real term', () => {
    const run = vi.fn()
    lookUpPress('gloss', () => 'counsel', run)?.()
    expect(run).toHaveBeenCalledTimes(1)
  })

  /* The install prompt is a press like any other — `useGloss.ask` is what
     decides an unavailable provider shows it, so this must not branch. */
  it('acts the same way when the press will only offer an install', () => {
    const run = vi.fn()
    lookUpPress('install', () => 'counsel', run)?.()
    expect(run).toHaveBeenCalledTimes(1)
  })

  /* THE GUARD, which a source scan cannot see at all. A reader can select a
     whole chapter, and a chapter is not a term. */
  it.each([['an empty selection', ''], ['whitespace only', '  \n '], ['a chapter', 'a'.repeat(121)]])(
    'does nothing for %s',
    (_name, term) => {
      const run = vi.fn()
      lookUpPress('gloss', () => term, run)?.()
      expect(run).not.toHaveBeenCalled()
    },
  )

  /* THE TERM IS READ AT PRESS TIME, not at render. The button is created once
     and pressed later, and the selection moves underneath it — reading it
     early would define whatever was selected when the popup first appeared. */
  it('reads the selection when pressed, not when created', () => {
    let selected = 'first'
    const seen: string[] = []
    const press = lookUpPress('gloss', () => selected, () => void seen.push(selected))
    selected = 'second'
    press?.()
    expect(seen).toEqual(['second'])
  })
})
