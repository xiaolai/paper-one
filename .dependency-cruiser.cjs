'use strict'

/**
 * The boundary rules — decision 2 ("public entrypoints") and the "declared"
 * half of decision 3 (`requires`) of `dev-docs/adr/0001-kernel-capabilities.md`,
 * as `pnpm boundaries` (`scripts/check-boundaries.mjs`) enforces them.
 *
 * Every rule here matches on the RESOLVED path of an edge, so anything that
 * stops resolution silently disables it — which is why `no-unresolvable` is a
 * rule and not a warning. Type-only imports count (`tsPreCompilationDeps`),
 * dynamic `import()` counts, tests count (nothing under `src/` is excluded),
 * and a barrel is judged by its own edges: an `export … from` crossing a line
 * is a crossing, whoever imports the barrel.
 *
 * `scripts/check-boundaries.selftest.mjs` injects every illegal edge into a
 * fixture tree and asserts each rule below rejects the edge it owns; a rule
 * added here needs a fixture there.
 *
 * The one thing these rules cannot express — that a capability may import
 * another's `index.ts` ONLY when its manifest entry lists that capability in
 * `requires` — is checked by `check-boundaries.mjs` over this cruise's JSON
 * output, under the name `capability-requires-declared`.
 *
 * The composition-root exception is mostly the shape of the rules:
 * `src/app/composition.<platform>.ts` and `src/main.tsx` may import every
 * capability's `index.ts` and the kernel's entries because nothing below
 * forbids an edge to an index or to `src/kernel/index.ts` from there. The one
 * thing they may import that nobody else may is the kernel's UI entry,
 * `src/kernel/ui/index.ts` (`composition-root-kernel-entries`) — the React
 * side of the kernel, which the public entry keeps out so a capability's
 * declarations stay React-free. What a root may NOT do is reach past an index
 * (`capability-only-via-index`) or past those two entries. The selftest's
 * legal tree is exactly a composition root doing the allowed thing.
 */

const path = require('node:path')

/** The composition roots: one static composition per platform, and the file
 *  that imports exactly one of them. `composition.contract.test.ts` is NOT one —
 *  the platform list is closed, so the test falls under the ordinary rule. */
/**
 * The roots that build a NATIVE app, and the one that builds the browser
 * client — separately, because they may not reach for each other's UI entry.
 *
 * `COMPOSITION_ROOTS` below is their union and stays the subject of every rule
 * that treats a root as a root. These two exist for the one rule that cannot:
 * the kernel's UI entries are per-platform, and a single allowance covering
 * both let a native root import the browser's and the browser root import the
 * Tauri-bound one.
 */
const DESKTOP_COMPOSITION_ROOTS = ['^src/app/composition\\.desktop\\.ts$', '^src/main\\.tsx$']

/* The MOBILE shell's roots. Separate from the desktop's rather than a branch
   inside `main.tsx`, for the reason the browser's are separate again: the
   shells share a launch sequence, not a component tree, and the desktop tree
   must not enter a mobile bundle. */
const MOBILE_COMPOSITION_ROOTS = ['^src/app/composition\\.(ios|android)\\.ts$', '^src/main\\.mobile\\.tsx$']

/* THE SHARED LAUNCH SEQUENCE, which is part of the root rather than a module
   the root calls. It reaches the kernel's public entry and its boot entry
   exactly as a root does, and it exists only because BOTH native roots run
   it — see the header of `src/app/bootApp.ts`. It belongs to no platform
   group, which is what refuses it all three component entries below. */
const LAUNCH_SEQUENCE = '^src/app/bootApp\\.ts$'

/* The BROWSER client's roots (phase 18). Their own group rather than a branch
   inside `main.tsx`: that file arms a shutdown handshake with the Rust shell,
   tears down the sync journal and migrates a legacy library, and the imports
   carrying those pull `@tauri-apps` into a bundle served to a phone.
   `assert-bundle` refuses a web bundle that reaches one. */
const WEB_COMPOSITION_ROOTS = ['^src/app/composition\\.web\\.ts$', '^src/main\\.web\\.tsx$']

/**
 * Who may take which of the kernel's UI entries.
 *
 * ⚠️ **THE UNIONS ARE DERIVED, AND THEY WERE TYPED OUT THREE TIMES.**
 * `NATIVE_COMPOSITION_ROOTS`, `COMPOSITION_ROOTS` and the `to` list of
 * `no-capability-to-composition-root` each held the same roots written by
 * hand, so adding or renaming one updated whichever the author was looking at
 * and left the others describing a tree that no longer existed. Nothing could
 * notice: each list was complete on its own. They are spreads now, so a root
 * added to a platform group is a root everywhere, in one edit.
 *
 * The groups are what the four `only-…-takes-…` rules below are written
 * against. A root in NO group is refused every component entry — the loud
 * default: a new platform must say which door is its, rather than silently
 * inheriting all of them.
 */
const NATIVE_COMPOSITION_ROOTS = [
  ...DESKTOP_COMPOSITION_ROOTS,
  ...MOBILE_COMPOSITION_ROOTS,
  LAUNCH_SEQUENCE,
]

const COMPOSITION_ROOTS = [...NATIVE_COMPOSITION_ROOTS, ...WEB_COMPOSITION_ROOTS]

/* Who takes `src/kernel/ui/boot.ts` DIRECTLY. Not a platform group, because it
   cuts across one: the launch sequence and the phone's root run it, and the
   phone's two composition files — which list capabilities and launch nothing —
   do not. Spelled out rather than widened to MOBILE_COMPOSITION_ROOTS so that
   moving launch code into a composition file has to be a decision. */
const BOOT_ENTRY_TAKERS = [LAUNCH_SEQUENCE, '^src/main\\.mobile\\.tsx$']

/** The design system's stylesheets.
 *
 * A composition root reaches these DIRECTLY only because the browser root
 * cannot take the ordinary path: `src/kernel/ui/index.ts` imports them, and it
 * also reaches `appStorage.ts` and four other modules that import
 * `@tauri-apps`, which do not exist in a browser.
 *
 * Narrow on purpose — `.css` under `styles/` and nothing else. A stylesheet
 * carries no imports and cannot smuggle a dependency past the boundary these
 * rules exist to hold; a `.ts` file there could, so it stays refused. */
const KERNEL_STYLESHEETS = '^src/kernel/ui/styles/.*\\.css$'

/** The design system's geometry.
 *
 * `applyMetrics` publishes `--control-sm`, `--radius-pill` and the rest onto a
 * root element, and `capability.css` resolves every control's size and shape
 * from them. `App.tsx` calls it for the desktop build from inside `kernel/ui`.
 *
 * The BROWSER root cannot take either sanctioned door. `kernel/ui/index.ts`
 * pulls five modules that import `@tauri-apps`; so does the public entry, whose
 * barrel retains them for any symbol taken from it — `assert-bundle` refused a
 * web bundle carrying three. Without this the client mirrored the constants in
 * a stylesheet of its own, which is a client IMITATING the design system rather
 * than using it, and it showed.
 *
 * Narrow, and cheap to allow: `metrics.ts` has exactly one import and it is
 * type-only. It is arithmetic over constants with no dependencies to smuggle. */
const KERNEL_METRICS = '^src/kernel/core/metrics\\.ts$'

/** The envelope: a service call as bytes, and bytes back.
 *
 * It moved into the kernel in phase 18 because a second transport needed it —
 * nothing about it is peer-to-peer. */
const KERNEL_ENVELOPE = '^src/kernel/core/envelope\\.ts$'
/* The SHELF CHANNEL — the envelope over a WebSocket, and a leaf for the same
 * reason the envelope is: its only import is the envelope, and it reads no
 * platform. It moved out of `src/app/web/` in WI-11.7 when `paper --shelf`
 * became a second caller that cannot import the browser client; the client
 * keeps a re-export at the old path, and this is what lets that re-export
 * reach the leaf DIRECTLY rather than dragging the kernel barrel into the web
 * bundle to fetch one module. */
const KERNEL_SHELF_CHANNEL = '^src/kernel/core/shelfChannel\\.ts$'

/* THE BROWSER UI ENTRY (WI-19.4), which REPLACED a whole-directory reach.
 * This was `KERNEL_READER = '^src/kernel/ui/reader/'` — the client could import
 * any of the twenty-odd modules under `ui/reader/` by path, and did. An entry
 * is a door with a list on it; a directory prefix is a hole the shape of a
 * directory. `scripts/check-browser-safe.mjs` pins the entry browser-safe, so
 * what is behind this door is guaranteed rather than hoped. */
const KERNEL_BROWSER_ENTRY = '^src/kernel/ui/browser\\.ts$'
/** The type vocabulary the reader is configured with — `Theme`, `Typeface`,
 *  `ReadingStyle` and the rest. ZERO dependencies of its own, which is the test
 *  every leaf on this list passes. */
const KERNEL_UI_TYPES = '^src/kernel/core/uiTypes\\.ts$'

/** The BROWSER CLIENT: `src/app/web/`, the SPA the shelf serves to a phone.
 *
 * ⚠️ **THIS USED TO BE AN EXEMPTION AND IS NOW A PAIR OF DOORS.** The old rule,
 * `web-client-kernel-allowlist`, existed because the kernel's public entry
 * re-exported modules importing `@tauri-apps` — so the client could not use it
 * and reached five named modules directly instead, one of them an entire
 * DIRECTORY (`ui/reader/`). Its own comment asked the right question: "a fourth
 * entry is a signal that the public entry should be made Tauri-free instead of
 * routed around." There were five.
 *
 * WI-19.1 made it Tauri-free — one export, `tauriSizePort`, was the whole
 * cause — so `web-client-kernel-entries` below now mirrors
 * `composition-root-kernel-entries`: the public entry, plus a React door
 * (`ui/browser.ts`) the client may mount surfaces from, plus the same two
 * dependency-free leaves a root gets.
 *
 * The client is NOT folded into `kernel-public-entry-only`. That rule is for
 * capabilities, which have no business importing React; this client's whole
 * job is to render it. */
const WEB_CLIENT = '^src/app/web/'

/** THE SHARED MOBILE SHELL.
 *
 * `src/app/shell/` is the phone furniture from the mobile design — the tab bar,
 * the bottom sheet, the Continue strip, the selection bar, the progress footer.
 * It began inside the browser client, which is where the design was first
 * built; the NATIVE mobile shell mounts the same pieces, so it moved up one
 * level rather than being copied.
 *
 * ⚠️ **IT MAY NOT NAME A UI DOOR, and that is the whole reason it has a rule.**
 * The kernel's UI entries are per-platform on purpose — `ui/browser.ts` for a
 * browser, `ui/index.ts` for a native build — and a component mounted by BOTH
 * roots that imported one of them would pick a platform on the other's behalf
 * and drag that barrel's whole re-export set into the wrong bundle. So it takes
 * the public entry, the design system's geometry, and the browser-safe LEAVES
 * it renders, exactly as the browser client takes `envelope.ts` and
 * `shelfChannel.ts`.
 *
 * What is NOT here is as load-bearing: `ReadingSettings` and `YouScreen` were
 * moved BACK to `src/app/web/` during this split, because both reach the
 * browser's own settings store and one of them takes an `onSignOut` a native
 * app has no use for. A shared directory is for what is genuinely shared. */
const SHARED_SHELL = '^src/app/shell/'

/** THE NATIVE MOBILE CLIENT.
 *
 * `src/app/mobile/` is to iOS and Android what `src/app/web/` is to a browser:
 * the shell that composes the kernel's surfaces for one audience. It reaches
 * the kernel through ENTRIES — the public one and `ui/mobile.ts` — plus the
 * design-system leaves, exactly as the browser client does. */
const MOBILE_CLIENT = '^src/app/mobile/'

/** The two kernel COMPONENTS the shared shell renders.
 *
 * Both are browser-safe leaves that the two doors each re-export; naming the
 * leaves is what lets one component serve both clients. Narrow on purpose — a
 * prefix here would re-open the directory allowance that
 * `web-client-kernel-allowlist` was removed for. */
/* `.tsx?` rather than `.tsx`: both are React components in the real tree, but
   the selftest lays out its fixture entirely in `.ts` so that resolution is
   never the variable under test. An exact `.tsx` here passed the real cruise
   and failed the selftest's clean tree — the pattern would have been pinned to
   a file extension rather than to a module. */
const KERNEL_OVERLAY_SHEET = '^src/kernel/ui/overlays/OverlaySheet\\.tsx?$'
const KERNEL_BOOK_COVER = '^src/kernel/ui/screens/BookCover\\.tsx?$'
const KERNEL_COVER_ART = '^src/kernel/core/coverArt\\.ts$'

/** The kernel's two entries: the React-free public one every capability may
 *  import, and the UI one only a composition root may. */
const KERNEL_PUBLIC_ENTRY = '^src/kernel/index\\.ts$'
/** The kernel's TEST-ONLY entry — see `kernel-testkit-in-tests-only`. */
const KERNEL_TESTKIT_ENTRY = '^src/kernel/testkit\\.ts$'
const KERNEL_UI_ENTRY = '^src/kernel/ui/index\\.ts$'

/** The kernel's NATIVE BOOT entry.
 *
 * `src/kernel/ui/boot.ts` is the third door: the launch surface — the store,
 * the filesystem, the shelf, the migration, the measurements — with no React
 * component in it. `src/kernel/ui/index.ts` re-exports it, so the desktop root
 * still has one import and the list has one home.
 *
 * It exists because `bootApp.ts` and the mobile root need `loadShelf` and its
 * neighbours WITHOUT `App`. A barrel retains everything it names, so reaching
 * them through the UI entry would put the entire desktop pane tree into a
 * mobile bundle that renders none of it — the defect `browser.ts` was created
 * for, and the one AGENTS.md records at 0.5% of function coverage. */
const KERNEL_BOOT_ENTRY = '^src/kernel/ui/boot\\.ts$'

/** The kernel's MOBILE UI entry.
 *
 * The fourth door. `ui/index.ts` is the desktop shell's and names `App`;
 * `ui/browser.ts` grows for what a BROWSER mounts; this one grows for what a
 * PHONE mounts, and the two sets are not the same. Like the browser's, it
 * grows one export at a time, in the change that mounts it — a barrel's
 * re-exports evaluate with the barrel. */
const KERNEL_MOBILE_ENTRY = '^src/kernel/ui/mobile\\.ts$'

/** The kernel's storage adapters: the only modules that touch the fs plugin.
 *
 *  `tagFiles` is one of them, and is on this list for the same reason the
 *  others are: it is the half of the tag archive that TOUCHES A FILE, split
 *  from `core/tagArchive.ts` — which decides what an archive contains and
 *  needs no filesystem to be tested. Both paths go through a dialog, so the
 *  file is one the reader pointed at; no path is constructed there.
 *
 *  `marksFiles` is the same shape and here for the same reason: the I/O half
 *  of `core/marksArchive.ts`, dialogs only, no path constructed. That two of
 *  these now exist is the pattern, not an exception to it — an archive is a
 *  pure document module plus a thin file half, and the file half is what goes
 *  on this list.
 *
 *  `bookSizes` is the third of that shape: `sizePortOver` decides what a size
 *  MEANS — the extension preference order, and the rule that a walk which did
 *  not finish has no total — and needs no filesystem to be tested, while the
 *  binding under it is two calls to the plugin. It constructs paths, unlike
 *  the two archive halves above, but only from `folderOf` and the kernel's
 *  closed `CONTENT_EXTENSIONS` list; nothing a reader typed reaches it. */
const FS_ADAPTERS = [
  '^src/kernel/core/bookFiles\\.ts$',
  /* `bookSizes.ts` IS NO LONGER ON THIS LIST, for exactly the reason
   * `bookVault.ts` is not, below. It holds `sizePortOver` — a pure walk over
   * two callbacks — and while the binding sat eleven lines beneath it, the
   * kernel's PUBLIC ENTRY re-exported `tauriSizePort` and so could not be
   * bundled for a browser at all. One export, 54 modules. The binding is
   * `bookSizesTauri.ts`. */
  '^src/kernel/core/bookSizesTauri\\.ts$',
  /* `bookVault.ts` IS NO LONGER ON THIS LIST, and its absence is the point.
   * It holds the vault's seam and its rules — `extensionFor`,
   * `CONTENT_EXTENSIONS`, `readRangeOf` — which `bookFolder` imports and the
   * reader imports in turn. While the Tauri binding sat beside them, every one
   * of those importers dragged the fs plugin in behind it, which is what put
   * the reader out of a browser's reach. The binding is `vaultFsTauri.ts`. */
  '^src/kernel/core/vaultFsTauri\\.ts$',
  /* The audiobook export's scratch, and it belongs here for the same reason the
   * two bindings above do rather than as an exemption from the rule. It is the
   * KERNEL, not a capability — the thing this rule keeps the plugin away from —
   * and it is a Tauri-only LEAF, split from `audiobook.ts` exactly as
   * `vaultFsTauri.ts` was split from `bookVault.ts`, so nothing a browser
   * reaches imports it. What it does with the plugin is what every other entry
   * does: own a directory under `$APPDATA` and remove its own files from it. */
  '^src/kernel/ui/reader/audiobookTauri\\.ts$',
  '^src/kernel/ui/appStorage\\.ts$',
  '^src/kernel/ui/tagFiles\\.ts$',
  '^src/kernel/ui/marksFiles\\.ts$',
]

/** The PLUGIN WIRES — the only capability files allowed to import
 *  @tauri-apps/api (WI-C.1, WI-15.0). Everything else a capability does to
 *  the app goes through the kernel or through one of these.
 *
 *  ONE PER TAURI PLUGIN, and the list is meant to stay short. A capability
 *  with a Rust half needs exactly one file that names its commands, so that
 *  the set of `invoke` names is auditable in one place and can be read against
 *  the crate's own `build.rs` list. A second file in the same capability would
 *  be the thing this rule exists to prevent; a second capability with its own
 *  plugin is not.
 *
 *  ⚠️ **AND IT HELD A THIRD ENTRY FOR A CAPABILITY THAT NO LONGER EXISTS.**
 *  `inference/lib/plugin.ts` (phase 15) wrapped `tauri-plugin-inference`, and
 *  the whole `inference` capability was deleted with the AI features on
 *  2026-09-19 — plugin, crate and directory. The grant outlived it by every
 *  commit since, because a permission naming a path that cannot exist matches
 *  nothing and so can never fail: it is exactly the silent-staleness shape
 *  AGENTS.md records for a hand-written capability id, wearing another hat. A
 *  live allowlist is a statement about what is allowed TODAY, and an entry
 *  nothing can satisfy makes that statement unreadable — the next reader cannot
 *  tell a standing exception from a fossil. Found by reading, not by a gate;
 *  `pnpm boundaries` was green throughout. */
const PLUGIN_WIRES = [
  '^src/capabilities/peer/lib/wire\\.ts$',
  /* The second (phase 18): `tauri-plugin-webhost`'s commands — the six-digit
   * code the shelf shows, the browsers holding a credential, and the frame pipe
   * to each. Admitted by the rule's own reasoning above: a second file in ONE
   * capability is what this list prevents, and a second capability with its own
   * plugin is not. The crate's `build.rs` carries the matching command list,
   * and a test in that crate fails when the two disagree. */
  '^src/capabilities/webhost/lib/wire\\.ts$',
]

/** A capability's public entry — the only file under `src/capabilities/<id>/`
 *  anything outside that directory may import. */
const CAPABILITY_INDEX = '^src/capabilities/[^/]+/index\\.tsx?$'

/**
 * The CLI, and the hosts under it — the SECOND composition of this system
 * (phase 11).
 *
 * `src/cli/` is `paper`: a process that builds `KernelServices` over
 * `src/hosts/node/` and reaches services either in-process or over the peer
 * capability's envelope. That last clause is what puts it here rather than
 * under the ordinary rule: it composes a capability, which is the one thing
 * `capability-index-only-from-composition` reserves for a composition root.
 * It is a directory rather than one file because a CLI is not one file.
 *
 * `src/hosts/` is NOT part of that allowance. A host is a SEAM — an
 * implementation of `IndexFs`/`FileSystem` for a runtime that is not the
 * webview — and a seam that composed a capability would be a composition
 * root wearing a filesystem's name. Hosts get the leaf rule below and
 * nothing else.
 *
 * It is NOT added to `COMPOSITION_ROOTS`, deliberately: that constant carries
 * the kernel's UI entry with it, and a CLI has no React and must not gain a
 * path to any. `kernel-public-entry-only` therefore still applies here — the
 * CLI and the hosts may import `src/kernel/index.ts` and nothing else of the
 * kernel — and so does `capability-only-via-index`: reaching PAST a
 * capability's index is refused here exactly as it is everywhere else.
 *
 * The allowance is closed at the other end by `hosts-and-cli-are-leaves`
 * below: nothing under `src/kernel/` or `src/capabilities/` may import these,
 * so a capability cannot reach an undeclared capability by way of the CLI.
 */
const CLI_ROOT = ['^src/cli/']
const CLI_AND_HOSTS = [...CLI_ROOT, '^src/hosts/']

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-kernel-to-capabilities',
      severity: 'error',
      comment:
        'The kernel imports nothing from capabilities/, in value or type position. Where it must call ' +
        'into one it goes through a kernel-owned port with a no-op default, injected by the composition root.',
      from: { path: '^src/kernel/' },
      to: { path: '^src/capabilities/' },
    },
    {
      name: 'no-kernel-reaches-capabilities',
      severity: 'error',
      comment:
        'The transitive form of no-kernel-to-capabilities: a kernel module may not reach a capability ' +
        'through any chain of imports — a barrel under src/app/, a helper, anything. The direct rule ' +
        'names the crossing edge; this one refuses the path.',
      from: { path: '^src/kernel/' },
      to: { path: '^src/capabilities/', reachable: true },
    },
    {
      name: 'kernel-public-entry-only',
      severity: 'error',
      comment:
        'Outside the kernel, the only kernel module that may be imported is its public entry, ' +
        'src/kernel/index.ts — for a capability, a test under src/app/, anything. The composition ' +
        'roots are judged by composition-root-kernel-entries instead, which adds the UI entry, and ' +
        'the shared mobile shell by shared-shell-kernel-entries, which adds the two leaf components ' +
        'it renders. Both of those rules are NARROWER than this one, not looser: each names its ' +
        'permitted modules exactly.',
      from: { path: '^src/', pathNot: ['^src/kernel/', WEB_CLIENT, MOBILE_CLIENT, SHARED_SHELL, ...COMPOSITION_ROOTS] },
      to: { path: '^src/kernel/', pathNot: [KERNEL_PUBLIC_ENTRY, KERNEL_TESTKIT_ENTRY] },
    },
    {
      name: 'kernel-testkit-in-tests-only',
      severity: 'error',
      comment:
        "src/kernel/testkit.ts holds `fakeFs`, a deliberately behaviour-divergent stand-in for a " +
        'filesystem — its readDir decides a name is a directory by whether it contains a dot, and ' +
        'its exists is a prefix match. Only a test or another testkit may import it. It used to be ' +
        're-exported from the production entry, where the boundary rules could not tell it apart ' +
        'from `createKernelServices`, because it came through the one door everything may use.',
      from: { pathNot: ['\\.test\\.(ts|tsx|mjs)$', '\\.testkit\\.(ts|tsx)$'] },
      /* THE CONSTANT, NOT THE LITERAL IT IS A COPY OF. Spelled out here, the
         entry's protection and its allowance in `no-kernel-internals-outside`
         could be renamed apart — and a testkit entry that two rules disagree
         about is one nothing protects. */
      to: { path: KERNEL_TESTKIT_ENTRY },
    },
    {
      name: 'kernel-testkit-not-reached-through-a-testkit',
      severity: 'error',
      comment:
        'And not through an intermediary. The rule above reads DIRECT imports only, and it exempts ' +
        'every *.testkit.ts importer — so production code importing a helper testkit that itself ' +
        'imports src/kernel/testkit.ts passed both halves: the production file did not name the ' +
        'entry, and the file that did was exempt. `fakeFs` would then be in a shipped bundle, ' +
        'deciding that a name containing a dot is a directory. This rule is transitive and has no ' +
        'testkit exemption on the `from` side, so the chain is refused wherever it starts in ' +
        'production; the direct rule stays for the clearer diagnostic it gives on the common case.',
      from: { pathNot: ['\\.test\\.(ts|tsx|mjs)$', '\\.testkit\\.(ts|tsx)$'] },
      to: { path: KERNEL_TESTKIT_ENTRY, reachable: true },
    },
    {
      name: 'composition-root-kernel-entries',
      severity: 'error',
      comment:
        'A composition root (src/app/composition.<platform>.ts, src/main.tsx, src/main.web.tsx) may ' +
        'import the kernel through the public entry and ONE UI entry — never past either. This rule ' +
        'refuses everything else under src/kernel/; WHICH UI entry is its platform\'s is settled by ' +
        'the four only-…-takes-… rules below, one per entry.',
      from: { path: COMPOSITION_ROOTS },
      to: { path: '^src/kernel/', pathNot: [KERNEL_PUBLIC_ENTRY, KERNEL_UI_ENTRY, KERNEL_BOOT_ENTRY, KERNEL_MOBILE_ENTRY, KERNEL_BROWSER_ENTRY, KERNEL_STYLESHEETS, KERNEL_METRICS] },
    },
    /**
     * ⚠️ **ONE RULE PER ENTRY, BECAUSE THREE RULES PER *EXCEPTION* LEFT HALF THE
     * GRID OPEN.** `composition-root-kernel-entries` allows every root all four
     * UI entries, and three subtractive rules used to carve pieces back out:
     * natives could not take the browser's, boot and mobile could not take the
     * desktop's, web could not take the desktop's. That is four entries against
     * four root groups — sixteen pairs — and only five were decided. The
     * undecided ones were real: `composition.ios.ts` could import the DESKTOP
     * barrel, `main.tsx` could import `ui/mobile.ts`, and the web root could
     * import `ui/boot.ts` or `ui/mobile.ts`. Each contradicts the invariant the
     * rule above states in its own comment, and no rule could notice, because a
     * subtractive rule is silent about every pair it does not name.
     *
     * Written the other way round the grid closes itself: each entry names the
     * group that owns it and refuses every other root. Sixteen pairs, four
     * rules, no gap — and a root in NO group is refused all four, so a new
     * platform fails closed rather than inheriting every door.
     */
    {
      name: 'only-a-desktop-root-takes-the-desktop-ui-entry',
      severity: 'error',
      comment:
        'src/kernel/ui/index.ts is the DESKTOP door. That barrel names App, and a barrel retains ' +
        'everything it names — so a mobile or web root reaching it for loadShelf or openAppStorage ' +
        'would load the entire desktop pane tree, titlebar and palette into a bundle that renders ' +
        'none of them, and it re-exports modules that import @tauri-apps, which assert-bundle then ' +
        'refuses for a reason that reads as unrelated. The shared launch sequence is refused it too, ' +
        'and takes src/kernel/ui/boot.ts — the same list with no component in it, which index.ts ' +
        're-exports so the desktop root still has one door.',
      from: { path: COMPOSITION_ROOTS, pathNot: DESKTOP_COMPOSITION_ROOTS },
      to: { path: KERNEL_UI_ENTRY },
    },
    {
      name: 'only-a-mobile-root-takes-the-mobile-ui-entry',
      severity: 'error',
      comment:
        'src/kernel/ui/mobile.ts is the PHONE door, and until this rule existed nothing said so: ' +
        'every root could import it, so the desktop and browser bundles could each acquire the ' +
        'mobile shell they never render.',
      from: { path: COMPOSITION_ROOTS, pathNot: MOBILE_COMPOSITION_ROOTS },
      to: { path: KERNEL_MOBILE_ENTRY },
    },
    {
      name: 'only-a-web-root-takes-the-browser-ui-entry',
      severity: 'error',
      comment:
        'src/kernel/ui/browser.ts exists for the browser client and grows one export at a time, in ' +
        'the change that mounts it — a barrel\'s re-exports evaluate with the barrel, so a native ' +
        'root reaching for it would load and retain surfaces nothing on that platform renders.',
      from: { path: COMPOSITION_ROOTS, pathNot: WEB_COMPOSITION_ROOTS },
      to: { path: KERNEL_BROWSER_ENTRY },
    },
    {
      name: 'only-the-launch-sequence-and-the-mobile-root-take-the-boot-entry',
      severity: 'error',
      comment:
        'src/kernel/ui/boot.ts is the launch surface with no React component in it. The shared ' +
        'sequence (src/app/bootApp.ts) and the mobile root take it directly; the desktop root takes ' +
        'it through src/kernel/ui/index.ts, which re-exports it, so that root keeps ONE door rather ' +
        'than two. A web root has no native launch sequence to run and is refused it here — which ' +
        'nothing said before, so the browser bundle could pull in the shelf loader and the library ' +
        'migration it can never perform.',
      from: { path: COMPOSITION_ROOTS, pathNot: BOOT_ENTRY_TAKERS },
      to: { path: KERNEL_BOOT_ENTRY },
    },
    {
      name: 'capability-only-via-index',
      severity: 'error',
      comment:
        'From outside a capability, only its index.ts may be imported — not lib/, not ui/, not a ' +
        'test double. This is the rule for the kernel, src/app/ and src/main.tsx; the same line ' +
        'between two capabilities is cap-to-other-cap-internal.',
      from: { path: '^src/', pathNot: '^src/capabilities/' },
      to: { path: '^src/capabilities/[^/]+/', pathNot: CAPABILITY_INDEX },
    },
    {
      name: 'cap-to-other-cap-internal',
      severity: 'error',
      comment:
        'A capability may import another capability only through its index.ts (and only when its ' +
        'manifest entry lists that capability in `requires` — capability-requires-declared, checked ' +
        'over this output by scripts/check-boundaries.mjs). $1 is the importing capability, so its ' +
        'own files are not "another" capability.',
      from: { path: '^src/capabilities/([^/]+)/' },
      to: { path: '^src/capabilities/(?!$1/)[^/]+/', pathNot: CAPABILITY_INDEX },
    },
    {
      name: 'capability-index-only-from-composition',
      severity: 'error',
      comment:
        "A capability's index.ts is imported only by a composition root or by another capability " +
        '(which capability-requires-declared then checks against `requires`). A shared/other module ' +
        'under src/ — anything that is neither a composition root, nor a capability, nor the kernel ' +
        '(which no-kernel-to-capabilities already stops) — importing a capability index is a back ' +
        'door: capability A could reach an undeclared capability B THROUGH that intermediary, and the ' +
        'requires check sees only the direct A->B edge, not A->shared->B. Forbidding the intermediary ' +
        'edge closes the barrel. src/main.tsx and the composition roots are the allowed non-capability ' +
        'importers.',
      from: { path: '^src/', pathNot: [...COMPOSITION_ROOTS, ...CLI_ROOT, '^src/capabilities/', '^src/kernel/'] },
      to: { path: CAPABILITY_INDEX },
    },
    {
      name: 'hosts-and-cli-are-leaves',
      severity: 'error',
      comment:
        'Nothing under src/kernel/ or src/capabilities/ imports src/hosts/ or src/cli/. Two reasons, and ' +
        'both are load-bearing. First, those directories carry Node types and node: builtins, and a kernel ' +
        'or capability module that reached one would break the browser and mobile builds that have neither. ' +
        'Second, src/cli/ is allowed to import a capability index (see CLI_AND_HOSTS); without this rule a ' +
        'capability could reach an UNDECLARED capability through it, and capability-requires-declared judges ' +
        'only direct capability-to-capability edges. Forbidding the inward edge is what keeps the allowance ' +
        'from being a back door. Tests are not exempt: a capability test that reached the CLI would be the ' +
        'same edge.',
      from: { path: ['^src/kernel/', '^src/capabilities/'] },
      to: { path: CLI_AND_HOSTS },
    },
    {
      name: 'no-capability-to-composition-root',
      severity: 'error',
      comment:
        'NOTHING imports a composition root (nor src/main.tsx) but a test: the root imports EVERY ' +
        "composed capability's index, so the edge would hand the importer the whole composition — " +
        'each capability reachable without a `requires` declaration, because ' +
        'capability-requires-declared judges only direct capability-to-capability edges. And the rule ' +
        'covers every module, not just capabilities, so a capability cannot launder the edge through ' +
        'a shared intermediary either — and one PLATFORM root cannot import another, which would ' +
        'braid two platforms\' capability graphs. Only the modules that CHOOSE a root — ' +
        'src/app/bootApp.ts for the native shells, src/main.web.tsx for the browser one — and tests ' +
        'are exempt. src/main.tsx stays exempt as well, though it no longer imports a composition at ' +
        'all: the choosing moved to bootApp.ts with the rest of the launch sequence.',
      from: {
        path: '^src/',
        /* The choosers, and none of them may be reached FROM a root.
         *
         * `bootApp.ts` is where `virtual:paper-composition` is imported now —
         * the native shells share one launch sequence, so the choice moved
         * there with it. `main.web.tsx` is the browser client's chooser, exempt
         * for exactly the reason the native one is. `main.tsx` keeps its
         * exemption because it remains an ENTRY the rule's target names; it
         * simply has no composition edge left to exempt. */
        pathNot: [
          '^src/app/bootApp\\.ts$',
          '^src/main\\.tsx$',
          '^src/main\\.mobile\\.tsx$',
          '^src/main\\.web\\.tsx$',
          '\\.(test|testkit)\\.tsx?$',
        ],
      },
      /* ⚠️ BOTH ENTRIES TOO, not only the composition files. The comment above
       * states the invariant as "nothing may import src/main.tsx", and the
       * target did not include it — so a capability could reach an entire
       * composition through either entry, which is the same exposure by a
       * different path. `main.web.tsx` is the browser client's and carries the
       * same weight. */
      /* EVERY root, derived — including the shared sequence, which imports each
         composed capability's index through the virtual specifier exactly as a
         root does. Left out, it would be the laundering intermediary this
         rule's comment describes: reachable by anything under src/, and handing
         on the whole composition. This list was typed out by hand and could
         therefore fall behind `COMPOSITION_ROOTS` without either looking
         wrong. */
      to: { path: COMPOSITION_ROOTS },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'No import cycles anywhere under src/, tests included. Cycles made only of type-only ' +
        'imports are not counted: `import type` is erased by tsc, esbuild and Vite alike, so no ' +
        'such edge exists in the emitted program and nothing can be undefined at import time — ' +
        "which is the hazard this rule guards. (dependency-cruiser's own default rule draws the " +
        'same line.) The one such cycle the tree had — useBook.ts <-> reader/session.ts, both ' +
        'ways `import type` — went in WI-5.5, when the shared types moved to core/bookMeta.ts.',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-direct-fs-plugin-outside-storage',
      severity: 'error',
      comment:
        "@tauri-apps/plugin-fs is imported by the kernel's storage adapters and nothing else. " +
        'Capabilities write through kernel primitives, never the plugin. Matched on the package name ' +
        'wherever it resolves — node_modules, the pnpm store, or unresolved — so a resolution quirk ' +
        'cannot let it through.',
      from: { pathNot: FS_ADAPTERS },
      to: { path: '(^|/)@tauri-apps/plugin-fs(/|$)' },
    },
    {
      name: 'mobile-client-kernel-entries',
      severity: 'error',
      comment:
        'The native mobile client (src/app/mobile/) reaches the kernel through ENTRIES, the same way ' +
        'the browser client does: the public entry, and src/kernel/ui/mobile.ts for the React ' +
        'surfaces it mounts — plus the design-system stylesheets, metrics.ts and uiTypes.ts, which ' +
        'are leaves with no runtime dependencies of their own. It may NOT take ui/index.ts, whose ' +
        'barrel names App and would bring the desktop pane tree, titlebar and palette into a phone ' +
        'bundle that draws none of them; nor ui/browser.ts, which lists what a BROWSER mounts. ' +
        'Three shells, three doors, and each one grows for its own audience.',
      from: { path: MOBILE_CLIENT },
      to: {
        path: '^src/kernel/',
        pathNot: [
          KERNEL_PUBLIC_ENTRY,
          KERNEL_STYLESHEETS,
          KERNEL_METRICS,
          KERNEL_UI_TYPES,
          KERNEL_MOBILE_ENTRY,
        ],
      },
    },
    {
      name: 'shared-shell-kernel-entries',
      severity: 'error',
      comment:
        'The shared mobile shell (src/app/shell/) reaches the kernel through the public entry, the ' +
        'design-system stylesheets and metrics.ts, and the browser-safe leaves it renders — ' +
        'OverlaySheet, BookCover and coverArt.ts. It may NOT name a UI door. The doors are ' +
        'per-platform (ui/browser.ts for a browser, ui/index.ts for a native build) and this ' +
        'directory is mounted by BOTH roots, so importing one would pick a platform on the other ' +
        "root's behalf and pull that barrel's whole re-export set into the wrong bundle. Naming the " +
        'leaves is what lets one component serve both clients — the same shape as the permitted ' +
        'leaves in web-client-kernel-entries.',
      from: { path: SHARED_SHELL },
      to: {
        path: '^src/kernel/',
        pathNot: [
          KERNEL_PUBLIC_ENTRY,
          KERNEL_STYLESHEETS,
          KERNEL_METRICS,
          KERNEL_UI_TYPES,
          KERNEL_OVERLAY_SHEET,
          KERNEL_BOOK_COVER,
          KERNEL_COVER_ART,
        ],
      },
    },
    {
      name: 'web-client-kernel-entries',
      severity: 'error',
      comment:
        'The browser client (src/app/web/) reaches the kernel through ENTRIES, the same way a ' +
        'composition root does: the public entry, and src/kernel/ui/browser.ts for the React ' +
        'surfaces it mounts — plus the design-system stylesheets, metrics.ts, envelope.ts, ' +
        'shelfChannel.ts and uiTypes.ts, which are leaves with no runtime dependencies of their ' +
        'own. This replaced ' +
        'web-client-kernel-allowlist, an EXEMPTION that existed only because the public entry was ' +
        'not Tauri-free; it listed five modules, one of them the whole ui/reader/ directory. ' +
        'WI-19.1 removed the cause (one export, tauriSizePort), so the exemption became a door. ' +
        'The client is deliberately not folded into kernel-public-entry-only: that rule is for ' +
        'capabilities, which must not import React, and rendering React is this client\'s job.',
      from: { path: WEB_CLIENT },
      to: {
        path: '^src/kernel/',
        pathNot: [
          KERNEL_PUBLIC_ENTRY,
          KERNEL_STYLESHEETS,
          KERNEL_METRICS,
          KERNEL_ENVELOPE,
          KERNEL_SHELF_CHANNEL,
          KERNEL_BROWSER_ENTRY,
          KERNEL_UI_TYPES,
        ],
      },
    },
    {
      name: 'no-tauri-api-outside-plugin-wires',
      severity: 'error',
      comment:
        'A capability may not import @tauri-apps/* directly — the platform is reached through the ' +
        "kernel's primitives, or through a capability's own plugin wire. The exceptions are the " +
        'wires themselves (see PLUGIN_WIRES): peer/lib/wire.ts and webhost/lib/wire.ts, which are ' +
        'where invoke/listen for those plugins live (mirroring the fs-plugin allow-list above). ' +
        'One file per plugin, so the set of command names is auditable in one place. Matched on ' +
        'the package name wherever it resolves, like the fs rule. ⚠️ THE NAME SAID "peer" AND THE ' +
        'RULE HAS NEVER BEEN ABOUT PEER ALONE: it reads every wire in PLUGIN_WIRES, so a violation ' +
        'in the webhost wire was reported under a name that misnames the abstraction governing it.',
      from: { path: '^src/capabilities/', pathNot: PLUGIN_WIRES },
      to: { path: '(^|/)@tauri-apps/' },
    },
    {
      name: 'no-tauri-in-the-web-client',
      severity: 'error',
      comment:
        'The browser client and its composition root may not import @tauri-apps/* at all. There is ' +
        'no Tauri in a browser: the import resolves at build time, ships, and fails at run time on ' +
        "the reader's phone — as `undefined is not a function`, three layers from the import that " +
        'caused it. The phase-18 plan names this as a gate and it did not exist: ' +
        '`no-tauri-api-outside-plugin-wires` is scoped to src/capabilities/, so src/app/web/ could ' +
        'import @tauri-apps/api/core with `pnpm boundaries` reporting 0 violations. Measured, not ' +
        'assumed. This rule matches ONE EDGE; a transitive reach is caught by assert-bundle, which ' +
        'inspects what actually ships and so cannot be fooled by a type-only import that erases. ' +
        '⚠️ AND ITS `from` NAMED TWO OF THE FOUR PLACES IT CLAIMED TO COVER: the comment said "and ' +
        'its composition root", and src/app/composition.web.ts — the other web root — was not in ' +
        'the list, nor was src/app/shell/, which the browser bundle includes. Both are derived now, ' +
        'so a root added to WEB_COMPOSITION_ROOTS is covered by this rule in the same edit.',
      from: { path: [WEB_CLIENT, SHARED_SHELL, ...WEB_COMPOSITION_ROOTS] },
      to: { path: '(^|/)@tauri-apps/' },
    },
    {
      name: 'plugin-wires-tauri-api-only',
      severity: 'error',
      comment:
        "A wire's exception is @tauri-apps/api and nothing wider: the fs plugin, the dialog " +
        'plugin and every other @tauri-apps package stay out of capabilities entirely. Named for ' +
        'the wires rather than for peer, for the reason the rule above gives: it reads all of them.',
      from: { path: PLUGIN_WIRES.join('|') },
      to: { path: '(^|/)@tauri-apps/(?!api(/|$))' },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'An import that does not resolve is not a warning: every rule above matches on the resolved ' +
        'path, so an unresolved edge is an edge no boundary rule can see.',
      from: { path: '^src/' },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // Type-only imports are edges. Without this an `import type` from
    // capabilities/ would compile, cross the line, and never be seen here.
    tsPreCompilationDeps: true,
    doNotFollow: { path: ['node_modules'] },
    // The shared compiler options, for `paths` (`@/*`) and the TypeScript
    // parse. Absolute, so the same config serves a fixture tree rooted
    // elsewhere (the selftest) without a copy of the tsconfig beside it.
    tsConfig: { fileName: path.join(__dirname, 'tsconfig.cruiser.json') },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.d.ts', '.mjs', '.js', '.cjs', '.json'],
    },
  },
}
