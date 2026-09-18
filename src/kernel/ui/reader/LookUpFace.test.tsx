// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_VOICE, type Speaking, type Voice } from '../../core/voice'
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

/**
 * A VOICE THE TEST DRIVES BY HAND — the PORT, not the capability behind it.
 *
 * `say` and `stop` move the state the way the bound voice does, and `settle`
 * stands in for the two things that happen without a press: playback finishing,
 * and a synthesis that failed. Everything the control draws is a function of
 * that state, so this is the whole surface it depends on.
 */
interface FakeVoice {
  readonly port: Voice
  /** Every text handed to `say`, with the language it was given. */
  readonly said: { text: string; lang: string | null | undefined }[]
  stops(): number
  /** What the capability would report on its own — an end, or a failure. */
  settle(next: Speaking): void
  /**
   * The voice's answer about a language CHANGING under the popup — what the
   * engine's own `voiceschanged` does when its list finally loads and turns out
   * to have no voice for the passage.
   */
  answer(serves: (lang: string | null) => boolean): void
}

function fakeVoice(serves: (lang: string | null) => boolean = () => true): FakeVoice {
  const listeners = new Set<() => void>()
  const said: { text: string; lang: string | null | undefined }[] = []
  let state: Speaking = 'idle'
  let stops = 0
  let answers = serves
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    said,
    stops: () => stops,
    settle: (next) => act(() => {
      state = next
      notify()
    }),
    answer: (next) => act(() => {
      answers = next
      notify()
    }),
    port: {
      canSay: (lang) => answers(lang),
      state: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      say: (text, lang) => {
        said.push({ text, lang })
        state = 'speaking'
        notify()
      },
      stop: () => {
        stops += 1
        state = 'idle'
        notify()
      },
    },
  }
}

/**
 * The pronunciation control.
 *
 * FOUND BY ITS NAME, WHICH DOES NOT MOVE. A toggle inside a `role="status"` live
 * region must not rename itself on every press — the region is atomic, so the
 * whole definition would be read back. `aria-pressed` carries the state instead,
 * which is what the cases below assert.
 */
const sayButton = () => screen.queryByRole('button', { name: /aloud/ })

const draw = (
  state: Exclude<GlossState, { kind: 'idle' }>,
  over: { onBack?: () => void; onInstall?: (section: string) => void; voice?: Voice } = {},
) =>
  render(
    <LookUpFace
      state={state}
      onBack={over.onBack ?? (() => {})}
      /* NOTHING CAN SPEAK unless a case says otherwise: every assertion written
         before pronunciation existed is about a face with no voice, and
         `NO_VOICE` is exactly that. (This said the port answers it on a browser
         client, a phone, or a machine with no speech model installed; each of
         those gets the machine's own voice now.) */
      voice={over.voice ?? NO_VOICE}
      {...(over.onInstall ? { onInstall: over.onInstall } : {})}
    />,
  )

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

  /*
   * THE PART OF SPEECH — §10's prototype draws it between the headword and the
   * meaning, and the ORDER is the assertion: a dictionary entry read out of
   * order is a different object. Asserted by position in the rendered text
   * rather than by class, because a CSS module's class name is a hash in jsdom.
   */
  it('shows the part of speech between the term and the meaning', () => {
    draw({ kind: 'ready', term: 'precisely', text: 'In exact terms; to the exact degree.', partOfSpeech: 'adverb' })

    const said = textOf(screen.getByRole('status'))
    expect(said).toContain('adverb')
    expect(said.indexOf('adverb')).toBeGreaterThan(said.indexOf('precisely'))
    expect(said.indexOf('adverb')).toBeLessThan(said.indexOf('In exact terms'))
  })

  /*
   * ⚠️ **NOTHING AT ALL WHEN THERE IS NONE — NOT AN EMPTY ELEMENT.** The
   * definition is a flex column with a gap between its children, so a span
   * rendered empty is a visible space under the term on every answer a model
   * did not mark, and `toContain('')` can never catch it. The child COUNT is
   * what can: two elements without a part of speech, three with.
   */
  it('draws no element at all for a part of speech it was not given', () => {
    const { container } = draw({ kind: 'ready', term: 'gam', text: 'A meeting of two whaling ships at sea.' })

    expect(container.querySelector('[role="status"]')?.childElementCount).toBe(2)
    cleanup()

    const { container: marked } = draw({ kind: 'ready', term: 'gam', text: 'A meeting.', partOfSpeech: 'noun' })
    expect(marked.querySelector('[role="status"]')?.childElementCount).toBe(3)
  })

  /* `asking` shares the definition's own box, deliberately — so it reaches the
     same element and has no part of speech to draw. */
  it('draws no part of speech while it is still looking', () => {
    draw({ kind: 'asking', term: 'gam' })

    expect(screen.getByRole('status').childElementCount).toBe(2)
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
   * NOTHING SET UP TO ANSWER WITH — the state that exists because the
   * Dictionary.app hand-off was deleted, and phase 17's decision that a macOS
   * reader must get SOMETHING rather than a control that disappeared. Since
   * 2026-09-18 the way out is the section where the reader CHOOSES what
   * answers — an endpoint, Claude, Codex or the local model — not a download.
   */
  describe('and the lookup with nothing to answer it', () => {
    const absent = { kind: 'unavailable', term: 'gam', installAt: 'inference:gloss' } as const

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
      expect(textOf(said)).toMatch(/needs something to answer with/i)
      expect(textOf(said)).toContain('gam')
      expect(textOf(said)).not.toMatch(/couldn.t define/i)
      /* NOT ONE WAY OF MEETING THE NEED: the local model is an opt-in, and the
         sentence must not read as "download a model". */
      expect(textOf(said)).not.toMatch(/language model|install/i)
    })

    /* L3: it goes to the SECTION the provider named, not to the top of a pane
       with that section collapsed under another band. */
    it('offers the way out, and it goes to the section the provider named', () => {
      const onInstall = vi.fn()
      draw(absent, { onInstall })

      screen.getByRole('button', { name: 'Choose one' }).click()

      expect(onInstall).toHaveBeenCalledTimes(1)
      expect(onInstall).toHaveBeenCalledWith('inference:gloss')
    })

    it('offers no way out where the caller gave it nowhere to send the reader', () => {
      draw(absent)

      expect(textOf(screen.getByRole('status'))).toMatch(/needs something to answer with/i)
      expect(screen.queryByRole('button', { name: 'Choose one' })).toBeNull()
    })

    /* THE OTHER HALF: this screen has somewhere to send the reader, and the
       build has nowhere to choose anything (WI-20.21's shape, which is a build
       with no `inference` since 2026-09-18). */
    it('offers no way out where the build has nowhere to choose', () => {
      draw({ ...absent, installAt: null }, { onInstall: () => {} })

      expect(textOf(screen.getByRole('status'))).toMatch(/needs something to answer with/i)
      expect(screen.queryByRole('button', { name: 'Choose one' })).toBeNull()
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
      expect(textOf(said)).not.toMatch(/needs something to answer with/i)
    })

    it('does not quote the passage back', () => {
      draw(long)

      expect(textOf(screen.getByRole('status')).length).toBeLessThan(120)
    })

    it('offers no way out, whatever the caller passes', () => {
      draw(long, { onInstall: () => {} })

      expect(screen.queryByRole('button', { name: 'Choose one' })).toBeNull()
    })
  })

  /**
   * PRONUNCIATION — the control that replaced IPA.
   *
   * §10's prototype draws a pronunciation after the headword. A language model
   * has no phonetic data, so asked for IPA it invents a transcription the reader
   * cannot check; the reader hears the word instead. `core/voice.ts` carries the
   * argument, and everything below is about what the popup does with the port.
   */
  describe('and saying the term aloud', () => {
    const ready = { kind: 'ready', term: 'gam', text: 'A meeting of two whaling ships at sea.' } as const

    /* §07 AND `ModelsPane`'s PRECEDENT: "a control that cannot do anything is
       §07's 'disabled and says why' with nothing to say". No voice, no button —
       and no install offer either, because this is one glyph inside an answer
       the reader already has. */
    it('draws no control at all where nothing can speak', () => {
      draw(ready)

      expect(sayButton()).toBeNull()
      expect(textOf(screen.getByRole('status'))).not.toMatch(/install/i)
    })

    it('offers to say the term where a voice is installed, and names it', () => {
      draw(ready, { voice: fakeVoice().port })

      expect(sayButton()?.getAttribute('aria-label')).toBe('Say “gam” aloud')
    })

    /* THE TERM, NOT THE DEFINITION — the whole point of the control. A button
       that spoke `said` would read the model's two sentences aloud, which is a
       different feature and not the one IPA occupied. */
    it('says the term and not the definition', () => {
      const voice = fakeVoice()
      draw(ready, { voice: voice.port })

      fireEvent.click(sayButton()!)

      expect(voice.said).toEqual([{ text: 'gam', lang: null }])
    })

    /*
     * ⚠️ **THE BOOK'S LANGUAGE, NOT THE INTERFACE'S.** A term is looked up
     * inside a passage, and the passage's own `lang` is what says how to
     * pronounce it — resolved at the press by the same climb of the range that
     * decides what language to ANSWER in, and carried on the state. Without it
     * every Chinese term in a reader's library is pronounced by whatever voice
     * the system defaults to.
     */
    it('says the term in the language the passage declared', () => {
      const voice = fakeVoice()
      draw({ kind: 'ready', term: '漢字', text: 'Chinese characters.', locale: 'zh-Hant' }, { voice: voice.port })

      fireEvent.click(sayButton()!)

      expect(voice.said).toEqual([{ text: '漢字', lang: 'zh-Hant' }])
    })

    /* AND `null` WHERE THE DOCUMENT DECLARED NONE, never `''`: WebKit reads an
       empty `lang` as a language it has no voice for, where unset leaves the
       reader's own default alone (`documentLang` records the measurement). */
    it('says nothing about the language when the passage declared none', () => {
      const voice = fakeVoice()
      draw(ready, { voice: voice.port })

      fireEvent.click(sayButton()!)

      expect(voice.said[0]?.lang).toBeNull()
    })

    /*
     * ⚠️ **THE CONTROL IS ABSENT FOR A LANGUAGE NOTHING CAN SAY, AND THAT IS A
     * STRICTER RULE THAN THE LISTEN CONTROL'S.** A machine with only English
     * voices reading a chapter aloud in one is still reading the chapter; the
     * same machine pronouncing a Chinese term in an English voice is a wrong
     * answer the reader has no way to check. §07: a control that cannot act is
     * not drawn.
     */
    it('draws no control for a term in a language the voice cannot say', () => {
      const english = fakeVoice((lang) => lang === null || lang.startsWith('en'))
      draw({ kind: 'ready', term: '漢字', text: 'Chinese characters.', locale: 'zh-Hant' }, { voice: english.port })

      expect(sayButton()).toBeNull()
    })

    /*
     * ⚠️ **AND AN ANSWER THAT ARRIVES LATE TAKES THE CONTROL BACK.** A voice
     * list is loaded asynchronously, so an empty one means "not yet" rather than
     * "none" and the port allows the press — which leaves the control drawn on
     * an answer that may turn out to be no. The engine's `voiceschanged` reaches
     * the port, the port notifies, and this is what re-asks: nothing else in the
     * tree re-renders for it, because the utterance's own state has not moved.
     */
    it('takes the control away when the voice list arrives without a match', () => {
      const unknown = fakeVoice()
      draw({ kind: 'ready', term: '漢字', text: 'Chinese characters.', locale: 'zh-Hant' }, { voice: unknown.port })
      expect(sayButton()).not.toBeNull()

      unknown.answer((lang) => lang === null || lang.startsWith('en'))

      expect(sayButton()).toBeNull()
    })

    /* ONE CONTROL, TWO STATES — `TitleBar`'s Listen idiom, which is why the
       glyph is the same `AudioLines`. `aria-pressed` is how a screen reader
       hears "it is running now"; the label changes with it, because "Stop" on
       its own says nothing about what. */
    it('shows that it is speaking, and the same control stops it', () => {
      const voice = fakeVoice()
      draw(ready, { voice: voice.port })
      expect(sayButton()?.getAttribute('aria-pressed')).toBe('false')

      fireEvent.click(sayButton()!)
      expect(sayButton()?.getAttribute('aria-pressed')).toBe('true')
      expect(sayButton()?.getAttribute('title')).toBe('Stop')

      fireEvent.click(sayButton()!)
      expect(voice.stops()).toBe(1)
      expect(sayButton()?.getAttribute('aria-pressed')).toBe('false')
    })

    /* ⚠️ **AND THE NAME STAYS PUT WHILE IT DOES.** The definition is a
       `role="status"` live region and an atomic one, so a control that renamed
       itself on press would have the whole definition read back to a
       screen-reader user for pressing play. The pressed state says it instead. */
    it('does not rename itself mid-utterance, because it lives in a live region', () => {
      draw(ready, { voice: fakeVoice().port })
      const named = sayButton()?.getAttribute('aria-label')

      fireEvent.click(sayButton()!)

      expect(sayButton()?.getAttribute('aria-label')).toBe(named)
    })

    /* IT ENDS ON ITS OWN, and the control has to notice. The utterance belongs
       to the capability, so nothing in this component would hear the audio
       finish without the subscription. */
    it('goes back to offering when the utterance ends by itself', () => {
      const voice = fakeVoice()
      draw(ready, { voice: voice.port })
      fireEvent.click(sayButton()!)

      voice.settle('idle')

      expect(sayButton()?.getAttribute('aria-pressed')).toBe('false')
    })

    /*
     * ⚠️ **THE READER MUST NOT BE LEFT WITH A VOICE THEY CANNOT STOP.** The Stop
     * control lives on the lookup's own face, so every route that puts the
     * lookup away — Back, a new selection, a page turn, leaving the book — takes
     * the control off the screen. All of them reach the same thing here: the
     * face unmounts. This is the same shape as `stopIf` in the capability's
     * speaker, and it is asserted as an UNMOUNT rather than as a list of events,
     * because a list is what misses the route somebody adds next.
     */
    it('stops the utterance when the lookup goes away', () => {
      const voice = fakeVoice()
      const { unmount } = draw(ready, { voice: voice.port })
      fireEvent.click(sayButton()!)
      expect(voice.stops()).toBe(0)

      unmount()

      expect(voice.stops(), 'a dismissed popup left the voice playing').toBe(1)
    })

    /* AND WHEN THE VOICE ITSELF GOES AWAY — a reader who removes the speech
       model in Settings mid-word. The control is no longer drawn, which is
       exactly the moment the audio would otherwise become unstoppable. */
    it('stops the utterance when the voice stops being available', () => {
      const voice = fakeVoice()
      const { rerender } = draw(ready, { voice: voice.port })
      fireEvent.click(sayButton()!)

      rerender(
        <LookUpFace state={ready} onBack={() => {}} voice={{ ...voice.port, canSay: () => false }} />,
      )

      expect(sayButton()).toBeNull()
      expect(voice.stops()).toBe(1)
    })

    /* SAID, NOT SWALLOWED — a press that made no sound and no sentence is
       indistinguishable from a broken button, which is the rule every other
       state in this face is drawn by. */
    it('says so when it could not be spoken', () => {
      const voice = fakeVoice()
      draw(ready, { voice: voice.port })
      fireEvent.click(sayButton()!)

      voice.settle('failed')

      expect(textOf(screen.getByRole('status'))).toMatch(/couldn.t say that aloud/i)
    })

    /* THE WORD IS KNOWN FROM THE PRESS, so it can be heard while the definition
       is still coming — and the box does not change shape when the answer
       arrives, which is why `asking` shares this element at all. */
    it('offers to say the term while it is still looking', () => {
      draw({ kind: 'asking', term: 'gam' }, { voice: fakeVoice().port })

      expect(sayButton()?.getAttribute('aria-label')).toBe('Say “gam” aloud')
    })

    /* NOT IN THE STATES THAT ARE NOT A DEFINITION. A pronunciation belongs to a
       dictionary entry; the other three are Paper speaking about itself, and
       `tooLong` has no term at all. */
    it.each([
      ['failed', { kind: 'failed', term: 'gam', reason: 'No model.' } as const],
      ['unavailable', { kind: 'unavailable', term: 'gam', installAt: 'inference:gloss' } as const],
      ['tooLong', { kind: 'tooLong' } as const],
    ])('draws no pronunciation in the %s state, even with a voice installed', (_name, state) => {
      draw(state, { voice: fakeVoice().port })

      expect(sayButton()).toBeNull()
    })

    /*
     * ⚠️ **IT SHARES THE HEADWORD'S LINE, AND THE CHILD COUNT IS WHAT SAYS SO.**
     * The definition is a flex column with a gap, so a control added as a
     * sibling of the term would be a line of its own between the headword and
     * the part of speech — a dictionary entry with its speaker glyph on the
     * wrong row, and `toContain` can never catch it. Two children with a voice
     * exactly as without one; three once a part of speech arrives.
     */
    it('sits on the headword’s own line rather than taking one', () => {
      const { container } = draw(ready, { voice: fakeVoice().port })
      expect(container.querySelector('[role="status"]')?.childElementCount).toBe(2)
      cleanup()

      const { container: marked } = draw({ ...ready, partOfSpeech: 'noun' }, { voice: fakeVoice().port })
      expect(marked.querySelector('[role="status"]')?.childElementCount).toBe(3)
    })

    /* THE ORDER SURVIVES IT: headword, part of speech, meaning. A control
       between the last two would read as part of the entry's own sequence. */
    it('keeps the part of speech between the term and the meaning', () => {
      draw({ ...ready, partOfSpeech: 'noun' }, { voice: fakeVoice().port })

      const said = textOf(screen.getByRole('status'))
      expect(said.indexOf('noun')).toBeGreaterThan(said.indexOf('gam'))
      expect(said.indexOf('noun')).toBeLessThan(said.indexOf('A meeting'))
    })

    /* IT IS NOT A WAY OUT. Speaking acts on the answer the reader is reading;
       putting the lookup away is Back's job and only Back's. */
    it('does not put the lookup away', () => {
      const onBack = vi.fn()
      draw(ready, { onBack, voice: fakeVoice().port })

      fireEvent.click(sayButton()!)

      expect(onBack).not.toHaveBeenCalled()
    })
  })

  /* Every state carries the same way back, from one definition. */
  it.each([
    ['ready', { kind: 'ready', term: 'gam', text: 'A meeting.' } as const],
    ['asking', { kind: 'asking', term: 'gam' } as const],
    ['failed', { kind: 'failed', term: 'gam', reason: 'No model.' } as const],
    ['unavailable', { kind: 'unavailable', term: 'gam', installAt: 'inference:gloss' } as const],
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
