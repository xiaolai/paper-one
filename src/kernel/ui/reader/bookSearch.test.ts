import { describe, expect, it, vi } from 'vitest'
import type { View } from 'foliate-js/view.js'
import { runSearch, type SearchHit } from './bookSearch'

/**
 * `runSearch`, against a stand-in for `view.search()`.
 *
 * A HAND-ROLLED ITERATOR, not an async generator function, and that is the
 * point of it: a real generator queues `return()` behind a pending `next()`, so
 * a test built on one could not see whether the loop itself stopped at once.
 * This one lets each case decide when the book's next result arrives.
 */
type Step = IteratorResult<unknown, void>

function searchOver(next: () => Promise<Step>) {
  const results = {
    next: vi.fn(next),
    return: vi.fn(() => Promise.resolve({ done: true, value: undefined } as Step)),
  }
  const search = vi.fn(() => results)
  return { view: { search } as unknown as View, search, results }
}

/** A stream that yields `steps` in order and then ends. */
function streamOf(steps: readonly unknown[]) {
  let at = 0
  return searchOver(() =>
    Promise.resolve(
      at < steps.length ? { done: false, value: steps[at++] } : { done: true, value: undefined },
    ),
  )
}

async function collect(view: View, signal = new AbortController().signal): Promise<SearchHit[]> {
  const out: SearchHit[] = []
  for await (const hit of runSearch(view, 'whale', signal)) out.push(hit)
  return out
}

const raw = (cfi: string) => ({ cfi, excerpt: { pre: `${cfi}<`, match: cfi, post: `>${cfi}` } })
const hit = (cfi: string, label: string): SearchHit => ({
  cfi,
  label,
  pre: `${cfi}<`,
  match: cfi,
  post: `>${cfi}`,
})

/** Lets the generator run up to the point where it waits on the book. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('runSearch', () => {
  it('asks the book for the query, and flattens its groups and bare hits in order', async () => {
    const { view, search } = streamOf([
      raw('c0'),
      { label: 'Chapter 1', subitems: [raw('c1'), raw('c2')] },
      raw('c3'),
    ])
    /* A bare hit before any group has no chapter to name; one after a group
       carries that group's label, which is what foliate's order means. */
    expect(await collect(view)).toEqual([hit('c0', ''), hit('c1', 'Chapter 1'), hit('c2', 'Chapter 1'), hit('c3', 'Chapter 1')])
    expect(search).toHaveBeenCalledWith({ query: 'whale' })
  })

  it('passes over progress, the closing "done", and anything that is not a record', async () => {
    const { view } = streamOf([{ progress: 0.5 }, null, 7, raw('c0'), 'done'])
    expect(await collect(view)).toEqual([hit('c0', '')])
  })

  it('reads a group with no label, and a hit with no excerpt, as empty text', async () => {
    const { view } = streamOf([{ subitems: [{ cfi: 'c0' }] }])
    expect(await collect(view)).toEqual([{ cfi: 'c0', label: '', pre: '', match: '', post: '' }])
  })

  it('never starts a search on a signal that is already aborted', async () => {
    /* `view.search()` clears foliate's own results, so entering it only to
       discard every outcome threw away what was on screen. */
    const { view, search } = streamOf([raw('c0')])
    const stop = new AbortController()
    stop.abort()
    expect(await collect(view, stop.signal)).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })

  it('stops at once when aborted while waiting on the book, and closes its search', async () => {
    let release: (step: Step) => void = () => {}
    const { view, results } = searchOver(() => new Promise<Step>((resolve) => (release = resolve)))
    const stop = new AbortController()
    const first = runSearch(view, 'whale', stop.signal).next()
    let settled = false
    void first.then(() => (settled = true))
    await turn()

    stop.abort()
    await turn()
    expect(settled, 'the loop did not wait for the book').toBe(true)
    await expect(first).resolves.toEqual({ done: true, value: undefined })
    expect(results.return, "foliate's generator is closed").toHaveBeenCalled()
    release({ done: false, value: raw('late') })
  })

  it('yields nothing that arrived in the same turn as the abort', async () => {
    /* A result that settles first WINS the race, so the race alone says
       nothing was aborted — the signal has to be asked as well. */
    let release: (step: Step) => void = () => {}
    const { view } = searchOver(() => new Promise<Step>((resolve) => (release = resolve)))
    const stop = new AbortController()
    const first = runSearch(view, 'whale', stop.signal).next()
    await turn()

    release({ done: false, value: raw('late') })
    stop.abort()
    await expect(first).resolves.toEqual({ done: true, value: undefined })
  })

  it('stops inside a group, between one hit and the next', async () => {
    const { view } = streamOf([{ label: 'Chapter 1', subitems: [raw('c1'), raw('c2')] }])
    const stop = new AbortController()
    const got: SearchHit[] = []
    for await (const one of runSearch(view, 'whale', stop.signal)) {
      got.push(one)
      stop.abort()
    }
    expect(got).toEqual([hit('c1', 'Chapter 1')])
  })

  it('closes the search when the book runs out, too', async () => {
    const { view, results } = streamOf([raw('c0')])
    await collect(view)
    expect(results.return).toHaveBeenCalledTimes(1)
  })
})
