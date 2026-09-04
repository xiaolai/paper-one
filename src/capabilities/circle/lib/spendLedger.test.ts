import { describe, expect, it } from 'vitest'
import { DEFAULT_BUDGET } from '../../../kernel'
import { createSpendLedger } from './spendLedger'

/**
 * The one ledger the round and the jackets charge — and the property the old
 * `spend`/`spent` pair did not have: two callers holding a read across their
 * awaits cannot each write back a total that forgot the other's charge.
 */

const ALICE = 'a1'.repeat(32)
const NOW = 1_700_000_000_000

describe('one ledger, two callers', () => {
  it('charges in one step, so a round and a jacket interleaved across awaits both land', async () => {
    const ledger = createSpendLedger()
    /* Each side reads, awaits something — a page parsing, a chunk arriving — and charges. */
    const round = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve()
        expect(ledger.charge(ALICE, 'book:moby', 100, NOW)).toBe(true)
      }
    }
    const jacket = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve()
        expect(ledger.charge(ALICE, 'cover', 50, NOW)).toBe(true)
      }
    }
    await Promise.all([round(), jacket()])
    expect(ledger.spend(ALICE).total).toBe(10 * 100 + 10 * 50)
    expect(ledger.spend(ALICE).byWork).toEqual({ 'book:moby': 1_000, cover: 500 })
  })

  it('refuses past the budget and records nothing for a refused charge', () => {
    const ledger = createSpendLedger()
    expect(ledger.charge(ALICE, 'cover', DEFAULT_BUDGET.perPeer + 1, NOW)).toBe(false)
    expect(ledger.spend(ALICE).total).toBe(0)
    expect(ledger.charge(ALICE, 'cover', 1, NOW)).toBe(true)
    expect(ledger.spend(ALICE).total).toBe(1)
  })
})
