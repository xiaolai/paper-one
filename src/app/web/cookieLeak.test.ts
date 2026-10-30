import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The client CANNOT leak what it cannot read.
 *
 * `HttpOnly` already puts the shelf's cookie out of reach of page script, so
 * this is belt and braces — but it is the assertion that survives somebody
 * deciding to "just read the cookie to check whether we're signed in". The
 * honest way to ask that question is `/api/auth/session`, which is what
 * `session.ts` does, and it works precisely because the browser attaches the
 * credential without the page ever seeing it.
 *
 * ## Why the roots are written down instead of derived
 *
 * This guard has now been narrowed twice by accident, both times silently.
 *
 * First it used `readdirSync` without recursion, so it covered
 * `src/app/web/*.ts` and stopped — `shell/` was outside it entirely.
 *
 * Then it lived in the transport's own test file and took its root from
 * `import.meta.url`. When the transport moved to `src/kernel/core/` in
 * WI-11.7 the scan would have followed it and quietly started covering the
 * kernel instead of the client: the same number of green checks, over a
 * different subject, with the comment above still claiming the client cannot
 * leak the cookie.
 *
 * So the roots are NAMED, each one is asserted to exist and to contribute
 * files, and a root that stops matching fails loudly rather than shrinking.
 *
 * ## And a THIRD time, which is why the root is now `src/app`
 *
 * The named root was `src/app/web`, and the phone furniture the client mounts
 * — the tab bar, the bottom sheet, the Continue strip — moved OUT of it to
 * `src/app/shell/` when the native mobile shell came to mount the same pieces.
 * The guard did not shrink noisily; it simply stopped covering five modules
 * that still render inside a session-bearing origin. What caught it was the
 * recursion assertion below, on its way to being vacuous: `src/app/web/` had
 * become flat, so the one root with subdirectories in it no longer had any.
 *
 * Naming the PARENT fixes the mechanism rather than the instance. `src/app` is
 * a strict superset of both, it stays nested whatever moves between its
 * children, and a directory relocated inside it cannot narrow the scan again.
 * The extra files it sweeps — the composition roots, `bootApp.ts`, `boot.ts`,
 * `shutdown.ts` — are ones that must not read the cookie either.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Everything this guard covers. Every application shell — the browser client,
 * the shared mobile furniture it mounts, and the composition roots beside them
 * — plus the transport they use, which is not inside any of them.
 */
const ROOTS = ['src/app', 'src/kernel/core/shelfChannel.ts']

function sources(at: string): string[] {
  const full = join(REPO, at)
  if (statSync(full).isFile()) return [full]
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const path = join(full, entry.name)
    if (entry.isDirectory()) return sources(relative(REPO, path))
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
  })
}

describe('the session cookie', () => {
  it.each(ROOTS)('%s is a root this guard can actually see', (root) => {
    expect(existsSync(join(REPO, root)), `${root} is gone — this guard is covering nothing`).toBe(true)
    expect(sources(root).length, `${root} contributed no files to the scan`).toBeGreaterThan(0)
  })

  /* A WALK THAT NEVER RECURSED looks exactly like one that did.
     ⚠️ **DERIVED FROM `ROOTS`, NOT FROM A REPEATED LITERAL.** The first version
     of this assertion scanned `src/app` by name, so narrowing `ROOTS` back to
     `src/app/web` left it green over a scan that no longer covered the shell —
     the check and the thing it checks have to be the same value or the check
     is decoration. Caught by mutation, which is the only way this shows up. */
  it('reaches below the top of a named root', () => {
    const nested = ROOTS.filter((root) => statSync(join(REPO, root)).isDirectory()).some((root) =>
      sources(root).some((at) => relative(join(REPO, root), at).includes(sep)),
    )
    expect(nested, 'the scan never left a root\'s top directory; a nested module is not covered').toBe(true)
  })

  /* AND IT REACHES THE SHELL SPECIFICALLY. The check above proves the walk
     descends somewhere; this proves it descends into the directory whose
     departure from `src/app/web/` narrowed this guard a third time. Named, so
     moving it again fails here rather than quietly halving the scan. */
  it('covers the shared mobile shell, which the client mounts', () => {
    const covered = ROOTS.flatMap(sources).map((at) => relative(REPO, at))
    const inShell = covered.filter((at) => at.startsWith(join('src', 'app', 'shell') + sep))
    expect(
      inShell.length,
      'src/app/shell contributed no files; the furniture the client mounts is unscanned',
    ).toBeGreaterThan(0)
  })

  it('is never read by page script, anywhere either root covers', () => {
    const files = ROOTS.flatMap(sources)
    expect(files.length).toBeGreaterThan(3)
    for (const at of files) {
      expect(readFileSync(at, 'utf8'), `${relative(REPO, at)} must not read the session cookie`).not.toContain(
        'document.cookie',
      )
    }
  })
})
