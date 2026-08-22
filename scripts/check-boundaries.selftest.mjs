import { spawnSync } from 'node:child_process'
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

/** The CLI end to end over a fixture: `{ code, out, err }`. */
export function runCli(files) {
  const root = makeFixture(files)
  try {
    const result = spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8', timeout: 300_000 })
    if (result.error) throw result.error
    return { code: result.status, out: result.stdout, err: result.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Every case, a few at a time (each is a cruiser process), results in
 *  case order. `Promise.all` over all twenty would start twenty TypeScript
 *  compilers at once. */
async function runAll(cases, width) {
  const results = new Array(cases.length)
  let next = 0
  const worker = async () => {
    while (next < cases.length) {
      const i = next++
      results[i] = await runCase(cases[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, cases.length) }, worker))
  return results
}

async function main() {
  const results = await runAll(CASES, Math.max(1, Math.min(6, availableParallelism())))
  let failed = 0
  CASES.forEach((testCase, i) => {
    const { violations, missing, unexpected } = results[i]
    const ok = missing.length === 0 && unexpected.length === 0
    if (!ok) failed++
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${testCase.name}\n`)
    if (missing.length > 0) {
      process.stdout.write(`     not reported: ${missing.join(', ')} for ${testCase.from} -> ${testCase.to}\n`)
      for (const v of violations) process.stdout.write(`     saw: ${formatViolation(v)}\n`)
    }
    for (const v of unexpected) process.stdout.write(`     unexpected: ${formatViolation(v)}\n`)
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
