import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  ASK_FIRST_UNPUBLISHED,
  CONFIRM_OPEN_DISCLOSURE,
  MY_SHARE_ID,
  OPEN_DISCLOSURE_STATE,
  OPEN_PUBLISH_PANE,
  PANE_STATE,
  READ_PUBLISH_ROWS,
  askWho,
  clickPaneButton,
  parseArgs,
} from './public-scripts.mjs'

/**
 * The scripts the public driver sends into the webview, checked for the one
 * thing that actually goes wrong: whether they PARSE.
 *
 * ⚠️ **WRITTEN WITH THE FIRST SCRIPT, NOT AFTER THE FIRST LOST EVENING.** The
 * circle's equivalent was written last, and its own header records what that
 * cost: two escaping mistakes, both reported by the bridge as
 * `Script execution timeout`, and three confident wrong causes drawn from that
 * one message — a shelf too heavy to iterate, `innerText` forcing layout, and
 * a plugin losing deferred replies. None was real; the scripts had simply
 * never parsed. This file exists so that lesson is paid for once.
 *
 * ⚠️ **`new Script()` IS A PARSE AND NOT A RUN.** Nothing here touches a DOM
 * or a bridge. That is the whole point: a parse error is the failure this
 * catches, and it is the failure that hides behind a timeout.
 */

/* ⚠️ **EVERY SNIPPET, AND FOUR WERE MISSING.** `MY_SHARE_ID`, `askWho`,
   `CONFIRM_OPEN_DISCLOSURE` and `OPEN_DISCLOSURE_STATE` were added after this
   suite was written and nobody added them here — leaving the file's whole
   purpose unmet for exactly the snippets most recently edited, which are the
   ones most likely to carry a fresh escaping mistake. Found by an independent
   audit, 2026-09-11. */
const BUILT = {
  OPEN_PUBLISH_PANE,
  PANE_STATE,
  READ_PUBLISH_ROWS,
  ASK_FIRST_UNPUBLISHED,
  CONFIRM_OPEN_DISCLOSURE,
  OPEN_DISCLOSURE_STATE,
  MY_SHARE_ID,
}

describe('every script parses', () => {
  for (const [name, source] of Object.entries(BUILT)) {
    it(name, () => {
      expect(() => new Script(source)).not.toThrow()
    })
  }

  /**
   * The builders, against the inputs that break naive escaping.
   *
   * ⚠️ **A LABEL IS INTERPOLATED, SO A LABEL IS AN INJECTION SITE.** The pane's
   * own labels are plain, but a builder that is only ever tested with plain
   * input is a builder whose escaping is untested. `asJs` is `JSON.stringify`,
   * which is correct for a JavaScript string literal — these cases prove it is
   * actually being used rather than assumed.
   */
  const HOSTILE = [
    'Offer to anyone',
    'a label with "double quotes"',
    "a label with 'single quotes'",
    'a label with a \\ backslash',
    'a label with a \n newline',
    'a label with a ` backtick and ${notInterpolated}',
    'Other people’s notes',
  ]
  for (const label of HOSTILE) {
    it(`clickPaneButton(${JSON.stringify(label)})`, () => {
      expect(() => new Script(clickPaneButton(label))).not.toThrow()
    })
    it(`askWho(${JSON.stringify(label)})`, () => {
      /* The other builder that interpolates caller input. It types into a
         React-controlled field, so a snippet that does not parse fails as a
         bridge timeout rather than as an error. */
      expect(() => new Script(askWho(label))).not.toThrow()
    })
  }
})

describe('clickPaneButton', () => {
  it('carries the label through as a JavaScript string literal, not as raw text', () => {
    /* The evidence that `asJs` ran: the newline is the two characters `\` and
       `n` in the emitted source, never a real line break, which is what would
       end the string early. */
    const source = clickPaneButton('one\ntwo')
    expect(source).toContain('"one\\ntwo"')
    expect(source.split('\n').some((line) => line.includes('one') && line.includes('two'))).toBe(true)
  })

  it('refuses a disabled button by name rather than clicking it', () => {
    /* `Publish to anyone` is disabled until the disclosure has loaded, and a
       click on a disabled button does nothing — which would report success and
       leave the scenario waiting on a publication nobody made. */
    expect(clickPaneButton('Publish to anyone')).toContain('b.disabled')
  })
})

describe('parseArgs', () => {
  it('takes a subcommand and its flags', () => {
    expect(parseArgs(['pane', '--port', '31416', '--title', 'Moby-Dick'])).toEqual({
      command: 'pane',
      port: 31416,
      title: 'Moby-Dick',
      label: undefined,
    })
  })

  it('refuses no subcommand', () => {
    expect(parseArgs([]).error).toMatch(/subcommand is required/u)
  })

  it('refuses a port that is not a number', () => {
    expect(parseArgs(['pane', '--port', 'soon']).error).toMatch(/--port needs a number/u)
  })

  it('refuses an unknown flag by name', () => {
    expect(parseArgs(['pane', '--prot', '1']).error).toMatch(/unknown argument "--prot"/u)
  })

  it('refuses a flag whose value is the next flag', () => {
    /* `--title --port 3` would otherwise take "--port" as the title and then
       treat "3" as a flag, which reports the wrong error for the real mistake. */
    expect(parseArgs(['pane', '--title', '--port']).error).toMatch(/--title needs a value/u)
  })
})
