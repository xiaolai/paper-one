import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReflowGuard } from './invalidate'
import { fakeDocument } from './documentFake.testkit'
import { importSpecifiers, scan } from './sourceScan.testkit'

/**
 * The render-generation seam, on its own.
 *
 * This is WI-11's first task rather than a later refactor, and the reason is
 * recorded in `decisions-design-20260815-100158.md` §5: the counter was a
 * module-level `WeakMap` behind an unexported function, so **no test could
 * observe a generation bump cancelling a pending snap**. What is asserted here
 * is the seam's own behaviour — the counter, the token, and the notification —
 * and what it must survive: a listener that throws must not take a repaint down
 * with it, because `paint` is an async function whose result nobody catches
 * (`makePdf.ts`), so an escaping throw becomes an unhandled rejection at the
 * window. That file has already fixed two of those; this is the guard against a
 * third.
 *
 * The consequences for the reader's selection — a pending snap cancelled, a
 * published snapshot invalidated — are asserted where they are consumed, in
 * `session.test.ts`, against the real `#watchSelection` rather than against a
 * re-implementation of it here.
 *
 * **Live-lane partner: none, and there cannot be one.** That a real zoom on a
 * real PDF leaves no stale highlight is a claim about WebKit and pdf.js that
 * nothing in this lane can reach, and the `live` lane cannot either — it needs
 * a selection made by a gesture, which no harness produces.
 *
 * **This pairing is permanently unmet**, and its only cover is
 * `dev-docs/manual-selection-checklist.md` §2.
 */

/** A page document, keyed only by identity — which is all the guard asks of it.
 *  The keyed fake is reused rather than a bare object literal so that a guard
 *  which started reading the document would fail here rather than silently. */
const pageDocument = (): Document => fakeDocument().asDocument()

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createReflowGuard — the counter', () => {
  it('hands out a rising token, and only the newest one is still valid', () => {
    const guard = createReflowGuard(pageDocument())

    expect(guard.generation()).toBe(0)

    const first = guard.bump()
    const second = guard.bump()

    expect([first, second]).toEqual([1, 2])
    expect(guard.generation()).toBe(2)
    expect(guard.isValid(second)).toBe(true)
    // `paint`'s `superseded()` is exactly this, negated: the older paint
    // abandons itself the moment a newer one starts.
    expect(guard.isValid(first)).toBe(false)
  })

  /*
   * Per document, not per module. A single global counter passes every case
   * above and then abandons a perfectly good paint on one page because another
   * page started painting — which is the bug the WeakMap existed to avoid, and
   * the one a careless extraction would reintroduce.
   */
  it('counts each document separately', () => {
    const one = createReflowGuard(pageDocument())
    const other = createReflowGuard(pageDocument())

    const token = one.bump()
    other.bump()
    other.bump()

    expect(one.generation()).toBe(1)
    expect(other.generation()).toBe(2)
    expect(one.isValid(token)).toBe(true)
  })

  /*
   * The whole point of the seam. `paint` builds a guard for the page it is
   * painting and `#watchSelection` builds one for the same document when the
   * section loads — two callers, two objects, and they must be looking at ONE
   * counter and ONE listener set or the notification never crosses between
   * them. An implementation that kept its state on the returned object instead
   * of on the document passes every other case in this file.
   */
  it('is one counter and one listener set per document, however many guards ask for it', () => {
    const doc = pageDocument()
    const painter = createReflowGuard(doc)
    const watcher = createReflowGuard(doc)
    const seen: string[] = []
    watcher.onReflow(() => seen.push('watcher'))

    const token = painter.bump()

    expect(seen).toEqual(['watcher'])
    expect(watcher.generation()).toBe(1)
    expect(watcher.isValid(token)).toBe(true)

    // And the other way round, so neither guard is privileged.
    const later = watcher.bump()
    expect(painter.isValid(token)).toBe(false)
    expect(painter.isValid(later)).toBe(true)
  })
})

describe('createReflowGuard — the notification', () => {
  it('notifies every listener on every bump, in registration order', () => {
    const guard = createReflowGuard(pageDocument())
    const seen: string[] = []
    const off = guard.onReflow(() => seen.push('first'))
    guard.onReflow(() => seen.push('second'))

    guard.bump()
    expect(seen).toEqual(['first', 'second'])

    guard.bump()
    expect(seen).toEqual(['first', 'second', 'first', 'second'])

    /* Removes exactly the listener it was given. A teardown that dropped the
     * whole set would leave the other section's watcher deaf, and nothing else
     * here would notice. */
    off()
    guard.bump()
    expect(seen).toEqual(['first', 'second', 'first', 'second', 'second'])
  })

  /*
   * Unsubscribing is what `#onTeardown` does, and a section that goes away
   * during a repaint is a real sequence rather than a contrived one.
   *
   * A `Set` iterator gives this for free — deleting the entry it is standing on
   * does not skip the next, unlike the array `documentFake.testkit.ts` keeps
   * its DOM listeners in. Asserted anyway, because the guarantee is the
   * guard's, not the container's: swapping `Set` for something without that
   * property must fail here rather than quietly take it away.
   */
  it('lets a listener unsubscribe from inside a notification without skipping the next one', () => {
    const guard = createReflowGuard(pageDocument())
    const seen: string[] = []
    let off = (): void => {}
    off = guard.onReflow(() => {
      seen.push('first')
      off()
    })
    guard.onReflow(() => seen.push('second'))

    guard.bump()
    expect(seen).toEqual(['first', 'second'])

    guard.bump()
    expect(seen).toEqual(['first', 'second', 'second'])
  })

  /*
   * The other half of the copy, and the half a `Set` does NOT give for free: a
   * listener registered while a repaint is being announced hears about the
   * NEXT one, not the one already under way. A watcher that arrives in the
   * middle of a repaint has nothing anchored into the page yet — telling it to
   * throw away a snapshot it has not published, and to cancel a snap it has not
   * scheduled, describes a moment it was not present for.
   */
  it('notifies the listeners a repaint started with, not one registered while it ran', () => {
    const guard = createReflowGuard(pageDocument())
    const seen: string[] = []
    let joined = false
    guard.onReflow(() => {
      seen.push('first')
      if (joined) return
      joined = true
      guard.onReflow(() => seen.push('late'))
    })

    guard.bump()
    expect(seen).toEqual(['first'])

    guard.bump()
    expect(seen).toEqual(['first', 'first', 'late'])
  })

  /*
   * **No third unhandled rejection.** `paint` is `async` and its caller is
   * `void paint(...).then(...)` with nothing catching, so anything that escapes
   * `bump()` leaves the function as a rejected promise nobody handles — which
   * is precisely the failure `makePdf.ts` has already fixed twice, once for the
   * canvas render and once for the text layer. The bump is inside `paint`, so
   * the isolation has to be here.
   *
   * Reported rather than discarded: a listener that throws is a bug in the
   * watcher, and `console.error` is how this file's siblings say so.
   */
  it('does not let a failing listener take the repaint down with it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = createReflowGuard(pageDocument())
    const seen: string[] = []
    guard.onReflow(() => {
      throw new Error('a listener bug')
    })
    guard.onReflow(() => seen.push('after'))

    const token = guard.bump()

    // The listener after the failing one still ran, and the paint that called
    // bump() still has a usable token.
    expect(seen).toEqual(['after'])
    expect(guard.isValid(token)).toBe(true)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0]?.[1]).toBeInstanceOf(Error)

    // Still usable afterwards, rather than wedged by the first failure.
    expect(() => guard.bump()).not.toThrow()
    expect(seen).toEqual(['after', 'after'])
    expect(guard.generation()).toBe(2)
  })
})

/**
 * That `paint` actually goes through the seam.
 *
 * Nothing else in this lane can see it: `makePdf.ts` imports pdf.js, a worker
 * URL and a raw stylesheet, and `paint` is neither exported nor callable
 * without a `PDFPageProxy`. So the one thing a unit lane can check is the
 * source itself — the same instrument `classify.test.ts` and
 * `snapWordRange.test.ts` use to prove those modules are DOM-free.
 *
 * It is a structural assertion and is written down as one. What it stops is
 * narrow and real: a private counter growing back beside the shared one, which
 * would leave every behavioural case in `session.test.ts` green while the live
 * app never notified anybody. Whether a real zoom clears a real highlight is
 * **permanently outside every lane** — it needs a selection made by a gesture —
 * and lives in `dev-docs/manual-selection-checklist.md` §2.
 */
describe('makePdf takes its render generation from the seam', () => {
  const source = readFileSync(fileURLToPath(new URL('../makePdf.ts', import.meta.url)), 'utf8')
  const { withoutComments, codeOnly } = scan(source)

  it('imports the guard and paints against its token', () => {
    expect(importSpecifiers(withoutComments)).toContain('./wordSnap/invalidate')
    expect(codeOnly).toMatch(/const\s+reflow\s*=\s*createReflowGuard\(doc\)/)
    expect(codeOnly).toMatch(/const\s+generation\s*=\s*reflow\.bump\(\)/)
    expect(codeOnly).toMatch(/reflow\.isValid\(generation\)/)
  })

  it('keeps no private generation counter of its own', () => {
    expect(codeOnly).not.toMatch(/\bgenerations\b/)
    expect(codeOnly).not.toMatch(/WeakMap<\s*Document\s*,\s*number\s*>/)
  })
})
