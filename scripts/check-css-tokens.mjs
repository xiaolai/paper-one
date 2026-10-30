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
 * A stylesheet with its comments blanked, LINE COUNT PRESERVED.
 *
 * ⚠️ **A COMMENTED-OUT DECLARATION WAS COUNTED AS A DECLARATION.**
 * `/* --missing: red *\/` matched `(--[a-z0-9-]+)\s*:` exactly as a live rule
 * does, so a token somebody had commented out went on satisfying every `var()`
 * that referenced it — and this gate, whose entire job is to catch a `var()`
 * that resolves to nothing, reported clean. The dead name looked alive because
 * its own gravestone was legible.
 *
 * Replaced with spaces rather than removed so `referencedIn`'s line numbers
 * still point at the right line.
 */
function withoutComments(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  /* AND LINE COMMENTS, for the TypeScript side. CSS has none, so this is inert
     there. NOT `\/\/.*$`: that eats the `//` in `https://` and takes the rest
     of the line with it — the same trap `check-browser-safe` recorded. The
     capture keeps the character before the marker. */
  const noLines = noBlocks.replace(/(^|[^:])\/\/[^\n]*/gm, (_all, before) => before)
  /* AND A BARE `*` CONTINUATION LINE. Inside a complete file the block pass
     above has already taken these, but the scan is also handed FRAGMENTS — a
     doc comment's middle, with no `/*` in sight — and a line that begins with
     `*` is prose in every file this repository has. */
  return noLines
    .split('\n')
    .map((line) => (line.trimStart().startsWith('*') ? '' : line))
    .join('\n')
}

/**
 * Names a stylesheet DECLARES.
 *
 * Matches every `--name:` in the text rather than one per line — see the header
 * for what a line-anchored pattern misses — and only outside a comment.
 */
export function declaredIn(text) {
  return new Set([...withoutComments(text).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))
}

/** Names a stylesheet REFERENCES, with the line each appears on. */
export function referencedIn(text) {
  const out = []
  /* Comments blanked here too, and for the mirror reason: a `var()` inside a
     commented-out rule is not a reference, and reporting it as an undefined
     token is a finding about text nothing reads. */
  withoutComments(text)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) out.push({ name: m[1], line: i + 1 })
    })
  return out
}

/**
 * Names a source file WRITES — an inline style key, a `setProperty` argument,
 * or an entry in a table of either.
 *
 * ⚠️ **A READ IS NOT A WRITE, AND EVERY TOKEN-SHAPED STRING COUNTED AS ONE.**
 * `getPropertyValue('--missing')` ASKS for a token; it defines nothing. So a
 * name that no stylesheet declared and nothing ever set was reported as
 * defined, purely because something looked it up — which is precisely the
 * shape of the defect this gate exists to catch, wearing its own uniform.
 * `useAppPalette` reads nine tokens by name for exactly this reason.
 *
 * The reading calls are named rather than the writing ones, because the write
 * forms are open-ended (a style key, a table entry, a bare string in a map) and
 * the read forms are a short closed list. Excluding the closed list is honest;
 * enumerating the open one would silently stop counting the next spelling.
 *
 * COMMENTS ARE STRIPPED FIRST, with a real comment-aware pass rather than a
 * line prefix: a token named in a trailing `// see --ink` or inside a block
 * comment is prose, and prose keeps a dead name looking alive.
 */
const READ_CALLS = /\b(?:getPropertyValue|getComputedStyle\([^)]*\)\s*\.getPropertyValue)\s*\(\s*['"`](--[a-z0-9-]+)['"`]/gi

export function writtenInCode(text) {
  const live = withoutComments(text)
  const read = new Set([...live.matchAll(READ_CALLS)].map((m) => m[1]))
  const found = new Set()
  for (const m of live.matchAll(/['"`](--[a-z0-9-]+)['"`]/gi)) {
    if (!read.has(m[1])) found.add(m[1])
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
