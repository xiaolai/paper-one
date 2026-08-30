/**
 * Putting something on the clipboard, and saying which way it went.
 *
 * ⚠️ **ONE PATH, AND THERE WERE TWO.** `Reader.copyText` handled the whole
 * problem carefully — clipboard absent, clipboard refused, both reported to the
 * reader — and the Developer panel's copy was written later as
 * `void navigator.clipboard?.writeText(jsonl)`: no report on refusal, an
 * unhandled rejection reaching the global fatal handler, and a silent no-op on
 * a host with no clipboard at all. Two spellings of one operation, and the
 * second had lost every lesson the first was written for.
 *
 * A RESULT RATHER THAN A NOTICE. The three outcomes are the same everywhere;
 * what to SAY about them is not — the reader gets a sentence under the passage,
 * the Developer panel gets a word on the button — so this answers the question
 * and each caller decides how to put it. A helper that took a `setNotice` would
 * have been the reader's surface leaking into a diagnostics panel.
 *
 * NEVER REJECTS AND NEVER THROWS. It is called from click handlers with nobody
 * to catch, which is the property the previous `void`-with-no-`catch` version
 * only appeared to have.
 */

export type CopyOutcome =
  /** On the clipboard. */
  | 'copied'
  /** There is a clipboard and it said no — a permission, a non-secure context. */
  | 'refused'
  /** This host has none. A browser tab without one, an old webview. */
  | 'absent'

export async function writeClipboard(text: string): Promise<CopyOutcome> {
  const clipboard = navigator.clipboard
  if (!clipboard) return 'absent'
  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    /* SWALLOWED HERE AND REPORTED AS A VALUE, which is the point: a rejection
       from a click handler has nobody to catch it, and the caller is about to
       be told what happened in a form it can render. */
    return 'refused'
  }
}
