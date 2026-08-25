#!/usr/bin/env node
/**
 * Does the shipped Content Security Policy actually stop a book's JavaScript?
 *
 * `rendererIsolation.test.ts` asserts the policy's SHAPE — that `script-src` is
 * exactly `'self'`, that nothing has grown `blob:`. This asks a real engine what
 * that shape DOES, which is a different question and the one that matters.
 *
 * It exists because foliate-js's own README makes the instruction and not the
 * proof: "Do NOT use this library (or any other e-book library, for that
 * matter) without CSP unless you completely trust the content you're rendering."
 * The library cannot support scripted EPUBs "securely due to the content being
 * served from the same origin (using `blob:` URLs)", and WebKit bug 218086
 * forces `allow-scripts` on the iframe, "which renders iframe sandbox useless".
 *
 * So the sandbox attribute is not the boundary here. The CSP is. This measures
 * whether it holds, in the engine Paper ships on and the one a phone runs.
 *
 * ## What it does
 *
 * Serves a page under a policy, has that page build a book the way foliate does
 * — an object URL in an iframe carrying `allow-same-origin allow-scripts` — and
 * reports whether the book's script ran. Two routes, because a book has two:
 * an inline `<script>`, and a `<script src>` pointing at another object URL,
 * which is what every book resource becomes.
 *
 * ## Read the control, not just the verdict
 *
 * A probe that reports "blocked" because it is broken looks exactly like a
 * policy that works. So the host page's own same-origin script sets the
 * baseline, and `--loose` re-runs the whole thing under a deliberately widened
 * policy: if the widened run does not report RAN, the probe proved nothing and
 * the strict run should be disbelieved.
 *
 * Usage:  node scripts/csp-effect.mjs [--loose]
 * Exit 0 when the strict policy blocks both routes and the loose one allows
 * them; 1 on any other combination, including a probe that cannot fail.
 */

import { createServer } from 'node:http'
import { chromium, webkit } from '@playwright/test'

/** The policy under test, in the shape both of Paper's real ones take. */
const STRICT = "default-src 'self'; script-src 'self'; style-src 'self' blob:; img-src 'self' blob: data:; frame-src 'self' blob:"
/** The same policy with the two additions that would open the boundary. */
const LOOSE = STRICT.replace("script-src 'self'", "script-src 'self' blob: 'unsafe-inline'")

const PAGE = `<!doctype html><html><body><p id="verdict">nothing yet</p><script src="/host.js"></script></body></html>`

/* THE HOST'S OWN SCRIPT IS THE CONTROL. It is same-origin, so `'self'` permits
 * it; if it does not run, the run below says nothing about books. */
const HOST_JS = `
const results = { host: 'ran', inline: 'blocked', external: 'blocked' }
const show = () => {
  document.getElementById('verdict').textContent =
    'host=' + results.host + ' inline=' + results.inline + ' external=' + results.external
}
window.ran = (which) => { results[which] = 'RAN'; show() }
show()
const helper = URL.createObjectURL(new Blob(['parent.ran && parent.ran("external")'], { type: 'text/javascript' }))
const book = \`<!doctype html><html><body><p>a book</p>
<script>parent.ran && parent.ran('inline')<\\/script>
<script src="\${helper}"><\\/script>
</body></html>\`
const frame = document.createElement('iframe')
/* EXACTLY WHAT FOLIATE DOES - see its paginator and fixed-layout renderers.
 * The sandbox attribute is present and, carrying allow-same-origin with
 * allow-scripts, buys nothing; that is the point being measured. */
frame.setAttribute('sandbox', 'allow-same-origin allow-scripts')
frame.src = URL.createObjectURL(new Blob([book], { type: 'text/html' }))
document.body.append(frame)
`

async function measure(policy) {
  const server = createServer((request, response) => {
    const headers = { 'content-security-policy': policy }
    const js = request.url === '/host.js'
    response.writeHead(200, {
      ...headers,
      'content-type': js ? 'text/javascript' : 'text/html',
    })
    response.end(js ? HOST_JS : PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  const seen = {}
  for (const [name, engine] of [['WebKit', webkit], ['Chromium', chromium]]) {
    let browser
    try {
      browser = await engine.launch()
    } catch {
      console.log(`  ${name.padEnd(9)} (not installed — skipped)`)
      continue
    }
    const page = await browser.newPage()
    await page.goto(origin)
    await page.waitForTimeout(1200)
    const verdict = await page.textContent('#verdict')
    console.log(`  ${name.padEnd(9)} ${verdict}`)
    seen[name] = verdict
    await browser.close()
  }
  server.close()
  return seen
}

console.log('strict — the policy Paper serves:')
const strict = await measure(STRICT)
console.log('loose — script-src widened, to prove this probe can fail:')
const loose = await measure(LOOSE)

const engines = Object.keys(strict)
if (engines.length === 0) {
  console.error('\nNo browser engine was available. Run `npx playwright install webkit`.')
  process.exit(1)
}

let ok = true
for (const engine of engines) {
  const blocked = /host=ran/.test(strict[engine]) && !/RAN/.test(strict[engine].replace('host=ran', ''))
  const allowed = /inline=RAN/.test(loose[engine] ?? '') && /external=RAN/.test(loose[engine] ?? '')
  if (!blocked) {
    console.error(`\n${engine}: a book's script RAN under the shipped policy. The boundary is open.`)
    ok = false
  }
  if (!allowed) {
    console.error(`\n${engine}: the widened policy did not run the script either — this probe cannot fail, so its "blocked" above means nothing.`)
    ok = false
  }
}
console.log(ok ? '\ncsp-effect: the shipped policy blocks a book’s script; the probe can fail.' : '')
process.exit(ok ? 0 : 1)
