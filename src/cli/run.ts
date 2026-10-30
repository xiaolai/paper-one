import { SERVICE_ERRORS, SERVICE_NOUNS, servicesOn, type ServiceDescriptor } from '../kernel'
import { parseArgs } from './args'
import { callerErrorCode, callerErrorMessage, type ServiceCaller } from './caller'
import { plain, render } from './format'

/**
 * `paper`, from argv to an exit code (WI-11.4).
 *
 * Pure but for the three functions it is handed — a caller, and two sinks —
 * so the whole command surface is testable without a process, a filesystem or
 * a terminal. The entry (`paper.ts`) is what builds a caller and wires the
 * sinks to `process.stdout`; everything a command DOES is here.
 *
 * THE EXIT CODES, and why there are three rather than two:
 *
 *   0  it worked
 *   1  the service refused — `not-found`, `forbidden`, `conflict`. The
 *      command was well-formed and the answer is no.
 *   2  the command was not well-formed — an unknown noun or verb, a missing
 *      argument, a flag that takes a value and was not given one.
 *
 * A script has to tell those two apart. `paper book get $id || retry` is
 * right for a 1 and wrong for a 2, and collapsing them into "non-zero" is how
 * a harness retries a typo two hundred times.
 */

/**
 * How the caller is built, once a command is known to be worth running.
 *
 * A FUNCTION OF THE DESCRIPTOR, not a value, and that is what lets the entry
 * decide the lock from the service's own declared grant rather than by
 * re-reading argv — one derivation instead of two that must agree.
 */
export type OpenCaller = (descriptor: ServiceDescriptor, shelf: string | null) => Promise<ServiceCaller>

export interface CliSinks {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export const EXIT = { ok: 0, refused: 1, usage: 2 } as const

/**
 * The commands `paper` offers, derived from the table.
 *
 * `only` is what WI-11.4 shipped with: the read half, while the write half
 * was still in flight. It is a FILTER over the table, never a list — what it
 * cannot do is offer a command the table does not declare, or miss one it
 * does.
 */
export function commandList(only?: (descriptor: ServiceDescriptor) => boolean): readonly string[] {
  return SERVICE_NOUNS.flatMap((noun) =>
    servicesOn(noun)
      .filter((one) => only?.(one) ?? true)
      .map((one) => `${one.noun} ${one.verb}`),
  )
}

/**
 * Run one command.
 *
 * A stream is drained into ONE array before anything is printed, and that is
 * a deliberate trade rather than an oversight. Printing page by page would
 * stream a 2 000-row library through a pipe without buffering it — but
 * `--json` has to emit one well-formed document, and a run that failed
 * half-way would have already printed rows that the caller must now decide
 * whether to trust. A partial answer that looks complete is the worse
 * failure; `--limit` is how a caller bounds the memory.
 */
export async function runCommand(argv: readonly string[], open: OpenCaller, sinks: CliSinks): Promise<number> {
  const parsed = parseArgs(argv)
  /* PARSED BEFORE ANYTHING IS OPENED. `open` scans a library and, for a
   * write, takes a lock; `paper --help` and `paper bok list` need neither,
   * and a usage error that waited behind somebody's import to be told it is a
   * typo would be the CLI at its least useful. */
  if (parsed.kind === 'help') {
    sinks.out(parsed.text)
    return EXIT.ok
  }
  if (parsed.kind === 'error') {
    /* SANITISED, like every other line this writes. `parseArgs` interpolates
     * the offending ARGUMENT into its message — an unknown flag, a bad value
     * — and those come off the command line, so an escape sequence in one
     * reached the terminal unfiltered. The same hole `plain` closes on the
     * answer path, on the path a caller reaches by getting something wrong. */
    sinks.err(`paper: ${plain(parsed.message)}`)
    if (parsed.text !== undefined) sinks.err(plain(parsed.text))
    return EXIT.usage
  }

  const { descriptor, body, json } = parsed
  /* `open` may reject — no filesystem, a library that will not load, a remote
   * that will not connect, a journal another process holds. It is NOT caught
   * here: `paper.ts` owns those failures, matches its own sentinels by
   * identity, and prints the named refusal each one deserves. Catching here
   * would swallow the identity and turn every one of them into the same
   * generic line. */
  const caller = await open(descriptor, parsed.shelf ?? null)
  /**
   * CLOSING IS PART OF THE WRITE, so its failure is part of the answer.
   *
   * This used to live only in `finally`, after the success line had already
   * been printed and `EXIT.ok` returned. Two consequences, both bad: a write
   * whose queue failed to drain reported success and then threw out of the
   * `finally` as an UNCAUGHT rejection, and on the failure path a close error
   * replaced the service's own error with a less useful one.
   *
   * So it is called once, explicitly, before success is announced — and once
   * more from `finally` for the paths that did not reach it. Idempotent, so
   * the second call is free.
   */
  let closed = false
  const closeOnce = async (): Promise<unknown> => {
    if (closed) return null
    closed = true
    try {
      await caller.close()
      return null
    } catch (error) {
      return error
    }
  }
  try {
    const answer =
      descriptor.kind === 'stream'
        ? await drain(caller.stream(descriptor.name, body), readLimit(body))
        : await caller.call(descriptor.name, body)
    const text = render(descriptor, answer, json)
    const failed = await closeOnce()
    if (failed !== null) {
      /* NOT PRINTED AS SUCCESS. The command's bytes may not be on disk, and
       * a script that read `EXIT.ok` here would have believed a write that
       * did not land. */
      sinks.err(`paper: ${descriptor.name}: the library could not be closed cleanly: ${plain(callerErrorMessage(failed))}`)
      return EXIT.refused
    }
    if (text !== '') sinks.out(text)
    return EXIT.ok
  } catch (error) {
    const code = callerErrorCode(error)
    /* SANITISED, like the answer. A refusal's code and message come off the
     * wire on `--shelf`, and a hole on the failure path is the easier one to
     * trigger: a caller reaches it by doing something wrong. */
    sinks.err(`paper: ${descriptor.name}: ${plain(code)}: ${plain(callerErrorMessage(error))}`)
    /* A `malformed` refusal IS a usage error — the caller's arguments did not
     * describe a request — and a script has to tell that from "the answer is
     * no". The CLI catches most of them while parsing, where it can point at
     * the argument; the ones it cannot judge (a colour outside the registry,
     * a progress with no position) are the service's to refuse, and they must
     * come back with the same code the parser's would. */
    return code === SERVICE_ERRORS.malformed ? EXIT.usage : EXIT.refused
  } finally {
    /* Closing drains the write queue, so a command that threw still lands its
     * bytes — a CLI that exited with a write in flight is the one way this
     * can lose a reader's work.
     *
     * REPORTED, NEVER RETHROWN. A throw here would leave the `finally` as the
     * function's outcome and discard the exit code the failure path just
     * chose — the caller would lose the service's own refusal to a message
     * about cleanup. Reported on stderr instead, so it is not silent either. */
    const failed = await closeOnce()
    if (failed !== null) {
      sinks.err(`paper: ${descriptor.name}: the library could not be closed cleanly: ${plain(callerErrorMessage(failed))}`)
    }
  }
}

/**
 * The `--limit` the caller asked for, when the body carries a usable one.
 *
 * IT DOES NOT VALIDATE, and that is deliberate. `readInput` owns the bounds —
 * `integer`, `min: 0` — and enforcing them here would mean a second rule to
 * keep in step; worse, short-circuiting on a limit the SERVICE would have
 * refused (`--limit -1`, `--limit 1.5`) would turn a usage error into a
 * successful empty answer without the service ever seeing the request. So
 * anything that is not a plain non-negative whole number is simply not a
 * ceiling this function applies, and the service refuses it as it always did.
 */
function readLimit(body: Record<string, unknown>): number | undefined {
  const value = body['limit']
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * How much of a stream this process will hold before refusing.
 *
 * `--limit` is a REQUEST, not a guarantee: it is sent to the producer, and a
 * producer that ignores it — a faulty shelf, or a hostile one — could send
 * pages until this process ran out of memory. The envelope caps each FRAME at
 * 4 MiB; nothing capped how many frames arrive.
 *
 * Two ceilings, because rows differ enormously in size: a `book.list` row is a
 * few hundred bytes and a `mark.list` row carries the passage a reader
 * highlighted. Either alone leaves the other unbounded.
 *
 * They are far above any real library — two thousand books is about half a
 * megabyte — so a reader meets them only when something is wrong.
 */
const MAX_DRAIN_ROWS = 1_000_000
const MAX_DRAIN_BYTES = 64 * 1024 * 1024

/**
 * Every page's rows, flattened — a stream answers pages, a caller wants rows.
 *
 * BOUNDED, AND IT REFUSES RATHER THAN TRUNCATING. A truncated list printed as
 * though complete is the failure this whole file is written against; a script
 * reading `EXIT.ok` over a partial answer has no way to find out. So the
 * ceiling throws, `runCommand`'s catch prints the code, and stdout stays
 * empty.
 *
 * The throw happens INSIDE the loop, not after it. Breaking first and
 * throwing afterwards runs the iterator's `return()` in between — and if
 * THAT rejects, execution never reaches the throw and the caller receives the
 * cleanup's failure instead of the refusal that explains it. Throwing here
 * still closes the iterator (a `for await` does that on any abrupt exit) and
 * the refusal is what propagates.
 */
async function drain(stream: AsyncIterable<unknown>, limit: number | undefined): Promise<unknown[]> {
  const rows: unknown[] = []
  /* MEASURED AS COMPACT-JSON CODE UNITS, which is a PROXY and is named as one.
   * It is not UTF-8 bytes — a thousand Han characters are 1 008 units and
   * 3 008 bytes — and not heap either. It is the same measure `paging.ts` uses
   * to decide a page, so the two ends agree about what "big" means, and it is
   * conservative in the direction that matters: it never over-estimates the
   * ceiling's headroom by more than the encoding's ratio. */
  let units = 0
  for await (const page of stream) {
    /* Appended one at a time rather than `push(...page)`. A spread becomes
     * that many ARGUMENTS, and the engine's argument limit is far below the
     * number of rows a 4 MiB frame can carry — so a page from a shelf this
     * process does not control could take the CLI down with a stack overflow
     * rather than an answer. */
    for (const row of Array.isArray(page) ? (page as unknown[]) : [page]) {
      /* THE CALLER'S OWN LIMIT, ENFORCED HERE TOO. It was only ever asked for.
       * Stopping at exactly N is not a refusal — the caller asked for N and
       * got N — so this returns rather than throwing. */
      if (limit !== undefined && rows.length >= limit) return rows
      rows.push(row)
      units += JSON.stringify(row)?.length ?? 0
      if (rows.length > MAX_DRAIN_ROWS || units > MAX_DRAIN_BYTES) {
        /* A REFUSAL, with a code — not a bare `Error`. `isRefusal` reads
         * `{code, message, retryable}`; anything else is classified `internal`,
         * which is the one code a caller cannot act on. */
        throw {
          code: SERVICE_ERRORS.unsupported,
          message: `the answer is larger than this command will hold (${rows.length} rows); ask for less with --limit`,
          retryable: false,
        }
      }
    }
  }
  return rows
}
