/**
 * A book's metadata, as the rest of the app stores it.
 *
 * ⚠️ **ITS OWN MODULE BECAUSE `parseBook.ts` READS BOOKS WITH NO READER OPEN.**
 * This lived at the foot of `session.ts`, so the enrichment pass imported the
 * whole reader session — foliate's footnote runtime, the wheel pager, word
 * snapping and every section watcher — to reach a function that touches none
 * of them. The import graph does not care that nobody calls the rest; nothing
 * here needs a view, a document or a window.
 */

import type { BookMeta } from '../../core/bookMeta'

/** foliate's metadata is loosely typed: title may be a language map, author a
 *  string, an object, or an array of either. */
export function readMeta(book: { metadata?: unknown }): BookMeta {
  const md = (book.metadata ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ')
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>
      const name = rec['name']
      if (typeof name === 'string') return name
      const first = Object.values(rec)[0]
      if (typeof first === 'string') return first
    }
    return ''
  }
  const belongsTo = (md['belongsTo'] ?? {}) as Record<string, unknown>
  const series = firstOf(belongsTo['series'])
  return {
    title: cap(text(md['title'])),
    author: cap(text(md['author'])),
    // Loosely typed like the rest: foliate resolves the OPF's unique-identifier
    // and hands back a string, but a malformed package can put anything here.
    identifier: cap(typeof md['identifier'] === 'string' ? md['identifier'] : ''),
    sortAs: cap(text(md['sortAs'])),
    series: cap(text(series?.['name'] ?? series)),
    /* A position, not an index into anything: EPUB allows `1.5` for a novella
     * between two books, so this is a float and NaN must not survive as one. */
    seriesIndex: finiteOrNull(series?.['position']),
    subjects: list(md['subject'], text),
    publisher: cap(text(md['publisher'])),
    /* Kept as the STRING the book declared, not parsed into a date. EPUB dates
     * are only loosely specified — `2011`, `2011-03`, and a full timestamp are
     * all legal — and `new Date('2011')` silently invents a January 1st in
     * whatever timezone the reader happens to be in. Sorting can compare these
     * lexically, which is correct for ISO-shaped values and no worse than a
     * fabricated day for the rest. */
    published: cap(text(md['published'])),
    languages: list(md['language'], text),
    description: cap(text(md['description']), MAX_LONG),
    subtitle: cap(text(md['subtitle'])),
    /* Set by `makePdf` and by nothing else, which is exactly the intent: a
       book either has pages or it does not, and only one format here does. */
    pageCount: pageCount(md['pageCount']),
  }
}

/**
 * A whole number of pages, or 0 for a book that has none.
 *
 * `Number.isInteger` is the whole type test: it refuses a non-number without
 * coercing, so `'12'` is not an integer to it. A `typeof` beside it was a
 * condition no input could make matter.
 */
function pageCount(value: unknown): number {
  return Number.isInteger(value) ? Math.max(value as number, 0) : 0
}

/**
 * Caps on metadata, because a book is a file a stranger wrote.
 *
 * Every field below travels straight from an untrusted OPF into a store that is
 * read whole, parsed whole and rewritten whole on every position save. Without
 * a bound, a book declaring a megabyte-long description or forty thousand
 * subjects would bloat that store permanently — and it would still be there
 * after the book was removed from the shelf, because the row outlives the open.
 *
 * The numbers are chosen to be past anything real rather than to be tight. A
 * genuine title is not 500 characters and a genuine book is not in 32
 * languages; the point is only that there IS a ceiling.
 */
const MAX_FIELD = 500
const MAX_LONG = 4000
const MAX_LIST = 32

/**
 * `value`, cut to at most `limit` UTF-16 units — never between the two halves
 * of one character.
 *
 * ⚠️ **A CUT BETWEEN A SURROGATE PAIR STORES HALF A CHARACTER.** `slice` counts
 * code units, and a character outside the Basic Multilingual Plane — an emoji,
 * a rare CJK ideograph, much of a historical script — is two of them. Cut
 * between them, the stored title ended in a lone high surrogate: shown as a
 * replacement box, and written to disk as U+FFFD by any UTF-8 encoder, so the
 * row no longer matched the book it was read from. One unit shorter keeps the
 * whole character out rather than half of it in.
 */
function cap(value: string, limit = MAX_FIELD): string {
  if (value.length <= limit) return value
  const last = value.charCodeAt(limit - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit)
}

/** foliate hands back an object, an array of them, or nothing. */
function firstOf(value: unknown): Record<string, unknown> | null {
  const one = Array.isArray(value) ? value[0] : value
  return one && typeof one === 'object' ? (one as Record<string, unknown>) : null
}

function finiteOrNull(value: unknown): number | null {
  /* `Number`, not `parseFloat`: the latter reads "1.5junk" as 1.5, and a
     series position with trailing junk is malformed metadata to refuse, not
     to half-read (audit round 1, #838). The empty string is `NaN`d explicitly
     because `Number('')` is 0. */
  const n = typeof value === 'string' ? (value.trim() === '' ? NaN : Number(value)) : value
  /* `Number.isFinite`, not the global: it refuses a non-number rather than
     coercing one, so it is the type test as well. */
  return Number.isFinite(n) ? (n as number) : null
}

/** A bounded list of non-empty strings, deduplicated, order preserved. */
function list(value: unknown, text: (v: unknown) => string): readonly string[] {
  /* Nothing declared is one entry that reads as nothing, and nothing is what
     reaches the list — no separate case for it. */
  const raw = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of raw) {
    const one = cap(text(item))
    // Deduplicated because an OPF may repeat a subject per language, and a tag
    // shown twice on a row looks like a bug in the reader rather than the book.
    if (one && !out.includes(one)) out.push(one)
    if (out.length >= MAX_LIST) break
  }
  return out
}
