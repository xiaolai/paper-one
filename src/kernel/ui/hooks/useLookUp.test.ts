// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_GLOSS, type GlossContext, type GlossProvider } from '../../core/gloss'
import type { AnswerChoice } from '../../core/glossLanguage'
import type { LookupEntry } from '../../core/lookups'
import { NOOP_DIAGNOSTICS, type Diagnostics } from '../../core/ports'
import { buildFixture, elem, txt } from '../reader/wordSnap/domFake.testkit'
import type { SelectionSnapshot } from '../reader/session'
import { useLookUp, type LookUpOptions, type LookUpReading } from './useLookUp'

/**
 * Look up, lifted above the reader (WI-17.2) — the anchor it builds, what it
 * records, the language it asks in, and what it cannot do.
 */

afterEach(cleanup)

/* A SENTENCE ON EACH SIDE: the walk declines the first and last sentence of a
   block by design (`sentenceAt`, §C1), and this suite is about the lookup, not
   about the fallback. */
const WHOLE =
  'Call me Ishmael. There now is your insular city of the Manhattoes, belted round by wharves. Commerce surrounds it.'

function selection(cfi = 'epubcfi(/6/4!/4/2,/1:66,/1:73)', text = 'wharves'): SelectionSnapshot {
  const fixture = buildFixture(elem('p', {}, [txt(WHOLE)]))
  const at = WHOLE.indexOf(text)
  return {
    cfi,
    sectionIndex: 2,
    text,
    prefix: WHOLE.slice(Math.max(0, at - 32), at),
    suffix: WHOLE.slice(at + text.length, at + text.length + 32),
    range: {
      startContainer: fixture.text(WHOLE),
      startOffset: at,
      endContainer: fixture.text(WHOLE),
      endOffset: at + text.length,
    } as unknown as Range,
  }
}

const reading = (over: Partial<LookUpReading> = {}): LookUpReading => ({
  bookId: 'moby',
  title: 'Moby-Dick',
  languages: ['en'],
  fixedLayout: false,
  chapterLabel: 'Loomings',
  generation: 1,
  sectionIndex: 2,
  chapterHref: 'ch1.xhtml',
  navigation: 0,
  ...over,
})

function answering(text = 'Structures along a shore where ships dock.') {
  const seen: { term: string; context: GlossContext }[] = []
  const provider: GlossProvider = {
    available: true,
    installAt: 'inference:models',
    async gloss(term, context) {
      seen.push({ term, context })
      return text
    },
  }
  return { provider, seen }
}

function mount(over: Partial<LookUpOptions> = {}) {
  const record = vi.fn(async (_entry: LookupEntry) => {})
  const initial: LookUpOptions = {
    provider: answering().provider,
    selection: selection(),
    reading: reading(),
    choice: 'reader' as AnswerChoice,
    readerLocale: 'en-US',
    lookups: { record },
    now: () => 5_000,
    ...over,
  }
  const hook = renderHook((props: LookUpOptions) => useLookUp(props), { initialProps: initial })
  return { ...hook, record, initial }
}

describe('whether there is a press at all', () => {
  it('is a press with a model and a selection', () => {
    expect(mount().result.current.press).toBeTypeOf('function')
  })

  it('is no press with nothing selected', () => {
    expect(mount({ selection: null }).result.current.press).toBeNull()
  })

  it('is no press while the reader is not reading', () => {
    expect(mount({ reading: null }).result.current.press).toBeNull()
  })

  /* A browser, a phone: nothing to define with and nowhere to get it. */
  it('is no press where there is neither a model nor anywhere to install one', () => {
    const { result } = mount({ provider: NO_GLOSS })

    expect(result.current.action).toBe('none')
    expect(result.current.press).toBeNull()
  })

  /* A desktop with no model yet: the press is the install offer. */
  it('is a press that offers the install where a model could be had', () => {
    const nothing: GlossProvider = { ...NO_GLOSS, installAt: 'inference:models' }
    const { result } = mount({ provider: nothing, onInstall: () => {} })

    expect(result.current.action).toBe('install')
    act(() => result.current.press?.())
    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'wharves', installAt: 'inference:models' })
  })

  /* And the host's handler alone is not enough: with nowhere to install TO, a
     handler would open Settings on nothing. */
  it('offers no install where the provider has nowhere to install to, whatever the host passes', () => {
    expect(mount({ provider: NO_GLOSS, onInstall: () => {} }).result.current.action).toBe('none')
  })

  /* The provider says where; the host has to have given somewhere to go. */
  it('offers no install where the host gave nowhere to go', () => {
    const nothing: GlossProvider = { ...NO_GLOSS, installAt: 'inference:models' }

    expect(mount({ provider: nothing }).result.current.action).toBe('none')
  })
})

describe('a lookup', () => {
  it('asks the provider for the sentence the word sits in, in the chosen language', async () => {
    const { provider, seen } = answering()
    const { result } = mount({ provider, choice: 'both', readerLocale: 'zh-CN' })

    await act(async () => result.current.press?.())

    expect(seen).toHaveLength(1)
    expect(seen[0]?.term).toBe('wharves')
    expect(seen[0]?.context.sentence).toBe('There now is your insular city of the Manhattoes, belted round by wharves.')
    expect(seen[0]?.context.bookTitle).toBe('Moby-Dick')
    /* The book's language first (no `lang` in the fixture, so the book's
       declared `en`), then the reader's. */
    expect(seen[0]?.context.answerIn.map((one) => one.tag)).toEqual(['en', 'zh-Hans'])
    expect(result.current.state).toEqual({
      kind: 'ready',
      term: 'wharves',
      text: 'Structures along a shore where ships dock.',
    })
  })

  /* WI-17.2: every answered lookup is filed, under the press that asked. */
  it('records the answer under the book, the anchor and the chapter it was asked from', async () => {
    const { result, record } = mount({ choice: 'reader', readerLocale: 'de-DE' })

    await act(async () => result.current.press?.())

    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith({
      bookId: 'moby',
      cfi: 'epubcfi(/6/4!/4/2,/1:66,/1:73)',
      chapter: 'Loomings',
      spelled: 'wharves',
      sentence: 'There now is your insular city of the Manhattoes, belted round by wharves.',
      gloss: 'Structures along a shore where ships dock.',
      language: 'de',
      at: 5_000,
    })
  })

  it('records nothing where there is no history to record into', async () => {
    const { provider, seen } = answering()
    const { result } = mount({ provider, lookups: null })

    await act(async () => result.current.press?.())

    expect(seen).toHaveLength(1)
    expect(result.current.state.kind).toBe('ready')
  })

  /* NOTHING TO FILE INTO IS NOT AN ERROR: a lookup with no history is quietly
     not recorded, and nothing is reported as having gone wrong. */
  it('reports nothing when there is no history to record into', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = mount({ lookups: null })

    await act(async () => result.current.press?.())

    expect(result.current.state.kind).toBe('ready')
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  /* THE PRESS READS THE SELECTION THE READER HAS NOW. A handler that kept the
     first render's would define a word the reader had moved away from. */
  it('looks up the selection the reader has now, not the one they had', async () => {
    const { provider, seen } = answering()
    const { result, rerender, initial } = mount({ provider })

    rerender({ ...initial, selection: selection('epubcfi(/6/4!/4/2,/1:8,/1:15)', 'Ishmael') })
    await act(async () => result.current.press?.())

    expect(seen.map((one) => one.term)).toEqual(['Ishmael'])
  })

  /* A refused write is the store's to report through `persistent`; it must not
     escape as an unhandled rejection. */
  it('lets a refused recording go without an unhandled rejection', async () => {
    const record = vi.fn(async () => {
      throw new Error('the disk is full')
    })
    const { result } = mount({ lookups: { record } })

    await act(async () => result.current.press?.())

    expect(record).toHaveBeenCalledTimes(1)
    expect(result.current.state.kind).toBe('ready')
  })

  /* AND ITS CAUSE IS FILED — found by the 2026-09-13 audit. The flag says the
     history is not saving and cannot say why, and a failure before the write —
     a clock or a store that threw — does not move the flag at all, so an empty
     `catch` left nothing anywhere. */
  it('files a refused recording with its cause', async () => {
    const warnings: unknown[][] = []
    const diagnostics: Diagnostics = { ...NOOP_DIAGNOSTICS, warn: (...args) => void warnings.push(args) }
    const record = vi.fn(async () => {
      throw new Error('the disk is full')
    })
    const { result } = mount({ lookups: { record }, diagnostics })

    await act(async () => result.current.press?.())

    await vi.waitFor(() => expect(warnings).toEqual([['lookups.record-failed', { message: 'the disk is full' }]]))
    expect(result.current.state.kind).toBe('ready')
  })

  /* A SINK THAT THROWS COSTS THE REPORT AND NEVER THE DEFINITION: `Diagnostics`
     has no no-throw contract, and a throw in a rejection handler is an
     unhandled rejection of its own. */
  it('keeps the definition when the diagnostics sink throws as well', async () => {
    const warn = vi.fn(() => {
      throw new Error('the log is gone')
    })
    const record = vi.fn(async () => {
      throw new Error('the disk is full')
    })
    const { result } = mount({ lookups: { record }, diagnostics: { ...NOOP_DIAGNOSTICS, warn } })

    await act(async () => result.current.press?.())
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))

    expect(result.current.state.kind).toBe('ready')
  })

  /* PHASE 17'S RULE: a lookup never opens the pane, because opening it
     re-lays-out the book under the word. The only navigation the hook holds is
     the install offer, and a press does not reach it. */
  it('never navigates on a press — the install is the reader’s own second press', async () => {
    const onInstall = vi.fn()
    const nothing: GlossProvider = { ...NO_GLOSS, installAt: 'inference:models' }
    const { result } = mount({ provider: nothing, onInstall })

    act(() => result.current.press?.())

    expect(onInstall).not.toHaveBeenCalled()
    expect(result.current.onInstall).toBe(onInstall)
  })
})

/**
 * THE ANCHOR — see `GlossAnchor`. The answer is drawn in the selection popup,
 * so it must go when the selection does, and it must NOT go when the session
 * republishes the same selection as a new object.
 */
describe('when the passage stops being shown', () => {
  async function answered() {
    const hook = mount()
    await act(async () => hook.result.current.press?.())
    expect(hook.result.current.state.kind).toBe('ready')
    return hook
  }

  it('stays while the same selection is republished as a new object', async () => {
    const { result, rerender, initial } = await answered()

    rerender({ ...initial, selection: selection() })

    expect(result.current.state.kind).toBe('ready')
  })

  it('goes when the reader selects somewhere else', async () => {
    const { result, rerender, initial } = await answered()

    rerender({ ...initial, selection: selection('epubcfi(/6/4!/4/2,/1:0,/1:5)', 'There') })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('goes when the selection is cleared', async () => {
    const { result, rerender, initial } = await answered()

    rerender({ ...initial, selection: null })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  /* The keyboard page turn, which never clears a selection. */
  it('goes when the page turns', async () => {
    const { result, rerender, initial } = await answered()

    rerender({ ...initial, reading: reading({ navigation: 1 }) })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('goes when the reader moves to another section', async () => {
    const { result, rerender, initial } = await answered()

    rerender({ ...initial, reading: reading({ sectionIndex: 3 }) })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  /* THE ANCHOR IS A JOINED KEY, and fields that run together must not collide:
     generation 1 in section 12 is not generation 11 in section 2. */
  it('tells apart two places whose numbers run together', async () => {
    const hook = mount({ reading: reading({ generation: 1, sectionIndex: 12 }) })
    await act(async () => hook.result.current.press?.())
    expect(hook.result.current.state.kind).toBe('ready')

    hook.rerender({ ...hook.initial, reading: reading({ generation: 11, sectionIndex: 2 }) })

    expect(hook.result.current.state).toEqual({ kind: 'idle' })
  })

  it('goes when the reader leaves the book', async () => {
    const { result, rerender, initial } = await answered()

    rerender({ ...initial, reading: null })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('goes when it is dismissed', async () => {
    const { result } = await answered()

    act(() => result.current.dismiss())

    expect(result.current.state).toEqual({ kind: 'idle' })
  })
})

/**
 * THE PRESS IS ONE FUNCTION UNTIL SOMETHING IT READS CHANGES — found by the
 * 2026-09-13 audit. `App` builds `reading` afresh on every render, and a press
 * keyed on that object, and on the gloss's own fresh object, was a new function
 * on every render; so was the object this hook returns, which the palette's
 * memo and the keyboard map's effect both depend on.
 */
describe('a render that changed nothing the press reads', () => {
  it('keeps the press, and the lookup, across a render with an equal reading', () => {
    const { result, rerender, initial } = mount()
    const before = result.current

    rerender({ ...initial, reading: reading() })

    expect(result.current.press).toBe(before.press)
    expect(result.current).toBe(before)
  })

  /* NON-VACUITY. A press that never changed would file a lookup under the
     chapter the reader had left, and ask about a book they had closed. */
  it('files under the chapter the reader is in now', async () => {
    const { result, rerender, initial, record } = mount()

    rerender({ ...initial, reading: reading({ chapterLabel: 'The Carpet-Bag' }) })
    await act(async () => result.current.press?.())

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ chapter: 'The Carpet-Bag' }))
  })

  it('asks with the title and the language of the book the reader has now', async () => {
    const { provider, seen } = answering()
    const { result, rerender, initial } = mount({ provider, choice: 'book' })

    rerender({ ...initial, reading: reading({ title: 'Typee', languages: ['fr'] }) })
    await act(async () => result.current.press?.())

    expect(seen[0]?.context.bookTitle).toBe('Typee')
    expect(seen[0]?.context.answerIn.map((one) => one.tag)).toEqual(['fr'])
  })

  it('files under the book the reader has now', async () => {
    const { result, rerender, initial, record } = mount()

    rerender({ ...initial, reading: reading({ bookId: 'typee' }) })
    await act(async () => result.current.press?.())

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'typee' }))
  })
})
