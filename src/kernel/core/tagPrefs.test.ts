import { describe, expect, it } from 'vitest'
import {
  NO_TAG_PREFS,
  TAG_PREFS_STORAGE_KEY,
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

  /* ⚠️ **AND IT READS NOTHING TO DO IT**, which is what makes the shortcut a
     branch the gate can hold rather than one it must exempt. Counted here
     because a review counted it after the branch had been deleted as
     unobservable: on a shelf of about two thousand books that is two thousand
     tags folded on every prune, and a `tag` getter that throws would escape. */
  it('reads no row’s tag when nothing is pinned, and nothing is hidden', () => {
    const reads = { tag: 0 }
    const counted = (tag: string) => ({
      get tag() {
        reads.tag += 1
        return tag
      },
    })
    const rows = [counted('A'), counted('B')]

    /* Identity, never `toEqual`: a deep compare reads the getters itself and
       would answer the question with its own reads. */
    const pinned = pinnedFirst(rows, NO_TAG_PREFS)
    const shown = shownSubjects(rows, NO_TAG_PREFS)

    expect(reads.tag).toBe(0)
    expect(pinned).toHaveLength(2)
    expect(pinned[0]).toBe(rows[0])
    expect(pinned[1]).toBe(rows[1])
    expect(shown).toHaveLength(2)
    expect(shown[0]).toBe(rows[0])

    /* Non-vacuous: with a pin, the tags ARE read. */
    pinnedFirst(rows, togglePinned(NO_TAG_PREFS, 'A'))
    expect(reads.tag).toBeGreaterThan(0)
  })

  it('unpins one tag and keeps the rest', () => {
    const two = togglePinned(togglePinned(NO_TAG_PREFS, 'Sea'), 'Whales')
    expect(togglePinned(two, 'sea').pinned).toEqual(['whales'])
  })

  it('refuses a tag that is nothing but space', () => {
    expect(togglePinned(NO_TAG_PREFS, '   ')).toBe(NO_TAG_PREFS)
  })

  /* THREE, AND IN EVERY ARRIVAL ORDER. Two pins sort the same under a comparator
     that ignores the left-hand rank; three arriving in the order they were
     pinned do not. */
  it('ranks three pins in the order they were pinned, whatever order the rows arrive in', () => {
    const prefs = togglePinned(togglePinned(togglePinned(NO_TAG_PREFS, 'Sea'), 'Whales'), 'Ships')
    for (const arrival of [
      ['Sea', 'Whales', 'Ships'],
      ['Ships', 'Whales', 'Sea'],
      ['Whales', 'Ships', 'Sea'],
    ]) {
      expect(pinnedFirst([row('Novels'), ...arrival.map(row)], prefs).map((r) => r.tag)).toEqual([
        'Sea',
        'Whales',
        'Ships',
        'Novels',
      ])
    }
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

  /* CLEARED MEANS GONE FROM THE MAP, not a key holding null: `colourOf` reads
     both as no colour, but the file would carry a row for every colour a reader
     ever took away. */
  it('keeps every other tag’s colour when one is set or cleared, and leaves no row for the cleared one', () => {
    const two = setTagColour(setTagColour(NO_TAG_PREFS, 'Sea', 'green'), 'Whales', 'purple')
    expect(two.colours).toEqual({ sea: 'green', whales: 'purple' })
    expect(setTagColour(two, 'SEA', null).colours).toStrictEqual({ whales: 'purple' })
  })

  it('refuses a tag that is nothing but space', () => {
    expect(setTagColour(NO_TAG_PREFS, '   ', 'green')).toBe(NO_TAG_PREFS)
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

  it('shows one subject again and keeps the others hidden', () => {
    const two = toggleHiddenSubject(toggleHiddenSubject(NO_TAG_PREFS, 'Whaling'), 'Business & Economics')
    expect(toggleHiddenSubject(two, 'whaling').hiddenSubjects).toEqual(['business & economics'])
  })

  it('refuses a subject that is nothing but space', () => {
    expect(toggleHiddenSubject(NO_TAG_PREFS, '   ')).toBe(NO_TAG_PREFS)
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

  it('keeps views of other names beside the one saved', () => {
    const two = saveView(saveView(NO_TAG_PREFS, 'v1', 'Reading', 'is:reading'), 'v2', 'Finished', 'is:finished')
    expect(two.views.map((one) => one.id)).toEqual(['v1', 'v2'])
  })

  it('cuts a query at five hundred characters', () => {
    expect(saveView(NO_TAG_PREFS, 'v1', 'Long', 'q'.repeat(600)).views[0]?.query).toBe('q'.repeat(500))
  })

  it('stops at two hundred views, and still lets one of them be revised', () => {
    let prefs = NO_TAG_PREFS
    for (let n = 0; n < 200; n += 1) prefs = saveView(prefs, `v${n}`, `view ${n}`, 'is:reading')
    expect(prefs.views).toHaveLength(200)

    expect(saveView(prefs, 'extra', 'one too many', 'is:reading')).toBe(prefs)

    const revised = saveView(prefs, 'v0-again', 'View 0', 'is:finished')
    expect(revised.views).toHaveLength(200)
    expect(revised.views.at(-1)).toEqual({ id: 'v0-again', name: 'View 0', query: 'is:finished' })
  })

  it('removes and renames only the view it names', () => {
    const two = saveView(saveView(NO_TAG_PREFS, 'v1', 'Reading', 'is:reading'), 'v2', 'Finished', 'is:finished')
    expect(removeView(two, 'v1').views).toEqual([{ id: 'v2', name: 'Finished', query: 'is:finished' }])
    expect(renameView(two, 'v2', 'Done').views).toEqual([
      { id: 'v1', name: 'Reading', query: 'is:reading' },
      { id: 'v2', name: 'Done', query: 'is:finished' },
    ])
  })

  it('refuses a rename to nothing but space', () => {
    const prefs = saveView(NO_TAG_PREFS, 'v1', 'Reading', 'is:reading')
    expect(renameView(prefs, 'v1', '   ')).toBe(prefs)
  })

  /* ⚠️ **A RENAME CUT THE NAME A SECOND TIME, BY UTF-16 UNIT.** `normalizeTag`
     already cuts at `TAG_MAX` BY CODE POINT, and `renameView` then sliced the
     result at `TAG_MAX` units — so a name whose sixtieth character was astral
     kept a lone half of a surrogate pair no font can draw, a name of astral
     characters lost half its length, and renaming a view to a name stored
     something different from saving it under that name. `tags.ts` records the
     same defect, fixed there once already. Found by mutation testing. */
  it('renames to exactly what saving under that name would store', () => {
    const whale = String.fromCodePoint(0x1f40b)
    const prefs = saveView(NO_TAG_PREFS, 'v1', 'Reading', 'is:reading')
    for (const name of [`${'a'.repeat(59)}${whale}`, whale.repeat(60), 'b'.repeat(70)]) {
      const saved = saveView(NO_TAG_PREFS, 'v1', name, 'is:reading').views[0]?.name
      expect(saved, 'the case needs a name saving keeps').toBeTruthy()
      expect(renameView(prefs, 'v1', name).views[0]?.name).toBe(saved)
    }
  })
})

describe('reading a file nobody can vouch for', () => {
  it('returns nothing set when there is no file', () => {
    expect(parseTagPrefs(null)).toEqual(NO_TAG_PREFS)
  })

  /* ⚠️ **A FILE THAT WILL NOT READ IS NOT AN EMPTY ONE — found by the
     2026-09-13 audit.** Every shape here answered `NO_TAG_PREFS`, which is what
     a reader who has decided nothing gets, so `useTagPrefs` came up healthy and
     the first pin wrote "nothing plus this pin" over every colour, hidden
     subject and saved view in the file. One bad FIELD still costs that field —
     see the case below — but a file nothing can read is damage, and the bytes
     are left for whatever can recover them. Each clause in its own words: the
     two share a prefix. */
  it.each([
    ['rubbish', 'not json', /are not JSON/u],
    ['an empty string', '', /are not JSON/u],
    ['a list', '[]', /are not a record/u],
    ['JSON null', 'null', /are not a record/u],
    ['a bare number', '42', /are not a record/u],
  ])('refuses a file that is %s rather than reading it as nothing set', (_name, raw, clause) => {
    const cause = (() => {
      try {
        parseTagPrefs(raw)
        return null
      } catch (error: unknown) {
        return error
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(clause)
  })

  /* ⚠️ **AND A WHOLE COLLECTION THAT WILL NOT READ IS DAMAGE TOO — IT READ AS AN
     EMPTY ONE.** The record above was refused; a record whose `pinned` was an
     object, whose `colours` was a list, went on reading as no pins and no
     colours with the hook still persistent, so pinning one tag wrote that pin
     and an empty collection over the reader's file. `voicePort.ts` made this
     same move for its bindings. ABSENT is still empty, and one bad ROW inside a
     good collection still costs that row alone — the case below. Found by the
     2026-09-13 verify. Each collection is named in its own words. */
  it.each([
    ['pinned tags are an object', { pinned: { Sea: true } }, /have a pinned list that will not read/u],
    ['pinned tags are a string', { pinned: 'Sea' }, /have a pinned list that will not read/u],
    ['colours are a list', { colours: [['Sea', 'green']] }, /have a colours map that will not read/u],
    ['colours are JSON null', { colours: null }, /have a colours map that will not read/u],
    ['colours are a string', { colours: 'green' }, /have a colours map that will not read/u],
    ['colours are a number', { colours: 3 }, /have a colours map that will not read/u],
    ['hidden subjects are an object', { hiddenSubjects: { Sea: 1 } }, /have a hidden subjects list that will not read/u],
    ['hidden subjects are a string', { hiddenSubjects: 'not a list' }, /have a hidden subjects list that will not read/u],
    ['views are an object', { views: { v1: { id: 'v1', name: 'Reading', query: 'is:reading' } } }, /have a views list that will not read/u],
    ['views are a number', { views: 3 }, /have a views list that will not read/u],
  ])('refuses a record whose %s rather than reading them as none', (_name, doc, clause) => {
    const cause = (() => {
      try {
        parseTagPrefs(JSON.stringify({ pinned: ['kept'], ...doc }))
        return null
      } catch (error: unknown) {
        return error
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(clause)
  })

  it('reads a record with a collection simply absent as that collection empty', () => {
    expect(parseTagPrefs(JSON.stringify({ pinned: ['Sea'] }))).toEqual({
      pinned: ['sea'],
      colours: {},
      hiddenSubjects: [],
      views: [],
    })
    expect(parseTagPrefs('{}')).toEqual(NO_TAG_PREFS)
  })

  it('keeps the parts it recognises and drops the rest', () => {
    const got = parseTagPrefs(
      JSON.stringify({
        pinned: ['Sea', 42, 'sea', ''],
        colours: { Sea: 'green', Whales: 'octarine', '': 'yellow' },
        hiddenSubjects: ['Whaling', 7, null],
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
    expect(got.hiddenSubjects).toEqual(['whaling'])
    expect(got.views).toEqual([{ id: 'v1', name: 'Reading', query: 'is:reading' }])
  })

  it('refuses a colour outside the mark tints', () => {
    /* A tag's colour and a highlight's colour are the same vocabulary. A second
       palette here would put two unrelated sets of colour words in one app. */
    expect(parseTagPrefs(JSON.stringify({ colours: { Sea: 'crimson' } })).colours).toEqual({})
  })

  it('keeps what the JSON parser said, as the cause of refusing bytes that are not JSON', () => {
    const cause = (() => {
      try {
        parseTagPrefs('{oops')
        return null
      } catch (error: unknown) {
        return error
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).cause).toBeInstanceOf(SyntaxError)
  })

  it('keeps every row of a collection, not only the first', () => {
    const got = parseTagPrefs(
      JSON.stringify({
        pinned: ['Sea', 'Whales'],
        colours: { Sea: 'green', Whales: 'purple' },
        hiddenSubjects: ['Whaling', 'Sailing'],
        views: [
          { id: 'v1', name: 'Reading', query: 'is:reading' },
          { id: 'v2', name: 'Finished', query: 'is:finished' },
        ],
      }),
    )
    expect(got).toEqual({
      pinned: ['sea', 'whales'],
      colours: { sea: 'green', whales: 'purple' },
      hiddenSubjects: ['whaling', 'sailing'],
      views: [
        { id: 'v1', name: 'Reading', query: 'is:reading' },
        { id: 'v2', name: 'Finished', query: 'is:finished' },
      ],
    })
  })

  /* ONE BAD ROW COSTS THAT ROW, and `null` is the row that could cost more:
     reading a property of it throws, which would refuse the whole file over
     one entry. A name that is not a string is a view nobody can choose. */
  it('drops a view that is null, or not an object, or has a name that is not a string, alone', () => {
    const got = parseTagPrefs(
      JSON.stringify({
        views: [null, 'v0', { id: 'v1', name: 42, query: 'is:reading' }, { id: 'v2', name: 'Reading', query: 'is:reading' }],
      }),
    )
    expect(got.views).toEqual([{ id: 'v2', name: 'Reading', query: 'is:reading' }])
  })

  it('holds a hand-edited view to the bounds a saved one has', () => {
    const got = parseTagPrefs(
      JSON.stringify({
        views: [
          { id: 'i'.repeat(70), name: 'Long', query: 'q'.repeat(600) },
          { id: 'v2', name: 'Padded', query: '  is:reading  ' },
        ],
      }),
    )
    expect(got.views).toEqual([
      { id: 'i'.repeat(64), name: 'Long', query: 'q'.repeat(500) },
      { id: 'v2', name: 'Padded', query: 'is:reading' },
    ])
  })

  /* THE BOUNDS, AT THEIR EDGE. Far past where anyone meets them — the point is
     that a corrupt or hostile file cannot make the panel unrenderable. */
  it('stops reading each collection at its bound', () => {
    const many = Array.from({ length: 2_001 }, (_, n) => `tag ${n}`)
    const got = parseTagPrefs(
      JSON.stringify({
        pinned: many,
        colours: Object.fromEntries(many.map((tag) => [tag, 'green'])),
        hiddenSubjects: many,
        views: Array.from({ length: 201 }, (_, n) => ({ id: `v${n}`, name: `view ${n}`, query: 'is:reading' })),
      }),
    )
    expect(got.pinned).toHaveLength(2_000)
    expect(Object.keys(got.colours)).toHaveLength(2_000)
    expect(got.hiddenSubjects).toHaveLength(2_000)
    expect(got.views).toHaveLength(200)
  })
})

/* THE KEY IS THE STORED FORMAT'S NAME. `useTagPrefs` reads and writes through
   the constant, so nothing else could notice it change — and a changed key is
   every reader's pins, colours and saved views orphaned. */
describe('the storage key', () => {
  it('is paper.tags.v1', () => {
    expect(TAG_PREFS_STORAGE_KEY).toBe('paper.tags.v1')
  })
})
