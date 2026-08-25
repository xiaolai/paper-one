import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The property that stands between a shared book and Paper's native layer.
 *
 * An EPUB is a zip of HTML, and foliate renders it in an iframe carrying
 * `allow-same-origin allow-scripts` (`paginator.js`, `fixed-layout.js`). That
 * puts book JavaScript in the application's own origin. The only thing stopping
 * it from running at all is the Content Security Policy — so the policy is not a
 * hardening detail here, it is the boundary.
 *
 * This asserts the SHIPPED configuration, from the file the Rust build reads.
 * There is no way to write a unit test for "a malicious EPUB cannot call
 * plugin:fs" — that needs the app, a real WebKit and a real book, and it lives
 * in `scripts/make-hostile-epub.py`. What a unit test CAN do is refuse the
 * regressions that would silently reopen the hole: someone adding
 * `'unsafe-inline'` to make a stylesheet work, or turning the policy off while
 * debugging and not turning it back on.
 *
 * Both are one-line edits to a JSON file nobody reads twice.
 */

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
) as {
  app: {
    withGlobalTauri?: boolean
    security?: { csp?: string | null; devCsp?: string | null }
  }
}

/** The directives of one policy, by name. */
function directives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out[name] = values
  }
  return out
}

/**
 * The policy the WEB HOST serves, read from the Rust source that serves it.
 *
 * ⚠️ THIS TEST WAS STRUCTURALLY BLIND TO THE BROWSER BUILD. Everything above
 * reads `tauri.conf.json` — a file a browser build never opens. The web host
 * sends headers of its own, and until this was added nothing asserted them:
 * the boundary existed, the test protecting it could not see the new target,
 * and it stayed green either way.
 *
 * Parsed out of `lib.rs` rather than copied here, because a copy is a second
 * policy that agrees with the first until somebody edits one. Rust's `\` line
 * continuation eats the newline and the indent that follows it, so the join
 * below reproduces exactly the string the compiler builds.
 */
function servedPolicy(): string {
  const source = readFileSync(
    fileURLToPath(new URL('../../../src-tauri/crates/paper-webhost/src/lib.rs', import.meta.url)),
    'utf8',
  )
  const at = source.indexOf('pub const CONTENT_SECURITY_POLICY')
  if (at < 0) throw new Error('CONTENT_SECURITY_POLICY is gone from paper-webhost — this test cannot see the policy')
  const opened = source.indexOf('"', at)
  const closed = source.indexOf('";', opened + 1)
  if (opened < 0 || closed < 0) throw new Error('CONTENT_SECURITY_POLICY is no longer a plain string literal')
  return source.slice(opened + 1, closed).replace(/\\\s*\n\s*/g, '')
}

const SERVED = servedPolicy()

const POLICIES: [string, string | null | undefined][] = [
  ['csp', config.app.security?.csp],
  ['devCsp', config.app.security?.devCsp],
]

/** Every policy whose job is to stand between a book and this origin. */
const BOUNDARY_POLICIES: [string, string | null | undefined][] = [
  ...POLICIES,
  ['webhost', SERVED],
]

describe('the shipped Content Security Policy', () => {
  it('exists at all', () => {
    for (const [name, policy] of BOUNDARY_POLICIES) {
      expect(policy, `${name} must be set — foliate's own README says not to run without one`)
        .toBeTruthy()
    }
  })

  /* The regression that matters most. `script-src 'self'` is what stops an
   * EPUB's inline <script> from executing; `'unsafe-inline'` there would hand
   * every shared book the run of the application's origin. */
  it('never allows inline or evaluated script', () => {
    for (const [name, policy] of BOUNDARY_POLICIES) {
      const scriptSrc = directives(policy ?? '')['script-src']
      expect(scriptSrc, `${name} must name script-src explicitly`).toBeDefined()
      expect(scriptSrc, `${name} script-src must not allow inline`).not.toContain("'unsafe-inline'")
      expect(scriptSrc, `${name} script-src must not allow eval`).not.toContain("'unsafe-eval'")
      expect(scriptSrc).toContain("'self'")
    }
  })

  /* A missing default-src means every directive not listed falls back to "any",
   * which makes the listed ones a decoration. */
  it('closes what it does not name', () => {
    for (const [name, policy] of BOUNDARY_POLICIES) {
      const d = directives(policy ?? '')
      expect(d['default-src'], `${name} needs a default-src`).toEqual(["'self'"])
      expect(d['object-src'], `${name} should refuse plugins outright`).toEqual(["'none'"])
    }
  })

  /* Book documents arrive as blob URLs, and foliate rewrites a book's
   * stylesheets and embedded fonts to object URLs too. A policy that forgets
   * these does not fail loudly — the book renders unstyled, in a fallback face,
   * with no pictures, which reads as a bad EPUB rather than as our mistake. */
  it('still permits what a book legitimately needs', () => {
    for (const [name, policy] of POLICIES) {
      const d = directives(policy ?? '')
      expect(d['frame-src'], `${name}: book documents are blob URLs`).toContain('blob:')
      expect(d['img-src'], `${name}: book images are blobs`).toContain('blob:')
      expect(d['img-src'], `${name}: and sometimes data URLs`).toContain('data:')
      expect(d['worker-src'], `${name}: pdf.js runs in a worker`).toContain('blob:')
      expect(d['style-src'], `${name}: foliate rewrites book CSS to a blob`).toContain('blob:')
      expect(d['font-src'], `${name}: and embedded fonts with it`).toContain('blob:')
    }
  })

  /* Asserted as an EXACT set, not with `toContain`.
   *
   * `script-src` is the boundary, and a shape check passes on a policy that has
   * quietly grown a scheme. `script-src 'self' blob:` in particular would look
   * fine to every other assertion in this file while letting a book run script
   * from an object URL — which is precisely how a book's own resources arrive. */
  it('lets script come from exactly one place', () => {
    for (const [name, policy] of BOUNDARY_POLICIES) {
      expect(directives(policy ?? '')['script-src'], `${name}`).toEqual(["'self'"])
    }
  })

  /**
   * WHAT THE WEB HOST'S POLICY DOES NOT YET ALLOW — asserted, so it cannot be
   * discovered as "a bad EPUB".
   *
   * The test above this one is the reason it matters: a policy that forgets
   * these "does not fail loudly — the book renders unstyled, in a fallback
   * face, with no pictures". The browser build has no reading surface yet, so
   * nothing is broken today and the missing directives are correctly ABSENT:
   * least privilege means a policy does not permit what nothing uses.
   *
   * But the day a reader is mounted there, three directives have to arrive
   * with it, and the failure if they do not is silent and misattributed. So
   * the shortfall is written down as an exact set rather than as prose in a
   * plan nobody re-reads.
   *
   * WHEN THE READING SURFACE LANDS this test fails, and the fix is to widen
   * the served policy exactly as the desktop one already is and to empty this
   * list — deliberately, in the same change. It is a ratchet, not a change
   * detector: the desktop policy is the reference, and `script-src` is not
   * part of any of it.
   */
  it('names precisely what the web host will need before it can serve a book', () => {
    const served = directives(SERVED)
    const missing: string[] = []
    if (!(served['worker-src'] ?? []).includes('blob:')) missing.push('worker-src blob:')
    if (!(served['style-src'] ?? []).includes('blob:')) missing.push('style-src blob:')
    if (!(served['font-src'] ?? []).includes('blob:')) missing.push('font-src blob:')

    expect(missing).toEqual(['worker-src blob:', 'style-src blob:', 'font-src blob:'])

    /* AND THE BOUNDARY IS NOT PART OF THE SHORTFALL. Widening the three above
     * is routine; widening this one is the hole the whole file exists to
     * refuse, so it is asserted here too — where somebody relaxing the policy
     * for a book is actually looking. */
    expect(served['script-src']).toEqual(["'self'"])
  })

  /* Development needs the Vite HMR socket; the shipped policy must not. */
  it('keeps the development allowances out of the shipped policy', () => {
    const shipped = config.app.security?.csp ?? ''
    expect(shipped).not.toContain('ws://')
    expect(shipped).not.toContain('localhost:14201')
    expect(config.app.security?.devCsp ?? '').toContain('ws://localhost:14201')
  })
})

describe('the global Tauri object', () => {
  /* `withGlobalTauri` attaches `window.__TAURI__` to the page — and therefore,
   * through `parent`, to every book. It exists for the MCP test bridge, which is
   * compiled out of release builds, so the base configuration must not carry it
   * and a plain `tauri build` must not be able to ship it. Development opts in
   * through `src-tauri/tauri.dev.conf.json`. */
  it('is off in the configuration a build reads', () => {
    expect(config.app.withGlobalTauri ?? false).toBe(false)
  })

  it('is turned back on only by the development override', () => {
    const dev = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../src-tauri/tauri.dev.conf.json', import.meta.url)),
        'utf8',
      ),
    ) as { app?: { withGlobalTauri?: boolean } }
    expect(dev.app?.withGlobalTauri).toBe(true)

    // And the script that applies it, so the override is not an orphan file.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string> }
    const applies = Object.values(pkg.scripts).some((s) => s.includes('tauri.dev.conf.json'))
    expect(applies, 'no script applies the dev config override').toBe(true)
  })
})
