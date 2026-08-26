// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FoliateView } from './FoliateView'
import { DEFAULT_READING_STYLE, DEFAULT_SPACING } from '../../core/metrics'

/**
 * The reader component, mounted.
 *
 * ## Why so little is asserted here
 *
 * The lifecycle lives in `ReaderSession`, deliberately outside React — startup
 * is a chain of awaits a component can unmount in the middle of, and the
 * disposal races that creates are only verifiable when they are not entangled
 * with rendering. `session.test.ts` is where those are proven.
 *
 * What is left in this file is WIRING, and wiring fails in exactly two ways: it
 * throws while mounting, or it leaves something behind when it goes. Both are
 * observable without a real book. Neither was observable at all before, because
 * **no test had ever imported this module** — 741 lines, reported by the v8
 * coverage provider as seven functions because nothing loaded it, when it has
 * thirty-four. `vitest.config.ts` records the same discovery about
 * `Library.tsx`, in the same words: the first test to load a file does not
 * lower coverage, it reveals it.
 *
 * ## A book cannot actually open here
 *
 * foliate's `View` is a custom element behind a dynamic import, and jsdom has
 * no layout to paginate into. So the session starts and does not finish, which
 * is the honest shape of this file: it proves the component survives being
 * mounted, re-rendered and torn down, and does not pretend to prove reading.
 * The browser client's own suite opens real books, over a real socket.
 */

afterEach(cleanup)

const callbacks = () => ({
  onToc: vi.fn(),
  onRelocate: vi.fn(),
  onDocument: vi.fn(),
  onMeta: vi.fn(),
  onCover: vi.fn(),
  onError: vi.fn(),
  onNavigator: vi.fn(),
  onSelection: vi.fn(),
  onMarkDrawn: vi.fn(),
  onLink: vi.fn(),
  onExternalLink: vi.fn(),
  onFootnote: vi.fn(),
  onFileDropped: vi.fn(),
  onPageIntent: vi.fn(),
  onFixedLayout: vi.fn(),
  onDirection: vi.fn(),
})

const props = (over: Record<string, unknown> = {}) => ({
  file: null,
  generation: 0,
  stepIdx: 6,
  measure: 700,
  pageMargins: 88,
  theme: 'paper' as const,
  typeface: 'literata',
  spacing: { ...DEFAULT_SPACING },
  align: 'justified' as const,
  brightness: 1,
  contrast: 1,
  animated: true,
  paginated: true,
  lastLocation: null,
  style: DEFAULT_READING_STYLE,
  marks: [],
  ...callbacks(),
  ...over,
})

describe('FoliateView', () => {
  it('mounts with no book and reports nothing wrong', () => {
    const spies = callbacks()
    const { container } = render(<FoliateView {...props({ ...spies })} />)
    expect(container.firstChild, 'the host element must exist to mount a view into').toBeTruthy()
    expect(spies.onError).not.toHaveBeenCalled()
  })

  /* THE SETTINGS PATH. Changing one must not tear the book down and reopen it —
     reopening loses the reading position — so every settings prop travels
     through refs and an update effect rather than through the session's
     identity. What is checked here is that none of them throws on the way. */
  it('survives every reading setting changing under it', () => {
    const spies = callbacks()
    const { rerender } = render(<FoliateView {...props({ ...spies })} />)
    for (const change of [
      { theme: 'night' as const },
      { typeface: 'crimson' },
      { stepIdx: 9 },
      { measure: 420, pageMargins: 24 },
      { align: 'ragged' as const },
      { brightness: 0.8, contrast: 1.2 },
      { paginated: false },
      { animated: false },
      { spacing: { ...DEFAULT_SPACING, line: 3 } },
    ]) {
      rerender(<FoliateView {...props({ ...spies, ...change })} />)
    }
    expect(spies.onError).not.toHaveBeenCalled()
  })

  /* MARKS ARRIVE LATE and change often — they are drawn onto a book that is
     already open, so a new array must not reopen anything. */
  it('takes a changing set of marks without reopening the book', () => {
    const spies = callbacks()
    const { rerender } = render(<FoliateView {...props({ ...spies })} />)
    rerender(
      <FoliateView
        {...props({ ...spies, marks: [{ id: 'm1', cfi: 'epubcfi(/6/4!/4/2)', kind: 'highlight' }] })}
      />,
    )
    rerender(<FoliateView {...props({ ...spies, marks: [] })} />)
    expect(spies.onError).not.toHaveBeenCalled()
  })

  /**
   * UNMOUNTING MID-STARTUP IS THE RACE THIS COMPONENT IS BUILT AROUND.
   *
   * The session opens over a chain of awaits, and React can unmount the tree
   * during any of them. `session.test.ts` proves the session itself settles;
   * what is proven here is that the component's teardown runs without throwing
   * into a tree that is already gone — an unhandled rejection there takes the
   * whole app down rather than one book.
   */
  it('unmounts while a book is still opening', () => {
    const spies = callbacks()
    const file = new File(['PK'], 'Moby-Dick.epub')
    const { unmount } = render(<FoliateView {...props({ ...spies, file })} />)
    expect(() => unmount()).not.toThrow()
  })

  /* A NEW BOOK IN THE SAME COMPONENT. The generation is what lets a late answer
     from the previous book be dropped rather than applied to this one. */
  it('replaces one book with another', () => {
    const spies = callbacks()
    const first = new File(['PK'], 'One.epub')
    const second = new File(['PK'], 'Two.epub')
    const { rerender, unmount } = render(
      <FoliateView {...props({ ...spies, file: first, generation: 1 })} />,
    )
    rerender(<FoliateView {...props({ ...spies, file: second, generation: 2 })} />)
    expect(() => unmount()).not.toThrow()
  })
})
