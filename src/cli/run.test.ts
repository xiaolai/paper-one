import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SERVICE_NAMES, SERVICE_TABLE, readServices, readingGrant, serviceDescriptor, type ServiceDescriptor } from '../kernel'
import { openNodeServices, type NodeHost } from '../hosts/node/services'
import { FIXTURE, FIXTURE_FILES } from '../hosts/node/fixture.testkit'
import { localCaller } from './caller'
import { render, table } from './format'
import { paper } from './paper'
import { EXIT, commandList, runCommand } from './run'

/**
 * `paper`, end to end over a real library directory (WI-11.4).
 *
 * Over a REAL directory rather than a fake, because the point of the in-
 * process path is that there is nothing between the command and the files —
 * so a test that put something between them would be testing the wrong
 * arrangement. The library is the same fixture the Node host's own suite
 * opens, which is what makes "the CLI answers what the app would" one claim
 * rather than two.
 */

const roots: string[] = []
const hosts: NodeHost[] = []

async function library(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paper-cli-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const full = join(root, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.close()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

/**
 * One command, in process, against a fresh host over `dataDir`.
 *
 * TWO THINGS HERE MODEL PRODUCTION AND USED NOT TO.
 *
 * The host is opened INSIDE the `open` callback, not before `runCommand` is
 * called. `paper` opens lazily on purpose — `paper --help` and `paper bok
 * list` must not scan a library to be told they are a typo — and a harness
 * that opened eagerly could not have caught that being lost.
 *
 * And `localCaller` is given a real `close`, which is what `runCommand`
 * promises to call on success AND on failure. It was given none, so every
 * host stayed open until `afterEach` swept it: a caller that stopped closing
 * would have left this suite entirely green while leaking a host per command
 * in the shipped binary.
 */
async function cli(dataDir: string, argv: readonly string[], grants?: readonly string[]): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  let opened = 0
  let closed = 0
  const code = await runCommand(
    argv,
    async () => {
      const host = await openNodeServices({ dataDir })
      opened += 1
      hosts.push(host)
      return localCaller({
        services: host.services,
        ...(grants ? { grants } : {}),
        close: async () => {
          closed += 1
          await host.close()
        },
      })
    },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  )
  /* EVERY HOST THIS COMMAND OPENED WAS CLOSED. Asserted in the harness rather
   * than in one test, so it holds for every command this file runs. */
  expect(closed, `${argv.join(' ')} opened ${opened} host(s) and closed ${closed}`).toBe(opened)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('the command list', () => {
  /* THE PLAN'S OWN CHECK: the commands are the table, filtered. Written as an
   * equality against the table rather than against a list here, so a service
   * added to the table appears as a command with no edit to the CLI — which
   * is the claim WI-11.1 makes and this is where it is spent. */
  it('equals the table filtered to read services', () => {
    expect(commandList((one) => readingGrant(one.grant))).toEqual(
      readServices().map((one) => `${one.noun} ${one.verb}`),
    )
  })

  it('equals the whole table when nothing is filtered', () => {
    expect(commandList()).toEqual([...SERVICE_NAMES].map((name) => name.replace('.', ' ')))
    expect(commandList()).toHaveLength(SERVICE_TABLE.length)
  })
})

describe('exit codes', () => {
  it('exits 0 on a command that answered', async () => {
    expect((await cli(await library(), ['book', 'list'])).code).toBe(EXIT.ok)
  })

  /* A SCRIPT HAS TO TELL THESE APART. `paper book get $id || retry` is right
   * for a refusal and wrong for a typo, and collapsing both into "non-zero"
   * is how a harness retries a misspelling two hundred times. */
  it('exits 2 on a bad verb, a bad noun and a missing argument', async () => {
    const root = await library()
    expect((await cli(root, ['book', 'lst'])).code).toBe(EXIT.usage)
    expect((await cli(root, ['bok', 'list'])).code).toBe(EXIT.usage)
    expect((await cli(root, ['book', 'get'])).code).toBe(EXIT.usage)
  })

  it('exits 1 when the service refused, naming the code', async () => {
    const run = await cli(await library(), ['book', 'get', 'nope'])
    expect(run.code).toBe(EXIT.refused)
    expect(run.err).toContain('not-found')
  })

  it('exits 0 for --help, which is an answer and not a failure', async () => {
    const run = await cli(await library(), ['--help'])
    expect(run.code).toBe(EXIT.ok)
    expect(run.out).toContain('Nouns:')
  })
})

describe('--json', () => {
  it('parses, and carries whole rows rather than the shown columns', async () => {
    const run = await cli(await library(), ['book', 'list', '--json'])
    const rows = JSON.parse(run.out) as Record<string, unknown>[]
    expect(rows).toHaveLength(FIXTURE.books)
    /* The human table shows five columns; the JSON is the whole row. */
    expect(Object.keys(rows[0] ?? {})).toContain('subjects')
    expect(Object.keys(rows[0] ?? {})).toContain('contentHash')
  })

  it('parses for every read service that can answer on this host', async () => {
    const root = await library()
    const bodies: Readonly<Record<string, readonly string[]>> = {
      'book.list': ['book', 'list'],
      'book.get': ['book', 'get', 'aaa'],
      'book.search': ['book', 'search', 'Moby'],
      'mark.list': ['mark', 'list', 'aaa'],
      'card.list': ['card', 'list'],
      'tag.list': ['tag', 'list'],
      'trash.list': ['trash', 'list'],
      'content.locate': ['content', 'locate', 'aaa'],
      'content.read': ['content', 'read', 'aaa'],
      /* The fixture book has no jacket, and that is fine: `cover.read` answers
         an EMPTY stream for a book with no artwork rather than refusing, so
         `[]` is a valid JSON document and the exit code is still 0. That is
         precisely the behaviour worth pinning — the first version of the
         service made this case an internal error. */
      'cover.read': ['cover', 'read', 'aaa'],
      'shelf.status': ['shelf', 'status'],
    }
    /* THE LIST IS CHECKED AGAINST THE TABLE, not merely iterated.
     *
     * "every read service" was a hand-written map, so a read service added to
     * the table and not here stayed untested while this test went on claiming
     * the words "every read service". `device.list` is the one deliberate
     * omission — it needs a peer transport this host does not compose — and
     * naming it here is what keeps the exemption visible. */
    const EXEMPT = new Set(['device.list'])
    const declared = readServices().map((one) => one.name)
    expect(new Set([...Object.keys(bodies), ...EXEMPT])).toEqual(new Set(declared))

    for (const [name, argv] of Object.entries(bodies)) {
      const run = await cli(root, [...argv, '--json'])
      expect({ name, code: run.code, err: run.err }).toEqual({ name, code: EXIT.ok, err: '' })
      expect(() => JSON.parse(run.out)).not.toThrow()
    }
  })

})

/* NEITHER OF THESE IS ABOUT `--json`, and both were nested under it — so a
 * failure report named the wrong feature, and a reader looking for the human
 * format's behaviour would not have found it here. */
describe('the human format', () => {
  it('prints an empty answer as `nothing`, not as an empty table', async () => {
    const run = await cli(await library(), ['trash', 'list'])
    expect(run.out).toBe('nothing')
  })
})

describe('a service this host cannot answer', () => {
  /* `device.list` needs the peer transport, which a Node process does not
   * have. It refuses BY NAME rather than answering an empty list — the
   * difference between "nothing is paired" and "this host cannot see what
   * is paired". */
  it('refuses device.list on a host with no transport, by name', async () => {
    const run = await cli(await library(), ['device', 'list'])
    expect(run.code).toBe(EXIT.refused)
    expect(run.err).toContain('unsupported')
  })

  /* AND `--json` DOES NOT CHANGE THAT. A refusal is a refusal in either
   * format; answering `[]` to the machine-readable form would be the exact
   * conflation the refusal exists to avoid. */
  it('refuses it in --json too, rather than answering an empty list', async () => {
    const run = await cli(await library(), ['device', 'list', '--json'])
    expect(run.code).toBe(EXIT.refused)
    expect(run.out).toBe('')
  })
})

describe('what the commands answer', () => {
  it('lists the fixture and filters it', async () => {
    const root = await library()
    expect(JSON.parse((await cli(root, ['book', 'list', '--json'])).out)).toHaveLength(FIXTURE.books)
    expect(JSON.parse((await cli(root, ['book', 'list', '--tag', 'Classics', '--json'])).out)).toHaveLength(
      FIXTURE.tags.Classics,
    )
    expect(JSON.parse((await cli(root, ['book', 'list', '--downloaded', '--json'])).out)).toHaveLength(
      FIXTURE.withContent.length,
    )
  })

  it('reads a book’s marks', async () => {
    const rows = JSON.parse((await cli(await library(), ['mark', 'list', 'aaa', '--json'])).out) as unknown[]
    expect(rows).toHaveLength(FIXTURE.marks.aaa)
  })

  it('counts the tags', async () => {
    const rows = JSON.parse((await cli(await library(), ['tag', 'list', '--json'])).out) as { tag: string }[]
    expect(rows.map((one) => one.tag).sort()).toEqual(Object.keys(FIXTURE.tags).sort())
  })

  it('measures the shelf, with nulls where no port can say', async () => {
    const status = JSON.parse((await cli(await library(), ['shelf', 'status', '--json'])).out) as Record<string, unknown>
    expect(status['books']).toBe(FIXTURE.books)
    expect(status['role']).toBeNull()
    /* The Node host DOES bind a size port, so this one is a number. */
    expect(typeof status['bytes']).toBe('number')
  })

  it('locates a book’s bytes, and says so honestly for one with none', async () => {
    const root = await library()
    const here = JSON.parse((await cli(root, ['content', 'locate', 'aaa', '--json'])).out) as Record<string, unknown>
    expect(here['here']).toBe(true)
    expect(here['size']).toBeGreaterThan(0)
    const absent = JSON.parse((await cli(root, ['content', 'locate', 'ccc', '--json'])).out) as Record<string, unknown>
    expect(absent['here']).toBe(false)
    expect(absent['size']).toBeNull()
  })
})

describe('the grant check on the local path', () => {
  /* The check EXISTS here, and that is the point. A local caller that skipped
   * it would make "the API surface and the permission surface are one table"
   * true only over the wire — and the first service whose grant was wrong in
   * the table would be caught by a peer rather than by this machine. */
  it('refuses a command whose grant this process does not hold', async () => {
    const run = await cli(await library(), ['book', 'list'], ['mark:read'])
    expect(run.code).toBe(EXIT.refused)
    expect(run.err).toContain('forbidden')
    expect(run.err).toContain('book:read')
  })

  it('honours the family wildcard, and only the family', async () => {
    const root = await library()
    expect((await cli(root, ['book', 'list'], ['book:*'])).code).toBe(EXIT.ok)
    /* A bare `*` covers nothing — a wildcard names a family, not a word. */
    expect((await cli(root, ['book', 'list'], ['*'])).code).toBe(EXIT.refused)
  })
})

describe('what an audit of the CLI found', () => {
  /* A script has to tell "your arguments were wrong" from "the answer is no".
   * The parser catches most malformed input where it can point at the
   * argument; the ones it cannot judge are the service's to refuse, and they
   * must come back with the same exit code the parser's would. */
  it('exits 2 for a refusal the service judged malformed, not 1', async () => {
    const root = await library()
    /* A CONDITIONAL cross-field rule — "progress needs position" — which the
     * schema still cannot express: `atLeastOne` says "one of these", not "this
     * one implies that one". So the SERVICE refuses it, and the exit code has
     * to be the parser's.
     *
     * The old example here was `--kind nonsense`, which the table declares as
     * `choices` now: the parser refuses it, with a better message and the same
     * exit code. That is the right outcome and it made this case vacuous —
     * the assertion was about a service refusal and the service was no longer
     * the one refusing. */
    const progress = await cli(root, ['book', 'set', 'aaa', '--progress', '0.5'])
    expect(progress.code).toBe(EXIT.usage)
    expect(progress.err).toContain('malformed')
    expect(progress.err).toContain('progress needs position')
  })

  /* AND WHAT THE PARSER NOW CATCHES comes back with the same code, so a script
   * branching on the exit sees no difference — only a better message. */
  it('exits 2 for a vocabulary the parser can judge, naming the whole set', async () => {
    const root = await library()
    const bad = await cli(root, ['mark', 'add', 'aaa', 'epubcfi(/6/4)', 'x', '--kind', 'nonsense'])
    expect(bad.code).toBe(EXIT.usage)
    expect(bad.err).toContain('must be one of highlight, companion, bookmark')
  })

  /* A title, an author and a note are all strings SOMEBODY ELSE WROTE. A
   * terminal reads control sequences out of ordinary output, and nothing in
   * this API needs to emit one. */
  /* A cell is ONE line. An embedded newline in a title turns a table into as
   * many extra lines as the title contains — the same "somebody else's string
   * reaches the terminal" hole as an escape sequence, wearing a character
   * that looks harmless. */
  it('keeps a cell to one line, whatever the stored string contains', async () => {
    const root = await library()
    expect((await cli(root, ['book', 'set', 'bbb', '--title', 'one\ntwo\rthree'])).code).toBe(EXIT.ok)
    const human = await cli(root, ['book', 'get', 'bbb'])
    const title = human.out.split('\n').find((line) => line.startsWith('title'))
    expect(title).toContain('one two three')
  })

  it('never writes a terminal control sequence into human output', async () => {
    const root = await library()
    const nasty = 'safe\u001b[2Khidden\u0007'
    expect((await cli(root, ['book', 'set', 'bbb', '--title', nasty])).code).toBe(EXIT.ok)
    const human = await cli(root, ['book', 'list'])
    expect(human.out).not.toContain('\u001b')
    expect(human.out).not.toContain('\u0007')
    expect(human.out).toContain('safe')
    /* `--json` is untouched: `JSON.stringify` escapes them, and a consumer
     * decoding that JSON is not a terminal. */
    const rows = JSON.parse((await cli(root, ['book', 'get', 'bbb', '--json'])).out) as { title: string }
    expect(rows.title).toBe(nasty)
  })

  /* STDERR TOO, and that is the easier half to reach: a caller gets there by
   * getting something WRONG, so the string is theirs and the path takes no
   * setup at all. `parseArgs` interpolates the offending argument into its
   * message, so an unknown flag carrying an escape sequence reached the
   * terminal unfiltered while the answer path was carefully sanitised. */
  it('never writes a terminal control sequence into a usage error', async () => {
    const root = await library()
    const nasty = '--\u001b[2Kgone\u0007'
    const bad = await cli(root, ['book', 'list', nasty])
    expect(bad.code).toBe(EXIT.usage)
    expect(bad.err).not.toContain('\u001b')
    expect(bad.err).not.toContain('\u0007')
    /* Still names what was wrong — sanitising must not cost the message. */
    expect(bad.err).toContain('paper:')
  })
})

describe('paper(), the process entry', () => {
  it('hosts the library in-process with no shelf configured', async () => {
    const out: string[] = []
    const code = await paper({
      argv: ['book', 'list', '--json'],
      dataDir: await library(),
      sinks: { out: (line) => out.push(line), err: () => {} },
    })
    expect(code).toBe(EXIT.ok)
    expect(JSON.parse(out.join('\n'))).toHaveLength(FIXTURE.books)
  })

  /* An empty `--shelf` is not "local". It is a caller who meant to name a
   * shelf and did not, and answering from the local library would be the
   * wrong library's answer wearing the right one's face.
   *
   * `paper --shelf book list` is NOT this case and must not be: the token
   * after `--shelf` is its value, so that is a shelf called `book` — the
   * ordinary reading, and the only one that lets a shelf be called anything.
   * What is empty is a `--shelf` with nothing after it, or one followed by
   * another flag. */
  it('refuses an empty --shelf rather than quietly answering from the local library', async () => {
    for (const argv of [['--shelf'], ['--shelf', '--json', 'book', 'list']]) {
      const err: string[] = []
      const code = await paper({
        argv,
        dataDir: await library(),
        sinks: { out: () => {}, err: (line) => err.push(line) },
      })
      expect(code).toBe(EXIT.usage)
      expect(err.join('\n')).toContain('needs a shelf key')
    }
  })

  it('reads the token after --shelf as its value, whatever it looks like', async () => {
    const asked: string[] = []
    await paper({
      argv: ['--shelf', 'book', 'book', 'list'],
      dataDir: await library(),
      sinks: { out: () => {}, err: () => {} },
      remote: async (shelf) => {
        asked.push(shelf)
        return { call: async () => null, stream: () => ({ async *[Symbol.asyncIterator]() {} }), close: async () => {} }
      },
    })
    expect(asked).toEqual(['book'])
  })

  /* `--shelf k --help` is a request for help and gets it; a mistyped verb is
   * a usage error and says so. Answering "cannot reach a remote shelf" to
   * either refuses a question that was never about the shelf. */
  it('answers help and usage errors for a --shelf command with no remote wired', async () => {
    const out: string[] = []
    const err: string[] = []
    const help = await paper({
      argv: ['--shelf', 'k', 'book', 'list', '--help'],
      dataDir: await library(),
      sinks: { out: (line) => out.push(line), err: (line) => err.push(line) },
    })
    expect(help).toBe(EXIT.ok)
    expect(out.join('\n')).toContain('book:read')
    expect(err.join('\n')).not.toContain('cannot reach a remote shelf')

    const typo = await paper({
      argv: ['--shelf', 'k', 'book', 'lst'],
      dataDir: await library(),
      sinks: { out: () => {}, err: (line) => err.push(line) },
    })
    expect(typo).toBe(EXIT.usage)
    expect(err.join('\n')).toContain('did you mean "list"')
  })

  it('says so by name when a build cannot reach a remote shelf', async () => {
    const err: string[] = []
    const code = await paper({
      argv: ['--shelf', 'somekey', 'book', 'list'],
      dataDir: await library(),
      sinks: { out: () => {}, err: (line) => err.push(line) },
    })
    expect(code).toBe(EXIT.usage)
    expect(err.join('\n')).toContain('cannot reach a remote shelf')
  })

  it('routes a --shelf command through the remote caller it was given', async () => {
    const asked: string[] = []
    const out: string[] = []
    const code = await paper({
      argv: ['--shelf', 'k', 'book', 'get', 'aaa', '--json'],
      dataDir: await library(),
      sinks: { out: (line) => out.push(line), err: () => {} },
      remote: async (shelf) => {
        asked.push(shelf)
        return {
          call: async (service) => ({ service }),
          stream: () => ({ async *[Symbol.asyncIterator]() {} }),
          close: async () => {},
        }
      },
    })
    expect(code).toBe(EXIT.ok)
    expect(asked).toEqual(['k'])
    expect(JSON.parse(out.join('\n'))).toEqual({ service: 'book.get' })
  })
})

/**
 * THE HUMAN TABLE HAS TO SURVIVE A REAL LIBRARY.
 *
 * Both of these were reachable on ordinary local data with no remote
 * involved, and both were found by measuring rather than by reading.
 */
describe('the table, at scale', () => {
  const descriptor = serviceDescriptor('mark.list') as ServiceDescriptor

  /**
   * `Math.max(key.length, ...body.map(…))` passes ONE ARGUMENT PER ROW, and
   * the engine's argument limit is far below the number of rows a library
   * holds — measured, it threw at about 125 000. So `paper mark list` on a
   * heavily annotated library crashed with a stack overflow instead of
   * printing.
   */
  it('renders more rows than the engine will take as arguments', () => {
    const rows = Array.from({ length: 200_000 }, (_one, index) => ({ id: `m${index}`, text: 'x' }))
    expect(() => table(descriptor, rows)).not.toThrow()
  })

  /**
   * PADDING AMPLIFIES. Every row is padded to the widest cell in its column,
   * so ONE long value in a non-final column widens every other row to match:
   * 46 KB of data became 20 MB of table, a 435× blow-up, built whole in memory
   * before a line of it was printed.
   */
  it('does not let one long cell widen every other row without bound', () => {
    const rows = [
      { id: 'm0', text: 'x'.repeat(10_000), note: 'n' },
      ...Array.from({ length: 1_999 }, (_one, index) => ({ id: `m${index + 1}`, text: 'z', note: 'n' })),
    ]
    const rendered = table(descriptor, rows)

    /* THE PROPERTY, stated directly: the rendered size no longer depends on
     * how long the longest cell is. Ten times the cell, the same table. */
    const wider = [{ ...rows[0], text: 'x'.repeat(100_000) } as Record<string, unknown>, ...rows.slice(1)]
    expect(table(descriptor, wider).length).toBe(rendered.length)

    /* And it is bounded by rows × columns, which is the only thing left that
     * can grow. Before this it was 20 006 000 characters for 46 000 of data. */
    expect(rendered.length).toBeLessThan(rows.length * 3 * 210)

    /* The long cell is marked as cut rather than silently shortened... */
    expect(rendered).toContain('…')
    /* ...and `--json` still carries the whole thing, which is the contract
     * this file's own note opens with: nothing here narrows what is
     * AVAILABLE, only what is readable. */
    expect(render(descriptor, rows, true)).toContain('x'.repeat(10_000))
  })
})

/**
 * `--limit` IS A REQUEST TO THE PRODUCER, AND A CEILING HERE.
 *
 * A stream's pages arrive from a service that may be on another machine.
 * `--limit` is sent in the body; nothing made the CLI hold the producer to it,
 * and the envelope's 4 MiB cap bounds each FRAME rather than how many arrive.
 * So a faulty or hostile shelf could send pages until this process ran out of
 * memory, and `drain` kept every row while `render` built a second complete
 * copy of them.
 */
describe('what the CLI will hold', () => {
  /** A caller whose stream ignores `limit` and yields `pages` of `per` rows. */
  function flooding(pages: number, per: number, row: () => unknown) {
    let closed = 0
    const caller = {
      call: async () => ({}),
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          try {
            for (let page = 0; page < pages; page += 1) {
              yield Array.from({ length: per }, row)
            }
          } finally {
            closed += 1
          }
        },
      }),
      close: async () => {},
    }
    return { caller, closed: () => closed }
  }

  const sinks = () => {
    const out: string[] = []
    const err: string[] = []
    return { out: (line: string) => out.push(line), err: (line: string) => err.push(line), lines: { out, err } }
  }

  it('stops at the caller’s own limit even when the producer keeps sending', async () => {
    const flood = flooding(50, 100, () => ({ bookId: 'b', title: 't' }))
    const sink = sinks()
    const code = await runCommand(['book', 'list', '--limit', '10', '--json'], async () => flood.caller, sink)
    expect(code).toBe(EXIT.ok)
    expect(JSON.parse(sink.lines.out.join('\n'))).toHaveLength(10)
    /* AND THE PRODUCER WAS TOLD TO STOP. A bare `break` inside the row loop
     * would leave the outer page iterator running; the stream's `finally` is
     * what proves it was closed. */
    expect(flood.closed()).toBe(1)
  })

  /**
   * PAST THE CEILING IT REFUSES — it does not print what it has.
   *
   * A truncated list printed as though complete is the failure this file is
   * written against: a script reading `EXIT.ok` over a partial answer has no
   * way to find out. Partial stdout with a non-zero exit is barely better —
   * `sh -c 'false | cat' ; echo $?` prints 0 without `pipefail` — so stdout
   * stays empty.
   */
  it('refuses rather than truncating when an answer will not fit', async () => {
    /* One row of about 700 KB per page, so the byte ceiling is met in a
     * hundred pages rather than a million rows. */
    const big = 'x'.repeat(700_000)
    const flood = flooding(200, 1, () => ({ bookId: 'b', title: big }))
    const sink = sinks()
    const code = await runCommand(['book', 'list', '--json'], async () => flood.caller, sink)
    expect(code).toBe(EXIT.refused)
    expect(sink.lines.out).toEqual([])
    expect(sink.lines.err.join('\n')).toMatch(/larger than this command will hold/)
    /* It names the way out. */
    expect(sink.lines.err.join('\n')).toMatch(/--limit/)
    expect(flood.closed()).toBe(1)
  })

  /**
   * THE REFUSAL SURVIVES A CLEANUP THAT FAILS.
   *
   * Breaking out and throwing afterwards runs the iterator's `return()` in
   * between — and a `return()` that rejects would replace the refusal with the
   * cleanup's own failure, so the caller learns that closing went wrong and
   * never learns why the command stopped.
   */
  it('reports the ceiling, not the failure of closing the stream', async () => {
    const big = 'x'.repeat(700_000)
    /* A HAND-ROLLED iterator, because the failure under test is in `return()`
     * — the method a `for await` calls on an abrupt exit — and a generator
     * cannot reject from there without a throw inside a `finally`. */
    const caller = {
      call: async () => ({}),
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: [{ bookId: 'b', title: big }], done: false }),
          return: async () => {
            throw new Error('closing the stream failed')
          },
        }),
      }),
      close: async () => {},
    }
    const sink = sinks()
    const code = await runCommand(['book', 'list', '--json'], async () => caller, sink)
    expect(code).toBe(EXIT.refused)
    expect(sink.lines.err.join('\n')).toMatch(/larger than this command will hold/)
  })

  /**
   * THE CEILING MUST NOT BECOME A SECOND VALIDATOR.
   *
   * `readInput` owns the bounds on `limit` — whole, non-negative. A ceiling
   * that short-circuited on the caller's number would answer a request the
   * service would have REFUSED: `--limit -1` and `--limit 1.5` would come back
   * as successful empty answers, with the service never seeing them.
   */
  it('lets the service refuse a limit it would have refused', async () => {
    const root = await library()
    for (const bad of ['-1', '1.5']) {
      /* The CLI's own coercion accepts any finite number — the `integer` and
       * `min` bounds live on the descriptor and are enforced by the service's
       * validator. So these reach the service, and the service refuses. A
       * client-side shortcut on `limit` would have answered them as
       * successful empty lists with the service never seeing the request. */
      const run = await cli(root, ['book', 'list', '--limit', bad, '--json'])
      expect(run.code, bad).toBe(EXIT.usage)
      expect(run.out, bad).toBe('')
      expect(run.err, bad).toMatch(/limit/)
    }
  })

  /* AND A LIMIT OF ZERO IS AN ANSWER, not a refusal: the caller asked for
   * nothing and gets nothing, having been through the same validation. */
  it('answers nothing for a limit of zero', async () => {
    const flood = flooding(5, 10, () => ({ bookId: 'b', title: 't' }))
    const sink = sinks()
    const code = await runCommand(['book', 'list', '--limit', '0', '--json'], async () => flood.caller, sink)
    expect(code).toBe(EXIT.ok)
    expect(JSON.parse(sink.lines.out.join('\n'))).toEqual([])
  })
})
