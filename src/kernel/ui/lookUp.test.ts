import { describe, expect, it } from 'vitest'
import { LOOK_UP_SETTING } from '../core/gloss'
import { decideLookUp, isLookUpTerm } from './lookUp'

describe('decideLookUp', () => {
  /* ── WI-15.13's ACCEPTANCE CRITERION, WHICH IS "NO REGRESSION" ─────────
   * "With no model installed, `Look up` invokes `look_up` exactly as it does
   * today and Windows still shows no control. Everything here is addition." */
  describe('with no gloss bound — today’s behaviour, unchanged', () => {
    it('hands to the system dictionary on macOS', () => {
      expect(decideLookUp(true, false, 'system')).toBe('system')
    })

    it('does nothing at all off macOS, so no control is drawn', () => {
      expect(decideLookUp(false, false, 'system')).toBe('none')
    })

    /* The stored preference must not be able to conjure a gloss that is not
     * there — a reader who chose `gloss` and then removed the model gets the
     * dictionary, not a broken control. */
    it('ignores a stored preference for a gloss that does not exist', () => {
      expect(decideLookUp(true, false, 'gloss')).toBe('system')
      expect(decideLookUp(true, false, 'both')).toBe('system')
      expect(decideLookUp(false, false, 'gloss')).toBe('none')
    })
  })

  describe('with a gloss bound', () => {
    /* The half of F8 that is easy to miss: `hasDictionary` is false off
     * macOS, so a Windows reader has had no way to look a word up AT ALL.
     * This is not a second option for them — it is the first. */
    it('is the only lookup a Windows or Linux reader has ever had', () => {
      expect(decideLookUp(false, true, 'system')).toBe('gloss')
      expect(decideLookUp(false, true, 'both')).toBe('gloss')
      expect(decideLookUp(false, true, 'gloss')).toBe('gloss')
    })

    it('honours the reader’s choice on the one platform that has both', () => {
      expect(decideLookUp(true, true, 'system')).toBe('system')
      expect(decideLookUp(true, true, 'gloss')).toBe('gloss')
      expect(decideLookUp(true, true, 'both')).toBe('both')
    })

    it('falls back to the system dictionary rather than doing nothing', () => {
      expect(decideLookUp(true, true, 'none')).toBe('system')
    })

    /* THE SHIPPED DEFAULT, ASSERTED THROUGH THE SETTING ITSELF rather than by
     * repeating the literal — a test that hard-codes `'gloss'` here passes
     * whatever `LOOK_UP_SETTING.fallback` is changed to, which is precisely
     * the bug it is here to catch.
     *
     * The bug: a reader with a model installed and no stored preference got
     * Dictionary.app. The gloss was bound and `available` was true; the
     * fallback was `system`, and the branch below honours a stored choice. So
     * the feature was invisible until the reader found the settings row. */
    it('gives a reader who installed a model the gloss, with nothing stored', () => {
      /* REACHES THE GLOSS — not "equals `both`". The requirement is that a
         reader who just installed a model gets the thing they installed
         without hunting for a settings row; whether the system dictionary
         fires alongside it is a separate call, and one that has already been
         made both ways. Pinning the literal would make this test a second
         spelling of the default rather than a statement about it. */
      expect(['gloss', 'both']).toContain(decideLookUp(true, true, LOOK_UP_SETTING.fallback))
    })

    /* And the other half of that default: it must not be able to conjure a
       gloss that is not there. This is the no-regression rule, and it is the
       reason the default was safe to change at all — the branch never reads
       the preference when no gloss is bound. */
    it('still hands to the system dictionary when the default meets no model', () => {
      expect(decideLookUp(true, false, LOOK_UP_SETTING.fallback)).toBe('system')
      expect(decideLookUp(false, false, LOOK_UP_SETTING.fallback)).toBe('none')
    })
  })

  it('never answers `both` where only one half exists', () => {
    expect(decideLookUp(true, false, 'both')).not.toBe('both')
    expect(decideLookUp(false, true, 'both')).not.toBe('both')
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

  /* Past 120 characters the feature cannot work anyway — a `dict://` lookup
   * of a whole paragraph finds nothing, and the reader can select a chapter. */
  it('refuses a selection past the point the feature could work', () => {
    expect(isLookUpTerm('a'.repeat(120))).toBe(true)
    expect(isLookUpTerm('a'.repeat(121))).toBe(false)
  })

  it('measures the collapsed length, so line breaks do not disqualify a phrase', () => {
    expect(isLookUpTerm(`kept his\n\n   own counsel`)).toBe(true)
  })
})
