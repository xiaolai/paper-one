// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_TAG_PREFS, TAG_PREFS_STORAGE_KEY, colourOf, isHidden, isPinned } from '../../core/tagPrefs'
import { useTagPrefs } from './useTagPrefs'

/**
 * The tag preferences say when they are not being kept (WI-20.36).
 *
 * The write effect advanced its "last written" marker BEFORE `setItem`, and
 * reported a throw to the console only — so a pin, a colour, a hidden subject
 * or a saved view showed as kept until the next launch, when it was gone, and
 * nothing on screen had ever said otherwise. Codex's case, made executable.
 */

/** A storage that can be told to refuse, with what it holds visible. */
function storage(entries: Record<string, string> = {}, refuse = false) {
  const held = new Map(Object.entries(entries))
  let refusing = refuse
  return {
    held,
    refuse: (on: boolean) => {
      refusing = on
    },
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refusing) throw new Error('quota')
      held.set(key, value)
    },
  }
}

describe('useTagPrefs and a store that refuses', () => {
  afterEach(cleanup)
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it("Codex's case: the pin is gone at the next mount, and the refusal was published", () => {
    const warn = quiet()
    const store = storage({}, true)
    const first = renderHook(() => useTagPrefs(store))
    expect(first.result.current.persistent).toBe(true)

    act(() => first.result.current.togglePinned('Sea'))
    // Kept for the session — the pin is drawn — and SAID to be only that.
    expect(isPinned(first.result.current.prefs, 'Sea')).toBe(true)
    expect(first.result.current.persistent).toBe(false)
    expect(store.held.size).toBe(0)
    expect(warn).toHaveBeenCalledWith('Paper: could not save your tag preferences', expect.objectContaining({ message: 'quota' }))
    first.unmount()

    const second = renderHook(() => useTagPrefs(storage()))
    expect(isPinned(second.result.current.prefs, 'Sea')).toBe(false)
    warn.mockRestore()
  })

  /* The file store queues the write BEFORE it throws for the previous one, so
     a refusal is not necessarily forever — the next change tries again, and
     a write that lands says so. */
  it('tries again on the next change, and says so when the store takes it', () => {
    const warn = quiet()
    const store = storage({}, true)
    const hook = renderHook(() => useTagPrefs(store))
    act(() => hook.result.current.togglePinned('Sea'))
    expect(hook.result.current.persistent).toBe(false)

    store.refuse(false)
    act(() => hook.result.current.togglePinned('Sky'))
    expect(hook.result.current.persistent).toBe(true)
    // Both decisions, in the one write that landed — pins are kept by key.
    expect(store.held.get(TAG_PREFS_STORAGE_KEY)).toContain('"sea"')
    expect(store.held.get(TAG_PREFS_STORAGE_KEY)).toContain('"sky"')
    warn.mockRestore()
  })

  it('with no storage at all is not persistent from the start', () => {
    const hook = renderHook(() => useTagPrefs(null))
    expect(hook.result.current.persistent).toBe(false)
  })

  /* ⚠️ **A FILE THAT WILL NOT READ IS NOT AN EMPTY ONE, AND THE FIRST CHANGE
     WROTE OVER IT.** `parseTagPrefs` answered "nothing decided" for bytes that
     would not parse, so the hook reported itself persistent and the next pin
     replaced every colour, hidden subject and saved view the reader had. The
     session keeps what they choose; the file is left for whatever can recover
     it. Found by the 2026-09-13 audit. */
  it('writes nothing over a preferences file it could not read', () => {
    const warn = quiet()
    const raw = '{"pinned": ["Sea"'
    const store = storage({ [TAG_PREFS_STORAGE_KEY]: raw })
    const hook = renderHook(() => useTagPrefs(store))

    expect(hook.result.current.persistent, 'said from the first render').toBe(false)
    expect(warn).toHaveBeenCalledWith(
      'Paper: your tag preferences could not be read, and will not be saved this session',
      expect.any(Error),
    )
    act(() => hook.result.current.togglePinned('Sky'))

    expect(isPinned(hook.result.current.prefs, 'Sky'), 'kept for the session').toBe(true)
    expect(hook.result.current.persistent).toBe(false)
    expect(store.held.get(TAG_PREFS_STORAGE_KEY), 'the file it could not read must be intact').toBe(raw)
    warn.mockRestore()
  })

  it('does not rewrite a launch that changed nothing', () => {
    const store = storage({ [TAG_PREFS_STORAGE_KEY]: JSON.stringify({ pinned: ['Sea'] }) })
    const setItem = vi.spyOn(store, 'setItem')
    renderHook(() => useTagPrefs(store))
    expect(setItem).not.toHaveBeenCalled()
  })

  /* NO STORE IS NOT A STORE THAT FAILED. A host with nothing to write to starts
     from nothing decided, keeps what the reader decides for the session, and has
     no read failure to report — there was nothing to read. */
  it('with no storage at all starts from nothing decided, and reports no failed read', () => {
    const warn = quiet()
    const hook = renderHook(() => useTagPrefs(null))

    expect(hook.result.current.prefs).toEqual(NO_TAG_PREFS)
    act(() => hook.result.current.togglePinned('Sea'))
    expect(isPinned(hook.result.current.prefs, 'Sea'), 'kept for the session').toBe(true)
    expect(hook.result.current.persistent).toBe(false)
    expect(warn, 'a host with no storage was reported as an unreadable file').not.toHaveBeenCalled()
    warn.mockRestore()
  })

  /* READ ONCE, BEFORE THE FIRST RENDER — the header's own words. A read on
     every render would re-parse the file under every pin, and a file that went
     bad mid-session would silently stop the session's writes. */
  it('reads the store once, however many times it renders', () => {
    const store = storage({ [TAG_PREFS_STORAGE_KEY]: JSON.stringify({ pinned: ['Sea'] }) })
    const getItem = vi.spyOn(store, 'getItem')
    const hook = renderHook(() => useTagPrefs(store))

    act(() => hook.result.current.togglePinned('Sky'))
    act(() => hook.result.current.togglePinned('Sea'))
    hook.rerender()

    expect(getItem).toHaveBeenCalledTimes(1)
    expect(getItem).toHaveBeenCalledWith(TAG_PREFS_STORAGE_KEY)
  })
})

/** What the store last took, read back the way the next launch will read it. */
const kept = (store: ReturnType<typeof storage>): unknown => JSON.parse(store.held.get(TAG_PREFS_STORAGE_KEY) ?? 'null')

describe('useTagPrefs, each decision the panel can make', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('colours a tag, and takes the colour away again, writing each', () => {
    const store = storage()
    const hook = renderHook(() => useTagPrefs(store))

    act(() => hook.result.current.setColour('Sea', 'green'))
    expect(colourOf(hook.result.current.prefs, 'sea')).toBe('green')
    expect(kept(store)).toEqual({ pinned: [], colours: { sea: 'green' }, hiddenSubjects: [], views: [] })

    act(() => hook.result.current.setColour('Sea', null))
    expect(colourOf(hook.result.current.prefs, 'sea')).toBeNull()
    expect(kept(store)).toEqual(NO_TAG_PREFS)
    expect(hook.result.current.persistent).toBe(true)
  })

  it('hides a subject, and shows it again, writing each', () => {
    const store = storage()
    const hook = renderHook(() => useTagPrefs(store))

    act(() => hook.result.current.toggleHidden('Fiction'))
    expect(isHidden(hook.result.current.prefs, 'fiction')).toBe(true)
    expect(kept(store)).toEqual({ pinned: [], colours: {}, hiddenSubjects: ['fiction'], views: [] })

    act(() => hook.result.current.toggleHidden('Fiction'))
    expect(isHidden(hook.result.current.prefs, 'fiction')).toBe(false)
    expect(kept(store)).toEqual(NO_TAG_PREFS)
  })

  it('keeps a view under the id it mints, renames it by that id, and removes it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'minted-by-crypto' })
    const store = storage()
    const hook = renderHook(() => useTagPrefs(store))

    act(() => hook.result.current.saveView('Reading', 'is:reading'))
    expect(hook.result.current.prefs.views).toEqual([{ id: 'minted-by-crypto', name: 'Reading', query: 'is:reading' }])
    expect(kept(store)).toEqual({
      pinned: [],
      colours: {},
      hiddenSubjects: [],
      views: [{ id: 'minted-by-crypto', name: 'Reading', query: 'is:reading' }],
    })

    act(() => hook.result.current.renameView('minted-by-crypto', 'On the desk'))
    expect(hook.result.current.prefs.views).toEqual([{ id: 'minted-by-crypto', name: 'On the desk', query: 'is:reading' }])
    expect((kept(store) as { views: unknown }).views).toEqual([
      { id: 'minted-by-crypto', name: 'On the desk', query: 'is:reading' },
    ])

    act(() => hook.result.current.removeView('minted-by-crypto'))
    expect(hook.result.current.prefs.views).toEqual([])
    expect(kept(store)).toEqual(NO_TAG_PREFS)
  })

  /* `randomUUID` NEEDS A SECURE CONTEXT, and a `file://` build is not one: there
     `crypto` is present without it. Where there is no `crypto` at all the same
     fallback applies. Either way a view is still saved, under an id built from
     the clock and a random draw — pinned here to fixed values so the whole id
     can be read. */
  it.each([
    ['present without randomUUID, as outside a secure context', {}],
    ['absent altogether', undefined],
  ])('still keeps a view when crypto is %s', (_case, crypto) => {
    const store = storage()
    const hook = renderHook(() => useTagPrefs(store))
    vi.stubGlobal('crypto', crypto)
    vi.spyOn(Date, 'now').mockReturnValue(36 ** 6)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    act(() => hook.result.current.saveView('Reading', 'is:reading'))

    /* `36 ** 6` is `1000000` in base 36, and `0.5` is `0.i` — the id keeps the
       digits after the point, never the `0.`. */
    expect(hook.result.current.prefs.views).toEqual([{ id: 'v-1000000-i', name: 'Reading', query: 'is:reading' }])
  })
})
