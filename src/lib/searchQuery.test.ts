import { describe, expect, it } from 'vitest'
import { tagKey } from './library'
import { parseQuery, withTag, withoutTag } from './searchQuery'

/**
 * The query IS the scope, which is what let collections go away.
 *
 * A collection was a saved scope. A tag already persists and already scopes, so
 * the only thing missing was a way to say WHICH tags — and a text field says it
 * better than hidden state, because the reader can see, edit and correct it.
 */

const parse = (raw: string) => parseQuery(raw, tagKey)

describe('parseQuery', () => {
  it('is all text when there are no tags', () => {
    expect(parse('moby dick')).toEqual({ tags: [], text: 'moby dick' })
  })

  it('pulls one tag out and leaves the text', () => {
    expect(parse('tag:Sea whales')).toEqual({ tags: ['Sea'], text: 'whales' })
  })

  it('takes several tags', () => {
    expect(parse('tag:Sea tag:Classics').tags).toEqual(['Sea', 'Classics'])
  })

  it('finds a tag written after the text', () => {
    expect(parse('whales tag:Sea')).toEqual({ tags: ['Sea'], text: 'whales' })
  })

  /* A tag with a space in it is ordinary — "Book club", "To reread". */
  it('takes a quoted tag with a space in it', () => {
    expect(parse('tag:"Book club" notes')).toEqual({ tags: ['Book club'], text: 'notes' })
  })

  it('is case-insensitive about the prefix itself', () => {
    expect(parse('TAG:Sea').tags).toEqual(['Sea'])
  })

  /* Folded, so `tag:Sea tag:sea` is one restriction rather than two that can
   * never both be satisfied by a book storing only one spelling. */
  it('deduplicates tags that fold together', () => {
    expect(parse('tag:Sea tag:sea').tags).toEqual(['Sea'])
  })

  /**
   * The reader is midway through typing.
   *
   * They have not asked for anything yet, and matching the literal string
   * "tag:" against titles would empty the shelf under their hands.
   */
  it('drops an empty term rather than searching for the word "tag:"', () => {
    expect(parse('tag:')).toEqual({ tags: [], text: '' })
    expect(parse('tag:"" whales')).toEqual({ tags: [], text: 'whales' })
  })

  /* Removing a middle term must not weld the words on either side together. */
  it('does not join the text around a removed term', () => {
    expect(parse('moby tag:Sea dick').text).toBe('moby dick')
  })
})

describe('withTag', () => {
  it('adds a tag to an empty field', () => {
    expect(withTag('', 'Sea', tagKey)).toBe('tag:Sea')
  })

  it('keeps what was already typed', () => {
    expect(withTag('whales', 'Sea', tagKey)).toBe('tag:Sea whales')
  })

  /* Clicking a chip twice is not an error state. */
  it('does not add a tag that is already there', () => {
    expect(withTag('tag:Sea whales', 'sea', tagKey)).toBe('tag:Sea whales')
  })

  /* Quoted only when it must be: `tag:Sea` reads better than `tag:"Sea"`, and
   * the reader is going to see this. */
  it('quotes only a tag that needs it', () => {
    expect(withTag('', 'Book club', tagKey)).toBe('tag:"Book club"')
  })
})

describe('withoutTag', () => {
  it('takes a tag back out', () => {
    expect(withoutTag('tag:Sea whales', 'Sea', tagKey)).toBe('whales')
  })

  it('removes it whatever case the chip was in', () => {
    expect(withoutTag('tag:Sea whales', 'sea', tagKey)).toBe('whales')
  })

  it('leaves the other tags alone', () => {
    expect(withoutTag('tag:Sea tag:Classics', 'Sea', tagKey)).toBe('tag:Classics')
  })

  it('handles a quoted tag', () => {
    expect(withoutTag('tag:"Book club" notes', 'Book club', tagKey)).toBe('notes')
  })

  it('does nothing for a tag that is not in the query', () => {
    expect(withoutTag('tag:Sea', 'Poetry', tagKey)).toBe('tag:Sea')
  })
})

describe('round trip', () => {
  /* What a reader clicks and what they type must produce the same thing, or the
   * field and the chips are two sources of truth that can disagree. */
  it('adds and removes back to where it started', () => {
    const start = 'whales'
    const added = withTag(start, 'Sea', tagKey)
    expect(withoutTag(added, 'Sea', tagKey)).toBe(start)
  })

  it('survives several tags added and removed in any order', () => {
    let q = ''
    q = withTag(q, 'Sea', tagKey)
    q = withTag(q, 'Classics', tagKey)
    expect(parse(q).tags).toHaveLength(2)
    q = withoutTag(q, 'Sea', tagKey)
    expect(parse(q).tags).toEqual(['Classics'])
  })
})

/**
 * A tag containing a double quote.
 *
 * `withTag` used to DELETE the quote, which produced a perfectly well-formed
 * query for a different tag — `He said "Hi"` searched for `He said Hi` — so the
 * chip appeared, the shelf emptied, and nothing on screen could explain it.
 */
describe('a tag with a quote in it', () => {
  const key = (t: string) => t.trim().toLowerCase()

  it('round-trips through the query it writes', () => {
    const tag = 'He said "Hi"'
    const query = withTag('', tag, key)
    expect(parseQuery(query, key).tags).toEqual([tag])
  })

  it('round-trips one with a backslash too', () => {
    const tag = 'C:\\Books'
    expect(parseQuery(withTag('', tag, key), key).tags).toEqual([tag])
  })

  it('can be taken back out again', () => {
    const tag = 'He said "Hi"'
    expect(withoutTag(withTag('moby', tag, key), tag, key).trim()).toBe('moby')
  })

  it('still leaves a plain tag unquoted', () => {
    expect(withTag('', 'Sea', key)).toBe('tag:Sea')
  })
})

/**
 * A tag term the reader has not finished typing.
 *
 * It went wrong twice. First the quoted alternative failed outright, the bare
 * one matched, and `tag:"Book club` searched for a tag called `"Book` with
 * `club` as free text. Then, made optional, it became an ACTIVE tag `Book club`
 * — a complete wrong answer applied mid-keystroke. Both empty the shelf under
 * somebody's hands for a reason nothing on screen can explain.
 */
describe('an unterminated quoted tag', () => {
  const key = (t: string) => t.trim().toLowerCase()

  it('is dropped rather than applied', () => {
    expect(parseQuery('tag:"Book club', key)).toEqual({ tags: [], text: '' })
  })

  it('does not leak the opening quote into the text', () => {
    expect(parseQuery('moby tag:"Book club', key).text).toBe('moby')
  })

  it('applies the moment the quote is closed', () => {
    expect(parseQuery('tag:"Book club"', key).tags).toEqual(['Book club'])
  })

  it('leaves the other tags in the query alone', () => {
    expect(parseQuery('tag:Sea tag:"Book clu', key).tags).toEqual(['Sea'])
  })

  /* Nothing to remove, so `withoutTag` must leave the half-typed term where it
   * is rather than swallowing what the reader is still writing. */
  it('survives withoutTag untouched', () => {
    expect(withoutTag('tag:"Book clu', 'Book club', key)).toBe('tag:"Book clu')
  })
})
