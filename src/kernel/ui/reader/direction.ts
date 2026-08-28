/**
 * Which way a section's text runs.
 *
 * One module, two importers — the session and speech. It sat in `session.ts`
 * and speech carried a copy rather than import the session's whole graph into
 * a suite that runs without a DOM; two copies of one rule is how the reader
 * and the follow-along come to disagree about which way "forward" is, so the
 * rule moved here instead (audit round 1, #842).
 *
 * THE BODY IS CONSULTED, not only the root. `dir` does not propagate upward:
 * a book that declares `<body dir="rtl">` — common in EPUBs converted from
 * older toolchains — leaves `html`'s computed direction at `ltr`, so reading
 * the root's computed value alone answered `ltr` for every such book and the
 * arrows ran backwards (audit round 1, #499). The computed value still wins
 * over the attribute on the SAME element — an author's stylesheet counts —
 * and the attributes are only believed where there is no view to compute
 * against, which is what a section that failed to parse hands back.
 */
export function directionOf(doc: Document): 'ltr' | 'rtl' {
  const html = doc.documentElement as HTMLElement | null
  if (!html) return 'ltr'
  const body = doc.body as HTMLElement | null
  const view = doc.defaultView
  const computedOf = (el: HTMLElement | null): string | undefined =>
    el && view ? view.getComputedStyle(el).direction : undefined
  const rootComputed = computedOf(html)
  if (rootComputed === 'rtl') return 'rtl'
  const bodyComputed = computedOf(body)
  if (bodyComputed === 'rtl') return 'rtl'
  /* No computed answer at all — no view. Only then do the attributes speak. */
  if (!rootComputed && !bodyComputed) {
    const declared = html.getAttribute('dir') || body?.getAttribute('dir')
    if (declared === 'rtl') return 'rtl'
  }
  return 'ltr'
}
