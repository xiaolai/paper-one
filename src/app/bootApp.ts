/* THE NATIVE LAUNCH SEQUENCE, in one place, for both native shells.
 *
 * This was the body of `src/main.tsx` until the mobile shell arrived. Nothing
 * in it is desktop-specific and nothing in it renders: it opens the store,
 * carries a legacy library across, finishes the removals a crash left half
 * done, reads the shelf, builds the kernel's services, composes this build's
 * capabilities and arms the shutdown handshake. The only part that differed
 * between the two shells was the component at the end — so the shells stayed
 * in the entries and the sequence moved here.
 *
 * ⚠️ **THE ORDER IS THE POINT, AND A SECOND COPY WOULD NOT KEEP IT.** Every
 * step below sits where it does for a reason written beside it, and several of
 * those reasons are incidents: the handshake is armed BEFORE composition
 * because a quit during composition left the journal dirty; `pagehide` is
 * registered before the composition is awaited because a reload landing
 * mid-composition overlapped two capability sets and ran the journal's
 * sequence backwards. A mobile entry with its own copy of this would have
 * started out correct and drifted, one incident at a time, out of sight of the
 * tests that hold the order — which live in `app/boot.ts` and
 * `app/shutdown.ts` precisely because they cannot run against a file like
 * this one.
 *
 * IMPORTS THE KERNEL THROUGH `ui/boot.ts`, NOT `ui/index.ts`: that barrel
 * names `App`, and a barrel retains everything it names, so taking the wide
 * door here would put the entire desktop pane tree into the mobile bundle.
 * `.dependency-cruiser.cjs` refuses the shortcut (`mobile-root-not-desktop-ui-entry`).
 */
import {
  buildServices,
  composeCapabilities,
  createDiagnosticLog,
  createDiagnosticSpool,
  createDiagnostics,
  createKernelServices,
  DIAGNOSTICS_FILE,
  DIAGNOSTICS_SWITCH,
  finishPendingRemovals,
  flushBeforeClose,
  kernelApi,
  serviceClients,
} from '../kernel'
import type { Composition, DiagnosticLog, IndexFs, KernelServices } from '../kernel'
import {
  CLOSE_DRAIN_MS,
  OPEN_FILES_EVENT,
  OPEN_FILES_READY_EVENT,
  countingFs,
  inTauri,
  libraryFs,
  loadShelf,
  migrateToFolders,
  moment,
  onFirstPaint,
  openAppStorage,
  reportFs,
  reportStartup,
  summariseMigration,
  timed,
  watchFs,
  tauriSizePort,
} from '../kernel/ui/boot'
import type { OpenRequests } from '../kernel/ui/boot'
import { armShutdownInBackground } from './shutdown'
import { bootShelf } from './boot'
import { capabilities } from 'virtual:paper-composition'

/**
 * The shell's event channel, loaded once and lazily.
 *
 * `@tauri-apps/api/event` was imported inline at three separate call sites —
 * the shutdown listener, the shutdown emitter, and the opened-files bridge.
 * Three copies of one decision about WHEN the module is pulled in, and the
 * import is deliberately lazy (it is what keeps `@tauri-apps` off the critical
 * path of a launch that may not need it), so the laziness is the thing that
 * had to stay identical in all three and had nothing holding it there.
 *
 * The module cache makes the second and third calls free, so this is one
 * import in practice as well as in the source.
 */
async function shellEvents(): Promise<typeof import('@tauri-apps/api/event')> {
  return import('@tauri-apps/api/event')
}

/**
 * Everything a native shell needs to render its first frame, and nothing about
 * how it renders it.
 *
 * The two optional-in-`AppProps` fields are `null` here rather than absent,
 * because a shell has to be able to tell "this build records nothing" from
 * "nothing has been recorded yet" — the Developer panel draws a different
 * surface for each. Each entry spreads them back to `undefined` at the prop.
 */
export interface BootedApp {
  readonly services: KernelServices
  readonly fs: IndexFs | null
  readonly shelfUnread: boolean
  readonly bootNotice: string | null
  readonly composition: Composition
  readonly beforeWindowClose: () => Promise<unknown>
  readonly openRequests: OpenRequests
  /** The window of diagnostics this run is recording, or null if it records none. */
  readonly diagnosticLog: DiagnosticLog | null
  /** Told after the panel clears the window, so the file can catch up, or null with no file. */
  readonly onDiagnosticsCleared: (() => void) | null
  /** What the shelf came up holding, for the after-paint measurement. */
  readonly bookCount: number
  /** `performance.now()` at the first line of the sequence, for the same. */
  readonly startedAt: number
}

/**
 * Run the native launch sequence.
 *
 * ASYNCHRONOUS FOR ONE REASON, and it is the store: the card and settings
 * stores read their storage once, when the services are built, so a store that
 * arrived after the first render would be a store the app never saw. Every
 * reader would get one frame of an empty shelf and an unannotated book.
 *
 * A failure opening the store cannot stop the app — `openAppStorage` falls
 * back rather than throwing — so there is no error branch for a shell to
 * render. What it could not do is reported through `bootNotice`.
 */
export async function bootApp(): Promise<BootedApp> {
  /* EVERY PHASE BELOW RUNS WHILE THE WINDOW IS BLANK, which is why they are
   * measured rather than reasoned about. Dev only, and gone from a build —
   * see `devTiming`. */
  const bootFrom = performance.now()
  /* FIRST, so the window's own cost is on the record before the app adds any of
   * its own. Everything above this line ran before `boot` was called at all. */
  reportStartup()
  /* AND WHAT OPENING IT HAD TO SAY — a damaged file moved aside, a disk it
   * could not open — carried to the shelf's foot rather than to the console,
   * which is not where a reader looks for their cards and settings. */
  const { storage, notice: storeNotice } = await timed('open the store', () => openAppStorage())
  /* THE SHELF IS AWAITED TOO, for the same reason the store is: rendering first
   * and filling in afterwards gives every reader one frame of an empty library,
   * and this one would be a frame of "Your library is empty" over a full one.
   *
   * `loadShelf` reads the index — one file — or rescans when it is missing or
   * disagrees with the folders. Outside Tauri there is no filesystem and the
   * shelf starts empty, which is the honest answer in a browser. */
  /* COUNTED, in dev. The scan's own comment says the call count is the time the
   * window stays blank, so the count is the measurement that matters most here;
   * `countingFs` is the identity function in a build. */
  const fs = inTauri() ? countingFs(libraryFs) : null

  /* WHAT THE APP CAN STILL BE ASKED ABOUT AFTERWARDS — see
     `core/diagnosticsLog.ts` for why this is worth a module.
   *
   * The console was the only sink, so Paper's own account of a failure was
   * reachable by a person with devtools open and by nobody else. That is what
   * cost `scripts/sync-scenario.sh` three runs: the satchel wrote
   * `sync.session-failed` with the refusal kind and the message, over an ssh
   * connection, into a console nobody could read from the other end.
   *
   * ON IN DEV, AND IN A RELEASE ONLY IF ASKED. A file of a reader's own
   * diagnostics is a thing to opt into, not a thing to find. The switch is
   * the PRESENCE OF A FILE rather than a setting, for one reason that
   * matters: settings arrive with the services, and this has to be decided
   * before them — and a harness driving a release build over ssh can `touch`
   * a path, where it cannot open a settings pane. */
  /* A FAILURE TO LOOK IS NOT A DECISION NOT TO. Swallowing this made a
     permission error, an unreadable directory and a deliberate opt-out the
     same observation — so a reader who created the switch and got no file had
     nothing at all to explain it, which is the very complaint this whole
     feature exists to answer. Still defaults to off; it just says why. */
  const switchAsked =
    fs === null
      ? false
      : await fs.exists(DIAGNOSTICS_SWITCH).catch((cause: unknown) => {
          console.error(`Paper: could not read ${DIAGNOSTICS_SWITCH}; diagnostics stay off`, cause)
          return false
        })
  const diagnosticsOn = import.meta.env.DEV || switchAsked
  /* BUILT ONLY IF SOMETHING WILL WRITE TO IT. With diagnostics off, nothing
     records and this was returned as `null` anyway — so the ring it allocates
     was unreachable state from the moment it existed. */
  const diagnosticLog = diagnosticsOn ? createDiagnosticLog() : null
  const diagnosticSpool =
    fs === null || diagnosticLog === null
      ? null
      : createDiagnosticSpool({
          log: diagnosticLog,
          write: async (jsonl) => {
            await fs.writeFile(DIAGNOSTICS_FILE, new TextEncoder().encode(jsonl))
          },
        })

  /* THE SHELF'S BOOT ORDER — carry a phase-3 library across, finish the
   * removals a crash left half done, then read the shelf — lives in
   * `app/boot.ts`, where its order is tested. Timing wraps each step here,
   * because the timing is this file's concern and the order is not.
   *
   * THE ANSWER TO "why is launch slow" IS USUALLY `rescanned`. A trusted
   * cache is one file read and one listing; a rescan is two round-trips per
   * book, and a library of a few thousand feels every one of them. If this
   * says `rescanned=true` on every launch, the cache is being distrusted
   * rather than the scan being slow, and that is a different bug. */
  const { initialBooks, shelfUnread } = await bootShelf({
    fs,
    legacy:
      storage === null
        ? null
        : () => {
            /* CHECKED, not asserted. `as []` told the compiler this was a list and
             * told the runtime nothing — so a store holding a valid JSON OBJECT
             * threw inside the migration and skipped every legacy book. Parsed
             * separately, so a malformed marks value does not stop the rows.
             *
             * AND A VALUE THAT WOULD NOT PARSE IS SAID, not silently emptied:
             * a corrupt legacy blob used to make the library simply appear
             * empty, with nothing anywhere explaining where the books went. */
            const rawRows = storage.getItem('paper.library.v1')
            const parsedRows = readJson(rawRows, null)
            if (rawRows !== null && parsedRows === null) {
              console.error('paper: the legacy library value exists but would not parse; migration sees no rows')
            }
            /* THE SAME SENTENCE FOR THE MARKS, which had none. The paragraph
               above says a value that would not parse is SAID rather than
               silently emptied, and then the very next line emptied one
               silently: a corrupt marks blob migrated the books and dropped
               every highlight and note on them, and the migration STAMPS, so
               the next launch treated those books as already carried across.
               Nothing anywhere said where the annotations went. */
            const rawMarks = storage.getItem('paper.marks.v1')
            const parsedMarks = readJson(rawMarks, null)
            if (rawMarks !== null && parsedMarks === null) {
              console.error('paper: the legacy marks value exists but would not parse; migration carries no marks')
            }
            return {
              rows: asRows(parsedRows ?? []),
              marks: parsedMarks ?? [],
            }
          },
    migrate: (target, legacy) => timed('carry a legacy library across', () => migrateToFolders(target, legacy)),
    summarise: summariseMigration,
    finishPendingRemovals: (target) => timed('finish pending removals', () => finishPendingRemovals(target), (ids) => ({ finished: ids.length })),
    loadShelf: (target) =>
      timed('load the shelf', () => loadShelf(target), (one) => ({
        books: one.books.length,
        rescanned: one.rescanned,
        why: one.why,
      })),
    report: {
      info: (message) => console.info(message),
      error: (message, cause) => console.error(message, cause),
    },
  })

  /* NAMED FOR WHAT IT ACTUALLY COVERS. This said "everything before the first
     render" and was taken here — before the services are built, before the
     capabilities compose, and before the shutdown handshake is armed, all of
     which also precede the render and all of which do I/O. The number was
     right and the label was not, which is worse than no label: it made the
     phases below it invisible to the one measurement anyone reads. */
  moment('the store and the shelf', { ms: Math.round(performance.now() - bootFrom) })
  reportFs('filesystem, up to the shelf')

  /* THE KERNEL'S SERVICES, built once, here — the composition root — over the
   * store and the shelf resolved above, and handed to the UI. The hooks are
   * adapters over these instances; a capability's service handler will hold
   * the same ones. The ports keep their defaults until a capability supplies
   * an implementation: no recorder journals, and diagnostics go to the console
   * in a dev build and nowhere in a release. */
  const services = createKernelServices({
    fs,
    storage,
    initialBooks,
    /* SO THE KERNEL KNOWS WHICH EMPTY THIS IS. The catch above opens the
     * window on `[]` rather than not opening — the right trade — but every
     * consumer downstream then counted zero books and could not tell that
     * from a library with none. `shelf.status` reported `books: 0` to a peer
     * asking whether this device was healthy. */
    shelfRead: !shelfUnread,
    /* `record` TEES THE SAME REDACTED FIELDS the console line gets — redaction
       happens once, above both, so the file cannot come to carry something the
       console would not. `enabled` still decides everything: turned off, this
       is `NOOP_DIAGNOSTICS` and nothing is recorded either. */
    diagnostics: createDiagnostics({
      enabled: diagnosticsOn,
      /* ⚠️ **THE RECORDER FOLLOWS THE WINDOW, NOT THE SPOOL — AND IT USED TO
         FOLLOW THE SPOOL.** `diagnosticSpool` is null wherever there is no
         filesystem, so a dev build outside Tauri had `diagnosticsOn` true, no
         recorder installed, and a Developer panel reporting that diagnostics
         were being recorded over a window that could never fill. The two are
         different questions: whether anything is WRITTEN DOWN in memory, and
         whether it is also projected to a FILE. Only the second needs a disk.
         Found by audit.
         Keyed on `diagnosticLog` rather than on `diagnosticsOn`: the log is
         now built only when diagnostics are on, so the two say the same thing
         — and this way the compiler is the one enforcing it. */
      ...(diagnosticLog
        ? {
            record: (entry) => {
              diagnosticLog.record(entry)
              diagnosticSpool?.touch()
            },
          }
        : {}),
    }),
  })

  /* THE TRASH IS EMPTIED AT BOOT, ON EACH BOOK'S LANE. Not on a timer and
   * not when the reader removes something: a timer deletes a reader's work
   * while they are looking at the shelf, and doing it during a removal makes
   * an undoable action wait on unrelated disk work. At launch nothing is
   * waiting, and being a fortnight late is not a failure.
   *
   * THROUGH THE LIBRARY, NOT `emptyExpired` DIRECT. The direct sweep read a
   * stamp and deleted off every queue, so a restore that landed between the
   * two — one that had kept files back and given them a fresh fortnight —
   * lost exactly those files. The purge now runs on the book's lane with the
   * stamp re-read there, so it is ordered against every restore and remove
   * of that book. Deliberately not awaited: a slow sweep must not delay the
   * window, and the library errs towards keeping anything it cannot age. */
  void services.library.emptyExpiredTrash().catch((error: unknown) => {
    services.diagnostics.warn('trash.sweep-failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  })

  /* WHAT THIS HOST CAN MEASURE, bound here rather than by a capability.
   *
   * The other two outward ports belong to capabilities — `peer` binds the
   * devices, `sync` binds the shelf — because both describe something composed
   * onto the kernel. A book's size describes the app's OWN data directory, so
   * it belongs to whoever owns that, which is this file.
   *
   * Never bound at all until now, which is why `content.locate` answered
   * `size: null` in the shipping app for every book while its own
   * documentation described the field as a measurement. The browser client is
   * what made it matter: pdf.js's range transport must be told a file's length
   * before it asks for a byte of it, and a stream cannot supply that.
   *
   * Not disposed. It lives exactly as long as the services do, and the app's
   * data directory does not go away while the app is running. */
  services.bindSizePort(tauriSizePort)

  /* THE CAPABILITIES, composed onto those services — validated, ordered and
   * started before the first render, so the pane and the palette are complete
   * on the first frame rather than filling in. A capability whose START fails
   * is left out and the app runs without it (ADR 0001 Decision 9); a
   * composition that will not VALIDATE is a build defect and still reaches the
   * fatal handlers. `composition.failures` is what did not compose, and the
   * settings pane says so. */
  const lifetime = new AbortController()
  /* THE SERVICE TABLE, served alongside the capabilities' own services
   * (phase 11). One map, one router registration, one grant check — a caller
   * must not be able to tell which side of the kernel/capability line a
   * service came from. The handlers read their three outward ports
   * (`device`, `shelf`, sizes) at CALL time, so building them here, before
   * any capability has started, is not too early: `peer.start` and
   * `sync.start` bind theirs on the way past. */
  /* ARMED BEFORE COMPOSITION, which is the window that matters — and said
   * precisely, because the first spelling of this note overclaimed.
   *
   * This used to sit below `composeCapabilities`, so a quit arriving during
   * composition reached no handler: the shell deferred the exit, waited out
   * its whole grace period, and quit anyway with the journal left dirty —
   * composition is where sync OPENS the journal, so that was the exact
   * window the handshake exists for. Storage loading, migration and the
   * shelf scan still run above this line unarmed, deliberately: the journal
   * does not exist yet there, so a quit in that window costs the shell's
   * grace period and nothing else — a slow quit, never a dirty flag — and
   * arming earlier would mean late-binding `services` through a mutable
   * reference in the one file no test can mount.
   *
   * Everything it needs already exists here: `lifetime` and `services` are
   * built above, and `quiesce()` resolves at once when no capability has
   * opened anything yet, which is precisely the startup case.
   *
   * THE HANDSHAKE ITSELF LIVES IN `app/shutdown.ts`, where it can be tested:
   * its ordering, its bounding and its failure paths are the parts that go
   * wrong, and inline in this function nothing could reach them. What is left
   * here is the one thing that genuinely belongs to a composition root —
   * naming the real Tauri event module.
   *
   * THE REAL MODULE, not `window.__TAURI__`. The first version read the
   * global, which a RELEASE build does not expose — `tauri.conf.json` sets
   * `withGlobalTauri: false`, and `tauri.dev.conf.json` sets it TRUE, so the
   * global is there under `pnpm app` and gone in the shipped app. (This said
   * "FALSE in this app", which is the half that is wrong in development and so
   * the half that hides the bug from anyone reproducing it.) So it found
   * nothing,
   * returned, and the quit handshake timed out for five seconds every time
   * while looking like it had been wired. A silent capability check written
   * into the fix for a silent failure. */
  /* THE TEARDOWN IS HANDED TO THE WINDOW AS WELL. Arming answers the shell's
     ask; the same function goes to `App` as `beforeWindowClose`, so the red
     button — the only quit on Windows and Linux — closes the journal too. */
  const teardown = armShutdownInBackground({
    listen: async (event, handler) => {
      const { listen } = await shellEvents()
      return listen(event, () => handler())
    },
    emit: async (event) => {
      const { emit } = await shellEvents()
      await emit(event)
    },
    /* THE SPOOL'S TAIL GOES WITH THE FLUSH, because the diagnostics worth
       having are the ones written just before the app stopped — and the spool
       is debounced, so without this the last two seconds are exactly what a
       crash-adjacent shutdown would drop. */
    flush: async () => {
      await flushBeforeClose()
      await diagnosticSpool?.flush()
    },
    drain: () => services.drain(),
    abort: () => lifetime.abort(),
    /* EVERY CAPABILITY'S ASYNC TAIL, read from the STATIC composition list
       rather than from the composed object.

       The note this replaces said that the day a second capability owed a
       tail, it should become a property of `Composition` — and it cannot be.
       This handshake is armed BEFORE `composeCapabilities` is awaited, on
       purpose, because a quit during startup is the window most likely to be
       slow. A tail read off the composition would therefore be a no-op for
       exactly as long as composition takes, which is the same window in which
       sync's `start` opens the journal: quit there and the flag stays up,
       which is the failure the handshake exists to prevent.

       `capabilities` is imported at module load, so this thunk sees every
       capability's `quiesce` from the first tick, and each one answers about
       live module state at the moment it is called. `Promise.all` rather than
       `allSettled`: one tail rejecting must reach `shutdown.ts`'s failure
       path exactly as a single rejecting tail used to. */
    quiesce: async () => {
      await Promise.all(capabilities.map((cap) => cap.quiesce?.()))
    },
    signal: lifetime.signal,
    /* THE SAME BOUND THE WINDOW CLOSE USES, imported rather than restated:
       both drain the same queue under the same rule, and two spellings of one
       policy is how they come to disagree. */
    graceMs: CLOSE_DRAIN_MS,
    diagnostics: services.diagnostics,
  })

  /* THE LIFETIME ENDS WITH THE PAGE, which nothing used to do.
   *
   * A reload builds a SECOND set of capabilities while the first is still
   * live, and the two overlap for as long as the old context takes to go
   * away. The sync journal is append-only with an in-memory sequence counter,
   * so two of them on one file is exactly how its sequence came to run
   * backwards — 203 violations, and a journal the next launch refused. Aborting
   * here runs each capability's teardown: sync unbinds the recorder at once, so
   * no further bracket reaches the old journal, and closes it behind the queue.
   *
   * REGISTERED BEFORE COMPOSITION IS AWAITED, not after. Below the await, a
   * reload landing MID-composition — the very window in which sync opens the
   * journal — found no listener, so the half-started first set was never
   * aborted and overlapped the reload's second set: the incident above,
   * reachable through the one gap in its fix. Only `lifetime` is needed here,
   * and it exists.
   *
   * `pagehide`, not `beforeunload`: it fires on a reload and on a navigation,
   * it does not ask to block the unload, and it is the event the platform
   * actually guarantees here. Idempotent — `dispose()` and the abort listener
   * both no-op after the first. */
  window.addEventListener('pagehide', () => lifetime.abort(), { once: true })

  const composition = await composeCapabilities(capabilities, kernelApi(services), lifetime.signal, {
    services: buildServices({ services }),
    /* The satchel side of the same table, declared: what this composition may
     * CALL on a shelf, as opposed to what it answers. Derived, so it cannot
     * name a service that does not exist. */
    clients: serviceClients(),
  })

  /* AND THE SAME TEARDOWN ON QUIT, which `pagehide` does not cover.
   *
   * Quitting destroys the webview; the platform does not guarantee `pagehide`
   * first, and even when it fires, nothing holds the process open for the
   * async tail — so `journal.close()` never finished and `journal.dirty` was
   * never cleared. Measured on a real library: it survived every ordinary
   * quit, which made every launch treat the last one as a crash and re-verify
   * the whole shelf.
   *
   * `lib.rs` defers the first exit request and waits for the answer below,
   * bounded, so a teardown that hangs delays the quit rather than preventing
   * it. Failing to reach the shell is not fatal here: this is a best-effort
   * flush, and the unclean path still works exactly as it does today. */
  /* BOOKS THE LAUNCH CARRIED. The shell holds what the Finder, the command
   * line or a second launch handed it until the webview says it is listening
   * — a file opened at launch is known to Rust before this module exists, and
   * an event emitted then is emitted into nothing. So READY is sent HERE,
   * after the listener is registered and never before, and the shell hands
   * over what it held. StrictMode's mount/unmount/mount sends READY twice;
   * the shell's queue answers the second with nothing, by design. Outside
   * Tauri there is no shell and nothing to subscribe to. */
  const openRequests: OpenRequests = {
    subscribe: (handler) => {
      if (!inTauri()) return () => {}
      let stopped = false
      let stop: (() => void) | null = null
      void (async () => {
        const { emit, listen } = await shellEvents()
        const off = await listen<string[]>(OPEN_FILES_EVENT, (event) => handler(event.payload))
        if (stopped) {
          off()
          return
        }
        stop = off
        await emit(OPEN_FILES_READY_EVENT)
      })().catch((cause: unknown) => {
        console.error('Paper: could not listen for the files the launch carried', cause)
      })
      return () => {
        stopped = true
        stop?.()
      }
    },
  }

  /* WHAT THE SHELL IS HANDED. The sequence is over; everything below this line
     is somebody else's frame. */
  return {
    services,
    fs,
    shelfUnread,
    bootNotice: storeNotice,
    composition,
    beforeWindowClose: teardown,
    openRequests,
    /* ONLY WHEN SOMETHING IS ACTUALLY RECORDING — see `diagnosticLog` on
       `BootedApp`. `diagnosticsOn` is the same flag the sink reads. */
    diagnosticLog: diagnosticsOn ? diagnosticLog : null,
    /* THE FILE IS A PROJECTION OF THE WINDOW — see `diagnosticsLog.ts` — so
       clearing one must rewrite the other, or a harness reading
       `diagnostics.jsonl` over ssh reads entries the app has thrown away. */
    onDiagnosticsCleared: diagnosticSpool ? () => diagnosticSpool.touch() : null,
    bookCount: initialBooks.length,
    startedAt: bootFrom,
  }
}

/**
 * The measurements that can only be taken once a shell has drawn.
 *
 * Called by the entry immediately after `render`, not from `bootApp`: a shelf
 * that comes up quickly and then reads a thousand covers is slow in a way no
 * boot measurement can see, and the boot is over by the time that starts.
 * `watchFs` then reports each subsequent burst of filesystem work.
 *
 * Dev-only in effect — both send over the HMR socket, which does not exist in
 * a build.
 */
export function reportFirstFrame(booted: BootedApp): void {
  onFirstPaint('the window drew its first frame', {
    ms: Math.round(performance.now() - booted.startedAt),
    books: booted.bookCount,
  })
  watchFs()
}

/**
 * A legacy library value that is not a list is not a library.
 *
 * The cast used to be `as []` over an unchecked array, which claims the
 * EMPTY-tuple type — so `[null, validRow]` satisfied the outer check and every
 * element was then treated as a row it might not be. Each entry is checked to
 * be a non-null object, and anything else is dropped: a legacy file is one a
 * reader may have hand-edited, so a single bad row must not cost the rest.
 */
function asRows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
}

function readJson(raw: string | null, fallback: unknown): unknown {
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}
