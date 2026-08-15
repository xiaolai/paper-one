import { describe, expect, it } from 'vitest'
import { buildFixture, elem, txt } from './domFake.testkit'

/**
 * The fake's own contract.
 *
 * Every other case in this directory that touches the DOM runs against
 * `domFake.testkit.ts`. If the fake stopped keying its answers — if
 * `getComputedStyle` ignored its argument, if `isConnected` became a flag on
 * the container, if two text nodes could hold the same string — those cases
 * would stay green while asserting nothing at all. That is not a hypothetical:
 * it is what `markGeometry.test.ts:53` documents happening one layer down.
 *
 * So the fake is tested. Nothing else can detect this failure, because the
 * failure looks exactly like success everywhere it matters.
 *
 * **Live-lane partner: the `live` lane** (`scripts/word-snap-live.mjs`). These
 * cases prove the fake behaves as specified; they cannot prove the
 * specification matches WebKit. `block-merge` and `br-merge` measure the two
 * sentinel sources in a real document with real computed styles; inherited
 * visibility and `display: contents` are still modelled here and nowhere
 * measured. The lane is manual-only — **check whether it has been run.**
 */

/** `getComputedStyle`, as an implementation must reach it: through the
 *  document's own view, never through a global that this lane does not have. */
function styleOf(root: Element, target: Element): { display: string; visibility: string; position: string } {
  const view = root.ownerDocument.defaultView
  if (!view) throw new Error('fixture has no defaultView')
  return view.getComputedStyle(target) as unknown as {
    display: string
    visibility: string
    position: string
  }
}

describe('the WI-5 fixture fake', () => {
  it('answers getComputedStyle per element, so two same-tag elements can differ', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', { id: 'blocky', display: 'block' }, [txt('one')]),
        elem('span', { id: 'inliney' }, [txt('two')]),
      ]),
    )

    expect(styleOf(fixture.root, fixture.element('blocky')).display).toBe('block')
    expect(styleOf(fixture.root, fixture.element('inliney')).display).toBe('inline')
  })

  it('gives a `p` whatever display it was told, not what its tag implies', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('p', { id: 'declared-inline', display: 'inline' }, [txt('one')]),
        elem('p', { id: 'default' }, [txt('two')]),
      ]),
    )

    expect(styleOf(fixture.root, fixture.element('declared-inline')).display).toBe('inline')
    expect(styleOf(fixture.root, fixture.element('default')).display).toBe('block')
  })

  /*
   * The keying that makes the PDF text-layer case real. pdf.js emits every run
   * as `position: absolute`, and CSS Display 3 §2.7 blockifies an out-of-flow
   * box — so the computed display of those spans is `block`, not the `inline`
   * the markup suggests. Without this, that case would silently be the
   * ordinary inline case and would prove nothing about PDFs.
   */
  it('blockifies an out-of-flow element, as CSS does', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', { id: 'absolute', position: 'absolute' }, [txt('Hello ')]),
        elem('span', { id: 'static' }, [txt('world')]),
      ]),
    )

    expect(styleOf(fixture.root, fixture.element('absolute')).display).toBe('block')
    expect(styleOf(fixture.root, fixture.element('static')).display).toBe('inline')
  })

  it('inherits visibility, and lets an inner element take it back', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        elem('span', { id: 'outer', visibility: 'hidden' }, [
          txt('A'),
          elem('span', { id: 'inner', visibility: 'visible' }, [txt('B')]),
          elem('span', { id: 'unset' }, [txt('C')]),
        ]),
      ]),
    )

    expect(styleOf(fixture.root, fixture.element('outer')).visibility).toBe('hidden')
    expect(styleOf(fixture.root, fixture.element('inner')).visibility).toBe('visible')
    expect(styleOf(fixture.root, fixture.element('unset')).visibility).toBe('hidden')
  })

  it('refuses a fixture whose text nodes repeat, so a wrong walk always shows', () => {
    expect(() => buildFixture(elem('p', {}, [txt('x'), elem('em', {}, [txt('x')])]))).toThrow(
      /two text nodes hold/,
    )
  })

  it('gives distinct text nodes distinct identity and distinct content', () => {
    const fixture = buildFixture(elem('p', {}, [txt('wo'), elem('em', {}, [txt('r')]), txt('d here')]))

    expect(fixture.text('wo')).not.toBe(fixture.text('r'))
    expect((fixture.text('wo') as unknown as { data: string }).data).not.toBe(
      (fixture.text('r') as unknown as { data: string }).data,
    )
  })

  /*
   * The WI-11 trap, one layer down. A fake that flipped `isConnected` on the
   * container alone would let an implementation that checks the TEXT node —
   * the only check that is any use — pass without doing anything.
   */
  it('flips isConnected on former descendants, not only on the container', () => {
    const fixture = buildFixture(
      elem('div', { id: 'layer' }, [elem('span', {}, [txt('before the repaint')])]),
    )
    const captured = fixture.text('before the repaint')
    expect(captured.isConnected).toBe(true)

    fixture.replaceChildren('layer', [elem('span', {}, [txt('after the repaint')])])

    expect(captured.isConnected).toBe(false)
    expect(fixture.text('after the repaint').isConnected).toBe(true)
  })

  it('counts a visit for every node whose type a walk reads', () => {
    const fixture = buildFixture(elem('p', {}, [txt('one'), elem('em', {}, [txt('two')])]))
    expect(fixture.visits).toBe(0)

    const root = fixture.root as unknown as {
      firstChild: { nodeType: number; nextSibling: { nodeType: number } }
    }
    const first = root.firstChild.nodeType
    const second = root.firstChild.nextSibling.nodeType

    expect([first, second]).toEqual([3, 1])
    expect(fixture.visits).toBe(2)
  })
})
