import { invoke } from '@tauri-apps/api/core'
import { inTauri } from './appStorage'
import { externalTarget } from '../core/externalLink'

/**
 * Handing a book's web link to the platform's own browser.
 *
 * THE SHAPE IS `lookUp.ts`'s, and deliberately: Paper already has a way of
 * saying "this belongs to the operating system, not to us" — a capability
 * predicate the interface consults before drawing anything, and a Rust command
 * that validates its own argument rather than trusting the webview.
 *
 * WHAT IT REPLACES. foliate hands any link whose scheme leaves the package to
 * `globalThis.open(href, '_blank')` unless the embedder cancels the event, and
 * nothing in Paper listened. An EPUB is a zip a stranger wrote, and
 * `epub.js`'s idea of "external" is any scheme but `blob:` — so
 * `javascript:` and `data:` went the same way. The event is cancelled now and
 * the href comes here.
 *
 * THE SCHEME IS CHECKED TWICE, on purpose. `externalTarget` decides what the
 * interface will offer and is pure, so the rule can be tested against real
 * hrefs; `open_external` refuses the same set in Rust, because a check that
 * only exists on the caller's side is not a boundary — and the webview is
 * where the untrusted string comes from.
 */

/** Whether this platform has a browser to hand a link to. */
export function canOpenExternal(): boolean {
  return inTauri()
}

/**
 * Open a link the book asked for, or say why not.
 *
 * Resolves with `null` when it was opened and a SENTENCE when it was refused —
 * the caller shows that sentence. A link that silently does nothing is the
 * failure this whole path exists to delete, and it is the one this is easiest
 * to reintroduce by swallowing the refusal.
 */
export async function openExternal(href: string): Promise<string | null> {
  const target = externalTarget(href)
  if (target.kind === 'refuse') return target.why
  if (!canOpenExternal()) return 'Links cannot be opened here.'
  try {
    await invoke('open_external', { url: target.url })
    return null
  } catch (cause) {
    console.error('Paper: could not open that link', cause)
    return 'That link could not be opened.'
  }
}
