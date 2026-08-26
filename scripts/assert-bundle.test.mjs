import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { compositionFile, decideBundle } from './lib/compositions.mjs'
import {
  MANIFEST_NAME,
  PLUGIN_NAME,
  VIRTUAL_ID,
  bundleModuleIds,
  bundleRoots,
  loadManifest,
  paperComposition,
  selectPlatform,
} from './vite/assert-bundle.mjs'

/**
 * The bundle assertion, both halves. The decision itself
 * (`decideBundle`) is proven case by case in `lib/compositions.test.mjs`;
 * here the plugin around it is: which composition the virtual specifier
 * resolves to per platform; that a legal bundle passes and logs its line;
 * that a foreign capability module fails the build NAMING the module, and
 * so does another platform's composition — through the same hooks Rollup
 * calls, with a fake bundle and a fake `this.error`. A desktop-only manifest
 * fixture drives the failing branch, since every real capability is
 * composed on every platform today.
 *
 * Then one real build: `pnpm build:ios` on this tree must print the
 * assert-bundle line and exit 0. That is the row's Verify, once.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A root holding a manifest where `desk` is desktop-only and `both` is
 *  everywhere, plus the directories the validator wants to see. */
function fixture(manifest) {
  const root = mkdtempSync(path.join(tmpdir(), 'assert-bundle-'))
  roots.push(root)
  writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(manifest))
  for (const entry of manifest.capabilities ?? []) {
    if (typeof entry.ts !== 'string') continue
    mkdirSync(path.join(root, 'src', 'capabilities', entry.ts), { recursive: true })
    writeFileSync(path.join(root, 'src', 'capabilities', entry.ts, 'index.ts'), 'export {}\n')
  }
  return root
}

const MANIFEST = {
  capabilities: [
    { id: 'both', ts: 'both', platforms: ['desktop', 'ios', 'android'] },
    { id: 'desk', ts: 'desk', platforms: ['desktop'] },
  ],
}

/** Drive the plugin's hooks the way Vite/Rollup would, capturing what it logs and errors. */
function drive(root, platform, moduleIds) {
  const logged = []
  const plugin = paperComposition({ platform, log: (line) => logged.push(line) })
  plugin.configResolved({ root, command: 'build' })
  const errors = []
  const context = {
    error: (message) => {
      errors.push(message)
      throw new Error(message)
    },
  }
  const bundle = {
    'assets/index.js': { type: 'chunk', moduleIds },
    'assets/index.css': { type: 'asset' },
  }
  let threw = null
  try {
    plugin.generateBundle.call(context, {}, bundle)
  } catch (cause) {
    threw = cause
  }
  return { plugin, logged, errors, threw }
}

describe('selectPlatform', () => {
  it('reads TAURI_ENV_PLATFORM unless told explicitly', () => {
    expect(selectPlatform({ TAURI_ENV_PLATFORM: 'ios' })).toBe('ios')
    expect(selectPlatform({ TAURI_ENV_PLATFORM: 'darwin' })).toBe('desktop')
    expect(selectPlatform({})).toBe('desktop')
    expect(selectPlatform({ TAURI_ENV_PLATFORM: 'ios' }, 'android')).toBe('android')
    expect(selectPlatform()).toBe(selectPlatform(process.env))
  })
})

describe('the plugin', () => {
  it('resolves the virtual specifier to the platform composition under the resolved root, and nothing else', () => {
    for (const platform of ['desktop', 'ios', 'android']) {
      const plugin = paperComposition({ platform, log: () => {} })
      plugin.configResolved({ root: '/some/root', command: 'build' })
      expect(plugin.resolveId(VIRTUAL_ID)).toBe(path.resolve('/some/root', compositionFile(platform)))
      expect(plugin.resolveId('./app/composition.desktop')).toBeNull()
      expect(plugin.name).toBe(PLUGIN_NAME)
      expect(plugin.enforce).toBe('pre')
    }
    // Before configResolved it points under the working directory.
    expect(paperComposition({ platform: 'ios', log: () => {} }).resolveId(VIRTUAL_ID)).toBe(path.resolve(process.cwd(), compositionFile('ios')))
  })

  it('logs the platform choice when the config resolves', () => {
    const logged = []
    paperComposition({ env: { TAURI_ENV_PLATFORM: 'android' }, log: (l) => logged.push(l) }).configResolved({ root: '/r', command: 'build' })
    expect(logged).toEqual([`${PLUGIN_NAME}: TAURI_ENV_PLATFORM="android" → android → src/app/composition.android.ts`])
    const unset = []
    paperComposition({ env: {}, log: (l) => unset.push(l) }).configResolved({ root: '/r', command: 'build' })
    expect(unset[0]).toContain('TAURI_ENV_PLATFORM="" → desktop')
    // Not for the dev server or Vitest, whose stdout `vitest list --json` is parsed from.
    const serve = []
    paperComposition({ env: {}, log: (l) => serve.push(l) }).configResolved({ root: '/r', command: 'serve' })
    expect(serve).toEqual([])
  })

  it('passes a legal ios bundle and prints the assert-bundle line', () => {
    const root = fixture(MANIFEST)
    const ids = [`${root}/src/main.tsx`, `${root}/src/app/composition.ios.ts`, `${root}/src/capabilities/both/index.ts`, '\0vite/preload-helper', `${root}/node_modules/react/index.js`]
    const { logged, errors, threw } = drive(root, 'ios', ids)
    expect(errors).toEqual([])
    expect(threw).toBeNull()
    expect(logged.at(-1)).toBe('assert-bundle: ios: 1 capability modules from {both}')
  })

  it('fails an ios build that carries a desktop-only capability, naming the module', () => {
    const root = fixture(MANIFEST)
    const ids = [`${root}/src/app/composition.ios.ts`, `${root}/src/capabilities/both/index.ts`, `${root}/src/capabilities/desk/lib/leak.ts`]
    const { errors, threw, logged } = drive(root, 'ios', ids)
    expect(threw).not.toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('assert-bundle: the ios bundle is not the manifest\'s ios set (1 findings)')
    expect(errors[0]).toContain('BUNDLE_FOREIGN_CAPABILITY src/capabilities/desk/lib/leak.ts')
    expect(errors[0]).toContain('composed on [desktop] only')
    expect(logged.some((l) => l.startsWith('assert-bundle:'))).toBe(false)
  })

  it("fails a build that carries another platform's composition file", () => {
    const root = fixture(MANIFEST)
    const ids = [`${root}/src/app/composition.desktop.ts`, `${root}/src/app/composition.android.ts`, `${root}/src/capabilities/both/index.ts`, `${root}/src/capabilities/desk/index.ts`]
    const { errors } = drive(root, 'desktop', ids)
    expect(errors[0]).toContain('BUNDLE_FOREIGN_COMPOSITION src/app/composition.android.ts')
    expect(errors[0]).toContain('only src/app/composition.desktop.ts may be')
  })

  it("fails a build whose bundle lacks the platform's composition or one of its capabilities", () => {
    const root = fixture(MANIFEST)
    const { errors } = drive(root, 'desktop', [`${root}/src/app/composition.desktop.ts`, `${root}/src/capabilities/both/index.ts`])
    expect(errors[0]).toContain('BUNDLE_CAPABILITY_ABSENT capabilities/desk')
    const { errors: absent } = drive(root, 'desktop', [`${root}/src/capabilities/both/index.ts`, `${root}/src/capabilities/desk/index.ts`])
    expect(absent[0]).toContain('BUNDLE_COMPOSITION_ABSENT src/app/composition.desktop.ts')
  })

  /**
   * THE WEB BUNDLE, which every case above was blind to.
   *
   * The phase-18 gates name this one — "assert-bundle must fail if a
   * capability leaks into the web bundle" — and nothing exercised it: every
   * case here was `ios` or `desktop`. `web` is the platform where it matters
   * most and where the check is strongest, because NO capability lists `web`
   * in its platforms. Every one that exists is Tauri-bound — `peer` reaches an
   * iroh endpoint, `inference` supervises a local process, `webhost` IS the
   * server this build talks to — so any capability module in a web bundle is
   * foreign by construction, and would fail on a phone rather than at a build.
   *
   * `web` is also the platform most likely to be special-cased by accident: it
   * has a composition and no Cargo feature, and `NATIVE_PLATFORMS` exists to
   * mark that difference. `decideBundle` is platform-generic and does not know
   * about it — asserted here rather than assumed from reading it.
   */
  it('passes a web bundle that composes nothing, which is what an empty composition means', () => {
    const root = fixture(MANIFEST)
    const ids = [`${root}/src/main.web.tsx`, `${root}/src/app/composition.web.ts`, `${root}/node_modules/react/index.js`]
    const { logged, errors, threw } = drive(root, 'web', ids)
    expect(errors).toEqual([])
    expect(threw).toBeNull()
    expect(logged.at(-1)).toBe('assert-bundle: web: 0 capability modules from {}')
  })

  it('fails a web build that carries any capability at all, naming the module', () => {
    const root = fixture(MANIFEST)
    const ids = [`${root}/src/app/composition.web.ts`, `${root}/src/capabilities/both/index.ts`]
    const { errors, threw, logged } = drive(root, 'web', ids)
    expect(threw).not.toBeNull()
    expect(errors[0]).toContain('BUNDLE_FOREIGN_CAPABILITY src/capabilities/both/index.ts')
    /* EVERY NATIVE PLATFORM AND NOT web, which is the whole point: there is no
       capability whose platforms include it, so the refusal does not depend on
       which one leaked. */
    expect(errors[0]).toContain('composed on [desktop, ios, android] only')
    expect(logged.some((l) => l.startsWith('assert-bundle:'))).toBe(false)
  })

  it('fails a web build carrying a capability that leaked as an internal file, not an index', () => {
    /* THE QUIETER SHAPE. A tree-shaken index leaves `lib/…` behind, which is
       still the capability's code in a browser that cannot run it. */
    const root = fixture(MANIFEST)
    const ids = [`${root}/src/app/composition.web.ts`, `${root}/src/capabilities/desk/lib/leak.ts`]
    const { errors } = drive(root, 'web', ids)
    expect(errors[0]).toContain('BUNDLE_FOREIGN_CAPABILITY src/capabilities/desk/lib/leak.ts')
  })

  /**
   * A BROWSER HAS NO TAURI, and only the bundle can say whether one shipped.
   *
   * The check has been in `assert-bundle.mjs` since the first web build and had
   * no test; its own comment says it was "verified once by hand (0 references)".
   * This is what keeps it at zero.
   *
   * It is the guard for the reach that actually happened: `bookVault.ts` held
   * the vault's seam and its Tauri binding together, `bookFolder` imports
   * `extensionFor` from it, and the reader imports `bookFolder` — so the entire
   * reader subtree pulled in a filesystem plugin no module on that path ever
   * called. The direct-edge rule in `.dependency-cruiser.cjs` cannot see four
   * hops, and a reachability rule would also flag every type-only path, which
   * erases and ships nothing. A module in the bundle ships; there is no
   * ambiguity here to trade against.
   */
  it('fails a web build carrying a Tauri module, however deep the import was', () => {
    const root = fixture(MANIFEST)
    const ids = [
      `${root}/src/main.web.tsx`,
      `${root}/src/app/composition.web.ts`,
      `${root}/node_modules/@tauri-apps/plugin-fs/dist-js/index.js`,
    ]
    const { errors, threw } = drive(root, 'web', ids)
    expect(threw).not.toBeNull()
    expect(errors[0]).toContain('the web bundle reaches 1 Tauri module(s)')
    expect(errors[0]).toContain('@tauri-apps/plugin-fs/dist-js/index.js')
  })

  /* AND THE NATIVE PLATFORMS ARE UNAFFECTED — they are Tauri targets, and a
     rule that flagged them would be refusing the app for being the app. */
  it('says nothing about a Tauri module in a desktop bundle', () => {
    const root = fixture(MANIFEST)
    const ids = [
      `${root}/src/app/composition.desktop.ts`,
      `${root}/src/capabilities/both/index.ts`,
      `${root}/src/capabilities/desk/index.ts`,
      `${root}/node_modules/@tauri-apps/plugin-fs/dist-js/index.js`,
    ]
    const { errors, threw } = drive(root, 'desktop', ids)
    expect(threw).toBeNull()
    expect(errors).toEqual([])
  })

  it('reads the manifest at generateBundle and refuses an invalid or missing one', () => {
    const invalid = fixture({ capabilities: [{ id: 'Bad Id', ts: 'x', platforms: ['desktop'] }] })
    expect(drive(invalid, 'desktop', []).threw?.message).toMatch(/capabilities.manifest.json is invalid.*ID_INVALID/s)
    const missing = mkdtempSync(path.join(tmpdir(), 'assert-bundle-missing-'))
    roots.push(missing)
    expect(drive(missing, 'desktop', []).threw?.message).toMatch(/cannot read .*capabilities.manifest.json: ENOENT/)
    expect(() => loadManifest(missing)).toThrow(/ENOENT/)
    expect(loadManifest(REPO_ROOT)).toEqual(JSON.parse(readFileSync(path.join(REPO_ROOT, MANIFEST_NAME), 'utf8')))
  })

  it('collects module ids from chunks only, falling back to `modules` keys, and both roots of a symlinked one', () => {
    expect(bundleModuleIds({ a: { type: 'chunk', moduleIds: ['x', 'y'] }, b: { type: 'chunk', modules: { y: {}, z: {} } }, c: { type: 'asset' } })).toEqual(['x', 'y', 'z'])
    expect(bundleModuleIds({ d: { type: 'chunk' } })).toEqual([])
    const real = mkdtempSync(path.join(realpathSync(tmpdir()), 'assert-bundle-real-'))
    roots.push(real)
    const link = path.join(real, 'link')
    mkdirSync(path.join(real, 'target'))
    symlinkSync(path.join(real, 'target'), link, 'dir')
    expect(bundleRoots(link)).toEqual([link, path.join(real, 'target')])
    expect(bundleRoots(path.join(real, 'target'))).toEqual([path.join(real, 'target')])
    expect(bundleRoots(path.join(real, 'absent'))).toEqual([path.join(real, 'absent')])
    // A module named by the real path is accepted against a root given by the link.
    const d = decideBundle('ios', [path.join(real, 'target', 'src/app/composition.ios.ts')], { capabilities: [] }, bundleRoots(link))
    expect(d.ok).toBe(true)
  })
})

describe('a real build', () => {
  it('`pnpm build:ios` prints its assert-bundle line and exits 0', () => {
    const result = spawnSync('pnpm', ['build:ios'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000, env: { ...process.env, TAURI_ENV_PLATFORM: undefined } })
    if (result.error) throw result.error
    const out = `${result.stdout}\n${result.stderr}`
    expect(out).toContain(`${PLUGIN_NAME}: TAURI_ENV_PLATFORM="ios" → ios → src/app/composition.ios.ts`)
    expect(out).toMatch(/^assert-bundle: ios: \d+ capability modules from \{.*\}$/m)
    expect(result.status).toBe(0)
  }, 300_000)
})
