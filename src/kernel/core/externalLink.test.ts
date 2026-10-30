import { describe, expect, it } from 'vitest'
import { MAX_URL, externalTarget } from './externalLink'

/**
 * The allowlist, and the cases it exists for.
 *
 * The first three of these are the item: `javascript:` and `data:` are
 * `isExternal` under `epub.js`'s own test — `/^(?!blob)\w+:/i`, any scheme but
 * `blob:` — and reached `globalThis.open` with no handler anywhere in Paper.
 */

describe('what a book may hand to the platform', () => {
  it('opens http and https, normalised', () => {
    expect(externalTarget('https://example.org/a')).toEqual({
      kind: 'open',
      url: 'https://example.org/a',
    })
    expect(externalTarget('http://example.org')).toEqual({
      kind: 'open',
      url: 'http://example.org/',
    })
  })

  it('refuses javascript:, which an EPUB could reach globalThis.open with', () => {
    const out = externalTarget('javascript:alert(1)')
    expect(out.kind).toBe('refuse')
    expect(out.kind === 'refuse' && out.why).toContain('javascript:')
  })

  it('refuses data:', () => {
    expect(externalTarget('data:text/html,<script>x</script>').kind).toBe('refuse')
  })

  it('refuses file:, which would hand the reader’s own disk to a book', () => {
    expect(externalTarget('file:///etc/passwd').kind).toBe('refuse')
  })

  it('refuses a scheme nobody thought of, because the rule is an allowlist', () => {
    /* A BLOCKLIST IS WRONG THE MOMENT A PLATFORM ADDS A SCHEME. This is the
       case that makes the direction of the rule matter. */
    expect(externalTarget('itms-apps://open').kind).toBe('refuse')
    expect(externalTarget('smb://host/share').kind).toBe('refuse')
    expect(externalTarget('mailto:someone@example.org').kind).toBe('refuse')
  })

  it('names the scheme it refused, rather than calling the link broken', () => {
    const out = externalTarget('ftp://example.org/x')
    expect(out.kind === 'refuse' && out.why).toBe(
      'Paper only opens web links, and that one is ftp://',
    )
  })

  it('refuses control characters INSIDE the url, which a parse would launder', () => {
    /* `new URL` strips some of these rather than refusing, so checking after
       parsing would sanitise away the exact thing worth catching. */
    expect(externalTarget('https://example.org/\nx').kind).toBe('refuse')
    expect(externalTarget('https://example.org/\tx').kind).toBe('refuse')
    expect(externalTarget('https://example.org/\u0000x').kind).toBe('refuse')
    expect(externalTarget('java\nscript:alert(1)').kind).toBe('refuse')
  })

  it('trims SURROUNDING whitespace rather than refusing it', () => {
    /* THIS CASE WAS BEING TESTED BY ACCIDENT, and passing for the wrong
       reason. The assertion here used to read as a trailing SPACE and expect a
       refusal — but the character in the source was a literal NUL, so it
       exercised the interior-control-character branch and said nothing at all
       about whitespace. `trim()` runs before the control check, so the refusal
       it appeared to prove never existed.

       Trimming is the right behaviour: nothing dangerous survives it, and the
       normalised `parsed.href` is what gets handed on. It has to be ASSERTED
       rather than assumed, which is the whole lesson of the NUL. */
    expect(externalTarget('https://example.org/ ').kind).toBe('open')
    expect(externalTarget(' \t https://example.org/ \n ').kind).toBe('open')
  })

  it('refuses the empty and the unparseable', () => {
    expect(externalTarget('').kind).toBe('refuse')
    expect(externalTarget('   ').kind).toBe('refuse')
    expect(externalTarget('not a url').kind).toBe('refuse')
  })

  it('refuses a URL longer than a reader ever typed', () => {
    expect(externalTarget(`https://example.org/${'a'.repeat(MAX_URL)}`).kind).toBe('refuse')
  })

  it('measures the length of the NORMALISED url, not the raw text', () => {
    /* `new URL` percent-encodes as it parses, so a href under the bound as
       written can come out of it well over — three bytes or more for every raw
       space or non-ASCII character. Checking only the raw string left the
       backstop measuring something other than what gets handed on. */
    const justUnder = 'e'.repeat(MAX_URL - 30)
    expect(externalTarget(`https://example.org/${justUnder}`).kind).toBe('open')
    /* Each of these is one character raw and three in the normalised href, so
       the raw string is well under the bound and the result is well over. */
    const expands = '\u00e9'.repeat(Math.floor(MAX_URL / 2))
    const raw = `https://example.org/${expands}`
    expect(raw.length).toBeLessThan(MAX_URL)
    expect(externalTarget(raw).kind).toBe('refuse')
  })

  it('is case-insensitive about the scheme, as URL parsing is', () => {
    expect(externalTarget('HTTPS://example.org/').kind).toBe('open')
    expect(externalTarget('JavaScript:alert(1)').kind).toBe('refuse')
  })

  it('hands on the string it judged, not the raw text', () => {
    /* Validating a parse and then passing the original is how a check and its
       subject come apart. */
    const out = externalTarget('  https://EXAMPLE.org/a?b=1  ')
    expect(out).toEqual({ kind: 'open', url: 'https://example.org/a?b=1' })
  })
})
