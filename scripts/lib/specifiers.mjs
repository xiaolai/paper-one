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
