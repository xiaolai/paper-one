#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm css:check` — every class in a CSS module has a consumer, and every class
 * a source names from a CSS module exists.
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
 * exactly. A class is used when some source reads it as `styles.<name>` or
 * `styles['<name>']`, or under whatever other name that source imported the
 * module by, or when another module `composes` it. The source is PARSED: a
 * comment or a string that mentions `styles.gone` reads nothing, whichever way
 * that would have misled the gate.
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

/** `styles`, `styles!`, `(styles)`, `styles as X`: the expression under its wrappers. */
function unwrapped(node) {
  let inner = node
  while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)) {
    inner = inner.expression
  }
  return inner
}

/** `{ object, name }` for `object.name` and `object['name']`; null for anything else. */
function memberRead(node) {
  if (ts.isPropertyAccessExpression(node)) return { object: unwrapped(node.expression), name: node.name.text }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { object: unwrapped(node.expression), name: node.argumentExpression.text }
  }
  return null
}

/** Every member read in a source: what it was read off, and the name. */
function memberReads(file) {
  const kind = extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind)
  const reads = []
  const visit = (node) => {
    const read = memberRead(node)
    if (read !== null) reads.push(read)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { source, reads }
}

/** The module classes a source reads: `{ alias, modulePath, name }` for each. */
function moduleReads(file) {
  const { source, reads } = memberReads(file)
  const modules = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.endsWith('.module.css')) continue
    const modulePath = resolve(dirname(file), statement.moduleSpecifier.text)
    const clause = statement.importClause
    if (clause?.name) modules.set(clause.name.text, modulePath)
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) modules.set(clause.namedBindings.name.text, modulePath)
  }
  return reads.flatMap(({ object, name }) =>
    ts.isIdentifier(object) && modules.has(object.text) ? [{ alias: object.text, modulePath: modules.get(object.text), name }] : [],
  )
}

/** Names read off anything called `styles`, imported here or handed in: `styles.a`, `props.styles.a`. */
function readsOffStyles(file) {
  return memberReads(file).reads.flatMap(({ object, name }) => {
    const called = ts.isIdentifier(object) ? object.text : ts.isPropertyAccessExpression(object) ? object.name.text : null
    return called === 'styles' ? [name] : []
  })
}

/**
 * A stylesheet's selectors and nothing else, one prelude to a line.
 *
 * Comments, strings and `url(...)` go first and in one pass, because each can
 * hold what opens another: an apostrophe in a comment, a `;` in a data URL. What
 * stands before a `{` is then a prelude, and one starting `@` is a condition
 * rather than a selector. What stands before a `;` or a `}` is a declaration.
 */
function selectorText(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|url\(\s*[^"'\s)][^)]*\)/g, '')
  const preludes = [...bare.matchAll(/([^{};]*)\{/g)].map((m) => m[1].trim())
  return preludes.filter((prelude) => !prelude.startsWith('@')).join('\n')
}

/** Class selectors in a stylesheet: only a selector declares one. */
function declaredClasses(file) {
  const text = selectorText(readFileSync(file, 'utf8'))
  return new Set([...text.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]))
}

/**
 * Every class a source reads from a CSS module that the module does not declare.
 *
 * The direction that shows. `styles.gone` is `undefined`, and `className={undefined}`
 * draws no attribute and says nothing, so the element falls back to whatever the
 * browser gives it. `fefc54f` took `.searchInput` and `.placeLine` out with the
 * rules it meant to remove, and the search field went on looking like that for
 * six weeks under a gate that was green.
 */
export function undefinedClasses(root, roots = ROOTS) {
  const files = roots.flatMap((dir) => (existsSync(join(root, dir)) ? walk(join(root, dir)) : []))
  const found = []
  for (const file of files.filter((f) => ['.ts', '.tsx'].includes(extname(f)))) {
    for (const { modulePath, name } of moduleReads(file)) {
      const known = existsSync(modulePath) && declaredClasses(modulePath).has(name)
      const shown = relative(root, file).split(sep).join('/')
      if (!known && !found.some((f) => f.file === shown && f.name === name)) {
        found.push({ file: shown, name })
      }
    }
  }
  return found
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
    for (const name of readsOffStyles(file)) used.add(name)
    /* UNDER ANY IMPORT NAME. Reading only `styles.` called `.popover` unreachable
       while three files drew it as `editorStyles.popover`, and it was deleted on
       this gate's word (`74aa52b`). */
    for (const { name } of moduleReads(file)) used.add(name)
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
    for (const m of selectorText(text).matchAll(/(^|[\s,>+~(])\.(-?[A-Za-z_][A-Za-z0-9_-]*)/gm)) declared.add(m[2])
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
if (isProcessEntry(import.meta)) {
  const { dead, modules, used } = deadClasses(REPO)
  const missing = undefinedClasses(REPO)
  for (const { file, name, line } of dead) {
    process.stdout.write(`${file}:${line}  .${name} — no source names \`styles.${name}\`\n`)
  }
  process.stdout.write(
    `check-dead-css: ${modules} modules, ${used} classes used, ${dead.length} unreachable, ${missing.length} undefined\n`,
  )
  for (const { file, name } of missing) {
    process.stdout.write(`${file}  .${name} — named here, declared by no rule in the module it imports\n`)
  }
  if (missing.length > 0) {
    process.stdout.write(
      '\nA class no stylesheet declares reads as undefined and styles nothing, without\n' +
        'an error. Restore the rule, or stop naming the class.\n',
    )
  }
  if (dead.length > 0) {
    process.stdout.write(
      '\nAn unreachable rule is shipped CSS that can never apply. Delete it, or\n' +
        'rename it with a leading `_` if it is kept deliberately — the exemption\n' +
        'belongs at the rule, where the next reader of this file will see it.\n',
    )
  }
  if (dead.length > 0 || missing.length > 0) process.exit(1)
}
