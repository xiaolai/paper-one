import {
  SERVICE_NOUNS,
  flagFields,
  positionalFields,
  serviceDescriptor,
  servicesOn,
  type ServiceDescriptor,
  type ServiceField,
  type ServiceNoun,
} from '../kernel'

/**
 * `paper <noun> <verb> …`, parsed against the service table (WI-11.4).
 *
 * NOUN FIRST, and singular. Nine nouns against six verbs does not
 * tab-complete or discover as `paper list-books`: a reader who knows there is
 * something to do with tags types `paper tag` and is told what. Singular so
 * that the command and the service name are ONE string rather than two
 * spellings of one idea — `paper book list` IS `book.list`, and there is no
 * mapping table between them to get wrong.
 *
 * EVERY ARGUMENT COMES FROM THE DESCRIPTOR. Which arguments are positional,
 * which are `--flags`, what each one holds and which are required is read
 * from `ServiceDescriptor.input`; nothing about a command is written here.
 * That is what makes "the command list equals the table" checkable rather
 * than a claim, and what stops the CLI from inventing a second spelling of an
 * argument the service already named.
 */

/** What the parse produced, or why it could not. */
export type Parsed =
  | {
      readonly kind: 'run'
      readonly descriptor: ServiceDescriptor
      readonly body: Record<string, unknown>
      readonly json: boolean
      /** `--shelf <key>`, when one was given. Decides which CALLER to build. */
      readonly shelf?: string
    }
  | { readonly kind: 'help'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string; readonly text?: string }

/** The end-of-options marker: everything after it is a value, never a flag. */
export const END_OF_FLAGS = '--'

/** Global flags — the ones that are not any service's business. */
export const GLOBAL_FLAGS = ['--json', '--help', '-h', '--shelf'] as const

/**
 * How far apart two words are, capped at what is worth reporting.
 *
 * The plain Levenshtein distance, iterative and O(a·b) over two short words.
 * It exists for one sentence — "did you mean X" — and a suggestion is only
 * offered inside `SUGGEST_WITHIN`, because a distant "closest match" is worse
 * than none: it sends a reader to a command that was never what they meant.
 */
export function distance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_one, index) => index)
  for (let i = 1; i < rows; i++) {
    const current = [i, ...Array.from({ length: cols - 1 }, () => 0)]
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost)
    }
    previous = current
  }
  return previous[cols - 1] ?? Math.max(a.length, b.length)
}

/** Past this, a "closest match" is noise. */
export const SUGGEST_WITHIN = 3

/** The nearest of `candidates` to `word`, or null when none is near enough. */
export function closest(word: string, candidates: readonly string[]): string | null {
  let best: { word: string; at: number } | null = null
  for (const candidate of candidates) {
    const at = distance(word, candidate)
    if (at <= SUGGEST_WITHIN && (best === null || at < best.at)) best = { word: candidate, at }
  }
  return best?.word ?? null
}

const suggestion = (word: string, candidates: readonly string[]): string => {
  const near = closest(word, candidates)
  return near === null ? '' : ` — did you mean ${JSON.stringify(near)}?`
}

/* ------------------------------------------------------------------- help */

/** How one service is spelled on a command line, from its descriptor alone. */
export function usageOf(descriptor: ServiceDescriptor): string {
  const parts = [`paper ${descriptor.noun} ${descriptor.verb}`]
  for (const field of positionalFields(descriptor)) {
    parts.push(field.required === true ? `<${field.name}>` : `[${field.name}]`)
  }
  for (const field of flagFields(descriptor)) {
    const spelling = field.type === 'boolean' ? `--${field.name}` : `--${field.name} <${field.type}>`
    parts.push(field.required === true ? spelling : `[${spelling}]`)
  }
  return parts.join(' ')
}

/** Everything `paper` can do, by noun. */
export function overview(): string {
  const lines = ['paper <noun> <verb> [arguments] [--json]', '', 'Nouns:']
  for (const noun of SERVICE_NOUNS) {
    lines.push(`  ${noun.padEnd(8)} ${servicesOn(noun).map((one) => one.verb).join(' · ')}`)
  }
  lines.push('', 'paper <noun> --help lists what that noun can do.')
  return lines.join('\n')
}

/** One noun's verbs, with what each does. */
export function nounHelp(noun: ServiceNoun): string {
  const lines = [`paper ${noun} <verb>`, '']
  for (const descriptor of servicesOn(noun)) {
    lines.push(`  ${usageOf(descriptor)}`)
    lines.push(`      ${descriptor.summary}`)
    lines.push(`      grant: ${descriptor.grant}${descriptor.kind === 'stream' ? ' · streams' : ''}`)
  }
  return lines.join('\n')
}

/** One service, argument by argument. */
export function serviceHelp(descriptor: ServiceDescriptor): string {
  const lines = [usageOf(descriptor), '', `  ${descriptor.summary}`, `  grant: ${descriptor.grant}`]
  if (descriptor.input.length > 0) {
    lines.push('', '  Arguments:')
    for (const field of descriptor.input) {
      const where = field.positional === undefined ? `--${field.name}` : `<${field.name}>`
      const need = field.required === true ? ' (required)' : ''
      /* THE VOCABULARY, WHERE THE CALLER IS DECIDING WHAT TO TYPE. `choices`
       * lived in a handler, so this said `colour string` while the service
       * accepted three words — a caller learned them by being refused, which
       * is the least useful moment to be told. */
      const choices = field.choices === undefined ? '' : ` (${field.choices.join(' | ')})`
      lines.push(`    ${where.padEnd(14)} ${field.type}${choices}${need} — ${field.doc}`)
    }
  }
  /* AND THE CROSS-FIELD RULE. Without it the usage line above presents
   * `paper mark set <mark>` as a complete call; it is refused. */
  if (descriptor.atLeastOne !== undefined) {
    lines.push('', `  At least one of ${descriptor.atLeastOne.map((one) => `--${one}`).join(', ')} is required.`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ parse */

const isNoun = (word: string): word is ServiceNoun => (SERVICE_NOUNS as readonly string[]).includes(word)

/** A flag's value as the field's declared type, or a message saying why not. */
function coerce(field: ServiceField, raw: string): { value: unknown } | { error: string } {
  /* A CLOSED VOCABULARY IS REFUSED HERE TOO, and the duplication is the same
   * deliberate one the required-field check makes below: the service refuses
   * it either way, and this refusal can name the whole set beside the usage
   * line — where the caller is still deciding what to type. Read off the
   * field, so there is no second list of what the words are. */
  const outside = (value: string): { error: string } | null =>
    field.choices && !field.choices.includes(value)
      ? { error: `--${field.name} must be one of ${field.choices.join(', ')}, not ${JSON.stringify(value)}` }
      : null
  switch (field.type) {
    case 'string':
      return outside(raw) ?? { value: raw }
    case 'number': {
      /* `Number('')` is 0 and `Number(' ')` is 0 — an empty value must not
       * become a silent zero, which for `trash empty --count` would be a
       * confirmation the caller never gave. */
      const value = raw.trim() === '' ? Number.NaN : Number(raw)
      return Number.isFinite(value) ? { value } : { error: `--${field.name} takes a number, not ${JSON.stringify(raw)}` }
    }
    case 'boolean':
      if (raw === 'true' || raw === 'false') return { value: raw === 'true' }
      return { error: `--${field.name} is a flag; write --${field.name} or --no-${field.name}` }
    case 'string[]':
      /* Repeatable OR comma-separated, because both are what people type.
       * Empty segments are dropped: `--book a,,b` is two books. */
      {
        const parts = raw.split(',').map((one) => one.trim()).filter((one) => one !== '')
        const bad = parts.find((one) => field.choices && !field.choices.includes(one))
        return bad === undefined ? { value: parts } : (outside(bad) as { error: string })
      }
  }
}

/**
 * Parse `argv` — everything after the program name.
 *
 * Global flags are taken out first wherever they appear, so `paper --json book
 * list` and `paper book list --json` are the same command. `--shelf <key>` is
 * one of them: it decides which CALLER to build rather than what to call, and
 * the entry reads it off this result.
 *
 * IT USED TO BE PARSED TWICE. `paper()` scanned argv for `--shelf` and removed
 * it wherever it appeared, and this function then REFUSED a `--shelf` after
 * the verb — a refusal nothing could reach, because the entry had already
 * taken it out. So `paper book list --shelf k` was documented as an error, was
 * asserted as an error by a test that called this function directly, and
 * worked perfectly in the shipped binary. Two parsers over one argv, and the
 * test was measuring the one that does not run.
 *
 * `--` ENDS THE FLAGS. Everything after it is a value, however it is spelled —
 * without it there was no way to pass a positional that begins with two
 * dashes, and `paper card add --json` could not mean a card whose text is
 * "--json". A reader writing about command-line tools meets this on their
 * first card.
 */
export function parseArgs(argv: readonly string[]): Parsed {
  const rest: string[] = []
  let json = false
  let help = false
  let shelf: string | null = null
  let literal = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (literal) {
      rest.push(arg)
      continue
    }
    if (arg === END_OF_FLAGS) {
      literal = true
      /* KEPT, not dropped: the global loop stops reading flags here, and
       * `readBody` needs the same boundary to stop reading them too. One
       * marker, honoured by both halves of the parse. */
      rest.push(arg)
    }
    else if (arg === '--json') json = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--shelf') {
      const value = argv[i + 1]
      /* AN EMPTY `--shelf` IS NOT "LOCAL": it is a caller who meant to name a
       * shelf and did not, and silently answering from the local library would
       * be the wrong library's answer wearing the right one's face. */
      if (value === undefined || value.startsWith('--')) {
        return { kind: 'error', message: '--shelf needs a shelf key' }
      }
      shelf = value
      i++
    } else rest.push(arg)
  }

  const noun = rest[0]
  if (noun === undefined) {
    return help ? { kind: 'help', text: overview() } : { kind: 'error', message: 'no command', text: overview() }
  }
  if (!isNoun(noun)) {
    return { kind: 'error', message: `unknown noun ${JSON.stringify(noun)}${suggestion(noun, SERVICE_NOUNS)}`, text: overview() }
  }

  const verb = rest[1]
  if (verb === undefined) {
    return help ? { kind: 'help', text: nounHelp(noun) } : { kind: 'error', message: `paper ${noun} needs a verb`, text: nounHelp(noun) }
  }
  const descriptor = serviceDescriptor(`${noun}.${verb}`)
  if (!descriptor) {
    const verbs = servicesOn(noun).map((one) => one.verb)
    return {
      kind: 'error',
      message: `${noun} has no verb ${JSON.stringify(verb)}${suggestion(verb, verbs)}`,
      text: nounHelp(noun),
    }
  }
  if (help) return { kind: 'help', text: serviceHelp(descriptor) }

  const parsed = readBody(descriptor, rest.slice(2), json)
  return parsed.kind === 'run' && shelf !== null ? { ...parsed, shelf } : parsed
}

function readBody(descriptor: ServiceDescriptor, words: readonly string[], json: boolean): Parsed {
  const body: Record<string, unknown> = {}
  const positionals = positionalFields(descriptor)
  const byName = new Map(descriptor.input.map((field) => [field.name, field]))
  const loose: string[] = []

  let literal = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    /* EVERYTHING AFTER `--` IS A VALUE. Without it a positional beginning
     * with two dashes had no spelling at all: a card whose text is `--json`,
     * a book titled `--- draft ---`. */
    if (!literal && word === END_OF_FLAGS) {
      literal = true
      continue
    }
    if (literal || !word.startsWith('--')) {
      loose.push(word)
      continue
    }
    /* `--no-<flag>` sets a boolean false. Without it there is no way to ask
     * `book list --finished false` — a flag's absence means "do not filter",
     * which is a third state and not the same as false. */
    const negated = word.startsWith('--no-')
    const name = negated ? word.slice('--no-'.length) : word.slice(2)
    const field = byName.get(name)
    if (!field) {
      const near = suggestion(name, [...byName.keys()])
      return { kind: 'error', message: `${descriptor.name} has no --${name}${near}`, text: serviceHelp(descriptor) }
    }
    if (field.positional !== undefined) {
      return {
        kind: 'error',
        message: `${field.name} is positional: ${usageOf(descriptor)}`,
        text: serviceHelp(descriptor),
      }
    }
    if (negated) {
      if (field.type !== 'boolean') {
        return { kind: 'error', message: `--no-${name} is only for flags, and --${name} takes a ${field.type}` }
      }
      body[name] = false
      continue
    }
    if (field.type === 'boolean') {
      body[name] = true
      continue
    }
    const raw = words[i + 1]
    if (raw === undefined || raw.startsWith('--')) {
      return { kind: 'error', message: `--${name} needs a value`, text: serviceHelp(descriptor) }
    }
    i++
    const read = coerce(field, raw)
    if ('error' in read) return { kind: 'error', message: read.error, text: serviceHelp(descriptor) }
    /* A repeated `--book` ACCUMULATES for a list field and REPLACES for
     * everything else. Accumulating a string would silently join two values
     * a caller meant as one correction of the other. */
    body[name] =
      field.type === 'string[]' && Array.isArray(body[name])
        ? [...(body[name] as string[]), ...(read.value as string[])]
        : read.value
  }

  if (loose.length > positionals.length) {
    return {
      kind: 'error',
      message: `${descriptor.name} takes ${positionals.length} positional ${positionals.length === 1 ? 'argument' : 'arguments'}, not ${loose.length}: ${usageOf(descriptor)}`,
      text: serviceHelp(descriptor),
    }
  }
  for (let i = 0; i < loose.length; i++) {
    const field = positionals[i] as ServiceField
    const read = coerce(field, loose[i] as string)
    if ('error' in read) {
      return { kind: 'error', message: read.error.replace(`--${field.name}`, `<${field.name}>`), text: serviceHelp(descriptor) }
    }
    body[field.name] = read.value
  }

  /* AND THE CROSS-FIELD RULE, for the same reason and with the same message
   * the service gives — pointed at the flags rather than at the field names,
   * because that is how a caller wrote them. */
  const anyOf = descriptor.atLeastOne
  if (anyOf && !anyOf.some((name) => body[name] !== undefined)) {
    return {
      kind: 'error',
      message: `${descriptor.name} needs at least one of ${anyOf.join(', ')}: ${usageOf(descriptor)}`,
      text: serviceHelp(descriptor),
    }
  }

  /* Required fields are checked HERE as well as by the service's own
   * validator, and the duplication is deliberate: the CLI can say
   * `paper book get <book>` and point at the argument, where the service can
   * only say `book.get needs book`. The service still refuses — this is the
   * better message, not the only check. */
  for (const field of descriptor.input) {
    if (field.required === true && body[field.name] === undefined) {
      return {
        kind: 'error',
        message: `${descriptor.name} needs ${field.positional === undefined ? `--${field.name}` : `<${field.name}>`}: ${usageOf(descriptor)}`,
        text: serviceHelp(descriptor),
      }
    }
  }
  return { kind: 'run', descriptor, body, json }
}
