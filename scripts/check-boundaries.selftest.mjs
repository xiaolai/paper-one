import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRES_RULE, checkBoundaries, formatViolation } from './check-boundaries.mjs'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm boundaries:selftest` — every illegal edge is caught, by the rule that
 * owns it, and a legal tree is clean.
 *
 * A boundary check that nobody has watched fail is a comment. This builds a
 * small legal tree — a kernel with an entry, two capabilities that declare
 * their dependency, a composition root, a storage adapter that imports the
 * fs plugin — under a temporary root, then injects one illegal edge per case
 * and runs `check-boundaries` over it (the real script, the real config, the
 * real cruiser; only the root differs). Each case names the rule that must
 * reject its edge and the edge itself, so a rule that fires for the wrong
 * reason, or a different rule that happens to fire, does not count.
 *
 * The cases are the enforcement schedule's list from the ADR, made concrete:
 * kernel→capability in value and type position, capability→undeclared
 * capability, capability→another capability's internals, capability→kernel
 * internals, kernel test→capability test double, a barrel that hides a
 * crossing (inside the kernel and outside it), dynamic `import()`, the fs
 * plugin from a capability and from a kernel non-adapter, a cycle, the app
 * layer reaching past an index, and the kernel's UI entry reached from
 * anywhere but a composition root. One legal variant pins a deliberate
 * semantic: a type-only cycle is not a cycle. The legal tree itself pins the
 * other — a composition root importing both kernel entries — and the case
 * that used to let `src/main.tsx` reach kernel internals now expects the
 * refusal (WI-5.6 removed the exemption).
 *
 * Phase 11 added the SECOND COMPOSITION, `src/cli/` over `src/hosts/`, with
 * the allowance pinned in the legal tree and four refusals beside it: the
 * inward edge from a capability or the kernel (`hosts-and-cli-are-leaves`,
 * which is what stops the allowance being a back door to an undeclared
 * capability), the CLI reaching past a capability's index, the CLI reaching
 * a kernel internal, and the CLI reaching the kernel's UI entry — because
 * the CLI is deliberately NOT a composition root and must not acquire a path
 * to React.
 *
 * `scripts/check-boundaries.test.mjs` runs the same cases under Vitest; this
 * file is the standalone runner. Exit 0 when every case behaves, 1 otherwise.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECK = fileURLToPath(new URL('./check-boundaries.mjs', import.meta.url))

const manifest = (capabilities) => JSON.stringify({ capabilities }, null, 2)

/**
 * The legal tree. `alpha` requires `beta`; `gamma` requires nothing. Every
 * import carries its `.ts` extension so resolution cannot be the variable.
 */
export const LEGAL_TREE = {
  'capabilities.manifest.json': manifest([
    { id: 'alpha', ts: 'alpha', platforms: ['desktop'], requires: ['beta'] },
    { id: 'beta', ts: 'beta', platforms: ['desktop'] },
    { id: 'gamma', ts: 'gamma', platforms: ['desktop'] },
    { id: 'peer', ts: 'peer', platforms: ['desktop'] },
  ]),
  'src/kernel/index.ts': "export { kernelThing } from './core/thing.ts'\nexport type { KernelType } from './core/thing.ts'\n",
  /* The kernel's TEST-ONLY entry. Legal for a test to import, refused to
   * anything else — see `kernel-testkit-in-tests-only`. */
  'src/kernel/testkit.ts': "export { fake } from './core/fake.testkit.ts'\n",
  'src/kernel/core/fake.testkit.ts': 'export const fake = () => null\n',
  'src/kernel/ui/index.ts': "export { App } from './App.ts'\n",
  /* The BROWSER client's UI entry, beside the native one. Two doors, and the
     rules below hold each root to its own — see `native-root-not-browser-ui-entry`. */
  'src/kernel/ui/browser.ts': "export { App } from './App.ts'\n",
  'src/kernel/ui/App.ts': "import { other } from '../core/other.ts'\nexport const App = () => other\n",
  'src/kernel/core/thing.ts': 'export const kernelThing = 1\nexport type KernelType = { n: number }\n',
  'src/kernel/core/other.ts': 'export const other = 2\nexport type OtherType = { m: number }\n',
  'src/kernel/core/bookFiles.ts': "import { readFile } from '@tauri-apps/plugin-fs'\nexport { readFile }\n",
  'src/kernel/core/thing.test.ts': "import { kernelThing } from './thing.ts'\nvoid kernelThing\n",
  'src/capabilities/alpha/index.ts':
    "import { kernelThing } from '../../kernel/index.ts'\n" +
    "import { helper } from './lib/helper.ts'\n" +
    "import { betaPort } from '../beta/index.ts'\n" +
    'export const alpha = { kernelThing, helper, betaPort }\nexport type Alpha = typeof alpha\n',
  'src/capabilities/alpha/lib/helper.ts': 'export const helper = 1\n',
  'src/capabilities/beta/index.ts': "import type { KernelType } from '../../kernel/index.ts'\nexport const betaPort = { n: 1 } satisfies KernelType\n",
  'src/capabilities/beta/lib/internal.ts': 'export const betaInternal = 1\n',
  'src/capabilities/beta/testing/double.ts': 'export const betaDouble = 1\n',
  'src/capabilities/gamma/index.ts': 'export const gamma = 1\n',
  /* The one capability file allowed to import @tauri-apps/api — the peer
   * wire. In the legal tree so the allowance itself is pinned: if the rule
   * ever over-matches, the clean case fails. */
  'src/capabilities/peer/index.ts': "import { wire } from './lib/wire.ts'\nexport const peer = wire\n",
  'src/capabilities/peer/lib/wire.ts': "import { invoke } from '@tauri-apps/api/core'\nexport const wire = invoke\n",
  'src/app/composition.desktop.ts':
    "import { kernelThing } from '../kernel/index.ts'\n" +
    "import { alpha } from '../capabilities/alpha/index.ts'\n" +
    "import { betaPort } from '../capabilities/beta/index.ts'\n" +
    "import { gamma } from '../capabilities/gamma/index.ts'\n" +
    'export const composition = { kernelThing, alpha, betaPort, gamma }\n',
  'src/main.tsx':
    "import { kernelThing } from './kernel/index.ts'\n" +
    "import { App } from './kernel/ui/index.ts'\n" +
    "import { composition } from './app/composition.desktop.ts'\n" +
    'void kernelThing\nvoid App\nvoid composition\n',
  /* THE SECOND COMPOSITION (phase 11): the CLI may import a capability's
   * index and the kernel's public entry, and a host under it may import the
   * public entry. In the legal tree so the allowance is PINNED — if the rule
   * ever over-matches, the clean case fails rather than something subtler. */
  'src/hosts/node/fs.ts': "import { kernelThing } from '../../kernel/index.ts'\nexport const nodeFs = kernelThing\n",
  'src/cli/paper.ts':
    "import { kernelThing } from '../kernel/index.ts'\n" +
    "import { nodeFs } from '../hosts/node/fs.ts'\n" +
    "import { betaPort } from '../capabilities/beta/index.ts'\n" +
    'export const cli = { kernelThing, nodeFs, betaPort }\n',
  /* THE THIRD COMPOSITION (phase 18, reshaped in phase 19): the BROWSER client.
   * It reaches the kernel through ENTRIES now — the public entry and
   * `ui/browser.ts` — plus a few dependency-free leaves, exactly as a
   * composition root does. It used to hold an EXEMPTION instead, because the
   * public entry was not Tauri-free; WI-19.1 removed that cause.
   *
   * The allowance is pinned here for the same reason the peer wire's and the
   * CLI's are: if `web-client-kernel-entries` ever over-matches, the clean case
   * fails rather than something subtler later.
   *
   * `envelope.ts` is a permitted leaf; `other.ts` is not, and is what the
   * refusal case below reaches for. */
  'src/kernel/core/envelope.ts': 'export const encodeFrame = () => new Uint8Array()\n',
  /* The SECOND permitted leaf (WI-11.7). The transport moved here out of
     `src/app/web/`, and the client's old path is now a re-export that must be
     able to reach it — pinned so that a `web-client-kernel-entries` which
     stops matching this fails on the CLEAN tree rather than silently in the
     web build. */
  'src/kernel/core/shelfChannel.ts':
    "import { encodeFrame } from './envelope.ts'\nexport const connect = encodeFrame\n",
  'src/app/web/channel.ts':
    "import { connect } from '../../kernel/core/shelfChannel.ts'\nexport const channel = connect\n",
  'src/main.web.tsx':
    "import { channel } from './app/web/channel.ts'\nvoid channel\n",
}

/**
 * One case: files laid over the legal tree (a value of `null` deletes), and
 * `expect` — the rule names that must each report an edge from `from` to
 * `to`. An empty `expect` means the tree must be clean.
 */
export const CASES = [
  {
    name: 'legal tree is clean',
    files: {},
    expect: [],
  },
  {
    name: 'kernel -> capability, value import',
    files: { 'src/kernel/core/thing.ts': "import { alpha } from '../../capabilities/alpha/index.ts'\nexport const kernelThing = alpha\nexport type KernelType = { n: number }\n" },
    from: 'src/kernel/core/thing.ts',
    to: 'src/capabilities/alpha/index.ts',
    expect: ['no-kernel-to-capabilities', 'no-kernel-reaches-capabilities'],
  },
  {
    name: 'kernel -> capability, type-only import',
    files: { 'src/kernel/core/thing.ts': "import type { Alpha } from '../../capabilities/alpha/index.ts'\nexport const kernelThing = 1\nexport type KernelType = { n: number; a?: Alpha }\n" },
    from: 'src/kernel/core/thing.ts',
    to: 'src/capabilities/alpha/index.ts',
    expect: ['no-kernel-to-capabilities', 'no-kernel-reaches-capabilities'],
  },
  {
    name: 'capability -> capability its manifest entry does not require',
    files: { 'src/capabilities/gamma/index.ts': "import { alpha } from '../alpha/index.ts'\nexport const gamma = alpha\n" },
    from: 'src/capabilities/gamma/index.ts',
    to: 'src/capabilities/alpha/index.ts',
    expect: [REQUIRES_RULE],
  },
  {
    name: 'capability directory with no manifest entry -> capability',
    files: { 'src/capabilities/delta/index.ts': "import { alpha } from '../alpha/index.ts'\nexport const delta = alpha\n" },
    from: 'src/capabilities/delta/index.ts',
    to: 'src/capabilities/alpha/index.ts',
    expect: [REQUIRES_RULE],
  },
  {
    name: "capability -> another capability's internal file (declared, but not its index)",
    files: {
      'src/capabilities/alpha/index.ts':
        LEGAL_TREE['src/capabilities/alpha/index.ts'] + "import { betaInternal } from '../beta/lib/internal.ts'\nvoid betaInternal\n",
    },
    from: 'src/capabilities/alpha/index.ts',
    to: 'src/capabilities/beta/lib/internal.ts',
    expect: ['cap-to-other-cap-internal'],
  },
  {
    name: 'capability -> kernel internal (not the public entry)',
    files: {
      'src/capabilities/alpha/index.ts':
        LEGAL_TREE['src/capabilities/alpha/index.ts'] + "import { other } from '../../kernel/core/other.ts'\nvoid other\n",
    },
    from: 'src/capabilities/alpha/index.ts',
    to: 'src/kernel/core/other.ts',
    expect: ['kernel-public-entry-only'],
  },
  {
    /**
     * THE TEST-ONLY ENTRY IS NOT THE PUBLIC ONE.
     *
     * `fakeFs` used to be re-exported from `src/kernel/index.ts`, where these
     * rules could not tell it apart from `createKernelServices` — it arrived
     * through the one door everything may use. A separate entry makes the
     * difference nameable.
     */
    name: 'production code -> the kernel testkit entry',
    files: {
      'src/cli/paper.ts':
        LEGAL_TREE['src/cli/paper.ts'] + "import { fake } from '../kernel/testkit.ts'\nvoid fake\n",
    },
    from: 'src/cli/paper.ts',
    to: 'src/kernel/testkit.ts',
    expect: ['kernel-testkit-in-tests-only'],
  },
  {
    name: 'kernel test -> capability test double',
    files: {
      'src/kernel/core/thing.test.ts':
        LEGAL_TREE['src/kernel/core/thing.test.ts'] + "import { betaDouble } from '../../capabilities/beta/testing/double.ts'\nvoid betaDouble\n",
    },
    from: 'src/kernel/core/thing.test.ts',
    to: 'src/capabilities/beta/testing/double.ts',
    expect: ['no-kernel-to-capabilities', 'capability-only-via-index'],
  },
  {
    name: 'barrel inside the kernel re-exports a capability',
    files: {
      'src/kernel/core/barrel.ts': "export * from '../../capabilities/alpha/index.ts'\n",
      'src/kernel/core/thing.ts': "export * from './barrel.ts'\nexport const kernelThing = 1\nexport type KernelType = { n: number }\n",
    },
    from: 'src/kernel/core/barrel.ts',
    to: 'src/capabilities/alpha/index.ts',
    expect: ['no-kernel-to-capabilities'],
  },
  {
    name: 'barrel outside the kernel hides a kernel -> capability path',
    files: {
      'src/app/barrel.ts': "export * from '../capabilities/alpha/index.ts'\n",
      'src/kernel/core/thing.ts': "import { alpha } from '../../app/barrel.ts'\nexport const kernelThing = alpha\nexport type KernelType = { n: number }\n",
    },
    from: 'src/kernel/core/thing.ts',
    to: 'src/capabilities/alpha/index.ts',
    expect: ['no-kernel-reaches-capabilities'],
  },
  {
    name: 'shared intermediary re-exports a capability (the requires back door)',
    files: {
      // A non-kernel, non-capability, non-composition module re-exporting a
      // capability index: the barrel through which a capability could reach an
      // undeclared capability, invisible to the direct-edge requires check.
      'src/shared/facade.ts': "export { betaPort } from '../capabilities/beta/index.ts'\n",
      'src/capabilities/gamma/index.ts': "import { betaPort } from '../../shared/facade.ts'\nexport const gamma = betaPort\n",
    },
    from: 'src/shared/facade.ts',
    to: 'src/capabilities/beta/index.ts',
    expect: ['capability-index-only-from-composition'],
  },
  {
    name: 'dynamic import() of a kernel internal from a capability',
    files: {
      'src/capabilities/alpha/index.ts':
        LEGAL_TREE['src/capabilities/alpha/index.ts'] + "export const load = () => import('../../kernel/core/other.ts')\n",
    },
    from: 'src/capabilities/alpha/index.ts',
    to: 'src/kernel/core/other.ts',
    expect: ['kernel-public-entry-only'],
  },
  {
    name: 'dynamic import() of a capability from the kernel',
    files: {
      'src/kernel/core/thing.ts':
        "export const kernelThing = 1\nexport type KernelType = { n: number }\nexport const load = () => import('../../capabilities/alpha/index.ts')\n",
    },
    from: 'src/kernel/core/thing.ts',
    to: 'src/capabilities/alpha/index.ts',
    expect: ['no-kernel-to-capabilities', 'no-kernel-reaches-capabilities'],
  },
  {
    name: '@tauri-apps/plugin-fs imported by a capability',
    files: { 'src/capabilities/alpha/lib/helper.ts': "import { readFile } from '@tauri-apps/plugin-fs'\nexport const helper = readFile\n" },
    from: 'src/capabilities/alpha/lib/helper.ts',
    to: /(^|\/)@tauri-apps\/plugin-fs(\/|$)/,
    expect: ['no-direct-fs-plugin-outside-storage'],
  },
  {
    name: '@tauri-apps/plugin-fs imported by a kernel module that is not a storage adapter',
    files: { 'src/kernel/core/other.ts': "import { readFile } from '@tauri-apps/plugin-fs'\nexport const other = readFile\nexport type OtherType = { m: number }\n" },
    from: 'src/kernel/core/other.ts',
    to: /(^|\/)@tauri-apps\/plugin-fs(\/|$)/,
    expect: ['no-direct-fs-plugin-outside-storage'],
  },
  {
    name: '@tauri-apps/api imported by a capability file that is not the peer wire',
    files: { 'src/capabilities/alpha/lib/helper.ts': "import { invoke } from '@tauri-apps/api/core'\nexport const helper = invoke\n" },
    from: 'src/capabilities/alpha/lib/helper.ts',
    to: /(^|\/)@tauri-apps\/api(\/|$)/,
    expect: ['no-tauri-api-outside-peer-wire'],
  },
  {
    name: 'the peer wire imports an @tauri-apps package that is not the api',
    files: {
      'src/capabilities/peer/lib/wire.ts':
        "import { invoke } from '@tauri-apps/api/core'\nimport { open } from '@tauri-apps/plugin-dialog'\nexport const wire = { invoke, open }\n",
    },
    from: 'src/capabilities/peer/lib/wire.ts',
    to: /(^|\/)@tauri-apps\/plugin-dialog(\/|$)/,
    expect: ['peer-wire-tauri-api-only'],
  },
  /**
   * THE BROWSER CLIENT'S TWO RULES, neither of which had a case here.
   *
   * `no-tauri-in-the-web-client` did not exist at all until it was tested by
   * hand: `no-tauri-api-outside-peer-wire` is scoped to `src/capabilities/`,
   * so `src/app/web/` could import `@tauri-apps/api/core` and `pnpm
   * boundaries` reported 0 violations. There is no Tauri in a browser — the
   * import resolves at build time, ships, and fails on the reader's phone as
   * `undefined is not a function`, three layers from its cause.
   */
  {
    name: '@tauri-apps imported by the browser client',
    files: { 'src/app/web/channel.ts': "import { invoke } from '@tauri-apps/api/core'\nexport const send = invoke\n" },
    from: 'src/app/web/channel.ts',
    to: /(^|\/)@tauri-apps\/api(\/|$)/,
    expect: ['no-tauri-in-the-web-client'],
  },
  {
    name: '@tauri-apps imported by the browser composition root',
    files: { 'src/main.web.tsx': "import { invoke } from '@tauri-apps/api/core'\nvoid invoke\n" },
    from: 'src/main.web.tsx',
    to: /(^|\/)@tauri-apps\/api(\/|$)/,
    expect: ['no-tauri-in-the-web-client'],
  },
  /* And the client's entry rule, which had no case either. The client reaches
   * the kernel through named ENTRIES, and this is the edge that proves they are
   * doors rather than an open directory — the failure the old allow-list
   * actually had, where `^src/kernel/ui/reader/` let twenty-odd modules
   * through as one entry. */
  {
    name: 'the browser client -> a kernel module that is not one of its entries',
    files: { 'src/app/web/books.ts': "import { other } from '../../kernel/core/other.ts'\nexport const books = other\n" },
    from: 'src/app/web/books.ts',
    to: 'src/kernel/core/other.ts',
    expect: ['web-client-kernel-entries'],
  },
  /* THE DIRECTORY, specifically. `ui/browser.ts` is an entry; `ui/reader/` is
   * not, and reaching past the door into the room behind it is the thing this
   * rule was reshaped to forbid. */
  {
    name: 'the browser client -> past its entry into ui/reader/',
    files: {
      'src/kernel/ui/reader/FoliateView.tsx': 'export const FoliateView = () => null\n',
      'src/app/web/Reader.tsx': "import { FoliateView } from '../../kernel/ui/reader/FoliateView.tsx'\nexport const R = FoliateView\n",
    },
    from: 'src/app/web/Reader.tsx',
    to: 'src/kernel/ui/reader/FoliateView.tsx',
    expect: ['web-client-kernel-entries'],
  },
  {
    name: 'a capability -> a composition root (the whole-composition back door)',
    files: {
      'src/capabilities/alpha/index.ts':
        LEGAL_TREE['src/capabilities/alpha/index.ts'] + "import { capabilities } from '../../app/composition.desktop.ts'\nvoid capabilities\n",
    },
    from: 'src/capabilities/alpha/index.ts',
    to: 'src/app/composition.desktop.ts',
    expect: ['no-capability-to-composition-root'],
  },
  {
    name: 'a shared module -> a composition root (the laundered whole-composition path)',
    files: {
      'src/shared/roots.ts': "import { capabilities } from '../app/composition.desktop.ts'\nexport const laundered = capabilities\n",
    },
    from: 'src/shared/roots.ts',
    to: 'src/app/composition.desktop.ts',
    expect: ['no-capability-to-composition-root'],
  },
  {
    name: 'one platform composition root -> another (braided platform graphs)',
    files: {
      'src/app/composition.ios.ts':
        "import { capabilities as desktop } from './composition.desktop.ts'\nexport const capabilities = desktop\n",
    },
    from: 'src/app/composition.ios.ts',
    to: 'src/app/composition.desktop.ts',
    expect: ['no-capability-to-composition-root'],
  },
  {
    name: 'a cycle',
    files: {
      'src/kernel/core/thing.ts': "import { other } from './other.ts'\nexport const kernelThing = other\nexport type KernelType = { n: number }\n",
      'src/kernel/core/other.ts': "import { kernelThing } from './thing.ts'\nexport const other = kernelThing\nexport type OtherType = { m: number }\n",
    },
    from: 'src/kernel/core/other.ts',
    to: 'src/kernel/core/thing.ts',
    expect: ['no-circular'],
  },
  {
    name: 'a type-only cycle is not a cycle (erased before it could run)',
    files: {
      'src/kernel/core/thing.ts': "import type { OtherType } from './other.ts'\nexport const kernelThing = 1\nexport type KernelType = { n: number; o?: OtherType }\n",
      'src/kernel/core/other.ts': "import type { KernelType } from './thing.ts'\nexport const other = 2\nexport type OtherType = { m: number; k?: KernelType }\n",
    },
    expect: [],
  },
  {
    name: "app -> a capability's internal file",
    files: {
      'src/app/composition.desktop.ts':
        LEGAL_TREE['src/app/composition.desktop.ts'] + "import { betaInternal } from '../capabilities/beta/lib/internal.ts'\nvoid betaInternal\n",
    },
    from: 'src/app/composition.desktop.ts',
    to: 'src/capabilities/beta/lib/internal.ts',
    expect: ['capability-only-via-index'],
  },
  {
    name: 'a composition root -> kernel internal',
    files: {
      'src/app/composition.desktop.ts':
        LEGAL_TREE['src/app/composition.desktop.ts'] + "import { other } from '../kernel/core/other.ts'\nvoid other\n",
    },
    from: 'src/app/composition.desktop.ts',
    to: 'src/kernel/core/other.ts',
    expect: ['composition-root-kernel-entries'],
  },
  {
    name: 'src/main.tsx -> kernel internal (the exemption WI-5.6 removed)',
    files: { 'src/main.tsx': LEGAL_TREE['src/main.tsx'] + "import { other } from './kernel/core/other.ts'\nvoid other\n" },
    from: 'src/main.tsx',
    to: 'src/kernel/core/other.ts',
    expect: ['composition-root-kernel-entries'],
  },
  /**
   * ⚠️ THE TWO UI ENTRIES ARE TWO DOORS, and one allowance used to open both.
   *
   * `composition-root-kernel-entries` exempted `src/kernel/ui/index.ts` AND
   * `src/kernel/ui/browser.ts` for every root alike, so a native root could
   * import the browser's entry and the browser root could import the
   * Tauri-bound one. The second is the dangerous direction: `ui/index.ts`
   * re-exports modules that import `@tauri-apps`, and a barrel retains
   * everything it names. `assert-bundle` would refuse the bundle afterwards,
   * for a reason that reads as unrelated.
   */
  {
    name: 'a native composition root -> the BROWSER ui entry',
    files: {
      'src/main.tsx': LEGAL_TREE['src/main.tsx'] + "import { App as B } from './kernel/ui/browser.ts'\nvoid B\n",
    },
    from: 'src/main.tsx',
    to: 'src/kernel/ui/browser.ts',
    expect: ['native-root-not-browser-ui-entry'],
  },
  {
    name: 'the browser composition root -> the NATIVE ui entry',
    files: {
      'src/main.web.tsx': LEGAL_TREE['src/main.web.tsx'] + "import { App } from './kernel/ui/index.ts'\nvoid App\n",
    },
    from: 'src/main.web.tsx',
    to: 'src/kernel/ui/index.ts',
    expect: ['web-root-not-native-ui-entry'],
  },
  /* AND EACH ROOT KEEPS ITS OWN, so the two rules above are about crossing
     over rather than about the entries being unreachable. */
  {
    name: 'the browser composition root -> the BROWSER ui entry (allowed)',
    files: {
      'src/main.web.tsx': LEGAL_TREE['src/main.web.tsx'] + "import { App as B } from './kernel/ui/browser.ts'\nvoid B\n",
    },
    from: 'src/main.web.tsx',
    to: 'src/kernel/ui/browser.ts',
    expect: [],
  },
  /**
   * A capability reaching an ENTRY is the same back door as one reaching a
   * composition file, and the rule's target named only the latter — while its
   * own comment said "nothing may import src/main.tsx".
   */
  {
    name: 'a capability -> src/main.tsx (the entry back door)',
    files: {
      'src/capabilities/alpha/index.ts':
        LEGAL_TREE['src/capabilities/alpha/index.ts'] + "import '../../main.tsx'\n",
    },
    from: 'src/capabilities/alpha/index.ts',
    to: 'src/main.tsx',
    expect: ['no-capability-to-composition-root'],
  },
  {
    name: 'a capability -> src/main.web.tsx (the same door, browser side)',
    files: {
      'src/capabilities/alpha/index.ts':
        LEGAL_TREE['src/capabilities/alpha/index.ts'] + "import '../../main.web.tsx'\n",
    },
    from: 'src/capabilities/alpha/index.ts',
    to: 'src/main.web.tsx',
    expect: ['no-capability-to-composition-root'],
  },
  {
    name: 'capability -> the kernel UI entry',
    files: {
      'src/capabilities/alpha/index.ts':
        LEGAL_TREE['src/capabilities/alpha/index.ts'] + "import { App } from '../../kernel/ui/index.ts'\nvoid App\n",
    },
    from: 'src/capabilities/alpha/index.ts',
    to: 'src/kernel/ui/index.ts',
    expect: ['kernel-public-entry-only'],
  },
  {
    name: 'a file under src/app that is not a composition root -> the kernel UI entry',
    files: { 'src/app/composition.contract.test.ts': "import { App } from '../kernel/ui/index.ts'\nvoid App\n" },
    from: 'src/app/composition.contract.test.ts',
    to: 'src/kernel/ui/index.ts',
    expect: ['kernel-public-entry-only'],
  },
  {
    name: 'a capability -> the CLI (the laundered path to an undeclared capability)',
    files: {
      'src/capabilities/gamma/index.ts': "import { cli } from '../../cli/paper.ts'\nexport const gamma = cli\n",
    },
    from: 'src/capabilities/gamma/index.ts',
    to: 'src/cli/paper.ts',
    expect: ['hosts-and-cli-are-leaves'],
  },
  {
    name: 'the kernel -> a host (node: builtins in a browser build)',
    files: {
      'src/kernel/core/thing.ts':
        "import { nodeFs } from '../../hosts/node/fs.ts'\nexport const kernelThing = nodeFs\nexport type KernelType = { n: number }\n",
    },
    from: 'src/kernel/core/thing.ts',
    to: 'src/hosts/node/fs.ts',
    expect: ['hosts-and-cli-are-leaves'],
  },
  {
    name: "the CLI -> a capability's internal file (the allowance does not reach past an index)",
    files: {
      'src/cli/paper.ts':
        LEGAL_TREE['src/cli/paper.ts'] + "import { betaInternal } from '../capabilities/beta/lib/internal.ts'\nvoid betaInternal\n",
    },
    from: 'src/cli/paper.ts',
    to: 'src/capabilities/beta/lib/internal.ts',
    expect: ['capability-only-via-index'],
  },
  {
    name: 'the CLI -> a kernel internal (the allowance is not a composition root)',
    files: {
      'src/cli/paper.ts': LEGAL_TREE['src/cli/paper.ts'] + "import { other } from '../kernel/core/other.ts'\nvoid other\n",
    },
    from: 'src/cli/paper.ts',
    to: 'src/kernel/core/other.ts',
    expect: ['kernel-public-entry-only'],
  },
  {
    name: 'the CLI -> the kernel UI entry (a CLI has no React and must not gain a path to one)',
    files: {
      'src/cli/paper.ts': LEGAL_TREE['src/cli/paper.ts'] + "import { App } from '../kernel/ui/index.ts'\nvoid App\n",
    },
    from: 'src/cli/paper.ts',
    to: 'src/kernel/ui/index.ts',
    expect: ['kernel-public-entry-only'],
  },
  {
    name: 'a host -> a capability index (only the CLI composes; a host is a seam)',
    files: {
      'src/hosts/node/fs.ts': LEGAL_TREE['src/hosts/node/fs.ts'] + "import { gamma } from '../../capabilities/gamma/index.ts'\nvoid gamma\n",
    },
    from: 'src/hosts/node/fs.ts',
    to: 'src/capabilities/gamma/index.ts',
    expect: ['capability-index-only-from-composition'],
  },
  {
    name: 'an import that does not resolve',
    files: {
      'src/capabilities/alpha/index.ts': LEGAL_TREE['src/capabilities/alpha/index.ts'] + "import { gone } from './lib/does-not-exist.ts'\nvoid gone\n",
    },
    from: 'src/capabilities/alpha/index.ts',
    to: /does-not-exist/,
    expect: ['no-unresolvable'],
  },
]

/**
 * A fresh root holding `LEGAL_TREE` with `files` laid over it, and this
 * repository's `node_modules` linked in so `@tauri-apps/plugin-fs` resolves
 * as it does here. The temp dir is realpath'd: on macOS `tmpdir()` is a
 * symlink, and the cruiser reports files under a symlinked cwd by a
 * relative path that climbs out of `src/`, which no rule would match.
 */
export function makeFixture(files) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'boundaries-selftest-'))
  const tree = { ...LEGAL_TREE, ...files }
  for (const [rel, content] of Object.entries(tree)) {
    if (content === null) continue
    const full = path.join(root, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  return root
}

const matches = (actual, expected) => (expected instanceof RegExp ? expected.test(actual) : actual === expected)

/**
 * Run one case: build its tree, check it, and judge. Returns
 * `{ violations, missing, unexpected }` — `missing` is every expected rule
 * that did not report the case's edge; `unexpected` is the whole violation
 * list when the case expected a clean tree and did not get one. The case
 * behaved when both are empty.
 */
export async function runCase(testCase) {
  const root = makeFixture(testCase.files)
  try {
    const { violations } = await checkBoundaries(root)
    const missing = testCase.expect.filter(
      (rule) => !violations.some((v) => v.rule === rule && matches(v.from, testCase.from) && matches(v.to, testCase.to)),
    )
    const unexpected = testCase.expect.length === 0 ? violations : []
    return { violations, missing, unexpected }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The CLI end to end over a fixture: `{ code, out, err }`.
 *
 * ASYNC, AND THAT IS THE POINT. It was `spawnSync`, and these four calls are
 * the only blocking work in this file — each holds the calling thread for the
 * whole child run. Under Vitest that thread is a worker, and a blocked worker
 * cannot service the reply to its own `onTaskUpdate` RPC until the child
 * exits: on a loaded machine the reply misses vitest's deadline and the run
 * dies with `Timeout calling "onTaskUpdate"`, an UNHANDLED ERROR rather than a
 * failing assertion. 2540 green tests and exit 1, with nothing naming a cause.
 *
 * Measured 2026-08-21: `pnpm verify` uncontended passed 16/16 in 147.7s; the
 * same command contended failed at `test:coverage` that way, and
 * `pnpm test:coverage` alone went 47.8s uncontended to 123.0s contended with
 * the same error. Making these four await removes the mechanism rather than
 * trying to make the machine fast enough that it never fires.
 *
 * A non-zero exit RESOLVES — three of the four cases assert one. Only a
 * failure to run at all, or the timeout, rejects.
 */
export function runCli(files) {
  const root = makeFixture(files)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHECK, '--root', root])
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`check-boundaries CLI did not finish within 300s for ${root}`))
    }, 300_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  }).finally(() => {
    rmSync(root, { recursive: true, force: true })
  })
}

/** Every case, a few at a time, results in case order.
 *
 *  Bounded because each case SPAWNS A CHILD PROCESS — `runCase` awaits
 *  `checkBoundaries(root)`, which calls `cruise`, which spawns
 *  `process.execPath` against dependency-cruiser — and enough of them at once
 *  saturate the machine. The count is `CASES.length`; do not write it here,
 *  because the last two numbers written into this comment both went stale.
 *
 *  ⚠️ **THIS SAID "IN-PROCESS", AND BEING WRONG COST A REAL INVESTIGATION.**
 *  The note here claimed the child-process-per-case era had ended and that
 *  "the only blocking calls are `runCli`'s four", so a survey of this gate's
 *  own flakiness read it, believed it, and went looking elsewhere. `cruise`
 *  has spawned throughout — `scripts/check-boundaries.mjs` line ~111. The
 *  previous version of this paragraph said a stale comment about concurrency
 *  is not a cosmetic defect, while being the example of one. */
export async function runAll(cases, width = defaultWidth()) {
  const results = new Array(cases.length)
  let next = 0
  const worker = async () => {
    while (next < cases.length) {
      const i = next++
      /* CAUGHT PER CASE, not per pool. `Promise.all` over the workers means one
         throw rejects the whole run, and both consumers then lose every OTHER
         case's result — the standalone runner prints nothing and Vitest fails a
         `beforeAll`, taking all of the case names down with it and naming none
         of them. A case that could not run is a result like any other, and it
         is reported against its own name. */
      try {
        results[i] = await runCase(cases[i])
      } catch (cause) {
        results[i] = { violations: [], missing: [], unexpected: [], error: cause }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, cases.length)) }, worker))
  return results
}

/** The cap both consumers get unless one asks for another. */
export function defaultWidth() {
  /* THE BUDGET IS NOT THIS FUNCTION'S TO SPEND WHEN VITEST IS RUNNING.
   *
   * Six was chosen for work that shares one event loop. Each case is a
   * CPU-bound CHILD PROCESS — measured 2026-08-29 at 2.9 s each, 64 s for the
   * set — and under Vitest the pool has already committed `maxWorkers`
   * processes (`cpus − 2`, so 8 of 10 here). Six more makes fourteen on ten
   * cores, and the one that loses is Vitest's MAIN thread, which must answer
   * `onTaskUpdate` inside birpc's 60 s. This file holds that state for longer
   * than the deadline, which is the `[vitest-worker]: Timeout calling
   * "onTaskUpdate"` the gate has been failing on with every test passing.
   *
   * Standalone, six is still right: nothing else is running and these cases
   * are the whole job. The number is about what is FREE, and only one of the
   * two situations has six cores free. */
  return Math.max(1, Math.min(6, availableParallelism()))
}

/** Why a case did not behave, as one line, or null when it did. */
export function caseFailure({ violations, missing, unexpected, error }, testCase) {
  if (error) return `could not run: ${error?.stack ?? String(error)}`
  if (missing.length > 0) {
    const saw = violations.map(formatViolation)
    return `not reported: ${missing.join(', ')} for ${testCase.from} -> ${testCase.to}${
      saw.length > 0 ? `\n     saw: ${saw.join('\n     saw: ')}` : ''
    }`
  }
  if (unexpected.length > 0) return `unexpected: ${unexpected.map(formatViolation).join(', ')}`
  return null
}

async function main() {
  const results = await runAll(CASES)
  let failed = 0
  CASES.forEach((testCase, i) => {
    const why = caseFailure(results[i], testCase)
    if (why) failed++
    process.stdout.write(`${why ? 'FAIL' : 'ok  '} ${testCase.name}\n`)
    if (why) process.stdout.write(`     ${why}\n`)
  })
  process.stdout.write(`check-boundaries selftest: ${CASES.length} cases, ${failed} failed\n`)
  return failed > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = await main()
  } catch (cause) {
    process.stderr.write(`check-boundaries selftest: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
