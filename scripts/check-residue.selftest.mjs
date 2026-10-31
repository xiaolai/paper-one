import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compare, parseAllowList, scan } from './check-residue.mjs'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm residue:selftest` — a gate nobody has watched fail is a comment.
 *
 * Builds a small kernel under a temporary root, plants one naming per case, and
 * runs the real scan and comparison over it. `scripts/check-residue.test.mjs`
 * runs the same cases under Vitest, which is what binds `pnpm verify` and what
 * puts them in the test ledger; this file is the standalone runner, as
 * `boundaries:selftest` is for its own.
 */

const IDS = ['circle', 'public', 'passages']
const ALLOWED = { id: 'circle', file: 'src/kernel/a.ts', match: './circle/log', count: 1, reason: 'held on purpose' }
const CLEAN = "export { a } from './circle/log'\n"

export const CASES = [
  { name: 'a legal tree is clean', files: {}, rows: [ALLOWED], expect: [] },
  { name: 'a planted import path', files: { 'src/kernel/b.ts': "import './core/public/x'\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [public]'] },
  { name: 'a planted path in a template', files: { 'src/kernel/b.ts': 'export const f = (d: string) => `${d}/public/${d}`\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [public]'] },
  { name: 'a planted file name', files: { 'src/kernel/b.ts': "export const p = 'public.jsonl'\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [public]'] },
  { name: 'a planted id-prefixed key', files: { 'src/kernel/b.ts': "export const k = 'circle:shelf'\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted services member', files: { 'src/kernel/b.ts': 'export const f = (env: any) => env.services.passages()\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted key of an object value', files: { 'src/kernel/b.tsx': 'export const o = { circle: { n: 1 } }\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.tsx [circle]'] },
  { name: 'a planted shorthand key', files: { 'src/kernel/b.ts': "const circle = 1\nexport const o = { circle }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted computed key', files: { 'src/kernel/b.ts': "export const o = { ['circle']: { n: 1 } }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted computed key in a bare template', files: { 'src/kernel/b.ts': "export const o = { [`circle`]: { n: 1 } }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted computed method', files: { 'src/kernel/b.ts': "export const o = { ['circle']() {} }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted getter', files: { 'src/kernel/b.ts': "export const o = { get circle() { return 1 } }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted setter', files: { 'src/kernel/b.ts': "export const o = { set circle(_v: number) {} }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted computed getter', files: { 'src/kernel/b.ts': "export const o = { get ['circle']() { return 1 } }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted literal lookup of services', files: { 'src/kernel/b.ts': "export const f = (ctx: any) => ctx['services'].passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted optional literal lookup of services', files: { 'src/kernel/b.ts': "export const f = (ctx: any) => ctx?.['services'].passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted literal lookup on a literal lookup of services', files: { 'src/kernel/b.ts': "export const f = (ctx: any) => ctx['services']['passages']\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted member of parenthesised services', files: { 'src/kernel/b.ts': "export const f = (env: any) => (env.services).passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted member of asserted services', files: { 'src/kernel/b.ts': "export const f = (env: any) => env.services!.passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted member of cast services', files: { 'src/kernel/b.ts': "export const f = (env: any) => (env.services as any).passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted destructuring of services', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  const { passages } = env.services\n  return passages\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted renaming destructuring of services', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  const { passages: p } = env['services']\n  return p\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a second naming on an allowed row', files: { 'src/kernel/a.ts': `${CLEAN}${CLEAN}` }, rows: [ALLOWED], expect: ['COUNT src/kernel/a.ts [circle]'] },
  { name: 'a row whose naming has gone', files: { 'src/kernel/a.ts': 'export const a = 1\n' }, rows: [ALLOWED], expect: ['STALE src/kernel/a.ts [circle]'] },
  {
    name: 'a row for an id cut from the manifest is inert',
    files: {},
    rows: [ALLOWED, { ...ALLOWED, id: 'gone', match: './gone/x' }],
    expect: [],
    inert: 1,
  },
  {
    name: 'the bare word, a comment, a test and a type member are not namings',
    files: {
      'src/kernel/b.tsx':
        "// './core/public/x' and services.circle\n" +
        "/* circle: { } */\n" +
        "export type T = { readonly circle: string; public: number }\n" +
        "export const f = (passages: string, circle = 'circle') => <p>don't say circle: {passages}{circle}</p>\n",
      'src/kernel/c.ts':
        "export const f = (circle: string, other: any) => {\n" +
        "  const { passages } = other\n" +
        "  const { passages: renamed } = other['elsewhere']\n" +
        "  return [{ [circle]: 1, [other.circle]: 2 }, other['elsewhere'].passages, other.services[circle], passages, renamed]\n" +
        "}\n" +
        "export class C { get circle() { return 1 } }\n" +
        "export type U = { get circle(): string }\n",
      'src/kernel/b.test.ts': "import './core/public/x'\n",
      'src/kernel/b.testkit.ts': "import './core/public/y'\n",
    },
    rows: [ALLOWED],
    expect: [],
  },
]

/** `{ name, problems }`: empty when the case behaved. */
export function runCase(testCase) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'residue-selftest-')))
  try {
    for (const [file, text] of Object.entries({ 'src/kernel/a.ts': CLEAN, ...testCase.files })) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    const { findings, inert } = compare(scan(root, IDS), parseAllowList(JSON.stringify({ rows: testCase.rows })), IDS)
    const problems = []
    if (findings.length !== testCase.expect.length) problems.push(`expected ${testCase.expect.length} finding(s), got: ${findings.join(' | ') || 'none'}`)
    testCase.expect.forEach((prefix, index) => {
      if (!findings[index]?.startsWith(prefix)) problems.push(`expected "${prefix}…", got "${findings[index]}"`)
    })
    if (inert !== (testCase.inert ?? 0)) problems.push(`expected ${testCase.inert ?? 0} inert row(s), got ${inert}`)
    return { name: testCase.name, problems }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (isProcessEntry(import.meta)) {
  const results = CASES.map(runCase)
  for (const { name, problems } of results) process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${name}\n${problems.map((one) => `     ${one}\n`).join('')}`)
  process.exitCode = results.every(({ problems }) => problems.length === 0) ? 0 : 1
}
