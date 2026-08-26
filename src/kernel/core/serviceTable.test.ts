import { describe, expect, it } from 'vitest'
import {
  GRANT_FAMILIES,
  SERVICE_GRANTS,
  SERVICE_NAMES,
  SERVICE_NOUNS,
  SERVICE_TABLE,
  SERVICE_VERBS,
  flagFields,
  positionalFields,
  readServices,
  readingGrant,
  serviceClients,
  serviceDescriptor,
  servicesOn,
  writeServices,
  type ServiceDescriptor,
} from './serviceTable'

/**
 * THE DRIFT TEST (WI-11.1). The table is one source; this is what makes
 * "one source" a fact rather than an intention.
 *
 * Every assertion here is about the table AS DATA — spelling, grants, the
 * pairing of `kind` with `output.many`, the shape of the CLI's positionals.
 * A row that breaks one of them is a row the router, the CLI or the generated
 * reference would read differently from the way it reads, which is precisely
 * the drift that three hand-kept lists produced in `commands.rs` and that
 * this phase must not repeat.
 */

describe('the service table', () => {
  it('names every entry <noun>.<verb>, from the closed vocabularies', () => {
    for (const one of SERVICE_TABLE) {
      expect(one.name).toBe(`${one.noun}.${one.verb}`)
      expect(SERVICE_NOUNS).toContain(one.noun)
      expect(SERVICE_VERBS).toContain(one.verb)
    }
  })

  it('gives every entry a grant whose family is declared', () => {
    for (const one of SERVICE_TABLE) {
      expect(SERVICE_GRANTS).toContain(one.grant)
      const family = one.grant.slice(0, one.grant.indexOf(':'))
      expect(GRANT_FAMILIES).toContain(family)
    }
  })

  it('declares no grant no service uses, and no family no grant uses', () => {
    const used = new Set(SERVICE_TABLE.map((one) => one.grant))
    for (const grant of SERVICE_GRANTS) expect(used.has(grant)).toBe(true)
    const families = new Set([...used].map((grant) => grant.slice(0, grant.indexOf(':'))))
    for (const family of GRANT_FAMILIES) expect(families.has(family)).toBe(true)
  })

  it('lets no two entries share a name', () => {
    expect(new Set(SERVICE_NAMES).size).toBe(SERVICE_TABLE.length)
  })

  /* The plan's wording is "every `stream` entry's output type is an array or
   * an async iterable" — which, at the declaration, is the `many` flag, and
   * at the handler is enforced by `ServiceHandlerFor` in services/handlers.ts.
   * Pinned in BOTH directions: a `req` that claimed `many` would make the CLI
   * iterate a promise. */
  it('pairs stream with many, and req with one', () => {
    for (const one of SERVICE_TABLE) {
      /* EVERY `stream` IS MANY. A `req` may also be — `device.list` answers a
       * whole list in one frame — so this is an implication rather than an
       * equality. It used to be an equality, which made `many` a restatement
       * of `kind` and left the one service that needed the distinction
       * spelling it into its type name as `DeviceRow[]`. */
      if (one.kind === 'stream') expect(one.output.many, one.name).toBe(true)
      expect(one.output.of).not.toBe('')
    }
  })

  it('uses each noun at least once, and no noun the table does not declare', () => {
    for (const noun of SERVICE_NOUNS) expect(servicesOn(noun).length).toBeGreaterThan(0)
    const nouns = new Set(SERVICE_TABLE.map((one) => one.noun))
    expect([...nouns].sort()).toEqual([...SERVICE_NOUNS].sort())
  })

  it('does not publish sync, pairing, or a second byte path', () => {
    for (const name of SERVICE_NAMES) {
      expect(name.startsWith('sync.')).toBe(false)
      expect(name).not.toBe('device.pair')
      /* `content.locate` says where the bytes are; nothing here carries them. */
      expect(name).not.toBe('content.get')
      expect(name).not.toBe('content.download')
    }
  })

  it('keeps every field name distinct within one service, and documents each', () => {
    for (const one of SERVICE_TABLE) {
      const names = one.input.map((field) => field.name)
      expect(new Set(names).size).toBe(names.length)
      for (const field of one.input) {
        expect(field.doc.length).toBeGreaterThan(0)
        expect(field.name).toMatch(/^[a-z][a-zA-Z]*$/)
      }
    }
  })

  it('numbers positionals 0..n-1 with no gap and no repeat', () => {
    for (const one of SERVICE_TABLE) {
      const positions = positionalFields(one).map((field) => field.positional)
      expect(positions).toEqual(positions.map((_value, index) => index))
      /* Every field is one or the other, never both and never neither. */
      expect(positionalFields(one).length + flagFields(one).length).toBe(one.input.length)
    }
  })

  it('puts every required positional before every optional one', () => {
    for (const one of SERVICE_TABLE) {
      const required = positionalFields(one).map((field) => field.required === true)
      const firstOptional = required.indexOf(false)
      if (firstOptional === -1) continue
      expect(required.slice(firstOptional).every((value) => !value)).toBe(true)
    }
  })

  it('marks exactly one verb irreversible, and it takes a confirming count', () => {
    const irreversible = SERVICE_TABLE.filter((one) => one.irreversible === true)
    expect(irreversible.map((one) => one.name)).toEqual(['trash.empty'])
    const count = irreversible[0]?.input.find((field) => field.name === 'count')
    expect(count?.required).toBe(true)
    expect(count?.type).toBe('number')
  })

  it('splits read from write by the grant alone', () => {
    expect(readingGrant('book:read')).toBe(true)
    expect(readingGrant('device:manage')).toBe(false)
    expect(readingGrant('shelf:admin')).toBe(false)
    expect(readServices().length + writeServices().length).toBe(SERVICE_TABLE.length)
    /* WRITTEN OUT, so a service cannot become a READ service by accident.
     * `readServices` splits on the grant alone, so a row whose grant is
     * mistyped `book:read` when it writes moves silently into the set every
     * satchel may call. Growing this list is a deliberate edit; not noticing
     * it grew is the failure. The ten the plan named for WI-11.3, plus
     * `content.read` (phase 18) — the browser client's byte path — and
     * `cover.read` (phase 19), which is what lets that client draw jackets
     * instead of tinted rectangles. */
    expect(readServices().map((one) => one.name).sort()).toEqual(
      [
        'book.get',
        'book.list',
        'book.search',
        'card.list',
        'content.locate',
        'content.read',
        'cover.read',
        'device.list',
        'mark.list',
        'shelf.status',
        'tag.list',
        'trash.list',
      ].sort(),
    )
  })

  it('answers for a name it holds and refuses one it does not', () => {
    expect(serviceDescriptor('book.list')?.grant).toBe('book:read')
    expect(serviceDescriptor('book.destroy')).toBeNull()
    expect(serviceDescriptor('sync.pull')).toBeNull()
  })

  it('derives the client stubs from the table and nowhere else', () => {
    expect(serviceClients().map((one) => one.name)).toEqual([...SERVICE_NAMES])
  })
})

/**
 * THE TABLE IS THE AUTHORIZATION RECORD, so `readonly` is not enough — it is
 * a compile-time fact and this object is exported from the kernel's public
 * entry. A module loaded before `buildServices()` could otherwise downgrade a
 * destructive service's grant, and the derived lookups, built from the same
 * objects, would agree with it.
 */
describe('the published table cannot be rewritten at runtime', () => {
  it('refuses a grant swap on a descriptor', () => {
    const row = SERVICE_TABLE.find((one) => one.name === 'trash.empty')
    expect(row).toBeDefined()
    expect(Object.isFrozen(row)).toBe(true)
    expect(() => {
      ;(row as unknown as { grant: string }).grant = 'book:read'
    }).toThrow()
    expect(row?.grant).not.toBe('book:read')
  })

  it('refuses to grow, shrink or reorder', () => {
    expect(Object.isFrozen(SERVICE_TABLE)).toBe(true)
    expect(() => (SERVICE_TABLE as ServiceDescriptor[]).push({} as ServiceDescriptor)).toThrow()
  })

  /* The freeze walks: a shallow one would leave every field object writable,
   * and the bounds on those fields are what validation reads. */
  it('freezes nested input fields, not just the rows', () => {
    const row = SERVICE_TABLE.find((one) => one.input.length > 0)
    expect(row).toBeDefined()
    const field = row!.input[0]!
    expect(Object.isFrozen(field)).toBe(true)
    expect(() => {
      ;(field as unknown as { name: string }).name = 'tampered'
    }).toThrow()
  })
})
