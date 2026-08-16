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
  readFileSync(fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
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

const POLICIES: [string, string | null | undefined][] = [
  ['csp', config.app.security?.csp],
  ['devCsp', config.app.security?.devCsp],
]

describe('the shipped Content Security Policy', () => {
  it('exists at all', () => {
    for (const [name, policy] of POLICIES) {
      expect(policy, `${name} must be set — foliate's own README says not to run without one`)
        .toBeTruthy()
    }
  })

  /* The regression that matters most. `script-src 'self'` is what stops an
   * EPUB's inline <script> from executing; `'unsafe-inline'` there would hand
   * every shared book the run of the application's origin. */
  it('never allows inline or evaluated script', () => {
    for (const [name, policy] of POLICIES) {
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
    for (const [name, policy] of POLICIES) {
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
    for (const [name, policy] of POLICIES) {
      expect(directives(policy ?? '')['script-src'], `${name}`).toEqual(["'self'"])
    }
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
        fileURLToPath(new URL('../../src-tauri/tauri.dev.conf.json', import.meta.url)),
        'utf8',
      ),
    ) as { app?: { withGlobalTauri?: boolean } }
    expect(dev.app?.withGlobalTauri).toBe(true)

    // And the script that applies it, so the override is not an orphan file.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string> }
    const applies = Object.values(pkg.scripts).some((s) => s.includes('tauri.dev.conf.json'))
    expect(applies, 'no script applies the dev config override').toBe(true)
  })
})
