// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_READING_STYLE, DEFAULT_SPACING } from '../../core/metrics'
import type { ForeignAnchor, MarkAnchor } from './session'

/**
 * WHEN THE READER REPAINTS — WI-22.D1's last inch.
 *
 * ## Why this file exists and is not part of `FoliateView.test.tsx`
 *
 * ⚠️ **A BOOK CANNOT OPEN IN JSDOM**, which that file says in its own header:
 * foliate's `View` is a custom element behind a dynamic import and there is no
 * layout to paginate into, so `start` never settles and `ready` stays 0. Every
 * redraw in this component is gated on `ready`, so the one behaviour proven
 * here is unreachable there — and mocking the session inside that file would
 * quietly hollow out its disposal tests, which depend on the real one.
 *
 * So the session is replaced HERE, in a file of its own, and nothing else is.
 * What is proven is the seam between two things each already proven elsewhere:
 * `useOverlays` produces a list (its own suite), `ReaderSession.redrawMarks`
 * paints it (`session.test.ts`). This is the wire between them.
 *
 * ## The defect
 *
 * The redraw effect listed `marks` and not `overlays`. Both are read through
 * refs, so neither is a dependency the compiler or `exhaustive-deps` can
 * derive — they are there as SIGNALS, named by hand, and one of the two was
 * not named. A foreign mark then appeared only if some section happened to
 * rebuild afterwards, which is exactly what the whole `subscribe` seam exists
 * to remove: *"the reader redraws only when its `marks` input changes, so a
 * share arriving mid-session can neither appear nor disappear."* The signal
 * reached `useOverlays`, `useOverlays` produced a new list, and the list
 * stopped at this effect.
 */

const fake = vi.hoisted(() => ({
  redraws: 0,
  /** Every session built, so a remount is visible rather than assumed. */
  built: 0,
}))

vi.mock('./session', () => ({
  ReaderSession: class {
    disposed = false
    constructor() {
      fake.built += 1
    }
    start() {
      return Promise.resolve()
    }
    redrawMarks() {
      fake.redraws += 1
    }
    dispose() {
      this.disposed = true
    }
    setFootnoteMount() {}
  },
}))

import { FoliateView } from './FoliateView'

afterEach(() => {
  cleanup()
  fake.redraws = 0
  fake.built = 0
})

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

const spies = callbacks()

/**
 * ⚠️ **BUILT ONCE, so a re-render changes ONLY what the test changed.**
 *
 * A fixture that rebuilds `{ ...DEFAULT_SPACING }` and `marks: []` per call
 * hands the component a new identity for both on every render — and the
 * settings effect calls `redrawMarks` too. Every test here would then have
 * passed with the defect still in place, which is the failure mode a fixture
 * is most likely to hide and least likely to be blamed for.
 */
const BASE = {
  /* A book, because the session is only created for one — the mocked session
     never reads it, so the string is enough. */
  file: 'book.epub',
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
  marks: [] as MarkAnchor[],
  overlays: [] as ForeignAnchor[],
  ...spies,
}

const props = (over: Record<string, unknown> = {}) => ({ ...BASE, ...over })

const foreign = (key: string): ForeignAnchor =>
  ({ cfi: 'epubcfi(/6/4!/4/2)', sectionIndex: 0, key, readers: 1 }) as ForeignAnchor

const mark = (cfi: string): MarkAnchor =>
  ({ cfi, sectionIndex: 0, kind: 'highlight', tint: 'yellow', style: 'fill' }) as MarkAnchor

describe('the reader repaints when its inputs change', () => {
  it('repaints when a shared passage arrives, not only when a mark does', async () => {
    const { rerender } = render(<FoliateView {...props()} />)
    await waitFor(() => expect(fake.redraws).toBeGreaterThan(0))
    const before = fake.redraws

    rerender(<FoliateView {...props({ overlays: [foreign('circle:alice:pub1')] })} />)

    expect(fake.redraws).toBeGreaterThan(before)
  })

  it('repaints when a shared passage is withdrawn', async () => {
    /* The other half, and the one a reader notices: an underline that stays up
       after its author took it down is worse than never having shown it. */
    const { rerender } = render(
      <FoliateView {...props({ overlays: [foreign('circle:alice:pub1')] })} />,
    )
    await waitFor(() => expect(fake.redraws).toBeGreaterThan(0))
    const before = fake.redraws

    rerender(<FoliateView {...props()} />)

    expect(fake.redraws).toBeGreaterThan(before)
  })

  it('repaints when the marks change, which it always did', async () => {
    const { rerender } = render(<FoliateView {...props()} />)
    await waitFor(() => expect(fake.redraws).toBeGreaterThan(0))
    const before = fake.redraws

    rerender(<FoliateView {...props({ marks: [mark('epubcfi(/6/4!/4/2)')] })} />)

    expect(fake.redraws).toBeGreaterThan(before)
  })

  it('does not reopen the book to do it', async () => {
    /* ⚠️ Marks and overlays arrive LATE, onto a book already open. Putting
       either in the effect that CREATES the session would reopen the file on
       every share — which is a page jump, not a repaint. */
    const { rerender } = render(<FoliateView {...props()} />)
    await waitFor(() => expect(fake.redraws).toBeGreaterThan(0))

    rerender(<FoliateView {...props({ overlays: [foreign('circle:alice:pub1')] })} />)
    rerender(<FoliateView {...props({ marks: [mark('epubcfi(/6/4!/4/2)')] })} />)

    expect(fake.built).toBe(1)
    expect(spies.onError).not.toHaveBeenCalled()
  })
})
