// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FootnotePopover } from './FootnotePopover'
import type { FootnoteRender } from './footnotes'
import type { View } from 'foliate-js/view.js'

/**
 * THE POPOVER IS NOT SHOWN WHILE IT IS MEASURING, and that is the whole point
 * of the component's three-state fit.
 *
 * A note's own document lays out inside an iframe, asynchronously, and its
 * height is not knowable in the frame the note arrives in. Shown before it is
 * known, the box appears at one size and jumps to another — read as a glitch
 * rather than as a note. So it is parked off-screen until the measurement
 * settles, and `unmeasured` is the honest third state: a note whose document
 * never laid out is shown at the full box, because a note the reader cannot see
 * is worse than one in too much white.
 *
 * ⚠️ **THIS FILE EXISTS BECAUSE THE INITIAL STATE HAD NO TEST.** `MEASURING` is
 * a module constant, and both an empty object and an empty string in place of
 * its `state` field leave the popover shown from the first frame — which is
 * exactly the flash the design refuses.
 */

afterEach(cleanup)

/** A note whose document reports `scrollHeight`, as an iframe's would. */
function noteOf(scrollHeight: number): FootnoteRender {
  return {
    href: 'notes.xhtml#n1',
    type: 'footnote',
    at: { left: 40, top: 40, right: 60, bottom: 56, width: 20, height: 16 },
    view: {
      renderer: {
        getContents: () => [{ doc: { body: { scrollHeight } } }],
      },
    } as unknown as View,
  }
}

function draw(note: FootnoteRender | null) {
  return render(
    <FootnotePopover
      note={note}
      stage={document.createElement('div')}
      column={{ left: 0, width: 600 }}
      onMount={vi.fn()}
      onCopy={vi.fn()}
      onDismiss={vi.fn()}
    />,
  )
}

describe('a note that has not been measured yet', () => {
  it('is parked and hidden, rather than shown at a size it will not keep', () => {
    /* A document with no height yet — the ordinary first frame of a note. The
       component polls for it, so this is the state it stays in until the poll
       finds a height or gives up. */
    draw(noteOf(0))
    expect(screen.queryByRole('dialog'), 'a note was shown before it was measured').toBeNull()
  })

  it('is shown once its document has a height, at that height', () => {
    draw(noteOf(120))
    const note = screen.getByRole('dialog')
    expect(note.getAttribute('aria-hidden')).toBeNull()
  })

  it('is hidden when there is no note at all', () => {
    draw(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('a note whose document never lays out', () => {
  it('is shown anyway once the measuring gives up — a note nobody can see is worse', () => {
    vi.useFakeTimers()
    try {
      draw(noteOf(0))
      expect(screen.queryByRole('dialog')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(3200)
      })
      expect(screen.getByRole('dialog'), 'giving up is a state, not a note lost for good').toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
