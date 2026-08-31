import { describe, expect, it } from 'vitest'
import { markList } from './mark'
import type { Mark } from '../marks'
import type { ServiceContext } from '../capability'
import type { ServiceEnvironment } from './environment'

/**
 * WHAT `mark.list` DOES WITH A CANCEL THAT ARRIVES DURING THE READ.
 *
 * ⚠️ **THE SIGNAL WAS CHECKED ONLY BEFORE THE READ**, and the read is where the
 * seconds go: a whole-shelf list is `loadAll`, which is one file per book
 * folder. So a `cancel` arriving while two thousand folders are being read was
 * the ORDINARY case rather than a race — and everything after the read ran
 * anyway: an `O(n log n)` sort over every mark on the shelf, with a `markRow`
 * allocation each, for a peer that had stopped listening.
 *
 * `pages` refuses to SEND any of it, which is exactly why this was invisible.
 * The work was done and thrown away, and the only symptom was a shelf that felt
 * busy after a reader closed a pane.
 *
 * `loadAll` itself still cannot be interrupted, and that is deliberate: it is a
 * SHARED store operation whose result is published to every subscriber, so it
 * does not belong to this request to abandon. What belongs to the request is
 * everything after it.
 */

/** A mark whose `bookId` reports being read — which is what the sort does. */
function watched(id: string, seen: { comparisons: number }): Mark {
  const base = {
    id,
    cfi: `epubcfi(/6/4!/${id})`,
    kind: 'highlight' as const,
    tint: 'yellow' as const,
    style: 'fill' as const,
    text: 'a passage',
    section: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    ...base,
    /* THE COMPARATOR'S FIRST MOVE is `a.bookId.localeCompare(b.bookId)`, so a
       getter here counts the sort without depending on how it is spelled. */
    get bookId() {
      seen.comparisons += 1
      return 'one'
    },
  } as unknown as Mark
}

/**
 * An environment holding these marks, whose `loadAll` runs `during`.
 *
 * ⚠️ **THE SNAPSHOT MUST NAME EVERY CLASS THE STORE PUBLISHES.** This double is
 * cast `as unknown as ServiceEnvironment`, so TypeScript does not hold it to
 * `MarkSnapshot` — when `allUnplaced` arrived (WI-21.7) and `markList` began
 * reading it, the omission surfaced as a `TypeError` from spreading
 * `undefined` rather than as a compile error. Left partial, a double like this
 * teaches the handler to be defensive about a shape the real store always
 * supplies in full.
 */
function shelfOf(
  marks: readonly Mark[],
  during: () => void,
  classes: { unplaced?: readonly Mark[]; bookmarks?: readonly Mark[] } = {},
) {
  let loads = 0
  const env = {
    services: {
      marks: {
        loadAll: async () => {
          loads += 1
          during()
        },
        getSnapshot: () => ({
          all: marks,
          allUnplaced: classes.unplaced ?? [],
          allBookmarks: classes.bookmarks ?? [],
        }),
        forBook: async () => marks,
      },
    },
  } as unknown as ServiceEnvironment
  return { env, loads: () => loads }
}

/** Drain a stream into its rows. */
async function drain(iterable: AsyncIterable<readonly unknown[]>): Promise<unknown[]> {
  const rows: unknown[] = []
  for await (const page of iterable) rows.push(...page)
  return rows
}

const ctxOf = (signal: AbortSignal) => ({ peer: 'p', signal, input: null }) as unknown as ServiceContext

describe('a cancel that lands while the shelf is being read', () => {
  it('does no work after the read', async () => {
    const seen = { comparisons: 0 }
    const marks = Array.from({ length: 50 }, (_one, i) => watched(`m${i}`, seen))
    const stop = new AbortController()
    /* ABORTED DURING `loadAll`, which is the case the top-of-function check
       cannot see: it has already run and returned false. */
    const { env, loads } = shelfOf(marks, () => stop.abort())

    const rows = await drain(markList(env)({}, ctxOf(stop.signal)))

    expect(rows, 'nothing may be sent to a peer that has gone').toEqual([])
    expect(loads(), 'the read itself is shared and still happens').toBe(1)
    expect(
      seen.comparisons,
      'every mark on the shelf was sorted and converted for a peer that had stopped listening',
    ).toBe(0)
  })

  /* AND AN ALREADY-CANCELLED REQUEST DOES NOT EVEN READ. The check at the top
     is still the cheaper one and still earns its place. */
  it('does not read at all when it was cancelled before it started', async () => {
    const seen = { comparisons: 0 }
    const stop = new AbortController()
    stop.abort()
    const { env, loads } = shelfOf([watched('m0', seen)], () => {})

    expect(await drain(markList(env)({}, ctxOf(stop.signal)))).toEqual([])
    expect(loads(), 'an aborted request must not read two thousand folders').toBe(0)
  })

  /* THE UNCANCELLED CASE STILL ANSWERS, so the assertions above are about
     cancellation rather than about the handler having stopped working. */
  it('answers normally when nothing cancelled it', async () => {
    const seen = { comparisons: 0 }
    const marks = Array.from({ length: 3 }, (_one, i) => watched(`m${i}`, seen))
    const { env } = shelfOf(marks, () => {})

    const rows = await drain(markList(env)({}, ctxOf(new AbortController().signal)))
    expect(rows).toHaveLength(3)
    expect(seen.comparisons, 'the sort should have run for a live request').toBeGreaterThan(0)
  })
})
