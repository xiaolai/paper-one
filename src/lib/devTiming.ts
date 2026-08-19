/**
 * Where the launch spends its time — in the terminal, not only in devtools.
 *
 * The shelf is awaited before React mounts, so everything below runs while the
 * window is blank. When a library is large enough for that to be felt, the
 * question is never "is it slow" but WHICH of four things is slow: reading the
 * store, carrying a legacy library across, loading the shelf, or drawing it.
 * Guessing between them costs a rebuild each time; measuring them costs one
 * launch.
 *
 * FILESYSTEM CALLS ARE COUNTED, not just timed. Every one is an IPC round-trip
 * into the Tauri process, so on this path the call COUNT is the wall clock —
 * `scanShelf` already says so in its own comment, which is why it walks folders
 * a few at a time. A phase that takes two seconds and made four thousand calls
 * is a different bug from one that takes two seconds and made two, and only the
 * count tells them apart.
 *
 * DEV ONLY, and gone from a production bundle rather than merely quiet in one:
 * `import.meta.env.DEV` is replaced with `false` at build time, so every guard
 * below folds flat and the module's body is dropped. Nothing here is on a
 * shipped path, which is also why it is allowed to be chatty.
 *
 * The sink is `import.meta.hot.send`, which puts the line in the terminal
 * running the dev server — see `paper:timing` in `vite.config.ts`. It also goes
 * to the webview console, because that is where a reader of devtools looks and
 * because the automation bridge reads console rather than stdout.
 */

/** Off in a production build, and off under vitest so suites stay quiet. */
const ON = import.meta.env.DEV && import.meta.env.MODE !== 'test'

export type Detail = Record<string, string | number | boolean>

/**
 * A DURATION AND A TIMESTAMP ARE NOT THE SAME NUMBER, and printing them in the
 * same slot is how a reading misleads. `took` is how long something ran; `at`
 * is when it happened, counted from the page's start. The first line this
 * instrument produced said `the shelf rendered 104639ms`, which reads as a
 * hundred-second render and meant a hundred-second WAIT before one.
 */
function say(name: string, took: number | null, at: number | null, detail?: Detail): void {
  if (!ON) return
  const when = [
    took === null ? '' : ` took=${took.toFixed(0)}ms`,
    at === null ? '' : ` at=${at.toFixed(0)}ms`,
  ].join('')
  const rest = detail
    ? ' ' +
      Object.entries(detail)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
    : ''
  /* WHETHER ANYONE COULD SEE THE WINDOW, on every line.
   *
   * WebKit suspends `requestAnimationFrame` and throttles timers for an
   * occluded webview, so a measurement taken while the window is behind
   * something is not a measurement of the app — it is a measurement of the
   * window server. This project has already sent one investigation the wrong
   * way that way, and `document.visibilityState` is the tell, so it rides
   * along rather than being remembered. */
  const seen = typeof document === 'undefined' || document.visibilityState === 'visible'
  console.info(`Paper timing: ${name}${when}${rest}${seen ? '' : ' HIDDEN'}`)
  /* Optional-chained because this module is also loaded by the production
   * bundle's type graph and by vitest, where `import.meta.hot` does not exist.
   * In dev it is the whole point. */
  import.meta.hot?.send('paper:timing', {
    name,
    took,
    at,
    hidden: !seen,
    detail: detail ?? {},
  })
}

/**
 * Time one phase of the launch and report it.
 *
 * The result passes through untouched, so a call site reads the same with the
 * wrapper as without it. A phase that THROWS is still reported — the failing
 * path is usually the slow one, and a measurement that only survives success
 * is missing the case worth seeing.
 */
export async function timed<T>(
  name: string,
  run: () => Promise<T>,
  detail?: (value: T) => Detail,
): Promise<T> {
  if (!ON) return run()
  const from = performance.now()
  try {
    const value = await run()
    say(name, performance.now() - from, performance.now(), detail?.(value))
    return value
  } catch (cause) {
    say(name, performance.now() - from, performance.now(), { failed: true })
    throw cause
  }
}

/** A moment worth naming, with no duration of its own — only a WHEN. */
export function moment(name: string, detail?: Detail): void {
  say(name, null, ON ? performance.now() : null, detail)
}

/* ── the filesystem tally ──────────────────────────────────────────────────
 *
 * One entry per method actually called, so a method nobody calls does not
 * appear and pretend to be a zero.
 */

interface Tally {
  calls: number
  /** Cumulative time awaited. Overlapping calls double-count on purpose: the
   *  pooled scan runs several at once, and the sum against the wall clock is
   *  what shows whether the pool is actually being used. */
  ms: number
  failed: number
}

const tally = new Map<string, Tally>()

function record(method: string, ms: number, ok: boolean): void {
  const row = tally.get(method) ?? { calls: 0, ms: 0, failed: 0 }
  row.calls += 1
  row.ms += ms
  if (!ok) row.failed += 1
  tally.set(method, row)
}

/**
 * The same filesystem, counting itself.
 *
 * A wrapper rather than instrumentation inside `bookFiles.ts`, so the measured
 * object and the shipped one are the same object with nothing added to it — the
 * counting exists only where `main.tsx` chooses to put it, and only in dev.
 *
 * Every function-valued property is wrapped and everything else is passed
 * through, so this keeps working when the filesystem seam grows a method.
 */
export function countingFs<T extends object>(fs: T): T {
  if (!ON) return fs
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fs)) {
    if (typeof value !== 'function') {
      out[key] = value
      continue
    }
    const call = value as (...args: unknown[]) => unknown
    out[key] = (...args: unknown[]) => {
      const from = performance.now()
      let result: unknown
      try {
        result = call.apply(fs, args)
      } catch (cause) {
        record(key, performance.now() - from, false)
        throw cause
      }
      /* SYNCHRONOUS METHODS ARE MEASURED TOO, and measured correctly: only a
       * thenable gets the settle hook, or a plain return would be recorded
       * twice — once here and once never. */
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            record(key, performance.now() - from, true)
            return value
          },
          (cause: unknown) => {
            record(key, performance.now() - from, false)
            throw cause
          },
        )
      }
      record(key, performance.now() - from, true)
      return result
    }
  }
  return out as T
}

/** Everything counted so far, flattened for one line of output. */
function snapshot(): { detail: Detail; calls: number } {
  const detail: Detail = {}
  let calls = 0
  for (const [method, row] of tally) {
    detail[method] = `${row.calls}×${row.ms.toFixed(0)}ms${row.failed ? `!${row.failed}` : ''}`
    calls += row.calls
  }
  return { detail, calls }
}

/** Report the tally under a name, and say how much of it is new. */
export function reportFs(name: string): void {
  if (!ON) return
  const { detail, calls } = snapshot()
  say(name, null, performance.now(), { total: calls, ...detail })
}

/**
 * Keep reporting what the filesystem does AFTER the window is up.
 *
 * The launch is only half the question — a shelf that paints quickly and then
 * reads a thousand covers is slow in a way no boot measurement can see. This
 * prints a line whenever the count moved since the last one, so scrolling the
 * shelf shows its own cost as it happens, and a quiet app prints nothing.
 */
export function watchFs(everyMs = 2_000): void {
  if (!ON) return
  let before = snapshot().calls
  setInterval(() => {
    const { detail, calls } = snapshot()
    if (calls === before) return
    say('since the last line', null, performance.now(), {
      added: calls - before,
      total: calls,
      ...detail,
    })
    before = calls
  }, everyMs)
}

/**
 * EVERYTHING BEFORE `boot()` EVER RUNS, which is most of the wait.
 *
 * The instrument started at the first line of `boot`, so every phase it
 * measured was fast and the launch still felt slow — the shelf finishing at
 * `at=756ms` after `took=29ms` of work says the other 727ms happened before
 * anything here was watching. That time is the window opening, the document
 * parsing, and the module graph evaluating, and none of it is the app's own
 * code.
 *
 * IN DEV THIS IS MOSTLY VITE. An unbundled module graph is served a file at a
 * time and transformed on first request, so a cold dev server pays hundreds of
 * round-trips a production bundle does not. Read a dev number as an upper
 * bound, and compare a built app before optimising anything here.
 */
export function reportStartup(): void {
  if (!ON) return
  const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
  if (nav) {
    say('the document', null, performance.now(), {
      /* When the HTML had arrived — the window's own cost, up to that point. */
      arrived: `${Math.round(nav.responseEnd)}ms`,
      /* Everything since: parsing, and the module graph evaluating. In dev
       * that is Vite serving it one file at a time and transforming each on
       * first request, which a production bundle does not do. */
      modules: `${Math.round(performance.now() - nav.responseEnd)}ms`,
    })
  }
  /* WHEN THE READER SAW ANYTHING AT ALL. Every other number here is the app
   * talking about itself; this is the one that answers "how long was the window
   * white", which is the question actually being asked. */
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        moment(`the window painted: ${entry.name}`, { at: Math.round(entry.startTime) })
      }
    }).observe({ type: 'paint', buffered: true })
  } catch {
    // No paint timing in this webview: one fewer line, not a failure.
  }
}

/**
 * When the window actually showed something.
 *
 * TWO FRAMES, not one. A single `requestAnimationFrame` fires BEFORE the frame
 * it schedules work for is painted, so it reports the moment the browser agreed
 * to draw rather than the moment it drew. The second one runs after that paint
 * has happened, which is the number a reader would recognise as "the window
 * came up".
 */
export function onFirstPaint(name: string, detail?: Detail): void {
  if (!ON) return
  /* AN OCCLUDED WINDOW NEVER PAINTS, so this never fires — which looks exactly
   * like a paint that is taking for ever. Said once, so the silence that
   * follows is explained rather than measured. */
  if (document.visibilityState !== 'visible') {
    moment(`${name} — waiting, the window is not visible`, detail)
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => moment(name, detail))
  })
}
