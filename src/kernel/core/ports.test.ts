import { describe, expect, it } from 'vitest'
import { CONTENT_EXTENSIONS } from './bookVault'
import { COVER_NAMES } from './bookFolder'
import { CONTENT_BLOB_NAMES, REMOVABLE_BLOB_KINDS, defineSetting, frozen } from './ports'

/**
 * The few VALUES the ports file owns, asked directly.
 *
 * Everything else here is an interface, and is held by the suites of whatever
 * implements it. These three were reached only through `settings.ts`, which
 * calls `defineSetting` and `frozen` while it loads — so a defect in either
 * failed that suite at import, with no test to name, and the refusal of a bad
 * key was reached by nothing at all.
 */

describe('CONTENT_BLOB_NAMES', () => {
  /* WHAT `content.evict` MEANS BY "CONTENT": every name the book's bytes may be
     stored under, and no jacket — the cover cache is what evicts a cover. */
  it('is every removable name of the content kind, and nothing else', () => {
    const content = Object.entries(REMOVABLE_BLOB_KINDS)
      .filter(([, kind]) => kind === 'content')
      .map(([name]) => name)
    expect([...CONTENT_BLOB_NAMES].sort()).toEqual(content.sort())
    expect(CONTENT_BLOB_NAMES).toHaveLength(CONTENT_EXTENSIONS.length)
    for (const cover of COVER_NAMES) expect(CONTENT_BLOB_NAMES).not.toContain(cover)
  })
})

describe('defineSetting', () => {
  it('mints a key with an owner and a name, however short either is', () => {
    for (const key of ['kernel.theme', 'a.b', 'kernel.reader.size'] as const) {
      expect(defineSetting(key, 0, () => undefined).key, key).toBe(key)
    }
  })

  /* The fallback and whatever the parser passes through are FROZEN where they
     are minted, so no reader can change a value under another. */
  it('freezes its fallback and what its parser answers', () => {
    const setting = defineSetting('test.shape', { tags: ['a'] }, (raw) => raw as { tags: string[] } | undefined)
    expect(Object.isFrozen(setting.fallback.tags)).toBe(true)
    const stored = { tags: ['b'] }
    expect(setting.parse(stored)).toBe(stored)
    expect(Object.isFrozen(stored.tags)).toBe(true)
    expect(setting.parse(undefined)).toBeUndefined()
  })

  /* AN UNOWNED KEY IS WHAT THE NAMESPACE WRAPPERS CANNOT SCOPE, and the template
     type lets every one of these through. */
  it.each(['.theme', 'kernel.', '.', 'theme'])('refuses %j, which has no owner or no name', (key) => {
    const cause = (() => {
      try {
        defineSetting(key as `${string}.${string}`, 0, () => undefined)
        return null
      } catch (error: unknown) {
        return error
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe(
      `defineSetting: ${JSON.stringify(key)} must be "<namespace>.<name>", both non-empty`,
    )
  })
})

describe('frozen', () => {
  it('freezes a value and everything under it, past nulls and primitives, and hands back the same value', () => {
    const deep = { at: 1 }
    const value = { n: 1, text: 'x', none: null, gone: undefined, yes: true, list: [2, null, 'y', { deep }] }
    expect(frozen(value)).toBe(value)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.list)).toBe(true)
    expect(Object.isFrozen(value.list[3])).toBe(true)
    expect(Object.isFrozen(deep)).toBe(true)
  })

  it('answers a primitive, null and undefined exactly as given', () => {
    for (const plain of [0, 1, '', 'text', true, false, null, undefined, 10n]) {
      expect(frozen(plain)).toBe(plain)
    }
  })

  /* A PARENT SOMEBODY ALREADY FROZE DOES NOT HIDE A CHILD THAT WAS NOT — the
     walk does not stop at a frozen object — and a cycle ends it. */
  it('reaches a child under a parent frozen elsewhere, and ends at a cycle', () => {
    const child: Record<string, unknown> = { inner: { leaf: 1 } }
    const cyclic: Record<string, unknown> = { parent: Object.freeze({ child }) }
    cyclic['self'] = cyclic
    child['back'] = cyclic
    expect(frozen(cyclic)).toBe(cyclic)
    expect(Object.isFrozen(cyclic)).toBe(true)
    expect(Object.isFrozen(child)).toBe(true)
    expect(Object.isFrozen(child['inner'])).toBe(true)
  })
})
