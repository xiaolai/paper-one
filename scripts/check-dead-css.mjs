#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `pnpm css:check` — every class in a CSS module has a consumer.
 *
 * A RULE OUTLIVES THE COMPONENT THAT ORPHANED IT, silently. A panel loses its
 * empty state, a popover becomes a full-width sheet, a status line is replaced
 * — the JSX changes and the CSS is left behind, still valid, still parsed,
 * still shipped, and nothing anywhere says it is unreachable. Three were found
 * by hand in one afternoon (`.enriching`, `.emptyAction` and its `:hover`,
 * `.popover`); by then it is a class of defect rather than three mistakes, and
 * the fix for a class is a check rather than three deletions.
 *
 * NOT A LINTER, and deliberately not: this repo gates with small scripts that
 * answer one question each, and the question here is narrow enough to answer
 * exactly. A class is used when some source names it as `styles.<name>` — the
 * only way a module class is read in this codebase, verified by there being no
 * `styles[...]` lookup anywhere — or when another module `composes` it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not check whether the RULE has any
 * effect, or whether the element it lands on is rendered, or whether a
 * declaration is overridden. Those need a browser. This one needs a grep, and
 * it catches the whole of the failure that actually happened.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['src']

/**
 * Prefixed with `_` to say "kept on purpose".
 *
 * An escape hatch, and it is the ONE thing that could turn this gate into
 * theatre — so it has to be an explicit rename rather than a list in this file
 * that grows a line at a time until nobody reads it. There is no allowlist
 * here for that reason: the exemption lives at the site, where the next reader
 * of the CSS sees it, and adding one is a visible edit to the rule itself.
 */
const KEPT = /^_/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * Every class a CSS module declares that nothing can reach, under `root`.
 *
 * Rooted rather than reading this repository directly, so the gate's own test
 * can hand it a tree built for the purpose. A check that can only be run
 * against the repository it lives in is a check whose behaviour is asserted by
 * whatever that repository happens to contain today — which is how a gate ends
 * up passing because it found nothing to look at.
 */
export function deadClasses(root, roots = ROOTS) {
  const files = roots.flatMap((dir) => (existsSync(join(root, dir)) ? walk(join(root, dir)) : []))
  const modules = files.filter((f) => f.endsWith('.module.css'))
  const sources = files.filter((f) => ['.ts', '.tsx'].includes(extname(f)))

  /* Every `styles.name` in every source file, and every `composes:` in every
     stylesheet — one flat set, because a class is used if ANYTHING uses it and
     which file did the using is not this gate's question. */
  const used = new Set()
  for (const file of sources) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bstyles\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      used.add(m[1])
    }
  }
  for (const file of modules) {
    /* BOTH SPELLINGS OF `composes`. Cross-file is `composes: x from './y.css'`;
       SAME-FILE is just `composes: x`, and reading only the first form reported
       a class as unreachable that three rules in its own stylesheet were built
       from — a false positive, which is the one outcome that would make this
       gate worth ignoring. `.groupTitle` is exactly that shape: never written
       into markup on purpose, composed by the heading that is also a toggle. */
    for (const m of readFileSync(file, 'utf8').matchAll(/composes:\s*([^;{}]+)/g)) {
      const names = m[1].replace(/\s+from\s+.*$/, '')
      for (const name of names.split(/[,\s]+/).filter(Boolean)) used.add(name)
    }
  }

  const dead = []
  for (const file of modules) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    /* Class selectors only, and only where a selector can begin: at the start
       of a line or after a combinator or comma. `.foo:hover` and `.foo .bar`
       both name classes; `--foo` and `0.5` do not, and a naive `\.[a-z]` finds
       both. */
    const declared = new Set()
    for (const m of text.matchAll(/(^|[\s,>+~(])\.(-?[A-Za-z_][A-Za-z0-9_-]*)/gm)) declared.add(m[2])
    for (const name of [...declared].sort()) {
      if (KEPT.test(name) || used.has(name)) continue
      /* The DECLARATION, not the first mention: a class is usually described in
         prose above the rule that defines it, and pointing the reader at the
         comment instead of the code is a small lie that costs a search. */
      const line = lines.findIndex((l) => new RegExp(`^\\s*\\.${name}\\b`).test(l)) + 1
      dead.push({ file: relative(root, file).split(sep).join('/'), name, line })
    }
  }
  return { dead, modules: modules.length, used: used.size }
}

/* THE WHOLE CLI BEHIND THE GUARD, not just the exit. Importing this module
   used to run the scan and print its summary as a side effect, so the gate's
   own test emitted the repository's result in the middle of its output — and
   an importer that only wanted `deadClasses` paid for a full walk of `src`. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dead, modules, used } = deadClasses(REPO)
  for (const { file, name, line } of dead) {
    process.stdout.write(`${file}:${line}  .${name} — no source names \`styles.${name}\`\n`)
  }
  process.stdout.write(
    `check-dead-css: ${modules} modules, ${used} classes used, ${dead.length} unreachable\n`,
  )
  if (dead.length > 0) {
    process.stdout.write(
      '\nAn unreachable rule is shipped CSS that can never apply. Delete it, or\n' +
        'rename it with a leading `_` if it is kept deliberately — the exemption\n' +
        'belongs at the rule, where the next reader of this file will see it.\n',
    )
    process.exit(1)
  }
}
