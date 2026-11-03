// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadingSurface, SpokenSection } from '../../core/ports'
import { textDigest } from './clipKey'
import { canonicalTextOf } from './passageText'
import {
  createReadingSurface,
  readyBookOf,
  useReadingSurface,
  type BookFacts,
  type SurfaceDriver,
  type SurfaceSource,
} from './readingSurface'
import { placeSpokenWord } from './rulerBand'
import { collectText } from './speech'

/**
 * The contract decision D7 asks for, driven adversarially: what happens to a
 * section, a tap, a walk and a hold when the thing it was made for has gone.
 *
 * Whether a whole reading survives the same things is `useSpeech.test.tsx`, which
 * runs through this surface from a child, as the app does.
 */

afterEach(cleanup)

const BAND = 'paper-spoken-word'

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

/** One spine document in a frame, with its words at a position the test sets. */
function page(html: string, lang: string | null = null) {
  const stage = document.createElement('div')
  document.body.append(stage)
  const frame = document.createElement('iframe')
  stage.append(frame)
  const doc = frame.contentDocument!
  if (lang) doc.documentElement.setAttribute('lang', lang)
  doc.body.innerHTML = html
  stage.getBoundingClientRect = () => rect(0, 0, 1000, 800)
  frame.getBoundingClientRect = () => rect(0, 0, 3000, 800)
  let word = rect(100, 100, 60, 20)
  ;(doc.defaultView as unknown as { Range: typeof Range }).Range.prototype.getBoundingClientRect = () => word
  let caret: { node: Node; offset: number } | null = null
  ;(doc as Partial<Document>).caretRangeFromPoint = (() =>
    caret && ({ startContainer: caret.node, startOffset: caret.offset } as Range)) as Document['caretRangeFromPoint']
  return {
    doc,
    band: () => doc.getElementById(BAND),
    wordAt: (left: number) => {
      word = rect(left, 100, 60, 20)
    },
    aim: (node: Node | null, offset = 0) => {
      caret = node && { node, offset }
    },
    text: (selector = 'p') => doc.querySelector(selector)!.firstChild!,
    click: (over: MouseEventInit = {}, on: Element = doc.body) => {
      const event = new (doc.defaultView as unknown as typeof globalThis).MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...over,
      })
      on.dispatchEvent(event)
    },
  }
}

const facts = (over: Partial<BookFacts> = {}): BookFacts => ({
  generation: 1,
  bookId: 'book:1',
  doc: document.implementation.createHTMLDocument(''),
  meta: { title: 'Le Horla', author: 'Maupassant' },
  toc: [],
  fixedLayout: false,
  sectionTexts: vi.fn(async () => ({ sections: [], complete: true })),
  ...over,
})

const NOTHING_TO_TURN = { next: () => {}, prev: () => {} }

function source(doc: Document | null, over: Partial<SurfaceSource> = {}): SurfaceSource {
  return {
    doc,
    place: { bookId: 'book:1', sectionIndex: 3 },
    paging: NOTHING_TO_TURN,
    book: facts({ doc }),
    ...over,
  }
}

const NO_NOTES = { notes: false }

describe('a section is bound to the document it was made from', () => {
  it('carries what a reading needs of that document', () => {
    const one = page('<p>Bonjour le monde. Encore ici.</p>', 'fr')
    const section = createReadingSurface(source(one.doc)).surface.speakable(NO_NOTES)!
    expect(section.bookId).toBe('book:1')
    expect(section.sectionIndex).toBe(3)
    expect(section.lang).toBe('fr')
    expect(section.text).toBe(collectText(one.doc, NO_NOTES).text)
    expect(section.text.slice(section.sentences[1]!.start, section.sentences[1]!.end)).toContain('Encore')
    expect(section.blocks).toEqual(collectText(one.doc, NO_NOTES).blocks)
    expect(section.live()).toBe(true)
  })

  it('cuts Chinese into sentences, with no spaces to help', () => {
    /* Chinese has no word gaps, so what a band and a tap can rely on is the
       sentence the segmenter finds and the offset into the text. */
    const one = page('<p>第一句话。第二句话！第三句话？</p>', 'zh-Hans')
    const section = createReadingSurface(source(one.doc)).surface.speakable(NO_NOTES)!
    expect(section.lang).toBe('zh-Hans')
    expect(section.sentences.map(({ start, end }) => section.text.slice(start, end).trim())).toEqual([
      '第一句话。',
      '第二句话！',
      '第三句话？',
    ])
    expect(section.digest).toBe(textDigest(canonicalTextOf(one.doc)))
  })

  it('names no book until the hash resolves, and no section where the place cannot', () => {
    /* ⚠️ **NULL, AND NOT A SENTINEL**: a negative index is what `ClipKey.section`
       records killing every Listen. */
    const one = page('<p>Words.</p>')
    const section = createReadingSurface(
      source(one.doc, { place: { bookId: null, sectionIndex: null } }),
    ).surface.speakable(NO_NOTES)!
    expect(section.bookId).toBe('')
    expect(section.sectionIndex).toBeNull()
  })

  it('has nothing to offer with no document', () => {
    expect(createReadingSurface(source(null)).surface.speakable(NO_NOTES)).toBeNull()
  })

  it('paints the word it is asked for, in its own document, and says where it fell', () => {
    const one = page('<p>Bonjour le monde.</p>')
    const section = createReadingSurface(source(one.doc)).surface.speakable(NO_NOTES)!
    expect(section.paintWord(0, 7)).toBe('visible')
    expect(one.band(), 'painted').not.toBeNull()
    one.wordAt(1200)
    expect(section.paintWord(0, 7)).toBe('ahead')
    one.wordAt(-800)
    expect(section.paintWord(0, 7)).toBe('behind')
  })

  it('answers null for an offset the text does not hold, and paints nothing', () => {
    const one = page('<p>Bonjour.</p>')
    const section = createReadingSurface(source(one.doc)).surface.speakable(NO_NOTES)!
    expect(section.paintWord(5000, 3)).toBeNull()
    expect(one.band()).toBeNull()
  })

  it('takes its word back off the page', () => {
    const one = page('<p>Bonjour.</p>')
    const section = createReadingSurface(source(one.doc)).surface.speakable(NO_NOTES)!
    section.paintWord(0, 7)
    section.clearWord()
    expect(one.band()).toBeNull()
  })
})

/** A driver over `first`, a section of it, and a second document on screen. */
function replaced(firstHtml = '<p>The old words.</p>', secondHtml = '<p>The new words.</p>') {
  const first = page(firstHtml)
  const second = page(secondHtml)
  const driver = createReadingSurface(source(first.doc))
  const stale = driver.surface.speakable(NO_NOTES)!
  return { first, second, driver, stale }
}

describe('a late callback, once the section has been replaced', () => {
  it('finds the section is not live', () => {
    const { second, driver, stale } = replaced()
    expect(stale.live()).toBe(true)
    driver.commit(source(second.doc))
    expect(stale.live()).toBe(false)
    expect(driver.surface.speakable(NO_NOTES)!.live(), 'the new one is').toBe(true)
  })

  it('paints nothing in either document', () => {
    const { first, second, driver, stale } = replaced()
    driver.commit(source(second.doc))
    expect(stale.paintWord(0, 3)).toBeNull()
    expect(first.band(), 'the document it was made from').toBeNull()
    expect(second.band(), 'the document on screen').toBeNull()
  })

  it('does not clear a word it no longer owns', () => {
    /* Placed directly, so that only the section's own guard is being asked: a
       stale reading's clear must be a no-op wherever it would have landed. */
    const { first, second, driver, stale } = replaced()
    driver.commit(source(second.doc))
    placeSpokenWord(first.doc, rect(1, 1, 1, 1))
    stale.clearWord()
    expect(first.band(), 'the guard, not the document, decided').not.toBeNull()
  })

  it('does not answer a tap', () => {
    const { first, second, driver, stale } = replaced()
    const heard = vi.fn()
    stale.onTap(heard)
    driver.commit(source(second.doc))
    first.aim(first.text(), 2)
    first.click()
    expect(heard).not.toHaveBeenCalled()
  })

  it('leaves the same document live across a commit that did not replace it', () => {
    const { first, driver, stale } = replaced()
    driver.commit(source(first.doc))
    expect(stale.live()).toBe(true)
  })
})

describe('the section and the book being replaced', () => {
  it('takes the band out of the document that is leaving', () => {
    /* The section that drew it can no longer do so: see `clearWord`. */
    const { first, second, driver, stale } = replaced()
    stale.paintWord(0, 3)
    expect(first.band()).not.toBeNull()
    driver.commit(source(second.doc))
    expect(first.band()).toBeNull()
  })

  it('leaves the band alone across a commit that keeps the document', () => {
    const { first, driver, stale } = replaced()
    stale.paintWord(0, 3)
    driver.commit(source(first.doc))
    expect(first.band()).not.toBeNull()
  })

  it('takes it out when the book closes', () => {
    const { first, driver, stale } = replaced()
    stale.paintWord(0, 3)
    driver.commit(source(null))
    expect(first.band()).toBeNull()
    expect(stale.live()).toBe(false)
  })

  it('reads the place as of the latest commit', () => {
    const { first, driver } = replaced()
    driver.commit(source(first.doc, { place: { bookId: 'book:2', sectionIndex: 9 } }))
    const section = driver.surface.speakable(NO_NOTES)!
    expect(section.bookId).toBe('book:2')
    expect(section.sectionIndex).toBe(9)
  })

  it('turns pages through whatever was last committed, in reading order', () => {
    const before = { next: vi.fn(), prev: vi.fn() }
    const after = { next: vi.fn(), prev: vi.fn() }
    const one = page('<p>Words.</p>')
    const driver = createReadingSurface(source(one.doc, { paging: before }))
    driver.commit(source(one.doc, { paging: after }))
    driver.surface.turn(1)
    expect(after.next).toHaveBeenCalledTimes(1)
    expect(after.prev).not.toHaveBeenCalled()
    driver.surface.turn(-1)
    expect(after.prev).toHaveBeenCalledTimes(1)
    expect(after.next).toHaveBeenCalledTimes(1)
    expect(before.next).not.toHaveBeenCalled()
    expect(before.prev).not.toHaveBeenCalled()
  })
})

describe('a skip choice', () => {
  const HTML = '<p>Before.</p><aside epub:type="footnote"><p>The note.</p></aside><p>After.</p>'
  const both = () => {
    const one = page(HTML)
    const { surface } = createReadingSurface(source(one.doc))
    return { one, skipped: surface.speakable({ notes: false })!, read: surface.speakable({ notes: true })! }
  }

  it('makes a new section with its own text, and both stay live', () => {
    /* ⚠️ **INDEPENDENT, SO THAT A SECOND READER OF THE SURFACE CANNOT KILL THE
       READING'S SECTION BY ASKING FOR ONE OF ITS OWN.** */
    const { skipped, read } = both()
    expect(read.text).toContain('The note')
    expect(skipped.text).not.toContain('The note')
    expect(skipped.live()).toBe(true)
    expect(read.live()).toBe(true)
  })

  it('maps a tap through the same skip the section reads', () => {
    /* The word after the note is at a different offset in the two texts, and a
       tap mapped through the wrong one would land the voice on the wrong word. */
    const { one, skipped, read } = both()
    const heardSkipped = vi.fn()
    const heardRead = vi.fn()
    skipped.onTap(heardSkipped)
    read.onTap(heardRead)
    const after = one.doc.querySelectorAll('body > p')[1]!.firstChild!
    one.aim(after, 2)
    one.click()
    expect(heardSkipped).toHaveBeenCalledWith(skipped.text.indexOf('After') + 2)
    expect(heardRead).toHaveBeenCalledWith(read.text.indexOf('After') + 2)
    expect(heardSkipped.mock.calls[0]![0]).not.toBe(heardRead.mock.calls[0]![0])
  })

  it('is silent on a tap on text it skips, and hears it where it reads it', () => {
    const { one, skipped, read } = both()
    const heardSkipped = vi.fn()
    const heardRead = vi.fn()
    skipped.onTap(heardSkipped)
    read.onTap(heardRead)
    one.aim(one.doc.querySelector('aside p')!.firstChild!, 1)
    one.click()
    expect(heardSkipped).not.toHaveBeenCalled()
    expect(heardRead).toHaveBeenCalledTimes(1)
  })

  it('does not change what the section is filed under', () => {
    /* The key names the section's words, and a choice of which to read is not a
       different section: see the digest below. */
    const { skipped, read } = both()
    expect(skipped.digest).toBe(read.digest)
  })
})

describe('the digest', () => {
  it('is over `indexText`s canonical form, not over the spoken text', () => {
    const one = page('<h1>A title</h1><p>Some words here.</p><aside epub:type="footnote"><p>A note.</p></aside>')
    const section = createReadingSurface(source(one.doc)).surface.speakable(NO_NOTES)!
    expect(section.digest).toBe(textDigest(canonicalTextOf(one.doc)))
    expect(section.digest, 'the two really differ on this page').not.toBe(textDigest(section.text))
  })
})

describe('a tap', () => {
  const tapped = () => {
    const one = page('<p>Some words <a href="#n">a link</a> here.</p>')
    const section = createReadingSurface(source(one.doc)).surface.speakable(NO_NOTES)!
    const heard = vi.fn()
    const off = section.onTap(heard)
    one.aim(one.text(), 2)
    return { one, section, heard, off }
  }

  it('reports the offset in the section’s text', () => {
    const { one, heard } = tapped()
    one.click()
    expect(heard).toHaveBeenCalledExactlyOnceWith(2)
  })

  it.each<[string, MouseEventInit]>([
    ['a secondary button', { button: 2 }],
    ['with Command', { metaKey: true }],
    ['with Control', { ctrlKey: true }],
    ['with Shift', { shiftKey: true }],
    ['with Alt', { altKey: true }],
  ])('is not %s', (_name, over) => {
    const { one, heard } = tapped()
    one.click(over)
    expect(heard).not.toHaveBeenCalled()
  })

  it('gives way to a link, so a footnote keeps its meaning', () => {
    const { one, heard } = tapped()
    one.click({}, one.doc.querySelector('a')!)
    expect(heard).not.toHaveBeenCalled()
  })

  it('gives way to whatever already took the click', () => {
    const { one, heard } = tapped()
    one.doc.body.addEventListener('click', (event) => event.preventDefault(), { capture: true })
    one.click()
    expect(heard).not.toHaveBeenCalled()
  })

  it('gives way to a selection the click just ended', () => {
    const { one, heard } = tapped()
    const selection = one.doc.defaultView!.getSelection()!
    selection.selectAllChildren(one.doc.body)
    one.click()
    expect(heard).not.toHaveBeenCalled()
  })

  it('is silent where there is no caret under the point', () => {
    const { one, heard } = tapped()
    one.aim(null)
    one.click()
    expect(heard).not.toHaveBeenCalled()
  })

  it('stops when unsubscribed, leaving another listener alone', () => {
    const { one, section, heard, off } = tapped()
    const other = vi.fn()
    section.onTap(other)
    off()
    one.click()
    expect(heard).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledTimes(1)
  })
})

describe('the pace', () => {
  const driver = () => createReadingSurface(source(null))

  it('is held until the last holder lets go', () => {
    const { surface, paceHeld } = driver()
    expect(paceHeld()).toBe(false)
    const one = surface.holdPace()
    expect(paceHeld(), 'synchronously').toBe(true)
    const two = surface.holdPace()
    one()
    expect(paceHeld(), 'one holder left').toBe(true)
    two()
    expect(paceHeld()).toBe(false)
  })

  it('does not let one holder release twice and free another’s hold', () => {
    const { surface, paceHeld } = driver()
    const one = surface.holdPace()
    const two = surface.holdPace()
    one()
    one()
    expect(paceHeld(), 'the second holder still has it').toBe(true)
    two()
    expect(paceHeld()).toBe(false)
    two()
    const three = surface.holdPace()
    expect(paceHeld(), 'and the count did not go below nothing').toBe(true)
    three()
    expect(paceHeld()).toBe(false)
  })

  it('tells a listener at each edge and nowhere between', () => {
    const { surface, subscribePace } = driver()
    const told = vi.fn()
    const off = subscribePace(told)
    const one = surface.holdPace()
    expect(told).toHaveBeenCalledTimes(1)
    const two = surface.holdPace()
    one()
    expect(told, 'still held throughout').toHaveBeenCalledTimes(1)
    two()
    expect(told).toHaveBeenCalledTimes(2)
    two()
    expect(told, 'a second release changes nothing').toHaveBeenCalledTimes(2)
    off()
    surface.holdPace()
    expect(told, 'unsubscribed').toHaveBeenCalledTimes(2)
  })
})

describe('a subscriber that throws', () => {
  /* The hold is taken from inside `speakDocument`, on its way to speaking, so a
     throw that came back through `holdPace` would stop a reading because a
     listener misbehaved. */
  const noisy = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  const broken = () => {
    throw new Error('a broken subscriber')
  }

  it('takes neither the pace nor the next subscriber with it, and is reported by name', () => {
    const logged = noisy()
    const { surface, paceHeld, subscribePace } = createReadingSurface(source(null))
    const after = vi.fn()
    subscribePace(broken)
    subscribePace(after)
    const release = surface.holdPace()
    expect(paceHeld()).toBe(true)
    expect(after).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0]?.[0]).toBe('Paper: a reading pace subscriber threw while being notified')
    release()
    expect(paceHeld()).toBe(false)
    expect(after).toHaveBeenCalledTimes(2)
    logged.mockRestore()
  })

  it('does not stop a commit from telling the chapter or the book', () => {
    const logged = noisy()
    const chapterIs = (open: boolean) => ({ ...NOTHING_TO_TURN, chapter: { can: () => open, go: () => open } })
    const driver = createReadingSurface(source(null, { paging: chapterIs(false) }))
    const chapter = vi.fn()
    const book = vi.fn()
    driver.surface.chapter.subscribe(broken)
    driver.surface.chapter.subscribe(chapter)
    driver.surface.subscribeBook(broken)
    driver.surface.subscribeBook(book)
    driver.commit(source(null, { paging: chapterIs(true), book: facts() }))
    expect(book).toHaveBeenCalledTimes(1)
    expect(chapter).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls.map(([line]) => line)).toEqual([
      'Paper: a ready book subscriber threw while being notified',
      'Paper: a chapter availability subscriber threw while being notified',
    ])
    logged.mockRestore()
  })
})

describe('chapter availability', () => {
  const steps = (back: boolean, forward: boolean, moved = true) => ({
    ...NOTHING_TO_TURN,
    chapter: { can: (by: 1 | -1) => (by === 1 ? forward : back), go: vi.fn(() => moved) },
  })

  it('answers for each direction', () => {
    const { surface } = createReadingSurface(source(null, { paging: steps(false, true) }))
    expect(surface.chapter.can(1)).toBe(true)
    expect(surface.chapter.can(-1)).toBe(false)
  })

  it('answers no, and moves nowhere, where the book has no chapter steps', () => {
    const { surface } = createReadingSurface(source(null))
    expect(surface.chapter.can(1)).toBe(false)
    expect(surface.chapter.go(1)).toBe(false)
  })

  it('says whether a step moved, in the direction it was asked', () => {
    const paging = steps(true, true, false)
    const { surface } = createReadingSurface(source(null, { paging }))
    expect(surface.chapter.go(-1)).toBe(false)
    expect(paging.chapter.go).toHaveBeenCalledExactlyOnceWith(-1)
  })

  it.each<[string, boolean, boolean]>([
    ['forward', true, true],
    ['back', false, false],
  ])('tells a listener when %s changes', (_direction, back, forward) => {
    const driver = createReadingSurface(source(null, { paging: steps(true, false) }))
    const told = vi.fn()
    driver.surface.chapter.subscribe(told)
    driver.commit(source(null, { paging: steps(back, forward) }))
    expect(told).toHaveBeenCalledTimes(1)
  })

  it('does not tell one when a commit changes nothing, and stops when unsubscribed', () => {
    const driver = createReadingSurface(source(null, { paging: steps(true, false) }))
    const told = vi.fn()
    const off = driver.surface.chapter.subscribe(told)
    driver.commit(source(null, { paging: steps(true, false) }))
    expect(told).not.toHaveBeenCalled()
    off()
    driver.commit(source(null, { paging: steps(false, true) }))
    expect(told).not.toHaveBeenCalled()
  })

  it('reaches what renders from it, without anything else re-rendering it', () => {
    let driver!: SurfaceDriver
    const seen: boolean[] = []
    function Child({ surface }: { surface: ReadingSurface }) {
      seen.push(useSyncExternalStore(surface.chapter.subscribe, () => surface.chapter.can(1)))
      return null
    }
    function Parent({ forward }: { forward: boolean }) {
      driver = useReadingSurface(source(null, { paging: steps(true, forward) }))
      return <Child surface={driver.surface} />
    }
    const view = render(<Parent forward={false} />)
    expect(seen.at(-1)).toBe(false)
    view.rerender(<Parent forward={true} />)
    expect(seen.at(-1), 'the child rendered before the commit, so it was told').toBe(true)
  })
})

describe('the book', () => {
  it('is nothing until it has both an identity and a document', () => {
    /* The id resolves from the bytes before the book is parsed, and a walk
       started then has no navigator to ask. */
    const current = () => 1
    expect(readyBookOf(facts({ doc: null }), current), 'an id alone').toBeNull()
    expect(readyBookOf(facts({ bookId: null }), current), 'a document alone').toBeNull()
    expect(readyBookOf(facts(), current), 'both').not.toBeNull()
  })

  it('carries what the book declares, and the language of its document', () => {
    const doc = document.implementation.createHTMLDocument('')
    doc.documentElement.setAttribute('lang', 'fr')
    const toc = [{ label: 'One', href: 'one.html' }]
    expect(readyBookOf(facts({ doc, toc, fixedLayout: true }), () => 1)).toMatchObject({
      bookId: 'book:1',
      title: 'Le Horla',
      author: 'Maupassant',
      lang: 'fr',
      toc,
      fixedLayout: true,
    })
  })

  it('names a book that declares nothing, and credits nobody rather than somebody wrong', () => {
    /* ⚠️ **SOMETHING A READER SEES IN A FILE NAME OR A PLAYER.** Both end up in the
       `.m4b`'s metadata and in Apple Books' library. */
    expect(readyBookOf(facts({ meta: null }), () => 1)).toMatchObject({ title: 'Audiobook', author: '' })
  })

  it('tells a listener when it becomes ready, and not when nothing changed', () => {
    const one = page('<p>Words.</p>')
    const unready = facts({ bookId: null, doc: one.doc })
    const driver = createReadingSurface(source(one.doc, { book: unready }))
    const told = vi.fn()
    const off = driver.surface.subscribeBook(told)
    expect(driver.surface.book()).toBeNull()
    driver.commit(source(one.doc, { book: unready }))
    expect(told, 'the same facts').not.toHaveBeenCalled()
    const ready = facts({ doc: one.doc })
    driver.commit(source(one.doc, { book: ready }))
    expect(told).toHaveBeenCalledTimes(1)
    expect(driver.surface.book()?.bookId).toBe('book:1')
    off()
    driver.commit(source(one.doc, { book: facts({ doc: one.doc }) }))
    expect(told, 'unsubscribed').toHaveBeenCalledTimes(1)
  })

  it('keeps one identity across a commit of the same facts', () => {
    const one = page('<p>Words.</p>')
    const same = facts({ doc: one.doc })
    const driver = createReadingSurface(source(one.doc, { book: same }))
    const before = driver.surface.book()
    driver.commit(source(one.doc, { book: same }))
    expect(driver.surface.book()).toBe(before)
  })
})

describe('a walk of the book', () => {
  const opened = (walk: BookFacts['sectionTexts']) => {
    const one = page('<p>Words.</p>')
    const driver = createReadingSurface(source(one.doc, { book: facts({ doc: one.doc, sectionTexts: walk }) }))
    return { one, driver, book: driver.surface.book()! }
  }
  const nextOpening = (one: { doc: Document }) => source(one.doc, { book: facts({ generation: 2, doc: one.doc }) })

  it('passes on the contents, the skip, and whether to stop', async () => {
    const walk = vi.fn<BookFacts['sectionTexts']>(async () => ({ sections: [], complete: true }))
    const { book } = opened(walk)
    let stop = false
    await expect(book.sectionTexts(() => stop, { notes: true })).resolves.toEqual({ sections: [], complete: true })
    const [toc, shouldStop, skip] = walk.mock.calls[0]!
    expect(toc).toBe(book.toc)
    expect(skip).toEqual({ notes: true })
    expect(shouldStop()).toBe(false)
    stop = true
    expect(shouldStop(), 'the export cancelling reaches the walk').toBe(true)
  })

  it('stops part way when the book is replaced under it', async () => {
    /* ⚠️ **OR THE NEXT BOOK'S TEXT WOULD BE FILED UNDER THIS ONE'S TITLE.** */
    let shouldStop = (): boolean => false
    const { one, driver, book } = opened(async (_toc, stop) => {
      shouldStop = stop
      return { sections: [], complete: false }
    })
    await book.sectionTexts(() => false, NO_NOTES)
    expect(shouldStop()).toBe(false)
    driver.commit(nextOpening(one))
    expect(shouldStop()).toBe(true)
  })

  it('walks nothing, and says so, if the book had already been replaced', async () => {
    const walk = vi.fn<BookFacts['sectionTexts']>(async () => ({ sections: [], complete: true }))
    const { one, driver, book } = opened(walk)
    driver.commit(nextOpening(one))
    await expect(book.sectionTexts(() => false, NO_NOTES)).resolves.toEqual({ sections: [], complete: false })
    expect(walk).not.toHaveBeenCalled()
  })

  it('calls a finished walk incomplete if the book was replaced while it ran', async () => {
    let driver: ReturnType<typeof opened>['driver'] | null = null
    const sections = [{ text: 'Words.' }] as never
    const walk = vi.fn<BookFacts['sectionTexts']>(async () => {
      driver!.commit(nextOpening(one))
      return { sections, complete: true }
    })
    const made = opened(walk)
    const one = made.one
    driver = made.driver
    await expect(made.book.sectionTexts(() => false, NO_NOTES)).resolves.toEqual({ sections, complete: false })
  })

  it('keeps an incomplete walk incomplete with the book unchanged', async () => {
    const sections = [{ text: 'Words.' }] as never
    const { book } = opened(async () => ({ sections, complete: false }))
    await expect(book.sectionTexts(() => false, NO_NOTES)).resolves.toEqual({ sections, complete: false })
  })

  it('survives a chapter turn, which is the same opening', async () => {
    const walk = vi.fn<BookFacts['sectionTexts']>(async () => ({ sections: [], complete: true }))
    const { driver, book } = opened(walk)
    const elsewhere = page('<p>Later.</p>')
    driver.commit(source(elsewhere.doc, { book: facts({ doc: elsewhere.doc }) }))
    await expect(book.sectionTexts(() => false, NO_NOTES)).resolves.toMatchObject({ complete: true })
    expect(walk).toHaveBeenCalledTimes(1)
  })
})

/**
 * ⚠️ **THE ORDER THE WHOLE MOVE RESTS ON, PINNED SO THAT A REACT UPGRADE OR A
 * CHANGE TO `useReadingSurface` THAT BROKE IT WOULD SAY SO.** A child's effects run
 * before its parent's, and the reading is a child.
 */
describe('a child of what commits the surface', () => {
  function run(first: Document, second: Document) {
    const made: { section?: SpokenSection | null } = {}
    function Child({ surface, doc }: { surface: ReadingSurface; doc: Document }) {
      useEffect(() => {
        if (doc === second) made.section = surface.speakable(NO_NOTES)
      }, [doc, surface])
      return null
    }
    function Parent({ doc }: { doc: Document }) {
      const { surface } = useReadingSurface(source(doc))
      return <Child surface={surface} doc={doc} />
    }
    const view = render(<Parent doc={first} />)
    view.rerender(<Parent doc={second} />)
    return { made }
  }

  it('sees the incoming document from its passive effect, in the commit that brought it', () => {
    const one = page('<p>The old words.</p>')
    const two = page('<p>The new words.</p>')
    const { made } = run(one.doc, two.doc)
    expect(made.section?.text).toContain('new')
    expect(made.section?.live(), 'and it is live at once').toBe(true)
  })

  it('still sees the outgoing one from its layout effect, which is why none may ask', () => {
    const seen: Array<string | undefined> = []
    const one = page('<p>The old words.</p>')
    const two = page('<p>The new words.</p>')
    function Child({ surface, doc }: { surface: ReadingSurface; doc: Document }) {
      useLayoutEffect(() => {
        seen.push(surface.speakable(NO_NOTES)?.text)
      }, [doc, surface])
      return null
    }
    function Parent({ doc }: { doc: Document }) {
      const { surface } = useReadingSurface(source(doc))
      return <Child surface={surface} doc={doc} />
    }
    const view = render(<Parent doc={one.doc} />)
    view.rerender(<Parent doc={two.doc} />)
    expect(seen.at(-1)).toContain('old')
  })

  it('keeps one surface for the life of the component', () => {
    const seen = new Set<ReadingSurface>()
    function Parent({ doc }: { doc: Document }) {
      seen.add(useReadingSurface(source(doc)).surface)
      return null
    }
    const one = page('<p>a</p>')
    const view = render(<Parent doc={one.doc} />)
    view.rerender(<Parent doc={page('<p>b</p>').doc} />)
    expect(seen.size).toBe(1)
  })

  it('does not take a render React threw away', () => {
    /* ⚠️ **WHY THE WRITE IS IN AN EFFECT AND NOT IN THE RENDER** (audit round 1,
       #505): a render that never commits must leave the surface where it was. */
    const one = page('<p>The old words.</p>')
    const two = page('<p>The new words.</p>')
    let surface!: ReadingSurface
    let bad!: (doc: Document) => void
    function Bomb({ doc }: { doc: Document }) {
      if (doc === two.doc) throw new Error('abandoned')
      return null
    }
    function Parent() {
      const [doc, setDoc] = useState(one.doc)
      bad = setDoc
      surface = useReadingSurface(source(doc)).surface
      return <Bomb doc={doc} />
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Parent />)
    const before = surface.speakable(NO_NOTES)!
    expect(() => act(() => bad(two.doc))).toThrow('abandoned')
    expect(before.live()).toBe(true)
    quiet.mockRestore()
  })
})
