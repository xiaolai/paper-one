// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { RekeyOutcome } from '../../index'
import { useBookIntake } from './useBookIntake'

/**
 * `noteOpen` AND `noteRemoval` ARE STABLE FOR THE HOOK'S WHOLE LIFE.
 *
 * ⚠️ This is not a nicety — `App.tsx` depends on it and cannot say so. Its
 * `openBook` and `removeBook` callbacks call these two while listing neither
 * `intake` nor its methods in their dependency arrays, and they cannot: the
 * hook is declared two hundred lines BELOW those callbacks, because it needs
 * the open book's id, meta and source. Naming it in a dependency array would
 * read the binding during render, before it exists.
 *
 * So the correctness of two callbacks rests on an invariant held in this file,
 * and it used to rest on it silently — `useCallback(…, [])` written here, and
 * a comment nowhere. If either gains a dependency, `openBook` starts closing
 * over a stale function and a removal lands against the wrong ordering, with
 * nothing to show for it in either diff.
 *
 * This is that assertion. It is the whole reason the file exists.
 */

/* React refuses to treat `act` as a test boundary without this, and says so on
   stderr rather than failing — a warning nobody reads is the state this whole
   file exists to avoid. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function harness(): {
  seen: { noteOpen: unknown; noteRemoval: unknown }[]
  rerenderWithNewInputs: () => void
  unmount: () => void
} {
  const seen: { noteOpen: unknown; noteRemoval: unknown }[] = []
  let bump = (): void => {}

  function Probe(): ReactNode {
    /* Every input the hook takes is changed on each render, so a `useCallback`
       that gained ANY dependency would be rebuilt. */
    const [n, setN] = useState(0)
    bump = () => setN((was) => was + 1)
    const intake = useBookIntake({
      bookId: `book_${n}`,
      /* `null` rather than a hand-built `BookMeta`: this test cares only that
         the input CHANGES, and the id and source below carry that. */
      meta: null,
      source: `source_${n}`,
      generation: n,
      fs: null,
      add: async () => {},
      keepContent: async () => true,
      rekeyBook: async (): Promise<RekeyOutcome> => 'nothing',
      rekeyMarks: async () => {},
      rekeyCards: async () => {},
    })
    seen.push({ noteOpen: intake.noteOpen, noteRemoval: intake.noteRemoval })
    return null
  }

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  return {
    seen,
    rerenderWithNewInputs: () => act(() => bump()),
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

describe('useBookIntake', () => {
  it('hands back the same noteOpen and noteRemoval however its inputs change', () => {
    const world = harness()
    world.rerenderWithNewInputs()
    world.rerenderWithNewInputs()

    expect(world.seen.length, 'the probe did not re-render, so this proves nothing').toBeGreaterThan(2)
    const first = world.seen[0]!
    for (const [at, later] of world.seen.entries()) {
      expect(later.noteOpen, `noteOpen was rebuilt on render ${at}`).toBe(first.noteOpen)
      expect(later.noteRemoval, `noteRemoval was rebuilt on render ${at}`).toBe(first.noteRemoval)
    }
    world.unmount()
  })
})
