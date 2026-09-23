// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'
import { FakeAudioHost, pcmOf } from './enginePlayer.testkit'
import type { VoicePack } from '../../core/ports'
import {
  CONTINUE_GRACE_MS,
  CONTINUE_TICK_MS,
  TURN_SETTLE_MS,
  useSpeech,
  type ReadingEngine,
  type Speech,
} from './useSpeech'
import { Speaker, collectText, type SpeakPrefs } from './speech'

/**
 * The wiring: a section's document in, page turns and utterances out.
 *
 * `speech.ts` proves the decisions — which language, which way is ahead —
 * and this proves the hook acts on them: that the voice asks for the page it
 * has walked off, that a section ending is not a reading ending, and that
 * the reader's stop is the only thing that is.
 *
 * Layout is STUBBED, not simulated. jsdom gives every box zero size and has
 * no `Range.getBoundingClientRect` at all — the follow-along could never have
 * run under it — so each section's frame, stage and word rects are set by the
 * test. The arithmetic over them is `placeOf`'s and is tested where it lives.
 */

afterEach(cleanup)

let synth: FakeSynth
const originalUtterance = globalThis.SpeechSynthesisUtterance

beforeEach(() => {
  synth = new FakeSynth()
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true })
  window.SpeechSynthesisUtterance = FakeUtterance as unknown as typeof SpeechSynthesisUtterance
  vi.useFakeTimers()
})

afterEach(() => {
  delete (window as { speechSynthesis?: unknown }).speechSynthesis
  window.SpeechSynthesisUtterance = originalUtterance
  vi.useRealTimers()
})

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

/**
 * One spine document, laid out the way foliate lays a paginated section out:
 * a frame three columns wide inside a stage one column wide, the overflow
 * clipped. Every word of it sits where `wordAt` last put it.
 *
 * An ARRAY of paragraphs where a test needs more than one block: a paragraph
 * step has nowhere to go inside a single `<p>`, and `collectText`'s block index
 * is the thing being exercised.
 */
function section(text: string | readonly string[], lang: string | null = null) {
  const stage = document.createElement('div')
  document.body.append(stage)
  const frame = document.createElement('iframe')
  stage.append(frame)
  const doc = frame.contentDocument
  if (!doc) throw new Error('jsdom gave the frame no document')
  if (lang) doc.documentElement.setAttribute('lang', lang)
  doc.body.innerHTML = Array.isArray(text)
    ? text.map((block) => `<p>${block}</p>`).join('')
    : text === ''
      ? ''
      : `<p>${text as string}</p>`

  stage.getBoundingClientRect = () => rect(0, 0, 1000, 800)
  frame.getBoundingClientRect = () => rect(0, 0, 3000, 800)
  let word = rect(100, 100, 60, 20)
  /**
   * Words that are off the page, BY THEIR TEXT rather than by position.
   *
   * ⚠️ **WITHOUT THIS, A TEST OF THE OFFSET REBASE CANNOT FAIL.** The stub below
   * used to answer the same rect for every range, so which word an offset
   * resolved to made no difference to the page decision — and removing the
   * rebase entirely left all 34 cases green. `this` inside the stub is the Range,
   * so asking it what text it covers is what makes the resolved word observable.
   */
  const offPage = new Set<string>()
  const realm = doc.defaultView as Window & { Range: { prototype: Range } }
  realm.Range.prototype.getBoundingClientRect = function (this: Range) {
    return offPage.has(this.toString()) ? rect(1200, 100, 60, 20) : word
  }

  return {
    doc,
    /** Put every word at this x, in the frame's own coordinates. */
    wordAt(left: number) {
      word = rect(left, 100, 60, 20)
    },
    /** Put these words, and only these, in the next column. */
    offPage(...words: readonly string[]) {
      offPage.clear()
      for (const one of words) offPage.add(one)
    },
    remove() {
      stage.remove()
    },
  }
}

/** The engine reporting a word boundary on the current utterance. */
function boundary(index: number, length: number, at = synth.queued.length - 1) {
  const event = Object.assign(new Event('boundary'), { charIndex: index, charLength: length, name: 'word' })
  act(() => {
    synth.queued[at]?.dispatchEvent(event)
  })
}

function ends(at = synth.queued.length - 1) {
  act(() => {
    synth.queued[at]?.dispatchEvent(new Event('end'))
  })
}

function mount(
  doc: Document | null,
  {
    chapters = false,
    lands = true,
    can,
    prefs,
    engine = null,
  }: {
    chapters?: boolean
    lands?: boolean
    /** Asked per direction, and per render — the transport draws each button
     *  from its own answer, and a book answers differently at either end. */
    can?: (by: -1 | 1) => boolean
    prefs?: SpeakPrefs
    /** The downloaded voices, where a case is about routing to them. */
    engine?: ReadingEngine | null
  } = {},
) {
  const next = vi.fn()
  /* ⚠️ `lands` IS THE WHOLE POINT OF THE RETURN VALUE. A `chapter` that
     declines is what a reader meets at either end of a book, and the reading
     must survive it — see the case that presses a dead direction mid-gap. */
  const chapter = vi.fn(() => lands)
  const api: { current: Speech | null } = { current: null }
  function Probe({ doc }: { doc: Document | null }) {
    /* ABSENT rather than a no-op when the book cannot step chapters — the
       transport reads its presence to decide whether to draw the buttons. */
    api.current = useSpeech(
      doc,
      chapters ? { next, chapter: { can: can ?? (() => lands), go: chapter } } : { next },
      prefs,
      engine,
    )
    return null
  }
  const view = render(<Probe doc={doc} />)
  return {
    next,
    chapter,
    speech: () => api.current!,
    show: (doc: Document | null) => view.rerender(<Probe doc={doc} />),
    /** The window outlives the component, so what an unmount does to a reading
     *  in progress is a case rather than a detail. */
    unmount: () => view.unmount(),
  }
}

/** The text of every utterance queued so far, in order. */
const spoken = () => synth.queued.map((u) => u.text.trim())

describe('the language', () => {
  it('speaks the section in the language its document declares', () => {
    const a = section('Bonjour le monde', 'fr')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    expect(synth.queued[0]?.text).toBe('Bonjour le monde')
    expect(synth.queued[0]?.lang).toBe('fr')
    a.remove()
  })
})

describe('following the voice across pages', () => {
  it('turns to a word that has left the page, once', () => {
    const a = section('Bonjour le monde')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())

    boundary(0, 7)
    expect(next).not.toHaveBeenCalled()

    /* Two words in the next column, inside one page turn's animation. The
     * second must not turn a second page: foliate takes a turn asked for
     * mid-animation rather than dropping it, so two asks are two pages. */
    a.wordAt(1200)
    boundary(8, 2)
    boundary(11, 5)
    expect(next).toHaveBeenCalledTimes(1)

    // The turn landed and the word is still ahead — a page with nothing to
    // read on it. Now a second turn is right.
    vi.advanceTimersByTime(TURN_SETTLE_MS)
    boundary(11, 5)
    expect(next).toHaveBeenCalledTimes(2)
    a.remove()
  })

  it('a word back on the page re-arms the turn at once', () => {
    const a = section('Bonjour le monde')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())

    a.wordAt(1200)
    boundary(0, 7)
    a.wordAt(100)
    boundary(8, 2)
    a.wordAt(1200)
    boundary(11, 5)
    expect(next).toHaveBeenCalledTimes(2)
    a.remove()
  })

  it('never turns for a word behind the page', () => {
    // The reader flipped forward to peek. The voice keeps its place; the
    // page is theirs.
    const a = section('Bonjour le monde')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    a.wordAt(-500)
    boundary(0, 7)
    expect(next).not.toHaveBeenCalled()
    a.remove()
  })
})

/**
 * NO VOICE RATHER THAN A BAD ONE — and a refusal must END the reading.
 *
 * Every reason the speaker reports but three means "that sentence finished, go
 * on", so a refusal read that way walked the book: the next sentence, refused;
 * then the next section, a page turn at a time, refused again. Nothing can be
 * read until the voices change.
 */
describe('a reading no voice is good enough for', () => {
  it('stops at once, speaks nothing and turns no page', () => {
    /* What a Mac's WebView offers — all of it below the floor. */
    synth.voices = [
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.super-compact.en-US.Samantha' },
    ]
    const a = section(['First sentence here.', 'Second sentence here.'], 'en-US')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    act(() => {
      vi.advanceTimersByTime(CONTINUE_TICK_MS * 4)
    })
    expect(synth.queued).toEqual([])
    expect(next, 'the refusal walked the book').not.toHaveBeenCalled()
    expect(speech().speaking).toBe(false)
    a.remove()
  })

  /* THE CASE THE GUARD IN `onDone` IS FOR. On the reader's own press the reading
     is not yet marked under way, so a refusal there ends it by another road;
     MID-reading it does not. A book that moves into a section in a language no
     good voice speaks must stop there, not walk on through it. */
  it('stops where the reading reaches a section no good voice can read', () => {
    synth.voices = [{ name: 'Zoe', lang: 'en-US', voiceURI: 'com.apple.voice.enhanced.en-US.Zoe' }]
    const a = section('An English chapter.', 'en-US')
    const b = section(['Un chapitre.', 'Une autre phrase.'], 'fr-FR')
    const { speech, next, show } = mount(a.doc)
    act(() => speech().start())
    ends()
    expect(next).toHaveBeenCalledTimes(1)

    show(b.doc)
    act(() => {
      vi.advanceTimersByTime(CONTINUE_TICK_MS * 4)
    })
    expect(spoken(), 'nothing French was read').toEqual(['An English chapter.'])
    expect(next, 'the refusal walked on past the section').toHaveBeenCalledTimes(1)
    expect(speech().speaking).toBe(false)
    a.remove()
    b.remove()
  })
})

describe('the end of a section', () => {
  it('goes on into the next section instead of stopping', () => {
    const a = section('First chapter.')
    const b = section('Second chapter.', 'de')
    const { speech, next, show } = mount(a.doc)
    act(() => speech().start())
    expect(speech().speaking).toBe(true)

    ends()
    expect(next).toHaveBeenCalledTimes(1)
    expect(speech().speaking).toBe(true)

    show(b.doc)
    expect(synth.queued).toHaveLength(2)
    expect(synth.queued[1]?.text).toBe('Second chapter.')
    expect(synth.queued[1]?.lang).toBe('de')
    expect(speech().speaking).toBe(true)
    a.remove()
    b.remove()
  })

  it('keeps turning until the next section arrives, then stops asking', () => {
    // The utterance can end with pages of the section still to go — plates,
    // a full-page figure — because the voice only walks the readable text.
    // One `next` per tick walks them; the section that follows is spoken.
    const a = section('First chapter.')
    const b = section('Second chapter.')
    const { speech, next, show } = mount(a.doc)
    act(() => speech().start())
    ends()
    expect(next).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(CONTINUE_TICK_MS * 2)
    })
    expect(next).toHaveBeenCalledTimes(3)

    show(b.doc)
    act(() => {
      vi.advanceTimersByTime(CONTINUE_GRACE_MS)
    })
    expect(next).toHaveBeenCalledTimes(3)
    expect(speech().speaking).toBe(true)
    a.remove()
    b.remove()
  })

  it('gives up when no section follows, so the control does not stay lit', () => {
    const a = section('Last chapter.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    ends()
    act(() => {
      vi.advanceTimersByTime(CONTINUE_GRACE_MS + CONTINUE_TICK_MS)
    })
    expect(speech().speaking).toBe(false)
    expect(next.mock.calls.length).toBeLessThanOrEqual(CONTINUE_GRACE_MS / CONTINUE_TICK_MS + 1)
    a.remove()
  })

  it('reads through a section with nothing to read', () => {
    const a = section('First chapter.')
    const plate = section('')
    const c = section('Third chapter.')
    const { speech, next, show } = mount(a.doc)
    act(() => speech().start())
    ends()
    expect(next).toHaveBeenCalledTimes(1)

    show(plate.doc)
    // Nothing queued for the plate, and the reading did not end there.
    expect(synth.queued).toHaveLength(1)
    expect(next).toHaveBeenCalledTimes(2)
    expect(speech().speaking).toBe(true)

    show(c.doc)
    expect(synth.queued[1]?.text).toBe('Third chapter.')
    a.remove()
    plate.remove()
    c.remove()
  })

  it('stops on an engine error rather than erroring through the whole book', () => {
    const a = section('First chapter.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    act(() => {
      synth.queued[0]?.dispatchEvent(new Event('error'))
    })
    expect(speech().speaking).toBe(false)
    expect(next).not.toHaveBeenCalled()
    a.remove()
  })

  /**
   * ⚠️ **AND IT STOPS WHEN SOMETHING ELSE TAKES THE ENGINE, RATHER THAN WALKING
   * THE BOOK.** `window.speechSynthesis` serves one utterance, and the lookup
   * popup's pronunciation speaks through the same one — so a reader who
   * pronounces a word mid-reading cancels this utterance, whose `end` arrives
   * anyway. Read as a section finishing, that ran `continueReading()`: pages
   * turning forward hunting the next section while one word was being
   * pronounced. `engineHeldBy` in `speech.ts` reports it as `taken` instead, and
   * this is the half that acts on it.
   *
   * The reading ends VISIBLY — `speaking` goes false, so the Listen control
   * shows what happened — and no page is turned.
   */
  it('stops when another speaker takes the engine, without turning a page', () => {
    const a = section('First chapter.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    const section_ = synth.queued[0]

    /* What the pronunciation control is: another `Speaker` over this engine. */
    const pronouncing = new Speaker(
      { onWord: () => {}, onDone: () => {}, onNoBoundaries: () => {} },
      synth as unknown as SpeechSynthesis,
    )
    act(() => {
      pronouncing.speak('gam', null)
      section_?.dispatchEvent(new Event('end'))
    })

    expect(speech().speaking).toBe(false)
    expect(next).not.toHaveBeenCalled()
    a.remove()
  })
})

describe('a section change while speaking', () => {
  it('does not stop the speaker — the new section is read', () => {
    // The reader clicked a chapter in the contents. Following them is the
    // reading continuing; stopping was the old behaviour, and for a PDF it
    // fired at every page.
    const a = section('First chapter.')
    const b = section('Fifth chapter.')
    const { speech, show } = mount(a.doc)
    act(() => speech().start())
    show(b.doc)
    expect(speech().speaking).toBe(true)
    expect(synth.queued).toHaveLength(2)
    expect(synth.queued[1]?.text).toBe('Fifth chapter.')
    a.remove()
    b.remove()
  })

  it('an explicit stop is the reader speaking, and a later section change queues nothing', () => {
    const a = section('First chapter.')
    const b = section('Second chapter.')
    const { speech, next, show } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stop())
    expect(speech().speaking).toBe(false)

    show(b.doc)
    expect(synth.queued).toHaveLength(1)
    expect(next).not.toHaveBeenCalled()
    expect(speech().speaking).toBe(false)
    a.remove()
    b.remove()
  })

  it('the book closing ends the reading', () => {
    const a = section('First chapter.')
    const { speech, show } = mount(a.doc)
    act(() => speech().start())
    show(null)
    expect(speech().speaking).toBe(false)
    expect(synth.cancelled).toBeGreaterThan(0)
    a.remove()
  })
})

describe('collectText — the words between the words', () => {
  /* Here rather than in `speech.test.ts`, whose header explains why it holds
     no DOM: this is not a layout question — jsdom walks a tree the same way
     WebKit does. */
  it('keeps the space a standalone whitespace node carries between two inline spans', () => {
    /* `<span>Hello</span> <span>world</span>` is three text nodes in ONE
       block; rejecting the whitespace node fused the words — the voice said
       "Helloworld", and every boundary offset after it was off by the missing
       space (audit round 1, #500). The separator sits OUTSIDE the segments,
       so an offset landing in it maps to no node rather than the wrong one. */
    const doc = document.implementation.createHTMLDocument('s')
    doc.body.innerHTML = '<p><span>Hello</span> <span>world</span></p>'
    const spoken = collectText(doc)
    expect(spoken.text).toBe('Hello world')
    expect(spoken.segments).toHaveLength(2)
    const worldAt = spoken.text.indexOf('world')
    const seg = spoken.segments.find((one) => one.start <= worldAt && worldAt < one.end)
    expect(seg?.node.textContent).toBe('world')
  })

  it('does not stack separators for a run of indentation nodes', () => {
    const doc = document.implementation.createHTMLDocument('s')
    doc.body.innerHTML = '<p>One</p>\n\n   \n<p>Two</p>'
    const spoken = collectText(doc)
    expect(spoken.text).toBe('One Two')
  })
})

describe('reading one sentence at a time', () => {
  /**
   * ⚠️ **THE WHOLE SECTION USED TO BE ONE UTTERANCE**, and that is why none of
   * the reader's controls except play and stop could exist: Web Speech cannot
   * seek inside an utterance and cannot change its rate once it has started.
   * Every test below is a control that became possible when the utterance became
   * a sentence.
   */
  it('queues one sentence, not the whole section', () => {
    const a = section('One here. Two there. Three everywhere.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    expect(spoken()).toEqual(['One here.'])
    a.remove()
  })

  it('speaks the next sentence when one ends, without turning a page', () => {
    const a = section('One here. Two there. Three everywhere.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    ends()
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    /* ⚠️ **A SENTENCE ENDING IS NOT A SECTION ENDING.** Before the split, an
       utterance ending WAS the section ending, and `continueReading` walks pages
       hunting the next section — so treating a sentence's end that way would
       turn the page away from prose nobody had read. */
    expect(next).not.toHaveBeenCalled()
    expect(speech().speaking).toBe(true)
    a.remove()
  })

  it('walks to the next section only after the last sentence', () => {
    const a = section('One here. Two there.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    ends()
    expect(next).not.toHaveBeenCalled()
    ends()
    expect(next).toHaveBeenCalledTimes(1)
    a.remove()
  })
})

describe('the follow-along highlight across sentences', () => {
  /**
   * ⚠️ **THE ENGINE COUNTS FROM THE START OF THE UTTERANCE, AND THE UTTERANCE IS
   * NOW A SENTENCE.** So a boundary at index 0 in the second sentence is that
   * sentence's first word, not the chapter's — and resolving it without adding
   * the sentence's own offset puts the highlight at the top of the section for
   * every sentence after the first. The same trap `narrate`'s `byteSampleOffset`
   * records, one layer up.
   */
  it('resolves a later sentence offset to that sentence own word', () => {
    /* ⚠️ **THE FIRST VERSION OF THIS TEST COULD NOT FAIL**, and removing the
       rebase left all 34 cases green. It put every word at one x, so which word
       an offset resolved to changed nothing. Now the page decision is driven by
       the resolved TEXT: `Two` is in the next column and `One` is not, so an
       offset read as absolute resolves to `One` and turns no page. */
    const a = section('One here. Two there. Three everywhere.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    ends()
    expect(spoken()).toEqual(['One here.', 'Two there.'])

    a.offPage('Two')
    boundary(0, 3)
    expect(next).toHaveBeenCalledTimes(1)
    a.remove()
  })

  it('does not turn for the first word of a later sentence that is on the page', () => {
    /* The mirror, so the case above cannot pass by turning for everything: here
       the first sentence own word is the one in the next column, and a boundary
       in the SECOND sentence must ignore it. */
    const a = section('One here. Two there. Three everywhere.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    ends()

    a.offPage('One')
    boundary(0, 3)
    expect(next).not.toHaveBeenCalled()
    a.remove()
  })

  it('resolves the third sentence too, so the rebase is not a one-off', () => {
    const a = section('One here. Two there. Three everywhere.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    ends()
    ends()
    expect(spoken()).toEqual(['One here.', 'Two there.', 'Three everywhere.'])

    a.offPage('Three')
    boundary(0, 5)
    expect(next).toHaveBeenCalledTimes(1)
    a.remove()
  })
})

describe('the band does not outlive its sentence', () => {
  /**
   * ⚠️ **A SENTENCE THAT REPORTS NO BOUNDARY USED TO INHERIT THE LAST ONE'S
   * HIGHLIGHT.** The band only moves on a boundary event, and `BOUNDARY_GRACE_MS`
   * measures 2.5 s of speech — most sentences are shorter, so nothing concludes
   * the engine is silent and nothing clears it. The reader then sees the band
   * sitting on the previous sentence's last word while a different sentence is
   * read aloud: a highlight pointing confidently at the wrong place.
   */
  const bandIn = (doc: Document) => doc.getElementById('paper-spoken-word')

  it('clears the previous sentence band when the next one begins', () => {
    const a = section('One here. Two there.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    boundary(0, 3)
    expect(bandIn(a.doc), 'a boundary should have drawn a band').not.toBeNull()

    /* The next sentence reports NO boundary — the ordinary case for a short one. */
    ends()
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    expect(bandIn(a.doc)).toBeNull()
    a.remove()
  })

  it('still draws one for the new sentence when a boundary does arrive', () => {
    /* So the clear cannot pass by simply never drawing again. */
    const a = section('One here. Two there.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    ends()
    boundary(0, 3)
    expect(bandIn(a.doc)).not.toBeNull()
    a.remove()
  })
})

describe('pause and resume', () => {
  it('holds the engine and reports it, then lets go', () => {
    const a = section('One here. Two there.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    expect(speech().paused).toBe(false)

    act(() => speech().pause())
    expect(speech().paused).toBe(true)
    expect(synth.paused).toBe(true)
    /* STILL READING. Paused is a state of the voice, not the end of the
       reading — the Listen control must not switch itself off. */
    expect(speech().speaking).toBe(true)

    act(() => speech().resume())
    expect(speech().paused).toBe(false)
    expect(synth.paused).toBe(false)
    a.remove()
  })

  it('does nothing when no reading is under way', () => {
    const a = section('One here.')
    const { speech } = mount(a.doc)
    act(() => speech().pause())
    expect(speech().paused).toBe(false)
    a.remove()
  })

  it('stops clears the pause, so the next start is not born held', () => {
    const a = section('One here. Two there.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().pause())
    act(() => speech().stop())
    expect(speech().paused).toBe(false)
    a.remove()
  })
})

describe('stepping by sentence', () => {
  it('goes forward and back within the section', () => {
    const a = section('One here. Two there. Three everywhere.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stepSentence(1))
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    act(() => speech().stepSentence(-1))
    expect(spoken()).toEqual(['One here.', 'Two there.', 'One here.'])
    a.remove()
  })

  it('re-speaks the first sentence rather than doing nothing at the start', () => {
    const a = section('One here. Two there.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stepSentence(-1))
    expect(spoken()).toEqual(['One here.', 'One here.'])
    a.remove()
  })

  it('leaves the last sentence playing rather than crossing the section itself', () => {
    /* ⚠️ **THE CROSSING IS `continueReading`'s AND MUST STAY THERE.** When this
       sentence ends, `onDone` finds no next one and hands over to the machinery
       that walks pages with a grace period — the only thing that can tell the end
       of a book from a slow page turn. A second answer here would be a second
       thing to get wrong. */
    const a = section('One here. Two there.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stepSentence(1))
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    act(() => speech().stepSentence(1))
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    expect(next).not.toHaveBeenCalled()
    a.remove()
  })

  it('does nothing when no reading is under way', () => {
    const a = section('One here. Two there.')
    const { speech } = mount(a.doc)
    act(() => speech().stepSentence(1))
    expect(spoken()).toEqual([])
    a.remove()
  })
})

describe('stepping by paragraph', () => {
  const THREE = ['One here. Two there.', 'Three everywhere. Four beyond.', 'Five last.']

  it('goes to the first sentence of the next paragraph', () => {
    const a = section(THREE)
    const { speech } = mount(a.doc)
    act(() => speech().start())
    expect(spoken()).toEqual(['One here.'])
    act(() => speech().stepParagraph(1))
    expect(spoken()).toEqual(['One here.', 'Three everywhere.'])
    a.remove()
  })

  it('restarts the current paragraph before leaving it', () => {
    /* The back-button convention — see `stepParagraph` in `readingCursor.ts`. */
    const a = section(THREE)
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stepSentence(1))
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    act(() => speech().stepParagraph(-1))
    expect(spoken()).toEqual(['One here.', 'Two there.', 'One here.'])
    a.remove()
  })

  it('crosses into the previous paragraph from that paragraph first sentence', () => {
    const a = section(THREE)
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stepParagraph(1))
    act(() => speech().stepParagraph(-1))
    expect(spoken()).toEqual(['One here.', 'Three everywhere.', 'One here.'])
    a.remove()
  })

  it('needs the block index collectText records, which a single space cannot carry', () => {
    /* ⚠️ **THE BLOCK SEPARATOR IS ONE SPACE**, chosen so the voice does not weld
       `endBegin` and so an inline element cannot split a word — which makes a
       paragraph break and a word space the same character. Without
       `SpokenText.blocks` this step has nothing to look for, and the three
       paragraphs above are one run of text. */
    const a = section(THREE)
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stepParagraph(1))
    act(() => speech().stepParagraph(1))
    expect(spoken()).toEqual(['One here.', 'Three everywhere.', 'Five last.'])
    a.remove()
  })
})

describe('stepping by chapter', () => {
  it('asks the book, and does not restart the reading itself', () => {
    /* Navigating changes the spine document, and the document effect speaks the
       new one — the same path a reader taking a chapter from the contents goes
       down while listening. */
    const a = section('One here.')
    const { speech, chapter } = mount(a.doc, { chapters: true })
    act(() => speech().start())
    act(() => speech().stepChapter(1))
    expect(chapter).toHaveBeenCalledWith(1)
    expect(spoken()).toEqual(['One here.'])
    a.remove()
  })

  /**
   * ⚠️ **A DIRECTION THAT DECLINES USED TO KILL THE READING.** `stepChapter`
   * cleared the pending sentence gap and the section continuation BEFORE asking
   * the book to navigate, and `chapter` answered nothing at all, so a press at
   * either end of the book — where a reader is very likely to press — threw
   * away the only future work the reading had. The voice fell silent,
   * `speaking` stayed true, and no timer was left to restart it: the transport
   * showed a reading in progress that only stop could end.
   *
   * The book is the only thing that knows whether a step lands, which is why
   * `chapter.go` reports it rather than the hook guessing.
   */
  it('keeps reading when a chapter step declines, instead of stranding it mid-gap', () => {
    const a = section('One here. Two there.')
    const { speech, chapter } = mount(a.doc, { chapters: true, lands: false, prefs: { sentenceGapMs: 300 } })
    act(() => speech().start())
    /* MID-GAP: the first sentence is done and the timer for the second is the
       pending work the old teardown destroyed. */
    ends()
    expect(spoken()).toEqual(['One here.'])

    act(() => speech().stepChapter(1))

    expect(chapter, 'the book was still asked').toHaveBeenCalledWith(1)
    expect(speech().speaking, 'and the reading is still under way').toBe(true)
    act(() => vi.advanceTimersByTime(300))
    expect(spoken(), 'the sentence the gap was waiting for still arrives').toEqual([
      'One here.',
      'Two there.',
    ])
    a.remove()
  })

  it('does nothing at all when the book cannot step chapters', () => {
    const a = section('One here.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stepChapter(1))
    expect(speech().speaking).toBe(true)
    a.remove()
  })

  it('does nothing when no reading is under way', () => {
    const a = section('One here.')
    const { speech, chapter } = mount(a.doc, { chapters: true })
    act(() => speech().stepChapter(1))
    expect(chapter).not.toHaveBeenCalled()
    a.remove()
  })
})

describe('the silence between sentences and paragraphs', () => {
  const TWO = ['One here. Two there.', 'Three everywhere.']

  it('waits the sentence gap before the next sentence', () => {
    const a = section(TWO)
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 300, paragraphGapMs: 900 } })
    act(() => speech().start())
    ends()
    /* Nothing yet: the reading is in the pause. */
    expect(spoken()).toEqual(['One here.'])
    act(() => vi.advanceTimersByTime(299))
    expect(spoken()).toEqual(['One here.'])
    act(() => vi.advanceTimersByTime(1))
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    a.remove()
  })

  it('waits the PARAGRAPH gap where the next sentence opens one', () => {
    const a = section(TWO)
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 300, paragraphGapMs: 900 } })
    act(() => speech().start())
    ends()
    act(() => vi.advanceTimersByTime(300))
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    ends()
    /* The sentence gap would have been enough; a paragraph boundary is not. */
    act(() => vi.advanceTimersByTime(300))
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    act(() => vi.advanceTimersByTime(600))
    expect(spoken()).toEqual(['One here.', 'Two there.', 'Three everywhere.'])
    a.remove()
  })

  it('uses the paragraph gap ALONE, not added to the sentence gap', () => {
    /* A reader who sets the paragraph pause to zero means no pause there, which
       adding the sentence gap underneath would make impossible to ask for. */
    const a = section(TWO)
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 300, paragraphGapMs: 0 } })
    act(() => speech().start())
    ends()
    act(() => vi.advanceTimersByTime(300))
    ends()
    expect(spoken()).toEqual(['One here.', 'Two there.', 'Three everywhere.'])
    a.remove()
  })

  it('does not hesitate at all when the pause is zero', () => {
    const a = section(TWO)
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 0, paragraphGapMs: 0 } })
    act(() => speech().start())
    ends()
    /* No timer advanced: a `setTimeout(0)` would still yield, and a reader who
       turned the pause off asked for the reading not to wait. */
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    a.remove()
  })

  it('a stop during the pause stays stopped', () => {
    const a = section(TWO)
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 300, paragraphGapMs: 900 } })
    act(() => speech().start())
    ends()
    act(() => speech().stop())
    act(() => vi.advanceTimersByTime(5000))
    expect(spoken()).toEqual(['One here.'])
    expect(speech().speaking).toBe(false)
    a.remove()
  })

  it('a gap abandoned by a stop cannot fire into a LATER reading', () => {
    /* ⚠️ **FOUND BY MUTATION, NOT BY DESIGN.** `clearGap()` in `stop` looked
       defensive — the timer checks `readingRef` when it fires, so a stopped
       reading stays silent and removing the clear failed nothing. But the timer
       is still PENDING, and starting again makes `readingRef` true: the stale
       gap then fires into the new reading and speaks the sentence it was going
       to say, cutting off the one that had just begun. Clearing it is what makes
       the two readings independent. */
    const a = section(TWO)
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 300, paragraphGapMs: 900 } })
    act(() => speech().start())
    ends()
    act(() => speech().stop())
    act(() => speech().start())
    expect(spoken()).toEqual(['One here.', 'One here.'])
    act(() => vi.advanceTimersByTime(5000))
    expect(spoken()).toEqual(['One here.', 'One here.'])
    a.remove()
  })

  it('a pause during the gap holds it, and resume picks the sentence up', () => {
    /* ⚠️ **AND THE ENGINE IS NOT TOUCHED WHILE IN A GAP.**
       `speechSynthesis.pause()` sets a flag on the ENGINE, so pausing here and
       then queueing the held sentence would queue it behind a paused engine and
       it would never start. */
    const a = section(TWO)
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 300, paragraphGapMs: 900 } })
    act(() => speech().start())
    ends()
    act(() => speech().pause())
    expect(speech().paused).toBe(true)
    expect(synth.paused).toBe(false)
    act(() => vi.advanceTimersByTime(5000))
    expect(spoken()).toEqual(['One here.'])

    act(() => speech().resume())
    expect(spoken()).toEqual(['One here.', 'Two there.'])
    expect(speech().paused).toBe(false)
    a.remove()
  })

  it('a step during the pause goes where the reader asked, not where the gap was going', () => {
    const a = section(TWO)
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 300, paragraphGapMs: 900 } })
    act(() => speech().start())
    ends()
    act(() => speech().stepParagraph(1))
    expect(spoken()).toEqual(['One here.', 'Three everywhere.'])
    /* The abandoned gap must not fire a second utterance behind it. */
    act(() => vi.advanceTimersByTime(5000))
    expect(spoken()).toEqual(['One here.', 'Three everywhere.'])
    a.remove()
  })

  it('still crosses to the next section after the last sentence', () => {
    const a = section('Only this.')
    const { speech, next } = mount(a.doc, { prefs: { sentenceGapMs: 300, paragraphGapMs: 900 } })
    act(() => speech().start())
    ends()
    /* No sentence to wait for, so the section-end walk starts without a gap. */
    expect(next).toHaveBeenCalledTimes(1)
    a.remove()
  })
})

describe('a reading that ends while paused', () => {
  /**
   * ⚠️ **`cancel()` EMPTIES THE QUEUE AND LEAVES THE ENGINE'S PAUSE FLAG SET**, and
   * `paused` belongs to the ENGINE rather than to an utterance — `FakeSynth`
   * models both, which is what makes these provable without a browser. So every
   * way a reading can end had to normalise it, and four paths had diverged:
   * `finish` never touched `paused` or the engine, closing the book left both,
   * and unmount left everything.
   */
  it('speaks again after pause then stop then start', () => {
    const a = section('One here. Two there.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().pause())
    expect(synth.paused).toBe(true)

    act(() => speech().stop())
    /* THE WHOLE BUG: without this the engine stays paused, the next utterance is
       queued behind it and never spoken, and every control reports playback. */
    expect(synth.paused).toBe(false)

    act(() => speech().start())
    expect(spoken()).toEqual(['One here.', 'One here.'])
    expect(speech().speaking).toBe(true)
    expect(speech().paused).toBe(false)
    a.remove()
  })

  it('clears paused when the engine fails mid-sentence', () => {
    const a = section('One here. Two there.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().pause())
    act(() => {
      synth.queued[0]?.dispatchEvent(new Event('error'))
    })
    /* `{ speaking: false, paused: true }` is a state the public type defines as
       "paused mid-sentence", and there is no sentence. */
    expect(speech().speaking).toBe(false)
    expect(speech().paused).toBe(false)
    expect(synth.paused).toBe(false)
    a.remove()
  })

  it('clears paused when the book closes', () => {
    const a = section('One here. Two there.')
    const { speech, show } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().pause())
    show(null)
    expect(speech().speaking).toBe(false)
    expect(speech().paused).toBe(false)
    expect(synth.paused).toBe(false)
    a.remove()
  })
})

describe('pausing between two sections', () => {
  /**
   * ⚠️ **THERE IS NO LIVE UTTERANCE WHILE THE WALK LOOKS FOR THE NEXT SECTION**, so
   * `speaker.pause()` had nothing to pause and returned quietly while
   * `setPaused(true)` said it had worked — and `continueReading`'s timer went on
   * turning pages under a reader who had asked for silence.
   */
  it('stops the pages turning, and resume starts the walk again', () => {
    const a = section('Only this.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    ends()
    expect(next).toHaveBeenCalledTimes(1)

    act(() => speech().pause())
    expect(speech().paused).toBe(true)
    act(() => vi.advanceTimersByTime(CONTINUE_TICK_MS * 4))
    expect(next).toHaveBeenCalledTimes(1)

    act(() => speech().resume())
    expect(speech().paused).toBe(false)
    act(() => vi.advanceTimersByTime(CONTINUE_TICK_MS))
    expect(next.mock.calls.length).toBeGreaterThan(1)
    a.remove()
  })

  it('does not let the walk run out its grace while held', () => {
    /* The grace is what ends a reading at the end of the book. Counted over a
       pause it would end the reading on the reader's own hold. */
    const a = section('Only this.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    ends()
    act(() => speech().pause())
    act(() => vi.advanceTimersByTime(CONTINUE_GRACE_MS * 3))
    expect(speech().speaking).toBe(true)
    a.remove()
  })
})

/**
 * Which chapter steps the book offers, per direction.
 *
 * ⚠️ **NOTHING DREW THIS, AND IT IS WHAT THE TRANSPORT'S TWO BUTTONS ARE.** The
 * pair used to be one boolean meaning "at least one direction exists", so the
 * first chapter of every book drew a Previous control that went nowhere and the
 * last drew a Next one — the exact defect at the two places a reader is most
 * likely to be.
 */
describe('the chapter steps a book offers', () => {
  it('answers for each direction on its own', () => {
    const a = section('One.')
    const { speech } = mount(a.doc, { chapters: true, can: (by) => by === -1 })
    expect(speech().chapters).toEqual({ back: true, forward: false })
    a.remove()
  })

  it('offers neither where the book cannot place the reader at all', () => {
    /* No `chapter` — a book whose current spine item no contents entry points
       at. The answer is two falses rather than an absence, because the control
       reads booleans. */
    const a = section('One.')
    const { speech } = mount(a.doc)
    expect(speech().chapters).toEqual({ back: false, forward: false })
    a.remove()
  })

  it('follows the book when the answer changes under it', () => {
    let first = true
    const a = section('One.')
    const { speech, show } = mount(a.doc, { chapters: true, can: (by) => (first ? by === 1 : true) })
    expect(speech().chapters).toEqual({ back: false, forward: true })

    first = false
    act(() => show(a.doc))
    expect(speech().chapters, 'a chapter in, both directions exist').toEqual({
      back: true,
      forward: true,
    })
    a.remove()
  })
})

describe('the document it reads', () => {
  it('is the one it was last given, not the one it opened with', () => {
    /* The refs the engine's callbacks read are written in a layout effect, and
       an effect that stopped writing them would leave every callback — and
       `start` itself — reading the document the tree first showed. */
    const a = section('First section.')
    const b = section('Second section.')
    const { speech, show } = mount(a.doc)
    act(() => show(b.doc))
    act(() => speech().start())
    expect(spoken()).toEqual(['Second section.'])
    a.remove()
    b.remove()
  })

  it('drops a pending sentence gap when the section changes under it', () => {
    /* ⚠️ A gap is a timer holding an INDEX into the plan of the section that
       set it. Left running across a section change it speaks that index out of
       the new section — the wrong words, in the right voice, with nothing to
       say what happened. */
    const a = section('One. Two.')
    const b = section('Next one. And more.')
    const { speech, show } = mount(a.doc, { prefs: { sentenceGapMs: 300 } })
    act(() => speech().start())
    ends()
    expect(spoken(), 'the gap is holding the second sentence').toEqual(['One.'])

    act(() => show(b.doc))
    expect(spoken()).toEqual(['One.', 'Next one.'])
    act(() => vi.advanceTimersByTime(2000))
    expect(spoken(), 'and the abandoned gap says nothing at all').toEqual(['One.', 'Next one.'])
    a.remove()
    b.remove()
  })

  it('says nothing more when the reader stops during a gap', () => {
    const a = section('One. Two.')
    const { speech } = mount(a.doc, { prefs: { sentenceGapMs: 300 } })
    act(() => speech().start())
    ends()
    act(() => speech().stop())
    act(() => vi.advanceTimersByTime(2000))
    expect(spoken()).toEqual(['One.'])
    expect(speech().speaking).toBe(false)
    a.remove()
  })
})

/**
 * The reader's note preference reaches the walk that collects the words.
 *
 * ⚠️ **ONE VALUE, NOT TWO DEFAULTS.** `collectText` decides what a note is; the
 * hook decides whether this reader wants it read; and the audiobook export reads
 * the same preference, so what is spoken and what is written are one answer.
 */
describe('notes in the reading', () => {
  const withNote = 'He left.<span epub:type="footnote">A note.</span>Then she stayed.'

  it('leaves a note body out unless the reader asked for it', () => {
    const a = section(withNote)
    const { speech } = mount(a.doc)
    act(() => speech().start())
    expect(spoken().join(' ')).not.toContain('A note')
    a.remove()
  })

  it('reads the note body when the reader did ask', () => {
    const a = section(withNote)
    const { speech } = mount(a.doc, { prefs: { notesAloud: true } })
    act(() => speech().start())
    expect(spoken().join(' ')).toContain('A note')
    a.remove()
  })

  it('reads a book with no preferences at all', () => {
    /* `prefs` is optional — a host that passes none must not be a crash, which
       is what reading through the object rather than around it would be. */
    const a = section('One.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    expect(spoken()).toEqual(['One.'])
    a.remove()
  })
})

describe('the controls with no engine behind them', () => {
  /* ⚠️ **A BUILD WITH NO SPEECH ENGINE STILL RENDERS THE CONTROLS**, disabled —
     and a disabled control is still a control somebody can reach by keyboard or
     by a stale command. Every one of them has to be a no-op rather than a throw.
  */
  it('does nothing, and throws nothing, without one', () => {
    delete (window as { speechSynthesis?: unknown }).speechSynthesis
    const a = section('One.')
    const { speech } = mount(a.doc)
    expect(speech().available).toBe(false)
    act(() => {
      speech().start()
      speech().pause()
      speech().resume()
      speech().stop()
      speech().stepSentence(1)
      speech().stepParagraph(-1)
      speech().stepChapter(1)
    })
    expect(speech().speaking).toBe(false)
    a.remove()
  })
})

describe('the reading and the component it lives in', () => {
  it('ends when the component goes away, because the engine does not', () => {
    /* Speech is a property of the window: an utterance outlives an unmount and
       would go on reading a book whose reader has closed it. */
    const a = section('One. Two.')
    const { speech, unmount } = mount(a.doc)
    act(() => speech().start())
    const cancelled = synth.cancelled
    act(() => unmount())
    expect(synth.cancelled, 'the engine was stopped on the way out').toBe(cancelled + 1)
    a.remove()
  })
})

/**
 * `heldContinuation` says the reader paused a walk between sections rather than
 * a sentence, and `resume` reads it to decide which one to pick up.
 *
 * ⚠️ **LEFT SET, IT SENDS THE NEXT RESUME DOWN THE WRONG ROAD.** The engine is
 * never released, the reading stays silent, and the transport goes on showing a
 * reading in progress — so both places that clear the flag are load-bearing.
 */
describe('the flag that says what was paused', () => {
  it('is not carried from a reading that ended into the next one', () => {
    const a = section('Only this.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    ends()
    act(() => speech().pause())
    act(() => speech().stop())

    act(() => speech().start())
    act(() => speech().pause())
    expect(synth.paused, 'the engine itself is what was paused this time').toBe(true)
    act(() => speech().resume())
    expect(synth.paused, 'so resuming has to release it').toBe(false)
    a.remove()
  })

  it('is not carried from one held walk to the next pause', () => {
    const a = section('Only this.')
    const b = section('And this. With more.')
    const { speech, show } = mount(a.doc)
    act(() => speech().start())
    ends()
    act(() => speech().pause())
    act(() => speech().resume())

    act(() => show(b.doc))
    act(() => speech().pause())
    expect(synth.paused).toBe(true)
    act(() => speech().resume())
    expect(synth.paused, 'the second pause was the engine, and is released').toBe(false)
    a.remove()
    b.remove()
  })
})

describe('a section the segmenter finds no sentence in', () => {
  /* Written from its code point: an escape typed into an edit arrives as the
     character itself, and a soft hyphen in a source file is invisible. */
  const SOFT = String.fromCodePoint(0xad)

  it('is spoken whole, and a boundary in it places nothing', () => {
    /* ⚠️ A soft hyphen is neither whitespace nor content, so the text is not
       empty and the plan is. `speakDocument` hands the engine the collected text
       so the section still reports done and the walk goes on — and a boundary on
       THAT utterance has no sentence to rebase against. */
    const a = section(SOFT)
    const { speech } = mount(a.doc)
    act(() => speech().start())
    expect(synth.queued.length, 'the section went to the engine').toBe(1)

    /* ⚠️ **AND THE FOLLOW-ALONG STILL WORKS THERE.** The boundary's index is an
       offset into what was spoken, which here is the whole text — so the band is
       drawn from it like any other. It used to be dropped: the handler looked
       the sentence up by cursor, found none, and returned, so such a section
       read with no highlight at all and nothing said why. */
    boundary(0, 1)
    expect(a.doc.getElementById('paper-spoken-word'), 'the word is followed').not.toBeNull()
    expect(speech().speaking).toBe(true)
    a.remove()
  })
})

describe('a step with nowhere to go', () => {
  it('leaves the walk that crosses sections alone', () => {
    /* ⚠️ Forward off the END of a section is not "do nothing to the reading" —
       the continuation is what carries it into the next section, and the press
       must not tear that down. It used to: the cursor answered null, the move
       ran anyway, and a reader pressing forward at a section boundary stopped
       the reading with `speaking` still true and no timer left to wake it. */
    const a = section('Only this.')
    const { speech, next } = mount(a.doc)
    act(() => speech().start())
    ends()
    expect(next).toHaveBeenCalledTimes(1)

    act(() => speech().stepSentence(1))
    act(() => vi.advanceTimersByTime(CONTINUE_TICK_MS * 2))
    expect(next.mock.calls.length, 'the walk is still walking').toBeGreaterThan(1)
    expect(spoken(), 'and nothing was spoken twice').toEqual(['Only this.'])
    a.remove()
  })

  it('says nothing when the reader steps after stopping', () => {
    /* ⚠️ The plan OUTLIVES the reading — it is cleared when the document
       changes, not when the reader stops — so a step that only checked for one
       would find everything it needs and speak into a stopped reading. */
    const a = section('One. Two.')
    const { speech } = mount(a.doc)
    act(() => speech().start())
    act(() => speech().stop())

    act(() => speech().stepSentence(1))
    act(() => speech().stepParagraph(1))
    expect(spoken()).toEqual(['One.'])
    expect(speech().speaking).toBe(false)
    a.remove()
  })
})

describe('reading on a downloaded voice', () => {
  /** A pack that reads English, installed. */
  const ENGLISH: VoicePack = {
    id: 'english-kokoro',
    name: 'English',
    summary: '',
    family: 'kokoro',
    languages: ['en'],
    bytes: 1,
    minimumMemoryGb: 4,
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
    installed: true,
  }

  /** An engine whose renders the case controls. */
  function downloaded(packs: readonly VoicePack[]) {
    const host = new FakeAudioHost()
    const asked: string[] = []
    const engine: ReadingEngine = {
      packs: () => packs,
      host: () => host,
      render: async (request) => {
        asked.push(request.text)
        return { pcm: pcmOf(2_400), sampleRate: 24_000, words: [], skipped: [] }
      },
    }
    return { engine, asked, host }
  }

  it('reads a book the pack can read through the engine, not the platform', async () => {
    /* ⚠️ THE WIRING ITSELF, which nothing else here touches: every other case
     * in this file drives the platform speaker, so the router could have been
     * absent and all of them would still pass. */
    const { engine, asked, host } = downloaded([ENGLISH])
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(asked).toEqual(['Hello there.'])
    expect(host.sources).toHaveLength(1)
    expect(synth.queued).toHaveLength(0)
    unmount()
    page.remove()
  })

  it('renders the NEXT sentence while this one is being read', async () => {
    /* ⚠️ **THE LOOK-AHEAD EXISTED AND NOTHING ASKED FOR IT.** `EngineSpeaker`
       has had `prepare` since it landed — *"so the gap between them is a gap
       and not a wait"* — and `routedSpeaker` forwards it, and no production
       caller ever called either. Measured in the running app on 2026-09-23
       with the sentence gap at zero, a boundary still cost about 2.3 s, most of
       it the next sentence's render. This case is what keeps that wired. */
    const { engine, asked } = downloaded([ENGLISH])
    const page = section('Hello there. And then this. And a third.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    /* The spans carry their trailing space — a sentence ends where the next
       one begins — so these are the exact strings the engine is handed. */
    expect(asked, 'the second sentence is asked for before it is needed').toEqual([
      'Hello there. ',
      'And then this. ',
    ])
    unmount()
    page.remove()
  })

  it('asks for no look-ahead past the last sentence', async () => {
    const { engine, asked } = downloaded([ENGLISH])
    const page = section('Only one.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(asked).toEqual(['Only one.'])
    unmount()
    page.remove()
  })

  it('reads a book no pack can read through the platform', async () => {
    const { engine, asked } = downloaded([ENGLISH])
    const page = section('Bonjour.', 'fr')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(asked).toEqual([])
    expect(synth.queued).toHaveLength(1)
    unmount()
    page.remove()
  })

  it('reads through the platform when no engine was given at all', async () => {
    // A build without the voices capability — a phone, a browser client —
    // reads exactly as it did before.
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc)
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(synth.queued).toHaveLength(1)
    unmount()
    page.remove()
  })
})
