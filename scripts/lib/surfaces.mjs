import ts from 'typescript'

/**
 * The rules behind `scripts/surfaces.mjs` — everything about WHAT a surface is,
 * with no module evaluation and no filesystem.
 *
 * PURE, and split out for the reason `lib/ledger.mjs` was: `surfaces.mjs`
 * registers a loader hook at import time, and a test that wants to check the
 * capability reader should not have to install a resolver into its own runtime
 * to do it. Everything here takes a string and returns a value.
 */

/**
 * The seams a capability may contribute to.
 *
 * ⚠️ **`commands` IS DELIBERATELY ABSENT AND THE FIRST VERSION OF THIS COMMENT
 * DID NOT SAY SO.** `core/capability.ts` declares ten seams; `services` and
 * `clients` are named by the service table and collected from there, and
 * `commands` is a FUNCTION (`(ctx) => Command[]`) rather than an array literal,
 * so `seamOpensAt` — which requires `seam: [` — does not reach it.
 *
 * ⚠️ **AND "there is no `id:` to read" WAS WRONG, WHICH A SECOND AUDIT
 * CORRECTED.** `commands: (ctx) => [{ id: 'x:real' }]` plainly contains one;
 * what is true is that this reader does not look inside a factory, and a
 * factory can build ids conditionally or from its context, so reading the
 * literals would report a list the app may never produce. Seven is therefore
 * right and "ten minus two" was wrong arithmetic. **No capability contributes
 * commands today**, so this is a latent gap, recorded rather than papered over
 * by pretending the seam is unreadable in principle.
 */
export const CONTRIBUTION_SEAMS = Object.freeze([
  'panes',
  'screens',
  'settings',
  'bookActions',
  'bookStatuses',
  'markControls',
  'overlays',
])

/**
 * Every contribution id a capability declares, by seam.
 *
 * ⚠️ **A READ, NOT AN EVALUATION, AND THE READ IS AN AST.** The capability
 * index modules import `.tsx` components, and Node's type stripping has no JSX,
 * so they cannot be evaluated — measured 2026-09-10 on node v24.18.0, where
 * `--experimental-transform-types` gets past the parameter property in that
 * graph and then stops at `Unknown file extension ".tsx"`.
 *
 * ⚠️ **TWO HAND-ROLLED SCANNERS WERE TRIED FIRST AND BOTH WERE REFUTED WITH
 * REPRODUCTIONS.** A flat regex took the `id` of every object a `render`
 * builds. A bracket counter that skipped strings and comments still
 * miscounted on regex literals (`/\}/`), on nested template substitutions
 * (`` `outer ${`}`}` ``) and on an apostrophe inside a regex (`/'/`), each of
 * which could silently attribute a nested `id` to the capability. A shape
 * filter was then added to contain that, and it failed BOTH ways: a nested
 * `id: "book:moby"` passes it, and a legitimate `x:reader2` was dropped
 * without a word — `PaneId` is `${string}:${string}`, so digits are legal.
 *
 * **Lexing JavaScript by hand is the wrong tool and the audit said so twice.**
 * `typescript` is already a direct dependency (5.9), so the parser that builds
 * this app reads it here too. Ownership is then exact rather than inferred:
 * an `id` counts when it is a property of an object literal that is a DIRECT
 * ELEMENT of the seam's array, which is a question an AST answers and a
 * character scanner can only estimate.
 */
export function contributionsIn(source) {
  /* ⚠️ **`ScriptKind.TS`, NOT `TSX` — FORCING TSX REJECTED VALID TYPESCRIPT.**
     Under TSX a generic arrow's `<T>` parses as a JSX tag, so
     `const identity = <T>(value: T) => value` reported parse diagnostics and
     this threw over a file `tsc` reads without complaint. Every capability
     input is `index.ts`; the components they import are `.tsx` and are never
     read here. Caught by the round 3 verification as a regression the AST
     rewrite introduced. */
  const file = ts.createSourceFile('capability.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  /* ⚠️ **TypeScript's PARSER RECOVERS, AND RECOVERY IS THE DANGEROUS ANSWER
     HERE.** Handed a truncated file it returns a tree anyway, so a capability
     cut off mid-array would yield a SHORT list rather than an error — the
     scanner it replaced at least threw. `parseDiagnostics` is not public API
     but is stable and is what `tsc` itself reports from; an empty-array
     fallback would restore exactly the silence this whole tool exists to end. */
  const trouble = file.parseDiagnostics ?? []
  if (trouble.length > 0) {
    const first = ts.flattenDiagnosticMessageText(trouble[0].messageText, ' ')
    throw new Error(
      `surfaces: the capability source does not parse (${first}) — refusing to report a partial inventory from it`,
    )
  }
  const out = {}
  for (const seam of CONTRIBUTION_SEAMS) {
    const array = seamArray(file, seam)
    if (array === null) continue
    out[seam] = array.elements.filter(ts.isObjectLiteralExpression).map(idOf).filter((id) => id !== null)
  }
  return out
}

/** The literal name of a property, whatever quoting it was written with. */
const nameOf = (property) => {
  const n = property.name
  if (n === undefined) return null
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  return null
}

/** A direct element's own `id`, or null when it does not declare one. */
function idOf(element) {
  for (const property of element.properties) {
    if (!ts.isPropertyAssignment(property) || nameOf(property) !== 'id') continue
    const value = property.initializer
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
    /* A computed id is not a literal this can read. Reported as a refusal
       rather than skipped, because "no id" and "an id I cannot see" are
       different facts and only one of them is harmless. */
    throw new Error(
      `surfaces: a contribution declares a non-literal id (${value.getText(element.getSourceFile()).slice(0, 60)}) — ` +
        'this reader only understands string literals, and guessing would put a name in the inventory that the app never uses',
    )
  }
  return null
}

/**
 * The array literal assigned to `seam` on the exported capability object.
 *
 * Walks only the TOP-LEVEL properties of exported object literals, so a seam
 * named inside a nested helper — or inside a `render` — is not mistaken for the
 * capability's own. Indentation, quoting and formatting are irrelevant to an
 * AST, which is the point.
 */
function seamArray(file, seam) {
  let found = null
  const visit = (node) => {
    if (found !== null) return
    if (ts.isObjectLiteralExpression(node) && isExported(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || nameOf(property) !== seam) continue
        if (ts.isArrayLiteralExpression(property.initializer)) found = property.initializer
      }
      if (found !== null) return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

/**
 * Is this object literal the one an `export const` names — DIRECTLY?
 *
 * ⚠️ **THE FIRST AST VERSION WALKED UP UNTIL IT FOUND AN EXPORT, AND THAT IS
 * NOT THE SAME QUESTION.** Every nested literal inside an exported capability
 * also reaches that export, so `public`'s pane — which carries
 * `screens: ['reader']`, meaning *this pane appears on the reader screen* — was
 * read as the capability contributing a `screens` seam. It produced an empty
 * list rather than a wrong one only because those elements are strings, and
 * `circle` escaped by declaring its real `screens` earlier in the file. Caught
 * by diffing the AST walk's output against the scanner's before trusting it.
 *
 * The literal must be the declaration's own initializer, through nothing but
 * `as`, `satisfies` and parentheses.
 */
function isExported(node) {
  let at = node.parent
  while (
    at !== undefined &&
    (ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isParenthesizedExpression(at))
  ) {
    at = at.parent
  }
  if (at === undefined || !ts.isVariableDeclaration(at)) return false
  const statement = at.parent?.parent
  if (statement === undefined || !ts.isVariableStatement(statement)) return false
  return statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/**
 * The flat set of names a ledger is expected to mention.
 *
 * ⚠️ **EVERY FIELD OF A SURFACES OBJECT IS EITHER INCLUDED OR EXCLUDED HERE BY
 * NAME, AND THAT IS THE POINT.** The first version listed nine includes and
 * silently dropped whatever it did not mention — an audit found `spacingAxes`,
 * `aligns` and `acceptFormats` disappearing before coverage ran, with no stated
 * reason for any of them. A field nobody decided about is exactly the "surface
 * with no row" failure this tool exists to catch, reproduced one level up.
 *
 * `EXCLUDED` therefore carries a reason per field, and `namesOf` throws when a
 * surfaces object has a field in neither list — so adding one to
 * `collectSurfaces` forces a decision rather than a silent omission.
 */
const INCLUDED = Object.freeze([
  'kernelSettings',
  'readingStyle',
  'panes',
  'services',
  'markTints',
  'markStyles',
  'cardKinds',
  'themes',
  'bundledFaces',
  'spacingAxes',
  'aligns',
  'acceptFormats',
])

const EXCLUDED = Object.freeze({
  readingSteps: 'fourteen integers; a document containing "15" proves nothing about whether the size ladder is described',
  paneShortcuts: 'carries a ⌘ glyph and a pane id already covered by `panes`',
  readerStyles: 'a subset of `markStyles`',
  allFaces: 'a superset of `bundledFaces` whose extra members are probed at runtime and may legitimately never be described',
  unfinishedPanes: 'a subset of `panes`',
  capabilities: 'walked separately below, seam by seam',
})

export function namesOf(surfaces) {
  const unclassified = Object.keys(surfaces).filter((k) => !INCLUDED.includes(k) && !(k in EXCLUDED))
  if (unclassified.length > 0) {
    throw new Error(
      `surfaces: ${unclassified.join(', ')} is neither included in nor excluded from coverage — ` +
        'add it to INCLUDED or give it a reason in EXCLUDED, so a new registry cannot fall out silently',
    )
  }
  const names = new Set()
  const add = (xs) => {
    for (const x of xs) names.add(x)
  }
  for (const field of INCLUDED) add(surfaces[field])
  for (const seams of Object.values(surfaces.capabilities)) {
    for (const ids of Object.values(seams)) add(ids)
  }
  return [...names].sort()
}
