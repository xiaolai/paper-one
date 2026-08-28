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

/**
 * The directives of one policy, by name.
 *
 * ⚠️ **THE FIRST OCCURRENCE WINS, AND THIS USED TO KEEP THE LAST.** CSP says a
 * repeated directive name is ignored after the first, so a browser handed
 * `script-src *; script-src 'self'` runs anything — while a parser that
 * overwrote as it went would report `'self'` and every assertion below would
 * pass. That is a policy this test would call safe and a browser would not.
 *
 * A duplicate is refused outright rather than silently resolved. Both policies
 * here are authored by hand in one place each; a repeat is a mistake, and the
 * honest thing to do with a mistake in a security boundary is stop.
 */
function directives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (!name) continue
    if (name in out) {
      throw new Error(
        `duplicate CSP directive ${name}: a browser honours the FIRST and ignores the rest, ` +
          'so the two spellings cannot both be what this policy means',
      )
    }
    out[name] = values
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
    for (const [name, policy] of BOUNDARY_POLICIES) {
      const d = directives(policy ?? '')
      expect(d['frame-src'], `${name}: book documents are blob URLs`).toContain('blob:')
      /* AND NOTHING THE CLIENT ITSELF SERVES. Asserted as an exact set, like
       * `script-src`, because `'self'` sat here for a phase and was a route a
       * book had into the real client: a blob document inherits this policy,
       * so a book framing the client loaded it — module running, cookie
       * attached to its socket — under the book's own markup. Nothing Paper
       * serves is legitimately framed by a book.
       *
       * ⚠️ **THE URL HAS TO BE ABSOLUTE, and this comment used to say
       * `<iframe src="/">`.** It cannot: a `blob:` URL has an opaque path, and
       * the WHATWG parser refuses every relative reference against one but a
       * fragment — so that markup resolves to nothing and frames `about:blank`.
       * The hostile fixture's static probe was written from this same wrong
       * belief and tested nothing for a while (round 3, `make-hostile-epub.py`).
       * The script half always used `location.origin + '/'`, which is why the
       * vector is real and why the assertion below is right; only the example
       * was wrong. A book that wants the client writes the origin out.
       *
       * AND ONLY `blob:`. `data:` sat beside it from the policy's first draft
       * with no consumer — nothing under `src/` and nothing in the pinned
       * fork frames a `data:` URL — and a frame source no document of ours
       * needs is one a book's markup may use. The plan's acceptance for
       * WI-20.39 is `["blob:"]`; this is that sentence, held. */
      expect(d['frame-src'], `${name}: a book frames blob documents and nothing else`).toEqual(['blob:'])
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
   * THE SERVED POLICY NOW LETS A BOOK RENDER, and this is the ratchet that was
   * here paying off rather than a rule being relaxed.
   *
   * It used to assert the exact SHORTFALL — `worker-src blob:`, `style-src
   * blob:`, `font-src blob:` all absent — because the browser build had no
   * reading surface and least privilege says a policy should not permit what
   * nothing uses. The reading surface landed, that test failed, and naming the
   * three directives is what it was for: without them nothing fails loudly, the
   * book renders unstyled in a fallback face with no pictures and a PDF does not
   * render at all, which reads as a bad book rather than as our policy.
   *
   * The served policy is folded into `still permits what a book legitimately
   * needs` above, so it is now held to the same standard as the other two
   * rather than to a list of its own.
   *
   * WHAT DID NOT MOVE IS `script-src`, and that is the whole argument. It is
   * asserted as an exact set three tests up, for all three policies, and
   * `scripts/csp-effect.mjs` measures what that shape DOES: in WebKit and
   * Chromium a book's script does not run — neither inline nor from an object
   * URL, which is what every book resource becomes.
   */
  it('lets the web host serve a book without letting it run code', () => {
    const served = directives(SERVED)
    const shipped = directives(config.app.security?.csp ?? '')

    /**
     * THE TWO POLICIES AGREE, DIRECTIVE FOR DIRECTIVE, except where they are
     * deliberately different — and the exceptions are named here rather than
     * being whatever the diff happens to be.
     *
     * THIS IS THE THIRD VERSION OF THIS ASSERTION AND THE FIRST HONEST ONE.
     * The first looked for `blob:` in three directives; the served policy was
     * also missing `'unsafe-inline'` on `style-src`, so the client rendered
     * unstyled. The second compared five named directives; the served policy
     * also had `frame-ancestors 'none'`, which a blob document INHERITS — so
     * the book's own frame had no permitted ancestor and would not load at all,
     * and `media-src` was absent so a book with audio would have failed later.
     *
     * Both were found by looking at the page. A check that compares only what
     * somebody thought to list cannot find what they did not, and the list gets
     * shorter than the policy every time the policy grows. So this compares
     * every directive in EITHER policy, and a new one has to be classified
     * deliberately — as shared, or as a named difference.
     */
    /**
     * ⚠️ EACH EXCEPTION NAMES WHAT THE SERVED POLICY MUST BE, not merely that
     * it differs.
     *
     * This was a map of directive to REASON, and the only assertion made about
     * an exempt directive was that it was not equal to the desktop's. So
     * `connect-src *`, `base-uri *` or `frame-ancestors *` would all have
     * passed — each of them differs from the desktop, which was the entire
     * test. An exemption list that says "this one is allowed to be anything"
     * is the shape of hole worth closing in a policy comparison.
     */
    const DELIBERATELY_DIFFERENT: Readonly<Record<string, readonly string[]>> = {
      /* Tauri's own IPC origin, which does not exist in a browser. The browser
         talks to its own shelf and nowhere else — including the book's frame,
         which inherits this. */
      'connect-src': ["'self'"],
      /* The served page is stricter, and can afford to be: it has no base tag. */
      'base-uri': ["'none'"],
      /* The desktop is a window, not a frame, so it has no ancestors to refuse.
         The served page is reachable over the network and does — but `'self'`
         rather than `'none'`, because a book's blob frame inherits this. */
      'frame-ancestors': ["'self'"],
    }

    const everything = [...new Set([...Object.keys(shipped), ...Object.keys(served)])].sort()
    /* NOT EMPTY, and not one. A parse that silently yielded nothing would make
       every comparison below vacuous. */
    expect(everything.length).toBeGreaterThan(8)

    for (const directive of everything) {
      if (directive in DELIBERATELY_DIFFERENT) continue
      expect(
        new Set(served[directive] ?? []),
        `${directive}: the served policy must match the desktop's, or be listed as deliberately different`,
      ).toEqual(new Set(shipped[directive] ?? []))
    }

    /* AND EACH NAMED DIFFERENCE IS THE VALUE IT IS SUPPOSED TO BE. */
    for (const [directive, expected] of Object.entries(DELIBERATELY_DIFFERENT)) {
      expect(
        served[directive] ?? [],
        `${directive}: the served policy is exempt from matching the desktop, which makes this \
the ONLY thing asserting what it actually is`,
      ).toEqual([...expected])
      /* AND IT STILL DIFFERS. An exemption that stopped being needed is one
         sitting there ready to hide the next real difference in the same
         directive. */
      expect(
        new Set(served[directive] ?? []),
        `${directive} no longer differs from the desktop — remove it from the list`,
      ).not.toEqual(new Set(shipped[directive] ?? []))
    }
    /* THE BOUNDARY IS NOT PART OF WHAT WAS WIDENED. Asserted here as well as
     * above, because here is where somebody relaxing the policy for a book is
     * actually looking. */
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
