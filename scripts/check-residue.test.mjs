import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main, parseAllowList, parseArgs, scan, UNFOLLOWED } from './check-residue.mjs'
import { CASES, runCase } from './check-residue.selftest.mjs'

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
/** A root holding these files and nothing else. */
const tree = (files) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'residue-')))
  roots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}
const IDS = ['circle', 'public', 'passages']
const B = 'src/kernel/b.tsx'
const TYPE = "import type { KernelServices } from './core/services'\n"
/** Every naming a scan finds, as `[file, id, match, count]`. */
const scanned = (files, ids = IDS) => [...scan(tree(files), ids)].map(([key, count]) => [...JSON.parse(key), count])
const named = (id, match) => [B, id, match, 1]
const refused = (match) => [B, UNFOLLOWED, match, 1]

describe('check-residue on a planted tree', () => {
  /* A LOOP OVER CASES IS NOT A TEST NAMED FOR EACH, so each gets its own name,
     which is what the test ledger holds. */
  for (const testCase of CASES) {
    it(testCase.name, () => {
      expect(runCase(testCase).problems).toEqual([])
    })
  }
})

describe('the allow-list', () => {
  const row = { id: 'circle', file: 'src/kernel/a.ts', match: './circle/log', count: 1, reason: 'held on purpose' }

  it('refuses a row with no reason, a bad count, a duplicate, or no rows at all', () => {
    expect(() => parseAllowList(JSON.stringify({ rows: [{ ...row, reason: ' ' }] }))).toThrow(/reason/)
    expect(() => parseAllowList(JSON.stringify({ rows: [{ ...row, count: 0 }] }))).toThrow(/count/)
    expect(() => parseAllowList(JSON.stringify({ rows: [row, row] }))).toThrow(/duplicate/)
    expect(() => parseAllowList('{}')).toThrow(/rows/)
  })
})

describe('the command', () => {
  it('passes on this tree, whose allow-list matches it', () => {
    expect(main([])).toBe(0)
  })

  it('refuses arguments it does not understand and a root with no kernel', () => {
    expect(parseArgs(['--root'])).toHaveProperty('error')
    expect(parseArgs(['--write'])).toHaveProperty('error')
    expect(parseArgs(['--root', 'a', '--root', 'b'])).toHaveProperty('error')
    expect(main(['--nope'])).toBe(2)
    expect(main(['--root', '/nonexistent-residue-root'])).toBe(2)
  })
})

/* EACH OF THESE THE SCAN ONCE PASSED IN SILENCE. */
describe('forms the scan once missed', () => {
  /* An exported pattern exports every name it binds, past a hole. */
  it('refuses the services exported through a pattern', () => {
    expect(scanned({ [B]: 'const services: any = 1\nexport const [s] = [services]\nexport const { t } = { t: services }\nexport const [, u] = [1, services]\n' })).toEqual([
      refused('the services, exported under another name: s'),
      refused('the services, exported under another name: t'),
      refused('the services, exported under another name: u'),
    ])
  })
})
