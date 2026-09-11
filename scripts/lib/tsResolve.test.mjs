/**
 * The resolver that fills in the extension this tree leaves out.
 *
 * ⚠️ **THIS FILE EXISTS BECAUSE THE MODULE WAS AT 0% AND WORKING.**
 * `tsResolve.mjs` only ever runs inside the child process `surfaces.mjs`
 * becomes, and a child is not instrumented by the parent's V8 coverage — so it
 * was exercised on every run of `surfaces.test.mjs` and reported as untouched.
 * That is the shape this repository already has a rule about: a step that
 * silently does nothing looks exactly like a step that worked, and here the
 * inverse was true — a module doing real work looked exactly like dead code.
 *
 * Calling `resolve` directly is also a better test than "the child process
 * managed to import something". Every branch below is a decision the hook makes
 * that nothing previously asserted.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from './tsResolve.mjs'

/** `next` here just records what it was handed, so the assertions read as
 *  "what did the hook decide" rather than "what did node do afterwards". */
const spy = () => {
  const seen = []
  const next = (specifier, context) => {
    seen.push(specifier)
    return { specifier, context }
  }
  return { next, seen }
}

const made = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A directory with the given files in it, and the URL of a module inside it. */
function treeOf(...files) {
  const root = mkdtempSync(path.join(tmpdir(), 'ts-resolve-'))
  made.push(root)
  for (const rel of files) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
    writeFileSync(path.join(root, rel), '')
  }
  return { root, parentURL: pathToFileURL(path.join(root, 'entry.mjs')).href }
}

describe('what it hands straight on', () => {
  it('leaves a bare specifier alone — that is a package', async () => {
    const { next, seen } = spy()
    const { parentURL } = treeOf('node_modules/react/index.ts')
    await resolve('react', { parentURL }, next)
    expect(seen).toEqual(['react'])
  })

  it('leaves a specifier that already carries an extension', async () => {
    const { next, seen } = spy()
    const { parentURL } = treeOf('marks.ts')
    await resolve('./marks.ts', { parentURL }, next)
    expect(seen).toEqual(['./marks.ts'])
  })

  it('leaves a relative specifier with no parent to resolve against', async () => {
    const { next, seen } = spy()
    await resolve('./marks', { parentURL: undefined }, next)
    expect(seen).toEqual(['./marks'])
  })

  /* A `data:` or `node:` parent has no directory, and guessing one would be
   * inventing a filesystem location for something that has none. */
  it('leaves a relative specifier whose parent is not a file', async () => {
    const { next, seen } = spy()
    await resolve('./marks', { parentURL: 'data:text/javascript,0' }, next)
    expect(seen).toEqual(['./marks'])
  })

  /* THE KNOWN NEGATIVE. If this rewrote anything, every assertion above would
   * be passing for the wrong reason. */
  it('leaves a relative specifier that names nothing at all', async () => {
    const { next, seen } = spy()
    const { parentURL } = treeOf('marks.ts')
    await resolve('./nothing-here', { parentURL }, next)
    expect(seen).toEqual(['./nothing-here'])
  })
})

describe('what it fills in', () => {
  it('finds a .ts sibling', async () => {
    const { next, seen } = spy()
    const { root, parentURL } = treeOf('marks.ts')
    await resolve('./marks', { parentURL }, next)
    expect(seen).toEqual([pathToFileURL(path.join(root, 'marks.ts')).href])
  })

  it('finds a .tsx sibling', async () => {
    const { next, seen } = spy()
    const { root, parentURL } = treeOf('Pane.tsx')
    await resolve('./Pane', { parentURL }, next)
    expect(seen).toEqual([pathToFileURL(path.join(root, 'Pane.tsx')).href])
  })

  it('finds an .mts sibling', async () => {
    const { next, seen } = spy()
    const { root, parentURL } = treeOf('thing.mts')
    await resolve('./thing', { parentURL }, next)
    expect(seen).toEqual([pathToFileURL(path.join(root, 'thing.mts')).href])
  })

  it('prefers .ts over .tsx when a directory holds both', async () => {
    const { next, seen } = spy()
    const { root, parentURL } = treeOf('both.ts', 'both.tsx')
    await resolve('./both', { parentURL }, next)
    expect(seen).toEqual([pathToFileURL(path.join(root, 'both.ts')).href])
  })

  /* A DIRECTORY named `core.ts` is not a module. `existsSync` accepted it and
   * the import then failed downstream, pointing nowhere near this hook. */
  it('skips a directory that is named like a file', async () => {
    const { next, seen } = spy()
    const { root, parentURL } = treeOf('core.ts/placeholder', 'core.mts')
    await resolve('./core', { parentURL }, next)
    expect(seen).toEqual([pathToFileURL(path.join(root, 'core.mts')).href])
  })

  it('falls back to a directory index', async () => {
    const { next, seen } = spy()
    const { root, parentURL } = treeOf('core/index.ts')
    await resolve('./core', { parentURL }, next)
    expect(seen).toEqual([pathToFileURL(path.join(root, 'core/index.ts')).href])
  })

  /* A FILE BEATS A DIRECTORY, which is node's own rule and the one a reader
   * expects: `./core` next to both `core.ts` and `core/index.ts` is the file. */
  it('prefers a sibling file over a directory index of the same name', async () => {
    const { next, seen } = spy()
    const { root, parentURL } = treeOf('core.ts', 'core/index.ts')
    await resolve('./core', { parentURL }, next)
    expect(seen).toEqual([pathToFileURL(path.join(root, 'core.ts')).href])
  })

  it('resolves through a parent directory reference', async () => {
    const { next, seen } = spy()
    const { root } = treeOf('shared.ts', 'ui/entry.mjs')
    const nested = pathToFileURL(path.join(root, 'ui/entry.mjs')).href
    await resolve('../shared', { parentURL: nested }, next)
    expect(seen).toEqual([pathToFileURL(path.join(root, 'shared.ts')).href])
  })

  it('passes the context through untouched', async () => {
    const { next } = spy()
    const { parentURL } = treeOf('marks.ts')
    const context = { parentURL, conditions: ['node'] }
    const got = await resolve('./marks', context, next)
    expect(got.context).toBe(context)
  })
})
