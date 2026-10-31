import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm residue:check` — the kernel may not know a capability's name unless a
 * row here says why.
 *
 * `boundaries` refuses a kernel IMPORT of a capability, and that is all it can
 * see. A capability can be cut by `capability:remove` while the kernel still
 * holds its storage path, its service slot or its confinement rule, and every
 * other gate stays green, because a name is not an edge. So this reads what the
 * kernel names and compares it against an allow-list, in which each row carries
 * its reason.
 *
 * WHAT COUNTS AS NAMING, and it is deliberately not the bare word: `cards` alone
 * hits 130 times in 21 files and is ordinary kernel vocabulary, and `peer` and
 * `voices` are parameter names. For a manifest id `<id>`:
 *
 *   - a literal holding it as a path segment: `./circle/log`, `/circle`, `sync/x`;
 *   - a literal with `<id>:` or `<id>.` at its start or after a slash:
 *     `sync:presence`, `/public.jsonl`;
 *   - `services.<id>`, however it is reached: `ctx['services']['circle']`,
 *     `(env.services!).circle`, `const { circle } = env.services`,
 *     `({ services: { circle } }) => …`, `const s = env.services; s.circle`,
 *     `(s: KernelServices) => s.circle`. See `namingsIn` for the whole of it;
 *   - `<id>` as a key of an object VALUE, however it is written: `circle: { … }`,
 *     `{ circle }`, `{ ['circle']: … }`, `circle() {}`, `get circle() {}`. A member
 *     of a type is not one, since a type holds no behaviour for a cut capability
 *     to orphan.
 *
 * WHAT IT CANNOT SEE: a key that is computed (`services[key]`, `'cir' + 'cle'`),
 * services returned by a call or handed under another name and type
 * (`getServices().circle`, `Reflect.get(services, 'circle')`), and a class member,
 * a JSX attribute or an enum member, which are not the keys of an object value.
 *
 * A literal equal to the id and nothing more (`'circle'`) is not matched: the
 * shapes above are the ones the plan fixed, and `core/capability.ts` shows why a
 * bare token needs care, since its icon list holds ordinary words.
 *
 * THE SOURCE IS PARSED, NOT REGEXED, because the shared `stripComments` is a
 * small lexer that takes an apostrophe in JSX text for an opening quote, and from
 * there can read a real string as code and drop the rest of its line. A comment
 * is not a node here, so there is nothing to strip. Tests and test kits are not
 * read: they ship nothing, and `boundaries` holds what they import.
 *
 * A RATCHET, IN BOTH DIRECTIONS. A match with no row, or more matches than the
 * row's `count`, is a finding. So is a row whose matches have gone (`STALE`), or
 * the allow-list could only grow. The one exception is a row for an id the
 * manifest does not declare: `verify:without <id>` cuts the id and may not touch
 * the kernel, so the name stays where it was and is no longer anybody's. Such a
 * row is inert, because only manifest ids are ever searched, and it is counted in
 * the summary.
 *
 * Findings one per line, then a summary; exit 0 when clean, 1 on a finding, 2 on
 * a usage error or an unreadable input.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-residue.mjs [--root <dir>]'
const MANIFEST = 'capabilities.manifest.json'
const KERNEL = 'src/kernel'
export const ALLOW_LIST = 'scripts/residue-allowlist.json'

const isSource = (file) => /\.tsx?$/.test(file) && !/\.(test|testkit)\.tsx?$/.test(file) && !file.endsWith('.d.ts')

function sourcesUnder(dir, into = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) sourcesUnder(full, into)
    else if (isSource(full)) into.push(full)
  }
  return into
}

/** The literal's text, for every node that holds some, or null. */
function literalText(node) {
  return ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ? node.text
    : null
}

/** `x`, `x!`, `(x)`, `x as T`, `x satisfies T`: the expression under its wrappers. */
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

/** A type that is the kernel's services, or is cut from them: `KernelServices`, `Pick<KernelServices, 'a'>`. */
function namesServicesType(type) {
  if (!ts.isTypeReferenceNode(type)) return false
  const called = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text
  return called === 'KernelServices' || (type.typeArguments ?? []).some(namesServicesType)
}

/** The text of a key that says it: `a`, `'a'`, `['a']`. Null for `[a]`, which could be anything. */
function keyText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) ? name.expression.text : null
}

/** Whether an object literal is the left of an assignment, so its keys read rather than write. */
function isDestructuringTarget(literal) {
  let node = literal
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent
  const parent = node.parent
  if (ts.isBinaryExpression(parent)) return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  return ts.isPropertyAssignment(parent) && parent.initializer === node && isDestructuringTarget(parent.parent)
}

const isObjectMember = (node) =>
  (ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)) &&
  ts.isObjectLiteralExpression(node.parent) &&
  !isDestructuringTarget(node.parent)

/** The one file, its scopes bound and nothing else: no library, no resolving. */
function scopesOf(text, fileName) {
  const options = { noResolve: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, noEmit: true }
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)
  const host = {
    ...ts.createCompilerHost(options),
    getSourceFile: (name) => (name === fileName ? source : undefined),
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? text : undefined),
    getCurrentDirectory: () => '',
  }
  return { source, checker: ts.createProgram([fileName], options, host).getTypeChecker() }
}

/**
 * Every naming of an id in one file's text: `{ id, match }`, one per occurrence.
 * `match` is what a row quotes: the literal's whole text, `services.<id>`, or
 * `<id>:`.
 *
 * WHAT HOLDS THE SERVICES IS A BINDING, and the compiler's scopes say which. It is
 * an expression ending in the name, a binding of the kernel's services type, or
 * whatever was filled from one of those: by a declaration, a default, an assignment
 * or a pattern. In a pattern over the services every key is a naming and the rest is
 * another holder; in a pattern over anything else a `services` key is one, at any
 * depth. Run until nothing changes, because an alias can be written above the one
 * it copies.
 */
export function namingsIn(text, fileName, ids) {
  const known = new Set(ids)
  const found = []
  const inLiteral = ids.map((id) => ({ id, shape: new RegExp(`(?:^|/)${id}(?:[:./]|$)`) }))
  const { source, checker } = scopesOf(text, fileName)

  const holders = new Set()
  /* A pattern is met again on every pass, and a key is one naming however often. */
  const named = new Set()
  let changed = false

  const hold = (identifier) => {
    const symbol = checker.getSymbolAtLocation(identifier)
    if (symbol === undefined || holders.has(symbol)) return
    holders.add(symbol)
    changed = true
  }
  const name = (key, at) => {
    if (key === null || !known.has(key) || named.has(at)) return
    named.add(at)
    found.push({ id: key, match: `services.${key}` })
  }
  const isServices = (node) => {
    const inner = unwrapped(node)
    if (ts.isIdentifier(inner)) return inner.text === 'services' || holders.has(checker.getSymbolAtLocation(inner))
    if (ts.isPropertyAccessExpression(inner)) return inner.name.text === 'services'
    return ts.isElementAccessExpression(inner) && literalKeys(inner.argumentExpression).includes('services')
  }
  /** A binding name or an assignment target that takes the services. */
  const takeServices = (target) => {
    if (ts.isIdentifier(target)) hold(target)
    else if (ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) {
        if (element.dotDotDotToken) takeServices(element.name)
        else name(keyText(element.propertyName ?? element.name), element)
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const member of target.properties) {
        if (ts.isSpreadAssignment(member)) takeServices(unwrapped(member.expression))
        else name(keyText(member.name), member)
      }
    }
  }

  const flows = []
  const servicesKeys = []
  const typed = []
  const scanForScopes = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      if (node.initializer) flows.push([node.name, node.initializer])
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.type && namesServicesType(node.type)) typed.push(node.name)
    if (ts.isBindingElement(node) && !node.dotDotDotToken && keyText(node.propertyName ?? node.name) === 'services') servicesKeys.push(node.name)
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && isDestructuringTarget(node.parent) && keyText(node.name) === 'services') {
      servicesKeys.push(unwrapped(node.initializer))
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) flows.push([unwrapped(node.left), node.right])
    ts.forEachChild(node, scanForScopes)
  }
  scanForScopes(source)

  do {
    changed = false
    for (const target of servicesKeys) takeServices(target)
    for (const target of typed) takeServices(target)
    for (const [target, from] of flows) if (isServices(from)) takeServices(target)
  } while (changed)

  const visit = (node) => {
    const literal = literalText(node)
    if (literal !== null) {
      for (const { id, shape } of inLiteral) {
        /* The id alone, with no slash and nothing after it, is the bare token. */
        if (literal !== id && shape.test(literal)) found.push({ id, match: literal })
      }
    }
    if (ts.isPropertyAccessExpression(node) && isServices(node.expression)) name(node.name.text, node)
    if (ts.isElementAccessExpression(node) && isServices(node.expression)) {
      for (const key of literalKeys(node.argumentExpression)) if (known.has(key)) found.push({ id: key, match: `services.${key}` })
    }
    if (isObjectMember(node)) {
      const key = keyText(node.name)
      if (key !== null && known.has(key)) found.push({ id: key, match: `${key}:` })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Every naming under the kernel, as a map of `file\0id\0match` to its count. */
export function scan(root, ids) {
  const files = sourcesUnder(path.join(root, KERNEL))
  /* A walk that found nothing would report every row stale, or with no rows
     report clean. Neither is an answer. */
  if (files.length === 0) throw new Error(`${KERNEL}: no source files under ${root}`)
  const counts = new Map()
  for (const full of files) {
    const file = path.relative(root, full).split(path.sep).join('/')
    for (const { id, match } of namingsIn(readFileSync(full, 'utf8'), file, ids)) {
      const key = JSON.stringify([file, id, match])
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

/** Rows from the allow-list's text. Throws on any shape it does not understand. */
export function parseAllowList(text) {
  const body = JSON.parse(text)
  if (!Array.isArray(body?.rows)) throw new Error(`${ALLOW_LIST}: no rows array`)
  const seen = new Set()
  for (const row of body.rows) {
    const where = `${ALLOW_LIST}: ${JSON.stringify(row)}`
    for (const field of ['id', 'file', 'match', 'reason']) {
      if (typeof row?.[field] !== 'string' || row[field].trim() === '') throw new Error(`${where}: needs a non-empty ${field}`)
    }
    if (!Number.isInteger(row.count) || row.count < 1) throw new Error(`${where}: count must be a positive integer`)
    const key = JSON.stringify([row.file, row.id, row.match])
    if (seen.has(key)) throw new Error(`${where}: duplicate row`)
    seen.add(key)
  }
  return body.rows
}

/** `{ findings, inert, occurrences }`, comparing a scan against the rows. */
export function compare(counts, rows, ids) {
  const known = new Set(ids)
  const findings = []
  const remaining = new Map(counts)
  let inert = 0
  for (const row of rows) {
    if (!known.has(row.id)) {
      inert++
      continue
    }
    const key = JSON.stringify([row.file, row.id, row.match])
    const count = remaining.get(key) ?? 0
    remaining.delete(key)
    const named = `${row.file} [${row.id}] ${JSON.stringify(row.match)}`
    if (count === 0) findings.push(`STALE ${named}: the kernel no longer names this; delete the row`)
    else if (count !== row.count) findings.push(`COUNT ${named}: ${count} in the source, ${row.count} on the row`)
  }
  for (const [key, count] of remaining) {
    const [file, id, match] = JSON.parse(key)
    findings.push(`NEW ${file} [${id}] ${JSON.stringify(match)} x${count}: the kernel names a capability; remove it, or add a row with its reason`)
  }
  const occurrences = [...counts.values()].reduce((sum, count) => sum + count, 0)
  return { findings: findings.sort(), inert, occurrences }
}

/** `{ root }` or `{ error }`. Anything not understood is an error. */
export function parseArgs(argv, cwd = process.cwd()) {
  let root
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--root') return { error: `unknown argument ${JSON.stringify(argv[i])}` }
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) return { error: '--root needs a directory' }
    if (root !== undefined) return { error: '--root given twice' }
    root = path.resolve(cwd, value)
  }
  return { root: root ?? REPO_ROOT }
}

/** Exit code; prints findings and a summary. */
export function main(argv) {
  const args = parseArgs(argv)
  if ('error' in args) {
    process.stderr.write(`check-residue: ${args.error}\n${USAGE}\n`)
    return 2
  }
  let result
  let rows
  try {
    const manifest = JSON.parse(readFileSync(path.join(args.root, MANIFEST), 'utf8'))
    const ids = manifest.capabilities.map((entry) => entry.id)
    rows = parseAllowList(readFileSync(path.join(args.root, ALLOW_LIST), 'utf8'))
    result = compare(scan(args.root, ids), rows, ids)
  } catch (cause) {
    process.stderr.write(`check-residue: ${cause?.message ?? String(cause)}\n`)
    return 2
  }
  for (const finding of result.findings) process.stdout.write(`${finding}\n`)
  const inert = result.inert === 0 ? '' : `; ${result.inert} for an id not in the manifest, ignored`
  process.stdout.write(`check-residue: ${rows.length} rows, ${result.occurrences} namings${inert}; ${result.findings.length} finding(s)\n`)
  return result.findings.length === 0 ? 0 : 1
}

if (isProcessEntry(import.meta)) process.exitCode = main(process.argv.slice(2))
