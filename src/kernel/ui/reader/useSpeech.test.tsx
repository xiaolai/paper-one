// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'
import { CONTINUE_GRACE_MS, CONTINUE_TICK_MS, TURN_SETTLE_MS, useSpeech, type Speech } from './useSpeech'
import { collectText } from './speech'

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
 */
function section(text: string, lang: string | null = null) {
  const stage = document.createElement('div')
  document.body.append(stage)
  const frame = document.createElement('iframe')
  stage.append(frame)
  const doc = frame.contentDocument
  if (!doc) throw new Error('jsdom gave the frame no document')
  if (lang) doc.documentElement.setAttribute('lang', lang)
  doc.body.innerHTML = text === '' ? '' : `<p>${text}</p>`

  stage.getBoundingClientRect = () => rect(0, 0, 1000, 800)
  frame.getBoundingClientRect = () => rect(0, 0, 3000, 800)
  let word = rect(100, 100, 60, 20)
  const realm = doc.defaultView as Window & { Range: { prototype: Range } }
  realm.Range.prototype.getBoundingClientRect = () => word

  return {
    doc,
    /** Put every word at this x, in the frame's own coordinates. */
    wordAt(left: number) {
      word = rect(left, 100, 60, 20)
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

function mount(doc: Document | null) {
  const next = vi.fn()
  const api: { current: Speech | null } = { current: null }
  function Probe({ doc }: { doc: Document | null }) {
    api.current = useSpeech(doc, { next })
    return null
  }
  const view = render(<Probe doc={doc} />)
  return {
    next,
    speech: () => api.current!,
    show: (doc: Document | null) => view.rerender(<Probe doc={doc} />),
  }
}

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
