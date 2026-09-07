import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { clickShare, filterShelf, moreSelector, openMatch, parse, rowState, shelfMatches, stateOfRow, withdrawRow } from './circle-drive.mjs'

/**
 * The scripts this driver sends into the webview, checked for the one thing
 * that actually went wrong: whether they PARSE.
 *
 * ⚠️ **THIS IS THE TEST THAT WOULD HAVE SAVED THE MOST TIME AND WAS WRITTEN
 * LAST.** Two separate escaping mistakes shipped into these builders on
 * 2026-09-07 — a nested template literal whose `${...}` was emitted verbatim,
 * and a `\\"` that ended a string early. Both produced a SyntaxError in the
 * page, and the bridge reports a script that never parsed as
 * `Script execution timeout`. That message sent the investigation to three
 * different wrong causes: a shelf too heavy to iterate, `innerText` forcing
 * layout, and a plugin losing deferred replies. None was real.
 *
 * Compiling the source is the whole guard. It needs no DOM and no app, and it
 * fails on exactly the class that cost the afternoon. A builder that emits a
 * syntax error cannot reach the bridge again.
 */

const QUOTES = [
  ['a plain passage', 'the quick brown fox'],
  ['curly quotes, which the app produces', 'children attended St. John’s, Houston’s most'],
  ['a double quote, which ends an attribute selector', 'he said "no" and left'],
  ['a backslash', 'C:\\Users\\nobody'],
  ['a newline, which real marks contain', 'ELIZABETH WAS ACCEPTED\n\n to Stanford'],
  ['a backtick, which would end a template literal', 'the `export` keyword'],
  ['a dollar-brace, which is the exact bug this file exists for', 'cost ${JSON.stringify(evil)} dollars'],
  ['a script-closing sequence', 'end </script> here'],
]

/**
 * Compiles the source without running it — the only assertion that matters.
 *
 * ⚠️ **`vm.Script`, NOT `new Function`.** Both compile without executing, but
 * `new Function` BUILDS A CALLABLE from concatenated text, and a reader (or a
 * later edit) has to reason about whether anything ever calls it. `vm.Script`
 * can only be compiled; running it needs an explicit `runInContext` and a
 * context to run in, neither of which exists here. The intent is "does this
 * parse", and this is the tool that says only that.
 */
const parses = (source) => {
  new Script(source, { filename: 'generated.js' })
  return true
}

describe('every script the driver sends is syntactically valid JavaScript', () => {
  it.each(QUOTES)('builds a row-state script around %s', (_what, quote) => {
    expect(parses(stateOfRow(quote))).toBe(true)
  })

  it.each(QUOTES)('builds a withdraw script around %s', (_what, quote) => {
    expect(parses(withdrawRow(quote))).toBe(true)
  })

  it.each(QUOTES)('builds shelf scripts around %s', (_what, title) => {
    expect(parses(shelfMatches(title))).toBe(true)
    expect(parses(openMatch(title))).toBe(true)
    expect(parses(filterShelf(title))).toBe(true)
  })

  it.each([0, 1, 7])('builds a click script for row %i', (index) => {
    expect(parses(clickShare(index))).toBe(true)
    expect(parses(rowState(index))).toBe(true)
  })
})

describe('and no script carries an unevaluated substitution', () => {
  /* ⚠️ **THE FIRST BUG PARSED IN ONE CONTEXT AND NOT THE OTHER.** A literal
     `${...}` inside a string is legal JavaScript, so the compiler accepts it;
     it only breaks when the page evaluates it bare. Checking for the marker as
     well as for parseability is what makes this pair complete. */
  const every = [
    stateOfRow('x'),
    withdrawRow('x'),
    shelfMatches('Some Book'),
    openMatch('Some Book'),
    filterShelf('Some Book'),
    clickShare(0),
    rowState(0),
  ]

  it.each(every.map((s, i) => [i, s]))('script %i has no `${` left in it', (_i, source) => {
    expect(source).not.toContain('${')
  })

  it.each(every.map((s, i) => [i, s]))('script %i has no placeholder left in it', (_i, source) => {
    expect(source).not.toContain('__WANT__')
  })
})

describe('the values actually reach the script', () => {
  /* A builder that parsed and dropped its argument would satisfy everything
     above while addressing the wrong row for ever. */
  it('puts the quote in the row-state script, escaped', () => {
    expect(stateOfRow('he said "no"')).toContain(JSON.stringify('he said "no"'))
  })

  it('puts the quote in the withdraw script, escaped', () => {
    expect(withdrawRow('a ’curly’ one')).toContain(JSON.stringify('a ’curly’ one'))
  })

  it('puts the row index in the click script', () => {
    expect(clickShare(4)).toContain('][4]')
  })

  it('truncates a long title into the selector, because the label is a prefix match', () => {
    /* `More for <title>` is what the shelf renders; matching the whole title
       breaks on any book whose label the shelf itself shortens. */
    const long = 'A Very Long Title That Goes On Well Past Any Reasonable Label Length'
    expect(moreSelector(long)).toBe('button[aria-label^=' + JSON.stringify('More for ' + long.slice(0, 24)) + ']')
  })

  it('quotes a title containing a double quote so the selector stays one attribute', () => {
    /* The selector is encoded TWICE — once into an attribute value, once into
       the JS string that carries it — so asserting a hand-written escape
       sequence here just re-implements the nesting and gets it wrong, which is
       what the first version of this assertion did. Compare against the
       builder's own output instead. */
    const title = 'The "Best" Book'
    const source = shelfMatches(title)
    expect(parses(source)).toBe(true)
    expect(source).toContain(JSON.stringify(moreSelector(title)))
  })
})

describe('argument parsing', () => {
  it('reads the flags it documents', () => {
    const args = parse(['share', '--title', 'A Book', '--person', 'Ann', '--quote', 'a passage', '--port', '9999'])
    expect(args).toMatchObject({ _: ['share'], title: 'A Book', person: 'Ann', quote: 'a passage', port: 9999 })
  })

  it('defaults to the pinned bridge port', () => {
    expect(parse(['identity']).port).toBe(31415)
  })
})
