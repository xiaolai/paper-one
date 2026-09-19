import ts from 'typescript'

/**
 * Every specifier a module loads when it RUNS, read from its syntax.
 *
 * Two gates ask this one question of a module and then different questions of
 * the answer: `check-browser-safe` follows every specifier to see whether
 * `@tauri-apps` is reachable, and `check-mutants` resolves the relative ones to
 * learn which tests import a subject. Neither may count what does not run, and
 * neither may miss what does.
 *
 * ⚠️ **IT WAS PARSED ONLY AFTER TWO REGEXES HAD BEEN WRONG IN OPPOSITE
 * DIRECTIONS.** `check-browser-safe` stripped comments with a stripper that was
 * not JavaScript-aware — a regex literal holding `//` ate the real import after
 * it, and a blocked module read as clean — and then matched `from '…'` in
 * ordinary strings, so `bookVault.ts`, which names the package three times to
 * say it does NOT import it, read as blocked. `check-mutants` matched
 * `from\s+'(\.[^']+)'`, so a test loading its subject with `await import(…)`
 * covered nothing. Both shared one cause: reading a language with a pattern
 * instead of a parser.
 *
 * ⚠️ **AND THEN THERE WERE TWO PARSES, AND ONLY ONE OF THEM WAS FIXED.**
 * Measured 2026-09-13 against `check-browser-safe`'s `specifiersIn`:
 *
 * - **A template dynamic import was invisible.** `await import(`./later`)`
 *   resolves exactly as the quoted form does, and only `ts.isStringLiteral`
 *   counted. For the browser gate that HIDES AN EDGE: a module reaching the
 *   platform that way passed a pin.
 * - **`import type x = require('./ghost')` counted.** The clause is erased
 *   whole. For the browser gate that INVENTS AN EDGE: a module shipping nothing
 *   of the platform was blocked.
 *
 * `check-mutants` fixed its copy the same day and wrote beside the fix that the
 * other copy still had both. A defect written down as living in a second copy
 * is a defect waiting on somebody to remember it, so there is one copy now, and
 * both gates read through it. Neither spelling is in the tree today, which is
 * how both survived the first parse landing.
 *
 * TYPE-ONLY CLAUSES ARE NOT IMPORTS — `import type`, `export type` and
 * `import type x = require(…)`, which TypeScript always erases. A mixed
 * `import { type A, B }` still needs the module at runtime for `B`, and counts.
 *
 * `fileName` decides the dialect: `<T>(x)` is a cast in `.ts` and an element in
 * `.tsx`, and reading one as the other can lose the import after it.
 */
export function runtimeSpecifiers(source, fileName) {
  /* Stryker disable next-line BooleanLiteral: nothing here reads a parent — the
     walk is `forEachChild`, every test is a `kind`, and every answer is a
     literal's `text` — so a tree built without parent pointers answers the same. */
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = new Set()
  const add = (node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) found.add(node.text)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      /* `import type …` is erased entirely; a bare `import '…'` (no clause) is
         a side effect and very much runs. */
      if (!node.importClause?.isTypeOnly) add(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      /* A template WITH substitutions names no one module, so there is nothing
         to resolve and nothing is claimed. */
      add(erased(node.arguments[0]))
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(tree, visit)
  return found
}

/**
 * Every place a module loads or runs code by a route no static import graph can
 * follow, named in source order — `[]` where there is none.
 *
 * `runtimeSpecifiers` answers each of these with NOTHING, because there is no
 * single module to name, and so does Vitest's `related` filter, which drops a
 * test that reaches its subject only this way. Nothing can say where such a load
 * lands, so what `check-mutants` needs is to know that one is THERE: a test whose
 * route holds one is a test neither it nor Vitest can prove unrelated.
 *
 * - a dynamic `import()` of a computed path;
 * - `require` of a path, or of a computed value — CommonJS never enters Vite's
 *   graph, however literal the path; one of a builtin or a package cannot land
 *   in the checkout's own code, and is not named;
 * - `createRequire()`, whose result may load anything under any name;
 * - `vi.importActual` and `vi.importMock`, which load at run time;
 * - code run from text — `eval`, `new Function`, and `vm`'s runners and `Script`.
 *
 * An import of something that is not a file — an alias, a plugin's `virtual:`
 * module — is a literal specifier and so is not named here: whether it resolves
 * to an installed package is a question about a checkout, which the caller asks.
 */
export function hiddenLoads(source, fileName) {
  /* Stryker disable next-line BooleanLiteral: as in `runtimeSpecifiers` — no
     parent is read, and `getText` is not called — so a tree built without
     parent pointers answers the same. */
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const said = hiddenCall(node)
      if (said !== null) found.push(said)
    } else if (ts.isNewExpression(node)) {
      const built = nameOf(node.expression)
      if (built === 'Function' || built === 'Script') found.push(`new ${built}()`)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(tree, visit)
  return found
}

/** Code run from text, by the name its runner is called. */
const RUNS_TEXT = new Set(['eval', 'runInContext', 'runInNewContext', 'runInThisContext', 'compileFunction'])

/** What one call loads that no import graph shows, or `null` where it loads nothing hidden. */
function hiddenCall(node) {
  const argument = erased(node.arguments[0])
  const text = isLiteral(argument) ? argument.text : null
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return text === null ? 'a computed import()' : null
  const callee = nameOf(node.expression)
  if (callee === 'require' && ts.isIdentifier(node.expression)) {
    if (text === null) return 'a computed require()'
    return text.startsWith('.') || text.startsWith('/') ? `require('${text}')` : null
  }
  /* ⚠️ **`createRequire(x).resolve(y)` LOADS NOTHING — IT ANSWERS A PATH.**
     Flagged on the callee's name alone, it made every module holding one a
     route no static graph can follow, which is right for a require FUNCTION
     that is kept and called (`const req = createRequire(x); req('./thing')` —
     `req` is a name this cannot match, so the catch-all is what covers it) and
     wrong for a resolution. `.resolve` immediately on the call, with a bare
     package specifier, reaches a package and never a file in the checkout —
     the same ground on which `require('<bare package>')` is already not a load,
     two rules up. Anything else about a `createRequire` stays hidden. */
  if (callee === 'createRequire') return resolvesAPackage(node) ? null : 'createRequire()'
  if ((callee === 'importActual' || callee === 'importMock') && isVi(node.expression)) {
    return text === null ? `vi.${callee}()` : `vi.${callee}('${text}')`
  }
  return RUNS_TEXT.has(callee) ? `${callee}()` : null
}

/**
 * Whether this `createRequire(…)` is immediately `.resolve`d on a bare package
 * name — `createRequire(x).resolve('pkg')`, which answers where a package is
 * and loads nothing from the checkout.
 *
 * A specifier that names a PATH is not one: `.resolve('./x')` answers a file in
 * the project, and a route to it is a route the static graph cannot follow.
 */
function resolvesAPackage(node) {
  const access = node.parent
  if (access === undefined || !ts.isPropertyAccessExpression(access) || access.name.text !== 'resolve') return false
  if (access.parent === undefined || !ts.isCallExpression(access.parent) || access.parent.expression !== access) return false
  const asked = erased(access.parent.arguments[0])
  if (!isLiteral(asked)) return false
  return !asked.text.startsWith('.') && !asked.text.startsWith('/')
}

/** The name a callee or a constructor is called by — `b` for both `b` and `a.b` — or `null` for anything else. */
function nameOf(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null
}

/** Whether a callee is a member of `vi`, Vitest's own object. */
function isVi(expression) {
  return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'vi'
}

/** A string the source spells out whole — a quoted one, or a template with nothing substituted in. */
function isLiteral(node) {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
}

/**
 * `node` with every wrapper that cannot change its value taken off: parentheses,
 * and the type-only `as`, `satisfies`, `!` and `<T>`, which the emit erases.
 *
 * ⚠️ **`import(('./x'))` NAMED NO MODULE, BECAUSE ONLY A BARE LITERAL COUNTED.**
 * The parentheses evaluate to the same string and the module loads as it does
 * unwrapped, so the browser gate could not see a platform edge written that way
 * and the mutation gate could not see a test that loads its subject that way.
 * Found by review on 2026-09-14. Only syntax that is gone by the time anything
 * runs is taken off — a conditional or a call still names no single module.
 */
function erased(node) {
  let at = node
  while (
    at !== undefined &&
    (ts.isParenthesizedExpression(at) ||
      ts.isAsExpression(at) ||
      ts.isSatisfiesExpression(at) ||
      ts.isNonNullExpression(at) ||
      ts.isTypeAssertionExpression(at))
  ) {
    at = at.expression
  }
  return at
}
