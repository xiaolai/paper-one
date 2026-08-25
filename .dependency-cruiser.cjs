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
const COMPOSITION_ROOTS = [
  '^src/app/composition\\.(desktop|ios|android|web)\\.ts$',
  '^src/main\\.tsx$',
  /* The BROWSER client's root (phase 18). A second root rather than a branch
   * inside `main.tsx`: that file arms a shutdown handshake with the Rust
   * shell, tears down the sync journal and migrates a legacy library, and the
   * imports carrying those pull `@tauri-apps` into a bundle served to a
   * phone. `assert-bundle` refuses a web bundle that reaches one. */
  '^src/main\\.web\\.tsx$',
]

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

/** The BROWSER CLIENT: `src/app/web/`, the SPA the shelf serves to a phone.
 *
 * It is the one part of this tree that cannot use the kernel's public entry.
 * That barrel re-exports modules which import `@tauri-apps`, and importing ANY
 * symbol from it retains them — `assert-bundle` refuses a web bundle carrying
 * three, and a browser has no such thing to run.
 *
 * So it reaches a SHORT, NAMED list of kernel modules directly, and
 * `web-client-kernel-allowlist` below holds it to that list. Each entry is a
 * module with no runtime dependencies of its own, which is why reaching it
 * costs nothing. Adding a fourth should prompt the question this note is
 * really about: whether the public entry ought to be Tauri-free. */
const WEB_CLIENT = '^src/app/web/'

/** The kernel's two entries: the React-free public one every capability may
 *  import, and the UI one only a composition root may. */
const KERNEL_PUBLIC_ENTRY = '^src/kernel/index\\.ts$'
/** The kernel's TEST-ONLY entry — see `kernel-testkit-in-tests-only`. */
const KERNEL_TESTKIT_ENTRY = '^src/kernel/testkit\\.ts$'
const KERNEL_UI_ENTRY = '^src/kernel/ui/index\\.ts$'

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
  '^src/kernel/core/bookSizes\\.ts$',
  '^src/kernel/core/bookVault\\.ts$',
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
 *  `inference/lib/plugin.ts` is the second entry (phase 15): it wraps
 *  `tauri-plugin-inference`, whose commands carry the bearer token, the model
 *  installer and the agent turn. Everything above it calls a function; nothing
 *  above it calls `invoke`. */
const PLUGIN_WIRES = [
  '^src/capabilities/peer/lib/wire\\.ts$',
  '^src/capabilities/inference/lib/plugin\\.ts$',
  /* The third (phase 18): `tauri-plugin-webhost`'s commands — the six-digit
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
        'roots are judged by composition-root-kernel-entries instead, which adds the UI entry.',
      from: { path: '^src/', pathNot: ['^src/kernel/', WEB_CLIENT, ...COMPOSITION_ROOTS] },
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
      to: { path: '^src/kernel/testkit\\.ts$' },
    },
    {
      name: 'composition-root-kernel-entries',
      severity: 'error',
      comment:
        'A composition root (src/app/composition.<platform>.ts, src/main.tsx) may import the kernel ' +
        "through exactly two files: the public entry and the UI entry, src/kernel/ui/index.ts. The " +
        'UI entry exists because the public entry is React-free and a root has to render App; ' +
        'nothing else may import it, and a root may not reach past either.',
      from: { path: COMPOSITION_ROOTS },
      to: { path: '^src/kernel/', pathNot: [KERNEL_PUBLIC_ENTRY, KERNEL_UI_ENTRY, KERNEL_STYLESHEETS, KERNEL_METRICS] },
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
        'braid two platforms\' capability graphs. Only the two entries that choose a root — ' +
        'src/main.tsx and src/main.web.tsx — and tests are exempt.',
      from: {
        path: '^src/',
        /* Both entries choose a root, and neither may be reached FROM one —
         * `src/main.web.tsx` is the browser client's, exempt for exactly the
         * reason `src/main.tsx` is. */
        pathNot: ['^src/main\\.tsx$', '^src/main\\.web\\.tsx$', '\\.(test|testkit)\\.tsx?$'],
      },
      to: { path: '^src/app/composition\\.(desktop|ios|android|web)\\.ts$' },
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
      name: 'web-client-kernel-allowlist',
      severity: 'error',
      comment:
        'The browser client (src/app/web/) is exempt from kernel-public-entry-only because the ' +
        "public entry's barrel retains modules that import @tauri-apps, which do not exist in a " +
        'browser — assert-bundle refuses a web bundle carrying them. This is the rule that keeps ' +
        'that exemption narrow: it may reach the design-system stylesheets, metrics.ts and ' +
        'envelope.ts, and nothing else of the kernel. All three have no runtime dependencies of ' +
        'their own. A fourth entry is a signal that the public entry should be made Tauri-free ' +
        'instead of routed around.',
      from: { path: WEB_CLIENT },
      to: {
        path: '^src/kernel/',
        pathNot: [KERNEL_PUBLIC_ENTRY, KERNEL_STYLESHEETS, KERNEL_METRICS, KERNEL_ENVELOPE],
      },
    },
    {
      name: 'no-tauri-api-outside-peer-wire',
      severity: 'error',
      comment:
        'A capability may not import @tauri-apps/* directly — the platform is reached through the ' +
        "kernel's primitives, or through a capability's own plugin wire. The exceptions are the " +
        'wires themselves (see PLUGIN_WIRES): peer/lib/wire.ts and inference/lib/plugin.ts, which ' +
        'are where invoke/listen for those two plugins live (mirroring the fs-plugin allow-list ' +
        'above). One file per plugin, so the set of command names is auditable in one place. ' +
        'Matched on the package name wherever it resolves, like the fs rule.',
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
        '`no-tauri-api-outside-peer-wire` is scoped to src/capabilities/, so src/app/web/ could ' +
        'import @tauri-apps/api/core with `pnpm boundaries` reporting 0 violations. Measured, not ' +
        'assumed. assert-bundle also refuses such a bundle, but that is a build away; this is the ' +
        'edge itself, and it names the file. Matched on the package name wherever it resolves, ' +
        'like the two rules below.',
      from: { path: [WEB_CLIENT, '^src/main\\.web\\.tsx$'] },
      to: { path: '(^|/)@tauri-apps/' },
    },
    {
      name: 'peer-wire-tauri-api-only',
      severity: 'error',
      comment:
        "A wire's exception is @tauri-apps/api and nothing wider: the fs plugin, the dialog " +
        'plugin and every other @tauri-apps package stay out of capabilities entirely.',
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
    tsConfig: { fileName: path.join(__dirname, 'tsconfig.base.json') },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.d.ts', '.mjs', '.js', '.cjs', '.json'],
    },
  },
}
