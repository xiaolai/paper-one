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
 * A STATIC HEURISTIC WITH NAMED LIMITS, not a proof: it reads syntax and one file's
 * scopes, with no types resolved. WHAT IT CANNOT SEE lists what a clean run does not
 * cover.
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
 * exactly. A class is used when some source reads it off a binding that holds a
 * stylesheet (see `readsIn` for every form), or when another module `composes`
 * it. The source is PARSED: a comment or a string that mentions `styles.gone`
 * reads nothing, whichever way that would have misled the gate.
 *
 * WHAT IT CANNOT SEE. A stylesheet handed on under another name (`f(styles)`,
 * `{ ...styles }`, `Object.keys(styles)`), a computed key (`styles[name]`), a
 * stylesheet reached through a re-export or a dynamic import, or chosen by an
 * expression (`const s = x ? a : b`): no read is recorded. A binding reassigned to
 * a second stylesheet is read against the first.
 * A class read only that way is reported dead, which is loud, and a missing class
 * read that way is not reported. `<X styles={styles}>` is seen where it is read
 * as `styles`. A namespace import read as `css.default.x` reports `default` as
 * undefined and reads no `x`, which is loud too; read `css.x` or a default import.
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

/** The keys an expression can only be: `'a'`, `x ? 'a' : 'b'`, `x ?? 'a'`. Empty for anything else. */
function literalKeys(node) {
  const inner = unwrapped(node)
  if (ts.isStringLiteralLike(inner)) return [inner.text]
  if (ts.isConditionalExpression(inner)) return [...literalKeys(inner.whenTrue), ...literalKeys(inner.whenFalse)]
  if (ts.isBinaryExpression(inner) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(inner.operatorToken.kind)) {
    return [...literalKeys(inner.left), ...literalKeys(inner.right)]
  }
  return []
}

/** `a`, `'a'`, `['a']`: the key a pattern or an object names. Null for `[a]`, which could be anything. */
function keyOf(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) ? name.expression.text : null
}

/** What a pattern's value assigns to: `s` in `{ a: s }` and in `{ a: s = {} }`. */
function assignedTarget(node) {
  const inner = unwrapped(node)
  return ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken ? assignedTarget(inner.left) : inner
}

/** Whether an object literal is the left of an assignment, so its keys read rather than write. */
function isDestructuringTarget(literal) {
  let node = literal
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent
  const parent = node.parent
  if (ts.isBinaryExpression(parent)) return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  return ts.isPropertyAssignment(parent) && parent.initializer === node && isDestructuringTarget(parent.parent)
}

const isModuleImport = (specifier) => ts.isStringLiteralLike(specifier) && specifier.text.endsWith('.module.css')

/** Handed in by whoever called: no stylesheet is known, so a read proves only that a class is used. */
const HANDED_IN = Object.freeze({ modulePath: null })

/**
 * Every class one source reads: `{ modulePath, name }`, `modulePath` null for a
 * stylesheet that was handed in.
 *
 * WHAT HOLDS A STYLESHEET IS A BINDING, so the compiler's scopes decide: an
 * identifier means what it resolves to, and a parameter that shadows an import is
 * not the import. It is what handing a stylesheet in looks like, though, so
 * anything called `styles` still counts as one, and that keeps its classes alive
 * without saying which module they must be in.
 *
 * A binding is filled from an import, a declaration, a default or an assignment,
 * directly or through a pattern; a pattern's keys are reads and its rest is another
 * holder. Run until nothing changes, because an alias can be
 * written above the one it copies.
 */
function readsIn(file, source, checker) {
  const holders = new Map()
  const reads = new Map()
  const read = (origin, name) => {
    if (name !== null) reads.set(JSON.stringify([origin.modulePath, name]), { modulePath: origin.modulePath, name })
  }

  const originOf = (node) => {
    const inner = unwrapped(node)
    if (ts.isIdentifier(inner)) return holders.get(checker.getSymbolAtLocation(inner)) ?? (inner.text === 'styles' ? HANDED_IN : null)
    const called = ts.isPropertyAccessExpression(inner) ? [inner.name.text] : ts.isElementAccessExpression(inner) ? literalKeys(inner.argumentExpression) : []
    return called.includes('styles') ? HANDED_IN : null
  }

  let changed = false
  const hold = (identifier, origin) => {
    /* In `({ s = x } = o)` the name's own symbol is the key; the variable is the holder. */
    const symbol = ts.isShorthandPropertyAssignment(identifier.parent) ? checker.getShorthandAssignmentValueSymbol(identifier.parent) : checker.getSymbolAtLocation(identifier)
    /* THE FIRST STYLESHEET A BINDING TAKES IS THE ONE IT HOLDS, so this only ever
       moves one way and the loop below ends, whatever a reassignment does. Knowing
       the module outranks knowing only that one was handed in. */
    if (symbol === undefined || (holders.has(symbol) && holders.get(symbol) !== HANDED_IN) || holders.get(symbol) === origin) return
    holders.set(symbol, origin)
    changed = true
  }
  /** A declaration's name, or an assignment's target, taking the stylesheet in `origin`. */
  const fill = (target, origin) => {
    if (origin === null) return
    if (ts.isIdentifier(target)) hold(target, origin)
    else if (ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) {
        if (element.dotDotDotToken) fill(element.name, origin)
        else read(origin, keyOf(element.propertyName ?? element.name))
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const member of target.properties) {
        if (ts.isSpreadAssignment(member)) fill(unwrapped(member.expression), origin)
        else read(origin, keyOf(member.name))
      }
    }
  }

  const flows = []
  const handedIn = []
  const members = []
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      if (node.initializer) flows.push([node.name, node.initializer])
    }
    if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer) flows.push([node.name, node.objectAssignmentInitializer])
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken && keyOf(node.propertyName ?? node.name) === 'styles') {
      handedIn.push(node.name)
    }
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && isDestructuringTarget(node.parent) && keyOf(node.name) === 'styles') {
      handedIn.push(assignedTarget(node.initializer))
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      flows.push([unwrapped(node.left), node.right])
    } else if (ts.isPropertyAccessExpression(node)) {
      members.push([node.expression, [node.name.text]])
    } else if (ts.isElementAccessExpression(node)) {
      members.push([node.expression, literalKeys(node.argumentExpression)])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && isModuleImport(statement.moduleReference.expression)) {
      hold(statement.name, { modulePath: resolve(dirname(file), statement.moduleReference.expression.text) })
    }
    if (!ts.isImportDeclaration(statement) || !isModuleImport(statement.moduleSpecifier)) continue
    const origin = { modulePath: resolve(dirname(file), statement.moduleSpecifier.text) }
    const clause = statement.importClause
    if (clause?.name) hold(clause.name, origin)
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) hold(clause.namedBindings.name, origin)
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text
        if (imported === 'default') hold(element.name, origin)
        else read(origin, imported)
      }
    }
  }

  do {
    changed = false
    for (const name of handedIn) fill(name, HANDED_IN)
    for (const [target, from] of flows) fill(target, originOf(from))
  } while (changed)

  for (const [object, names] of members) {
    const origin = originOf(object)
    if (origin !== null) for (const name of names) read(origin, name)
  }
  return [...reads.values()]
}

/** Every class each source reads, parsed once for the whole walk, as a map from file to its reads. */
function readsBySource(sources) {
  /* NO LIBRARY AND NO RESOLVING: the scopes are all this asks of the compiler, and
     they are within one file. */
  const program = ts.createProgram(sources, { noResolve: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, noEmit: true })
  const checker = program.getTypeChecker()
  return new Map(sources.map((file) => [file, readsIn(file, program.getSourceFile(file), checker)]))
}

/** Comments, strings and `url(...)` gone, in one pass: each can hold what opens another. */
const withoutProse = (css) => css.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|url\(\s*[^"'\s)][^)]*\)/g, '')

const CLASS = /\.(-?(?:[A-Za-z_\u0080-\uffff]|\\[0-9a-fA-F]{1,6}\s?|\\[^0-9a-fA-F])(?:[\w\u0080-\uffff-]|\\[0-9a-fA-F]{1,6}\s?|\\[^0-9a-fA-F])*)/y
const unescaped = (name) =>
  name.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_all, hex, char) => (hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : char))

/** Where the bracket opened at `open` closes. A selector with none reads to its end. */
function closing(text, open) {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    if (text[at] === '\\') at++
    else if (text[at] === '(') depth++
    else if (text[at] === ')' && --depth === 0) return at
  }
  return text.length
}

/**
 * The classes a selector makes local, which are the ones the module exports.
 * `:global(...)` holds none. A bare `:global` lasts to the next `:local` or the end
 * of that selector in its list, and `:local(...)` is local wherever it stands.
 */
function localClasses(selector, inherited) {
  const found = []
  let global = inherited
  for (let at = 0; at < selector.length; ) {
    const rest = selector.slice(at)
    const switched = /^:(global|local)(?![\w-])/.exec(rest)
    if (switched) {
      const end = at + switched[0].length
      if (selector[end] === '(') {
        const close = closing(selector, end)
        if (switched[1] === 'local') found.push(...localClasses(selector.slice(end + 1, close), false))
        at = close + 1
      } else {
        global = switched[1] === 'global'
        at = end
      }
      continue
    }
    if (selector[at] === '(') {
      const close = closing(selector, at)
      found.push(...localClasses(selector.slice(at + 1, close), global))
      at = close + 1
      continue
    }
    if (selector[at] === ',') global = inherited
    if (selector[at] === '.') {
      CLASS.lastIndex = at
      const match = CLASS.exec(selector)
      if (match) {
        if (!global) found.push(unescaped(match[1]))
        at += match[0].length
        continue
      }
    }
    at += selector[at] === '\\' ? 2 : 1
  }
  return found
}

/** The names `@value` adds: `a: 1px`, `a, b as c from './x.css'`. */
function valueNames(statement) {
  const body = statement.replace(/^@value\s+/, '')
  const imported = /^(.*?)\s+from\s/s.exec(body)
  if (imported === null) return [body.split(/[\s:]/)[0]]
  return imported[1].split(',').map((one) => one.trim().split(/\s+as\s+/).at(-1))
}

/**
 * What a stylesheet exports: `classes`, from its selectors, and `keys`, which are
 * every other name an import can read, from `:export` and `@value`.
 *
 * A prelude's meaning depends on what it stands in, so the blocks are walked rather
 * than matched: `:global { .a {} }` holds a selector that says nothing about being
 * global, and a keyframe's `12.5%` is not a selector at all.
 */
function moduleExports(css) {
  const classes = new Set()
  const keys = new Set()
  const stack = [{ global: false, exporting: false, frames: false }]
  let buffer = ''
  for (const char of withoutProse(css)) {
    const top = stack.at(-1)
    if (char === '{') {
      const prelude = buffer.trim()
      buffer = ''
      stack.push({
        global: prelude === ':global' || (prelude !== ':local' && top.global),
        exporting: prelude === ':export',
        frames: top.frames || /^@(-\w+-)?keyframes\b/.test(prelude),
      })
      if (!prelude.startsWith('@') && !top.frames && ![':global', ':local', ':export', ':import'].includes(prelude) && !prelude.startsWith(':import(')) {
        const selector = prelude.replace(/\[[^\]]*\]/g, '')
        for (const name of localClasses(selector, top.global)) classes.add(name)
      }
    } else if (char === ';' || char === '}') {
      const statement = buffer.trim()
      buffer = ''
      if (top.exporting && statement.includes(':')) keys.add(statement.split(':')[0].trim())
      if (statement.startsWith('@value')) for (const name of valueNames(statement)) keys.add(name)
      if (char === '}' && stack.length > 1) stack.pop()
    } else buffer += char
  }
  return { classes, keys }
}

/** Every name a source can read from a stylesheet. */
function declaredClasses(file) {
  const { classes, keys } = moduleExports(readFileSync(file, 'utf8'))
  return new Set([...classes, ...keys])
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
  const sources = files.filter((f) => ['.ts', '.tsx'].includes(extname(f)))
  for (const [file, reads] of readsBySource(sources)) {
    for (const { modulePath, name } of reads) {
      if (modulePath === null) continue
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
  /* UNDER ANY IMPORT NAME. Reading only `styles.` called `.popover` unreachable
     while three files drew it as `editorStyles.popover`, and it was deleted on
     this gate's word (`74aa52b`). */
  for (const reads of readsBySource(sources).values()) {
    for (const { name } of reads) used.add(name)
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
    const declared = moduleExports(text).classes
    for (const name of [...declared].sort()) {
      if (KEPT.test(name) || used.has(name)) continue
      /* The DECLARATION, not the first mention: a class is usually described in
         prose above the rule that defines it, and pointing the reader at the
         comment instead of the code is a small lie that costs a search. */
      const code = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')).split('\n')
      const shape = new RegExp(`\\.${name.replace(/[^\w-]/g, '\\$&')}(?![\\w-])`)
      const line = code.findIndex((l) => shape.test(l)) + 1
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
