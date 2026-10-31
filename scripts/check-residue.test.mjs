import { describe, expect, it } from 'vitest'
import { main, parseAllowList, parseArgs } from './check-residue.mjs'
import { CASES, runCase } from './check-residue.selftest.mjs'

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
