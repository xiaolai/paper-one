// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from './Settings'
import type { SettingsSection } from '../../core/capability'
import {
  DEFAULT_ALIGN,
  DEFAULT_READING_STYLE,
  DEFAULT_SPACING,
  DEFAULT_STEP_IDX,
  DEFAULT_THEME,
  FIGURE_HEIGHTS,
  FIGURE_WIDTHS,
  MINIMUM_SIZES,
  READING_STEPS,
  SPACING,
} from '../../core/metrics'
import { offeredFaces } from '../../core/typefaces'
import styles from './SidePane.module.css'

/**
 * What the reading panel writes, and — the part that had no test at all —
 * WHICH ROWS IT DRAWS.
 *
 * WHY THIS FILE DID NOT EXIST BEFORE. The pane is thirty-seven functions and
 * had no direct test; mounting it in the browser client is what surfaced that,
 * because loading it put thirty-two uncovered functions on the books at once.
 * A pane this size with no test is one where a row can stop firing its setter
 * and nothing says so.
 *
 * Seven of its setters became optional in phase 19 so a host that cannot act on
 * a row does not draw it — the browser has no reading ruler, no scroll port it
 * owns, no side pane on a 393px screen, and no brightness filter. **Gated on
 * the setter, never on the value**, so a composition root that passes all seven
 * sees exactly what it saw before. Both halves are asserted here: the full
 * pane draws every row, and the narrow one draws none of the seven.
 */

/**
 * ⚠️ **EVERY ELEMENT HAS A BOX**, and in jsdom none of them do.
 *
 * `useRowMenu` closes a menu whose anchor is `detached` — off screen, where its
 * items would stay focusable and exposed to assistive technology while nobody
 * can see them. jsdom answers every `getBoundingClientRect` with zeros, so the
 * anchor is always detached and the typeface menu **opens and shuts inside one
 * commit**: no click can ever reach a face. That reads exactly like a control
 * that does not work, which is why `onTypeface` sat unfired here without
 * anyone noticing. `LibraryShelf.test.tsx` carries the same stub.
 */
Element.prototype.getBoundingClientRect = function (): DOMRect {
  return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Open every collapsed group, then click every row that is not a summary. */
const GROUPS = /^(appearance|text|spacing|paragraphs|blocks|figures|page)$/i

function sweep(container: HTMLElement): void {
  /* ⚠️ **THE GROUPS OPEN ONE AT A TIME, RE-QUERYING AFTER EACH.** Toggling
   * several summaries in a row closes the ones already open and detaches the
   * buttons collected before; every later click then lands on a node no longer
   * in the document and writes nothing, which looks exactly like a pane of dead
   * controls. This file fell into that twice. */
  for (;;) {
    const shut = [...container.querySelectorAll('button')].find(
      (b) => GROUPS.test((b.textContent ?? '').trim()) && b.getAttribute('aria-expanded') !== 'true',
    )
    if (!shut) break
    fireEvent.click(shut)
  }
  /* THE TYPEFACE IS A MENU, NOT A ROW, and it is driven separately: clicking it
     mid-sweep opens a list that the next row's click dismisses, so it writes
     nothing and looks inert. */
  const opener = screen.queryByRole('button', { name: /^Typeface:/ })
  if (opener) {
    fireEvent.click(opener)
    const other = screen
      .queryAllByRole('menuitemradio')
      .find((f) => f.getAttribute('aria-checked') !== 'true')
    if (other) fireEvent.click(other)
  }
  for (const one of [...container.querySelectorAll('button')]) {
    if (one !== opener && !GROUPS.test((one.textContent ?? '').trim()) && one.isConnected) {
      fireEvent.click(one)
    }
  }
}

beforeEach(() => {
  /* jsdom has no `ResizeObserver`, and the groups measure themselves to
     animate open. Observing nothing is enough — this is about what the pane
     writes, not how tall it is. */
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

/** Every value and setter — a composition root's call. */
function full(over: Record<string, unknown> = {}) {
  const spy = {
    onTheme: vi.fn(),
    onFollowOs: vi.fn(),
    onTypeface: vi.fn(),
    onStepIdx: vi.fn(),
    onSpacing: vi.fn(),
    onAlign: vi.fn(),
    onStyle: vi.fn(),
    onPageLayout: vi.fn(),
    onToggleRuler: vi.fn(),
    onToggleScrollbar: vi.fn(),
    onToggleProgressLine: vi.fn(),
    onSide: vi.fn(),
    onBrightness: vi.fn(),
    onContrast: vi.fn(),
  }
  const props = {
    theme: DEFAULT_THEME,
    themeFollowsOs: false,
    typeface: 'literata',
    stepIdx: DEFAULT_STEP_IDX,
    spacing: DEFAULT_SPACING,
    align: DEFAULT_ALIGN,
    style: DEFAULT_READING_STYLE,
    offered: offeredFaces(new Set(['Literata'])),
    sections: [],
    pageLayout: 'scrolled' as const,
    rulerOn: false,
    scrollbarOn: false,
    progressLineOn: true,
    side: 'right' as const,
    brightness: 4,
    contrast: 4,
    ...spy,
    ...over,
  }
  return { props, spy }
}

/**
 * THE CONTROL FOR A ROW, by what a reader reads on it: a stepper's end and an
 * on-or-off row carry an accessible name of their own; a cycling row is named
 * by its label and its value run together, so it is found by the label.
 */
function rowControl(label: string): HTMLElement {
  const named = screen.queryByLabelText(label)
  if (named) return named
  const found = screen.getByText(label).closest('button')
  if (!found) throw new Error(`no row is labelled ${label}`)
  return found
}

/** What a row says it is set to — the value drawn after its label. */
function valueOf(row: HTMLElement): string | null | undefined {
  return row.lastElementChild?.textContent
}

/** What a browser passes: the seven it cannot act on are simply absent. */
function narrow() {
  const { props, spy } = full()
  for (const key of [
    'onPageLayout',
    'onToggleRuler',
    'onToggleScrollbar',
    'onToggleProgressLine',
    'onSide',
    'onBrightness',
    'onContrast',
  ]) {
    delete (props as Record<string, unknown>)[key]
  }
  return { props, spy }
}

/** WI-17.5 — the answer language, as a list in the Reading band. */
describe('the Look up language', () => {
  const ENGLISH = { tag: 'en', name: 'English', label: 'English' } as const
  const withLookUp = (onChoice = vi.fn(), choice = 'reader') =>
    full({ lookUp: { choice, readerLanguage: ENGLISH, onChoice } }).props as ComponentProps<typeof Settings>
  const openGroup = () => fireEvent.click(screen.getByRole('button', { name: 'Look up' }))

  /* A host with no Look up draws no row for it — a browser, a phone, a desktop
     with no `inference`. */
  it('is drawn only where there is a Look up', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)

    expect(screen.queryByRole('button', { name: 'Look up' })).toBeNull()
  })

  it('names what “your language” resolves to', () => {
    render(<Settings {...withLookUp()} />)
    openGroup()

    expect(screen.getByRole('option', { name: 'Your language — English' })).not.toBeNull()
  })

  it('writes the language a reader picks', () => {
    const onChoice = vi.fn()
    render(<Settings {...withLookUp(onChoice)} />)
    openGroup()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-Hans' } })

    expect(onChoice).toHaveBeenCalledWith('zh-Hans')
  })

  /* THE LIST IS THE BOUNDARY: a language the model was measured poor in is not
     an option, and a value the element reports that the setting does not hold
     writes nothing. */
  it('offers no language the measurement refused, and writes nothing for one', () => {
    const onChoice = vi.fn()
    render(<Settings {...withLookUp(onChoice)} />)
    openGroup()

    expect(screen.queryByRole('option', { name: /日本語|Japanese/ })).toBeNull()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ja' } })
    expect(onChoice).not.toHaveBeenCalled()
  })

  it('says why the list is short', () => {
    render(<Settings {...withLookUp()} />)
    openGroup()

    expect(screen.getByText(/languages its model defines words well in/)).not.toBeNull()
  })

  /* THE LABEL TAKES THE ROW'S SPARE WIDTH, so the list sits at the row's end
     the way every other row's control does. */
  it('lets the label take the row’s spare width', () => {
    render(<Settings {...withLookUp()} />)
    openGroup()

    /* `flexGrow`, not `flex`: jsdom expands the shorthand to `1 1 0%`, and growing is the part the row relies on. */
    expect(screen.getByText('Define words in').style.flexGrow).toBe('1')
  })
})

/**
 * "Choose one" LANDS ON ITS SECTION (phase 17, L3): opened — it is closed at
 * rest — brought into view, and reported, once.
 */
describe('a request to reveal a section', () => {
  const models = { id: 'inference:models', title: 'Local models', order: 15, render: () => null } as unknown as SettingsSection

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      run(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  it('opens the section, brings it into view, and reports the request answered', () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const onRevealed = vi.fn()
    const { props } = full({ sections: [models], reveal: { section: 'inference:models', nonce: 3, pending: true }, onRevealed })
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)

    expect(screen.getByRole('button', { name: 'Local models' }).getAttribute('aria-expanded')).toBe('true')
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(onRevealed).toHaveBeenCalledWith(3)
  })

  /* A remount finds the request already answered, and leaves alone a group the
     reader may since have closed. */
  it('does nothing for a request already answered', () => {
    const onRevealed = vi.fn()
    const { props } = full({ sections: [models], reveal: { section: 'inference:models', nonce: 3, pending: false }, onRevealed })
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)

    expect(screen.getByRole('button', { name: 'Local models' }).getAttribute('aria-expanded')).toBe('false')
    expect(onRevealed).not.toHaveBeenCalled()
  })

  /**
   * THE FRAME, HELD RATHER THAN RUN. The stub above runs it on the spot, which
   * cannot say what is still queued, what a newer request replaced, or what an
   * unmount left behind. `land` delivers every frame still queued, as the next
   * paint would.
   */
  function heldFrames() {
    let issued = 0
    const pending = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      issued += 1
      pending.set(issued, run)
      return issued
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pending.delete(id)
    })
    return {
      pending,
      land: () => {
        const due = [...pending.values()]
        pending.clear()
        for (const run of due) run(0)
      },
    }
  }

  /** Which group each scroll moved, and how. */
  function scrolls() {
    const seen: { readonly group: string | null; readonly options: unknown }[] = []
    Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
      seen.push({ group: this.getAttribute('data-group'), options })
    }
    return seen
  }

  /* `Devices` is drawn FIRST, so a selector that matched any group rather than
     the one asked for would move the wrong one. */
  const devices = { id: 'peer:devices', title: 'Devices', render: () => null } as unknown as SettingsSection
  const request = (section: string, nonce: number, pending = true) => ({ section, nonce, pending })
  const settings = (over: Record<string, unknown>) =>
    full({ sections: [devices, models], ...over }).props as ComponentProps<typeof Settings>
  const AT_THE_TOP = { block: 'start' }

  it('scrolls the requested group, and only it, to the top of the panel once painted', () => {
    const frames = heldFrames()
    const seen = scrolls()
    render(<Settings {...settings({ reveal: request('inference:models', 1) })} />)
    expect(seen, 'it scrolled before the opened group had painted').toEqual([])

    frames.land()
    expect(seen).toEqual([{ group: 'inference:models', options: AT_THE_TOP }])
  })

  /* A SECTION THIS READER IS NOT OFFERED finds no group and nothing moves — and
     the request is still answered, so a remount does not find it again. */
  it('moves nothing, and throws nothing, for a section that is not drawn', () => {
    const frames = heldFrames()
    const seen = scrolls()
    const onRevealed = vi.fn()
    render(<Settings {...settings({ sections: [devices], reveal: request('inference:models', 4), onRevealed })} />)

    expect(() => frames.land()).not.toThrow()
    expect(seen).toEqual([])
    expect(onRevealed.mock.calls).toEqual([[4]])
  })

  /* A SECTION ID IS A CAPABILITY'S STRING, and the registry checks only its
     prefix — so an id no CSS selector can spell reached `querySelector` and
     threw inside the frame, where nothing catches it (#138). */
  it('finds a section whose id no selector could spell', () => {
    const frames = heldFrames()
    const seen = scrolls()
    const odd = { id: 'inference:a"b]', title: 'Odd', render: () => null } as unknown as SettingsSection
    render(<Settings {...settings({ sections: [devices, odd], reveal: request('inference:a"b]', 8) })} />)

    expect(() => frames.land()).not.toThrow()
    expect(seen).toEqual([{ group: 'inference:a"b]', options: AT_THE_TOP }])
  })

  /* ONE ANSWER PER NONCE. A host that hands the same request over again — a
     fresh handler on every render is the ordinary case — had it answered again
     and its scroll queued again (#139). */
  it('answers a request once, however often it is handed over', () => {
    const frames = heldFrames()
    const seen = scrolls()
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Settings {...settings({ reveal: request('inference:models', 9), onRevealed: first })} />)
    rerender(<Settings {...settings({ reveal: request('inference:models', 9), onRevealed: second })} />)

    frames.land()
    expect(seen).toEqual([{ group: 'inference:models', options: AT_THE_TOP }])
    expect([...first.mock.calls, ...second.mock.calls]).toEqual([[9]])
  })

  /* ⚠️ AND ANSWERING ONCE MUST NOT COST THE FIRST REVEAL. React mounts an
     effect, tears it down and mounts it again, which is what every developer
     runs: the teardown cancels the frame, and a nonce marked answered when the
     frame was merely QUEUED refused to queue another — the request was reported
     answered and nothing moved (#139, round 2). */
  it('still scrolls the first reveal when React mounts its effects twice', () => {
    const frames = heldFrames()
    const seen = scrolls()
    const onRevealed = vi.fn()
    render(
      <StrictMode>
        <Settings {...settings({ reveal: request('inference:models', 11), onRevealed })} />
      </StrictMode>,
    )

    frames.land()
    expect(seen).toEqual([{ group: 'inference:models', options: AT_THE_TOP }])
    expect(onRevealed.mock.calls).toEqual([[11]])
  })

  /* A NEWER REQUEST BEFORE THE FIRST HAS PAINTED replaces it: one scroll, to the
     newer section, and each request reported to the handler that came with it. */
  it('lets a newer request replace one whose frame has not landed', () => {
    const frames = heldFrames()
    const seen = scrolls()
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Settings {...settings({ reveal: request('peer:devices', 1), onRevealed: first })} />)
    rerender(<Settings {...settings({ reveal: request('inference:models', 2), onRevealed: second })} />)
    expect(frames.pending.size, 'the replaced request’s frame is still queued').toBe(1)

    frames.land()
    expect(seen).toEqual([{ group: 'inference:models', options: AT_THE_TOP }])
    expect(first.mock.calls).toEqual([[1]])
    expect(second.mock.calls).toEqual([[2]])
  })

  /* BUT THE ANSWER IS NOT A NEWER REQUEST. Reporting the request answered
     changes it, and the frame it scheduled must survive that — cancelling on
     every change would cancel the very scroll the request was for. */
  it('still scrolls when the request is marked answered before its frame lands', () => {
    const frames = heldFrames()
    const seen = scrolls()
    const onRevealed = vi.fn()
    const { rerender } = render(<Settings {...settings({ reveal: request('inference:models', 3), onRevealed })} />)
    rerender(<Settings {...settings({ reveal: request('inference:models', 3, false), onRevealed })} />)

    frames.land()
    expect(seen).toEqual([{ group: 'inference:models', options: AT_THE_TOP }])
    expect(onRevealed.mock.calls).toEqual([[3]])
  })

  /* ⚠️ **AND ONCE ITS FRAME HAS LANDED, THE REQUEST STAYS ANSWERED.** A host
     that has not yet caught up hands the same pending request over again, with a
     fresh handler — the ordinary case, since `SidePane` makes one per render.
     The in-flight mark is gone by then, so only the answered nonce stands
     between that and a second scroll, a second report, and a group the reader
     had closed in between springing open again. */
  it('does not answer a request again after its frame has landed', () => {
    const frames = heldFrames()
    const seen = scrolls()
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Settings {...settings({ reveal: request('inference:models', 12), onRevealed: first })} />)
    frames.land()
    const toggle = screen.getByRole('button', { name: 'Local models' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded'), 'the reader closed the revealed group').toBe('false')

    rerender(<Settings {...settings({ reveal: request('inference:models', 12), onRevealed: second })} />)
    frames.land()
    expect(seen).toEqual([{ group: 'inference:models', options: AT_THE_TOP }])
    expect(first.mock.calls).toEqual([[12]])
    expect(second).not.toHaveBeenCalled()
    expect(toggle.getAttribute('aria-expanded'), 'an answered request opened the group again').toBe('false')
  })

  /* A HOST THAT DOES NOT TRACK THE REQUEST passes no handler. The section is
     still opened and brought into view, and the panel is still there. */
  it('opens and scrolls with no handler to report to', () => {
    const frames = heldFrames()
    const seen = scrolls()
    render(<Settings {...settings({ reveal: request('inference:models', 5) })} />)

    frames.land()
    expect(screen.getByRole('button', { name: 'Local models' }).getAttribute('aria-expanded')).toBe('true')
    expect(seen).toEqual([{ group: 'inference:models', options: AT_THE_TOP }])
  })

  it('cancels a frame still queued when the panel unmounts', () => {
    const frames = heldFrames()
    const { unmount } = render(<Settings {...settings({ reveal: request('inference:models', 6) })} />)
    expect(frames.pending.size).toBe(1)

    unmount()
    expect(frames.pending.size, 'a frame outlived the panel that queued it').toBe(0)
  })

  /**
   * AND ONE ALREADY ON ITS WAY FINDS NO PANEL. React clears the ref in the
   * commit that removes the panel, and runs the cleanup that cancels the frame
   * after it — at the end of that commit only for a discrete update, otherwise
   * as a later task, and a frame can land in between.
   */
  it('moves nothing when a frame lands after the panel is gone', () => {
    const frames = heldFrames()
    const seen = scrolls()
    const { unmount } = render(<Settings {...settings({ reveal: request('inference:models', 7) })} />)
    const [landing] = [...frames.pending.values()]
    if (landing === undefined) throw new Error('no frame was queued, so this proves nothing')
    unmount()

    expect(() => landing(0)).not.toThrow()
    expect(seen).toEqual([])
  })
})

describe('what it writes', () => {
  it('reports a theme the reader picked', () => {
    const { props, spy } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    fireEvent.click(screen.getByRole('button', { name: /Night/i }))
    expect(spy.onTheme).toHaveBeenCalledWith('night')
  })

  it('reports a change to following the system', () => {
    const { props, spy } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    fireEvent.click(screen.getByText('Follow system appearance').closest('button')!)
    expect(spy.onFollowOs).toHaveBeenCalled()
  })

  it('reports a larger and a smaller type size', () => {
    const { props, spy } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    const steppers = screen.getAllByRole('button', { name: /larger|smaller/i })
    for (const one of steppers) fireEvent.click(one)
    expect(spy.onStepIdx).toHaveBeenCalled()
  })

  /* ONE STEP EACH WAY, FROM THE STEP SHOWN — "something was called" above is
     satisfied by a Larger that asks for a smaller size. */
  it('asks for the step above and the step below the one shown', () => {
    const { props, spy } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(screen.getByText(String(READING_STEPS[DEFAULT_STEP_IDX]!.size))).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Larger text' }))
    expect(spy.onStepIdx.mock.calls).toEqual([[DEFAULT_STEP_IDX + 1]])
    fireEvent.click(screen.getByRole('button', { name: 'Smaller text' }))
    expect(spy.onStepIdx.mock.calls).toEqual([[DEFAULT_STEP_IDX + 1], [DEFAULT_STEP_IDX - 1]])
  })

  /* THE ENDS GO DEAD, and only the ends: the smallest step has no Smaller and
     the largest no Larger, and the step beside each still has both. */
  it('disables Smaller at the smallest step and Larger at the largest, and neither one step in', () => {
    const disabled = (stepIdx: number) => {
      const { props } = full({ stepIdx })
      render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
      const answer = {
        smaller: screen.getByRole('button', { name: 'Smaller text' }).hasAttribute('disabled'),
        larger: screen.getByRole('button', { name: 'Larger text' }).hasAttribute('disabled'),
      }
      cleanup()
      return answer
    }
    const last = READING_STEPS.length - 1
    expect(disabled(0)).toEqual({ smaller: true, larger: false })
    expect(disabled(1)).toEqual({ smaller: false, larger: false })
    expect(disabled(last - 1)).toEqual({ smaller: false, larger: false })
    expect(disabled(last)).toEqual({ smaller: false, larger: true })
  })

  /* THE ROW IS SET AS THE READING ROW — a static row holding the face picker
     and the stepper side by side, not a pressable one. */
  it('sets the face and size in the reading row’s own style', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    const row = screen.getByRole('button', { name: 'Larger text' }).parentElement?.parentElement
    expect(row?.className).toBe(`${styles.settingRow} ${styles.settingStatic} ${styles.readingRow}`)
  })

  /* EACH SWATCH SAYS WHETHER IT IS THE THEME IN USE — to the eye through
     `data-on`, and to assistive technology through `aria-pressed` — and only
     that one says so. */
  it('marks the theme in use, and only it, as chosen', () => {
    const { props } = full({ theme: 'sepia' })
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    for (const label of ['Paper', 'Slate', 'Sepia', 'Sage', 'Night']) {
      const chip = screen.getByRole('button', { name: label })
      const chosen = String(label === 'Sepia')
      expect(chip.getAttribute('aria-pressed'), `${label}'s aria-pressed`).toBe(chosen)
      expect(chip.getAttribute('data-on'), `${label}'s data-on`).toBe(chosen)
    }
  })
})

/**
 * WHAT EACH READING-STYLE ROW WRITES, row by row — the key and the value.
 *
 * `every control` and `the collapsed groups` prove a setter FIRED, and a row
 * handing `onStyle` the wrong key, or nothing at all, fires it just the same.
 * So each row here is pressed alone, from the defaults, and has to write
 * exactly one call: its own key, and the state or step next to the default.
 * The value each cycling row SHOWS is asserted first, because a row whose
 * label fell through is a control that lies about where it is.
 */
describe('what each reading-style row writes', () => {
  type Setter = 'onStyle' | 'onSpacing'
  const ROWS: readonly {
    readonly group: string
    readonly row: string
    readonly shows?: string
    readonly setter: Setter
    readonly writes: readonly unknown[]
  }[] = [
    { group: 'Text', row: 'More minimum size', setter: 'onStyle', writes: ['minimumSize', MINIMUM_SIZES.def + 1] },
    { group: 'Text', row: 'Typography', shows: "Paper's", setter: 'onStyle', writes: ['fidelity', 'publisher'] },
    { group: 'Spacing', row: 'More letter', setter: 'onSpacing', writes: ['letter', SPACING.letter.def + 1] },
    { group: 'Spacing', row: 'More word', setter: 'onSpacing', writes: ['word', SPACING.word.def + 1] },
    { group: 'Spacing', row: 'More line', setter: 'onSpacing', writes: ['line', SPACING.line.def + 1] },
    { group: 'Spacing', row: 'More paragraph', setter: 'onSpacing', writes: ['paragraph', SPACING.paragraph.def + 1] },
    { group: 'Spacing', row: 'Space CJK and Latin', shows: 'Off', setter: 'onStyle', writes: ['cjkSpacing', true] },
    { group: 'Paragraphs', row: 'Separation', shows: 'Space', setter: 'onStyle', writes: ['separation', 'indent'] },
    { group: 'Paragraphs', row: 'Opening', shows: 'None', setter: 'onStyle', writes: ['flourish', 'drop-cap'] },
    { group: 'Paragraphs', row: 'Heading sizes', shows: "Publisher's", setter: 'onStyle', writes: ['headingScale', 'paper'] },
    { group: 'Blocks', row: 'Quotations', shows: 'Indented', setter: 'onStyle', writes: ['blockquote', 'rule'] },
    { group: 'Blocks', row: 'Code face', shows: "Publisher's", setter: 'onStyle', writes: ['codeFace', 'paper'] },
    { group: 'Blocks', row: 'Long code lines', shows: 'Scroll', setter: 'onStyle', writes: ['codeWrap', 'wrap'] },
    { group: 'Blocks', row: 'Wide tables', shows: 'Scroll', setter: 'onStyle', writes: ['wideTables', 'shrink'] },
    { group: 'Blocks', row: 'Note size', shows: "Paper's", setter: 'onStyle', writes: ['noteSize', 'publisher'] },
    { group: 'Figures', row: 'More width', setter: 'onStyle', writes: ['figureWidth', FIGURE_WIDTHS.def + 1] },
    { group: 'Figures', row: 'Less height', setter: 'onStyle', writes: ['figureHeight', FIGURE_HEIGHTS.def - 1] },
    { group: 'Figures', row: 'Frame', shows: 'None', setter: 'onStyle', writes: ['figureFrame', 'hairline'] },
    { group: 'Figures', row: 'Scale with text', shows: 'Off', setter: 'onStyle', writes: ['figureScalesWithText', true] },
  ]

  it('writes its own key and the next value, and nothing else', () => {
    const { props, spy } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    for (const group of new Set(ROWS.map((one) => one.group))) {
      const heading = screen.getByRole('button', { name: group })
      if (heading.getAttribute('aria-expanded') !== 'true') fireEvent.click(heading)
    }
    for (const { row, shows, setter, writes } of ROWS) {
      const control = rowControl(row)
      if (shows !== undefined) expect(valueOf(control), `${row} shows`).toBe(shows)
      spy.onStyle.mockClear()
      spy.onSpacing.mockClear()
      fireEvent.click(control)
      expect(spy[setter].mock.calls, `${row} writes`).toEqual([writes])
      const other: Setter = setter === 'onStyle' ? 'onSpacing' : 'onStyle'
      expect(spy[other], `${row} wrote through ${other} as well`).not.toHaveBeenCalled()
    }
  })

  /* THE PARAGRAPH SPACING IS HIDDEN WHERE IT CANNOT DO ANYTHING — `Indent`
     zeroes the space between paragraphs — and drawn for the two separations
     that use it. */
  it('draws the paragraph spacing only where paragraphs are separated by space', () => {
    for (const [separation, drawn] of [
      ['space', true],
      ['indent', false],
      ['both', true],
    ] as const) {
      const { props } = full({ style: { ...DEFAULT_READING_STYLE, separation } })
      render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
      fireEvent.click(screen.getByRole('button', { name: 'Spacing' }))
      expect(screen.queryByText('Paragraph') !== null, `Paragraph under ${separation}`).toBe(drawn)
      expect(screen.queryByText('Line'), 'the rest of Spacing is drawn either way').not.toBeNull()
      cleanup()
    }
  })
})

describe('which rows it draws', () => {
  /* A COMPOSITION ROOT SEES EVERY ROW. This is the half that guards the
     desktop: the seven became optional, and a mistake in that change would
     take a row off the desktop's pane silently. */
  it('draws all seven when every setter is passed', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    for (const label of [
      'Flow',
      'Reading ruler',
      'Scrollbar',
      'Progress rule',
      'Side pane position',
      'Brightness',
      'Contrast',
    ]) {
      expect(screen.queryByText(label), `${label} should be drawn`).not.toBeNull()
    }
  })

  /* AND A HOST THAT CANNOT ACT DRAWS NONE OF THEM. Absent, not disabled: a
     disabled row names a feature the host will never have. */
  it('draws none of the seven when their setters are absent', () => {
    const { props } = narrow()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    for (const label of [
      'Flow',
      'Reading ruler',
      'Scrollbar',
      'Progress rule',
      'Side pane position',
      'Brightness',
      'Contrast',
    ]) {
      expect(screen.queryByText(label), `${label} should not be drawn`).toBeNull()
    }
  })

  /* THE ROWS IT CAN ACT ON ARE STILL THERE — the narrowing must not take the
     pane's whole point with it. */
  it('still draws the rows a browser can act on', () => {
    const { props } = narrow()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(screen.queryByText('Follow system appearance')).not.toBeNull()
    expect(screen.queryByText('Alignment')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Night/i })).not.toBeNull()
  })
})

/**
 * EVERY CONTROL, CLICKED.
 *
 * The pane is thirty-seven functions and almost all of them are a row's own
 * handler — an inline arrow that reads one value and calls one setter. Sampling
 * three of those leaves the rest able to stop working silently, which is the
 * exact failure a pane this size invites: nothing renders differently when a
 * handler is wrong, it just stops writing.
 *
 * So this opens every collapsed group and clicks every control it finds, then
 * asserts that the setters fired. It is deliberately not assertion-per-row —
 * the rows' individual meanings are the design system's, not this file's — but
 * it does prove that no control is inert.
 */
describe('every control', () => {
  it('reaches a setter — no visible row is inert', () => {
    const { props, spy } = full()
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)

    /* ⚠️ THE GROUPS ARE NOT TOGGLED FIRST. An earlier version clicked every
       summary to open the collapsed groups — which also CLOSED `Appearance`
       and `Text`, the two that are open by default, so the rows it then
       collected were gone and not one setter fired. Clicking what is visible
       is both simpler and what a reader can actually reach. */
    /* ⚠️ AND THE GROUP SUMMARIES ARE SKIPPED. The first button in the pane is
       `APPEARANCE`'s own summary; clicking it COLLAPSES the group, which
       detaches every button collected after it — so the remaining clicks land
       on nodes no longer in the document and not one setter fires. That is
       what "only nothing fired" meant, and it looked exactly like a pane of
       dead controls. */
    expect(
      [...container.querySelectorAll('button')].filter((b) => !GROUPS.test((b.textContent ?? '').trim())).length,
    ).toBeGreaterThan(8)
    sweep(container)

    /**
     * ⚠️ **EVERY SETTER, NAMED — AND THIS USED TO BE "AT LEAST FOUR".**
     *
     * `>= 4` out of seventeen is a threshold, and a threshold on a count is the
     * thing this pane invites: nothing renders differently when a handler is
     * wrong, it just stops writing. Thirteen setters could have gone silent and
     * this stayed green. It also hid a real one — `onTypeface` never fired at
     * all, because the face menu cannot open without a layout box.
     *
     * Derived from `spy` rather than listed, so a setter added to the pane with
     * no control fails this rather than being discovered by a reader whose
     * choice does nothing.
     */
    for (const [name, fn] of Object.entries(spy)) {
      expect(fn.mock.calls.length, `${name} never fired: its row is inert`).toBeGreaterThan(0)
    }
  })
})

/**
 * THE COLLAPSED GROUPS, one at a time.
 *
 * `Spacing`, `Paragraphs`, `Blocks` and `Figures` start closed, and a closed
 * group renders no rows — so a pane test that clicks what is visible never
 * reaches them, and every handler in them can stop writing without a word.
 * That is most of this pane.
 *
 * ⚠️ OPENED ONE AT A TIME, RE-QUERYING AFTER EACH. Toggling several summaries
 * in a row closes the ones that were already open and detaches the buttons
 * collected before — every subsequent click then lands on a node no longer in
 * the document and writes nothing, which looks exactly like a pane of dead
 * controls. That is a trap this file fell into twice.
 */
describe('the collapsed groups', () => {
  /**
   * WHICH SETTER EACH GROUP OWNS.
   *
   * ⚠️ **THE ASSERTION USED TO BE "SOMETHING FIRED".** Every one of these tests
   * clicked EVERY button in the whole panel, including the rows of the groups
   * that are open at rest — so `onTheme` firing satisfied "Figures wrote
   * something", and every handler inside Figures could have been inert. Four
   * tests, none of them about the group it names.
   *
   * Named per group, so the test fails where the defect is.
   */
  const OWNS: Record<string, readonly string[]> = {
    Spacing: ['onSpacing'],
    Paragraphs: ['onStyle'],
    Blocks: ['onStyle'],
    Figures: ['onStyle'],
  }

  for (const group of ['Spacing', 'Paragraphs', 'Blocks', 'Figures']) {
    it(`writes something from ${group}`, () => {
      const { props, spy } = full()
      const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)

      const summary = [...container.querySelectorAll('button')].find(
        (b) => (b.textContent ?? '').trim().toLowerCase() === group.toLowerCase(),
      )
      expect(summary, `${group} should have a summary to open`).toBeDefined()
      fireEvent.click(summary!)

      /**
       * ⚠️ **ONLY THIS GROUP'S ROWS, AND THE SWEEP USED TO CLICK THE WHOLE
       * PANEL.** A setter belonging to an always-open group then satisfied the
       * assertion below, and the group the test is named after was never
       * exercised at all.
       *
       * Scoped through `aria-controls`, which `PaneGroup` already sets to the
       * id of the body it opens. Diffing the rows by LABEL was the first
       * attempt and is wrong: a stepper's "larger"/"smaller" appear in more
       * than one group, so the group's own rows were filtered out as
       * pre-existing and nothing was clicked.
       */
      const bodyId = summary!.getAttribute('aria-controls')
      expect(bodyId, `${group}'s summary should name the body it opens`).toBeTruthy()
      const body = container.querySelector(`#${CSS.escape(bodyId!)}`)
      expect(body, `${group} should render a body when open`).not.toBeNull()

      const rows = [...(body?.querySelectorAll('button') ?? [])]
      expect(rows.length, `${group} should render rows when open`).toBeGreaterThan(0)
      for (const one of rows) {
        if (one.isConnected) fireEvent.click(one)
      }

      for (const name of OWNS[group] ?? []) {
        expect(
          spy[name as keyof typeof spy].mock.calls.length,
          `${group} never reached ${name}: its rows are inert`,
        ).toBeGreaterThan(0)
      }
    })
  }
})

/**
 * ⚠️ **A PREFERENCE THAT IS NOT BEING SAVED LOOKS EXACTLY LIKE ONE THAT IS**,
 * right up until the next launch throws it away.
 *
 * The store used to report a refused write by THROWING out of `set`, into an
 * `onClick` that did not catch it. Nothing was drawn, nothing was logged where
 * a reader would see it, and the rest of a two-field handler never ran. The
 * refusal is a state now, and this is the sentence it draws — the same one the
 * Notes and Cards panels draw for the same condition.
 */
describe('when the settings are not being saved', () => {
  const notice = /not being saved/i

  it('says so, and says what it costs', () => {
    const { props } = full()
    render(<Settings {...({ ...props, persistent: false } as ComponentProps<typeof Settings>)} />)
    expect(screen.getByText(notice).textContent).toMatch(/until you close Paper/i)
  })

  it('says nothing when the store is saving', () => {
    const { props } = full()
    render(<Settings {...({ ...props, persistent: true } as ComponentProps<typeof Settings>)} />)
    expect(screen.queryByText(notice)).toBeNull()
  })

  /* AND SAYS NOTHING BY DEFAULT. A host with no answer must not accuse a
     working store — the prop is optional and this is what that means. */
  it('says nothing when the host does not say', () => {
    const { props } = full()
    delete (props as Record<string, unknown>)['persistent']
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(screen.queryByText(notice)).toBeNull()
  })

  /* The controls still work: this is a notice, not a disabled panel. A reader
     may still want Night for this session. */
  it('leaves every control usable', () => {
    const { props, spy } = full()
    render(<Settings {...({ ...props, persistent: false } as ComponentProps<typeof Settings>)} />)
    fireEvent.click(screen.getByRole('button', { name: /Night/i }))
    expect(spy.onTheme).toHaveBeenCalledWith('night')
  })
})

/**
 * THE TWO BANDS, AND WHICH SIDE EACH HEADING FALLS ON.
 *
 * The panel reached thirteen top-level headings in one 400px column — seven
 * the kernel writes and up to six contributed — so `Figures` sat beside
 * `Local models`. Those answer different questions, and a reader after the
 * second read past five groups of typography to reach it.
 *
 * Asserted through the DOM rather than by reading the source, because what
 * matters is which band a heading ENDS UP IN. A source scan would pass on a
 * `</PaneBand>` in the wrong place, which is the one mistake this arrangement
 * makes easy to introduce and impossible to see in a diff.
 */
describe('the two bands', () => {
  /** A contributed section, shaped like a capability's. */
  const section = (id: string, title: string) => ({ id, title, render: () => null })

  function bandOf(heading: string, container: HTMLElement): string | null {
    const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(heading))
    const band = found?.closest('section')
    return band?.querySelector('h3')?.textContent ?? null
  }

  it('puts the kernel groups under Reading and the contributed ones under The app', () => {
    const { props } = full({
      sections: [section('peer:devices', 'Devices'), section('inference:models', 'Local models')],
    })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    for (const heading of ['Appearance', 'Text', 'Spacing', 'Paragraphs', 'Blocks', 'Figures', 'Page']) {
      expect(bandOf(heading, container), `${heading} belongs to Reading`).toBe('Reading')
    }
    for (const heading of ['Devices', 'Local models']) {
      expect(bandOf(heading, container), `${heading} belongs to The app`).toBe('The app')
    }
  })

  /**
   * ⚠️ **THE PANEL SHOWED SETTINGS FOR A PANEL THE READER COULD NOT OPEN.**
   * `UNFINISHED_PANE_IDS` hid the Companion pane and never touched
   * `Settings → Companion`, which sat in The app band from the day the
   * capability contributed it. A section configuring a surface that is not
   * offered is worse than either half alone: it is evidence the feature is
   * there.
   *
   * `inference:models` is in the same assertion deliberately. It ships — the
   * selection bar's Look up runs on it — so a rule that hid it because the
   * companion shares its engine would take a working control away.
   */
  it('hides an unfinished capability’s settings, and only that capability’s', () => {
    const both = [
      section('companion:provider', 'Companion'),
      section('inference:models', 'Local models'),
      section('inference:endpoints', 'Cloud endpoints'),
    ]
    const { props } = full({ sections: both })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(bandOf('Local models', container)).toBe('The app')
    expect(bandOf('Cloud endpoints', container)).toBe('The app')
    expect(bandOf('Companion', container)).toBeNull()

    /* One chord later it is there, which is what makes the line above about
       the gate rather than about the section having been dropped. */
    const { props: dev } = full({
      sections: both,
      developer: { hidden: [], onSetHidden: () => {}, recording: false },
    })
    const revealed = render(<Settings {...(dev as ComponentProps<typeof Settings>)} />)
    expect(bandOf('Companion', revealed.container)).toBe('The app')
  })

  /**
   * ⚠️ **ONE SECTION CAN BE UNFINISHED WHILE ITS CAPABILITY SHIPS.** Cloud
   * endpoints was never measured against a real provider and nothing connects
   * one to an answer, so `inference` marks that section `unfinished` — while
   * Local models, beside it and from the same capability, is what Look up runs
   * on. The list of unfinished PANELS cannot say that; the flag can.
   *
   * BOTH HALVES, and a sibling from the same capability in each, so what is
   * measured is the flag and not the capability's prefix.
   */
  it('offers a section marked unfinished only under developer options, and its finished sibling always', () => {
    const sections = [
      section('inference:models', 'Local models'),
      { ...section('inference:endpoints', 'Cloud endpoints'), unfinished: true as const },
    ]
    const { props } = full({ sections })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(bandOf('Local models', container)).toBe('The app')
    expect(bandOf('Cloud endpoints', container), 'an unfinished section was offered to every reader').toBeNull()
    cleanup()

    const { props: dev } = full({ sections, developer: { hidden: [], onSetHidden: () => {}, recording: false } })
    const revealed = render(<Settings {...(dev as ComponentProps<typeof Settings>)} />)
    expect(bandOf('Local models', revealed.container)).toBe('The app')
    expect(bandOf('Cloud endpoints', revealed.container), 'developer options did not reveal it').toBe('The app')
  })

  /* `hidden` NAMES PANELS, so it cannot take an unfinished section away again:
     there is no panel of that name to have ticked. Hiding every unfinished
     panel leaves the section where developer options put it. */
  it('keeps an unfinished section offered under developer options whatever panels are hidden', () => {
    const sections = [{ ...section('inference:endpoints', 'Cloud endpoints'), unfinished: true as const }]
    const { props } = full({
      sections,
      developer: { hidden: ['companion', 'cards', 'inference'], onSetHidden: () => {}, recording: false },
    })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(bandOf('Cloud endpoints', container)).toBe('The app')
  })

  it('captions each band with a real heading, so the split is structure and not a drawn line', () => {
    /* A SECTION TO SHOW, or there is no "The app" band to caption — see
       'a container with nothing in it'. */
    const { props } = full({ sections: [section('peer:devices', 'Devices')] })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    const bands = [...container.querySelectorAll('section')]
    expect(bands.map((one) => one.querySelector('h3')?.textContent)).toEqual(['Reading', 'The app'])
    /* Named by its own caption — a section labelled by nothing is a landmark
       that announces itself as "section" and helps no one. */
    for (const band of bands) {
      const id = band.getAttribute('aria-labelledby')
      expect(id, 'every band names its caption').toBeTruthy()
      expect(band.querySelector(`h3#${CSS.escape(id ?? '')}`)).not.toBeNull()
    }
  })

  /* NO RULE OVER THE FIRST BAND, where the panel's own title is already the
     edge; a rule over every band after it. */
  it('rules every band but the first', () => {
    const { props } = full({
      sections: [section('peer:devices', 'Devices')],
      developer: { hidden: [], onSetHidden: () => {}, recording: false },
    })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(
      [...container.querySelectorAll('section')].map((band) => [band.querySelector('h3')?.textContent, band.getAttribute('data-ruled')]),
    ).toEqual([
      ['Reading', 'false'],
      ['The app', 'true'],
      ['Developer', 'true'],
    ])
  })

  /* NO CHEVRON ON A CAPTION. Every group heading in this pane carries one and
     every group heading opens something; a caption that looked the same but
     did nothing is the exact defect `PaneGroup` was built to end. */
  it('gives the band captions no disclosure, because they disclose nothing', () => {
    const { props } = full({ sections: [section('peer:devices', 'Devices')] })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    const captions = [...container.querySelectorAll('h3')]
    /* NOT VACUOUS. With no captions at all every assertion below it holds and
       the test reports green — which is exactly what it did against the panel
       before the bands existed, while the two tests above it failed. A loop
       over an empty list is the quietest way for a guard to stop guarding. */
    expect(captions.length, 'there are band captions to check').toBe(2)
    for (const caption of captions) {
      expect(caption.querySelector('svg'), 'a band caption draws no chevron').toBeNull()
      expect(caption.closest('button'), 'a band caption is not a button').toBeNull()
    }
  })
})

describe('a contributed section', () => {
  it('is rendered only once its group is opened, and inside a boundary of its own', () => {
    const render1 = vi.fn(() => <p>devices body</p>)
    const { props } = full({ sections: [{ id: 'peer:devices', title: 'Devices', render: render1 }] })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(render1).not.toHaveBeenCalled()
    const summary = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Devices'))
    expect(summary).toBeDefined()
    fireEvent.click(summary!)
    expect(render1).toHaveBeenCalled()
    expect(screen.getByText('devices body')).toBeTruthy()
  })

  it('cannot take the panel with it when it throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { props } = full({
      sections: [
        {
          id: 'peer:devices',
          title: 'Devices',
          render: () => {
            throw new Error('port gone')
          },
        },
      ],
    })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    const summary = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Devices'))
    fireEvent.click(summary!)
    expect(screen.getByText(/Devices could not be drawn/u)).toBeTruthy()
    expect(container.querySelectorAll('section').length).toBeGreaterThan(0)
    spy.mockRestore()
  })
})

/**
 * AN ON-OR-OFF ROW SAYS WHICH IT IS, TO EVERYONE. It was a plain button whose
 * text changed between "On" and "Off", so assistive technology heard a
 * different button each time and no state at all (#140).
 */
describe('an on-or-off row', () => {
  it('is a switch that reports its state under a name that does not change', () => {
    const { props } = full({ themeFollowsOs: true })
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(screen.getByRole('switch', { name: 'Follow system appearance' }).getAttribute('aria-checked')).toBe('true')
    cleanup()

    const { props: off } = full({ themeFollowsOs: false })
    render(<Settings {...(off as ComponentProps<typeof Settings>)} />)
    expect(screen.getByRole('switch', { name: 'Follow system appearance' }).getAttribute('aria-checked')).toBe('false')
  })

  /* PRESSED, IT ASKS FOR THE STATE IT IS NOT IN — and says which it is in, as
     On or Off, for the readers who read it there. */
  it('writes the opposite of its state, and shows On or Off', () => {
    for (const on of [false, true]) {
      const { props, spy } = full({ themeFollowsOs: on })
      render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
      const row = screen.getByRole('switch', { name: 'Follow system appearance' })
      expect(valueOf(row)).toBe(on ? 'On' : 'Off')
      fireEvent.click(row)
      expect(spy.onFollowOs.mock.calls).toEqual([[!on]])
      cleanup()
    }
  })

  /* THE LABEL TAKES THE ROW'S SPARE WIDTH, which is what puts the value at the
     row's end — in an on-or-off row and in a cycling one alike. */
  it('lets the label take the row’s spare width, as a cycling row does', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    for (const label of ['Follow system appearance', 'Alignment']) {
      expect(screen.getByText(label).style.flexGrow, label).toBe('1')
    }
  })
})

/**
 * A ROW THAT CYCLES says which state it is on, by name, and moves to the next,
 * wrapping from the last to the first. Alignment is the row with three states,
 * so it is the one where "the next" and "the first" differ.
 */
describe('a cycling row', () => {
  it('names the state it is on and writes the next one, wrapping at the end', () => {
    for (const [align, shows, next] of [
      ['justified', 'Justified', 'justified-no-hyphens'],
      ['justified-no-hyphens', 'Justified, no hyphens', 'ragged'],
      ['ragged', 'Ragged', 'justified'],
    ] as const) {
      const { props, spy } = full({ align })
      render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
      const row = rowControl('Alignment')
      expect(valueOf(row), `${align} is called`).toBe(shows)
      fireEvent.click(row)
      expect(spy.onAlign.mock.calls, `after ${align}`).toEqual([[next]])
      cleanup()
    }
  })
})

/**
 * ⚠️ **EVERY GROUP HEADING IS A TOGGLE, AND NO TEST EVER CLOSED ONE.** The tests
 * above open closed groups; a group open at rest whose heading did nothing, or
 * one whose closing emptied every OTHER group too, passed all of them.
 */
describe('opening and closing a group', () => {
  const expanded = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-expanded')

  it('opens Appearance, Text and Page at rest, and the four set-once groups closed', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(['Appearance', 'Text', 'Spacing', 'Paragraphs', 'Blocks', 'Figures', 'Page'].map(expanded)).toEqual([
      'true',
      'true',
      'false',
      'false',
      'false',
      'false',
      'true',
    ])
  })

  it('closes an open group and opens it again, leaving every other group as it was', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    for (const group of ['Appearance', 'Text', 'Page']) {
      const others = ['Appearance', 'Text', 'Page'].filter((one) => one !== group)
      fireEvent.click(screen.getByRole('button', { name: group }))
      expect(expanded(group), `${group} closes`).toBe('false')
      expect(others.map(expanded), `closing ${group} left the others open`).toEqual(['true', 'true'])
      fireEvent.click(screen.getByRole('button', { name: group }))
      expect(expanded(group), `${group} opens again`).toBe('true')
    }
  })
})

/**
 * THE PAGE ROWS AT THEIR DEFAULTS. A host may pass a row's setter without its
 * value, and the row must still say something true: paged flow, no ruler, no
 * scrollbar, the progress rule shown, the side pane on the right.
 */
describe('the Page rows, handed their setters and not their values', () => {
  const VALUES = ['pageLayout', 'rulerOn', 'scrollbarOn', 'progressLineOn', 'side']
  const withoutValues = (over: Record<string, unknown> = {}) => {
    const { props, spy } = full(over)
    for (const key of VALUES) delete (props as Record<string, unknown>)[key]
    return { props: props as ComponentProps<typeof Settings>, spy }
  }

  it('reads paged, with the progress rule shown and the side pane on the right', () => {
    const { props, spy } = withoutValues()
    render(<Settings {...props} />)
    expect(valueOf(rowControl('Flow'))).toBe('Paged')
    /* Paged, so the two rows that only scrolled flow has are not drawn. */
    expect(screen.queryByText('Reading ruler')).toBeNull()
    expect(screen.queryByText('Scrollbar')).toBeNull()
    const progress = screen.getByRole('switch', { name: 'Progress rule' })
    expect([progress.getAttribute('aria-checked'), valueOf(progress)]).toEqual(['true', 'Shown'])
    expect(valueOf(rowControl('Side pane position'))).toBe('Right')

    fireEvent.click(rowControl('Flow'))
    fireEvent.click(rowControl('Side pane position'))
    expect(spy.onPageLayout.mock.calls).toEqual([['scrolled']])
    expect(spy.onSide.mock.calls).toEqual([['left']])
  })

  it('reads the ruler off and the scrollbar hidden in scrolled flow', () => {
    const { props } = withoutValues()
    render(<Settings {...{ ...props, pageLayout: 'scrolled' as const }} />)
    const ruler = screen.getByRole('switch', { name: 'Reading ruler' })
    const scrollbar = screen.getByRole('switch', { name: 'Scrollbar' })
    expect([ruler.getAttribute('aria-checked'), valueOf(ruler)]).toEqual(['false', 'Off'])
    expect([scrollbar.getAttribute('aria-checked'), valueOf(scrollbar)]).toEqual(['false', 'Hidden'])
  })
})

/**
 * WHICH PAGE ROWS ARE DRAWN, one setter at a time — `a container with nothing
 * in it` proves any one of them draws the GROUP, and a group drawn for one row
 * could hold every row whether its setter came or not.
 */
describe('the Page group holds exactly the rows its host can act on', () => {
  const PAGE_ROWS = [
    ['onPageLayout', 'Flow'],
    ['onToggleRuler', 'Reading ruler'],
    ['onToggleScrollbar', 'Scrollbar'],
    ['onToggleProgressLine', 'Progress rule'],
    ['onSide', 'Side pane position'],
  ] as const

  /** The label of every row in the Page group's body, in order. */
  function pageRows(): (string | null | undefined)[] {
    const toggle = screen.getByRole('button', { name: 'Page' })
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    return [...(body?.querySelectorAll('button') ?? [])].map((row) => row.firstElementChild?.textContent)
  }

  it('draws every row, in order, for a host with every setter in scrolled flow', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(pageRows()).toEqual(PAGE_ROWS.map(([, label]) => label))
  })

  it('draws only the row whose setter came', () => {
    for (const [setter, label] of PAGE_ROWS) {
      const { props } = narrow()
      render(<Settings {...({ ...props, pageLayout: 'scrolled', [setter]: vi.fn() } as ComponentProps<typeof Settings>)} />)
      expect(pageRows(), `${setter} alone`).toEqual([label])
      cleanup()
    }
  })

  /* PAGED, THE RULER AND THE SCROLLBAR ARE NOT ROWS, whatever the host can do. */
  it('draws neither the ruler nor the scrollbar in paged flow, with their setters', () => {
    const { props } = narrow()
    const paged = {
      ...props,
      pageLayout: 'paginated',
      onToggleRuler: vi.fn(),
      onToggleScrollbar: vi.fn(),
      onToggleProgressLine: vi.fn(),
    }
    render(<Settings {...(paged as ComponentProps<typeof Settings>)} />)
    expect(pageRows()).toEqual(['Progress rule'])
  })
})

/**
 * ⚠️ **DEVELOPER OPTIONS, and the band that exists only while they are on.**
 * ⌘⌃⌥D is the only way in, so nothing here offers it; what IS here is which
 * unfinished panels are drawn, and whether diagnostics are being recorded.
 * `UNFINISHED_PANE_IDS` names the rows, so these are Companion and Cards.
 */
describe('developer options', () => {
  const developer = (over: Record<string, unknown> = {}) => ({ hidden: [], onSetHidden: vi.fn(), recording: false, ...over })
  const captions = (container: HTMLElement) => [...container.querySelectorAll('h3')].map((one) => one.textContent)
  const open = (group: string) => fireEvent.click(screen.getByRole('button', { name: group }))

  it('draw no Developer band while they are off', () => {
    const { props } = full()
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(captions(container)).toEqual(['Reading'])
    expect(screen.queryByRole('button', { name: 'Unfinished panels' })).toBeNull()
  })

  it('list each unfinished panel as shown or hidden, and a press asks for the other', () => {
    const onSetHidden = vi.fn()
    const { props } = full({ developer: developer({ hidden: ['cards'], onSetHidden }) })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(captions(container)).toEqual(['Reading', 'Developer'])
    open('Unfinished panels')

    expect(
      screen.getByText(
        'These panels are drawn but do not yet answer what they promise. They are hidden from every reader who has not turned developer options on.',
      ),
    ).not.toBeNull()
    const companion = screen.getByRole('switch', { name: 'Companion' })
    const cards = screen.getByRole('switch', { name: 'Cards' })
    expect([companion.getAttribute('aria-checked'), valueOf(companion)]).toEqual(['true', 'Shown'])
    expect([cards.getAttribute('aria-checked'), valueOf(cards)]).toEqual(['false', 'Hidden'])

    fireEvent.click(companion)
    fireEvent.click(cards)
    expect(onSetHidden.mock.calls).toEqual([
      ['companion', true],
      ['cards', false],
    ])
  })

  /* REPORTED, NOT OFFERED: recording is a file read at boot, so the panel says
     which it is and, when it is off, how to turn it on. */
  it('say whether diagnostics are being recorded, and how to record them when they are not', () => {
    const { props } = full({ developer: developer({ recording: true }) })
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    open('Diagnostics')
    expect(screen.getByText('Diagnostics are being recorded. The Developer panel shows the window.')).not.toBeNull()
    cleanup()

    const { props: off } = full({ developer: developer({ recording: false }) })
    render(<Settings {...(off as ComponentProps<typeof Settings>)} />)
    open('Diagnostics')
    expect(
      screen.getByText(
        'Diagnostics are not being recorded on this build. Create a file named diagnostics.on in the data directory and relaunch to turn them on.',
      ),
    ).not.toBeNull()
  })

  /* HIDING A PANEL INSIDE DEVELOPER OPTIONS HIDES ITS SETTINGS WITH IT — the
     same list, read the same way — and leaves `inference`'s two alone, because
     Look up ships on them. */
  it('hide an unfinished capability’s settings again when its panel is hidden', () => {
    const sections = [
      { id: 'companion:provider', title: 'Companion', render: () => null },
      { id: 'inference:models', title: 'Local models', render: () => null },
      { id: 'inference:endpoints', title: 'Cloud endpoints', render: () => null },
    ]
    const { props } = full({ sections, developer: developer({ hidden: ['companion'] }) })
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(screen.queryByRole('button', { name: 'Companion' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Local models' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Cloud endpoints' })).not.toBeNull()
  })
})

/**
 * A HEADING OVER NOTHING (#141). A host with none of the Page rows — a phone,
 * a browser — drew a "Page" group that opened onto nothing, and a browser,
 * which composes no capability, drew "The app" over nothing at all.
 */
describe('a container with nothing in it', () => {
  const page = () => screen.queryByRole('button', { name: 'Page' })
  const captions = (container: HTMLElement) => [...container.querySelectorAll('h3')].map((one) => one.textContent)

  it('draws no Page group for a host with none of its rows', () => {
    const { props } = narrow()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(page()).toBeNull()
  })

  /* THE RULER AND THE SCROLLBAR ARE ROWS ONLY IN SCROLLED FLOW, so a host with
     only those two, reading paged, has nothing to put under the heading. */
  it('draws none for a host whose only rows do not apply to paged flow', () => {
    const { props } = narrow()
    const paged = { ...props, pageLayout: 'paginated', onToggleRuler: vi.fn(), onToggleScrollbar: vi.fn() }
    render(<Settings {...(paged as ComponentProps<typeof Settings>)} />)
    expect(page()).toBeNull()
  })

  it('draws Page for a host with any one of its rows', () => {
    for (const one of [
      { onPageLayout: vi.fn() },
      { onToggleRuler: vi.fn() },
      { onToggleScrollbar: vi.fn() },
      { onToggleProgressLine: vi.fn() },
      { onSide: vi.fn() },
    ]) {
      const { props } = narrow()
      render(<Settings {...({ ...props, ...one } as ComponentProps<typeof Settings>)} />)
      expect(page(), `${Object.keys(one).join()} alone should draw Page`).not.toBeNull()
      cleanup()
    }
  })

  it('draws no "The app" band with no section to show and nothing missing', () => {
    const { props } = full({ sections: [] })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(captions(container)).toEqual(['Reading'])
  })

  /* NOR FOR SECTIONS THIS READER IS NOT OFFERED — Companion's, with developer
     options off, is filtered before the band is decided. */
  it('draws none when every section is one this reader is not offered', () => {
    const { props } = full({ sections: [{ id: 'companion:provider', title: 'Companion', render: () => null }] })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(captions(container)).toEqual(['Reading'])
  })

  it('draws the band for a capability that failed to start', () => {
    const { props } = full({ sections: [], missing: [{ id: 'peer' }] })
    const { container } = render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(captions(container)).toEqual(['Reading', 'The app'])
  })

  /* AND SAYS WHICH, AND WHAT IT COSTS — one line per capability that did not
     start, and none at all where every one did. */
  it('names each capability that failed to start, and none when nothing is missing', () => {
    const notice = /is not running/u
    const { props } = full({ sections: [], missing: [{ id: 'peer' }, { id: 'sync' }] })
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(screen.getAllByText(notice).map((one) => one.textContent)).toEqual([
      'peer is not running — its settings are unavailable until the app is restarted.',
      'sync is not running — its settings are unavailable until the app is restarted.',
    ])
    cleanup()

    const { props: running } = full({ sections: [{ id: 'peer:devices', title: 'Devices', render: () => null }] })
    render(<Settings {...(running as ComponentProps<typeof Settings>)} />)
    expect(screen.queryByText(notice)).toBeNull()
  })
})

/* THE STEPPER STEPS FROM THE SIZE IT SHOWS (#142). Handed an index off the
   scale, it showed the default size and measured its ends from the raw index —
   so Larger was dead and Smaller asked for a step that does not exist. */
describe('the text size, handed an index off its scale', () => {
  it('steps from the size it shows', () => {
    const { props, spy } = full({ stepIdx: 99 })
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    expect(screen.getByRole('button', { name: 'Larger text' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Smaller text' }))
    expect(spy.onStepIdx).toHaveBeenCalledWith(DEFAULT_STEP_IDX - 1)
  })
})

/**
 * A GROUP'S HEADING, as assistive technology meets it (#136, #137). Drawn by
 * `PaneGroup`, measured here because this is the panel that is made of them.
 *
 * `aria-controls` named a body a closed group did not render, so the
 * relationship pointed at nothing; and the toggle was a button in a `div`, so
 * heading navigation could not find a single group.
 */
describe('a group heading', () => {
  it('names a body that exists while the group is closed — hidden, and holding nothing', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    const toggle = screen.getByRole('button', { name: 'Spacing' })
    const body = () => document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body(), 'aria-controls named an element that is not there').not.toBeNull()
    expect(body()?.hidden).toBe(true)
    expect(body()?.childElementCount).toBe(0)

    fireEvent.click(toggle)
    expect(body()?.hidden).toBe(false)
    expect(body()?.childElementCount).toBeGreaterThan(0)
  })

  it('is a heading one level under its band, with the toggle inside it', () => {
    const { props } = full()
    render(<Settings {...(props as ComponentProps<typeof Settings>)} />)
    const heading = screen.getByRole('heading', { name: 'Spacing', level: 4 })
    expect(heading.querySelector('button[aria-expanded]')).not.toBeNull()
  })
})
