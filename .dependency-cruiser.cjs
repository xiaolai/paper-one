'use strict'

/**
 * The boundary rules — decision 2 ("public entrypoints") and the "declared"
 * half of decision 3 (`requires`) of `docs/adr/0001-kernel-capabilities.md`,
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
const COMPOSITION_ROOTS = ['^src/app/composition\\.(desktop|ios|android)\\.ts$', '^src/main\\.tsx$']

/** The kernel's two entries: the React-free public one every capability may
 *  import, and the UI one only a composition root may. */
const KERNEL_PUBLIC_ENTRY = '^src/kernel/index\\.ts$'
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
 *  on this list. */
const FS_ADAPTERS = [
  '^src/kernel/core/bookFiles\\.ts$',
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
]

/** A capability's public entry — the only file under `src/capabilities/<id>/`
 *  anything outside that directory may import. */
const CAPABILITY_INDEX = '^src/capabilities/[^/]+/index\\.tsx?$'

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
      from: { path: '^src/', pathNot: ['^src/kernel/', ...COMPOSITION_ROOTS] },
      to: { path: '^src/kernel/', pathNot: KERNEL_PUBLIC_ENTRY },
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
      to: { path: '^src/kernel/', pathNot: [KERNEL_PUBLIC_ENTRY, KERNEL_UI_ENTRY] },
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
      from: { path: '^src/', pathNot: [...COMPOSITION_ROOTS, '^src/capabilities/', '^src/kernel/'] },
      to: { path: CAPABILITY_INDEX },
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
        'braid two platforms\' capability graphs. Only src/main.tsx (the entry choosing its root) and ' +
        'tests are exempt.',
      from: { path: '^src/', pathNot: ['^src/main\\.tsx$', '\\.(test|testkit)\\.tsx?$'] },
      to: { path: '^src/app/composition\\.(desktop|ios|android)\\.ts$' },
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
