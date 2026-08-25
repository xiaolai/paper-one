import { describe, expect, it } from 'vitest'
import { PAGE_BYTES, PAGE_ROWS, pages } from './services/paging'
import { ENVELOPE_VERSION, MAX_PAYLOAD_BYTES, encodeFrame } from './envelope'

/**
 * THE PAGER'S BUDGET, AGAINST THE FRAME THAT HAS TO CARRY IT.
 *
 * `pages` decides a page is full at `PAGE_BYTES` of `JSON.stringify(row).length`
 * — UTF-16 code units, measured on the row alone. The transport refuses a
 * frame past `MAX_PAYLOAD_BYTES` of encoded UTF-8, measured on the whole
 * envelope. Those are two different quantities, and the pager's tests were all
 * in the pager's own units: row counts, and a coarse "more than one page for
 * big rows". Nothing anywhere asked whether a page the pager considers legal
 * can actually be SENT.
 *
 * It matters most for text that is not ASCII, which is most of a reading app's
 * content: one Han character is 1 code unit and 3 UTF-8 bytes, so a page can
 * be a third of the budget by the pager's measure and past it on the wire.
 * This file lives under `peer/` because that is the only place the real
 * encoder may be imported from.
 */

const signal = new AbortController().signal

async function all<T>(iterable: AsyncIterable<readonly T[]>): Promise<(readonly T[])[]> {
  const out: (readonly T[])[] = []
  for await (const page of iterable) out.push(page)
  return out
}

/** The whole frame this page would cross as, in bytes. */
const framed = (page: readonly unknown[]): number =>
  encodeFrame({ v: ENVELOPE_VERSION, kind: 'res', service: 'book.list', id: 'r1', body: page }).byteLength

describe('every page the pager produces can be encoded', () => {
  it('encodes a page filled to the exact byte boundary', async () => {
    /* Rows sized so the budget is met precisely rather than overshot: the
     * off-by-one at a boundary is the failure a coarse test cannot see. */
    const per = 1_000
    const row = (index: number) => ({ id: index, text: 'x'.repeat(per) })
    const count = Math.ceil(PAGE_BYTES / JSON.stringify(row(0)).length) + 2
    const got = await all(pages(Array.from({ length: count }, (_one, index) => row(index)), signal))
    expect(got.length).toBeGreaterThan(1)
    for (const page of got) {
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(PAGE_BYTES)
      expect(framed(page)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    }
  })

  /**
   * MULTIBYTE TEXT, which is where the two measures part company.
   *
   * A page of Han characters is three times its code-unit size once encoded.
   * The margin between `PAGE_BYTES` (512 KiB) and `MAX_PAYLOAD_BYTES` (4 MiB)
   * is what absorbs that — eight times over — and this is the assertion that
   * the margin is really there rather than assumed.
   */
  it('encodes a page of non-ASCII text well inside the frame', async () => {
    const row = (index: number) => ({ id: index, text: '書'.repeat(1_000) })
    const count = Math.ceil(PAGE_BYTES / JSON.stringify(row(0)).length) + 2
    const got = await all(pages(Array.from({ length: count }, (_one, index) => row(index)), signal))
    expect(got.length).toBeGreaterThan(1)
    for (const page of got) {
      const units = JSON.stringify(page).length
      const bytes = framed(page)
      expect(units).toBeLessThanOrEqual(PAGE_BYTES)
      /* The encoding really did expand it — otherwise this measures ASCII. */
      expect(bytes).toBeGreaterThan(units * 2)
      expect(bytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    }
  })

  /* A FULL PAGE OF THE WIDEST ROWS the row cap allows, encoded. `PAGE_ROWS`
   * and `PAGE_BYTES` bound a page in two different ways, and this is the
   * corner where both are near their limit at once. */
  it('encodes a page that is full by rows AND near full by bytes', async () => {
    const per = Math.floor(PAGE_BYTES / PAGE_ROWS) - 40
    const rows = Array.from({ length: PAGE_ROWS }, (_one, index) => ({ id: index, text: '書'.repeat(Math.floor(per / 3)) }))
    const got = await all(pages(rows, signal))
    expect(got[0]).toHaveLength(PAGE_ROWS)
    expect(framed(got[0] as unknown[])).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
  })

  /**
   * A ROW NO PAGE CAN CARRY IS REFUSED BY NAME, not handed to the transport.
   *
   * Inputs are bounded, so this should be unreachable; if it ever fires, the
   * message says how big the row was and what the budget is — rather than the
   * caller receiving a generic wire error for a specific, nameable problem.
   */
  it('refuses a single row past the page budget rather than emitting it', async () => {
    const monster = [{ text: 'x'.repeat(PAGE_BYTES + 1) }]
    await expect(all(pages(monster, signal))).rejects.toThrow(/page budget/)
  })

  /* AND THE ROW THAT ONLY JUST FITS still goes, alone — dropping it would be
   * a silent truncation and refusing it would make one long highlight
   * unlistable. */
  it('emits a row that only just fits, on its own', async () => {
    const text = 'x'.repeat(PAGE_BYTES - 20)
    const one = { text }
    expect(JSON.stringify(one).length).toBeLessThanOrEqual(PAGE_BYTES)
    const got = await all(pages([one, { text: 'short' }], signal))
    expect(got[0]).toEqual([one])
    expect(framed(got[0] as unknown[])).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
  })
})
