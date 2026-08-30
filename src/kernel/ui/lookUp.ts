/**
 * What the selection popup's dictionary button does.
 *
 * ONE BEHAVIOUR: it glosses the selection with Paper's own model. There is no
 * longer a system-dictionary hand-off, no mode, and no stored preference —
 * see `core/gloss.ts` for why all three went at once.
 *
 * ⚠️ **THE FILE USED TO BE ABOUT Dictionary.app**, and most of what it said no
 * longer applies. It argued at length that handing off was more honest than
 * drawing a panel, because `DCSCopyTextDefinition` returns a doubled headword,
 * an unstructured body assembled from whichever dictionaries the reader has
 * enabled, and **nothing at all for a multi-word selection**. That reasoning
 * was sound and it is now somebody else's problem: macOS puts Look Up on the
 * right-click menu of any selection, so a reader who wants Apple's dictionary
 * has it without Paper carrying a second route to the same window.
 *
 * What is left here is the pure half — the two things that were never about
 * Dictionary.app. `lookUpTauri.ts`, which held the one `invoke`, is deleted;
 * this file stays on `check-browser-safe.mjs`'s pinned list, and with the
 * platform predicate gone it is now pure by construction rather than by
 * having had its one binding split out.
 */

/**
 * The longest term worth sending.
 *
 * A reader can select a whole chapter, and a chapter is not a term. It was the
 * point past which a `dict://` lookup found nothing; it is now the point past
 * which the reader has plainly not asked for a definition of a word. A
 * headword and a short phrase both fit comfortably.
 *
 * ⚠️ **IT USED TO BE MIRRORED IN RUST** (`lib.rs`'s `MAX_LOOKUP`) and no
 * longer is, because the command that held the mirror is deleted. One bound,
 * one place, and nothing left to drift against.
 *
 * MODULE-PRIVATE, and it was exported until an audit noticed why: the export
 * existed for `lookUpTauri.ts`, which imported it rather than restating it so
 * the two bounds could not disagree. That file is deleted. `termVerdict` is
 * now the only reader, and a constant nobody outside can name is a constant
 * nobody outside can drift from.
 */
const MAX_TERM = 120

/** What a Look up gesture should actually do. */
export type LookUpAction = 'gloss' | 'install' | 'none'

/**
 * What to do when the reader asks to look something up.
 *
 * Two inputs, and they are not the same question. `gloss` is whether a
 * definition can be produced right now; `installable` is whether a build that
 * cannot produce one has somewhere to send the reader to fix that. See
 * `GlossProvider.installable` for why the second exists at all — collapsing
 * them would either draw a dead button in a browser or silently remove the
 * feature from a desktop that has simply not downloaded a model yet.
 *
 * Kept here rather than in the reader so the rule has one home and a test.
 * `Reader.tsx` cannot be mounted cheaply — sixteen props, and it renders
 * foliate — so a rule left inside it can only be checked by reading its source
 * back, and a source scan cannot tell a working wiring from a plausible one.
 */
export function decideLookUp(gloss: boolean, installable: boolean): LookUpAction {
  if (gloss) return 'gloss'
  return installable ? 'install' : 'none'
}

/**
 * Whether a selection is a term worth looking up — and WHICH WAY it is not.
 *
 * ⚠️ **IT USED TO BE A BOOLEAN, AND THE FALSE BRANCH WAS SILENCE.** `lookUpPress`
 * read `isLookUpTerm` and `return`ed on false: the button was drawn, the press
 * was accepted, and nothing happened at all. That is the exact failure the
 * deleted `lookUpTauri.ts` warned about in its own header — *a lookup that
 * silently did nothing is the failure this path is easiest to get wrong in* —
 * and the one `useGloss`'s `unavailable` state was added to remove for the
 * other half of the same question. A reader who selected a paragraph got no
 * definition, no message, and no way to tell a refusal from a broken feature.
 *
 * A boolean could not be fixed in place, because the two false cases are not
 * one fact: an EMPTY selection has nothing to say about it, and an OVER-LONG
 * one has a sentence the reader can act on. Collapsing them is what made
 * silence the only answer either could get. So a closed set of three, and the
 * caller decides what each one means — `useGloss.ask` turns `too-long` into a
 * state the reader can read.
 *
 * ⚠️ **COUNTED IN CODE POINTS, AND IT USED TO BE CODE UNITS.** `String.length`
 * is UTF-16 units, so an emoji or a CJK extension character counts twice; the
 * Rust boundary this used to mirror counted scalars. The two disagreed for any
 * selection containing an astral character — a passage the native side would
 * happily accept, refused by the interface before it ever got there, with no
 * explanation available to a reader who had selected sixty perfectly
 * ordinary-looking characters.
 *
 * The Rust half is gone, so there is no second check to disagree with any
 * more. The counting stays as it is regardless: `Array.from` iterates by code
 * point, and a bound on a *term* that miscounts CJK is wrong on its own terms
 * in a codebase whose model was chosen for Chinese.
 */
export type TermVerdict = 'ok' | 'empty' | 'too-long'

export function termVerdict(term: string): TermVerdict {
  const trimmed = term.trim().replace(/\s+/g, ' ')
  if (trimmed === '') return 'empty'
  return Array.from(trimmed).length <= MAX_TERM ? 'ok' : 'too-long'
}

/**
 * The handler the selection popup's dictionary button gets, or `null` for no
 * button at all.
 *
 * ⚠️ **EXTRACTED SO IT CAN BE RUN RATHER THAN READ.** This was three lines
 * inside `Reader.tsx`, and an audit named the consequence: `Reader` takes
 * sixteen props and renders foliate, so nothing in it can be mounted cheaply,
 * and the only assertion anybody could write was `useGloss.test.ts` grepping
 * the file for the string `askGloss(gloss, selection`. A source scan cannot
 * tell a working wiring from a plausible-looking one — it would survive
 * `lookUpAction` being compared against a value it can never hold.
 *
 * ⚠️ **IT USED TO HOLD THE TERM BOUND TOO, AND THAT WAS THE BUG.** The handler
 * took a `term` thunk and `return`ed on a term `isLookUpTerm` refused — a press
 * that did nothing, said nothing and left nothing behind. The bound has not
 * moved because it was in the wrong file; it moved because **the answer to a
 * refused term is a state the reader can read**, and states live in
 * `useGloss`. Deciding there is what closed the silence; keeping a second copy
 * of the decision here is what would reopen it. See `termVerdict`.
 *
 * So ONE decision is left, and it is the one that genuinely belongs to the
 * button: whether a control is drawn at all.
 *
 * THE SELECTION IS NOT CONSUMED. A lookup is a question about the passage, not
 * something done to it — and the reader's next act is usually to mark the word
 * they have just understood, which a consumed selection would make them select
 * again.
 */
export function lookUpPress(action: LookUpAction, run: () => void): (() => void) | null {
  /* NOT a disabled button: a control that cannot act is the app describing a
   * feature it does not have — see `decideLookUp` for when that happens. */
  return action === 'none' ? null : run
}
