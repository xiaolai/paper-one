import { describe, expect, it } from 'vitest'
import {
  BLOCKED_BUDGET,
  DEFAULT_BUDGET,
  NOTHING_SPENT,
  PREFIX_CHARS,
  charge,
  readRouting,
  type Spend,
} from './bound'

/** WI-22.C3 — the bound that runs before the parse, and survives reconnection. */

const hex = (c: string) => c.repeat(64)
const frame = (person: string, work: string, body = '{}') => `${hex(person)}${hex(work)}${body}`

const small: Parameters<typeof charge>[4] = { perPeer: 1000, perWork: 400, windowMs: 60_000 }

describe('readRouting', () => {
  it('reads the two fields a charge needs, without touching the body', () => {
    const routing = readRouting(frame('a', 'b', '{"anything":"at all"}'))
    expect(routing).toEqual({ person: hex('a'), workDigest: hex('b') })
  })

  it('refuses a frame too short to carry a prefix', () => {
    expect(readRouting('')).toBeNull()
    expect(readRouting('a'.repeat(PREFIX_CHARS - 1))).toBeNull()
  })

  it('refuses anything that is not hex, so parsing cannot itself be an attack', () => {
    /* ⚠️ A length-prefixed or delimited prefix would mean reading a length the
       PEER chose before deciding whether to read anything — the shape this
       whole module exists to refuse, reproduced in miniature. Fixed size and
       hex-only is what makes the read constant-cost. */
    expect(readRouting(`${'z'.repeat(64)}${hex('b')}`)).toBeNull()
    expect(readRouting(`${hex('a')}${'!'.repeat(64)}`)).toBeNull()
  })

  it('does not need the body to be valid at all', () => {
    /* ⚠️ **THE WHOLE POINT.** The charge happens before the parse, so a frame
       whose body is garbage must still be chargeable — otherwise the bound
       depends on the thing it is bounding. */
    expect(readRouting(frame('a', 'b', 'not json at all {{{'))).not.toBeNull()
  })
})

describe('charge', () => {
  it('allows a frame inside both budgets', () => {
    const result = charge(NOTHING_SPENT, 'w1', 100, 1000, small)
    expect(result.allowed).toBe(true)
  })

  it('refuses when one work is over its budget', () => {
    let spend: Spend = NOTHING_SPENT
    for (let i = 0; i < 4; i += 1) {
      const r = charge(spend, 'w1', 100, 1000, small)
      expect(r.allowed).toBe(true)
      if (r.allowed) spend = r.spend
    }
    expect(charge(spend, 'w1', 100, 1000, small)).toEqual({ allowed: false, why: 'per-work' })
  })

  it('lets another work through while one is exhausted', () => {
    /* ⚠️ `review.md`'s check: *"exhaust work A but not B and send equal-sized
       pages — the handler cannot know which budget applies."* It can, because
       the work digest is in the cleartext prefix. */
    let spend: Spend = NOTHING_SPENT
    for (let i = 0; i < 4; i += 1) {
      const r = charge(spend, 'A', 100, 1000, small)
      if (r.allowed) spend = r.spend
    }
    expect(charge(spend, 'A', 100, 1000, small).allowed).toBe(false)
    expect(charge(spend, 'B', 100, 1000, small).allowed).toBe(true)
  })

  it('refuses on the peer total even when each work is inside its own', () => {
    let spend: Spend = NOTHING_SPENT
    for (const work of ['a', 'b', 'c']) {
      for (let i = 0; i < 3; i += 1) {
        const r = charge(spend, work, 110, 1000, small)
        if (r.allowed) spend = r.spend
      }
    }
    expect(spend.total).toBe(990)
    expect(charge(spend, 'd', 100, 1000, small)).toEqual({ allowed: false, why: 'per-peer' })
  })

  it('does NOT reset when a peer reconnects', () => {
    /* ⚠️ **THE HALF THAT MAKES IT A BUDGET AT ALL.** *"Reconnecting resets the
       cap, so retained data grows as `sessions × budget`."* The spend is
       persisted and passed back in, so a fresh session resumes the window
       rather than opening one. Nothing here has a notion of "session", which is
       what makes that true by construction. */
    let spend: Spend = NOTHING_SPENT
    for (let i = 0; i < 4; i += 1) {
      const r = charge(spend, 'w1', 100, 1000, small)
      if (r.allowed) spend = r.spend
    }
    /* A new connection, one millisecond later, with the stored spend. */
    expect(charge(spend, 'w1', 100, 1001, small).allowed).toBe(false)
  })

  it('rolls the window once it has genuinely elapsed', () => {
    let spend: Spend = NOTHING_SPENT
    for (let i = 0; i < 4; i += 1) {
      const r = charge(spend, 'w1', 100, 1000, small)
      if (r.allowed) spend = r.spend
    }
    expect(charge(spend, 'w1', 100, 1000 + small.windowMs - 1, small).allowed).toBe(false)
    expect(charge(spend, 'w1', 100, 1000 + small.windowMs, small).allowed).toBe(true)
  })

  it('opens the first window at the first charge, not at the epoch', () => {
    /* `since: 0` is "never spent". Treating it as a real timestamp would make
       every first frame look like one from 1970 and roll immediately. */
    const first = charge(NOTHING_SPENT, 'w1', 10, 5_000_000, small)
    expect(first.allowed).toBe(true)
    if (first.allowed) expect(first.spend.since).toBe(5_000_000)
  })

  it('refuses a frame that alone exceeds the budget', () => {
    expect(charge(NOTHING_SPENT, 'w1', 401, 1000, small)).toEqual({ allowed: false, why: 'per-work' })
  })
})

describe('BLOCKED_BUDGET', () => {
  it('refuses everything, including a zero-byte frame', () => {
    /* ⚠️ `relationships.md` requires a blocked person's budget be zero AND
       persisted. Expressing it as a BUDGET rather than as a branch means every
       path that charges is covered, including ones written later — a branch
       has to be remembered at each new call site. */
    expect(charge(NOTHING_SPENT, 'w1', 1, 1000, BLOCKED_BUDGET).allowed).toBe(false)
    expect(charge(NOTHING_SPENT, 'w1', 0, 1000, BLOCKED_BUDGET).allowed).toBe(true)
  })
})

describe('DEFAULT_BUDGET', () => {
  it('admits several full frames per work and is a day long', () => {
    /* A page is capped by the frame at just under 4 MiB. These bound the case
       where somebody is not sharing passages from a book. */
    expect(DEFAULT_BUDGET.perWork).toBeGreaterThan(4 * 1024 * 1024)
    expect(DEFAULT_BUDGET.perPeer).toBeGreaterThan(DEFAULT_BUDGET.perWork)
    expect(DEFAULT_BUDGET.windowMs).toBe(86_400_000)
  })
})

describe("WI-22.C3's falsifier — the parser must not run for an over-budget frame", () => {
  /**
   * ⚠️ **THE PLAN'S CHECK IS *"instrument the parser and send an over-budget
   * peer's frame. If the parser ran, the bound is after the read"*, AND IT WAS
   * NOT BEING RUN IN ANY FORM.** The other tests here prove `readRouting` works
   * on a frame whose body is garbage, which is a necessary condition and not the
   * claim. The claim is about ORDER.
   *
   * There is no real stream handler yet, so the handler is modelled — and that
   * is enough, because the ordering is the whole of what is being asserted.
   * `importLimits.ts` names the failure this guards: *"a bound that runs AFTER
   * the read has not bounded anything."*
   */
  const handler = (spend: Spend, frame: string, now: number, budget: typeof small) => {
    let parsed = 0
    const routing = readRouting(frame)
    if (!routing) return { parsed, refused: 'no-routing' as const, spend }
    const result = charge(spend, routing.workDigest, frame.length, now, budget)
    if (!result.allowed) return { parsed, refused: result.why, spend }
    /* THE PARSE. Everything above it is the bound. */
    parsed += 1
    JSON.parse(frame.slice(PREFIX_CHARS))
    return { parsed, refused: null, spend: result.spend }
  }

  it('does not parse the body of a frame it refuses', () => {
    /* A generous peer budget and a tiny per-work one, so the refusal is the
       one being named rather than whichever limit happened to trip first. */
    const tiny = { perPeer: 100_000, perWork: 10, windowMs: 60_000 }
    const out = handler(NOTHING_SPENT, frame('a', 'b', '{"big":"payload"}'), 1000, tiny)
    expect(out.refused).toBe('per-work')
    expect(out.parsed).toBe(0)
  })

  it('parses the body of a frame it accepts, so the counter is real', () => {
    /* ⚠️ **THE KNOWN POSITIVE.** A handler that never parsed anything would pass
       the test above for the wrong reason — the same shape as a detector that
       finds nothing looking like a clean result. */
    const out = handler(NOTHING_SPENT, frame('a', 'b', '{"ok":1}'), 1000, small)
    expect(out.refused).toBeNull()
    expect(out.parsed).toBe(1)
  })

  it('refuses without parsing even when the body is not JSON at all', () => {
    /* If the bound ran after the read, this would throw rather than refuse —
       which is the failure mode stated as a symptom rather than a theory. */
    const tiny = { perPeer: 100_000, perWork: 10, windowMs: 60_000 }
    expect(() => handler(NOTHING_SPENT, frame('a', 'b', 'not json {{{'), 1000, tiny)).not.toThrow()
  })

  it('charges an exhausted work without parsing, while another still parses', () => {
    /* `review.md`'s own phrasing: *"exhaust work A but not B and send
       equal-sized pages — the handler cannot know which budget applies."* */
    /* A frame here is 135 bytes (64 + 64 + body). `perWork` of 300 admits two
       and refuses the third; `perPeer` is far above both so it cannot be the
       limit that trips — which is the distinction the test is about. */
    const wide = { perPeer: 100_000, perWork: 300, windowMs: 60_000 }
    /* ⚠️ **LOWER-CASE HEX. `'A'` and `'B'` read as `no-routing`**, not as
       over-budget — `readRouting` requires `[0-9a-f]`, deliberately, so that
       parsing the prefix is constant-cost. The first version of this test used
       them and refused for the wrong reason; asserting `parsed` rather than
       `refused` is what exposed it, because both refusals parse nothing. */
    let spend: Spend = NOTHING_SPENT
    for (let i = 0; i < 4; i += 1) {
      spend = handler(spend, frame('a', 'c', '{"x":1}'), 1000, wide).spend
    }
    const exhausted = handler(spend, frame('a', 'c', '{"x":1}'), 1000, wide)
    expect(exhausted.refused).toBe('per-work')
    expect(exhausted.parsed).toBe(0)

    const other = handler(spend, frame('a', 'd', '{"x":1}'), 1000, wide)
    expect(other.refused).toBeNull()
    expect(other.parsed).toBe(1)
  })
})
