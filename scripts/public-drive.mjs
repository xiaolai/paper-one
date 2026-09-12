/**
 * The public harness's hands: everything `public-scenario.sh` does TO the app,
 * done through the app's own UI over the MCP bridge.
 *
 * ⚠️ **THROUGH THE UI, NOT THROUGH THE STORE, AND THAT IS THE WHOLE POINT.** A
 * harness that wrote `public.jsonl` itself would be testing its own JSON
 * writer: a public annotation is SIGNED by the voice key, and only the app can
 * sign it. Every mutation here clicks the control a reader would click. The
 * scenario script reads files to CHECK, and never to change. `circle-drive.mjs`
 * states the same rule and is the reason this one exists in this shape.
 *
 * ⚠️ **DEBUG BUILDS ONLY.** The bridge plugin is compiled under a debug cfg, so
 * a release build answers nothing on the port — `connect` says so by name.
 *
 * ⚠️ **BUT `withGlobalTauri` IS NOT REQUIRED, AND `AGENTS.md` SAID IT WAS.**
 * Nothing here calls `invoke`; every subcommand is DOM. Measured 2026-09-11
 * against a build running the plain `tauri.conf.json`, where
 * `window.__TAURI__` is undefined: `webview_execute_js` answered normally, read
 * the closed shadow root's contents, and drove the page. So the far end does
 * not need the dev config layered over it — which matters, because the far end
 * gets a bundle rather than a dev server.
 *
 * Subcommands, each printing one JSON object on stdout:
 *
 *   open   --title <t>     bring that book up in the reader
 *   pane   --title <t>     open the Publish pane and report its three rows
 *   whoami --title <t>     this device's share id, as the pane shows it
 *   offer  --title <t>     offer the file itself to anyone
 *   notes  --title <t>     publish the notes about it
 *   say    --title <t>     publish the first unpublished passage, and WAIT
 *   look   --title <t> [--at <device id>]   ask for its notes, optionally
 *                          naming the device to ask rather than relying on the index
 *   stop   --title <t> --label <button>   press a named withdrawal button
 *
 * Exit codes: 0 did what was asked, 1 could not, 2 was asked wrongly.
 */

import { isProcessEntry } from './lib/entry.mjs'
import { connect, evaluate, DEFAULT_PORT } from './lib/bridge.mjs'
import {
  ASK_FIRST_UNPUBLISHED,
  AT_SHELF,
  CONFIRM_OPEN_DISCLOSURE,
  OPEN_DISCLOSURE_STATE,
  MY_SHARE_ID,
  askWho,
  OPEN_PUBLISH_PANE,
  PANE_STATE,
  TO_SHELF,
  clickPaneButton,
  filterShelf,
  openMatch,
  parseArgs,
  shelfMatches,
} from './lib/public-scripts.mjs'

const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function usage(why) {
  process.stderr.write(`public-drive: ${why}\n`)
  process.exit(2)
}

/**
 * Get that book open, in short round trips rather than one long one.
 *
 * ⚠️ **THE BRIDGE HAS ITS OWN SCRIPT TIMEOUT AND IT IS SHORTER THAN THE
 * NAVIGATION.** A single snippet that clicked, waited, typed and clicked again
 * came back as `Script execution timeout` during the circle's harness — the
 * bridge's message, not this client's, so no timeout set here ever applied.
 * Waiting inside the webview spends the bridge's budget; waiting in Node
 * spends none of it.
 *
 * ⚠️ **AND THE SHELF IS VIRTUALISED**, so the row is FILTERED into existence
 * rather than searched for. 1 962 books render a few dozen cells; a selector
 * for a title that is not near the viewport finds nothing and reads exactly
 * like a book that is not in the library.
 */
async function openBook(socket, title) {
  const where = await evaluate(socket, AT_SHELF, 'find out where we are')
  if (!where.shelf) {
    await evaluate(socket, TO_SHELF, 'go back to the shelf')
    await wait(600)
  }
  await evaluate(socket, filterShelf(title), 'narrow the shelf to that title')
  await wait(900)
  const seen = await evaluate(socket, shelfMatches(title), 'count the matching cells')
  if (!seen.cells) {
    return { ok: false, why: `the shelf has no book titled ${JSON.stringify(title)} — it was filtered and nothing matched` }
  }
  if (seen.cells > 1) {
    /* Refused rather than guessed: two books of one title would have two
       different content hashes, so the far end would be asked about one and
       the passage published under the other. */
    return { ok: false, why: `${seen.cells} books on this shelf are titled ${JSON.stringify(title)} — name one that is unique` }
  }
  const opened = await evaluate(socket, openMatch(title), 'open that book')
  if (!opened.ok) return opened
  await wait(1500)
  return { ok: true }
}

/** Open the Publish pane and read it back, which is also the proof it opened. */
async function openPane(socket) {
  const tab = await evaluate(socket, OPEN_PUBLISH_PANE, 'open the Publish pane')
  if (!tab.ok) return tab
  await wait(800)
  return evaluate(socket, PANE_STATE, 'read the Publish pane')
}

/**
 * Click a pane button and wait for the pane to AGREE.
 *
 * ⚠️ **THE WAIT IS THE ASSERTION.** Every one of these controls resolves its
 * click immediately and does its work asynchronously — offering a book mints a
 * topic and binds an endpoint; publishing notes writes and signs a file. A
 * driver that returned at the click would report success before anything had
 * happened, and the converge step would then blame the far end for work this
 * machine never did. This is `circle-drive.mjs`'s rule, and it is the single
 * most load-bearing line in either harness.
 */
async function clickAndSettle(socket, label, settled, seconds = 45) {
  const clicked = await evaluate(socket, clickPaneButton(label), `press ${label}`)
  if (!clicked.ok) return clicked
  for (let i = 0; i < seconds * 2; i++) {
    await wait(500)
    const now = await evaluate(socket, PANE_STATE, 'read the Publish pane')
    if (!now.ok) return now
    if (settled(now)) return { ok: true, waitedMs: (i + 1) * 500, pane: now }
  }
  return { ok: false, why: `${label} was pressed and the pane never agreed within ${seconds}s` }
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.error) usage(args.error)
  const { command, title } = args
  const port = args.port ?? DEFAULT_PORT
  if (!title) usage('--title <book title> is required')

  /* ⚠️ **CONNECTING IS INSIDE THE HANDLED PATH, AND IT WAS OUTSIDE.** This file
     promises "one JSON object on stdout" and an exit code; a refused connection
     threw past the catch and produced a Node stack trace instead, which the
     scenario script then reported as an empty `note` line. Found by an
     independent audit, 2026-09-11 — and the scenario's own transcript shows it:
     two steps whose whole diagnostic was the words "Node.js v24.18.0". */
  let socket
  try {
    socket = await connect(port)
  } catch (cause) {
    say({ ok: false, why: `could not reach the app's bridge on port ${port}: ${cause.message}` })
    process.exit(1)
  }
  try {
    const open = await openBook(socket, title)
    if (!open.ok) {
      say(open)
      process.exit(1)
    }

    if (command === 'open') {
      say({ ok: true, title })
      process.exit(0)
    }

    const pane = await openPane(socket)
    if (!pane.ok) {
      say(pane)
      process.exit(1)
    }

    if (command === 'pane') {
      say({ ok: true, ...pane })
      process.exit(0)
    }

    if (command === 'whoami') {
      /* Read off the PANE rather than by invoking the command, so this stays
         DOM-only and works against a bundle with no `window.__TAURI__`. */
      const mine = await evaluate(socket, MY_SHARE_ID, "read this device's share id")
      say(mine)
      process.exit(mine.ok ? 0 : 1)
    }

    if (command === 'offer') {
      if (pane.bytes === 'offered') {
        say({ ok: true, already: true, bytes: 'offered' })
        process.exit(0)
      }
      if (pane.bytes === 'no-control') {
        /* The third answer PANE_STATE exists to keep: the app is refusing to
           offer this book and says why in a sentence beside the missing
           button. Waiting on a control that will never appear is what the
           scenario would otherwise do. */
        say({ ok: false, why: 'the pane draws no offer control for this book — its fingerprint is not ready, or the app refuses to offer it' })
        process.exit(1)
      }
      const done = await clickAndSettle(socket, 'Offer to anyone', (p) => p.bytes === 'offered')
      say(done)
      process.exit(done.ok ? 0 : 1)
    }

    if (command === 'notes') {
      if (pane.notes === 'published') {
        say({ ok: true, already: true, notes: 'published' })
        process.exit(0)
      }
      if (pane.notes === 'no-control') {
        say({ ok: false, why: 'the pane draws no publish control for this book — Paper has not finished reading its fingerprint' })
        process.exit(1)
      }
      const done = await clickAndSettle(socket, 'Publish notes', (p) => p.notes === 'published')
      say(done)
      process.exit(done.ok ? 0 : 1)
    }

    if (command === 'stop') {
      if (!args.label) usage('--label <button text> is required for stop')
      const done = await clickAndSettle(
        socket,
        args.label,
        (p) => (args.label === 'Stop offering' ? p.bytes !== 'offered' : p.notes !== 'published'),
      )
      say(done)
      process.exit(done.ok ? 0 : 1)
    }

    if (command === 'look') {
      if (!pane.canLook) {
        say({ ok: false, why: 'the pane draws no "Look for some" control — this build has no way to ask, which is the half phase 26 was missing' })
        process.exit(1)
      }
      /* ⚠️ **NAME WHO TO ASK, BECAUSE THE INDEX IS THE DHT AND NOTHING
         ELSE.** With announcing off `resolve` answers nobody and there is no
         other route from a hash to a provider — so a run that does not supply
         `--at` can only succeed against a machine that has published its home
         address to a permanent public index. Measured 2026-09-11: the first
         green run of this harness came from naming the publisher. */
      if (args.at) {
        const typed = await evaluate(socket, askWho(args.at), 'name the device to ask')
        if (!typed.ok) {
          say(typed)
          process.exit(1)
        }
        await wait(300)
      }
      /* ⚠️ **ASKING IS ON A CONTROL AND NEVER ON A TIMER**, deliberately:
         asking tells whoever answers that this device is interested in this
         book. So the harness presses it, exactly as a reader would, and there
         is nothing to wait for on a schedule. */
      const asked = await evaluate(socket, clickPaneButton('Look for some'), 'ask for other people’s notes')
      if (!asked.ok) {
        say(asked)
        process.exit(1)
      }
      /* The pane reports WHAT ARRIVED rather than what was kept, so the number
         it draws is not the assertion. The scenario reads `public.jsonl` on
         disk, which is what the overlay actually draws from. */
      await wait(4000)
      say({ ok: true, asked: true, at: args.at ?? '(whoever advertised)' })
      process.exit(0)
    }

    if (command === 'say') {
      /* Marginalia, not the Publish pane — the passage control lives on the
         mark's own row, deliberately beside the circle's Share so that
         reaching both audiences takes two acts by the reader. */
      const tab = await evaluate(
        socket,
        `(() => {
          const b = [...document.querySelectorAll('button,[role="button"]')].find((x) => (x.getAttribute('aria-label') || '').trim() === 'Marginalia')
          if (!b) return JSON.stringify({ ok: false, why: 'no Marginalia tab — no book is open' })
          b.click()
          return JSON.stringify({ ok: true })
        })()`,
        'open Marginalia',
      )
      if (!tab.ok) {
        say(tab)
        process.exit(1)
      }
      await wait(900)
      const asked = await evaluate(socket, ASK_FIRST_UNPUBLISHED, 'ask to publish the first unpublished passage')
      if (!asked.ok) {
        say(asked)
        process.exit(1)
      }
      /* ⚠️ **SCOPED TO THE DISCLOSURE THIS RUN OPENED.** `clickPaneButton`
         searches the whole document, so it would confirm whichever row had a
         disclosure open — and `Publish to anyone` is disabled until the
         disclosure has loaded, so this still retries until it is live. */
      let confirmed = { ok: false, why: 'the disclosure never finished loading' }
      for (let i = 0; i < 40; i++) {
        await wait(500)
        confirmed = await evaluate(socket, CONFIRM_OPEN_DISCLOSURE, 'confirm the publication')
        if (confirmed.ok) break
      }
      if (!confirmed.ok) {
        say(confirmed)
        process.exit(1)
      }
      /* The control's own sentence is the only local evidence the signing
         landed. Returning at the click would report success before anything
         was signed. */
      /* ⚠️ **THE CONTROL THIS RUN CONFIRMED, NOT A COUNT.** "Any row says
         Published." passes when a different row lands; "one more than before"
         passes when any row lands at all. Only the marked control answers the
         question that was asked. */
      for (let i = 0; i < 60; i++) {
        await wait(500)
        const now = await evaluate(socket, OPEN_DISCLOSURE_STATE, 'read the publish controls')
        if (!now.ok) {
          say(now)
          process.exit(1)
        }
        if (now.selectedPublished === true) {
          say({ ok: true, waitedMs: (i + 1) * 500, quote: asked.quote })
          process.exit(0)
        }
        if (now.selectedPublished === null) {
          say({ ok: false, why: 'the control this run confirmed is no longer in the DOM — the pane re-rendered it away' })
          process.exit(1)
        }
      }
      /* The control's own text, not a bare timeout — see `OPEN_DISCLOSURE_STATE`.
         If the app refused, its reason is in here. */
      const last = await evaluate(socket, OPEN_DISCLOSURE_STATE, 'read the publish controls')
      const asked_ = last.ok ? [last.selectedSays ?? '(the selected control is gone)', ...last.bodies] : []
      say({
        ok: false,
        why: 'no control ever read "Published." within 30s',
        controlsSaid: asked_.length > 0 ? asked_ : '(every control is still offering — the disclosure closed without publishing)',
      })
      process.exit(1)
    }

    usage(`unknown subcommand ${JSON.stringify(command)}`)
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
if (isProcessEntry(import.meta)) {
  await main(process.argv.slice(2))
}
