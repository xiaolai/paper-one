import { describe, expect, it } from 'vitest'
import { SERVICE_NAMES, serviceDescriptor, type ServiceDescriptor, type ServiceField } from '../serviceTable'
import { bool, list, num, readInput, reqList, reqNum, reqStr, str } from './input'
import { isRefusal } from './refusals'
import { PAGE_BYTES, PAGE_ROWS, pages } from './paging'

/**
 * The two pieces the handlers are built out of (WI-11.3): the validator that
 * turns a wire body into arguments, and the pager that turns a list into
 * frames.
 *
 * EVERY handler uses the validator; only the `stream` ones page — `book.get`
 * answers one row and never sees `pages` at all. The note here used to say
 * both applied to every handler, which is the kind of small overstatement
 * that makes a reader trust the next sentence less.
 *
 * Tested here rather than only through the router because they are where a
 * mistake is silent: a field quietly ignored produces an answer that looks
 * right, and a page boundary off by one produces a list that is short by
 * exactly one row on exactly one library size.
 */

/** The refusal a call threw, or the value it returned. */
function thrown(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error) {
    if (isRefusal(error)) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error('expected a refusal')
}

/**
 * A descriptor by name, or a failure that names the fixture.
 *
 * `serviceDescriptor(…) as ServiceDescriptor` suppressed the null, so a
 * service RENAMED in the table turned these fixtures into `undefined` and the
 * first assertion failed somewhere else entirely with a `TypeError` about
 * reading a property — a fixture problem reported as a code problem.
 */
function descriptorFor(name: string): ServiceDescriptor {
  const found = serviceDescriptor(name)
  if (!found) throw new Error(`the table has no ${name}; this fixture is stale`)
  return found
}

const bookGet = descriptorFor('book.get')
const bookList = descriptorFor('book.list')
const tagAdd = descriptorFor('tag.add')

describe('readInput', () => {
  it('reads a body the schema describes', () => {
    expect(readInput(bookGet, { book: 'b1' })).toEqual({ book: 'b1' })
    expect(readInput(bookList, { tag: 'x', finished: true, since: 5 })).toEqual({ tag: 'x', finished: true, since: 5 })
  })

  /* `null` is what an empty request body is on the wire, and `end`/`cancel`
   * carry exactly that. A service with no required field is legitimately
   * called with nothing. */
  it('reads null and undefined as an empty body', () => {
    expect(readInput(bookList, null)).toEqual({})
    expect(readInput(bookList, undefined)).toEqual({})
  })

  it('refuses a body that is not an object — an array included', () => {
    expect(thrown(() => readInput(bookGet, 'b1')).code).toBe('malformed')
    expect(thrown(() => readInput(bookGet, 7)).code).toBe('malformed')
    /* `typeof [] === 'object'`, and its numeric keys satisfy nothing. */
    expect(thrown(() => readInput(bookGet, ['b1'])).code).toBe('malformed')
  })

  /* Silently ignoring an unknown field is how a misspelled `--finished`
   * becomes an unfiltered list that looks exactly like a filtered one. */
  it('refuses a field the schema does not name, by name', () => {
    const refusal = thrown(() => readInput(bookList, { finshed: true }))
    expect(refusal.code).toBe('malformed')
    expect(refusal.message).toContain('finshed')
  })

  it('refuses a required field that is absent, by name', () => {
    expect(thrown(() => readInput(bookGet, {})).message).toContain('book')
  })

  it('refuses a value of the wrong type rather than coercing it', () => {
    expect(thrown(() => readInput(bookGet, { book: 7 })).code).toBe('malformed')
    expect(thrown(() => readInput(bookList, { since: '5' })).code).toBe('malformed')
    expect(thrown(() => readInput(bookList, { finished: 'yes' })).code).toBe('malformed')
    expect(thrown(() => readInput(tagAdd, { tag: 't', book: 'b1' })).code).toBe('malformed')
    expect(thrown(() => readInput(tagAdd, { tag: 't', book: [1, 2] })).code).toBe('malformed')
  })

  /* `JSON.parse("1e400")` yields Infinity, which is not a JSON value: it
   * re-encodes as null, mutating the body under any check that only asked
   * `typeof x === "number"`. */
  it('refuses a non-finite number', () => {
    expect(thrown(() => readInput(bookList, { since: Number.POSITIVE_INFINITY })).code).toBe('malformed')
    expect(thrown(() => readInput(bookList, { since: Number.NaN })).code).toBe('malformed')
  })

  it('leaves an absent optional field absent rather than defaulting it', () => {
    const input = readInput(bookList, { tag: 'x' })
    expect('finished' in input).toBe(false)
    expect(bool(input, 'finished')).toBeUndefined()
  })
})

describe('the readers', () => {
  it('narrow a validated value to the type its schema declared', () => {
    const input = readInput(bookList, { tag: 'x', since: 5, finished: true })
    expect(str(input, 'tag')).toBe('x')
    expect(num(input, 'since')).toBe(5)
    expect(bool(input, 'finished')).toBe(true)
    expect(list(input, 'tag')).toBeUndefined()
    expect(reqStr(readInput(bookGet, { book: 'b1' }), 'book')).toBe('b1')
    expect(reqList(readInput(tagAdd, { tag: 't', book: ['b1'] }), 'book')).toEqual(['b1'])
  })

  it('refuse where the schema could not have — a required reader on a missing name', () => {
    const input = readInput(bookList, {})
    expect(thrown(() => reqStr(input, 'tag')).code).toBe('malformed')
    expect(thrown(() => reqNum(input, 'since')).code).toBe('malformed')
    expect(thrown(() => reqList(input, 'nothing')).code).toBe('malformed')
  })
})

describe('pages', () => {
  const signal = new AbortController().signal
  const rows = Array.from({ length: PAGE_ROWS * 2 + 3 }, (_one, index) => index)

  async function all<T>(iterable: AsyncIterable<readonly T[]>): Promise<(readonly T[])[]> {
    const out: (readonly T[])[] = []
    for await (const page of iterable) out.push(page)
    return out
  }

  it('cuts a list into full pages and a remainder', async () => {
    const got = await all(pages(rows, signal))
    expect(got.map((page) => page.length)).toEqual([PAGE_ROWS, PAGE_ROWS, 3])
    expect(got.flat()).toEqual(rows)
  })

  it('yields nothing for an empty list, rather than one empty page', async () => {
    expect(await all(pages([], signal))).toEqual([])
  })

  it('applies limit to rows, not to pages', async () => {
    expect((await all(pages(rows, signal, 5))).flat()).toEqual([0, 1, 2, 3, 4])
    expect((await all(pages(rows, signal, PAGE_ROWS + 1))).map((page) => page.length)).toEqual([PAGE_ROWS, 1])
  })

  it('yields nothing for a limit of zero, which is what asking for nothing means', async () => {
    expect(await all(pages(rows, signal, 0))).toEqual([])
  })

  /* THE BYTE BUDGET, WHICH IS THE HALF THAT PROTECTS THE TRANSPORT.
   *
   * `PAGE_ROWS` bounds a page's row count; `PAGE_BYTES` bounds what it costs
   * to send. Only the first was tested, so deleting the byte split left every
   * test green while a page of long rows grew past what a frame can carry —
   * and the caller's error would arrive from the wire, naming nothing. */
  it('splits on bytes as well as rows', async () => {
    /* Eight rows, each an eighth of the budget and change: far inside
     * `PAGE_ROWS`, so a row-only pager would put all eight in one page. */
    const chunk = 'x'.repeat(Math.floor(PAGE_BYTES / 8))
    const heavy = Array.from({ length: 8 }, (_one, index) => ({ index, chunk }))
    expect(heavy.length).toBeLessThan(PAGE_ROWS)
    const got = await all(pages(heavy, signal))
    expect(got.length).toBeGreaterThan(1)
    for (const page of got) {
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(PAGE_BYTES)
    }
    /* Split, not dropped. */
    expect(got.flat()).toEqual(heavy)
  })

  /* A ROW NOTHING CAN CARRY IS NAMED, not handed to the transport to reject.
   * Bounded inputs should make this unreachable; if it ever fires, the
   * message says how big the row was and what the budget is. */
  it('refuses a single row larger than a whole page, by name', async () => {
    const monster = [{ text: 'x'.repeat(PAGE_BYTES + 1) }]
    await expect(all(pages(monster, signal))).rejects.toThrow(/page budget/)
  })

  it('produces no page at all when the signal is already aborted', async () => {
    const aborted = AbortSignal.abort()
    expect(await all(pages(rows, aborted))).toEqual([])
  })

  /**
   * STOPS AT THE PAGE BOUNDARY — and this asserts what it BUILT, not only
   * what it yielded.
   *
   * Counting yielded pages alone is satisfied by a generator that assembles
   * another whole page and then discards it at its next abort check: the
   * consumer sees one page either way, while the shelf has done twice the
   * work. On a page of two hundred rows that is two hundred rows serialised
   * for nobody, which is exactly the cost cancellation exists to avoid.
   */
  it('stops at the page boundary after an abort mid-iteration, without building another', async () => {
    const controller = new AbortController()
    /* Every row the pager PULLS, counted at the source. */
    const pulled: number[] = []
    const watched = (function* () {
      for (const row of rows) {
        pulled.push(row)
        yield row
      }
    })()
    const got: number[][] = []
    for await (const page of pages(watched, controller.signal)) {
      got.push([...page])
      controller.abort()
    }
    expect(got).toHaveLength(1)
    /* ONE PAGE'S WORTH, plus the two rows the boundary costs: the row whose
     * arrival closes the page, and the one pulled before the next check
     * fires. Not a second page's worth — which is what it was: 401 rows
     * pulled to yield 200, every one of them serialised for a caller that had
     * already gone. */
    expect(pulled.length).toBeLessThanOrEqual(PAGE_ROWS + 2)
    expect(pulled.length).toBeLessThan(PAGE_ROWS * 2)
  })
})

/**
 * EVERY BOUND THE TABLE DECLARES, EXERCISED — driven off the table itself.
 *
 * The suite above proved the shapes (`must be a string`, `must be an object`)
 * and stopped there, so `nonEmpty`, `maxLength`, `maxItems`, `integer`, `min`
 * and `max` were declared on forty-odd fields and enforced by nothing any test
 * would notice losing. Deleting the whole constraint block from `readInput`
 * left this file green. That is the failure this describes.
 *
 * Table-driven rather than a hand-written case per field, for the reason the
 * table exists at all: a bound added to a row is checked here without this
 * file being touched, and a bound nobody checks cannot survive.
 */
describe('the bounds every field declares', () => {
  /** A value that satisfies every constraint on `field`. */
  function valid(field: ServiceField): unknown {
    switch (field.type) {
      case 'string':
        /* A CHOICE WHEN THE FIELD HAS ONE. `'x'` is not a mark colour, and a
         * generator that ignored `choices` would build bodies every service
         * with a closed vocabulary refuses — so the "at each bound" sweep
         * below would have measured refusals rather than acceptances. */
        return field.choices?.[0] ?? 'x'
      case 'number': {
        const floor = field.min ?? 0
        return field.max !== undefined && floor > field.max ? field.max : floor
      }
      case 'boolean':
        return true
      case 'string[]':
        return [field.choices?.[0] ?? 'x']
    }
  }

  /**
   * A body this descriptor ACCEPTS: every required field, plus one of any
   * `atLeastOne` set.
   *
   * The cross-field rule is not on any single field, so a body built from
   * `required` alone is refused by `mark.set` — and every "at each bound"
   * assertion below would then have been measuring a refusal rather than an
   * acceptance.
   */
  function body(descriptor: ServiceDescriptor): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const field of descriptor.input) if (field.required === true) out[field.name] = valid(field)
    const anyOf = descriptor.atLeastOne
    if (anyOf && !anyOf.some((name) => out[name] !== undefined)) {
      const first = descriptor.input.find((one) => one.name === anyOf[0])
      if (first) out[first.name] = valid(first)
    }
    return out
  }

  /** Each way `field` can be out of bounds, as `[constraint, value]`. */
  function violations(field: ServiceField): [string, unknown][] {
    const out: [string, unknown][] = []
    if (field.nonEmpty === true) out.push(['nonEmpty', field.type === 'string[]' ? ['   '] : '   '])
    if (field.choices === undefined && field.maxLength !== undefined) {
      const past = 'x'.repeat(field.maxLength + 1)
      out.push(['maxLength', field.type === 'string[]' ? [past] : past])
    }
    if (field.choices !== undefined) {
      out.push(['choices', field.type === 'string[]' ? ['not-a-choice'] : 'not-a-choice'])
    }
    if (field.maxItems !== undefined) out.push(['maxItems', Array.from({ length: field.maxItems + 1 }, () => 'x')])
    if (field.minItems !== undefined) out.push(['minItems', Array.from({ length: field.minItems - 1 }, () => 'x')])
    if (field.pattern !== undefined) out.push(['pattern', 'not the shape'])
    if (field.integer === true) out.push(['integer', (field.min ?? 0) + 0.5])
    if (field.min !== undefined) out.push(['min', field.min - 1])
    if (field.max !== undefined) out.push(['max', field.max + 1])
    return out
  }

  it('refuses a value past every bound on every field, and names the field', () => {
    const exercised = new Map<string, number>()
    for (const name of SERVICE_NAMES) {
      const descriptor = descriptorFor(name)
      for (const field of descriptor.input) {
        for (const [constraint, value] of violations(field)) {
          const refusal = thrown(() => readInput(descriptor, { ...body(descriptor), [field.name]: value }))
          expect(refusal.code, `${name}.${field.name} ${constraint}`).toBe('malformed')
          /* The field's NAME, because "malformed" alone leaves a caller with
           * a whole body to inspect and no idea which part of it was wrong. */
          expect(refusal.message, `${name}.${field.name} ${constraint}`).toContain(field.name)
          exercised.set(constraint, (exercised.get(constraint) ?? 0) + 1)
        }
      }
    }
    /* THE SWEEP MUST HAVE SWEPT. A generator that produced no violations —
     * a renamed constraint, a table read wrongly — would pass the loop above
     * without entering it once. */
    expect([...exercised.keys()].sort()).toEqual(['choices', 'integer', 'max', 'maxItems', 'maxLength', 'min', 'minItems', 'nonEmpty', 'pattern'])
    for (const [constraint, count] of exercised) expect(count, constraint).toBeGreaterThan(0)
  })

  it('accepts a value exactly at each bound, so the check is not off by one', () => {
    for (const name of SERVICE_NAMES) {
      const descriptor = descriptorFor(name)
      for (const field of descriptor.input) {
        const edges: unknown[] = []
        /* A field with a closed vocabulary has no length edge to sit on: its
         * legal values are the words, not every string up to a bound. */
        if (field.choices === undefined && field.maxLength !== undefined && field.type === 'string') {
          /* A patterned field's edge must still have the shape: `a` is a hex
             digit, `x` is not. */
          edges.push((field.pattern ? 'a' : 'x').repeat(field.maxLength))
        }
        if (field.choices === undefined && field.maxLength !== undefined && field.type === 'string[]') {
          edges.push(['x'.repeat(field.maxLength)])
        }
        if (field.min !== undefined) edges.push(field.min)
        if (field.max !== undefined) edges.push(field.max)
        for (const edge of edges) {
          const input = readInput(descriptor, { ...body(descriptor), [field.name]: edge })
          expect(input[field.name], `${name}.${field.name}`).toEqual(edge)
        }
      }
    }
  })
})
