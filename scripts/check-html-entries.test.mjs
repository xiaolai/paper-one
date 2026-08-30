import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * EVERY HTML ENTRY'S SCRIPT IS IN THE TYPESCRIPT PROJECT.
 *
 * ## Why this exists
 *
 * `tsconfig.app.json` lists its entries by hand in `files`, because each one is
 * a composition root that nothing else imports — so nothing pulls it into the
 * project graph, and an entry left out of that list is simply never typechecked.
 *
 * **That has happened twice.** `src/main.web.tsx` shipped unchecked with a real
 * error in it, and the comment written above `files` afterwards — which says
 * exactly this, at length — did not stop `src/main.mobile.tsx` going in the
 * same way months later. A comment is not a gate.
 *
 * The failure is invisible from every direction that normally catches things:
 * the bundler is happy (Vite transpiles without checking types), the app runs,
 * the tests pass, and `pnpm typecheck` prints its usual clean line. Measured
 * rather than argued: `const x: number = 'nope'` appended to the mobile entry
 * passed `pnpm typecheck` with no output at all.
 *
 * ## Why it derives the list instead of restating it
 *
 * A second hand-written list of entries would be the same defect wearing a
 * different hat — it could be forgotten in exactly the same way. The HTML files
 * ARE the definition of what an entry is: Vite builds what `index*.html` points
 * at, so this reads the `<script type="module" src=...>` out of each one and
 * requires that path to be in `files`. Adding an entry to the bundler now
 * fails here until the project is told about it too.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** Every `index*.html` at the repository root — Vite's entry documents. */
function entryDocuments() {
  return readdirSync(REPO).filter((name) => /^index[.\w-]*\.html$/.test(name))
}

/** The module script an entry document loads, repository-relative. */
function scriptOf(document) {
  const html = readFileSync(join(REPO, document), 'utf8')
  const found = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)
  return found?.[1]?.replace(/^\//, '') ?? null
}

/** `tsconfig.app.json` is JSONC — it carries the comment this test is about. */
function projectFiles() {
  const raw = readFileSync(join(REPO, 'tsconfig.app.json'), 'utf8')
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(stripped).files
}

describe('every HTML entry is typechecked', () => {
  const documents = entryDocuments()

  /* THE SCAN ITSELF FIRST. A glob that matched nothing would make every case
     below vacuously true, which is the shape of the bug this file exists for. */
  it('finds the entry documents at all', () => {
    expect(documents.length, 'no index*.html found — this gate is checking nothing').toBeGreaterThan(1)
  })

  it.each(documents)('%s loads a module script', (document) => {
    expect(scriptOf(document), `${document} has no <script type="module" src=...>`).not.toBeNull()
  })

  it.each(documents)("%s's script is in tsconfig.app.json files", (document) => {
    const script = scriptOf(document)
    expect(projectFiles(), `${script} is bundled by ${document} but never typechecked`).toContain(script)
  })
})
