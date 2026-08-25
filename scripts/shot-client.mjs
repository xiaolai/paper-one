#!/usr/bin/env node
/**
 * A picture of the browser client, from the engine it actually ships against.
 *
 * `node scripts/shot-client.mjs [out.png] [--path /] [--width 390] [--height 844]`
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

const ORIGIN = 'http://127.0.0.1:27182'
/* An iPhone 15's CSS viewport. A desktop window would flatter a layout whose
 * whole point is the phone — the design's own note is that on mobile
 * "adjacency becomes sequence". */
const DEFAULT = { width: 393, height: 852 }

function parse(argv) {
  const out = { file: 'dev-docs/artifacts/client.png', path: '/', ...DEFAULT, dark: false, code: null }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--path') out.path = argv[++i] ?? '/'
    else if (arg === '--width') out.width = Number(argv[++i])
    else if (arg === '--height') out.height = Number(argv[++i])
    else if (arg === '--dark') out.dark = true
    else if (arg === '--code') out.code = argv[++i]
    else rest.push(arg)
  }
  if (rest[0] !== undefined) out.file = rest[0]
  return out
}

const options = parse(process.argv.slice(2))

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
  viewport: { width: options.width, height: options.height },
  colorScheme: options.dark ? 'dark' : 'light',
})
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
 * ⚠️ **THIS CANNOT PHOTOGRAPH A CONNECTED STATE OVER PLAIN HTTP**, and the
 * reason is not this script's. Measured 2026-08-25: WebKit stores the `Secure`
 * session cookie from `http://127.0.0.1` and then refuses to SEND it, so the
 * code is accepted, the cookie is in the jar, and every page fetch is still
 * 401. Every screen behind the six digits needs a TLS origin to reach.
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
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) on the page:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
