import { describe, expect, it } from 'vitest'
import { deadContentSelectors, soleAttr, suppressEmptyGeneratedContent } from './generatedContent'

/**
 * NO jsdom HERE, AND THAT IS THE POINT.
 *
 * jsdom drops a bare `attr()` from a `content` declaration — it keeps
 * `"Note: " attr(data-note)` and discards `attr(data-note)` entirely, leaving
 * the rule with no content at all. A suite that parsed real CSS in jsdom would
 * therefore be handed nothing to decide about and pass by finding nothing,
 * which is the shape of a test that proves its subject was never run.
 *
 * The values below are the ones WebKit reports, read out of the running app
 * against *What's Our Problem?*:
 *
 *   { sel: ".footnote:hover::after", content: "attr(data-note)" }
 */
describe('soleAttr', () => {
  it('names the attribute when the content is only that attribute', () => {
    expect(soleAttr('attr(data-note)')).toBe('data-note')
  })

  it('ignores the whitespace a stylesheet may carry', () => {
    expect(soleAttr('  attr( data-note )  ')).toBe('data-note')
  })

  it('declines content that also has a literal in it', () => {
    /* THE DISTINCTION THE WHOLE THING TURNS ON. With a literal beside it the
       box still draws "Note: ", so it is not empty and the rule is not dead. */
    expect(soleAttr('"Note: " attr(data-note)')).toBeNull()
    expect(soleAttr('attr(data-note) " "')).toBeNull()
  })

  it('declines ordinary content', () => {
    expect(soleAttr('none')).toBeNull()
    expect(soleAttr('normal')).toBeNull()
    expect(soleAttr('"•"')).toBeNull()
    expect(soleAttr('')).toBeNull()
  })

  it('declines a name that would not make an attribute selector', () => {
    /* The name is interpolated into `[name]`, and `querySelector('[-x]')`
       throws — inside foliate's own event dispatch, where a throw reaches the
       app's error boundary. */
    expect(soleAttr('attr(-x)')).toBeNull()
    expect(soleAttr('attr(2note)')).toBeNull()
  })
})

describe('deadContentSelectors', () => {
  const bookRule = { selectorText: '.footnote:hover::after', content: 'attr(data-note)' }

  it('names a rule whose attribute is nowhere in the document', () => {
    expect(deadContentSelectors([bookRule], () => false)).toEqual(['.footnote:hover::after'])
  })

  it('leaves a rule alone when the document does carry the attribute', () => {
    /* Then the author meant something by it and some of the boxes have text.
       This only ever removes one that is guaranteed empty. */
    expect(deadContentSelectors([bookRule], () => true)).toEqual([])
  })

  it('asks about the attribute it found, not about some other one', () => {
    const asked: string[] = []
    deadContentSelectors([bookRule], (name) => {
      asked.push(name)
      return false
    })
    expect(asked).toEqual(['data-note'])
  })

  it('leaves generated content that is not an attribute alone', () => {
    const rules = [
      { selectorText: 'li::before', content: '"•"' },
      { selectorText: 'q::after', content: '"”"' },
      bookRule,
    ]
    expect(deadContentSelectors(rules, () => false)).toEqual(['.footnote:hover::after'])
  })

  it('skips a rule with no selector, which is how an at-rule arrives', () => {
    const rules = [{ selectorText: '', content: 'attr(data-note)' }]
    expect(deadContentSelectors(rules, () => false)).toEqual([])
  })
})

/**
 * The glue, driven through a stand-in document.
 *
 * A REAL DOCUMENT CANNOT TEST THIS — see the note at the top of the file. What
 * is checkable here is the wiring: that every sheet is read, that a sheet which
 * refuses to be read does not take the pass down with it, and that the rule
 * installed is one sheet rather than a new one on every re-render.
 */
describe('suppressEmptyGeneratedContent', () => {
  const fakeDoc = (
    sheets: { cssRules: unknown[] | (() => never) }[],
    /* MUTABLE, so a test can flip the document out from under a second call —
       which is the only way to reach the branch that takes the sheet back off. */
    present: string[] = [],
  ) => {
    const style = { id: '', textContent: '', remove: () => (removed = true) }
    let removed = false
    let appended = 0
    let installed: typeof style | null = null
    const doc = {
      styleSheets: sheets.map((s) => ({
        get cssRules() {
          if (typeof s.cssRules === 'function') return s.cssRules()
          return s.cssRules
        },
      })),
      querySelector: (selector: string) =>
        present.some((name) => selector === `[${name}]`) ? {} : null,
      getElementById: () => installed,
      createElement: () => style,
      head: {
        appendChild: (el: typeof style) => {
          appended += 1
          installed = el
        },
      },
    }
    return {
      doc: doc as unknown as Document,
      style,
      appends: () => appended,
      wasRemoved: () => removed,
    }
  }

  const rule = (selectorText: string, content: string) => ({
    selectorText,
    style: { getPropertyValue: (name: string) => (name === 'content' ? content : '') },
  })

  it('installs one rule per dead selector, marked !important', () => {
    const { doc, style, appends } = fakeDoc([
      { cssRules: [rule('.footnote:hover::after', 'attr(data-note)')] },
    ])
    suppressEmptyGeneratedContent(doc)
    expect(style.textContent).toBe('.footnote:hover::after{content:none!important}')
    expect(style.id).toBe('paper-dead-content')
    expect(appends()).toBe(1)
  })

  it('installs nothing when the book has nothing dead', () => {
    const { doc, appends } = fakeDoc([{ cssRules: [rule('li::before', '"•"')] }])
    suppressEmptyGeneratedContent(doc)
    expect(appends()).toBe(0)
  })

  it('reads on past a sheet it is not allowed to read', () => {
    /* A cross-origin sheet throws on `cssRules`. One of those must not hide
       every rule after it. */
    const { doc, style } = fakeDoc([
      {
        cssRules: () => {
          throw new Error('SecurityError')
        },
      },
      { cssRules: [rule('.footnote:hover::after', 'attr(data-note)')] },
    ])
    suppressEmptyGeneratedContent(doc)
    expect(style.textContent).toContain('.footnote:hover::after')
  })

  it('replaces its own sheet rather than stacking one per re-render', () => {
    /* A section re-renders on every settings change, and this runs each time. */
    const { doc, style, appends } = fakeDoc([
      { cssRules: [rule('.footnote:hover::after', 'attr(data-note)')] },
    ])
    suppressEmptyGeneratedContent(doc)
    suppressEmptyGeneratedContent(doc)
    suppressEmptyGeneratedContent(doc)
    expect(appends()).toBe(1)
    expect(style.textContent).toBe('.footnote:hover::after{content:none!important}')
  })

  it('takes its sheet back off when the document no longer needs it', () => {
    /* ONE DOCUMENT, CHANGED BETWEEN THE TWO CALLS. Written first as two
       separate fakes, which asserted that a sheet nobody had installed was not
       removed — green, and testing nothing. A section re-renders on every
       settings change, and a stale override left behind would go on hiding
       content the book means to show. */
    const present: string[] = []
    const { doc, wasRemoved } = fakeDoc(
      [{ cssRules: [rule('.footnote:hover::after', 'attr(data-note)')] }],
      present,
    )
    suppressEmptyGeneratedContent(doc)
    expect(wasRemoved()).toBe(false)

    present.push('data-note')
    suppressEmptyGeneratedContent(doc)
    expect(wasRemoved()).toBe(true)
  })
})
