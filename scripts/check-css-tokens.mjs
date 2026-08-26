#!/usr/bin/env node
/**
 * Every `var(--token)` resolves to a token something defines.
 *
 * # Why this exists
 *
 * **An undefined custom property is silent.** `color: var(--ink-muted)` where
 * nothing defines `--ink-muted` is not an error, not a warning, and not a
 * fallback — the declaration is simply dropped and the element inherits. There
 * is no console message and no visual cue beyond "that looks slightly wrong".
 *
 * The browser client's reading surface shipped with FIVE invented names —
 * `--rule`, `--type-ui`, `--ink-muted`, `--space-3`, `--surface-sunken` — so the
 * bar had no border, the title no size and no colour, the banner no background,
 * and no horizontal padding at all, which is why a book's title ran into the
 * edge of a phone. Found by reading on the phone; `check-dead-css` cannot see
 * it, because that asks whether a CLASS is reachable and this is about a VALUE.
 *
 * # What counts as defined
 *
 * A stylesheet declaration, OR a name written from code. **Most of this app's
 * geometry never appears in a stylesheet at all**: `metrics.ts` publishes
 * `--control-sm` and forty others onto the root, `Reader.tsx` writes the whole
 * track grid as an inline style object, `bookCss.ts` writes from a table,
 * `useAppPalette.ts` from a key list. A CSS-only view of "defined" called 23 of
 * its first 26 findings wrong — a check that noisy gets muted, and a muted
 * check is worse than none.
 *
 * So any `--name` appearing as a string literal in a `.ts`/`.tsx` file counts.
 * That is deliberately generous: it can MISS a bad name (if some unrelated file
 * happens to mention it) but it will not INVENT one. For a check whose whole
 * job is to be trusted when it does fire, a miss is the cheaper error. Comment
 * lines are skipped, so prose about a token does not vouch for it.
 *
 * ⚠️ **Tokens are packed several to a line.** `tokens.css` writes
 * `--ink:#17191B; --ink-2:#3D4348; --muted:#5F666C;` on one line, so a
 * line-anchored pattern finds the first and misses the rest — which produced a
 * ten-name false-positive list on the first run of this idea, five of them
 * real. Every declaration is matched, wherever it sits.
 *
 * # What it deliberately does not do
 *
 * A `var(--x, fallback)` with a fallback is still reported. A fallback makes the
 * declaration survive, but a name that resolves to nothing on every render is a
 * name nobody meant to write, and the fallback is then the only value there is.
 * If one is genuinely intended, define the token.
 *
 * Exit 0 when every reference resolves, 1 on a finding, 2 on a usage error.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-css-tokens.mjs [--root <dir>]'

/** Every file under `dir` whose name ends in one of `suffixes`, at any depth. */
export function filesUnder(root, dir, suffixes) {
  const out = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = path.join(rel, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (suffixes.some((s) => entry.name.endsWith(s))) out.push(child)
    }
  }
  walk(dir)
  return out.sort()
}

/** Every `.css` under `dir`, at any depth. */
export function stylesheets(root, dir = 'src') {
  return filesUnder(root, dir, ['.css'])
}

/**
 * Names a stylesheet DECLARES.
 *
 * Matches every `--name:` in the text rather than one per line — see the header
 * for what a line-anchored pattern misses.
 */
export function declaredIn(text) {
  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))
}

/** Names a stylesheet REFERENCES, with the line each appears on. */
export function referencedIn(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) out.push({ name: m[1], line: i + 1 })
  })
  return out
}

/**
 * Names a source file writes — an inline style key, a `setProperty` argument,
 * or an entry in a table of either.
 *
 * COMMENT LINES ARE SKIPPED. Prose describing a token is not a definition of
 * it, and counting it as one is how a stale doc-comment keeps a dead name
 * looking alive.
 */
export function writtenInCode(text) {
  const found = new Set()
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
    for (const m of line.matchAll(/['"`](--[a-z0-9-]+)['"`]/gi)) found.add(m[1])
  }
  return found
}

/** Every custom property this repo defines, from stylesheets and from code. */
export function definedIn(root) {
  const defined = new Set()
  for (const file of filesUnder(root, 'src', ['.ts', '.tsx'])) {
    for (const name of writtenInCode(readFileSync(path.join(root, file), 'utf8'))) defined.add(name)
  }
  return defined
}

export function checkCssTokens(root) {
  const files = stylesheets(root)
  const findings = []
  if (files.length === 0) {
    /* NOT A PASS. No stylesheets means the scan looked at the wrong tree, and
     * "every reference resolves" would be true and meaningless. */
    return {
      findings: [{ file: 'src', line: 0, name: '', message: 'no stylesheets found — is --root right?' }],
      files: 0,
      references: 0,
    }
  }

  const defined = definedIn(root)
  const texts = new Map()
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8')
    texts.set(file, text)
    for (const name of declaredIn(text)) defined.add(name)
  }

  let references = 0
  for (const [file, text] of texts) {
    for (const { name, line } of referencedIn(text)) {
      references += 1
      if (defined.has(name)) continue
      findings.push({
        file,
        line,
        name,
        message: `${name} is referenced but nothing defines it — the declaration is dropped silently`,
      })
    }
  }
  return { findings, files: files.length, references }
}

function main(argv) {
  let root = REPO_ROOT
  const at = argv.indexOf('--root')
  if (at !== -1) {
    if (argv[at + 1] === undefined) {
      console.error(USAGE)
      return 2
    }
    root = path.resolve(argv[at + 1])
  }
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory')
  } catch {
    console.error(`check-css-tokens: ${root} is not a directory`)
    return 2
  }

  const { findings, files, references } = checkCssTokens(root)
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.message}`)
  console.log(`check-css-tokens: ${files} stylesheets, ${references} references, ${findings.length} undefined`)
  if (findings.length > 0) {
    console.log(
      '\nAn undefined custom property is not an error and not a warning — the\n' +
        'declaration is dropped and the element inherits. Define the token, or\n' +
        'use the name the design system already has for it.',
    )
    return 1
  }
  return 0
}

if (isProcessEntry(import.meta)) process.exit(main(process.argv.slice(2)))
