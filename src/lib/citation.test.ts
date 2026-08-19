import { describe, expect, it } from 'vitest'
import { citation, type Source } from './citation'

const SOURCE: Source = {
  title: 'On China',
  author: 'Henry Kissinger',
  chapter: 'Preface',
  page: 0,
  fraction: 0.02,
}

const source = (over: Partial<Source> = {}): Source => ({ ...SOURCE, ...over })

describe('the quote', () => {
  it('is wrapped in the typographic pair, not the typewriter one', () => {
    expect(citation('Call me Ishmael.', source())).toContain('“Call me Ishmael.”')
  })

  it('collapses the source document’s own wrapping', () => {
    /* A selection crossing a line break carries the book's line width with it,
       which has nothing to do with the width of wherever it lands. */
    const text = 'Forty years ago\n  almost to the day,\nPresident Nixon'
    expect(citation(text, source())).toContain('“Forty years ago almost to the day, President Nixon”')
  })

  it('leaves a line of dialogue exactly as the book set it', () => {
    /* The commonest quoted passage there is, and the one both obvious rules
       get wrong: re-wrapping doubles the opening mark, and stripping the outer
       pair takes the dialogue's opener while leaving its closer behind. */
    const line = '“Call me Ishmael,” he said.'
    expect(citation(line, source())).toBe(
      '“Call me Ishmael,” he said.\n\n— Henry Kissinger, On China, Preface',
    )
  })

  it('does not wrap a passage that is already a whole quotation', () => {
    expect(citation('“Call me Ishmael.”', source())).not.toContain('““')
    expect(citation('“Call me Ishmael.”', source())).toContain('“Call me Ishmael.”')
  })

  it('leaves a book that sets dialogue in straight or single marks alone', () => {
    expect(citation('"Call me Ishmael."', source())).toContain('"Call me Ishmael."')
    expect(citation('‘Call me Ishmael.’', source())).toContain('‘Call me Ishmael.’')
  })

  it('still wraps ordinary prose', () => {
    expect(citation('Call me Ishmael.', source())).toContain('“Call me Ishmael.”')
  })

  it('puts a blank line between the quote and the attribution', () => {
    // A single newline is a soft wrap in most editors; a blank line is a break.
    expect(citation('A passage.', source())).toBe(
      '“A passage.”\n\n— Henry Kissinger, On China, Preface',
    )
  })
})

describe('the locator', () => {
  it('prefers the page when the book has pages', () => {
    expect(citation('A passage.', source({ page: 12 }))).toContain(
      '— Henry Kissinger, On China, p. 12',
    )
  })

  it('falls back to the chapter for reflowable text, which has no page', () => {
    expect(citation('A passage.', source({ page: 0 }))).toContain('On China, Preface')
  })

  it('falls back to the proportion when there is no chapter either', () => {
    // A PDF with no outline: nothing else can say where in the book this was.
    expect(citation('A passage.', source({ chapter: '', fraction: 0.31 }))).toContain(
      'On China, 31%',
    )
  })

  it('offers no locator at all at the very start rather than “0%”', () => {
    expect(citation('A passage.', source({ chapter: '', fraction: 0 }))).toBe(
      '“A passage.”\n\n— Henry Kissinger, On China',
    )
  })

  it('survives a fraction that is not a number', () => {
    const broken = source({ chapter: '', fraction: Number.NaN })
    expect(citation('A passage.', broken)).toBe('“A passage.”\n\n— Henry Kissinger, On China')
  })

  it('clamps a fraction past the end', () => {
    expect(citation('A passage.', source({ chapter: '', fraction: 4 }))).toContain('100%')
  })
})

describe('what is missing', () => {
  it('omits an author the book does not declare', () => {
    expect(citation('A passage.', source({ author: '' }))).toBe(
      '“A passage.”\n\n— On China, Preface',
    )
  })

  it('omits a title the book does not declare', () => {
    expect(citation('A passage.', source({ title: '' }))).toBe(
      '“A passage.”\n\n— Henry Kissinger, Preface',
    )
  })

  it('gives no dangling dash when there is nothing to attribute to', () => {
    /* An em dash alone under a quote reads as the app having LOST the source,
       which sends the reader looking for something that was never there. */
    const nothing = source({ title: '', author: '', chapter: '', fraction: 0 })
    expect(citation('A passage.', nothing)).toBe('“A passage.”')
  })

  it('gives the attribution alone when the passage is empty', () => {
    expect(citation('   ', source())).toBe('— Henry Kissinger, On China, Preface')
  })

  it('gives an empty string when there is neither', () => {
    const nothing = source({ title: '', author: '', chapter: '', fraction: 0 })
    expect(citation('', nothing)).toBe('')
  })

  it('ignores fields that are only whitespace', () => {
    expect(citation('A passage.', source({ author: '   ', chapter: '  ' }))).toBe(
      '“A passage.”\n\n— On China, 2%',
    )
  })
})
