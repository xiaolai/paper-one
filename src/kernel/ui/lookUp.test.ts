import { describe, expect, it, vi } from 'vitest'
import { decideLookUp, lookUpPress, termVerdict } from './lookUp'

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

/**
 * ⚠️ **THREE ANSWERS, AND IT USED TO BE A BOOLEAN CALLED `isLookUpTerm`.**
 *
 * The two false cases are not one fact — an empty selection has nothing to say
 * about it, an over-long one has a sentence the reader can act on — and
 * collapsing them into `false` is what made SILENCE the only answer either
 * could get. `lookUpPress` read the boolean and `return`ed. The cases below are
 * the same cases; what changed is that the caller can now tell them apart, and
 * `useGloss.test.ts` asserts what the reader is told for each.
 */
describe('termVerdict', () => {
  it('accepts a headword and a short phrase', () => {
    expect(termVerdict('counsel')).toBe('ok')
    expect(termVerdict('kept his own counsel')).toBe('ok')
  })

  /* NOT `too-long`, and the difference is the whole reason this is not a
   * boolean: there is no passage to refuse and nothing to say about one. */
  it('answers empty for an empty or whitespace-only selection', () => {
    expect(termVerdict('')).toBe('empty')
    expect(termVerdict('   \n ')).toBe('empty')
  })

  /* Past 120 characters the reader has plainly not asked for a definition of a
   * word — they can select a whole chapter. It used to be the point past which
   * a `dict://` lookup found nothing; the reason changed and the number did
   * not. */
  it('refuses a selection past the point the feature could work', () => {
    expect(termVerdict('a'.repeat(120))).toBe('ok')
    expect(termVerdict('a'.repeat(121))).toBe('too-long')
  })

  it('measures the collapsed length, so line breaks do not disqualify a phrase', () => {
    expect(termVerdict(`kept his\n\n   own counsel`)).toBe('ok')
  })

  /* COUNTED IN CODE POINTS. `String.length` is UTF-16 units, so an astral
   * character counts twice and a selection of 120 of them would be refused as
   * 240. There is no longer a Rust half to disagree with, but the bound is on a
   * TERM and a term of CJK extension characters is a term. */
  it('counts code points, not UTF-16 units', () => {
    expect(termVerdict('𠮷'.repeat(120))).toBe('ok')
    expect(termVerdict('𠮷'.repeat(121))).toBe('too-long')
  })

  /* A closed set, counted, so a fourth answer cannot arrive untested. */
  it('has no fourth answer', () => {
    const seen = new Set(['counsel', '', 'a'.repeat(121)].map(termVerdict))
    expect(seen).toEqual(new Set(['ok', 'empty', 'too-long']))
  })
})

/**
 * THE WIRING, RUN RATHER THAN READ.
 *
 * This decision lived inside `Reader.tsx`, which takes sixteen props and
 * renders foliate — so the only assertion anybody could write was
 * `useGloss.test.ts` scanning the file for a call. A source scan cannot tell a
 * working wiring from a plausible-looking one: it survives the action being
 * compared against a value it can never hold, which is a case below.
 *
 * ⚠️ **THE TERM BOUND USED TO BE HERE AND IS NOW `useGloss.ask`'s**, along with
 * the cases that pinned it. It did not move for tidiness: this file's own
 * comment called the old behaviour "does nothing for a chapter", and doing
 * nothing was the bug — a drawn button, an accepted press, and no state, no
 * message and no diagnostic anywhere. A refusal the reader can read is a
 * STATE, and states are the hook's. See `useGloss.test.ts`, where those cases
 * now assert what the reader is told rather than that nothing happened.
 */
describe('lookUpPress', () => {
  it('draws no control where there is nothing to look up with', () => {
    expect(lookUpPress('none', () => {})).toBeNull()
  })

  it('acts for a real term', () => {
    const run = vi.fn()
    lookUpPress('gloss', run)?.()
    expect(run).toHaveBeenCalledTimes(1)
  })

  /* The install prompt is a press like any other — `useGloss.ask` is what
     decides an unavailable provider shows it, so this must not branch. */
  it('acts the same way when the press will only offer an install', () => {
    const run = vi.fn()
    lookUpPress('install', run)?.()
    expect(run).toHaveBeenCalledTimes(1)
  })

  /* NOT A COPY OF THE HANDLER. `lookUpPress` hands back the caller's own
     function, so there is nothing left here that could read the selection at
     the wrong moment, drop a press, or drift from what `Reader` passes. */
  it('hands back the caller’s own handler rather than a wrapper', () => {
    const run = vi.fn()
    expect(lookUpPress('gloss', run)).toBe(run)
  })
})
