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
 * reports what the book reached. THREE routes, because a book has three: an
 * inline `<script>`, a `<script src>` pointing at another object URL (what
 * every book resource becomes), and an `<iframe src="/">` — the one route
 * that needs no script at all, which frames the real client under the book.
 *
 * ## Read the control, not just the verdict
 *
 * A probe that reports "blocked" because it is broken looks exactly like a
 * policy that works. So the host page's own same-origin script sets the
 * baseline, and the whole thing is ALSO run under a deliberately widened
 * policy (`script-src` opened to blob and inline, `frame-src` given `'self'`
 * back): if that loose run does not report RAN on every route, the probe
 * proved nothing and the strict run should be disbelieved.
 *
 * Usage:  node scripts/csp-effect.mjs   (no arguments; both policies always run)
 * Exit 0 when the strict policy blocks all three routes and the loose one
 * allows them; 1 on any other combination, including a probe that cannot fail;
 * 2 when the served policy has nothing to widen.
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from '@playwright/test'

/**
 * THE POLICY PAPER ACTUALLY SERVES, read from the Rust that serves it.
 *
 * ⚠️ This was a hand-written approximation — `"default-src 'self'; script-src
 * 'self'; style-src 'self' blob:; …"` — described in the header as "the shape
 * both of Paper's real ones take". A shape is not a policy. The served one had
 * already grown `media-src`, `font-src`, `worker-src`, `object-src`,
 * `base-uri`, `form-action` and `frame-ancestors`, and `frame-src` had gained
 * `data:`; none of that was under test. The one claim this whole script exists
 * to support — "a book's script does not run" — was measured against a string
 * that no browser is ever sent.
 *
 * Parsed out of `lib.rs` the same way `rendererIsolation.test.ts` does, and for
 * the same reason: a copy is a second policy that agrees with the first until
 * somebody edits one. Rust's `\` line continuation eats the newline and the
 * following indent, so the join reproduces exactly what the compiler builds.
 */
function servedPolicy() {
  const source = readFileSync(
    fileURLToPath(new URL('../src-tauri/crates/paper-webhost/src/lib.rs', import.meta.url)),
    'utf8',
  )
  const at = source.indexOf('pub const CONTENT_SECURITY_POLICY: &str =')
  if (at === -1) throw new Error('csp-effect: CONTENT_SECURITY_POLICY is gone from paper-webhost')
  /* Resolve both quote positions and require them ordered before slicing. If
   * the Rust constant ever changes form, `indexOf('"') + 1` and
   * `indexOf('";')` could cross or go missing and slice unrelated source into
   * a policy string — a MISLEADING policy tested green is worse than a loud
   * failure to parse. */
  const open = source.indexOf('"', at)
  const close = source.indexOf('";', open + 1)
  if (open === -1 || close === -1 || close <= open) {
    throw new Error('csp-effect: CONTENT_SECURITY_POLICY is not a quoted string literal where expected')
  }
  const literal = source.slice(open + 1, close)
  const policy = literal
    .split('\\\n')
    .map((line) => line.trim())
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!policy.includes('script-src')) {
    throw new Error(`csp-effect: could not parse the served policy (got ${JSON.stringify(policy)})`)
  }
  return policy
}

/** The policy under test — the real one. */
const STRICT = servedPolicy()
/** The same policy with the three additions that would open the boundary:
 *  script from a blob or inline, and `'self'` back in `frame-src` — the one
 *  route that needs no script at all. */
const LOOSE = STRICT.replace("script-src 'self'", "script-src 'self' blob: 'unsafe-inline'").replace(
  'frame-src blob:',
  "frame-src 'self' blob:",
)
if (LOOSE === STRICT || !LOOSE.includes("frame-src 'self'")) {
  console.error('csp-effect: the served policy has no `script-src \'self\'` or `frame-src blob:` to widen — refusing to run a probe that cannot fail.')
  process.exit(2)
}

const PAGE = `<!doctype html><html><body><p id="verdict">nothing yet</p><script src="/host.js"></script></body></html>`

/* THE HOST'S OWN SCRIPT IS THE CONTROL. It is same-origin, so `'self'` permits
 * it; if it does not run, the run below says nothing about books. */
const HOST_JS = `
/* THE THIRD ROUTE NEEDS NO SCRIPT IN THE BOOK. If this page is running INSIDE
 * a frame, the book framed the client: the real module, the real cookie on
 * its socket, under the book's own markup. Report to the top and stop, or
 * the nested client would frame a book that frames a client, forever. */
if (window !== window.top) { window.top.ran && window.top.ran('framed'); throw new Error('nested client: reported, not booting') }
const results = { host: 'ran', inline: 'blocked', external: 'blocked', framed: 'blocked' }
const show = () => {
  document.getElementById('verdict').textContent =
    'host=' + results.host + ' inline=' + results.inline + ' external=' + results.external + ' framed=' + results.framed
}
window.ran = (which) => { results[which] = 'RAN'; show() }
show()
const helper = URL.createObjectURL(new Blob(['parent.ran && parent.ran("external")'], { type: 'text/javascript' }))
const book = \`<!doctype html><html><body><p>a book</p>
<script>parent.ran && parent.ran('inline')<\\/script>
<script src="\${helper}"><\\/script>
<iframe src="\${location.origin}/"></iframe>
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
  /* Reject on a bind failure instead of crashing with a raw `error` event: a
   * port that will not bind is a normal thing to report, not a stack trace. */
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const origin = `http://127.0.0.1:${server.address().port}`

  const seen = {}
  for (const [name, engine] of ENGINES) {
    let browser
    try {
      browser = await engine.launch()
    } catch (cause) {
      /* ⚠️ WEBKIT IS NOT OPTIONAL. Every browser on iOS is WebKit whatever its
       * icon says, so it is the engine this client is actually served to — and
       * a missing install used to print "(skipped)" and let Chromium alone
       * decide the verdict. A green run that never tested the primary engine is
       * the failure this script exists to prevent, one level up. */
      if (name === 'WebKit') {
        console.error(
          `\n${name} could not launch: ${String(cause)}\n` +
            '  It is the engine every iOS browser uses, so a run without it proves nothing\n' +
            '  about the client this policy protects. Run `npx playwright install webkit`.',
        )
        process.exit(1)
      }
      /* ONLY A MISSING INSTALL IS "skipped". A crash, a missing system
       * library or a permission error used to read as "not installed" too,
       * quietly dropping the secondary engine from the verdict; those are
       * fatal, because they are a broken run, not an absent one. */
      if (/Executable doesn't exist|please run the following command|npx playwright install/i.test(String(cause))) {
        console.log(`  ${name.padEnd(9)} (not installed — skipped)`)
        continue
      }
      console.error(`\n${name} failed to launch (not a missing install): ${String(cause)}`)
      process.exit(1)
    }
    try {
      const page = await browser.newPage()
      await page.goto(origin)
      await page.waitForTimeout(1200)
      const verdict = await page.textContent('#verdict')
      console.log(`  ${name.padEnd(9)} ${verdict}`)
      seen[name] = verdict
    } finally {
      await browser.close()
    }
  }
  server.close()
  return seen
}

/** WebKit first, so its absence stops the run before Chromium can flatter it. */
const ENGINES = [
  ['WebKit', webkit],
  ['Chromium', chromium],
]

console.log(`strict — the policy Paper serves:\n  ${STRICT}`)
const strict = await measure(STRICT)
console.log('loose — script-src widened, to prove this probe can fail:')
const loose = await measure(LOOSE)

const engines = Object.keys(strict)
if (engines.length === 0) {
  console.error('\nNo browser engine was available. Run `npx playwright install webkit`.')
  process.exit(1)
}

let ok = true
/* AND WEBKIT WAS ONE OF THEM. The loop below only checks the engines that ran;
 * without this, a future skip path would make it vacuous again. */
if (!engines.includes('WebKit')) {
  console.error('\ncsp-effect: WebKit did not run. The primary engine is not optional.')
  ok = false
}
for (const engine of engines) {
  const blocked = /host=ran/.test(strict[engine]) && !/RAN/.test(strict[engine].replace('host=ran', ''))
  const allowed = /inline=RAN/.test(loose[engine] ?? '') && /external=RAN/.test(loose[engine] ?? '') && /framed=RAN/.test(loose[engine] ?? '')
  if (!blocked) {
    console.error(`\n${engine}: a book's script RAN, or a book FRAMED THE CLIENT, under the shipped policy. The boundary is open.`)
    ok = false
  }
  if (!allowed) {
    console.error(`\n${engine}: the widened policy did not run the script either — this probe cannot fail, so its "blocked" above means nothing.`)
    ok = false
  }
}
console.log(ok ? '\ncsp-effect: the shipped policy blocks a book’s script; the probe can fail.' : '')
process.exit(ok ? 0 : 1)
