import { describe, expect, it } from 'vitest'
import { ALL_FACES, BUNDLED_FACES, faceById, offeredFaces, scaleFor } from './typefaces'

describe('the face registry', () => {
  it('gives every face a unique id', () => {
    const ids = ALL_FACES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /* A bundled face ships with the app; probing for it would report it missing
   * for as long as the webfont takes to load, and then offer it. */
  it('probes for every system face and for no bundled one', () => {
    for (const face of BUNDLED_FACES) expect(face.probe, face.id).toBeUndefined()
    for (const face of ALL_FACES) {
      if (BUNDLED_FACES.includes(face)) continue
      expect(face.probe, `${face.id} must say what to look for`).toBeTruthy()
    }
  })

  /* An id that is not in this build — a setting from a newer version, or a
   * system face carried from another machine — must resolve to something
   * readable rather than to nothing. */
  it('falls back to the default for an id it does not know', () => {
    expect(faceById('no-such-face').id).toBe('literata')
    expect(faceById('').id).toBe('literata')
  })

  it('resolves a known id to itself', () => {
    for (const face of ALL_FACES) expect(faceById(face.id).id).toBe(face.id)
  })
})

describe('what gets offered', () => {
  it('offers the bundled faces even when the machine has nothing else', () => {
    const out = offeredFaces(new Set())
    expect(out.map((f) => f.id)).toEqual(BUNDLED_FACES.map((f) => f.id))
  })

  it('never offers a face this machine does not have', () => {
    const out = offeredFaces(new Set(['charter']))
    expect(out.some((f) => f.id === 'charter')).toBe(true)
    expect(out.some((f) => f.id === 'cambria')).toBe(false)
  })

  /* "A minimal set" is the whole point: this Mac has seven of the serifs in the
   * registry, and a list of seven serifs is not a choice, it is a font menu. */
  it('caps how many found faces it adds to a group', () => {
    const everything = new Set(ALL_FACES.map((f) => f.id))
    const serifs = offeredFaces(everything).filter((f) => f.group === 'serif')
    const bundledSerifs = BUNDLED_FACES.filter((f) => f.group === 'serif').length
    expect(serifs.length).toBe(bundledSerifs + 2)
  })

  it('takes the found faces in the registry’s preference order', () => {
    const out = offeredFaces(new Set(['georgia', 'iowan', 'charter', 'palatino']))
    const found = out.filter((f) => f.group === 'serif' && f.probe).map((f) => f.id)
    // Iowan Old Style and Charter come first in the registry, so they win.
    expect(found).toEqual(['iowan', 'charter'])
  })

  it('keeps every group together and in reading order', () => {
    const groups = offeredFaces(new Set(['charter', 'menlo', 'avenir'])).map((f) => f.group)
    expect(groups).toEqual([...groups].sort((a, b) => {
      const order = { serif: 0, sans: 1, mono: 2 }
      return order[a] - order[b]
    }))
  })

  /* Nothing shown to a reader may say where a face came from — a reader cannot
   * act on "bundled", and there is no entry called "System serif". */
  it('labels every face with a real font name', () => {
    for (const face of ALL_FACES) {
      expect(face.label, face.id).not.toMatch(/system|bundled|default/i)
    }
  })
})

describe('a size means the same thing in every face', () => {
  /* Literata is the reference, so it is the one face that must not move. */
  it('leaves the reference face alone', () => {
    expect(scaleFor(0.51)).toBe(1)
  })

  /* Crimson Pro measured 0.42 against Literata's 0.51 — 18% smaller on the
   * body at the same nominal size, which is the whole reason this exists. */
  it('enlarges a face with a small x-height', () => {
    expect(scaleFor(0.42)).toBeGreaterThan(1)
    expect(Math.round(21 * scaleFor(0.42))).toBeGreaterThan(21)
  })

  it('shrinks a face with a large x-height', () => {
    expect(scaleFor(0.58)).toBeLessThan(1)
  })

  /* A correction, not a rescale: past a point the reader's "21" would produce
   * something they would not recognise as 21. */
  it('never travels far from the size that was asked for', () => {
    for (const x of [0.01, 0.2, 0.3, 0.7, 0.9, 5]) {
      expect(scaleFor(x)).toBeGreaterThanOrEqual(0.86)
      expect(scaleFor(x)).toBeLessThanOrEqual(1.18)
    }
  })

  /* No canvas, a face that has not loaded, a measurement that returned nothing:
   * uncorrected is the behaviour this replaces and is never worse than it. */
  it('does not correct at all when it cannot measure', () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(scaleFor(bad)).toBe(1)
  })
})
