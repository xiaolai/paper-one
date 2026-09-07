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
 *   withdraw --title <t> --quote <q>   take a publication back
 *   shelf  --person <name>       show them your shelf   (unshelf: stop)
 *   mute   --person <name>       hold that person's passages back
 *   unmute --person <name>       let them be drawn again
 *
 * Exit codes: 0 did what was asked, 1 could not, 2 was asked wrongly.
 */

import { pathToFileURL } from 'node:url'
import { connect, evaluate, DEFAULT_PORT } from './lib/bridge.mjs'
import {
  AT_SHELF,
  FRIEND_SHELF_STATE,
  IDENTITY,
  OPEN_FRIEND_SHELF,
  OPEN_MARGINALIA,
  PERSON_SWITCHES,
  READ_MARKS,
  ROW_STATE,
  SHARE_FIRST_UNSHARED,
  TO_CIRCLE,
  TO_SHELF,
  WITHDRAW_ROW,
  asJs,
  clickShare,
  controlAt,
  filterShelf,
  flipSwitch,
  moreSelector,
  muteLabel,
  openMatch,
  rowState,
  shelfLabel,
  shelfMatches,
  stateOfRow,
  withdrawRow,
  parse,
} from './lib/circle-scripts.mjs'

/* ------------------------------------------------------------------------ */
/* Scripts evaluated in the webview                                          */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function usage(message) {
  process.stderr.write(message + '\nSee the header of scripts/circle-drive.mjs.\n')
  process.exit(2)
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

  /* ⚠️ **A DEBUG BUILD IS NOT A RELEASE BUILD, AND THESE WAITS WERE TUNED
     AGAINST ONE.** The defaults (6 s) were measured against the release app on
     the machine running this script. Driving a DEBUG bundle over an ssh tunnel
     — which is how the far end is reached, because the bridge is debug-only —
     opening a book means parsing an EPUB with 1 962 rows on the shelf behind
     it, and 6 s is not close. Both failures read as "the app never reached the
     expected state", which is indistinguishable from a broken selector.
     Patience costs nothing on success and only delays an honest failure. */
  if (!(await atShelf())) {
    const back = await act(socket, TO_SHELF, 'go to the shelf', atShelf, 40)
    if (!back.ok) return back
  }
  const narrowed = await act(socket, filterShelf(title), 'narrow the shelf', async () =>
    (await read(shelfMatches(title), 'count the matches')).cells > 0, 40)
  if (!narrowed.ok) return narrowed

  /* Leaving the shelf IS the confirmation that the book opened: the search
     field belongs to the library screen and the reader has none. */
  const opened = await act(socket, openMatch(title), 'open the book', async () => !(await atShelf()), 120)
  if (!opened.ok) return opened

  const pane = await act(socket, OPEN_MARGINALIA, 'open Marginalia', async () =>
    (await read(READ_MARKS, 'look for share controls')).rows.length > 0, 60)
  if (!pane.ok) return pane
  return { ok: true }
}

async function main(argv) {
  let args
  try {
    args = parse(argv)
  } catch (cause) {
    usage(cause.message)
    return
  }
  const command = args._[0]
  if (!command) usage('a subcommand is required: identity | marks | share | withdraw | mute | unmute | shelf | unshelf | friend')

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

    if (command === 'mute' || command === 'unmute' || command === 'shelf' || command === 'unshelf') {
      if (!args.person) usage('--person <display name> is required')
      const on = command === 'mute' || command === 'shelf'
      const label = command === 'mute' || command === 'unmute' ? muteLabel(args.person) : shelfLabel(args.person)

      /* ⚠️ **THE CIRCLE CHIP IS ON THE SHELF, NOT IN THE READER.** It lives in
         the titlebar of the library screen, so a switch flipped straight after
         a share — which leaves the app in the reader with Marginalia open —
         finds no control to click and reports the screen as never arriving.
         Going to the shelf first is idempotent and costs one round trip. */
      const at = await evaluate(socket, AT_SHELF, 'where are we')
      if (at.shelf !== true) {
        const back = await act(socket, TO_SHELF, 'go to the shelf', async () =>
          (await evaluate(socket, AT_SHELF, 'where are we')).shelf === true, 40)
        if (!back.ok) {
          say(back)
          process.exit(1)
        }
      }
      /* The switches are drawn only once the row's own read of the port has
         answered (`switchReady`), so this waits for a switch and not for the
         screen. */
      const toCircle = await act(socket, TO_CIRCLE, 'open the Circle screen', async () =>
        (await evaluate(socket, PERSON_SWITCHES, 'find the switches')).boxes.length > 0, 40)
      if (!toCircle.ok) {
        say(toCircle)
        process.exit(1)
      }
      const flipped = await act(socket, flipSwitch(label, on), 'flip the switch', async () => {
        const seen = await evaluate(socket, PERSON_SWITCHES, 'read the switches')
        const box = seen.boxes.find((b) => b.label === label)
        return box !== undefined && box.checked === on
      }, 40)
      say(flipped.ok ? { ok: true, person: args.person, label, on } : flipped)
      process.exit(flipped.ok ? 0 : 1)
    }

    if (command === 'friend') {
      const at = await evaluate(socket, AT_SHELF, 'where are we')
      if (at.shelf !== true) {
        const back = await act(socket, TO_SHELF, 'go to the shelf', async () =>
          (await evaluate(socket, AT_SHELF, 'where are we')).shelf === true, 40)
        if (!back.ok) { say(back); process.exit(1) }
      }
      const toCircle = await act(socket, TO_CIRCLE, 'open the Circle screen', async () =>
        (await evaluate(socket, PERSON_SWITCHES, 'find the switches')).boxes.length > 0, 40)
      if (!toCircle.ok) { say(toCircle); process.exit(1) }
      const opened = await act(socket, OPEN_FRIEND_SHELF, "open the friend's shelf", async () =>
        (await evaluate(socket, FRIEND_SHELF_STATE, 'read the shelf')).showing === true, 40)
      if (!opened.ok) { say(opened); process.exit(1) }
      /* Covers are fetched one at a time behind the drawn rows; give them a
         window rather than reporting on the first frame. */
      await wait(15000)
      say({ ok: true, ...(await evaluate(socket, FRIEND_SHELF_STATE, 'read the shelf')) })
      process.exit(0)
    }

    if (command !== 'marks' && command !== 'share' && command !== 'withdraw') usage('unknown subcommand: ' + command)
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

    if (command === 'withdraw') {
      if (!args.quote) usage('--quote <the passage> is required')
      const gone = await act(socket, withdrawRow(args.quote), 'withdraw the passage', async () => {
        const now = await evaluate(socket, stateOfRow(args.quote), 'read the control')
        return now.ok === true && now.buttons.includes('Share')
      }, 60)
      say(gone.ok ? { ok: true, quote: args.quote } : gone)
      process.exit(gone.ok ? 0 : 1)
    }

    if (mine.length === 0) {
      say({ ok: false, why: 'Marginalia lists no mark of ' + JSON.stringify(args.title) + ' — mark a passage in it first', rows: listed.rows.length })
      process.exit(1)
    }

    /* Decided and clicked in one script — see SHARE_FIRST_UNSHARED. */
    const clicked = await evaluate(socket, SHARE_FIRST_UNSHARED, 'share the first unshared passage')
    if (!clicked.ok) {
      say(clicked)
      process.exit(1)
    }

    /* ⚠️ **THE WAIT IS THE ASSERTION.** The click resolves immediately and the
       publish is async — a driver that returned here would report success
       before anything was signed, and the converge step would then blame the
       far end for a page this machine never wrote. The control turning into
       `Withdraw` is the only local evidence the publication landed. */
    for (let i = 0; i < 60; i++) {
      await wait(500)
      const now = await evaluate(socket, stateOfRow(clicked.quote), 'read the control')
      if (!now.ok) {
        say(now)
        process.exit(1)
      }
      if (now.buttons.includes('Withdraw')) {
        say({ ok: true, waitedMs: (i + 1) * 500, quote: clicked.quote })
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

/* ⚠️ **GUARDED, SO THE TESTS CAN IMPORT THE BUILDERS.** A top-level `await
   main()` runs the whole CLI — bridge connection and all — the moment anything
   imports this file, which is how a unit test comes to need a running app. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
