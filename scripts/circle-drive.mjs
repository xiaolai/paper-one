/**
 * The circle harness's hands: everything `circle-scenario.sh` does TO the app,
 * done through the app's own UI over the MCP bridge.
 *
 * ⚠️ **THROUGH THE UI, NOT THROUGH THE STORE, AND THAT IS THE WHOLE POINT.** A
 * harness that wrote `shared.json` itself would be testing its own JSON writer:
 * the page a friend receives is SIGNED, and only the app can sign it. Every
 * mutation here clicks the control a reader would click. The scenario script
 * reads files to CHECK, and never to change.
 *
 * ⚠️ **DEBUG BUILDS ONLY.** The bridge plugin is compiled under a debug cfg, so
 * a release build answers nothing on the port — `connect` says so by name.
 *
 * Subcommands, each printing one JSON object on stdout:
 *
 *   identity                     who this device publishes as
 *   marks --title <t>            the reader's own marks and their share state
 *   share --title <t>            share one unshared mark of that book
 *   drawn --person <hex>         whether that person's passages are DRAWN here
 *
 * Exit codes: 0 did what was asked, 1 could not, 2 was asked wrongly.
 */

import { connect, evaluate, DEFAULT_PORT } from './lib/bridge.mjs'

/* ------------------------------------------------------------------------ */
/* Scripts evaluated in the webview                                          */
/* ------------------------------------------------------------------------ */

/**
 * ⚠️ **EVERY SNIPPET BELOW IS AN IIFE RETURNING JSON.** The bridge hands back
 * whatever the expression evaluates to; a bare arrow function comes back as
 * the source text of a function, which parses as neither an object nor an
 * error and reads downstream as "the app answered something odd".
 */

const IDENTITY = `(async () => {
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
const AT_SHELF = `(() => JSON.stringify({ shelf: !!document.querySelector('input[aria-label="Search the library"]') }))()`

/* Idempotent: on the shelf there is nothing to click. A second run of this
   script always starts with the previous run's book open, which made the FIRST
   run pass and every later one fail — the worst ordering for noticing. */
const TO_SHELF = `(() => {
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
const moreSelector = (title) => 'button[aria-label^=' + JSON.stringify('More for ' + title.slice(0, 24)) + ']'

const asJs = (value) => JSON.stringify(value)

/** How many shelf cells match, read-only — the narrow step's confirmation. */
const shelfMatches = (title) =>
  '(() => JSON.stringify({ cells: document.querySelectorAll(' + asJs(moreSelector(title)) + ').length }))()'

/**
 * ⚠️ **THE SHELF IS VIRTUALISED, so the row must be FILTERED into existence.**
 * 1 962 books render a few dozen cells; a selector for a title that is not near
 * the viewport finds nothing and reads exactly like a book that is not in the
 * library.
 */
const openMatch = (title) =>
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
const filterShelf = (title) =>
  '(() => {\n' +
  "  const input = document.querySelector('input[aria-label=\"Search the library\"]')\n" +
  "  if (!input) return JSON.stringify({ ok: false, why: 'no library search field on screen' })\n" +
  "  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set\n" +
  '  setter.call(input, ' + asJs(title) + ')\n' +
  "  input.dispatchEvent(new Event('input', { bubbles: true }))\n" +
  '  return JSON.stringify({ ok: true })\n' +
  '})()'

const controlAt = (index) => "[...document.querySelectorAll('[data-mark-control=\"circle:share\"]')][" + Number(index) + ']'

/** Click Share on one row. The WAIT is the caller's, in Node. */
const clickShare = (index) =>
  '(() => {\n' +
  '  const control = ' + controlAt(index) + '\n' +
  "  if (!control) return JSON.stringify({ ok: false, why: 'that row is not on screen — the list moved under the driver' })\n" +
  "  const share = [...control.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Share')\n" +
  "  if (!share) return JSON.stringify({ ok: false, why: 'that row offers no Share button' })\n" +
  '  share.click()\n' +
  '  return JSON.stringify({ ok: true })\n' +
  '})()'

/** What one row's control says NOW — the publish is async, so this is polled. */
const rowState = (index) =>
  '(() => {\n' +
  '  const control = ' + controlAt(index) + '\n' +
  "  if (!control) return JSON.stringify({ ok: false, why: 'the row left the screen mid-publish' })\n" +
  '  return JSON.stringify({\n' +
  '    ok: true,\n' +
  "    buttons: [...control.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),\n" +
  "    text: (control.textContent || '').trim().slice(0, 200),\n" +
  '  })\n' +
  '})()'

const OPEN_MARGINALIA = `(() => {
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
const READ_MARKS = `(() => {
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

/* ------------------------------------------------------------------------ */

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function usage(message) {
  process.stderr.write(message + '\nSee the header of scripts/circle-drive.mjs.\n')
  process.exit(2)
}

function parse(argv) {
  const args = { _: [], port: DEFAULT_PORT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--title') args.title = argv[++i]
    else if (a === '--person') args.person = argv[++i]
    else if (a.startsWith('--')) usage('unknown option: ' + a)
    else args._.push(a)
  }
  return args
}

const say = (value) => process.stdout.write(JSON.stringify(value) + '\n')

/**
 * Run a script that CHANGES something, then prove it changed by looking.
 *
 * ⚠️ **THE ASSERTION IS THE OBSERVATION, NOT THE CALL RETURNING.** A click
 * resolves the moment it is dispatched; what matters is whether the app moved.
 * So every mutating step here is followed by a separate read that must come
 * back the way it should, or the step fails by name.
 *
 * ⚠️ **AND IT DOES NOT SWALLOW ERRORS.** An earlier version treated a bridge
 * timeout as "probably ran, check anyway", on the strength of having seen a
 * filter land despite one. That evidence was contaminated — the filter had
 * been applied by hand from a separate session minutes earlier — and the real
 * cause was a SyntaxError in a script this file generated. Swallowing the
 * message would have hidden it permanently. Errors propagate.
 */
async function act(socket, script, label, verify, tries = 12) {
  const answer = await evaluate(socket, script, label)
  if (answer && answer.ok === false) return answer
  for (let i = 0; i < tries; i++) {
    await wait(500)
    if (await verify()) return { ok: true, confirmedAfterMs: (i + 1) * 500 }
  }
  return { ok: false, why: label + ': the script ran and the app never reached the expected state' }
}

/** Navigate to the book and open Marginalia. Every step names its own failure. */
async function reachMarginalia(socket, title) {
  const read = (script, label) => evaluate(socket, script, label)
  const atShelf = async () => (await read(AT_SHELF, 'where are we')).shelf === true

  if (!(await atShelf())) {
    const back = await act(socket, TO_SHELF, 'go to the shelf', atShelf)
    if (!back.ok) return back
  }
  const narrowed = await act(socket, filterShelf(title), 'narrow the shelf', async () =>
    (await read(shelfMatches(title), 'count the matches')).cells > 0)
  if (!narrowed.ok) return narrowed

  /* Leaving the shelf IS the confirmation that the book opened: the search
     field belongs to the library screen and the reader has none. */
  const opened = await act(socket, openMatch(title), 'open the book', async () => !(await atShelf()))
  if (!opened.ok) return opened

  const pane = await act(socket, OPEN_MARGINALIA, 'open Marginalia', async () =>
    (await read(READ_MARKS, 'look for share controls')).rows.length > 0)
  if (!pane.ok) return pane
  return { ok: true }
}

async function main(argv) {
  const args = parse(argv)
  const command = args._[0]
  if (!command) usage('a subcommand is required: identity | marks | share')

  let socket
  try {
    socket = await connect(args.port)
  } catch (cause) {
    /* ⚠️ NAMED, because "no bridge" and "no app" look identical from here and
       they need different fixes — one is a release build, one is a stopped
       app. The scenario script checks the process separately for that reason. */
    say({ ok: false, why: 'the bridge did not answer: ' + cause.message + ' (a RELEASE build answers nothing on this port)' })
    process.exit(1)
  }

  try {
    if (command === 'identity') {
      const answer = await evaluate(socket, IDENTITY, 'identity')
      say(answer)
      process.exit(answer.ok ? 0 : 1)
    }

    if (command !== 'marks' && command !== 'share') usage('unknown subcommand: ' + command)
    if (!args.title) usage('--title <book title> is required')

    const reached = await reachMarginalia(socket, args.title)
    if (!reached.ok) {
      say(reached)
      process.exit(1)
    }
    const listed = await evaluate(socket, READ_MARKS, 'read the marks')
    if (!listed.ok) {
      say(listed)
      process.exit(1)
    }
    /* Only the OPEN book's rows — `otherBook` is null for exactly those.
       Sharing "the first unshared row" without this publishes a passage from
       whichever book Marginalia happened to list first, and the converge step
       then waits for a `pub` under a work claim the far end was never asked
       about. */
    const mine = listed.rows.filter((r) => r.otherBook === null)

    if (command === 'marks') {
      say({ ok: true, ofThisBook: mine.length, rows: listed.rows })
      process.exit(0)
    }

    if (mine.length === 0) {
      say({ ok: false, why: 'Marginalia lists no mark of ' + JSON.stringify(args.title) + ' — mark a passage in it first', rows: listed.rows.length })
      process.exit(1)
    }
    const candidate = mine.find((r) => !r.shared)
    if (!candidate) {
      say({ ok: false, why: 'every mark of that book is already shared — withdraw one, or mark a fresh passage', ofThisBook: mine.length })
      process.exit(1)
    }

    const clicked = await evaluate(socket, clickShare(candidate.i), 'click Share')
    if (clicked && clicked.ok === false) {
      say(clicked)
      process.exit(1)
    }

    /* ⚠️ **THE WAIT IS THE ASSERTION.** `click()` returns immediately and the
       publish is async — a driver that returned here would report success
       before anything was signed, and the converge step would then blame the
       far end for a page this machine never wrote. The control turning into
       `Withdraw` is the only local evidence the publication landed. */
    for (let i = 0; i < 60; i++) {
      await wait(500)
      const now = await evaluate(socket, rowState(candidate.i), 'read the control')
      if (!now.ok) {
        say(now)
        process.exit(1)
      }
      if (now.buttons.includes('Withdraw')) {
        say({ ok: true, row: candidate.i, waitedMs: (i + 1) * 500, text: candidate.text })
        process.exit(0)
      }
      if (/could not|failed|cannot/i.test(now.text)) {
        say({ ok: false, why: 'the control reported: ' + now.text })
        process.exit(1)
      }
    }
    say({ ok: false, why: 'the control never became Withdraw — the publish did not land within 30s' })
    process.exit(1)
  } catch (cause) {
    say({ ok: false, why: cause.message })
    process.exit(1)
  } finally {
    try {
      socket.close()
    } catch {
      /* closing a socket that already closed is not a failure of the run */
    }
  }
}

await main(process.argv.slice(2))
