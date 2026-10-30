import { NOTHING_SPENT, charge, type Budget, type Spend } from '../../../kernel'

/**
 * The per-person spend ledger — one for the run, shared by the round and the
 * jackets (WI-23.C5), so both draw on one budget.
 *
 * ⚠️ **`charge` IS THE ONE WAY TO SPEND.** It reads, decides and commits in a
 * single synchronous step, so two callers with awaits between their reads
 * and their writes — a round and a jacket — cannot each write back a total
 * that forgot the other's charge. The `spend`/`spent` pair it replaced was
 * exactly that: a snapshot held across the awaits, written back over the
 * other side's charge. `spend` is a read, for a report and for a test.
 */
export interface SpendLedger {
  readonly spend: (person: string) => Spend
  readonly charge: (person: string, key: string, bytes: number, now: number, budget?: Budget) => boolean
}

export function createSpendLedger(): SpendLedger {
  const held = new Map<string, Spend>()
  return {
    spend: (person) => held.get(person) ?? NOTHING_SPENT,
    charge: (person, key, bytes, now, budget) => {
      const charged = charge(held.get(person) ?? NOTHING_SPENT, key, bytes, now, budget)
      if (charged.allowed) held.set(person, charged.spend)
      return charged.allowed
    },
  }
}
