import { DEFAULT_PORT } from './bridge.mjs'

/**
 * Every script `circle-drive.mjs` sends into the webview, and its argument
 * parsing — the pure half, split out so it can be measured.
 *
 * ⚠️ **SPLIT FOR THE REASON `main.tsx` AND `shutdown.ts` WERE.** The driver is a
 * PROCESS ENTRY: it reads `process.argv`, writes to a real stream, sets an exit
 * code and needs a live WebSocket to an app that is running. Nothing can call
 * it from a test, so it counts as zero and says nothing about the code that
 * matters. What matters is here, where a test reaches it without an app.
 *
 * ⚠️ **AND WHAT MATTERS MOST IS THAT THESE PARSE.** Two escaping mistakes
 * shipped into these builders on 2026-09-07 — a nested template literal whose
 * `${...}` was emitted verbatim, and a `\"` that ended a string early. The
 * bridge reports a script that never PARSED as `Script execution timeout`, and
 * that one message produced three confident wrong causes. `circle-scripts.test.mjs`
 * compiles every one of them.
 */

/**
 * ⚠️ **EVERY SNIPPET BELOW IS AN IIFE RETURNING JSON.** The bridge hands back
 * whatever the expression evaluates to; a bare arrow function comes back as
 * the source text of a function, which parses as neither an object nor an
 * error and reads downstream as "the app answered something odd".
 */

export const IDENTITY = `(async () => {
  const inv = window.__TAURI__?.core?.invoke
  if (!inv) return JSON.stringify({ ok: false, why: 'window.__TAURI__ is not exposed — withGlobalTauri is false, so this is not the dev config' })
  const mine = await inv('plugin:peer|peer_circle_mine')
  if (!mine) return JSON.stringify({ ok: false, why: 'this device has no person identity — it has never shared' })
  return JSON.stringify({
    ok: true,
    person: mine.person,
    device: mine.device,
    delegationKeys: Object.keys(mine.delegation).sort(),
    roster: mine.roster.length,
  })
})()`

/**
 * Open a book by title, from the Library.
 *
 * ⚠️ **THE SHELF IS VIRTUALISED, so the row must be FILTERED into existence
 * rather than searched for in the DOM.** 1 962 books render a few dozen cells;
 * a querySelector for a title that is not near the viewport finds nothing and
 * reads exactly like a book that is not in the library. The search field is
 * how the app itself narrows, so it is what this uses.
 *
 * ⚠️ **AND THE VALUE IS SET THROUGH THE NATIVE SETTER.** React tracks an
 * input's value on the DOM node; assigning `input.value` directly leaves
 * React's copy stale, so the `input` event fires and the component re-renders
 * with the OLD value. This is the standard React-controlled-input trap and it
 * fails silently — the field looks right on screen and the list never narrows.
 */
/**
 * Getting to a book, in THREE short round trips rather than one long one.
 *
 * ⚠️ **THE BRIDGE HAS ITS OWN SCRIPT TIMEOUT, AND IT IS SHORTER THAN THE
 * NAVIGATION.** A single snippet that clicked, waited 1.5 s, typed, waited
 * 1.2 s and clicked again came back as `Script execution timeout` — the
 * bridge's message, not this client's, so the 30 s here never applied. Waiting
 * inside the webview spends the bridge's budget; waiting in Node spends none of
 * it. Short scripts also fail where you can see it: each step below names the
 * thing it could not find.
 */
export const AT_SHELF = `(() => JSON.stringify({ shelf: !!document.querySelector('input[aria-label="Search the library"]') }))()`

/* Idempotent: on the shelf there is nothing to click. A second run of this
   script always starts with the previous run's book open, which made the FIRST
   run pass and every later one fail — the worst ordering for noticing. */
export const TO_SHELF = `(() => {
  const b = [...document.querySelectorAll('button,[role="button"]')].find((x) => (x.getAttribute('aria-label') || '').trim() === 'Library')
  if (!b) return JSON.stringify({ ok: false, why: 'no way back to the shelf from here' })
  b.click()
  return JSON.stringify({ ok: true })
})()`

/**
 * ⚠️ **THE SHELF IS VIRTUALISED, so the row must be FILTERED into existence.**
 * 1 962 books render a few dozen cells; a querySelector for a title that is not
 * near the viewport finds nothing and reads exactly like a book that is not in
 * the library.
 */
/**
 * ⚠️ **EVERY SNIPPET HERE IS INDEXED, NOT ITERATED, AND THAT IS NOT AN
 * OPTIMISATION.** The first versions did `[...document.querySelectorAll('div')]`
 * and filtered on a class substring, over a shelf of 1 962 books, then read
 * `innerText` — which forces layout. The bridge answered `Script execution
 * timeout` for all of them, including READ-ONLY ones, and the timeout is the
 * bridge's own and not this client's. A selector the engine can index answers
 * in milliseconds; `textContent` needs no layout.
 *
 * The title goes into the selector as a JSON string, which is already
 * double-quoted and escaped exactly the way an attribute selector wants.
 */
/**
 * ⚠️ **THESE ARE BUILT BY CONCATENATION, NOT BY NESTED TEMPLATE LITERALS.**
 * The first version returned a template literal from one helper and embedded
 * it in another with `${...}`. Interpolation does not re-evaluate its result,
 * so the page received the six characters `${...}` verbatim — a SyntaxError,
 * which the bridge reports as `Script execution timeout` rather than as an
 * error. Three wrong diagnoses came out of that one message: that the shelf
 * was too heavy to iterate, that innerText was forcing layout, and that the
 * plugin loses deferred replies. All three were false and the script had
 * simply never parsed.
 *
 * The title becomes a JSON string, which is already double-quoted and escaped
 * exactly the way an attribute selector wants it.
 */
export const moreSelector = (title) => 'button[aria-label^=' + JSON.stringify('More for ' + title.slice(0, 24)) + ']'

export const asJs = (value) => JSON.stringify(value)

/** How many shelf cells match, read-only — the narrow step's confirmation. */
export const shelfMatches = (title) =>
  '(() => JSON.stringify({ cells: document.querySelectorAll(' + asJs(moreSelector(title)) + ').length }))()'

/**
 * ⚠️ **THE SHELF IS VIRTUALISED, so the row must be FILTERED into existence.**
 * 1 962 books render a few dozen cells; a selector for a title that is not near
 * the viewport finds nothing and reads exactly like a book that is not in the
 * library.
 */
export const openMatch = (title) =>
  '(() => {\n' +
  '  const more = document.querySelector(' + asJs(moreSelector(title)) + ')\n' +
  "  if (!more) return JSON.stringify({ ok: false, why: 'no shelf row matched that title' })\n" +
  "  const cell = more.closest('[class*=\"cell\"]')\n" +
  "  if (!cell) return JSON.stringify({ ok: false, why: 'the matched row has no cell around it' })\n" +
  "  const opener = [...cell.querySelectorAll('button')].find((b) => !(b.getAttribute('aria-label') || '').startsWith('More for'))\n" +
  "  if (!opener) return JSON.stringify({ ok: false, why: 'the shelf row has no opener button' })\n" +
  '  opener.click()\n' +
  '  return JSON.stringify({ ok: true })\n' +
  '})()'

/**
 * ⚠️ **THE VALUE GOES THROUGH THE NATIVE SETTER.** React tracks an input's
 * value on the DOM node; assigning `input.value` leaves React's copy stale, so
 * the `input` event fires and the component re-renders with the OLD value. The
 * field looks right on screen and the list never narrows — a silent failure.
 */
export const filterShelf = (title) =>
  '(() => {\n' +
  "  const input = document.querySelector('input[aria-label=\"Search the library\"]')\n" +
  "  if (!input) return JSON.stringify({ ok: false, why: 'no library search field on screen' })\n" +
  "  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set\n" +
  '  setter.call(input, ' + asJs(title) + ')\n' +
  "  input.dispatchEvent(new Event('input', { bubbles: true }))\n" +
  '  return JSON.stringify({ ok: true })\n' +
  '})()'

export const controlAt = (index) => "[...document.querySelectorAll('[data-mark-control=\"circle:share\"]')][" + Number(index) + ']'

/**
 * Find the first unshared row of the OPEN book and click its Share, in ONE
 * round trip.
 *
 * ⚠️ **READING THE ROWS AND THEN CLICKING BY INDEX IS A RACE, AND IT LOST.**
 * Marginalia re-renders whenever the store changes — which a fetch round does,
 * on its own schedule — so an index read in one call can address a different
 * row in the next. The first run of `circle-scenario.sh` failed with *"that row
 * offers no Share button"*: the index was stale, not the button missing.
 * Deciding and acting in the same script cannot be raced by anything.
 *
 * Returns the row's text, which is what the caller polls on — a stable handle
 * where an index is not.
 */
export const SHARE_FIRST_UNSHARED = `(() => {
  const rows = [...document.querySelectorAll('[data-mark-control="circle:share"]')]
  for (const control of rows) {
    let row = control
    for (let k = 0; k < 6 && row.parentElement; k++) {
      row = row.parentElement
      if ((row.textContent || '').length > (control.textContent || '').length + 20) break
    }
    /* Only the OPEN book's rows: Marginalia is cross-book and labels the
       others with a placeBook element. Sharing somebody else's row publishes a
       passage from a book the far end was never asked about. */
    if (row.querySelector('[class*="placeBook"]')) continue
    const share = [...control.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Share')
    if (!share) continue
    /* ⚠️ **THE HANDLE IS THE MARK'S OWN QUOTE, NOT THE ROW'S TEXT.** The row's
       text CONTAINS the control, and the control is exactly what the click
       changes — 'Share / Share with note' becomes 'Shared with your circle /
       Withdraw'. Polling on the whole row therefore never matches again and
       reports the row as gone. Measured: 'the row left the screen mid-publish'
       on a row that had not moved at all. The quote does not change. */
    const jump = row.querySelector('[class*="noteJump"]')
    if (!jump) continue
    share.click()
    return JSON.stringify({ ok: true, quote: (jump.textContent || '').trim().slice(0, 120) })
  }
  return JSON.stringify({ ok: false, why: 'no unshared mark of the open book — withdraw one, or mark a fresh passage' })
})()`

/**
 * What the row carrying this quote says NOW — a handle the click cannot change.
 *
 * ⚠️ **A PLACEHOLDER, NOT NESTED ESCAPES.** Every parameterised script here was
 * first built by concatenating quoted fragments, and the escaping went wrong
 * twice in a row in opposite directions — once producing a literal `${...}` the
 * page could not parse, once ending a string early on `\\"`. A template with a
 * token swapped in has neither failure mode, and reads as the script it is.
 */
export const ROW_STATE = `(() => {
  for (const control of document.querySelectorAll('[data-mark-control="circle:share"]')) {
    let row = control
    for (let k = 0; k < 6 && row.parentElement; k++) {
      row = row.parentElement
      if ((row.textContent || '').length > (control.textContent || '').length + 20) break
    }
    const jump = row.querySelector('[class*="noteJump"]')
    if (!jump) continue
    if ((jump.textContent || '').trim().slice(0, 120) !== __WANT__) continue
    return JSON.stringify({
      ok: true,
      buttons: [...control.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
      text: (control.textContent || '').trim().slice(0, 200),
    })
  }
  return JSON.stringify({ ok: false, why: 'the row carrying that passage is no longer on screen' })
})()`

export const stateOfRow = (quote) => ROW_STATE.replace('__WANT__', JSON.stringify(quote))

/**
 * Withdraw the publication on the row carrying this quote.
 *
 * ⚠️ **WITHOUT THIS THE HARNESS IS NOT REPEATABLE, AND IT TOOK FOUR RUNS TO
 * NOTICE.** Each run consumes one unshared mark; the fourth reported *"no
 * unshared mark of the open book"* and looked like a defect in the app. A
 * harness that cannot be run twice is a harness nobody runs, which is exactly
 * how the circle went unwatched for four phases. Withdrawing what the run
 * published leaves the library as it was found.
 */
export const WITHDRAW_ROW = `(() => {
  for (const control of document.querySelectorAll('[data-mark-control="circle:share"]')) {
    let row = control
    for (let k = 0; k < 6 && row.parentElement; k++) {
      row = row.parentElement
      if ((row.textContent || '').length > (control.textContent || '').length + 20) break
    }
    const jump = row.querySelector('[class*="noteJump"]')
    if (!jump) continue
    if ((jump.textContent || '').trim().slice(0, 120) !== __WANT__) continue
    const button = [...control.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Withdraw')
    if (!button) return JSON.stringify({ ok: false, why: 'that row is not shared, so there is nothing to withdraw' })
    button.click()
    return JSON.stringify({ ok: true })
  }
  return JSON.stringify({ ok: false, why: 'no row carries that passage' })
})()`

export const withdrawRow = (quote) => WITHDRAW_ROW.replace('__WANT__', JSON.stringify(quote))

/** Click Share on one row. The WAIT is the caller's, in Node. */
export const clickShare = (index) =>
  '(() => {\n' +
  '  const control = ' + controlAt(index) + '\n' +
  "  if (!control) return JSON.stringify({ ok: false, why: 'that row is not on screen — the list moved under the driver' })\n" +
  "  const share = [...control.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Share')\n" +
  "  if (!share) return JSON.stringify({ ok: false, why: 'that row offers no Share button' })\n" +
  '  share.click()\n' +
  '  return JSON.stringify({ ok: true })\n' +
  '})()'

/** What one row's control says NOW — the publish is async, so this is polled. */
export const rowState = (index) =>
  '(() => {\n' +
  '  const control = ' + controlAt(index) + '\n' +
  "  if (!control) return JSON.stringify({ ok: false, why: 'the row left the screen mid-publish' })\n" +
  '  return JSON.stringify({\n' +
  '    ok: true,\n' +
  "    buttons: [...control.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),\n" +
  "    text: (control.textContent || '').trim().slice(0, 200),\n" +
  '  })\n' +
  '})()'

/* The Circle screen, where the roster and its per-person switches live. */
export const TO_CIRCLE = `(() => {
  const b = [...document.querySelectorAll('button,[role="button"]')].find((x) => (x.getAttribute('aria-label') || '').trim() === 'Circle')
  if (!b) return JSON.stringify({ ok: false, why: 'no Circle control in the titlebar' })
  b.click()
  return JSON.stringify({ ok: true })
})()`

/**
 * Every per-person switch on the Circle screen, by the name it names.
 *
 * ⚠️ **NOT FILTERED TO ONE KIND.** This listed only the hold-back switches
 * until WI-24.C3 needed the shelf one; a second copy filtered differently is
 * how the two drift. Both are drawn by the same `switchReady` gate, so a caller
 * waiting for "a switch" is waiting for the row to have read its port either
 * way.
 */
export const PERSON_SWITCHES = `(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
    .map((b) => ({ label: (b.getAttribute('aria-label') || '').trim(), checked: b.checked }))
    .filter((b) => b.label.startsWith('Hold back ') || b.label.startsWith('Show my shelf to '))
  return JSON.stringify({ ok: true, boxes })
})()`

/**
 * Flip the switch whose accessible name is exactly this.
 *
 * ⚠️ **BY THE CONTROL'S OWN ACCESSIBLE NAME, because that is what a reader
 * sees.** The roster row shows a display name and a short fingerprint; the
 * checkbox's label is the reader-facing sentence, and driving the control a
 * reader drives is the whole point of going through the UI rather than the
 * store.
 */
export const flipSwitch = (label, on) =>
  '(() => {\n' +
  '  const want = ' + JSON.stringify(label) + '\n' +
  '  const box = [...document.querySelectorAll(\'input[type="checkbox"]\')].find((b) => (b.getAttribute(\'aria-label\') || \'\').trim() === want)\n' +
  "  if (!box) return JSON.stringify({ ok: false, why: 'no switch labelled ' + want })\n" +
  '  if (box.checked === ' + JSON.stringify(Boolean(on)) + ') return JSON.stringify({ ok: true, already: true })\n' +
  '  box.click()\n' +
  '  return JSON.stringify({ ok: true })\n' +
  '})()'

/**
 * Open a friend's shelf on the Circle screen — the row's "Their shelf" button.
 *
 * ⚠️ **A JACKET IS FETCHED WHEN THE ROW IS SEEN, NOT IN THE ROUND.** `covers.ts`
 * asks the publishing device only for a row that is actually drawn, so a
 * harness that turns the shelf switch on and waits for covers to appear waits
 * for ever. Somebody has to look at the shelf.
 */
export const OPEN_FRIEND_SHELF = `(() => {
  const buttons = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === 'Their shelf')
  if (buttons.length === 0) {
    const open = [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Hide their shelf')
    return JSON.stringify({ ok: open, why: open ? undefined : 'no "Their shelf" button on the Circle screen' })
  }
  buttons[0].click()
  return JSON.stringify({ ok: true })
})()`

/** Whether a friend's shelf is showing, and how many rows it drew. */
export const FRIEND_SHELF_STATE = `(() => {
  const showing = [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Hide their shelf')
  return JSON.stringify({ ok: true, showing, images: document.querySelectorAll('img').length })
})()`

export const muteLabel = (name) => `Hold back ${name}'s passages`
export const shelfLabel = (name) => `Show my shelf to ${name}`

export const OPEN_MARGINALIA = `(() => {
  const tab = [...document.querySelectorAll('button,[role="button"]')].find((b) => (b.getAttribute('aria-label') || '').trim() === 'Marginalia')
  if (!tab) return JSON.stringify({ ok: false, why: 'no Marginalia tab — no book is open' })
  tab.click()
  return JSON.stringify({ ok: true })
})()`

/**
 * The reader's own marks, with the share control's state, from Marginalia.
 *
 * ⚠️ **MARGINALIA IS CROSS-BOOK.** It lists the reader's writing across the
 * whole library, labelling every mark that is NOT from the open book with its
 * book's title. So a row must be attributed before it is acted on: sharing
 * "the first unshared mark" without that check publishes a passage from
 * whichever book happened to sort first, and the converge step then waits for
 * a `pub` under a work claim the far end was never asked about.
 */
export const READ_MARKS = `(() => {
  const rows = [...document.querySelectorAll('[data-mark-control="circle:share"]')].map((c, i) => {
    /* textContent, never innerText: the latter forces layout, and doing it
       once per row on this pane was enough to blow the bridge's script
       timeout. Nothing here needs rendered text. (No backticks in this
       comment: it lives inside a template literal, and one would end it.) */
    let row = c
    for (let k = 0; k < 6 && row.parentElement; k++) {
      row = row.parentElement
      if ((row.textContent || '').length > (c.textContent || '').length + 20) break
    }
    const buttons = [...c.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
    /* ⚠️ **THE ATTRIBUTION IS A CLASS, NOT A TEXT PREFIX.** Marginalia gives a
       row from ANOTHER book a \`placeBook\` element carrying that book's title,
       and gives the open book's rows none. Deciding it by "does the text start
       with a title" needs a list of every title to compare against and breaks
       on any mark whose first words happen to look like one. */
    const place = row.querySelector('[class*="placeBook"]')
    return {
      i,
      buttons,
      shared: buttons.includes('Withdraw'),
      otherBook: place ? (place.textContent || '').trim() : null,
      text: (row.innerText || '').replace(/\\n+/g, ' / ').slice(0, 160),
    }
  })
  return JSON.stringify({ ok: true, rows })
})()`

export function parse(argv) {
  const args = { _: [], port: DEFAULT_PORT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--title') args.title = argv[++i]
    else if (a === '--person') args.person = argv[++i]
    else if (a === '--quote') args.quote = argv[++i]
    /* ⚠️ **THROWS, IT DOES NOT EXIT.** This called `usage()`, which writes to
       stderr and calls `process.exit` — fine inside the entry it came from,
       and the reason it could not be tested there. A pure parser reports; the
       process entry decides what a report costs. */
    else if (a.startsWith('--')) throw new Error('unknown option: ' + a)
    else args._.push(a)
  }
  return args
}
