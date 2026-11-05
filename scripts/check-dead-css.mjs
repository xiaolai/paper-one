#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { isProcessEntry } from './lib/entry.mjs'
import { followHolders, staticText, unwrapped } from './lib/holders.mjs'

/**
 * `pnpm css:check` — every class in a CSS module has a consumer, and every class
 * a source names from a CSS module exists.
 *
 * A STATIC CHECK, not a proof: it reads syntax and one file's scopes, carries what
 * crosses a file itself, and resolves no types. What it cannot follow it says so about.
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
 * stylesheet (see `readsIn`, and `lib/holders.mjs` for every form), or when another module `composes`
 * it. The source is PARSED: a comment or a string that mentions `styles.gone`
 * reads nothing, whichever way that would have misled the gate.
 *
 * WHAT IT FOLLOWS, across files as well as within one: an alias, an assignment, a
 * pattern, `x ? a : b`, an array, an object bound to a name, a spread, a function that
 * returns one, a call that hands one to a function another source exports, an export,
 * a re-export (`export { default as s } from './a.module.css'`, `export * as s`, and
 * through source files), `import()`, `require()`, `css.default.x` and `Object.keys`.
 * A binding that can hold two stylesheets is read against each, since nothing here
 * knows which branch ran.
 *
 * WHAT IT CANNOT FOLLOW IT REFUSES, by file and line: `unfollowedStylesheets`. A key
 * nothing can read (`styles[name]`), a stylesheet handed to a call this cannot see
 * into (`f(styles)` for a library's `f`), one spread into props, assigned to a member,
 * returned from a method or inside an array or object, or an array or object that
 * goes on holding one. The way out is a class read by name, or the stylesheet handed
 * on as `styles`: `<X styles={styles}>` is seen where it is read as `styles`, which
 * proves the class is used and cannot say which module it must be in.
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

/** Every file under `dir`, however deep. A link is not followed, and is no file. */
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))

/** Every file under each of `roots` that exists in `root`. */
const filesUnder = (root, roots) => roots.map((dir) => join(root, dir)).filter((dir) => existsSync(dir)).flatMap(walk)

const isModuleImport = (specifier) => ts.isStringLiteralLike(specifier) && specifier.text.endsWith('.module.css')

/*
 * WHAT A BINDING CAN HOLD. A stylesheet, as a default import reads it; the module
 * object, as `import * as` and `import()` read it, whose `default` is the stylesheet;
 * one handed in by whoever called, whose module is not known, so a read of it proves
 * only that a class is used; and another source file's module object, which holds
 * whatever that file exports.
 */
const interned = (make) => {
  const made = new Map()
  return (key) => {
    if (!made.has(key)) made.set(key, make(key))
    return made.get(key)
  }
}
// Stryker disable next-line StringLiteral: no reader compares a kind with 'sheet'; one is told from the others by `modulePath`
const sheetOf = interned((modulePath) => Object.freeze({ kind: 'sheet', modulePath }))
const namespaceOf = interned((modulePath) => Object.freeze({ kind: 'namespace', modulePath }))
const sourceModuleOf = interned((file) => Object.freeze({ kind: 'source', file, modulePath: null }))
// Stryker disable next-line StringLiteral: no reader compares a kind with 'handedIn'; one is told from the others by its null `modulePath`
const HANDED_IN = Object.freeze({ kind: 'handedIn', modulePath: null })

const isExported = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
const isDefault = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0

/** The source file a relative specifier means, or null: this tree writes no extensions. */
function sourceAt(file, specifier, functions) {
  if (!specifier.startsWith('.')) return null
  const bare = resolve(dirname(file), specifier)
  for (const candidate of [bare, `${bare}.ts`, `${bare}.tsx`, join(bare, 'index.ts'), join(bare, 'index.tsx')]) {
    if (functions.has(candidate)) return candidate
  }
  return null
}

/** The functions a file exports, by name, whatever else is known of it. A call into one is followed. */
function exportedFunctions(source) {
  const found = new Map()
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
      /* Only a default may go unnamed: the parser names any other, if only with ''. */
      if (isDefault(statement)) found.set('default', statement)
      else found.set(statement.name.text, statement)
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer)
        /* A pattern has no `text`, so a function it is bound to is filed under
           `undefined`, which no import names. */
        if (value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) found.set(declaration.name.text, value)
      }
    }
  }
  return found
}

/** Every name a declaration binds: itself, or each a pattern holds, however deep. */
const boundNames = (name) => (ts.isIdentifier(name) ? [name] : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name))))

const emptyExport = () => ({ value: new Set(), returns: new Set() })

/** `followHolders`' answer for a file with nothing in it to follow. */
const NOTHING_HELD = { originsOf: () => [], heldBy: () => [], returnsOf: () => [] }

/** One round's view of every file: what each exports, and what callers hand its functions. */
const emptyTable = () => ({ exports: new Map(), handed: new Map() })

function exportFrom(table, file, name) {
  let exported = table.exports.get(file)
  if (exported === undefined) table.exports.set(file, (exported = new Map()))
  let entry = exported.get(name)
  if (entry === undefined) exported.set(name, (entry = emptyExport()))
  return entry
}

/* WHAT IS KNOWN ONLY GROWS, round on round, and every origin is made once (`interned`),
   so a round that learned anything left some set larger: the sizes are the whole
   comparison, and what each origin is need not be spelled out. */
const tableSizes = (table) =>
  JSON.stringify([
    [...table.exports].map(([file, names]) => [file, [...names].map(([name, entry]) => [name, entry.value.size, entry.returns.size])]),
    [...table.handed].map(([key, origins]) => [key, origins.size]),
  ])

/**
 * Every class one source reads, `{ modulePath, name }`, `modulePath` null for a
 * stylesheet that was handed in; every stylesheet it reads whole; what it does
 * with one that this cannot follow; and whether it could hold one at all, which is
 * whether it was walked.
 *
 * WHAT HOLDS A STYLESHEET IS A BINDING, so the compiler's scopes decide: an
 * identifier means what it resolves to, and a parameter that shadows an import is
 * not the import. It is what handing a stylesheet in looks like, though, so
 * anything called `styles` still counts as one, and that keeps its classes alive
 * without saying which module they must be in.
 *
 * `lib/holders.mjs` follows it within the file. This adds what crosses a file, which
 * only the whole walk can see: an export, a re-export, an import of either, and a
 * call handing one to a function another file exports.
 */
function readsIn(file, source, checker, functions, known, next) {
  const reads = new Map()
  const whole = new Set()
  const unfollowed = []
  const say = (at, how) => unfollowed.push({ line: source.getLineAndCharacterOfPosition(at.getStart()).line + 1, what: at.getText().replace(/\s+/g, ' ').slice(0, 60), how })
  /* Never of a source module: what a source exports is read through `through`. */
  const readName = (origin, name) => reads.set(JSON.stringify([origin.modulePath, name]), { modulePath: origin.modulePath, name })

  /** Whether another source is known to export anything: only then is its module worth holding. */
  const exportsAny = (target) => (known.exports.get(target)?.size ?? 0) > 0

  const importedFrom = new Map()
  const seeds = []
  // Stryker disable next-line ArrayDeclaration: a string in it is filed under a string, and only a symbol is ever looked up
  const returning = []
  const takeFrom = (target, name, nameNode) => {
    importedFrom.set(checker.getSymbolAtLocation(nameNode), { target, name })
    const entry = known.exports.get(target)?.get(name)
    if (entry === undefined) return
    /* An entry holds a value or a return, and an empty list of either fills nothing. */
    seeds.push([nameNode, [...entry.value]])
    returning.push([checker.getSymbolAtLocation(nameNode), [...entry.returns]])
  }

  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && isModuleImport(statement.moduleReference.expression)) {
      seeds.push([statement.name, [sheetOf(resolve(dirname(file), statement.moduleReference.expression.text))]])
    }
    /* Only an import declaration has a clause, and one without (`import './x'`) binds nothing. */
    const clause = statement.importClause
    if (clause === undefined) continue
    if (isModuleImport(statement.moduleSpecifier)) {
      const modulePath = resolve(dirname(file), statement.moduleSpecifier.text)
      if (clause.name) seeds.push([clause.name, [sheetOf(modulePath)]])
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) seeds.push([clause.namedBindings.name, [namespaceOf(modulePath)]])
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text
          if (imported === 'default') seeds.push([element.name, [sheetOf(modulePath)]])
          else readName(sheetOf(modulePath), imported)
        }
      }
      continue
    }
    /* A module that is no source here is `null`, of which nothing is known. */
    const target = sourceAt(file, statement.moduleSpecifier.text, functions)
    if (clause.name) takeFrom(target, 'default', clause.name)
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      importedFrom.set(checker.getSymbolAtLocation(clause.namedBindings.name), { target, name: null })
      if (exportsAny(target)) seeds.push([clause.namedBindings.name, [sourceModuleOf(target)]])
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) takeFrom(target, (element.propertyName ?? element.name).text, element.name)
    }
  }

  /* What another file's call hands this one's function. */
  const elementSeeds = []
  for (const [key, origins] of known.handed) {
    const [into, name, index] = JSON.parse(key)
    if (into !== file) continue
    const { parameters } = functions.get(file).get(name)
    const last = parameters[parameters.length - 1]
    if (last?.dotDotDotToken && index >= parameters.length - 1) elementSeeds.push([last.name, [...origins]])
    else if (parameters[index] !== undefined) seeds.push([parameters[index].name, [...origins]])
  }

  /* A source module is only made of a file known to export something, and what is
     known only grows, so its exports are there to read. */
  const through = (origins, keys) =>
    origins.flatMap((origin) => {
      if (origin.kind === 'namespace') return keys.includes('default') ? [sheetOf(origin.modulePath)] : []
      if (origin.kind !== 'source') return []
      const exported = known.exports.get(origin.file)
      return keys.flatMap((key) => [...(exported.get(key)?.value ?? [])])
    })

  const rootOf = (inner) => {
    if (!ts.isCallExpression(inner)) return []
    /* `re.f()`, a function another file exports that hands one back. */
    const callee = unwrapped(inner.expression)
    if (ts.isPropertyAccessExpression(callee)) {
      const from = ts.isIdentifier(callee.expression) ? importedFrom.get(checker.getSymbolAtLocation(callee.expression)) : undefined
      return from?.name === null ? [...(known.exports.get(from.target)?.get(callee.name.text)?.returns ?? [])] : []
    }
    if (inner.arguments.length === 0) return []
    const isLoad = inner.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(inner.expression) && inner.expression.text === 'require')
    if (!isLoad) return []
    const specifier = staticText(inner.arguments[0], checker)
    if (specifier === null) return []
    if (specifier.endsWith('.module.css')) return [namespaceOf(resolve(dirname(file), specifier))]
    const target = sourceAt(file, specifier, functions)
    return exportsAny(target) ? [sourceModuleOf(target)] : []
  }

  /* NOTHING IN A FILE THAT CANNOT HOLD ONE: the walk is the cost of this gate, about
     half of it on this tree, and most sources mention no stylesheet and were handed
     none. A return is never known without its import's seed, so `returning` adds no
     file. Whether the file was walked is in the answer, so the saving is held to. */
  const couldHoldOne = seeds.length > 0 || elementSeeds.length > 0 || /styles|\.module|\bimport\(|\brequire\(/.test(source.text)

  /* A stylesheet chosen at run time names no module, so nothing can be said of it. */
  const loads = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 0 && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      if (staticText(node.arguments[0], checker) === null && node.arguments[0].getText().includes('.module.css')) say(node, 'a stylesheet chosen at run time')
    }
    ts.forEachChild(node, loads)
  }
  loads(source)

  const followed = !couldHoldOne ? NOTHING_HELD : followHolders({
    source,
    checker,
    rootName: 'styles',
    rootOrigin: HANDED_IN,
    rootOf,
    seeds,
    elementSeeds,
    returning,
    through,
    read: (origins, name, at) => {
      for (const origin of origins) {
        if (origin.kind === 'source') {
          const exported = known.exports.get(origin.file)
          if (name === null) say(at, 'a module read by a key this cannot read')
          else if ((exported.get(name)?.returns.size ?? 0) > 0 && !(ts.isPropertyAccessExpression(at) && ts.isCallExpression(at.parent) && at.parent.expression === at)) say(at, 'a function that returns it, handed on')
        } else if (name === null) say(at, 'a key this cannot read: name the class')
        else readName(origin, name)
      }
    },
    enumerated: (origins, at) => {
      for (const origin of origins) {
        if (origin.kind === 'source') say(at, 'every member of a module that holds one')
        else if (origin.modulePath === null) say(at, 'every key of a stylesheet handed in, whose module is not known')
        else whole.add(origin.modulePath)
      }
    },
    /* A source module is only made of a file that exports one, so wherever it goes,
       one goes with it. An imported function known to return nothing escapes empty. */
    escaped: (origins, at, how) => {
      if (origins.length > 0) say(at, how)
    },
    /* `index` is where the value stands among the arguments, which it always does. */
    handedOn: (callee, index, origins) => {
      const inner = unwrapped(callee)
      const named = ts.isIdentifier(inner)
        ? importedFrom.get(checker.getSymbolAtLocation(inner))
        : ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)
          ? (() => {
              const from = importedFrom.get(checker.getSymbolAtLocation(inner.expression))
              return from?.name === null ? { target: from.target, name: inner.name.text } : undefined
            })()
          : undefined
      if (named === undefined || !functions.get(named.target)?.has(named.name)) return false
      const key = JSON.stringify([named.target, named.name, index])
      const held = next.handed.get(key) ?? new Set()
      for (const origin of origins) held.add(origin)
      next.handed.set(key, held)
      return true
    },
  })

  /* What leaves, for the next round to read on the other side. */
  const addExport = (name, value, returns) => {
    if (value.length === 0 && returns.length === 0) return
    const entry = exportFrom(next, file, name)
    for (const origin of value) entry.value.add(origin)
    for (const origin of returns) entry.returns.add(origin)
  }
  const addSymbol = (name, symbol) => addExport(name, followed.heldBy(symbol), followed.returnsOf(symbol))
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name) addSymbol(isDefault(statement) ? 'default' : statement.name.text, checker.getSymbolAtLocation(statement.name))
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of boundNames(declaration.name)) addSymbol(name.text, checker.getSymbolAtLocation(name))
      }
    }
    if (ts.isExportAssignment(statement)) {
      /* A name says what it holds and what it returns; anything else has no symbol that holds. */
      const value = unwrapped(statement.expression)
      addSymbol('default', checker.getSymbolAtLocation(value))
      addExport('default', followed.originsOf(value), [])
    }
    if (!ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    const clause = statement.exportClause
    if (specifier === undefined) {
      /* `export { a, b as c }`, of this file's own names. */
      for (const element of clause.elements) addSymbol(element.name.text, checker.getExportSpecifierLocalTargetSymbol(element))
      continue
    }
    const sheet = isModuleImport(specifier) ? resolve(dirname(file), specifier.text) : null
    const target = sourceAt(file, specifier.text, functions)
    if (clause === undefined) {
      /* `export * from`: every name goes on, and `default` does not. */
      if (sheet !== null) whole.add(sheet)
      else for (const [name, entry] of known.exports.get(target) ?? []) if (name !== 'default') addExport(name, [...entry.value], [...entry.returns])
    } else if (ts.isNamespaceExport(clause)) {
      if (sheet !== null) addExport(clause.name.text, [namespaceOf(sheet)], [])
      else if (exportsAny(target)) addExport(clause.name.text, [sourceModuleOf(target)], [])
    } else {
      for (const element of clause.elements) {
        const from = (element.propertyName ?? element.name).text
        if (sheet === null) {
          const entry = known.exports.get(target)?.get(from)
          if (entry !== undefined) addExport(element.name.text, [...entry.value], [...entry.returns])
        } else if (from === 'default') addExport(element.name.text, [sheetOf(sheet)], [])
        else readName(sheetOf(sheet), from)
      }
    }
  }
  return { reads: [...reads.values()], whole: [...whole], unfollowed, walked: couldHoldOne }
}

/** `readsBySource` for every source under `root`. */
export function scanSources(root, roots = ROOTS) {
  const files = filesUnder(root, roots)
  return readsBySource(files.filter((f) => ['.ts', '.tsx'].includes(extname(f))))
}

/*
 * NO LIBRARY, NO RESOLVING AND NO OUTPUT: the scopes are all this asks of the compiler,
 * and they are within one file. What crosses a file is `readsIn`'s to carry. So each of
 * these saves time and decides no answer: a type the library or another file would
 * lend is asked about only for a key, and a key is held only where this file says so.
 */
// Stryker disable next-line ObjectLiteral: with none of these every program loads the whole default library, which only slows each scan past the timeout; a file's extension decides JSX and any target parses the same syntax, so no answer moves
const PROGRAM = {
  // Stryker disable next-line BooleanLiteral: resolving adds the files a source imports, whose declarations no scope of this file holds anything under
  noResolve: true,
  // Stryker disable next-line BooleanLiteral: the library adds types no scope of this file holds anything under, and costs only time
  noLib: true,
  // Stryker disable next-line ArrayDeclaration: a type package that is not there is a diagnostic, and no diagnostic is read
  types: [],
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.Latest,
  // Stryker disable next-line BooleanLiteral: nothing is ever emitted, so whether it could be decides nothing
  noEmit: true,
}

/**
 * What every source does with a stylesheet, parsed once for the whole walk: a map
 * from file to `readsIn`'s answer. Rounds until what crosses a file stops changing,
 * since a re-export of a re-export arrives a round later.
 */
function readsBySource(sources) {
  const program = ts.createProgram(sources, PROGRAM)
  const checker = program.getTypeChecker()
  const functions = new Map(sources.map((file) => [file, exportedFunctions(program.getSourceFile(file))]))
  let known = emptyTable()
  for (;;) {
    const next = emptyTable()
    const answers = new Map(sources.map((file) => [file, readsIn(file, program.getSourceFile(file), checker, functions, known, next)]))
    if (tableSizes(next) === tableSizes(known)) return answers
    known = next
  }
}

/** Comments, strings and `url(...)` gone, in one pass: each can hold what opens another. */
const withoutProse = (css) => css.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|url\(\s*[^"'\s)][^)]*\)/g, '')

const CLASS = /\.(-?(?:[A-Za-z_\u0080-\uffff]|\\[0-9a-fA-F]{1,6}\s?|\\[^0-9a-fA-F])(?:[\w\u0080-\uffff-]|\\[0-9a-fA-F]{1,6}\s?|\\[^0-9a-fA-F])*)/y
const CLASSES = new RegExp(CLASS.source, 'g')
const unescaped = (name) =>
  name.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_all, hex, char) => (hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : char))

/** Where the bracket opened at `open` closes. A selector with none reads to its end. */
function closing(text, open) {
  let depth = 0
  for (let at = open; text[at] !== undefined; at++) {
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
  for (let at = 0; selector[at] !== undefined; ) {
    const rest = selector.slice(at)
    const switched = /^:(global|local)(?![\w-])/.exec(rest)
    if (switched) {
      const end = at + switched[0].length
      if (selector[end] === '(') {
        const close = closing(selector, end)
        // Stryker disable next-line ArithmeticOperator: a slice from before the bracket adds the `l` of `:local`, no class, and the bracket, which opens a group around the same selector kept local by the same `false`
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
    /* Sticky, so it matches only a class that starts here, at a dot. */
    CLASS.lastIndex = at
    const match = CLASS.exec(selector)
    if (match) {
      if (!global) found.push(unescaped(match[1]))
      at += match[0].length
      continue
    }
    at += selector[at] === '\\' ? 2 : 1
  }
  return found
}

/* THE `from` OF AN IMPORT, wherever it stands: a line may end after it, and an
   `@value` has lost its quoted path with the prose by the time it is read. */
const FROM = /\sfrom(?:\s|$)/

/** The names an `@value` body adds: `a: 1px`, `a, b as c from './x.css'`. */
function valueNames(body) {
  const [names, from] = body.split(FROM)
  if (from === undefined) return [body.split(/[\s:]/)[0]]
  /* `b as c` adds `c`, the last word of each. */
  return names.split(',').map((one) => one.trim().split(/\s/).at(-1))
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
  const stack = [{}]
  let buffer = ''
  for (const char of withoutProse(css)) {
    const top = stack.at(-1)
    if (char === '{') {
      const prelude = buffer.trim()
      buffer = ''
      stack.push({
        global: prelude === ':global' || (prelude !== ':local' && top.global),
        exporting: prelude === ':export',
      })
      /* An at-rule's prelude is no selector, and `:import(./x.css)` names a file. A
         keyframe's `12.5%` needs no exception: a class cannot start with a digit. */
      if (!prelude.startsWith('@') && !prelude.startsWith(':import(')) {
        const selector = prelude.replace(/\[[^\]]*\]/g, '')
        for (const name of localClasses(selector, top.global)) classes.add(name)
      }
    } else if (char === ';' || char === '}') {
      const statement = buffer.trim()
      buffer = ''
      if (top.exporting && statement.includes(':')) keys.add(statement.split(':')[0].trim())
      const value = /^@value\s+/.exec(statement)
      if (value !== null) for (const name of valueNames(statement.slice(value[0].length))) keys.add(name)
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
export function undefinedClasses(root, roots = ROOTS, scanned = scanSources(root, roots)) {
  const found = []
  for (const [file, { reads }] of scanned) {
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
 * Every place a source takes a stylesheet where this cannot follow, so that neither
 * direction above can answer for it: `{ file, line, what, how }`.
 */
export function unfollowedStylesheets(root, roots = ROOTS, scanned = scanSources(root, roots)) {
  const found = []
  for (const [file, { unfollowed }] of scanned) {
    for (const one of unfollowed) found.push({ file: relative(root, file).split(sep).join('/'), ...one })
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
export function deadClasses(root, roots = ROOTS, scanned = scanSources(root, roots)) {
  const files = filesUnder(root, roots)
  const modules = files.filter((f) => f.endsWith('.module.css'))

  /* Every `styles.name` in every source file, and every `composes:` in every
     stylesheet — one flat set, because a class is used if ANYTHING uses it and
     which file did the using is not this gate's question. */
  const used = new Set()
  /* UNDER ANY IMPORT NAME. Reading only `styles.` called `.popover` unreachable
     while three files drew it as `editorStyles.popover`, and it was deleted on
     this gate's word (`74aa52b`). */
  const wholeSheets = new Set()
  for (const { reads, whole } of scanned.values()) {
    for (const { name } of reads) used.add(name)
    for (const sheet of whole) wholeSheets.add(sheet)
  }
  /* `Object.keys(styles)` reaches every class in it, by no name a search would find. */
  for (const sheet of wholeSheets) {
    if (existsSync(sheet)) for (const name of moduleExports(readFileSync(sheet, 'utf8')).classes) used.add(name)
  }
  for (const file of modules) {
    /* BOTH SPELLINGS OF `composes`. Cross-file is `composes: x from './y.css'`;
       SAME-FILE is just `composes: x`, and reading only the first form reported
       a class as unreachable that three rules in its own stylesheet were built
       from — a false positive, which is the one outcome that would make this
       gate worth ignoring. `.groupTitle` is exactly that shape: never written
       into markup on purpose, composed by the heading that is also a toggle. */
    for (const m of readFileSync(file, 'utf8').matchAll(/composes:\s*([^;{}]+)/g)) {
      const [names] = m[1].split(FROM)
      for (const name of names.split(/[,\s]/).filter(Boolean)) used.add(name)
    }
  }

  const dead = []
  for (const file of modules) {
    const text = readFileSync(file, 'utf8')
    const declared = moduleExports(text).classes
    /* The DECLARATION, not the first mention: a class is usually described in
       prose above the rule that defines it, and pointing the reader at the
       comment instead of the code is a small lie that costs a search. Each line
       is read the way a selector is, so an escaped name (`.a\:b`) is found by
       what it means rather than by how it is spelled. */
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => '\n'.repeat(comment.split('\n').length - 1)).split('\n')
    for (const name of [...declared].sort()) {
      if (KEPT.test(name) || used.has(name)) continue
      const line = code.findIndex((l) => [...l.matchAll(CLASSES)].some((m) => unescaped(m[1]) === name)) + 1
      dead.push({ file: relative(root, file).split(sep).join('/'), name, line })
    }
  }
  return { dead, modules: modules.length, used: used.size }
}

/* THE WHOLE CLI BEHIND THE GUARD, not just the exit. Importing this module
   used to run the scan and print its summary as a side effect, so the gate's
   own test emitted the repository's result in the middle of its output — and
   an importer that only wanted `deadClasses` paid for a full walk of `src`. `main` prints what it found under `root` and
   returns the exit code. */
export function main({ root = REPO, stdout = process.stdout } = {}) {
  const scanned = scanSources(root)
  const { dead, modules, used } = deadClasses(root, ROOTS, scanned)
  const missing = undefinedClasses(root, ROOTS, scanned)
  const unfollowed = unfollowedStylesheets(root, ROOTS, scanned)
  for (const { file, name, line } of dead) {
    stdout.write(`${file}:${line}  .${name} — no source names \`styles.${name}\`\n`)
  }
  stdout.write(
    `check-dead-css: ${modules} modules, ${used} classes used, ${dead.length} unreachable, ${missing.length} undefined, ${unfollowed.length} unfollowed\n`,
  )
  for (const { file, name } of missing) {
    stdout.write(`${file}  .${name} — named here, declared by no rule in the module it imports\n`)
  }
  if (missing.length > 0) {
    stdout.write(
      '\nA class no stylesheet declares reads as undefined and styles nothing, without\n' +
        'an error. Restore the rule, or stop naming the class.\n',
    )
  }
  for (const { file, line, what, how } of unfollowed) {
    stdout.write(`${file}:${line}  ${what} — ${how}\n`)
  }
  if (unfollowed.length > 0) {
    stdout.write(
      '\nA stylesheet this cannot follow answers neither question above: a class read\n' +
        'that way could be missing, or be all that keeps a rule alive. Read the classes\n' +
        'by name, or hand the stylesheet on as `styles`, where its reader is seen.\n',
    )
  }
  if (dead.length > 0) {
    stdout.write(
      '\nAn unreachable rule is shipped CSS that can never apply. Delete it, or\n' +
        'rename it with a leading `_` if it is kept deliberately — the exemption\n' +
        'belongs at the rule, where the next reader of this file will see it.\n',
    )
  }
  return dead.length > 0 || missing.length > 0 || unfollowed.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) process.exit(main())
