import { describe, expect, it } from 'vitest'
import {
  LOOK_UP_LABELS,
  LOOK_UP_MODES,
  NO_GLOSS,
  availableModes,
  effectiveMode,
  isLookUpMode,
} from './gloss'

describe('NO_GLOSS', () => {
  it('reports itself unavailable rather than pretending', () => {
    expect(NO_GLOSS.available).toBe(false)
  })

  /* Loud, not apologetic. A provider that resolved with a sentence would put
   * that sentence in front of the reader under an amber mark, which is the
   * one thing the mark must never be used for. */
  it('throws rather than resolving with an apology', async () => {
    await expect(NO_GLOSS.gloss('close', { sentence: 'x', bookTitle: 'y' }, new AbortController().signal))
      .rejects.toThrow(/Check `available`/)
  })
})

describe('isLookUpMode', () => {
  it('accepts the three modes and nothing else', () => {
    for (const mode of LOOK_UP_MODES) expect(isLookUpMode(mode)).toBe(true)
    for (const bad of ['', 'System', 'dictionary', null, undefined, 3, {}]) {
      expect(isLookUpMode(bad)).toBe(false)
    }
  })

  it('has a label for every mode', () => {
    for (const mode of LOOK_UP_MODES) {
      expect(LOOK_UP_LABELS[mode]).toBeTruthy()
    }
  })
})

describe('availableModes', () => {
  /* THE NO-REGRESSION RULE, as a table. WI-15.13: "With no model installed,
   * `Look up` invokes `look_up` exactly as it does today and Windows still
   * shows no control. Everything here is addition." */
  it('offers only the system dictionary on macOS with no model', () => {
    expect(availableModes(true, false)).toEqual(['system'])
  })

  it('offers nothing at all off macOS with no model — the control stays absent', () => {
    expect(availableModes(false, false)).toEqual([])
  })

  it('offers the gloss alone off macOS once a model is installed', () => {
    /* The half of F8 that is easy to miss: a Windows reader has never had a
     * dictionary at all, so this is not a second option — it is the first. */
    expect(availableModes(false, true)).toEqual(['gloss'])
  })

  it('offers all three on the one platform that has both', () => {
    expect(availableModes(true, true)).toEqual(['system', 'gloss', 'both'])
  })

  it('never offers `both` where only one half exists', () => {
    expect(availableModes(true, false)).not.toContain('both')
    expect(availableModes(false, true)).not.toContain('both')
  })
})

describe('effectiveMode', () => {
  it('uses the reader’s choice when it is available', () => {
    expect(effectiveMode('gloss', ['system', 'gloss', 'both'])).toBe('gloss')
  })

  it('is null when nothing is available, so the caller draws no control', () => {
    expect(effectiveMode('system', [])).toBeNull()
  })

  /* The stored preference outlives the thing it names: a reader who chose
   * `gloss` and then removed the model has a setting pointing at nothing. */
  it('falls back to the system dictionary when the gloss disappears', () => {
    expect(effectiveMode('gloss', ['system'])).toBe('system')
    expect(effectiveMode('both', ['system'])).toBe('system')
  })

  it('falls back to the gloss when there is no system dictionary', () => {
    expect(effectiveMode('both', ['gloss'])).toBe('gloss')
    expect(effectiveMode('system', ['gloss'])).toBe('gloss')
  })

  /* The stored value is NOT rewritten — this function only reports what to
   * use — so re-installing the model restores what the reader asked for
   * without them having to ask twice. Checked by asking again with the wider
   * list and getting the original answer back. */
  it('restores the reader’s choice when what it named comes back', () => {
    const chosen = 'gloss'
    expect(effectiveMode(chosen, ['system'])).toBe('system')
    expect(effectiveMode(chosen, ['system', 'gloss', 'both'])).toBe('gloss')
  })
})
