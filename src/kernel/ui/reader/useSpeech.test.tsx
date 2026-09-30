// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'
import { FakeAudioHost, pcmOf } from './enginePlayer.testkit'
import type { SpeechRequest, SpokenAudio, VoicePack } from '../../core/ports'
import {
  CONTINUE_GRACE_MS,
  CONTINUE_TICK_MS,
  POSITION_TICK_MS,
  TURN_SETTLE_MS,
  NOWHERE_IN_PARTICULAR,
  refusalFor,
  useSpeech,
  type ReadingEngine,
  type Speech,
  type SpeechPlace,
} from './useSpeech'
import { textDigest } from './clipKey'
import { canonicalTextOf } from './passageText'
import { Speaker, collectText, type SpeakPrefs } from './speech'

/** Where the reader is before anything has resolved — the app's first render. */
const NOWHERE: SpeechPlace = { bookId: null, sectionIndex: null }

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
    prefs = {},
    engine = null,
    place = NOWHERE,
  }: {
    chapters?: boolean
    lands?: boolean
    /** Which book and section is on screen — see `SpeechPlace`. */
    place?: SpeechPlace
    /** Asked per direction, and per render — the transport draws each button
     *  from its own answer, and a book answers differently at either end. */
    can?: (by: -1 | 1) => boolean
    prefs?: SpeakPrefs
    /** The downloaded voices, where a case is about routing to them. */
    engine?: ReadingEngine | null
  } = {},
) {
  const next = vi.fn()
  /* Back one page, which only a backward SEEK ever asks for — see the case that
     pins a reader's forward peek against it. */
  const prev = vi.fn()
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
      chapters ? { next, prev, chapter: { can: can ?? (() => lands), go: chapter } } : { next, prev },
      prefs,
      engine,
      place,
    )
    return null
  }
  const view = render(<Probe doc={doc} />)
  return {
    next,
    prev,
    chapter,
    speech: () => api.current!,
    show: (doc: Document | null) => view.rerender(<Probe doc={doc} />),
    /**
     * Change where the reader is AFTER the first render, which is what the app
     * does — `bookId` is a content hash that resolves asynchronously and
     * `docSection` arrives with the document.
     */
    moveTo: (next: SpeechPlace, at: Document | null = doc) => {
      place = next
      view.rerender(<Probe doc={at} />)
    },
    /**
     * Change the reader's preferences AFTER the first render, which is what the
     * app does — a reader turning notes on or changing the voice mid-book.
     */
    setPrefs: (next: SpeakPrefs, at: Document | null = doc) => {
      prefs = next
      view.rerender(<Probe doc={at} />)
    },
    /**
     * Supply the downloaded voices AFTER the first render, which is what the app
     * does — `useVoicePacks` says in its own words that the port *"binds during
     * `start`, which can land after this hook's first render"*.
     */
    setEngine: (next: ReadingEngine | null, at: Document | null = doc) => {
      engine = next
      view.rerender(<Probe doc={at} />)
    },
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
    const { speech, next, prev } = mount(a.doc)
    act(() => speech().start())
    a.wordAt(-500)
    boundary(0, 7)
    expect(next).not.toHaveBeenCalled()
    /* ⚠️ **AND NOT BACKWARDS EITHER, WHICH IS WHAT PHASE 34 PUT AT RISK.** The
       page can be turned back now, and turning it here would fight the reader for
       it — they are the ones who moved. What makes the two tellable apart is that
       no seek happened; the case below is the same word in the same place with a
       seek in front of it. */
    expect(prev, 'their page, not the voice’s').not.toHaveBeenCalled()
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
  function downloaded(packs: readonly VoicePack[], words: SpokenAudio['words'] = []) {
    const host = new FakeAudioHost()
    const asked: string[] = []
    const requests: SpeechRequest[] = []
    const engine: ReadingEngine = {
      packs: () => packs,
      host: () => host,
      render: async (request) => {
        asked.push(request.text)
        requests.push(request)
        return {
          pcm: pcmOf(2_400),
          sampleRate: 24_000,
          words,
          skipped: [],
          evicted: { clips: 0, bytes: 0 },
          clipPath: '/tmp/audio/clips/x.wav',
        }
      },
    }
    return { engine, asked, requests, host }
  }

  it('reads through the engine when the port bound after the first render', async () => {
    /* ⚠️ **THE ROUTER USED TO BE BUILT ONLY IF AN ENGINE WAS ALREADY THERE, AND
     * THE MEMO NEVER RE-RAN — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.**
     * `useVoicePacks` says in its own words that the port *"binds during `start`,
     * which can land after this hook's first render"*, so whether a reader with a
     * pack installed got any of this phase depended on which of the two happened
     * first. When it lost: `speakDocument` reads the LIVE packs to choose its
     * unit, picked `'section'`, and handed a whole chapter to Web Speech — no
     * scrubber, no tap-to-seek, sentence steps re-speaking instead of seeking,
     * and nothing failing anywhere.
     *
     * This is the case the fix exists for, and the only one in this file that
     * mounts without an engine and then supplies one. */
    const { engine, asked, host } = downloaded([ENGLISH])
    const page = section('Hello there.', 'en')
    const { speech, setEngine, unmount } = mount(page.doc, { engine: null })

    setEngine(engine)
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })

    expect(asked, 'the engine read it').toEqual(['Hello there.'])
    expect(host.sources, 'through Web Audio').toHaveLength(1)
    expect(synth.queued, 'and Web Speech was never asked').toHaveLength(0)
    /* AND THE PHASE'S OWN SURFACE IS THERE, which is what the reader loses when
       a section is routed to the platform speaker: the engine can report a
       position and seek, and Web Speech can do neither. `at` arrives on the
       position tick, so the SPEAKER is asked directly — which is also the
       stronger claim, since it is what `at` is read from. */
    expect(speech().seekToFraction(0.5), 'the section can be seeked').toBe(true)
    unmount()
    page.remove()
  })

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

  it('renders the WHOLE section once, and nothing ahead of it', async () => {
    /* ⚠️ **THE LOOK-AHEAD THAT USED TO BE ASSERTED HERE IS DELETED, AND THIS IS
       WHAT REPLACED IT.** The engine is handed the whole section in one request —
       one render, kept on disk, one `words` array — and nothing renders anything
       the reader has not asked for. The owner's decision on 2026-09-30, against
       WI-34.0's measurements: the whole section and no render-ahead. */
    const { engine, asked } = downloaded([ENGLISH])
    const page = section('Hello there. And then this. And a third.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(asked, 'one request, for the whole section').toEqual([
      'Hello there. And then this. And a third.',
    ])
    unmount()
    page.remove()
  })

  it('names the book, the section and the canonical text in the request', async () => {
    /* ⚠️ THE KEY IS WHAT MAKES THE ARTIFACT FINDABLE NEXT TIME, and the digest is
       over `indexText`'s CANONICAL form rather than over the collected text — the
       same walk phase 31 indexes, so the audio key and the search index cannot
       disagree about what a section says. */
    const { engine, requests } = downloaded([ENGLISH])
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc, {
      engine,
      place: { bookId: 'book:a', sectionIndex: 7 },
    })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(requests[0]?.clip).toEqual({
      bookId: 'book:a',
      section: 7,
      textDigest: textDigest(canonicalTextOf(page.doc)),
    })
    unmount()
    page.remove()
  })

  it('carries an empty book and section where the reader is nowhere in particular', async () => {
    /* A key naming no book simply never matches a stored clip, so the section is
       rendered — which is the safe direction, and better than a throw for a
       bookkeeping slip. */
    const { engine, requests } = downloaded([ENGLISH])
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(requests[0]?.clip.bookId).toBe('')
    /* ⚠️ **NULL AND NOT `-1`.** A sentinel was here, and the plugin's `section` is
       a `u32` — so every Listen in the real app died at the IPC boundary with
       *"invalid value: integer `-1`, expected u32"* while this very case passed.
       Found by looking at the running app on 2026-09-30, which is what WI-34.6 is
       for. A value the caller may genuinely not have is null. */
    expect(requests[0]?.clip.section).toBeNull()
    unmount()
    page.remove()
  })

  it('still gives the PLATFORM speaker one sentence at a time', async () => {
    /* ⚠️ **THE TWO UNITS, AND BOTH ARE RIGHT.** Web Speech cannot seek inside an
       utterance, so a section-long one there would take `stepSentence`,
       `stepParagraph` and both gap settings with it. A French book no pack can
       read goes to the platform, and it is still sentence-at-a-time. */
    const { engine, asked } = downloaded([ENGLISH])
    const page = section('Bonjour. Et puis ceci.', 'fr')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(asked, 'the engine is not asked at all').toEqual([])
    expect(spoken()).toEqual(['Bonjour.'])
    unmount()
    page.remove()
  })

  it('steps a sentence by SEEKING, not by rendering again', async () => {
    /* ⚠️ THE REASON FOR ALL OF IT. The step used to cancel the utterance and
       speak a different sentence, which on an engine voice is a whole render per
       press — seconds of silence for a button a reader taps repeatedly. */
    const words = [
      { start: 0, length: 5, startMs: 10, endMs: 40 },
      { start: 6, length: 6, startMs: 50, endMs: 90 },
      { start: 13, length: 3, startMs: 60, endMs: 80 },
      { start: 17, length: 4, startMs: 70, endMs: 95 },
    ]
    const { engine, asked, host } = downloaded([ENGLISH], words)
    const page = section('Hello there. And then this.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(asked).toHaveLength(1)
    const sources = host.sources.length
    act(() => speech().stepSentence(1))
    expect(asked, 'nothing is rendered again').toHaveLength(1)
    expect(host.sources.length, 'a seek is a new source over the same buffer').toBe(sources + 1)
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

describe('where the reader is, read at speak time', () => {
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

  function downloaded() {
    const host = new FakeAudioHost()
    const requests: SpeechRequest[] = []
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: async (request) => {
        requests.push(request)
        return {
          pcm: pcmOf(2_400),
          sampleRate: 24_000,
          words: [],
          skipped: [],
          evicted: { clips: 0, bytes: 0 },
          clipPath: '/tmp/audio/clips/x.wav',
        }
      },
    }
    return { engine, requests }
  }

  it('takes the place as of the Listen, not as of the first render', async () => {
    /* ⚠️ **THE DEFECT THAT KILLED READING ALOUD OUTRIGHT — FOUND BY DRIVING THE
       RUNNING APP, 2026-09-30, AND BY NOTHING ELSE.** `place` was read from
       `speakDocument`'s closure, whose dependency list is `[speaker,
       speakSentence]` — so it was the value at the FIRST render, where `bookId` is
       null (`bookIdFor` resolves a content hash asynchronously) and `docSection`
       is null (no document has loaded). Every clip key carried an empty book and
       no section, the plugin refused it, and every Listen ended with "This chapter
       could not be made into audio".

       Every case that existed supplied its place at mount and never changed it,
       which is why 3 007 of them passed over it. This one changes it, which is
       what the app does. */
    const { engine, requests } = downloaded()
    const page = section('Hello there.', 'en')
    const { speech, unmount, moveTo } = mount(page.doc, { engine })
    /* The place resolves after mount, exactly as the app's does. */
    moveTo({ bookId: 'book:resolved-later', sectionIndex: 8 })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(requests[0]?.clip.bookId).toBe('book:resolved-later')
    expect(requests[0]?.clip.section).toBe(8)
    unmount()
    page.remove()
  })

  it('takes the place as of EACH section, not as of the reading’s start', async () => {
    /* A reading walks many sections and the index changes with every one — the
       same reason `prefsRef` is read per utterance rather than captured. */
    const { engine, requests } = downloaded()
    const first = section('The first one.', 'en')
    const second = section('The second one.', 'en')
    const { speech, unmount, moveTo } = mount(first.doc, { engine })
    moveTo({ bookId: 'book:a', sectionIndex: 3 })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      moveTo({ bookId: 'book:a', sectionIndex: 4 }, second.doc)
      await Promise.resolve()
    })
    expect(requests.map((r) => r.clip.section)).toEqual([3, 4])
    unmount()
    first.remove()
    second.remove()
  })
})

describe('a tap on a word in the book', () => {
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

  /** Words over `Hello there. And then this.` — enough to seek between. */
  const WORDS = [
    { start: 0, length: 5, startMs: 100, endMs: 300 },
    { start: 6, length: 6, startMs: 400, endMs: 600 },
    { start: 13, length: 3, startMs: 700, endMs: 900 },
    { start: 17, length: 4, startMs: 1000, endMs: 1200 },
  ]

  function downloaded() {
    const host = new FakeAudioHost()
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: async () => ({
        /* ⚠️ **TWO SECONDS, BECAUSE THE TIMINGS RUN TO 1.2 s.** `pcmOf(2_400)` at
           24 kHz is a tenth of a second, and `seekToMs` CLAMPS to the buffer — so
           every seek in this block landed at 100 ms and the case read as a wrong
           word rather than as a fixture whose audio was shorter than its own word
           list. A test whose sound and timings disagree cannot measure a seek. */
        pcm: pcmOf(48_000),
        sampleRate: 24_000,
        words: WORDS,
        skipped: [],
        evicted: { clips: 0, bytes: 0 },
        clipPath: '/tmp/audio/clips/x.wav',
      }),
    }
    return { engine, host }
  }

  /**
   * A reading in progress, with the book's caret lookup under this test's
   * control — jsdom has neither `caretRangeFromPoint` nor
   * `caretPositionFromPoint`, so the one the app uses is supplied here.
   */
  async function reading(at: (x: number, y: number) => { node: Node; offset: number } | null) {
    const { engine, host } = downloaded()
    const page = section('Hello there. And then this.', 'en')
    ;(page.doc as unknown as { caretRangeFromPoint: unknown }).caretRangeFromPoint = (
      x: number,
      y: number,
    ) => {
      const found = at(x, y)
      return found ? { startContainer: found.node, startOffset: found.offset } : null
    }
    const mounted = mount(page.doc, { engine })
    act(() => mounted.speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    return { ...mounted, page, host }
  }

  /** The first text node of the section, which is where every word here is. */
  const textOf = (doc: Document): Node => doc.body.querySelector('p')!.firstChild!

  it('puts the voice where the reader tapped', async () => {
    /* ⚠️ **THE THIRD OF WI-34.3's THREE SEEKS, AND THE ONE THAT WAS NOT
       EXPRESSIBLE BEFORE.** An utterance used to be a SENTENCE, so an offset
       elsewhere in the section named a position in no buffer that existed. */
    const { page, host, unmount } = await reading(() => ({ node: textOf(page.doc), offset: 17 }))
    const before = host.sources.length
    await act(async () => {
      page.doc.body.dispatchEvent(new page.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    })
    expect(host.sources.length, 'a seek is a new source over the same buffer').toBe(before + 1)
    expect(host.latest.started[0]?.offset).toBeCloseTo(1.0, 3)
    unmount()
    page.remove()
  })

  it.each([
    ['a modified click is the platform’s', { metaKey: true }],
    ['and so is a Shift one', { shiftKey: true }],
    ['a secondary button is not a tap', { button: 2 }],
  ])('refuses: %s', async (_why, init) => {
    const { page, host, unmount } = await reading(() => ({ node: textOf(page.doc), offset: 17 }))
    const before = host.sources.length
    await act(async () => {
      page.doc.body.dispatchEvent(
        new page.doc.defaultView!.MouseEvent('click', { bubbles: true, ...init }),
      )
    })
    expect(host.sources.length).toBe(before)
    unmount()
    page.remove()
  })

  it('refuses a click somebody else has already taken', async () => {
    /* `defaultPrevented` is how a plate and a footnote say they took it —
       `ReaderSession.#watchPlates` gives way the same way. */
    const { page, host, unmount } = await reading(() => ({ node: textOf(page.doc), offset: 17 }))
    const before = host.sources.length
    await act(async () => {
      const event = new page.doc.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true })
      event.preventDefault()
      page.doc.body.dispatchEvent(event)
    })
    expect(host.sources.length).toBe(before)
    unmount()
    page.remove()
  })

  it('refuses a tap on text the voice does not read', async () => {
    /* A hidden note has nowhere in the sound to go, so a tap must do nothing
       rather than land somewhere plausible. */
    const { page, host, unmount } = await reading(() => ({
      node: page.doc.createTextNode('not collected'),
      offset: 0,
    }))
    const before = host.sources.length
    await act(async () => {
      page.doc.body.dispatchEvent(new page.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    })
    expect(host.sources.length).toBe(before)
    unmount()
    page.remove()
  })

  it('refuses when there is no caret under the point', async () => {
    const { page, host, unmount } = await reading(() => null)
    const before = host.sources.length
    await act(async () => {
      page.doc.body.dispatchEvent(new page.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    })
    expect(host.sources.length).toBe(before)
    unmount()
    page.remove()
  })

  it('does nothing at all when no reading is under way', async () => {
    /* ⚠️ THE LISTENER IS ONLY INSTALLED WHILE SPEAKING, which is what keeps this
       from being a gesture the reader has to know about: with nothing being read
       a tap does exactly what it always did. */
    const { engine, host } = downloaded()
    const page = section('Hello there. And then this.', 'en')
    let asked = 0
    ;(page.doc as unknown as { caretRangeFromPoint: unknown }).caretRangeFromPoint = () => {
      asked += 1
      return null
    }
    const { unmount } = mount(page.doc, { engine })
    await act(async () => {
      page.doc.body.dispatchEvent(new page.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    })
    expect(asked, 'the caret is not even looked for').toBe(0)
    expect(host.sources).toHaveLength(0)
    unmount()
    page.remove()
  })
})

describe('five defects an independent audit found', () => {
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
  const WORDS = [
    { start: 0, length: 5, startMs: 100, endMs: 300 },
    { start: 6, length: 6, startMs: 400, endMs: 600 },
    { start: 13, length: 3, startMs: 700, endMs: 900 },
    { start: 17, length: 4, startMs: 1000, endMs: 1200 },
  ]

  function downloaded(words: SpokenAudio['words'] = WORDS) {
    const host = new FakeAudioHost()
    const texts: string[] = []
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: async (request) => {
        texts.push(request.text)
        return {
          pcm: pcmOf(48_000),
          sampleRate: 24_000,
          words,
          skipped: [],
          evicted: { clips: 0, bytes: 0 },
          clipPath: '/tmp/audio/clips/x.wav',
        }
      },
    }
    return { engine, host, texts }
  }

  it('reads the notes choice as of the SECTION, not as of the first render', async () => {
    /* ⚠️ **THE SAME DEFECT THE IN-APP RUN FOUND IN `place`, THREE LINES AWAY.**
       `speakDocument`'s dependency list is `[speaker, speakSentence]`, so a
       captured `prefs` is the value at the render that built it — a reader
       turning notes on mid-book got the old choice for every remaining section.
       Observed through the TEXT the engine is handed, which is what the skip
       choice decides. */
    const { engine, texts } = downloaded()
    const page = section('Hello there.', 'en')
    const note = page.doc.createElement('aside')
    note.setAttribute('epub:type', 'footnote')
    note.textContent = 'A note nobody asked for.'
    page.doc.body.append(note)

    const { speech, setPrefs, unmount } = mount(page.doc, {
      engine,
      prefs: { notesAloud: false },
    })
    act(() => setPrefs({ notesAloud: true }))
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(texts[0], 'the choice as of the Listen, not as of the mount').toContain(
      'A note nobody asked for.',
    )
    unmount()
    page.remove()
  })

  /**
   * A reading that has reached the end of its section and is walking pages for
   * the next one — which is the ONLY state in which tearing down the pending
   * work is observable.
   *
   * ⚠️ **THREE CASES BELOW FIRST ASSERTED THIS FROM MID-SECTION AND PROVED
   * NOTHING**, because with no gap and no continuation running there is nothing
   * for a premature `clearGap()`/`clearContinuation()` to destroy. Hand-applying
   * the defect is what showed it: the suite stayed green. The walk has to be
   * RUNNING for its loss to be visible.
   */
  async function atASectionBoundary(words: SpokenAudio['words']) {
    const { engine, host } = downloaded(words)
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    const mounted = mount(page.doc, { engine })
    act(() => mounted.speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    /* The sound runs out, which is the section ending — `onDone('ended')` hands
       over to `continueReading`, and from here `next` is asked once a tick until
       the grace runs out and the reading finishes. */
    await act(async () => {
      host.latest.end()
      await Promise.resolve()
    })
    mounted.next.mockClear()
    return { ...mounted, page, host }
  }

  it('a step on a reading with no word timings changes nothing at all', async () => {
    /* ⚠️ **QWEN REPORTS NO WORD TIMINGS AT ALL, SO EVERY STEP ANSWERS FALSE** —
       a Chinese reading can be scrubbed and cannot be stepped. What a press must
       not do is look like it worked.
 
       ⚠️ **AND THE OTHER HALF OF THE AUDIT'S FINDING IS UNREACHABLE ON THIS UNIT
       TODAY, WHICH IS WORTH WRITING DOWN RATHER THAN LEAVING AS A PASSING
       TEST.** It said a failed step also tears down the pending work. It cannot:
       a gap belongs to the PLATFORM's sentence unit, and a section continuation
       runs only after `continueReading` has set `spokenRef` to null — where
       `stepBy` returns at its first guard. `seekToOffset` is asked before either
       clear all the same, because `stepChapter` above has the same order for a
       reason that IS observable, and one shape is cheaper to keep right than two.
       Hand-applied 2026-09-30: the suite stays green with the order reversed,
       which is exactly what an unreachable branch looks like. */
    const { engine, host } = downloaded([])
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    const before = host.sources.length
    act(() => speech().stepSentence(1))
    act(() => speech().stepParagraph(1))
    expect(host.sources.length, 'nothing moved, and nothing pretended to').toBe(before)
    expect(speech().speaking, 'and the reading is untouched').toBe(true)
    unmount()
    page.remove()
  })

  it('a scrub moves the sentence cursor at once, not at the next word boundary', async () => {
    /* ⚠️ **FOUND BY AN INDEPENDENT AUDIT, 2026-09-30, AND THE COMMENT THAT STOOD
       IN `seekToFraction` ARGUED IT DID NOT NEED FIXING.** A scrub moved the sound
       and left the cursor to be set by the next word BOUNDARY, a few hundred
       milliseconds later — so a reader who scrubbed forward and pressed a step
       inside that window stepped from where they HAD been.

       The reasoning was half right: a cursor computed from the fraction and the
       duration would be a second answer to a question the word timings already
       answer. What it missed is that the SPEAKER knows which word it landed on, so
       asking it is that same answer rather than a new one.

       ⚠️ **AND THE FIRST VERSION OF THIS CASE PASSED OVER THE DEFECT**, which is
       why it is written this way. It scrubbed to the end and stepped BACK, and a
       step back reaches sentence 0 from a stale cursor and from a true one alike.
       Forward is the discriminator: from the LAST sentence there is nowhere to go,
       so the correct answer is that nothing moves — while a cursor still saying
       sentence 0 steps to sentence 1, which from the end of the section is the
       voice jumping BACKWARDS on a press labelled *Next sentence*. */
    const { engine, host, texts } = downloaded([
      { start: 0, length: 3, startMs: 0, endMs: 200 },
      { start: 14, length: 3, startMs: 800, endMs: 1000 },
      { start: 28, length: 5, startMs: 1800, endMs: 2000 },
    ])
    const page = section(['One sentence.', 'Two sentence.', 'Three sentence.'], 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    texts.length = 0
    /* A SEEK IS A NEW SOURCE — Web Audio has no other way to move a buffer —
       so counting sources is counting seeks. */
    const starts = () => host.sources.length

    /* All the way to the end, which is inside the THIRD sentence — and with no
       word boundary allowed to arrive afterwards, which is the window. */
    expect(speech().seekToFraction(1)).toBe(true)
    const after = starts()

    act(() => speech().stepSentence(1))

    expect(
      starts(),
      'there is no sentence after the last one, so nothing moved',
    ).toBe(after)
    expect(texts, 'and nothing was rendered again — a step is a seek').toEqual([])

    /* AND THE CURSOR IS REALLY WHERE THE SCRUB PUT IT, rather than merely
       refusing: stepping BACK from the last sentence reaches the second. */
    act(() => speech().stepSentence(-1))
    expect(starts(), 'a step back from the last sentence does move').toBe(after + 1)
    unmount()
    page.remove()
  })

  it('stops claiming a render when a section goes to the platform voice instead', async () => {
    /* ⚠️ **`preparing` LEAKED ACROSS A ROUTE CHANGE — FOUND BY AN INDEPENDENT
       AUDIT, 2026-09-30.** It was set on the engine's road and on no other, and
       it is cleared by the arrival of a POSITION — which the platform speaker
       never reports. So stepping from an English section to one Web Speech reads
       left the transport showing *"Making this chapter's audio…"* with Stop as
       its only control, over a reading that was speaking perfectly well.

       The pack here reads English and nothing else, so the second section's
       Spanish is the platform's — which is the real shape of this: one book, two
       languages, one downloaded pack. */
    const { engine, host } = downloaded()
    const english = section('Hello there.', 'en')
    const spanish = section('Hola.', 'es')
    const { speech, show, unmount } = mount(english.doc, { engine })

    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(speech().preparing, 'the engine section is being rendered').toBe(true)

    /* The render never lands — which is the window, and is why this does not
       resolve the host first: a reader stepping chapters during a 315-second
       render is exactly whom this is for. */
    show(spanish.doc)
    await act(async () => {
      await Promise.resolve()
    })

    expect(speech().preparing, 'and the Spanish section is not being rendered').toBe(false)
    expect(speech().at, 'the platform voice reports no position, which is why it leaked').toBeNull()
    expect(host.sources, 'nothing went to the engine for Spanish').toHaveLength(1)
    unmount()
    english.remove()
    spanish.remove()
  })

  it('turns the page BACK to a word a seek landed on above it', async () => {
    /* ⚠️ **EVERY BACKWARD SEEK THIS PHASE ADDS COULD LEAVE THE READING OFF THE TOP
       OF THE PAGE — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `SpeechPaging`
       had only `next`, because before phase 34 the voice could only move forward;
       a word classified `behind` fell through a bare `return` and the page stayed
       where it was, so the reader was left looking at text nobody was reading.

       The distinction this rests on is in the case above: a word behind the page
       because the READER flipped forward is theirs, and one behind it because the
       READING seeked is the voice's to chase. Same word, same place, and the seek
       is the only difference. */
    const { engine } = downloaded()
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    const { speech, prev, next, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })

    /* A tap on a word — which a reader does to text they can see, and the word
       then reported is above the page because the SECTION moved under it. */
    act(() => {
      speech().seekToOffset(0)
    })
    page.wordAt(-500)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(prev, 'the page followed the voice back').toHaveBeenCalled()
    expect(next, 'and not forward').not.toHaveBeenCalled()
    unmount()
    page.remove()
  })

  it('stops chasing the page once the voice is on it again', async () => {
    /* The reading follows itself back exactly as far as it needs to and then
       stops competing with the reader for the page — otherwise one seek would
       leave it turning back for the rest of the section. */
    const { engine } = downloaded()
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    const { speech, prev, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      speech().seekToOffset(0)
    })
    /* Caught up: the word is on the page. */
    page.wordAt(100)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    prev.mockClear()

    /* Now the reader flips forward. The voice must not drag them back. */
    page.wordAt(-500)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(prev, 'the chase ended when the voice reached the page').not.toHaveBeenCalled()
    unmount()
    page.remove()
  })

  it('a scrub the speaker refuses destroys nothing either', async () => {
    /* Same shape, same reason: `seekToFraction` answers false where the reading
       has no player — between sections is exactly such a moment. */
    const { speech, next, page, unmount } = await atASectionBoundary(WORDS)
    expect(speech().seekToFraction(0.5), 'nothing is playing between sections').toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTINUE_TICK_MS + 10)
    })
    expect(next, 'the walk the scrub must not have taken down').toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTINUE_GRACE_MS + CONTINUE_TICK_MS)
    })
    expect(speech().speaking).toBe(false)
    unmount()
    page.remove()
  })

  it('a new section under a paused reading does not play silently', async () => {
    /* ⚠️ **BOTH SPEAKERS' `speak` BEGINS BY STOPPING, WHICH CLEARS THE ENGINE'S
       OWN PAUSE FLAG.** So a chapter step taken while paused started the new
       section while the transport still said "Go on reading", and only Stop could
       get the two back in step. */
    const { engine } = downloaded()
    const first = section('One.', 'en')
    const second = section('Two.', 'en')
    const { speech, show, unmount } = mount(first.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    act(() => speech().pause())
    expect(speech().paused).toBe(true)
    await act(async () => {
      show(second.doc)
      await Promise.resolve()
    })
    expect(speech().paused, 'the transport agrees with the voice').toBe(false)
    unmount()
    first.remove()
    second.remove()
  })

  it('a held section walk does not survive the section it belonged to', async () => {
    /* ⚠️ `pause` sets `heldContinuation` when it takes down a section walk and
       `resume` reads it as *"restart the walk"*. Left standing across a document
       change, a reader who paused during the OLD section's walk and then resumed
       the NEW section's utterance restarted a page walk instead of releasing the
       speaker: pages turned under a voice they had just resumed. */
    const second = section('Two sentence.', 'en')
    const { speech, show, next, page, unmount } = await atASectionBoundary(WORDS)
    /* Paused DURING the walk, which is what sets the flag. */
    act(() => speech().pause())
    expect(speech().paused).toBe(true)
    await act(async () => {
      show(second.doc)
      await Promise.resolve()
    })
    next.mockClear()
    act(() => speech().pause())
    act(() => speech().resume())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTINUE_TICK_MS * 3)
    })
    expect(next, 'no page is turned under a reader who resumed a section').not.toHaveBeenCalled()
    unmount()
    page.remove()
    second.remove()
  })
})

describe('stepping through a section that is one buffer', () => {
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
  /* `One sentence. Two sentence. Three sentence.` — a word at each sentence's
     first character, so a step's landing is visible in the source's offset. */
  const WORDS = [
    { start: 0, length: 3, startMs: 100, endMs: 200 },
    { start: 14, length: 3, startMs: 500, endMs: 600 },
    { start: 28, length: 5, startMs: 900, endMs: 1000 },
  ]

  async function reading() {
    const host = new FakeAudioHost()
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: async () => ({
        pcm: pcmOf(48_000),
        sampleRate: 24_000,
        words: WORDS,
        skipped: [],
        evicted: { clips: 0, bytes: 0 },
        clipPath: '/tmp/audio/clips/x.wav',
      }),
    }
    const page = section('One sentence. Two sentence. Three sentence.', 'en')
    const mounted = mount(page.doc, { engine })
    act(() => mounted.speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    return { ...mounted, page, host }
  }

  /** Where the newest source was told to start, in seconds. */
  const landedAt = (host: FakeAudioHost) => host.latest.started[0]?.offset

  it('each press steps from where the LAST one landed', async () => {
    /* ⚠️ **THE CURSOR IS WHAT MAKES THIS TRUE, AND NOTHING ELSE WRITES IT ON THIS
       UNIT.** On the platform's sentence unit `speakSentence` writes it once per
       utterance; one buffer has one utterance for a whole section, so a step that
       failed to write it would step from the same place every time — and a step
       that wrote it BEFORE asking would step from a place the reader never
       reached. Two presses in a row is the case that can tell. */
    const { speech, host, page, unmount } = await reading()
    act(() => speech().stepSentence(1))
    expect(landedAt(host), 'the second sentence, at 500 ms').toBeCloseTo(0.5, 3)
    act(() => speech().stepSentence(1))
    expect(landedAt(host), 'the third, not the second again').toBeCloseTo(0.9, 3)
    act(() => speech().stepSentence(-1))
    expect(landedAt(host), 'and back to the second').toBeCloseTo(0.5, 3)
    unmount()
    page.remove()
  })

  it('stepping back from the first sentence says it again', async () => {
    /* The rule `stepParagraph`'s back button already had: a reader pressing back
       at the start of a chapter means "say that again". */
    const { speech, host, page, unmount } = await reading()
    act(() => speech().stepSentence(-1))
    expect(landedAt(host)).toBeCloseTo(0.1, 3)
    unmount()
    page.remove()
  })

  it('stepping forward off the end does nothing, and leaves the reading alone', async () => {
    /* ⚠️ **FORWARD OFF THE END IS THE CONTINUATION'S JOB**, not this one's: the
       sound is still playing, and when it ends `onDone` hands over to the walk
       that crosses a section boundary correctly. */
    const { speech, host, page, unmount } = await reading()
    act(() => speech().stepSentence(1))
    act(() => speech().stepSentence(1))
    const sources = host.sources.length
    act(() => speech().stepSentence(1))
    expect(host.sources.length, 'nothing begins past the last sentence').toBe(sources)
    expect(speech().speaking).toBe(true)
    unmount()
    page.remove()
  })
})

/**
 * ⚠️ **THE POSITION TICK HAD NO CASE — FOUND BY THE MUTATION SWEEP, which reported
 * seventeen survivors inside one `setAt` callback.** It is the scrubber's whole
 * data path: `at` is what the transport draws the thumb and the two clocks from,
 * and every branch of how it is kept — the bail-out, the two null roads, the
 * comparison on either field — was replaceable with nothing failing.
 */
describe('the position the transport draws from', () => {
  const ENGLISH: VoicePack = {
    id: 'english-kokoro',
    name: 'English',
    summary: '',
    family: 'kokoro',
    languages: ['en'],
    bytes: 336_822_660,
    minimumMemoryGb: 4,
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
    installed: true,
  }

  function downloaded() {
    const host = new FakeAudioHost()
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: async () => ({
        pcm: pcmOf(48_000),
        sampleRate: 24_000,
        words: [],
        skipped: [],
        evicted: { clips: 0, bytes: 0 },
        clipPath: '/tmp/audio/clips/x.wav',
      }),
    }
    return { engine, host }
  }

  it('is null before a reading, and carries both numbers once there is one', async () => {
    const { engine } = downloaded()
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    expect(speech().at, 'nothing is playing').toBeNull()

    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS)
    })
    /* 48 000 BYTES is 24 000 samples of 16-bit mono — two seconds at 24 kHz. */
    expect(speech().at, 'two seconds of audio').toEqual({ positionMs: 0, durationMs: 2000 })
    unmount()
    page.remove()
  })

  it('follows the sound, a tick at a time', async () => {
    const { engine, host } = downloaded()
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      host.advance(400)
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS)
    })
    expect(speech().at?.positionMs).toBeCloseTo(400, 0)
    await act(async () => {
      host.advance(200)
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS)
    })
    expect(speech().at?.positionMs).toBeCloseTo(600, 0)
    unmount()
    page.remove()
  })

  it('hands back the SAME object where nothing moved, so React bails out', async () => {
    /* ⚠️ **THE WHOLE REASON THE CALLBACK IS SHAPED THIS WAY.** `positionMs()` is
       constant while paused, so a tick that always set state would re-render four
       times a second for a value nobody can see change. Returning the previous
       value is what makes React skip the render — and an identity comparison is
       the only way to observe it, because an equal object would render. */
    const { engine, unmount, page, speech } = await (async () => {
      const made = downloaded()
      const page = section('Hello there.', 'en')
      const mounted = mount(page.doc, { engine: made.engine })
      act(() => mounted.speech().start())
      await act(async () => {
        await Promise.resolve()
      })
      return { ...made, ...mounted, page }
    })()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS)
    })
    const first = speech().at
    expect(first).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS * 3)
    })
    expect(speech().at, 'the very same object, not an equal one').toBe(first)
    unmount()
    page.remove()
    void engine
  })

  it('goes back to null when the reading stops, and stops ticking', async () => {
    /* Null is what the transport reads to know there is nothing to scrub — the
       platform speaker answers it for ever, and a stopped engine must too. */
    const { engine } = downloaded()
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS)
    })
    expect(speech().at).not.toBeNull()

    act(() => speech().stop())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS * 2)
    })
    expect(speech().at, 'nothing to scrub once the reading is over').toBeNull()
    unmount()
    page.remove()
  })

  it('notices a seek at the next tick', async () => {
    /* The scrubber's thumb is drawn from `at`, so a seek that did not reach it
       would snap back to where the reader dragged it from. */
    const { engine } = downloaded()
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS)
    })
    expect(speech().at?.positionMs).toBe(0)

    act(() => {
      speech().seekToFraction(0.5)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS)
    })
    expect(speech().at?.positionMs).toBeCloseTo(1000, 0)
    unmount()
    page.remove()
  })
})

/**
 * ⚠️ **`refusalFor` HAD NO CASE ANYWHERE — FOUND BY THE MUTATION SWEEP, which
 * reported thirteen survivors in nine lines.** It is the only place a reader is
 * told WHY the voice stopped, and every branch and every sentence in it was
 * replaceable with the empty string and nothing failed. A refusal that says
 * nothing is exactly the state WI-34.5 exists to remove: the Listen control back
 * where it was, and no account of why.
 */
describe('what a reader is told when the reading stops', () => {
  it('names the two reasons that are worth a sentence', () => {
    expect(refusalFor('no-voice')).toBe(
      'No downloaded voice can read this book. Settings → Voices has the packs.',
    )
    /* ⚠️ **NOT "SOMETHING WENT WRONG".** The two things that happen are a render
       that did not finish and a device with nowhere to play; both are covered by
       saying the audio could not be made, and both leave the engine's own words in
       the console and in `Paper.log`. */
    expect(refusalFor('error')).toBe(
      'This chapter could not be made into audio. Trying again may work.',
    )
  })

  it('says nothing for every reason that is not a failure', () => {
    /* ⚠️ **`taken` IS THE ONE WORTH NAMING HERE.** The reader asked for something
       else on the same engine, which is not a refusal — a sentence there would
       accuse the app of failing at the moment it did what it was told. The rest
       are ordinary ends. */
    for (const reason of ['ended', 'empty', 'taken'] as const) {
      expect(refusalFor(reason), reason).toBeNull()
    }
  })

  it('tells the two sentences apart, which is the whole of its job', () => {
    /* One reason maps to one sentence: a reader told to visit Settings → Voices
       when the render simply failed would download a pack they already have, and
       one told to try again when no pack can read the book would try for ever. */
    expect(refusalFor('no-voice')).not.toBe(refusalFor('error'))
    for (const reason of ['no-voice', 'error'] as const) {
      expect(refusalFor(reason), reason).not.toBe('')
    }
  })
})

/**
 * ⚠️ **TAP-TO-SEEK HAD NO CASE AT ALL — FOUND BY THE MUTATION SWEEP, which
 * reported sixteen survivors in one listener.** It is the direction phase 34 made
 * expressible, and every one of its four refusals is a defect if it is missed:
 * a link that no longer follows, a drag that moves the voice, a modified click
 * the platform wanted, a plate's own handler overridden. The listener was
 * installed, removed and refused entirely on argument rather than on measurement.
 */
describe('a tap on a word, which is the direction phase 34 added', () => {
  const ENGLISH: VoicePack = {
    id: 'english-kokoro',
    name: 'English',
    summary: '',
    family: 'kokoro',
    languages: ['en'],
    bytes: 336_822_660,
    minimumMemoryGb: 4,
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
    installed: true,
  }

  /**
   * A reading on a downloaded voice, with `caretRangeFromPoint` answering the
   * node and offset a tap resolves to.
   *
   * ⚠️ **jsdom IMPLEMENTS NEITHER CARET API**, so the tap cannot be driven without
   * one — which is why this listener had no case. Stubbing the LEGACY one is what
   * a WebKit reader really has; `textAtPoint` prefers it for that reason.
   */
  async function reading(text: readonly string[] = ['One sentence.', 'Two sentence.']) {
    const host = new FakeAudioHost()
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: async () => ({
        pcm: pcmOf(48_000),
        sampleRate: 24_000,
        words: [
          { start: 0, length: 3, startMs: 0, endMs: 200 },
          { start: 14, length: 3, startMs: 1000, endMs: 1200 },
        ],
        skipped: [],
        evicted: { clips: 0, bytes: 0 },
        clipPath: '/tmp/audio/clips/x.wav',
      }),
    }
    const page = section(text, 'en')
    let caret: { node: Node; offset: number } | null = null
    ;(page.doc as Partial<Document>).caretRangeFromPoint = ((x: number, y: number) => {
      void x
      void y
      return caret ? ({ startContainer: caret.node, startOffset: caret.offset } as Range) : null
    }) as Document['caretRangeFromPoint']
    const mounted = mount(page.doc, { engine })
    act(() => mounted.speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    const sources = () => host.sources.length
    /** Put the caret in the SECOND paragraph, which is the second sentence. */
    const aim = (at: 'first' | 'second' | 'nowhere') => {
      const paragraphs = [...page.doc.querySelectorAll('p')]
      const node = at === 'first' ? paragraphs[0]?.firstChild : paragraphs[1]?.firstChild
      caret = at === 'nowhere' || !node ? null : { node, offset: 0 }
    }
    const tap = (over: Partial<MouseEventInit> = {}) => {
      const event = new page.doc.defaultView!.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...over,
      })
      act(() => {
        ;(page.doc.querySelector('p') as Element).dispatchEvent(event)
      })
      return event
    }
    return { ...mounted, page, host, sources, aim, tap }
  }

  it('puts the voice where the reader tapped', async () => {
    const { aim, tap, sources, unmount, page } = await reading()
    const before = sources()
    aim('second')
    tap()
    expect(sources(), 'a seek is a new source').toBe(before + 1)
    unmount()
    page.remove()
  })

  it('follows a link rather than moving the voice', async () => {
    /* A footnote or a chapter reference is an `<a>`, and navigating is what the
       reader asked for — `ReaderSession.#watchPlates` gives way the same way. */
    const { aim, page, sources, unmount } = await reading()
    const link = page.doc.createElement('a')
    link.href = '#note'
    link.textContent = 'note'
    ;(page.doc.querySelector('p') as Element).append(link)
    const before = sources()
    aim('second')
    act(() => {
      link.dispatchEvent(
        new page.doc.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      )
    })
    expect(sources()).toBe(before)
    unmount()
    page.remove()
  })

  it('leaves a live selection alone', async () => {
    /* A click that ends a drag arrives here too, so without this every marked
       passage would also move the voice. */
    const { aim, tap, page, sources, unmount } = await reading()
    const range = page.doc.createRange()
    range.selectNodeContents(page.doc.querySelector('p') as Element)
    page.doc.defaultView?.getSelection()?.removeAllRanges()
    page.doc.defaultView?.getSelection()?.addRange(range)
    const before = sources()
    aim('second')
    tap()
    expect(sources(), 'the drag was theirs').toBe(before)
    page.doc.defaultView?.getSelection()?.removeAllRanges()
    unmount()
    page.remove()
  })

  it('gives way to a modified click and to a button that is not the first', async () => {
    /* Command, Control, Shift and Alt all mean something to macOS and to the
       fork; a right button is a context menu. */
    const { aim, tap, sources, unmount, page } = await reading()
    const before = sources()
    aim('second')
    for (const over of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { button: 2 },
    ]) {
      tap(over)
    }
    expect(sources(), 'none of them moved the voice').toBe(before)
    unmount()
    page.remove()
  })

  it('gives way to a click something else has already taken', async () => {
    /* `defaultPrevented` is how a plate and a footnote say they handled it. */
    const { aim, page, sources, unmount } = await reading()
    const taken = (event: Event) => event.preventDefault()
    page.doc.addEventListener('click', taken, true)
    const before = sources()
    aim('second')
    act(() => {
      ;(page.doc.querySelector('p') as Element).dispatchEvent(
        new page.doc.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      )
    })
    expect(sources()).toBe(before)
    page.doc.removeEventListener('click', taken, true)
    unmount()
    page.remove()
  })

  it('survives a click whose target is the document rather than an element', async () => {
    /* ⚠️ **`closest` IS AN `Element` METHOD AND A CLICK CAN TARGET THE DOCUMENT** —
       the margin is a place readers click. Without the `typeof` test the listener
       would throw there, taking the reading down; with it, the tap is an ordinary
       one and moves the voice, which is what a reader clicking beside a line
       means. The seek happening is the proof that nothing threw on the way. */
    const { aim, page, sources, unmount } = await reading()
    const before = sources()
    aim('second')
    act(() => {
      page.doc.dispatchEvent(
        new page.doc.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      )
    })
    expect(sources(), 'it read the click through rather than throwing on it').toBe(before + 1)
    unmount()
    page.remove()
  })

  it('does nothing for a tap on text the voice does not read', async () => {
    /* ⚠️ **`offsetIn` ANSWERS `null` FOR A NODE OUTSIDE THE COLLECTED TEXT** — a
       hidden note, a caption `collectText` skips. There is nowhere in the sound to
       go, and a seek to a guessed place would be worse than none. */
    const { page, tap, sources, unmount } = await reading()
    const hidden = page.doc.createElement('p')
    hidden.hidden = true
    hidden.textContent = 'Not read aloud.'
    page.doc.body.append(hidden)
    ;(page.doc as Partial<Document>).caretRangeFromPoint = (() =>
      ({ startContainer: hidden.firstChild!, startOffset: 0 }) as unknown as
        Range) as Document['caretRangeFromPoint']
    const before = sources()
    tap()
    expect(sources(), 'the tap resolved to text the reading never collected').toBe(before)
    unmount()
    page.remove()
  })

  it('does nothing where the tap resolves to no text at all', async () => {
    const { aim, tap, sources, unmount, page } = await reading()
    const before = sources()
    aim('nowhere')
    tap()
    expect(sources()).toBe(before)
    unmount()
    page.remove()
  })

  it('is not installed at all on the platform voice, which cannot seek', async () => {
    /* ⚠️ **THE SECTION UNIT ONLY.** Web Speech is handed one sentence and cannot
       seek inside it, so a tap there would report `false` and leave the reader
       with a gesture that silently does nothing. */
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    let asked = 0
    ;(page.doc as Partial<Document>).caretRangeFromPoint = ((): Range | null => {
      asked += 1
      return null
    }) as Document['caretRangeFromPoint']
    const { speech, unmount } = mount(page.doc)
    act(() => speech().start())
    act(() => {
      ;(page.doc.querySelector('p') as Element).dispatchEvent(
        new page.doc.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      )
    })
    expect(asked, 'the tap was not even resolved to text').toBe(0)
    unmount()
    page.remove()
  })

  it('takes the listener off when the reading stops', async () => {
    /* It is installed only while a reading is speaking — a tap on a book nobody
       is reading aloud is an ordinary tap. */
    const { aim, tap, sources, speech, unmount, page } = await reading()
    act(() => speech().stop())
    const before = sources()
    aim('second')
    tap()
    expect(sources()).toBe(before)
    unmount()
    page.remove()
  })

  it('leaves no listener behind, which nothing about the reading would reveal', async () => {
    /* ⚠️ **THE CLEANUP IS A LEAK AND NOT A BEHAVIOUR — FOUND BY THE MUTATION
       SWEEP, which replaced `removeEventListener` with nothing and every case
       stayed green.** It is unobservable through the reading because the handler's
       own guards refuse once `spokenRef` is clear: an abandoned listener costs
       nothing visible and accumulates one per start for as long as the book is
       open. So this counts, which is the only way to see it.

       ⚠️ **AND THE COUNT IS OF `'click'` ALONE.** This document carries the
       plates, the selection, the keys and the wheel; a bare total would move for
       reasons that have nothing to do with the tap. */
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    let live = 0
    const added = page.doc.addEventListener.bind(page.doc)
    const removed = page.doc.removeEventListener.bind(page.doc)
    page.doc.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'click') live += 1
      return (added as (...args: unknown[]) => void)(type, ...rest)
    }) as Document['addEventListener']
    page.doc.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'click') live -= 1
      return (removed as (...args: unknown[]) => void)(type, ...rest)
    }) as Document['removeEventListener']

    const host = new FakeAudioHost()
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: async () => ({
        pcm: pcmOf(48_000),
        sampleRate: 24_000,
        words: [],
        skipped: [],
        evicted: { clips: 0, bytes: 0 },
        clipPath: '/tmp/audio/clips/x.wav',
      }),
    }
    const { speech, unmount } = mount(page.doc, { engine })
    for (let round = 0; round < 3; round += 1) {
      act(() => speech().start())
      await act(async () => {
        await Promise.resolve()
      })
      expect(live, `one while reading, round ${round}`).toBe(1)
      act(() => speech().stop())
      expect(live, `and none once stopped, round ${round}`).toBe(0)
    }
    unmount()
    expect(live, 'and none after the component goes').toBe(0)
    page.remove()
  })
})

/**
 * ⚠️ **THE TWO SENTINELS HAD NO CASE — FOUND BY THE MUTATION SWEEP.** Each stands
 * for *the bookkeeping has not caught up yet*, and each is sent to the plugin as a
 * real key — so what is IN them decides whether the store answers a miss or, far
 * worse, something. Every string in both was replaceable and nothing failed.
 */
describe('the value that means “nothing is known yet”', () => {
  it('names no book and no section', () => {
    expect(NOWHERE_IN_PARTICULAR).toEqual({ bookId: null, sectionIndex: null })
  })

  it('is what the app’s own first render passes, before anything has resolved', () => {
    /* `bookId` is a content hash that resolves asynchronously and `sectionIndex`
       arrives with the document, so this IS the value `App` holds at mount — see
       the in-app run, where a `?? -1` in its place killed every Listen. */
    expect(NOWHERE, 'the harness and the hook agree about it').toEqual(NOWHERE_IN_PARTICULAR)
  })
})

/**
 * ⚠️ **THE ENGINE GOING AWAY IS A ROUTE CHANGE, NOT A FAILURE — which is what the
 * mutation sweep settled.** Four members of the speaker's deps used to guard
 * against `engineRef.current` being null, and every one of those branches was
 * unreachable: `routedSpeaker` sends a passage to the engine only when
 * `speakerFor(packs(), …)` answers `'engine'`, and with no engine `packs()` is
 * `[]`, which answers `'platform'` for every language there is. The guards are
 * gone; this is the behaviour they were standing in front of.
 */
describe('the downloaded engine going away under an open book', () => {
  const ENGLISH: VoicePack = {
    id: 'english-kokoro',
    name: 'English',
    summary: '',
    family: 'kokoro',
    languages: ['en'],
    bytes: 336_822_660,
    minimumMemoryGb: 4,
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
    installed: true,
  }

  it('falls back to the platform voice rather than refusing', async () => {
    const host = new FakeAudioHost()
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: async () => ({
        pcm: pcmOf(48_000),
        sampleRate: 24_000,
        words: [],
        skipped: [],
        evicted: { clips: 0, bytes: 0 },
        clipPath: '/tmp/audio/clips/x.wav',
      }),
    }
    const page = section('Hello there.', 'en')
    const { speech, setEngine, unmount } = mount(page.doc, { engine })

    setEngine(null)
    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(speech().speaking, 'the book is still read').toBe(true)
    expect(host.sources, 'but not by the engine').toHaveLength(0)
    expect(synth.queued.map((u) => u.text.trim()), 'by Web Speech instead').toEqual(['Hello there.'])
    expect(speech().at, 'and there is nothing to scrub, which is honest').toBeNull()
    unmount()
    page.remove()
  })
})

/**
 * ⚠️ **THE TRANSPORT'S THREE INITIAL VALUES HAD NO CASE — FOUND BY THE MUTATION
 * SWEEP.** Each decides what a reader sees before they have pressed anything, and
 * `preparing` is the one that matters: true at mount, every book would open under
 * *"Making this chapter's audio…"* with Stop as the only control, over a reading
 * that has not been asked for.
 */
describe('what the transport says before anything has been pressed', () => {
  it('is not reading, not preparing, not paused, and has nowhere to scrub', () => {
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc)
    expect(speech().speaking, 'nothing has been asked for').toBe(false)
    expect(speech().preparing, 'and nothing is being made').toBe(false)
    expect(speech().paused).toBe(false)
    expect(speech().at, 'nothing to scrub').toBeNull()
    expect(speech().refusal, 'and nothing to explain').toBeNull()
    unmount()
    page.remove()
  })
})

/**
 * ⚠️ **THE `unit === 'section'` TESTS HAD ONLY ONE SIDE — FOUND BY THE MUTATION
 * SWEEP.** Three places ask it, and every case that reached them was an ENGINE
 * reading: the sentence unit's answer was never observed at all. It is the whole
 * of what the platform speaker does — one sentence at a time, no position, no
 * seek — so these are the cases that say what a reader on Web Speech gets.
 */
describe('a reading on the platform voice, which is a sentence at a time', () => {
  it('moves the cursor per utterance and not per word', async () => {
    /* ⚠️ **`onWord` SETS THE CURSOR ONLY ON THE SECTION UNIT.** Web Speech writes
       `charIndex` once per utterance and an utterance IS one sentence, so
       `speakSentence` already knows which — asking the plan again from a boundary
       would answer the same thing at best and the wrong thing at worst, since the
       index is rebased onto the utterance rather than the section. */
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    const { speech, unmount } = mount(page.doc)
    act(() => speech().start())
    expect(spoken(), 'one sentence queued, not the section').toEqual(['One sentence.'])

    /* A boundary at offset 0 of the SECOND utterance: on the section unit that
       would be read as the top of the chapter. */
    ends()
    expect(spoken()).toEqual(['One sentence.', 'Two sentence.'])
    boundary(0, 3)
    act(() => speech().stepSentence(1))
    /* The cursor came from `speakSentence`, so the step goes past the second —
       which is the end of the section rather than back to the first. */
    expect(spoken().length, 'nothing was re-spoken from the top').toBe(2)
    unmount()
    page.remove()
  })

  it('cannot be scrubbed or tapped, and says so rather than pretending', async () => {
    /* ⚠️ **`at` IS NULL, WHICH IS WHAT THE TRANSPORT READS TO DRAW NO SCRUBBER.**
       Web Speech reports no position in an utterance and has no duration until it
       has finished one, so there is nothing to draw a thumb from — and a seek
       that answered `true` would leave a reader dragging a control that does
       nothing. */
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    const { speech, unmount } = mount(page.doc)
    act(() => speech().start())
    expect(speech().at, 'nothing to scrub').toBeNull()
    expect(speech().seekToFraction(0.5), 'and it says so').toBe(false)
    expect(speech().seekToOffset(14)).toBe(false)
    unmount()
    page.remove()
  })
})

/**
 * ⚠️ **THE EFFECT THAT ENDS "Making this chapter's audio…" HAD NO CASE — FOUND BY
 * THE MUTATION SWEEP, six survivors in three lines.** It is the one thing that
 * turns the preparing transport back into the ordinary one, and WI-34.0 measured a
 * real section at 315 seconds: a reader spends minutes there. Every branch of it
 * was replaceable and nothing failed.
 */
describe('when the wait for a render is over', () => {
  const ENGLISH: VoicePack = {
    id: 'english-kokoro',
    name: 'English',
    summary: '',
    family: 'kokoro',
    languages: ['en'],
    bytes: 336_822_660,
    minimumMemoryGb: 4,
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
    installed: true,
  }

  /** A render this case releases, so the wait can be observed while it lasts. */
  function slow() {
    const host = new FakeAudioHost()
    let land: () => void = () => {}
    const engine: ReadingEngine = {
      packs: () => [ENGLISH],
      host: () => host,
      render: () =>
        new Promise<SpokenAudio>((resolve) => {
          land = () =>
            resolve({
              pcm: pcmOf(48_000),
              sampleRate: 24_000,
              words: [],
              skipped: [],
              evicted: { clips: 0, bytes: 0 },
              clipPath: '/tmp/audio/clips/x.wav',
            })
        }),
    }
    return { engine, host, land: () => land() }
  }

  it('says it is preparing until a position arrives, and not a moment longer', async () => {
    /* ⚠️ **A POSITION IS THE END OF THE WAIT, AND IT IS THE ONLY HONEST SIGNAL.**
       The render resolving is not it: the audio still has to reach the player and
       start. A separate writer for `preparing` would be a second answer to one
       question; this is the same fact read once. */
    const { engine, land } = slow()
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc, { engine })

    act(() => speech().start())
    await act(async () => {
      await Promise.resolve()
    })
    expect(speech().preparing, 'the render is still running').toBe(true)
    expect(speech().at, 'and there is no position yet').toBeNull()

    /* The clock alone does not end it — only a position does. */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS * 4)
    })
    expect(speech().preparing, 'still waiting').toBe(true)

    land()
    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(POSITION_TICK_MS)
    })
    expect(speech().at, 'the sound is playing').not.toBeNull()
    expect(speech().preparing, 'so the ordinary transport is back').toBe(false)
    unmount()
    page.remove()
  })

})

/**
 * ⚠️ **THREE GUARDS AND A CLEANUP THE SWEEP COULD NOT SEE ANY TEST REACH.** Each
 * is about a control being pressed at a moment the transport would not normally
 * offer it — which a keyboard accelerator, a palette row or a stale render can all
 * produce.
 */
describe('the transport pressed when there is nothing to press it on', () => {
  it('answers false for every seek before a reading has begun', async () => {
    /* ⚠️ **NOT AN ERROR AND NOT A SILENT TRUE.** `⌘[`-style accelerators are live
       whether or not the voice is going, so a seek arrives here with no reading
       behind it — and a `true` would tell the transport it had moved something. */
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    const { speech, unmount } = mount(page.doc)
    expect(speech().seekToFraction(0.5), 'nothing is reading').toBe(false)
    expect(speech().seekToOffset(0)).toBe(false)
    expect(speech().at).toBeNull()
    unmount()
    page.remove()
  })

  it('answers false for a seek once the reading has been stopped', async () => {
    const page = section(['One sentence.', 'Two sentence.'], 'en')
    const { speech, unmount } = mount(page.doc)
    act(() => speech().start())
    act(() => speech().stop())
    expect(speech().seekToFraction(0.5)).toBe(false)
    expect(speech().seekToOffset(0)).toBe(false)
    unmount()
    page.remove()
  })

  it('clears a refusal when the reader presses Listen again', async () => {
    /* ⚠️ **LEFT STANDING, A SENTENCE ABOUT A CHAPTER THAT COULD NOT BE MADE WOULD
       SIT OVER THE ONE THAT CAN.** The Listen control carries the refusal in its
       title, so a reader who fixes the cause — downloads the pack, frees the
       device — would press it and be told again that it cannot be read. */
    synth.voices = [
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
    ]
    const page = section('Hello there.', 'en-US')
    const { speech, unmount } = mount(page.doc)
    act(() => speech().start())
    act(() => {
      vi.advanceTimersByTime(CONTINUE_TICK_MS * 4)
    })
    expect(speech().refusal, 'no voice good enough, and it says so').not.toBeNull()

    /* THE CAUSE FIXED — a voice whose identifier Apple does not spell, which is
       every voice on Windows, Linux and a browser, and which the floor lets
       through because a tier it cannot read must not be refused. */
    synth.voices = [{ name: 'Zoe', lang: 'en-US', voiceURI: 'Zoe' }]
    act(() => speech().start())
    expect(speech().refusal, 'the reader’s own press clears it').toBeNull()
    unmount()
    page.remove()
  })

  it('stops the position tick when the reading ends, rather than leaving it running', async () => {
    /* ⚠️ **AN INTERVAL PER READING, LEFT BEHIND, IS FOUR WAKE-UPS A SECOND EACH.**
       The cleanup is invisible through the transport — `at` goes null either way
       — so the timer has to be counted. */
    const page = section('Hello there.', 'en')
    const { speech, unmount } = mount(page.doc)
    const live = () => vi.getTimerCount()
    act(() => speech().start())
    const reading = live()
    act(() => speech().stop())
    expect(live(), 'the tick went with the reading').toBeLessThan(reading)
    unmount()
    page.remove()
  })
})
