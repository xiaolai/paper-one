import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  AT_SHELF,
  MORE_BUTTONS,
  FRIEND_SHELF_STATE,
  IDENTITY,
  OPEN_FRIEND_SHELF,
  OPEN_MARGINALIA,
  PERSON_SWITCHES,
  READ_MARKS,
  SHARE_FIRST_UNSHARED,
  TO_CIRCLE,
  TO_SHELF,
  clickShare,
  filterShelf,
  flipSwitch,
  moreLabel,
  muteLabel,
  openMatch,
  parse,
  rowState,
  shelfLabel,
  shelfMatches,
  stateOfRow,
  withdrawRow,
} from './circle-scripts.mjs'

/**
 * The scripts the circle driver sends into the webview, checked for the one
 * thing that actually went wrong: whether they PARSE.
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
  /* ⚠️ **THE FOUR `String.replace` READS IN A REPLACEMENT, AND THEY WERE THE
     ONES MISSING.** This corpus had `${x}` — the bug already known — and none
     of these, so a real defect shipped green: the builders used a plain string
     replacement, and `$&`, `$$`, `` $` `` and `$'` each corrupted the quote or
     produced a script the page could not parse. Chosen for the mechanism now,
     not for the bug already found. */
  ['a dollar-ampersand, which String.replace expands to the match', 'cost $& dollars'],
  ['a double dollar, which collapses to one', 'cost $$ dollars'],
  ['a dollar-backtick, which splices in the source before', 'cost $` dollars'],
  ["a dollar-apostrophe, which splices in the source after", "cost $' dollars"],
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

describe('the value survives the builder exactly', () => {
  /* Parsing is not enough: a builder can emit a perfectly valid script that
     addresses the WRONG row. `$&` did exactly that. */
  it.each(QUOTES)('keeps %s intact through stateOfRow', (_what, quote) => {
    expect(stateOfRow(quote)).toContain(JSON.stringify(quote))
  })

  it.each(QUOTES)('keeps %s intact through withdrawRow', (_what, quote) => {
    expect(withdrawRow(quote)).toContain(JSON.stringify(quote))
  })
})

describe('every FIXED script compiles too', () => {
  /* ⚠️ **THE PARAMETERISED BUILDERS WERE THE ONLY THING CHECKED**, and the
     driver sends ten constants that take no argument at all — `IDENTITY`,
     `READ_MARKS`, `SHARE_FIRST_UNSHARED` and the rest. A syntax error in any of
     them bypassed the guard entirely and would surface as the bridge's
     `Script execution timeout`, which is the message that already cost three
     wrong diagnoses. */
  it.each([
    ['AT_SHELF', AT_SHELF],
    ['TO_SHELF', TO_SHELF],
    ['TO_CIRCLE', TO_CIRCLE],
    ['IDENTITY', IDENTITY],
    ['READ_MARKS', READ_MARKS],
    ['OPEN_MARGINALIA', OPEN_MARGINALIA],
    ['PERSON_SWITCHES', PERSON_SWITCHES],
    ['SHARE_FIRST_UNSHARED', SHARE_FIRST_UNSHARED],
    ['OPEN_FRIEND_SHELF', OPEN_FRIEND_SHELF],
    ['FRIEND_SHELF_STATE', FRIEND_SHELF_STATE],
  ])('%s parses', (_name, source) => {
    expect(parses(source)).toBe(true)
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

  it('truncates a long title into the label it compares against, because the shelf truncates it', () => {
    /* `More for <title>` is what the shelf renders, cut to 24 characters;
       comparing the whole title breaks on any book whose label is shortened. */
    const long = 'A Very Long Title That Goes On Well Past Any Reasonable Label Length'
    expect(moreLabel(long)).toBe('More for ' + long.slice(0, 24))
    expect(shelfMatches(long)).toContain(JSON.stringify(moreLabel(long)))
  })

  it('carries a title with a quote in it as DATA, not as part of the selector', () => {
    /* ⚠️ **THE TITLE IS NO LONGER IN THE SELECTOR AT ALL.** It used to be
       spliced into a CSS attribute value through `JSON.stringify`, and JSON
       escaping is not CSS escaping — `circle-scripts.dom.test.mjs` measures
       what that cost. What travels now is the fixed prefix every row shares,
       plus the label as a JavaScript string compared in the page. */
    const title = 'The "Best" Book'
    const source = shelfMatches(title)
    expect(parses(source)).toBe(true)
    expect(source).toContain(JSON.stringify(moreLabel(title)))
    expect(source).toContain(JSON.stringify(MORE_BUTTONS))
  })
})

describe('the per-person switches', () => {
  /* Both switches on a roster row are driven through ONE builder. They were two
     until WI-24.C3 needed the shelf one, and a second copy filtered differently
     is how the two come to disagree about which control they mean. */
  const NAMES = [
    ['a plain name', 'Ann'],
    ['a name with an apostrophe, which the label already contains one of', "O'Brien"],
    ['a curly apostrophe', 'O’Brien'],
    ['a double quote', 'The "Real" Ann'],
    ['a backslash', 'Ann\\Bob'],
    ['a dollar-brace', 'Ann ${x}'],
  ]

  it.each(NAMES)('builds a parseable mute flip for %s', (_what, name) => {
    for (const on of [true, false]) expect(parses(flipSwitch(muteLabel(name), on))).toBe(true)
  })

  it.each(NAMES)('builds a parseable shelf flip for %s', (_what, name) => {
    for (const on of [true, false]) expect(parses(flipSwitch(shelfLabel(name), on))).toBe(true)
  })

  it('names the two controls the way the UI does', () => {
    /* If these drift from `RosterSection.tsx`, the driver clicks nothing and
       reports "no switch labelled …" — which reads as a missing feature. */
    expect(muteLabel('Ann')).toBe("Hold back Ann's passages")
    expect(shelfLabel('Ann')).toBe('Show my shelf to Ann')
  })

  it('compares against the state it wants, so an already-correct switch is left alone', () => {
    expect(flipSwitch(muteLabel('Ann'), true)).toContain('box.checked === true')
    expect(flipSwitch(muteLabel('Ann'), false)).toContain('box.checked === false')
  })

  it('embeds a name as DATA, so a dollar-brace in it is inert', () => {
    /* ⚠️ **NOT THE SAME CHECK AS "no `${` anywhere", AND THE FIRST VERSION OF
       THIS TEST CONFLATED THEM.** The scripts above must carry no substitution
       in CODE position — that was the defect that emitted `${...}` verbatim and
       never parsed. A dollar-brace inside a QUOTED STRING is different: it is
       somebody's display name, it is inert, and forbidding it would forbid a
       legal name. What matters is that the name arrives as a string literal. */
    const name = 'Ann ${x}'
    const source = flipSwitch(shelfLabel(name), true)
    expect(parses(source)).toBe(true)
    expect(source).toContain(JSON.stringify(shelfLabel(name)))
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

  it('refuses an option with no value, and one whose value is the next option', () => {
    /* ⚠️ **BOTH USED TO GO THROUGH.** A trailing `--title` set nothing and the
       run went ahead against a book nobody named; `--title --person Ann` made
       the title the six characters `--person` and `Ann` a positional. Measured
       before the fix, both. */
    expect(() => parse(['share', '--title'])).toThrow(/--title needs a value/u)
    expect(() => parse(['share', '--person'])).toThrow(/--person needs a value/u)
    expect(() => parse(['share', '--quote'])).toThrow(/--quote needs a value/u)
    /* The port goes through the same refusal before its range is looked at, so
       a trailing `--port` names itself rather than reporting `NaN`. */
    expect(() => parse(['--port'])).toThrow(/--port needs a value/u)
    expect(() => parse(['--port', '--title', 'A Book'])).toThrow(/--port needs a value, and --title is another option/u)
    expect(() => parse(['share', '--title', '--person', 'Ann'])).toThrow(/--title needs a value, and --person is another option/u)
  })

  it('refuses a port that is not one', () => {
    /* ⚠️ `Number('abc')` is `NaN`, and it was taken: `connect` then built
       `ws://127.0.0.1:NaN`, whose refusal reads as "the bridge did not answer"
       and sends the reading to the app rather than to the command line. */
    for (const bad of ['abc', '-1', '0', '99999999', '31415.5']) {
      expect(() => parse(['--port', bad]), bad).toThrow(/--port needs a number between 1 and 65535/u)
    }
    expect(parse(['--port', '65535']).port).toBe(65535)
    expect(parse(['--port', '1']).port).toBe(1)
  })

  it('THROWS on a flag it does not know, naming it, and keeps bare words as words', () => {
    /* ⚠️ **NOTHING HAD EVER PASSED AN UNKNOWN FLAG.** The refusal and its
       message were both uncovered, so `--persn` would have been collected as a
       positional argument and the run would have gone ahead against the wrong
       person — or the message could have been empty. It throws rather than
       exiting because a pure parser reports and the process entry decides what
       a report costs. */
    expect(() => parse(['share', '--persn', 'Ann'])).toThrow(/^unknown option: --persn$/u)
    expect(parse(['share', 'and', 'another'])._).toEqual(['share', 'and', 'another'])
    /* A lone dash is a word, not a flag: only `--` starts one. */
    expect(parse(['-x'])._).toEqual(['-x'])
  })
})
