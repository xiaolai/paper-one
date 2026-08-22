import { describe, expect, it } from 'vitest'
import { SERVICE_NOUNS, SERVICE_TABLE, serviceDescriptor, servicesOn, type ServiceDescriptor } from '../kernel'
import { SUGGEST_WITHIN, closest, distance, nounHelp, overview, parseArgs, serviceHelp, usageOf } from './args'

/**
 * `paper <noun> <verb>`, parsed (WI-11.4).
 *
 * Everything asserted here is about the parse being DERIVED. There is no list
 * of commands in `args.ts` and no per-service knowledge, so the tests that
 * matter are the ones that would catch a list creeping back in: every noun in
 * the table is a noun the parser accepts, every verb on it parses, and every
 * required field is demanded by name.
 */

/** The `run` branch, or a failure naming what came back instead. */
function run(argv: readonly string[]) {
  const parsed = parseArgs(argv)
  if (parsed.kind !== 'run') throw new Error(`expected a command, got ${parsed.kind}: ${JSON.stringify(parsed)}`)
  return parsed
}

function error(argv: readonly string[]): string {
  const parsed = parseArgs(argv)
  if (parsed.kind !== 'error') throw new Error(`expected an error, got ${parsed.kind}`)
  return parsed.message
}

/**
 * A refusal's message AND the context it carries.
 *
 * `error()` returns only the message, so every assertion built on it passed
 * whether or not the second half — the overview, or the offending service's
 * own usage — was still there. That context is most of what makes a CLI error
 * actionable, and it could have been deleted without a single test noticing.
 */
function errorWithText(argv: readonly string[]): { message: string; text: string } {
  const parsed = parseArgs(argv)
  if (parsed.kind !== 'error') throw new Error(`expected an error, got ${parsed.kind}`)
  return { message: parsed.message, text: parsed.text ?? '' }
}

describe('every command in the table parses', () => {
  it('accepts each noun and verb the table declares', () => {
    for (const descriptor of SERVICE_TABLE) {
      /* A body that satisfies whatever this service requires, built from the
       * schema — so a new required field cannot make this test stale without
       * making it fail. */
      const words: string[] = [descriptor.noun, descriptor.verb]
      /* A CROSS-FIELD RULE IS NOT ON ANY FIELD, so a body built from
       * `required` alone is refused by `mark.set` — and this test's claim is
       * that every command PARSES, not that some of them do. */
      const needed = new Set<string>(descriptor.atLeastOne?.slice(0, 1) ?? [])
      for (const field of descriptor.input) {
        if (field.required !== true && !needed.has(field.name)) continue
        /* A field with a closed vocabulary takes one of its words, not `x`. */
        const value = field.choices?.[0] ?? (field.type === 'number' ? '1' : 'x')
        if (field.positional !== undefined) words.push(value)
        else if (field.type === 'boolean') words.push(`--${field.name}`)
        else words.push(`--${field.name}`, value)
      }
      const parsed = run(words)
      expect(parsed.descriptor.name).toBe(descriptor.name)
      for (const field of descriptor.input) {
        if (field.required === true) expect(parsed.body[field.name]).toBeDefined()
      }
    }
  })

  /**
   * EACH VERB UNDER ITS OWN NOUN.
   *
   * This searched the WHOLE overview for each verb, so a verb missing from one
   * noun's line still passed as long as some other noun happened to declare a
   * verb of the same name — and they overlap heavily: `list`, `add`, `remove`
   * and `set` appear on several nouns each. A reader looking up `card` would
   * have found the line short and nothing would have said so.
   */
  it('names every noun in the overview, with its own verbs on its own line', () => {
    const text = overview()
    for (const noun of SERVICE_NOUNS) {
      const line = text.split('\n').find((one) => one.trim().startsWith(noun))
      expect(line, `no line for ${noun}`).toBeDefined()
      for (const descriptor of servicesOn(noun)) {
        expect(line, `${noun} is missing ${descriptor.verb}`).toContain(descriptor.verb)
      }
    }
  })
})

describe('positional and flag arguments', () => {
  it('reads positionals in the order the schema numbers them', () => {
    expect(run(['tag', 'rename', 'sci-fi', 'science-fiction']).body).toEqual({ from: 'sci-fi', to: 'science-fiction' })
  })

  it('reads a flag and its value', () => {
    expect(run(['book', 'list', '--tag', 'philosophy']).body).toEqual({ tag: 'philosophy' })
  })

  it('reads a boolean flag as presence, and --no- as false', () => {
    expect(run(['book', 'list', '--finished']).body).toEqual({ finished: true })
    expect(run(['book', 'list', '--no-finished']).body).toEqual({ finished: false })
    /* Absence is a THIRD state — "do not filter" — and must not become false. */
    expect(run(['book', 'list']).body).toEqual({})
  })

  it('reads a number, and refuses one that is not', () => {
    expect(run(['book', 'list', '--limit', '5']).body).toEqual({ limit: 5 })
    expect(error(['book', 'list', '--limit', 'five'])).toContain('takes a number')
    /* `Number('')` is 0. An empty value must not become a silent zero — for
     * `trash empty --count` that would be a confirmation nobody gave. */
    expect(error(['book', 'list', '--limit', ''])).toContain('takes a number')
  })

  it('reads a list flag repeated and comma-separated, accumulating both ways', () => {
    expect(run(['tag', 'add', 'sea', '--book', 'a', '--book', 'b']).body).toEqual({ tag: 'sea', book: ['a', 'b'] })
    expect(run(['tag', 'add', 'sea', '--book', 'a,b']).body).toEqual({ tag: 'sea', book: ['a', 'b'] })
    expect(run(['tag', 'add', 'sea', '--book', 'a,,b']).body).toEqual({ tag: 'sea', book: ['a', 'b'] })
  })

  it('lets a repeated scalar flag replace rather than accumulate', () => {
    expect(run(['book', 'list', '--tag', 'a', '--tag', 'b']).body).toEqual({ tag: 'b' })
  })

  it('takes --json wherever it appears', () => {
    expect(run(['--json', 'book', 'list']).json).toBe(true)
    expect(run(['book', 'list', '--json']).json).toBe(true)
    expect(run(['book', 'list']).json).toBe(false)
  })
})

describe('what it refuses', () => {
  it('refuses an unknown noun and names the closest', () => {
    expect(error(['bok', 'list'])).toContain('did you mean "book"')
  })

  it('refuses an unknown verb and names the closest', () => {
    expect(error(['book', 'lst'])).toContain('did you mean "list"')
  })

  it('offers no suggestion when nothing is near — a wrong pointer is worse than none', () => {
    const message = error(['xylophone', 'list'])
    expect(message).toContain('unknown noun')
    expect(message).not.toContain('did you mean')
  })

  /**
   * THE BOUNDARY ITSELF, which nothing pinned.
   *
   * The cases above are distance 1 and a word nowhere near anything, so
   * changing `SUGGEST_WITHIN` from 3 to 2, 4, 5 or 6 left every one of them
   * passing. The threshold is the whole decision — past it a "closest match"
   * sends a reader to a command that was never what they meant.
   */
  it('suggests exactly up to the declared distance, and not past it', () => {
    /* THE VALUE ITSELF, pinned. Everything below is written RELATIVE to
     * `SUGGEST_WITHIN`, which proves the code is internally consistent and
     * nothing more — raise the constant and those assertions rise with it.
     * The threshold is a decision about every error message the CLI prints,
     * so changing it should cost an edit here, deliberately. */
    expect(SUGGEST_WITHIN).toBe(3)

    const candidates = ['book']
    const at = (word: string) => distance(word, 'book')

    /* Appending N characters is exactly N edits away, so the distance is
     * stated by construction rather than counted by hand. */
    const inside = `book${'x'.repeat(SUGGEST_WITHIN)}`
    expect(at(inside)).toBe(SUGGEST_WITHIN)
    expect(closest(inside, candidates)).toBe('book')

    const outside = `book${'x'.repeat(SUGGEST_WITHIN + 1)}`
    expect(at(outside)).toBe(SUGGEST_WITHIN + 1)
    expect(closest(outside, candidates)).toBeNull()
  })

  /* A TIE GOES TO THE FIRST CANDIDATE, and the candidates are the table's own
   * order — so the answer is stable rather than dependent on iteration order
   * a reader cannot see. */
  it('answers the same suggestion for a word equidistant from two candidates', () => {
    const candidates = ['aaa', 'bbb']
    expect(distance('xxx', 'aaa')).toBe(distance('xxx', 'bbb'))
    expect(closest('xxx', candidates)).toBe('aaa')
    expect(closest('xxx', [...candidates].reverse())).toBe('bbb')
  })

  it('refuses a flag the service does not declare, and names the closest', () => {
    expect(error(['book', 'list', '--finshed'])).toContain('did you mean "finished"')
  })

  it('refuses a flag with no value', () => {
    expect(error(['book', 'list', '--tag'])).toContain('needs a value')
    /* The next `--` is not a value: `--tag --json` means the tag was
     * forgotten, not that the tag is "--json". */
    expect(error(['book', 'list', '--tag', '--limit', '5'])).toContain('needs a value')
  })

  it('refuses --no- on a flag that is not a boolean', () => {
    expect(error(['book', 'list', '--no-tag'])).toContain('only for flags')
  })

  it('refuses a positional written as a flag, and points at the usage line', () => {
    expect(error(['book', 'get', '--book', 'x'])).toContain('positional')
  })

  it('refuses more positionals than the service takes', () => {
    expect(error(['book', 'get', 'a', 'b'])).toContain('positional')
  })

  it('demands a required argument by name, with the usage line', () => {
    expect(error(['book', 'get'])).toContain('<book>')
    expect(error(['tag', 'add', 'sea'])).toContain('--book')
  })

  it('refuses a bare noun, and no command at all', () => {
    expect(error(['book'])).toContain('needs a verb')
    expect(error([])).toContain('no command')
  })

  it('refuses --shelf with no key rather than answering from the local library', () => {
    /* An empty `--shelf` is a caller who meant to name a shelf and did not.
     * Silently answering locally would be the wrong library's answer wearing
     * the right one's face. */
    expect(error(['book', 'list', '--shelf'])).toContain('needs a shelf key')
    expect(error(['--shelf', '--json', 'book', 'list'])).toContain('needs a shelf key')
  })
})

/**
 * `--shelf` IS A GLOBAL FLAG, read wherever it appears — like `--json`.
 *
 * It used to be parsed TWICE. `paper()` scanned argv and removed it from
 * anywhere; this function then refused one appearing after the verb — a
 * refusal nothing could reach, because the entry had already taken it out. So
 * `paper book list --shelf k` was documented as an error, asserted as an error
 * by a test that called this function directly, and worked perfectly in the
 * shipped binary. One parser now, and these assertions describe it.
 */
describe('--shelf', () => {
  const shelfOf = (argv: readonly string[]) => {
    const parsed = parseArgs(argv)
    expect(parsed.kind, JSON.stringify(argv)).toBe('run')
    return parsed.kind === 'run' ? (parsed.shelf ?? null) : null
  }

  it('is read before the command, after it, and in the middle', () => {
    expect(shelfOf(['--shelf', 'k', 'book', 'list'])).toBe('k')
    expect(shelfOf(['book', 'list', '--shelf', 'k'])).toBe('k')
    expect(shelfOf(['book', '--shelf', 'k', 'list'])).toBe('k')
  })

  it('is absent when nobody named one', () => {
    expect(shelfOf(['book', 'list'])).toBeNull()
  })

  /* IT IS NOT A SERVICE'S ARGUMENT. Taking it out must not shift the
   * positionals it sat between. */
  it('does not disturb the positionals around it', () => {
    const parsed = parseArgs(['book', 'add', 'b1', '--shelf', 'k', 'Moby-Dick'])
    expect(parsed.kind).toBe('run')
    if (parsed.kind !== 'run') return
    expect(parsed.body).toMatchObject({ book: 'b1', title: 'Moby-Dick' })
    expect(parsed.shelf).toBe('k')
  })
})

/**
 * `--` ENDS THE FLAGS, and without it a whole class of values could not be
 * written at all.
 *
 * Every `--…` token was a flag, so a card whose text is `--json`, a book
 * titled `--- draft ---`, or a tag beginning with two dashes had no spelling
 * on this command line. A reader writing about command-line tools meets that
 * on their first card.
 */
describe('the end-of-flags marker', () => {
  it('lets a positional begin with two dashes', () => {
    const parsed = parseArgs(['card', 'add', '--', '--json'])
    expect(parsed.kind).toBe('run')
    if (parsed.kind !== 'run') return
    expect(parsed.body).toMatchObject({ text: '--json' })
    /* And the `--json` after it is the CARD, not the output format. */
    expect(parsed.json).toBe(false)
  })

  it('takes everything after it literally, flags included', () => {
    const parsed = parseArgs(['book', 'add', '--', '--b1', '--shelf'])
    expect(parsed.kind).toBe('run')
    if (parsed.kind !== 'run') return
    expect(parsed.body).toMatchObject({ book: '--b1', title: '--shelf' })
    expect(parsed.shelf).toBeUndefined()
  })

  it('still honours a global flag written before it', () => {
    const parsed = parseArgs(['--json', 'card', 'add', '--', '--x'])
    expect(parsed.kind).toBe('run')
    if (parsed.kind !== 'run') return
    expect(parsed.json).toBe(true)
    expect(parsed.body).toMatchObject({ text: '--x' })
  })

  it('is not itself a positional', () => {
    const parsed = parseArgs(['book', 'list', '--'])
    expect(parsed.kind).toBe('run')
  })
})

/**
 * A CLOSED VOCABULARY AND A CROSS-FIELD RULE ARE DECLARED, ENFORCED AND SHOWN.
 *
 * `choices` and `atLeastOne` lived in the handlers, so the schema could not
 * express them: `--help` and the generated reference both showed
 * `--colour <string>` while the service accepted three words, and both
 * presented `paper mark set <mark>` as a complete call when it is refused. A
 * caller learned the vocabulary by being refused, which is the least useful
 * moment to be told.
 */
describe('a field with a closed vocabulary', () => {
  it('is offered in the service’s help, where the caller is deciding what to type', () => {
    const text = serviceHelp(serviceDescriptor('mark.set') as ServiceDescriptor)
    expect(text).toContain('yellow | green | purple')
    expect(text).toContain('At least one of --note, --colour is required.')
  })

  it('accepts a declared value and refuses anything else, naming the set', () => {
    expect(run(['mark', 'set', 'm1', '--colour', 'green']).body).toMatchObject({ colour: 'green' })
    const message = error(['mark', 'set', 'm1', '--colour', 'octarine'])
    expect(message).toContain('one of yellow, green, purple')
  })

  it('refuses a call that names none of the fields it needs one of', () => {
    expect(error(['mark', 'set', 'm1'])).toContain('at least one of note, colour')
  })

  /* AND THE SAME FOR THE OTHER TWO VOCABULARIES the table now declares, so
   * this is a property of the schema rather than of one row. */
  it('holds every field that declares choices to them', () => {
    for (const [argv, bad] of [
      [['mark', 'add', 'b1', 'epubcfi(/6/4)', '--kind'], 'scribble'],
      [['card', 'add', 'a thought', '--kind'], 'Nonsense'],
    ] as const) {
      expect(error([...argv, bad]), argv.join(' ')).toContain('must be one of')
    }
  })
})

describe('help', () => {
  /* THE TEXT, not merely the branch. `kind === 'help'` alone is satisfied by
   * an empty string — the one thing a help command must never answer. */
  it('answers the overview for --help with no command, and for -h', () => {
    for (const flag of ['--help', '-h']) {
      const parsed = parseArgs([flag])
      expect(parsed.kind, flag).toBe('help')
      if (parsed.kind !== 'help') continue
      expect(parsed.text.length, flag).toBeGreaterThan(0)
      expect(parsed.text, flag).toBe(overview())
      /* And it really is the overview: every noun is named. */
      for (const noun of SERVICE_NOUNS) expect(parsed.text, `${flag} omits ${noun}`).toContain(noun)
    }
  })

  it('answers a noun’s verbs for `paper <noun> --help`', () => {
    const parsed = parseArgs(['tag', '--help'])
    expect(parsed.kind).toBe('help')
    expect(parsed.kind === 'help' && parsed.text).toContain('paper tag rename <from> <to>')
  })

  it('answers one service’s arguments for `paper <noun> <verb> --help`', () => {
    const parsed = parseArgs(['book', 'list', '--help'])
    expect(parsed.kind).toBe('help')
    const text = parsed.kind === 'help' ? parsed.text : ''
    expect(text).toContain('--tag')
    expect(text).toContain('book:read')
  })

  it('spells every service’s usage line from its descriptor alone', () => {
    expect(usageOf(serviceDescriptor('book.get')!)).toBe('paper book get <book>')
    expect(usageOf(serviceDescriptor('book.add')!)).toBe('paper book add <book> <title> [author] [--ext <string>]')
    /* The optional `--books` is the membership confirmation: a count cannot see
     * a swap, so a caller that can name what it reviewed should. It appears here
     * because the usage line is DERIVED — the flag exists in the descriptor, so
     * it exists in the help, with nothing kept in step by hand. */
    expect(usageOf(serviceDescriptor('trash.empty')!)).toBe('paper trash empty <count> [--books <string[]>]')
  })

  it('documents every field of every service', () => {
    for (const descriptor of SERVICE_TABLE) {
      const text = serviceHelp(descriptor)
      for (const field of descriptor.input) expect(text).toContain(field.doc)
      expect(nounHelp(descriptor.noun)).toContain(descriptor.summary)
    }
  })
})

describe('closest', () => {
  it('measures the plain edit distance', () => {
    expect(distance('', '')).toBe(0)
    expect(distance('book', 'book')).toBe(0)
    expect(distance('bok', 'book')).toBe(1)
    expect(distance('', 'book')).toBe(4)
    expect(distance('kitten', 'sitting')).toBe(3)
  })

  it('answers null past the suggestion window', () => {
    expect(closest('lst', ['list', 'get'])).toBe('list')
    expect(closest('xylophone', ['list', 'get'])).toBeNull()
  })
})

/**
 * WHAT THE ERROR PATH ACTUALLY HANDS A READER.
 *
 * Everything above asserts the message. The `text` beside it — the overview
 * for an unknown noun, the service's usage for a bad argument — was never
 * read by a test, so it could have gone missing silently. It is the half that
 * tells somebody what to type next.
 */
describe('a refusal carries its context, not just its complaint', () => {
  it('offers the overview when the noun is not one', () => {
    const { message, text } = errorWithText(['nonsense', 'list'])
    expect(message).toMatch(/nonsense/)
    /* The overview names the nouns, so a reader who mistyped can see the set. */
    for (const noun of SERVICE_NOUNS) expect(text).toContain(noun)
  })

  it('offers the service’s own usage when the arguments are wrong', () => {
    const { text } = errorWithText(['book', 'get'])
    expect(text).toContain('paper book get <book>')
  })

  /* `usageOf` is derived from the descriptor, so "every service" can be
   * checked rather than sampled — three were, and the other twenty-five were
   * covered by the words "every service" alone. */
  it('can spell a usage line for every service in the table', () => {
    for (const descriptor of SERVICE_TABLE) {
      const usage = usageOf(descriptor)
      expect(usage.startsWith(`paper ${descriptor.noun} ${descriptor.verb}`), usage).toBe(true)
      /* Every required field appears, so a positional cannot go missing from
       * the help while the parser still demands it. */
      for (const field of descriptor.input.filter((one) => one.required === true)) {
        expect(usage, `${descriptor.name} omits ${field.name}`).toContain(field.name)
      }
    }
  })

  /* The one destructive verb takes a NUMBER positionally, and a positional is
   * where a string slips through most easily — it never passes a flag parser.
   * A `trash empty` that accepted "3x" would confirm a count nobody meant. */
  it('refuses a non-numeric count for the irreversible verb', () => {
    for (const bad of ['3x', '', 'NaN', '1e', '--2']) {
      const parsed = parseArgs(['trash', 'empty', bad])
      expect(parsed.kind, `trash empty ${JSON.stringify(bad)}`).toBe('error')
    }
    const good = parseArgs(['trash', 'empty', '3'])
    expect(good.kind).toBe('run')
  })
})
