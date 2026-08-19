import { describe, expect, it } from 'vitest'
import { tagKey } from './library'
import {
  parseQuery,
  withExcludedTag,
  withStatus,
  withTag,
  withUntagged,
  withoutTag,
} from './searchQuery'

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
    expect(parse('moby dick')).toEqual({ tags: [], excluded: [], status: null, untagged: false, text: 'moby dick' })
  })

  it('pulls one tag out and leaves the text', () => {
    expect(parse('tag:Sea whales')).toEqual({ tags: ['Sea'], excluded: [], status: null, untagged: false, text: 'whales' })
  })

  it('takes several tags', () => {
    expect(parse('tag:Sea tag:Classics').tags).toEqual(['Sea', 'Classics'])
  })

  it('finds a tag written after the text', () => {
    expect(parse('whales tag:Sea')).toEqual({ tags: ['Sea'], excluded: [], status: null, untagged: false, text: 'whales' })
  })

  /* A tag with a space in it is ordinary — "Book club", "To reread". */
  it('takes a quoted tag with a space in it', () => {
    expect(parse('tag:"Book club" notes')).toEqual({ tags: ['Book club'], excluded: [], status: null, untagged: false, text: 'notes' })
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
    expect(parse('tag:')).toEqual({ tags: [], excluded: [], status: null, untagged: false, text: '' })
    expect(parse('tag:"" whales')).toEqual({ tags: [], excluded: [], status: null, untagged: false, text: 'whales' })
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
    expect(parseQuery('tag:"Book club', key)).toEqual({ tags: [], excluded: [], status: null, untagged: false, text: '' })
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

/* `is:` — the status axis, beside `tag:`. Same field, same discipline: what
 * the reader can see is the whole query. */
describe('is:', () => {
  const key = (t: string) => t.toLowerCase()

  it('pulls a status out and leaves the text', () => {
    expect(parseQuery('is:reading whales', key)).toEqual({ tags: [], excluded: [], status: 'reading', untagged: false, text: 'whales' })
  })

  it('accepts all three, case-insensitively', () => {
    expect(parseQuery('IS:Unread', key).status).toBe('unread')
    expect(parseQuery('is:FINISHED', key).status).toBe('finished')
  })

  it('is null when no status was named', () => {
    expect(parseQuery('whales tag:Sea', key).status).toBeNull()
  })

  /* A reader mid-word has not asked for anything yet — same rule as `tag:`. */
  it('drops a bare `is:` rather than searching for the word', () => {
    expect(parseQuery('is: whales', key)).toEqual({ tags: [], excluded: [], status: null, untagged: false, text: 'whales' })
  })

  /* An unknown value is not a status. It stays as text, which is the honest
   * reading: the reader typed it, and the shelf should say nothing matches
   * rather than silently ignore what they wrote. */
  it('leaves an unknown value as text', () => {
    expect(parseQuery('is:banana', key)).toEqual({ tags: [], excluded: [], status: null, untagged: false, text: 'is:banana' })
  })

  it('composes with tags and text in any order', () => {
    const p = parseQuery('whales is:reading tag:Sea', key)
    expect(p).toEqual({ tags: ['Sea'], excluded: [], status: 'reading', untagged: false, text: 'whales' })
  })

  it('last status wins, since a book has only one', () => {
    expect(parseQuery('is:unread is:finished', key).status).toBe('finished')
  })

  describe('withStatus', () => {
    it('sets a status on an empty field', () => {
      expect(withStatus('', 'reading')).toBe('is:reading')
    })
    it('keeps what was typed', () => {
      expect(withStatus('whales tag:Sea', 'unread')).toBe('is:unread whales tag:Sea')
    })
    it('replaces rather than adds — one status at a time', () => {
      expect(withStatus('is:reading whales', 'finished')).toBe('is:finished whales')
    })
    it('clears with null and does not leave a hole', () => {
      expect(withStatus('whales is:reading tag:Sea', null)).toBe('whales tag:Sea')
    })
    it('round-trips through parseQuery', () => {
      const q = withStatus(withTag('', 'Sea', key), 'reading')
      expect(parseQuery(q, key)).toEqual({ tags: ['Sea'], excluded: [], status: 'reading', untagged: false, text: '' })
    })
  })
})

/* `-tag:` — the minus every search box a reader knows agrees on. It composes
 * with the rest, and a tag cannot be both required and excluded. */
describe('-tag:', () => {
  it('pulls an excluded tag out and leaves the text', () => {
    expect(parse('-tag:Abandoned whales')).toEqual({
      tags: [],
      excluded: ['Abandoned'],
      status: null,
      untagged: false,
      text: 'whales',
    })
  })

  it('keeps required and excluded apart', () => {
    const p = parse('tag:Sea -tag:Abandoned')
    expect(p.tags).toEqual(['Sea'])
    expect(p.excluded).toEqual(['Abandoned'])
  })

  it('takes a quoted excluded tag', () => {
    expect(parse('-tag:"Book club"').excluded).toEqual(['Book club'])
  })

  it('deduplicates by key, like tag:', () => {
    expect(parse('-tag:Sea -tag:sea').excluded).toEqual(['Sea'])
  })

  /* A minus with nothing after it is a reader mid-word, not a request. */
  it('drops an empty term', () => {
    expect(parse('-tag: whales').text).toBe('whales')
    expect(parse('-tag: whales').excluded).toEqual([])
  })

  /* A minus INSIDE a word is not the grammar: `re-tag:Sea` is text. */
  it('only reads the minus at the start of a term', () => {
    expect(parse('re-tag:Sea')).toEqual({
      tags: [],
      excluded: [],
      status: null,
      untagged: false,
      text: 're-tag:Sea',
    })
  })

  describe('withExcludedTag', () => {
    it('writes -tag: at the front', () => {
      expect(withExcludedTag('whales', 'Sea', tagKey)).toBe('-tag:Sea whales')
    })
    it('quotes when it must', () => {
      expect(withExcludedTag('', 'Book club', tagKey)).toBe('-tag:"Book club"')
    })
    it('is idempotent', () => {
      expect(withExcludedTag('-tag:Sea', 'sea', tagKey)).toBe('-tag:Sea')
    })
    /* The reader's latest word stands: excluding a tag that was required lifts
     * the requirement rather than leaving a query no book can satisfy. */
    it('lifts a requirement on the same tag', () => {
      expect(withExcludedTag('tag:Sea whales', 'Sea', tagKey)).toBe('-tag:Sea whales')
    })
    it('and withTag lifts an exclusion the same way', () => {
      expect(withTag('-tag:Sea whales', 'Sea', tagKey)).toBe('tag:Sea whales')
    })
  })

  /* One chip clears one tag, whichever form it was said in. */
  it('withoutTag lifts the excluded form too', () => {
    expect(withoutTag('-tag:Sea whales', 'Sea', tagKey)).toBe('whales')
    expect(withoutTag('tag:Sea -tag:Poetry', 'poetry', tagKey)).toBe('tag:Sea')
  })

  it('round-trips', () => {
    const q = withExcludedTag(withTag('', 'Sea', tagKey), 'Poetry', tagKey)
    expect(parse(q)).toEqual({
      tags: ['Sea'],
      excluded: ['Poetry'],
      status: null,
      untagged: false,
      text: '',
    })
  })
})

/* A hand-typed contradiction: the SAME tag required and excluded. The parser
 * resolves it — last term wins — because a scope requiring what it excludes
 * matches nothing, and the shelf emptied with both chips lit. */
describe('the same tag in both forms', () => {
  it('lets the later exclusion win', () => {
    const p = parse('tag:Sea -tag:Sea')
    expect(p.tags).toEqual([])
    expect(p.excluded).toEqual(['Sea'])
  })

  it('lets the later requirement win', () => {
    const p = parse('-tag:Sea tag:Sea')
    expect(p.tags).toEqual(['Sea'])
    expect(p.excluded).toEqual([])
  })

  it('resolves by key, not by spelling', () => {
    const p = parse('tag:Sea -tag:sea')
    expect(p.tags).toEqual([])
    expect(p.excluded).toEqual(['sea'])
  })

  it('the very last word stands across three terms', () => {
    const p = parse('tag:Sea -tag:Sea tag:Sea')
    expect(p.tags).toEqual(['Sea'])
    expect(p.excluded).toEqual([])
  })

  /* The writers clean the TEXT, not only the parse. The parse resolves the
   * contradiction by last-wins, so judged through it alone the stale losing
   * term stayed in the field — a term the field was then lying about. */
  it('withTag rebuilds a query whose text still carries the exclusion', () => {
    expect(withTag('-tag:Sea tag:Sea whales', 'Sea', tagKey)).toBe('tag:Sea whales')
  })

  it('withExcludedTag rebuilds a query whose text still carries the requirement', () => {
    expect(withExcludedTag('tag:Sea -tag:Sea whales', 'Sea', tagKey)).toBe('-tag:Sea whales')
  })
})

/* A quoted tag ending in a lone backslash: the reader is mid-escape. The term
 * is dropped whole — the `\` used to leak into free text and search titles. */
describe('a dangling backslash in a quoted tag', () => {
  it('is dropped with its term, not leaked into the text', () => {
    expect(parse('tag:"abc\\')).toEqual({
      tags: [],
      excluded: [],
      status: null,
      untagged: false,
      text: '',
    })
  })

  it('leaves the surrounding text intact', () => {
    expect(parse('moby tag:"abc\\').text).toBe('moby')
  })
})

/* The whitespace INSIDE a quoted tag is the tag's own. The old global collapse
 * rewrote `tag:"A  B"` while clearing an unrelated term, silently scoping the
 * shelf to a different tag. */
describe('whitespace inside a quoted tag', () => {
  it('survives clearing a status', () => {
    expect(withStatus('is:reading tag:"A  B"', null)).toBe('tag:"A  B"')
  })

  it('survives removing another tag', () => {
    expect(withoutTag('tag:Sea tag:"A  B"', 'Sea', tagKey)).toBe('tag:"A  B"')
  })

  it('survives withUntagged', () => {
    expect(withUntagged('is:untagged tag:"A  B"', false)).toBe('tag:"A  B"')
  })
})

/* `is:untagged` — spelt with the status prefix because it reads as a state of
 * the book, but NOT a status: it does not displace one, and `withStatus`
 * leaves it alone. */
describe('is:untagged', () => {
  it('is a flag beside the status, not instead of it', () => {
    expect(parse('is:untagged is:reading whales')).toEqual({
      tags: [],
      excluded: [],
      status: 'reading',
      untagged: true,
      text: 'whales',
    })
  })

  it('is case-insensitive', () => {
    expect(parse('IS:Untagged').untagged).toBe(true)
  })

  it('withStatus does not touch it', () => {
    expect(withStatus('is:untagged whales', 'reading')).toBe('is:reading is:untagged whales')
    expect(withStatus('is:reading is:untagged', null)).toBe('is:untagged')
  })

  describe('withUntagged', () => {
    it('sets it once', () => {
      expect(withUntagged('whales', true)).toBe('is:untagged whales')
      expect(withUntagged('is:untagged whales', true)).toBe('is:untagged whales')
    })
    it('clears it without leaving a hole', () => {
      expect(withUntagged('whales is:untagged tag:Sea', false)).toBe('whales tag:Sea')
    })
    it('round-trips', () => {
      expect(parse(withUntagged('', true))).toEqual({
        tags: [],
        excluded: [],
        status: null,
        untagged: true,
        text: '',
      })
    })
  })
})
