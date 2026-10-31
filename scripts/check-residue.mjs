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
 *   - `services.<id>`, however it is reached;
 *   - `<id>` as a key of an object VALUE: `circle: { … }`. A member of a type is
 *     not one, since a type holds no behaviour for a cut capability to orphan.
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

/** `services`, `env.services`, `ctx?.services`: an expression ending in that name. */
const endsInServices = (node) =>
  (ts.isIdentifier(node) && node.text === 'services') ||
  (ts.isPropertyAccessExpression(node) && node.name.text === 'services')

/**
 * Every naming of an id in one file's text: `{ id, match }`, one per occurrence.
 * `match` is what a row quotes: the literal's whole text, `services.<id>`, or
 * `<id>:`.
 */
export function namingsIn(text, fileName, ids) {
  const known = new Set(ids)
  const found = []
  const inLiteral = ids.map((id) => ({ id, shape: new RegExp(`(?:^|/)${id}(?:[:./]|$)`) }))
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)

  const visit = (node) => {
    const literal = literalText(node)
    if (literal !== null) {
      for (const { id, shape } of inLiteral) {
        /* The id alone, with no slash and nothing after it, is the bare token. */
        if (literal !== id && shape.test(literal)) found.push({ id, match: literal })
      }
    }
    if (ts.isPropertyAccessExpression(node) && known.has(node.name.text) && endsInServices(node.expression)) {
      found.push({ id: node.name.text, match: `services.${node.name.text}` })
    }
    if (ts.isElementAccessExpression(node) && endsInServices(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
      const id = node.argumentExpression.text
      if (known.has(id)) found.push({ id, match: `services.${id}` })
    }
    if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && ts.isObjectLiteralExpression(node.parent)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : null
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
