import { serviceDescriptor, type ServiceDescriptor, type ServiceField } from '../serviceTable'
import { SERVICE_ERRORS, refuse } from './refusals'

/**
 * A request body, checked against its descriptor's input schema (WI-11.3).
 *
 * THE WIRE IS A TRUST BOUNDARY, exactly as a file is. Every handler below
 * receives its arguments through here and nothing else, so a body arriving
 * from a peer is validated by the same code that validates one the CLI built
 * — one validator, one set of refusals, and no handler carrying its own
 * hand-written `typeof` ladder that could disagree with the schema the
 * documentation was generated from.
 *
 * What it refuses, and why each one is refused rather than coerced:
 *
 *   - a body that is not an object — including an array, which `typeof` calls
 *     an object and whose numeric keys would satisfy nothing
 *   - a field the schema does not name. Silently ignoring one is how a
 *     misspelled `--finished` becomes an unfiltered list that looks right
 *   - a required field that is absent
 *   - a value of the wrong type. `"3"` is not `3`: the CLI knows what a field
 *     holds because the schema says so, and it is the CLI's job to parse the
 *     string, not this one's job to guess
 *   - a non-finite number. `JSON.parse("1e400")` yields `Infinity`, which is
 *     not a JSON value and re-encodes as `null`
 */

/**
 * The descriptor a handler validates against, by name.
 *
 * ONE COPY. Every noun's module needs it, and eight copies of a five-line
 * lookup is seven chances for one of them to answer differently. Unreachable
 * through `buildServices`, which is keyed by the table's own names — but a
 * lookup that CAN return null must say so where it happens rather than hand
 * an `undefined` to the validator and fail two frames later.
 */
export function descriptorOf(name: string): ServiceDescriptor {
  const found = serviceDescriptor(name)
  if (!found) throw refuse(SERVICE_ERRORS.unsupported, `${name} is not in the service table`)
  return found
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The value a field may hold, once checked. */
export type FieldValue = string | number | boolean | readonly string[]

/** A validated body: only the fields the schema names, only where supplied. */
export type ServiceInput = Readonly<Record<string, FieldValue | undefined>>

function checkField(field: ServiceField, value: unknown): FieldValue {
  const wrong = (why: string): never => {
    throw refuse(SERVICE_ERRORS.malformed, `${field.name} ${why}`)
  }
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return wrong('must be a string')
      /* An empty id reaches `folderOf`, which turns it into ONE path segment
       * — and an empty segment is not a book's folder, it is the library's.
       * `bookFolder` refuses it too; this is where the caller learns which
       * field was wrong. Trimmed, because a field of spaces is empty. */
      if (field.nonEmpty === true && value.trim() === '') return wrong('must not be empty')
      /* REFUSED, never truncated. `parseRecord` slices a prose field and
       * drops an over-long position, which is right for a file somebody may
       * have hand-edited — and wrong here: a caller told the write succeeded
       * and handed back the value they sent would find a different one on the
       * next read, with nothing in between having said so. */
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return wrong(`must be at most ${field.maxLength} characters, not ${value.length}`)
      }
      /* A CLOSED SET, NAMED IN THE REFUSAL. The handlers enforced these and
       * the table did not say them, so `--help` and the generated reference
       * both showed `<string>` while the service accepted three words. A
       * caller learned the vocabulary by being refused; now the refusal is
       * the same one every other malformed field gets, and the reference
       * prints the list. */
      if (field.choices && !field.choices.includes(value)) {
        return wrong(`must be one of ${field.choices.join(', ')}, not ${JSON.stringify(value)}`)
      }
      return value
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return wrong('must be a finite number')
      if (field.integer === true && !Number.isInteger(value)) return wrong('must be a whole number')
      /* REFUSED, never clamped. Clamping answers a question the caller did
       * not ask — a fractional `count` becomes a confusing conflict, a
       * negative `limit` silently returns nothing — and they have no way to
       * find out it happened. */
      if (field.min !== undefined && value < field.min) return wrong(`must be at least ${field.min}`)
      if (field.max !== undefined && value > field.max) return wrong(`must be at most ${field.max}`)
      return value
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : wrong('must be true or false')
    case 'string[]': {
      if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) return wrong('must be a list of strings')
      if (field.nonEmpty === true && value.some((one) => one.trim() === '')) return wrong('must hold no empty entry')
      const most = field.maxItems
      if (most !== undefined && value.length > most) {
        return wrong(`must hold at most ${most} entries, not ${value.length}`)
      }
      const longest = field.maxLength
      if (longest !== undefined && value.some((one) => one.length > longest)) {
        return wrong(`must hold no entry longer than ${longest} characters`)
      }
      const allowed = field.choices
      if (allowed && value.some((one) => !allowed.includes(one))) {
        return wrong(`must hold only ${allowed.join(', ')}`)
      }
      return value as readonly string[]
    }
  }
}

/**
 * `body` as this service's arguments, or a `malformed` refusal.
 *
 * `null` and `undefined` are read as an empty body, because a service with no
 * required fields is legitimately called with nothing — `paper shelf status`
 * sends `null`, and `end`/`cancel` frames carry exactly that.
 */
export function readInput(descriptor: ServiceDescriptor, body: unknown): ServiceInput {
  const raw = body === null || body === undefined ? {} : body
  if (!isPlainObject(raw)) {
    throw refuse(SERVICE_ERRORS.malformed, `${descriptor.name} takes an object body`)
  }
  const known = new Set(descriptor.input.map((field) => field.name))
  for (const key of Object.keys(raw)) {
    /* WITHDRAWN BEFORE UNKNOWN. A field the row refuses on purpose gets the
     * row's own sentence, not the misspelling's — `book.set` with a `title`
     * is a caller asking for a rename, and "no such field" would send them
     * looking for the spelling of an edit that is not offered. */
    const gone = descriptor.withdrawn?.find((one) => one.name === key)
    if (gone) throw refuse(SERVICE_ERRORS.malformed, `${descriptor.name} does not take ${key}: ${gone.why}`)
    if (!known.has(key)) throw refuse(SERVICE_ERRORS.malformed, `${descriptor.name} has no field ${JSON.stringify(key)}`)
  }
  const out: Record<string, FieldValue> = {}
  for (const field of descriptor.input) {
    const value = raw[field.name]
    if (value === undefined) {
      if (field.required === true) throw refuse(SERVICE_ERRORS.malformed, `${descriptor.name} needs ${field.name}`)
      continue
    }
    out[field.name] = checkField(field, value)
  }
  /* A CROSS-FIELD RULE, ENFORCED WHERE EVERY OTHER MALFORMED BODY IS.
   *
   * "at least one of these" is not something a per-field schema can say, so
   * the two services that need it said it in their handlers — and the
   * generated reference presented `paper mark set <mark>` as a complete call
   * when it is refused. Declared on the descriptor, it is one statement that
   * is both enforced and published. */
  const anyOf = descriptor.atLeastOne
  if (anyOf && !anyOf.some((name) => out[name] !== undefined)) {
    throw refuse(SERVICE_ERRORS.malformed, `${descriptor.name} needs at least one of ${anyOf.join(', ')}`)
  }
  return out
}

/* The readers below narrow a validated value to the type its schema declared.
 * They exist so a handler says `str(input, 'book')` rather than casting: the
 * cast would be a promise about a value the validator has already proved, and
 * a promise is what drifts when a schema changes. */

export function str(input: ServiceInput, name: string): string | undefined {
  const value = input[name]
  return typeof value === 'string' ? value : undefined
}

/** A required string. The schema already refused an absent one; this is what
 *  turns "the validator proved it" into a type the compiler agrees with. */
export function reqStr(input: ServiceInput, name: string): string {
  const value = str(input, name)
  if (value === undefined) throw refuse(SERVICE_ERRORS.malformed, `${name} is required`)
  return value
}

export function num(input: ServiceInput, name: string): number | undefined {
  const value = input[name]
  return typeof value === 'number' ? value : undefined
}

export function reqNum(input: ServiceInput, name: string): number {
  const value = num(input, name)
  if (value === undefined) throw refuse(SERVICE_ERRORS.malformed, `${name} is required`)
  return value
}

export function bool(input: ServiceInput, name: string): boolean | undefined {
  const value = input[name]
  return typeof value === 'boolean' ? value : undefined
}

export function list(input: ServiceInput, name: string): readonly string[] | undefined {
  const value = input[name]
  return Array.isArray(value) ? (value as readonly string[]) : undefined
}

export function reqList(input: ServiceInput, name: string): readonly string[] {
  const value = list(input, name)
  if (value === undefined) throw refuse(SERVICE_ERRORS.malformed, `${name} is required`)
  return value
}
