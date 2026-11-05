import { describe, expect, it } from 'vitest'
import {
  PUBLIC_DISCLOSURE,
  PUBLIC_LINKS_DISCLOSURE,
  disclosureFor,
  linksVoiceToPerson,
  mayPublish,
} from './publish'

const passage = { quote: 'a sentence', prefix: 'before ', suffix: ' after', chapter: 'One' }

describe('mayPublish', () => {
  it('lets a circle publication through without a confirmation', () => {
    /* A reader sharing with people they chose has already made that decision,
       and a prompt on every passage is one readers learn to dismiss. */
    expect(mayPublish({ audience: 'circle', acknowledged: false })).toBeNull()
  })

  it('refuses a public publication the reader has not been told about', () => {
    expect(mayPublish({ audience: 'public', acknowledged: false })).toBe('needs-disclosure')
    expect(mayPublish({ audience: 'public', acknowledged: true })).toBeNull()
  })
})

/* ⚠️ **"ONE ACT CHANGES ONE AUDIENCE" IS ASSERTED AT THE PORTS NOW, NOT
   HERE.** This block drove `afterPublishing` and `afterWithdrawing` — two
   one-line transitions over a `Published` record that no surface and no port
   ever held. So it measured a model of the rule rather than the rule: the
   mirror WI-26.4 forbids could have been written in `publishPort` with every
   assertion here still green. `publishPort.test.ts` holds it against the
   thing that publishes — *"has no method that takes two audiences"*, and a
   public act that writes to the public store and nowhere else. Found by
   audit. */

describe('disclosureFor', () => {
  it('says nothing before a circle act', () => {
    expect(disclosureFor('circle', false)).toBeNull()
    expect(disclosureFor('circle', true)).toBeNull()
  })

  it('names the consequence before a public act', () => {
    const said = disclosureFor('public', false)
    expect(said).toBe(PUBLIC_DISCLOSURE)
    /* The consequence, not the mechanism: a reader needs to know it cannot be
       recalled, not that it is signed under a separate key. */
    expect(said).toMatch(/anyone/u)
    expect(said).toMatch(/already read it/u)
    expect(said).not.toMatch(/key|sign|hash|envelope/iu)
  })

  it('adds the linkage sentence when the circle already has these words', () => {
    /* ⚠️ **A SEPARATE SIGNING KEY HIDES NOTHING HERE.** Quote, prefix and
       suffix are identical by construction, so anybody in both audiences
       matches them without doing any work. */
    const said = disclosureFor('public', true)
    expect(said).toContain(PUBLIC_DISCLOSURE)
    expect(said).toContain(PUBLIC_LINKS_DISCLOSURE)
    expect(said).toMatch(/same person/u)
  })
})

describe('linksVoiceToPerson', () => {
  it('is true for the same three fields that travel', () => {
    expect(linksVoiceToPerson(passage, [passage])).toBe(true)
    /* A different chapter label is the same passage — builds disagree about
       chapter names, and the label does not identify anybody. */
    expect(linksVoiceToPerson(passage, [{ ...passage, chapter: 'Chapter One' }])).toBe(true)
    /* And a note withheld from one audience does not make it a different
       passage either. */
    expect(linksVoiceToPerson(passage, [{ ...passage, note: 'my own words' }])).toBe(true)
  })

  it('is false when any of the three differs', () => {
    for (const field of ['quote', 'prefix', 'suffix'] as const) {
      expect(linksVoiceToPerson(passage, [{ ...passage, [field]: 'different' }]), field).toBe(false)
    }
    expect(linksVoiceToPerson(passage, [])).toBe(false)
  })
})
