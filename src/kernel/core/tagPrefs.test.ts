import { describe, expect, it } from 'vitest'
import {
  NO_TAG_PREFS,
  colourOf,
  isHidden,
  isPinned,
  parseTagPrefs,
  pinnedFirst,
  removeView,
  renameView,
  saveView,
  setTagColour,
  shownSubjects,
  toggleHiddenSubject,
  togglePinned,
} from './tagPrefs'

const row = (tag: string) => ({ tag })

describe('pinning', () => {
  it('pins and unpins by key, not by spelling', () => {
    /* `Philosophy` and `philosophy` are one tag everywhere else; a preference
       about one that did not apply to the other would be a second tag. */
    const pinned = togglePinned(NO_TAG_PREFS, 'Philosophy')
    expect(isPinned(pinned, 'philosophy')).toBe(true)
    expect(isPinned(togglePinned(pinned, 'PHILOSOPHY'), 'Philosophy')).toBe(false)
  })

  it('keeps the order the reader pinned them in', () => {
    let prefs = togglePinned(NO_TAG_PREFS, 'Sea')
    prefs = togglePinned(prefs, 'Whales')
    const rows = [row('Novels'), row('Whales'), row('Sea')]
    expect(pinnedFirst(rows, prefs).map((r) => r.tag)).toEqual(['Sea', 'Whales', 'Novels'])
  })

  it('leaves the incoming order alone within each group', () => {
    /* The rows arrive already ordered by count or by name — the reader's own
       control — and pinning must not disturb that among the rest. */
    const prefs = togglePinned(NO_TAG_PREFS, 'Sea')
    const rows = [row('A'), row('Sea'), row('B'), row('C')]
    expect(pinnedFirst(rows, prefs).map((r) => r.tag)).toEqual(['Sea', 'A', 'B', 'C'])
  })

  it('is a no-op with nothing pinned', () => {
    const rows = [row('A'), row('B')]
    expect(pinnedFirst(rows, NO_TAG_PREFS).map((r) => r.tag)).toEqual(['A', 'B'])
  })
})

describe('colouring', () => {
  it('sets and clears a colour by key', () => {
    const green = setTagColour(NO_TAG_PREFS, 'Sea', 'green')
    expect(colourOf(green, 'SEA')).toBe('green')
    expect(colourOf(setTagColour(green, 'sea', null), 'Sea')).toBeNull()
  })

  it('has no colour by default, which is not the same as yellow', () => {
    expect(colourOf(NO_TAG_PREFS, 'Sea')).toBeNull()
  })

  it('returns the same object when nothing moves, so nothing is written', () => {
    const green = setTagColour(NO_TAG_PREFS, 'Sea', 'green')
    expect(setTagColour(green, 'Sea', 'green')).toBe(green)
  })
})

describe('hiding a publisher’s subject', () => {
  it('hides and shows again by key', () => {
    const hidden = toggleHiddenSubject(NO_TAG_PREFS, 'Business & Economics')
    expect(isHidden(hidden, 'business & economics')).toBe(true)
    expect(shownSubjects([row('Business & Economics'), row('History')], hidden).map((r) => r.tag)).toEqual(['History'])
  })

  it('shows everything when nothing is hidden', () => {
    expect(shownSubjects([row('A'), row('B')], NO_TAG_PREFS)).toHaveLength(2)
  })
})

describe('saved views', () => {
  it('keeps a name and a query', () => {
    const prefs = saveView(NO_TAG_PREFS, 'v1', 'Currently', 'is:reading -tag:Abandoned')
    expect(prefs.views).toEqual([{ id: 'v1', name: 'Currently', query: 'is:reading -tag:Abandoned' }])
  })

  it('replaces a view of the same name rather than duplicating it', () => {
    /* Saving "Reading" twice means the reader is revising it. Two rows with one
       name is a list nobody can use. */
    const first = saveView(NO_TAG_PREFS, 'v1', 'Reading', 'is:reading')
    const again = saveView(first, 'v2', 'reading', 'is:reading -tag:Abandoned')
    expect(again.views).toHaveLength(1)
    expect(again.views[0]?.query).toBe('is:reading -tag:Abandoned')
  })

  it('refuses a view with no name or no query', () => {
    expect(saveView(NO_TAG_PREFS, 'v1', '  ', 'is:reading').views).toEqual([])
    expect(saveView(NO_TAG_PREFS, 'v1', 'Empty', '   ').views).toEqual([])
  })

  it('renames and removes by id, so a rename is not a new row', () => {
    const prefs = saveView(NO_TAG_PREFS, 'v1', 'Reading', 'is:reading')
    expect(renameView(prefs, 'v1', 'Current').views[0]).toEqual({
      id: 'v1',
      name: 'Current',
      query: 'is:reading',
    })
    expect(removeView(prefs, 'v1').views).toEqual([])
    expect(removeView(prefs, 'nope')).toBe(prefs)
  })
})

describe('reading a file nobody can vouch for', () => {
  it('returns nothing set for an absent or broken file', () => {
    for (const bad of [null, '', 'not json', '[]', 'null', '42']) {
      expect(parseTagPrefs(bad), String(bad)).toEqual(NO_TAG_PREFS)
    }
  })

  it('keeps the parts it recognises and drops the rest', () => {
    const got = parseTagPrefs(
      JSON.stringify({
        pinned: ['Sea', 42, 'sea', ''],
        colours: { Sea: 'green', Whales: 'octarine', '': 'yellow' },
        hiddenSubjects: 'not a list',
        views: [
          { id: 'v1', name: 'Reading', query: 'is:reading' },
          { id: 'v2', name: 'No query' },
          { name: 'No id', query: 'x' },
          { id: 'v1', name: 'Duplicate id', query: 'y' },
        ],
      }),
    )
    // Folded and de-duplicated, like every other tag list.
    expect(got.pinned).toEqual(['sea'])
    expect(got.colours).toEqual({ sea: 'green' })
    expect(got.hiddenSubjects).toEqual([])
    expect(got.views).toEqual([{ id: 'v1', name: 'Reading', query: 'is:reading' }])
  })

  it('refuses a colour outside the mark tints', () => {
    /* A tag's colour and a highlight's colour are the same vocabulary. A second
       palette here would put two unrelated sets of colour words in one app. */
    expect(parseTagPrefs(JSON.stringify({ colours: { Sea: 'crimson' } })).colours).toEqual({})
  })
})
