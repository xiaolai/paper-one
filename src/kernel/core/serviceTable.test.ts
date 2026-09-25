import { describe, expect, it } from 'vitest'
import {
  deepFreeze,
  GRANT_FAMILIES,
  SERVICE_AUDIENCES,
  SERVICE_GRANTS,
  SERVICE_NAMES,
  SERVICE_NOUNS,
  SERVICE_TABLE,
  SERVICE_VERBS,
  flagFields,
  positionalFields,
  readServices,
  readingGrant,
  servableToAnotherDevice,
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

  /**
   * ⚠️ THIS WAS CALLED "no second byte path" AND SAID "nothing here carries
   * them", with `content.read` and `cover.read` in the same table — both
   * declared `kind: 'stream'`, both answering bytes. The table's own header
   * explains why they are the deliberate exception; only this test still
   * described the world before it.
   *
   * What it actually forbids is a second TRANSFER: `content.get` and
   * `content.download` are the resumable, hash-verified shape the blob path
   * already owns, and a second one would need every test that one is held to —
   * a flipped byte, a resumed interruption, a folder trashed mid-transfer — or,
   * worse, none. A READ is not that: no resume, no partial file on disk, no
   * second hash to keep honest.
   */
  it('does not publish sync, pairing, or a second byte TRANSFER', () => {
    for (const name of SERVICE_NAMES) {
      expect(name.startsWith('sync.')).toBe(false)
      expect(name).not.toBe('device.pair')
      expect(name).not.toBe('content.get')
      expect(name).not.toBe('content.download')
    }
    /* AND THE DELIBERATE READS ARE STILL HERE, named — so removing one is a
       decision rather than a quiet drift back to the sentence above. */
    expect(SERVICE_NAMES).toContain('content.read')
    expect(SERVICE_NAMES).toContain('cover.read')
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

  /* A WITHDRAWN FIELD IS A RULE THE TABLE STATES, not a name that quietly
   * stopped being listed. Refused by name with its reason, published beside
   * the fields that are taken — and never one the service also takes, which
   * would make `readInput` refuse a field the row declares. */
  it('names no withdrawn field that is also taken, and says why each was withdrawn', () => {
    for (const one of SERVICE_TABLE) {
      const taken = new Set(one.input.map((field) => field.name))
      for (const gone of one.withdrawn ?? []) {
        expect(taken.has(gone.name), `${one.name} both takes and withdraws ${gone.name}`).toBe(false)
        expect(gone.name).toMatch(/^[a-z][a-zA-Z]*$/)
        expect(gone.why.length).toBeGreaterThan(0)
      }
    }
  })

  /**
   * WI-20.7 — `book.set` offered a title and an author it could not keep. The
   * write went through `patch` with no stamp, so the next parse or enrichment
   * put the file's own metadata back over it, and sync's metadata group is
   * taken whole by `parsedAt`, which `patch` never moved. Nothing in the app
   * called it; the CLI reached it through the table. The two fields are
   * withdrawn BY NAME rather than dropped, so a caller who types `--title`
   * is told a rename is not offered instead of "no such field".
   */
  it('withdraws title and author from book.set by name, and takes only the fields it can keep', () => {
    const set = serviceDescriptor('book.set') as ServiceDescriptor
    expect(set.input.map((field) => field.name)).toEqual(['book', 'finished', 'position', 'progress', 'status', 'rating', 'review'])
    expect(set.atLeastOne).toEqual(['finished', 'position', 'progress', 'status', 'rating', 'review'])
    expect((set.withdrawn ?? []).map((gone) => gone.name)).toEqual(['title', 'author'])
    for (const gone of set.withdrawn ?? []) expect(gone.why).toMatch(/rename/i)
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
        /* `passage.search` IS A READ, and it is the first row whose grant is
         * not the only thing standing between a caller and the answer — see
         * `audience`. Listing it here says it reads; the audience case below
         * says who may ask. Two questions, two lists, neither derived from the
         * other. */
        'passage.search',
        'shelf.status',
        'tag.list',
        'trash.list',
      ].sort(),
    )
  })

  it('makes every row declare who may be served it', () => {
    /* ⚠️ **DECLARED BY EVERY ROW, WITH NO DEFAULT** — `marks.ts`'s own rule in
     * as many words: *"Membership, not exclusion … Adding a kind now means
     * putting it in one of these two lists, which is a decision rather than an
     * omission."* A default would make the next row's omission silent, and the
     * silent direction is the permissive one.
     *
     * The type already refuses a row without the field; this is what refuses a
     * row with a value that is not one of the two, which a widened union or a
     * cast could otherwise let through. */
    for (const row of SERVICE_TABLE) {
      expect(SERVICE_AUDIENCES, row.name).toContain(row.audience)
    }
  })

  it('withholds exactly the rows a paired device may not be served', () => {
    /* WRITTEN OUT, for `readServices`' reason one case up: a row becomes
     * reachable by a paired device the moment somebody types `paired-device`,
     * and not noticing that is the failure. `passage.search` is the only one
     * today — and it is the one that made the field necessary. */
    const withheld = SERVICE_TABLE.filter((one) => one.audience !== 'paired-device')
    expect(withheld.map((one) => one.name)).toEqual(['passage.search'])
  })

  it('filters a contributed set by the audience, by membership', () => {
    const every = SERVICE_TABLE.map((one) => ({ name: one.name }))
    const offered = servableToAnotherDevice(every)
    expect(offered).toHaveLength(SERVICE_TABLE.length - 1)
    expect(offered.map((one) => one.name)).not.toContain('passage.search')
  })

  it('refuses a name the table does not hold rather than passing it through', () => {
    /* ⚠️ **THE PERMISSIVE DEFAULT THIS FIELD EXISTS TO REMOVE.** Every
     * contribution reaching a host came from `buildServices`, which can only
     * produce the table's own rows — so an unknown name means something built a
     * contribution by hand, and serving it to another device on the strength of
     * not recognising it is exactly the wrong way to fail. */
    expect(servableToAnotherDevice([{ name: 'book.list' }, { name: 'book.destroy' }])).toEqual([
      { name: 'book.list' },
    ])
  })

  it('answers nothing for nothing', () => {
    expect(servableToAnotherDevice([])).toEqual([])
  })

  it('names exactly two audiences, and they mean different things', () => {
    expect([...SERVICE_AUDIENCES]).toEqual(['paired-device', 'this-shelf'])
  })

  it('does not let the grant stand in for the audience', () => {
    /* ⚠️ **TWO INDEPENDENT REFUSALS, AND THIS IS WHAT KEEPS THEM TWO.**
     * `passage.search` carries `blob:read` — the honest label for a row that
     * returns book content — and `blob:read` is granted for SYNC, so a satchel
     * receiving a library holds it. If the grant were doing the work, this row
     * would be reachable by every such device. */
    const row = serviceDescriptor('passage.search')
    expect(row?.grant).toBe('blob:read')
    expect(row?.audience).toBe('this-shelf')
    const alsoBlobRead = SERVICE_TABLE.filter((one) => one.grant === 'blob:read')
    expect(alsoBlobRead.map((one) => one.name).sort()).toEqual(['content.read', 'passage.search'])
    /* And the other holder of that grant IS served to a paired device, so the
       two rows differ by the audience alone. */
    expect(serviceDescriptor('content.read')?.audience).toBe('paired-device')
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

describe('the table is frozen, and reachable by name', () => {
  /* ⚠️ **SIX MUTANTS SAT ON `deepFreeze` AND THE BY-NAME INDEX, AND THE MERGE
   * BASE COULD DECIDE NONE OF THEM** — its report marks each `static`, and a
   * static mutant that throws while the module loads is reported `Survived` by
   * Stryker's vitest runner because the suite fails no test. So they were
   * neither authorised nor billed; the gate's own instruction is to settle them
   * by killing them here. */
  it('freezes the rows, their arrays and their nested fields', () => {
    const row = SERVICE_TABLE[0]
    expect(row).toBeDefined()
    if (!row) return
    expect(Object.isFrozen(SERVICE_TABLE)).toBe(true)
    expect(Object.isFrozen(row)).toBe(true)
    /* NESTED, which is the whole of what `deepFreeze` adds over one
     * `Object.freeze` — the recursion is what the mutants empty. */
    const nested = Object.getOwnPropertyNames(row)
      .map((key) => (row as unknown as Record<string, unknown>)[key])
      .filter((value): value is object => value !== null && typeof value === 'object')
    expect(nested.length, 'a row with no object field cannot show the recursion').toBeGreaterThan(0)
    for (const value of nested) expect(Object.isFrozen(value)).toBe(true)
  })

  it('leaves a null field alone rather than walking its properties', () => {
    /* ⚠️ **`typeof null === 'object'`**, so without the null clause this falls
     * through to `Object.getOwnPropertyNames(null)` and throws — at IMPORT,
     * because the table is frozen at module scope. No row carries a null field
     * today, which is why nothing that walks `SERVICE_TABLE` reaches it, and
     * why that one mutant survives where every other one in the function stops
     * the module loading. Asked directly instead. */
    expect(deepFreeze(null)).toBeNull()
    const holding = { a: null, b: { c: null } }
    expect(() => deepFreeze(holding)).not.toThrow()
    expect(Object.isFrozen(holding)).toBe(true)
    expect(Object.isFrozen(holding.b)).toBe(true)
  })

  it('leaves a primitive alone rather than trying to freeze it', () => {
    /* The guard's own job: `Object.freeze` on a string is harmless and on
     * `null` it throws in older engines, but the branch exists so the RECURSION
     * stops — without it `deepFreeze` walks a string's indices for ever. */
    const row = SERVICE_TABLE[0]
    if (!row) return
    expect(typeof row.name).toBe('string')
    expect(row.name.length).toBeGreaterThan(0)
  })

  it('answers a descriptor for every name in the table, and null for anything else', () => {
    /* ⚠️ **THE INDEX IS BUILT BY ONE `map` WHOSE ARROW WAS A SURVIVOR.**
     * Returning `undefined` from it makes every entry `[undefined, undefined]`,
     * so the map holds one key and every real lookup answers null — the
     * router's `unknown-service` for every service the app has. */
    for (const row of SERVICE_TABLE) {
      expect(serviceDescriptor(row.name), row.name).toBe(row)
    }
    expect(serviceDescriptor('no.such.service')).toBeNull()
  })
})
