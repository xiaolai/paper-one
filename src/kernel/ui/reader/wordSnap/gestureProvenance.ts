/**
 * Which selections a pointer gesture actually produced.
 *
 * Word snapping is for drags. A shift+arrow selection must stay exactly where
 * the reader put it — extending it to word boundaries would take the keyboard's
 * one useful property, character granularity, away from it. So the snap needs
 * to know where the current selection came from, and `pointerup` does not tell
 * it: a shift+arrow selection followed by a context-click fires a perfectly
 * ordinary `pointerup` over a selection the pointer had nothing to do with.
 *
 * The signal that separates them is a `selectionchange` observed **while a
 * pointer is down**. That is what a drag is; a click on an existing selection
 * produces no `selectionchange` at all.
 *
 * Three things this gets right that the obvious version does not:
 *
 * 1. **Release is four events, not one.** `pointerup`, `pointercancel`, window
 *    `blur` — the trio `bindSelectionFix` already needs (`makePdf.ts:71`),
 *    because a drag released outside the text layer or outside the window
 *    delivers no `pointerup` to this document — **and `keydown`**. The keydown
 *    is what makes the failure mode bounded: a `pointerdown` whose release is
 *    lost would otherwise leave the flag set, and the reader's next shift+arrow
 *    would be recorded as pointer-produced. The guarantee this file exists to
 *    provide is that the worst outcome is *does not snap*, never *snaps a
 *    keyboard selection*.
 *
 *    **"Does not snap" is not "does not publish", and the difference is not
 *    pedantry.** This file answers one question and it is not whether a gesture
 *    is reported: a `pointerup` publishes either way, snapped when the answer
 *    below is `true` and exactly as the reader made it when it is `false`. A
 *    consumer that read `false` as a reason to return early would take the
 *    selection toolbar away from every ordinary drag whose `selectionchange`
 *    happened to land late — which is a routine ordering, documented three
 *    paragraphs down — and the sentence above would then be false. It was, and
 *    `deferredSnap.ts` is where it was made true again.
 * 2. **Only `pointerup` completes.** `pointercancel` and `blur` release the
 *    pointer and drop the provenance with it: nothing finished, so there is
 *    nothing to snap. The accepted consequence is that a drag released outside
 *    the window does not snap, which is the harmless side of the guarantee.
 * 3. **Provenance is a token, not a boolean.** It records WHICH selection the
 *    pointer made — the anchor/focus quadruple — and `isPointerProduced()`
 *    compares it against the selection that is live at the moment it is asked.
 *    A boolean can only say that a pointer made *some* selection at *some*
 *    point, which is exactly wrong once WI-8 defers the snap by a macrotask:
 *    a selection replaced in between must cancel it, and no event needs to have
 *    fired for that to be true.
 *
 * The comparison is also why a `selectionchange` arriving with the pointer up
 * is left alone rather than clearing the token. WebKit fires `selectionchange`
 * asynchronously, so a drag's last one can land after `pointerup`; clearing on
 * it would silently kill the snap for every gesture where it did. Comparing
 * instead answers correctly either way — a trailing event that reports the same
 * selection changes nothing, and one that reports a different selection fails
 * the comparison.
 *
 * **The residual hole, stated rather than hidden.** A `selectionchange` that no
 * pointer caused, arriving while a pointer is genuinely down — a programmatic
 * selection from a search hit, say — is recorded as pointer-produced. It is
 * bounded to the same side of the guarantee: the wrong outcome is a
 * programmatic selection snapped to word boundaries, never a keyboard one.
 *
 * **Live-lane partner: none, and there cannot be one.** Every ordering claim
 * above is a claim about WebKit, and no lane can check one at any level: the
 * Tauri MCP bridge dispatches `isTrusted: false` events, which produce no native
 * selection and therefore no `selectionchange`. The `live` lane exists
 * (`scripts/word-snap-live.mjs`) and verifies the adapter, never the events.
 *
 * **This pairing is permanently unmet.** Real drags, double-click, long-press,
 * selection handles, touch, pen and force-touch are covered only by
 * The manual selection checklist §1, by a person on real hardware.
 */

export interface GestureProvenance {
  /** Whether the selection that is live RIGHT NOW is one a pointer gesture
   *  produced. Asked at the moment the answer is used, never cached. */
  isPointerProduced: () => boolean
  /** Remove every listener this added, on the document and on its window. */
  unbind: () => void
}

/** Which selection the pointer made — the four fields that identify one. */
interface SelectionToken {
  readonly anchorNode: Node
  readonly anchorOffset: number
  readonly focusNode: Node
  readonly focusOffset: number
}

export function watchGestureProvenance(doc: Document): GestureProvenance {
  /* Captured once. The window is where `blur` has to go — it does not reach a
   * document from a focus change — and it is also the only route to the
   * selection, so a document already detached from its view has neither. */
  const view = doc.defaultView

  let pointerDown = false
  let token: SelectionToken | null = null

  const tokenOf = (): SelectionToken | null => {
    const selection = view?.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null
    return {
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset,
    }
  }

  const onPointerDown = (): void => {
    pointerDown = true
  }

  /* The one place provenance is TAKEN. Only while a pointer is down, and only
   * from the selection as it stands — an event with the pointer up is left to
   * the comparison in `isPointerProduced`, for the reason in the header. */
  const onSelectionChange = (): void => {
    if (pointerDown) token = tokenOf()
  }

  /** The gesture completed. The pointer is up; what it produced stands. */
  const onPointerUp = (): void => {
    pointerDown = false
  }

  /** Nothing completed — a cancelled gesture, a lost window, a keystroke. */
  const abandon = (): void => {
    pointerDown = false
    token = null
  }

  doc.addEventListener('pointerdown', onPointerDown)
  doc.addEventListener('pointerup', onPointerUp)
  doc.addEventListener('pointercancel', abandon)
  doc.addEventListener('keydown', abandon)
  doc.addEventListener('selectionchange', onSelectionChange)
  view?.addEventListener('blur', abandon)

  return {
    isPointerProduced: () => {
      if (!token) return false
      const live = tokenOf()
      return (
        live !== null &&
        live.anchorNode === token.anchorNode &&
        live.anchorOffset === token.anchorOffset &&
        live.focusNode === token.focusNode &&
        live.focusOffset === token.focusOffset
      )
    },
    unbind: () => {
      doc.removeEventListener('pointerdown', onPointerDown)
      doc.removeEventListener('pointerup', onPointerUp)
      doc.removeEventListener('pointercancel', abandon)
      doc.removeEventListener('keydown', abandon)
      doc.removeEventListener('selectionchange', onSelectionChange)
      view?.removeEventListener('blur', abandon)
    },
  }
}
