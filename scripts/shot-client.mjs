#!/usr/bin/env node
/**
 * A picture of the browser client, from the engine it actually ships against.
 *
 * `node scripts/shot-client.mjs [out.png] [--path /] [--width 390] [--height 844]`
 * `                              [--click <selector>] [--wait <selector>]`
 *
 * ## Why this exists
 *
 * Phase 18's gate screen was written, its every custom property confirmed to
 * resolve, the token guard run — and it shipped with the caret detached from a
 * placeholder that read as a typed value. **Resolving is not looking.** No
 * check over declarations can see a layout, and the first person to see this
 * screen rendered was the reader, which is the wrong order.
 *
 * ## Why WebKit and not Chromium
 *
 * The client is served to a phone, and every browser on iOS is WebKit whatever
 * its icon says. A Chromium screenshot would be a picture of a rendering nobody
 * receives — and the defect that started this is a WebKit caret behaviour, so
 * the wrong engine would have shown a clean field.
 *
 * ## Why it drives the RUNNING shelf
 *
 * The client is not a static page: it asks `/api/auth/session` before it draws
 * anything, and what it draws depends on the answer. Serving `dist-web/` from a
 * file server would render the unreachable state forever and call it the gate
 * screen. So this points at `127.0.0.1:27182` and reports plainly when nothing
 * is there, rather than photographing a failure mode and presenting it as a
 * design.
 */

import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { webkit, devices } from '@playwright/test'

/* Overridable, because every screen behind the six digits needs TLS to reach —
 * see the caveat below. `scripts/dev-tls.mjs` puts a throwaway certificate in
 * front of the shelf; point this at it. */
const ORIGIN = process.env['PAPER_CLIENT_ORIGIN'] ?? 'http://127.0.0.1:27182'
/* An iPhone 15's CSS viewport. A desktop window would flatter a layout whose
 * whole point is the phone — the design's own note is that on mobile
 * "adjacency becomes sequence". */
const DEFAULT = { width: 393, height: 852 }

function parse(argv) {
  const out = {
    file: 'dev-docs/artifacts/client.png',
    path: '/',
    ...DEFAULT,
    dark: false,
    click: null,
    wait: null,
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--path') out.path = argv[++i] ?? '/'
    else if (arg === '--width') out.width = Number(argv[++i])
    else if (arg === '--height') out.height = Number(argv[++i])
    else if (arg === '--dark') out.dark = true
    else if (arg === '--click') out.click = argv[++i]
    else if (arg === '--wait') out.wait = argv[++i]
    else rest.push(arg)
  }
  if (rest[0] !== undefined) out.file = rest[0]

  /* CREDENTIALS COME FROM THE ENVIRONMENT, AND ONLY FROM THERE.
   *
   * `PAPER_CLIENT_COOKIE` is a ninety-day session credential and
   * `PAPER_CLIENT_CODE` is the six digits that mint one. They used to be
   * `--cookie` and `--code`, which put both in the shell's history file and, for
   * as long as the process lived, in `ps` output — readable by every other
   * process running as this user. The flags are refused outright below rather
   * than deprecated; see the note there for why a warning is not a fix. */
  out.cookie = process.env['PAPER_CLIENT_COOKIE'] ?? null
  out.code = process.env['PAPER_CLIENT_CODE'] ?? null
  return out
}

const options = parse(process.argv.slice(2))

/* A WARNING DOES NOT UNSET THE EXPOSURE, which is why this refuses instead.
 *
 * The first pass at this printed a note and carried on. The note is read after
 * the credential is already in the shell's history file and already visible in
 * `ps` to every process running as this user — the damage is done by the time
 * anything can advise against it. The only version of this that works is the
 * one that will not run.
 *
 * Both flags are gone rather than deprecated: this is a development tool, its
 * callers are a handful of notes, and the replacement is one word longer. */
for (const [flag, variable] of [
  ['--cookie', 'PAPER_CLIENT_COOKIE'],
  ['--code', 'PAPER_CLIENT_CODE'],
]) {
  if (process.argv.includes(flag)) {
    console.error(
      `shot-client: ${flag} is refused — it puts a credential in argv, where your\n` +
        `  shell history and every other process's \`ps\` can read it.\n` +
        `\n` +
        `  Use the environment instead:\n` +
        `    ${variable}=… node scripts/shot-client.mjs …\n`,
    )
    process.exit(2)
  }
}

/**
 * Is `ORIGIN` the throwaway dev TLS front, rather than somebody's real shelf?
 *
 * The dev front generates a self-signed certificate per run, so no client can
 * validate it and every connection to it has to be told to stop caring. That is
 * safe for loopback and is the opposite of safe for anything else: this script
 * SENDS A SESSION COOKIE, and ignoring certificate errors while doing so means
 * handing a long-lived credential to whatever answered.
 */
const LOCAL_TLS = /^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(ORIGIN)

/* The reachability probe below runs in NODE, which validates certificates —
 * and the dev TLS front is self-signed by design. Disabled only for a LOCAL
 * https origin, so this can never quiet a real certificate error against a real
 * host. Playwright is told separately, via `ignoreHTTPSErrors`. */
if (LOCAL_TLS) {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
}

/* THE SHELF MUST BE RUNNING, and saying so is the whole value of this check.
 * A screenshot of a connection failure looks like a screenshot of a screen. */
const probe = await fetch(`${ORIGIN}/api/auth/session`, { redirect: 'manual' }).catch(() => null)
if (probe === null) {
  console.error(
    `shot-client: nothing is answering at ${ORIGIN}.\n` +
      '  Start the app with `pnpm app`. The client is served BY the shelf, so\n' +
      '  there is no page to photograph without one.',
  )
  process.exit(2)
}

/* IS THE SHELF SERVING WHAT WAS LAST BUILT?
 *
 * `pnpm build:web` writes `dist-web/`; the shelf serves a copy EMBEDDED at
 * cargo-build time. Change the client, rebuild it, screenshot — and the picture
 * is of the previous bundle, identical in every way that would make you suspect
 * it. That happened, and the measurements looked so plausible they were nearly
 * believed.
 *
 * Vite hashes the entry script, so the two are comparable in one line. */
const servedHtml = await fetch(ORIGIN).then((r) => r.text()).catch(() => '')
const served = /index\.web-[^."]*\.js/.exec(servedHtml)?.[0]
const built = (await readdir('dist-web/assets').catch(() => [])).find((name) =>
  /^index\.web-.*\.js$/.test(name),
)
if (served !== undefined && built !== undefined && served !== built) {
  console.error(
    `shot-client: THE SHELF IS SERVING A STALE CLIENT.\n` +
      `  serving: ${served}\n` +
      `  built:   ${built}\n` +
      '  The bundle is embedded at cargo-build time, so `pnpm build:web` alone\n' +
      '  does not change what is served. Touch a file under\n' +
      '  src-tauri/crates/tauri-plugin-webhost/src/ and let `pnpm app` rebuild.',
  )
  process.exit(3)
}

const browser = await webkit.launch()
const context = await browser.newContext({
  ...devices['iPhone 15'],
  /* The dev TLS front is self-signed on purpose — it is generated fresh and
   * thrown away, and no browser will trust it. Ignoring the error here is what
   * makes the connected screens photographable at all; it says nothing about
   * how a real phone reaches this shelf, which is the reader's own TLS.
   *
   * ⚠️ SCOPED, and it was not. This read `ignoreHTTPSErrors: true`
   * unconditionally, while the Node probe six lines up was already careful to
   * limit its own bypass to loopback — the two disagreed, and the careless one
   * was the one holding the credential. Point `PAPER_CLIENT_ORIGIN` at a real
   * shelf and this browser would submit the pairing code, or attach a
   * ninety-day session cookie, over a TLS connection whose peer it had
   * deliberately declined to authenticate. Anyone able to answer for that name
   * gets the credential. */
  ignoreHTTPSErrors: LOCAL_TLS,
  viewport: { width: options.width, height: options.height },
  colorScheme: options.dark ? 'dark' : 'light',
})
/* A CREDENTIAL OBTAINED ELSEWHERE. A code lives ninety seconds, which is not
 * long enough to survive minting it through the automation bridge and then
 * starting a browser — the round trips alone spend it. Submitting the code
 * with `curl` and passing the cookie here collapses that to one step. */
if (options.cookie !== null) {
  const { hostname } = new URL(ORIGIN)
  await context.addCookies([
    {
      name: 'paper_session',
      value: options.cookie,
      domain: hostname,
      path: '/',
      httpOnly: true,
      secure: ORIGIN.startsWith('https:'),
      sameSite: 'Strict',
    },
  ])
}

const page = await context.newPage()

/* Console and page errors are REPORTED, not swallowed. A screenshot of a blank
 * page with a thrown module error in the console is the exact failure this
 * script exists to make visible. */
const problems = []
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`)
})
page.on('pageerror', (error) => problems.push(`page: ${error.message}`))

/* SIGN IN FIRST, when a code is given.
 *
 * Without this the tool can only ever photograph the gate — every screen behind
 * the six digits is unreachable, which is most of the client. The code is
 * submitted through the same endpoint the client uses, so the cookie the
 * browser stores is the real one.
 *
 * ⚠️ **A CONNECTED STATE NEEDS A TLS ORIGIN**, and the reason is not this
 * script's. Measured 2026-08-25: WebKit stores the `Secure` session cookie from
 * `http://127.0.0.1` and then refuses to SEND it, so the code is accepted, the
 * cookie is in the jar, and every page fetch is still 401.
 *
 * Run `node scripts/dev-tls.mjs` and set
 * `PAPER_CLIENT_ORIGIN=https://localhost:27183`. Certificate errors are ignored
 * here because that front is self-signed by design.
 *
 * NAVIGATE FIRST. Posting from `about:blank` gets a 204 and stores nothing:
 * the cookie has no origin to attach to, so the next load shows the gate again
 * and the tool reports success. That cost a confusing half hour — the sign-in
 * looked fine and the screenshot was of a failure.
 *
 * Mint a code with the app's Settings → Browsers pane, or the plugin command. */
if (options.code !== null) {
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  const response = await page.request.post(`${ORIGIN}/api/auth/submit`, {
    data: { code: options.code },
  })
  if (response.status() !== 204) {
    console.error(
      `shot-client: the code was refused (${response.status()}).\n` +
        '  409 means no code is showing, 410 that it expired, 429 that its five\n' +
        '  tries are spent, 401 that it was wrong. Show a new one and retry.',
    )
    await browser.close()
    process.exit(4)
  }
}

await page.goto(`${ORIGIN}${options.path}`, { waitUntil: 'networkidle' })

/* `networkidle` IS NOT ENOUGH once there is a channel. The shelf's books arrive
 * over a WebSocket, which is not a request and so never makes the page "idle"
 * or un-idle — the first screenshot of the connected state caught "Loading…"
 * and would have been read as the shelf being empty.
 *
 * Waiting for the word rather than a fixed delay: a fixed delay is either too
 * short on a slow shelf or wasted on a fast one, and it silently becomes the
 * former. */
await page
  .waitForFunction(() => !document.body.innerText.includes('Loading…'), null, { timeout: 5000 })
  .catch(() => console.error('shot-client: still loading after 5s — the picture shows that state'))

/* REACHING A SCREEN THAT HAS NO URL.
 *
 * The client has no router: the reader is state on the shelf, so `--path`
 * cannot address it and the whole reading surface — the part a phone actually
 * spends its time in — was unphotographable by the tool written to photograph
 * the screens behind the gate. One click closes that.
 *
 * `--wait` is a SELECTOR, not a delay. What follows a click is a book being
 * fetched over the channel and laid out, which takes as long as it takes; a
 * fixed delay is either too short on a big book or wasted on a small one, and
 * it silently becomes the former on the book you care about. */
/* A REQUESTED INTERACTION THAT DID NOT HAPPEN IS A FAILURE, not a note.
 *
 * Both of these used to log to stderr and carry on, and the process then wrote
 * a screenshot and exited 0. `--click` exists precisely because the reading
 * surface has no URL, so a click that never landed means the picture is of the
 * LIBRARY while its filename and the caller's intent both say "the reader".
 * Nobody reads stderr of a command that succeeded; the exit code is the part
 * that gets checked, and it said everything was fine.
 *
 * The screenshot is still written — it is evidence about what went wrong — and
 * the exit code is what changes. */
let missed = null
if (options.click !== null) {
  const target = page.locator(options.click).first()
  const visible = await target
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false)
  if (visible) await target.click()
  else missed = `nothing matched --click ${options.click}`
}
if (options.wait !== null) {
  const appeared = await page
    .locator(options.wait)
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  if (!appeared) missed ??= `--wait ${options.wait} never appeared`
}

await mkdir(path.dirname(options.file), { recursive: true })
await page.screenshot({ path: options.file, fullPage: false })

/* What the page ACTUALLY resolved to, not what the stylesheet asked for.
 * `getComputedStyle` is the difference between "the token exists" and "the
 * element is that size" — the gap the gate screen fell through. */
const measured = await page.evaluate(() => {
  const seen = {}
  for (const [name, selector] of [
    ['field', 'input'],
    ['button', 'button'],
    ['heading', 'h1'],
  ]) {
    const el = document.querySelector(selector)
    if (el === null) continue
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    seen[name] = {
      box: { w: Math.round(box.width), h: Math.round(box.height), x: Math.round(box.x) },
      font: style.fontFamily.split(',')[0],
      fontSize: style.fontSize,
      radius: style.borderRadius,
      background: style.backgroundColor,
      align: style.textAlign,
      letterSpacing: style.letterSpacing,
    }
  }
  return { title: document.title, text: document.body.innerText.trim().slice(0, 200), seen }
})

await browser.close()

console.log(`shot-client: ${options.file}  ${options.width}x${options.height}  ${options.dark ? 'dark' : 'light'}`)
console.log(JSON.stringify(measured, null, 2))

/* THE PICTURE IS OF THE WRONG SCREEN, and the exit code has to say so. Written
 * first and deliberately: it is the evidence for what went wrong, and deleting
 * it would leave the reader with a number and nothing to look at. */
if (missed !== null) {
  console.error(
    `shot-client: ${missed}.\n` +
      `  ${options.file} was written, but it is NOT the screen that was asked for.`,
  )
  process.exit(5)
}
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) on the page:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
