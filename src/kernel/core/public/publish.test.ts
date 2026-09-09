import { describe, expect, it } from 'vitest'
import {
  PUBLIC_DISCLOSURE,
  PUBLIC_LINKS_DISCLOSURE,
  afterPublishing,
  afterWithdrawing,
  disclosureFor,
  linksVoiceToPerson,
  mayPublish,
  type Audience,
  type Published,
} from './publish'

const passage = { quote: 'a sentence', prefix: 'before ', suffix: ' after', chapter: 'One' }
const NEITHER: Published = { circle: false, public: false }

describe('mayPublish', () => {
  it('lets a circle publication through without a confirmation', () => {
    /* A reader sharing with people they chose has already made that decision,
       and a prompt on every passage is one readers learn to dismiss. */
    expect(mayPublish({ audience: 'circle', passage, acknowledged: false })).toBeNull()
  })

  it('refuses a public publication the reader has not been told about', () => {
    expect(mayPublish({ audience: 'public', passage, acknowledged: false })).toBe('needs-disclosure')
    expect(mayPublish({ audience: 'public', passage, acknowledged: true })).toBeNull()
  })
})

describe('one act changes one audience', () => {
  it('publishing to the circle leaves the public audience alone, and the reverse', () => {
    /* ⚠️ **THE MIRROR WI-26.4 FORBIDS WOULD BE A LINE HERE THAT SET BOTH.**
       And "no code path causes it" is not the property — disabling public
       publishing entirely would pass that. What is asserted is that each act
       reaches its own audience and only its own. */
    expect(afterPublishing(NEITHER, 'circle')).toEqual({ circle: true, public: false })
    expect(afterPublishing(NEITHER, 'public')).toEqual({ circle: false, public: true })
  })

  it('reaches both audiences only through two acts', () => {
    const both = afterPublishing(afterPublishing(NEITHER, 'circle'), 'public')
    expect(both).toEqual({ circle: true, public: true })
  })

  it('withdrawing from one leaves the other', () => {
    const both: Published = { circle: true, public: true }
    expect(afterWithdrawing(both, 'public')).toEqual({ circle: true, public: false })
    expect(afterWithdrawing(both, 'circle')).toEqual({ circle: false, public: true })
  })

  it('is idempotent, so a retried act is not a second publication', () => {
    const audiences: readonly Audience[] = ['circle', 'public']
    for (const audience of audiences) {
      const once = afterPublishing(NEITHER, audience)
      expect(afterPublishing(once, audience)).toEqual(once)
    }
  })
})

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
