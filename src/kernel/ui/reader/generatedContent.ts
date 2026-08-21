/**
 * An empty box a book draws from an attribute it does not have.
 *
 * *What's Our Problem?* ships this, and every footnote in it is affected:
 *
 * ```css
 * .footnote:hover::after {
 *   content: attr(data-note);
 *   position: absolute; left: 0; bottom: 100%;
 *   background-color: #f9f9f9; border: 1px solid #ccc; padding: 5px;
 * }
 * ```
 *
 * A hover tooltip, for a web page. **Nothing in the document carries
 * `data-note`** — measured, `[data-note]` matches zero elements — so `attr()`
 * resolves to the empty string and what the reader gets is the box on its own:
 * 13×13 of border and padding around nothing, hanging above the footnote,
 * inside the note popover and over the page alike.
 *
 * THE RULE IS: content that is nothing but an attribute the document does not
 * have. That is narrow on purpose. It is not "books may not draw tooltips" —
 * a tooltip that has something to say still works, and a reader who paid for
 * the book gets what its designer built. It is only the case where the box is
 * GUARANTEED empty, which no author intended and no reader can use.
 *
 * WHOLE-DOCUMENT, NOT PER ELEMENT. A book where SOME elements carry the
 * attribute keeps its rule, empty boxes and all, because there the author meant
 * something by it and the fix would be to add `:not([attr])` to a selector this
 * would have to take apart — `::after` split off a selector list, correctly,
 * for a case not yet seen in a real book. When one turns up, that is the change.
 */

/**
 * The one attribute a `content` value consists of, or null.
 *
 * EXACT, NOT "MENTIONS `attr(`". `content: "Note: " attr(data-note)` still
 * draws the literal, so the box is not empty and the rule is not dead — only a
 * value that is a single `attr()` and nothing else can resolve to nothing.
 *
 * The name is checked rather than trusted: it is interpolated into an attribute
 * selector by the caller, and `querySelector('[-x]')` throws.
 */
export function soleAttr(content: string): string | null {
  const match = /^attr\(\s*([A-Za-z][-\w]*)\s*\)$/.exec(content.trim())
  return match?.[1] ?? null
}

/** As much of a CSS rule as the decision needs. */
export interface ContentRule {
  readonly selectorText: string
  readonly content: string
}

/**
 * Which selectors draw a box that can only ever be empty.
 *
 * PURE, AND THAT IS DELIBERATE. jsdom DROPS a bare `attr()` from a `content`
 * declaration — it keeps `"Note: " attr(data-note)` and discards
 * `attr(data-note)` — so a test that fed this a real stylesheet in jsdom would
 * be handed a rule with no content at all and pass by finding nothing. The
 * decision is separated from the CSSOM so it can be tested against the values
 * WebKit actually reports, which were read out of the running app.
 */
export function deadContentSelectors(
  rules: Iterable<ContentRule>,
  hasAttribute: (name: string) => boolean,
): string[] {
  const dead: string[] = []
  for (const rule of rules) {
    if (!rule.selectorText) continue
    const attr = soleAttr(rule.content)
    if (attr !== null && !hasAttribute(attr)) dead.push(rule.selectorText)
  }
  return dead
}

/** Marks the sheet this installs, so re-running on a document replaces it. */
const STYLE_ID = 'paper-dead-content'

/** Every style rule in a document, skipping sheets it may not read. */
function* contentRules(doc: Document): Generator<ContentRule> {
  for (const sheet of doc.styleSheets) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      /* A cross-origin sheet throws on access. Nothing to decide about it. */
      continue
    }
    for (const rule of rules) {
      const style = (rule as CSSStyleRule).style as CSSStyleDeclaration | undefined
      const content = style?.getPropertyValue('content')
      if (content) yield { selectorText: (rule as CSSStyleRule).selectorText, content }
    }
  }
}

/**
 * Stop a document drawing generated content that resolves to nothing.
 *
 * `!important` rather than trusting the cascade. This installs a sheet at the
 * end of `head`, which would win on order alone today — but `bookCss` is
 * re-applied whenever the reader changes a setting, and a fix that depends on
 * nothing ever being appended after it is a fix with a date on it.
 */
export function suppressEmptyGeneratedContent(doc: Document): void {
  const dead = deadContentSelectors(contentRules(doc), (name) => {
    try {
      return doc.querySelector(`[${name}]`) !== null
    } catch {
      /* An attribute name that will not make a selector. Leave the rule be —
         this only ever removes something it is certain is empty. */
      return true
    }
  })
  const existing = doc.getElementById(STYLE_ID)
  if (dead.length === 0) {
    existing?.remove()
    return
  }
  const style = existing ?? doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = dead.map((selector) => `${selector}{content:none!important}`).join('\n')
  if (!existing) doc.head.appendChild(style)
}
