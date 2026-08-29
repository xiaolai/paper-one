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
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Everything this guard covers. The browser client whole, plus the transport
 * it uses — which is no longer inside it.
 */
const ROOTS = ['src/app/web', 'src/kernel/core/shelfChannel.ts']

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

  /* A WALK THAT NEVER RECURSED looks exactly like one that did. The client is
     the root with subdirectories in it, so it is the one that can prove it. */
  it('reaches below the top of the browser client', () => {
    const root = join(REPO, 'src/app/web')
    expect(
      sources('src/app/web').some((at) => relative(root, at).includes(sep)),
      'the scan never left the top directory; a nested module is not covered',
    ).toBe(true)
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
