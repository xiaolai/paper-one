// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from './Settings'
import { DEFAULT_ALIGN, DEFAULT_READING_STYLE, DEFAULT_SPACING, DEFAULT_STEP_IDX, DEFAULT_THEME } from '../../core/metrics'
import { offeredFaces } from '../../core/typefaces'

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

  it('captions each band with a real heading, so the split is structure and not a drawn line', () => {
    const { props } = full()
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

  /* NO CHEVRON ON A CAPTION. Every group heading in this pane carries one and
     every group heading opens something; a caption that looked the same but
     did nothing is the exact defect `PaneGroup` was built to end. */
  it('gives the band captions no disclosure, because they disclose nothing', () => {
    const { props } = full()
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
