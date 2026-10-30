/**
 * What to do with a link that leaves the book.
 *
 * WHAT THIS EXISTS FOR, precisely. foliate resolves every link in the book and
 * then asks about it. For one whose scheme leaves the package it emits
 * `external-link`, and if nothing cancels the event it does this:
 *
 *     .then(x => x ? globalThis.open(href_, '_blank') : null)
 *
 * Nothing in Paper listened. So an EPUB — a zip a stranger wrote — chose a
 * string and the app's own window did whatever its webview does with it.
 *
 * AND "EXTERNAL" IS BROADER THAN THE WEB. The EPUB backend's test is
 * `uri => /^(?!blob)\w+:/i.test(uri)` (`epub.js:109`, and `class EPUB`'s
 * method delegates straight to it) — **any scheme but `blob:`**. So
 * `javascript:` and `data:` take that branch too, and reached the same line.
 *
 * The rule here is therefore an ALLOWLIST, not a blocklist. `http` and `https`
 * are what a footnote citing a source needs; everything else is refused by
 * name. A blocklist of the schemes somebody thought of is a list that is wrong
 * the moment a platform adds one.
 *
 * PURE, so the rule can be tested against real hrefs without a webview — and
 * so the same decision can be made again in Rust, where the command that
 * actually launches anything lives. Two checks rather than one is deliberate:
 * this one decides what the interface offers, and the other refuses to be
 * turned into a general "open any URL" command by a caller that skipped it.
 */

/** What the host should do with an external href. */
export type ExternalTarget =
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'refuse'; readonly why: string }

/**
 * The only two schemes a book may hand to the platform.
 *
 * `mailto:` is deliberately absent. It is defensible and it is not needed by
 * anything in the reading Paper is for, and every scheme on this list is one
 * more thing a book can make the operating system do.
 */
const ALLOWED = new Set(['http:', 'https:'])

/**
 * The longest URL worth passing on.
 *
 * Not a defensive round number: a `data:` payload is the shape that makes a
 * length limit matter, and those are refused by scheme above. This is the
 * backstop for a book that hands over a megabyte of query string, which no
 * launcher handles well and no reader typed.
 */
export const MAX_URL = 2048

export function externalTarget(href: string): ExternalTarget {
  const raw = href.trim()
  if (raw === '') return { kind: 'refuse', why: 'that link is empty' }
  if (raw.length > MAX_URL) return { kind: 'refuse', why: 'that link is too long to open' }
  /* CONTROL CHARACTERS FIRST, before parsing. A URL carrying a newline is a
     URL that can mean two things to whatever reads it next, and `new URL`
     strips some of them rather than refusing — so parsing first would launder
     the very thing worth catching. The deleted `look_up` refused them one
     layer down for the same reason; `open_external` still does. */
  if (/[\u0000-\u0020\u007f]/u.test(raw)) return { kind: 'refuse', why: 'that link is malformed' }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    /* A RELATIVE HREF NEVER REACHES HERE. foliate only emits `external-link`
       for something its own `isExternal` matched, which requires a scheme —
       so an unparseable one is a book with a broken link, not a page in it. */
    return { kind: 'refuse', why: 'that link is not a web address' }
  }
  if (!ALLOWED.has(parsed.protocol)) {
    /* NAMED, not "blocked". The scheme is the useful half of the sentence: a
       reader whose book carries a `mailto:` deserves to know that is why it
       did nothing, rather than being told the link is broken. */
    return { kind: 'refuse', why: `Paper only opens web links, and that one is ${parsed.protocol}//` }
  }
  /* THE LENGTH IS CHECKED AGAIN, ON THE NORMALISED STRING. `new URL` percent-
     encodes as it parses, so a href that is comfortably under the bound as
     written can come out of it well over — every raw space, quote or non-ASCII
     character becomes three bytes or more. Checking only `raw` above left the
     backstop measuring the wrong string, which is the same defect as handing
     on a value other than the one that was judged. */
  if (parsed.href.length > MAX_URL) return { kind: 'refuse', why: 'that link is too long to open' }
  /* `parsed.href`, not `raw` — normalised once, here, so the string the host
     hands on is the one this function actually judged. Handing on the raw text
     after validating a parse of it is how a check and its subject come apart. */
  return { kind: 'open', url: parsed.href }
}
